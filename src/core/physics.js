// Constitutive relations: viscosity, evaporation, cure kinetics, disjoining pressure,
// and classical analytic coating laws used both by the process models and by the
// verification tests.

import { GAS_R } from './materials.js';

export const G0 = 9.81;
export const T_REF = 298.15;
export const MU_CAP = 1e9; // Pa·s – treated as "set"

export function viscosity(c, phi, alpha, T) {
  return viscosityAt(c, c.mu0 * Math.exp((c.EaMu * 1000 / GAS_R) * (1 / T - 1 / T_REF)), phi, alpha);
}

// Same as viscosity() with the Arrhenius part mu0·exp(...) at the film temperature already
// evaluated (muT), so the solver can reuse it while a cell's temperature is unchanged.
export function viscosityAt(c, muT, phi, alpha) {
  let mu = muT;
  if (c.thick > 0 && c.solids < c.phiMax) {
    const p0 = Math.min(c.solids, 0.999 * c.phiMax);
    const p = Math.min(Math.max(phi, p0), 0.995 * c.phiMax);
    mu *= Math.pow((1 - p0 / c.phiMax) / (1 - p / c.phiMax), c.thick);
  }
  const ag = c.cure?.alphaGel ?? 0.5;
  if (c.cure && c.cure.model !== 'none' && alpha > 0) {
    if (alpha >= ag * 0.999) return MU_CAP;
    mu *= Math.pow(ag / (ag - alpha), 1.5 + alpha);
  }
  return Math.min(mu, MU_CAP);
}

// Solvent evaporation rate of the free surface [m/s]
//  airU: air speed over the surface [m/s]; locFactor: geometric/ventilation factor (0..1]
export function evaporationRate(c, phi, T, airU, locFactor) {
  if (!(c.evap0 > 0) || c.solids >= c.phiMax) return 0;
  const fT = Math.exp((c.dHvap * 1000 / GAS_R) * (1 / T_REF - 1 / T));
  const act = Math.max(0, 1 - Math.pow(Math.min(phi / c.phiMax, 1), 4));
  const fAir = Math.sqrt(1 + Math.max(0, airU) / 0.15);
  return c.evap0 * 1e-6 * fT * act * fAir * locFactor;
}

// Cure rate d(alpha)/dt [1/s]. env: {T [K], uv [mW/cm^2]}
export function cureRate(c, alpha, env) {
  const cu = c.cure || { model: 'none' };
  if (alpha >= 1) return 0;
  if (cu.model === 'thermal') {
    const k1 = cu.A1 * Math.exp(-(cu.Ea1 * 1000) / (GAS_R * env.T));
    const k2 = (cu.A2 || 0) * Math.exp(-((cu.Ea2 || cu.Ea1) * 1000) / (GAS_R * env.T));
    return (k1 + k2 * Math.pow(alpha, cu.m || 1)) * Math.pow(1 - alpha, cu.n || 1);
  }
  if (cu.model === 'uv') {
    if (!(env.uv > 0)) return 0;
    return cu.kUV * Math.sqrt(env.uv / 100) * Math.pow(1 - alpha, cu.nUV || 1);
  }
  return 0;
}

// Disjoining pressure (Schwartz & Eley n=3, m=2 form) giving equilibrium angle theta
// on a precursor film of thickness hp. Returns {Pi, dPi}.
export function disjoiningCoeff(gamma, theta, hp) {
  return (2 * gamma * (1 - Math.cos(theta))) / hp;
}
export function disjoining(Bd, hp, h) {
  const r = hp / h, r2 = r * r, r3 = r2 * r;
  const Pi = Bd * (r3 - r2);
  const dPi = (Bd / h) * (-3 * r3 + 2 * r2);
  return [Pi, dPi];
}

export function capillaryLength(gamma, rho, g = G0) { return Math.sqrt(gamma / (rho * g)); }

// Film entrained on the OUTSIDE of a body withdrawn from a bath.
//  radius: local radius of curvature of the cross-section [m] (Infinity for a plate)
// Blends the Landau–Levich–Derjaguin plate law (0.94 lc Ca^2/3) with the fibre law
// (1.34 b Ca^2/3, Quéré) and limits to the visco-gravitational (Derjaguin) regime.
export function dipFilmOuter(mu, U, gamma, rho, radius, g = G0) {
  if (!(U > 0)) return 0;
  const Ca = (mu * U) / gamma;
  const lc = capillaryLength(gamma, rho, g);
  const c23 = Math.pow(Ca, 2 / 3);
  const plate = Math.min(0.94 * lc * c23, 0.8 * Math.sqrt((mu * U) / (rho * g)));
  if (!isFinite(radius)) return plate;
  const fibre = (1.34 * radius * c23) / Math.max(0.2, 1 - 1.34 * c23);
  return 1 / (1 / fibre + 1 / plate);
}

// Film left on the wall of a tube by a moving meniscus (Bretherton / Aussillous–Quéré).
export function brethertonFilm(R, mu, U, gamma) {
  if (!(U > 0)) return 0;
  const Ca = (mu * U) / gamma;
  const c = 1.34 * Math.pow(Ca, 2 / 3);
  return (R * c) / (1 + 2.5 * c);
}

// Jeffreys (1930) gravity drainage of a vertical film: h(x,t) = sqrt(mu x / (rho g t))
export function jeffreysDrainage(mu, rho, x, t, g = G0) { return Math.sqrt((mu * x) / (rho * g * t)); }

// Linear capillary levelling decay rate of a sinusoid of wavenumber k on a film h0.
export function levelingRate(gamma, mu, h0, k) { return (gamma * h0 * h0 * h0 * k ** 4) / (3 * mu); }

// Poiseuille resistance per unit length of an elliptical duct (semi-axes a,b) [Pa·s/m^4]
export function ellipseResistance(mu, a, b) { return (4 * mu * (a * a + b * b)) / (Math.PI * a ** 3 * b ** 3); }

// Dip withdrawal speed profile (mm/s) as a function of the withdrawn fraction f ∈ [0, 1]
// of the immersed length. Modes: 'constant'; 'ramp' (linear in withdrawn distance from
// speed to speedEnd); 'steps' (speed, then speed2 from switch1Pct, then speedEnd from
// switch2Pct). Slowing down toward the end thins the last-withdrawn (lower) part, which
// counters the thickening there from drainage.
export function dipSpeedAt(st, f) {
  const v0 = Math.max(st.speed, 1e-6);
  const mode = st.mode || 'constant';
  if (mode === 'ramp') {
    const v1 = Math.max(st.speedEnd ?? v0, 1e-6);
    const x = Math.min(1, Math.max(0, f));
    return v0 + (v1 - v0) * x;
  }
  if (mode === 'steps') {
    const a = (st.switch1Pct ?? 50) / 100, b = (st.switch2Pct ?? 100) / 100;
    if (f >= Math.max(a, b) && b < 1) return Math.max(st.speedEnd ?? v0, 1e-6);
    if (f >= a) return Math.max(st.speed2 ?? v0, 1e-6);
    return v0;
  }
  return v0;
}

// Time-position table for a profiled withdrawal of length D (m): returns { x, t, T } with
// x[n] the withdrawn distance (m) at time t[n] (s) and T the total withdrawal time.
export function dipWithdrawTable(st, D, n = 800) {
  const x = new Float64Array(n + 1), t = new Float64Array(n + 1);
  for (let k = 1; k <= n; k++) {
    const fa = (k - 1) / n, fb = k / n, dx = (D / n);
    x[k] = fb * D;
    // Simpson on 1/v over the sub-interval (exact enough for ramps; steps are piecewise constant)
    const va = dipSpeedAt(st, fa + 1e-12), vm = dipSpeedAt(st, 0.5 * (fa + fb)), vb = dipSpeedAt(st, fb - 1e-12);
    t[k] = t[k - 1] + (dx / 6) * (1 / va + 4 / vm + 1 / vb) * 1e3;
  }
  return { x, t, T: t[n] };
}

// Withdrawn distance (m) after time tw (s) into the withdrawal, from a dipWithdrawTable.
export function dipPositionAt(tab, tw) {
  const { x, t } = tab, n = t.length - 1;
  if (tw <= 0) return 0;
  if (tw >= t[n]) return x[n] + (tw - t[n]) * 1e9; // past the end: fully out
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= tw) lo = mid; else hi = mid; }
  return x[lo] + ((x[hi] - x[lo]) * (tw - t[lo])) / Math.max(t[hi] - t[lo], 1e-300);
}
