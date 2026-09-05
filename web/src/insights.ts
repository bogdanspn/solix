import type { HistoryPoint, Snapshot } from "../../server/types.ts";
import type { WeatherReport } from "../../server/weather.ts";

const HOUR = 3600_000;
const median = (values: number[]) => {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

export function solarInsights(points: HistoryPoint[], report: WeatherReport, snapshot: Snapshot, capacity: number | null) {
  const now = snapshot.ts;
  const ratios: number[] = [];
  for (const hour of report.hours) {
    if (hour.ts > now || hour.ts < now - 24 * HOUR || hour.radiation < 100) continue;
    const matches = points.filter((point) => point.ts >= hour.ts - HOUR && point.ts < hour.ts && Number.isFinite(point.pvW));
    if (matches.length < 10 || matches.at(-1)!.ts - matches[0]!.ts < 45 * 60_000) continue;
    ratios.push(matches.reduce((sum, point) => sum + point.pvW, 0) / matches.length / hour.radiation);
  }
  const scale = median(ratios);
  const calibrated = ratios.length >= 3 && scale > 0 && Number.isFinite(scale);
  const spread = Math.max(0.35, Math.min(0.8, median(ratios.map((ratio) => Math.abs(ratio - scale))) / (scale || 1) * 2));
  const fresh = snapshot.online && snapshot.staleSeconds <= 20 && Math.abs(now - report.updatedAt) < 3 * HOUR;
  const future = report.hours.filter((hour) => hour.ts > now && hour.ts <= now + 24 * HOUR);
  const best = future.filter((hour) => hour.radiation >= 100).sort((first, second) => second.radiation - first.radiation)[0];
  const tomorrow = report.days[1];
  const tomorrowKwh = calibrated && fresh && tomorrow ? scale * tomorrow.solarKwhM2 : null;
  const sunset = new Date(report.days[0]?.sunset ?? "").getTime();
  const remaining = report.hours.reduce((sum, hour) => {
    const duration = Math.max(0, Math.min(hour.ts, sunset) - Math.max(hour.ts - HOUR, now)) / HOUR;
    return sum + duration * Math.max(0, hour.radiation) * scale / 1000;
  }, 0);
  const recent = points.filter((point) => point.ts >= now - HOUR && point.ts <= now);
  const demandW = median(recent.map((point) => Math.max(0, point.pvW - point.batteryW)));
  const floor = snapshot.settings.dischargeLimitSoc;
  const ceiling = snapshot.settings.chargingLimitSoc;
  const reserve = calibrated && fresh && capacity !== null && capacity > 0 && sunset > now && recent.length >= 10 && recent.at(-1)!.ts >= now - 10 * 60_000
    ? [1 - spread, 1 + spread].map((factor) => {
      const energy = capacity * snapshot.soc / 100 + remaining * factor * 0.9 - demandW / 1000 * (sunset - now) / HOUR;
      return Math.max(0, Math.min(capacity * Math.max(0, ceiling - floor) / 100, energy - capacity * floor / 100));
    }) : null;
  return { calibrated, matchedHours: ratios.length, spread, tomorrowKwh, reserve, demandW, best: fresh ? best : undefined };
}