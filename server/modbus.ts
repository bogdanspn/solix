import ModbusRTU from "modbus-serial";
import { config } from "./config.ts";
import { decodeValue } from "./decode.ts";
import {
  BATTERY_STATUS,
  BLOCKS,
  operatingModeLabel,
  REGISTERS,
  type Block,
  type RegisterKey,
} from "./registers.ts";
import type { DeviceInfo, PvString, Snapshot } from "./types.ts";

const MODEL_NAMES: Record<string, string> = {
  AE103: "Solarbank 4 E5000 Pro",
  A17E2: "Solarbank Max AC",
};

/** Raw register words keyed by block name. */
export type BlockData = Map<string, number[]>;

export interface PollResult {
  snapshot: Snapshot;
  device: DeviceInfo;
}

export class SolixClient {
  private client = new ModbusRTU();
  private connected = false;
  /** modbus-serial serialises poorly under concurrency, so requests queue. */
  private chain: Promise<unknown> = Promise.resolve();
  private staticBlocks: BlockData = new Map();

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connectTCP(config.host, { port: config.port });
    this.client.setID(config.unitId);
    this.client.setTimeout(4000);
    this.connected = true;
  }

  private disconnect(): void {
    this.connected = false;
    try {
      this.client.close(() => {});
    } catch {
      /* already down */
    }
  }

  /** Serialise every Modbus operation onto a single chain. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.chain = next.catch(() => {});
    return next;
  }

  private async readBlock(block: Block): Promise<number[]> {
    await this.connect();
    const res =
      config.registerKind === "holding"
        ? await this.client.readHoldingRegisters(block.start, block.count)
        : await this.client.readInputRegisters(block.start, block.count);
    return res.data as number[];
  }

  /** Read every block and decode a full snapshot. Throws if the device is unreachable. */
  async poll(): Promise<PollResult> {
    return this.run(async () => {
      try {
        const data: BlockData = new Map(this.staticBlocks);

        for (const block of BLOCKS) {
          if (block.static && data.has(block.name)) continue;
          const words = await this.readBlock(block);
          data.set(block.name, words);
          if (block.static) this.staticBlocks.set(block.name, words);
        }

        return { snapshot: decodeSnapshot(data), device: deviceInfoFrom(data) };
      } catch (err) {
        // Force a fresh socket next time; a half-open connection otherwise
        // keeps failing forever.
        this.disconnect();
        throw err;
      }
    });
  }

  /** Write a single 16-bit register, then read it back so callers see the truth. */
  async writeRegister(address: number, value: number): Promise<number | null> {
    return this.run(async () => {
      try {
        await this.connect();
        await this.client.writeRegister(address, value & 0xffff);
        const res = await this.client.readHoldingRegisters(address, 1);
        const words = res.data as number[];
        return words[0] ?? null;
      } catch (err) {
        this.disconnect();
        throw err;
      }
    });
  }

  /** Drop cached static blocks so identity is re-read (e.g. after a firmware update). */
  invalidateStatic(): void {
    this.staticBlocks.clear();
  }

  /**
   * Force a fresh socket, for when the device has moved to a new address.
   * Identity is re-read too, so a different unit cannot inherit the old one.
   */
  reset(): void {
    this.disconnect();
    this.staticBlocks.clear();
  }
}

/** Locate the block holding a register and pull the decoded value out of it. */
function value(data: BlockData, key: RegisterKey): number | string | null {
  const def = REGISTERS[key];
  for (const block of BLOCKS) {
    if (def.address < block.start || def.address + def.count > block.start + block.count) continue;
    const words = data.get(block.name);
    if (!words) continue;
    return decodeValue(words, def.address - block.start, def);
  }
  return null;
}

const numberAt = (data: BlockData, key: RegisterKey): number => {
  const v = value(data, key);
  return typeof v === "number" ? v : 0;
};

const stringAt = (data: BlockData, key: RegisterKey): string => {
  const v = value(data, key);
  return typeof v === "string" ? v : "";
};

export function decodeSnapshot(data: BlockData): Snapshot {
  const batteryRaw = numberAt(data, "battery_power");
  const gridRaw = numberAt(data, "grid_power");
  // The setpoint register already signs discharge negative -- the opposite of
  // battery_power on the same device -- so it needs no inversion. Observed:
  // battery_power +1380 and setpoint -1380 while the device reported
  // "discharging".
  const setpointW = numberAt(data, "battery_power_setpoint");

  const batterySign = config.invertBattery ? -1 : 1;
  const gridSign = config.invertGrid ? -1 : 1;

  const pvW = numberAt(data, "pv_power");
  const strings = decodeStrings(data, pvW);

  const statusCode = numberAt(data, "battery_status");
  const modeCode = numberAt(data, "operating_mode");

  return {
    ts: Date.now(),
    online: true,
    staleSeconds: 0,

    soc: numberAt(data, "battery_soc"),
    batteryStatus: BATTERY_STATUS[statusCode] ?? "unknown",
    batteryW: batteryRaw * batterySign,
    pvW: numberAt(data, "pv_power"),
    thirdPartyPvW: numberAt(data, "third_party_pv_power"),
    loadW: numberAt(data, "load_power"),
    gridW: gridRaw * gridSign,
    acOutW: numberAt(data, "ac_grid_output_power"),
    gridImportLimitW: numberAt(data, "grid_import_limit"),
    gridExportLimitW: numberAt(data, "grid_export_limit"),
    setpointW,
    operatingMode: operatingModeLabel(modeCode),

    gridHz: numberAt(data, "grid_frequency"),
    acVolts: numberAt(data, "ac_voltage"),
    batteryTempC: numberAt(data, "battery_temp"),
    batteryHealth: numberAt(data, "battery_health"),

    strings,
    // Filled in by the poller, which holds the rate history.
    eta: { direction: "idle", minutes: null, targetSoc: 0, basisW: 0, beforeSunset: null },

    pvTotalKwh: numberAt(data, "pv_total_generation"),
    chargeTotalKwh: numberAt(data, "cumulative_charge_energy"),
    dischargeTotalKwh: numberAt(data, "cumulative_discharge_energy"),

    settings: {
      chargingLimitSoc: numberAt(data, "charging_limit_soc"),
      dischargeLimitSoc: numberAt(data, "discharge_limit_soc"),
      backupReserveSoc: numberAt(data, "backup_reserve_soc"),
      backupSocEnable: numberAt(data, "backup_soc_enable") === 1,
      operatingMode: operatingModeLabel(modeCode),
    },

    // Filled in by the poller once the sockets have been read.
    plugs: [],
    homeW: 0,
    homeSource: "none",
    gridMeasured: false,
    unmeteredW: 0,
  };
}

/** Three measured strings, plus the fourth inferred from the shortfall. */
function decodeStrings(data: BlockData, pvTotalW: number): PvString[] {
  const pairs: Array<[RegisterKey, RegisterKey]> = [
    ["pv1_voltage", "pv1_current"],
    ["pv2_voltage", "pv2_current"],
    ["pv3_voltage", "pv3_current"],
  ];

  const measured: PvString[] = pairs.map(([v, a], i) => {
    // Clamp at zero: a string cannot produce negative power, and the sensors
    // wander a little below zero in the dark.
    const volts = Math.max(numberAt(data, v), 0);
    const amps = Math.max(numberAt(data, a), 0);
    return { index: i + 1, volts, amps, watts: Math.round(volts * amps), derived: false };
  });

  const sum = measured.reduce((t, s) => t + s.watts, 0);
  // Negative shortfall just means V*I overshot the device's own total by a few
  // percent, which happens at very low output. Floor it rather than dropping
  // the string, so the panel keeps a stable four slots and an idle input reads
  // as 0 W instead of vanishing.
  const rest = Math.max(0, Math.round(pvTotalW - sum));

  measured.push({ index: 4, volts: 0, amps: 0, watts: rest, derived: true });
  return measured;
}

/** Nominal capacity of one Solarbank 4 pack, base or expansion. */
const PACK_KWH = 5.0;

export function deviceInfoFrom(data: BlockData): DeviceInfo {
  const model = stringAt(data, "device_model");
  const ratedKwh = numberAt(data, "rated_energy");
  return {
    model,
    name: MODEL_NAMES[model.toUpperCase()] ?? `Solix ${model || "device"}`,
    serial: stringAt(data, "device_sn"),
    firmware: stringAt(data, "device_sw_version"),
    ratedKwh,
    packs: ratedKwh > 0 ? Math.round(ratedKwh / PACK_KWH) : 0,
    host: config.host,
  };
}
