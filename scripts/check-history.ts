import assert from "node:assert/strict";
import type { Snapshot } from "../server/types.ts";

process.env["SOLIX_HISTORY_FILE"] = ":memory:";
const { recordSample, history, totalsSince, recordStateEvent } = await import("../server/history.ts");
const now = Math.floor(Date.now() / 60_000) * 60_000;
const sample = (ts: number, counter: number) => ({
  ts, pvW: 100, thirdPartyPvW: 0, batteryW: 20, homeW: 80, gridW: 0, acOutW: 80,
  soc: 50, pvTotalKwh: counter, chargeTotalKwh: counter / 2, dischargeTotalKwh: counter / 4,
  online: true, operatingMode: "custom",
} as Snapshot);
for (let minute = 0; minute < 4320; minute++) recordSample(sample(now - (4320 - minute) * 60_000, minute / 100));
const end = now - 6 * 3600_000;
const result = history("day", end);
assert.equal(result.window?.end, end);
assert.equal(result.window?.start, end - 86_400_000);
assert(result.points.every((point) => point.ts < end));
assert.equal(result.totals.pvKwh, 14.39);
assert((result.window?.coverage ?? 0) > 0.99);
assert((result.previous?.coverage ?? 0) > 0.99);
assert(result.daily && result.daily.length >= 1);
assert((history("month").window?.coverage ?? 1) < 0.11);
assert.equal(totalsSince(now / 1000).pvKwh, 0);
recordSample(sample(now, 1));
recordSample(sample(now + 60_000, 2));
assert.equal(totalsSince(now / 1000 - 60).pvKwh, 1);
recordStateEvent(sample(now, 1));
recordStateEvent({ ...sample(now, 1), online: false });
recordStateEvent({ ...sample(now, 1), online: false });
recordStateEvent({ ...sample(now, 1), operatingMode: "auto" });
await new Promise<void>((resolve) => setTimeout(resolve, 1100));
const events = history("day").events ?? [];
assert.equal(events.filter((event) => event.kind === "connection").length, 2);
assert.equal(events.filter((event) => event.kind === "mode").length, 1);
console.log("History checks passed: date bounds, daily totals, coverage, counter resets and deduplicated events. No hardware or persistent database used.");