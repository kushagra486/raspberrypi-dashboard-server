// Database section: talks straight to the Supabase Postgres as supabase_admin.
// Host: the supabase-db container's IP (looked up via Docker) unless configured.
// Password: POSTGRES_PASSWORD from the Supabase .env, read at connect time, never sent to the browser.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Pool, escapeIdentifier } = require('pg');
const csv = require('./csv');

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

const rowSafe = r => r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonSafe(v)]));
// Errors that are the user's input (bad SQL, bad value): reported as 400, not 502.
function sqlError(message) { const e = new Error(message); e.sql = true; return e; }

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

  // ---- connect an app (Vercel env block) ---------------------------------------

  async connectInfo(schema) {
    const exists = (await this.q(`select 1 from pg_namespace where nspname = $1`, [schema])).length > 0;
    if (!exists || SYSTEM_SCHEMAS.has(schema)) throw new Error(`No app schema ${schema}`);
    const env = this.supabaseEnv();
    const url = env.SUPABASE_PUBLIC_URL || this.cfg.publicApiUrl || '';
    const key = env.SUPABASE_PUBLISHABLE_KEY || env.ANON_KEY || '';   // public by design; never the secret key
    const [rls] = await this.q(`
      select count(*) filter (where not c.relrowsecurity)::int as without_rls, count(*)::int as tables
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p')`, [schema]);
    const exposed = this.apiSchemas().includes(schema);
    return {
      schema, url, key, exposed, tables: rls.tables, tablesWithoutRls: rls.without_rls,
      siteUrl: env.SITE_URL || '', redirects: (env.ADDITIONAL_REDIRECT_URLS || '').split(',').filter(Boolean),
      env: [
        `NEXT_PUBLIC_SUPABASE_URL=${url}`,
        `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${key}`,
        `NEXT_PUBLIC_SUPABASE_SCHEMA=${schema}`,
      ].join('\n'),
      snippet: [
        `import { createClient } from '@supabase/supabase-js'`,
        ``,
        `export const supabase = createClient(`,
        `  process.env.NEXT_PUBLIC_SUPABASE_URL,`,
        `  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,`,
        `  { db: { schema: process.env.NEXT_PUBLIC_SUPABASE_SCHEMA } }`,
        `)`,
      ].join('\n'),
    };
  }

  // ---- branches: <app>_dev copies of an app schema ---------------------------
  // Copies tables (columns, defaults, constraints, indexes, identity), serial sequences,
  // foreign keys within the schema, RLS and policies, and optionally the rows.
  // Views, functions, triggers and custom types are NOT copied (reported back).

  async appSchemaOrThrow(schema) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(schema || '') || SYSTEM_SCHEMAS.has(schema) || schema === 'public') {
      throw sqlError(`"${schema}" is not an app schema`);
    }
    const r = await this.q(`select 1 from pg_namespace where nspname = $1`, [schema]);
    if (!r.length) throw sqlError(`No schema ${schema}`);
  }

  async branch(source, { withData = false, reset = false } = {}) {
    await this.appSchemaOrThrow(source);
    if (source.endsWith('_dev')) throw sqlError('Branch the original app schema, not a branch');
    const dev = `${source}_dev`;
    if (dev.length > 31) throw sqlError('Schema name too long to branch (max 27 characters)');
    const exists = (await this.q(`select 1 from pg_namespace where nspname = $1`, [dev])).length > 0;
    if (exists && !reset) throw sqlError(`${dev} already exists: reset or delete it`);
    if (!exists && reset) throw sqlError(`${dev} does not exist`);
    if (withData) {
      const [{ size }] = await this.q(`select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as size
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind in ('r','p')`, [source]);
      if (Number(size) > 500 * 1024 * 1024) throw sqlError('Source is larger than 500 MB: branch without data');
    }
    const report = await this.tx(client => this.copySchema(client, source, dev, { withData, dropFirst: reset }));
    if (!exists) await this.expose('add', dev);
    return { branch: dev, ...report };
  }

  async deleteBranch(dev) {
    if (!/^[a-z][a-z0-9_]{1,26}_dev$/.test(dev || '')) throw sqlError('Only branches (schemas ending in _dev) can be deleted here');
    await this.appSchemaOrThrow(dev);
    await this.tx(c => c.query(`drop schema ${escapeIdentifier(dev)} cascade`));
    await this.expose('remove', dev);
    return { deleted: dev };
  }

  expose(cmd, schema) {
    const script = this.cfg.exposeSchemaScript || path.join(__dirname, '..', '..', 'supabase', 'expose-schema.sh');
    return new Promise((resolve, reject) => {
      execFile(script, [cmd, schema], { timeout: 120000, env: { ...process.env, PROJECT_DIR: this.cfg.supabaseDir } },
        (err, stdout, stderr) => err ? reject(new Error(`API exposure (${cmd}) failed: ${(stderr || err.message).trim().split('\n').pop()}`))
          : resolve(stdout.trim()));
    });
  }

  async copySchema(client, src, dst, { withData, dropFirst }) {
    const S = escapeIdentifier(src), D = escapeIdentifier(dst);
    const q = (sql, p) => client.query(sql, p).then(r => r.rows);
    await client.query(`set local search_path = ''`);   // catalog functions then print fully qualified names
    if (dropFirst) await client.query(`drop schema ${D} cascade`);
    await client.query(`create schema ${D}`);
    for (const role of ['postgres', 'supabase_admin']) {
      const exists = (await q(`select 1 from pg_roles where rolname = $1`, [role])).length;
      if (!exists) continue;
      for (const kind of ['tables', 'routines', 'sequences']) {
        await client.query(`alter default privileges for role ${role} in schema ${D} grant all on ${kind} to anon, authenticated, service_role`).catch(() => {});
      }
    }
    const tables = await q(`
      select c.oid, c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p') and not c.relispartition order by c.relname`, [src]);
    const reSrc = new RegExp(`(^|[^\\w."])${src.replace(/[^a-z0-9_]/g, '')}\\.`, 'g');
    const swap = sql => sql == null ? sql : sql.replace(reSrc, `$1${dst}.`);

    for (const t of tables) {
      const T = escapeIdentifier(t.name);
      await client.query(`create table ${D}.${T} (like ${S}.${T} including all)`);
      // serial columns still point at the source's sequences: give the copy its own
      for (const s of await q(`
        select a.attname as col, pg_get_serial_sequence($1, a.attname) as seq
        from pg_attribute a where a.attrelid = $2 and a.attnum > 0 and not a.attisdropped and a.attidentity = ''`,
      [`${S}.${T}`, t.oid])) {
        if (!s.seq) continue;
        const seqName = escapeIdentifier(s.seq.split('.').pop().replace(/"/g, ''));
        const C = escapeIdentifier(s.col);
        await client.query(`create sequence ${D}.${seqName} owned by ${D}.${T}.${C}`);
        await client.query(`alter table ${D}.${T} alter column ${C} set default nextval('${D}.${seqName}'::regclass)`);
      }
    }
    let rows = 0;
    if (withData) {
      for (const t of tables) {
        const T = escapeIdentifier(t.name);
        const cols = (await q(`select attname from pg_attribute where attrelid = $1 and attnum > 0
          and not attisdropped and attgenerated = '' order by attnum`, [t.oid])).map(c => escapeIdentifier(c.attname)).join(', ');
        rows += (await client.query(`insert into ${D}.${T} (${cols}) overriding system value select ${cols} from ${S}.${T}`)).rowCount;
      }
      for (const s of await q(`
        select c.relname as seq, t.relname as tbl, a.attname as col
        from pg_class c join pg_depend d on d.objid = c.oid and d.deptype = 'a'
        join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
        join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and n.nspname = $1`, [dst])) {
        await client.query(`select setval('${D}.${escapeIdentifier(s.seq)}', coalesce((select max(${escapeIdentifier(s.col)}) from ${D}.${escapeIdentifier(s.tbl)}), 0) + 1, false)`);
      }
      for (const t of tables) {   // identity columns
        for (const a of await q(`select attname from pg_attribute where attrelid = $1 and attidentity <> ''`, [t.oid])) {
          const T = escapeIdentifier(t.name), C = escapeIdentifier(a.attname);
          await client.query(`select setval(pg_get_serial_sequence('${D}.${T}', '${a.attname.replace(/'/g, "''")}'), coalesce((select max(${C}) from ${D}.${T}), 0) + 1, false)`);
        }
      }
    }
    for (const fk of await q(`
      select k.conname, c.relname as tbl, pg_get_constraintdef(k.oid) as def
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and k.contype = 'f' order by k.conname`, [src])) {
      await client.query(`alter table ${D}.${escapeIdentifier(fk.tbl)} add constraint ${escapeIdentifier(fk.conname)} ${swap(fk.def)}`);
    }
    let policies = 0;
    for (const t of tables) {
      const T = escapeIdentifier(t.name);
      if (t.rls) await client.query(`alter table ${D}.${T} enable row level security`);
      if (t.force_rls) await client.query(`alter table ${D}.${T} force row level security`);
      for (const p of await q(`
        select polname, polcmd, polpermissive,
               case when polroles = '{0}' then 'public' else
                 (select string_agg(quote_ident(rolname), ', ') from pg_roles where oid = any(polroles)) end as roles,
               pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as chk
        from pg_policy where polrelid = $1`, [t.oid])) {
        const cmd = { r: 'select', a: 'insert', w: 'update', d: 'delete', '*': 'all' }[p.polcmd];
        await client.query(`create policy ${escapeIdentifier(p.polname)} on ${D}.${T} as ${p.polpermissive ? 'permissive' : 'restrictive'}
          for ${cmd} to ${p.roles}${p.qual ? ` using (${swap(p.qual)})` : ''}${p.chk ? ` with check (${swap(p.chk)})` : ''}`);
        policies++;
      }
    }
    await client.query(`grant usage on schema ${D} to anon, authenticated, service_role`);
    for (const kind of ['tables', 'sequences', 'routines']) {
      await client.query(`grant all on all ${kind} in schema ${D} to anon, authenticated, service_role`);
    }
    const [skipped] = await q(`
      select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind in ('v','m'))::int as views,
             (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1)::int as functions,
             (select count(*) from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = $1 and not g.tgisinternal)::int as triggers`, [src]);
    await client.query(`notify pgrst, 'reload schema'`);
    return { tables: tables.length, rows, policies, notCopied: skipped };
  }

  // ---- schema diagram ---------------------------------------------------------

  async diagram(schema) {
    const tables = await this.q(`
      select c.relname as name, c.relkind = 'v' or c.relkind = 'm' as view,
             json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
               'pk', coalesce(a.attnum = any(i.indkey), false), 'nullable', not a.attnotnull) order by a.attnum) as columns
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      left join pg_index i on i.indrelid = c.oid and i.indisprimary
      where n.nspname = $1 and c.relkind in ('r','p','v','m')
      group by c.relname, c.relkind order by c.relname`, [schema]);
    const fks = await this.q(`
      select c.relname as from_table, tn.nspname as to_schema, t.relname as to_table, k.conname as name,
             (select array_agg(a.attname::text order by u.o) from unnest(k.conkey) with ordinality u(n, o)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n) as from_cols,
             (select array_agg(a.attname::text order by u.o) from unnest(k.confkey) with ordinality u(n, o)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n) as to_cols
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace
      where k.contype = 'f' and n.nspname = $1 order by c.relname, k.conname`, [schema]);
    return { schema, tables, fks };
  }

  // ---- migration history (supabase CLI) -----------------------------------------

  async migrations() {
    const ok = (await this.q(`select to_regclass('supabase_migrations.schema_migrations') is not null as ok`))[0].ok;
    if (!ok) return [];
    const cols = (await this.q(`select column_name from information_schema.columns
      where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`)).map(r => r.column_name);
    return this.q(`select version, ${cols.includes('name') ? 'name' : 'null as name'},
        ${cols.includes('statements') ? 'coalesce(array_length(statements, 1), 0)' : '0'} as statements
      from supabase_migrations.schema_migrations order by version desc limit 200`);
  }

  // ---- table editor ------------------------------------------------------------

  async columnsOf(schema, table) {
    await this.assertTable(schema, table);
    return this.q(`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
             coalesce(a.attnum = any(i.indkey), false) as primary_key,
             a.attidentity = 'a' or a.attgenerated <> '' as readonly
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_index i on i.indrelid = c.oid and i.indisprimary
      where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
      order by a.attnum`, [schema, table]);
  }

  // op: insert | update | delete. key: primary key values (update/delete). values: column -> text|null.
  async writeRow({ schema, table, op, key = {}, values = {} }) {
    const cols = await this.columnsOf(schema, table);
    const byName = new Map(cols.map(c => [c.name, c]));
    const pk = cols.filter(c => c.primary_key).map(c => c.name);
    for (const n of [...Object.keys(values), ...Object.keys(key)]) {
      if (!byName.has(n)) throw sqlError(`Unknown column ${n}`);
    }
    const ident = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;
    const params = [];
    const p = v => { params.push(v === undefined ? null : v); return `$${params.length}`; };
    let sql;
    if (op === 'insert') {
      const names = Object.keys(values).filter(n => !byName.get(n).readonly);
      sql = names.length
        ? `insert into ${ident} (${names.map(escapeIdentifier).join(', ')}) values (${names.map(n => p(values[n])).join(', ')}) returning *`
        : `insert into ${ident} default values returning *`;
    } else if (op === 'update' || op === 'delete') {
      if (!pk.length) throw sqlError('This table has no primary key, so rows cannot be edited safely. Add one first (see Advisors).');
      if (!pk.every(n => n in key)) throw sqlError('Missing primary key value');
      const where = pk.map(n => `${escapeIdentifier(n)} = ${p(key[n])}`).join(' and ');
      if (op === 'delete') sql = `delete from ${ident} where ${where} returning *`;
      else {
        const names = Object.keys(values).filter(n => !byName.get(n).readonly);
        if (!names.length) throw sqlError('Nothing to change');
        const sets = names.map(n => `${escapeIdentifier(n)} = ${p(values[n])}`).join(', ');
        sql = `update ${ident} set ${sets} where ${where} returning *`;
      }
    } else throw sqlError(`Unknown operation ${op}`);
    return this.tx(async client => {
      const r = await client.query(sql, params);
      if (op !== 'insert' && r.rowCount !== 1) throw sqlError(`Expected to change 1 row, matched ${r.rowCount}; nothing was changed.`);
      return { op, row: rowSafe(r.rows[0]) };
    });
  }

  async exportCsv(schema, table, maxRows = 100000) {
    const cols = await this.columnsOf(schema, table);
    const pool = await this.getPool();
    const ident = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;
    const r = await pool.query(`select * from ${ident} limit ${Number(maxRows) | 0}`);
    const names = cols.map(c => c.name);
    return csv.stringify(names, r.rows.map(row => names.map(n => jsonSafe(row[n]))));
  }

  // Appends rows. Header must name existing columns. Empty cells become NULL (so defaults do not apply).
  // All-or-nothing: any bad row rolls the whole import back.
  async importCsv(schema, table, text, { maxRows = 50000 } = {}) {
    const cols = await this.columnsOf(schema, table);
    const known = new Set(cols.map(c => c.name));
    const rows = csv.parse(text);
    if (rows.length < 2) throw sqlError('CSV needs a header row and at least one data row');
    const header = rows[0].map(h => h.trim());
    const bad = header.filter(h => !known.has(h));
    if (bad.length) throw sqlError(`Not columns of ${schema}.${table}: ${bad.join(', ')}`);
    if (new Set(header).size !== header.length) throw sqlError('Duplicate column in header');
    const data = rows.slice(1);
    if (data.length > maxRows) throw sqlError(`Too many rows (${data.length}); limit is ${maxRows}`);
    data.forEach((r, i) => { if (r.length !== header.length) throw sqlError(`Row ${i + 2} has ${r.length} fields, header has ${header.length}`); });
    const ident = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;
    const colList = header.map(escapeIdentifier).join(', ');
    const batch = Math.max(1, Math.min(500, Math.floor(60000 / header.length)));
    return this.tx(async client => {
      let inserted = 0;
      for (let i = 0; i < data.length; i += batch) {
        const chunk = data.slice(i, i + batch);
        const params = [];
        const tuples = chunk.map(r => `(${r.map(v => { params.push(v === '' ? null : v); return `$${params.length}`; }).join(', ')})`);
        try {
          inserted += (await client.query(`insert into ${ident} (${colList}) values ${tuples.join(', ')}`, params)).rowCount;
        } catch (e) {
          throw sqlError(`Rows ${i + 2}-${i + 1 + chunk.length}: ${e.message}. Nothing was imported.`);
        }
      }
      return { inserted };
    });
  }

  async tx(fn) {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local statement_timeout = '60s'`);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      if (!e.sql) { const err = sqlError(e.message); throw err; }
      throw e;
    } finally {
      client.release();
    }
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
