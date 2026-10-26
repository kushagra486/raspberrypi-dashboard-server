// Minute-by-minute history for the Reports pages: per database (main + each isolated project) and the Pi
// itself. One cheap query per minute; 24 hours kept in memory and saved to dataDir/metrics.json every
// 5 minutes so a restart keeps the history. Nothing here is secret.
const fs = require('fs');
const path = require('path');

const KEEP = 24 * 60;  // points (minutes)

class Metrics {
  constructor(cfg, db, system) {
    this.cfg = cfg; this.db = db; this.system = system;
    this.file = path.join(cfg.dataDir, 'metrics.json');
    this.series = {};      // key -> [{t, ...}]; keys: "db:<datname>", "host"
    this.last = {};        // previous raw counters per database, for rates
    this.load();
  }

  load() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.series = d.series || {}; } catch { /* first run */ }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ series: this.series }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* not fatal */ }
  }
  push(key, point) {
    const s = this.series[key] || (this.series[key] = []);
    s.push(point);
    if (s.length > KEEP) s.splice(0, s.length - KEEP);
  }

  async sample(now = Date.now()) {
    const rows = await this.db.q(`
      select datname, numbackends::int as conns, (xact_commit + xact_rollback)::text as xacts,
             blks_hit::text as hit, blks_read::text as read,
             (tup_inserted + tup_updated + tup_deleted)::text as writes, (tup_returned + tup_fetched)::text as reads,
             pg_database_size(datid)::text as size
        from pg_stat_database where datname = 'postgres' or datname like 'proj\\_%'`);
    for (const r of rows) {
      const cur = { t: now, xacts: Number(r.xacts), hit: Number(r.hit), read: Number(r.read), writes: Number(r.writes), reads: Number(r.reads) };
      const prev = this.last[r.datname];
      this.last[r.datname] = cur;
      if (!prev || now - prev.t > 5 * 60000) continue;   // need two samples close together for rates
      const mins = (now - prev.t) / 60000;
      const d = k => Math.max(0, cur[k] - prev[k]);
      const blocks = d('hit') + d('read');
      this.push(`db:${r.datname}`, {
        t: now, conns: r.conns, size: Number(r.size),
        tpm: Math.round(d('xacts') / mins), writes: Math.round(d('writes') / mins), reads: Math.round(d('reads') / mins),
        cacheHit: blocks ? Math.round((d('hit') / blocks) * 1000) / 10 : null,
      });
    }
    try {
      const s = await this.system.snapshot(this.cfg.disks || ['/']);
      this.push('host', { t: now, cpu: s.cpu, mem: s.memory.total ? Math.round((s.memory.used / s.memory.total) * 1000) / 10 : null,
        temp: s.temperature, load: s.load ? s.load[0] : null });
    } catch { /* host stats unavailable */ }
  }

  get(key, hours = 24) {
    const since = Date.now() - Math.min(Math.max(Number(hours) || 24, 1), 24) * 3600000;
    return (this.series[key] || []).filter(p => p.t >= since);
  }

  start() {
    const every = (this.cfg.metricsEverySec || 60) * 1000;
    let n = 0;
    const tick = () => this.sample().then(() => { if (++n % 5 === 0) this.save(); }).catch(() => {});
    tick();
    this.timer = setInterval(tick, every); this.timer.unref();
  }
}

module.exports = { Metrics };
