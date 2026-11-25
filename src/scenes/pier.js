// Pleasure Pier: a Victorian seaside pier on a summer evening, on a day that
// runs fast.  The pier runs straight out to sea from the promenade, with a
// little railway on it, and ends in a fairground: a big wheel, a swing ride,
// a swing boat, a helter-skelter, Punch and Judy, and a pavilion with a clock
// tower.  A lighthouse sweeps the bay from the harbour arm, a barge offshore
// fires rockets all night, speedboats, jet skis, yachts and a trip boat go
// by, and the tide comes in and goes out every three minutes.
//
// Everything here goes through a visible cycle, which a tilted view turns
// into shapes: the sky and the clocks (a gradient of hours), the tide (the
// sea ahead stands at an earlier tide: it slopes up or down the tide boards),
// the lamps switching on at dusk in a wave out along the pier, the chasing
// bulbs and the channel buoys flashing in turn (patterns whose speed depends
// on the tilt), the wheel, the swing ride and the lighthouse beams (spirals
// and helices), the swing boat (a wave), the fireworks' expanding shells
// (cones), the queue for the swing ride (long in one part of the view, short
// in another), and trains, boats, cars, cyclists and people moving both ways
// at many different speeds along the pier's and the promenade's sight lines.
// C is 5 m/s, so each of those speeds has its own tilt (between 16 and 75
// degrees) at which things coming towards the visitor stretch without limit.
//
// Layout (metres; +x east, +y north, z up; mean sea level z = 0):
//   sea            x < 0 (west); the sun sets in the west-north-west, right of the pier
//   beach          from the sea wall at x = 0 (sand at z = 3) down to the sea; huts, deckchairs, donkeys;
//                  steps down to it from the promenade at y = 13..23, beside the pier
//   promenade      x 0..20 at z = 7 (floral clock at (9, -27)), the road (x 22..36), hotels (x > 42),
//                  the town and its hills behind, headlands closing the bay at y = +-1100 and beyond
//   pier entry     x -30..0, |y| < 13: gate with a clock, two kiosks, the shore station (x -35..-7)
//   pier neck      x -232..-30, |y| < 6.5, deck at z = 7; two railway tracks on the south side,
//                  a fence, the walkway on the north side; clock column at (-206, 3.6)
//   pier head      x -336..-232, |y| < 36: head station (x -228..-200, on the neck), swing ride
//                  (-247, 23) and swing boat (-300, 27) on the north side, big wheel (-262, -17)
//                  and helter-skelter (-296, -24) on the south, Punch and Judy (-280, 8), pavilion
//                  with clock tower (x -336..-303), landing stage (x -326..-311, south edge)
//   harbour arm    from the shore at y = 300 out to the lighthouse at (-196, 338); channel buoys
//   firework barge (-560, -10)
// The visitor starts at the landward end of the pier head's approach, at
// (-182, 1), looking out along the pier to the fairground and the sunset.
//
// Timeline.  Dynamic things repeat every P = 180 s; the sky, the lamps and
// the clocks follow a day of 600 s whose hours are slowed round dusk and dawn:
//   t = -17   sunset (18:00); the pier lamps switch on in a wave from the
//             shore at 6 m/s: past the visitor at t = 14, the pier head at 39
//   t = 0     18:21, afterglow; both trains in their stations (A at the shore, B at the head)
//   t = 4     both trains leave (every 45 s: A and B alternate); they cross half way out at t = 21
//   t = 13    18:35: the fireworks begin to show against the sky (full night from 19:00, t = 40)
//   t = 45    high water (+1.7 m); t = 135 low water (-1.7 m)
//   t = 163   midnight; t = 269 05:36, the lamps go out in a wave; t = 463 noon; t = 583 sunset again
//   rides     the wheel turns every 36 s; the swing ride runs 70 s, then loads for 20 s (from 50 s
//             past every 90 s); the swing boat swings for 46 s of every 60 s

import { Geo } from '../geom.js';
import { m4, v3 } from '../math.js';
import { dayNightEnv } from '../env.js';
import { Path, adaptiveTimes, timeRange, rng } from '../util.js';

// Development switch (?draft in the page address): fewer copies of the things
// that repeat, for quicker test pictures.  Absent in normal use.
const DRAFT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('draft');
const thin = (n) => (DRAFT ? Math.max(1, Math.ceil(n / 4)) : n);

// ---------------------------------------------------------------------------
// constants shared by the geometry and the shader

const C = 5;                  // metres per second: walkers at 0.26 C, cyclists 1.1 C, the trains 1.8 C, cars 2.5 C, speedboats 3.4 C
const P = 180;                // every moving thing repeats after this many seconds
const DAY = 600;              // seconds per day (25 s an hour on average; slower at dusk and dawn, see WARP)
const HOUR0 = 18.35;          // time of day at t = 0: the sun has just set over the sea, in the west-north-west
const WARP = 0.62;            // how much the hours slow down round 18:45 and 06:45 (and speed up round noon and midnight)
const PHS = 18.75 / 24 - 0.25;
const SUN_AZ = -26 * Math.PI / 180;   // the sun's path is turned this far: it sets in the west-north-west, right of the pier
const hourOfPhase = (ph) => 24 * ph + (24 * WARP / (4 * Math.PI)) * Math.sin(4 * Math.PI * (ph - PHS));
const PH0 = (() => {
  let lo = -0.2, hi = 1.2;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (hourOfPhase(m) < HOUR0) lo = m; else hi = m; }
  return (lo + hi) / 2;
})();
const TIDE_A = 1.7;           // the tide rises and falls this far either side of mean sea level ...
const TIDE_T = P;             // ... once in this many seconds: high water at t = 45, low water at t = 135
const tideZ = (t) => TIDE_A * Math.sin(2 * Math.PI * t / TIDE_T);

const DECK = 7.0;             // top of the pier deck, the promenade and the town
const ENTRY = { x0: -30, x1: 0, hw: 13 };   // the wider first stretch, with the gate and the shore station
const NECK = { x0: -232, x1: 0, hw: 6.5 };
const HEAD = { x0: -336, x1: -232, hw: 36 };
const TRACK_Y = [-2.15, -4.65];   // the two railway tracks (north one: track A)
const FENCE_Y = -0.75;            // the fence between the railway and the walkway
const STATION_X = [-21, -214];    // shore and pier-head stations (centre of a standing train)

const WHEEL = { x: -262, y: -17, r: 17.5, hub: 21.5, yaw: -Math.PI / 4, turn: 36 };   // a turn every 36 s
const SWING = { x: -247, y: 23 };
const BOAT = { x: -300, y: 27 };
const SKELTER = { x: -296, y: -24 };
const PAVILION = { x0: -336, x1: -306, hw: 18 };
const LIGHT = { x: -196, y: 338, z: 26.5 };
const BARGE = { x: -560, y: -10 };

const TAU = Math.PI * 2;
const sstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// material ids
const MAT = {
  SAND: 1, SEA: 2, DECK: 3, IRON: 4, RAILING: 5, PAVING: 6, ROAD: 7, FACADE: 8, GLASS: 9, ROOF: 10,
  LAMP: 11, BULB: 12, CLOCK: 13, SIGN: 14, NEON: 15, SKIN: 16, CLOTH: 17, HAIR: 18, PAINT: 19, WOOD: 20,
  STONE: 21, GRASS: 22, SPARK: 23, BEAM: 24, RIMLIGHT: 25, STEEL: 26, ZINC: 27, LATTICE: 28, CANVAS: 29,
  BOARD: 30, ROCK: 31, WHEEL: 32, WINDOW: 33, WAKE: 34, SAIL: 35, TOWN: 36, MARQUEE: 37,
};

// ---------------------------------------------------------------------------
// the land: beach and sea bed west of the sea wall, the town east of it, and
// two headlands closing the bay to the north and south.  (The same beach
// profile is in the shader, which needs the depth of the water.)

function hsh(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed + 0x3c6ef372, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function vnoise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hsh(ix, iy, seed), b = hsh(ix + 1, iy, seed), c = hsh(ix, iy + 1, seed), d = hsh(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, oct, seed = 0) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y, seed + i * 17); n += a;
    const nx = x * 1.7 - y * 1.1, ny = x * 1.1 + y * 1.7;
    x = nx + 3.1; y = ny - 1.7; a *= 0.5;
  }
  return s / n;
}
function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

// the beach: 1 in 26 from the foot of the sea wall to below the low-tide
// line, then the sea bed falls away more gently
function sandBase(x) {
  return x > -170 ? 3.0 + x / 26 : Math.max(-14, 3.0 - 170 / 26 + (x + 170) / 45);
}
function sandZ(x, y) {
  let z = sandBase(x);
  // a low sand bar beyond the low-tide line, and gentle runnels
  z += 0.55 * Math.exp(-Math.pow((x + 150) / 16, 2)) * (0.75 + 0.25 * Math.sin(y / 61));
  z += 0.18 * Math.sin(y / 47 + x / 23) * sstep(-15, -60, x) * sstep(-170, -120, x);
  return z;
}
// the headlands at the ends of the bay
function headland(x, y) {
  let best = -100;
  for (const [cx, cy, R, H] of [[-520, 1760, 760, 78], [-560, -1820, 820, 92]]) {
    const dx = (x - cx), dy = (y - cy) * 0.8;
    const r = Math.hypot(dx, dy) * (1 + 0.18 * (fbm(x / 260, y / 260, 3, 5) - 0.5));
    const k = Math.max(0, 1 - r / R);
    if (k <= 0) continue;
    // a cliff round the edge, a rolling top
    const z = -16 + (H + 16) * sstep(0, 0.28, k) + 14 * (fbm(x / 90, y / 90, 3, 9) - 0.5) * sstep(0.1, 0.4, k) + 20 * k * k;
    best = Math.max(best, z);
  }
  return best;
}
// the town and the hills behind it
function landZ(x, y) {
  let z = DECK + 58 * sstep(260, 820, x) * (0.8 + 0.4 * fbm(y / 500, x / 500, 3, 2)) + 9 * sstep(300, 600, x) * (fbm(x / 140, y / 140, 3, 3) - 0.5);
  const h = headland(x, y);
  if (h > z - 30) z = smax(z, h, 20);
  return z;
}
function seabedZ(x, y) {
  const z = sandZ(x, y);
  const h = headland(x, y);
  return h > z - 30 ? smax(z, h, 12) : z;
}

const onNeck = (x, y) => x >= NECK.x0 - 0.01 && x <= NECK.x1 && Math.abs(y) <= NECK.hw;
const onHead = (x, y) => x >= HEAD.x0 && x <= HEAD.x1 + 0.01 && Math.abs(y) <= HEAD.hw;
const onEntry = (x, y) => x >= ENTRY.x0 && x <= ENTRY.x1 && Math.abs(y) <= ENTRY.hw;
const STAGE = { x0: -326, x1: -311, y0: -HEAD.hw - 2.2 };   // the landing stage on the south side of the head
const onStage = (x, y) => x >= STAGE.x0 && x <= STAGE.x1 && y >= STAGE.y0 && y <= -HEAD.hw;
const onPier = (x, y) => onNeck(x, y) || onHead(x, y) || onEntry(x, y) || onStage(x, y);
// Steps down the face of the sea wall to the beach, just north of the pier's
// entrance: a landing at the top (y0..y1), then a flight of 4 m down to the
// sand (y1..y2) at 29 degrees.  The walker goes down a smooth ramp half a
// step under the nosings.  (The beach that they lead to is closed off at the
// high-water line and by the pier and the harbour arm: see beachSteps.)
const STEPS = { x0: -2.3, y0: 13.2, y1: 15.2, y2: 22.6, n: 16 };
const onSteps = (x, y) => x >= STEPS.x0 && x < 0 && y >= STEPS.y0 && y <= STEPS.y2;
function stepsZ(x, y) {
  if (y <= STEPS.y1) return DECK;
  const zb = sandZ(x, STEPS.y2), rise = (DECK - zb) / STEPS.n;
  return lerp(DECK - rise / 2, zb, (y - STEPS.y1) / (STEPS.y2 - STEPS.y1));
}

// the ground the visitor walks on
function ground(x, y) {
  if (onPier(x, y)) return DECK;
  if (x >= 0) return landZ(x, y);
  if (onSteps(x, y)) return stepsZ(x, y);
  return seabedZ(x, y);
}

// A grid over [x0, x1] x [y0, y1] with cells of size s, leaving out the
// rectangle `hole` (aligned to the cells).  The vertices along the border are
// put on straight lines every `snap` cells, so that the grid meets a coarser
// one round it without cracks.  colour(x, y, z) gives the vertex colour.
function hgrid(x0, y0, x1, y1, s, height, { hole = null, snap = 1, color = null, mat = 0 } = {}) {
  const nx = Math.round((x1 - x0) / s), ny = Math.round((y1 - y0) / s), w = nx + 1;
  const H = new Float64Array(w * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) H[j * w + i] = height(x0 + i * s, y0 + j * s);
  if (snap > 1) {
    const line = (count, idx) => {
      for (let q = 0; q < count; q += snap) {
        const a = H[idx(q)], b = H[idx(Math.min(count, q + snap))];
        for (let m = 1; m < snap && q + m <= count; m++) H[idx(q + m)] = a + (b - a) * m / snap;
      }
    };
    line(nx, (i) => i); line(nx, (i) => ny * w + i); line(ny, (j) => j * w); line(ny, (j) => j * w + nx);
  }
  const g = new Geo();
  const vid = new Int32Array(w * (ny + 1)).fill(-1);
  const vert = (i, j) => {
    const o = j * w + i;
    if (vid[o] >= 0) return vid[o];
    const x = x0 + i * s, y = y0 + j * s, z = H[o];
    const zx0 = i > 0 ? H[o - 1] : height(x - s, y), zx1 = i < nx ? H[o + 1] : height(x + s, y);
    const zy0 = j > 0 ? H[o - w] : height(x, y - s), zy1 = j < ny ? H[o + w] : height(x, y + s);
    const n = v3.norm([-(zx1 - zx0) / (2 * s), -(zy1 - zy0) / (2 * s), 1]);
    const id = g.vert(x, y, z, n[0], n[1], n[2], x * 0.05, y * 0.05);
    if (color) { const c = color(x, y, z, n); g.c[id * 3] = c[0]; g.c[id * 3 + 1] = c[1]; g.c[id * 3 + 2] = c[2]; }
    vid[o] = id;
    return id;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = x0 + (i + 0.5) * s, cy = y0 + (j + 0.5) * s;
      if (hole && cx > hole[0] && cx < hole[2] && cy > hole[1] && cy < hole[3]) continue;
      const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
      g.tri(a, b, c); g.tri(a, c, d);
    }
  }
  return g.orientByNormals().mat(mat);
}

// ---------------------------------------------------------------------------
// geometry helpers

// A cheaper box with small chamfered edges (44 triangles), shaded as if
// rounded.  uv: metres across each face.
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
  const at = (a, s) => V(a, s[a], s[(a + 1) % 3], s[(a + 2) % 3]);
  for (let a = 0; a < 3; a++) {
    for (const sa of [-1, 1]) g.quadIdx(V(a, sa, -1, -1), V(a, sa, 1, -1), V(a, sa, 1, 1), V(a, sa, -1, 1));
  }
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
  for (const sx2 of [-1, 1]) for (const sy2 of [-1, 1]) for (const sz2 of [-1, 1]) {
    const c = [sx2, sy2, sz2];
    g.tri(at(0, c), at(1, c), at(2, c));
  }
  const x = g.idx, Pp = g.p;
  for (let i = 0; i < x.length; i += 3) {
    const A = x[i] * 3, B = x[i + 1] * 3, Cc = x[i + 2] * 3;
    const e1 = [Pp[B] - Pp[A], Pp[B + 1] - Pp[A + 1], Pp[B + 2] - Pp[A + 2]], e2 = [Pp[Cc] - Pp[A], Pp[Cc + 1] - Pp[A + 1], Pp[Cc + 2] - Pp[A + 2]];
    const nn = v3.cross(e1, e2);
    const cx = Pp[A] + Pp[B] + Pp[Cc], cy = Pp[A + 1] + Pp[B + 1] + Pp[Cc + 1], cz = Pp[A + 2] + Pp[B + 2] + Pp[Cc + 2];
    if (nn[0] * cx + nn[1] * cy + nn[2] * cz < 0) { const t = x[i + 1]; x[i + 1] = x[i + 2]; x[i + 2] = t; }
  }
  return g;
}
// a box between two corners
const boxAt = (x0, y0, z0, x1, y1, z1) => Geo.box(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
// a vertical rectangle facing direction (nx, ny), centred at (x, y), from z0 up
// to z1, width w; uv in metres (u along, v up) unless `unit`
function panel(x, y, nx, ny, w, z0, z1, unit = false) {
  const tx = -ny, ty = nx; // along the panel, to the right seen from the front
  const a = [x - tx * w / 2, y - ty * w / 2], b = [x + tx * w / 2, y + ty * w / 2];
  const g = Geo.quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
  if (g.n[0] * nx + g.n[1] * ny < 0) g.flip();
  if (!unit) { g.uv[0] = 0; g.uv[1] = 0; g.uv[2] = w; g.uv[3] = 0; g.uv[4] = w; g.uv[5] = z1 - z0; g.uv[6] = 0; g.uv[7] = z1 - z0; }
  // (quad corners are a, b, b-up, a-up: the uv follows them)
  return g;
}
// a straight tube between two points (r, seg sides)
const rod = (a, b, r, seg = 6) => Geo.tube([a, b], r, seg, { caps: false });
// the same in n lengths (for a long rod on something that moves: see inPieces)
const rodIn = (a, b, r, seg, n) => Geo.tube([...Array(n + 1).keys()].map((i) => v3.lerp(a, b, i / n)), r, seg, { caps: false });

// Moving things in pieces.  A slice tilted close to 90 degrees touches a
// moving thing at every step of its movement during which the thing is no
// further from the slice than it is big that way: something 30 m tall, at
// every step of the minutes it takes a slice tilted up by 89 degrees to rise
// 30 m.  Cut into pieces a few metres across, each piece is drawn only for
// the steps during which the slice crosses that piece: the same picture, for
// a fraction of the cost.  (Every piece has the movement of the whole.)

// A stiff mesh in pieces: by where its triangles' middles lie in a grid of
// cells `size` across, in its own frame.  Whatever is long has to be built
// in lengths no longer than that (as rodIn does), so that no piece reaches
// far.  (Not by halving the long triangles here: what a triangle sweeps from
// key to key is split by the order of its corners among the mesh's vertices,
// and a thin thing that turns stays thin only in the order in which its
// shape was made: see Geo.pick.)  A piece of fewer than 16 triangles goes
// with the piece nearest to it: fewer than that are kept together over
// several steps of the movement, in a larger box.
function inPieces(g, size) {
  const cells = new Map();
  g.pick((t, mid) => {
    const key = mid.map((v) => Math.floor(v / size)).join(',');
    if (!cells.has(key)) cells.set(key, { tris: new Set(), mid });
    cells.get(key).tris.add(t);
    return false;
  });
  const groups = [...cells.values()];
  for (const gr of groups.filter((q) => q.tris.size < 16)) {
    let best = null, bd = Infinity;
    for (const o of groups) if (o !== gr && o.tris.size >= 16) { const d = v3.dist(o.mid, gr.mid); if (d < bd) { bd = d; best = o; } }
    if (best) { for (const t of gr.tris) best.tris.add(t); gr.tris.clear(); }
  }
  return groups.filter((q) => q.tris.size).map((q) => g.pick((t) => q.tris.has(t)));
}
// A mesh that changes shape over a round (u => Geo, the same triangles every
// time) in two: the triangles whose middles, at u = 0, pass test(middle), and
// the rest.
function cutPoses(fn, test) {
  const g0 = fn(0), a = new Set();
  g0.pick((t, mid) => { if (test(mid)) a.add(t); return false; });
  if (a.size === 0 || a.size === g0.triangleCount) return [fn];
  return [(u) => fn(u).pick((t) => a.has(t)), (u) => fn(u).pick((t) => !a.has(t))];
}

// Key times for a straight run at constant speed from t0 to t1 over `dist`
// metres: two would do for the motion, but a key every `step` metres keeps
// each piece of it small, so that a tilted slice, which meets the run in one
// place, takes in only the piece there.
function runKeys(t0, t1, dist, step = 25) {
  return timeRange(t0, t1, (t1 - t0) / Math.max(1, Math.ceil(dist / step)));
}

// Adds a moving thing whose keys may run past the period P: the part of its
// run beyond each multiple of P is added a period earlier instead (the scene
// repeats every P, so it is the same thing).  That keeps every moving piece of
// the scene within 0..P, which matters for a view tilted to 90 degrees: it
// takes in every repeat between the earliest and the latest piece.  (A
// movement of its own that repeats, opts.cycle, keeps its step: a round that
// begins at `start` still does in the piece moved a period earlier.)
function dynWrapped(b, geo, times, transform, opts = {}) {
  const t0 = times[0], t1 = times[times.length - 1];
  const kFirst = Math.floor(t0 / P + 1e-9), kLast = Math.ceil(t1 / P - 1e-9) - 1;
  if (kFirst === kLast && kFirst === 0) { b.dynamic(geo, { ...opts, times, transform }); return; }
  for (let k = kFirst; k <= kLast; k++) {
    const a = Math.max(t0, k * P), c = Math.min(t1, (k + 1) * P);
    if (c - a < 1e-6) continue;
    const ks = [a, ...times.filter((t) => t > a + 1e-6 && t < c - 1e-6), c];
    const shift = k * P;
    const caps = a === t0 && c === t1 ? 'auto' : a === t0 ? 'start' : c === t1 ? 'end' : 'none';
    const o = { ...opts, times: ks.map((t) => t - shift), transform: (t) => transform(t + shift), caps };
    if (opts.cycle) {
      const n = Math.round(shift / opts.cycle.period);
      o.cycle = { ...opts.cycle, start: (opts.cycle.start ?? 0) - (shift - n * opts.cycle.period) };
    }
    b.dynamic(geo, o);
  }
}

// Something that moves along straight legs through `pts` at speed v from t0,
// turning quickly at the corners: keys at the corners, just before each, and
// every 25 m between.  parts: more meshes that go with it, each { geo, within,
// cycle } (a cycled mesh: legs that stride, wheels and pedals that turn).
function legMover(b, geo, pts, v, t0, z, within, parts = []) {
  const legs = [];
  let T = t0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    legs.push({ a: pts[i - 1], b: pts[i], t0: T, t1: T + L / v, L });
    T += L / v;
  }
  const tf = (t) => {
    let lg = legs[0];
    for (const l of legs) if (t >= l.t0 - 1e-9) lg = l;
    const u = Math.min(1, Math.max(0, (t - lg.t0) / (lg.t1 - lg.t0)));
    return m4.facing([lerp(lg.a[0], lg.b[0], u), lerp(lg.a[1], lg.b[1], u), z], [lg.b[0] - lg.a[0], lg.b[1] - lg.a[1], 0]);
  };
  const ks = [];
  for (const l of legs) {
    const n = Math.max(1, Math.ceil(l.L / 25));
    for (let k = 0; k < n; k++) ks.push(l.t0 + (l.t1 - l.t0) * k / n);
    if (l.t1 - l.t0 > 1) ks.push(l.t1 - 0.35);
  }
  ks.push(T);
  const kt = ks.sort((a, c) => a - c).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.05);
  dynWrapped(b, geo, kt, tf, { within });
  for (const p of parts) dynWrapped(b, p.geo, kt, tf, { within: p.within ?? within, cycle: p.cycle });
}

// numbers into WGSL
const f = (v) => {
  const s = Number(v).toFixed(6).replace(/0+$/, '');
  return s.endsWith('.') ? s + '0' : s;
};

// ---------------------------------------------------------------------------
// lettering: a stroke font, drawn as a distance field into one table that
// holds every sign of the scene, a line each.  A sign's mesh gets its line
// as its tag and its uv across the text; the shader looks the distance up.

const FONT = (() => {
  const O = [[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]];
  const Pq = [[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]];
  return {
    A: [[[0, 0], [2, 6], [4, 0]], [[0.7, 2], [3.3, 2]]],
    B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
    C: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1]]],
    D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
    E: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
    F: [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
    G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2.2, 3]]],
    H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
    I: [[[2, 0], [2, 6]], [[1, 6], [3, 6]], [[1, 0], [3, 0]]],
    J: [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
    K: [[[0, 0], [0, 6]], [[4, 6], [0, 2.5]], [[1.3, 3.6], [4, 0]]],
    L: [[[0, 6], [0, 0], [4, 0]]],
    M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
    N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
    O: [O],
    P: [Pq],
    Q: [O, [[2.5, 1.5], [4, -0.3]]],
    R: [Pq, [[2, 3], [4, 0]]],
    S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
    T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
    U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
    V: [[[0, 6], [2, 0], [4, 6]]],
    W: [[[0, 6], [1, 0], [2, 4], [3, 0], [4, 6]]],
    X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
    Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
    Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
    0: [O, [[0.6, 1.2], [3.4, 4.8]]],
    1: [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
    2: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
    3: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1.5, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
    4: [[[3, 0], [3, 6], [0, 2], [4, 2]]],
    5: [[[4, 6], [0, 6], [0, 3.5], [3, 3.5], [4, 2.5], [4, 1], [3, 0], [1, 0], [0, 1]]],
    6: [[[3.5, 6], [1.5, 6], [0, 4], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2.5], [3, 3.5], [0, 3.5]]],
    7: [[[0, 6], [4, 6], [1.5, 0]]],
    8: [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
    9: [[[4, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]]],
    '&': [[[4, 0], [0.8, 4.4], [0.8, 5.3], [1.5, 6], [2.5, 6], [3.1, 5.3], [3.1, 4.6], [0, 2], [0, 1], [1, 0], [2.5, 0], [4, 2]]],
    '-': [[[1, 3], [3, 3]]],
    '.': [[[2, 0], [2, 0.02]]],
    ',': [[[2.2, 0.3], [1.6, -0.8]]],
    "'": [[[2, 6], [2, 4.6]]],
    '!': [[[2, 6], [2, 2]], [[2, 0], [2, 0.02]]],
    ':': [[[2, 1.2], [2, 1.22]], [[2, 4.2], [2, 4.22]]],
    '/': [[[0, 0], [4, 6]]],
    '£': [[[4, 5], [3, 6], [2, 6], [1, 5], [1, 0]], [[0, 3], [2.5, 3]], [[0, 0], [4, 0]]],
    'p': [[[0, -0.2], [0, 4], [2.6, 4], [3.4, 3.2], [3.4, 2.6], [2.6, 1.8], [0, 1.8]]],
    ' ': [],
  };
})();

const LETTER_W = 512, LETTER_H = 48, LETTER_LINES = 128;
const SIGNS = [];   // { text, aspect }: one line each, in order
// Registers a line of text; returns { line, u0, u1, aspect } (aspect = width / height of the lettered area).
function signLine(text) {
  const found = SIGNS.findIndex((s) => s.text === text);
  if (found >= 0) return SIGNS[found].info;
  const n = text.length, adv = 5.6, widthU = n * adv - 1.6 + 3.2, heightU = 9.2;
  const aspect = widthU / heightU;
  const info = { line: SIGNS.length, aspect, u0: 0, u1: 1 };
  // the text fills the band's height; the band is wider than most lines
  const span = Math.min(1, aspect * LETTER_H / LETTER_W);
  info.u0 = 0.5 - span / 2; info.u1 = 0.5 + span / 2;
  info.scaleX = aspect * LETTER_H / LETTER_W > 1 ? LETTER_W / (aspect * LETTER_H) : 1; // squeezed if too long
  SIGNS.push({ text, info });
  if (SIGNS.length > LETTER_LINES) throw new Error('too many sign lines');
  return info;
}
function letterTable() {
  const data = new Uint8Array(LETTER_W * LETTER_H * LETTER_LINES).fill(255);
  const RANGE = 2.4;   // font units of distance the table covers (0 .. 255)
  SIGNS.forEach(({ text, info }, li) => {
    const n = text.length, adv = 5.6, heightU = 9.2;
    const scale = LETTER_H / heightU;                 // texels per font unit (vertically)
    const sx = scale * info.scaleX;                   // horizontally
    const widthT = (n * adv - 1.6 + 3.2) * sx;
    const x0 = (LETTER_W - widthT) / 2 + 1.6 * sx, y0 = 1.6 * scale;
    // segments in font units, each char offset
    const segs = [];
    for (let k = 0; k < n; k++) {
      const strokes = FONT[text[k]] || FONT[text[k].toUpperCase()] || [];
      for (const st of strokes) {
        for (let q = 0; q < st.length - 1; q++) segs.push([k, st[q][0] + k * adv, st[q][1], st[q + 1][0] + k * adv, st[q + 1][1]]);
      }
    }
    for (let j = 0; j < LETTER_H; j++) {
      const fy = (j + 0.5 - y0) / scale;
      for (let i = 0; i < LETTER_W; i++) {
        const fx = (i + 0.5 - x0) / sx;
        const k0 = Math.floor(fx / adv);
        let best = RANGE;
        for (const [k, ax, ay, bx, by] of segs) {
          if (k < k0 - 1 || k > k0 + 1) continue;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
          const tt = Math.max(0, Math.min(1, ((fx - ax) * dx + (fy - ay) * dy) / L2));
          const d = Math.hypot(fx - ax - dx * tt, fy - ay - dy * tt);
          if (d < best) best = d;
        }
        data[(li * LETTER_H + j) * LETTER_W + i] = Math.round(255 * best / RANGE);
      }
    }
  });
  return data;
}
// A sign: a panel facing (nx, ny) with a line of text, height h (the
// lettered area); returns the mesh (uv across the text, tag = the line).
// style: 0 painted (dark letters on the board's colour), 1 gilt, 2 neon
function signGeo(text, x, y, z, nx, ny, h, style = 0) {
  const info = signLine(text);
  const w = h * Math.min(info.aspect, LETTER_W / LETTER_H);
  const g = panel(x, y, nx, ny, w, z - h / 2, z + h / 2, true);
  // uv: u across the lettered part of the line, v up
  for (let i = 0; i < 4; i++) g.uv[i * 2] = lerp(info.u0, info.u1, g.uv[i * 2]);
  return g.mat(MAT.SIGN).tag(info.line).aux(style / 4).cutout();
}

// ---------------------------------------------------------------------------
// the tide and the sea surface: a grid that rises and falls with the tide
// (a rigid movement: two keys per straight stretch, twelve per tide)

// The moving surface covers the bay within SEA_R of the pier, in cells of
// 150 m (it is flat: the waves are the shader's); beyond it the sea is static
// at mean sea level, which the fog has mostly swallowed by then.  The moving
// surface is the costliest moving thing in a tilted view, which takes in all
// of its keys several times over, so it is kept small and has eight keys a tide.
const SEA_R = [-1500, -1500, 0, 1500];
function seaGrid(x0, y0, x1, y1, s, hole) {
  const g = new Geo();
  const nx = Math.round((x1 - x0) / s), ny = Math.round((y1 - y0) / s);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) g.vert(x0 + i * s, y0 + j * s, 0, 0, 0, 1, 0, 0);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = x0 + (i + 0.5) * s, cy = y0 + (j + 0.5) * s;
      if (hole && cx > hole[0] && cx < hole[2] && cy > hole[1] && cy < hole[3]) continue;
      // (not where the land stands well above the water all over the cell)
      let low = Infinity;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) low = Math.min(low, seabedZ(x0 + (i + u) * s, y0 + (j + v) * s));
      if (low > TIDE_A + 1) continue;
      const a = j * (nx + 1) + i;
      g.quadIdx(a, a + 1, a + nx + 2, a + nx + 1);
    }
  }
  return g.orientByNormals().mat(MAT.SEA).noShadow();
}

// ---------------------------------------------------------------------------
// the pier: deck, piles and girders, railings, lamps and festoons of bulbs

const DECK_RECTS = [
  [ENTRY.x0, -ENTRY.hw, ENTRY.x1, ENTRY.hw],
  [NECK.x0, -NECK.hw, ENTRY.x0, NECK.hw],
  [HEAD.x0, -HEAD.hw, HEAD.x1, HEAD.hw],
];
const IRON_GREEN = '#2d5246', IRON_CREAM = '#d8cfb4', IRON_DARK = '#1d2b27';

function pierDeck(b) {
  for (const [x0, y0, x1, y1] of DECK_RECTS) {
    const nx = Math.ceil((x1 - x0) / 26), ny = Math.ceil((y1 - y0) / 26);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const a = x0 + (x1 - x0) * i / nx, c = x0 + (x1 - x0) * (i + 1) / nx;
        const bb = y0 + (y1 - y0) * j / ny, d = y0 + (y1 - y0) * (j + 1) / ny;
        b.static(boxAt(a, bb, DECK - 0.28, c, d, DECK).color('#9a7a58').mat(MAT.DECK).cutout());
      }
    }
  }
}

// cast-iron piles in bents across the pier, braced, with girders under the deck
function pierFrame(b) {
  const iron = new Geo(), web = new Geo();
  const pile = (x, y) => {
    const z0 = seabedZ(x, y) - 0.6, z1 = DECK - 0.95;
    iron.add(Geo.cylinder(0.19, z1 - z0, 10, { caps: false }).translate(x, y, z0));
    iron.add(Geo.cylinder(0.3, 0.45, 10).translate(x, y, Math.max(z0 + 0.6, -0.6)));
    iron.add(Geo.cylinder(0.27, 0.3, 10).translate(x, y, z1 - 0.3));
    return [z0 + 0.6, z1];
  };
  const brace = (x0, y0, x1, y1, zl0, zl1, zh) => {
    // a pair of crossed flat bars and a tie between two piles
    const lo = Math.max(zl0, zl1, -1.2) + 0.3;
    if (zh - lo < 1.2) return;
    iron.add(rod([x0, y0, lo], [x1, y1, zh], 0.05, 4));
    iron.add(rod([x0, y0, zh], [x1, y1, lo], 0.05, 4));
    iron.add(rod([x0, y0, (lo + zh) / 2], [x1, y1, (lo + zh) / 2], 0.06, 4));
  };
  const bent = (x, ys) => {
    const tops = ys.map((y) => pile(x, y));
    for (let k = 0; k < ys.length - 1; k++) brace(x, ys[k], x, ys[k + 1], tops[k][0], tops[k + 1][0], DECK - 1.3);
    // cross girder
    iron.add(boxAt(x - 0.18, ys[0] - 0.3, DECK - 0.95, x + 0.18, ys[ys.length - 1] + 0.3, DECK - 0.28));
    return tops;
  };
  // neck (and entry): bents every 9 m
  let prev = null;
  for (let x = -3; x >= NECK.x0 + 2; x -= 9) {
    const wide = x > ENTRY.x0;
    const ys = wide ? [-12.4, -6.2, -2, 2, 6.2, 12.4] : [-6.2, -2, 2, 6.2];
    const tops = bent(x, ys);
    if (prev && prev.ys.length === ys.length) {
      // longitudinal bracing on the outer lines
      for (const k of [0, ys.length - 1]) brace(prev.x, ys[k], x, ys[k], prev.tops[k][0], tops[k][0], DECK - 1.3);
    }
    prev = { x, ys, tops };
  }
  // the head: a grid of piles
  for (let x = HEAD.x1 - 2; x >= HEAD.x0 + 2; x -= 9) {
    const ys = [];
    for (let y = -HEAD.hw + 0.6; y <= HEAD.hw - 0.5; y += 7.08) ys.push(y);
    bent(x, ys);
  }
  // longitudinal lattice girders under the deck edges, and inner stringers
  const girder = (x0, x1, y, out) => {
    for (let a = x0; a < x1 - 0.01; a += 29) {
      const c = Math.min(x1, a + 29), mx = (a + c) / 2;
      iron.add(boxAt(a, y - 0.16, DECK - 0.36, c, y + 0.16, DECK - 0.28));
      iron.add(boxAt(a, y - 0.16, DECK - 1.35, c, y + 0.16, DECK - 1.25));
      web.add(panel(mx, y, 0, out, c - a, DECK - 1.25, DECK - 0.36));
    }
  };
  girder(NECK.x0, ENTRY.x0, NECK.hw - 0.2, 1); girder(NECK.x0, ENTRY.x0, -NECK.hw + 0.2, -1);
  girder(ENTRY.x0, 0, ENTRY.hw - 0.2, 1); girder(ENTRY.x0, 0, -ENTRY.hw + 0.2, -1);
  girder(HEAD.x0, HEAD.x1, HEAD.hw - 0.2, 1); girder(HEAD.x0, HEAD.x1, -HEAD.hw + 0.2, -1);
  for (const y of [-2, 2]) iron.add(boxAt(NECK.x0, y - 0.12, DECK - 0.8, -0.5, y + 0.12, DECK - 0.28).translate(0, 0, 0));
  b.static(iron.color(IRON_DARK).mat(MAT.IRON).gloss(0.3));
  b.static(web.color(IRON_DARK).mat(MAT.LATTICE).doubleSided().cutout(), { solid: false });
}

// ornamental railings along every edge of the deck (and the promenade)
const RAIL_H = 1.08;
function railRuns() {
  const r = [];
  const E = ENTRY, N = NECK, H = HEAD;
  r.push([E.x0, E.hw, E.x1, E.hw], [E.x0, -E.hw, E.x1, -E.hw], [E.x0, N.hw, E.x0, E.hw], [E.x0, -E.hw, E.x0, -N.hw]);
  r.push([N.x0, N.hw, E.x0, N.hw], [N.x0, -N.hw, E.x0, -N.hw]);
  r.push([H.x1, N.hw, H.x1, H.hw], [H.x1, -H.hw, H.x1, -N.hw], [H.x0, H.hw, H.x1, H.hw]);
  r.push([H.x0, -H.hw, -326, -H.hw], [-311, -H.hw, H.x1, -H.hw]);   // gap for the landing stage
  r.push([-326, -H.hw, -326, -H.hw - 2.2], [-311, -H.hw, -311, -H.hw - 2.2], [-326, -H.hw - 2.2, -311, -H.hw - 2.2]);
  r.push([H.x0, -H.hw, H.x0, H.hw]);
  return r;
}
function railings(b, runs, { edge = true } = {}) {
  const top = new Geo(), infill = new Geo(), posts = [], guard = new Geo();
  for (const [x0, y0, x1, y1] of runs) {
    const L = Math.hypot(x1 - x0, y1 - y0), dx = (x1 - x0) / L, dy = (y1 - y0) / L;
    const n = Math.max(1, Math.round(L / 2.4));
    for (let i = 0; i <= n; i++) posts.push(m4.translation(x0 + dx * L * i / n, y0 + dy * L * i / n, DECK));
    for (let a = 0; a < L - 0.01; a += 28) {
      const c = Math.min(L, a + 28), m = (a + c) / 2;
      const cx = x0 + dx * m, cy = y0 + dy * m, ang = Math.atan2(dy, dx);
      top.add(cbox(c - a, 0.11, 0.07, 0.025).rotateZ(ang).translate(cx, cy, DECK + RAIL_H));
      top.add(Geo.box(c - a, 0.04, 0.05).rotateZ(ang).translate(cx, cy, DECK + 0.12));
      infill.add(panel(cx, cy, -dy, dx, c - a, DECK + 0.14, DECK + RAIL_H - 0.04));
      // An invisible screen above a railing at the edge of a drop, and below
      // the deck down to the sea bed: a jump (1.27 m) would clear the
      // railing, and the ground beyond it is the sea bed, under the deck.
      // The ground under the deck is the deck itself, so the space under it
      // is closed off (a flyer coming in under it would be lifted through it).
      if (edge) {
        let zlo = DECK - 0.4;
        for (let k = 0; k <= 8; k++) {
          for (const o of [-0.6, 0.6]) zlo = Math.min(zlo, ground(x0 + dx * lerp(a, c, k / 8) + dy * o, y0 + dy * lerp(a, c, k / 8) - dx * o) - 0.6);
        }
        guard.add(panel(cx, cy, -dy, dx, c - a, zlo, DECK + 2.9));
      }
    }
  }
  if (edge) b.static(guard.mat(MAT.GLASS).tag(9).blend(0), { solid: true });
  b.static(top.color('#6b4a2e').mat(MAT.WOOD).gloss(0.35));
  b.static(infill.color(IRON_GREEN).mat(MAT.RAILING).doubleSided().cutout());
  const post = new Geo();
  post.add(cbox(0.09, 0.09, RAIL_H, 0.015).translate(0, 0, RAIL_H / 2));
  post.add(Geo.sphere(0.07, 8, 5).translate(0, 0, RAIL_H + 0.09));
  b.instances(post.color(IRON_GREEN).mat(MAT.IRON).gloss(0.35), posts);
}

// Lamp standards: a fluted column with two globe lanterns on a scrolled
// arm.  Each copy's number is its distance out along the pier, which sets
// when it switches on at dusk.
function lampStandard() {
  const g = new Geo();
  const ironC = (geo) => geo.color(IRON_GREEN).mat(MAT.IRON).gloss(0.35);
  g.add(ironC(Geo.lathe([[0.22, 0], [0.22, 0.25], [0.15, 0.32], [0.13, 0.9], [0.09, 1.0], [0.075, 3.6], [0.11, 3.7], [0.06, 3.85]], 8)));
  g.add(ironC(Geo.tube([[-0.62, 0, 3.75], [-0.4, 0, 3.95], [0, 0, 3.85], [0.4, 0, 3.95], [0.62, 0, 3.75]], 0.035, 5)));
  for (const s of [-1, 1]) {
    g.add(ironC(Geo.cylinder(0.07, 0.12, 8).translate(s * 0.62, 0, 3.62)));
    g.add(Geo.sphere(0.21, 10, 7).translate(s * 0.62, 0, 3.47).color('#fff1d0').mat(MAT.LAMP));
    g.add(ironC(Geo.cone(0.09, 0.14, 8).translate(s * 0.62, 0, 3.67)));
  }
  g.add(ironC(Geo.lathe([[0.05, 0], [0.08, 0.08], [0.02, 0.4]], 6).translate(0, 0, 3.85)));
  return g;
}
// where the lamps stand: [x, y, along]
function lampSpots() {
  const out = [];
  for (let x = -38; x >= NECK.x0 + 4; x -= 15) for (const s of [-1, 1]) out.push([x, s * (NECK.hw - 0.35), -x]);
  for (const x of [-8, -24]) for (const s of [-1, 1]) out.push([x, s * (ENTRY.hw - 0.35), -x]);
  for (let x = HEAD.x1 - 8; x >= HEAD.x0 + 6; x -= 15) for (const s of [-1, 1]) out.push([x, s * (HEAD.hw - 0.35), -x]);
  for (let y = -HEAD.hw + 8; y <= HEAD.hw - 6; y += 14) if (Math.abs(y) > 8) out.push([HEAD.x1 + 0.35, y, -HEAD.x1]);
  return out;
}
// festoons of bulbs from lamp to lamp along the neck: the bulbs are copies,
// each with its distance along the pier as its number (for the chasing)
function festoons(b) {
  const wire = new Geo(), bulbs = [];
  const tints = ['#ff5a4a', '#ffd84a', '#5aff7a', '#5ab4ff', '#fff4e0'];
  for (const s of [-1, 1]) {
    const y = s * (NECK.hw - 0.35);
    const xs = [];
    for (let x = -38; x >= NECK.x0 + 4; x -= 15) xs.push(x);
    for (let i = 0; i < xs.length - 1; i++) {
      const xa = xs[i], xb = xs[i + 1], za = DECK + 3.82, sag = 0.75;
      const pts = [];
      for (let k = 0; k <= 10; k++) { const u = k / 10; pts.push([lerp(xa, xb, u), y, za - sag * 4 * u * (1 - u)]); }
      wire.add(Geo.tube(pts, 0.012, 3, { caps: false }));
      const nb = 24;
      for (let k = 1; k < nb; k++) {
        const u = k / nb, x = lerp(xa, xb, u);
        bulbs.push({ transform: m4.translation(x, y, za - sag * 4 * u * (1 - u) - 0.07), tint: tints[(i * nb + k) % 5], data: -x });
      }
    }
  }
  b.static(wire.color('#202020').mat(MAT.STEEL), { solid: false });
  const bulb = Geo.sphere(0.075, 6, 4).color('#ffffff').mat(MAT.BULB);
  b.instances(bulb, bulbs, { solid: false });
}

// ---------------------------------------------------------------------------
// buildings on the pier

// an octagonal kiosk with an ogee dome; returns the mesh (origin on the deck)
function kioskGeo(r, h, wallHex, domeHex) {
  const g = new Geo();
  const wall = Geo.cylinder(r, h, 8, { caps: false }).rotateZ(Math.PI / 8);
  for (let i = 0; i < wall.vertexCount; i++) { wall.uv[i * 2] *= 8 * 2 * r * Math.sin(Math.PI / 8); wall.uv[i * 2 + 1] *= h; }
  g.add(wall.color(wallHex).mat(MAT.FACADE).tag(1));
  g.add(Geo.cylinder(r + 0.25, 0.35, 8).rotateZ(Math.PI / 8).translate(0, 0, h).color(IRON_CREAM).mat(MAT.WOOD));
  g.add(Geo.cylinder(r + 0.12, 0.25, 8).rotateZ(Math.PI / 8).translate(0, 0, -0.05).color('#3a3a36').mat(MAT.STONE));
  const prof = [[r + 0.05, 0], [r * 0.98, 0.25], [r * 0.85, 0.7], [r * 0.55, 1.25], [r * 0.3, 1.55], [r * 0.18, 1.9], [r * 0.12, 2.3], [0.01, 2.6]];
  g.add(Geo.lathe(prof, 8).rotateZ(Math.PI / 8).translate(0, 0, h + 0.35).color(domeHex).mat(MAT.ZINC).gloss(0.5));
  g.add(Geo.lathe([[0.08, 0], [0.12, 0.2], [0.04, 0.5], [0.09, 0.62], [0.01, 1.0]], 6).translate(0, 0, h + 2.9).color('#c8a040').mat(MAT.IRON).gloss(0.7));
  return g;
}

// the clock dial: a disc whose shader draws the face and hands (both
// hands keep the time of day the sky shows, at the moment the dial is seen)
function dial(x, y, z, nx, ny, r) {
  const g = Geo.disc(r, 32).rotateX(Math.PI / 2);         // facing -y
  const ang = Math.atan2(ny, nx) + Math.PI / 2;
  g.rotateZ(ang).translate(x, y, z);
  g.add(Geo.torus(r + 0.04, 0.05, 32, 5).rotateX(Math.PI / 2).rotateZ(ang).translate(x, y, z).color('#b8902c').mat(MAT.IRON).gloss(0.7));
  // the face's own uv: (0.5, 0.5) at the centre, v up, u to the right seen from the front
  return g.mat(MAT.CLOCK);
}

function entrance(b) {
  const solid = new Geo(), deco = new Geo();
  // gate arch over the walkway and the railway, at x = -4
  const X = -4.5;
  for (const y of [-7.4, 7.4]) {
    solid.add(cbox(1.3, 1.3, 6.4, 0.06).translate(X, y, DECK + 3.2).color(IRON_CREAM).mat(MAT.STONE));
    deco.add(Geo.lathe([[0.55, 0], [0.62, 0.3], [0.3, 0.7], [0.1, 1.3], [0.01, 1.5]], 8).translate(X, y, DECK + 6.4).color('#c8a040').mat(MAT.IRON).gloss(0.6));
  }
  // lintel and the pediment that carries the clock and the name
  solid.add(cbox(1.1, 16, 1.0, 0.05).translate(X, 0, DECK + 5.4).color(IRON_CREAM).mat(MAT.STONE));
  const ped = Geo.extrude([[-4.2, 0], [4.2, 0], [3.4, 1.6], [1.4, 2.6], [0, 2.9], [-1.4, 2.6], [-3.4, 1.6]], 0.8).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(X - 0.4, 0, DECK + 5.9);
  solid.add(ped.color(IRON_CREAM).mat(MAT.STONE));
  for (const nx of [1, -1]) {
    deco.add(dial(X + nx * 0.43, 0, DECK + 7.25, nx, 0, 0.95));
    deco.add(cbox(0.06, 9.6, 0.85, 0.02).translate(X + nx * 0.58, 0, DECK + 5.4).color('#1e2a4a').mat(MAT.PAINT));
    deco.add(signGeo('PORTHAVEN PIER', X + nx * 0.62, 0, DECK + 5.4, nx, 0, 0.6, 1));
  }
  // the arch's iron spandrels: a lattice under the lintel
  deco.add(panel(X, -3.7, 1, 0, 6.2, DECK + 4.2, DECK + 4.9).color(IRON_GREEN).mat(MAT.LATTICE).doubleSided().cutout());
  deco.add(panel(X, 3.7, 1, 0, 6.2, DECK + 4.2, DECK + 4.9).color(IRON_GREEN).mat(MAT.LATTICE).doubleSided().cutout());
  // two kiosks: tickets and rock
  const k1 = kioskGeo(2.4, 3.2, '#e8dcc0', '#3c6b62').translate(-9, 9.6, DECK);
  const k2 = kioskGeo(2.4, 3.2, '#e8dcc0', '#3c6b62').translate(-9, -9.9, DECK);
  solid.add(k1); solid.add(k2);
  deco.add(signGeo('TICKETS', -6.55, 9.6, DECK + 2.75, 1, 0, 0.42, 0));
  deco.add(signGeo('ROCK & SWEETS', -6.55, -9.9, DECK + 2.75, 1, 0, 0.42, 0));
  b.static(solid);
  b.static(deco, { solid: false });
}

// a railway station: a canopy over both tracks on iron columns, a platform,
// a name board and a board counting down to the next departure
function station(b, xc, name, side) {
  const solid = new Geo(), deco = new Geo();
  const x0 = xc - 14, x1 = xc + 14, y0 = -NECK.hw + 0.1, y1 = FENCE_Y + 0.05;
  for (let x = x0 + 1; x <= x1 - 1 + 0.01; x += 6.5) {
    for (const y of [y0 + 0.25, y1 - 0.15]) solid.add(Geo.cylinder(0.09, 3.3, 8).translate(x, y, DECK).color(IRON_GREEN).mat(MAT.IRON));
  }
  const roof = new Geo();
  roof.add(cbox(x1 - x0, y1 - y0 + 0.8, 0.12, 0.03).translate((x0 + x1) / 2, (y0 + y1) / 2, DECK + 3.4));
  roof.add(cbox(x1 - x0, 0.06, 0.45, 0.02).translate((x0 + x1) / 2, y0 - 0.35, DECK + 3.2));
  roof.add(cbox(x1 - x0, 0.06, 0.45, 0.02).translate((x0 + x1) / 2, y1 + 0.35, DECK + 3.2));
  deco.add(roof.color('#e6dcc4').mat(MAT.PAINT));
  // valance boards with a scalloped edge (cut out)
  for (const y of [y0 - 0.39, y1 + 0.39]) deco.add(panel((x0 + x1) / 2, y, 0, y < 0 ? -1 : 1, x1 - x0, DECK + 2.75, DECK + 3.0).color('#e6dcc4').mat(MAT.LATTICE).tag(1).doubleSided().cutout());
  // platform between the south track and the railing
  deco.add(boxAt(x0, -NECK.hw + 0.15, DECK, x1, TRACK_Y[1] - 1.0, DECK + 0.35).color('#a89f90').mat(MAT.STONE));
  // name and countdown boards hanging under the canopy, facing along the pier
  for (const nx of [-1, 1]) {
    deco.add(cbox(0.05, 2.6, 0.55, 0.02).translate(xc + nx * 6, (y0 + y1) / 2, DECK + 2.95).color('#1e2a4a').mat(MAT.PAINT));
    deco.add(signGeo(name, xc + nx * 6 + nx * 0.03, (y0 + y1) / 2, DECK + 2.95, nx, 0, 0.36, 1));
    const bd = panel(xc + nx * 2 + nx * 0.03, (y0 + y1) / 2 + 0.6, nx, 0, 1.0, DECK + 2.45, DECK + 2.85, true);
    deco.add(bd.mat(MAT.BOARD).tag(side));
    deco.add(cbox(0.05, 2.4, 0.5, 0.02).translate(xc + nx * 2, (y0 + y1) / 2, DECK + 2.65).color('#111111').mat(MAT.PAINT));
    deco.add(signGeo('NEXT TRAIN', xc + nx * 2 + nx * 0.03, (y0 + y1) / 2 - 0.55, DECK + 2.65, nx, 0, 0.2, 2));
  }
  b.static(solid);
  b.static(deco, { solid: false });
}

// the railway: two tracks of rails on sleepers, with buffer stops at each end
function railway(b) {
  const steel = new Geo(), sleepers = [];
  const xa = STATION_X[1] - 15, xb = STATION_X[0] + 14;
  for (const ty of TRACK_Y) {
    for (const off of [-0.45, 0.45]) {
      for (let x = xa; x < xb - 0.01; x += 30) {
        const c = Math.min(xb, x + 30);
        steel.add(boxAt(x, ty + off - 0.035, DECK, c, ty + off + 0.035, DECK + 0.13));
      }
    }
    for (let x = xa + 0.3; x < xb; x += 0.65) sleepers.push(m4.translation(x, ty, DECK));
    for (const x of [xa, xb]) {
      steel.add(boxAt(x - 0.3, ty - 0.7, DECK, x + 0.3, ty + 0.7, DECK + 0.7));
    }
  }
  b.static(steel.color('#5a5652').mat(MAT.STEEL).gloss(0.5), { solid: false });
  b.instances(Geo.box(0.22, 1.5, 0.07).translate(0, 0, 0.035).color('#3a2c22').mat(MAT.WOOD), sleepers, { solid: false });
  // the fence between the railway and the walkway (open at the stations)
  const fence = new Geo(), posts = [];
  for (const [a, c] of [[STATION_X[1] + 15, STATION_X[0] - 15]]) {
    for (let x = c; x >= a; x -= 2.5) posts.push(m4.translation(x, FENCE_Y, DECK));
    for (let x = a; x < c - 0.01; x += 25) {
      const e = Math.min(c, x + 25);
      for (const h of [0.45, 1.0]) fence.add(cbox(e - x, 0.05, 0.06, 0.015).translate((x + e) / 2, FENCE_Y, DECK + h));
    }
  }
  b.static(fence.color(IRON_GREEN).mat(MAT.IRON));
  const post = cbox(0.07, 0.07, 1.05, 0.015).translate(0, 0, 0.525).color(IRON_GREEN).mat(MAT.IRON);
  b.instances(post, posts);
}

// the pavilion at the end of the pier, with its clock tower
function pavilion(b) {
  const solid = new Geo(), deco = new Geo();
  const { x0, x1, hw } = PAVILION;
  const H = 9.5;
  // walls with windows (uv in metres)
  const walls = [[x1, 0, 1, 0, 2 * hw], [x0, 0, -1, 0, 2 * hw], [(x0 + x1) / 2, hw, 0, 1, x1 - x0], [(x0 + x1) / 2, -hw, 0, -1, x1 - x0]];
  for (const [x, y, nx, ny, w] of walls) solid.add(panel(x, y, nx, ny, w, DECK, DECK + H).color('#efe6d2').mat(MAT.FACADE).tag(2));
  solid.add(boxAt(x0, -hw, DECK + H - 0.1, x1, hw, DECK + H).color('#6d6d68').mat(MAT.ROOF));
  // cornice and parapet
  deco.add(cbox(x1 - x0 + 0.6, 2 * hw + 0.6, 0.35, 0.06).translate((x0 + x1) / 2, 0, DECK + H - 0.1).color(IRON_CREAM).mat(MAT.STONE));
  deco.add(cbox(x1 - x0 + 0.2, 2 * hw + 0.2, 0.9, 0.05).translate((x0 + x1) / 2, 0, DECK + H + 0.45).color('#efe6d2').mat(MAT.STONE));
  // the dome on a drum
  const cx = (x0 + x1) / 2;
  solid.add(Geo.cylinder(7.2, 2.2, 24, { caps: false }).translate(cx, 0, DECK + H).color('#efe6d2').mat(MAT.FACADE).tag(3));
  const dome = Geo.lathe([[7.6, 0], [7.5, 0.6], [7.0, 2.2], [6.0, 3.8], [4.4, 5.2], [2.4, 6.2], [0.9, 6.6], [0.01, 6.7]], 24);
  solid.add(dome.translate(cx, 0, DECK + H + 2.2).color('#5d8a80').mat(MAT.ZINC).gloss(0.5));
  deco.add(kioskGeo(1.1, 1.6, '#efe6d2', '#5d8a80').translate(cx, 0, DECK + H + 8.8));
  // corner turrets
  for (const sx of [x0 + 1.4, x1 - 1.4]) for (const sy of [-hw + 1.4, hw - 1.4]) {
    solid.add(kioskGeo(1.6, 2.4, '#efe6d2', '#5d8a80').translate(sx, sy, DECK + H));
  }
  // a glazed veranda along the front
  const vx0 = x1, vx1 = x1 + 3.2;
  for (let y = -hw + 0.5; y <= hw - 0.5 + 0.01; y += 3.4) solid.add(Geo.cylinder(0.1, 3.4, 8).translate(vx1, y, DECK).color(IRON_GREEN).mat(MAT.IRON));
  deco.add(boxAt(vx0, -hw, DECK + 3.35, vx1 + 0.3, hw, DECK + 3.5).color(IRON_GREEN).mat(MAT.IRON));
  deco.add(panel(vx1 + 0.3, 0, 1, 0, 2 * hw, DECK + 3.0, DECK + 3.5).color('#e6dcc4').mat(MAT.LATTICE).tag(1).doubleSided().cutout());
  deco.add(signGeo('PAVILION THEATRE', x1 + 0.03, 0, DECK + H - 1.3, 1, 0, 0.9, 1));
  deco.add(signGeo('DANCING NIGHTLY', x1 + 0.03, -11.3, DECK + 5.8, 1, 0, 0.45, 2));
  deco.add(signGeo('TEAS & ICES', x1 + 0.03, 11.3, DECK + 5.8, 1, 0, 0.45, 2));
  // the clock tower, in front of the middle of the veranda
  const tx = x1 + 5.5, T = 4.2, th = 19;
  solid.add(cbox(T, T, th, 0.08).translate(tx, 0, DECK + th / 2).color('#e9dfc8').mat(MAT.STONE));
  for (const z of [6, 12.5, th - 0.2]) deco.add(cbox(T + 0.4, T + 0.4, 0.35, 0.06).translate(tx, 0, DECK + z).color(IRON_CREAM).mat(MAT.STONE));
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2, nx = Math.cos(a), ny = Math.sin(a);
    deco.add(dial(tx + nx * (T / 2 + 0.02), ny * (T / 2 + 0.02), DECK + 15.2, nx, ny, 1.75));
  }
  deco.add(kioskGeo(1.9, 2.6, '#e9dfc8', '#5d8a80').translate(tx, 0, DECK + th));
  // its door arch on the deck side
  deco.add(signGeo('1897', tx + T / 2 + 0.02, 0, DECK + 10.5, 1, 0, 0.5, 1));
  b.static(solid);
  b.static(deco, { solid: false });
}

// ---------------------------------------------------------------------------
// people.  One mesh per person, modelled facing +y with the feet at the
// origin: clothes in the vertex colour, the head marked as skin (its face
// and hair are drawn by the shader from the head's uv, so that the front of
// the head differs from the back).  pose: 0 walking, 1 standing, 3 sitting
// (on a seat at z = 0.42), 4 leaning forward on a railing.

const COATS = ['#8e2b2b', '#2b4a8e', '#d8c46a', '#3d7a4a', '#7a3d7a', '#c86a2b', '#e8e2d4', '#2e3640', '#b84a6a', '#4a8e8e', '#6a5a3a', '#d84a3a', '#3a6ac8', '#f0f0f0'];
const TROUSERS = ['#22252c', '#2f3b52', '#4a3b2c', '#5a5a5a', '#c8b48a', '#1a1a1a', '#3a4a6a'];
const SKINS = ['#e8c0a0', '#d8a888', '#b8805c', '#8a5a3c', '#f0d0b8', '#c89070'];
function personGeo(rand, pose = 0, o = {}) {
  const g = new Geo();
  const coat = o.coat || rand.pick(COATS), legs = o.legs || rand.pick(TROUSERS), skin = rand.pick(SKINS);
  const child = o.child || false, k = child ? 0.62 : 0.92 + 0.12 * rand();
  const dress = !child && rand() < 0.28;
  const hip = 0.88 * k, sh = 1.42 * k, head = 1.6 * k;
  const Cl = (geo, hex) => geo.color(hex).mat(MAT.CLOTH);
  const hairAux = rand() * 2 - 1;
  const stride = pose === 0 ? 0.24 * k : 0;
  if (pose === 5) {
    // a rider seen from afar (on the wheel, the swing ride, the swing boat, a boat): 44 triangles
    // (o.hidden: 32, for one whose legs are out of sight in a hull or a tub)
    const zs = 0.42;
    g.add(Cl(Geo.box(0.34 * k, 0.2 * k, 0.5 * k).translate(0, -0.04, zs + 0.27 * k), coat));
    if (!o.hidden) g.add(Cl(Geo.box(0.28 * k, 0.4 * k, 0.13).translate(0, 0.16 * k, zs + 0.06), legs));
    g.add(Geo.sphere(0.115 * k, 5, 3).scale(0.92, 1, 1.12).translate(0, -0.02, zs + 0.64 * k).color(skin).mat(MAT.SKIN).aux(hairAux));
    return g;
  }
  if (pose === 3) {
    // a rider (on a train, a ride): a light figure of 70 triangles, sitting on z = 0.42
    // (o.parts: without the legs, for a rider who pedals)
    const zs = 0.42;
    const torso = Cl(Geo.box(0.34 * k, 0.2 * k, 0.5 * k).translate(0, -0.04, zs + 0.27 * k), coat);
    const face = Geo.sphere(0.115 * k, 6, 4).scale(0.92, 1, 1.12).translate(0, -0.02, zs + 0.64 * k).color(skin).mat(MAT.SKIN).aux(hairAux);
    if (o.parts) return { sp: { k, legs }, body: Geo.merge(torso, face) };
    g.add(torso);
    g.add(Cl(Geo.box(0.3 * k, 0.42 * k, 0.13).translate(0, 0.17 * k, zs + 0.06), legs));
    g.add(Cl(Geo.box(0.26 * k, 0.11, zs).translate(0, 0.38 * k, zs / 2), legs));
    g.add(face);
    return g;
  }
  if (pose === 2) {
    // sitting: thighs forward, shins down
    const zs = 0.42;
    for (const s of [-1, 1]) {
      g.add(Cl(Geo.tube([[s * 0.1 * k, -0.05, zs], [s * 0.11 * k, 0.42 * k, zs]], 0.075 * k, 5, { caps: false }), legs));
      g.add(Cl(Geo.tube([[s * 0.11 * k, 0.42 * k, zs], [s * 0.11 * k, 0.45 * k, 0.06]], 0.06 * k, 5, { caps: false }), legs));
      g.add(Cl(cbox(0.1 * k, 0.24 * k, 0.08, 0.02).translate(s * 0.11 * k, 0.5 * k, 0.04), '#1e1a18'));
    }
    const dz = zs - hip + 0.1;
    g.add(Cl(Geo.lathe([[0.03, hip - 0.1], [0.19 * k, hip - 0.08], [0.2 * k, hip + 0.3 * k], [0.21 * k, sh - 0.05], [0.12 * k, sh + 0.04], [0.05, sh + 0.08]], 7).scale(1, 0.7, 1).translate(0, -0.05, dz), coat));
    for (const s of [-1, 1]) g.add(Cl(Geo.tube([[s * 0.22 * k, -0.05, sh - 0.06 + dz], [s * 0.25 * k, 0.05, hip + 0.1 + dz], [s * 0.18 * k, 0.25 * k, hip + 0.02 + dz]], 0.05 * k, 4, { caps: false }), coat));
    g.add(Geo.sphere(0.105 * k + 0.015, 10, 7).scale(0.92, 1, 1.12).translate(0, -0.03, head + dz + 0.04).color(skin).mat(MAT.SKIN).aux(hairAux));
    return g;
  }
  // Standing, leaning and walking: legs (or a skirt) and shoes, the body, the
  // arms, the head.  The random choices are all made first (in the order in
  // which they have always been made), so that a walker can be had in two
  // parts: what swings as it walks, and the rest (o.parts, see personLegs).
  const shoes = [-1, 1].map(() => rand.pick(['#1e1a18', '#4a2a1a', '#e8e8e8', '#7a1a1a']));
  const hat = rand() < 0.22 ? rand.pick(['#e8dcb4', '#2a2a2a', '#c8402a', '#f0f0f0']) : null;
  const sp = { pose, coat, legs, skin, child, k, dress, hip, sh, head, hairAux, shoes, hat, stride };
  if (o.parts) return { sp, body: Geo.merge(personTorso(sp), personHead(sp)) };
  g.add(personLegs(sp, null));
  // (leaning on a railing: bent forward from the hips, the forearms on the rail)
  const lean = pose === 4 ? m4.mul(m4.translation(0, 0, hip), m4.rotationX(-LEAN), m4.translation(0, 0, -hip)) : null;
  g.add(lean ? personTorso(sp).transform(lean) : personTorso(sp));
  g.add(personArms(sp, null, { lean }));
  g.add(lean ? personHead(sp).transform(lean) : personHead(sp));
  return g;
}
// how far forward someone leaning on a railing bends (radians), and where
// the railing's top is in front of their feet
const LEAN = 0.3, LEAN_RAIL = [0.5, 1.15];
// body: a coat or a dress, wider at the hem
function personTorso({ k, hip, sh, coat, dress }) {
  if (dress) return Geo.lathe([[0.02, hip * 0.5], [0.3 * k, hip * 0.52], [0.2 * k, hip + 0.1], [0.19 * k, sh - 0.05], [0.12 * k, sh + 0.04], [0.05, sh + 0.08]], 8).scale(1, 0.72, 1).color(coat).mat(MAT.CLOTH);
  return Geo.lathe([[0.02, hip - 0.12], [0.2 * k, hip - 0.1], [0.19 * k, hip + 0.2], [0.21 * k, sh - 0.05], [0.12 * k, sh + 0.04], [0.05, sh + 0.08]], 8).scale(1, 0.72, 1).color(coat).mat(MAT.CLOTH);
}
// neck and head; the head's aux picks the hair (the shader draws face and hair)
function personHead({ k, sh, head, skin, hairAux, hat }) {
  const g = new Geo();
  g.add(Geo.cylinder(0.05 * k, 0.1, 4, { caps: false }).translate(0, 0, sh + 0.02).color(skin).mat(MAT.SKIN).aux(-1).tag(1));
  g.add(Geo.sphere(0.105 * k + 0.015, 8, 6).scale(0.92, 1, 1.12).translate(0, 0, head + 0.04).color(skin).mat(MAT.SKIN).aux(hairAux));
  if (hat) g.add(Geo.lathe([[0.2 * k, 0], [0.19 * k, 0.03], [0.11 * k, 0.04], [0.1 * k, 0.14], [0.01, 0.15]], 7).translate(0, 0, head + 0.1).color(hat).mat(MAT.CLOTH));
  return g;
}
// A tube along a limb that swings in the y-z plane, as Geo.tube makes one but
// with its sides always laid out from the x axis, so that every pose of a
// stride has them the same way round (the poses are blended vertex by
// vertex).  r: a radius, or a function of the share of the way along; end: a
// cap on the far end.  (A limb is given as two pieces, at the knee or the
// elbow, even where it is straight: a long piece that swings would bend
// between two poses.)  footUp: the rings are listed from the far end back,
// so that what a step from pose to pose folds of a leg (the triangles are
// cut into tetrahedra by the order of their corners) bends it at the knee the
// way a knee bends.
function limbTube(path, r, seg, end = false, footUp = false) {
  const g = new Geo();
  const np = path.length;
  const rad = (q) => (typeof r === 'function' ? r(q / (np - 1)) : r);
  const ring = (q) => (footUp ? np - 1 - q : q) * (seg + 1);   // where ring q starts
  const rings = [];
  let t;
  for (let q = 0; q < np; q++) {
    t = v3.norm(v3.sub(path[Math.min(np - 1, q + 1)], path[Math.max(0, q - 1)]));
    const nrm = v3.norm(v3.sub([1, 0, 0], v3.scale(t, t[0]))), bin = v3.cross(t, nrm);
    rings.push([]);
    for (let i = 0; i <= seg; i++) {
      const ph = TAU * i / seg, d = v3.add(v3.scale(nrm, Math.cos(ph)), v3.scale(bin, Math.sin(ph)));
      rings[q].push([path[q][0] + d[0] * rad(q), path[q][1] + d[1] * rad(q), path[q][2] + d[2] * rad(q), d[0], d[1], d[2], i / seg, q / (np - 1)]);
    }
  }
  for (let j = 0; j < np; j++) for (const v of rings[footUp ? np - 1 - j : j]) g.vert(...v);
  for (let q = 0; q < np - 1; q++) for (let i = 0; i < seg; i++) { const a = ring(q) + i, c = ring(q + 1) + i; g.quadIdx(a, a + 1, c + 1, c); }
  if (end) {
    const c = path[np - 1], c0 = g.vert(c[0], c[1], c[2], t[0], t[1], t[2], 0.5, 0.5), base = g.vertexCount;
    for (let i = 0; i <= seg; i++) { const o = (ring(np - 1) + i) * 3; g.vert(g.p[o], g.p[o + 1], g.p[o + 2], t[0], t[1], t[2], 0.5, 0.5); }
    for (let i = 0; i < seg; i++) g.tri(c0, base + i, base + i + 1);
  }
  return g;
}
// A walker's stride.  u is the share done of a round of two steps, or null
// for a figure that stands still (pose 0: caught in mid-stride).  Over a
// round the left foot is put down in front (u = 0) and stays where it was put
// while the body passes over it, at the walker's own speed, rising onto its
// toe as it gets behind (u = 0.5); then it is lifted and swung forward, the
// knee bent, past the other one (u = 0.75), and put down in front again.  The
// right foot does the same half a round later, and the arms swing the other
// way.  So a round of four poses covers it.  reach: how far each foot gets in
// front of the hips and behind them (half a step), so that a round of two
// steps takes 4 reach / speed; lift: how high the passing foot is carried.
function footAt(sp, s, u, reach, lift) {
  if (u === null) return { fy: (sp.pose === 0 ? s : 0) * sp.stride, up: 0, heel: 0 };
  const w = (((u + (s < 0 ? 0 : 0.5)) % 1) + 1) % 1;
  if (w < 0.5 - 1e-9) return { fy: reach * (1 - 4 * w), up: 0, heel: 0 };
  if (w < 0.5 + 1e-9) return { fy: -reach, up: 0, heel: 0.38 };
  return { fy: reach * (4 * w - 3), up: lift * (1 - Math.abs(4 * w - 3)), heel: 0 };
}
function personLegs(sp, u, { reach = 0, lift = 0 } = {}) {
  const { k, hip, dress, legs, skin, shoes } = sp;
  const g = new Geo();
  [-1, 1].forEach((s, i) => {
    const { fy, up, heel } = footAt(sp, s, u, reach, lift);
    if (u === null) {
      if (!dress) g.add(Geo.tube([[s * 0.1 * k, 0, hip], [s * 0.1 * k, fy * 0.5, hip * 0.5], [s * 0.1 * k, fy, 0.08]], (q) => (0.085 - 0.03 * q) * k, 4, { caps: false }).color(legs).mat(MAT.CLOTH));
      else g.add(Geo.tube([[s * 0.09 * k, fy * 0.3, hip * 0.55], [s * 0.1 * k, fy, 0.08]], 0.045 * k, 4, { caps: false }).color(skin).mat(MAT.CLOTH));
      g.add(Geo.box(0.1 * k, 0.25 * k, 0.09).translate(s * 0.1 * k, fy + 0.05, 0.045).color(shoes[i]).mat(MAT.CLOTH));
      return;
    }
    // the shoe, lifted by `up` and turned up about its toe by `heel`
    // radians, and the ankle with it; the knee forward as the foot is lifted
    const toe = fy + 0.05 + 0.125 * k, c = Math.cos(heel), sn = Math.sin(heel);
    const ankle = [s * 0.1 * k, toe + (-0.05 - 0.125 * k) * c + 0.08 * sn, up + (0.05 + 0.125 * k) * sn + 0.08 * c];
    if (!dress) g.add(limbTube([[s * 0.1 * k, 0, hip], [s * 0.1 * k, ankle[1] * 0.5 + up * 1.3, (hip + ankle[2]) * 0.5 + up * 0.3], ankle], (q) => (0.085 - 0.03 * q) * k, 4, false, true).color(legs).mat(MAT.CLOTH));
    else g.add(limbTube([[s * 0.09 * k, ankle[1] * 0.3, hip * 0.55], [s * 0.095 * k, ankle[1] * 0.65 + up * 0.5, (hip * 0.55 + ankle[2]) * 0.5], ankle], 0.045 * k, 4, false, true).color(skin).mat(MAT.CLOTH));
    g.add(Geo.box(0.1 * k, 0.25 * k, 0.09).translate(0, -0.125 * k, 0.045).rotateX(-heel).translate(s * 0.1 * k, toe, up).color(shoes[i]).mat(MAT.CLOTH));
  });
  return g;
}
// The arms swing with the legs, each forward as the foot on its own side goes
// back (swing: how far, 0.6 being the stride of a still figure).  hold: for
// an arm that does not swing, because its hand holds something, its elbow
// and hand ({ left, right }: [elbow, hand], in the figure's own frame).
// lean: for someone leaning on a railing, the matrix that bends them forward.
function personArms(sp, u, { reach = 0, swing = 0, hold = {}, lean = null } = {}) {
  const { pose, k, hip, sh, coat, skin } = sp;
  const g = new Geo();
  for (const s of [-1, 1]) {
    const held = s > 0 ? hold.right : hold.left;
    let path;
    if (pose === 4) {
      // from the bent-forward shoulder down to the elbow on the rail, the forearm along its top
      const [ry, rz] = LEAN_RAIL, shoulder = m4.point(lean, [s * 0.22 * k, 0, sh - 0.06]);
      path = [shoulder, [s * 0.25 * k, ry - 0.06, rz + 0.04], [s * 0.1 * k, ry + 0.06, rz + 0.05]];
    }
    else if (held) path = [[s * 0.22 * k, 0, sh - 0.06], ...held];
    else {
      const f = u === null ? (pose === 0 ? -s * 0.6 : 0) : reach > 0 ? -swing * footAt(sp, s, u, reach, 0).fy / reach : 0;
      // (a swinging hand goes round an arc, a little up at either end)
      const arc = u === null ? 0 : Math.abs(f);
      path = [[s * 0.22 * k, 0, sh - 0.06], [s * 0.25 * k, f * 0.12, hip + 0.18 + arc * 0.02], [s * 0.24 * k, f * 0.22, hip - 0.05 + arc * 0.05]];
    }
    const tip = [path[2][0], path[2][1] + 0.02, path[2][2] - 0.09];
    if (u === null) {
      g.add(Geo.tube(path, (q) => (0.055 - 0.012 * q) * k, 4, { caps: false }).color(coat).mat(MAT.CLOTH));
      g.add(Geo.tube([path[2], tip], 0.04 * k, 4).color(skin).mat(MAT.SKIN).aux(-1).tag(1));
    } else {
      g.add(limbTube(path, (q) => (0.055 - 0.012 * q) * k, 4).color(coat).mat(MAT.CLOTH));
      g.add(limbTube([path[2], tip], 0.04 * k, 4, true).color(skin).mat(MAT.SKIN).aux(-1).tag(1));
    }
  }
  return g;
}
// The stride of a walker of size k at speed v (m/s): how far each foot gets
// in front and behind, how high it is lifted, how far the arms swing, and
// how long a round of two steps takes (so that the planted foot does not
// slide).
function strideFor(sp, v) {
  const run = v > 2.4;
  const step = sp.k * (run ? 0.55 + 0.3 * v : 0.5 + 0.2 * v);
  const reach = step / 2;
  return { reach, lift: (run ? 0.18 : 0.1) * sp.k, swing: Math.min(1.1, 0.6 * reach / (0.24 * sp.k)) * (run ? 1.2 : 1), period: 2 * step / v };
}
// The parts of a walker that swing, as meshes for the four poses of its
// stride: the shins and the thighs, the forearms and the upper arms (no arms,
// if both hands hold something).  They are four meshes because a slice tilted
// up close to 90 degrees touches a thing for as long as its height takes to
// cross it (see inPieces): a part a quarter of the height of the whole is
// touched for a quarter as many poses.
function walkerLimbs(sp, gait, hold) {
  const out = cutPoses((u) => personLegs(sp, u, gait), (m) => m[2] < sp.hip / 2);
  if (!(hold.left && hold.right)) out.push(...cutPoses((u) => personArms(sp, u, { ...gait, hold }), (m) => m[2] < sp.hip + 0.17));
  return out;
}

// ---------------------------------------------------------------------------
// the pier railway: two trains shuttling on their own tracks, half a cycle
// apart, so that one leaves each station whenever the other does.
// Timing (each train, cycle 90 s): train A leaves the shore station at 4 s
// past (B 45 s later), speeds up at 0.75 m/s2 to 9 m/s (1.8 C), slows down
// into the pier-head station 33.4 s after leaving, waits there 11.6 s, and
// comes back the same way.  So both stations send a train off at 4 s past
// every 45 s, and the two trains cross half way out at about 21 s past.

const TRAIN_V = 9, TRAIN_A = 0.75, TRAIN_CYC = 90;
const TRAIN_D = STATION_X[0] - STATION_X[1];
const TRAIN_TA = TRAIN_V / TRAIN_A, TRAIN_DA = 0.5 * TRAIN_A * TRAIN_TA * TRAIN_TA;
const TRAIN_TRIP = 2 * TRAIN_TA + (TRAIN_D - 2 * TRAIN_DA) / TRAIN_V;
function tripDist(u) {
  if (u <= 0) return 0;
  if (u >= TRAIN_TRIP) return TRAIN_D;
  if (u < TRAIN_TA) return 0.5 * TRAIN_A * u * u;
  if (u > TRAIN_TRIP - TRAIN_TA) { const r = TRAIN_TRIP - u; return TRAIN_D - 0.5 * TRAIN_A * r * r; }
  return TRAIN_DA + (u - TRAIN_TA) * TRAIN_V;
}
function trainX(t, offset) {
  const u = (((t - 4 - offset) % TRAIN_CYC) + TRAIN_CYC) % TRAIN_CYC;
  if (u < TRAIN_CYC / 2) return STATION_X[0] - tripDist(u);
  return STATION_X[1] + tripDist(u - TRAIN_CYC / 2);
}
// key times: the ends of every phase, and enough in between while it speeds up or slows down
function trainKeys(offset) {
  const ks = new Set([0, P]);
  for (let c = -1; c <= P / TRAIN_CYC + 1; c++) {
    for (const base of [0, TRAIN_CYC / 2]) {
      const t0 = 4 + offset + c * TRAIN_CYC + base;
      for (let i = 0; i <= 6; i++) {
        ks.add(t0 + TRAIN_TA * i / 6);
        ks.add(t0 + TRAIN_TRIP - TRAIN_TA * i / 6);
      }
      // and a key every second while it cruises, so that each piece of its run is short
      for (let tt = t0 + TRAIN_TA + 1; tt < t0 + TRAIN_TRIP - TRAIN_TA - 0.5; tt += 1) ks.add(tt);
    }
  }
  return [...ks].filter((t) => t >= 0 && t <= P).sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.05);
}

function trainCar(rand, motor, front) {
  const g = new Geo();
  const L = 6.2, W = 1.75;
  const blue = '#1f3f6e', cream = '#efe4c8';
  // underframe and wheels
  g.add(boxAt(-W / 2 + 0.15, -L / 2 + 0.3, 0.18, W / 2 - 0.15, L / 2 - 0.3, 0.42).color('#1a1a1a').mat(MAT.STEEL));
  for (const y of [-L / 2 + 1.1, L / 2 - 1.1]) for (const x of [-0.45, 0.45]) g.add(Geo.cylinder(0.24, 0.08, 6, { caps: false }).rotateY(Math.PI / 2).translate(x - 0.04, y, 0.24).color('#2a2a2a').mat(MAT.WHEEL));
  // body: lower panels, waist rail, open sides with pillars, roof
  g.add(Geo.box(W, L, 0.75).translate(0, 0, 0.8).color(blue).mat(MAT.PAINT));
  g.add(Geo.box(W + 0.04, L + 0.02, 0.1).translate(0, 0, 1.2).color(cream).mat(MAT.PAINT));
  for (const y of [-L / 2 + 0.1, 0, L / 2 - 0.1]) for (const x of [-W / 2 + 0.05, W / 2 - 0.05]) g.add(Geo.box(0.07, 0.07, 1.15).translate(x, y, 1.8).color(cream).mat(MAT.PAINT));
  g.add(Geo.box(W + 0.2, L + 0.2, 0.12).translate(0, 0, 2.42).color(cream).mat(MAT.PAINT));
  g.add(Geo.box(W - 0.2, L - 0.4, 0.12).translate(0, 0, 2.53).color('#b8b0a0').mat(MAT.PAINT));
  // a row of bulbs along each edge of the roof
  for (const s of [-1, 1]) g.add(Geo.box(0.06, L, 0.07).translate(s * (W / 2 + 0.07), 0, 2.4).color('#f0e8d0').mat(MAT.RIMLIGHT).tag(2));
  if (motor) {
    // a closed cab at the outer end with windows and a lamp
    const s = front ? 1 : -1;
    g.add(Geo.box(W, 1.4, 1.2).translate(0, s * (L / 2 - 0.7), 1.82).color(blue).mat(MAT.PAINT));
    g.add(panel(0, s * (L / 2 + 0.01), 0, s, W - 0.4, 1.55, 2.25, true).mat(MAT.GLASS));
    g.add(Geo.sphere(0.12, 6, 4).translate(0, s * (L / 2 + 0.02), 0.95).color('#fff6d0').mat(MAT.LAMP).tag(2));
    g.add(signGeo('PIER RAILWAY', W / 2 + 0.01, 0, 0.82, 1, 0, 0.22, 1));
    g.add(signGeo('PIER RAILWAY', -W / 2 - 0.01, 0, 0.82, -1, 0, 0.22, 1));
  } else {
    // bench seats facing outwards, and passengers
    for (const x of [-0.42, 0.42]) g.add(Geo.box(0.5, L - 0.6, 0.08).translate(x, 0, 0.95).color('#6b4a2e').mat(MAT.WOOD));
    g.add(Geo.box(0.1, L - 0.6, 0.6).translate(0, 0, 1.25).color('#6b4a2e').mat(MAT.WOOD));
    for (let i = 0; i < 6; i++) {
      if (rand() < 0.3) continue;
      const side = i % 2 ? 1 : -1, y = -L / 2 + 0.9 + Math.floor(i / 2) * 2.1 + rand() * 0.3;
      g.add(personGeo(rand, 3).transform(m4.mul(m4.translation(side * 0.42, y, 0.57), m4.rotationZ(side > 0 ? -Math.PI / 2 : Math.PI / 2))));
    }
  }
  return g;
}

function trains(b) {
  const rand = rng(404);
  TRACK_Y.forEach((ty, k) => {
    const offset = k * TRAIN_CYC / 2;
    const cars = 4, L = 6.2, gap = 0.45, keys = trainKeys(offset);
    // each car is a moving object of its own (so that a slice that meets one
    // car does not have to take in the whole train); the train runs along x,
    // its +y (the front car) pointing west
    for (let i = 0; i < cars; i++) {
      const y = (i - (cars - 1) / 2) * (L + gap);
      const car = trainCar(rand, i === 0 || i === cars - 1, i === cars - 1);
      const tf = (t) => m4.mul(m4.translation(trainX(t, offset) - y, ty, DECK + 0.13), m4.rotationZ(Math.PI / 2));
      b.dynamic(car, { times: keys, transform: tf, caps: 'none' });
      b.dynamic(trainDetail(i === 0 || i === cars - 1, i === cars - 1, k * 4 + i + 1, rand), { times: keys, transform: tf, caps: 'none', within: 25 });
    }
  });
}

// ---------------------------------------------------------------------------
// the big wheel: two rims with spokes turning once a minute, sixteen gondolas
// hanging level from bars between the rims

function wheelFrame() {
  const W = WHEEL;
  const M = m4.mul(m4.translation(W.x, W.y, DECK + W.hub), m4.rotationZ(W.yaw));
  const g = new Geo();
  const st = (geo) => geo.color('#d8d8d0').mat(MAT.STEEL);
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const foot = [sx * 7.8, sy * 4.2, -W.hub], top = [sx * 0.4, sy * 2.7, 0];
      g.add(st(rod(foot, top, 0.28, 8)));
      if (sx > 0) {
        for (let k = 1; k < 6; k++) {
          const u = k / 6, a = v3.lerp(foot, top, u);
          g.add(st(rod(a, [-a[0], a[1], a[2]], 0.08, 5)));
        }
      }
    }
    g.add(st(rod([-7.8, sy * 4.2, -W.hub + 2], [7.8, sy * 4.2, -W.hub + 2], 0.12, 5)));
  }
  g.add(st(rod([0, -3.1, 0], [0, 3.1, 0], 0.55, 12)));
  // boarding platform with steps
  g.add(cbox(7, 5.6, 0.25, 0.04).translate(0, 0, -W.hub + 1.45).color('#6b4a2e').mat(MAT.WOOD));
  for (let i = 0; i < 5; i++) g.add(cbox(0.32, 1.8, 0.27 * (i + 1), 0.03).translate(4.9 - i * 0.32 + 0.32 * 4, 0, -W.hub + 0.135 * (i + 1)).color('#6b4a2e').mat(MAT.WOOD));
  return { geo: g.transform(M), M };
}
function wheelRotor() {
  const W = WHEEL;
  const g = new Geo();
  for (const sy of [-1.9, 1.9]) {
    g.add(Geo.torus(W.r, 0.17, 32, 3).rotateX(Math.PI / 2).translate(0, sy, 0).color('#f2efe6').mat(MAT.RIMLIGHT));
    g.add(Geo.torus(6.2, 0.12, 16, 3).rotateX(Math.PI / 2).translate(0, sy, 0).color('#e0ddd2').mat(MAT.STEEL));
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * TAU;
      g.add(rodIn([0.8 * Math.sin(a), sy * 0.8, 0.8 * Math.cos(a)], [W.r * Math.sin(a), sy, W.r * Math.cos(a)], 0.07, 3, 3).color('#e0ddd2').mat(MAT.RIMLIGHT).tag(1));
    }
  }
  for (let k = 0; k < 16; k++) {
    const a = k / 16 * TAU;
    g.add(rod([W.r * Math.sin(a), -2.0, W.r * Math.cos(a)], [W.r * Math.sin(a), 2.0, W.r * Math.cos(a)], 0.07, 3).color('#c8c8c0').mat(MAT.STEEL));
  }
  g.add(Geo.cylinder(1.1, 4.4, 12).rotateX(Math.PI / 2).translate(0, 2.2, 0).color('#c83a2a').mat(MAT.PAINT));
  return g;
}
function gondola(rand, color) {
  const g = new Geo();
  g.add(rod([0, -0.7, 0], [0, -0.7, -0.9], 0.035, 3).color('#888888').mat(MAT.STEEL));
  g.add(rod([0, 0.7, 0], [0, 0.7, -0.9], 0.035, 3).color('#888888').mat(MAT.STEEL));
  g.add(Geo.cone(1.05, 0.45, 8).translate(0, 0, -0.95).color(color).mat(MAT.PAINT));
  g.add(Geo.lathe([[0.75, -2.65], [0.98, -2.5], [1.0, -1.92]], 8).color(color).mat(MAT.PAINT));
  g.add(Geo.disc(0.75, 8).flip().translate(0, 0, -2.65).color('#3a3a3a').mat(MAT.PAINT));
  for (const s of [-1, 1]) g.add(rod([s * 0.85, 0, -1.95], [s * 0.85, 0, -0.98], 0.03, 3).color('#d0d0c8').mat(MAT.STEEL));
  for (let i = 0; i < 2; i++) {
    if (i === 1 || rand() < 0.2) continue;
    g.add(personGeo(rand, 5, { hidden: true }).transform(m4.mul(m4.translation(i ? 0.35 : -0.35, 0, -2.62), m4.rotationZ(i ? Math.PI / 2 : -Math.PI / 2))));
  }
  return g;
}
function bigWheel(b) {
  const W = WHEEL;
  const { geo, M } = wheelFrame();
  b.static(geo);
  b.static(signGeo('BIG WHEEL', 0, 3.3, -W.hub + 4.0, 0, 1, 1.1, 2).transform(M), { solid: false });
  // it turns clockwise seen from its front (the side facing the pier's entrance)
  const ang = (t) => -TAU * t / W.turn;
  const keys = timeRange(0, P, W.turn / 16);
  // (in pieces: see inPieces)
  for (const piece of inPieces(wheelRotor(), 6)) b.dynamic(piece, { times: keys, transform: (t) => m4.mul(M, m4.rotationY(ang(t))), caps: 'none' });
  const rand = rng(77);
  const cols = ['#c83a2a', '#2a6ac8', '#e8c040', '#3a9a5a'];
  for (let k = 0; k < 16; k++) {
    const g = gondola(rand, cols[k % 4]);
    const a0 = k / 16 * TAU;
    const tf = (t) => {
      const a = a0 + ang(t);
      return m4.mul(M, m4.translation(W.r * Math.sin(a), 0, W.r * Math.cos(a)));
    };
    b.dynamic(g, { times: keys, transform: tf, caps: 'none', within: 700 });
    // from near by: the bench seats inside, the door with its latch, the number
    const d = new Geo();
    for (const s of [-1, 1]) d.add(Geo.box(0.32, 1.3, 0.06).translate(s * 0.55, 0, -2.25).color('#6b4a2e').mat(MAT.WOOD));
    d.add(Geo.box(0.04, 0.7, 0.5).translate(0, 0.99, -2.18).color('#e8e2d4').mat(MAT.PAINT));
    d.add(Geo.box(0.05, 0.05, 0.12).translate(0.12, 1.02, -2.05).color('#c8a040').mat(MAT.IRON).gloss(0.7));
    d.add(signGeo(String(k + 1), 0, -1.01, -2.2, 0, -1, 0.16, 1));
    b.dynamic(d, { times: keys, transform: tf, caps: 'none', within: 60 });
  }
  // the attendant on the boarding platform, and a railed lane from the ticket booth to the steps
  const MZ = M;
  b.static(personGeo(rand, 1, { coat: '#2a4a8a' }).transform(m4.mul(MZ, m4.translation(2.4, -1.6, -W.hub + 1.58), m4.rotationZ(Math.PI))), { within: 80, solid: false });
  const st = m4.point(M, [6.4, 0, -W.hub]), bo = [-251.3, -10.3];
  const dx = st[0] - bo[0], dy = st[1] - bo[1], L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
  railings(b, [-0.7, 0.7].map((o) => [bo[0] + nx * o, bo[1] + ny * o, st[0] + nx * o, st[1] + ny * o]), { edge: false });
}

// ---------------------------------------------------------------------------
// the swing ride: twelve chairs on chains from a turning crown.  It runs in
// cycles of 90 s: still for 20 s while people get on, 8 s speeding up, 54 s
// at full speed (a turn every 6.2 s), 8 s slowing down.  The chairs fly out
// as far as their speed takes them (about 40 degrees).

const SW_CYC = 90, SW_ARM = 5.2, SW_CHAIN = 5.6, SW_TOP = 12.2;
const SW_PHASES = [20, 8, 54, 8];
const SW_TURNS = 10;          // whole turns per cycle (so that every cycle ends where it began)
const swProfile = (u) => {
  // speed as a fraction of full speed, at u seconds into the cycle
  const [a, b2, c, d] = SW_PHASES;
  if (u < a) return 0;
  if (u < a + b2) return sstep(0, 1, (u - a) / b2);
  if (u < a + b2 + c) return 1;
  if (u < SW_CYC) return 1 - sstep(0, 1, (u - a - b2 - c) / d);
  return 0;
};
const SW_INT = (() => { let s = 0; const n = 9000; for (let i = 0; i < n; i++) s += swProfile((i + 0.5) / n * SW_CYC) * SW_CYC / n; return s; })();
const SW_W = SW_TURNS * TAU / SW_INT;    // full speed, radians per second
const SW_OFF = 40;            // the cycle is shifted so that at t = 0 the ride is at full speed
function swAngle(t0) {
  const t = t0 + SW_OFF;
  const c = Math.floor(t / SW_CYC), u = t - c * SW_CYC;
  let s = 0;
  const n = Math.max(1, Math.ceil(u / 0.05));
  for (let i = 0; i < n; i++) s += swProfile((i + 0.5) / n * u) * u / n;
  return c * SW_TURNS * TAU + s * SW_W;
}
function swOut(t) {
  const u = (((t + SW_OFF) % SW_CYC) + SW_CYC) % SW_CYC, w = swProfile(u) * SW_W;
  let a = 0;
  for (let i = 0; i < 10; i++) a = Math.atan(w * w * (SW_ARM + SW_CHAIN * Math.sin(a)) / 9.81);
  return a;
}
function swingKeys() {
  const ks = new Set([0, P]);
  for (let c = -1; c <= P / SW_CYC + 1; c++) {
    const t0 = c * SW_CYC - SW_OFF;
    ks.add(t0 + SW_PHASES[0]);
    for (let tt = t0 + SW_PHASES[0]; tt < t0 + SW_CYC - 1e-6;) {
      const w = Math.max(0.05, swProfile(tt - t0)) * SW_W;
      tt = Math.min(t0 + SW_CYC, tt + Math.min(0.8, TAU / 12 / w));
      ks.add(tt);
    }
  }
  return [...ks].filter((t) => t >= 0 && t <= P).sort((a, b2) => a - b2);
}
function swingRide(b) {
  const { x, y } = SWING;
  const solid = new Geo(), deco = new Geo();
  solid.add(Geo.cylinder(3.6, 0.7, 16).translate(x, y, DECK).color('#c8402a').mat(MAT.PAINT));
  deco.add(Geo.cylinder(3.65, 0.35, 16, { caps: false }).translate(x, y, DECK + 0.2).color('#e8c040').mat(MAT.MARQUEE));
  solid.add(Geo.cylinder(0.75, SW_TOP, 12, { r2: 0.55 }).translate(x, y, DECK + 0.7).color('#e8dcc0').mat(MAT.PAINT));
  for (let k = 0; k < 4; k++) deco.add(Geo.torus(0.78 - k * 0.05, 0.08, 12, 4).translate(x, y, DECK + 2.5 + k * 2.6).color('#c8a040').mat(MAT.IRON).gloss(0.7));
  deco.add(signGeo('CHAIR-O-PLANES', x, y - 3.66, DECK + 0.95, 0, -1, 0.3, 2));
  b.static(solid);
  b.static(deco, { solid: false });
  // a fence ring, open towards the middle of the pier head
  const runs = [];
  const R = 11.5, n = 20;
  for (let i = 0; i < n; i++) {
    const a0 = i / n * TAU, a1 = (i + 1) / n * TAU, am = (a0 + a1) / 2;
    if (Math.sin(am) < -0.93) continue;
    runs.push([x + R * Math.cos(a0), y + R * Math.sin(a0), x + R * Math.cos(a1), y + R * Math.sin(a1)]);
  }
  railings(b, runs, { edge: false });
  b.static(personGeo(rng(5), 1, { coat: '#c8402a' }).transform(m4.mul(m4.translation(x - 1.4, y - 12.0, DECK), m4.rotationZ(Math.PI * 0.85))), { within: 80, solid: false });
  // the queue: while the ride runs, people join it every 5 s from the gate
  // eastwards (person k at 70 + 5k s past, every 90 s); when it stops to
  // load (50 s past) they board, the front of the queue first.  Static
  // people with time windows of their own: seen tilted, the queue is long
  // in one part of the view and short in another.
  {
    const rand = rng(1717);
    for (let k = 0; k < 13; k++) {
      const p = personGeo(rand, 1, { child: rand() < 0.3 });
      const M = m4.mul(m4.translation(x + 0.75 * k + 0.6, y - 12.3 + (rand() - 0.5) * 0.25, DECK), m4.rotationZ(Math.PI / 2 + (rand() - 0.5) * 0.4));
      b.static(p, { transform: M, from: 70 + 5 * k - SW_CYC, to: 140 + 1.4 * k - SW_CYC, period: SW_CYC, solid: false });
    }
  }
  // the turning crown
  const crown = new Geo();
  crown.add(Geo.cone(6.6, 2.2, 16).translate(0, 0, SW_TOP + 1.0).color('#e8dcc0').mat(MAT.CANVAS));
  crown.add(Geo.cylinder(6.6, 0.9, 16, { caps: false }).translate(0, 0, SW_TOP + 0.1).color('#c8402a').mat(MAT.MARQUEE));
  crown.add(Geo.disc(6.6, 16).flip().translate(0, 0, SW_TOP + 0.1).color('#3a2a22').mat(MAT.PAINT));
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * TAU;
    crown.add(rod([0.6 * Math.cos(a), 0.6 * Math.sin(a), SW_TOP + 0.6], [SW_ARM * Math.cos(a), SW_ARM * Math.sin(a), SW_TOP], 0.06, 3).color('#d8d8d0').mat(MAT.STEEL));
  }
  const tfC = (t) => m4.mul(m4.translation(x, y, DECK), m4.rotationZ(swAngle(t)));
  const keys = swingKeys();
  b.dynamic(crown, { times: keys, transform: tfC, caps: 'none' });
  // the chairs: each hangs from the end of its arm, turned out about the
  // arm's end by the swing-out angle (a stiff part with a motion of its own).
  // Its two chains, 5.6 m long, are a mesh of their own (see inPieces), and
  // cast no shadow: 3 cm across, they are thinner than a pixel of the maps.
  const rand = rng(91);
  for (let k = 0; k < 12; k++) {
    const g = new Geo();
    const chains = Geo.quad([0, -0.22, 0], [0, 0.22, 0], [0, 0.22, -SW_CHAIN], [0, -0.22, -SW_CHAIN]).color('#bbbbbb').mat(MAT.LATTICE).tag(2).doubleSided().cutout().noShadow();
    g.add(Geo.box(0.5, 0.5, 0.06).translate(0, 0, -SW_CHAIN).color('#c8402a').mat(MAT.PAINT));
    g.add(Geo.box(0.06, 0.5, 0.5).translate(-0.24, 0, -SW_CHAIN + 0.25).color('#c8402a').mat(MAT.PAINT));
    if (rand() < 0.8) g.add(personGeo(rand, 5).transform(m4.mul(m4.translation(-0.05, 0, -SW_CHAIN - 0.4), m4.rotationZ(-Math.PI / 2))));
    // (in the chair's own frame: hung from the origin, facing +y)
    const tf = (t) => m4.mul(tfC(t), m4.rotationZ(k / 12 * TAU), m4.translation(SW_ARM, 0, SW_TOP), m4.rotationY(-swOut(t)));
    b.dynamic(g, { times: keys, transform: tf, caps: 'none', within: 450 });
    b.dynamic(chains, { times: keys, transform: tf, caps: 'none', within: 450 });
  }
}

// ---------------------------------------------------------------------------
// the swing boat: a boat on long arms from a high axle, swinging along the
// pier.  Cycles of 60 s: still for 14 s, then the swing (5.8 s there and
// back) grows to 70 degrees over 16 s, holds for 14 s and dies away over 16 s.

const SB_CYC = 60, SB_T = 5.8, SB_AX = 13.5;
function sbAngle(t) {
  const u = (((t + 32) % SB_CYC) + SB_CYC) % SB_CYC;   // (shifted: in full swing at t = 0)
  const amp = (70 * Math.PI / 180) * (u < 14 ? 0 : u < 30 ? sstep(14, 30, u) : u < 44 ? 1 : 1 - sstep(44, 60, u));
  return amp * Math.sin(TAU * (u - 14) / SB_T);
}
function swingBoat(b) {
  const { x, y } = BOAT;
  const frame = new Geo();
  for (const sy of [-2.6, 2.6]) {
    for (const sx of [-6.5, 6.5]) frame.add(rod([x + sx, y + sy * 1.5, DECK], [x, y + sy, DECK + SB_AX], 0.22, 8));
    frame.add(rod([x - 4.5, y + sy * 1.2, DECK + 4.2], [x + 4.5, y + sy * 1.2, DECK + 4.2], 0.1, 5));
  }
  frame.add(rod([x, y - 2.9, DECK + SB_AX], [x, y + 2.9, DECK + SB_AX], 0.3, 10));
  b.static(frame.color('#2a5a8a').mat(MAT.PAINT));
  b.static(cbox(16, 6, 0.4, 0.05).translate(x, y, DECK + 0.2).color('#6b4a2e').mat(MAT.WOOD), { solid: false });
  b.static(cbox(4.6, 0.15, 1.0, 0.03).translate(x + 6, y - 6.2, DECK + 1.2).color('#1a1a1a').mat(MAT.PAINT));
  b.static(signGeo('THE GALLEON', x + 6, y - 6.3, DECK + 1.2, 0, -1, 0.55, 2), { solid: false });
  for (const dx of [-2, 2]) b.static(cbox(0.12, 0.12, 1.4, 0.03).translate(x + 6 + dx, y - 6.2, DECK + 0.35).color('#1a1a1a').mat(MAT.PAINT));
  // the boat, hanging 11 m below the axle; its length runs along x
  const g = new Geo();
  const hull = Geo.lathe([[0.05, -1.4], [0.9, -1.25], [1.4, -0.5], [1.5, 0.3], [1.45, 0.55]], 10);
  // squash the round hull into a boat: long along x, curving up at both ends
  for (let i = 0; i < hull.vertexCount; i++) {
    const px = hull.p[i * 3];
    hull.p[i * 3] = px * 4.6;
    hull.p[i * 3 + 2] += 0.8 * Math.pow(px / 1.5, 2);
  }
  hull.computeNormals(true);
  g.add(hull.color('#8a2a1a').mat(MAT.PAINT).translate(0, 0, -11));
  for (const x of [-4.2, 0, 4.2]) g.add(Geo.box(4.2, 2.5, 0.12).translate(x, 0, -11 + 0.1).color('#c8a060').mat(MAT.WOOD));
  for (let k = -3; k <= 3; k++) g.add(Geo.box(0.35, 2.4, 0.45).translate(k * 1.8, 0, -11 + 0.35).color('#6b4a2e').mat(MAT.WOOD));
  for (const sy of [-1.2, 1.2]) for (const sx of [-1, 1]) g.add(rodIn([0, sy * 2.1, 0], [sx * 3.2, sy, -10.6], 0.12, 4, 3).color('#c8c8c0').mat(MAT.STEEL));
  // dragon prow and a sternpost
  g.add(Geo.tube([[6.6, 0, -10.2], [7.3, 0, -9.0], [7.4, 0, -8.2], [7.0, 0, -7.9]], (u) => 0.28 - 0.18 * u, 6).color('#c8a040').mat(MAT.IRON).gloss(0.7));
  g.add(Geo.tube([[-6.6, 0, -10.2], [-7.2, 0, -9.2], [-7.1, 0, -8.6]], (u) => 0.25 - 0.15 * u, 6).color('#c8a040').mat(MAT.IRON).gloss(0.7));
  const rand = rng(55);
  for (let k = -3; k <= 3; k++) {
    for (const sy of [-0.6, 0.6]) {
      if (rand() < 0.35) continue;
      g.add(personGeo(rand, 5, { hidden: true }).transform(m4.mul(m4.translation(k * 1.8 + 0.3, sy, -11 + 0.15), m4.rotationZ(Math.PI / 2))));
    }
  }
  const tf = (t) => m4.mul(m4.translation(x, y, DECK + SB_AX), m4.rotationY(sbAngle(t)));
  const times = adaptiveTimes(tf, 0, P, { tolerance: 0.3, size: 11, maxStep: 7, minStep: 0.3 });
  // (in pieces, arms and boat alike: see inPieces)
  for (const piece of inPieces(g, 5)) b.dynamic(piece, { times, transform: tf, caps: 'none' });
}

// ---------------------------------------------------------------------------
// the helter-skelter: a striped tower with a slide wound three times round
// it.  A rider sets off from the top every 7.5 s and takes 8 s to come down.

const HS_R = 2.0, HS_H = 13, HS_SLIDE = 3.4;
const hsPath = (u) => {
  const a = u * 3 * TAU;
  return [SKELTER.x + (HS_R + HS_SLIDE) / 2 * Math.cos(a) * 1.25, SKELTER.y + (HS_R + HS_SLIDE) / 2 * Math.sin(a) * 1.25, DECK + HS_H - 1.6 - u * (HS_H - 2.2)];
};
function helterSkelter(b) {
  const { x, y } = SKELTER;
  const g = new Geo(), deco = new Geo();
  g.add(Geo.cylinder(HS_R + 0.3, HS_H, 16, { r2: HS_R - 0.2, caps: false }).translate(x, y, DECK).color('#ffffff').mat(MAT.CANVAS).tag(1));
  deco.add(Geo.cone(HS_R + 0.6, 3.2, 16).translate(x, y, DECK + HS_H).color('#c8402a').mat(MAT.CANVAS).tag(2));
  deco.add(rod([x, y, DECK + HS_H + 3.0], [x, y, DECK + HS_H + 4.6], 0.04, 4).color('#aaaaaa').mat(MAT.STEEL));
  deco.add(Geo.quad([x, y, DECK + HS_H + 4.0], [x + 1.1, y, DECK + HS_H + 3.8], [x + 1.1, y, DECK + HS_H + 4.3], [x, y, DECK + HS_H + 4.5]).color('#e8c040').mat(MAT.CANVAS).doubleSided());
  // the slide: a ribbon with a raised outer lip, on brackets
  const slide = new Geo();
  const N = 120;
  for (let i = 0; i <= N; i++) {
    const u = i / N, a = u * 3 * TAU;
    const z = DECK + HS_H - 1.6 - u * (HS_H - 2.2);
    const c = Math.cos(a), sn = Math.sin(a);
    for (const [r, dz] of [[HS_R + 0.15, 0.1], [HS_R + 0.3, 0], [HS_SLIDE + 0.75, 0], [HS_SLIDE + 0.95, 0.35]]) slide.vert(x + r * c, y + r * sn, z + dz, 0, 0, 1, r, u * 30);
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) { const a = i * 4 + k; slide.quadIdx(a, a + 4, a + 5, a + 1); }
  slide.computeNormals(true);
  deco.add(slide.color('#e8c040').mat(MAT.PAINT).doubleSided());
  for (let i = 0; i < 24; i++) {
    const u = (i + 0.5) / 24, a = u * 3 * TAU, z = DECK + HS_H - 1.75 - u * (HS_H - 2.2);
    deco.add(rod([x + (HS_R + 0.1) * Math.cos(a), y + (HS_R + 0.1) * Math.sin(a), z - 0.5], [x + (HS_SLIDE + 0.8) * Math.cos(a), y + (HS_SLIDE + 0.8) * Math.sin(a), z - 0.05], 0.04, 3).color('#888888').mat(MAT.STEEL));
  }
  deco.add(signGeo('HELTER SKELTER', x + 5.2, y + 4.8, DECK + 1.0, 0.6, 0.8, 0.3, 2));
  b.static(g);
  b.static(deco, { solid: false });
  // riders on mats
  const rand = rng(33);
  for (let k = 0; k < thin(P / 7.5); k++) {
    const t0 = k * 7.5 + 0.3, dur = 8;
    const p = personGeo(rand, 5, { child: rand() < 0.5 });
    p.add(Geo.box(0.55, 1.0, 0.04).translate(0, 0.2, 0.02).color('#7a5a3a').mat(MAT.CLOTH));
    const tf = (t) => {
      const u = Math.min(1, Math.max(0, (t - t0) / dur));
      const q = hsPath(u), a = u * 3 * TAU;
      return m4.facing([q[0], q[1], q[2] - 0.38], [-Math.sin(a), Math.cos(a), 0]);
    };
    dynWrapped(b, p, timeRange(t0, t0 + dur, dur / 36), tf, { within: 250 });
  }
}

// ---------------------------------------------------------------------------
// the harbour arm and its lighthouse, whose two beams turn once in 12 s

const ARM_PATH = new Path([[2, 296], [-50, 300], [-110, 312], [-160, 326], [-188, 334]], { smooth: 6 });
function harbourArm(b) {
  const g = new Geo();
  const W = 4.5, Z = 5.2;
  const N = Math.ceil(ARM_PATH.length / 3);
  for (const side of [-1, 1]) {
    const wall = new Geo();
    for (let i = 0; i <= N; i++) {
      const { p, dir } = ARM_PATH.smoothAt(ARM_PATH.length * i / N, 6);
      const nx = dir[1] * side, ny = -dir[0] * side;
      const x = p[0] + nx * W, y = p[1] + ny * W;
      wall.vert(x + nx * 1.2, y + ny * 1.2, seabedZ(x, y) - 1, nx, ny, 0.25);
      wall.vert(x, y, Z, nx, ny, 0.25);
    }
    for (let i = 0; i < N; i++) wall.quadIdx(i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1);
    g.add(wall.orientByNormals());
  }
  const top = new Geo();
  for (let i = 0; i <= N; i++) {
    const { p, dir } = ARM_PATH.smoothAt(ARM_PATH.length * i / N, 6);
    top.vert(p[0] + dir[1] * W, p[1] - dir[0] * W, Z, 0, 0, 1);
    top.vert(p[0] - dir[1] * W, p[1] + dir[0] * W, Z, 0, 0, 1);
  }
  for (let i = 0; i < N; i++) top.quadIdx(i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1);
  g.add(top.orientByNormals());
  // a parapet on the seaward side
  for (let i = 0; i < N; i++) {
    const d = ARM_PATH.length * (i + 0.5) / N;
    const { p, dir } = ARM_PATH.smoothAt(d, 6);
    g.add(Geo.box(ARM_PATH.length / N + 0.05, 0.6, 1.1).rotateZ(Math.atan2(dir[1], dir[0])).translate(p[0] + dir[1] * (W - 0.3), p[1] - dir[0] * (W - 0.3), Z + 0.55));
  }
  g.add(Geo.cylinder(6.5, Z + 12, 20).translate(LIGHT.x, LIGHT.y, -12));
  b.static(g.color('#8f887c').mat(MAT.STONE));
}
function lighthouse(b) {
  const { x, y } = LIGHT;
  const g = new Geo(), deco = new Geo();
  const z0 = 5.2;
  g.add(Geo.cylinder(3.0, 17.5, 20, { r2: 2.3, caps: false }).translate(x, y, z0).color('#f2efe8').mat(MAT.PAINT).tag(3));
  deco.add(Geo.cylinder(3.1, 0.6, 20).translate(x, y, z0 + 17.5).color('#2a2a2a').mat(MAT.IRON));
  for (let k = 0; k < 24; k++) {
    const a = k / 24 * TAU;
    deco.add(rod([x + 3.0 * Math.cos(a), y + 3.0 * Math.sin(a), z0 + 18.1], [x + 3.0 * Math.cos(a), y + 3.0 * Math.sin(a), z0 + 19.1], 0.03, 3).color('#2a2a2a').mat(MAT.IRON));
  }
  deco.add(Geo.torus(3.0, 0.04, 24, 3).translate(x, y, z0 + 19.1).color('#2a2a2a').mat(MAT.IRON));
  deco.add(Geo.cylinder(1.9, 2.6, 16, { caps: false }).translate(x, y, z0 + 18.1).color('#ffe8b0').mat(MAT.LAMP).tag(3));
  deco.add(Geo.lathe([[2.1, 0], [1.9, 0.5], [1.2, 1.2], [0.4, 1.6], [0.01, 1.7]], 16).translate(x, y, z0 + 20.7).color('#a03a2a').mat(MAT.PAINT));
  deco.add(Geo.sphere(0.3, 8, 6).translate(x, y, z0 + 22.6).color('#2a2a2a').mat(MAT.IRON));
  b.static(g);
  b.static(deco, { solid: false });
  // The beams are not moving geometry: two very flat cones of haze round the
  // lantern (one rising, one falling a little outwards) on which the shader
  // draws the two beams where they point at the moment each pixel is seen.
  // Seen tilted, that moment varies across the bay: the beams wind into a spiral.
  const beam = new Geo();
  for (const dz of [-14, 14]) beam.add(Geo.lathe(dz < 0 ? [[320, dz], [1.2, 0]] : [[1.2, 0], [320, dz]], 72).translate(x, y, LIGHT.z));
  b.static(beam.color('#fff2c8').mat(MAT.BEAM).unlit().doubleSided().blend(0.1), { solid: false });
}

// ---------------------------------------------------------------------------
// fireworks, fired from a barge offshore all through the night (by day the
// shader leaves them dark).  Each shell rises for 1.6 s and bursts into a
// shell of sparks that spreads at first at 40 to 90 m/s (8 to 18 times C),
// slows in the air, droops and fades over 3.2 s.  Shells go up every 2.2 to
// 5.4 s, with a salvo of five near the end of every period.

const FW_COLORS = ['#ff4a3a', '#ffd84a', '#5aff8a', '#4ab4ff', '#ff6ad8', '#ffffff', '#ff9a2a', '#b46aff'];
function fireworkSchedule() {
  const rand = rng(2024);
  const out = [];
  let t = 0.6;
  while (t < P - 12) {
    out.push({ t, x: BARGE.x + (rand() - 0.5) * 70, y: BARGE.y + (rand() - 0.5) * 120, h: 70 + rand() * 80, r: 22 + rand() * 26, col: rand.pick(FW_COLORS), col2: rand.pick(FW_COLORS), kind: rand() < 0.2 ? 1 : 0 });
    t += 2.2 + rand() * 3.2;
  }
  for (let k = 0; k < 5; k++) out.push({ t: P - 9 + k * 0.35, x: BARGE.x + (k - 2) * 25, y: BARGE.y + (k - 2) * 30, h: 110 + k * 8, r: 40, col: FW_COLORS[k], col2: '#ffffff', kind: 0 });
  return out;
}
function burstGeo(rand, n, col, col2, kind) {
  const g = new Geo();
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    let d;
    if (kind === 1) {
      const a = i / n * TAU;
      d = v3.norm([Math.cos(a), Math.sin(a) * 0.4, Math.sin(a) * 0.9]);
    } else {
      const zz = 1 - 2 * (i + 0.5) / n, rr = Math.sqrt(1 - zz * zz), a = i * ga;
      d = v3.norm([rr * Math.cos(a) + (rand() - 0.5) * 0.1, rr * Math.sin(a) + (rand() - 0.5) * 0.1, zz + (rand() - 0.5) * 0.1]);
    }
    // a streak from 0.8 to 1.0 of the radius, as two crossed blades
    const side = v3.norm(v3.cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    const up = v3.cross(d, side);
    const w = 0.014;
    const c = i % 3 === 0 ? col2 : col;
    for (const s of [i % 2 ? side : up]) {
      const a0 = v3.scale(d, 0.8), a1 = v3.scale(d, 1.0);
      g.add(Geo.quad(v3.add(a0, v3.scale(s, -w * 0.3)), v3.add(a0, v3.scale(s, w * 0.3)), v3.add(a1, v3.scale(s, w)), v3.add(a1, v3.scale(s, -w))).color(c));
    }
  }
  return g.mat(MAT.SPARK).emissive(6).tag(1).additive();
}
function fireworks(b) {
  const rand = rng(77);
  // the barge, riding the tide
  const barge = new Geo();
  barge.add(cbox(10, 30, 1.6, 0.2).translate(0, 0, 0.3).color('#3a3a3a').mat(MAT.PAINT));
  for (let i = 0; i < 18; i++) barge.add(Geo.cylinder(0.15, 0.9, 6).translate((i % 3 - 1) * 2.5, -12 + Math.floor(i / 3) * 4.5, 1.1).color('#6a6a5a').mat(MAT.STEEL));
  barge.add(cbox(3, 4, 2.4, 0.1).translate(0, 13, 2.2).color('#d8d0b8').mat(MAT.PAINT));
  b.dynamic(barge, { times: timeRange(0, P, P / 16), transform: (t) => m4.translation(BARGE.x, BARGE.y, tideZ(t)), caps: 'none' });
  const rise = 1.6, life = 3.2;
  for (const sh of fireworkSchedule()) {
    // the rising shell: a bright streak travelling straight up
    const trail = Geo.box(0.25, 0.25, 6).translate(0, 0, -3).color('#ffd8a0').mat(MAT.SPARK).emissive(5).additive();
    b.dynamic(trail, {
      times: [sh.t, sh.t + rise],
      transform: (t) => m4.translation(lerp(BARGE.x, sh.x, (t - sh.t) / rise), lerp(BARGE.y, sh.y, (t - sh.t) / rise), 2 + (sh.h - 2) * (t - sh.t) / rise),
      caps: 'none',
    });
    const g = burstGeo(rand, thin(110), sh.col, sh.col2, sh.kind);
    const tb = sh.t + rise;
    // the moment of the burst, for the shader's fade: whole seconds / 32 in u
    // (exact in the 16-bit uv of moving geometry), the fraction in v
    for (let i = 0; i < g.vertexCount; i++) { g.uv[i * 2] = Math.floor(tb) / 32; g.uv[i * 2 + 1] = tb - Math.floor(tb); }
    const keys = [0, 0.15, 0.4, 0.8, 1.4, 2.2, life].map((u) => tb + u);
    // radius: fast at first, slowing in the air; and a droop under gravity
    const rad = (u) => sh.r * (1 - Math.exp(-u / 0.55)) / (1 - Math.exp(-life / 0.55));
    b.dynamic(g, {
      times: keys,
      transform: (t) => {
        const u = Math.max(0, t - tb);
        return m4.mul(m4.translation(sh.x, sh.y, sh.h - 2.2 * u * u), m4.scaling(Math.max(0.02, rad(u))));
      },
      caps: 'none',
    });
  }
}

// ---------------------------------------------------------------------------
// people walking on the pier: each walks from the promenade to the pavilion
// (or back), at a speed of their own, along a lane of their own.  A walk
// takes longer than a period, so each walker object stands for a stream of
// people one period apart.  Most stroll at 1.1 to 1.55 m/s; a few children
// run at 2.6 to 3.8 m/s.  (Nothing that moves lives much longer than two
// periods: a view tilted to 90 degrees draws every period copy that any
// moving thing spans, so long lives make that view expensive.)

function walkers(b) {
  const rand = rng(8080), phase = rng(8081);
  const n = thin(34);
  for (let k = 0; k < n; k++) {
    const out = k % 2 === 0;
    const v = rand() < 0.12 ? 2.6 + rand() * 1.2 : 1.1 + rand() * 0.45;
    const lane = rand() < 0.5 ? 1.6 + rand() * 1.2 : 4.4 + rand() * 1.0;   // (either side of the clock)
    const promY = (rand() < 0.5 ? -1 : 1) * (20 + rand() * 50);
    const door = [PAVILION.x1 + 3.4, (rand() < 0.5 ? -1 : 1) * (2.6 + rand() * 1.5)];
    let pts = [[18, promY], [18, 2.5 + lane * 0.3], [6, lane * 0.6 + 1.0], [-30, lane], [HEAD.x1 - 6, lane], [door[0] + 8, door[1]], door];
    if (!out) pts = pts.reverse();
    const legs = [];
    let T = rand() * P;
    const times = [T];
    for (let i = 1; i < pts.length; i++) {
      const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      legs.push({ a: pts[i - 1], b: pts[i], t0: T, t1: T + L / v });
      T += L / v;
      times.push(T);
    }
    const child = v > 2.4 || rand() < 0.15;
    const { sp, body: g } = personGeo(rand, 0, { child, parts: true });
    const { k: size, hip, sh } = sp;
    // what they carry, from near by only: an ice cream, a camera, a handbag
    // (and the arms that hold things, which do not swing: [elbow, hand])
    const det = new Geo(), hold = {};
    let dogLegs = null;
    if (!child && k % 7 === 3) {
      hold.left = [[-0.25 * size, 0.14, hip + 0.12], [-0.2, 0.3, 1.0]];
      hold.right = [[0.25 * size, 0.14, hip + 0.12], [0.2, 0.3, 1.0]];
      // pushing a pram
      const pr = new Geo(), pc = rand.pick(['#1e2a4a', '#5a1a2a', '#2a4a3a']);
      pr.add(cbox(0.5, 0.8, 0.35, 0.08).translate(0, 0.95, 0.62).color(pc).mat(MAT.PAINT));
      pr.add(Geo.sphere(0.36, 8, 4).scale(0.72, 0.8, 1).translate(0, 0.72, 0.8).color(pc).mat(MAT.CLOTH));
      for (const [x, y] of [[-0.24, 0.65], [0.24, 0.65], [-0.24, 1.25], [0.24, 1.25]]) pr.add(Geo.torus(0.14, 0.02, 10, 3).rotateY(Math.PI / 2).translate(x, y, 0.14).color('#1a1a1a').mat(MAT.WHEEL));
      pr.add(rod([-0.2, 0.55, 0.75], [-0.2, 0.3, 1.0], 0.015, 4).color('#c8c8c8').mat(MAT.STEEL));
      pr.add(rod([0.2, 0.55, 0.75], [0.2, 0.3, 1.0], 0.015, 4).color('#c8c8c8').mat(MAT.STEEL));
      pr.add(rod([-0.22, 0.3, 1.0], [0.22, 0.3, 1.0], 0.02, 4).color('#2a2a2a').mat(MAT.STEEL));
      g.add(pr);
      // (arms that both hold the handle do not swing: they go with the body)
      g.add(personArms(sp, null, { hold }));
    } else if (k % 4 === 0) {
      det.add(Geo.cone(0.035, 0.12, 6).rotateX(Math.PI).translate(0.25, 0.25, 1.05).color('#d8a860').mat(MAT.WOOD));
      det.add(Geo.sphere(0.04, 6, 4).translate(0.25, 0.25, 1.07).color(rand.pick(['#f4ecd8', '#f0b0c0', '#8a5a3a'])).mat(MAT.CLOTH));
      hold.right = [[0.26 * size, 0.04, sh - 0.4 * size], [0.25, 0.22, 0.97]];
    } else if (k % 4 === 1 && !child) {
      det.add(cbox(0.13, 0.07, 0.09, 0.015).translate(0, 0.15, 1.2).color('#1a1a1a').mat(MAT.STEEL));
      det.add(Geo.cylinder(0.025, 0.05, 8).rotateX(-Math.PI / 2).translate(0, 0.18, 1.2).color('#3a3a3a').mat(MAT.GLASS));
      det.add(Geo.tube([[-0.07, 0.15, 1.24], [-0.12, 0.05, 1.45], [0, 0.0, 1.5], [0.12, 0.05, 1.45], [0.07, 0.15, 1.24]], 0.006, 3, { caps: false }).color('#2a2a2a').mat(MAT.CLOTH));
    } else if (k % 4 === 2 && !child) {
      det.add(cbox(0.24, 0.08, 0.18, 0.03).translate(-0.27, 0.0, 0.75).color(rand.pick(['#8a2a1a', '#2a2a2a', '#c8a060', '#3a5a8a'])).mat(MAT.PAINT));
      det.add(Geo.tube([[-0.33, 0, 0.84], [-0.27, 0, 1.1], [-0.21, 0, 0.84]], 0.008, 3, { caps: false }).color('#2a2a2a').mat(MAT.CLOTH));
      hold.left = [[-0.25 * size, 0, hip + 0.18], [-0.24 * size, 0, hip - 0.05]];
    }
    if (child && k % 3 === 0) {
      // a balloon on a string
      hold.right = [[0.24 * size, 0.02, hip + 0.12], [0.17, 0.0, 0.6]];
      g.add(rod([0.16, 0.0, 0.55], [0.3, -0.2, 1.9], 0.004, 3).color('#e0e0e0').mat(MAT.STEEL));
      g.add(Geo.sphere(0.2, 8, 6).scale(1, 1, 1.15).translate(0.3, -0.2, 2.12).color(rand.pick(['#ff3a3a', '#3a7aff', '#ffd83a', '#ff7ad8'])).gloss(0.7).mat(MAT.PAINT));
    } else if (!child && k % 5 === 1) {
      // a dog on a lead, trotting alongside
      const dog = new Geo(), coat = rand.pick(['#2a2420', '#8a6a4a', '#e8e0d0', '#5a4a3a']);
      dog.add(Geo.sphere(0.2, 7, 5).scale(0.6, 1.4, 0.6).translate(0, 0, 0.38).color(coat).mat(MAT.CLOTH));
      dog.add(Geo.sphere(0.1, 6, 4).scale(0.9, 1.3, 1).translate(0, 0.33, 0.5).color(coat).mat(MAT.CLOTH));
      dog.add(rod([0, -0.26, 0.42], [0, -0.38, 0.6], 0.02, 3).color(coat).mat(MAT.CLOTH));
      g.add(dog.translate(0.65, 0.5, 0));
      // its legs, trotting: the diagonal pairs together, half a round apart,
      // each paw down for half a round and then lifted and brought forward
      dogLegs = (u) => {
        const m = new Geo();
        for (const [dx, dy, ph] of [[-0.07, 0.18, 0], [0.07, -0.18, 0], [0.07, 0.18, 0.5], [-0.07, -0.18, 0.5]]) {
          const w = (u + ph) % 1;
          const fy = w < 0.5 + 1e-9 ? 0.12 * (1 - 4 * w) : 0.12 * (4 * w - 3), up = w < 0.5 + 1e-9 ? 0 : 0.07 * (1 - Math.abs(4 * w - 3));
          m.add(limbTube([[dx, dy, 0.3], [dx, dy + fy * 0.5 + (dy > 0 ? 1 : -1) * up * 0.6, 0.15 + up * 0.5], [dx, dy + fy, up]], 0.03, 4, false, true).color(coat).mat(MAT.CLOTH));
        }
        return m.translate(0.65, 0.5, 0);
      };
      g.add(rod([0.25, 0.1, 0.85], [0.65, 0.8, 0.5], 0.006, 3).color('#c83a2a').mat(MAT.CLOTH));
      if (!hold.right) hold.right = [[0.25 * size, 0.04, hip + 0.15], [0.25, 0.1, 0.92]];
    }
    const tf = (t) => {
      let lg = legs[0];
      for (const l of legs) if (t >= l.t0 - 1e-9) lg = l;
      const u = Math.min(1, Math.max(0, (t - lg.t0) / (lg.t1 - lg.t0)));
      return m4.facing([lerp(lg.a[0], lg.b[0], u), lerp(lg.a[1], lg.b[1], u), DECK], [lg.b[0] - lg.a[0], lg.b[1] - lg.a[1], 0]);
    };
    // keys at the corners, just before each (so that the turn is quick), and every 25 m between
    const ks = [];
    for (const l of legs) {
      const L = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
      const n = Math.max(1, Math.ceil(L / 25));
      for (let k = 0; k < n; k++) ks.push(l.t0 + (l.t1 - l.t0) * k / n);
      if (l.t1 - l.t0 > 1) ks.push(l.t1 - 0.35);
    }
    ks.push(legs[legs.length - 1].t1);
    const kt = ks.sort((a, c) => a - c).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.05);
    dynWrapped(b, g, kt, tf, { within: 200 });
    if (det.vertexCount) dynWrapped(b, det, kt, tf, { within: 25 });
    // the legs and arms, striding: a round of two steps, each walker out of step with the others
    const gait = strideFor(sp, v);
    const cycle = { period: gait.period, keys: 4, start: phase() * gait.period };
    for (const limbs of walkerLimbs(sp, gait, hold)) dynWrapped(b, limbs, kt, tf, { within: 200, cycle });
    // (a dog's trot: a paw put down 0.24 m on from the last)
    if (dogLegs) dynWrapped(b, dogLegs, kt, tf, { within: 200, cycle: { period: 0.48 / v, keys: 4, start: phase() * 0.48 / v } });
  }
}

// ---------------------------------------------------------------------------
// the promenade and the town.  The promenade (x 0..20) runs along the top of
// the sea wall with a railing, lamps and the illuminations (festoons of bulbs
// that switch on at dusk in a wave running away from the pier both ways), and
// shelters.  Then the road (x 22..36), the pavement, and a terrace of hotels,
// shops and amusement arcades facing the sea (x 42..), with side streets.

const PROM_Y = 900;           // the promenade runs from y = -PROM_Y to PROM_Y
const ROAD_X = [22, 36];
const LANES = [26.2, 31.8];   // southbound, northbound
const FRONT_X = 42;           // the hotel fronts
// hotel blocks: [y0, y1, storeys, name or null, tint]
const BLOCKS = (() => {
  const rand = rng(1888);
  const out = [];
  const names = ['ROYAL HOTEL', 'THE MARINE HOTEL', 'HOTEL BEAUMONT', 'BELVEDERE', 'ALBION HOTEL', 'THE CLARENCE', 'HOTEL MIRAMAR', 'SEAVIEW HOTEL', 'THE ESPLANADE', 'GRAND HOTEL', 'QUEENS HOTEL', 'BAY HOTEL'];
  const tints = ['#f2ead8', '#efe2c4', '#e8eef0', '#f4dccc', '#dfe8d8', '#f0e6b8', '#e4dce8', '#f6f2ea', '#d8e4ec'];
  let y = -PROM_Y + 40, i = 0;
  while (y < PROM_Y - 60) {
    const w = 36 + Math.floor(rand() * 5) * 9;
    if (!(y < 20 && y + w > -20)) out.push({ y0: y, y1: y + w, st: 4 + Math.floor(rand() * 3), name: names[i % names.length], tint: tints[Math.floor(rand() * tints.length)], i });
    else out.push({ y0: y, y1: y + w, st: 3, name: 'AMUSEMENTS', tint: '#f6f2ea', i, arcade: true });
    i++;
    y += w + 12;
  }
  return out;
})();
const SHOPS = ['FISH & CHIPS', 'ROCK SHOP', 'ICE CREAM', 'CAFE', 'GIFTS', 'BINGO', 'DOUGHNUTS', 'TEAS', 'BUCKET & SPADE', 'ARCADE', 'POSTCARDS', 'SEAFOOD', 'CHEMIST', 'NEWSAGENT', 'TOYS'];

function promenade(b) {
  // the sea railing, open at the pier and at the head of the steps down to the beach
  const runs = [];
  for (const [a, c] of [[-1140, -ENTRY.hw], [STEPS.y1, 1140]]) {
    for (let y = a; y < c - 0.01; y += 30) runs.push([-0.15, y, -0.15, Math.min(c, y + 30)]);
  }
  railings(b, runs);
  // kerbs, and a low wall along the back of the promenade
  const kerb = new Geo();
  for (let y = -PROM_Y; y < PROM_Y; y += 60) {
    for (const x of ROAD_X) kerb.add(boxAt(x - 0.15, y, DECK - 0.1, x + 0.15, y + 60, DECK + 0.12));
  }
  b.static(kerb.color('#a8a49c').mat(MAT.STONE), { solid: false });
  // lamps every 25 m along the sea side, with the illuminations strung between them
  const lamps = [], bulbs = [];
  const tints = ['#ff5a4a', '#ffd84a', '#5aff7a', '#5ab4ff', '#fff4e0', '#ff7ad8'];
  for (let y = -PROM_Y + 10; y <= PROM_Y - 10; y += 25) {
    if (Math.abs(y) < ENTRY.hw + 2) continue;
    lamps.push({ transform: m4.mul(m4.translation(0.6, y, DECK), m4.rotationZ(Math.PI / 2)), data: 30 + Math.abs(y) * 0.6 });
    const y2 = y + 25;
    if (Math.abs(y2) < ENTRY.hw + 2 || y2 > PROM_Y - 10) continue;
    for (let k = 1; k < 40; k++) {
      const u = k / 40, yy = lerp(y, y2, u);
      bulbs.push({ transform: m4.translation(0.6, yy, DECK + 3.82 - 0.8 * 4 * u * (1 - u) - 0.07), tint: tints[k % 6], data: 30 + Math.abs(yy) * 0.6 });
    }
  }
  b.instances(lampStandard(), lamps);
  b.instances(Geo.sphere(0.075, 6, 4).color('#ffffff').mat(MAT.BULB), bulbs, { solid: false });
  // the wires
  const wire = new Geo();
  for (let y = -PROM_Y + 10; y < PROM_Y - 35; y += 25) {
    if (Math.abs(y) < ENTRY.hw + 2 || Math.abs(y + 25) < ENTRY.hw + 2) continue;
    const pts = [];
    for (let k = 0; k <= 8; k++) { const u = k / 8; pts.push([0.6, y + 25 * u, DECK + 3.82 - 0.8 * 4 * u * (1 - u)]); }
    wire.add(Geo.tube(pts, 0.012, 3, { caps: false }));
  }
  b.static(wire.color('#202020').mat(MAT.STEEL), { solid: false });
  // Victorian shelters: a glazed screen down the middle, benches both sides, a canopy
  const shelter = new Geo();
  shelter.add(boxAt(-0.06, -5, 0.5, 0.06, 5, 2.4).color('#cfe0e4').mat(MAT.GLASS).tag(1).blend(0.3));
  shelter.add(boxAt(-0.12, -5, 0, 0.12, 5, 0.5).color('#e8e2d4').mat(MAT.STONE));
  for (const yy of [-5.2, 5.2]) shelter.add(cbox(0.4, 0.4, 2.9, 0.04).translate(0, yy, 1.45).color(IRON_GREEN).mat(MAT.IRON));
  shelter.add(cbox(4.2, 11.6, 0.18, 0.05).translate(0, 0, 2.95).color(IRON_GREEN).mat(MAT.IRON));
  for (const s of [-1, 1]) {
    shelter.add(cbox(0.5, 9.6, 0.07, 0.02).translate(s * 0.5, 0, 0.45).color('#6b4a2e').mat(MAT.WOOD));
    shelter.add(cbox(0.06, 9.6, 0.45, 0.02).translate(s * 0.25, 0, 0.75).color('#6b4a2e').mat(MAT.WOOD));
    shelter.add(panel(s * 2.0, 0, s, 0, 11.6, 2.62, 2.9).color('#e6dcc4').mat(MAT.LATTICE).tag(1).doubleSided().cutout());
  }
  shelter.add(Geo.lathe([[2.6, 0], [2.2, 0.5], [0.3, 1.1], [0.01, 1.15]], 4).rotateZ(Math.PI / 4).scale(1, 2.6, 1).translate(0, 0, 3.0).color('#5d8a80').mat(MAT.ZINC));
  const shelters = [];
  for (let y = -PROM_Y + 70; y < PROM_Y - 50; y += 140) if (Math.abs(y) > 40) shelters.push(m4.translation(10, y, DECK));
  b.instances(shelter, shelters);
}

// a terrace of hotels and shops; returns the static meshes
function hotels(b) {
  const solid = new Geo(), deco = new Geo(), bays = [], balconies = [], awnings = [];
  const rand = rng(31337);
  for (const B of BLOCKS) {
    const { y0, y1 } = B, W = y1 - y0, H = B.st * 3.3 + 1.2, D = 22;
    const tint = B.tint;
    // the front, the sides, the back (uv in metres from the corner)
    solid.add(panel(FRONT_X, (y0 + y1) / 2, -1, 0, W, DECK, DECK + H).color(tint).mat(MAT.FACADE).tag(B.arcade ? 4 : 0));
    solid.add(panel(FRONT_X + D / 2, y0, 0, -1, D, DECK, DECK + H).color(tint).mat(MAT.FACADE).tag(5));
    solid.add(panel(FRONT_X + D / 2, y1, 0, 1, D, DECK, DECK + H).color(tint).mat(MAT.FACADE).tag(5));
    solid.add(panel(FRONT_X + D, (y0 + y1) / 2, 1, 0, W, DECK, DECK + H).color(tint).mat(MAT.FACADE).tag(5));
    // cornice, and a mansard roof of slate with dormers
    deco.add(cbox(0.8, W + 0.4, 0.45, 0.08).translate(FRONT_X - 0.2, (y0 + y1) / 2, DECK + H - 0.2).color('#e8e2d4').mat(MAT.STONE));
    const roof = Geo.extrude([[0, 0], [D, 0], [D - 2.2, 3.6], [2.2, 3.6]], W).rotateX(Math.PI / 2).translate(FRONT_X, y1, DECK + H);
    // (extruded along -y after the turn; the uv is in metres)
    solid.add(roof.color('#4a4c54').mat(MAT.ROOF));
    for (let y = y0 + 2.5; y < y1 - 2; y += 7.2) {
      deco.add(cbox(1.6, 1.6, 1.8, 0.05).translate(FRONT_X + 1.1, y + 1.8, DECK + H + 1.2).color(tint).mat(MAT.FACADE).tag(6));
    }
    // chimneys
    for (let y = y0 + 4; y < y1 - 2; y += 13) deco.add(cbox(1.0, 2.4, 2.6, 0.05).translate(FRONT_X + D / 2, y, DECK + H + 4.4).color('#8a5a44').mat(MAT.STONE));
    // the ground floor: shop fronts with fascia signs and striped awnings
    const nShop = Math.max(1, Math.round(W / 9));
    for (let k = 0; k < nShop; k++) {
      const yc = y0 + W * (k + 0.5) / nShop, sw = W / nShop - 0.8;
      const name = B.arcade ? (k % 2 ? 'AMUSEMENTS' : 'PRIZE BINGO') : (k === Math.floor(nShop / 2) ? 'HOTEL ENTRANCE' : SHOPS[(B.i * 3 + k) % SHOPS.length]);
      deco.add(cbox(0.25, sw, 0.75, 0.04).translate(FRONT_X - 0.12, yc, DECK + 3.55).color(B.arcade ? '#2a1a4a' : '#1e2a4a').mat(MAT.PAINT));
      deco.add(signGeo(name, FRONT_X - 0.26, yc, DECK + 3.55, -1, 0, 0.42, B.arcade ? 2 : 1));
      if (!B.arcade && rand() < 0.75) awnings.push({ transform: m4.mul(m4.translation(FRONT_X, yc, DECK + 3.05), m4.scaling(1, sw / 4, 1)), tint: rand.pick(['#c83a2a', '#2a5ac8', '#2a8a4a', '#d8a82a']) });
    }
    // the hotel's name along the top, on both its sea front and its parapet
    if (!B.arcade) deco.add(signGeo(B.name, FRONT_X - 0.45, (y0 + y1) / 2, DECK + H - 1.05, -1, 0, Math.min(1.1, W / 14), 1));
    else deco.add(signGeo('AMUSEMENTS', FRONT_X - 0.3, (y0 + y1) / 2, DECK + H - 1.3, -1, 0, 1.6, 2));
    // bay windows on the upper floors, balconies on the first
    for (let y = y0 + 1.8; y < y1 - 3.5; y += 7.2) {
      for (let s = 1; s < B.st; s++) bays.push({ transform: m4.translation(FRONT_X, y + 1.8, DECK + 3.3 * s + 0.15), tint });
      if (!B.arcade) balconies.push(m4.translation(FRONT_X, y + 5.4, DECK + 3.3 + 0.15));
    }
  }
  b.static(solid);
  b.static(deco, { solid: false });
  // a bay window: three faces of windows under a little roof (front at -x)
  const bay = new Geo();
  bay.add(panel(-0.8, 0, -1, 0, 2.0, 0, 3.1).mat(MAT.FACADE).tag(7));
  for (const s of [-1, 1]) {
    const q = panel(-0.4, s * 1.25, -0.6 * 1, s * 0.8, 1.0, 0, 3.1).mat(MAT.FACADE).tag(7);
    bay.add(q);
  }
  bay.add(cbox(1.0, 2.9, 0.2, 0.04).translate(-0.45, 0, 3.15));
  bay.add(cbox(1.0, 2.9, 0.15, 0.04).translate(-0.45, 0, 0.05));
  b.instances(bay.color('#ffffff'), bays, { solid: false });
  const balc = new Geo();
  balc.add(cbox(1.2, 3.2, 0.14, 0.03).translate(-0.6, 0, 0).color('#e8e2d4').mat(MAT.STONE));
  balc.add(panel(-1.15, 0, -1, 0, 3.1, 0.07, 1.0).color('#1d2b27').mat(MAT.RAILING).doubleSided().cutout());
  for (const s of [-1, 1]) balc.add(panel(-0.6, s * 1.55, 0, s, 1.1, 0.07, 1.0).color('#1d2b27').mat(MAT.RAILING).doubleSided().cutout());
  balc.add(cbox(1.2, 3.2, 0.06, 0.02).translate(-0.6, 0, 1.03).color('#1d2b27').mat(MAT.IRON));
  b.instances(balc, balconies, { solid: false });
  // a striped awning, 4 m wide (scaled to the shop), sloping out over the pavement
  const aw = new Geo();
  const q = Geo.quad([0, -2, 0.55], [0, 2, 0.55], [-2.2, 2, 0], [-2.2, -2, 0]);
  if (q.n[2] < 0) q.flip();
  for (let i = 0; i < 4; i++) { q.uv[i * 2] = [0, 4, 4, 0][i]; q.uv[i * 2 + 1] = [0, 0, 1, 1][i]; }
  aw.add(q.color('#ffffff').mat(MAT.CANVAS).tag(3).doubleSided());
  const val = panel(-2.2, 0, -1, 0, 4, -0.35, 0).color('#ffffff').mat(MAT.CANVAS).tag(3).doubleSided();
  aw.add(val);
  b.instances(aw, awnings, { solid: false });
  // pavement furniture: benches facing the sea, bins
}

// the streets of the town behind, and houses up the hill: instanced boxes
// with roofs, tinted, windows from the shader
function town(b) {
  const rand = rng(99);
  const houses = [], roofs = [];
  for (let x = 80; x < 760; x += 26) {
    for (let y = -PROM_Y; y < PROM_Y; y += 22) {
      if (rand() < 0.18) continue;
      const xx = x + rand() * 6, yy = y + rand() * 6;
      const z = landZ(xx, yy);
      if (z > DECK + 50 && rand() < 0.5) continue;
      const w = 9 + rand() * 6, d = 10 + rand() * 6, h = 6.5 + rand() * (x < 200 ? 9 : 4);
      const ang = (rand() - 0.5) * 0.08;
      const M = m4.mul(m4.translation(xx, yy, z - 0.5), m4.rotationZ(ang));
      houses.push({ transform: m4.mul(M, m4.scaling(d, w, h + 0.5)), tint: rand.pick(['#efe6d6', '#e6d8c2', '#d8c8b0', '#c8b8a8', '#e8e0d8', '#d0c0a0', '#b8a898']) });
      roofs.push({ transform: m4.mul(M, m4.translation(0, 0, h + 0.5), m4.scaling(d + 0.6, w + 0.6, 2.6 + rand() * 1.5)), tint: rand.pick(['#5a5a62', '#8a4a3a', '#6a6a6a', '#7a3a2a']) });
    }
  }
  // a unit house: walls with windows (uv: metres, scaled per copy in the shader by size; approximated)
  const house = Geo.box(1, 1, 1).translate(0, 0, 0.5).color('#ffffff').mat(MAT.TOWN);
  const roof = Geo.extrude([[-0.5, 0], [0.5, 0], [0, 1]], 1).rotateX(Math.PI / 2).translate(0, 0.5, 0).color('#ffffff').mat(MAT.ROOF);
  b.instances(house, houses);
  b.instances(roof, roofs, { solid: false });
  // a church on the hill
  const cx = 300, cy = 120, cz = landZ(cx, cy);
  const ch = new Geo();
  ch.add(boxAt(-14, -6, 0, 14, 6, 11).color('#b8b0a0').mat(MAT.STONE));
  ch.add(Geo.extrude([[-6.6, 0], [6.6, 0], [0, 6]], 29).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(-14.5, 0, 11).color('#5a5a62').mat(MAT.ROOF));
  ch.add(boxAt(-22, -4, 0, -14, 4, 24).color('#b8b0a0').mat(MAT.STONE));
  ch.add(Geo.cone(5.2, 22, 4).rotateZ(Math.PI / 4).translate(-18, 0, 24).color('#6a6a72').mat(MAT.ROOF));
  b.static(ch, { transform: m4.translation(cx, cy, cz - 1) });
}

// ---------------------------------------------------------------------------
// boats.  Everything afloat rides the tide (its height follows tideZ).
//   speedboats  one each side of the pier, lapping a 1.5 km oval at about 17 m/s (3.4 C), twice a period
//   jet skis    two, weaving along the beach at 12 m/s
//   yachts      three, crossing the bay on long straight legs at 2.5 to 4 m/s
//   trip boat   leaves the pier-head landing stage at 20 s past each period,
//               runs out and round the fireworks barge at 7 m/s and is back by 172 s
//   moored boats in the harbour, bobbing (a slow swell: 7.5 s)

function hullGeo(L, W, Hh, hex, deckHex) {
  // a simple planing hull: pointed bow at +y, flat transom at -y
  const g = new Geo();
  const sec = (u) => {
    // half-width and keel depth along the length (u 0 stern .. 1 bow)
    const w = W / 2 * (u < 0.6 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.6) / 0.4, 2))));
    return [Math.max(0.02, w), Hh * (0.55 + 0.45 * u)];
  };
  const N = 8, rows = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, y = -L / 2 + L * u, [w, kz] = sec(u);
    rows.push([g.vert(-w, y, Hh, -1, 0, 0), g.vert(-w * 0.75, y, Hh * 0.25 - (kz - Hh) * 0.2, -0.7, 0, -0.7), g.vert(0, y, Hh - kz, 0, 0, -1), g.vert(w * 0.75, y, Hh * 0.25 - (kz - Hh) * 0.2, 0.7, 0, -0.7), g.vert(w, y, Hh, 1, 0, 0)]);
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < 4; k++) g.quadIdx(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
  // transom
  g.quadIdx(rows[0][0], rows[0][4], rows[0][3], rows[0][1]); g.tri(rows[0][1], rows[0][3], rows[0][2]);
  g.computeNormals(true);
  g.color(hex).mat(MAT.PAINT);
  // deck
  const d = new Geo();
  for (let i = 0; i <= N; i++) { const u = i / N, y = -L / 2 + L * u, [w] = sec(u); d.vert(-w, y, Hh, 0, 0, 1); d.vert(w, y, Hh, 0, 0, 1); }
  for (let i = 0; i < N; i++) d.quadIdx(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  d.orientByNormals();
  g.add(d.color(deckHex).mat(MAT.WOOD));
  return g.orientByNormals();
}
function wakeGeo(L, W) {
  // a V of foam trailing the stern, lying on the water
  const g = new Geo();
  for (const s of [-1, 1]) {
    g.add(Geo.quad([s * W * 0.4, -L / 2, 0.06], [s * W * 0.6, -L / 2, 0.06], [s * (W * 0.6 + 7), -L / 2 - 26, 0.06], [s * (W * 0.4 + 5), -L / 2 - 26, 0.06]));
  }
  g.add(Geo.quad([-W * 0.4, -L / 2, 0.07], [W * 0.4, -L / 2, 0.07], [W * 0.8, -L / 2 - 18, 0.07], [-W * 0.8, -L / 2 - 18, 0.07]));
  for (let i = 0; i < g.vertexCount; i++) { g.uv[i * 2 + 1] = Math.min(1, Math.max(0, (-L / 2 - g.p[i * 3 + 1]) / 26)); }
  g.orientByNormals();
  return g.color('#ffffff').mat(MAT.WAKE).doubleSided().blend(0.9);
}
function speedboatGeo(rand, hex) {
  const g = hullGeo(7.5, 2.5, 0.9, hex, '#e8e2d4');
  g.add(Geo.quad([-1.0, 0.6, 0.9], [1.0, 0.6, 0.9], [0.8, 0.0, 1.55], [-0.8, 0.0, 1.55]).color('#203040').mat(MAT.GLASS));
  g.add(Geo.box(1.6, 1.0, 0.4).translate(0, -1.0, 1.1).color('#d8d0c0').mat(MAT.PAINT));
  g.add(Geo.box(0.5, 0.6, 0.7).translate(0, -3.5, 0.6).color('#2a2a2a').mat(MAT.STEEL));
  for (const x of [-0.5, 0.5]) if (rand() < 0.8) g.add(personGeo(rand, 5).translate(x, -0.8, 0.5));
  g.add(wakeGeo(7.5, 2.5));
  return g;
}
function jetskiGeo(rand, hex) {
  const g = hullGeo(3.0, 1.1, 0.6, hex, '#2a2a2a');
  g.add(cbox(0.4, 1.1, 0.25, 0.08).translate(0, -0.4, 0.75).color('#1a1a1a').mat(MAT.CLOTH));
  g.add(personGeo(rand, 5).translate(0, -0.55, 0.3));
  g.add(wakeGeo(3.0, 1.1).scale(0.6, 0.7, 1));
  return g;
}
function yachtGeo(rand) {
  const g = hullGeo(9, 3.0, 1.2, rand.pick(['#f4f4f0', '#1e2a4a', '#8a2a1a']), '#c8a070');
  g.add(cbox(1.8, 3, 0.6, 0.1).translate(0, -0.5, 1.5).color('#f0ece4').mat(MAT.PAINT));
  g.add(rod([0, 1.2, 1.2], [0, 1.2, 13], 0.08, 6).color('#c8c8c8').mat(MAT.STEEL));
  g.add(rod([0, 1.2, 2.8], [0, -3.6, 2.8], 0.06, 4).color('#c8c8c8').mat(MAT.STEEL));
  // mainsail and jib, slightly curved
  const main = new Geo();
  main.add(Geo.triangle([0, 1.15, 2.9], [0, -3.5, 2.9], [0, 1.15, 12.8]));
  main.add(Geo.triangle([0, 1.3, 2.0], [0, 4.4, 1.5], [0, 1.3, 12.0]));
  for (let i = 0; i < main.vertexCount; i++) main.p[i * 3] += 0.35 * Math.sin(Math.PI * Math.min(1, (main.p[i * 3 + 2] - 1.5) / 11.5));
  g.add(main.color('#f8f6f0').mat(MAT.SAIL).doubleSided());
  for (const y of [-2.5, -1.5]) if (rand() < 0.8) g.add(personGeo(rand, 5).translate(0.6, y, 0.8));
  return g;
}
function tripBoatGeo(rand) {
  const g = hullGeo(18, 5.2, 1.8, '#f2efe6', '#a88a60');
  g.add(cbox(4.6, 9, 2.2, 0.1).translate(0, -1.0, 2.9).color('#f2efe6').mat(MAT.PAINT));
  g.add(panel(2.31, -1.0, 1, 0, 8.6, 2.3, 3.5, true).mat(MAT.GLASS));
  g.add(panel(-2.31, -1.0, -1, 0, 8.6, 2.3, 3.5, true).mat(MAT.GLASS));
  g.add(cbox(5.0, 10, 0.15, 0.05).translate(0, -1.0, 4.05).color('#2a4a8a').mat(MAT.PAINT));
  g.add(Geo.cylinder(0.55, 2.0, 10).translate(0, 1.5, 4.1).color('#c8402a').mat(MAT.PAINT));
  g.add(cbox(5.2, 0.2, 0.2, 0.05).translate(0, -7.8, 2.6).color('#2a4a8a').mat(MAT.PAINT));
  for (let i = 0; i < 10; i++) g.add(personGeo(rand, 5).translate((i % 2 ? 1 : -1) * (0.6 + rand() * 1.2), -6 + (i >> 1) * 2.4 + (rand() - 0.5), 4.05 - 0.42 + 0.1));
  g.add(signGeo('BAY BELLE', 2.62, 3.5, 1.3, 1, 0, 0.45, 1));
  g.add(signGeo('BAY BELLE', -2.62, 3.5, 1.3, -1, 0, 0.45, 1));
  return g;
}

// a closed course as a smooth loop; returns a transform for a boat on it
function course(pts, speedOf, lapT, offsetT, bob = 0.04) {
  const path = new Path(pts, { closed: true, smooth: 10 });
  const L = path.length;
  return (t) => {
    const d = ((t + offsetT) / lapT) * L;
    const q = path.smoothAt(d, 8);
    const z = tideZ(t) + bob * Math.sin(t * 2.1);
    return m4.mul(m4.facing([q.p[0], q.p[1], z], [q.dir[0], q.dir[1], 0]), m4.rotationY(0.0), m4.rotationX(0.05));
  };
}

function boats(b) {
  const rand = rng(1234);
  // speedboats: one lapping an oval on each side of the pier, twice a period,
  // their long legs running along the pier's sight line (out on one side, in on the other)
  const ovals = [
    [[-275, -95], [-940, -110], [-1005, -250], [-920, -390], [-290, -370], [-240, -230]],
    [[-275, 95], [-940, 110], [-1000, 190], [-920, 262], [-310, 250], [-255, 172]],
  ];
  ['#c8402a', '#2a5ac8'].forEach((hex, i) => {
    const pts = i ? ovals[i].slice().reverse() : ovals[i];
    const tf = course(pts, 17, P / 2, i * P / 7);
    b.dynamic(speedboatGeo(rand, hex), { times: adaptiveTimes(tf, 0, P, { tolerance: 0.6, size: 4, maxStep: 3 }), transform: tf, caps: 'none', within: 900 });
  });
  // jet skis weaving in a loop each side of the pier head, two laps a period
  const jsLoops = [
    [[-255, -70], [-330, -160], [-262, -262], [-345, -365], [-430, -262], [-405, -120]],
    [[-255, 70], [-330, 160], [-262, 262], [-345, 365], [-430, 262], [-405, 120]].reverse(),
  ];
  ['#e8c040', '#3ac87a'].forEach((hex, i) => {
    const tf = course(jsLoops[i], 12, P / 2, i * P / 5, 0.08);
    b.dynamic(jetskiGeo(rand, hex), { times: adaptiveTimes(tf, 0, P, { tolerance: 0.5, size: 1.5, maxStep: 3 }), transform: tf, caps: 'none', within: 500 });
  });
  // yachts: straight across the bay and back, slowly (the leg out and the leg back each take half a period)
  [[-640, -900, -700, 900, 0], [-900, 850, -860, -850, 0.3], [-1150, -800, -1110, 800, 0.65]].forEach(([x0, y0, x1, y1, ph]) => {
    const g = yachtGeo(rand);
    const pos = (t) => {
      const u = (((t / P + ph) % 1) + 1) % 1;
      const k = u < 0.5 ? u * 2 : 2 - u * 2;
      return [lerp(x0, x1, k), lerp(y0, y1, k), u < 0.5 ? 1 : -1];
    };
    const tf = (t) => {
      const [x, y, s] = pos(t);
      return m4.mul(m4.facing([x, y, tideZ(t)], [(x1 - x0) * s, (y1 - y0) * s, 0]), m4.rotationY(0.12 * s));
    };
    const tTurn = (((0.5 - ph) % 1) + 1) % 1 * P, tTurn2 = (((1 - ph) % 1) + 1) % 1 * P;
    const ks = new Set(timeRange(0, P, P / 16));
    for (const tt of [tTurn, tTurn2]) for (const dt of [-0.6, 0.6]) if (tt + dt > 0 && tt + dt < P) ks.add(tt + dt);
    b.dynamic(g, { times: [...ks].sort((a, c) => a - c), transform: tf, caps: 'none' });
  });
  // the trip boat
  {
    const g = tripBoatGeo(rand);
    // Moored alongside the landing stage's pontoon, bow to the east; it pulls
    // out eastwards, turns south and west, and comes back round the end of
    // the pier head to the same berth, all within a period.
    const loop = new Path([[-318.5, -48.4], [-298, -50], [-292, -66], [-320, -100], [-380, -150], [-560, -170], [-660, -40], [-600, 110], [-420, 90], [-360, 10], [-352, -38], [-338, -49], [-318.5, -48.4]], { smooth: 10 });
    const t0 = 20, v = 7, dur = loop.length / v;
    const tf = (t) => {
      const q = loop.smoothAt(t > t0 && t < t0 + dur ? (t - t0) * v : 0, 10);
      return m4.facing([q.p[0], q.p[1], tideZ(t)], [q.dir[0], q.dir[1], 0]);
    };
    const ks = new Set(timeRange(0, P, P / 16));
    for (const tt of adaptiveTimes(tf, t0, t0 + dur, { tolerance: 0.5, size: 9, maxStep: 6 })) ks.add(tt);
    for (const tt of [t0 + 8, t0 + dur - 8]) ks.add(tt);
    const times = [...ks].sort((a, c) => a - c).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.05);
    b.dynamic(g, { times, transform: tf, caps: 'none' });
    // its wake, which draws out behind the stern as it gets under way and
    // shrinks away as it comes in to the berth (nothing at all while it lies there)
    const wake = (t) => Math.min(1, Math.max(0, (t - t0) / 8), Math.max(0, (t0 + dur - t) / 8));
    b.dynamic(wakeGeo(18, 5.2).scale(1.2, 0.9, 1), { times, transform: (t) => m4.mul(tf(t), m4.translation(0, -8.1, 0), m4.scaling(1, wake(t), 1), m4.translation(0, 8.1, 0)), caps: 'none' });
  }
  // boats moored inside the harbour arm, bobbing on the swell
  for (let i = 0; i < thin(6); i++) {
    const x = -30 - i * 22 + rand() * 6, y = 272 - i * 3 + rand() * 8;
    const g = hullGeo(6 + rand() * 3, 2.2 + rand() * 0.6, 1.0, rand.pick(['#2a5a8a', '#c8402a', '#f0ece4', '#3a7a4a', '#e8c040']), '#a88a60');
    g.add(cbox(1.4, 1.6, 1.2, 0.08).translate(0, 0.2, 1.6).color('#f0ece4').mat(MAT.PAINT));
    g.add(rod([0, 1.4, 1.0], [0, 1.4, 5.5], 0.05, 4).color('#c8c8c8').mat(MAT.STEEL));
    const ph = rand() * TAU, yaw = 2.6 + rand() * 0.6;
    // riding the tide (on the sea surface's own keys), and meanwhile bobbing
    // and rocking on the swell: a round of 7.5 s, eight poses
    const tf = (t) => m4.mul(m4.translation(x, y, tideZ(t)), m4.rotationZ(yaw));
    const swell = (u) => m4.mul(m4.translation(0, 0, 0.12 * Math.sin(TAU * u + ph)), m4.rotationX(0.05 * Math.sin(TAU * u + ph + 1.2)), m4.rotationY(0.07 * Math.sin(TAU * u + ph + 0.4)));
    b.dynamic(g, { times: timeRange(0, P, P / 8), transform: tf, caps: 'none', within: 600, cycle: { period: 7.5, keys: 8, transform: swell } });
  }
  // the landing stage at the pier head: steps down to a pontoon that rides the tide
  {
    const solid = new Geo();
    solid.add(boxAt(-326, -HEAD.hw - 2.2, DECK - 0.3, -311, -HEAD.hw, DECK).color('#8a6a4a').mat(MAT.DECK));
    for (const x of [-325, -312]) solid.add(Geo.cylinder(0.25, DECK + 6, 8).translate(x, -HEAD.hw - 7, -6).color(IRON_DARK).mat(MAT.IRON));
    b.static(solid);
    const pont = new Geo();
    pont.add(cbox(15, 4.5, 0.8, 0.1).translate(-318.5, -HEAD.hw - 6.8, 0.25).color('#5a5a5a').mat(MAT.PAINT));
    const ramp = (t) => m4.translation(0, 0, tideZ(t));
    b.dynamic(pont, { times: timeRange(0, P, P / 16), transform: ramp, caps: 'none' });
  }
}

// ---------------------------------------------------------------------------
// gulls, wheeling over the pier: each glides round a circle (a helix, seen
// tilted) of its own size and speed, and one flaps along beside the railing

function gullGeo() {
  const g = new Geo();
  g.add(Geo.sphere(0.12, 6, 4).scale(1, 2.6, 1).color('#f4f4f0').mat(MAT.PAINT));
  g.add(Geo.cone(0.03, 0.12, 4).rotateX(-Math.PI / 2).translate(0, 0.32, 0).color('#e8b040').mat(MAT.PAINT));
  return g;
}
// The wings, held out in a glide (a = 0) or raised by a (radians) at the
// shoulder, the outer half further, as they beat.
function gullWings(a) {
  const g = new Geo();
  for (const s of [-1, 1]) {
    // turned about the body's long axis, through the shoulder
    const up = (p, ang) => [p[0] * Math.cos(ang) - (p[2] - 0.02) * Math.sin(ang) * s, p[1], 0.02 + s * p[0] * Math.sin(ang) + (p[2] - 0.02) * Math.cos(ang)];
    const f = [0, 0.15, 0.02], r = [0, -0.12, 0.02], wr = up([s * 0.55, 0.05, 0.12], a), tip = up([s * 1.05, -0.2, 0.0], 1.35 * a);
    const w = new Geo();
    w.add(Geo.triangle(f, wr, r));
    w.add(Geo.triangle(wr, tip, r));
    g.add(w.color('#d8dce0').mat(MAT.PAINT).doubleSided());
  }
  return g;
}
// A gull's round: three beats of its wings (0.4 s each: up, level, down,
// level), then a glide of 2 s.  Thirty-two poses, a tenth of a second apart.
const GULL_ROUND = 3.2, GULL_POSES = 32;
const gullBeat = (u) => {
  const i = Math.round(u * GULL_POSES);
  return i < 12 ? [0.55, 0.05, -0.42, 0.05][i % 4] : 0;
};
function gulls(b) {
  const rand = rng(4321), phase = rng(4322);
  for (let i = 0; i < thin(14); i++) {
    const cx = -20 - rand() * 300, cy = (rand() - 0.5) * 120, cz = DECK + 12 + rand() * 25;
    const R = 8 + rand() * 18, laps = 3 + Math.floor(rand() * 4), dir = rand() < 0.5 ? 1 : -1, ph = rand() * TAU;
    const tf = (t) => {
      const a = ph + dir * TAU * laps * t / P;
      const p = [cx + R * Math.cos(a), cy + R * Math.sin(a), cz + 2 * Math.sin(a * 2 + ph)];
      return m4.mul(m4.facing(p, [-Math.sin(a) * dir, Math.cos(a) * dir, 0]), m4.rotationY(-0.35 * dir));
    };
    const times = timeRange(0, P, P / laps / 16);
    b.dynamic(gullGeo(), { times, transform: tf, caps: 'none', within: 250 });
    // the wings, on the same keys; each gull beats its own time, and its
    // round divides the period (so that it joins up), at about 3.2 s
    const round = P / Math.round(P / (GULL_ROUND * (0.85 + 0.3 * phase())));
    b.dynamic((u) => gullWings(gullBeat(u)), { times, transform: tf, caps: 'none', within: 250, cycle: { period: round, keys: GULL_POSES, start: phase() * round } });
  }
}

// ---------------------------------------------------------------------------
// traffic on the sea-front road: cars and buses both ways at 10.5 to 14 m/s,
// each driving the whole 1.9 km of the promenade on its lane (a straight run
// at constant speed, with a key every 25 m so that a tilted slice takes in
// only the piece of the run it meets), drawn again every period: a stream.
// Cyclists (5 to 6.5 m/s) and people on the pavement come out of one side
// street and turn into another a few blocks along.  Small movers are only
// drawn from near by (`within`).

function carGeo(rand, kind) {
  const g = new Geo();
  const paint = rand.pick(['#c83a2a', '#2a4a8a', '#e8e2d4', '#1a1a1a', '#8a8a8a', '#2a6a4a', '#d8b02a', '#6a2a5a']);
  if (kind === 'bus') {
    const L = 10.5, W = 2.5;
    g.add(Geo.box(W, L, 2.0).translate(0, 0, 1.45).color('#c83a2a').mat(MAT.PAINT));
    g.add(Geo.box(W, L, 1.9).translate(0, 0, 3.4).color('#c83a2a').mat(MAT.PAINT));
    for (const z of [1.95, 3.85]) for (const s of [-1, 1]) g.add(panel(s * (W / 2 + 0.01), 0, s, 0, L - 1.2, z - 0.45, z + 0.45, true).mat(MAT.GLASS));
    g.add(panel(0, L / 2 + 0.01, 0, 1, W - 0.3, 1.5, 2.4, true).mat(MAT.GLASS));
    g.add(Geo.box(W + 0.02, L - 0.3, 0.25).translate(0, 0, 2.6).color('#efe4c8').mat(MAT.PAINT));
    g.add(signGeo('PROMENADE', 0, L / 2 + 0.02, 4.1, 0, 1, 0.3, 2));
    for (const y of [-L / 2 + 2, L / 2 - 2.2]) for (const s of [-1, 1]) g.add(Geo.cylinder(0.5, 0.3, 7, { caps: false }).rotateY(Math.PI / 2).translate(s * (W / 2 - 0.15) - 0.15, y, 0.5).color('#1a1a1a').mat(MAT.WHEEL));
    for (const s of [-1, 1]) g.add(Geo.box(0.25, 0.05, 0.18).translate(s * 0.9, L / 2 + 0.02, 0.8).color('#fff6d0').mat(MAT.LAMP).tag(2));
    return g;
  }
  const L = 4.2, W = 1.75;
  g.add(Geo.box(W, L, 0.7).translate(0, 0, 0.65).color(paint).mat(MAT.PAINT));
  g.add(Geo.box(W - 0.2, L * 0.5, 0.55).translate(0, -0.2, 1.25).color(paint).mat(MAT.PAINT));
  for (const s of [-1, 1]) g.add(panel(s * (W / 2 - 0.09), -0.2, s, 0, L * 0.46, 1.05, 1.45, true).mat(MAT.GLASS));
  g.add(Geo.quad([-0.75, 0.88, 1.0], [0.75, 0.88, 1.0], [0.7, 0.5, 1.48], [-0.7, 0.5, 1.48]).mat(MAT.GLASS));
  g.add(Geo.quad([0.75, -1.3, 1.0], [-0.75, -1.3, 1.0], [-0.7, -0.95, 1.48], [0.7, -0.95, 1.48]).mat(MAT.GLASS));
  for (const y of [-1.35, 1.35]) for (const s of [-1, 1]) g.add(Geo.cylinder(0.32, 0.22, 7, { caps: false }).rotateY(Math.PI / 2).translate(s * (W / 2 - 0.1) - 0.11, y, 0.32).color('#1a1a1a').mat(MAT.WHEEL));
  for (const s of [-1, 1]) {
    g.add(Geo.box(0.22, 0.05, 0.14).translate(s * 0.62, L / 2, 0.72).color('#fff6d0').mat(MAT.LAMP).tag(2));
    g.add(Geo.box(0.3, 0.05, 0.12).translate(s * 0.6, -L / 2 - 0.01, 0.8).color('#ff2a1a').mat(MAT.LAMP).tag(4));
  }
  g.add(Geo.box(0.5, 0.03, 0.12).translate(0, L / 2 + 0.01, 0.45).color('#f0f0e0').mat(MAT.PAINT));
  g.add(personGeo(rand, 5).translate(-0.4, 0.1, 0.18));
  if (rand() < 0.5) g.add(personGeo(rand, 5).translate(0.4, 0.1, 0.18));
  return g;
}
function cyclistGeo(rand) {
  const g = new Geo();
  for (const y of [-0.52, 0.52]) {
    g.add(Geo.torus(0.33, 0.025, 10, 3).rotateY(Math.PI / 2).translate(0, y, 0.35).color('#1a1a1a').mat(MAT.WHEEL));
    g.add(Geo.disc(0.31, 10).rotateY(Math.PI / 2).translate(0, y, 0.35).color('#b0b0b0').mat(MAT.WHEEL).tag(1).doubleSided());
  }
  const fr = rand.pick(['#c83a2a', '#2a5ac8', '#1a1a1a', '#e8e2d4', '#2a8a4a']);
  for (const [a, c] of [[[0, -0.52, 0.35], [0, -0.05, 0.85]], [[0, -0.05, 0.85], [0, 0.45, 0.88]], [[0, 0.45, 0.88], [0, 0.52, 0.35]], [[0, -0.05, 0.85], [0, 0.0, 0.35]], [[0, 0.0, 0.35], [0, -0.52, 0.35]]]) g.add(rod(a, c, 0.025, 4).color(fr).mat(MAT.PAINT));
  const { sp, body } = personGeo(rand, 3, { parts: true });
  // seated higher, leaning forward to the bars
  const seat = m4.mul(m4.translation(0, -0.15, 0.5), m4.rotationX(-0.25));
  g.add(body.transform(seat));
  // The legs, pedalling: the cranks (0.17 m) turn about the bottom bracket,
  // pose by pose (u: the share of a turn done), the feet on the pedals, and
  // each knee goes where a thigh and a shin of the rider's length put it,
  // forward of the hip.
  const k = sp.k, L1 = 0.42 * k, L2 = 0.45 * k;
  const legs = (u) => {
    const m = new Geo();
    for (const s of [-1, 1]) {
      const a = TAU * u + (s < 0 ? Math.PI : 0);
      const hip = m4.point(seat, [s * 0.08 * k, 0, 0.48]), foot = [s * 0.12, 0.17 * Math.sin(a), 0.35 + 0.17 * Math.cos(a)];
      const dy = foot[1] - hip[1], dz = foot[2] - hip[2], d = Math.min(L1 + L2 - 0.01, Math.hypot(dy, dz));
      const al = Math.acos(Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))), dir = Math.atan2(dz, dy) + al;
      const knee = [s * 0.11 * k, hip[1] + L1 * Math.cos(dir), hip[2] + L1 * Math.sin(dir)];
      m.add(limbTube([hip, knee, foot], (q) => (0.075 - 0.025 * q) * k, 4, false, true).color(sp.legs).mat(MAT.CLOTH));
      // and the crank the foot is on
      m.add(limbTube([[s * 0.06, 0, 0.35], [s * 0.09, foot[1] * 0.5, 0.35 + (foot[2] - 0.35) * 0.5], [s * 0.11, foot[1], foot[2]]], 0.016, 3).color('#9a9a9a').mat(MAT.STEEL));
    }
    return m;
  };
  return { body: g, legs };
}
function traffic(b) {
  const rand = rng(777), pedal = rng(778);
  const Y0 = -PROM_Y - 60, Y1 = PROM_Y + 60;
  const lanes = [[LANES[1], 1], [LANES[0], -1]];
  for (const [x, s] of lanes) {
    const n = thin(18);
    for (let i = 0; i < n; i++) {
      const kind = i % 4 === 2 ? 'bus' : 'car';
      const v = kind === 'bus' ? 10.5 : 11 + rand() * 3;
      const dur = (Y1 - Y0) / v;
      const t0 = i * P / n + rand() * 4;
      const tf = (t) => m4.facing([x, s > 0 ? Y0 + (t - t0) * v : Y1 - (t - t0) * v, DECK], [0, s, 0]);
      dynWrapped(b, carGeo(rand, kind), runKeys(t0, t0 + dur, Y1 - Y0), tf, { within: kind === 'bus' ? 500 : 350 });
    }
  }
  // Cyclists and people on the pavement come out of one side street and turn
  // into another a few blocks along (so that nothing moving lives for more
  // than about two periods: a view tilted to 90 degrees takes in every
  // period that any moving thing spans).
  const gaps = [];
  for (let i = 0; i < BLOCKS.length - 1; i++) gaps.push((BLOCKS[i].y1 + BLOCKS[i + 1].y0) / 2);
  for (let i = 0; i < thin(14); i++) {
    const a = Math.floor(rand() * gaps.length), d = (rand() < 0.5 ? -1 : 1) * (3 + Math.floor(rand() * 3));
    const bq = Math.min(gaps.length - 1, Math.max(0, a + d));
    if (bq === a) continue;
    const gA = gaps[a], gB = gaps[bq], north = gB > gA;
    const xx = north ? ROAD_X[1] - 1.2 : ROAD_X[0] + 1.2;
    // (pedalling: a turn of the cranks for every 4.8 m, eight poses to a turn)
    const cg = cyclistGeo(rand), v = 5 + rand() * 1.5, t0 = rand() * P;
    // (the spoked discs of its wheels are told its speed, for the shader: see wheelSurf)
    for (let q = 0; q < cg.body.vertexCount; q++) if (cg.body.a[q * 4 + 2] === MAT.WHEEL && cg.body.x[q * 2 + 1] === 1) cg.body.x[q * 2] = v / 10;
    legMover(b, cg.body, [[52, gA], [xx, gA], [xx, gB], [52, gB]], v, t0, DECK, 300, [{ geo: cg.legs, cycle: { period: 4.8 / v, keys: 8, start: pedal() } }]);
  }
  // people strolling on the promenade between the pier entrance and the
  // shelters, and along the pavement, striding at their own pace
  const phase = rng(7071);
  const stroller = (pts, v0, dv) => {
    const { sp, body } = personGeo(rand, 0, { child: rand() < 0.15, parts: true });
    const v = v0 + rand() * dv, t0 = rand() * P, gait = strideFor(sp, v);
    const cycle = { period: gait.period, keys: 4, start: phase() * gait.period };
    legMover(b, body, pts, v, t0, DECK, 220, walkerLimbs(sp, gait, {}).map((geo) => ({ geo, cycle })));
  };
  const shelterY = [];
  for (let y = -PROM_Y + 70; y < PROM_Y - 50; y += 140) if (Math.abs(y) > 40 && Math.abs(y) < 450) shelterY.push(y);
  for (let i = 0; i < thin(14); i++) {
    const ys = shelterY[Math.floor(rand() * shelterY.length)], x = rand() < 0.5 ? 2 + rand() * 2 : 14 + rand() * 4;
    let pts = [[9, Math.sign(ys) * 14], [x, Math.sign(ys) * 16], [x, ys - Math.sign(ys) * 6], [10, ys - Math.sign(ys) * 5.2]];
    if (i % 2) pts = pts.reverse();
    stroller(pts, 0.9, 0.5);
  }
  for (let i = 0; i < thin(18); i++) {
    const a = Math.floor(rand() * gaps.length), d = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 3));
    const bq = Math.min(gaps.length - 1, Math.max(0, a + d));
    if (bq === a) continue;
    const x = 38.2 + rand() * 2.6;
    stroller([[54, gaps[a]], [x, gaps[a]], [x, gaps[bq]], [54, gaps[bq]]], 0.9, 0.6);
  }
}

// ---------------------------------------------------------------------------
// things on the pier: benches with people on them, people at the railings
// and fishing, a clock on a column half way out, kiosks, telescopes, life
// rings, bins.  Small parts are given with `within` (drawn from near by only).

function benchGeo() {
  const g = new Geo();
  const wood = '#7a5638';
  for (let k = 0; k < 3; k++) g.add(cbox(1.9, 0.1, 0.04, 0.01).translate(0, -0.18 + k * 0.12, 0.45).color(wood).mat(MAT.WOOD));
  for (let k = 0; k < 2; k++) g.add(cbox(1.9, 0.04, 0.1, 0.01).transform(m4.mul(m4.translation(0, -0.3, 0.68 + k * 0.16), m4.rotationX(0.2))).color(wood).mat(MAT.WOOD));
  for (const x of [-0.85, 0.85]) {
    g.add(Geo.tube([[x, 0.2, 0.0], [x, 0.1, 0.43], [x, -0.25, 0.45], [x, -0.36, 0.95]], 0.03, 4).color(IRON_GREEN).mat(MAT.IRON));
    g.add(Geo.tube([[x, -0.25, 0.0], [x, -0.2, 0.43]], 0.03, 4).color(IRON_GREEN).mat(MAT.IRON));
    g.add(Geo.tube([[x, -0.3, 0.62], [x, -0.05, 0.62], [x, 0.18, 0.55]], 0.025, 4).color(IRON_GREEN).mat(MAT.IRON));
  }
  return g;
}
function pierThings(b) {
  const rand = rng(5150);
  // benches along the north railing of the neck, facing in; on the head round the edge
  const benches = [], sitters = [];
  for (let x = -45.5; x > NECK.x0 + 4; x -= 15) {
    benches.push(m4.mul(m4.translation(x, NECK.hw - 0.75, DECK), m4.rotationZ(Math.PI)));
    if (x < -150 && x > -170) continue;
  }
  for (let x = -250; x > HEAD.x0 + 40; x -= 15) for (const s of [-1, 1]) benches.push(m4.mul(m4.translation(x, s * (HEAD.hw - 0.75), DECK), m4.rotationZ(s > 0 ? Math.PI : 0)));
  b.instances(benchGeo(), benches, { solid: false });
  // some of them occupied (static people: a mesh each, so that they differ)
  const people = new Geo(), leaners = new Geo(), papers = new Geo();
  for (const M of benches) {
    for (const dx of [-0.5, 0.45]) {
      if (rand() < 0.55) continue;
      const pm = m4.mul(M, m4.translation(dx, -0.05, 0.03), m4.rotationZ(Math.PI));
      people.add(personGeo(rand, 2).transform(pm));
      if (rand() < 0.35) {
        // reading a newspaper, held open on the knees
        const np = Geo.quad([-0.28, 0.32, 0.72], [0.28, 0.32, 0.72], [0.26, 0.42, 1.05], [-0.26, 0.42, 1.05]).color('#e8e4d8').mat(MAT.BOARD).tag(8).doubleSided();
        papers.add(np.transform(pm));
      }
    }
  }
  // People leaning on the railings looking out to sea, and anglers on the
  // head: half a metre from the rail, and not where a lamp, a bench, a
  // telescope or a bin stands.
  const taken = (x, onHead) => {
    const near = (x0, step, n, w) => { for (let j = 0; j < n; j++) if (Math.abs(x - (x0 - step * j)) < w) return true; return false; };
    if (onHead) return near(HEAD.x1 - 8, 15, 7, 1.0) || near(-250, 15, 3, 1.6);
    return near(-38, 15, 13, 1.0) || near(-45.5, 15, 13, 1.6) || near(-52, 30, 7, 0.9) || near(-40, 22, 9, 0.9);
  };
  for (let i = 0; i < thin(26); i++) {
    const head = i % 3 === 0;
    const side = !head || rand() < 0.5 ? 1 : -1;   // (on the neck, the walkway side: the railway runs along the other)
    let x = head ? HEAD.x0 + 40 + rand() * 60 : -40 - rand() * 180;
    for (let tries = 0; tries < 8 && taken(x, head); tries++) x = head ? HEAD.x0 + 40 + rand() * 60 : -40 - rand() * 180;
    const y = side * ((head ? HEAD.hw : NECK.hw) - LEAN_RAIL[0]), rot = side > 0 ? 0 : Math.PI;
    const p = personGeo(rand, 4);
    if (head && rand() < 0.6) {
      // a fishing rod over the railing
      p.add(rod([0.18, 0.5, 1.17], [0.5, 3.6, 2.6], 0.012, 3).color('#2a2a2a').mat(MAT.STEEL));
      p.add(rod([0.5, 3.6, 2.6], [0.55, 3.9, -DECK + 0.5], 0.002, 3).color('#d0d0d0').mat(MAT.STEEL));
    }
    leaners.add(p.transform(m4.mul(m4.translation(x, y, DECK), m4.rotationZ(rot))));
  }
  b.static(people, { solid: false });
  b.static(leaners, { solid: false });
  b.static(papers, { solid: false, within: 40 });
  // the pier clock: a cast-iron column with four dials, half way out on the walkway
  {
    const cx = -206, cy = 3.6;
    const g = new Geo();
    g.add(Geo.lathe([[0.4, 0], [0.4, 0.4], [0.25, 0.55], [0.18, 0.7], [0.15, 3.4], [0.3, 3.6], [0.3, 3.7]], 10).color(IRON_GREEN).mat(MAT.IRON));
    g.add(cbox(1.3, 1.3, 1.3, 0.08).translate(0, 0, 4.35).color(IRON_GREEN).mat(MAT.IRON));
    g.add(Geo.lathe([[0.75, 0], [0.6, 0.3], [0.2, 0.6], [0.05, 1.0]], 8).rotateZ(Math.PI / 8).translate(0, 0, 5.0).color(IRON_GREEN).mat(MAT.IRON));
    g.add(Geo.sphere(0.12, 8, 6).translate(0, 0, 6.1).color('#c8a040').mat(MAT.IRON).gloss(0.7));
    b.static(g, { transform: m4.translation(cx, cy, DECK) });
    const d = new Geo();
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; d.add(dial(Math.cos(a) * 0.66, Math.sin(a) * 0.66, 4.35, Math.cos(a), Math.sin(a), 0.52)); }
    b.static(d, { transform: m4.translation(cx, cy, DECK), solid: false });
  }
  // kiosks along the neck, on the walkway side: ices, doughnuts, fortunes
  [[-82, 'ICES', '#f0d8d8'], [-160, 'DOUGHNUTS', '#d8e8f0'], [-124, 'FORTUNES', '#e8e0f0']].forEach(([x, name, wall]) => {
    const k = kioskGeo(1.6, 2.6, wall, '#3c6b62').translate(x, 4.4, DECK);
    b.static(k);
    b.static(signGeo(name, x - 1.62, 4.4, DECK + 2.2, -1, 0, 0.3, 2), { solid: false });
    b.static(signGeo(name, x + 1.62, 4.4, DECK + 2.2, 1, 0, 0.3, 2), { solid: false });
  });
  // coin telescopes, life rings and bins at the railings (small parts: from near by only)
  const scopes = [], rings = [], bins = [];
  for (let x = -52; x > NECK.x0 + 4; x -= 30) scopes.push(m4.mul(m4.translation(x, NECK.hw - 0.6, DECK), m4.rotationZ(rand() - 0.5)));
  for (const [x, y, r] of [[-318, HEAD.hw - 0.6, 0], [-336 + 0.6, 24, -Math.PI / 2], [-336 + 0.6, -24, -Math.PI / 2], [-300, -HEAD.hw + 0.6, Math.PI]]) scopes.push(m4.mul(m4.translation(x, y, DECK), m4.rotationZ(r)));
  for (let x = -60; x > NECK.x0 + 4; x -= 45) rings.push(m4.mul(m4.translation(x, NECK.hw - 0.1, DECK + 0.62), m4.rotationZ(Math.PI)));
  for (let x = -40; x > NECK.x0 + 4; x -= 22) bins.push(m4.translation(x, NECK.hw - 0.5, DECK));
  for (const [x, y] of [[-245, 8], [-260, -32.5], [-272, 33], [-290, 7.5], [-243, -31]]) bins.push(m4.translation(x, y, DECK));
  for (const x of [-258, -288, -318]) for (const s of [-1, 1]) rings.push(m4.mul(m4.translation(x, s * (HEAD.hw - 0.1), DECK + 0.62), m4.rotationZ(s > 0 ? Math.PI : 0)));
  const scope = new Geo();
  scope.add(Geo.cylinder(0.08, 1.1, 8).color(IRON_GREEN).mat(MAT.IRON));
  scope.add(cbox(0.3, 0.25, 0.35, 0.04).translate(0, 0, 1.2).color(IRON_GREEN).mat(MAT.IRON));
  scope.add(Geo.cylinder(0.09, 0.8, 10).rotateX(-Math.PI / 2 + 0.15).translate(0, -0.35, 1.35).color('#c8a040').mat(MAT.IRON).gloss(0.7));
  b.instances(scope, scopes, { solid: false, within: 60 });
  const ring = Geo.torus(0.3, 0.07, 14, 6).rotateX(Math.PI / 2).color('#ffffff').mat(MAT.CANVAS).tag(4);
  ring.add(cbox(0.7, 0.06, 0.8, 0.02).translate(0, -0.08, 0).color('#e8e2d4').mat(MAT.PAINT));
  b.instances(ring, rings, { solid: false, within: 80 });
  const bin = Geo.cylinder(0.24, 0.85, 10).color('#1e3a2a').mat(MAT.IRON);
  bin.add(Geo.cylinder(0.27, 0.06, 10).translate(0, 0, 0.85).color('#c8a040').mat(MAT.IRON));
  b.instances(bin, bins, { solid: false, within: 80 });
  // a queue at the ice-cream kiosk, and a family on the entry deck (static)
  const crowd = new Geo();
  for (let i = 0; i < 5; i++) crowd.add(personGeo(rand, 1, { child: i === 2 }).transform(m4.mul(m4.translation(-79.6 + i * 0.75, 2.9 - i * 0.1, DECK), m4.rotationZ(Math.PI / 2 + 0.2))));
  for (const [x, y, r, c] of [[-14, 6, 2.0, false], [-15, 7.0, 2.5, true], [-20, -11, 0.3, false], [-19.3, -11.6, 0.5, false]]) crowd.add(personGeo(rand, 1, { child: c }).transform(m4.mul(m4.translation(x, y, DECK), m4.rotationZ(r))));
  b.static(crowd, { solid: false });
}

// ---------------------------------------------------------------------------
// the beach: a row of beach huts under the sea wall, deckchairs, windbreaks
// and sandcastles on the dry sand above the high-water line (x > -30), people
// sitting and standing, and a donkey ride that plods 80 m along the beach and
// back once a period (0.9 m/s; it turns at 90 s past).

function hutGeo() {
  const g = new Geo();
  g.add(panel(0, -1.2, 0, -1, 2.0, 0, 2.1).color('#ffffff').mat(MAT.WOOD));
  g.add(panel(0, 1.2, 0, 1, 2.0, 0, 2.1).color('#ffffff').mat(MAT.WOOD));
  g.add(panel(1.0, 0, 1, 0, 2.4, 0, 2.1).color('#ffffff').mat(MAT.WOOD));
  // the front (facing the sea, -x), with a door and a little window in the gable
  g.add(panel(-1.0, 0, -1, 0, 2.4, 0, 2.1).color('#ffffff').mat(MAT.WOOD));
  g.add(panel(-1.02, 0, -1, 0, 1.0, 0.15, 1.95).color('#f4f0e6').mat(MAT.PAINT).untinted());
  g.add(Geo.sphere(0.03, 4, 3).translate(-1.05, 0.38, 1.0).color('#c8a040').mat(MAT.IRON).untinted());
  const gab = Geo.extrude([[-1.25, 0], [1.25, 0], [0, 0.9]], 2.2).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(-1.1, 0, 2.1);
  g.add(gab.color('#f4f0e6').mat(MAT.PAINT).untinted());
  for (const s of [-1, 1]) {
    const r = Geo.quad([-1.15, 0, 3.02], [1.15, 0, 3.02], [1.15, s * 1.4, 2.02], [-1.15, s * 1.4, 2.02]);
    if (r.n[2] < 0) r.flip();
    g.add(r.color('#5a5a62').mat(MAT.ROOF).untinted());
  }
  return g;
}
function deckchairGeo() {
  const g = new Geo();
  const wood = (geo) => geo.color('#b8956a').mat(MAT.WOOD).untinted();
  for (const s of [-0.3, 0.3]) {
    g.add(wood(rod([s, 0.45, 0], [s, -0.5, 0.95], 0.02, 3)));
    g.add(wood(rod([s, -0.25, 0], [s, 0.25, 0.42], 0.02, 3)));
    g.add(wood(rod([s, 0.25, 0.42], [s, 0.55, 0.45], 0.02, 3)));
  }
  // the striped canvas sling (uv across: the stripes run down it)
  const c = new Geo();
  for (let k = 0; k <= 4; k++) {
    const u = k / 4;
    const p = v3.lerp([0, 0.35, 0.38], [0, -0.48, 0.92], u);
    const sag = 0.1 * Math.sin(Math.PI * u);
    c.vert(-0.29, p[1] + sag * 0.6, p[2] - sag, 0, 0.6, 0.8, 0, u);
    c.vert(0.29, p[1] + sag * 0.6, p[2] - sag, 0, 0.6, 0.8, 4, u);
  }
  for (let k = 0; k < 4; k++) c.quadIdx(k * 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
  c.orientByNormals();
  g.add(c.color('#ffffff').mat(MAT.CANVAS).tag(3).doubleSided());
  return g;
}
function windbreakGeo() {
  const g = new Geo();
  for (let k = 0; k < 4; k++) {
    const a = [k * 1.2, k % 2 ? 0.25 : -0.25], b = [(k + 1) * 1.2, k % 2 ? -0.25 : 0.25];
    const q = Geo.quad([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], 1.1], [a[0], a[1], 1.1]);
    for (let i = 0; i < 4; i++) q.uv[i * 2] = [0, 4, 4, 0][i];
    g.add(q.color('#ffffff').mat(MAT.CANVAS).tag(3).doubleSided());
  }
  for (let k = 0; k <= 4; k++) g.add(rod([k * 1.2, k % 2 ? 0.25 : -0.25, -0.3], [k * 1.2, k % 2 ? 0.25 : -0.25, 1.2], 0.025, 3).color('#8a6a4a').mat(MAT.WOOD).untinted());
  return g;
}
function donkeyGeo(rand, rider) {
  const g = new Geo();
  const coat = rand.pick(['#6a5a4a', '#8a7a6a', '#4a3a30', '#9a8a7a']);
  g.add(Geo.sphere(0.5, 9, 6).scale(0.55, 1.15, 0.6).translate(0, 0, 1.0).color(coat).mat(MAT.CLOTH));
  // The legs, walking (u: the share of a round of four steps done): one
  // after another, left hind, left fore, right hind, right fore, a quarter of
  // a round apart; each hoof stays where it was put for half a round while
  // the body passes over it, then is lifted and brought forward, the knee
  // bent (forward on a foreleg, back on a hind one).  reach: how far a hoof
  // gets in front of its shoulder or hip, and behind it.
  const legs = (u, reach) => {
    const m = new Geo();
    for (const [x, y, ph] of [[-0.17, -0.45, 0], [-0.17, 0.45, 0.25], [0.17, -0.45, 0.5], [0.17, 0.45, 0.75]]) {
      const w = (u + ph) % 1;
      const fy = w < 0.5 + 1e-9 ? reach * (1 - 4 * w) : reach * (4 * w - 3), up = w < 0.5 + 1e-9 ? 0 : 0.12 * (1 - Math.abs(4 * w - 3));
      const bend = (y > 0 ? 1 : -1) * up * 0.9;
      m.add(limbTube([[x, y, 0.85], [x, y + fy * 0.5 + bend, 0.43 + up * 0.4], [x, y + fy, up]], (q) => 0.06 - 0.01 * q, 5, false, true).color(coat).mat(MAT.CLOTH));
    }
    return m;
  };
  g.add(Geo.tube([[0, 0.5, 1.15], [0, 0.75, 1.45], [0, 0.95, 1.55]], 0.13, 6).color(coat).mat(MAT.CLOTH));
  g.add(Geo.sphere(0.17, 7, 5).scale(0.8, 1.6, 0.9).translate(0, 1.12, 1.48).color(coat).mat(MAT.CLOTH));
  g.add(Geo.sphere(0.07, 5, 3).scale(0.6, 0.8, 1).translate(0, 1.38, 1.42).color('#d8d0c0').mat(MAT.CLOTH));
  for (const s of [-1, 1]) g.add(Geo.cone(0.05, 0.32, 4).rotateX(-0.3).rotateY(s * 0.4).translate(s * 0.08, 0.98, 1.6).color(coat).mat(MAT.CLOTH));
  g.add(rod([0, -0.62, 1.05], [0, -0.75, 0.6], 0.03, 3).color(coat).mat(MAT.CLOTH));
  g.add(cbox(0.6, 0.55, 0.08, 0.02).translate(0, -0.05, 1.32).color(rand.pick(['#c83a2a', '#2a5ac8', '#e8c040'])).mat(MAT.CLOTH));
  g.add(signGeo(rand.pick(['DAISY', 'PADDY', 'BONNIE', 'JACK', 'MOLLY']), 0, 0.98, 1.56, 0, 1, 0.07, 1));
  if (rider) g.add(personGeo(rand, 3, { child: true }).translate(0, -0.1, 0.92));
  return { body: g, legs };
}
function beach(b) {
  const rand = rng(2468);
  // beach huts in rows under the sea wall, facing the sea
  const huts = [];
  const hutCols = ['#e84a3a', '#3a8ae8', '#f0c83a', '#3ac87a', '#e8e8e0', '#e87ab8', '#7a5ae8', '#3ac8c8'];
  // (none where one would stand in the way at the foot of the steps down from
  // the promenade, or in the wall of the harbour arm, y 291.7 to 301.9 here)
  const inTheWay = (y) => (y > 0 && y < STEPS.y2 + 3.4) || (y > 289.8 && y < 303.2);
  for (const [y0, y1] of [[24, 330], [-330, -24], [420, 640], [-640, -420]]) {
    for (let y = y0; y < y1; y += 2.9) {
      if (rand() < 0.06) continue;
      const tint = hutCols[Math.floor(rand() * hutCols.length)];
      if (!inTheWay(y)) huts.push({ transform: m4.translation(-2.1, y, sandZ(-2.1, y) - 0.05), tint });
    }
  }
  b.instances(hutGeo(), huts);
  // deckchairs, windbreaks, sandcastles, and people on the dry sand
  const chairs = [], breaks = [], castles = [];
  const people = new Geo();
  const canv = ['#c83a2a', '#2a5ac8', '#2a8a4a', '#e8c040', '#7a3d7a', '#e86a2a'];
  for (let i = 0; i < thin(140); i++) {
    const y = (rand() < 0.5 ? -1 : 1) * (10 + rand() * 420), x = -6 - rand() * 24;
    if (Math.abs(y) < 9) continue;
    const z = sandZ(x, y), rot = Math.PI / 2 + (rand() - 0.5) * 0.9;
    const M = m4.mul(m4.translation(x, y, z), m4.rotationZ(rot));
    const r = rand();
    if (r < 0.45) {
      chairs.push({ transform: M, tint: rand.pick(canv) });
      if (rand() < 0.5) people.add(personGeo(rand, 2).transform(m4.mul(M, m4.translation(0, -0.05, 0.0), m4.rotationX(-0.25))));
    } else if (r < 0.62) {
      breaks.push({ transform: m4.mul(M, m4.rotationZ(Math.PI / 2)), tint: rand.pick(canv) });
    } else if (r < 0.75) {
      castles.push({ transform: m4.mul(M, m4.scaling(0.6 + rand() * 0.8)), tint: '#c8a878' });
      if (rand() < 0.7) people.add(personGeo(rand, 1, { child: true }).transform(m4.mul(M, m4.translation(0.9, 0, 0), m4.rotationZ(Math.PI / 2))));
    } else {
      people.add(personGeo(rand, 1, { child: rand() < 0.3 }).transform(M));
    }
  }
  b.instances(deckchairGeo(), chairs, { solid: false });
  b.instances(windbreakGeo(), breaks, { solid: false });
  const castle = new Geo();
  castle.add(Geo.cylinder(0.35, 0.35, 8, { r2: 0.3 }).color('#ffffff').mat(MAT.SAND));
  for (const [x, y] of [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]) castle.add(Geo.cylinder(0.12, 0.45, 6, { r2: 0.09 }).translate(x, y, 0).color('#ffffff').mat(MAT.SAND));
  b.instances(castle, castles, { solid: false, within: 120 });
  b.static(people, { solid: false });
  // a lifeguard's chair on a tall frame
  {
    const x = -24, y = -150, z = sandZ(x, y);
    const g = new Geo();
    for (const [a, c] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) g.add(rod([a * 1.4, c * 1.4, 0], [a, c, 2.6], 0.05, 4));
    g.add(cbox(1.5, 1.5, 0.1, 0.02).translate(0, 0, 2.6));
    g.add(cbox(1.6, 0.1, 1.0, 0.02).translate(0, 0.75, 3.1));
    g.color('#e8e2d4').mat(MAT.PAINT);
    g.add(Geo.quad([-1.6, -1.6, 4.0], [1.6, -1.6, 4.0], [1.6, 1.6, 4.0], [-1.6, 1.6, 4.0]).color('#c83a2a').mat(MAT.CANVAS).doubleSided());
    g.add(rod([0.7, 0.7, 2.6], [0.7, 0.7, 4.0], 0.03, 3).color('#e8e2d4').mat(MAT.PAINT));
    g.add(personGeo(rand, 2, { coat: '#c83a2a' }).translate(0, 0.1, 2.25));
    g.add(signGeo('LIFEGUARD', 0, -0.76, 3.1, 0, -1, 0.25, 0).rotateZ(0));
    b.static(g, { transform: m4.mul(m4.translation(x, y, z), m4.rotationZ(Math.PI / 2)), solid: false });
  }
  // the donkey ride: a handler leading four donkeys along the beach and back
  {
    const yA = 30, yB = 110, x = -15, v = (yB - yA) / (P / 2);
    const team = new Geo();
    const handler = personGeo(rand, 0, { coat: '#3a5a3a', parts: true });
    team.add(handler.body.translate(-0.6, 1.4, 0));
    const donkeys = [];
    for (let k = 0; k < 4; k++) {
      const d = donkeyGeo(rand, k !== 2);
      team.add(d.body.translate(0, -k * 2.4, 0));
      donkeys.push(d.legs);
    }
    const tf = (t) => {
      const u = ((t % P) + P) % P;
      const out = u < P / 2;
      const y = out ? yA + v * u : yB - v * (u - P / 2);
      const yy = out ? y : y;
      return m4.facing([x, yy, sandZ(x, yy) - 0.05], [0, out ? 1 : -1, 0]);
    };
    const ks = new Set([...timeRange(0, P / 2 - 0.6, 10), ...timeRange(P / 2, P - 0.6, 10), P]);
    const times = [...ks].sort((a, c) => a - c);
    b.dynamic(team, { times, transform: tf, caps: 'none', within: 400 });
    // the legs (and the handler's arms), each on the team's keys, striding:
    // a hoof put down 0.48 m on from the last on the same side, and each in a
    // round that the period holds a whole number of times, as the team is
    // there throughout
    const whole = (T) => P / Math.round(P / T);
    const hg = strideFor(handler.sp, v), hp = whole(hg.period);
    for (const limbs of walkerLimbs(handler.sp, hg, {})) b.dynamic((u) => limbs(u).translate(-0.6, 1.4, 0), { times, transform: tf, caps: 'none', within: 400, cycle: { period: hp, keys: 4, start: 0.3 * hp } });
    const dp = whole(4 * 0.24 / v);
    donkeys.forEach((legs, k) => b.dynamic((u) => legs(u, 0.24).translate(0, -k * 2.4, 0), { times, transform: tf, caps: 'none', within: 400, cycle: { period: dp, keys: 4, start: [0, 0.55, 0.2, 0.8][k] * dp } }));
  }
}

// The steps from the promenade down to the beach (see STEPS): stone treads
// against the sea wall, a railing down their open side, and the screens that
// keep a walker on the dry part of the beach: along the high-water line, from
// the pier to the harbour arm, whose wall closes it to the north.  (The
// pier's railings have screens of their own, down to the sand.)
function beachSteps(b) {
  const { x0, y0, y1, y2, n } = STEPS;
  const zb = sandZ(x0 / 2, y2), rise = (DECK - zb) / n, run = (y2 - y1) / n;
  const stone = new Geo();
  stone.add(boxAt(x0, y0, DECK - 0.4, 0, y1, DECK));
  for (let i = 0; i < n - 1; i++) stone.add(boxAt(x0, y1 + run * i, zb - 0.3, 0, y1 + run * (i + 1), DECK - rise * (i + 1)));
  b.static(stone.color('#b8b2a4').mat(MAT.STONE), { solid: false });
  // the railing: posts, a handrail, and iron infill, level along the landing and sloping down the flight
  const x = x0 + 0.06, hz = (y) => (y <= y1 ? DECK : lerp(DECK - rise, zb, (y - y1) / (y2 - y1)));
  const iron = new Geo();
  for (const y of [y0, y1, ...[1, 2, 3, 4].map((k) => y1 + (y2 - y1) * k / 4)]) iron.add(cbox(0.08, 0.08, RAIL_H, 0.015).translate(x, y, hz(y) + RAIL_H / 2));
  b.static(iron.color(IRON_GREEN).mat(MAT.IRON), { solid: false });
  b.static(Geo.tube([[x, y0, DECK + RAIL_H], [x, y1, DECK + RAIL_H], [x, y2, zb + RAIL_H]], 0.04, 6).color('#6b4a2e').mat(MAT.WOOD).gloss(0.35), { solid: false });
  const infill = new Geo();
  for (const [ya, yb] of [[y0, y1], [y1, y2]]) {
    const za = hz(ya), zc = hz(yb), q = Geo.quad([x, ya, za + 0.14], [x, yb, zc + 0.14], [x, yb, zc + RAIL_H - 0.04], [x, ya, za + RAIL_H - 0.04]);
    const h = RAIL_H - 0.18;
    q.uv.splice(0, 8, 0, 0, yb - ya, 0, yb - ya, h, 0, h);
    infill.add(q);
  }
  b.static(infill.color(IRON_GREEN).mat(MAT.RAILING).doubleSided().cutout(), { solid: false });
  // the screens (invisible): beside the steps, and along the high-water line
  const guard = new Geo();
  guard.add(panel(x0, (y0 + y2) / 2, -1, 0, y2 - y0, zb - 0.6, DECK + 2.9));
  for (let y = NECK.hw; y < 300; y += 50) guard.add(panel(-34, y + 25, 1, 0, 50, 0.8, 5.2));
  b.static(guard.mat(MAT.GLASS).tag(9).blend(0), { solid: true });
}

// ---------------------------------------------------------------------------
// the pier head's smaller attractions: bunting, flags on the pavilion, a
// Punch and Judy booth with children watching, a balloon seller, a
// test-your-strength machine, and gulls perched on the posts

function headThings(b) {
  const rand = rng(97531);
  // bunting: lines of pennants from the clock tower to lamp posts round the head
  const pennants = [], line = new Geo();
  const top = [PAVILION.x1 + 5.5, 0, DECK + 12.5];
  const cols = ['#c83a2a', '#2a5ac8', '#e8c040', '#f0f0f0', '#3a9a5a'];
  for (const [x, y] of [[HEAD.x1 - 8, HEAD.hw - 0.35], [HEAD.x1 - 8, -HEAD.hw + 0.35], [HEAD.x1 - 38, HEAD.hw - 0.35], [HEAD.x1 - 38, -HEAD.hw + 0.35], [HEAD.x1 + 0.35, 8], [HEAD.x1 + 0.35, -8]]) {
    const a = [x, y, DECK + 3.9];
    const L = v3.dist(a, top), n = Math.floor(L / 0.7);
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const u = k / n, p = v3.lerp(a, top, u);
      p[2] -= 1.6 * 4 * u * (1 - u);
      pts.push(p);
    }
    line.add(Geo.tube(pts, 0.01, 3, { caps: false }));
    for (let k = 1; k < n; k++) {
      const d = v3.sub(pts[k + 1], pts[k - 1]);
      pennants.push({ transform: m4.mul(m4.translation(...pts[k]), m4.rotationZ(Math.atan2(d[1], d[0]))), tint: cols[k % 5] });
    }
  }
  b.static(line.color('#e8e2d4').mat(MAT.STEEL), { solid: false });
  const pen = Geo.triangle([-0.16, 0, 0], [0.16, 0, 0], [0, 0, -0.38]).color('#ffffff').mat(MAT.CANVAS).doubleSided();
  b.instances(pen, pennants, { solid: false });
  // flags on the pavilion's turrets and dome
  // (the poles stand still; the flags wave in the breeze off the sea, a wave
  // running out along each from its pole to its free end, 1.5 s apart, six
  // poses to a wave; each flag on its own, so that a tilted view, which
  // takes in many moments of a thing, takes them in only where it is)
  const flags = new Geo();
  const flagAt = (x, y, z, hex, n) => {
    flags.add(rod([x, y, z], [x, y, z + 3.2], 0.035, 4).color('#d8d8d0').mat(MAT.STEEL));
    const cloth = (w) => {
      const f2 = new Geo();
      for (let i = 0; i <= 6; i++) {
        const u = i / 6, dy = 0.12 * Math.sin(u * 5 + x) * (1 - u) + 0.3 * u * Math.sin(TAU * w - 4.4 * u + n * 1.9);
        f2.vert(x + u * 1.9, y + dy, z + 3.1, 0, 1, 0, u, 1);
        f2.vert(x + u * 1.9, y + dy, z + 2.0 - 0.1 * u, 0, 1, 0, u, 0);
      }
      for (let i = 0; i < 6; i++) f2.quadIdx(i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1);
      return f2.computeNormals(true).color(hex).mat(MAT.CANVAS).doubleSided();
    };
    b.dynamic(cloth, { times: [0, P], caps: 'none', cycle: { period: 1.5, keys: 6 } });
  };
  const { x0, x1, hw } = PAVILION;
  flagAt((x0 + x1) / 2, 0, DECK + 9.5 + 8.8 + 4.2, '#c83a2a', 0);
  let nf = 1;
  for (const sx of [x0 + 1.4, x1 - 1.4]) for (const sy of [-hw + 1.4, hw - 1.4]) flagAt(sx, sy, DECK + 9.5 + 5.6, sy > 0 ? '#2a5ac8' : '#e8c040', nf++);
  b.static(flags, { solid: false });
  // Punch and Judy: a tall striped booth with a little stage, children sitting in front
  {
    const bx = -280, by = 8;
    const g = new Geo();
    g.add(boxAt(-0.7, -0.9, 0, 0.7, 0.9, 2.9).color('#ffffff').mat(MAT.CANVAS).tag(5));
    g.add(Geo.extrude([[-0.85, -1.05], [0.85, -1.05], [0.85, 1.05], [-0.85, 1.05]], 0.08).translate(0, 0, 2.9).color('#c83a2a').mat(MAT.PAINT));
    g.add(Geo.cone(0.95, 0.9, 4).rotateZ(Math.PI / 4).scale(1, 1.25, 1).translate(0, 0, 2.98).color('#c83a2a').mat(MAT.CANVAS).tag(2));
    g.add(boxAt(0.68, -0.55, 1.75, 0.74, 0.55, 2.45).color('#120c08').mat(MAT.PAINT));
    g.add(cbox(0.25, 1.3, 0.08, 0.02).translate(0.82, 0, 1.72).color('#e8c040').mat(MAT.PAINT));
    // Mr Punch himself, and the crocodile
    g.add(Geo.sphere(0.1, 8, 6).translate(0.78, -0.2, 1.98).color('#e8a888').mat(MAT.SKIN).tag(1));
    g.add(Geo.cone(0.07, 0.22, 6).translate(0.78, -0.2, 2.06).color('#c83a2a').mat(MAT.CLOTH));
    g.add(Geo.cylinder(0.09, 0.25, 6).translate(0.78, -0.2, 1.72).color('#c83a2a').mat(MAT.CLOTH));
    g.add(Geo.sphere(0.07, 6, 4).scale(2.2, 1, 0.8).translate(0.8, 0.25, 1.92).color('#3a8a3a').mat(MAT.CLOTH));
    g.add(signGeo('PUNCH & JUDY', 0.72, 0, 2.7, 1, 0, 0.18, 1));
    const kids = new Geo();
    for (let i = 0; i < 9; i++) {
      const p = personGeo(rand, 2, { child: true });
      kids.add(p.transform(m4.mul(m4.translation(3.0 + (i % 3) * 0.75 + rand() * 0.2, -1.0 + Math.floor(i / 3) * 0.75 + rand() * 0.2, -0.4), m4.rotationZ(Math.PI / 2))));
    }
    for (let i = 0; i < 3; i++) kids.add(personGeo(rand, 1).transform(m4.mul(m4.translation(5.6 + rand(), -1.2 + i * 1.1, 0), m4.rotationZ(Math.PI / 2))));
    b.static(g, { transform: m4.mul(m4.translation(bx, by, DECK), m4.rotationZ(0)) });
    b.static(kids, { transform: m4.translation(bx, by, DECK), solid: false });
  }
  // A queue for the big wheel, in the railed lane from its ticket booth to
  // the boarding steps, and an ice-cream cart with its customers near Punch
  // and Judy (static people: a mesh each, so that they differ).
  {
    const qr = rng(13579), crowd = new Geo();
    const a = [-251.3, -10.3], z = [-257.5, -21.5], dir = Math.atan2(z[1] - a[1], z[0] - a[0]) - Math.PI / 2;
    for (let i = 0; i < 7; i++) {
      const u = 0.12 + i * 0.12;
      const M = m4.mul(m4.translation(lerp(z[0], a[0], u) + (qr() - 0.5) * 0.3, lerp(z[1], a[1], u) + (qr() - 0.5) * 0.3, DECK), m4.rotationZ(dir + (qr() - 0.5) * 0.5));
      crowd.add(personGeo(qr, 1, { child: qr() < 0.3 }).transform(M));
    }
    const cart = new Geo(), cx = -265, cy = 9.6;
    cart.add(cbox(1.6, 0.9, 0.9, 0.06).translate(0, 0, 0.75).color('#f4f0e6').mat(MAT.PAINT));
    cart.add(signGeo('ICES', 0, -0.46, 0.85, 0, -1, 0.3, 0).color('#c8402a'));
    for (const s of [-1, 1]) cart.add(Geo.cylinder(0.32, 0.06, 12).rotateY(Math.PI / 2).translate(s * 0.83, 0, 0.32).color('#2a2a2a').mat(MAT.WHEEL));
    cart.add(rod([0, 0, 1.2], [0, 0, 2.3], 0.025, 4).color('#d8d8d0').mat(MAT.STEEL));
    cart.add(Geo.cone(1.1, 0.45, 8).translate(0, 0, 2.2).color('#e8c040').mat(MAT.CANVAS).tag(2));
    cart.add(personGeo(qr, 1, { coat: '#f4f0e6' }).rotateZ(Math.PI).translate(0, 0.75, 0));
    b.static(cart, { transform: m4.translation(cx, cy, DECK), solid: false });
    for (const [dx, dy, r] of [[-0.4, -1.3, 0.1], [0.5, -1.5, -0.3], [1.2, -2.2, 0.6], [-1.3, -2.0, -0.5]]) {
      crowd.add(personGeo(qr, 1, { child: qr() < 0.4 }).transform(m4.mul(m4.translation(cx + dx, cy + dy, DECK), m4.rotationZ(r))));
    }
    b.static(crowd, { solid: false });
  }
  // the balloon seller, near the head of the walkway
  {
    const g = personGeo(rand, 1, { coat: '#2a5a8a' });
    const bal = ['#ff3a3a', '#3a7aff', '#ffd83a', '#3acc5a', '#ff7ad8', '#ffffff', '#ff9a2a'];
    for (let k = 0; k < 11; k++) {
      const a = k * 2.4, r = 0.25 + 0.2 * (k % 3);
      const top = [0.3 + r * Math.cos(a), 0.2 + r * Math.sin(a), 2.7 + 0.35 * (k % 4)];
      g.add(rod([0.3, 0.2, 1.0], top, 0.004, 3).color('#e0e0e0').mat(MAT.STEEL));
      g.add(Geo.sphere(0.2, 8, 6).scale(1, 1, 1.15).translate(top[0], top[1], top[2] + 0.22).color(bal[k % bal.length]).gloss(0.7).mat(MAT.PAINT));
    }
    b.static(g, { transform: m4.mul(m4.translation(-240, -10, DECK), m4.rotationZ(Math.PI * 0.4)), solid: false, within: 250 });
  }
  // a test-your-strength machine: a tall board with a scale, a slider and a bell
  {
    const g = new Geo();
    g.add(cbox(0.5, 0.25, 6.0, 0.03).translate(0, 0, 3.0).color('#c83a2a').mat(MAT.PAINT));
    g.add(signGeo('TRY YOUR STRENGTH', 0, -0.13, 3.6, 0, -1, 0.16, 1).rotateY(0));
    g.add(Geo.sphere(0.22, 10, 6).translate(0, 0, 6.2).color('#e8c040').gloss(0.8).mat(MAT.IRON));
    g.add(cbox(0.8, 0.8, 0.3, 0.04).translate(0, -0.5, 0.15).color('#3a3a3a').mat(MAT.PAINT));
    g.add(cbox(0.2, 0.12, 0.2, 0.03).translate(0, -0.15, 1.6).color('#e8e2d4').mat(MAT.PAINT));
    const man = personGeo(rand, 1, { coat: '#3a3a3a' });
    man.add(rod([0.25, 0.1, 1.0], [0.3, 0.6, 2.0], 0.025, 4).color('#6a4a2a').mat(MAT.WOOD));
    man.add(cbox(0.14, 0.32, 0.14, 0.03).translate(0.3, 0.6, 2.05).color('#2a2a2a').mat(MAT.STEEL));
    g.add(man.transform(m4.mul(m4.translation(0, -1.4, 0), m4.rotationZ(0))));
    b.static(g, { transform: m4.mul(m4.translation(-246, -24, DECK), m4.rotationZ(Math.PI / 2)) });
  }
  // gulls perched on railing posts round the head and along the neck
  const perched = [];
  for (let i = 0; i < 26; i++) {
    const onHead2 = i % 2 === 0;
    const x = onHead2 ? HEAD.x0 + rand() * (HEAD.x1 - HEAD.x0) : -40 - rand() * 180;
    const y = onHead2 ? (rand() < 0.5 ? -1 : 1) * HEAD.hw : (rand() < 0.5 ? -1 : 1) * NECK.hw;
    perched.push(m4.mul(m4.translation(x, y, DECK + RAIL_H + 0.06), m4.rotationZ(rand() * TAU)));
  }
  const gull = new Geo();
  gull.add(Geo.sphere(0.11, 7, 5).scale(0.9, 1.8, 0.9).translate(0, 0, 0.14).color('#f4f4f0').mat(MAT.PAINT));
  gull.add(Geo.sphere(0.06, 6, 4).translate(0, 0.17, 0.27).color('#f4f4f0').mat(MAT.PAINT));
  gull.add(Geo.cone(0.018, 0.07, 4).rotateX(-Math.PI / 2).translate(0, 0.22, 0.27).color('#e8b040').mat(MAT.PAINT));
  for (const s of [-1, 1]) gull.add(Geo.sphere(0.08, 5, 3).scale(0.3, 2.0, 0.5).translate(s * 0.09, -0.04, 0.17).color('#a8acb2').mat(MAT.PAINT));
  for (const s of [-1, 1]) gull.add(rod([s * 0.03, 0, 0.06], [s * 0.03, 0, -0.03], 0.008, 3).color('#e8b040').mat(MAT.PAINT));
  b.instances(gull, perched, { solid: false, within: 150 });
}

// ---------------------------------------------------------------------------
// things that tell the tide and the time: tide boards on the piles (black
// and white metre scales the water climbs), a floral clock on the promenade,
// and a line of channel buoys into the harbour whose lights flash one after
// another out to sea (each 0.6 s after the one inside it, every 6 s).

const BUOYS = (() => {
  const out = [];
  for (let k = 0; k < 7; k++) {
    const u = k / 6;
    const x = lerp(-215, -620, u), y = lerp(318, 210, u) + 40 * Math.sin(u * 3);
    for (const s of [-1, 1]) out.push({ x: x + s * 14 * 0.26, y: y + s * 14, k, red: s > 0 });
  }
  return out;
})();

function tideThings(b) {
  // tide boards: a board on a pile every 36 m along the south side of the neck, marked in metres
  const boards = new Geo();
  for (let x = -66; x > NECK.x0 + 10; x -= 36) {
    const px = x - ((x + 3) % 9 + 9) % 9, py = -6.2 - 0.22;     // on the outer pile of the nearest bent
    const z0 = Math.max(seabedZ(px, py) + 0.2, -3), z1 = 3.0;
    const g = panel(px, py, 0, -1, 0.32, z0, z1);
    g.uv[1] = z0; g.uv[3] = z0; g.uv[5] = z1; g.uv[7] = z1;   // v = height above mean sea level
    boards.add(g);
  }
  b.static(boards.color('#f0f0f0').mat(MAT.BOARD).tag(3), { solid: false });
  // the floral clock: a sloping bed of flowers on the promenade by the pier, facing the pier
  {
    const x = 9, y = -27, r = 4.2;
    const g = new Geo();
    const face = Geo.disc(r, 40);
    g.add(face.color('#3a6a2a').mat(MAT.CLOCK).tag(2));
    g.add(Geo.torus(r + 0.15, 0.22, 40, 6).color('#8a8478').mat(MAT.STONE));
    const M = m4.mul(m4.translation(x, y, DECK + 1.9), m4.rotationZ(-Math.PI / 2), m4.rotationX(0.42));
    b.static(g.transform(M), { solid: false });
    // the bank under it: a slanting drum of turf down into the ground
    const bank = Geo.cylinder(r + 0.35, 4, 40, { caps: false }).translate(0, 0, -4.02).color('#3a5a2a').mat(MAT.WOOD);
    b.static(bank.transform(M), { solid: false });
    b.static(signGeo('FLORAL CLOCK', x - 5.215, y, DECK + 0.45, -1, 0, 0.25, 1), { solid: false });
    b.static(cbox(0.1, 2.6, 0.45, 0.02).translate(x - 5.15, y, DECK + 0.45).color('#1e3a2a').mat(MAT.PAINT), { solid: false });
  }
  // the channel buoys, riding the tide with a slow bob
  const buoy = new Geo();
  buoy.add(Geo.cylinder(0.6, 1.4, 6, { r2: 0.45, caps: false }).translate(0, 0, -0.6).color('#ffffff').mat(MAT.PAINT));
  buoy.add(Geo.cone(0.4, 1.6, 6).translate(0, 0, 0.8).color('#ffffff').mat(MAT.PAINT));
  const lamp = Geo.sphere(0.18, 5, 3).translate(0, 0, 2.55).color('#ffffff').mat(MAT.LAMP).tag(5);
  for (const bu of BUOYS) {
    const g = buoy.clone().color(bu.red ? '#c8302a' : '#2a8a3a');
    g.add(lamp.clone().color(bu.red ? '#ff3020' : '#30ff60').aux(bu.k / 6 * 2 - 1));
    const ph = bu.k * 1.3 + (bu.red ? 0.5 : 0);
    // riding the tide (on the sea surface's own keys), and bobbing and
    // rocking on the swell meanwhile: a round of 6 s, eight poses
    const tf = (t) => m4.translation(bu.x, bu.y, tideZ(t));
    const swell = (u) => m4.mul(m4.translation(0, 0, 0.15 * Math.sin(TAU * u + ph)), m4.rotationX(0.12 * Math.sin(TAU * u + ph + 1)), m4.rotationY(0.1 * Math.sin(TAU * u + ph + 2.2)));
    b.dynamic(g, { times: timeRange(0, P, P / 8), transform: tf, caps: 'none', within: 700, cycle: { period: 6, keys: 8, transform: swell } });
  }
}

// ---------------------------------------------------------------------------
// detail for the visitor who walks round: the stalls of the pier head with
// their prizes and stallholders, ticket booths with price boards, enamel
// signs on the railings, the stations' signals, benches and fare boards.
// Small parts are given with `within`, so that they cost nothing from afar.

// a stall: counter, back and side walls, a striped canopy, a name board;
// origin at the middle of the counter's front, facing +y
function stallGeo(name, price, canvasHex, W = 6.4) {
  const g = new Geo(), D = 2.8;
  const wood = (geo, hex = '#e8dcc0') => geo.color(hex).mat(MAT.PAINT).tag(10);
  g.add(wood(boxAt(-W / 2, -0.55, 0, W / 2, 0, 1.0), canvasHex));
  g.add(wood(boxAt(-W / 2 - 0.05, -0.65, 1.0, W / 2 + 0.05, 0.08, 1.07), '#6b4a2e'));
  g.add(panel(0, -D, 0, 1, W, 0, 2.7).color('#3a2a3a').mat(MAT.PAINT).tag(10));
  for (const s of [-1, 1]) g.add(panel(s * W / 2, -D / 2, -s, 0, D, 0, 2.7).color('#e8dcc0').mat(MAT.PAINT).tag(10).doubleSided());
  for (const s of [-1, 1]) g.add(wood(boxAt(s * W / 2 - 0.08, -0.1, 0, s * W / 2 + 0.08, 0.06, 2.75), '#c8a040'));
  // the canopy, sloping out over the counter, striped (uv across)
  const q = Geo.quad([-W / 2 - 0.2, -D, 2.95], [W / 2 + 0.2, -D, 2.95], [W / 2 + 0.2, 0.9, 2.55], [-W / 2 - 0.2, 0.9, 2.55]);
  if (q.n[2] < 0) q.flip();
  for (let i = 0; i < 4; i++) q.uv[i * 2] = [0, W * 1.2, W * 1.2, 0][i];
  g.add(q.color(canvasHex).mat(MAT.CANVAS).tag(3).doubleSided());
  g.add(panel(0, 0.9, 0, 1, W + 0.4, 2.2, 2.55).color(canvasHex).mat(MAT.LATTICE).tag(1).doubleSided().cutout());
  // a row of bulbs along the foot of the valance (a bulb every 0.4 m), which
  // lights the stall and the deck in front of it (see stallLight)
  g.add(Geo.box(W + 0.2, 0.05, 0.06).translate(0, 0.96, 2.19).color('#f0e8d0').mat(MAT.RIMLIGHT).tag(9));
  // name board on the canopy's front, a price board on the counter
  g.add(wood(boxAt(-W / 2 + 0.3, 0.92, 2.6, W / 2 - 0.3, 0.98, 3.25), '#1e2a4a'));
  g.add(signGeo(name, 0, 1.0, 2.93, 0, 1, 0.42, 1));
  g.add(wood(boxAt(W / 2 - 1.4, 0.0, 1.07, W / 2 - 0.2, 0.05, 1.47), '#f4f0e6'));
  g.add(signGeo(price, W / 2 - 0.8, 0.06, 1.27, 0, 1, 0.16, 0).color('#1a1a1a'));
  return g;
}
// prizes on shelves at the back of a stall: rows of teddies, dolls and goldfish bags
function prizeShelves(W, rand) {
  const g = new Geo(), D = 2.8;
  const cols = ['#c8402a', '#e8c040', '#3a8ae8', '#f0a0c0', '#8a5a3a', '#f4f4f0', '#3ac87a'];
  for (const z of [1.3, 1.85, 2.35]) {
    g.add(boxAt(-W / 2 + 0.1, -D + 0.02, z - 0.04, W / 2 - 0.1, -D + 0.32, z).color('#6b4a2e').mat(MAT.WOOD));
    for (let x = -W / 2 + 0.35; x < W / 2 - 0.3; x += 0.38 + rand() * 0.12) {
      const c = rand.pick(cols), s = 0.8 + rand() * 0.5;
      if (rand() < 0.65) {
        // a teddy: body, head, ears
        g.add(Geo.sphere(0.1 * s, 6, 4).scale(1, 0.9, 1.1).translate(x, -D + 0.2, z + 0.1 * s).color(c).mat(MAT.CLOTH));
        g.add(Geo.sphere(0.075 * s, 6, 4).translate(x, -D + 0.22, z + 0.25 * s).color(c).mat(MAT.CLOTH));
        for (const e of [-1, 1]) g.add(Geo.sphere(0.03 * s, 4, 3).translate(x + e * 0.05 * s, -D + 0.22, z + 0.31 * s).color(c).mat(MAT.CLOTH));
      } else {
        // a goldfish in a bag of water
        g.add(Geo.sphere(0.09, 6, 4).scale(1, 1, 1.25).translate(x, -D + 0.2, z + 0.11).color('#c8e0e8').mat(MAT.GLASS).tag(1).gloss(0.9));
        g.add(Geo.sphere(0.025, 4, 3).scale(1.6, 1, 1).translate(x, -D + 0.17, z + 0.1).color('#ff7a1a').mat(MAT.PAINT));
      }
    }
  }
  return g;
}
function stalls(b) {
  const rand = rng(4711);
  const defs = [
    { x: -268, y: 31, f: -1, name: 'HOOK-A-DUCK', price: 'A PRIZE EVERY TIME 50p', hex: '#2a6ac8', kind: 'duck' },
    { x: -277, y: 31, f: -1, name: 'CANDY FLOSS & ROCK', price: 'ROCK 80p', hex: '#e87ab8', kind: 'rock' },
    { x: -286, y: 31, f: -1, name: 'MADAME ZELDA', price: 'PALMS READ £1', hex: '#7a3d7a', kind: 'fortune' },
    { x: -276, y: -31, f: 1, name: 'RIFLE RANGE', price: '5 SHOTS 50p', hex: '#c8402a', kind: 'rifle' },
    { x: -285, y: -31.2, f: 1, name: 'COCONUT SHY', price: '3 BALLS 50p', hex: '#3a9a5a', kind: 'shy' },
  ];
  for (const d of defs) {
    const M = m4.mul(m4.translation(d.x, d.y, DECK), m4.rotationZ(d.f > 0 ? 0 : Math.PI));
    b.static(stallGeo(d.name, d.price, d.hex, 7.2).transform(M));
    const near = new Geo();
    if (d.kind === 'duck') {
      // a trough of water round the counter with ducks bobbing in it (still, here)
      near.add(boxAt(-3.2, -0.5, 1.07, 3.2, -0.05, 1.12).color('#2a6ac8').mat(MAT.GLASS).tag(1).gloss(0.9));
      for (let i = 0; i < 16; i++) {
        const x = -3 + i * 0.4;
        near.add(Geo.sphere(0.06, 6, 4).scale(1.2, 1, 0.8).translate(x, -0.28, 1.15).color('#ffd83a').mat(MAT.PAINT).gloss(0.6));
        near.add(Geo.sphere(0.035, 5, 3).translate(x + 0.05, -0.28, 1.22).color('#ffd83a').mat(MAT.PAINT).gloss(0.6));
        near.add(rod([x - 0.02, -0.28, 1.15], [x - 0.02, -0.28, 1.27], 0.004, 3).color('#cccccc').mat(MAT.STEEL));
      }
      for (const x of [-2, 2]) near.add(rod([x, -0.2, 1.07], [x + 0.6, 0.4, 1.9], 0.012, 3).color('#6b4a2e').mat(MAT.WOOD));
      near.add(prizeShelves(7.2, rand));
    } else if (d.kind === 'rock') {
      // sticks of rock standing in jars, and bags of candy floss hanging from the canopy
      for (let i = 0; i < 40; i++) {
        const x = -3.2 + (i % 20) * 0.32, z = 1.07, yy = -0.25 - Math.floor(i / 20) * 0.15;
        near.add(Geo.cylinder(0.018, 0.28, 5).translate(x, yy, z).color(i % 3 ? '#f8b0c8' : '#f4f4f0').mat(MAT.PAINT).gloss(0.5));
      }
      for (let i = 0; i < 9; i++) {
        const x = -3 + i * 0.75;
        near.add(rod([x, 0.5, 2.6], [x, 0.5, 2.25], 0.004, 3).color('#e0e0e0').mat(MAT.STEEL));
        near.add(Geo.sphere(0.17, 7, 5).scale(1, 1, 1.3).translate(x, 0.5, 2.08).color(i % 2 ? '#f8b0d8' : '#b8d8f8').mat(MAT.CLOTH));
      }
      near.add(boxAt(-3.4, -2.6, 0.9, 3.4, -2.3, 2.4).color('#f4f0e6').mat(MAT.PAINT));
    } else if (d.kind === 'fortune') {
      // a curtained booth: a table with a crystal ball, a lamp, and the fortune teller
      near.add(Geo.cylinder(0.45, 0.75, 10).translate(0, -1.5, 0).color('#4a1a4a').mat(MAT.CLOTH));
      near.add(Geo.sphere(0.13, 10, 8).translate(0, -1.5, 0.88).color('#c8e0f8').mat(MAT.GLASS).tag(1).gloss(0.95));
      near.add(personGeo(rand, 2, { coat: '#5a1a5a' }).transform(m4.mul(m4.translation(0, -2.2, 0), m4.rotationZ(0))));
      near.add(panel(-2.2, -0.15, 0, 1, 2.8, 0.0, 2.7).color('#7a2a6a').mat(MAT.CLOTH).doubleSided());
      near.add(panel(2.2, -0.15, 0, 1, 2.8, 0.0, 2.7).color('#7a2a6a').mat(MAT.CLOTH).doubleSided());
    } else if (d.kind === 'rifle') {
      // targets on the back wall and rifles chained to the counter
      for (let i = 0; i < 12; i++) {
        const x = -3 + (i % 6) * 1.2, z = 1.4 + Math.floor(i / 6) * 0.65;
        near.add(Geo.disc(0.22, 14).rotateX(Math.PI / 2).rotateZ(Math.PI).translate(x, -2.76, z).color('#ffffff').mat(MAT.CLOCK).tag(3));
      }
      for (const x of [-2.4, -0.8, 0.8, 2.4]) {
        near.add(Geo.box(0.05, 0.85, 0.08).transform(m4.mul(m4.translation(x, -0.25, 1.13), m4.rotationX(0.05))).color('#3a2a1a').mat(MAT.WOOD));
        near.add(rod([x, 0.15, 1.13], [x, -0.55, 1.13], 0.012, 4).color('#2a2a2a').mat(MAT.STEEL));
      }
    } else if (d.kind === 'shy') {
      // posts with coconuts in cups, and a bucket of balls
      for (let i = 0; i < 6; i++) {
        const x = -2.8 + i * 1.12;
        near.add(rod([x, -2.3, 0], [x, -2.3, 1.45], 0.03, 5).color('#c8a060').mat(MAT.WOOD));
        near.add(Geo.cylinder(0.07, 0.06, 6, { r2: 0.1 }).translate(x, -2.3, 1.45).color('#c8a060').mat(MAT.WOOD));
        near.add(Geo.sphere(0.1, 7, 5).translate(x, -2.3, 1.6).color('#5a3a20').mat(MAT.WOOD));
      }
      near.add(Geo.cylinder(0.16, 0.3, 8, { r2: 0.2 }).translate(2.6, -0.3, 1.07).color('#c8402a').mat(MAT.PAINT));
      for (let i = 0; i < 6; i++) near.add(Geo.sphere(0.04, 5, 3).translate(2.55 + (i % 3) * 0.06, -0.3 + Math.floor(i / 3) * 0.06, 1.38).color('#f4f4f0').mat(MAT.CLOTH));
      near.add(panel(0, -0.4, 0, -1, 7, 0, 1.0).color('#3a9a5a').mat(MAT.PAINT));
    }
    // the stallholder behind the counter
    if (d.kind !== 'fortune') near.add(personGeo(rand, 1, { coat: rand.pick(['#f4f0e6', '#2a2a2a', '#c8402a']) }).transform(m4.mul(m4.translation(-1.5, -1.1, 0), m4.rotationZ(0))));
    b.static(near.transform(M), { within: 80, solid: false });
  }
  // ticket booths for the wheel and the swing ride, with price boards
  for (const [x, y, rot, name] of [[-250, -8.5, -Math.PI / 2, 'BIG WHEEL'], [-253, 10.6, Math.PI, 'CHAIR-O-PLANES']]) {
    const M = m4.mul(m4.translation(x, y, DECK), m4.rotationZ(rot));
    const g = new Geo();
    g.add(cbox(1.6, 1.4, 2.3, 0.04).translate(0, 0, 1.15).color('#c8402a').mat(MAT.PAINT));
    g.add(Geo.cone(1.2, 0.6, 4).rotateZ(Math.PI / 4).translate(0, 0, 2.3).color('#e8c040').mat(MAT.PAINT));
    g.add(panel(0, 0.71, 0, 1, 1.0, 1.0, 1.7, true).mat(MAT.GLASS));
    g.add(boxAt(-0.6, 0.7, 0.95, 0.6, 0.95, 1.0).color('#6b4a2e').mat(MAT.WOOD));
    g.add(signGeo('TICKETS', 0, 0.72, 1.95, 0, 1, 0.22, 1));
    b.static(g, { transform: M });
    const near = new Geo();
    near.add(boxAt(0.85, -0.4, 0.4, 0.9, 0.6, 1.9).color('#f4f0e6').mat(MAT.PAINT));
    near.add(signGeo(name, 0.92, 0.1, 1.72, 1, 0, 0.14, 0).color('#1a1a1a'));
    near.add(signGeo('ADULTS £2', 0.92, 0.1, 1.38, 1, 0, 0.14, 0).color('#1a1a1a'));
    near.add(signGeo('CHILDREN £1', 0.92, 0.1, 1.08, 1, 0, 0.14, 0).color('#1a1a1a'));
    near.add(signGeo('NEXT RIDE', 0.92, 0.1, 0.75, 1, 0, 0.12, 2));
    near.add(personGeo(rand, 2, { coat: '#2a4a8a' }).transform(m4.mul(m4.translation(0, -0.2, -0.05), m4.rotationZ(0))));
    b.static(near, { transform: M, within: 60, solid: false });
  }
  // boards to read: opening hours at the gate, a price list at the ice-cream
  // kiosk with its attendant, and posters by the pavilion's doors
  const rd = new Geo();
  const board = (x, y, nx, ny, w, h, z, lines, hex = '#1e2a4a', style = 1) => {
    rd.add(panel(x - nx * 0.03, y - ny * 0.03, nx, ny, w, z - h / 2, z + h / 2).color(hex).mat(MAT.PAINT));
    lines.forEach((t, i) => rd.add(signGeo(t, x + nx * 0.01, y + ny * 0.01, z + h / 2 - (i + 0.8) * h / (lines.length + 0.6), nx, ny, Math.min(0.14, h / (lines.length + 1.5)), style)));
  };
  board(-3.6, -2.4, 1, 0, 1.2, 0.9, DECK + 1.6, ['PIER OPEN', '9 AM - 11 PM', 'ADMISSION FREE']);
  board(-3.6, 2.4, 1, 0, 1.2, 0.9, DECK + 1.6, ['FIREWORKS', 'EVERY NIGHT', 'FROM DUSK']);
  board(-80.5, 4.4 + 1.05, 0.6, 0.8, 0.8, 0.7, DECK + 1.5, ['CORNETS 50p', 'WAFERS 60p', 'LOLLIES 40p'], '#f4f0e6', 0);
  board(-302.65, -4.5, 1, 0, 1.0, 1.4, DECK + 1.6, ['TONIGHT', 'THE SUMMER', 'SHOW', '8 PM'], '#7a1a2a');
  board(-302.65, 4.5, 1, 0, 1.0, 1.4, DECK + 1.6, ['TEA DANCE', 'SUNDAYS', '3 PM'], '#1a4a3a');
  rd.add(personGeo(rand, 1, { coat: '#f4f0e6' }).transform(m4.mul(m4.translation(-83.0, 4.4, DECK), m4.rotationZ(-Math.PI / 2))));
  b.static(rd, { within: 60, solid: false });
  // enamel signs on the railings of the neck, and a few on the head
  const texts = ['NO FISHING FROM THIS SIDE', 'NO CYCLING ON THE PIER', 'PLEASE DO NOT FEED THE GULLS', 'DANGER - DEEP WATER', 'PIER HEAD AND PAVILION', 'PLEASE USE THE LITTER BINS', 'LIFEBELT - FOR EMERGENCY USE'];
  const plates = new Geo();
  let n = 0;
  for (let x = -48; x > NECK.x0 + 8; x -= 33) {
    for (const s of [-1, 1]) {
      if (s < 0 && x > -40) continue;
      const t = texts[n++ % texts.length];
      const y = s * (NECK.hw - 0.1);
      plates.add(boxAt(x - 0.55, y - 0.02, DECK + 0.55, x + 0.55, y + 0.02, DECK + 0.85).translate(0, -s * 0.02, 0).color('#1e3a8a').mat(MAT.PAINT).gloss(0.8));
      plates.add(signGeo(t, x, y - s * 0.05, DECK + 0.7, 0, -s, 0.1, 0).color('#f4f4f0'));
    }
  }
  b.static(plates, { within: 70, solid: false });
  // the stations: platform edges, benches, fare and timetable boards, and a signal at each end
  // that shows green from just before a train leaves until it has gone (both stations send
  // one off every 45 s, at 4 s past)
  const benchSpots = [], sigs = [], boards = new Geo();
  for (const [k, xc] of STATION_X.entries()) {
    boards.add(boxAt(xc - 14, TRACK_Y[1] - 1.08, DECK + 0.35, xc + 14, TRACK_Y[1] - 0.98, DECK + 0.36).color('#f0f0e8').mat(MAT.PAINT));
    for (const dx of [-8, 0, 8]) benchSpots.push(m4.mul(m4.translation(xc + dx, -NECK.hw + 0.75, DECK + 0.35), m4.rotationZ(0)));
    const bx = xc + (k ? 9 : -9), by = -NECK.hw + 0.1;
    boards.add(boxAt(bx - 1.0, by - 0.03, DECK + 1.3, bx + 1.0, by + 0.03, DECK + 2.2).color('#1e2a4a').mat(MAT.PAINT));
    boards.add(signGeo('PIER RAILWAY', bx, by + 0.04, DECK + 2.05, 0, 1, 0.12, 1));
    boards.add(signGeo('SINGLE 50p', bx, by + 0.04, DECK + 1.82, 0, 1, 0.12, 1));
    boards.add(signGeo('RETURN 80p', bx, by + 0.04, DECK + 1.62, 0, 1, 0.12, 1));
    boards.add(signGeo('EVERY FEW MINUTES', bx, by + 0.04, DECK + 1.42, 0, 1, 0.1, 1));
    for (const [ty, dx] of [[TRACK_Y[0], k ? 15.5 : -15.5], [TRACK_Y[1], k ? 15.5 : -15.5]]) sigs.push([xc + dx, ty + (ty === TRACK_Y[0] ? 0.95 : -0.95)]);
  }
  b.instances(benchGeo(), benchSpots, { solid: false, within: 120 });
  b.static(boards, { within: 90, solid: false });
  const sig = new Geo();
  sig.add(Geo.cylinder(0.05, 2.6, 6).color('#2a2a2a').mat(MAT.IRON));
  sig.add(cbox(0.22, 0.12, 0.55, 0.03).translate(0, 0, 2.6).color('#1a1a1a').mat(MAT.IRON));
  sig.add(Geo.sphere(0.06, 6, 4).translate(0, 0.07, 2.75).color('#ff2a1a').mat(MAT.LAMP).tag(6));
  sig.add(Geo.sphere(0.06, 6, 4).translate(0, 0.07, 2.47).color('#2aff6a').mat(MAT.LAMP).tag(7));
  b.instances(sig, sigs.map(([x, y]) => m4.mul(m4.translation(x, y, DECK), m4.rotationZ(x < -100 ? -Math.PI / 2 : Math.PI / 2))), { within: 150 });
}

// detail on the trains, from near by: bogies, couplings, the car's number,
// a driver in the cab
function trainDetail(motor, front, number, rand) {
  const g = new Geo();
  const L = 6.2, W = 1.75;
  for (const y of [-L / 2 + 1.1, L / 2 - 1.1]) g.add(boxAt(-W / 2 + 0.1, y - 0.55, 0.12, W / 2 - 0.1, y + 0.55, 0.3).color('#222222').mat(MAT.STEEL));
  for (const s of [-1, 1]) {
    g.add(Geo.box(0.12, 0.3, 0.1).translate(0, s * (L / 2 + 0.12), 0.4).color('#1a1a1a').mat(MAT.STEEL));
    g.add(signGeo(String(number), s * (W / 2 + 0.012), -L / 2 + 0.5, 0.95, s, 0, 0.16, 1));
  }
  if (motor) {
    const sgn = front ? 1 : -1;
    g.add(personGeo(rand, 3, { coat: '#1e2a4a' }).transform(m4.mul(m4.translation(0, sgn * (L / 2 - 0.9), 0.62), m4.rotationZ(front ? 0 : Math.PI))));
    g.add(Geo.cylinder(0.07, 0.12, 6).rotateX(Math.PI / 2).translate(0.45, sgn * (L / 2 + 0.02), 2.0).color('#ff2a1a').mat(MAT.LAMP).tag(4));
  }
  return g;
}

// ---------------------------------------------------------------------------
// shader

// The built-in day and night, with two changes: the hours are warped (slow
// at dusk and dawn) and the sun's path is turned so that it sets in the
// west-north-west.
// (`own` leaves those two functions to this scene; the built-in ones are there as envDayPhase0 and envSunVec0)
const envBase = dayNightEnv({ dayLength: DAY, startHour: PH0 * 24, sunTilt: 0.5, fog: 0.0012, clouds: 0.38, zenith: '#3a74c4', horizon: '#c8d8e4', own: ['envDayPhase', 'envSunVec'] });
const wgsl = envBase + /* wgsl */ `
fn envDayPhase(t: f32) -> f32 {
  let ph = envDayPhase0(t);
  return fract(ph + ${f(WARP / (4 * Math.PI))} * sin(4.0 * PI * (ph - ${f(PHS)})));
}
fn envSunVec(t: f32) -> vec3f {
  let s = envSunVec0(t);
  return vec3f(s.x * ${f(Math.cos(SUN_AZ))} - s.y * ${f(Math.sin(SUN_AZ))}, s.x * ${f(Math.sin(SUN_AZ))} + s.y * ${f(Math.cos(SUN_AZ))}, s.z);
}
const TIDE_A = ${f(TIDE_A)};
const TIDE_W = ${f(TAU / TIDE_T)};
const DECKZ = ${f(DECK)};
const NLINES = ${f(LETTER_LINES)};

fn sstep(a: f32, b: f32, x: f32) -> f32 { return smoothstep(a, b, x); }
fn tideZ(t: f32) -> f32 { return TIDE_A * sin(TIDE_W * t); }
fn hourOf(t: f32) -> f32 { return envDayPhase(t) * 24.0; }
// 0 by day .. 1 at night (when the lamps are on and the fireworks show)
fn nightOf(t: f32) -> f32 { return 1.0 - smoothstep(-0.16, 0.0, envSunVec(t).z); }
fn duskOf(t: f32) -> f32 { return 1.0 - smoothstep(-0.05, 0.12, envSunVec(t).z); }

fn sandBase(x: f32) -> f32 {
  if (x > -170.0) { return 3.0 + x / 26.0; }
  return max(-14.0, 3.0 - 170.0 / 26.0 + (x + 170.0) / 45.0);
}
fn sandAt(p: vec2f) -> f32 {
  return sandBase(p.x) + 0.55 * exp(-pow((p.x + 150.0) / 16.0, 2.0)) * (0.75 + 0.25 * sin(p.y / 61.0));
}

// ---- lettering
fn letterDist(s: Surface) -> f32 {
  let v = (f32(s.tag) + clamp(s.uv.y, 0.0, 1.0)) / NLINES;
  return letters(vec2f(s.uv.x, v)).r * 2.4;
}

// ---- the sea: swell and wind waves running in towards the shore (+x), a
// shallow tint and breaking foam where the water is shallow
struct Wave { h: f32, g: vec2f };
fn waveSum(p: vec2f, t: f32, fine: f32) -> Wave {
  var w: Wave;
  w.h = 0.0; w.g = vec2f(0.0);
  // (direction, wavelength, height) of a few trains; speed from deep water
  var dirs = array<vec2f, 5>(vec2f(1.0, 0.0), vec2f(0.94, 0.34), vec2f(0.92, -0.39), vec2f(0.6, 0.8), vec2f(0.7, -0.71));
  var lens = array<f32, 5>(46.0, 23.0, 17.0, 7.3, 4.1);
  var amps = array<f32, 5>(0.32, 0.14, 0.11, 0.045, 0.022);
  for (var i = 0; i < 5; i++) {
    let k = TAU / lens[i];
    let om = sqrt(9.81 * k);
    let a = amps[i] * select(1.0, fine, i >= 3);
    let ph = dot(dirs[i], p) * k - om * t + f32(i) * 1.7;
    w.h += a * sin(ph);
    w.g += dirs[i] * (a * k * cos(ph));
  }
  return w;
}
fn seaSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  let depth = p.z - sandAt(p.xy);
  let fine = 1.0 - smoothstep(0.08, 0.5, pf);
  let w = waveSum(p.xy, s.t, fine);
  // waves steepen and break in the shallows
  let shoal = 1.0 + 1.5 * (1.0 - smoothstep(0.5, 3.0, depth));
  var gr = w.g * shoal;
  // ripples
  if (fine > 0.0) {
    let q = p.xy * 1.7 + vec2f(s.t * 0.9, s.t * 0.3);
    gr += (vec2f(noise2(q + vec2f(0.1, 0.0)), noise2(q + vec2f(0.0, 0.1))) - noise2(q)) * 0.6 * fine;
  }
  s.n = normalize(vec3f(-gr * 0.9, 1.0));
  let deep = smoothstep(0.3, 7.0, depth);
  var col = mix(vec3f(0.10, 0.21, 0.19), vec3f(0.010, 0.033, 0.045), deep);
  col = mix(col, vec3f(0.22, 0.24, 0.20), (1.0 - smoothstep(0.0, 0.6, depth)) * 0.6);
  // foam: the breaking crests over the bar and on the beach, and a little on crests out at sea
  let crest = w.h * shoal / 0.45;
  let surf = (1.0 - smoothstep(0.3, 1.3, depth)) * smoothstep(0.35, 0.95, crest + 0.4 * noise2(p.xy * 0.4 + vec2f(s.t * 0.5, 0.0)));
  let edge = 1.0 - smoothstep(0.0, 0.12, depth + 0.06 * sin(p.y * 0.21 + s.t * 1.3));
  let foam = saturate(max(surf, edge) * (0.55 + 0.45 * noise2(p.xy * 2.3 + s.t * 0.2)));
  s.color = mix(col, vec3f(0.80, 0.83, 0.84), foam);
  s.gloss = mix(0.94, 0.25, foam);
  return s;
}

// ---- sand: dry above the last high water, dark and glossy where the tide
// has only just left it
fn sandSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  let fine = 1.0 - smoothstep(0.03, 0.25, pf);
  var col = vec3f(0.42, 0.35, 0.24) * (0.9 + 0.12 * noise2(p.xy * 0.08));
  // ripple marks below the high-water line
  let below = 1.0 - smoothstep(TIDE_A - 0.2, TIDE_A + 0.4, p.z);
  if (fine > 0.0) {
    let q = vec2f(p.x * 0.9 + noise2(p.xy * 0.3) * 1.2, p.y * 0.12);
    let rip = sin(q.x * 6.0 + q.y);
    s.n = normalize(s.n + vec3f(cos(q.x * 6.0 + q.y) * 0.12 * below * fine, 0.0, 0.0));
    col *= 1.0 + 0.05 * rip * below * fine;
    col *= mix(1.0, 0.85 + 0.3 * noise2(p.xy * 9.0), fine);
  }
  // Wet: since the falling tide left it, which it did at the same moment of
  // every tide for a given height, the sand shines and darkens, and dries
  // over a minute or so (so on a falling tide a broad wet band follows the
  // water down the beach, and on a rising one the water comes up over dry
  // sand); and always just above the water, where the waves reach.
  let tz = tideZ(s.t);
  let tLeft = (PI - asin(clamp(p.z / TIDE_A, -1.0, 1.0))) / TIDE_W;
  let age = (s.t - tLeft) - (TAU / TIDE_W) * floor((s.t - tLeft) / (TAU / TIDE_W));
  var wet = max(exp(-age / 55.0) * below, 1.0 - smoothstep(tz + 0.05, tz + 0.45, p.z));
  // The swash: each wave runs a sheet of water a few centimetres deep up the
  // sand, quickly, with a line of foam at its edge, and draws it back more
  // slowly (waves every 6.5 s, reaching 0.2 to 0.45 m above the sea's level,
  // 5 to 12 m up the beach).  Pools stand in the hollows of the lower beach.
  let ph = fract(s.t / 6.5 + p.y * 0.012 + 0.4 * noise2(vec2f(p.y * 0.03, 1.7)));
  let reach = (0.2 + 0.25 * noise2(vec2f(p.y * 0.05 + floor(s.t / 6.5 + p.y * 0.012) * 3.1, 0.3))) * select(1.0 - (ph - 0.3) / 0.7, sin(ph / 0.3 * 1.5708), ph < 0.3);
  let up = p.z - tz;
  let lobe = reach + 0.05 * (noise2(vec2f(p.y * 0.35, p.x * 0.1)) - 0.5) * smoothstep(0.0, 0.1, reach);
  let sheet = (1.0 - smoothstep(lobe - 0.015, lobe, up)) * step(0.0, up);
  let edge = (1.0 - smoothstep(0.0, 0.01, abs(up - lobe))) * step(ph, 0.45) * step(0.0, up) * smoothstep(0.3, 0.7, noise2(p.xy * vec2f(0.9, 1.6)));
  let rn = sin(p.y / 47.0 + p.x / 23.0);
  let pool = smoothstep(-0.86, -0.95, rn) * smoothstep(-15.0, -60.0, p.x) * smoothstep(-170.0, -120.0, p.x) * step(tz + 0.05, p.z);
  let water = max(sheet, pool);
  // the strand line of seaweed at the top of the last high water
  let strand = (1.0 - smoothstep(0.0, 0.12, abs(p.z - TIDE_A - 0.15 + 0.1 * noise2(p.xy * 0.2)))) * smoothstep(0.55, 0.8, noise2(p.xy * 1.7)) * 0.6;
  col = mix(col, col * vec3f(0.55, 0.52, 0.5), max(wet, water));
  col = mix(col, vec3f(0.12, 0.11, 0.06), strand * 0.7);
  col = mix(col, col * vec3f(0.75, 0.85, 0.9), water * 0.6);
  col = mix(col, vec3f(0.8, 0.83, 0.84), edge * 0.85);
  s.n = normalize(mix(s.n, vec3f(0.0, 0.0, 1.0), water));
  s.color = col;
  s.gloss = mix(mix(0.08, 0.6, wet), 0.95, water * (1.0 - edge));
  return s;
}

// ---- things with holes: railings, lattices, valances, lettering
fn cutout(s: Surface) -> f32 {
  let pfc = length(fwidth(s.pos));
  if (s.mat == ${MAT.DECK}u) {
    // the gaps between the deck's boards, open to the sea below where you
    // look down at them from near by (solid in the shadow maps, and far off)
    if (s.dist <= 0.0 || pfc > 0.02 || abs(s.n.z) < 0.5) { return 1.0; }
    let fq = fract(s.pos.x / 0.16);
    return saturate((min(fq, 1.0 - fq) * 0.16 - 0.005) / 0.003);
  }
  if (s.mat == ${MAT.RAILING}u) {
    // balusters, rails, and a band of rings near the top (uv in metres)
    let u = s.uv.x; let v = s.uv.y;
    let bal = 1.0 - smoothstep(0.012, 0.02, abs(fract(u / 0.125) - 0.5) * 0.125);
    let rails = max(step(v, 0.04), max(step(abs(v - 0.62), 0.025), step(0.86, v)));
    let cu = (fract(u / 0.25) - 0.5) * 0.25;
    let ring = 1.0 - smoothstep(0.008, 0.016, abs(length(vec2f(cu, v - 0.74)) - 0.085));
    let inBand = step(0.645, v) * step(v, 0.86);
    return max(rails, max(bal * (1.0 - inBand), ring * inBand));
  }
  if (s.mat == ${MAT.LATTICE}u) {
    let u = s.uv.x; let v = s.uv.y;
    // a swing-ride chair's two chains (a quad with uv 0..1 across)
    if (s.tag == 2u) { return saturate(1.0 - (min(u, 1.0 - u) - 0.03) * 60.0); }
    if (s.tag == 1u) {
      // a scalloped valance board with a row of small holes
      let sc = abs(fract(u / 0.32) - 0.5) * 2.0;
      let edge = 0.08 + 0.07 * sqrt(max(1.0 - sc * sc, 0.0));
      let hole = 1.0 - smoothstep(0.018, 0.026, length(vec2f((fract(u / 0.32) - 0.5) * 0.32, v - 0.16)));
      return step(edge, v) * (1.0 - hole);
    }
    // diamond lattice with chords
    let a = abs(fract((u + v) / 0.9) - 0.5) * 0.9;
    let b = abs(fract((u - v) / 0.9) - 0.5) * 0.9;
    let bar = 1.0 - smoothstep(0.03, 0.045, min(a, b));
    let h = s.uv.y;
    return max(bar, step(h, 0.05));
  }
  if (s.mat == ${MAT.SIGN}u) {
    let d = letterDist(s);
    return saturate((0.72 - d) * 3.0);
  }
  return 1.0;
}

// ---- the deck: boards laid across the pier, with dark gaps, nail heads and wear
fn deckSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  if (s.n.z < 0.5) { s.color = vec3f(0.16, 0.12, 0.09); s.gloss = 0.1; return s; }
  let q = p.x / 0.16;
  let board = floor(q);
  let fq = fract(q);
  let len = floor((p.y + hash11(board) * 7.0) / 4.1);
  let h = hash21(vec2f(board, len));
  let fd = 1.0 - smoothstep(0.004, 0.03, pf);
  let fb = 1.0 - smoothstep(0.03, 0.09, pf);     // the boards themselves fade out further off
  var col = mix(vec3f(0.40, 0.31, 0.22), mix(vec3f(0.30, 0.22, 0.15), vec3f(0.50, 0.40, 0.29), h), fb);
  col = mix(col, vec3f(0.42, 0.40, 0.37), 0.35 * noise2(vec2f(board * 0.37, p.y * 0.2)));
  // grain along the boards
  col *= mix(1.0, 0.82 + 0.3 * noise2(vec2f(fq * 3.0 + board * 7.0, p.y * 6.0)), fd);
  // gaps between boards
  let gap = 1.0 - smoothstep(0.0, 0.035 + pf * 4.0, min(fq, 1.0 - fq));
  col = mix(col, vec3f(0.02, 0.018, 0.015), gap * mix(0.12, 0.85, fb));
  // nail heads where the boards cross the joists (every 0.75 m), close by
  if (fd > 0.0) {
    let nz = vec2f((fq - 0.5) * 0.16, (fract(p.y / 0.75 + 0.5) - 0.5) * 0.75);
    let nail = 1.0 - smoothstep(0.004, 0.007, min(length(nz - vec2f(0.045, 0.0)), length(nz + vec2f(0.045, 0.0))));
    col = mix(col, vec3f(0.08, 0.07, 0.065), nail * fd);
    // gull droppings near the railings
    let edge = smoothstep(4.5, 6.3, abs(p.y)) * step(p.x, -30.0);
    let spl = smoothstep(0.82, 0.86, noise2(p.xy * 2.3)) * smoothstep(0.4, 0.6, noise2(p.xy * 11.0));
    col = mix(col, vec3f(0.75, 0.74, 0.7), spl * edge * fd * 0.8);
  }
  // wear down the middle of the walkway
  let wear = smoothstep(4.0, 0.5, abs(p.y - 2.6)) * step(p.x, -30.0) * step(-232.0, p.x);
  col = mix(col, col * 0.75 + vec3f(0.06), wear * 0.5);
  s.color = col;
  s.gloss = 0.07 + 0.05 * wear;
  s.light += lampPool(p, s.t);
  // the fairground's glow on the pier head
  if (p.x < -232.0) { s.light += vec3f(1.0, 0.75, 0.5) * 0.05 * smoothstep(0.1, 0.6, duskOf(s.t)); }
  return s;
}

// warm light from the rows of lamps along the pier (they stand every 15 m on
// both sides: the nearest of each row, worked out without a loop)
fn lampPool(p: vec3f, t: f32) -> vec3f {
  let night = nightOf(t);
  if (night <= 0.01 || p.x > -30.0 || p.x < -340.0) { return vec3f(0.0); }
  let xl = -38.0 - 15.0 * round((-38.0 - p.x) / 15.0);
  var acc = 0.0;
  for (var k = 0; k < 2; k++) {
    let y = select(-6.15, 6.15, k == 1);
    let hw = select(6.15, 35.65, p.x < -232.0);
    let yy = select(y, sign(y) * hw, p.x < -232.0);
    let d = vec3f(xl - p.x, yy - p.y, 10.5 - p.z);
    let dd = dot(d, d);
    acc += lampOn(-xl, t) * 9.0 / (dd + 4.0);
  }
  return vec3f(1.0, 0.72, 0.42) * acc * night;
}
// when a lamp along the pier is lit: at sunset (18:00) they switch on in a
// wave that runs out from the shore at 6 m/s, and at dawn they go off the
// same way.  (A lamp at distance d does what the first lamp did d / 6 s before.)
fn lampOn(along: f32, t: f32) -> f32 {
  let h = hourOf(t - along / 6.0);
  return smoothstep(18.0, 18.03, h) + 1.0 - smoothstep(5.6, 5.63, h);
}

// the clocks: hands at the hour the sky shows, at the moment the dial is seen
fn clockSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let q = s.uv - 0.5;
  let r = length(q) * 2.0;
  if (s.tag == 3u) {
    // a shooting-gallery target: red and white rings, a black bull
    let ring = fract(r * 2.5);
    s.color = select(vec3f(0.85, 0.83, 0.78), vec3f(0.6, 0.05, 0.04), ring < 0.5);
    s.color = mix(s.color, vec3f(0.02), step(r, 0.12));
    s.gloss = 0.2;
    return s;
  }
  let ang = atan2(q.x, q.y);
  let hr = hourOf(s.t);
  let hh = fract(hr / 12.0) * TAU;
  let mm = fract(hr) * TAU;
  let aa = max(pf * 1.5, 0.006);
  let tick = (1.0 - smoothstep(0.03, 0.03 + aa * 3.0, abs(fract(ang / TAU * 12.0 + 0.5) - 0.5))) * step(0.74, r) * step(r, 0.9);
  let ring = 1.0 - smoothstep(0.0, aa * 2.0, abs(r - 0.93) - 0.02);
  let dh = vec2f(sin(hh), cos(hh)); let dm = vec2f(sin(mm), cos(mm));
  let hand1 = 1.0 - smoothstep(0.04, 0.04 + aa, sdSegment(q * 2.0, -dh * 0.12, dh * 0.5));
  let hand2 = 1.0 - smoothstep(0.025, 0.025 + aa, sdSegment(q * 2.0, -dm * 0.15, dm * 0.8));
  let ink = max(max(tick, ring), max(hand1, hand2));
  let glow = smoothstep(0.2, 0.7, nightOf(s.t));
  if (s.tag == 2u) {
    // the floral clock: beds of flowers in rings, hands of painted iron
    let fl = noise2(s.pos.xy * 9.0);
    let band = floor(r * 4.0);
    var bed = select(select(vec3f(0.5, 0.05, 0.08), vec3f(0.6, 0.5, 0.05), band == 1.0), vec3f(0.3, 0.12, 0.45), band == 2.0);
    if (band >= 3.0) { bed = vec3f(0.06, 0.18, 0.05); }
    bed = mix(vec3f(0.04, 0.12, 0.03), bed, smoothstep(0.35, 0.6, fl));
    s.color = mix(bed, vec3f(0.85, 0.85, 0.8), max(tick, ring) * 0.8);
    s.color = mix(s.color, vec3f(0.03, 0.05, 0.03), max(hand1, hand2));
    s.gloss = 0.1;
    s.light += promLight(s.pos, s.t);
    return s;
  }
  s.color = mix(vec3f(0.86, 0.84, 0.76), vec3f(0.02, 0.02, 0.025), ink);
  s.emissive = glow * 1.4 * (1.0 - ink);
  s.gloss = 0.4;
  return s;
}

// the departure boards: seconds to the next train (both stations send one off every 45 s, at 4 s past)
fn boardSurf(sIn: Surface) -> Surface {
  var s = sIn;
  if (s.tag == 8u) {
    let u = s.uv.x; let v = s.uv.y;
    let colm = abs(fract(u * 4.0) - 0.5) < 0.44;
    let line = step(0.45, fract(v * 26.0)) * select(0.0, 1.0, colm) * step(v, 0.78);
    let head = step(0.84, v) * step(v, 0.95) * step(0.08, u) * step(u, 0.92);
    s.color = mix(vec3f(0.82, 0.8, 0.74), vec3f(0.15), max(line * 0.6, head));
    s.gloss = 0.05;
    return s;
  }
  if (s.tag == 3u) {
    // a tide board: white, with a black tick every 10 cm (an E every metre) and the
    // metres above the lowest tide; below the high-water mark it is green with weed
    let h = s.uv.y + 2.0;
    let f = fract(h * 10.0);
    let tick = step(f, 0.5) * step(s.uv.x, select(0.16, 0.28, fract(h) < 0.5 && fract(h) > 0.0)) * step(0.04, s.uv.x);
    let num = number7((vec2f(s.uv.x, fract(h)) - vec2f(0.17, 0.55)) / vec2f(0.12, 0.35), floor(h + 0.001), 1);
    var col = mix(vec3f(0.85, 0.85, 0.82), vec3f(0.03), max(tick, num));
    let wet = 1.0 - smoothstep(${f(TIDE_A)} - 0.1, ${f(TIDE_A)} + 0.2, s.pos.z);
    col = mix(col, col * vec3f(0.35, 0.45, 0.3), wet * 0.7);
    s.color = col;
    s.gloss = mix(0.3, 0.6, wet);
    return s;
  }
  let wait = 45.0 - (s.t - 4.0 - 45.0 * floor((s.t - 4.0) / 45.0));
  let on = number7((s.uv - vec2f(0.2, 0.15)) / vec2f(0.6, 0.7), floor(wait), 2);
  s.color = mix(vec3f(0.01, 0.01, 0.012), vec3f(1.0, 0.55, 0.1), on);
  s.emissive = on * 5.0;
  s.gloss = 0.5;
  return s;
}

// lettering: painted, gilt, or neon tubes (style in aux)
fn signSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let style = i32(round(s.aux * 4.0));
  if (style == 1) {
    s.color = vec3f(0.85, 0.62, 0.22);
    s.gloss = 0.75;
  } else if (style == 2) {
    let hue = hash11(f32(s.tag) * 3.1);
    let c = select(select(vec3f(1.0, 0.25, 0.55), vec3f(0.3, 0.75, 1.0), hue > 0.66), vec3f(1.0, 0.75, 0.25), hue < 0.33);
    let on = 0.25 + 0.75 * smoothstep(0.1, 0.4, duskOf(s.t));
    s.color = c;
    s.emissive = 6.0 * on;
  } else {
    s.gloss = 0.3;
  }
  return s;
}

// facades with windows laid out from uv (metres): 1 kiosk, 2 pavilion, 3 dome drum, 0 hotel
fn facadeSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let u = s.uv.x; let v = s.uv.y;
  var bay = 1.5; var w0 = 0.35; var w1 = 1.15; var z0 = 1.0; var z1 = 2.4; var fl = 100.0;
  if (s.tag == 2u) { bay = 3.4; w0 = 0.9; w1 = 2.5; z0 = 0.9; z1 = 3.6; fl = 4.6; }
  if (s.tag == 3u) { bay = 2.2; w0 = 0.8; w1 = 1.4; z0 = 0.6; z1 = 1.6; }
  if (s.tag == 0u || s.tag == 4u) { bay = 3.6; w0 = 1.0; w1 = 2.5; z0 = 0.95; z1 = 2.55; fl = 3.3; }
  if (s.tag == 5u) { bay = 4.2; w0 = 1.6; w1 = 2.6; z0 = 1.0; z1 = 2.4; fl = 3.3; }
  if (s.tag == 6u) { bay = 100.0; w0 = 0.35; w1 = 1.25; z0 = 0.3; z1 = 1.5; }
  if (s.tag == 7u) { bay = 100.0; w0 = 0.12; w1 = 0.12 + max(s.uv.x, 0.0) * 0.0 + 99.0; z0 = 0.5; z1 = 2.75; }
  let bx = u / bay;
  let cell = floor(bx);
  let fx = fract(bx) * bay;
  let story = floor(v / fl);
  let fz = v - story * fl;
  var inW = step(w0, fx) * step(fx, w1) * step(z0, fz) * step(fz, z1);
  // arched heads on the pavilion
  if (s.tag == 2u) {
    let cx = (w0 + w1) * 0.5; let rr = (w1 - w0) * 0.5;
    let arch = step(length(vec2f(fx - cx, max(fz - (z1 - rr), 0.0))), rr);
    inW = step(w0, fx) * step(fx, w1) * step(z0, fz) * arch;
  }
  if ((s.tag == 0u || s.tag == 4u) && story < 0.5) {
    // the ground floor: shop windows and doors, lit until late
    let sb = 4.5;
    let sx = fract(u / sb) * sb;
    inW = step(0.35, sx) * step(sx, sb - 0.35) * step(0.35, fz) * step(fz, 2.85);
  }
  if (s.tag == 7u) { inW = step(0.12, u) * step(u, max(s.uv.x, 0.0) + 1.0) * step(0.5, fz) * step(fz, 2.75) * step(abs(fract(u / 1.0) - 0.5), 0.46); }
  let fd = 1.0 - smoothstep(0.01, 0.08, pf);
  var col = s.color * (0.92 + 0.08 * noise2(s.pos.xy * 0.7 + s.pos.z));
  if (inW > 0.5) {
    let id = hash21(vec2f(cell + s.pos.x * 0.013, story + s.pos.y * 0.017));
    let night = nightOf(s.t);
    let th = 0.1 + 0.8 * fract(id * 7.31);
    let lit = smoothstep(th, th + 0.05, night) * step(0.2, fract(id * 3.7));
    // glazing bars
    let gx = abs(fract((fx - w0) / (w1 - w0) * 2.0) - 0.5);
    let gz = abs(fract((fz - z0) / (z1 - z0) * 3.0) - 0.5);
    let bar = (1.0 - smoothstep(0.43, 0.47, max(gx, gz))) * 0.0 + smoothstep(0.44, 0.48, max(gx, gz)) * fd;
    let warm = mix(vec3f(1.0, 0.62, 0.3), vec3f(1.0, 0.8, 0.55), fract(id * 13.1));
    // curtains: drawn to the sides, or a net across the lower part, varying from window to window
    let wx = (fx - w0) / (w1 - w0); let wz = (fz - z0) / (z1 - z0);
    let ck = fract(id * 5.7);
    let side = step(min(wx, 1.0 - wx), 0.12 + 0.1 * fract(id * 3.3)) * step(0.3, ck);
    let net = step(wz, 0.55) * step(ck, 0.3);
    let ccol = select(vec3f(0.55, 0.52, 0.46), select(vec3f(0.42, 0.08, 0.06), vec3f(0.18, 0.25, 0.4), fract(id * 9.1) < 0.5), fract(id * 2.9) < 0.6);
    let curtain = max(side, net * 0.7);
    col = mix(vec3f(0.035, 0.045, 0.055), ccol * 0.45, curtain);
    col = mix(col, warm * 0.6 * mix(1.0, 0.7, curtain), lit);
    col = mix(col, vec3f(0.85, 0.83, 0.78), bar);
    s.emissive = lit * 2.2 * (1.0 - bar);
    s.gloss = mix(0.85, 0.3, max(lit, bar));
  } else {
    // a frame round each window, and on the hotels a moulded band at every floor and rusticated ground floor
    let fr = step(w0 - 0.1, fx) * step(fx, w1 + 0.1) * step(z0 - 0.15, fz) * step(fz, z1 + 0.1);
    col = mix(col, col * 0.8, fr * fd * 0.6);
    if (s.tag == 0u || s.tag == 5u) {
      let band = step(fz, 0.22) * step(0.5, story);
      col = mix(col, col * 1.06 + vec3f(0.02), band);
      col *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.03 + pf, abs(fz - 0.22))) * step(0.5, story) * fd;
      if (story < 0.5 && fz > 2.9) { col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.02 + pf, abs(fract(v / 0.45) - 0.5) * 0.45 - 0.2)) * fd; }
    }
    s.gloss = 0.08;
  }
  s.color = col;
  return s;
}

// the town's houses (copies of a unit box): windows laid out from the world position
fn townSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let n = s.n;
  if (abs(n.z) > 0.5) { s.color *= 0.6; s.gloss = 0.05; return s; }
  let along = dot(s.pos.xy, normalize(vec2f(-n.y, n.x)));
  let fz = s.pos.z - ${f(DECK)};
  let bx = fract(along / 3.2); let bz = fract(fz / 2.9);
  let win = step(0.3, bx) * step(bx, 0.7) * step(0.35, bz) * step(bz, 0.8) * step(1.2, fz);
  let fade = 1.0 - smoothstep(0.3, 1.2, pf);
  let id = hash21(floor(vec2f(along / 3.2, fz / 2.9)) + floor(s.pos.xy / 40.0));
  let night = nightOf(s.t);
  let lit = smoothstep(0.15 + 0.7 * id, 0.2 + 0.7 * id, night) * step(0.35, fract(id * 5.3));
  let wc = mix(vec3f(0.03, 0.035, 0.04), vec3f(1.0, 0.7, 0.4) * 0.6, lit);
  s.color = mix(s.color * (0.85 + 0.15 * noise2(s.pos.xy * 0.3)), wc, win * fade);
  s.emissive = win * lit * 2.0;
  s.gloss = mix(0.06, 0.7, win * fade * (1.0 - lit));
  return s;
}
// slate roofs
fn roofSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let fd = 1.0 - smoothstep(0.01, 0.08, pf);
  let q = vec2f(dot(s.pos.xy, normalize(vec2f(-s.n.y, s.n.x) + vec2f(1e-4, 0.0))) / 0.3, s.pos.z / 0.18);
  let row = floor(q.y);
  let h = hash21(vec2f(floor(q.x + 0.5 * row), row));
  let edge = smoothstep(0.8, 1.0, fract(q.y));
  s.color *= mix(1.0, (0.8 + 0.35 * h) * (1.0 - 0.35 * edge), fd);
  s.gloss = 0.3;
  return s;
}
// the land: the promenade's paving, the road and its markings, the town's
// streets, and fields and woods on the hills
fn landSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  if (p.x > 260.0 || p.z > ${f(DECK + 0.5)}) { return grassSurf(s, pf); }
  let fd = 1.0 - smoothstep(0.02, 0.12, pf);
  var col = vec3f(0.0);
  var gl = 0.1;
  if (p.x < 20.0) {
    // promenade: square slabs, and a band of red tiles
    let q = p.xy / 0.9;
    let e = min(min(fract(q.x), 1.0 - fract(q.x)), min(fract(q.y), 1.0 - fract(q.y)));
    let id = hash21(floor(q));
    col = mix(vec3f(0.48, 0.46, 0.42), vec3f(0.58, 0.55, 0.5), id);
    col = mix(col, vec3f(0.45, 0.24, 0.18), step(abs(p.x - 10.0), 2.2) * 0.8);
    col *= 1.0 - 0.3 * (1.0 - smoothstep(0.02, 0.05 + pf, e)) * fd;
  } else if (p.x < 22.0 || (p.x > 36.0 && p.x < 42.0)) {
    col = vec3f(0.5, 0.48, 0.45) * (0.9 + 0.1 * noise2(p.xy * 2.0));
  } else if (p.x < 36.0) {
    // the road: asphalt, a dashed centre line, edge lines, and a pedestrian crossing at the pier
    col = vec3f(0.08, 0.08, 0.085) * (0.85 + 0.3 * noise2(p.xy * 3.0) * fd + 0.1 * noise2(p.xy * 0.2));
    let centre = step(abs(p.x - 29.0), 0.08) * step(fract(p.y / 6.0), 0.5);
    let edges = step(abs(p.x - 22.6), 0.07) + step(abs(p.x - 35.4), 0.07);
    let zebra = step(abs(p.y), 3.0) * step(fract(p.x / 1.0), 0.5) * step(22.5, p.x) * step(p.x, 35.5);
    col = mix(col, vec3f(0.85, 0.85, 0.8), saturate(centre + edges + zebra * step(abs(p.x - 29.0), 6.4)));
    gl = 0.2;
  } else {
    // town streets
    col = vec3f(0.22, 0.21, 0.2) * (0.85 + 0.2 * noise2(p.xy * 0.5));
  }
  s.color = col;
  s.gloss = gl;
  s.light += promLight(p, s.t);
  return s;
}
// light from the promenade's lamps (every 25 m along x = 0.6)
fn promLight(p: vec3f, t: f32) -> vec3f {
  let night = nightOf(t);
  if (night <= 0.01 || p.x > 60.0 || abs(p.y) > ${f(PROM_Y)}) { return vec3f(0.0); }
  let yl = -${f(PROM_Y - 10)} + 25.0 * round((p.y + ${f(PROM_Y - 10)}) / 25.0);
  let d = vec3f(0.6 - p.x, yl - p.y, ${f(DECK + 3.5)} - p.z);
  return vec3f(1.0, 0.72, 0.42) * night * 12.0 / (dot(d, d) + 6.0);
}

// The promenade's lamps seen from the beach below the sea wall: they stand
// 8 m above the sand, so a lamp lights a pool of it, and the side of a hut or
// a deckchair that faces it, out to 20 m or so.  (The three nearest; there is
// none at the pier's entrance.)
fn beachLight(p: vec3f, n: vec3f, t: f32) -> vec3f {
  let night = nightOf(t);
  if (night <= 0.01) { return vec3f(0.0); }
  let yl = -${f(PROM_Y - 10)} + 25.0 * round((p.y + ${f(PROM_Y - 10)}) / 25.0);
  var acc = 0.0;
  for (var k = -1; k <= 1; k++) {
    let ly = yl + 25.0 * f32(k);
    let d = vec3f(0.6 - p.x, ly - p.y, ${f(DECK + 3.5)} - p.z);
    let dd = dot(d, d);
    acc += select(0.0, 1.0, abs(ly) > 15.0) * saturate(dot(n, d) * inverseSqrt(dd)) * 30.0 / (dd + 6.0);
  }
  return vec3f(1.0, 0.72, 0.42) * night * acc;
}
// The stalls on the pier head after dusk: a row of bulbs along the foot of
// each valance (2.2 m up, 0.96 m in front of the counter) lights the stall
// inside, and a pool of the deck in front that fades out over a few metres.
// The stalls stand in two rows, their counters 31 m either side of the middle.
fn stallLight(p: vec3f, t: f32) -> vec3f {
  let on = smoothstep(0.1, 0.6, duskOf(t));
  if (on <= 0.0) { return vec3f(0.0); }
  let north = p.y > 0.0;
  let dx = max(max(select(-288.6, -289.6, north) - p.x, p.x - select(-272.4, -264.4, north)), 0.0);
  let dy = max(30.04 - abs(p.y), 0.0);
  let dz = DECKZ + 2.19 - p.z;
  let pool = 2.0 / (dx * dx + dy * dy + dz * dz + 1.5);
  let inside = smoothstep(30.0, 31.0, abs(p.y)) * (1.0 - smoothstep(0.0, 0.6, dx));
  return vec3f(1.0, 0.8, 0.55) * on * (pool + 0.35 * inside);
}

fn lampSurf(sIn: Surface) -> Surface {
  var s = sIn;
  var on = lampOn(s.inst.w, s.t);
  if (s.tag == 2u) { on = 0.6; }
  if (s.tag == 4u) { s.color = vec3f(1.0, 0.08, 0.04); s.emissive = 0.5 + 2.5 * duskOf(s.t); return s; }
  if (s.tag == 6u || s.tag == 7u) {
    // the stations' signals: green from 2 s before a train leaves (at 4 s past
    // every 45 s) until it is under way, red otherwise
    let ph = (s.t - 2.0) - 45.0 * floor((s.t - 2.0) / 45.0);
    let green = step(ph, 10.0);
    let lit = select(1.0 - green, green, s.tag == 7u);
    s.emissive = 0.15 + lit * 8.0;
    s.gloss = 0.6;
    return s;
  }
  if (s.tag == 5u) {
    // a channel buoy: a short flash every 6 s, each buoy 0.6 s after the one inside it
    let k = (s.aux + 1.0) * 3.0;
    let fl = step(fract((s.t - k * 0.6) / 6.0), 0.1);
    s.emissive = 0.3 + fl * (3.0 + 9.0 * duskOf(s.t));
    s.gloss = 0.6;
    return s;
  }
  if (s.tag == 3u) { on = 0.4 + 0.6 * duskOf(s.t); }
  s.color = vec3f(1.0, 0.86, 0.6);
  s.emissive = 0.15 + on * 7.0;
  s.gloss = 0.6;
  return s;
}
// the festoon bulbs: on after dusk, with a pattern chasing out along the pier at 6 m/s
fn bulbSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let on = lampOn(s.inst.w, s.t);
  let ch = fract((s.inst.w - 6.0 * s.t) / 4.5);
  let lev = on * (0.25 + 0.75 * smoothstep(0.55, 0.45, ch) * smoothstep(0.0, 0.08, ch));
  s.emissive = 0.2 + lev * 9.0;
  s.gloss = 0.5;
  return s;
}

fn ironSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let fd = 1.0 - smoothstep(0.005, 0.04, pf);
  s.color *= mix(1.0, 0.85 + 0.25 * noise3(s.pos * 6.0), fd);
  // rust streaks low down, where the spray reaches
  let low = 1.0 - smoothstep(-1.0, 4.0, s.pos.z);
  s.color = mix(s.color, vec3f(0.18, 0.08, 0.04), low * 0.5 * noise3(s.pos * vec3f(2.0, 2.0, 0.3)));
  // weed and wet below the high-water mark
  let wet = 1.0 - smoothstep(TIDE_A - 0.1, TIDE_A + 0.3, s.pos.z);
  s.color = mix(s.color, vec3f(0.04, 0.06, 0.03), wet * 0.8);
  s.gloss = mix(0.35, 0.6, wet);
  return s;
}

fn stoneSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let n = normalize(s.n);
  var q = vec2f(dot(s.pos.xy, normalize(vec2f(-n.y, n.x) + vec2f(1e-4, 0.0))), s.pos.z);
  if (abs(n.z) > 0.7) { q = s.pos.xy; }
  let fd = 1.0 - smoothstep(0.01, 0.08, pf);
  let row = floor(q.y / 0.45);
  let qx = q.x / 0.9 + row * 0.5;
  let id = hash21(vec2f(floor(qx), row));
  let e = min(min(fract(qx), 1.0 - fract(qx)) * 0.9, min(fract(q.y / 0.45), 1.0 - fract(q.y / 0.45)) * 0.45);
  let joint = (1.0 - smoothstep(0.012, 0.03 + pf, e)) * fd;
  var col = s.color * (0.85 + 0.25 * id) * mix(1.0, 0.85 + 0.3 * noise3(s.pos * 5.0), fd);
  col *= 1.0 - 0.35 * joint;
  let wet = 1.0 - smoothstep(TIDE_A, TIDE_A + 0.5, s.pos.z);
  col = mix(col, col * vec3f(0.35, 0.4, 0.3), wet);
  s.color = col;
  s.gloss = mix(0.1, 0.5, wet);
  return s;
}

fn woodSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let fd = 1.0 - smoothstep(0.005, 0.05, pf);
  let g = noise3(s.pos * vec3f(3.0, 3.0, 12.0)) * 0.6 + noise3(s.pos * 17.0) * 0.4;
  s.color *= mix(1.0, 0.8 + 0.4 * g, fd);
  return s;
}

fn grassSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  let p = s.pos;
  let n1 = noise2(p.xy * 0.004);
  let n2 = noise2(p.xy * 0.03);
  // fields with hedges, woods on the steep parts
  let cell = floor(p.xy / vec2f(140.0, 95.0) + vec2f(noise2(p.xy * 0.01), noise2(p.xy * 0.012 + 3.0)) * 0.6);
  let fh = hash21(cell);
  var col = mix(vec3f(0.09, 0.15, 0.05), vec3f(0.20, 0.24, 0.08), fh);
  col = mix(col, vec3f(0.33, 0.30, 0.14), step(0.82, fh));
  let steep = 1.0 - s.n.z;
  let wood = smoothstep(0.45, 0.6, n1 * 0.6 + n2 * 0.4 + steep * 0.8);
  col = mix(col, vec3f(0.035, 0.06, 0.03) * (0.7 + 0.6 * n2), wood);
  let rock = smoothstep(0.35, 0.6, steep);
  col = mix(col, vec3f(0.22, 0.2, 0.18) * (0.7 + 0.5 * n2), rock);
  s.color = col * (0.85 + 0.3 * noise2(p.xy * 0.2));
  s.gloss = 0.05;
  return s;
}

// faces and hair, drawn on the head from its uv (u round the head from +x,
// so the face, which looks along +y, is at u = 0.25; v from the crown down)
fn skinSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  s.gloss = 0.25;
  if (s.tag == 1u) { return s; }
  let a = (fract(s.uv.x - 0.25 + 0.5) - 0.5) * TAU;     // 0 at the middle of the face
  let el = (0.5 - s.uv.y) * PI;                          // up from the level of the ears
  let hairSel = s.aux * 0.5 + 0.5;
  let hairCol = select(select(select(vec3f(0.02, 0.015, 0.01), vec3f(0.18, 0.09, 0.04), hairSel > 0.35), vec3f(0.55, 0.38, 0.18), hairSel > 0.62), vec3f(0.55, 0.52, 0.5), hairSel > 0.88);
  let longHair = step(0.5, fract(hairSel * 7.3));
  // hair: the crown, and the back of the head (lower for long hair)
  let back = smoothstep(1.2, 1.7, abs(a));
  let hairLine = mix(0.55, 0.1, back) - longHair * back * 0.9;
  let hair = smoothstep(hairLine - 0.05, hairLine + 0.05, el + 0.15 * noise2(vec2f(a * 4.0, el * 4.0)));
  let fd = 1.0 - smoothstep(0.004, 0.02, pf);
  var col = s.color;
  // eyes, brows, nose, mouth (only on the front)
  let front = 1.0 - smoothstep(0.9, 1.1, abs(a));
  let ey = vec2f(abs(a) - 0.38, el - 0.1);
  let er = length(ey * vec2f(1.0, 1.7));
  let white = (1.0 - smoothstep(0.1, 0.13, er)) * front;
  let iris = (1.0 - smoothstep(0.045, 0.07, length(ey * vec2f(1.0, 1.1) - vec2f(0.012, 0.0)))) * front;
  let socket = (1.0 - smoothstep(0.1, 0.2, er)) * front;
  let brow = (1.0 - smoothstep(0.025, 0.05, abs(el - 0.3 + 0.08 * abs(a)))) * step(abs(a), 0.62) * step(0.15, abs(a)) * front;
  let mouth = (1.0 - smoothstep(0.025, 0.045, abs(el + 0.4 - 0.1 * a * a))) * step(abs(a), 0.32) * front;
  let nose = (1.0 - smoothstep(0.04, 0.1, abs(a))) * smoothstep(-0.28, -0.05, el) * (1.0 - smoothstep(-0.05, 0.12, el)) * front;
  col = mix(col, col * 0.8, socket * 0.4);
  col = mix(col, col * 0.7, nose * 0.6);
  col = mix(col, vec3f(0.5, 0.16, 0.14), mouth * 0.85);
  col = mix(col, vec3f(0.9, 0.88, 0.85), white * fd);
  col = mix(col, vec3f(0.04, 0.03, 0.02), max(iris, brow * 0.75) * mix(0.7, 1.0, fd));
  // the cheeks catch a little colour
  col = mix(col, col * vec3f(1.08, 0.92, 0.9), (1.0 - smoothstep(0.1, 0.25, length(vec2f(abs(a) - 0.45, el + 0.15)))) * front);
  s.color = mix(col, hairCol, hair);
  s.gloss = mix(0.25, 0.4, hair);
  return s;
}

// canvas: the helter-skelter's red and white spiral, striped awnings
fn canvasSurf(sIn: Surface, pf: f32) -> Surface {
  var s = sIn;
  if (s.tag == 1u) {
    let a = atan2(s.n.y, s.n.x) / TAU;
    let st = fract(a * 6.0 + s.pos.z * 0.35);
    s.color = select(vec3f(0.85, 0.82, 0.76), vec3f(0.6, 0.06, 0.04), st < 0.5);
  } else if (s.tag == 3u) {
    s.color = select(vec3f(0.85, 0.83, 0.78), s.color, fract(s.uv.x * 2.0) < 0.5);
  } else if (s.tag == 5u) {
    // a booth in red and white stripes
    let q = dot(s.pos.xy, normalize(vec2f(-s.n.y, s.n.x) + vec2f(1e-4, 0.0)));
    s.color = select(vec3f(0.85, 0.83, 0.78), vec3f(0.6, 0.06, 0.04), fract(q * 2.5) < 0.5);
  } else if (s.tag == 4u) {
    // a life ring: red and white quarters
    s.color = select(vec3f(0.9, 0.9, 0.88), vec3f(0.75, 0.08, 0.05), fract(s.uv.x * 4.0) < 0.5);
  } else if (s.tag == 2u) {
    let a = atan2(s.n.y, s.n.x) / TAU;
    s.color = select(vec3f(0.85, 0.82, 0.76), s.color, fract(a * 8.0) < 0.5);
  }
  s.color *= 0.92 + 0.08 * noise3(s.pos * 9.0);
  s.gloss = 0.1;
  return s;
}

// rows of bulbs on ride fronts and on the wheel's rims and spokes, chasing
fn rimSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let night = smoothstep(0.1, 0.5, duskOf(s.t));
  var k = 0.0;
  var c = vec3f(1.0, 0.85, 0.5);
  if (s.tag == 1u) {
    // spokes: light running out from the hub
    k = s.uv.y * 6.0 - s.t * 1.5;
    c = vec3f(1.0, 0.45, 0.25);
  } else if (s.tag == 9u) {
    // a stall's canopy (it runs along x): a bulb every 0.4 m
    k = s.pos.x * 2.5;
    c = vec3f(1.0, 0.85, 0.55);
  } else if (s.tag == 2u) {
    // the train's roof: a bulb every 0.4 m (uv in metres along the car)
    k = s.uv.x * 2.5 + 0.5;
    c = vec3f(1.0, 0.8, 0.45);
  } else {
    k = s.uv.x * 80.0;
    c = select(vec3f(1.0, 0.85, 0.5), vec3f(0.5, 0.8, 1.0), fract(s.uv.x * 4.0 + s.t * 0.25) < 0.5);
  }
  let bulb = 1.0 - smoothstep(0.15, 0.35, abs(fract(k) - 0.5));
  s.color = mix(s.color, c, bulb);
  s.emissive = bulb * night * 5.0;
  s.gloss = 0.4;
  return s;
}
fn marqueeSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let night = smoothstep(0.1, 0.5, duskOf(s.t));
  let a = atan2(s.n.y, s.n.x) / TAU;
  let k = a * 96.0;
  let row = step(0.5, fract(s.pos.z * 1.5));
  let bulb = (1.0 - smoothstep(0.15, 0.35, length(vec2f(fract(k) - 0.5, (fract(s.pos.z * 3.0) - 0.5) * 0.9))));
  let ch = step(0.5, fract(floor(k) / 3.0 - s.t * 2.0 + row * 0.5));
  s.emissive = bulb * night * (1.0 + 5.0 * ch);
  s.color = mix(s.color, vec3f(1.0, 0.9, 0.6), bulb);
  s.gloss = 0.4;
  return s;
}
// the lighthouse beams: faint in daylight, bright in the dusk haze, thinning out along their length
fn beamSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let night = smoothstep(0.0, 0.8, duskOf(s.t));
  let d = s.pos.xy - vec2f(${f(LIGHT.x)}, ${f(LIGHT.y)});
  let r = length(d);
  let along = r / 320.0;
  // the beams turn clockwise once in 12 s; at t = 0 one points north
  var da = atan2(d.y, d.x) - (0.5 * PI - TAU * s.t / 12.0);
  da = abs(da - TAU * round(da / TAU));
  let dd = min(da, PI - da);
  let halfw = (0.6 + r * 0.02) / max(r, 1.0);
  let beam = exp(-dd * dd / (halfw * halfw));
  let facing = beam;
  // (seen tilted far, the slice cuts the turning beams again and again: a
  // column of cross-sections, the helix they sweep out.  They are drawn as
  // see-through haze rather than added light, so that many of them one
  // behind another approach the beam's colour instead of glaring white.)
  s.color = vec3f(1.6, 1.35, 0.95);
  s.alpha = night * 0.3 * pow(max(1.0 - along, 0.0), 1.6) * facing;
  return s;
}
// fireworks: only to be seen against the dark.  A burst's sparks (uv: the
// moment of the burst) flash and then fade over 3.2 s; the rising shells'
// trails (uv 0..1) burn steadily.
fn sparkSurf(sIn: Surface) -> Surface {
  var s = sIn;
  if (s.uv.x > 0.0 || s.uv.y > 0.0) {
    if (s.mat == ${MAT.SPARK}u && s.tag == 1u) {
      let tb = s.uv.x * 32.0 + s.uv.y;
      let age = (s.t - tb) - ${f(P)} * floor((s.t - tb) / ${f(P)});
      s.emissive = 6.0 * pow(max(0.0, 1.0 - age / 3.2), 1.3) + select(0.0, 4.0, age < 0.1);
    }
  }
  s.emissive *= 0.1 + 2.4 * smoothstep(0.2, 0.9, nightOf(s.t));
  return s;
}
// spoked wheels (tag 1: a disc): the spokes turn as the wheel rolls, so in a
// tilted view they bend into curves.  The wheel's speed is in its aux (m/s,
// divided by 10): it rolls on a radius of 0.355 m.  Spokes that pass more than about 20 times a second cannot be seen turning
// at the rate a screen shows them (they seem to stand, flicker or turn
// back), so as they speed up they fade to a blur of their average tone (12
// spokes cover 0.12 of the circle): crisp up to 3 a second, a blur by 20.
// The hub, and the tyre and rim (a mesh of their own), are round and stay
// crisp.
fn wheelSurf(sIn: Surface) -> Surface {
  var s = sIn;
  if (s.tag == 1u) {
    let q = s.uv - 0.5;
    let w = s.aux * 10.0 / 0.355;
    let a = atan2(q.y, q.x) + s.t * w;
    let r = length(q) * 2.0;
    let blur = smoothstep(3.0, 20.0, abs(w) * 12.0 / TAU);
    let spoke = mix(1.0 - smoothstep(0.08, 0.16, abs(fract(a / TAU * 12.0) - 0.5) * 2.0), 0.12, blur);
    let hub = 1.0 - smoothstep(0.12, 0.16, r);
    let cov = max(spoke, hub);
    s.color = mix(vec3f(0.05), vec3f(0.75, 0.75, 0.78), cov);
    s.gloss = 0.6 * cov;
    return s;
  }
  s.gloss = 0.3;
  return s;
}
// foam of a wake: strongest at the stern, broken up, fading behind
fn wakeSurf(sIn: Surface) -> Surface {
  var s = sIn;
  let f = noise2(s.pos.xy * 0.8 + vec2f(s.t * 0.7, 0.0)) * 0.6 + noise2(s.pos.xy * 3.1) * 0.4;
  let k = (1.0 - s.uv.y) * smoothstep(0.35, 0.7, f + 0.3 * (1.0 - s.uv.y));
  s.color = vec3f(0.85, 0.88, 0.9);
  s.alpha = saturate(k) * 0.85;
  s.gloss = 0.2;
  return s;
}
fn glassSurf(sIn: Surface) -> Surface {
  var s = sIn;
  if (s.tag == 9u) { s.alpha = 0.0; return s; }
  if (s.tag == 1u) { s.gloss = 0.9; return s; }
  s.color = vec3f(0.03, 0.04, 0.05);
  s.gloss = 0.9;
  return s;
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  let pf = length(fwidth(s.pos));
  switch (s.mat) {
    case ${MAT.SEA}u: { s = seaSurf(s, pf); }
    case ${MAT.SAND}u: { s = sandSurf(s, pf); }
    case ${MAT.DECK}u: { s = deckSurf(s, pf); }
    case ${MAT.IRON}u, ${MAT.RAILING}u, ${MAT.LATTICE}u: { s = ironSurf(s, pf); }
    case ${MAT.STONE}u: { s = stoneSurf(s, pf); }
    case ${MAT.WOOD}u: { s = woodSurf(s, pf); }
    case ${MAT.CLOCK}u: { s = clockSurf(s, pf); }
    case ${MAT.BOARD}u: { s = boardSurf(s); }
    case ${MAT.SIGN}u: { s = signSurf(s); }
    case ${MAT.FACADE}u: { s = facadeSurf(s, pf); }
    case ${MAT.LAMP}u: { s = lampSurf(s); }
    case ${MAT.BULB}u: { s = bulbSurf(s); }
    case ${MAT.GRASS}u: { s = landSurf(s, pf); }
    case ${MAT.TOWN}u: { s = townSurf(s, pf); }
    case ${MAT.ROOF}u: { s = roofSurf(s, pf); }
    case ${MAT.PAINT}u: { s.gloss = 0.45; }
    case ${MAT.ZINC}u: { s.color *= 0.85 + 0.3 * noise3(s.pos * vec3f(0.5, 0.5, 3.0)); s.gloss = 0.45; }
    case ${MAT.STEEL}u: { s.gloss = 0.6; }
    case ${MAT.SKIN}u: { s = skinSurf(s, pf); }
    case ${MAT.CLOTH}u: { s.color *= 0.9 + 0.2 * noise3(s.pos * 30.0); s.gloss = 0.12; }
    case ${MAT.CANVAS}u: { s = canvasSurf(s, pf); }
    case ${MAT.RIMLIGHT}u: { s = rimSurf(s); }
    case ${MAT.MARQUEE}u: { s = marqueeSurf(s); }
    case ${MAT.BEAM}u: { s = beamSurf(s); }
    case ${MAT.SPARK}u: { s = sparkSurf(s); }
    case ${MAT.GLASS}u: { s = glassSurf(s); }
    case ${MAT.WHEEL}u: { s = wheelSurf(s); }
    case ${MAT.WAKE}u: { s = wakeSurf(s); }
    case ${MAT.SAIL}u: { s.color *= 0.95 + 0.05 * noise3(s.pos * 2.0); s.gloss = 0.15; }
    default: {}
  }
  // the stalls of the pier head, and the beach under the promenade's lamps,
  // whatever stands there
  let p = s.pos;
  if (p.x < -262.0 && p.x > -292.0 && abs(p.y) > 22.0 && abs(p.y) < 34.0 && p.z < DECKZ + 4.0) { s.light += stallLight(p, s.t); }
  if (p.x > -45.0 && p.x < -0.02 && abs(p.y) > 13.0 && p.z < DECKZ - 0.3) { s.light += beachLight(p, s.n, s.t); }
  return s;
}
`;

// ---------------------------------------------------------------------------
// the scene

export default {
  id: 'pier',
  name: 'Pleasure Pier',
  blurb: 'A Victorian pleasure pier at dusk on a day that runs fast: a pier railway, a fairground, fireworks over the sea, a lighthouse, the tide coming in and going out.',
  C,
  mode: 'walk',
  modes: ['walk', 'fly'],
  spawn: { pos: [-182, 1.0, DECK], t: 0, yaw: 270, pitch: 5 },
  period: P,
  viewDistance: 1600,
  skyDistance: 2500,
  accel: 2,
  exposure: 1.0,
  bloom: 0.35,
  shadowRadii: [40, 300],
  shadowDepth: 900,
  reflections: true,
  walkSpeed: 3,
  runSpeed: 8,
  ceiling: 500,
  ground: (x, y) => ground(x, y),
  wgsl,

  // The music (see "Music" in docs/SCENES.md).
  // The Pleasure Pier: a fairground organ's waltz.  Forty bars in three
  // quarters of a minute, which is a quarter of the pier's own round of
  // things: pedal and reeds going oom-pah-pah, the tune on the pipes, a
  // glockenspiel joining in for every other strain.
  music: {
    seconds: 45, bpm: 160, reverb: 1.5, echo: [0.375, 0.15], seed: 71,
    build(m) {
      const { n, notes, tune } = m;
      const b = m.beat, bar = 3 * b;
      const pedal = m.track({ hall: 0.15 }), reeds = m.track({ pan: -0.25, hall: 0.25, vib: [5.8, 7] }), pipes = m.track({ pan: 0.2, hall: 0.3, vib: [5.8, 11] });
      const chimes = m.track({ pan: 0.35, hall: 0.4 }), kit = m.track({ gain: 0.8, hall: 0.12 });
      const chord = {
        C: ['C3', 'E4 G4 C5'], G7: ['G2', 'F4 G4 B4'], C7: ['C3', 'E4 G4 Bb4'], F: ['F2', 'F4 A4 C5'],
        D7: ['D3', 'F#4 A4 C5'], 'F#o': ['F#2', 'F#4 A4 C5'], A7: ['A2', 'E4 G4 C#5'], Dm: ['D3', 'F4 A4 D5'],
      };
      const form = 'C C G7 G7 G7 G7 C C  C C G7 G7 G7 G7 C C7  F F C C D7 D7 G7 G7  C C G7 G7 G7 G7 C C  F F#o C A7 Dm G7 C C'.split(/\s+/);
      form.forEach((name, k) => {
        const t0 = k * bar, [root, tones] = chord[name];
        // the pedal: the root, and the fifth where the chord stays for another bar
        m.tone(pedal, t0, b * 0.9, n(root) + (k > 0 && name === form[k - 1] && k % 2 ? 7 : 0), { type: 'triangle', cutoff: 700, gain: 0.15, a: 0.01, d: 0.3, s: 0.5, r: 0.15 });
        for (const i of [1, 2]) {
          for (const p of notes(tones)) m.tone(reeds, t0 + i * b, b * 0.45, p, { type: 'square', cutoff: 2100, gain: 0.06, a: 0.01, d: 0.1, s: 0.6, r: 0.06 });
          m.noise(kit, t0 + i * b, { dur: 0.04, gain: 0.07, type: 'bandpass', freq: 2600, q: 0.8 });
        }
        m.kick(kit, t0, 0.4, { from: 110, to: 50, dur: 0.2 });
        if (k % 8 === 0) m.noise(kit, t0, { dur: 0.5, gain: 0.08, type: 'highpass', freq: 6000 });
      });
      const pipe = (t, d, p) => {
        m.tone(pipes, t, d * 0.85, p, { type: 'square', cutoff: 3600, gain: 0.13, a: 0.015, d: 0.15, s: 0.8, r: 0.08 });
        m.tone(pipes, t, d * 0.85, p + 12, { gain: 0.04, a: 0.015, d: 0.15, s: 0.8, r: 0.08 });
        m.noise(pipes, t, { dur: 0.02, gain: 0.03, type: 'bandpass', freq: 4000, q: 1 });
      };
      const chime = (t, d, p) => m.bell(chimes, t, p + 12, { partials: 'bars', gain: 0.1, decay: 0.7 });
      const A = 'E5 G5 C6  B5 A5 G5  F5 G5 B5  D6:2 B5  D5 G5 B5  A5 G5 F5  E5 G5 E5  C5:3';
      const A2 = 'E5 G5 C6  C6 B5 G5  F5 G5 B5  D6:2 B5  D5 G5 B5  A5 G5 F5  G5 E5 C5  E5:2 Bb5';
      const B = 'A5:2 C6  A5 F5 A5  G5:2 E5  C5 E5 G5  F#5:2 A5  C6 A5 F#5  G5 B5 D6  D6:2 G5';
      const coda = 'F5 A5 C6  C6 A5 F#5  G5:2 E5  E5 G5 A5  F5:2 D5  B4 D5 F5  E5 G5 C6  C6:2 -';
      [A, A2, B, A, coda].forEach((text, i) => {
        tune(i * 8 * bar, b, text, pipe);
        if (i === 1 || i === 3) tune(i * 8 * bar, b, text, chime);
      });
    },
  },

  build(b) {
    SIGNS.length = 0;
    // terrain: the beach and sea bed (fine round the pier), the land
    const sandCol = () => [0.8, 0.8, 0.8];
    b.static(hgrid(-200, -400, 0, 400, 4, seabedZ, { color: sandCol, snap: 5, mat: MAT.SAND }), { solid: false });
    b.static(hgrid(-1100, -2400, 0, 2400, 20, seabedZ, { hole: [-200, -400, 0, 400], color: sandCol, mat: MAT.SAND }), { solid: false });
    b.static(hgrid(0, -2400, 2400, 2400, 25, landZ, { color: () => [0.35, 0.45, 0.25], mat: MAT.GRASS }), { solid: false });
    // the sea, rising and falling with the tide
    const [sx0, sy0, sx1, sy1] = SEA_R;
    b.dynamic(seaGrid(sx0, sy0, sx1, sy1, 150), { times: timeRange(0, P, P / 8), transform: (t) => m4.translation(0, 0, tideZ(t)), caps: 'none' });
    // the sea beyond it, at mean sea level; and under the moving surface a deep
    // one, for where that is too far away to be drawn
    b.static(seaGrid(-6000, -6000, 0, 6000, 150, SEA_R), { solid: false });
    b.static(seaGrid(sx0, sy0, sx1, sy1, 150).translate(0, 0, -TIDE_A - 0.3), { solid: false });
    // sea wall
    const wall = new Geo();
    for (let y = -1150; y < 1150; y += 50) wall.add(panel(0, y + 25, -1, 0, 50, 2.0, DECK));
    b.static(wall.color('#8a8478').mat(MAT.STONE));
    // the pier
    pierDeck(b);
    pierFrame(b);
    railings(b, railRuns());
    b.instances(lampStandard(), lampSpots().map(([x, y, along]) => ({ transform: m4.translation(x, y, DECK), data: along })));
    festoons(b);
    entrance(b);
    station(b, STATION_X[0], 'PIER RAILWAY', 0);
    station(b, STATION_X[1], 'PIER HEAD', 1);
    railway(b);
    pavilion(b);
    trains(b);
    bigWheel(b);
    swingRide(b);
    swingBoat(b);
    helterSkelter(b);
    harbourArm(b);
    lighthouse(b);
    fireworks(b);
    walkers(b);
    promenade(b);
    hotels(b);
    town(b);
    boats(b);
    gulls(b);
    traffic(b);
    pierThings(b);
    beach(b);
    beachSteps(b);
    headThings(b);
    tideThings(b);
    stalls(b);
    b.texture('letters', { width: LETTER_W, height: LETTER_H * LETTER_LINES, data: letterTable() });
  },
};
