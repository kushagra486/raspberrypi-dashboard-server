// Password login with scrypt hashes, in-memory session tokens and a login lockout.
const crypto = require('crypto');

// Hash format: scrypt$<N>$<saltB64>$<hashB64>
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const hash = crypto.scryptSync(password, salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

class Auth {
  constructor({ passwordHash, ttlHours }) {
    this.passwordHash = passwordHash;
    this.ttlMs = ttlHours * 3600 * 1000;
    this.sessions = new Map(); // token -> expiresAt
    this.failures = new Map(); // ip -> { count, until }
  }

  // Five wrong passwords lock that IP out for 15 minutes.
  isLocked(ip) {
    const f = this.failures.get(ip);
    return !!(f && f.until && f.until > Date.now());
  }

  login(ip, password) {
    if (!this.passwordHash) return { ok: false, error: 'No password set. Run: npm run set-password' };
    if (this.isLocked(ip)) return { ok: false, error: 'Too many attempts. Try again later.' };
    if (!verifyPassword(password, this.passwordHash)) {
      const f = this.failures.get(ip) || { count: 0, until: 0 };
      f.count += 1;
      if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
      this.failures.set(ip, f);
      return { ok: false, error: 'Wrong password.' };
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + this.ttlMs);
    return { ok: true, token };
  }

  check(token) {
    const exp = token && this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) { this.sessions.delete(token); return false; }
    return true;
  }

  logout(token) { this.sessions.delete(token); }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { Auth, hashPassword, verifyPassword, parseCookies };
