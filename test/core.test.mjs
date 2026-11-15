import { test, assert, near, run } from './harness.mjs';
import { PentaSolver, solveDense } from '../src/core/linalg.js';
import { buildGeometry, parseProfileCSV, profileToCSV } from '../src/core/geometry.js';
import { FilmSolver } from '../src/core/film.js';
import { COATINGS, SUBSTRATES, contactAngleOWRK } from '../src/core/materials.js';
import { levelingRate, jeffreysDrainage, dipFilmOuter, brethertonFilm, capillaryLength, dipSpeedAt, dipWithdrawTable, dipPositionAt } from '../src/core/physics.js';

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

test('dip withdrawal profiles: ramp and step timing match closed forms', () => {
  const D = 0.02; // 20 mm
  // linear ramp in distance: v(x) = v0 + (v1 − v0) x/D → T = D ln(v1/v0)/(v1 − v0)
  const ramp = { mode: 'ramp', speed: 3, speedEnd: 0.5 };
  const tabR = dipWithdrawTable(ramp, D);
  const Tr = (D * 1e3) * Math.log(0.5 / 3) / (0.5 - 3);
  near(tabR.T, Tr, 1e-4, 'ramp withdrawal time');
  // position after half the time is where ∫dx/v = T/2: x = D (v0/(v1−v0)) (exp((v1−v0)T/(2D))−1)
  const xHalf = (3 / (0.5 - 3)) * (Math.exp(((0.5 - 3) * (Tr / 2)) / (D * 1e3)) - 1) * D;
  near(dipPositionAt(tabR, Tr / 2), xHalf, 1e-3, 'ramp position at T/2');
  // three steps: 2 mm/s to 40%, 1 mm/s to 75%, 0.5 mm/s to the end
  const steps = { mode: 'steps', speed: 2, speed2: 1, speedEnd: 0.5, switch1Pct: 40, switch2Pct: 75 };
  const Ts = 20 * (0.4 / 2 + 0.35 / 1 + 0.25 / 0.5);
  near(dipWithdrawTable(steps, D).T, Ts, 2e-3, 'multi-step withdrawal time');
  assert(dipSpeedAt(steps, 0.1) === 2 && dipSpeedAt(steps, 0.5) === 1 && dipSpeedAt(steps, 0.9) === 0.5, 'step speeds');
  near(dipWithdrawTable({ speed: 2 }, D).T, 10, 1e-9, 'constant speed');
  return `ramp T = ${tabR.T.toFixed(3)} s (exact ${Tr.toFixed(3)}), steps T = ${dipWithdrawTable(steps, D).T.toFixed(3)} s (exact ${Ts.toFixed(3)})`;
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

test('CSV profile import: headers, units, delimiters and a frustum bore volume', () => {
  // Diameters in µm with a header, measured from the tip (descending), semicolon + decimal comma
  const eu = 'Position (mm);Diameter (µm)\n30;1600\n20,0;1600\n10;4000\n0;4000\n';
  const a = parseProfileCSV(eu);
  assert(a.points.length === 4 && a.kind === 'full', 'four full-size points');
  near(a.points[0][1], 2.0, 1e-9, 'r at s=0 (µm diameter → mm radius)');
  near(a.points[3][2], 0.8, 1e-9, 'r at tip');
  // No header: s, half-width, half-height in mm (same as the text box); comments, blanks, tabs
  const b = parseProfileCSV('# bore\n5\t2.8\t2.0\n\n17\t1.05\t0.85\n27\t0.85\t0.68\n');
  near(b.points[0][0], 0, 1e-12, 'shifted to s=0'); near(b.length, 22, 1e-12, 'length');
  assert(b.notes.some((n) => /Shifted/.test(n)), 'shift noted');
  // Header synonyms: width/height in inches → halved and scaled
  const c = parseProfileCSV('z_in, width_in, height_in\n0, 0.2, 0.1\n1, 0.1, 0.05\n');
  near(c.points[1][0], 25.4, 1e-9, 'inch position'); near(c.points[0][1], 2.54, 1e-9, 'half width'); near(c.points[0][2], 1.27, 1e-9, 'half height');
  // radius column; flip
  const d = parseProfileCSV('s,r\n0,0.5\n10,1.5\n', { flip: true });
  near(d.points[0][1], 1.5, 1e-12, 'flipped: wide end first');
  // Round trip
  const e = parseProfileCSV(profileToCSV(b.points));
  assert(JSON.stringify(e.points) === JSON.stringify(b.points), 'round trip');
  // Errors
  let threw = 0;
  for (const bad of ['', 's,d\n0,1\n', 's,d\n0,1\n5,-1\n', 's (m),d (m)\n0,0.002\n0.3,0.002\n10,0.002\n']) { try { parseProfileCSV(bad); } catch { threw++; } }
  assert(threw === 4, 'invalid profiles rejected, got ' + threw);
  // Frustum: lumen volume from the built grid matches pi L/3 (r1^2 + r1 r2 + r2^2)
  const L = 20, r1 = 1.5, r2 = 0.6;
  const fr = parseProfileCSV(`s_mm,diameter_mm\n0,${2 * r1}\n${L},${2 * r2}\n`);
  const geo = buildGeometry({ geometry: { type: 'custom', points: fr.points }, surface: 'inner', grid: { ns: 200, nphi: 24 } });
  let V = 0; for (let i = 0; i < geo.Ni; i++) V += geo.crossArea[i] * geo.ds;
  const Vref = Math.PI * L / 3 * (r1 * r1 + r1 * r2 + r2 * r2) * 1e-9;
  near(V, Vref, 1e-4, 'frustum volume');
  // Dense noisy measurement → averaged down, volume kept
  let txt = 's,d\n'; const rng = rnd(7);
  for (let i = 0; i <= 4000; i++) { const s = L * i / 4000; txt += `${s},${2 * (r1 + (r2 - r1) * s / L) + 0.01 * (rng() - 0.5)}\n`; }
  const dn = parseProfileCSV(txt);
  assert(dn.points.length <= 240, 'decimated to ' + dn.points.length);
  const g2 = buildGeometry({ geometry: { type: 'custom', points: dn.points }, surface: 'inner', grid: { ns: 200, nphi: 24 } });
  let V2 = 0; for (let i = 0; i < g2.Ni; i++) V2 += g2.crossArea[i] * g2.ds;
  near(V2, Vref, 2e-3, 'noisy frustum volume');
  return `frustum ${(V * 1e9).toFixed(3)} µL vs ${(Vref * 1e9).toFixed(3)}; 4001 noisy points → ${dn.points.length}`;
});

run();
