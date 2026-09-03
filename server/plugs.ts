/**
 * Anker SOLIX Smart Plug Gen 2 (model A17X8) over Modbus TCP.
 *
 * Without a Smart Meter the Solarbank reports household load as 0, but the
 * sockets each meter their own branch -- so their sum is the measured load.
 * Register map from the same official-integration YAML as the Solarbank.
 *
 * The live registers are contiguous (30029..30037), so one read per plug per
 * poll covers switch state, power, voltage, current and temperature.
 */
import fs from "node:fs";
import path from "node:path";
import ModbusRTU from "modbus-serial";
import { config } from "./config.ts";
import type { PlugReading } from "./types.ts";

/**
 * The switch is write-only: reading 30047 raises an exception, while
 * switch_status (30029) reports the actual state. Confirmed by sweeping
 * 30038-30060, where every readable address stops at 30046.
 */
const SWITCH_REG = 30047;

const LIVE_START = 30029;
const LIVE_COUNT = 9; // 30029 switch_status .. 30037 temperature

const OFFSET = {
  switch_status: 30029 - LIVE_START,
  real_time_power: 30030 - LIVE_START,
  voltage: 30031 - LIVE_START,
  current: 30032 - LIVE_START,
  temperature: 30037 - LIVE_START,
};

const NAMES_FILE = path.resolve(import.meta.dirname, "..", "data", "plug-names.json");

function loadNames(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(NAMES_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

let names = loadNames();

export function setPlugName(serial: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed) names[serial] = trimmed;
  else delete names[serial];
  fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true });
  fs.writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2));
}

function ascii(words: number[]): string {
  const bytes: number[] = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.slice(0, end))
    .toString("ascii")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
}

interface StaticInfo {
  serial: string;
  model: string;
  firmware: string;
}

class Plug {
  private client = new ModbusRTU();
  private connected = false;
  private info: StaticInfo | null = null;
  private failures = 0;
  private last: PlugReading | null = null;

  constructor(readonly host: string) {}

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connectTCP(this.host, { port: config.port });
    this.client.setID(config.unitId);
    this.client.setTimeout(3000);
    this.connected = true;
  }

  private drop(): void {
    this.connected = false;
    try {
      this.client.close(() => {});
    } catch {
      /* already down */
    }
  }

  private async readStatic(): Promise<StaticInfo> {
    if (this.info) return this.info;
    const sn = (await this.client.readHoldingRegisters(30005, 12)).data as number[];
    const fw = (await this.client.readHoldingRegisters(30017, 6)).data as number[];
    const model = (await this.client.readHoldingRegisters(32768, 5)).data as number[];
    this.info = { serial: ascii(sn), firmware: ascii(fw), model: ascii(model) };
    return this.info;
  }

  get serial(): string {
    return this.info?.serial ?? "";
  }

  /** Switch the socket. Throws if the device refuses or is unreachable. */
  async setSwitch(on: boolean): Promise<void> {
    try {
      await this.connect();
      await this.client.writeRegister(SWITCH_REG, on ? 1 : 0);
    } catch (err) {
      this.drop();
      throw err;
    }
  }

  async read(): Promise<PlugReading> {
    try {
      await this.connect();
      const info = await this.readStatic();
      const w = (await this.client.readHoldingRegisters(LIVE_START, LIVE_COUNT)).data as number[];

      const raw = (o: number) => w[o] ?? 0;
      const signed = (v: number) => (v > 0x7fff ? v - 0x10000 : v);

      this.failures = 0;
      const reading: PlugReading = {
        host: this.host,
        serial: info.serial,
        model: info.model,
        firmware: info.firmware,
        name: names[info.serial] ?? `Socket ${this.host.split(".").pop()}`,
        on: raw(OFFSET.switch_status) === 1,
        watts: raw(OFFSET.real_time_power) / 10,
        volts: raw(OFFSET.voltage) / 10,
        amps: raw(OFFSET.current) / 100,
        tempC: signed(raw(OFFSET.temperature)) / 10,
        online: true,
        todayKwh: 0,
        weekKwh: 0,
        monthKwh: 0,
      };
      this.last = reading;
      return reading;
    } catch {
      this.failures++;
      this.drop();
      // Keep the socket visible with its last values, marked offline, rather
      // than dropping it out of the total and making consumption look lower.
      if (this.last) return { ...this.last, online: false };
      return {
        host: this.host,
        serial: "",
        model: "",
        firmware: "",
        name: `Socket ${this.host.split(".").pop()}`,
        on: false,
        watts: 0,
        volts: 0,
        amps: 0,
        tempC: 0,
        online: false,
        todayKwh: 0,
        weekKwh: 0,
        monthKwh: 0,
      };
    }
  }
}

/** Keyed by host so a rescan can add or drop sockets without losing state. */
const plugs = new Map<string, Plug>(config.plugHosts.map((h) => [h, new Plug(h)]));

export function hasPlugs(): boolean {
  return plugs.size > 0;
}

export function plugHosts(): string[] {
  return [...plugs.keys()];
}

/**
 * Replace the socket list. Existing entries keep their connection and cached
 * identity, so a rescan that finds the same sockets costs nothing.
 */
export function setPlugHosts(hosts: string[]): { added: string[]; removed: string[] } {
  const added = hosts.filter((h) => !plugs.has(h));
  const removed = [...plugs.keys()].filter((h) => !hosts.includes(h));

  for (const h of removed) plugs.delete(h);
  for (const h of added) plugs.set(h, new Plug(h));

  return { added, removed };
}

/** Read every socket in parallel -- they are independent devices. */
export async function readPlugs(): Promise<PlugReading[]> {
  if (plugs.size === 0) return [];
  const readings = await Promise.all([...plugs.values()].map((p) => p.read()));
  // Stable order so the list does not jump around between polls.
  return readings.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function refreshNames(): void {
  names = loadNames();
}

/**
 * Switch a socket on or off, addressed by serial so it survives a DHCP move.
 * The caller is responsible for confirming: this cuts real power.
 */
export async function setPlugSwitch(serial: string, on: boolean): Promise<PlugReading> {
  const plug = [...plugs.values()].find((p) => p.serial === serial);
  if (!plug) throw new Error(`No socket with serial ${serial}`);
  await plug.setSwitch(on);
  // Read back, so the caller sees what the device actually did.
  return plug.read();
}
