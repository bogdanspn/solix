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
import { mainsInputW } from "./derive.ts";
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
  const mains = mainsInputW(snapshot);
  const [mainsV, mainsU] = split(mains ?? 0);

  return (
    <>
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
              : "AC output"
          }
          value={gridV}
          unit={gridU}
          title={
            snapshot.gridMeasured
              ? undefined
              : "Without a Smart Meter this is not a grid reading. It mirrors the AC output: what the Solarbank sends to the house, not what crosses the meter."
          }
        />
        {mains !== null && (
          <Row
            icon={<IconGrid size={17} />}
            color="var(--grid-series)"
            label="AC input"
            value={mainsV}
            unit={mainsU}
            title="House load the Solarbank is not covering, so it comes off the mains. At the discharge floor that is the whole of it."
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
    </>
  );
}
