import { useCallback, useState } from "react";
import { Modal } from "./Modal.tsx";
import type { EnergyTotals, Snapshot } from "../../server/types.ts";
import {
  IconBattery,
  IconGrid,
  IconHeart,
  IconHome,
  IconInfo,
  IconSun,
  IconThermometer,
  IconWave,
} from "./Icons.tsx";
import { netAcOutputW } from "./derive.ts";
import { formatDuration, formatEnergy, formatW } from "./format.ts";

function split(w: number): [string, string] {
  const text = formatW(Math.abs(w));
  const [value = text, unit = ""] = text.split(" ");
  return [value, unit];
}

function Row({
  icon,
  color,
  label,
  value,
  unit,
  title,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: string;
  unit?: string;
  title?: string;
}) {
  return (
    <div className="row" title={title}>
      <span className="row-ico" style={{ color }}>
        {icon}
      </span>
      <span className="row-label">{label}</span>
      <span className="row-value">
        {value}
        {unit && <em>{unit}</em>}
      </span>
    </div>
  );
}

function Cell({
  icon,
  label,
  value,
  unit,
  inferred,
  title,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  unit: string;
  inferred?: boolean;
  title?: string;
}) {
  return (
    <div className="cell">
      <div className="cell-k">
        {icon}
        {label}
      </div>
      <div className="cell-v">
        {inferred ? (
          <span className="inferred" title={title ?? "Undocumented register; decode inferred, not verified"}>
            {value}
          </span>
        ) : (
          value
        )}
        <em>{unit}</em>
      </div>
    </div>
  );
}

export function Readings({
  snapshot,
  today,
  device,
}: {
  snapshot: Snapshot;
  today: EnergyTotals;
  device: { ratedKwh: number; packs: number } | null;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  const [solarV, solarU] = split(snapshot.pvW + snapshot.thirdPartyPvW);
  const [homeV, homeU] = split(snapshot.homeW);
  const [gridV, gridU] = split(snapshot.gridW);
  const homeKnown = snapshot.homeSource !== "none";
  const netAc = netAcOutputW(snapshot);
  const [netAcV, netAcU] = split(netAc ?? 0);

  const soc = Math.max(0, Math.min(100, snapshot.soc));
  const floor = snapshot.settings.dischargeLimitSoc;
  const charging = snapshot.batteryW > 0;
  const status = snapshot.batteryW === 0 ? "Idle" : charging ? "Charging" : "Discharging";
  const etaMatches = snapshot.batteryW !== 0 && snapshot.eta.direction === (charging ? "charge" : "discharge");

  return (
    <div className="readings battery-overview">
      <div className="chart-head"><div className="card-title"><IconBattery size={17} /><h2>Battery</h2></div><span className="sub-total">{device ? `${device.ratedKwh.toFixed(1)} kWh capacity` : "Capacity unavailable"}</span></div>
      <div className="battery-overview-level">
        <strong>{Math.round(soc)}<small>%</small></strong>
        <div><span>{snapshot.online ? status : "Last reading"}</span><b>{formatW(Math.abs(snapshot.batteryW))}</b></div>
      </div>
      <div className="battery-reserve-track" role="meter" aria-label="Battery charge" aria-valuemin={0} aria-valuemax={100} aria-valuenow={soc}>
        <span style={{ width: `${soc}%` }} />
        <i style={{ left: `${Math.max(0, Math.min(100, floor))}%` }} />
      </div>
      <div className="battery-limits"><span>Minimum {floor}%</span><span>Charge limit {snapshot.settings.chargingLimitSoc}%</span></div>
      <p className="battery-outlook">
        {!snapshot.online || snapshot.staleSeconds > 20 ? "Waiting for current readings"
          : snapshot.eta.minutes !== null && etaMatches
            ? `${snapshot.eta.targetSoc}% in about ${formatDuration(snapshot.eta.minutes)}`
            : "No reliable time estimate"}
        {snapshot.online && snapshot.staleSeconds <= 20 && etaMatches && charging && snapshot.eta.minutes !== null && snapshot.eta.beforeSunset === false && <span>At this rate, after sunset</span>}
      </p>
      <div className="battery-power-readings">
      <div className="rows">
        <Row icon={<IconSun size={17} />} color="var(--solar)" label="Solar" value={solarV} unit={solarU} />
        <Row
          icon={<IconHome size={17} />}
          color="var(--home)"
          label={homeKnown ? "Home" : "Home · no meter"}
          value={homeKnown ? homeV : "—"}
          unit={homeKnown ? homeU : undefined}
        />
        <Row
          icon={<IconGrid size={17} />}
          color="var(--grid-series)"
          label={
            snapshot.gridMeasured
              ? snapshot.gridW >= 0
                ? "Grid import"
                : "Grid export"
              : "Solarbank AC output"
          }
          value={snapshot.gridMeasured ? gridV : split(snapshot.acOutW)[0]}
          unit={snapshot.gridMeasured ? gridU : split(snapshot.acOutW)[1]}
          title={
            snapshot.gridMeasured
              ? undefined
              : "Raw Solarbank AC output. With socket compensation enabled, it includes measured socket use and is not a direct grid reading."
          }
        />
        {netAc !== null && (
          <Row
            icon={<IconGrid size={17} />}
            color="var(--grid-series)"
            label={netAc >= 0 ? "Net AC output" : "Net AC input"}
            value={netAcV}
            unit={netAcU}
            title="Calculated as Solarbank AC output minus the measured socket load. A Smart Meter replaces this estimate with direct grid flow."
          />
        )}
      </div>

      </div>
      <div className="battery-day-totals">
        <div><span>Charged today</span><strong>{formatEnergy(today.chargeKwh)}</strong></div>
        <div><span>Discharged today</span><strong>{formatEnergy(today.dischargeKwh)}</strong></div>
      </div>
      <button className="detail-trigger" onClick={() => setDetailsOpen(true)} aria-haspopup="dialog">System details <IconInfo size={16} /></button>
      <Modal open={detailsOpen} title="System details" onClose={closeDetails}>
      <div className="system-details">
      {/* Frequency and voltage were confirmed live by sampling; temperature and
          health decode plausibly but are unproven, so they are marked. */}
      <h3 className="eyebrow">Electrical &amp; device</h3>
      <div className="cells">
        <Cell icon={<IconWave size={12} />} label="Frequency" value={snapshot.gridHz.toFixed(2)} unit="Hz" />
        <Cell icon={<IconGrid size={12} />} label="Voltage" value={snapshot.acVolts.toFixed(1)} unit="V" />
        <Cell
          icon={<IconThermometer size={12} />}
          label="Temp"
          value={snapshot.batteryTempC.toFixed(1)}
          unit="°C"
          inferred
        />
        <Cell
          icon={<IconHeart size={12} />}
          label="Health"
          value={String(snapshot.batteryHealth)}
          unit="%"
          inferred
        />
        <Cell label="Max from grid" value={(snapshot.gridImportLimitW / 1000).toFixed(1)} unit="kW" />
        <Cell label="Max to grid" value={(snapshot.gridExportLimitW / 1000).toFixed(1)} unit="kW" />
        <Cell label="Capacity" value={device ? device.ratedKwh.toFixed(1) : "--"} unit="kWh" />
        {device && device.packs > 0 && (
          <Cell
            label="Packs"
            value={String(device.packs)}
            unit={device.packs > 1 ? `base +${device.packs - 1}` : "base"}
            inferred
          />
        )}
      </div>

      </div>
      </Modal>
    </div>
  );
}
