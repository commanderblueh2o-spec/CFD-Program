// Banded linear solvers used by the ADI thin-film integrator.
// Row i of a pentadiagonal system:  a[i] x[i-2] + b[i] x[i-1] + c[i] x[i] + d[i] x[i+1] + e[i] x[i+2] = r[i]

export class PentaSolver {
  constructor(n) {
    this.n = n;
    this.c = new Float64Array(n); this.d = new Float64Array(n); this.e = new Float64Array(n);
    this.f1 = new Float64Array(n); this.f2 = new Float64Array(n);
    // Woodbury buffers for the cyclic case
    this.Z = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    this.y = new Float64Array(n);
  }

  // Factor the non-cyclic band (corner entries ignored). Inputs are not modified.
  factor(a, b, c, d, e) {
    const n = this.n, C = this.c, D = this.d, E = this.e, f1 = this.f1, f2 = this.f2;
    const B = this._b || (this._b = new Float64Array(n));
    for (let i = 0; i < n; i++) { C[i] = c[i]; D[i] = d[i]; E[i] = e[i]; B[i] = b[i]; }
    for (let i = 0; i < n; i++) {
      const piv = C[i];
      if (i + 1 < n) {
        const f = B[i + 1] / piv; f1[i + 1] = f;
        C[i + 1] -= f * D[i]; D[i + 1] -= f * E[i];
      }
      if (i + 2 < n) {
        const g = a[i + 2] / piv; f2[i + 2] = g;
        B[i + 2] -= g * D[i]; C[i + 2] -= g * E[i];
      }
    }
  }

  // Solve the factored (non-cyclic) system in place on r.
  solveFactored(r) {
    const n = this.n, C = this.c, D = this.d, E = this.e, f1 = this.f1, f2 = this.f2;
    for (let i = 0; i < n; i++) {
      if (i + 1 < n) r[i + 1] -= f1[i + 1] * r[i];
      if (i + 2 < n) r[i + 2] -= f2[i + 2] * r[i];
    }
    r[n - 1] /= C[n - 1];
    if (n > 1) r[n - 2] = (r[n - 2] - D[n - 2] * r[n - 1]) / C[n - 2];
    for (let i = n - 3; i >= 0; i--) r[i] = (r[i] - D[i] * r[i + 1] - E[i] * r[i + 2]) / C[i];
    return r;
  }

  solve(a, b, c, d, e, r) { this.factor(a, b, c, d, e); return this.solveFactored(r); }

  // Cyclic pentadiagonal: a[0],b[0],a[1] wrap to the end; d[n-1],e[n-1],e[n-2] wrap to the start.
  solveCyclic(a, b, c, d, e, r) {
    const n = this.n;
    if (n < 5) throw new Error('cyclic penta needs n>=5');
    this.factor(a, b, c, d, e);
    const rows = [0, 1, n - 2, n - 1];
    const Z = this.Z;
    for (let k = 0; k < 4; k++) { Z[k].fill(0); Z[k][rows[k]] = 1; this.solveFactored(Z[k]); }
    const y = this.y; for (let i = 0; i < n; i++) y[i] = r[i]; this.solveFactored(y);
    // V^T rows: corner coefficients
    const vt = (k, x) => {
      switch (k) {
        case 0: return a[0] * x[n - 2] + b[0] * x[n - 1];
        case 1: return a[1] * x[n - 1];
        case 2: return e[n - 2] * x[0];
        default: return d[n - 1] * x[0] + e[n - 1] * x[1];
      }
    };
    const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const vy = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      for (let l = 0; l < 4; l++) M[k][l] = (k === l ? 1 : 0) + vt(k, Z[l]);
      vy[k] = vt(k, y);
    }
    const z = solveDense(M, vy);
    for (let i = 0; i < n; i++) r[i] = y[i] - (Z[0][i] * z[0] + Z[1][i] * z[1] + Z[2][i] * z[2] + Z[3][i] * z[3]);
    return r;
  }
}

// Small dense solve with partial pivoting (copies inputs).
export function solveDense(M0, v0) {
  const n = v0.length;
  const M = M0.map((r) => r.slice());
  const v = v0.slice();
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]]; [v[k], v[p]] = [v[p], v[k]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j < n; j++) M[i][j] -= f * M[k][j];
      v[i] -= f * v[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = v[i];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = sum / M[i][i];
  }
  return x;
}
