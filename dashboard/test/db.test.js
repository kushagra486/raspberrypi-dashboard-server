// Database section against a real local Postgres seeded like Supabase (auth, storage, app schemas).
// Skipped unless PI_CONSOLE_TEST_DB=1 (needs the seeded server on 127.0.0.1:5432).
// Seed it first: psql -d postgres -f test/seed.sql (needs pg_stat_statements in shared_preload_libraries).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashPassword } = require('../lib/auth');

const enabled = process.env.PI_CONSOLE_TEST_DB === '1';
const PASSWORD = 'correct horse battery';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-console-db-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let proc; let cookie = '';
const call = (p, opts = {}) => fetch(base + p, { ...opts, headers: { cookie, origin: base, 'content-type': 'application/json', ...(opts.headers || {}) } });
const json = async (p, opts) => { const r = await call(p, opts); return { status: r.status, body: await r.json() }; };

before(async () => {
  if (!enabled) return;
  fs.writeFileSync(path.join(tmp, '.env'), 'PGRST_DB_SCHEMAS=public,graphql_public,janseva,lab\nPOSTGRES_PASSWORD=test-db-pass\n');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    bind: '127.0.0.1', port, projectRoots: [tmp], supabaseDir: tmp, disks: ['/'],
    dockerSocket: path.join(tmp, 'none.sock'), db: { host: '127.0.0.1', port: 5432 },
  }));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PI_CONSOLE_CONFIG: path.join(tmp, 'config.json'), PI_CONSOLE_PASSWORD_HASH: hashPassword(PASSWORD) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => { proc.stdout.on('data', d => /Pi Console on/.test(d) && res()); proc.on('exit', c => rej(new Error(`exit ${c}`))); });
  const r = await call('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => proc && proc.kill());

test('database API needs login', { skip: !enabled }, async () => {
  const r = await fetch(`${base}/api/db/overview`);
  assert.strictEqual(r.status, 401);
});

test('overview: version, size, auth users, storage', { skip: !enabled }, async () => {
  const { status, body } = await json('/api/db/overview');
  assert.strictEqual(status, 200);
  assert.match(body.version, /PostgreSQL/);
  assert.strictEqual(body.authUsers, 2);
  assert.deepStrictEqual({ b: body.storage.buckets, o: body.storage.objects, s: body.storage.bytes }, { b: 1, o: 2, s: '6144' });
});

test('projects: app schemas only, API exposure and RLS gaps', { skip: !enabled }, async () => {
  const { body } = await json('/api/db/projects');
  const names = body.map(p => p.schema);
  assert.ok(names.includes('janseva') && names.includes('shop'));
  assert.ok(!names.includes('auth') && !names.includes('storage') && !names.includes('pg_catalog'));
  const j = body.find(p => p.schema === 'janseva'), s = body.find(p => p.schema === 'shop');
  assert.strictEqual(j.api, true); assert.strictEqual(s.api, false);
  assert.strictEqual(j.tables_without_rls, 0); assert.strictEqual(s.tables_without_rls, 1);
});

test('tables and table detail with columns, policies, paged rows', { skip: !enabled }, async () => {
  const { body: t } = await json('/api/db/tables?schema=janseva');
  assert.strictEqual(t[0].name, 'complaints'); assert.strictEqual(t[0].rls, true); assert.strictEqual(t[0].policies, 1);
  const { body: d } = await json('/api/db/table?schema=janseva&name=complaints&limit=100&offset=200');
  assert.ok(d.columns.find(c => c.name === 'id').primary_key);
  assert.strictEqual(d.policies[0].name, 'public read');
  assert.strictEqual(d.rows.length, 50);
  const { body: o } = await json('/api/db/table?schema=shop&name=orders');
  assert.strictEqual(o.rows[0].big, '9007199254740993'); // bigint survives JSON
  assert.strictEqual(o.rows[0].raw, '\\xdeadbeef');
});

test('table names are validated, not interpolated', { skip: !enabled }, async () => {
  const r = await json('/api/db/table?schema=janseva&name=' + encodeURIComponent('complaints; drop table janseva.complaints'));
  assert.strictEqual(r.status, 502); assert.match(r.body.error, /No table/);
  const still = await json('/api/db/tables?schema=janseva');
  assert.strictEqual(still.body.length, 1);
});

test('auth users never include password hashes', { skip: !enabled }, async () => {
  const r = await call('/api/db/users'); const text = await r.text();
  assert.ok(text.includes('a@example.com')); assert.ok(!text.includes('HASH'));
});

test('SQL editor: read-only by default, writes refused and rolled back', { skip: !enabled }, async () => {
  const sel = await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'select count(*) as n from janseva.complaints' }) });
  assert.deepStrictEqual(sel.body.fields, ['n']); assert.strictEqual(sel.body.rows[0][0], '250'); assert.strictEqual(sel.body.readOnly, true);
  const w = await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: "insert into janseva.complaints (title) values ('x')" }) });
  assert.strictEqual(w.status, 400); assert.match(w.body.error, /read-only/);
  const after = await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'select count(*) from janseva.complaints' }) });
  assert.strictEqual(after.body.rows[0][0], '250');
});

test('SQL editor: writes commit only when read-only is off; errors are reported', { skip: !enabled }, async () => {
  const w = await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'create table shop.tmp_t (id int); insert into shop.tmp_t values (1),(2)', readOnly: false }) });
  assert.strictEqual(w.status, 200); assert.strictEqual(w.body.rowCount, 2);
  const c = await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'select * from shop.tmp_t order by 1' }) });
  assert.deepStrictEqual(c.body.rows, [[1], [2]]);
  await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'drop table shop.tmp_t', readOnly: false }) });
  const bad = await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'selec 1' }) });
  assert.strictEqual(bad.status, 400); assert.match(bad.body.error, /syntax error/);
});

test('SQL editor caps results at 1000 rows', { skip: !enabled }, async () => {
  const r = await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'select g from generate_series(1, 5000) g' }) });
  assert.strictEqual(r.body.rows.length, 1000); assert.strictEqual(r.body.truncated, true);
});

test('new project name is validated before any script runs', { skip: !enabled }, async () => {
  const r = await json('/api/db/projects', { method: 'POST', body: JSON.stringify({ name: 'Bad;Name' }) });
  assert.strictEqual(r.status, 502); assert.match(r.body.error, /lowercase/);
});

test('advisors: security and performance findings with fixes', { skip: !enabled }, async () => {
  const { status, body } = await json('/api/db/advisors');
  assert.strictEqual(status, 200);
  const has = (name, object) => body.find(a => a.name === name && a.object === object);
  assert.strictEqual(has('rls_disabled_in_exposed_schema', 'lab.open_table').level, 'error');
  assert.strictEqual(has('policy_exists_rls_disabled', 'lab.forgot').level, 'error');
  assert.ok(has('rls_enabled_no_policy', 'lab.locked'));
  assert.ok(has('rls_disabled_private_schema', 'shop.orders'));        // shop is not exposed
  assert.match(has('unindexed_foreign_key', 'lab.child').fix, /create index on "lab"\."child" \("?parent_id"?\)/);
  assert.ok(has('no_primary_key', 'lab.nopk'));
  assert.match(has('duplicate_index', 'lab.parent').fix, /drop index "lab"\."parent_name_b"/);
  assert.ok(has('function_search_path_mutable', 'lab.add_one'));
  assert.ok(!body.some(a => /^(auth|storage)\./.test(a.object)));  // platform schemas are not linted
  assert.ok(!has('rls_disabled_in_exposed_schema', 'janseva.complaints'));
  assert.strictEqual(body[0].level, 'error');                        // errors first
});

test('query insights from pg_stat_statements', { skip: !enabled }, async () => {
  await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'select count(*) from janseva.complaints where title like $$%9%$$' }) });
  const { status, body } = await json('/api/db/insights?sort=calls');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.enabled, true); assert.strictEqual(body.sort, 'calls');
  assert.ok(body.rows.length > 0 && body.rows.length <= 25);
  assert.ok(body.rows.some(r => /janseva\.complaints/.test(r.query)));
  assert.ok(!body.rows.some(r => /pg_stat_statements/.test(r.query)));
  const all = await json('/api/db/insights?sort=total&limit=100');
  assert.ok(!JSON.stringify(all.body).includes('test-db-pass'));   // seed's CREATE ROLE ... PASSWORD is redacted

  const bad = await json('/api/db/insights?sort=drop%20table');
  assert.strictEqual(bad.body.sort, 'total');                        // unknown sort falls back, never interpolated
});

test('passwords are masked in query text', () => {
  const { redactSecrets } = require('../lib/db');
  assert.strictEqual(redactSecrets("create role x login password 'it''s secret'"), "create role x login password '***'");
  assert.strictEqual(redactSecrets('ALTER ROLE x WITH ENCRYPTED PASSWORD "abc"; select 1'), "ALTER ROLE x WITH ENCRYPTED PASSWORD '***'; select 1");
  assert.strictEqual(redactSecrets('alter user x password $$p w$$'), "alter user x password '***'");
  assert.strictEqual(redactSecrets('select encrypted_password from auth.users'), 'select encrypted_password from auth.users');
});
