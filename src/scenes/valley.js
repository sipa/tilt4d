// Winter Valley: a high alpine valley on a winter afternoon running into
// night.  A lantern path leads through a hamlet to a frozen lake; a chairlift
// and an aerial tram climb the slopes, skiers come down, skaters circle the
// ice and smoke rises from the chimneys.  The light is the clock: the low sun
// sweeps the shadow of the western ridge across the valley and leaves the
// peaks glowing, so when you move, the mountains ahead are lit by an earlier
// sun than the ones behind you.
//
// This is the detailed scene, written for desktop graphics cards: about a
// million static triangles, smooth and bevelled shapes, and materials with
// several scales of procedural detail.

import { Geo } from '../geom.js';
import { m4, v3 } from '../math.js';
import { rng, adaptiveTimes, Path } from '../util.js';

// ---------------------------------------------------------------------------
// constants shared by the geometry and the shader

const P = 60;                 // every moving thing repeats after this many seconds
const DAY = 480;              // seconds per day (with the hours slowed round dusk and dawn)
const HOUR0 = 16.72;          // time of day at t = 0
const WARP = 0.88;            // how much the hours slow down round 6 and 18 o'clock
const LAT = 46 * Math.PI / 180, DEC_SUN = -6 * Math.PI / 180, DEC_MOON = 12 * Math.PI / 180;
const ROT = 32 * Math.PI / 180;   // the valley axis (+y) points this far east of north
const C = 12;

const TAU = Math.PI * 2;
const sstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// hour of the day as a function of the day phase: the hours pass slowly
// round 17:36 (sunset in the valley) and 05:36 (dawn), quickly at noon and midnight
const PHS = -0.4 / 24;
const hourOfPhase = (ph) => 24 * ph + (24 * WARP / (4 * Math.PI)) * Math.sin(4 * Math.PI * (ph - PHS));
// the phase at t = 0
const PH0 = (() => {
  let lo = -0.2, hi = 1.2;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (hourOfPhase(m) < HOUR0) lo = m; else hi = m; }
  return (lo + hi) / 2;
})();

// material ids
const MAT = {
  TERRAIN: 1, BARK: 2, NEEDLES: 3, LOGS: 4, STONE: 5, SNOWSLAB: 6, WOOD: 7, GLASS: 8,
  LANTERN: 9, METAL: 10, PATH: 11, CLOCK: 12, COPPER: 13, PLASTER: 14, SMOKE: 15,
  BOARD: 17, CABIN: 18, CLOTH: 19, SHINGLE: 21, BEACON: 22, SKIN: 23, SHUTTER: 24, WOODPILE: 25, CHAPELWIN: 26, BELFRY: 27, CABINWIN: 28,
};

// ---------------------------------------------------------------------------
// terrain (JS side).  The height is designed around two crest lines, one on
// each side of the valley; the shader uses the same crest lines to cast the
// ridges' shadows across the valley at any time and any distance.

const GRAD = (() => {
  const g = new Float64Array(512);
  for (let i = 0; i < 256; i++) { const a = i / 256 * TAU + 0.37; g[i * 2] = Math.cos(a); g[i * 2 + 1] = Math.sin(a); }
  return g;
})();
function ih(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed + 0x3c6ef372, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) & 255;
}
// gradient noise, roughly -1..1
function gnoise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = ih(ix, iy, seed) * 2, b = ih(ix + 1, iy, seed) * 2, c = ih(ix, iy + 1, seed) * 2, d = ih(ix + 1, iy + 1, seed) * 2;
  const n00 = GRAD[a] * fx + GRAD[a + 1] * fy;
  const n10 = GRAD[b] * (fx - 1) + GRAD[b + 1] * fy;
  const n01 = GRAD[c] * fx + GRAD[c + 1] * (fy - 1);
  const n11 = GRAD[d] * (fx - 1) + GRAD[d + 1] * (fy - 1);
  return 1.6 * (n00 + (n10 - n00) * ux + (n01 - n00) * uy + (n00 - n10 - n01 + n11) * ux * uy);
}
function fbm(x, y, oct, seed = 0) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * gnoise(x, y, seed + i * 7); n += a;
    const nx = x * 1.62 - y * 1.18, ny = x * 1.18 + y * 1.62;
    x = nx + 3.1; y = ny - 1.7; a *= 0.5;
  }
  return s / n;
}
// ridged noise 0..1 (sharp crests)
function ridged(x, y, oct, seed = 0) {
  let s = 0, a = 0.5, n = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let r = 1 - Math.abs(gnoise(x, y, seed + i * 13));
    r *= r;
    s += a * r * w; n += a;
    w = Math.min(1, r * 1.6);
    const nx = x * 1.7 - y * 1.05, ny = x * 1.05 + y * 1.7;
    x = nx + 1.3; y = ny + 2.9; a *= 0.5;
  }
  return s / n;
}

// The crest lines [x, z] of the western and eastern ridges at a given y.
// (The same formulas appear in the shader: keep them in step.)
function crestW(y) {
  const s = sstep(400, -1200, y), nth = sstep(1200, 2600, y);
  return [
    -860 - 620 * s + 40 * Math.sin(y / 310 + 0.7) + 22 * Math.sin(y / 133 + 2.0),
    560 - 470 * s + 300 * nth + 70 * Math.sin(y / 420 + 1.3) + 36 * Math.sin(y / 161 + 0.2) + 16 * Math.sin(y / 71 + 1.1),
  ];
}
function crestE(y) {
  const s = sstep(300, -2400, y), nth = sstep(1200, 2600, y);
  return [
    900 + 420 * s + 48 * Math.sin(y / 350 + 2.2) + 20 * Math.sin(y / 120 + 0.5),
    590 - 330 * s + 280 * nth + 80 * Math.sin(y / 380 + 2.6) + 38 * Math.sin(y / 170 + 1.0) + 15 * Math.sin(y / 63 + 2.4),
  ];
}
const floorBase = (y) => 0.016 * y + 420 * sstep(1250, 2600, y);
const valleyCx = (y) => 25 * Math.sin(y / 600 + 0.5);
const valleyHw = (y) => 185 + 170 * sstep(0, -2600, y) - 70 * sstep(1100, 2000, y);

// the frozen lake: an ellipse
const LAKE = { x: -40, y: 470, rx: 118, ry: 72, a: 0.22 };
const lakeR = (x, y) => {
  const dx = x - LAKE.x, dy = y - LAKE.y, c = Math.cos(LAKE.a), s = Math.sin(LAKE.a);
  return Math.hypot((dx * c + dy * s) / LAKE.rx, (-dx * s + dy * c) / LAKE.ry);
};
const ZLAKE = floorBase(LAKE.y) - 0.8;
// the swept rink, towards the path along the east shore
const RINK = { x: 8, y: 468, rx: 50, ry: 34 };

const HORN = [130, 2700];

function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

function heightRaw(x, y) {
  const f = floorBase(y);
  const cx = valleyCx(y), hw = valleyHw(y);
  // floor: gentle hummocks, calmer round the hamlet
  const dv = Math.hypot(x - 0, (y - 200) * 0.7);
  const hum = (0.6 + 1.3 * sstep(110, 300, dv)) * fbm(x / 90, y / 45, 3, 11) + 0.35 * fbm(x / 30, y / 14, 2, 5) * sstep(60, 200, dv);
  const west = x < cx;
  const [xc, zc] = west ? crestW(y) : crestE(y);
  const edge = west ? cx - hw : cx + hw;
  const span = Math.abs(edge - xc);
  const u = (west ? edge - x : x - edge) / span;
  let z;
  if (u <= 0) {
    z = f + hum;
  } else if (u <= 1) {
    const s = Math.pow(u, 1.9);
    const rise = zc - f;
    z = f + rise * s;
    // spurs and gullies running down the slope (stretched along the fall line),
    // rocky towers below the crest, and broken ground on the lower slopes
    const g = ridged(y / 110 + (west ? 0 : 40), x / 380 + y / 2000, 5, west ? 3 : 4);
    const g2 = ridged(y / 38 + 5, x / 120, 3, west ? 23 : 24);
    z += (g - 0.40) * 0.42 * rise * u * Math.pow(1 - u, 1.1);
    z += (g2 - 0.45) * 0.10 * rise * u * u * (1 - u) * 3;
    z += fbm(x / 70, y / 55, 3, 21) * 9 * u * (1 - u) * 4;
    z += hum * Math.pow(1 - u, 4);
  } else {
    // behind the crest: falling away to a shoulder, then further ranges
    const back = sstep(1, 2.2, u);
    z = zc - (zc - (0.55 * zc + 120)) * back;
    z += 520 * Math.pow(ridged(x / 1100 + 7, y / 1100, 4, 9), 1.6) * sstep(1.4, 3.0, u);
    z += fbm(x / 60, y / 60, 3, 31) * 25 * Math.min(1, u - 1);
  }
  // the horn at the head of the valley
  {
    const dx = x - HORN[0], dy = y - HORN[1];
    const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    const R = 1700 * (1 + 0.30 * Math.cos(3 * a + 0.9) + 0.08 * Math.cos(5 * a + 0.3) + 0.05 * Math.sin(7 * a));
    const k = Math.max(0, 1 - r / R);
    if (k > 0) {
      let zh = 1500 * Math.pow(k, 1.55) + 160 * Math.sqrt(k) * (1 - k) * (ridged(x / 260 + 2, y / 260, 5, 17) - 0.45);
      zh += 25 * k * fbm(x / 60, y / 60, 3, 41);
      z = smax(z, zh, 90);
    }
  }
  // distant mountains to the south, beyond the mouth of the valley
  if (y < -2500) {
    const k = sstep(-2500, -5200, y);
    z = smax(z, -60 + 900 * k * Math.pow(ridged(x / 900 + 3, y / 900, 4, 51), 1.5), 120);
  }
  // the lake: level ice, a low shore that blends into the valley floor, and,
  // where that floor would lie below the ice (downhill, to the south), a low
  // dam that falls away gently
  const lr = lakeR(x, y);
  if (lr < 2.2) {
    if (lr < 1) z = ZLAKE;
    else if (lr < 1.45) z = Math.max(ZLAKE + 0.05, mix(ZLAKE + 0.15, z, sstep(1.0, 1.45, lr)));
    else z = mix(Math.max(ZLAKE + 0.05, z), z, sstep(1.45, 2.2, lr));
  }
  return z;
}

// Terrain levels: nested rectangles, each a regular grid with a hole where the
// next finer one lies.  Bounds are multiples of the next coarser cell size.
const LEVELS = [
  { s: 2.5, x0: -110, x1: 120, y0: -150, y1: 420 },
  { s: 5, x0: -300, x1: 300, y0: -320, y1: 900 },
  { s: 10, x0: -1040, x1: 1040, y0: -760, y1: 1680 },
  { s: 20, x0: -1900, x1: 1900, y0: -1700, y1: 3400 },
  { s: 100, x0: -7000, x1: 7000, y0: -7000, y1: 9000 },
];

let GRIDS = null;
function buildGrids() {
  if (GRIDS) return GRIDS;
  GRIDS = LEVELS.map((L) => {
    const nx = Math.round((L.x1 - L.x0) / L.s), ny = Math.round((L.y1 - L.y0) / L.s);
    return { ...L, nx, ny, h: new Float32Array((nx + 1) * (ny + 1)), done: new Uint8Array((nx + 1) * (ny + 1)) };
  });
  // sample everything that is not deep inside the next finer level
  for (let k = GRIDS.length - 1; k >= 0; k--) {
    const g = GRIDS[k], fine = GRIDS[k - 1];
    for (let j = 0; j <= g.ny; j++) {
      const y = g.y0 + j * g.s;
      for (let i = 0; i <= g.nx; i++) {
        const x = g.x0 + i * g.s;
        if (fine && x > fine.x0 + g.s * 1.5 && x < fine.x1 - g.s * 1.5 && y > fine.y0 + g.s * 1.5 && y < fine.y1 - g.s * 1.5) continue;
        g.h[j * (g.nx + 1) + i] = heightRaw(x, y);
        g.done[j * (g.nx + 1) + i] = 1;
      }
    }
  }
  // snap the border of each finer level onto the straight edges of the coarser one
  for (let k = 0; k < GRIDS.length - 1; k++) {
    const g = GRIDS[k], c = GRIDS[k + 1], r = Math.round(c.s / g.s);
    const at = (i, j) => j * (g.nx + 1) + i;
    const snapLine = (count, idx) => {
      for (let q = 0; q < count; q += r) {
        const a = g.h[idx(q)], b = g.h[idx(Math.min(count, q + r))];
        for (let m = 1; m < r && q + m <= count; m++) g.h[idx(q + m)] = a + (b - a) * m / r;
      }
    };
    snapLine(g.nx, (i) => at(i, 0));
    snapLine(g.nx, (i) => at(i, g.ny));
    snapLine(g.ny, (j) => at(0, j));
    snapLine(g.ny, (j) => at(g.nx, j));
  }
  return GRIDS;
}

// The ground: the terrain mesh itself (each grid cell is split along the same
// diagonal as the mesh), from the finest level that covers the point.
function ground(x, y) {
  const grids = GRIDS || buildGrids();
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k];
    if (x < g.x0 || x > g.x1 || y < g.y0 || y > g.y1) continue;
    const fx = (x - g.x0) / g.s, fy = (y - g.y0) / g.s;
    const i = Math.min(g.nx - 1, Math.floor(fx)), j = Math.min(g.ny - 1, Math.floor(fy));
    const u = fx - i, v = fy - j, w = g.nx + 1, o = j * w + i;
    const h00 = g.h[o], h10 = g.h[o + 1], h01 = g.h[o + w], h11 = g.h[o + w + 1];
    return u > v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
  }
  return heightRaw(x, y);
}

// a terrain normal from the ground itself
function groundNormal(x, y, e = 1.0) {
  const dx = (ground(x + e, y) - ground(x - e, y)) / (2 * e), dy = (ground(x, y + e) - ground(x, y - e)) / (2 * e);
  return v3.norm([-dx, -dy, 1]);
}

// Data carried in the terrain's vertex colour (each value pre-encoded so
// that the shader receives it linear): r = ambient occlusion,
// g = forest floor, b = unused.
const enc = (v) => Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2);

// Occlusion stamped round things standing on the ground (filled in by the
// builders before the terrain is meshed; emptied at the start of each build,
// since the app builds the scene again every time it is entered).
const AO_STAMPS = [];
function stampAO(x, y, r, strength) { AO_STAMPS.push([x, y, r, strength]); }

// How exposed the ground is (0..1): steep over tens of metres, and convex
// (ridges and spurs are blown free of snow, gullies fill up).
function rockiness(x, y, z) {
  const e = 14;
  const zx0 = ground(x - e, y), zx1 = ground(x + e, y), zy0 = ground(x, y - e), zy1 = ground(x, y + e);
  const gx = (zx1 - zx0) / (2 * e), gy = (zy1 - zy0) / (2 * e);
  const steep = 1 - 1 / Math.sqrt(1 + gx * gx + gy * gy);
  const convex = z - (zx0 + zx1 + zy0 + zy1) / 4;
  const above = z - floorBase(y);
  return Math.max(0, Math.min(1, 0.62 * sstep(0.22, 0.48, steep) + 0.24 * Math.max(-1, Math.min(1, convex / 5)) * sstep(0.12, 0.3, steep) + 0.12 * sstep(250, 700, above)));
}

function terrainMeshes() {
  const grids = buildGrids();
  // occlusion stamps, bucketed
  const B = 64, buckets = new Map();
  for (const st of AO_STAMPS) {
    const r = st[2] * 2.2;
    for (let bx = Math.floor((st[0] - r) / B); bx <= Math.floor((st[0] + r) / B); bx++) {
      for (let by = Math.floor((st[1] - r) / B); by <= Math.floor((st[1] + r) / B); by++) {
        const k = bx * 100003 + by;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(st);
      }
    }
  }
  const stampAt = (x, y) => {
    const list = buckets.get(Math.floor(x / B) * 100003 + Math.floor(y / B));
    let ao = 1;
    if (list) {
      for (const [sx, sy, r, k] of list) {
        const d = Math.hypot(x - sx, y - sy) / r;
        if (d < 2.2) ao *= 1 - k * Math.exp(-d * d * 1.4);
      }
    }
    return ao;
  };
  const out = [];
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k], fine = grids[k - 1];
    const w = g.nx + 1;
    const H = (i, j) => g.h[j * w + i];
    const geo = new Geo();
    const vid = new Int32Array(w * (g.ny + 1)).fill(-1);
    const inHole = (i, j) => fine && g.x0 + i * g.s >= fine.x0 && g.x0 + (i + 1) * g.s <= fine.x1 && g.y0 + j * g.s >= fine.y0 && g.y0 + (j + 1) * g.s <= fine.y1;
    const vert = (i, j) => {
      const o = j * w + i;
      if (vid[o] >= 0) return vid[o];
      const x = g.x0 + i * g.s, y = g.y0 + j * g.s, z = g.h[o];
      // normal from the grid (one-sided at the border)
      const hx0 = i > 0 && g.done[o - 1] ? H(i - 1, j) : z, hx1 = i < g.nx && g.done[o + 1] ? H(i + 1, j) : z;
      const hy0 = j > 0 && g.done[o - w] ? H(i, j - 1) : z, hy1 = j < g.ny && g.done[o + w] ? H(i, j + 1) : z;
      const ddx = (i > 0 && i < g.nx ? 2 : 1) * g.s, ddy = (j > 0 && j < g.ny ? 2 : 1) * g.s;
      const n = v3.norm([-(hx1 - hx0) / ddx, -(hy1 - hy0) / ddy, 1]);
      // occlusion: hollows are darker, and so is the ground round things
      const ring = (hx0 + hx1 + hy0 + hy1) * 0.25;
      const cav = Math.max(0, Math.min(1, 1 - (ring - z) / (g.s * 2.5)));
      const ao = (0.72 + 0.28 * cav) * stampAt(x, y);
      const id = geo.vert(x, y, z, n[0], n[1], n[2], x * 0.01, y * 0.01);
      geo.c[id * 3] = enc(ao); geo.c[id * 3 + 1] = enc(groundCover(x, y)); geo.c[id * 3 + 2] = enc(rockiness(x, y, z));
      vid[o] = id;
      return id;
    };
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        if (inHole(i, j)) continue;
        const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
        // split along (i, j)-(i+1, j+1), as ground() assumes
        geo.tri(a, b, c); geo.tri(a, c, d);
      }
    }
    geo.mat(MAT.TERRAIN);
    out.push({ geo, solid: true });
    // a skirt hanging under the seam to the finer level (hides pixel cracks at T-junctions)
    if (fine) {
      const sk = new Geo();
      const r = Math.round(g.s / fine.s), fw = fine.nx + 1;
      const edges = [
        [fine.nx, (q) => [q, 0], [0, -1]], [fine.nx, (q) => [q, fine.ny], [0, 1]],
        [fine.ny, (q) => [0, q], [-1, 0]], [fine.ny, (q) => [fine.nx, q], [1, 0]],
      ];
      for (const [count, ij, nrm] of edges) {
        for (let q = 0; q < count; q++) {
          const [i0, j0] = ij(q), [i1, j1] = ij(q + 1);
          const p0 = [fine.x0 + i0 * fine.s, fine.y0 + j0 * fine.s, fine.h[j0 * fw + i0]];
          const p1 = [fine.x0 + i1 * fine.s, fine.y0 + j1 * fine.s, fine.h[j1 * fw + i1]];
          const drop = 0.4 + g.s * 0.05;
          const base = sk.vertexCount;
          for (const p of [p0, p1]) {
            sk.vert(p[0], p[1], p[2], 0, 0, 1);
            sk.vert(p[0], p[1], p[2] - drop, nrm[0], nrm[1], 0);
          }
          sk.quadIdx(base, base + 2, base + 3, base + 1);
          void r;
        }
      }
      sk.c.fill(enc(0.8));
      for (let q = 1; q < sk.c.length; q += 3) { sk.c[q] = enc(0.5); sk.c[q + 1] = 0; }
      out.push({ geo: sk.mat(MAT.TERRAIN).noShadow().doubleSided(), solid: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// layout of the hamlet

// the lantern path, from the spawn point to the lake shore and on to the tram
const PATH_PTS = [[0, -95], [2, -40], [7, 30], [-4, 105], [-12, 185], [-14, 262], [-2, 335], [40, 385], [86, 438], [96, 505], [74, 568], [24, 612], [-62, 640]];
const PATH = new Path(PATH_PTS, { smooth: 6 });
const PATH_HALF = 1.6;                 // half-width of the trodden path

// distance from a point to the path (coarse, for placement)
const PATH_SAMPLES = (() => {
  const out = [];
  for (let d = 0; d <= PATH.length; d += 4) out.push(PATH.at(d).p);
  return out;
})();
function pathDist(x, y) {
  let best = 1e9;
  for (const p of PATH_SAMPLES) {
    const d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// buildings: [x, y, facing (radians, the front faces this way), kind]
const CHAPEL = { x: -33, y: 176, rot: -Math.PI / 2 };   // front faces +x, towards the path
const CHALETS = [
  [-19, -24, -1.5, 0], [22, 6, 1.6, 1], [-23, 46, -1.45, 2], [25, 78, 1.5, 0], [-31, 112, -1.62, 1],
  [19, 150, 1.72, 2], [22, 226, 1.6, 1], [-42, 238, -1.4, 0], [-36, 312, -1.2, 2],
  [56, 36, 2.3, 2], [-58, 80, -0.9, 0], [58, 186, 2.6, 0], [-70, 190, -1.1, 2],
];
const LODGE = { x: 70, y: 318, rot: 2.2 };
// keep-out discs for trees: [x, y, r]
const CLEAR = [];
for (const c of CHALETS) CLEAR.push([c[0], c[1], 14]);
CLEAR.push([CHAPEL.x, CHAPEL.y, 22], [LODGE.x, LODGE.y, 26]);
CLEAR.push([-100, 652, 22], [-600, 960, 22], [128, 372, 16], [610, 880, 16]);

// chairlift and aerial tram end points
const LIFT = { a: [128, 372], b: [610, 880] };
const TRAM = { a: [-100, 652], b: [-600, 960] };
function lineDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

// how much forest grows at a point (0..1): below the tree line, not too
// steep, broken into stands with avalanche tracks between them
function forestDensity(x, y) {
  const z = ground(x, y);
  const above = z - floorBase(y);
  if (above > 420 || y > 1900) return 0;
  const n = groundNormal(x, y, 6);
  const slope = 1 - n[2];
  let d = sstep(0.32, 0.22, slope) * sstep(420, 300, above);
  // stands and clearings
  d *= sstep(-0.15, 0.25, fbm(x / 160, y / 160, 3, 61) + 0.1);
  // avalanche tracks: strips running down the slope
  d *= sstep(0.2, 0.45, Math.abs(gnoise(y / 70, x / 900, 71)));
  // the hamlet, the lake, the lift lines and pistes are kept clear
  d *= sstep(1.15, 1.45, lakeR(x, y));
  d *= sstep(14, 30, lineDist(x, y, LIFT.a, LIFT.b)) * sstep(10, 24, lineDist(x, y, TRAM.a, TRAM.b));
  d *= sstep(35, 70, pisteDist(x, y));
  const village = Math.hypot(x * 1.2, (y - 200) * 0.75);
  d *= 0.15 + 0.85 * sstep(170, 240, village);
  return Math.max(0, Math.min(1, d));
}

// what covers the ground, for the terrain's vertex colour (g channel): 0.5
// is bare snow, forest runs down towards 0, a groomed piste up towards 1 (so
// that between the two the value passes through bare snow)
function groundCover(x, y) {
  const pd = pisteDist(x, y);
  if (pd < 22) return 0.5 + 0.5 * sstep(22, 12, pd);
  return 0.5 - 0.5 * forestDensity(x, y);
}

// pistes coming down the eastern slope from the top of the chairlift
const PISTES = [
  new Path([[600, 860], [560, 760], [470, 690], [430, 590], [330, 520], [240, 440], [150, 395]], { smooth: 8 }),
  new Path([[640, 850], [700, 720], [640, 600], [560, 470], [450, 360], [300, 300], [170, 360]], { smooth: 8 }),
];
const PISTE_SAMPLES = PISTES.map((pp) => {
  const out = [];
  for (let d = 0; d <= pp.length; d += 8) out.push(pp.at(d).p);
  return out;
});
function pisteDist(x, y) {
  let best = 1e9;
  for (const list of PISTE_SAMPLES) {
    for (const p of list) {
      const d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// distant spruce trees (lod 2 and 3; near ones are spruceNear): unit height,
// tiers of branches that droop and are cut into lobes.  Vertex colour carries
// data for the shader: r = occlusion, g = tint, b = how much snow it holds.

function spruce(seed, lod) {
  const rand = rng(seed);
  const cfg = lod === 2 ? { tiers: 4, seg: 6 } : { tiers: 3, seg: 5 };
  const g = new Geo();
  const tint = rand(), snowK = 0.35 + 0.65 * rand();
  const slim = 0.27 + 0.07 * rand();
  // branch tiers
  const prof = lod === 2 ? [[0.04, 0, 0.7, 1], [1.0, -1.0, 1.0, 1], [0.3, -0.62, 0.4, 0]]
    : [[0.0, 0, 0.7, 1], [1.0, -1.0, 1.0, 1], [0.0, -0.75, 0.4, 0]];
  const n = cfg.tiers, seg = cfg.seg;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const zt = 0.11 + 0.87 * Math.pow(f, 0.95) + (rand() - 0.5) * 0.02;
    const droop = (0.95 / (n - 1)) * (1.6 + 0.5 * (1 - f)) * (lod >= 2 ? 1.3 : 1);
    const R = slim * Math.pow(Math.max(0.02, 1 - (zt - droop * 0.6)), 0.92) * (0.9 + 0.2 * rand()) + 0.015;
    const lobes = 6 + ((i + seed) % 3), ph = rand() * TAU;
    const base = g.vertexCount;
    for (const [rf, dz, ao, top] of prof) {
      for (let k = 0; k <= seg; k++) {
        const a = (k % seg) / seg * TAU;
        const lobe = 0.70 + 0.30 * Math.pow(0.5 + 0.5 * Math.cos(lobes * (a - ph)), 0.6);
        const lf = rf > 0.6 ? lobe : rf > 0.3 ? 0.5 + 0.5 * lobe : 1;
        const jit = 1 + (rand() - 0.5) * 0.10 * rf;
        const r = R * rf * lf * jit;
        const tipDroop = rf > 0.6 ? (1 - lobe) * droop * 0.25 : 0;
        const id = g.vert(Math.cos(a) * r, Math.sin(a) * r, zt + dz * droop + tipDroop + (rand() - 0.5) * 0.006, Math.cos(a) * 0.3, Math.sin(a) * 0.3, top ? 1 : -1);
        g.c[id * 3] = enc(ao * (0.75 + 0.25 * f)); g.c[id * 3 + 1] = tint; g.c[id * 3 + 2] = snowK;
      }
    }
    for (let q = 0; q < prof.length - 1; q++) {
      for (let k = 0; k < seg; k++) {
        const a0 = base + q * (seg + 1) + k, b0 = base + (q + 1) * (seg + 1) + k;
        g.quadIdx(a0, b0, b0 + 1, a0 + 1);
      }
    }
  }
  g.computeNormals(true);
  g.mat(MAT.NEEDLES);
  // a plain trunk (the solid part) for the nearer of the two; the farthest
  // trees, hundreds of metres from the path, are left without one
  let trunk = null;
  if (lod === 2) {
    trunk = Geo.lathe([[0.03, -0.08], [0.02, 0.4], [0.008, 0.9]], 4).mat(MAT.BARK);
    trunk.colorBy((p) => [enc(0.55 + 0.45 * Math.min(1, p[2] * 3)), 0.5, 0]);
  }
  return { foliage: g, trunk };
}


// One branch of a near spruce: a drooping, tapering sheet along +x with a
// raised spine (snow settles on it), drawn from both sides.
function frond(rand, L, W, droop, segs, ao0, tint, snowK) {
  const g = new Geo();
  const curl = (rand() - 0.5) * 0.35;
  for (let k = 0; k <= segs; k++) {
    const s = k / segs;
    const x = 0.015 + L * s;
    const yc = curl * L * s * s;
    const zc = -droop * Math.pow(s, 1.6) + 0.10 * droop * Math.sin(Math.PI * s);
    const w = W * (0.30 + 0.70 * Math.sin(Math.PI * Math.min(1, 0.15 + s * 0.85))) * (1 - 0.55 * s * s * s);
    const ridge = w * 0.32;
    const ao = ao0 * (0.45 + 0.55 * Math.min(1, s * 1.4));
    for (const [dy, dz, u] of [[-w, -ridge, -1], [0, 0, 0], [w, -ridge, 1]]) {
      const id = g.vert(x, yc + dy, zc + dz, 0, 0, 1, u, 1 + s);
      g.c[id * 3] = enc(ao); g.c[id * 3 + 1] = tint; g.c[id * 3 + 2] = snowK;
    }
  }
  for (let k = 0; k < segs; k++) {
    const a = k * 3, b = a + 3;
    g.quadIdx(a, b, b + 1, a + 1);
    g.quadIdx(a + 1, b + 1, b + 2, a + 2);
  }
  g.computeNormals(true);
  return g;
}

// A near spruce (unit height) made of whorls of fronds round a dense core.
function spruceNear(seed, fine) {
  const rand = rng(seed);
  const g = new Geo();
  const tint = rand(), snowK = 0.35 + 0.65 * rand();
  const slim = 0.25 + 0.07 * rand();
  const whorls = fine ? 13 : 8, per = fine ? 7 : 5, segs = fine ? 4 : 2;
  let a0 = rand() * TAU;
  for (let i = 0; i < whorls; i++) {
    const f = i / (whorls - 1);
    const z = 0.07 + 0.86 * Math.pow(f, 0.9) + (rand() - 0.5) * 0.015;
    const env = slim * Math.pow(Math.max(0.03, 1 - z), 0.9) + 0.02;
    const n = per - (f > 0.8 ? 1 : 0);
    a0 += 2.39996;
    for (let j = 0; j < n; j++) {
      const L = env * (0.82 + 0.3 * rand());
      const W = L * (0.33 + 0.08 * rand());
      const droop = L * (0.30 + 0.35 * (1 - f) + 0.15 * rand());
      const fr = frond(rand, L, W, droop, segs, 0.55 + 0.45 * f, tint, snowK);
      const a = a0 + j * TAU / n + (rand() - 0.5) * 0.5;
      fr.transform(m4.mul(m4.translation(0, 0, z), m4.rotationZ(a), m4.rotationY(-0.12 + rand() * 0.18)));
      g.add(fr);
    }
  }
  // thin sheets with a feathered outline (see `cutout` in the shader)
  g.doubleSided().cutout();
  // dense dark foliage round the trunk, so the tree is not see-through
  const core = Geo.lathe([[0.04, 0.08], [slim * 0.30, 0.18], [slim * 0.22, 0.55], [slim * 0.09, 0.85], [0.004, 1.0]], fine ? 9 : 6);
  core.colorBy((p) => [enc(0.22 + 0.2 * p[2]), tint, snowK * 0.3]);
  for (let i = 0; i < core.vertexCount; i++) { core.uv[i * 2] = 0; core.uv[i * 2 + 1] = 0; }
  g.add(core);
  g.mat(MAT.NEEDLES);
  const trunk = Geo.lathe([[0.03, -0.08], [0.024, 0.08], [0.018, 0.45], [0.006, 0.97]], fine ? 8 : 5).mat(MAT.BARK);
  trunk.colorBy((p) => [enc(0.55 + 0.45 * Math.min(1, p[2] * 3)), 0.5, 0]);
  return { foliage: g, trunk };
}

// ---------------------------------------------------------------------------
// geometry helpers

// Box with rounded edges and corners (radius r, nb segments per quarter
// round), centred on the origin; nf subdivides the flat parts (for bending).
// uv: metres across each face.
function rbox(sx, sy, sz, r, nb = 2, nf = 1) {
  const h = [sx / 2, sy / 2, sz / 2];
  r = Math.max(1e-4, Math.min(r, h[0], h[1], h[2]));
  const g = new Geo();
  const nfs = Array.isArray(nf) ? nf : [nf, nf, nf];
  const list = (hh, ax) => {
    const ins = hh - r, c = [], nfa = nfs[ax];
    for (let k = nb; k >= 1; k--) c.push(-ins - r * Math.tan(k / nb * Math.PI / 4));
    if (ins > 1e-6) for (let k = 0; k <= nfa; k++) c.push(-ins + 2 * ins * k / nfa);
    else c.push(0);
    for (let k = 1; k <= nb; k++) c.push(ins + r * Math.tan(k / nb * Math.PI / 4));
    return c;
  };
  const faces = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 0, 2, 1], [1, 0, 2, -1], [2, 0, 1, 1], [2, 0, 1, -1]];
  const q = [0, 0, 0], inner = [0, 0, 0];
  for (const [an, au, av, sg] of faces) {
    const cu = list(h[au], au), cv = list(h[av], av);
    const base = g.vertexCount;
    for (let j = 0; j < cv.length; j++) {
      for (let i = 0; i < cu.length; i++) {
        q[an] = sg * h[an]; q[au] = cu[i]; q[av] = cv[j];
        for (let k = 0; k < 3; k++) inner[k] = Math.max(-(h[k] - r), Math.min(h[k] - r, q[k]));
        let dx = q[0] - inner[0], dy = q[1] - inner[1], dz = q[2] - inner[2];
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l; dy /= l; dz /= l;
        g.vert(inner[0] + dx * r, inner[1] + dy * r, inner[2] + dz * r, dx, dy, dz, cu[i] + h[au], cv[j] + h[av]);
      }
    }
    for (let j = 0; j < cv.length - 1; j++) {
      for (let i = 0; i < cu.length - 1; i++) {
        const a = base + j * cu.length + i;
        g.quadIdx(a, a + 1, a + cu.length + 1, a + cu.length);
      }
    }
  }
  return g.orientByNormals();
}

// A cheaper box with small chamfered edges (44 triangles), shaded as if rounded.
function cbox(sx, sy, sz, r = 0.02) {
  const h = [sx / 2, sy / 2, sz / 2];
  r = Math.min(r, h[0] * 0.9, h[1] * 0.9, h[2] * 0.9);
  const g = new Geo();
  const ids = new Map();
  const V = (a, sa, su, sv) => {
    const key = a * 100 + (sa + 1) * 10 + (su + 1) * 3 + (sv + 1);
    if (ids.has(key)) return ids.get(key);
    const u = (a + 1) % 3, v = (a + 2) % 3, p = [0, 0, 0], n = [0, 0, 0];
    p[a] = sa * h[a]; p[u] = su * (h[u] - r); p[v] = sv * (h[v] - r); n[a] = sa;
    const id = g.vert(p[0], p[1], p[2], n[0], n[1], n[2], p[u] + h[u], p[v] + h[v]);
    ids.set(key, id);
    return id;
  };
  // the vertex of face (axis a, sign sa) nearest the box corner with signs s
  const at = (a, s) => V(a, s[a], s[(a + 1) % 3], s[(a + 2) % 3]);
  for (let a = 0; a < 3; a++) {
    for (const sa of [-1, 1]) g.quadIdx(V(a, sa, -1, -1), V(a, sa, 1, -1), V(a, sa, 1, 1), V(a, sa, -1, 1));
  }
  // edges: along axis e, between the faces of the other two axes
  for (let e = 0; e < 3; e++) {
    const a = (e + 1) % 3, b2 = (e + 2) % 3;
    for (const sa of [-1, 1]) {
      for (const sb of [-1, 1]) {
        const s0 = [0, 0, 0], s1 = [0, 0, 0];
        s0[a] = sa; s0[b2] = sb; s0[e] = -1;
        s1[a] = sa; s1[b2] = sb; s1[e] = 1;
        g.quadIdx(at(a, s0), at(a, s1), at(b2, s1), at(b2, s0));
      }
    }
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = [sx, sy, sz];
    g.tri(at(0, c), at(1, c), at(2, c));
  }
  // orient each triangle outwards (from the centre)
  const x = g.idx, P = g.p;
  for (let i = 0; i < x.length; i += 3) {
    const A = x[i] * 3, B = x[i + 1] * 3, Cc = x[i + 2] * 3;
    const e1 = [P[B] - P[A], P[B + 1] - P[A + 1], P[B + 2] - P[A + 2]], e2 = [P[Cc] - P[A], P[Cc + 1] - P[A + 1], P[Cc + 2] - P[A + 2]];
    const nn = v3.cross(e1, e2);
    const cx = P[A] + P[B] + P[Cc], cy = P[A + 1] + P[B + 1] + P[Cc + 1], cz = P[A + 2] + P[B + 2] + P[Cc + 2];
    if (nn[0] * cx + nn[1] * cy + nn[2] * cz < 0) { const t = x[i + 1]; x[i + 1] = x[i + 2]; x[i + 2] = t; }
  }
  return g;
}

// a rounded box from z = 0 up (handy for things standing on something)
const rboxUp = (sx, sy, sz, r, nb, nf) => rbox(sx, sy, sz, r, nb, nf).translate(0, 0, sz / 2);

// Sets data colour channels on every vertex (values pre-encoded for the shader).
function dataColor(g, fn) {
  for (let i = 0; i < g.vertexCount; i++) {
    const c = fn([g.p[i * 3], g.p[i * 3 + 1], g.p[i * 3 + 2]], [g.n[i * 3], g.n[i * 3 + 1], g.n[i * 3 + 2]]);
    g.c[i * 3] = enc(c[0]); g.c[i * 3 + 1] = c[1] ?? 0; g.c[i * 3 + 2] = c[2] ?? 0;
  }
  return g;
}
// a mesh with plain colour times an occlusion term from its height
function aoColor(g, hex, fn) {
  const c = typeof hex === 'string' ? [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255] : hex;
  for (let i = 0; i < g.vertexCount; i++) {
    const k = Math.pow(fn([g.p[i * 3], g.p[i * 3 + 1], g.p[i * 3 + 2]], [g.n[i * 3], g.n[i * 3 + 1], g.n[i * 3 + 2]]), 1 / 2.2);
    g.c[i * 3] = c[0] * k; g.c[i * 3 + 1] = c[1] * k; g.c[i * 3 + 2] = c[2] * k;
  }
  return g;
}
const snowData = (g, ao = 1) => dataColor(g, (p, n) => [ao * (0.8 + 0.2 * Math.max(0, n[2])), 0, 0]).mat(MAT.SNOWSLAB);

// A soft mound of snow lying on the ground (sx by sy, height h): a smooth
// bump that meets the ground tangentially.
function drift(sx, sy, h, seg = 18, rings = 6) {
  const g = new Geo();
  const prof = (r) => (r >= 1 ? 0 : Math.pow(1 - r * r, 2));
  for (let j = 0; j <= rings; j++) {
    const r = j / rings;
    for (let i = 0; i < seg; i++) {
      const a = i / seg * TAU, c = Math.cos(a), sn = Math.sin(a);
      const z = h * prof(r) - 0.12 * r;
      const dr = 0.01, dz = h * (prof(r + dr) - prof(Math.max(0, r - dr))) / (2 * dr);
      const n = v3.norm([-dz * c / (sx / 2), -dz * sn / (sy / 2), 1]);
      g.vert(c * r * sx / 2, sn * r * sy / 2, z, n[0], n[1], n[2], 0, 0);
      if (j === 0) break;
    }
  }
  for (let i = 0; i < seg; i++) g.tri(0, 1 + i, 1 + (i + 1) % seg);
  for (let j = 1; j < rings; j++) {
    const a = 1 + (j - 1) * seg, b2 = 1 + j * seg;
    for (let i = 0; i < seg; i++) g.quadIdx(a + i, b2 + i, b2 + (i + 1) % seg, a + (i + 1) % seg);
  }
  g.orientByNormals();
  return snowData(g, 1);
}

// ---------------------------------------------------------------------------
// a chalet: stone ground floor, log-built upper floor(s), a shallow roof
// with deep eaves under a thick blanket of snow.  Local frame: origin on the
// ground in the middle, the front gable (with the balcony) faces +y.

const SHUTTER_COLORS = [[0.20, 0.30, 0.17], [0.42, 0.12, 0.09], [0.14, 0.22, 0.32], [0.30, 0.22, 0.12]];

// Parts that every chalet has many of (windows, log ends, rafter tails,
// balcony boards) are each one mesh, drawn at every place it occurs
// (b.instances).  The chalets collect the placements here; addRepeats() adds
// them once all are built.
let REP = null;
const newRepeats = () => ({ windows: [[], []], shutters: [], logEnds: [], rafters: [], boards: [] });

// A window: frame, mullions, glass, sill with snow, and (on the big ones)
// a pair of shutters as a separate mesh, tinted per chalet.  Built facing +y,
// centred on the origin.  The glass gets its own number (s.inst.w), which
// decides when it lights up at dusk.
function windowGeo(wdt, hgt) {
  const w = new Geo();
  w.add(aoColor(cbox(wdt + 0.16, 0.10, 0.09, 0.03).translate(0, 0.03, hgt / 2 + 0.04), '#d8d0c0', () => 0.85));
  w.add(aoColor(cbox(wdt + 0.16, 0.10, 0.09, 0.03).translate(0, 0.03, -hgt / 2 - 0.04), '#d8d0c0', () => 0.85));
  w.add(aoColor(cbox(0.09, 0.10, hgt, 0.03).translate(-wdt / 2 - 0.035, 0.03, 0), '#d8d0c0', () => 0.85));
  w.add(aoColor(cbox(0.09, 0.10, hgt, 0.03).translate(wdt / 2 + 0.035, 0.03, 0), '#d8d0c0', () => 0.85));
  w.add(aoColor(Geo.box(0.05, 0.06, hgt).translate(0, 0.0, 0), '#d8d0c0', () => 0.8));
  w.add(aoColor(Geo.box(wdt, 0.06, 0.05).translate(0, 0.0, hgt * 0.18), '#d8d0c0', () => 0.8));
  w.mat(MAT.WOOD);
  const gl = Geo.quad([-wdt / 2, -0.03, -hgt / 2], [wdt / 2, -0.03, -hgt / 2], [wdt / 2, -0.03, hgt / 2], [-wdt / 2, -0.03, hgt / 2]);
  if (gl.n[1] < 0) gl.flip();
  w.add(dataColor(gl, () => [1, 0, 0]).mat(MAT.GLASS));
  w.add(aoColor(cbox(wdt + 0.4, 0.22, 0.07, 0.025).translate(0, 0.1, -hgt / 2 - 0.12), '#cfc6b4', () => 0.8).mat(MAT.WOOD));
  w.add(snowData(cbox(wdt + 0.3, 0.17, 0.10, 0.045).translate(0, 0.11, -hgt / 2 - 0.06)));
  return w;
}
function shutterGeo(wdt, hgt) {
  const w = new Geo();
  for (const sgn of [-1, 1]) {
    const sh = cbox(wdt * 0.55, 0.05, hgt + 0.08, 0.015).translate(sgn * (wdt / 2 + 0.1 + wdt * 0.275), 0.07, 0);
    w.add(aoColor(sh, [1, 1, 1], () => 0.9).mat(MAT.SHUTTER));
  }
  return w;
}

function addRepeats(b) {
  const logEnd = aoColor(Geo.cylinder(0.12, 0.34, 6).rotateY(Math.PI / 2), '#7a5232', () => 0.8);
  const rafter = aoColor(Geo.box(1.85, 0.12, 0.17), '#5a3a26', () => 0.6).mat(MAT.WOOD);
  const board = aoColor(Geo.box(0.13, 0.03, 0.80), '#7a5638', () => 0.85).mat(MAT.WOOD);
  b.instances(windowGeo(0.85, 1.05), REP.windows[0], { solid: false });
  b.instances(windowGeo(0.6, 0.6), REP.windows[1], { solid: false });
  b.instances(shutterGeo(0.85, 1.05), REP.shutters, { solid: false });
  b.instances(logEnd, REP.logEnds, { solid: false });
  b.instances(rafter, REP.rafters, { solid: false });
  b.instances(board, REP.boards, { solid: false });
}

function chalet(b, cx, cy, rot, kind, rand) {
  const W = [9.0, 10.6, 8.4, 13.5][kind], D = [11, 12.4, 9.8, 17][kind], floors = [1, 2, 1, 2][kind];
  const hs = 2.5, ht = 2.7 * floors, zTop = hs + ht;
  const pitch = 0.40 + rand() * 0.06, tp = Math.tan(pitch);
  const eave = 1.35, gover = 1.7;
  const rise = (W / 2) * tp;
  const tint = rand();
  const shutter = SHUTTER_COLORS[Math.floor(rand() * SHUTTER_COLORS.length)];
  const M = m4.mul(m4.translation(cx, cy, 0), m4.rotationZ(rot));
  // ground under the footprint
  let gmin = Infinity, gmax = -Infinity;
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
    const w = m4.point(M, [u * W / 2, v * D / 2, 0]);
    const gz = ground(w[0], w[1]);
    gmin = Math.min(gmin, gz); gmax = Math.max(gmax, gz);
  }
  const z0 = gmax - 0.15;
  const MZ = m4.mul(m4.translation(cx, cy, z0), m4.rotationZ(rot));
  const sink = z0 - gmin + 0.6;
  const solid = new Geo(), deco = new Geo();

  // stone ground floor
  const plinth = rbox(W, D, hs + sink, 0.10, 1).translate(0, 0, (hs - sink) / 2);
  solid.add(dataColor(plinth, (p) => [0.55 + 0.45 * sstep(-0.3, 1.4, p[2]), tint, 0]).mat(MAT.STONE));
  // log walls and gables
  const logs = cbox(W - 0.06, D - 0.06, ht, 0.06).translate(0, 0, hs + ht / 2);
  solid.add(dataColor(logs, (p) => [0.65 + 0.35 * sstep(zTop + 0.2, zTop - 1.5, p[2]), tint, 0]).mat(MAT.LOGS));
  for (const s of [1, -1]) {
    const gab = Geo.extrude([[-W / 2 + 0.03, 0], [W / 2 - 0.03, 0], [0, rise - 0.12]], 0.3).rotateX(Math.PI / 2).translate(0, s > 0 ? D / 2 - 0.03 + 0.3 : -D / 2 + 0.03, zTop);
    solid.add(dataColor(gab, (p) => [0.55 + 0.25 * sstep(zTop + rise, zTop, p[2]), tint, 0]).mat(MAT.LOGS));
  }
  // interleaved log ends at the corners (one mesh, see addRepeats)
  for (let k = 0, z = hs + 0.15; z < zTop - 0.1; k++, z += 0.3) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        if (k % 2 === 0) REP.logEnds.push(m4.mul(MZ, m4.translation(sx * W / 2 + (sx > 0 ? 0 : -0.34), sy * (D / 2 - 0.12), z)));
        else REP.logEnds.push(m4.mul(MZ, m4.translation(sx * (W / 2 - 0.12), sy * D / 2 + (sy > 0 ? 0.34 : 0), z), m4.rotationZ(Math.PI / 2)));
      }
    }
  }
  // roof: boards, purlins with carved ends, rafter tails
  const roofLen = D + 2 * gover;
  const slope = (W / 2 + eave) / Math.cos(pitch);
  const zEave = zTop - eave * tp;
  for (const s of [-1, 1]) {
    const roofM = m4.mul(m4.translation(s * (W / 2 + eave) / 2, 0, (zTop + rise + zEave) / 2 + 0.08), m4.rotationY(s * pitch));
    const board = cbox(slope + 0.05, roofLen, 0.16, 0.04).transform(roofM);
    solid.add(aoColor(board, '#4a3020', (p, n) => (n[2] < -0.3 ? 0.55 : 0.9)).mat(MAT.WOOD));
    // rafter tails under the eaves (one mesh, see addRepeats)
    for (let y = -roofLen / 2 + 0.4; y <= roofLen / 2 - 0.3; y += 0.85) {
      const len = eave + 0.5;
      REP.rafters.push(m4.mul(MZ, m4.translation(s * (W / 2 + eave - len / 2 + 0.05), y, zTop - (eave - len / 2 + 0.05) * tp - 0.1), m4.rotationY(s * pitch)));
    }
  }
  for (const [x, dz] of [[0, rise - 0.12], [-W / 4, rise / 2 - 0.12], [W / 4, rise / 2 - 0.12], [-W / 2 + 0.1, -0.1], [W / 2 - 0.1, -0.1]]) {
    const pur = cbox(0.2, roofLen + 0.2, 0.24, 0.04).translate(x, 0, zTop + dz - 0.05);
    deco.add(aoColor(pur, '#5e3d27', () => 0.7).mat(MAT.WOOD));
  }
  // snow on the roof: thick, rounded, sagging over the eaves
  for (const s of [-1, 1]) {
    const len = slope + 0.35, thick = 0.62;
    const sl = rbox(len, roofLen + 0.25, thick, thick * 0.48, 2, [8, 6, 1]);
    for (let i = 0; i < sl.vertexCount; i++) {
      const u = sl.p[i * 3] / len + 0.5;          // 0 at the ridge .. 1 at the eave
      const v = sl.p[i * 3 + 1] / (roofLen + 0.25) * 2;
      sl.p[i * 3 + 2] -= Math.pow(Math.max(0, u - 0.75) / 0.25, 2) * 0.22 + Math.pow(Math.abs(v), 6) * 0.10;
    }
    sl.computeNormals(true);
    const snowM = m4.mul(m4.translation(s * (W / 2 + eave + 0.18) / 2, 0, (zTop + rise + zEave) / 2 + 0.16 + thick / 2 - 0.05),
      s > 0 ? m4.identity() : m4.rotationZ(Math.PI), m4.rotationY(pitch));
    deco.add(snowData(sl.transform(snowM), 0.95));
  }
  // chimney
  {
    const cxl = W * 0.18, cyl = -D * 0.15;
    const zr = zTop + rise - Math.abs(cxl) * tp;
    const chH = rise + 1.6 - Math.abs(cxl) * tp + 0.5;
    const ch = rboxUp(0.75, 0.75, chH, 0.05, 1).translate(cxl, cyl, zr - 0.6);
    solid.add(dataColor(ch, () => [0.85, tint, 0]).mat(MAT.STONE));
    deco.add(aoColor(rboxUp(1.0, 1.0, 0.1, 0.03, 1).translate(cxl, cyl, zr + 1.5 + 0.05), '#3a3634', () => 0.8).mat(MAT.WOOD));
    deco.add(snowData(rbox(0.95, 0.95, 0.24, 0.11, 2).translate(cxl, cyl, zr + 1.5 + 0.2)));
    // the smoke leaves the top of the stack
    const top = m4.point(MZ, [cxl, cyl, zr - 0.6 + chH]);
    CHIMNEYS.push(top);
  }
  // windows with shutters and snowy sills (see windowGeo and addRepeats): big
  // ones with shutters in the chalet's colour, small ones without
  const windowAt = (u, z, nx, ny, small = false) => {
    // a frame placed on a wall whose outward normal is (nx, ny); u runs along the wall
    const M = m4.mul(MZ, m4.translation(u[0], u[1], z), m4.fromBasis([ny, -nx, 0], [nx, ny, 0], [0, 0, 1], [0, 0, 0]));
    // which moment at dusk the window lights up (four draws, as there were
    // when each corner of the pane had a number of its own: keeps the
    // chalets after this one as they were)
    const id = rand(); rand(); rand(); rand();
    REP.windows[small ? 1 : 0].push({ transform: M, data: id });
    if (!small) REP.shutters.push({ transform: M, tint: shutter });
  };
  const nside = Math.max(2, Math.floor(D / 3.4));
  for (let f2 = 0; f2 < floors; f2++) {
    const z = hs + 1.45 + f2 * 2.7;
    for (let i = 0; i < nside; i++) {
      const y = -D / 2 + D * (i + 0.5) / nside;
      windowAt([W / 2 + 0.02, y], z, 1, 0);
      windowAt([-W / 2 - 0.02, y], z, -1, 0);
    }
    for (const x of [-W * 0.3, W * 0.3]) windowAt([x, D / 2 + 0.02], z, 0, 1);
    windowAt([0, -D / 2 - 0.02], z, 0, -1);
  }
  windowAt([0, D / 2 + 0.3], zTop + rise * 0.42, 0, 1, true);
  for (const x of [-W * 0.28, W * 0.28]) windowAt([x, -D / 2 - 0.02], 1.4, 0, -1, true);
  // balcony on the front gable
  {
    const bw = W * 0.86, bd = 1.35, bz = hs + 0.05;
    const bal = new Geo();
    bal.add(aoColor(cbox(bw, bd, 0.12, 0.03).translate(0, D / 2 + bd / 2, bz), '#6b4a30', () => 0.8));
    bal.add(aoColor(cbox(bw, 0.12, 0.1, 0.03).translate(0, D / 2 + bd - 0.06, bz + 1.02), '#6b4a30', () => 0.9));
    bal.add(aoColor(cbox(bw, 0.10, 0.08, 0.02).translate(0, D / 2 + bd - 0.06, bz + 0.18), '#6b4a30', () => 0.8));
    for (const sx of [-1, 1]) {
      bal.add(aoColor(cbox(0.12, bd, 0.1, 0.03).translate(sx * bw / 2, D / 2 + bd / 2, bz + 1.02), '#6b4a30', () => 0.9));
      // brackets
      const br = cbox(0.12, 1.5, 0.14, 0.03).transform(m4.mul(m4.translation(sx * (bw / 2 - 0.4), D / 2 + 0.55, bz - 0.55), m4.rotationX(0.75)));
      bal.add(aoColor(br, '#5a3a26', () => 0.6));
    }
    // cut boards with a waisted shape (a row of narrow boards; one mesh, see addRepeats)
    for (let x = -bw / 2 + 0.12; x <= bw / 2 - 0.1; x += 0.19) {
      REP.boards.push(m4.mul(MZ, m4.translation(x, D / 2 + bd - 0.06, bz + 0.6)));
    }
    for (const sx of [-1, 1]) {
      for (let y = D / 2 + 0.15; y <= D / 2 + bd - 0.1; y += 0.19) {
        REP.boards.push(m4.mul(MZ, m4.translation(sx * bw / 2, y, bz + 0.6), m4.rotationZ(Math.PI / 2)));
      }
    }
    deco.add(bal.mat(MAT.WOOD));
    deco.add(snowData(rbox(bw - 0.05, 0.16, 0.12, 0.06, 2).translate(0, D / 2 + bd - 0.06, bz + 1.11)));
    deco.add(snowData(rbox(bw - 0.4, bd - 0.25, 0.14, 0.07, 2, 3).translate(0, D / 2 + bd / 2 + 0.05, bz + 0.1)));
  }
  // door with a lamp, on the downhill long side
  {
    const dg = new Geo();
    dg.add(aoColor(cbox(1.25, 0.16, 2.25, 0.03).translate(0, 0, 1.12), '#3e2a1c', () => 0.8));
    dg.add(aoColor(cbox(1.0, 0.1, 2.05, 0.02).translate(0, 0.05, 1.05), '#5b3b25', () => 0.75));
    dg.mat(MAT.WOOD);
    dg.add(aoColor(cbox(0.12, 0.12, 0.2, 0.02).translate(0.85, 0.1, 2.3), '#202020', () => 0.9).mat(MAT.METAL));
    dg.add(dataColor(Geo.sphere(0.07, 8, 6).translate(0.85, 0.12, 2.18), () => [1, 0.5, 0]).mat(MAT.LANTERN));
    dg.add(snowData(rbox(1.6, 0.9, 0.4, 0.2, 2).translate(0, 0.9, -0.15)));
    dg.transform(m4.fromBasis([0, 1, 0], [-1, 0, 0], [0, 0, 1], [-W / 2 - 0.05, D * 0.12, 0]));
    deco.add(dg);
  }
  // firewood under the eaves
  {
    const wp = cbox(0.7, D * 0.32, 1.35, 0.04).translate(W / 2 + 0.45, -D * 0.12, 0.675);
    deco.add(dataColor(wp, () => [0.6, 0, 0]).mat(MAT.WOODPILE));
    deco.add(snowData(rbox(0.78, D * 0.32 + 0.05, 0.16, 0.08, 2, [1, 2, 1]).translate(W / 2 + 0.45, -D * 0.12, 1.38)));
  }
  // drifts against the walls
  deco.add(drift(W + 2.6, 2.2, 0.9).translate(0, -D / 2 - 1.0, 0));
  deco.add(drift(2.0, D * 0.6, 0.7).translate(W / 2 + 1.6, D * 0.25, 0));
  deco.add(drift(2.2, D * 0.5, 1.0).translate(-W / 2 - 1.4, -D * 0.25, 0));

  b.static(solid, { transform: MZ });
  b.static(deco, { transform: MZ, solid: false });
  stampAO(cx, cy, Math.max(W, D) * 0.62, 0.45);
}
const CHIMNEYS = [];

// ---------------------------------------------------------------------------
// the chapel: plastered nave and apse, steep roof, and a clock tower with an
// onion dome.  Local frame as for the chalets (the front, with the tower,
// faces +y).  Its four dials show the time of day that the sky shows.

function roofWithSnow(solid, deco, W, D, zTop, pitch, eave, gover, thick, wallColor) {
  const tp = Math.tan(pitch), rise = (W / 2) * tp, zEave = zTop - eave * tp;
  const slope = (W / 2 + eave) / Math.cos(pitch), roofLen = D + 2 * gover;
  for (const s of [-1, 1]) {
    const roofM = m4.mul(m4.translation(s * (W / 2 + eave) / 2, 0, (zTop + rise + zEave) / 2 + 0.08), m4.rotationY(s * pitch));
    solid.add(aoColor(rbox(slope + 0.05, roofLen, 0.16, 0.04, 1).transform(roofM), '#3a2a22', (p, n) => (n[2] < -0.3 ? 0.5 : 0.9)).mat(MAT.SHINGLE));
    const len = slope + 0.3;
    const sl = rbox(len, roofLen + 0.2, thick, thick * 0.48, 2, [8, 6, 1]);
    for (let i = 0; i < sl.vertexCount; i++) {
      const u = sl.p[i * 3] / len + 0.5, v = sl.p[i * 3 + 1] / (roofLen + 0.2) * 2;
      sl.p[i * 3 + 2] -= Math.pow(Math.max(0, u - 0.75) / 0.25, 2) * thick * 0.35 + Math.pow(Math.abs(v), 6) * 0.08;
    }
    sl.computeNormals(true);
    const snowM = m4.mul(m4.translation(s * (W / 2 + eave + 0.15) / 2, 0, (zTop + rise + zEave) / 2 + 0.16 + thick / 2 - 0.04),
      s > 0 ? m4.identity() : m4.rotationZ(Math.PI), m4.rotationY(pitch));
    deco.add(snowData(sl.transform(snowM), 0.95));
  }
  // gables
  for (const s of [1, -1]) {
    const gab = Geo.extrude([[-W / 2 + 0.02, 0], [W / 2 - 0.02, 0], [0, rise - 0.1]], 0.25).rotateX(Math.PI / 2).translate(0, s > 0 ? D / 2 + 0.25 - 0.02 : -D / 2 + 0.02, zTop);
    solid.add(dataColor(gab, (p) => [0.8, wallColor, 0]).mat(MAT.PLASTER));
  }
  return rise;
}

function chapel(b) {
  const { x: cx, y: cy, rot } = CHAPEL;
  const W = 7.4, D = 12.5, hw = 5.4;
  const z0 = Math.max(...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const w = m4.point(m4.mul(m4.translation(cx, cy, 0), m4.rotationZ(rot)), [u * W / 2, v * (D / 2 + 4), 0]);
    return ground(w[0], w[1]);
  })) - 0.1;
  const MZ = m4.mul(m4.translation(cx, cy, z0), m4.rotationZ(rot));
  const solid = new Geo(), deco = new Geo();
  const sink = 1.5;
  // stone base and plastered walls
  solid.add(dataColor(rbox(W + 0.3, D + 0.3, 0.6 + sink, 0.06, 1).translate(0, 0, (0.6 - sink) / 2), () => [0.75, 0.3, 0]).mat(MAT.STONE));
  solid.add(dataColor(rbox(W, D, hw - 0.5, 0.10, 1).translate(0, 0, 0.5 + (hw - 0.5) / 2), (p) => [0.62 + 0.38 * sstep(0.4, 2.5, p[2]) * sstep(hw + 0.3, hw - 1.2, p[2]), 0.1, 0]).mat(MAT.PLASTER));
  // cornice
  deco.add(aoColor(cbox(W + 0.3, D + 0.3, 0.22, 0.05).translate(0, 0, hw - 0.05), '#d9d3c6', () => 0.85).mat(MAT.WOOD));
  roofWithSnow(solid, deco, W, D, hw, 0.74, 0.55, 0.45, 0.42, 0.1);
  // apse with a conical roof
  {
    const r = 2.9;
    const ap = Geo.cylinder(r, hw - 0.5, 20, { caps: false }).translate(0, -D / 2, 0.5);
    solid.add(dataColor(ap, (p) => [0.62 + 0.38 * sstep(0.4, 2.5, p[2]) * sstep(hw + 0.3, hw - 1.2, p[2]), 0.1, 0]).mat(MAT.PLASTER));
    solid.add(dataColor(Geo.cylinder(r + 0.15, 0.6 + sink, 20, { caps: false }).translate(0, -D / 2, -sink), () => [0.75, 0.3, 0]).mat(MAT.STONE));
    deco.add(aoColor(Geo.cone(r + 0.45, 3.0, 20).translate(0, -D / 2, hw), '#3a2a22', () => 0.7).mat(MAT.SHINGLE));
    deco.add(snowData(Geo.lathe([[r + 0.5, 0], [r + 0.35, 0.25], [1.4, 1.75], [0.3, 2.75], [0.02, 2.95]], 20).translate(0, -D / 2, hw + 0.12)));
  }
  // tall arched windows (two each side) and the door
  const archWin = (x, y, nx, w, h, z) => {
    const q = Geo.quad([-w / 2, 0, 0], [w / 2, 0, 0], [w / 2, 0, h], [-w / 2, 0, h]);
    if (q.n[1] < 0) q.flip();
    const M = m4.fromBasis([nx[1], -nx[0], 0], [nx[0], nx[1], 0], [0, 0, 1], [x, y, z]);
    // a panel with the arch cut out of its top (see archCover in the shader)
    return dataColor(q.transform(M), () => [1, 0.3, 0]).mat(MAT.CHAPELWIN).cutout();
  };
  for (const y of [-2.5, 2.2]) {
    deco.add(archWin(W / 2 + 0.03, y, [1, 0], 1.1, 2.6, 1.6));
    deco.add(archWin(-W / 2 - 0.03, y, [-1, 0], 1.1, 2.6, 1.6));
  }
  deco.add(archWin(0, -D / 2 - 2.92, [0, -1], 0.9, 2.2, 1.9));
  // the tower
  const T = 3.5, th = 15.0, ty = D / 2 + 1.2;
  solid.add(dataColor(rbox(T + 0.3, T + 0.3, 0.6 + sink, 0.06, 1).translate(0, ty, (0.6 - sink) / 2), () => [0.75, 0.3, 0]).mat(MAT.STONE));
  solid.add(dataColor(rbox(T, T, th - 0.5, 0.08, 1).translate(0, ty, 0.5 + (th - 0.5) / 2), (p) => [0.62 + 0.38 * sstep(0.4, 2.5, p[2]), 0.1, 0]).mat(MAT.PLASTER));
  for (const zc of [5.6, 9.2, th - 0.1]) deco.add(aoColor(cbox(T + 0.24, T + 0.24, 0.2, 0.05).translate(0, ty, zc), '#d9d3c6', () => 0.85).mat(MAT.WOOD));
  deco.add(snowData(rbox(T + 0.2, T + 0.2, 0.14, 0.07, 1).translate(0, ty, th + 0.03)));
  // belfry openings and dials on all four sides
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2, nx = Math.sin(a), ny = Math.cos(a);
    const px = nx * (T / 2 + 0.02), py = ty + ny * (T / 2 + 0.02);
    deco.add(archWin(px, py, [nx, ny], 1.3, 2.3, 11.4).mat(MAT.BELFRY));
    const dial = Geo.disc(0.95, 40).rotateX(-Math.PI / 2);
    const M = m4.fromBasis([ny, -nx, 0], [nx, ny, 0], [0, 0, 1], [nx * (T / 2 + 0.06), ty + ny * (T / 2 + 0.06), 7.6]);
    deco.add(dataColor(dial.transform(M), () => [1, 0, 0]).mat(MAT.CLOCK));
    const ring = Geo.torus(0.98, 0.07, 40, 6).rotateX(Math.PI / 2).transform(M);
    deco.add(aoColor(ring, '#b08a3a', () => 0.9).gloss(0.7).mat(MAT.METAL));
  }
  // onion dome on an eight-sided drum, lantern and cross
  {
    const zb = th + 0.1;
    deco.add(aoColor(Geo.cylinder(1.55, 0.9, 8).rotateZ(Math.PI / 8).translate(0, ty, zb), '#d9d3c6', () => 0.8).mat(MAT.PLASTER));
    const prof = [[1.62, 0], [1.75, 0.25], [1.95, 0.8], [1.85, 1.35], [1.45, 1.95], [0.85, 2.45], [0.42, 2.85], [0.28, 3.15], [0.34, 3.45], [0.52, 3.8], [0.5, 4.15], [0.3, 4.45], [0.12, 4.65], [0.05, 5.6]];
    const dome = Geo.lathe(prof, 32).translate(0, ty, zb + 0.9);
    deco.add(dataColor(dome, (p) => [0.75 + 0.25 * sstep(zb + 1.2, zb + 3.5, p[2]), 0, 0]).mat(MAT.COPPER));
    deco.add(snowData(Geo.lathe([[1.7, 0], [1.85, 0.12], [1.6, 0.45], [1.1, 0.95], [0.6, 1.25], [0.05, 1.32]], 32).translate(0, ty, zb + 0.9 + 0.95), 0.95));
    const cross = new Geo();
    cross.add(cbox(0.08, 0.08, 1.2, 0.02).translate(0, 0, 0.6));
    cross.add(cbox(0.6, 0.08, 0.08, 0.02).translate(0, 0, 0.82));
    deco.add(aoColor(cross.translate(0, ty, zb + 0.9 + 5.5), '#d8b25a', () => 1).gloss(0.8).mat(MAT.METAL));
  }
  // door in the base of the tower, with a lamp each side
  {
    const dg = new Geo();
    dg.add(aoColor(cbox(1.6, 0.25, 2.7, 0.04).translate(0, 0, 1.35), '#c9c2b4', () => 0.8));
    dg.add(aoColor(cbox(1.2, 0.2, 2.45, 0.03).translate(0, 0.05, 1.22), '#4b2f1e', () => 0.7));
    dg.mat(MAT.WOOD);
    for (const sx of [-1, 1]) dg.add(dataColor(Geo.sphere(0.09, 8, 6).translate(sx * 1.05, 0.25, 2.4), () => [1, 0.12, 0]).mat(MAT.LANTERN));
    dg.add(snowData(rbox(2.4, 1.3, 0.3, 0.15, 2).translate(0, 1.0, -0.12)));
    deco.add(dg.translate(0, ty + T / 2, 0));
  }
  deco.add(drift(W + 4, 2.6, 0.9).translate(-W / 2 - 1.3, 0, 0).rotateZ(0));
  deco.add(drift(3.2, D + 3, 1.0).translate(-W / 2 - 1.2, 0, 0));
  deco.add(drift(3.0, D * 0.8, 0.8).translate(W / 2 + 1.3, -1, 0));
  b.static(solid, { transform: MZ });
  b.static(deco, { transform: MZ, solid: false });
  stampAO(cx, cy, 10, 0.4);
}

// ---------------------------------------------------------------------------
// the path and its lanterns

// lanterns every 12 m, on alternate sides: [x, y, z of the light, distance along]
const LAMPS = (() => {
  const out = [];
  for (let d = 8, i = 0; d < PATH.length - 4; d += 12, i++) {
    const { p, dir } = PATH.smoothAt(d, 4);
    const side = i % 2 ? 1 : -1, off = PATH_HALF + 1.1;
    const x = p[0] - dir[1] * off * side, y = p[1] + dir[0] * off * side;
    out.push([x, y, ground(x, y) + 2.55, d]);
  }
  return out;
})();

// One lantern, drawn at every lamp (b.instances): its distance along the path
// comes as the copy's number, s.inst.w, and its glass is tagged 1.
function lantern() {
  const g = new Geo();
  g.add(aoColor(cbox(0.17, 0.17, 2.36, 0.03).translate(0, 0, 1.18), '#4a3424', (p) => 0.55 + 0.45 * sstep(0, 1.2, p[2])).mat(MAT.WOOD));
  g.add(aoColor(cbox(0.36, 0.36, 0.06, 0.015).translate(0, 0, 2.38), '#1e1e1e', () => 0.8).mat(MAT.METAL));
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    g.add(aoColor(Geo.box(0.035, 0.035, 0.42).translate(x * 0.135, y * 0.135, 2.62), '#1e1e1e', () => 0.8).mat(MAT.METAL));
  }
  g.add(Geo.box(0.25, 0.25, 0.40).translate(0, 0, 2.61).color('#ffb060').mat(MAT.LANTERN).tag(1));
  g.add(aoColor(Geo.cone(0.27, 0.2, 4).rotateZ(Math.PI / 4).translate(0, 0, 2.83), '#1e1e1e', () => 0.85).mat(MAT.METAL));
  g.add(aoColor(Geo.sphere(0.035, 6, 4).translate(0, 0, 3.05), '#1e1e1e', () => 0.85).mat(MAT.METAL));
  g.add(snowData(Geo.cone(0.25, 0.14, 8).translate(0, 0, 2.86)));
  return g;
}

// the trodden path: a ribbon over the snow with low banks either side.
// uv = (offset across, distance along) in metres.
function pathRibbon() {
  const g = new Geo();
  const h = PATH_HALF;
  const cross = [[-(h + 1.6), 0.0], [-(h + 0.45), 0.11], [-(h - 0.2), 0.035], [0, 0.03], [h - 0.2, 0.035], [h + 0.45, 0.11], [h + 1.6, 0.0]];
  const step = 1.25;
  const n = Math.floor(PATH.length / step);
  for (let k = 0; k <= n; k++) {
    const d = k * step;
    const { p, dir } = PATH.smoothAt(d, 3);
    const nx = -dir[1], ny = dir[0];
    const wob = 0.25 * Math.sin(d / 9.0) + 0.15 * Math.sin(d / 3.7);
    for (const [o, dz] of cross) {
      const oo = o + (Math.abs(o) > h + 1 ? Math.sign(o) * wob * 0.5 : 0);
      const x = p[0] + nx * oo, y = p[1] + ny * oo;
      g.vert(x, y, ground(x, y) + dz, 0, 0, 1, o, d);
    }
  }
  const m = cross.length;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < m - 1; j++) {
      const a = k * m + j;
      g.quadIdx(a, a + 1, a + m + 1, a + m);
    }
  }
  g.computeNormals(true);
  g.orientByNormals();
  return dataColor(g, (p) => [1, 0, 0]).mat(MAT.PATH);
}

// ---------------------------------------------------------------------------
// the chairlift: towers, the rope loop, and chairs that go round it.  The
// loop takes LIFT_LAPS periods, so each chair object stands for LIFT_LAPS
// chairs a period apart.

const LIFT_LAPS = 10, LIFT_CHAIRS = 6, LIFT_HALF = 2.5;

function liftLine() {
  const a = LIFT.a, bb = LIFT.b;
  const dx = bb[0] - a[0], dy = bb[1] - a[1], Lh = Math.hypot(dx, dy);
  const d = [dx / Lh, dy / Lh], n = [d[1], -d[0]];   // n: to the right going up
  const N = 8;
  const pts = [];
  for (let i = 0; i <= N + 1; i++) {
    const s = i / (N + 1);
    const x = a[0] + dx * s, y = a[1] + dy * s;
    const g = ground(x, y);
    pts.push({ x, y, g, h: i === 0 || i === N + 1 ? 5.6 : 10 + 3 * Math.sin(i * 2.3) });
  }
  // raise towers until the rope clears the snow by 6 m everywhere
  for (let iter = 0; iter < 30; iter++) {
    let ok = true;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      for (let k = 1; k < 10; k++) {
        const f = k / 10, x = p.x + (q.x - p.x) * f, y = p.y + (q.y - p.y) * f;
        const rz = (p.g + p.h) * (1 - f) + (q.g + q.h) * f;
        if (rz - ground(x, y) < 6.5) {
          ok = false;
          if (i + 1 < pts.length - 1) q.h += 0.8;
          if (i > 0) p.h += 0.8;
        }
      }
    }
    if (ok) break;
  }
  return { a, b: bb, d, n, Lh, pts };
}

// the closed path of the grips (rope height), going up on the right
function liftLoop(line) {
  const { d, n, pts } = line;
  const out = [];
  const R = LIFT_HALF;
  const at = (p, side) => [p.x + n[0] * R * side, p.y + n[1] * R * side, p.g + p.h + 0.3 * (p === pts[0] || p === pts[pts.length - 1] ? 0 : 1)];
  for (const p of pts) out.push(at(p, 1));
  const top = pts[pts.length - 1], bot = pts[0];
  for (let k = 1; k < 16; k++) {
    const th = k / 16 * Math.PI;
    out.push([top.x + R * (n[0] * Math.cos(th) + d[0] * Math.sin(th)), top.y + R * (n[1] * Math.cos(th) + d[1] * Math.sin(th)), top.g + top.h]);
  }
  for (let i = pts.length - 1; i >= 0; i--) out.push(at(pts[i], -1));
  for (let k = 1; k < 16; k++) {
    const th = k / 16 * Math.PI;
    out.push([bot.x + R * (-n[0] * Math.cos(th) - d[0] * Math.sin(th)), bot.y + R * (-n[1] * Math.cos(th) - d[1] * Math.sin(th)), bot.g + bot.h]);
  }
  return new Path(out, { closed: true });
}

function liftChair(color) {
  const g = new Geo();
  const metal = (geo) => aoColor(geo, '#9aa0a6', () => 0.9).mat(MAT.METAL);
  g.add(metal(Geo.box(0.22, 0.42, 0.2)));
  g.add(metal(Geo.tube([[0, 0, 0], [0, -0.1, -0.5], [0, -0.42, -2.2]], 0.045, 4, { caps: false })));
  g.add(metal(Geo.box(2.0, 0.06, 0.06).translate(0, -0.42, -2.2)));
  for (const x of [-0.98, 0.98]) g.add(metal(Geo.tube([[x, -0.42, -2.2], [x, -0.3, -2.62], [x, 0.45, -2.5]], 0.03, 4, { caps: false })));
  g.add(metal(Geo.box(2.0, 0.05, 0.05).translate(0, 0.55, -2.45)));
  g.add(metal(Geo.box(1.9, 0.04, 0.04).translate(0, 0.62, -3.05)));
  g.add(aoColor(cbox(1.96, 0.52, 0.1, 0.04).translate(0, 0.02, -2.56), color, () => 0.85).mat(MAT.CLOTH));
  g.add(aoColor(cbox(1.96, 0.09, 0.55, 0.04).transform(m4.mul(m4.translation(0, -0.34, -2.28), m4.rotationX(0.18))), color, () => 0.8).mat(MAT.CLOTH));
  return g;
}

// a rider, sitting: modelled at the seat with +y forward
const JACKETS = ['#c0392b', '#2e86c1', '#f1c40f', '#27ae60', '#8e44ad', '#e67e22', '#ecf0f1', '#34495e', '#d35400', '#16a085'];
function rider(rand, x) {
  const g = new Geo();
  const jacket = rand.pick(JACKETS), pants = rand.pick(['#2c3e50', '#1b1b1b', '#5d4037', '#37474f']);
  g.add(aoColor(Geo.box(0.40, 0.26, 0.58).transform(m4.mul(m4.translation(x, -0.12, -2.22), m4.rotationX(-0.12))), jacket, () => 0.9).mat(MAT.CLOTH));
  g.add(aoColor(Geo.sphere(0.125, 5, 4).translate(x, -0.08, -1.78), rand.pick(['#1b1b1b', '#e74c3c', '#ffffff', '#2980b9']), () => 1).gloss(0.6).mat(MAT.CLOTH));
  for (const s of [-0.1, 0.1]) {
    g.add(aoColor(Geo.box(0.13, 0.45, 0.14).translate(x + s, 0.16, -2.46), pants, () => 0.85).mat(MAT.CLOTH));
    g.add(aoColor(Geo.box(0.12, 0.14, 0.45).translate(x + s, 0.36, -2.72), pants, () => 0.8).mat(MAT.CLOTH));
    g.add(aoColor(Geo.box(0.07, 1.6, 0.03).translate(x + s, 0.55, -2.98), rand.pick(['#d4ac0d', '#cb4335', '#2471a3', '#17202a']), () => 0.9).gloss(0.6).mat(MAT.METAL));
  }
  return g;
}

function liftTower(h) {
  const g = new Geo();
  g.add(aoColor(Geo.cylinder(0.42, h, 10, { r2: 0.28 }), '#7f8c8d', (p) => 0.6 + 0.4 * sstep(0, 3, p[2])).mat(MAT.METAL));
  g.add(aoColor(cbox(1.4, 1.4, 0.4, 0.06).translate(0, 0, 0.2), '#5d6d6e', () => 0.6).mat(MAT.METAL));
  // cross-arm and sheave trains
  g.add(aoColor(cbox(6.4, 0.38, 0.38, 0.05).translate(0, 0, h - 0.2), '#7f8c8d', () => 0.85).mat(MAT.METAL));
  for (const s of [-1, 1]) {
    g.add(aoColor(cbox(0.14, 2.6, 0.22, 0.03).translate(s * LIFT_HALF, 0, h + 0.15), '#5d6d6e', () => 0.8).mat(MAT.METAL));
    for (const y of [-0.9, -0.3, 0.3, 0.9]) {
      g.add(aoColor(Geo.cylinder(0.2, 0.08, 10).rotateY(Math.PI / 2).translate(s * LIFT_HALF - 0.04, y, h + 0.3), '#2c3e50', () => 0.9).mat(MAT.METAL));
    }
  }
  // a little platform and a warning lamp on top
  g.add(aoColor(cbox(1.2, 0.8, 0.06, 0.02).translate(0, -0.6, h - 1.4), '#5d6d6e', () => 0.7).mat(MAT.METAL));
  g.add(snowData(rbox(6.3, 0.34, 0.1, 0.05, 1).translate(0, 0, h + 0.02)));
  return g;
}

// a station: the bull wheel under a canopy, on a timber base
function liftStation(b, p, d, n, rz, top) {
  const M = m4.fromBasis([n[0], n[1], 0], [d[0], d[1], 0], [0, 0, 1], [p.x, p.y, p.g]);
  const g = new Geo(), solid = new Geo();
  const up = rz - p.g;
  // bull wheel
  const wheel = new Geo();
  wheel.add(Geo.torus(LIFT_HALF, 0.12, 32, 6));
  for (let k = 0; k < 6; k++) wheel.add(cbox(LIFT_HALF * 2, 0.1, 0.06, 0.02).rotateZ(k * Math.PI / 6));
  wheel.add(Geo.cylinder(0.3, 0.4, 10).translate(0, 0, -0.2));
  g.add(aoColor(wheel.translate(0, 0, up), '#c0392b', () => 0.85).mat(MAT.METAL));
  // canopy roof over the wheel
  const roof = rbox(7.4, 8.4, 0.3, 0.08, 1).translate(0, top ? 0.8 : -0.8, up + 2.4);
  g.add(aoColor(roof, '#34495e', (q, nn) => (nn[2] < 0 ? 0.6 : 0.9)).mat(MAT.METAL));
  g.add(snowData(rbox(7.2, 8.2, 0.45, 0.2, 2, [3, 3, 1]).translate(0, top ? 0.8 : -0.8, up + 2.75)));
  for (const [sx, sy] of [[-3.2, -3.4], [3.2, -3.4], [-3.2, 3.4], [3.2, 3.4]]) {
    solid.add(aoColor(cbox(0.3, 0.3, up + 2.4, 0.04).translate(sx, sy + (top ? 0.8 : -0.8), (up + 2.4) / 2), '#7f8c8d', (q) => 0.6 + 0.4 * sstep(0, 2, q[2])).mat(MAT.METAL));
  }
  // the hut for the lift attendant, with a clock board facing the path
  const hut = rbox(3.4, 3.0, 2.8, 0.06, 1).translate(top ? -5.8 : 5.8, top ? 2 : -2, 1.4);
  solid.add(dataColor(hut, (q) => [0.6 + 0.4 * sstep(0, 1.5, q[2]), 0.6, 0]).mat(MAT.LOGS));
  g.add(snowData(rbox(4.0, 3.6, 0.4, 0.18, 2).translate(top ? -5.8 : 5.8, top ? 2 : -2, 2.95)));
  const board = Geo.quad([-1.1, 0, 0], [1.1, 0, 0], [1.1, 0, 0.75], [-1.1, 0, 0.75]);
  if (board.n[1] > 0) board.flip();
  g.add(dataColor(board.translate(top ? -5.8 : 5.8, (top ? 2 : -2) - 1.56, 1.6), () => [1, 0, 0]).mat(MAT.BOARD));
  g.add(aoColor(cbox(2.4, 0.1, 0.95, 0.03).translate(top ? -5.8 : 5.8, (top ? 2 : -2) - 1.5, 1.975), '#1a1a1a', () => 0.8).mat(MAT.METAL));
  g.add(drift(9, 4, 0.8).translate(0, top ? 5 : -5, 0));
  b.static(g, { transform: M, solid: false });
  b.static(solid, { transform: M });
  stampAO(p.x, p.y, 6, 0.4);
}

function chairlift(b) {
  const line = liftLine();
  const { d, n, pts } = line;
  // towers
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const M = m4.fromBasis([n[0], n[1], 0], [d[0], d[1], 0], [0, 0, 1], [p.x, p.y, p.g - 0.3]);
    b.static(liftTower(p.h + 0.3), { transform: M });
    stampAO(p.x, p.y, 1.5, 0.35);
  }
  liftStation(b, pts[0], d, n, pts[0].g + pts[0].h, false);
  liftStation(b, pts[pts.length - 1], d, n, pts[pts.length - 1].g + pts[pts.length - 1].h, true);
  // the rope
  const loop = liftLoop(line);
  const rope = new Geo();
  for (let i = 0; i < loop.points.length - 1; i++) {
    rope.add(Geo.tube([loop.points[i], loop.points[i + 1]].map((q) => [q[0], q[1], q[2] + 0.05]), 0.03, 4, { caps: false }));
  }
  b.static(aoColor(rope, '#3d4245', () => 1).gloss(0.4).mat(MAT.METAL), { solid: false });
  // chairs: keys exactly where the path bends
  const L = loop.length, T = LIFT_LAPS * P, v = L / T;
  const rand = rng(31);
  const colors = ['#2e4053', '#922b21', '#1f618d'];
  for (let c = 0; c < LIFT_CHAIRS; c++) {
    const off = c * L / (LIFT_CHAIRS * LIFT_LAPS);
    const tf = (t) => {
      const q = loop.smoothAt(off + v * t, 0.6);
      return m4.facing([q.p[0], q.p[1], q.p[2]], [q.dir[0], q.dir[1], 0]);
    };
    const times = new Set([0, T]);
    for (const cd of loop.cum) times.add(((cd - off) / v % T + T) % T);
    const keys = [...times].sort((x, y) => x - y).filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.02);
    b.dynamic(liftChair(colors[c % 3]), { times: keys, transform: tf, caps: 'none' });
    // riders on the way up only (from leaving the bottom wheel to the top wheel)
    const upLen = loop.cum[pts.length - 1];
    for (let lap = 0; lap < 1; lap++) {
      const t0 = ((0 - off) / v % T + T) % T, t1 = t0 + upLen / v;
      const rk = [t0, ...keys.filter((t) => t > t0 + 0.02 && t < t1 - 0.02), t1];
      const who = new Geo();
      const nr = 1 + Math.floor(rand() * 3);
      for (let r = 0; r < nr; r++) who.add(rider(rand, -0.72 + r * 0.72 * (3 / Math.max(2, nr))));
      b.dynamic(who, { times: rk, transform: tf, caps: 'none' });
    }
  }
  return line;
}

// ---------------------------------------------------------------------------
// the aerial tram.  One cabin is authored over two periods, so it is drawn
// twice, half a cycle apart: one copy goes up while the other comes down.
// It rides up on one track rope and down on the other, changing tracks while
// it stands in a station, so the two copies never meet.

const TRAM_SPLIT = 5;

function tramGeometry() {
  const a = TRAM.a, bb = TRAM.b;
  const dx = bb[0] - a[0], dy = bb[1] - a[1], Lh = Math.hypot(dx, dy);
  const d = [dx / Lh, dy / Lh], n = [d[1], -d[0]];
  const za = ground(a[0], a[1]) + 11.5, zb = ground(bb[0], bb[1]) + 10.5;
  const sag = 0.05 * Lh;
  const rope = (s, side) => [a[0] + dx * s + n[0] * side, a[1] + dy * s + n[1] * side, za + (zb - za) * s - 4 * sag * s * (1 - s)];
  return { a, b: bb, d, n, za, zb, Lh, rope };
}

function tramCabin() {
  const g = new Geo();
  const red = (geo, k = 0.9) => aoColor(geo, '#b3261e', () => k).gloss(0.55).mat(MAT.CABIN);
  g.add(red(rbox(2.7, 4.4, 1.25, 0.4, 2, [1, 1, 1]).translate(0, 0, -6.75)));
  const win = rbox(2.6, 4.3, 1.15, 0.36, 2, [1, 1, 1]).translate(0, 0, -5.6);
  g.add(dataColor(win, () => [1, 0.5, 0]).mat(MAT.CABINWIN));
  g.add(red(rbox(2.7, 4.4, 0.4, 0.18, 1).translate(0, 0, -4.85)));
  g.add(aoColor(cbox(1.2, 2.2, 0.25, 0.05).translate(0, 0, -4.55), '#d0d3d4', () => 0.9).mat(MAT.METAL));
  g.add(aoColor(cbox(0.22, 0.22, 4.1, 0.05).translate(0, 0, -2.4), '#7b7d7d', () => 0.9).mat(MAT.METAL));
  g.add(aoColor(cbox(0.5, 3.2, 0.55, 0.06).translate(0, 0, -0.25), '#5d6d7e', () => 0.9).mat(MAT.METAL));
  for (const y of [-1.2, -0.4, 0.4, 1.2]) g.add(aoColor(Geo.cylinder(0.2, 0.12, 8).rotateY(Math.PI / 2).translate(-0.06, y, 0.05), '#2c3e50', () => 0.9).mat(MAT.METAL));
  // a red lamp under the floor
  g.add(dataColor(Geo.sphere(0.12, 6, 4).translate(0, 2.0, -7.42), () => [1, 0, 0]).mat(MAT.BEACON));
  return g;
}

function tramStation(b, p, d, n, zr, top) {
  const gz = ground(p[0], p[1]);
  const M = m4.fromBasis([n[0], n[1], 0], [d[0], d[1], 0], [0, 0, 1], [p[0], p[1], gz]);
  const solid = new Geo(), deco = new Geo();
  const H = zr - gz + 2.2, W = 16, Dp = 12, back = top ? 3.5 : -3.5, hs = 4.2;
  const sink = 2.5;
  // stone base, a log hall above it with a band of windows, a shallow roof
  solid.add(dataColor(rbox(W, Dp, hs + sink, 0.12, 1).translate(0, back, (hs - sink) / 2), (q) => [0.6 + 0.4 * sstep(-0.5, 2.5, q[2]), 0.4, 0]).mat(MAT.STONE));
  solid.add(dataColor(rbox(W - 0.4, Dp - 0.4, H - hs, 0.08, 1).translate(0, back, hs + (H - hs) / 2), (q) => [0.6 + 0.4 * sstep(H + 0.3, H - 2, q[2]), 0.7, 0]).mat(MAT.LOGS));
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const y = back - Dp / 2 + 1.8 + k * (Dp - 3.6) / 3;
      const gl = Geo.quad([0, -1.0, 0], [0, 1.0, 0], [0, 1.0, 1.6], [0, -1.0, 1.6]);
      if (gl.n[0] * sx < 0) gl.flip();
      deco.add(dataColor(gl.translate(sx * (W / 2 - 0.17), y, hs + 2.2), () => [1, 0.2 + 0.15 * k + (top ? 0.4 : 0), 0]).mat(MAT.GLASS));
      deco.add(aoColor(cbox(0.14, 2.3, 0.1, 0.03).translate(sx * (W / 2 - 0.12), y, hs + 2.12), '#d8d0c0', () => 0.8).mat(MAT.WOOD));
      deco.add(snowData(cbox(0.2, 2.2, 0.08, 0.035).translate(sx * (W / 2 - 0.05), y, hs + 2.03)));
    }
  }
  const roofM = m4.mul(m4.translation(0, back, H + 0.25), m4.rotationX(top ? -0.1 : 0.1));
  deco.add(aoColor(rbox(W + 2.4, Dp + 2.4, 0.4, 0.1, 1).transform(roofM), '#3b3f45', (q, nn) => (nn[2] < 0 ? 0.6 : 0.9)).mat(MAT.METAL));
  deco.add(snowData(rbox(W + 2.0, Dp + 2.0, 0.62, 0.29, 2, [4, 3, 1]).transform(m4.mul(roofM, m4.translation(0, 0, 0.46)))));
  // the dark opening the cabins come out of
  const op = Geo.quad([-6.5, 0, hs + 0.5], [6.5, 0, hs + 0.5], [6.5, 0, H - 0.6], [-6.5, 0, H - 0.6]);
  if ((op.n[1] > 0) !== top) op.flip();
  deco.add(aoColor(op.translate(0, back + (top ? -Dp / 2 + 0.17 : Dp / 2 - 0.17), 0), '#060708', () => 1).mat(MAT.METAL));
  // a clock board under the opening, and a beacon on the roof
  const board = Geo.quad([-1.3, 0, 0], [1.3, 0, 0], [1.3, 0, 0.85], [-1.3, 0, 0.85]);
  if ((board.n[1] > 0) !== top) board.flip();
  deco.add(dataColor(board.translate(0, back + (top ? -Dp / 2 - 0.05 : Dp / 2 + 0.05), hs - 1.6), () => [1, 0, 0]).mat(MAT.BOARD));
  deco.add(dataColor(Geo.sphere(0.25, 8, 6).translate(0, back, H + 1.0), () => [1, top ? 0.5 : 0, 0]).mat(MAT.BEACON));
  deco.add(drift(W + 6, 5, 1.0).translate(0, back + (top ? Dp / 2 + 2 : -Dp / 2 - 2), 0));
  b.static(solid, { transform: M });
  b.static(deco, { transform: M, solid: false });
  stampAO(p[0], p[1], 12, 0.45);
}

function aerialTram(b) {
  const T = tramGeometry();
  const { d, n, rope, za, zb } = T;
  tramStation(b, T.a, d, n, za, false);
  tramStation(b, T.b, d, n, zb, true);
  // the track ropes and the haul rope
  const ropes = new Geo();
  for (const side of [-TRAM_SPLIT, TRAM_SPLIT, -TRAM_SPLIT - 0.5, TRAM_SPLIT + 0.5]) {
    const pts = [];
    for (let k = 0; k <= 48; k++) pts.push(rope(k / 48, side));
    ropes.add(Geo.tube(pts, 0.045, 4, { caps: false }));
  }
  b.static(aoColor(ropes, '#2f3336', () => 1).gloss(0.4).mat(MAT.METAL), { solid: false });
  // one cycle over two periods: wait, up, wait, down
  const C2 = 2 * P, wait = 4, trip = (C2 - 4 * wait) / 2;
  const ease = (x) => {
    const r = 0.12;   // share of the trip spent speeding up (and again slowing down)
    const vmax = 1 / (1 - r);
    if (x < r) return vmax * x * x / (2 * r);
    if (x > 1 - r) return 1 - vmax * (1 - x) * (1 - x) / (2 * r);
    return vmax * (x - r / 2);
  };
  const state = (t) => {
    t = ((t % C2) + C2) % C2;
    // returns [position along 0..1, side offset]
    if (t < wait) return [0, -TRAM_SPLIT + TRAM_SPLIT * (t / wait) * 1 + TRAM_SPLIT * (t / wait)];
    if (t < wait + trip) return [ease((t - wait) / trip), TRAM_SPLIT];
    if (t < 3 * wait + trip) return [1, TRAM_SPLIT - 2 * TRAM_SPLIT * (t - wait - trip) / (2 * wait)];
    if (t < 3 * wait + 2 * trip) return [1 - ease((t - 3 * wait - trip) / trip), -TRAM_SPLIT];
    return [0, -TRAM_SPLIT + 0 * (t - 3 * wait - 2 * trip)];
  };
  const tf = (t) => {
    const [s, side] = state(t);
    const p = rope(Math.min(1, Math.max(0, s)), side);
    return m4.fromBasis([n[0], n[1], 0], [d[0], d[1], 0], [0, 0, 1], p);
  };
  // keys: where the motion bends, plus the corners of the cycle
  const times = adaptiveTimes(tf, 0, C2, { tolerance: 0.12, size: 4, maxStep: 6 });
  b.dynamic(tramCabin(), { times, transform: tf, caps: 'none' });
}

// ---------------------------------------------------------------------------
// skaters on the swept rink of the frozen lake

function skater(rand) {
  const g = new Geo();
  const coat = rand.pick(JACKETS), dark = rand.pick(['#1b2631', '#3e2723', '#212f3d', '#4a235a']);
  const lean = m4.rotationX(-0.32);
  const body = new Geo();
  body.add(aoColor(rbox(0.40, 0.26, 0.62, 0.11, 1).translate(0, 0, 1.22), coat, () => 0.95).mat(MAT.CLOTH));
  body.add(aoColor(Geo.sphere(0.115, 8, 6).translate(0, 0.02, 1.68), '#e6c2a6', () => 1).mat(MAT.SKIN));
  body.add(aoColor(Geo.cone(0.13, 0.26, 8).translate(0, 0.0, 1.74), rand.pick(['#c0392b', '#f4f6f7', '#1f618d', '#f1c40f']), () => 1).mat(MAT.CLOTH));
  body.add(aoColor(Geo.torus(0.12, 0.05, 8, 4).translate(0, 0.0, 1.55), rand.pick(['#e74c3c', '#f39c12', '#27ae60']), () => 1).mat(MAT.CLOTH));
  // arms folded behind the back
  for (const s of [-1, 1]) body.add(aoColor(Geo.tube([[s * 0.22, 0, 1.45], [s * 0.26, -0.1, 1.2], [s * 0.1, -0.2, 1.05]], 0.055, 5), coat, () => 0.85).mat(MAT.CLOTH));
  g.add(body.transform(m4.mul(m4.translation(0, 0, 0.9), lean, m4.translation(0, 0, -0.9))));
  // legs: one gliding, one pushing out behind
  g.add(aoColor(Geo.tube([[0.1, 0.05, 0.95], [0.1, 0.12, 0.5], [0.1, 0.05, 0.08]], 0.075, 5), dark, () => 0.85).mat(MAT.CLOTH));
  g.add(aoColor(Geo.tube([[-0.1, -0.02, 0.95], [-0.2, -0.3, 0.55], [-0.3, -0.62, 0.22]], 0.075, 5), dark, () => 0.85).mat(MAT.CLOTH));
  g.add(aoColor(Geo.box(0.03, 0.42, 0.05).translate(0.1, 0.08, 0.025), '#d5dbdb', () => 1).gloss(0.8).mat(MAT.METAL));
  g.add(aoColor(Geo.box(0.03, 0.42, 0.05).transform(m4.mul(m4.translation(-0.3, -0.66, 0.2), m4.rotationX(-0.5))), '#d5dbdb', () => 1).gloss(0.8).mat(MAT.METAL));
  return g;
}

// a low bank of swept snow round the rink, open towards the path
function rinkBank() {
  const g = new Geo();
  const c = Math.cos(LAKE.a), sn = Math.sin(LAKE.a);
  const seg = 72, prof = [[-1.1, 0], [-0.5, 0.22], [0, 0.32], [0.5, 0.2], [1.2, 0]];
  const rows = [];
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * TAU;
    // the gap faces east, towards the path
    const gap = sstep(0.25, 0.05, Math.abs(Math.atan2(Math.sin(a), Math.cos(a))));
    const ex = Math.cos(a) * RINK.rx, ey = Math.sin(a) * RINK.ry;
    const nx0 = Math.cos(a) / RINK.rx, ny0 = Math.sin(a) / RINK.ry, nl = Math.hypot(nx0, ny0);
    const row = [];
    for (const [o, h] of prof) {
      const lx = ex + nx0 / nl * o, ly = ey + ny0 / nl * o;
      const x = RINK.x + lx * c - ly * sn, y = RINK.y + lx * sn + ly * c;
      row.push(g.vert(x, y, ZLAKE + h * (1 - gap) * (0.85 + 0.3 * Math.sin(a * 7 + 1)), 0, 0, 1));
    }
    rows.push(row);
  }
  for (let i = 0; i < seg; i++) for (let k = 0; k < prof.length - 1; k++) g.quadIdx(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
  g.computeNormals(true);
  g.orientByNormals();
  return snowData(g, 0.95);
}

function skaters(b) {
  b.static(rinkBank(), { solid: false });
  const rand = rng(57);
  const c = Math.cos(LAKE.a), sn = Math.sin(LAKE.a);
  const rinks = [[36, 23, 1, 0], [28, 18, 1, 1.3], [20, 13, -1, 2.0], [42, 27, 1, 3.1], [14, 9, 1, 0.6], [32, 21, -1, 4.4], [24, 20, 1, 5.2], [38, 25, 1, 2.6], [18, 15, -1, 3.7]];
  rinks.forEach(([ra, rb, dir, ph], i) => {
    const per = 2 * Math.PI * Math.sqrt((ra * ra + rb * rb) / 2);
    const laps = 1;
    const w = dir * laps * 2 * Math.PI / P;
    const ox = (i % 3 - 1) * 6, oy = ((i * 7) % 5 - 2) * 4;
    const tf = (t) => {
      const a = ph + w * t;
      const lx = Math.cos(a) * ra + ox, ly = Math.sin(a) * rb + oy;
      const x = RINK.x + lx * c - ly * sn, y = RINK.y + lx * sn + ly * c;
      const tx = -Math.sin(a) * ra * dir, ty = Math.cos(a) * rb * dir;
      const fx = tx * c - ty * sn, fy = tx * sn + ty * c;
      const bank = dir * 0.14;
      return m4.mul(m4.facing([x, y, ZLAKE + 0.01], [fx, fy, 0]), m4.rotationY(bank));
    };
    const times = adaptiveTimes(tf, 0, P, { tolerance: 0.1, size: 1.0, maxStep: 3 });
    b.dynamic(skater(rand), { times, transform: tf, caps: 'none' });
  });
}

// ---------------------------------------------------------------------------
// skiers carving down the pistes

function skierGeo(rand) {
  const g = new Geo();
  const coat = rand.pick(JACKETS), pants = rand.pick(['#1b2631', '#212f3d', '#7b241c', '#17202a', '#f8f9f9']);
  const body = new Geo();
  body.add(aoColor(cbox(0.40, 0.26, 0.58, 0.08).translate(0, 0, 1.15), coat, () => 0.95).mat(MAT.CLOTH));
  body.add(aoColor(Geo.sphere(0.13, 6, 4).translate(0, 0.03, 1.56), rand.pick(['#1b1b1b', '#f4f6f7', '#e74c3c', '#2980b9']), () => 1).gloss(0.6).mat(MAT.CLOTH));
  for (const s of [-1, 1]) {
    body.add(aoColor(Geo.box(0.025, 0.025, 1.15).transform(m4.mul(m4.translation(s * 0.3, 0.6, 0.62), m4.rotationX(-0.45))), '#bdc3c7', () => 1).mat(MAT.METAL));
  }
  g.add(body.transform(m4.mul(m4.translation(0, 0, 0.75), m4.rotationX(-0.4), m4.translation(0, 0, -0.75))));
  for (const s of [-1, 1]) {
    g.add(aoColor(Geo.box(0.14, 0.16, 0.86).transform(m4.mul(m4.translation(s * 0.12, 0.05, 0.43), m4.rotationX(0.12))), pants, () => 0.85).mat(MAT.CLOTH));
    g.add(aoColor(Geo.box(0.08, 1.7, 0.03).translate(s * 0.12, 0.05, 0.03), rand.pick(['#d4ac0d', '#cb4335', '#2471a3', '#f0f3f4']), () => 1).gloss(0.6).mat(MAT.METAL));
  }
  return g;
}

function skiers(b) {
  const rand = rng(91);
  PISTES.forEach((piste, pi) => {
    const L = piste.length;
    for (let k = 0; k < 3; k++) {
      const speed = 7 + rand() * 3, dur = L / speed;
      const t0 = k * P / 3 + rand() * 6, amp = 4 + rand() * 3, wl = 46 + rand() * 16, ph = rand() * TAU;
      const geo = skierGeo(rand);
      const pos = (t) => {
        const dd = Math.min(L, Math.max(0, (t - t0) * speed));
        const q = piste.smoothAt(dd, 6);
        const off = amp * Math.sin(dd / wl * TAU + ph) * sstep(0, 40, dd) * sstep(L, L - 40, dd);
        const x = q.p[0] - q.dir[1] * off, y = q.p[1] + q.dir[0] * off;
        return [x, y, ground(x, y) + 0.02];
      };
      const tf = (t) => {
        const p0 = pos(t - 0.4), p1 = pos(t + 0.4), p = pos(t);
        const fwd = [p1[0] - p0[0], p1[1] - p0[1], 0];
        // lean into the turn: the side the carve bends towards
        const dd = (t - t0) * speed;
        const lean = -Math.sin(dd / wl * TAU + ph) * 0.35 * sstep(0, 40, dd) * sstep(L, L - 40, dd);
        return m4.mul(m4.facing(p, fwd), m4.rotationY(lean));
      };
      const times = adaptiveTimes(tf, t0, t0 + dur, { tolerance: 0.25, size: 0.8, maxStep: 4, minStep: 0.15 });
      b.dynamic(geo, { times, transform: tf });
    }
  });
}

// ---------------------------------------------------------------------------
// chimney smoke: soft see-through puffs that rise, grow and thin out.  Each
// is densest as it leaves the chimney and fades as it spreads (the opacity
// of its key poses: roughly the square of the life it has left); the shader
// thins it towards its outline.

function smoke(b) {
  const puff = Geo.sphere(1, 7, 4).mat(MAT.SMOKE).color('#ffffff');
  const pose = [puff.clone().blend(SMOKE_OPACITY), puff.clone().blend(SMOKE_OPACITY * 0.42), puff.clone().blend(0)];
  const rand = rng(5);
  const every = 0.9, life = 10, mid = 3.5;
  for (const c of CHIMNEYS) {
    const ph = rand() * every;
    const drift = [1.6 + rand() * 0.8, 0.6 + rand() * 0.6];
    for (let t0 = -life + ph; t0 < P - life + ph + 1e-6 + life; t0 += every) {
      if (t0 >= P + ph - 1e-6) break;
      const jx = (rand() - 0.5) * 0.4, jy = (rand() - 0.5) * 0.4;
      // One period's puffs are all there need be: the scene repeats them, so
      // the last ten seconds' already stand in for those born before the
      // start.  (Those were once drawn as well, which doubled the smoke for
      // twenty seconds round every period's seam.  Their random draws are
      // still made, so that every other puff keeps its own.)
      if (t0 < ph - every / 2) continue;
      const times = [t0, t0 + mid, t0 + life];
      b.dynamic((t) => pose[times.indexOf(t)], {
        times,
        transform: (t) => {
          const u = (t - t0) / life;
          return m4.mul(m4.translation(c[0] + jx * (0.3 + u) + drift[0] * u * 3, c[1] + jy * (0.3 + u) + drift[1] * u * 3, c[2] + 0.15 + u * 7.5), m4.scaling(0.45 + u * 2.0));
        },
        caps: 'none',
      });
    }
  }
}
const SMOKE_OPACITY = 0.5;

// ---------------------------------------------------------------------------
// people walking the path.  Each walker object takes the whole walk, which
// lasts many periods, so it is drawn once a period: a stream of walkers
// about 80 m apart, half of them going each way.

function walkerGeo(rand, extra) {
  const g = new Geo();
  const coat = rand.pick(['#7b241c', '#1f3a5f', '#4a5a2a', '#5b2c6f', '#2e4053', '#a04000', '#145a32', '#6e2c00']);
  const pants = rand.pick(['#1b2631', '#212f3d', '#3e2723', '#17202a']);
  // a rounded coat, wider at the hem, with a collar
  g.add(aoColor(Geo.lathe([[0.02, 0.72], [0.25, 0.74], [0.21, 1.25], [0.23, 1.42], [0.06, 1.55]], 7).scale(1, 0.72, 1), coat, (q) => 0.7 + 0.3 * sstep(0.7, 1.3, q[2])).mat(MAT.CLOTH));
  g.add(aoColor(Geo.sphere(0.11, 6, 5).scale(0.95, 1, 1.08).translate(0, 0.02, 1.67), '#e2b89c', () => 1).mat(MAT.SKIN));
  g.add(aoColor(Geo.lathe([[0.125, 0], [0.11, 0.12], [0.02, 0.2]], 6).translate(0, 0.0, 1.69), rand.pick(['#c0392b', '#f4f6f7', '#1f618d', '#f1c40f', '#7d3c98']), () => 1).mat(MAT.CLOTH));
  g.add(aoColor(Geo.torus(0.12, 0.045, 6, 3).scale(1, 0.85, 1).translate(0, 0.01, 1.53), rand.pick(['#e74c3c', '#f39c12', '#27ae60', '#ecf0f1']), () => 1).mat(MAT.CLOTH));
  // legs mid-stride, arms swinging
  for (const [s, f] of [[-1, 1], [1, -1]]) {
    g.add(aoColor(Geo.tube([[s * 0.1, 0, 0.8], [s * 0.11, f * 0.12, 0.45], [s * 0.11, f * 0.25, 0.1]], (u) => 0.085 - 0.025 * u, 5, { caps: false }), pants, () => 0.85).mat(MAT.CLOTH));
    g.add(aoColor(Geo.box(0.13, 0.27, 0.11).translate(s * 0.11, f * 0.25 + 0.06, 0.055), '#2b1d14', () => 0.8).mat(MAT.CLOTH));
    g.add(aoColor(Geo.tube([[s * 0.25, 0, 1.42], [s * 0.29, -f * 0.1, 1.15], [s * 0.28, -f * 0.2, 0.93]], (u) => 0.065 - 0.015 * u, 5, { caps: false }), coat, () => 0.85).mat(MAT.CLOTH));
  }
  if (extra === 1) {
    // skis over the shoulder
    g.add(aoColor(Geo.box(0.16, 1.75, 0.04).transform(m4.mul(m4.translation(0.22, -0.1, 1.5), m4.rotationX(0.5))), '#c0392b', () => 1).gloss(0.5).mat(MAT.METAL));
  } else if (extra === 2) {
    // pulling a sledge
    g.add(aoColor(cbox(0.42, 0.95, 0.07, 0.02).translate(0, -1.9, 0.22), '#8e5a32', () => 0.9).mat(MAT.WOOD));
    for (const s of [-0.18, 0.18]) g.add(aoColor(Geo.tube([[s, -2.4, 0.03], [s, -1.45, 0.03], [s, -1.3, 0.14]], 0.02, 4), '#3b3b3b', () => 1).mat(MAT.METAL));
    g.add(aoColor(Geo.box(0.02, 1.2, 0.02).transform(m4.mul(m4.translation(0.18, -0.85, 0.55), m4.rotationX(-0.45))), '#d0d3d4', () => 1).mat(MAT.METAL));
  }
  return g;
}

function walkers(b) {
  const rand = rng(71);
  const L = PATH.length;
  for (let k = 0; k < 3; k++) {
    const up = k % 2 === 0;
    const v = 1.2 + 0.2 * rand();
    const dur = L / v, t0 = k * 13.7;
    const geo = walkerGeo(rand, k % 3);
    const pos = (t) => {
      const dd = Math.min(L, Math.max(0, up ? (t - t0) * v : L - (t - t0) * v));
      const q = PATH.smoothAt(dd, 4);
      const side = up ? 0.6 : -0.6;
      const x = q.p[0] + q.dir[1] * side, y = q.p[1] - q.dir[0] * side;
      return { p: [x, y, ground(x, y) + 0.03], dir: up ? q.dir : [-q.dir[0], -q.dir[1], 0] };
    };
    const tf = (t) => { const { p, dir } = pos(t); return m4.facing(p, [dir[0], dir[1], 0]); };
    const times = adaptiveTimes(tf, t0, t0 + dur, { tolerance: 0.1, size: 0.5, maxStep: 25 });
    b.dynamic(geo, { times, transform: tf });
  }
}

// ---------------------------------------------------------------------------
// split-rail fences along the first stretch of the path, and benches

function fences(b) {
  const solid = new Geo(), snow = new Geo();
  const wood = '#5b3d28';
  for (const side of [-1, 1]) {
    let prev = null;
    for (let d = 2; d < 150; d += 2.6) {
      if ((d % 52) > 34) { prev = null; continue; }
      const q = PATH.smoothAt(d, 4);
      const off = side * (PATH_HALF + 2.9);
      const x = q.p[0] + q.dir[1] * off, y = q.p[1] - q.dir[0] * off;
      let skip = false;
      for (const [cx, cy, r] of CLEAR) if (Math.hypot(x - cx, y - cy) < r * 0.75) skip = true;
      if (skip) { prev = null; continue; }
      const z = ground(x, y);
      solid.add(aoColor(cbox(0.13, 0.13, 1.25, 0.025).translate(x, y, z + 0.5), wood, (p) => 0.55 + 0.45 * sstep(z, z + 0.8, p[2])).mat(MAT.WOOD));
      snow.add(snowData(cbox(0.17, 0.17, 0.09, 0.04).translate(x, y, z + 1.15)));
      if (prev) {
        const [px, py, pz] = prev;
        const len = Math.hypot(x - px, y - py), mx = (x + px) / 2, my = (y + py) / 2, mz = (z + pz) / 2;
        const ang = Math.atan2(y - py, x - px);
        for (const h of [0.5, 0.95]) {
          solid.add(aoColor(Geo.box(len + 0.1, 0.07, 0.11).transform(m4.mul(m4.translation(mx, my, mz + h), m4.rotationZ(ang))), wood, () => 0.85).mat(MAT.WOOD));
        }
        snow.add(snowData(cbox(len, 0.12, 0.08, 0.035).transform(m4.mul(m4.translation(mx, my, mz + 1.03), m4.rotationZ(ang)))));
      }
      prev = [x, y, z];
    }
  }
  b.static(solid);
  b.static(snow, { solid: false });
}

function bench(b, x, y, facing) {
  const z = ground(x, y);
  const g = new Geo();
  const wood = '#6e4a2e';
  g.add(aoColor(cbox(1.8, 0.45, 0.06, 0.015).translate(0, 0, 0.45), wood, () => 0.9));
  g.add(aoColor(cbox(1.8, 0.05, 0.42, 0.015).transform(m4.mul(m4.translation(0, -0.22, 0.72), m4.rotationX(-0.2))), wood, () => 0.9));
  for (const sx of [-0.75, 0.75]) {
    g.add(aoColor(Geo.box(0.07, 0.4, 0.45).translate(sx, 0, 0.22), '#2d2d2d', () => 0.7));
    g.add(aoColor(Geo.box(0.07, 0.06, 0.5).translate(sx, -0.22, 0.7), '#2d2d2d', () => 0.8));
  }
  g.mat(MAT.WOOD);
  g.add(snowData(rbox(1.7, 0.4, 0.1, 0.05, 1).translate(0, 0.01, 0.51)));
  g.add(snowData(cbox(1.75, 0.08, 0.06, 0.03).translate(0, -0.27, 0.95)));
  g.add(drift(2.6, 1.6, 0.25));
  b.static(g, { transform: m4.mul(m4.translation(x, y, z), m4.rotationZ(facing)) });
  stampAO(x, y, 1.2, 0.3);
}

// Tree positions: a jittered grid over the forest, finer near the path.
function placeTrees() {
  const rand = rng(77);
  const out = [];
  const tryAt = (x, y, keep) => {
    const d = forestDensity(x, y);
    if (rand() > d * keep) return;
    for (const [cx, cy, r] of CLEAR) if (Math.hypot(x - cx, y - cy) < r) return;
    const pd = pathDist(x, y);
    if (pd < 7) return;
    const lod = pd < 50 ? 0 : pd < 150 ? 1 : pd < 480 ? 2 : 3;
    if (lod === 3 && rand() > 0.62) return;
    const h = (lod === 0 ? 13 : 11) + rand() * (lod === 0 ? 13 : 10);
    out.push({ x, y, h, lod, rot: rand() * TAU, proto: Math.floor(rand() * 6), lean: (rand() - 0.5) * 0.04 });
  };
  for (let gy = -1000; gy < 1900; gy += 13) {
    for (let gx = -1150; gx < 1150; gx += 13) {
      const x = gx + rand() * 13, y = gy + rand() * 13;
      if (Math.abs(x) < 220 && y > -200 && y < 700) continue;
      tryAt(x, y, 0.95);
    }
  }
  // the valley floor round the hamlet: scattered trees and small groups
  for (let gy = -200; gy < 700; gy += 6) {
    for (let gx = -220; gx < 220; gx += 6) {
      tryAt(gx + rand() * 6, gy + rand() * 6, 0.8);
    }
  }
  // a few big spruces framing the path near the start
  for (const [x, y, h] of [[-17, -58, 24], [-24, -40, 19], [21, -70, 22], [26, -28, 18], [-12, 18, 15], [19, 92, 17], [-52, 140, 21], [16, 252, 20]]) {
    out.push({ x, y, h, lod: 0, rot: x * 0.37 + y, proto: (Math.abs(x + y) | 0) % 6, lean: 0 });
  }
  for (const t of out) stampAO(t.x, t.y, t.h * 0.22, 0.32);
  return out;
}

function addTrees(b, trees) {
  const protos = [0, 1, 2, 3].map((lod) => Array.from({ length: 6 }, (_, i) => (lod < 2 ? spruceNear(100 + lod * 10 + i, lod === 0) : spruce(100 + lod * 10 + i, lod))));
  // every tree is a copy of one of these few: placed, turned and scaled
  const places = protos.map((list) => list.map(() => []));
  for (const t of trees) {
    const z = ground(t.x, t.y);
    places[t.lod][t.proto].push(m4.mul(m4.translation(t.x, t.y, z - 0.05 * t.h * 0.1), m4.rotationX(t.lean), m4.rotationZ(t.rot), m4.scaling(t.h)));
  }
  protos.forEach((list, lod) => list.forEach((p, i) => {
    if (!places[lod][i].length) return;
    b.instances(p.foliage, places[lod][i], { solid: false });
    if (p.trunk) b.instances(p.trunk, places[lod][i]);
  }));
}

// ---------------------------------------------------------------------------
// shader

const f = (v) => {
  const s = Number(v).toFixed(6).replace(/0+$/, '');
  return s.endsWith('.') ? s + '0' : s;
};

const wgsl = /* wgsl */ `
const DAYLEN = ${f(DAY)};
const PH0 = ${f(PH0)};
const PHS = ${f(PHS)};
const WARPK = ${f(24 * WARP / (4 * Math.PI))};
const SLAT = ${f(Math.sin(LAT))};
const CLAT = ${f(Math.cos(LAT))};
const DEC_SUN = ${f(DEC_SUN)};
const DEC_MOON = ${f(DEC_MOON)};
const NORTH = vec2f(${f(-Math.sin(ROT))}, ${f(Math.cos(ROT))});
const EAST = vec2f(${f(Math.cos(ROT))}, ${f(Math.sin(ROT))});
const ZLAKE = ${f(ZLAKE)};

fn lin(c: vec3f) -> vec3f { return srgbToLinear(c); }
fn sstep(a: f32, b: f32, x: f32) -> f32 { return smoothstep(a, b, x); }

// ---- the sky's clock
fn hourOf(t: f32) -> f32 {
  let ph = fract(t / DAYLEN + PH0);
  return 24.0 * ph + WARPK * sin(2.0 * TAU * (ph - PHS));
}
fn celestial(H: f32, dec: f32) -> vec3f {
  let e = -cos(dec) * sin(H);
  let n = sin(dec) * CLAT - cos(dec) * cos(H) * SLAT;
  let u = sin(dec) * SLAT + cos(dec) * cos(H) * CLAT;
  return vec3f(e * EAST.x + n * NORTH.x, e * EAST.y + n * NORTH.y, u);
}
fn sunVec(t: f32) -> vec3f { return celestial((hourOf(t) - 12.0) * (PI / 12.0), DEC_SUN); }
fn moonVec(t: f32) -> vec3f { return celestial((hourOf(t) - 12.0) * (PI / 12.0) + PI + 0.3, DEC_MOON); }
// 0 at night .. 1 in daylight
fn daylight(t: f32) -> f32 { return smoothstep(-0.12, 0.10, sunVec(t).z); }
fn nightOf(t: f32) -> f32 { return 1.0 - smoothstep(-0.10, 0.02, sunVec(t).z); }

// sunlight through the air: reddens and dims towards the horizon
fn sunTrans(u: f32) -> vec3f {
  let h = max(asin(clamp(u, -1.0, 1.0)) * 57.2958, 0.0);
  let m = 1.0 / (max(u, 0.0) + 0.15 * pow(h + 3.885, -1.253));
  return exp(-vec3f(0.040, 0.098, 0.23) * m);
}

// ---- the ridges' shadow.  Each ridge is a curtain standing on its crest
// line; a point is shaded when the ray towards the light passes under it.
fn crestW(y: f32) -> vec2f {
  let s = sstep(400.0, -1200.0, y); let nth = sstep(1200.0, 2600.0, y);
  return vec2f(-860.0 - 620.0 * s + 40.0 * sin(y / 310.0 + 0.7) + 22.0 * sin(y / 133.0 + 2.0),
    560.0 - 470.0 * s + 300.0 * nth + 70.0 * sin(y / 420.0 + 1.3) + 36.0 * sin(y / 161.0 + 0.2) + 16.0 * sin(y / 71.0 + 1.1));
}
fn crestE(y: f32) -> vec2f {
  let s = sstep(300.0, -2400.0, y); let nth = sstep(1200.0, 2600.0, y);
  return vec2f(900.0 + 420.0 * s + 48.0 * sin(y / 350.0 + 2.2) + 20.0 * sin(y / 120.0 + 0.5),
    590.0 - 330.0 * s + 280.0 * nth + 80.0 * sin(y / 380.0 + 2.6) + 38.0 * sin(y / 170.0 + 1.0) + 15.0 * sin(y / 63.0 + 2.4));
}
fn ridgeShade(p: vec3f, L: vec3f) -> f32 {
  let hl = length(L.xy);
  if (hl < 1e-4 || L.z <= -0.02) { return 1.0; }
  let d = L.xy / hl;
  let tn = L.z / hl;
  var c: vec2f;
  var u = 0.0;
  if (d.x < 0.0) {
    u = (crestW(p.y).x - p.x) / d.x;
    u = (crestW(p.y + d.y * max(u, 0.0)).x - p.x) / d.x;
    u = (crestW(p.y + d.y * max(u, 0.0)).x - p.x) / d.x;
    c = crestW(p.y + d.y * max(u, 0.0));
  } else {
    u = (crestE(p.y).x - p.x) / d.x;
    u = (crestE(p.y + d.y * max(u, 0.0)).x - p.x) / d.x;
    u = (crestE(p.y + d.y * max(u, 0.0)).x - p.x) / d.x;
    c = crestE(p.y + d.y * max(u, 0.0));
  }
  if (u <= 0.0) { return 1.0; }
  let above = p.z + u * tn - c.y;
  let pen = 4.0 + u * 0.012;
  return smoothstep(-pen, pen, above);
}

// ---- sky
struct SkyK { zen: vec3f, hor: vec3f, glow: vec3f, sun: vec3f };
fn skyK(S: vec3f) -> SkyK {
  var k: SkyK;
  let u = S.z;
  let day = smoothstep(-0.20, 0.30, u);
  let tw = exp(-abs(u + 0.02) * 9.0);           // strength of dusk colours
  k.zen = mix(vec3f(0.0011, 0.0017, 0.0045), vec3f(0.020, 0.062, 0.215), day);
  k.zen = mix(k.zen, vec3f(0.030, 0.042, 0.115), tw * 0.45 * (1.0 - day * 0.6));
  k.hor = mix(vec3f(0.0035, 0.0050, 0.0100), vec3f(0.26, 0.37, 0.52), day);
  k.hor = mix(k.hor, vec3f(0.20, 0.17, 0.20), tw * 0.5);
  k.glow = vec3f(1.0, 0.36, 0.10) * tw * smoothstep(-0.22, -0.02, u);
  k.sun = sunTrans(u) * smoothstep(-0.02, 0.012, u);
  return k;
}
fn skyCol(dir: vec3f, t: f32, discs: f32, stars: f32) -> vec3f {
  let S = sunVec(t);
  let k = skyK(S);
  let up = max(dir.z, 0.0);
  var c = mix(k.hor, k.zen, pow(up, 0.42));
  let hd = normalize(vec3f(dir.xy, 0.0) + vec3f(1e-5, 0.0, 0.0));
  let hs = normalize(vec3f(S.xy, 0.0) + vec3f(1e-5, 0.0, 0.0));
  let toward = dot(hd, hs) * 0.5 + 0.5;
  let sd = dot(dir, S);
  // dusk: a warm band low towards the sun, and in the opposite sky the pink
  // belt above the blue shadow of the earth
  let low = exp(-up * 5.0);
  c += k.glow * low * (0.12 + 0.88 * toward * toward * toward);
  let tw = exp(-abs(S.z + 0.02) * 9.0);
  let anti = (1.0 - toward) * tw;
  c += vec3f(0.30, 0.15, 0.20) * anti * exp(-pow((up - 0.11) / 0.08, 2.0)) * smoothstep(-0.16, -0.01, S.z);
  c = mix(c, vec3f(0.030, 0.042, 0.085) * smoothstep(-0.25, 0.0, S.z), anti * exp(-up * 16.0) * smoothstep(-0.12, -0.02, S.z) * (1.0 - smoothstep(-0.02, 0.06, S.z)) * 0.75);
  // glare round the sun
  let sdp = max(sd, 0.0);
  c += k.sun * (vec3f(1.0, 0.8, 0.55) * (pow(sdp, 6.0) * 0.16 + pow(sdp, 48.0) * 0.4) + vec3f(1.0, 0.9, 0.75) * pow(sdp, 900.0) * 3.0);
  // sun disc
  c += k.sun * vec3f(1.0, 0.92, 0.8) * (70.0 * smoothstep(0.99985, 0.99993, sd) * discs);
  // night: moon and stars, turning round the pole
  let night = 1.0 - smoothstep(-0.16, 0.02, S.z);
  if (night > 0.0 && dir.z > -0.02) {
    let M = moonVec(t);
    let md = dot(dir, M);
    c += vec3f(0.75, 0.82, 1.0) * (4.0 * smoothstep(0.99990, 0.99995, md) * discs + 0.05 * pow(max(md, 0.0), 40.0) + 0.012 * pow(max(md, 0.0), 6.0)) * night * smoothstep(-0.05, 0.05, M.z);
    if (stars > 0.0) {
      // into the frame of the turning sky
      let H = (hourOf(t) - 12.0) * (PI / 12.0);
      let e = dot(dir.xy, EAST); let n = dot(dir.xy, NORTH); let zz = dir.z;
      // rotate about the celestial pole (in the north, LAT above the horizon)
      let px = n * SLAT - zz * CLAT; let pz = n * CLAT + zz * SLAT;
      let ca = cos(H); let sa = sin(H);
      let q = vec3f(e * ca - px * sa, e * sa + px * ca, pz);
      let g = q * 120.0;
      let cell = floor(g);
      let hh = hash33(cell);
      let sp = length(fract(g) - 0.5 - (hh.yzx - 0.5) * 0.5);
      let star = step(0.972, hh.x) * smoothstep(0.30, 0.05, sp);
      let mw = exp(-pow(dot(q, normalize(vec3f(0.3, 0.8, 0.5))) / 0.22, 2.0)) * (0.6 + 0.8 * noise3(q * 9.0));
      c += (vec3f(0.85, 0.9, 1.0) * star * (0.4 + 2.6 * hh.z * hh.z) + vec3f(0.008, 0.010, 0.016) * mw) * night * stars * smoothstep(-0.02, 0.15, dir.z);
    }
  }
  // thin high clouds, drifting
  if (dir.z > 0.01) {
    let pc = dir.xy / (dir.z + 0.08) * 1.3 + vec2f(t * 0.0045, -t * 0.0018);
    let cl = noise2(pc * vec2f(0.9, 2.6) + vec2f(0.0, 3.0)) * 0.65 + noise2(pc * 3.7 + 7.1) * 0.35;
    let cov = smoothstep(0.56, 0.86, cl) * smoothstep(0.01, 0.2, dir.z) * 0.6;
    let lit = k.sun * 0.9 * (0.45 + 0.55 * pow(sdp, 3.0)) + k.glow * 1.3 * smoothstep(-0.16, 0.0, S.z) + k.zen * 1.6 + k.hor * 0.35;
    c = mix(c, lit, cov);
  }
  // below the horizon (seen from high up): the haze
  if (dir.z < 0.0) { c = mix(c, k.hor * 0.8, smoothstep(0.0, -0.2, dir.z)); }
  return c;
}

fn envSky(dir: vec3f, t: f32) -> vec3f { return skyCol(dir, t, 1.0, 1.0); }
fn envReflect(dir: vec3f, t: f32, lit: f32) -> vec3f { return skyCol(dir, t, lit, 0.0); }

fn envSun(t: f32) -> Light {
  let S = sunVec(t);
  if (S.z > -0.03) {
    return Light(S, vec3f(1.95, 1.95, 1.95) * sunTrans(S.z) * smoothstep(-0.03, 0.015, S.z));
  }
  let M = moonVec(t);
  return Light(M, vec3f(0.050, 0.068, 0.11) * smoothstep(-0.03, -0.12, S.z) * smoothstep(-0.05, 0.1, M.z));
}

fn envAmbient(n: vec3f, t: f32) -> vec3f {
  let S = sunVec(t);
  let k = skyK(S);
  let sky = k.zen * 0.85 + k.hor * 0.22;
  // snow throws a lot of light back up
  let bounce = k.sun * (1.9 * max(S.z, 0.0) * 0.45) + sky * 0.45;
  var a = mix(bounce, sky, n.z * 0.5 + 0.5);
  // the glowing horizon at dusk lights what faces it
  let hs = normalize(vec3f(S.xy, 0.0) + vec3f(1e-5, 0.0, 0.0));
  a += k.glow * 0.07 * max(dot(n, hs) * 0.7 + 0.3, 0.0);
  // a little moonlit sky at night
  a += vec3f(0.003, 0.0045, 0.009) * nightOf(t);
  return a;
}

fn envFog(dir: vec3f, t: f32, dist: f32) -> vec4f {
  let S = sunVec(t);
  let k = skyK(S);
  let hd = normalize(vec3f(dir.xy, 0.0) + vec3f(1e-5, 0.0, 0.0));
  let hs = normalize(vec3f(S.xy, 0.0) + vec3f(1e-5, 0.0, 0.0));
  let toward = dot(hd, hs) * 0.5 + 0.5;
  var c = k.hor * 0.9 + k.zen * 0.25 + k.glow * 0.30 * toward * toward + k.sun * 0.30 * pow(max(dot(dir, S), 0.0), 6.0);
  // thicker low down: the haze thins with height
  let z0 = max(G.P.z, 0.0) / 900.0;
  let dz = dir.z * dist / 900.0;
  var hf = exp(-z0);
  if (abs(dz) > 0.01) { hf = (exp(-z0) - exp(-max(z0 + dz, 0.0))) / dz; }
  return vec4f(c, 1.0 - exp(-dist * 0.00022 * max(hf, 0.15)));
}

// ---- materials

// gradient of a noise field in 2D, by differences (for bending normals)
fn ngrad(p: vec2f, e: f32) -> vec2f {
  let c = noise2(p);
  return vec2f(noise2(p + vec2f(e, 0.0)) - c, noise2(p + vec2f(0.0, e)) - c) / e;
}

// snow: albedo, bent normal, sparkle; pf is the size of a pixel in metres
fn snowSurf(sIn: Surface, pf: f32, ao: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  // large variation: wind-packed and powder patches
  let m = noise2(p.xy * 0.045);
  s.color = vec3f(0.84, 0.87, 0.92) * (0.93 + 0.09 * m) * ao;
  // wind ripples (elongated) and fine grain, faded out with distance
  let fr = 1.0 - smoothstep(0.08, 0.5, pf);
  let ff = 1.0 - smoothstep(0.01, 0.06, pf);
  var bend = vec2f(0.0);
  if (fr > 0.0) {
    let q = vec2f(p.x * 0.80 + p.y * 0.60, -p.x * 0.60 + p.y * 0.80);
    let g = ngrad(q * vec2f(0.35, 1.6), 0.15) * vec2f(0.35, 1.6);
    bend += vec2f(g.x * 0.80 - g.y * 0.60, g.x * 0.60 + g.y * 0.80) * 0.10 * fr;
  }
  if (ff > 0.0) {
    bend += (ngrad(p.xy * 5.0, 0.2) * 5.0) * 0.012 * ff;
  }
  s.n = normalize(s.n - vec3f(bend, 0.0) * s.n.z);
  s.gloss = 0.22;
  // sparkle: a few tiny ice crystals turned just right towards the light
  if (ff > 0.0) {
    let cs = 0.045;
    let g = p / cs;
    let cell = floor(g);
    let h = hash33(cell);
    let L = sunVec(s.t);
    let Ld = select(moonVec(s.t), L, L.z > -0.03);
    if (h.x > 0.87) {
      let r = length(fract(g) - 0.5 - (h.yzx - 0.5) * 0.4);
      let dot_ = smoothstep(0.22, 0.10, r) * ff;
      let hv = normalize(Ld - s.view);
      let facet = normalize(hv + (hash33(cell + 17.0) - 0.5) * 0.10);
      s.n = normalize(mix(s.n, facet, dot_));
      s.gloss = mix(s.gloss, 0.97, dot_);
    }
  }
  return s;
}

// rock: dark, blocky, streaked down the face, with snow caught on ledges
// close by.  The pattern is laid on world-aligned planes (y-z or x-z, blended
// by the normal), never on a frame taken from the normal itself: far from the
// origin that would jump at every crease of the mesh.  Detail is faded out by
// scale (d2: features of metres, d3: decimetres) so that it never shimmers.
struct RockP { col: vec3f, g: vec2f, snow: f32 };
fn rockPat(uv: vec2f, p: vec3f, pf: f32, d2: f32, d3: f32) -> RockP {
  var r: RockP;
  let patchN = noise2(uv * 0.03);
  let streak = noise2(uv * vec2f(0.12, 0.015));
  var tone = 0.45 * patchN + 0.35 * streak + 0.2 * mix(0.5, noise2(uv * 0.35), d2);
  let strata = hash11(floor((dot(p, vec3f(0.28, -0.2, 0.94)) + noise2(uv * 0.02) * 8.0) / 2.6) + 0.5);
  tone = mix(tone, tone * 0.8 + strata * 0.2, d2);
  var col = mix(vec3f(0.040, 0.040, 0.042), vec3f(0.16, 0.152, 0.145), tone);
  col *= mix(vec3f(1.0), vec3f(1.12, 0.98, 0.84), smoothstep(0.6, 0.9, noise2(uv * 0.018 + 4.0)));
  let crack = (1.0 - smoothstep(0.0, 0.04 + pf * 0.15, abs(noise2(uv * vec2f(0.30, 0.11)) - 0.5))) * d2;
  col *= 1.0 - 0.45 * crack;
  col *= mix(1.0, 0.8 + 0.4 * noise2(uv * 3.0), d3);
  r.col = col;
  r.g = ngrad(uv * vec2f(0.20, 0.32), 0.1) * vec2f(0.20, 0.32) * 2.6 * mix(0.35, 1.0, d2);
  if (d3 > 0.0) { r.g += ngrad(uv * 1.3 + 3.0, 0.1) * 1.3 * 0.35 * d3; }
  r.snow = (noise2(uv * vec2f(0.09, 0.012) + 11.0) - 0.5) * 0.5 + (noise2(uv * vec2f(0.5, 0.25) + 5.0) - 0.5) * 0.35;
  return r;
}
fn rockSurf(sIn: Surface, pf: f32, ao: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  let n = normalize(s.n);
  let d2 = 1.0 - smoothstep(0.3, 1.4, pf);
  let d3 = 1.0 - smoothstep(0.04, 0.22, pf);
  let ax = abs(n.x); let ay = abs(n.y);
  let w = smoothstep(0.3, 0.7, ay / max(ax + ay, 1e-4));
  var r: RockP;
  if (w < 0.999) { r = rockPat(vec2f(p.y * sign(n.x + 1e-6), p.z), p, pf, d2, d3); }
  if (w > 0.001) {
    let r2 = rockPat(vec2f(-p.x * sign(n.y + 1e-6), p.z), p, pf, d2, d3);
    if (w >= 0.999) { r = r2; } else {
      r.col = mix(r.col, r2.col, w); r.g = mix(r.g, r2.g, w); r.snow = mix(r.snow, r2.snow, w);
    }
  }
  // bend the normal: across the face and up it
  var t1 = cross(vec3f(0.0, 0.0, 1.0), n);
  if (dot(t1, t1) < 1e-4) { t1 = vec3f(1.0, 0.0, 0.0); }
  t1 = normalize(t1);
  let t2 = cross(n, t1);
  let rn = normalize(n + (t1 * r.g.x + t2 * r.g.y) * 0.8);
  let ledge = smoothstep(0.60, 0.66, rn.z + r.snow) * d2;
  s.color = mix(r.col, vec3f(0.80, 0.85, 0.92), ledge) * ao;
  s.n = normalize(mix(rn, n, ledge * 0.6));
  s.gloss = mix(0.12, 0.22, ledge);
  return s;
}

fn terrainSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  let ao = s.color.r;
  let gch = s.color.g;
  let rocky = s.color.b;
  let n0 = normalize(s.n);
  let steep = 1.0 - n0.z;
  let m1 = noise2(p.xy * 0.011);
  // rock ribs and snow-filled couloirs running down the steep faces (on
  // world-aligned planes, blended by the normal: see rockSurf)
  let wr = smoothstep(0.3, 0.7, abs(n0.y) / max(abs(n0.x) + abs(n0.y), 1e-4));
  let fine = 1.0 - smoothstep(1.0, 3.0, pf);
  var rib = 0.0;
  if (wr < 0.999) { rib += (1.0 - wr) * (noise2(vec2f(p.y / 34.0, p.z / 190.0)) * 0.65 + noise2(vec2f(p.y / 12.0, p.z / 70.0) + 7.0) * 0.35 * fine); }
  if (wr > 0.001) { rib += wr * (noise2(vec2f(p.x / 34.0, p.z / 190.0) + 3.0) * 0.65 + noise2(vec2f(p.x / 12.0, p.z / 70.0) + 9.0) * 0.35 * fine); }
  let rockAmt = smoothstep(0.50, 0.56 + pf * 0.01, rocky + (rib - 0.5) * 0.55 + (m1 - 0.5) * 0.12 + (steep - 0.35) * 0.3);
  if (rockAmt < 0.999) {
    s = snowSurf(s, pf, ao);
  }
  if (rockAmt > 0.001) {
    let r = rockSurf(sIn, pf, ao);
    s.color = mix(s.color, r.color, rockAmt);
    s.n = normalize(mix(s.n, r.n, rockAmt));
    s.gloss = mix(s.gloss, r.gloss, rockAmt);
  }
  // the frozen lake
  if (abs(p.z - ZLAKE) < 0.02) {
    let q = p.xy - vec2f(${f(LAKE.x)}, ${f(LAKE.y)});
    let ca = ${f(Math.cos(LAKE.a))}; let sa = ${f(Math.sin(LAKE.a))};
    let lr = length(vec2f((q.x * ca + q.y * sa) / ${f(LAKE.rx)}, (-q.x * sa + q.y * ca) / ${f(LAKE.ry)}));
    if (lr < 1.0) {
      // dark clear ice with drifts of snow, and a swept rink in the middle
      let drift = smoothstep(0.55, 0.8, noise2(p.xy * 0.05) * 0.7 + noise2(p.xy * 0.22) * 0.3 + lr * 0.3);
      let rq = p.xy - vec2f(${f(RINK.x)}, ${f(RINK.y)});
      let rink = 1.0 - smoothstep(0.96, 1.0, length(vec2f((rq.x * ca + rq.y * sa) / ${f(RINK.rx)}, (-rq.x * sa + rq.y * ca) / ${f(RINK.ry)})));
      let ice = (1.0 - drift) * (1.0 - smoothstep(0.92, 1.0, lr));
      let iceA = max(ice, rink);
      let crack = (1.0 - smoothstep(0.0, 0.02 + pf * 0.3, abs(noise2(p.xy * 0.18) - 0.5))) * (1.0 - smoothstep(0.1, 0.8, pf));
      let iceCol = mix(vec3f(0.035, 0.065, 0.085), vec3f(0.11, 0.16, 0.19), noise2(p.xy * 0.4)) + crack * 0.25;
      s.color = mix(s.color, iceCol, iceA);
      s.gloss = mix(s.gloss, 0.92, iceA);
      s.n = normalize(mix(s.n, vec3f(0.0, 0.0, 1.0), iceA));
    }
  }
  // forest seen from afar: the canopy as a tone on the ground (the trees
  // themselves are sparser than a real forest)
  let forest = saturate((0.5 - gch) * 3.4) * smoothstep(70.0, 220.0, s.dist);
  // groomed pistes: smooth, a little brighter, with corduroy across the fall line
  let piste = saturate((gch - 0.5) * 2.0);
  if (piste > 0.001) {
    var fall = vec2f(n0.x, n0.y);
    fall = fall / max(length(fall), 1e-3);
    let cq = dot(p.xy, fall) * 0.0 + dot(p.xy, vec2f(-fall.y, fall.x)) / 0.07;
    let fc = 1.0 - smoothstep(0.004, 0.02, pf);
    let cord = (abs(fract(cq) - 0.5) * 2.0 - 0.5) * fc;
    s.n = normalize(mix(s.n, n0, piste * 0.7) + vec3f(-fall.y, fall.x, 0.0) * cord * 0.25 * piste);
    s.color = mix(s.color, s.color * (1.02 + 0.06 * cord), piste);
    s.gloss = mix(s.gloss, 0.3, piste);
  }
  if (forest > 0.001) {
    let cn = noise2(p.xy * 0.09) * 0.6 + noise2(p.xy * 0.4) * 0.4 * (1.0 - smoothstep(0.3, 1.5, pf));
    let canopy = mix(vec3f(0.022, 0.040, 0.026), vec3f(0.62, 0.67, 0.74), 0.24 + 0.32 * cn);
    s.color = mix(s.color, canopy * ao, forest * 0.85);
    s.gloss = mix(s.gloss, 0.1, forest);
  }
  s.sun *= ridgeShade(p, envSun(s.t).dir);
  return s;
}

// The feathered, ragged outline of a near spruce's fronds (uv.y >= 1): cut
// out where the frond is seen close up, in the picture and in its shadow.
fn cutout(s: Surface) -> f32 {
  let pf = length(fwidth(s.pos));
  if (s.mat == ${MAT.CHAPELWIN}u || s.mat == ${MAT.BELFRY}u) { return archCover(s.uv); }
  if (s.mat != ${MAT.NEEDLES}u || s.uv.y < 1.0 || pf > 0.06) { return 1.0; }
  let along = s.uv.y - 1.0;
  let across = s.uv.x;
  let q = along * 11.0 - abs(across) * 1.6;
  let twig = abs(fract(q) - 0.5) * 2.0;
  let edge = abs(across) - 0.5 - 0.45 * (1.0 - twig) - 0.1 * hash11(floor(q) + 0.5);
  let tip = along - (0.97 - 0.06 * twig);
  return saturate(0.5 - 6.0 * max(edge, tip * 3.0));
}

// spruce needles, with snow lying on whatever faces up
fn needleSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let ao = s.color.r; let tint = s.color.g; let snowK = s.color.b;
  let p = s.pos;
  var col = mix(vec3f(0.030, 0.058, 0.034), vec3f(0.055, 0.082, 0.040), tint);
  let fd = 1.0 - smoothstep(0.015, 0.09, pf);
  // the branches of near trees (uv.y >= 1): herringbone twigs, and a
  // feathered, ragged outline cut out where the frond is seen close up
  if (s.uv.y >= 1.0) {
    let along = s.uv.y - 1.0;
    let across = s.uv.x;
    let q = along * 11.0 - abs(across) * 1.6;
    let twig = abs(fract(q) - 0.5) * 2.0;
    col *= mix(1.0, 0.55 + 0.6 * smoothstep(0.2, 0.8, twig), fd);
    s.n = normalize(s.n + vec3f(0.0, 0.0, (twig - 0.5) * 0.6 * fd));
  }
  if (fd > 0.0) {
    let nz = noise3(p * 11.0);
    col *= 0.55 + 0.9 * mix(0.5, nz, fd);
    let b = vec3f(noise3(p * 7.0), noise3(p * 7.0 + 5.3), noise3(p * 7.0 + 9.1)) - 0.5;
    s.n = normalize(s.n + b * 0.9 * fd);
  }
  let sn = noise3(p * 3.4 + 3.0) * 0.55 + noise3(p * 11.0) * 0.45 * fd + 0.225 * (1.0 - fd);
  var edgeK = 0.0;
  if (s.uv.y >= 1.0) { edgeK = smoothstep(0.25, 0.85, abs(s.uv.x)) * 0.32 + (s.uv.y - 1.0) * 0.12; }
  let snow = smoothstep(0.45, 0.62, s.n.z * 0.85 + (sn - 0.5) * 0.8 + snowK * 0.3 - 0.12 - edgeK);
  s.color = mix(col, vec3f(0.78, 0.83, 0.90) * (0.85 + 0.15 * sn), snow) * ao;
  s.gloss = mix(0.12, 0.22, snow);
  return s;
}

fn barkSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  let a = atan2(s.n.y, s.n.x);
  let q = vec2f(a * 2.0, p.z * 1.3);
  let fiss = noise2(q * vec2f(3.0, 0.6)) * 0.6 + noise2(q * vec2f(9.0, 2.0)) * 0.4;
  s.color = mix(vec3f(0.045, 0.028, 0.020), vec3f(0.13, 0.085, 0.060), fiss) * s.color.r;
  s.gloss = 0.08;
  return s;
}

// a horizontal direction along a wall with normal n
fn wallDir(n: vec3f) -> vec3f {
  var th = vec2f(-n.y, n.x);
  let l = length(th);
  if (l < 1e-3) { return vec3f(1.0, 0.0, 0.0); }
  return vec3f(th / l, 0.0);
}

// log walls: horizontal logs with a round profile and dark joints
fn logSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let ao = s.color.r; let tint = s.color.g;
  let p = s.pos;
  let n = normalize(s.n);
  let v = fract(p.z / 0.30 + 0.5);
  let fd = 1.0 - smoothstep(0.02, 0.10, pf);
  let along = dot(p, wallDir(n));
  let logId = floor(p.z / 0.30 + 0.5);
  let h = hash21(vec2f(logId, floor(along / 4.3)));
  var col = mix(vec3f(0.085, 0.046, 0.024), vec3f(0.19, 0.11, 0.058), tint * 0.5 + h * 0.5);
  let grain = noise2(vec2f(along * 0.8, p.z * 16.0)) * 0.6 + noise2(vec2f(along * 3.5, p.z * 45.0)) * 0.4;
  col *= mix(1.0, 0.65 + 0.7 * grain, fd);
  // silvered by the weather towards the bottom of each log
  col = mix(col, vec3f(0.16, 0.15, 0.14), smoothstep(0.5, 0.0, v) * 0.25 * fd);
  let joint = 1.0 - smoothstep(0.0, 0.05 + pf * 1.5, min(v, 1.0 - v));
  col *= 1.0 - joint * mix(0.35, 0.8, fd);
  if (abs(n.z) < 0.7) { s.n = normalize(n + vec3f(0.0, 0.0, (v - 0.5) * 1.4 * fd)); }
  s.color = col * ao;
  s.gloss = 0.10;
  return s;
}

// rubble stone with mortar joints
fn stoneSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let ao = s.color.r; let tint = s.color.g;
  let p = s.pos;
  let n = normalize(s.n);
  let th = wallDir(n);
  var q = vec2f(dot(p, th), p.z);
  if (abs(n.z) > 0.8) { q = p.xy; }
  // rows of uneven height, stones of uneven length, wobbly joints
  q = q * vec2f(2.3, 3.4) + vec2f(noise2(q * 1.3) - 0.5, noise2(q * 1.1 + 4.0) - 0.5) * 0.35;
  let fd = 1.0 - smoothstep(0.02, 0.10, pf);
  let row0 = floor(q.y);
  let rh = 0.55 + 0.9 * hash11(row0 * 3.7 + 0.2);
  let yy = q.y - row0;
  let row = row0 + step(rh * 0.5, yy) * 0.5;
  let qx = q.x * (0.7 + 0.6 * hash11(row * 5.1 + 0.3)) + hash11(row * 7.13 + 0.5) * 3.0;
  let w = 0.6 + 0.8 * hash11(floor(qx) * 1.7 + row);
  let cellx = floor(qx);
  let f = vec2f(fract(qx), select(fract(yy / max(rh * 0.5, 0.05)), fract((yy - rh * 0.5) / max(1.0 - rh * 0.5, 0.05)), yy > rh * 0.5));
  let e = min(min(f.x, 1.0 - f.x) * 0.7 * w, min(f.y, 1.0 - f.y)) + (noise2(q * 2.7) - 0.5) * 0.14;
  let mortar = 1.0 - smoothstep(0.02, 0.05 + pf * 4.0, e);
  let hs = hash21(vec2f(cellx, row) + tint * 13.0);
  var col = mix(vec3f(0.13, 0.12, 0.11), vec3f(0.34, 0.32, 0.29), hs);
  col *= mix(vec3f(1.0), vec3f(1.08, 1.0, 0.9), hash11(hs * 91.0));
  col *= mix(1.0, 0.8 + 0.4 * noise2(q * 6.0), fd);
  col = mix(col, vec3f(0.40, 0.385, 0.36), mortar * mix(0.6, 1.0, fd));
  if (abs(n.z) < 0.8) {
    s.n = normalize(n + (th * (f.x - 0.5) * 0.8 + vec3f(0.0, 0.0, (f.y - 0.5) * 0.9)) * fd * (1.0 - mortar));
  }
  s.color = col * ao;
  s.gloss = 0.08;
  return s;
}

// painted or bare wood (colour from the mesh), with grain
fn woodSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let fd = 1.0 - smoothstep(0.01, 0.06, pf);
  let g = noise3(s.pos * vec3f(3.0, 3.0, 9.0)) * 0.6 + noise3(s.pos * 14.0) * 0.4;
  s.color *= mix(1.0, 0.8 + 0.4 * g, fd);
  s.gloss = 0.12;
  return s;
}

fn shutterSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let fd = 1.0 - smoothstep(0.005, 0.03, pf);
  let v = fract(s.pos.z / 0.075);
  let edge = 1.0 - smoothstep(0.0, 0.18, min(v, 1.0 - v));
  s.color *= 1.0 - 0.45 * edge * fd;
  if (abs(s.n.z) < 0.7) { s.n = normalize(s.n + vec3f(0.0, 0.0, (0.5 - v) * 0.9 * fd)); }
  s.gloss = 0.25;
  return s;
}

// windows: dark glass mirroring the sky, lit one by one after dusk (the
// window's number: the copy's own for the chalets', the colour's g otherwise)
fn glassSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let id = s.color.g + s.inst.w;
  let night = nightOf(s.t);
  let th = 0.15 + 0.7 * fract(id * 7.31);
  let lit = smoothstep(th, th + 0.06, night) * step(0.18, fract(id * 3.7 + 0.2));
  let cur = smoothstep(0.30, 0.22, abs(s.uv.x - 0.5)) * 0.5 + 0.5;
  let warm = mix(vec3f(1.0, 0.55, 0.24), vec3f(1.0, 0.72, 0.42), fract(id * 13.1));
  s.color = mix(vec3f(0.012, 0.016, 0.020), warm * 0.5, lit);
  s.emissive = lit * mix(2.6, 1.4, cur);
  s.gloss = mix(0.88, 0.5, lit);
  return s;
}

// lamps: off by day, switched on in order at dusk, with a slight flicker
fn lanternOn(t: f32, k: f32) -> f32 {
  let th = 0.10 + 0.55 * k;
  return smoothstep(th, th + 0.05, nightOf(t));
}
fn lanternSurf(sIn: Surface) -> Surface {
  var s = sIn;
  var lev = 0.0;
  if (s.tag == 1u) {
    // a lantern on the path: its distance along it is the copy's number
    lev = lampLevel(s.inst.w, s.t, nightOf(s.t));
  } else {
    let k = s.color.g;
    lev = lanternOn(s.t, k) * (0.9 + 0.1 * sin(s.t * 11.0 + k * 40.0) * sin(s.t * 7.3 + k * 17.0));
  }
  s.color = vec3f(1.0, 0.62, 0.28);
  s.emissive = 0.12 + lev * 8.0;
  s.gloss = 0.6;
  return s;
}

fn woodpileSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let n = normalize(s.n);
  let fd = 1.0 - smoothstep(0.01, 0.05, pf);
  if (abs(n.z) < 0.7) {
    let th = wallDir(n);
    var q = vec2f(dot(s.pos, th), s.pos.z) / 0.17;
    let row = floor(q.y);
    q.x += 0.5 * (row - 2.0 * floor(row * 0.5));
    let f = fract(q) - 0.5;
    let r = length(f);
    let id = hash21(floor(q));
    let face = 1.0 - smoothstep(0.40, 0.46 + pf * 4.0, r);
    let rings = 0.85 + 0.15 * sin(r * 70.0 + id * 6.0) * fd;
    let endc = mix(vec3f(0.36, 0.24, 0.13), vec3f(0.52, 0.38, 0.22), id) * rings;
    s.color = mix(vec3f(0.03, 0.022, 0.016), endc, face) * s.color.r;
    s.n = normalize(n + vec3f(f * 0.0, 0.0));
  } else {
    s.color = vec3f(0.10, 0.07, 0.05) * s.color.r;
  }
  s.gloss = 0.08;
  return s;
}


// lime plaster: off-white, rough, with a damp darker foot
fn plasterSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let ao = s.color.r;
  let fd = 1.0 - smoothstep(0.01, 0.08, pf);
  let p = s.pos;
  let big = noise3(p * 0.6);
  var col = vec3f(0.70, 0.67, 0.60) * (0.92 + 0.1 * big);
  col *= mix(1.0, 0.85 + 0.3 * noise3(p * 9.0), fd);
  if (fd > 0.0) {
    let b = vec3f(noise3(p * 14.0), noise3(p * 14.0 + 3.7), noise3(p * 14.0 + 8.1)) - 0.5;
    s.n = normalize(s.n + b * 0.25 * fd);
  }
  s.color = col * ao;
  s.gloss = 0.06;
  return s;
}

// shingles: overlapping rows of small wooden tiles
fn shingleSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let fd = 1.0 - smoothstep(0.01, 0.06, pf);
  let q = vec2f(dot(s.pos, wallDir(s.n)), s.pos.z) / vec2f(0.16, 0.11);
  let row = floor(q.y);
  let qx = q.x + 0.5 * (row - 2.0 * floor(row * 0.5));
  let h = hash21(vec2f(floor(qx), row));
  let edge = smoothstep(0.75, 1.0, fract(q.y)) + (1.0 - smoothstep(0.0, 0.12, abs(fract(qx) - 0.5) * 2.0 - 0.88));
  s.color *= mix(1.0, (0.7 + 0.5 * h) * (1.0 - 0.4 * saturate(edge)), fd);
  s.gloss = 0.08;
  return s;
}

// verdigris copper: blue-green, streaked, still a little shiny
fn copperSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  let a = atan2(p.y - 0.0, p.x);
  let streak = noise2(vec2f(dot(p.xy, vec2f(0.7, 0.7)) * 6.0, p.z * 0.6)) * 0.6 + noise3(p * 3.0) * 0.4;
  s.color = mix(vec3f(0.07, 0.17, 0.14), vec3f(0.22, 0.42, 0.36), streak) * s.color.r;
  s.gloss = 0.55;
  return s;
}

// arched openings drawn on a flat panel: stained glass, or the dark belfry.
// The panel is a mesh with holes (cutout): a round arch on straight sides,
// with the corners above it cut away.  Returns a ramp across the outline.
fn archCover(uv: vec2f) -> f32 {
  let x = abs(uv.x - 0.5);
  var d = x - 0.5;
  if (uv.y > 0.78) { d = length(vec2f(x, (uv.y - 0.78) * 2.6)) - 0.5; }
  return saturate(0.5 - d * 4.0);
}
fn chapelWinSurf(sIn: Surface, pf: f32, belfry: bool) -> Surface {
  var s = sIn;
  if (belfry) {
    s.color = vec3f(0.006, 0.006, 0.007);
    s.gloss = 0.0;
    return s;
  }
  // leaded glass in small diamonds, glowing in colour at night
  let q = s.uv * vec2f(6.0, 11.0);
  let d = abs(fract(vec2f(q.x + q.y, q.x - q.y) * 0.5) - 0.5);
  let lead = 1.0 - smoothstep(0.03, 0.07, min(d.x, d.y));
  let cell = floor(vec2f(q.x + q.y, q.x - q.y) * 0.5);
  let hue = hash21(cell);
  var gc = select(select(vec3f(0.9, 0.55, 0.15), vec3f(0.2, 0.35, 0.9), hue > 0.7), vec3f(0.85, 0.2, 0.12), hue < 0.25);
  gc = mix(gc, vec3f(1.0, 0.85, 0.5), 0.35);
  let lit = smoothstep(0.2, 0.5, nightOf(s.t));
  s.color = mix(vec3f(0.02, 0.022, 0.03), gc * 0.5, lit) * (1.0 - lead);
  s.emissive = lit * 2.2 * (1.0 - lead);
  s.gloss = 0.8 * (1.0 - lit);
  return s;
}

// the dials: hour and minute hands follow the time of day of the sky
fn clockSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let q = s.uv - 0.5;
  let r = length(q) * 2.0;
  let ang = atan2(q.x, q.y);
  let hr = hourOf(s.t);
  let hh = fract(hr / 12.0) * TAU;
  let mm = fract(hr) * TAU;
  let aa = max(pf * 1.5, 0.004);
  let tick = (1.0 - smoothstep(0.045, 0.045 + aa * 3.0, abs(fract(ang / TAU * 12.0 + 0.5) - 0.5))) * step(0.72, r) * step(r, 0.88);
  let ring = 1.0 - smoothstep(0.0, aa * 2.0, abs(r - 0.93) - 0.03);
  let dh = vec2f(sin(hh), cos(hh)); let dm = vec2f(sin(mm), cos(mm));
  let hand1 = 1.0 - smoothstep(0.035, 0.035 + aa, sdSegment(q * 2.0, vec2f(0.0), dh * 0.5));
  let hand2 = 1.0 - smoothstep(0.022, 0.022 + aa, sdSegment(q * 2.0, vec2f(0.0), dm * 0.78));
  let face = vec3f(0.80, 0.78, 0.72);
  let ink = max(max(tick, ring), max(hand1, hand2));
  let glow = smoothstep(0.3, 0.7, nightOf(s.t));
  s.color = mix(face, vec3f(0.03, 0.025, 0.02), ink);
  s.emissive = glow * 1.3 * (1.0 - ink);
  s.gloss = 0.3;
  return s;
}

// the lift stations' timing boards: minutes and seconds of the moment seen
fn boardSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let on = clock7((s.uv - vec2f(0.07, 0.16)) / vec2f(0.86, 0.68), s.t);
  s.color = mix(vec3f(0.012, 0.012, 0.014), vec3f(1.0, 0.42, 0.07), on);
  s.emissive = on * 5.0;
  s.gloss = 0.5;
  return s;
}
fn clothSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let fd = 1.0 - smoothstep(0.004, 0.03, pf);
  s.color *= mix(1.0, 0.85 + 0.3 * noise3(s.pos * 40.0), fd);
  s.gloss = 0.18;
  return s;
}

// smoke: see-through puffs, lit by the sun and sky of their moment like
// everything else (so in the ridge's shadow they show grey against the
// snow and the sky), thin towards the outline and wispy
fn smokeSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let facing = abs(dot(s.n, s.view));
  let w = noise3(s.pos * 0.7 - vec3f(0.0, 0.0, s.t * 0.4));
  s.alpha = s.alpha * pow(facing, 1.5) * (0.5 + w);
  // light passes through a puff: wrap the sunlight round it, and let it
  // take in the sky from all round
  s.n = normalize(s.n + envSun(s.t).dir * 0.6);
  s.ambient = 1.5;
  s.color = vec3f(0.68, 0.71, 0.78);
  s.gloss = 0.0;
  return s;
}
// red beacons, blinking in turn (g = phase); the cabin lamp blinks too
fn beaconSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let ph = s.color.g;
  let on = step(fract(s.t / 1.6 + ph), 0.22);
  s.color = vec3f(1.0, 0.06, 0.03);
  s.emissive = 0.3 + on * 14.0;
  return s;
}
fn cabinWinSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  // window band with posts; lit from inside after dusk
  let post = 1.0 - smoothstep(0.04, 0.06, abs(fract(s.uv.x / 1.1) - 0.5) * 2.0 - 0.9);
  let night = smoothstep(0.15, 0.5, nightOf(s.t));
  s.color = mix(vec3f(0.015, 0.02, 0.025), vec3f(1.0, 0.85, 0.6) * 0.5, night);
  s.emissive = night * 2.0;
  s.gloss = 0.85;
  if (abs(s.n.z) > 0.6 || post > 0.5) { s.color = vec3f(0.30, 0.03, 0.02); s.emissive = 0.0; s.gloss = 0.5; }
  return s;
}

// ---- the lantern path
const NLAMP = ${LAMPS.length};
const LAMPS = array<vec4f, ${LAMPS.length}>(${LAMPS.map((l) => `vec4f(${f(l[0])}, ${f(l[1])}, ${f(l[2])}, ${f(l[3])})`).join(', ')});
const LAMP_BOX = vec4f(${f(Math.min(...LAMPS.map((l) => l[0])) - 25)}, ${f(Math.min(...LAMPS.map((l) => l[1])) - 25)}, ${f(Math.max(...LAMPS.map((l) => l[0])) + 25)}, ${f(Math.max(...LAMPS.map((l) => l[1])) + 25)});
const PATH_LEN = ${f(PATH.length)};

// how bright the lantern at a distance along the path is: switched on in a
// wave up the path at dusk, with a pulse of light running up it every 7 s
fn lampLevel(along: f32, t: f32, night: f32) -> f32 {
  let th = 0.10 + 0.55 * along / PATH_LEN;
  let on = smoothstep(th, th + 0.04, night);
  let ph = fract((t * 9.0 - along) / 63.0) - 0.5;
  let pulse = exp(-ph * ph * 160.0);
  let fl = 0.93 + 0.07 * sin(t * 13.0 + along) * sin(t * 7.7 + along * 0.37);
  return on * fl * (0.75 + 1.1 * pulse);
}
fn lampLight(p: vec3f, n: vec3f, t: f32) -> vec3f {
  if (p.x < LAMP_BOX.x || p.y < LAMP_BOX.y || p.x > LAMP_BOX.z || p.y > LAMP_BOX.w) { return vec3f(0.0); }
  let night = nightOf(t);
  if (night <= 0.08) { return vec3f(0.0); }
  var L = LAMPS;
  var acc = 0.0;
  for (var i = 0; i < NLAMP; i++) {
    let d = L[i].xyz - p;
    let dd = dot(d, d);
    if (dd > 576.0) { continue; }
    let lev = lampLevel(L[i].w, t, night);
    acc += lev * max(dot(n, d) * inverseSqrt(dd), 0.0) * 7.0 / (dd + 1.5) * (1.0 - smoothstep(300.0, 576.0, dd));
  }
  return vec3f(1.0, 0.58, 0.26) * acc;
}

// the trodden path: packed snow with footprints and sledge runners
fn pathSurf(sIn: Surface, pf: f32) -> Surface {
  var s = snowSurf(sIn, pf, 1.0);
  let u = s.uv.x; let v = s.uv.y;
  let inside = 1.0 - smoothstep(${f(PATH_HALF - 0.45)}, ${f(PATH_HALF - 0.05)}, abs(u));
  if (inside > 0.0) {
    let fd = 1.0 - smoothstep(0.01, 0.06, pf);
    var packed = vec3f(0.60, 0.62, 0.66) * (0.9 + 0.1 * noise2(vec2f(u, v) * 1.3));
    var dent = 0.0;
    var bend = vec2f(0.0);
    if (fd > 0.0) {
      // two walkers' tracks
      for (var w = 0; w < 2; w++) {
        let fw = f32(w);
        let st = 0.37 + 0.05 * fw;
        let q = v / st + fw * 0.37;
        let i = floor(q);
        let side = select(-1.0, 1.0, (i - 2.0 * floor(i * 0.5)) > 0.5);
        let hsh = hash21(vec2f(i, fw * 7.0));
        let c = vec2f(-0.45 + 0.9 * fw + side * 0.12 + (hsh - 0.5) * 0.08 + 0.25 * sin(v / 13.0 + fw * 2.0), (i + 0.5) * st);
        let dl = (vec2f(u, v) - c) / vec2f(0.07, 0.16);
        let r = length(dl);
        let k = (1.0 - smoothstep(0.7, 1.05, r)) * step(0.25, hsh);
        dent = max(dent, k);
        bend += dl * k * 0.35;
      }
      // sledge runners
      let sc = 0.35 * sin(v / 23.0) + 0.15 * sin(v / 7.0);
      let run = 1.0 - smoothstep(0.012, 0.03 + pf, abs(abs(u - sc) - 0.21));
      dent = max(dent, run * 0.7);
      dent *= fd;
    }
    packed *= 1.0 - 0.13 * dent;
    s.color = mix(s.color, packed, inside);
    s.n = normalize(s.n + vec3f(-bend * inside, 0.0));
    s.gloss = mix(s.gloss, 0.3, inside);
  }
  return s;
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  let pf = length(fwidth(s.pos));
  switch (s.mat) {
    case ${MAT.TERRAIN}u: { s = terrainSurf(s, pf); s.light += lampLight(s.pos, s.n, s.t); return s; }
    case ${MAT.NEEDLES}u: { s = needleSurf(s, pf); }
    case ${MAT.BARK}u: { s = barkSurf(s, pf); }
    case ${MAT.LOGS}u: { s = logSurf(s, pf); }
    case ${MAT.STONE}u: { s = stoneSurf(s, pf); }
    case ${MAT.WOOD}u: { s = woodSurf(s, pf); }
    case ${MAT.SHUTTER}u: { s = shutterSurf(s, pf); }
    case ${MAT.GLASS}u: { s = glassSurf(s, pf); }
    case ${MAT.LANTERN}u: { s = lanternSurf(s); }
    case ${MAT.WOODPILE}u: { s = woodpileSurf(s, pf); }
    case ${MAT.SNOWSLAB}u: { s = snowSurf(s, pf, s.color.r); }
    case ${MAT.PATH}u: { s = pathSurf(s, pf); }
    case ${MAT.PLASTER}u: { s = plasterSurf(s, pf); }
    case ${MAT.SHINGLE}u: { s = shingleSurf(s, pf); }
    case ${MAT.COPPER}u: { s = copperSurf(s, pf); }
    case ${MAT.CHAPELWIN}u: { s = chapelWinSurf(s, pf, false); }
    case ${MAT.BELFRY}u: { s = chapelWinSurf(s, pf, true); }
    case ${MAT.CLOCK}u: { s = clockSurf(s, pf); }
    case ${MAT.BOARD}u: { s = boardSurf(s, pf); }
    case ${MAT.CLOTH}u: { s = clothSurf(s, pf); }
    case ${MAT.SKIN}u: { s.gloss = 0.3; }
    case ${MAT.SMOKE}u: { s = smokeSurf(s); }
    case ${MAT.BEACON}u: { s = beaconSurf(s); }
    case ${MAT.CABINWIN}u: { s = cabinWinSurf(s, pf); }
    case ${MAT.CABIN}u: { s.gloss = 0.55; }
    case ${MAT.METAL}u: { s.gloss = 0.45; }
    default: {}
  }
  s.sun *= ridgeShade(s.pos, envSun(s.t).dir);
  s.light += lampLight(s.pos, s.n, s.t);
  return s;
}`;

// ---------------------------------------------------------------------------
// the scene

export default {
  id: 'valley',
  name: 'Winter Valley',
  blurb: 'An alpine valley from late afternoon into night: a lantern path, a frozen lake, a chairlift and skiers. The detailed scene, meant for desktop graphics cards.',
  C,
  mode: 'walk',
  modes: ['walk', 'fly', 'drive'],
  spawn: { pos: [0, -60, 0], t: 0, yaw: 0, pitch: 4 },
  period: P,
  viewDistance: 1200,
  skyDistance: 3000,
  exposure: 0.9,
  bloom: 0.3,
  shadowRadii: [40, 320],
  reflections: true,         // ice, windows and metal mirror the mountains, not just the sky
  shadowDepth: 2400,
  walkSpeed: 3,
  runSpeed: 8,
  ceiling: 2500,
  ground: (x, y) => ground(x, y),
  wgsl,

  build(b) {
    AO_STAMPS.length = 0;
    CHIMNEYS.length = 0;
    REP = newRepeats();
    const rand = rng(1907);
    for (const [x, y, rot, kind] of CHALETS) chalet(b, x, y, rot, kind, rand);
    chapel(b);
    chalet(b, LODGE.x, LODGE.y, LODGE.rot, 3, rand);
    addRepeats(b);
    chairlift(b);
    aerialTram(b);
    skaters(b);
    skiers(b);
    smoke(b);
    walkers(b);
    fences(b);
    bench(b, 64, 432, 2.3);
    bench(b, 103, 512, 1.6);
    bench(b, -8, 205, -1.5);
    b.static(pathRibbon());
    b.instances(lantern(), LAMPS.map(([x, y, z, along]) => ({ transform: m4.mul(m4.translation(x, y, z - 2.55 - 0.05), m4.rotationZ(along)), data: along })));
    for (const [x, y] of LAMPS) stampAO(x, y, 0.6, 0.25);
    const trees = placeTrees();
    for (const { geo, solid } of terrainMeshes()) b.static(geo, { solid });
    addTrees(b, trees);
  },
};
