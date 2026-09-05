import { useEffect, useState } from "react";
import type { DayForecast, HourPoint, Place, WeatherReport } from "../../server/weather.ts";
import { IconDrop, IconPin, IconSun } from "./Icons.tsx";
import { weatherLook } from "./WeatherIcon.tsx";
import { Modal } from "./Modal.tsx";

/**
 * Weather, framed around the decision it informs: how hard to lean on the
 * battery tonight.
 *
 * The bars are solar irradiance (kWh/m²), not a sunshine icon - irradiance is
 * what actually predicts PV yield, since it already folds in sun angle, day
 * length and haze.
 */

/**
 * The condition to show against a day, picked from its daylight hours.
 *
 * DayForecast carries no weather code, only the aggregates, so it comes from
 * the hourly series. The most frequent daylight code rather than the worst:
 * one thunderstorm hour in a bright day is not what the day looks like, and
 * the precipitation figure already carries the warning.
 */
function dayCode(hours: HourPoint[]): number | null {
  const tally = new Map<number, number>();
  for (const h of hours) {
    if (!h.isDay) continue;
    tally.set(h.code, (tally.get(h.code) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [code, n] of tally) {
    // Ties go to the higher code, which is the more significant weather.
    if (n > bestN || (n === bestN && best !== null && code > best)) {
      best = code;
      bestN = n;
    }
  }
  return best;
}

/**
 * The day's irradiance hour by hour, as a filled curve.
 *
 * A single bar per day answers "how much" and leaves a wide cell mostly
 * empty. The shape answers "when", which is the question that actually
 * changes what you do: a morning-weighted day and an afternoon-weighted one
 * can carry the same kWh and want opposite plans for running the washing.
 *
 * Scaled against the peak across the whole window, not each day's own, so the
 * seven curves are comparable at a glance.
 */
function DayProfile({ hours, peak }: { hours: HourPoint[]; peak: number }) {
  const W = 100;
  const H = 40;
  if (hours.length < 2) return <svg className="day-profile" viewBox={`0 0 ${W} ${H}`} />;

  const x = (i: number) => (i / (hours.length - 1)) * W;
  const y = (r: number) => H - Math.min(r / peak, 1) * (H - 2);
  const line = hours.map((h, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(h.radiation).toFixed(2)}`).join(" ");

  return (
    <svg className="day-profile" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${line} L ${W} ${H} L 0 ${H} Z`} className="day-profile-fill" />
      <path d={line} className="day-profile-line" />
    </svg>
  );
}

/** Local clock for an hourly sample, e.g. the peak-irradiance hour. */
function clockOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Hours of daylight, from the day's own sunrise and sunset. */
function daylight(d: DayForecast): string {
  const rise = new Date(d.sunrise).getTime();
  const set = new Date(d.sunset).getTime();
  if (!Number.isFinite(rise) || !Number.isFinite(set) || set <= rise) return "";
  const mins = Math.round((set - rise) / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function dayName(date: string, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tom";
  return new Date(date).toLocaleDateString([], { weekday: "short" });
}

function LocationPicker({ onPicked }: { onPicked: (report: WeatherReport) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/weather/search?q=${encodeURIComponent(query)}`);
      const body = (await res.json()) as { results?: Place[]; error?: string };
      if (body.error) setError(body.error);
      else if (!body.results?.length) setError("Nothing found for that postcode or place.");
      else setResults(body.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (place: Place) => {
    setBusy(true);
    try {
      const res = await fetch("/api/weather/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(place),
      });
      onPicked((await res.json()) as WeatherReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="picker">
      <p className="picker-hint">
        Set a location to forecast solar yield. A postcode is enough. Nothing about your system is
        sent, only the location.
      </p>
      <div className="picker-row">
        <input
          value={query}
          placeholder="Postcode or town"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button className="btn" onClick={search} disabled={busy}>
          {busy ? "…" : "Search"}
        </button>
      </div>
      {error && <div className="msg err">{error}</div>}
      {results?.map((r) => (
        <button key={`${r.latitude},${r.longitude}`} className="picker-result" onClick={() => choose(r)}>
          <span>{r.name}</span>
          <span className="muted">
            {r.country} · {r.latitude.toFixed(2)}, {r.longitude.toFixed(2)}
          </span>
        </button>
      ))}
    </div>
  );
}

export interface WeatherState {
  report: WeatherReport | null;
  needsLocation: boolean;
  error: string | null;
  adopt: (r: WeatherReport) => void;
}

export function useWeather(): WeatherState {
  const [report, setReport] = useState<WeatherReport | null>(null);
  const [needsLocation, setNeedsLocation] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/weather")
        .then(async (r) => {
          if (r.status === 404) {
            if (!cancelled) setNeedsLocation(true);
            return null;
          }
          return (await r.json()) as WeatherReport & { error?: string };
        })
        .then((d) => {
          if (cancelled || !d) return;
          if (d.error) setError(d.error);
          else {
            setReport(d);
            setNeedsLocation(false);
          }
        })
        .catch((e) => !cancelled && setError(String(e)));

    load();
    // The forecast is cached server-side for 15 minutes; refresh hourly.
    const id = setInterval(load, 3600_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return {
    report,
    needsLocation,
    error,
    adopt: (r: WeatherReport) => {
      setReport(r);
      setNeedsLocation(false);
    },
  };
}

export function Weather({
  report,
  needsLocation,
  error,
  adopt,
}: WeatherState) {
  const [picking, setPicking] = useState(false);

  const peak = report ? Math.max(...report.days.map((d) => d.solarKwhM2), 0.1) : 1;
  // Bucketed once here rather than filtered per day inside the map, which
  // would walk all 168 hours seven times over on every render.
  const byDate = new Map<string, HourPoint[]>();
  for (const h of report?.hours ?? []) {
    const key = new Date(h.ts).toLocaleDateString("sv");
    const list = byDate.get(key);
    if (list) list.push(h);
    else byDate.set(key, [h]);
  }
  const peakRadiation = Math.max(...(report?.hours ?? []).map((h) => h.radiation), 100);

  // The header and the body both stay mounted whatever the state, so setting or
  // changing a location never resizes the card underneath the dialog.
  return (
    <>
      <div className="chart-head">
        <div className="card-title"><IconSun size={17} /><h2>
          Forecast{report && ` · ${report.place.name}`}
        </h2></div>
        <div className="head-actions">
          {report && (
            <span className="sub-total">
              {report.now.tempC.toFixed(0)}°C · {report.now.cloudPct}% cloud
              {report.now.isDay && ` · ${Math.round(report.now.radiation)} W/m²`}
            </span>
          )}
          <button
            className="icon-btn wide"
            onClick={() => setPicking(true)}
            title={report ? "Change location" : "Set a location"}
          >
            <IconPin size={14} />
            {report ? "Change" : "Set location"}
          </button>
        </div>
      </div>

      {error && (
        <div className="msg err" style={{ marginTop: 0, marginBottom: 14 }}>
          Could not reach the forecast service. {error}
        </div>
      )}

      {!report ? (
        <div className="empty">
          {needsLocation
            ? "No location set yet. Add one to forecast solar yield for the days ahead."
            : error
              ? "No forecast to show."
              : "Loading forecast…"}
        </div>
      ) : (
        <>
          <div className="days">
            {report.days.map((d, i) => {
              const hours = byDate.get(d.date) ?? [];
                const code = dayCode(hours);
                const look = code === null ? null : weatherLook(code, true);
                const best = hours.reduce(
                  (acc, h) => (h.radiation > acc.radiation ? h : acc),
                  hours[0] ?? { radiation: 0, ts: 0 },
                );
                return (
                  <div className={`day ${i === 0 ? "is-today" : ""}`} key={d.date}>
                    <div className="day-head">
                      <span className="day-name">{dayName(d.date, i)}</span>
                      {look && (
                        <span className="day-ico" style={{ color: look.tone }} title={look.label}>
                          <look.Icon size={16} />
                        </span>
                      )}
                    </div>

                    <div
                      className="day-chart"
                      style={{ opacity: 0.35 + (d.solarKwhM2 / peak) * 0.65 }}
                      title={`${d.solarKwhM2} kWh/m² over the day`}
                    >
                      <DayProfile hours={hours} peak={peakRadiation} />
                    </div>

                    <div className="day-figs">
                      <span className="day-sun">
                        {d.solarKwhM2.toFixed(1)}
                        <em>kWh/m²</em>
                      </span>
                      {best.radiation > 0 && (
                        <span className="day-peak" title="Strongest hour of the day">
                          {Math.round(best.radiation)} W/m² at {clockOf(best.ts)}
                        </span>
                      )}
                    </div>

                    <div className="day-meta">
                      <span className="day-temp">
                        {Math.round(d.tempMax)}° <span className="muted">{Math.round(d.tempMin)}°</span>
                      </span>
                      <span className={`day-rain ${d.precipPct >= 40 ? "wet" : ""}`}>
                        <IconDrop size={10} /> {d.precipPct}%
                      </span>
                      <span className="day-light" title="Sunrise to sunset">
                        {daylight(d)}
                      </span>
                    </div>
                  </div>
              );
            })}
          </div>

        </>
      )}

      <Modal open={picking} title="Forecast location" onClose={() => setPicking(false)}>
        <LocationPicker
          onPicked={(r) => {
            adopt(r);
            setPicking(false);
          }}
        />
      </Modal>
    </>
  );
}
