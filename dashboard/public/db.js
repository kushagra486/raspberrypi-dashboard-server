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
          : el('span', { class: 'tag running' }, p.tables ? 'all on' : '–')),
        el('td', { class: 'row-actions' }, ...projectActions(p)))));
      if (cur.schema) await openSchema(cur.schema, true);
    },

    async sql() {
      $('#sql-input').focus();
      await loadSnippets();
      const m = await api('/api/db/migrations');
      $('#mig-list').replaceChildren(...(m.length ? m.map(x => el('tr', {},
        el('td', { class: 'mono' }, x.version), el('td', {}, x.name || ''), el('td', {}, String(x.statements))))
        : [el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'No migrations recorded (only apps deployed with the Supabase CLI have them).'))]));
    },

    async users() {
      const u = await api('/api/db/users');
      $('#db-user-list').replaceChildren(...(u.length ? u.map(x => el('tr', {},
        el('td', {}, x.email || '–'), el('td', {}, x.phone || '–'),
        el('td', {}, x.confirmed ? 'yes' : 'no'),
        el('td', {}, x.created_at ? fmtAge(new Date(x.created_at).getTime()) : '–'),
        el('td', {}, x.last_sign_in_at ? fmtAge(new Date(x.last_sign_in_at).getTime()) : 'never')))
        : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No users yet.'))]));
    },

    async advisors() {
      advisorData = await api('/api/db/advisors');
      renderAdvisors();
    },

    async insights() {
      const d = await api(`/api/db/insights?sort=${encodeURIComponent($('#ins-sort').value)}`);
      if (!d.enabled) {
        $('#ins-meta').textContent = '';
        $('#ins-list').replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted' },
          'pg_stat_statements is not enabled. ', el('code', {}, d.hint))));
        return;
      }
      $('#ins-meta').textContent = `${d.statements} distinct statements tracked`;
      $('#ins-list').replaceChildren(...(d.rows.length ? d.rows.map(r => el('tr', {},
        el('td', { class: 'mono small query-cell', title: r.query }, r.query.length > 220 ? r.query.slice(0, 220) + '…' : r.query),
        el('td', { class: 'small' }, r.role || ''), el('td', {}, r.calls), el('td', {}, r.total_ms),
        el('td', {}, r.mean_ms), el('td', {}, r.rows), el('td', {}, (r.share ?? '0') + '%')))
        : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No queries recorded yet.'))]));
    },

    async storage() {
      const b = await api('/api/db/buckets');
      $('#db-bucket-list').replaceChildren(...(b.length ? b.map(x => el('tr', {},
        el('td', {}, el('b', {}, x.name)), el('td', {}, x.public ? 'public' : 'private'),
        el('td', {}, String(x.objects)), el('td', {}, fmtBytes(Number(x.bytes)))))
        : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No buckets yet.'))]));
    },
  };

  // ---- advisors rendering
  let advisorData = [];
  const levelTag = { error: 'exited', warn: 'warn', info: '' };
  function renderAdvisors() {
    const cat = (document.querySelector('input[name="adv-cat"]:checked') || {}).value || 'all';
    const list = advisorData.filter(a => cat === 'all' || a.category === cat);
    const n = l => advisorData.filter(a => a.level === l).length;
    $('#adv-summary').textContent = `${n('error')} errors · ${n('warn')} warnings · ${n('info')} suggestions`;
    const badge = $('#db-adv-badge');
    badge.textContent = String(n('error'));
    badge.classList.toggle('hidden', n('error') === 0);
    $('#adv-list').replaceChildren(...(list.length ? list.map(a => el('div', { class: `advisor level-${a.level}` },
      el('div', { class: 'advisor-head' },
        el('span', { class: `tag ${levelTag[a.level]}` }, a.level), ' ',
        el('span', { class: 'tag' }, a.category), ' ',
        el('b', {}, a.title), ' ', el('span', { class: 'mono small' }, a.object)),
      el('p', { class: 'muted small' }, a.detail),
      a.fix ? el('div', { class: 'advisor-fix' },
        el('pre', { class: 'mono small' }, a.fix),
        el('button', { class: 'ghost small', onclick: () => useInEditor(a.fix) }, 'Open in SQL editor')) : ''))
      : [el('p', { class: 'muted' }, advisorData.length ? 'Nothing in this category.' : 'No issues found. 🎉')]));
  }
  function useInEditor(sql) {
    $('#sql-input').value = `-- from Advisors: review, untick read-only, then run\n${sql}\n`;
    show('sql');
  }
  document.querySelectorAll('input[name="adv-cat"]').forEach(r => r.addEventListener('change', renderAdvisors));
  $('#adv-refresh').addEventListener('click', () => views.advisors().catch(e => err(e.message)));
  $('#ins-sort').addEventListener('change', () => views.insights().catch(e => err(e.message)));
  $('#ins-refresh').addEventListener('click', () => views.insights().catch(e => err(e.message)));

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
    cur.columns = d.columns; cur.rows = d.rows;
    cur.pk = d.columns.filter(c => c.primary_key).map(c => c.name);
    renderRows(fields, d.rows);
    $('#db-export').href = `/api/db/export?schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}`;
    $('#db-row-form').classList.add('hidden');
    $('#db-edit-msg').textContent = cur.pk.length ? '' : 'No primary key: rows can be added but not edited or deleted.';
    $('#db-page').textContent = d.rows.length ? `rows ${offset + 1}–${offset + d.rows.length}` : 'no rows';
    $('#db-prev').disabled = offset === 0;
    $('#db-next').disabled = d.rows.length < d.limit;
    $('#db-table-panel').classList.remove('hidden');
    $('#db-table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- table editor
  function renderRows(fields, rows) {
    const editable = cur.pk.length > 0;
    $('#db-rows').replaceChildren(
      el('thead', {}, el('tr', {}, ...(editable ? [el('th', {}, '')] : []), ...fields.map(f => el('th', {}, f)))),
      el('tbody', {}, ...(rows.length ? rows.map(r => el('tr', {},
        ...(editable ? [el('td', { class: 'row-actions' },
          el('button', { class: 'ghost small', title: 'Edit row', onclick: () => openRowForm(r) }, '✎'),
          el('button', { class: 'ghost small', title: 'Delete row', onclick: () => deleteRow(r) }, '🗑'))] : []),
        ...fields.map(f => cell(r[f]))))
        : [el('tr', {}, el('td', { colspan: fields.length + 1, class: 'muted' }, 'No rows'))])));
  }
  const fieldValue = v => v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  function openRowForm(row) {
    cur.editing = row || null;
    $('#db-row-form-title').textContent = row ? 'Edit row' : 'Add row';
    $('#db-row-fields').replaceChildren(...cur.columns.map(c => el('label', { class: 'field' },
      el('span', {}, c.name, ' ', el('span', { class: 'muted small' }, c.type + (c.primary_key ? ' · PK' : ''))),
      Object.assign(el('input', { 'data-col': c.name, ...(c.readonly ? { disabled: '' } : {}) }),
        { value: row ? fieldValue(row[c.name]) : '' }))));
    $('#db-row-form').classList.remove('hidden');
    $('#db-row-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function deleteRow(row) {
    const key = Object.fromEntries(cur.pk.map(k => [k, fieldValue(row[k])]));
    if (!confirm(`Delete the row with ${Object.entries(key).map(([k, v]) => `${k} = ${v}`).join(', ')}? This cannot be undone.`)) return;
    try {
      await api('/api/db/rows', { method: 'POST', body: { schema: cur.schema, table: cur.table, op: 'delete', key } });
      await openTable(cur.schema, cur.table, cur.offset);
      $('#db-edit-msg').textContent = 'Row deleted.';
    } catch (e) { err(e.message); }
  }
  $('#db-add-row').addEventListener('click', () => openRowForm(null));
  $('#db-row-cancel').addEventListener('click', () => $('#db-row-form').classList.add('hidden'));
  $('#db-row-form').addEventListener('submit', async e => {
    e.preventDefault(); err('');
    const row = cur.editing, values = {};
    for (const input of document.querySelectorAll('#db-row-fields input:not([disabled])')) {
      const col = input.dataset.col, v = input.value;
      const val = v === 'NULL' ? null : v;
      if (row) { if (v !== fieldValue(row[col])) values[col] = val; }
      else if (v !== '') values[col] = val;
    }
    try {
      if (row) {
        const key = Object.fromEntries(cur.pk.map(k => [k, fieldValue(row[k])]));
        await api('/api/db/rows', { method: 'POST', body: { schema: cur.schema, table: cur.table, op: 'update', key, values } });
      } else {
        await api('/api/db/rows', { method: 'POST', body: { schema: cur.schema, table: cur.table, op: 'insert', values } });
      }
      await openTable(cur.schema, cur.table, cur.offset);
      $('#db-edit-msg').textContent = row ? 'Row saved.' : 'Row added.';
    } catch (e2) { err(e2.message); }
  });
  $('#db-import').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return err('CSV is larger than 8 MB.');
    const text = await file.text();
    if (!confirm(`Append the rows in ${file.name} to ${cur.schema}.${cur.table}? The first line must be column names. If any row fails, nothing is imported.`)) return;
    try {
      const r = await api('/api/db/import', { method: 'POST', body: { schema: cur.schema, name: cur.table, csv: text } });
      await openTable(cur.schema, cur.table, 0);
      $('#db-edit-msg').textContent = `Imported ${r.inserted} rows.`;
    } catch (e2) { err(e2.message); }
  });

  // ---- project actions: connect, branch, reset / delete branch
  const stop = fn => ev => { ev.stopPropagation(); fn().catch(e => err(e.message)); };
  function projectActions(p) {
    const acts = [el('button', { class: 'ghost small', onclick: stop(() => openConnect(p.schema)) }, 'Connect')];
    if (p.schema === 'public') return acts;
    if (p.schema.endsWith('_dev')) {
      const source = p.schema.slice(0, -4);
      acts.push(el('button', { class: 'ghost small', title: `Throw away changes and copy ${source} again`, onclick: stop(async () => {
        const withData = confirm(`Reset ${p.schema} from ${source}?\n\nOK = copy structure AND rows\nCancel = choose structure only`);
        if (!withData && !confirm(`Reset ${p.schema} with structure only (empty tables)? Everything in ${p.schema} is replaced.`)) return;
        const r = await api('/api/db/branch', { method: 'POST', body: { schema: source, withData, reset: true } });
        err(''); alert(branchSummary(r)); await views.projects();
      }) }, 'Reset'));
      acts.push(el('button', { class: 'ghost small danger', onclick: stop(async () => {
        if (prompt(`Delete branch ${p.schema} and all its data? Type its name to confirm:`) !== p.schema) return;
        await api(`/api/db/branch?schema=${encodeURIComponent(p.schema)}`, { method: 'DELETE' });
        if (cur.schema === p.schema) { cur.schema = null; $('#db-tables-panel').classList.add('hidden'); $('#db-table-panel').classList.add('hidden'); }
        await views.projects();
      }) }, 'Delete'));
    } else {
      acts.push(el('button', { class: 'ghost small', onclick: stop(async () => openBranch(p.schema)) }, 'Branch'));
    }
    return acts;
  }
  const branchSummary = r => {
    const n = r.notCopied || {};
    const skipped = [n.views && `${n.views} view(s)`, n.functions && `${n.functions} function(s)`, n.triggers && `${n.triggers} trigger(s)`].filter(Boolean);
    return `${r.branch}: ${r.tables} tables, ${r.rows} rows, ${r.policies} policies copied.` +
      (skipped.length ? ` Not copied: ${skipped.join(', ')}; recreate them in the SQL editor if the branch needs them.` : '');
  };
  function openBranch(schema) {
    $('#db-branch-name').textContent = schema;
    $('#db-branch-target').textContent = `${schema}_dev`;
    $('#db-branch-msg').textContent = '';
    $('#db-branch-panel').classList.remove('hidden');
    $('#db-branch-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#db-branch-close').addEventListener('click', () => $('#db-branch-panel').classList.add('hidden'));
  $('#db-branch-go').addEventListener('click', async () => {
    const schema = $('#db-branch-name').textContent;
    $('#db-branch-go').disabled = true; $('#db-branch-msg').textContent = 'copying… (the REST API restarts for a few seconds)';
    try {
      const r = await api('/api/db/branch', { method: 'POST', body: { schema, withData: $('#db-branch-data').checked } });
      $('#db-branch-msg').textContent = branchSummary(r);
      await views.projects();
    } catch (e) { $('#db-branch-msg').textContent = ''; err(e.message); }
    $('#db-branch-go').disabled = false;
  });

  // ---- schema diagram (SVG, laid out by foreign-key depth: referenced tables on the left)
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, text) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  async function openDiagram(schema) {
    const d = await api(`/api/db/diagram?schema=${encodeURIComponent(schema)}`);
    $('#db-diagram-name').textContent = schema;
    const W = 230, HEAD = 26, ROW = 19, MAXC = 14, GX = 90, GY = 28, PAD = 16;
    const local = d.fks.filter(f => f.to_schema === schema && f.to_table !== f.from_table);
    const depth = {};
    const level = (t, seen = new Set()) => {
      if (depth[t] != null) return depth[t];
      if (seen.has(t)) return 0;
      seen.add(t);
      const parents = local.filter(f => f.from_table === t).map(f => f.to_table);
      return (depth[t] = parents.length ? 1 + Math.max(...parents.map(p => level(p, seen))) : 0);
    };
    d.tables.forEach(t => level(t.name));
    const cols = {};
    d.tables.forEach(t => (cols[depth[t.name]] = cols[depth[t.name]] || []).push(t));
    const pos = {}, rowY = {};
    let width = 0, height = 0;
    Object.keys(cols).sort((a, b) => a - b).forEach((lv, ci) => {
      let y = PAD;
      cols[lv].forEach(t => {
        const shown = t.columns.slice(0, MAXC), h = HEAD + ROW * (shown.length + (t.columns.length > MAXC ? 1 : 0)) + 6;
        const x = PAD + ci * (W + GX);
        pos[t.name] = { x, y, h };
        shown.forEach((c, i) => { rowY[`${t.name}.${c.name}`] = y + HEAD + ROW * i + ROW / 2 + 2; });
        y += h + GY; width = Math.max(width, x + W + PAD); height = Math.max(height, y);
      });
    });
    const root = svg('svg', { xmlns: SVGNS, width, height, viewBox: `0 0 ${width} ${height}`, class: 'diagram' });
    root.append(svg('style', {}, `text{font:12px ui-monospace,Menlo,Consolas,monospace;fill:#c9d4e0}.h{font-weight:700;fill:#e6edf3}.t{fill:#8b9bb0}.pk{fill:#3ecf8e}.fk{fill:#f0b429}`));
    const defs = svg('defs');
    defs.append(Object.assign(svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }),
      {}));
    defs.firstChild.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#4a6a8a' }));
    root.append(defs);
    const edges = svg('g', { fill: 'none', stroke: '#4a6a8a', 'stroke-width': 1.4 });
    root.append(edges);
    local.forEach(f => {
      const a = pos[f.from_table], b = pos[f.to_table];
      if (!a || !b) return;
      const y1 = rowY[`${f.from_table}.${f.from_cols[0]}`] ?? a.y + HEAD / 2, y2 = rowY[`${f.to_table}.${f.to_cols[0]}`] ?? b.y + HEAD / 2;
      const x1 = a.x, x2 = b.x + W;
      const mid = Math.max(30, (x1 - x2) / 2);
      edges.append(svg('path', { d: `M${x1},${y1} C${x1 - mid},${y1} ${x2 + mid},${y2} ${x2},${y2}`, 'marker-end': 'url(#arrow)' }));
    });
    const fkCols = new Set(d.fks.flatMap(f => f.from_cols.map(c => `${f.from_table}.${c}`)));
    const external = {};
    d.fks.filter(f => f.to_schema !== schema).forEach(f => { external[`${f.from_table}.${f.from_cols[0]}`] = `→ ${f.to_schema}.${f.to_table}`; });
    d.tables.forEach(t => {
      const { x, y, h } = pos[t.name];
      const g = svg('g', { class: 'tbl', 'data-table': t.name, style: 'cursor:pointer' });
      g.append(svg('rect', { x, y, width: W, height: h, rx: 8, fill: '#121821', stroke: t.view ? '#4a6a8a' : '#2b3a4f', 'stroke-dasharray': t.view ? '4 3' : '' }));
      g.append(svg('rect', { x, y, width: W, height: HEAD, rx: 8, fill: '#1a2533' }));
      g.append(svg('text', { x: x + 10, y: y + 17, class: 'h' }, (t.view ? '👁 ' : '') + t.name));
      t.columns.slice(0, MAXC).forEach((c, i) => {
        const cy = y + HEAD + ROW * i + 14, key = `${t.name}.${c.name}`;
        const cls = c.pk ? 'pk' : fkCols.has(key) ? 'fk' : '';
        g.append(svg('text', { x: x + 10, y: cy, class: cls }, (c.pk ? '🔑 ' : fkCols.has(key) ? '↗ ' : '') + c.name));
        const typ = external[key] || c.type;
        g.append(svg('text', { x: x + W - 10, y: cy, 'text-anchor': 'end', class: 't' }, typ.length > 18 ? typ.slice(0, 17) + '…' : typ));
      });
      if (t.columns.length > MAXC) g.append(svg('text', { x: x + 10, y: y + HEAD + ROW * MAXC + 14, class: 't' }, `+ ${t.columns.length - MAXC} more`));
      if (!t.view) g.addEventListener('click', () => openTable(schema, t.name, 0).catch(e => err(e.message)));
      root.append(g);
    });
    $('#db-diagram').replaceChildren(d.tables.length ? root : el('p', { class: 'muted' }, 'No tables yet.'));
    $('#db-diagram-panel').classList.remove('hidden');
    $('#db-diagram-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#db-diagram-open').addEventListener('click', () => openDiagram(cur.schema).catch(e => err(e.message)));
  $('#db-diagram-close').addEventListener('click', () => $('#db-diagram-panel').classList.add('hidden'));
  $('#db-diagram-svg').addEventListener('click', () => {
    const node = $('#db-diagram svg'); if (!node) return;
    const a = el('a', { href: URL.createObjectURL(new Blob([node.outerHTML], { type: 'image/svg+xml' })), download: `${$('#db-diagram-name').textContent}-diagram.svg` });
    document.body.append(a); a.click(); a.remove();
  });

  // ---- saved snippets (stored on the Pi)
  let snippetList = [];
  async function loadSnippets(select) {
    snippetList = await api('/api/snippets');
    $('#snip-list').replaceChildren(el('option', { value: '' }, snippetList.length ? 'Saved snippets…' : 'No saved snippets yet'),
      ...snippetList.map(x => el('option', { value: x.name }, x.name)));
    if (select) $('#snip-list').value = select;
  }
  $('#snip-list').addEventListener('change', () => {
    const s = snippetList.find(x => x.name === $('#snip-list').value);
    if (s) { $('#sql-input').value = s.sql; $('#sql-input').focus(); }
  });
  $('#snip-save').addEventListener('click', async () => {
    const name = prompt('Save this query as:', $('#snip-list').value || '');
    if (!name) return;
    try { await api('/api/snippets', { method: 'POST', body: { name, sql: $('#sql-input').value } }); await loadSnippets(name.trim()); }
    catch (e) { err(e.message); }
  });
  $('#snip-delete').addEventListener('click', async () => {
    const name = $('#snip-list').value;
    if (!name || !confirm(`Delete the saved snippet "${name}"?`)) return;
    try { await api(`/api/snippets?name=${encodeURIComponent(name)}`, { method: 'DELETE' }); await loadSnippets(); }
    catch (e) { err(e.message); }
  });

  // ---- connect an app
  async function openConnect(schema) {
    const c = await api(`/api/db/connect?schema=${encodeURIComponent(schema)}`);
    $('#db-connect-name').textContent = schema;
    $('#db-connect-env').textContent = c.env;
    $('#db-connect-snippet').textContent = c.snippet;
    const warns = [];
    if (!c.exposed) warns.push(`Schema "${schema}" is not exposed through the API yet: requests will fail. Create it with "Create project" (which exposes it) or add it to PGRST_DB_SCHEMAS.`);
    if (c.tablesWithoutRls) warns.push(`${c.tablesWithoutRls} table(s) have RLS off: with this public key anyone could read and change them. See Advisors.`);
    if (!c.url || !c.key) warns.push('Could not read the API URL or publishable key from the Supabase .env.');
    $('#db-connect-warn').replaceChildren(...warns.map(w => el('p', { class: 'warn-box small' }, w)));
    $('#db-connect-redirects').textContent = `Currently allowed: ${[c.siteUrl, ...c.redirects].filter(Boolean).join(', ') || 'none'}`;
    $('#db-connect-panel').classList.remove('hidden');
    $('#db-connect-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#db-connect-close').addEventListener('click', () => $('#db-connect-panel').classList.add('hidden'));

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
