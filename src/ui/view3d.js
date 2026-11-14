// Minimal WebGL viewer: part surface coloured by a field, optional film exaggeration,
// cutaway for lumen surfaces, ghost wall, and process markers (bath level, nozzle,
// meniscus) drawn as rings.

import { colorAt } from './colormap.js';

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec3 aCol; attribute float aCut;
uniform mat4 uMVP; uniform mat4 uModel; varying vec3 vN; varying vec3 vC; varying float vCut; varying vec3 vW;
void main(){ vec4 w = uModel*vec4(aPos,1.0); vW=w.xyz; gl_Position=uMVP*w; vN=mat3(uModel)*aNrm; vC=aCol; vCut=aCut; }`;
const FS = `
precision mediump float; varying vec3 vN; varying vec3 vC; varying float vCut; varying vec3 vW;
uniform float uCut; uniform float uAlpha; uniform vec3 uEye; uniform float uFlat;
void main(){
  if (uCut > 0.5 && vCut > 0.0) discard;
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uEye - vW);
  vec3 l1 = normalize(vec3(0.4,0.9,0.6)); vec3 l2 = v;
  float d = 0.35 + 0.4*max(dot(n,l1),0.0) + 0.35*max(dot(n,l2),0.0);
  vec3 h = normalize(l1+v); float sp = pow(max(dot(n,h),0.0),40.0)*0.25;
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
    for (const a of ['aPos', 'aNrm', 'aCol', 'aCut']) this.loc[a] = gl.getAttribLocation(p, a);
    for (const u of ['uMVP', 'uModel', 'uCut', 'uAlpha', 'uEye', 'uFlat']) this.loc[u] = gl.getUniformLocation(p, u);
    this.buf = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), cut: gl.createBuffer(), idx: gl.createBuffer(),
      gpos: gl.createBuffer(), gnrm: gl.createBuffer(), gcol: gl.createBuffer(), gcut: gl.createBuffer(),
      lpos: gl.createBuffer(), lcol: gl.createBuffer() };
    this.yaw = -0.5; this.pitch = 0.5; this.dist = 2.6; this.pan = [0, 0];
    this.cutaway = true; this.exag = 0; this.tilt = 90; this.radialMode = 'auto'; this.radial = 1;
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.b === 2 || drag.shift) { this.pan[0] += dx * 0.003 * this.dist; this.pan[1] -= dy * 0.003 * this.dist; }
      else { this.yaw += dx * 0.008; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.008)); }
      this.render();
    });
    this.canvas.addEventListener('pointerup', () => { drag = null; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.dist = Math.max(0.4, Math.min(20, this.dist * Math.exp(e.deltaY * 0.001))); this.render(); }, { passive: false });
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  resetView() { this.yaw = -0.5; this.pitch = 0.5; this.dist = 2.6; this.pan = [0, 0]; this.render(); }

  // geo: serialised geometry; ghost: wall radius offset for the context shell
  setGeometry(geo) {
    this.geo = geo;
    const { Ni, Nj, flat } = geo;
    const cols = flat ? Nj : Nj + 1;
    this.cols = cols;
    const idx = [];
    for (let i = 0; i < Ni - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    this.nIdx = idx.length;
    const gl = this.gl; if (!gl) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    gl.getExtension('OES_element_index_uint');
    let rmax = 0;
    for (let i = 0; i < Ni; i++) rmax = Math.max(rmax, geo.A[i], geo.B[i] || 0);
    // slender parts: optionally scale the radius so the part is visible
    this.radial = this.radialMode === 'auto' && !geo.flat ? Math.max(1, geo.L / 10 / (2 * rmax)) : 1;
    this.scale = 2.2 / Math.max(geo.L, 2 * rmax * this.radial * 1.2);
    this.rmax = rmax;
    // ghost shell (outer wall for lumen views, nothing otherwise)
    this.hasGhost = geo.surface === 'inner';
    if (this.hasGhost) {
      const n = Ni * cols, gp = new Float32Array(3 * n), gn = new Float32Array(3 * n), gc = new Float32Array(3 * n), gcut = new Float32Array(n);
      const wall = Math.max(0.15 * rmax, 0.2e-3);
      for (let i = 0; i < Ni; i++) for (let jj = 0; jj < cols; jj++) {
        const j = jj % Nj, k = i * Nj + j, v = i * cols + jj;
        const nx = -geo.nrm[3 * k], ny = -geo.nrm[3 * k + 1], nz = -geo.nrm[3 * k + 2];
        gp[3 * v] = (geo.pos[3 * k] + nx * wall) * this.radial; gp[3 * v + 1] = (geo.pos[3 * k + 1] + ny * wall) * this.radial; gp[3 * v + 2] = geo.pos[3 * k + 2];
        gn[3 * v] = nx; gn[3 * v + 1] = ny; gn[3 * v + 2] = nz;
        gc[3 * v] = 0.55; gc[3 * v + 1] = 0.6; gc[3 * v + 2] = 0.68;
        gcut[v] = geo.pos[3 * k + 1] > 1e-9 ? 1 : 0;
      }
      this.upload('gpos', gp); this.upload('gnrm', gn); this.upload('gcol', gc); this.upload('gcut', gcut);
    }
  }

  upload(name, arr) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[name]); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW); }

  // values: per cell scalar for colour; film: per cell thickness [m] for displacement
  setField(values, range, cmap, film, markers = [], bare = null) {
    const geo = this.geo; if (!geo || !this.gl) return;
    const { Ni, Nj } = geo, cols = this.cols, n = Ni * cols;
    const pos = new Float32Array(3 * n), nrm = new Float32Array(3 * n), col = new Float32Array(3 * n), cut = new Float32Array(n);
    const [lo, hi] = range;
    const ex = this.exag;
    for (let i = 0; i < Ni; i++) for (let jj = 0; jj < cols; jj++) {
      const j = jj % Nj, k = i * Nj + j, v = i * cols + jj;
      const d = film && ex > 0 ? film[k] * ex : 0;
      for (let c = 0; c < 3; c++) { pos[3 * v + c] = (geo.pos[3 * k + c] + (c < 2 || geo.flat ? geo.nrm[3 * k + c] * d : 0)) * (c < 2 ? this.radial : 1); nrm[3 * v + c] = geo.nrm[3 * k + c]; }
      if (bare && bare[k]) { col[3 * v] = 0.40; col[3 * v + 1] = 0.42; col[3 * v + 2] = 0.46; }
      else {
        const rgb = colorAt(cmap, 0.12 + 0.88 * Math.max(0, Math.min(1, (values[k] - lo) / (hi - lo))));
        col[3 * v] = rgb[0] / 255; col[3 * v + 1] = rgb[1] / 255; col[3 * v + 2] = rgb[2] / 255;
      }
      cut[v] = geo.surface === 'inner' && geo.pos[3 * k + 1] > 1e-9 ? 1 : 0;
    }
    this.upload('pos', pos); this.upload('nrm', nrm); this.upload('col', col); this.upload('cut', cut);
    // marker rings
    const lp = [], lc = [];
    for (const m of markers) {
      if (m.s === null || m.s === undefined || !isFinite(m.s)) continue;
      const i = Math.max(0, Math.min(Ni - 1, Math.round(m.s / geo.ds - 0.5)));
      const a = (geo.A[i] || 0) * 1.12 + 0.05e-3, b = geo.flat ? 0 : (geo.B[i] || 0) * 1.12 + 0.05e-3;
      const segs = 48;
      const rgb = m.rgb || [1, 1, 1];
      for (let q = 0; q < segs; q++) {
        for (const qq of [q, q + 1]) {
          const t = (qq / segs) * 2 * Math.PI;
          if (geo.flat) lp.push(-a + (2 * a * qq) / segs, 0.1e-3, m.s); else lp.push(a * Math.cos(t) * this.radial, b * Math.sin(t) * this.radial, m.s);
          lc.push(...rgb);
        }
      }
    }
    this.nLines = lp.length / 3;
    this.upload('lpos', new Float32Array(lp)); this.upload('lcol', new Float32Array(lc));
    this.render();
  }

  modelMatrix() {
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
    const right = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const tgt = [right[0] * -this.pan[0], this.pan[1] * -1 * -1, right[2] * -this.pan[0]];
    const e2 = [eye[0] + tgt[0], eye[1] + tgt[1], eye[2] + tgt[2]];
    const V = lookAt(e2, tgt, [0, 1, 0]);
    const P = perspective(0.75, W / H, 0.01, 100);
    const Mm = this.modelMatrix();
    const MVP = mul(P, V);
    gl.uniformMatrix4fv(this.loc.uMVP, false, MVP);
    gl.uniformMatrix4fv(this.loc.uModel, false, Mm);
    gl.uniform3fv(this.loc.uEye, e2);
    gl.uniform1f(this.loc.uCut, this.cutaway ? 1 : 0);
    const bindA = (name, loc, size) => { if (loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[name]); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    // main surface
    bindA('pos', this.loc.aPos, 3); bindA('nrm', this.loc.aNrm, 3); bindA('col', this.loc.aCol, 3); bindA('cut', this.loc.aCut, 1);
    gl.uniform1f(this.loc.uAlpha, 1); gl.uniform1f(this.loc.uFlat, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
    // lines (no depth test so markers are always visible)
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
      gl.uniform1f(this.loc.uAlpha, 0.18); gl.uniform1f(this.loc.uFlat, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }

  snapshot() { this.render(); return this.canvas.toDataURL('image/png'); }
}
