import type { EnergyTotals, Snapshot } from "../../server/types.ts";
import {
  IconBattery,
  IconGrid,
  IconHeart,
  IconHome,
  IconSun,
  IconThermometer,
  IconWave,
} from "./Icons.tsx";
import { netAcOutputW } from "./derive.ts";
import { formatW } from "./format.ts";

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
  const [solarV, solarU] = split(snapshot.pvW + snapshot.thirdPartyPvW);
  const [batV, batU] = split(snapshot.batteryW);
  const [homeV, homeU] = split(snapshot.homeW);
  const [gridV, gridU] = split(snapshot.gridW);
  const homeKnown = snapshot.homeSource !== "none";
  const netAc = netAcOutputW(snapshot);
  const [netAcV, netAcU] = split(netAc ?? 0);

  const pv = today.pvKwh;
  const charge = today.chargeKwh;
  // Charging beyond what the array made can only have come off the mains, so
  // the stored figure is clamped and the excess named rather than folded in.
  const stored = Math.min(charge, pv);
  const direct = Math.max(0, pv - charge);
  const fromGrid = Math.max(0, charge - pv);
  const socketsKwh = snapshot.plugs.reduce((sum, p) => sum + p.todayKwh, 0);

  return (
    <div className="readings">
      <h2 className="eyebrow">Right now</h2>

      <div className="rows">
        <Row icon={<IconSun size={17} />} color="var(--solar)" label="Solar" value={solarV} unit={solarU} />
        <Row
          icon={<IconBattery size={17} />}
          color="var(--battery)"
          label={snapshot.batteryW >= 0 ? "Battery charging" : "Battery discharging"}
          value={batV}
          unit={batU}
        />
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

      <h2 className="eyebrow">Today</h2>
      <div className="cells">
        <Cell label="Out" value={today.dischargeKwh.toFixed(1)} unit="kWh" />
        <Cell label="In" value={today.chargeKwh.toFixed(1)} unit="kWh" />
        <Cell label="Solar" value={today.pvKwh.toFixed(1)} unit="kWh" />
      </div>

      {/* Frequency and voltage were confirmed live by sampling; temperature and
          health decode plausibly but are unproven, so they are marked. */}
      <h2 className="eyebrow">System</h2>
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
        <Cell label="Capacity" value={(device?.ratedKwh ?? 0).toFixed(1)} unit="kWh" />
        {device && device.packs > 0 && (
          <Cell
            label="Packs"
            value={String(device.packs)}
            unit={device.packs > 1 ? `base +${device.packs - 1}` : "base"}
            inferred
          />
        )}
      </div>

      {pv > 0.05 && (
        <div className="destination">
          <h2 className="eyebrow">Where today&rsquo;s solar went</h2>
          <div className="dest-bar">
            {stored > 0 && (
              <span
                className="dest-seg is-stored"
                style={{ flexGrow: stored }}
                title={`${stored.toFixed(1)} kWh charged into the battery`}
              />
            )}
            {direct > 0 && (
              <span
                className="dest-seg is-direct"
                style={{ flexGrow: direct }}
                title={`${direct.toFixed(1)} kWh generated but not stored`}
              />
            )}
          </div>
          <div className="dest-keys">
            <span className="dest-key">
              <i className="is-stored" />
              Stored <b>{stored.toFixed(1)}</b> kWh
            </span>
            <span className="dest-key">
              <i className="is-direct" />
              Not stored <b>{direct.toFixed(1)}</b> kWh
            </span>
          </div>
          <p className="dest-note">
            {fromGrid > 0.05
              ? `A further ${fromGrid.toFixed(1)} kWh went into the battery from the mains: charging exceeded what the array made.`
              : `Not stored means it went to the house or was left on the table. Sockets measured ${socketsKwh.toFixed(1)} kWh today.`}
          </p>
        </div>
      )}
    </div>
  );
}
