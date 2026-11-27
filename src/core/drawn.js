import { tipPoolBody, rowOfS, rowEdges } from './geometry.js';

// Geometry of the drawn coating (shared by the 3D view and the volume checks).
//
// The 3D view draws the wall at its true position and the coating as a second surface standing
// off it. This module builds both surfaces on the render mesh (rows at the cell centres, the
// first and last rows at the true ends of the part, SUB render columns per cell around the
// circumference, vertices clamped onto a bevel cut), so the view and the tests use the same
// numbers. `meshVolume` integrates the liquid between the two surfaces, which lets a test check
// that what is drawn at true scale holds the volume the solver's mass balance says is there.

// Coating surface point for a wall point (x, y) with unit normal (nx, ny) pointing into the
// liquid side, drawn thickness dd (m) and flood fraction fl. Flat coupons: offset along the
// normal. Tubes: the point moves along its radius by a fraction t (toward the axis in a bore). The solver's
// film holds dd × (wall area) of liquid; the wedge between the wall and the coating holds
// r²(1 − (1 − t)²)/2 per unit angle and the wall arc is r/cosβ per unit angle (β between the
// wall normal and the radius), so t = 1 − √(1 − 2dd/(r cosβ)) draws exactly that volume in a
// round or oval bore, also when a thick film fills much of it (outside a tube the wedge grows,
// t = √(1 + 2dd/(r cosβ)) − 1). A full bore (fl) goes to the
// axis, and no film is drawn past it.
export function coatPoint(x, y, nx, ny, dd, fl, inner, flat = false) {
  if (flat) return [x + nx * dd, y + ny * dd];
  const r = Math.hypot(x, y) || 1e-12, cb = Math.max(0.2, Math.abs((x * nx + y * ny) / r));
  const q = (2 * dd) / (r * cb);
  if (!inner) { const t = Math.sqrt(1 + q) - 1; return [x * (1 + t), y * (1 + t)]; } // outer: r²((1 + t)² − 1)/2 per unit angle
  const t = fl > 0.5 ? 0.999 : q >= 0.9991 ? 0.97 : Math.min(0.97, 1 - Math.sqrt(1 - q));
  return [x * (1 - t), y * (1 - t)];
}

// Monotone (Fritsch–Butland / PCHIP) node slopes of the drawn thickness along each cell column.
// sAt: cell-centre positions; val(i): value of the column at cell row i. End slopes are zero (the
// half cells at the ends are drawn flat), and so is the slope at any local extremum, so the
// interpolant never overshoots: a film front or contact line is drawn as a smooth S between the
// thick and the thin cell, without negative thickness or invented ridges.
function pchipSlopes(sAt, n, val, out) {
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) { out[i] = 0; continue; }
    const h0 = sAt[i] - sAt[i - 1], h1 = sAt[i + 1] - sAt[i];
    const d0 = (val(i) - val(i - 1)) / h0, d1 = (val(i + 1) - val(i)) / h1;
    if (d0 * d1 <= 0) { out[i] = 0; continue; }
    const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    out[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
  }
}

// geo: built or serialised geometry. d: per-cell drawn thickness (m, already magnified) or null.
// fill: per-cell 0/1 (bore full of liquid) or null. Render rows sit at the cell centres, with
// opts.rsub − 1 extra rows between neighbouring centres (default 3 render rows per cell), plus
// one row at each true end of the part carrying the end cell's value (on a flat coupon the columns
// get the same two edge columns). Along the part the thickness is a monotone cubic (PCHIP) through
// the cell-centre values with zero slope at the end centres; over each segment a cubic Hermite
// holds ds(d₀ + d₁)/2 + ds²(m₀ − m₁)/12 and the slope terms cancel between segments, so the drawn
// layer holds the same volume as with straight lines between the centres (= Σ film × area), but
// fronts and contact lines are smooth instead of kinked. Around the circumference values are
// blended linearly over SUB render columns per cell. Returns body-frame coordinates in metres (the
// view applies its radius magnifier to x and y afterwards); per render row the two cell rows it
// lies between (rowI0, rowI1, rowT) and the interpolated semi-axes (rowA, rowB); per vertex the
// drawn thickness and flood fraction (dd, fl) and four cells with bilinear weights (blend4, w4)
// for colours.
export function coatingMesh(geo, d, fill, opts = {}) {
  const { Ni, Nj, flat } = geo;
  const SUB = flat ? 1 : opts.sub || 4;
  const RS = Ni > 1 ? Math.max(1, Math.round(opts.rsub || 3)) : 1;
  const cols = flat ? Nj + 2 : Nj * SUB + 1, rows = Ni + 2 + (Ni - 1) * (RS - 1);
  const inner = geo.surface === 'inner' && !flat;
  const vm = geo.voidMask, ee = geo.edgeEnd;
  const lastRow = new Int32Array(Nj);
  for (let j = 0; j < Nj; j++) { let r = Ni - 1; while (r > 0 && vm && vm[r * Nj + j]) r--; lastRow[j] = r; }
  const cutAtCell = (j) => (ee ? geo.s[lastRow[j]] + ee[lastRow[j] * Nj + j] : geo.L);
  const cutS = new Float64Array(cols);
  for (let u = 0; u < cols; u++) {
    if (flat) { cutS[u] = geo.L; continue; }
    const j = Math.floor(u / SUB) % Nj, f = (u % SUB) / SUB, j2 = (j + 1) % Nj;
    cutS[u] = Math.min(geo.L, cutAtCell(j) * (1 - f) + cutAtCell(j2) * f);
  }
  // render row → axial position, the cell rows it lies between and the local semi-axes
  const rowZ = new Float64Array(rows), rowI = new Int32Array(rows), rowI0 = new Int32Array(rows), rowI1 = new Int32Array(rows);
  const rowT = new Float64Array(rows), rowA = new Float64Array(rows), rowB = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    let i0, i1, t;
    if (r === 0) { i0 = i1 = 0; t = 0; }
    else if (r === rows - 1) { i0 = i1 = Ni - 1; t = 0; }
    else { const q = r - 1, a = Math.min(Ni - 1, Math.floor(q / RS)); i0 = a; t = a === Ni - 1 ? 0 : (q - a * RS) / RS; i1 = t > 0 ? a + 1 : a; }
    rowI0[r] = i0; rowI1[r] = i1; rowT[r] = t; rowI[r] = t < 0.5 ? i0 : i1;
    rowZ[r] = r === 0 ? 0 : r === rows - 1 ? geo.L : geo.s[i0] * (1 - t) + geo.s[i1] * t;
    rowA[r] = geo.A ? geo.A[i0] * (1 - t) + geo.A[i1] * t : 0;
    rowB[r] = geo.B ? (geo.B[i0] || geo.A[i0]) * (1 - t) + (geo.B[i1] || geo.A[i1]) * t : rowA[r];
  }
  // flat coupon: column → x and cell column
  let colX = null, colJ = null;
  if (flat) {
    colX = new Float64Array(cols); colJ = new Int32Array(cols);
    const x0 = geo.pos[0], x1 = Nj > 1 ? geo.pos[3] : x0 + 1e-3, hw = 0.5 * (x1 - x0);
    for (let u = 0; u < cols; u++) { const j = Math.max(0, Math.min(Nj - 1, u - 1)); colJ[u] = j; colX[u] = u === 0 ? x0 - hw : u === cols - 1 ? geo.pos[3 * (Nj - 1)] + hw : geo.pos[3 * j]; }
  }
  const cellOf = (i, j) => (flat ? i : Math.min(i, lastRow[j])) * Nj + j;
  // PCHIP slopes of the drawn thickness along every cell column (cells past a bevel cut repeat the
  // last uncut cell, so the slope there is zero)
  const slope = new Float64Array(geo.N || Ni * Nj);
  if (d && RS > 1) {
    const col = new Float64Array(Ni);
    for (let j = 0; j < Nj; j++) { pchipSlopes(geo.s, Ni, (i) => d[cellOf(i, j)], col); for (let i = 0; i < Ni; i++) slope[i * Nj + j] = col[i]; }
  }
  const dAt = (r, j) => { // drawn thickness of cell column j at render row r (monotone cubic in s)
    const i0 = rowI0[r], i1 = rowI1[r], t = rowT[r], a = d[cellOf(i0, j)];
    if (t === 0) return a;
    const b = d[cellOf(i1, j)], h = geo.s[i1] - geo.s[i0], t2 = t * t, t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * h * slope[i0 * Nj + j] + (-2 * t3 + 3 * t2) * b + (t3 - t2) * h * slope[i1 * Nj + j];
    return Math.max(0, v);
  };
  const n = rows * cols, wall = new Float64Array(3 * n), coat = new Float64Array(3 * n), nrm = new Float64Array(2 * n);
  const blend4 = new Int32Array(4 * n), w4 = new Float32Array(4 * n), ddv = new Float64Array(n), flv = new Float64Array(n);
  for (let r = 0; r < rows; r++) {
    const i0 = rowI0[r], i1 = rowI1[r], t = rowT[r], z = rowZ[r];
    for (let u = 0; u < cols; u++) {
      const v = r * cols + u;
      let j, j2, f;
      if (flat) { j = j2 = colJ[u]; f = 0; }
      else { const jf = u / SUB; j = Math.floor(jf) % Nj; j2 = (j + 1) % Nj; f = jf - Math.floor(jf); }
      const c00 = cellOf(i0, j), c01 = cellOf(i0, j2), c10 = cellOf(i1, j), c11 = cellOf(i1, j2);
      blend4[4 * v] = c00; blend4[4 * v + 1] = c01; blend4[4 * v + 2] = c10; blend4[4 * v + 3] = c11;
      w4[4 * v] = (1 - f) * (1 - t); w4[4 * v + 1] = f * (1 - t); w4[4 * v + 2] = (1 - f) * t; w4[4 * v + 3] = f * t;
      const dd = d ? dAt(r, j) * (1 - f) + (f > 0 ? dAt(r, j2) * f : 0) : 0;
      const fl = fill ? (fill[c00] * (1 - f) + fill[c01] * f) * (1 - t) + (fill[c10] * (1 - f) + fill[c11] * f) * t : 0;
      ddv[v] = dd; flv[v] = fl;
      const zz = Math.min(z, cutS[u]);
      let x, y, nx, ny;
      if (flat) { const k = c00; x = colX[u]; y = geo.pos[3 * k + 1]; nx = geo.nrm[3 * k]; ny = geo.nrm[3 * k + 1]; }
      else {
        const ph = geo.phi[0] + (u / SUB) * ((2 * Math.PI) / Nj), a = rowA[r], b = rowB[r], c = Math.cos(ph), sn = Math.sin(ph);
        x = a * c; y = b * sn; nx = b * c; ny = a * sn; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        if (inner) { nx = -nx; ny = -ny; }
      }
      wall[3 * v] = x; wall[3 * v + 1] = y; wall[3 * v + 2] = zz; nrm[2 * v] = nx; nrm[2 * v + 1] = ny;
      const C = coatPoint(x, y, nx, ny, dd, fl, inner, flat);
      coat[3 * v] = C[0]; coat[3 * v + 1] = C[1]; coat[3 * v + 2] = zz;
    }
  }
  return { Ni: rows, rows, Nj, cols, SUB, RS, cutS, lastRow, rowZ, rowI, rowI0, rowI1, rowT, rowA, rowB, wall, coat, nrm, blend4, w4, dd: ddv, fl: flv, inner, flat };
}

// signed volume of the tetrahedron (a, b, c, e) × 6
function tet6(P, a, Q, b, R, c, S, e) {
  const ax = Q[b] - P[a], ay = Q[b + 1] - P[a + 1], az = Q[b + 2] - P[a + 2];
  const bx = R[c] - P[a], by = R[c + 1] - P[a + 1], bz = R[c + 2] - P[a + 2];
  const cx = S[e] - P[a], cy = S[e + 1] - P[a + 1], cz = S[e + 2] - P[a + 2];
  return ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
}

// Liquid volume between the wall and coating surfaces of a coatingMesh: each drawn triangle is
// swept from the wall to the coating into a prism and split into three tetrahedra. The split of
// each side face is chosen from the vertex indices alone, so neighbouring prisms split their
// shared face the same way and the internal faces cancel exactly; the sum is the volume of the
// closed polyhedron bounded by the drawn wall, the drawn coating and the open ends.
// perRow: optional Float64Array(rows − 1) receiving the volume of each row segment.
export function meshVolume(M, perRow = null) {
  const { Ni, cols, wall: W, coat: C } = M;
  let V = 0;
  const prism = (p, q, r) => { // vertex indices of a wall triangle; signed volume × 6
    let a = p, b = q, c = r, sg = 1;
    if (a > b) { [a, b] = [b, a]; sg = -sg; }
    if (b > c) { [b, c] = [c, b]; sg = -sg; }
    if (a > b) { [a, b] = [b, a]; sg = -sg; }
    a *= 3; b *= 3; c *= 3;
    return sg * (tet6(W, a, W, b, W, c, C, a) + tet6(W, b, W, c, C, a, C, b) + tet6(W, c, C, a, C, b, C, c));
  };
  for (let i = 0; i < Ni - 1; i++) {
    let Vr = 0;
    for (let u = 0; u < cols - 1; u++) {
      const a = i * cols + u, b = a + 1, c = a + cols, e = c + 1;
      Vr += prism(a, c, b) + prism(b, c, e);
    }
    Vr /= 6;
    if (perRow) perRow[i] = Math.abs(Vr);
    V += Vr;
  }
  return Math.abs(V);
}

// Liquid filling the whole bore between two menisci (fill stage, plugs, held columns, a lumen
// below a dip bath), drawn as a body with curved ends instead of whole flooded cell rows.
// held: { a, b, V, kind } from heldLiquid() (s of the upper and lower meniscus, volume).
// Each free end is a concave meniscus z(ρ) = c ± hm(½ − ρ²) about its mean level c (the liquid
// climbs the wall by hm/2 and dips hm/2 at the axis, so a straight bore holds the same volume as
// a flat end at c); hm is the spherical-cap sag r(1 − sin θ)/cos θ at that end. An end at the
// proximal opening is flat; an end at the tip spans the opening in the bevel plane. The upper
// end is then placed so the drawn body holds exactly V (bisection), so the bevel scoop and the
// taper are accounted for. Close to the proximal opening the meniscus would climb above it, so
// its contact line pins at the rim and only the centre dips (still holding V). Returns the same shape interface as tipPoolBody (zTop/zBot in the
// unit disc of the local ellipse) plus V (drawn volume) and Vheld.
export function heldBody(geo, held, opts = {}) {
  if (!geo || geo.flat || geo.surface !== 'inner' || !held || !(held.V > 0)) return null;
  const { Ni, L, A, B } = geo, { sE, dsR } = rowEdges(geo);
  const bv = geo.bevel || { deg: 0, clockDeg: 270, qmax: 0 };
  const tanB = bv.deg > 0 ? Math.tan(Math.min((bv.deg * Math.PI) / 180, 1.4)) : 0;
  const cb = ((bv.clockDeg ?? 270) * Math.PI) / 180, aT = A[Ni - 1], bT = B[Ni - 1];
  const qmax = bv.qmax || Math.hypot(aT * Math.cos(cb), bT * Math.sin(cb));
  const dl = Math.hypot(aT * Math.cos(cb), bT * Math.sin(cb)) || 1, dX = (aT * Math.cos(cb)) / dl, dY = (bT * Math.sin(cb)) / dl;
  const Fc = new Float64Array(Ni + 1);
  for (let i = 0; i < Ni; i++) Fc[i + 1] = Fc[i] + A[i] * B[i] * dsR[i];
  const F = (z) => { if (z <= 0) return 0; if (z >= L) return Fc[Ni]; const i = rowOfS(geo, z); return Fc[i] + A[i] * B[i] * (z - sE[i]); };
  const sBot = (u) => L - (1 - u) * qmax * tanB;
  const rAt = (s) => { const i = rowOfS(geo, s); return Math.min(A[i], B[i]); };
  const th = Math.min(Math.max(opts.theta ?? 0.5, 0), 1.45), sag = (s) => (rAt(s) * (1 - Math.sin(th))) / Math.cos(th);
  const eps = 0.5 * Math.min(dsR[0], dsR[Ni - 1]);
  const atTop = held.a <= 0.5e-3 * dsR[0], atTip = held.b >= L - eps;
  const len = Math.max(held.b - held.a, 1e-9);
  // meniscus depth at each free end, never more than a third of the body length
  const hmB = atTip ? 0 : Math.min(sag(held.b), len / 3);
  let hmA = atTop ? 0 : Math.min(sag(held.a), len / 3);
  const zBotF = (r2, u) => (atTip ? sBot(u) : Math.min(sBot(u), held.b - hmB * (0.5 - r2)));
  const NQ = opts.nq || 40, pts = [];
  for (let p = 0; p < NQ; p++) for (let q = 0; q < NQ; q++) {
    const u = -1 + (2 * (p + 0.5)) / NQ, v = -1 + (2 * (q + 0.5)) / NQ, r2 = u * u + v * v;
    if (r2 <= 1) pts.push(u, r2);
  }
  const wq = Math.PI / (pts.length / 2);
  const vol = (c, hm) => {
    let V = 0;
    for (let n = 0; n < pts.length; n += 2) {
      const u = pts[n], r2 = pts[n + 1], zt = Math.max(0, c + hm * (0.5 - r2)), zb = zBotF(r2, u);
      if (zb > zt) V += F(zb) - F(zt);
    }
    return V * wq;
  };
  let c = atTop ? 0 : held.a;
  if (!atTop) {
    // place the upper meniscus so the body holds V (volume falls as c moves down)
    let lo = -L, hi = held.b;
    for (let it = 0; it < 60; it++) { const mid = 0.5 * (lo + hi); if (vol(mid, hmA) > held.V) lo = mid; else hi = mid; }
    c = 0.5 * (lo + hi);
    // Near the proximal opening the contact line pins at the rim (zTop is clamped at 0) and only
    // the centre of the meniscus dips, so c may lie above the opening. The surface is flat at the
    // opening only when the liquid fills the bore right up to it.
    if (c <= -hmA / 2) { c = 0; hmA = 0; }
  }
  const zTopF = (r2) => Math.max(0, c + hmA * (0.5 - r2));
  return {
    kind: held.kind, Vheld: held.V, V: vol(c, hmA), a: c, b: held.b, hmA, hmB, top: Math.max(0, c - hmA / 2),
    tanB, qmax, cb, dX, dY,
    zTop: (r2) => zTopF(r2), zBot: (r2, u) => zBotF(r2, u), sBottom: sBot,
  };
}

// Everything the 3D view draws for one recorded frame, and the volume check. Returns
//   film: per-cell film to draw (m, true scale; zero under the liquid bodies and in held cells),
//   fill: cells still drawn flooded to the axis (only a pool at the proximal opening) or null,
//   bodies: [tip pool, held liquid] (either may be null),
//   expected: liquid on the part by the solver's bookkeeping (free film + pools + held liquid),
//   drawn: liquid volume of what is drawn at true scale (film layer + flooded rows + bodies).
// hp: precursor film; theta: contact angle at the tip (rad) for the meniscus shapes.
export function frameLiquid(geo, fr, hp, theta = 0.5) {
  const N = geo.N, film = new Float64Array(N);
  let Vfilm = 0;
  for (let k = 0; k < N; k++) {
    if ((fr.mask && fr.mask[k]) || (geo.voidMask && geo.voidMask[k])) continue;
    film[k] = Math.max(0, fr.h[k] - hp); Vfilm += film[k] * geo.area[k];
  }
  const aux = fr.aux || {}, pool = aux.pool || [0, 0], inner = geo.surface === 'inner' && !geo.flat;
  const body = inner && pool[1] > 1e-12 ? tipPoolBody(geo, pool[1], film, { theta }) : null;
  const held = inner && aux.held ? heldBody(geo, aux.held, { theta }) : null;
  let fill = null;
  if (inner) {
    fill = new Uint8Array(N);
    const reach0 = geo.poolReach ? geo.poolReach[0] : 3 * geo.ds;
    for (let k = 0; k < N; k++) {
      const i = Math.floor(k / geo.Nj);
      if (pool[0] > 1e-12 && geo.s[i] <= reach0) fill[k] = 1;
      else if (fr.mask && fr.mask[k] === 1 && !held) fill[k] = 1; // held cells with no recorded extent (old results)
    }
  }
  const drawFilm = Float64Array.from(film);
  if (body) for (let k = 0; k < N; k++) if (body.inBody[k]) drawFilm[k] = 0;
  const Vmesh = meshVolume(coatingMesh(geo, drawFilm, fill));
  const expected = Vfilm + pool[0] + pool[1] + (aux.held ? aux.held.V : 0);
  const drawn = Vmesh + (body ? body.V : 0) + (held ? held.V : 0);
  return { film: drawFilm, fill, bodies: [body, held], body, held, Vfilm, expected, drawn };
}
