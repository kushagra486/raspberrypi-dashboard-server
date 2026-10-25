// Saved SQL snippets, stored on the Pi (one JSON file) so every device sees the same list.
const fs = require('fs');
const path = require('path');

class Snippets {
  constructor(file) { this.file = file; }

  read() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(d) ? d : []; }
    catch { return []; }
  }

  write(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);   // atomic: a crash never leaves half a file
  }

  list() { return this.read().sort((a, b) => a.name.localeCompare(b.name)); }

  save({ name, sql }) {
    name = String(name || '').trim();
    if (!name || name.length > 80) throw Object.assign(new Error('Name: 1-80 characters'), { status: 400 });
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 100000) throw Object.assign(new Error('SQL: 1-100000 characters'), { status: 400 });
    const list = this.read().filter(s => s.name !== name);
    if (list.length >= 300) throw Object.assign(new Error('Too many snippets (300)'), { status: 400 });
    const item = { name, sql, updated: Date.now() };
    this.write([...list, item]);
    return item;
  }

  remove(name) {
    const list = this.read();
    const next = list.filter(s => s.name !== name);
    if (next.length === list.length) throw Object.assign(new Error('No such snippet'), { status: 404 });
    this.write(next);
    return { deleted: name };
  }
}

module.exports = { Snippets };
