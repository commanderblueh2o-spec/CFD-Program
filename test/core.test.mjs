import { test, assert, near, run } from './harness.mjs';
import { PentaSolver, solveDense } from '../src/core/linalg.js';
import { buildGeometry } from '../src/core/geometry.js';
import { FilmSolver } from '../src/core/film.js';
import { COATINGS, SUBSTRATES, contactAngleOWRK } from '../src/core/materials.js';
import { levelingRate, jeffreysDrainage, dipFilmOuter, brethertonFilm, capillaryLength } from '../src/core/physics.js';

function rnd(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

test('pentadiagonal solver matches dense LU', () => {
  const n = 12, r = rnd(3);
  const a = [], b = [], c = [], d = [], e = [], rhs = [];
  for (let i = 0; i < n; i++) { a.push(r() - 0.5); b.push(r() - 0.5); c.push(4 + r()); d.push(r() - 0.5); e.push(r() - 0.5); rhs.push(r()); }
  for (const cyclic of [false, true]) {
    const M = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      const put = (o, v) => { let j = i + o; if (cyclic) j = (j + n) % n; if (j >= 0 && j < n) M[i][j] += v; };
      put(-2, a[i]); put(-1, b[i]); put(0, c[i]); put(1, d[i]); put(2, e[i]);
    }
    const ref = solveDense(M, rhs);
    const ps = new PentaSolver(n);
    const x = Float64Array.from(rhs);
    const A = Float64Array.from(a), B = Float64Array.from(b), C = Float64Array.from(c), D = Float64Array.from(d), E = Float64Array.from(e);
    if (cyclic) ps.solveCyclic(A, B, C, D, E, x); else ps.solve(A, B, C, D, E, x);
    for (let i = 0; i < n; i++) assert(Math.abs(x[i] - ref[i]) < 1e-10, `mismatch at ${i} (cyclic=${cyclic})`);
  }
});

test('Owens–Wendt contact angles are physically ordered', () => {
  const w = COATINGS.water;
  const thPTFE = contactAngleOWRK(SUBSTRATES.ptfe, w) * 180 / Math.PI;
  const thPP = contactAngleOWRK(SUBSTRATES.pp, w) * 180 / Math.PI;
  const thGlass = contactAngleOWRK(SUBSTRATES.glass, w) * 180 / Math.PI;
  assert(thPTFE > 100 && thPTFE < 125, 'water on PTFE ~110°, got ' + thPTFE);
  assert(thPP > 90 && thPP < 110, 'water on PP ~100°, got ' + thPP);
  assert(thGlass < 40, 'water on glass < 40°, got ' + thGlass);
  return `water: PTFE ${thPTFE.toFixed(0)}°, PP ${thPP.toFixed(0)}°, glass ${thGlass.toFixed(0)}°`;
});

function couponSolver(opts) {
  const spec = { geometry: { type: 'coupon', length: opts.L, width: opts.W }, grid: { ns: opts.ns, nphi: opts.nphi || 6 } };
  const geo = buildGeometry(spec);
  const coat = { ...COATINGS.silicone_oil_1000, mu0: opts.mu || 1, evap0: 0, cure: { model: 'none' } };
  const fs = new FilmSolver(geo, coat, { drip: false, precursor: opts.hp || 1e-8 });
  fs.setContactAngle(1e-3);
  return { geo, fs };
}

test('capillary levelling decay rate matches linear theory', () => {
  const L = 4, ns = 64; // mm
  const { geo, fs } = couponSolver({ L, W: 1, ns });
  fs.setGravity([0, 0, 0]);
  const h0 = 50e-6, eps = 0.02 * h0, k = Math.PI / (L * 1e-3);
  for (let i = 0; i < geo.Ni; i++) for (let j = 0; j < geo.Nj; j++) {
    const kk = i * geo.Nj + j; fs.h[kk] = h0 + eps * Math.cos(k * geo.s[i]); fs.m[kk] = fs.h[kk];
  }
  const rate = levelingRate(fs.gamma, fs.coat.mu0, h0, k);
  const tEnd = 1 / rate;
  fs.dt = tEnd / 200;
  fs.advance(tEnd, null, { dtMax: tEnd / 100 });
  const amp = (fs.h[0] - fs.h[(geo.Ni - 1) * geo.Nj]) / 2;
  const amp0 = eps * (Math.cos(k * geo.s[0]) - Math.cos(k * geo.s[geo.Ni - 1])) / 2;
  // discrete wavenumber correction for 2nd-order FV laplacian (k^4 -> (2 sin(k dx/2)/dx)^4)
  const dx = geo.ds;
  const kd = 2 * Math.sin(k * dx / 2) / dx;
  const expected = Math.exp(-rate * Math.pow(kd / k, 4) * tEnd);
  near(amp / amp0, expected, 0.03, 'amplitude ratio');
  return `decay ${ (amp / amp0).toFixed(4) } vs theory ${expected.toFixed(4)}`;
});

test('mass is conserved without sources or evaporation', () => {
  const { geo, fs } = couponSolver({ L: 10, W: 4, ns: 50, nphi: 12 });
  fs.setGravity([3, -2, 8]);
  for (let k = 0; k < geo.N; k++) { const i = Math.floor(k / geo.Nj); fs.h[k] = 20e-6 * (1 + 0.5 * Math.sin(i / 5)); fs.m[k] = fs.h[k]; }
  const v0 = fs.volume();
  fs.dt = 1e-3;
  fs.advance(20, null, { dtMax: 1 });
  near(fs.volume(), v0, 1e-9, 'film volume');
  return `${fs.stats.steps} steps`;
});

test('vertical gravity drainage approaches the Jeffreys solution', () => {
  const L = 20; // mm
  const { geo, fs } = couponSolver({ L, W: 1, ns: 100, mu: 0.5, nphi: 5 });
  fs.setGravity([0, 0, 9.81]); // s increases downward
  for (let k = 0; k < geo.N; k++) { fs.h[k] = 200e-6; fs.m[k] = fs.h[k]; }
  const t = 200;
  fs.dt = 1e-3;
  fs.advance(t, null, { dtMax: 2 });
  // compare in the upper-middle region (away from the top edge and bottom bead)
  let errMax = 0; const out = [];
  for (const smm of [5, 8, 12]) {
    const i = Math.round(smm / L * geo.Ni - 0.5);
    const hs = fs.h[i * geo.Nj + 2];
    const hj = jeffreysDrainage(0.5, fs.rho, geo.s[i], t);
    errMax = Math.max(errMax, Math.abs(hs - hj) / hj);
    out.push(`${smm}mm: ${(hs * 1e6).toFixed(1)}/${(hj * 1e6).toFixed(1)}µm`);
  }
  assert(errMax < 0.06, 'Jeffreys mismatch ' + (errMax * 100).toFixed(1) + '% ' + out.join(' '));
  return out.join(', ') + ` (${fs.stats.steps} steps, ${fs.stats.rejected} rejected)`;
});

test('dip-coating and Bretherton laws reproduce known limits', () => {
  const mu = 0.05, gamma = 0.03, rho = 1000, U = 1e-3;
  const lc = capillaryLength(gamma, rho);
  const Ca = mu * U / gamma;
  near(dipFilmOuter(mu, U, gamma, rho, Infinity), 0.94 * lc * Math.pow(Ca, 2 / 3), 1e-9, 'LLD plate');
  const hf = dipFilmOuter(mu, U, gamma, rho, 50e-6);
  near(hf, 1.34 * 50e-6 * Math.pow(Ca, 2 / 3), 0.05, 'thin fibre limit');
  const R = 1e-3, Cb = 1e-4;
  near(brethertonFilm(R, Cb * gamma, 1, gamma), 1.34 * R * Math.pow(Cb, 2 / 3), 0.02, 'Bretherton small Ca');
});

test('cylinder outer film shows Rayleigh–Plateau beading (thin fibre)', () => {
  const spec = { geometry: { type: 'catheter', length: 6, od: 0.2, id: 0.1 }, surface: 'outer', grid: { ns: 60, nphi: 8 } };
  const geo = buildGeometry(spec);
  const coat = { ...COATINGS.silicone_oil_350, evap0: 0 };
  const fs = new FilmSolver(geo, coat, { drip: false, precursor: 1e-7 });
  fs.setContactAngle(0.05); fs.setGravity([0, 0, 0]);
  for (let k = 0; k < geo.N; k++) { const i = Math.floor(k / geo.Nj); fs.h[k] = 15e-6 * (1 + 0.01 * Math.sin(i * 0.7)); fs.m[k] = fs.h[k]; }
  fs.dt = 1e-4;
  fs.advance(60, null, { dtMax: 1 });
  let mx = 0, mn = 1;
  for (let k = 0; k < geo.N; k++) { mx = Math.max(mx, fs.h[k]); mn = Math.min(mn, fs.h[k]); }
  assert(mx / mn > 2, 'expected beads to grow, max/min=' + (mx / mn).toFixed(2));
  return `max/min thickness ${(mx / mn).toFixed(1)}`;
});

run();
