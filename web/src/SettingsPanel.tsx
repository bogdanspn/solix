import { useEffect, useState } from "react";
import type { Settings } from "../../server/types.ts";
import { IconClose } from "./Icons.tsx";

interface Mode {
  value: string;
  label: string;
}

interface WriteResult {
  ok: boolean;
  key: string;
  readBack: number | null;
  message?: string;
}

/**
 * Settings live in a slide-over rather than on the dashboard: they are read
 * rarely and written even more rarely, and every write changes how the battery
 * actually behaves. Nothing is sent until Apply, and the result reports what
 * the device read back rather than what was asked for.
 */
export function SettingsPanel({
  settings,
  modes,
  open,
  onClose,
}: {
  settings: Settings;
  modes: Mode[];
  open: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Track the device while the user has not touched anything, so the panel
  // reflects changes made in the phone app.
  useEffect(() => {
    if (!dirty) setDraft(settings);
  }, [settings, dirty]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setResult(null);
  };

  const reset = () => {
    setDraft(settings);
    setDirty(false);
    setResult(null);
  };

  const apply = async () => {
    const changes: Record<string, number | string | boolean> = {};
    if (draft.chargingLimitSoc !== settings.chargingLimitSoc) changes["charging_limit_soc"] = draft.chargingLimitSoc;
    if (draft.dischargeLimitSoc !== settings.dischargeLimitSoc) changes["discharge_limit_soc"] = draft.dischargeLimitSoc;
    if (draft.backupReserveSoc !== settings.backupReserveSoc) changes["backup_reserve_soc"] = draft.backupReserveSoc;
    if (draft.backupSocEnable !== settings.backupSocEnable) changes["backup_soc_enable"] = draft.backupSocEnable;

    const summary = Object.keys(changes).join(", ").replace(/_/g, " ");
    if (!window.confirm(`Write these settings to the Solarbank?\n\n${summary}`)) return;

    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const body = (await res.json()) as { ok: boolean; results: WriteResult[] };
      if (body.ok) {
        setResult({ ok: true, text: "Applied. The device confirmed the new values." });
        setDirty(false);
      } else {
        setResult({
          ok: false,
          text: body.results
            .filter((r) => !r.ok)
            .map((f) => `${f.key.replace(/_/g, " ")}: ${f.message ?? "rejected"}`)
            .join(" · "),
        });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={`scrim ${open ? "is-open" : ""}`} onClick={onClose} aria-hidden />
      <aside
        className={`sheet ${open ? "is-open" : ""}`}
        role="dialog"
        aria-label="Settings"
        aria-hidden={!open}
      >
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconClose size={17} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="field">
            <div className="field-head">
              <label htmlFor="charge">Charge limit</label>
              <span className="val">{draft.chargingLimitSoc}%</span>
            </div>
            <p className="hint">Stop charging at this level.</p>
            <input
              id="charge"
              type="range"
              min={50}
              max={100}
              value={draft.chargingLimitSoc}
              onChange={(e) => update("chargingLimitSoc", Number(e.target.value))}
            />
          </div>

          <div className="field">
            <div className="field-head">
              <label htmlFor="discharge">Discharge limit</label>
              <span className="val">{draft.dischargeLimitSoc}%</span>
            </div>
            <p className="hint">Stop discharging at this level.</p>
            <input
              id="discharge"
              type="range"
              min={0}
              max={50}
              value={draft.dischargeLimitSoc}
              onChange={(e) => update("dischargeLimitSoc", Number(e.target.value))}
            />
          </div>

          <div className="field">
            <div className="field-head">
              <label htmlFor="reserve">Backup reserve</label>
              <span className="val">{draft.backupReserveSoc}%</span>
            </div>
            <p className="hint">Charge held back for an outage.</p>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.backupSocEnable}
                onChange={(e) => update("backupSocEnable", e.target.checked)}
              />
              Enabled
            </label>
            <input
              id="reserve"
              type="range"
              min={0}
              max={100}
              value={draft.backupReserveSoc}
              onChange={(e) => update("backupReserveSoc", Number(e.target.value))}
              disabled={!draft.backupSocEnable}
            />
          </div>

          <div className="field">
            <div className="field-head">
              <label>Operating mode</label>
              <span className="val" style={{ fontSize: 14 }}>
                {settings.operatingMode}
              </span>
            </div>
            <p className="hint">
              Read-only for now. The register value to mode mapping documented for other Solarbank
              models does not match this one, and writing an unverified value could select the wrong
              mode. Change it in the Anker app; run <code>npm run learn-modes</code> to record the
              real mapping.
            </p>
          </div>

          {result && <div className={`msg ${result.ok ? "ok" : "err"}`}>{result.text}</div>}
        </div>

        <div className="sheet-foot">
          <button className="btn" onClick={apply} disabled={!dirty || busy}>
            {busy ? "Writing…" : "Apply"}
          </button>
          <button className="btn secondary" onClick={dirty ? reset : onClose} disabled={busy}>
            {dirty ? "Discard" : "Close"}
          </button>
        </div>
      </aside>
    </>
  );
}
