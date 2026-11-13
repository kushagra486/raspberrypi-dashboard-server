# raspberrypi-dashboard-server

A lightweight web dashboard for a Raspberry Pi. It shows CPU temperature, CPU
usage and load, memory, disk, uptime and per-interface network traffic, and it
refreshes itself every few seconds. The same data is available as JSON.

| Route         | What it returns                       |
|---------------|---------------------------------------|
| `/`           | The dashboard page                    |
| `/api/stats`  | Current system stats as JSON          |
| `/healthz`    | `{"status": "ok"}` for health checks  |

## Quick start

```bash
git clone https://github.com/kushagra486/raspberrypi-dashboard-server.git
cd raspberrypi-dashboard-server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Then open `http://<pi-ip>:8080` from any device on your network.

### Configuration

| Variable            | Default   | Meaning                         |
|---------------------|-----------|---------------------------------|
| `DASHBOARD_HOST`    | `0.0.0.0` | Bind address (`app.py` only)    |
| `DASHBOARD_PORT`    | `8080`    | Port (`app.py` only)            |
| `DASHBOARD_REFRESH` | `3`       | Page refresh interval, seconds  |

## Run on boot (systemd)

The included unit assumes the repo is at `/home/pi/raspberrypi-dashboard-server`
and runs as user `pi`; edit `pi-dashboard.service` if yours differs.

```bash
sudo cp pi-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-dashboard
systemctl status pi-dashboard
```

## Security note

There's no authentication. Anyone who can reach the port can see your Pi's
stats, so keep it on a trusted LAN or put it behind a reverse proxy with auth.

## Tests

```bash
.venv/bin/pip install pytest
.venv/bin/pytest
```
