import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnergyTotals, PlugReading, Snapshot } from "../server/types.ts";
import { TodaySummary } from "../web/src/TodaySummary.tsx";
import { Readings } from "../web/src/Readings.tsx";
import { Sockets } from "../web/src/Sockets.tsx";
import type { WeatherReport } from "../server/weather.ts";
import { solarInsights } from "../web/src/insights.ts";
import { Weather } from "../web/src/Weather.tsx";
import { Insights } from "../web/src/Insights.tsx";

const totals: EnergyTotals = { pvKwh: 4, chargeKwh: 2, dischargeKwh: 1 };
const plug: PlugReading = {
  host: "192.0.2.1", serial: "test", model: "test", firmware: "test", name: "Desk",
  on: true, watts: 100, volts: 230, amps: 0.43, tempC: 30, online: true,
  todayKwh: 1, weekKwh: 2, monthKwh: 3,
};
const snapshot: Snapshot = {
  ts: Date.now(), online: true, staleSeconds: 0, soc: 50, batteryStatus: "Charging",
  batteryW: 500, pvW: 600, thirdPartyPvW: 0, loadW: 100, gridW: 0, acOutW: 100,
  gridImportLimitW: 1200, gridExportLimitW: 800, setpointW: 100, operatingMode: "custom",
  gridHz: 50, acVolts: 230, batteryTempC: 25, batteryHealth: 100, strings: [],
  eta: { direction: "charge", minutes: 120, targetSoc: 100, basisW: 500, beforeSunset: false },
  pvTotalKwh: 100, chargeTotalKwh: 50, dischargeTotalKwh: 40,
  settings: { chargingLimitSoc: 100, dischargeLimitSoc: 10, backupReserveSoc: 10, backupSocEnable: false, operatingMode: "custom" },
  plugs: [plug], homeW: 100, homeSource: "sockets", gridMeasured: false, unmeteredW: 0,
};
const summary = (overrides: Partial<Snapshot> = {}, capacity: number | null = 15) =>
  renderToStaticMarkup(<TodaySummary snapshot={{ ...snapshot, ...overrides }} today={totals} ratedKwh={capacity} />);
assert.match(summary(), /6\.00 kWh/);
assert.match(summary({ soc: 5 }), /0 Wh/);
assert.match(summary({ soc: 110 }), /13\.5 kWh/);
assert.match(summary({}, null), /Capacity unavailable/);
assert.match(summary({ plugs: [] }), /No sockets connected/);
assert.match(summary(), /Largest: Desk/);

const battery = (overrides: Partial<Snapshot> = {}) => renderToStaticMarkup(
  <Readings snapshot={{ ...snapshot, ...overrides }} today={totals} device={{ ratedKwh: 15, packs: 3 }} />,
);
assert.match(battery(), /100% in about 2h/);
assert.match(battery(), /At this rate, after sunset/);
assert.match(battery({ batteryW: -500 }), /No reliable time estimate/);
assert.doesNotMatch(battery({ batteryW: -500 }), /100% in about|At this rate/);
assert.match(battery({ staleSeconds: 21 }), /Waiting for current readings/);
assert.match(battery({ online: false }), /Last reading/);
assert.doesNotMatch(battery(), /Where today|Not stored|from the mains/);
assert.match(battery(), /Charged today/);
assert.match(battery(), /Discharged today/);
assert.match(battery(), /battery-power-readings/);
assert.doesNotMatch(battery(), /Power readings|Battery charging|Battery discharging/);
assert.doesNotMatch(battery({ batteryW: -500 }), /Battery discharging/);
assert.match(battery(), /Solarbank AC output/);
assert.match(battery(), /Net AC output/);
assert.match(battery({ gridMeasured: true, gridW: -250 }), /Grid export/);
assert.doesNotMatch(battery(), /Frequency|Voltage|Electrical &amp; device/);

const sockets = renderToStaticMarkup(<Sockets plugs={[
  plug, { ...plug, serial: "offline", name: "Offline device", online: false, watts: 9876, todayKwh: 3 },
]} onRenamed={() => {}} />);
assert(sockets.indexOf("Offline device") < sockets.indexOf(">Desk<"));
assert.match(sockets, /75 percent of socket energy today/);
assert.doesNotMatch(sockets, /9\.88 kW/);
assert.match(sockets, /100 W/);
assert.match(renderToStaticMarkup(<Sockets plugs={[]} onRenamed={() => {}} />), /No sockets connected yet/);
const hour = 3600_000;
const current = Math.floor(snapshot.ts / hour) * hour;
const forecast: WeatherReport = {
  place: { name: "Test", country: "DE", latitude: 50, longitude: 12 }, updatedAt: current,
  now: { tempC: 20, cloudPct: 10, radiation: 500, isDay: true, code: 0 }, advice: "",
  hours: Array.from({ length: 12 }, (_, index) => ({ ts: current + (index - 5) * hour, tempC: 20, cloudPct: 10, radiation: 500, precipPct: 0, isDay: true, code: 0 })),
  days: [0, 1].map((offset) => ({ date: "2026-09-03", tempMin: 10, tempMax: 20, solarKwhM2: 4, precipPct: 0, sunrise: new Date(current - 6 * hour).toISOString(), sunset: new Date(current + (6 + offset * 24) * hour).toISOString(), yieldScore: 1 })),
};
const recorded = Array.from({ length: 72 }, (_, index) => ({ ts: current - 6 * hour + index * 300_000, pvW: 1000, batteryW: 500, loadW: 500, gridW: 0, soc: 50 }));
const evaluate = (overrides: Partial<Snapshot> = {}, capacity: number | null = 15) => solarInsights(recorded, forecast, { ...snapshot, ts: current, ...overrides }, capacity);
assert.equal(evaluate().tomorrowKwh, 8);
assert.equal(evaluate().matchedHours, 6);
assert(evaluate().reserve?.every((value) => value >= 0 && value <= 13.5));
assert.equal(evaluate({ online: false }).tomorrowKwh, null);
assert.equal(evaluate({ staleSeconds: 21 }).reserve, null);
assert.equal(evaluate({}, null).reserve, null);
assert.equal(solarInsights(recorded.slice(0, 12), forecast, snapshot, 15).tomorrowKwh, null);
assert.equal(solarInsights(recorded, { ...forecast, updatedAt: current - 4 * hour }, snapshot, 15).tomorrowKwh, null);
assert.equal(solarInsights([], forecast, snapshot, 15).reserve, null);
assert.match(sockets, /aria-haspopup="dialog">Energy cost estimate/);
assert.match(sockets, /aria-label="Details for Desk"/);
assert.doesNotMatch(sockets, /<details|socket-detail-body/);
const forecastMarkup = renderToStaticMarkup(<>
  <Weather report={{ ...forecast, advice: "Legacy duplicate advice" }} needsLocation={false} error={null} adopt={() => {}} />
  <Insights snapshot={snapshot} report={forecast} ratedKwh={15} onReviewSettings={() => {}} />
</>);
assert.equal((forecastMarkup.match(/Review limits/g) ?? []).length, 1);
assert.doesNotMatch(forecastMarkup, /forecast-verdict|Legacy duplicate advice/);
assert(forecastMarkup.indexOf('class="days"') < forecastMarkup.indexOf('class="forecast-insights"'));
console.log("Dashboard checks passed: reserve, missing data, ETA consistency, totals, socket sorting, tariff scope and forecast calibration gates.");