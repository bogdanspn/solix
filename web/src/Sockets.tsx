import { useState } from "react";
import type { PlugReading } from "../../server/types.ts";
import { formatEnergy, formatW } from "./format.ts";
import { IconPlug, IconRefresh } from "./Icons.tsx";

/**
 * The sockets are the only measurement of household consumption on a system
 * without a Smart Meter, so they get a first-class panel rather than a
 * footnote. Sorted by draw, so whatever is actually using power is on top.
 */
export function Sockets({ plugs, onRenamed }: { plugs: PlugReading[]; onRenamed: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

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

  if (plugs.length === 0) return null;

  const sorted = [...plugs].sort((a, b) => b.watts - a.watts);
  const total = plugs.reduce((s, p) => s + (p.online ? p.watts : 0), 0);
  const peak = Math.max(...sorted.map((p) => p.watts), 1);
  const offline = plugs.filter((p) => !p.online).length;
  const totalToday = plugs.reduce((s, p) => s + p.todayKwh, 0);

  // Cutting power to a socket is a real-world action, so it always confirms.
  const toggle = async (p: PlugReading) => {
    const next = !p.on;
    if (!window.confirm(`Switch ${p.name} ${next ? "ON" : "OFF"}?

This cuts power to whatever is plugged in.`))
      return;
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
    }
  };

  const save = async (serial: string) => {
    setEditing(null);
    await fetch(`/api/plugs/${encodeURIComponent(serial)}/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: draft }),
    }).catch(() => {});
    onRenamed();
  };

  return (
    <>
      <div className="chart-head">
        <div className="card-title">
          <IconPlug size={17} />
          <h2>Sockets</h2>
          {scanMsg && <span className="scan-msg">{scanMsg}</span>}
        </div>
        <div className="head-actions">
          <span className="sub-total">
            {formatW(total)} · {formatEnergy(totalToday)} today · {plugs.length} sockets
            {offline > 0 && <span className="warn"> · {offline} offline</span>}
          </span>
          <button className="icon-btn wide" onClick={rescan} disabled={scanning} title="Sweep the LAN for sockets">
            <IconRefresh size={14} />
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </div>

      <div className="socket-grid">
        {sorted.map((p) => {
          const share = total > 0 ? (p.watts / total) * 100 : 0;
          return (
            <div className={`plug ${p.online ? "" : "is-offline"}`} key={p.serial || p.host}>
              <div className="plug-top">
                <button
                  className={`plug-switch ${p.on ? "on" : "off"}`}
                  onClick={() => toggle(p)}
                  disabled={!p.online || switching === p.serial}
                  title={p.on ? "Switch off" : "Switch on"}
                  aria-label={`${p.name} is ${p.on ? "on" : "off"}`}
                />
                {editing === p.serial ? (
                  <input
                    className="rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => save(p.serial)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save(p.serial);
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button
                    className="socket-name"
                    title={`${p.host} · ${p.serial} · click to rename`}
                    onClick={() => {
                      setDraft(p.name);
                      setEditing(p.serial);
                    }}
                  >
                    {p.name}
                  </button>
                )}
                <span className="plug-share">{share.toFixed(0)}%</span>
              </div>

              <div className="plug-watts">{formatW(p.watts)}</div>

              <div className="plug-bar-track">
                <div className="plug-bar" style={{ width: `${(p.watts / peak) * 100}%` }} />
              </div>

              <div className="plug-meta">
                {p.online ? `${p.volts.toFixed(0)} V · ${p.amps.toFixed(2)} A · ${p.tempC.toFixed(0)}°C` : "offline"}
              </div>

              <div className="plug-energy">
                <div>
                  <em>Today</em>
                  {formatEnergy(p.todayKwh)}
                </div>
                <div>
                  <em>7d</em>
                  {formatEnergy(p.weekKwh)}
                </div>
                <div>
                  <em>30d</em>
                  {formatEnergy(p.monthKwh)}
                </div>
              </div>

              {p.serial && <div className="plug-serial">{p.serial}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}
