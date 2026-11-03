// Host stats read straight from /proc and /sys: no extra daemons needed.
const fs = require('fs');
const os = require('os');

let lastCpu = null;

function readCpu() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] || 0);
  const total = v.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function cpuPercent() {
  const now = readCpu();
  let pct = null;
  if (lastCpu) {
    const dt = now.total - lastCpu.total;
    pct = dt > 0 ? Math.round((1 - (now.idle - lastCpu.idle) / dt) * 1000) / 10 : 0;
  }
  lastCpu = now;
  return pct;
}

function meminfo() {
  const m = {};
  for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const r = line.match(/^(\w+):\s+(\d+)/);
    if (r) m[r[1]] = Number(r[2]) * 1024;
  }
  return {
    total: m.MemTotal, available: m.MemAvailable, used: m.MemTotal - m.MemAvailable,
    swapTotal: m.SwapTotal, swapUsed: m.SwapTotal - m.SwapFree,
  };
}

function temperature() {
  try {
    return Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000;
  } catch { return null; }
}

async function disk(p) {
  try {
    const s = await fs.promises.statfs(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path: p, total, used: total - free, free };
  } catch { return { path: p, error: 'not mounted' }; }
}

async function snapshot(disks) {
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    cpu: cpuPercent(),
    memory: meminfo(),
    temperature: temperature(),
    disks: await Promise.all(disks.map(disk)),
  };
}

cpuPercent(); // prime the delta so the first request has a value

module.exports = { snapshot };
