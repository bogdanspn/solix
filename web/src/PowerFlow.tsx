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
const H = 600;
const CX = W / 2;
const CY = 430;

const HUB_R = 112;
const NODE_R = 64;
const ORBIT = 205;

const SUPPLY_Y = CY - 292;
const SUPPLY_DX = 92;
/** Half way between the hub and the supply row, and drawn in closer. */
const SIDE_Y = (SUPPLY_Y + CY) / 2;
const SIDE_LEFT = { x: CX - ORBIT, y: SIDE_Y };
const SIDE_RIGHT = { x: CX + ORBIT, y: SIDE_Y };
/** Height of the horizontal run into the hub's flank. */
const SIDE_ENTRY_Y = CY + 10;
/** Where the supply branches turn inward, between node and hub. */
const SUPPLY_TURN_Y = CY - HUB_R - 62;
/** Half the gap between the two stubs entering the top of the hub. */
const STEM_DX = 16;

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
  at?: { x: number; y: number };
  curved?: boolean;
}

/**
 * An orthogonal run: straight segments joined by quarter-round corners.
 *
 * Each corner is a quadratic with the corner itself as the control point,
 * which reads as a true fillet on a right angle. The radius is clamped to
 * half the shorter of the two runs meeting there, so a tight pair of turns
 * cannot overshoot into one another.
 */
function elbow(points: Array<[number, number]>, radius = 22): string {
  // Collapsed segments would divide by zero when a branch happens to be
  // straight - which is exactly the unpaired supply case.
  const pts = points.filter(
    (p, i) => i === 0 || Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1]) > 0.01,
  );
  if (pts.length < 2) return "";

  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!;
    const [cx, cy] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    d +=
      ` L ${cx + ((px - cx) / inLen) * r} ${cy + ((py - cy) / inLen) * r}` +
      ` Q ${cx} ${cy} ${cx + ((nx - cx) / outLen) * r} ${cy + ((ny - cy) / outLen) * r}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last[0]} ${last[1]}`;
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
  const at = link.at ?? pos(node.angle);
  const rad = (node.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);

  // Out of the hub's flank, along, then a single turn up to the node's foot.
  const side = at.x < CX ? -1 : 1;
  const d = link.curved
    ? elbow([
        [CX + side * (HUB_R + 8), SIDE_ENTRY_Y],
        [at.x, SIDE_ENTRY_Y],
        [at.x, at.y + NODE_R + 8],
      ])
    : `M ${CX + ux * (HUB_R + 10)} ${CY + uy * (HUB_R + 10)} ` +
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
  // Each branch drops, turns inward, and drops again into the top of the hub,
  // so the two arrive as a parallel pair. They used to merge into one stem,
  // which meant a shared wire that could only be one colour and one speed;
  // kept apart, each carries its own flow the whole way in.
  const branch = (from: { x: number; y: number }, side: number) =>
    elbow([
      [from.x, from.y + NODE_R + 8],
      [from.x, SUPPLY_TURN_Y],
      [CX + side * STEM_DX, SUPPLY_TURN_Y],
      [CX + side * STEM_DX, CY - HUB_R - 6],
    ]);

  return (
    <g>
      <Wire d={branch(solarAt, paired ? -1 : 0)} color={NODES.solar.color} watts={solarW} />
      {paired && <Wire d={branch(inputAt, 1)} color={NODES.acin.color} watts={inputW} />}
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
    // Solar lives in the supply row in both modes, so it is not a link here.
    ...(gridMeasured
      ? [{ node: "grid" as const, watts: gridW, inbound: gridW > 0, at: SIDE_LEFT, curved: true }]
      : [{ node: "acout" as const, watts: snapshot.acOutW, inbound: false, at: SIDE_LEFT, curved: true }]),
    { node: "home", watts: homeKnown ? homeW : 0, inbound: false, at: SIDE_RIGHT, curved: true },
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

        <AcInterfaces solarW={solarTotal} inputW={fromMains} />
        {links.map((l) => (
          <LinkPath key={l.node} link={l} />
        ))}

        <circle cx={CX} cy={CY} r={HUB_R} fill="var(--node-fill)" stroke="var(--hairline)" strokeWidth={1} />
        <Ticks soc={soc} />

        <g style={{ color: "var(--battery)" }}>
          <IconBattery size={16} x={CX - 8} y={CY - 81} />
        </g>
        <text x={CX} y={CY - 47} textAnchor="middle" className="hub-system" fill="var(--text-muted)">
          SOLARBANK
        </text>
        <text x={CX} y={CY} textAnchor="middle" className="hub-value" fill="var(--text-primary)">
          {soc}
          <tspan className="hub-unit" fill="var(--text-muted)">
            %
          </tspan>
        </text>
        <text x={CX} y={CY + 27} textAnchor="middle" className="hub-sub" fill="var(--text-secondary)">
          {formatKwh(storedKwh)}
        </text>
        <text x={CX} y={CY + 47} textAnchor="middle" className="hub-status" fill="var(--text-muted)">
          {batteryStatus} · {formatW(Math.abs(batteryW))}
        </text>
        {etaText && (
          <text x={CX} y={CY + 69} textAnchor="middle" className="hub-eta" fill="var(--text-muted)">
            {etaText}
          </text>
        )}

        {gridMeasured ? (
          <Node
            nodeKey="grid"
            watts={gridW}
            sub={gridW >= 0 ? "Smart Meter · import" : "Smart Meter · export"}
            at={SIDE_LEFT}
          />
        ) : (
          <Node nodeKey="acout" watts={snapshot.acOutW} at={SIDE_LEFT} />
        )}
        <Node
          nodeKey="home"
          watts={homeKnown ? homeW : null}
          sub={homeSource === "sockets" ? "sockets" : homeSource === "meter" ? "metered" : "no meter"}
          at={SIDE_RIGHT}
        />
      </svg>
    </div>
  );
}
