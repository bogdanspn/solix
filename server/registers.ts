/**
 * Register map for the Anker SOLIX Solarbank 4 E5000 Pro.
 *
 * Source: the per-device YAML shipped with Anker's own Home Assistant
 * integration (anker-charging/ha-anker-solix-official, MIT). `gain` is a
 * divisor applied to the raw integer; `count` is the number of 16-bit
 * registers the value occupies.
 *
 * Note on same-address pairs: the upstream YAML lists
 * battery_charging_power/battery_discharging_power both at 10008, and
 * grid_import_power/grid_export_power both at 10012. Those are not two
 * registers -- they are one signed INT32 that the integration splits by sign.
 * We model them as single signed values (`battery_power`, `grid_power`) and
 * normalise the sign in decode.ts.
 */

export type DataType = "UINT16" | "INT16" | "UINT32" | "INT32" | "STRING";

export interface RegisterDef {
  /** Modbus register address. */
  address: number;
  type: DataType;
  /** Number of 16-bit registers. */
  count: number;
  /** Divisor applied to the raw value. */
  gain?: number;
  unit?: string;
  /** Value -> label mapping for enum registers. */
  enum?: Record<number, string>;
  writable?: boolean;
  /** Inclusive bounds enforced before any write. */
  min?: number;
  max?: number;
}

export const BATTERY_STATUS: Record<number, string> = {
  0: "standby",
  1: "charging",
  2: "discharging",
  3: "sleep",
};

/**
 * Operating modes, by register value.
 *
 * The table that shipped here came from the Solarbank Max AC YAML and is WRONG
 * for the AE103: with the app showing "Custom Mode" this register reads 4,
 * which that table called "socket overlay". Only the observed mapping is
 * asserted; everything else is reported by number rather than guessed, because
 * this register is writable and a wrong label would send the battery into the
 * wrong mode.
 *
 * The app offers: Smart, Self-Consumption, Custom, Time of Use, Dynamic Tariff.
 * Run `npm run learn-modes`, switch modes in the app, and the observed values
 * get printed for filling in here.
 */
export const OPERATING_MODE: Record<number, string> = {
  4: "custom",
};

/** Never invent a name: an unmapped value is shown as its number. */
export function operatingModeLabel(code: number): string {
  return OPERATING_MODE[code] ?? `mode ${code}`;
}

export const OPERATING_MODE_LABELS: Record<string, string> = {
  custom: "Custom",
};

export const REGISTERS = {
  // --- Identity (static; read once at connect) ---
  device_model: { address: 32768, type: "STRING", count: 5 },
  device_sn: { address: 10100, type: "STRING", count: 12 },
  device_sw_version: { address: 10112, type: "STRING", count: 6 },
  ems_mode_mask: { address: 32774, type: "UINT16", count: 1 },
  parallel_capability_mask: { address: 0x8007, type: "UINT16", count: 1 },
  rated_energy: { address: 10250, type: "UINT32", count: 2, gain: 10, unit: "kWh" },

  // --- Live power ---
  battery_status: { address: 10001, type: "UINT16", count: 1, enum: BATTERY_STATUS },
  pv_power: { address: 10002, type: "INT32", count: 2, unit: "W" },
  third_party_pv_power: { address: 10004, type: "INT32", count: 2, unit: "W" },
  battery_power: { address: 10008, type: "INT32", count: 2, unit: "W" },
  load_power: { address: 10010, type: "INT32", count: 2, unit: "W" },
  grid_power: { address: 10012, type: "INT32", count: 2, unit: "W" },
  battery_soc: { address: 10014, type: "UINT16", count: 1, unit: "%" },
  /**
   * Undocumented, found by sweeping the register space (npm run explore).
   * Confirmed live by sampling: both jitter the way real measurements do.
   *   10213 -> 5001..5002 = 50.01-50.02 Hz
   *   10224 -> 2335..2340 = 233.5-234.0 V
   */
  /**
   * Per-string PV, at 10167-10172: three (voltage, current) pairs. The block
   * is exactly six registers -- 10166 and 10173 raise Modbus exceptions.
   *
   * Verified against the app: with it showing 250/450/390/410 W, these pairs
   * gave 247/436/382 W, matching three of the four strings to within ~3%
   * (the app rounds to 10 W). The FOURTH string is not exposed anywhere in
   * the register space -- 10016-10063 and 10140-10210 were both swept -- so
   * it is derived as pv_power minus the sum of these three.
   */
  /*
   * SIGNED, not unsigned. At dusk the current registers dip just below zero
   * and an unsigned read turned -9 into 65527, i.e. 655.27 A, which produced
   * a 22 kW string on a 30 W array.
   */
  pv1_voltage: { address: 10167, type: "INT16", count: 1, gain: 10, unit: "V" },
  pv1_current: { address: 10168, type: "INT16", count: 1, gain: 100, unit: "A" },
  pv2_voltage: { address: 10169, type: "INT16", count: 1, gain: 10, unit: "V" },
  pv2_current: { address: 10170, type: "INT16", count: 1, gain: 100, unit: "A" },
  pv3_voltage: { address: 10171, type: "INT16", count: 1, gain: 10, unit: "V" },
  pv3_current: { address: 10172, type: "INT16", count: 1, gain: 100, unit: "A" },

  grid_frequency: { address: 10213, type: "UINT16", count: 1, gain: 100, unit: "Hz" },
  ac_voltage: { address: 10224, type: "UINT16", count: 1, gain: 10, unit: "V" },
  /**
   * Also undocumented, and INFERRED rather than proven: both held steady over
   * a 30s sample, so the decode is plausible but unverified. 10156 reads 290
   * (29.0 C, sensible for a battery) and 10015 reads 100 (a healthy pack).
   * Treat as indicative; the UI labels them as such.
   */
  battery_temp: { address: 10156, type: "INT16", count: 1, gain: 10, unit: "°C" },
  battery_health: { address: 10015, type: "UINT16", count: 1, unit: "%" },
  ac_grid_output_power: { address: 10208, type: "INT32", count: 2, unit: "W" },
  /*
   * GRID power limits, not battery limits. Anker's integration names these
   * max_charge/max_discharge, which is misleading: the battery charges at up
   * to 2910 W from solar while 10036 sits at 1000 W. Confirmed against the
   * app, where they appear as "max power from grid" (1000 W) and "max power
   * to grid" (2500 W).
   */
  grid_import_limit: { address: 10036, type: "INT32", count: 2, unit: "W" },
  grid_export_limit: { address: 10038, type: "INT32", count: 2, unit: "W" },

  // --- Lifetime energy counters (monotonic; period energy is derived by
  //     differencing these rather than integrating power) ---
  pv_total_generation: { address: 10018, type: "UINT32", count: 2, gain: 10, unit: "kWh" },
  cumulative_charge_energy: { address: 10262, type: "UINT32", count: 2, gain: 10, unit: "kWh" },
  cumulative_discharge_energy: { address: 10264, type: "UINT32", count: 2, gain: 10, unit: "kWh" },

  // --- Mode & setpoint ---
  operating_mode: { address: 10064, type: "UINT16", count: 1, enum: OPERATING_MODE, writable: true },
  // Deliberately read-only in this build: writing it fights the device's own EMS.
  battery_power_setpoint: { address: 10071, type: "INT32", count: 2, unit: "W" },

  // --- Writable settings ---
  charging_limit_soc: { address: 60000, type: "UINT16", count: 1, unit: "%", writable: true, min: 50, max: 100 },
  discharge_limit_soc: { address: 60001, type: "UINT16", count: 1, unit: "%", writable: true, min: 0, max: 50 },
  backup_reserve_soc: { address: 60002, type: "UINT16", count: 1, unit: "%", writable: true, min: 0, max: 100 },
  backup_soc_enable: { address: 60003, type: "UINT16", count: 1, writable: true, min: 0, max: 1 },
} as const satisfies Record<string, RegisterDef>;

export type RegisterKey = keyof typeof REGISTERS;

/** Settings the HTTP API is allowed to write. */
/**
 * operating_mode is deliberately absent: until the value/mode mapping is
 * confirmed on this model, writing it could select a mode other than the one
 * named in the UI.
 */
export const WRITABLE_KEYS = [
  "charging_limit_soc",
  "discharge_limit_soc",
  "backup_reserve_soc",
  "backup_soc_enable",
] as const satisfies readonly RegisterKey[];

export type WritableKey = (typeof WRITABLE_KEYS)[number];

/**
 * Contiguous address blocks read per poll. Batching matters: Modbus allows up
 * to 125 registers per request, so the whole live view is one round trip
 * instead of ten.
 */
export interface Block {
  name: string;
  start: number;
  count: number;
  /** Static blocks are read once at connect and cached. */
  static?: boolean;
}

export const BLOCKS: Block[] = [
  // status, PV, third-party PV, battery, load, grid, SOC, PV lifetime total
  { name: "live", start: 10001, count: 19 },
  { name: "limits", start: 10036, count: 4 },
  { name: "mode", start: 10064, count: 9 },
  { name: "acout", start: 10208, count: 20 },
  { name: "temp", start: 10156, count: 1 },
  { name: "strings", start: 10167, count: 6 },
  { name: "energy", start: 10250, count: 16 },
  { name: "settings", start: 60000, count: 4 },
  { name: "identity", start: 10100, count: 18, static: true },
  { name: "model", start: 32768, count: 8, static: true },
];
