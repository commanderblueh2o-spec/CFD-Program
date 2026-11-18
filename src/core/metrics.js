// Post-processing: film statistics, profiles, defect detection and key dimensionless groups.

import { capillaryLength, dipFilmOuter, brethertonFilm, viscosity, G0 } from './physics.js';

function weightedStats(vals, wts) {
  let W = 0, s = 0;
  for (let i = 0; i < vals.length; i++) { W += wts[i]; s += vals[i] * wts[i]; }
  const mean = W > 0 ? s / W : 0;
  let v = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < vals.length; i++) { v += wts[i] * (vals[i] - mean) ** 2; mn = Math.min(mn, vals[i]); mx = Math.max(mx, vals[i]); }
  const std = W > 0 ? Math.sqrt(v / W) : 0;
  const sorted = vals.map((x, i) => [x, wts[i]]).sort((a, b) => a[0] - b[0]);
  const pct = (p) => { let acc = 0; for (const [x, w] of sorted) { acc += w; if (acc >= p * W) return x; } return sorted.length ? sorted[sorted.length - 1][0] : 0; };
  return { mean, std, cov: mean > 0 ? std / mean : 0, min: isFinite(mn) ? mn : 0, max: isFinite(mx) ? mx : 0, p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), area: W };
}

export function dryThickness(ctx) {
  const { fs, coat } = ctx;
  const N = fs.h.length, out = new Float64Array(N);
  const sh = coat.shrink || 0;
  for (let k = 0; k < N; k++) {
    const film = fs.h[k] > 4 * fs.hp;
    out[k] = film ? fs.m[k] * (1 - sh * fs.alpha[k]) : 0;
  }
  return out;
}

export function computeMetrics(ctx, stages) {
  const { geo, fs, coat, spec } = ctx;
  const { Ni, Nj } = geo;
  const zone = spec.metrics?.zone || [0, geo.L * 1e3];
  const z0 = zone[0] * 1e-3, z1 = zone[1] * 1e-3;
  const dry = dryThickness(ctx);
  const wet = new Float64Array(geo.N);
  for (let k = 0; k < geo.N; k++) wet[k] = Math.max(0, fs.h[k] - fs.hp);
  const zv = [], zd = [], zw = [], za = [], zalpha = [];
  const axial = { s: [], mean: [], min: [], max: [], wetMean: [] };
  const circ = new Float64Array(Nj), circW = new Float64Array(Nj);
  for (let i = 0; i < Ni; i++) {
    let am = 0, aw = 0, mn = Infinity, mx = 0, wm = 0;
    for (let j = 0; j < Nj; j++) {
      const k = i * Nj + j, a = geo.area[k];
      if (geo.voidMask && geo.voidMask[k]) continue;
      am += dry[k] * a; wm += wet[k] * a; aw += a; mn = Math.min(mn, dry[k]); mx = Math.max(mx, dry[k]);
      if (geo.s[i] >= z0 && geo.s[i] <= z1) {
        zd.push(dry[k]); zw.push(wet[k]); za.push(a); zalpha.push(fs.alpha[k]); zv.push(k);
        circ[j] += dry[k] * a; circW[j] += a;
      }
    }
    axial.s.push(geo.s[i] * 1e3); axial.mean.push(aw > 0 ? (am / aw) * 1e6 : 0); axial.min.push(isFinite(mn) ? mn * 1e6 : 0); axial.max.push(mx * 1e6); axial.wetMean.push(aw > 0 ? (wm / aw) * 1e6 : 0);
  }
  const circProfile = { phiDeg: Array.from(geo.phi, (p) => (p * 180) / Math.PI), mean: Array.from(circ, (c, j) => (circW[j] ? (c / circW[j]) * 1e6 : 0)) };
  const D = weightedStats(zd, za);
  const W = weightedStats(zw, za);
  const toUm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'cov' ? v : k === 'area' ? v * 1e6 : v * 1e6]));
  const dryUm = toUm(D), wetUm = toUm(W);
  dryUm.area = D.area * 1e6; // mm^2
  const minDry = (spec.metrics?.minDryUm ?? Math.max(0.25 * (dryUm.p50 > 0 ? dryUm.p50 : dryUm.mean), 0.01)) * 1e-6;
  let covA = 0, dewetA = 0, Atot = 0, alphaMean = 0, filmA = 0;
  for (let n = 0; n < zv.length; n++) {
    const k = zv[n];
    Atot += za[n];
    if (zd[n] >= minDry) covA += za[n];
    // dewetted: carried liquid at some point but is now bare (no solids left behind)
    if (fs.wetted[k] && fs.h[k] < 4 * fs.hp && fs.m[k] < 1e-9) dewetA += za[n];
    if (zd[n] > 0) { alphaMean += zalpha[n] * za[n]; filmA += za[n]; }
  }
  alphaMean /= Math.max(filmA, 1e-30);
  const coverage = Atot > 0 ? covA / Atot : 0;
  const dewetFrac = Atot > 0 ? dewetA / Atot : 0;

  // ---------- dimensionless groups and analytic predictions
  const gamma = (coat.d + coat.p) * 1e-3;
  const mu0 = viscosity(coat, coat.solids, 0, 298.15);
  const lc = capillaryLength(gamma, coat.rho);
  const Rmean = geo.flat ? Infinity : geo.rHyd.reduce((a, b) => a + b, 0) / Ni;
  const groups = {
    surfaceTension_mNm: gamma * 1e3, viscosity_mPas: mu0 * 1e3, capillaryLength_mm: lc * 1e3,
    contactAngleMean_deg: (ctx.thetaMean * 180) / Math.PI,
    contactAngleMin_deg: (Math.min(...ctx.thetaField) * 180) / Math.PI,
    contactAngleMax_deg: (Math.max(...ctx.thetaField) * 180) / Math.PI,
    bond: isFinite(Rmean) ? (coat.rho * G0 * Rmean * Rmean) / gamma : null,
  };
  const predictions = [];
  for (const st of stages) {
    if (st.type === 'dip') {
      const film = (v) => { const U = v * 1e-3; return geo.surface === 'inner' ? brethertonFilm(Rmean, mu0, U, gamma) : dipFilmOuter(mu0, U, gamma, coat.rho, geo.flat ? Infinity : Rmean); };
      const Ca = (mu0 * st.speed * 1e-3) / gamma, h = film(st.speed);
      const law = geo.surface === 'inner' ? 'Bretherton' : 'LLD/fibre';
      if (st.mode === 'ramp' || st.mode === 'steps') {
        const vEnd = st.speedEnd ?? st.speed, hE = film(vEnd);
        predictions.push({ stage: st.label || 'dip', text: `Profiled withdrawal ${st.speed}→${vEnd} mm/s: entrained wet film ≈ ${(h * 1e6).toFixed(2)} µm at the first-withdrawn end and ${(hE * 1e6).toFixed(2)} µm at the last (${law} law, ∝ speed^2/3) → dry ≈ ${(h * coat.solids * 1e6).toFixed(2)}–${(hE * coat.solids * 1e6).toFixed(2)} µm before drainage` });
      } else predictions.push({ stage: st.label || 'dip', text: `Ca = ${Ca.toExponential(2)}; entrained wet film ≈ ${(h * 1e6).toFixed(2)} µm (${law} law) → dry ≈ ${(h * coat.solids * 1e6).toFixed(2)} µm before drainage` });
    }
    if (st.type === 'vacuum' && geo.surface === 'inner') {
      predictions.push({ stage: st.label || 'vacuum', text: `Plug pulled at ${st.pressureKpa} kPa. Bretherton film thickens as Ca^(2/3): halving meniscus speed thins the film by ~37%.` });
    }
  }
  if (geo.surface === 'inner' && isFinite(Rmean)) {
    const jur = (2 * gamma * Math.cos(ctx.thetaMean)) / (coat.rho * G0 * Rmean);
    groups.jurinHeight_mm = jur * 1e3;
  }

  // ---------- defects
  const defects = [];
  const add = (severity, title, detail, fix) => defects.push({ severity, title, detail, fix });
  if (dryUm.mean <= 1e-6) add('high', 'No film formed', 'Nothing was deposited in the evaluation zone.', 'Check the stage sequence: the zone may not be reached by the applicator, or the surface (inner/outer) may not match the process.');
  if (coverage < 0.98 && dryUm.mean > 0) add(coverage < 0.85 ? 'high' : 'medium', 'Incomplete coverage', `${((1 - coverage) * 100).toFixed(1)}% of the zone is below ${(minDry * 1e6).toFixed(2)} µm dry.`, 'Lower the contact angle (plasma treat, add surfactant / lower-tension solvent), add liquid, or improve applicator reach.');
  if (dewetFrac > 0.005) add(dewetFrac > 0.05 ? 'high' : 'medium', 'Dewetting', `${(dewetFrac * 100).toFixed(1)}% of the wetted zone retracted to a bare surface.`, `Mean equilibrium contact angle is ${groups.contactAngleMean_deg.toFixed(0)}°. Plasma activation or a primer raises the substrate polar energy; faster drying freezes the film before it can retract.`);
  if (dryUm.cov > 0.25 && dryUm.mean > 0) add(dryUm.cov > 0.5 ? 'high' : 'medium', 'Poor uniformity', `Coefficient of variation ${(dryUm.cov * 100).toFixed(0)}% (P5 ${dryUm.p5.toFixed(2)} µm, P95 ${dryUm.p95.toFixed(2)} µm).`, 'The Charts tab shows whether the variation runs along the part or around it.');
  // axial gradient
  const am = axial.mean.filter((_, i) => geo.s[i] >= z0 && geo.s[i] <= z1);
  if (am.length > 6) {
    const third = Math.floor(am.length / 3);
    const top = am.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const bot = am.slice(-third).reduce((a, b) => a + b, 0) / third;
    const ratio = Math.max(top, bot) / Math.max(Math.min(top, bot), 1e-9);
    if (ratio > 1.3 && dryUm.mean > 0) add(ratio > 2 ? 'high' : 'medium', 'Axial thickness gradient', `One end is ${ratio.toFixed(2)}× thicker than the other (${top.toFixed(2)} vs ${bot.toFixed(2)} µm).`, 'Typical of gravity drainage or speed-dependent deposition: use a speed ramp, invert the part between stages, shorten time-to-set (faster solvent, heat).');
    // beading: count pronounced local maxima
    let peaks = 0;
    for (let i = 1; i < am.length - 1; i++) if (am[i] > am[i - 1] && am[i] > am[i + 1] && am[i] > 1.5 * dryUm.mean) peaks++;
    if (peaks >= 3) add('high', 'Beading (Rayleigh–Plateau)', `${peaks} periodic thick collars/beads along the axis.`, 'Capillary instability on small radii: reduce wet thickness, increase viscosity build (faster drying), or use a lower surface tension coating.');
  }
  // circumferential sag
  if (!geo.flat && Nj >= 8) {
    const cm = circProfile.mean, mx = Math.max(...cm), mn = Math.min(...cm);
    const horiz = stages.some((st) => ['dip', 'spray', 'drip', 'vacuum', 'dwell', 'airflow'].includes(st.type) && (st.tilt ?? 90) > 45 && (st.tilt ?? 90) < 135);
    const fixC = horiz
      ? 'Gravity drains the film toward the low side of a horizontal part: hold it vertically, or let the film set faster (heat, faster solvent).'
      : 'Liquid stays near where it was applied (vertical, stationary part): add more bead lines / needles around the bore, lower the contact angle (plasma) or the viscosity so it spreads before it sets.';
    if (mn >= 0 && mx > 1.4 * Math.max(mn, 1e-9) && dryUm.mean > 0) add(mx > 2.5 * mn ? 'high' : 'medium', horiz ? 'Circumferential sag' : 'Uneven around the circumference', `Around the circumference the film varies ${mn.toFixed(2)}–${mx.toFixed(2)} µm.`, fixC);
  }
  // edge beads
  const endMean = (i) => axial.mean[i];
  if (Ni > 4 && dryUm.mean > 0) {
    const e = Math.max(endMean(0), endMean(Ni - 1));
    if (e > 2.5 * dryUm.mean) add('medium', 'Edge bead / drip line', `End thickness ${e.toFixed(2)} µm vs mean ${dryUm.mean.toFixed(2)} µm.`, 'Liquid accumulates at an edge: wick or blow off the end, slow the final withdrawal, or exclude the end from the functional zone.');
  }
  if (coat.cure?.model !== 'none' && dryUm.mean > 0) {
    if (alphaMean < 0.9) add(alphaMean < 0.5 ? 'high' : 'medium', 'Under-cured', `Mean degree of cure ${(alphaMean * 100).toFixed(0)}%.`, coat.cure.model === 'uv' ? 'Increase UV dose (intensity × time) or wall transmission for lumen coatings.' : 'Raise oven temperature or extend cure time.');
  }
  if (coat.solids < coat.phiMax) {
    let solvA = 0, solvW = 0;
    for (let n = 0; n < zv.length; n++) { const k = zv[n]; if (fs.h[k] > 4 * fs.hp) { solvA += (1 - fs.m[k] / fs.h[k] / coat.phiMax) * za[n]; solvW += za[n]; } }
    const residual = solvW > 0 ? solvA / solvW : 0;
    if (residual > 0.05) add('medium', 'Film still wet / residual solvent', `About ${(residual * 100).toFixed(0)}% of the final film is still solvent.`, ctx.geo.surface === 'inner' ? 'Solvent escapes slowly from lumens: add an airflow stage, raise temperature, or extend flash-off.' : 'Extend flash-off or raise temperature / airflow before cure.');
    if (residual > 0.05 && coat.cure?.model !== 'none' && alphaMean > 0.5) add('medium', 'Solvent entrapment risk', 'The film cured while still holding solvent.', 'Insert a flash-off stage before cure.');
  }
  if (ctx.poolReport && (ctx.poolReport.uL > 0.3 || ctx.poolReport.dryUm > 3 * Math.max(dryUm.p50, 0.05))) {
    const P = ctx.poolReport;
    add(P.uL > 1 ? 'high' : 'medium', `Coating pooled at the ${P.side === 1 ? 'tip' : 'top'}`, `${P.uL.toFixed(1)} µL collected at the opening and dried there (~${P.dryUm.toFixed(0)} µm dry over the last ${P.reachMm.toFixed(1)} mm).`, `Surface tension holds it; horizontal jets above ~${P.jetScfh.toFixed(1)} SCFH through ${P.jetDiaMm.toFixed(1)} mm nozzles (≈${P.jet.toFixed(0)} m/s) aimed along the bevel blow it out, or reduce the wall excess with a slower withdraw.`);
  }
  for (const w of ctx.warnings || []) if (!/pooled at the/.test(w)) add('info', 'Process note', w, '');

  return {
    zoneMm: zone, dry: dryUm, wet: wetUm, coverage, dewetFraction: dewetFrac, cureMean: alphaMean,
    axial, circ: circProfile, groups, predictions, defects,
    dryField: Float32Array.from(dry, (x) => x * 1e6),
    massBalance: {
      deposited_uL: fs.stats.deposited * 1e9, evaporated_uL: fs.stats.evaporated * 1e9,
      dripped_uL: fs.stats.dripped * 1e9, film_uL: fs.volume() * 1e9, solids_uL: fs.solidsVolume() * 1e9,
    },
  };
}
