import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { DeviceInfo, EnergyTotals, Snapshot } from "../../server/types.ts";
import { PowerFlow } from "./PowerFlow.tsx";
import { Readings } from "./Readings.tsx";
import { SmartMeter } from "./SmartMeter.tsx";
import { TodaySummary } from "./TodaySummary.tsx";
import { Insights } from "./Insights.tsx";
import { isBoolean, usePreference } from "./preferences.ts";
import { HistoryCharts } from "./HistoryCharts.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { Sockets } from "./Sockets.tsx";
import { Strings } from "./Strings.tsx";
import { Weather, useWeather } from "./Weather.tsx";
import { mainsInputW, netAcOutputW } from "./derive.ts";
import { formatClock, formatDuration, formatW } from "./format.ts";
import { IconBolt, IconInfo, IconMoon, IconSettings, IconSun } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
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

function ConfidenceBand({ snapshot, connected }: { snapshot: Snapshot; connected: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  const home = snapshot.homeSource === "meter" ? "Smart Meter" : snapshot.homeSource === "sockets" ? "Socket estimate" : "Not measured";
  const netAc = netAcOutputW(snapshot);
  const balance = snapshot.gridMeasured
    ? <>{snapshot.gridW > 0 ? "Import" : snapshot.gridW < 0 ? "Export" : "Measured"} · <span className="confidence-value">{formatW(Math.abs(snapshot.gridW))}</span></>
    : netAc !== null
      ? <>Calculated · <span className="confidence-value">{netAc > 0 ? "+" : netAc < 0 ? "-" : ""}{formatW(Math.abs(netAc))}</span></>
      : "Output only";
  const offline = !snapshot.online || !connected;
  const stale = snapshot.staleSeconds > 20;
  const status = offline ? "Offline" : stale ? "Stale" : "Live";
  const age = formatDuration(Math.max(0, Math.round(snapshot.staleSeconds / 60)));
  const freshness = snapshot.staleSeconds < 60 ? `${Math.max(0, Math.round(snapshot.staleSeconds))}s ago` : `${age} ago`;

  return (
    <>
    <section className="confidence-band" aria-label="Measurement confidence">
      <div className="confidence-item">
        <span className="confidence-label">Household</span>
        <strong>{home}</strong>
      </div>
      <div className="confidence-item">
        <span className="confidence-label">{snapshot.gridMeasured ? "Grid" : "AC balance"}</span>
        <strong>{balance}</strong>
      </div>
      <div className={`confidence-item is-${offline ? "critical" : stale ? "warn" : "good"}`}>
        <span className="confidence-label">Connection</span>
        <strong>{status}<span className="confidence-age"> · {freshness}</span></strong>
      </div>
      <button className="icon-btn confidence-info" title="About these measurements" aria-label="About these measurements" aria-haspopup="dialog" onClick={() => setDetailsOpen(true)}>
        <IconInfo size={18} />
      </button>
    </section>
    <Modal open={detailsOpen} title="About these measurements" onClose={closeDetails}>
      <dl className="measurement-definitions">
        <dt>Household</dt>
        <dd>A Smart Meter measures whole-home demand. A socket estimate totals monitored sockets only; it cannot establish consumption elsewhere in the home.</dd>
        <dt>AC balance</dt>
        <dd>Calculated from Solarbank AC output minus monitored socket demand. Positive means output exceeds those sockets; negative means their demand exceeds output. This is not a measurement of grid import, export, or unmonitored consumption.</dd>
        <dt>Grid</dt>
        <dd>Shown only when a Smart Meter supplies a direct reading. Import draws from the grid; export sends power to it. Without socket readings or a meter, only Solarbank AC output is available.</dd>
        <dt>Connection</dt>
        <dd>Live means the stream is connected, the device is online, and the last device reading is at most 20 seconds old. Stale or offline values are the last known readings.</dd>
      </dl>
    </Modal>
    </>
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
  const [compact, setCompact] = usePreference("solix-compact", false, isBoolean);
  const [stringsOpen, setStringsOpen] = useState(false);
  const closeStrings = useCallback(() => setStringsOpen(false), []);
  const [navMarker, setNavMarker] = useState<HTMLDivElement | null>(null);
  const [navStuck, setNavStuck] = useState(false);
  useEffect(() => {
    if (!navMarker) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setNavStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(navMarker);
    return () => observer.disconnect();
  }, [navMarker]);
  const [section, setSection] = useState(() => window.location.hash.slice(1) || "overview");
  useEffect(() => {
    const updateSection = () => setSection(window.location.hash.slice(1) || "overview");
    window.addEventListener("hashchange", updateSection);
    return () => window.removeEventListener("hashchange", updateSection);
  }, []);

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

  return (
    <div className={`app${compact ? " is-compact" : ""}${theme === "light" && weather.report && !weather.report.now.isDay ? " is-light-night" : ""}`}>
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

      {!compact && <Suspense fallback={<div className="house house-loading" aria-hidden />}>
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
            netAcW: netAcOutputW(snapshot),
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
      </Suspense>}

      <div ref={setNavMarker} className="nav-marker" aria-hidden="true" />
      <nav className={`dashboard-nav${navStuck ? " is-stuck" : ""}`} aria-label="Dashboard sections">
        <div>{["Overview", "Forecast", "Sockets", "History"].map((label) => <a key={label} href={`#${label.toLowerCase()}`} aria-current={section === label.toLowerCase() ? "location" : undefined}>{label}</a>)}</div>
        <label className="compact-toggle" title="Compact view"><span className="compact-toggle-label">Compact view</span><input type="checkbox" role="switch" aria-label="Compact view" checked={compact} onChange={(event) => setCompact(event.target.checked)} /><span className="compact-toggle-track" aria-hidden="true" /></label>
      </nav>
      <div id="overview" className="dashboard-anchor">
      <TodaySummary snapshot={snapshot} today={snapshot.today} ratedKwh={info?.device.ratedKwh ?? null} />
      <ConfidenceBand snapshot={snapshot} connected={connected} />
      </div>

      <div className="layout">
        <section className="card flow-card">
          <div className="chart-head"><div className="card-title"><IconBolt size={17} /><h2>Live power</h2></div><span className="sub-total">{snapshot.online ? "Live readings" : "Last readings"}</span></div>
          <div className="flow-compact">
          <PowerFlow snapshot={snapshot} ratedKwh={info?.device.ratedKwh ?? 0} />
          </div>
          <p className="footnote">{footnote(snapshot)}</p>
          <button className="detail-trigger" onClick={() => setStringsOpen(true)} aria-haspopup="dialog">PV strings <span>{formatW(snapshot.pvW)}</span><IconInfo size={16} /></button>
          <Modal open={stringsOpen} title="PV strings" onClose={closeStrings} wide>
            <Strings key={info?.device.serial ?? "unknown"} strings={snapshot.strings} model={info?.device.model} deviceKey={info?.device.serial} fresh={connected && snapshot.online && snapshot.staleSeconds <= 20} />
          </Modal>
        </section>

        <section className="card battery-card">
          <Readings snapshot={snapshot} today={snapshot.today} device={info?.device ?? null} connected={connected} />
        </section>

        <section className="card span-2 smart-meter-card">
          <SmartMeter snapshot={snapshot} connected={connected} />
        </section>

        <section className="card span-2 dashboard-anchor" id="forecast">
          <Weather {...weather} />
          {weather.report && <Insights snapshot={snapshot} report={weather.report} ratedKwh={info?.device.ratedKwh ?? null} onReviewSettings={() => setSettingsOpen(true)} />}
        </section>

        <section className="card span-2 dashboard-anchor" id="sockets">
          <Sockets plugs={snapshot.plugs} onRenamed={refresh} />
        </section>

        <section className="card span-2 dashboard-anchor" id="history">
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
  const netAc = netAcOutputW(s);
  if (netAc !== null) {
    return `${formatW(Math.abs(netAc))} net AC ${netAc >= 0 ? "output" : "input"} after socket use. This is calculated from Solarbank AC output minus the measured sockets, not a Smart Meter reading.`;
  }
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
