import { test, assert, near, run } from './harness.mjs';
import { PentaSolver, solveDense } from '../src/core/linalg.js';
import { buildGeometry, parseProfileCSV, profileToCSV, tipPoolBody } from '../src/core/geometry.js';
import { getPreset } from '../src/core/presets.js';
import { makeContext } from '../src/core/processes.js';
import { FilmSolver } from '../src/core/film.js';
import { coatingMesh, meshVolume, heldBody } from '../src/core/drawn.js';
import { diffSpecs, resampleField, diffStats } from '../src/core/compare.js';
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

test('A/B comparison: resampling between grids, difference statistics and setting diffs', () => {
  // Smooth analytic field on a tube; resample from a coarse grid to a fine one and back.
  const field = (geo) => { const f = new Float32Array(geo.Ni * geo.Nj); for (let i = 0; i < geo.Ni; i++) for (let j = 0; j < geo.Nj; j++) f[i * geo.Nj + j] = 2 + Math.sin(geo.s[i] / geo.L * Math.PI) + 0.3 * Math.cos(2 * Math.PI * (j + 0.5) / geo.Nj); return f; };
  const tube = { type: 'catheter', length: 40, od: 3 };
  const A = buildGeometry({ geometry: tube, surface: 'outer', grid: { ns: 60, nphi: 16 } });
  const B = buildGeometry({ geometry: tube, surface: 'outer', grid: { ns: 150, nphi: 24 } });
  const fa = field(A), fb = field(B), r = resampleField(A, fa, B);
  let err = 0, errEnd = 0;
  for (let i = 0; i < B.Ni; i++) for (let j = 0; j < B.Nj; j++) { const k = i * B.Nj + j, e = Math.abs(r[k] - fb[k]); if (B.s[i] >= A.s[0] && B.s[i] <= A.s[A.Ni - 1]) err = Math.max(err, e); else errEnd = Math.max(errEnd, e); }
  // interior: linear-interpolation error ≈ 0.3·Δφ²/8 ≈ 6e-3; end half-cells are held constant (≤ slope × half cell ≈ 0.026)
  assert(err < 0.008, 'coarse → fine interpolation error ' + err);
  assert(errEnd < 0.03, 'end half-cell error ' + errEnd);
  // identical grids: exact copy, zero difference
  const same = resampleField(B, fb, B); const d0 = fb.map((v, k) => v - same[k]);
  const s0 = diffStats(d0, B.area);
  assert(s0.rms === 0 && s0.thicker === 0, 'same grid gives zero difference');
  // uniform +0.5 µm offset: mean = RMS = max = offset, all thicker
  const d1 = fb.map((v, k) => v + 0.5 - same[k]), s1 = diffStats(d1, B.area, () => true, 0.01);
  near(s1.mean, 0.5, 1e-6, 'mean offset'); near(s1.rms, 0.5, 1e-6, 'rms offset'); near(s1.thicker, 1, 1e-9, 'all thicker');
  // a shorter part: stations beyond its end have no data (NaN) and are skipped by the stats
  const C = buildGeometry({ geometry: { ...tube, length: 20 }, surface: 'outer', grid: { ns: 30, nphi: 16 } });
  const rc = resampleField(C, field(C), B);
  const nanRows = B.s.filter((s, i) => !isFinite(rc[i * B.Nj])).length, expect = B.s.filter((s) => s > 0.02 + 1e-9).length;
  assert(Math.abs(nanRows - expect) <= 1 && nanRows > 0, `rows beyond the shorter part: ${nanRows} vs ~${expect}`);
  assert(isFinite(diffStats(rc.map((v, k) => v - fb[k]), B.area).mean), 'stats skip missing cells');
  // bevelled cartridge: cut-away cells of the source never leak into the result
  const cart = { type: 'iol_cartridge', chamberLength: 12, chamberWidth: 5.6, chamberHeight: 4.0, taperLength: 14, nozzleWidth: 2.1, nozzleHeight: 1.7, nozzleLength: 10, tipWidth: 1.7, tipHeight: 1.35, wall: 0.6, tipBevelDeg: 45, bevelClockDeg: 270 };
  const P = buildGeometry({ geometry: cart, surface: 'inner', grid: { ns: 80, nphi: 16 } }), Q = buildGeometry({ geometry: cart, surface: 'inner', grid: { ns: 120, nphi: 24 } });
  const fp = new Float32Array(P.Ni * P.Nj).fill(1); for (let k = 0; k < fp.length; k++) if (P.voidMask[k]) fp[k] = 1e6;
  const rq = resampleField(P, fp, Q);
  assert(P.hasVoid && rq.every((v) => !isFinite(v) || Math.abs(v - 1) < 1e-6), 'void cells carry no weight');
  // setting diffs
  const sa = { presetId: 'x', geometry: { type: 'catheter', length: 40 }, stages: [{ type: 'dip', speed: 2 }, { type: 'cure', T: 80 }], metrics: { zone: [0, 10] } };
  const sb = { presetId: 'y', geometry: { type: 'catheter', length: 40 }, stages: [{ type: 'dip', speed: 2.5 }, { type: 'cure', T: 80, time: 60 }], metrics: { zone: [0, 12] } };
  const ds = diffSpecs(sa, sb);
  assert(ds.length === 3 && ds[0].path === 'stages[0].speed' && ds[0].a === 2 && ds[0].b === 2.5, JSON.stringify(ds));
  assert(ds.some((d) => d.path === 'stages[1].time' && d.a === undefined && d.b === 60), 'added field');
  assert(ds.some((d) => d.path === 'metrics.zone' && d.a === '[0,10]'), 'array leaf compared whole');
  assert(diffSpecs(sa, JSON.parse(JSON.stringify(sa))).length === 0, 'identical setups');
  return `interp err ${err.toExponential(1)}; ${nanRows} stations beyond a 20 mm part; ${ds.length} setting diffs`;
});

test('tip pool drawn as a meniscus body: volume matches the held pool (analytic cylinder, voxel check on the cartridge)', () => {
  // 1) square-ended tube: V = πr²(L − s0) + πr²·hm/2 (paraboloid meniscus)
  const tube = buildGeometry({ geometry: { type: 'catheter', length: 20, od: 2.2, id: 1.4 }, surface: 'inner', grid: { ns: 80, nphi: 16 } });
  const r = 0.7e-3, V1 = 2e-9, b1 = tipPoolBody(tube, V1, null, { theta: 0.5 });
  near(b1.V, V1, 2e-3, 'square tip body volume');
  near(Math.PI * r * r * (tube.L - b1.s0 + b1.hm / 2), V1, 3e-3, 'square tip analytic');
  assert(b1.hm > 0.2 * r, 'meniscus drawn');
  // 2) bevelled tube, pool above the short side: V = πr²(L − s0 + hm/2) − πr²·qmax·tanβ (the cut wedge)
  const bev = buildGeometry({ geometry: { type: 'catheter', length: 20, od: 2.2, id: 1.4, tipBevelDeg: 35 }, surface: 'inner', grid: { ns: 80, nphi: 16 } });
  const V2 = 4e-9, b2 = tipPoolBody(bev, V2, null, { theta: 0.5 });
  assert(b2.s0 < bev.L - b2.cutLen, 'pool reaches above the short side');
  near(Math.PI * r * r * (bev.L - b2.s0 + b2.hm / 2) - Math.PI * r * r * b2.qmax * b2.tanB, V2, 4e-3, 'bevel analytic');
  // 3) the SAICCS cartridge (taper, oval bore, 35° bevel on the floor): independent voxel count
  //    using the geometry's own cut rule, for a puddle in the bevel scoop and a full tip pool
  const spec = getPreset('saiccs_ha_heated');
  const geo = buildGeometry({ ...spec, grid: { ns: 120, nphi: 32 } });
  const { Ni, ds, L, A, B } = geo, cb = (geo.bevel.clockDeg * Math.PI) / 180, qmax = geo.bevel.qmax, tb = Math.tan(Math.min((geo.bevel.deg * Math.PI) / 180, 1.4));
  const out = [];
  for (const Vp of [0.3e-9, 3.5e-9]) {
    const body = tipPoolBody(geo, Vp, null, { theta: 0.6 });
    near(body.V, Vp, 3e-3, 'cartridge body volume');
    let Vv = 0; const NX = 70, NS = 400, z0 = body.top - ds;
    for (let n = 0; n < NS; n++) {
      const sz = z0 + ((n + 0.5) / NS) * (L - z0), i = Math.min(Ni - 1, Math.floor(sz / ds)), a = A[i], b = B[i], qi = Math.hypot(a * Math.cos(cb), b * Math.sin(cb));
      for (let p = 0; p < NX; p++) for (let q = 0; q < NX; q++) {
        const X = -1 + (2 * (p + 0.5)) / NX, Y = -1 + (2 * (q + 0.5)) / NX, r2 = X * X + Y * Y; if (r2 > 1) continue;
        const qT = ((a * X * Math.cos(cb) + b * Y * Math.sin(cb)) / qi) * qmax;
        if (sz > L - (qmax - qT) * tb || sz < body.zTop(r2)) continue;
        Vv += a * b * (4 / (NX * NX)) * ((L - z0) / NS);
      }
    }
    near(Vv, Vp, 0.02, 'voxel volume');
    out.push(`${(Vp * 1e9).toFixed(1)} µL → voxel ${(Vv * 1e9).toFixed(3)}, ${(body.height * 1e3).toFixed(2)} mm tall`);
  }
  // 4) film in the covered cells is part of the body: V = pool + film there
  const film = new Float64Array(geo.N).fill(20e-6), body = tipPoolBody(geo, 2e-9, film, { theta: 0.6 });
  let Vf = 0; for (let k = 0; k < geo.N; k++) if (body.inBody[k]) Vf += film[k] * geo.area[k];
  near(body.Vfilm, Vf, 1e-9, 'film in body'); near(body.V, 2e-9 + Vf, 0.01, 'pool + film');
  return out.join('; ');
});

test('drawn coating volume: film layer, full bore and held liquid bodies hold the simulated volume', () => {
  const out = [];
  // 1) oval bore (b/a = 0.7) filled to the axis: a 128-sided polygon of the ellipse
  const ov = buildGeometry({ geometry: { type: 'catheter', length: 20, od: 2, id: 1.4, ovality: 0.7 }, surface: 'inner', grid: { ns: 40, nphi: 32 } });
  const Vbore = Math.PI * 0.7e-3 * 0.49e-3 * 20e-3, Vf = meshVolume(coatingMesh(ov, null, new Uint8Array(ov.N).fill(1)));
  near(Vf, Vbore, 1e-3, 'flooded oval bore');
  // 2) thick, varying film in the oval bore (up to 35% of the minor radius, edge bead at the tip):
  //    drawn wedge volume = Σ film × area although the inner surface shrinks
  const film = new Float64Array(ov.N);
  for (let k = 0; k < ov.N; k++) { const i = Math.floor(k / ov.Nj), j = k % ov.Nj; film[k] = 20e-6 * (1 + 0.5 * Math.sin(ov.phi[j]) ** 2) * (1 + 3 * (i / ov.Ni) ** 4) + (i === ov.Ni - 1 ? 60e-6 : 0); }
  let Vs = 0; for (let k = 0; k < ov.N; k++) Vs += film[k] * ov.area[k];
  const e1 = near(meshVolume(coatingMesh(ov, film, null)), Vs, 2e-3, 'thick film in an oval bore');
  // 3) same film outside a round tube (the layer grows outward) and on a flat coupon with an edge bead
  const tube = buildGeometry({ geometry: { type: 'catheter', length: 20, od: 1, id: 0.6 }, surface: 'outer', grid: { ns: 40, nphi: 32 } });
  let Vo = 0; for (let k = 0; k < tube.N; k++) Vo += film[k] * tube.area[k];
  const e2 = near(meshVolume(coatingMesh(tube, film, null)), Vo, 2e-3, 'film outside a tube');
  const cp = buildGeometry({ geometry: { type: 'coupon', length: 20, width: 6 }, grid: { ns: 40, nphi: 12 } });
  const fc = new Float64Array(cp.N); let Vc = 0;
  for (let k = 0; k < cp.N; k++) { const j = k % cp.Nj; fc[k] = j === 0 || j === cp.Nj - 1 ? 90e-6 : 30e-6; Vc += fc[k] * cp.area[k]; }
  const e3 = near(meshVolume(coatingMesh(cp, fc, null)), Vc, 1e-9, 'coupon film with edge beads');
  out.push(`film ${(e1 * 100).toFixed(2)}% in bore, ${(e2 * 100).toFixed(2)}% outside, ${(e3 * 100).toFixed(4)}% coupon`);
  // 4) liquid plug in a straight round bore: concave menisci, volume as given, mean levels at the ends
  const rb = buildGeometry({ geometry: { type: 'catheter', length: 30, od: 2, id: 1.4 }, surface: 'inner', grid: { ns: 60, nphi: 16 } });
  const r = 0.7e-3, Vp = Math.PI * r * r * 8e-3, hb = heldBody(rb, { a: 10e-3, b: 18e-3, V: Vp, kind: 'plug' }, { theta: 0.5 });
  near(hb.V, Vp, 2e-3, 'plug body volume'); near(hb.a, 10e-3, 0.01, 'upper meniscus mean level');
  near(hb.hmA, (r * (1 - Math.sin(0.5))) / Math.cos(0.5), 1e-9, 'spherical-cap sag');
  assert(hb.zTop(1) < hb.zTop(0) && hb.zBot(1, 0) > hb.zBot(0, 0), 'both menisci concave: the liquid climbs the wall at each end');
  // 5) SAICCS cartridge: liquid draining out of the 35° bevelled tip, and the bore filled from the tip
  const geo = buildGeometry({ ...getPreset('saiccs_ha_heated'), grid: { ns: 120, nphi: 32 } });
  const cx = makeContext({ ...getPreset('saiccs_ha_heated'), grid: { ns: 120, nphi: 32 } });
  for (const V of [8e-9, 120e-9]) {
    const top = (() => { let lo = 0, hi = geo.L; for (let it = 0; it < 60; it++) { const m = 0.5 * (lo + hi); let v = 0; for (let i = 0; i < geo.Ni; i++) { const s0 = i * geo.ds, s1 = s0 + geo.ds; v += Math.PI * geo.A[i] * geo.B[i] * Math.max(0, s1 - Math.max(s0, m)); } if (v > V) lo = m; else hi = m; } return 0.5 * (lo + hi); })();
    const sSolver = cx.invCumA(cx.cumA(cx.L) - V); // the solver's (bevel-aware) meniscus level
    const b = heldBody(geo, { a: sSolver, b: geo.L, V, kind: 'plug' }, { theta: 0.6 });
    near(b.V, V, 3e-3, 'cartridge tip plug volume');
    assert(sSolver < top, 'the bevel scoop holds no liquid, so the plug reaches higher than the full-section estimate');
    assert(Math.abs(b.a - sSolver) < 0.03e-3, `drawn meniscus ${(b.a * 1e3).toFixed(3)} mm at the solver's ${(sSolver * 1e3).toFixed(3)} mm`);
    out.push(`${(V * 1e9).toFixed(0)} µL plug: solver meniscus ${(sSolver * 1e3).toFixed(2)} mm, drawn ${(b.a * 1e3).toFixed(2)} mm (full-section ${(top * 1e3).toFixed(2)})`);
  }
  return out.join('; ');
});

test('bevel: liquid-holding section of the bevelled rows is the uncut circular segment', () => {
  // round bore r = 0.7 mm, 35° bevel (face to axis): the cut is 2r·tan55° long and, by symmetry,
  // the bevelled length holds exactly half its full volume, πr²·r·tan55°
  const r = 0.7e-3, g = buildGeometry({ geometry: { type: 'catheter', length: 20, od: 2, id: 1.4, tipBevelDeg: 35 }, surface: 'inner', grid: { ns: 200, nphi: 32 } });
  const tanB = Math.tan((55 * Math.PI) / 180), cut = 2 * r * tanB;
  let Vh = 0, Vf = 0;
  for (let i = 0; i < g.Ni; i++) if (g.L - (i + 1) * g.ds < cut) { Vh += g.holdArea[i] * g.ds; Vf += g.crossArea[i] * g.ds; }
  const Vrow = Vf - Math.PI * r * r * cut; // full-section part of the row that straddles the top of the cut
  const e = near(Vh - Vrow, Math.PI * r * r * r * tanB, 2e-3, 'bevel holds half the cut length');
  assert(g.holdArea[g.Ni - 1] < 0.02 * g.crossArea[g.Ni - 1] && g.holdArea[0] === g.crossArea[0], 'empty at the point, full above the cut');
  // mid-cut row: the plane passes through the axis, half the section is left
  const iMid = Math.round((g.L - r * tanB) / g.ds - 0.5), fMid = g.holdArea[iMid] / g.crossArea[iMid];
  assert(Math.abs(fMid - 0.5) < 0.035, `half section at mid-cut (got ${fMid.toFixed(3)})`); // within half a row of the axis
  // square end: unchanged
  const sq = buildGeometry({ geometry: { type: 'catheter', length: 20, od: 2, id: 1.4 }, surface: 'inner', grid: { ns: 40, nphi: 16 } });
  assert(sq.holdArea.every((v, i) => v === sq.crossArea[i]), 'square end holds the full section');
  return `bevelled length holds ${((Vh - Vrow) * 1e9).toFixed(3)} µL of ${((Vf - Vrow) * 1e9).toFixed(3)} µL (error ${(e * 100).toFixed(2)}%)`;
});

run();
