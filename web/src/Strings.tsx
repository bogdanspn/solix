import type { PvString } from "../../server/types.ts";
import { lazy, Suspense, useState } from "react";
import { hardwareFor, isPanelConfiguration, isPanelVoltages, panelSetups, pvInputStatus, seriesPanelEstimate, type PanelConfiguration, type PanelSetup } from "./hardware.ts";
import { usePreference } from "./preferences.ts";
import { DetailTabs } from "./DetailTabs.tsx";

const ProductScene = lazy(() => import("./ProductScene.tsx"));

function PanelFields({ label, setup, individual = false, onChange }: { label: string; setup: PanelSetup; individual?: boolean; onChange: (setup: PanelSetup) => void }) {
  const [draft, setDraft] = useState(String(setup.panelW));
  const valid = draft.trim() !== "" && Number.isFinite(Number(draft)) && Number(draft) >= 1 && Number(draft) <= 500;
  return <fieldset className="panel-config-input">
    <legend>{label}</legend>
    <div className="panel-config-fields">
      <label>{individual ? "Panels" : "Panels per input"}<select value={setup.panelsPerInput} onChange={(event) => onChange({ ...setup, panelsPerInput: Number(event.target.value) })}>
        {(individual ? [0, 1, 2, 3] : [1, 2, 3]).map((count) => <option key={count} value={count}>{count === 0 ? "Not connected" : `${count} ${count === 1 ? "panel" : "panels"}`}</option>)}
      </select></label>
      <label>Panel nameplate W<input type="number" min="1" max="500" step="any" disabled={setup.panelsPerInput === 0} value={draft} aria-invalid={!valid} onChange={(event) => {
        const value = event.target.value;
        setDraft(value);
        if (value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 500) onChange({ ...setup, panelW: Number(value) });
      }} onBlur={() => { if (!valid) setDraft(String(setup.panelW)); }} /></label>
      {!valid && <span className="panel-config-error" role="status">Enter a panel rating from 1 to 500 W. Saved rating: {setup.panelW} W.</span>}
      <label className="panel-config-toggle"><input type="checkbox" disabled={setup.panelsPerInput === 0} checked={setup.bifacial} onChange={(event) => onChange({ ...setup, bifacial: event.target.checked })} /> Bifacial</label>
    </div>
  </fieldset>;
}

/**
 * Per-MPPT solar inputs, sitting above the solar node in the flow diagram.
 *
 * PV1-PV3 are measured (voltage x current from registers 10167-10172). PV4 is
 * derived: the device exposes no registers for it, so it is the shortfall
 * between the PV total and the three measured strings. It is hatched and
 * labelled so it never reads as a measurement.
 */
export function Strings({ strings, model, fresh = false, deviceKey = "unknown" }: { strings: PvString[]; model?: string; fresh?: boolean; deviceKey?: string }) {
  const hardware = hardwareFor(model);
  const [panelVoltages, setPanelVoltages] = usePreference<Record<string, number>>(`solix-panel-vmp-${deviceKey}`, {}, isPanelVoltages);
  const [configuration, setConfiguration] = usePreference<PanelConfiguration>(`solix-panel-configuration-${deviceKey}`, { enabled: false, panelsPerInput: 1, panelW: 400, bifacial: false }, isPanelConfiguration);
  const setups = panelSetups(configuration, hardware?.mppts ?? 0);
  const panelCount = setups.reduce((total, setup) => total + setup.panelsPerInput, 0);
  const nameplateW = setups.reduce((total, setup) => total + setup.panelsPerInput * setup.panelW, 0);
  const configured = hardware !== null && configuration.enabled;
  const peak = Math.max(...strings.map((s) => s.watts), 1);

  return (
    <div className="strings-panel">
      <Suspense fallback={<div className="product-scene" aria-busy="true" />}>
        <ProductScene kind="panels" />
      </Suspense>
      {hardware ? <dl className="hardware-metrics">
        <div><dt>Solar input max</dt><dd>5.0 <small>kW</small></dd></div>
        <div><dt>Independent MPPTs</dt><dd>{hardware.mppts}</dd></div>
        <div><dt>Advertised array</dt><dd>Up to {hardware.advertisedPanels} <small>panels</small></dd></div>
      </dl> : <p className="technical-note">Hardware limits are not verified for {model || "this device"}.</p>}
      {configured && <div className="pv-array-summary">
        <strong>{panelCount} panels <span>/ {(nameplateW / 1000).toFixed(1)} kWp nameplate</span></strong>
        <span>User-provided configuration</span>
      </div>}
      {configured && nameplateW > hardware.solarW && <p className="technical-note panel-config-error" role="status">Configured nameplate capacity exceeds the listed {hardware.solarW / 1000} kW total input rating. Verify the permitted array configuration with Anker before connecting.</p>}
      <DetailTabs label="PV details" tabs={["Solar", "Panel configuration", "Connection limits"]}>
      <div>
      <div className="technical-heading"><h3>PV inputs</h3><span>{fresh ? "Live" : "Last readings"}</span></div>
      {strings.length === 0 && <p className="technical-note">PV readings unavailable.</p>}
      <div className="strings">
        {strings.map((st) => {
          const setup = configured ? setups[st.index - 1] : undefined;
          const status = pvInputStatus(st, model, fresh);
          const estimate = status === "Within operating range" ? seriesPanelEstimate(st, panelVoltages[String(st.index)] ?? 0, fresh) : null;
          const warning = status.startsWith("At or above") || status.startsWith("Above") || status.startsWith("Outside");
          return (
          <div className={`string ${st.watts < 1 ? "is-idle" : ""}`} key={st.index}>
            <div className="string-head">
              <span className="string-name">PV{st.index}</span>
              <span className="string-watts">{Math.round(st.watts)} W</span>
            </div>
            {setup && <div className="string-configured">
              <strong>{setup.panelsPerInput === 0 ? "Not connected" : `${setup.panelsPerInput} × ${setup.panelW} W${setup.bifacial ? " bifacial" : " panels"}`}</strong>
              <span>{(setup.panelsPerInput * setup.panelW / 1000).toFixed(2)} kWp nameplate · user-provided</span>
            </div>}
            <div className="string-bar-track" title="Relative to the strongest PV input, not the input's capacity">
              <div
                className={`string-bar ${st.derived ? "is-derived" : ""}`}
                style={{ width: `${Math.min(100, (st.watts / peak) * 100)}%` }}
              />
            </div>
            <div className="string-meta">
              {st.watts < 1 ? (
                "idle"
              ) : st.derived ? (
                <span
                  className="inferred"
                  title="Not exposed by the device; inferred as the shortfall between the PV total and the three measured strings"
                >
                  derived
                </span>
              ) : (
                `${st.volts.toFixed(1)} V · ${st.amps.toFixed(2)} A`
              )}
            </div>
            <div className={`string-status${warning ? " is-warning" : ""}`}>{status}</div>
            {!configured && !st.derived && hardware && <div className="string-estimate">
              <label>Panel Vmp <span><input type="number" min="1" max="60" step="0.1" inputMode="decimal" aria-label={`PV${st.index} panel Vmp`} placeholder="--" value={panelVoltages[String(st.index)] ?? ""} onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                setPanelVoltages((previous) => {
                  const next = { ...previous };
                  if (Number.isFinite(value) && value > 0 && value <= 60) next[String(st.index)] = value;
                  else delete next[String(st.index)];
                  return next;
                });
              }} /> V</span></label>
              <strong>{estimate === null ? "Series count unknown" : `About ${estimate} in series`}</strong>
              <span>Parallel count unknown</span>
            </div>}
          </div>
        );})}
      </div>
      <p className="technical-note">{configured
        ? `Panel count and wattage are user-provided, not detected. Series/parallel wiring remains unverified; PV4 power is inferred.${setups.some((setup) => setup.panelsPerInput > 0 && setup.bifacial) ? " Bifacial rear-side gain can raise output above the declared nameplate rating; this does not indicate extra panels." : ""}`
        : "Panel count is not reported by Modbus. The series estimate compares operating voltage with your panel's rated Vmp (voltage at maximum power), with a 15% tolerance. Temperature, shading and MPPT behaviour can change it; parallel panels do not add voltage. PV4 power is inferred."}</p>
      </div>
      <div className="panel-configuration">
        {hardware ? <>
          <label className="panel-config-toggle"><input type="checkbox" checked={configuration.enabled} onChange={(event) => setConfiguration({ ...configuration, enabled: event.target.checked })} /> Use saved panel configuration</label>
          {configuration.enabled && <>
            <fieldset className="panel-config-mode">
              <legend>Panel setup</legend>
              <label><input type="radio" name={`panel-mode-${deviceKey}`} checked={!configuration.individual} onChange={() => setConfiguration({ ...configuration, individual: false })} /> All inputs</label>
              <label><input type="radio" name={`panel-mode-${deviceKey}`} checked={!!configuration.individual} onChange={() => setConfiguration({ ...configuration, individual: true, inputs: configuration.inputs ?? panelSetups(configuration, hardware.mppts) })} /> Per input</label>
            </fieldset>
            {configuration.individual ? <div className="panel-config-inputs">{setups.map((setup, index) => <PanelFields key={index} label={`PV${index + 1} / MPPT ${index + 1}`} setup={setup} individual onChange={(next) => setConfiguration({ ...configuration, inputs: setups.map((previous, position) => position === index ? next : previous) })} />)}</div>
              : <PanelFields key="shared" label={`All ${hardware.mppts} inputs`} setup={configuration} onChange={(next) => setConfiguration({ ...configuration, ...next })} />}
          </>}
          <p className="technical-note">User-provided panel ratings. Independent MPPTs may have different arrays; panel compatibility within each input and all connection limits still apply.</p>
        </> : <p className="technical-note">Panel configuration is not available for {model || "this device"}.</p>}
      </div>
      <div>
      {hardware ? <section className="technical-section">
        <div className="technical-heading"><h3>Connection limits</h3><a href={hardware.source} target="_blank" rel="noreferrer">Anker specifications</a></div>
        <dl className="hardware-specs">
          <div><dt>MPPT operating voltage</dt><dd>{hardware.mpptMinV}-{hardware.mpptMaxV} V</dd></div>
          <div><dt>Absolute PV voltage max</dt><dd>{hardware.maxPvV} V DC</dd></div>
          <div><dt>Input current per MPPT max</dt><dd>{hardware.maxMpptA} A</dd></div>
          <div><dt>Total solar input max</dt><dd>{hardware.solarW.toLocaleString()} W</dd></div>
        </dl>
        <p className="technical-note">Up to 12 panels is a manufacturer configuration claim, not approval for any 12 panels. Series adds voltage; parallel adds current. Cold-corrected open-circuit voltage (Voc) must stay below 60 V. Check panel Isc, cables, connectors and the installation manual with your installer; 36 A is an operating-input rating, not a verified short-circuit rating. Live output is not spare connection capacity.</p>
      </section> : <p className="technical-note">Connection limits are not verified for {model || "this device"}.</p>}
      </div>
      </DetailTabs>
    </div>
  );
}
