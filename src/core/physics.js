// Constitutive relations: viscosity, evaporation, cure kinetics, disjoining pressure,
// and classical analytic coating laws used both by the process models and by the
// verification tests.

import { GAS_R } from './materials.js';

export const G0 = 9.81;
export const T_REF = 298.15;
export const MU_CAP = 1e9; // Pa·s – treated as "set"

export function viscosity(c, phi, alpha, T) {
  let mu = c.mu0 * Math.exp((c.EaMu * 1000 / GAS_R) * (1 / T - 1 / T_REF));
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
