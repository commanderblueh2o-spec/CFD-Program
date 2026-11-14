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
