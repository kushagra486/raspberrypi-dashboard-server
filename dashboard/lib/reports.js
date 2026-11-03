// Reports (Supabase "Reports" / observability): API traffic over time, database activity history from
// the metrics sampler, and auth activity per day. Read-only.
const logs = require('./logs');

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null; }

async function apiTraffic({ docker, project, hours }) {
  const iso = project.startsWith('iso:') ? project.slice(4) : null;
  const container = iso ? 'iso-proxy' : 'supabase-kong';
  const prefix = iso ? `/p/${iso}/` : null;
  const text = await docker.logsSince(container, hours * 3600, 200000, true);
  const end = Date.now(), start = end - hours * 3600000, n = hours <= 1 ? 30 : hours <= 24 ? 24 * (hours <= 6 ? 4 : 1) : 28;
  const w = (end - start) / n;
  const buckets = Array.from({ length: n }, (_, i) => ({ t: Math.round(start + (i + 1) * w), ok: 0, c4: 0, c5: 0, ms: [] }));
  const paths = new Map(), statuses = new Map();
  let total = 0;
  for (const line of text.split('\n')) {
    if (prefix && !line.includes(prefix)) continue;
    const e = logs.parseLine(line);
    if (!e || e.status == null || !e.path) continue;
    if (prefix && !e.path.startsWith(prefix)) continue;
    if (e.ts < start) continue;
    total++;
    const b = buckets[Math.min(n - 1, Math.max(0, Math.floor((e.ts - start) / w)))];
    if (e.status >= 500) b.c5++; else if (e.status >= 400) b.c4++; else b.ok++;
    if (e.ms != null) b.ms.push(e.ms);
    const p = logs.redact(e.path).split('?')[0].replace(prefix ? prefix.slice(0, -1) : '', '').replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id');
    const key = `${e.method} ${p}`;
    paths.set(key, (paths.get(key) || 0) + 1);
    statuses.set(e.status, (statuses.get(e.status) || 0) + 1);
  }
  const all = [];
  const out = buckets.map(b => {
    const s = b.ms.sort((x, y) => x - y); all.push(...s);
    return { t: b.t, ok: b.ok, c4: b.c4, c5: b.c5, p50: pct(s, 0.5), p95: pct(s, 0.95) };
  });
  all.sort((x, y) => x - y);
  const errors = out.reduce((a, b) => a + b.c5, 0);
  return {
    shared: !iso, total, errors, clientErrors: out.reduce((a, b) => a + b.c4, 0),
    errorRate: total ? Math.round((errors / total) * 1000) / 10 : 0,
    p50: pct(all, 0.5), p95: pct(all, 0.95), latency: all.length > 0,
    buckets: out,
    top: [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => ({ path: k, n: c })),
    statuses: [...statuses.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ status: s, n: c })),
  };
}

async function authActivity(pg) {
  const rows = await pg.q(`
    with days as (select generate_series(current_date - 29, current_date, '1 day')::date as d)
    select to_char(d, 'YYYY-MM-DD') as day,
      (select count(*) from auth.users u where u.created_at::date = d)::int as signups,
      (select count(*) from auth.audit_log_entries a where a.created_at::date = d
         and a.payload->>'action' in ('login', 'token_refreshed'))::int as signins
    from days order by d`);
  return rows;
}

async function build({ docker, db, metrics, project, hours = 24 }) {
  project = String(project || '');
  const iso = project.startsWith('iso:') ? project.slice(4) : null;
  if (iso && !db.isoProject(iso)) throw new Error('No such isolated project');
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 7);
  const database = iso ? `proj_${iso}` : 'postgres';
  const pg = iso ? db.forDb(database) : db;
  const [api, auth] = await Promise.all([
    apiTraffic({ docker, project, hours: h }).catch(e => ({ error: e.message })),
    authActivity(pg).catch(e => ({ error: e.message })),
  ]);
  return {
    project, hours: h, database, sharedDatabase: !iso,
    api, auth,
    db: metrics ? metrics.get(`db:${database}`, Math.min(h, 24)) : [],
  };
}

module.exports = { build, apiTraffic };
