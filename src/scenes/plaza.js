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
//            walkers come and go along the outside of the wall; north of it,
//            a yard with a stair up to the top of the wall (see WALK)
//   town     blocks of houses round both, inside a rectangular city wall

import { Geo } from '../geom.js';
import { m4, v3 } from '../math.js';
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
const WHEEL_R = 0.34;     // bicycle wheels
const CAROUSEL = [17, -17];
// how many times a second the sixteen spokes of a rolling wheel pass a point,
// and how blurred that makes them (see the shader's cutout)
const SPOKE_PASSES = 16 * 4.6 / WHEEL_R / (2 * Math.PI);
const SPOKE_BLUR = ((x) => x * x * (3 - 2 * x))(Math.min(1, Math.max(0, (SPOKE_PASSES - 3) / 17)));

// window rectangle inside one bay x storey cell of a facade (cell units); the
// shader draws the windows, the builder adds sills that line up with them
const WIN = { hw: 0.2, b: 0.27, t: 0.86 };

const MAT = {
  GROUND: 1, FACADE: 2, WALL: 3, ROOF: 4, STONE: 5, TOWER: 6, CLOCK: 7, LAMP: 8,
  WATER: 9, AWNING: 10, TRAM: 11, BULB: 12, DISPLAY: 13, LEAF: 14, GABLE: 15,
  JET: 16, CANOPY: 17, DOOR: 18, GLASS: 19, CURTAIN: 20, NEON: 21, PERSON: 22, WHEEL: 23, SIGN: 24, HORSE: 25,
};

// The city wall north of the gate can be walked along on top (WALK, at its
// full 9 m height), and a stone stair goes up to it against its inner face,
// from a yard beside the gate (STAIR: rising north from y0 to y1, then a
// landing to y2).  Both are part of `ground`, the one thing in the town that
// is not level: in a view tilted up, going up the stair takes the walker
// 9 m × tan(tilt) / 10 m/s on in time (a second at 45°), and coming down
// takes them back.  (Its edge with the wall's top is put 2 cm off the wall,
// so that the top of the wall and the treads each count as ground.)
const WALK = { x0: WALL.x0, x1: WALL.x0 + 2.6, y0: AW, y1: WALL.y + 1.3, z: 9 };
const STAIR = { x0: WALK.x1 + 0.02, x1: WALK.x1 + 2.6, y0: 15, y1: 31, y2: 33 };
function ground(x, y) {
  if (x < WALK.x0 - 0.01 || x > STAIR.x1 + 0.01 || y < WALK.y0 - 0.01 || y > WALK.y1 + 0.01) return 0;
  if (x < STAIR.x0 - 0.01) return WALK.z;
  if (y < STAIR.y0 || y > STAIR.y2 + 0.01) return 0;
  return WALK.z * Math.min(1, (y - STAIR.y0) / (STAIR.y1 - STAIR.y0));
}

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
const WHEEL_R = ${WHEEL_R.toFixed(3)};
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

// What is seen through a shop's window from near by: shelves of goods (kind
// 0), clothes on two figures (1) or a café's counter with lamps over it (2),
// and for some the shop's name in gold along the top of the glass.  f is the
// place in the facade's cell, y metres up from the foot of the glass, w the
// size of a pixel.  Returns the colour inside, how bright it is when lit (as
// a share of the light's colour), and where the gold letters are.
struct Shop { inside: vec3f, light: f32, letters: f32 };
fn shopInside(f: vec2f, cell: vec2f, kind: f32, y: f32, hr: f32, hr2: f32, w: vec2f) -> Shop {
  let goods = noise2(f * vec2f(14.0, 5.0) + cell * 3.1);
  var inside: vec3f;
  var light: f32;
  if (kind == 1.0) {
    // two dressed figures on stands against a pale wall
    inside = lin(vec3f(0.42, 0.38, 0.34)) * (0.8 + 0.3 * goods);
    let x = (fract(f.x * 2.0) - 0.5) * 1.33;
    let fid = hash21(vec2f(floor(f.x * 2.0) + cell.x * 2.0, 4.7));
    let hw = select(0.1 + 0.12 * (1.0 - y), 0.17 - 0.06 * (y - 1.0), y > 1.0);
    let cloth = step(0.45, y) * step(y, 1.45) * (1.0 - smoothstep(hw - 0.01, hw + 0.01, abs(x)));
    let head = saturate(ellipse(vec2f(x, y - 1.62), vec2f(0.085, 0.11), 0.01) + step(abs(x), 0.035) * step(1.4, y) * step(y, 1.55));
    let pole = saturate(step(abs(x), 0.018) * step(y, 0.5) + step(abs(x), 0.15) * step(y, 0.035));
    inside = mix(inside, select(paint(fract(fid * 5.3)) * 0.8, paint(fid), y > 1.0), cloth);
    inside = mix(inside, lin(vec3f(0.82, 0.8, 0.76)), head);
    inside = mix(inside, lin(vec3f(0.1)), pole);
    light = (0.35 + 0.35 * goods) * (1.0 - 0.7 * saturate(cloth + head + pole));
  } else if (kind == 2.0) {
    // a tiled wall, a counter with cakes and loaves on it, lamps hanging over it
    let tl = abs(fract(vec2f(f.x * 2.65, y) / 0.15) - 0.5);
    inside = lin(vec3f(0.6, 0.56, 0.48)) * (1.0 - 0.25 * step(0.44, max(tl.x, tl.y)) * (1.0 - smoothstep(0.004, 0.012, w.x)));
    let counter = step(y, 0.95);
    inside = mix(inside, lin(vec3f(0.3, 0.18, 0.1)) * (0.8 + 0.3 * step(0.88, y)), counter);
    let ck = hash21(vec2f(floor(f.x * 9.0), cell.x));
    let cake = ellipse(vec2f((fract(f.x * 9.0) - 0.5) * 0.3, y - 1.0), vec2f(0.1, 0.06), 0.01) * step(0.95, y) * step(0.3, ck);
    inside = mix(inside, mix(lin(vec3f(0.75, 0.5, 0.25)), lin(vec3f(0.9, 0.85, 0.75)), ck), cake);
    let lp = vec2f((fract(f.x * 3.0) - 0.5) * 0.9, y - 1.95);
    let glow = ellipse(lp, vec2f(0.12, 0.07), 0.01) * step(lp.y, 0.0);
    inside = mix(inside, lin(vec3f(0.15, 0.25, 0.2)), saturate(glow + step(abs(lp.x), 0.006) * step(0.0, lp.y)));
    light = (0.35 + 0.35 * goods) * (1.0 - 0.7 * saturate(counter + cake)) + 2.5 * glow;
  } else {
    inside = lin(vec3f(0.2, 0.17, 0.14) * (0.75 + 0.5 * goods));
    // things on the shelves: boxes, jars and bottles in rows, each its own colour and height
    let sq = vec2f(f.x * 26.0, (f.y - 0.12) / 0.58 * 3.0 + 0.5);
    let item = vec2f(floor(sq.x), floor(sq.y));
    let ih = hash22(item + cell * 7.3);
    let stand = step(0.18, fract(sq.x)) * step(fract(sq.x), 0.88) * step(0.08, fract(sq.y)) * step(fract(sq.y), 0.25 + 0.5 * ih.y) * step(0.25, ih.x) * step(0.5, sq.y) * step(sq.y, 3.5);
    inside = mix(inside, paint(fract(ih.x * 3.7 + hr)) * (0.6 + 0.5 * ih.y), stand * (1.0 - smoothstep(0.01, 0.03, w.x)) * step(f.y, 0.69));
    let shelf = 1.0 - smoothstep(0.012, 0.012 + w.y, abs(fract((f.y - 0.12) / 0.58 * 3.0) - 0.5) * 0.19);
    light = (0.25 + 0.6 * goods) * (1.0 - 0.5 * shelf);
  }
  // the shop's name in gold along the top of the glass, for some
  let lq = vec2f((f.x - 0.2) / 0.6, (f.y - 0.6) / 0.06);
  var letters = 0.0;
  if (hr2 >= 0.5 && lq.y >= 0.0 && lq.y <= 1.0 && lq.x >= 0.0 && lq.x <= 1.0) {
    letters = step(0.3, fract(lq.x * 9.0)) * step(0.35, noise2(vec2f(lq.x * 40.0, lq.y * 3.0) + cell));
  }
  return Shop(mix(inside, lin(vec3f(0.85, 0.66, 0.25)), letters), light, letters);
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
  var shine = 0.0;
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
      // its furniture: a brass knob, letterbox and bell, the house number on
      // an enamel plate, a worn stone step
      let m = vec2f(2.65, 4.1);                   // roughly metres to a cell
      let wm = max(w.x * m.x, 0.003);
      let knob = ellipse((f - vec2f(0.625, 0.245)) * m, vec2f(0.026, 0.026), wm);
      let slot = rectAA(f, vec2f(0.455, 0.3), vec2f(0.545, 0.316), w);
      let bell = ellipse((f - vec2f(0.69, 0.27)) * m, vec2f(0.017, 0.017), wm);
      shine = max(max(knob, slot), bell);
      c = mix(c, lin(vec3f(0.78, 0.6, 0.26)), shine);
      c *= 1.0 - 0.6 * rectAA(f, vec2f(0.465, 0.304), vec2f(0.535, 0.312), w);
      let plate = rectAA(f, vec2f(0.72, 0.47), vec2f(0.8, 0.53), w);
      let num = number7((f - vec2f(0.732, 0.478)) / vec2f(0.056, 0.044), 1.0 + floor(fract(cell.x * 0.1373 + 0.31) * 89.0), 2);
      c = mix(c, lin(vec3f(0.08, 0.17, 0.45)), plate);
      c = mix(c, vec3f(0.92), num * plate);
      c = mix(c, lin(vec3f(0.55, 0.53, 0.5)), rectAA(f, vec2f(0.29, 0.0), vec2f(0.71, 0.022), w));
      glass = fan;
      lit = step(0.5, hr) * nightOf(s.t);
    } else {
      let sfr = rectAA(f, vec2f(0.06, 0.08), vec2f(0.94, 0.74), w);
      let sw = rectAA(f, vec2f(0.1, 0.12), vec2f(0.9, 0.7), w);
      c = mix(c, trim * 0.85, sfr);
      glass = sw;
      // shops stay open into the evening
      let h = hours(s.t);
      lit = step(0.3, hr2) * step(16.5 + hr * 1.5, h) * step(h, 21.5 + hr2 * 2.0);
      // The inside, one of three kinds for each house (see shopInside), is
      // worked out only on the glass and from near by: where a pixel is
      // wider than about 10 cm across the window (from 50 m or so face on,
      // nearer at a slant) it gives way to the even tint it comes to from
      // there, so that the windows down the avenue cost no more than paint.
      let kind = floor(hash21(vec2f(hid * 0.71, 2.9)) * 3.0);
      let y = (f.y - 0.12) * 4.1;
      let low = step(y, 0.95);
      var light = 0.53;   // the lit inside's brightness, as a share of litCol
      if (kind == 1.0) {
        inside = lin(vec3f(0.4, 0.36, 0.33));
        light = 0.47;
      } else if (kind == 2.0) {
        inside = mix(lin(vec3f(0.57, 0.53, 0.46)), lin(vec3f(0.26, 0.15, 0.08)), low);
        light = 0.525 * (1.0 - 0.7 * low);
      } else {
        inside = lin(vec3f(0.2, 0.17, 0.14));
      }
      let near = (1.0 - smoothstep(0.025, 0.04, w.x)) * step(0.001, sw);
      if (near > 0.0) {
        let v = shopInside(f, cell, kind, y, hr, hr2, w);
        inside = mix(inside, v.inside, near);
        light = mix(light, v.light, near);
        shine = max(shine, v.letters * near);
      }
      litCol = select(lin(mix(vec3f(0.95, 0.8, 0.6), vec3f(0.95, 0.7, 0.45), hr)), lin(vec3f(0.95, 0.78, 0.55)), kind > 0.5) * light;
    }
    let fascia = rectAA(f, vec2f(-0.1, 0.79), vec2f(1.1, 0.93), w) * step(0.35, hr2);
    c = mix(c, paint(fract(hr * 3.7)) * 0.8, fascia);
    let plinth = 1.0 - smoothstep(0.06, 0.06 + w.y, f.y);
    c = mix(c, lin(vec3f(0.42, 0.4, 0.38)), plinth);
  }
  let glassC = mix(inside, litCol * 0.9, lit);
  s.color = mix(c, glassC, glass);
  s.emissive = glass * lit * select(1.7, 1.2, cell.y < 1.0);
  s.gloss = max(mix(0.08, mix(0.6, 0.2, lit), glass), shine * 0.7);
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
      // the kerb, in stones a metre long
      let kerb = (1.0 - smoothstep(0.15, 0.15 + px, abs(ay - 9.0))) * (1.0 - 0.5 * (1.0 - smoothstep(0.006, 0.006 + px, abs(fract(p.x) - 0.5) - 0.49)));
      c = mix(c, lin(vec3f(0.5, 0.5, 0.52)), kerb);
      // studded paving where the zebra crossing meets the pavement
      if (abs(p.x - ${f1(CROSS_X)}) < 1.8 && ay < 9.95) {
        let dot_ = 1.0 - smoothstep(0.2, 0.3, length(fract(p * 14.0) - 0.5));
        c = mix(lin(vec3f(0.78, 0.72, 0.5)), lin(vec3f(0.9, 0.85, 0.62)), dot_ * (1.0 - smoothstep(0.01, 0.03, px)));
      }
      // a manhole cover now and then
      let mq = vec2f(fract((p.x + 7.0) / 23.0) * 23.0 - 11.5, ay - 11.1);
      let mr = length(mq);
      if (mr < 0.36) {
        let rings = step(0.5, fract(mr * 28.0)) * step(mr, 0.3);
        let grid = step(0.6, fract((mq.x + mq.y) * 14.0)) * step(0.6, fract((mq.x - mq.y) * 14.0));
        c = mix(lin(vec3f(0.2, 0.2, 0.21)), lin(vec3f(0.32, 0.31, 0.3)), max(rings, grid) * (1.0 - smoothstep(0.02, 0.06, px)));
        c *= 1.0 - 0.5 * (1.0 - smoothstep(0.008, 0.008 + px, abs(mr - 0.33)));
        gl = 0.35;
      }
    } else if (ay > 7.0) {
      // strip of fine gravel for the trees and lamps, an iron grate round each tree
      c = lin(vec3f(0.6, 0.55, 0.46)) * (0.85 + 0.25 * noise2(p * 9.0));
      let tq = vec2f((fract((p.x - ${f1(AV_LAMP.x0 + AV_LAMP.dx * 0.5)}) / ${f1(-AV_LAMP.dx)} + 0.5) - 0.5) * ${f1(-AV_LAMP.dx)}, ay - ${f1(AV_LAMP.y + 0.2)});
      if (max(abs(tq.x), abs(tq.y)) < 0.72 && p.x < ${f1(AV_LAMP.x0 + AV_LAMP.dx * 0.5 + 1)} && p.x > ${f1(AV_LAMP.x0 + AV_LAMP.dx * (AV_LAMP.n - 1.5) - 1)}) {
        let tr = length(tq);
        let slot = step(0.45, fract(atan2(tq.y, tq.x) * ${f1(24 / (2 * Math.PI))})) * step(0.3, tr) * step(max(abs(tq.x), abs(tq.y)), 0.64) * (1.0 - smoothstep(0.02, 0.05, px));
        c = mix(lin(vec3f(0.16, 0.16, 0.17)), lin(vec3f(0.06, 0.05, 0.04)), slot);
        gl = 0.25;
      }
    } else if (ay > ${f1(BIKE_Y - 0.85)} && ay < ${f1(BIKE_Y + 0.85)}) {
      c = lin(vec3f(0.55, 0.3, 0.25)) * (0.92 + 0.1 * noise2(p * 3.0));
      let edge = 1.0 - smoothstep(0.05, 0.05 + px, abs(abs(ay - ${f1(BIKE_Y)}) - 0.76));
      c = mix(c, lin(vec3f(0.85, 0.83, 0.78)), edge);
      gl = 0.08;
    } else if (ay > ${f1(BIKE_Y + 0.85)} && ay < 7.0) {
      // a gully grating at the edge of the cycle lane every 15 m
      let gq = vec2f(fract((p.x + 3.0) / 15.0) * 15.0 - 7.5, ay - 6.55);
      if (abs(gq.x) < 0.32 && abs(gq.y) < 0.22) {
        let slots = step(0.45, fract(gq.x * 22.0)) * step(abs(gq.y), 0.17) * step(abs(gq.x), 0.27);
        c = mix(lin(vec3f(0.24, 0.24, 0.25)), lin(vec3f(0.02, 0.02, 0.02)), slots * (1.0 - smoothstep(0.015, 0.04, px)));
        gl = 0.3;
      }
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

// tram body: on the sides uv = (along / 1.4 + 0.5, height), on the ends
// (x + 1.2, height + 4).  tag: 0 the right side, 4 the left side, 1 the
// driving end (on these two the lettering is mirrored), 2 the back end, 3 an end facing the next
// section, 5 the roof.  aux: which tram and section (3 * tram + section + 1).
// The destination board's dot-matrix letters, 5 x 7 dots each: A L T S D 4
const GLYPHS = array<u32, 12>(1033774u, 17969u, 541200u, 32272u, 135327u, 4228u, 475663u, 30753u, 575038u, 31281u, 600258u, 2143u);
fn glyphDot(g: u32, col: u32, row: u32) -> f32 {
  let bits = select(GLYPHS[g * 2u + 1u] >> (5u * (row - 4u)), GLYPHS[g * 2u] >> (5u * row), row < 4u);
  return f32((bits >> (4u - col)) & 1u);
}
// "4 ALTSTADT" across a board, q in 0..1 both ways
fn destBoard(q: vec2f, px: f32) -> f32 {
  var text = array<u32, 10>(5u, 9u, 0u, 1u, 2u, 3u, 2u, 0u, 4u, 2u);
  let cell = vec2f(q.x * 60.0, (1.0 - q.y) * 9.0 - 1.0);
  let ch = u32(clamp(floor(cell.x / 6.0), 0.0, 9.0));
  let col = u32(floor(cell.x - f32(ch) * 6.0));
  let row = floor(cell.y);
  if (text[ch] > 5u || col > 4u || row < 0.0 || row > 6.0) { return 0.0; }
  let on = glyphDot(text[ch], col, u32(row));
  // round dots from near by, an even glow from afar
  let dot = 1.0 - smoothstep(0.3, 0.42, length(fract(cell) - 0.5));
  return on * mix(dot, 0.6, smoothstep(0.3, 0.8, px * 60.0));
}
// a seated figure seen through a window: head and shoulders, q in metres from the seat
fn passenger(q: vec2f, w: f32) -> f32 {
  let head = ellipse(q - vec2f(0.0, 0.5), vec2f(0.1, 0.12), w);
  let body = ellipse(q - vec2f(0.0, 0.18), vec2f(0.24, 0.2), w);
  return max(head, body);
}
fn tramBody(sIn: Surface, fw: vec2f) -> Surface {
  var s = sIn;
  let w = max(fw, vec2f(0.003));
  let night = nightOf(s.t);
  let id = round(s.aux * 127.0);
  var glass = 0.0;
  var red = 0.0;
  var dark = 0.0;     // rubber, seals, bellows
  var metal = 0.0;    // handrails, rims
  var lampW = 0.0;    // head lamps
  var lampR = 0.0;    // tail lamps
  var sign_ = 0.0;    // destination board, lit
  var board = 0.0;    // destination board, its black face
  var fig = 0.0;      // people inside
  var zz = s.uv.y;
  let lamp = vec3f(1.0, 0.82, 0.58);
  if (s.tag == 0u || s.tag == 4u) {
    let z = s.uv.y;
    let bay = floor(s.uv.x);
    let f = fract(s.uv.x);
    // a pair of doors in the middle bay, glazed, with handrails either side
    let door = bay == 2.0;
    if (door) {
      let leaf = rectAA(vec2f(f, z), vec2f(0.04, 0.42), vec2f(0.96, 2.48), w);
      let seam = 1.0 - smoothstep(0.004, 0.004 + w.x, abs(f - 0.5));
      let edge = leaf * (1.0 - rectAA(vec2f(f, z), vec2f(0.07, 0.47), vec2f(0.93, 2.43), w));
      glass = rectAA(vec2f(abs(f - 0.5), z), vec2f(0.06, 0.95), vec2f(0.4, 2.3), w);
      dark = max(max(seam, edge), (1.0 - rectAA(vec2f(abs(f - 0.5), z), vec2f(0.075, 0.93), vec2f(0.39, 2.32), w)) * rectAA(vec2f(abs(f - 0.5), z), vec2f(0.055, 0.9), vec2f(0.415, 2.35), w));
      metal = (1.0 - smoothstep(0.012, 0.012 + w.x, abs(abs(f - 0.5) - 0.465))) * step(1.0, z) * step(z, 2.2);
      // the button to open it
      let btn = ellipse(vec2f((f - 0.62) * 1.4, z - 1.25), vec2f(0.025, 0.025), w.y);
      s.color = mix(s.color, lin(vec3f(0.1, 0.6, 0.2)), btn);
    } else {
      // a window: pane, rubber seal, a top light that opens
      glass = rectAA(vec2f(f, z), vec2f(0.08, 1.42), vec2f(0.92, 2.43), w);
      let seal = rectAA(vec2f(f, z), vec2f(0.06, 1.39), vec2f(0.94, 2.46), w) - glass;
      let transom = (1.0 - smoothstep(0.012, 0.012 + w.y, abs(z - 2.15))) * glass;
      dark = max(seal, transom);
      glass -= transom;
      // someone sitting by some of the windows
      let h = hash21(vec2f(bay * 1.7 + id * 3.1, f32(s.tag) + 0.5));
      if (h < 0.55) {
        fig = passenger(vec2f((f - 0.3 - 0.4 * fract(h * 7.0)) * 1.4, z - 1.45 + 0.08 * fract(h * 13.0)), w.y) * glass;
      }
    }
    red = rectAA(vec2f(0.5, z), vec2f(0.0, 0.45), vec2f(1.0, 1.05), w) * (1.0 - select(0.0, rectAA(vec2f(f, z), vec2f(0.04, 0.42), vec2f(0.96, 2.48), w), door))
        + rectAA(vec2f(0.5, z), vec2f(0.0, 2.62), vec2f(1.0, 2.72), w);
    // the fleet number, low down at one end of each section
    if (bay == 4.0) {
      var q = vec2f(f, z);
      if (s.tag == 4u) { q.x = 1.0 - q.x; }
      let num = number7((q - vec2f(0.3, 0.6)) / vec2f(0.4, 0.3), 200.0 + id, 3);
      s.color = mix(s.color, lin(vec3f(0.95, 0.92, 0.84)), num * red);
    }
    dark = max(dark, 1.0 - smoothstep(0.5, 0.5 + w.y, z));
  } else if (s.tag == 5u) {
    s.color *= 0.9;
  } else if (s.tag == 6u) {
    // under the floor: a bogie, its side frame with springs and axle boxes, two wheels a side
    let y = s.uv.x - 3.2;
    let z = s.uv.y;
    let q = vec2f(abs(y) - 0.85, z - 0.3);
    let r = length(q);
    let wheel = 1.0 - smoothstep(0.3, 0.3 + w.x, r);
    let rim = smoothstep(0.24, 0.24 + w.x, r) * wheel;
    let hub = 1.0 - smoothstep(0.075, 0.075 + w.x, r);
    let frame = rectAA(vec2f(y, z), vec2f(-1.3, 0.26), vec2f(1.3, 0.4), w) + rectAA(q, vec2f(-0.09, -0.09), vec2f(0.09, 0.12), w);
    let spring = rectAA(vec2f(y, z), vec2f(-0.25, 0.08), vec2f(0.25, 0.26), w) * (0.6 + 0.4 * step(0.5, fract(z * 30.0)));
    var c = lin(vec3f(0.06, 0.065, 0.07));
    c = mix(c, lin(vec3f(0.16, 0.16, 0.17)), wheel);
    c = mix(c, lin(vec3f(0.42, 0.42, 0.44)), max(rim, hub * 0.6));
    c = mix(c, lin(vec3f(0.12, 0.12, 0.13)), saturate(frame));
    c = mix(c, lin(vec3f(0.3, 0.12, 0.1)), spring);
    s.color = c;
    s.gloss = 0.3 + 0.4 * rim;
    return s;
  } else {
    let z = s.uv.y - 4.0;
    zz = z;
    var x = s.uv.x - 1.2;
    if (s.tag == 1u) { x = -x; }   // (so that the lettering reads from in front)
    if (s.tag == 3u) {
      // towards the next section: the bellows of the gangway
      let gw = rectAA(vec2f(x, z), vec2f(-0.75, 0.45), vec2f(0.75, 2.6), w);
      dark = gw * (0.75 + 0.25 * step(0.5, fract(z * 9.0)));
      red = rectAA(vec2f(x, z), vec2f(-2.0, 0.45), vec2f(2.0, 1.05), w) * (1.0 - gw);
    } else {
      // a driving end (or the back end): windscreen with its wiper and the
      // driver, the destination board, lamps, bumper
      glass = rectAA(vec2f(x, z), vec2f(-1.02, 1.35), vec2f(1.02, 2.45), w);
      let seal = rectAA(vec2f(x, z), vec2f(-1.06, 1.31), vec2f(1.06, 2.49), w) - glass;
      let wiper = (1.0 - smoothstep(0.008, 0.008 + w.x, abs(sdSegment(vec2f(x, z), vec2f(0.25, 1.4), vec2f(-0.35, 2.15))))) * glass;
      dark = max(seal, wiper);
      if (s.tag == 1u) { fig = passenger(vec2f(x + 0.32, z - 1.25), w.y) * glass; }
      board = rectAA(vec2f(x, z), vec2f(-0.78, 2.53), vec2f(0.78, 2.84), w);
      sign_ = destBoard((vec2f(x, z) - vec2f(-0.72, 2.57)) / vec2f(1.44, 0.24), max(w.x / 1.44, 0.0)) * board;
      red = rectAA(vec2f(x, z), vec2f(-2.0, 0.45), vec2f(2.0, 1.05), w);
      let lr = ellipse(vec2f(abs(x) - 0.82, z - 0.8), vec2f(0.095, 0.095), w.x);
      let ring = ellipse(vec2f(abs(x) - 0.82, z - 0.8), vec2f(0.12, 0.12), w.x) - lr;
      metal = ring;
      if (s.tag == 1u) { lampW = lr; } else { lampR = lr; }
      // indicators, and the bumper
      let ind = rectAA(vec2f(abs(x), z), vec2f(0.96, 0.74), vec2f(1.1, 0.86), w);
      s.color = mix(s.color, lin(vec3f(0.95, 0.55, 0.1)), ind);
      dark = max(dark, rectAA(vec2f(x, z), vec2f(-1.3, 0.4), vec2f(1.3, 0.56), w));
    }
  }
  s.color = mix(s.color, lin(vec3f(0.62, 0.12, 0.1)), saturate(red));
  let inside = mix(lin(vec3f(0.06, 0.07, 0.08)), lamp * (0.35 + 0.3 * smoothstep(1.4, 2.45, zz)), night);
  let figC = mix(lin(vec3f(0.24, 0.2, 0.18)), lin(vec3f(0.1, 0.07, 0.05)) * lamp, night);
  s.color = mix(s.color, mix(inside, figC, fig), glass);
  s.color = mix(s.color, lin(vec3f(0.05, 0.05, 0.055)), saturate(dark));
  s.color = mix(s.color, lin(vec3f(0.8, 0.82, 0.85)), saturate(metal));
  s.emissive = glass * (1.0 - fig * 0.6) * night * 1.1;
  s.gloss = mix(mix(0.45, 0.8, glass), 0.85, saturate(metal));
  s.color = mix(s.color, vec3f(0.02), board);
  s.color = mix(s.color, vec3f(1.0, 0.55, 0.1), sign_);
  s.color = mix(s.color, vec3f(1.0, 0.95, 0.82), lampW);
  s.color = mix(s.color, vec3f(1.0, 0.1, 0.05), lampR);
  s.emissive = max(max(s.emissive, sign_ * 4.0), max(lampW * 6.0, lampR * 4.0));
  return s;
}

// Scalloped valances: on the shop awnings, the market stalls and the
// parasols (tag 1: uv.x in metres along the edge, a tongue every 0.275 m, one
// to a stripe of the awnings; uv.y from 0 at the top to 1 at the bottom), and
// on the carousel (tag 2: its own uv, the tongues turning with the stripes).
// Where a tongue is only a few pixels wide they give way to a plain edge.
fn cutout(s: Surface) -> f32 {
  let fw = fwidth(s.uv.x);
  let fw2 = fwidth(s.uv.y);
  if (s.mat == ${MAT.WHEEL}u) {
    // a bicycle wheel (uv: metres from the hub, plus 1): tyre and rim, a
    // hub, and sixteen spokes, turning as the wheel rolls along at 4.6 m/s.
    // The page shows a frame at one instant, 60 or so a second, so spokes
    // that pass more than about 20 times a second seem to stand, flicker or
    // turn backwards; the eye sees a blur.  So the spokes thin away as they
    // come round faster (all there at 3 passes a second, gone at 20; a
    // rolling wheel's pass ${SPOKE_PASSES.toFixed(0)}): their blur, an even tone of a few per cent,
    // is less than a cut-out can show, which leaves the open wheel, its tyre,
    // rim and hub sharp.  A parked bicycle (tag 1) keeps its spokes.
    let q = s.uv - vec2f(1.0);
    let r = length(q);
    let px = max(max(fw, fw2), 1e-4);
    let outer = saturate((WHEEL_R - r) / px + 0.5);
    let rim = saturate((r - 0.283) / px + 0.5);
    let hub = saturate((0.032 - r) / px + 0.5);
    let parked = s.tag == 1u;
    let ang = atan2(q.y, q.x) + select(s.t * ${(4.6 / WHEEL_R).toFixed(3)}, 0.0, parked) + s.aux * 3.0;
    let d = abs(fract(ang * 16.0 / TAU + 0.5) - 0.5) * TAU / 16.0 * r;
    let blur = select(${SPOKE_BLUR.toFixed(3)}, 0.0, parked);
    let spoke = saturate((0.0017 * (1.0 - blur) - d) / px + 0.5 - blur);
    return outer * max(max(rim, hub), spoke);
  }
  if (s.tag == 0u || s.tag > 2u || s.mat == ${MAT.PERSON}u) { return 1.0; }
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

// Figures (material PERSON), drawn on: aux holds a style number (see
// person() for its bits); tag & 7 says which part: 1 the body (uv.x round it
// from +x, the front at 0.25; uv.y the height in metres), 2 the head (its
// sphere's uv), 3 a hat, 4 hair, 5 the end of a scarf; tag >> 3 is the colour
// of the hair.
fn styleHash(id: u32, k: f32) -> f32 { return hash21(vec2f(f32(id) * 0.618 + k * 3.1, k * 1.37 + 0.5)); }
fn hairCol(k: u32) -> vec3f {
  var pal = array<vec3f, 6>(vec3f(0.165, 0.118, 0.078), vec3f(0.353, 0.227, 0.125), vec3f(0.69, 0.533, 0.314), vec3f(0.102, 0.102, 0.102),
                            vec3f(0.541, 0.541, 0.541), vec3f(0.478, 0.227, 0.125));
  return lin(pal[min(k, 5u)]);
}
fn scarfCol(id: u32) -> vec3f {
  var pal = array<vec3f, 6>(vec3f(0.8, 0.16, 0.12), vec3f(0.95, 0.74, 0.2), vec3f(0.2, 0.45, 0.75), vec3f(0.92, 0.9, 0.85),
                            vec3f(0.25, 0.55, 0.3), vec3f(0.62, 0.25, 0.55));
  return lin(pal[min(u32(styleHash(id, 2.0) * 6.0), 5u)]);
}
fn ellipse(p: vec2f, r: vec2f, w: f32) -> f32 {
  let d = (length(p / r) - 1.0) * min(r.x, r.y);
  return 1.0 - smoothstep(-w, w, d);
}
fn personSurf(sIn: Surface, fw: vec2f) -> Surface {
  var s = sIn;
  let id = u32(clamp(round(s.aux * 127.0 + 64.0), 0.0, 127.0));
  let part = s.tag & 7u;
  let hc = hairCol(s.tag >> 3u);
  var c = s.color;
  if (part == 1u) {
    let z = s.uv.y;
    let f = fract(s.uv.x - 0.25 + 0.5) - 0.5;      // 0 at the front, -0.5 or 0.5 at the back
    let x = f * 1.2;                               // roughly metres across the front
    let xb = (0.5 - abs(f)) * 1.2;                 // and from the middle of the back
    let w = max(max(fw.x * 1.2, fw.y), 0.0015);
    let coatBot = select(0.82, 0.56, (id & 64u) != 0u);
    if (z < coatBot) {
      var tp = array<vec3f, 4>(vec3f(0.16, 0.16, 0.19), vec3f(0.23, 0.25, 0.29), vec3f(0.29, 0.23, 0.19), vec3f(0.13, 0.15, 0.18));
      c = lin(tp[(id >> 4u) & 3u]);
      // the gap between the legs, front and back, and the shoes
      let gap = 1.0 - smoothstep(0.005, 0.005 + w, min(abs(x), xb));
      c *= 1.0 - 0.8 * gap * smoothstep(0.86, 0.78, z);
      let sh = 1.0 - smoothstep(0.075, 0.075 + w, z);
      c = mix(c, lin(vec3f(0.09, 0.075, 0.065)), sh);
      s.gloss = mix(0.12, 0.45, sh);
    } else {
      // the coat: its opening down the front, buttons or a zip, pocket flaps,
      // a seam down the back, a darker hem
      let front = 1.0 - smoothstep(0.004, 0.004 + w, abs(x));
      let upTo = step(z, 1.31);
      c *= 1.0 - 0.4 * front * upTo;
      if ((id & 2u) != 0u) {
        let q = vec2f(abs(x) - 0.024, (fract((z - coatBot - 0.06) / 0.1 + 0.5) - 0.5) * 0.1);
        let btn = ellipse(q, vec2f(0.0085, 0.0085), w) * step(coatBot + 0.02, z) * step(z, 1.3);
        let brass = styleHash(id, 5.0) < 0.4;
        c = mix(c, select(lin(vec3f(0.1, 0.09, 0.08)), lin(vec3f(0.8, 0.62, 0.25)), brass), btn);
        s.gloss = mix(0.12, 0.6, btn);
      } else {
        c = mix(c, lin(vec3f(0.72, 0.72, 0.7)), front * upTo * 0.6);
      }
      let pz = coatBot + 0.15;
      let pk = (1.0 - smoothstep(0.005, 0.005 + w, abs(z - pz))) * (1.0 - smoothstep(0.032, 0.032 + w, abs(abs(x) - 0.085)));
      c *= 1.0 - 0.4 * pk;
      c *= 1.0 - 0.3 * (1.0 - smoothstep(0.003, 0.003 + w, xb)) * step(z, 1.26);
      c *= 0.75 + 0.25 * smoothstep(0.0, 0.035 + w, z - coatBot);
      // the sleeves, down the sides, with a cuff above the hand
      let side = abs(abs(f) - 0.25) * 1.2;
      let arm = step(0.885, z) * step(z, 1.36);
      c *= 1.0 - 0.4 * (1.0 - smoothstep(0.005, 0.005 + w, abs(side - 0.07))) * arm;
      c *= 1.0 - 0.35 * (1.0 - smoothstep(0.011, 0.011 + w, abs(z - 0.9))) * (1.0 - smoothstep(0.07, 0.07 + w, side));
      if ((id & 1u) != 0u) {
        // a scarf, striped
        let band = smoothstep(1.355 - w, 1.355 + w, z);
        let stripe = step(0.5, fract(z * 28.0 + f * 2.0));
        c = mix(c, scarfCol(id) * (0.8 + 0.2 * stripe), band);
      } else {
        // a shirt collar in the opening of the coat
        let vv = step(1.24, z) * (1.0 - smoothstep(0.0, w, abs(x) - (z - 1.24) * 0.33));
        c = mix(c, lin(vec3f(0.88, 0.87, 0.84)), vv);
      }
    }
  } else if (part == 2u || part == 6u) {
    let f = fract(s.uv.x - 0.25 + 0.5) - 0.5;
    let a = abs(f);
    let x = f * 0.672;                          // roughly metres across the face
    let y = (0.5 - s.uv.y) * 0.38;              // and up from the middle of the head
    let w = max(max(fw.x * 0.672, fw.y * 0.38), 0.0012);
    // the hair line: low over the forehead, above the ears, down to the neck at the back
    let longHair = styleHash(id, 4.0) < 0.4;
    var hl = mix(0.052 + 0.006 * sin(x * 150.0), select(-0.075, -0.16, longHair), smoothstep(0.12, 0.36, a));
    if (!longHair) { hl += 0.055 * (1.0 - smoothstep(0.0, 0.07, abs(a - 0.25))); }
    var hair = smoothstep(hl - w, hl + w, y);
    if ((id & 8u) != 0u && styleHash(id, 3.0) < 0.5) {
      // bald on top
      hair *= 1.0 - smoothstep(0.05, 0.05 + w, y);
    }
    let ex = abs(x) - 0.03;
    let eye = ellipse(vec2f(ex, y - 0.016), vec2f(0.0115, 0.0062), w);
    let iris = ellipse(vec2f(ex, y - 0.016), vec2f(0.0056, 0.0056), w);
    var irisC = array<vec3f, 4>(vec3f(0.25, 0.15, 0.08), vec3f(0.2, 0.35, 0.55), vec3f(0.25, 0.38, 0.22), vec3f(0.08, 0.06, 0.05));
    c = mix(c, lin(vec3f(0.93, 0.91, 0.88)), eye);
    c = mix(c, lin(irisC[min(u32(styleHash(id, 6.0) * 4.0), 3u)]) * (1.0 - 0.6 * ellipse(vec2f(ex, y - 0.016), vec2f(0.0025, 0.0025), w)), iris * eye);
    let brow = (1.0 - smoothstep(0.0028, 0.0028 + w, abs(y - 0.033 + 0.12 * ex))) * (1.0 - smoothstep(0.014, 0.014 + w, abs(ex)));
    c = mix(c, hc * 0.7, brow);
    let my = y + 0.046 - 7.0 * x * x;
    let mouth = (1.0 - smoothstep(0.0032, 0.0032 + w, abs(my))) * (1.0 - smoothstep(0.017, 0.017 + w, abs(x)));
    c = mix(c, c * vec3f(0.62, 0.3, 0.28), mouth);
    c *= mix(vec3f(1.0), vec3f(1.04, 0.9, 0.88), ellipse(vec2f(ex - 0.006, y + 0.022), vec2f(0.017, 0.012), 0.008));
    if ((id & 4u) != 0u) {
      let rim = abs(length(vec2f(ex, (y - 0.016) * 1.35)) - 0.0165);
      let gl = (1.0 - smoothstep(0.0016, 0.0016 + w, rim)) + (1.0 - smoothstep(0.0014, 0.0014 + w, abs(y - 0.019))) * (1.0 - smoothstep(0.014, 0.014 + w, abs(x)));
      c = mix(c, vec3f(0.015), saturate(gl));
    }
    if ((id & 8u) != 0u) {
      let bd = smoothstep(-0.008 - w, -0.008 + w, -y) * (1.0 - smoothstep(0.052, 0.062, abs(x))) * (1.0 - mouth);
      c = mix(c, hc, bd * 0.92);
    }
    c *= 1.0 - 0.2 * ellipse(vec2f((a - 0.25) * 0.672, y + 0.004), vec2f(0.011, 0.021), w) * (1.0 - hair);
    if (part == 6u) {
      // a cycling helmet over it all, with vents, and its strap
      var hp = array<vec3f, 4>(vec3f(0.88, 0.23, 0.16), vec3f(0.94, 0.94, 0.94), vec3f(0.16, 0.42, 0.82), vec3f(0.94, 0.75, 0.13));
      let hel = lin(hp[min(s.tag >> 3u, 3u)]);
      let shell = smoothstep(-w, w, y - mix(0.046, -0.03, smoothstep(0.1, 0.4, a)));
      let vent = step(0.72, fract(s.uv.x * 14.0)) * smoothstep(0.05, 0.07, y);
      let strap = (1.0 - smoothstep(0.003, 0.003 + w, abs(a - 0.22))) * step(y, 0.0) * step(-0.09, y);
      c = mix(c, hc * 0.8, hair * (1.0 - shell));
      c = mix(c, hel * (1.0 - 0.75 * vent), shell);
      c = mix(c, vec3f(0.02), strap);
      s.gloss = mix(0.2, 0.55, shell);
    } else {
      c = mix(c, hc * (0.9 + 0.2 * noise2(vec2f(s.uv.x * 40.0, s.uv.y * 6.0))), hair);
      s.gloss = mix(0.2, 0.3, hair);
    }
  } else if (part == 3u) {
    c *= 1.0 - 0.45 * (1.0 - smoothstep(0.028, 0.03, s.uv.y));
  } else if (part == 4u) {
    c = hc;
  } else if (part == 5u) {
    c = scarfCol(id) * (0.8 + 0.2 * step(0.5, fract(s.uv.x * 3.0))) * (1.0 - 0.3 * step(0.9, s.uv.y));
  }
  s.color = c;
  return s;
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
    // iron: three strap hinges, rows of studs, a ring handle, and the split between the two leaves
    let iron = lin(vec3f(0.08, 0.08, 0.09));
    let hz = min(min(abs(s.uv.y - 0.5), abs(s.uv.y - 1.8)), abs(s.uv.y - 3.1));
    let strap = (1.0 - smoothstep(0.045, 0.045 + ww.y, hz)) * step(0.25, abs(s.uv.x)) * arch;
    let stud = (1.0 - smoothstep(0.018, 0.018 + ww.x, length(vec2f(fract(s.uv.x * 3.0) - 0.5, fract(s.uv.y * 3.0) - 0.5) / 3.0))) * arch;
    let ring = (1.0 - smoothstep(0.012, 0.012 + ww.x, abs(length(vec2f(abs(s.uv.x) - 0.2, s.uv.y - 1.15)) - 0.09))) * arch;
    let split = (1.0 - smoothstep(0.008, 0.008 + ww.x, abs(s.uv.x))) * arch;
    s.color = mix(s.color, iron, max(max(strap, stud * 0.9), max(ring, split)));
    s.gloss = max(s.gloss, 0.4 * max(strap, max(stud, ring)));
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
  } else if (s.mat == ${MAT.PERSON}u) {
    s = personSurf(s, fwu);
  } else if (s.mat == ${MAT.SIGN}u && s.tag == 2u) {
    // a tram stop's sign: a yellow H on green, in a white ring
    let q = s.uv - vec2f(0.5);
    let ww = max(max(fwu.x, fwu.y), 0.004);
    let r = length(q);
    let h = max(rectAA(abs(q), vec2f(0.13, 0.0), vec2f(0.19, 0.27), vec2f(ww)), rectAA(abs(q), vec2f(0.0, 0.0), vec2f(0.19, 0.035), vec2f(ww)));
    s.color = mix(s.color, lin(vec3f(0.95, 0.82, 0.1)), h);
    s.color = mix(s.color, lin(vec3f(0.95)), smoothstep(0.43 - ww, 0.43 + ww, r));
    s.gloss = 0.4;
  } else if (s.mat == ${MAT.SIGN}u && s.tag == 3u) {
    // a timetable: columns of departure times under a heading
    let ww = max(fwu, vec2f(0.004));
    let head = rectAA(s.uv, vec2f(0.06, 0.86), vec2f(0.94, 0.95), ww);
    let row = fract(s.uv.y * 30.0);
    let colx = fract(s.uv.x * 4.0);
    let txt = step(0.3, row) * step(row, 0.7) * step(0.12, colx) * step(colx, 0.8) * step(0.06, s.uv.y) * step(s.uv.y, 0.82) * step(0.06, s.uv.x) * step(s.uv.x, 0.94)
            * step(0.3, noise2(s.uv * vec2f(120.0, 30.0)));
    s.color = mix(s.color, lin(vec3f(0.1, 0.25, 0.15)), head);
    s.color = mix(s.color, lin(vec3f(0.15)), txt * 0.8 * (1.0 - smoothstep(0.004, 0.02, ww.x)));
  } else if (s.mat == ${MAT.SIGN}u && s.tag == 1u) {
    // a price card: a price in black, the cents smaller
    let pr = 1.0 + floor(hash21(floor(s.pos.xy * 3.0)) * 6.0);
    let d = number7((s.uv - vec2f(0.12, 0.2)) / vec2f(0.3, 0.6), pr, 1) + number7((s.uv - vec2f(0.5, 0.4)) / vec2f(0.4, 0.4), floor(hash21(floor(s.pos.yx * 3.0)) * 10.0) * 10.0 + 9.0, 2);
    s.color = mix(s.color, lin(vec3f(0.08)), saturate(d));
  } else if (s.mat == ${MAT.SIGN}u) {
    // a chalk board in a wooden frame: a heading and lines of writing
    let ww = max(fwu, vec2f(0.004));
    let fr = 1.0 - rectAA(s.uv, vec2f(0.07, 0.06), vec2f(0.93, 0.95), ww);
    let row = fract(s.uv.y * 9.0);
    let line = step(0.35, row) * step(row, 0.62) * step(0.15, s.uv.x) * step(s.uv.x, 0.85 - 0.3 * hash21(vec2f(floor(s.uv.y * 9.0), floor(s.pos.x + s.pos.y))))
             * step(0.15, s.uv.y) * step(s.uv.y, 0.78) * step(0.35, noise2(s.uv * vec2f(60.0, 9.0)));
    s.color = mix(s.color, lin(vec3f(0.85, 0.85, 0.8)), line * 0.8);
    s.color = mix(s.color, lin(vec3f(0.45, 0.3, 0.18)), fr);
  } else if (s.mat == ${MAT.HORSE}u) {
    // a painted carousel horse
    let y = s.uv.x - 2.0;
    let z = s.uv.y - 2.0;
    let w = max(max(fwu.x, fwu.y), 0.003);
    let flank = s.aux > 0.5;
    let gold = lin(vec3f(0.85, 0.65, 0.22));
    let dark = lin(vec3f(0.08, 0.06, 0.05));
    var c = s.color;
    var shine = 0.35;
    if (s.tag == 3u) {
      let bridle = (1.0 - smoothstep(0.012, 0.012 + w, abs(y - 0.8))) + (1.0 - smoothstep(0.012, 0.012 + w, abs(y - 0.99)));
      c = mix(c, lin(vec3f(0.45, 0.08, 0.06)), saturate(bridle));
      c = mix(c, gold, ellipse(vec2f(y - 0.8, z - 0.5), vec2f(0.018, 0.018), w));
      if (flank) {
        let eye = ellipse(vec2f(y - 0.9, z - 0.6), vec2f(0.03, 0.022), w);
        c = mix(c, dark, eye);
        c = mix(c, vec3f(0.9), ellipse(vec2f(y - 0.91, z - 0.607), vec2f(0.007, 0.007), w) * eye);
        c = mix(c, dark, ellipse(vec2f(y - 1.03, z - 0.47), vec2f(0.012, 0.016), w));
      }
    } else if (s.tag == 2u) {
      // the mane, along the upper edge of the neck
      let d = dot(vec2f(y - 0.45, z - 0.05), vec2f(-0.86, 0.51));
      let mane = smoothstep(0.07, 0.08 + w, d + 0.012 * sin(z * 60.0));
      c = mix(c, mix(dark, gold, step(0.5, fract(z * 7.0)) * 0.6), mane);
    } else if (s.tag == 1u) {
      // the saddle cloth, trimmed in gold, a stirrup hanging from it
      let cloth = step(abs(y), 0.32) * step(0.0, z);
      let trim = (1.0 - smoothstep(0.015, 0.015 + w, abs(abs(y) - 0.31))) * step(0.0, z) + (1.0 - smoothstep(0.015, 0.015 + w, abs(z))) * step(abs(y), 0.32);
      if (flank) {
        c = mix(c, lin(vec3f(0.62, 0.1, 0.1)), cloth);
        let stirrup = (1.0 - smoothstep(0.01, 0.01 + w, abs(length(vec2f(y, (z + 0.15) * 1.4)) - 0.045))) * step(z, -0.08);
        c = mix(c, gold, max(saturate(trim), stirrup));
        shine = mix(shine, 0.8, max(saturate(trim), stirrup));
      } else {
        c = mix(c, gold, saturate((1.0 - smoothstep(0.015, 0.015 + w, abs(abs(y) - 0.29))) * step(abs(y), 0.3)));
      }
    } else if (s.tag == 4u) {
      let hoof = smoothstep(-0.6, -0.62 - w, z);
      c = mix(c, gold, hoof);
      shine = mix(shine, 0.8, hoof);
    }
    s.color = c;
    s.gloss = shine;
  } else if (s.mat == ${MAT.WHEEL}u) {
    let r = length(s.uv - vec2f(1.0));
    let tyre = smoothstep(0.301, 0.306, r);
    s.color = mix(lin(vec3f(0.66, 0.67, 0.7)), lin(vec3f(0.04, 0.04, 0.045)), tyre);
    s.color = mix(s.color, lin(vec3f(0.3, 0.31, 0.33)), 1.0 - smoothstep(0.026, 0.031, r));
    s.gloss = mix(0.75, 0.12, tyre);
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

// A smooth tube with shared vertices (few of them, for things that move):
// n sides through points with radii (a number or one per point), no end caps,
// or closed by a point `tip`.  sx, sy squash the cross-section (sx across, in
// the horizontal; sy the other way).
function limb(pts, radii, n = 4, { sx = 1, sy = 1, tip = null, phase = Math.PI / 4 } = {}) {
  const g = new Geo();
  const rs = Array.isArray(radii) ? radii : pts.map(() => radii);
  const rings = [];
  for (let k = 0; k < pts.length; k++) {
    const d = pts.length > 1 ? v3.norm(v3.sub(pts[Math.min(k + 1, pts.length - 1)], pts[Math.max(k - 1, 0)])) : v3.norm(v3.sub(tip || [0, 0, 1], pts[0]));
    let e1 = v3.cross(d, [0, 0, 1]);
    e1 = v3.len(e1) < 1e-3 ? [1, 0, 0] : v3.norm(e1);
    const e2 = v3.cross(e1, d);
    rings.push(g.vertexCount);
    for (let i = 0; i < n; i++) {
      const a = phase + 2 * Math.PI * i / n, c = Math.cos(a), s = Math.sin(a);
      const nn = v3.norm(v3.add(v3.scale(e1, c / sx), v3.scale(e2, s / sy)));
      const p = v3.add(pts[k], v3.add(v3.scale(e1, c * sx * rs[k]), v3.scale(e2, s * sy * rs[k])));
      g.vert(p[0], p[1], p[2], nn[0], nn[1], nn[2], i / n, k);
    }
  }
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; g.quadIdx(rings[k] + i, rings[k] + j, rings[k + 1] + j, rings[k + 1] + i); }
  }
  if (tip) {
    const d = v3.norm(v3.sub(tip, pts[pts.length - 1])), last = rings[rings.length - 1];
    const t = g.vert(tip[0], tip[1], tip[2], d[0], d[1], d[2], 0.5, pts.length);
    for (let i = 0; i < n; i++) g.tri(last + i, last + (i + 1) % n, t);
  }
  return g.orientByNormals();
}

// A box with 8 shared corners (smooth, rounded-looking): for small parts of moving things.
function sbox(sx, sy, sz, x = 0, y = 0, z = 0) {
  const g = new Geo();
  for (let k = 0; k < 8; k++) {
    const a = k & 1 ? 1 : -1, b = k & 2 ? 1 : -1, c = k & 4 ? 1 : -1;
    const n = v3.norm([a, b, c]);
    g.vert(x + a * sx / 2, y + b * sy / 2, z + c * sz / 2, n[0], n[1], n[2], (a + 1) / 2, (c + 1) / 2);
  }
  for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) g.quadIdx(a, b, c, d);
  return g.orientByNormals();
}

// A sphere with single vertices at its poles (the seam is kept, for uv).
function lowSphere(r, seg, rings) {
  const g = new Geo();
  const top = g.vert(0, 0, r, 0, 0, 1, 0.5, 0);
  const row = [];
  for (let j = 1; j < rings; j++) {
    const th = Math.PI * j / rings;
    row.push(g.vertexCount);
    for (let i = 0; i <= seg; i++) {
      const ph = 2 * Math.PI * i / seg;
      const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
      g.vert(n[0] * r, n[1] * r, n[2] * r, n[0], n[1], n[2], i / seg, j / rings);
    }
  }
  const bot = g.vert(0, 0, -r, 0, 0, -1, 0.5, 1);
  for (let i = 0; i < seg; i++) {
    g.tri(top, row[0] + i, row[0] + i + 1);
    g.tri(bot, row[row.length - 1] + i + 1, row[row.length - 1] + i);
    for (let j = 0; j + 1 < row.length; j++) g.quadIdx(row[j] + i, row[j + 1] + i, row[j + 1] + i + 1, row[j] + i + 1);
  }
  return g.orientByNormals();
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
    // (the back gable gets its round window too: left with the triangle's own
    // uv, the shader would make most of it one dark pane)
    gable.add(uvFrom(Geo.triangle([w, d, H], [0, d, H], [w / 2, d, zR]), oculus(rh)));
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
//   leave   the id of a house to leave out: everything about it is drawn
//           from the random numbers as before, so that the rest of the town
//           stays as it was, but it is not added (onHouse is told `gone`)
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
      const bays = Math.max(2, Math.round(w / rand.range(2.4, 2.9)));
      const { g: house, H, boxes } = makeHouse({
        w, d: o.depth ?? DEPTH, floors, g0, sh, roof, hid,
        bays,
        pitch: roof === 'side' ? rand.range(0.62, 0.8) : rand.range(0.85, 1.0),
        wall: col, roofCol: rand.pick(ROOF_COLORS),
        left: exL && i === 0, right: exR && i === widths.length - 1,
        back: o.back ?? true, sills: o.sills ?? true, dormers: rand() < 0.55,
        chimney: rand() < 0.7 ? rand.range(0.2, 0.8) : 0,
        awning: o.awnings && rand() < o.awnings ? rand.pick(AWNING_COLORS) : null,
      });
      const org = [o.start[0] + e[0] * x, o.start[1] + e[1] * x];
      const m = placeM(org, e, inward);
      const gone = o.leave === hid;
      if (!gone) {
        b.static(house.transform(m));
        addBoxes(boxes, m);
      }
      if (o.onHouse) o.onHouse({ m, w, H, g0, hid, rand, sh, floors, bays, roof, gone });
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

// The lamp's small parts, from near by: the glazing bars of the lantern, a
// ladder bar under it, a collar and a ring on the column.
function lampDetail() {
  const g = new Geo();
  const iron = '#1e2622';
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, c = Math.cos(a), s = Math.sin(a);
    g.add(limb([[0.125 * c, 0.125 * s, 4.25], [0.225 * c, 0.225 * s, 4.87]], 0.012, 3).color(iron));
  }
  g.add(limb([[-0.38, 0, 3.72], [0.38, 0, 3.72]], 0.022, 3).color(iron));
  for (const x of [-0.38, 0.38]) g.add(Geo.sphere(0.04, 4, 2).translate(x, 0, 3.72).color(iron));
  g.add(Geo.cylinder(0.12, 0.1, 8, { caps: false }).translate(0, 0, 1.05).color(iron));
  g.add(Geo.cylinder(0.11, 0.06, 8, { caps: false, r2: 0.08 }).translate(0, 0, 1.15).color(iron));
  g.add(Geo.cylinder(0.24, 0.06, 8, { caps: false }).translate(0, 0, 0.0).color(iron));
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
const LEGS = ['#2a2a30', '#3a3f4a', '#4a3b30', '#22262e'];
const HAIR = ['#2a1e14', '#5a3a20', '#b08850', '#1a1a1a', '#8a8a8a', '#7a3a20'];
// a second stream of random numbers, for the looks of the figures, and a
// third for where the walkers are in their stride
let STYLE = rng(29);
let GAIT = rng(3);

// A figure, feet at the origin, facing +y: a coat and legs turned on a lathe,
// a head and perhaps a hat (about 70 to 95 triangles, with few vertices, since
// most of them walk).  The `surface` hook (material PERSON) draws on it the
// face, the hair, buttons, a scarf, trousers and shoes; how is told by a style
// number in .aux, the same for the whole figure (bits: 1 scarf, 2 buttons,
// 4 glasses, 8 beard, 16 and 32 the trousers, 64 a long coat).  The small
// parts that only show from near by (arms and hands, shoes, nose, a bag, the
// end of the scarf, a ponytail) are in `.detail`, in the same frame, for the
// caller to add with `within` (a walker's arms, hands, shoes and a bag in its
// hand move with its stride, and are in `.gait` instead: see walkingLimbs).
//   sit     seated, on something about 0.45 m high
//   scale   overall size; build: [width, depth] factors
//   walk    the speed, in metres a second, of a figure that walks: then the
//           legs are not part of the column but real ones that stride, and the
//           arms swing (see walkingLimbs); `fit`, if given, is a span of
//           seconds that a whole number of strides must fill
//   kid     a child for certain (otherwise one now and then, at random)
function person(rand, { sit = false, scale = 1, build = null, walk = 0, fit = 0, kid = false } = {}) {
  // (the scene's random numbers are drawn as they always were, so that
  // everything else in the town stays as it was; the rest come from STYLE)
  const R = STYLE;
  const coat = rand.pick(COATS), legs = rand.pick(LEGS);
  const skin = rand.pick(SKIN), hairI = HAIR.indexOf(rand.pick(HAIR));
  const hat = rand() < 0.25, hatCol = hat ? rand.pick(['#2a2a2a', '#7a5a3a', '#a33', '#e8e0d0']) : null;
  const st = { scarf: R() < 0.4, buttons: R() < 0.6, glasses: R() < 0.18, beard: R() < 0.14, trousers: LEGS.indexOf(legs), long: R() < 0.35 };
  // a child now and then: smaller, with a larger head for its size
  const child = (!sit && R() < 0.09) || kid;
  if (child) { st.beard = false; st.long = false; scale *= 0.64; }
  const hs = child ? 1.2 : 1;
  const id = (st.scarf ? 1 : 0) | (st.buttons ? 2 : 0) | (st.glasses ? 4 : 0) | (st.beard ? 8 : 0) | (st.trousers << 4) | (st.long ? 64 : 0);
  const aux = (id - 64) / 127;
  const [bw, bd] = build || [R.range(0.86, 1.18), R.range(0.88, 1.12)];
  // (a walker's column stops at the hem of the coat, and its legs are its own)
  const prof = sit
    ? [[0.15, 0.45], [0.21, 0.6], [0.22, 0.95], [0.08, 1.13]]
    : walk ? [st.long ? [0.19, 0.55] : [0.125, 0.74], [0.2, 0.92], [0.21, 1.3], [0.07, 1.48]]
    : [[0.085, 0.0], [0.13, 0.8], [0.2, 0.92], [0.21, 1.3], [0.07, 1.48]];
  // (u round the body from +x, so the front is at u = 0.25; v the height in metres)
  const body = uvFrom(Geo.lathe(prof, 6), (p) => [0, p[2]]);
  for (let i = 0; i < body.vertexCount; i++) {
    const k = i % 7;
    body.uv[i * 2] = k / 6;
  }
  body.scale(0.9 * bw, 0.75 * bd, 1).color(coat).tag(1);
  const g = new Geo();
  g.add(body);
  const hz = sit ? 1.25 : 1.61;
  g.add(lowSphere(0.112 * hs, 6, 4).scale(1, 1, 1.12).translate(0, 0, hz + 0.13 * (hs - 1)).color(skin).tag(2 + 8 * hairI));
  if (hat && !child) g.add(uvFrom(Geo.cylinder(0.14, 0.09, 6, { r2: 0.11, caps: false }), (p) => [0, p[2]]).add(uvFrom(Geo.disc(0.11, 6), () => [0, 0.09]).translate(0, 0, 0.09)).translate(0, 0, hz + 0.07).color(hatCol).tag(3));
  if (sit) g.add(Geo.box(0.3 * bw, 0.45, 0.14).translate(0, 0.2, 0.5).color(legs));
  g.mat(MAT.PERSON).aux(aux);

  // ---- the detail: arms and hands, shoes, the nose, a bag, the end of a scarf, a ponytail
  const d = new Geo();
  const sx = 0.9 * bw;
  const shoe = R.pick(['#2a2420', '#1a1a1a', '#4a3020', '#e8e4dc', '#6a2a20']);
  const bagKind = sit ? 0 : R.pick([0, 0, 1, 1, 2]);
  const bagSide = R() < 0.5 ? -1 : 1;
  const tet = (pts, col) => {
    // a small closed tetrahedron (a hand, a nose)
    const t = new Geo();
    const c = v3.scale(v3.add(v3.add(pts[0], pts[1]), v3.add(pts[2], pts[3])), 0.25);
    const ids = pts.map((q) => { const n = v3.norm(v3.sub(q, c)); return t.vert(q[0], q[1], q[2], n[0], n[1], n[2]); });
    t.tri(ids[0], ids[1], ids[2]); t.tri(ids[0], ids[1], ids[3]); t.tri(ids[0], ids[2], ids[3]); t.tri(ids[1], ids[2], ids[3]);
    return t.orientByNormals().color(col);
  };
  // (a walker's arms, hands, shoes and a bag carried in the hand move with
  // its stride: they go to `arms`, `hands`, `shoes` and `inHand` instead)
  const arms = [], hands = [], shoes = [];
  let inHand = null;
  for (const s of [-1, 1]) {
    // an arm (its sleeve is also painted on the coat, for far off) and its hand
    const hx = s * (sit ? 0.17 : 0.23) * bw, hy = sit ? 0.28 : 0.012 * s, hz0 = sit ? 0.64 : 0.9;
    const arm = sit ? [[s * 0.2 * bw, 0, 1.0], [s * 0.23 * bw, 0.04, 0.78], [hx, 0.24, 0.68]] : [[s * 0.205 * bw, 0, 1.37], [hx, hy, hz0]];
    const armG = (walk ? limb(arm, [0.057, 0.046], 3) : limb(arm, sit ? [0.055, 0.05, 0.044] : [0.055, 0.044], 4)).color(mixHex(coat, '#000000', 0.1));
    const hand = sit
      ? [[hx - s * 0.03, hy - 0.06, hz0 + 0.03], [hx + s * 0.02, hy - 0.06, hz0 + 0.03], [hx, hy + 0.06, hz0], [hx, hy - 0.04, hz0 - 0.02]]
      : [[hx - s * 0.03, hy - 0.03, hz0 + 0.01], [hx + s * 0.03, hy - 0.025, hz0 + 0.01], [hx, hy + 0.035, hz0 + 0.01], [hx + s * 0.005, hy, hz0 - 0.12]];
    if (walk) { arms.push(armG); hands.push(tet(hand, skin)); } else { d.add(armG); d.add(tet(hand, skin)); }
    // a shoe, its toe peeping out from under the front
    const fx = s * 0.06 * bw;
    if (sit) d.add(limb([[fx, 0.42, 0.47], [fx, 0.46, 0.06]], 0.05, 3).color(legs));
    const fy = sit ? 0.46 : 0;
    const sh2 = new Geo();
    const v = (x, y, z) => { const n = v3.norm([x * 5, y * 3, z * 6 + 0.3]); return sh2.vert(fx + x, fy + y, z, n[0], n[1], n[2]); };
    const a = v(-0.048, -0.04, 0.085), b = v(0.048, -0.04, 0.085), c = v(-0.05, 0.15, 0.005), e = v(0.05, 0.15, 0.005), f = v(0, 0.165, 0.045);
    sh2.tri(a, c, f); sh2.tri(a, f, b); sh2.tri(b, f, e); sh2.tri(c, e, f);
    if (walk) shoes.push(sh2.orientByNormals().color(shoe).gloss(0.45)); else d.add(sh2.orientByNormals().color(shoe).gloss(0.45));
  }
  // the nose
  const fz = hz + 0.13 * (hs - 1) - 0.006 * hs, ny = 0.096 * hs;
  d.add(tet([[-0.013, ny - 0.004, fz - 0.012], [0.013, ny - 0.004, fz - 0.012], [0, ny - 0.006, fz + 0.024], [0, ny + 0.026, fz - 0.014]], skin));
  // a bag: in one hand, or on the back
  const bagCol = R.pick(['#5a3a24', '#2a2a2a', '#8a2f2f', '#c8b090', '#2f4a6a', '#6a6a3a']);
  if (bagKind === 1) {
    const bag = Geo.merge(sbox(0.08, 0.3, 0.24, bagSide * 0.25 * sx / 0.9, 0.0, 0.7).color(bagCol).gloss(0.3),
      Geo.quad([bagSide * 0.2 * sx / 0.9, -0.06, 0.82], [bagSide * 0.2 * sx / 0.9, 0.06, 0.82], [bagSide * 0.235 * sx / 0.9, 0.08, 0.92], [bagSide * 0.235 * sx / 0.9, -0.08, 0.92]).color(mixHex(bagCol, '#000000', 0.4)).doubleSided());
    if (walk) inHand = bag; else d.add(bag);
  } else if (bagKind === 2) {
    d.add(sbox(0.3 * bw, 0.15, 0.4, 0, -0.165 * bd - 0.03, 1.12).color(bagCol));
  }
  // the end of the scarf, hanging down the front
  if (st.scarf && !sit) d.add(Geo.quad([0.03, 0.155 * bd, 1.4], [0.1, 0.15 * bd, 1.4], [0.11, 0.163 * bd, 1.12], [0.05, 0.168 * bd, 1.12]).color(coat).mat(MAT.PERSON).tag(5).aux(aux).doubleSided());
  // a ponytail for some
  const hc = hz + 0.13 * (hs - 1);
  if ((!hat || child) && R() < 0.3) d.add(limb([[0, -0.1 * hs, hc + 0.02 * hs]], 0.035 * hs, 3, { tip: [0, -0.13 * hs, hc - 0.12 * hs] }).mat(MAT.PERSON).tag(4 + 8 * hairI).aux(aux));
  g.scale(scale);
  g.detail = d.scale(scale);
  if (walk) g.gait = walkingLimbs({ speed: walk, fit, scale, bw, legs, aux, arms, hands, shoes, inHand, bagSide, child });
  return g;
}

// The stride of a figure made by person() with `walk`, as movements that
// repeat (see moving()): the share u of a stride (two steps) done, with the
// right foot half a step ahead at u = 0 and the left at u = 0.5.  The feet go
// in straight lines, so the one that is down stays where it was put (the
// period is fitted to the speed for that) while the other goes forward to the
// next step, lifted as it passes the first, the knee bent forward.  The arms
// swing about the shoulders, against the legs; the arm that carries a bag,
// little.
//
// What is drawn between two poses is not quite the mesh with every vertex
// part of the way along: the slice through the tetrahedra that a triangle
// sweeps out between them is folded, by up to a quarter of how far its
// corners move relative to one another, towards where the corner listed first
// in the mesh is going.  Two poses of a straight leg whose foot goes 0.7 m
// while the hip stays put fold it by 17 cm at mid-stride (the two legs cross
// like an X).  So the legs have four poses and a knee, which brings that down
// to about 4 cm, and are listed from the foot up, so that the leg that swings
// bends forwards, as a knee does.  The arms have four poses too, listed from
// the shoulder down (the arm going forward bends at the elbow the right way).
// The legs are drawn by the shader as the column's were (trousers, shoes),
// with uv.y the height in the figure as it stands.  They are always drawn;
// the arms, hands and a bag carried in the hand from `ARMS_WITHIN` metres,
// and the shoes from `SHOES_WITHIN`.
// Returns { period, phase, parts: [{ geo: u => Geo, keys, within }] }.
const ARMS_WITHIN = 50, SHOES_WITHIN = 12;
function walkingLimbs({ speed, fit, scale, bw, legs, aux, arms, hands, shoes, inHand, bagSide, child }) {
  const H = 0.84 * scale, KNEE = 0.45 * scale;      // the hips and the knees
  let step = scale * (0.5 + 0.18 * speed) * (child ? 1.1 : 1);   // metres from one foot to the other
  let period = 2 * step / speed;
  if (fit) period = fit / Math.max(1, Math.round(fit / period));
  step = speed * period / 2;
  const lift = 0.08 * scale, bend = 0.23 * step, rise = 0.04 * scale;   // of the swinging foot and knee
  const swing = (0.15 + 0.08 * speed) * (child ? 1.2 : 1);   // of the arms, in radians either way
  const A = (u) => Math.cos(2 * Math.PI * u);                // 1: the right leg ahead; -1: the left
  const w = (s, u) => Math.max(0, -s * Math.sin(2 * Math.PI * u));   // 1 for the foot that is half way through its swing
  const leg = (s, u) => {
    const y = s * A(u) * step / 2, x = s * 0.06 * bw * scale;
    const wu = w(s, u);
    const g = tubeX([[x, y, lift * wu], [x, y * (H - KNEE) / H + bend * wu, KNEE + rise * wu], [x, 0, H]], [0.05 * scale, 0.058 * scale, 0.07 * scale], 3);
    for (let i = 0; i < g.vertexCount; i++) { g.uv[i * 2] = 0.5; g.uv[i * 2 + 1] = [0, 0.45, 0.84][Math.floor(i / 3)]; }
    return g.color(legs).mat(MAT.PERSON).tag(1).aux(aux);
  };
  const am = arms.map((a) => a.clone().scale(scale));
  const hd = hands.map((a) => a.clone().scale(scale));
  const sh = shoes.map((a) => a.clone().scale(scale));
  const bag = inHand && inHand.clone().scale(scale);
  const shoulder = 1.37 * scale;
  const turn = (s, u) => {
    const a = -s * A(u) * swing * (inHand && s === bagSide ? 0.25 : 1);
    return m4.mul(m4.translation(0, 0, shoulder), m4.rotationX(a), m4.translation(0, 0, -shoulder));
  };
  const armsAt = (u) => {
    const g = Geo.merge(am[0].clone().transform(turn(-1, u)), am[1].clone().transform(turn(1, u)),
      hd[0].clone().transform(turn(-1, u)), hd[1].clone().transform(turn(1, u)));
    if (bag) g.add(bag.clone().transform(turn(bagSide, u)));
    return g;
  };
  const shoesAt = (u) => Geo.merge(...[-1, 1].map((s, i) => sh[i].clone().translate(0, s * A(u) * step / 2, lift * w(s, u))));
  return {
    period, phase: GAIT(),
    parts: [{ geo: (u) => Geo.merge(leg(-1, u), leg(1, u)), keys: 4 }, { geo: armsAt, keys: 4, within: ARMS_WITHIN }, { geo: shoesAt, keys: 4, within: SHOES_WITHIN }],
  };
}

// Moves a figure made by person() and its detail together.
function placePerson(p, m) {
  p.transform(m);
  p.detail.transform(m);
  return p;
}

// A cyclist, wheels on the ground, riding along +y.  The wheels are flat
// octagons that the `cutout` hook turns into tyre, rim, spokes and hub
// (material WHEEL: uv is the position in metres from the hub, plus 1; aux
// sets where the spokes start), turning as they roll.  Built from tubes with
// shared vertices to stay light, since there are thirty of them about.
function cyclist(rand, speed = 4.6) {
  const R = STYLE;
  // (the scene's random numbers drawn as they always were)
  const frame = rand.pick(['#b8342c', '#2b4f7c', '#2f6a4a', '#e0b030', '#222222', '#d8d8d8', '#6b2f5a']);
  const shirt = rand.pick(COATS), trousers = rand.pick(['#2a2a30', '#3a3f4a', '#22262e']);
  const helmeted = rand() < 0.5;
  const helmetI = helmeted ? ['#e03a2a', '#f0f0f0', '#2a6ad0', '#f0c020'].indexOf(rand.pick(['#e03a2a', '#f0f0f0', '#2a6ad0', '#f0c020'])) : HAIR.indexOf(rand.pick(['#2a1e14', '#5a3a20', '#b08850']));
  const skin = rand.pick(SKIN);
  const g = bicycle(frame, false, false);
  const id = (R() < 0.3 ? 4 : 0) | (R() < 0.12 ? 8 : 0) | 2;
  addRider(g, { shirt, trousers, skin, helmeted, helmetI, id, legs: false });
  // the legs and the cranks go round, a turn of the pedals to every 2.2 of
  // the wheels (as the shader turns those), in six poses
  g.gait = { period: 2.2 * 2 * Math.PI * WHEEL_R / speed, phase: GAIT(), parts: [{ geo: (u) => pedalling(trousers, u), keys: PEDAL_KEYS }] };
  // from near by: mudguards, chainring, a bell, the rider's nose, a basket for some
  const d = new Geo();
  const guard = mixHex(frame, '#000000', 0.25);
  for (const y of [-0.52, 0.52]) {
    const arc = [];
    for (let i = 0; i <= 3; i++) { const a = (y > 0 ? 0.35 : 0.5) + i * 0.75; arc.push([0, y + 0.375 * Math.cos(a) * (y > 0 ? 1 : -1), WHEEL_R + 0.375 * Math.sin(a)]); }
    d.add(limb(arc, 0.02, 3, { sx: 1.8, sy: 0.4 }).color(guard).gloss(0.5));
  }
  const ring = new Geo();
  for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; ring.vert(0.06, -0.05 + 0.1 * Math.cos(a), 0.3 + 0.1 * Math.sin(a), 1, 0, 0); }
  for (let i = 1; i < 7; i++) ring.tri(0, i, i + 1);
  d.add(ring.orientByNormals().color('#55585c').gloss(0.6).doubleSided());
  d.add(limb([[-0.17, 0.31, 1.02]], 0.022, 4, { tip: [-0.17, 0.31, 1.06] }).color('#c8ccd0').gloss(0.8));
  d.add(limb([[0, 0.262, 1.655]], 0.012, 3, { tip: [0, 0.29, 1.645] }).color(skin));
  if (R() < 0.3) d.add(sbox(0.32, 0.26, 0.2, 0, 0.52, 0.93).color('#8a6a3a'));
  g.detail = d;
  return g;
}

// A tube along a polyline in the plane x = const (more or less), its rings
// laid out from the x axis, so that the same vertex stays on the same side
// however the line bends from pose to pose (limb() lays them out from the
// vertical, which a leg swinging past the upright would turn round).
function tubeX(pts, radii, n, tip) {
  const g = new Geo();
  const rings = [];
  for (let k = 0; k < pts.length; k++) {
    const d = v3.norm(v3.sub(pts[Math.min(k + 1, pts.length - 1)], pts[Math.max(k - 1, 0)]));
    const e2 = v3.norm(v3.cross([1, 0, 0], d)), e1 = v3.cross(d, e2);
    rings.push(g.vertexCount);
    for (let i = 0; i < n; i++) {
      const a = 2 * Math.PI * i / n, c = Math.cos(a), s = Math.sin(a);
      const nn = v3.add(v3.scale(e1, c), v3.scale(e2, s));
      g.vert(pts[k][0] + nn[0] * radii[k], pts[k][1] + nn[1] * radii[k], pts[k][2] + nn[2] * radii[k], nn[0], nn[1], nn[2], i / n, k);
    }
  }
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; g.quadIdx(rings[k] + i, rings[k] + j, rings[k + 1] + j, rings[k + 1] + i); }
  }
  if (tip) {
    const d = v3.norm(v3.sub(tip, pts[pts.length - 1])), last = rings[rings.length - 1];
    const t = g.vert(tip[0], tip[1], tip[2], d[0], d[1], d[2], 0.5, pts.length);
    for (let i = 0; i < n; i++) g.tri(last + i, last + (i + 1) % n, t);
  }
  return g.orientByNormals();
}

// A cyclist's legs and the cranks, the pedals a share u of a turn on from
// where they are at u = 0 (going round forwards: the upper pedal moves
// ahead): the cranks turned about the bottom bracket, the feet on the pedals,
// and each knee where a thigh and a shin of their lengths put it, forwards.
const PEDAL_KEYS = 6;
const CRANK = { y: -0.05, z: 0.3, r: 0.18, a0: 2.55 };
function pedalling(trousers, u) {
  const g = new Geo();
  const turn = -2 * Math.PI * u;
  const at = (a) => [CRANK.y + CRANK.r * Math.cos(a), CRANK.z + CRANK.r * Math.sin(a)];
  // the cranks, one piece through the bracket, turned as a whole
  const c0 = at(CRANK.a0), c1 = at(CRANK.a0 + Math.PI);
  const crank = limb([[0.15, c0[0], c0[1]], [0, CRANK.y, CRANK.z], [-0.15, c1[0], c1[1]]], 0.014, 3).color('#3a3a3a');
  g.add(crank.transform(m4.mul(m4.translation(0, CRANK.y, CRANK.z), m4.rotationX(turn), m4.translation(0, -CRANK.y, -CRANK.z))));
  const L1 = 0.45, L2 = 0.44;
  for (const s of [1, -1]) {
    const p = at(CRANK.a0 + (s > 0 ? 0 : Math.PI) + turn);
    const hip = [-0.15, 0.98], ankle = [p[0] - 0.04, p[1] + 0.05];
    const dy = ankle[0] - hip[0], dz = ankle[1] - hip[1], dl = Math.hypot(dy, dz);
    const cosA = Math.min(1, (L1 * L1 + dl * dl - L2 * L2) / (2 * L1 * dl)), sinA = Math.sqrt(1 - cosA * cosA);
    const uy = dy / dl, uz = dz / dl;
    const knee = [hip[0] + L1 * (uy * cosA - uz * sinA), hip[1] + L1 * (uy * sinA + uz * cosA)];
    g.add(tubeX([[s * 0.09, hip[0], hip[1]], [s * 0.11, knee[0], knee[1]], [s * 0.1, ankle[0], ankle[1]]], [0.075, 0.056, 0.045], 3,
      [s * 0.1, p[0] + 0.1, p[1] - 0.01]).color(trousers));
  }
  return g;
}

// A bicycle, wheels on the ground, pointing along +y; `parked`: its lamps off
// and its wheels still.
function bicycle(frame, parked = false, cranks = true) {
  const R = STYLE;
  const g = new Geo();
  const black = '#1c1c1c';
  // wheels
  const rr = WHEEL_R / Math.cos(Math.PI / 8) + 0.004;
  for (const y of [-0.52, 0.52]) {
    const w = new Geo();
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) * Math.PI / 4;
      w.vert(0, y + rr * Math.cos(a), WHEEL_R + rr * Math.sin(a), 1, 0, 0, 1 + rr * Math.cos(a), 1 + rr * Math.sin(a));
    }
    for (let i = 1; i < 7; i++) w.tri(0, i, i + 1);
    g.add(w.orientByNormals().color('#1c1c1c').mat(MAT.WHEEL).aux(R.range(-1, 1)).tag(parked ? 1 : 0).cutout().doubleSided());
  }
  // frame
  const RH = [0, -0.52, WHEEL_R], FH = [0, 0.52, WHEEL_R], BB = [0, -0.05, 0.3], ST = [0, -0.17, 0.8], SAD = [0, -0.2, 0.9];
  const HB = [0, 0.39, 0.68], HT = [0, 0.36, 0.84], STEM = [0, 0.33, 1.0];
  g.add(limb([RH, BB, HB, HT, STEM], 0.02, 3).color(frame));
  g.add(limb([RH, ST, HT], 0.016, 3).color(frame));
  g.add(limb([BB, SAD], 0.017, 3).color(frame));
  g.add(limb([HB, FH], 0.016, 3).color(frame));
  g.add(limb([[-0.25, 0.31, 1.0], [0.25, 0.31, 1.0]], 0.014, 3).color(black));
  // the cranks, one pedal up at the back and one down at the front, through the bottom bracket
  if (cranks) g.add(limb([[0.15, -0.2, 0.4], [0.05, -0.05, 0.3], [-0.15, 0.08, 0.22]], 0.014, 3).color('#3a3a3a'));
  // the saddle: a wedge, broad at the back
  const sd = new Geo();
  const sv = [[-0.08, -0.31, 0.93], [0.08, -0.31, 0.93], [0, -0.06, 0.935], [0, -0.25, 0.97]].map((q) => { const n = v3.norm(v3.sub(q, [0, -0.22, 0.9])); return sd.vert(q[0], q[1], q[2], n[0], n[1], n[2]); });
  sd.tri(sv[0], sv[1], sv[2]); sd.tri(sv[0], sv[1], sv[3]); sd.tri(sv[1], sv[2], sv[3]); sd.tri(sv[2], sv[0], sv[3]);
  g.add(sd.orientByNormals().color('#2a2420').gloss(0.4));
  // lamps: white at the front, red at the back (each a small pyramid, lit on its face)
  const lamp = (c, dir, col, e) => {
    const L = new Geo();
    const q = [[-0.03, 0, -0.02], [0.03, 0, -0.02], [0, 0, 0.025]].map((o) => L.vert(c[0] + o[0], c[1], c[2] + o[2], 0, dir, 0));
    const t = L.vert(c[0], c[1] - dir * 0.05, c[2], 0, -dir, 0);
    L.tri(q[0], q[1], q[2]); L.tri(q[0], q[1], t); L.tri(q[1], q[2], t); L.tri(q[2], q[0], t);
    L.orientByNormals().color(col);
    for (const k of q) L.a[k * 4] = e;
    return L;
  };
  g.add(lamp([0, 0.41, 0.93], 1, parked ? '#d8d4c8' : '#fff4d8', parked ? 0 : 3.5));
  g.add(lamp([0, -0.34, 0.84], -1, parked ? '#a02018' : '#ff2a18', parked ? 0 : 3.5));
  return g;
}

function addRider(g, { shirt, trousers, skin, helmeted, helmetI, id, legs = true }) {
  // the rider
  const hip = [0, -0.17, 1.0], sh = [0, 0.08, 1.46], neck = [0, 0.13, 1.53];
  g.add(limb([hip, sh], [0.14, 0.16], 4, { sx: 1.25, sy: 0.75, tip: neck }).color(shirt));
  for (const s of [-1, 1]) {
    g.add(limb([[s * 0.17, 0.08, 1.42], [s * 0.23, 0.27, 1.04]], [0.05, 0.04], 3).color(shirt));
    g.add(limb([[s * 0.23, 0.27, 1.04]], 0.032, 3, { tip: [s * 0.245, 0.32, 1.0] }).color(skin));
    if (!legs) continue;
    const up = s > 0;
    const knee = up ? [s * 0.11, 0.13, 0.8] : [s * 0.11, 0.17, 0.62], foot = up ? [s * 0.1, -0.2, 0.42] : [s * 0.1, 0.07, 0.23];
    g.add(limb([[s * 0.09, -0.15, 0.98], knee, foot], [0.075, 0.056, 0.045], 3, { tip: [foot[0], foot[1] + 0.13, foot[2] - 0.04] }).color(trousers));
  }
  g.add(lowSphere(0.11, 6, 4).scale(1, 1, 1.1).translate(0, 0.17, 1.66).color(skin).mat(MAT.PERSON).tag((helmeted ? 6 : 2) + 8 * helmetI).aux((id - 64) / 127));
  return g;
}

// One section of a tram, centred on the origin, running along +y.  Windows,
// doors, lamps and lettering are the shader's (see tramBody); j is which tram.
function tramSection(kind, j = 0) {
  const L = TRAM_SEG, g = new Geo();
  const k = ['rear', 'mid', 'front'].indexOf(kind);
  const body = Geo.box(2.4, L, 2.5).translate(0, 0, 0.42 + 1.25);
  uvFrom(body, (p, n) => (Math.abs(n[1]) > 0.5 ? [p[0] + 1.2, p[2] + 4] : Math.abs(n[2]) > 0.5 ? [0, 3.5] : [(p[1] + L / 2) / 1.4 + 0.5, p[2]]));
  body.color('#ece2c6').mat(MAT.TRAM).aux((3 * j + k + 1) / 127);
  for (let i = 0; i < body.vertexCount; i++) {
    const nx = body.n[i * 3], ny = body.n[i * 3 + 1], nz = body.n[i * 3 + 2];
    body.x[i * 2 + 1] = ny > 0.5 ? (kind === 'front' ? 1 : 3) : ny < -0.5 ? (kind === 'rear' ? 2 : 3) : nz > 0.5 ? 5 : nx < -0.5 ? 4 : 0;
  }
  g.add(body);
  g.add(Geo.box(2.1, L - 0.5, 0.22).translate(0, 0, 3.03).color('#8f9499').gloss(0.5));
  const under = Geo.box(2.0, L - 1.2, 0.42).translate(0, 0, 0.21);
  g.add(uvFrom(under, (p) => [p[1] + 3.2, p[2]]).color('#26292d').mat(MAT.TRAM).tag(6));
  if (kind === 'mid') {
    // a pantograph on its frame on the roof
    const D = '#333333';
    g.add(sbox(0.9, 0.7, 0.12, 0, -0.5, 3.2).color('#55585c'));
    g.add(limb([[0, -0.8, 3.2], [0, 0.4, 3.75], [0, -0.3, 4.15]], 0.03, 3).color(D));
    g.add(limb([[-0.75, -0.3, 4.1], [-0.6, -0.3, 4.18], [0.6, -0.3, 4.18], [0.75, -0.3, 4.1]], 0.025, 3).color('#444444'));
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

// A carousel horse on its pole, saddle at the origin, facing +y.  The
// shader paints on it (material HORSE: uv = its own y and z, plus 2; tag
// the part, 1 body, 2 neck, 3 head, 4 legs; aux 1 on the flanks) the eyes,
// bridle, mane, saddle cloth, stirrups and hooves.
function horse(color) {
  const g = new Geo();
  g.add(Geo.box(0.36, 1.15, 0.42).translate(0, 0, -0.05).colorBy((p, n) => (n[2] > 0.5 && Math.abs(p[1]) < 0.3 ? '#b8342c' : color)).tag(1));
  g.add(beam([0, 0.45, 0.05], [0, 0.78, 0.6], 0.24, 0.3).color(color).tag(2));
  g.add(beam([0, 0.7, 0.62], [0, 1.05, 0.45], 0.2, 0.24).color(color).tag(3));
  g.add(beam([0, 0.45, -0.2], [0, 0.85, -0.7], 0.3, 0.1).color(color).tag(4));
  g.add(beam([0, -0.45, -0.2], [0, -0.75, -0.75], 0.3, 0.1).color(color).tag(4));
  uvFrom(g, (p) => [p[1] + 2, p[2] + 2]).aux((p, n) => (Math.abs(n[0]) > 0.7 ? 1 : 0)).mat(MAT.HORSE);
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

function clockFaceAt(b, m, R, seg = 48) {
  const face = Geo.disc(R, seg).rotateX(Math.PI / 2);
  uvFrom(face, (p) => [0.5 + p[0] / (2 * R), 0.5 + p[2] / (2 * R)]);
  const bez = new Geo();
  const t = 0.12 * Math.min(1, R / 1.2);
  bez.add(annulus(R, R + 0.35 * R / 3.25, seg).rotateX(Math.PI / 2).translate(0, -t, 0));
  bez.add(Geo.cylinder(R + 0.35 * R / 3.25, t, seg, { caps: false }).rotateX(Math.PI / 2));
  b.static(face.mat(MAT.CLOCK).transform(m4.mul(m, m4.translation(0, -t * 0.4, 0))));
  b.static(bez.color('#d9a842').gloss(0.8).transform(m));
}

// Street clocks, low down, that keep the same time as the tower's: level,
// they all agree; in a view tilted up, what is higher is seen later, and the
// tower's clock, 30 m above them, runs ahead (by a quarter of an hour at 45°,
// by nearly an hour at 75°, as a day here lasts five minutes).
//   a cast-iron pillar clock with four faces at the square's end of the avenue
function pillarClock(b, x, y) {
  const iron = '#1e2622';
  const g = new Geo();
  g.add(Geo.lathe([[0.34, 0], [0.34, 0.2], [0.24, 0.32], [0.2, 0.62], [0.13, 0.78], [0.1, 0.8]], 10, { smooth: false }));
  g.add(Geo.cylinder(0.1, 2.45, 10, { r2: 0.085, caps: false }).translate(0, 0, 0.8));
  g.add(Geo.cylinder(0.16, 0.14, 10).translate(0, 0, 1.5));
  g.add(Geo.lathe([[0.085, 3.2], [0.26, 3.3], [0.26, 3.36]], 10, { smooth: false }));
  g.add(Geo.box(0.9, 0.9, 0.98).translate(0, 0, 3.36 + 0.49));
  g.add(Geo.box(1.02, 1.02, 0.1).translate(0, 0, 4.39));
  g.add(Geo.cone(0.62, 0.42, 4).rotateZ(Math.PI / 4).translate(0, 0, 4.44));
  g.add(Geo.sphere(0.07, 6, 4).translate(0, 0, 4.92));
  b.static(g.color(iron).gloss(0.35).translate(x, y, 0));
  b.static(Geo.sphere(0.06, 6, 4).translate(x, y, 4.99).color('#d9a842').gloss(0.8), { within: 40, solid: false });
  for (let k = 0; k < 4; k++) clockFaceAt(b, m4.mul(m4.translation(x, y, 3.85), m4.rotationZ(k * Math.PI / 2), m4.translation(0, -0.455, 0)), 0.36, 24);
}

//   a clock on an iron bracket over the pavement, its two faces along the street
function bracketClock(b, x, y, z, out) {
  const iron = '#1e2622';
  const tip = y - out * 1.25;
  addBoxes([[beamM([x, y, z + 0.55], [x, tip, z + 0.55], 0.06), iron], [beamM([x, y, z - 0.2], [x, tip + out * 0.55, z + 0.5], 0.04), iron],
    [boxM(0.05, 0.05, 0.12, x, tip + out * 0.25, z + 0.5), iron]]);
  const c = [x, tip + out * 0.25, z];
  b.static(Geo.cylinder(0.43, 0.2, 20).rotateY(Math.PI / 2).translate(c[0] - 0.1, c[1], c[2]).color(iron).gloss(0.35));
  for (const s of [-1, 1]) clockFaceAt(b, m4.mul(m4.translation(c[0] + s * 0.1, c[1], c[2]), m4.rotationZ(s * Math.PI / 2)), 0.36, 24);
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

// The stair up the inside of the city wall (see WALK and STAIR): fifty steps
// of 18 cm in a solid block of masonry, whose stepped edge shows from the
// yard through an iron railing along its open side; a parapet across the end
// of its landing; and a timber railing along the inner edge of the wall's
// top, open where the stair comes up.  All of it solid, so that nobody walks
// off by mistake (the rails are within a walker's height); and a tree in the
// yard.
function wallStair(b) {
  const { y0, y1, y2 } = STAIR, n = 50, r = WALK.z / n, L = (y1 - y0) / n;
  // the block: its profile in (y, z), extruded across x
  const steps = [[y0, 0]];
  for (let k = 0; k < n; k++) steps.push([y0 + k * L, (k + 1) * r], [y0 + (k + 1) * L, (k + 1) * r]);
  steps.push([y2, WALK.z], [y2, 0]);
  const g = Geo.extrude(steps, STAIR.x1 - STAIR.x0).transform(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [STAIR.x0, 0, 0]));
  g.add(Geo.box(STAIR.x1 - STAIR.x0, 0.35, 1).translate((STAIR.x0 + STAIR.x1) / 2, y2 - 0.175, WALK.z + 0.5));
  b.static(metricUV(g).color('#b5a98c').mat(MAT.STONE));
  // the iron railing: a post on every fifth step, a handrail and a rail half
  // way down; and the railing on the wall: posts every 2 m, the same two
  // rails.  (One mesh with the stair, not copies of the plain boxes: a group
  // of those of its own would be a draw call more in the shadow maps.)
  const rails = new Geo();
  const bar = (m, c) => rails.add(Geo.box(1, 1, 1).transform(m).color(c));
  const iron = '#262a2c', xr = STAIR.x1 - 0.06;
  for (let k = 2; k < n; k += 5) bar(boxM(0.05, 0.05, 1, xr, y0 + (k + 0.5) * L, (k + 1) * r + 0.5), iron);
  for (const y of [y1 + 1, y2 - 0.4]) bar(boxM(0.05, 0.05, 1, xr, y, WALK.z + 0.5), iron);
  for (const h of [0.5, 1]) {
    bar(beamM([xr, y0 + 1.5 * L, 2 * r + h], [xr, y1, WALK.z + h], 0.045), iron);
    bar(beamM([xr, y1, WALK.z + h], [xr, y2 - 0.35, WALK.z + h], 0.045), iron);
  }
  const wood = '#5a4030', x = WALK.x1 - 0.1, top = WALK.z + 1;
  for (const [a, c] of [[WALK.y0 + 0.2, y1 - 2], [y2, WALK.y1 - 4.5]]) {
    const k = Math.round((c - a) / 2);
    for (let i = 0; i <= k; i++) bar(boxM(0.1, 0.1, 1, x, a + (c - a) * i / k, WALK.z + 0.5), wood);
    bar(boxM(0.08, c - a, 0.07, x, (a + c) / 2, top - 0.035), wood);
    bar(boxM(0.05, c - a, 0.05, x, (a + c) / 2, WALK.z + 0.5), wood);
  }
  b.static(rails.gloss(0.3));
  b.static(tree(rng(1210), 7).translate(-218.5, 23, 0));
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
      const sh = person(rand);
      placePerson(sh, m4.mul(m4.translation(rand.range(-1, 1), 0.4, 0), m4.rotationZ(Math.PI)));
      g.add(sh);
      const m = m4.mul(m4.translation(xc, yc, 0), m4.rotationZ(facing > 0 ? Math.PI : 0));
      b.static(g.transform(m));
      b.static(sh.detail.transform(m), { within: 16, solid: false });
      addBoxes(bx, m);
      // a customer or two
      for (let c = 0; c < 2; c++) {
        if (rand() < 0.35) continue;
        const p = person(rand);
        placePerson(p, m4.mul(m4.translation(xc + rand.range(-1.6, 1.6), yc + facing * (Dp / 2 + 1.0 + rand.range(0, 0.6)), 0), m4.rotationZ(facing > 0 ? Math.PI : 0)));
        b.static(p);
        b.static(p.detail, { within: 16, solid: false });
      }
      k++;
    }
  }
}

// What the market stalls sell, piled up on their crates, with a price card
// on each: fruit, vegetables, bread, cheese, flowers.  Drawn from near by only.
function marketGoods(b) {
  const r = rng(5150);
  const kinds = ['fruit', 'veg', 'bread', 'cheese', 'flowers', 'fruit'];
  let k = 0;
  for (const [yc, facing] of [[-13, -1], [-21, 1]]) {
    for (const xc of [-24, -18, -12]) {
      const kind = kinds[k++];
      const g = new Geo();
      const Dp = 2.4, y0 = -Dp / 2 + 0.45, z0 = 1.07;
      for (let i = 0; i < 6; i++) {
        const cx = -1.75 + i * 0.7;
        const pile = (n, mx, my, make) => {
          for (let a = 0; a < n; a++) {
            const u = (a % mx) / Math.max(1, mx - 1) - 0.5, v = (Math.floor(a / mx) % my) / Math.max(1, my - 1) - 0.5, layer = Math.floor(a / (mx * my));
            g.add(make().translate(cx + u * 0.4 * (1 - layer * 0.4) + r.range(-0.015, 0.015), y0 + v * 0.24 * (1 - layer * 0.4) + r.range(-0.015, 0.015), z0 + layer * 0.05));
          }
        };
        if (kind === 'fruit' || kind === 'veg') {
          const fruit = kind === 'fruit'
            ? r.pick([['#c8281e', 0.04], ['#f08a1a', 0.042], ['#f2d23a', 0.036], ['#8ab83a', 0.04], ['#6a2a6a', 0.025], ['#d8b040', 0.038]])
            : r.pick([['#4a8a3a', 0.08], ['#d8401f', 0.04], ['#e86a1a', 0.03], ['#e8e0c0', 0.05], ['#7a3a6a', 0.06], ['#9ab83a', 0.06]]);
          const [col, rad] = fruit;
          const mx = Math.max(2, Math.floor(0.46 / (2 * rad))), my = Math.max(2, Math.floor(0.28 / (2 * rad)));
          pile(mx * my + (mx - 1) * (my - 1), mx, my, () => Geo.sphere(rad, 5, 3).scale(1, 1, 0.9).translate(0, 0, rad * 0.9).color(mixHex(col, '#000000', r.range(0, 0.18))).gloss(0.45));
        } else if (kind === 'bread') {
          const col = r.pick(['#b87a3a', '#8a5226', '#d8a860']);
          pile(6, 3, 2, () => Geo.sphere(0.06, 6, 3).scale(1.6, 0.9, 0.7).rotateZ(r.range(-0.3, 0.3)).translate(0, 0, 0.04).color(col));
        } else if (kind === 'cheese') {
          const col = r.pick(['#f0c850', '#e8d890', '#d89a30']);
          pile(4, 2, 2, () => Geo.cylinder(0.1, 0.07, 8).color(col));
        } else {
          // buckets of flowers
          g.add(Geo.cylinder(0.14, 0.22, 8, { r2: 0.16 }).translate(cx, y0, 0.99).color('#6a7a8a').gloss(0.5));
          const col = r.pick(['#e23a3a', '#f06aa0', '#f2c12e', '#f4f1e8', '#b04ad0', '#f08a1a']);
          for (let a = 0; a < 7; a++) {
            const ang = a * 2.4, rr = a ? 0.09 : 0;
            const top = [cx + rr * Math.cos(ang), y0 + rr * Math.sin(ang), 1.42 + r.range(-0.05, 0.05)];
            g.add(beam([cx + rr * 0.5 * Math.cos(ang), y0 + rr * 0.5 * Math.sin(ang), 1.15], top, 0.012).color('#3a6a2a'));
            g.add(Geo.cone(0.05, 0.08, 4).rotateX(Math.PI).translate(top[0], top[1], top[2] + 0.06).color(col));
          }
        }
        // a price card on a stick
        const card = uvFrom(Geo.quad([-0.07, 0, 0], [0.07, 0, 0], [0.07, 0, 0.09], [-0.07, 0, 0.09]), (p) => [(p[0] + 0.07) / 0.14, p[2] / 0.09]);
        g.add(card.translate(cx + 0.18, y0 - 0.17, 1.12).color('#f4f1e8').mat(MAT.SIGN).tag(1).doubleSided());
      }
      const m = m4.mul(m4.translation(xc, yc, 0), m4.rotationZ(facing > 0 ? Math.PI : 0));
      b.static(g.transform(m), { within: 28, solid: false });
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
      const sitters = new Geo();
      for (const a of [0, Math.PI]) {
        const cm = m4.mul(m4.rotationZ(a), m4.translation(0, 0.75, 0));
        chairs.push([m4.mul(cm, boxM(0.42, 0.42, 0.05, 0, 0, 0.45)), '#3a4a3a'], [m4.mul(cm, boxM(0.42, 0.05, 0.45, 0, 0.2, 0.7)), '#3a4a3a']);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) chairs.push([m4.mul(cm, boxM(0.04, 0.04, 0.45, sx * 0.18, sy * 0.18, 0.225)), '#3a4a3a']);
        if (rand() < 0.65) {
          const p = placePerson(person(rand, { sit: true }), m4.mul(m4.rotationZ(a), m4.translation(0, 0.72, 0), m4.rotationZ(Math.PI)));
          g.add(p);
          sitters.add(p.detail);
        }
      }
      const m = m4.mul(m4.translation(x, y, 0), m4.rotationZ(rand.range(-0.3, 0.3)));
      b.static(g.transform(m));
      // cups on saucers, a little vase with a flower
      for (const cy of [-0.24, 0.24]) {
        sitters.add(Geo.cylinder(0.07, 0.012, 8).translate(0.05, cy, 0.76).color('#f4f1e8'));
        sitters.add(Geo.cylinder(0.035, 0.065, 8, { r2: 0.042 }).translate(0.05, cy, 0.77).color(STYLE.pick(['#f4f1e8', '#e8d8c0', '#c84a3a'])).gloss(0.6));
        sitters.add(Geo.disc(0.036, 8).translate(0.05, cy, 0.83).color('#3a2012'));
      }
      sitters.add(Geo.cylinder(0.03, 0.12, 6, { r2: 0.018 }).translate(-0.12, 0, 0.76).color('#a8c8d0').gloss(0.8));
      sitters.add(beam([-0.12, 0, 0.86], [-0.13, 0.01, 1.0], 0.006).color('#3a6a2a'));
      sitters.add(Geo.cone(0.03, 0.05, 5).rotateX(Math.PI).translate(-0.13, 0.01, 1.04).color(STYLE.pick(['#e23a3a', '#f2c12e', '#f06aa0'])));
      b.static(sitters.transform(m), { within: 16, solid: false });
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
    // the stop's sign: a green disc with a yellow H on a pole, and a timetable case
    const px = STOP_X + 5.5, py = s * 4.05;
    addBoxes([[boxM(0.07, 0.07, 2.5, px, py, 1.25), '#2a3530'], [boxM(0.06, 0.5, 0.66, px, py, 1.55), '#2a3530']]);
    for (const f of [-1, 1]) {
      b.static(uvFrom(Geo.disc(0.3, 12).rotateY(f * Math.PI / 2), (p) => [0.5 + f * p[1] / 0.6, 0.5 + p[2] / 0.6]).translate(px + f * 0.04, py, 2.65).color('#1e7a3a').mat(MAT.SIGN).tag(2), { within: 60, solid: false });
      b.static(uvFrom(Geo.quad([-0.22, 0, -0.3], [0.22, 0, -0.3], [0.22, 0, 0.3], [-0.22, 0, 0.3]), (p) => [(p[0] + 0.22) / 0.44, (p[2] + 0.3) / 0.6]).transform(m4.mul(m4.translation(px + f * 0.032, py, 1.55), m4.rotationZ(f > 0 ? Math.PI / 2 : -Math.PI / 2))).color('#f4f1e8').mat(MAT.SIGN).tag(3), { within: 30, solid: false });
    }
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

// Small things on the houses that face the avenue and the square, there only
// from near by: a drainpipe with its brackets, flower boxes under some of the
// windows, a board on the pavement in front of some shops.  (Their own random
// numbers, so that the rest of the town is as it was.)
function houseDetail(b, h) {
  const { m, w, H, g0, hid, sh, floors, bays } = h;
  const r = rng(hid * 7919 + 13);
  const near = new Geo(), mid = new Geo();
  // the drainpipe at the left end, from the gutter to a shoe at the foot
  const pipe = '#3a4044';
  mid.add(Geo.cylinder(0.05, H - 0.45, 6, { caps: false }).translate(0.14, -0.1, 0.12).color(pipe).gloss(0.4));
  mid.add(Geo.box(0.18, 0.16, 0.22).translate(0.14, -0.1, H - 0.35).color(pipe));
  near.add(Geo.box(0.1, 0.22, 0.08).translate(0.14, -0.18, 0.08).color(pipe));
  for (let z = 1.6; z < H - 0.8; z += 2.4) near.add(Geo.box(0.13, 0.11, 0.035).translate(0.14, -0.06, z).color(pipe));
  // flower boxes under the windows of the first floor
  if (floors > 0 && r() < 0.5) {
    const bw = w / bays, zs = g0 + WIN.b * sh + 0.02;
    const flower = r.pick(['#e23a3a', '#f06aa0', '#f2c12e', '#f4f1e8', '#b04ad0']);
    for (let k = 0; k < bays; k++) {
      const cx = (k + 0.5) * bw, bxw = 2 * WIN.hw * bw + 0.12;
      mid.add(Geo.box(bxw, 0.24, 0.2).translate(cx, -0.25, zs + 0.1).color(r.pick(['#7a4a2a', '#2f5a3a', '#3a3a3a', '#a8a090'])));
      mid.add(Geo.box(bxw - 0.06, 0.2, 0.14).translate(cx, -0.25, zs + 0.25).color('#4a7a32').mat(MAT.LEAF));
      const n = Math.round(bxw / 0.22);
      for (let i = 0; i < n; i++) {
        near.add(Geo.cone(0.07, 0.1, 3).rotateX(Math.PI).translate(cx - bxw / 2 + 0.1 + i * (bxw - 0.2) / Math.max(1, n - 1), -0.25 + r.range(-0.06, 0.06), zs + 0.42 + r.range(0, 0.05)).color(r() < 0.8 ? flower : '#f4f1e8'));
      }
    }
  }
  // a board on the pavement in front of some shops, chalked
  if (r() < 0.3) {
    const x = r.range(1.2, w - 1.2), y = -1.6;
    const board = new Geo();
    board.add(Geo.quad([x - 0.3, y - 0.25, 0], [x + 0.3, y - 0.25, 0], [x + 0.3, y, 0.9], [x - 0.3, y, 0.9]));
    board.add(Geo.quad([x + 0.3, y + 0.25, 0], [x - 0.3, y + 0.25, 0], [x - 0.3, y, 0.9], [x + 0.3, y, 0.9]));
    uvFrom(board, (p) => [(p[0] - x + 0.3) / 0.6, p[2] / 0.9]);
    near.add(board.color('#2a3a2e').mat(MAT.SIGN).doubleSided());
  }
  b.static(mid.transform(m), { within: 50, solid: false });
  b.static(near.transform(m), { within: 30, solid: false });
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

// Litter bins by the lamps, bollards along the kerb of the avenue.
function streetFurniture(b) {
  const bin = new Geo();
  bin.add(Geo.cylinder(0.2, 0.72, 8, { caps: false, r2: 0.22 }).translate(0, 0, 0.08).color('#2f4a3a'));
  bin.add(Geo.cylinder(0.225, 0.06, 8, { r2: 0.2 }).translate(0, 0, 0.74).color('#1e2e24'));
  bin.add(Geo.cylinder(0.12, 0.08, 4, { caps: false }).color('#222'));
  bin.add(Geo.box(0.16, 0.012, 0.1).translate(0, -0.215, 0.6).color('#d8d0b0'));
  const bins = [];
  for (let k = 0; k < AV_LAMP.n; k++) for (const s of [-1, 1]) bins.push(m4.mul(m4.translation(AV_LAMP.x0 + AV_LAMP.dx * k + 1.1, s * 8.4, 0), m4.rotationZ(s > 0 ? Math.PI : 0)));
  for (const [x, y] of SQ_LAMPS) bins.push(m4.mul(m4.translation(x + (x > 0 ? -1 : 1) * 1.1, y, 0), m4.rotationZ(x > 0 ? Math.PI / 2 : -Math.PI / 2)));
  b.instances(bin.gloss(0.3), bins);
  // bollards: cast iron, with a white band
  const bol = Geo.lathe([[0.1, 0], [0.075, 0.2], [0.075, 0.72], [0.09, 0.76], [0, 0.9]], 6);
  bol.colorBy((p) => (p[2] > 0.62 && p[2] < 0.68 ? '#e8e4da' : '#24282a'));
  const bols = [];
  const busy = [];
  for (let k = 0; k < AV_LAMP.n; k++) busy.push(AV_LAMP.x0 + AV_LAMP.dx * k, AV_LAMP.x0 + AV_LAMP.dx * (k + 0.5), AV_LAMP.x0 + AV_LAMP.dx * (k + 0.5) + 3, AV_LAMP.x0 + AV_LAMP.dx * k + 1.1);
  for (let x = -44; x > GATE_X + 4; x -= 6) {
    if (busy.some((q) => Math.abs(q - x) < 1.6) || Math.abs(x - CROSS_X) < 3.2 || Math.abs(x - STOP_X) < 7.5) continue;
    for (const s of [-1, 1]) bols.push(m4.translation(x, s * 9.3, 0));
  }
  b.instances(bol.gloss(0.35), bols);
  // bicycles leaning against the house fronts
  const r = rng(808);
  for (const [x, s] of [[-197.5, 1], [-189, -1], [-176.5, 1], [-158, -1], [-141, 1], [-117.5, -1], [-96, 1], [-83, -1], [-68.5, 1], [-52, -1], [-45, 1]]) {
    const bike = bicycle(r.pick(['#b8342c', '#2b4f7c', '#2f6a4a', '#e0b030', '#222222', '#d8d8d8', '#6b2f5a', '#8a8a6a']), true);
    const dir = r() < 0.5 ? 1 : -1;
    b.static(bike, { transform: m4.mul(m4.translation(x, s * (AW - 0.42), 0), m4.rotationZ(dir * Math.PI / 2), m4.rotationY(-dir * s * 0.13)), solid: false });
  }
}

// Pigeons on the ground, in little flocks: each pecks, then looks up, then
// pecks again, every pigeon in its own time (two poses in turn, as copies
// with time windows).
function groundPigeons(b) {
  const make = (down) => {
    const g = new Geo();
    g.add(lowSphere(0.1, 5, 3).scale(0.65, 1.35, 0.7).translate(0, 0, 0.1).color('#8a8f99'));
    g.add(Geo.triangle([-0.05, -0.12, 0.11], [0.05, -0.12, 0.11], [0, -0.27, 0.09]).color('#5a5f68').doubleSided());
    const hp = down ? [0, 0.19, 0.04] : [0, 0.13, 0.19];
    g.add(lowSphere(0.042, 4, 2).translate(hp[0], hp[1], hp[2]).color('#5f6a72'));
    const tip = down ? [0, 0.235, 0.0] : [0, 0.19, 0.18];
    g.add(limb([[0, hp[1] + 0.03, hp[2]]], 0.01, 3, { tip }).color('#c8a060'));
    g.add(limb([[0, 0.02, 0.1], [0, hp[1] - 0.01, hp[2] - 0.01]], 0.035, 3).color('#6a7a7a'));
    return g;
  };
  const r = rng(4242);
  const flocks = [[-199, -8.2, 6], [-187, 8.3, 5], [-128, 12.8, 5], [-17, 24.0, 7], [-9, 17, 4], [8, -7.6, 6], [-16, -24.5, 5], [-60, -8.0, 4]];
  const up = [], down = [];
  for (const [x, y, n] of flocks) {
    for (let i = 0; i < n; i++) {
      const tf = m4.mul(m4.translation(x + r.range(-1.4, 1.4), y + r.range(-0.45, 0.45), 0), m4.rotationZ(r.range(0, 2 * Math.PI)), m4.scaling(r.range(0.9, 1.1)));
      const per = r.range(1.4, 2.4), ph = r.range(0, per), d = per * r.range(0.35, 0.6);
      down.push({ transform: tf, from: ph, to: ph + d, period: per });
      up.push({ transform: tf, from: ph + d, to: ph + per, period: per });
    }
  }
  b.instances(make(true), down, { within: 35, solid: false });
  b.instances(make(false), up, { within: 35, solid: false });
}

// ---------------------------------------------------------------------------
// moving things

// The small 3D parts of a tram section, drawn from near by: the bogie's side
// frames and wheels with their hubs, grab rails beside the doors, the roof
// equipment, coupler covers and bumper bars at the ends, the mirrors at the
// driving end, the pantograph's insulators.
function tramDetail(kind) {
  const L = TRAM_SEG, g = new Geo(), dark = '#2a2d30', steel = '#3a3c40', chrome = '#c8ccd0';
  for (const s of [-1, 1]) {
    g.add(sbox(0.06, 2.4, 0.16, s * 1.03, 0, 0.34).color('#2e3236'));
    for (const y of [-0.85, 0.85]) {
      const w = new Geo();
      const rr = 0.3 / Math.cos(Math.PI / 8);
      for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; w.vert(s * 1.02, y + rr * Math.cos(a), 0.3 + rr * Math.sin(a), s, 0, 0); }
      for (let i = 1; i < 7; i++) w.tri(0, i, i + 1);
      g.add(w.orientByNormals().color(steel).gloss(0.5).doubleSided());
      g.add(limb([[s * 1.0, y, 0.3]], 0.075, 4, { tip: [s * 1.08, y, 0.3] }).color('#5a5c60').gloss(0.6));
    }
    // grab rails either side of the doors
    for (const y of [-1.13, 0.33]) g.add(limb([[s * 1.24, y, 1.0], [s * 1.24, y, 2.2]], 0.018, 3).color(chrome).gloss(0.85));
  }
  g.add(sbox(1.3, 1.5, 0.24, 0, kind === 'mid' ? 1.6 : 0.2, 3.26).color('#b8bcc0'));
  const end = kind === 'front' ? 1 : kind === 'rear' ? -1 : 0;
  if (end) {
    g.add(sbox(0.55, 0.16, 0.22, 0, end * (L / 2 + 0.06), 0.52).color(dark));
    g.add(sbox(1.7, 0.1, 0.12, 0, end * (L / 2 + 0.04), 0.4).color('#3a3e42'));
  }
  if (kind === 'front') {
    for (const s of [-1, 1]) {
      g.add(limb([[s * 1.18, L / 2 - 0.25, 2.32], [s * 1.42, L / 2 - 0.12, 2.36]], 0.022, 3).color(dark));
      g.add(limb([[s * 1.45, L / 2 - 0.1, 2.08], [s * 1.45, L / 2 - 0.1, 2.4]], 0.07, 4, { sx: 0.45 }).color(dark));
    }
  }
  if (kind === 'mid') {
    for (const x of [-0.35, 0.35]) g.add(limb([[x, -0.8, 3.26], [x, -0.8, 3.4]], 0.04, 4).color('#8a3a2a'));
  }
  return g;
}

function trams(b) {
  const kinds = ['rear', 'mid', 'front'];
  const detail = kinds.map(tramDetail);
  for (let j = 0; j < TRAM_N; j++) {
    for (let k = 0; k < 3; k++) {
      const off = TRAM_OFF + j * TRAM_PATH.length / TRAM_N + k * (TRAM_SEG + TRAM_GAP);
      const tf = follow(TRAM_PATH, { speed: TRAM_V, offset: off, span: TRAM_SEG * 0.75 });
      const times = adaptiveTimes(tf, 0, P, { size: 3.2, tolerance: 0.09, maxStep: 8 });
      b.dynamic(tramSection(kinds[k], j), { times, transform: tf, caps: 'none' });
      b.dynamic(detail[k], { times, transform: tf, caps: 'none', within: 25 });
    }
  }
}

// Things that come in along an open route, cross the town and leave again:
// one every `every` seconds, each existing from its start to its end.
// Whatever `make(rand, speed, kid)` returns may carry small parts in
// `.detail`: they go with it all the way, drawn from `within` metres; and a
// movement of its own that repeats in `.gait` (see moving()).  With `pairs`,
// every other one is two, side by side at the same pace (now and then a
// grown-up and a child, `kid`): people in twos never walk through one
// another, as people walking each at their own pace along one line would.
function travellers(b, rand, pts, { speed, every, make, size, lift = 0, start = 0, within = 12, pairs = false }) {
  const path = new Path(pts.map((p) => [p[0], p[1], 0]));
  const n = Math.max(1, Math.round(P / every));
  for (let i = 0; i < n; i++) {
    const t0 = start + i * P / n;
    const v = speed * rand.range(0.97, 1.03);
    const d = path.length / v;
    const tf = follow(path, { speed: v, offset: -v * t0, span: size * 1.5, lift });
    const times = adaptiveTimes(tf, t0, t0 + d, { size, tolerance: 0.1, maxStep: 40 });
    if (!pairs || i % 2 === 0) {
      moving(b, make(rand, v), { times, transform: tf, caps: 'both' }, within);
      continue;
    }
    const kid = rand() < 0.4;
    for (const side of [-0.33, 0.33]) {
      moving(b, make(rand, v, kid && side > 0), { times, transform: (t) => m4.mul(tf(t), m4.translation(side, 0, 0)), caps: 'both' }, within);
    }
  }
}

// Adds a thing made by person() or cyclist() that moves as `o` says (times,
// transform, caps): its body, and its detail, drawn from `within` metres.  A
// thing with a `gait` (a stride, the pedals going round) has parts that move
// with it as well, each with its own poses of one round of that movement
// (`keys`) and perhaps drawn only from near by.  All on the same keys.
function moving(b, geo, o, within) {
  b.dynamic(geo, o);
  if (geo.detail) b.dynamic(geo.detail, { ...o, within });
  const g = geo.gait;
  if (!g) return;
  for (const part of g.parts) {
    const cycle = { period: g.period, keys: part.keys, start: o.times[0] + g.phase * g.period };
    b.dynamic(part.geo, part.within ? { ...o, within: part.within, cycle } : { ...o, cycle });
  }
}

function walkersRoundTower(b, rand) {
  const n = 7, r = 10.6;
  const loop = new Path(Array.from({ length: 72 }, (_, i) => [r * Math.cos(i / 72 * 2 * Math.PI), r * Math.sin(i / 72 * 2 * Math.PI), 0]), { closed: true });
  const v = 2 * loop.length / P;
  for (let i = 0; i < n; i++) {
    const tf = follow(loop, { speed: v, offset: i * loop.length / n, span: 1 });
    // (they go round and round all the time: a whole number of strides to the period)
    const p = person(rand, { scale: rand.range(0.92, 1.06), walk: v, fit: P });
    const times = adaptiveTimes(tf, 0, P, { size: 0.5, tolerance: 0.08, maxStep: 4 });
    moving(b, p, { times, transform: tf, caps: 'none' }, 14);
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
    // the wings beat once a second (a whole number of beats to the period):
    // four poses to a beat, up, level, down, level.  Half of the birds keep
    // beating; the others beat twice and then glide for two seconds, each
    // starting at a time of its own.
    const tri = (u) => 1 - 4 * Math.abs(u - 0.5);
    if (i % 2) b.dynamic((u) => pigeon(col, tri(u)), { times: timeRange(0, P, 0.5), transform: tf, caps: 'none', cycle: { period: 1, keys: 4, start: -fo } });
    else b.dynamic((u) => pigeon(col, u < 0.5 ? tri((u * 4) % 1) : 0.15), { times: timeRange(0, P, 0.5), transform: tf, caps: 'none', cycle: { period: 4, keys: 16, start: Math.floor(GAIT() * 16) / 4 } });
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

// Balloons: a seller in the square, west of the tower, with a bunch of them on
// strings; and once a minute a cloud of them let go from the town hall's
// balcony, rising over the roofs at 1.75 to 2.15 m/s (each at its own speed,
// so that the cloud spreads as it goes) and drifting north on the breeze.  A
// straight rise needs only two keys.  In a view tilted up a balloon is seen
// the later the higher it is, so the cloud is drawn out upwards; between 78°
// and 80°, where 10 m/s over the tangent is a balloon's own speed, the slice
// runs along its ascent, and seen from a moment or two before a release the
// cloud is a sheaf of long coloured threads.  (The speeds are kept close for
// that: the further a balloon's is from that of the slice, the shorter its
// thread.)
const BALLOON_COLS = ['#d8402f', '#f2c12e', '#2f6fb3', '#3c9a5a', '#e07a2a', '#d84a8a', '#f4f1e8', '#7a4ab0'];
function balloon(col) {
  const g = lowSphere(0.17, 7, 5).scale(1, 1, 1.2).translate(0, 0, 0.23).color(col).gloss(0.55);
  return g.add(Geo.cone(0.035, 0.05, 4).color(col));
}
// (Each cloud goes up as five groups of eight, a group one mesh with one
// speed and drift, its balloons let go at places of their own along the
// balcony: every moving thing costs the renderer something in every pass,
// however small.  They are plain, as they are never seen from closer than
// 30 m or so, cast no shadow, which nobody could see from that height, and
// are drawn from 180 m, beyond which a balloon is less than a pixel or two.)
function balloonRelease(b) {
  const r = rng(7177);
  for (const t0 of [20, 80]) {
    for (let k = 0; k < 5; k++) {
      const v = 1.75 + 0.1 * k + r.range(-0.03, 0.03), a = r.range(0.3, 0.7) * Math.PI, drift = r.range(0.3, 0.8);
      const g = new Geo();
      for (let i = 0; i < 8; i++) g.add(lowSphere(0.17, 5, 3).scale(1, 1, 1.2).translate(SQ - 3.3 + r.range(-0.3, 0.3), r.range(-15, 15), 7.43 + r.range(0, 0.6)).color(r.pick(BALLOON_COLS)).gloss(0.55));
      const t1 = t0 + 0.3 * k, t2 = t1 + 85 / v;
      const tf = (t) => m4.translation(Math.cos(a) * drift * (t - t1), Math.sin(a) * drift * (t - t1), v * (t - t1));
      b.dynamic(g.noShadow(), { times: [t1, t2], transform: tf, caps: 'both', within: 180 });
    }
  }
}
function balloons(b, at) {
  const r = rng(6061);
  const [bx, by] = at;
  const seller = placePerson(person(r, { scale: 1.02 }), m4.mul(m4.translation(bx, by, 0), m4.rotationZ(Math.PI / 2)));
  b.static(seller);
  b.static(seller.detail, { within: 16, solid: false });
  // the bunch, its strings gathered in the seller's right hand
  const hand = [bx, by + 0.24, 0.95];
  const bunch = new Geo();
  for (let i = 0; i < 11; i++) {
    const a = i * 2.4, rr = 0.12 + 0.3 * Math.sqrt((i + 0.5) / 11);
    const knot = [hand[0] + rr * Math.cos(a), hand[1] + rr * Math.sin(a), 2.25 + 0.5 * ((i * 0.618) % 1)];
    bunch.add(balloon(r.pick(BALLOON_COLS)).rotateX(r.range(-0.25, 0.25)).rotateY(r.range(-0.25, 0.25)).translate(...knot));
    bunch.add(beam(hand, knot, 0.007).color('#e8e4da'));
  }
  b.static(bunch, { solid: false });
  balloonRelease(b);
}

function flags(b) {
  // two flags on the town hall's poles, a wave running out along them every
  // 1.5 s: one round of it as eight poses (80 rounds to the period)
  const L = 3.4, Hf = 2.2, nx = 5, nz = 2, wave = 1.5;
  const make = (col, ph) => (w) => {
    const g = Geo.plane(L, Hf, nx, nz).rotateX(Math.PI / 2).translate(L / 2, 0, 0);
    for (let i = 0; i < g.p.length; i += 3) {
      const x = g.p[i], u = x / L;
      g.p[i + 1] += u * 0.35 * Math.sin(2 * Math.PI * (u * 1.3 - w) + ph);
      g.p[i + 2] -= u * u * 0.25;
    }
    g.computeNormals();
    return g.colorBy((p) => (p[2] > Hf / 6 ? col[0] : p[2] > -Hf / 6 ? col[1] : col[2]));
  };
  for (const [y, col, ph] of [[-12, ['#f2c12e', '#f4f1e8', '#d8402f'], 0], [12, ['#2f6fb3', '#f4f1e8', '#2f6fb3'], 1.7]]) {
    const top = [SQ - 3.2, y, 12.4];
    b.dynamic(make(col, ph), { times: [0, P], transform: () => m4.mul(m4.translation(top[0], top[1], top[2] - Hf / 2 - 0.05), m4.rotationZ(Math.PI)), caps: 'none', cycle: { period: wave, keys: 8 } });
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
  ground,
  wgsl,

  // The music (see "Music" in docs/SCENES.md).
  // Old Town: a round dance for the festival, in six-eight and in the Dorian
  // mode.  A hand drum and a tambourine, a lute, a held fifth as of a
  // hurdy-gurdy, a pipe with the tune, and the tower's bell every eight bars.
  music: {
    seconds: 40.32, reverb: 1.4, echo: [0.42, 0.2], seed: 41,
    build(m) {
      const { n, notes, tune } = m;
      const e = 0.21, bar = 6 * e; // a quaver, and a bar of six
      const drum = m.track({ gain: 0.9, hall: 0.15 }), shake = m.track({ pan: 0.4, hall: 0.2 }), lute = m.track({ pan: -0.35, hall: 0.3 });
      const pipe = m.track({ pan: 0.1, hall: 0.4, echo: 0.15, vib: [5.2, 10] }), reed = m.track({ pan: -0.1, hall: 0.3, vib: [5.2, 6] });
      const hum = m.track({ hall: 0.3, lowpass: 900 }), tower = m.track({ hall: 0.8 });
      m.drone(hum, n('D3'), { type: 'sawtooth', gain: 0.045, cutoff: 600 });
      m.drone(hum, n('A3'), { type: 'sawtooth', gain: 0.03, cutoff: 700, swell: [8, 0.5] });
      const chord = { Dm: notes('D3 A3 D4 F4'), C: notes('C3 G3 C4 E4'), Am: notes('A2 E3 A3 C4'), F: notes('F3 C4 F4 A4') };
      const A = 'Dm Dm C C Dm Dm Am Dm', B = 'F F C C Dm C Am Dm';
      `${A} ${A} ${B} ${A}`.split(' ').forEach((name, k) => {
        const t0 = k * bar, c = chord[name];
        m.thud(drum, t0, 0.65);
        m.thud(drum, t0 + 3 * e, 0.45);
        if (k % 2) m.thud(drum, t0 + 5 * e, 0.3);
        for (const [i, v] of [[1, 0.35], [2, 0.8], [4, 0.35], [5, 0.8]]) m.jingle(shake, t0 + i * e, v);
        [c[0], c[1], c[2], c[3], c[2], c[1]].forEach((p, i) => m.pluck(lute, t0 + i * e, p, { gain: i === 0 ? 0.28 : 0.2, decay: 0.5, bright: 3800, dark: 700 }));
        if (k % 8 === 0) m.bell(tower, t0, n('D4'), { partials: 'glass', gain: 0.12, decay: 4 });
      });
      const blow = (t, d, p) => {
        m.tone(pipe, t, d * 0.9, p, { type: 'triangle', gain: 0.22, a: 0.03, d: 0.2, s: 0.8, r: 0.1 });
        m.noise(pipe, t, { dur: 0.03, gain: 0.03, type: 'bandpass', freq: 3000, q: 1 });
      };
      // (a second player an octave below, where the tune comes round again)
      const both = (t, d, p) => { blow(t, d, p); m.tone(reed, t, d * 0.9, p - 12, { type: 'sawtooth', cutoff: 1400, gain: 0.06, a: 0.03, d: 0.2, s: 0.8, r: 0.1 }); };
      const first = 'A4:3 D5:2 E5  F5:2 E5 D5:2 A4  E5:2 D5 C5:2 G4  C5:3 E5:3  D5:2 F5 A5:2 G5  F5:2 E5 D5:3  C5:2 E5 D5:2 C5  D5:6';
      const second = 'A5:3 F5:2 A5  C6:2 A5 F5:3  G5:3 E5:2 G5  C6:2 G5 E5:3  F5:2 G5 A5:2 F5  E5:2 F5 G5:2 E5  C5:2 D5 E5:2 C5  D5:6';
      tune(0, e, first, blow);
      tune(8 * bar, e, first, both);
      tune(16 * bar, e, second, blow);
      tune(24 * bar, e, first, both);
    },
  },

  build(b) {
    const rand = rng(1871);
    STYLE = rng(29);
    GAIT = rng(3);
    HOUSE_ID = 1;
    BOXES = [];
    MERLONS = [];

    // ground, subdivided so that no edge is long
    b.static(Geo.plane(3000, 3000, 40, 40).color('#888888').mat(MAT.GROUND));

    // ---- houses round the square and along the avenue
    const specials = { cinema: -1, chemists: [] };
    const extras = (h) => {
      if (h.gone) {
        // (a house left out: its extras draw their random numbers all the same, and are dropped)
        const n = BOXES.length;
        shopExtras({ static() {} }, rand, h, specials);
        BOXES.length = n;
        return;
      }
      shopExtras(b, rand, h, specials);
      houseDetail(b, h);
    };
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
    // (its first house, by the gate, is left out: there is a yard there with
    // the stair up to the wall)
    row(b, rand, { ...front, start: [GATE_X, AW], nrm: [0, -1], length: -SQ - DEPTH - GATE_X, gaps: [[78, 84]], leave: HOUSE_ID });
    specials.chemists.push(HOUSE_ID + 7);
    row(b, rand, { ...front, start: [-SQ - DEPTH, -AW], nrm: [0, 1], length: -SQ - DEPTH - GATE_X, gaps: [[64, 70]] });

    townHall(b);
    clockTower(b);
    gate(b);
    cityWall(b, rand);
    wallStair(b);
    blocks(b, rand);

    // ---- street lamps
    const lamps = [];
    for (let k = 0; k < AV_LAMP.n; k++) {
      for (const y of [-AV_LAMP.y, AV_LAMP.y]) lamps.push(m4.translation(AV_LAMP.x0 + AV_LAMP.dx * k, y, 0));
    }
    for (const [x, y] of SQ_LAMPS) lamps.push(m4.translation(x, y, 0));
    b.instances(lampPost(), lamps);
    b.instances(lampDetail(), lamps, { within: 30, solid: false });

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
      const p = placePerson(person(rand, { sit: true }), m4.mul(m4.translation(x, y, 0), m4.rotationZ(a)));
      b.static(p);
      b.static(p.detail, { within: 16, solid: false });
    }

    fountain(b);
    carousel(b);
    market(b, rand);
    marketGoods(b);
    cafe(b, rand);
    tramStop(b);
    signals(b);
    streetFurniture(b);
    groundPigeons(b);
    countryside(b, rand);
    pillarClock(b, -20, 0);
    bracketClock(b, -196, AW, 5.0, 1);

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
    R_WALK.forEach((r, i) => travellers(b, rand, r, { speed: 1.35, every: P / 7, pairs: true, make: (rr, v, kid) => person(rr, { scale: rr.range(0.9, 1.07), walk: v, kid }), size: 0.4, start: i * 2.2 }));
    walkersRoundTower(b, rand);
    birds(b, rand);
    fountainJets(b);
    carouselHorses(b);
    flags(b);
    // (last, so that the figures of the town draw their looks as they always did)
    balloons(b, [-16.5, -7]);
  },
};
