// Pi Console front end: vanilla JS, no build step.
const $ = s => document.querySelector(s);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(k ?? ''));
  return n;
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const fmtBytes = b => {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtAge = ms => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const fmtUptime = s => `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h ${Math.floor(s % 3600 / 60)}m`;

// ---- tabs
let current = 'overview';
const loaders = {};
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  current = b.dataset.tab;
  location.hash = current;
  loaders[current]?.();
}));

// ---- overview
function meter(label, value, max, text) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const level = pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'ok';
  return el('div', { class: 'card' },
    el('div', { class: 'card-label' }, label),
    el('div', { class: 'card-value' }, text),
    el('div', { class: 'bar' }, el('div', { class: `fill ${level}`, style: `width:${pct.toFixed(1)}%` })));
}

loaders.overview = async () => {
  const s = await api('/api/system');
  $('#host').textContent = s.hostname;
  const m = s.memory;
  const cards = [
    meter('CPU', s.cpu ?? 0, 100, s.cpu == null ? '…' : `${s.cpu}% · ${s.cpus} cores`),
    meter('Memory', m.used, m.total, `${fmtBytes(m.used)} / ${fmtBytes(m.total)}`),
    meter('Swap', m.swapUsed, m.swapTotal || 1, m.swapTotal ? `${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)}` : 'none'),
    meter('Temperature', s.temperature ?? 0, 85, s.temperature == null ? 'n/a' : `${s.temperature.toFixed(1)} °C`),
    ...s.disks.map(d => d.error
      ? el('div', { class: 'card' }, el('div', { class: 'card-label' }, `Disk ${d.path}`), el('div', { class: 'card-value muted' }, d.error))
      : meter(`Disk ${d.path}`, d.used, d.total, `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`)),
    el('div', { class: 'card' }, el('div', { class: 'card-label' }, 'Uptime · load'),
      el('div', { class: 'card-value' }, `${fmtUptime(s.uptime)} · ${s.load.map(x => x.toFixed(2)).join(' ')}`)),
  ];
  $('#stats').replaceChildren(...cards);
};

// ---- claude / shell sessions
loaders.claude = async () => {
  const [list, folders] = await Promise.all([api('/api/sessions'), api('/api/folders')]);
  const dirSel = $('#s-dir');
  const keep = dirSel.value;
  dirSel.replaceChildren(...folders.map(f => el('option', { value: f.path }, f.label)));
  if (folders.some(f => f.path === keep)) dirSel.value = keep;
  $('#f-root').replaceChildren(...folders.filter(f => f.root).map(f => el('option', { value: f.path }, f.label)));
  $('#sessions').replaceChildren(...(list.length ? list.map(s => el('tr', {},
    el('td', {}, el('b', {}, s.name)),
    el('td', {}, el('span', { class: `tag ${s.kind}` }, s.kind === 'claude' ? 'Claude Code' : 'Shell')),
    el('td', { class: 'mono' }, s.cwd),
    el('td', {}, fmtAge(s.created)),
    el('td', { class: 'actions' },
      el('button', { onclick: () => openTerminal(s.name) }, 'Open'),
      el('button', { class: 'danger', onclick: async () => {
        if (!confirm(`End session "${s.name}"? Anything running in it stops.`)) return;
        await api(`/api/sessions/${s.name}`, { method: 'DELETE' });
        loaders.claude();
      } }, 'End')))) : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No sessions yet. Start one above.'))]));
};

$('#new-session').addEventListener('submit', async e => {
  e.preventDefault();
  $('#s-error').textContent = '';
  try {
    const s = await api('/api/sessions', { method: 'POST', body: { name: $('#s-name').value, dir: $('#s-dir').value, kind: $('#s-kind').value } });
    $('#s-name').value = '';
    await loaders.claude();
    openTerminal(s.name);
  } catch (err) { $('#s-error').textContent = err.message; }
});

$('#new-folder').addEventListener('submit', async e => {
  e.preventDefault();
  $('#s-error').textContent = '';
  try {
    const r = await api('/api/folders', { method: 'POST', body: { root: $('#f-root').value, name: $('#f-name').value } });
    $('#f-name').value = '';
    await loaders.claude();
    $('#s-dir').value = r.dir;
  } catch (err) { $('#s-error').textContent = err.message; }
});

// ---- terminal
let term, socket, fit;
function openTerminal(name) {
  closeTerminal();
  $('#term-title').textContent = name;
  $('#term-view').classList.remove('hidden');
  term = new Terminal({ cursorBlink: true, fontSize: 14, convertEol: false, scrollback: 5000,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#0b0f14' } });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#terminal'));
  fit.fit();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(name)}`);
  const sendSize = () => socket.readyState === 1 && socket.send('1' + JSON.stringify({ cols: term.cols, rows: term.rows }));
  socket.onopen = () => { sendSize(); term.focus(); };
  socket.onmessage = ev => term.write(ev.data);
  socket.onclose = () => term && term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
  term.onData(d => socket.readyState === 1 && socket.send('0' + d));
  term.onResize(sendSize);
  window.addEventListener('resize', onResize);
}
function onResize() { try { fit && fit.fit(); } catch {} }
function closeTerminal() {
  window.removeEventListener('resize', onResize);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  if (term) { term.dispose(); term = null; }
  $('#term-view').classList.add('hidden');
}
$('#term-close').addEventListener('click', () => { closeTerminal(); loaders.claude(); });

// ---- docker services
loaders.services = async () => {
  $('#d-error').textContent = '';
  let list;
  try { list = await api('/api/docker'); } catch (e) { $('#d-error').textContent = e.message; return; }
  list.sort((a, b) => (a.project || '').localeCompare(b.project || '') || a.name.localeCompare(b.name));
  const act = (c, verb) => async () => {
    if (verb === 'stop' && !confirm(`Stop ${c.name}?`)) return;
    try { await api(`/api/docker/${c.id}/${verb}`, { method: 'POST' }); }
    catch (e) { $('#d-error').textContent = e.message; }
    loaders.services();
  };
  $('#containers').replaceChildren(...list.map(c => el('tr', {},
    el('td', {}, el('b', {}, c.name), c.project ? el('div', { class: 'muted small' }, c.project) : ''),
    el('td', {}, el('span', { class: `tag ${c.state}` }, c.state), el('div', { class: 'muted small' }, c.status)),
    el('td', { class: 'mono small' }, c.image),
    el('td', { class: 'mono small' }, c.ports.join(', ')),
    el('td', { class: 'actions' },
      c.state === 'running'
        ? el('button', { onclick: act(c, 'restart') }, 'Restart')
        : el('button', { onclick: act(c, 'start') }, 'Start'),
      c.state === 'running' ? el('button', { class: 'danger', onclick: act(c, 'stop') }, 'Stop') : '',
      el('button', { class: 'ghost', onclick: () => showLogs(c) }, 'Logs')))));
};
async function showLogs(c) {
  $('#logs-panel').classList.remove('hidden');
  $('#logs-name').textContent = c.name;
  $('#logs').textContent = 'Loading…';
  try { $('#logs').textContent = (await api(`/api/docker/${c.id}/logs?tail=300`)).logs || '(no output)'; }
  catch (e) { $('#logs').textContent = e.message; }
  $('#logs').scrollTop = $('#logs').scrollHeight;
}
$('#logs-close').addEventListener('click', () => $('#logs-panel').classList.add('hidden'));

// ---- apps
loaders.apps = async () => {
  const links = await api('/api/links');
  $('#links').replaceChildren(...(links.length ? links.map(l => el('a', { class: 'card link', href: l.url, target: '_blank', rel: 'noopener' },
    el('div', { class: 'card-value' }, l.name),
    el('div', { class: 'muted' }, l.description || l.url))) : [el('p', { class: 'muted' }, 'Add links in config.json.')]));
};

// ---- backups
loaders.backups = async () => {
  const b = await api('/api/backups');
  $('#b-error').textContent = b.error || '';
  const rows = Array.isArray(b) ? b : [];
  $('#backups').replaceChildren(...(rows.length ? rows.map(f => el('tr', {},
    el('td', { class: 'mono' }, f.name), el('td', {}, fmtBytes(f.size)), el('td', {}, fmtAge(f.modified))))
    : [el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'No backups found.'))]));
};

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });

// Start on the tab in the URL, refresh live tabs every 5 s.
const start = location.hash.slice(1);
// Tabs whose code loads later (db.js) start their own loader once ready.
const startBtn = document.querySelector(`#tabs button[data-tab="${CSS.escape(start)}"]`);
(startBtn || document.querySelector('#tabs button[data-tab="overview"]')).click();
setInterval(() => {
  if (document.hidden || !$('#term-view').classList.contains('hidden')) return;
  if (current === 'overview' || current === 'services') loaders[current]().catch(() => {});
}, 5000);
