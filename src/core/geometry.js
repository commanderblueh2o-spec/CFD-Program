// Geometry: builds a structured surface grid (axial s x circumferential phi) for the
// coated surface. Lengths in the spec are in mm; everything returned is SI (m).
//
// All parts are described by an axis (body z) and an elliptical cross-section with
// semi-axes a(s) (body x) and b(s) (body y) that may vary along the axis. The coated
// surface is either the outer wall or the inner (lumen) wall. A flat coupon is also
// available for reference cases.

function smoothstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

// Returns {L, a(s), b(s)} in mm for the wall that is being coated (inner or outer).
export function profileFor(spec) {
  const g = spec.geometry;
  const surf = spec.surface || 'outer';
  if (g.type === 'catheter') {
    const L = g.length;
    const tipL = Math.min(g.tipLength || 0, L * 0.9);
    const ro = g.od / 2, ri = g.id / 2;
    const rtip = (g.tipOd || g.od) / 2;
    const rtipI = Math.max(0.05, Math.min(ri, rtip - (ro - ri)));
    const f = (s) => {
      // distal tip at s = L
      const t = tipL > 0 ? smoothstep((s - (L - tipL)) / tipL) : 0;
      if (surf === 'outer') return lerp(ro, rtip, t);
      return lerp(ri, rtipI, t);
    };
    const ell = g.ovality || 1; // b/a ratio
    return { L, a: (s) => f(s), b: (s) => f(s) * ell };
  }
  if (g.type === 'iol_cartridge') {
    // Loading chamber -> conical taper -> nozzle. Inner profile given; outer = inner + wall.
    const Lc = g.chamberLength, Lt = g.taperLength, Ln = g.nozzleLength;
    const L = Lc + Lt + Ln;
    const wall = surf === 'outer' ? g.wall : 0;
    const ac = g.chamberWidth / 2, bc = g.chamberHeight / 2;
    const an = g.nozzleWidth / 2, bn = g.nozzleHeight / 2;
    const at = g.tipWidth / 2, bt = g.tipHeight / 2;
    const prof = (s, c, n, t) => {
      if (s <= Lc) return c;
      if (s <= Lc + Lt) return lerp(c, n, smoothstep((s - Lc) / Lt));
      return lerp(n, t, (s - Lc - Lt) / Ln); // slight nozzle taper toward the tip
    };
    return { L, a: (s) => prof(s, ac, an, at) + wall, b: (s) => prof(s, bc, bn, bt) + wall };
  }
  if (g.type === 'custom') {
    const pts = (g.points || []).slice().sort((p, q) => p[0] - q[0]);
    const L = pts[pts.length - 1][0] - pts[0][0];
    const s0 = pts[0][0];
    const interp = (s, k) => {
      const x = s + s0;
      if (x <= pts[0][0]) return pts[0][k];
      for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i][0]) {
          const t = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
          return lerp(pts[i - 1][k], pts[i][k], t);
        }
      }
      return pts[pts.length - 1][k];
    };
    const wall = surf === 'outer' ? (g.wall || 0) : 0;
    return { L, a: (s) => interp(s, 1) + wall, b: (s) => interp(s, 2) + wall };
  }
  if (g.type === 'coupon') {
    return { L: g.length, a: () => g.width / 2, b: () => 0, flat: true };
  }
  throw new Error('Unknown geometry type ' + g.type);
}

export function buildGeometry(spec) {
  const prof = profileFor(spec);
  const Ni = spec.grid?.ns || 120;
  const flat = !!prof.flat;
  const Nj = spec.grid?.nphi || (flat ? 24 : 40);
  const surf = flat ? 'outer' : (spec.surface || 'outer');
  const Lm = prof.L * 1e-3;
  const ds = Lm / Ni;
  const N = Ni * Nj;
  const dphi = 2 * Math.PI / Nj;
  const s = new Float64Array(Ni);
  const phi = new Float64Array(Nj);
  const A = new Float64Array(Ni), B = new Float64Array(Ni);
  const w = new Float64Array(N);      // cell width in circumferential direction [m]
  const area = new Float64Array(N);
  const kc = new Float64Array(N);     // cross-section curvature [1/m]
  const nrm = new Float64Array(3 * N), es = new Float64Array(3 * N), ep = new Float64Array(3 * N);
  const pos = new Float64Array(3 * N); // position of the wall (body frame, m)
  const crossArea = new Float64Array(Ni), perim = new Float64Array(Ni), rHyd = new Float64Array(Ni);
  for (let j = 0; j < Nj; j++) phi[j] = (j + 0.5) * dphi;
  for (let i = 0; i < Ni; i++) {
    s[i] = (i + 0.5) * ds;
    const smm = s[i] * 1e3;
    A[i] = prof.a(smm) * 1e-3;
    B[i] = prof.b(smm) * 1e-3;
  }
  const deriv = (arr, i) => {
    if (Ni < 2) return 0;
    if (i === 0) return (arr[1] - arr[0]) / ds;
    if (i === Ni - 1) return (arr[Ni - 1] - arr[Ni - 2]) / ds;
    return (arr[i + 1] - arr[i - 1]) / (2 * ds);
  };
  const width = prof.flat ? prof.a(0) * 2e-3 : 0;
  for (let i = 0; i < Ni; i++) {
    const a = A[i], b = B[i];
    const da = deriv(A, i), db = deriv(B, i);
    let P = 0;
    for (let j = 0; j < Nj; j++) {
      const k = i * Nj + j;
      if (flat) {
        const x = -width / 2 + (j + 0.5) * width / Nj;
        w[k] = width / Nj; kc[k] = 0;
        pos.set([x, 0, s[i]], 3 * k);
        nrm.set([0, 1, 0], 3 * k); es.set([0, 0, 1], 3 * k); ep.set([1, 0, 0], 3 * k);
      } else {
        const c = Math.cos(phi[j]), sn = Math.sin(phi[j]);
        const tpx = -a * sn, tpy = b * c;                // d/dphi
        const tsx = da * c, tsy = db * sn, tsz = 1;       // d/ds
        const tpl = Math.hypot(tpx, tpy);
        w[k] = tpl * dphi;
        kc[k] = (a * b) / Math.pow(tpl, 3);
        // outward normal = Tphi x Ts
        let nx = tpy * tsz - 0 * tsy, ny = 0 * tsx - tpx * tsz, nz = tpx * tsy - tpy * tsx;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const sg = surf === 'inner' ? -1 : 1;
        nrm.set([sg * nx, sg * ny, sg * nz], 3 * k);
        const tsl = Math.hypot(tsx, tsy, tsz);
        es.set([tsx / tsl, tsy / tsl, tsz / tsl], 3 * k);
        ep.set([tpx / tpl, tpy / tpl, 0], 3 * k);
        pos.set([a * c, b * sn, s[i]], 3 * k);
      }
      area[k] = w[k] * ds;
      P += w[k];
    }
    perim[i] = P;
    crossArea[i] = flat ? 0 : Math.PI * a * b;
    rHyd[i] = flat ? 0 : 2 * crossArea[i] / P; // = D_h / 2
  }
  // Bevelled tip (IOL cartridge nozzles): the tube end is cut by a plane at `tipBevelDeg`
  // from square. Cells beyond the cut do not exist (void). edgeEnd = axial distance from a
  // cell to the open tip edge (along its own generator line).
  const voidMask = new Uint8Array(N);
  const edgeEnd = new Float64Array(N);
  const bev = !flat ? ((spec.geometry.tipBevelDeg || 0) * Math.PI) / 180 : 0;
  const cb = (((spec.geometry.bevelClockDeg ?? 270) * Math.PI) / 180);
  const aT = A[Ni - 1], bT = B[Ni - 1];
  const qmax = Math.hypot(aT * Math.cos(cb), bT * Math.sin(cb));
  for (let i = 0; i < Ni; i++) {
    for (let j = 0; j < Nj; j++) {
      const k = i * Nj + j;
      let sCut = Lm;
      if (bev > 0) {
        const q = pos[3 * k] * Math.cos(cb) + pos[3 * k + 1] * Math.sin(cb);
        const qT = (q / Math.max(Math.hypot(A[i] * Math.cos(cb), B[i] * Math.sin(cb)), 1e-12)) * qmax;
        sCut = Lm - (qmax - qT) * Math.tan(Math.min(bev, 1.4));
      }
      edgeEnd[k] = sCut - s[i];
      if (edgeEnd[k] < 0) voidMask[k] = 1;
    }
  }
  // last existing cell of each generator line (where liquid leaves the tip)
  const endCell = new Int32Array(Nj);
  for (let j = 0; j < Nj; j++) { let ii = Ni - 1; while (ii > 0 && voidMask[ii * Nj + j]) ii--; endCell[j] = ii; }
  return {
    spec, surface: surf, flat, periodic: !flat, Ni, Nj, N, ds, dphi, L: Lm, s, phi, A, B,
    w, area, kc, nrm, es, ep, pos, crossArea, perim, rHyd, voidMask, edgeEnd, endCell, hasVoid: voidMask.some((v) => v),
  };
}

// Gravity vector in the body frame for a part whose axis is tilted `tiltDeg` from
// vertical (0 = axis vertical with s=0 at the top, 90 = horizontal) and rotated about
// its own axis by `psi` radians. "Down" for a horizontal part at psi=0 is body -y.
export function gravityBody(tiltDeg, psi, g = 9.81) {
  const b = tiltDeg * Math.PI / 180;
  return [g * Math.sin(b) * Math.sin(psi), -g * Math.sin(b) * Math.cos(psi), g * Math.cos(b)];
}

// ---------------------------------------------------------------------------------------
// Axial profile import (e.g. a measured cartridge bore). Accepts CSV/TSV/semicolon or
// whitespace-separated text with an optional header row and returns custom-geometry points
// [s, halfWidth, halfHeight] in mm, starting at s = 0.
//
// Header names pick the columns and their meaning:
//   position: s, z, x, pos, position, axial, distance, depth
//   full size: diameter, dia, d, id, od, bore, width, w, height, h, major, minor
//   half size: radius, r, half-width, semi-axis, a, b
// Units in the header ("s (mm)", "D [um]", "r_in") scale to mm: mm, µm/um, cm, m, in.
// Without a header the columns are read as s, half-width[, half-height] in mm (the same as
// the profile text box) unless opts.dims = 'full' (diameters / full widths).
// Options: dims 'auto'|'half'|'full', flip (true = data measured from the tip; s is
// reversed so s = 0 is the wide proximal end), maxPoints (bin-averaged above this).
const PROFILE_UNITS = [[/(µm|um|micron)/, 1e-3], [/\bmm\b|_mm\b|\(mm\)|\[mm\]|mm$/, 1], [/\bcm\b|_cm\b|\(cm\)|\[cm\]/, 10], [/\b(in|inch|inches)\b|_in\b|\(in\)|\[in\]|"/, 25.4], [/\bm\b|\(m\)|\[m\]|_m\b/, 1000]];

function profileUnit(name) {
  for (const [re, f] of PROFILE_UNITS) if (re.test(name)) return f;
  return null;
}

function profileRole(name) {
  const n = name.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[_\-]+/g, ' ').trim();
  const w = n.split(/\s+/)[0] || '';
  if (/^(s|z|x|pos|position|axial|distance|dist|depth|length|station)$/.test(w) || /axial|position|distance/.test(n)) return 'pos';
  const half = /radius|half|semi/.test(n) || /^(r|ri|ro|a|b)$/.test(w);
  let axis = null;
  if (/height|minor|\bh\b|^b$|vert|\by\b/.test(n) || /^(h|b|y)$/.test(w)) axis = 'h';
  else if (/width|major|\bw\b|^a$|horiz|\bx\b/.test(n) || /^(w|a)$/.test(w)) axis = 'w';
  if (half) return axis === 'h' ? 'hh' : axis === 'w' ? 'hw' : 'r';
  if (/diam|bore|^(d|id|od|dia|di|do)$/.test(w) || /diam/.test(n)) return 'd';
  if (axis === 'h') return 'fh';
  if (axis === 'w') return 'fw';
  return null;
}

export function parseProfileCSV(text, opts = {}) {
  const dims = opts.dims || 'auto';
  const maxPoints = opts.maxPoints || 240;
  const notes = [];
  const lines = String(text || '').replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const rows = [];
  let header = null, skipped = 0;
  const num = (t) => { const v = Number(t); return t !== '' && isFinite(v) ? v : NaN; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    let cells;
    if (line.includes(';')) cells = line.split(';').map((c) => c.trim().replace(/^"|"$/g, '').replace(/(\d),(\d)/g, '$1.$2'));
    else if (line.includes('\t')) cells = line.split('\t').map((c) => c.trim().replace(/^"|"$/g, ''));
    else if (line.includes(',')) cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    else cells = line.split(/\s+/);
    cells = cells.filter((c, i) => c !== '' || i < cells.length - 1);
    const vals = cells.map(num);
    if (vals.length >= 2 && vals.every((v) => !isNaN(v))) { rows.push(vals); continue; }
    if (!header && !rows.length) { header = cells; continue; }
    skipped++;
  }
  if (skipped) notes.push(`${skipped} non-numeric line${skipped > 1 ? 's' : ''} skipped`);
  if (rows.length < 2) throw new Error('Need at least two numeric rows (position and size).');
  const ncol = Math.min(...rows.map((r) => r.length));
  // Column assignment
  let iPos = 0, iW = 1, iH = ncol >= 3 ? 2 : 1, kind = dims === 'full' ? 'full' : 'half';
  let scale = [1, 1, 1];
  if (header) {
    const roles = header.map(profileRole);
    const units = header.map(profileUnit);
    const find = (...rs) => roles.findIndex((r, i) => i < ncol && rs.includes(r));
    const p = find('pos');
    iPos = p >= 0 ? p : 0;
    const cols = [];
    for (const [a, b, k] of [['fw', 'fh', 'full'], ['hw', 'hh', 'half']]) {
      const x = find(a), y = find(b);
      if (x >= 0 || y >= 0) { cols.push([x >= 0 ? x : y, y >= 0 ? y : x, k]); break; }
    }
    if (!cols.length) {
      const d = find('d'), r = find('r');
      if (d >= 0) cols.push([d, d, 'full']);
      else if (r >= 0) cols.push([r, r, 'half']);
    }
    if (cols.length) [iW, iH, kind] = cols[0];
    else {
      const rest = [...Array(ncol).keys()].filter((i) => i !== iPos);
      iW = rest[0]; iH = rest[1] ?? rest[0];
      if (dims === 'auto') notes.push('Column meaning not recognised from the header; read as half-width/half-height');
    }
    if (dims !== 'auto') kind = dims;
    const defU = units.find((u, i) => u != null && i < ncol);
    scale = [iPos, iW, iH].map((i) => units[i] ?? defU ?? 1);
    if (units.every((u) => u == null)) notes.push('No units in the header; read as mm');
  } else {
    if (ncol > 3) notes.push(`Only the first three of ${ncol} columns used`);
    notes.push(dims === 'full' ? 'No header: read as s, width[, height] in mm (full sizes)' : 'No header: read as s, half-width[, half-height] in mm');
  }
  const f = kind === 'full' ? 0.5 : 1;
  let pts = rows.map((r) => [r[iPos] * scale[0], r[iW] * scale[1] * f, r[iH] * scale[2] * f]);
  if (iW === iH) notes.push('Round section (one size column)');
  if (kind === 'full') notes.push('Sizes read as diameters/full widths and halved');
  // Orientation: s = 0 is the proximal (wide, upper) end.
  const descending = pts[pts.length - 1][0] < pts[0][0];
  if (opts.flip) { const sMax = Math.max(...pts.map((p) => p[0])); pts = pts.map((p) => [sMax - p[0], p[1], p[2]]); notes.push('Reversed: measured from the tip'); }
  pts.sort((p, q) => p[0] - q[0]);
  if (descending && !opts.flip) notes.push('Positions were descending; sorted ascending');
  // Merge repeated positions (average)
  const merged = [];
  for (const p of pts) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(p[0] - last.s) < 1e-9) { last.a += p[1]; last.b += p[2]; last.n++; }
    else merged.push({ s: p[0], a: p[1], b: p[2], n: 1 });
  }
  if (merged.length < pts.length) notes.push(`${pts.length - merged.length} repeated position${pts.length - merged.length > 1 ? 's' : ''} averaged`);
  pts = merged.map((m) => [m.s, m.a / m.n, m.b / m.n]);
  if (pts.length < 2) throw new Error('Need at least two distinct positions.');
  const bad = pts.findIndex((p) => !(p[1] > 0 && p[2] > 0));
  if (bad >= 0) throw new Error(`Size must be positive (row at s = ${pts[bad][0]}).`);
  const s0 = pts[0][0];
  if (Math.abs(s0) > 1e-9) { pts = pts.map((p) => [p[0] - s0, p[1], p[2]]); notes.push(`Shifted to start at s = 0 (was ${+s0.toFixed(4)} mm)`); }
  const L = pts[pts.length - 1][0];
  if (!(L > 0.5)) throw new Error('Profile is shorter than 0.5 mm — check the units.');
  if (L > 2000) throw new Error(`Profile is ${Math.round(L)} mm long — check the units.`);
  const rMax = Math.max(...pts.map((p) => Math.max(p[1], p[2])));
  if (rMax > 100) throw new Error(`Half-size up to ${Math.round(rMax)} mm — check the units.`);
  // Dense measured data: bin-average onto maxPoints stations (keeps both ends exactly).
  if (pts.length > maxPoints) {
    const n0 = pts.length, out = [pts[0]];
    const nb = maxPoints - 2, h = L / nb;
    for (let k = 0; k < nb; k++) {
      const lo = k * h, hi = (k + 1) * h;
      const inBin = pts.filter((p, i) => i > 0 && i < n0 - 1 && p[0] >= lo && (p[0] < hi || (k === nb - 1 && p[0] <= hi)));
      if (!inBin.length) continue;
      const m = (j) => inBin.reduce((acc, p) => acc + p[j], 0) / inBin.length;
      out.push([m(0), m(1), m(2)]);
    }
    out.push(pts[n0 - 1]);
    pts = out;
    notes.push(`${n0} points averaged down to ${pts.length}`);
  }
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  pts = pts.map((p) => p.map(r4));
  return { points: pts, notes, length: r4(L), kind };
}

// Inverse of the profile text format, as CSV with a header (round-trips through parseProfileCSV).
export function profileToCSV(points) {
  return 's_mm,half_width_mm,half_height_mm\n' + points.map((p) => p.join(',')).join('\n') + '\n';
}
