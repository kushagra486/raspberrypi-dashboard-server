// Backups tab: list dumps, run a backup now, prove a dump restores, download a dump.
// Scripts live on the Pi: backup.sh (installed by supabase/02-install-backups.sh) and
// supabase/restore-test.sh from this repo. One job at a time.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DUMP = /^db-\d{8}-\d{6}\.dump$/;   // only database dumps; .env copies are never served

class Backups {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = cfg.backupDir;
    this.backupScript = cfg.backupScript || path.join(cfg.supabaseDir, 'backup.sh');
    this.restoreScript = cfg.restoreTestScript || path.join(__dirname, '..', '..', 'supabase', 'restore-test.sh');
    this.busy = null;
  }

  async list() {
    try {
      const names = await fs.promises.readdir(this.dir);
      const items = await Promise.all(names.filter(n => !n.startsWith('.')).map(async n => {
        const st = await fs.promises.stat(path.join(this.dir, n));
        return { name: n, size: st.size, modified: st.mtimeMs, dump: DUMP.test(n) };
      }));
      return items.sort((a, b) => b.modified - a.modified);
    } catch (e) { return { error: `${this.dir}: ${e.code || e.message}` }; }
  }

  async status() {
    const stamp = async f => { try { return (await fs.promises.stat(path.join(this.dir, f))).mtimeMs; } catch { return null; } };
    return {
      offsiteOk: await stamp('.offsite-ok'),
      restoreTestOk: await stamp('.restore-test-ok'),
      busy: this.busy,
      canRun: fs.existsSync(this.backupScript),
      canTest: fs.existsSync(this.restoreScript),
    };
  }

  dumpPath(name) {
    if (!DUMP.test(String(name))) throw Object.assign(new Error('Not a database dump name'), { status: 400 });
    const p = path.join(this.dir, name);
    if (!fs.existsSync(p)) throw Object.assign(new Error('No such backup'), { status: 404 });
    return p;
  }

  run(kind, name) {
    if (this.busy) return Promise.reject(Object.assign(new Error(`Busy: ${this.busy} is still running`), { status: 409 }));
    const [file, args] = kind === 'backup'
      ? [this.backupScript, []]
      : [this.restoreScript, [this.dumpPath(name)]];
    this.busy = kind === 'backup' ? 'backup' : `restore test of ${name}`;
    return new Promise(resolve => {
      execFile(file, args, { timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, BACKUP_DIR: this.dir } },
        (err, stdout, stderr) => {
          this.busy = null;
          const output = `${stdout}${stderr}`.trim().split('\n').slice(-40).join('\n');
          resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, output });
        });
    });
  }
}

module.exports = { Backups, DUMP };
