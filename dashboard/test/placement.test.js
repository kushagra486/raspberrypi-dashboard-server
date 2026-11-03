// Placement advisor rules (pure functions, no database needed).
const { test } = require('node:test');
const assert = require('node:assert');
const { placementFor, modeFor, advise, planImport, ISO_MB, RESERVE_MB } = require('../lib/placement');

test('placement: shared unless separate users are needed; cloud when isolated lacks a feature', () => {
  assert.strictEqual(placementFor({ ownUsers: false, storage: true, edgeFunctions: true }).placement, 'shared');
  assert.strictEqual(placementFor({ ownUsers: true }).placement, 'isolated');
  const c = placementFor({ ownUsers: true, edgeFunctions: true, storage: true });
  assert.strictEqual(c.placement, 'cloud');
  assert.deepStrictEqual(c.missing, ['edge functions', 'file storage']);
});

test('mode: busy stays on, quiet or idle sleeps', () => {
  assert.strictEqual(modeFor({ requests7d: 7 * 3000, lastActive: Date.now() }).mode, 'always-on');
  assert.strictEqual(modeFor({ requests7d: 70, lastActive: Date.now() }).mode, 'auto-sleep');
  assert.strictEqual(modeFor({ requests7d: 0, lastActive: null }).mode, 'auto-sleep');
});

test('advise: suggests a mode change only when it differs, and reports memory headroom', () => {
  const r = advise([
    { key: 'iso:busy', name: 'busy', kind: 'isolated', mode: 'auto-sleep', requests7d: 7 * 5000, lastActive: Date.now(), awake: true, memoryMb: 50 },
    { key: 'iso:quiet', name: 'quiet', kind: 'isolated', mode: 'auto-sleep', requests7d: 3, lastActive: Date.now() - 86400000, awake: false },
    { key: 'shop', name: 'shop', kind: 'shared' },
  ], { totalMb: 4000, availableMb: 2000 });
  assert.deepStrictEqual(r.advice[0].action, { type: 'set-mode', mode: 'always-on' });
  assert.strictEqual(r.advice[1].action, null);
  assert.strictEqual(r.advice[2].recommended.placement, 'shared');
  assert.strictEqual(r.memory.isolatedAwakeMb, 50);
  assert.strictEqual(r.memory.moreIsolatedProjects, Math.floor((2000 - RESERVE_MB) / ISO_MB));
  assert.strictEqual(r.memory.status, 'good');
  assert.strictEqual(advise([], { totalMb: 4000, availableMb: RESERVE_MB - 1 }).memory.status, 'critical');
});

test('import plan: places each project, counts always-on memory, falls back to sleep when full', () => {
  const rows = [
    { name: 'blog', ownUsers: false },
    { name: 'shop', ownUsers: true, traffic: 'high' },
    { name: 'club', ownUsers: true, traffic: 'low' },
    { name: 'certs', ownUsers: true, edgeFunctions: true },
  ];
  const p = planImport(rows, { totalMb: 4000, availableMb: 2000 });
  assert.deepStrictEqual(p.plan.map(x => [x.name, x.placement, x.mode]),
    [['blog', 'shared', null], ['shop', 'isolated', 'always-on'], ['club', 'isolated', 'auto-sleep'], ['certs', 'cloud', null]]);
  assert.deepStrictEqual({ s: p.summary.shared, i: p.summary.isolated, c: p.summary.cloud, mb: p.summary.alwaysOnMb },
    { s: 1, i: 2, c: 1, mb: ISO_MB });
  const tight = planImport([{ name: 'big', ownUsers: true, traffic: 'high' }], { totalMb: 4000, availableMb: RESERVE_MB + 10 });
  assert.strictEqual(tight.plan[0].mode, 'auto-sleep'); assert.match(tight.plan[0].note, /not enough free memory/);
});
