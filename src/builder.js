// SceneBuilder turns 3D meshes plus a description of how they exist and move
// through time into the two kinds of 4D geometry the renderer draws:
//
//  * static geometry: a mesh that does not move.  Its world-volume is the mesh
//    extruded along the time axis, so slicing it only needs one time value per
//    vertex; it is drawn as ordinary triangles.  It may exist only during a
//    time window (optionally a repeating one).  The same mesh can be placed
//    many times over (instances): it is then stored once.
//
//  * dynamic geometry: a mesh sampled at a list of key times.  Every triangle
//    sweeps out a prism between consecutive keys, which is split into three
//    tetrahedra living in (x, y, z, t).  The GPU slices those tetrahedra with
//    the player's hyperplane every frame.

import { m4 } from './math.js';
import { parseColor, FLAG_ADDITIVE, FLAG_BLEND, FLAG_UNTINTED } from './geom.js';
import { bakeHorizon } from './util.js';

export const STATIC_STRIDE = 44;
export const DYN_STRIDE = 32;
export const INSTANCE_STRIDE = 80; // a 3 x 4 matrix by rows; tint r, g, b and a number of the scene's own; from, to, period
export const MAX_TEXTURES = 4;
// Everything is drawn in three layers: opaque, then see-through (blended),
// then additive light.
export const LAYERS = 3;
const layerOf = (flags) => (flags & FLAG_ADDITIVE ? 1 : flags & FLAG_BLEND ? 2 : 0);
export const FLAG_DYNAMIC = 0x40;
export const FLAG_CAP = 0x80;

const BIG = 1e30;
// Tetrahedra are grouped into chunks: runs of consecutive key intervals of one
// object.  Each chunk records its bounding box in space and time, which lets
// the renderer skip every chunk the player's slice cannot touch.
const CHUNK_TETS = 48;
// The numbers given to tetrahedra come in blocks of this many, each block
// belonging to one chunk (see finalize).
export const BLOCK = 16;
// Static pieces with a time window get their own visibility test if they have
// at least this many triangles (additive ones always do: they cover a lot of screen).
const WINDOW_CULL_TRIANGLES = 48;
// Static geometry is sorted into cells of neighbouring triangles of about
// this size (more in a very large scene), each of which the renderer can
// leave out of a pass that cannot see it.
const CELL_TRIANGLES = 2048;

class Grow {
  constructor(stride, cap = 4096) {
    this.stride = stride;
    this.count = 0;
    this._alloc(cap);
  }
  _alloc(cap) {
    const buf = new ArrayBuffer(cap * this.stride);
    if (this.u8) new Uint8Array(buf).set(this.u8.subarray(0, this.count * this.stride));
    this.cap = cap;
    this.u8 = new Uint8Array(buf);
    this.i8 = new Int8Array(buf);
    this.f32 = new Float32Array(buf);
    this.u32 = new Uint32Array(buf);
    this.u16 = new Uint16Array(buf);
  }
  reserve(n) {
    if (this.count + n <= this.cap) return;
    let cap = this.cap;
    while (cap < this.count + n) cap *= 2;
    this._alloc(cap);
  }
}

const f32tmp = new Float32Array(1), u32tmp = new Uint32Array(f32tmp.buffer);
export function toHalf(v) {
  f32tmp[0] = v;
  const x = u32tmp[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7bff;
  return (sign | (exp << 10) | (mant >> 13)) + ((mant & 0x1000) ? 1 : 0);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const encEmissive = (e) => Math.round(255 * Math.sqrt(clamp01(e / 32)));
const encUnit = (v) => Math.round(255 * clamp01(v));
const encSnorm = (v) => Math.round(127 * (v < -1 ? -1 : v > 1 ? 1 : v));

function resolveTimes(o) {
  let times = o.times;
  if (!times) {
    if (o.from === undefined || o.to === undefined) throw new Error('dynamic(): give `times`, or `from`, `to` and `step`');
    const n = Math.max(1, Math.ceil((o.to - o.from) / (o.step ?? 0.25) - 1e-9));
    times = [];
    for (let i = 0; i <= n; i++) times.push(o.from + (o.to - o.from) * i / n);
  }
  if (times.length < 2) throw new Error('dynamic(): need at least two key times');
  for (let i = 1; i < times.length; i++) {
    if (!(times[i] > times[i - 1])) throw new Error('dynamic(): key times must be strictly increasing');
  }
  return times;
}

// Splits a set of points into groups of neighbours: in two at the middle of
// its longest side, again and again, until a group has no more than `most`
// points or is no bigger than `small` across.  px, py, pz: the points.
// Returns the points' numbers, group after group (their order within a group
// is the order they came in), and where each group ends: { order, ends }.
// Groups that are neighbours in the list are neighbours in space, so what a
// view takes in is mostly a few runs of them.
function spatialGroups(px, py, pz, most, small = 4) {
  const n = px.length, order = new Uint32Array(n), tmp = new Uint32Array(n), ends = [];
  for (let i = 0; i < n; i++) order[i] = i;
  const split = (lo, hi) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const p = order[i], x = px[p], y = py[p], z = pz[p];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
    if (hi - lo > most && Math.max(ex, ey, ez) > small) {
      const c = ex >= ey && ex >= ez ? px : ey >= ez ? py : pz;
      const mid = c === px ? (x0 + x1) / 2 : c === py ? (y0 + y1) / 2 : (z0 + z1) / 2;
      let l = lo, r = 0;
      for (let i = lo; i < hi; i++) { const p = order[i]; if (c[p] < mid) order[l++] = p; else tmp[r++] = p; }
      order.set(tmp.subarray(0, r), l);
      if (l > lo && l < hi) { split(lo, l); split(l, hi); return; }
    }
    ends.push(hi);
  };
  if (n) split(0, n);
  return { order, ends };
}

export class SceneBuilder {
  constructor() {
    this.sv = new Grow(STATIC_STRIDE);
    this.sIdx = [new Grow(4), new Grow(4), new Grow(4)]; // per layer
    // Moving geometry.  A mesh that changes shape or colour is stored vertex by
    // vertex at every key time; one that only moves is stored once, as it is,
    // with the matrix that places it at each key (`keys`: three rows of four,
    // then the key's time and the sign of the matrix's determinant).  The
    // tetrahedra are not stored at all: those of one step from key to key are
    // the same for every step, so there is one list of them per mesh (`tmpl`:
    // four corners each, as vertex numbers within the mesh, bit 30 set for
    // "at the later key" and bit 31 on the first for the orientation), and a
    // chunk says which list, which vertices and which keys it stands for.
    this.dv = new Grow(DYN_STRIDE);
    this.keys = new Grow(64);
    this.tmpl = new Grow(16);
    this.shared = new Map(); // meshes and lists already stored, by their contents (see _share)
    // per layer: { count, t0, t1, box: [minx, miny, minz, maxx, maxy, maxz], tmpl, per, vert, nv, key, rigid, ... }
    this.chunks = [[], [], []];
    // one entry per static() call and layer: { layer, first, count, from, to, period, box }
    this.sCalls = [];
    this.solidCalls = []; // index ranges { layer, first, count } of what the player cannot pass through
    // instances(): the copies' placements, the indices of the meshes copied,
    // and one entry per call and layer: { layer, first, count, firstInstance, instances }
    this.inst = new Grow(INSTANCE_STRIDE);
    this.iIdx = new Grow(4);
    this.iCalls = [];
    this.solidExtra = []; // corners of the solid triangles of instanced meshes, where they were placed
    this.textures = []; // data for the scene's shader: { name, width, height, channels, float, data, repeat, nearest, horizon }
    this.counts = { staticObjects: 0, dynamicObjects: 0, instances: 0, instancedTriangles: 0, tetrahedra: 0 };
  }

  // Many moving things are copies of one mesh.  What has just been written at
  // the end of a store (`n` records from `first`) is dropped again if the same
  // bytes are in the store already, and the place of those is returned.
  _share(store, first, n) {
    const words = store.u32.subarray(first * store.stride / 4, (first + n) * store.stride / 4);
    let h = 2166136261 ^ words.length;
    for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 16777619);
    const key = `${store.stride}:${n}:${h >>> 0}`;
    const list = this.shared.get(key) || [];
    for (const at of list) {
      const other = store.u32.subarray(at * store.stride / 4, (at + n) * store.stride / 4);
      let same = true;
      for (let i = 0; i < words.length && same; i++) same = other[i] === words[i];
      if (same) return at;
    }
    list.push(first);
    this.shared.set(key, list);
    store.count = first + n;
    return first;
  }

  // Writes a mesh's vertices into the static vertex buffer, moved by the
  // matrix m if there is one.  Returns where they start and their bounds.
  _putStatic(geo, m, from, to, period) {
    const nm = m ? m4.normalMat(m) : null;
    const nsign = m && m4.det3(m) < 0 ? -1 : 1;
    const nv = geo.vertexCount, sv = this.sv, base = sv.count, gx = geo.x || [];
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    sv.reserve(nv);
    for (let i = 0; i < nv; i++) {
      let x = geo.p[i * 3], y = geo.p[i * 3 + 1], z = geo.p[i * 3 + 2];
      let nx = geo.n[i * 3], ny = geo.n[i * 3 + 1], nz = geo.n[i * 3 + 2];
      if (m) {
        const px = m[0] * x + m[4] * y + m[8] * z + m[12], py = m[1] * x + m[5] * y + m[9] * z + m[13];
        z = m[2] * x + m[6] * y + m[10] * z + m[14]; x = px; y = py;
        const a = nm[0] * nx + nm[3] * ny + nm[6] * nz, b = nm[1] * nx + nm[4] * ny + nm[7] * nz;
        const c = nm[2] * nx + nm[5] * ny + nm[8] * nz, l = (Math.hypot(a, b, c) || 1) * nsign;
        nx = a / l; ny = b / l; nz = c / l;
      }
      if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
      if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
      const o8 = (base + i) * STATIC_STRIDE, o32 = o8 >> 2;
      sv.f32[o32] = x; sv.f32[o32 + 1] = y; sv.f32[o32 + 2] = z;
      sv.i8[o8 + 12] = encSnorm(nx); sv.i8[o8 + 13] = encSnorm(ny); sv.i8[o8 + 14] = encSnorm(nz);
      sv.i8[o8 + 15] = encSnorm(gx[i * 2] || 0);
      sv.u8[o8 + 16] = encUnit(geo.c[i * 3]); sv.u8[o8 + 17] = encUnit(geo.c[i * 3 + 1]); sv.u8[o8 + 18] = encUnit(geo.c[i * 3 + 2]);
      sv.u8[o8 + 19] = encEmissive(geo.a[i * 4]);
      sv.u8[o8 + 20] = geo.a[i * 4 + 2] & 255; sv.u8[o8 + 21] = encUnit(geo.a[i * 4 + 1]);
      sv.u8[o8 + 22] = geo.a[i * 4 + 3] & (63 | FLAG_UNTINTED);
      sv.u8[o8 + 23] = (gx[i * 2 + 1] || 0) & 255;
      sv.f32[o32 + 6] = from; sv.f32[o32 + 7] = to; sv.f32[o32 + 8] = period;
      sv.f32[o32 + 9] = geo.uv[i * 2]; sv.f32[o32 + 10] = geo.uv[i * 2 + 1];
    }
    sv.count += nv;
    return { base, box };
  }

  // Adds geometry that does not move.
  //   from, to   it exists for from <= t < to (default: always)
  //   period     if > 0 the window repeats: visible while (t - from) mod period < to - from
  //   transform  optional matrix applied to the mesh
  //   solid      false to let the player pass through it.  Otherwise whatever
  //              is always there (no time window) and opaque is solid; with
  //              true, what is see-through (blended) is solid as well.
  static(geo, o = {}) {
    const from = Math.max(-BIG, o.from ?? -BIG), to = Math.min(BIG, o.to ?? BIG), period = o.period ?? 0;
    const within = o.within > 0 ? o.within : BIG; // detail: drawn only when the viewer is this near
    const m = o.transform || null;
    const flip = m ? m4.det3(m) < 0 : false;
    const { base, box } = this._putStatic(geo, m, from, to, period);
    const idx = geo.idx;
    const before = this.sIdx.map((s) => s.count);
    for (let i = 0; i < idx.length; i += 3) {
      const layer = layerOf(geo.a[idx[i] * 4 + 3]);
      const dst = this.sIdx[layer];
      dst.reserve(3);
      dst.u32[dst.count] = base + idx[i];
      dst.u32[dst.count + 1] = base + idx[flip ? i + 2 : i + 1];
      dst.u32[dst.count + 2] = base + idx[flip ? i + 1 : i + 2];
      dst.count += 3;
    }
    for (let layer = 0; layer < LAYERS; layer++) {
      const count = this.sIdx[layer].count - before[layer];
      if (count) this.sCalls.push({ layer, first: before[layer], count, from, to, period, box, within });
    }
    if (o.solid !== false && from <= -BIG && to >= BIG) {
      for (const layer of o.solid === true ? [0, 2] : [0]) {
        if (this.sIdx[layer].count > before[layer]) this.solidCalls.push({ layer, first: before[layer], count: this.sIdx[layer].count - before[layer] });
      }
    }
    this.counts.staticObjects++;
    this._progress();
    return this;
  }

  // Adds many copies of one mesh that does not move.  The mesh is stored once
  // and drawn at every placement, which costs far less memory and loading
  // time than adding each copy with static().
  //   at         the placements: a list of matrices, or of
  //              { transform, tint, data, from, to, period }.  tint (a colour)
  //              multiplies the mesh's own colours for that copy (except the
  //              parts marked .untinted()), and data is a number of the
  //              scene's own; both reach the `surface` hook in s.inst
  //              (rgb = the tint, w = data).  from, to and period give a copy
  //              a time window of its own.
  //   from, to, period   the time window of every copy that has none of its own
  //   solid      as for static(): copies that are always there are solid
  instances(geo, at, o = {}) {
    const win = (it) => {
      const from = Math.max(-BIG, it.from ?? o.from ?? -BIG), to = Math.min(BIG, it.to ?? o.to ?? BIG);
      return [from, to, it.period ?? o.period ?? 0];
    };
    const items = Array.from(at, (a) => (a && a.transform ? a : { transform: a }));
    if (!items.length || !geo.vertexCount) return this;
    const within = o.within > 0 ? o.within : BIG; // detail: drawn only when the viewer is this near
    const { base, box: local } = this._putStatic(geo, null, -BIG, BIG, 0);
    const idx = geo.idx, inst = this.inst, dst = this.iIdx;
    // Mirrored copies have their triangles wound the other way, so they are
    // drawn as a group of their own.
    for (const mirrored of [false, true]) {
      const all = items.filter((it) => (m4.det3(it.transform) < 0) === mirrored);
      if (!all.length) continue;
      // the mesh's triangles, layer by layer
      const ranges = [];
      for (let layer = 0; layer < LAYERS; layer++) {
        const first = dst.count;
        for (let i = 0; i < idx.length; i += 3) {
          if (layerOf(geo.a[idx[i] * 4 + 3]) !== layer) continue;
          dst.reserve(3);
          dst.u32[dst.count] = base + idx[i];
          dst.u32[dst.count + 1] = base + idx[mirrored ? i + 2 : i + 1];
          dst.u32[dst.count + 2] = base + idx[mirrored ? i + 1 : i + 2];
          dst.count += 3;
        }
        if (dst.count > first) ranges.push({ layer, first, count: dst.count - first });
      }
      // Copies that are drawn only from near by are put in clusters, each of
      // which the renderer tests by itself: the cells of a grid twice as wide
      // as the distance, so that only a few of them are ever in reach.
      const cells = new Map();
      if (within < BIG) {
        const size = 2 * Math.max(within, 0.5);
        for (const it of all) {
          const m = it.transform, key = `${Math.floor(m[12] / size)},${Math.floor(m[13] / size)},${Math.floor(m[14] / size)}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(it);
        }
      } else if (all.length >= 16 && all.length * geo.triangleCount >= 2 * CELL_TRIANGLES && !ranges.some((r) => r.layer === 2)) {
        // A large group goes in clusters of neighbours as well, so that the
        // renderer can leave out the ones no pass can see.  (Not see-through
        // copies: they are drawn in the order they were given.)
        const most = Math.max(Math.ceil(all.length / 128), Math.ceil(CELL_TRIANGLES / geo.triangleCount));
        const { order, ends } = spatialGroups(Float32Array.from(all, (it) => it.transform[12]), Float32Array.from(all, (it) => it.transform[13]), Float32Array.from(all, (it) => it.transform[14]), most, 0);
        let lo = 0;
        ends.forEach((hi, k) => { cells.set(k, Array.from(order.subarray(lo, hi), (i) => all[i])); lo = hi; });
      } else {
        cells.set('', all);
      }
      for (const group of cells.values()) {
        const firstInstance = inst.count;
        inst.reserve(group.length);
        // the group's bounds, and its time window if every copy has the same one
        const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        let shared = win(group[0]);
        for (const it of group) {
          const m = it.transform, o32 = inst.count * (INSTANCE_STRIDE >> 2), w = win(it);
          // (a tint is given like any colour, in sRGB, and applied to linear ones)
          const tint = it.tint !== undefined ? parseColor(it.tint).map((v) => Math.pow(v, 2.2)) : [1, 1, 1];
          inst.f32.set([m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], tint[0], tint[1], tint[2], it.data ?? 0, w[0], w[1], w[2], 0], o32);
          inst.count++;
          if (shared && (w[0] !== shared[0] || w[1] !== shared[1] || w[2] !== shared[2])) shared = null;
          for (let c = 0; c < 8; c++) {
            const x = local[c & 1 ? 3 : 0], y = local[c & 2 ? 4 : 1], z = local[c & 4 ? 5 : 2];
            const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
            for (let k = 0; k < 3; k++) { if (p[k] < box[k]) box[k] = p[k]; if (p[k] > box[k + 3]) box[k + 3] = p[k]; }
          }
      }
      // copies with windows of their own: the group is drawn whenever any of them might be there
      const [from, to, period] = shared || [-BIG, BIG, 0];
      for (const r of ranges) this.iCalls.push({ ...r, firstInstance, instances: group.length, box, from, to, period, within });
      }
    }
    // what is always there is solid
    const lasting = o.solid === false ? [] : items.filter((it) => { const w = win(it); return w[0] <= -BIG && w[1] >= BIG; });
    if (lasting.length) {
      const corners = [];
      for (let i = 0; i < idx.length; i += 3) {
        if (layerOf(geo.a[idx[i] * 4 + 3]) !== 0) continue;
        for (let k = 0; k < 3; k++) corners.push(geo.p[idx[i + k] * 3], geo.p[idx[i + k] * 3 + 1], geo.p[idx[i + k] * 3 + 2]);
      }
      if (corners.length) {
        const out = new Float32Array(corners.length * lasting.length);
        let at2 = 0;
        for (const { transform: m } of lasting) {
          for (let i = 0; i < corners.length; i += 3) {
            const x = corners[i], y = corners[i + 1], z = corners[i + 2];
            out[at2++] = m[0] * x + m[4] * y + m[8] * z + m[12];
            out[at2++] = m[1] * x + m[5] * y + m[9] * z + m[13];
            out[at2++] = m[2] * x + m[6] * y + m[10] * z + m[14];
          }
        }
        this.solidExtra.push(out);
      }
    }
    this.counts.staticObjects++;
    this.counts.instances += items.length;
    this.counts.instancedTriangles += geo.triangleCount * items.length;
    this._progress();
    return this;
  }

  // Gives the scene's shader a table of numbers to look up: a texture.  In
  // the scene's WGSL it becomes a function of that name,
  //   fn <name>(uv: vec2f) -> vec4f
  // (uv from 0 to 1 across the table; row 0 is at v = 0).
  //   width, height   the table's size
  //   data       width * height * channels numbers, row by row: a Uint8Array
  //              (0..255 becomes 0..1) or a Float32Array (kept as 16-bit
  //              floats).  channels is 1, 2 or 4, worked out from the length.
  //   repeat     true to wrap around at the edges (default: clamp)
  //   nearest    true to read single entries (default: blend between them)
  // A scene can have up to four.
  texture(name, o) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`texture(): "${name}" is not a usable name (letters and digits, starting with a letter)`);
    if (this.textures.some((t) => t.name === name)) throw new Error(`texture(): "${name}" is used twice`);
    if (this.textures.length >= MAX_TEXTURES) throw new Error(`texture(): a scene can have at most ${MAX_TEXTURES}`);
    const { width, height } = o;
    const float = o.data instanceof Float32Array;
    const data = float ? o.data : o.data instanceof Uint8Array ? o.data : Uint8Array.from(o.data);
    const channels = data.length / (width * height);
    if (![1, 2, 4].includes(channels)) throw new Error(`texture(): ${data.length} numbers for ${width} x ${height} entries (need 1, 2 or 4 each)`);
    this.textures.push({ name, width, height, channels, float, data, repeat: !!o.repeat, nearest: !!o.nearest, horizon: o.horizon || null });
    return this;
  }

  // Lets terrain cast its shadow at any distance and at any moment: works
  // out, over a grid, how high the land stands against the sky in every
  // direction, and gives the shader
  //   fn <name>Sun(pos: vec3f, toLight: vec3f) -> f32
  // which is 0 where the land hides a light in that direction from a point
  // on the ground at pos, and 1 where it does not.  Use it on `s.sun` in the
  // `surface` hook, with the sun as it stands at s.t.
  //   height     (x, y) -> z, the terrain
  //   x0, y0, x1, y1   the area covered
  //   nx, ny     grid size (default 128 x 128)
  //   reach      how far away land is looked for, metres (default 3000)
  //   soft       width of the shadow's edge, radians (default 0.03)
  // For points that are not on the ground there is
  //   fn <name>SunAt(pos: vec3f, toLight: vec3f, above: f32) -> f32
  // where `above` is the point's height over the terrain, in metres.
  // Takes one of the scene's four textures.
  horizon(name, height, o) {
    const baked = bakeHorizon(height, o);
    return this.texture(name, { ...baked, horizon: { x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, nx: baked.nx, ny: baked.ny, near: baked.near, far: baked.far, soft: o.soft ?? 0.03 } });
  }

  // Adds geometry that moves or changes.
  //   geo        a Geo, or a function t -> Geo (every result must have the same
  //              vertex count and triangle list) for shape animation
  //   times      strictly increasing key times; or give from, to, step
  //   transform  function t -> matrix placing the mesh at time t (optional)
  //   paint      function t -> { color?, emissive? } overriding the whole mesh (optional)
  //   holdBefore keep the first pose for all earlier times (default false)
  //   holdAfter  keep the last pose for all later times (default false)
  //   caps       'auto' (default): seal the ends in time that are not held, so
  //              a tilted slice through the moment of (dis)appearance looks
  //              solid; or 'none', 'start', 'end', 'both'
  // Between keys every vertex moves in a straight line at constant speed, so
  // straight uniform motion needs just two keys, while turning or accelerating
  // objects need more.
  dynamic(geo, o = {}) {
    const times = resolveTimes(o);
    const nk = times.length;
    const geoAt = typeof geo === 'function' ? geo : () => geo;
    const xf = o.transform || null, paint = o.paint || null;
    const g0 = geoAt(times[0]);
    const nv = g0.vertexCount, idx = g0.idx;
    if (nv === 0) return this;
    const dv = this.dv, base = dv.count;
    const within = o.within > 0 ? o.within : BIG; // detail: drawn only when the viewer is this near
    const capMode = o.caps ?? 'auto';
    const capStart = capMode === 'both' || capMode === 'start' || (capMode === 'auto' && !o.holdBefore);
    const capEnd = capMode === 'both' || capMode === 'end' || (capMode === 'auto' && !o.holdAfter);
    // only moved about: the same mesh at every key, placed by `transform` and not repainted
    const rigid = typeof geo !== 'function' && !paint;
    dv.reserve(nv * (rigid ? 1 : nk) + (capStart ? nv + 1 : 0) + (capEnd ? nv + 1 : 0));

    const writeKey = (g, t, m, pt, dstBase, extraFlags) => {
      if (g.vertexCount !== nv) throw new Error('dynamic(): the mesh must keep the same vertex count at every key');
      const nm = m ? m4.normalMat(m) : null;
      const nsign = m && m4.det3(m) < 0 ? -1 : 1;
      const col = pt && pt.color !== undefined ? parseColor(pt.color) : null;
      const emi = pt && pt.emissive !== undefined ? pt.emissive : null;
      let cx = 0, cy = 0, cz = 0;
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < nv; i++) {
        let x = g.p[i * 3], y = g.p[i * 3 + 1], z = g.p[i * 3 + 2];
        let nx = g.n[i * 3], ny = g.n[i * 3 + 1], nz = g.n[i * 3 + 2];
        if (m) {
          const px = m[0] * x + m[4] * y + m[8] * z + m[12], py = m[1] * x + m[5] * y + m[9] * z + m[13];
          z = m[2] * x + m[6] * y + m[10] * z + m[14]; x = px; y = py;
          const a = nm[0] * nx + nm[3] * ny + nm[6] * nz, b = nm[1] * nx + nm[4] * ny + nm[7] * nz;
          const c = nm[2] * nx + nm[5] * ny + nm[8] * nz, l = (Math.hypot(a, b, c) || 1) * nsign;
          nx = a / l; ny = b / l; nz = c / l;
        }
        cx += x; cy += y; cz += z;
        if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
        if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
        const o8 = (dstBase + i) * DYN_STRIDE, o32 = o8 >> 2;
        dv.f32[o32] = x; dv.f32[o32 + 1] = y; dv.f32[o32 + 2] = z; dv.f32[o32 + 3] = t;
        dv.i8[o8 + 16] = encSnorm(nx); dv.i8[o8 + 17] = encSnorm(ny); dv.i8[o8 + 18] = encSnorm(nz);
        dv.i8[o8 + 19] = encSnorm((g.x && g.x[i * 2]) || 0);
        dv.u8[o8 + 27] = ((g.x && g.x[i * 2 + 1]) || 0) & 255;
        dv.u8[o8 + 20] = encUnit(col ? col[0] : g.c[i * 3]); dv.u8[o8 + 21] = encUnit(col ? col[1] : g.c[i * 3 + 1]);
        dv.u8[o8 + 22] = encUnit(col ? col[2] : g.c[i * 3 + 2]);
        dv.u8[o8 + 23] = encEmissive(emi !== null ? emi : g.a[i * 4]);
        dv.u8[o8 + 24] = g.a[i * 4 + 2] & 255; dv.u8[o8 + 25] = encUnit(g.a[i * 4 + 1]);
        dv.u8[o8 + 26] = (g.a[i * 4 + 3] & 63) | FLAG_DYNAMIC | extraFlags;
        dv.u16[(o8 + 28) >> 1] = toHalf(g.uv[i * 2]); dv.u16[(o8 + 30) >> 1] = toHalf(g.uv[i * 2 + 1]);
      }
      return { centre: [cx / nv, cy / nv, cz / nv], box };
    };

    const boxes = [];
    let vertBase = base, keyBase = 0, mirrored = false;
    if (rigid) {
      // the mesh as it is, once (or not at all, if the same mesh is there already) ...
      const own = writeKey(g0, 0, null, null, base, 0).box;
      vertBase = this._share(dv, base, nv);
      // ... and where each key puts it
      const keys = this.keys;
      keys.reserve(nk);
      keyBase = keys.count;
      for (let k = 0; k < nk; k++) {
        const t = times[k], m = xf ? xf(t) : m4.identity(), det = m4.det3(m);
        if (k === 0) mirrored = det < 0;
        keys.f32.set([m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], t, det < 0 ? -1 : 1, 0, 0], keys.count * 16);
        keys.count++;
        // (bounds: the mesh's own box, placed, takes in the placed mesh)
        const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let c = 0; c < 8; c++) {
          const x = own[c & 1 ? 3 : 0], y = own[c & 2 ? 4 : 1], z = own[c & 4 ? 5 : 2];
          const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
          for (let j = 0; j < 3; j++) { if (p[j] < box[j]) box[j] = p[j]; if (p[j] > box[j + 3]) box[j + 3] = p[j]; }
        }
        boxes.push(box);
      }
    } else {
      for (let k = 0; k < nk; k++) {
        const t = times[k];
        boxes.push(writeKey(k === 0 ? g0 : geoAt(t), t, xf ? xf(t) : null, paint ? paint(t) : null, base + k * nv, 0).box);
      }
      dv.count += nv * nk;
    }

    // Order the vertices of each triangle by a rank that is shared between
    // vertices at the same position, so neighbouring prisms split their common
    // quad along the same diagonal.
    const rank = new Uint32Array(nv);
    {
      const seen = new Map();
      for (let i = 0; i < nv; i++) {
        const key = `${Math.round(g0.p[i * 3] * 1e4)},${Math.round(g0.p[i * 3 + 1] * 1e4)},${Math.round(g0.p[i * 3 + 2] * 1e4)}`;
        let r = seen.get(key);
        if (r === undefined) { r = seen.size; seen.set(key, r); }
        rank[i] = r;
      }
    }
    const ntri = idx.length / 3;

    // Does the winding of the placed triangles agree with their normals?  (A
    // mirroring transform reverses it.)  Judged at whichever of the first,
    // middle and last key is least degenerate.
    let agree = 0;
    for (const k of rigid ? [0] : [0, nk >> 1, nk - 1]) {
      let sum = 0;
      const at = (v) => (vertBase + k * nv + v) * DYN_STRIDE;
      for (let i = 0; i < ntri; i++) {
        const A = at(idx[i * 3]), B = at(idx[i * 3 + 1]), Cc = at(idx[i * 3 + 2]);
        const f = dv.f32, a4 = A >> 2, b4 = B >> 2, c4 = Cc >> 2;
        const ux = f[b4] - f[a4], uy = f[b4 + 1] - f[a4 + 1], uz = f[b4 + 2] - f[a4 + 2];
        const vx = f[c4] - f[a4], vy = f[c4 + 1] - f[a4 + 1], vz = f[c4 + 2] - f[a4 + 2];
        const n8 = dv.i8;
        sum += (uy * vz - uz * vy) * (n8[A + 16] + n8[B + 16] + n8[Cc + 16])
             + (uz * vx - ux * vz) * (n8[A + 17] + n8[B + 17] + n8[Cc + 17])
             + (ux * vy - uy * vx) * (n8[A + 18] + n8[B + 18] + n8[Cc + 18]);
      }
      if (Math.abs(sum) > Math.abs(agree)) agree = sum;
    }
    // (a mesh stored as it is was judged as it is: a mirroring placement turns it round)
    const inward = (agree < 0) !== (rigid && mirrored) ? 1 : 0;

    const tris = new Uint32Array(idx.length);
    const layers = new Uint8Array(ntri);
    // Whether a triangle's sorted vertex order is an odd permutation of its
    // winding (combined with the above): this fixes the sign of the 4D normal
    // of its tetrahedra, and travels in the top bit of their first index.
    const flipBit = new Uint32Array(ntri);
    for (let i = 0; i < ntri; i++) {
      let a = idx[i * 3], b = idx[i * 3 + 1], c = idx[i * 3 + 2], s, odd = inward;
      layers[i] = layerOf(g0.a[a * 4 + 3]);
      if (rank[a] > rank[b]) { s = a; a = b; b = s; odd ^= 1; }
      if (rank[b] > rank[c]) { s = b; b = c; c = s; odd ^= 1; }
      if (rank[a] > rank[b]) { s = a; a = b; b = s; odd ^= 1; }
      tris[i * 3] = a; tris[i * 3 + 1] = b; tris[i * 3 + 2] = c;
      flipBit[i] = odd ? 0x80000000 : 0;
    }

    const grow = (box, b) => {
      for (let i = 0; i < 3; i++) { if (b[i] < box[i]) box[i] = b[i]; if (b[i + 3] > box[i + 3]) box[i + 3] = b[i + 3]; }
    };
    const LATER = 0x40000000;
    for (let layer = 0; layer < LAYERS; layer++) {
      const mine = [];
      for (let i = 0; i < ntri; i++) if (layers[i] === layer) mine.push(i);
      if (!mine.length) continue;
      // the tetrahedra of one step: three to a triangle's prism
      const per = mine.length * 3, tm = this.tmpl;
      tm.reserve(per);
      const at = tm.count;
      mine.forEach((i, n) => {
        const a = tris[i * 3], b = tris[i * 3 + 1], c = tris[i * 3 + 2], fb = flipBit[i];
        tm.u32.set([(a | fb) >>> 0, b, c, a | LATER, (b | fb) >>> 0, c, a | LATER, b | LATER, (c | fb) >>> 0, a | LATER, b | LATER, c | LATER], (at + n * 3) * 4);
      });
      const list = this._share(tm, at, per);
      const chunks = this.chunks[layer];
      let chunk = null;
      for (let k = 0; k < nk - 1; k++) {
        if (!chunk) {
          chunk = { count: 0, t0: times[k], t1: times[k], box: boxes[k].slice(), within, path: [boxes[k]],
            tmpl: list, per, vert: rigid ? vertBase : base + k * nv, nv: rigid ? 0 : nv, key: rigid ? keyBase + k : 0, rigid };
        }
        chunk.count += per;
        chunk.t1 = times[k + 1];
        grow(chunk.box, boxes[k + 1]);
        chunk.path.push(boxes[k + 1]);
        if (chunk.count >= CHUNK_TETS) { chunks.push(chunk); chunk = null; }
      }
      if (chunk) chunks.push(chunk);
      this.counts.tetrahedra += per * (nk - 1);
    }

    // Seal an end in time with the solid interior of the mesh at that moment:
    // a fan of tetrahedra from the centroid, all at one instant.
    const cap = (k) => {
      const t = times[k], g = k === 0 ? g0 : geoAt(t);
      dv.reserve(nv + 1);
      const cb = dv.count;
      const { centre, box } = writeKey(g, t, xf ? xf(t) : null, paint ? paint(t) : null, cb, FLAG_CAP);
      // centre vertex: a copy of vertex 0 moved to the centroid
      const src = cb * DYN_STRIDE, dst = (cb + nv) * DYN_STRIDE;
      dv.u8.copyWithin(dst, src, src + DYN_STRIDE);
      dv.f32[dst >> 2] = centre[0]; dv.f32[(dst >> 2) + 1] = centre[1]; dv.f32[(dst >> 2) + 2] = centre[2];
      dv.count += nv + 1;
      const fan = [];
      for (let i = 0; i < ntri; i++) if (!layers[i]) fan.push(nv, idx[i * 3], idx[i * 3 + 1], idx[i * 3 + 2]);
      if (!fan.length) return;
      const tm = this.tmpl, per = fan.length / 4;
      tm.reserve(per);
      const at = tm.count;
      tm.u32.set(fan, at * 4);
      this.chunks[0].push({ count: per, t0: t, t1: t, box, within, path: [box], tmpl: this._share(tm, at, per), per, vert: cb, nv: 0, key: 0, rigid: false });
      this.counts.tetrahedra += per;
    };
    if (capStart) cap(0);
    if (capEnd) cap(nk - 1);

    if (o.holdBefore) {
      const g = xf ? g0.clone().transform(xf(times[0])) : g0;
      this.static(paint ? applyPaint(g === g0 ? g0.clone() : g, paint(times[0])) : g, { to: times[0], within: o.within });
      this.counts.staticObjects--;
    }
    if (o.holdAfter) {
      const tl2 = times[nk - 1];
      const gl = geoAt(tl2);
      const g = xf ? gl.clone().transform(xf(tl2)) : gl;
      this.static(paint ? applyPaint(g === gl ? gl.clone() : g, paint(tl2)) : g, { from: tl2, within: o.within });
      this.counts.staticObjects--;
    }
    this.counts.dynamicObjects++;
    this._progress();
    return this;
  }

  // Tells whoever is waiting how far the build has got: `onProgress`, if set,
  // is called after every piece with the bytes of geometry made so far.
  _progress() {
    if (this.onProgress) this.onProgress(this._work());
  }

  // How much has been made so far, as bytes of geometry: what the progress of
  // a build is measured in (the final figure is in the statistics as `work`).
  _work() {
    return this.sv.count * STATIC_STRIDE + this.inst.count * INSTANCE_STRIDE + this.dv.count * DYN_STRIDE + this.keys.count * 64 + this.tmpl.count * 16;
  }

  stats() {
    return {
      staticObjects: this.counts.staticObjects,
      dynamicObjects: this.counts.dynamicObjects,
      staticVertices: this.sv.count,
      // (what is drawn: an instanced mesh counts once for every copy)
      staticTriangles: this.sIdx.reduce((n, s) => n + s.count, 0) / 3 + this.counts.instancedTriangles,
      instances: this.counts.instances,
      dynamicVertices: this.dv.count,
      tetrahedra: this.counts.tetrahedra,
    };
  }

  // Packs everything into the buffers the renderer uploads.
  finalize() {
    // Chunks are numbered in order of starting time (within each layer), so
    // that the chunks a slice touches, which lie close together in time, are
    // also neighbours and can be drawn with few draw calls.  Detail that is
    // drawn only from near by comes after everything else, so that it is never
    // swept up in a draw call that bridges the gap between two other chunks.
    // Each chunk is given a run of numbers for its tetrahedra, starting at a
    // multiple of BLOCK; the vertex shader, which is handed one such number,
    // finds the chunk in a table with an entry per BLOCK numbers (`blocks`),
    // and in the chunk's own entry (`runs`) what it needs to work out the rest.
    const all = [];
    let tetAt = 0;
    for (let layer = 0; layer < LAYERS; layer++) {
      for (const c of this.chunks[layer].slice().sort((a, b) => (a.within < BIG) - (b.within < BIG) || a.t0 - b.t0)) {
        all.push({ ...c, first: tetAt, layer });
        tetAt += Math.ceil(c.count / BLOCK) * BLOCK;
      }
    }
    const runs = new Uint32Array(Math.max(1, all.length) * 8);
    const blocks = new Uint32Array(Math.max(1, tetAt / BLOCK));
    all.forEach((c, i) => {
      runs.set([c.first, c.count, c.tmpl, c.per, c.vert, c.nv, c.key, c.rigid ? 1 : 0], i * 8);
      blocks.fill(i, c.first / BLOCK, c.first / BLOCK + Math.ceil(c.count / BLOCK));
    });
    // chunk table: [first, count] and [t0, t1, centre xyz, half-size xyz, radius]
    const chunkRange = new Uint32Array(all.length * 2);
    const chunkBox = new Float64Array(all.length * 9);
    const chunkLayer = new Uint8Array(all.length);
    const chunkNear = new Float32Array(all.length); // how near the viewer has to be for it to be drawn
    // For chunks of such detail, where the thing is over the chunk's stretch of
    // time: the middle of its bounds at the start and at the end, and a radius
    // that takes in the thing itself and any bend of its path in between.  (A
    // chunk's bounds take in the whole stretch, which for something on a long
    // straight run says little about how near it is at any one moment.)
    const chunkPath = new Float32Array(all.length * 7);
    all.forEach((c, i) => {
      chunkNear[i] = c.within < BIG ? c.within : Infinity;
      if (c.within < BIG) {
        const mid = (b) => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
        const a = mid(c.path[0]), z = mid(c.path[c.path.length - 1]), d = [z[0] - a[0], z[1] - a[1], z[2] - a[2]];
        const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        let r = 0;
        for (const b of c.path) {
          const m = mid(b), u = len2 > 0 ? Math.min(1, Math.max(0, ((m[0] - a[0]) * d[0] + (m[1] - a[1]) * d[1] + (m[2] - a[2]) * d[2]) / len2)) : 0;
          const off = Math.hypot(m[0] - a[0] - d[0] * u, m[1] - a[1] - d[1] * u, m[2] - a[2] - d[2] * u);
          r = Math.max(r, off + Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2);
        }
        chunkPath.set([a[0], a[1], a[2], z[0], z[1], z[2], r], i * 7);
      }
      chunkRange[i * 2] = c.first; chunkRange[i * 2 + 1] = c.count;
      const b = c.box, h = [(b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2];
      chunkBox.set([c.t0, c.t1, (b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2, h[0], h[1], h[2], Math.hypot(h[0], h[1], h[2])], i * 9);
      chunkLayer[i] = c.layer;
    });
    // Static index buffer, per layer: first everything that is always drawn,
    // then the pieces with a time window that are worth testing one by one
    // against the slice (the rest are simply discarded per pixel when they
    // are outside their window).
    // See-through pieces are all listed one by one, so that they can be drawn
    // from the furthest to the nearest.  The meshes of instances() come last.
    const staticIndices = new Uint32Array(Math.max(1, this.sIdx.reduce((n, s) => n + s.count, 0) + this.iIdx.count));
    const staticAlways = [];
    const cells = []; // { layer, first, count, box } of the always-drawn triangles, cell by cell
    const timed = [];
    const pos = this.sv.f32, stride = STATIC_STRIDE >> 2;
    let at = 0;
    for (let layer = 0; layer < LAYERS; layer++) {
      const src = this.sIdx[layer].u32;
      const calls = this.sCalls.filter((c) => c.layer === layer);
      const worth = (c) => layer === 2 || c.within < BIG || ((c.from > -BIG || c.to < BIG) && (layer === 1 || c.count >= 3 * WINDOW_CULL_TRIANGLES));
      const start = at;
      for (const c of calls) {
        if (worth(c)) continue;
        staticIndices.set(src.subarray(c.first, c.first + c.count), at);
        at += c.count;
      }
      staticAlways.push({ first: start, count: at - start });
      // ... which are then put in the order of the cells they fall in (by their centres)
      const n = (at - start) / 3;
      if (n) {
        const tri = staticIndices.slice(start, at);
        const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const a = tri[i * 3] * stride, b = tri[i * 3 + 1] * stride, c = tri[i * 3 + 2] * stride;
          cx[i] = (pos[a] + pos[b] + pos[c]) / 3; cy[i] = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3; cz[i] = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
        }
        const { order, ends } = spatialGroups(cx, cy, cz, Math.min(4 * CELL_TRIANGLES, Math.max(CELL_TRIANGLES, Math.ceil(n / 256))));
        let lo = 0;
        for (const hi of ends) {
          const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          for (let i = lo; i < hi; i++) {
            for (let k = 0; k < 3; k++) {
              const v = tri[order[i] * 3 + k];
              staticIndices[start + i * 3 + k] = v;
              for (let j = 0; j < 3; j++) { const x = pos[v * stride + j]; if (x < box[j]) box[j] = x; if (x > box[j + 3]) box[j + 3] = x; }
            }
          }
          cells.push({ layer, first: start + lo * 3, count: (hi - lo) * 3, box });
          lo = hi;
        }
      }
      for (const c of calls) {
        if (!worth(c)) continue;
        staticIndices.set(src.subarray(c.first, c.first + c.count), at);
        timed.push({ ...c, first: at });
        at += c.count;
      }
    }
    // cell table: [first, count] and [centre xyz, half-size xyz]
    const cellRange = new Uint32Array(cells.length * 2);
    const cellBox = new Float64Array(cells.length * 6);
    const cellLayer = new Uint8Array(cells.length);
    cells.forEach((c, i) => {
      cellRange[i * 2] = c.first; cellRange[i * 2 + 1] = c.count;
      const b = c.box;
      cellBox.set([(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2, (b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2], i * 6);
      cellLayer[i] = c.layer;
    });
    const timedRange = new Uint32Array(timed.length * 2);
    const timedBox = new Float64Array(timed.length * 9);
    const timedLayer = new Uint8Array(timed.length);
    const timedNear = new Float32Array(timed.length);
    timed.forEach((c, i) => {
      timedNear[i] = c.within < BIG ? c.within : Infinity;
      timedRange[i * 2] = c.first; timedRange[i * 2 + 1] = c.count;
      const b = c.box;
      timedBox.set([c.from, c.to, c.period, (b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2, (b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2], i * 9);
      timedLayer[i] = c.layer;
    });
    staticIndices.set(this.iIdx.u32.subarray(0, this.iIdx.count), at);
    // (each with its bounds as centre and half-size, like the windowed static pieces)
    const instanced = this.iCalls.map((c) => {
      const b = c.box;
      return { ...c, first: c.first + at, box: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2, (b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2] };
    });
    // the corners of every solid triangle, for collisions (see collide.js)
    const solidTris = new Float32Array(this.solidCalls.reduce((sum, c) => sum + c.count, 0) * 3 + this.solidExtra.reduce((sum, a) => sum + a.length, 0));
    let st = 0;
    for (const c of this.solidCalls) {
      for (let i = c.first; i < c.first + c.count; i++) {
        const o32 = this.sIdx[c.layer].u32[i] * (STATIC_STRIDE >> 2);
        solidTris[st++] = this.sv.f32[o32]; solidTris[st++] = this.sv.f32[o32 + 1]; solidTris[st++] = this.sv.f32[o32 + 2];
      }
    }
    for (const a of this.solidExtra) { solidTris.set(a, st); st += a.length; }
    const stats = this.stats();
    stats.work = this._work();
    // what the graphics card is given to hold
    stats.bytes = this.sv.count * STATIC_STRIDE + staticIndices.byteLength + this.inst.count * INSTANCE_STRIDE
      + this.dv.count * DYN_STRIDE + this.keys.count * 64 + this.tmpl.count * 16 + runs.byteLength + blocks.byteLength
      + this.textures.reduce((sum, t) => sum + t.width * t.height * t.channels * (t.float ? 2 : 1), 0);
    return {
      solidTris,
      staticVerts: this.sv.u8.slice(0, Math.max(1, this.sv.count) * STATIC_STRIDE),
      staticIndices,
      staticAlways,
      staticCells: { count: cells.length, range: cellRange, box: cellBox, layer: cellLayer },
      instances: this.inst.u8.slice(0, Math.max(1, this.inst.count) * INSTANCE_STRIDE),
      instanced,
      textures: this.textures,
      staticTimed: { count: timed.length, range: timedRange, box: timedBox, layer: timedLayer, near: timedNear },
      dynVerts: this.dv.u8.slice(0, Math.max(1, this.dv.count) * DYN_STRIDE),
      dynKeys: this.keys.f32.slice(0, Math.max(1, this.keys.count) * 16),
      dynTmpl: this.tmpl.u32.slice(0, Math.max(1, this.tmpl.count) * 4),
      dynRuns: runs,
      dynBlocks: blocks,
      chunks: { count: all.length, range: chunkRange, box: chunkBox, layer: chunkLayer, near: chunkNear, path: chunkPath },
      stats,
    };
  }
}

function applyPaint(g, pt) {
  if (!pt) return g;
  if (pt.color !== undefined) g.color(pt.color);
  if (pt.emissive !== undefined) g.emissive(pt.emissive);
  return g;
}
