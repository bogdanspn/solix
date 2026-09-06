import { useEffect, useId, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Legend,
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
import { IconChart, IconDownload, IconNext, IconPrevious, IconRefresh } from "./Icons.tsx";
import { isBoolean, usePreference } from "./preferences.ts";
import { downloadJson, localDate } from "./download.ts";
import { Modal } from "./Modal.tsx";

type Range = "day" | "week" | "month";
const BUCKET_MS = { day: 300_000, week: 3600_000, month: 21_600_000 } as const;

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
  value?: number | null;
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
        if (!hit || hit.value == null) return null;
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
  if (!active || !payload?.length || payload[0]?.value == null) return null;
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
  const chartId = useId();
  const [eventsOpen, setEventsOpen] = useState(false);
  const [range, setRange] = usePreference<Range>("solix-history-range", "day", (value): value is Range => value === "day" || value === "week" || value === "month");
  const [end, setEnd] = useState<number | null>(null);
  const [compare, setCompare] = usePreference("solix-history-compare", false, isBoolean);
  const [selection, setSelection] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const [backendRequired, setBackendRequired] = useState(false);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState<Set<string>>(() => new Set(SERIES.map((series) => series.key)));

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setData(null);
    setSelection(null);
    setBackendRequired(false);
    const refresh = async () => {
      try {
        const response = await fetch(`/api/history?range=${range}${end === null ? "" : `&end=${end}`}`, { signal: controller.signal });
        if (!response.ok) throw new Error("History unavailable");
        const next: HistoryResponse = await response.json();
        if (end !== null && (!next.window || Math.abs(next.window.end - end) > 1000)) {
          if (!cancelled) setBackendRequired(true);
          throw new Error("Backend update required");
        }
        if (!cancelled) {
          setData(next);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [range, retry, end]);

  const points = data?.points ?? [];
  const allChartPoints = points.flatMap((point, index) => {
    const previous = points[index - 1];
    return previous && point.ts - previous.ts > BUCKET_MS[range] * 1.5
      ? [{ ts: previous.ts + BUCKET_MS[range], pvW: null, batteryW: null, loadW: null, gridW: null, soc: null }, point]
      : [point];
  });
  const chartPoints = selection ? allChartPoints.slice(selection.startIndex, selection.endIndex + 1) : allChartPoints;
  const totals = data?.totals;
  const today = data?.today;

  // Label the axis from the span the samples actually cover. A 30-day view
  // holding two hours of data was printing the same date on every tick.
  const spanMs =
    points.length > 1 ? (points[points.length - 1]?.ts ?? 0) - (points[0]?.ts ?? 0) : 0;
  const selectedSpan = (chartPoints.at(-1)?.ts ?? 0) - (chartPoints[0]?.ts ?? 0);
  const tickFormat = axisTimeFormatter(selectedSpan);
  const tickStep = [0.25, 0.5, 1, 3, 6, 12, 24, 48, 168, 336].find((hours) => selectedSpan / (hours * 3600_000) <= 6)! * 3600_000;
  const firstTick = Math.ceil((chartPoints[0]?.ts ?? 0) / tickStep) * tickStep;
  const ticks = Array.from({ length: 7 }, (_, index) => firstTick + index * tickStep)
    .filter((timestamp) => timestamp <= (chartPoints.at(-1)?.ts ?? 0));

  const RANGE_MS = { day: 24, week: 7 * 24, month: 30 * 24 } as const;
  const partial = spanMs > 0 && spanMs < RANGE_MS[range] * 3600_000 * 0.9;
  const daysRecorded = Math.max(1, spanMs / 86_400_000);
  const showDailyAverage = range !== "day" && totals;
  const averageSolar = totals ? totals.pvKwh / daysRecorded : 0;
  const periodMs = RANGE_MS[range] * 3600_000;
  const movePeriod = (direction: number) => {
    const next = (end ?? Date.now()) + direction * periodMs;
    setEnd(next >= Date.now() ? null : next);
  };

  return (
    <>
      <div className="chart-head unified-head history-head">
        <div className="card-title">
          <IconChart size={17} />
          <h2>History</h2>
        </div>
        <div className="range-tabs" role="group" aria-label="History range">
          {(["day", "week", "month"] as Range[]).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r === "day" ? "24h" : r === "week" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
      <div className="history-controls">
        <div className="history-date-controls">
          <button className="icon-btn" title="Previous period" aria-label="Previous period" onClick={() => movePeriod(-1)}><IconPrevious size={16} /></button>
          <label>Through <input aria-label="History end date" type="date" max={localDate(Date.now())} value={localDate(end === null ? Date.now() : end - 1)} onChange={(event) => {
            if (!event.target.value) return;
            const date = new Date(`${event.target.value}T00:00:00`); date.setDate(date.getDate() + 1);
            setEnd(date.getTime() >= Date.now() ? null : date.getTime());
          }} /></label>
          <button className="icon-btn" title="Next period" aria-label="Next period" disabled={end === null} onClick={() => movePeriod(1)}><IconNext size={16} /></button>
          {end !== null && <button className="btn secondary" onClick={() => setEnd(null)}>Latest</button>}
        </div>
        <label><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Compare previous period</label>
        <button className="icon-btn" disabled={!data} title="Export history JSON" aria-label="Export history JSON" onClick={() => downloadJson(`solix-history-${range}-${localDate(end ?? Date.now())}.json`, data)}><IconDownload size={16} /></button>
      </div>
      </div>

      {error && (
        <div className="history-error" role="status">
          <span>{backendRequired ? "Dated history requires the updated dashboard server." : data ? "Refresh failed. Showing the last available readings." : "History is unavailable."}</span>
          <button type="button" onClick={() => setRetry((value) => value + 1)} aria-label="Retry history" title="Retry history">
            <IconRefresh size={16} />
          </button>
        </div>
      )}
      {points.length < 2 ? (
        <div className="empty history-empty" role="status" aria-busy={loading}>
          {loading
            ? "Loading…"
            : error ? "No history to display." : "Not enough recorded history yet."}
        </div>
      ) : (
        <>
          {data?.window && <p className="history-coverage">{formatFullTime(data.window.start)} - {formatFullTime(data.window.end)} · {Math.round(data.window.coverage * 100)}% sample coverage</p>}
          {compare && <div className="period-comparison">
            {data?.previous && data.window && data.previous.coverage >= 0.8 && data.window.coverage >= 0.8
              ? <><span>Previous period: {formatKwh(data.previous.totals.pvKwh)} solar</span><strong>{data.previous.totals.pvKwh > 0 ? `${((totals!.pvKwh / data.previous.totals.pvKwh - 1) * 100).toFixed(0)}% change` : "No previous generation"}</strong></>
              : <span>Not enough coverage for a reliable period comparison.</span>}
          </div>}
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
              {showDailyAverage && (
                <div className="energy-stat is-average">
                  <div className="k">Solar / day</div>
                  <div className="v">{formatKwh(averageSolar)}</div>
                </div>
              )}
              {showDailyAverage && today && !partial && end === null && (
                <div className="energy-stat is-comparison">
                  <div className="k">Today / average</div>
                  <div className="v">
                    {formatKwh(today.pvKwh)}
                    <small>{averageSolar > 0 ? `${((today.pvKwh / averageSolar) * 100).toFixed(0)}%` : "—"}</small>
                  </div>
                </div>
              )}
            </div>
          )}

          {range !== "day" && data?.daily && <div className="daily-energy-chart">
            <h3 className="eyebrow">Daily energy · kWh</h3>
            <ResponsiveContainer width="100%" height={190}>
              <BarChart data={data.daily} margin={{ top: 12, right: 10, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(value: string) => new Date(`${value}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })} {...axisProps} minTickGap={24} />
                <YAxis {...axisProps} />
                <Tooltip labelFormatter={(label, payload) => `${label} (${Math.round((payload[0]?.payload?.coverage ?? 0) * 100)}% coverage)`} formatter={(value: number) => formatKwh(value)} contentStyle={{ background: "var(--node-fill)", border: "1px solid var(--hairline)", borderRadius: 6 }} />
                <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="pvKwh" name="Solar" fill="var(--solar)" isAnimationActive={false} />
                <Bar dataKey="chargeKwh" name="Charged" fill="var(--battery)" isAnimationActive={false} />
                <Bar dataKey="dischargeKwh" name="Discharged" fill="var(--home)" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>}

          {/* Power. Every series is direct-labelled in the legend, which is the
              relief the light-mode contrast warning requires. */}
          <div className="history-plot-head history-power-head">
            <h3 className="eyebrow">Power</h3>
          <div className="legend history-legend" role="group" aria-label="Power series">
            {SERIES.map((s) => (
              <label className="legend-item" key={s.key} data-visible={visible.has(s.key)}>
                <input
                  type="checkbox"
                  checked={visible.has(s.key)}
                  disabled={visible.size === 1 && visible.has(s.key)}
                  onChange={() => setVisible((current) => {
                    const next = new Set(current);
                    if (next.has(s.key)) next.delete(s.key);
                    else next.add(s.key);
                    return next;
                  })}
                />
                <span
                  className={`swatch ${s.dotted ? "is-dotted" : ""}`}
                  style={{ background: s.color }}
                />
                {s.label}
              </label>
            ))}
          </div>
            <span className="history-resolution">{range === "day" ? "5-minute" : range === "week" ? "Hourly" : "6-hour"} averages</span>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart accessibilityLayer syncId={chartId} syncMethod="value" data={chartPoints} margin={{ top: 14, right: 10, bottom: 0, left: -4 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={tickFormat}
                ticks={ticks}
                minTickGap={64}
                {...axisProps}
              />
              <YAxis tickFormatter={formatKw} width={58} {...axisProps} />
              <Tooltip content={<PowerTooltip />} cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }} />
              <ReferenceLine y={0} stroke="var(--axis)" strokeWidth={1} />
              {data?.events?.filter((event) => event.ts >= (chartPoints[0]?.ts ?? 0) && event.ts <= (chartPoints.at(-1)?.ts ?? 0)).slice(0, 40).map((event, index) => <ReferenceLine key={`${event.ts}-${index}`} x={event.ts} stroke="var(--text-muted)" strokeDasharray="2 5" />)}
              {SERIES.map((s) => (
                <Line
                  key={s.key}
                  type="linear"
                  dataKey={s.key}
                  hide={!visible.has(s.key)}
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

          <div className="history-zoom" aria-label="History interval selection">
            <div className="history-zoom-track"><ResponsiveContainer width="100%" height={42}>
              <LineChart data={allChartPoints}>
                <Brush dataKey="ts" height={26} stroke="var(--axis)" fill="var(--node-fill)" travellerWidth={12}
                  tickFormatter={(value: number) => tickFormat(value)} startIndex={selection?.startIndex ?? 0} endIndex={selection?.endIndex ?? Math.max(0, allChartPoints.length - 1)}
                  onChange={(value) => { if (value.startIndex !== undefined && value.endIndex !== undefined) setSelection(value.startIndex === 0 && value.endIndex === allChartPoints.length - 1 ? null : { startIndex: value.startIndex, endIndex: value.endIndex }); }}>
                  <LineChart data={allChartPoints}><Line dataKey="pvW" stroke="var(--solar)" dot={false} isAnimationActive={false} /></LineChart>
                </Brush>
              </LineChart>
            </ResponsiveContainer></div>
            <button className="icon-btn" disabled={!selection} title="Reset to full period" aria-label="Reset to full period" onClick={() => setSelection(null)}><IconRefresh size={16} /></button>
          </div>

          {/* State of charge lives in its own chart: a percentage and watts on
              one pair of axes would be a dual-axis chart. */}
          <div className="history-plot-head history-soc-head">
            <h3 className="eyebrow">Battery charge</h3>
            <span className="history-resolution">{Math.min(...points.map((point) => point.soc))}% – {Math.max(...points.map((point) => point.soc))}%</span>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <AreaChart accessibilityLayer syncId={chartId} syncMethod="value" data={chartPoints} margin={{ top: 14, right: 10, bottom: 0, left: -4 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={tickFormat}
                ticks={ticks}
                minTickGap={64}
                {...axisProps}
              />
              <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={58} tickFormatter={(v: number) => `${v}%`} {...axisProps} />
              <Tooltip content={<SocTooltip />} cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }} />
              <Area
                type="linear"
                dataKey="soc"
                stroke="var(--battery)"
                fill="var(--battery)"
                fillOpacity={0.1}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>

          {data?.events && <><button className="detail-trigger" onClick={() => setEventsOpen(true)} aria-haspopup="dialog">Timeline events ({data.events.length})<IconChart size={16} /></button>
          <Modal open={eventsOpen} title="Timeline events" onClose={() => setEventsOpen(false)}><div className="history-events">
            {data.events.length ? <ul>{data.events.map((event, index) => <li key={`${event.ts}-${index}`}><time>{formatFullTime(event.ts)}</time><span>{event.label}</span></li>)}</ul> : <p>No recorded events in this period.</p>}
          </div></Modal></>}

          {partial && (
            <p className="range-note is-foot">
              {formatSpan(spanMs)} recorded in this period
            </p>
          )}
        </>
      )}
    </>
  );
}
