// Minimal WebGL viewer: part surface coloured by a field, optional film exaggeration,
// cutaway for lumen surfaces, ghost wall, and process markers (bath level, nozzle,
// meniscus) drawn as rings.

import { colorAt } from './colormap.js';
import { coatingMesh, coatPoint } from '../core/drawn.js';

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec3 aCol; attribute float aCut; attribute float aGloss;
uniform mat4 uMVP; uniform mat4 uModel; varying vec3 vN; varying vec3 vC; varying float vCut; varying vec3 vW; varying float vG; varying float vS;
void main(){ vec4 w = uModel*vec4(aPos,1.0); vW=w.xyz; vS=aPos.z; gl_Position=uMVP*w; vN=mat3(uModel)*aNrm; vC=aCol; vCut=aCut; vG=aGloss; gl_PointSize=3.0; }`;
const FS = `
precision highp float; varying vec3 vN; varying vec3 vC; varying float vCut; varying vec3 vW; varying float vG; varying float vS;
uniform float uCut; uniform float uAlpha; uniform vec3 uEye; uniform float uFlat; uniform float uSec;
void main(){
  if (uCut > 0.5 && vCut > 1e-7) discard;
  if (uFlat < 0.5 && vS < uSec) discard; // section slice: everything above it is hidden
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uEye - vW);
  vec3 l1 = normalize(vec3(0.4,0.9,0.6)); vec3 l2 = v;
  float d = 0.55 + 0.35*max(dot(n,l1),0.0) + 0.35*max(dot(n,l2),0.0);
  vec3 h = normalize(l1+v); float sp = pow(max(dot(n,h),0.0),40.0+60.0*vG)*(0.18+0.9*vG);
  vec3 c = uFlat > 0.5 ? vC : vC*d + sp;
  gl_FragColor = vec4(c, uAlpha);
}`;

function mat4() { return new Float32Array(16); }
function mul(a, b) { const o = mat4(); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; }
function perspective(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2), o = mat4(); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = (2 * f * n) / (n - f); return o; }
function lookAt(e, c, u) {
  const z = norm([e[0] - c[0], e[1] - c[1], e[2] - c[2]]), x = norm(cross(u, z)), y = cross(z, x), o = mat4();
  o[0] = x[0]; o[4] = x[1]; o[8] = x[2]; o[1] = y[0]; o[5] = y[1]; o[9] = y[2]; o[2] = z[0]; o[6] = z[1]; o[10] = z[2];
  o[12] = -dot(x, e); o[13] = -dot(y, e); o[14] = -dot(z, e); o[15] = 1; return o;
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class View3D {
  constructor(container) {
    this.el = container;
    this.canvas = document.createElement('canvas');
    this.el.append(this.canvas);
    const gl = this.canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
    this.gl = gl;
    if (!gl) { this.el.insertAdjacentHTML('beforeend', '<div class="empty">WebGL is not available in this browser.</div>'); return; }
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    this.prog = p;
    this.loc = {};
    for (const a of ['aPos', 'aNrm', 'aCol', 'aCut', 'aGloss']) this.loc[a] = gl.getAttribLocation(p, a);
    for (const u of ['uMVP', 'uModel', 'uCut', 'uAlpha', 'uEye', 'uFlat', 'uSec']) this.loc[u] = gl.getUniformLocation(p, u);
    this.buf = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), cut: gl.createBuffer(), idx: gl.createBuffer(), gloss: gl.createBuffer(),
      gpos: gl.createBuffer(), gnrm: gl.createBuffer(), gcol: gl.createBuffer(), gcut: gl.createBuffer(),
      cpos: gl.createBuffer(), cnrm: gl.createBuffer(), ccol: gl.createBuffer(), ccut: gl.createBuffer(), cgloss: gl.createBuffer(),
      kpos: gl.createBuffer(), knrm: gl.createBuffer(), kcol: gl.createBuffer(), kgloss: gl.createBuffer(),
      ppos: gl.createBuffer(), pnrm: gl.createBuffer(), pcol: gl.createBuffer(), pcut: gl.createBuffer(), pgloss: gl.createBuffer(),
      lpos: gl.createBuffer(), lcol: gl.createBuffer() };
    this.yaw = -0.5; this.pitch = 0.5; this.dist = 2.6; this.tgt = [0, 0, 0];
    this.cutaway = true; this.exag = 0; this.secZ = null; this.tilt = 90; this.radialMode = 'auto'; this.radial = 1;
    // Fusion 360-style navigation: middle-drag pans, Shift + middle-drag orbits, the wheel
    // zooms about the cursor, double-click middle fits. Left-drag orbit / right-drag pan stay
    // as fallbacks for trackpads.
    let drag = null;
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, b: e.button };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = this._dragMode(e) === 'pan' ? 'grabbing' : 'move';
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (this._dragMode({ button: drag.b, shiftKey: e.shiftKey }) === 'pan') this.panBy(dx, dy);
      else { this.yaw -= dx * 0.008; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.008)); }
      this.render();
    });
    const end = () => { drag = null; this.canvas.style.cursor = ''; };
    this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoomAt(Math.exp(e.deltaY * 0.0012), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    }, { passive: false });
    let lastMid = 0;
    this.canvas.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const now = performance.now(); if (now - lastMid < 400) this.fitView(); lastMid = now;
    });
    this.canvas.addEventListener('dblclick', () => this.fitView());
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('keydown', (e) => {
      if (e.key === 'F6' || e.key === 'f') { e.preventDefault(); this.fitView(); }
      else if (e.key === 'Home' || e.key === 'h') { e.preventDefault(); this.resetView(); }
      else if (e.key === 't') { e.preventDefault(); this.tipView(); }
    });
    this.canvas.addEventListener('pointerenter', () => this.canvas.focus({ preventScroll: true }));
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  resetView() { this.autoCamera(true); this.render(); }
  // Close-up of the tip, side-on to the bevel
  tipView() {
    const geo = this.geo; if (!geo) return;
    this.autoCamera(true);
    const bv = geo.bevel, R = this.radial, rT = Math.max(geo.A[geo.Ni - 1], geo.B[geo.Ni - 1] || 0);
    const cutLen = bv && bv.deg > 0 ? 2 * bv.qmax * Math.tan((bv.deg * Math.PI) / 180) : 0;
    const zc = geo.L - 0.5 * cutLen - 1.5 * rT, Mm = this.modelMatrix();
    this.tgt = [Mm[8] * zc + Mm[12], Mm[9] * zc + Mm[13], Mm[10] * zc + Mm[14]];
    // exactly side-on: the bevel plane is seen edge-on, so the cut is a straight line at its true angle
    const n = this.cutN || [0, 1]; this.yaw = Math.atan2(n[1], n[0]); this.pitch = 0;
    this.dist = Math.max(0.05, ((3 * cutLen + 8 * rT * R) * this.scale) / 0.78);
    this.render();
  }
  fitView() { const y = this.yaw, p = this.pitch; this.autoCamera(true); this.yaw = y; this.pitch = p; this.render(); }
  _dragMode(e) { return (e.button === 1 && !e.shiftKey) || e.button === 2 ? 'pan' : 'orbit'; }
  _basis() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const back = [cp * sy, sp, cp * cy], right = [cy, 0, -sy];
    const up = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2], back[0] * right[1] - back[1] * right[0]];
    return { back, right, up };
  }
  _worldPerPx() { return (2 * this.dist * Math.tan(0.375)) / Math.max(1, this.el.clientHeight); }
  // grab-style pan: the part follows the cursor
  panBy(dx, dy) {
    const { right, up } = this._basis(), k = this._worldPerPx();
    for (let c = 0; c < 3; c++) this.tgt[c] += (-dx * right[c] + dy * up[c]) * k;
  }
  // World point of the visible surface under the cursor (mx, my = pixels from the view
  // centre), or null. CPU pick over the render vertices: nearest-in-depth within a few px.
  pickAt(mx, my) {
    if (!this._mvp || !this._posW) return null;
    const W = this.el.clientWidth, H = this.el.clientHeight, M = this._mvp, P = this._posW, C = this._cutV;
    let best = null, bestZ = Infinity, bestD = 14 * 14;
    for (let v = 0, n = P.length / 3; v < n; v++) {
      if (this.cutaway && C && C[v]) continue;
      const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
      const w = M[3] * x + M[7] * y + M[11] * z + M[15]; if (w <= 1e-6) continue;
      const sx = ((M[0] * x + M[4] * y + M[8] * z + M[12]) / w) * W / 2, sy = -((M[1] * x + M[5] * y + M[9] * z + M[13]) / w) * H / 2;
      const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d2 > bestD) continue;
      const zz = (M[2] * x + M[6] * y + M[10] * z + M[14]) / w;
      if (d2 < 9 ? zz < bestZ : !best) { best = [x, y, z]; bestZ = zz; if (d2 >= 9) bestD = d2; }
    }
    return best;
  }
  // Zoom about the point under the cursor: the surface point if there is one (so the pivot
  // lands on the part, as in Fusion 360), otherwise the point at the current target depth.
  zoomAt(f, mx, my) {
    const d0 = this.dist, d1 = Math.max(0.01, Math.min(20, d0 * f)), r = d1 / d0;
    const { back, right, up } = this._basis(), k = this._worldPerPx();
    let p = this.pickAt(mx, my);
    if (!p) p = [0, 1, 2].map((c) => this.tgt[c] + k * (mx * right[c] - my * up[c]));
    // the camera moves along the ray through p; the new target is where that view axis
    // meets the plane through p, so later orbits pivot on the part
    const eye = [0, 1, 2].map((c) => this.tgt[c] + back[c] * d0);
    const eye2 = [0, 1, 2].map((c) => p[c] + (eye[c] - p[c]) * r);
    const depth = [0, 1, 2].reduce((acc, c) => acc + (eye2[c] - p[c]) * back[c], 0);
    this.tgt = [0, 1, 2].map((c) => eye2[c] - back[c] * depth);
    this.dist = Math.max(0.01, depth);
    this.render();
  }

  // Default camera: look into the cut-open half (body +y side is removed by the cutaway).
  autoCamera(force) {
    if (!force && this._camTilt === this.tilt) return;
    this._camTilt = this.tilt;
    const vertical = this.tilt < 45 || this.tilt > 135;
    const n = this.cutN || [0, 1];
    if (vertical) { this.yaw = Math.atan2(n[1], n[0]) - 0.52; this.pitch = 0.3; this.dist = 3.4; } else { this.yaw = -0.5; this.pitch = 0.55; this.dist = 2.7; }
    this.tgt = [0, 0, 0];
  }

  // geo: serialised geometry; ghost: wall radius offset for the context shell
  // The render mesh is finer than the simulation grid (coatingMesh in core/drawn.js): the
  // cross-section is drawn from the exact ellipse with SUB vertices per cell around the
  // circumference, values are blended between cell centres, rows sit at the cell centres plus
  // one at each true end of the part, and at a bevelled tip the vertices sit on the cut plane
  // (smooth slanted edge instead of stepped cells). The same mesh gives the drawn volume.
  setGeometry(geo) {
    this.geo = geo;
    const M0 = coatingMesh(geo, null, null);
    const { rows, cols, SUB } = M0;
    this.SUB = SUB; this.cols = cols; this.rows = rows; this.cutS = M0.cutS; this.lastRow = M0.lastRow; this.rowZ = M0.rowZ; this.rowI = M0.rowI;
    this.M0 = M0;
    const idx = [];
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    this.nIdx = idx.length;
    // Cut-open plane: normally the body +y half is removed. A bevelled bore is instead sliced
    // along the bevel's own plane (the half perpendicular to the bevel direction is removed),
    // so the whole slanted cut, long side to short side, shows in profile.
    const bvl = geo.bevel && geo.bevel.deg > 0 && geo.surface === 'inner';
    if (bvl) { const cb = (geo.bevel.clockDeg * Math.PI) / 180; this.cutN = [-Math.sin(cb), Math.cos(cb)]; } else this.cutN = [0, 1];
    const gl = this.gl; if (!gl) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    gl.getExtension('OES_element_index_uint');
    let rmax = 0;
    for (let i = 0; i < geo.Ni; i++) rmax = Math.max(rmax, geo.A[i], geo.B[i] || 0);
    this.radial = this.radialMode === 'auto' && !geo.flat ? Math.max(1, geo.L / 10 / (2 * rmax)) : 1;
    this.scale = 2.2 / Math.max(geo.L, 2 * rmax * this.radial * 1.2);
    this._camTilt = undefined;
    this.rmax = rmax;
    this.hasGhost = geo.surface === 'inner';
    if (this.hasGhost) {
      const n = rows * cols, gp = new Float32Array(3 * n), gn = new Float32Array(3 * n), gc = new Float32Array(3 * n), gcut = new Float32Array(n);
      const wall = Math.max(0.15 * rmax, 0.2e-3), R = this.radial, W = M0.wall, Nn = M0.nrm;
      this.wallT = wall;
      for (let v = 0; v < n; v++) {
        const nx = Nn[2 * v], ny = Nn[2 * v + 1];
        gp[3 * v] = (W[3 * v] - nx * wall) * R; gp[3 * v + 1] = (W[3 * v + 1] - ny * wall) * R; gp[3 * v + 2] = W[3 * v + 2];
        gn[3 * v] = -nx; gn[3 * v + 1] = -ny; gn[3 * v + 2] = 0;
        gc[3 * v] = 0.55; gc[3 * v + 1] = 0.6; gc[3 * v + 2] = 0.68;
        gcut[v] = gp[3 * v] * this.cutN[0] + gp[3 * v + 1] * this.cutN[1]; // signed distance to the cut plane
      }
      this.upload('gpos', gp); this.upload('gnrm', gn); this.upload('gcol', gc); this.upload('gcut', gcut);
    }
  }

  upload(name, arr) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[name]); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW); }

  // opts: {values, range, cmap, film (m), markers, bare (Uint8), rgb (Float32 3/cell, overrides cmap), gloss (0..1/cell)}
  // The wall is drawn in grey at its true position and the coating as a second surface
  // standing off it by the film thickness × this.exag (1 = true scale). Flooded cells (`fill`)
  // fill the bore to the axis. Where a bore is cut open, caps on the cut plane show the coating
  // thickness (coloured band) and the wall (grey band).
  // bodies: liquid bodies drawn as their own meshes (tipPoolBody: the meniscus-shaped pool at
  // the tip; heldBody: liquid filling the bore between curved menisci during fill and plugs).
  setField(values, range, cmap, film, markers = [], bare = null, rgbOverride = null, glossField = null, fill = null, bodies = null) {
    const geo = this.geo; if (!geo || !this.gl) return;
    const { Nj } = geo, cols = this.cols, rows = this.rows, n = rows * cols, R = this.radial;
    const inner = geo.surface === 'inner' && !geo.flat;
    const pos = new Float32Array(3 * n), nrm = new Float32Array(3 * n), col = new Float32Array(3 * n), cut = new Float32Array(n);
    const cpos = new Float32Array(3 * n), ccol = new Float32Array(3 * n), ccut = new Float32Array(n), cgl = new Float32Array(n);
    const [lo, hi] = range;
    const ex = this.exag || 0;
    const N = geo.N, cc = new Float32Array(3 * N), cg = new Float32Array(N), cd = new Float32Array(N), cf = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      if (bare && bare[k]) { cc[3 * k] = 0.50; cc[3 * k + 1] = 0.52; cc[3 * k + 2] = 0.56; }
      else if (rgbOverride) { cc[3 * k] = rgbOverride[3 * k]; cc[3 * k + 1] = rgbOverride[3 * k + 1]; cc[3 * k + 2] = rgbOverride[3 * k + 2]; }
      else { const rgb = colorAt(cmap, 0.2 + 0.8 * Math.max(0, Math.min(1, (values[k] - lo) / (hi - lo)))); cc[3 * k] = rgb[0] / 255; cc[3 * k + 1] = rgb[1] / 255; cc[3 * k + 2] = rgb[2] / 255; }
      cg[k] = glossField && !(bare && bare[k]) ? glossField[k] : 0;
      cd[k] = film && !(bare && bare[k]) ? film[k] * ex : 0;
      cf[k] = fill && fill[k] ? 1 : 0;
    }
    const M = coatingMesh(geo, cd, cf);
    const WALL = [0.60, 0.62, 0.66];
    for (let v = 0; v < n; v++) {
      const k1 = M.blend[2 * v], k2 = M.blend[2 * v + 1], f = M.bf[v];
      pos[3 * v] = M.wall[3 * v] * R; pos[3 * v + 1] = M.wall[3 * v + 1] * R; pos[3 * v + 2] = M.wall[3 * v + 2];
      nrm[3 * v] = M.nrm[2 * v]; nrm[3 * v + 1] = M.nrm[2 * v + 1]; nrm[3 * v + 2] = 0;
      for (let c = 0; c < 3; c++) col[3 * v + c] = WALL[c];
      cut[v] = inner ? pos[3 * v] * this.cutN[0] + pos[3 * v + 1] * this.cutN[1] : -1;
      cpos[3 * v] = M.coat[3 * v] * R; cpos[3 * v + 1] = M.coat[3 * v + 1] * R; cpos[3 * v + 2] = M.coat[3 * v + 2];
      for (let c = 0; c < 3; c++) ccol[3 * v + c] = cc[3 * k1 + c] * (1 - f) + cc[3 * k2 + c] * f;
      cgl[v] = cg[k1] * (1 - f) + cg[k2] * f;
      ccut[v] = inner ? cpos[3 * v] * this.cutN[0] + cpos[3 * v + 1] * this.cutN[1] : -1;
    }
    const blendAt = (i, jf) => {
      const j = Math.floor(jf) % Nj, f = jf - Math.floor(jf), j2 = (j + 1) % Nj;
      const k1 = Math.min(i, this.lastRow[j]) * Nj + j, k2 = Math.min(i, this.lastRow[j2]) * Nj + j2;
      return { k1, k2, f };
    };
    // caps on the cut plane: two generator lines where the plane meets the bore
    const kp = [], kn = [], kc = [], kg = [];
    if (inner && this.cutaway) {
      const [n0, n1] = this.cutN, p0 = -n1, p1 = n0, wall = this.wallT || 0, SUB = this.SUB;
      for (const sgn of [1, -1]) {
        let prev = null;
        for (let r = 0; r < rows; r++) {
          const i = this.rowI[r], a = geo.A[i], b = geo.B[i];
          const ph = Math.atan2((sgn * p1) / b, (sgn * p0) / a);
          const x = a * Math.cos(ph), y = b * Math.sin(ph);
          let nx = b * Math.cos(ph), ny = a * Math.sin(ph); const nl = Math.hypot(nx, ny) || 1; nx = -nx / nl; ny = -ny / nl; // into the bore
          const jf = ((((ph - geo.phi[0]) / (2 * Math.PI)) * Nj) % Nj + Nj) % Nj;
          const { k1, k2, f } = blendAt(i, jf);
          const d = cd[k1] * (1 - f) + cd[k2] * f, fl = cf[k1] * (1 - f) + cf[k2] * f;
          const u = jf * SUB, u0 = Math.floor(u) % cols, u1 = Math.min(cols - 1, u0 + 1), fu = u - Math.floor(u);
          const z = Math.min(this.rowZ[r], this.cutS[u0] * (1 - fu) + this.cutS[u1] * fu);
          const C = coatPoint(x, y, nx, ny, d, fl, true);
          const rgb = [0, 1, 2].map((c) => cc[3 * k1 + c] * (1 - f) + cc[3 * k2 + c] * f);
          const gl = cg[k1] * (1 - f) + cg[k2] * f;
          const row = { W: [x * R, y * R, z], C: [C[0] * R, C[1] * R, z], G: [(x - nx * wall) * R, (y - ny * wall) * R, z], rgb, gl, thick: d > 0 || fl > 0.5 };
          if (prev) {
            const quad = (A, B, Cq, D, rgbA, rgbB, gA, gB) => { // A,B on row i-1; Cq,D on row i
              for (const [Pq, rq, gq] of [[A, rgbA, gA], [B, rgbA, gA], [Cq, rgbB, gB], [B, rgbA, gA], [D, rgbB, gB], [Cq, rgbB, gB]]) { kp.push(...Pq); kn.push(n0, n1, 0); kc.push(...rq); kg.push(gq); }
            };
            if (prev.thick || row.thick) quad(prev.W, prev.C, row.W, row.C, prev.rgb, row.rgb, prev.gl, row.gl);
            quad(prev.G, prev.W, row.G, row.W, [0.42, 0.45, 0.5], [0.42, 0.45, 0.5], 0, 0);
          }
          prev = row;
        }
      }
    }
    // section slice: ring caps at secZ (coating band coloured, wall band grey)
    if (this.secZ != null && !geo.flat) {
      const z = this.secZ, rz = this.rowZ; let i = 0; while (i < rows - 2 && rz[i + 1] < z) i++;
      const t = Math.max(0, Math.min(1, (z - rz[i]) / Math.max(rz[i + 1] - rz[i], 1e-12)));
      const wall = this.wallT || 0;
      const at = (u) => { // interpolated wall / coating / outer points and colour at render column u
        const a = i * cols + u, b2 = (i + 1) * cols + u, L3 = (arr, v, c) => arr[3 * v + c];
        const W = [0, 1].map((c) => L3(pos, a, c) * (1 - t) + L3(pos, b2, c) * t);
        const C = [0, 1].map((c) => L3(cpos, a, c) * (1 - t) + L3(cpos, b2, c) * t);
        const nx = L3(nrm, a, 0), ny = L3(nrm, a, 1);
        const out = inner ? [W[0] - nx * wall * R, W[1] - ny * wall * R] : W;
        const rgb = [0, 1, 2].map((c) => L3(ccol, a, c) * (1 - t) + L3(ccol, b2, c) * t);
        const zc = Math.min(z, this.cutS[u]);
        return { W: [W[0], W[1], zc], C: [C[0], C[1], zc], O: [out[0], out[1], zc], rgb, gl: cgl[a] * (1 - t) + cgl[b2] * t, cut: inner && this.cutaway && W[0] * this.cutN[0] + W[1] * this.cutN[1] > 1e-9, gone: z > this.cutS[u] };
      };
      const tri = (A, B, Cq, rgb, g) => { for (const Pq of [A, B, Cq]) { kp.push(...Pq); kn.push(0, 0, -1); kc.push(...rgb); kg.push(g); } };
      for (let u = 0; u < cols - 1; u++) {
        const p = at(u), q = at(u + 1);
        if ((p.cut && q.cut) || p.gone || q.gone) continue;
        tri(p.W, p.C, q.W, p.rgb, p.gl); tri(p.C, q.C, q.W, q.rgb, q.gl); // coating ring
        if (inner) { const G = [0.42, 0.45, 0.5]; tri(p.O, p.W, q.O, G, 0); tri(p.W, q.W, q.O, G, 0); } // wall ring
      }
    }
    this.nCap = kp.length / 3;
    this.buildBodies(bodies, cc, cg);
    {
      const Mm = this.modelMatrix(), pw = new Float32Array(pos.length);
      for (let v = 0; v < pos.length; v += 3) for (let c = 0; c < 3; c++) pw[v + c] = Mm[c] * cpos[v] + Mm[4 + c] * cpos[v + 1] + Mm[8 + c] * cpos[v + 2] + Mm[12 + c];
      this._posW = pw; this._cutV = ccut.map((x) => (x > 0 ? 1 : 0));
    }
    this.upload('pos', pos); this.upload('nrm', nrm); this.upload('col', col); this.upload('cut', cut); this.upload('gloss', new Float32Array(n));
    this.upload('cpos', cpos); this.upload('cnrm', nrm); this.upload('ccol', ccol); this.upload('ccut', ccut); this.upload('cgloss', cgl);
    if (this.nCap) { this.upload('kpos', new Float32Array(kp)); this.upload('knrm', new Float32Array(kn)); this.upload('kcol', new Float32Array(kc)); this.upload('kgloss', new Float32Array(kg)); }
    this.markers = markers;
    this.render();
  }

  // Meshes for liquid bodies in the bore (tipPoolBody / heldBody in core): an upper free surface
  // zTop(ρ², u) and a lower one zBot(ρ², u) (a meniscus, or the opening in the bevel plane),
  // plus their section on the cut-open plane. Built in the unit disc of the local ellipse, so
  // the drawn body has the computed volume (the radius magnifier scales x and y only).
  buildBodies(bodies, cc, cg) {
    this.nPool = 0; this.poolInfo = null;
    const geo = this.geo;
    const list = (Array.isArray(bodies) ? bodies : [bodies]).filter(Boolean);
    if (!list.length || !geo || geo.flat || geo.surface !== 'inner') return;
    const { Ni, ds, A, B, L } = geo, R = this.radial, [n0, n1] = this.cutN;
    const tp = [], tn = [], tc = [], tg = [], tcut = [];
    for (const body of list) {
      let rgb = body.rgb, gloss = body.gloss ?? 1;
      if (!rgb && body.inBody) { // mean colour of the cells the body covers
        rgb = [0, 0, 0]; let c = 0; gloss = 0;
        for (let k = 0; k < body.inBody.length; k++) if (body.inBody[k]) { for (let q = 0; q < 3; q++) rgb[q] += cc[3 * k + q]; gloss += cg[k]; c++; }
        if (!c) continue; rgb = rgb.map((x) => x / c); gloss /= c;
      }
      if (!rgb) rgb = [0.08, 0.30, 0.80];
      const zBot = body.zBot || ((r2, u) => body.sBottom(u));
      const P = (u, v, s) => { const i = Math.max(0, Math.min(Ni - 1, Math.floor(s / ds))), X = u * body.dX - v * body.dY, Y = u * body.dY + v * body.dX; return [A[i] * X * R, B[i] * Y * R, Math.min(L, s)]; };
      const n0v = tp.length / 3;
      const NR = 20, NM = 72;
      for (const face of ['top', 'bottom']) {
        const G = [];
        for (let k = 0; k <= NR; k++) {
          const row = [], rho = k / NR, r2 = rho * rho;
          for (let m = 0; m <= NM; m++) {
            const ps = (2 * Math.PI * m) / NM, u = rho * Math.cos(ps), v = rho * Math.sin(ps), sb = zBot(r2, u);
            row.push(P(u, v, face === 'top' ? Math.min(body.zTop(r2, u), sb) : sb));
          }
          G.push(row);
        }
        const Nn = G.map((row, k) => row.map((p, m) => {
          const kk = Math.max(1, k), a = G[Math.min(NR, kk + 1)][m], b = G[kk - 1][m], c = G[kk][(m + 1) % NM], d = G[kk][(m + NM - 1) % NM];
          const t1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], t2 = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
          return norm(cross(t1, t2));
        }));
        for (let k = 0; k < NR; k++) for (let m = 0; m < NM; m++) {
          for (const [kk, mm] of [[k, m], [k + 1, m], [k + 1, m + 1], [k, m], [k + 1, m + 1], [k, m + 1]]) { tp.push(...G[kk][mm]); tn.push(...Nn[kk][mm]); }
        }
      }
      const nSurf = tp.length / 3;
      // section of the body on the cut-open plane (only when cut open)
      if (this.cutaway) {
        const aT = A[Ni - 1], bT = B[Ni - 1], cb = body.cb;
        let eX = Math.cos(cb) / aT, eY = Math.sin(cb) / bT; const el = Math.hypot(eX, eY) || 1; eX /= el; eY /= el;
        const NT = 64, NZ = 12, colm = [];
        for (let q = 0; q <= NT; q++) {
          const tt = -1 + (2 * q) / NT, X = tt * eX, Y = tt * eY, u = X * body.dX + Y * body.dY, v = -X * body.dY + Y * body.dX, r2 = tt * tt, sb = zBot(r2, u), z = Math.min(body.zTop(r2, u), sb);
          const c = []; for (let r = 0; r <= NZ; r++) c.push(P(u, v, z + ((sb - z) * r) / NZ)); colm.push(c);
        }
        for (let q = 0; q < NT; q++) for (let r = 0; r < NZ; r++) {
          for (const [qq, rr] of [[q, r], [q + 1, r], [q + 1, r + 1], [q, r], [q + 1, r + 1], [q, r + 1]]) { tp.push(...colm[qq][rr]); tn.push(n0, n1, 0); }
        }
      }
      for (let v = n0v; v < tp.length / 3; v++) {
        tc.push(rgb[0], rgb[1], rgb[2]); tg.push(gloss);
        tcut.push(v < nSurf ? tp[3 * v] * n0 + tp[3 * v + 1] * n1 : -1); // the plane section itself is never cut
      }
    }
    const n = tp.length / 3; if (!n) return;
    this.upload('ppos', new Float32Array(tp)); this.upload('pnrm', new Float32Array(tn)); this.upload('pcol', new Float32Array(tc)); this.upload('pcut', new Float32Array(tcut)); this.upload('pgloss', new Float32Array(tg));
    this.nPool = n;
    const pool = list.find((b) => b.Vpool !== undefined), held = list.find((b) => b.Vheld !== undefined);
    this.poolInfo = { V: pool ? pool.V : 0, Vpool: pool ? pool.Vpool : 0, Vfilm: pool ? pool.Vfilm : 0, height: pool ? pool.height : 0, hm: pool ? pool.hm : 0, Vheld: held ? held.V : 0, heldKind: held ? held.kind : null };
  }

  // Animated process effects: [{kind:'air'|'cross'|'needle'|'spray'|'bath', ...}]
  setEffects(effects) {
    this.effects = effects || [];
    const animated = this.effects.some((e) => e.kind === 'air' || e.kind === 'cross' || e.kind === 'spray');
    if (animated && !this._loop) {
      const tick = () => { if (!this._loop) return; this.render(); this._loop = requestAnimationFrame(tick); };
      this._loop = requestAnimationFrame(tick);
    } else if (!animated && this._loop) { cancelAnimationFrame(this._loop); this._loop = null; this.render(); }
  }

  ringAt(sPos, scale = 1.12) {
    const geo = this.geo, i = Math.max(0, Math.min(geo.Ni - 1, Math.round(sPos / geo.ds - 0.5)));
    return [(geo.A[i] || 0) * scale * this.radial, geo.flat ? 0 : (geo.B[i] || 0) * scale * this.radial, i];
  }

  // build line geometry for markers + effects (time-dependent)
  buildLines(now) {
    const geo = this.geo, lp = [], lc = [];
    const seg = (a, b, rgb) => { lp.push(...a, ...b); lc.push(...rgb, ...rgb); };
    // outline of the bevelled tip opening, so the cut reads even at full-part zoom
    if (geo.bevel && geo.bevel.deg > 0 && !geo.flat) {
      const rim = [];
      const W = this.M0.wall, R = this.radial, r0 = (this.rows - 1) * this.cols;
      for (let u = 0; u < this.cols; u++) { const v = r0 + u; rim.push([W[3 * v] * R, W[3 * v + 1] * R, W[3 * v + 2]]); }
      const hidden = (P) => this.cutaway && geo.surface === 'inner' && P[0] * this.cutN[0] + P[1] * this.cutN[1] > 1e-9;
      for (let u = 0; u < rim.length - 1; u++) if (!hidden(rim[u]) || !hidden(rim[u + 1])) seg(rim[u], rim[u + 1], [1.0, 0.82, 0.35]);
    }
    for (const m of this.markers || []) {
      if (m.s === null || m.s === undefined || !isFinite(m.s)) continue;
      const [a, b] = this.ringAt(m.s), segs = 48, rgb = m.rgb || [1, 1, 1];
      for (let q = 0; q < segs; q++) {
        const p = (qq) => { const t = (qq / segs) * 2 * Math.PI; return geo.flat ? [-a + (2 * a * qq) / segs, 0.1e-3, m.s] : [a * Math.cos(t), b * Math.sin(t), m.s]; };
        seg(p(q), p(q + 1), rgb);
      }
    }
    const L = geo.L, t = now / 1000;
    for (const e of this.effects || []) {
      if (e.kind === 'air') {
        // streaks travelling along the bore (or along the outside) in the flow direction
        const n = 70, rgb = e.hot ? [1.0, 0.55, 0.2] : [0.75, 0.85, 1.0];
        const speed = 0.35 * L * Math.min(3, 0.5 + e.speed / 8);
        for (let q = 0; q < n; q++) {
          const phase = (q * 0.6180339) % 1, ang = q * 2.399;
          let sPos = ((phase * L + t * speed) % (L * 1.1)) - 0.05 * L;
          if (e.dir < 0) sPos = L - sPos;
          const [a, b] = this.ringAt(Math.max(0, Math.min(L, sPos)), geo.surface === 'inner' ? 0.55 * (0.3 + 0.7 * ((q * 0.37) % 1)) : 1.35);
          const x = a * Math.cos(ang), y = b * Math.sin(ang), len = 0.06 * L * e.dir;
          seg([x, y, sPos], [x, y, sPos + len], rgb);
        }
      } else if (e.kind === 'cross') {
        // Horizontal tip jets: they blow across the opening from the short side of the bevel
        // into its long side, angled with the bevel, so excess is ejected straight off the tip.
        const atEnd = e.end !== 'start';
        const bv = (atEnd && geo.bevel) || { deg: 0, clockDeg: 270, qmax: geo.A[geo.Ni - 1] };
        const R = this.radial, cb = (bv.clockDeg * Math.PI) / 180, tb = Math.tan((bv.deg * Math.PI) / 180);
        const i0 = atEnd ? geo.Ni - 1 : 0;
        const qmax = (bv.qmax || Math.max(geo.A[i0], geo.B[i0] || 0)) * R;
        const half = Math.max(geo.A[i0], geo.B[i0] || 0) * R;
        const ux = Math.cos(cb), uy = Math.sin(cb), px = -uy, py = ux;
        const n = 30;
        for (let q = 0; q < n; q++) {
          const ph = ((q * 0.6180339) + t * 1.1) % 1;
          const pLat = half * (-0.8 + 1.6 * ((q * 0.37) % 1));
          const ql = -2.2 * qmax + 5 * qmax * ph, len = 0.35 * qmax;
          const off = (0.002 + 0.006 * ((q * 0.53) % 1)) * L; // thin sheet just outside the cut plane
          const zOf = (qq) => (atEnd ? L - ((qmax - qq) / R) * tb + off : -off);
          const P = (qq) => [qq * ux + pLat * px, qq * uy + pLat * py, zOf(qq)];
          const past = ql > qmax ? Math.min(1, (ql - qmax) / (2 * qmax)) : 0;
          // dim tail + bright head shows the travel direction (short side -> long side -> off the tip)
          seg(P(ql), P(ql + 0.7 * len), [0.25, 0.4 - 0.1 * past, 0.5]);
          seg(P(ql + 0.7 * len), P(ql + len), [0.85 - 0.3 * past, 0.95, 1.0]);
        }
      } else if (e.kind === 'needle') {
        const from = e.fromEnd === 'end' ? L * 1.15 : -0.15 * L;
        const [a, b] = this.ringAt(e.s, 1);
        const n = this.cutN || [0, 1];
        // inside: in the visible half, toward its wall; outside: above the part
        const x = geo.surface === 'inner' ? -0.45 * a * n[0] : 0, y = geo.surface === 'inner' ? -0.45 * b * n[1] : 1.6 * b;
        const tx = geo.surface === 'inner' ? -0.15 * Math.max(a, 0.0005) * n[0] : 0, ty = geo.surface === 'inner' ? -0.15 * Math.max(b, 0.0005) * n[1] : -0.15 * Math.max(b, 0.0005);
        seg([x, y, from], [x, y, e.s], [0.85, 0.87, 0.9]);
        seg([x, y, e.s], [x + tx, y + ty, e.s], [0.3, 0.8, 1.0]);
      } else if (e.kind === 'spray') {
        const [a] = this.ringAt(e.s, 1), top = 3 * Math.max(a, 0.001) + 0.05 * L;
        const n = 28, rgb = [0.55, 0.8, 1.0];
        for (let q = 0; q < n; q++) {
          const ph = ((q * 0.6180339) + t * 1.5) % 1, spread = (((q * 0.37) % 1) - 0.5) * 0.25 * L;
          const y0 = top * (1 - ph), y1 = Math.max(a, top * (1 - ph - 0.12));
          seg([0, y0, e.s + spread * ph], [0, y1, e.s + spread * (ph + 0.12)], rgb);
        }
      } else if (e.kind === 'bath') {
        // liquid level plane edges around the part
        const [a] = this.ringAt(e.s, 1), w = Math.max(3 * a, 0.08 * L), rgb = [0.3, 0.75, 1.0];
        for (const yy of [-w, w]) seg([-w, yy, e.s], [w, yy, e.s], rgb);
        for (const xx of [-w, w]) seg([xx, -w, e.s], [xx, w, e.s], rgb);
      }
    }
    return { lp: new Float32Array(lp), lc: new Float32Array(lc) };
  }

  modelMatrix() {
    this.autoCamera(false);
    // body frame -> world: axis direction a = (sin b, -cos b, 0); body y -> (cos b, sin b, 0); body x -> z
    const b = (this.tilt * Math.PI) / 180, s = this.scale, L = this.geo.L;
    const ax = [Math.sin(b), -Math.cos(b), 0], ay = [Math.cos(b), Math.sin(b), 0], az = [0, 0, 1];
    const o = mat4();
    // columns: body x -> az, body y -> ay, body z -> ax
    o[0] = az[0] * s; o[1] = az[1] * s; o[2] = az[2] * s;
    o[4] = ay[0] * s; o[5] = ay[1] * s; o[6] = ay[2] * s;
    o[8] = ax[0] * s; o[9] = ax[1] * s; o[10] = ax[2] * s;
    o[12] = -ax[0] * s * L / 2; o[13] = -ax[1] * s * L / 2; o[14] = 0; o[15] = 1;
    return o;
  }

  render() {
    const gl = this.gl; if (!gl || !this.geo) return;
    const W = this.el.clientWidth, H = this.el.clientHeight, dpr = window.devicePixelRatio || 1;
    if (W < 10 || H < 10) return;
    if (this.canvas.width !== Math.round(W * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
    this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px';
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.prog);
    const eye = [this.dist * Math.cos(this.pitch) * Math.sin(this.yaw), this.dist * Math.sin(this.pitch), this.dist * Math.cos(this.pitch) * Math.cos(this.yaw)];
    const tgt = this.tgt;
    const e2 = [eye[0] + tgt[0], eye[1] + tgt[1], eye[2] + tgt[2]];
    const V = lookAt(e2, tgt, [0, 1, 0]);
    const P = perspective(0.75, W / H, Math.max(1e-4, this.dist * 0.02), this.dist + 20);
    const Mm = this.modelMatrix();
    const MVP = mul(P, V);
    this._mvp = MVP;
    gl.uniformMatrix4fv(this.loc.uMVP, false, MVP);
    gl.uniformMatrix4fv(this.loc.uModel, false, Mm);
    gl.uniform3fv(this.loc.uEye, e2);
    gl.uniform1f(this.loc.uCut, this.cutaway ? 1 : 0);
    gl.uniform1f(this.loc.uSec, this.secZ != null ? this.secZ - 1e-7 : -1e9);
    const bindA = (name, loc, size) => { if (loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[name]); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    // main surface
    bindA('pos', this.loc.aPos, 3); bindA('nrm', this.loc.aNrm, 3); bindA('col', this.loc.aCol, 3); bindA('cut', this.loc.aCut, 1); bindA('gloss', this.loc.aGloss, 1);
    gl.uniform1f(this.loc.uAlpha, 1); gl.uniform1f(this.loc.uFlat, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
    // coating layer (pulled toward the eye so a true-scale film still shows over the wall)
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -4);
    bindA('cpos', this.loc.aPos, 3); bindA('cnrm', this.loc.aNrm, 3); bindA('ccol', this.loc.aCol, 3); bindA('ccut', this.loc.aCut, 1); bindA('cgloss', this.loc.aGloss, 1);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    // caps on the cut plane: coating thickness band + wall band
    if (this.nCap) {
      bindA('kpos', this.loc.aPos, 3); bindA('knrm', this.loc.aNrm, 3); bindA('kcol', this.loc.aCol, 3); bindA('kgloss', this.loc.aGloss, 1);
      gl.disableVertexAttribArray(this.loc.aCut); gl.vertexAttrib1f(this.loc.aCut, -1);
      gl.drawArrays(gl.TRIANGLES, 0, this.nCap);
    }
    // liquid pool body at the tip (in front of the coplanar film caps)
    if (this.nPool) {
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -8);
      bindA('ppos', this.loc.aPos, 3); bindA('pnrm', this.loc.aNrm, 3); bindA('pcol', this.loc.aCol, 3); bindA('pcut', this.loc.aCut, 1); bindA('pgloss', this.loc.aGloss, 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.nPool);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // lines (no depth test so markers are always visible)
    const lines = this.buildLines(performance.now());
    this.upload('lpos', lines.lp); this.upload('lcol', lines.lc);
    this.nLines = lines.lp.length / 3;
    gl.disableVertexAttribArray(this.loc.aGloss); gl.vertexAttrib1f(this.loc.aGloss, 0);
    if (this.nLines) {
      gl.disable(gl.DEPTH_TEST);
      bindA('lpos', this.loc.aPos, 3); bindA('lcol', this.loc.aCol, 3);
      gl.disableVertexAttribArray(this.loc.aCut); gl.vertexAttrib1f(this.loc.aCut, 0);
      gl.disableVertexAttribArray(this.loc.aNrm); gl.vertexAttrib3f(this.loc.aNrm, 0, 1, 0);
      gl.uniform1f(this.loc.uFlat, 1);
      gl.drawArrays(gl.LINES, 0, this.nLines);
      gl.enable(gl.DEPTH_TEST);
    }
    // ghost wall
    if (this.hasGhost) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      bindA('gpos', this.loc.aPos, 3); bindA('gnrm', this.loc.aNrm, 3); bindA('gcol', this.loc.aCol, 3); bindA('gcut', this.loc.aCut, 1);
      gl.disableVertexAttribArray(this.loc.aGloss); gl.vertexAttrib1f(this.loc.aGloss, 0);
      gl.uniform1f(this.loc.uAlpha, 0.18); gl.uniform1f(this.loc.uFlat, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }

  snapshot() { this.render(); return this.canvas.toDataURL('image/png'); }
}
