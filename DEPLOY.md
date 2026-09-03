# Deploying on a Debian homelab behind Apache

The dashboard is one Node process that serves both the API and the built
frontend. Apache sits in front as a reverse proxy.

Two things about this app shape the setup:

- **It must reach the Solarbank and the plugs on port 502.** Put it on a host
  with a route to `192.168.1.0/24` - the same LAN, not an isolated DMZ.
- **`/api/stream` is Server-Sent Events.** Apache buffers proxied responses by
  default, which makes an SSE stream arrive in silent chunks or not at all.
  The config below turns that off explicitly. This is the step people miss.

---

## 1. Node

Debian's packaged Node is usually too old - this needs **Node 22+** for the
built-in `node:sqlite`.

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # expect v22.x or newer
```

## 2. Application

```sh
sudo useradd --system --create-home --home-dir /opt/solix --shell /usr/sbin/nologin solix
sudo -u solix git clone <your-repo> /opt/solix/app     # or rsync the directory
cd /opt/solix/app
sudo -u solix npm ci --omit=dev
sudo -u solix npx vite build                            # writes dist/
```

`npm ci --omit=dev` skips Vite and Playwright, so build first if you are
deploying from source on the server - or build on your workstation and copy
`dist/` across.

Then discover the hardware:

```sh
sudo -u solix npx tsx scripts/probe.ts
```

That writes `/opt/solix/app/.env` with the Solarbank address, unit id, register
kind, sign conventions and every plug it finds. Check it before continuing.

**Bind to localhost.** Apache is the only thing that should reach the Node
process directly:

```sh
echo "HTTP_HOST=127.0.0.1" | sudo -u solix tee -a /opt/solix/app/.env
```

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
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# The data directory holds history.db, plug names and the saved location.
ReadWritePaths=/opt/solix/app/data
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
    # holds the live stream until the buffer fills. Both flags are needed -
    # flushpackets on the worker, and no-gzip so mod_deflate cannot re-buffer.
    <Location /api/stream>
        ProxyPass http://127.0.0.1:8787/api/stream flushpackets=on
        ProxyPassReverse http://127.0.0.1:8787/api/stream
        SetEnv proxy-nokeepalive 0
        SetEnv no-gzip 1
        Header set X-Accel-Buffering "no"
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

# SSE actually streaming - events should appear every ~5s, not in one burst
curl -N -s http://solix.home.lan/api/stream | head -20
```

If `curl -N` sits silent and then dumps several events at once, buffering is
still on somewhere - check `mod_deflate` and that the `<Location>` block is
being matched.

## Notes

- **Back up `data/`.** It holds the history database, per-socket energy totals,
  socket names and the forecast location. Nothing else is stateful; `.env` is
  reproducible with `npm run probe`.
- **Do not expose this to the internet.** There is no authentication, and the
  settings endpoints write to the battery. Keep it on the LAN or behind a VPN.
- **Modbus allows one connection per device at a time.** Running a second copy
  of this dashboard, or Home Assistant polling the same Solarbank, will cause
  both to drop reads intermittently.
- Logs: `journalctl -u solix -f`.
