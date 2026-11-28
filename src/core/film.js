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
import { viscosity, viscosityAt, evaporationRate, cureRate, disjoining, disjoiningCoeff, T_REF } from './physics.js';
import { GAS_R } from './materials.js';

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
    this.airUf = new Float64Array(N);             // local air speed over the film [m/s]
    this.hcAir = new Float64Array(N).fill(10);    // local air-side heat-transfer coefficient [W/m^2K]
    // work arrays
    this.mu = new Float64Array(N); this.M = new Float64Array(N); this.p = new Float64Array(N);
    this.R = new Float64Array(N); this.Rm = new Float64Array(N); this.D = new Float64Array(N);
    this.gn = new Float64Array(N); this.gs = new Float64Array(N); this.gp = new Float64Array(N);
    this.delta = new Float64Array(N);
    this.uS = new Float64Array(N); this.uP = new Float64Array(N); // linearised advective face velocities x face width
    // liquid volume through each face per step (s-face k → k+Nj, phi-face k → next j): explicit
    // flux and the implicit correction, so the solids can move with the liquid that actually moved
    this.FsE = new Float64Array(N); this.FpE = new Float64Array(N);
    this.VsT = new Float64Array(N); this.VpT = new Float64Array(N);
    this.phiO = new Float64Array(N); this.sOut = new Float64Array(N); this.dM = new Float64Array(N);
    this.solverS = new PentaSolver(geo.Ni);
    // axial row lengths and centre-to-centre distances (rows may be refined toward the tip)
    this.dsR = geo.dsR || new Float64Array(geo.Ni).fill(geo.ds);
    this.dC = new Float64Array(Math.max(1, geo.Ni - 1));
    for (let i = 0; i < geo.Ni - 1; i++) this.dC[i] = geo.uniform ? geo.ds : geo.s[i + 1] - geo.s[i];
    this.solverP = new PentaSolver(geo.Nj);
    const nmax = Math.max(geo.Ni, geo.Nj);
    this.la = new Float64Array(nmax); this.lb = new Float64Array(nmax); this.lc = new Float64Array(nmax);
    this.ld = new Float64Array(nmax); this.le = new Float64Array(nmax); this.lr = new Float64Array(nmax);
    this.dt = 1e-4;
    this.t = 0;
    this.stats = { deposited: 0, evaporated: 0, dripped: 0, bathExchange: 0, steps: 0, rejected: 0, clipped: 0, solidsClipGain: 0, solidsClipLoss: 0 };
    this.dripEnabled = opts.drip !== false;
    this.voidList = [];
    if (geo.voidMask) for (let k = 0; k < N; k++) if (geo.voidMask[k]) this.voidList.push(k);
    this.isVoid = geo.voidMask || new Uint8Array(N);
    this._applyVoid();
    this.cflMax = opts.cflMax || 4; // advection is implicit; this only bounds accuracy
  }

  // cells cut away by a bevel never carry liquid
  _applyVoid() {
    for (const k of this.voidList) { this.mask[k] = 2; this.hFix[k] = this.hp; this.h[k] = this.hp; this.m[k] = 0; this.alpha[k] = 0; }
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
    return v + this.poolVolume();
  }
  solidsVolume() {
    let v = 0; const { area } = this.geo;
    for (let k = 0; k < this.geo.N; k++) if (!this.mask[k]) v += this.m[k] * area[k];
    return v + (this.pool ? this.pool[0].M + this.pool[1].M : 0);
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
    const geo = this.geo, { Ni, Nj, w, area, kc, periodic } = geo;
    const dsR = this.dsR, dC = this.dC;
    const h = this.h, m = this.m, mu = this.mu, M = this.M, p = this.p, R = this.R, Rm = this.Rm, D = this.D;
    const c = this.coat, gam = this.gamma, rho = this.rho, hp = this.hp, Tf = this.Tf;
    const N = geo.N;
    let vmax = 0;
    this.uS.fill(0); this.uP.fill(0);
    // Arrhenius factor mu0·exp(Ea/R (1/T − 1/Tref)) per cell, recomputed only where the film
    // temperature changed since the last call (it is constant over most steps)
    if (!this._muT || this._muT.length !== N || this._muC !== c || this._muK !== c.mu0 + '|' + c.EaMu) {
      this._muT = new Float64Array(N); this._muTT = new Float64Array(N).fill(NaN); this._muC = c; this._muK = c.mu0 + '|' + c.EaMu;
    }
    const muT = this._muT, muTT = this._muTT, aMu = (c.EaMu * 1000) / GAS_R;
    for (let k = 0; k < N; k++) {
      const phi = m[k] / h[k], T = Tf[k];
      if (T !== muTT[k]) { muTT[k] = T; muT[k] = c.mu0 * Math.exp(aMu * (1 / T - 1 / T_REF)); }
      mu[k] = viscosityAt(c, muT[k], phi, this.alpha[k]);
      M[k] = (h[k] * h[k] * h[k]) / (3 * mu[k]);
    }
    // pressure
    for (let i = 0; i < Ni; i++) {
      for (let j = 0; j < Nj; j++) {
        const k = i * Nj + j;
        let lap = 0;
        const V = this.isVoid;
        if (i > 0 && !V[k - Nj]) lap += 0.5 * (w[k] + w[k - Nj]) * (h[k - Nj] - h[k]) / dC[i - 1];
        if (i < Ni - 1 && !V[k + Nj]) lap += 0.5 * (w[k] + w[k + Nj]) * (h[k + Nj] - h[k]) / dC[i];
        const jm = j > 0 ? k - 1 : (periodic ? k + Nj - 1 : -1);
        const jp = j < Nj - 1 ? k + 1 : (periodic ? k - Nj + 1 : -1);
        if (jm >= 0 && !V[jm]) lap += dsR[i] * (h[jm] - h[k]) / (0.5 * (w[k] + w[jm]));
        if (jp >= 0 && !V[jp]) lap += dsR[i] * (h[jp] - h[k]) / (0.5 * (w[k] + w[jp]));
        lap /= area[k];
        const [Pi, dPi] = disjoining(this.Bd[k], hp, h[k]);
        p[k] = -gam * (lap + kc[k] * kc[k] * h[k]) - Pi - rho * this.gn[k] * h[k];
        D[k] = Math.max(0, -dPi - rho * this.gn[k]);
      }
    }
    R.fill(0); Rm.fill(0);
    const FsE = this.FsE, FpE = this.FpE;
    FsE.fill(0); FpE.fill(0);
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
        if ((this.mask[kL] && this.mask[kR]) || this.isVoid[kL] || this.isVoid[kR]) continue;
        const wf = 0.5 * (w[kL] + w[kR]);
        // donor-limited mobility: a thin (precursor) donor cannot be pumped dry by a thick neighbour
        const Mf = Math.min(0.5 * (M[kL] + M[kR]), 2 * (p[kL] > p[kR] ? M[kL] : M[kR]));
        const gsf = 0.5 * (this.gs[kL] + this.gs[kR]);
        const Mg = gsf > 0 ? M[kL] : M[kR];
        const tau = 0.5 * (this.tauS[kL] + this.tauS[kR]);
        const kup = tau > 0 ? kL : kR;
        const Ms = (h[kup] * h[kup]) / (2 * mu[kup]);
        const q = -Mf * (p[kR] - p[kL]) / dC[i] + Mg * rho * gsf + Ms * tau;
        const ua = (rho * gsf * h[gsf > 0 ? kL : kR] ** 2) / mu[gsf > 0 ? kL : kR] + (tau * h[kup]) / mu[kup];
        this.uS[kL] = ua * wf;
        const v = Math.abs(Mg * rho * gsf + Ms * tau) / h[kup];
        if (v > vmax) vmax = v;
        addFlux(kL, kR, q * wf); FsE[kL] = q * wf;
      }
    }
    // phi-faces
    const jEnd = periodic ? Nj : Nj - 1;
    for (let i = 0; i < Ni; i++) {
      for (let j = 0; j < jEnd; j++) {
        const kL = i * Nj + j, kR = i * Nj + ((j + 1) % Nj);
        if ((this.mask[kL] && this.mask[kR]) || this.isVoid[kL] || this.isVoid[kR]) continue;
        const dist = 0.5 * (w[kL] + w[kR]);
        const Mf = Math.min(0.5 * (M[kL] + M[kR]), 2 * (p[kL] > p[kR] ? M[kL] : M[kR]));
        const gpf = 0.5 * (this.gp[kL] + this.gp[kR]);
        const Mg = gpf > 0 ? M[kL] : M[kR];
        const tau = 0.5 * (this.tauP[kL] + this.tauP[kR]);
        const kup = tau > 0 ? kL : kR;
        const Ms = (h[kup] * h[kup]) / (2 * mu[kup]);
        const q = -Mf * (p[kR] - p[kL]) / dist + Mg * rho * gpf + Ms * tau;
        const ua = (rho * gpf * h[gpf > 0 ? kL : kR] ** 2) / mu[gpf > 0 ? kL : kR] + (tau * h[kup]) / mu[kup];
        this.uP[kL] = ua * dsR[i];
        const v = Math.abs(Mg * rho * gpf + Ms * tau) / h[kup];
        if (v > vmax) vmax = v;
        addFlux(kL, kR, q * dsR[i]); FpE[kL] = q * dsR[i];
      }
    }
    let inflow = 0;
    for (let k = 0; k < N; k++) {
      if (this.mask[k]) { if (this.mask[k] === 1) inflow += R[k]; R[k] = 0; Rm[k] = 0; continue; }
      R[k] = R[k] / area[k] + this.src[k];
      Rm[k] = Rm[k] / area[k] + this.src[k] * this.srcPhi;
    }
    this.maskInflowRate = inflow; // m^3/s of film liquid flowing into held (bath / plug) cells
    return vmax;
  }

  // Assemble and solve one implicit line operator (I - dt J) x = r in place.
  // idx: cell indices along the line; cl: Laplacian face conductances (face f between f and f+1)
  // Written without closures or per-entry dispatch (it was ~40% of the run time): the capillary
  // pressure stencil P_k = Pm_k x_k-1 + P0_k x_k + Pp_k x_k+1 is precomputed per cell, and every
  // band entry is added to its band directly, in the same order and with the same arithmetic as
  // before, so the results are bit-identical.
  _lineSolve(idx, n, periodic, cl, gm, gd, ua, Aa, r, solver) {
    const a = this.la, b = this.lb, c = this.lc, d = this.ld, e = this.le;
    const gam = this.gamma, dt = this.dt, mask = this.mask;
    a.fill(0, 0, n); b.fill(0, 0, n); c.fill(0, 0, n); d.fill(0, 0, n); e.fill(0, 0, n);
    if (!this._pm || this._pm.length < this.la.length) {
      const L = this.la.length; this._pm = new Float64Array(L); this._p0 = new Float64Array(L); this._pp = new Float64Array(L);
    }
    const Pm = this._pm, P0 = this._p0, Pp = this._pp;
    // pressure stencil of each cell (faces missing at the ends of an open line carry 0)
    for (let k = 0; k < n; k++) {
      const clL = periodic ? cl[k === 0 ? n - 1 : k - 1] : k > 0 ? cl[k - 1] : 0;
      const clR = periodic || k < n - 1 ? cl[k] : 0;
      Pm[k] = (-gam / Aa[k]) * clL; Pp[k] = (-gam / Aa[k]) * clR; P0[k] = (gam / Aa[k]) * (clL + clR);
    }
    for (let k = 0; k < n; k++) {
      c[k] += 1;
      if (mask[idx[k]]) { r[k] = 0; continue; }
      const s = -dt / Aa[k];
      // Inflow through each face of cell k: gm (P_kn - P_k) + gd (x_kn - x_k);
      // (J x)_k = sum over faces / A_k ; matrix row gets -dt * J.
      // left face (k-1|k), neighbour kn = k-1: its stencil reaches offsets -2..0
      if (periodic || k > 0) {
        const fi = k === 0 ? n - 1 : k - 1, kn = k === 0 ? n - 1 : k - 1;
        const sg = s * gm[fi], g2 = gd[fi];
        if (periodic || kn - 1 >= 0) a[k] += sg * Pm[kn];
        b[k] += -sg * Pm[k];
        b[k] += sg * P0[kn];
        c[k] += -sg * P0[k];
        c[k] += sg * Pp[kn];
        if (periodic || k + 1 < n) d[k] += -sg * Pp[k];
        b[k] += s * g2;
        c[k] += -s * g2;
        const u = ua[fi];
        if (u !== 0) { if (u > 0) b[k] += s * u; else c[k] += s * u; }
      }
      // right face (k|k+1), neighbour kn = k+1: offsets 0..+2
      if (periodic || k < n - 1) {
        const fi = k, kn = k === n - 1 ? 0 : k + 1;
        const sg = s * gm[fi], g2 = gd[fi];
        c[k] += sg * Pm[kn];
        if (periodic || k - 1 >= 0) b[k] += -sg * Pm[k];
        d[k] += sg * P0[kn];
        c[k] += -sg * P0[k];
        if (periodic || kn + 1 < n) e[k] += sg * Pp[kn];
        d[k] += -sg * Pp[k];
        d[k] += s * g2;
        c[k] += -s * g2;
        const u = ua[fi];
        if (u !== 0) { const inflow = -u; if (inflow > 0) d[k] += s * inflow; else c[k] += s * inflow; }
      }
    }
    if (periodic) solver.solveCyclic(a, b, c, d, e, r); else solver.solve(a, b, c, d, e, r);
  }

  // Volume the implicit correction r (the solution of _lineSolve) moved through each face of the
  // line during the step (face f: from f toward f+1), from the same face terms as the matrix rows.
  _lineFlux(n, periodic, cl, gm, gd, ua, Aa, r, fo) {
    const gam = this.gamma, dt = this.dt;
    // inflow into cell f through its right face is gm (P_f+1 − P_f) + gd (x_f+1 − x_f) + upwind
    // advection; row f of the matrix adds dt × that / A_f, so dt × (−inflow) left through the face
    // P_k = (γ/A_k) [clL (x_k − x_k−1) + clR (x_k − x_k+1)], as pc() builds it
    const P = this._Pl || (this._Pl = new Float64Array(this.la.length));
    for (let k = 0; k < n; k++) {
      const clL = periodic || k > 0 ? cl[periodic ? (k - 1 + n) % n : k - 1] : 0, clR = periodic || k < n - 1 ? cl[k] : 0;
      const xm = periodic ? r[(k - 1 + n) % n] : k > 0 ? r[k - 1] : 0, xp = periodic ? r[(k + 1) % n] : k < n - 1 ? r[k + 1] : 0;
      P[k] = (gam / Aa[k]) * (clL * (r[k] - xm) + clR * (r[k] - xp));
    }
    const nf = periodic ? n : n - 1;
    for (let f = 0; f < nf; f++) {
      const f2 = f + 1 === n ? 0 : f + 1, u = ua[f];
      const inflow = gm[f] * (P[f2] - P[f]) + gd[f] * (r[f2] - r[f]) + (u < 0 ? -u * r[f2] : -u * r[f]);
      fo[f] = -dt * inflow;
    }
  }

  // Solids transport for the accepted step. Each face carries the liquid volume that actually
  // crossed it (explicit flux + implicit correction, VsT/VpT, which sum exactly to the transport
  // part of delta). The solids go with it, upwind and implicit in the solids fraction:
  //   φ'_k = (m_k A_k + Σ_in V_f φ'_donor) / (h_k A_k + Σ_in V_f),
  // i.e. the new fraction is a volume-weighted mean of what the cell kept and what flowed in, so
  // it stays between the neighbouring fractions even when a step moves more liquid through a cell
  // than it holds (thick tip films, large implicit steps). Solved by symmetric Gauss–Seidel sweeps
  // (one or two in a draining bore), then applied as face fluxes V_f φ'_donor, so the solids
  // are conserved exactly. The old scheme moved solids with the explicit fluxes only, which in
  // stiff cells differ a lot from what the implicit liquid update moved: the fraction swung
  // between 0 and 1 and the clipping created solids (SAICCS heated: +0.72 µL against 0.53 µL left
  // on the part; oven: +2.6 µL). Result: dM (solids volume change per cell, m³).
  _moveSolids() {
    const geo = this.geo, { Nj, N, area, periodic } = geo;
    const h = this.h, m = this.m, mask = this.mask, Vd = this.isVoid;
    const phi = this.phiO, inV = this.sOut, dM = this.dM, VsT = this.VsT, VpT = this.VpT;
    // usable faces (not cut away, not between two held cells) and the phi-neighbour of each cell
    if (!this._jp) {
      this._jp = new Int32Array(N); this._fS = new Uint8Array(N); this._fP = new Uint8Array(N); this._act = new Int32Array(N);
      for (let k = 0; k < N; k++) { const j = k % Nj; this._jp[k] = j < Nj - 1 ? k + 1 : periodic ? k - Nj + 1 : -1; }
    }
    const JP = this._jp, fS = this._fS, fP = this._fP, act = this._act;
    for (let k = 0; k < N; k++) {
      fS[k] = k + Nj < N && !Vd[k] && !Vd[k + Nj] && !(mask[k] && mask[k + Nj]) && VsT[k] !== 0 ? 1 : 0;
      const k2 = JP[k];
      fP[k] = k2 >= 0 && !Vd[k] && !Vd[k2] && !(mask[k] && mask[k2]) && VpT[k] !== 0 ? 1 : 0;
      phi[k] = h[k] > 0 ? Math.min(1, m[k] / h[k]) : 0; inV[k] = 0;
    }
    for (let k = 0; k < N; k++) {
      if (fS[k]) { const v = VsT[k]; if (v > 0) inV[k + Nj] += v; else inV[k] -= v; }
      if (fP[k]) { const v = VpT[k]; if (v > 0) inV[JP[k]] += v; else inV[k] -= v; }
    }
    // cells whose fraction can change: free film with inflow
    let na = 0;
    for (let k = 0; k < N; k++) if (!mask[k] && !Vd[k] && inV[k] > 0) act[na++] = k;
    const update = (k) => {
      let num = m[k] * area[k];
      const kd = k - Nj; if (kd >= 0 && fS[kd] && VsT[kd] > 0) num += VsT[kd] * phi[kd];
      if (fS[k] && VsT[k] < 0) num -= VsT[k] * phi[k + Nj];
      const j = k % Nj, kl = j > 0 ? k - 1 : periodic ? k + Nj - 1 : -1;
      if (kl >= 0 && fP[kl] && VpT[kl] > 0) num += VpT[kl] * phi[kl];
      if (fP[k] && VpT[k] < 0) num -= VpT[k] * phi[JP[k]];
      const pn = Math.min(1, Math.max(0, num / (h[k] * area[k] + inV[k]))), ch = Math.abs(pn - phi[k]);
      phi[k] = pn;
      return ch;
    };
    for (let sweep = 0; sweep < 16; sweep++) {
      let ch = 0;
      if (sweep % 2 === 0) { for (let a = 0; a < na; a++) { const c = update(act[a]); if (c > ch) ch = c; } }
      else { for (let a = na - 1; a >= 0; a--) { const c = update(act[a]); if (c > ch) ch = c; } }
      if (ch < 1e-8) break;
    }
    dM.fill(0);
    for (let k = 0; k < N; k++) {
      if (fS[k]) { const v = VsT[k], k2 = k + Nj, S = v > 0 ? v * phi[k] : v * phi[k2]; dM[k] -= S; dM[k2] += S; }
      if (fP[k]) { const v = VpT[k], k2 = JP[k], S = v > 0 ? v * phi[k] : v * phi[k2]; dM[k] -= S; dM[k2] += S; }
    }
  }

  // Advance one step of size this.dt. Returns false if rejected (state restored).
  step(maxRel = 0.25) {
    const geo = this.geo, { Ni, Nj, w, area, periodic } = geo;
    const dsR = this.dsR, dC = this.dC;
    const N = geo.N;
    const h = this.h;
    if (this.dtCap > 0 && this.dt > this.dtCap) this.dt = this.dtCap;
    if (this.voidList.length) this._applyVoid();
    this._anyMask1 = false; for (let k = 0; k < N; k++) if (this.mask[k] === 1) { this._anyMask1 = true; break; }
    const vmax = this._rates();
    // CFL for explicit advection: rates do not depend on dt, so just shorten the step
    if (this._minW === undefined) { let mw = Infinity; for (let i = 0; i < Ni; i++) if (dsR[i] < mw) mw = dsR[i]; for (let k = 0; k < N; k++) if (w[k] < mw) mw = w[k]; this._minW = mw; }
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
    const fo = this._fo || (this._fo = new Float64Array(Math.max(Ni, Nj)));
    const VsT = this.VsT, VpT = this.VpT, FsE = this.FsE, FpE = this.FpE;
    VsT.fill(0); VpT.fill(0);
    for (let j = 0; j < Nj; j++) {
      for (let i = 0; i < ni; i++) {
        const k = i * Nj + j; idx[i] = k; AS[i] = area[k]; r[i] = delta[k];
        if (i < ni - 1) {
          const k2 = k + Nj; const wf = 0.5 * (w[k] + w[k2]);
          const cut = this.isVoid[k] || this.isVoid[k2] ? 0 : 1;
          clS[i] = (cut * wf) / dC[i];
          const Mf = 0.5 * (M[k] + M[k2]);
          gmS[i] = (cut * Mf * wf) / dC[i];
          gdS[i] = (cut * Mf * 0.5 * (D[k] + D[k2]) * wf) / dC[i];
          uaS[i] = cut * this.uS[k];
        }
      }
      this._lineSolve(idx, ni, false, clS, gmS, gdS, uaS, AS, r, this.solverS);
      this._lineFlux(ni, false, clS, gmS, gdS, uaS, AS, r, fo);
      for (let i = 0; i < ni; i++) delta[idx[i]] = r[i];
      for (let i = 0; i < ni - 1; i++) VsT[idx[i]] = dt * FsE[idx[i]] + fo[i];
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
          const cut = this.isVoid[k] || this.isVoid[k2] ? 0 : 1;
          clP[j] = (cut * dsR[i]) / dist;
          const Mf = 0.5 * (M[k] + M[k2]);
          gmP[j] = (cut * Mf * dsR[i]) / dist;
          gdP[j] = (cut * Mf * 0.5 * (D[k] + D[k2]) * dsR[i]) / dist;
          uaP[j] = cut * this.uP[k];
        }
      }
      this._lineSolve(idxP, nj, periodic, clP, gmP, gdP, uaP, AP, r, this.solverP);
      this._lineFlux(nj, periodic, clP, gmP, gdP, uaP, AP, r, fo);
      for (let j = 0; j < nj; j++) delta[idxP[j]] = r[j];
      for (let j = 0; j < (periodic ? nj : nj - 1); j++) VpT[idxP[j]] = dt * FpE[idxP[j]] + fo[j];
    }
    // --- accept / reject
    let rel = 0;
    const hp = this.hp;
    const cap = this._endCaps();
    for (let k = 0; k < N; k++) {
      if (this.mask[k]) continue;
      let hn = h[k] + delta[k];
      // liquid above what an end cell can keep (cross-jet strip, tip pool) is removed right after
      // the step, so only the part that stays counts toward the step-size control
      if (cap && hn > cap[k]) hn = Math.max(cap[k], h[k]);
      if (!(hn === hn)) { rel = Infinity; this.worst = k; break; }
      // small undershoots ahead of a capillary front are clipped to the precursor (mass tracked)
      if (hn < 0 && -hn > 0.5 * h[k] + 2 * hp) { rel = Infinity; this.worst = k; break; }
      const rr = Math.abs(hn - h[k]) / (h[k] + 20 * hp);
      if (rr > rel) { rel = rr; this.worst = k; }
    }
    if (rel > maxRel) {
      this.dt *= Math.max(0.2, 0.7 * maxRel / rel);
      this.stats.rejected++;
      return false;
    }
    // apply transport
    const m = this.m, c = this.coat;
    this._moveSolids(dt);
    const dM = this.dM;
    let dep = 0;
    for (let k = 0; k < N; k++) {
      if (this.mask[k]) { h[k] = this.hFix[k]; continue; }
      dep += this.src[k] * dt * area[k];
      h[k] += delta[k];
      m[k] += dM[k] / area[k] + dt * this.src[k] * this.srcPhi;
      if (m[k] < 0) { this.stats.solidsClipGain += -m[k] * area[k]; m[k] = 0; }
      if (h[k] < hp) { this.stats.clipped += (hp - h[k]) * area[k]; h[k] = hp; }
      if (m[k] > h[k]) { this.stats.solidsClipLoss += (m[k] - h[k]) * area[k]; m[k] = h[k]; }
    }
    this.stats.deposited += dep;
    // liquid that left the free film into held (plug/bath) cells this step: explicit inflow plus
    // whatever the implicit correction moved across their faces
    if (this._anyMask1) {
      let expect = 0, actual = 0;
      for (let k = 0; k < N; k++) if (!this.mask[k]) { expect += (R[k] - this.src[k]) * dt * area[k]; actual += (delta[k] - this.src[k] * dt) * area[k]; }
      this.maskInflow = (this.maskInflow || 0) + (expect - actual) + (this.maskInflowRate || 0) * dt;
    }
    // evaporation + cure (pointwise)
    const uvI = this.env.uv, Tf = this.Tf, airUf = this.airUf, hc = this.hcAir;
    let evap = 0;
    const needEvap = c.evap0 > 0 && c.solids < c.phiMax;
    const ef = this.evapFac;
    // latent heat of the solvent per m^3 of liquid evaporated [J/m^3]
    const Lvol = ((c.dHvap * 1000) / ((c.solventM || 18) / 1000)) * 950;
    const tau = Math.max(this.tauHeat, 1e-6);
    for (let k = 0; k < N; k++) {
      let qe = 0; // evaporative heat sink [W/m^2]
      if (!this.mask[k]) {
        if (h[k] > 4 * hp) this.wetted[k] = 1;
        if (needEvap && h[k] > 2 * hp) {
          const phi = m[k] / h[k];
          const E = evaporationRate(c, phi, Tf[k], airUf[k], ef[k]);
          const floor = Math.max(hp, m[k] / c.phiMax);
          const dh = Math.min(E * dt, Math.max(0, h[k] - floor));
          h[k] -= dh; evap += dh * area[k];
          qe = (Lvol * dh) / dt;
        }
      }
      // part + film temperature: heated by the air with the wall's thermal lag, cooled by
      // evaporation (a wet film sits near the wet-bulb temperature until it dries)
      const target = this.Tair[k] - qe / Math.max(hc[k], 1);
      Tf[k] = (Tf[k] + (dt / tau) * target) / (1 + dt / tau);
      if (this.mask[k]) continue;
      if (c.cure && c.cure.model !== 'none' && h[k] > 2 * hp) {
        const uvk = this.uvFac ? uvI * this.uvFac[k] : uvI;
        const a = this.alpha[k] + dt * cureRate(c, this.alpha[k], { T: Tf[k], uv: uvk });
        this.alpha[k] = Math.min(1, a);
      }
    }
    this.stats.evaporated += evap;
    this._lastDt = dt;
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
    const endCell = this.geo.endCell;
    for (const side of [0, 1]) {
      for (let j = 0; j < Nj; j++) {
        const i = side === 0 ? 0 : (endCell ? endCell[j] : Ni - 1);
        const k = i * Nj + j;
        if (this.mask[k]) continue;
        const outward = side === 0 ? -this.gs[k] : this.gs[k];
        const tauOut = side === 0 ? -this.tauS[k] : this.tauS[k];
        // air blowing out of an open end strips liquid once drag beats capillary retention
        let lim = Infinity;
        // outside surfaces: a pendant drop detaches once it outgrows the capillary length.
        // (bores are handled by the pool/Tate-volume rule below)
        if (this.geo.surface !== 'inner' && (outward > 0.2 * 9.81 || this.gn[k] > 0)) lim = hMax;
        // (inside a bore the air vents past a pool held at the opening; only cross-jets strip it)
        if (tauOut > 0.05 && this.geo.surface !== 'inner') lim = Math.min(lim, Math.max(5e-6, Math.min(hMax, this.gamma / (200 * tauOut))));
        if (!isFinite(lim)) continue;
        if (this.h[k] > lim) {
          const ex = this.h[k] - lim;
          const frac = this.m[k] / this.h[k];
          this.stats.dripped += ex * area[k];
          this.h[k] = lim; this.m[k] = lim * frac;
        }
      }
    }
    if (this.geo.surface === 'inner') this._tipPool(this._lastDt || 0);
  }

  // Liquid that drains to an open end of a bore collects there as a pool held by surface
  // tension (it cannot be represented as a thin film once it is comparable to the bore radius).
  // The pool keeps its liquid and solids; it drips off only above the drop capillarity can hold
  // (Tate: V ≈ 0.6 · 2π r γ / (ρ g)); a cross-jet removes it if its dynamic pressure beats the
  // capillary hold of the opening (~2γ/r); otherwise it dries in place (tip deposit).
  _tipPool(dt) {
    const { Ni, Nj, area, s, L, edgeEnd, rHyd } = this.geo;
    const g = 9.81;
    if (!this.pool) this.pool = [{ V: 0, M: 0 }, { V: 0, M: 0 }];
    for (const side of [0, 1]) {
      const P = this.pool[side];
      const iEnd = side === 0 ? 0 : Ni - 1;
      const kRef = iEnd * Nj;
      const gOut = side === 0 ? -this.gs[kRef] : this.gs[kRef];
      const r = rHyd[iEnd];
      const reach = this.poolReach(side);
      const hCap = 0.25 * r;
      // liquid beyond hCap in the end region joins the pool (only where gravity pulls toward the end)
      if (gOut > 0.2 * g) {
        for (let i = 0; i < Ni; i++) for (let j = 0; j < Nj; j++) {
          const k = i * Nj + j;
          if (this.mask[k]) continue;
          const d = side === 0 ? s[i] : (edgeEnd ? edgeEnd[k] : L - s[i]);
          if (d < 0 || d > reach || this.h[k] <= hCap) continue;
          const ex = this.h[k] - hCap, frac = this.m[k] / this.h[k];
          P.V += ex * area[k]; P.M += ex * frac * area[k];
          this.h[k] = hCap; this.m[k] = hCap * frac;
        }
      }
      if (P.V <= 0) continue;
      // evaporation from the pool's free surface (about two bore cross-sections)
      const c = this.coat;
      if (c.evap0 > 0 && c.solids < c.phiMax) {
        const phi = P.M / P.V;
        const E = evaporationRate(c, phi, this.Tf[kRef], this.airUf[kRef], 1);
        const Afree = 2 * Math.PI * r * r;
        const dV = Math.min(E * dt * Afree, Math.max(0, P.V - P.M / c.phiMax));
        P.V -= dV; this.stats.evaporated += dV;
      }
      // cross-jet over this opening blows the pool out if it overcomes the capillary hold
      const es = this.endStrip;
      if (es && (es.end === 'start') === (side === 0) && es.pDyn > (2 * this.gamma) / r) {
        this.stats.dripped += P.V; P.V = 0; P.M = 0; continue;
      }
      // drips off once larger than the drop capillarity can hold
      if (gOut > 0.2 * g) {
        const Vt = (0.6 * 2 * Math.PI * r * this.gamma) / (this.rho * gOut);
        if (P.V > Vt) { const f = Vt / P.V; this.stats.dripped += P.V - Vt; P.M *= f; P.V = Vt; }
      }
    }
  }

  // End region whose excess joins the pool: three nominal cells (L/ns, so the pool physics does
  // not change with tip refinement) plus the bevel's cut-away length.
  poolReach(side) {
    const { ds, L, sE } = this.geo;
    if (side === 0 || !this.geo.hasVoid) return 3 * ds;
    let maxCut = 0;
    for (const e of this.geo.endCell) maxCut = Math.max(maxCut, this.geo.uniform ? (this.geo.Ni - 1 - e) * ds : L - sE[e + 1]);
    return 3 * ds + maxCut;
  }

  // Per-cell ceiling on the film at the open ends, from the same rules as _crossStrip (the
  // cross-jet keeps at most es.lim within es.reach) and _tipPool (in a bore, gravity carries any
  // film above hCap = r/4 in the end region into the pool). null when no end removes liquid.
  _endCaps() {
    const geo = this.geo, { Ni, Nj, s, L, edgeEnd } = geo, es = this.endStrip;
    const inner = geo.surface === 'inner', g = 9.81;
    const poolSides = inner && this.dripEnabled ? [0, 1].filter((side) => (side === 0 ? -this.gs[0] : this.gs[(Ni - 1) * Nj]) > 0.2 * g) : [];
    if (!es && !poolSides.length) return null;
    const cap = this._cap || (this._cap = new Float64Array(geo.N));
    cap.fill(Infinity);
    const dist = (side, i, k) => (side === 0 ? s[i] : (edgeEnd ? edgeEnd[k] : L - s[i]));
    for (const side of poolSides) {
      const reach = this.poolReach(side), hCap = 0.25 * geo.rHyd[side === 0 ? 0 : Ni - 1];
      for (let i = 0; i < Ni; i++) for (let j = 0; j < Nj; j++) {
        const k = i * Nj + j, d = dist(side, i, k);
        if (d >= 0 && d <= reach && hCap < cap[k]) cap[k] = hCap;
      }
    }
    if (es) {
      const side = es.end === 'start' ? 0 : 1;
      for (let i = 0; i < Ni; i++) for (let j = 0; j < Nj; j++) {
        const k = i * Nj + j;
        if (dist(side, i, k) <= es.reach && es.lim < cap[k]) cap[k] = es.lim;
      }
    }
    return cap;
  }

  poolVolume() { return this.pool ? this.pool[0].V + this.pool[1].V : 0; }

  // Horizontal cross-jet across an opening strips liquid within `reach` of that end.
  _crossStrip() {
    const es = this.endStrip; if (!es) return;
    const { Ni, Nj, s, L, area, edgeEnd } = this.geo;
    for (let i = 0; i < Ni; i++) {
      for (let j = 0; j < Nj; j++) {
        const k = i * Nj + j;
        const d = es.end === 'start' ? s[i] : (edgeEnd ? edgeEnd[k] : L - s[i]);
        if (d > es.reach || this.isVoid[k]) continue;
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

