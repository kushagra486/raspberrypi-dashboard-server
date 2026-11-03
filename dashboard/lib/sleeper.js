// Sleep / wake for isolated projects in auto-sleep mode.
//
// Wake: iso-proxy asks  GET /wake?project=<name>  (Caddy forward_auth, with a secret token) before
// every request to an auto-sleep project. If its containers are stopped we start them and answer
// once they accept connections, so the waiting request then succeeds. Awake: we answer at once.
// The listener binds only to the Docker network gateway of the Supabase network (WAKER_ADDR in
// isolated/waker.env), so it is reachable from the proxy, not from the LAN or the internet.
//
// Sleep: every minute, auto-sleep projects idle longer than their SLEEP_AFTER_MIN are stopped.
// Memory guard: if available memory drops below memoryGuardMb, the least recently used awake
// auto-sleep project is stopped first (one per check), before the Pi starts to struggle.
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

function availableMemoryMb() {
  const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
  return m ? Math.round(Number(m[1]) / 1024) : Infinity;
}

class Sleeper {
  constructor(cfg, docker, database) {
    this.cfg = cfg;
    this.docker = docker;
    this.db = database;
    this.file = path.join(cfg.dataDir, 'activity.json');
    this.lastActive = {};
    this.events = [];
    this.waking = new Map();
    this.server = null;
    this.load();
  }

  load() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.lastActive = d.lastActive || {}; this.events = d.events || []; }
    catch { /* first run */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ lastActive: this.lastActive, events: this.events.slice(-200) }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* not fatal */ }
  }

  event(project, what, why) {
    this.events.push({ at: Date.now(), project, what, why });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    this.save();
  }

  wakerEnv() {
    const out = {};
    try {
      for (const l of fs.readFileSync(path.join(this.db.isoDir(), 'waker.env'), 'utf8').split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) out[m[1]] = m[2];
      }
    } catch { /* no isolated projects yet */ }
    return out;
  }

  settings(name) {
    const env = this.db.isoProject(name) || {};
    const mins = Number(env.SLEEP_AFTER_MIN) || 30;
    return { mode: env.SLEEP_MODE === 'auto' ? 'auto-sleep' : 'always-on', sleepAfterMin: mins };
  }

  touch(name) { this.lastActive[name] = Date.now(); }

  containers(name) { return [`iso-${name}-auth`, `iso-${name}-rest`]; }

  async isAwake(name) {
    const states = await Promise.all(this.containers(name).map(c => this.docker.state(c)));
    return states.every(s => s === 'running' || s === 'healthy');
  }

  async containerIp(id) {
    const i = await this.docker.request('GET', `/containers/${id}/json`);
    return Object.values(i.NetworkSettings?.Networks || {}).map(n => n.IPAddress).find(Boolean);
  }

  // ready = Auth's /health and PostgREST's admin /ready (schema cache loaded) both answer 200
  httpOk(host, port, pathName, ms = 1500) {
    return new Promise(resolve => {
      const r = http.get({ host, port, path: pathName, timeout: ms }, res => { res.resume(); resolve(res.statusCode === 200); });
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.on('error', () => resolve(false));
    });
  }

  portOpen(host, port, ms = 800) {
    return new Promise(resolve => {
      const s = net.connect({ host, port, timeout: ms });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('timeout', () => { s.destroy(); resolve(false); });
      s.once('error', () => resolve(false));
    });
  }

  // Start both containers if needed and wait until they accept connections (max ~25 s).
  ensureAwake(name, why = 'request') {
    if (this.waking.has(name)) return this.waking.get(name);
    const p = (async () => {
      this.touch(name);
      if (await this.isAwake(name)) return true;
      const started = Date.now();
      for (const c of this.containers(name)) await this.docker.request('POST', `/containers/${c}/start`).catch(() => {});
      const [authId, restId] = this.containers(name);
      for (let i = 0; i < 100; i++) {
        const [a, r] = await Promise.all([this.containerIp(authId).catch(() => null), this.containerIp(restId).catch(() => null)]);
        if (a && r && await this.httpOk(a, 9999, '/health') && await this.httpOk(r, 3001, '/ready')) {
          this.event(name, 'wake', `${why}, ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
          return true;
        }
        await new Promise(res => setTimeout(res, 250));
      }
      this.event(name, 'wake-failed', `${why}: not ready after 25 s`);
      return false;
    })().finally(() => this.waking.delete(name));
    this.waking.set(name, p);
    return p;
  }

  async putToSleep(name, why) {
    for (const c of this.containers(name)) await this.docker.request('POST', `/containers/${c}/stop?t=5`).catch(() => {});
    this.event(name, 'sleep', why);
  }

  // one pass of the sleep loop; exported for tests
  async check({ now = Date.now(), availableMb = null } = {}) {
    const autos = this.db.isoNames().filter(n => this.settings(n).mode === 'auto-sleep');
    const awake = [];
    for (const n of autos) {
      if (this.waking.has(n) || !(await this.isAwake(n))) continue;
      if (this.lastActive[n] == null) { this.touch(n); continue; }   // unknown: start the clock now
      const idleMin = (now - this.lastActive[n]) / 60000;
      if (idleMin >= this.settings(n).sleepAfterMin) await this.putToSleep(n, `idle for ${Math.round(idleMin)} min`);
      else awake.push(n);
    }
    const avail = availableMb ?? availableMemoryMb();
    const guard = this.cfg.memoryGuardMb || 400;
    if (avail < guard && awake.length) {
      const lru = awake.sort((a, b) => (this.lastActive[a] || 0) - (this.lastActive[b] || 0))[0];
      await this.putToSleep(lru, `memory guard: only ${avail} MB available (< ${guard} MB), least recently used`);
    }
    this.save();
  }

  status() {
    return {
      wakerAddr: this.wakerEnv().WAKER_ADDR || null, listening: !!(this.server && this.server.listening),
      projects: Object.fromEntries(this.db.isoNames().map(n => [n, { ...this.settings(n), lastActive: this.lastActive[n] || null }])),
      events: this.events.slice(-50).reverse(),
    };
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://waker');
    const env = this.wakerEnv();
    const token = String(req.headers['x-waker-token'] || '');
    const ok = env.WAKER_TOKEN && token.length === env.WAKER_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(env.WAKER_TOKEN));
    if (url.pathname !== '/wake' || !ok) { res.writeHead(403); return res.end(); }
    const name = url.searchParams.get('project') || '';
    if (!this.db.isoProject(name)) { res.writeHead(404); return res.end(); }
    this.ensureAwake(name).then(up => { res.writeHead(up ? 200 : 503, { 'Retry-After': '5' }); res.end(); },
      () => { res.writeHead(503); res.end(); });
  }

  start() {
    const listen = () => {
      const addr = this.wakerEnv().WAKER_ADDR;
      if (!addr || (this.server && this.server.listening)) return;
      const [host, port] = addr.split(':');
      const srv = http.createServer((q, s) => this.handle(q, s));
      srv.on('error', () => { /* network not up yet: retried below */ });
      srv.listen(Number(port), host, () => { this.server = srv; console.log(`Pi Console waker on ${addr}`); });
    };
    listen();
    const every = (this.cfg.sleepCheckSec || 60) * 1000;
    this.timer = setInterval(() => { listen(); this.check().catch(() => {}); }, every);
    this.timer.unref();
  }
}

module.exports = { Sleeper, availableMemoryMb };
