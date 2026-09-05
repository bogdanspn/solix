import { useEffect, useState } from "react";
import type { HistoryResponse, Snapshot } from "../../server/types.ts";
import type { WeatherReport } from "../../server/weather.ts";
import { solarInsights } from "./insights.ts";
import { formatEnergy, formatW } from "./format.ts";
import { IconSun, IconClock, IconBattery, IconSettings } from "./Icons.tsx";

export function Insights({ snapshot, report, ratedKwh, onReviewSettings }: {
  snapshot: Snapshot; report: WeatherReport; ratedKwh: number | null; onReviewSettings: () => void;
}) {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/history?range=day", { signal: controller.signal });
        if (!response.ok) throw new Error("History unavailable");
        const data: HistoryResponse = await response.json();
        if (!controller.signal.aborted) setHistory(data);
      } catch { if (!controller.signal.aborted) setHistory(null); }
    };
    void load();
    const timer = setInterval(() => void load(), 300_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const insight = solarInsights(history?.points ?? [], report, snapshot, ratedKwh);
  const clock = (timestamp: number) => new Date(timestamp).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const offline = snapshot.plugs.filter((plug) => !plug.online).length;
  const tomorrow = report.days[1];
  const outlook = !tomorrow ? null : tomorrow.solarKwhM2 >= 4 ? "Strong solar outlook" : tomorrow.solarKwhM2 >= 2.5 ? "Moderate solar outlook" : "Limited solar outlook";
  const tonight = !tomorrow ? "Review the reserve against expected overnight demand."
    : tomorrow.solarKwhM2 < 2.5 ? "Limited solar tomorrow. Consider keeping more reserve overnight."
    : "Review overnight demand before lowering the reserve; tomorrow's refill is not guaranteed.";
  return <div className="forecast-insights">
    <div><h3><IconSun size={20} />Tomorrow's solar estimate</h3><strong>{insight.tomorrowKwh === null ? "Not enough matched data" : `${formatEnergy(insight.tomorrowKwh * (1 - insight.spread))} - ${formatEnergy(insight.tomorrowKwh * (1 + insight.spread))}`}</strong>
      {outlook && <p className="forecast-outlook">{outlook}</p>}
      <p>{insight.tomorrowKwh === null ? "Needs three complete daylight hours and a current forecast." : `Calibrated to ${insight.matchedHours} recent hours. Scenario range, not a confidence interval; shading and curtailment may change output.`}</p></div>
    <div><h3><IconClock size={20} />Next high-production hour</h3><strong>{insight.best ? `${clock(insight.best.ts - 3600_000)} - ${new Date(insight.best.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "No strong window available"}</strong><p>Highest forecast irradiance in the next 24 hours.</p></div>
    <div><h3><IconBattery size={20} />Reserve at sunset</h3><strong>{insight.reserve ? `${formatEnergy(insight.reserve[0]!)} - ${formatEnergy(insight.reserve[1]!)}` : "Estimate unavailable"}</strong>
      <p>{insight.reserve ? `Above the discharge floor, assuming ${formatW(insight.demandW)} steady system demand and 90% solar charging efficiency. No scheduled charging modeled.` : "Requires current readings, capacity, and enough daylight history."}</p>
      </div>
    <div className="forecast-decision"><div><p>{tonight}</p>
    <div role="status">
      {(!snapshot.online || snapshot.staleSeconds > 20) && <p>Device readings are stale. Check the connection before changing limits.</p>}
      {offline > 0 && <p>{offline} socket{offline === 1 ? " is" : "s are"} offline. <a href="#sockets">Review sockets</a></p>}
      {snapshot.online && snapshot.staleSeconds <= 20 && snapshot.eta.beforeSunset === false && <p>The charge target is beyond sunset at the current rate.</p>}
    </div></div><button className="btn secondary" onClick={onReviewSettings}><IconSettings size={16} />Review limits</button></div>
  </div>;
}