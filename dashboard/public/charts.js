// Tiny SVG charts for Reports and Logs: stacked bars and lines, hover tooltip, data table fallback.
// window.pcChart.bars(target, { points: [{t, values: {k: n}}], series: [{key, label, color}], ... })
// window.pcChart.line(target, { points: [{t, values: {k: n|null}}], series, ... })
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs = {}, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
  let W = 640, H = 190; const L = 44, R = 10, T = 10, B = 26;
  const dims = o => { W = o.wide ? 1200 : 640; H = o.wide ? 120 : 190; };
  const nice = max => { if (max <= 0) return 1; const p = 10 ** Math.floor(Math.log10(max)); const f = max / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  const short = v => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v * 10) / 10));
  const fmtTime = (t, span) => { const d = new Date(t); return span > 2 * 86400000 ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  function frame(target, o, max) {
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: `pc-chart${o.wide ? ' wide' : ''}`, role: 'img', 'aria-label': o.label || '' });
    const top = nice(max), steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = T + (H - T - B) * (1 - i / steps);
      svg.append(s('line', { x1: L, x2: W - R, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
      svg.append(s('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' }, (o.yFmt || short)(top * i / steps)));
    }
    return { svg, top };
  }
  function xTicks(svg, pts, x, span) {
    if (!pts.length) return;
    [0, Math.floor(pts.length / 2), pts.length - 1].forEach(i => svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, fmtTime(pts[i].t, span))));
  }
  function mount(target, svg, o, pts) {
    const tip = document.createElement('div'); tip.className = 'chart-tip hidden';
    const wrap = document.createElement('div'); wrap.className = 'chart-wrap'; wrap.append(svg, tip);
    const legend = document.createElement('div'); legend.className = 'legend';
    if (o.series.length > 1) o.series.forEach(se => { const i = document.createElement('span'); i.innerHTML = `<span class="sw" style="background:${se.color}"></span>`; i.append(se.label); legend.append(i); });
    // data as a table for screen readers and exact numbers
    const det = document.createElement('details'); det.className = 'chart-data small';
    const sum = document.createElement('summary'); sum.textContent = 'Data'; det.append(sum);
    const tbl = document.createElement('table'); tbl.className = 'list';
    tbl.innerHTML = `<thead><tr><th>Time</th>${o.series.map(se => `<th>${se.label}</th>`).join('')}</tr></thead>`;
    const tb = document.createElement('tbody');
    pts.forEach(p => { const tr = document.createElement('tr'); tr.innerHTML = `<td>${new Date(p.t).toLocaleString()}</td>${o.series.map(se => `<td>${p.values[se.key] ?? '–'}</td>`).join('')}`; tb.append(tr); });
    tbl.append(tb); det.append(tbl);
    target.replaceChildren(...(o.series.length > 1 ? [legend] : []), wrap, det);
    return { tip, wrap };
  }
  function hover(svg, tip, wrap, pts, x, bw, o) {
    const width = W;
    pts.forEach((p, i) => {
      const r = s('rect', { x: x(i) - bw / 2, y: T, width: bw, height: H - T - B, class: 'hit' });
      r.addEventListener('mouseenter', () => {
        tip.replaceChildren();
        const head = document.createElement('b'); head.textContent = new Date(p.t).toLocaleString(); tip.append(head);
        o.series.forEach(se => { const d = document.createElement('div'); d.innerHTML = `<span class="sw" style="background:${se.color}"></span>`; d.append(`${se.label}: ${p.values[se.key] ?? '–'}${o.unit ? ` ${o.unit}` : ''}`); tip.append(d); });
        tip.classList.remove('hidden');
        const left = (x(i) / width) * wrap.clientWidth;
        tip.style.left = `${Math.min(left + 12, wrap.clientWidth - tip.offsetWidth - 4)}px`;
        if (left > wrap.clientWidth * 0.6) tip.style.left = `${Math.max(0, left - tip.offsetWidth - 12)}px`;
      });
      r.addEventListener('mouseleave', () => tip.classList.add('hidden'));
      svg.append(r);
    });
  }
  function empty(target, msg) { const p = document.createElement('p'); p.className = 'muted chart-empty'; p.textContent = msg || 'No data yet.'; target.replaceChildren(p); }

  function bars(target, o) {
    dims(o);
    const pts = o.points || [];
    if (!pts.length) return empty(target, o.empty);
    const totals = pts.map(p => o.series.reduce((a, se) => a + (p.values[se.key] || 0), 0));
    const { svg, top } = frame(target, o, Math.max(...totals, 0));
    const step = (W - L - R) / pts.length, bw = Math.max(1, step * 0.72);
    const x = i => L + step * i + step / 2, y = v => T + (H - T - B) * (1 - v / top);
    pts.forEach((p, i) => {
      let acc = 0;
      o.series.forEach(se => {
        const v = p.values[se.key] || 0; if (!v) return;
        const y0 = y(acc), y1 = y(acc + v); acc += v;
        svg.append(s('rect', { x: x(i) - bw / 2, y: y1, width: bw, height: Math.max(1, y0 - y1), fill: se.color, rx: 1.5 }));
      });
    });
    xTicks(svg, pts, x, pts[pts.length - 1].t - pts[0].t);
    const { tip, wrap } = mount(target, svg, o, pts);
    hover(svg, tip, wrap, pts, x, step, o);
  }

  function line(target, o) {
    dims(o);
    const pts = o.points || [];
    const vals = pts.flatMap(p => o.series.map(se => p.values[se.key]).filter(v => v != null));
    if (!pts.length || !vals.length) return empty(target, o.empty);
    const { svg, top } = frame(target, o, o.max != null ? o.max : Math.max(...vals));
    const step = (W - L - R) / Math.max(1, pts.length - 1);
    const x = i => L + step * i, y = v => T + (H - T - B) * (1 - v / top);
    o.series.forEach(se => {
      let d = '', area = '', open = false, first = null;
      pts.forEach((p, i) => {
        const v = p.values[se.key];
        if (v == null) { open = false; return; }
        d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; open = true;
        if (first == null) first = i;
      });
      if (o.area && o.series.length === 1 && first != null) {
        area = `${d}L${x(pts.length - 1).toFixed(1)},${y(0)}L${x(first).toFixed(1)},${y(0)}Z`;
        svg.append(s('path', { d: area, fill: se.color, opacity: 0.14 }));
      }
      svg.append(s('path', { d, fill: 'none', stroke: se.color, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
    });
    xTicks(svg, pts, x, pts[pts.length - 1].t - pts[0].t);
    const { tip, wrap } = mount(target, svg, o, pts);
    hover(svg, tip, wrap, pts, x, Math.max(step, 4), o);
  }

  window.pcChart = { bars, line, short };
})();
