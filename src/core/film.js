// Thin-film (lubrication) solver on a curved surface grid.
//
//   dh/dt + div(q) = S - E
//   q = (h^3 / 3mu) * ( -grad p + rho g_t ) + (h^2 / 2mu) tau
//   p = -gamma (lap h + kc^2 h) - Pi(h) - rho (g.n) h
//   d(h phi)/dt + div(phi q) = S phi_s            (solids transport)
//   d(alpha)/dt = cure rate                        (cure kinetics)
//
// Spatial discretisation: finite volumes on the (s, phi) surface grid with metric
// widths from the geometry. Time integration: linearly implicit, approximately
// factorised ADI in delta form (Witelski & Bowen 2003) for the stiff capillary terms,
// explicit for gravity/shear advection, evaporation and sources; adaptive step size.

import { PentaSolver } from './linalg.js';
import { viscosity, evaporationRate, cureRate, disjoining, disjoiningCoeff } from './physics.js';

export class FilmSolver {
  constructor(geo, coat, opts = {}) {
    this.geo = geo; this.coat = coat;
    const N = geo.N;
    this.gamma = (coat.d + coat.p) * 1e-3;
    this.rho = coat.rho;
    this.hp = opts.precursor || 0.05e-6; // precursor film thickness [m]
    this.h = new Float64Array(N).fill(this.hp);
    this.m = new Float64Array(N);          // solids height [m]
    this.alpha = new Float64Array(N);
    this.mask = new Uint8Array(N);         // 1 = held fixed (bath / liquid plug)
    this.hFix = new Float64Array(N);
    this.theta = new Float64Array(N).fill(Math.PI / 4); // local equilibrium contact angle
    this.Bd = new Float64Array(N);
    this.wetted = new Uint8Array(N);       // has ever carried a real film
    this.setContactAngle(Math.PI / 4);
    // per-step environment fields
    this.src = new Float64Array(N);        // deposition rate [m/s]
    this.srcPhi = coat.solids;
    this.tauS = new Float64Array(N); this.tauP = new Float64Array(N); // interfacial shear [Pa]
    this.evapFac = new Float64Array(N).fill(1);
    this.env = { T: 298.15, airU: 0, uv: 0, g: [0, 0, 9.81] };
    this.Tf = new Float64Array(N).fill(298.15);   // film/part temperature [K]
    this.Tair = new Float64Array(N).fill(298.15); // local air temperature the part relaxes to [K]
    this.tauHeat = opts.tauHeat || 30;            // thermal time constant of the part wall [s]
    // work arrays
    this.mu = new Float64Array(N); this.M = new Float64Array(N); this.p = new Float64Array(N);
    this.R = new Float64Array(N); this.Rm = new Float64Array(N); this.D = new Float64Array(N);
    this.gn = new Float64Array(N); this.gs = new Float64Array(N); this.gp = new Float64Array(N);
    this.delta = new Float64Array(N);
    this.uS = new Float64Array(N); this.uP = new Float64Array(N); // linearised advective face velocities x face width
    this.solverS = new PentaSolver(geo.Ni);
    this.solverP = new PentaSolver(geo.Nj);
    const nmax = Math.max(geo.Ni, geo.Nj);
    this.la = new Float64Array(nmax); this.lb = new Float64Array(nmax); this.lc = new Float64Array(nmax);
    this.ld = new Float64Array(nmax); this.le = new Float64Array(nmax); this.lr = new Float64Array(nmax);
    this.dt = 1e-4;
    this.t = 0;
    this.stats = { deposited: 0, evaporated: 0, dripped: 0, bathExchange: 0, steps: 0, rejected: 0, clipped: 0 };
    this.dripEnabled = opts.drip !== false;
    this.cflMax = opts.cflMax || 4; // advection is implicit; this only bounds accuracy
  }

  setContactAngle(theta, field) {
    const N = this.geo.N;
    for (let k = 0; k < N; k++) {
      const th = field ? field[k] : theta;
      this.theta[k] = th;
      this.Bd[k] = disjoiningCoeff(this.gamma, th, this.hp);
    }
  }

  volume() {
    let v = 0; const { area } = this.geo;
    for (let k = 0; k < this.geo.N; k++) if (!this.mask[k]) v += (this.h[k] - this.hp) * area[k];
    return v;
  }
  solidsVolume() {
    let v = 0; const { area } = this.geo;
    for (let k = 0; k < this.geo.N; k++) if (!this.mask[k]) v += this.m[k] * area[k];
    return v;
  }

  // Update gravity projections (body-frame gravity vector g).
  setGravity(g) {
    const { nrm, es, ep, N } = this.geo;
    this.env.g = g;
    for (let k = 0; k < N; k++) {
      const o = 3 * k;
      this.gn[k] = g[0] * nrm[o] + g[1] * nrm[o + 1] + g[2] * nrm[o + 2];
      this.gs[k] = g[0] * es[o] + g[1] * es[o + 1] + g[2] * es[o + 2];
      this.gp[k] = g[0] * ep[o] + g[1] * ep[o + 1] + g[2] * ep[o + 2];
    }
  }

  // Compute viscosity, mobility, pressure and the explicit rate R = -div q + S.
  _rates() {
    const geo = this.geo, { Ni, Nj, ds, w, area, kc, periodic } = geo;
    const h = this.h, m = this.m, mu = this.mu, M = this.M, p = this.p, R = this.R, Rm = this.Rm, D = this.D;
    const c = this.coat, gam = this.gamma, rho = this.rho, hp = this.hp, Tf = this.Tf;
    const N = geo.N;
    let vmax = 0;
    this.uS.fill(0); this.uP.fill(0);
    for (let k = 0; k < N; k++) {
      const phi = m[k] / h[k];
      mu[k] = viscosity(c, phi, this.alpha[k], Tf[k]);
      M[k] = (h[k] * h[k] * h[k]) / (3 * mu[k]);
    }
    // pressure
    for (let i = 0; i < Ni; i++) {
      for (let j = 0; j < Nj; j++) {
        const k = i * Nj + j;
        let lap = 0;
        if (i > 0) lap += 0.5 * (w[k] + w[k - Nj]) * (h[k - Nj] - h[k]) / ds;
        if (i < Ni - 1) lap += 0.5 * (w[k] + w[k + Nj]) * (h[k + Nj] - h[k]) / ds;
        const jm = j > 0 ? k - 1 : (periodic ? k + Nj - 1 : -1);
        const jp = j < Nj - 1 ? k + 1 : (periodic ? k - Nj + 1 : -1);
        if (jm >= 0) lap += ds * (h[jm] - h[k]) / (0.5 * (w[k] + w[jm]));
        if (jp >= 0) lap += ds * (h[jp] - h[k]) / (0.5 * (w[k] + w[jp]));
        lap /= area[k];
        const [Pi, dPi] = disjoining(this.Bd[k], hp, h[k]);
        p[k] = -gam * (lap + kc[k] * kc[k] * h[k]) - Pi - rho * this.gn[k] * h[k];
        D[k] = Math.max(0, -dPi - rho * this.gn[k]);
      }
    }
    R.fill(0); Rm.fill(0);
    const addFlux = (kL, kR, F) => {
      // F = volumetric flux from L to R [m^3/s]
      R[kL] -= F; R[kR] += F;
      const phiUp = F > 0 ? m[kL] / h[kL] : m[kR] / h[kR];
      Rm[kL] -= F * phiUp; Rm[kR] += F * phiUp;
    };
    // s-faces
    for (let i = 0; i < Ni - 1; i++) {
      for (let j = 0; j < Nj; j++) {
        const kL = i * Nj + j, kR = kL + Nj;
        if (this.mask[kL] && this.mask[kR]) continue;
        const wf = 0.5 * (w[kL] + w[kR]);
        // donor-limited mobility: a thin (precursor) donor cannot be pumped dry by a thick neighbour
        const Mf = Math.min(0.5 * (M[kL] + M[kR]), 2 * (p[kL] > p[kR] ? M[kL] : M[kR]));
        const gsf = 0.5 * (this.gs[kL] + this.gs[kR]);
        const Mg = gsf > 0 ? M[kL] : M[kR];
        const tau = 0.5 * (this.tauS[kL] + this.tauS[kR]);
        const kup = tau > 0 ? kL : kR;
        const Ms = (h[kup] * h[kup]) / (2 * mu[kup]);
        const q = -Mf * (p[kR] - p[kL]) / ds + Mg * rho * gsf + Ms * tau;
        const ua = (rho * gsf * h[gsf > 0 ? kL : kR] ** 2) / mu[gsf > 0 ? kL : kR] + (tau * h[kup]) / mu[kup];
        this.uS[kL] = ua * wf;
        const v = Math.abs(Mg * rho * gsf + Ms * tau) / h[kup];
        if (v > vmax) vmax = v;
        addFlux(kL, kR, q * wf);
      }
    }
    // phi-faces
    const jEnd = periodic ? Nj : Nj - 1;
    for (let i = 0; i < Ni; i++) {
      for (let j = 0; j < jEnd; j++) {
        const kL = i * Nj + j, kR = i * Nj + ((j + 1) % Nj);
        if (this.mask[kL] && this.mask[kR]) continue;
        const dist = 0.5 * (w[kL] + w[kR]);
        const Mf = Math.min(0.5 * (M[kL] + M[kR]), 2 * (p[kL] > p[kR] ? M[kL] : M[kR]));
        const gpf = 0.5 * (this.gp[kL] + this.gp[kR]);
        const Mg = gpf > 0 ? M[kL] : M[kR];
        const tau = 0.5 * (this.tauP[kL] + this.tauP[kR]);
        const kup = tau > 0 ? kL : kR;
        const Ms = (h[kup] * h[kup]) / (2 * mu[kup]);
        const q = -Mf * (p[kR] - p[kL]) / dist + Mg * rho * gpf + Ms * tau;
        const ua = (rho * gpf * h[gpf > 0 ? kL : kR] ** 2) / mu[gpf > 0 ? kL : kR] + (tau * h[kup]) / mu[kup];
        this.uP[kL] = ua * ds;
        const v = Math.abs(Mg * rho * gpf + Ms * tau) / h[kup];
        if (v > vmax) vmax = v;
        addFlux(kL, kR, q * ds);
      }
    }
    for (let k = 0; k < N; k++) {
      if (this.mask[k]) { R[k] = 0; Rm[k] = 0; continue; }
      R[k] = R[k] / area[k] + this.src[k];
      Rm[k] = Rm[k] / area[k] + this.src[k] * this.srcPhi;
    }
    return vmax;
  }

  // Assemble and solve one implicit line operator (I - dt J) x = r in place.
  // idx: cell indices along the line; cl: Laplacian face conductances (face f between f and f+1)
  _lineSolve(idx, n, periodic, cl, gm, gd, ua, Aa, r, solver) {
    const a = this.la, b = this.lb, c = this.lc, d = this.ld, e = this.le;
    const gam = this.gamma, dt = this.dt;
    a.fill(0, 0, n); b.fill(0, 0, n); c.fill(0, 0, n); d.fill(0, 0, n); e.fill(0, 0, n);
    const wrap = (k) => (periodic ? (k + n) % n : k);
    const has = (f) => periodic || (f >= 0 && f < n - 1);
    // P_k = sum_{o=-1..1} pc(k,o) x_{k+o}
    const pc = (k, o) => {
      const fl = k - 1, fr = k; // left face index (k-1|k), right face (k|k+1)
      const clL = has(fl) ? cl[wrap(fl)] : 0, clR = has(fr) ? cl[wrap(fr)] : 0;
      if (o === -1) return (-gam / Aa[k]) * clL;
      if (o === 1) return (-gam / Aa[k]) * clR;
      return (gam / Aa[k]) * (clL + clR);
    };
    const add = (row, col, val) => {
      let off = col - row;
      if (periodic) { if (off > 2) off -= n; if (off < -2) off += n; }
      switch (off) {
        case -2: a[row] += val; break; case -1: b[row] += val; break; case 0: c[row] += val; break;
        case 1: d[row] += val; break; case 2: e[row] += val; break; default: break;
      }
    };
    for (let k = 0; k < n; k++) {
      c[k] += 1;
      if (this.mask[idx[k]]) { r[k] = 0; continue; }
      // Inflow through each face of cell k: gm (P_kn - P_k) + gd (x_kn - x_k);
      // (J x)_k = sum over faces / A_k ; matrix row gets -dt * J.
      for (let side = -1; side <= 1; side += 2) {
        const f = side === 1 ? k : k - 1;
        if (!has(f)) continue;
        const fi = wrap(f);
        const kn = wrap(k + side);
        const s = -dt / Aa[k];
        const g1 = gm[fi], g2 = gd[fi];
        for (let o = -1; o <= 1; o++) {
          const col = periodic ? wrap(kn + o) : kn + o;
          if (col >= 0 && col < n) add(k, col, s * g1 * pc(kn, o));
          const col2 = periodic ? wrap(k + o) : k + o;
          if (col2 >= 0 && col2 < n) add(k, col2, -s * g1 * pc(k, o));
        }
        add(k, kn, s * g2);
        add(k, k, -s * g2);
        // implicit upwind advection: face velocity u (positive = from k toward k+1 along the line)
        const u = ua[fi];
        if (u !== 0) {
          const inflow = side === 1 ? -u : u; // >0 means flow into cell k through this face
          if (inflow > 0) add(k, kn, s * inflow); else add(k, k, s * inflow);
        }
      }
    }
    if (periodic) solver.solveCyclic(a, b, c, d, e, r); else solver.solve(a, b, c, d, e, r);
  }

  // Advance one step of size this.dt. Returns false if rejected (state restored).
  step(maxRel = 0.25) {
    const geo = this.geo, { Ni, Nj, ds, w, area, periodic } = geo;
    const N = geo.N;
    const h = this.h;
    if (this.dtCap > 0 && this.dt > this.dtCap) this.dt = this.dtCap;
    const vmax = this._rates();
    // CFL for explicit advection: rates do not depend on dt, so just shorten the step
    if (this._minW === undefined) { let mw = ds; for (let k = 0; k < N; k++) if (w[k] < mw) mw = w[k]; this._minW = mw; }
    const minW = this._minW;
    this.cflLimited = false;
    if (vmax * this.dt > this.cflMax * minW) { this.dt = (this.cflMax * minW) / vmax; this.cflLimited = true; }
    const dt = this.dt;
    const R = this.R, M = this.M, D = this.D, delta = this.delta;
    for (let k = 0; k < N; k++) delta[k] = dt * R[k];
    // --- s-lines
    const ni = Ni, idx = this._idxS || (this._idxS = new Int32Array(ni));
    const clS = this._clS || (this._clS = new Float64Array(ni)), gmS = this._gmS || (this._gmS = new Float64Array(ni));
    const gdS = this._gdS || (this._gdS = new Float64Array(ni)), AS = this._AS || (this._AS = new Float64Array(ni));
    const uaS = this._uaS || (this._uaS = new Float64Array(ni));
    const r = this.lr;
    for (let j = 0; j < Nj; j++) {
      for (let i = 0; i < ni; i++) {
        const k = i * Nj + j; idx[i] = k; AS[i] = area[k]; r[i] = delta[k];
        if (i < ni - 1) {
          const k2 = k + Nj; const wf = 0.5 * (w[k] + w[k2]);
          clS[i] = wf / ds;
          const Mf = 0.5 * (M[k] + M[k2]);
          gmS[i] = (Mf * wf) / ds;
          gdS[i] = (Mf * 0.5 * (D[k] + D[k2]) * wf) / ds;
          uaS[i] = this.uS[k];
        }
      }
      this._lineSolve(idx, ni, false, clS, gmS, gdS, uaS, AS, r, this.solverS);
      for (let i = 0; i < ni; i++) delta[idx[i]] = r[i];
    }
    // --- phi-lines
    const nj = Nj, idxP = this._idxP || (this._idxP = new Int32Array(nj));
    const clP = this._clP || (this._clP = new Float64Array(nj)), gmP = this._gmP || (this._gmP = new Float64Array(nj));
    const gdP = this._gdP || (this._gdP = new Float64Array(nj)), AP = this._AP || (this._AP = new Float64Array(nj));
    const uaP = this._uaP || (this._uaP = new Float64Array(nj));
    for (let i = 0; i < Ni; i++) {
      for (let j = 0; j < nj; j++) {
        const k = i * Nj + j; idxP[j] = k; AP[j] = area[k]; r[j] = delta[k];
        if (j < nj - 1 || periodic) {
          const k2 = i * Nj + ((j + 1) % nj);
          const dist = 0.5 * (w[k] + w[k2]);
          clP[j] = ds / dist;
          const Mf = 0.5 * (M[k] + M[k2]);
          gmP[j] = (Mf * ds) / dist;
          gdP[j] = (Mf * 0.5 * (D[k] + D[k2]) * ds) / dist;
          uaP[j] = this.uP[k];
        }
      }
      this._lineSolve(idxP, nj, periodic, clP, gmP, gdP, uaP, AP, r, this.solverP);
      for (let j = 0; j < nj; j++) delta[idxP[j]] = r[j];
    }
    // --- accept / reject
    let rel = 0;
    const hp = this.hp;
    for (let k = 0; k < N; k++) {
      if (this.mask[k]) continue;
      const hn = h[k] + delta[k];
      if (!(hn === hn)) { rel = Infinity; this.worst = k; break; }
      // small undershoots ahead of a capillary front are clipped to the precursor (mass tracked)
      if (hn < 0 && -hn > 0.5 * h[k] + 2 * hp) { rel = Infinity; this.worst = k; break; }
      const rr = Math.abs(delta[k]) / (h[k] + 20 * hp);
      if (rr > rel) { rel = rr; this.worst = k; }
    }
    if (rel > maxRel) {
      this.dt *= Math.max(0.2, 0.7 * maxRel / rel);
      this.stats.rejected++;
      return false;
    }
    // apply transport
    const m = this.m, Rm = this.Rm, c = this.coat;
    let dep = 0;
    for (let k = 0; k < N; k++) {
      if (this.mask[k]) { h[k] = this.hFix[k]; continue; }
      dep += this.src[k] * dt * area[k];
      h[k] += delta[k];
      m[k] += dt * Rm[k];
      if (m[k] < 0) m[k] = 0;
      if (h[k] < hp) { this.stats.clipped += (hp - h[k]) * area[k]; h[k] = hp; }
      if (m[k] > h[k]) m[k] = h[k];
    }
    this.stats.deposited += dep;
    // evaporation + cure (pointwise)
    const airU = this.env.airU, uvI = this.env.uv, Tf = this.Tf;
    let evap = 0;
    // part/film temperature relaxes toward the local air temperature (thermal lag of the wall)
    const relax = 1 - Math.exp(-dt / Math.max(this.tauHeat, 1e-6));
    for (let k = 0; k < N; k++) Tf[k] += (this.Tair[k] - Tf[k]) * relax;
    const needEvap = c.evap0 > 0 && c.solids < c.phiMax;
    const ef = this.evapFac;
    for (let k = 0; k < N; k++) {
      if (this.mask[k]) continue;
      if (h[k] > 4 * hp) this.wetted[k] = 1;
      if (needEvap && h[k] > 2 * hp) {
        const phi = m[k] / h[k];
        const E = evaporationRate(c, phi, Tf[k], airU, ef[k]);
        const floor = Math.max(hp, m[k] / c.phiMax);
        const dh = Math.min(E * dt, Math.max(0, h[k] - floor));
        h[k] -= dh; evap += dh * area[k];
      }
      if (c.cure && c.cure.model !== 'none' && h[k] > 2 * hp) {
        const uvk = this.uvFac ? uvI * this.uvFac[k] : uvI;
        const a = this.alpha[k] + dt * cureRate(c, this.alpha[k], { T: Tf[k], uv: uvk });
        this.alpha[k] = Math.min(1, a);
      }
    }
    this.stats.evaporated += evap;
    if (this.dripEnabled) this._dripOff();
    if (this.endStrip) this._crossStrip();
    this.t += dt; this.stats.steps++;
    // step size adaptation
    const grow = rel < 0.25 * maxRel ? 1.5 : rel < 0.5 * maxRel ? 1.15 : 0.95;
    this.dt *= this.cflLimited ? 1 : grow;
    return true;
  }

  // Remove liquid collecting at an end of the part beyond what capillarity can hold
  // (a hanging drop detaches). Drop-off threshold ~ capillary length.
  _dripOff() {
    const { Ni, Nj, area } = this.geo;
    const lc = Math.sqrt(this.gamma / (this.rho * 9.81));
    const hMax = 0.6 * lc;
    for (const i of [0, Ni - 1]) {
      for (let j = 0; j < Nj; j++) {
        const k = i * Nj + j;
        if (this.mask[k]) continue;
        const outward = i === 0 ? -this.gs[k] : this.gs[k];
        const tauOut = i === 0 ? -this.tauS[k] : this.tauS[k];
        // air blowing out of an open end strips liquid once drag beats capillary retention
        let lim = Infinity;
        // a pendant drop at an open end detaches once it outgrows the capillary length,
        // or (in a lumen) once it would bridge the bore
        const hEnd = this.geo.surface === 'inner' ? Math.min(hMax, 0.45 * this.geo.rHyd[i]) : hMax;
        if (outward > 0.2 * 9.81 || this.gn[k] > 0) lim = hEnd;
        if (tauOut > 0.05) lim = Math.min(lim, Math.max(5e-6, Math.min(hMax, this.gamma / (200 * tauOut))));
        if (!isFinite(lim)) continue;
        if (this.h[k] > lim) {
          const ex = this.h[k] - lim;
          const frac = this.m[k] / this.h[k];
          this.stats.dripped += ex * area[k];
          this.h[k] = lim; this.m[k] = lim * frac;
        }
      }
    }
  }

  // Horizontal cross-jet across an opening strips liquid within `reach` of that end.
  _crossStrip() {
    const es = this.endStrip; if (!es) return;
    const { Ni, Nj, s, L, area } = this.geo;
    for (let i = 0; i < Ni; i++) {
      const d = es.end === 'start' ? s[i] : L - s[i];
      if (d > es.reach) continue;
      for (let j = 0; j < Nj; j++) {
        const k = i * Nj + j;
        if (this.mask[k] || this.h[k] <= es.lim) continue;
        const frac = this.m[k] / this.h[k];
        this.stats.dripped += (this.h[k] - es.lim) * area[k];
        this.h[k] = es.lim; this.m[k] = es.lim * frac;
      }
    }
  }

  // Advance to time tEnd (absolute) calling hook(solver) before each step.
  advance(tEnd, hook, opts = {}) {
    const dtMax = opts.dtMax || 5;
    const dtMin = opts.dtMin || 1e-9;
    let guard = 0;
    while (this.t < tEnd - 1e-12) {
      if (this.dt > dtMax) this.dt = dtMax;
      if (this.t + this.dt > tEnd) this.dt = tEnd - this.t;
      if (hook) hook(this);
      const ok = this.step(opts.maxRel || 0.25);
      if (!ok && this.dt < dtMin) throw new Error('Time step collapsed at t=' + this.t.toFixed(4) + ' s');
      if (++guard > (opts.maxSteps || 5e6)) throw new Error('Step limit reached');
      if (opts.onStep && ok) opts.onStep(this);
    }
  }
}

