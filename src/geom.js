// Geo: a plain 3D triangle mesh with per-vertex attributes, plus a library of
// primitives.  Conventions: +Z is up, lengths are metres, triangles are
// counter-clockwise seen from outside, colours are sRGB.

import { m4, v3 } from './math.js';

export const FLAG_ADDITIVE = 1; // drawn as additive light (no depth write, casts no shadow)
export const FLAG_UNLIT = 2; // colour is output as is, ignoring sun and shadows
export const FLAG_NO_SHADOW = 4; // casts no shadow
export const FLAG_TWO_SIDED = 8; // a thin sheet: whichever side is seen gets lit as a front
export const FLAG_CUTOUT = 16; // has holes: the scene's `cutout` shader hook says, per pixel, what is there
export const FLAG_BLEND = 32; // see-through: blended over what is behind it (no depth write, casts no shadow)
export const FLAG_UNTINTED = 128; // in an instanced mesh: keeps its own colour whatever the copy's tint

export function parseColor(c) {
  if (typeof c === 'string') {
    let h = c.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  if (typeof c === 'number') return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  return c;
}

export class Geo {
  constructor() {
    this.p = []; // positions, 3 per vertex
    this.n = []; // normals, 3 per vertex
    this.c = []; // sRGB colour, 3 per vertex
    this.uv = []; // 2 per vertex
    this.a = []; // emissive, gloss, material id, flags: 4 per vertex
    this.x = []; // spare values for the scene's shader: aux (-1..1), tag (0..255): 2 per vertex
    this.idx = []; // triangle indices
  }

  get vertexCount() { return this.p.length / 3; }
  get triangleCount() { return this.idx.length / 3; }

  vert(px, py, pz, nx, ny, nz, u = 0, v = 0) {
    const i = this.p.length / 3;
    this.p.push(px, py, pz);
    this.n.push(nx, ny, nz);
    this.c.push(0.8, 0.8, 0.8);
    this.uv.push(u, v);
    this.a.push(0, 0.15, 0, 0);
    this.x.push(0, 0);
    return i;
  }

  tri(a, b, c) { this.idx.push(a, b, c); return this; }
  quadIdx(a, b, c, d) { this.idx.push(a, b, c, a, c, d); return this; }

  // --- primitives ----------------------------------------------------------

  // Box centred on the origin.
  static box(sx, sy = sx, sz = sx) {
    const g = new Geo();
    const h = [sx / 2, sy / 2, sz / 2];
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
      [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
    ];
    for (const [n, u, v] of faces) {
      const corner = (su, sv) => [0, 1, 2].map((k) => (n[k] + su * u[k] + sv * v[k]) * h[k]);
      const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
        const p = corner(su, sv);
        return g.vert(p[0], p[1], p[2], n[0], n[1], n[2], (su + 1) / 2, (sv + 1) / 2);
      });
      g.quadIdx(q[0], q[1], q[2], q[3]);
    }
    return g;
  }

  // Rectangle in the XY plane (z = 0) facing +Z, centred on the origin.
  static plane(sx, sy = sx, nx = 1, ny = 1) {
    const g = new Geo();
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        g.vert((i / nx - 0.5) * sx, (j / ny - 0.5) * sy, 0, 0, 0, 1, i / nx, j / ny);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        g.quadIdx(a, a + 1, a + nx + 2, a + nx + 1);
      }
    }
    return g.orientByNormals();
  }

  // Flat quad through four points given counter-clockwise (seen from the front).
  static quad(p0, p1, p2, p3) {
    const g = new Geo();
    const n = v3.norm(v3.cross(v3.sub(p1, p0), v3.sub(p3, p0)));
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const q = [p0, p1, p2, p3].map((p, i) => g.vert(p[0], p[1], p[2], n[0], n[1], n[2], uv[i][0], uv[i][1]));
    return g.quadIdx(q[0], q[1], q[2], q[3]);
  }

  // Flat triangle, counter-clockwise seen from the front.
  static triangle(p0, p1, p2) {
    const g = new Geo();
    const n = v3.norm(v3.cross(v3.sub(p1, p0), v3.sub(p2, p0)));
    const uv = [[0, 0], [1, 0], [0, 1]];
    const q = [p0, p1, p2].map((p, i) => g.vert(p[0], p[1], p[2], n[0], n[1], n[2], uv[i][0], uv[i][1]));
    return g.tri(q[0], q[1], q[2]);
  }

  // Terrain: a grid over [x0,x1] x [y0,y1] with z = height(x, y).
  // colorFn(x, y, z, normal) may return a colour per vertex.
  static heightfield(x0, y0, x1, y1, nx, ny, height, colorFn = null) {
    const g = new Geo();
    const ex = (x1 - x0) / nx * 0.5, ey = (y1 - y0) / ny * 0.5;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = x0 + (x1 - x0) * i / nx, y = y0 + (y1 - y0) * j / ny;
        const z = height(x, y);
        const n = v3.norm([
          (height(x - ex, y) - height(x + ex, y)) / (2 * ex),
          (height(x, y - ey) - height(x, y + ey)) / (2 * ey),
          1,
        ]);
        const k = g.vert(x, y, z, n[0], n[1], n[2], i / nx, j / ny);
        if (colorFn) {
          const c = parseColor(colorFn(x, y, z, n));
          g.c[k * 3] = c[0]; g.c[k * 3 + 1] = c[1]; g.c[k * 3 + 2] = c[2];
        }
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        g.quadIdx(a, a + 1, a + nx + 2, a + nx + 1);
      }
    }
    return g.orientByNormals();
  }

  // Sphere centred on the origin.
  static sphere(r, seg = 20, rings = 12) {
    const g = new Geo();
    for (let j = 0; j <= rings; j++) {
      const th = Math.PI * j / rings;
      for (let i = 0; i <= seg; i++) {
        const ph = 2 * Math.PI * i / seg;
        const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
        g.vert(n[0] * r, n[1] * r, n[2] * r, n[0], n[1], n[2], i / seg, j / rings);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i;
        if (j > 0) g.tri(a, a + seg + 1, a + 1);
        if (j < rings - 1) g.tri(a + 1, a + seg + 1, a + seg + 2);
      }
    }
    return g.orientByNormals();
  }

  // Cylinder (or cone frustum) around the Z axis, from z = 0 to z = h.
  // r is the bottom radius, opts.r2 the top radius (defaults to r).
  static cylinder(r, h, seg = 16, opts = {}) {
    const r2 = opts.r2 ?? r, caps = opts.caps ?? true;
    const g = new Geo();
    const slope = (r - r2) / h;
    for (let i = 0; i <= seg; i++) {
      const ph = 2 * Math.PI * i / seg, c = Math.cos(ph), s = Math.sin(ph);
      const n = v3.norm([c, s, slope]);
      g.vert(c * r, s * r, 0, n[0], n[1], n[2], i / seg, 0);
      g.vert(c * r2, s * r2, h, n[0], n[1], n[2], i / seg, 1);
    }
    for (let i = 0; i < seg; i++) {
      const a = i * 2;
      if (r > 0) g.tri(a, a + 2, a + 1);
      if (r2 > 0) g.tri(a + 1, a + 2, a + 3);
    }
    if (caps) {
      for (const [z, rr, nz] of [[0, r, -1], [h, r2, 1]]) {
        if (rr <= 0) continue;
        const c0 = g.vert(0, 0, z, 0, 0, nz, 0.5, 0.5);
        for (let i = 0; i <= seg; i++) {
          const ph = 2 * Math.PI * i / seg, c = Math.cos(ph), s = Math.sin(ph);
          g.vert(c * rr, s * rr, z, 0, 0, nz, 0.5 + c * 0.5, 0.5 + s * 0.5);
        }
        for (let i = 0; i < seg; i++) {
          if (nz > 0) g.tri(c0, c0 + 1 + i, c0 + 2 + i);
          else g.tri(c0, c0 + 2 + i, c0 + 1 + i);
        }
      }
    }
    return g.orientByNormals();
  }

  static cone(r, h, seg = 16) { return Geo.cylinder(r, h, seg, { r2: 0 }); }

  // Flat disc in the XY plane facing +Z.
  static disc(r, seg = 24) {
    const g = new Geo();
    const c0 = g.vert(0, 0, 0, 0, 0, 1, 0.5, 0.5);
    for (let i = 0; i <= seg; i++) {
      const ph = 2 * Math.PI * i / seg, c = Math.cos(ph), s = Math.sin(ph);
      g.vert(c * r, s * r, 0, 0, 0, 1, 0.5 + c * 0.5, 0.5 + s * 0.5);
    }
    for (let i = 0; i < seg; i++) g.tri(c0, c0 + 1 + i, c0 + 2 + i);
    return g.orientByNormals();
  }

  // Torus around the Z axis: ring radius R, tube radius r.
  static torus(R, r, seg = 24, tube = 10) {
    const g = new Geo();
    for (let i = 0; i <= seg; i++) {
      const ph = 2 * Math.PI * i / seg, cp = Math.cos(ph), sp = Math.sin(ph);
      for (let j = 0; j <= tube; j++) {
        const th = 2 * Math.PI * j / tube, ct = Math.cos(th), st = Math.sin(th);
        g.vert((R + r * ct) * cp, (R + r * ct) * sp, r * st, ct * cp, ct * sp, st, i / seg, j / tube);
      }
    }
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < tube; j++) {
        const a = i * (tube + 1) + j;
        g.quadIdx(a, a + tube + 1, a + tube + 2, a + 1);
      }
    }
    return g.orientByNormals();
  }

  // Surface of revolution around the Z axis.  profile is a list of [radius, z]
  // points, normally running from bottom to top with the outside on the right.
  // opts.smooth = false gives each segment its own flat-shaded band.
  static lathe(profile, seg = 16, opts = {}) {
    const smooth = opts.smooth ?? true;
    const g = new Geo();
    const np = profile.length;
    const segN = [];
    for (let k = 0; k < np - 1; k++) {
      const dr = profile[k + 1][0] - profile[k][0], dz = profile[k + 1][1] - profile[k][1];
      const l = Math.hypot(dr, dz) || 1;
      segN.push([dz / l, -dr / l]);
    }
    const ring = (r, z, nr, nz, v) => {
      const base = g.vertexCount;
      for (let i = 0; i <= seg; i++) {
        const ph = 2 * Math.PI * i / seg, c = Math.cos(ph), s = Math.sin(ph);
        g.vert(c * r, s * r, z, c * nr, s * nr, nz, i / seg, v);
      }
      return base;
    };
    const band = (a, b) => {
      for (let i = 0; i < seg; i++) g.quadIdx(a + i, a + i + 1, b + i + 1, b + i);
    };
    if (smooth) {
      const bases = [];
      for (let k = 0; k < np; k++) {
        const n0 = segN[Math.max(0, k - 1)], n1 = segN[Math.min(np - 2, k)];
        const nr = n0[0] + n1[0], nz = n0[1] + n1[1], l = Math.hypot(nr, nz) || 1;
        bases.push(ring(profile[k][0], profile[k][1], nr / l, nz / l, k / (np - 1)));
      }
      for (let k = 0; k < np - 1; k++) band(bases[k], bases[k + 1]);
    } else {
      for (let k = 0; k < np - 1; k++) {
        const a = ring(profile[k][0], profile[k][1], segN[k][0], segN[k][1], k / (np - 1));
        const b = ring(profile[k + 1][0], profile[k + 1][1], segN[k][0], segN[k][1], (k + 1) / (np - 1));
        band(a, b);
      }
    }
    return g.orientByNormals();
  }

  // Extrudes a simple polygon [[x, y], ...] in the XY plane from z = 0 to z = h.
  static extrude(poly, h) {
    const g = new Geo();
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const pts = area < 0 ? poly.slice().reverse() : poly;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const d = v3.norm([b[1] - a[1], a[0] - b[0], 0]);
      const q0 = g.vert(a[0], a[1], 0, d[0], d[1], 0, 0, 0), q1 = g.vert(b[0], b[1], 0, d[0], d[1], 0, 1, 0);
      const q2 = g.vert(b[0], b[1], h, d[0], d[1], 0, 1, 1), q3 = g.vert(a[0], a[1], h, d[0], d[1], 0, 0, 1);
      g.quadIdx(q0, q1, q2, q3);
    }
    const tris = triangulate(pts);
    for (const [z, nz] of [[h, 1], [0, -1]]) {
      const base = g.vertexCount;
      for (const p of pts) g.vert(p[0], p[1], z, 0, 0, nz, p[0], p[1]);
      for (let i = 0; i < tris.length; i += 3) {
        if (nz > 0) g.tri(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
        else g.tri(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
      }
    }
    return g.orientByNormals();
  }

  // Tube of radius r (number, or function of the 0..1 path parameter) along a
  // polyline of 3D points.
  static tube(path, r, seg = 8, opts = {}) {
    const caps = opts.caps ?? true;
    const g = new Geo();
    const np = path.length;
    const rad = (k) => (typeof r === 'function' ? r(k / (np - 1)) : r);
    let tPrev = v3.norm(v3.sub(path[1], path[0]));
    let nrm = Math.abs(tPrev[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    nrm = v3.norm(v3.sub(nrm, v3.scale(tPrev, v3.dot(nrm, tPrev))));
    const tangents = [];
    for (let k = 0; k < np; k++) {
      const a = path[Math.max(0, k - 1)], b = path[Math.min(np - 1, k + 1)];
      const t = v3.norm(v3.sub(b, a));
      tangents.push(t);
      nrm = v3.norm(v3.sub(nrm, v3.scale(t, v3.dot(nrm, t))));
      const bin = v3.cross(t, nrm);
      for (let i = 0; i <= seg; i++) {
        const ph = 2 * Math.PI * i / seg, c = Math.cos(ph), s = Math.sin(ph);
        const d = [nrm[0] * c + bin[0] * s, nrm[1] * c + bin[1] * s, nrm[2] * c + bin[2] * s];
        const rr = rad(k);
        g.vert(path[k][0] + d[0] * rr, path[k][1] + d[1] * rr, path[k][2] + d[2] * rr, d[0], d[1], d[2], i / seg, k / (np - 1));
      }
    }
    for (let k = 0; k < np - 1; k++) {
      for (let i = 0; i < seg; i++) {
        const a = k * (seg + 1) + i;
        g.quadIdx(a, a + 1, a + seg + 2, a + seg + 1);
      }
    }
    if (caps) {
      for (const [k, sgn] of [[0, -1], [np - 1, 1]]) {
        if (rad(k) <= 0) continue;
        const t = v3.scale(tangents[k], sgn);
        const c0 = g.vert(path[k][0], path[k][1], path[k][2], t[0], t[1], t[2], 0.5, 0.5);
        const base = g.vertexCount;
        for (let i = 0; i <= seg; i++) {
          const src = (k * (seg + 1) + i) * 3;
          g.vert(g.p[src], g.p[src + 1], g.p[src + 2], t[0], t[1], t[2], 0.5, 0.5);
        }
        for (let i = 0; i < seg; i++) g.tri(c0, base + i, base + i + 1);
      }
    }
    return g.orientByNormals();
  }

  static merge(...geos) {
    const g = new Geo();
    for (const o of geos.flat()) g.add(o);
    return g;
  }

  // --- editing (all return this) -------------------------------------------

  // Appends another mesh, optionally transformed by matrix m.
  add(o, m = null) {
    if (m) o = o.clone().transform(m);
    const base = this.vertexCount;
    for (const k of ['p', 'n', 'c', 'uv', 'a']) {
      const src = o[k], dst = this[k];
      for (let i = 0; i < src.length; i++) dst.push(src[i]);
    }
    // (a mesh put together by hand may have no spare values)
    for (let i = 0, n = o.vertexCount * 2; i < n; i++) this.x[base * 2 + i] = (o.x && o.x[i]) || 0;
    for (let i = 0; i < o.idx.length; i++) this.idx.push(o.idx[i] + base);
    return this;
  }

  // A new mesh of some of this one's triangles: those for which
  // keep(i, middle) holds (i: the triangle's number, middle: the middle of
  // its corners).  The vertices come in the order they had, which matters
  // for a mesh that moves: what a moving triangle sweeps from key to key is
  // split by the order of its corners among the mesh's vertices (see
  // _tetLists in builder.js), and a thin thing that turns is drawn true only
  // if that order runs along it, as it does in the shapes made here (a tube's
  // vertices go ring by ring).  Numbered any other way, such a thing opens
  // into a sheet in a tilted view.
  pick(keep) {
    const p = this.p, idx = this.idx, used = new Uint8Array(this.vertexCount), tris = [];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      if (!keep(i / 3, [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3])) continue;
      tris.push(i);
      used[idx[i]] = used[idx[i + 1]] = used[idx[i + 2]] = 1;
    }
    const out = new Geo(), at = new Int32Array(this.vertexCount);
    for (let v = 0; v < used.length; v++) {
      if (!used[v]) continue;
      at[v] = out.p.length / 3;
      for (const [arr, w] of [['p', 3], ['n', 3], ['c', 3], ['uv', 2], ['a', 4], ['x', 2]]) for (let k = 0; k < w; k++) out[arr].push(this[arr][v * w + k]);
    }
    for (const i of tris) out.idx.push(at[idx[i]], at[idx[i + 1]], at[idx[i + 2]]);
    return out;
  }

  clone() {
    const g = new Geo();
    for (const k of ['p', 'n', 'c', 'uv', 'a', 'x', 'idx']) g[k] = this[k].slice();
    return g;
  }

  transform(m) {
    const nm = m4.normalMat(m);
    const p = this.p, n = this.n;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const a = n[i], b = n[i + 1], c = n[i + 2];
      const nx = nm[0] * a + nm[3] * b + nm[6] * c, ny = nm[1] * a + nm[4] * b + nm[7] * c, nz = nm[2] * a + nm[5] * b + nm[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / l; n[i + 1] = ny / l; n[i + 2] = nz / l;
    }
    if (m4.det3(m) < 0) {
      // A mirroring transform reverses the winding, and the cofactor matrix
      // (det * inverse transpose) has turned the normals inward: undo both.
      for (let i = 0; i < n.length; i++) n[i] = -n[i];
      this._swapWinding();
    }
    return this;
  }

  translate(x, y, z) { return this.transform(m4.translation(x, y, z)); }
  scale(x, y = x, z = x) { return this.transform(m4.scaling(x, y, z)); }
  rotateX(a) { return this.transform(m4.rotationX(a)); }
  rotateY(a) { return this.transform(m4.rotationY(a)); }
  rotateZ(a) { return this.transform(m4.rotationZ(a)); }

  // Sets the colour of every vertex.
  color(c) {
    c = parseColor(c);
    for (let i = 0; i < this.c.length; i += 3) { this.c[i] = c[0]; this.c[i + 1] = c[1]; this.c[i + 2] = c[2]; }
    return this;
  }

  // Sets colours per vertex: fn(position, normal, index) -> colour.
  colorBy(fn) {
    for (let i = 0, k = 0; i < this.c.length; i += 3, k++) {
      const c = parseColor(fn([this.p[i], this.p[i + 1], this.p[i + 2]], [this.n[i], this.n[i + 1], this.n[i + 2]], k));
      this.c[i] = c[0]; this.c[i + 1] = c[1]; this.c[i + 2] = c[2];
    }
    return this;
  }

  _attr(slot, v) {
    for (let i = slot; i < this.a.length; i += 4) this.a[i] = v;
    return this;
  }

  // Self-illumination as a multiple of the colour (0 = none; 1 looks lit in
  // daylight, 4+ glows and blooms).
  emissive(e) { return this._attr(0, e); }
  // 0 = matte, 1 = mirror-like (sharp highlight and sky reflection).
  gloss(v) { return this._attr(1, v); }
  // Material id (0..255) passed to the scene's `surface` shader hook.
  mat(id) { return this._attr(2, id); }
  flags(f) { return this._attr(3, f); }
  _flag(bit) {
    for (let i = 3; i < this.a.length; i += 4) this.a[i] |= bit;
    return this;
  }
  additive() { return this._flag(FLAG_ADDITIVE); }
  unlit() { return this._flag(FLAG_UNLIT); }
  // Has holes: for every pixel the scene's `cutout` shader hook says how much
  // of the surface is there (leaves, fences, grilles).  The holes show in its
  // shadow too, and the edges are smoothed.
  cutout() { return this._flag(FLAG_CUTOUT); }
  // See-through: drawn blended over what lies behind it, by `opacity` (0..1;
  // a number, or fn(position, normal, index) -> number).  The opacity is kept
  // in the mesh's `aux` value; the `surface` hook can change it (s.alpha).
  // Such a mesh writes no depth and casts no shadow.
  blend(opacity = 0.5) { this.aux(opacity); return this._flag(FLAG_BLEND); }
  // For part of a mesh that is placed with b.instances: it keeps the colour
  // it has, whatever tint a copy is given (a tree's trunk, a lamp's post).
  untinted() { return this._flag(FLAG_UNTINTED); }
  // A spare number per vertex, -1..1, which reaches the scene's shader hooks
  // as `aux`, interpolated across each triangle: a number, or
  // fn(position, normal, index) -> number.
  aux(v) {
    const p = this.p, n = this.n;
    for (let i = 0, count = this.vertexCount; i < count; i++) {
      this.x[i * 2] = typeof v === 'function' ? v([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]], [n[i * 3], n[i * 3 + 1], n[i * 3 + 2]], i) : v;
      if (this.x[i * 2 + 1] === undefined) this.x[i * 2 + 1] = 0;
    }
    return this;
  }
  // A spare whole number per vertex, 0..255, which reaches the shader hooks
  // as `tag`.  It is not interpolated: a triangle has the tag of its first corner.
  tag(v) {
    for (let i = 0, count = this.vertexCount; i < count; i++) {
      if (this.x[i * 2] === undefined) this.x[i * 2] = 0;
      this.x[i * 2 + 1] = v;
    }
    return this;
  }
  // Casts no shadow (it still receives them).
  noShadow() { return this._flag(FLAG_NO_SHADOW); }

  // Rescales and offsets texture coordinates.
  uvTransform(su, sv = su, ou = 0, ov = 0) {
    for (let i = 0; i < this.uv.length; i += 2) {
      this.uv[i] = this.uv[i] * su + ou; this.uv[i + 1] = this.uv[i + 1] * sv + ov;
    }
    return this;
  }

  _swapWinding() {
    const x = this.idx;
    for (let i = 0; i < x.length; i += 3) { const t = x[i + 1]; x[i + 1] = x[i + 2]; x[i + 2] = t; }
  }

  // Turns the mesh inside out.
  flip() {
    for (let i = 0; i < this.n.length; i++) this.n[i] = -this.n[i];
    this._swapWinding();
    return this;
  }

  // Marks the mesh as a thin sheet (a leaf, a flag, a fin): both sides are
  // drawn anyway, and with this whichever side is seen is lit as a front.
  doubleSided() { return this._flag(FLAG_TWO_SIDED); }

  // Makes every triangle's winding agree with its vertex normals.
  orientByNormals() {
    const x = this.idx, p = this.p, n = this.n;
    for (let i = 0; i < x.length; i += 3) {
      const a = x[i] * 3, b = x[i + 1] * 3, c = x[i + 2] * 3;
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const gn = v3.cross(e1, e2);
      const s = gn[0] * (n[a] + n[b] + n[c]) + gn[1] * (n[a + 1] + n[b + 1] + n[c + 1]) + gn[2] * (n[a + 2] + n[b + 2] + n[c + 2]);
      if (s < 0) { const t = x[i + 1]; x[i + 1] = x[i + 2]; x[i + 2] = t; }
    }
    return this;
  }

  // Recomputes normals from the triangles.  smooth = true averages over
  // vertices that share a position; false gives flat shading (and unshares
  // the vertices).
  computeNormals(smooth = true) {
    const p = this.p, x = this.idx;
    const faceN = (i) => {
      const a = x[i] * 3, b = x[i + 1] * 3, c = x[i + 2] * 3;
      return v3.cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]);
    };
    if (!smooth) {
      const g = new Geo();
      for (let i = 0; i < x.length; i += 3) {
        const fn = v3.norm(faceN(i));
        for (let k = 0; k < 3; k++) {
          const s = x[i + k];
          const d = g.vert(p[s * 3], p[s * 3 + 1], p[s * 3 + 2], fn[0], fn[1], fn[2], this.uv[s * 2], this.uv[s * 2 + 1]);
          for (let q = 0; q < 3; q++) g.c[d * 3 + q] = this.c[s * 3 + q];
          for (let q = 0; q < 4; q++) g.a[d * 4 + q] = this.a[s * 4 + q];
          for (let q = 0; q < 2; q++) g.x[d * 2 + q] = this.x[s * 2 + q] || 0;
        }
        g.idx.push(i, i + 1, i + 2);
      }
      for (const k of ['p', 'n', 'c', 'uv', 'a', 'x', 'idx']) this[k] = g[k];
      return this;
    }
    const acc = new Map();
    const key = (s) => `${Math.round(p[s * 3] * 1e4)},${Math.round(p[s * 3 + 1] * 1e4)},${Math.round(p[s * 3 + 2] * 1e4)}`;
    for (let i = 0; i < x.length; i += 3) {
      const fn = faceN(i);
      for (let k = 0; k < 3; k++) {
        const kk = key(x[i + k]);
        const e = acc.get(kk);
        if (e) { e[0] += fn[0]; e[1] += fn[1]; e[2] += fn[2]; } else acc.set(kk, fn.slice());
      }
    }
    for (let s = 0; s < this.vertexCount; s++) {
      const e = acc.get(key(s));
      if (!e) continue;
      const nn = v3.norm(e);
      this.n[s * 3] = nn[0]; this.n[s * 3 + 1] = nn[1]; this.n[s * 3 + 2] = nn[2];
    }
    return this;
  }

  // Axis-aligned bounds: { min: [x,y,z], max: [x,y,z] }.
  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (this.p[i + k] < min[k]) min[k] = this.p[i + k];
        if (this.p[i + k] > max[k]) max[k] = this.p[i + k];
      }
    }
    return { min, max };
  }
}

// Ear-clipping triangulation of a simple counter-clockwise polygon.
function triangulate(pts) {
  const n = pts.length, out = [];
  const idx = pts.map((_, i) => i);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (cross(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(pts[j], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) idx.splice(0, 1); // degenerate input: drop a vertex and carry on
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}
