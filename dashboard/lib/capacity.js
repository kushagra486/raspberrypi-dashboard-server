// Capacity page data: where memory goes, every project's traffic and state, and the
// placement advisor's verdict. Read-only; actions go through the isolated-project script.
const fs = require('fs');
const placement = require('./placement');

const MB = 1048576;

function meminfoMb() {
  const m = {};
  for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const r = /^(\w+):\s+(\d+)/.exec(l); if (r) m[r[1]] = Math.round(Number(r[2]) / 1024);
  }
  return { totalMb: m.MemTotal, availableMb: m.MemAvailable, swapUsedMb: (m.SwapTotal || 0) - (m.SwapFree || 0) };
}

// requests per isolated project from iso-proxy's (key-free) access log
function trafficFromLog(text, sinceMs) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('"uri":"/p/');
    if (i < 0) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const m = /^\/p\/([a-z][a-z0-9_]{1,30})\//.exec(j.request?.uri || '');
    const ts = (j.ts || 0) * 1000;
    if (!m || ts < sinceMs) continue;
    const t = out[m[1]] || (out[m[1]] = { requests7d: 0, requests24h: 0, lastActive: 0 });
    t.requests7d++;
    if (ts > Date.now() - 86400000) t.requests24h++;
    if (ts > t.lastActive) t.lastActive = ts;
  }
  return out;
}

async function gather({ db, docker, sleeper, cfg }) {
  const mem = meminfoMb();

  // memory by part of the system
  const groups = { 'Supabase (main)': 0, 'Isolated projects': 0, 'Isolated proxy': 0, 'Other containers': 0 };
  const perProject = {};
  let containers = [];
  try { containers = await docker.list(); } catch { /* docker unavailable */ }
  await Promise.all(containers.filter(c => c.state === 'running').map(async c => {
    const m = await docker.memory(c.name);
    const mb = m ? m.usage / MB : 0;
    const iso = /^iso-([a-z][a-z0-9_]{1,30})-(auth|rest)$/.exec(c.name);
    if (iso) { groups['Isolated projects'] += mb; perProject[iso[1]] = (perProject[iso[1]] || 0) + mb; }
    else if (c.name === 'iso-proxy') groups['Isolated proxy'] += mb;
    else if (/^(supabase-|realtime)/.test(c.name)) groups['Supabase (main)'] += mb;
    else groups['Other containers'] += mb;
  }));
  const containersMb = Object.values(groups).reduce((a, b) => a + b, 0);
  const memory = {
    ...mem,
    usedMb: mem.totalMb - mem.availableMb,
    parts: [...Object.entries(groups).map(([name, mb]) => ({ name, mb: Math.round(mb) })),
      { name: 'System, Pi Console, cache', mb: Math.max(0, Math.round(mem.totalMb - mem.availableMb - containersMb)) }],
  };

  // database connections
  let connections = null;
  try {
    const [c] = await db.q(`select (select count(*) from pg_stat_activity)::int as used,
      (select setting::int from pg_settings where name = 'max_connections') as max`);
    connections = c;
  } catch { /* database down */ }

  // projects
  let traffic = {};
  try { traffic = trafficFromLog(await docker.logsSince(cfg.isoProxyContainer || 'iso-proxy', 7 * 86400, 500000), Date.now() - 7 * 86400000); }
  catch { /* no proxy yet */ }
  const shared = (await db.projects().catch(() => [])).map(p => ({ key: p.schema, name: p.schema, kind: 'shared', tables: p.tables }));
  const isolated = [];
  for (const p of await db.isolatedProjects().catch(() => [])) {
    const s = sleeper ? sleeper.settings(p.name) : { mode: 'always-on', sleepAfterMin: 30 };
    const t = traffic[p.name] || { requests7d: 0, requests24h: 0, lastActive: 0 };
    const seen = Math.max(t.lastActive || 0, (sleeper && sleeper.lastActive[p.name]) || 0) || null;
    isolated.push({
      key: `iso:${p.name}`, name: p.name, kind: 'isolated', users: p.users, tables: p.tables,
      mode: s.mode, sleepAfterMin: s.sleepAfterMin, awake: perProject[p.name] > 0,
      memoryMb: perProject[p.name] ? Math.round(perProject[p.name]) : 0,
      requests7d: t.requests7d, requests24h: t.requests24h, lastActive: seen,
    });
  }
  const verdict = placement.advise([...isolated, ...shared], mem);
  const byKey = Object.fromEntries(verdict.advice.map(a => [a.key, a]));
  return {
    memory, connections,
    limits: { isoMb: placement.ISO_MB, reserveMb: placement.RESERVE_MB, memoryGuardMb: cfg.memoryGuardMb || 400 },
    headroom: verdict.memory,
    projects: [...isolated, ...shared].map(p => ({ ...p, advice: byKey[p.key] })),
    sleeper: sleeper ? sleeper.status() : null,
  };
}

module.exports = { gather, trafficFromLog, meminfoMb };
