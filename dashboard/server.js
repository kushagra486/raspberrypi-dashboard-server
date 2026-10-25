// Pi Console: one dashboard for the Pi. Plain Node http + ws, no framework.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const config = require('./lib/config');
const { Auth, parseCookies } = require('./lib/auth');
const system = require('./lib/system');
const { Docker } = require('./lib/docker');
const { Sessions } = require('./lib/sessions');
const { Database } = require('./lib/db');
const { Backups } = require('./lib/backups');
const { Snippets } = require('./lib/snippets');

const cfg = config.load();
const auth = new Auth({ passwordHash: cfg.passwordHash, ttlHours: cfg.sessionTtlHours });
const docker = new Docker(cfg.dockerSocket);
const sessions = new Sessions(cfg);
const rootDatabase = new Database(cfg, docker);
const backups = new Backups(cfg);
const snippets = new Snippets(path.join(cfg.dataDir, 'snippets.json'));

const PUBLIC = path.join(config.ROOT, 'public');
const VENDOR = {
  'xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  'xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  'addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const COOKIE = 'pc_session';

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function clientIp(req) {
  // Behind cloudflared every request comes from localhost; trust its header only then.
  const direct = req.socket.remoteAddress;
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(direct) && req.headers['cf-connecting-ip']) return req.headers['cf-connecting-ip'];
  return direct;
}

// State-changing requests and terminal sockets must come from this site's own pages.
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (cfg.allowedOrigins.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// cloudflared reaches us from localhost and marks tunnel traffic as HTTPS.
function viaHttps(req) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return cfg.secureCookies || (local && req.headers['x-forwarded-proto'] === 'https');
}

function token(req) { return parseCookies(req.headers.cookie)[COOKIE]; }

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  let m;

  if (route === 'GET /api/system') return send(res, 200, await system.snapshot(cfg.disks));
  if (route === 'GET /api/links') return send(res, 200, cfg.links);
  if (route === 'GET /api/backups') return send(res, 200, await backups.list());
  if (route === 'GET /api/snippets') return send(res, 200, snippets.list());
  if (route === 'POST /api/snippets' || route === 'DELETE /api/snippets') {
    try {
      if (req.method === 'DELETE') return send(res, 200, snippets.remove(url.searchParams.get('name') || ''));
      return send(res, 200, snippets.save(await readJson(req, 200 * 1024)));
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }
  if (route === 'GET /api/backups/status') return send(res, 200, await backups.status());
  if (route === 'GET /api/backups/download') {
    let file;
    try { file = backups.dumpPath(url.searchParams.get('name')); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
    });
    return fs.createReadStream(file).pipe(res);
  }
  if (route === 'POST /api/backups/run' || route === 'POST /api/backups/restore-test') {
    try {
      const { name } = await readJson(req);
      return send(res, 200, await backups.run(route.endsWith('run') ? 'backup' : 'restore-test', name));
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }

  if (route === 'GET /api/docker') {
    try { return send(res, 200, await docker.list()); }
    catch (e) { return send(res, 503, { error: `Docker unavailable: ${e.message}` }); }
  }
  if ((m = url.pathname.match(/^\/api\/docker\/([^/]+)\/logs$/)) && req.method === 'GET') {
    return send(res, 200, { logs: await docker.logs(m[1], url.searchParams.get('tail')) });
  }
  if ((m = url.pathname.match(/^\/api\/docker\/([^/]+)\/(start|stop|restart)$/)) && req.method === 'POST') {
    await docker.action(m[1], m[2]);
    return send(res, 200, { ok: true });
  }

  // ---- database section
  if (url.pathname.startsWith('/api/db/')) {
    try {
      // ?db=proj_<name> scopes every database screen to one isolated project's own database
      const dbParam = url.searchParams.get('db');
      const database = dbParam ? rootDatabase.forDb(dbParam) : rootDatabase;
      if (route === 'POST /api/db/isolated') {
        const { name, orgId } = await readJson(req);
        return send(res, 201, await rootDatabase.createIsolated(name, orgId ?? null));
      }
      if (route === 'DELETE /api/db/isolated') return send(res, 200, await rootDatabase.deleteIsolated(url.searchParams.get('name') || ''));
      if (route === 'GET /api/db/overview') return send(res, 200, { ...(await database.overview()), studioUrl: cfg.studioUrl });
      if (route === 'GET /api/db/projects') return send(res, 200, await database.projects());
      if (route === 'GET /api/db/tables') return send(res, 200, await database.tables(url.searchParams.get('schema') || ''));
      if (route === 'GET /api/db/table') {
        return send(res, 200, await database.table(url.searchParams.get('schema') || '', url.searchParams.get('name') || '', {
          limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'),
        }));
      }
      if (route === 'GET /api/db/users') return send(res, 200, await database.authUsers());
      if (route === 'GET /api/db/buckets') return send(res, 200, await database.buckets());
      if (route === 'GET /api/db/orgs') return send(res, 200, await rootDatabase.orgs());
      if (route === 'POST /api/db/orgs') return send(res, 201, await rootDatabase.createOrg((await readJson(req)).name));
      if (route === 'PATCH /api/db/orgs') { const b = await readJson(req); return send(res, 200, await rootDatabase.renameOrg(b.id, b.name)); }
      if (route === 'DELETE /api/db/orgs') return send(res, 200, await rootDatabase.deleteOrg(url.searchParams.get('id')));
      if (route === 'POST /api/db/projects/move') { const b = await readJson(req); return send(res, 200, await rootDatabase.moveProject(b.schema, b.orgId)); }
      if (route === 'GET /api/db/diagram') return send(res, 200, await database.diagram(url.searchParams.get('schema') || ''));
      if (route === 'GET /api/db/migrations') return send(res, 200, await database.migrations());
      if (route === 'POST /api/db/branch') {
        const { schema, withData, reset } = await readJson(req);
        return send(res, 200, await database.branch(schema, { withData: !!withData, reset: !!reset }));
      }
      if (route === 'DELETE /api/db/branch') return send(res, 200, await database.deleteBranch(url.searchParams.get('schema') || ''));
      if (route === 'GET /api/db/connect') return send(res, 200, await rootDatabase.connectInfo(url.searchParams.get('schema') || ''));
      if (route === 'POST /api/db/rows') return send(res, 200, await database.writeRow(await readJson(req, 1024 * 1024)));
      if (route === 'GET /api/db/export') {
        const schema = url.searchParams.get('schema') || '', name = url.searchParams.get('name') || '';
        const body = await database.exportCsv(schema, name);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${`${schema}.${name}`.replace(/[^\w.-]/g, '_')}.csv"`,
        });
        return res.end(body);
      }
      if (route === 'POST /api/db/import') {
        const { schema, name, csv } = await readJson(req, 10 * 1024 * 1024);
        return send(res, 200, await database.importCsv(schema || '', name || '', csv || ''));
      }
      if (route === 'GET /api/db/advisors') return send(res, 200, await database.advisors());
      if (route === 'GET /api/db/insights') {
        return send(res, 200, await database.insights({ sort: url.searchParams.get('sort') || 'total', limit: url.searchParams.get('limit') }));
      }
      if (route === 'POST /api/db/sql') {
        const { sql, readOnly } = await readJson(req, 200 * 1024);
        return send(res, 200, await database.run(sql, { readOnly: readOnly !== false }));
      }
      if (route === 'POST /api/db/projects') {
        const { name, orgId } = await readJson(req);
        return send(res, 201, await rootDatabase.createProject(name, orgId ?? null));
      }
    } catch (e) {
      return send(res, e.sql ? 400 : 502, { error: e.message });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (route === 'GET /api/sessions') return send(res, 200, await sessions.list());
  if (route === 'GET /api/folders') return send(res, 200, sessions.folders());
  if (route === 'POST /api/sessions') return send(res, 201, await sessions.create(await readJson(req)));
  if (route === 'POST /api/folders') {
    const { root, name } = await readJson(req);
    if (!cfg.projectRoots.includes(root)) throw new Error('Unknown project root.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name || '')) throw new Error('Folder name: letters, digits, . _ - only.');
    const dir = path.join(root, name);
    await fs.promises.mkdir(dir, { recursive: false });
    return send(res, 201, { dir });
  }
  if ((m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)) && req.method === 'DELETE') {
    await sessions.kill(m[1]);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/login' && req.method === 'GET') return serveFile(res, path.join(PUBLIC, 'login.html'));
    if (url.pathname.startsWith('/static/')) {
      const name = path.basename(url.pathname);
      return serveFile(res, path.join(PUBLIC, name));
    }
    if (url.pathname.startsWith('/vendor/')) {
      const file = VENDOR[path.basename(url.pathname)];
      return file ? serveFile(res, file) : send(res, 404, 'Not found', 'text/plain');
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!originOk(req)) return send(res, 403, { error: 'bad origin' });
      const { password } = await readJson(req, 4096);
      const r = auth.login(clientIp(req), password);
      if (!r.ok) return send(res, 401, { error: r.error });
      const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${cfg.sessionTtlHours * 3600}`];
      if (viaHttps(req)) flags.push('Secure');
      res.setHeader('Set-Cookie', `${COOKIE}=${r.token}; ${flags.join('; ')}`);
      return send(res, 200, { ok: true });
    }

    const authed = auth.check(token(req));
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      auth.logout(token(req));
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authed) return send(res, 401, { error: 'login required' });
      if (req.method !== 'GET' && !originOk(req)) return send(res, 403, { error: 'bad origin' });
      return await api(req, res, url);
    }
    if (!authed) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
    return send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

// Browser terminal: /ws/term?session=<name> attaches to that tmux session through a pty.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws/term' || !auth.check(token(req)) || !originOk(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  let target;
  try { target = sessions.tmuxTarget(url.searchParams.get('session')); }
  catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => attachTerminal(ws, target));
});

function attachTerminal(ws, target) {
  const pty = require('node-pty');
  const term = pty.spawn('tmux', ['attach-session', '-t', target], {
    name: 'xterm-256color', cols: 120, rows: 32, cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  term.onData(d => { if (ws.readyState === ws.OPEN) ws.send(d); });
  term.onExit(() => ws.close());
  // Client protocol: "0<data>" keystrokes, "1{cols,rows}" resize.
  ws.on('message', raw => {
    const msg = raw.toString();
    if (msg[0] === '0') term.write(msg.slice(1));
    else if (msg[0] === '1') {
      try {
        const { cols, rows } = JSON.parse(msg.slice(1));
        if (cols > 0 && rows > 0 && cols < 1000 && rows < 500) term.resize(cols, rows);
      } catch {}
    }
  });
  // Closing the tab only detaches; the tmux session keeps running.
  ws.on('close', () => { try { term.kill(); } catch {} });
}

if (!cfg.passwordHash) console.warn('WARNING: no password set. Run `npm run set-password` before using the console.');
server.listen(cfg.port, cfg.bind, () => console.log(`Pi Console on http://${cfg.bind}:${cfg.port}`));

module.exports = { server };
