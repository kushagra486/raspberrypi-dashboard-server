// Logs explorer: reads the containers' own output (docker logs), parses the common formats into
// { ts, level, method, path, status, ms, msg } and REDACTS secrets before anything leaves the server.
// Nothing is stored; every request reads the last N minutes again.

// where each kind of log lives. Shared projects use the main stack, isolated ones their own containers.
const SOURCES = [
  { id: 'api', label: 'API gateway', shared: 'supabase-kong', iso: () => 'iso-proxy' },
  { id: 'auth', label: 'Auth', shared: 'supabase-auth', iso: n => `iso-${n}-auth` },
  { id: 'rest', label: 'REST (PostgREST)', shared: 'supabase-rest', iso: n => `iso-${n}-rest` },
  { id: 'storage', label: 'Storage', shared: 'supabase-storage' },
  { id: 'realtime', label: 'Realtime', shared: 'realtime-dev.supabase-realtime' },
  { id: 'functions', label: 'Edge functions', shared: 'supabase-edge-functions' },
  { id: 'db', label: 'Postgres', shared: 'supabase-db', iso: () => 'supabase-db' },
  { id: 'pooler', label: 'Connection pooler', shared: 'supabase-pooler' },
];

// ---- redaction: keys, tokens, passwords, connection strings, emails
const REDACT = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\b(sb_(?:publishable|secret)_)[A-Za-z0-9_-]+/g, '$1[redacted]'],
  [/(Bearer\s+)[^\s"',]+/gi, '$1[redacted]'],
  [/((?:api_?key|access_token|refresh_token|token|password|passwd|secret|code|signature|otp|key)=)[^&\s"',]+/gi, '$1[redacted]'],
  [/("(?:api_?key|access_token|refresh_token|token|password|secret|authorization|cookie|otp)"\s*:\s*")[^"]*"/gi, '$1[redacted]"'],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[redacted]@'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];
function redact(s) {
  let out = String(s);
  for (const [re, by] of REDACT) out = out.replace(re, by);
  return out;
}

const PINO = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };
const levelOf = (lvl, status, text) => {
  if (typeof lvl === 'number') return PINO[lvl] || 'info';
  if (lvl) {
    const l = String(lvl).toLowerCase();
    if (/err|fatal|panic|crit/.test(l)) return 'error';
    if (/warn/.test(l)) return 'warn';
    if (/debug|trace/.test(l)) return 'debug';
  }
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  if (!lvl && text && /\b(error|fatal|panic|exception)\b/i.test(text)) return 'error';
  if (!lvl && text && /\bwarn(ing)?\b/i.test(text)) return 'warn';
  return 'info';
};
const COMBINED = /^(\S+) \S+ \S+ \[[^\]]+\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+|-)(?: "[^"]*" "([^"]*)")?/;

// one docker line (with --timestamps) -> entry
function parseLine(line) {
  const sp = line.indexOf(' ');
  if (sp < 20) return null;
  const tsText = line.slice(0, sp);
  const ts = Date.parse(tsText);
  if (Number.isNaN(ts)) return null;
  const body = line.slice(sp + 1).replace(/\r$/, '');
  if (!body.trim()) return null;
  const e = { ts, level: 'info', method: null, path: null, status: null, ms: null, msg: '' };
  if (body[0] === '{') {
    try {
      const j = JSON.parse(body);
      const req = j.request || j.req || {};
      e.method = j.method || req.method || null;
      e.path = j.path || req.uri || req.url || j.url || null;
      const st = j.status ?? j.res?.statusCode ?? j.statusCode ?? null;
      e.status = typeof st === 'number' ? st : (st && /^\d{3}$/.test(st) ? Number(st) : null);
      const dur = j.duration ?? j.responseTime ?? null;
      if (typeof dur === 'number') e.ms = j.duration != null && dur < 100 ? Math.round(dur * 1000) : Math.round(dur);
      e.level = levelOf(j.level, e.status, null);
      const parts = [j.msg || j.message || ''];
      if (j.error) parts.push(typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
      if (j.component) parts.unshift(`[${j.component}]`);
      e.msg = parts.filter(Boolean).join(' ') || (e.method ? '' : body.slice(0, 400));
      return e;
    } catch { /* not JSON after all */ }
  }
  const m = COMBINED.exec(body);
  if (m) {
    e.method = m[2]; e.path = m[3]; e.status = Number(m[4]);
    e.level = levelOf(null, e.status, null);
    e.msg = m[6] ? `ua: ${m[6].slice(0, 80)}` : '';
    return e;
  }
  e.level = levelOf(null, null, body);
  e.msg = body.slice(0, 600);
  return e;
}

function finish(e) {
  if (e.path) e.path = redact(e.path).slice(0, 300);
  e.msg = redact(e.msg).slice(0, 600);
  return e;
}

async function read({ docker, db, project, source, minutes = 60, q = '', level = 'all', limit = 500 }) {
  const iso = String(project || '').startsWith('iso:') ? project.slice(4) : null;
  if (iso && !db.isoProject(iso)) throw new Error('No such isolated project');
  const src = SOURCES.find(s => s.id === source) || SOURCES[0];
  const available = SOURCES.filter(s => (iso ? !!s.iso : !!s.shared)).map(s => ({ id: s.id, label: s.label }));
  if (iso && !src.iso) return { sources: available, source: src.id, entries: [], histogram: [], note: `${src.label} is not available for isolated projects yet.` };
  const container = iso ? src.iso(iso) : src.shared;
  const mins = Math.min(Math.max(Number(minutes) || 60, 5), 7 * 24 * 60);
  let text;
  try { text = await docker.logsSince(container, mins * 60, 50000, true); }
  catch (e) { return { sources: available, source: src.id, entries: [], histogram: [], note: `Could not read ${container}: ${e.message}` }; }
  const prefix = iso && src.id === 'api' ? `/p/${iso}/` : null;
  const needle = String(q || '').toLowerCase().slice(0, 200);
  const all = [];
  for (const line of text.split('\n')) {
    if (prefix && !line.includes(prefix)) continue;
    const e = parseLine(line);
    if (!e) continue;
    if (prefix && !(e.path || '').startsWith(prefix)) continue;
    finish(e);
    all.push(e);
  }
  // histogram over the whole window (before text/level filters), 40 buckets
  const end = Date.now(), start = end - mins * 60000, n = 40, w = (end - start) / n;
  const histogram = Array.from({ length: n }, (_, i) => ({ t: Math.round(start + (i + 1) * w), info: 0, warn: 0, error: 0 }));
  for (const e of all) {
    const b = Math.min(n - 1, Math.max(0, Math.floor((e.ts - start) / w)));
    histogram[b][e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info']++;
  }
  const rank = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = level === 'error' ? 3 : level === 'warn' ? 2 : 0;
  const entries = all.filter(e => rank[e.level] >= min)
    .filter(e => !needle || `${e.method || ''} ${e.path || ''} ${e.status || ''} ${e.msg}`.toLowerCase().includes(needle))
    .slice(-Math.min(Math.max(Number(limit) || 500, 1), 2000)).reverse();
  const sharedNote = !iso && src.id !== 'db'
    ? 'Shared projects use one set of services, so this shows every shared project.' : null;
  return { sources: available, source: src.id, container, minutes: mins, total: all.length, entries, histogram,
    note: src.id === 'db' ? 'Postgres writes its detailed log inside the database container; this shows its console output (startup, errors).' : sharedNote };
}

module.exports = { read, parseLine, redact, SOURCES };
