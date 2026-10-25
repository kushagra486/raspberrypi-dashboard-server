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
  fs.writeFileSync(path.join(tmp, '.env'), 'PGRST_DB_SCHEMAS=public,graphql_public,janseva,lab\nPOSTGRES_PASSWORD=test-db-pass\nSUPABASE_PUBLIC_URL=https://pi.example\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_test\nSUPABASE_SECRET_KEY=sb_secret_test\n');
  fs.writeFileSync(path.join(tmp, 'expose.sh'), `#!/bin/sh\necho "$1 $2" >> ${path.join(tmp, 'expose.log')}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'new-project.sh'),
    '#!/bin/sh\nPGPASSWORD=test-db-pass psql -q -h 127.0.0.1 -U supabase_admin -d postgres -c "create schema if not exists $1" && echo "created $1"\n', { mode: 0o755 });
  // stand-in for supabase/isolated/iso-project.sh: a real separate database with its own auth.users
  fs.writeFileSync(path.join(tmp, 'iso.sh'), `#!/bin/sh
set -e
# PGPASSWORD comes from the test server's environment
P="psql -q -h 127.0.0.1 -U supabase_admin"
case "$1" in
  create)
    $P -d postgres -c "create database proj_$2"
    $P -d proj_$2 -c "create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
        created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz, encrypted_password text);
      insert into auth.users (email, encrypted_password) values ('$2@iso.example', 'HASH');
      create table public.items (id int primary key, owner text);
      insert into public.items values (1, '$2');"
    mkdir -p "$ISO_DIR/projects/$2"
    printf 'NAME=%s\\nDATABASE=proj_%s\\nANON_KEY=anon-%s\\nSERVICE_KEY=secret-service-%s\\nCREATED=now\\n' $2 $2 $2 $2 > "$ISO_DIR/projects/$2/project.env"
    echo "created isolated project $2"; echo "service key: secret-service-$2" ;;
  migrate)
    $P -d postgres -c "create database proj_$2"
    $P -d proj_$2 -c "create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
        created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz, encrypted_password text);"
    pg_dump -h 127.0.0.1 -U supabase_admin -d postgres --schema=$2 | $P -d proj_$2 -v ON_ERROR_STOP=1 >/dev/null
    mkdir -p "$ISO_DIR/projects/$2"
    printf 'NAME=%s\nDATABASE=proj_%s\nANON_KEY=anon-%s\nSERVICE_KEY=secret-service-%s\nAPI_SCHEMAS=%s,public\nMIGRATED_FROM=%s\n' $2 $2 $2 $2 $2 $2 > "$ISO_DIR/projects/$2/project.env"
    echo "   all tables match: items=3" ;;
  retire-shared)
    [ "$3" = --confirm ] || exit 1
    $P -d postgres -c "drop schema $2 cascade"
    echo "final backup of the shared copy: /backups/$2/shared-final.dump" ;;
  remove)
    [ "$3" = --drop-data ] || exit 1
    $P -d postgres -c "drop database proj_$2"
    rm -rf "$ISO_DIR/projects/$2"
    echo "removed isolated project $2 (final backup kept at /backups/$2/final.dump)" ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    bind: '127.0.0.1', port, projectRoots: [tmp], supabaseDir: tmp, disks: ['/'],
    dockerSocket: path.join(tmp, 'none.sock'), db: { host: '127.0.0.1', port: 5432 },
    exposeSchemaScript: path.join(tmp, 'expose.sh'), dataDir: path.join(tmp, 'data'),
    newProjectScript: path.join(tmp, 'new-project.sh'),
    isoDir: path.join(tmp, 'iso'), isoScript: path.join(tmp, 'iso.sh'),
  }));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PI_CONSOLE_CONFIG: path.join(tmp, 'config.json'), PI_CONSOLE_PASSWORD_HASH: hashPassword(PASSWORD), PGPASSWORD: 'test-db-pass' },
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
  // start from empty statistics so the result does not depend on what other tests ran
  await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'select extensions.pg_stat_statements_reset()', readOnly: false }) });
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

test('connect: env block with public key only, warnings for exposure and RLS', { skip: !enabled }, async () => {
  const { status, body } = await json('/api/db/connect?schema=janseva');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.exposed, true); assert.strictEqual(body.tablesWithoutRls, 0);
  assert.match(body.env, /NEXT_PUBLIC_SUPABASE_URL=https:\/\/pi\.example/);
  assert.match(body.env, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test/);
  assert.match(body.env, /NEXT_PUBLIC_SUPABASE_SCHEMA=janseva/);
  assert.ok(!JSON.stringify(body).includes('sb_secret_test'));
  const shop = (await json('/api/db/connect?schema=shop')).body;
  assert.strictEqual(shop.exposed, false); assert.strictEqual(shop.tablesWithoutRls, 1);
  assert.strictEqual((await json('/api/db/connect?schema=auth')).status, 502);
});

test('table editor: insert, update, delete by primary key', { skip: !enabled }, async () => {
  const post = b => json('/api/db/rows', { method: 'POST', body: JSON.stringify({ schema: 'shop', table: 'orders', ...b }) });
  const note = `it's "quoted"`;
  const ins = await post({ op: 'insert', values: { big: '42', raw: '\\x00ff', note } });
  assert.strictEqual(ins.status, 200);
  const id = ins.body.row.id;
  assert.strictEqual(ins.body.row.raw, '\\x00ff'); assert.strictEqual(ins.body.row.note, note);
  const up = await post({ op: 'update', key: { id: String(id) }, values: { note: null } });
  assert.strictEqual(up.status, 200); assert.strictEqual(up.body.row.note, null);
  const miss = await post({ op: 'update', key: { id: '999999' }, values: { note: 'x' } });
  assert.strictEqual(miss.status, 400); assert.match(miss.body.error, /matched 0/);
  assert.strictEqual((await post({ op: 'delete', key: { id: String(id) } })).status, 200);
  const unknown = await post({ op: 'update', key: { id: '1' }, values: { 'note"; drop table shop.orders; --': 'x' } });
  assert.strictEqual(unknown.status, 400); assert.match(unknown.body.error, /Unknown column/);
  const nopk = await json('/api/db/rows', { method: 'POST', body: JSON.stringify({ schema: 'lab', table: 'nopk', op: 'delete', key: { x: '1' } }) });
  assert.strictEqual(nopk.status, 400); assert.match(nopk.body.error, /no primary key/);
  const typeErr = await post({ op: 'insert', values: { big: 'not a number' } });
  assert.strictEqual(typeErr.status, 400); assert.match(typeErr.body.error, /invalid input syntax/);
});

test('CSV export and all-or-nothing import', { skip: !enabled }, async () => {
  const exp = await call('/api/db/export?schema=shop&name=orders');
  assert.strictEqual(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /shop\.orders\.csv/);
  assert.match(await exp.text(), /^id,big,raw,note\r\n1,9007199254740993,\\xdeadbeef,first\r\n/);
  const count = async () => Number((await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'select count(*) from shop.orders' }) })).body.rows[0][0]);
  const before = await count();
  const csv = 'note,big\r\n"hello, world",1\r\n"multi\nline ""q""",\r\n';
  const imp = await json('/api/db/import', { method: 'POST', body: JSON.stringify({ schema: 'shop', name: 'orders', csv }) });
  assert.strictEqual(imp.status, 200); assert.strictEqual(imp.body.inserted, 2);
  const rows = (await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: "select note, big from shop.orders where note like 'hello%' or note like 'multi%' order by note" }) })).body.rows;
  assert.deepStrictEqual(rows, [['hello, world', '1'], ['multi\nline "q"', null]]);
  const bad = await json('/api/db/import', { method: 'POST', body: JSON.stringify({ schema: 'shop', name: 'orders', csv: 'note,big\nok,1\nbad,notanumber\n' }) });
  assert.strictEqual(bad.status, 400); assert.match(bad.body.error, /Nothing was imported/);
  const hdr = await json('/api/db/import', { method: 'POST', body: JSON.stringify({ schema: 'shop', name: 'orders', csv: 'nope\n1\n' }) });
  assert.strictEqual(hdr.status, 400); assert.match(hdr.body.error, /Not columns/);
  assert.strictEqual(await count(), before + 2);   // the failed import added nothing
  await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: "delete from shop.orders where note like 'hello%' or note like 'multi%'", readOnly: false }) });
});

test('CSV parser handles quotes, newlines and BOM', () => {
  const csvlib = require('../lib/csv');
  assert.deepStrictEqual(csvlib.parse('﻿a,b\r\n"x,1","y ""z"""\n\n"multi\nline",\n'), [['a', 'b'], ['x,1', 'y "z"'], ['multi\nline', '']]);
  assert.throws(() => csvlib.parse('a\n"open'), /unterminated/);
  assert.strictEqual(csvlib.stringify(['a', 'b'], [[' lead', 'q"x'], [null, { k: 1 }]]), 'a,b\r\n" lead","q""x"\r\n,"{""k"":1}"\r\n');
});

test('branch an app: structure, data, sequences, FKs, policies; reset; delete', { skip: !enabled }, async () => {
  const sql = async (q, readOnly = true) => (await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: q, readOnly }) })).body;
  const b = await json('/api/db/branch', { method: 'POST', body: JSON.stringify({ schema: 'blog', withData: true }) });
  assert.strictEqual(b.status, 200, JSON.stringify(b.body));
  assert.deepStrictEqual({ t: b.body.tables, r: b.body.rows, p: b.body.policies }, { t: 2, r: 13, p: 2 });
  assert.deepStrictEqual(b.body.notCopied, { views: 1, functions: 1, triggers: 1 });
  assert.match(fs.readFileSync(path.join(tmp, 'expose.log'), 'utf8'), /^add blog_dev$/m);
  // own sequences: inserting into the branch does not touch the original
  await sql(`insert into blog_dev.posts (title) values ('Dev only'); insert into blog_dev.comments (post_id, body) values (1, 'x')`, false);
  assert.deepStrictEqual((await sql(`select max(id) from blog_dev.posts`)).rows[0], [4]);
  assert.deepStrictEqual((await sql(`select max(id)::int from blog_dev.comments`)).rows[0], [11]);
  assert.deepStrictEqual((await sql(`select count(*)::int from blog.posts`)).rows[0], [3]);
  assert.deepStrictEqual((await sql(`select last_value::int from blog.posts_id_seq`)).rows[0], [3]);
  // generated column regenerated, FK points inside the branch, external FK kept, policy rewritten
  assert.deepStrictEqual((await sql(`select slug from blog_dev.posts where id = 4`)).rows[0], ['dev only']);
  const fk = (await sql(`select confrelid::regclass::text from pg_constraint where conrelid = 'blog_dev.comments'::regclass and contype = 'f' order by 1`)).rows.map(r => r[0]);
  assert.deepStrictEqual(fk, ['auth.users', 'blog_dev.posts']);
  const pol = (await sql(`select qual from pg_policies where schemaname = 'blog_dev' and tablename = 'comments'`)).rows[0][0];
  assert.match(pol, /blog_dev\.posts/); assert.ok(!/[^_]blog\.posts/.test(pol));
  assert.deepStrictEqual((await sql(`select relrowsecurity from pg_class where oid = 'blog_dev.posts'::regclass`)).rows[0], [true]);
  assert.deepStrictEqual((await sql(`select has_table_privilege('anon', 'blog_dev.posts', 'select')`)).rows[0], [true]);
  // second branch refused; reset restores the original's rows
  assert.strictEqual((await json('/api/db/branch', { method: 'POST', body: JSON.stringify({ schema: 'blog' }) })).status, 400);
  const r = await json('/api/db/branch', { method: 'POST', body: JSON.stringify({ schema: 'blog', withData: false, reset: true }) });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.rows, 0);
  assert.deepStrictEqual((await sql(`select count(*)::int from blog_dev.posts`)).rows[0], [0]);
  // only *_dev schemas can be deleted, never system or real app schemas
  assert.strictEqual((await json('/api/db/branch?schema=blog', { method: 'DELETE' })).status, 400);
  assert.strictEqual((await json('/api/db/branch?schema=auth', { method: 'DELETE' })).status, 400);
  assert.strictEqual((await json('/api/db/branch', { method: 'POST', body: JSON.stringify({ schema: 'auth' }) })).status, 400);
  const del = await json('/api/db/branch?schema=blog_dev', { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual((await sql(`select count(*)::int from pg_namespace where nspname = 'blog_dev'`)).rows[0], [0]);
  assert.match(fs.readFileSync(path.join(tmp, 'expose.log'), 'utf8'), /^remove blog_dev$/m);
});

test('schema diagram: tables, columns, keys and foreign keys', { skip: !enabled }, async () => {
  const { status, body } = await json('/api/db/diagram?schema=blog');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.tables.map(t => t.name), ['comments', 'posts', 'recent']);
  assert.ok(body.tables.find(t => t.name === 'recent').view);
  assert.ok(body.tables.find(t => t.name === 'posts').columns.find(c => c.name === 'id').pk);
  const fk = body.fks.find(f => f.to_table === 'posts');
  assert.deepStrictEqual({ from: fk.from_table, cols: fk.from_cols, to: fk.to_cols }, { from: 'comments', cols: ['post_id'], to: ['id'] });
  assert.ok(body.fks.find(f => f.to_schema === 'auth' && f.to_table === 'users'));
});

test('saved SQL snippets persist on the server', { skip: !enabled }, async () => {
  assert.deepStrictEqual((await json('/api/snippets')).body, []);
  assert.strictEqual((await json('/api/snippets', { method: 'POST', body: JSON.stringify({ name: 'open complaints', sql: 'select 1' }) })).status, 200);
  await json('/api/snippets', { method: 'POST', body: JSON.stringify({ name: 'open complaints', sql: 'select 2' }) });   // overwrite
  await json('/api/snippets', { method: 'POST', body: JSON.stringify({ name: 'a first', sql: 'select 3' }) });
  const list = (await json('/api/snippets')).body;
  assert.deepStrictEqual(list.map(s => [s.name, s.sql]), [['a first', 'select 3'], ['open complaints', 'select 2']]);
  assert.strictEqual((fs.statSync(path.join(tmp, 'data', 'snippets.json')).mode & 0o777), 0o600);
  assert.strictEqual((await json('/api/snippets', { method: 'POST', body: JSON.stringify({ name: '', sql: 'x' }) })).status, 400);
  assert.strictEqual((await json('/api/snippets?name=a%20first', { method: 'DELETE' })).status, 200);
  assert.strictEqual((await json('/api/snippets?name=nope', { method: 'DELETE' })).status, 404);
  assert.strictEqual((await json('/api/db/migrations')).body.length, 0);   // no supabase_migrations schema in the seed
});

test('organizations: default org holds existing projects; create, move, rename, delete', { skip: !enabled }, async () => {
  const orgs = async () => (await json('/api/db/orgs')).body;
  let list = await orgs();
  assert.strictEqual(list.length, 1); assert.strictEqual(list[0].name, 'Personal'); assert.strictEqual(list[0].is_default, true);
  assert.ok(['janseva', 'shop', 'blog'].every(s => list[0].projects.some(p => p.schema === s)));
  assert.ok(!list[0].projects.some(p => p.schema === 'pi_console'));          // metadata schema stays hidden
  const acme = await json('/api/db/orgs', { method: 'POST', body: JSON.stringify({ name: 'Client Acme' }) });
  assert.strictEqual(acme.status, 201);
  assert.strictEqual((await json('/api/db/orgs', { method: 'POST', body: JSON.stringify({ name: 'Client Acme' }) })).status, 400);
  // new project directly inside the new org
  const np = await json('/api/db/projects', { method: 'POST', body: JSON.stringify({ name: 'acme_store', orgId: acme.body.id }) });
  assert.strictEqual(np.status, 201, JSON.stringify(np.body));
  assert.strictEqual((await json('/api/db/projects', { method: 'POST', body: JSON.stringify({ name: 'x_dev' }) })).status, 502);
  // move blog there; its branch follows
  await json('/api/db/branch', { method: 'POST', body: JSON.stringify({ schema: 'blog' }) });
  assert.strictEqual((await json('/api/db/projects/move', { method: 'POST', body: JSON.stringify({ schema: 'blog', orgId: acme.body.id }) })).status, 200);
  assert.strictEqual((await json('/api/db/projects/move', { method: 'POST', body: JSON.stringify({ schema: 'blog_dev', orgId: acme.body.id }) })).status, 400);
  list = await orgs();
  const a = list.find(o => o.name === 'Client Acme');
  assert.deepStrictEqual(a.projects.map(p => p.schema).sort(), ['acme_store', 'blog', 'blog_dev']);
  assert.ok(!list[0].projects.some(p => p.schema === 'blog'));
  // rename; delete refused while it has projects; default org is never deletable
  assert.strictEqual((await json('/api/db/orgs', { method: 'PATCH', body: JSON.stringify({ id: a.id, name: 'Acme Ltd' }) })).body.name, 'Acme Ltd');
  assert.match((await json(`/api/db/orgs?id=${a.id}`, { method: 'DELETE' })).body.error, /Move or delete/);
  assert.match((await json(`/api/db/orgs?id=${list[0].id}`, { method: 'DELETE' })).body.error, /default/);
  // empty it, then delete
  await json('/api/db/branch?schema=blog_dev', { method: 'DELETE' });
  for (const s of ['blog', 'acme_store']) await json('/api/db/projects/move', { method: 'POST', body: JSON.stringify({ schema: s, orgId: list[0].id }) });
  assert.strictEqual((await json(`/api/db/orgs?id=${a.id}`, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await orgs()).length, 1);
  await json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: 'drop schema acme_store; delete from pi_console.projects', readOnly: false }) });
});

test('isolated projects: create, list in org, scoped screens, connect, delete', { skip: !enabled }, async () => {
  const orgs = (await json('/api/db/orgs')).body;
  const personal = orgs.find(o => o.is_default);
  for (const n of ['isoa', 'isob']) {
    const r = await json('/api/db/isolated', { method: 'POST', body: JSON.stringify({ name: n, orgId: personal.id }) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes('secret-service'));        // keys never reach the browser
  }
  assert.strictEqual((await json('/api/db/isolated', { method: 'POST', body: JSON.stringify({ name: 'isoa' }) })).status, 400);
  const listed = (await json('/api/db/orgs')).body.find(o => o.is_default).projects.filter(p => p.kind === 'isolated');
  assert.deepStrictEqual(listed.map(p => [p.name, p.users, p.tables]), [['isoa', 1, 1], ['isob', 1, 1]]);
  // every screen scoped with ?db= sees only that project's database
  const ua = (await json('/api/db/users?db=proj_isoa')).body;
  assert.deepStrictEqual(ua.map(u => u.email), ['isoa@iso.example']);
  const ub = (await json('/api/db/users?db=proj_isob')).body;
  assert.deepStrictEqual(ub.map(u => u.email), ['isob@iso.example']);
  assert.ok(!(await json('/api/db/users')).body.some(u => /iso\.example/.test(u.email)));   // main pool unaffected
  const rows = (await json('/api/db/table?db=proj_isoa&schema=public&name=items')).body.rows;
  assert.deepStrictEqual(rows, [{ id: 1, owner: 'isoa' }]);
  const sel = await json('/api/db/sql?db=proj_isob', { method: 'POST', body: JSON.stringify({ sql: 'select owner from public.items' }) });
  assert.deepStrictEqual(sel.body.rows, [['isob']]);
  const cross = await json('/api/db/sql?db=proj_isoa', { method: 'POST', body: JSON.stringify({ sql: 'select * from janseva.complaints limit 1' }) });
  assert.strictEqual(cross.status, 400);                                 // main data invisible from a project
  assert.strictEqual((await json('/api/db/tables?db=proj_nope&schema=public')).status, 400);
  assert.strictEqual((await json('/api/db/tables?db=postgres&schema=public')).status, 400);
  assert.strictEqual((await json('/api/db/branch?db=proj_isoa', { method: 'POST', body: JSON.stringify({ schema: 'public' }) })).status, 400);
  const adv = (await json('/api/db/advisors?db=proj_isoa')).body;
  assert.ok(adv.some(a => a.name === 'rls_disabled_in_exposed_schema' && a.object === 'public.items'));
  // connect: own URL + own public key, never the service key
  const c = (await json('/api/db/connect?schema=iso:isoa')).body;
  assert.match(c.env, /NEXT_PUBLIC_SUPABASE_URL=https:\/\/pi\.example\/p\/isoa/);
  assert.match(c.env, /NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-isoa/);
  assert.ok(!JSON.stringify(c).includes('secret-service'));
  assert.strictEqual(c.tablesWithoutRls, 1);
  // moving between orgs works for isolated projects too
  const org = (await json('/api/db/orgs', { method: 'POST', body: JSON.stringify({ name: 'Iso Org' }) })).body;
  await json('/api/db/projects/move', { method: 'POST', body: JSON.stringify({ schema: 'iso:isob', orgId: org.id }) });
  assert.ok((await json('/api/db/orgs')).body.find(o => o.name === 'Iso Org').projects.some(p => p.name === 'isob'));
  // delete
  for (const n of ['isoa', 'isob']) {
    const d = await json(`/api/db/isolated?name=${n}`, { method: 'DELETE' });
    assert.strictEqual(d.status, 200); assert.strictEqual(d.body.finalBackup, `/backups/${n}/final.dump`);
  }
  assert.strictEqual((await json('/api/db/isolated?name=isoa', { method: 'DELETE' })).status, 400);
  assert.strictEqual((await json('/api/db/users?db=proj_isoa')).status, 400);
  await json(`/api/db/orgs?id=${org.id}`, { method: 'DELETE' });
});

test('project overview: shared project and isolated project', { skip: !enabled }, async () => {
  const shared = await json('/api/db/project-overview?project=janseva');
  assert.strictEqual(shared.status, 200, JSON.stringify(shared.body));
  const s = shared.body;
  assert.strictEqual(s.kind, 'shared'); assert.strictEqual(s.sharedUsers, true);
  assert.strictEqual(s.users.total, 2); assert.strictEqual(s.users.signupsPerDay.length, 30);
  assert.strictEqual(s.tables, 1); assert.strictEqual(s.topTables[0].name, 'complaints'); assert.strictEqual(s.topTables[0].rows, '250');
  assert.strictEqual(s.requests, null);                                   // not tracked per shared project
  assert.ok(s.advisors.error === 0);                                      // lab's errors are not janseva's
  const lab = (await json('/api/db/project-overview?project=lab')).body;
  assert.ok(lab.advisors.error >= 2);
  assert.strictEqual((await json('/api/db/project-overview?project=auth')).status, 400);
  // isolated: own users only
  await json('/api/db/isolated', { method: 'POST', body: JSON.stringify({ name: 'isoa' }) });
  const iso = (await json('/api/db/project-overview?project=iso:isoa')).body;
  assert.strictEqual(iso.kind, 'isolated'); assert.strictEqual(iso.database, 'proj_isoa');
  assert.strictEqual(iso.users.total, 1); assert.strictEqual(iso.users.new30, 1);
  assert.strictEqual(iso.users.signupsPerDay.at(-1).n, 1);
  assert.ok(iso.requests && iso.requests.error);                          // no proxy in this test: reported, not thrown
  assert.ok(!JSON.stringify(iso).includes('secret-service'));
  await json('/api/db/isolated?name=isoa', { method: 'DELETE' });
});

test('request counts come from the proxy log, per project, without keys', async () => {
  const { Database } = require('../lib/db');
  const now = Date.now() / 1000;
  const line = (uri, status, ago = 60, method = 'GET') => JSON.stringify({ ts: now - ago, request: { method, uri }, status, duration: 0.012 });
  const log = [
    line('/p/shop/rest/v1/orders', 200), line('/p/shop/rest/v1/orders', 200, 120),
    line('/p/shop/auth/v1/token', 400, 30, 'POST'), line('/p/shop/rest/v1/items/3f2b8c1e-1111-4a2b-9c3d-1234567890ab', 503),
    line('/p/shopping/rest/v1/x', 200),                         // another project with a similar name
    line('/p/shop/rest/v1/old', 200, 25 * 3600),               // older than 24 h
    'not json', '{"level":"info","msg":"server running"}',
  ].join('\n');
  const db = new Database({ db: {}, supabaseDir: '/nonexistent' }, { logsSince: async () => log });
  const r = await db.proxyRequests('shop');
  assert.deepStrictEqual({ total: r.total, e4: r.clientErrors, e5: r.serverErrors }, { total: 4, e4: 1, e5: 1 });
  assert.strictEqual(r.perHour.length, 24);
  assert.strictEqual(r.perHour.reduce((a, h) => a + h.n, 0), 4);
  assert.deepStrictEqual(r.top[0], { path: 'GET /rest/v1/orders', n: 2 });
  assert.ok(r.top.some(t => t.path === 'GET /rest/v1/items/:id'));          // ids folded together
  assert.strictEqual(r.p95ms, 12);
});

test('make isolated: copy a shared project, connect with its schema, retire the shared copy', { skip: !enabled }, async () => {
  const sql = (q) => json('/api/db/sql', { method: 'POST', body: JSON.stringify({ sql: q, readOnly: false }) });
  await sql('drop schema if exists migt cascade; create schema migt; create table migt.items (id int primary key, name text); insert into migt.items values (1,\'a\'),(2,\'b\'),(3,\'c\'); alter table migt.items enable row level security');
  const org = (await json('/api/db/orgs', { method: 'POST', body: JSON.stringify({ name: 'Mig Org' }) })).body;
  await json('/api/db/projects/move', { method: 'POST', body: JSON.stringify({ schema: 'migt', orgId: org.id }) });
  assert.strictEqual((await json('/api/db/make-isolated', { method: 'POST', body: JSON.stringify({ schema: 'migt_dev' }) })).status, 400);
  assert.strictEqual((await json('/api/db/make-isolated', { method: 'POST', body: JSON.stringify({ schema: 'auth' }) })).status, 400);
  const r = await json('/api/db/make-isolated', { method: 'POST', body: JSON.stringify({ schema: 'migt' }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.verified, 'items=3'); assert.strictEqual(r.body.sharedCopyKept, true);
  assert.strictEqual((await json('/api/db/make-isolated', { method: 'POST', body: JSON.stringify({ schema: 'migt' }) })).status, 400);
  // it lands in the same organization, flagged as having a shared copy, with its schema as the app schema
  const inOrg = (await json('/api/db/orgs')).body.find(o => o.name === 'Mig Org').projects;
  const iso = inOrg.find(p => p.kind === 'isolated' && p.name === 'migt');
  assert.ok(iso); assert.strictEqual(iso.appSchema, 'migt'); assert.strictEqual(iso.sharedCopy, true); assert.strictEqual(iso.tables, 1);
  assert.ok(inOrg.some(p => p.schema === 'migt' && p.kind !== 'isolated'));              // shared copy still listed
  const c = (await json('/api/db/connect?schema=iso:migt')).body;
  assert.match(c.env, /NEXT_PUBLIC_SUPABASE_SCHEMA=migt/); assert.match(c.snippet, /db: \{ schema:/);
  const rows = (await json('/api/db/table?db=proj_migt&schema=migt&name=items')).body.rows;
  assert.strictEqual(rows.length, 3);
  const ov = (await json('/api/db/project-overview?project=iso:migt')).body;
  assert.strictEqual(ov.schema, 'migt'); assert.strictEqual(ov.tables, 1);
  // retire: only for migrated projects; shared copy gone, isolated copy intact
  assert.strictEqual((await json('/api/db/retire-shared', { method: 'POST', body: JSON.stringify({ schema: 'janseva' }) })).status, 400);
  const ret = await json('/api/db/retire-shared', { method: 'POST', body: JSON.stringify({ schema: 'migt' }) });
  assert.strictEqual(ret.status, 200); assert.strictEqual(ret.body.finalBackup, '/backups/migt/shared-final.dump');
  const after = (await json('/api/db/orgs')).body.find(o => o.name === 'Mig Org').projects;
  assert.ok(!after.some(p => p.schema === 'migt' && p.kind !== 'isolated'));
  assert.strictEqual(after.find(p => p.name === 'migt').sharedCopy, false);
  assert.strictEqual((await json('/api/db/table?db=proj_migt&schema=migt&name=items')).body.rows.length, 3);
  await json('/api/db/isolated?name=migt', { method: 'DELETE' });
  await json(`/api/db/orgs?id=${org.id}`, { method: 'DELETE' });
});
