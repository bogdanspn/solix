import "dotenv/config";

function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  host: process.env.SOLIX_HOST ?? "",
  port: num("SOLIX_PORT", 502),
  unitId: num("SOLIX_UNIT_ID", 1),
  registerKind: (process.env.SOLIX_REGISTER_KIND ?? "holding") as "holding" | "input",

  /**
   * The Solarbank 4 reports positive power while discharging; we normalise to
   * "positive means charging". The probe derives this from battery_status.
   */
  invertBattery: bool("SOLIX_INVERT_BATTERY"),
  invertGrid: bool("SOLIX_INVERT_GRID"),

  /**
   * Smart plugs found on the LAN. Without a Smart Meter these are the only
   * measurement of household consumption, so their sum stands in for load.
   */
  /**
   * Smart Meter address, when one is on the LAN. Only with a meter are the
   * Solarbank's grid and load registers actual house measurements.
   */
  meterHost: process.env.SOLIX_METER ?? "",

  plugHosts: (process.env.SOLIX_PLUGS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),

  /**
   * Bind address. Defaults to all interfaces so the dashboard is reachable
   * from a phone on the LAN; set to 127.0.0.1 when a reverse proxy fronts it.
   */
  httpHost: process.env.HTTP_HOST ?? "0.0.0.0",
  httpPort: num("HTTP_PORT", 8787),
  pollIntervalMs: num("POLL_INTERVAL_MS", 5000),
  persistIntervalMs: num("PERSIST_INTERVAL_MS", 30000),
};

/**
 * A missing host is not fatal: the server sweeps the LAN for the Solarbank at
 * startup. That covers a fresh install by someone else, and a DHCP move.
 */
export function setHost(host: string): void {
  config.host = host;
}

export function setMeterHost(host: string): void {
  config.meterHost = host;
}
