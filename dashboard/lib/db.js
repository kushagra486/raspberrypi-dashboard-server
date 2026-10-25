// Database section: talks straight to the Supabase Postgres as supabase_admin.
// Host: the supabase-db container's IP (looked up via Docker) unless configured.
// Password: POSTGRES_PASSWORD from the Supabase .env, read at connect time, never sent to the browser.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Pool, escapeIdentifier } = require('pg');

// Schemas that belong to Postgres or Supabase itself, not to an app.
const SYSTEM_SCHEMAS = new Set([
  'pg_catalog', 'information_schema', 'pg_toast', 'auth', 'storage', 'realtime', '_realtime',
  'supabase_functions', 'supabase_migrations', 'extensions', 'graphql', 'graphql_public', 'vault',
  'pgsodium', 'pgsodium_masks', 'net', 'cron', '_analytics', 'pgbouncer', 'pgtle', '_supavisor',
]);
const ROW_LIMIT = 1000;

function readEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

// Postgres types that JSON cannot carry exactly (bigint, numeric) come back as strings,
// which is what we want for display. Buffers become hex.
function jsonSafe(v) {
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return v;
}

// pg_stat_statements keeps utility statements (CREATE/ALTER ROLE ... PASSWORD '...') verbatim.
function redactSecrets(sql) {
  return String(sql).replace(/(\b(?:encrypted\s+|unencrypted\s+)?password\s+)('(?:[^']|'')*'|"[^"]*"|\$\$.*?\$\$|\S+)/gis, "$1'***'");
}

class Database {
  constructor(cfg, docker) {
    this.cfg = cfg;
    this.docker = docker;
    this.pool = null;
    this.poolHost = null;
  }

  envFile() { return path.join(this.cfg.supabaseDir, '.env'); }
  supabaseEnv() { return readEnv(this.envFile()); }

  async host() {
    if (this.cfg.db.host) return this.cfg.db.host;
    const info = await this.docker.request('GET', `/containers/${this.cfg.db.container}/json`);
    const nets = Object.values(info.NetworkSettings?.Networks || {});
    const ip = nets.map(n => n.IPAddress).find(Boolean);
    if (!ip) throw new Error(`${this.cfg.db.container} has no IP; is Supabase running?`);
    return ip;
  }

  async getPool() {
    const host = await this.host();
    if (this.pool && this.poolHost === host) return this.pool;
    if (this.pool) this.pool.end().catch(() => {});
    const password = process.env.PI_CONSOLE_DB_PASSWORD || this.supabaseEnv().POSTGRES_PASSWORD;
    if (!password) throw new Error(`No database password (POSTGRES_PASSWORD in ${this.envFile()}).`);
    this.pool = new Pool({
      host, port: this.cfg.db.port, user: this.cfg.db.user, database: this.cfg.db.database, password,
      max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000, application_name: 'pi-console',
    });
    this.pool.on('error', () => {}); // a dropped idle client must not crash the server
    this.poolHost = host;
    return this.pool;
  }

  async q(sql, params = []) {
    const pool = await this.getPool();
    const r = await pool.query(sql, params);
    return r.rows;
  }

  // ---- read-only views ------------------------------------------------------

  async overview() {
    const [db] = await this.q(`
      select version() as version,
             pg_database_size(current_database())::text as size,
             (select numbackends from pg_stat_database where datname = current_database()) as connections,
             (select setting::int from pg_settings where name = 'max_connections') as max_connections,
             pg_postmaster_start_time() as started`);
    const auth = await this.q(`select to_regclass('auth.users') is not null as ok`);
    const users = auth[0].ok ? (await this.q(`select count(*)::int as n from auth.users`))[0].n : null;
    const st = await this.q(`select to_regclass('storage.objects') is not null as ok`);
    let storage = null;
    if (st[0].ok) {
      storage = (await this.q(`
        select (select count(*) from storage.buckets)::int as buckets,
               count(*)::int as objects,
               coalesce(sum((metadata->>'size')::bigint), 0)::text as bytes
        from storage.objects`))[0];
    }
    return { ...db, started: jsonSafe(db.started), authUsers: users, storage };
  }

  apiSchemas() {
    return (this.supabaseEnv().PGRST_DB_SCHEMAS || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  async projects() {
    const rows = await this.q(`
      select n.nspname as schema,
             count(c.oid) filter (where c.relkind in ('r','p'))::int as tables,
             count(c.oid) filter (where c.relkind in ('r','p') and not c.relrowsecurity)::int as tables_without_rls,
             coalesce(sum(pg_total_relation_size(c.oid)) filter (where c.relkind in ('r','p')), 0)::text as size
      from pg_namespace n
      left join pg_class c on c.relnamespace = n.oid
      where n.nspname not like 'pg\\_%' escape '\\'
      group by n.nspname
      order by n.nspname`);
    const api = new Set(this.apiSchemas());
    return rows
      .filter(r => !SYSTEM_SCHEMAS.has(r.schema))
      .map(r => ({ ...r, api: api.has(r.schema) }));
  }

  async assertTable(schema, table) {
    const r = await this.q(`
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p','v','m','f')`, [schema, table]);
    if (!r.length) throw new Error(`No table ${schema}.${table}`);
  }

  async tables(schema) {
    return this.q(`
      select c.relname as name,
             case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
                            when 'm' then 'materialized view' when 'f' then 'foreign table' end as kind,
             greatest(c.reltuples, 0)::bigint::text as est_rows,
             pg_total_relation_size(c.oid)::text as size,
             c.relrowsecurity as rls,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
             obj_description(c.oid, 'pg_class') as comment
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p','v','m','f')
      order by c.relname`, [schema]);
  }

  async table(schema, name, { limit = 100, offset = 0 } = {}) {
    await this.assertTable(schema, name);
    const columns = await this.q(`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
             not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default,
             coalesce(a.attnum = any(i.indkey), false) as primary_key
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      left join pg_index i on i.indrelid = c.oid and i.indisprimary
      where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
      order by a.attnum`, [schema, name]);
    const policies = await this.q(`
      select policyname as name, cmd, roles::text[] as roles, qual as using, with_check
      from pg_policies where schemaname = $1 and tablename = $2 order by policyname`, [schema, name]);
    const pool = await this.getPool();
    const ident = `${escapeIdentifier(schema)}.${escapeIdentifier(name)}`;
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const data = await pool.query(`select * from ${ident} limit ${lim} offset ${off}`);
    return {
      columns, policies,
      rows: data.rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonSafe(v)]))),
      limit: lim, offset: off,
    };
  }

  async authUsers() {
    const ok = (await this.q(`select to_regclass('auth.users') is not null as ok`))[0].ok;
    if (!ok) return [];
    return (await this.q(`
      select id, email, phone, created_at, last_sign_in_at, email_confirmed_at is not null as confirmed
      from auth.users order by created_at desc limit 200`)).map(r => ({
        ...r, created_at: jsonSafe(r.created_at), last_sign_in_at: jsonSafe(r.last_sign_in_at),
      }));
  }

  async buckets() {
    const ok = (await this.q(`select to_regclass('storage.buckets') is not null as ok`))[0].ok;
    if (!ok) return [];
    return this.q(`
      select b.id, b.name, b.public, count(o.id)::int as objects,
             coalesce(sum((o.metadata->>'size')::bigint), 0)::text as bytes
      from storage.buckets b left join storage.objects o on o.bucket_id = b.id
      group by b.id, b.name, b.public order by b.name`);
  }

  // ---- advisors (security + performance lints, after Supabase's splinter) ----

  async advisors() {
    const sys = [...SYSTEM_SCHEMAS];
    const exposed = this.apiSchemas();
    const app = `n.nspname not like 'pg\\_%' escape '\\' and n.nspname <> all($1::text[])`;
    const ident = (s, t) => `${escapeIdentifier(s)}.${escapeIdentifier(t)}`;
    const out = [];
    const add = (level, category, name, title, object, detail, fix) =>
      out.push({ level, category, name, title, object, detail, fix: fix || null });

    const tables = await this.q(`
      select n.nspname as schema, c.relname as name, c.relrowsecurity as rls,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
             exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p') as has_pk
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and ${app}`, [sys]);
    for (const t of tables) {
      const obj = `${t.schema}.${t.name}`, id = ident(t.schema, t.name);
      const isExposed = exposed.includes(t.schema);
      if (!t.rls && t.policies > 0) {
        add('error', 'security', 'policy_exists_rls_disabled', 'Policies exist but RLS is off', obj,
          'The policies are ignored: anyone with the publishable key can read and write every row.',
          `alter table ${id} enable row level security;`);
      } else if (!t.rls && isExposed) {
        add('error', 'security', 'rls_disabled_in_exposed_schema', 'RLS is off on an API-exposed table', obj,
          'Anyone with the publishable key (it is public) can read, change and delete every row.',
          `alter table ${id} enable row level security;\n-- then add policies, e.g.\n-- create policy "read own" on ${id} for select to authenticated using (auth.uid() = user_id);`);
      } else if (!t.rls) {
        add('info', 'security', 'rls_disabled_private_schema', 'RLS is off (schema not exposed yet)', obj,
          'Safe while the schema stays private; becomes fully public the moment the schema is exposed.',
          `alter table ${id} enable row level security;`);
      } else if (t.policies === 0) {
        add('info', 'security', 'rls_enabled_no_policy', 'RLS is on but there are no policies', obj,
          'Nobody can read or write it through the API (only the secret key can). Fine if intended.',
          `create policy "read" on ${id} for select to authenticated using (true);`);
      }
      if (!t.has_pk) {
        add('info', 'performance', 'no_primary_key', 'Table has no primary key', obj,
          'Rows cannot be updated or deleted reliably from Studio, and replication/realtime need a key.',
          `alter table ${id} add column id bigint generated always as identity primary key;`);
      }
    }

    for (const r of await this.q(`
      select n.nspname as schema, c.relname as table, k.conname as fk,
             (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
                from unnest(k.conkey) with ordinality u(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) as cols
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      where k.contype = 'f' and ${app}
        and not exists (select 1 from pg_index i where i.indrelid = k.conrelid
                          and (i.indkey::text || ' ') like (array_to_string(k.conkey, ' ') || ' %'))`, [sys])) {
      add('info', 'performance', 'unindexed_foreign_key', 'Foreign key without an index', `${r.schema}.${r.table}`,
        `${r.fk} (${r.cols}): joins and deletes on the parent table scan this whole table.`,
        `create index on ${ident(r.schema, r.table)} (${r.cols});`);
    }

    for (const r of await this.q(`
      select n.nspname as schema, c.relname as table, array_agg(ic.relname::text order by ic.relname) as indexes
      from pg_index i join pg_class ic on ic.oid = i.indexrelid
      join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      where ${app}
      group by n.nspname, c.relname, i.indkey::text, i.indclass::text,
               coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), coalesce(pg_get_expr(i.indpred, i.indrelid), '')
      having count(*) > 1`, [sys])) {
      add('warn', 'performance', 'duplicate_index', 'Duplicate indexes', `${r.schema}.${r.table}`,
        `${r.indexes.join(', ')} are identical: every write updates both, reads use one.`,
        r.indexes.slice(1).map(x => `drop index ${ident(r.schema, x)};`).join('\n'));
    }

    for (const r of await this.q(`
      select s.schemaname as schema, s.relname as table, s.indexrelname as index,
             pg_relation_size(s.indexrelid)::text as size
      from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
      join pg_namespace n on n.nspname = s.schemaname
      where s.idx_scan = 0 and not i.indisunique and not i.indisprimary and ${app}`, [sys])) {
      add('info', 'performance', 'unused_index', 'Index never used (since stats were last reset)', `${r.schema}.${r.table}`,
        `${r.index} has not been used by any query; it still costs disk and slows writes.`,
        `drop index ${ident(r.schema, r.index)};`);
    }

    for (const r of await this.q(`
      select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${app} and p.prokind in ('f','p')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`, [sys])) {
      add('warn', 'security', 'function_search_path_mutable', 'Function has a mutable search_path', `${r.schema}.${r.name}`,
        'A caller can change search_path and make it run their objects instead of yours.',
        `alter function ${ident(r.schema, r.name)}(${r.args}) set search_path = '';`);
    }

    for (const r of await this.q(`
      select e.extname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = 'public'`)) {
      add('warn', 'security', 'extension_in_public', 'Extension installed in public', `public (${r.extname})`,
        'Its functions become part of the public API surface; Supabase keeps extensions in the "extensions" schema.',
        `alter extension ${escapeIdentifier(r.extname)} set schema extensions;`);
    }

    const rank = { error: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level] || a.object.localeCompare(b.object));
  }

  // ---- query insights (pg_stat_statements) -----------------------------------

  async insights({ sort = 'total', limit = 25 } = {}) {
    const ext = await this.q(`select n.nspname as schema from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements'`);
    if (!ext.length) {
      return { enabled: false, hint: 'Run: create extension pg_stat_statements with schema extensions;' };
    }
    const columns = { total: 'total_exec_time', mean: 'mean_exec_time', calls: 'calls', rows: 'rows' };
    if (!columns[sort]) sort = 'total';
    const order = columns[sort];
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const v = `${escapeIdentifier(ext[0].schema)}.pg_stat_statements`;
    const rows = await this.q(`
      select left(s.query, 2000) as query, r.rolname as role, s.calls::text as calls,
             round(s.total_exec_time::numeric, 1)::text as total_ms,
             round(s.mean_exec_time::numeric, 2)::text as mean_ms,
             s.rows::text as rows,
             round((100 * s.total_exec_time / nullif(sum(s.total_exec_time) over (), 0))::numeric, 1)::text as share
      from ${v} s left join pg_roles r on r.oid = s.userid
      where s.dbid = (select oid from pg_database where datname = current_database())
        and s.query not ilike '%pg_stat_statements%'
      order by s.${order} desc limit ${lim}`);
    const [info] = await this.q(`select (select count(*) from ${v})::int as statements`);
    return { enabled: true, sort, statements: info.statements, rows: rows.map(r => ({ ...r, query: redactSecrets(r.query) })) };
  }

  // ---- SQL editor -----------------------------------------------------------

  // Read-only runs inside a READ ONLY transaction that is always rolled back.
  async run(sql, { readOnly = true } = {}) {
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('Empty query.');
    if (sql.length > 100000) throw new Error('Query too long.');
    const pool = await this.getPool();
    const client = await pool.connect();
    const started = Date.now();
    try {
      await client.query(readOnly ? 'begin read only' : 'begin');
      await client.query(`set local statement_timeout = '30s'`);
      let res = await client.query(sql);
      await client.query(readOnly ? 'rollback' : 'commit');
      if (Array.isArray(res)) res = res.filter(r => r.fields?.length).pop() || res[res.length - 1];
      const rows = res.rows || [];
      return {
        command: res.command, rowCount: res.rowCount,
        fields: (res.fields || []).map(f => f.name),
        rows: rows.slice(0, ROW_LIMIT).map(r => (res.fields || []).map(f => jsonSafe(r[f.name]))),
        truncated: rows.length > ROW_LIMIT,
        ms: Date.now() - started, readOnly,
      };
    } catch (e) {
      await client.query('rollback').catch(() => {});
      const err = new Error(e.message + (e.position ? ` (at character ${e.position})` : ''));
      err.sql = true;
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- new app schema -------------------------------------------------------

  createProject(name) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(name || '')) {
      return Promise.reject(new Error('Name: lowercase letters, digits, underscores; 2-31 chars; starts with a letter.'));
    }
    return new Promise((resolve, reject) => {
      execFile(this.cfg.newProjectScript, [name], {
        timeout: 120000, env: { ...process.env, PROJECT_DIR: this.cfg.supabaseDir },
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message).trim().split('\n').pop()));
        resolve({ name, output: stdout.trim() });
      });
    });
  }
}

module.exports = { Database, SYSTEM_SCHEMAS, redactSecrets };
