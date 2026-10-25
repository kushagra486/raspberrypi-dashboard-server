// Minimal Docker Engine API client over the unix socket (no dockerode dependency).
const http = require('http');

class Docker {
  constructor(socketPath) { this.socketPath = socketPath; }

  request(method, path, { raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method, path }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            let msg = body.toString();
            try { msg = JSON.parse(msg).message; } catch {}
            return reject(new Error(`docker ${res.statusCode}: ${msg}`));
          }
          if (raw) return resolve(body);
          resolve(body.length ? JSON.parse(body.toString()) : null);
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('docker request timed out')));
      req.end();
    });
  }

  async list() {
    const items = await this.request('GET', '/containers/json?all=1');
    return items.map(c => ({
      id: c.Id.slice(0, 12),
      name: (c.Names[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      project: c.Labels?.['com.docker.compose.project'] || null,
      ports: (c.Ports || []).filter(p => p.PublicPort).map(p => `${p.PublicPort}->${p.PrivatePort}`),
    }));
  }

  action(id, verb) {
    if (!['start', 'stop', 'restart'].includes(verb)) throw new Error('bad action');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error('bad container id');
    return this.request('POST', `/containers/${id}/${verb}`);
  }

  // Log lines of the last `seconds` (no timestamps), capped to `maxLines`.
  async logsSince(id, seconds, maxLines = 100000) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error('bad container id');
    const since = Math.floor(Date.now() / 1000) - Math.max(60, Number(seconds) | 0);
    const buf = await this.request('GET', `/containers/${id}/logs?stdout=1&stderr=1&since=${since}&tail=${maxLines | 0}`, { raw: true });
    return demux(buf);
  }

  async memory(id) {
    try {
      const s = await this.request('GET', `/containers/${id}/stats?stream=false&one-shot=true`);
      const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
      return { usage: Math.max(0, (s.memory_stats?.usage || 0) - cache), limit: s.memory_stats?.limit || null };
    } catch { return null; }
  }

  async state(id) {
    try { const i = await this.request('GET', `/containers/${id}/json`); return i.State?.Health?.Status || i.State?.Status || 'unknown'; }
    catch { return 'missing'; }
  }

  async logs(id, tail = 200) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error('bad container id');
    const n = Math.min(Math.max(Number(tail) || 200, 1), 2000);
    const buf = await this.request('GET', `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${n}`, { raw: true });
    return demux(buf);
  }
}

// Non-TTY logs are multiplexed: 8-byte header (stream, 0,0,0, size uint32 BE) per frame.
function demux(buf) {
  if (buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    const out = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      out.push(buf.subarray(i + 8, i + 8 + size));
      i += 8 + size;
    }
    return Buffer.concat(out).toString('utf8');
  }
  return buf.toString('utf8');
}

module.exports = { Docker };
