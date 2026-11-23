// Coastal Circuit: a 3.6 km road circuit on a Mediterranean coast, explored by
// car.  Traffic laps it in both directions at 15, 30 and 45 m/s (half of C,
// C, and one and a half times C), a train runs beside the 1.2 km main
// straight, and everything along the straight keeps time: a gantry clock and
// start lights, timing boards every 50 m, chase lights in the wall and in a
// gallery.  Tilt the view along the straight and every board ahead shows an
// earlier time than the one before it; look back and they run ahead.
//
// Layout (x east, y north): the main straight runs north along x = 300 with the
// railway and the sea to its right.  The lap turns west at its north end,
// winds south through the hills (through a covered gallery), and comes back
// east along the south straight.  The scene repeats every PERIOD = LAP / 15 s,
// so every car does a whole number of laps per period.
//
// Detail for close inspection (on foot, or driving alongside) is mostly
// painted by the shader from uv, tags and the copies' numbers: the cars'
// wheels, glass, helmets, lights and racing numbers, the trains' windows,
// doors and wheels, shutters on the houses.  What stands out in 3D is added
// with `within`, so that it costs nothing from afar: mirrors, tyres and
// exhausts on the cars and coaches all round the lap, the trains' bogies, the
// balloons' ropes and burners, the yachts' rigging, the timing boards',
// gantry's and lamps' small parts, doors and chimneys, garden walls.

import { Geo } from '../geom.js';
import { m4, v3 } from '../math.js';
import { dayNightEnv } from '../env.js';
import { Path, adaptiveTimes, rng, smoothstep, lerp } from '../util.js';

// ------------------------------------------------------------------ constants

const C = 30;                 // m/s: at a tilt of 45 degrees, one second for every 30 m
const LAP_TARGET = 3600;      // metres per lap (3D)
const UNIT = 15;              // m/s for exactly one lap per period
const DAY = 480;              // seconds per day
const START_HOUR = 11.5;      // the spawn, at t = 30 s, is at 1 pm
const FOG = 0.0007;
const MAIN_Z = 6.6;           // the main straight is level at this height

const ROAD_LIFT = 0.1;        // ribbon height above the terrain it is draped on
const HALF_ROAD = 6;          // four 3 m lanes
const HALF_PAVED = 9;         // plus hard shoulders
const HALF_VERGE = 15;        // plus mown verges (still draped ribbon, lit by the lamps)
const FLAT = 33, BLEND = 80;  // the terrain is flat across the road out to FLAT, back to nature by BLEND
const TAU_W = 12;

const RAIL_X = 345, RAIL_Z = 4.2, RAIL_S = -1000, RAIL_N = 900, RAIL_GAUGE = 2.2;
const LAMP_SP = 40;
const GAL_SP = 8, GAL_N = 25, GAL_V = 60, GAL_CYCLE = 2, GAL_ON = 0.3;
const CHASE_V = 30, CHASE_SP = 90;
const BEAM_T = 12;            // lighthouse revolution, seconds
const S_LINE = 330;           // start/finish line, metres from the start of the straight

const MAT = {
  TERRAIN: 1, ROAD: 2, VERGE: 3, SEA: 4, DISPLAY: 5, LAMP: 6, BEAM: 7, CHASE: 8,
  HOUSE: 9, CAR_SIDE: 10, CAR_FRONT: 11, CAR_REAR: 12, CROWD: 13, BUS_SIDE: 14,
  TRAIN: 15, LANTERN: 16, BALLOON: 17, AD: 18, RAILBED: 19, CHECKER: 20, LATTICE: 21,
  CAR_SCREEN: 22, CAR_BACKGLASS: 23, CAR_TOP: 24, CAR_ROOF: 25, BUS_END: 26,
  TRAIN_CAB: 27, TRAIN_END: 28, BOGIE: 29, LOCO: 30, CONTAINER: 31,
  LADDER: 32, MARKER: 33, RAILING: 34, TYRES: 35, CONE: 36, FENCE: 37,
  BASKET: 38, FLAME: 39, GONDOLA: 40, HULL: 41, PLANKS: 42, ARMCO: 43, CHEVRON: 44, SAIL: 45, ROOF: 46, CAR_BONNET: 47,
};

// ------------------------------------------------------------------ noise

function hash2(i, j) {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash2(i, j), hash2(i + 1, j), u), lerp(hash2(i, j + 1), hash2(i + 1, j + 1), u), v);
}
function fbm(x, y) {
  let s = 0, a = 0.5, f = 1;
  for (let k = 0; k < 4; k++) { s += a * vnoise(x * f + k * 17.3, y * f - k * 9.1); f *= 2.03; a *= 0.5; }
  return s / 0.9375;
}

// ------------------------------------------------------------------ land

const gauss = (x, y, cx, cy, r) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (r * r));

// x of the shoreline as a function of y; two headlands bulge out to sea
function coastX(y) {
  const a = (y - 1120) / 330, b = (y + 1250) / 320;
  return 440 + 20 * Math.sin(y / 230 + 0.7) + 9 * Math.sin(y / 97 + 2.1) + 250 * Math.exp(-a * a) + 230 * Math.exp(-b * b);
}

// The natural land, before the road and railway are cut into it.
function landHeight(x, y) {
  const dc = coastX(y) - x; // metres inland from the shore
  const plain = 1.0 + 6.0 * smoothstep(-5, 210, dc);
  const inland = smoothstep(120, 900, dc);
  const rise = 0.03 * Math.max(0, dc - 150);
  const rolling = (fbm(x / 520 + 3.7, y / 520 - 1.3) - 0.45) * 44;
  const ridge = 34 * Math.exp(-(((x + 950) / 240) ** 2)) * (0.75 + 0.25 * Math.sin(y / 380 + 0.4));
  const heads = (52 * gauss(x, y, 470, 1120, 300) + 44 * gauss(x, y, 440, -1250, 290)) * smoothstep(-40, 60, dc);
  const land = plain + Math.max(-2, inland * (rise + rolling + ridge)) + heads;
  const sea = Math.max(-30, -1.5 + 0.05 * dc);
  return lerp(sea, land, smoothstep(-35, 15, dc));
}

// ------------------------------------------------------------------ layout

// Turtle walk: straights ['S', length] and arcs ['A', radius, degrees (+ = left)].
// Appends sample points (each segment's start and interior, not its end).
function walk(x, y, hd, segs, out) {
  for (const sg of segs) {
    out.starts.push(out.pts.length);
    if (sg[0] === 'S') {
      const len = sg[1], n = Math.max(1, Math.ceil(len / 10 - 1e-9));
      const c = Math.cos(hd), sn = Math.sin(hd);
      for (let i = 0; i < n; i++) { out.pts.push([x + c * len * i / n, y + sn * len * i / n]); out.curv.push(0); }
      x += c * len; y += sn * len;
    } else {
      const R = sg[1], ang = sg[2] * Math.PI / 180, k = Math.sign(ang);
      const cx = x - k * R * Math.sin(hd), cy = y + k * R * Math.cos(hd);
      const n = Math.max(2, Math.ceil(R * Math.abs(ang) / 3.5));
      for (let i = 0; i < n; i++) {
        const a = hd + ang * i / n;
        out.pts.push([cx + k * R * Math.sin(a), cy - k * R * Math.cos(a)]);
        out.curv.push(k / R);
      }
      hd += ang; x = cx + k * R * Math.sin(hd); y = cy - k * R * Math.cos(hd);
    }
  }
  return [x, y, hd];
}

// Everything after the main straight, up to the S-bend that heads south.
const TAIL = [
  ['A', 120, 90], ['S', 140], ['A', 100, 90], ['S', 100], ['A', 130, -60], ['S', 100],
  ['A', 130, 60], ['S', 300], ['A', 180, 35], ['A', 180, -35],
];
const SEG_GALLERY = 8; // index of the 300 m straight (counting the main straight as 0)

function makeLayout(target) {
  const probe = { pts: [], curv: [], starts: [] };
  const [qx, qy] = walk(300, 500, Math.PI / 2, TAIL, probe);
  let len0 = 0;
  for (const sg of TAIL) len0 += sg[0] === 'S' ? sg[1] : sg[1] * Math.abs(sg[2]) * Math.PI / 180;
  const R = 130;
  const a = 300 - 2 * R - qx;                     // south straight, heading east
  const f = (target - (500 - qy) - len0 - Math.PI * R - a) / 2; // last straight heading south
  const main = 500 - qy + f;
  const lay = { pts: [], curv: [], starts: [] };
  const end = walk(300, qy - f, Math.PI / 2, [['S', main], ...TAIL, ['S', f], ['A', R, 90], ['S', a], ['A', R, 90]], lay);
  lay.closure = Math.hypot(end[0] - 300, end[1] - (qy - f));
  Object.assign(lay, { main, y0: qy - f, f, a });
  return lay;
}

function smoothLoop(arr, sigma) {
  const n = arr.length, r = Math.ceil(sigma * 3), w = [];
  let ws = 0;
  for (let k = -r; k <= r; k++) { const e = Math.exp(-0.5 * (k / sigma) ** 2); w.push(e); ws += e; }
  return arr.map((_, i) => {
    let s = 0;
    for (let k = -r; k <= r; k++) s += arr[(((i + k) % n) + n) % n] * w[k + r];
    return s / ws;
  });
}

// ------------------------------------------------------------------ height field
// The road and railway are flattened into the land: within FLAT metres of a
// sample the ground is the sample's height, blending back to the natural land
// by BLEND.  Where several samples are near, their heights are averaged with
// weights that favour the nearest, which keeps the result continuous.

const CELL = 40;
let FIELD = null;

function makeField(lay) {
  const P2 = new Path(lay.pts, { closed: true });
  const n = Math.round(P2.length / 4);
  const xs = [], ys = [], raw = [];
  for (let k = 0; k < n; k++) {
    const { p } = P2.at(k * P2.length / n);
    xs.push(p[0]); ys.push(p[1]); raw.push(landHeight(p[0], p[1]));
  }
  // the main straight is held level; the rest follows the land, smoothed
  const zs = smoothLoop(smoothLoop(raw, 22), 22).map((z, k) => {
    const s = k * P2.length / n, sw = s > P2.length / 2 ? s - P2.length : s;
    const w = smoothstep(-150, 0, sw) * (1 - smoothstep(lay.main, lay.main + 150, s));
    return Math.max(lerp(z, MAIN_Z, w), 4);
  });
  const S = { x: [], y: [], z: [], F: [], B: [], rail: [] };
  for (let k = 0; k < n; k++) { S.x.push(xs[k]); S.y.push(ys[k]); S.z.push(zs[k]); S.F.push(FLAT); S.B.push(BLEND); S.rail.push(0); }
  for (let y = RAIL_S; y <= RAIL_N + 1e-6; y += 6) { S.x.push(RAIL_X); S.y.push(y); S.z.push(RAIL_Z); S.F.push(13); S.B.push(45); S.rail.push(1); }
  const grid = new Map();
  for (let i = 0; i < S.x.length; i++) {
    const key = (Math.floor(S.x[i] / CELL) + 500) * 2048 + (Math.floor(S.y[i] / CELL) + 500);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  return { S, grid };
}

function nearSamples(x, y, fn) {
  const ix = Math.floor(x / CELL), iy = Math.floor(y / CELL);
  const S = FIELD.S;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const list = FIELD.grid.get((ix + dx + 500) * 2048 + (iy + dy + 500));
      if (!list) continue;
      for (const i of list) fn(i, Math.hypot(S.x[i] - x, S.y[i] - y), S);
    }
  }
}

function heightAt(x, y) {
  const base = landHeight(x, y);
  let m = 0, emin = Infinity;
  nearSamples(x, y, (i, d, S) => {
    if (d >= S.B[i]) return;
    m = Math.max(m, 1 - smoothstep(S.F[i], S.B[i], d));
    emin = Math.min(emin, d - S.F[i]);
  });
  if (m <= 0) return base;
  let ws = 0, wz = 0;
  nearSamples(x, y, (i, d, S) => {
    if (d >= S.B[i]) return;
    const e = (d - S.F[i] - emin) / TAU_W, w = Math.exp(-e * e);
    ws += w; wz += w * S.z[i];
  });
  return lerp(base, wz / ws, m);
}

// distance to the nearest road (rail = false) or railway (rail = true) sample, up to 80 m
function featureDist(x, y, rail = false) {
  let d0 = Infinity;
  nearSamples(x, y, (i, d, S) => { if (!!S.rail[i] === rail && d < d0) d0 = d; });
  return d0;
}

// ------------------------------------------------------------------ build the layout

let LAY, CENTRE;
{
  let target = LAP_TARGET;
  for (let it = 0; it < 3; it++) {
    LAY = makeLayout(target);
    FIELD = makeField(LAY);
    CENTRE = new Path(LAY.pts.map(([x, y]) => [x, y, heightAt(x, y) + ROAD_LIFT]), { closed: true });
    target += LAP_TARGET - CENTRE.length;
  }
}
const LAP = CENTRE.length;
const PERIOD = LAP / UNIT;
const SEG_S = LAY.starts.map((i) => CENTRE.cum[i]);
const GAL0 = SEG_S[SEG_GALLERY] + 50;
const GAL1 = GAL0 + GAL_SP * GAL_N;
const MAIN_LEN = SEG_S[1];

// Frame of the track at distance s: position (on the centre line), unit
// tangent and right vectors (horizontal).
function frameAt(s) {
  const { p, dir } = CENTRE.smoothAt(s, 4);
  const l = Math.hypot(dir[0], dir[1]) || 1;
  const t = [dir[0] / l, dir[1] / l];
  return { p, t, r: [t[1], -t[0]] };
}
const onTrack = (s, u) => {
  const f = frameAt(s);
  return [f.p[0] + f.r[0] * u, f.p[1] + f.r[1] * u];
};

// ------------------------------------------------------------------ terrain grid

function axis(spec) {
  const out = [spec[0][0]];
  for (let k = 0; k < spec.length - 1; k++) {
    const [a, step] = spec[k], b = spec[k + 1][0];
    const n = Math.max(1, Math.round((b - a) / step));
    for (let i = 1; i <= n; i++) out.push(a + (b - a) * i / n);
  }
  return out;
}
const XS = axis([[-4800, 100], [-3000, 65], [-1300, 25], [-480, 12.5], [520, 25], [900, 70], [1600]]);
const YS = axis([[-4800, 100], [-3200, 65], [-1800, 25], [-900, 12.5], [720, 25], [1700, 65], [3200, 100], [4800]]);
const ZG = new Float32Array(XS.length * YS.length);
for (let j = 0; j < YS.length; j++) for (let i = 0; i < XS.length; i++) ZG[j * XS.length + i] = heightAt(XS[i], YS[j]);

function findCell(arr, v) {
  let lo = 0, hi = arr.length - 1;
  if (v <= arr[0]) return 0;
  if (v >= arr[hi]) return hi - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m; else hi = m; }
  return lo;
}
// height of the terrain mesh as drawn (piecewise linear)
function meshHeight(x, y) {
  if (x < XS[0] || x > XS[XS.length - 1] || y < YS[0] || y > YS[YS.length - 1]) return heightAt(x, y);
  const nx = XS.length, i = findCell(XS, x), j = findCell(YS, y);
  const fx = (x - XS[i]) / (XS[i + 1] - XS[i]), fy = (y - YS[j]) / (YS[j + 1] - YS[j]);
  const z00 = ZG[j * nx + i], z10 = ZG[j * nx + i + 1], z01 = ZG[(j + 1) * nx + i], z11 = ZG[(j + 1) * nx + i + 1];
  return fx >= fy ? z00 + fx * (z10 - z00) + fy * (z11 - z10) : z00 + fy * (z01 - z00) + fx * (z11 - z01);
}
const groundZ = meshHeight;

const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function terrainColor(x, y, z, n) {
  const dc = coastX(y) - x;
  const sand = [0.86, 0.79, 0.61], seabed = [0.6, 0.56, 0.45];
  const dry = [0.68, 0.6, 0.37], green = [0.45, 0.5, 0.27], scrub = [0.31, 0.36, 0.2], rock = [0.6, 0.55, 0.47];
  let c = mixc(dry, green, smoothstep(0.38, 0.66, fbm(x / 140, y / 140)));
  c = mixc(c, scrub, smoothstep(0.5, 0.72, fbm(x / 320 + 5, y / 320 - 2)) * smoothstep(150, 600, dc));
  const dRoad = featureDist(x, y);
  c = mixc(c, [0.46, 0.5, 0.29], 1 - smoothstep(FLAT - 6, FLAT + 14, dRoad));
  c = mixc(c, rock, smoothstep(0.2, 0.45, 1 - n[2]));
  c = mixc(c, sand, (1 - smoothstep(1.5, 2.4, z)) * (1 - smoothstep(50, 90, dc)));
  if (z < -0.3) c = seabed;
  return c;
}

// ------------------------------------------------------------------ mesh helpers

function setAttr(g, idx, o) {
  const col = o.color !== undefined ? (typeof o.color === 'string' ? parseHex(o.color) : o.color) : null;
  for (const k of idx) {
    if (col) { g.c[k * 3] = col[0]; g.c[k * 3 + 1] = col[1]; g.c[k * 3 + 2] = col[2]; }
    if (o.emissive !== undefined) g.a[k * 4] = o.emissive;
    if (o.gloss !== undefined) g.a[k * 4 + 1] = o.gloss;
    if (o.mat !== undefined) g.a[k * 4 + 2] = o.mat;
    if (o.tag !== undefined) g.x[k * 2 + 1] = o.tag;
  }
}
function parseHex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// A prism: a side profile [[y, z], ...] (counter-clockwise, y forward, z up)
// extruded across x.  edgeAttr(k) styles the face along profile edge k (its
// uv: 0..1 along the edge, 0..1 across); the two sides get capAttr and uv =
// the profile coordinates in metres.
//   (an edgeAttr of null leaves that face out; with opts.fan the sides are a
//   fan from profile point 0, which must see every other point, instead of
//   one from the centre: two triangles and a vertex fewer on each side.
//   opts.capTag(sx) tags each side's vertices.)
function prism(profile, width, edgeAttr, capAttr, opts = {}) {
  const g = new Geo(), hw = width / 2, n = profile.length;
  for (let k = 0; k < n; k++) {
    const attr = edgeAttr(k);
    if (attr === null) continue;
    const P = profile[k], Q = profile[(k + 1) % n];
    const dy = Q[0] - P[0], dz = Q[1] - P[1], l = Math.hypot(dy, dz);
    const ny = dz / l, nz = -dy / l;
    const q = [
      g.vert(-hw, P[0], P[1], 0, ny, nz, 0, 0), g.vert(hw, P[0], P[1], 0, ny, nz, 0, 1),
      g.vert(hw, Q[0], Q[1], 0, ny, nz, 1, 1), g.vert(-hw, Q[0], Q[1], 0, ny, nz, 1, 0),
    ];
    setAttr(g, q, attr);
    g.quadIdx(q[0], q[1], q[2], q[3]);
  }
  let cy = 0, cz = 0;
  for (const p of profile) { cy += p[0] / n; cz += p[1] / n; }
  for (const sx of [-1, 1]) {
    const idx = [];
    if (opts.fan) {
      for (const p of profile) idx.push(g.vert(sx * hw, p[0], p[1], sx, 0, 0, p[0], p[1]));
      for (let k = 1; k < n - 1; k++) g.tri(idx[0], idx[k], idx[k + 1]);
    } else {
      const c0 = g.vert(sx * hw, cy, cz, sx, 0, 0, cy, cz);
      idx.push(c0);
      for (const p of profile) idx.push(g.vert(sx * hw, p[0], p[1], sx, 0, 0, p[0], p[1]));
      for (let k = 0; k < n; k++) g.tri(c0, c0 + 1 + k, c0 + 1 + ((k + 1) % n));
    }
    setAttr(g, idx, capAttr);
    if (opts.capTag) for (const i of idx) g.x[i * 2 + 1] = opts.capTag(sx);
  }
  return g.orientByNormals();
}

// matrix placing a model (x across, y along, z up) on the track at (s, u), on the ground
function trackMatrix(s, u, dz = 0, z = null) {
  const f = frameAt(s);
  const x = f.p[0] + f.r[0] * u, y = f.p[1] + f.r[1] * u;
  return m4.fromBasis([f.r[0], f.r[1], 0], [f.t[0], f.t[1], 0], [0, 0, 1], [x, y, (z ?? groundZ(x, y)) + dz]);
}

// Sets aux to each vertex's height above the land in hundreds of metres (0..1),
// so that tall things see over nearer hills in the land's shadow (`surface`).
const aboveLand = (g) => g.aux((p) => Math.min(1, Math.max(0, (p[2] - groundZ(p[0], p[1])) / 100)));

// A vertical panel of size w x h facing -Y, standing on z = 0 (as in lab.js).
const panel = (w, h) => Geo.plane(w, h).rotateX(Math.PI / 2).translate(0, 0, h / 2);

// Shows `make(phase)` (phase 0..1) as a stop-motion loop of n static poses: a
// periodic time window each, so it costs no tetrahedra at all.
function stopMotion(b, make, n, cycle, offset = 0) {
  for (let j = 0; j < n; j++) {
    b.static(make(j / n), { from: offset + j * cycle / n, to: offset + (j + 1) * cycle / n, period: cycle });
  }
}

// ------------------------------------------------------------------ vehicles

// The race cars: a low wedge with a ducktail, and a wing on a swan-neck
// pedestal.  Every moving triangle is drawn as three tetrahedra, so the body
// is still a prism of 30 triangles: no floor (it is never seen), sides fanned
// from a corner, and everything else is painted on by the CAR_* materials: wheels with tyres,
// rims, spokes and callipers under flared arches, glass with the driver's
// helmet behind it, lights, grille, splitter, diffuser, exhaust, stripes and
// the racing number (the vertices' tag; bit 128 marks the left side).  The
// small parts that stand out (mirrors, tyres, exhaust pipe, ...) are added
// from near by, see carDetailGeo.
const CAR_PROFILE = [[-2.28, 0.06], [2.3, 0.06], [2.34, 0.56], [1.05, 0.8], [0.2, 1.22], [-0.85, 1.24], [-1.9, 0.93], [-2.32, 0.9]];
const CAR_W = 1.84;
const CAR_NUMBERS = [7, 23, 11, 4, 88, 31, 16, 42, 5, 69, 12, 27, 3, 55, 9, 71, 18, 21, 33, 8, 64, 2];
function carGeo(color, number) {
  const g = prism(CAR_PROFILE, CAR_W, (k) => {
    if (k === 0) return null;
    if (k === 1) return { color, mat: MAT.CAR_FRONT, gloss: 0.6 };
    if (k === 7) return { color, mat: MAT.CAR_REAR, gloss: 0.6 };
    if (k === 3) return { color, mat: MAT.CAR_SCREEN, gloss: 0.6 };
    if (k === 5) return { color, mat: MAT.CAR_BACKGLASS, gloss: 0.6 };
    if (k === 4) return { color, mat: MAT.CAR_ROOF, gloss: 0.7 };
    if (k === 2) return { color, mat: MAT.CAR_BONNET, gloss: 0.7 };
    return { color, mat: MAT.CAR_TOP, gloss: 0.7 };
  }, { color, mat: MAT.CAR_SIDE, gloss: 0.7 }, { fan: true, capTag: (sx) => (sx < 0 ? 128 : 0) });
  const wing = Geo.merge(
    Geo.quad([0, -2.17, 0.9], [0, -1.98, 0.925], [0, -2.07, 1.19], [0, -2.21, 1.19]),
    Geo.quad([-0.86, -2.0, 1.165], [-0.86, -2.37, 1.235], [0.86, -2.37, 1.235], [0.86, -2.0, 1.165]),
  ).color('#1c1f23').gloss(0.45).doubleSided();
  g.add(wing);
  for (let i = 0; i < g.vertexCount; i++) g.x[i * 2 + 1] |= number;
  return g;
}
// The small parts of a car that stand out of the body, for near by: door
// mirrors, the tyres' treads (open rings round the painted wheels, standing
// 4 cm proud of the sides), exhaust pipe, splitter lip, wing end plates,
// canards, tow straps, an aerial and wiper blades.  117 triangles.
function carDetailGeo(color) {
  const g = new Geo();
  for (const sx of [-1, 1]) {
    const mirror = Geo.box(0.17, 0.09, 0.1).translate(sx * 1.0, 0.8, 0.93).color(color).gloss(0.6);
    for (let i = 12; i < 16; i++) mirror.c.splice(i * 3, 3, 0.62, 0.7, 0.78);   // the face towards the back: glass
    for (let i = 12; i < 16; i++) mirror.a[i * 4 + 1] = 0.95;
    g.add(mirror);
    g.add(Geo.quad([sx * 0.865, -2.39, 1.12], [sx * 0.865, -1.97, 1.12], [sx * 0.865, -1.97, 1.27], [sx * 0.865, -2.41, 1.3]).color('#1c1f23').doubleSided());
    g.add(Geo.triangle([sx * 0.92, 2.22, 0.3], [sx * 0.92, 1.95, 0.33], [sx * 1.0, 2.2, 0.31]).color('#1c1f23').doubleSided());
    for (const cy of [-1.38, 1.45]) {
      const tyre = new Geo(), seg = 8, R = 0.345, x0 = sx * 0.86, x1 = sx * 0.965;
      for (let i = 0; i < seg; i++) {
        const a = (i + 0.5) / seg * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
        tyre.vert(x0, cy + R * c, 0.33 + R * s, 0, c, s, i / seg, 0);
        tyre.vert(x1, cy + R * c, 0.33 + R * s, 0, c, s, i / seg, 1);
      }
      for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; tyre.quadIdx(2 * i, 2 * j, 2 * j + 1, 2 * i + 1); }
      g.add(tyre.orientByNormals().color('#151617').gloss(0.2));
    }
  }
  g.add(Geo.cylinder(0.045, 0.1, 6, { caps: false }).rotateX(Math.PI / 2).translate(0.55, -2.27, 0.26).color('#8a8580').gloss(0.7));
  g.add(Geo.quad([-0.9, 2.3, 0.075], [0.9, 2.3, 0.075], [0.9, 2.4, 0.075], [-0.9, 2.4, 0.075]).color('#1a1a1a').doubleSided());
  g.add(Geo.triangle([0, -0.3, 1.235], [0, -0.45, 1.235], [0, -0.42, 1.52]).color('#111').doubleSided());
  // wiper blades lying on the windscreen, a centimetre proud of it
  const dl = Math.hypot(0.85, 0.42), dir = [-0.85 / dl, 0.42 / dl], nrm = [dir[1], -dir[0]];   // along the glass, and out of it
  const onGlass = (x, d) => [x, 1.05 + dir[0] * d + nrm[0] * 0.012, 0.8 + dir[1] * d + nrm[1] * 0.012];
  for (const [x0, x1] of [[-0.8, -0.08], [0.02, 0.72]]) {
    g.add(Geo.quad(onGlass(x0, 0.06), onGlass(x1, 0.16), onGlass(x1, 0.185), onGlass(x0, 0.085)).color('#141414').doubleSided());
  }
  g.add(Geo.quad([0.4, 2.33, 0.1], [0.5, 2.335, 0.1], [0.5, 2.335, 0.22], [0.4, 2.33, 0.22]).color('#d62f1f').doubleSided());
  g.add(Geo.quad([-0.5, -2.31, 0.24], [-0.4, -2.31, 0.24], [-0.4, -2.31, 0.36], [-0.5, -2.31, 0.36]).color('#d62f1f').doubleSided());
  return g;
}
// A coach's small parts: mirrors on arms that reach forward, a cooling unit
// on the roof and the treads of its tyres.
function busDetailGeo() {
  const g = new Geo();
  for (const sx of [-1, 1]) {
    g.add(Geo.box(0.06, 0.5, 0.06).translate(sx * 1.3, 6.15, 2.6).color('#1c1f23'));
    const mirror = Geo.box(0.12, 0.1, 0.42).translate(sx * 1.48, 6.38, 2.35).color('#1c1f23');
    for (let i = 12; i < 16; i++) mirror.c.splice(i * 3, 3, 0.62, 0.7, 0.78);
    g.add(mirror);
    g.add(Geo.box(0.2, 0.06, 0.06).translate(sx * 1.38, 6.38, 2.6).color('#1c1f23'));
  }
  g.add(Geo.box(1.6, 2.6, 0.28).translate(0, 1.5, 3.39).color('#d8dadb').gloss(0.3));
  // the treads of the tyres, standing a little proud of the sides
  for (const sx of [-1, 1]) {
    for (const cy of [-3.7, 3.9]) {
      const tyre = new Geo(), seg = 8, R = 0.52, x0 = sx * 1.18, x1 = sx * 1.29;
      for (let i = 0; i < seg; i++) {
        const a = (i + 0.5) / seg * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
        tyre.vert(x0, cy + R * c, 0.5 + R * s, 0, c, s, i / seg, 0);
        tyre.vert(x1, cy + R * c, 0.5 + R * s, 0, c, s, i / seg, 1);
      }
      for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; tyre.quadIdx(2 * i, 2 * j, 2 * j + 1, 2 * i + 1); }
      g.add(tyre.orientByNormals().color('#151617').gloss(0.2));
    }
  }
  return g;
}
// The coaches: the same kind of prism, with doors, wheels, lights and the
// destination board painted on (BUS_SIDE, and BUS_END with tags 1 to 4 for
// the lower front, windscreen, upper rear and lower rear).
const BUS_PROFILE = [[-6, 0.08], [6, 0.08], [6.05, 1.1], [5.95, 2.95], [5.7, 3.25], [-5.95, 3.25], [-6.05, 1.1]];
function busGeo(color) {
  return prism(BUS_PROFILE, 2.5, (k) => {
    if (k === 0) return null;
    if (k === 1) return { color, mat: MAT.BUS_END, gloss: 0.5, tag: 1 };
    if (k === 2) return { color, mat: MAT.BUS_END, gloss: 0.6, tag: 2 };
    if (k === 5) return { color, mat: MAT.BUS_END, gloss: 0.5, tag: 3 };
    if (k === 6) return { color, mat: MAT.BUS_END, gloss: 0.5, tag: 4 };
    return { color, gloss: 0.55 };
  }, { color, mat: MAT.BUS_SIDE, gloss: 0.55 }, { fan: true, capTag: (sx) => (sx < 0 ? 128 : 0) });
}

// Carries a model along a lane: offset metres to the right of the lap
// direction, dir = +1 with the lap, -1 against it.
function laneTransform(s0, speed, offset, dir) {
  return (t) => {
    const s = s0 + dir * speed * t;
    const { p, dir: d } = CENTRE.smoothAt(s, 8);
    const l = Math.hypot(d[0], d[1]) || 1;
    const pos = [p[0] + d[1] / l * offset, p[1] - d[0] / l * offset, p[2]];
    return m4.facing(pos, dir > 0 ? d : [-d[0], -d[1], -d[2]]);
  };
}

// The trains move in straight lines at a steady speed, so each run has only
// two keys and their small parts cost little memory; they are drawn whenever
// the train is, so they are kept to boxes.  Windows, doors, lights, grilles
// and wheels are painted (TRAIN, TRAIN_CAB, TRAIN_END, BOGIE, CONTAINER).
// Rails are 0.26 m above the trains' origin; the bodies start at 0.55.
const boxFace = (g, face, o) => setAttr(g, [0, 1, 2, 3].map((i) => face * 4 + i), o);   // faces: +x, -x, +y, -y, +z, -z
// a bar of square section w from a to b (in a mesh's own coordinates)
function bar(a, b, w) {
  const d = v3.sub(b, a), l = v3.len(d), y = v3.scale(d, 1 / l);
  const x = Math.abs(y[2]) < 0.9 ? v3.norm(v3.cross(y, [0, 0, 1])) : [1, 0, 0];
  return Geo.box(w, l, w).transform(m4.fromBasis(x, y, v3.cross(x, y), v3.scale(v3.add(a, b), 0.5)));
}
// the faces of a box but its top and bottom (for parts whose top is hidden
// under a body and whose bottom is never seen): 8 triangles instead of 12
function sides(g) {
  g.idx = g.idx.slice(0, 24);
  for (const [k, n] of [['p', 3], ['n', 3], ['c', 3], ['uv', 2], ['a', 4], ['x', 2]]) g[k] = g[k].slice(0, 16 * n);
  return g;
}
// a bogie: a low frame with two wheels painted on each side, centred at y
const bogie = (y, w = 2.0) => sides(Geo.box(w, 2.8, 0.42)).translate(0, y, 0.41).color('#2b2d30').mat(MAT.BOGIE);
function expressGeo() {
  const g = new Geo();
  // power car, front at y = 0, with a sloping nose; no floor
  g.add(prism([[-24, 0.55], [0, 0.55], [0.1, 1.5], [-4.5, 4.2], [-24, 4.2]], 3.0, (k) => {
    if (k === 0) return null;
    if (k === 1) return { color: '#c0392b', gloss: 0.5, mat: MAT.TRAIN_END, tag: 1 };
    if (k === 2) return { color: '#eef0f2', gloss: 0.6, mat: MAT.TRAIN_END, tag: 2 };
    return { color: '#eef0f2', gloss: 0.5 };
  }, { color: '#eef0f2', gloss: 0.5, mat: MAT.TRAIN_CAB }, { fan: true }));
  for (let i = 1; i < 8; i++) {
    const coach = Geo.box(3.0, 24.2, 3.65).translate(0, -12.5 - 25 * i, 2.38).color('#eef0f2').gloss(0.5).mat(MAT.TRAIN);
    if (i === 7) boxFace(coach, 3, { mat: MAT.TRAIN_END, tag: 3 });
    g.add(coach);
  }
  // bogies, the gangways between the cars, air conditioning on the roofs, the pantograph
  const parts = new Geo();
  for (let i = 1; i < 8; i++) {
    const yc = -12.5 - 25 * i;
    parts.add(Geo.box(2.5, 1.6, 3.1).translate(0, yc + 12.4, 2.3).color('#3b3e42'));
    parts.add(Geo.box(1.9, 4.2, 0.3).translate(0, yc + 3, 4.35).color('#c9cdd1').gloss(0.3));
  }
  const pan = new Geo();
  pan.add(Geo.box(1.5, 2.2, 0.22).translate(0, -15, 4.31));
  pan.add(bar([0, -14.2, 4.42], [0, -15.6, 5.3], 0.08));
  pan.add(bar([0, -15.6, 5.3], [0, -14.4, 6.05], 0.07));
  pan.add(Geo.box(1.7, 0.18, 0.08).translate(0, -14.4, 6.08));
  pan.add(Geo.box(2.0, 5.5, 0.35).translate(0, -9.5, 4.37));
  parts.add(pan.color('#5b6168').gloss(0.4));
  g.add(parts);
  return g;
}
// the bogies under the express, and under the freight train with its
// couplings: seen only from near by (see the trains in build())
function expressBogies() {
  const g = new Geo();
  g.add(bogie(-3.5)); g.add(bogie(-20.5));
  for (let i = 1; i < 8; i++) { const yc = -12.5 - 25 * i; g.add(bogie(yc + 9.3)); g.add(bogie(yc - 9.3)); }
  return g;
}
function freightBogies() {
  const g = new Geo();
  g.add(bogie(-3.6, 2.2)); g.add(bogie(-15.4, 2.2));
  for (let i = 0; i < 14; i++) {
    const y = -20 - 20 * i - 9.6;
    g.add(bogie(y + 7.2, 1.9)); g.add(bogie(y - 7.2, 1.9));
    g.add(sides(Geo.box(0.35, 1.2, 0.3)).translate(0, y + 9.6 + 0.4, 1.05).color('#1d1e20'));     // coupling
  }
  return g;
}
function freightGeo(rand) {
  const g = new Geo();
  const loco = Geo.box(3.0, 19, 4.0).translate(0, -9.5, 2.5).color('#8e2b20').gloss(0.4).mat(MAT.LOCO);
  boxFace(loco, 2, { mat: MAT.TRAIN_END, tag: 4 });
  boxFace(loco, 3, { mat: MAT.TRAIN_END, tag: 4 });
  g.add(loco);
  const cols = ['#2f5d8a', '#b8862b', '#7a3a2a', '#3f6b47', '#9a9a96', '#c2552c', '#5a4a7a'];
  for (let i = 0; i < 14; i++) {
    const y = -20 - 20 * i - 9.6;
    g.add(Geo.box(2.7, 19.2, 0.5).translate(0, y, 1.1).color('#2a2c2e'));
    g.add(Geo.box(2.5, 18.6, 2.6).translate(0, y, 2.65).color(rand.pick(cols)).gloss(0.25).mat(MAT.CONTAINER));
  }
  // the red lamp on the last wagon
  g.add(Geo.box(0.3, 0.2, 0.3).translate(0.9, -20 - 20 * 13 - 19.3, 1.6).color('#ff2a14').emissive(6));
  return g;
}

function balloonGeo(color) {
  const g = Geo.lathe([[2.0, 0], [5.2, 3.6], [8.3, 9.5], [8.9, 13.5], [7.8, 18], [4.6, 21.2], [0.4, 22.4]], 10)
    .color(color).mat(MAT.BALLOON).gloss(0.2);
  g.add(Geo.box(1.5, 1.5, 1.1).translate(0, 0, -3.6).color('#8a6236').mat(MAT.BASKET));
  return g.aux(1); // high above the land: out of the reach of its shadow
}
// a rope or stay: two crossed strips from a to b, w wide
function rope(a, b, w, color) {
  const d = v3.norm(v3.sub(b, a));
  const g = new Geo();
  for (const side of [[0, 0, 1], [1, 0, 0]]) {
    let p = v3.cross(d, side);
    if (v3.len(p) < 0.1) p = v3.cross(d, [0, 1, 0]);
    p = v3.scale(v3.norm(p), w / 2);
    g.add(Geo.quad(v3.sub(a, p), v3.add(a, p), v3.add(b, p), v3.sub(b, p)));
  }
  return g.color(color).doubleSided();
}
// a balloon's small parts, for near by: the ropes from the basket to the
// envelope's mouth, the burner on its frame of poles, its flame (lit while
// the envelope glows, see FLAME), a padded rim round the basket, and the
// pilot and a passenger looking over it
function balloonDetailGeo() {
  const g = new Geo();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    g.add(rope([sx * 0.72, sy * 0.72, -3.05], [sx * 1.41, sy * 1.41, 0], 0.05, '#cbbf9f'));
    g.add(rope([sx * 0.62, sy * 0.62, -3.05], [sx * 0.32, sy * 0.32, -1.72], 0.04, '#3b3f44'));
  }
  g.add(Geo.box(0.7, 0.7, 0.35).translate(0, 0, -1.55).color('#9aa0a6').gloss(0.7));
  for (const [x, y, w, d] of [[0, 0.76, 1.62, 0.12], [0, -0.76, 1.62, 0.12], [0.76, 0, 0.12, 1.4], [-0.76, 0, 0.12, 1.4]]) {
    g.add(Geo.box(w, d, 0.12).translate(x, y, -3.0).color('#4a2e1a'));
  }
  for (const [x, y, shirt] of [[0.35, 0.3, '#2a5f8f'], [-0.33, -0.25, '#b8322a']]) {
    g.add(Geo.box(0.4, 0.26, 0.3).translate(x, y, -3.05).color(shirt));
    g.add(Geo.box(0.22, 0.24, 0.26).translate(x, y, -2.77).color('#c99f84'));
  }
  g.add(Geo.cone(0.32, 2.4, 6).translate(0, 0, -1.38).color('#ffb347').mat(MAT.FLAME).additive());
  return g.aux(1);
}

function blimpGeo() {
  const g = Geo.sphere(1, 10, 6).scale(7.5, 34, 7.5).color('#e9ecef').gloss(0.6);
  for (const a of [0, Math.PI / 2]) {
    const fin = Geo.quad([0, -26, -9], [0, -36, -7], [0, -36, 7], [0, -26, 9]).color('#c0392b').doubleSided();
    g.add(fin.rotateY(a));
  }
  g.add(Geo.box(2.6, 9, 2.2).translate(0, 4, -8.2).color('#2b3036').mat(MAT.GONDOLA));
  for (const sx of [-1, 1]) {
    const p = Geo.plane(22, 5).rotateX(Math.PI / 2).rotateZ(sx > 0 ? Math.PI / 2 : -Math.PI / 2).translate(sx * 7.62, 0, 0);
    g.add(p.color('#ffb347').mat(MAT.DISPLAY));
  }
  return g.aux(1); // high above the land: out of the reach of its shadow
}

// a yacht's small parts, for near by: boom, cabin top, shrouds and
// backstay, and the helmsman at the tiller
function boatDetailGeo() {
  const g = new Geo();
  g.add(bar([0, 0.9, 2.15], [0, -3.7, 2.15], 0.1).color('#c9ccd0'));
  g.add(Geo.box(1.5, 2.2, 0.55).translate(0, -0.4, 1.55).color('#ece9e0').gloss(0.4));
  for (const sx of [-1, 1]) g.add(rope([0, 0.8, 11.9], [sx * 1.22, 0.4, 1.3], 0.03, '#8d9196'));
  g.add(rope([0, 0.8, 12.0], [0, -4.3, 1.3], 0.03, '#8d9196'));
  g.add(Geo.box(0.36, 0.3, 0.5).translate(0.5, -3.3, 1.55).color('#2a5f8f'));
  g.add(Geo.box(0.2, 0.22, 0.24).translate(0.5, -3.3, 1.92).color('#c99f84'));
  g.add(bar([0, -4.1, 1.45], [0.35, -3.1, 1.6], 0.05).color('#6b5440'));
  return g;
}
// the blimp's engine pods on their struts, beside the gondola, for near by
function blimpDetailGeo() {
  const g = new Geo();
  for (const sx of [-1, 1]) {
    g.add(Geo.cylinder(0.7, 2.6, 8).rotateX(-Math.PI / 2).translate(sx * 4.0, 1.0, -7.0).color('#c9ccd0').gloss(0.5));
    g.add(bar([sx * 1.3, 2.3, -7.8], [sx * 3.4, 2.3, -7.1], 0.15).color('#5b6168'));
    g.add(Geo.disc(1.15, 10).rotateX(Math.PI / 2).translate(sx * 4.0, 0.9, -7.0).color('#2b3036'));
  }
  return g.aux(1);
}
function boatGeo(sail) {
  const g = prism([[-4.2, 0], [3.4, 0], [4.8, 1.3], [-4.4, 1.3]], 2.6, (k) => (k === 0 ? null : { color: '#f4f2ec', gloss: 0.5 }), { color: '#f4f2ec', gloss: 0.5, mat: MAT.HULL }, { fan: true });
  g.add(Geo.box(0.16, 0.16, 11).translate(0, 0.8, 6.6).color('#ccc'));
  g.add(Geo.triangle([0, 1.0, 2.2], [0, -3.6, 2.2], [0, 0.9, 11.8]).color(sail).mat(MAT.SAIL).doubleSided());
  g.add(Geo.triangle([0, 1.2, 2.0], [0, 4.6, 1.6], [0, 1.1, 10.5]).color('#f7f5ef').doubleSided());
  return g;
}

// ------------------------------------------------------------------ shader

const f = (v) => { const s = Number(v).toFixed(4); return s; };
const LH = [640, 1140];

const wgsl = dayNightEnv({ dayLength: DAY, startHour: START_HOUR, sunTilt: 0.55, fog: FOG, clouds: 0.35, zenith: '#3b7fcf', horizon: '#c4dbe8' }) + /* wgsl */ `
const S_LINE = ${f(S_LINE)};
const GAL0 = ${f(GAL0)};
const GAL1 = ${f(GAL1)};
const GAL_SP = ${f(GAL_SP)};
const GAL_N = ${f(GAL_N)};
const GAL_DT = ${f(GAL_SP / GAL_V)};
const GAL_CYCLE = ${f(GAL_CYCLE)};
const GAL_ON = ${f(GAL_ON)};
const LAMP_SP = ${f(LAMP_SP)};
const CHASE_V = ${f(CHASE_V)};
const CHASE_SP = ${f(CHASE_SP)};
const LH = vec2f(${f(LH[0])}, ${f(LH[1])});
const BEAM_T = ${f(BEAM_T)};
const RAIL_X = ${f(RAIL_X)};

fn coastX(y: f32) -> f32 {
  let a = (y - 1120.0) / 330.0;
  let b = (y + 1250.0) / 320.0;
  return 440.0 + 20.0 * sin(y / 230.0 + 0.7) + 9.0 * sin(y / 97.0 + 2.1) + 250.0 * exp(-a * a) + 230.0 * exp(-b * b);
}
fn nightOf(t: f32) -> f32 { return 1.0 - envDaylight(t); }
fn lampsOn(t: f32) -> f32 { return smoothstep(0.3, 0.7, 1.0 - envDaylight(t)); }
fn aaBand(x: f32, half: f32, fw: f32) -> f32 { return 1.0 - smoothstep(half - fw, half + fw, abs(x)); }

// gallery lamp i is lit while (t - i * GAL_DT) mod GAL_CYCLE < GAL_ON (same as its static window)
fn galleryLit(i: f32, t: f32) -> f32 {
  let ph = t - i * GAL_DT;
  return 1.0 - step(GAL_ON, ph - floor(ph / GAL_CYCLE) * GAL_CYCLE);
}

// light from the street lamps (or the gallery lamps) at track coordinates (u, v)
fn trackLight(u: f32, v: f32, t: f32) -> vec3f {
  if (v > GAL0 && v < GAL1) {
    var l = vec3f(0.0);
    let k = floor((v - GAL0) / GAL_SP);
    for (var j = -1; j <= 1; j++) {
      let i = k + f32(j);
      if (i < 0.0 || i > GAL_N - 1.0) { continue; }
      let dv = v - (GAL0 + GAL_SP * (i + 0.5));
      let e = u * u + dv * dv + 42.0;
      l += vec3f(0.45, 0.8, 1.0) * (galleryLit(i, t) * 260.0 * 6.5 / (e * sqrt(e)));
    }
    return l;
  }
  let on = lampsOn(t);
  if (on <= 0.0) { return vec3f(0.0); }
  let dl = v - LAMP_SP * round(v / LAMP_SP);
  let w = v - 0.5 * LAMP_SP;
  let dr = w - LAMP_SP * round(w / LAMP_SP);
  let el = (u + 9.0) * (u + 9.0) + dl * dl + 76.0;
  let er = (u - 9.0) * (u - 9.0) + dr * dr + 76.0;
  return vec3f(1.0, 0.8, 0.55) * (on * 8.7 * 60.0 * (1.0 / (el * sqrt(el)) + 1.0 / (er * sqrt(er))));
}

fn groundDetail(p: vec2f, dist: f32) -> f32 {
  let near = 1.0 - smoothstep(60.0, 400.0, dist);
  return 0.86 + 0.26 * fbm2(p * 0.035) + 0.16 * (noise2(p * 0.9) - 0.5) * near;
}

fn waveGrad(p: vec2f, d: vec2f, k: f32, w: f32, t: f32) -> vec2f {
  return d * (k * cos(dot(d, p) * k - w * t));
}

// "MM:SS.d" across the unit square
fn timeDisplay(uv: vec2f, t: f32) -> f32 {
  if (uv.x < 0.0 || uv.x >= 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
  let tt = t - floor(t / 3600.0) * 3600.0;
  let ten = floor(tt * 10.0);
  let secs = floor(ten / 10.0);
  let d = i32(ten - secs * 10.0);
  let mins = i32(floor(secs / 60.0));
  let sc = i32(secs) - mins * 60;
  let x = uv.x * 5.9;
  if (x < 1.0) { return digit7(vec2f(x, uv.y), mins / 10); }
  if (x < 2.0) { return digit7(vec2f(x - 1.0, uv.y), mins % 10); }
  if (x < 2.5) {
    let l = vec2f((x - 2.25) * 2.0, uv.y);
    let e = min(length((l - vec2f(0.0, 0.33)) * vec2f(0.5, 1.0)), length((l - vec2f(0.0, 0.67)) * vec2f(0.5, 1.0)));
    return 1.0 - smoothstep(0.06, 0.085, e);
  }
  if (x < 3.5) { return digit7(vec2f(x - 2.5, uv.y), sc / 10); }
  if (x < 4.5) { return digit7(vec2f(x - 3.5, uv.y), sc % 10); }
  if (x < 4.9) {
    let l = vec2f((x - 4.7) * 0.4, uv.y - 0.12);
    return 1.0 - smoothstep(0.06, 0.085, length(l));
  }
  return digit7(vec2f(x - 4.9, uv.y), d);
}

// Ladders, railings and the catch fence, uv in metres.  Their bars are kept
// at least about a pixel wide (pf: the pixel's size), except the fence's mesh,
// which fades away once its wires are too fine to see, leaving its frame.
fn smallCutout(s: Surface, pf: f32) -> f32 {
  let w = max(pf * 0.6, 0.004);
  var d = 0.0;
  if (s.mat == ${MAT.LADDER}u) {
    let v = fract(s.uv.y / 0.3) * 0.3;
    d = max(max(0.04, w) - min(s.uv.x, 0.4 - s.uv.x), max(0.016, w) - min(v, 0.3 - v));
  } else if (s.mat == ${MAT.RAILING}u) {
    let x = fract(s.uv.x / 1.5) * 1.5;
    let h = s.uv.y;
    d = max(max(max(0.03, w) - min(x, 1.5 - x), max(0.03, w) - abs(h - 1.07)), max(max(0.025, w) - abs(h - 0.55), 0.1 - h));
  } else {
    // tubes at the top, the middle and the bottom (uv.x is the height), and a
    // mesh of 10 cm squares turned 45 degrees
    let a = abs(fract((s.uv.x + s.uv.y) * 7.071 + 0.5) - 0.5);
    let b = abs(fract((s.uv.x - s.uv.y) * 7.071 + 0.5) - 0.5);
    let mesh = 0.007 - min(a, b) * 0.1 - smoothstep(0.014, 0.05, pf) * 0.03;
    let tubes = max(max(0.04, w) - min(s.uv.x, 2.88 - s.uv.x), max(0.03, w) - abs(s.uv.x - 1.44));
    d = max(mesh, tubes);
  }
  return saturate(0.5 + d / max(pf, 0.002));
}

// The start gantry's legs are lattice towers: on each 0.9 m side of a 10.5 m
// leg, corner posts, a batten every 0.9 m and a diagonal brace in each panel,
// solid at the foot and where the beam joins.  Solid again once the bars are
// under a pixel wide (and in the shadow maps from the second cascade on).
fn cutout(s: Surface) -> f32 {
  let pf = length(fwidth(s.pos));
  if (s.mat == ${MAT.LADDER}u || s.mat == ${MAT.RAILING}u || s.mat == ${MAT.FENCE}u) { return smallCutout(s, pf); }
  if (s.mat != ${MAT.LATTICE}u) { return 1.0; }
  let a = s.uv.x * 0.9;
  let z = s.uv.y * 10.5;
  let k = floor(z / 0.9);
  let v = (z - k * 0.9);
  let along = select(a, 0.9 - a, fract(k * 0.5) > 0.25);
  let post = 0.09 - min(a, 0.9 - a);
  let batten = 0.045 - min(v, 0.9 - v);
  let brace = 0.05 - abs(along - v) * 0.7071;
  let ends = max(0.6 - z, z - 8.0);
  let d = max(max(post, batten), max(brace, ends));
  // (the shadow pass leaves s.dist at 0; its 6 cm texels near the player
  // show the holes well, its 50 cm ones further out do not)
  let fine = select(vec2f(0.085, 0.17), vec2f(0.25, 0.45), s.dist <= 0.0);
  return mix(saturate(0.5 + d / 0.03), 1.0, smoothstep(fine.x, fine.y, pf));
}

// ---- vehicles: painted detail (see carGeo and busGeo)
// coverage of a shape with signed distance d (< 0 inside), smoothed over aa
fn cover(d: f32, aa: f32) -> f32 { return 1.0 - smoothstep(-aa, aa, d); }
// the stripe colour that goes with a paint (s.color is linear)
fn carAccent(body: vec3f) -> vec3f {
  return select(vec3f(0.85, 0.85, 0.82), vec3f(0.02, 0.05, 0.22), dot(body, vec3f(0.3, 0.6, 0.1)) > 0.5);
}
fn helmetColor(num: f32) -> vec3f {
  let h = vec3f(hash11(num * 3.1), hash11(num * 5.7 + 1.0), hash11(num * 9.3 + 2.0));
  return h * h * 0.85 + 0.06;
}
// a race car's wheel from the side, d in metres from its centre: rgb, gloss
fn carWheel(d: vec2f, num: f32, aa: f32) -> vec4f {
  let r = length(d);
  let k = hash11(num * 7.1);
  let rim = select(select(vec3f(0.6, 0.61, 0.64), vec3f(0.07, 0.075, 0.08), k > 0.45), vec3f(0.55, 0.4, 0.12), k > 0.8);
  var c = mix(vec3f(0.028), vec3f(0.5, 0.45, 0.1), cover(abs(r - 0.29) - 0.005, aa) * 0.7);
  if (r < 0.24) {
    let a5 = fract(atan2(d.y, d.x) * 0.7958 + 0.25) - 0.5;
    let spoke = abs(a5) * 1.2566 * r - 0.02 - 0.06 * r;
    let metal = min(min(spoke, abs(r - 0.223) - 0.012), r - 0.06);
    // between the spokes: the disc, and the calliper on top
    let calliper = step(abs(d.x), 0.07) * step(0.11, d.y) * step(d.y, 0.2);
    let inner = mix(vec3f(0.035), select(vec3f(0.6, 0.05, 0.03), vec3f(0.75, 0.55, 0.05), k > 0.5), calliper);
    c = mix(c, mix(inner, rim, cover(metal, aa)), cover(r - 0.235, aa));
    c = mix(c, vec3f(0.05), cover(r - 0.022, aa));
  }
  return vec4f(c, select(0.15, 0.6, r < 0.235));
}
// the sides: uv = (forward, up) in metres
fn carSide(sIn: Surface, aa: f32) -> Surface {
  var s = sIn;
  let side = select(1.0, -1.0, (s.tag & 128u) != 0u);
  let num = f32(s.tag & 127u);
  let q = s.uv;
  let body = s.color;
  var c = body;
  var gl = s.gloss;
  // sponsor stripe, black sills, door shut lines
  c = mix(c, carAccent(body), cover(abs(q.y - 0.62) - 0.03, aa));
  c = mix(c, vec3f(0.03), cover(q.y - 0.17, aa));
  let shut = min(abs(q.x - 0.98), abs(q.x + 0.33));
  c = mix(c, body * 0.3, cover(shut - 0.006, aa) * step(0.17, q.y) * step(q.y, 0.84));
  // the racing number on a white roundel on the door
  let rp = q - vec2f(0.33, 0.43);
  let rr = length(rp * vec2f(0.85, 1.0));
  if (rr < 0.23) {
    c = mix(c, vec3f(0.92), cover(rr - 0.21, aa));
    c = mix(c, vec3f(0.02), number7(vec2f(side * rp.x / 0.3 + 0.5, rp.y / 0.27 + 0.5), num, 2));
  }
  // side glass in a black surround, the B-pillar, and the driver's helmet behind
  let z = q.y;
  let win = max(max(0.86 - z, z - 1.15), max(q.x - (0.92 - (z - 0.82) * 1.9), (-1.7 + (z - 0.9) * 3.0) - q.x));
  if (win < 0.035) {
    c = vec3f(0.02);
    gl = 0.35;
    if (win < 0.0 && abs(q.x + 0.33) > 0.04) {
      c = vec3f(0.018, 0.022, 0.028);
      gl = 0.9;
      let hp = q - vec2f(-0.06, 1.0);
      if (length(hp * vec2f(1.0, 1.12)) < 0.13) {
        c = mix(helmetColor(num), vec3f(0.01), step(abs(hp.y + 0.005), 0.035) * step(0.0, hp.x)) * 0.5;
        gl = 0.7;
      }
      c = mix(c, vec3f(0.12), cover(sdSegment(q, vec2f(0.75, 0.86), vec2f(-0.25, 1.15)) - 0.014, aa));
    }
  }
  // wheels under flared arches
  let d = q - vec2f(select(-1.38, 1.45, q.x > 0.0), 0.33);
  let r = length(d);
  if (r < 0.42) {
    c *= mix(0.7, 1.0, smoothstep(0.345, 0.42, r));
    c = mix(c, vec3f(0.006), cover(r - 0.345, aa));
    if (r < 0.345) {
      let w = carWheel(d, num, aa);
      c = mix(c, w.rgb, cover(r - 0.333, aa));
      gl = w.w;
    }
  }
  s.color = c;
  s.gloss = gl;
  return s;
}
// the nose: uv.x 0 at the bottom .. 1 at the top (0.5 m), uv.y across (1.84 m)
fn carFront(sIn: Surface, fwu: vec2f) -> Surface {
  var s = sIn;
  let m = vec2f(abs(s.uv.y - 0.5) * 1.84, s.uv.x * 0.5);   // from the centre line, up: metres
  let aa = max(fwu.x * 0.5, fwu.y * 1.84);
  var c = s.color;
  var e = 0.0;
  c = mix(c, vec3f(0.03), cover(m.y - 0.075, aa));
  // the front tyres, showing under the corners of the bumper
  c = mix(c, vec3f(0.025), cover(max(abs(m.x - 0.8) - 0.11, m.y - 0.13 + 0.25 * max(0.0, abs(m.x - 0.8) - 0.05)), aa));
  let grille = max(abs(m.y - 0.2) - 0.1, m.x - 0.34);
  c = mix(c, mix(vec3f(0.012), vec3f(0.07), step(0.55, fract(m.y * 40.0))), cover(grille, aa));
  c = mix(c, vec3f(0.015), cover(max(abs(m.y - 0.15) - 0.05, abs(m.x - 0.62) - 0.14), aa));
  let house = max(abs(m.y - 0.38) - 0.07, abs(m.x - 0.68) - 0.2);
  if (house < 0.01) {
    c = mix(c, vec3f(0.05), cover(house, aa));
    let lamp = min(length(m - vec2f(0.78, 0.39)) - 0.055, max(abs(m.y - 0.33) - 0.012, abs(m.x - 0.62) - 0.12));
    let lit = cover(lamp, aa);
    c = mix(c, vec3f(1.0, 0.97, 0.9), lit);
    e = lit * mix(1.5, 14.0, nightOf(s.t));
    let ind = cover(max(abs(m.y - 0.42) - 0.012, abs(m.x - 0.86) - 0.02), aa);
    c = mix(c, vec3f(1.0, 0.45, 0.02), ind);
    e = max(e, ind * 1.2);
  }
  s.color = c;
  s.emissive = e;
  return s;
}
// the tail: uv.x 0 at the top .. 1 at the bottom (0.84 m), uv.y across
fn carRear(sIn: Surface, fwu: vec2f) -> Surface {
  var s = sIn;
  let x = (s.uv.y - 0.5) * 1.84;
  let m = vec2f(abs(x), (1.0 - s.uv.x) * 0.84);
  let aa = max(fwu.x * 0.84, fwu.y * 1.84);
  var c = s.color;
  c = mix(c, mix(vec3f(0.025), vec3f(0.09), step(0.85, fract(s.uv.y * 12.0))), cover(m.y - 0.2, aa));
  c = mix(c, vec3f(0.018), cover(max(abs(m.x - 0.8) - 0.11, m.y - 0.17 + 0.25 * max(0.0, abs(m.x - 0.8) - 0.05)), aa));
  let ex = length(vec2f(x - 0.55, m.y - 0.26));
  c = mix(c, mix(vec3f(0.5, 0.48, 0.45), vec3f(0.01), cover(ex - 0.042, aa)), cover(ex - 0.058, aa));
  c = mix(c, vec3f(0.12, 0.01, 0.01), cover(max(abs(m.y - 0.7) - 0.07, abs(m.x - 0.7) - 0.18), aa));
  var lit = cover(max(abs(m.y - 0.7) - 0.045, abs(m.x - 0.72) - 0.15), aa);
  lit = max(lit, cover(max(abs(m.y - 0.3) - 0.03, m.x - 0.035), aa));
  c = mix(c, vec3f(1.0, 0.04, 0.02), lit);
  s.emissive = lit * mix(1.5, 6.0, nightOf(s.t));
  let np = vec2f(x, m.y - 0.48);
  if (abs(np.x) < 0.2 && abs(np.y) < 0.12) {
    c = mix(vec3f(0.9), vec3f(0.02), number7(vec2f(np.x / 0.32 + 0.5, np.y / 0.2 + 0.5), f32(s.tag & 127u), 2));
  }
  s.color = c;
  return s;
}
// windscreen (uv.x 0 at its foot .. 1 at the roof) and rear window (uv.x 0 at
// the roof .. 1 at its foot): glass in a frame of paint, a sun strip, and the
// helmet of the driver, who sits on the left
fn carGlass(sIn: Surface, fwu: vec2f, back: bool) -> Surface {
  var s = sIn;
  let q = s.uv;
  let up = select(q.x * 0.42, (1.0 - q.x) * 0.31, back);   // height above the glass's foot
  let frame = max(max(abs(q.y - 0.5) * 1.84 - 0.84, 0.035 - up), up - select(0.38, 0.27, back));
  if (frame < 0.0) {
    var c = vec3f(0.018, 0.022, 0.028);
    s.gloss = 0.92;
    if (!back && up > 0.31) { c = carAccent(s.color) * 0.8; s.gloss = 0.5; }
    let hp = vec2f((q.y - 0.3) * 1.84, up - select(0.21, 0.08, back));
    if (length(hp * vec2f(1.0, 1.1)) < 0.13) {
      c = helmetColor(f32(s.tag & 127u)) * 0.45;
      if (!back && abs(hp.y) < 0.035) { c = vec3f(0.01); }
      s.gloss = 0.7;
    }
    s.color = c;
  }
  return s;
}
// bonnet, boot and roof: twin stripes, the number on the roof, louvres and
// pins on the bonnet (uv.x 0 at the nose .. 1 at the windscreen, 1.31 m)
fn carTop(sIn: Surface, fwu: vec2f, roof: bool, bonnet: bool) -> Surface {
  var s = sIn;
  let x = (s.uv.y - 0.5) * 1.84;
  var c = mix(s.color, carAccent(s.color), cover(abs(abs(x) - 0.12) - 0.05, fwu.y * 1.84));
  if (bonnet) {
    let along = s.uv.x * 1.31;
    if (abs(abs(x) - 0.48) < 0.13 && abs(along - 0.8) < 0.2) { c = mix(c * 0.35, vec3f(0.02), step(0.5, fract(along / 0.05))); }
    c = mix(c, vec3f(0.05), step(length(vec2f(abs(x) - 0.72, along - 0.18)), 0.022));
  }
  if (roof) {
    let np = vec2f(x, (0.5 - s.uv.x) * 1.05);
    if (abs(np.x) < 0.3 && abs(np.y) < 0.33) {
      c = mix(vec3f(0.9), vec3f(0.02), number7(vec2f(np.x / 0.5 + 0.5, np.y / 0.5 + 0.5), f32(s.tag & 127u), 2));
    }
  }
  s.color = c;
  return s;
}
// the coaches' sides: uv = (forward, up) in metres; the doors are on the right
fn busSide(sIn: Surface, aa: f32) -> Surface {
  var s = sIn;
  let q = s.uv;
  let n = nightOf(s.t);
  var c = s.color;
  c = mix(c, carAccent(s.color), cover(abs(q.y - 1.2) - 0.07, aa));
  c = mix(c, vec3f(0.06), cover(q.y - 0.25, aa));
  let bx = abs(fract((q.x - 0.2) / 1.8) - 0.5) * 1.8;
  c = mix(c, c * 0.45, cover(0.9 - bx - 0.008, aa) * step(abs(q.x), 3.0) * step(0.3, q.y) * step(q.y, 1.08));
  let glassCol = mix(vec3f(0.02, 0.025, 0.03), vec3f(0.95, 0.8, 0.55), n);
  if (q.y > 1.35 && q.y < 2.75 && q.x > -5.6 && q.x < 5.7) {
    c = vec3f(0.03);
    if (fract(q.x / 1.5) > 0.1 && q.y > 1.4 && q.y < 2.7) {
      c = glassCol;
      s.emissive = n * 1.3;
      s.gloss = 0.85;
    }
  }
  if ((s.tag & 128u) == 0u) {
    let dx = min(abs(q.x - 5.0), abs(q.x + 0.1));
    if (dx < 0.5 && q.y > 0.3 && q.y < 2.78) {
      c = vec3f(0.03);
      if (dx < 0.45 && dx > 0.03 && q.y > 0.36 && q.y < 2.72) { c = glassCol; s.emissive = n * 1.3; s.gloss = 0.85; }
    }
  }
  let d = q - vec2f(select(-3.7, 3.9, q.x > 0.0), 0.5);
  let r = length(d);
  if (r < 0.58) {
    c = mix(c, vec3f(0.01), cover(r - 0.56, aa));
    var w = vec3f(0.03);
    if (r < 0.32) {
      let arc = (fract(atan2(d.y, d.x) * 1.5915) - 0.5) * 0.6283 * r;
      w = mix(vec3f(0.55, 0.56, 0.58), vec3f(0.25), cover(abs(r - 0.24) - 0.025, aa));
      w = mix(w, vec3f(0.12), cover(length(vec2f(arc, r - 0.15)) - 0.018, aa));
    }
    c = mix(c, w, cover(r - 0.5, aa));
    s.gloss = select(0.15, 0.5, r < 0.3);
  }
  s.color = c;
  return s;
}
// the coaches' ends, by tag: 1 lower front, 2 windscreen, 3 upper rear, 4 lower rear
fn busEnd(sIn: Surface, fwu: vec2f) -> Surface {
  var s = sIn;
  let q = s.uv;
  let x = (q.y - 0.5) * 2.5;
  let ax = abs(x);
  let tag = s.tag & 127u;
  let aa = max(fwu.x * 1.5, fwu.y * 2.5);
  let n = nightOf(s.t);
  var c = s.color;
  var e = 0.0;
  if (tag == 1u) {
    let up = q.x * 1.02;
    c = mix(c, vec3f(0.1), cover(up - 0.28, aa));
    c = mix(c, mix(vec3f(0.02), vec3f(0.1), step(0.6, fract(up * 20.0))), cover(max(ax - 0.55, abs(up - 0.62) - 0.16), aa));
    let lit = cover(min(length(vec2f(ax - 0.98, up - 0.62)) - 0.09, length(vec2f(ax - 0.76, up - 0.62)) - 0.07), aa);
    c = mix(c, vec3f(1.0, 0.97, 0.9), lit);
    e = lit * mix(1.5, 14.0, n);
    let pl = max(ax - 0.26, abs(up - 0.18) - 0.055);
    c = mix(c, vec3f(0.88), cover(pl, aa));
    c = mix(c, vec3f(0.05), cover(pl + 0.015, aa) * step(0.45, fract(x / 0.07)));
  } else if (tag == 2u) {
    let up = q.x * 1.85;
    if (ax < 1.15 && up > 0.06 && up < 1.78) {
      c = vec3f(0.02, 0.025, 0.03);
      s.gloss = 0.9;
      if (up > 1.5 && ax < 1.0) {
        c = vec3f(0.01);
        s.gloss = 0.4;
        // (seen from the front, the coach's +x is on the left: xv runs to the viewer's right)
        let xv = -x;
        let dots = step(0.45, hash21(floor(vec2f(xv / 0.05, up / 0.05)))) * step(1.55, up) * step(up, 1.72) * step(-0.45, xv) * step(xv, 0.95);
        let route = number7(vec2f((xv + 0.95) / 0.4, (up - 1.53) / 0.2), 42.0, 2);
        let on = max(dots, route);
        c = mix(c, vec3f(1.0, 0.6, 0.1), on);
        e = on * 3.0;
      }
      c = mix(c, vec3f(0.03), cover(sdSegment(vec2f(ax, up), vec2f(0.15, 0.12), vec2f(0.85, 0.5)) - 0.012, aa));
      // the driver, on the left (x < 0), behind the dashboard
      let dv = vec2f(x + 0.62, up);
      let driver = max(cover(length((dv - vec2f(0.0, 0.5)) * vec2f(1.0, 0.8)) - 0.27, aa), cover(length(dv - vec2f(0.0, 0.95)) - 0.12, aa));
      c = mix(c, vec3f(0.055, 0.058, 0.062), driver * step(up, 1.5));
    }
  } else if (tag == 3u) {
    let z = 3.25 - q.x * 2.15;
    if (ax < 1.1 && z > 2.0 && z < 3.05) { c = vec3f(0.02, 0.025, 0.03); s.gloss = 0.9; }
    if (ax < 0.9 && z > 1.25 && z < 1.85) { c = mix(vec3f(0.03), c * 0.6, step(0.5, fract(z * 12.0))); }
  } else {
    let z = 1.1 - q.x * 1.02;
    c = mix(c, vec3f(0.1), cover(z - 0.3, aa));
    let lit = cover(max(abs(ax - 1.08) - 0.08, abs(z - 0.72) - 0.3), aa);
    c = mix(c, vec3f(1.0, 0.04, 0.02), lit);
    e = lit * mix(1.0, 6.0, n);
    c = mix(c, vec3f(0.88), cover(max(ax - 0.26, abs(z - 0.5) - 0.055), aa));
  }
  s.color = c;
  s.emissive = e;
  return s;
}

// ---- trains: painted detail (see expressGeo and freightGeo)
// a coach's side, uv 0..1 over 24.2 m by 3.65 m: skirt, stripe, doors at both
// ends, eight windows with frames and top lights (lit at night)
fn coachSide(sIn: Surface, aa: f32) -> Surface {
  var s = sIn;
  let L = vec2f(s.uv.x * 24.2, s.uv.y * 3.65);
  let n = nightOf(s.t);
  var c = s.color;
  c = mix(c, vec3f(0.25, 0.26, 0.28), cover(L.y - 0.4, aa));
  c = mix(c, vec3f(0.75, 0.13, 0.1), cover(abs(L.y - 1.4) - 0.14, aa));
  c = mix(c, c * 0.8, cover(abs(L.y - 3.45) - 0.03, aa));
  let glass = mix(vec3f(0.02, 0.025, 0.03), vec3f(1.0, 0.86, 0.62), n);
  let dd = min(abs(L.x - 1.55), abs(L.x - 22.65));
  if (dd < 0.64) {
    let inDoor = step(0.3, L.y) * step(L.y, 3.05);
    c = mix(c, c * 0.3, cover(abs(dd - 0.6) - 0.015, aa) * inDoor);
    c = mix(c, c * 0.3, cover(abs(L.y - 3.05) - 0.015, aa) * step(dd, 0.6));
    c = mix(c, c * 0.4, cover(dd - 0.012, aa) * inDoor);
    if (dd > 0.06 && dd < 0.42 && L.y > 1.9 && L.y < 2.85) { c = glass; s.emissive = n * 1.5; s.gloss = 0.85; }
  } else if (L.x > 2.6 && L.x < 21.6 && L.y > 1.72 && L.y < 2.88) {
    let wx = fract((L.x - 2.6) / 2.375) * 2.375;
    c = vec3f(0.5, 0.52, 0.55);
    if (wx > 0.22 && wx < 2.2 && L.y > 1.8 && L.y < 2.8 && abs(L.y - 2.52) > 0.025) {
      c = glass; s.emissive = n * 1.5; s.gloss = 0.85;
    }
  }
  s.color = c;
  return s;
}
// the power car's sides, uv = (forward, up) in metres: cab window and door, grilles
fn trainCab(sIn: Surface, aa: f32) -> Surface {
  var s = sIn;
  let q = s.uv;
  var c = s.color;
  c = mix(c, vec3f(0.25, 0.26, 0.28), cover(q.y - 0.95, aa));
  c = mix(c, vec3f(0.75, 0.13, 0.1), cover(abs(q.y - 1.95) - 0.14, aa));
  let win = max(abs(q.x + 3.6) - 0.8, abs(q.y - 2.95) - 0.5);
  c = mix(c, vec3f(0.05), cover(win - 0.05, aa));
  if (win < 0.0) { c = vec3f(0.02, 0.025, 0.03); s.gloss = 0.9; }
  let door = max(abs(q.x + 5.6) - 0.45, abs(q.y - 2.2) - 1.45);
  c = mix(c, c * 0.35, cover(abs(door) - 0.012, aa));
  c = mix(c, vec3f(0.02, 0.025, 0.03), cover(max(abs(q.x + 5.6) - 0.25, abs(q.y - 3.0) - 0.35), aa));
  let gx = fract((q.x + 21.0) / 2.2) * 2.2;
  if (q.x > -21.0 && q.x < -7.8 && q.y > 2.55 && q.y < 3.75 && gx > 0.15 && gx < 2.05) {
    c = mix(vec3f(0.2, 0.21, 0.22), vec3f(0.45, 0.46, 0.48), step(0.5, fract(q.y * 12.0)));
  }
  s.color = c;
  return s;
}
// the ends, by tag: 1 the express's lower nose, 2 its sloping nose, 3 the tail
// of its last coach, 4 the freight locomotive's cab ends
fn trainEnd(sIn: Surface, fwu: vec2f) -> Surface {
  var s = sIn;
  let q = s.uv;
  let n = nightOf(s.t);
  var c = s.color;
  var e = 0.0;
  if (s.tag == 1u) {
    let m = vec2f(abs(q.y - 0.5) * 3.0, q.x * 0.95);
    let aa = max(fwu.x * 0.95, fwu.y * 3.0);
    c = mix(c, vec3f(0.15), cover(m.y - 0.18, aa));
    c = mix(c, vec3f(0.06), cover(max(abs(m.x - 1.07) - 0.25, abs(m.y - 0.55) - 0.16), aa));
    let lit = cover(length(m - vec2f(1.0, 0.55)) - 0.11, aa);
    c = mix(c, vec3f(1.0, 0.97, 0.9), lit);
    c = mix(c, vec3f(0.3, 0.02, 0.02), cover(length(m - vec2f(1.24, 0.55)) - 0.05, aa));
    c = mix(c, vec3f(0.08), cover(max(m.x - 0.35, abs(m.y - 0.36) - 0.14), aa));
    e = lit * mix(2.0, 14.0, n);
  } else if (s.tag == 2u) {
    let m = vec2f(abs(q.y - 0.5) * 3.0, q.x * 5.3);
    let aa = max(fwu.x * 5.3, fwu.y * 3.0);
    c = mix(c, vec3f(0.75, 0.13, 0.1), cover(abs(m.y - 0.55 - m.x * 0.5) - 0.18, aa));
    let screen = max(m.x - 1.25 + (m.y - 2.0) * 0.1, abs(m.y - 2.6) - 0.75);
    if (screen < 0.06) {
      c = mix(vec3f(0.05), vec3f(0.02, 0.025, 0.03), cover(screen, aa));
      s.gloss = 0.9;
      c = mix(c, vec3f(0.06), cover(sdSegment(m, vec2f(0.1, 1.95), vec2f(0.8, 2.6)) - 0.02, aa));
    }
    let top = cover(max(m.x - 0.35, abs(m.y - 4.3) - 0.08), aa);
    c = mix(c, vec3f(1.0, 0.97, 0.9), top);
    e = top * mix(2.0, 12.0, n);
  } else if (s.tag == 3u) {
    let m = vec2f(abs(q.x - 0.5) * 3.0, q.y * 3.65);
    let aa = max(fwu.x * 3.0, fwu.y * 3.65);
    c = mix(c, vec3f(0.06), cover(max(m.x - 0.5, abs(m.y - 1.6) - 1.3), aa));
    c = mix(c, vec3f(0.02, 0.025, 0.03), cover(max(m.x - 0.32, abs(m.y - 2.2) - 0.4), aa));
    let lit = cover(length(m - vec2f(1.15, 0.45)) - 0.09, aa);
    c = mix(c, vec3f(1.0, 0.04, 0.02), lit);
    e = lit * mix(2.0, 8.0, n);
  } else {
    let m = vec2f(abs(q.x - 0.5) * 3.0, q.y * 4.0);
    let aa = max(fwu.x * 3.0, fwu.y * 4.0);
    c = mix(c, vec3f(0.95, 0.75, 0.1), step(abs(m.y - 0.75), 0.25) * step(0.5, fract((q.x * 3.0 + m.y) * 1.5)));
    let win = max(abs(m.x - 0.75) - 0.6, abs(m.y - 2.9) - 0.45);
    c = mix(c, vec3f(0.03), cover(win - 0.06, aa));
    c = mix(c, vec3f(0.02, 0.025, 0.03), cover(win, aa));
    if (win < 0.0) { s.gloss = 0.9; }
    let lit = cover(length(m - vec2f(1.05, 1.5)) - 0.1, aa);
    c = mix(c, vec3f(1.0, 0.97, 0.9), lit);
    e = lit * mix(2.0, 12.0, n);
  }
  s.color = c;
  s.emissive = e;
  return s;
}
// a bogie's sides (uv 0..1 over 2.8 m by 0.42 m, 0.2 m above the origin): two
// wheels on the rails, the lower half of each showing under the body
fn bogieSide(sIn: Surface, aa: f32) -> Surface {
  var s = sIn;
  let L = vec2f(s.uv.x * 2.8, s.uv.y * 0.42 + 0.2);
  let r = length(vec2f(min(abs(L.x - 0.6), abs(L.x - 2.2)), L.y - 0.59));
  var c = s.color;
  if (r < 0.33) {
    c = mix(vec3f(0.42, 0.42, 0.43), vec3f(0.1), cover(r - 0.28, aa));
    c = mix(c, vec3f(0.32), cover(r - 0.08, aa));
    s.gloss = 0.5;
  }
  c = mix(c, vec3f(0.55, 0.45, 0.1), cover(max(abs(L.x - 1.4) - 0.22, abs(L.y - 0.45) - 0.08), aa));
  s.color = c;
  return s;
}
// the freight locomotive's sides (uv 0..1 over 19 m by 4 m): cabs at both ends, grilles
fn locoSide(sIn: Surface, aa: f32) -> Surface {
  var s = sIn;
  let L = vec2f(s.uv.x * 19.0, s.uv.y * 4.0);
  var c = s.color;
  c = mix(c, vec3f(0.95, 0.75, 0.1), cover(abs(L.y - 0.55) - 0.1, aa));
  c = mix(c, vec3f(0.18), cover(L.y - 0.35, aa));
  let ex = min(L.x, 19.0 - L.x);
  if (ex < 2.6) {
    let win = max(abs(ex - 1.5) - 0.55, abs(L.y - 2.85) - 0.45);
    c = mix(c, vec3f(0.03), cover(win - 0.05, aa));
    if (win < 0.0) { c = vec3f(0.02, 0.025, 0.03); s.gloss = 0.9; }
    c = mix(c, c * 0.4, cover(abs(ex - 0.55) - 0.012, aa) * step(0.6, L.y) * step(L.y, 3.5));
  } else {
    let gx = fract((L.x - 2.6) / 1.38) * 1.38;
    if (L.y > 2.3 && L.y < 3.6 && gx > 0.12) { c = mix(c * 0.5, c * 0.8, step(0.5, fract(L.y * 10.0))); }
  }
  s.color = c;
  return s;
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  let fwu = fwidth(s.uv);
  let m = s.mat;
  // The land's shadow, for the sun as it stands at this surface's own time.
  // Tall things (s.aux: their height above the land in hundreds of metres)
  // see over nearer hills.
  let lift = select(max(s.aux, 0.0), 0.0, m == ${MAT.SEA}u) * 100.0;
  s.sun *= landSunAt(s.pos, envSun(s.t).dir, lift);
  if (m == ${MAT.TERRAIN}u || m == ${MAT.VERGE}u) {
    s.color *= groundDetail(s.pos.xy, s.dist);
    s.color *= 1.0 - 0.3 * (1.0 - smoothstep(0.15, 1.1, s.pos.z));
    if (m == ${MAT.VERGE}u) { s.light += trackLight(s.uv.x, s.uv.y, s.t) * smoothstep(15.0, 10.5, abs(s.uv.x)); }
    if (s.pos.z < 0.0) {
      // the seabed, seen through the shallows: wet sand, darker with depth
      // (from the depth rather than the coarse vertex colours), under the
      // moving light of the ripples above it
      let dz = -s.pos.z;
      s.color = mix(vec3f(0.50, 0.42, 0.24), vec3f(0.20, 0.21, 0.15), smoothstep(0.0, 7.0, dz)) * groundDetail(s.pos.xy, s.dist);
      let cq = s.pos.xy * 0.26 + vec2f(s.t * 0.2, s.t * 0.08);
      let caustic = pow(1.0 - abs(noise2(cq) - noise2(cq * 1.37 + vec2f(4.1, -2.3))), 10.0);
      s.sun *= 0.85 + 0.6 * caustic * (1.0 - smoothstep(1.0, 7.0, dz)) * (1.0 - smoothstep(80.0, 300.0, s.dist));
    }
  } else if (m == ${MAT.ROAD}u) {
    let kerbZone = s.color.r;
    let u = s.uv.x;
    let v = s.uv.y;
    let au = abs(u);
    let grain = noise2(s.pos.xy * 1.7) * 0.5 + noise2(s.pos.xy * 0.21) * 0.5;
    var col = vec3f(0.085, 0.088, 0.094) * (0.82 + 0.36 * grain);
    col *= 1.0 - 0.13 * aaBand(fract(au / 3.0) - 0.5, 0.16, 0.08) * step(au, 6.0);
    col = mix(col, vec3f(0.115, 0.112, 0.108) * (0.85 + 0.3 * grain), step(6.0, au));
    let fu = max(fwu.x, 0.003);
    var mk = aaBand(au - 5.85, 0.1, fu);
    mk = max(mk, aaBand(au - 3.0, 0.075, fu) * step(fract(v / 12.0), 0.5));
    mk = max(mk, aaBand(au - 0.2, 0.07, fu));
    col = mix(col, vec3f(0.8, 0.8, 0.76), mk * step(au, 6.0) * 0.92);
    if (kerbZone > 0.5 && au > 6.0 && au < 7.4) {
      col = mix(vec3f(0.6, 0.045, 0.035), vec3f(0.8, 0.8, 0.78), step(0.5, fract(v / 2.5)));
    }
    // the starting grid: fourteen numbered slots, staggered, in the two lanes that run with the lap
    let gv = S_LINE - v;
    if (gv > 8.0 && gv < 120.0 && u > 0.0 && u < 6.0) {
      let k = floor((gv - 8.0) / 8.0);
      let f = gv - 8.0 - k * 8.0;
      let du = u - select(1.5, 4.5, fract(k * 0.5) > 0.25);
      var gm = aaBand(f - 0.07, 0.07, fu) * step(abs(du), 1.1);
      gm = max(gm, aaBand(abs(du) - 1.05, 0.06, fu) * step(f, 1.2));
      gm = max(gm, number7(vec2f((du + 0.55) / 1.1, (3.4 - f) / 1.8), k + 1.0, 2));
      col = mix(col, vec3f(0.8, 0.8, 0.76), gm * 0.92);
    }
    let dv = v - S_LINE;
    if (abs(dv) < 1.6 && au < 6.0) {
      let ch = fract((floor(u / 0.8) + floor(dv / 0.8)) * 0.5) * 2.0;
      col = mix(vec3f(0.02), vec3f(0.85), ch);
    }
    s.color = col;
    s.gloss = 0.16;
    s.light += trackLight(u, v, s.t);
  } else if (m == ${MAT.SEA}u) {
    let p = s.pos.xy;
    let t = s.t;
    let fade = 1.0 / (1.0 + s.dist / 260.0);
    var g = waveGrad(p, vec2f(-0.96, 0.28), 0.21, 1.4, t) * 0.032;
    g += waveGrad(p, vec2f(-0.80, -0.60), 0.34, 1.8, t) * 0.022;
    g += waveGrad(p, vec2f(-0.55, 0.83), 0.55, 2.3, t) * 0.014;
    let q = p * 0.4 + vec2f(-t * 0.3, t * 0.1);
    g += vec2f(noise2(q + vec2f(0.5, 0.0)) - noise2(q - vec2f(0.5, 0.0)), noise2(q + vec2f(0.0, 0.5)) - noise2(q - vec2f(0.0, 0.5))) * 0.12;
    g *= fade;
    s.n = normalize(vec3f(-g.x, -g.y, 1.0));
    let off = p.x - coastX(p.y);
    let shallow = 1.0 - smoothstep(10.0, 160.0, off);
    var col = mix(vec3f(0.010, 0.055, 0.085), vec3f(0.04, 0.17, 0.17), shallow);
    let surfZone = 1.0 - smoothstep(4.0, 45.0, off);
    let crest = smoothstep(0.8, 0.97, fract(off / 15.0 + t / 6.0)) * surfZone;
    let foam = max(crest, 1.0 - smoothstep(0.0, 6.0, off)) * (0.55 + 0.45 * noise2(p * 0.35 + vec2f(t * 0.2, 0.0)));
    s.color = mix(col, vec3f(0.85, 0.88, 0.86), foam * 0.85);
    s.gloss = mix(0.9, 0.15, foam);
    // Near the shore the water is see-through (that band is a blended mesh,
    // see build()): the sand shows, the less the deeper it lies (the seabed
    // falls 1 m in 20, as in landHeight), and at a glancing angle the water
    // mirrors instead.  By 190 m out it is opaque, like the rest of the sea.
    let depth = (1.5 + 0.05 * off) * smoothstep(3.0, 25.0, off);
    let fres = 0.04 + 0.96 * pow(1.0 - max(dot(s.n, -s.view), 0.0), 5.0);
    let clear = exp(-depth / 2.5) * (1.0 - smoothstep(150.0, 190.0, off));
    s.alpha = max(1.0 - clear * (1.0 - fres), foam * 0.85);
  } else if (m == ${MAT.DISPLAY}u) {
    let on = timeDisplay((s.uv - vec2f(0.05, 0.15)) / vec2f(0.9, 0.7), s.t);
    s.color = mix(vec3f(0.012, 0.013, 0.016), s.color, on);
    s.emissive = on * 5.0;
    s.gloss = 0.45;
  } else if (m == ${MAT.LAMP}u) {
    s.emissive = 0.1 + 12.0 * lampsOn(s.t);
  } else if (m == ${MAT.BEAM}u) {
    let d = length(s.pos.xy - LH);
    let n = smoothstep(0.25, 0.8, nightOf(s.t));
    s.emissive = n * (0.06 + 0.8 * exp(-d / 25.0)) * exp(-d / 600.0);
  } else if (m == ${MAT.LANTERN}u) {
    let n = nightOf(s.t);
    let a = TAU * s.t / BEAM_T;
    let toEye = normalize(-s.view.xy + vec2f(1e-5, 0.0));
    let fl = pow(abs(dot(toEye, vec2f(sin(a), cos(a)))), 80.0);
    // the glazing bars
    let gb = max(step(fract(s.uv.x * 12.0 + 0.5), 0.07), step(abs(s.uv.y - 0.55), 0.03));
    s.color = mix(vec3f(1.0, 0.92, 0.7), vec3f(0.08), gb);
    s.emissive = (0.4 + n * (4.0 + 40.0 * fl)) * (1.0 - gb);
  } else if (m == ${MAT.CHASE}u) {
    let q = fract((s.uv.y - CHASE_V * s.t) / CHASE_SP);
    s.emissive = 0.3 + 10.0 * pow(q, 14.0);
  } else if (m == ${MAT.HOUSE}u) {
    if (s.tag != 0u) {
      // a wall: windows evenly across it (the copy's number holds how many
      // fit across the width and the depth, and a seed; see the houses)
      let code = u32(s.inst.w + 0.5);
      let cols = f32(select((code >> 4u) & 15u, code & 15u, (s.tag & 1u) == 1u));
      let cx = floor(s.uv.x * cols);
      let fx = fract(s.uv.x * cols);
      let fy = s.uv.y * 2.0;
      let row = floor(fy);
      let gy = fract(fy);
      let inWin = fx > 0.32 && fx < 0.68 && gy > 0.32 && gy < 0.78 && row < 2.0;
      if (inWin) {
        let h = hash21(vec2f(cx + f32(s.tag) * 5.0, row) + f32(code >> 8u) * 7.31);
        let lit = step(h, nightOf(s.t) * 0.9 - 0.08);
        s.color = mix(vec3f(0.07, 0.065, 0.06), vec3f(1.0, 0.72, 0.42), lit);
        s.emissive = lit * 1.8;
        s.gloss = 0.5;
        // the window's cross bars
        if (abs(fx - 0.5) < 0.012 || abs(gy - 0.6) < 0.015) { s.color = vec3f(0.6, 0.58, 0.54); s.emissive = 0.0; s.gloss = 0.2; }
      } else if (row < 2.0 && gy > 0.28 && gy < 0.78 && fx > 0.19 && fx < 0.81) {
        // a stone sill under each window, and louvred shutters either side
        // (green or blue, the same on the whole house)
        if (gy < 0.32) {
          s.color = vec3f(0.72, 0.69, 0.63);
        } else if (fx < 0.3 || fx > 0.7) {
          let blue = hash11(f32(code >> 8u) * 1.37) > 0.5;
          s.color = select(vec3f(0.12, 0.3, 0.17), vec3f(0.14, 0.25, 0.45), blue) * (0.75 + 0.25 * step(0.5, fract(gy * 36.0)));
          s.gloss = 0.25;
        }
      }
    }
  } else if (m == ${MAT.CAR_SIDE}u) {
    s = carSide(s, max(fwu.x, fwu.y));
  } else if (m == ${MAT.CAR_FRONT}u) {
    s = carFront(s, fwu);
  } else if (m == ${MAT.CAR_REAR}u) {
    s = carRear(s, fwu);
  } else if (m == ${MAT.CAR_SCREEN}u || m == ${MAT.CAR_BACKGLASS}u) {
    s = carGlass(s, fwu, m == ${MAT.CAR_BACKGLASS}u);
  } else if (m == ${MAT.CAR_TOP}u || m == ${MAT.CAR_ROOF}u || m == ${MAT.CAR_BONNET}u) {
    s = carTop(s, fwu, m == ${MAT.CAR_ROOF}u, m == ${MAT.CAR_BONNET}u);
  } else if (m == ${MAT.BUS_SIDE}u) {
    s = busSide(s, max(fwu.x, fwu.y));
  } else if (m == ${MAT.BUS_END}u) {
    s = busEnd(s, fwu);
  } else if (m == ${MAT.TRAIN}u) {
    if (abs(s.n.z) < 0.5 && abs(s.n.y) < 0.6) { s = coachSide(s, max(fwu.x * 24.2, fwu.y * 3.65)); }
  } else if (m == ${MAT.TRAIN_CAB}u) {
    s = trainCab(s, max(fwu.x, fwu.y));
  } else if (m == ${MAT.TRAIN_END}u) {
    s = trainEnd(s, fwu);
  } else if (m == ${MAT.BOGIE}u) {
    if (abs(s.n.x) > 0.5) { s = bogieSide(s, max(fwu.x * 2.8, fwu.y * 0.42)); }
  } else if (m == ${MAT.LOCO}u) {
    if (abs(s.n.x) > 0.5) { s = locoSide(s, max(fwu.x * 19.0, fwu.y * 4.0)); }
  } else if (m == ${MAT.MARKER}u) {
    // a white plate with a number: the boards' distance along the straight
    // (the copy's number), or the hundreds of metres to the bend (the tag)
    let v = select(s.inst.w, f32(s.tag) * 100.0, s.tag != 0u);
    let on = number7((s.uv - vec2f(0.08, 0.18)) / vec2f(0.84, 0.64), v, select(4, 3, s.tag != 0u));
    s.color = mix(s.color, vec3f(0.02), on);
    if (s.tag != 0u) { s.color = mix(s.color, vec3f(0.75, 0.1, 0.06), step(s.uv.y, 0.1) + step(0.9, s.uv.y)); }
  } else if (m == ${MAT.TYRES}u) {
    // a stack of four tyres: grooves between them, the holes in the top
    if (s.n.z < 0.5) {
      let f = fract(s.uv.y * 4.0);
      s.color *= 0.35 + 0.65 * smoothstep(0.0, 0.08, min(f, 1.0 - f));
      s.color = s.color * 0.9 + 0.012;
    } else {
      s.color = mix(vec3f(0.006), s.color, smoothstep(0.17, 0.2, length(s.uv - 0.5)));
    }
  } else if (m == ${MAT.BASKET}u) {
    // wicker, with a padded leather rim
    let cell = floor(s.uv * vec2f(14.0, 10.0));
    let w = fract(s.uv * vec2f(14.0, 10.0));
    let shade = mix(abs(w.x - 0.5), abs(w.y - 0.5), fract((cell.x + cell.y) * 0.5) * 2.0) * 2.0;
    s.color *= 0.75 + 0.35 * (1.0 - shade * shade);
    if (abs(s.n.z) < 0.5 && s.uv.y > 0.86) { s.color = vec3f(0.12, 0.06, 0.03); }
  } else if (m == ${MAT.FLAME}u) {
    // the burner's flame, in the same rhythm as BALLOON's glow (the tag holds the seed)
    let ph = fract(s.t / 9.0 + f32(s.tag) / 255.0);
    let burn = smoothstep(0.86, 0.9, ph) * (1.0 - smoothstep(0.96, 1.0, ph));
    s.emissive = (0.03 + 5.0 * burn) * (1.0 - 0.8 * s.uv.y);
  } else if (m == ${MAT.GONDOLA}u) {
    if (abs(s.n.z) < 0.5 && s.uv.y > 0.42 && s.uv.y < 0.8 && fract(s.uv.x * 7.0) > 0.12) {
      let n = nightOf(s.t);
      s.color = mix(vec3f(0.02, 0.025, 0.03), vec3f(1.0, 0.86, 0.62), n);
      s.emissive = n * 1.5;
      s.gloss = 0.85;
    }
  } else if (m == ${MAT.HULL}u) {
    // a yacht's sides, uv = (forward, up) in metres: cove stripe, antifouling, portholes
    let q = s.uv;
    var c = mix(s.color, vec3f(0.08, 0.2, 0.45), step(abs(q.y - 1.08), 0.06));
    c = mix(c, vec3f(0.55, 0.1, 0.08), step(q.y, 0.22));
    let px = fract((q.x + 0.5) / 1.1) * 1.1 - 0.55;
    if (q.x > -2.2 && q.x < 1.8) { c = mix(c, vec3f(0.03), step(length(vec2f(px, q.y - 0.75)), 0.08)); }
    s.color = c;
  } else if (m == ${MAT.CONE}u) {
    s.color = mix(s.color, vec3f(0.92), step(abs(s.uv.y - 0.5), 0.1));
  } else if (m == ${MAT.CONTAINER}u) {
    if (abs(s.n.z) < 0.5) {
      let along = abs(s.n.x) > 0.5;
      s.color *= 0.8 + 0.2 * step(0.5, fract(s.uv.x * select(9.0, 62.0, along)));
      s.color *= 1.0 - 0.45 * (step(s.uv.y, 0.05) + step(0.95, s.uv.y) + step(min(s.uv.x, 1.0 - s.uv.x), select(0.05, 0.008, along)));
    }
  } else if (m == ${MAT.CROWD}u) {
    s.light += vec3f(1.0, 0.92, 0.78) * (0.4 * lampsOn(s.t));
    if (s.n.z > 0.6) {
      let cell = floor(vec2f(s.pos.y / 0.6, s.pos.x / 1.1));
      let h = hash21(cell);
      let shirt = vec3f(hash21(cell + 1.7), hash21(cell + 5.3), hash21(cell + 9.1)) * 0.75 + 0.12;
      let ph = fract((s.pos.y - 14.0 * s.t) / 150.0) - 0.5;
      let wave = exp(-ph * ph * 700.0);
      var c = select(vec3f(0.06, 0.16, 0.45), shirt * shirt, h < 0.82);
      c = mix(c, min(c * 2.4 + 0.15, vec3f(1.0)), wave * step(h, 0.82));
      s.color = mix(c, vec3f(0.3, 0.28, 0.3), smoothstep(150.0, 600.0, s.dist) * 0.5);
    } else if (s.n.x > 0.6) {
      // the riser faces: rows of seated spectators seen from the track
      let cell = floor(vec2f(s.pos.y / 0.62, s.pos.z / 1.05));
      let h = hash21(cell + 3.3);
      let l = vec2f(fract(s.pos.y / 0.62), fract(s.pos.z / 1.05));
      let shirt = vec3f(hash21(cell + 1.7), hash21(cell + 5.3), hash21(cell + 9.1)) * 0.75 + 0.12;
      let ph = fract((s.pos.y - 14.0 * s.t) / 150.0) - 0.5;
      let wave = exp(-ph * ph * 700.0);
      let rise = 0.3 * wave;
      let head = step(length((l - vec2f(0.5, 0.78 + rise)) * vec2f(1.0, 0.75)), 0.2);
      let body = step(abs(l.x - 0.5), 0.36) * step(l.y, 0.62 + rise);
      var c = vec3f(0.06, 0.16, 0.45);
      if (h < 0.85) { c = mix(mix(c, shirt * shirt, body), vec3f(0.62, 0.45, 0.33), head); }
      s.color = mix(c, vec3f(0.3, 0.28, 0.3), smoothstep(150.0, 600.0, s.dist) * 0.6);
    } else {
      s.color = vec3f(0.5, 0.49, 0.46);
    }
    // aisles every 20 m: bare concrete steps
    if (abs(fract(s.pos.y / 20.0) - 0.5) * 20.0 > 9.25) { s.color = select(vec3f(0.58, 0.57, 0.53), vec3f(0.47, 0.46, 0.43), s.n.x > 0.6); }
  } else if (m == ${MAT.CHEVRON}u) {
    // red and white chevrons pointing left (number 1) or right (2)
    let px = select(1.0 - s.uv.x, s.uv.x, s.inst.w > 1.5) * 1.2;
    let k = px + abs(s.uv.y - 0.5) * 0.9;
    s.color = mix(vec3f(0.75, 0.05, 0.04), vec3f(0.9), step(0.5, fract(k / 0.4)));
    s.gloss = 0.3;
  } else if (m == ${MAT.ROOF}u) {
    // rows of half-round tiles, a little uneven, fading out with distance
    let row = floor(s.uv.y * 13.0);
    let fu = fract(s.uv.x * 64.0 + row * 0.5);
    let fv = fract(s.uv.y * 13.0);
    let near = 1.0 - smoothstep(40.0, 120.0, s.dist);
    s.color *= 1.0 - near * (0.3 * (1.0 - smoothstep(0.0, 0.18, fv)) + 0.18 * abs(fu - 0.5) * 2.0 - 0.1 * hash21(vec2f(floor(s.uv.x * 64.0 + row * 0.5), row)));
  } else if (m == ${MAT.SAIL}u) {
    // the mainsail (uv 0..1 along its 4.6 m foot and up its 9.6 m luff):
    // battens out to the leech, seams, and the class emblem, a ring
    let q = s.uv * vec2f(4.6, 9.6);
    let leech = (1.0 - s.uv.y) * 4.6;           // how far the leech is from the mast at this height
    let k = clamp(round(q.y / 1.9), 1.0, 4.0);  // the nearest of four battens
    var c = s.color;
    c *= 1.0 - 0.25 * step(abs(q.y - k * 1.9), 0.035) * step(leech - 1.2 * (1.0 - k / 5.0), q.x);
    c *= 1.0 - 0.12 * step(0.9, fract(q.y / 0.9));
    let ring = abs(length(q - vec2f(0.95, 6.1)) - 0.38);
    c = mix(c, vec3f(0.1, 0.25, 0.6), 1.0 - smoothstep(0.06, 0.08, ring));
    s.color = c;
  } else if (m == ${MAT.ARMCO}u) {
    // the W-shaped beam: two ridges catching the light, a valley between them
    s.color *= 0.72 + 0.36 * (0.5 + 0.5 * cos((s.uv.x - 0.25) * 12.566));
  } else if (m == ${MAT.PLANKS}u) {
    // a jetty's deck: planks across it, weathered
    let k = floor(s.pos.x / 0.24);
    let f = fract(s.pos.x / 0.24);
    s.color *= (0.8 + 0.3 * hash11(k)) * (0.45 + 0.55 * smoothstep(0.0, 0.08, min(f, 1.0 - f)));
  } else if (m == ${MAT.BALLOON}u) {
    let seed = s.color.g * 3.7 + s.color.b * 1.3;
    let k = floor(s.uv.x * 12.0);
    let alt = fract(k * 0.5) * 2.0;
    var c = mix(s.color, vec3f(0.93, 0.88, 0.76), alt);
    c = mix(c, vec3f(0.12, 0.1, 0.1), step(0.83, s.uv.y) * step(s.uv.y, 0.88));
    // load tapes down the seams between the gores, the dark skirt round the
    // mouth and the crown ring at the top
    let fg = fract(s.uv.x * 12.0);
    c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.025, min(fg, 1.0 - fg)));
    c = mix(c, vec3f(0.08, 0.075, 0.07), step(s.uv.y, 0.035) + step(0.975, s.uv.y));
    s.color = c;
    let ph = fract(s.t / 9.0 + seed);
    let burn = smoothstep(0.86, 0.9, ph) * (1.0 - smoothstep(0.96, 1.0, ph));
    s.emissive = nightOf(s.t) * (0.08 + 0.9 * burn) * (1.0 - s.uv.y);
  } else if (m == ${MAT.AD}u) {
    var pal = array<vec3f, 4>(vec3f(0.72, 0.05, 0.035), vec3f(0.02, 0.13, 0.45), vec3f(0.85, 0.55, 0.02), vec3f(0.85, 0.85, 0.83));
    let k = i32(floor(s.uv.x)) % 4;
    let fx = fract(s.uv.x);
    var c = pal[k];
    if (s.uv.y > 0.32 && s.uv.y < 0.68 && fx > 0.12 && fx < 0.88 && fract(fx * 9.0) < 0.62) {
      c = select(vec3f(0.92), vec3f(0.04), k == 3);
    }
    s.color = c;
    s.gloss = 0.35;
  } else if (m == ${MAT.RAILBED}u) {
    let across = s.pos.x - RAIL_X;
    let tr = abs(abs(across) - ${f(RAIL_GAUGE)});
    let sl = step(tr, 1.3) * step(fract(s.pos.y / 0.65), 0.38) * (1.0 - smoothstep(40.0, 120.0, s.dist));
    s.color = mix(s.color * (0.8 + 0.4 * noise2(s.pos.xy * 4.0)), vec3f(0.42, 0.4, 0.38), sl * 0.85);
  } else if (m == ${MAT.CHECKER}u) {
    let c = fract((floor(s.uv.x * 6.0) + floor(s.uv.y * 4.0)) * 0.5) * 2.0;
    s.color = mix(vec3f(0.02), vec3f(0.9), c);
  }
  return s;
}
`;

// ------------------------------------------------------------------ scene

const SPAWN_S = 125, SPAWN_T = 30;
const spawnXY = onTrack(SPAWN_S, 4.5);

export default {
  id: 'circuit',
  name: 'Coastal Circuit',
  blurb: 'Drive a 3.6 km seaside road circuit with traffic at 15, 30 and 45 m/s, a train, and clocks along the 1.2 km main straight. Tilt the view and the boards ahead show the past.',
  C,
  accel: 0.8,                // the car gains 6 m/s every second (21.6 km/h), more with Shift
  mode: 'drive',
  modes: ['drive', 'fly', 'walk'],
  spawn: { pos: [spawnXY[0], spawnXY[1], 0], t: SPAWN_T, yaw: 0, pitch: 0 },
  period: PERIOD,
  viewDistance: 2500,
  skyDistance: 4300,
  shadowRadii: [60, 500],
  shadowDepth: 900,
  bloom: 0.35,
  walkSpeed: 3,
  runSpeed: 10,
  ceiling: 1200,
  ground: (x, y) => Math.max(0, Math.max(heightAt(x, y), meshHeight(x, y)) + ROAD_LIFT),
  wgsl,

  // The music (see "Music" in docs/SCENES.md).
  // The Coastal Circuit: driving music.  Four on the floor, a bass in
  // quavers, semiquavers up and down the chords, and a tune the second time
  // round.
  music: {
    seconds: 32, bpm: 120, reverb: 1.6, echo: [0.375, 0.32], seed: 31,
    build(m) {
      const { n, notes, tune } = m;
      const b = m.beat;
      const drums = m.track({ gain: 0.9, hall: 0.08 }), hats = m.track({ pan: 0.25, hall: 0.1 }), low = m.track({});
      const arp = m.track({ pan: -0.3, hall: 0.25, echo: 0.3 }), pads = m.track({ hall: 0.4 });
      const lead = m.track({ pan: 0.15, hall: 0.35, echo: 0.3, vib: [5.5, 9] });
      // two bars to a chord: D, B minor, G, A
      const chords = [['D2', 'D4 F#4 A4'], ['B1', 'B3 D4 F#4'], ['G1', 'G3 B3 D4'], ['A1', 'A3 C#4 E4']];
      for (let bar = 0; bar < 16; bar++) {
        const t0 = bar * 4 * b, [root, tones] = chords[(bar >> 1) % 4], r = n(root), ch = notes(tones);
        for (let i = 0; i < 4; i++) m.kick(drums, t0 + i * b, i === 0 ? 0.7 : 0.6);
        m.snare(drums, t0 + b, 0.8);
        m.snare(drums, t0 + 3 * b, 0.9);
        for (let i = 0; i < 8; i++) m.hat(hats, t0 + i * b / 2, i % 2 ? 1.2 : 0.6, i === 7 && bar % 4 === 3);
        [0, 0, 0, 12, 0, 0, 0, 12].forEach((up, i) => m.tone(low, t0 + i * b / 2, 0.16, r + up, { type: 'sawtooth', cutoff: 1000, cutTo: 350, cutTime: 0.15, gain: 0.15, a: 0.004, d: 0.12, s: 0.3, r: 0.05 }));
        const run = [ch[0], ch[1], ch[2], ch[0] + 12, ch[1] + 12, ch[0] + 12, ch[2], ch[1]];
        for (let i = 0; i < 16; i++) m.pluck(arp, t0 + i * b / 4, run[i % 8], { type: 'sawtooth', gain: i % 4 === 0 ? 0.19 : 0.14, decay: 0.16, bright: 5200, dark: 900 });
        if (bar % 2 === 0) m.pad(pads, t0, 8 * b, [r + 24, ...ch], { cutoff: 1500, gain: 0.06, a: 0.4, r: 0.6 });
      }
      const sing = (t, d, p) => m.tone(lead, t, d * 0.92, p, { type: 'sawtooth', detune: 6, cutoff: 3000, gain: 0.17, a: 0.02, d: 0.25, s: 0.75, r: 0.12 });
      tune(32 * b, b, `F#5 A5 F#5:.5 E5:.5 D5  E5:1.5 F#5:.5 A5:2  B5 A5 F#5 D5  F#5:3 -
                       G5 B5 G5:.5 F#5:.5 E5  D5:1.5 E5:.5 G5:2  A5 G5 E5 C#5  E5:2 A5 -`, sing);
    },
  },

  build(b) {
    const rand = rng(1234);

    // ---------------------------------------------------------- terrain
    {
      const nx = XS.length, ny = YS.length, g = new Geo();
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = XS[i], y = YS[j], z = ZG[j * nx + i];
          const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
          const dzdx = (ZG[j * nx + i1] - ZG[j * nx + i0]) / (XS[i1] - XS[i0]);
          const dzdy = (ZG[j1 * nx + i] - ZG[j0 * nx + i]) / (YS[j1] - YS[j0]);
          const n = v3.norm([-dzdx, -dzdy, 1]);
          const k = g.vert(x, y, z, n[0], n[1], n[2], 0, 0);
          const c = terrainColor(x, y, z, n);
          g.c[k * 3] = c[0]; g.c[k * 3 + 1] = c[1]; g.c[k * 3 + 2] = c[2];
        }
      }
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; g.quadIdx(a, a + 1, a + nx + 1, a + nx); }
      }
      b.static(g.mat(MAT.TERRAIN).gloss(0.05));
      // The land's own shadow at any distance and for the sun as it stands at
      // any moment: the shadow maps reach 500 m round the player, and only for
      // the player's own time, so at sunset the hills' shadow used to stop
      // there.  Baked from the land with the road and railway cuttings filled
      // in, so that a train or a car in a cutting is not put in its shade
      // (near the player the shadow maps draw the cuttings' own shadows).
      b.horizon('land', (x, y) => Math.max(0, meshHeight(x, y), landHeight(x, y)), { x0: -3200, y0: -3400, x1: 1800, y1: 3400, nx: 128, ny: 176, reach: 3000 });
    }

    // ---------------------------------------------------------- sea
    // The cells within about 250 m of the shoreline are a see-through mesh of
    // their own: in the shallows the sand shows through the water (see the
    // SEA material), which is opaque again by the time it reaches the rest.
    {
      const x0 = 280, x1 = 5200, y0 = -5200, y1 = 5200;
      const nx = Math.ceil((x1 - x0) / 100), ny = Math.ceil((y1 - y0) / 100);
      const X = (i) => x0 + (x1 - x0) * i / nx, Y = (j) => y0 + (y1 - y0) * j / ny;
      const deep = new Geo(), shallows = new Geo();
      const at = [new Map(), new Map()];
      const corner = (g, k, i, j) => {
        const key = j * (nx + 1) + i;
        if (!at[k].has(key)) at[k].set(key, g.vert(X(i), Y(j), 0, 0, 0, 1, 0, 0));
        return at[k].get(key);
      };
      for (let j = 0; j < ny; j++) {
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k <= 4; k++) { const c = coastX(lerp(Y(j), Y(j + 1), k / 4)); lo = Math.min(lo, c); hi = Math.max(hi, c); }
        for (let i = 0; i < nx; i++) {
          const near = X(i + 1) > lo - 60 && X(i) < hi + 250 && Math.abs(Y(j)) < 4700 && Math.abs(Y(j + 1)) < 4700;
          const g = near ? shallows : deep, k = near ? 1 : 0;
          g.quadIdx(corner(g, k, i, j), corner(g, k, i + 1, j), corner(g, k, i + 1, j + 1), corner(g, k, i, j + 1));
        }
      }
      b.static(deep.color('#1b5e78').mat(MAT.SEA).gloss(0.9));
      b.static(shallows.color('#1b5e78').mat(MAT.SEA).gloss(0.9).blend(1));
    }

    // ---------------------------------------------------------- road ribbon and verges
    const np = LAY.pts.length;
    const rows = [];
    for (let i = 0; i <= np; i++) {
      const s = CENTRE.cum[i], fr = frameAt(s);
      const kerb = [-2, -1, 0, 1, 2].some((d) => LAY.curv[((i + d) % np + np) % np] !== 0);
      rows.push({ s, fr, kerb });
    }
    const ribbon = (us, mat, colorAt) => {
      const g = new Geo();
      for (const row of rows) {
        for (const u of us) {
          const x = row.fr.p[0] + row.fr.r[0] * u, y = row.fr.p[1] + row.fr.r[1] * u;
          const z = heightAt(x, y) + ROAD_LIFT;
          const k = g.vert(x, y, z, 0, 0, 1, u, row.s);
          const c = colorAt(x, y, z, row);
          g.c[k * 3] = c[0]; g.c[k * 3 + 1] = c[1]; g.c[k * 3 + 2] = c[2];
        }
      }
      const nu = us.length;
      for (let r = 0; r < rows.length - 1; r++) {
        for (let c = 0; c < nu - 1; c++) {
          const a = r * nu + c;
          g.quadIdx(a, a + nu, a + nu + 1, a + 1);
        }
      }
      return g.orientByNormals().mat(mat);
    };
    b.static(ribbon([-HALF_PAVED, 0, HALF_PAVED], MAT.ROAD, (x, y, z, row) => (row.kerb ? [1, 0, 0] : [0, 0, 0])).gloss(0.16));
    const vergeColor = (x, y, z) => terrainColor(x, y, z, [0, 0, 1]);
    b.static(ribbon([-HALF_VERGE, -HALF_PAVED], MAT.VERGE, vergeColor).gloss(0.05));
    b.static(ribbon([HALF_PAVED, HALF_VERGE], MAT.VERGE, vergeColor).gloss(0.05));

    // ---------------------------------------------------------- along-track helpers
    // A strip of quads along the track from s0 to s1 at offset u.
    // A wall along the track from s0 to s1 at offset u, from z0 to z1 above the
    // road surface: a double-sided ribbon, or with opts.thick a solid slab with
    // a top.  uv = (0..1 across or up, s).
    const strip = (s0, s1, u, z0, z1, opts = {}) => {
      const g = new Geo(), n = Math.max(1, Math.ceil((s1 - s0) / (opts.step ?? 5))), th = (opts.thick ?? 0) / 2;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const s = s0 + (s1 - s0) * i / n, fr = frameAt(s);
        const x = fr.p[0] + fr.r[0] * u, y = fr.p[1] + fr.r[1] * u;
        pts.push({ x, y, z: heightAt(x, y) + ROAD_LIFT, r: fr.r, s });
      }
      const quad = (A, B, oA, oB, za, zb, n3, uv) => {
        const q = [
          g.vert(A.x + oA[0], A.y + oA[1], A.z + za, ...n3, uv[0], A.s), g.vert(B.x + oB[0], B.y + oB[1], B.z + za, ...n3, uv[0], B.s),
          g.vert(B.x + oB[2], B.y + oB[3], B.z + zb, ...n3, uv[1], B.s), g.vert(A.x + oA[2], A.y + oA[3], A.z + zb, ...n3, uv[1], A.s),
        ];
        g.quadIdx(q[0], q[1], q[2], q[3]);
      };
      for (let i = 0; i < n; i++) {
        const A = pts[i], B = pts[i + 1];
        for (const side of th > 0 ? [-1, 1] : [1]) {
          // side = +1 is the face towards the road
          const k = -Math.sign(u || 1) * side, oA = [A.r[0] * th * k, A.r[1] * th * k], oB = [B.r[0] * th * k, B.r[1] * th * k];
          quad(A, B, [...oA, ...oA], [...oB, ...oB], z0, z1, [A.r[0] * k, A.r[1] * k, 0], [0, 1]);
        }
        if (th > 0) {
          const a = [-A.r[0] * th, -A.r[1] * th, A.r[0] * th, A.r[1] * th], b2 = [-B.r[0] * th, -B.r[1] * th, B.r[0] * th, B.r[1] * th];
          quad(A, B, a, b2, z1, z1, [0, 0, 1], [0, 1]);
        }
      }
      if (!(th > 0)) g.doubleSided();
      return g.orientByNormals();
    };
    const inGallery = (s) => s > GAL0 - 6 && s < GAL1 + 6;

    // ---------------------------------------------------------- barriers
    {
      // armco on the bends, both sides (not in the gallery)
      const bends = [];
      let cur = null;
      for (let i = 0; i < np; i++) {
        const curved = LAY.curv[i] !== 0;
        if (curved && !cur) cur = { s0: CENTRE.cum[i] - 25 };
        if (!curved && cur) { cur.s1 = CENTRE.cum[i] + 25; bends.push(cur); cur = null; }
      }
      if (cur) { cur.s1 = LAP + 25; bends.push(cur); }
      // chevron boards on the outside of every bend, facing the traffic that
      // runs with the lap and pointing the way the road turns (the copy's number)
      {
        const curvAt = (s) => {
          let lo = 0, hi = np;
          while (hi - lo > 1) { const m = (lo + hi) >> 1; if (CENTRE.cum[m] <= s) lo = m; else hi = m; }
          return LAY.curv[lo % np];
        };
        const sign = Geo.merge(
          Geo.box(0.1, 0.1, 1.95).translate(0, 0.02, 0.97).color('#9aa0a6').untinted(),
          panel(1.2, 0.9).translate(0, -0.05, 1.0).color('#ffffff').mat(MAT.CHEVRON),
        );
        const at = [];
        for (const bd of bends) {
          for (let s = bd.s0 + 35; s < bd.s1 - 25; s += 16) {
            const c = curvAt(s % LAP);
            if (c === 0 || inGallery(s % LAP)) continue;
            const u = c > 0 ? 14.2 : -14.2;
            at.push({ transform: trackMatrix(s % LAP, u, 0, heightAt(...onTrack(s % LAP, u)) + ROAD_LIFT), data: c > 0 ? 1 : 2 });
          }
        }
        b.instances(sign, at, { within: 400 });
      }
      // the rails are one mesh; their posts, one every 4 m on the bends and down
      // the right of the main straight, are copies of a single post
      const armco = new Geo(), postAt = [];
      for (const bd of bends) {
        for (const u of [-12.5, 12.5]) {
          armco.add(strip(bd.s0, bd.s1, u, 0.42, 0.82, { step: 4 }));
          for (let s = bd.s0; s <= bd.s1; s += 4) {
            postAt.push(trackMatrix(s, u + Math.sign(u) * 0.12, 0, heightAt(...onTrack(s, u)) + ROAD_LIFT));
          }
        }
      }

      // main straight: concrete wall with sponsor boards and a chase-light strip on the left,
      // armco on the right
      const s0 = 30, s1 = MAIN_LEN - 30;
      const wall = new Geo();
      for (let s = s0; s < s1 - 1; s += 100) {
        const e = Math.min(s + 100, s1);
        wall.add(strip(s, e, -12.5, 0, 1.1, { thick: 0.45, step: 100 }));
      }
      b.static(wall.color('#c9c4b8'));
      const ads = new Geo();
      for (let s = s0, k = 0; s < s1 - 6; s += 6, k++) {
        const p = panel(5.6, 0.85).translate(0, 0, 0.13);
        p.uvTransform(1, 1, k, 0);
        ads.add(p.rotateZ(Math.PI / 2), trackMatrix(s + 3, -12.5 + 0.235, 0, heightAt(...onTrack(s + 3, -12.5)) + ROAD_LIFT));
      }
      b.static(ads.mat(MAT.AD));
      const chase = new Geo();
      for (let s = s0; s < s1 - 1; s += 100) chase.add(strip(s, Math.min(s + 100, s1), -12.5, 1.1, 1.22, { thick: 0.16, step: 100 }));
      b.static(chase.color('#38d6ff').mat(MAT.CHASE));
      armco.add(strip(s0, s1, 12.5, 0.42, 0.82, { step: 50 }));
      for (let s = s0; s <= s1; s += 4) postAt.push(trackMatrix(s, 12.62, 0, heightAt(...onTrack(s, 12.5)) + ROAD_LIFT));
      b.static(armco.color('#b9c0c6').gloss(0.55).mat(MAT.ARMCO));
      b.instances(Geo.box(0.12, 0.12, 0.75).translate(0, 0, 0.37).color('#b9c0c6').gloss(0.55), postAt);
    }

    // ---------------------------------------------------------- street lamps
    // One lamp, built for the left of the road (its arm reaching out towards
    // +x, the road), copied all round the lap; on the right it is turned round.
    {
      const lamp = Geo.merge(
        Geo.cylinder(0.14, 9.2, 6, { r2: 0.09, caps: false }).color('#59616b').gloss(0.4),
        Geo.box(2.3, 0.12, 0.12).translate(1.1, 0, 9.05).color('#59616b').gloss(0.4),
        Geo.box(0.9, 0.36, 0.14).translate(2.05, 0, 8.95).color('#ffe2b0').mat(MAT.LAMP),
      );
      const at = [];
      for (let s = 0; s < LAP - 1; s += LAMP_SP / 2) {
        const left = Math.round(s / (LAMP_SP / 2)) % 2 === 0;
        if (inGallery(s) || Math.abs(s - S_LINE) < 8) continue;
        const u = left ? -11 : 11;
        const [x, y] = onTrack(s, u);
        const m = trackMatrix(s, u, 0, heightAt(x, y) + ROAD_LIFT - 0.3);
        at.push(left ? m : m4.mul(m, m4.rotationZ(Math.PI)));
      }
      b.instances(lamp, at);
      // their small parts, from near by: a plinth, a brace under the arm and
      // a housing over the lamp
      const parts = Geo.merge(
        Geo.box(0.5, 0.5, 0.5).translate(0, 0, 0.25).color('#9a958b'),
        bar([0, 0, 8.3], [0.85, 0, 9.0], 0.07).color('#59616b').gloss(0.4),
        Geo.box(1.0, 0.42, 0.12).translate(2.05, 0, 9.08).color('#59616b').gloss(0.4),
      );
      b.instances(parts, at, { within: 50, solid: false });
    }

    // ---------------------------------------------------------- start/finish gantry
    {
      const m = trackMatrix(S_LINE, 0, 0, heightAt(...onTrack(S_LINE, 0)) + ROAD_LIFT);
      const g = new Geo();
      // the legs are lattice towers: their four sides (the box's first sixteen
      // corners) are a mesh with holes, see `cutout`
      for (const x of [-11, 11]) {
        const leg = Geo.box(0.9, 0.9, 10.5).translate(x, 0, 5.25).cutout();
        for (let i = 0; i < 16; i++) leg.a[i * 4 + 2] = MAT.LATTICE;
        g.add(leg);
      }
      g.add(Geo.box(23, 1.3, 1.7).translate(0, 0, 9.0));
      g.add(Geo.box(9.4, 0.7, 3.4).translate(0, 0, 11.55));
      b.static(g.color('#2d3238').gloss(0.4), { transform: m });
      // sponsor band on the beam, both sides
      for (const side of [-1, 1]) {
        const ad = panel(22, 1.3).uvTransform(4, 1, 0, 0);
        if (side > 0) ad.rotateZ(Math.PI);
        b.static(ad.translate(0, side * 0.66, 8.35).mat(MAT.AD), { transform: m });
      }
      // big clocks facing both ways
      for (const side of [-1, 1]) {
        const p = panel(8.8, 3.0);
        if (side > 0) p.rotateZ(Math.PI);
        b.static(p.translate(0, side * 0.36, 10.05).color('#ff9a2e').mat(MAT.DISPLAY), { transform: m });
      }
      // start lights: five columns light up one per second, all go out and the
      // green row shows for two seconds; an 8 s cycle
      const housing = new Geo();
      for (let j = 0; j < 5; j++) housing.add(Geo.box(0.8, 0.5, 2.0).translate(-2.6 + 1.3 * j, -0.85, 7.25));
      b.static(housing.color('#141619'), { transform: m });
      const lamp = (x, z, c) => Geo.sphere(0.25, 8, 5).translate(x, -1.1, z).color(c);
      const off = new Geo();
      for (let j = 0; j < 5; j++) for (const z of [7.85, 7.25, 6.65]) off.add(lamp(-2.6 + 1.3 * j, z, '#2a0f0d'));
      b.static(off.gloss(0.6), { transform: m });
      for (let j = 0; j < 5; j++) {
        const red = Geo.merge(lamp(-2.6 + 1.3 * j, 7.85, '#ff2a14'), lamp(-2.6 + 1.3 * j, 7.25, '#ff2a14')).translate(0, -0.02, 0).emissive(9);
        b.static(red, { transform: m, from: j, to: 5, period: 8 });
      }
      const green = new Geo();
      for (let j = 0; j < 5; j++) green.add(lamp(-2.6 + 1.3 * j, 6.65, '#3dff6a'));
      b.static(green.translate(0, -0.02, 0).emissive(9), { transform: m, from: 5, to: 7, period: 8 });
      // its small parts, from near by: plinths, visors over the start lights,
      // railings along the walkway on the beam (clear of the clocks), a ladder
      // up the west leg (meshes with holes, see `cutout`)
      const d = new Geo();
      for (const x of [-11, 11]) d.add(Geo.box(1.5, 1.5, 0.4).translate(x, 0, 0.2).color('#a9a59c'));
      for (let j = 0; j < 5; j++) {
        for (const z of [7.85, 7.25, 6.65]) d.add(Geo.box(0.62, 0.42, 0.05).translate(-2.6 + 1.3 * j, -1.31, z + 0.3).color('#141619'));
      }
      for (const sd of [-1, 1]) {
        for (const [x0, x1] of [[-11.5, -4.8], [4.8, 11.5]]) {
          d.add(Geo.quad([x0, sd * 0.6, 9.85], [x1, sd * 0.6, 9.85], [x1, sd * 0.6, 10.95], [x0, sd * 0.6, 10.95]).uvTransform(x1 - x0, 1.1)
            .color('#2d3238').mat(MAT.RAILING).cutout().doubleSided());
        }
      }
      d.add(Geo.quad([-11.47, -0.2, 0.5], [-11.47, 0.2, 0.5], [-11.47, 0.2, 8.2], [-11.47, -0.2, 8.2]).uvTransform(0.4, 7.7)
        .color('#4a5058').mat(MAT.LADDER).cutout().doubleSided());
      b.static(d, { transform: m, within: 80 });
    }

    // ---------------------------------------------------------- trackside furniture along the main straight
    // Tyre walls round the gantry's legs and at both ends of the pit wall,
    // cones on the shoulder past the line, distance boards before the north
    // bend, marshals' posts with their flags, and a catch fence on the pit wall.
    {
      const tyreStack = Geo.cylinder(0.32, 1.0, 8).color('#ffffff').mat(MAT.TYRES).gloss(0.12);
      const stacks = [];
      const stackAt = (s, u, tint) => stacks.push({ transform: trackMatrix(s, u, 0, heightAt(...onTrack(s, u)) + ROAD_LIFT), tint });
      for (const sd of [-1, 1]) {
        for (let k = -2; k <= 2; k++) stackAt(S_LINE + 0.65 * k, sd * 10.2, k === 0 ? '#e8e8e4' : '#2a2a2a');
      }
      for (const [s, dir] of [[30, -1], [MAIN_LEN - 30, 1]]) {
        for (let k = 0; k < 6; k++) stackAt(s + dir * (0.4 + 0.65 * (k % 3)), -12.0 + 0.65 * Math.floor(k / 3), k % 3 === 1 ? '#c0392b' : '#2a2a2a');
      }
      b.instances(tyreStack, stacks, { within: 80 });

      const cone = Geo.merge(
        Geo.cone(0.17, 0.62, 8).translate(0, 0, 0.03).color('#ff6a13').mat(MAT.CONE).gloss(0.3),
        Geo.box(0.38, 0.38, 0.03).translate(0, 0, 0.015).color('#1d1d1d'),
      );
      const cones = [];
      for (let k = 0; k < 10; k++) cones.push(trackMatrix(S_LINE + 18 + 5 * k, -9.6, 0, heightAt(...onTrack(S_LINE + 18 + 5 * k, -9.6)) + ROAD_LIFT));
      b.instances(cone, cones, { within: 50, solid: false });

      // distance boards: 300, 200 and 100 m before the bend, both sides
      for (let k = 1; k <= 3; k++) {
        for (const u of [-14.2, 14.2]) {
          const s = MAIN_LEN - 100 * k;
          const g = Geo.merge(
            Geo.box(0.12, 0.12, 2.6).translate(0, 0.05, 1.3).color('#9aa0a6'),
            panel(1.3, 1.5).translate(0, -0.02, 1.15).color('#f2f2f0').mat(MAT.MARKER).tag(k),
          );
          b.static(g, { transform: trackMatrix(s, u, 0, heightAt(...onTrack(s, u)) + ROAD_LIFT) });
        }
      }

      // marshals' posts on the right, each with a green flag in the wind
      const hut = Geo.merge(
        Geo.box(2.2, 2.2, 2.3).translate(0, 0, 1.15).color('#e9e4d8'),
        Geo.box(2.6, 2.6, 0.15).translate(0, 0, 2.38).color('#c0392b'),
        Geo.box(2.21, 1.4, 0.6).translate(0, 0, 1.6).color('#1d2329').gloss(0.8),
        Geo.cylinder(0.04, 5.2, 5, { caps: false }).translate(-1.4, 0, 0).color('#ddd'),
      );
      const flagCloth = (ph) => {
        const g = new Geo(), nx = 5, L = 1.5, H = 1.0;
        for (let j = 0; j <= 1; j++) {
          for (let i = 0; i <= nx; i++) {
            const a = i / nx;
            g.vert(0.25 * a * Math.sin(a * 5 - ph * Math.PI * 2), -a * L, -j * H, 1, 0, 0, a, 1 - j);
          }
        }
        for (let i = 0; i < nx; i++) g.quadIdx(i, i + 1, i + nx + 2, i + nx + 1);
        return g.computeNormals().color('#1e9e49').doubleSided();
      };
      const marshal = Geo.merge(
        Geo.box(0.36, 0.24, 0.85).translate(0, 0, 0.43).color('#2d2f33'),
        Geo.box(0.46, 0.3, 0.75).translate(0, 0, 1.22).color('#ff7a1a'),
        Geo.box(0.22, 0.22, 0.25).translate(0, 0, 1.73).color('#c99f84'),
        Geo.box(0.12, 0.12, 0.62).translate(0.29, 0, 1.25).color('#ff7a1a'),
        Geo.quad([0.32, 0.0, 1.0], [0.32, 0.55, 1.0], [0.32, 0.55, 1.4], [0.32, 0.0, 1.4]).color('#ffd21a').doubleSided(),
      );
      for (const s of [470, 770, 1070]) {
        const m = trackMatrix(s, 16.5);
        b.static(hut, { transform: m });
        b.static(marshal, { transform: m4.mul(m, m4.translation(-1.7, 1.6, 0), m4.rotationZ(-0.3)), within: 120, solid: false });
        const fm = m4.mul(m, m4.translation(-1.4, 0, 5.1));
        for (let j = 0; j < 8; j++) {
          b.static(flagCloth(j / 8).transform(fm), { from: j * 0.85 / 8 + s * 0.01, to: (j + 1) * 0.85 / 8 + s * 0.01, period: 0.85, within: 150 });
        }
      }

      // catch fence on top of the pit wall: posts every 4 m and a mesh (with
      // holes, see `cutout`; it fades to its frame of tubes with distance) in
      // 50 m pieces, both from near by, and not solid, so that a walker can
      // still climb onto the wall and into the grandstand as before
      const posts = [];
      for (let s = 32; s <= MAIN_LEN - 32; s += 4) posts.push(trackMatrix(s, -12.5, 0, heightAt(...onTrack(s, -12.5)) + ROAD_LIFT));
      b.instances(Geo.box(0.08, 0.08, 2.9).translate(0, 0, 2.65).color('#5f666d').gloss(0.4), posts, { within: 220, solid: false });
      for (let s = 32; s < MAIN_LEN - 33; s += 50) {
        const e = Math.min(s + 50, MAIN_LEN - 32);
        const mesh = strip(s, e, -12.5, 1.22, 4.1, { step: 50 });
        for (let i = 0; i < mesh.vertexCount; i++) { mesh.uv[i * 2] *= 2.88; mesh.uv[i * 2 + 1] -= s; }
        b.static(mesh.color('#7a8188').mat(MAT.FENCE).cutout(), { within: 220, solid: false });
      }
    }

    // ---------------------------------------------------------- timing boards along the straight
    // every 50 m, alternating sides; each shows the time at which you see it
    const boardAt = [];
    for (let s = 100; s < MAIN_LEN - 40; s += 50) {
      if (s > 230 && s < 390) continue; // gantry and grandstand
      const left = (s / 50) % 2 === 0, u = left ? -14.6 : 15.2;
      const m = trackMatrix(s, u);
      const g = new Geo();
      for (const x of [-2.2, 2.2]) g.add(Geo.box(0.25, 0.25, 4.4).translate(x, 0, 2.2));
      g.add(Geo.box(6.3, 0.36, 2.5).translate(0, 0, 5.45));
      b.static(g.color('#2b3036').gloss(0.3), { transform: m });
      for (const side of [-1, 1]) {
        const p = panel(6.0, 2.3);
        if (side > 0) p.rotateZ(Math.PI);
        b.static(p.translate(0, side * 0.19, 4.3).color(left ? '#9dff6e' : '#ffd23a').mat(MAT.DISPLAY), { transform: m });
      }
      boardAt.push({ transform: m, data: s });
    }
    // their small parts, from near by: footings, a cross brace, hoods over the
    // displays, a sponsor board, a ladder (a mesh with holes), a cabinet and a
    // plate with the board's distance from the start of the straight
    {
      const d = new Geo();
      for (const x of [-2.2, 2.2]) d.add(Geo.box(0.6, 0.6, 0.3).translate(x, 0, 0.1).color('#a9a59c'));
      d.add(bar([-2.2, 0, 0.9], [2.2, 0, 3.9], 0.1).color('#2b3036'));
      d.add(bar([2.2, 0, 0.9], [-2.2, 0, 3.9], 0.1).color('#2b3036'));
      for (const sd of [-1, 1]) d.add(Geo.box(6.3, 0.42, 0.06).translate(0, sd * 0.38, 6.74).color('#2b3036'));
      d.add(Geo.box(4.2, 0.12, 0.42).translate(0, 0, 3.95).color('#ffffff').mat(MAT.AD));
      d.add(Geo.quad([2.5, -0.2, 0.4], [2.5, 0.2, 0.4], [2.5, 0.2, 4.25], [2.5, -0.2, 4.25]).color('#4a5058').mat(MAT.LADDER).cutout().doubleSided());
      d.add(Geo.box(0.7, 0.45, 1.1).translate(-2.2, 0.55, 0.55).color('#7d8a8f').gloss(0.3));
      for (const sd of [-1, 1]) {
        const p = panel(0.9, 0.32);
        if (sd > 0) p.rotateZ(Math.PI);
        d.add(p.translate(1.55, sd * 0.07, 3.79).color('#f2f2f0').mat(MAT.MARKER));
      }
      b.instances(d, boardAt, { within: 60, solid: false });
    }

    // ---------------------------------------------------------- grandstand
    {
      const sc = 310, len = 120;
      const base = heightAt(...onTrack(sc, -18)) + ROAD_LIFT - 0.4;
      const m = trackMatrix(sc, 0, 0, base);
      const stand = new Geo(), roof = new Geo();
      for (let half = 0; half < 2; half++) {
        const yc = (half - 0.5) * len / 2;
        for (let i = 0; i < 9; i++) {
          const x0 = -18 - 2.3 * i, h = 1.4 + 1.05 * i;
          stand.add(Geo.box(2.3, len / 2, h).translate(x0 - 1.15, yc, h / 2));
        }
        roof.add(Geo.box(26, len / 2, 0.45).translate(-30, yc, 15.4));
        roof.add(Geo.box(0.5, len / 2, 13).translate(-39.3, yc, 6.5));
      }
      for (let y = -len / 2; y <= len / 2 + 0.1; y += 15) {
        roof.add(Geo.box(0.5, 0.5, 15.4).translate(-38.6, y, 7.7));
      }
      b.static(stand.mat(MAT.CROWD), { transform: m });
      b.static(roof.color('#e7e3da').gloss(0.3), { transform: m });
      // flags along the roof's front edge, flying south in the breeze
      const flag = (color, mat) => (ph) => {
        const g = new Geo(), nx = 6, nz = 2, L = 3.2, H = 2.0;
        for (let j = 0; j <= nz; j++) {
          for (let i = 0; i <= nx; i++) {
            const a = i / nx, y = -a * L;
            const x = 0.45 * a * Math.sin(a * 5.5 - ph * Math.PI * 2) ;
            g.vert(x, y, -j / nz * H, 1, 0, 0, a, 1 - j / nz);
          }
        }
        for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; g.quadIdx(a, a + 1, a + nx + 2, a + nx + 1); }
        g.computeNormals();
        g.color(color);
        if (mat) g.mat(mat);
        return g.doubleSided();
      };
      const cols = ['#c0392b', '#f1c40f', '#2471a3', '#ffffff', '#1e8449', '#e67e22', '#8e44ad', '#17a589', '#c0392b', '#2471a3'];
      for (let k = 0; k < 10; k++) {
        const y = -len / 2 + 6 + k * (len - 12) / 9;
        const pm = m4.mul(m, m4.translation(-17.6, y, 15.6));
        b.static(Geo.cylinder(0.07, 5.2, 5, { caps: false }).color('#ddd'), { transform: pm });
        const fm = m4.mul(pm, m4.translation(0, -0.05, 5.1));
        const make = flag(cols[k], k === 4 || k === 5 ? MAT.CHECKER : 0);
        stopMotion(b, (ph) => make(ph).transform(fm), 12, 0.9 + 0.07 * k, k * 0.13);
      }
    }

    // ---------------------------------------------------------- covered gallery with chase lamps
    {
      const g = new Geo();
      const pieces = Math.round((GAL1 - GAL0) / 10);
      for (let i = 0; i < pieces; i++) {
        const s = GAL0 + 10 * i + 5;
        const zr = heightAt(...onTrack(s, 0)) + ROAD_LIFT;
        const m = trackMatrix(s, 0, 0, zr);
        const part = new Geo();
        part.add(Geo.box(25, 10.05, 0.7).translate(0, 0, 7.9));         // roof slab
        part.add(Geo.box(0.9, 10.05, 7.6).translate(12.2, 0, 3.8));      // solid wall on the hill side (west)
        part.add(Geo.box(1.0, 1.4, 7.6).translate(-12.2, -4.3, 3.8));    // pillars towards the sea
        part.add(Geo.box(1.0, 10.05, 1.2).translate(-12.2, 0, 6.95));    // lintel
        g.add(part, m);
      }
      {
        const s = GAL0 + 10 * pieces;
        const m = trackMatrix(s, 0, 0, heightAt(...onTrack(s, 0)) + ROAD_LIFT);
        g.add(Geo.box(1.0, 1.4, 7.6).translate(-12.2, -0.7, 3.8), m);
      }
      b.static(g.color('#cfc6b4').gloss(0.15));
      const fixtures = new Geo();
      for (let i = 0; i < GAL_N; i++) {
        const s = GAL0 + GAL_SP * (i + 0.5);
        const m = trackMatrix(s, 0, 0, heightAt(...onTrack(s, 0)) + ROAD_LIFT);
        fixtures.add(Geo.box(1.6, 0.6, 0.18).translate(0, 0, 7.45), m);
        const lit = Geo.box(1.4, 0.5, 0.1).translate(0, 0, 7.32).transform(m).color('#9fe6ff').emissive(10);
        b.static(lit, { from: i * GAL_SP / GAL_V, to: i * GAL_SP / GAL_V + GAL_ON, period: GAL_CYCLE });
      }
      b.static(fixtures.color('#30363d'));
    }

    // ---------------------------------------------------------- railway
    {
      const bed = new Geo(), rails = new Geo(), masts = new Geo();
      for (let y = RAIL_S; y < RAIL_N - 1; y += 95) {
        const e = Math.min(y + 95, RAIL_N), yc = (y + e) / 2, l = e - y;
        bed.add(prism([[-4.2, 0], [4.2, 0], [3.2, 0.7], [-3.2, 0.7]], l, () => ({}), {})
          .rotateZ(Math.PI / 2).translate(RAIL_X, yc, RAIL_Z - 0.4));
        for (const tx of [-RAIL_GAUGE, RAIL_GAUGE]) {
          for (const rx of [-0.72, 0.72]) rails.add(Geo.box(0.09, l, 0.16).translate(RAIL_X + tx + rx, yc, RAIL_Z + 0.38));
        }
      }
      b.static(bed.color('#8a8073').mat(MAT.RAILBED));
      b.static(rails.color('#8f949a').gloss(0.8));
      for (let y = RAIL_S + 20; y < RAIL_N; y += 60) {
        masts.add(Geo.box(0.3, 0.3, 7.6).translate(RAIL_X + 5, y, RAIL_Z + 3.4));
        masts.add(Geo.box(7.6, 0.16, 0.16).translate(RAIL_X + 1.6, y, RAIL_Z + 6.9));
      }
      for (let y = RAIL_S; y < RAIL_N - 1; y += 95) {
        const e = Math.min(y + 95, RAIL_N);
        for (const tx of [-RAIL_GAUGE, RAIL_GAUGE]) masts.add(Geo.box(0.04, e - y, 0.04).translate(RAIL_X + tx, (y + e) / 2, RAIL_Z + 6.3));
      }
      b.static(masts.color('#5d646c'));
      // tunnel portals: the trains vanish into the headlands
      for (const [yp, dir] of [[RAIL_N, 1], [RAIL_S, -1]]) {
        const g = new Geo();
        g.add(Geo.box(16, 3, 11).translate(RAIL_X, yp + dir * 1.5, RAIL_Z + 5));
        for (let k = 0; k < 3; k++) g.add(Geo.box(12, 120, 9).translate(RAIL_X, yp + dir * (3 + 60 + 120 * k), RAIL_Z + 4.5));
        b.static(g.color('#b4ab9a'));
        const hole = panel(9.6, 7.2);
        if (dir < 0) hole.rotateZ(Math.PI);
        b.static(hole.translate(RAIL_X, yp - dir * 0.02, RAIL_Z - 0.2).color('#050505').unlit());
      }
    }

    // ---------------------------------------------------------- lighthouse
    {
      const [lx, ly] = LH, lz = groundZ(lx, ly);
      const g = new Geo();
      const bands = 5, H = 24;
      for (let k = 0; k < bands; k++) {
        const z0 = H * k / bands, z1 = H * (k + 1) / bands;
        const r0 = lerp(3.8, 2.7, z0 / H), r1 = lerp(3.8, 2.7, z1 / H);
        g.add(Geo.cylinder(r0, z1 - z0, 14, { r2: r1, caps: false }).translate(0, 0, z0).color(k % 2 ? '#b8322a' : '#f2efe8'));
      }
      g.add(Geo.cylinder(3.6, 0.5, 14).translate(0, 0, H).color('#30353b'));
      g.add(Geo.cone(2.4, 2.0, 12).translate(0, 0, H + 3.6).color('#b8322a'));
      g.add(Geo.box(9, 6, 4.5).translate(-7, 0, 2.25).color('#f2efe8'));
      g.add(Geo.cone(6.5, 2.2, 4).rotateZ(Math.PI / 4).scale(1.0, 0.7, 1).translate(-7, 0, 4.5).color('#a9472e'));
      b.static(aboveLand(g.translate(lx, ly, lz - 0.5)));
      b.static(aboveLand(Geo.cylinder(1.9, 3.1, 12, { caps: false }).translate(lx, ly, lz - 0.5 + H + 0.5).mat(MAT.LANTERN)));
      // its small parts, from near by: the gallery's railing (a mesh with
      // holes), a door with a canopy and windows up the tower, a lightning
      // rod, and the keeper's house's door, windows and chimney
      {
        const d = new Geo();
        d.add(Geo.cylinder(3.55, 1.1, 14, { caps: false }).translate(0, 0, H + 0.5).uvTransform(22.3, 1.1).color('#30353b').mat(MAT.RAILING).cutout().doubleSided());
        d.add(Geo.box(1.3, 0.3, 2.3).translate(0, 3.72, 1.65).color('#2f4f3a').gloss(0.3));
        d.add(Geo.box(1.8, 0.7, 0.1).translate(0, 3.95, 2.95).color('#30353b'));
        for (const z of [7, 13, 19]) d.add(Geo.box(0.55, 0.14, 0.85).translate(0, 3.8 - 1.1 * z / H, z).color('#1b2128').gloss(0.8));
        d.add(bar([0, 0, H + 5.5], [0, 0, H + 7.4], 0.07).color('#30353b'));
        d.add(Geo.box(1.0, 0.1, 2.1).translate(-8.2, 3.03, 1.55).color('#29466b'));
        for (const [x, y] of [[-10.2, 3.03], [-5.8, 3.03], [-9.5, -3.03], [-5.8, -3.03]]) {
          d.add(Geo.box(1.2, 0.08, 1.15).translate(x, y, 2.5).color('#e0dccf'));
          d.add(Geo.box(0.95, 0.1, 0.9).translate(x, y, 2.5).color('#1b2128').gloss(0.8));
        }
        d.add(Geo.box(0.65, 0.65, 1.8).translate(-9.3, -1.0, 5.6).color('#c9b9a0'));
        b.static(aboveLand(d.translate(lx, ly, lz - 0.5)), { within: 120, solid: false });
      }
      // two opposite beams, turning clockwise once every BEAM_T seconds: stop motion, 2.5 degree steps
      const one = Geo.lathe([[0.7, 0], [8, 120], [16, 240], [24, 360], [32, 480]], 8).rotateX(-Math.PI / 2).rotateX(-0.025);
      const beams = Geo.merge(one, one.clone().rotateZ(Math.PI)).color('#fff0c8').mat(MAT.BEAM).additive();
      const N = 72, origin = [lx, ly, lz - 0.5 + H + 2.0];
      stopMotion(b, (ph) => beams.clone().rotateZ(-ph * Math.PI).translate(...origin), N, BEAM_T / 2);
    }

    // ---------------------------------------------------------- a jetty off the beach, east of the straight
    // A plank deck on pairs of piles, a lamp and a ladder at its end, and a
    // dinghy tied up beside it; the piles and the small parts from near by.
    {
      const y = 100, x0 = 426, x1 = 520, top = groundZ(x0, y) + 0.08;
      b.static(Geo.box(x1 - x0, 2.6, 0.22).translate((x0 + x1) / 2, y, top - 0.11).color('#9b7b57').mat(MAT.PLANKS).gloss(0.1));
      const pair = new Geo();
      for (const sy of [-1.15, 1.15]) pair.add(Geo.cylinder(0.14, top + 3.2, 6, { caps: false }).translate(0, sy, -3.2));
      pair.add(Geo.box(0.22, 2.9, 0.25).translate(0, 0, top - 0.35));
      pair.color('#5e4a36').gloss(0.1);
      const piles = [];
      for (let x = x0 + 30; x <= x1 - 0.5; x += 6) piles.push(m4.translation(x, y, 0));
      b.instances(pair, piles, { within: 250 });
      const d = new Geo();
      d.add(Geo.cylinder(0.07, 4.2, 6, { caps: false }).translate(x1 - 0.6, y - 1.0, top).color('#3b4148'));
      d.add(Geo.box(0.5, 0.3, 0.3).translate(x1 - 0.6, y - 0.8, top + 4.1).color('#ffe2b0').mat(MAT.LAMP));
      for (const sy of [-0.9, 0.9]) d.add(Geo.cylinder(0.13, 0.45, 6).translate(x1 - 2.5, y + sy, top).color('#2a2c2e'));
      d.add(Geo.quad([x1 + 0.02, y + 0.2, -0.5], [x1 + 0.02, y + 0.6, -0.5], [x1 + 0.02, y + 0.6, top], [x1 + 0.02, y + 0.2, top]).uvTransform(0.4, top + 0.5)
        .color('#4a5058').mat(MAT.LADDER).cutout().doubleSided());
      const dinghy = prism([[-1.8, 0.0], [1.4, 0.0], [2.0, 0.55], [-1.9, 0.55]], 1.5, (k) => (k === 0 ? null : k === 2 ? { color: '#6b5440' } : { color: '#2a6f97' }), { color: '#2a6f97' }, { fan: true });
      d.add(dinghy.transform(m4.mul(m4.translation(x1 - 8, y + 2.6, 0.02), m4.rotationZ(-Math.PI / 2 + 0.08))));
      d.add(rope([x1 - 2.5, y + 0.9, top + 0.4], [x1 - 6.2, y + 2.6, 0.5], 0.03, '#cbbf9f'));
      b.static(d, { within: 150, solid: false });
    }

    // ---------------------------------------------------------- wind turbines on the western ridge
    {
      const towers = new Geo();
      const turbines = [];
      for (let k = 0; k < 7; k++) {
        const y = -760 + 240 * k + rand.range(-30, 30), x = -950 + 30 * Math.sin(k * 1.7);
        const z = groundZ(x, y) - 0.5;
        towers.add(Geo.cylinder(2.1, 64, 10, { r2: 1.3, caps: false }).translate(x, y, z));
        towers.add(Geo.box(3.2, 9, 3.4).translate(x, y - 1.5, z + 65));
        turbines.push([x, y + 3.3, z + 65, rand.range(4.6, 5.8), rand.range(0, 2)]);
      }
      b.static(aboveLand(towers.color('#eef0f0').gloss(0.3)));
      const blade = Geo.box(1.9, 0.35, 30).translate(0.35, 0, 16.5);
      blade.p.forEach((v, i) => { if (i % 3 === 0 && blade.p[i + 2] > 20) blade.p[i] *= 0.55; });
      const rotor = new Geo();
      for (let k = 0; k < 3; k++) rotor.add(blade.clone().rotateY(k * 2 * Math.PI / 3));
      rotor.add(Geo.box(2.2, 2.6, 2.2));
      rotor.color('#f4f5f3').gloss(0.4);
      for (const [x, y, z, T, off] of turbines) {
        // seen from the north (upwind) the rotor turns clockwise; one third of a turn repeats
        stopMotion(b, (ph) => aboveLand(rotor.clone().rotateY(-ph * 2 * Math.PI / 3).translate(x, y, z)), 40, T / 3, off);
      }
      // their small parts, from near by: the spinner on the hub (round, so it
      // need not turn), a door and a transformer at the foot; and on every
      // nacelle a red warning light, all flashing together, a second on and a second off
      const lightOff = new Geo(), lightOn = new Geo();
      for (const [x, y, z] of turbines) {
        const d = new Geo();
        d.add(Geo.cone(1.25, 2.0, 8).rotateX(-Math.PI / 2).translate(x, y + 4.55, z).color('#f4f5f3').gloss(0.4));
        d.add(Geo.box(1.0, 0.3, 2.2).translate(x, y - 2.08, z - 64.5 + 1.1).color('#7d8a8f'));
        d.add(Geo.box(2.0, 1.4, 2.0).translate(x + 4.5, y, z - 64.5 + 1.0).color('#c9cdd1'));
        b.static(aboveLand(d), { within: 200 });
        lightOff.add(Geo.box(0.45, 0.45, 0.3).translate(x, y - 4.5, z + 1.85).color('#4a0c08'));
        lightOn.add(Geo.box(0.47, 0.47, 0.32).translate(x, y - 4.5, z + 1.85).color('#ff2a14').emissive(9));
      }
      b.static(aboveLand(lightOff));
      b.static(aboveLand(lightOn), { from: 0, to: 1, period: 2, solid: false });
    }

    // ---------------------------------------------------------- trees
    // Every tree is a copy of one of three: placed, turned and scaled.
    {
      const pines = [], cyps = [];
      const pine = Geo.merge(
        Geo.cylinder(0.32, 6.5, 5, { r2: 0.22, caps: false }).color('#5a4636'),
        Geo.cylinder(3.9, 2.3, 6, { r2: 2.4 }).translate(0, 0, 6.2).color('#3d5628'),
      ).gloss(0.08);
      const cyp = Geo.cone(1.15, 10, 6).color('#2f4527').gloss(0.08);
      const blocked = (x, y) => {
        if (featureDist(x, y) < FLAT - 4) return true;
        if (y > RAIL_S - 400 && y < RAIL_N + 400 && Math.abs(x - RAIL_X) < 18) return true;
        if (Math.hypot(x - LH[0], y - LH[1]) < 25) return true;
        // grandstand
        const [gx, gy] = onTrack(310, -30);
        if (Math.abs(x - gx) < 35 && Math.abs(y - gy) < 80) return true;
        return false;
      };
      let placed = 0;
      for (let tries = 0; tries < 60000 && placed < 2600; tries++) {
        const x = rand.range(-2000, 720), y = rand.range(-2200, 2200);
        const dens = fbm(x / 260 + 11, y / 260 + 4);
        if (rand() > smoothstep(0.36, 0.62, dens)) continue;
        const z = groundZ(x, y);
        if (z < 3.2 || blocked(x, y)) continue;
        const e = 2;
        const slope = Math.hypot(groundZ(x + e, y) - groundZ(x - e, y), groundZ(x, y + e) - groundZ(x, y - e)) / (2 * e);
        if (slope > 0.45) continue;
        const sc = rand.range(0.75, 1.25), isPine = rand() < 0.75;
        const sz = sc * rand.range(0.85, 1.15), turn = rand.range(0, 6.28);
        (isPine ? pines : cyps).push(m4.mul(m4.translation(x, y, z - 0.3), m4.rotationZ(turn), m4.scaling(sc, sc, sz)));
        placed++;
      }
      // cypress avenues along the south straight and the gallery approach
      const avenue = (s0, s1, u) => {
        for (let s = s0; s <= s1; s += 14) {
          const [x, y] = onTrack(s, u);
          if (featureDist(x, y) < 20) continue;
          const sc = rand.range(0.9, 1.1);
          cyps.push(m4.mul(m4.translation(x, y, groundZ(x, y) - 0.3), m4.scaling(sc, sc, sc * 1.15)));
        }
      };
      const sSouth = SEG_S[13], sLast = SEG_S[11];
      avenue(sSouth + 10, sSouth + LAY.a - 10, -24);
      avenue(sSouth + 10, sSouth + LAY.a - 10, 24);
      avenue(sLast + 10, sLast + LAY.f - 10, 24);
      avenue(SEG_S[2] + 10, SEG_S[2] + 130, 24);
      // olive groves: rows of small round trees
      const olive = Geo.merge(
        Geo.cylinder(0.17, 1.3, 3, { caps: false }).color('#5d4b3a'),
        Geo.cylinder(1.9, 1.8, 5, { r2: 1.25 }).translate(0, 0, 1.0).color('#6b7a4a'),
      ).gloss(0.08);
      const olives = [];
      const groves = [[60, -150], [-60, 260], [120, 150], [-480, -560], [-560, 520], [-1200, 300], [-1150, -500], [30, 950], [-300, -1050]];
      for (const [gx, gy] of groves) {
        const yaw = rand.range(0, Math.PI), c = Math.cos(yaw), sn = Math.sin(yaw);
        const nr = rand.int(9, 13), nc = rand.int(10, 14);
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) {
            const a = (i - nr / 2) * 9, bb = (j - nc / 2) * 8;
            const x = gx + c * a - sn * bb + rand.range(-0.8, 0.8), y = gy + sn * a + c * bb + rand.range(-0.8, 0.8);
            if (blocked(x, y) || groundZ(x, y) < 3) continue;
            const sc = rand.range(0.8, 1.15);
            olives.push(m4.mul(m4.translation(x, y, groundZ(x, y) - 0.15), m4.rotationZ(rand.range(0, 6.28)), m4.scaling(sc)));
          }
        }
      }
      b.instances(olive, olives);
      b.instances(pine, pines);
      b.instances(cyp, cyps);
    }

    // ---------------------------------------------------------- houses
    // A unit block and a unit hipped roof, stretched to each house's size.  The
    // walls take their colour from the copy's tint, and its number says how many
    // windows fit across the front and across the side (and seeds which are lit
    // at night); the four wall faces are tagged 1 to 4 (odd: across the depth,
    // even: across the width), so the windows are laid out on each facade from
    // its own uv.
    {
      const walls = [], roofs = [], garden = [];
      const spots = [];
      const tryHouse = (x, y, minGap) => {
        if (featureDist(x, y) < 40 || featureDist(x, y, true) < 30) return;
        if (spots.some(([a, c]) => Math.hypot(a - x, c - y) < minGap)) return;
        const z = groundZ(x, y);
        if (z < 3) return;
        const w = rand.range(7, 12), d = rand.range(6, 9), h = rand.range(5.5, 7.5);
        const e = 4, slope = Math.abs(groundZ(x + e, y) - groundZ(x - e, y)) + Math.abs(groundZ(x, y + e) - groundZ(x, y - e));
        if (slope > 4) return;
        const yaw = rand.range(-0.3, 0.3) + (rand() < 0.5 ? 0 : Math.PI / 2);
        const m = m4.mul(m4.translation(x, y, z - 1.0), m4.rotationZ(yaw));
        const cols = (len) => Math.max(1, Math.round(len / 3.1));
        walls.push({
          transform: m4.mul(m, m4.scaling(w, d, h + 1)),
          tint: rand.pick(['#f2ede2', '#efe4cf', '#f5f1e8', '#e9d8bb']),
          data: ((spots.length * 37 + 11) % 256) * 256 + cols(w) * 16 + cols(d),
        });
        roofs.push(m4.mul(m, m4.translation(0, 0, h + 1), m4.scaling(w * 0.76, d * 0.76, 2.4)));
        spots.push([x, y]);
        // its small parts, from near by: a front door with a step and a lamp
        // beside it (lit at night), and a chimney rising out of the roof
        const det = new Geo();
        det.add(Geo.box(1.05, 0.08, 2.15).translate(0, -d / 2 - 0.03, 1.0 + 1.07).color(['#2f4f3a', '#29466b', '#6b3a2a', '#3d3d3d'][spots.length % 4]).gloss(0.3));
        det.add(Geo.box(1.5, 0.6, 0.3).translate(0, -d / 2 - 0.3, 0.95).color('#b9b2a4'));
        det.add(Geo.box(0.16, 0.12, 0.24).translate(0.85, -d / 2 - 0.08, 1.0 + 2.2).color('#ffe2b0').mat(MAT.LAMP));
        det.add(Geo.box(0.62, 0.62, 1.7).translate(w * 0.2, d * 0.1, h + 1 + 1.75).color('#c9b9a0'));
        det.add(Geo.box(0.74, 0.74, 0.12).translate(w * 0.2, d * 0.1, h + 1 + 2.62).color('#8a7d6c'));
        b.static(det, { transform: m, within: 70, solid: false });
        // a low garden wall round it, with a gateway in front of the door: in
        // pieces of up to 7 m, each standing on the ground where it is
        const gx = w / 2 + 3.5, gy = d / 2 + 4.5, cy = Math.cos(yaw), sy = Math.sin(yaw);
        const side = (x0, y0, x1, y1) => {
          const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / 7));
          for (let i = 0; i < n; i++) {
            const lx = x0 + (x1 - x0) * (i + 0.5) / n, ly = y0 + (y1 - y0) * (i + 0.5) / n;
            const wx = x + cy * lx - sy * ly, wy = y + sy * lx + cy * ly;
            garden.push({
              transform: m4.mul(m4.translation(wx, wy, groundZ(wx, wy) - 0.6), m4.rotationZ(yaw + Math.atan2(y1 - y0, x1 - x0)), m4.scaling(L / n + 0.34, 0.34, 1.5)),
              tint: ['#d9cdb5', '#cfc3a8', '#e3d9c4'][spots.length % 3],
            });
          }
        };
        side(-gx, -gy, -1.3, -gy); side(1.3, -gy, gx, -gy); side(gx, -gy, gx, gy); side(gx, gy, -gx, gy); side(-gx, gy, -gx, -gy);
      };
      for (let k = 0; k < 400 && spots.length < 34; k++) tryHouse(rand.range(-260, 260), rand.range(-1220, -880), 22);
      for (let k = 0; k < 300 && spots.length < 50; k++) tryHouse(rand.range(-900, 250), rand.range(700, 1100), 30);
      for (let k = 0; k < 300 && spots.length < 64; k++) tryHouse(rand.range(-1500, -450), rand.range(-1400, 1400), 60);
      const block = Geo.box(1, 1, 1).translate(0, 0, 0.5).color('#ffffff').mat(MAT.HOUSE).gloss(0.1);
      // (Geo.box makes the faces +x, -x, +y, -y, +z, -z, four corners each)
      for (let i = 0; i < block.vertexCount; i++) block.x[i * 2 + 1] = [1, 3, 2, 4, 0, 0][i >> 2];
      b.instances(block, walls);
      b.instances(Geo.cone(1, 1, 4).rotateZ(Math.PI / 4).color('#b0532f').gloss(0.15).mat(MAT.ROOF), roofs);
      const wallBox = Geo.box(1, 1, 1).translate(0, 0, 0.5).color('#ffffff').gloss(0.08);
      wallBox.idx = wallBox.idx.slice(0, 30);   // (no floor: it stands in the ground)
      b.instances(wallBox, garden, { within: 150, solid: false });
    }

    // ---------------------------------------------------------- traffic
    // Four lanes, each at one steady speed: with the lap at 30 and 45 m/s, against it at 15 and 30.
    {
      const lanes = [
        { offset: 4.5, dir: 1, k: 2, n: 8, kind: 'car', ahead: 45 },    // 30 m/s = C, the pace lane
        { offset: 1.5, dir: 1, k: 3, n: 6, kind: 'car', ahead: 150 },   // 45 m/s
        { offset: -1.5, dir: -1, k: 2, n: 8, kind: 'car', ahead: 240 }, // 30 m/s, oncoming
        { offset: -4.5, dir: -1, k: 1, n: 5, kind: 'bus', ahead: 420 }, // 15 m/s, oncoming coaches
      ];
      const carCols = ['#f08a12', '#c62828', '#1565c0', '#f9a825', '#2e7d32', '#eceff1', '#37474f', '#ef6c00', '#6a1b9a', '#00838f', '#d81b60', '#8d6e63'];
      const busCols = ['#f2c12e', '#e9eef2', '#2a6f97', '#c0392b'];
      // Each vehicle's small parts ride with it all the way round the lap,
      // with the same keys as its body (so they stay exactly in place), and
      // are drawn only while the vehicle is seen within 50 m.
      let ci = 0;
      lanes.forEach((lane, li) => {
        for (let i = 0; i < lane.n; i++) {
          const speed = lane.k * UNIT;
          // the first car of each lane is `ahead` metres in front of the spawn at the spawn time
          const s0 = SPAWN_S + lane.ahead - lane.dir * speed * SPAWN_T + i * LAP / lane.n;
          const tf = laneTransform(s0, speed, lane.offset, lane.dir);
          const color = lane.kind === 'bus' ? busCols[i % busCols.length] : carCols[ci % carCols.length];
          const geo = lane.kind === 'bus' ? busGeo(color) : carGeo(color, CAR_NUMBERS[ci++]);
          const detail = lane.kind === 'bus' ? busDetailGeo() : carDetailGeo(color);
          const times = adaptiveTimes(tf, 0, PERIOD, { tolerance: 0.07, size: lane.kind === 'bus' ? 6 : 2.3, maxStep: 8, minStep: 0.03 });
          b.dynamic(geo, { times, transform: tf, caps: 'none' });
          b.dynamic(detail, { times, transform: tf, caps: 'none', within: 50 });
        }
      });
    }

    // ---------------------------------------------------------- trains
    {
      const express = expressGeo(), freight = freightGeo(rand);
      // The bogies and couplings are drawn only from within 40 m (which
      // leaves them out when the viewer is on the road, 40 m and more from
      // the rails), with the same two keys as the train.
      const expressParts = expressBogies(), freightParts = freightBogies();
      const xN = RAIL_X + RAIL_GAUGE, xS = RAIL_X - RAIL_GAUGE;
      // northbound express, 40 m/s, from inside the south tunnel to inside the north one
      const vN = 40, yA = RAIL_S - 12, yB = RAIL_N + 15 + 200;
      for (const t0 of [10, 10 + PERIOD / 2]) {
        const t1 = t0 + (yB - yA) / vN;
        const transform = (t) => m4.translation(xN, yA + vN * (t - t0), RAIL_Z + 0.2);
        b.dynamic(express, { times: [t0, t1], transform });
        b.dynamic(expressParts, { times: [t0, t1], transform, within: 40 });
      }
      // southbound freight, 25 m/s, 300 m long
      const vS = 25, yC = RAIL_N + 12, yD = RAIL_S - 15 - 300;
      for (const t0 of [70, 70 + PERIOD / 2]) {
        const t1 = t0 + (yC - yD) / vS;
        const transform = (t) => m4.mul(m4.translation(xS, yC - vS * (t - t0), RAIL_Z + 0.2), m4.rotationZ(Math.PI));
        b.dynamic(freight, { times: [t0, t1], transform });
        b.dynamic(freightParts, { times: [t0, t1], transform, within: 40 });
      }
    }

    // ---------------------------------------------------------- balloons, blimp, boats
    {
      const balloons = [
        { c: [-330, 260], r: 240, z: 260, col: '#d84a3a', laps: 1, ph: 0.1 },
        { c: [80, -380], r: 190, z: 180, col: '#2a7ab8', laps: 1, ph: 0.6 },
        { c: [-760, -150], r: 300, z: 320, col: '#f0b429', laps: 1, ph: 0.3 },
        { c: [120, 280], r: 150, z: 140, col: '#5b9a3c', laps: 1, ph: 0.85 },
      ];
      for (const bl of balloons) {
        const tf = (t) => {
          const a = (t / PERIOD * bl.laps + bl.ph) * 2 * Math.PI;
          return m4.translation(bl.c[0] + bl.r * Math.cos(a), bl.c[1] + bl.r * Math.sin(a), bl.z + 25 * Math.sin(a * 2 + 1));
        };
        const times = adaptiveTimes(tf, 0, PERIOD, { tolerance: 0.2, size: 10, maxStep: 8 });
        b.dynamic(balloonGeo(bl.col), { times, transform: tf, caps: 'none' });
        // the flame takes the envelope's burner rhythm from its colour, as BALLOON does (the tag holds it)
        const lin = parseHex(bl.col).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        const seed = lin[1] * 3.7 + lin[2] * 1.3;
        b.dynamic(balloonDetailGeo().tag(Math.round((seed - Math.floor(seed)) * 255)), { times, transform: tf, caps: 'none', within: 60 });
      }
      const blimp = (t) => {
        const a = (t / PERIOD) * 2 * Math.PI;
        const pos = [-40 + 540 * Math.cos(a), -80 + 840 * Math.sin(a), 210 + 15 * Math.sin(2 * a)];
        const dir = [-540 * Math.sin(a), 840 * Math.cos(a), 30 * Math.cos(2 * a)];
        return m4.facing(pos, dir);
      };
      const blimpTimes = adaptiveTimes(blimp, 0, PERIOD, { tolerance: 0.2, size: 30, maxStep: 8 });
      b.dynamic(blimpGeo(), { times: blimpTimes, transform: blimp, caps: 'none' });
      b.dynamic(blimpDetailGeo(), { times: blimpTimes, transform: blimp, caps: 'none', within: 80 });
      const boats = [
        { c: [780, 150], a: 260, b: 90, sail: '#f7f5ef', ph: 0 },
        { c: [1000, -450], a: 330, b: 130, sail: '#e74c3c', ph: 0.4 },
        { c: [960, 700], a: 240, b: 110, sail: '#f7f5ef', ph: 0.7 },
        { c: [1350, 120], a: 380, b: 160, sail: '#2e86c1', ph: 0.2 },
        { c: [820, -1650], a: 220, b: 100, sail: '#f4d03f', ph: 0.55 },
      ];
      for (const bt of boats) {
        const tf = (t) => {
          const a = (t / PERIOD + bt.ph) * 2 * Math.PI;
          return m4.facing([bt.c[0] + bt.b * Math.cos(a), bt.c[1] + bt.a * Math.sin(a), 0.05], [-bt.b * Math.sin(a), bt.a * Math.cos(a), 0]);
        };
        const times = adaptiveTimes(tf, 0, PERIOD, { tolerance: 0.15, size: 5, maxStep: 8 });
        b.dynamic(boatGeo(bt.sail), { times, transform: tf, caps: 'none' });
        b.dynamic(boatDetailGeo(), { times, transform: tf, caps: 'none', within: 50 });
      }
    }
  },
};
