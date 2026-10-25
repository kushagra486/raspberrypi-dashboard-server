// Sleep / wake logic with a fake Docker and fake project settings (no containers needed).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Sleeper } = require('../lib/sleeper');
const { trafficFromLog } = require('../lib/capacity');

function setup(projects) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sleeper-'));
  const state = {};
  for (const n of Object.keys(projects)) { state[`iso-${n}-auth`] = 'running'; state[`iso-${n}-rest`] = 'running'; }
  const calls = [];
  const docker = {
    state: async c => state[c] || 'missing',
    request: async (method, p) => {
      calls.push(`${method} ${p}`);
      const m = /^\/containers\/([^/]+)\/(start|stop)/.exec(p);
      if (m) state[m[1]] = m[2] === 'start' ? 'running' : 'exited';
      return { NetworkSettings: { Networks: { n: { IPAddress: '127.0.0.1' } } } };
    },
  };
  fs.writeFileSync(path.join(tmp, 'waker.env'), 'WAKER_TOKEN=t0ken-for-tests\nWAKER_ADDR=127.0.0.1:0\n');
  const db = { isoDir: () => tmp, isoNames: () => Object.keys(projects), isoProject: n => projects[n] || null };
  const s = new Sleeper({ dataDir: tmp, memoryGuardMb: 400 }, docker, db);
  s.httpOk = async () => true;   // readiness is covered by the container test on the Pi
  return { s, state, calls, tmp };
}

test('idle auto-sleep projects are stopped; always-on and busy ones are not', async () => {
  const { s, state } = setup({ idle: { SLEEP_MODE: 'auto', SLEEP_AFTER_MIN: '10' }, busy: { SLEEP_MODE: 'auto', SLEEP_AFTER_MIN: '10' }, on: {} });
  const now = Date.now();
  s.lastActive = { idle: now - 11 * 60000, busy: now - 60000, on: now - 99 * 60000 };
  await s.check({ now, availableMb: 2000 });
  assert.strictEqual(state['iso-idle-rest'], 'exited');
  assert.strictEqual(state['iso-busy-rest'], 'running');
  assert.strictEqual(state['iso-on-rest'], 'running');
  assert.match(s.events.at(-1).why, /idle for 11 min/);
});

test('a project never seen starts its idle clock instead of sleeping at once', async () => {
  const { s, state } = setup({ fresh: { SLEEP_MODE: 'auto', SLEEP_AFTER_MIN: '5' } });
  await s.check({ availableMb: 2000 });
  assert.strictEqual(state['iso-fresh-rest'], 'running');
  assert.ok(s.lastActive.fresh);
});

test('memory guard sleeps the least recently used auto-sleep project, one per pass', async () => {
  const { s, state } = setup({ a: { SLEEP_MODE: 'auto' }, b: { SLEEP_MODE: 'auto' }, c: {} });
  const now = Date.now();
  s.lastActive = { a: now - 5 * 60000, b: now - 60000, c: now - 50 * 60000 };
  await s.check({ now, availableMb: 300 });
  assert.strictEqual(state['iso-a-rest'], 'exited');
  assert.strictEqual(state['iso-b-rest'], 'running');
  assert.strictEqual(state['iso-c-rest'], 'running', 'always-on is never touched');
  assert.match(s.events.at(-1).why, /memory guard/);
});

test('ensureAwake starts both containers once, even with parallel requests', async () => {
  const { s, state, calls } = setup({ x: { SLEEP_MODE: 'auto' } });
  state['iso-x-auth'] = state['iso-x-rest'] = 'exited';
  const r = await Promise.all([s.ensureAwake('x'), s.ensureAwake('x'), s.ensureAwake('x')]);
  assert.deepStrictEqual(r, [true, true, true]);
  assert.strictEqual(calls.filter(c => c.endsWith('/start')).length, 2);
  assert.strictEqual(s.events.at(-1).what, 'wake');
});

test('activity survives a restart (saved to the data dir)', async () => {
  const { s, tmp } = setup({ x: { SLEEP_MODE: 'auto' } });
  s.touch('x'); s.event('x', 'sleep', 'test');
  const again = new Sleeper({ dataDir: tmp }, {}, { isoDir: () => tmp });
  assert.ok(again.lastActive.x);
  assert.strictEqual(again.events.at(-1).why, 'test');
});

test('waker endpoint needs the token and a known project', async () => {
  const { s } = setup({ x: { SLEEP_MODE: 'auto' } });
  const srv = http.createServer((q, r) => s.handle(q, r));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const code = async (p, token) => (await fetch(base + p, { headers: token ? { 'x-waker-token': token } : {} })).status;
  try {
    assert.strictEqual(await code('/wake?project=x'), 403);
    assert.strictEqual(await code('/wake?project=x', 'wrong-token-here'), 403);
    assert.strictEqual(await code('/wake?project=nope', 't0ken-for-tests'), 404);
    assert.strictEqual(await code('/other?project=x', 't0ken-for-tests'), 403);
    assert.strictEqual(await code('/wake?project=x', 't0ken-for-tests'), 200);
  } finally { srv.close(); }
});

test('traffic per project from the proxy access log', () => {
  const now = Date.now() / 1000;
  const line = (uri, ts) => JSON.stringify({ ts, request: { uri } });
  const log = [line('/p/shop/rest/v1/items', now - 60), line('/p/shop/auth/v1/token', now - 3 * 86400),
    line('/p/blog/rest/v1/x', now - 9 * 86400), 'not json "uri":"/p/', line('/other', now)].join('\n');
  const t = trafficFromLog(log, Date.now() - 7 * 86400000);
  assert.deepStrictEqual(Object.keys(t), ['shop']);
  assert.strictEqual(t.shop.requests7d, 2);
  assert.strictEqual(t.shop.requests24h, 1);
});
