// Small canvas line-chart with crosshair tooltip, optional min/max band, stage markers
// and a log-y option. One y-axis per chart by design.

import { fmt } from './colormap.js';

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function ticks(min, max, n = 5) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export class LineChart {
  constructor(container, opts = {}) {
    this.el = container;
    this.opts = opts;
    this.el.classList.add('chart');
    this.title = document.createElement('div'); this.title.className = 'chart-title';
    this.legend = document.createElement('div'); this.legend.className = 'chart-legend';
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div'); this.tip.className = 'chart-tip';
    const head = document.createElement('div'); head.className = 'chart-head';
    head.append(this.title, this.legend);
    this.el.append(head, this.canvas, this.tip);
    this.series = []; this.markers = [];
    this.hoverX = null;
    this.canvas.addEventListener('mousemove', (e) => { const r = this.canvas.getBoundingClientRect(); this.hoverX = e.clientX - r.left; this.draw(); });
    this.canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.tip.style.display = 'none'; this.draw(); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
  }

  // series: [{name, x[], y[], color, band: {lo[], hi[]}, dash}]
  // yMax: optional upper axis limit; data above it is clipped and the peak noted on the chart.
  // shade: optional [{x0, x1, label}] x-ranges drawn greyed (e.g. outside the evaluation zone).
  set(data) {
    Object.assign(this, { series: data.series || [], markers: data.markers || [], yMax: data.yMax ?? null, shade: data.shade || [], xfmt: data.xfmt || fmt });
    this.title.textContent = data.title || '';
    this.xlabel = data.xlabel || ''; this.ylabel = data.ylabel || '';
    this.logY = !!data.logY;
    this.cursorX = data.cursorX ?? null;
    this.legend.innerHTML = '';
    if (this.series.length > 1) {
      for (const s of this.series) {
        const it = document.createElement('span'); it.className = 'legend-item';
        it.innerHTML = `<i style="background:${s.color}"></i>${s.name}`;
        this.legend.append(it);
      }
    }
    this.draw();
  }

  draw() {
    const cv = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = this.el.clientWidth, H = Math.max(80, this.el.clientHeight - 28);
    if (W < 10) return;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const muted = css('--text-muted') || '#888', grid = css('--grid') || '#333', text2 = css('--text-secondary') || '#aaa';
    const ser = this.series.filter((s) => s.x && s.x.length);
    if (!ser.length) { g.fillStyle = muted; g.font = '12px system-ui'; g.fillText('No data yet', 12, 24); return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const tf = (v) => (this.logY ? Math.log10(Math.max(v, 1e-30)) : v);
    for (const s of ser) {
      for (let i = 0; i < s.x.length; i++) {
        x0 = Math.min(x0, s.x[i]); x1 = Math.max(x1, s.x[i]);
        const ys = [s.y[i]]; if (s.band) ys.push(s.band.lo[i], s.band.hi[i]);
        for (const y of ys) if (isFinite(y) && (!this.logY || y > 0)) { y0 = Math.min(y0, tf(y)); y1 = Math.max(y1, tf(y)); }
      }
    }
    if (!this.logY) y0 = Math.min(y0, 0);
    if (!(y1 > y0)) { y1 = y0 + 1; }
    // optional clip of the y-range (outliers such as a tip deposit would otherwise flatten the profile)
    let peak = null;
    if (!this.logY && this.yMax !== null && isFinite(this.yMax) && this.yMax > y0 && this.yMax < y1) {
      for (const s of ser) for (let i = 0; i < s.x.length; i++) {
        const v = s.band ? Math.max(s.y[i], s.band.hi[i]) : s.y[i];
        if (isFinite(v) && (!peak || v > peak.y)) peak = { x: s.x[i], y: v };
      }
      y1 = this.yMax;
    }
    if (!this.logY) y1 += (y1 - y0) * 0.06;
    if (!(x1 > x0)) x1 = x0 + 1;
    const L = 52, R = 14, T = 8, B = this.xlabel ? 40 : 26;
    const px = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
    const py = (y) => T + (1 - (tf(y) - y0) / (y1 - y0)) * (H - T - B);
    g.font = '11px system-ui'; g.textBaseline = 'middle';
    // grid + y ticks
    const yt = this.logY ? ticks(Math.floor(y0), Math.ceil(y1), 5).filter((v) => Number.isInteger(v)) : ticks(y0, y1, 5);
    g.strokeStyle = grid; g.lineWidth = 1; g.fillStyle = muted; g.textAlign = 'right';
    for (const v of yt) {
      const yy = T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
      if (yy < T - 1 || yy > H - B + 1) continue;
      g.beginPath(); g.moveTo(L, yy + 0.5); g.lineTo(W - R, yy + 0.5); g.stroke();
      g.fillText(this.logY ? (Math.abs(v) <= 3 ? fmt(Math.pow(10, v)) : '1e' + v) : fmt(v), L - 6, yy);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of ticks(x0, x1, Math.max(3, Math.floor((W - L) / 80)))) { const xx = Math.min(Math.max(px(v), L + 10), W - R - 10); g.fillText(fmt(v), xx, H - B + 5); }
    g.fillStyle = text2;
    if (this.xlabel) { g.textAlign = 'center'; g.fillText(this.xlabel, L + (W - L - R) / 2, H - 15); }
    if (this.ylabel) { g.save(); g.translate(11, T + (H - T - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(this.ylabel, 0, 0); g.restore(); }
    // greyed x-ranges
    for (const sh of this.shade) {
      const a = Math.max(L, px(Math.max(sh.x0, x0))), b = Math.min(W - R, px(Math.min(sh.x1, x1)));
      if (!(b - a > 0.5)) continue;
      g.fillStyle = muted; g.globalAlpha = 0.12; g.fillRect(a, T, b - a, H - T - B); g.globalAlpha = 1;
      if (sh.label && b - a > g.measureText(sh.label).width + 6) { g.fillStyle = muted; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(sh.label, (a + b) / 2, H - B - 3); }
    }
    // stage markers
    g.save();
    let lastLabelEnd = -Infinity;
    for (const m of this.markers) {
      if (m.x < x0 || m.x > x1) continue;
      const xx = Math.round(px(m.x)) + 0.5;
      g.strokeStyle = grid; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, H - B); g.stroke();
      g.setLineDash([]);
      const w = g.measureText(m.label).width;
      if (xx + 3 > lastLabelEnd + 6 && xx + 3 + w < W - R) { g.fillStyle = muted; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(m.label, xx + 3, T + 1); lastLabelEnd = xx + 3 + w; }
    }
    g.restore();
    // bands then lines (clipped to the plot area)
    g.save(); g.beginPath(); g.rect(L, T - 1, W - L - R, H - T - B + 2); g.clip();
    for (const s of ser) {
      if (!s.band) continue;
      g.beginPath();
      for (let i = 0; i < s.x.length; i++) g.lineTo(px(s.x[i]), py(s.band.hi[i]));
      for (let i = s.x.length - 1; i >= 0; i--) g.lineTo(px(s.x[i]), py(s.band.lo[i]));
      g.closePath(); g.globalAlpha = 0.18; g.fillStyle = s.color; g.fill(); g.globalAlpha = 1;
    }
    for (const s of ser) {
      g.beginPath(); g.strokeStyle = s.color; g.lineWidth = 2; g.lineJoin = 'round';
      g.setLineDash(s.dash ? [5, 4] : []);
      let pen = false;
      for (let i = 0; i < s.x.length; i++) {
        const y = s.y[i];
        if (!isFinite(y) || (this.logY && y <= 0)) { pen = false; continue; }
        if (!pen) { g.moveTo(px(s.x[i]), py(y)); pen = true; } else g.lineTo(px(s.x[i]), py(y));
      }
      g.stroke(); g.setLineDash([]);
      if (s.points) for (let i = 0; i < s.x.length; i++) { g.beginPath(); g.arc(px(s.x[i]), py(s.y[i]), 4, 0, 7); g.fillStyle = s.color; g.fill(); g.lineWidth = 2; g.strokeStyle = css('--surface-1'); g.stroke(); }
    }
    g.restore();
    if (peak && peak.y > this.yMax) {
      const xx = px(peak.x), txt = `\u2191 off scale: ${fmt(peak.y)}${this.ylabel ? ' ' + this.ylabel : ''} at ${this.xfmt(peak.x)}`;
      g.font = '11px system-ui'; g.fillStyle = text2; g.textBaseline = 'top';
      const w = g.measureText(txt).width;
      g.textAlign = 'left'; g.fillText(txt, Math.max(L + 4, Math.min(xx - w - 6, W - R - w - 4)), T + 14);
    }
    if (this.cursorX !== null && this.cursorX >= x0 && this.cursorX <= x1) {
      g.strokeStyle = text2; g.lineWidth = 1; g.beginPath(); g.moveTo(px(this.cursorX) + 0.5, T); g.lineTo(px(this.cursorX) + 0.5, H - B); g.stroke();
    }
    // hover crosshair + tooltip
    if (this.hoverX !== null && this.hoverX >= L && this.hoverX <= W - R) {
      const xv = x0 + ((this.hoverX - L) / (W - L - R)) * (x1 - x0);
      g.strokeStyle = muted; g.beginPath(); g.moveTo(this.hoverX + 0.5, T); g.lineTo(this.hoverX + 0.5, H - B); g.stroke();
      const rows = [];
      for (const s of ser) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < s.x.length; i++) { const d = Math.abs(s.x[i] - xv); if (d < bd) { bd = d; bi = i; } }
        const y = s.y[bi];
        if (isFinite(y)) { g.beginPath(); g.arc(px(s.x[bi]), py(y), 4, 0, 7); g.fillStyle = s.color; g.fill(); }
        rows.push(`<div><i style="background:${s.color}"></i>${s.name}: <b>${fmt(y)}</b>${s.band ? ` <span class="muted">(${fmt(s.band.lo[bi])}–${fmt(s.band.hi[bi])})</span>` : ''}</div>`);
      }
      this.tip.innerHTML = `<div class="muted">${this.xlabel || 'x'} = ${fmt(xv)}</div>${rows.join('')}`;
      this.tip.style.display = 'block';
      const tw = this.tip.offsetWidth;
      this.tip.style.left = Math.min(W - tw - 4, this.hoverX + 12) + 'px';
      this.tip.style.top = '32px';
    }
  }
}
