// Collisions between the player and the scene's static surfaces.
//
// Everything a scene adds with b.static() and that is always there is solid,
// unless it is additive light or was added with { solid: false }.  The
// triangles are used as they are: nothing is authored separately, so what
// stops the player is what the player sees.  Geometry that moves, and
// geometry that is only there for part of the time, is not solid.
//
// The player is an upright cylinder when walking or driving, and a sphere
// when flying or swimming.  Surfaces are sheets, not volumes: they stop the
// player from either side, and it is the shortness of the steps the player is
// moved in (see Player.update) that keeps the player from getting across one.

const LEVELS = 6;      // grids over x and y with cells of 4, 32, 256, ... metres
const CELL0 = 4, GROW = 8;
const MAX_CELLS = 64;  // a triangle goes into the finest grid in which it covers no more cells than this
const LIE = 0.35;      // triangles that stay this close to the ground are part of it
const OFF = 1048576;
const key = (l, ix, iy) => ((ix + OFF) * (2 * OFF) + (iy + OFF)) * 8 + l;
const cellOf = (v, s) => Math.max(-OFF + 1, Math.min(OFF - 1, Math.floor(v / s)));
const NONE = Object.freeze([]);

// scratch space: the closest point found, and polygons while they are clipped
const Q = new Float64Array(3);
const polyA = new Float64Array(24), polyB = new Float64Array(24);

export class Colliders {
  // A structure made in a worker arrives as a plain object: this makes it one of these again.
  static revive(plain) {
    return Object.assign(Object.create(Colliders.prototype), plain, { cand: new Int32Array(256) });
  }

  // tris: 9 numbers per triangle.  ground: (x, y, t) -> z or null; triangles
  // lying on it (terrain, paving, road markings) are left out, because the
  // ground is followed rather than run into.
  constructor(tris, ground = null) {
    const total = Math.floor(tris.length / 9);
    const keep = [];
    const onGround = (o) => Math.abs(tris[o + 2] - ground(tris[o], tris[o + 1], 0)) < LIE;
    for (let i = 0; i < total; i++) {
      const o = i * 9;
      let ok = true;
      for (let k = 0; k < 9; k++) ok = ok && Number.isFinite(tris[o + k]);
      if (!ok) continue;
      // no area: nothing to run into
      const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
      const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-9) continue;
      if (ground && onGround(o) && onGround(o + 3) && onGround(o + 6)) continue;
      keep.push(i);
    }
    const n = keep.length;
    this.count = n;
    this.t = new Float32Array(n * 9);
    this.zr = new Float32Array(n * 2); // lowest and highest point of each triangle
    this.cells = new Map();
    this.levels = new Array(LEVELS).fill(false);
    this.cand = new Int32Array(256);
    for (let j = 0; j < n; j++) {
      const o = keep[j] * 9, t = this.t.subarray(j * 9, j * 9 + 9);
      t.set(tris.subarray(o, o + 9));
      this.zr[j * 2] = Math.min(t[2], t[5], t[8]);
      this.zr[j * 2 + 1] = Math.max(t[2], t[5], t[8]);
      const x0 = Math.min(t[0], t[3], t[6]), x1 = Math.max(t[0], t[3], t[6]);
      const y0 = Math.min(t[1], t[4], t[7]), y1 = Math.max(t[1], t[4], t[7]);
      for (let l = 0, s = CELL0; l < LEVELS; l++, s *= GROW) {
        const ix0 = cellOf(x0, s), ix1 = cellOf(x1, s), iy0 = cellOf(y0, s), iy1 = cellOf(y1, s);
        if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > MAX_CELLS && l < LEVELS - 1) continue;
        for (let ix = ix0; ix <= ix1; ix++) {
          for (let iy = iy0; iy <= iy1; iy++) {
            const k = key(l, ix, iy), list = this.cells.get(k);
            if (list) list.push(j); else this.cells.set(k, [j]);
          }
        }
        this.levels[l] = true;
        break;
      }
    }
  }

  // Collects the triangles near (x, y) into this.cand; returns how many.
  _gather(x, y, r) {
    let n = 0;
    for (let l = 0, s = CELL0; l < LEVELS; l++, s *= GROW) {
      if (!this.levels[l]) continue;
      const ix0 = cellOf(x - r, s), ix1 = cellOf(x + r, s), iy0 = cellOf(y - r, s), iy1 = cellOf(y + r, s);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const list = this.cells.get(key(l, ix, iy));
          if (!list) continue;
          if (n + list.length > this.cand.length) {
            const bigger = new Int32Array(Math.max(this.cand.length * 2, n + list.length));
            bigger.set(this.cand.subarray(0, n));
            this.cand = bigger;
          }
          for (let k = 0; k < list.length; k++) this.cand[n++] = list[k];
        }
      }
    }
    return n;
  }

  // Moves the centre p of a sphere of radius r out of every surface it
  // overlaps.  Returns the directions it was pushed in (unit vectors).
  pushSphere(p, r) {
    let hits = NONE;
    for (let pass = 0; pass < 4; pass++) {
      const n = this._gather(p[0], p[1], r);
      let moved = false;
      for (let k = 0; k < n; k++) {
        const i = this.cand[k];
        if (p[2] + r <= this.zr[i * 2] || p[2] - r >= this.zr[i * 2 + 1]) continue;
        closestOnTriangle(p[0], p[1], p[2], this.t, i * 9);
        let nx = p[0] - Q[0], ny = p[1] - Q[1], nz = p[2] - Q[2];
        const d = Math.hypot(nx, ny, nz);
        if (d >= r) continue;
        if (d > 1e-7) { nx /= d; ny /= d; nz /= d; } else [nx, ny, nz] = this._normal(i);
        p[0] += nx * (r - d); p[1] += ny * (r - d); p[2] += nz * (r - d);
        if (hits === NONE) hits = [];
        if (hits.length < 12) hits.push([nx, ny, nz]);
        moved = true;
      }
      if (!moved) break;
    }
    return hits;
  }

  // The same for an upright cylinder of radius r about p that reaches from
  // height z0 to z1.  Only p's x and y change, and the directions returned
  // are horizontal.
  pushCylinder(p, r, z0, z1) {
    let hits = NONE;
    for (let pass = 0; pass < 4; pass++) {
      const n = this._gather(p[0], p[1], r);
      let moved = false;
      for (let k = 0; k < n; k++) {
        const i = this.cand[k];
        if (z1 <= this.zr[i * 2] || z0 >= this.zr[i * 2 + 1]) continue;
        const m = this._section(i, z0, z1);
        if (m < 2) continue;
        // the part of the triangle at these heights, seen from above, is a
        // flat polygon (or just a line, for an upright wall)
        const depth = outOfPolygon(polyA, m, p[0], p[1], r);
        if (depth <= 0) continue;
        let nx = Q[0], ny = Q[1];
        if (nx === 0 && ny === 0) {
          const nrm = this._normal(i), l = Math.hypot(nrm[0], nrm[1]);
          if (l < 1e-6) continue;
          nx = nrm[0] / l; ny = nrm[1] / l;
        }
        p[0] += nx * depth; p[1] += ny * depth;
        if (hits === NONE) hits = [];
        if (hits.length < 12) hits.push([nx, ny, 0]);
        moved = true;
      }
      if (!moved) break;
    }
    return hits;
  }

  // Whether nothing solid crosses the upright line from (x, y, z0) to (x, y, z1).
  clearColumn(x, y, z0, z1) {
    const n = this._gather(x, y, 0), t = this.t;
    for (let k = 0; k < n; k++) {
      const i = this.cand[k], o = i * 9;
      if (z1 < this.zr[i * 2] || z0 > this.zr[i * 2 + 1]) continue;
      // where (x, y) lies in the triangle seen from above
      const ax = t[o], ay = t[o + 1], bx = t[o + 3] - ax, by = t[o + 4] - ay, cx = t[o + 6] - ax, cy = t[o + 7] - ay;
      const det = bx * cy - by * cx;
      if (Math.abs(det) < 1e-12) continue;
      const u = ((x - ax) * cy - (y - ay) * cx) / det, v = (bx * (y - ay) - by * (x - ax)) / det;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const z = t[o + 2] + u * (t[o + 5] - t[o + 2]) + v * (t[o + 8] - t[o + 2]);
      if (z >= z0 && z <= z1) return false;
    }
    return true;
  }

  // The height of the highest solid surface at (x, y) that is no higher than
  // zMax: what there is to stand on there.  -Infinity if there is none.
  floorBelow(x, y, zMax) {
    const n = this._gather(x, y, 0), t = this.t;
    let best = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = this.cand[k], o = i * 9;
      if (this.zr[i * 2] > zMax || this.zr[i * 2 + 1] <= best) continue;
      const ax = t[o], ay = t[o + 1], bx = t[o + 3] - ax, by = t[o + 4] - ay, cx = t[o + 6] - ax, cy = t[o + 7] - ay;
      const det = bx * cy - by * cx;
      if (Math.abs(det) < 1e-12) continue; // upright: nothing to stand on
      const u = ((x - ax) * cy - (y - ay) * cx) / det, v = (bx * (y - ay) - by * (x - ax)) / det;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const z = t[o + 2] + u * (t[o + 5] - t[o + 2]) + v * (t[o + 8] - t[o + 2]);
      if (z <= zMax && z > best) best = z;
    }
    return best;
  }

  _normal(i) {
    const t = this.t, o = i * 9;
    const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
    const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  // Cuts triangle i down to the heights z0..z1.  The corners of what is left
  // go into polyA as x, y, z; returns how many there are.
  _section(i, z0, z1) {
    const t = this.t, o = i * 9;
    for (let k = 0; k < 9; k++) polyB[k] = t[o + k];
    const m = clipZ(polyB, 3, polyA, z0, 1);
    for (let k = 0; k < m * 3; k++) polyB[k] = polyA[k];
    return clipZ(polyB, m, polyA, z1, -1);
  }
}

// Keeps the part of a polygon with sign * (z - zc) >= 0.
function clipZ(src, n, dst, zc, sign) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    const da = sign * (src[a + 2] - zc), db = sign * (src[b + 2] - zc);
    if (da >= 0) { dst[m * 3] = src[a]; dst[m * 3 + 1] = src[a + 1]; dst[m * 3 + 2] = src[a + 2]; m++; }
    if ((da >= 0) !== (db >= 0)) {
      const f = da / (da - db);
      dst[m * 3] = src[a] + f * (src[b] - src[a]);
      dst[m * 3 + 1] = src[a + 1] + f * (src[b + 1] - src[a + 1]);
      dst[m * 3 + 2] = zc;
      m++;
    }
  }
  return m;
}

// How far a circle of radius r about (x, y) has to move to be clear of a
// convex polygon seen from above (corners in `poly` as x, y, z), or 0 if it
// is clear already.  The direction to move in goes into Q[0], Q[1]; it is
// left at zero when the centre lies exactly on the polygon's edge.
function outOfPolygon(poly, n, x, y, r) {
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    area += poly[a] * poly[b + 1] - poly[b] * poly[a + 1];
  }
  let best = Infinity, bx = 0, by = 0, inside = Math.abs(area) > 1e-9;
  let edge = Infinity, ex = 0, ey = 0;
  const turn = area > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    const dx = poly[b] - poly[a], dy = poly[b + 1] - poly[a + 1];
    const px = x - poly[a], py = y - poly[a + 1];
    const len2 = dx * dx + dy * dy;
    const f = len2 > 1e-18 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
    const qx = px - f * dx, qy = py - f * dy, d = Math.hypot(qx, qy);
    if (d < best) { best = d; bx = qx; by = qy; }
    if (len2 > 1e-18) {
      // distance to the inside of this edge; the centre is inside the
      // polygon when that is positive for every edge
      const s = turn * (dx * py - dy * px) / Math.sqrt(len2);
      if (s < 0) inside = false;
      else if (s < edge) { edge = s; const l = Math.sqrt(len2); ex = turn * dy / l; ey = -turn * dx / l; }
    }
  }
  Q[0] = Q[1] = 0;
  if (inside) {
    // under or over a sloping surface: out through the nearest edge
    Q[0] = ex; Q[1] = ey;
    return edge + r;
  }
  if (best >= r) return 0;
  if (best > 1e-7) { Q[0] = bx / best; Q[1] = by / best; }
  return r - best;
}

// The point of triangle (t[o..o+8]) closest to p, into Q.
function closestOnTriangle(px, py, pz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const abx = t[o + 3] - ax, aby = t[o + 4] - ay, abz = t[o + 5] - az;
  const acx = t[o + 6] - ax, acy = t[o + 7] - ay, acz = t[o + 8] - az;
  const set = (u, v) => { Q[0] = ax + abx * u + acx * v; Q[1] = ay + aby * u + acy * v; Q[2] = az + abz * u + acz * v; };
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(0, 0);
  const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(d1 / (d1 - d3), 0);
  const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return set(1 - w, w);
  }
  const k = 1 / (va + vb + vc);
  return set(vb * k, vc * k);
}
