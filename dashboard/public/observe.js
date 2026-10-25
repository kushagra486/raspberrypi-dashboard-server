// Logs explorer and Reports for the current project, plus the Server page's history chart.
// Uses el, api, fmtBytes, fmtAge, $ from app.js and window.pcChart from charts.js.
(() => {
  const C = { ok: '#3ecf8e', c4: '#f0b429', c5: '#f2665c', info: '#4f8f78', warn: '#f0b429', error: '#f2665c', p50: '#3ecf8e', p95: '#7cc7e8', a: '#3ecf8e', b: '#7cc7e8' };
  const keyOf = p => p.schema;
  const nf = n => (n == null ? '–' : Number(n).toLocaleString());
  const stat = (label, value, sub, tone) => el('div', { class: `card${tone ? ` status-${tone}` : ''}` },
    el('div', { class: 'card-label' }, label), el('div', { class: 'card-value' }, value), sub ? el('div', { class: 'muted small' }, sub) : '');
  const chartBox = (title, sub) => {
    const body = el('div', { class: 'chart-body' });
    return { box: el('figure', { class: 'chart-card' }, el('figcaption', {}, title, sub ? el('span', { class: 'muted small' }, ` ${sub}`) : ''), body), body };
  };
  const seg = (name, options, value, onChange) => {
    const g = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': name });
    options.forEach(([v, label]) => {
      const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '' }, label);
      b.addEventListener('click', () => { g.querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); onChange(v); });
      g.append(b);
    });
    return g;
  };

  // ---------------------------------------------------------------- logs
  const L = { source: 'api', minutes: 60, level: 'all', q: '', live: false, timer: null, proj: null };
  function buildLogs() {
    const root = $('#logs-root');
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    const q = el('input', { type: 'search', placeholder: 'Search path, status or message', 'aria-label': 'Search logs' });
    let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { L.q = q.value; loadLogs(); }, 300); });
    const range = el('select', { 'aria-label': 'Time range' }, ...[[15, 'Last 15 minutes'], [60, 'Last hour'], [360, 'Last 6 hours'], [1440, 'Last 24 hours'], [10080, 'Last 7 days']].map(([v, l]) => el('option', { value: String(v) }, l)));
    range.value = String(L.minutes); range.addEventListener('change', () => { L.minutes = Number(range.value); loadLogs(); });
    const live = el('label', { class: 'check small' }, el('input', { type: 'checkbox', id: 'logs-live' }), ' Live (every 5 s)');
    live.querySelector('input').addEventListener('change', e => { L.live = e.target.checked; schedule(); });
    root.append(
      el('div', { class: 'panel logs-panel' },
        el('div', { class: 'logs-sources', id: 'logs-sources' }),
        el('div', { class: 'logs-tools' }, q, range,
          seg('Level', [['all', 'All'], ['warn', 'Warnings+'], ['error', 'Errors']], L.level, v => { L.level = v; loadLogs(); }),
          live, el('button', { type: 'button', class: 'ghost small', onclick: () => loadLogs() }, 'Refresh')),
        el('p', { id: 'logs-note', class: 'muted small' }),
        el('div', { id: 'logs-hist', class: 'logs-hist' }),
        el('div', { class: 'logs-table-wrap' }, el('table', { class: 'list logs-table' },
          el('thead', {}, el('tr', {}, ...['Time', '', 'Status', 'Request / message'].map(h => el('th', {}, h)))),
          el('tbody', { id: 'logs-rows' })))));
  }
  function schedule() {
    clearInterval(L.timer);
    if (L.live) L.timer = setInterval(() => { if (!document.hidden && current === 'database' && $('#db-logs').classList.contains('active')) loadLogs(true); }, 5000);
  }
  async function loadLogs(quiet) {
    if (!L.proj) return;
    const qs = new URLSearchParams({ project: keyOf(L.proj), source: L.source, minutes: String(L.minutes), level: L.level, q: L.q, limit: '500' });
    if (!quiet) $('#logs-rows').replaceChildren(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Loading…')));
    let r;
    try { r = await api(`/api/logs?${qs}`); } catch (e) { $('#logs-note').textContent = e.message; return; }
    $('#logs-sources').replaceChildren(seg('Source', r.sources.map(x => [x.id, x.label]), r.source, v => { L.source = v; loadLogs(); }));
    $('#logs-note').textContent = [r.note, r.total != null ? `${nf(r.total)} lines in range, showing the newest ${nf(r.entries.length)}${L.q || L.level !== 'all' ? ' that match' : ''}.` : ''].filter(Boolean).join(' ');
    pcChart.bars($('#logs-hist'), { wide: $('#logs-hist').clientWidth > 700, label: 'Log lines over time', points: r.histogram.map(h => ({ t: h.t, values: { info: h.info, warn: h.warn, error: h.error } })),
      series: [{ key: 'info', label: 'Info', color: C.info }, { key: 'warn', label: 'Warning', color: C.warn }, { key: 'error', label: 'Error', color: C.error }], empty: 'Nothing logged in this time range.' });
    $('#logs-rows').replaceChildren(...(r.entries.length ? r.entries.map(e => {
      const tr = el('tr', { class: `log-row lv-${e.level}`, tabindex: '0' },
        el('td', { class: 'mono small nowrap', title: new Date(e.ts).toISOString() }, new Date(e.ts).toLocaleTimeString()),
        el('td', {}, el('span', { class: `dot ${e.level}`, title: e.level, 'aria-label': e.level })),
        el('td', { class: 'mono small' }, e.status != null ? String(e.status) : ''),
        el('td', { class: 'mono small log-msg' }, e.method ? `${e.method} ${e.path || ''}` : '', e.method && e.msg ? el('span', { class: 'muted' }, `  ${e.msg}`) : e.msg,
          e.ms != null ? el('span', { class: 'muted' }, `  ${e.ms} ms`) : ''));
      const toggle = () => tr.classList.toggle('open');
      tr.addEventListener('click', toggle); tr.addEventListener('keydown', ev => { if (ev.key === 'Enter') toggle(); });
      return tr;
    }) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No matching log lines. Widen the time range or clear the search.'))]));
  }

  // ---------------------------------------------------------------- reports
  const R = { hours: 24, proj: null };
  function buildReports() {
    const root = $('#reports-root');
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    root.append(
      el('div', { class: 'reports-tools' },
        seg('Time range', [[1, 'Last hour'], [24, 'Last 24 hours'], [168, 'Last 7 days']], R.hours, v => { R.hours = v; loadReports(); }),
        el('button', { type: 'button', class: 'ghost small', onclick: () => loadReports() }, 'Refresh')),
      el('h2', { class: 'section-title' }, 'API'), el('p', { id: 'rep-api-note', class: 'muted small' }),
      el('div', { id: 'rep-api-cards', class: 'grid' }),
      el('div', { id: 'rep-api-charts', class: 'chart-grid' }),
      el('div', { id: 'rep-api-lists', class: 'chart-grid' }),
      el('h2', { class: 'section-title' }, 'Database'), el('p', { id: 'rep-db-note', class: 'muted small' }),
      el('div', { id: 'rep-db-charts', class: 'chart-grid' }),
      el('h2', { class: 'section-title' }, 'Authentication'), el('p', { id: 'rep-auth-note', class: 'muted small' }),
      el('div', { id: 'rep-auth-charts', class: 'chart-grid' }));
  }
  async function loadReports() {
    if (!R.proj) return;
    let r;
    try { r = await api(`/api/reports?project=${encodeURIComponent(keyOf(R.proj))}&hours=${R.hours}`); }
    catch (e) { $('#rep-api-note').textContent = e.message; return; }
    const a = r.api;
    // API
    if (a.error) { $('#rep-api-note').textContent = `Could not read API logs: ${a.error}`; $('#rep-api-cards').replaceChildren(); $('#rep-api-charts').replaceChildren(); $('#rep-api-lists').replaceChildren(); }
    else {
      $('#rep-api-note').textContent = a.shared ? 'Shared projects share one API, so these numbers cover every shared project.' : 'Requests to this project\'s own address (/p/…).';
      $('#rep-api-cards').replaceChildren(
        stat('Requests', nf(a.total)), stat('Server errors', nf(a.errors), `${a.errorRate}% of requests · ${nf(a.clientErrors)} client errors (4xx)`, a.errors ? 'critical' : null),
        stat('Response time', a.latency ? `${a.p50 ?? '–'} ms` : '–', a.latency ? `median · p95 ${a.p95 ?? '–'} ms` : 'not in the shared gateway log'));
      const req = chartBox('Requests', 'by status'), lat = chartBox('Response time', 'ms');
      $('#rep-api-charts').replaceChildren(req.box, ...(a.latency ? [lat.box] : []));
      pcChart.bars(req.body, { label: 'Requests by status', points: a.buckets.map(b => ({ t: b.t, values: { ok: b.ok, c4: b.c4, c5: b.c5 } })),
        series: [{ key: 'ok', label: 'Success', color: C.ok }, { key: 'c4', label: 'Client error (4xx)', color: C.c4 }, { key: 'c5', label: 'Server error (5xx)', color: C.c5 }], empty: 'No requests in this time range.' });
      if (a.latency) pcChart.line(lat.body, { label: 'Response time', unit: 'ms', points: a.buckets.map(b => ({ t: b.t, values: { p50: b.p50, p95: b.p95 } })),
        series: [{ key: 'p50', label: 'Median', color: C.p50 }, { key: 'p95', label: '95th percentile', color: C.p95 }] });
      const top = el('figure', { class: 'chart-card' }, el('figcaption', {}, 'Busiest routes'), el('table', { class: 'list' },
        el('tbody', {}, ...(a.top.length ? a.top.map(x => el('tr', {}, el('td', { class: 'mono small' }, x.path), el('td', { class: 'num' }, nf(x.n)))) : [el('tr', {}, el('td', { class: 'muted' }, 'None yet.'))]))));
      const st = el('figure', { class: 'chart-card' }, el('figcaption', {}, 'Status codes'), el('table', { class: 'list' },
        el('tbody', {}, ...(a.statuses.length ? a.statuses.map(x => el('tr', {}, el('td', {}, el('span', { class: `tag ${x.status >= 500 ? 'exited' : x.status >= 400 ? 'warn' : 'running'}` }, String(x.status))), el('td', { class: 'num' }, nf(x.n)))) : [el('tr', {}, el('td', { class: 'muted' }, 'None yet.'))]))));
      $('#rep-api-lists').replaceChildren(top, st);
    }
    // database (sampler history)
    const d = r.db || [];
    $('#rep-db-note').textContent = `${r.sharedDatabase ? 'The main database, which every shared project lives in.' : `This project's own database (${r.database}).`} Pi Console records these every minute and keeps 24 hours${d.length ? `; ${d.length} samples so far` : ''}.`;
    const pts = d.map(p => ({ t: p.t, values: p }));
    const charts = [['Connections', 'conns', ''], ['Transactions', 'tpm', 'per minute'], ['Rows written', 'writes', 'per minute'], ['Rows read', 'reads', 'per minute'], ['Cache hit rate', 'cacheHit', '%'], ['Database size', 'size', '']];
    $('#rep-db-charts').replaceChildren(...charts.map(([title, k, sub]) => {
      const c = chartBox(title, sub);
      pcChart.line(c.body, { label: title, area: true, points: pts.map(p => ({ t: p.t, values: { [k]: p.values[k] } })), series: [{ key: k, label: title, color: C.a }],
        max: k === 'cacheHit' ? 100 : undefined, yFmt: k === 'size' ? (v => fmtBytes(v)) : undefined, empty: 'Collecting: the first points appear two minutes after Pi Console starts.' });
      return c.box;
    }));
    // auth
    const au = r.auth;
    if (au.error) { $('#rep-auth-note').textContent = `No auth data: ${au.error}`; $('#rep-auth-charts').replaceChildren(); }
    else {
      $('#rep-auth-note').textContent = r.sharedDatabase ? 'Shared projects share one user pool: these count all of its users. Last 30 days.' : 'This project\'s own users. Last 30 days.';
      const su = chartBox('Sign-ups', 'per day'), si = chartBox('Sign-ins', 'per day');
      $('#rep-auth-charts').replaceChildren(su.box, si.box);
      const dp = au.map(x => ({ t: Date.parse(`${x.day}T12:00:00`), values: x }));
      pcChart.bars(su.body, { label: 'Sign-ups per day', points: dp, series: [{ key: 'signups', label: 'Sign-ups', color: C.a }] });
      pcChart.bars(si.body, { label: 'Sign-ins per day', points: dp, series: [{ key: 'signins', label: 'Sign-ins and token refreshes', color: C.b }] });
    }
  }

  // ---------------------------------------------------------------- server history (Server page)
  async function hostHistory() {
    let target = $('#host-history');
    if (!target) {
      target = el('div', { id: 'host-history', class: 'chart-grid' });
      $('#tab-overview').append(el('h2', { class: 'section-title' }, 'Last 24 hours'), target);
    }
    const pts = (await api('/api/metrics/host?hours=24')).map(p => ({ t: p.t, values: p }));
    const cpu = chartBox('CPU', '%'), mem = chartBox('Memory used', '%'), tmp = chartBox('Temperature', '°C');
    target.replaceChildren(cpu.box, mem.box, tmp.box);
    const msg = 'Collecting: Pi Console records this every minute.';
    pcChart.line(cpu.body, { label: 'CPU', area: true, max: 100, points: pts.map(p => ({ t: p.t, values: { cpu: p.values.cpu } })), series: [{ key: 'cpu', label: 'CPU', color: C.a }], empty: msg });
    pcChart.line(mem.body, { label: 'Memory', area: true, max: 100, points: pts.map(p => ({ t: p.t, values: { mem: p.values.mem } })), series: [{ key: 'mem', label: 'Memory', color: C.b }], empty: msg });
    pcChart.line(tmp.body, { label: 'Temperature', points: pts.map(p => ({ t: p.t, values: { temp: p.values.temp } })), series: [{ key: 'temp', label: 'Temperature', color: C.c4 }], empty: 'No temperature sensor reading.' });
  }
  const baseOverview = loaders.overview;
  let lastHost = 0;
  loaders.overview = async () => {
    await baseOverview();
    if (Date.now() - lastHost > 60000) { lastHost = Date.now(); hostHistory().catch(() => {}); }
  };

  window.pcObs = {
    async logs(proj) { buildLogs(); if (!L.proj || L.proj.schema !== proj.schema) L.source = 'api'; L.proj = proj; schedule(); await loadLogs(); },
    async reports(proj) { buildReports(); R.proj = proj; await loadReports(); },
  };
  if (current === 'overview') loaders.overview();
})();
