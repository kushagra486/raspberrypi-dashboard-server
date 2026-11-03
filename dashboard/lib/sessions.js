// Claude Code and shell sessions, each kept alive in its own tmux session so it
// survives closing the browser, a dashboard restart, and switching devices.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'pc-';
const SEP = '|:pc:|';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

class Sessions {
  constructor(cfg) { this.cfg = cfg; }

  // Resolve a requested folder and make sure it sits inside one of the project roots.
  resolveDir(dir) {
    const real = fs.realpathSync(path.resolve(dir));
    const ok = this.cfg.projectRoots.some(root => {
      try {
        const r = fs.realpathSync(root);
        return real === r || real.startsWith(r + path.sep);
      } catch { return false; }
    });
    if (!ok) throw new Error('Folder is outside the allowed project roots.');
    if (!fs.statSync(real).isDirectory()) throw new Error('Not a folder.');
    return real;
  }

  async list() {
    let out = '';
    try {
      // newer tmux (3.4+) prints control characters such as tab as "_", so use a printable separator
      out = await tmux(['list-sessions', '-F',
        ['#{session_name}', '#{session_created}', '#{session_attached}', '#{pane_current_path}', '#{@pc_kind}'].join(SEP)]);
    } catch (e) {
      if (/no server running|no sessions|error connecting/i.test(e.stderr || '')) return [];
      throw e;
    }
    return out.trim().split('\n').filter(Boolean)
      .map(l => l.split(SEP))
      .filter(([name]) => name.startsWith(PREFIX))
      .map(([name, created, attached, cwd, kind]) => ({
        name: name.slice(PREFIX.length),
        kind: kind || 'shell',
        created: Number(created) * 1000,
        attached: Number(attached),
        cwd,
      }));
  }

  async create({ name, dir, kind }) {
    if (!NAME_RE.test(name || '')) throw new Error('Name: lowercase letters, digits and dashes (max 40).');
    if (!['claude', 'shell'].includes(kind)) throw new Error('Kind must be claude or shell.');
    const cwd = this.resolveDir(dir);
    const existing = await this.list();
    if (existing.some(s => s.name === name)) throw new Error('A session with that name already exists.');

    // Claude runs inside a login shell, so when it exits you drop to a shell
    // in the same folder instead of the session vanishing.
    const shell = this.cfg.shell;
    const command = kind === 'claude'
      ? `${shell} -lc '${this.cfg.claudeBin.replace(/'/g, "'\\''")}; exec ${shell} -l'`
      : `${shell} -l`;
    await tmux(['new-session', '-d', '-s', PREFIX + name, '-c', cwd, '-x', '200', '-y', '50', command]);
    await tmux(['set-option', '-t', PREFIX + name, '@pc_kind', kind]);
    return { name, kind, cwd };
  }

  // The one-click "Terminal" in the top bar: a login shell in the home folder, session "pi".
  // Reused if it is already running, so your history and running commands are still there.
  async terminal() {
    const name = 'pi';
    const found = (await this.list()).find(s => s.name === name);
    if (found) return found;
    const cwd = os.homedir();
    await tmux(['new-session', '-d', '-s', PREFIX + name, '-c', cwd, '-x', '200', '-y', '50', `${this.cfg.shell} -l`]);
    await tmux(['set-option', '-t', PREFIX + name, '@pc_kind', 'shell']);
    return { name, kind: 'shell', cwd };
  }

  async kill(name) {
    if (!NAME_RE.test(name || '')) throw new Error('bad session name');
    await tmux(['kill-session', '-t', PREFIX + name]);
  }

  // Folders a session can start in: the roots and their direct children.
  folders() {
    const home = os.homedir();
    const label = p => (p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
    const out = [];
    for (const root of this.cfg.projectRoots) {
      if (!fs.existsSync(root)) continue;
      out.push({ path: root, label: label(root), root: true });
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) {
          const p = path.join(root, ent.name);
          out.push({ path: p, label: label(p), root: false });
        }
      }
    }
    return out;
  }

  tmuxTarget(name) {
    if (!NAME_RE.test(name || '')) throw new Error('bad session name');
    return PREFIX + name;
  }
}

module.exports = { Sessions };
