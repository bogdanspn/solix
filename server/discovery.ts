/**
 * Finding Solix devices on the LAN.
 *
 * Shared by the probe script and the running server, so a socket that has
 * Modbus switched on later can be picked up without editing .env by hand.
 */
import net from "node:net";
import { spawn } from "node:child_process";
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

/**
 * Virtual interfaces to ignore when working out what to scan.
 *
 * A homelab running Docker presents several bridges, and sweeping them is not
 * merely wasted effort: on the reported run they added 508 addresses to a
 * 762-address sweep, and every one of them held a worker slot for the full
 * timeout while the real devices were being probed.
 */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|tun|tap|zt|wg|lo)/i;

/**
 * Every local IPv4 /24 worth scanning.
 *
 * SOLIX_SUBNETS overrides the detection entirely, as a comma separated list of
 * /24 bases ("192.168.3"), for a host whose real LAN sits behind an interface
 * this cannot tell apart from a bridge.
 */
export function localSubnets(): string[] {
  const override = (process.env.SOLIX_SUBNETS ?? "").trim();
  if (override) {
    return override
      .split(",")
      .map((s) => s.trim().split(".").slice(0, 3).join("."))
      .filter(Boolean);
  }

  const bases = new Set<string>();
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
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

/** Run probePort over a list of addresses with a bounded number in flight. */
async function sweep(
  targets: string[],
  port: number,
  concurrency: number,
  timeoutMs: number,
  onOpen?: (ip: string) => void,
): Promise<string[]> {
  const hits: string[] = [];
  const queue = [...targets];
  const worker = async () => {
    for (let ip = queue.pop(); ip !== undefined; ip = queue.pop()) {
      if (await probePort(ip, port, timeoutMs)) {
        onOpen?.(ip);
        hits.push(ip);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return hits;
}

/**
 * Addresses this machine has resolved to a MAC address.
 *
 * This is the key to a reliable retry. ARP resolution happens before the SYN
 * is ever sent, so a host that dropped the TCP handshake still leaves a
 * neighbour entry behind. That turns "retry the 230 addresses that stayed
 * silent" into "retry the 25 that are demonstrably alive", which is cheap
 * enough to do slowly and carefully.
 */
async function neighbours(): Promise<Set<string>> {
  const found = new Set<string>();
  const cmd =
    process.platform === "win32"
      ? { file: "arp", args: ["-a"] }
      : process.platform === "linux"
        ? { file: "ip", args: ["neigh", "show"] }
        : { file: "arp", args: ["-an"] };

  const text = await new Promise<string>((resolve) => {
    let out = "";
    try {
      const p = spawn(cmd.file, cmd.args, { stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (c) => (out += c));
      p.once("error", () => resolve(""));
      p.once("close", () => resolve(out));
    } catch {
      resolve("");
    }
  });

  for (const line of text.split(/\r?\n/)) {
    // An entry without a resolved MAC (FAILED, INCOMPLETE, or Windows'
    // "invalid") means the address did not answer at layer 2 either.
    if (/incomplete|failed|invalid/i.test(line)) continue;
    if (!/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.test(line)) continue;
    const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(line)?.[1];
    if (ip) found.add(ip);
  }
  return found;
}

export interface ScanProgress {
  /** Called once the target list is known, before any connecting starts. */
  onStart?: (bases: string[], count: number) => void;
  onOpen?: (ip: string) => void;
  /** Called before the careful second pass, with how many hosts it will retry. */
  onRetry?: (count: number) => void;
}

/**
 * TCP-connect sweep of the local /24s, in two passes.
 *
 * One pass is not enough. These devices are on WiFi, and a burst of concurrent
 * SYNs loses packets: three consecutive runs of the single-pass version
 * returned five, then seven, then a different seven of the ten sockets. A scan
 * whose answer changes between runs is not finding absent devices, it is
 * dropping present ones, and treating that as "the device is gone" is what
 * previously sent the server into a repeated full-subnet sweep.
 *
 * So: a fast wide pass to find the obvious responders, then a slow narrow pass
 * over everything the ARP table says is alive but that did not answer.
 */
export async function scanSubnet(port: number, progress?: ScanProgress): Promise<string[]> {
  const bases = localSubnets();
  const targets = bases.flatMap((base) => Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`));
  if (targets.length === 0) return [];

  progress?.onStart?.(bases, targets.length);

  const hits = new Set(await sweep(targets, port, 32, 1500, progress?.onOpen));

  // Anything with a MAC address but no answer on 502 is either a device that
  // dropped the handshake or something unrelated that will refuse quickly.
  const inScope = (ip: string) => bases.includes(ip.split(".").slice(0, 3).join("."));
  const retry = [...(await neighbours())].filter((ip) => inScope(ip) && !hits.has(ip));

  if (retry.length > 0) {
    progress?.onRetry?.(retry.length);
    for (const [concurrency, timeoutMs] of [[8, 4000] as const, [4, 6000] as const]) {
      const pending = retry.filter((ip) => !hits.has(ip));
      if (pending.length === 0) break;
      for (const ip of await sweep(pending, port, concurrency, timeoutMs, progress?.onOpen)) {
        hits.add(ip);
      }
    }
  }

  return [...hits];
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
