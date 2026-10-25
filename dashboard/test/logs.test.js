// Log parsing and redaction (no containers needed).
const { test } = require('node:test');
const assert = require('node:assert');
const { parseLine, redact } = require('../lib/logs');

test('Kong access line: method, path, status, level from status', () => {
  const e = parseLine('2026-10-25T20:24:46.396086078Z 172.18.0.1 - - [25/Oct/2026:20:24:46 +0000] "GET /rest/v1/items?select=* HTTP/1.1" 503 96 "-" "curl/8.14.1"');
  assert.strictEqual(e.method, 'GET'); assert.strictEqual(e.path, '/rest/v1/items?select=*');
  assert.strictEqual(e.status, 503); assert.strictEqual(e.level, 'error');
  assert.strictEqual(e.ts, Date.parse('2026-10-25T20:24:46.396Z'));
});

test('Caddy JSON (isolated proxy): duration in seconds becomes ms', () => {
  const e = parseLine('2026-10-25T20:35:23.1Z {"level":"info","msg":"handled request","request":{"method":"POST","uri":"/p/shop/auth/v1/token"},"status":400,"duration":0.0185}');
  assert.deepStrictEqual([e.method, e.path, e.status, e.ms, e.level], ['POST', '/p/shop/auth/v1/token', 400, 19, 'warn']);
});

test('pino (storage) and GoTrue levels', () => {
  assert.strictEqual(parseLine('2026-10-25T09:05:40.8Z {"level":50,"msg":"boom"}').level, 'error');
  assert.strictEqual(parseLine('2026-10-25T09:05:40.8Z {"level":"warning","msg":"slow"}').level, 'warn');
  assert.strictEqual(parseLine('2026-10-25T09:05:40.8Z 25/Oct/2026:17:25:33 +0000: Schema cache loaded').level, 'info');
  assert.strictEqual(parseLine('2026-10-25T09:05:40.8Z FATAL: password authentication failed').level, 'error');
  assert.strictEqual(parseLine('not a docker line'), null);
});

test('redaction removes keys, tokens, passwords, connection strings and emails', () => {
  // a made-up token, assembled here so no token-shaped literal sits in the repository
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ role: 'service_role' }), 'not-a-real-signature-0123'].join('.');
  const out = redact(`GET /rest/v1/x?apikey=${jwt}&token=abc123 Authorization: Bearer ${jwt} sb_secret_AbC-123 ` +
    '{"password":"hunter2","refresh_token":"r1"} postgresql://postgres:s3cret@db.example:5432/postgres user ana@example.com');
  for (const secret of [jwt, 'abc123', 'AbC-123', 'hunter2', '"r1"', 's3cret', 'ana@example.com']) assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  assert.ok(out.includes('/rest/v1/x?apikey=[redacted]'));
});
