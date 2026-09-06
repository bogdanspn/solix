import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnergyTotals, PlugReading, Snapshot } from "../server/types.ts";
import { TodaySummary } from "../web/src/TodaySummary.tsx";
import { Readings } from "../web/src/Readings.tsx";
import { SmartMeter } from "../web/src/SmartMeter.tsx";
import { Sockets } from "../web/src/Sockets.tsx";
import type { WeatherReport } from "../server/weather.ts";
import { solarInsights } from "../web/src/insights.ts";
import { Weather } from "../web/src/Weather.tsx";
import { Insights } from "../web/src/Insights.tsx";
import { hardwareFor, isPanelConfiguration, isPanelVoltages, pvInputStatus, seriesPanelEstimate } from "../web/src/hardware.ts";
import { Strings } from "../web/src/Strings.tsx";

assert.equal(hardwareFor("AE103")?.solarW, 5000);
assert.equal(hardwareFor("A17C1"), null);
assert.equal(hardwareFor(), null);
const measuredString = { index: 1, volts: 60, amps: 10, watts: 600, derived: false };
assert.equal(seriesPanelEstimate(measuredString, 30, true), 2);
assert.equal(seriesPanelEstimate(measuredString, 30, false), null);
assert.equal(seriesPanelEstimate({ ...measuredString, derived: true }, 30, true), null);
assert.equal(seriesPanelEstimate(measuredString, 0, true), null);
assert.equal(seriesPanelEstimate({ ...measuredString, amps: 0.1 }, 30, true), null);
assert.equal(seriesPanelEstimate({ ...measuredString, volts: 45 }, 30, true), null);
assert.equal(seriesPanelEstimate({ ...measuredString, volts: 34.4 }, 10, true), null);
assert.equal(seriesPanelEstimate({ ...measuredString, volts: NaN }, 30, true), null);
assert.equal(seriesPanelEstimate(measuredString, Infinity, true), null);
assert.equal(seriesPanelEstimate({ ...measuredString, watts: 0 }, 30, true), null);
assert.equal(pvInputStatus(measuredString, "AE103", true), "At or above maximum PV voltage");
assert.equal(pvInputStatus({ ...measuredString, volts: 30, amps: 37 }, "AE103", true), "Above MPPT current rating");
assert.equal(pvInputStatus({ ...measuredString, volts: 30 }, "AE103", true), "Within operating range");
assert.equal(pvInputStatus(measuredString, "AE103", false), "Last reading");
assert.equal(pvInputStatus({ ...measuredString, volts: 51 }, "AE103", true), "Outside MPPT operating range");
assert.equal(pvInputStatus({ ...measuredString, volts: 15 }, "AE103", true), "Outside MPPT operating range");
assert.equal(pvInputStatus({ ...measuredString, volts: 30, amps: 36 }, "AE103", true), "Within operating range");
assert.equal(pvInputStatus({ ...measuredString, derived: true }, "AE103", true), "Power inferred; voltage/current unavailable");
assert.equal(pvInputStatus(measuredString, "unknown", true), "Limits not verified for this model");
assert.equal(isPanelVoltages({ 1: 30 }), true);
assert.equal(isPanelVoltages({ 1: -30 }), false);
assert.equal(isPanelVoltages([]), false);
assert.equal(isPanelVoltages({ 1: null }), false);
assert.equal(isPanelConfiguration({ enabled: true, panelsPerInput: 2, panelW: 500, bifacial: true }), true);
assert.equal(isPanelConfiguration({ enabled: true, panelsPerInput: 0, panelW: 500, bifacial: true }), false);
assert.equal(isPanelConfiguration({ enabled: true, panelsPerInput: 2, panelW: NaN, bifacial: true }), false);
assert.equal(isPanelConfiguration({ enabled: true, panelsPerInput: 1.5, panelW: 500, bifacial: true }), false);
const pvDetails = renderToStaticMarkup(<Strings strings={[measuredString, { ...measuredString, index: 4, derived: true }]} model="AE103" fresh />);
assert.match(pvDetails, /60 V DC/);
assert.match(pvDetails, /Series count unknown/);
assert.match(pvDetails, /Parallel count unknown/);
assert.doesNotMatch(pvDetails, /PV4 panel Vmp/);
assert.doesNotMatch(renderToStaticMarkup(<Strings strings={[]} model="unknown" />), /60 V DC|5,000 W/);
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
try {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "solix-panel-configuration-confirmed-device"
      ? JSON.stringify({ enabled: true, panelsPerInput: 2, panelW: 500, bifacial: true }) : null,
  } });
  const configuredInputs = Array.from({ length: 4 }, (_, index) => ({ ...measuredString, index: index + 1, derived: index === 3 }));
  const configuredMarkup = renderToStaticMarkup(<Strings strings={configuredInputs} model="AE103" deviceKey="confirmed-device" fresh />);
  assert.match(configuredMarkup, /8 panels/);
  assert.match(configuredMarkup, /4\.0 kWp nameplate/);
  assert.equal((configuredMarkup.match(/2 × 500 W bifacial/g) ?? []).length, 4);
  assert.match(configuredMarkup, /user-provided, not detected/);
  assert.match(configuredMarkup, /PV4 power is inferred/);
  assert.doesNotMatch(configuredMarkup, /Series count unknown|PV1 panel Vmp/);
  assert.doesNotMatch(renderToStaticMarkup(<Strings strings={configuredInputs} model="AE103" deviceKey="other-device" fresh />), /8 panels|2 × 500 W bifacial/);
} finally {
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
}

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
const meter = (overrides: Partial<Snapshot> = {}, connected = true) => renderToStaticMarkup(
  <SmartMeter snapshot={{ ...snapshot, ...overrides }} connected={connected} />,
);
const absentMeter = meter({ gridW: 9876, homeSource: "meter", homeW: 1234 });
assert.match(absentMeter, /is-unavailable/);
assert.match(absentMeter, /No Smart Meter detected/);
assert.equal((absentMeter.match(/<strong>--<\/strong>/g) ?? []).length, 5);
assert.doesNotMatch(absentMeter, /Preview|Sample|<button|9\.88 kW|1\.23 kW|0 W|is-active|Balanced/);
assert.match(absentMeter, /class="meter-route-track"><\/span>/);
const measuredImport = meter({ gridMeasured: true, gridW: 425, homeSource: "meter", homeW: 1100 });
assert.match(measuredImport, /425 W/);
assert.match(measuredImport, /1\.10 kW/);
assert.match(measuredImport, /Imported today<\/span><strong>--/);
assert.doesNotMatch(measuredImport, /Sample|Preview|6\.80 kWh|860 W/);
const measuredExport = meter({ gridMeasured: true, gridW: -1240 });
assert.match(measuredExport, /smart-meter meter-export/);
assert.match(measuredExport, /1\.24 kW/);
assert.match(measuredExport, /Whole-home load<\/span><strong>--/);
assert.match(meter({ gridMeasured: true, gridW: 0 }), /smart-meter meter-balanced/);
assert.match(meter({ gridMeasured: true, staleSeconds: 21 }), /Last measured readings/);
assert.match(meter({ gridMeasured: true }, false), /Last measured readings/);
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
const forecastDay = new Date(2026, 8, 6).getTime();
const todayForecast = {
  ...forecast,
  days: [0, 1].map((offset) => ({
    ...forecast.days[0]!,
    date: new Date(forecastDay + offset * 24 * hour).toLocaleDateString("sv"),
    sunrise: new Date(forecastDay + (offset * 24 + 6) * hour).toISOString(),
    sunset: new Date(forecastDay + (offset * 24 + 18) * hour).toISOString(),
  })),
  hours: Array.from({ length: 48 }, (_, index) => ({ ...forecast.hours[0]!, ts: forecastDay + index * hour })),
};
const realNow = Date.now;
const forecastAt = (hoursAfterMidnight: number) => {
  Date.now = () => forecastDay + hoursAfterMidnight * hour;
  try {
    return renderToStaticMarkup(<Weather report={todayForecast} needsLocation={false} error={null} adopt={() => {}} />);
  } finally {
    Date.now = realNow;
  }
};
const middayForecast = forecastAt(12);
assert.equal((middayForecast.match(/day-featured/g) ?? []).length, 1);
assert.equal((middayForecast.match(/class="day-sun-times"/g) ?? []).length, 1);
assert.match(middayForecast, /Sunrise<\/span><strong>/);
assert.match(middayForecast, /Sunset<\/span><strong>/);
assert.match(middayForecast, /Tomorrow/);
assert.match(middayForecast, /class="day-time-axis"/);
assert.match(middayForecast, /class="day-profile-elapsed" clip-path="url\(#[^"]+-elapsed\)"/);
assert.equal((middayForecast.match(/class="day-profile-remaining"/g) ?? []).length, 1);
assert.equal((middayForecast.match(/class="day-profile-now"/g) ?? []).length, 1);
assert.match(middayForecast, /6h 00m left/);
const markerX = Number(middayForecast.match(/class="day-profile-now"><line x1="([\d.]+)"/)?.[1]);
assert(Math.abs(markerX - 12 / 23 * 100) < 0.01);
assert.match(forecastAt(5), /Sunrise /);
assert.match(forecastAt(18), /Sunset passed/);
assert.match(forecastAt(17.5), /0h 30m left/);
console.log("Dashboard checks passed: reserve, missing data, ETA consistency, totals, socket sorting, tariff scope, forecast calibration, current-time marker and daylight remaining.");