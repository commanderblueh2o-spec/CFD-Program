import { test, assert, near, run } from './harness.mjs';
import { simulate, makeContext } from '../src/core/processes.js';
import { brethertonFilm, dipFilmOuter, viscosity } from '../src/core/physics.js';
import { COATINGS } from '../src/core/materials.js';

const oil = { mu0: 0.1, evap0: 0, solids: 1, phiMax: 1, thick: 0, cure: { model: 'none' } };

test('dip (coupon): film at the bath line matches Landau–Levich', () => {
  const U = 1; // mm/s
  const spec = {
    geometry: { type: 'coupon', length: 20, width: 6 }, substrate: 'pp', coating: 'silicone_oil_350', coatingOverrides: oil,
    grid: { ns: 100, nphi: 6 }, stages: [{ type: 'dip', speed: U, dwell: 0, drainAfter: 0, tilt: 0 }], framesPerStage: 40,
  };
  const r = simulate(spec);
  // the frame at ~60% of withdrawal: the cells just above the bath line were just deposited
  const c = { ...COATINGS.silicone_oil_350, ...oil };
  const hLLD = dipFilmOuter(0.1, U * 1e-3, (c.d + c.p) * 1e-3, c.rho, Infinity);
  const fr = r.frames.find((f) => f.aux.bath > 0.012);
  const i = Math.floor(fr.aux.bath / (20e-3 / 100)) - 2;
  const h = fr.h[i * 6 + 3];
  near(h, hLLD, 0.1, 'film just above the bath');
  return `h = ${(h * 1e6).toFixed(1)} µm vs LLD ${(hLLD * 1e6).toFixed(1)} µm`;
});

test('vacuum withdraw leaves the Bretherton film for the controlled meniscus speed', () => {
  const spec = {
    geometry: { type: 'catheter', length: 30, od: 2, id: 1.2 }, surface: 'inner', substrate: 'pebax', coating: 'silicone_oil_350', coatingOverrides: oil,
    grid: { ns: 90, nphi: 16 },
    stages: [{ type: 'vacuum', pressureKpa: 20, fillLengthMm: 30, fromEnd: 'start', direction: 'through', maxSpeedMmS: 4, airTime: 0, tilt: 90 }],
  };
  const r = simulate(spec);
  const gamma = (COATINGS.silicone_oil_350.d + COATINGS.silicone_oil_350.p) * 1e-3;
  const hB = brethertonFilm(0.6e-3, 0.1, 4e-3, gamma);
  near(r.metrics.wet.mean * 1e-6, hB, 0.15, 'mean wet film');
  return `mean ${r.metrics.wet.mean.toFixed(1)} µm vs Bretherton ${(hB * 1e6).toFixed(1)} µm`;
});

test('narrow wetting lumen holds its liquid column after dip (capillary rise)', () => {
  const spec = {
    geometry: { type: 'catheter', length: 20, od: 0.6, id: 0.3 }, surface: 'inner', substrate: 'glass', coating: 'water',
    grid: { ns: 60, nphi: 12 }, stages: [{ type: 'dip', speed: 2, dwell: 0, drainAfter: 2, tilt: 0 }],
  };
  const r = simulate(spec);
  assert(r.warnings.some((w) => /Capillary forces hold/.test(w)), 'expected capillary hold warning, got ' + JSON.stringify(r.warnings));
  assert(r.metrics.groups.jurinHeight_mm > 20, 'Jurin height should exceed the part length');
  // a weak air jet cannot clear it, a strong one can
  const weak = simulate({ ...spec, stages: [...spec.stages, { type: 'airflow', duration: 3, nozzleSpeed: 2, fromEnd: 'start', tilt: 0 }] });
  assert(weak.warnings.some((w) => /still held/.test(w)), 'weak air should fail to clear: ' + weak.warnings.join('; '));
  const strong = simulate({ ...spec, stages: [...spec.stages, { type: 'airflow', duration: 3, nozzleSpeed: 60, fromEnd: 'start', tilt: 0 }] });
  assert(!strong.warnings.some((w) => /still held/.test(w)), 'strong air should clear: ' + strong.warnings.join('; '));
  return `Jurin height ${r.metrics.groups.jurinHeight_mm.toFixed(0)} mm; 60 m/s air clears it, 2 m/s does not`;
});

test('wide lumen drains after dip and leaves a thin film', () => {
  const spec = {
    geometry: { type: 'catheter', length: 40, od: 5, id: 4 }, surface: 'inner', substrate: 'pp', coating: 'silicone_oil_350', coatingOverrides: oil,
    grid: { ns: 80, nphi: 16 }, stages: [{ type: 'dip', speed: 2, dwell: 0, drainAfter: 2, tilt: 0 }], metrics: { zone: [0, 34] },
  };
  const r = simulate(spec);
  // only a short plug about one capillary-rise height long may stay at the bottom end
  const jur = r.metrics.groups.jurinHeight_mm;
  const w = r.warnings.find((x) => /Capillary forces hold/.test(x));
  const held = w ? parseFloat(w.match(/a ([\d.]+) mm/)[1]) : 0;
  assert(held <= jur * 1.2 + 1, `retained ${held} mm > Jurin ${jur.toFixed(1)} mm`);
  assert(r.metrics.wet.mean < 200, 'drained film should be thin, got ' + r.metrics.wet.mean);
  return `drained film ${r.metrics.wet.mean.toFixed(1)} µm; ${held.toFixed(1)} mm plug retained (Jurin ${jur.toFixed(1)} mm)`;
});

test('evaporation conserves solids: dry film = wet film × solids', () => {
  const spec = {
    geometry: { type: 'coupon', length: 10, width: 10 }, substrate: 'glass', coating: 'pu_thf',
    grid: { ns: 40, nphi: 8 },
    stages: [{ type: 'drip', mode: 'drops', dropUl: 2, count: 1, startMm: 5, endMm: 5, tilt: 90, drainAfter: 1 }, { type: 'dwell', duration: 400, tilt: 90, tempC: 40, ambientAir: 1 }],
  };
  const r = simulate(spec);
  const mb = r.metrics.massBalance;
  const c = COATINGS.pu_thf;
  near(mb.solids_uL, mb.deposited_uL * c.solids, 0.02, 'solids volume');
  assert(r.history[r.history.length - 1].phi > 0.9 * c.phiMax, 'film should be dry');
  return `solids ${mb.solids_uL.toFixed(4)} µL of ${(mb.deposited_uL * c.solids).toFixed(4)} µL`;
});

test('spray deposits no more than the transfer-efficient flow', () => {
  const spec = {
    geometry: { type: 'catheter', length: 40, od: 3, id: 2 }, surface: 'outer', substrate: 'tpu', coating: 'silicone_oil_350', coatingOverrides: oil,
    grid: { ns: 80, nphi: 24 },
    stages: [{ type: 'spray', flowMlMin: 1, transferEff: 0.5, standoffMm: 30, coneDeg: 20, traverseMmS: 20, passes: 2, startMm: 0, endMm: 40, rpm: 60, tilt: 90, inFlightEvapPct: 0, drainAfter: 0 }],
  };
  const r = simulate(spec);
  const sprayed = (1e3 / 60) * 0.5 * 4; // µL: flow × TE × time (2 passes × 2 s)
  const dep = r.metrics.massBalance.deposited_uL;
  assert(dep <= sprayed * 1.02 && dep > 0.2 * sprayed, `deposited ${dep.toFixed(2)} of ${sprayed.toFixed(2)} µL`);
  near(r.metrics.massBalance.film_uL, dep, 0.02, 'film volume vs deposited');
  return `captured ${(dep / sprayed * 100).toFixed(0)}% of the spray`;
});

test('plasma lowers the contact angle and decays inside a lumen', () => {
  const spec = { geometry: { type: 'catheter', length: 40, od: 3, id: 2 }, surface: 'inner', substrate: 'pp', coating: 'water', grid: { ns: 40, nphi: 8 }, stages: [] };
  const ctx = makeContext(spec);
  const before = ctx.thetaField[20 * 8];
  const r = simulate({ ...spec, stages: [{ type: 'plasma', duration: 20, power: 1, penetrationMm: 5, fromEnd: 'start', holdMinutes: 0 }] });
  const end = r.theta[0], mid = r.theta[20 * 8], far = r.theta[39 * 8];
  assert(end < before - 0.5, 'treated end angle should drop a lot');
  assert(end < mid && mid <= far + 1e-9, 'activation should decay with depth');
  return `water on PP: ${(before * 57.3).toFixed(0)}° → ${(end * 57.3).toFixed(0)}° at the treated end, ${(far * 57.3).toFixed(0)}° at the far end`;
});

test('UV cure follows first-order dose kinetics', () => {
  const spec = {
    geometry: { type: 'coupon', length: 10, width: 10 }, substrate: 'glass', coating: 'acrylate_uv', grid: { ns: 20, nphi: 6 },
    stages: [{ type: 'drip', mode: 'drops', dropUl: 1, count: 1, startMm: 5, endMm: 5, tilt: 90, drainAfter: 0.5 }, { type: 'cure', mode: 'uv', duration: 5, uvIntensity: 100, tilt: 90 }],
  };
  const r = simulate(spec);
  const expected = 1 - Math.exp(-COATINGS.acrylate_uv.cure.kUV * 5);
  near(r.metrics.cureMean, expected, 0.03, 'degree of cure');
  return `α = ${r.metrics.cureMean.toFixed(3)} vs ${expected.toFixed(3)}`;
});

test('viscosity rises with solids and diverges at gelation', () => {
  const c = COATINGS.pvp_water;
  const m0 = viscosity(c, c.solids, 0, 298.15), m1 = viscosity(c, 0.5, 0, 298.15), mg = viscosity(c, c.solids, 0.299, 298.15);
  assert(m1 > 10 * m0, 'solids thickening');
  assert(mg > 100 * m0, 'gelation');
  assert(viscosity(c, c.solids, 0, 350) < m0, 'temperature thinning');
});

test('oven cure includes part heat-up lag (HA thermal crosslink)', () => {
  const tau = 40, Toven = 110 + 273.15, dur = 600;
  const spec = {
    geometry: { type: 'coupon', length: 10, width: 10 }, substrate: 'glass', coating: 'ha_thermal', coatingOverrides: { evap0: 0 }, heatUpSeconds: tau,
    grid: { ns: 20, nphi: 6 },
    stages: [{ type: 'drip', mode: 'drops', dropUl: 1, count: 1, startMm: 5, endMm: 5, tilt: 90, drainAfter: 0.5 }, { type: 'cure', mode: 'thermal', duration: dur, tempC: 110, tilt: 90 }],
  };
  const r = simulate(spec);
  const c = COATINGS.ha_thermal.cure;
  // integrate k(T(t)) with T(t) = Toven - (Toven - 298.15) exp(-t/tau)
  let I = 0; const n = 6000;
  for (let q = 0; q < n; q++) { const t = (q + 0.5) * dur / n; const T = Toven - (Toven - 298.15) * Math.exp(-t / tau); I += c.A1 * Math.exp(-c.Ea1 * 1000 / (8.314 * T)) * dur / n; }
  const expected = 1 - Math.exp(-I);
  near(r.metrics.cureMean, expected, 0.03, 'degree of cure');
  const noLag = 1 - Math.exp(-c.A1 * Math.exp(-c.Ea1 * 1000 / (8.314 * Toven)) * dur);
  return `α = ${r.metrics.cureMean.toFixed(3)} vs ${expected.toFixed(3)} with lag (${noLag.toFixed(3)} if instant)`;
});

test('heated down-draft heats the lumen from the inlet and cures it', () => {
  const spec = {
    geometry: { type: 'catheter', length: 40, od: 3, id: 2 }, surface: 'inner', substrate: 'pp', coating: 'ha_thermal', heatUpSeconds: 20,
    grid: { ns: 40, nphi: 12 },
    stages: [{ type: 'drip', mode: 'bead', lines: 4, startMm: 38, endMm: 2, beadUlS: 2, needleMmS: 5, tilt: 0, drainAfter: 1 },
             { type: 'airflow', duration: 300, airFlowScfh: 30, airTempC: 60, fromEnd: 'start', tilt: 0 }],
  };
  const ctxT = [];
  const r = simulate(spec, { onStepDebug: (fs) => { if (fs.t > 300) ctxT[0] = [fs.Tf[0], fs.Tf[fs.Tf.length - 1]]; } });
  const [Tin, Tout] = ctxT[0];
  assert(Tin > 330 && Tin <= 333.2, 'inlet wall should approach the jet temperature, got ' + (Tin - 273.15).toFixed(1));
  assert(Tout < Tin, 'outlet cooler than inlet');
  const fr = r.frames[r.frames.length - 1], Nj = 12;
  const aIn = fr.alpha[2 * Nj], aOut = fr.alpha[37 * Nj];
  assert(aIn > 0.5 && aIn > 1.3 * aOut, `cure should be high at the inlet and fall downstream (${aIn.toFixed(2)} vs ${aOut.toFixed(2)})`);
  return `wall ${(Tin - 273.15).toFixed(0)} °C at inlet, ${(Tout - 273.15).toFixed(0)} °C at outlet; cure ${(aIn * 100).toFixed(0)}% → ${(aOut * 100).toFixed(0)}%`;
});

test('horizontal cross-jet strips excess liquid near the chosen opening', () => {
  const mk = (jet) => ({
    geometry: { type: 'catheter', length: 20, od: 4, id: 3 }, surface: 'inner', substrate: 'glass', coating: 'silicone_oil_350', coatingOverrides: oil,
    grid: { ns: 40, nphi: 12 },
    stages: [{ type: 'drip', mode: 'drops', dropUl: 4, count: 1, startMm: 19, endMm: 19, tilt: 90, drainAfter: 0.2 },
             { type: 'airflow', duration: 2, nozzleSpeed: 0, crossJetSpeed: jet, crossJetEnd: 'end', crossJetReachMm: 3, tilt: 90 }],
  });
  const a = simulate(mk(0)), b = simulate(mk(30));
  assert(b.metrics.massBalance.dripped_uL > a.metrics.massBalance.dripped_uL + 0.5, 'jet should remove liquid');
  return `removed ${(b.metrics.massBalance.dripped_uL - a.metrics.massBalance.dripped_uL).toFixed(2)} µL of the 4 µL drop`;
});

test('bevelled tip: no liquid in the cut-away region and mass is conserved', () => {
  const spec = {
    geometry: { type: 'catheter', length: 12, od: 3, id: 2, tipBevelDeg: 45 }, surface: 'inner', substrate: 'glass', coating: 'silicone_oil_350', coatingOverrides: oil,
    grid: { ns: 48, nphi: 16 },
    stages: [{ type: 'drip', mode: 'drops', dropUl: 1, count: 1, startMm: 6, endMm: 6, tilt: 90, drainAfter: 0.2 }, { type: 'dwell', duration: 5, tilt: 90 }],
  };
  const ctx = makeContext(spec);
  const nVoid = ctx.geo.voidMask.reduce((a, b) => a + b, 0);
  assert(nVoid > 0, 'bevel should remove cells');
  const r = simulate(spec);
  const fr = r.frames[r.frames.length - 1];
  for (let k = 0; k < fr.h.length; k++) if (ctx.geo.voidMask[k]) assert(fr.h[k] <= 1.01 * 0.05e-6, 'liquid in void cell');
  const mb = r.metrics.massBalance;
  near(mb.film_uL + mb.dripped_uL, mb.deposited_uL, 0.02, 'volume');
  return `${nVoid} cells cut away by the 45° bevel; volume conserved`;
});

test('liquid collecting in a narrow bore bridges into a plug that the air pushes out', () => {
  const spec = {
    geometry: { type: 'catheter', length: 30, od: 2.4, id: 1.6 }, surface: 'inner', substrate: 'glass', coating: 'silicone_oil_350', coatingOverrides: { ...oil, mu0: 0.05 },
    grid: { ns: 60, nphi: 16 },
    stages: [{ type: 'drip', mode: 'pump', startMm: 10, pumpUlS: 20, pumpVolumeUl: 4, lines: 4, tilt: 0, drainAfter: 2 },
             { type: 'airflow', duration: 5, airFlowScfh: 30, airTempC: 25, nozzleDiaMm: 2, captureFrac: 0.5, fromEnd: 'start', tilt: 0 }],
  };
  const r = simulate(spec);
  assert(r.warnings.some((w) => /bridged the bore/.test(w)), 'expected a plug to form: ' + r.warnings.join('; '));
  assert(!r.warnings.some((w) => /still held/.test(w)), 'air should clear the plug');
  // the plug leaves film all round the bore below the dispense point
  const c = r.metrics.circ.mean, mn = Math.min(...c), mx = Math.max(...c);
  assert(mn > 0.2 * mx, `film should go all the way round (min ${mn.toFixed(2)}, max ${mx.toFixed(2)})`);
  return `plug formed and cleared; film around the bore ${mn.toFixed(1)}–${mx.toFixed(1)} µm`;
});

test('blow-off jets aligned with the bevel spare the bevel-face film; misaligned jets thin it', () => {
  const mk = (ang) => ({
    geometry: { type: 'catheter', length: 10, od: 3, id: 2, tipBevelDeg: 45 }, surface: 'outer', substrate: 'glass', coating: 'silicone_oil_350', coatingOverrides: oil,
    grid: { ns: 40, nphi: 16 },
    stages: [{ type: 'dip', speed: 1, dwell: 0, drainAfter: 0, tilt: 0 },
             { type: 'airflow', duration: 40, nozzleSpeed: 0, crossJetSpeed: 25, crossJetEnd: 'end', crossJetReachMm: 1.5, crossJetAngleDeg: ang, tilt: 0 }],
    metrics: { zone: [8, 10] },
  });
  const a = simulate(mk(0)), b = simulate(mk(40));
  assert(b.metrics.wet.mean < 0.9 * a.metrics.wet.mean, `misaligned should thin the bevel film (${b.metrics.wet.mean.toFixed(1)} vs ${a.metrics.wet.mean.toFixed(1)} µm)`);
  return `bevel-zone film ${a.metrics.wet.mean.toFixed(1)} µm aligned vs ${b.metrics.wet.mean.toFixed(1)} µm at 40° misalignment`;
});

run();
