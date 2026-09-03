/**
 * Step 1: work out how to talk to the Solarbank before building anything on
 * top of it.
 *
 * The register map is known, but three things are not, and guessing any of
 * them produces a dashboard that looks plausible and is wrong:
 *   1. holding registers (FC3) vs input registers (FC4)
 *   2. the unit / slave id
 *   3. the sign convention on battery and grid power
 *
 * This script determines 1 and 2 by probing, and gives you the numbers to
 * confirm 3 against the phone app. It writes its findings to .env.
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ModbusRTU from "modbus-serial";
import { REGISTERS, BATTERY_STATUS } from "../server/registers.ts";
import { decodeValue } from "../server/decode.ts";

const PORT = Number(process.env.SOLIX_PORT ?? 502);
const ROOT = path.resolve(import.meta.dirname, "..");

type Kind = "holding" | "input";

interface Found {
  host: string;
  unitId: number;
  kind: Kind;
  model: string;
  soc: number;
}

async function main() {
  const hostArg = process.argv[2] ?? process.env.SOLIX_HOST;
  const hosts = hostArg ? [hostArg] : await scanSubnet();

  if (hosts.length === 0) {
    console.error(
      "\nNo device found listening on port %d.\n\n" +
        "Check that Modbus TCP is enabled:\n" +
        "  Anker app -> Devices -> your Solarbank -> Settings (gear)\n" +
        "  -> Three-Party Control Settings -> enable Modbus TCP\n\n" +
        "Then re-run with the IP the app shows:  npm run probe -- 192.168.1.50\n",
      PORT,
    );
    process.exit(1);
  }

  console.log("Candidate hosts: %s", hosts.join(", "));

  // Identify every responder, not just the first. A Solix installation puts
  // several devices on port 502 (solarbank, smart meter, plugs), and knowing
  // which is which is the difference between a dashboard and a guess.
  const devices: Found[] = [];
  for (const host of hosts) {
    let identified = false;
    for (const unitId of [1, 0, 247]) {
      for (const kind of ["holding", "input"] as Kind[]) {
        const r = await tryCombo(host, unitId, kind);
        if (r) {
          devices.push(r);
          identified = true;
          break;
        }
      }
      if (identified) break;
    }
  }

  if (devices.length > 0) {
    console.log("\n=== Devices identified ===");
    for (const d of devices) {
      console.log("  %s  unit=%s  %s  model=%s  soc=%s%%", d.host, d.unitId, d.kind, d.model, d.soc);
    }
  }

  // A17X8 is the Smart Plug Gen 2. Without a Smart Meter these are the only
  // measurement of household consumption, so they are worth finding.
  const plugHosts: string[] = [];
  for (const host of hosts) {
    if (devices.some((d) => d.host === host)) continue;
    const plug = await tryPlug(host);
    if (plug) {
      console.log("  socket %s  model=%s  sn=%s  %s W", host, plug.model, plug.serial, plug.watts);
      plugHosts.push(host);
    }
  }

  // AE103 is the Solarbank 4 E5000 Pro. Fall back to the first responder that
  // reports a plausible state of charge.
  const found =
    devices.find((d) => d.model.toUpperCase().includes("AE103")) ??
    devices.find((d) => d.soc > 0) ??
    devices[0] ??
    null;

  if (!found) {
    console.error(
      "\nReached a device but no unit-id/function-code combination returned " +
        "sane values.\nThe register map may differ on your firmware.\n",
    );
    process.exit(1);
  }

  console.log("\n=== Connection ===");
  console.log("  host          %s:%d", found.host, PORT);
  console.log("  unit id       %d", found.unitId);
  console.log("  registers     %s (%s)", found.kind, found.kind === "holding" ? "FC3" : "FC4");

  const live = await report(found);
  const invertBattery = detectBatteryInversion(live);
  reportSigns(live, invertBattery);
  writeEnv(found, invertBattery, plugHosts);

  if (plugHosts.length > 0) {
    console.log(
      [
        "",
        "=== Sockets ===",
        `  Found ${plugHosts.length} Smart Plug(s).`,
        "  Their combined power stands in for household consumption, which the",
        "  Solarbank itself only reports when a Smart Meter is paired.",
        "",
      ].join("\n"),
    );
  }
}

/** A combination is right if the model reads as text and SOC is a real percentage. */
async function tryCombo(host: string, unitId: number, kind: Kind): Promise<Found | null> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP(host, { port: PORT });
    client.setID(unitId);
    client.setTimeout(3000);

    const modelWords = await read(client, kind, REGISTERS.device_model.address, REGISTERS.device_model.count);
    const socWords = await read(client, kind, REGISTERS.battery_soc.address, 1);
    if (!modelWords || !socWords) return null;

    const model = String(decodeValue(modelWords, 0, REGISTERS.device_model) ?? "");
    const soc = Number(decodeValue(socWords, 0, REGISTERS.battery_soc) ?? -1);

    console.log("  try %s unit=%s %s -> model=%j soc=%s", host, unitId, kind.padEnd(7), model, soc);

    // Anker model codes are short and alphanumeric (the Solarbank 4 E5000 Pro
    // reports "AE103"), so require a letter and some length rather than a run
    // of letters.
    const modelLooksReal = model.length >= 3 && /[A-Za-z]/.test(model);
    const socLooksReal = soc >= 0 && soc <= 100;
    if (modelLooksReal && socLooksReal) return { host, unitId, kind, model, soc };
    return null;
  } catch {
    return null;
  } finally {
    try {
      client.close(() => {});
    } catch {
      /* already closed */
    }
  }
}

interface PlugFound {
  model: string;
  serial: string;
  watts: number;
}

/** Identify a Smart Plug Gen 2 by its own register block. */
async function tryPlug(host: string): Promise<PlugFound | null> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP(host, { port: PORT });
    client.setID(1);
    client.setTimeout(2500);

    const model = await read(client, "holding", 32768, 5);
    const sn = await read(client, "holding", 30005, 12);
    const live = await read(client, "holding", 30029, 9);
    if (!model || !sn || !live) return null;

    const modelStr = String(decodeValue(model, 0, { type: "STRING", count: 5 }) ?? "");
    if (!modelStr.toUpperCase().startsWith("A17X")) return null;

    return {
      model: modelStr,
      serial: String(decodeValue(sn, 0, { type: "STRING", count: 12 }) ?? ""),
      watts: (live[1] ?? 0) / 10,
    };
  } catch {
    return null;
  } finally {
    try {
      client.close(() => {});
    } catch {
      /* already closed */
    }
  }
}

async function read(client: ModbusRTU, kind: Kind, addr: number, len: number): Promise<number[] | null> {
  try {
    const res =
      kind === "holding"
        ? await client.readHoldingRegisters(addr, len)
        : await client.readInputRegisters(addr, len);
    return res.data as number[];
  } catch {
    return null;
  }
}

/** Print the live values that the user compares against the phone app. */
async function report(found: Found): Promise<Partial<Record<string, number | string | null>>> {
  const client = new ModbusRTU();
  await client.connectTCP(found.host, { port: PORT });
  client.setID(found.unitId);
  client.setTimeout(3000);

  const keys = [
    "device_model",
    "device_sn",
    "device_sw_version",
    "rated_energy",
    "battery_status",
    "battery_soc",
    "pv_power",
    "third_party_pv_power",
    "battery_power",
    "load_power",
    "grid_power",
    "ac_grid_output_power",
    "grid_import_limit",
    "grid_export_limit",
    "operating_mode",
    "battery_power_setpoint",
    "pv_total_generation",
    "cumulative_charge_energy",
    "cumulative_discharge_energy",
    "charging_limit_soc",
    "discharge_limit_soc",
    "backup_reserve_soc",
    "backup_soc_enable",
  ] as const;

  console.log("\n=== Live values ===");
  const live: Partial<Record<string, number | string | null>> = {};
  for (const key of keys) {
    const def = REGISTERS[key];
    const words = await read(client, found.kind, def.address, def.count);
    if (!words) {
      console.log("  %s <read failed>", key.padEnd(28));
      continue;
    }
    const v = decodeValue(words, 0, def);
    live[key] = v;
    const enumDef = (def as { enum?: Record<number, string> }).enum;
    const label = enumDef && typeof v === "number" ? " (" + (enumDef[v] ?? "unknown") + ")" : "";
    const unitDef = (def as { unit?: string }).unit;
    const unit = unitDef ? " " + unitDef : "";
    console.log("  %s %s%s%s   [raw %s]", key.padEnd(28), v, unit, label, JSON.stringify(words));
  }

  client.close(() => {});
  return live;
}

/**
 * Derive the battery sign convention from the device itself.
 *
 * battery_status reports charging/discharging independently of the power
 * register, so when the battery is actually moving energy we can settle the
 * convention as fact instead of asking the user to eyeball the app. Returns
 * null while the battery is idle, in which case the caller keeps whatever is
 * already configured.
 */
function detectBatteryInversion(live: Partial<Record<string, number | string | null>>): boolean | null {
  const status = live["battery_status"];
  const power = live["battery_power"];
  if (typeof status !== "number" || typeof power !== "number") return null;

  const label = BATTERY_STATUS[status];
  if (Math.abs(power) < 50) return null; // idle: sign carries no information
  if (label !== "charging" && label !== "discharging") return null;

  // Our convention: positive means charging.
  const deviceSaysCharging = label === "charging";
  const registerSaysCharging = power > 0;
  return deviceSaysCharging !== registerSaysCharging;
}

function reportSigns(live: Partial<Record<string, number | string | null>>, invertBattery: boolean | null) {
  console.log("\n=== Sign conventions ===");
  console.log("This dashboard normalises to: battery > 0 = CHARGING, grid > 0 = IMPORTING.\n");

  const status = live["battery_status"];
  const statusLabel = typeof status === "number" ? BATTERY_STATUS[status] : undefined;

  if (invertBattery === null) {
    console.log(
      "  battery: undetermined -- the battery is idle right now, so its sign\n" +
        "           carries no information. Re-run while it is charging or\n" +
        "           discharging to settle it.",
    );
  } else {
    console.log(
      "  battery: device reports %j at %s W -> SOLIX_INVERT_BATTERY=%s",
      statusLabel,
      live["battery_power"],
      invertBattery ? "1" : "0",
    );
  }

  console.log(
    "\n  grid:    reads %s W with AC output %s W. Negative grid alongside a\n" +
      "           positive AC output means exporting, which matches our\n" +
      "           convention, so SOLIX_INVERT_GRID=0.\n" +
      "           Worth a second look once you are importing from the grid --\n" +
      "           a sign error stays invisible until the flow reverses.",
    live["grid_power"],
    live["ac_grid_output_power"],
  );
}

function writeEnv(found: Found, invertBattery: boolean | null, plugHosts: string[]) {
  const envPath = path.join(ROOT, ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const keep = (k: string, fallback: string) =>
    new RegExp("^" + k + "=(.*)$", "m").exec(existing)?.[1] ?? fallback;

  const body = [
    "SOLIX_HOST=" + found.host,
    "SOLIX_PORT=" + PORT,
    "SOLIX_UNIT_ID=" + found.unitId,
    "SOLIX_REGISTER_KIND=" + found.kind,
    "SOLIX_INVERT_BATTERY=" +
      (invertBattery === null ? keep("SOLIX_INVERT_BATTERY", "0") : invertBattery ? "1" : "0"),
    "SOLIX_INVERT_GRID=" + keep("SOLIX_INVERT_GRID", "0"),
    "SOLIX_PLUGS=" + (plugHosts.length > 0 ? plugHosts.join(",") : keep("SOLIX_PLUGS", "")),
    "",
    "HTTP_PORT=" + keep("HTTP_PORT", "8787"),
    "POLL_INTERVAL_MS=" + keep("POLL_INTERVAL_MS", "5000"),
    "PERSIST_INTERVAL_MS=" + keep("PERSIST_INTERVAL_MS", "30000"),
    "",
  ].join("\n");

  fs.writeFileSync(envPath, body);
  console.log("Wrote %s", envPath);
}

/** Dependency-free fallback discovery: TCP-connect sweep of the local /24. */
async function scanSubnet(): Promise<string[]> {
  const bases = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === "IPv4" && !i.internal) bases.add(i.address.split(".").slice(0, 3).join("."));
    }
  }
  if (bases.size === 0) return [];

  const targets = [...bases].flatMap((base) =>
    Array.from({ length: 254 }, (_, i) => base + "." + (i + 1)),
  );
  console.log(
    "No SOLIX_HOST set. Scanning %s for port %d (%d addresses)...",
    [...bases].map((b) => b + ".0/24").join(", "),
    PORT,
    targets.length,
  );

  // Bounded concurrency: Windows throttles half-open connections, and a flat
  // Promise.all over 500 sockets produces spurious ECONNRESET / timeouts that
  // look exactly like "nothing is there".
  const hits: string[] = [];
  const queue = [...targets];
  const worker = async () => {
    for (let ip = queue.pop(); ip !== undefined; ip = queue.pop()) {
      if (await probePort(ip)) {
        console.log("  open: %s:%d", ip, PORT);
        hits.push(ip);
      }
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
  return hits;
}

function probePort(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2000);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
    s.connect(PORT, ip);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
