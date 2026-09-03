/**
 * Finding Solix devices on the LAN.
 *
 * Shared by the probe script and the running server, so a socket that has
 * Modbus switched on later can be picked up without editing .env by hand.
 */
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import ModbusRTU from "modbus-serial";
import { decodeValue } from "./decode.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface FoundPlug {
  host: string;
  model: string;
  serial: string;
  watts: number;
}

/** Every local IPv4 /24 this machine sits on. */
export function localSubnets(): string[] {
  const bases = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === "IPv4" && !i.internal) {
        bases.add(i.address.split(".").slice(0, 3).join("."));
      }
    }
  }
  return [...bases];
}

function probePort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
    s.connect(port, ip);
  });
}

/**
 * TCP-connect sweep of the local /24s.
 *
 * Concurrency is bounded: Windows throttles half-open connections, and a flat
 * Promise.all over 500 sockets produces spurious timeouts that look exactly
 * like "nothing is there".
 */
export async function scanSubnet(port: number, onOpen?: (ip: string) => void): Promise<string[]> {
  const targets = localSubnets().flatMap((base) =>
    Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`),
  );
  if (targets.length === 0) return [];

  const hits: string[] = [];
  const queue = [...targets];
  const worker = async () => {
    for (let ip = queue.pop(); ip !== undefined; ip = queue.pop()) {
      if (await probePort(ip, port, 2000)) {
        onOpen?.(ip);
        hits.push(ip);
      }
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
  return hits;
}

/** Identify a Smart Plug Gen 2 (A17X8) by its own register block. */
export async function identifyPlug(host: string, port: number, unitId: number): Promise<FoundPlug | null> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    client.setTimeout(2500);

    const model = (await client.readHoldingRegisters(32768, 5)).data as number[];
    const modelStr = String(decodeValue(model, 0, { type: "STRING", count: 5 }) ?? "");
    if (!modelStr.toUpperCase().startsWith("A17X")) return null;

    const sn = (await client.readHoldingRegisters(30005, 12)).data as number[];
    const live = (await client.readHoldingRegisters(30029, 9)).data as number[];

    return {
      host,
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

/**
 * A Smart Meter Gen 2 is a separate Modbus device with its own address, not a
 * register block on the Solarbank -- 10620 there raises "illegal data address".
 * So its presence has to be discovered on the LAN.
 */
export async function identifyMeter(host: string, port: number, unitId: number): Promise<string | null> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    client.setTimeout(2500);
    const w = (await client.readHoldingRegisters(10620, 8)).data as number[];
    const model = String(decodeValue(w, 0, { type: "STRING", count: 8 }) ?? "");
    return model.length >= 3 ? model : null;
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

export function persistMeterHost(host: string): void {
  writeEnvKey("SOLIX_METER", host);
}

export interface FoundSolarbank {
  host: string;
  model: string;
  serial: string;
  soc: number;
}

/** Identify a Solarbank by its model and serial registers. */
export async function identifySolarbank(
  host: string,
  port: number,
  unitId: number,
): Promise<FoundSolarbank | null> {
  const client = new ModbusRTU();
  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    client.setTimeout(2500);

    const model = (await client.readHoldingRegisters(32768, 5)).data as number[];
    const modelStr = String(decodeValue(model, 0, { type: "STRING", count: 5 }) ?? "");
    // Smart plugs answer the same address, so exclude them explicitly.
    if (!modelStr || modelStr.toUpperCase().startsWith("A17X")) return null;

    const socWords = (await client.readHoldingRegisters(10014, 1)).data as number[];
    const soc = Number(decodeValue(socWords, 0, { type: "UINT16", count: 1 }) ?? -1);
    if (soc < 0 || soc > 100) return null;

    const sn = (await client.readHoldingRegisters(10100, 12)).data as number[];
    return {
      host,
      model: modelStr,
      serial: String(decodeValue(sn, 0, { type: "STRING", count: 12 }) ?? ""),
      soc,
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

/**
 * Sweep the LAN for a Solarbank.
 *
 * When a serial is known, prefer that exact unit: on a network with more than
 * one Solarbank, picking "the first that answers" would silently latch onto
 * the wrong battery after a DHCP move.
 */
export async function discoverSolarbank(
  port: number,
  unitId: number,
  preferSerial?: string,
): Promise<FoundSolarbank | null> {
  const hosts = await scanSubnet(port);
  const found: FoundSolarbank[] = [];
  for (const host of hosts) {
    const sb = await identifySolarbank(host, port, unitId);
    if (!sb) continue;
    if (preferSerial && sb.serial === preferSerial) return sb;
    found.push(sb);
  }
  return found[0] ?? null;
}

/** Persist a rediscovered address so a restart does not sweep again. */
export function persistHost(host: string): void {
  writeEnvKey("SOLIX_HOST", host);
}

/** Rewrite a single key in .env, leaving every other line untouched. */
function writeEnvKey(key: string, value: string): void {
  const envPath = path.join(ROOT, ".env");
  let text = "";
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    /* .env does not exist yet */
  }

  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  text = pattern.test(text) ? text.replace(pattern, line) : [text.trimEnd(), line, ""].join("\n");

  fs.writeFileSync(envPath, text.replace(/^\n+/, ""));
}

/** Sweep the LAN and return every socket that answers Modbus. */
export async function discoverPlugs(port: number, unitId: number, skip: string[] = []): Promise<FoundPlug[]> {
  const hosts = await scanSubnet(port);
  const found: FoundPlug[] = [];
  for (const host of hosts) {
    if (skip.includes(host)) continue;
    const plug = await identifyPlug(host, port, unitId);
    if (plug) found.push(plug);
  }
  return found;
}

/**
 * Persist the socket list so a restart keeps it. Rewrites only SOLIX_PLUGS and
 * leaves every other line of .env untouched.
 */
export function persistPlugHosts(hosts: string[]): void {
  writeEnvKey("SOLIX_PLUGS", hosts.join(","));
}
