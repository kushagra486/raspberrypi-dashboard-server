// Minimal RFC 4180 CSV: quoted fields, "" escapes, CRLF/LF, optional UTF-8 BOM.

function parse(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && s[i + 1] === '\n') i++;
    if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));   // skip blank lines
}

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stringify(header, rows) {
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parse, stringify };
