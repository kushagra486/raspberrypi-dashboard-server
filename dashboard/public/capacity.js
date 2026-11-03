// Capacity tab: where the memory goes, per-project sleep / wake, placement advice, import planner.
(() => {
  const err = m => { $('#cap-error').textContent = m || ''; };
  // fixed order, distinguishable on the dark panel; "free" is the empty track
  const COLORS = { 'Supabase (main)': '#3ecf8e', 'Isolated projects': '#5b8def', 'Isolated proxy': '#9b7bea',
    'Other containers': '#f0b429', 'System, Pi Console, cache': '#8b9bb0' };
  const mb = n => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
  const modeLabel = m => (m === 'auto-sleep' ? 'Auto-sleep' : 'Always on');

  function renderMemory(d) {
    const m = d.memory;
    const bar = $('#cap-mem-bar'); bar.replaceChildren();
    const legend = $('#cap-mem-legend'); legend.replaceChildren();
    for (const p of m.parts) {
      if (p.mb <= 0) continue;
      bar.append(el('span', { style: `width:${(p.mb / m.totalMb) * 100}%;background:${COLORS[p.name] || '#4a6a8a'}`, title: `${p.name}: ${mb(p.mb)}` }));
      legend.append(el('span', {}, el('span', { class: 'sw', style: `background:${COLORS[p.name] || '#4a6a8a'}` }), `${p.name} `, el('b', {}, mb(p.mb))));
    }
    legend.append(el('span', { class: 'muted' }, el('span', { class: 'sw', style: 'background:#0b0f14;border:1px solid #223042' }), 'Free ', el('b', {}, mb(m.availableMb))));
    bar.setAttribute('aria-label', `Memory: ${mb(m.usedMb)} used of ${mb(m.totalMb)}`);
    const h = d.headroom;
    const st = $('#cap-status'); st.className = `tag ${h.status}`;
    st.textContent = { good: 'Plenty of room', warning: 'Getting tight', critical: 'Too full' }[h.status];
    const conn = d.connections ? ` · Database connections ${d.connections.used} of ${d.connections.max}` : '';
    $('#cap-headroom').textContent = `${mb(m.usedMb)} used of ${mb(m.totalMb)}. Pi Console keeps ${mb(h.reserveMb)} free for spikes; ` +
      `beyond that there is room for about ${h.moreIsolatedProjects} more always-on isolated projects (${d.limits.isoMb} MB each). ` +
      `Sleeping projects cost nothing. If free memory drops under ${d.limits.memoryGuardMb} MB, the least recently used auto-sleep project is put to sleep.${conn}`;
  }

  async function act(path, body, btn) {
    btn.disabled = true; err('');
    try { await api(path, { method: 'POST', body }); await load(); }
    catch (e) { err(e.message); btn.disabled = false; }
  }

  function renderProjects(d) {
    const tb = $('#cap-projects'); tb.replaceChildren();
    if (!d.projects.length) tb.append(el('tr', {}, el('td', { colspan: '8', class: 'muted' }, 'No projects yet.')));
    for (const p of d.projects) {
      const a = p.advice || {};
      const iso = p.kind === 'isolated';
      const state = !iso ? el('span', { class: 'tag' }, 'shared') : el('span', { class: `tag ${p.awake ? 'running' : 'asleep'}` }, p.awake ? 'awake' : 'asleep');
      const actions = el('td', { class: 'actions' });
      if (iso) {
        if (a.action && a.action.type === 'set-mode') {
          actions.append(el('button', { onclick: e => act('/api/capacity/mode', { name: p.name, mode: a.action.mode, minutes: p.sleepAfterMin }, e.target) }, `Apply: ${modeLabel(a.action.mode)}`));
        }
        const other = p.mode === 'auto-sleep' ? 'always-on' : 'auto-sleep';
        if (!a.action) actions.append(el('button', { class: 'ghost', onclick: e => act('/api/capacity/mode', { name: p.name, mode: other, minutes: p.sleepAfterMin }, e.target) }, `Set ${modeLabel(other).toLowerCase()}`));
        actions.append(p.awake
          ? el('button', { class: 'ghost', title: 'Stop now; the next request wakes it', onclick: e => act('/api/capacity/sleep', { name: p.name }, e.target) }, 'Sleep')
          : el('button', { class: 'ghost', onclick: e => act('/api/capacity/wake', { name: p.name }, e.target) }, 'Wake'));
      }
      tb.append(el('tr', {},
        el('td', {}, el('b', {}, p.name), el('div', { class: 'muted small' }, iso ? `isolated · ${p.users ?? 0} users` : `shared · ${p.tables ?? 0} tables`)),
        el('td', {}, state),
        el('td', {}, iso ? (p.awake ? mb(p.memoryMb) : '0 MB') : '–'),
        el('td', {}, iso ? `${p.requests24h} / ${p.requests7d}` : el('span', { class: 'muted' }, 'not measured')),
        el('td', {}, p.lastActive ? fmtAge(p.lastActive) : '–'),
        el('td', {}, iso ? `${modeLabel(p.mode)}${p.mode === 'auto-sleep' ? ` after ${p.sleepAfterMin} min` : ''}` : '–'),
        el('td', { class: `advice${a.action ? ' change' : ''}` }, (a.reasons || []).join('; ')),
        actions));
    }
  }

  function renderEvents(d) {
    const s = d.sleeper;
    $('#cap-waker').textContent = !s ? 'Sleep / wake is off.' : s.listening
      ? `Waker listening on ${s.wakerAddr} (reachable only from the isolated-project proxy).`
      : s.wakerAddr ? `Waker not listening on ${s.wakerAddr} yet: auto-sleep projects cannot wake until it is.` : 'No isolated projects yet.';
    const tb = $('#cap-events'); tb.replaceChildren();
    const ev = s ? s.events : [];
    if (!ev.length) tb.append(el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'Nothing yet.')));
    for (const e of ev) {
      tb.append(el('tr', {}, el('td', {}, fmtAge(e.at)), el('td', {}, e.project),
        el('td', {}, el('span', { class: `tag ${e.what === 'wake' ? 'running' : e.what === 'wake-failed' ? 'exited' : 'asleep'}` }, e.what)),
        el('td', { class: 'small' }, e.why)));
    }
  }

  async function load() {
    err('');
    try {
      const d = await api('/api/capacity');
      renderMemory(d); renderProjects(d); renderEvents(d);
    } catch (e) { err(e.message); }
  }

  // ---- import planner
  function planRow() {
    const cb = n => el('td', {}, el('input', { type: 'checkbox', 'data-k': n, 'aria-label': n }));
    const traffic = el('select', { 'data-k': 'traffic', 'aria-label': 'traffic' },
      el('option', { value: 'low' }, 'Low'), el('option', { value: 'medium' }, 'Medium'), el('option', { value: 'high' }, 'High (busy all day)'));
    const tr = el('tr', { class: 'plan-row' },
      el('td', {}, el('input', { type: 'text', 'data-k': 'name', placeholder: 'project name', maxlength: '60' })),
      cb('ownUsers'), cb('storage'), cb('edgeFunctions'), cb('realtime'), el('td', {}, traffic),
      el('td', {}, el('button', { class: 'ghost small', onclick: () => tr.remove() }, 'Remove')));
    $('#cap-plan-rows').append(tr);
  }

  async function plan() {
    err('');
    const rows = [...document.querySelectorAll('#cap-plan-rows tr')].map(tr => {
      const o = {};
      tr.querySelectorAll('[data-k]').forEach(i => { o[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
      return o;
    }).filter(r => r.name);
    const out = $('#cap-plan-out'); out.replaceChildren();
    if (!rows.length) return err('Add at least one project name.');
    try {
      const r = await api('/api/capacity/plan', { method: 'POST', body: { rows } });
      const where = { shared: 'Shared (schema in the main database)', isolated: 'Isolated (own database and users)', cloud: 'Stay on Supabase cloud' };
      const tb = el('tbody');
      for (const p of r.plan) {
        tb.append(el('tr', {}, el('td', {}, el('b', {}, p.name)), el('td', {}, where[p.placement]),
          el('td', {}, p.mode ? modeLabel(p.mode) : '–'), el('td', {}, p.costMb ? `${p.costMb} MB` : '0 MB'),
          el('td', { class: 'small' }, [...p.reasons, p.note].filter(Boolean).join('; '))));
      }
      const s = r.summary;
      out.append(el('div', { class: 'plan-out' },
        el('p', {}, `${s.shared} shared, ${s.isolated} isolated, ${s.cloud} stay on cloud. Always-on memory: ${s.alwaysOnMb} MB; ` +
          `room left after: ${mb(Math.max(0, s.headroomAfterMb))}.`),
        s.worstCaseFits ? el('p', { class: 'muted small' }, `Even if every isolated project were awake at once (${s.worstCaseMb} MB) it would fit.`)
          : el('p', { class: 'warn-box' }, `If every isolated project were awake at once (${s.worstCaseMb} MB) the Pi would be over its safe limit; the memory guard then puts the least recently used ones to sleep.`),
        el('div', { class: 'table-scroll' }, el('table', { class: 'list' },
          el('thead', {}, el('tr', {}, ...['Project', 'Where', 'Mode', 'Memory', 'Why'].map(h => el('th', {}, h)))), tb))));
    } catch (e) { err(e.message); }
  }

  $('#cap-refresh').addEventListener('click', load);
  $('#cap-plan-add').addEventListener('click', planRow);
  $('#cap-plan-go').addEventListener('click', plan);
  planRow();
  loaders.capacity = load;
  if (current === 'capacity') load();
})();
