import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, XAxis } from "recharts";
import type { EnergyTotals, HistoryResponse, Snapshot } from "../../server/types.ts";
import { formatEnergy } from "./format.ts";
import { IconBattery, IconPlug, IconSun } from "./Icons.tsx";

export function TodaySummary({ snapshot, today, ratedKwh }: {
  snapshot: Snapshot;
  today: EnergyTotals;
  ratedKwh: number | null;
}) {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/history?range=day", { signal: controller.signal });
        if (!response.ok) throw new Error("History unavailable");
        const next: HistoryResponse = await response.json();
        if (!controller.signal.aborted) setHistory(next);
      } catch {
        if (!controller.signal.aborted) setHistory(null);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);

  const midnight = new Date(snapshot.ts).setHours(0, 0, 0, 0);
  const points = (history?.points ?? []).filter((point) => point.ts >= midnight);
  const trace = points.flatMap((point, index) => {
    const previous = points[index - 1];
    return previous && point.ts - previous.ts > 450_000
      ? [{ ts: previous.ts + 300_000, pvW: null }, { ts: point.ts, pvW: point.pvW }]
      : [{ ts: point.ts, pvW: point.pvW }];
  });
  const floor = Math.max(0, Math.min(100, snapshot.settings.dischargeLimitSoc));
  const reserve = ratedKwh !== null && ratedKwh > 0
    ? ratedKwh * Math.max(0, Math.min(100, snapshot.soc) - floor) / 100 : null;
  const socketEnergy = snapshot.plugs.reduce((sum, plug) => sum + plug.todayKwh, 0);
  const largest = [...snapshot.plugs].sort((first, second) => second.todayKwh - first.todayKwh)[0];

  return (
    <section className="today-summary" aria-label="Today's energy summary">
      <div className="today-metric">
        <h2><IconSun size={15} />Solar generated today</h2>
        <strong>{formatEnergy(today.pvKwh)}</strong>
        <span className="today-context">{history?.sameTimeYesterday && history.sameTimeYesterday.coverage >= 0.8 && history.sameTimeYesterday.todayCoverage >= 0.8
          ? `${formatEnergy(history.sameTimeYesterday.totals.pvKwh)} by this time yesterday` : "Recorded generation"}</span>
        {trace.length > 1 && <div className="today-sparkline" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trace} margin={{ top: 3, right: 0, bottom: 3, left: 0 }}>
              <XAxis hide dataKey="ts" type="number" domain={[midnight, snapshot.ts]} />
              <Line type="linear" dataKey="pvW" stroke="var(--solar)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>}
      </div>
      <div className="today-metric">
        <h2><IconBattery size={15} />Available battery reserve</h2>
        <strong>{reserve === null ? "--" : formatEnergy(reserve)}</strong>
        <span className="today-context">{reserve === null ? "Capacity unavailable" : `Estimated above ${floor}% minimum`}</span>
      </div>
      <div className="today-metric">
        <h2><IconPlug size={15} />Sockets today</h2>
        <strong>{snapshot.plugs.length ? formatEnergy(socketEnergy) : "--"}</strong>
        <span className="today-context">{largest && largest.todayKwh > 0
          ? `Largest: ${largest.name} · ${formatEnergy(largest.todayKwh)}`
          : snapshot.plugs.length ? "Estimated from socket readings" : "No sockets connected"}</span>
      </div>
    </section>
  );
}