import type { Snapshot } from "../../server/types.ts";
import { IconArrowOut, IconGrid, IconHome } from "./Icons.tsx";
import { formatW } from "./format.ts";

export function SmartMeter({ snapshot, connected }: { snapshot: Snapshot; connected: boolean }) {
  const detected = snapshot.gridMeasured;
  const gridW = detected ? snapshot.gridW : null;
  const homeW = detected && snapshot.homeSource === "meter" ? snapshot.homeW : null;
  const stale = !connected || !snapshot.online || snapshot.staleSeconds > 20;
  const status = gridW === null ? "Not connected" : gridW > 0 ? "Importing" : gridW < 0 ? "Exporting" : "Balanced";
  const direction = gridW === null ? "unavailable" : gridW > 0 ? "import" : gridW < 0 ? "export" : "balanced";

  return <div className={`smart-meter meter-${direction}${detected ? "" : " is-unavailable"}`}>
    <div className="chart-head unified-head meter-head">
      <div className="card-title"><IconGrid size={17} /><h2>Smart Meter</h2></div>
      <span className="meter-status">
        {!detected ? "No Smart Meter detected" : stale ? "Last measured readings" : "Live: measured at grid connection"}
      </span>
    </div>
    <div className="meter-exchange" aria-label={detected ? "Measured grid readings" : "Grid readings unavailable"}>
      <div className={`meter-reading meter-import${gridW !== null && gridW > 0 ? " is-active" : ""}`}>
        <span><IconArrowOut className="meter-import-arrow" size={17} />From grid</span>
        <strong>{gridW === null ? "--" : formatW(Math.max(0, gridW))}</strong>
        <small>Import</small>
      </div>
      <div className="meter-connection">
        <div className="meter-route" aria-hidden="true"><IconGrid size={24} />
          <span className="meter-route-track">{gridW !== null && gridW !== 0 && <IconArrowOut size={19} />}</span>
          <IconHome size={24} />
        </div>
        <span>{stale && detected ? `Last state: ${status.toLowerCase()}` : status}</span>
      </div>
      <div className={`meter-reading meter-export${gridW !== null && gridW < 0 ? " is-active" : ""}`}>
        <span><IconArrowOut size={17} />To grid</span>
        <strong>{gridW === null ? "--" : formatW(Math.max(0, -gridW))}</strong>
        <small>Export</small>
      </div>
    </div>
    <div className="meter-totals">
      <div><span>Whole-home load</span><strong>{homeW === null ? "--" : formatW(homeW)}</strong></div>
      <div title="Daily meter totals are not available yet">
        <span>Imported today</span><strong>--</strong>
      </div>
      <div title="Daily meter totals are not available yet">
        <span>Exported today</span><strong>--</strong>
      </div>
    </div>
  </div>;
}