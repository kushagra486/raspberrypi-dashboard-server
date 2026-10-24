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

module.exports = { Database, SYSTEM_SCHEMAS };
