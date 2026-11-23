// Old Town: a market square inside a walled town, explored on foot.  A clock
// tower stands in the middle of the square and its clock keeps the same time
// as the sky; a long avenue runs west from the square to the town gate, with
// trams, cyclists and people moving along it at steady speeds.  When you
// run, the far end of the avenue falls behind in time and the clocks, lamps
// and traffic show it.
//
// Layout (metres, +x east, +y north):
//   square   |x|, |y| < 40, clock tower at the origin, town hall on the east side
//   avenue   y in [-14, 14], from the square (x = -40) west to the gate (x = -224)
//   gate     x in [-236, -224]; trams turn round outside it, cyclists and
//            walkers come and go along the outside of the wall
//   town     blocks of houses round both, inside a rectangular city wall

import { Geo } from '../geom.js';
import { m4 } from '../math.js';
import { dayNightEnv } from '../env.js';
import { Path, follow, adaptiveTimes, timeRange, rng } from '../util.js';

const P = 120;            // everything that moves repeats after this many seconds
const DAY = 300;          // seconds per day: an hour is 12.5 s
const HOUR0 = 14.5;       // time of day at t = 0

const SQ = 40;            // half-size of the square, to the house fronts
const AW = 14;            // half-width of the avenue, to the house fronts
const GATE_X = -224;      // inner face of the town gate
const DEPTH = 12;         // depth of the houses on the square and the avenue
const WALL = { x0: -236, x1: 96, y: 96 }; // city wall (inner faces)
const TRAM_Y = 2.1;       // tram tracks either side of the avenue's centre line
const BIKE_Y = 5.2;       // cycle lanes
const FOUNTAIN = [-17, 17];
const CAROUSEL = [17, -17];

// window rectangle inside one bay x storey cell of a facade (cell units); the
// shader draws the windows, the builder adds sills that line up with them
const WIN = { hw: 0.2, b: 0.27, t: 0.86 };

const MAT = {
  GROUND: 1, FACADE: 2, WALL: 3, ROOF: 4, STONE: 5, TOWER: 6, CLOCK: 7, LAMP: 8,
  WATER: 9, AWNING: 10, TRAM: 11, BULB: 12, DISPLAY: 13, LEAF: 14, GABLE: 15,
  JET: 16, CANOPY: 17, DOOR: 18, GLASS: 19, CURTAIN: 20, NEON: 21,
};

// street lamps: positions shared by the geometry and the shader's light pools
const AV_LAMP = { x0: -46, dx: -24, n: 8, y: 7.6 };
const SQ_LAMPS = [[-26, -26], [0, -26], [26, -26], [26, 0], [26, 26], [0, 26], [-26, 26], [-26, 8], [-26, -8]];
const LAMP_Z = 4.55;

// ---------------------------------------------------------------------------
// paths

// A polyline through 2D corner points with each corner rounded off by a
// circular arc of radius r (a number, or one per point).
function fillet(pts, r, closed = false) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const B = pts[i];
    const rr = Array.isArray(r) ? r[i] : r;
    if (!closed && (i === 0 || i === n - 1)) { out.push(B); continue; }
    const A = pts[(i - 1 + n) % n], C = pts[(i + 1) % n];
    const lu = Math.hypot(B[0] - A[0], B[1] - A[1]), lv = Math.hypot(C[0] - B[0], C[1] - B[1]);
    const u = [(B[0] - A[0]) / lu, (B[1] - A[1]) / lu], v = [(C[0] - B[0]) / lv, (C[1] - B[1]) / lv];
    const cr = u[0] * v[1] - u[1] * v[0], dt = u[0] * v[0] + u[1] * v[1];
    const th = Math.atan2(Math.abs(cr), dt);
    if (th < 1e-3 || rr <= 0) { out.push(B); continue; }
    let tl = rr * Math.tan(th / 2), R = rr;
    const maxT = Math.min(lu, lv) * 0.5;
    if (tl > maxT) { tl = maxT; R = tl / Math.tan(th / 2); }
    const s = Math.sign(cr);
    const P0 = [B[0] - u[0] * tl, B[1] - u[1] * tl];
    const Cc = [P0[0] - u[1] * s * R, P0[1] + u[0] * s * R];
    const a0 = Math.atan2(P0[1] - Cc[1], P0[0] - Cc[0]);
    const k = Math.max(2, Math.ceil(th / (3 * Math.PI / 180)));
    for (let j = 0; j <= k; j++) {
      const a = a0 + s * th * j / k;
      out.push([Cc[0] + R * Math.cos(a), Cc[1] + R * Math.sin(a)]);
    }
  }
  return out;
}

// splits long straight pieces so that no edge of geometry built along the path is long
function densify(pts, maxLen, closed = false) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLen));
    for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

// The tram loop, in the direction of travel: in along the avenue's south
// track, round the square anticlockwise, out along the north track, and round
// a loop outside the gate.
const TRAM_PTS = fillet([
  [-246, -TRAM_Y], [-31, -TRAM_Y], [-31, -31], [31, -31], [31, 31], [-31, 31], [-31, TRAM_Y], [-246, TRAM_Y],
  [-262, 10], [-294, 10], [-294, -10], [-262, -10],
], [7, 8, 9, 9, 9, 9, 8, 7, 7, 8, 8, 7], true);
const TRAM_PATH = new Path(TRAM_PTS, { closed: true });
const TRAM_V = TRAM_PATH.length / P;
const TRAM_N = 3;
const TRAM_OFF = 120;          // where the first tram is at t = 0
const TRAM_SEG = 6.4, TRAM_GAP = 0.7;
const STOP_X = -130;           // tram stop in the avenue

// distance along the tram loop nearest to a point
function tramDistance(x, y) {
  let best = 0, bd = Infinity;
  for (let d = 0; d < TRAM_PATH.length; d += 0.25) {
    const p = TRAM_PATH.at(d).p, e = Math.hypot(p[0] - x, p[1] - y);
    if (e < bd) { bd = e; best = d; }
  }
  return best;
}
// the time (mod P / TRAM_N, the interval between trams) at which a tram's
// nose passes a point of the track
const NOSE = 2 * (TRAM_SEG + TRAM_GAP) + TRAM_SEG / 2;
const TRAM_LEN = NOSE + TRAM_SEG / 2;
const mod = (a, m) => ((a % m) + m) % m;
const tramPass = (x, y) => mod((tramDistance(x, y) - TRAM_OFF - NOSE) / TRAM_V, P / TRAM_N);
const STOP_T = [-TRAM_Y, TRAM_Y].map((y) => tramPass(STOP_X, y));
const CROSS_X = -64;           // zebra crossing with pedestrian lights

// Cyclists and walkers come in from outside the wall or a back street, cross
// the town and leave again out of sight.
const R_BIKE_IN = fillet([[-248, -112], [-248, -BIKE_Y], [-35.5, -BIKE_Y], [-35.5, -35], [-18.2, -35], [-18.2, -55], [14, -55]], [0, 4, 4, 4, 3, 3, 0]);
const R_BIKE_OUT = fillet([[46, 55], [17.9, 55], [17.9, 34.6], [-35.5, 34.6], [-35.5, BIKE_Y], [-246, BIKE_Y], [-246, 112]], [0, 3, 3, 4, 4, 4, 0]);
const R_WALK = [
  fillet([[-242, 104], [-242, 11.8], [-38.6, 11.8], [-38.6, 38.6], [14.8, 38.6], [14.8, 54.2], [46, 54.2]], 1.2),
  fillet([[46, 56.2], [16.0, 56.2], [16.0, 37.4], [-37.4, 37.4], [-37.4, 10.4], [-240.5, 10.4], [-240.5, 104]], 1.2),
  fillet([[-241, -104], [-241, -10.4], [-37.4, -10.4], [-37.4, -37.4], [-21.2, -37.4], [-21.2, -54.2], [-46, -54.2]], 1.2),
  fillet([[-46, -56.2], [-20.0, -56.2], [-20.0, -38.6], [-38.6, -38.6], [-38.6, -11.8], [-242.5, -11.8], [-242.5, -104]], 1.2),
];

// ---------------------------------------------------------------------------
// shader

const f1 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const wgsl = dayNightEnv({ dayLength: DAY, startHour: HOUR0, sunTilt: 0.62, clouds: 0.42 })
  // our own fog below: clear across the square, closing in over the length of
  // the avenue, and thinner higher up
  .replace(/fn envFog\(/, 'fn envFogDefault(') + /* wgsl */ `
const FOG_LIN = 0.0009;
const FOG_D = 330.0;
const FOG_H = 70.0;
fn envFog(dir: vec3f, t: f32, dist: f32) -> vec4f {
  let flat_ = normalize(vec3f(dir.xy, max(dir.z, 0.0) * 0.35 + 0.03));
  let q = dist / FOG_D;
  let z0 = max(G.P.z, 0.0) / FOG_H;
  let dz = dir.z * dist / FOG_H;
  var hf = exp(-z0);
  if (abs(dz) > 0.01) { hf = (exp(-z0) - exp(-max(z0 + dz, 0.0))) / dz; }
  hf = max(hf, 0.35);
  return vec4f(envSkyBase(flat_, t), 1.0 - exp(-(dist * FOG_LIN + q * q) * hf));
}

const WHW = ${f1(WIN.hw)};
const WB = ${f1(WIN.b)};
const WT = ${f1(WIN.t)};
const LAMP_Z = ${f1(LAMP_Z)};
const LAMP_COL = vec3f(1.0, 0.68, 0.36);
const FOUNTAIN = vec2f(${f1(FOUNTAIN[0])}, ${f1(FOUNTAIN[1])});
const STOP_T_E = ${STOP_T[0].toFixed(3)};
const STOP_T_W = ${STOP_T[1].toFixed(3)};
const TRAM_EVERY = ${f1(P / TRAM_N)};

fn lin(c: vec3f) -> vec3f { return srgbToLinear(c); }

fn rectAA(f: vec2f, lo: vec2f, hi: vec2f, w: vec2f) -> f32 {
  let a = smoothstep(lo - w, lo + w, f);
  let b = vec2f(1.0) - smoothstep(hi - w, hi + w, f);
  return a.x * a.y * b.x * b.y;
}

fn hours(t: f32) -> f32 { return envDayPhase(t) * 24.0; }
fn nightOf(t: f32) -> f32 { return smoothstep(0.25, 0.75, 1.0 - envDaylight(t)); }

// Street lamps switch on as the light fails; k orders them outwards from the
// square, so at dusk a wave of lamps runs down the avenue (and back at dawn).
fn lampOn(t: f32, k: f32) -> f32 {
  let th = 0.5 - 0.035 * k;
  return 1.0 - smoothstep(th - 0.012, th + 0.012, envDaylight(t));
}
fn lampIndex(p: vec3f) -> f32 {
  if (p.x < -${f1(SQ)} + 2.0) { return clamp(round((${f1(AV_LAMP.x0)} - p.x) / ${f1(-AV_LAMP.dx)}), 0.0, ${f1(AV_LAMP.n - 1)}) + 1.0; }
  return 0.0;
}
fn pointLamp(p: vec3f, n: vec3f, L: vec3f) -> f32 {
  let d = L - p;
  let dd = dot(d, d);
  let ndl = max(dot(n, d), 0.0) * inverseSqrt(dd + 1e-4);
  return ndl * 15.0 / (dd + 2.0) * (1.0 - smoothstep(220.0, 420.0, dd));
}
fn lampLight(p: vec3f, n: vec3f, t: f32) -> vec3f {
  var acc = 0.0;
  if (p.x < -${f1(SQ)} + 8.0 && p.x > ${f1(GATE_X)} - 4.0 && abs(p.y) < ${f1(AW)} + 1.0) {
    let k = clamp(round((${f1(AV_LAMP.x0)} - p.x) / ${f1(-AV_LAMP.dx)}), 0.0, ${f1(AV_LAMP.n - 1)});
    for (var j = -1; j <= 1; j++) {
      let kk = k + f32(j);
      if (kk < 0.0 || kk > ${f1(AV_LAMP.n - 1)}) { continue; }
      let lx = ${f1(AV_LAMP.x0)} + ${f1(AV_LAMP.dx)} * kk;
      let on = lampOn(t, kk + 1.0);
      if (on <= 0.0) { continue; }
      acc += on * (pointLamp(p, n, vec3f(lx, ${f1(AV_LAMP.y)}, LAMP_Z)) + pointLamp(p, n, vec3f(lx, -${f1(AV_LAMP.y)}, LAMP_Z)));
    }
  }
  if (abs(p.x) < ${f1(SQ)} + 2.0 && abs(p.y) < ${f1(SQ)} + 2.0) {
    let on = lampOn(t, 0.0);
    if (on > 0.0) {
      var L = array<vec2f, ${SQ_LAMPS.length}>(${SQ_LAMPS.map(([x, y]) => `vec2f(${f1(x)}, ${f1(y)})`).join(', ')});
      var a = 0.0;
      for (var i = 0; i < ${SQ_LAMPS.length}; i++) { a += pointLamp(p, n, vec3f(L[i], LAMP_Z)); }
      acc += a * on;
    }
  }
  return LAMP_COL * acc;
}

// whether a window is lit: each has its own evening and its own bedtime
fn windowLit(id: vec2f, t: f32) -> f32 {
  let h = hash22(id * vec2f(0.731, 1.37) + vec2f(3.1, 7.7));
  let hm = hours(t);
  var hr = hm;
  if (hr < 12.0) { hr += 24.0; }
  let on = 17.4 + 2.4 * h.x;
  let off = 22.0 + 4.5 * h.y;
  var lit = step(on, hr) * step(hr, off);
  lit = max(lit, step(5.0 + 1.2 * h.y, hm) * step(hm, 6.8 + 0.8 * h.x) * step(0.55, h.x));
  return lit * step(0.3, fract(h.x * 7.3 + h.y * 3.1));
}

fn paint(h: f32) -> vec3f {
  var pal = array<vec3f, 6>(vec3f(0.24, 0.42, 0.31), vec3f(0.18, 0.31, 0.44), vec3f(0.45, 0.2, 0.17),
                            vec3f(0.30, 0.42, 0.42), vec3f(0.5, 0.43, 0.22), vec3f(0.2, 0.22, 0.25));
  return lin(pal[i32(floor(clamp(h, 0.0, 0.999) * 6.0))]);
}

fn facade(sIn: Surface, fw: vec2f) -> Surface {
  var s = sIn;
  let w = max(fw * 0.7, vec2f(0.004));
  let cell = floor(s.uv);
  let f = fract(s.uv);
  let hid = floor(cell.x / 32.0);
  let hr = hash21(vec2f(hid * 0.123, 1.7));
  let hr2 = hash21(vec2f(hid * 0.311, 5.3));
  let wallC = s.color * (0.93 + 0.12 * noise2(vec2f(s.pos.x + s.pos.y, s.pos.z) * 1.3));
  let trim = mix(s.color, vec3f(0.86, 0.84, 0.8), 0.7);
  var c = wallC;
  var glass = 0.0;
  var lit = 0.0;
  var litCol = mix(vec3f(1.0, 0.62, 0.3), vec3f(1.0, 0.8, 0.55), hash21(cell + 0.5));
  var inside = lin(vec3f(0.07, 0.085, 0.1));
  if (cell.y >= 1.0) {
    let win = rectAA(f, vec2f(0.5 - WHW, WB), vec2f(0.5 + WHW, WT), w);
    let frm = rectAA(f, vec2f(0.5 - WHW - 0.035, WB - 0.02), vec2f(0.5 + WHW + 0.035, WT + 0.03), w);
    c = mix(c, trim, frm);
    if (hr < 0.55) {
      let sh = rectAA(f, vec2f(0.5 - WHW - 0.17, WB), vec2f(0.5 - WHW - 0.04, WT), w)
             + rectAA(f, vec2f(0.5 + WHW + 0.04, WB), vec2f(0.5 + WHW + 0.17, WT), w);
      c = mix(c, paint(hr2), sh);
    }
    let bx = 1.0 - smoothstep(0.012, 0.012 + w.x, abs(f.x - 0.5));
    let by = 1.0 - smoothstep(0.012, 0.012 + w.y, abs(f.y - 0.67));
    let bars = max(bx, by) * win;
    glass = win - bars;
    c = mix(c, trim, bars);
    lit = windowLit(cell, s.t);
    // curtains in some windows
    let cur = step(0.6, hash21(cell + 9.1)) * smoothstep(WHW - 0.075, WHW - 0.055, abs(f.x - 0.5));
    inside = mix(inside, lin(vec3f(0.55, 0.5, 0.42)) * 0.3, cur);
    litCol = mix(litCol, litCol * vec3f(1.0, 0.8, 0.7), cur);
    let band = 1.0 - smoothstep(0.025, 0.025 + w.y, f.y);
    c = mix(c, trim * 0.92, band * step(0.4, hr2));
    // the top of the glass sits in the shade of the lintel
    s.sun *= 1.0 - 0.6 * glass * smoothstep(WT - 0.12, WT - 0.02, f.y);
  } else {
    let isDoor = hash21(cell + vec2f(3.1, 0.7)) < 0.3;
    if (isDoor) {
      let dfr = rectAA(f, vec2f(0.3, 0.0), vec2f(0.7, 0.66), w);
      let d = rectAA(f, vec2f(0.33, 0.0), vec2f(0.67, 0.62), w);
      let fan = rectAA(f, vec2f(0.36, 0.53), vec2f(0.64, 0.6), w);
      let panel = rectAA(f, vec2f(0.37, 0.08), vec2f(0.63, 0.48), w);
      c = mix(c, trim, dfr);
      c = mix(c, paint(fract(hr2 + 0.37)) * (0.75 + 0.15 * panel), d);
      glass = fan;
      lit = step(0.5, hr) * nightOf(s.t);
    } else {
      let sfr = rectAA(f, vec2f(0.06, 0.08), vec2f(0.94, 0.74), w);
      let sw = rectAA(f, vec2f(0.1, 0.12), vec2f(0.9, 0.7), w);
      c = mix(c, trim * 0.85, sfr);
      glass = sw;
      // a shop interior: shelves and goods
      let shelf = 1.0 - smoothstep(0.012, 0.012 + w.y, abs(fract((f.y - 0.12) / 0.58 * 3.0) - 0.5) * 0.19);
      let goods = noise2(f * vec2f(14.0, 5.0) + cell * 3.1);
      inside = lin(vec3f(0.2, 0.17, 0.14) * (0.75 + 0.5 * goods));
      inside = mix(inside, lin(vec3f(0.4, 0.34, 0.27)), shelf * 0.5);
      // shops stay open into the evening
      let h = hours(s.t);
      lit = step(0.3, hr2) * step(16.5 + hr * 1.5, h) * step(h, 21.5 + hr2 * 2.0);
      litCol = lin(mix(vec3f(0.95, 0.8, 0.6), vec3f(0.95, 0.7, 0.45), hr)) * (0.25 + 0.6 * goods) * (1.0 - 0.5 * shelf);
    }
    let fascia = rectAA(f, vec2f(-0.1, 0.79), vec2f(1.1, 0.93), w) * step(0.35, hr2);
    c = mix(c, paint(fract(hr * 3.7)) * 0.8, fascia);
    let plinth = 1.0 - smoothstep(0.06, 0.06 + w.y, f.y);
    c = mix(c, lin(vec3f(0.42, 0.4, 0.38)), plinth);
  }
  let glassC = mix(inside, litCol * 0.9, lit);
  s.color = mix(c, glassC, glass);
  s.emissive = glass * lit * select(1.7, 1.2, cell.y < 1.0);
  s.gloss = mix(0.08, mix(0.6, 0.2, lit), glass);
  return s;
}

fn roofTiles(sIn: Surface, fw: vec2f) -> Surface {
  var s = sIn;
  let q = s.uv / vec2f(0.24, 0.3);
  let row = floor(q.y);
  let qx = q.x + 0.5 * (row - 2.0 * floor(row * 0.5));
  let fy = fract(q.y);
  let w = max(fw.y / 0.3, 1e-3);
  let fade = 1.0 - smoothstep(0.15, 0.6, w);
  let ridge = smoothstep(0.0, 0.25 + w, fy);
  let h = hash21(vec2f(floor(qx), row));
  s.color = s.color * mix(1.0, (0.72 + 0.28 * ridge) * (0.85 + 0.3 * h), fade);
  s.gloss = 0.18;
  return s;
}

fn ashlar(sIn: Surface, fw: vec2f, sz: vec2f) -> Surface {
  var s = sIn;
  let q = s.uv / sz;
  let row = floor(q.y);
  let qx = q.x + 0.5 * (row - 2.0 * floor(row * 0.5));
  let cell = vec2f(floor(qx), row);
  let f = vec2f(fract(qx), fract(q.y));
  let w = max(fw / sz, vec2f(1e-3));
  let fade = 1.0 - smoothstep(0.08, 0.3, max(w.x, w.y));
  let joint = 1.0 - rectAA(f, vec2f(0.015, 0.03), vec2f(0.985, 0.97), w);
  let h = hash21(cell);
  s.color = s.color * mix(1.0, (0.9 + 0.18 * h) * (1.0 - 0.3 * joint), fade);
  return s;
}

// paving: setts in staggered rows; returns (joint, random)
fn setts(p: vec2f, sz: vec2f, px: f32) -> vec2f {
  let q = p / sz;
  let row = floor(q.y);
  let qx = q.x + 0.5 * (row - 2.0 * floor(row * 0.5));
  let f = vec2f(fract(qx), fract(q.y));
  let e = min(min(f.x, 1.0 - f.x) * sz.x, min(f.y, 1.0 - f.y) * sz.y);
  let joint = (1.0 - smoothstep(0.008, 0.008 + px * 1.2, e)) * (1.0 - smoothstep(0.02, 0.07, px));
  return vec2f(joint, hash21(vec2f(floor(qx), row)));
}
fn cobbles(p: vec2f, px: f32) -> vec3f {
  let st = setts(p, vec2f(0.17, 0.14), px);
  return lin(vec3f(0.5, 0.48, 0.45)) * (0.85 + 0.25 * st.y) * (1.0 - 0.35 * st.x);
}
fn slabs(p: vec2f, px: f32, sz: vec2f) -> vec3f {
  let st = setts(p, sz, px);
  return lin(vec3f(0.66, 0.63, 0.58)) * (0.92 + 0.12 * st.y) * (1.0 - 0.3 * st.x);
}

fn ground(sIn: Surface, fwp: vec3f) -> Surface {
  var s = sIn;
  let p = s.pos.xy;
  let px = max(fwp.x, fwp.y);
  let ax = abs(p.x); let ay = abs(p.y);
  var c = cobbles(p, px);
  var gl = 0.12;
  let inside = p.x > ${f1(WALL.x0)} && p.x < ${f1(WALL.x1)} && ay < ${f1(WALL.y)};
  if (!inside) {
    // meadow outside the walls, with worn paths along the wall
    let n = fbm2(p * 0.08);
    c = mix(lin(vec3f(0.30, 0.40, 0.18)), lin(vec3f(0.42, 0.47, 0.22)), n);
    c *= 0.9 + 0.2 * noise2(p * 1.7);
    let nearWall = (1.0 - smoothstep(4.0, 5.5, abs(p.x + 244.0))) * (1.0 - step(118.0, ay));
    // the tram loop's bed: a rounded rectangle, and the run in from the gate
    let q = abs(p - vec2f(-278.0, 0.0)) - vec2f(8.0, 2.0);
    let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 8.0;
    let yl = ${f1(TRAM_Y)} + 7.9 * clamp((-246.0 - p.x) / 16.0, 0.0, 1.0);
    let lead = (1.0 - smoothstep(2.4, 3.2, abs(ay - yl))) * step(-262.0, p.x);
    let bed = max(1.0 - smoothstep(2.4, 3.2, abs(sd)), lead);
    let gravel = lin(vec3f(0.55, 0.5, 0.42)) * (0.85 + 0.3 * noise2(p * 6.0));
    c = mix(c, gravel, max(nearWall, bed) * step(p.x, ${f1(WALL.x0)}));
    gl = 0.05;
  } else if (ax < ${f1(SQ)} && ay < ${f1(SQ)}) {
    let m = max(ax, ay);
    if (m > ${f1(SQ - 3.5)}) {
      // pavement of big slabs along the houses, with a granite kerb
      c = slabs(p, px, vec2f(0.9, 0.6));
      let kerb = 1.0 - smoothstep(0.18, 0.18 + px, abs(m - ${f1(SQ - 3.5)}));
      c = mix(c, lin(vec3f(0.5, 0.5, 0.52)), kerb);
    } else {
      // setts with light stone bands: rings and a star round the tower, a grid beyond
      let r = length(p);
      var band = 0.0;
      band = max(band, 1.0 - smoothstep(0.22, 0.22 + px, abs(r - 8.5)));
      band = max(band, 1.0 - smoothstep(0.22, 0.22 + px, abs(r - 13.0)));
      let a = atan2(p.y, p.x);
      let rad = abs(fract(a / TAU * 16.0 + 0.5) - 0.5) * TAU / 16.0 * r;
      band = max(band, (1.0 - smoothstep(0.14, 0.14 + px, rad)) * step(8.5, r) * step(r, 13.0));
      let g = abs(fract(p / 9.0 + 0.5) - 0.5) * 9.0;
      band = max(band, (1.0 - smoothstep(0.12, 0.12 + px, min(g.x, g.y))) * step(13.0, r) * 0.7);
      c = mix(c, lin(vec3f(0.7, 0.67, 0.6)), band);
    }
  } else if (p.x < -${f1(SQ)} && p.x > ${f1(GATE_X - 12)} && ay < ${f1(AW)}) {
    if (ay > 9.0) {
      c = slabs(p, px, vec2f(0.6, 0.6));
      let kerb = 1.0 - smoothstep(0.15, 0.15 + px, abs(ay - 9.0));
      c = mix(c, lin(vec3f(0.5, 0.5, 0.52)), kerb);
    } else if (ay > 7.0) {
      // strip of fine gravel for the trees and lamps
      c = lin(vec3f(0.6, 0.55, 0.46)) * (0.85 + 0.25 * noise2(p * 9.0));
    } else if (ay > ${f1(BIKE_Y - 0.85)} && ay < ${f1(BIKE_Y + 0.85)}) {
      c = lin(vec3f(0.55, 0.3, 0.25)) * (0.92 + 0.1 * noise2(p * 3.0));
      let edge = 1.0 - smoothstep(0.05, 0.05 + px, abs(abs(ay - ${f1(BIKE_Y)}) - 0.76));
      c = mix(c, lin(vec3f(0.85, 0.83, 0.78)), edge);
      gl = 0.08;
    } else if (ay < 3.4) {
      // tram bed: dark basalt setts
      let st = setts(p, vec2f(0.2, 0.15), px);
      c = lin(vec3f(0.33, 0.33, 0.34)) * (0.85 + 0.25 * st.y) * (1.0 - 0.35 * st.x);
    }
    // zebra crossing
    if (abs(p.x - ${f1(CROSS_X)}) < 2.0 && ay < 9.0) {
      let z = 1.0 - smoothstep(0.25, 0.25 + px, abs(fract(p.y / 1.0) - 0.5));
      c = mix(c, lin(vec3f(0.88, 0.87, 0.83)), z * 0.9);
    }
  }
  s.color = c;
  s.gloss = gl;
  return s;
}

fn clockFace(sIn: Surface, fw: vec2f) -> Surface {
  var s = sIn;
  let q = (s.uv - 0.5) * 2.0;
  let r = length(q);
  let aa = max(max(fw.x, fw.y) * 2.0, 1e-3);
  let hr = hours(s.t);
  let ah = fract(hr / 12.0) * TAU;
  let am = fract(hr) * TAU;
  let ang = atan2(q.x, q.y);
  let d12 = abs(fract(ang / TAU * 12.0 + 0.5) - 0.5) * TAU / 12.0 * r;
  let major = abs(fract(ang / TAU * 4.0 + 0.5) - 0.5) < 0.04;
  let tw = select(0.03, 0.055, major);
  let tickH = (1.0 - smoothstep(tw, tw + aa, d12)) * smoothstep(0.66, 0.66 + aa, r) * (1.0 - smoothstep(0.86, 0.86 + aa, r));
  let d60 = abs(fract(ang / TAU * 60.0 + 0.5) - 0.5) * TAU / 60.0 * r;
  let tickM = (1.0 - smoothstep(0.009, 0.009 + aa, d60)) * smoothstep(0.8, 0.8 + aa, r) * (1.0 - smoothstep(0.86, 0.86 + aa, r));
  let ring = (1.0 - smoothstep(0.012, 0.012 + aa, abs(r - 0.89)));
  let dh = vec2f(sin(ah), cos(ah));
  let dm = vec2f(sin(am), cos(am));
  let hh = 1.0 - smoothstep(0.05, 0.05 + aa, sdSegment(q, -dh * 0.12, dh * 0.5));
  let hm = 1.0 - smoothstep(0.03, 0.03 + aa, sdSegment(q, -dm * 0.16, dm * 0.8));
  let boss = 1.0 - smoothstep(0.07, 0.07 + aa, r);
  let ink = max(max(tickH, tickM), max(ring, max(hh, hm)));
  s.color = mix(lin(vec3f(0.94, 0.91, 0.82)), lin(vec3f(0.05, 0.05, 0.06)), ink);
  s.color = mix(s.color, lin(vec3f(0.85, 0.62, 0.22)), boss);
  s.emissive = (1.0 - ink) * (1.0 - boss) * nightOf(s.t) * 1.4;
  s.gloss = 0.3;
  return s;
}

// tram body: uv.y < 4 on the sides (uv = along / 1.4, height), 4..8 on the ends
fn tramBody(sIn: Surface, fw: vec2f) -> Surface {
  var s = sIn;
  let w = max(fw, vec2f(0.004));
  let night = nightOf(s.t);
  var glass = 0.0;
  var red = 0.0;
  var sign_ = 0.0;
  let zz = select(s.uv.y, s.uv.y - 4.0, s.uv.y >= 4.0);
  if (s.uv.y < 4.0) {
    let z = s.uv.y;
    let f = fract(s.uv.x);
    glass = rectAA(vec2f(f, z), vec2f(0.07, 1.4), vec2f(0.93, 2.45), vec2f(w.x, w.y));
    red = rectAA(vec2f(0.5, z), vec2f(0.0, 0.45), vec2f(1.0, 1.05), w) + rectAA(vec2f(0.5, z), vec2f(0.0, 2.62), vec2f(1.0, 2.72), w);
  } else {
    let z = s.uv.y - 4.0;
    let x = s.uv.x - 1.2;
    glass = rectAA(vec2f(x, z), vec2f(-1.0, 1.35), vec2f(1.0, 2.45), w);
    sign_ = rectAA(vec2f(x, z), vec2f(-0.75, 2.55), vec2f(0.75, 2.82), w);
    red = rectAA(vec2f(x, z), vec2f(-2.0, 0.45), vec2f(2.0, 1.05), w);
  }
  s.color = mix(s.color, lin(vec3f(0.62, 0.12, 0.1)), red);
  let lamp = vec3f(1.0, 0.82, 0.58) * (0.35 + 0.3 * smoothstep(1.4, 2.45, zz));
  let inside = mix(lin(vec3f(0.06, 0.07, 0.08)), lamp, night);
  s.color = mix(s.color, inside, glass);
  s.emissive = glass * night * 1.1;
  s.gloss = mix(0.45, 0.8, glass);
  s.color = mix(s.color, vec3f(1.0, 0.55, 0.1), sign_);
  s.emissive = max(s.emissive, sign_ * 4.0);
  return s;
}

// Scalloped valances: on the shop awnings, the market stalls and the
// parasols (tag 1: uv.x in metres along the edge, a tongue every 0.275 m, one
// to a stripe of the awnings; uv.y from 0 at the top to 1 at the bottom), and
// on the carousel (tag 2: its own uv, the tongues turning with the stripes).
// Where a tongue is only a few pixels wide they give way to a plain edge.
fn cutout(s: Surface) -> f32 {
  let fw = fwidth(s.uv.x);
  if (s.tag == 0u || s.tag > 2u) { return 1.0; }
  var q = vec2f(s.uv.x / 0.275, s.uv.y);   // tongues across, top to bottom
  var fq = fw / 0.275;
  if (s.tag == 2u) {
    q = vec2f((s.uv.x + s.t / 20.0) * 32.0 + 0.5, 1.0 - s.uv.y);
    fq = fw * 32.0;
  }
  let u = (fract(q.x + 0.5) - 0.5) * 2.0;   // -1..1 across a tongue
  let v = (q.y - 0.5) * 2.0;                // 0..1 down its lower half
  let d = select(0.0, length(vec2f(u, v)), v > 0.0);
  let tongue = saturate((1.0 - d) * 6.0 + 0.5);
  return mix(tongue, saturate((0.9 - q.y) * 12.0 + 0.5), smoothstep(0.11, 0.25, fq));
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  // derivatives first, before any branching
  let fwu = fwidth(s.uv);
  let fwp = fwidth(s.pos);
  let night = nightOf(s.t);
  var lamps = true;
  if (s.mat == ${MAT.GROUND}u) {
    s = ground(s, fwp);
  } else if (s.mat == ${MAT.FACADE}u) {
    s = facade(s, fwu);
  } else if (s.mat == ${MAT.WALL}u || s.mat == ${MAT.GABLE}u) {
    s.color *= (0.93 + 0.12 * noise2(vec2f(s.pos.x + s.pos.y, s.pos.z) * 1.3)) * (0.82 + 0.18 * smoothstep(0.0, 1.2, s.pos.z));
    if (s.mat == ${MAT.GABLE}u) {
      // a round attic window
      let r = length(s.uv);
      let ww = max(max(fwu.x, fwu.y), 0.004);
      let win = 1.0 - smoothstep(0.42, 0.42 + ww, r);
      let frame = 1.0 - smoothstep(0.52, 0.52 + ww, r);
      let lit = windowLit(floor(s.pos.xy * 0.37), s.t) * 0.7;
      s.color = mix(s.color, vec3f(0.75, 0.72, 0.68), frame);
      s.color = mix(s.color, mix(lin(vec3f(0.07, 0.085, 0.1)), vec3f(1.0, 0.7, 0.4), lit), win);
      s.emissive = win * lit * 2.0;
      s.gloss = mix(0.08, 0.7, win);
    }
  } else if (s.mat == ${MAT.ROOF}u) {
    s = roofTiles(s, fwu);
  } else if (s.mat == ${MAT.STONE}u) {
    var fw = fwu;
    if (s.inst.w > 0.5) {
      // instanced merlons: stones laid out by world position, as metricUV() does for the rest
      let an = abs(s.n);
      if (an.z >= an.x && an.z >= an.y) { s.uv = s.pos.xy; fw = fwp.xy; }
      else if (an.x >= an.y) { s.uv = vec2f(s.pos.y * sign(s.n.x), s.pos.z); fw = fwp.yz; }
      else { s.uv = vec2f(-s.pos.x * sign(s.n.y), s.pos.z); fw = fwp.xz; }
    }
    s = ashlar(s, fw, vec2f(0.9, 0.45));
  } else if (s.mat == ${MAT.TOWER}u) {
    s = ashlar(s, fwu, vec2f(1.1, 0.55));
    // tall round-headed windows lighting the stair inside the shaft
    let ap = abs(s.pos.xy);
    if (max(ap.x, ap.y) < 4.56 && s.pos.z < 29.5 && abs(s.n.z) < 0.5) {
      let ww = max(fwu, vec2f(0.004));
      var win = 0.0;
      for (var k = 0; k < 2; k++) {
        let zb = 12.5 + f32(k) * 9.0;
        let q = vec2f(s.uv.x, s.uv.y - zb - 1.9);
        let shape = select(1.0 - smoothstep(0.42, 0.42 + ww.x, abs(q.x)), 1.0 - smoothstep(0.42, 0.42 + ww.x, length(q)), q.y > 0.0);
        win = max(win, shape * step(zb, s.uv.y));
      }
      let lit = night * step(0.35, hash21(floor(s.pos.xy * 0.2) + floor(s.uv.y / 9.0)));
      s.color = mix(s.color, mix(lin(vec3f(0.06, 0.06, 0.07)), vec3f(1.0, 0.7, 0.4), lit), win);
      s.emissive = win * lit * 1.8;
      s.gloss = mix(s.gloss, 0.6, win);
    }
    // floodlit from the foot of the tower at night
    let facing = max(s.n.x * sign(s.pos.x) + s.n.y * sign(s.pos.y), 0.0);
    s.light += LAMP_COL * (1.1 * night * exp(-s.pos.z / 28.0) * (0.3 + 0.7 * facing));
  } else if (s.mat == ${MAT.CLOCK}u) {
    s = clockFace(s, fwu);
    lamps = false;
  } else if (s.mat == ${MAT.LAMP}u) {
    let on = lampOn(s.t, lampIndex(s.pos));
    s.color = mix(lin(vec3f(0.55, 0.5, 0.42)), lin(vec3f(1.0, 0.8, 0.5)), on);
    s.emissive = on * 9.0;
    s.gloss = 0.6;
    lamps = false;
  } else if (s.mat == ${MAT.BULB}u) {
    s.emissive = 2.5 + 9.0 * night;
    lamps = false;
  } else if (s.mat == ${MAT.NEON}u) {
    s.emissive = 1.0 + 5.0 * night;
    lamps = false;
  } else if (s.mat == ${MAT.LEAF}u) {
    s.color *= 0.85 + 0.3 * noise3(s.pos * 2.3);
    s.ambient = 0.85;
  } else if (s.mat == ${MAT.DOOR}u) {
    // an arched wooden door, uv in metres from its foot
    let ww = max(fwu, vec2f(0.004));
    let q = s.uv - vec2f(0.0, 2.6);
    let arch = select(1.0 - smoothstep(1.1, 1.1 + ww.x, abs(s.uv.x)), 1.0 - smoothstep(1.1, 1.1 + ww.x, length(q)), s.uv.y > 2.6);
    let planks = 0.85 + 0.15 * smoothstep(0.0, 0.03, abs(fract(s.uv.x * 3.0) - 0.5));
    s.color = mix(s.color, lin(vec3f(0.3, 0.18, 0.1)) * planks, arch);
    s.light += LAMP_COL * (1.1 * night * exp(-s.pos.z / 28.0));
  } else if (s.mat == ${MAT.WATER}u) {
    // ripples running out from the jets
    let q = s.pos.xy - FOUNTAIN;
    let r = max(length(q), 0.01);
    let wave = sin(r * 5.0 - s.t * 4.0) * 0.6 + sin(r * 9.0 - s.t * 7.0 + 1.3) * 0.4;
    s.n = normalize(vec3f(q / r * wave * 0.12 + (vec2f(noise2(s.pos.xy * 3.0 + s.t), noise2(s.pos.yx * 3.0 - s.t)) - 0.5) * 0.15, 1.0));
    s.color = lin(vec3f(0.1, 0.24, 0.27));
    s.gloss = 0.92;
    s.emissive = night * 0.8 * (0.7 + 0.3 * wave);
  } else if (s.mat == ${MAT.JET}u) {
    s.color *= 0.85 + 0.15 * sin(s.pos.z * 9.0 - s.t * 14.0);
    s.emissive = 0.35 + 2.2 * night;
    s.gloss = 0.6;
    lamps = false;
  } else if (s.mat == ${MAT.CURTAIN}u) {
    // a falling sheet of water (additive): streaks running down
    let a = atan2(s.pos.y - FOUNTAIN.y, s.pos.x - FOUNTAIN.x);
    let streak = 0.5 + 0.5 * sin(a * 40.0 + 3.0 * sin(a * 7.0)) * sin(s.pos.z * 6.0 + s.t * 9.0);
    s.emissive = (0.06 + 0.22 * streak * streak) * (1.0 + 1.2 * night);
    lamps = false;
  } else if (s.mat == ${MAT.AWNING}u) {
    let ww = max(fwu.x, 0.004);
    let st = smoothstep(0.25 - ww, 0.25 + ww, abs(fract(s.uv.x / 0.55) - 0.5));
    s.color = mix(s.color, lin(vec3f(0.93, 0.9, 0.84)), st);
  } else if (s.mat == ${MAT.CANOPY}u) {
    // the carousel's stripes turn with it, a turn every 20 s
    let u = fract(s.uv.x + s.t / 20.0);
    let st = step(0.5, fract(u * 16.0));
    s.color = mix(lin(vec3f(0.75, 0.12, 0.12)), lin(vec3f(0.95, 0.88, 0.7)), st);
    s.gloss = 0.3;
  } else if (s.mat == ${MAT.TRAM}u) {
    s = tramBody(s, fwu);
  } else if (s.mat == ${MAT.GLASS}u) {
    // see-through glass: clear face on, more of a mirror at a glancing angle
    s.gloss = 0.9;
    let fr = 1.0 - abs(dot(s.n, s.view));
    s.alpha = mix(s.alpha, 0.9, fr * fr * fr * fr);
  } else if (s.mat == ${MAT.DISPLAY}u) {
    // tram stop: seconds until the next tram passes on this side
    let T0 = select(STOP_T_E, STOP_T_W, s.pos.y > 0.0);
    let left = T0 - s.t;
    let secs = left - TRAM_EVERY * floor(left / TRAM_EVERY);
    let on = number7((s.uv - vec2f(0.12, 0.15)) / vec2f(0.76, 0.7), floor(secs), 2);
    s.color = mix(vec3f(0.01), vec3f(1.0, 0.55, 0.08), on);
    s.emissive = on * 5.0;
    lamps = false;
  }
  if (lamps) { s.light += lampLight(s.pos, s.n, s.t); }
  return s;
}
`;

// ---------------------------------------------------------------------------
// geometry helpers

// Sets every vertex's uv from its position (and normal).
function uvFrom(g, fn) {
  for (let i = 0; i < g.vertexCount; i++) {
    const uv = fn([g.p[i * 3], g.p[i * 3 + 1], g.p[i * 3 + 2]], [g.n[i * 3], g.n[i * 3 + 1], g.n[i * 3 + 2]]);
    g.uv[i * 2] = uv[0]; g.uv[i * 2 + 1] = uv[1];
  }
  return g;
}

// uv in metres in the plane the face mostly lies in (for stone and paving).
const metricUV = (g) => uvFrom(g, (p, n) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return [p[0], p[1]];
  if (ax >= ay) return [p[1] * Math.sign(n[0] || 1), p[2]];
  return [-p[0] * Math.sign(n[1] || 1), p[2]];
});

// A quad in the plane y = 0 facing -y, x in [x0, x1], z in [z0, z1].
const vquad = (x0, x1, z0, z1) => Geo.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]);

// A quad through four points, turned to face along n.
function quadN(p0, p1, p2, p3, n) {
  const q = Geo.quad(p0, p1, p2, p3);
  if (q.n[0] * n[0] + q.n[1] * n[1] + q.n[2] * n[2] < 0) q.flip();
  return q;
}

// A flat ring in the XY plane facing +Z.
function annulus(r0, r1, seg) {
  const g = new Geo();
  for (let i = 0; i <= seg; i++) {
    const a = 2 * Math.PI * i / seg, c = Math.cos(a), s = Math.sin(a);
    g.vert(c * r0, s * r0, 0, 0, 0, 1, 0.5 + 0.5 * c * r0 / r1, 0.5 + 0.5 * s * r0 / r1);
    g.vert(c * r1, s * r1, 0, 0, 0, 1, 0.5 + 0.5 * c, 0.5 + 0.5 * s);
  }
  for (let i = 0; i < seg; i++) g.quadIdx(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  return g.orientByNormals();
}

// A box from one point to another (a beam, a pole, a string).
function beam(a, b, w, h = w) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  return Geo.box(w, L, h).transform(m4.facing([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], d, Math.abs(d[2]) > 0.99 * L ? [1, 0, 0] : [0, 0, 1]));
}
// the same, as a placement of a unit cube
function beamM(a, b, w, h = w) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  return m4.mul(m4.facing([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], d, Math.abs(d[2]) > 0.99 * L ? [1, 0, 0] : [0, 0, 1]), m4.scaling(w, L, h));
}

// Plain boxes.  Every box in the town that has nothing but a colour (sills,
// lintels, cornices, ridges, chimneys, brackets, benches, market stalls,
// chairs, the strings of the bunting...) is a copy of one unit cube, placed,
// stretched and tinted: a few thousand of them, drawn with one b.instances call.
// A list of plain boxes is [[matrix, colour], ...]; addBoxes() hands one to the
// scene, moved by m.
const boxM = (sx, sy, sz, x = 0, y = 0, z = 0) => m4.mul(m4.translation(x, y, z), m4.scaling(sx, sy, sz));
let BOXES = [];
// Merlons on the gate and the city wall are unit cubes of stone in the same
// way (data 1 tells the shader to lay out their stones by world position).
let MERLONS = [];
function addBoxes(list, m = null) {
  for (const [bm, c] of list) BOXES.push({ transform: m ? m4.mul(m, bm) : bm, tint: c });
}

// A flat strip along a 2D polyline at height z, between offsets o0 and o1 to its left.
function ribbon(pts, o0, o1, z, closed = false) {
  const g = new Geo();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    g.vert(pts[i][0] + nx * o0, pts[i][1] + ny * o0, z, 0, 0, 1, 0, 0);
    g.vert(pts[i][0] + nx * o1, pts[i][1] + ny * o1, z, 0, 0, 1, 1, 0);
  }
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % n;
    g.quadIdx(i * 2, i * 2 + 1, j * 2 + 1, j * 2);
  }
  return g.orientByNormals();
}

// A wall of width W (x), height H, thickness T (y in [0, T], front facing -y)
// with round-headed openings [{ c, r, spring }]: centre, half-width, and the
// height at which the arch starts.
function archWall(W, H, T, openings, seg = 10) {
  const front = new Geo();
  const inner = new Geo();
  let x = 0;
  for (const o of openings.slice().sort((a, b) => a.c - b.c)) {
    const x0 = o.c - o.r, x1 = o.c + o.r;
    if (x0 > x + 1e-6) front.add(vquad(x, x0, 0, H));
    for (let i = 0; i < seg; i++) {
      const a0 = Math.PI * (1 - i / seg), a1 = Math.PI * (1 - (i + 1) / seg);
      const p0 = [o.c + o.r * Math.cos(a0), o.spring + o.r * Math.sin(a0)];
      const p1 = [o.c + o.r * Math.cos(a1), o.spring + o.r * Math.sin(a1)];
      front.add(Geo.quad([p0[0], 0, p0[1]], [p1[0], 0, p1[1]], [p1[0], 0, H], [p0[0], 0, H]));
      const am = (a0 + a1) / 2;
      inner.add(quadN([p0[0], 0, p0[1]], [p0[0], T, p0[1]], [p1[0], T, p1[1]], [p1[0], 0, p1[1]], [-Math.cos(am), 0, -Math.sin(am)]));
    }
    inner.add(quadN([x0, 0, 0], [x0, T, 0], [x0, T, o.spring], [x0, 0, o.spring], [1, 0, 0]));
    inner.add(quadN([x1, 0, 0], [x1, 0, o.spring], [x1, T, o.spring], [x1, T, 0], [-1, 0, 0]));
    x = x1;
  }
  if (x < W - 1e-6) front.add(vquad(x, W, 0, H));
  const g = new Geo();
  g.add(front);
  g.add(front.clone().translate(0, T, 0).flip());
  g.add(inner);
  g.add(quadN([0, 0, 0], [0, T, 0], [0, T, H], [0, 0, H], [-1, 0, 0]));
  g.add(quadN([W, 0, 0], [W, 0, H], [W, T, H], [W, T, 0], [1, 0, 0]));
  g.add(quadN([0, 0, H], [W, 0, H], [W, T, H], [0, T, H], [0, 0, 1]));
  return g;
}

// Places a mesh built in a local frame (x along a row, y inwards, z up).
const placeM = (origin, e, inward, z = 0) => m4.fromBasis([e[0], e[1], 0], [inward[0], inward[1], 0], [0, 0, 1], [origin[0], origin[1], z]);

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (p, s) => (p >> s) & 255;
  const m = (s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t);
  return '#' + ((m(16) << 16) | (m(8) << 8) | m(0)).toString(16).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// houses

const WALL_COLORS = ['#ead9b6', '#e6c28c', '#dc9e6e', '#d28462', '#e8baa3', '#c9735a', '#f1e7d0', '#d9c290',
  '#bccaa8', '#abc1cb', '#e4d08f', '#d8a97c', '#c9a5a2', '#e9dcc5', '#b5b9cf', '#e0b06a'];
const ROOF_COLORS = ['#8e4c34', '#7b402d', '#9b5b3d', '#6e3b2b', '#5d6269', '#50555c', '#874a3a'];
const AWNING_COLORS = ['#b8342c', '#2f6a4a', '#2b4f7c', '#c27a1e', '#6b2f5a', '#3a3a3a'];

// One house in its local frame: the street front in the plane y = 0 facing
// -y, x in [0, w], depth y in [0, d].
//   o: w, d, floors, g0 (ground floor height), sh (storey height), bays,
//      roof ('side' | 'front' | 'step' | 'flat'), pitch, wall, roofCol, hid,
//      left/right: side walls with windows, back: back wall with windows,
//      sills: 3D sills and lintels at the front windows, awning: a colour
function makeHouse(o) {
  const { w, d, floors, g0, sh, bays, roof, hid } = o;
  const H = g0 + floors * sh;
  const g = new Geo();
  const boxes = []; // plain boxes, in the same frame
  const box = (sx, sy, sz, x, y, z, c) => boxes.push([boxM(sx, sy, sz, x, y, z), c]);
  const wallCol = o.wall, trim = mixHex(o.wall, '#f2eee6', 0.55);
  const face = (W, u0, nb, mat) => {
    const bw = W / nb;
    const f = new Geo();
    f.add(vquad(0, W, 0, g0));
    if (floors > 0) f.add(vquad(0, W, g0, H));
    uvFrom(f, (p) => [p[0] / bw + u0, p[2] <= g0 + 1e-6 ? p[2] / g0 : 1 + (p[2] - g0) / sh]);
    return f.mat(mat).color(wallCol);
  };
  const sideBays = Math.max(2, Math.round(d / 2.7));
  g.add(face(w, hid * 32, bays, MAT.FACADE));
  g.add(face(w, hid * 32 + 16, bays, o.back === false ? MAT.WALL : MAT.FACADE).transform(m4.mul(m4.translation(w, d, 0), m4.rotationZ(Math.PI))));
  g.add(face(d, hid * 32 + 24, sideBays, o.left ? MAT.FACADE : MAT.WALL).transform(m4.mul(m4.translation(0, d, 0), m4.rotationZ(-Math.PI / 2))));
  g.add(face(d, hid * 32 + 28, sideBays, o.right ? MAT.FACADE : MAT.WALL).transform(m4.mul(m4.translation(w, 0, 0), m4.rotationZ(Math.PI / 2))));

  const roofG = new Geo();
  const gable = new Geo();
  const tan = Math.tan(o.pitch);
  const oculus = (rh) => (p) => (rh > 2.6 ? [p[0] - w / 2, p[2] - (H + Math.min(rh * 0.36, 1.7))] : [9, 9]);
  if (roof === 'side') {
    const rh = d / 2 * tan, ov = 0.45, zE = H - ov * tan, zR = H + rh;
    const slope = Math.hypot(d / 2 + ov, zR - zE);
    roofG.add(uvFrom(Geo.quad([0, -ov, zE], [w, -ov, zE], [w, d / 2, zR], [0, d / 2, zR]), (p) => [p[0], (p[1] + ov) / (d / 2 + ov) * slope]));
    roofG.add(uvFrom(Geo.quad([w, d + ov, zE], [0, d + ov, zE], [0, d / 2, zR], [w, d / 2, zR]), (p) => [p[0], (d + ov - p[1]) / (d / 2 + ov) * slope]));
    gable.add(Geo.triangle([0, d, H], [0, 0, H], [0, d / 2, zR]));
    gable.add(Geo.triangle([w, 0, H], [w, d, H], [w, d / 2, zR]));
    box(w, 0.32, 0.22, w / 2, d / 2, zR + 0.02, mixHex(o.roofCol, '#000000', 0.25));
    box(w, 0.1, 0.3, w / 2, -ov - 0.03, zE - 0.1, trim);
    // dormers on wide roofs: one window each
    if (o.dormers && w > 6.5) {
      const n = Math.max(1, Math.floor(w / 4.2));
      const dw = 1.5, dh = 1.6, y0 = 1.3, zb = H + (y0 + 0.02) * tan;
      for (let i = 0; i < n; i++) {
        const cx = (i + 0.5) * w / n;
        const dm = new Geo();
        const u0 = hid * 32 + 12 + i;
        dm.add(uvFrom(vquad(-dw / 2, dw / 2, 0, dh), (p) => [(p[0] + dw / 2) / dw + u0, 1.12 + 0.82 * p[2] / dh]).mat(MAT.FACADE).color(wallCol));
        dm.add(quadN([-dw / 2, 0, 0], [-dw / 2, 0, dh], [-dw / 2, 2.6, dh], [-dw / 2, 2.6, 0], [-1, 0, 0]).color(wallCol).mat(MAT.WALL));
        dm.add(quadN([dw / 2, 0, 0], [dw / 2, 2.6, 0], [dw / 2, 2.6, dh], [dw / 2, 0, dh], [1, 0, 0]).color(wallCol).mat(MAT.WALL));
        dm.add(uvFrom(quadN([-dw / 2 - 0.15, -0.2, dh - 0.05], [dw / 2 + 0.15, -0.2, dh - 0.05], [dw / 2 + 0.15, 2.8, dh + 0.35], [-dw / 2 - 0.15, 2.8, dh + 0.35], [0, 0, 1]), (p) => [p[0], p[1]]).color(o.roofCol).mat(MAT.ROOF));
        g.add(dm.translate(cx, y0, zb));
      }
    }
  } else if (roof === 'front' || roof === 'step') {
    const rh = w / 2 * tan, zR = H + rh;
    const ovf = roof === 'step' ? -0.3 : 0.35, ovb = 0.3;
    const slope = Math.hypot(w / 2, rh);
    roofG.add(uvFrom(quadN([0, d + ovb, H], [0, -ovf, H], [w / 2, -ovf, zR], [w / 2, d + ovb, zR], [-rh, 0, w / 2]), (p) => [p[1], p[0] / (w / 2) * slope]));
    roofG.add(uvFrom(quadN([w, -ovf, H], [w, d + ovb, H], [w / 2, d + ovb, zR], [w / 2, -ovf, zR], [rh, 0, w / 2]), (p) => [p[1], (w - p[0]) / (w / 2) * slope]));
    box(0.3, d + ovf + ovb, 0.22, w / 2, (d + ovb - ovf) / 2, zR + 0.02, mixHex(o.roofCol, '#000000', 0.25));
    if (roof === 'front') {
      gable.add(uvFrom(Geo.triangle([0, 0, H], [w, 0, H], [w / 2, 0, zR]), oculus(rh)));
      box(w + 0.1, 0.25, 0.22, w / 2, -0.06, H, trim);
    } else {
      // stepped gable standing up in front of the roof
      const n = w > 8.5 ? 4 : 3;
      const top = rh + 1.0, dz = top / (n + 1), sx = (w / 2 - 0.7) / n;
      for (let k = 0; k <= n; k++) {
        const x0 = k * sx, x1 = w - k * sx, z0 = H + k * dz;
        gable.add(uvFrom(Geo.box(x1 - x0, 0.45, dz).translate((x0 + x1) / 2, 0.2, z0 + dz / 2), oculus(rh)));
        box(x1 - x0 + 0.12, 0.6, 0.12, (x0 + x1) / 2, 0.2, z0 + dz + 0.06, trim);
      }
    }
    gable.add(Geo.triangle([w, d, H], [0, d, H], [w / 2, d, zR]));
  } else {
    // flat roof behind a parapet, with a heavy cornice
    const par = 0.9;
    gable.add(vquad(0, w, H, H + par));
    gable.add(vquad(0, w, H, H + par).transform(m4.mul(m4.translation(w, d, 0), m4.rotationZ(Math.PI))));
    gable.add(quadN([0, 0, H], [0, d, H], [0, d, H + par], [0, 0, H + par], [-1, 0, 0]));
    gable.add(quadN([w, 0, H], [w, 0, H + par], [w, d, H + par], [w, d, H], [1, 0, 0]));
    box(w, d, 0.2, w / 2, d / 2, H + 0.3, '#77736c');
    box(w + 0.02, 0.7, 0.35, w / 2, -0.12, H - 0.05, trim);
    box(w + 0.02, 0.3, 0.2, w / 2, 0.0, H + par, trim);
  }
  g.add(roofG.color(o.roofCol).mat(MAT.ROOF));
  g.add(gable.color(wallCol).mat(roof === 'side' || roof === 'flat' ? MAT.WALL : MAT.GABLE));

  // string course over the shop fronts
  box(w, 0.2, 0.18, w / 2, -0.06, g0 + 0.02, trim);
  // window sills and lintels, in line with the windows the shader draws
  if (o.sills !== false) {
    const bw = w / bays;
    for (let s = 0; s < floors; s++) {
      for (let k = 0; k < bays; k++) {
        const cx = (k + 0.5) * bw, hw = (WIN.hw + 0.05) * bw;
        box(hw * 2, 0.22, 0.09, cx, -0.07, g0 + (s + WIN.b - 0.02) * sh - 0.045, trim);
        box(hw * 2 + 0.1, 0.16, 0.16, cx, -0.04, g0 + (s + WIN.t + 0.03) * sh + 0.08, trim);
      }
    }
  }
  // a striped awning over the shop front
  if (o.awning) {
    const aw = new Geo();
    const z0 = g0 - 0.45, z1 = g0 - 1.25, dy = 1.6;
    aw.add(uvFrom(quadN([0.25, 0, z0], [w - 0.25, 0, z0], [w - 0.25, -dy, z1], [0.25, -dy, z1], [0, -0.45, 1]), (p) => [p[0], 0]));
    // the valance, scalloped (see `cutout` in the shader)
    aw.add(uvFrom(quadN([0.25, -dy, z1], [w - 0.25, -dy, z1], [w - 0.25, -dy, z1 - 0.3], [0.25, -dy, z1 - 0.3], [0, -1, 0]), (p) => [p[0], (z1 - p[2]) / 0.3]).tag(1).cutout());
    g.add(aw.color(o.awning).mat(MAT.AWNING));
    for (const x of [0.3, w - 0.3]) boxes.push([beamM([x, 0, z0 + 0.1], [x, -dy, z1], 0.04), '#2a2a2a']);
  }
  // chimney
  if (o.chimney) {
    const cx = o.chimney * w, cy = roof === 'side' ? d / 2 + 0.8 : d * 0.7;
    const top = roof === 'side' ? H + (d / 2) * tan + 1.0 : roof === 'flat' ? H + 2.0 : H + Math.min(cx, w - cx) * tan + 1.6;
    box(0.7, 0.9, top - H + 0.5, cx, cy, (top + H - 0.5) / 2, '#8a5040');
    box(0.9, 1.1, 0.15, cx, cy, top + 0.07, '#5a4a42');
  }
  return { g, H, boxes };
}

let HOUSE_ID = 1;

// A row of houses along a facade line.
//   start   [x, y] of the left end (seen from the street)
//   nrm     the direction the fronts face
//   length  along the row; gaps: [[a, b], ...] distances left open for lanes
//   ends    [left, right]: whether the end walls are exposed (windows)
//   onHouse called with each house's placement, for extras
function row(b, rand, o) {
  const e = [-o.nrm[1], o.nrm[0]];
  const inward = [-o.nrm[0], -o.nrm[1]];
  const segs = [];
  let a = 0;
  const gaps = (o.gaps || []).slice().sort((x, y) => x[0] - y[0]);
  for (const [g0, g1] of gaps) { segs.push([a, g0, a === 0 ? !!o.ends?.[0] : true, true]); a = g1; }
  segs.push([a, o.length, gaps.length ? true : !!o.ends?.[0], !!o.ends?.[1]]);
  let prevCol = '';
  const minW = o.minW ?? 6.5, maxW = o.maxW ?? 10.5;
  for (const [s0, s1, exL, exR] of segs) {
    const widths = [];
    let rem = s1 - s0;
    while (rem > 0.01) {
      let w = rand.range(minW, maxW);
      if (rem - w < minW) w = rem;
      widths.push(w);
      rem -= w;
    }
    let x = s0;
    widths.forEach((w, i) => {
      const floors = o.floors ? rand.int(o.floors[0], o.floors[1]) : rand.int(2, 4);
      const sh = rand.range(3.05, 3.35), g0 = rand.range(3.9, 4.4);
      let roof = rand.pick(o.roofs || ['side', 'side', 'front', 'front', 'step', 'flat']);
      if (w > 9.8 && roof !== 'side') roof = rand() < 0.5 ? 'side' : 'flat';
      let col = rand.pick(WALL_COLORS);
      while (col === prevCol) col = rand.pick(WALL_COLORS);
      prevCol = col;
      const hid = HOUSE_ID++;
      const { g: house, H, boxes } = makeHouse({
        w, d: o.depth ?? DEPTH, floors, g0, sh, roof, hid,
        bays: Math.max(2, Math.round(w / rand.range(2.4, 2.9))),
        pitch: roof === 'side' ? rand.range(0.62, 0.8) : rand.range(0.85, 1.0),
        wall: col, roofCol: rand.pick(ROOF_COLORS),
        left: exL && i === 0, right: exR && i === widths.length - 1,
        back: o.back ?? true, sills: o.sills ?? true, dormers: rand() < 0.55,
        chimney: rand() < 0.7 ? rand.range(0.2, 0.8) : 0,
        awning: o.awnings && rand() < o.awnings ? rand.pick(AWNING_COLORS) : null,
      });
      const org = [o.start[0] + e[0] * x, o.start[1] + e[1] * x];
      const m = placeM(org, e, inward);
      b.static(house.transform(m));
      addBoxes(boxes, m);
      if (o.onHouse) o.onHouse({ m, w, H, g0, hid, rand });
      x += w;
    });
  }
}

// ---------------------------------------------------------------------------
// street furniture and people

function lampPost() {
  const g = new Geo();
  const iron = '#1e2622';
  g.add(Geo.cylinder(0.22, 0.7, 8, { r2: 0.13 }).color(iron));
  g.add(Geo.cylinder(0.09, 3.6, 8, { r2: 0.07 }).translate(0, 0, 0.7).color(iron));
  g.add(Geo.cylinder(0.16, 0.12, 8).translate(0, 0, 4.2).color(iron));
  g.add(Geo.cylinder(0.12, 0.62, 6, { r2: 0.22 }).translate(0, 0, 4.25).mat(MAT.LAMP).color('#ffe2b0'));
  g.add(Geo.cone(0.36, 0.34, 6).translate(0, 0, 4.86).color(iron));
  g.add(Geo.sphere(0.06, 6, 4).translate(0, 0, 5.24).color(iron));
  return g.gloss(0.3);
}

function tree(rand, h = 7.5) {
  const g = new Geo();
  g.add(Geo.cylinder(0.2, h * 0.55, 6, { r2: 0.12 }).color('#5b4636'));
  const base = rand.pick(['#4c7a37', '#58833c', '#4a7442', '#62873f']);
  for (let i = 0; i < 3; i++) {
    const r = rand.range(1.5, 2.1) * h / 7.5;
    const s = Geo.sphere(r, 9, 6);
    const ox = rand.range(-0.7, 0.7), oy = rand.range(-0.7, 0.7), oz = h * 0.6 + i * 0.7 + rand.range(0, 0.5);
    for (let k = 0; k < s.p.length; k += 3) {
      const [x, y, z] = [s.p[k], s.p[k + 1], s.p[k + 2]];
      const bump = 1 + 0.16 * Math.sin(x * 3.1 + y * 1.7) * Math.cos(z * 2.3 - x) + 0.08 * Math.sin(y * 5.3 + z * 4.1);
      s.p[k] = x * bump; s.p[k + 1] = y * bump; s.p[k + 2] = z * bump * 0.85;
    }
    s.translate(ox, oy, oz);
    s.colorBy((p) => mixHex(base, '#a6b85a', Math.max(0, Math.min(1, (p[2] - oz) / r * 0.35 + 0.15))));
    g.add(s.mat(MAT.LEAF));
  }
  return g;
}

// a bench, as plain boxes
function bench() {
  const g = [];
  const wood = '#8b5e3c', iron = '#2b2b2b';
  for (let i = 0; i < 4; i++) g.push([boxM(1.9, 0.09, 0.05, 0, -0.2 + i * 0.12, 0.46), wood]);
  g.push([boxM(1.9, 0.05, 0.1, 0, 0.27, 0.72), wood]);
  g.push([boxM(1.9, 0.05, 0.1, 0, 0.29, 0.86), wood]);
  for (const x of [-0.8, 0.8]) {
    g.push([boxM(0.06, 0.5, 0.06, x, 0, 0.42), iron]);
    g.push([boxM(0.06, 0.06, 0.45, x, -0.2, 0.22), iron]);
    g.push([boxM(0.06, 0.06, 0.92, x, 0.26, 0.46), iron]);
  }
  return g;
}

const COATS = ['#3b4a6b', '#8a2f2f', '#2f5a45', '#c28a3a', '#5a3b5e', '#6b6b6b', '#2a2d33', '#b35a3c', '#3c7a8a', '#d8c9a8', '#7a8a3c', '#a33f62'];
const SKIN = ['#e8c4a8', '#d9a98a', '#b97f5f', '#8a5a40', '#f0d0b8'];

// A walking figure, feet at the origin, facing +y (about 60 triangles).
function person(rand, { sit = false, scale = 1 } = {}) {
  const coat = rand.pick(COATS), legs = rand.pick(['#2a2a30', '#3a3f4a', '#4a3b30', '#22262e']);
  const prof = sit
    ? [[0.15, 0.45], [0.21, 0.6], [0.22, 0.95], [0.08, 1.13]]
    : [[0.08, 0.0], [0.13, 0.8], [0.2, 0.92], [0.21, 1.3], [0.07, 1.48]];
  const body = Geo.lathe(prof, 6).scale(1, 0.8, 1).colorBy((p) => (p[2] < (sit ? 0.5 : 0.82) ? legs : coat));
  const g = new Geo();
  g.add(body);
  const hz = sit ? 1.25 : 1.61;
  const skin = rand.pick(SKIN), hair = rand.pick(['#2a1e14', '#5a3a20', '#b08850', '#1a1a1a', '#8a8a8a', '#7a3a20']);
  g.add(Geo.sphere(0.112, 6, 4).scale(1, 1, 1.12).translate(0, 0, hz).colorBy((p, n) => (n[2] > 0.3 || n[1] < -0.45 ? hair : skin)));
  if (rand() < 0.25) g.add(Geo.cylinder(0.14, 0.09, 6, { r2: 0.11 }).translate(0, 0, hz + 0.07).color(rand.pick(['#2a2a2a', '#7a5a3a', '#a33', '#e8e0d0'])));
  if (sit) g.add(Geo.box(0.32, 0.45, 0.14).translate(0, 0.2, 0.5).color(legs));
  return g.scale(scale);
}

// A cyclist, wheels on the ground, riding along +y.
function cyclist(rand) {
  const g = new Geo();
  const frame = rand.pick(['#b8342c', '#2b4f7c', '#2f6a4a', '#e0b030', '#222222', '#d8d8d8', '#6b2f5a']);
  for (const y of [-0.52, 0.52]) g.add(annulus(0.26, 0.34, 9).rotateY(Math.PI / 2).translate(0, y, 0.34).color('#1c1c1c'));
  g.add(beam([0, -0.52, 0.34], [0, 0.05, 0.95], 0.05).color(frame));
  g.add(beam([0, 0.05, 0.95], [0, 0.52, 0.34], 0.05).color(frame));
  const shirt = rand.pick(COATS);
  g.add(beam([0, -0.08, 1.0], [0, 0.18, 1.55], 0.34, 0.22).color(shirt));
  g.add(beam([0, -0.02, 0.98], [0, 0.18, 0.5], 0.26, 0.14).color(rand.pick(['#2a2a30', '#3a3f4a', '#22262e'])));
  g.add(beam([0, 0.18, 1.5], [0, 0.46, 1.02], 0.5, 0.08).color(shirt));
  const helmet = rand() < 0.5 ? rand.pick(['#e03a2a', '#f0f0f0', '#2a6ad0', '#f0c020']) : rand.pick(['#2a1e14', '#5a3a20', '#b08850']);
  const skin = rand.pick(SKIN);
  g.add(Geo.sphere(0.12, 5, 3).scale(1, 1, 1.1).translate(0, 0.22, 1.72).colorBy((p, n) => (n[2] > 0.2 ? helmet : skin)));
  return g;
}

// One section of a tram, centred on the origin, running along +y.
function tramSection(kind) {
  const L = TRAM_SEG, g = new Geo();
  const body = Geo.box(2.4, L, 2.5).translate(0, 0, 0.42 + 1.25);
  uvFrom(body, (p, n) => (Math.abs(n[1]) > 0.5 ? [p[0] + 1.2, p[2] + 4] : Math.abs(n[2]) > 0.5 ? [0, 3.5] : [(p[1] + L / 2) / 1.4 + 0.5, p[2]]));
  g.add(body.color('#ece2c6').mat(MAT.TRAM));
  g.add(Geo.box(2.1, L - 0.5, 0.22).translate(0, 0, 3.03).color('#8f9499').gloss(0.5));
  g.add(Geo.box(2.0, L - 1.2, 0.42).translate(0, 0, 0.21).color('#26292d'));
  if (kind !== 'mid') {
    const s = kind === 'front' ? 1 : -1;
    for (const x of [-0.8, 0.8]) {
      g.add(Geo.box(0.32, 0.06, 0.16).translate(x, s * (L / 2 + 0.02), 0.82).color(kind === 'front' ? '#fff6d8' : '#ff3020').emissive(kind === 'front' ? 6 : 4));
    }
  }
  if (kind === 'mid') {
    // a pantograph folded down on the roof
    g.add(beam([0, -0.8, 3.15], [0, 0.4, 3.75], 0.06).color('#333'));
    g.add(beam([0, 0.4, 3.75], [0, -0.3, 4.15], 0.06).color('#333'));
    g.add(Geo.box(1.4, 0.08, 0.06).translate(0, -0.3, 4.18).color('#333'));
  }
  return g;
}

// A pigeon, about 0.35 m long, flying along +y; flap in -1..1.
function pigeon(color, flap) {
  const g = new Geo();
  const body = new Geo();
  const P0 = [0, 0.2, 0], P1 = [0, -0.17, 0.0];
  const ring = [[0.06, 0, -0.01], [0, 0, 0.055], [-0.06, 0, -0.01]];
  const v = (p) => body.vert(p[0], p[1], p[2], p[0], p[1], p[2], 0, 0);
  const a = v(P0), b = v(P1), r = ring.map(v);
  for (let i = 0; i < 3; i++) { body.tri(a, r[i], r[(i + 1) % 3]); body.tri(b, r[(i + 1) % 3], r[i]); }
  body.computeNormals(false);
  g.add(body.color(color));
  const tipZ = 0.16 * flap, midZ = 0.05 * flap;
  const wing = new Geo();
  for (const s of [-1, 1]) {
    wing.add(Geo.triangle([0.03 * s, 0.07, 0.01], [0.2 * s, 0.03, midZ], [0.03 * s, -0.07, 0.01]));
    wing.add(Geo.triangle([0.2 * s, 0.03, midZ], [0.36 * s, -0.06, tipZ], [0.2 * s, -0.08, midZ]));
    wing.add(Geo.triangle([0.03 * s, -0.07, 0.01], [0.2 * s, 0.03, midZ], [0.2 * s, -0.08, midZ]));
  }
  g.add(wing.color(mixHex(color, '#ffffff', 0.15)));
  return g.scale(1.9);
}

// A carousel horse on its pole, saddle at the origin, facing +y.
function horse(color) {
  const g = new Geo();
  g.add(Geo.box(0.36, 1.15, 0.42).translate(0, 0, -0.05).colorBy((p, n) => (n[2] > 0.5 && Math.abs(p[1]) < 0.3 ? '#b8342c' : color)));
  g.add(beam([0, 0.45, 0.05], [0, 0.78, 0.6], 0.24, 0.3).color(color));
  g.add(beam([0, 0.7, 0.62], [0, 1.05, 0.45], 0.2, 0.24).color(color));
  g.add(beam([0, 0.45, -0.2], [0, 0.85, -0.7], 0.3, 0.1).color(color));
  g.add(beam([0, -0.45, -0.2], [0, -0.75, -0.75], 0.3, 0.1).color(color));
  g.add(Geo.box(0.06, 0.06, 4.8).translate(0, 0.05, 1.1).color('#d9a842').gloss(0.8));
  return g;
}

// A pennant string between two points, sagging, with flags hanging from it
// (the string itself goes to the plain boxes).
function bunting(a, b, sag, rand) {
  const g = new Geo();
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.round(L / 0.9));
  const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - sag * 4 * t * (1 - t)];
  const cols = ['#d8402f', '#f2c12e', '#2f6fb3', '#f4f1e8', '#3c9a5a', '#e07a2a'];
  const off = rand.int(0, 5);
  const segs = Math.max(4, Math.round(L / 3));
  for (let i = 0; i < segs; i++) addBoxes([[beamM(at(i / segs), at((i + 1) / segs), 0.025), '#3a3a3a']]);
  for (let i = 1; i < n; i++) {
    const t0 = (i - 0.3) / n, t1 = (i + 0.3) / n;
    const p0 = at(t0), p1 = at(t1), pm = at(i / n);
    g.add(Geo.triangle(p0, p1, [pm[0], pm[1], pm[2] - 0.42]).color(cols[(i + off) % cols.length]));
  }
  return g;
}

// ---------------------------------------------------------------------------
// landmarks

function clockFaceAt(b, m, R) {
  const face = Geo.disc(R, 48).rotateX(Math.PI / 2);
  uvFrom(face, (p) => [0.5 + p[0] / (2 * R), 0.5 + p[2] / (2 * R)]);
  const bez = new Geo();
  bez.add(annulus(R, R + 0.35 * R / 3.25, 48).rotateX(Math.PI / 2).translate(0, -0.12, 0));
  bez.add(Geo.cylinder(R + 0.35 * R / 3.25, 0.12, 48, { caps: false }).rotateX(Math.PI / 2));
  b.static(face.mat(MAT.CLOCK).transform(m4.mul(m, m4.translation(0, -0.05, 0))));
  b.static(bez.color('#d9a842').gloss(0.8).transform(m));
}

function clockTower(b) {
  const stone = '#cfc2a3', dark = '#a99c80', copper = '#6aa58e', gold = '#d9a842';
  const g = new Geo();
  g.add(Geo.box(12.4, 12.4, 0.45).translate(0, 0, 0.225).color(dark));
  g.add(Geo.box(11, 11, 0.5).translate(0, 0, 0.7).color(dark));
  g.add(Geo.box(9, 9, 29.2).translate(0, 0, 0.95 + 14.6).color(stone));
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) g.add(Geo.box(1.4, 1.4, 28.6).translate(sx * 4.25, sy * 4.25, 0.95 + 14.3).color(stone));
  }
  // string courses
  for (const z of [10.5, 20.5]) g.add(Geo.box(9.5, 9.5, 0.35).translate(0, 0, z).color(dark));
  g.add(Geo.box(10.6, 10.6, 0.6).translate(0, 0, 30.1).color(dark));
  g.add(Geo.box(9.8, 9.8, 8.0).translate(0, 0, 30.4 + 4.0).color(stone));
  g.add(Geo.box(10.6, 10.6, 0.5).translate(0, 0, 38.65).color(dark));
  // belfry: four arched walls
  const z0 = 38.9, bh = 7.4;
  const ns = archWall(9.8, bh, 0.9, [{ c: 4.9, r: 2.4, spring: 3.4 }], 12);
  const ew = archWall(8.0, bh, 0.9, [{ c: 4.0, r: 2.4, spring: 3.4 }], 12);
  g.add(ns.clone().translate(-4.9, -4.9, z0));
  g.add(ns.clone().transform(m4.mul(m4.translation(4.9, 4.9, z0), m4.rotationZ(Math.PI))));
  g.add(ew.clone().transform(m4.mul(m4.translation(4.9, -4.0, z0), m4.rotationZ(Math.PI / 2))));
  g.add(ew.clone().transform(m4.mul(m4.translation(-4.9, 4.0, z0), m4.rotationZ(-Math.PI / 2))));
  g.add(Geo.box(8.0, 8.0, 0.3).translate(0, 0, z0 + 0.15).color(dark));
  g.add(Geo.box(10.8, 10.8, 0.6).translate(0, 0, z0 + bh + 0.3).color(dark));
  b.static(metricUV(g).mat(MAT.TOWER));

  // the bell, under a beam
  const bell = Geo.lathe([[0.02, 0], [1.25, 0.05], [1.15, 0.35], [0.85, 1.0], [0.75, 1.7], [0.55, 2.05], [0.02, 2.15]], 16).color('#a8803c').gloss(0.7);
  b.static(bell.translate(0, 0, z0 + 2.4));
  addBoxes([[boxM(8.2, 0.4, 0.5, 0, 0, z0 + 4.8), '#4a3a2c']]);

  // spire with corner pinnacles, ball and vane
  const sp = new Geo();
  sp.add(Geo.cone(7.6, 14, 4).rotateZ(Math.PI / 4).translate(0, 0, z0 + bh + 0.6));
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      sp.add(Geo.box(0.9, 0.9, 1.4).translate(sx * 4.9, sy * 4.9, z0 + bh + 1.3));
      sp.add(Geo.cone(0.65, 3.2, 4).rotateZ(Math.PI / 4).translate(sx * 4.9, sy * 4.9, z0 + bh + 2.0));
    }
  }
  b.static(sp.color(copper).gloss(0.35));
  const top = z0 + bh + 0.6 + 14;
  b.static(Geo.sphere(0.55, 12, 8).translate(0, 0, top + 0.2).color(gold).gloss(0.85));
  addBoxes([[boxM(0.09, 0.09, 3.2, 0, 0, top + 1.6), '#2a2a2a']]);
  b.static(Geo.box(0.06, 2.2, 0.5).translate(0, 0.3, top + 2.7).color(gold).gloss(0.8));

  // clock faces on all four sides
  for (let k = 0; k < 4; k++) clockFaceAt(b, m4.mul(m4.rotationZ(k * Math.PI / 2), m4.translation(0, -4.92, 34.4)), 3.25);
  // arched door facing the avenue
  const door = uvFrom(vquad(-1.1, 1.1, 0, 3.7), (p) => [p[0], p[2]]);
  b.static(door.color('#a99c80').mat(MAT.DOOR).transform(m4.mul(m4.rotationZ(-Math.PI / 2), m4.translation(0, -4.53, 0.95))));
}

function townHall(b) {
  const hid = HOUSE_ID++;
  const e = [0, -1], inward = [1, 0];
  const main = makeHouse({ w: 36, d: 18, floors: 2, g0: 5.6, sh: 4.4, bays: 9, roof: 'side', pitch: 0.92, wall: '#dfcaa0', roofCol: '#4f565e', hid, dormers: true, left: true, right: true });
  b.static(main.g.transform(placeM([SQ, 18], e, inward)));
  addBoxes(main.boxes, placeM([SQ, 18], e, inward));
  const mid = makeHouse({ w: 12, d: 4, floors: 2, g0: 5.6, sh: 4.4, bays: 3, roof: 'step', pitch: 0.98, wall: '#d4b98a', roofCol: '#4f565e', hid: HOUSE_ID++, left: true, right: true });
  b.static(mid.g.transform(placeM([SQ - 2, 6], e, inward)));
  addBoxes(mid.boxes, placeM([SQ - 2, 6], e, inward));
  // arcade along the ground floor, with a balcony on top
  const arc = archWall(36, 5.6, 0.8, Array.from({ length: 9 }, (_, i) => ({ c: 2 + i * 4, r: 1.45, spring: 3.3 })), 10);
  b.static(metricUV(arc.transform(placeM([SQ - 3.6, 18], e, inward))).color('#cdb890').mat(MAT.STONE));
  const bx = [[boxM(3.6, 36, 0.3, SQ - 1.8, 0, 5.75), '#bfa983']];
  for (let i = 0; i <= 36; i++) bx.push([boxM(0.12, 0.12, 0.9, SQ - 3.45, -18 + i, 6.35), '#e8dcc0']);
  bx.push([boxM(0.2, 36.1, 0.14, SQ - 3.45, 0, 6.85), '#e8dcc0']);
  // flagpoles over the balcony
  for (const y of [-12, 12]) bx.push([beamM([SQ - 0.1, y, 9.0], [SQ - 3.2, y, 12.4], 0.08), '#e8e4da']);
  addBoxes(bx);
}

function gate(b) {
  const g = archWall(28, 14, 12, [{ c: 14, r: 6.2, spring: 6 }, { c: 3, r: 1.6, spring: 2.6 }, { c: 25, r: 1.6, spring: 2.6 }], 14);
  b.static(metricUV(g.transform(placeM([GATE_X, -AW], [0, 1], [-1, 0]))).color('#bdb093').mat(MAT.STONE));
  // tower on top
  const t = new Geo();
  t.add(Geo.box(10, 16, 10).translate(GATE_X - 6, 0, 14 + 5));
  t.add(Geo.box(10.8, 16.8, 0.6).translate(GATE_X - 6, 0, 14.3));
  t.add(Geo.box(10.8, 16.8, 0.6).translate(GATE_X - 6, 0, 24.1));
  b.static(metricUV(t).color('#c4b799').mat(MAT.STONE));
  b.static(Geo.cone(Math.SQRT2, 9, 4).rotateZ(Math.PI / 4).scale(5.6, 8.6, 1).translate(GATE_X - 6, 0, 24.4).color('#7b402d'));
  // merlons along both faces of the gate
  for (const x of [GATE_X - 0.4, GATE_X - 11.6]) {
    for (let y = -13.4; y <= 13.4; y += 2.4) {
      if (Math.abs(y) < 8.6) continue;
      MERLONS.push({ transform: boxM(0.8, 1.3, 1.2, x, y, 14.6), tint: '#bdb093', data: 1 });
    }
  }
  // a clock on the gate tower, facing the avenue
  clockFaceAt(b, m4.mul(m4.translation(GATE_X - 1.0, 0, 19.2), m4.rotationZ(Math.PI / 2)), 2.4);
}

function cityWall(b, rand) {
  const H = 9, T = 2.6, col = '#b5a98c';
  const g = new Geo();
  const seg = (x0, y0, x1, y1) => {
    // wall from (x0, y0) to (x1, y1), outer face on the left of the direction
    const L = Math.hypot(x1 - x0, y1 - y0), dx = (x1 - x0) / L, dy = (y1 - y0) / L;
    const n = Math.ceil(L / 40);
    for (let i = 0; i < n; i++) {
      const c = (i + 0.5) * L / n;
      g.add(Geo.box(T, L / n, H).transform(m4.facing([x0 + dx * c, y0 + dy * c, H / 2], [dx, dy, 0])));
    }
    for (let s = 1.2; s < L - 1; s += 2.4) {
      const ox = -dy * (T / 2 - 0.3), oy = dx * (T / 2 - 0.3);
      MERLONS.push({ transform: m4.mul(m4.facing([x0 + dx * s + ox, y0 + dy * s + oy, H + 0.55], [dx, dy, 0]), m4.scaling(0.6, 1.2, 1.1)), tint: col, data: 1 });
    }
  };
  const x0 = WALL.x0 + T / 2, x1 = WALL.x1 + T / 2, y = WALL.y + T / 2;
  seg(x0, AW, x0, y);
  seg(x0, y, x1, y);
  seg(x1, y, x1, -y);
  seg(x1, -y, x0, -y);
  seg(x0, -y, x0, -AW);
  b.static(metricUV(g).color(col).mat(MAT.STONE));
  for (const [x, yy] of [[x0, y], [x1, y], [x1, -y], [x0, -y], [x1, 0], [-70, y], [-70, -y], [-150, y], [-150, -y], [10, y], [10, -y]]) {
    const t = Geo.cylinder(4.2, 13, 16).translate(x, yy, 0);
    b.static(metricUV(t).color(col).mat(MAT.STONE));
    b.static(Geo.cone(4.9, 6, 16).translate(x, yy, 13).color('#7b402d'));
  }
}

// Background blocks of houses behind the frontages, round courtyards.
function blocks(b, rand) {
  const list = [
    [-228, 32, -146, 90], [-140, 32, -58, 90],
    [-52, 58, 14, 90], [19, 58, 90, 90],
    [58, -52, 90, 52],
    [-52, -90, -22, -58], [-17, -90, 90, -58],
    [-228, -90, -122, -32], [-116, -90, -58, -32],
  ];
  const D = 11;
  for (const [x0, y0, x1, y1] of list) {
    const o = { depth: D, sills: false, floors: [2, 3], minW: 7, maxW: 11 };
    row(b, rand, { ...o, start: [x1, y1], nrm: [0, 1], length: x1 - x0, ends: [true, true] });
    row(b, rand, { ...o, start: [x0, y0], nrm: [0, -1], length: x1 - x0, ends: [true, true] });
    if (y1 - y0 > 2 * D + 6) {
      row(b, rand, { ...o, start: [x1, y0 + D], nrm: [1, 0], length: y1 - y0 - 2 * D });
      row(b, rand, { ...o, start: [x0, y1 - D], nrm: [-1, 0], length: y1 - y0 - 2 * D });
    }
    // a tree or two in the courtyard
    const n = Math.floor((x1 - x0) / 30);
    for (let i = 0; i < n; i++) {
      b.static(tree(rand, rand.range(6, 9)).translate(x0 + (x1 - x0) * (i + 0.5) / n + rand.range(-3, 3), (y0 + y1) / 2 + rand.range(-2, 2), 0));
    }
  }
}

function fountain(b) {
  const [cx, cy] = FOUNTAIN;
  const stone = '#c9bda2';
  b.static(Geo.lathe([[4.6, 0], [4.6, 0.55], [4.9, 0.6], [4.9, 0.78], [4.35, 0.78], [4.35, 0.25]], 40, { smooth: false }).translate(cx, cy, 0).color(stone));
  b.static(Geo.disc(4.36, 40).translate(cx, cy, 0.5).mat(MAT.WATER).color('#2a5a60'));
  b.static(Geo.lathe([[0.75, 0.45], [0.75, 0.65], [0.45, 0.85], [0.32, 1.7], [0.45, 1.85], [1.7, 2.1], [1.78, 2.32], [1.62, 2.32], [0.42, 2.2],
    [0.26, 2.45], [0.22, 3.0], [0.38, 3.12], [0.12, 3.35], [0.0, 3.4]], 24).translate(cx, cy, 0).color(stone));
  b.static(Geo.disc(1.63, 24).translate(cx, cy, 2.28).mat(MAT.WATER).color('#2a5a60'));
  // water spilling over the upper bowl all round
  b.static(Geo.cylinder(1.86, 1.8, 24, { caps: false, r2: 1.8 }).translate(cx, cy, 0.5).color('#bfe4ff').mat(MAT.CURTAIN).additive());
  // nozzles round the rim
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    b.static(Geo.cylinder(0.12, 0.35, 8).translate(cx + 3.3 * Math.cos(a), cy + 3.3 * Math.sin(a), 0.3).color('#6a6a62'));
  }
}

function carousel(b) {
  const [cx, cy] = CAROUSEL;
  b.static(Geo.cylinder(6.1, 0.5, 40).translate(cx, cy, 0).color('#8a6a48'));
  b.static(Geo.cylinder(6.3, 0.18, 40).translate(cx, cy, 0).color('#5a4636'));
  b.static(Geo.cylinder(1.0, 4.2, 16).translate(cx, cy, 0.5).color('#e8d8b0').gloss(0.4));
  const canopy = Geo.cone(6.7, 2.5, 32).translate(cx, cy, 4.55);
  b.static(canopy.mat(MAT.CANOPY));
  b.static(Geo.cylinder(6.6, 0.65, 32, { caps: false }).translate(cx, cy, 3.9).mat(MAT.CANOPY).tag(2).cutout());
  b.static(Geo.disc(6.6, 32).flip().translate(cx, cy, 3.9).color('#d9c39a'));
  b.static(Geo.sphere(0.35, 10, 6).translate(cx, cy, 7.2).color('#d9a842').gloss(0.8));
  addBoxes([[boxM(0.05, 0.05, 1.4, cx, cy, 7.9), '#333']]);
  b.static(Geo.triangle([cx, cy, 8.55], [cx, cy, 8.1], [cx + 0.9, cy, 8.33]).color('#d8402f'));
  // bulbs round the valance: a chaser, four groups lit in turn
  const n = 40;
  for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n, x = cx + 6.66 * Math.cos(a), y = cy + 6.66 * Math.sin(a);
    b.static(Geo.sphere(0.07, 6, 4).translate(x, y, 4.0).color('#8a7a50'));
    b.static(Geo.sphere(0.1, 6, 4).translate(x, y, 4.0).color('#ffd27a').mat(MAT.BULB), { from: (i % 4) * 0.3, to: (i % 4) * 0.3 + 0.55, period: 1.2 });
  }
}

function market(b, rand) {
  const cols = ['#b8342c', '#2f6a4a', '#2b4f7c', '#c27a1e', '#6b2f5a', '#3c7a8a'];
  const produce = ['#d8402f', '#f0a020', '#8ab83a', '#f2d23a', '#7a3a8a', '#e86a3a', '#4a8a3a'];
  let k = 0;
  for (const [yc, facing] of [[-13, -1], [-21, 1]]) {
    for (const xc of [-24, -18, -12]) {
      const g = new Geo(), bx = [];
      const W = 4.4, Dp = 2.4;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) bx.push([boxM(0.09, 0.09, sy > 0 ? 2.65 : 2.3, sx * (W / 2 - 0.1), sy * (Dp / 2 - 0.1), (sy > 0 ? 2.65 : 2.3) / 2), '#5a4030']);
      }
      bx.push([boxM(W - 0.2, 0.9, 0.85, 0, -Dp / 2 + 0.5, 0.425), '#9a7048']);
      for (let i = 0; i < 6; i++) {
        bx.push([boxM(0.6, 0.4, 0.14, -1.75 + i * 0.7, -Dp / 2 + 0.45, 0.92), '#c8a878']);
        bx.push([boxM(0.5, 0.32, 0.1, -1.75 + i * 0.7, -Dp / 2 + 0.45, 1.02), rand.pick(produce)]);
      }
      const roof = uvFrom(quadN([-W / 2 - 0.2, -Dp / 2 - 0.5, 2.25], [W / 2 + 0.2, -Dp / 2 - 0.5, 2.25], [W / 2 + 0.2, Dp / 2 + 0.2, 2.75], [-W / 2 - 0.2, Dp / 2 + 0.2, 2.75], [0, -0.3, 1]), (p) => [p[0], 0]);
      g.add(roof.color(cols[k % cols.length]).mat(MAT.AWNING));
      g.add(uvFrom(quadN([-W / 2 - 0.2, -Dp / 2 - 0.5, 2.25], [W / 2 + 0.2, -Dp / 2 - 0.5, 2.25], [W / 2 + 0.2, -Dp / 2 - 0.5, 1.95], [-W / 2 - 0.2, -Dp / 2 - 0.5, 1.95], [0, -1, 0]), (p) => [p[0], (2.25 - p[2]) / 0.3]).color(cols[k % cols.length]).mat(MAT.AWNING).tag(1).cutout());
      // the stallholder
      g.add(person(rand).rotateZ(Math.PI).translate(rand.range(-1, 1), 0.4, 0));
      const m = m4.mul(m4.translation(xc, yc, 0), m4.rotationZ(facing > 0 ? Math.PI : 0));
      b.static(g.transform(m));
      addBoxes(bx, m);
      // a customer or two
      for (let c = 0; c < 2; c++) {
        if (rand() < 0.35) continue;
        const p = person(rand).rotateZ(facing > 0 ? Math.PI : 0).translate(xc + rand.range(-1.6, 1.6), yc + facing * (Dp / 2 + 1.0 + rand.range(0, 0.6)), 0);
        b.static(p);
      }
      k++;
    }
  }
}

function cafe(b, rand) {
  const cols = ['#f0e6d0', '#b8342c', '#2f6a4a'];
  for (const x of [12.5, 18.5, 24.5]) {
    for (const y of [12, 18, 24]) {
      const g = new Geo();
      g.add(Geo.cylinder(0.45, 0.04, 12).translate(0, 0, 0.72).color('#e8e4da'));
      g.add(Geo.cylinder(0.04, 0.72, 6).color('#333'));
      g.add(Geo.cylinder(0.25, 0.03, 8).color('#333'));
      g.add(Geo.cylinder(0.03, 2.3, 6).translate(0, 0, 0.7).color('#ddd'));
      const pc = rand.pick(cols);
      g.add(Geo.cone(1.6, 0.55, 8).translate(0, 0, 2.45).color(pc));
      g.add(Geo.cylinder(1.6, 0.22, 8, { caps: false }).uvTransform(32 * 0.275, -1, 0, 1).tag(1).cutout().translate(0, 0, 2.25).color(pc));
      const chairs = [];
      for (const a of [0, Math.PI]) {
        const cm = m4.mul(m4.rotationZ(a), m4.translation(0, 0.75, 0));
        chairs.push([m4.mul(cm, boxM(0.42, 0.42, 0.05, 0, 0, 0.45)), '#3a4a3a'], [m4.mul(cm, boxM(0.42, 0.05, 0.45, 0, 0.2, 0.7)), '#3a4a3a']);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) chairs.push([m4.mul(cm, boxM(0.04, 0.04, 0.45, sx * 0.18, sy * 0.18, 0.225)), '#3a4a3a']);
        if (rand() < 0.65) g.add(person(rand, { sit: true }).rotateZ(Math.PI).translate(0, 0.72, 0).rotateZ(a));
      }
      const m = m4.mul(m4.translation(x, y, 0), m4.rotationZ(rand.range(-0.3, 0.3)));
      b.static(g.transform(m));
      addBoxes(chairs, m);
    }
  }
}

function tramStop(b) {
  for (const s of [-1, 1]) {
    const y0 = s * 3.4, y1 = s * 4.3;
    const g = [];
    g.push([boxM(14, 0.9, 0.22, STOP_X, (y0 + y1) / 2, 0.11), '#9a958c']);
    g.push([boxM(14, 0.12, 0.23, STOP_X, y0 + s * 0.06, 0.115), '#e8e0c8']);
    for (const dx of [-3.5, 3.5]) g.push([boxM(0.1, 0.1, 2.6, STOP_X + dx, y1 - s * 0.15, 1.52), '#2a3530']);
    addBoxes(g);
    // the shelter: a glass roof and a glass side pane (solid, as panes of glass should be)
    b.static(Geo.box(8, 0.75, 0.06).translate(STOP_X, s * 4.05, 2.85).color('#9ec4d0').mat(MAT.GLASS).blend(0.3), { solid: true });
    b.static(Geo.box(0.04, 0.6, 1.6).translate(STOP_X - 3.5, s * 4.05, 1.42).color('#a8c8d4').mat(MAT.GLASS).blend(0.3), { solid: true });
    addBoxes(bench(), m4.mul(m4.translation(STOP_X + 1.2, (y0 + y1) / 2 + s * 0.15, 0.22), m4.rotationZ(s > 0 ? 0 : Math.PI), m4.scaling(0.9)));
    // display, readable from both ends of the platform: seconds until the next tram passes on this side
    const ym = (y0 + y1) / 2, dx = STOP_X - 2.0, z0 = 2.06, z1 = 2.42;
    addBoxes([[boxM(0.1, 0.98, 0.44, dx, ym, (z0 + z1) / 2), '#1a1a1a'], [boxM(0.05, 0.05, 0.42, dx, ym, z1 + 0.21), '#222']]);
    b.static(uvFrom(quadN([dx - 0.055, ym + 0.45, z0], [dx - 0.055, ym - 0.45, z0], [dx - 0.055, ym - 0.45, z1], [dx - 0.055, ym + 0.45, z1], [-1, 0, 0]),
      (p) => [(ym + 0.45 - p[1]) / 0.9, (p[2] - z0) / (z1 - z0)]).mat(MAT.DISPLAY));
    b.static(uvFrom(quadN([dx + 0.055, ym - 0.45, z0], [dx + 0.055, ym + 0.45, z0], [dx + 0.055, ym + 0.45, z1], [dx + 0.055, ym - 0.45, z1], [1, 0, 0]),
      (p) => [(p[1] - ym + 0.45) / 0.9, (p[2] - z0) / (z1 - z0)]).mat(MAT.DISPLAY));
  }
}

// Signals that follow the tram timetable: pedestrian lights at the zebra
// crossing turn red while a tram is near, and amber lamps on the platforms
// blink as a tram comes in.  They are static meshes with repeating time windows.
function signals(b) {
  const every = P / TRAM_N;
  // red while a tram's nose is within 9 s before to TRAM_LEN after the crossing, on either track
  const red = [];
  for (const y of [-TRAM_Y, TRAM_Y]) {
    const T = tramPass(CROSS_X + (y < 0 ? 2 : -2), y);
    red.push([T - 9, T + TRAM_LEN / TRAM_V + 2]);
  }
  // merge into windows on a circle of length `every`
  const marks = [];
  for (const [a, c] of red) marks.push([mod(a, every), mod(a, every) + (c - a)]);
  marks.sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push(m.slice());
  }
  if (merged.length > 1 && merged[merged.length - 1][1] >= merged[0][0] + every) {
    const l = merged.pop();
    merged[0] = [l[0] - every, Math.max(merged[0][1], l[1] - every)];
  }
  const green = merged.map((m, i) => [m[1], (merged[(i + 1) % merged.length][0] + (i + 1 === merged.length ? every : 0))]);
  for (const s of [-1, 1]) {
    const x = CROSS_X + 2.3, y = s * 9.35;
    b.static(Geo.cylinder(0.06, 2.4, 8).color('#2a2a2a').translate(x, y, 0));
    addBoxes([[boxM(0.32, 0.32, 0.72, 0, 0, 2.75), '#1c1c1c'], [boxM(0.34, 0.34, 0.2, 0, 0, 2.95), '#3a1010'], [boxM(0.34, 0.34, 0.2, 0, 0, 2.55), '#0e2a14']], m4.translation(x, y, 0));
    for (const [a, c] of merged) b.static(Geo.box(0.36, 0.36, 0.2).translate(x, y, 2.95).color('#ff2a1a').mat(MAT.NEON), { from: a, to: c, period: every });
    for (const [a, c] of green) b.static(Geo.box(0.36, 0.36, 0.2).translate(x, y, 2.55).color('#2aff6a').mat(MAT.NEON), { from: a, to: c, period: every });
  }
  // platform lamps: blink for the six seconds before the tram arrives
  for (const [k, s] of [[0, -1], [1, 1]]) {
    const T = STOP_T[k], x = STOP_X + (s < 0 ? -3.5 : 3.5), y = s * 4.15;
    b.static(Geo.sphere(0.1, 8, 5).translate(x, y, 2.72).color('#5a4010'));
    for (let i = 0; i < 8; i++) {
      b.static(Geo.sphere(0.13, 8, 5).translate(x, y, 2.72).color('#ffb020').mat(MAT.NEON), { from: T - 6 + i * 0.75, to: T - 6 + i * 0.75 + 0.38, period: every });
    }
  }
}

// Trees and a few sheds in the meadow outside the walls.
function countryside(b, rand) {
  for (const s of [-1, 1]) {
    for (let y = 22; y < 140; y += 11) b.static(tree(rand, rand.range(8, 10)).scale(0.8, 0.8, 1.15).translate(-256 + rand.range(-1, 1), s * y, 0));
  }
  for (let i = 0; i < 40; i++) {
    const x = rand.range(-420, -250), y = rand.range(-200, 200);
    if (x > -310 && Math.abs(y) < 30) continue;
    if (x > -262 && Math.abs(y) < 150) continue;
    b.static(tree(rand, rand.range(6, 10)).translate(x, y, 0));
  }
}

// Extras on the houses that face the avenue and the square: blade signs, a
// cinema marquee, chemist's crosses.
function shopExtras(b, rand, h, specials) {
  const { m, w, g0 } = h;
  const place = (geo) => b.static(geo.transform(m));
  if (specials.cinema === h.hid) {
    // cinema: a canopy with two rows of chasing bulbs
    addBoxes([[boxM(w - 0.6, 2.0, 0.5, w / 2, -1.0, g0 - 0.6), '#3a2a3a'], [boxM(w - 0.6, 0.08, 0.8, w / 2, -2.0, g0 - 0.3), '#c8a040']], m);
    const n = Math.floor((w - 1) / 0.32);
    for (let i = 0; i < n; i++) {
      const x = 0.5 + i * 0.32;
      for (const [z, dir] of [[g0 - 0.55, 1], [g0 - 0.15, -1]]) {
        // a dull bulb, and a lit one round it for part of each cycle: the rows chase in opposite directions
        place(Geo.sphere(0.055, 5, 3).translate(x, -2.06, z).color('#7a6a40'));
        const k = dir > 0 ? i : n - 1 - i;
        b.static(Geo.sphere(0.09, 5, 3).translate(x, -2.1, z).color('#fff2c0').mat(MAT.BULB).transform(m), { from: (k % 6) * 0.15, to: (k % 6) * 0.15 + 0.3, period: 0.9 });
      }
    }
    // the vertical sign: letters lit one after another, then all together
    addBoxes([[boxM(0.25, 1.1, 4.2, w / 2, -0.7, g0 + 2.4), '#2a2030']], m);
    for (let i = 0; i < 6; i++) {
      const z = g0 + 4.0 - i * 0.65;
      const tile = Geo.box(0.3, 0.7, 0.5).translate(w / 2, -0.75, z).color(['#ff4a3a', '#ffb030', '#ffe04a', '#4ad07a', '#4ab0ff', '#d070ff'][i]).mat(MAT.NEON);
      b.static(tile.transform(m), { from: i * 0.5, to: 4.5, period: 5 });
    }
    return;
  }
  if (specials.chemists.includes(h.hid)) {
    // a green cross on a bracket, blinking
    const x = rand() < 0.5 ? 0.6 : w - 0.6;
    addBoxes([[beamM([x, 0, g0 + 0.6], [x, -1.0, g0 + 0.6], 0.06), '#222'],
      [boxM(0.12, 0.25, 0.75, x, -1.0, g0 + 0.15), '#163a20'], [boxM(0.12, 0.75, 0.25, x, -1.0, g0 + 0.15), '#163a20']], m);
    const cross = new Geo();
    cross.add(Geo.box(0.12, 0.25, 0.75));
    cross.add(Geo.box(0.12, 0.75, 0.25));
    b.static(cross.scale(1.1).translate(x, -1.0, g0 + 0.15).color('#30ff70').mat(MAT.NEON).transform(m), { from: 0, to: 0.7, period: 1.0 });
    return;
  }
  if (rand() < 0.45) {
    // a hanging sign on an iron bracket
    const x = rand() < 0.5 ? 0.5 : w - 0.5;
    const z = g0 + rand.range(0.2, 0.9);
    addBoxes([[beamM([x, 0, z + 0.05], [x, -1.1, z + 0.05], 0.05), '#222']], m);
    const neon = rand() < 0.3;
    const col = neon ? rand.pick(['#ff5a8a', '#5ad0ff', '#ffd040', '#a0ff60']) : rand.pick(['#2a4a3a', '#6a2a2a', '#c8a040', '#2a3a5a', '#e8e0d0']);
    if (neon) place(Geo.box(0.06, 0.75, 0.55).translate(x, -0.7, z - 0.32).color(col).mat(MAT.NEON));
    else addBoxes([[boxM(0.06, 0.75, 0.55, x, -0.7, z - 0.32), col]], m);
  }
}

// ---------------------------------------------------------------------------
// moving things

function trams(b) {
  const kinds = ['rear', 'mid', 'front'];
  for (let j = 0; j < TRAM_N; j++) {
    for (let k = 0; k < 3; k++) {
      const off = TRAM_OFF + j * TRAM_PATH.length / TRAM_N + k * (TRAM_SEG + TRAM_GAP);
      const tf = follow(TRAM_PATH, { speed: TRAM_V, offset: off, span: TRAM_SEG * 0.75 });
      b.dynamic(tramSection(kinds[k]), { times: adaptiveTimes(tf, 0, P, { size: 3.2, tolerance: 0.09, maxStep: 8 }), transform: tf, caps: 'none' });
    }
  }
}

// Things that come in along an open route, cross the town and leave again:
// one every `every` seconds, each existing from its start to its end.
function travellers(b, rand, pts, { speed, every, make, size, lift = 0, start = 0 }) {
  const path = new Path(pts.map((p) => [p[0], p[1], 0]));
  const n = Math.max(1, Math.round(P / every));
  for (let i = 0; i < n; i++) {
    const t0 = start + i * P / n;
    const v = speed * rand.range(0.97, 1.03);
    const d = path.length / v;
    const tf = follow(path, { speed: v, offset: -v * t0, span: size * 1.5, lift });
    b.dynamic(make(rand), { times: adaptiveTimes(tf, t0, t0 + d, { size, tolerance: 0.1, maxStep: 40 }), transform: tf, caps: 'both' });
  }
}

function walkersRoundTower(b, rand) {
  const n = 7, r = 10.6;
  const loop = new Path(Array.from({ length: 72 }, (_, i) => [r * Math.cos(i / 72 * 2 * Math.PI), r * Math.sin(i / 72 * 2 * Math.PI), 0]), { closed: true });
  for (let i = 0; i < n; i++) {
    const tf = follow(loop, { speed: 2 * loop.length / P, offset: i * loop.length / n, span: 1 });
    b.dynamic(person(rand, { scale: rand.range(0.92, 1.06) }), { times: adaptiveTimes(tf, 0, P, { size: 0.5, tolerance: 0.08, maxStep: 4 }), transform: tf, caps: 'none' });
  }
}

function birds(b, rand) {
  const n = 16;
  const w = 2 * Math.PI / 15; // one circuit every 15 s
  for (let i = 0; i < n; i++) {
    const r = rand.range(11, 21), z = rand.range(33, 47), ph = 2 * Math.PI * i / n + rand.range(-0.15, 0.15);
    const bob = rand.range(0.8, 2.2), col = rand.pick(['#8a8f99', '#9aa0a8', '#7a7f88', '#e8e8e4', '#6a6f78']);
    const fo = rand.int(0, 3) * 0.25;
    const tf = (t) => {
      const a = ph + w * t;
      const pos = [r * Math.cos(a), r * Math.sin(a), z + bob * Math.sin(2 * a + i)];
      const fwd = [-Math.sin(a), Math.cos(a), 0.0];
      const up = [-0.38 * Math.cos(a), -0.38 * Math.sin(a), 1];
      return m4.facing(pos, fwd, up);
    };
    // the wings beat once a second; keys every quarter second catch up, level, down, level
    const tri = (t) => 1 - 4 * Math.abs(((t + fo) % 1 + 1) % 1 - 0.5);
    if (i % 2) b.dynamic((t) => pigeon(col, tri(t)), { times: timeRange(0, P, 0.25), transform: tf, caps: 'none' });
    else b.dynamic(pigeon(col, 0.15), { times: timeRange(0, P, 0.5), transform: tf, caps: 'none' });
  }
}

function fountainJets(b) {
  const [cx, cy] = FOUNTAIN;
  const jet = Geo.lathe([[0.075, 0], [0.055, 0.85], [0.09, 0.95], [0.03, 1.0]], 5).color('#e4f2ff').mat(MAT.JET);
  // eight jets round the rim leap one after another: a wave runs round every 4 s
  const cyc = 4, n = 8;
  for (let i = 0; i < n; i++) {
    const a = i * 2 * Math.PI / n, x = cx + 3.3 * Math.cos(a), y = cy + 3.3 * Math.sin(a);
    const ph = i * cyc / n;
    // height through one cycle: up in 0.6 s, down in 1.4 s, then low
    const keysIn = [[0, 0.25], [0.6, 2.6], [2.0, 0.25], [cyc, 0.25]];
    const times = [], hs = [];
    for (let c = -1; c * cyc < P + cyc; c++) {
      for (const [k, h] of keysIn.slice(0, 3)) {
        const t = c * cyc + ph + k;
        if (t >= 0 && t <= P) { times.push(t); hs.push(h); }
      }
    }
    // the cycle repeats exactly, so the value at 0 and P are on the pattern
    const hAt = (t) => {
      const u = mod(t - ph, cyc);
      for (let k = 1; k < keysIn.length; k++) {
        if (u <= keysIn[k][0]) return keysIn[k - 1][1] + (keysIn[k][1] - keysIn[k - 1][1]) * (u - keysIn[k - 1][0]) / (keysIn[k][0] - keysIn[k - 1][0]);
      }
      return keysIn[0][1];
    };
    const ts = [...new Set([0, P, ...times].map((t) => Math.round(t * 1e6) / 1e6))].sort((p, q) => p - q);
    b.dynamic(jet, { times: ts, transform: (t) => m4.mul(m4.translation(x, y, 0.62), m4.scaling(1, 1, hAt(t))), caps: 'none' });
  }
  // the central plume: up to 4.5 m every 6 s
  const big = Geo.lathe([[0.12, 0], [0.1, 0.6], [0.07, 0.9], [0.16, 0.96], [0.04, 1.0]], 8).color('#e4f2ff').mat(MAT.JET);
  const keys = [[0, 0.3], [1.5, 4.6], [3.6, 0.3], [6, 0.3]];
  const hAt = (t) => {
    const u = mod(t, 6);
    for (let k = 1; k < keys.length; k++) {
      if (u <= keys[k][0]) return keys[k - 1][1] + (keys[k][1] - keys[k - 1][1]) * (u - keys[k - 1][0]) / (keys[k][0] - keys[k - 1][0]);
    }
    return keys[0][1];
  };
  const ts = [];
  for (let c = 0; c < P / 6; c++) for (const [k] of keys.slice(0, 3)) ts.push(c * 6 + k);
  ts.push(P);
  b.dynamic(big, { times: ts, transform: (t) => m4.mul(m4.translation(cx, cy, 3.35), m4.scaling(1, 1, hAt(t))), caps: 'none' });
}

function carouselHorses(b) {
  const [cx, cy] = CAROUSEL;
  const n = 8, R = 4.6, turn = 20;
  const cols = ['#f4f0e8', '#3a2a20', '#c89058', '#e8e0d0', '#5a4030', '#d8b070', '#f4f0e8', '#8a5a3a'];
  for (let i = 0; i < n; i++) {
    const a0 = i * 2 * Math.PI / n;
    const tf = (t) => {
      const a = a0 + 2 * Math.PI * t / turn;
      const z = 1.55 + 0.32 * Math.sin(2 * Math.PI * t / 6 + i * Math.PI / 2);
      return m4.facing([cx + R * Math.cos(a), cy + R * Math.sin(a), z], [-Math.sin(a), Math.cos(a), 0]);
    };
    b.dynamic(horse(cols[i]), { times: timeRange(0, P, 1.0), transform: tf, caps: 'none' });
  }
}

function flags(b) {
  // two flags on the town hall's poles
  const L = 3.4, Hf = 2.2, nx = 5, nz = 2;
  const make = (col, ph) => (t) => {
    const g = Geo.plane(L, Hf, nx, nz).rotateX(Math.PI / 2).translate(L / 2, 0, 0);
    for (let i = 0; i < g.p.length; i += 3) {
      const x = g.p[i], u = x / L;
      g.p[i + 1] += u * 0.35 * Math.sin(2 * Math.PI * (u * 1.3 - t / 1.5) + ph);
      g.p[i + 2] -= u * u * 0.25;
    }
    g.computeNormals();
    return g.colorBy((p) => (p[2] > Hf / 6 ? col[0] : p[2] > -Hf / 6 ? col[1] : col[2]));
  };
  for (const [y, col, ph] of [[-12, ['#f2c12e', '#f4f1e8', '#d8402f'], 0], [12, ['#2f6fb3', '#f4f1e8', '#2f6fb3'], 1.7]]) {
    const top = [SQ - 3.2, y, 12.4];
    b.dynamic(make(col, ph), { times: timeRange(0, P, 0.25), transform: () => m4.mul(m4.translation(top[0], top[1], top[2] - Hf / 2 - 0.05), m4.rotationZ(Math.PI)), caps: 'none' });
  }
}

// ---------------------------------------------------------------------------
// the scene

export default {
  id: 'plaza',
  name: 'Old Town',
  blurb: 'A walled town on a festival day: trams, cyclists and walkers on a long avenue, and a clock tower that keeps time with the sky. Run, and the far end of the street falls behind in time.',
  C: 10,
  mode: 'walk',
  modes: ['walk', 'fly', 'drive'],
  spawn: { pos: [-205, 0, 0], t: 0, yaw: 90, pitch: 2 },
  period: P,
  viewDistance: 430,
  skyDistance: 520,
  shadowRadii: [40, 240],
  wgsl,

  build(b) {
    const rand = rng(1871);
    HOUSE_ID = 1;
    BOXES = [];
    MERLONS = [];

    // ground, subdivided so that no edge is long
    b.static(Geo.plane(3000, 3000, 40, 40).color('#888888').mat(MAT.GROUND));

    // ---- houses round the square and along the avenue
    const specials = { cinema: -1, chemists: [] };
    const extras = (h) => shopExtras(b, rand, h, specials);
    const front = { awnings: 0.35, onHouse: extras };
    // north side, facing south, with a lane at x = 14..19
    row(b, rand, { ...front, start: [-SQ - DEPTH, SQ], nrm: [0, -1], length: 2 * (SQ + DEPTH), gaps: [[SQ + DEPTH + 14, SQ + DEPTH + 19]] });
    specials.chemists.push(HOUSE_ID + 3);
    // south side, facing north, with a lane at x = -22..-17
    row(b, rand, { ...front, start: [SQ + DEPTH, -SQ], nrm: [0, 1], length: 2 * (SQ + DEPTH), gaps: [[SQ + DEPTH + 17, SQ + DEPTH + 22]] });
    // east side, facing west: houses either side of the town hall
    row(b, rand, { ...front, start: [SQ, SQ], nrm: [-1, 0], length: SQ - 18, ends: [false, true] });
    row(b, rand, { ...front, start: [SQ, -18], nrm: [-1, 0], length: SQ - 18, ends: [true, false] });
    // west side, either side of the avenue
    row(b, rand, { ...front, start: [-SQ, AW], nrm: [1, 0], length: SQ - AW, ends: [true, false] });
    row(b, rand, { ...front, start: [-SQ, -SQ], nrm: [1, 0], length: SQ - AW, ends: [false, true] });
    // the avenue, with a side street on each side
    specials.cinema = HOUSE_ID + 9;
    specials.chemists.push(HOUSE_ID + 4);
    row(b, rand, { ...front, start: [GATE_X, AW], nrm: [0, -1], length: -SQ - DEPTH - GATE_X, gaps: [[78, 84]] });
    specials.chemists.push(HOUSE_ID + 7);
    row(b, rand, { ...front, start: [-SQ - DEPTH, -AW], nrm: [0, 1], length: -SQ - DEPTH - GATE_X, gaps: [[64, 70]] });

    townHall(b);
    clockTower(b);
    gate(b);
    cityWall(b, rand);
    blocks(b, rand);

    // ---- street lamps
    const lamps = [];
    for (let k = 0; k < AV_LAMP.n; k++) {
      for (const y of [-AV_LAMP.y, AV_LAMP.y]) lamps.push(m4.translation(AV_LAMP.x0 + AV_LAMP.dx * k, y, 0));
    }
    for (const [x, y] of SQ_LAMPS) lamps.push(m4.translation(x, y, 0));
    b.instances(lampPost(), lamps);

    // ---- trees: along the avenue between the lamps, and a few in the square
    for (let k = 0; k < AV_LAMP.n - 1; k++) {
      for (const y of [-AV_LAMP.y - 0.2, AV_LAMP.y + 0.2]) {
        b.static(tree(rand).translate(AV_LAMP.x0 + AV_LAMP.dx * (k + 0.5), y, 0));
      }
    }
    for (const [x, y] of [[-13, 27], [13, 27], [-13, -27], [27, 13], [27, -13], [-27, 20], [-27, -20]]) b.static(tree(rand, 8.5).translate(x, y, 0));

    // ---- benches: on the axes facing the tower, round the fountain, along the avenue
    const bn = bench();
    for (const [x, y, a] of [[13.5, 0, -Math.PI / 2], [0, 13.5, 0], [0, -13.5, Math.PI], [-13.5, 3, Math.PI / 2], [-13.5, -3, Math.PI / 2]]) {
      addBoxes(bn, m4.mul(m4.translation(x, y, 0), m4.rotationZ(a)));
    }
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      addBoxes(bn, m4.mul(m4.translation(FOUNTAIN[0] + 7 * Math.cos(a), FOUNTAIN[1] + 7 * Math.sin(a), 0), m4.rotationZ(a - Math.PI / 2)));
    }
    for (let k = 0; k < AV_LAMP.n - 1; k += 2) {
      for (const s of [-1, 1]) addBoxes(bn, m4.mul(m4.translation(AV_LAMP.x0 + AV_LAMP.dx * (k + 0.5) + 3, s * 9.6, 0), m4.rotationZ(s > 0 ? 0 : Math.PI)));
    }
    // people resting on some of them
    for (const [x, y, a] of [[13.5, 0.4, Math.PI / 2], [-0.5, 13.5, Math.PI], [-13.5, -3.4, -Math.PI / 2]]) {
      b.static(person(rand, { sit: true }).rotateZ(a).translate(x, y, 0));
    }

    fountain(b);
    carousel(b);
    market(b, rand);
    cafe(b, rand);
    tramStop(b);
    signals(b);
    countryside(b, rand);

    // ---- tram rails
    const rails = densify(TRAM_PTS, 10, true);
    for (const o of [-0.72, 0.72]) b.static(ribbon(rails, o - 0.035, o + 0.035, 0.02, true).color('#a3a6aa').gloss(0.85));

    // ---- bunting: across the avenue, and from the tower to the corners of the square
    for (let k = 0; k < AV_LAMP.n - 1; k++) {
      const x = AV_LAMP.x0 + AV_LAMP.dx * (k + 0.5) + 6;
      b.static(bunting([x, -AW + 0.1, 9.4], [x + 3, AW - 0.1, 9.4], 1.3, rand));
    }
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      b.static(bunting([sx * 4.6, sy * 4.6, 29.6], [sx * 26, sy * 26, 5.3], 3.2, rand));
    }
    for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [8, 0]]) {
      const a = SQ_LAMPS[i], c = SQ_LAMPS[j];
      b.static(bunting([a[0], a[1], 5.2], [c[0], c[1], 5.2], 0.9, rand));
    }

    // ---- all the plain boxes and merlons gathered above
    b.instances(Geo.box(1, 1, 1).color('#ffffff'), BOXES);
    b.instances(Geo.box(1, 1, 1).color('#ffffff').mat(MAT.STONE), MERLONS);

    // ---- moving things
    trams(b);
    travellers(b, rand, R_BIKE_IN, { speed: 4.6, every: 8, make: cyclist, size: 0.9 });
    travellers(b, rand, R_BIKE_OUT, { speed: 4.6, every: 8, make: cyclist, size: 0.9, start: 4 });
    R_WALK.forEach((r, i) => travellers(b, rand, r, { speed: 1.35, every: 12, make: (rr) => person(rr, { scale: rr.range(0.9, 1.07) }), size: 0.4, start: i * 2.2 }));
    walkersRoundTower(b, rand);
    birds(b, rand);
    fountainJets(b);
    carouselHorses(b);
    flags(b);
  },
};
