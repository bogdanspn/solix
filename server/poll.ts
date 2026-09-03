import { EventEmitter } from "node:events";
import { config } from "./config.ts";
import { SolixClient } from "./modbus.ts";
import { accumulatePlugEnergy, plugTotals, recordSample, rollup } from "./history.ts";
import { hasPlugs, readPlugs } from "./plugs.ts";
import { discoverSolarbank, persistHost } from "./discovery.ts";
import { cachedWeather } from "./weather.ts";
import { setHost } from "./config.ts";
import type { DeviceInfo, Eta, Snapshot } from "./types.ts";

export const client = new SolixClient();
export const events = new EventEmitter();

let latest: Snapshot | null = null;
let device: DeviceInfo | null = null;
let lastGoodTs = 0;
let lastPersistTs = 0;
let consecutiveFailures = 0;
let lastPlugTs = 0;
/**
 * Recent battery power, for the charge/discharge estimate.
 *
 * A single instantaneous reading is far too jumpy to divide by: a cloud
 * crossing the array swings it hundreds of watts and the estimate would leap
 * between 40 minutes and 6 hours. Averaging a couple of minutes keeps it
 * steady while still tracking real change.
 */
const RATE_WINDOW_MS = 150_000;
const rateHistory: Array<{ ts: number; w: number }> = [];

/** Test hook: clear the rolling rate window. */
export function resetRateHistory(): void {
  rateHistory.length = 0;
}

function averageBatteryW(now: number): number {
  while (rateHistory.length > 0 && now - (rateHistory[0]?.ts ?? 0) > RATE_WINDOW_MS) {
    rateHistory.shift();
  }
  if (rateHistory.length === 0) return 0;
  return rateHistory.reduce((t, r) => t + r.w, 0) / rateHistory.length;
}

/**
 * Time to the charge limit, or down to the discharge floor.
 *
 * Deliberately framed as "at this rate": it extrapolates the recent average,
 * it does not model the sun. When charging, it is cross-checked against
 * today's sunset, because an estimate that runs past dark will not happen.
 */
export function estimateEta(snapshot: Snapshot, ratedKwh: number): Eta {
  const now = snapshot.ts;
  rateHistory.push({ ts: now, w: snapshot.batteryW });
  const basisW = averageBatteryW(now);

  const idle: Eta = {
    direction: "idle",
    minutes: null,
    targetSoc: snapshot.soc,
    basisW: Math.round(basisW),
    beforeSunset: null,
  };

  // Below this the estimate is meaningless and the divisor explodes.
  if (Math.abs(basisW) < 60 || ratedKwh <= 0) return idle;

  const charging = basisW > 0;
  const targetSoc = charging ? snapshot.settings.chargingLimitSoc : snapshot.settings.dischargeLimitSoc;
  const deltaSoc = charging ? targetSoc - snapshot.soc : snapshot.soc - targetSoc;
  if (deltaSoc <= 0) return idle;

  const kwhNeeded = (deltaSoc / 100) * ratedKwh;
  const hours = kwhNeeded / (Math.abs(basisW) / 1000);
  const minutes = Math.round(hours * 60);

  // Anything beyond a couple of days is noise, not a forecast.
  if (!Number.isFinite(minutes) || minutes > 2880) return idle;

  let beforeSunset: boolean | null = null;
  if (charging) {
    const sunset = cachedWeather()?.days[0]?.sunset;
    if (sunset) {
      const sunsetMs = new Date(sunset).getTime();
      if (Number.isFinite(sunsetMs)) beforeSunset = now + minutes * 60_000 <= sunsetMs;
    }
  }

  return {
    direction: charging ? "charge" : "discharge",
    minutes,
    targetSoc,
    basisW: Math.round(basisW),
    beforeSunset,
  };
}

let rediscovering = false;
let lastRediscoverAt = 0;

/**
 * Hunt for the Solarbank again after it stops answering.
 *
 * A DHCP lease change is the common case, and without this the dashboard stays
 * dead until someone edits .env. The known serial is preferred, so a network
 * with two Solarbanks cannot silently latch onto the wrong one.
 */
export async function rediscover(force = false): Promise<string | null> {
  if (rediscovering) return null;
  // A full sweep is ~500 TCP connects; do not run it in a tight loop.
  if (!force && Date.now() - lastRediscoverAt < 120_000) return null;

  rediscovering = true;
  lastRediscoverAt = Date.now();
  try {
    const found = await discoverSolarbank(config.port, config.unitId, device?.serial);
    if (!found) return null;

    if (found.host !== config.host) {
      console.log("[rediscover] Solarbank moved to %s (%s)", found.host, found.serial);
      setHost(found.host);
      persistHost(found.host);
    }
    client.reset();
    consecutiveFailures = 0;
    return found.host;
  } catch (err) {
    console.warn("[rediscover] %s", err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    rediscovering = false;
  }
}

export function getLatest(): Snapshot | null {
  if (!latest) return null;
  const staleSeconds = Math.max(0, Math.round((Date.now() - lastGoodTs) / 1000));
  return {
    ...latest,
    staleSeconds,
    // Two missed polls is the threshold: one can be a transient blip, but the
    // UI must stop presenting stale numbers as live.
    online: consecutiveFailures < 2,
  };
}

export function getDevice(): DeviceInfo | null {
  return device;
}

/**
 * Resolve household consumption.
 *
 * The Solarbank only reports load_power when a Smart Meter is paired; without
 * one it sits at 0 while power still flows. Smart plugs each meter their own
 * branch, so their sum is the next best measurement. Whatever the sockets do
 * not account for -- a custom-mode baseline, or an unmetered circuit -- is
 * reported separately rather than folded in silently.
 */
async function attachHome(snapshot: Snapshot): Promise<void> {
  // Meter presence is a property of the network, not of a register value.
  //
  // This used to key off load_power being non-zero, which was wrong: with the
  // sun up that register reads ~40 W while the sockets draw ~450 W, so it is
  // not household consumption and its being non-zero says nothing about a
  // meter. Observed relation: grid_power = -(ac_output - load_power).
  if (config.meterHost) {
    snapshot.homeW = snapshot.loadW;
    snapshot.homeSource = "meter";
    snapshot.gridMeasured = true;
    snapshot.plugs = hasPlugs() ? await readPlugs() : [];
    snapshot.unmeteredW = 0;
    return;
  }

  if (!hasPlugs()) {
    snapshot.homeSource = "none";
    return;
  }

  const plugs = await readPlugs();
  const socketTotal = plugs.reduce((sum, p) => sum + (p.online ? p.watts : 0), 0);

  const now = Date.now();
  if (lastPlugTs) accumulatePlugEnergy(plugs, (now - lastPlugTs) / 1000);
  lastPlugTs = now;

  const totals = plugTotals();
  for (const p of plugs) {
    const t = totals[p.serial];
    if (t) Object.assign(p, t);
  }

  snapshot.plugs = plugs;
  snapshot.homeW = Math.round(socketTotal * 10) / 10;
  snapshot.homeSource = "sockets";
  // The Solarbank's AC output minus what the sockets measured.
  snapshot.unmeteredW = Math.max(0, Math.round(Math.abs(snapshot.acOutW) - socketTotal));
}

async function tick(): Promise<void> {
  try {
    const { snapshot, device: info } = await client.poll();
    await attachHome(snapshot);
    snapshot.eta = estimateEta(snapshot, info.ratedKwh);
    latest = snapshot;
    device = info;
    lastGoodTs = snapshot.ts;
    consecutiveFailures = 0;

    if (snapshot.ts - lastPersistTs >= config.persistIntervalMs) {
      lastPersistTs = snapshot.ts;
      recordSample(snapshot);
    }

    events.emit("snapshot", getLatest());
  } catch (err) {
    consecutiveFailures++;
    // Log the first failure and then every 12th, so a device that is off
    // overnight does not fill the console.
    if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
      console.warn(
        "[poll] read failed (%d in a row): %s",
        consecutiveFailures,
        err instanceof Error ? err.message : String(err),
      );
    }

    // Roughly a minute of silence: assume the address is stale and go look.
    if (consecutiveFailures >= 12) void rediscover();
    events.emit("snapshot", getLatest());
  }
}

export function startPolling(): void {
  // No address configured at all: a fresh install by someone else.
  if (!config.host) {
    console.log("[startup] No SOLIX_HOST set, sweeping the LAN...");
    void rediscover(true).then((host) => {
      if (host) void tick();
      else console.error("[startup] No Solarbank found. Check Modbus TCP is enabled in the app.");
    });
  }

  void tick();
  // Back off to 30s after sustained failures so an offline device is not
  // hammered every 5 seconds, and recover immediately once it answers.
  const schedule = () => {
    const delay = consecutiveFailures >= 6 ? 30_000 : config.pollIntervalMs;
    setTimeout(async () => {
      await tick();
      schedule();
    }, delay).unref();
  };
  schedule();

  setInterval(() => {
    try {
      rollup();
    } catch (err) {
      console.warn("[rollup] %s", err instanceof Error ? err.message : String(err));
    }
  }, 3600_000).unref();
}
