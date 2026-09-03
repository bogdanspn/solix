import { useEffect, useState } from "react";
import type { Place, WeatherReport } from "../../server/weather.ts";
import { IconCloud, IconDrop, IconPin, IconSun } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";

/**
 * Weather, framed around the decision it informs: how hard to lean on the
 * battery tonight.
 *
 * The bars are solar irradiance (kWh/m²), not a sunshine icon - irradiance is
 * what actually predicts PV yield, since it already folds in sun angle, day
 * length and haze.
 */

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

export function Weather({ report, needsLocation, error, adopt }: WeatherState) {
  const [picking, setPicking] = useState(false);

  const peak = report ? Math.max(...report.days.map((d) => d.solarKwhM2), 0.1) : 1;

  // The header and the body both stay mounted whatever the state, so setting or
  // changing a location never resizes the card underneath the dialog.
  return (
    <>
      <div className="chart-head">
        <h2 className="eyebrow" style={{ margin: 0 }}>
          Forecast{report && ` · ${report.place.name}`}
        </h2>
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
            {report.days.map((d, i) => (
              <div className={`day ${i === 0 ? "is-today" : ""}`} key={d.date}>
                <div className="day-name">{dayName(d.date, i)}</div>
                <div className="day-bar-track">
                  <div
                    className="day-bar"
                    style={{ height: `${Math.max(4, (d.solarKwhM2 / peak) * 100)}%` }}
                    title={`${d.solarKwhM2} kWh/m²`}
                  />
                </div>
                <div className="day-sun">{d.solarKwhM2.toFixed(1)}</div>
                <div className="day-temp">
                  {Math.round(d.tempMax)}° <span className="muted">{Math.round(d.tempMin)}°</span>
                </div>
                <div className={`day-rain ${d.precipPct >= 40 ? "wet" : ""}`}>
                  <IconDrop size={11} /> {d.precipPct}%
                </div>
              </div>
            ))}
          </div>

          <div className="advice">
            <span className="advice-ico">
              {report.days[1] && report.days[1].solarKwhM2 >= 3 ? <IconSun size={16} /> : <IconCloud size={16} />}
            </span>
            <p>{report.advice}</p>
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
