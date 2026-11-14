// Process orchestration: runs a sequence of process stages (plasma, dip, spray, drip,
// vacuum withdraw, airflow, flash/dwell, cure) on one FilmSolver, recording frames and
// time histories for visualisation.

import { buildGeometry, gravityBody } from './geometry.js';
import { FilmSolver } from './film.js';
import { resolveCoating, resolveSubstrate, activatedSubstrate, contactAngleOWRK, wenzel } from './materials.js';
import { dipFilmOuter, brethertonFilm, capillaryLength, ellipseResistance, viscosity, G0 } from './physics.js';
import { computeMetrics } from './metrics.js';

const AIR_RHO = 1.2, AIR_MU = 1.8e-5;

export const STAGE_TYPES = ['plasma', 'dip', 'spray', 'drip', 'vacuum', 'airflow', 'dwell', 'cure'];

// Default parameters for each stage type (lengths mm, speeds mm/s unless noted).
export const STAGE_DEFAULTS = {
  plasma: { duration: 20, power: 1.0, holdMinutes: 5, penetrationMm: 6, fromEnd: 'both', tempC: 25, tilt: 90, rpm: 0, ambientAir: 0 },
  dip: { speed: 2, immersionMm: 1e9, dwell: 5, drainAfter: 30, tempC: 25, tilt: 0, rpm: 0, ambientAir: 0 },
  spray: { flowMlMin: 2, transferEff: 0.7, standoffMm: 40, coneDeg: 30, traverseMmS: 20, passes: 4, startMm: 0, endMm: 1e9, clockDeg: 90, inFlightEvapPct: 20, lanceSigmaMm: 2, tempC: 25, tilt: 90, rpm: 60, ambientAir: 0, drainAfter: 10 },
  drip: { mode: 'drops', lines: 1, dropUl: 5, count: 3, interval: 2, startMm: 5, endMm: 5, clockDeg: null, beadUlS: 2, needleMmS: 5, tempC: 25, tilt: 90, rpm: 0, ambientAir: 0, drainAfter: 20 },
  vacuum: { pressureKpa: 5, fillLengthMm: 1e9, fromEnd: 'start', direction: 'through', maxSpeedMmS: 0, airTime: 10, tempC: 25, tilt: 90, rpm: 0, ambientAir: 0 },
  airflow: { duration: 20, nozzleSpeed: 10, angleDeg: 0, offsetMm: 0, fromEnd: 'start', airTempC: 25, crossJetSpeed: 0, crossJetEnd: 'end', crossJetReachMm: 3, tempC: 25, tilt: 90, rpm: 0, ambientAir: 0 },
  dwell: { duration: 60, tempC: 25, tilt: 90, rpm: 0, ambientAir: 0 },
  cure: { duration: 300, mode: 'thermal', tempC: 100, uvIntensity: 100, uvTransmission: 0.6, tilt: 0, rpm: 0, ambientAir: 0.3 },
};

export function withDefaults(stage) { return { ...STAGE_DEFAULTS[stage.type], ...stage }; }

function airShear(U, D) {
  if (!(U > 0)) return 0;
  const Re = (AIR_RHO * U * D) / AIR_MU;
  const f = Re < 2300 ? 16 / Math.max(Re, 1e-9) : 0.079 * Math.pow(Re, -0.25);
  return f * 0.5 * AIR_RHO * U * U;
}

function th(ctx) { return ctx.thetaMean || 0.5; }

function sphericalCapRadius(V, theta) {
  const th = Math.min(Math.max(theta, 0.15), Math.PI / 2);
  const c = Math.cos(th), s = Math.sin(th);
  return Math.cbrt((3 * V * s * s * s) / (Math.PI * (2 - 3 * c + c * c * c)));
}

// Liquid plug inside a lumen whose trailing meniscus deposits a Bretherton film.
class Plug {
  constructor(ctx, rear, dir, V) {
    this.ctx = ctx; this.rear = rear; this.dir = dir; this.V = V;
    this.stuck = false; this.done = false; this.speed = 0; this.exited = 0;
  }
  front() {
    const { cumA, L } = this.ctx;
    const target = this.dir > 0 ? cumA(this.rear) + this.V : cumA(this.rear) - this.V;
    const sf = this.ctx.invCumA(target);
    return Math.max(0, Math.min(L, sf));
  }
}

export function makeContext(spec) {
  const geo = buildGeometry(spec);
  const coat = resolveCoating(spec);
  const sub = resolveSubstrate(spec);
  const fs = new FilmSolver(geo, coat, { precursor: (spec.precursorUm || 0.05) * 1e-6, tauHeat: spec.heatUpSeconds || 30 });
  const ctx = { spec, geo, coat, sub, fs, act: new Float64Array(geo.N), holdHours: 0 };
  // cumulative cross-section area along the lumen (for plug kinematics)
  const { Ni, ds, crossArea } = geo;
  const edges = new Float64Array(Ni + 1);
  for (let i = 0; i < Ni; i++) edges[i + 1] = edges[i] + crossArea[i] * ds;
  ctx.L = geo.L;
  ctx.cumA = (s) => {
    const x = Math.max(0, Math.min(geo.L, s)) / ds;
    const i = Math.min(Ni - 1, Math.floor(x));
    return edges[i] + (x - i) * (edges[i + 1] - edges[i]);
  };
  ctx.invCumA = (v) => {
    if (v <= 0) return v / Math.max(crossArea[0], 1e-12);
    if (v >= edges[Ni]) return geo.L + (v - edges[Ni]) / Math.max(crossArea[Ni - 1], 1e-12);
    let lo = 0, hi = Ni;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (edges[mid] <= v) lo = mid; else hi = mid; }
    return (lo + (v - edges[lo]) / (edges[lo + 1] - edges[lo])) * ds;
  };
  ctx.iOf = (s) => Math.max(0, Math.min(Ni - 1, Math.floor(s / ds)));
  updateWetting(ctx);
  return ctx;
}

export function updateWetting(ctx) {
  const { geo, coat, sub, fs, act } = ctx;
  const r = ctx.spec.roughness || 1;
  const field = new Float64Array(geo.N);
  let sum = 0;
  for (let k = 0; k < geo.N; k++) {
    const s2 = activatedSubstrate(sub, act[k], ctx.holdHours);
    field[k] = wenzel(contactAngleOWRK(s2, coat), r);
    sum += field[k];
  }
  // the thin-film model needs a finite angle; clamp to [1°, 150°]
  for (let k = 0; k < geo.N; k++) field[k] = Math.min(Math.max(field[k], 0.0175), 2.6);
  fs.setContactAngle(0, field);
  ctx.thetaMean = sum / geo.N;
  ctx.thetaField = field;
}

function lumenEvapFactor(ctx, airInLumen) {
  const { geo, fs } = ctx;
  const ef = fs.evapFac;
  if (geo.surface !== 'inner' || airInLumen) { ef.fill(1); return; }
  for (let i = 0; i < geo.Ni; i++) {
    const d = Math.min(geo.s[i], geo.L - geo.s[i]);
    const f = 1 / (1 + d / (3 * geo.rHyd[i]));
    for (let j = 0; j < geo.Nj; j++) ef[i * geo.Nj + j] = f;
  }
}

// Set gravity, temperature etc. for this step. Handles part rotation.
function applyEnv(ctx, st, t0) {
  const fs = ctx.fs;
  fs.env.T = (st.tempC ?? 25) + 273.15;
  if (!ctx._airTField) fs.Tair.fill(fs.env.T);
  const omega = ((st.rpm || 0) * 2 * Math.PI) / 60;
  fs.dtCap = 0;
  if (omega > 0) {
    // Resolve the rotation (rimming flow, drag-out of puddles) while the film is mobile;
    // once the film moves negligibly per revolution, use the rotation-averaged gravity.
    const { h, mu, hp, rho } = fs;
    let vg = 0;
    for (let k = 0; k < h.length; k++) if (h[k] > 4 * hp && !fs.mask[k]) { const v = (rho * G0 * h[k] * h[k]) / (mu[k] || ctx.coat.mu0); if (v > vg) vg = v; }
    if (fs._minW === undefined) { let mw = fs.geo.ds; for (const x of fs.geo.w) if (x < mw) mw = x; fs._minW = mw; }
    if (vg * ((2 * Math.PI) / omega) > 0.02 * fs._minW) {
      fs.dtCap = 0.25 / omega;
      if (fs.dt > fs.dtCap) fs.dt = fs.dtCap;
      fs.setGravity(gravityBody(st.tilt || 0, omega * (fs.t - t0 + 0.5 * fs.dt)));
    } else {
      const b = ((st.tilt || 0) * Math.PI) / 180;
      fs.setGravity([0, 0, G0 * Math.cos(b)]);
    }
  } else {
    fs.setGravity(gravityBody(st.tilt || 0, 0));
  }
}

function clearFields(fs) { fs.src.fill(0); fs.tauS.fill(0); fs.tauP.fill(0); fs.env.uv = 0; fs.env.airU = 0; }

function freshLiquid(ctx, k, h) {
  const fs = ctx.fs, c = ctx.coat;
  fs.h[k] = Math.max(h, fs.hp); fs.m[k] = fs.h[k] * c.solids; fs.alpha[k] = 0;
}

function fmtMm(m) { return (m * 1e3).toFixed(1) + ' mm'; }

// Liquid column held in a lumen by capillarity: kept as a filled (masked) region.
function trapLiquid(ctx, a, b) {
  const { geo, fs, coat } = ctx;
  ctx.trapped = { a, b };
  for (let i = 0; i < geo.Ni; i++) {
    if (geo.s[i] < a - 0.5 * geo.ds || geo.s[i] > b + 0.5 * geo.ds) continue;
    for (let j = 0; j < geo.Nj; j++) {
      const k = i * geo.Nj + j;
      fs.mask[k] = 1; fs.hFix[k] = geo.rHyd[i]; fs.h[k] = geo.rHyd[i]; fs.m[k] = geo.rHyd[i] * coat.solids; fs.alpha[k] = 0;
    }
  }
}
function isTrappedCell(ctx, i) { const t = ctx.trapped; return !!t && ctx.geo.s[i] >= t.a - 0.5 * ctx.geo.ds && ctx.geo.s[i] <= t.b + 0.5 * ctx.geo.ds; }

// ---------------------------------------------------------------- stages
const STAGES = {};

STAGES.plasma = {
  setup(ctx, st) {
    const { geo } = ctx;
    const lam = Math.max(0.1, st.penetrationMm) * 1e-3;
    for (let i = 0; i < geo.Ni; i++) {
      let f = 1;
      if (geo.surface === 'inner') {
        const d0 = geo.s[i], d1 = geo.L - geo.s[i];
        const e0 = Math.exp(-d0 / lam), e1 = Math.exp(-d1 / lam);
        f = st.fromEnd === 'start' ? e0 : st.fromEnd === 'end' ? e1 : Math.min(1, e0 + e1);
      }
      const dose = Math.min(1, st.duration / 20); // ~20 s gives saturation
      for (let j = 0; j < geo.Nj; j++) {
        const k = i * geo.Nj + j;
        ctx.act[k] = Math.max(ctx.act[k], st.power * dose * f);
      }
    }
    ctx.holdHours = (st.holdMinutes || 0) / 60;
    updateWetting(ctx);
    return { duration: st.duration };
  },
};

STAGES.dwell = { setup(ctx, st) { return { duration: st.duration }; } };

STAGES.cure = {
  setup(ctx, st) {
    return { duration: st.duration, airU: st.ambientAir };
  },
  hook(ctx, st) {
    const fs = ctx.fs;
    if (st.mode === 'uv') {
      fs.env.uv = st.uvIntensity;
      if (!fs.uvFac) fs.uvFac = new Float32Array(ctx.geo.N);
      fs.uvFac.fill(ctx.geo.surface === 'inner' ? st.uvTransmission : 1);
    }
  },
};

STAGES.airflow = {
  setup(ctx, st) {
    const { geo, fs } = ctx;
    const tauS = new Float64Array(geo.N), tauP = new Float64Array(geo.N);
    const eff = Math.max(0, Math.cos((st.angleDeg * Math.PI) / 180));
    const dir = st.fromEnd === 'end' ? -1 : 1;
    let airMax = 0, Uin0 = 0;
    if (geo.surface === 'inner') {
      const i0 = dir > 0 ? 0 : geo.Ni - 1;
      const Rin = Math.sqrt(geo.A[i0] * geo.B[i0]);
      const capture = 0.7 * Math.exp(-Math.pow((st.offsetMm * 1e-3) / Rin, 2));
      const Uin = st.nozzleSpeed * eff * capture;
      Uin0 = Uin;
      for (let i = 0; i < geo.Ni; i++) {
        const U = (Uin * geo.crossArea[i0]) / geo.crossArea[i]; // continuity: accelerates in a taper
        const tau = airShear(U, 2 * geo.rHyd[i]) * dir;
        airMax = Math.max(airMax, U);
        for (let j = 0; j < geo.Nj; j++) tauS[i * geo.Nj + j] = tau;
      }
    } else {
      // air knife along the axis on the outside; strongest on the windward side
      const U = st.nozzleSpeed * eff * Math.exp(-Math.pow(st.offsetMm / 20, 2));
      airMax = U;
      for (let k = 0; k < geo.N; k++) tauS[k] = 0.0035 * AIR_RHO * U * U * dir;
    }
    ctx._air = { tauS, tauP, airMax, plug: null, Uin0 };
    // ---- heated air: local air temperature along the part
    const Tamb = (st.tempC ?? 25) + 273.15;
    const Tjet = (st.airTempC ?? st.tempC ?? 25) + 273.15;
    ctx._airTField = true;
    if (geo.surface === 'inner' && st.nozzleSpeed > 0) {
      // the air cools as it gives heat to the wall: T = Tamb + (Tjet - Tamb) exp(-x / Lth),
      // Lth = m_dot cp / (h P) with fully developed laminar (Nu = 3.66) or Dittus–Boelter h
      const i0 = dir > 0 ? 0 : geo.Ni - 1;
      const Q = ctx._air.Uin0 * geo.crossArea[i0];
      let x = 0;
      for (let ii = 0; ii < geo.Ni; ii++) {
        const i = dir > 0 ? ii : geo.Ni - 1 - ii;
        const D = 2 * geo.rHyd[i], U = Q / geo.crossArea[i];
        const Re = (AIR_RHO * U * D) / AIR_MU;
        const Nu = Re < 2300 ? 3.66 : 0.023 * Math.pow(Re, 0.8) * Math.pow(0.7, 0.4);
        const hc = (Nu * 0.026) / D;
        const Lth = (AIR_RHO * Q * 1005) / Math.max(hc * geo.perim[i], 1e-12);
        const T = Tamb + (Tjet - Tamb) * Math.exp(-x / Math.max(Lth, 1e-9));
        for (let j = 0; j < geo.Nj; j++) fs.Tair[i * geo.Nj + j] = T;
        x += geo.ds;
      }
    } else {
      fs.Tair.fill(st.nozzleSpeed > 0 ? Tjet : Tamb);
    }
    // ---- horizontal cross-jet across an opening: strips excess liquid near that end
    fs.endStrip = null;
    if ((st.crossJetSpeed || 0) > 0 && st.crossJetEnd && st.crossJetEnd !== 'none') {
      const reach = Math.max((st.crossJetReachMm ?? 3) * 1e-3, geo.ds);
      const tauX = 0.0035 * AIR_RHO * st.crossJetSpeed * st.crossJetSpeed;
      fs.endStrip = { end: st.crossJetEnd, reach, lim: Math.max(2e-6, fs.gamma / (200 * Math.max(tauX, 1e-6))) };
    }
    if (ctx.trapped && geo.surface === 'inner') {
      const i0 = dir > 0 ? 0 : geo.Ni - 1;
      const Rin = Math.sqrt(geo.A[i0] * geo.B[i0]);
      const Uin = st.nozzleSpeed * eff * 0.7 * Math.exp(-Math.pow((st.offsetMm * 1e-3) / Rin, 2));
      const { a, b } = ctx.trapped;
      const plug = new Plug(ctx, dir > 0 ? a : b, dir, Math.abs(ctx.cumA(b) - ctx.cumA(a)));
      plug.maxSpeed = 0; plug.pAir = 0.5 * AIR_RHO * Uin * Uin;
      ctx._air.plug = plug; ctx.trapped = null;
    }
    return { duration: st.duration, airU: airMax, airInLumen: geo.surface === 'inner' };
  },
  hook(ctx, st, tl) {
    const fs = ctx.fs, plug = ctx._air.plug;
    if (plug && !plug.done) {
      // air jet stagnation pressure pushes the retained liquid plug out of the lumen
      plugStep(ctx, plug, fs.dt, (p, len) => p.pAir + ctx.coat.rho * fs.env.g[2] * len * p.dir);
      ctx.aux = { meniscus: plug.rear, front: plug.front(), speed: plug.speed };
      if (plug.stuck && tl > 1) {
        plug.done = true;
        const sf = plug.front();
        trapLiquid(ctx, Math.min(plug.rear, sf), Math.max(plug.rear, sf));
        ctx.warnings.push(`Airflow (stagnation pressure ${plug.pAir.toFixed(0)} Pa) is too weak to blow out the liquid trapped in the lumen.`);
      }
      return;
    }
    fs.tauS.set(ctx._air.tauS);
  },
  dtMax(ctx) { const p = ctx._air?.plug; return p && !p.done ? Math.max(ctx.geo.ds / Math.max(p.speed, 1e-4) * 0.5, 1e-4) : 5; },
};

STAGES.spray = {
  setup(ctx, st) {
    const { geo } = ctx;
    const Lmm = geo.L * 1e3;
    const a = Math.max(0, Math.min(Lmm, st.startMm)), b = Math.max(0, Math.min(Lmm, st.endMm));
    const span = Math.max(Math.abs(b - a), 1e-3);
    const passTime = span / st.traverseMmS;
    const sprayTime = passTime * st.passes;
    const c = ctx.coat;
    const fe = Math.min(0.95, (st.inFlightEvapPct || 0) / 100);
    ctx.fs.srcPhi = Math.min(c.phiMax, c.solids / (1 - fe * (1 - c.solids)));
    ctx._spray = { a: a * 1e-3, b: b * 1e-3, passTime, sprayTime, liquidRate: (st.flowMlMin * 1e-6 / 60) * st.transferEff * (1 - fe * (1 - c.solids)) };
    return { duration: sprayTime + (st.drainAfter || 0) };
  },
  nozzleS(ctx, tl) {
    const sp = ctx._spray;
    if (tl > sp.sprayTime) return null;
    const p = tl / sp.passTime;
    const n = Math.floor(p), f = p - n;
    const u = n % 2 === 0 ? f : 1 - f;
    return sp.a + (sp.b - sp.a) * u;
  },
  hook(ctx, st, tl) {
    const { geo, fs } = ctx;
    const sp = ctx._spray;
    fs.src.fill(0);
    const sN = this.nozzleS(ctx, tl + 0.5 * fs.dt);
    ctx.aux = { nozzle: sN };
    if (sN === null) return;
    const Q = sp.liquidRate;
    if (geo.surface === 'inner') {
      const sig = Math.max(st.lanceSigmaMm * 1e-3, geo.ds);
      for (let i = 0; i < geo.Ni; i++) {
        const g = Math.exp(-0.5 * ((geo.s[i] - sN) / sig) ** 2) / (Math.sqrt(2 * Math.PI) * sig);
        const flux = (Q * g) / geo.perim[i];
        for (let j = 0; j < geo.Nj; j++) fs.src[i * geo.Nj + j] = flux;
      }
      return;
    }
    const sig = Math.max((st.standoffMm * 1e-3 * Math.tan((st.coneDeg * Math.PI) / 360)) / 2, geo.ds);
    const omega = ((st.rpm || 0) * 2 * Math.PI) / 60;
    const K = omega > 0 ? Math.min(24, Math.max(1, Math.ceil((omega * fs.dt) / 0.25))) : 1;
    const w = Q / (2 * Math.PI * sig * sig) / K;
    const { pos, nrm } = geo;
    for (let q = 0; q < K; q++) {
      const psi = omega * (tl + ((q + 0.5) / K) * fs.dt);
      const ang = (st.clockDeg * Math.PI) / 180 - psi;
      const dx = geo.flat ? 0 : Math.cos(ang), dy = geo.flat ? 1 : Math.sin(ang);
      for (let k = 0; k < geo.N; k++) {
        const inc = nrm[3 * k] * dx + nrm[3 * k + 1] * dy;
        if (inc <= 0) continue;
        const xt = -pos[3 * k] * dy + pos[3 * k + 1] * dx;
        const i = Math.floor(k / geo.Nj);
        const r2 = (geo.s[i] - sN) ** 2 + xt * xt;
        fs.src[k] += w * Math.exp(-0.5 * r2 / (sig * sig)) * inc;
      }
    }
  },
};

STAGES.drip = {
  setup(ctx, st) {
    const { geo } = ctx;
    const Lmm = geo.L * 1e3;
    const a = Math.max(0, Math.min(Lmm, st.startMm)) * 1e-3, b = Math.max(0, Math.min(Lmm, st.endMm)) * 1e-3;
    let applyTime;
    if (st.mode === 'bead') applyTime = Math.max(Math.abs(b - a) * 1e3 / st.needleMmS, 0.5);
    else applyTime = (st.count - 1) * st.interval + 0.01;
    ctx._drip = { a, b, applyTime, next: 0 };
    return { duration: applyTime + (st.drainAfter || 0) };
  },
  clockAngle(ctx, st) {
    if (st.clockDeg !== null && st.clockDeg !== undefined && st.clockDeg !== '') return (st.clockDeg * Math.PI) / 180;
    const g = ctx.fs.env.g;
    const down = Math.atan2(g[1], g[0]);
    if (Math.hypot(g[0], g[1]) < 1e-6) return Math.PI / 2;
    return ctx.geo.surface === 'inner' ? down : down + Math.PI; // lowest point inside, top outside
  },
  deposit(ctx, st, s0, V, rbOverride) {
    const n = Math.max(1, Math.round(st.lines || 1));
    if (n > 1 && !ctx.geo.flat) {
      // several needles / beads spaced evenly around the bore
      const a0 = this.clockAngle(ctx, st);
      for (let q = 0; q < n; q++) this.depositAt(ctx, st, s0, V / n, rbOverride, a0 + (2 * Math.PI * q) / n);
      return;
    }
    this.depositAt(ctx, st, s0, V, rbOverride, this.clockAngle(ctx, st));
  },
  depositAt(ctx, st, s0, V, rbOverride, ang) {
    const { geo, fs } = ctx;
    const th = ctx.thetaMean || 0.5;
    const rb = Math.max(rbOverride || sphericalCapRadius(V, th), 1.5 * geo.ds);
    const sig = rb / 2;
    let px, py;
    if (geo.flat) { px = 0; py = 0; } else {
      const i = ctx.iOf(s0);
      px = geo.A[i] * Math.cos(ang); py = geo.B[i] * Math.sin(ang);
    }
    const wts = new Float64Array(geo.N);
    let tot = 0;
    for (let k = 0; k < geo.N; k++) {
      const i = Math.floor(k / geo.Nj);
      const d2 = (geo.s[i] - s0) ** 2 + (geo.pos[3 * k] - px) ** 2 + (geo.pos[3 * k + 1] - py) ** 2;
      if (d2 > 16 * sig * sig) continue;
      const wv = Math.exp(-0.5 * d2 / (sig * sig)) * geo.area[k];
      wts[k] = wv; tot += wv;
    }
    if (tot <= 0) return;
    for (let k = 0; k < geo.N; k++) {
      if (!wts[k]) continue;
      const dh = (V * wts[k]) / tot / geo.area[k];
      fs.h[k] += dh; fs.m[k] += dh * ctx.coat.solids;
    }
    fs.stats.deposited += V;
  },
  hook(ctx, st, tl) {
    const { fs } = ctx;
    const dp = ctx._drip;
    fs.src.fill(0);
    if (st.mode === 'bead') {
      if (tl > dp.applyTime) { ctx.aux = {}; return; }
      const u = Math.min(1, tl / dp.applyTime);
      const s0 = dp.a + (dp.b - dp.a) * u;
      ctx.aux = { nozzle: s0 };
      // continuous bead: deposit the volume dispensed during this step
      // bead cross-section = dispense rate / needle speed; footprint ~ its width
      const Abead = (st.beadUlS * 1e-9) / Math.max(st.needleMmS * 1e-3, 1e-6);
      const rb = Math.max(1.5 * Math.sqrt(Abead / Math.max(Math.sin(Math.min(th(ctx), 1.2)), 0.3)), 0);
      this.deposit(ctx, st, s0, st.beadUlS * 1e-9 * fs.dt, rb);
      return;
    }
    while (dp.next < st.count && tl >= dp.next * st.interval - 1e-9) {
      const u = st.count > 1 ? dp.next / (st.count - 1) : 0;
      const s0 = dp.a + (dp.b - dp.a) * u;
      this.deposit(ctx, st, s0, st.dropUl * 1e-9);
      ctx.aux = { nozzle: s0 };
      dp.next++;
    }
  },
  dtMax(ctx, st) { return st.mode === 'bead' ? 0.05 : st.interval / 4; },
};

// --- liquid-plug based processes (inner surfaces)
function plugStep(ctx, plug, dt, drive) {
  const { geo, fs, coat } = ctx;
  if (plug.done) return;
  const sf = plug.front();
  const lo = Math.min(plug.rear, sf), hi = Math.max(plug.rear, sf);
  const iR = ctx.iOf(plug.rear);
  const mu = viscosity(coat, coat.solids, 0, fs.Tf[ctx.iOf(plug.rear) * geo.Nj]);
  // viscous resistance of the plug
  let Rv = 0;
  for (let i = ctx.iOf(lo); i <= ctx.iOf(hi); i++) Rv += ellipseResistance(mu, geo.A[i], geo.B[i]) * geo.ds;
  const frontInside = plug.dir > 0 ? sf < geo.L - 1e-9 : sf > 1e-9;
  const gamma = fs.gamma;
  const cth = Math.cos(ctx.thetaMean);
  const pcRear = (2 * gamma * cth) / geo.rHyd[iR];
  const pcFront = frontInside ? (2 * gamma * cth) / geo.rHyd[ctx.iOf(sf)] : 0;
  const dP = drive(plug, hi - lo) - pcRear + pcFront;
  let U0 = dP > 0 ? dP / Rv / geo.crossArea[iR] : 0;
  if (U0 < 1e-7) { plug.stuck = true; plug.speed = 0; } // balanced by capillarity (creeping < 0.1 µm/s)
  else {
    plug.stuck = false;
    let U = U0;
    if (plug.maxSpeed > 0) U = Math.min(U, plug.maxSpeed);
    plug.speed = U;
    const ds = U * dt * plug.dir;
    const old = plug.rear;
    plug.rear = Math.max(0, Math.min(geo.L, plug.rear + ds));
    // film deposited behind the rear meniscus
    const i0 = ctx.iOf(old), i1 = ctx.iOf(plug.rear);
    const hB = brethertonFilm(geo.rHyd[i1], mu, U, gamma);
    plug.hDep = hB;
    let used = 0;
    if (i1 !== i0) {
      const step = plug.dir;
      for (let i = i0; i !== i1; i += step) {
        for (let j = 0; j < geo.Nj; j++) {
          const k = i * geo.Nj + j;
          fs.mask[k] = 0; freshLiquid(ctx, k, hB); used += fs.h[k] * geo.area[k];
        }
      }
    }
    // swept volume from rear motion is pushed forward; deposited film is lost from plug
    plug.V -= used;
    const sfNew = plug.front();
    const sfRaw = ctx.invCumA(plug.dir > 0 ? ctx.cumA(plug.rear) + plug.V : ctx.cumA(plug.rear) - plug.V);
    if ((plug.dir > 0 && sfRaw > geo.L) || (plug.dir < 0 && sfRaw < 0)) {
      const vmax = plug.dir > 0 ? ctx.cumA(geo.L) - ctx.cumA(plug.rear) : ctx.cumA(plug.rear);
      plug.exited += plug.V - vmax; plug.V = vmax;
    }
    void sfNew;
    if (plug.V <= 1e-15 || (plug.dir > 0 ? plug.rear >= geo.L - 1e-9 : plug.rear <= 1e-9)) plug.done = true;
  }
  // mask the cells occupied by the plug
  const sf2 = plug.front();
  const a = Math.min(plug.rear, sf2), b = Math.max(plug.rear, sf2);
  const mu2 = mu;
  const hFix = Math.max(plug.hDep || brethertonFilm(geo.rHyd[iR], mu2, 1e-4, gamma), 4 * fs.hp);
  for (let i = 0; i < geo.Ni; i++) {
    const inside = !plug.done && geo.s[i] >= a && geo.s[i] <= b;
    for (let j = 0; j < geo.Nj; j++) {
      const k = i * geo.Nj + j;
      if (inside) { if (!fs.mask[k]) { fs.mask[k] = 1; } fs.hFix[k] = hFix; fs.h[k] = hFix; fs.m[k] = hFix * ctx.coat.solids; fs.alpha[k] = 0; }
      else if (fs.mask[k] === 1 && plug.done) { fs.mask[k] = 0; }
    }
  }
}

STAGES.vacuum = {
  setup(ctx, st) {
    const { geo, fs } = ctx;
    if (geo.surface !== 'inner') {
      ctx.warnings.push('Vacuum withdraw acts on lumens: select the inner surface to see its effect.');
      return { duration: 0.01 };
    }
    const fromStart = st.fromEnd !== 'end';
    const fill = Math.min(st.fillLengthMm * 1e-3, geo.L);
    if (ctx.trapped) { for (let k = 0; k < geo.N; k++) fs.mask[k] = 0; ctx.trapped = null; }
    // through: plug pulled through toward the far end; back: sucked back out of the entry end
    const through = st.direction !== 'back';
    let rear, dir;
    if (fromStart) { dir = through ? 1 : -1; rear = through ? 0 : fill; }
    else { dir = through ? -1 : 1; rear = through ? geo.L : geo.L - fill; }
    const V = Math.abs(ctx.cumA(fromStart ? fill : geo.L) - ctx.cumA(fromStart ? 0 : geo.L - fill));
    const plug = new Plug(ctx, rear, dir, V);
    plug.maxSpeed = (st.maxSpeedMmS || 0) * 1e-3;
    ctx._plug = plug;
    // filled cells: wet with fresh coating
    for (let i = 0; i < geo.Ni; i++) {
      const inFill = fromStart ? geo.s[i] <= fill : geo.s[i] >= geo.L - fill;
      if (!inFill) continue;
      for (let j = 0; j < geo.Nj; j++) { const k = i * geo.Nj + j; freshLiquid(ctx, k, fs.h[k]); }
    }
    ctx._vac = { airPhase: false, tAir: 0 };
    return { duration: 1e9, dynamic: true };
  },
  drive(ctx, st) {
    const gs = ctx.fs.env.g[2];
    return (plug, len) => st.pressureKpa * 1e3 + ctx.coat.rho * gs * len * plug.dir;
  },
  hook(ctx, st, tl) {
    const { geo, fs } = ctx;
    const plug = ctx._plug;
    if (!plug) return;
    if (!plug.done) {
      plugStep(ctx, plug, fs.dt, this.drive(ctx, st));
      ctx.aux = { meniscus: plug.rear, front: plug.front(), speed: plug.speed };
      if (plug.stuck && tl > 30) { ctx.warnings.push('Vacuum too weak to overcome capillary/gravity forces: the lumen stays filled.'); plug.done = true; }
      return;
    }
    if (!ctx._vac.airPhase) { ctx._vac.airPhase = true; ctx._vac.t0 = tl; }
    // air drawn through the open lumen by the vacuum
    const dP = st.pressureKpa * 1e3;
    let RvA = 0;
    for (let i = 0; i < geo.Ni; i++) RvA += ellipseResistance(AIR_MU, geo.A[i], geo.B[i]) * geo.ds;
    const Qlam = dP / RvA;
    const iMin = geo.crossArea.indexOf(Math.min(...geo.crossArea));
    const Ulim = 0.6 * Math.sqrt((2 * dP) / AIR_RHO);
    const Q = Math.min(Qlam, Ulim * geo.crossArea[iMin]);
    let airMax = 0;
    for (let i = 0; i < geo.Ni; i++) {
      const U = Q / geo.crossArea[i];
      airMax = Math.max(airMax, U);
      const tau = airShear(U, 2 * geo.rHyd[i]) * plug.dir;
      for (let j = 0; j < geo.Nj; j++) fs.tauS[i * geo.Nj + j] = tau;
    }
    fs.env.airU = airMax;
    lumenEvapFactor(ctx, true);
    ctx.aux = { air: airMax };
    if (tl - ctx._vac.t0 >= st.airTime) ctx._stageDone = true;
  },
  dtMax(ctx) { return ctx._plug && !ctx._plug.done ? Math.max(ctx.geo.ds / Math.max(ctx._plug.speed, 1e-4) * 0.5, 1e-4) : 1; },
};

STAGES.dip = {
  setup(ctx, st) {
    const { geo, fs, coat } = ctx;
    const U = st.speed * 1e-3;
    const D = Math.min(st.immersionMm * 1e-3, geo.L);
    const mu = viscosity(coat, coat.solids, 0, (st.tempC ?? 25) + 273.15);
    const gamma = fs.gamma;
    const gcos = G0 * Math.cos(((st.tilt || 0) * Math.PI) / 180);
    const dp = { U, D, mu, gamma, sTop: geo.L - D, phase: 'dwell', plug: null };
    // deposition thickness for each cell when it leaves the bath
    dp.hOut = new Float64Array(geo.N);
    for (let k = 0; k < geo.N; k++) {
      const i = Math.floor(k / geo.Nj);
      if (geo.surface === 'inner') dp.hOut[k] = brethertonFilm(geo.rHyd[i], mu, U, gamma);
      else dp.hOut[k] = dipFilmOuter(mu, U, gamma, coat.rho, geo.flat ? Infinity : 1 / geo.kc[k], Math.max(gcos, 0.5));
    }
    // capillary rise inside a lumen (Jurin) relative to the bath level
    dp.jurin = 0;
    if (geo.surface === 'inner') {
      const iTop = ctx.iOf(dp.sTop);
      dp.jurin = (2 * gamma * Math.cos(ctx.thetaMean)) / (coat.rho * Math.max(gcos, 0.5) * geo.rHyd[iTop]);
      dp.jurin = Math.max(-0.5 * D, Math.min(dp.jurin, geo.L));
    }
    ctx._dip = dp;
    if (Math.abs(st.tilt || 0) > 60) ctx.warnings.push('Dip coating with a near-horizontal axis: deposition laws assume vertical withdrawal.');
    return { duration: st.dwell + D / Math.max(U, 1e-9) + (geo.surface === 'inner' ? 1e9 : st.drainAfter), dynamic: geo.surface === 'inner' };
  },
  hook(ctx, st, tl) {
    const { geo, fs } = ctx;
    const dp = ctx._dip;
    const tw = tl - st.dwell;
    const sBath = tw <= 0 ? dp.sTop : Math.min(geo.L + 1e-9, dp.sTop + dp.U * tw);
    if (geo.surface !== 'inner') {
      for (let k = 0; k < geo.N; k++) {
        const i = Math.floor(k / geo.Nj);
        const inBath = geo.s[i] >= sBath;
        if (inBath) { fs.mask[k] = 1; fs.hFix[k] = dp.hOut[k]; fs.h[k] = dp.hOut[k]; fs.m[k] = dp.hOut[k] * ctx.coat.solids; fs.alpha[k] = 0; }
        else if (fs.mask[k]) { fs.mask[k] = 0; freshLiquid(ctx, k, dp.hOut[k]); }
      }
      ctx.aux = { bath: Math.min(sBath, geo.L) };
      return;
    }
    // inner surface: meniscus sits at bath level minus capillary rise while the bottom is submerged
    if (!dp.plug) {
      const sMen = Math.max(0, sBath - dp.jurin);
      for (let k = 0; k < geo.N; k++) {
        const i = Math.floor(k / geo.Nj);
        const filled = geo.s[i] >= sMen;
        if (filled) { fs.mask[k] = 1; fs.hFix[k] = dp.hOut[k]; fs.h[k] = dp.hOut[k]; fs.m[k] = dp.hOut[k] * ctx.coat.solids; fs.alpha[k] = 0; }
        else if (fs.mask[k]) { fs.mask[k] = 0; freshLiquid(ctx, k, dp.hOut[k]); }
      }
      ctx.aux = { bath: Math.min(sBath, geo.L), meniscus: sMen };
      if (sBath >= geo.L) {
        // bottom left the bath: the liquid column now drains under gravity
        const V = ctx.cumA(geo.L) - ctx.cumA(sMen);
        dp.plug = new Plug(ctx, sMen, 1, V);
        dp.plug.maxSpeed = 0;
        dp.tDrain = tl;
      }
      return;
    }
    const plug = dp.plug;
    const gcos = fs.env.g[2];
    if (!plug.done) {
      plugStep(ctx, plug, fs.dt, (p, len) => ctx.coat.rho * gcos * len);
      ctx.aux = { meniscus: plug.rear, speed: plug.speed };
      if (plug.stuck && tl - dp.tDrain > 1) {
        plug.done = true;
        const sf = plug.front();
        trapLiquid(ctx, Math.min(plug.rear, sf), Math.max(plug.rear, sf));
        ctx.warnings.push(`Capillary forces hold a ${fmtMm(ctx.trapped.b - ctx.trapped.a)} liquid column in the lumen after withdrawal. Consider vacuum withdraw or an airflow stage to clear it.`);
      }
    } else if (dp.tEnd === undefined) dp.tEnd = tl;
    if (dp.tEnd !== undefined && tl - dp.tEnd >= st.drainAfter) ctx._stageDone = true;
  },
  dtMax(ctx, st) {
    const dp = ctx._dip;
    if (!dp) return 1;
    if (dp.plug && !dp.plug.done) return Math.max(ctx.geo.ds / Math.max(dp.plug.speed, 1e-5) * 0.5, 1e-4);
    return Math.max((ctx.geo.ds / Math.max(dp.U, 1e-6)) * 0.5, 1e-3);
  },
};

// ---------------------------------------------------------------- driver
export function frameOf(ctx, stIndex, label) {
  const { fs } = ctx;
  return {
    t: fs.t, stage: stIndex, label,
    h: Float32Array.from(fs.h), m: Float32Array.from(fs.m), alpha: Float32Array.from(fs.alpha),
    mask: Uint8Array.from(fs.mask), T: Float32Array.from(fs.Tf), aux: { ...(ctx.aux || {}) },
  };
}

export function simulate(spec, cb = {}) {
  const t0wall = Date.now();
  const ctx = makeContext(spec);
  ctx.warnings = [];
  const { fs, geo } = ctx;
  const stages = (spec.stages || []).map(withDefaults);
  const frames = [], history = [];
  const stageInfo = [];
  const framesPerStage = spec.framesPerStage || 36;
  const maxWall = (spec.maxWallSeconds || 600) * 1000;
  // expected stage durations (for progress); dynamic stages estimated
  const est = stages.map((s) => s.duration || (s.type === 'dip' ? (s.dwell + Math.min(s.immersionMm, 1e4) / s.speed + (s.drainAfter || 0)) : 20));
  const totalEst = est.reduce((a, b) => a + b, 0) || 1;
  let doneEst = 0;
  frames.push(frameOf(ctx, -1, 'Start'));
  for (let si = 0; si < stages.length; si++) {
    const st = stages[si];
    const impl = STAGES[st.type];
    if (!impl) throw new Error('Unknown stage ' + st.type);
    clearFields(fs);
    applyEnv(ctx, st, fs.t);
    lumenEvapFactor(ctx, false);
    ctx._stageDone = false; ctx.aux = {};
    const tStart = fs.t;
    const info = impl.setup(ctx, st) || { duration: 0 };
    fs.env.airU = Math.max(info.airU || 0, st.ambientAir || 0);
    if (info.airInLumen) lumenEvapFactor(ctx, true);
    const duration = info.duration;
    const tEnd = tStart + duration;
    const frameDt = Math.max((info.dynamic ? est[si] : duration) / framesPerStage, 1e-3);
    let nextFrame = tStart + frameDt;
    let lastHist = -1;
    const histDt = Math.max((info.dynamic ? est[si] : duration) / 150, 1e-3);
    fs.dt = Math.min(fs.dt, 0.01);
    const hook = (s) => {
      applyEnv(ctx, st, tStart);
      fs.env.airU = Math.max(info.airU || 0, st.ambientAir || 0, fs.env.airU && st.type === 'vacuum' ? fs.env.airU : 0);
      if (impl.hook) impl.hook(ctx, st, s.t - tStart);
    };
    const onStep = (s) => {
      if (s.t >= nextFrame) { frames.push(frameOf(ctx, si, st.label || st.type)); nextFrame += frameDt; }
      if (s.t - lastHist >= histDt) { history.push(snapshotHistory(ctx, si)); lastHist = s.t; }
      if (cb.onProgress && s.stats.steps % 50 === 0) {
        const frac = Math.min(0.999, (doneEst + Math.min(1, (s.t - tStart) / Math.max(est[si], 1e-9)) * est[si]) / totalEst);
        cb.onProgress(frac, `${st.label || st.type}: t = ${(s.t - tStart).toFixed(1)} s`);
      }
      if (cb.onStepDebug) cb.onStepDebug(s, ctx);
      if (ctx._stageDone) throw STOP;
      if (Date.now() - t0wall > maxWall) throw new Error('Run exceeded the wall-clock limit — try a coarser grid or shorter stages.');
      if (cb.shouldAbort && s.stats.steps % 50 === 0 && cb.shouldAbort()) throw new Error('Aborted');
    };
    const dtMax = () => Math.min(impl.dtMax ? impl.dtMax(ctx, st) : 5, Math.max(duration / 40, 1e-3), 5);
    try {
      if (duration > 0) {
        // dtMax may change during dynamic stages: advance in chunks
        while (fs.t < tEnd - 1e-12 && !ctx._stageDone) {
          const chunkEnd = Math.min(tEnd, fs.t + Math.max(dtMax() * 20, 1e-3));
          fs.advance(chunkEnd, hook, { dtMax: dtMax(), onStep });
        }
      }
    } catch (e) {
      if (e !== STOP) throw e;
    }
    // unmask anything still held (e.g. bath cells after the stage)
    for (let k = 0; k < geo.N; k++) if (fs.mask[k] && !isTrappedCell(ctx, Math.floor(k / geo.Nj))) fs.mask[k] = 0;
    clearFields(fs);
    ctx._airTField = false; fs.endStrip = null;
    frames.push(frameOf(ctx, si, (st.label || st.type) + ' (end)'));
    history.push(snapshotHistory(ctx, si));
    stageInfo.push({ type: st.type, label: st.label || st.type, tStart, tEnd: fs.t, aux: { ...(ctx.aux || {}) } });
    doneEst += est[si];
    if (cb.onProgress) cb.onProgress(doneEst / totalEst, `${st.label || st.type} complete`);
  }
  const metrics = computeMetrics(ctx, stages);
  return {
    spec, frames, history, stageInfo, metrics, warnings: [...new Set(ctx.warnings)],
    geometry: serialiseGeometry(geo), stats: { ...fs.stats, wallSeconds: (Date.now() - t0wall) / 1000 },
    theta: Float32Array.from(ctx.thetaField),
  };
}

const STOP = { stop: true };

function meanT(fs) { let t = 0; for (const v of fs.Tf) t += v; return t / fs.Tf.length; }

function snapshotHistory(ctx, si) {
  const { fs, geo, coat } = ctx;
  let A = 0, hw = 0, hd = 0, al = 0, muMax = 0, phiS = 0;
  for (let k = 0; k < geo.N; k++) {
    if (fs.h[k] < 4 * fs.hp) continue;
    const a = geo.area[k];
    A += a; hw += fs.h[k] * a; hd += fs.m[k] * a; al += fs.alpha[k] * a; phiS += (fs.m[k] / fs.h[k]) * a;
    if (fs.mu[k] > muMax) muMax = fs.mu[k];
  }
  const inv = A > 0 ? 1 / A : 0;
  return {
    t: fs.t, stage: si, wet: hw * inv, dry: hd * inv, alpha: al * inv, phi: phiS * inv,
    muMax, volume: fs.volume(), coveredArea: A, T: fs.env.T - 273.15, Tpart: meanT(fs) - 273.15, solidsMax: coat.phiMax,
  };
}

export function serialiseGeometry(geo) {
  return {
    Ni: geo.Ni, Nj: geo.Nj, N: geo.N, L: geo.L, ds: geo.ds, surface: geo.surface, flat: geo.flat, periodic: geo.periodic,
    s: Array.from(geo.s), phi: Array.from(geo.phi), A: Array.from(geo.A), B: Array.from(geo.B),
    area: Float32Array.from(geo.area), pos: Float32Array.from(geo.pos), nrm: Float32Array.from(geo.nrm),
  };
}
