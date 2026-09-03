import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryResponse } from "../../server/types.ts";
import { axisTimeFormatter, formatFullTime, formatKwh, formatSpan, formatW } from "./format.ts";
import { IconChart } from "./Icons.tsx";

type Range = "day" | "week" | "month";

/**
 * Grid is dotted on purpose. While the battery discharges straight to the AC
 * output the two carry the same value and draw on top of each other, so the
 * break lets both read at once -- and doubles as secondary encoding for the
 * colour-vision case.
 *
 * Zero-length dashes with a round cap render as dots rather than the blunt
 * rectangles a plain dash array gives.
 */
const SERIES = [
  { key: "pvW", label: "Solar", color: "var(--solar)", dotted: false },
  { key: "batteryW", label: "Battery", color: "var(--battery)", dotted: false },
  { key: "loadW", label: "Home", color: "var(--home)", dotted: false },
  { key: "gridW", label: "Grid", color: "var(--grid-series)", dotted: true },
] as const;

interface TooltipPayloadItem {
  dataKey?: string | number;
  value?: number;
}

function PowerTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="t-time">{formatFullTime(Number(label))}</div>
      {SERIES.map((s) => {
        const hit = payload.find((p) => p.dataKey === s.key);
        if (!hit || hit.value === undefined) return null;
        return (
          <div className="t-row" key={s.key}>
            <span className="swatch" style={{ background: s.color }} />
            <span>{s.label}</span>
            <b>{formatW(hit.value)}</b>
          </div>
        );
      })}
    </div>
  );
}

function SocTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="t-time">{formatFullTime(Number(label))}</div>
      <div className="t-row">
        <span>Charge</span>
        <b>{Math.round(payload[0]?.value ?? 0)}%</b>
      </div>
    </div>
  );
}

/** Axis labels in kW, without a trailing ".0" on whole values. */
function formatKw(v: number): string {
  const kw = v / 1000;
  return `${Number.isInteger(kw) ? kw : kw.toFixed(1)} kW`;
}

const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--text-muted)", fontSize: 11 },
  tickLine: false,
};

export function HistoryCharts() {
  const [range, setRange] = useState<Range>("day");
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/history?range=${range}`)
      .then((r) => r.json())
      .then((d: HistoryResponse) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => !cancelled && setLoading(false));

    // Refresh on the sample cadence; the chart does not need live updates.
    const id = setInterval(() => {
      fetch(`/api/history?range=${range}`)
        .then((r) => r.json())
        .then((d: HistoryResponse) => !cancelled && setData(d))
        .catch(() => {});
    }, 60_000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [range]);

  const points = data?.points ?? [];
  const totals = data?.totals;

  // Label the axis from the span the samples actually cover. A 30-day view
  // holding two hours of data was printing the same date on every tick.
  const spanMs =
    points.length > 1 ? (points[points.length - 1]?.ts ?? 0) - (points[0]?.ts ?? 0) : 0;
  const tickFormat = axisTimeFormatter(spanMs);

  const RANGE_MS = { day: 24, week: 7 * 24, month: 30 * 24 } as const;
  const partial = spanMs > 0 && spanMs < RANGE_MS[range] * 3600_000 * 0.9;

  return (
    <>
      <div className="chart-head">
        <div className="card-title">
          <IconChart size={17} />
          <h2>History</h2>
        </div>
        <div className="range-tabs">
          {(["day", "week", "month"] as Range[]).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r === "day" ? "24h" : r === "week" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
      </div>

      {points.length < 2 ? (
        <div className="empty">
          {loading
            ? "Loading…"
            : "Not enough history yet. The dashboard records a sample every 30 seconds. " +
              "check back in a few minutes, and the daily and weekly views will fill in as it runs."}
        </div>
      ) : (
        <>
          {totals && (
            <div className="energy-row">
              <div className="energy-stat">
                <div className="k">
                  <span className="swatch" style={{ background: "var(--solar)" }} />
                  Solar generated
                </div>
                <div className="v">{formatKwh(totals.pvKwh)}</div>
              </div>
              <div className="energy-stat">
                <div className="k">
                  <span className="swatch" style={{ background: "var(--battery)" }} />
                  Battery charged
                </div>
                <div className="v">{formatKwh(totals.chargeKwh)}</div>
              </div>
              <div className="energy-stat">
                <div className="k">
                  <span className="swatch" style={{ background: "var(--battery)", opacity: 0.5 }} />
                  Battery discharged
                </div>
                <div className="v">{formatKwh(totals.dischargeKwh)}</div>
              </div>
            </div>
          )}

          {/* Power. Every series is direct-labelled in the legend, which is the
              relief the light-mode contrast warning requires. */}
          <div className="legend">
            {SERIES.map((s) => (
              <span className="legend-item" key={s.key}>
                <span
                  className={`swatch ${s.dotted ? "is-dotted" : ""}`}
                  style={{ background: s.color }}
                />
                {s.label}
              </span>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={points} margin={{ top: 14, right: 10, bottom: 0, left: -4 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={tickFormat}
                minTickGap={64}
                {...axisProps}
              />
              <YAxis tickFormatter={formatKw} width={58} {...axisProps} />
              <Tooltip content={<PowerTooltip />} cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }} />
              <ReferenceLine y={0} stroke="var(--axis)" strokeWidth={1} />
              {SERIES.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={s.dotted ? 2.6 : 2}
                  strokeDasharray={s.dotted ? "0.001 7" : undefined}
                  strokeLinecap={s.dotted ? "round" : "butt"}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>

          {/* State of charge lives in its own chart: a percentage and watts on
              one pair of axes would be a dual-axis chart. */}
          <h2 className="eyebrow soc-heading">State of charge</h2>
          <ResponsiveContainer width="100%" height={130}>
            <LineChart data={points} margin={{ top: 14, right: 10, bottom: 0, left: -4 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={tickFormat}
                minTickGap={64}
                {...axisProps}
              />
              <YAxis domain={[0, 100]} width={58} tickFormatter={(v: number) => `${v}%`} {...axisProps} />
              <Tooltip content={<SocTooltip />} cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }} />
              <Line
                type="monotone"
                dataKey="soc"
                stroke="var(--battery)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>

          {partial && (
            <p className="range-note is-foot">
              Only {formatSpan(spanMs)} of history so far. The full range fills in as the dashboard
              keeps running.
            </p>
          )}
        </>
      )}
    </>
  );
}
