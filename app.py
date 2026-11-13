"""Raspberry Pi dashboard server.

Serves a self-refreshing web dashboard at `/` and the raw stats as JSON at
`/api/stats`. Configure with environment variables:

    DASHBOARD_HOST      bind address            (default 0.0.0.0)
    DASHBOARD_PORT      port                    (default 8080)
    DASHBOARD_REFRESH   page refresh in seconds (default 3)
"""

import os
import platform
import socket
import time

import psutil
from flask import Flask, jsonify, render_template

THERMAL_ZONE = "/sys/class/thermal/thermal_zone0/temp"

app = Flask(__name__)


def cpu_temperature():
    """Return the CPU temperature in °C, or None if it can't be read."""
    try:
        with open(THERMAL_ZONE) as f:
            return round(int(f.read().strip()) / 1000, 1)
    except (OSError, ValueError):
        pass
    # Fallback for non-Pi Linux machines with lm-sensors style readings.
    try:
        temps = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return None
    for entries in temps.values():
        if entries:
            return round(entries[0].current, 1)
    return None


def network_stats():
    counters = psutil.net_io_counters(pernic=True)
    addrs = psutil.net_if_addrs()
    interfaces = []
    for name, io in counters.items():
        if name == "lo":
            continue
        ipv4 = next(
            (a.address for a in addrs.get(name, []) if a.family == socket.AF_INET),
            None,
        )
        interfaces.append({
            "name": name,
            "ipv4": ipv4,
            "bytes_sent": io.bytes_sent,
            "bytes_recv": io.bytes_recv,
        })
    return interfaces


def collect_stats():
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    boot_time = psutil.boot_time()
    load = os.getloadavg() if hasattr(os, "getloadavg") else (None, None, None)
    return {
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "timestamp": time.time(),
        "uptime_seconds": int(time.time() - boot_time),
        "cpu": {
            "percent": psutil.cpu_percent(interval=0.2),
            "count": psutil.cpu_count(),
            "temperature_c": cpu_temperature(),
            "load_avg": [round(x, 2) if x is not None else None for x in load],
        },
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "percent": mem.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "percent": disk.percent,
        },
        "network": network_stats(),
    }


@app.route("/")
def index():
    refresh = int(os.environ.get("DASHBOARD_REFRESH", "3"))
    return render_template("index.html", refresh_ms=max(refresh, 1) * 1000)


@app.route("/api/stats")
def api_stats():
    return jsonify(collect_stats())


@app.route("/healthz")
def healthz():
    return {"status": "ok"}


if __name__ == "__main__":
    app.run(
        host=os.environ.get("DASHBOARD_HOST", "0.0.0.0"),
        port=int(os.environ.get("DASHBOARD_PORT", "8080")),
    )
