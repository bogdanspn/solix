import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { DeviceInfo, EnergyTotals, Snapshot } from "../../server/types.ts";
import { PowerFlow } from "./PowerFlow.tsx";
import { Readings } from "./Readings.tsx";
import { HistoryCharts } from "./HistoryCharts.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { Sockets } from "./Sockets.tsx";
import { Strings } from "./Strings.tsx";
import { Weather, useWeather } from "./Weather.tsx";
import { mainsInputW } from "./derive.ts";
import { formatClock, formatDuration, formatW } from "./format.ts";
import { IconBolt, IconMoon, IconSettings, IconSun } from "./Icons.tsx";
import { weatherLook } from "./WeatherIcon.tsx";

const HouseScene = lazy(() =>
  import("./HouseScene.tsx").then((module) => ({ default: module.HouseScene })),
);

type LiveSnapshot = Snapshot & { today: EnergyTotals };

interface DeviceResponse {
  device: DeviceInfo;
  modes: Array<{ value: string; label: string }>;
  /** Highest PV ever recorded, used to scale the scene against a real peak. */
  peakPvW: number;
}

function ConfidenceBand({ snapshot }: { snapshot: Snapshot }) {
  const home =
    snapshot.homeSource === "meter"
      ? { label: "Household demand", value: "Smart Meter", detail: "Direct measurement", tone: "good" }
      : snapshot.homeSource === "sockets"
        ? {
            label: "Household demand",
            value: "Socket estimate",
            detail: snapshot.unmeteredW > 0 ? `${formatW(snapshot.unmeteredW)} not covered` : "Covered by sockets",
            tone: "warn",
          }
        : { label: "Household demand", value: "Not measured", detail: "Add a meter or sockets", tone: "critical" };
  const grid = snapshot.gridMeasured
    ? { value: "Grid measured", detail: "Import and export are live", tone: "good" }
    : { value: "AC output only", detail: "Grid flow needs a Smart Meter", tone: "warn" };
  const freshness = snapshot.online && snapshot.staleSeconds <= 20
    ? { value: "Live", detail: "Reading every 5 seconds", tone: "good" }
    : { value: "Last known reading", detail: `${snapshot.staleSeconds}s old`, tone: "critical" };

  return (
    <section className="confidence-band" aria-label="Measurement confidence">
      <div className="confidence-intro">
        <span className="eyebrow">System confidence</span>
        <p>Know what each number represents.</p>
      </div>
      <div className={`confidence-item is-${home.tone}`}>
        <span className="confidence-label">{home.label}</span>
        <strong>{home.value}</strong>
        <small>{home.detail}</small>
      </div>
      <div className={`confidence-item is-${grid.tone}`}>
        <span className="confidence-label">Grid flow</span>
        <strong>{grid.value}</strong>
        <small>{grid.detail}</small>
      </div>
      <div className={`confidence-item is-${freshness.tone}`}>
        <span className="confidence-label">Data freshness</span>
        <strong>{freshness.value}</strong>
        <small>{freshness.detail}</small>
      </div>
    </section>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return (localStorage.getItem("solix-theme") as "dark" | "light") ?? "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    try {
      localStorage.setItem("solix-theme", theme);
    } catch {
      /* private window */
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

/** Live snapshots over SSE, so the browser never polls. */
function useLive() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      setSnapshot(JSON.parse(e.data) as LiveSnapshot);
      setConnected(true);
    };
    return () => es.close();
  }, [nonce]);

  // Renaming a socket changes data the stream owns; reconnecting is the
  // simplest way to see it without a second source of truth.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { snapshot, connected, refresh };
}

export function App() {
  const { theme, toggle } = useTheme();
  const { snapshot, connected, refresh } = useLive();
  const [info, setInfo] = useState<DeviceResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const weather = useWeather();

  // The address can go stale on a DHCP change; the server also retries on its
  // own, but an offline dashboard should offer the button rather than just sit.
  const findDevice = async () => {
    setSearching(true);
    setSearchMsg(null);
    try {
      const res = await fetch("/api/rediscover", { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; host?: string; error?: string };
      setSearchMsg(body.ok ? `Found it at ${body.host}.` : (body.error ?? "No Solarbank answered."));
    } catch (err) {
      setSearchMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    if (info) return;
    const load = () =>
      fetch("/api/device")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: DeviceResponse | null) => d && setInfo(d))
        .catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [info]);

  if (!snapshot) {
    return (
      <div className="app">
        <div className="card">
          <div className="empty">Connecting to the Solarbank…</div>
        </div>
      </div>
    );
  }

  const stale = snapshot.staleSeconds > 20;
  const offline = !snapshot.online || !connected;
  const statusClass = offline ? "offline" : stale ? "stale" : "";
  const mode =
    info?.modes.find((m) => m.value === snapshot.operatingMode)?.label ??
    snapshot.operatingMode.replace(/_/g, " ");

  return (
    <div className={`app${theme === "light" && weather.report && !weather.report.now.isDay ? " is-light-night" : ""}`}>
      <header className="header">
        <div className="brand">
          <span className="mark">
            <IconBolt size={19} />
          </span>
          <div>
            <h1>{info?.device.name ?? "Solarbank"}</h1>
            <div className="sub">
              {info
                ? `${info.device.host} · ${info.device.serial} · fw ${info.device.firmware} · ${info.device.ratedKwh} kWh`
                : "—"}
            </div>
          </div>
        </div>

        <div className="header-right">
          {weather.report && (() => {
            const { Icon, label, tone } = weatherLook(
              weather.report.now.code,
              weather.report.now.isDay,
            );
            return (
              <span className="weather-chip" title={`${label} in ${weather.report.place.name}`}>
                <span className="weather-ico" style={{ color: tone }}>
                  <Icon size={17} />
                </span>
                <b>{Math.round(weather.report.now.tempC)}°</b>
                <span className="weather-label">{label}</span>
              </span>
            );
          })()}
          <span className="mode-chip">{mode}</span>
          <span className={`status ${statusClass}`}>
            <span className="dot" />
            {offline
              ? "Offline"
              : stale
                ? `${snapshot.staleSeconds}s ago`
                : weather.report
                  ? `${weather.report.place.name} · ${formatClock(snapshot.ts)}`
                  : formatClock(snapshot.ts)}
          </span>
          <button className="icon-btn" onClick={toggle} title={theme === "dark" ? "Light mode" : "Dark mode"}>
            {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
          </button>
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
            <IconSettings size={17} />
          </button>
        </div>
      </header>

      {offline && (
        <div className="msg err offline-bar">
          <span>
            Lost contact with the Solarbank. The values below are the last known reading, from{" "}
            {formatClock(snapshot.ts)}.
            {searchMsg && <> {searchMsg}</>}
          </span>
          <button className="btn secondary" onClick={findDevice} disabled={searching}>
            {searching ? "Searching…" : "Search the network"}
          </button>
        </div>
      )}

      <Suspense fallback={<div className="house house-loading" aria-hidden />}>
        <HouseScene
          state={{
            batteryW: snapshot.batteryW,
            gridW: snapshot.gridW,
            acOutW: snapshot.acOutW,
            solarW: snapshot.pvW + snapshot.thirdPartyPvW,
            strings: snapshot.strings,
            // The largest PV actually recorded, so the panel glow is scaled
            // against this array rather than an unrelated register.
            peakSolarW: info?.peakPvW || 2500,
            homeW: snapshot.homeSource === "none" ? 0 : snapshot.homeW,
            mainsW: snapshot.gridMeasured ? Math.max(snapshot.gridW, 0) : (mainsInputW(snapshot) ?? 0),
            gridMeasured: snapshot.gridMeasured,
            packs: info?.device.packs ?? 1,
          }}
          weather={
            weather.report
              ? {
                  cloudPct: weather.report.now.cloudPct,
                  precipPct: weather.report.days[0]?.precipPct ?? 0,
                  isDay: weather.report.now.isDay,
                  radiation: weather.report.now.radiation,
                  sunrise: weather.report.days[0]?.sunrise ?? "",
                  sunset: weather.report.days[0]?.sunset ?? "",
                }
              : null
          }
        />
      </Suspense>

      <ConfidenceBand snapshot={snapshot} />

      <div className="layout">
        <section className="card flow-card">
          {snapshot.pvW > 0 && <Strings strings={snapshot.strings} />}
          <PowerFlow snapshot={snapshot} ratedKwh={info?.device.ratedKwh ?? 0} />
          <p className="footnote">{footnote(snapshot)}</p>
        </section>

        <div className="col">
          <section className="card">
            <Readings snapshot={snapshot} today={snapshot.today} device={info?.device ?? null} />
          </section>
          <section className="card">
            <Weather {...weather} onReviewSettings={() => setSettingsOpen(true)} />
          </section>
        </div>

        <section className="card span-2">
          <Sockets plugs={snapshot.plugs} onRenamed={refresh} />
        </section>

        <section className="card span-2">
          <HistoryCharts />
        </section>

      </div>

      {info && (
        <SettingsPanel
          settings={snapshot.settings}
          modes={info.modes}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * One line that swaps content, rather than paragraphs that mount and unmount.
 *
 * Ordered most situational first. The permanent "this is AC output, not a
 * meter reading" caveat sits last, because putting it above the others meant
 * it never showed: the sunset case is true for most of a charging day and was
 * shadowing everything else.
 */
function footnote(s: Snapshot): string {
  if (s.homeSource === "none") {
    return "Household consumption is not measured. Pair a Smart Meter, or smart plugs can stand in for it.";
  }
  if (s.eta.direction === "charge" && s.eta.beforeSunset === false && s.eta.minutes !== null) {
    return `At the current rate the battery reaches ${s.eta.targetSoc}% after sunset, so it will not get there on solar alone today.`;
  }
  if (s.eta.direction === "discharge" && s.eta.minutes !== null) {
    return `At the current draw the battery reaches its ${s.eta.targetSoc}% floor in ${formatDuration(s.eta.minutes)}.`;
  }
  const mainsEstimate = mainsInputW(s);
  if (mainsEstimate !== null && mainsEstimate > 0) {
    return `${formatW(mainsEstimate)} of the socket-measured demand is not supplied by the Solarbank. This is a calculated mains estimate, not a grid reading.`;
  }
  if (s.homeSource === "sockets" && s.unmeteredW > 0) {
    return `${formatW(s.unmeteredW)} of the output is not covered by the sockets: the custom-mode baseline plus anything on an unmetered circuit.`;
  }
  if (!s.gridMeasured) {
    return "Grid flow is unavailable without a Smart Meter. Solarbank output is not a grid reading.";
  }
  return "";
}
