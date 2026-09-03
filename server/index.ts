import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { events, getDevice, getLatest, rediscover, startPolling } from "./poll.ts";
import { history, peakPvW, sampleCount, todayTotals, type Range } from "./history.ts";
import { isWritableKey, writeSetting } from "./control.ts";
import { OPERATING_MODE, OPERATING_MODE_LABELS } from "./registers.ts";
import { plugHosts, setPlugHosts, setPlugName, setPlugSwitch } from "./plugs.ts";
import { discoverPlugs, identifyMeter, persistMeterHost, persistPlugHosts } from "./discovery.ts";
import { setMeterHost } from "./config.ts";
import { geocode, getWeather, loadPlace, savePlace } from "./weather.ts";
import type { Snapshot } from "./types.ts";

const app = express();
app.use(express.json());

const ROOT = path.resolve(import.meta.dirname, "..");

app.get("/api/device", (_req, res) => {
  const device = getDevice();
  if (!device) {
    res.status(503).json({ error: "Not connected to the Solarbank yet" });
    return;
  }
  res.json({
    device,
    modes: Object.values(OPERATING_MODE).map((m) => ({ value: m, label: OPERATING_MODE_LABELS[m] ?? m })),
    samples: sampleCount(),
    peakPvW: peakPvW(),
  });
});

app.get("/api/live", (_req, res) => {
  const snapshot = getLatest();
  if (!snapshot) {
    res.status(503).json({ error: "No reading yet" });
    return;
  }
  res.json({ ...snapshot, today: todayTotals() });
});

/** Server-sent events: the UI subscribes once instead of polling. */
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (snapshot: Snapshot | null) => {
    if (!snapshot) return;
    res.write(`data: ${JSON.stringify({ ...snapshot, today: todayTotals() })}\n\n`);
  };

  send(getLatest());
  events.on("snapshot", send);

  // Comment frames keep proxies and browsers from dropping an idle stream.
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    events.off("snapshot", send);
  });
});

app.get("/api/history", (req, res) => {
  const range = String(req.query["range"] ?? "day");
  if (range !== "day" && range !== "week" && range !== "month") {
    res.status(400).json({ error: "range must be day, week or month" });
    return;
  }
  res.json(history(range as Range));
});

app.get("/api/settings", (_req, res) => {
  const snapshot = getLatest();
  if (!snapshot) {
    res.status(503).json({ error: "No reading yet" });
    return;
  }
  res.json(snapshot.settings);
});

app.post("/api/settings", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const entries = Object.entries(body ?? {});

  if (entries.length === 0) {
    res.status(400).json({ error: "No settings supplied" });
    return;
  }

  const results = [];
  for (const [key, value] of entries) {
    if (!isWritableKey(key)) {
      results.push({ ok: false, key, message: "Not a writable setting" });
      continue;
    }
    results.push(await writeSetting(key, value));
  }

  const ok = results.every((r) => r.ok);
  res.status(ok ? 200 : 409).json({ ok, results });
});

/**
 * Sweep the LAN for sockets and adopt whatever answers.
 *
 * Needed because a plug only appears once Modbus TCP is switched on for it in
 * the app, which can happen long after first setup -- and because DHCP can
 * move one to a new address.
 */
let rescanning = false;
app.post("/api/plugs/rescan", async (_req, res) => {
  if (rescanning) {
    res.status(409).json({ error: "A scan is already running" });
    return;
  }
  rescanning = true;
  try {
    const found = await discoverPlugs(config.port, config.unitId, [config.host]);
    const hosts = found.map((p) => p.host);
    const { added, removed } = setPlugHosts(hosts);
    persistPlugHosts(hosts);

    // A Smart Meter would also be a separate device on the LAN; if one shows
    // up, the grid and load registers become real house measurements.
    let meter: string | null = null;
    for (const h of hosts) {
      if (await identifyMeter(h, config.port, config.unitId)) {
        meter = h;
        break;
      }
    }
    if (meter) {
      setMeterHost(meter);
      persistMeterHost(meter);
    }

    console.log(
      "[rescan] %d socket(s); +%d -%d%s",
      hosts.length, added.length, removed.length,
      meter ? `; smart meter at ${meter}` : "",
    );
    res.json({ ok: true, total: hosts.length, added, removed, plugs: found, meter });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    rescanning = false;
  }
});

/** Sweep the LAN for the Solarbank, for when its address has changed. */
app.post("/api/rediscover", async (_req, res) => {
  try {
    const host = await rediscover(true);
    if (host) res.json({ ok: true, host });
    else res.status(404).json({ ok: false, error: "No Solarbank answered on the LAN" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Switch a socket on or off. This cuts real power, so the UI confirms first. */
app.post("/api/plugs/:serial/switch", async (req, res) => {
  const serial = req.params.serial;
  const on = (req.body as { on?: unknown })?.on;
  if (typeof on !== "boolean") {
    res.status(400).json({ error: "Body must be { on: boolean }" });
    return;
  }
  try {
    const reading = await setPlugSwitch(serial, on);
    const ok = reading.on === on;
    res.status(ok ? 200 : 409).json({
      ok,
      plug: reading,
      ...(ok ? {} : { message: "The socket did not report the requested state." }),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Rename a socket. Names are keyed by serial so they survive a DHCP change. */
app.post("/api/plugs/:serial/name", (req, res) => {
  const serial = req.params.serial;
  const name = String((req.body as { name?: unknown })?.name ?? "");
  if (!serial) {
    res.status(400).json({ error: "Missing serial" });
    return;
  }
  setPlugName(serial, name);
  res.json({ ok: true });
});

/**
 * Weather. The only endpoint that leaves the LAN, and only a postcode or a
 * pair of coordinates goes out -- nothing about the system.
 */
app.get("/api/weather", async (req, res) => {
  try {
    if (!loadPlace()) {
      res.status(404).json({ error: "No location set" });
      return;
    }
    const report = await getWeather(req.query["force"] === "1");
    res.json(report);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/weather/search", async (req, res) => {
  try {
    const q = String(req.query["q"] ?? "");
    const country = String(req.query["country"] ?? "DE");
    res.json({ results: await geocode(q, country) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/weather/location", async (req, res) => {
  const body = req.body as Partial<{
    name: string;
    country: string;
    latitude: number;
    longitude: number;
    postcode: string;
  }>;
  if (typeof body?.latitude !== "number" || typeof body?.longitude !== "number") {
    res.status(400).json({ error: "latitude and longitude are required" });
    return;
  }
  savePlace({
    name: body.name ?? "Home",
    country: body.country ?? "",
    latitude: body.latitude,
    longitude: body.longitude,
    ...(body.postcode ? { postcode: body.postcode } : {}),
  });
  try {
    res.json(await getWeather(true));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Serve the built frontend when it exists; in dev, Vite serves it instead.
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

startPolling();

app.listen(config.httpPort, config.httpHost, () => {
  console.log(
    "Solix dashboard on http://%s:%d  (device %s:%d, unit %d, %s registers)",
    config.httpHost,
    config.httpPort,
    config.host,
    config.port,
    config.unitId,
    config.registerKind,
  );
});
