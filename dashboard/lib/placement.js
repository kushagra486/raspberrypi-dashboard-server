// Placement advisor: decides where a project should live and how it should run, so the Pi
// never runs out of memory. Pure functions (no I/O) so the rules are easy to test and read.
//
// Placements:
//   shared    a schema in the main database: ~0 MB extra, every Supabase feature
//             (storage, edge functions, realtime), but users are shared with other shared projects
//   isolated  own database + users + API keys: ~45 MB awake, 0 MB asleep; Auth + REST only for now
//   cloud     keep on Supabase cloud (needs something isolated projects cannot do yet)
// Run modes (isolated only):
//   always-on   never sleeps: for busy apps where a wake-up delay is not acceptable
//   auto-sleep  stops when idle, wakes on the next request (a few seconds)

const ISO_MB = 45;          // measured on the Pi: Auth ~10 MB + REST ~34 MB
const RESERVE_MB = 600;     // always keep this much memory free for spikes, Postgres and Pi Console
const BUSY_PER_DAY = 1500;  // ~1 request/minute on average: keep awake
const QUIET_DAYS = 3;       // no traffic for this long: sleep is clearly fine

function placementFor(needs) {
  const reasons = [];
  if (!needs.ownUsers) {
    reasons.push('no separate users needed: a schema in the shared database costs ~0 MB and has every Supabase feature');
    return { placement: 'shared', reasons };
  }
  const missing = [];
  if (needs.edgeFunctions) missing.push('edge functions');
  if (needs.storage) missing.push('file storage');
  if (needs.realtime) missing.push('realtime');
  if (missing.length) {
    reasons.push(`needs its own users AND ${missing.join(', ')}, which isolated projects do not have yet: keep it on Supabase cloud for now`);
    return { placement: 'cloud', reasons, missing };
  }
  reasons.push('needs its own users: isolated (own database, users and keys)');
  return { placement: 'isolated', reasons };
}

// mode for an isolated project from its real traffic
function modeFor(activity) {
  const perDay = activity.requests7d != null ? activity.requests7d / 7 : null;
  if (perDay != null && perDay >= BUSY_PER_DAY) {
    return { mode: 'always-on', reason: `busy (~${Math.round(perDay)} requests/day): a wake-up delay would be noticed` };
  }
  if (activity.lastActive == null || Date.now() - activity.lastActive > QUIET_DAYS * 86400000) {
    return { mode: 'auto-sleep', reason: 'no traffic for days: sleeping frees its memory until someone uses it' };
  }
  return { mode: 'auto-sleep', reason: `light traffic (~${Math.round(perDay || 0)} requests/day): sleeps between uses, wakes in seconds` };
}

// Advice for every existing project plus the memory picture.
// projects: [{ key, name, kind: 'shared'|'isolated', ownUsers?, users?, mode?, awake?, memoryMb?, requests7d?, lastActive? }]
// resources: { totalMb, availableMb }
function advise(projects, resources) {
  const out = projects.map(p => {
    if (p.kind === 'shared') {
      return { key: p.key, name: p.name, kind: p.kind, current: 'shared', recommended: { placement: 'shared' },
        reasons: ['uses the shared database: no extra memory'], action: null };
    }
    const m = modeFor(p);
    const current = p.mode || 'always-on';
    const action = current === m.mode ? null : { type: 'set-mode', mode: m.mode };
    return { key: p.key, name: p.name, kind: p.kind, current, awake: p.awake, memoryMb: p.memoryMb,
      recommended: { placement: 'isolated', mode: m.mode }, reasons: [m.reason], action };
  });
  const awakeIso = projects.filter(p => p.kind === 'isolated' && p.awake !== false);
  const isoMb = awakeIso.reduce((a, p) => a + (p.memoryMb || ISO_MB), 0);
  const headroomMb = resources.availableMb - RESERVE_MB;
  return {
    advice: out,
    memory: {
      totalMb: resources.totalMb, availableMb: resources.availableMb, reserveMb: RESERVE_MB,
      headroomMb, isolatedAwakeMb: Math.round(isoMb),
      moreIsolatedProjects: Math.max(0, Math.floor(headroomMb / ISO_MB)),
      status: headroomMb < 0 ? 'critical' : headroomMb < 3 * ISO_MB ? 'warning' : 'good',
    },
  };
}

// Plan for projects you might import (e.g. from Supabase cloud), before anything moves.
// rows: [{ name, ownUsers, storage, edgeFunctions, realtime, traffic: 'low'|'medium'|'high' }]
function planImport(rows, resources) {
  let headroom = resources.availableMb - RESERVE_MB;
  const plan = rows.map(r => {
    const p = placementFor(r);
    let mode = null, costMb = 0, note = null;
    if (p.placement === 'isolated') {
      mode = r.traffic === 'high' ? 'always-on' : 'auto-sleep';
      costMb = mode === 'always-on' ? ISO_MB : 0;   // sleeping projects cost nothing until used
      if (mode === 'always-on' && headroom - costMb < 0) {
        note = 'not enough free memory to keep it always on: it will run in auto-sleep, or move to cloud / more RAM';
        mode = 'auto-sleep'; costMb = 0;
      }
      headroom -= costMb;
    }
    return { name: r.name, placement: p.placement, mode, costMb, reasons: p.reasons, note };
  });
  const isolatedCount = plan.filter(p => p.placement === 'isolated').length;
  return {
    plan,
    summary: {
      shared: plan.filter(p => p.placement === 'shared').length,
      isolated: isolatedCount,
      cloud: plan.filter(p => p.placement === 'cloud').length,
      alwaysOnMb: plan.reduce((a, p) => a + p.costMb, 0),
      headroomAfterMb: Math.round(headroom),
      // worst case: every auto-sleep project awake at the same moment
      worstCaseMb: isolatedCount * ISO_MB,
      worstCaseFits: isolatedCount * ISO_MB <= resources.availableMb - RESERVE_MB,
    },
  };
}

module.exports = { placementFor, modeFor, advise, planImport, ISO_MB, RESERVE_MB };
