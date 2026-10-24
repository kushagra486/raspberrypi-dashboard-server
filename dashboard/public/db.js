// Database tab: overview, projects (schemas) → tables → table, SQL editor, auth users, storage.
// Uses $, el, api, fmtBytes, fmtAge and loaders from app.js.
(() => {
  let view = 'overview';
  let cur = { schema: null, table: null, offset: 0, limit: 100 };
  const err = m => { $('#db-error').textContent = m || ''; };
  const show = v => {
    view = v;
    document.querySelectorAll('#db-nav button').forEach(b => b.classList.toggle('active', b.dataset.db === v));
    document.querySelectorAll('.db-view').forEach(d => d.classList.toggle('active', d.id === `db-${v}`));
    err('');
    return (views[v] || (() => {}))().catch(e => err(e.message));
  };
  document.querySelectorAll('#db-nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.db)));

  const card = (label, value, sub) => el('div', { class: 'card' },
    el('div', { class: 'card-label' }, label), el('div', { class: 'card-value' }, value),
    sub ? el('div', { class: 'muted small' }, sub) : '');
  const cell = v => {
    if (v === null || v === undefined) return el('td', { class: 'muted' }, 'NULL');
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return el('td', { title: s }, s.length > 120 ? s.slice(0, 120) + '…' : s);
  };
  const dataTable = (target, fields, rows) => {
    target.replaceChildren(
      el('thead', {}, el('tr', {}, ...fields.map(f => el('th', {}, f)))),
      el('tbody', {}, ...(rows.length ? rows.map(r => el('tr', {}, ...r.map(cell)))
        : [el('tr', {}, el('td', { colspan: Math.max(fields.length, 1), class: 'muted' }, 'No rows'))])));
  };

  const views = {
    async overview() {
      const o = await api('/api/db/overview');
      $('#db-studio').href = o.studioUrl;
      const cards = [
        card('Postgres', (o.version.match(/PostgreSQL [\d.]+/) || [o.version])[0], o.version.split(' on ')[1] || ''),
        card('Database size', fmtBytes(Number(o.size))),
        card('Connections', `${o.connections} / ${o.max_connections}`),
        card('Up since', fmtAge(new Date(o.started).getTime()), new Date(o.started).toLocaleString()),
        card('Auth users', o.authUsers ?? 'n/a'),
        card('Storage', o.storage ? fmtBytes(Number(o.storage.bytes)) : 'n/a',
          o.storage ? `${o.storage.objects} objects in ${o.storage.buckets} buckets` : ''),
      ];
      try {
        const b = await api('/api/backups');
        if (Array.isArray(b) && b.length) {
          const dump = b.find(f => f.name.startsWith('db-')) || b[0];
          cards.push(card('Latest backup', fmtAge(dump.modified), `${dump.name} · ${fmtBytes(dump.size)}`));
        }
      } catch {}
      $('#db-cards').replaceChildren(...cards);
    },

    async projects() {
      const list = await api('/api/db/projects');
      $('#db-project-list').replaceChildren(...list.map(p => el('tr', { class: 'clickable', onclick: () => openSchema(p.schema) },
        el('td', {}, el('b', {}, p.schema)),
        el('td', {}, String(p.tables)),
        el('td', {}, fmtBytes(Number(p.size))),
        el('td', {}, p.api ? el('span', { class: 'tag running' }, 'exposed') : el('span', { class: 'tag' }, 'private')),
        el('td', {}, p.tables_without_rls
          ? el('span', { class: 'tag exited', title: 'Tables without row level security are readable/writable with the public key if exposed' }, `${p.tables_without_rls} without RLS`)
          : el('span', { class: 'tag running' }, p.tables ? 'all on' : '–')))));
      if (cur.schema) await openSchema(cur.schema, true);
    },

    async sql() { $('#sql-input').focus(); },

    async users() {
      const u = await api('/api/db/users');
      $('#db-user-list').replaceChildren(...(u.length ? u.map(x => el('tr', {},
        el('td', {}, x.email || '–'), el('td', {}, x.phone || '–'),
        el('td', {}, x.confirmed ? 'yes' : 'no'),
        el('td', {}, x.created_at ? fmtAge(new Date(x.created_at).getTime()) : '–'),
        el('td', {}, x.last_sign_in_at ? fmtAge(new Date(x.last_sign_in_at).getTime()) : 'never')))
        : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No users yet.'))]));
    },

    async storage() {
      const b = await api('/api/db/buckets');
      $('#db-bucket-list').replaceChildren(...(b.length ? b.map(x => el('tr', {},
        el('td', {}, el('b', {}, x.name)), el('td', {}, x.public ? 'public' : 'private'),
        el('td', {}, String(x.objects)), el('td', {}, fmtBytes(Number(x.bytes)))))
        : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No buckets yet.'))]));
    },
  };

  async function openSchema(schema, keepTable) {
    cur.schema = schema;
    if (!keepTable) { cur.table = null; $('#db-table-panel').classList.add('hidden'); }
    const t = await api(`/api/db/tables?schema=${encodeURIComponent(schema)}`);
    $('#db-schema-name').textContent = schema;
    $('#db-tables-panel').classList.remove('hidden');
    $('#db-table-list').replaceChildren(...(t.length ? t.map(x => el('tr', { class: 'clickable', onclick: () => openTable(schema, x.name, 0) },
      el('td', {}, el('b', {}, x.name), x.comment ? el('div', { class: 'muted small' }, x.comment) : ''),
      el('td', {}, x.kind), el('td', {}, x.est_rows), el('td', {}, fmtBytes(Number(x.size))),
      el('td', {}, x.kind === 'table' ? (x.rls ? el('span', { class: 'tag running' }, 'on') : el('span', { class: 'tag exited' }, 'OFF')) : '–'),
      el('td', {}, String(x.policies))))
      : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No tables yet. Create them in the SQL editor or Studio.'))]));
  }

  async function openTable(schema, name, offset) {
    cur = { ...cur, schema, table: name, offset };
    const d = await api(`/api/db/table?schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}&limit=${cur.limit}&offset=${offset}`);
    $('#db-table-name').textContent = `${schema}.${name}`;
    $('#db-columns').replaceChildren(...d.columns.map(c => el('tr', {},
      el('td', {}, el('b', {}, c.name), c.primary_key ? el('span', { class: 'tag claude' }, 'PK') : ''),
      el('td', { class: 'mono' }, c.type), el('td', {}, c.nullable ? 'yes' : 'no'),
      el('td', { class: 'mono small' }, c.default || ''))));
    $('#db-policies').replaceChildren(...(d.policies.length ? d.policies.map(p => el('div', { class: 'policy' },
      el('b', {}, p.name), ' ', el('span', { class: 'tag' }, p.cmd), ' ', el('span', { class: 'muted small' }, `roles: ${(p.roles || []).join(', ')}`),
      p.using ? el('div', { class: 'mono small' }, `using (${p.using})`) : '',
      p.with_check ? el('div', { class: 'mono small' }, `with check (${p.with_check})`) : ''))
      : [el('p', { class: 'muted' }, 'No policies. With RLS on and no policies, the public key can read nothing (safe default).')]));
    const fields = d.columns.map(c => c.name);
    dataTable($('#db-rows'), fields, d.rows.map(r => fields.map(f => r[f])));
    $('#db-page').textContent = d.rows.length ? `rows ${offset + 1}–${offset + d.rows.length}` : 'no rows';
    $('#db-prev').disabled = offset === 0;
    $('#db-next').disabled = d.rows.length < d.limit;
    $('#db-table-panel').classList.remove('hidden');
    $('#db-table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#db-prev').addEventListener('click', () => openTable(cur.schema, cur.table, Math.max(cur.offset - cur.limit, 0)).catch(e => err(e.message)));
  $('#db-next').addEventListener('click', () => openTable(cur.schema, cur.table, cur.offset + cur.limit).catch(e => err(e.message)));
  $('#db-table-close').addEventListener('click', () => { cur.table = null; $('#db-table-panel').classList.add('hidden'); });

  $('#db-new-project').addEventListener('submit', async e => {
    e.preventDefault(); err('');
    const name = $('#db-new-name').value;
    if (!confirm(`Create project schema "${name}" and expose it through the API? The REST service restarts briefly.`)) return;
    try {
      await api('/api/db/projects', { method: 'POST', body: { name } });
      $('#db-new-name').value = '';
      await views.projects();
      await openSchema(name);
    } catch (e2) { err(e2.message); }
  });

  // ---- SQL editor
  const sqlInput = $('#sql-input');
  try { sqlInput.value = localStorage.getItem('pc-sql') || ''; } catch {}
  async function runSql() {
    const sql = sqlInput.value;
    const readOnly = $('#sql-ro').checked;
    if (!readOnly && !confirm('Run with writes allowed? Changes are committed immediately.')) return;
    try { localStorage.setItem('pc-sql', sql); } catch {}
    $('#sql-error').textContent = ''; $('#sql-meta').textContent = 'running…';
    try {
      const r = await api('/api/db/sql', { method: 'POST', body: { sql, readOnly } });
      $('#sql-meta').textContent = `${r.command || ''} · ${r.fields.length ? `${r.rows.length} row(s)${r.truncated ? ' (first 1000)' : ''}` : `${r.rowCount ?? 0} affected`} · ${r.ms} ms${r.readOnly ? ' · read-only, rolled back' : ' · committed'}`;
      if (r.fields.length) dataTable($('#sql-result'), r.fields, r.rows);
      else $('#sql-result').replaceChildren();
    } catch (e) {
      $('#sql-meta').textContent = '';
      $('#sql-error').textContent = e.message;
      $('#sql-result').replaceChildren();
    }
  }
  $('#sql-run').addEventListener('click', runSql);
  sqlInput.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); } });

  loaders.database = () => show(view);
  if (current === 'database') loaders.database();
})();
