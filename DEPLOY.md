# Deploying on a Debian homelab behind Apache

The dashboard is one Node process that serves both the API and the built
frontend. Apache sits in front as a reverse proxy.

Three things about this app shape the setup:

- **It must reach the Solarbank and the plugs on port 502.** Put it on a host
  with a route to their subnet: the same LAN, not an isolated DMZ.
- **`/api/stream` is Server-Sent Events.** Apache buffers proxied responses by
  default, which makes an SSE stream arrive in silent chunks or not at all.
  The config below turns that off explicitly. This is the step people miss.
- **The server runs TypeScript directly via `tsx`**, so `tsx` is a runtime
  dependency, not a build tool. Do not prune it.

---

## 1. Node

Debian's packaged Node is usually too old. This needs **Node 22+** for the
built-in `node:sqlite`.

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # expect v22.x or newer
```

## 2. Application

```sh
sudo useradd --system --create-home --home-dir /opt/solix --shell /usr/sbin/nologin solix
sudo -u solix git clone https://github.com/bogdanspn/solix /opt/solix/app
cd /opt/solix/app

sudo -u solix npm ci             # full install: the build needs the dev deps
sudo -u solix npm run build      # writes dist/
```

Install everything, then build. `npm ci --omit=dev` skips Vite, so the build
would fail. If you want to slim the tree afterwards:

```sh
sudo -u solix npm prune --omit=dev   # keeps dotenv, express, modbus-serial, tsx
```

Alternatively build on your workstation and copy `dist/` across, in which case
`npm ci --omit=dev` on the server is enough.

### Finding the hardware

Nothing needs configuring by hand. On startup, with no `SOLIX_HOST` set, the
server sweeps the local `/24` for the Solarbank and writes what it finds to
`.env`. It also re-sweeps by serial if the device stops answering, so a DHCP
lease change heals itself.

To do it up front and see the register dump:

```sh
sudo -u solix npm run probe
```

That writes `.env` with the address, unit id, register kind, sign conventions
and every Smart Plug it finds.

**Bind to localhost.** Apache should be the only thing reaching Node directly:

```sh
echo "HTTP_HOST=127.0.0.1" | sudo -u solix tee -a /opt/solix/app/.env
```

### What lives in `.env`

| Key | Meaning |
|---|---|
| `SOLIX_HOST` | Solarbank address. Blank means "discover on startup". |
| `SOLIX_PORT`, `SOLIX_UNIT_ID` | Modbus port and slave id, usually 502 and 1. |
| `SOLIX_REGISTER_KIND` | `holding` (FC3) or `input` (FC4). |
| `SOLIX_INVERT_BATTERY`, `SOLIX_INVERT_GRID` | Sign normalisation, set by the probe. |
| `SOLIX_PLUGS` | Smart Plug addresses, comma separated. Maintained by the Rescan button. |
| `SOLIX_METER` | Smart Meter address, if one is on the LAN. Only with a meter are the grid and load registers real house measurements. |
| `HTTP_HOST`, `HTTP_PORT` | Bind address and port. |
| `POLL_INTERVAL_MS` | Default 5000. Socket energy is integrated from these samples, so a longer interval costs accuracy on short loads. |
| `PERSIST_INTERVAL_MS` | How often a history row is written. Default 30000. |

## 3. systemd

`/etc/systemd/system/solix.service`:

```ini
[Unit]
Description=Solarbank dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=solix
WorkingDirectory=/opt/solix/app
# The project's own tsx, not npx: npx would reach for the network if it were
# missing, and tsx is what runs the TypeScript server.
ExecStart=/opt/solix/app/node_modules/.bin/tsx server/index.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# data/ holds history.db, per-socket energy, socket names and the saved
# forecast location. .env is rewritten on rediscovery, so the app directory
# itself has to stay writable.
ReadWritePaths=/opt/solix/app
ProtectSystem=full
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now solix
sudo systemctl status solix
curl -s localhost:8787/api/live | head -c 200
```

## 4. Apache

```sh
sudo a2enmod proxy proxy_http headers
```

`/etc/apache2/sites-available/solix.conf`:

```apache
<VirtualHost *:80>
    ServerName solix.home.lan

    ProxyPreserveHost On
    ProxyTimeout 300

    # Server-Sent Events: Apache buffers proxied output by default, which
    # holds the live stream until the buffer fills. Both flags are needed:
    # flushpackets on the worker, and no-gzip so mod_deflate cannot re-buffer.
    <Location /api/stream>
        ProxyPass http://127.0.0.1:8787/api/stream flushpackets=on
        ProxyPassReverse http://127.0.0.1:8787/api/stream
        SetEnv proxy-nokeepalive 0
        SetEnv no-gzip 1
        Header set X-Accel-Buffering "no"
    </Location>

    # A LAN sweep for the Solarbank or the sockets takes a couple of minutes,
    # well past a default proxy timeout.
    <Location /api/plugs/rescan>
        ProxyPass http://127.0.0.1:8787/api/plugs/rescan timeout=300
    </Location>
    <Location /api/rediscover>
        ProxyPass http://127.0.0.1:8787/api/rediscover timeout=300
    </Location>

    ProxyPass        / http://127.0.0.1:8787/
    ProxyPassReverse / http://127.0.0.1:8787/

    ErrorLog  ${APACHE_LOG_DIR}/solix-error.log
    CustomLog ${APACHE_LOG_DIR}/solix-access.log combined
</VirtualHost>
```

```sh
sudo a2ensite solix
sudo apache2ctl configtest
sudo systemctl reload apache2
```

If `mod_deflate` is enabled globally, also exclude the stream from it:

```apache
SetEnvIfNoCase Request_URI ^/api/stream$ no-gzip dont-vary
```

## 5. HTTPS (optional, LAN only)

For a hostname resolvable only on your LAN, Let's Encrypt HTTP-01 will not
work. Either use a DNS-01 challenge with a real domain, or a self-signed
certificate:

```sh
sudo apt install -y ssl-cert
sudo a2enmod ssl && sudo a2ensite default-ssl
```

Then copy the proxy blocks above into the `*:443` vhost. SSE works the same
over TLS.

---

## Verifying

```sh
# API reachable through Apache
curl -s http://solix.home.lan/api/live | head -c 200

# SSE actually streaming: events should appear every ~5s, not in one burst
curl -N -s http://solix.home.lan/api/stream | head -20
```

If `curl -N` sits silent and then dumps several events at once, buffering is
still on somewhere. Check `mod_deflate` and that the `<Location>` block is
being matched.

## Updating

```sh
cd /opt/solix/app
sudo -u solix git pull
sudo -u solix npm ci
sudo -u solix npm run build
sudo systemctl restart solix
```

`data/` and `.env` are gitignored, so history, socket names and the saved
location survive an update.

## Diagnostics

All read-only, and all runnable on the server.

| Command | What it does |
|---|---|
| `npm run probe` | Sweep the LAN, identify every device, dump every register, write `.env`. |
| `npm run explore` | Sweep the register space to find undocumented fields. |
| `npm run probe-modes` | Read the mode and capability-mask registers. |
| `npm run poll-timing` | Measure how long a full poll cycle takes against the hardware. |
| `npm run learn-modes` | Watch the operating-mode register while you switch modes in the app. |
| `npm run check-eta` | Exercise the charge/discharge estimate against known inputs. |
| `npm run check-flow` | Read back the flow animation directions from a live page. |
| `npm run shot` | Screenshot both themes. Needs Playwright's Chromium: `npx playwright install chromium`. |

The last two drive a browser, so they need the dev dependencies present.

## Notes

- **Back up `data/`.** It holds the history database, per-socket energy totals,
  socket names and the forecast location. `.env` is reproducible with
  `npm run probe`.
- **Do not expose this to the internet.** There is no authentication, and the
  settings endpoints write to the battery. Keep it on the LAN or behind a VPN.
- **Modbus concurrency is limited but not single.** Two simultaneous
  connections to the Solarbank were verified working, a diagnostic script
  alongside the running server. Adding a third consumer, such as Home
  Assistant polling the same unit, risks intermittent dropped reads.
- **Poll cost is modest.** Measured on real hardware: a full Solarbank cycle is
  around 310 ms of the 5 s window, roughly 6% duty, plus about 11 ms per plug
  read in parallel. Latency is dominated by per-request round-trip, so if you
  ever need headroom, merge adjacent register blocks rather than polling less
  often.
- **The forecast is the only outbound traffic.** Open-Meteo and Zippopotam
  receive a postcode or coordinates and nothing else. With no location set, the
  app makes no external requests at all.
- Logs: `journalctl -u solix -f`.
