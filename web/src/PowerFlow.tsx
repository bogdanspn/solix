import type { Snapshot } from "../../server/types.ts";
import { mainsInputW } from "./derive.ts";
import { formatDuration, formatKwh, formatW } from "./format.ts";
import { IconBattery, IconGrid, IconHome, IconSun } from "./Icons.tsx";

/**
 * Power flow with the state-of-charge gauge as the hub.
 *
 * The gauge used to live in a separate card, which meant the same percentage
 * was printed twice on one screen. Here it is the centre of the diagram, which
 * is also where it belongs -- everything flows through the battery.
 */

const W = 640;
const H = 700;
const CX = W / 2;
const CY = 350;

const HUB_R = 96;
const NODE_R = 56;
const ORBIT = 242;

const SUPPLY_Y = CY - 292;
const SUPPLY_DX = 78;
const JUNCTION_Y = (SUPPLY_Y + NODE_R + 10 + (CY - HUB_R - 10)) / 2;

const NODES = {
  solar: { angle: -90, label: "Solar", color: "var(--solar)", Icon: IconSun },
  acin: { angle: -90, label: "AC input", color: "var(--grid-series)", Icon: IconGrid },
  home: { angle: 0, label: "Home", color: "var(--home)", Icon: IconHome },
  battery: { angle: 90, label: "Battery", color: "var(--battery)", Icon: IconBattery },
  acout: { angle: 180, label: "AC output", color: "var(--grid-series)", Icon: IconGrid },
  grid: { angle: 180, label: "Grid", color: "var(--grid-series)", Icon: IconGrid },
};

type NodeKey = keyof typeof NODES;

const pos = (angle: number) => ({
  x: CX + Math.cos((angle * Math.PI) / 180) * ORBIT,
  y: CY + Math.sin((angle * Math.PI) / 180) * ORBIT,
});

interface Link {
  node: NodeKey;
  watts: number;
  /** true when energy moves from the node into the hub. */
  inbound: boolean;
}

/**
 * A run of wire: the dim track it follows, and the dashes that move along it
 * when something is flowing. Direction rides in the animation shorthand -
 * setting animationDirection beside it is React's "conflicting property"
 * warning, and the two can be applied in either order on a rerender.
 */
function Wire({
  d,
  color,
  watts,
  reverse = false,
}: {
  d: string;
  color: string;
  watts: number;
  reverse?: boolean;
}) {
  const active = Math.abs(watts) >= 5;
  // 1500 W saturates the speed scale; below that faster flow reads as faster.
  const speed = Math.max(0.65, 2.3 - (Math.abs(watts) / 1500) * 1.7);

  return (
    <g>
      <path d={d} stroke="var(--track)" strokeWidth={2} fill="none" strokeLinecap="round" />
      {active && (
        <path
          d={d}
          stroke={color}
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
          strokeDasharray="5 13"
          style={{ animation: `flow ${speed}s linear infinite ${reverse ? "reverse" : "normal"}` }}
        />
      )}
    </g>
  );
}

function LinkPath({ link }: { link: Link }) {
  const node = NODES[link.node];
  const rad = (node.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);

  const d =
    `M ${CX + ux * (HUB_R + 10)} ${CY + uy * (HUB_R + 10)} ` +
    `L ${CX + ux * (ORBIT - NODE_R - 10)} ${CY + uy * (ORBIT - NODE_R - 10)}`;

  // The path runs hub -> node, so an inbound flow plays it backwards.
  return <Wire d={d} color={node.color} watts={link.watts} reverse={link.inbound} />;
}

function Node({
  nodeKey,
  watts,
  sub,
  at,
}: {
  nodeKey: NodeKey;
  watts: number | null;
  sub?: string;
  at?: { x: number; y: number };
}) {
  const node = NODES[nodeKey];
  const { x, y } = at ?? pos(node.angle);
  const active = watts !== null && Math.abs(watts) >= 5;
  const { Icon } = node;

  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={NODE_R} fill="var(--node-fill)" stroke="var(--hairline)" strokeWidth={1} />
      {active && <circle r={NODE_R} fill="none" stroke={node.color} strokeWidth={1.5} opacity={0.7} />}
      <g transform="translate(-9 -32)" style={{ color: active ? node.color : "var(--text-muted)" }}>
        <Icon size={18} />
      </g>
      <text
        y={3}
        textAnchor="middle"
        className="flow-value"
        fill={active ? "var(--text-primary)" : "var(--text-muted)"}
      >
        {watts === null ? "—" : formatW(Math.abs(watts))}
      </text>
      <text y={23} textAnchor="middle" className="flow-sub" fill="var(--text-muted)">
        {sub ?? node.label}
      </text>
    </g>
  );
}

/** Ticked ring around the hub. Ticks, not a smooth arc: 52% and 58% must differ. */
function Ticks({ soc }: { soc: number }) {
  const TICKS = 60;
  const SWEEP = 280;
  const START = 130;
  const lit = Math.round((soc / 100) * TICKS);
  // Breathing room between the ring and the ticks.
  const outer = HUB_R - 12;
  const inner = HUB_R - 24;

  return (
    <g>
      {Array.from({ length: TICKS }, (_, i) => {
        const a = ((START + (i / (TICKS - 1)) * SWEEP) * Math.PI) / 180;
        const on = i < lit;
        return (
          <line
            key={i}
            x1={CX + Math.cos(a) * inner}
            y1={CY + Math.sin(a) * inner}
            x2={CX + Math.cos(a) * outer}
            y2={CY + Math.sin(a) * outer}
            stroke={on ? "var(--accent)" : "var(--track)"}
            strokeWidth={2}
            strokeLinecap="round"
          />
        );
      })}
    </g>
  );
}

/**
 * Socket mode exposes the Solarbank's own AC interfaces. Input is derived
 * from the socket total minus output, while output is measured directly.
 * Once a Smart Meter is present, this pair gives way to its true grid flow.
 */
function AcInterfaces({ solarW, inputW }: { solarW: number; inputW: number | null }) {
  const paired = inputW !== null;
  const solarAt = { x: paired ? CX - SUPPLY_DX : CX, y: SUPPLY_Y };
  const inputAt = { x: CX + SUPPLY_DX, y: SUPPLY_Y };
  const branch = (from: { x: number; y: number }) => {
    const y0 = from.y + NODE_R + 10;
    const drop = JUNCTION_Y - y0;
    return (
      `M ${from.x} ${y0} ` +
      `C ${from.x} ${y0 + drop * 0.55}, ${CX} ${JUNCTION_Y - drop * 0.5}, ${CX} ${JUNCTION_Y}`
    );
  };
  const total = solarW + (inputW ?? 0);
  const stemColor = (inputW ?? 0) > solarW ? NODES.acin.color : NODES.solar.color;

  return (
    <g>
      <Wire d={branch(solarAt)} color={NODES.solar.color} watts={solarW} />
      {paired && <Wire d={branch(inputAt)} color={NODES.acin.color} watts={inputW} />}
      <Wire
        d={`M ${CX} ${JUNCTION_Y} L ${CX} ${CY - HUB_R - 10}`}
        color={stemColor}
        watts={total}
      />
      <Node nodeKey="solar" watts={solarW} at={solarAt} />
      {paired && <Node nodeKey="acin" watts={inputW} at={inputAt} />}
    </g>
  );
}

export function PowerFlow({ snapshot, ratedKwh }: { snapshot: Snapshot; ratedKwh: number }) {
  const { pvW, thirdPartyPvW, batteryW, gridW, soc, batteryStatus, homeW, homeSource, gridMeasured } =
    snapshot;

  const { eta } = snapshot;
  // Framed as "at this rate": it extrapolates the recent average, it does not
  // model what the sun will do next.
  const etaText =
    eta.minutes === null
      ? null
      : `${eta.direction === "charge" ? "↑" : "↓"} ${eta.targetSoc}% in ${formatDuration(eta.minutes)}`;

  const solarTotal = pvW + thirdPartyPvW;
  const homeKnown = homeSource !== "none";
  const storedKwh = (soc / 100) * ratedKwh;

  const fromMains = mainsInputW(snapshot);

  const links: Link[] = [
    // batteryW > 0 is charging, i.e. hub -> battery.
    { node: "battery", watts: batteryW, inbound: batteryW < 0 },
      ...(gridMeasured
        ? [
            { node: "solar" as const, watts: solarTotal, inbound: true },
            { node: "grid" as const, watts: gridW, inbound: gridW > 0 },
          ]
        : [{ node: "acout" as const, watts: snapshot.acOutW, inbound: false }]),
    { node: "home", watts: homeKnown ? homeW : 0, inbound: false },
  ];

  return (
    <div className="flow-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block" }}
        role="img"
        aria-label={
          `Battery ${soc} percent, ${batteryStatus} at ${formatW(Math.abs(batteryW))}. ` +
          `Solar ${formatW(solarTotal)}. Home ${homeKnown ? formatW(homeW) : "not measured"}. ` +
          (gridMeasured
            ? `Grid ${gridW >= 0 ? "importing" : "exporting"} ${formatW(Math.abs(gridW))}.`
            : fromMains !== null
              ? `AC input ${formatW(fromMains)}, derived from socket measurements. AC output ${formatW(Math.abs(snapshot.acOutW))}.`
              : "Grid flow is not measured.")
        }
      >
        <defs>
          <radialGradient id="hub-glow">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.14" />
            <stop offset="65%" stopColor="var(--accent)" stopOpacity="0.03" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={CX} cy={CY} r={ORBIT} fill="url(#hub-glow)" />

        {!gridMeasured && <AcInterfaces solarW={solarTotal} inputW={fromMains} />}
        {links.map((l) => (
          <LinkPath key={l.node} link={l} />
        ))}

        <circle cx={CX} cy={CY} r={HUB_R} fill="var(--node-fill)" stroke="var(--hairline)" strokeWidth={1} />
        <Ticks soc={soc} />

        <text x={CX} y={CY - 10} textAnchor="middle" className="hub-value" fill="var(--text-primary)">
          {soc}
          <tspan className="hub-unit" fill="var(--text-muted)">
            %
          </tspan>
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" className="hub-sub" fill="var(--text-secondary)">
          {formatKwh(storedKwh)}
        </text>
        <text x={CX} y={CY + 31} textAnchor="middle" className="hub-status" fill="var(--text-muted)">
          {batteryStatus}
        </text>
        <text x={CX} y={CY - 48} textAnchor="middle" className="hub-system" fill="var(--text-muted)">
          SOLARBANK
        </text>
        {etaText && (
          <text x={CX} y={CY + 48} textAnchor="middle" className="hub-eta" fill="var(--text-muted)">
            {etaText}
          </text>
        )}

        {gridMeasured && <Node nodeKey="solar" watts={solarTotal} />}
        {gridMeasured ? (
          <Node nodeKey="grid" watts={gridW} sub={gridW >= 0 ? "Smart Meter · import" : "Smart Meter · export"} />
        ) : (
          <Node nodeKey="acout" watts={snapshot.acOutW} />
        )}
        <Node
          nodeKey="home"
          watts={homeKnown ? homeW : null}
          sub={homeSource === "sockets" ? "sockets" : homeSource === "meter" ? "metered" : "no meter"}
        />
        <Node nodeKey="battery" watts={batteryW} sub={batteryStatus} />
      </svg>
    </div>
  );
}
