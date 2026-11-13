import app as dashboard


def client():
    dashboard.app.config["TESTING"] = True
    return dashboard.app.test_client()


def test_index_renders():
    res = client().get("/")
    assert res.status_code == 200
    assert b"Pi Dashboard" in res.data


def test_stats_shape():
    res = client().get("/api/stats")
    assert res.status_code == 200
    data = res.get_json()
    for key in ("hostname", "uptime_seconds", "cpu", "memory", "disk", "network"):
        assert key in data
    assert 0 <= data["cpu"]["percent"] <= 100
    assert 0 <= data["memory"]["percent"] <= 100
    assert 0 <= data["disk"]["percent"] <= 100
    assert all(n["name"] != "lo" for n in data["network"])


def test_temperature_from_thermal_zone(tmp_path, monkeypatch):
    zone = tmp_path / "temp"
    zone.write_text("48312\n")
    monkeypatch.setattr(dashboard, "THERMAL_ZONE", str(zone))
    assert dashboard.cpu_temperature() == 48.3


def test_temperature_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(dashboard, "THERMAL_ZONE", str(tmp_path / "missing"))
    monkeypatch.setattr(dashboard.psutil, "sensors_temperatures", lambda: {}, raising=False)
    assert dashboard.cpu_temperature() is None


def test_healthz():
    assert client().get("/healthz").get_json() == {"status": "ok"}
