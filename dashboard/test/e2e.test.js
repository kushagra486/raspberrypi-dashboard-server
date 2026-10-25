// End-to-end: boots the real server on a random port and drives it like a browser.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { hashPassword } = require('../lib/auth');

const PASSWORD = 'correct horse battery';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-console-'));
const projects = path.join(tmp, 'projects');
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const origin = base;
let proc;
let cookie = '';

const call = (p, opts = {}) => fetch(base + p, {
  redirect: 'manual',
  ...opts,
  headers: { cookie, origin, 'content-type': 'application/json', ...(opts.headers || {}) },
});

before(async () => {
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'backups'));
  fs.writeFileSync(path.join(tmp, 'backups', 'db-20261010-033000.dump'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(tmp, 'backups', 'env-20261010-033000'), 'SECRET=1');
  fs.writeFileSync(path.join(tmp, 'fake-backup.sh'), '#!/bin/sh\necho "backup ok: $BACKUP_DIR"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'fake-restore.sh'), '#!/bin/sh\necho "restoring $1"; echo "RESTORE TEST PASSED"; touch "$BACKUP_DIR/.restore-test-ok"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    bind: '127.0.0.1', port, projectRoots: [projects], claudeBin: '/bin/true',
    backupDir: path.join(tmp, 'backups'), disks: ['/'], dockerSocket: path.join(tmp, 'no-docker.sock'),
    backupScript: path.join(tmp, 'fake-backup.sh'), restoreTestScript: path.join(tmp, 'fake-restore.sh'),
    links: [{ name: 'Supabase Studio', url: 'http://pi:8000' }],
  }));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PI_CONSOLE_CONFIG: path.join(tmp, 'config.json'), PI_CONSOLE_PASSWORD_HASH: hashPassword(PASSWORD), TMUX: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    proc.stdout.on('data', d => /Pi Console on/.test(d) && res());
    proc.on('exit', c => rej(new Error(`server exited ${c}`)));
  });
});

after(() => {
  try { execFileSync('tmux', ['kill-session', '-t', 'pc-e2e']); } catch {}
  proc && proc.kill();
});

test('unauthenticated requests are refused', async () => {
  assert.strictEqual((await call('/api/system')).status, 401);
  const r = await call('/');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
  assert.ok((await call('/login')).headers.get('content-security-policy').includes("default-src 'self'"));
});

test('login rejects a bad password and a foreign origin', async () => {
  assert.strictEqual((await call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) })).status, 401);
  const evil = await call('/api/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.strictEqual(evil.status, 403);
});

test('login sets an HttpOnly SameSite cookie', async () => {
  const r = await call('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  assert.strictEqual(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  assert.strictEqual((await call('/')).status, 200);
});

test('logins arriving through the tunnel (https from localhost) get a Secure cookie', async () => {
  const r = await call('/api/login', { method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /; Secure/);
});

test('system, links, backups and docker endpoints', async () => {
  const s = await (await call('/api/system')).json();
  assert.ok(s.memory.total > 0 && Array.isArray(s.disks));
  assert.strictEqual((await (await call('/api/links')).json())[0].name, 'Supabase Studio');
  const b = await (await call('/api/backups')).json();
  assert.strictEqual(b[0].name, 'db-20261010-033000.dump');
  const d = await call('/api/docker');
  assert.strictEqual(d.status, 503); // no docker socket in the test environment
});

test('state changes need a same-site origin even with a cookie', async () => {
  const r = await call('/api/sessions', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ name: 'x', dir: projects, kind: 'shell' }) });
  assert.strictEqual(r.status, 403);
});

test('sessions stay inside the project roots', async () => {
  const r = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'escape', dir: '/etc', kind: 'shell' }) });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /outside the allowed/);
  const folders = await (await call('/api/folders')).json();
  assert.ok(folders.some(f => f.path === path.join(projects, 'demo') && !f.root));
  assert.ok(folders.some(f => f.path === projects && f.root));
});

test('create a shell session, type into it over the websocket, then end it', async () => {
  const dir = path.join(projects, 'demo');
  const c = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'e2e', dir, kind: 'shell' }) });
  assert.strictEqual(c.status, 201, await c.text());
  const list = await (await call('/api/sessions')).json();
  assert.ok(list.some(s => s.name === 'e2e' && s.kind === 'shell'));

  // A foreign origin cannot open the terminal.
  await assert.rejects(new Promise((res, rej) => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws/term?session=e2e`, { headers: { cookie, origin: 'https://evil.example' } });
    bad.on('open', res); bad.on('error', rej);
  }));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term?session=e2e`, { headers: { cookie, origin } });
  let out = '';
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', d => { out += d.toString(); });
  ws.send('1' + JSON.stringify({ cols: 100, rows: 30 }));
  await new Promise(r => setTimeout(r, 800));
  ws.send('0echo PI_CONSOLE_$((6*7))\r');
  const deadline = Date.now() + 8000;
  while (!out.includes('PI_CONSOLE_42') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  ws.close();
  assert.ok(out.includes('PI_CONSOLE_42'), 'terminal output should contain the echoed result');

  // Closing the socket only detaches: the session is still there.
  await new Promise(r => setTimeout(r, 300));
  assert.ok((await (await call('/api/sessions')).json()).some(s => s.name === 'e2e'));
  assert.strictEqual((await call('/api/sessions/e2e', { method: 'DELETE' })).status, 200);
  assert.ok(!(await (await call('/api/sessions')).json()).some(s => s.name === 'e2e'));
});

test('a claude session starts in the chosen folder and falls back to a shell', async () => {
  const dir = path.join(projects, 'demo');
  const c = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'e2e', dir, kind: 'claude' }) });
  assert.strictEqual(c.status, 201, await c.text());
  await new Promise(r => setTimeout(r, 500));
  const s = (await (await call('/api/sessions')).json()).find(x => x.name === 'e2e');
  assert.strictEqual(s.kind, 'claude');
  assert.strictEqual(fs.realpathSync(s.cwd), fs.realpathSync(dir)); // claudeBin=/bin/true exited; shell remains
  assert.strictEqual((await call('/api/sessions/e2e', { method: 'DELETE' })).status, 200);
});

test('backups: status, run now, restore test, safe downloads', async () => {
  const st = await (await call('/api/backups/status')).json();
  assert.strictEqual(st.canRun, true); assert.strictEqual(st.restoreTestOk, null);
  const run = await (await call('/api/backups/run', { method: 'POST', body: '{}' })).json();
  assert.strictEqual(run.ok, true); assert.match(run.output, /backup ok/);
  const rt = await (await call('/api/backups/restore-test', { method: 'POST', body: JSON.stringify({ name: 'db-20261010-033000.dump' }) })).json();
  assert.strictEqual(rt.ok, true); assert.match(rt.output, /RESTORE TEST PASSED/);
  assert.ok((await (await call('/api/backups/status')).json()).restoreTestOk > 0);
  const bad = await call('/api/backups/restore-test', { method: 'POST', body: JSON.stringify({ name: '../../etc/passwd' }) });
  assert.strictEqual(bad.status, 400);
  const dl = await call('/api/backups/download?name=db-20261010-033000.dump');
  assert.strictEqual(dl.status, 200); assert.strictEqual((await dl.text()).length, 2048);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="db-20261010-033000.dump"/);
  assert.strictEqual((await call('/api/backups/download?name=env-20261010-033000')).status, 400); // secrets never served
  assert.strictEqual((await call('/api/backups/download?name=..%2Fconfig.json')).status, 400);
  assert.strictEqual((await call('/api/backups/download?name=db-20990101-000000.dump')).status, 404);
  const foreign = await call('/api/backups/run', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } });
  assert.strictEqual(foreign.status, 403);
});


test('logout ends the session', async () => {
  await call('/api/logout', { method: 'POST' });
  assert.strictEqual((await call('/api/system')).status, 401);
});

test('five wrong passwords lock the login', async () => {
  for (let i = 0; i < 5; i++) await call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  const r = await call('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  assert.strictEqual(r.status, 401);
  assert.match((await r.json()).error, /Too many attempts/);
});
