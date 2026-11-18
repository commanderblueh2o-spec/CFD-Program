// Process orchestration: runs a sequence of process stages (plasma, dip, spray, drip,
// vacuum withdraw, airflow, flash/dwell, cure) on one FilmSolver, recording frames and
// time histories for visualisation.

import { buildGeometry, gravityBody } from './geometry.js';
import { FilmSolver } from './film.js';
import { resolveCoating, resolveSubstrate, activatedSubstrate, contactAngleOWRK, wenzel } from './materials.js';
import { dipFilmOuter, brethertonFilm, capillaryLength, ellipseResistance, viscosity, G0, dipSpeedAt, dipWithdrawTable, dipPositionAt } from './physics.js';
import { computeMetrics } from './metrics.js';

const AIR_RHO = 1.2, AIR_MU = 1.8e-5;
export const SCFH = 7.8658e-6; // m^3/s per standard cubic foot per hour

export const STAGE_TYPES = ['plasma', 'dip', 'spray', 'drip', 'fill', 'vacuum', 'airflow', 'dwell', 'cure'];

// Default parameters for each stage type (lengths mm, speeds mm/s unless noted).
export const STAGE_DEFAULTS = {
  plasma: { duration: 20, power: 1.0, holdMinutes: 5, penetrationMm: 6, fromEnd: 'both', tempC: 25, tilt: 90, ambientAir: 0 },
  dip: { speed: 2, mode: 'constant', speedEnd: 1, speed2: 1.5, switch1Pct: 50, switch2Pct: 80, immersionMm: 1e9, dwell: 5, drainAfter: 30, tempC: 25, tilt: 0, ambientAir: 0 },
  spray: { nozzles: 1, flowMlMin: 2, transferEff: 0.7, standoffMm: 40, coneDeg: 30, traverseMmS: 20, passes: 4, startMm: 0, endMm: 1e9, clockDeg: 90, inFlightEvapPct: 20, lanceSigmaMm: 2, tempC: 25, tilt: 90, ambientAir: 0, drainAfter: 10 },
  drip: { mode: 'drops', lines: 1, pumpUlS: 5, pumpVolumeUl: 15, dropUl: 5, count: 3, interval: 2, startMm: 5, endMm: 5, clockDeg: null, beadUlS: 2, needleMmS: 5, tempC: 25, tilt: 90, ambientAir: 0, drainAfter: 20 },
  fill: { fillFrom: 'start', primeS: 5, fillUlS: 20, dwellS: 30, withdrawUlS: 20, fillLevelMm: 0, airTime: 5, tempC: 25, tilt: 0, ambientAir: 0 },
  vacuum: { pressureKpa: 5, fillLengthMm: 1e9, fromEnd: 'start', direction: 'through', maxSpeedMmS: 0, airTime: 10, tempC: 25, tilt: 90, ambientAir: 0 },
  airflow: { duration: 20, nozzleSpeed: 0, airFlowScfh: 20, nozzleDiaMm: 2, captureFrac: 0.2, angleDeg: 0, offsetMm: 0, fromEnd: 'start', airTempC: 25, crossJetScfh: 0, crossJetDiaMm: 1.5, crossJetSpeed: 0, crossJetEnd: 'end', crossJetReachMm: 1.5, crossJetAngleDeg: 0, tempC: 25, tilt: 90, ambientAir: 0 },
  dwell: { duration: 60, tempC: 25, tilt: 90, ambientAir: 0 },
  cure: { duration: 300, mode: 'thermal', tempC: 100, uvIntensity: 100, uvTransmission: 0.6, tilt: 0, ambientAir: 0.3 },
};

// IOL cartridges stand vertical with the wide proximal end up and the tip down (tilt 0,
// s = 0 at the top) unless a stage says otherwise; other parts use the per-stage default.
export function defaultTilt(type, geometry) { return geometry && geometry.type === 'iol_cartridge' ? 0 : (STAGE_DEFAULTS[type] || {}).tilt ?? 90; }
// Parts never rotate (SAICCS cartridges and the other fixtures are stationary), so any
// rpm left in an old saved setup is ignored, and a cartridge is always upright.
export function withDefaults(stage, geometry) {
  const st = { ...STAGE_DEFAULTS[stage.type], tilt: defaultTilt(stage.type, geometry), ...stage, rpm: 0 };
  if (geometry && geometry.type === 'iol_cartridge') st.tilt = 0;
  return st;
}

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

// Set gravity, temperature etc. for this step (parts are stationary).
function applyEnv(ctx, st, t0) {
  const fs = ctx.fs;
  fs.env.T = (st.tempC ?? 25) + 273.15;
  if (!ctx._airTField) fs.Tair.fill(fs.env.T);
  if (!fs._airField) { const U = Math.max(fs.env.airU || 0, st.ambientAir || 0); fs.airUf.fill(U); fs.hcAir.fill(hConv(U)); }
  fs.dtCap = 0;
  fs.setGravity(gravityBody(st.tilt || 0, 0));
}

function clearFields(fs) { fs.src.fill(0); fs.tauS.fill(0); fs.tauP.fill(0); fs.env.uv = 0; fs.env.airU = 0; fs._airField = false; }

// natural + forced convection over the part [W/m^2K]
function hConv(U) { return 8 + 12 * Math.sqrt(Math.max(U, 0)); }

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
    const Tamb = (st.tempC ?? 25) + 273.15;
    const Tjet = (st.airTempC ?? st.tempC ?? 25) + 273.15;
    const rhoJet = AIR_RHO * (293.15 / Tjet);
    // Nozzle exit velocity: from a standard volumetric flow (SCFH) through the nozzle bore,
    // corrected to the jet temperature, or given directly.
    let Unoz = st.nozzleSpeed || 0, Qnoz = 0;
    if ((st.airFlowScfh || 0) > 0) {
      Qnoz = st.airFlowScfh * SCFH * (Tjet / 293.15); // m^3/s actual
      const dn = Math.max((st.nozzleDiaMm || 2) * 1e-3, 1e-4);
      Unoz = Math.min(Qnoz / (Math.PI * dn * dn / 4), 250);
    }
    let airMax = 0, Uin0 = 0, airPush = 0;
    if (geo.surface === 'inner') {
      const i0 = dir > 0 ? 0 : geo.Ni - 1;
      const Rin = Math.sqrt(geo.A[i0] * geo.B[i0]);
      const capture = (st.captureFrac ?? 0.2) * eff * Math.exp(-Math.pow((st.offsetMm * 1e-3) / Rin, 2));
      // flow entering the bore; if the bore is blocked the jet's captured dynamic pressure acts on the liquid
      Uin0 = Qnoz > 0 ? Math.min((capture * Qnoz) / geo.crossArea[i0], Unoz) : Unoz * capture;
      airPush = capture * 0.5 * rhoJet * Unoz * Unoz;
      fs._airField = true;
      for (let i = 0; i < geo.Ni; i++) {
        const U = Math.min((Uin0 * geo.crossArea[i0]) / geo.crossArea[i], 250); // accelerates in a taper
        const tau = airShear(U, 2 * geo.rHyd[i]) * dir;
        const D = 2 * geo.rHyd[i], Re = (rhoJet * U * D) / AIR_MU;
        const hcI = Math.max(8, ((Re < 2300 ? 3.66 : 0.023 * Math.pow(Re, 0.8) * Math.pow(0.7, 0.4)) * 0.026) / D);
        airMax = Math.max(airMax, U);
        for (let j = 0; j < geo.Nj; j++) { const k = i * geo.Nj + j; tauS[k] = tau; fs.airUf[k] = U; fs.hcAir[k] = hcI; }
      }
    } else {
      const U = Unoz * eff * Math.exp(-Math.pow(st.offsetMm / 20, 2));
      airMax = U;
      fs._airField = true;
      for (let k = 0; k < geo.N; k++) { tauS[k] = 0.0035 * AIR_RHO * U * U * dir; fs.airUf[k] = U; fs.hcAir[k] = hConv(U); }
    }
    // ---- heated air: local air temperature along the part
    ctx._airTField = true;
    if (geo.surface === 'inner' && Uin0 > 0) {
      // air cools as it heats the wall: T = Tamb + (Tjet - Tamb) exp(-x / Lth), Lth = m_dot cp / (h P)
      const i0 = dir > 0 ? 0 : geo.Ni - 1;
      const Q = Uin0 * geo.crossArea[i0];
      let x = 0;
      for (let ii = 0; ii < geo.Ni; ii++) {
        const i = dir > 0 ? ii : geo.Ni - 1 - ii;
        const D = 2 * geo.rHyd[i], U = Q / geo.crossArea[i];
        const Re = (rhoJet * U * D) / AIR_MU;
        const Nu = Re < 2300 ? 3.66 : 0.023 * Math.pow(Re, 0.8) * Math.pow(0.7, 0.4);
        const hc = (Nu * 0.026) / D;
        const Lth = (rhoJet * Q * 1005) / Math.max(hc * geo.perim[i], 1e-12);
        const T = Tamb + (Tjet - Tamb) * Math.exp(-x / Math.max(Lth, 1e-9));
        for (let j = 0; j < geo.Nj; j++) fs.Tair[i * geo.Nj + j] = T;
        x += geo.ds;
      }
    } else {
      fs.Tair.fill(Unoz > 0 ? Tjet : Tamb);
    }
    // ---- horizontal cross-jet over an opening (aligned with the tip bevel): strips excess
    // liquid hanging at the opening. If it is not aligned with the bevel face it also shears
    // the film on that face toward the edge.
    fs.endStrip = null;
    // horizontal jets: flow in SCFH through a nozzle of crossJetDiaMm (or a speed in m/s)
    const dX = Math.max((st.crossJetDiaMm || 1.5) * 1e-3, 1e-4);
    const Ux = (st.crossJetScfh || 0) > 0 ? Math.min((st.crossJetScfh * SCFH * (Tamb / 293.15)) / (Math.PI * dX * dX / 4), 300) : (st.crossJetSpeed || 0);
    ctx.crossJetDia = dX;
    if (Ux > 0 && st.crossJetEnd && st.crossJetEnd !== 'none') {
      const reach = Math.max((st.crossJetReachMm ?? 1.5) * 1e-3, geo.ds);
      const tauX = 0.0035 * AIR_RHO * Ux * Ux;
      fs.endStrip = { end: st.crossJetEnd, reach, pDyn: 0.5 * AIR_RHO * Ux * Ux, lim: Math.max(2e-6, fs.gamma / (200 * Math.max(tauX, 1e-6))) };
      const mis = Math.abs(Math.sin(((st.crossJetAngleDeg || 0) * Math.PI) / 180));
      if (mis > 0) {
        const sign = st.crossJetEnd === 'end' ? 1 : -1;
        for (let k = 0; k < geo.N; k++) {
          const i = Math.floor(k / geo.Nj);
          const d = st.crossJetEnd === 'end' ? geo.edgeEnd[k] : geo.s[i];
          if (d >= 0 && d <= reach * 2) tauS[k] += sign * 4 * tauX * mis * Math.exp(-d / reach);
        }
      }
    }
    ctx._air = { tauS, tauP, airMax, Uin0, Unoz };
    ctx.airPush = { p: airPush, dir };
    return { duration: st.duration, airU: airMax, airInLumen: geo.surface === 'inner' };
  },
  hook(ctx) { ctx.fs.tauS.set(ctx._air.tauS); },
  dtMax(ctx) { return ctx.plug && !ctx.plug.done ? plugDt(ctx) : 5; },
};

// ---------------------------------------------------------------- free liquid plugs in bores
// A plug forms when liquid collecting in a bore bridges the cross-section (the thin-film
// picture breaks down there). It then moves under gravity, capillarity and any air jet
// pressure, leaving a Bretherton film behind, or stays held by capillarity.
function plugDt(ctx) { const p = ctx.plug; return p && !p.done && p.speed > 0 ? Math.max((ctx.geo.ds / p.speed) * 0.5, 1e-4) : 0.5; }

function managePlug(ctx, st) {
  const { geo, fs } = ctx;
  if (geo.surface !== 'inner' || geo.flat) return;
  if (st.type === 'dip' || st.type === 'vacuum' || st.type === 'fill') return;
  const gS = fs.env.g[2];
  const air = st.type === 'airflow' && ctx.airPush ? ctx.airPush : { p: 0, dir: 1 };
  if (!ctx.plug && ctx.trapped) {
    // liquid held from an earlier stage (e.g. capillary hold after a dip)
    const { a, b } = ctx.trapped;
    const dir = air.p > 0 ? air.dir : gS >= 0 ? 1 : -1;
    ctx.plug = new Plug(ctx, dir > 0 ? a : b, dir, Math.abs(ctx.cumA(b) - ctx.cumA(a)));
    ctx.plug.maxSpeed = 0; ctx.plug.formed = fs.t;
  }
  if (!ctx.plug) detectBridge(ctx, air, gS);
  const plug = ctx.plug;
  if (!plug) return;
  // liquid draining into the plug from the film joins it
  plug.V = Math.max(0, plug.V + (fs.maskInflow || 0)); fs.maskInflow = 0;
  if (plug.V < 1e-13) { plug.done = true; }
  const before = plug.exited;
  if (!plug.done) plugStep(ctx, plug, fs.dt, (p, len) => (air.p > 0 ? air.p * (air.dir === p.dir ? 1 : -1) : 0) + ctx.coat.rho * gS * len * p.dir);
  // liquid leaving the bore: blown out by the air if it beats the capillary hold of the
  // opening, otherwise it gathers in the pool held at that opening
  const exitSide = plug.dir > 0 ? 1 : 0;
  const rExit = geo.rHyd[exitSide ? geo.Ni - 1 : 0];
  const forced = air.p * (air.dir === plug.dir ? 1 : 0) > (2 * fs.gamma) / rExit;
  const out = Math.max(0, plug.exited - before);
  const sf0 = plug.front();
  const atExit = plug.dir > 0 ? sf0 >= geo.L - 1e-9 : sf0 <= 1e-9;
  let toPool = forced ? 0 : out;
  if (!forced && atExit && !plug.done && plug.V < 0.6 * geo.crossArea[exitSide ? geo.Ni - 1 : 0] * fs.poolReach(exitSide)) { toPool += plug.V; plug.V = 0; plug.done = true; }
  if (toPool > 0) {
    if (!fs.pool) fs.pool = [{ V: 0, M: 0 }, { V: 0, M: 0 }];
    fs.pool[exitSide].V += toPool; fs.pool[exitSide].M += toPool * ctx.coat.solids;
  }
  fs.stats.dripped += forced ? out : 0;
  if (plug.done && !forced) { for (let k = 0; k < geo.N; k++) if (fs.mask[k] === 1) fs.mask[k] = 0; }
  if (plug.done) { ctx.plug = null; ctx.trapped = null; return; }
  sweepIntoPlug(ctx, plug);
  const sf = plug.front();
  ctx.trapped = { a: Math.min(plug.rear, sf), b: Math.max(plug.rear, sf) };
  ctx.aux = { ...(ctx.aux || {}), meniscus: plug.rear, front: sf, speed: plug.speed };
}

// Liquid lying just outside a plug's menisci (thicker than the film the meniscus deposits)
// is swept into the plug: the menisci collect it as they pass.
function sweepIntoPlug(ctx, plug) {
  const { geo, fs } = ctx;
  const sf = plug.front();
  const lo = Math.min(plug.rear, sf), hi = Math.max(plug.rear, sf);
  const iLo = ctx.iOf(lo), iHi = ctx.iOf(hi);
  const keep = Math.max(2 * (plug.hDep || 0), 8 * fs.hp);
  let got = 0;
  for (const i of [iLo - 2, iLo - 1, iLo, iHi, iHi + 1, iHi + 2]) {
    if (i < 0 || i >= geo.Ni) continue;
    for (let j = 0; j < geo.Nj; j++) {
      const k = i * geo.Nj + j;
      if (fs.mask[k] || fs.h[k] <= keep) continue;
      const ex = fs.h[k] - keep, frac = fs.m[k] / fs.h[k];
      got += ex * geo.area[k];
      fs.h[k] = keep; fs.m[k] = keep * frac;
    }
  }
  plug.V += got;
}

function detectBridge(ctx, air, gS) {
  const { geo, fs } = ctx;
  const { Ni, Nj } = geo;
  let i0 = -1, i1 = -1;
  // liquid filling ~45 % of the cross-section (film ≳ 0.25 R) snaps
  // into a plug (Plateau–Rayleigh in a tube); the last cells at each open end are left to drip-off
  for (let i = 1; i < Ni - 2; i++) {
    // a pool lying in an open bevel cannot seal the bore
    let open = false;
    for (let j = 0; j < Nj && !open; j++) if (geo.voidMask[i * Nj + j] || geo.edgeEnd[i * Nj + j] < 2 * geo.ds) open = true;
    if (open) { if (i0 >= 0) break; continue; }
    let v = 0;
    for (let j = 0; j < Nj; j++) { const k = i * Nj + j; if (!fs.mask[k]) v += (fs.h[k] - fs.hp) * geo.w[k]; }
    if (v > 0.45 * geo.crossArea[i]) { if (i0 < 0) i0 = i; i1 = i; } else if (i0 >= 0) break;
  }
  if (i0 < 0) return;
  // take the bridged slug plus its immediate neighbourhood
  const lo = Math.max(0, i0 - 1), hi = Math.min(Ni - 1, i1 + 1);
  let V = 0;
  for (let i = lo; i <= hi; i++) for (let j = 0; j < Nj; j++) {
    const k = i * Nj + j; if (fs.mask[k]) continue;
    V += Math.max(0, fs.h[k] - 4 * fs.hp) * geo.area[k];
  }
  if (V < 0.5 * geo.crossArea[i0] * geo.ds) return;
  // the bridged liquid now belongs to the plug
  for (let i = lo; i <= hi; i++) for (let j = 0; j < Nj; j++) {
    const k = i * Nj + j; if (fs.mask[k]) continue;
    if (fs.h[k] > 4 * fs.hp) { const frac = fs.m[k] / fs.h[k]; fs.h[k] = 4 * fs.hp; fs.m[k] = fs.h[k] * frac; }
  }
  const dir = air.p > 0 ? air.dir : gS >= 0 ? 1 : -1;
  const a = geo.s[lo] - 0.5 * geo.ds, b = geo.s[hi] + 0.5 * geo.ds;
  const plug = new Plug(ctx, dir > 0 ? a : b, dir, V);
  plug.maxSpeed = 0; plug.formed = fs.t;
  ctx.plug = plug;
  ctx.bridges = (ctx.bridges || 0) + 1;
  if (ctx.bridges === 1) ctx.warnings.push(`Coating bridged the bore near s = ${(0.5 * (a + b) * 1e3).toFixed(1)} mm and formed a liquid plug (thin-film limit exceeded there).`);
}

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
    // stationary part: n fixed nozzles spaced evenly around it, flow split between them
    const K = geo.flat ? 1 : Math.max(1, Math.round(st.nozzles || 1));
    const w = Q / (2 * Math.PI * sig * sig) / K;
    const { pos, nrm } = geo;
    for (let q = 0; q < K; q++) {
      const ang = (st.clockDeg * Math.PI) / 180 + (2 * Math.PI * q) / K;
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
    else if (st.mode === 'pump') applyTime = Math.max(st.pumpVolumeUl / Math.max(st.pumpUlS, 1e-6), 0.05);
    else applyTime = (st.count - 1) * st.interval + 0.01;
    ctx._drip = { a, b, applyTime, next: 0 };
    return { duration: applyTime + (st.drainAfter || 0) };
  },
  clockAngle(ctx, st) {
    if (st.clockDeg !== null && st.clockDeg !== undefined && st.clockDeg !== '') return (st.clockDeg * Math.PI) / 180;
    const g = ctx.fs.env.g;
    const down = Math.atan2(g[1], g[0]);
    if (Math.hypot(g[0], g[1]) < 1e-6) { // vertical: the middle of the half shown when cut open
      if (ctx.geo.surface !== 'inner') return Math.PI / 2;
      const bv = ctx.geo.bevel;
      if (bv && bv.deg > 0) { const cb = (bv.clockDeg * Math.PI) / 180; return Math.atan2(-Math.cos(cb), Math.sin(cb)); } // bevelled: sliced along the bevel plane
      return 1.5 * Math.PI;
    }
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
      const dV = (V * wts[k]) / tot;
      if (fs.mask[k] === 1 && ctx.plug && !ctx.plug.done) { ctx.plug.V += dV; continue; } // lands in a liquid plug
      const dh = dV / geo.area[k];
      fs.h[k] += dh; fs.m[k] += dh * ctx.coat.solids;
    }
    fs.stats.deposited += V;
  },
  hook(ctx, st, tl) {
    const { fs } = ctx;
    const dp = ctx._drip;
    fs.src.fill(0);
    if (st.mode === 'pump') {
      // stationary inserter nozzle fed by a peristaltic pump: continuous stream at one spot
      if (tl > dp.applyTime) { ctx.aux = {}; return; }
      ctx.aux = { nozzle: dp.a };
      dp.dispensed = dp.dispensed || 0;
      const V = Math.min(st.pumpUlS * 1e-9 * fs.dt, st.pumpVolumeUl * 1e-9 - dp.dispensed);
      if (!(V > 0)) return;
      dp.dispensed += V;
      const rb = Math.max(1.0e-3, 2 * ctx.geo.ds);
      this.deposit(ctx, st, dp.a, V, rb);
      return;
    }
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
  dtMax(ctx, st) { return st.mode === 'bead' || st.mode === 'pump' ? 0.05 : st.interval / 4; },
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
  // a positive-displacement (peristaltic) pump sets the flow: the meniscus speed is Q / A(s)
  let U0 = plug.flowQ > 0 ? plug.flowQ / geo.crossArea[iR] : dP > 0 ? dP / Rv / geo.crossArea[iR] : 0;
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
    const hB = Math.max(Math.min(brethertonFilm(geo.rHyd[i1], mu, U, gamma), 0.2 * geo.rHyd[i1]), 4 * fs.hp);
    plug.hDep = hB;
    let used = 0;
    if (i1 !== i0) {
      const step = plug.dir;
      for (let i = i0; i !== i1; i += step) {
        for (let j = 0; j < geo.Nj; j++) {
          const k = i * geo.Nj + j;
          if (fs.mask[k] === 2) continue;
          if (fs.mask[k] === 0) plug.V += fs.h[k] * geo.area[k]; // film already there joins the plug
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
      if (inside) {
        if (fs.mask[k] === 2) continue;
        // a cell newly covered by the plug: its film joins the plug
        if (fs.mask[k] === 0) plug.V += fs.h[k] * geo.area[k];
        fs.mask[k] = 1; fs.hFix[k] = hFix; fs.h[k] = hFix; fs.m[k] = hFix * ctx.coat.solids; fs.alpha[k] = 0;
      } else if (fs.mask[k] === 1) { fs.mask[k] = 0; plug.V -= fs.h[k] * geo.area[k]; } // film left where the plug withdrew
    }
  }
}

// Fill, dwell & withdraw (SAICCS insertion): coating is pumped into one opening while a
// peristaltic withdraw pump on the other opening first pulls it through (priming), then stops
// so the bore fills completely; the liquid dwells (held by back-pressure in the withdraw line)
// and is finally pumped out at a set flow rate, leaving a Bretherton film whose thickness
// follows the local meniscus speed Q/A(s).
STAGES.fill = {
  setup(ctx, st) {
    const { geo, fs } = ctx;
    if (geo.surface !== 'inner') {
      ctx.warnings.push('Fill & withdraw acts on bores: select the inside surface to see its effect.');
      return { duration: 0.01 };
    }
    if (ctx.trapped || ctx.plug) { for (let k = 0; k < geo.N; k++) if (fs.mask[k] === 1) fs.mask[k] = 0; ctx.trapped = null; ctx.plug = null; }
    const fromStart = st.fillFrom !== 'end';
    // fill level: the liquid surface position (0 = completely full)
    const lvl = Math.min(Math.max(st.fillLevelMm || 0, 0) * 1e-3, geo.L * 0.95);
    const top = fromStart ? lvl : geo.L - lvl;
    const V = fromStart ? ctx.cumA(geo.L) - ctx.cumA(top) : ctx.cumA(top);
    const fillT = (V * 1e9) / Math.max(st.fillUlS, 1e-6);
    const wdT = (V * 1e9) / Math.max(st.withdrawUlS, 1e-6);
    ctx._fill = { fromStart, top, V, primeT: st.primeS || 0, fillT, wdT, phase: 'prime', plug: null };
    fs.stats.deposited += V + (st.primeS || 0) * st.fillUlS * 1e-9; // primed liquid passes through
    fs.stats.dripped += (st.primeS || 0) * st.fillUlS * 1e-9;
    return { duration: ctx._fill.primeT + fillT + st.dwellS + wdT * 3 + (st.airTime || 0), dynamic: true };
  },
  hook(ctx, st, tl) {
    const { geo, fs } = ctx;
    const F = ctx._fill;
    const tFill0 = F.primeT, tDwell0 = tFill0 + F.fillT, tWd0 = tDwell0 + st.dwellS;
    const markFilled = (sLiquid) => {
      // cells under liquid are held full; everything they cover is wetted
      for (let i = 0; i < geo.Ni; i++) {
        const under = F.fromStart ? geo.s[i] >= sLiquid : geo.s[i] <= sLiquid;
        for (let j = 0; j < geo.Nj; j++) {
          const k = i * geo.Nj + j;
          if (fs.mask[k] === 2) continue;
          if (under) { fs.mask[k] = 1; fs.hFix[k] = Math.max(fs.hp * 8, 0.02 * geo.rHyd[i]); fs.h[k] = fs.hFix[k]; fs.m[k] = fs.h[k] * ctx.coat.solids; fs.alpha[k] = 0; fs.wetted[k] = 1; }
          else if (fs.mask[k] === 1) fs.mask[k] = 0;
        }
      }
    };
    if (tl < tFill0) {
      // priming: coating streams through the whole bore into the withdraw line
      F.phase = 'prime';
      markFilled(F.fromStart ? 0 : geo.L);
      ctx.aux = { nozzle: F.fromStart ? 0.5e-3 : geo.L - 0.5e-3, filling: 1 };
      return;
    }
    if (tl < tDwell0) {
      // withdraw pump stopped: the bore fills from the far end up to the fill level
      F.phase = 'fill';
      const frac = (tl - tFill0) / Math.max(F.fillT, 1e-9);
      const target = F.fromStart ? ctx.cumA(geo.L) - frac * F.V : frac * F.V;
      const sLiq = Math.max(0, Math.min(geo.L, ctx.invCumA(target)));
      markFilled(sLiq);
      ctx.aux = { nozzle: F.fromStart ? 0.5e-3 : geo.L - 0.5e-3, meniscus: sLiq, filling: 1 };
      return;
    }
    if (tl < tWd0) {
      F.phase = 'dwell';
      markFilled(F.top);
      ctx.aux = { meniscus: F.top, filling: 1 };
      return;
    }
    // withdraw: positive-displacement pump empties the bore out of the far opening
    if (!F.plug) {
      F.phase = 'withdraw';
      F.plug = new Plug(ctx, F.top, F.fromStart ? 1 : -1, F.V);
      F.plug.flowQ = st.withdrawUlS * 1e-9;
      F.plug.maxSpeed = 0;
      for (let k = 0; k < geo.N; k++) if (fs.mask[k] === 1) fs.mask[k] = 0;
    }
    const plug = F.plug;
    if (!plug.done) {
      const before = plug.exited;
      plugStep(ctx, plug, fs.dt, () => 1);
      fs.stats.dripped += Math.max(0, plug.exited - before);
      ctx.aux = { meniscus: plug.rear, speed: plug.speed, filling: 1 };
      if (plug.done) { fs.stats.dripped += Math.max(0, plug.V); F.tDone = tl; }
      return;
    }
    if (F.tDone === undefined) F.tDone = tl;
    F.phase = 'done';
    ctx.aux = {};
    if (tl - F.tDone >= (st.airTime || 0)) ctx._stageDone = true;
  },
  dtMax(ctx) {
    const F = ctx._fill;
    if (F && F.plug && !F.plug.done) return Math.max((ctx.geo.ds / Math.max(F.plug.speed, 1e-5)) * 0.5, 1e-4);
    return 0.5;
  },
};

STAGES.vacuum = {
  setup(ctx, st) {
    const { geo, fs } = ctx;
    if (geo.surface !== 'inner') {
      ctx.warnings.push('Vacuum withdraw acts on lumens: select the inner surface to see its effect.');
      return { duration: 0.01 };
    }
    const fromStart = st.fromEnd !== 'end';
    const fill = Math.min(st.fillLengthMm * 1e-3, geo.L);
    if (ctx.trapped || ctx.plug) { for (let k = 0; k < geo.N; k++) if (fs.mask[k] === 1) fs.mask[k] = 0; ctx.trapped = null; ctx.plug = null; }
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
    ctx.aux = { air: airMax, airScfh: Q / SCFH };
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
    // withdrawal speed profile: time ↔ withdrawn distance table
    dp.tab = dipWithdrawTable(st, D);
    dp.Umax = U;
    for (let q = 0; q <= 100; q++) dp.Umax = Math.max(dp.Umax, dipSpeedAt(st, q / 100) * 1e-3);
    // capillary rise inside a lumen (Jurin) relative to the bath level
    dp.jurin = 0;
    if (geo.surface === 'inner') {
      const iTop = ctx.iOf(dp.sTop);
      dp.jurin = (2 * gamma * Math.cos(ctx.thetaMean)) / (coat.rho * Math.max(gcos, 0.5) * geo.rHyd[iTop]);
      dp.jurin = Math.max(-0.5 * D, Math.min(dp.jurin, geo.L));
    }
    // deposition thickness for each cell when it leaves the bath (outside) or the meniscus
    // passes it (inside), at the local withdrawal speed of the profile
    dp.hOut = new Float64Array(geo.N);
    for (let k = 0; k < geo.N; k++) {
      const i = Math.floor(k / geo.Nj);
      const xLeave = geo.s[i] - dp.sTop + (geo.surface === 'inner' ? dp.jurin : 0);
      const Uk = dipSpeedAt(st, Math.min(1, Math.max(0, xLeave / Math.max(D, 1e-12)))) * 1e-3;
      if (geo.surface === 'inner') dp.hOut[k] = brethertonFilm(geo.rHyd[i], mu, Uk, gamma);
      else dp.hOut[k] = dipFilmOuter(mu, Uk, gamma, coat.rho, geo.flat ? Infinity : 1 / geo.kc[k], Math.max(gcos, 0.5));
    }
    ctx._dip = dp;
    if (Math.abs(st.tilt || 0) > 60) ctx.warnings.push('Dip coating with a near-horizontal axis: deposition laws assume vertical withdrawal.');
    return { duration: st.dwell + dp.tab.T + (geo.surface === 'inner' ? 1e9 : st.drainAfter), dynamic: geo.surface === 'inner' };
  },
  hook(ctx, st, tl) {
    const { geo, fs } = ctx;
    const dp = ctx._dip;
    const tw = tl - st.dwell;
    const sBath = tw <= 0 ? dp.sTop : Math.min(geo.L + 1e-9, dp.sTop + ((st.mode||'constant')==='constant' ? dp.U * tw : dipPositionAt(dp.tab, tw)));
    dp.Unow = dipSpeedAt(st, Math.min(1, Math.max(0, (sBath - dp.sTop) / Math.max(dp.D, 1e-12)))) * 1e-3;
    if (geo.surface !== 'inner') {
      for (let k = 0; k < geo.N; k++) {
        const i = Math.floor(k / geo.Nj);
        const inBath = geo.s[i] >= sBath;
        if (inBath) { fs.mask[k] = 1; fs.hFix[k] = dp.hOut[k]; fs.h[k] = dp.hOut[k]; fs.m[k] = dp.hOut[k] * ctx.coat.solids; fs.alpha[k] = 0; }
        else if (fs.mask[k]) { fs.mask[k] = 0; freshLiquid(ctx, k, dp.hOut[k]); }
      }
      ctx.aux = { bath: Math.min(sBath, geo.L), withdraw: dp.Unow };
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
      ctx.aux = { bath: Math.min(sBath, geo.L), meniscus: sMen, withdraw: dp.Unow };
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
    return Math.max((ctx.geo.ds / Math.max(dp.Umax, 1e-6)) * 0.5, 1e-3);
  },
};

// ---------------------------------------------------------------- driver
export function frameOf(ctx, stIndex, label) {
  const { fs } = ctx;
  return {
    t: fs.t, stage: stIndex, label,
    h: Float32Array.from(fs.h), m: Float32Array.from(fs.m), alpha: Float32Array.from(fs.alpha),
    mask: Uint8Array.from(fs.mask), T: Float32Array.from(fs.Tf), aux: { ...(ctx.aux || {}), pool: fs.pool ? [fs.pool[0].V, fs.pool[1].V] : [0, 0] },
  };
}

export function simulate(spec, cb = {}) {
  const t0wall = Date.now();
  const ctx = makeContext(spec);
  ctx.warnings = [];
  const { fs, geo } = ctx;
  const stages = (spec.stages || []).map((st) => withDefaults(st, spec.geometry));
  const frames = [], history = [];
  const stageInfo = [];
  const framesPerStage = spec.framesPerStage || 36;
  const maxWall = (spec.maxWallSeconds || 600) * 1000;
  // expected stage durations (for progress); dynamic stages estimated
  const est = stages.map((s) => s.duration || (s.type === 'dip' ? (s.dwell + dipWithdrawTable(s, Math.min(s.immersionMm, 1e4) * 1e-3, 100).T + (s.drainAfter || 0)) : 20));
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
      managePlug(ctx, st);
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
      if (Date.now() - t0wall > maxWall) { ctx.timedOut = true; throw STOP; }
      if (cb.shouldAbort && s.stats.steps % 50 === 0 && cb.shouldAbort()) throw new Error('Aborted');
    };
    const dtMax = () => Math.min(impl.dtMax ? impl.dtMax(ctx, st) : 5, ctx.plug && !ctx.plug.done ? plugDt(ctx) : 5, Math.max(duration / 40, 1e-3), 5);
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
    if (ctx.timedOut) {
      ctx.warnings.push(`Stopped at t = ${fs.t.toFixed(0)} s (during "${st.label || st.type}") because the run hit its ${Math.round(maxWall / 1000)} s computing limit; results show the state at that point. Try the Fast resolution or shorter stages.`);
      frames.push(frameOf(ctx, si, (st.label || st.type) + ' (stopped)'));
      history.push(snapshotHistory(ctx, si));
      stageInfo.push({ type: st.type, label: st.label || st.type, tStart, tEnd: fs.t, aux: {} });
      break;
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
  if (fs.pool && geo.surface === 'inner') {
    for (const side of [0, 1]) {
      const P = fs.pool[side];
      if (P.V < 1e-12) continue;
      // the pool dries where it sits: spread its liquid and solids over the end region
      const reach = fs.poolReach(side);
      let A = 0; const cells = [];
      for (let k = 0; k < geo.N; k++) { const i = Math.floor(k / geo.Nj); const d = side === 0 ? geo.s[i] : geo.edgeEnd[k]; if (d >= 0 && d <= reach && !fs.mask[k]) { cells.push(k); A += geo.area[k]; } }
      if (!(A > 0)) { P.V = 0; P.M = 0; continue; }
      const eq = (P.M / A) * 1e6;
      const uMin = Math.sqrt((4 * fs.gamma) / (AIR_RHO * geo.rHyd[side ? geo.Ni - 1 : 0]));
      const dJ = ctx.crossJetDia || 1.5e-3;
      const scfhMin = (uMin * Math.PI * dJ * dJ / 4) / SCFH;
      ctx.poolReport = { side, uL: P.V * 1e9, dryUm: eq, reachMm: reach * 1e3, jet: uMin, jetScfh: scfhMin, jetDiaMm: dJ * 1e3 };
      ctx.warnings.push(`About ${(P.V * 1e9).toFixed(2)} µL of coating is pooled at the ${side === 1 ? 'tip' : 'top'} opening at the end of the process (held by surface tension; it dries to a thick deposit of ~${eq.toFixed(1)} µm dry over the last ${(reach * 1e3).toFixed(1)} mm). Horizontal jets above ~${scfhMin.toFixed(1)} SCFH (through ${(dJ * 1e3).toFixed(1)} mm nozzles) at that opening would blow it out.`);
      for (const k of cells) { fs.h[k] += P.V / A; fs.m[k] += P.M / A; }
      P.V = 0; P.M = 0;
    }
  }
  if (ctx.plug && !ctx.plug.done) {
    const t = ctx.trapped;
    ctx.warnings.push(`A liquid plug (${(ctx.plug.V * 1e9).toFixed(1)} µL) is still held in the bore between s = ${(t.a * 1e3).toFixed(1)} and ${(t.b * 1e3).toFixed(1)} mm at the end of the process. Stronger air (higher flow or capture) or a vacuum step would clear it.`);
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
    voidMask: Uint8Array.from(geo.voidMask || new Uint8Array(geo.N)), bevel: geo.bevel, edgeEnd: Float32Array.from(geo.edgeEnd || new Float64Array(geo.N)),
    poolReach: [3 * geo.ds, 3 * geo.ds + (geo.hasVoid ? Math.max(...Array.from(geo.endCell, (e) => (geo.Ni - 1 - e) * geo.ds)) : 0)],
  };
}
