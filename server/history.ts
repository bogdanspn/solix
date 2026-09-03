import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { EnergyTotals, HistoryPoint, HistoryResponse, Snapshot } from "./types.ts";

const DATA_DIR = path.resolve(import.meta.dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "history.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS samples (
    ts                  INTEGER PRIMARY KEY,  -- unix seconds
    pv_w                INTEGER NOT NULL,
    third_party_pv_w    INTEGER NOT NULL,
    battery_w           INTEGER NOT NULL,
    load_w              INTEGER NOT NULL,
    grid_w              INTEGER NOT NULL,
    ac_out_w            INTEGER NOT NULL,
    soc                 INTEGER NOT NULL,
    pv_total_kwh        REAL NOT NULL,
    charge_total_kwh    REAL NOT NULL,
    discharge_total_kwh REAL NOT NULL
  );

  /*
   * Per-socket energy.
   *
   * The Smart Plugs expose no cumulative counter -- a full sweep of their
   * register space (30000-30100) turns up only instantaneous power, voltage,
   * current and temperature. Anker's app totals are computed in their cloud
   * from the power stream, so we do the same thing locally: integrate each
   * poll's power over the elapsed time. Accurate to the poll interval, which
   * means brief spikes between samples are missed -- unlike the Solarbank's
   * own counters, this is an estimate.
   */
  CREATE TABLE IF NOT EXISTS plug_energy (
    serial TEXT NOT NULL,
    day    TEXT NOT NULL,   -- local YYYY-MM-DD
    wh     REAL NOT NULL,
    PRIMARY KEY (serial, day)
  );

  CREATE TABLE IF NOT EXISTS hourly (
    hour                INTEGER PRIMARY KEY,  -- unix seconds, truncated to the hour
    pv_w_avg            REAL NOT NULL,
    battery_w_avg       REAL NOT NULL,
    load_w_avg          REAL NOT NULL,
    grid_w_avg          REAL NOT NULL,
    soc_avg             REAL NOT NULL,
    soc_min             INTEGER NOT NULL,
    soc_max             INTEGER NOT NULL,
    pv_kwh              REAL NOT NULL,
    charge_kwh          REAL NOT NULL,
    discharge_kwh       REAL NOT NULL
  );
`);

const insertSample = db.prepare(`
  INSERT OR REPLACE INTO samples
    (ts, pv_w, third_party_pv_w, battery_w, load_w, grid_w, ac_out_w, soc,
     pv_total_kwh, charge_total_kwh, discharge_total_kwh)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function recordSample(s: Snapshot): void {
  insertSample.run(
    Math.floor(s.ts / 1000),
    Math.round(s.pvW),
    Math.round(s.thirdPartyPvW),
    Math.round(s.batteryW),
    // The measured home figure (sockets, or the meter when present) -- the raw
    // load register is 0 on a meterless system and would flatline the chart.
    Math.round(s.homeW),
    Math.round(s.gridW),
    Math.round(s.acOutW),
    Math.round(s.soc),
    s.pvTotalKwh,
    s.chargeTotalKwh,
    s.dischargeTotalKwh,
  );
}

const addPlugWh = db.prepare(`
  INSERT INTO plug_energy (serial, day, wh) VALUES (?, ?, ?)
  ON CONFLICT(serial, day) DO UPDATE SET wh = wh + excluded.wh
`);

function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Integrate this poll's socket power over the elapsed interval. */
export function accumulatePlugEnergy(
  plugs: Array<{ serial: string; watts: number; online: boolean }>,
  seconds: number,
): void {
  // Guard against a resumed laptop or a long stall crediting hours of energy.
  if (!(seconds > 0) || seconds > 120) return;
  const day = localDay();
  for (const p of plugs) {
    if (!p.online || !p.serial || p.watts <= 0) continue;
    addPlugWh.run(p.serial, day, (p.watts * seconds) / 3600);
  }
}

export interface PlugEnergy {
  todayKwh: number;
  weekKwh: number;
  monthKwh: number;
}

/** Energy per socket for today, the last 7 days and the last 30 days. */
export function plugTotals(): Record<string, PlugEnergy> {
  const since = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    return localDay(d);
  };

  const rows = db
    .prepare(`SELECT serial, day, wh FROM plug_energy WHERE day >= ?`)
    .all(since(30)) as Array<{ serial: string; day: string; wh: number }>;

  const today = localDay();
  const weekFrom = since(7);
  const out: Record<string, PlugEnergy> = {};

  for (const r of rows) {
    const e = (out[r.serial] ??= { todayKwh: 0, weekKwh: 0, monthKwh: 0 });
    const kwh = r.wh / 1000;
    e.monthKwh += kwh;
    if (r.day >= weekFrom) e.weekKwh += kwh;
    if (r.day === today) e.todayKwh += kwh;
  }

  for (const e of Object.values(out)) {
    e.todayKwh = Math.round(e.todayKwh * 1000) / 1000;
    e.weekKwh = Math.round(e.weekKwh * 1000) / 1000;
    e.monthKwh = Math.round(e.monthKwh * 1000) / 1000;
  }
  return out;
}

const RANGES = {
  day: { seconds: 24 * 3600, bucket: 300 },
  week: { seconds: 7 * 24 * 3600, bucket: 3600 },
  month: { seconds: 30 * 24 * 3600, bucket: 6 * 3600 },
} as const;

export type Range = keyof typeof RANGES;

export function history(range: Range): HistoryResponse {
  const { seconds, bucket } = RANGES[range];
  const since = Math.floor(Date.now() / 1000) - seconds;

  // Bucket in SQL so a month of 30s samples never crosses the wire.
  const rows = db
    .prepare(
      `SELECT (ts / ?) * ? AS bucket_ts,
              AVG(pv_w)      AS pv_w,
              AVG(battery_w) AS battery_w,
              AVG(load_w)    AS load_w,
              AVG(grid_w)    AS grid_w,
              AVG(soc)       AS soc
       FROM samples
       WHERE ts >= ?
       GROUP BY bucket_ts
       ORDER BY bucket_ts`,
    )
    .all(bucket, bucket, since) as Array<Record<string, number>>;

  const points: HistoryPoint[] = rows.map((r) => ({
    ts: (r["bucket_ts"] ?? 0) * 1000,
    pvW: Math.round(r["pv_w"] ?? 0),
    batteryW: Math.round(r["battery_w"] ?? 0),
    loadW: Math.round(r["load_w"] ?? 0),
    gridW: Math.round(r["grid_w"] ?? 0),
    soc: Math.round(r["soc"] ?? 0),
  }));

  return { range, points, totals: totalsSince(since) };
}

/**
 * Energy over a period, derived by differencing the device's own lifetime
 * counters rather than integrating instantaneous power. Those counters are
 * what the device itself reports in the app, so the figures match instead of
 * drifting a few percent over a day.
 *
 * Counters are monotonic, so any decrease means a firmware reset. We sum only
 * the non-negative deltas, which drops the reset step instead of emitting a
 * large negative number.
 */
export function totalsSince(sinceSeconds: number): EnergyTotals {
  const rows = db
    .prepare(
      `SELECT pv_total_kwh, charge_total_kwh, discharge_total_kwh
       FROM samples WHERE ts >= ? ORDER BY ts`,
    )
    .all(sinceSeconds) as Array<Record<string, number>>;

  const totals: EnergyTotals = { pvKwh: 0, chargeKwh: 0, dischargeKwh: 0 };
  const cols: Array<[keyof EnergyTotals, string]> = [
    ["pvKwh", "pv_total_kwh"],
    ["chargeKwh", "charge_total_kwh"],
    ["dischargeKwh", "discharge_total_kwh"],
  ];

  for (const [key, col] of cols) {
    let sum = 0;
    let prev: number | null = null;
    for (const row of rows) {
      const v = row[col];
      if (typeof v !== "number") continue;
      if (prev !== null && v >= prev) sum += v - prev;
      prev = v;
    }
    totals[key] = Math.round(sum * 100) / 100;
  }
  return totals;
}

/** Energy since local midnight - what the app's "today" figures show. */
export function todayTotals(): EnergyTotals {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return totalsSince(Math.floor(midnight.getTime() / 1000));
}

/** Roll finished hours into the `hourly` table so long ranges stay cheap. */
export function rollup(): void {
  const cutoff = Math.floor(Date.now() / 1000 / 3600) * 3600;
  db.prepare(
    `INSERT OR REPLACE INTO hourly
       (hour, pv_w_avg, battery_w_avg, load_w_avg, grid_w_avg,
        soc_avg, soc_min, soc_max, pv_kwh, charge_kwh, discharge_kwh)
     SELECT (ts / 3600) * 3600 AS hour,
            AVG(pv_w), AVG(battery_w), AVG(load_w), AVG(grid_w),
            AVG(soc), MIN(soc), MAX(soc),
            MAX(pv_total_kwh) - MIN(pv_total_kwh),
            MAX(charge_total_kwh) - MIN(charge_total_kwh),
            MAX(discharge_total_kwh) - MIN(discharge_total_kwh)
     FROM samples
     WHERE ts < ?
     GROUP BY hour`,
  ).run(cutoff);
}

/** Largest PV output ever recorded, for scaling displays against real peak. */
export function peakPvW(): number {
  const row = db.prepare("SELECT MAX(pv_w) AS peak FROM samples").get() as { peak: number | null };
  return row.peak ?? 0;
}

export function sampleCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM samples").get() as { n: number };
  return row.n;
}
