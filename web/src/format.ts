/** Watts, abbreviated to kW past 1000 the way the app does. */
export function formatW(w: number): string {
  const abs = Math.abs(w);
  if (abs >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

export function formatKwh(kwh: number): string {
  if (Math.abs(kwh) >= 100) return `${kwh.toFixed(0)} kWh`;
  return `${kwh.toFixed(1)} kWh`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Label an axis from the span the data actually covers.
 *
 * Keying off the selected range instead produced "Sep 2" on every tick when a
 * 30-day view held two hours of samples.
 */
export function axisTimeFormatter(spanMs: number): (ts: number) => string {
  const HOUR = 3600_000;
  if (spanMs <= 36 * HOUR) {
    return (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs <= 6 * 24 * HOUR) {
    return (ts) =>
      new Date(ts).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "2 hours", "3 days" - how much history actually exists. */
export function formatSpan(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 90) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function formatFullTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "2h 15m", "45m" - a duration a person can read at a glance. */
export function formatDuration(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Energy, switching to Wh below 0.1 kWh so small sockets still read. */
export function formatEnergy(kwh: number): string {
  if (kwh < 0.1) return `${Math.round(kwh * 1000)} Wh`;
  if (kwh < 10) return `${kwh.toFixed(2)} kWh`;
  return `${kwh.toFixed(1)} kWh`;
}
