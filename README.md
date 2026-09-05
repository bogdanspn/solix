# Solarbank dashboard

A local web dashboard for an Anker SOLIX Solarbank 4 E5000 Pro. It reads the
device directly over your LAN with **Modbus TCP** - no Anker account, no cloud,
no rate limits - and serves a live power-flow view, history charts, and the
settings worth changing without reaching for the phone.

Verified against a real system: a Solarbank 4 E5000 Pro (`AE103`, firmware
`1.0.2.30`, 15.1 kWh) and nine Smart Plug Gen 2 units (`A17X8`).

## Dashboard Views

- Compact scene mode, socket pins, sort order, and history range are saved in
  this browser. PV strings, system readings, socket details, tariff settings,
  and timeline events open in dialogs without expanding dashboard panels.
- History supports bounded dates, previous-period comparisons, daily energy
  bars, linked interval selection, event markers, and JSON export. Comparisons
  require at least 80% sample coverage. Daily bar tooltips show coverage.
- Solar estimates calibrate recent PV readings against hourly forecast
  irradiance. At least three sufficiently sampled daylight hours are required.
  The displayed range is a scenario range, not a statistical confidence interval.
  Sunset reserve assumes steady recent system demand and 90% charging efficiency;
  shading, curtailment, scheduled charging, and changing demand can invalidate it.
- Optional flat-rate tariff estimates cover socket consumption only, excluding
  standing charges. They are not whole-home costs or solar savings estimates.

Deploy the updated server as well as the frontend to enable dated history,
daily bars, coverage comparisons, and recorded connectivity/mode events.
Events start when the updated server runs; historical recording gaps are not
proof of a device outage. No device settings are changed automatically.

Run `npm run check-dashboard` and `npm run check-history` for the focused checks.
The history check uses an in-memory database and does not connect to hardware.

## Setup

**1. Enable Modbus TCP on the device** (once, in the Anker app):

> Devices → your Solarbank → Settings (gear) → **Three-Party Control Settings** →
> enable **Modbus TCP**

Note the IP it shows. A DHCP reservation for it on your router is worth doing so
it does not move.

**2. Install and probe:**

```sh
npm install
npm run probe            # scans the LAN, or: npm run probe -- 192.168.1.50
```

The probe finds the device, works out whether it speaks holding or input
registers and on which unit id, prints every register it can read, and writes the
result to `.env`. It also derives the battery sign convention from the device's
own `battery_status` register, so charging and discharging are never guessed.

**3. Run:**

```sh
npm run dev      # Vite on :5273 + API on :8787, with reload
npm start        # build the frontend and serve everything from :8787
npm run shot     # screenshot both themes to shot-dark.png / shot-light.png
npm run explore  # read-only sweep of the register space (diagnostic)
```

Open <http://localhost:8787>. It is reachable from a phone on the same network at
your machine's LAN address, and the layout is responsive.

### Developing against a deployed instance

The Solarbank accepts about two concurrent Modbus consumers. A deployed
dashboard and the phone app already use both, so a second dashboard polling the
same device is what makes it start refusing connections to everything.

So for frontend work, do not run a second poller. Point the dev server at the
deployed one:

```sh
echo "SOLIX_API=http://homelab:8080" >> .env
npm run dev:web          # Vite alone, no local Modbus connection at all
```

Vite prints the target it is proxying to on startup. This covers almost
everything: layout, charts, the header scene, formatting, theming.

Server work is the exception. Changing the register map, the poll loop or the
discovery code needs the hardware, and that means being the one consumer that
has it:

```sh
ssh homelab sudo systemctl stop solix    # hand the device over
npm run dev                              # local server + Vite
ssh homelab sudo systemctl start solix   # hand it back
```

History has a gap for as long as the deployed instance is stopped, so keep
those sessions short and do the UI half of the work in the mode above.

## What it shows

- **Power flow** - solar, battery, home and grid around a hub, with animated
  links whose direction follows the sign of each value and whose speed follows
  its magnitude. The hub ring is state of charge.
- **Now** - current power per path, stored kWh, and today's energy in and out.
- **History** - 24 hour / 7 day / 30 day power and state-of-charge charts, from a
  local SQLite file the server writes every 30 seconds.
- **Sockets** - every Smart Plug as a consumption list, sorted by draw, with its
  share of the total, voltage and temperature. Click a name to rename it; names
  are keyed by serial in `data/plug-names.json`, so they survive a DHCP change.
- **Forecast** - a 7-day solar outlook for your location, plus a plain-language
  read on whether tonight's discharge will refill tomorrow.
- **Settings** - charge limit, discharge limit, backup reserve and operating
  mode. Nothing is written until you press Apply, and the result reports what the
  device read back rather than what was requested.

## Sockets

Smart Plugs are found by sweeping the local /24 for port 502 and asking each
responder for its model register. A plug only answers once **Modbus TCP is
enabled for it individually** in the Anker app, so one switched on later will
not appear until the list is refreshed. Use the **Rescan** button on the Sockets
card (or `POST /api/plugs/rescan`) - it re-sweeps, adopts what it finds, and
writes the result back to `SOLIX_PLUGS` in `.env` so a restart keeps it.
Rescanning also recovers a socket that DHCP moved to a new address.

Renaming: click a socket's name. Names are keyed by **serial**, not IP, so they
survive an address change; they live in `data/plug-names.json`.

## Screenshots

`npm run shot` renders the dashboard with Playwright's bundled Chromium. The
system Edge/Chrome refuse to run headless on this machine - they exit silently
without writing a file, which is typical of an enterprise policy block - so the
script deliberately uses Playwright's own browser binary instead. If it is
missing, `npx playwright install chromium` fetches it.

## Weather and solar forecast

The forecast card predicts **solar irradiance**, not just "sunny or cloudy".
[Open-Meteo](https://open-meteo.com) publishes `shortwave_radiation` - the
energy actually reaching the ground in W/m² - which already folds in sun angle,
day length and haze, and so tracks PV yield far better than a cloud percentage
does. The daily bars are kWh/m²; roughly, multiply by your array's kWp and its
efficiency to get expected kWh.

That feeds the one decision worth automating in your head: **how far to run the
battery down overnight.** A sunny tomorrow means a low discharge limit costs
nothing, because the battery refills by afternoon. A dull tomorrow means holding
charge back is worth more.

Set the location by postcode or town. Postcodes go to
[Zippopotam](https://api.zippopotam.us) - Open-Meteo's geocoder indexes place
names, not postcodes, and returns nothing for e.g. `12345`. Both are free and
need no key. It is stored in `data/location.json`.

**This is the only part of the dashboard that leaves your LAN**, and only the
location goes out - nothing about the system, its readings or its serial.

## Notes

- **Sockets stand in for the Smart Meter.** Without a meter paired the Solarbank
  reports `load_power` as 0 even while power is flowing. Anker Smart Plugs
  (A17X8) each meter their own branch and speak Modbus on the same port, so the
  dashboard discovers them, polls them, and uses their sum as household
  consumption. Whatever the sockets do not account for -- a custom-mode
  baseline, or an unmetered circuit -- is reported separately as "not covered by
  the sockets" rather than folded in silently. With no meter and no plugs, Home
  reads "not measured" instead of a confident zero.
- **Period energy is derived by differencing the device's lifetime counters**
  rather than by integrating instantaneous power, so today/week/month totals
  match what the app reports instead of drifting a few percent.
- **Stale data is shown as stale.** A failed poll leaves the last known reading
  on screen, marked, instead of collapsing every figure to zero.
- **If a write reads back unchanged**, the likely cause is the operating mode:
  some Solarbank controls only take effect under third-party control. The UI says
  so rather than failing silently.
- The battery power setpoint (register 10071) is read and displayed but
  deliberately **not** writable here - driving it fights the device's own EMS.

## Undocumented registers

`npm run explore` sweeps the register space read-only and prints everything that
answers. It found four fields absent from Anker's own integration:

| Register | Reads | Meaning | Status |
|---|---|---|---|
| 10213 | 5001-5002 | Grid frequency, /100 Hz | **Confirmed** - jitters around 50.00 |
| 10224 | 2335-2340 | AC voltage, /10 V | **Confirmed** - jitters, tracks the sockets |
| 10156 | 290 | Battery temperature, /10 °C | Inferred - held steady over a 30 s sample |
| 10015 | 100 | Battery health, % | Inferred - held steady over a 30 s sample |

The first two were verified by sampling: real measurements jitter, constants do
not. The last two decode plausibly but could not be proven that way, so the UI
marks them with a dotted underline and says so on hover. Do not treat them as
gospel until something moves them.

Also seen but not adopted: 10118+ carries a second version string, 10256 mirrors
the state of charge, and 10006-10007 looks like another signed power value that
read 0 during the second sample. `npm run explore` will show them again.

## Register map

`server/registers.ts` holds the Solarbank map and `server/plugs.ts` the Smart
Plug map, both taken from the per-device YAML in Anker's
own Home Assistant integration
([anker-charging/ha-anker-solix-official](https://github.com/anker-charging/ha-anker-solix-official),
MIT). Two upstream quirks are handled there:

- `battery_charging_power` / `battery_discharging_power` share address 10008, and
  `grid_import_power` / `grid_export_power` share 10012 - each is one signed
  INT32 split by sign, not two registers.
- `battery_power` and `battery_power_setpoint` use **opposite** signs on the same
  device: while discharging, `battery_power` reads +1380 and the setpoint reads
  −1380. Only the former is inverted into the internal convention.

Internally: `batteryW > 0` means charging, `gridW > 0` means importing.

If a firmware update ever changes the map, `npm run probe` is the diagnostic -
it dumps every register with its raw words.

## Layout

```
server/
  registers.ts   register map + contiguous read blocks
  decode.ts      INT32/UINT32/UINT16/STRING decoding
  modbus.ts      connection, batched block reads, reconnect
  poll.ts        5s poll loop, SSE broadcast, backoff when offline
  history.ts     SQLite samples, hourly rollups, counter-differenced totals
  plugs.ts       Smart Plug polling, naming, aggregation
  control.ts     guarded, range-checked writes
  index.ts       HTTP API + static frontend
web/src/         React UI (power flow, tiles, charts, controls)
scripts/probe.ts discovery and convention prober
```

Chart colours were validated for colour-vision deficiency in both light and dark
modes; see the note at the top of `web/src/theme.css`.
