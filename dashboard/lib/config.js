// Loads config.json (non-secret settings) and .env (secrets) for Pi Console.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function load() {
  loadEnvFile(path.join(ROOT, '.env'));
  const file = process.env.PI_CONSOLE_CONFIG || path.join(ROOT, 'config.json');
  const fallback = path.join(ROOT, 'config.example.json');
  const raw = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : fallback, 'utf8'));

  const cfg = {
    bind: process.env.PI_CONSOLE_BIND || raw.bind || '127.0.0.1',
    port: Number(process.env.PI_CONSOLE_PORT || raw.port || 7070),
    // Set true once the console is served over HTTPS (e.g. behind Cloudflare Tunnel).
    secureCookies: process.env.PI_CONSOLE_SECURE_COOKIES === '1' || raw.secureCookies === true,
    // Extra origins allowed to talk to the API (the tunnel URL, for example).
    allowedOrigins: raw.allowedOrigins || [],
    projectRoots: (raw.projectRoots || ['~/projects']).map(expandHome).map(p => path.resolve(p)),
    claudeBin: expandHome(raw.claudeBin || '~/.local/bin/claude'),
    shell: raw.shell || process.env.SHELL || '/bin/bash',
    backupDir: expandHome(raw.backupDir || '/mnt/data/backups'),
    disks: (raw.disks || ['/', '/mnt/data']).map(expandHome),
    dockerSocket: raw.dockerSocket || '/var/run/docker.sock',
    links: raw.links || [],
    sessionTtlHours: Number(raw.sessionTtlHours || 12),
    passwordHash: process.env.PI_CONSOLE_PASSWORD_HASH || '',
    supabaseDir: expandHome(process.env.PI_CONSOLE_SUPABASE_DIR || raw.supabaseDir || '~/supabase-project'),
    newProjectScript: expandHome(raw.newProjectScript || path.join(ROOT, '..', 'supabase', 'new-project.sh')),
    studioUrl: raw.studioUrl || 'http://raspberrypi:8000',
    // Backups tab actions (defaults: the installed nightly script and this repo's restore test)
    backupScript: raw.backupScript ? expandHome(raw.backupScript) : null,
    restoreTestScript: raw.restoreTestScript ? expandHome(raw.restoreTestScript) : null,
    exposeSchemaScript: raw.exposeSchemaScript ? expandHome(raw.exposeSchemaScript) : null,
    // Where Pi Console keeps its own small state (saved SQL snippets)
    dataDir: expandHome(raw.dataDir || '~/.local/share/pi-console'),
    db: {
      host: process.env.PI_CONSOLE_DB_HOST || raw.db?.host || null,   // null = look up the container IP
      port: Number(process.env.PI_CONSOLE_DB_PORT || raw.db?.port || 5432),
      user: process.env.PI_CONSOLE_DB_USER || raw.db?.user || 'supabase_admin',
      database: raw.db?.database || 'postgres',
      container: raw.db?.container || 'supabase-db',
    },
  };
  return cfg;
}

module.exports = { load, ROOT };
