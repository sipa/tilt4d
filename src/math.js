// Small math helpers.
//
// m4: 3D affine transforms as column-major arrays of 16 numbers (used to place
//     geometry in space).
// v3: 3-vectors as [x, y, z].
// f4: operations on 4-vectors and on the player's 4D frame (see player.js).

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};

export const m4 = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  translation: (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  scaling: (x, y = x, z = x) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1],
  rotationX: (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  },
  rotationY: (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  },
  // Counter-clockwise seen from above (+Z towards the viewer).
  rotationZ: (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  },
  rotationAxis: (axis, a) => {
    const [x, y, z] = v3.norm(axis);
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [
      t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
      t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
      t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
      0, 0, 0, 1,
    ];
  },
  // Matrix whose columns are the given basis vectors and origin.
  fromBasis: (x, y, z, o = [0, 0, 0]) => [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1],
  // Places an object modelled with +Y forward and +Z up at `pos`, pointing along `forward`.
  facing: (pos, forward, up = [0, 0, 1]) => {
    const f = v3.norm(forward);
    let r = v3.cross(f, up);
    if (v3.len(r) < 1e-6) r = v3.cross(f, [1, 0, 0]);
    r = v3.norm(r);
    const u = v3.cross(r, f);
    return m4.fromBasis(r, f, u, pos);
  },
  // mul(A, B, C) = A·B·C  (C is applied to points first).
  mul: (...ms) => {
    let a = ms[0];
    for (let k = 1; k < ms.length; k++) {
      const b = ms[k], o = new Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      a = o;
    }
    return a;
  },
  point: (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ],
  dir: (m, d) => [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ],
  det3: (m) =>
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]),
  // Cofactor matrix of the upper 3x3 (transforms normals, up to scale); 9 numbers, column-major.
  normalMat: (m) => [
    m[5] * m[10] - m[6] * m[9], m[6] * m[8] - m[4] * m[10], m[4] * m[9] - m[5] * m[8],
    m[2] * m[9] - m[1] * m[10], m[0] * m[10] - m[2] * m[8], m[1] * m[8] - m[0] * m[9],
    m[1] * m[6] - m[2] * m[5], m[2] * m[4] - m[0] * m[6], m[0] * m[5] - m[1] * m[4],
  ],
};

// ---------------------------------------------------------------------------
// 4D frames: a Float64Array(16), column-major; the columns are four orthonormal
// 4-vectors.  Component 3 of every vector is the time axis measured in length
// units (w = C * t).

const dot4 = (M, i, a) => M[i] * a[0] + M[i + 1] * a[1] + M[i + 2] * a[2] + M[i + 3] * a[3];

export const f4 = {
  identity: () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  col: (M, i) => [M[i * 4], M[i * 4 + 1], M[i * 4 + 2], M[i * 4 + 3]],
  setCol: (M, i, v) => {
    M[i * 4] = v[0]; M[i * 4 + 1] = v[1]; M[i * 4 + 2] = v[2]; M[i * 4 + 3] = v[3];
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l, a[3] / l];
  },

  // Rotation in the plane of the frame's own columns i and j: column i turns
  // towards column j.  This is right-multiplication by a Givens rotation.
  rotCols: (M, i, j, angle) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let k = 0; k < 4; k++) {
      const a = M[i * 4 + k], b = M[j * 4 + k];
      M[i * 4 + k] = c * a + s * b;
      M[j * 4 + k] = c * b - s * a;
    }
  },

  // Rotation in the plane spanned by orthonormal 4-vectors a and b (a turns
  // towards b), applied to every column.  This is left-multiplication.
  rotPlane: (M, a, b, angle) => {
    const c = Math.cos(angle) - 1, s = Math.sin(angle);
    for (let i = 0; i < 16; i += 4) {
      const xa = dot4(M, i, a), xb = dot4(M, i, b);
      for (let k = 0; k < 4; k++) M[i + k] += c * (xa * a[k] + xb * b[k]) + s * (xa * b[k] - xb * a[k]);
    }
  },

  // Rotates every column by the rotation that turns unit vector `from` towards
  // unit vector `to` by at most maxAngle.  Returns the angle still remaining.
  rotTowards: (M, from, to, maxAngle = Infinity) => {
    const d = Math.max(-1, Math.min(1, f4.dot(from, to)));
    const b = [to[0] - d * from[0], to[1] - d * from[1], to[2] - d * from[2], to[3] - d * from[3]];
    const bl = Math.hypot(b[0], b[1], b[2], b[3]);
    if (bl < 1e-9) return 0;
    const angle = Math.atan2(bl, d);
    const step = Math.min(angle, maxAngle);
    f4.rotPlane(M, from, [b[0] / bl, b[1] / bl, b[2] / bl, b[3] / bl], step);
    return angle - step;
  },

  // Applies to x the minimal rotation that takes unit vector a to unit vector b.
  minRot: (x, a, b) => {
    const k = 1 + f4.dot(a, b);
    if (k < 1e-9) return x.slice();
    const s = [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
    const f = f4.dot(s, x) / k, g = 2 * f4.dot(a, x);
    return [x[0] - f * s[0] + g * b[0], x[1] - f * s[1] + g * b[1], x[2] - f * s[2] + g * b[2], x[3] - f * s[3] + g * b[3]];
  },

  // The 4-vector orthogonal to a, b and c, with det[x, a, b, c] = |x|^2 (the
  // 4D counterpart of the cross product).
  cross: (a, b, c) => {
    const d = (i, j, k) => a[i] * (b[j] * c[k] - b[k] * c[j]) - a[j] * (b[i] * c[k] - b[k] * c[i]) + a[k] * (b[i] * c[j] - b[j] * c[i]);
    return [d(1, 2, 3), -d(0, 2, 3), d(0, 1, 3), -d(0, 1, 2)];
  },

  // Gram-Schmidt over the columns in the given priority order.
  orthonormalize: (M, order) => {
    const done = [];
    for (const i of order) {
      let v = f4.col(M, i);
      for (const u of done) {
        const d = f4.dot(v, u);
        v = [v[0] - d * u[0], v[1] - d * u[1], v[2] - d * u[2], v[3] - d * u[3]];
      }
      v = f4.norm(v);
      f4.setCol(M, i, v);
      done.push(v);
    }
  },
};
