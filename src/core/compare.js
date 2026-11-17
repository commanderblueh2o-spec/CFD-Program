// A/B run comparison: setting differences, field resampling between grids and difference statistics.
// Pure functions (no DOM) so they can be tested headless.

function flatten(v, path, out) {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) { out[path] = JSON.stringify(v); return out; }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) flatten(v[k], path ? (Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`) : k, out);
    return out;
  }
  out[path] = v;
  return out;
}

const IGNORED = new Set(['presetId', 'name', 'description']);

// Leaf-level differences between two setups: [{path, a, b}] (undefined = not set on that side).
// Stages are compared position by position; numeric noise below 1e-9 relative is ignored.
export function diffSpecs(a, b) {
  const fa = flatten(a || {}, '', {}), fb = flatten(b || {}, '', {});
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])];
  const out = [];
  for (const k of keys) {
    if (IGNORED.has(k.split(/[.[]/)[0])) continue;
    const x = fa[k], y = fb[k];
    if (typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y))) continue;
    if (x === y) continue;
    out.push({ path: k, a: x, b: y });
  }
  const order = (p) => (p.startsWith('geometry') ? 0 : p.startsWith('substrate') || p.startsWith('coating') ? 1 : p.startsWith('stages') ? 2 : 3);
  return out.sort((p, q) => order(p.path) - order(q.path) || p.path.localeCompare(q.path, 'en', { numeric: true }));
}

// Resample a cell field from grid `src` onto grid `dst`.
// Grids: {Ni, Nj, s (cell-centre positions along the part, m), flat, voidMask?}.
// Axial: linear in absolute s (from the same reference end), so parts of different length are compared
// at the same distance; cells beyond the source part get NaN. Around: linear in the fractional index
// (j + 0.5)/Nj, periodic for tubes. Cut-away (void) source cells carry no weight; if every neighbour
// is void the result is NaN.
export function resampleField(src, vals, dst) {
  const out = new Float32Array(dst.Ni * dst.Nj);
  const S = src.s, ni = src.Ni, nj = src.Nj;
  const same = src.Ni === dst.Ni && src.Nj === dst.Nj && S.every((v, i) => Math.abs(v - dst.s[i]) < 1e-12);
  if (same) {
    for (let k = 0; k < out.length; k++) out[k] = src.voidMask && src.voidMask[k] ? NaN : vals[k];
    return out;
  }
  const tol = 0.5 * (S[ni - 1] - S[0]) / Math.max(1, ni - 1);
  for (let i = 0; i < dst.Ni; i++) {
    const s = dst.s[i];
    let i0, i1, fi;
    if (s < S[0] - tol || s > S[ni - 1] + tol) { for (let j = 0; j < dst.Nj; j++) out[i * dst.Nj + j] = NaN; continue; }
    if (s <= S[0]) { i0 = i1 = 0; fi = 0; } else if (s >= S[ni - 1]) { i0 = i1 = ni - 1; fi = 0; } else {
      let lo = 0, hi = ni - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
      i0 = lo; i1 = hi; fi = (s - S[lo]) / (S[hi] - S[lo]);
    }
    for (let j = 0; j < dst.Nj; j++) {
      const u = ((j + 0.5) / dst.Nj) * nj - 0.5;
      let j0 = Math.floor(u), fj = u - j0, j1 = j0 + 1;
      if (src.flat) { if (j0 < 0) { j0 = 0; j1 = 0; fj = 0; } if (j1 > nj - 1) { j1 = nj - 1; if (j0 > nj - 1) j0 = nj - 1; } }
      else { j0 = ((j0 % nj) + nj) % nj; j1 = ((j1 % nj) + nj) % nj; }
      let acc = 0, wt = 0;
      for (const [ii, wi] of [[i0, 1 - fi], [i1, fi]]) for (const [jj, wj] of [[j0, 1 - fj], [j1, fj]]) {
        const w = wi * wj, k = ii * nj + jj;
        if (w <= 0 || (src.voidMask && src.voidMask[k])) continue;
        acc += w * vals[k]; wt += w;
      }
      out[i * dst.Nj + j] = wt > 1e-12 ? acc / wt : NaN;
    }
  }
  return out;
}

// Area-weighted statistics of a difference field d = B − A over cells where `include(k)` is true
// and d is finite: mean, RMS, largest |d| and where it is, and the area fractions thicker/thinner
// than `tol` (same units as d).
export function diffStats(d, area, include = () => true, tol = 0) {
  let w = 0, m = 0, q = 0, mx = 0, kmax = -1, up = 0, dn = 0;
  for (let k = 0; k < d.length; k++) {
    const v = d[k];
    if (!isFinite(v) || !include(k)) continue;
    const a = area[k];
    w += a; m += a * v; q += a * v * v;
    if (v > tol) up += a; else if (v < -tol) dn += a;
    if (Math.abs(v) > Math.abs(mx)) { mx = v; kmax = k; }
  }
  if (!(w > 0)) return { mean: NaN, rms: NaN, maxAbs: NaN, kmax: -1, thicker: 0, thinner: 0, n: 0 };
  return { mean: m / w, rms: Math.sqrt(q / w), maxAbs: mx, kmax, thicker: up / w, thinner: dn / w, n: w };
}
