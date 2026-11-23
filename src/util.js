// Helpers for scene authors.

import { m4, v3 } from './math.js';

// Deterministic random numbers in [0, 1): const rand = rng(42); rand();
export function rng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => Math.floor(a + (b - a + 1) * next());
  next.pick = (list) => list[Math.floor(next() * list.length)];
  return next;
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Evenly spaced key times covering [from, to].
export function timeRange(from, to, step) {
  const n = Math.max(1, Math.ceil((to - from) / step - 1e-9));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(from + (to - from) * i / n);
  return out;
}

// A polyline through 3D points, parameterised by distance travelled.
//   closed  join the last point back to the first
//   smooth  number of Catmull-Rom subdivisions per segment (0 = straight segments)
export class Path {
  constructor(points, { closed = false, smooth = 0 } = {}) {
    let pts = points.map((p) => [p[0], p[1], p[2] ?? 0]);
    if (smooth > 0) {
      const n = pts.length, out = [];
      const get = (i) => (closed ? pts[((i % n) + n) % n] : pts[Math.min(n - 1, Math.max(0, i))]);
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
        for (let k = 0; k < smooth; k++) {
          const t = k / smooth, t2 = t * t, t3 = t2 * t;
          out.push([0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)));
        }
      }
      if (!closed) out.push(pts[n - 1]);
      pts = out;
    }
    if (closed) pts.push(pts[0]);
    this.closed = closed;
    this.points = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + v3.dist(pts[i - 1], pts[i]));
    this.length = this.cum[this.cum.length - 1];
  }

  // Position and unit direction after travelling distance d along the path.
  at(d) {
    const L = this.length;
    d = this.closed ? ((d % L) + L) % L : Math.min(L, Math.max(0, d));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] <= d) lo = m; else hi = m;
    }
    const a = this.points[lo], b = this.points[hi];
    const seg = this.cum[hi] - this.cum[lo] || 1;
    return { p: v3.lerp(a, b, (d - this.cum[lo]) / seg), dir: v3.norm(v3.sub(b, a)) };
  }

  // Like at(), but with the direction averaged over `span` metres so that an
  // object following the path turns gradually at corners.
  smoothAt(d, span = 2) {
    const a = this.at(d - span / 2), b = this.at(d + span / 2), c = this.at(d);
    const dir = v3.sub(b.p, a.p);
    return { p: c.p, dir: v3.len(dir) > 1e-6 ? v3.norm(dir) : c.dir };
  }
}

// Returns a transform function t -> matrix that carries an object modelled
// with +Y forward and +Z up along a path.
//   speed   metres per second
//   offset  distance along the path at t = 0
//   span    corner smoothing distance (see Path.smoothAt)
//   lift    height added above the path
export function follow(path, { speed = 1, offset = 0, span = 2, lift = 0 } = {}) {
  return (t) => {
    const { p, dir } = path.smoothAt(offset + speed * t, span);
    return m4.facing([p[0], p[1], p[2] + lift], dir);
  };
}

// Key times for a moving object, placed only where the motion needs them.
// The span [from, to] is cut into pieces of at most maxStep seconds, and each
// piece is split further until the motion inside it is within `tolerance`
// metres of a straight, constant-speed line (but never finer than minStep).
// Straight stretches end up with two keys, bends and wobbles with many.
//   size  roughly the object's radius: how far from its origin the motion is checked
export function adaptiveTimes(transform, from, to, { tolerance = 0.08, minStep = 0.04, maxStep = 2, size = 2 } = {}) {
  const probes = [[0, 0, 0], [size, 0, 0], [0, size, 0], [0, 0, size]];
  const sample = (t) => {
    const m = transform(t);
    return probes.map((p) => m4.point(m, p));
  };
  const out = [from];
  const refine = (t0, s0, t1, s1) => {
    let err = 0;
    const mids = [0.25, 0.5, 0.75].map((f) => {
      const t = t0 + (t1 - t0) * f, s = sample(t);
      for (let k = 0; k < probes.length; k++) err = Math.max(err, v3.dist(s[k], v3.lerp(s0[k], s1[k], f)));
      return [t, s];
    });
    if (err > tolerance && t1 - t0 > minStep * 2) {
      refine(t0, s0, mids[1][0], mids[1][1]);
      refine(mids[1][0], mids[1][1], t1, s1);
    } else {
      out.push(t1);
    }
  };
  const n = Math.max(1, Math.ceil((to - from) / maxStep - 1e-9));
  let tPrev = from, sPrev = sample(from);
  for (let i = 1; i <= n; i++) {
    const t = i === n ? to : from + (to - from) * i / n, s = sample(t);
    refine(tPrev, sPrev, t, s);
    tPrev = t; sPrev = s;
  }
  return out;
}

// For a grid of points on a terrain, how high the land around stands against
// the sky in each of 16 compass directions, and how far away the land that
// does so is: the table behind SceneBuilder.horizon().  height is (x, y) -> z;
// the area is x0..x1 by y0..y1 in nx by ny cells; land is looked for up to
// `reach` metres away, at `steps` distances in each direction.
// Returns { width, height, data, nx, ny, near, far }.  Direction d points
// along (cos, sin) of d * 22.5 degrees; directions 4q to 4q + 3 sit in the
// four channels of tile q.  The table is four tiles wide and two high: on the
// left the four tiles (two to a row) with the angle of the horizon above
// level, as a fraction of a right angle; on the right the same four with the
// distance of the land that makes that horizon, from `near` (0) to `far`
// (255) on a logarithmic scale.
export function bakeHorizon(height, { x0, y0, x1, y1, nx = 128, ny = 128, reach = 3000, steps = 40 }) {
  const DIRS = 16;
  const cx = (x1 - x0) / nx, cy = (y1 - y0) / ny, cell = Math.max(cx, cy);
  // The terrain is sampled once, on a grid that reaches `reach` beyond the
  // area, and read from there (the height function may be costly).
  const gx0 = x0 - reach, gy0 = y0 - reach;
  const gs = Math.max(cell, (Math.max(x1 - x0, y1 - y0) + 2 * reach) / 1024);
  const gw = Math.ceil((x1 - x0 + 2 * reach) / gs) + 2, gh = Math.ceil((y1 - y0 + 2 * reach) / gs) + 2;
  const grid = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) grid[j * gw + i] = height(gx0 + i * gs, gy0 + j * gs);
  const at = (x, y) => {
    const fx = Math.min(gw - 1.001, Math.max(0, (x - gx0) / gs)), fy = Math.min(gh - 1.001, Math.max(0, (y - gy0) / gs));
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, o = j * gw + i;
    return (grid[o] * (1 - u) + grid[o + 1] * u) * (1 - v) + (grid[o + gw] * (1 - u) + grid[o + gw + 1] * u) * v;
  };
  // distances at which to look: closer together near by
  const dists = [];
  for (let k = 1; k <= steps; k++) dists.push(cell * Math.pow(reach / cell, k / steps));
  const near = dists[0] / 2, far = reach, scale = 255 / Math.log(far / near);
  const width = nx * 4, data = new Uint8Array(width * ny * 2 * 4);
  for (let d = 0; d < DIRS; d++) {
    const a = d * 2 * Math.PI / DIRS, dx = Math.cos(a), dy = Math.sin(a);
    const tile = d >> 2, ox = (tile & 1) * nx, oy = (tile >> 1) * ny;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * cx, y = y0 + (j + 0.5) * cy, z = at(x, y);
        let slope = 0, best = -1, where = far; // the tangent of the horizon's angle: never below level
        for (let k = 0; k < steps; k++) {
          const r = dists[k], s = (at(x + dx * r, y + dy * r) - z) / r;
          if (s > slope) { slope = s; best = k; where = r; }
        }
        if (best >= 0) {
          // look again round the best distance, more closely
          const r0 = best > 0 ? dists[best - 1] : dists[0] / 2, r1 = dists[Math.min(steps - 1, best + 1)];
          for (let k = 1; k < 8; k++) {
            const r = r0 + (r1 - r0) * k / 8, s = (at(x + dx * r, y + dy * r) - z) / r;
            if (s > slope) { slope = s; where = r; }
          }
        }
        const o = ((oy + j) * width + ox + i) * 4 + (d & 3);
        data[o] = Math.round(255 * Math.atan(slope) / (Math.PI / 2));
        data[o + nx * 2 * 4] = Math.round(Math.min(255, Math.max(0, Math.log(where / near) * scale)));
      }
    }
  }
  return { width, height: ny * 2, data, nx, ny, near, far };
}
