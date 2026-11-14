// Unwrapped surface map: axial position (x) vs circumferential angle / width (y).

import { colorAt, fmt } from './colormap.js';

export class Heatmap {
  constructor(container) {
    this.el = container;
    this.el.classList.add('heatmap');
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div'); this.tip.className = 'chart-tip';
    this.el.append(this.canvas, this.tip);
    this.img = document.createElement('canvas');
    this.canvas.addEventListener('mousemove', (e) => this.hover(e));
    this.canvas.addEventListener('mouseleave', () => { this.tip.style.display = 'none'; });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  set(geo, values, range, cmap, unit, overlays = []) {
    Object.assign(this, { geo, values, range, cmap, unit, overlays });
    const { Ni, Nj } = geo;
    this.img.width = Ni; this.img.height = Nj;
    const g = this.img.getContext('2d');
    const id = g.createImageData(Ni, Nj);
    const [lo, hi] = range;
    for (let i = 0; i < Ni; i++) for (let j = 0; j < Nj; j++) {
      const v = values[i * Nj + j];
      const cut = geo.voidMask && geo.voidMask[i * Nj + j];
      const [r, gg, b] = cut ? [21, 24, 29] : colorAt(cmap, (v - lo) / (hi - lo));
      const p = 4 * ((Nj - 1 - j) * Ni + i);
      id.data[p] = r; id.data[p + 1] = gg; id.data[p + 2] = b; id.data[p + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    this.draw();
  }

  layout() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    return { W, H, L: 56, R: 16, T: 12, B: 34 };
  }

  draw() {
    if (!this.geo) return;
    const { W, H, L, R, T, B } = this.layout();
    if (W < 20 || H < 20) return;
    const dpr = window.devicePixelRatio || 1, cv = this.canvas;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.img, L, T, W - L - R, H - T - B);
    const st = getComputedStyle(document.documentElement);
    g.fillStyle = st.getPropertyValue('--text-muted'); g.font = '11px system-ui';
    const Lmm = this.geo.L * 1e3;
    g.textAlign = 'center'; g.textBaseline = 'top';
    const nt = Math.max(2, Math.floor((W - L) / 90));
    for (let q = 0; q <= nt; q++) { const v = (q / nt) * Lmm; g.fillText(fmt(v), L + (q / nt) * (W - L - R), H - B + 6); }
    g.fillStyle = st.getPropertyValue('--text-secondary');
    g.textAlign = 'right'; g.fillText('axial position s (mm)', W - R, H - 14);
    g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = st.getPropertyValue('--text-muted');
    if (this.geo.flat) {
      g.fillText('edge', L - 6, H - B - 4); g.fillText('edge', L - 6, T + 4);
    } else {
      for (const d of [0, 90, 180, 270, 360]) g.fillText(d + '°', L - 6, T + (1 - d / 360) * (H - T - B));
      g.save(); g.translate(12, T + (H - T - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('angle φ (270° = bottom when horizontal)', 0, 0); g.restore();
    }
    for (const o of this.overlays) {
      if (o.s === null || o.s === undefined || !isFinite(o.s)) continue;
      const x = L + (o.s / this.geo.L) * (W - L - R);
      g.strokeStyle = o.color; g.lineWidth = 2; g.setLineDash([5, 3]);
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, H - B); g.stroke(); g.setLineDash([]);
      g.fillStyle = o.color; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(o.label, x + 4, T + 2);
    }
  }

  hover(e) {
    if (!this.geo) return;
    const { W, H, L, R, T, B } = this.layout();
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < L || x > W - R || y < T || y > H - B) { this.tip.style.display = 'none'; return; }
    const i = Math.min(this.geo.Ni - 1, Math.floor(((x - L) / (W - L - R)) * this.geo.Ni));
    const j = Math.min(this.geo.Nj - 1, Math.floor((1 - (y - T) / (H - T - B)) * this.geo.Nj));
    const v = this.values[i * this.geo.Nj + j];
    const ang = this.geo.flat ? '' : `, φ ${((this.geo.phi[j] * 180) / Math.PI).toFixed(0)}°`;
    this.tip.innerHTML = `<div class="muted">s ${(this.geo.s[i] * 1e3).toFixed(2)} mm${ang}</div><div><b>${fmt(v)}</b> ${this.unit}</div>`;
    this.tip.style.display = 'block';
    this.tip.style.left = Math.min(W - this.tip.offsetWidth - 4, x + 12) + 'px';
    this.tip.style.top = Math.max(0, y - 40) + 'px';
  }
}
