/**
 * Weather and solar-yield forecast, from Open-Meteo.
 *
 * Open-Meteo is free, needs no API key, and - unusually - publishes
 * `shortwave_radiation`, the actual irradiance hitting the ground in W/m².
 * That is what predicts PV output, far better than a cloud-cover percentage:
 * it already accounts for sun angle, day length and haze.
 *
 * This is the one part of the dashboard that leaves the LAN. Nothing about the
 * system is sent - only a postcode or coordinates, to a public forecast API.
 */
import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = path.resolve(import.meta.dirname, "..", "data", "location.json");

export interface Place {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
  postcode?: string;
}

/**
 * WMO weather interpretation code, as published by Open-Meteo.
 *
 * Preferred over inferring a condition from cloud percentage: 90% cloud could
 * be dry overcast or a downpour, and only the code distinguishes them.
 *   0 clear · 1-3 mainly clear to overcast · 45,48 fog
 *   51-57 drizzle · 61-67 rain · 71-77 snow
 *   80-82 rain showers · 85,86 snow showers · 95-99 thunderstorm
 */
export type WeatherCode = number;

export interface HourPoint {
  ts: number;
  tempC: number;
  cloudPct: number;
  /** Global horizontal irradiance, W/m². The PV predictor. */
  radiation: number;
  precipPct: number;
  isDay: boolean;
  code: WeatherCode;
}

export interface DayForecast {
  date: string;
  tempMin: number;
  tempMax: number;
  /** Total irradiance over the day, kWh/m² - proportional to expected yield. */
  solarKwhM2: number;
  precipPct: number;
  sunrise: string;
  sunset: string;
  /** Where this day sits against the others in the window: 0..1. */
  yieldScore: number;
}

export interface WeatherReport {
  place: Place;
  updatedAt: number;
  now: { tempC: number; cloudPct: number; radiation: number; isDay: boolean; code: WeatherCode };
  hours: HourPoint[];
  days: DayForecast[];
  /** Plain-language guidance derived from tomorrow vs today. */
  advice: string;
}

export function loadPlace(): Place | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Place;
  } catch {
    return null;
  }
}

export function savePlace(place: Place): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(place, null, 2));
  cache = null;
}

/**
 * Resolve a postcode or a place name to coordinates.
 *
 * Open-Meteo's geocoder indexes place names, not postcodes -- "12345" returns
 * nothing there -- so postcodes go to Zippopotam, which is built for exactly
 * that and needs no key either.
 */
export async function geocode(query: string, country = "DE"): Promise<Place[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const isPostcode = /^\d{4,5}$/.test(trimmed);
  if (isPostcode) {
    const byPostcode = await geocodePostcode(trimmed, country);
    if (byPostcode.length > 0) return byPostcode;
    // Fall through: some numeric queries really are place names.
  }

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", trimmed);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Geocoding failed: HTTP ${res.status}`);

  const body = (await res.json()) as {
    results?: Array<{
      name: string;
      country_code?: string;
      country?: string;
      latitude: number;
      longitude: number;
      postcodes?: string[];
    }>;
  };

  return (body.results ?? []).map((r) => ({
    name: r.name,
    country: r.country ?? r.country_code ?? "",
    latitude: r.latitude,
    longitude: r.longitude,
    postcode: isPostcode ? trimmed : r.postcodes?.[0],
  }));
}

async function geocodePostcode(postcode: string, country: string): Promise<Place[]> {
  try {
    const res = await fetch(`https://api.zippopotam.us/${country.toLowerCase()}/${postcode}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const b = (await res.json()) as {
      country?: string;
      places?: Array<{ "place name": string; latitude: string; longitude: string; state?: string }>;
    };
    return (b.places ?? []).map((pl) => ({
      name: pl.state ? `${pl["place name"]}, ${pl.state}` : pl["place name"],
      country: b.country ?? country,
      latitude: Number(pl.latitude),
      longitude: Number(pl.longitude),
      postcode,
    }));
  } catch {
    return [];
  }
}

let cache: { at: number; report: WeatherReport } | null = null;
const CACHE_MS = 15 * 60 * 1000;

/** The last fetched report, without triggering a request. */
export function cachedWeather(): WeatherReport | null {
  return cache?.report ?? null;
}

export async function getWeather(force = false): Promise<WeatherReport | null> {
  const place = loadPlace();
  if (!place) return null;
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.report;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set(
    "hourly",
    "temperature_2m,cloud_cover,shortwave_radiation,precipitation_probability,is_day,weather_code",
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_min,temperature_2m_max,shortwave_radiation_sum,precipitation_probability_max,sunrise,sunset",
  );
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("timezone", "auto");

  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Forecast failed: HTTP ${res.status}`);

  const b = (await res.json()) as {
    hourly: {
      time: string[];
      temperature_2m: number[];
      cloud_cover: number[];
      shortwave_radiation: number[];
      precipitation_probability: (number | null)[];
      is_day: number[];
      weather_code: number[];
    };
    daily: {
      time: string[];
      temperature_2m_min: number[];
      temperature_2m_max: number[];
      shortwave_radiation_sum: number[];
      precipitation_probability_max: (number | null)[];
      sunrise: string[];
      sunset: string[];
    };
  };

  const hours: HourPoint[] = b.hourly.time.map((t, i) => ({
    ts: new Date(t).getTime(),
    tempC: b.hourly.temperature_2m[i] ?? 0,
    cloudPct: b.hourly.cloud_cover[i] ?? 0,
    radiation: b.hourly.shortwave_radiation[i] ?? 0,
    precipPct: b.hourly.precipitation_probability[i] ?? 0,
    isDay: (b.hourly.is_day[i] ?? 0) === 1,
    code: b.hourly.weather_code[i] ?? 0,
  }));

  const sums = b.daily.shortwave_radiation_sum.map((v) => v ?? 0);
  const best = Math.max(...sums, 0.001);

  const days: DayForecast[] = b.daily.time.map((d, i) => ({
    date: d,
    tempMin: b.daily.temperature_2m_min[i] ?? 0,
    tempMax: b.daily.temperature_2m_max[i] ?? 0,
    // Open-Meteo reports the daily sum in MJ/m²; 3.6 MJ = 1 kWh.
    solarKwhM2: Math.round(((sums[i] ?? 0) / 3.6) * 100) / 100,
    precipPct: b.daily.precipitation_probability_max[i] ?? 0,
    sunrise: b.daily.sunrise[i] ?? "",
    sunset: b.daily.sunset[i] ?? "",
    yieldScore: Math.round(((sums[i] ?? 0) / best) * 100) / 100,
  }));

  // Nearest hour to now, for the "currently" reading.
  const now = Date.now();
  const current = hours.reduce(
    (best, h) => (Math.abs(h.ts - now) < Math.abs(best.ts - now) ? h : best),
    hours[0] ?? { ts: now, tempC: 0, cloudPct: 0, radiation: 0, precipPct: 0, isDay: false, code: 0 },
  );

  const report: WeatherReport = {
    place,
    updatedAt: Date.now(),
    now: {
      tempC: current.tempC,
      cloudPct: current.cloudPct,
      radiation: current.radiation,
      isDay: current.isDay,
      code: current.code,
    },
    hours,
    days,
    advice: adviceFor(days),
  };

  cache = { at: Date.now(), report };
  return report;
}

/**
 * Turn the forecast into the decision the user actually cares about: how hard
 * to lean on the battery tonight.
 *
 * If tomorrow will be sunny the battery can be run down further overnight,
 * because it will refill. If tomorrow is dull, holding charge back is worth
 * more than the cheap overnight discharge.
 */
function adviceFor(days: DayForecast[]): string {
  const today = days[0];
  const tomorrow = days[1];
  if (!today || !tomorrow) return "Not enough forecast data yet.";

  const t = tomorrow.solarKwhM2;
  const ratio = today.solarKwhM2 > 0.05 ? t / today.solarKwhM2 : 1;

  if (t >= 4)
    return `Strong sun tomorrow (${t.toFixed(1)} kWh/m²). The battery will refill easily, so a lower discharge limit tonight costs you nothing.`;
  if (t >= 2.5)
    return `Decent sun tomorrow (${t.toFixed(1)} kWh/m²). A moderate overnight discharge should recover by afternoon.`;
  if (t >= 1.2)
    return `Modest sun tomorrow (${t.toFixed(1)} kWh/m²)${ratio < 0.7 ? ", weaker than today" : ""}. Keep some reserve, because recharging will be slow.`;
  return `Very little sun tomorrow (${t.toFixed(1)} kWh/m²). Hold charge back: raise the discharge limit and expect to draw from the grid.`;
}
