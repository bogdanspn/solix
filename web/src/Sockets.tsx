import { lazy, Suspense, useState } from "react";
import type { PlugReading } from "../../server/types.ts";
import { formatEnergy, formatW } from "./format.ts";
import { IconDownload, IconInfo, IconPlug, IconRefresh, IconStar } from "./Icons.tsx";
import { Confirm, Modal } from "./Modal.tsx";
import { isBoolean, isStringList, usePreference } from "./preferences.ts";
import { downloadJson, localDate } from "./download.ts";

const ProductScene = lazy(() => import("./ProductScene.tsx"));

/**
 * The sockets are the only measurement of household consumption on a system
 * without a Smart Meter, so they get a first-class panel rather than a
 * footnote. Sorted by draw, so whatever is actually using power is on top.
 */
export function Sockets({ plugs, onRenamed }: { plugs: PlugReading[]; onRenamed: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [sort, setSort] = usePreference<"live" | "today" | "name">("solix-socket-sort", "today", (value): value is "live" | "today" | "name" => value === "live" || value === "today" || value === "name");
  const [showInactive, setShowInactive] = usePreference("solix-socket-inactive", true, isBoolean);
  const [pinned, setPinned] = usePreference("solix-socket-pins", [], isStringList);
  const [selected, setSelected] = useState<string | null>(null);
  const [tariffOpen, setTariffOpen] = useState(false);
  const [tariff, setTariff] = usePreference("solix-tariff", "", (value): value is string => typeof value === "string" && (value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0)));
  const [currency, setCurrency] = usePreference("solix-currency", "EUR", (value): value is string => value === "EUR" || value === "GBP" || value === "USD");
  const [saving, setSaving] = useState(false);

  const rescan = async () => {
    setScanning(true);
    setScanMsg(null);
    try {
      const res = await fetch("/api/plugs/rescan", { method: "POST" });
      const body = (await res.json()) as { total?: number; added?: string[]; removed?: string[]; error?: string };
      if (body.error) setScanMsg(body.error);
      else {
        const bits = [`${body.total} socket${body.total === 1 ? "" : "s"} found`];
        if (body.added?.length) bits.push(`${body.added.length} new`);
        if (body.removed?.length) bits.push(`${body.removed.length} gone`);
        setScanMsg(bits.join(" · "));
      }
      onRenamed();
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const sorted = [...plugs].filter((plug) => showInactive || (plug.online && plug.on && plug.watts > 1))
    .sort((first, second) => Number(pinned.includes(second.serial)) - Number(pinned.includes(first.serial)) || (sort === "name" ? first.name.localeCompare(second.name)
      : sort === "today" ? second.todayKwh - first.todayKwh
      : (second.online ? second.watts : 0) - (first.online ? first.watts : 0)) || first.name.localeCompare(second.name));
  const total = plugs.reduce((s, p) => s + (p.online ? p.watts : 0), 0);
  const offline = plugs.filter((p) => !p.online).length;
  const totalToday = plugs.reduce((s, p) => s + p.todayKwh, 0);

  // The stream hands us new plug objects every poll, so the dialog reads the
  // live plug by serial rather than holding on to the one that was clicked.
  const pending = plugs.find((p) => p.serial === asking) ?? null;

  // Cutting power to a socket is a real-world action, so it always confirms.
  const toggle = async (p: PlugReading) => {
    const next = !p.on;
    setSwitching(p.serial);
    try {
      const res = await fetch(`/api/plugs/${encodeURIComponent(p.serial)}/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!body.ok) setScanMsg(body.error ?? body.message ?? "The socket rejected that.");
      onRenamed();
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(null);
      setAsking(null);
    }
  };

  const save = async (serial: string) => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/plugs/${encodeURIComponent(serial)}/name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draft.trim() }),
      });
      if (!response.ok) throw new Error("Could not rename this socket.");
      setEditing(null);
      onRenamed();
    } catch (error) {
      setScanMsg(error instanceof Error ? error.message : "Could not rename this socket.");
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="chart-head unified-head sockets-head">
        <div className="card-title">
          <IconPlug size={17} />
          <h2>Sockets</h2>
        </div>
        {plugs.length > 0 && <div className="socket-toolbar">
          <label>Sort by <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="today">Today's energy</option><option value="live">Live power</option><option value="name">Name</option>
          </select></label>
          <label><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />Show inactive</label>
        </div>}
        <div className="head-actions">
          <span className="sub-total">
            {formatW(total)} · {formatEnergy(totalToday)} today · {plugs.length} sockets
            {offline > 0 && <span className="warn"> · {offline} offline</span>}
          </span>
          <button className="icon-btn wide" onClick={rescan} disabled={scanning} title="Sweep the LAN for sockets">
            <IconRefresh size={14} />
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          {plugs.length > 0 && <button className="icon-btn" title="Export socket readings JSON" aria-label="Export socket readings JSON" onClick={() => downloadJson(`solix-sockets-${localDate(Date.now())}.json`, { exportedAt: new Date().toISOString(), energyBasis: "Estimated from socket readings", plugs })}><IconDownload size={16} /></button>}
        </div>
      </div>
      {scanMsg && <p className="scan-msg" role="status">{scanMsg}</p>}
      {plugs.length > 0 && <button className="detail-trigger socket-cost-trigger" onClick={() => setTariffOpen(true)} aria-haspopup="dialog">Energy cost estimate{tariff !== "" ? `: ${new Intl.NumberFormat(undefined, { style: "currency", currency }).format(totalToday * Number(tariff))} today` : ""}<IconInfo size={16} /></button>}
      <Modal open={tariffOpen} title="Energy cost estimate" onClose={() => setTariffOpen(false)}><div className="socket-tariff">
        <div className="socket-toolbar"><label>Rate / kWh <input type="number" min="0" step="0.01" value={tariff} onChange={(event) => { const value = event.target.value; if (value === "" || Number(value) >= 0) setTariff(value); }} /></label>
          <label>Currency <select value={currency} onChange={(event) => setCurrency(event.target.value)}><option>EUR</option><option>GBP</option><option>USD</option></select></label></div>
        <p className="muted">Socket consumption only, at a flat rate. Excludes standing charges and does not estimate solar savings.</p>
      </div></Modal>

      {plugs.length === 0 ? (
        <div className="socket-empty">
          <IconPlug size={22} />
          <div>
            <strong>No sockets connected yet</strong>
            <p>Enable Modbus TCP for each Smart Plug in the Anker app, then scan your network.</p>
          </div>
        </div>
      ) : (
        <div className="socket-list">
          <div className="socket-list-heading" aria-hidden="true"><span>Socket</span><span>Live power</span><span>Today</span><span>Daily share</span><span /></div>
          {sorted.length === 0 && <p className="empty">No active sockets</p>}
          {sorted.map((p) => {
          const share = totalToday > 0 ? Math.max(0, Math.min(100, p.todayKwh / totalToday * 100)) : 0;
          return (
            <div className={`socket-row ${p.online ? "" : "is-offline"}`} key={p.serial || p.host}>
              <button className="socket-row-trigger" onClick={() => { setSelected(p.serial || p.host); setEditing(null); }} aria-haspopup="dialog" aria-label={`Details for ${p.name}`}>
                <span className="socket-identity"><span className={`socket-state ${p.online && p.on ? "is-on" : ""}`} /><span><b>{pinned.includes(p.serial) && <IconStar size={12} />}{p.name}</b><small>{!p.online ? "Offline" : p.on ? "On" : "Off"}</small></span></span>
                <span className="socket-live"><small>Live</small><b>{p.online ? formatW(p.watts) : "--"}</b></span>
                <span className="socket-daily"><small>Today</small><b>{formatEnergy(p.todayKwh)}</b></span>
                <span className="socket-daily-share" aria-label={`${share.toFixed(0)} percent of socket energy today`}><span><i style={{ width: `${share}%` }} /></span><b>{share.toFixed(0)}%</b></span>
                <span className="socket-chevron" aria-hidden="true" />
              </button>
              <Modal open={selected === (p.serial || p.host) && asking === null} title={p.name} wide onClose={() => { setSelected(null); setEditing(null); }}>
              <div className="socket-detail-body">
                <div className="socket-detail-heading"><div><h3>{p.name}</h3><span>{!p.online ? "Connection unavailable" : p.on ? "Power enabled" : "Power disabled"}</span></div>
                <div className="socket-detail-actions">
                  <button className="icon-btn" disabled={!p.serial} aria-pressed={pinned.includes(p.serial)} title={pinned.includes(p.serial) ? `Unpin ${p.name}` : `Pin ${p.name}`} aria-label={pinned.includes(p.serial) ? `Unpin ${p.name}` : `Pin ${p.name}`} onClick={() => setPinned((previous) => previous.includes(p.serial) ? previous.filter((serial) => serial !== p.serial) : [...previous, p.serial])}><IconStar size={16} /></button>
                  <button className="btn secondary" onClick={() => setAsking(p.serial)} disabled={!p.serial || !p.online || switching === p.serial}>
                    <IconPlug size={14} />{p.on ? "Switch off" : "Switch on"}
                  </button>
                {editing === p.serial ? (
                  <form className="socket-rename" onSubmit={(event) => { event.preventDefault(); void save(p.serial); }}>
                    <input aria-label={`Name for ${p.name}`} className="rename" autoFocus value={draft} maxLength={80} disabled={saving}
                      onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditing(null); } }} />
                    <button className="btn secondary" type="submit" disabled={saving || !draft.trim()}>{saving ? "Saving..." : "Save"}</button>
                    <button className="btn secondary" type="button" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <button className="btn secondary" disabled={!p.serial} onClick={() => { setDraft(p.name); setEditing(p.serial); }}>Rename</button>
                )}
                </div>
                </div>
                <Suspense fallback={<div className="product-scene" aria-busy="true" />}><ProductScene kind="plug" /></Suspense>
                <div className="socket-detail-columns">
                  <div className="socket-energy-detail"><h4>Energy consumption</h4><dl className="socket-energy-totals">
                    <div><dt>Today</dt><dd>{formatEnergy(p.todayKwh)}</dd></div>
                    <div><dt>7 days</dt><dd>{formatEnergy(p.weekKwh)}</dd></div>
                    <div><dt>30 days</dt><dd>{formatEnergy(p.monthKwh)}</dd></div>
                  </dl><p className="socket-energy-basis">Estimated from socket readings</p></div>
                  <div><h4>Electrical readings</h4><dl className="socket-electrical">
                    <div><dt>Voltage</dt><dd>{p.online ? `${p.volts.toFixed(0)} V` : "--"}</dd></div>
                    <div><dt>Current</dt><dd>{p.online ? `${p.amps.toFixed(2)} A` : "--"}</dd></div>
                    <div><dt>Temperature</dt><dd>{p.online ? `${p.tempC.toFixed(0)}°C` : "--"}</dd></div>
                  </dl></div>
                </div>
                <dl className="socket-device-meta"><div><dt>Address</dt><dd>{p.host}</dd></div><div><dt>Serial</dt><dd>{p.serial || "Unavailable"}</dd></div><div><dt>Model</dt><dd>{p.model || "Unavailable"}</dd></div><div><dt>Firmware</dt><dd>{p.firmware || "Unavailable"}</dd></div></dl>
              </div>
              </Modal>
            </div>
          );
          })}
        </div>
      )}

      <Confirm
        open={pending !== null}
        title={pending?.on ? "Switch this socket off?" : "Switch this socket on?"}
        confirmLabel={pending?.on ? "Switch off" : "Switch on"}
        danger={pending?.on ?? false}
        busy={switching !== null}
        onConfirm={() => pending && toggle(pending)}
        onCancel={() => setAsking(null)}
      >
        <strong>{pending?.name}</strong> will be switched {pending?.on ? "off" : "on"}. This cuts
        power to whatever is plugged into it.
      </Confirm>
    </>
  );
}
