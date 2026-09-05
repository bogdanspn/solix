/** Shapes shared between the server and the browser bundle. */

export interface DeviceInfo {
  model: string;
  /** Friendly name resolved from the model code, e.g. "Solarbank 4 E5000 Pro". */
  name: string;
  serial: string;
  firmware: string;
  ratedKwh: number;
  /**
   * Battery packs, inferred from rated capacity at 5 kWh per pack. The device
   * exposes no per-pack registers -- sweeping 10000-10400, 10600-10730 and the
   * 20000/30000/40000/50000 ranges turns up no repeating three-block
   * structure, only this aggregate.
   */
  packs: number;
  host: string;
}

export interface Settings {
  chargingLimitSoc: number;
  dischargeLimitSoc: number;
  backupReserveSoc: number;
  backupSocEnable: boolean;
  operatingMode: string;
}

export interface PlugReading {
  host: string;
  serial: string;
  model: string;
  firmware: string;
  /** Friendly name, editable and stored in data/plug-names.json. */
  name: string;
  on: boolean;
  watts: number;
  volts: number;
  amps: number;
  tempC: number;
  online: boolean;
  /**
   * Energy integrated locally from the power stream -- the plugs expose no
   * counter of their own, so these are estimates at poll resolution.
   */
  todayKwh: number;
  weekKwh: number;
  monthKwh: number;
}

export interface PvString {
  /** 1-based label, matching the app's PV1..PV4. */
  index: number;
  volts: number;
  amps: number;
  watts: number;
  /**
   * True for the fourth string, whose power is inferred as the shortfall
   * between pv_power and the three measured strings - the device exposes no
   * registers for it.
   */
  derived: boolean;
}

export interface Eta {
  /** "charge" toward the charge limit, "discharge" toward the discharge floor. */
  direction: "charge" | "discharge" | "idle";
  /** Minutes at the recent average rate, or null when the rate is too small. */
  minutes: number | null;
  /** The state of charge this estimate runs to. */
  targetSoc: number;
  /** Average battery power the estimate is based on, W. */
  basisW: number;
  /**
   * For charging: whether the estimate lands before today's sunset. Null when
   * no forecast is available, or when discharging.
   */
  beforeSunset: boolean | null;
}

export interface Snapshot {
  /** Unix milliseconds when this reading was taken. */
  ts: number;
  /** False when the last poll failed; values are then the last known good ones. */
  online: boolean;
  /** Age of the data in seconds. The UI greys out when this grows. */
  staleSeconds: number;

  soc: number;
  batteryStatus: string;
  /** Normalised: > 0 charging, < 0 discharging. */
  batteryW: number;
  pvW: number;
  thirdPartyPvW: number;
  loadW: number;
  /** Normalised: > 0 importing, < 0 exporting. */
  gridW: number;
  acOutW: number;
  /** Ceiling on power drawn FROM the grid, from the app's own setting. */
  gridImportLimitW: number;
  /** Ceiling on power sent TO the grid. */
  gridExportLimitW: number;
  setpointW: number;
  operatingMode: string;

  /** Confirmed live measurements from undocumented registers. */
  gridHz: number;
  acVolts: number;
  /** Inferred decodes -- plausible but unproven, shown as indicative. */
  batteryTempC: number;
  batteryHealth: number;

  /** Three measured MPPT inputs plus the derived fourth. */
  strings: PvString[];

  /** Time to the charge limit or discharge floor at the recent average rate. */
  eta: Eta;

  pvTotalKwh: number;
  chargeTotalKwh: number;
  dischargeTotalKwh: number;

  settings: Settings;

  /** Smart plugs, when any are configured. */
  plugs: PlugReading[];
  /**
   * Measured household consumption: the Solarbank's own load reading when a
   * Smart Meter is paired, otherwise the sum of the sockets.
   */
  homeW: number;
  /** Where the home figure comes from, so the UI can be honest about it. */
  homeSource: "meter" | "sockets" | "none";
  /**
   * True only when a Smart Meter is paired. Without one, grid_power (10012)
   * is not a grid measurement at all -- it mirrors ac_grid_output_power
   * exactly (observed -1180/1180, -1420/1420, -400/400), so it reports what
   * the Solarbank puts out, not what crosses the meter.
   */
  gridMeasured: boolean;
  /**
   * Output the sockets do not account for -- the custom-mode baseline plus
   * anything on an unmetered circuit.
   */
  unmeteredW: number;
}

export interface HistoryPoint {
  ts: number;
  pvW: number;
  batteryW: number;
  loadW: number;
  gridW: number;
  soc: number;
}

export interface EnergyTotals {
  pvKwh: number;
  chargeKwh: number;
  dischargeKwh: number;
}

export interface HistoryResponse {
  range: "day" | "week" | "month";
  points: HistoryPoint[];
  totals: EnergyTotals;
  today: EnergyTotals;
  window?: { start: number; end: number; coverage: number };
  daily?: Array<EnergyTotals & { date: string; coverage: number }>;
  previous?: { totals: EnergyTotals; coverage: number };
  sameTimeYesterday?: { totals: EnergyTotals; coverage: number; todayCoverage: number };
  events?: Array<{ ts: number; kind: string; label: string }>;
}
