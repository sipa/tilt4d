// The Clockmaker's Workshop: one small room on a late afternoon, full of
// clocks and mechanisms that all move slowly, at centimetres a second.  The
// sun comes in low through a window in the left wall and falls across the
// left half of a long workbench; a lamp lights the right half.
//
// Everything that moves is built from small pieces and keyed finely in time,
// because with a second of time worth only 0.3 m (C) a tilted view warps it
// strongly: a turning wheel becomes a screw, a pendulum an S.  Stiff parts
// (wheels, hands, pendulums, arms, even the cat's breathing body) are fixed
// meshes moved by `cycle.transform`; only what bends (flames, cloth, water,
// the dust) changes shape.
//
// Layout (x to the right of the starting view, y away from it, z up; metres):
//   the room       x -2.4 .. 2.4, y -1.9 .. 1.9, z 0 .. 2.7
//   the bench      along the back wall, y 1.15 .. 1.9, top at z 0.92
//   the window     in the left wall, y 0.15 .. 1.55, z 1.0 .. 2.25
//   wall clocks    on the back wall over the bench, and round the room
// The clocks read 4 o'clock at t = 0 and the player starts at t = 1800, half
// past.  The scene repeats every hour, so every cycle here has a whole
// number of rounds in 3600 s; only the hour hands jump back, at the hour.

import { Geo, parseColor as parseCol } from '../geom.js';
import { m4, v3 } from '../math.js';
import { rng, Path, adaptiveTimes } from '../util.js';

const C = 0.3;
const P = 3600;
const T_SPAWN = 1800;
const TAU = 2 * Math.PI;
const GRAV = 9.81;
const lengthFor = (T) => GRAV * (T / TAU) ** 2; // a simple pendulum swinging in T seconds

// the room
const RX = 2.4, RY = 1.9, RZ = 2.7;
const BENCH = 0.92, BENCH_Y0 = 1.15;
const WIN = { y0: 0.15, y1: 1.55, z0: 1.0, z1: 2.25 };
const SUN = v3.norm([-0.8, -0.35, 0.5]); // towards the sun

const MAT = {
  PLASTER: 1, FLOOR: 2, WOOD: 3, BRASS: 4, STEEL: 5, DIAL: 6, WHEEL: 7, GLASS: 8, FLAME: 9, BEAM: 10,
  MOTE: 11, BOOK: 12, CLOTH: 13, FUR: 14, PAINT: 15, BLUED: 16, LAMP: 17, RUG: 18, PANEL: 19, SKYWIN: 20, EMBER: 21, LOG: 22,
  BENCH: 23, DRAWING: 24,
};

// Where things stand on the bench and on the floor, as [x, y, half width, half
// depth] (as build() places them): the shader darkens the light from round
// about close to their feet, which the lamp and the room's own light cast no
// shadows to do.  (The sun's shadows are real.)
const BENCH_FEET = [
  [-1.35, 1.5, 0.13, 0.065], [-2.0, 1.45, 0.1, 0.065], [-0.98, 1.5, 0.1, 0.265], [0, 1.5, 0.11, 0.11], [1.55, 1.45, 0.06, 0.042],
  [0.76, 1.405, 0.18, 0.08], [1.08, 1.4, 0.08, 0.055], [1.75, 1.72, 0.29, 0.07], [1.75, 1.3, 0.05, 0.03], [1.89, 1.36, 0.05, 0.03],
  [2.03, 1.3, 0.05, 0.03], [0.35, 1.28, 0.039, 0.034], [1.3, 1.3, 0.039, 0.034], [-0.35, 1.32, 0.039, 0.034], [0.92, 1.22, 0.03, 0.03],
  [0.42, 1.68, 0.11, 0.025], [2.22, 1.72, 0.075, 0.075], [-0.55, 1.28, 0.1, 0.065], [-1.75, 1.2, 0.035, 0.05], [-0.36, 1.2, 0.03, 0.03],
  [0.2, 1.8, 0.025, 0.025], [0.28, 1.82, 0.025, 0.025], [-0.3, 1.82, 0.025, 0.025], [1.45, 1.75, 0.03, 0.03], [1.62, 1.25, 0.03, 0.03],
  [-0.12, 1.24, 0.03, 0.03], [-0.285, 1.205, 0.024, 0.024], [0.06, 1.19, 0.022, 0.022],
];
const FLOOR_FEET = [
  [-0.55, -1.15, 0.3, 0.3], [2.16, -1.05, 0.22, 0.65], [2.26, 0.45, 0.14, 0.24], [-2.23, -1.58, 0.17, 0.29], [1.675, -1.76, 0.425, 0.14],
  [-1.013, -0.703, 0.03, 0.03], [-1.123, -1.003, 0.03, 0.03], [-1.577, -0.497, 0.03, 0.03], [-1.687, -0.797, 0.03, 0.03],
  [-2.05, -0.95, 0.18, 0.18], [-0.35, -1.6, 0.13, 0.13], [1.2, -1.5, 0.06, 0.06], [-0.3, 0.85, 0.14, 0.14], [0.25, -1.15, 0.17, 0.12],
];
const feetWgsl = (name, list, reach, depth) => `fn ${name}(p: vec2f) -> f32 {
  var f = array<vec4f, ${list.length}>(${list.map((v) => `vec4f(${v.map((x) => x.toFixed(3)).join(', ')})`).join(', ')});
  var o = 1.0;
  for (var i = 0; i < ${list.length}; i++) {
    let rr = 0.6 * min(f[i].z, f[i].w);
    let q = abs(p - f[i].xy) - (f[i].zw - vec2f(rr));
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
    o = o * (1.0 - ${depth.toFixed(2)} * (1.0 - smoothstep(0.0, ${reach.toFixed(3)}, d)));
  }
  return o;
}`;

// ---- colours
const COL = {
  brass: '#b8924a', brassDark: '#8f6f2c', steel: '#a9adb3', blued: '#1d2a4a', oak: '#7a5233', oakDark: '#4a3020',
  walnut: '#5a3a24', enamel: '#f2ede0', black: '#16130f', plaster: '#d9cdb4', copper: '#b06a3c', red: '#8e2a20',
};

const wgsl = /* wgsl */ `
const SUN_DIR = vec3f(${SUN.map((v) => v.toFixed(5)).join(', ')});
const SUN_COL = vec3f(2.9, 2.35, 1.75);
const LAMP_POS = vec3f(2.12, 1.58, 1.32);

fn envSun(t: f32) -> Light { return Light(SUN_DIR, SUN_COL); }

// What is seen through the window: a pale afternoon sky over a garden, with
// the light coming from beyond it.  Against the light, from far to near:
// roofs and chimneys pale in the haze, a row of trees, the hedge at the end
// of the garden (some 14 m off, its foot below the eye), and the lawn.
fn envSky(dir: vec3f, t: f32) -> vec3f {
  let up = dir.z;
  var c = mix(vec3f(1.25, 1.05, 0.82), vec3f(0.42, 0.62, 1.05), smoothstep(0.02, 0.55, up));
  if (up < 0.16) {
    let az = atan2(dir.y, dir.x);
    let e = 0.0025;
    // houses, each its own height, most of them gabled, some with a chimney
    let k = floor(az / 0.13);
    let f = fract(az / 0.13);
    let hh = hash11(k + 17.0);
    var roof = 0.045 + 0.03 * hh + 0.04 * (0.5 - abs(f - 0.5)) * step(0.3, hh);
    roof += 0.02 * step(abs(f - 0.25 - 0.5 * hash11(k + 41.0)), 0.03) * step(0.4, hash11(k + 3.0));
    c = mix(mix(c, vec3f(0.36, 0.38, 0.44), 0.45), c, smoothstep(roof - e, roof + e, up));
    let tree = 0.03 + 0.09 * smoothstep(0.35, 0.7, fbm2(vec2f(az * 14.0, 1.5))) + 0.008 * noise2(vec2f(az * 90.0, 0.0));
    c = mix(mix(c, vec3f(0.10, 0.14, 0.08), 0.78), c, smoothstep(tree - e, tree + e, up));
    let hedge = 0.035 + 0.012 * noise2(vec2f(az * 45.0, 2.0)) + 0.005 * noise2(vec2f(az * 160.0, 5.0));
    c = mix(vec3f(0.09, 0.14, 0.05), c, smoothstep(hedge - e, hedge + e, up));
    if (up < -0.1) {
      // the lawn in the sun, mottled, mown in stripes
      let g = dir.xy * (1.5 / max(-up, 0.05));
      let lawn = vec3f(0.30, 0.42, 0.13) * (0.75 + 0.35 * fbm2(g * 0.8)) * (0.92 + 0.12 * step(0.5, fract(g.y * 0.8)));
      c = mix(c, lawn, smoothstep(-0.1, -0.12, up));
    }
  }
  let sd = max(dot(dir, SUN_DIR), 0.0);
  c += vec3f(2.0, 1.6, 1.1) * (pow(sd, 900.0) * 40.0 + pow(sd, 12.0) * 0.5);
  return c;
}

// the room's own light: thrown back from the sunlit bench and floor, warm from below, dimmer from above
fn envAmbient(n: vec3f, t: f32) -> vec3f {
  let base = mix(vec3f(0.10, 0.078, 0.058), vec3f(0.088, 0.080, 0.074), n.z * 0.5 + 0.5);
  // the window side is brighter
  return base + vec3f(0.035, 0.035, 0.034) * saturate(-n.x);
}

fn envFog(dir: vec3f, t: f32, dist: f32) -> vec4f { return vec4f(0.0); }

// what polished brass and glass mirror: a room, dark wood below, the bright window to the left
fn envReflect(dir: vec3f, t: f32, lit: f32) -> vec3f {
  var c = mix(vec3f(0.10, 0.07, 0.045), vec3f(0.22, 0.19, 0.15), smoothstep(-0.3, 0.4, dir.z));
  let w = smoothstep(0.55, 0.8, -dir.x) * smoothstep(-0.2, 0.1, dir.z) * smoothstep(0.75, 0.3, abs(dir.y + 0.2));
  c = mix(c, vec3f(1.6, 1.45, 1.25), w);
  let l = normalize(LAMP_POS - vec3f(0.0, 0.5, 1.2));
  c += vec3f(1.8, 1.2, 0.6) * pow(max(dot(dir, l), 0.0), 60.0);
  return c * mix(0.6, 1.0, lit);
}

// Is a point in the sunbeam that comes through the window?  (Followed back
// along the sun's direction to the plane of the window.)
// And then the window's frame and glazing bars, 12 cm further out: their
// shadows run through the beam as darker shafts, soft at the edges by as much
// as a sun half a degree across makes them at that distance.
fn inBeam(p: vec3f) -> f32 {
  let s = (${(-RX).toFixed(2)} - p.x) / SUN_DIR.x;
  let q = p + SUN_DIR * s;
  let e = min(min(q.y - ${WIN.y0.toFixed(2)}, ${WIN.y1.toFixed(2)} - q.y), min(q.z - ${WIN.z0.toFixed(2)}, ${WIN.z1.toFixed(2)} - q.z));
  let w = p + SUN_DIR * (s - 0.12 / SUN_DIR.x);
  let pen = 0.002 + 0.0047 * s;
  let ym = ${((WIN.y0 + WIN.y1) / 2).toFixed(4)};
  let yq = ${((WIN.y1 - WIN.y0) / 4).toFixed(4)};
  let zt = ${((WIN.z1 - WIN.z0) / 3).toFixed(4)};
  var bars = smoothstep(0.0225 - pen, 0.0225 + pen, abs(w.y - ym));
  bars = bars * smoothstep(0.011 - pen, 0.011 + pen, min(abs(w.y - ym + yq), abs(w.y - ym - yq)));
  bars = bars * smoothstep(0.045 - pen, 0.045 + pen, min(w.z - ${WIN.z0.toFixed(2)}, ${WIN.z1.toFixed(2)} - w.z));
  bars = bars * smoothstep(0.011 - pen, 0.011 + pen, min(abs(w.z - ${WIN.z0.toFixed(2)} - zt), abs(w.z - ${WIN.z0.toFixed(2)} - 2.0 * zt)));
  return smoothstep(0.0, 0.04, e) * step(0.0, s) * bars;
}

${feetWgsl('benchFeet', BENCH_FEET, 0.035, 0.55)}
${feetWgsl('floorFeet', FLOOR_FEET, 0.12, 0.5)}

// the lamps the shader works out for itself: a desk lamp over the right end of
// the bench, and the light the sunlit patch throws back up
fn roomLight(p: vec3f, n: vec3f, t: f32) -> vec3f {
  let dl = LAMP_POS - p;
  let d2 = dot(dl, dl);
  let l = dl * inverseSqrt(d2);
  // the shade lets it out downwards
  let cone = 0.25 + 0.75 * smoothstep(0.0, 0.5, -l.z);
  var c = vec3f(1.0, 0.66, 0.34) * (0.22 * cone / (d2 + 0.03)) * max(dot(n, l), 0.0);
  let pb = vec3f(-1.25, 1.35, 0.95) - p;
  let b2 = dot(pb, pb);
  c += vec3f(0.55, 0.40, 0.25) * (0.05 / (b2 + 0.25)) * max(dot(n, pb * inverseSqrt(b2)) * 0.7 + 0.3, 0.0);
  // two candles on the bench
  for (var i = 0; i < 2; i++) {
    let pc = select(vec3f(-0.12, 1.24, 1.08), vec3f(1.62, 1.25, 1.12), i == 1) - p;
    let c2 = dot(pc, pc);
    let fl = 0.85 + 0.1 * sin(t * 9.1 + f32(i) * 2.0) + 0.05 * sin(t * 17.3);
    c += vec3f(1.0, 0.6, 0.25) * (0.012 * fl / (c2 + 0.004)) * max(dot(n, pc * inverseSqrt(c2)) * 0.8 + 0.2, 0.0);
  }
  // the fire, flickering
  let pf = vec3f(0.45, -1.68, 0.25) - p;
  let f2 = dot(pf, pf);
  let flick = 0.78 + 0.1 * sin(t * 7.3) + 0.07 * sin(t * 13.1 + 1.0) + 0.05 * sin(t * 23.7) + 0.1 * (noise2(vec2f(t * 5.0, 0.5)) - 0.5);
  // (the chimney breast stops it reaching the wall it stands in)
  let out = smoothstep(-0.05, 0.1, p.y + 1.62);
  c += vec3f(1.0, 0.42, 0.12) * (0.2 * flick * out / (f2 + 0.06)) * max(dot(n, pf * inverseSqrt(f2)) * 0.85 + 0.15, 0.0);
  return c;
}

fn cutout(s: Surface) -> f32 {
  if (s.mat != ${MAT.WHEEL}u || s.tag == 0u) { return 1.0; }
  // the windows between a wheel's spokes: uv runs -1..1 over the wheel, aux is where its rim begins
  let q = s.uv * 2.0 - 1.0;
  let r = length(q);
  let n = f32(s.tag);
  let sect = TAU / n;
  let am = (fract(atan2(q.y, q.x) / sect + 0.5) - 0.5) * sect;
  let d = abs(sin(am)) * r;
  let e = min(min(r - 0.26, s.aux - r), d - (0.05 + 0.035 * (1.0 - r)));
  return 1.0 - smoothstep(-0.012, 0.012, e);
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  let fw = fwidth(s.pos);
  let fu = fwidth(s.uv);
  s.light = roomLight(s.pos, s.n, s.t);
  let p = s.pos;
  if (s.mat == ${MAT.PLASTER}u) {
    // limewash, mottled
    let m = fbm2(p.xz * 3.0 + p.y * 2.0);
    s.color = s.color * (0.88 + 0.2 * m);
  } else if (s.mat == ${MAT.FLOOR}u) {
    // wide oak boards running away from the door, each its own shade, with grain
    let bw = 0.19;
    let k = floor(p.x / bw);
    let along = p.y + hash11(k) * 3.0;
    let joint = floor(along / 1.7);
    let h = hash21(vec2f(k, joint));
    let grain = noise2(vec2f(p.x * 90.0, along * 4.0)) * 0.5 + noise2(vec2f(p.x * 30.0, along * 1.3)) * 0.5;
    s.color = s.color * (0.72 + 0.4 * h) * (0.8 + 0.35 * grain);
    let gx = abs(fract(p.x / bw) - 0.5) * bw;
    let gy = abs(fract(along / 1.7) - 0.5) * 1.7;
    let line = max(1.0 - smoothstep(0.0, 0.003 + fw.x, 0.5 * bw - gx), 1.0 - smoothstep(0.0, 0.003 + fw.y, 0.85 - gy));
    s.color = mix(s.color, vec3f(0.03, 0.02, 0.015), line * 0.8);
    // worn paler and duller where the clockmaker stands at the bench
    let wx = (p.x + 0.3) / 0.45;
    let wy = (p.y - 0.95) / 0.3;
    let worn = exp(-wx * wx - wy * wy);
    s.color = mix(s.color, s.color * 1.25 + vec3f(0.03, 0.025, 0.02), worn * 0.6);
    s.gloss = 0.25 - 0.15 * worn;
    // brass filings swept under the vice, glinting
    let fd = (p.xy - vec2f(-1.75, 1.05)) / vec2f(0.25, 0.18);
    let fl = step(0.996, hash21(floor(p.xy * 700.0))) * exp(-dot(fd, fd));
    s.color = mix(s.color, vec3f(0.8, 0.6, 0.25), fl);
    s.gloss = max(s.gloss, fl);
    // darker close to the walls, under the bench and round the furniture
    let dw = min(${RX.toFixed(2)} - abs(p.x), ${RY.toFixed(2)} - abs(p.y));
    let o = mix(0.55, 1.0, smoothstep(0.02, 0.3, dw)) * mix(1.0, 0.45, smoothstep(${(BENCH_Y0 - 0.15).toFixed(2)}, ${(BENCH_Y0 + 0.25).toFixed(2)}, p.y)) * floorFeet(p.xy);
    s.ambient = s.ambient * o;
    s.light = s.light * o;
  } else if (s.mat == ${MAT.BENCH}u) {
    // The bench top: oak with its grain along the bench, and the wear of
    // years.  Darkened along the front edge where hands and arms rest, most
    // where the work is done (under the loupe, at the vice), and polished
    // there; fine scratches; the ring an oil can left.  Darker close to the
    // feet of whatever stands on it.
    let g = noise2(vec2f(p.x * 1.3, p.y * 160.0)) * 0.6 + noise2(vec2f(p.x * 8.5, p.y * 530.0)) * 0.4;
    var c = s.color * (0.78 + 0.4 * g);
    if (s.n.z > 0.5) {
      let d = max(p.y - ${BENCH_Y0.toFixed(2)}, 0.0);
      let w1 = (p.x + 0.25) / 0.35;
      let w2 = (p.x + 1.75) / 0.25;
      let w3 = (p.x - 0.8) / 0.5;
      let edge = exp(-d / 0.07) * (0.35 + 0.65 * min(exp(-w1 * w1) + 0.7 * exp(-w2 * w2) + 0.4 * exp(-w3 * w3), 1.0));
      c = c * (1.0 - 0.35 * edge);
      s.gloss = 0.2 + 0.35 * edge;
      let scr = smoothstep(0.88, 0.97, noise2(vec2f(p.x * 9.0 + p.y * 3.0, p.y * 900.0))) * smoothstep(0.4, 0.7, noise2(p.xy * 6.0));
      c = mix(c, c * 1.35 + vec3f(0.02), scr * 0.5);
      let ring = length(p.xy - vec2f(1.37, 1.63));
      c = c * (1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.004, abs(ring - 0.032))) - 0.12 * (1.0 - smoothstep(0.02, 0.034, ring)));
      let o = benchFeet(p.xy);
      s.ambient = s.ambient * o;
      s.light = s.light * o;
    }
    s.color = c;
  } else if (s.mat == ${MAT.WOOD}u) {
    // wood: grain along uv.x
    let g = noise2(vec2f(s.uv.x * 6.0, s.uv.y * 120.0)) * 0.6 + noise2(vec2f(s.uv.x * 40.0, s.uv.y * 400.0)) * 0.4;
    s.color = s.color * (0.78 + 0.4 * g);
  } else if (s.mat == ${MAT.BRASS}u || s.mat == ${MAT.WHEEL}u) {
    // polished brass, a little uneven
    s.color = s.color * (0.9 + 0.15 * noise2(s.uv * 37.0));
  } else if (s.mat == ${MAT.DIAL}u) {
    // a clock's dial: uv 0..1 across it.  Minute ticks, hour batons and a
    // double ring; tag 1 is a dark dial with gold marks, 2 a seconds ring (60 ticks only)
    let q = s.uv - 0.5;
    let r = length(q) * 2.0;
    let a = atan2(q.x, q.y) / TAU;
    let aw = max(length(fu) / (TAU * max(length(q), 0.01)), 1e-4);
    let mins = (1.0 - smoothstep(0.0, aw * 60.0 + 0.02, abs(fract(a * 60.0 + 0.5) - 0.5))) * step(0.84, r) * step(r, 0.9);
    let hrs = (1.0 - smoothstep(0.0, aw * 12.0 + 0.003, abs(fract(a * 12.0 + 0.5) - 0.5) - 0.012)) * step(0.66, r) * step(r, 0.9);
    let ring = max(step(abs(r - 0.905), 0.006), step(abs(r - 0.835), 0.004));
    var ink = max(mins, ring);
    if (s.tag != 2u) { ink = max(ink, hrs); }
    let inkCol = select(vec3f(0.03, 0.025, 0.02), vec3f(0.85, 0.65, 0.25), s.tag == 1u);
    s.color = mix(s.color, inkCol, ink);
    s.gloss = mix(s.gloss, 0.5, ink * f32(s.tag == 1u));
    if (s.tag < 2u) {
      // the hour hand, painted: 4 o'clock at t = 0, and on from there for ever
      // (tag 2 is a seconds dial, 3 a clock that has stopped)
      let ha = fract((4.0 + s.t / 3600.0) / 12.0) * TAU;
      let along = q.x * sin(ha) + q.y * cos(ha);
      let across = q.x * cos(ha) - q.y * sin(ha);
      let w = mix(0.024, 0.007, saturate(along / 0.27));
      let aa = length(fu) * 0.7 + 1e-4;
      var hand = step(-0.06, along) * (1.0 - smoothstep(0.27 - aa, 0.27 + aa, along)) * (1.0 - smoothstep(w - aa, w + aa, abs(across)));
      hand = max(hand, 1.0 - smoothstep(0.03 - aa, 0.03 + aa, length(q)));
      s.color = mix(s.color, select(vec3f(0.05, 0.07, 0.16), vec3f(0.85, 0.65, 0.25), s.tag == 1u), hand);
      s.gloss = mix(s.gloss, 0.75, hand);
    }
  } else if (s.mat == ${MAT.FLAME}u) {
    // Flames, in layers drawn as added light (tag 0 the outer, deep orange
    // one, 1 a yellow one inside it, 2 the pale core, 3 a candle's): uv.y runs
    // up the flame.  Soft at the edges (where the surface turns away from the
    // eye) and fading out towards the tips, flickering a little.
    let v = s.uv.y;
    let face = abs(dot(s.n, s.view));
    let soft = smoothstep(0.05, 0.75, face) * (1.0 - smoothstep(0.45, 1.0, v)) * smoothstep(0.0, 0.08, v);
    let flick = 0.8 + 0.2 * noise2(vec2f(s.t * 4.0 + s.pos.x * 23.0, f32(s.tag) * 5.0 + s.pos.y * 11.0));
    var col = mix(vec3f(1.0, 0.88, 0.6), vec3f(1.0, 0.45, 0.08), smoothstep(0.35, 0.95, v));
    var e = 1.3;
    if (s.tag == 0u) { col = mix(vec3f(1.0, 0.36, 0.05), vec3f(0.6, 0.08, 0.01), smoothstep(0.25, 0.9, v)); e = 0.9; }
    else if (s.tag == 1u) { col = mix(vec3f(1.0, 0.68, 0.22), vec3f(1.0, 0.32, 0.04), smoothstep(0.2, 0.85, v)); e = 0.75; }
    else if (s.tag == 2u) { col = mix(vec3f(1.0, 0.9, 0.7), vec3f(1.0, 0.62, 0.25), smoothstep(0.1, 0.8, v)); e = 0.6; }
    s.color = col;
    s.emissive = e * soft * flick;
  } else if (s.mat == ${MAT.EMBER}u) {
    // the bed of embers: glowing patches that wax and wane under a dark crust
    let n1 = noise2(s.pos.xy * 40.0 + vec2f(s.t * 0.7, -s.t * 0.4));
    let n2 = noise2(s.pos.xy * 95.0 - vec2f(s.t * 1.3, s.t * 0.9));
    let g = smoothstep(0.15, 0.9, n1 * 0.6 + n2 * 0.4);
    s.color = mix(vec3f(0.5, 0.06, 0.01), vec3f(1.0, 0.5, 0.1), g);
    s.emissive = 0.4 + 1.8 * g;
  } else if (s.mat == ${MAT.LOG}u) {
    // charred logs, glowing in their cracks underneath
    let below = saturate(0.6 - s.n.z * 0.8) * saturate(1.4 - (s.pos.z - 0.04) * 8.0);
    let crack = smoothstep(0.5, 0.8, noise2(s.uv * vec2f(9.0, 40.0) + vec2f(s.t * 0.15, 0.0)));
    let pulse = 0.75 + 0.25 * sin(s.t * 2.3 + s.pos.x * 30.0);
    s.color = mix(vec3f(0.05, 0.035, 0.03), vec3f(1.0, 0.32, 0.05), crack * below);
    s.emissive = crack * below * 2.0 * pulse;
  } else if (s.mat == ${MAT.BEAM}u) {
    // the sunbeam's haze: only inside the beam, and stirring slowly
    let h = noise3(p * 6.0 + vec3f(0.0, 0.0, s.t * 0.05));
    s.emissive = s.emissive * inBeam(p) * (0.5 + h);
  } else if (s.mat == ${MAT.MOTE}u) {
    // a speck of dust: it shows only where the sun catches it
    s.emissive = s.emissive * inBeam(p);
  } else if (s.mat == ${MAT.BOOK}u) {
    // book spines: each its own colour (from where it stands), with bands near the ends
    let h = hash11(floor(p.x * 37.0) + floor(p.y * 37.0) * 7.0);
    s.color = mix(vec3f(0.35, 0.08, 0.06), mix(vec3f(0.1, 0.2, 0.12), vec3f(0.12, 0.12, 0.25), step(0.5, h)), step(0.33, h));
    s.color = s.color * (0.6 + 0.6 * hash11(h * 91.0));
    let band = step(abs(abs(s.uv.y - 0.5) - 0.38), 0.025);
    s.color = mix(s.color, vec3f(0.7, 0.55, 0.2), band);
  } else if (s.mat == ${MAT.RUG}u) {
    // a worn red rug with a border
    let q = abs(s.uv - 0.5) * 2.0;
    let border = step(0.86, max(q.x, q.y)) * step(max(q.x, q.y), 0.94);
    let pat = step(0.5, fract((q.x + q.y) * 6.0));
    s.color = mix(mix(vec3f(0.32, 0.06, 0.05), vec3f(0.42, 0.12, 0.06), pat * step(max(q.x, q.y), 0.8)), vec3f(0.6, 0.45, 0.2), border);
    s.color = s.color * (0.85 + 0.2 * noise2(s.uv * 200.0));
    s.ambient = s.ambient * floorFeet(p.xy);
  } else if (s.mat == ${MAT.DRAWING}u) {
    // A drawing of an anchor escapement, framed: the escape wheel with its
    // hooked teeth, its pitch circle dashed, its rim, spokes and hub, the
    // anchor over it, centre lines, a border and a title block; brown ink on
    // paper gone yellow at the edges and spotted with age.
    let q = (s.uv - vec2f(0.5, 0.47)) * vec2f(0.34, 0.46);
    let px = length(fu * vec2f(0.34, 0.46)) + 1e-5;
    let r = length(q);
    let a = atan2(q.y, q.x);
    let t = fract(a * 30.0 / TAU);
    var d = abs(r - (0.085 + 0.025 * t)) * 0.7;
    d = min(d, min(t, 1.0 - t) * TAU / 30.0 * r + max(0.0, max(0.085 - r, r - 0.11)));
    d = min(d, min(abs(r - 0.07), min(abs(r - 0.016), abs(r - 0.005))));
    d = min(d, abs(min(abs(q.x), abs(q.y)) - 0.006) + max(0.0, max(0.016 - r, r - 0.07)));
    d = min(d, abs(r - 0.098) + step(0.6, fract(a * 40.0 / TAU)));
    let pv = vec2f(0.0, 0.16);
    for (var k = -1.0; k < 2.0; k += 2.0) {
      let pal = vec2f(k * 0.0556, 0.089);
      d = min(d, abs(sdSegment(q, pv, pal) - 0.004));
      d = min(d, abs(length(q - pal) - 0.006));
    }
    d = min(d, abs(length(q - pv) - 0.01));
    d = min(d, max(abs(q.x), 0.0) + step(0.55, fract(q.y * 40.0)) + step(0.17, abs(q.y - 0.03)));
    d = min(d, abs(q.y) + step(0.55, fract(q.x * 40.0)) + step(0.14, abs(q.x)));
    let bu = min(min(s.uv.x, 1.0 - s.uv.x), min(s.uv.y, 1.0 - s.uv.y));
    d = min(d, abs(bu - 0.04) * 0.34);
    d = min(d, abs(s.uv.y - 0.12) * 0.46 + step(0.0, 0.04 - min(s.uv.x, 1.0 - s.uv.x)));
    let ink = 1.0 - smoothstep(0.0004, 0.0004 + px, d);
    let txt = step(0.45, noise2(vec2f(s.uv.x * 90.0, floor(s.uv.y * 40.0) * 7.0))) * step(abs(fract(s.uv.y * 40.0) - 0.5), 0.22)
      * step(0.05, s.uv.y) * step(s.uv.y, 0.105) * step(0.3, s.uv.x) * step(s.uv.x, 0.9);
    let paper = vec3f(0.86, 0.80, 0.66) * (0.92 + 0.1 * fbm2(s.uv * 9.0)) * (1.0 - 0.18 * smoothstep(0.3, 0.0, bu)) * (1.0 - 0.15 * smoothstep(0.62, 0.8, fbm2(s.uv * 23.0)));
    s.color = mix(paper, vec3f(0.22, 0.13, 0.08), max(ink, txt * 0.6));
  } else if (s.mat == ${MAT.FUR}u) {
    // fur: tabby stripes across the cat's back and tail (tag 1), and a soft
    // sheen where the surface turns away from the eye
    // (tag 1: a sphere, its uv.x going round it, the stripes across its top;
    // tag 2: a tube, its uv.y going along it)
    let along = select(s.uv.y * 44.0, s.uv.x * 36.0, s.tag == 1u);
    let top = select(smoothstep(-0.2, 0.5, cos(s.uv.x * TAU)), smoothstep(0.25, 0.55, s.uv.y), s.tag == 1u);
    let stripe = smoothstep(0.25, 0.75, sin(along + noise2(s.uv * vec2f(7.0, 9.0)) * 3.0) * 0.5 + 0.5) * top;
    s.color = s.color * mix(1.0, 0.6, stripe * f32(s.tag != 0u));
    let rim = 1.0 - abs(dot(s.n, s.view));
    s.color = s.color * (1.0 + 0.6 * rim * rim);
    s.gloss = 0.05;
  } else if (s.mat == ${MAT.LAMP}u) {
    s.emissive = 6.0;
  }
  return s;
}
`;

// ---------------------------------------------------------------- helpers

// A matrix that puts a model built facing +Z (x right, y up) at `pos`, with
// its x along `right` and its y along `up`.
const place = (pos, right = [1, 0, 0], up = [0, 0, 1]) => m4.fromBasis(right, up, v3.cross(right, up), pos);
// facing the room from the back wall (towards -Y), from the right wall (-X), from the left wall (+X), from the front wall (+Y)
const FACE = { back: [[1, 0, 0], [0, 0, 1]], right: [[0, -1, 0], [0, 0, 1]], left: [[0, 1, 0], [0, 0, 1]], front: [[-1, 0, 0], [0, 0, 1]] };
const onWall = (wall, pos) => place(pos, ...FACE[wall]);

// A toothed wheel (or a pinion) in the XY plane, turning about Z, its faces at
// z = +-w/2.  `tooth` is one tooth's outline from base to base as
// [position in pitches, height 0 at the root .. 1 at the tip].  The faces are
// in rings from the bore out to the root, three points to a pitch, so that
// no triangle reaches far: a wheel turning between poses folds by a quarter
// of its triangles' reach times the angle.
const SPUR = [[-0.3, 0], [-0.2, 0.55], [-0.12, 1], [0.12, 1], [0.2, 0.55], [0.3, 0]];
const SPUR_SMALL = [[-0.3, 0], [-0.12, 1], [0.12, 1], [0.3, 0]];
const LEAF = [[-0.26, 0], [-0.16, 0.8], [-0.05, 1], [0.05, 1], [0.16, 0.8], [0.26, 0]]; // a pinion's rounded leaves
const ESCAPE = [[-0.42, 0], [-0.1, 0.62], [0.0, 1], [0.06, 0]];            // the escape wheel's hooked teeth

function wheel(N, rf, ra, { tooth = SPUR, w = 0.0016, bore = 0.0012, rings = 0, spokes = 0, rim = 0.78, color = COL.brass, gloss = 0.55, mat = MAT.WHEEL } = {}) {
  const g = new Geo();
  const pitch = TAU / N;
  const pa = tooth[0][0], pb = tooth[tooth.length - 1][0];
  const nr = rings || Math.max(1, Math.ceil((rf - bore) / 0.008));
  // the body's points round each ring: where a tooth starts and ends, and the middle of the gap
  const ang = [];
  for (let k = 0; k < N; k++) ang.push((k + pa) * pitch, (k + pb) * pitch, (k + (pb + pa + 1) / 2) * pitch);
  const M = ang.length;
  const uvOf = (x, y) => [0.5 + 0.5 * x / ra, 0.5 + 0.5 * y / ra];
  const toothPt = (k, [psi, f]) => {
    const a = (k + psi) * pitch, r = rf + (ra - rf) * f;
    return [r * Math.cos(a), r * Math.sin(a)];
  };
  for (const side of [1, -1]) {
    const z = side * w / 2;
    // the inner rings have a point to a pitch; the outermost, at the root, three
    const rows = [];
    for (let j = 0; j <= nr; j++) {
      const r = bore + (rf - bore) * j / nr;
      const row = [];
      for (let i = 0; i < M; i += j === nr ? 1 : 3) {
        const x = r * Math.cos(ang[i]), y = r * Math.sin(ang[i]);
        row.push(g.vert(x, y, z, 0, 0, side, ...uvOf(x, y)));
      }
      rows.push(row);
    }
    for (let j = 0; j < nr - 1; j++) for (let i = 0; i < N; i++) g.quadIdx(rows[j][i], rows[j][(i + 1) % N], rows[j + 1][(i + 1) % N], rows[j + 1][i]);
    {
      const I = rows[nr - 1], O = rows[nr];
      for (let k = 0; k < N; k++) {
        const i0 = I[k], i1 = I[(k + 1) % N], o0 = O[3 * k], o1 = O[3 * k + 1], o2 = O[3 * k + 2], o3 = O[(3 * k + 3) % M];
        g.tri(i0, o0, o1); g.tri(i0, o1, o2); g.tri(i0, o2, i1); g.tri(i1, o2, o3);
      }
    }
    // the teeth, each a strip from its two base corners up to its tip
    for (let k = 0; k < N; k++) {
      const pts = tooth.map((tp) => toothPt(k, tp));
      const ids = pts.map(([x, y], q) => (q === 0 ? rows[nr][3 * k] : q === pts.length - 1 ? rows[nr][3 * k + 1] : g.vert(x, y, z, 0, 0, side, ...uvOf(x, y))));
      let lo = 0, hi = ids.length - 1;
      while (hi - lo > 1) {
        g.tri(ids[lo], ids[lo + 1], ids[hi]);
        if (hi - lo > 2) g.tri(ids[lo + 1], ids[hi - 1], ids[hi]);
        lo++; hi--;
      }
    }
  }
  // the edge all round: tooth flanks and tips, flat, and the root between them
  const edge = [];
  for (let k = 0; k < N; k++) {
    for (const tp of tooth) edge.push(toothPt(k, tp));
    const a = (k + (pb + pa + 1) / 2) * pitch;
    edge.push([rf * Math.cos(a), rf * Math.sin(a)]);
  }
  for (let i = 0; i < edge.length; i++) {
    const [x0, y0] = edge[i], [x1, y1] = edge[(i + 1) % edge.length];
    const l = Math.hypot(x1 - x0, y1 - y0);
    if (l < 1e-7) continue;
    const nx = (y1 - y0) / l, ny = -(x1 - x0) / l;
    const a = g.vert(x0, y0, -w / 2, nx, ny, 0, ...uvOf(x0, y0)), b = g.vert(x1, y1, -w / 2, nx, ny, 0, ...uvOf(x1, y1));
    const c = g.vert(x1, y1, w / 2, nx, ny, 0, ...uvOf(x1, y1)), d = g.vert(x0, y0, w / 2, nx, ny, 0, ...uvOf(x0, y0));
    g.quadIdx(a, b, c, d);
  }
  // the bore
  if (bore > 0) {
    const s = Math.max(8, Math.min(M, 24));
    for (let i = 0; i < s; i++) {
      const a0 = i * TAU / s, a1 = (i + 1) * TAU / s;
      const p0 = [bore * Math.cos(a0), bore * Math.sin(a0)], p1 = [bore * Math.cos(a1), bore * Math.sin(a1)];
      const a = g.vert(p0[0], p0[1], -w / 2, -Math.cos(a0), -Math.sin(a0), 0), b = g.vert(p1[0], p1[1], -w / 2, -Math.cos(a1), -Math.sin(a1), 0);
      const c = g.vert(p1[0], p1[1], w / 2, -Math.cos(a1), -Math.sin(a1), 0), d = g.vert(p0[0], p0[1], w / 2, -Math.cos(a0), -Math.sin(a0), 0);
      g.quadIdx(a, b, c, d);
    }
  }
  g.orientByNormals().color(color).gloss(gloss).mat(mat);
  if (spokes) g.aux(rim * rf / ra).tag(spokes).cutout();
  return g;
}
// A wheel's stand-in in the shadow maps, for a wheel that casts its shadow
// at many poses a second: a thin disc in its middle plane, hidden inside it,
// with the same windows between the spokes but only simple pointed teeth
// (none where the teeth are smaller than a pixel of the shadow map), a fifth
// of the triangles.  The wheel itself then casts no shadow.  (A little inside
// the root circle, so as not to show between the teeth; `rim` is made up for
// that, so that the windows come out the same.)
function shadowProxy(N, rf, ra, { teeth = true, spokes = 0, rim = 0.78 } = {}) {
  return wheel(N, rf * 0.97, ra, { tooth: teeth ? [[-0.3, 0], [-0.03, 0.8], [0.03, 0]] : [[-0.5, 0], [0.5, 0]], w: 0.0004, bore: 0.0004, rings: 1, spokes, rim: rim / 0.97 });
}
// a spur wheel by its tooth count and module (the pitch radius is m N / 2)
const spur = (N, m, o = {}) => wheel(N, m * N / 2 - 1.25 * m, m * N / 2 + m, { tooth: N > 30 && m >= 0.0008 ? SPUR : SPUR_SMALL, ...o });
const pinion = (N, m, o = {}) => wheel(N, m * N / 2 - 1.1 * m, m * N / 2 + 0.9 * m, { tooth: LEAF, bore: 0.0008, ...o });

// A flat hand pointing along +Y in the XY plane, from -tail to len, `width(y)`
// across, `d` thick (z from 0 to d), in pieces of `step` along its length.
function blade(len, tail, width, { d = 0.0008, step = 0.008, color = COL.blued, gloss = 0.7, mat = MAT.BLUED } = {}) {
  const g = new Geo();
  const n = Math.max(2, Math.ceil((len + tail) / step));
  const ys = Array.from({ length: n + 1 }, (_, i) => -tail + (len + tail) * i / n);
  for (const [z, nz] of [[d, 1], [0, -1]]) {
    const row = ys.map((y) => { const hw = width(y) / 2; return [g.vert(-hw, y, z, 0, 0, nz, 0, (y + tail) / (len + tail)), g.vert(hw, y, z, 0, 0, nz, 1, (y + tail) / (len + tail))]; });
    for (let i = 0; i < n; i++) g.quadIdx(row[i][0], row[i][1], row[i + 1][1], row[i + 1][0]);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const y0 = ys[i], y1 = ys[i + 1], x0 = sx * width(y0) / 2, x1 = sx * width(y1) / 2;
      const a = g.vert(x0, y0, 0, sx, 0, 0), b = g.vert(x1, y1, 0, sx, 0, 0), c = g.vert(x1, y1, d, sx, 0, 0), e = g.vert(x0, y0, d, sx, 0, 0);
      g.quadIdx(a, b, c, e);
    }
  }
  for (const [y, ny] of [[len, 1], [-tail, -1]]) {
    const hw = width(y) / 2;
    if (hw < 1e-5) continue;
    g.quadIdx(g.vert(-hw, y, 0, 0, ny, 0), g.vert(hw, y, 0, 0, ny, 0), g.vert(hw, y, d, 0, ny, 0), g.vert(-hw, y, d, 0, ny, 0));
  }
  return g.orientByNormals().color(color).gloss(gloss).mat(mat);
}

// A rod (wire, string, pendulum rod) along a polyline, cut into pieces no
// longer than `step`.
function rod(points, r, { seg = 6, step = 0.01, caps = false } = {}) {
  const pts = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], n = Math.max(1, Math.ceil(v3.dist(a, b) / step));
    for (let k = 1; k <= n; k++) pts.push(v3.lerp(a, b, k / n));
  }
  return Geo.tube(pts, r, seg, { caps });
}

// A long rod (a pendulum's, say) from a to c as n rods of its own, to be given
// the same movement one by one.  Which steps of a movement are drawn goes by a
// box round each mesh's own movement, and a view tilted up crosses a rod's
// height over many seconds (a metre is 12 s at 75 degrees): in pieces, each
// is drawn for the seconds the slice crosses that piece, and not the whole rod
// for all of them.
const rodParts = (a, c, n, r, o) => Array.from({ length: n }, (_, k) => rod([v3.lerp(a, c, k / n), v3.lerp(a, c, (k + 1) / n)], r, o));

// Moving things.  Everything here stays where it is and only has its own
// movement, so its carrier is the whole period in one stretch.
// Whatever the sun cannot reach casts no shadow either: it is left out of the
// shadow map, which saves drawing it there at every step of its movement.
function cyc(b, geo, at, period, keys, xf, o = {}) {
  const lit = o.shadow ?? sunlit([at[12], at[13], at[14]], o.reach ?? 0.15);
  b.dynamic(lit ? geo : unshadowed(geo), { times: [0, P], transform: () => at, caps: 'none', within: o.within, cycle: { period, keys, start: o.start ?? 0, transform: xf } });
}
const shadeless = new Map();
const unshadowed = (g) => { if (!shadeless.has(g)) shadeless.set(g, g.clone().noShadow()); return shadeless.get(g); };
// can the sun through the window reach within `m` of this point?
function sunlit(p, m) {
  const s = (-RX - p[0]) / SUN[0];
  if (s < -m) return false;
  const y = p[1] + SUN[1] * s, z = p[2] + SUN[2] * s;
  return y > WIN.y0 - m && y < WIN.y1 + m && z > WIN.z0 - m && z < WIN.z1 + m;
}

// ---- clockwork timing
// An anchor escapement: per beat the escape wheel moves on half a tooth.  Its
// angle at the poses of one beat (8 poses), in half-teeth: the impulse just
// before and after the pendulum passes the middle (pose 0), the drop (pose 1
// to 2), and the recoil while the pendulum swings out and back.
const BEAT_POSES = 8;
const BEAT = Array.from({ length: BEAT_POSES }, (_, j) => (j === 0 ? 0.15 : j === 1 ? 0.3 : 1 - 0.13 * Math.sin(Math.PI * (j - 2) / 6.5)));
// where the escape wheel stands, in half-teeth, at pose i of an endless row of them
const escPose = (i) => Math.floor(i / BEAT_POSES) + BEAT[((i % BEAT_POSES) + BEAT_POSES) % BEAT_POSES];

// a ticking hand: it jumps on at each whole second, overshoots and settles (10 poses to the second)
const TICK = [0, 1.1, 0.96, 1.015, 1, 1, 1, 1, 1, 1];
const tickPose = (i) => Math.floor(i / 10) + TICK[i % 10];

// ---------------------------------------------------------------- the room

function room(b) {
  // the floor, in small enough pieces for the tilt to stretch
  b.static(Geo.plane(2 * RX, 2 * RY, 24, 19).color('#8a6a48').mat(MAT.FLOOR));
  // walls: boxes, thick, overlapping at the corners so that no light leaks in
  const wall = new Geo();
  const boxAt = (x0, x1, y0, y1, z0, z1) => Geo.box(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  wall.add(boxAt(-RX - 0.3, RX + 0.3, RY, RY + 0.3, -0.1, RZ + 0.3));            // back
  wall.add(boxAt(-RX - 0.3, RX + 0.3, -RY - 0.3, -RY, -0.1, RZ + 0.3));          // front
  wall.add(boxAt(RX, RX + 0.3, -RY, RY, -0.1, RZ + 0.3));                        // right
  // left, round the window
  wall.add(boxAt(-RX - 0.35, -RX, -RY, RY, -0.1, WIN.z0));
  wall.add(boxAt(-RX - 0.35, -RX, -RY, RY, WIN.z1, RZ + 0.3));
  wall.add(boxAt(-RX - 0.35, -RX, -RY, WIN.y0, WIN.z0, WIN.z1));
  wall.add(boxAt(-RX - 0.35, -RX, WIN.y1, RY, WIN.z0, WIN.z1));
  wall.add(boxAt(-RX - 0.3, RX + 0.3, -RY - 0.3, RY + 0.3, RZ, RZ + 0.2));      // ceiling
  // cut into smaller faces for the tilt
  b.static(subdivide(wall, 0.6).color(COL.plaster).mat(MAT.PLASTER));
  // ceiling beams, skirting, a dado rail
  const wood = new Geo();
  for (let x = -1.8; x <= 1.85; x += 0.9) wood.add(boxAt(x - 0.07, x + 0.07, -RY, RY, RZ - 0.16, RZ));
  wood.add(boxAt(-RX, RX, RY - 0.025, RY, 0, 0.14));
  wood.add(boxAt(-RX, RX, -RY, -RY + 0.025, 0, 0.14));
  wood.add(boxAt(RX - 0.025, RX, -RY, RY, 0, 0.14));
  wood.add(boxAt(-RX, -RX + 0.025, -RY, RY, 0, 0.14));
  b.static(subdivide(wood, 0.6).color(COL.oakDark).mat(MAT.WOOD), { solid: false });

  // the window: a deep reveal, a sill, two casements of six panes each
  {
    const win = new Geo(), X = -RX - 0.12;
    win.add(boxAt(-RX - 0.05, -RX + 0.06, WIN.y0 - 0.02, WIN.y1 + 0.02, WIN.z0 - 0.04, WIN.z0));   // the sill
    const bar = 0.022, frameW = 0.045;
    const ys = [WIN.y0, (WIN.y0 + WIN.y1) / 2, WIN.y1];
    for (const y of ys) win.add(boxAt(X - 0.02, X + 0.02, y - frameW / 2, y + frameW / 2, WIN.z0, WIN.z1));
    for (const z of [WIN.z0 + frameW / 2, WIN.z1 - frameW / 2]) win.add(boxAt(X - 0.02, X + 0.02, WIN.y0, WIN.y1, z - frameW / 2, z + frameW / 2));
    // glazing bars: two across each casement, one up the middle of each
    for (let k = 1; k < 3; k++) {
      const z = WIN.z0 + (WIN.z1 - WIN.z0) * k / 3;
      win.add(boxAt(X - 0.012, X + 0.012, WIN.y0, WIN.y1, z - bar / 2, z + bar / 2));
    }
    for (let c = 0; c < 2; c++) {
      const y = WIN.y0 + (WIN.y1 - WIN.y0) * (c + 0.5) / 2;
      win.add(boxAt(X - 0.012, X + 0.012, y - bar / 2, y + bar / 2, WIN.z0, WIN.z1));
    }
    b.static(win.color('#e8e2d2').gloss(0.3), { solid: false });
    // the glass, faintly there
    b.static(Geo.plane(WIN.y1 - WIN.y0, WIN.z1 - WIN.z0).rotateY(Math.PI / 2).translate(X, (WIN.y0 + WIN.y1) / 2, (WIN.z0 + WIN.z1) / 2).doubleSided().color('#dfe8e4').gloss(0.9).blend(0.06), { solid: false });
  }
}

// Cuts every triangle of a mesh in two along its longest edge until no edge is
// longer than `max`: big static faces stay well-behaved when the tilt stretches them.
function subdivide(g, max) {
  const out = new Geo();
  // (colour, material and the spare values go with each corner; a new point takes the first corner's)
  const copy = (src, s, d) => {
    for (let k = 0; k < 3; k++) out.c[d * 3 + k] = src.c[s * 3 + k];
    for (let k = 0; k < 4; k++) out.a[d * 4 + k] = src.a[s * 4 + k];
    for (let k = 0; k < 2; k++) out.x[d * 2 + k] = src.x[s * 2 + k] || 0;
    return d;
  };
  const vert = (src, s) => copy(src, s, out.vert(src.p[s * 3], src.p[s * 3 + 1], src.p[s * 3 + 2], src.n[s * 3], src.n[s * 3 + 1], src.n[s * 3 + 2], src.uv[s * 2], src.uv[s * 2 + 1]));
  const mid = (a, b) => {
    const p = v3.lerp([out.p[a * 3], out.p[a * 3 + 1], out.p[a * 3 + 2]], [out.p[b * 3], out.p[b * 3 + 1], out.p[b * 3 + 2]], 0.5);
    const n = [out.n[a * 3], out.n[a * 3 + 1], out.n[a * 3 + 2]];
    return copy(out, a, out.vert(p[0], p[1], p[2], n[0], n[1], n[2], (out.uv[a * 2] + out.uv[b * 2]) / 2, (out.uv[a * 2 + 1] + out.uv[b * 2 + 1]) / 2));
  };
  const len = (a, b) => Math.hypot(out.p[a * 3] - out.p[b * 3], out.p[a * 3 + 1] - out.p[b * 3 + 1], out.p[a * 3 + 2] - out.p[b * 3 + 2]);
  const split = (a, b, c, depth) => {
    const ab = len(a, b), bc = len(b, c), ca = len(c, a), m = Math.max(ab, bc, ca);
    if (m <= max || depth > 12) { out.tri(a, b, c); return; }
    if (m === ab) { const d = mid(a, b); split(a, d, c, depth + 1); split(d, b, c, depth + 1); }
    else if (m === bc) { const d = mid(b, c); split(a, b, d, depth + 1); split(a, d, c, depth + 1); }
    else { const d = mid(c, a); split(a, b, d, depth + 1); split(d, b, c, depth + 1); }
  };
  const map = new Map();
  for (let i = 0; i < g.idx.length; i += 3) {
    const ids = [0, 1, 2].map((k) => { const s = g.idx[i + k]; if (!map.has(s)) map.set(s, vert(g, s)); return map.get(s); });
    split(ids[0], ids[1], ids[2], 0);
  }
  return out;
}

// ---------------------------------------------------------------- clocks

// A wall clock's dial, bezel and case (static), and its hands (moving): an
// hour hand, a minute hand and a seconds hand, which ticks or sweeps.
// `at` places it facing +Z.  Seconds read t mod 60; the clock reads 4 o'clock at t = 0.
function wallClock(b, at, { r = 0.12, caseCol = COL.walnut, depth = 0.06, ...o } = {}) {
  b.static(Geo.lathe([[0, 0], [r * 1.1, 0], [r * 1.16, 0.006], [r * 1.18, depth * 0.3], [r * 1.16, depth * 0.7], [r * 1.12, depth], [0, depth]], 128).translate(0, 0, -depth).color(caseCol).gloss(0.5).mat(MAT.WOOD), { transform: at, solid: false });
  wallClockFace(b, at, { r, ...o });
}
function wallClockFace(b, at, { r = 0.12, dial = 0, tick = true, seconds = true, bezel = true } = {}) {
  const g = new Geo();
  if (bezel) g.add(Geo.torus(r * 1.04, r * 0.06, 128, 12).translate(0, 0, 0.004).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  g.add(Geo.disc(r, 128).translate(0, 0, 0.001).color(dial === 1 ? '#1b1712' : COL.enamel).gloss(0.35).mat(MAT.DIAL).tag(dial));
  g.add(Geo.cylinder(0.004, 0.012, 12).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  b.static(g, { transform: at, solid: false });
  const handCol = dial === 1 ? COL.brass : COL.blued, handMat = dial === 1 ? MAT.BRASS : MAT.BLUED;
  const minHand = blade(r * 0.82, r * 0.15, (y) => (y < 0 ? 0.009 * r / 0.12 : Math.max(0.0012, (0.008 - 0.008 * y / r) * r / 0.12)), { color: handCol, mat: handMat });
  const secHand = blade(r * 0.86, r * 0.25, (y) => (y < -0.15 * r ? 0.006 * r / 0.12 : 0.0016 * r / 0.12), { color: '#9e2a1c', mat: MAT.PAINT, d: 0.0006 });
  const lift = (z) => m4.mul(at, m4.translation(0, 0, z));
  // the hour hand: 4 o'clock at t = 0, half a degree a minute; keyed every two minutes
  // (the hour hand is painted on the dial by the shader, from the time at
  // which the dial is seen: so it goes on round for ever, where a moving hand
  // would have to jump back an hour each time the scene's hour comes round)
  // the minute hand, smoothly round in the hour: a pose every 3 degrees
  cyc(b, minHand, lift(0.0045), 3600, 120, (u) => m4.rotationZ(-u * TAU));
  // the seconds hand
  if (!seconds) return;
  if (tick) cyc(b, secHand, lift(0.006), 60, 600, (u) => m4.rotationZ(-tickPose(Math.round(u * 600)) * TAU / 60));
  else cyc(b, secHand, lift(0.006), 60, 90, (u) => m4.rotationZ(-u * TAU));
}

// A skeleton clock under the sun on the bench: an anchor escapement with a
// pendulum beating half-seconds, and its train in the open, every wheel
// meshing with the next and turning as their teeth say.
//   escape wheel  30 teeth, half a tooth a beat: once round in 30 s
//   escape pinion 24  <- fourth wheel 48: once round in 60 s, with the seconds hand
//   fourth pinion  8  <- third wheel 60: 450 s
//   third pinion   8  <- centre wheel 64: an hour, with the minute hand
function skeletonClock(b, base) {
  const m = 0.0007; // module of the train
  const at = (x, y, z) => m4.mul(base, m4.translation(x, y, z));
  const Tp = 1.0, Tb = Tp / 2, amp = 0.075; // the pendulum: one second there and back
  const L = lengthFor(Tp);
  // where the arbors are, in the clock's frame (x right, y up, z towards the viewer)
  const step = (from, d, a) => [from[0] + d * Math.cos(a), from[1] + d * Math.sin(a)];
  const cen = [0, 0.235];
  const third = step(cen, m * (64 + 8) / 2, 0.95);
  const fourth = step(third, m * (60 + 8) / 2, 2.3);
  const esc = step(fourth, m * (48 + 24) / 2, 1.15);
  const anchorAt = [esc[0], esc[1] + 0.0285];
  // the frame: two brass plates fretted down to bars, pillars, a wooden base
  const frame = new Geo();
  frame.add(Geo.box(0.26, 0.03, 0.13).translate(0, 0.015, 0).color(COL.walnut).mat(MAT.WOOD));
  frame.add(Geo.box(0.23, 0.012, 0.10).translate(0, 0.036, 0).color(COL.walnut).mat(MAT.WOOD));
  const top = anchorAt[1] + 0.012;
  const plate = (z) => {
    const pg = new Geo();
    const bar = (p0, p1, wd) => { const d = v3.sub(p1, p0), l = v3.len(d); pg.add(Geo.box(wd, l, 0.002).rotateZ(-Math.atan2(d[0], d[1])).translate((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, z)); };
    pg.add(Geo.torus(0.07, 0.004, 64, 6).scale(1, 1, 0.25).translate(cen[0], cen[1], z));
    bar([-0.085, 0.042, 0], [-0.035, top, 0], 0.008);
    bar([0.085, 0.042, 0], [0.035, top, 0], 0.008);
    bar([-0.04, top, 0], [0.04, top, 0], 0.008);
    bar([-0.095, 0.042, 0], [0.095, 0.042, 0], 0.01);
    for (const p of [third, fourth, esc]) bar([cen[0], cen[1], 0], [p[0], p[1], 0], 0.005);
    bar([esc[0], esc[1], 0], [anchorAt[0], top, 0], 0.005);
    return pg;
  };
  frame.add(plate(0.012).color(COL.brass).gloss(0.7).mat(MAT.BRASS));
  frame.add(plate(-0.012).color(COL.brass).gloss(0.7).mat(MAT.BRASS));
  for (const x of [-0.085, 0.085]) frame.add(Geo.cylinder(0.004, 0.026, 10).translate(0, 0, -0.013).translate(x, 0.046, 0).color(COL.brass).mat(MAT.BRASS));
  // arbors (a round rod turning about itself looks the same at any angle: they can stand still)
  for (const p of [cen, third, fourth, esc, anchorAt]) frame.add(Geo.cylinder(0.0011, 0.04, 8).translate(p[0], p[1], -0.02).color(COL.steel).gloss(0.8).mat(MAT.STEEL));
  // the chapter ring, and a little seconds ring round the fourth arbor
  frame.add(annulus(0.05, 0.066, 96).translate(cen[0], cen[1], 0.016).color(COL.enamel).gloss(0.35).mat(MAT.DIAL));
  frame.add(annulus(0.012, 0.016, 48).translate(fourth[0], fourth[1], 0.0165).color(COL.enamel).gloss(0.35).mat(MAT.DIAL).tag(2));
  b.static(frame, { transform: base, solid: false });

  // the wheels, each with its pinion on the same arbor behind it
  const escWheel = Geo.merge(wheel(30, 0.0165, 0.0215, { tooth: ESCAPE, spokes: 4, rim: 0.82, w: 0.0012 }), pinion(24, m, { w: 0.002, tooth: SPUR_SMALL }).translate(0, 0, -0.004));
  const fourthWheel = Geo.merge(spur(48, m, { spokes: 4 }), pinion(8, m, { w: 0.0025 }).translate(0, 0, -0.005));
  const thirdWheel = Geo.merge(spur(60, m, { spokes: 4 }), pinion(8, m, { w: 0.0025 }).translate(0, 0, -0.005));
  const centreWheel = spur(64, m, { spokes: 5 });
  // Their phases, so that the teeth of each wheel sit in the gaps of the
  // pinion it drives: a wheel of Na teeth whose tooth 0 is at angle alpha
  // puts the pinion's (Nb leaves) tooth 0 at this angle.
  const dirTo = (a, c) => Math.atan2(c[1] - a[1], c[0] - a[0]);
  const meshed = (alpha, pa, Na, pb, Nb) => dirTo(pb, pa) - (alpha - dirTo(pa, pb)) * Na / Nb + Math.PI / Nb;
  const ph3 = meshed(0, cen, 64, third, 8), ph4 = meshed(ph3, third, 60, fourth, 8), phE = meshed(ph4, fourth, 48, esc, 24);
  // the escape wheel turns anticlockwise (seen from the front), half a tooth (6 degrees) a beat;
  // the fourth wheel the other way, half as fast and in the same jerks (twice the escape's poses to a beat)
  const keysE = 60 * BEAT_POSES, keys4 = 120 * BEAT_POSES / 2;
  const escTurn = (u) => escPose(Math.round(u * keysE)) * TAU / 60;
  const turn4 = (u) => -escPose(Math.round(u * keys4) * 2) * TAU / 120;
  // (these two, with the most poses, cast their shadows through stand-ins: see shadowProxy)
  const escProxy = Geo.merge(shadowProxy(30, 0.0165, 0.0215, { spokes: 4, rim: 0.82 }), Geo.cylinder(0.0072, 0.0016, 12).translate(0, 0, -0.0048));
  const fourthProxy = Geo.merge(shadowProxy(48, m * 24 - 1.25 * m, m * 25, { teeth: false, spokes: 4 }), Geo.cylinder(0.0018, 0.002, 8).translate(0, 0, -0.006));
  for (const g of [unshadowed(escWheel), escProxy]) cyc(b, g, at(esc[0], esc[1], 0), 60 * Tb, keysE, (u) => m4.rotationZ(phE + escTurn(u)));
  for (const g of [unshadowed(fourthWheel), fourthProxy]) cyc(b, g, at(fourth[0], fourth[1], 0), 120 * Tb, keys4, (u) => m4.rotationZ(ph4 + turn4(u)));
  // the third and centre wheels creep round smoothly (their jerks are a fraction of a degree)
  cyc(b, thirdWheel, at(third[0], third[1], 0), 450, 90, (u) => m4.rotationZ(ph3 + u * TAU));
  cyc(b, centreWheel, at(cen[0], cen[1], 0), 3600, 180, (u) => m4.rotationZ(-u * TAU));
  // hands: seconds on the fourth arbor, minutes and hours at the centre
  const secHand = blade(0.015, 0.005, (y) => (y < 0 ? 0.0025 : 0.001), { color: COL.blued });
  cyc(b, secHand, at(fourth[0], fourth[1], 0.0185), 120 * Tb, keys4, (u) => m4.rotationZ(turn4(u)));
  const minHand = blade(0.06, 0.012, (y) => (y < 0 ? 0.004 : Math.max(0.0012, 0.0035 - 0.03 * y)));
  cyc(b, minHand, at(cen[0], cen[1], 0.0205), 3600, 120, (u) => m4.rotationZ(-u * TAU));
  const hourHand = blade(0.042, 0.01, (y) => (y < 0 ? 0.005 : Math.max(0.0016, 0.005 - 0.08 * y)));
  b.dynamic(hourHand, { times: Array.from({ length: 31 }, (_, i) => i * 120), transform: (t) => m4.mul(at(cen[0], cen[1], 0.019), m4.rotationZ(-(4 + t / 3600) * TAU / 12)), caps: 'none' });

  // the anchor and the pendulum, rocking together about the anchor's arbor:
  // a sine, 16 poses to the swing, through the middle at t = 0, 0.5, 1 ...
  const swing = (u) => m4.rotationZ(amp * Math.sin(TAU * u));
  const anchor = new Geo();
  {
    const R = 0.0215, spread = 0.62;
    for (const sgn of [-1, 1]) {
      const a = Math.PI / 2 + sgn * spread;
      const tip = [esc[0] + R * 1.02 * Math.cos(a) - anchorAt[0], esc[1] + R * 1.02 * Math.sin(a) - anchorAt[1], 0];
      anchor.add(rod([[0, 0, 0], [tip[0] * 0.6, tip[1] * 0.4, 0], tip], 0.0011, { seg: 6, step: 0.003 }));
      anchor.add(Geo.box(0.0024, 0.005, 0.0022).rotateZ(Math.atan2(tip[0], -tip[1])).translate(tip[0], tip[1], 0));
    }
    anchor.add(Geo.cylinder(0.0028, 0.004, 12).translate(0, 0, -0.002));
    anchor.color(COL.steel).gloss(0.8).mat(MAT.STEEL);
  }
  const pAt = at(anchorAt[0], anchorAt[1], 0);
  cyc(b, anchor, pAt, Tp, 16, swing);
  // the pendulum: its rod in three pieces and its bob, each swinging of its own (see rodParts)
  for (const piece of rodParts([0, 0, -0.016], [0, -L + 0.004, -0.016], 3, 0.0014, { seg: 5, step: 0.025 })) cyc(b, piece.color(COL.steel).gloss(0.7).mat(MAT.STEEL), pAt, Tp, 16, swing);
  cyc(b, lens(0.0225, 0.006, 32).translate(0, -L, -0.016).color(COL.brass).gloss(0.85).mat(MAT.BRASS), pAt, Tp, 16, swing);
}

// a flat ring in the XY plane facing +Z, uv laid out over the outer circle
function annulus(r0, r1, seg) {
  const g = new Geo();
  for (let i = 0; i <= seg; i++) {
    const a = i * TAU / seg, c = Math.cos(a), s = Math.sin(a);
    g.vert(r0 * c, r0 * s, 0, 0, 0, 1, 0.5 + 0.5 * c * r0 / r1, 0.5 + 0.5 * s * r0 / r1);
    g.vert(r1 * c, r1 * s, 0, 0, 0, 1, 0.5 + 0.5 * c, 0.5 + 0.5 * s);
  }
  for (let i = 0; i < seg; i++) g.quadIdx(2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1);
  return g.orientByNormals();
}
// a pendulum bob: a lens of radius r and thickness d, facing +Z
function lens(r, d, seg = 40) {
  const prof = [];
  for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 + Math.PI * k / 8; prof.push([r * Math.cos(a) * (k === 0 || k === 8 ? 0 : 1), d / 2 * Math.sin(a)]); }
  prof[0][0] = 0; prof[8][0] = 0;
  return Geo.lathe(prof, seg);
}

// ---------------------------------------------------------------- swinging things

// Newton's cradle: five steel balls on V-shaped strings.  The end balls take
// turns: one swings out and back, strikes, and the one at the other end flies
// out.  A ball's half-swing is half its pendulum's period; the strike is
// exactly on a pose.
function cradle(b, base) {
  const r = 0.0095, H = 0.15, T = 0.625, L = lengthFor(T), A = 0.5, keys = 24;
  const frame = new Geo();
  frame.add(Geo.box(0.2, 0.13, 0.012).translate(0, 0, 0.006).color('#1c1a18').gloss(0.5));
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) frame.add(rod([[sx * 0.085, sy * 0.03, 0.012], [sx * 0.085, sy * 0.03, H]], 0.0025, { seg: 10, step: 0.2 }));
  for (const sy of [-1, 1]) frame.add(rod([[-0.085, sy * 0.03, H], [0.085, sy * 0.03, H]], 0.0025, { seg: 10, step: 0.2 }));
  frame.color(COL.steel).gloss(0.85).mat(MAT.STEEL);
  b.static(frame, { transform: base, solid: false });
  // a ball and its two strings, hanging from the pivot line (along y) at the origin
  const sphere = Geo.sphere(r, 12, 8).translate(0, 0, -L).color('#cfd3d8').gloss(0.95).mat(MAT.STEEL);
  const strings = Geo.merge(
    rod([[0, -0.03, 0], [0, 0, -L + r * 0.8]], 0.00035, { seg: 3, step: 0.02 }),
    rod([[0, 0.03, 0], [0, 0, -L + r * 0.8]], 0.00035, { seg: 3, step: 0.02 }),
  ).color('#e8e4da');
  const xs = [-2, -1, 0, 1, 2].map((i) => i * 2 * r);
  for (let i = 1; i < 4; i++) b.static(Geo.merge(sphere, strings), { transform: m4.mul(base, m4.translation(xs[i], 0, H)), solid: false });
  // how far out (towards +x) the right ball is, and the left: each swings for half the round
  // (The strings, thinner than a pixel of the shadow map, cast no shadow.  And
  // as a mesh apart from them the ball, which keeps low, is drawn in a view
  // tilted up only for the few seconds that the slice crosses the ball: see rodParts.)
  const out = (u, right) => ((u < 0.5) === right ? A * Math.sin(TAU * u) : 0);
  for (const right of [true, false]) {
    const at = m4.mul(base, m4.translation(xs[right ? 4 : 0], 0, H)), swing = (u) => m4.rotationY(-out(u, right));
    cyc(b, sphere, at, T, keys, swing, { reach: 0.1 });
    cyc(b, strings, at, T, keys, swing, { shadow: false });
  }
}

// A pendulum wave: fifteen pendulums in a row (running back from the front of
// the bench) whose lengths are chosen so that in one minute the first swings
// 76 times, the next 77, ... the last 90: they drift out of step into waves
// and snakes and come back together every minute.  They swing left and right,
// in the sun, and their shadows swing on the bench.
function pendulumWave(b, base) {
  const n = 15, gap = 0.03, H = 0.24, A = 0.12, rb = 0.011;
  const x0 = -(n - 1) * gap / 2;
  const frame = new Geo();
  frame.add(Geo.box(0.2, n * gap + 0.08, 0.015).translate(0, 0, 0.0075).color(COL.walnut).mat(MAT.WOOD));
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) frame.add(rod([[sx * 0.08, sy * (n * gap / 2 + 0.025), 0.015], [sx * 0.08, sy * (n * gap / 2 + 0.025), H]], 0.004, { seg: 10, step: 0.5 }).color(COL.brass).mat(MAT.BRASS));
  for (const sx of [-1, 1]) frame.add(rod([[sx * 0.08, -(n * gap / 2 + 0.025), H], [sx * 0.08, n * gap / 2 + 0.025, H]], 0.003, { seg: 10, step: 0.5 }).color(COL.brass).mat(MAT.BRASS));
  b.static(frame.gloss(0.7), { transform: base, solid: false });
  const colours = ['#b23a2a', '#c8762a', '#c9a63a', '#5f8a3a', '#2f7a72', '#2f5d8a', '#5a3f8a', '#8a3a6a'];
  for (let k = 0; k < n; k++) {
    const T = 60 / (76 + k), L = lengthFor(T);
    // (the ball casts a shadow; the threads, thinner than a pixel of the shadow map, do not)
    const bob = Geo.sphere(rb, 12, 8).translate(0, 0, -L).color(colours[k % colours.length]).gloss(0.6).mat(MAT.PAINT);
    const threads = Geo.merge(
      rod([[-0.06, 0, 0], [0, 0, -L + rb * 0.9]], 0.0004, { seg: 3, step: 0.04 }),
      rod([[0.06, 0, 0], [0, 0, -L + rb * 0.9]], 0.0004, { seg: 3, step: 0.04 }),
    ).color('#e8e4da');
    // they swing across the row (about y): all at the far end of their swing at t = 0
    const swing = (u) => m4.rotationY(A * Math.cos(TAU * u)), at = m4.mul(base, m4.translation(0, x0 + k * gap, H));
    cyc(b, bob, at, T, 16, swing, { shadow: true });
    cyc(b, threads, at, T, 16, swing, { shadow: false });
  }
}

// A metronome at sixty beats a minute: a pyramid case, and a rod pivoted low
// in it with a sliding weight, swinging over the top: two seconds there and back.
function metronome(b, base, { lite = false, shadow } = {}) {
  const H = 0.2;
  const g = Geo.lathe([[0.06, 0], [0.06, 0.012], [0.05, 0.016], [0.022, H], [0, H + 0.004]], 4, { smooth: false }).rotateZ(Math.PI / 4).scale(1, 0.7, 1);
  g.color(COL.walnut).gloss(0.5).mat(MAT.WOOD);
  // the scale behind the rod
  g.add(Geo.plane(0.025, 0.12).rotateX(Math.PI / 2).translate(0, -0.03, 0.09).color('#d9c79a').mat(MAT.PAINT));
  b.static(g, { transform: base, solid: false });
  const arm = Geo.merge(
    rod([[0, 0, 0], [0, 0, 0.2]], 0.0012, { seg: lite ? 5 : 6, step: lite ? 0.016 : 0.008 }).color(COL.steel).gloss(0.8).mat(MAT.STEEL),
    Geo.lathe([[0, -0.008], [0.009, -0.007], [0.011, 0], [0.009, 0.007], [0, 0.008]], lite ? 10 : 16).translate(0, 0, 0.14).color(COL.brass).gloss(0.8).mat(MAT.BRASS),
  );
  // a sine, 32 poses to the two seconds, through the middle on every whole second
  cyc(b, arm, m4.mul(base, m4.translation(0, -0.034, 0.03)), 2, 32, (u) => m4.rotationY(0.42 * Math.sin(TAU * u)), { shadow });
}

// The orrery: planets on arms round a brass sun, each arm turning in a whole
// number of seconds, an earth with its moon and a Jupiter with two moons.
function orrery(b, base) {
  const g = new Geo();
  g.add(Geo.lathe([[0.11, 0], [0.11, 0.02], [0.1, 0.03], [0.04, 0.045], [0.02, 0.11], [0.012, 0.2]], 128).color(COL.walnut).gloss(0.6).mat(MAT.WOOD));
  g.add(Geo.cylinder(0.004, 0.14, 12).translate(0, 0, 0.2).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  g.add(Geo.sphere(0.028, 32, 20).translate(0, 0, 0.36).color('#ffcc66').emissive(1.2).gloss(0.8).mat(MAT.BRASS));
  b.static(g, { transform: base, solid: false });
  // An arm: out from the centre column at height z, then up (or down) to the planet.
  const arm = (R, z, zp, rp, col) => Geo.merge(
    rod([[0, 0, z], [R, 0, z]], 0.0016, { seg: 6, step: 0.01 }),
    rod([[R, 0, z], [R, 0, zp]], 0.0012, { seg: 6, step: 0.01 }),
    Geo.cylinder(0.006, 0.006, 16).translate(0, 0, z - 0.003),
  ).color(COL.brass).gloss(0.75).mat(MAT.BRASS).add(Geo.sphere(rp, 18, 12).translate(R, 0, zp).color(col).gloss(0.4).mat(MAT.PAINT));
  const at = m4.mul(base, m4.translation(0, 0, 0));
  const planets = [
    // radius, arm height, planet height, size, colour, seconds a round
    [0.055, 0.30, 0.345, 0.006, '#9a8f84', 8],
    [0.085, 0.285, 0.34, 0.009, '#e0c890', 20],
    [0.165, 0.255, 0.33, 0.011, '#3f74b0', 40],
    [0.205, 0.235, 0.31, 0.008, '#b0553a', 75],
    [0.26, 0.215, 0.29, 0.018, '#c8a070', 180],
  ];
  planets.forEach(([R, z, zp, rp, col, T], i) => {
    const keys = Math.min(60, Math.max(36, Math.round(T)));
    cyc(b, arm(R, z, zp, rp, col), at, T, keys, (u) => m4.rotationZ(u * TAU + i * 1.3), { shadow: false });
  });
  // the earth's moon: once round the earth in 5 s, carried round with it in 40 s (8 moon rounds a year)
  {
    const [R, , zp] = planets[2];
    const moon = Geo.merge(rod([[0, 0, 0], [0.03, 0, 0]], 0.0008, { seg: 5, step: 0.006 }).color(COL.brass).mat(MAT.BRASS), Geo.sphere(0.0045, 16, 10).translate(0.03, 0, 0).color('#cfcfc8').mat(MAT.PAINT));
    cyc(b, moon, at, 40, 8 * 16, (u) => m4.mul(m4.rotationZ(u * TAU + 2 * 1.3), m4.translation(R, 0, zp), m4.rotationZ(u * 8 * TAU)), { shadow: false });
  }
  // Jupiter's two moons: 9 s and 20 s round it, while it goes round in 180 s
  {
    const [R, , zp] = planets[4];
    for (const [d, Tm, rr] of [[0.032, 9, 0.004], [0.045, 20, 0.005]]) {
      const moon = Geo.merge(rod([[0, 0, 0], [d, 0, 0]], 0.0008, { seg: 5, step: 0.006 }).color(COL.brass).mat(MAT.BRASS), Geo.sphere(rr, 14, 9).translate(d, 0, 0).color('#d8d0c0').mat(MAT.PAINT));
      const n = 180 / Tm;
      cyc(b, moon, at, 180, n * 12, (u) => m4.mul(m4.rotationZ(u * TAU + 4 * 1.3), m4.translation(R, 0, zp), m4.rotationZ(u * n * TAU)), { shadow: false });
    }
  }
}

// A longcase regulator against the right-hand wall: a seconds pendulum (two
// seconds there and back, 0.99 m long) swinging behind a glass door, and a
// dial with a seconds hand that ticks once a second with the beat.
function longcase(b, at) {
  const g = new Geo();
  const W = 0.42, D = 0.24, Z0 = 0.3, Z1 = 1.6;
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  g.add(Geo.box(W + 0.06, D + 0.04, Z0).translate(0, -0.02, Z0 / 2));          // plinth
  // in this frame the clock faces -y.  The trunk is a hollow case: back, sides,
  // and a door, a frame round a long glass through which the pendulum is seen
  const gx = 0.16, gz0 = 0.45, gz1 = 1.45, f = -D / 2;
  g.add(boxAt(-W / 2, W / 2, D / 2 - 0.02, D / 2, Z0, Z1));
  for (const sx of [-1, 1]) g.add(boxAt(sx > 0 ? W / 2 - 0.02 : -W / 2, sx > 0 ? W / 2 : -W / 2 + 0.02, f, D / 2, Z0, Z1));
  for (const sx of [-1, 1]) g.add(boxAt(sx > 0 ? gx : -W / 2, sx > 0 ? W / 2 : -gx, f, f + 0.02, Z0, Z1));
  g.add(boxAt(-gx, gx, f, f + 0.02, Z0, gz0));
  g.add(boxAt(-gx, gx, f, f + 0.02, gz1, Z1));
  // a moulding round the glass
  for (const sx of [-1, 1]) g.add(boxAt(sx * gx - 0.008, sx * gx + 0.008, f - 0.006, f, gz0 - 0.008, gz1 + 0.008));
  for (const z of [gz0, gz1]) g.add(boxAt(-gx - 0.008, gx + 0.008, f - 0.006, f, z - 0.008, z + 0.008));
  g.add(Geo.box(W + 0.08, D + 0.06, 0.5).translate(0, -0.01, 1.85));          // hood
  g.add(Geo.box(W + 0.12, D + 0.1, 0.05).translate(0, -0.01, 2.125));
  g.color(COL.walnut).gloss(0.55).mat(MAT.WOOD);
  b.static(subdivide(g, 0.4), { transform: at });
  // the inside of the case, darker; the glass, which also keeps a flyer out
  b.static(Geo.box(W - 0.06, 0.005, Z1 - Z0).translate(0, D / 2 - 0.023, (Z0 + Z1) / 2).color('#1a120c').mat(MAT.WOOD), { transform: at, solid: false });
  const glass = Geo.plane(2 * gx, gz1 - gz0).rotateX(Math.PI / 2).translate(0, f + 0.01, (gz0 + gz1) / 2).color('#c8d4d8').gloss(0.95).blend(0.1).doubleSided();
  b.static(glass, { transform: at, solid: true });
  // the hood's front: two turned columns either side, a brass dial plate, the dial on it
  const front = -D / 2 - 0.04;
  const hood = new Geo();
  for (const sx of [-1, 1]) hood.add(Geo.lathe([[0.016, 0], [0.016, 0.02], [0.011, 0.03], [0.011, 0.43], [0.016, 0.44], [0.016, 0.46]], 16).translate(sx * (W / 2 + 0.01), front - 0.012, 1.62).color(COL.walnut).gloss(0.6).mat(MAT.WOOD));
  hood.add(Geo.box(0.34, 0.003, 0.34).translate(0, front - 0.0015, 1.85).color(COL.brass).gloss(0.75).mat(MAT.BRASS));
  b.static(hood, { transform: at, solid: false });
  const dialAt = m4.mul(at, m4.translation(0, front - 0.003, 1.85), m4.rotationX(Math.PI / 2));
  wallClockFace(b, dialAt, { r: 0.15, dial: 0, tick: true });
  // The pendulum: a rod a metre long and a big brass bob, two seconds there
  // and back.  Tilted up, the slice crosses the rod's metre in 3.3 s at 45
  // degrees: its foot is seen that much earlier than its top, and the rod
  // bends into a snake of more than a whole swing and a half.  So the rod is
  // in 2 cm lengths, in five pieces of its own (see rodParts).
  const L = lengthFor(2), pAt = m4.mul(at, m4.translation(0, 0.02, 1.62)), swing = (u) => m4.rotationY(0.06 * Math.sin(TAU * u));
  for (const piece of rodParts([0, 0, 0], [0, 0, -L], 5, 0.003, { seg: 5, step: 0.02 })) cyc(b, piece.color('#3a3632').gloss(0.6).mat(MAT.STEEL), pAt, 2, 24, swing);
  cyc(b, lens(0.07, 0.022, 24).rotateX(Math.PI / 2).translate(0, 0, -L).color(COL.brass).gloss(0.85).mat(MAT.BRASS), pAt, 2, 24, swing);
  // the weights on their cables, hanging still (they go down an inch in the hour)
  const wts = new Geo();
  for (const x of [-0.1, 0.1]) {
    wts.add(Geo.cylinder(0.028, 0.2, 24).translate(x, 0.04, 0.95).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
    wts.add(rod([[x, 0.04, 1.15], [x, 0.04, 1.6]], 0.0012, { seg: 5, step: 0.5 }).color('#888'));
  }
  b.static(wts, { transform: at, solid: false });
}

// ---------------------------------------------------------------- turning things

// A train of wheels on a board, laid out from a list: each wheel meshes with
// one before it (`on`, at `dir` degrees from it) or shares an arbor with one
// (`with`, in front of it).  Speeds follow from the tooth counts: a wheel of
// N teeth driven by one of M turns M/N times as fast, the other way.  Every
// round must go a whole number of times into the hour.
function train(b, at, m, list, { T0 = 120, w = 0.004, color = COL.brass, faceZ = 0.0, board = null } = {}) {
  const gs = [];
  const dirTo = (a, c) => Math.atan2(c[1] - a[1], c[0] - a[0]);
  for (const e of list) {
    const g = { ...e, z: e.z ?? faceZ };
    if (e.with !== undefined) {
      const o = gs[e.with];
      Object.assign(g, { pos: o.pos, T: o.T, sense: o.sense, phase: 0, z: o.z + (e.dz ?? w * 1.6) });
    } else if (e.on !== undefined) {
      const o = gs[e.on], d = m * (o.N + e.N) / 2, a = e.dir * Math.PI / 180;
      g.pos = [o.pos[0] + d * Math.cos(a), o.pos[1] + d * Math.sin(a)];
      g.T = o.T * e.N / o.N;
      g.sense = -o.sense;
      g.z = o.z;
      // its teeth in the gaps of the other's
      g.phase = dirTo(g.pos, o.pos) - (o.phase - dirTo(o.pos, g.pos)) * o.N / e.N + Math.PI / e.N;
    } else {
      Object.assign(g, { pos: e.pos, T: e.T ?? T0, sense: e.sense ?? -1, phase: 0 });
    }
    if (Math.abs(P / g.T - Math.round(P / g.T)) > 1e-6) throw new Error(`a wheel of ${g.N} teeth turns in ${g.T} s, which does not go into ${P}`);
    gs.push(g);
  }
  const arbors = new Geo();
  for (const g of gs) {
    const geo = spur(g.N, m, { w: g.w ?? w, spokes: g.spokes ?? (g.N >= 30 ? 5 : 0), bore: 0.002, color: g.color ?? color });
    // a pose every 9 degrees: with triangles of a centimetre at most, they fold by under half a millimetre
    const keys = g.keys ?? 40;
    cyc(b, geo, m4.mul(at, m4.translation(g.pos[0], g.pos[1], g.z)), g.T, keys, (u) => m4.rotationZ(g.phase + g.sense * u * TAU), { reach: m * g.N });
    if (g.with === undefined) arbors.add(Geo.cylinder(0.0025, g.z + 0.012, 12).translate(g.pos[0], g.pos[1], -0.004).color(COL.steel).gloss(0.8).mat(MAT.STEEL));
  }
  b.static(arbors, { transform: at, solid: false });
  if (board) {
    // the board they are mounted on, [colour, thickness]: 5 cm bigger all round than the wheels on it
    const e = [Infinity, Infinity, -Infinity, -Infinity];
    for (const g of gs) {
      const r = m * g.N / 2 + m + 0.05;
      e[0] = Math.min(e[0], g.pos[0] - r); e[1] = Math.min(e[1], g.pos[1] - r); e[2] = Math.max(e[2], g.pos[0] + r); e[3] = Math.max(e[3], g.pos[1] + r);
    }
    b.static(Geo.box(e[2] - e[0], e[3] - e[1], board[1]).translate((e[0] + e[2]) / 2, (e[1] + e[3]) / 2, -board[1] / 2).color(board[0]).mat(MAT.WOOD), { transform: at, solid: false });
  }
  return gs;
}

// A small horizontal mill engine: cylinder, crosshead, connecting rod, crank
// and flywheel, and a fly-ball governor turned off the shaft at twice its
// speed.  One turn of the crank every 6 s, 48 poses to the turn: every part's
// pose is worked out from the crank's angle, as the linkage has it.
function steamEngine(b, at) {
  const Tc = 6, keys = 48;
  const zc = 0.075, R = 0.018, l = 0.085, xc = 0.07; // shaft height, crank throw, rod length, shaft position
  const g = new Geo();
  // (the line of the engine, cylinder, crosshead, connecting rod and crank, is at y = yl, in front of the bearings)
  const yl = -0.055;
  g.add(Geo.box(0.36, 0.16, 0.015).translate(-0.02, -0.015, 0.0075).color(COL.walnut).gloss(0.5).mat(MAT.WOOD));
  // the cylinder, lagged in wood with brass bands, on its saddle, and its covers
  g.add(Geo.cylinder(0.026, 0.09, 32).rotateY(Math.PI / 2).translate(-0.19, yl, zc).color('#6b4a2e').mat(MAT.WOOD));
  for (const x of [-0.19, -0.1]) g.add(Geo.cylinder(0.0275, 0.006, 32).rotateY(Math.PI / 2).translate(x - 0.003, yl, zc).color(COL.brass).gloss(0.85).mat(MAT.BRASS));
  g.add(Geo.cylinder(0.006, 0.012, 16).rotateY(Math.PI / 2).translate(-0.103, yl, zc).color(COL.brass).gloss(0.85).mat(MAT.BRASS));   // the gland the piston rod slides through
  g.add(Geo.box(0.07, 0.05, zc - 0.015).translate(-0.145, yl, (zc - 0.015) / 2 + 0.015).color('#3b3430'));
  // the guide bars for the crosshead, on a stand of their own, as long as its travel
  for (const dz of [-0.009, 0.009]) g.add(Geo.box(0.115, 0.008, 0.003).translate(-0.0425, yl, zc + dz).color(COL.steel).gloss(0.8).mat(MAT.STEEL));
  g.add(Geo.box(0.012, 0.012, zc - 0.024).translate(-0.06, yl, (zc - 0.024) / 2 + 0.015).color('#3b3430'));
  // the bearings for the shaft, the shaft (it turns about itself: it may stand still)
  for (const y of [-0.035, 0.035]) g.add(Geo.box(0.022, 0.012, zc).translate(xc, y, zc / 2 + 0.008).color('#3b3430'));
  g.add(Geo.cylinder(0.004, 0.11, 12).rotateX(Math.PI / 2).translate(xc, 0.055, zc).color(COL.steel).gloss(0.8).mat(MAT.STEEL));
  // the governor's pillar and the bevel box
  g.add(Geo.cylinder(0.005, 0.12, 12).translate(-0.02, 0.04, 0.015).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  b.static(g, { transform: at, solid: false });

  const crank = (u) => -u * TAU; // the crank's angle: it turns towards the cylinder over the top
  const pin = (u) => [xc + R * Math.cos(crank(u)), zc + R * Math.sin(crank(u))];
  const head = (u) => { const [px, pz] = pin(u); return px - Math.sqrt(l * l - (pz - zc) ** 2); };
  // the flywheel: 8 spokes, a heavy rim, on the far side of the bearings
  const fly = Geo.merge(
    wheel(32, 0.064, 0.064, { tooth: [[-0.25, 0], [0.25, 0]], w: 0.012, bore: 0.006, rings: 4, spokes: 8, rim: 0.8, color: '#6a2218', gloss: 0.6 }),
    Geo.cylinder(0.012, 0.02, 16).translate(0, 0, -0.01).color(COL.brass).gloss(0.8).mat(MAT.BRASS),
  ).rotateX(Math.PI / 2);
  cyc(b, fly, m4.mul(at, m4.translation(xc, 0.05, zc)), Tc, keys, (u) => m4.rotationY(-crank(u)));
  // the crank: a disc with the pin
  const crankDisc = Geo.merge(Geo.cylinder(0.024, 0.006, 32).translate(0, 0, -0.003), Geo.cylinder(0.003, 0.012, 10).translate(R, 0, 0)).rotateX(Math.PI / 2).color(COL.steel).gloss(0.75).mat(MAT.STEEL);
  cyc(b, crankDisc, m4.mul(at, m4.translation(xc, -0.045, zc)), Tc, keys, (u) => m4.rotationY(-crank(u)));
  // the connecting rod, from the crosshead to the pin, in pieces
  const conrod = Geo.merge(rod([[0, 0, 0], [l, 0, 0]], 0.003, { seg: 8, step: 0.01 }), Geo.box(0.012, 0.008, 0.012), Geo.box(0.01, 0.008, 0.01).translate(l, 0, 0)).color(COL.steel).gloss(0.8).mat(MAT.STEEL);
  cyc(b, conrod, m4.mul(at, m4.translation(0, yl, 0)), Tc, keys, (u) => {
    const [px, pz] = pin(u), hx = head(u);
    return m4.mul(m4.translation(hx, 0, zc), m4.rotationY(-Math.atan2(pz - zc, px - hx)));
  });
  // the crosshead and the piston rod, sliding back and forth
  const slide = Geo.merge(Geo.box(0.014, 0.012, 0.014), rod([[-0.11, 0, 0], [0, 0, 0]], 0.0025, { seg: 8, step: 0.012 })).color(COL.steel).gloss(0.85).mat(MAT.STEEL);
  cyc(b, slide, m4.mul(at, m4.translation(0, yl, zc)), Tc, keys, (u) => m4.translation(head(u), 0, 0));
  // the governor: two balls on arms, spun at twice the shaft's speed, standing out at 35 degrees
  const gov = new Geo();
  gov.add(rod([[0, 0, 0], [0, 0, 0.06]], 0.0018, { seg: 6, step: 0.01 }).color(COL.steel).mat(MAT.STEEL));
  for (const sx of [-1, 1]) {
    const tip = [sx * 0.035 * Math.sin(0.62), 0, 0.06 - 0.035 * Math.cos(0.62)];
    gov.add(rod([[0, 0, 0.06], tip], 0.0012, { seg: 5, step: 0.008 }).color(COL.steel).mat(MAT.STEEL));
    gov.add(Geo.sphere(0.008, 16, 10).translate(...tip).color(COL.brass).gloss(0.9).mat(MAT.BRASS));
    gov.add(rod([[tip[0] * 0.5, 0, tip[2] * 0.5 + 0.03 * 0.5], [0, 0, 0.025]], 0.0009, { seg: 4, step: 0.008 }).color(COL.steel).mat(MAT.STEEL));
  }
  gov.add(Geo.cylinder(0.005, 0.006, 12).translate(0, 0, 0.022).color(COL.brass).mat(MAT.BRASS));
  cyc(b, gov, m4.mul(at, m4.translation(-0.02, 0.04, 0.135)), Tc / 2, 48, (u) => m4.rotationZ(u * TAU));
}

// ---------------------------------------------------------------- small clocks, light, air

// A carriage clock: a brass case with glass panels, a dial, hands, and on top,
// under a glass, the balance wheel swinging 115 degrees each way twice a
// second (24 poses to the swing: it moves fast).
function carriageClock(b, at, { start = 0 } = {}) {
  const W = 0.07, D = 0.06, H = 0.1;
  const g = new Geo();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) g.add(Geo.box(0.007, 0.007, H).translate(sx * (W / 2 - 0.0035), sy * (D / 2 - 0.0035), H / 2 + 0.006));
  g.add(Geo.box(W + 0.008, D + 0.008, 0.008).translate(0, 0, 0.004));
  // the top: a frame round a glass, through which the balance is seen
  for (const sy of [-1, 1]) g.add(Geo.box(W + 0.006, 0.01, 0.006).translate(0, sy * (D / 2 - 0.002), H + 0.006));
  for (const sx of [-1, 1]) g.add(Geo.box(0.01, D + 0.006, 0.006).translate(sx * (W / 2 - 0.002), 0, H + 0.006));
  g.add(Geo.torus(0.022, 0.0025, 24, 6).rotateX(Math.PI / 2).scale(1, 1, 0.8).translate(0, 0, H + 0.026));    // the handle
  g.add(Geo.box(W - 0.006, 0.004, H - 0.006).translate(0, D / 2 - 0.004, H / 2 + 0.006));                      // the back plate
  g.color(COL.brass).gloss(0.8).mat(MAT.BRASS);
  g.add(Geo.disc(0.026, 48).rotateX(Math.PI / 2).translate(0, -D / 2 + 0.006, 0.048).color(COL.enamel).gloss(0.4).mat(MAT.DIAL));
  b.static(g, { transform: at, solid: false });
  b.static(Geo.box(W - 0.006, D - 0.006, H - 0.002).translate(0, 0, H / 2 + 0.008).color('#d8e2e4').gloss(0.95).blend(0.08), { transform: at, solid: false });
  const face = m4.mul(at, m4.translation(0, -D / 2 + 0.006, 0.048), m4.rotationX(Math.PI / 2));
  wallClockFace(b, face, { r: 0.026, dial: 0, seconds: false, bezel: false });
  // the balance: a rim, three arms, a staff; it lies flat under the top glass
  const bal = Geo.merge(Geo.torus(0.0085, 0.0007, 32, 4), ...[0, 1, 2].map((k) => Geo.box(0.0085, 0.0007, 0.0005).translate(0.0042, 0, 0).rotateZ(k * TAU / 3)),
    ...[0, 1, 2, 3, 4, 5].map((k) => Geo.box(0.0012, 0.0012, 0.0012).translate(0.0092, 0, 0).rotateZ(k * TAU / 6 + 0.5))).color(COL.brass).gloss(0.9).mat(MAT.BRASS);
  // 115 degrees each way, 24 poses to the swing
  // (its shadow would fall inside the case, where nobody sees it)
  cyc(b, bal, m4.mul(at, m4.translation(0.012, 0.005, H + 0.0005)), 0.5, 24, (u) => m4.rotationZ(2.0 * Math.sin(TAU * u)), { start, shadow: false });
  b.static(Geo.box(0.03, 0.03, 0.003).translate(0.012, 0.005, H - 0.003).color(COL.brass).mat(MAT.BRASS), { transform: at, solid: false });
}

// The desk lamp at the right-hand end of the bench (the shader lights the room from it)
function deskLamp(b) {
  const g = new Geo();
  const [lx, ly, lz] = [2.12, 1.58, 1.32];
  g.add(Geo.lathe([[0.075, 0], [0.075, 0.012], [0.05, 0.022], [0.012, 0.03], [0.012, 0.04]], 96).translate(lx + 0.1, ly + 0.14, BENCH).color('#2c3a2c').gloss(0.6));
  g.add(rod([[lx + 0.1, ly + 0.14, BENCH + 0.03], [lx + 0.08, ly + 0.12, lz + 0.18], [lx, ly, lz + 0.06]], 0.006, { seg: 10, step: 0.05 }).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  // the shade: green glass outside, white inside, open below
  g.add(Geo.lathe([[0.11, -0.03], [0.09, 0.0], [0.05, 0.05], [0.015, 0.07]], 96).translate(lx, ly, lz).color('#1f4d2a').gloss(0.8));
  g.add(Geo.lathe([[0.015, 0.068], [0.05, 0.048], [0.09, -0.002], [0.108, -0.028]], 96).translate(lx, ly, lz).color('#f0e8d0').emissive(0.6));
  b.static(g, { solid: false });
  b.static(Geo.sphere(0.025, 20, 14).translate(lx, ly, lz + 0.01).color('#fff2d0').emissive(8).mat(MAT.LAMP), { solid: false });
}

// Dust in the sunbeam: three hundred specks, each drifting on a slow loop of
// its own (a minute round, a pose every second and a half).  They are light,
// and only shine where the sun catches them (see MAT.MOTE in the shader).
function dust(b) {
  const rand = rng(41), n = 300;
  const specks = [];
  for (let i = 0; i < n; i++) {
    // somewhere in the beam: from the window in along the sun's rays
    const sIn = rand.range(0.2, 2.6), y0 = rand.range(WIN.y0, WIN.y1), z0 = rand.range(WIN.z0, WIN.z1);
    const c = [-RX - SUN[0] * sIn, y0 - SUN[1] * sIn, z0 - SUN[2] * sIn];
    if (c[2] < BENCH + 0.1 || c[1] > RY - 0.05) { i--; continue; }
    specks.push({ c, a: [rand.range(0.01, 0.04), rand.range(0.01, 0.04), rand.range(0.01, 0.03)], f: [rand.int(1, 3), rand.int(1, 3), rand.int(1, 2)], ph: [rand.range(0, TAU), rand.range(0, TAU), rand.range(0, TAU)], size: rand.range(0.0006, 0.0014) });
  }
  const tet = (sz) => { const g = new Geo(); const v = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((p) => p.map((x) => x * sz)); for (const [a, c, d] of [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]) g.add(Geo.triangle(v[a], v[c], v[d])); return g; };
  const shape = (u) => {
    const g = new Geo();
    for (const sp of specks) {
      const p = sp.c.map((c, k) => c + sp.a[k] * Math.sin(TAU * sp.f[k] * u + sp.ph[k]) + (k === 2 ? -0.01 * Math.cos(TAU * u + sp.ph[0]) : 0));
      g.add(tet(sp.size).translate(...p));
    }
    return g.color('#fff4dc').emissive(5).mat(MAT.MOTE).additive();
  };
  b.dynamic(shape, { times: [0, P], caps: 'none', cycle: { period: 60, keys: 40 } });
  // the haze in the beam: a few faint sheets across it, which light up only inside it
  const haze = new Geo();
  for (let k = 0; k < 9; k++) {
    const x = -2.3 + k * 0.22;
    haze.add(Geo.plane(3.6, 2.6, 18, 13).rotateY(Math.PI / 2).translate(x, 0, 1.3));
  }
  b.static(haze.color('#ffe8c0').emissive(0.012).mat(MAT.BEAM).additive(), { solid: false });
}

// A curtain beside the window: a sheet hanging in soft pleats, stirred by
// the draught in a wave that runs across it (an eight-second round of 16 poses).
// It hangs beside the light, not in it, and casts no shadow.  It is four
// bands, one above the other, each moving of its own: a view tilted up
// crosses the curtain's height over many seconds (1.5 m is 19 s at 75
// degrees), and draws each band only for the seconds it crosses that band.
// Their normals come from the shape itself, so that the bands meet without
// a seam in the shading.
function curtain(b, at, { w = 0.34, h = 1.55, start = 0 } = {}) {
  const nx = 16, nz = 40, bands = 4;
  // how far the cloth stands out from its rail at x across it, z up from its hem
  const off = (x, z, u) => {
    const down = 1 - z / h; // 0 at the rail, 1 at the hem
    const pleat = 0.025 * Math.sin(x / w * 5 * TAU);
    return pleat + 0.03 * down * down * Math.sin(TAU * (u - x / w * 0.6 - down * 0.3)) + 0.012 * down * Math.sin(TAU * (2 * u + x / w));
  };
  for (let k = 0; k < bands; k++) {
    const shape = (u) => {
      const g = Geo.plane(w, h / bands, nx, nz / bands).rotateX(Math.PI / 2);
      for (let i = 0; i < g.vertexCount; i++) {
        const x = g.p[i * 3], z = g.p[i * 3 + 2] + h / bands * (k + 0.5), y = off(x, z, u), e = 1e-4;
        const n = v3.norm([(off(x + e, z, u) - y) / e, -1, (off(x, z + e, u) - y) / e]);
        g.p[i * 3 + 1] = y;
        g.p[i * 3 + 2] = z;
        for (let c = 0; c < 3; c++) g.n[i * 3 + c] = n[c];
      }
      return g.doubleSided().color('#7a2e26').mat(MAT.CLOTH).noShadow();
    };
    b.dynamic(shape, { times: [0, P], transform: () => at, caps: 'none', cycle: { period: 8, keys: 16, start } });
  }
}

// A candle: wax, wick, and a flame that leans, stretches and flickers on a
// six-second round of 36 poses (a sum of slower and quicker sways).
function candle(b, at, { h = 0.14, start = 0 } = {}) {
  const g = new Geo();
  g.add(Geo.cylinder(0.011, h, 48).color('#efe6cf').gloss(0.3));
  g.add(Geo.lathe([[0.03, 0], [0.03, 0.006], [0.014, 0.012], [0.009, 0.03], [0.016, 0.034], [0.016, 0.04]], 64).translate(0, 0, -0.04).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  g.add(rod([[0, 0, h], [0.001, 0, h + 0.008]], 0.0007, { seg: 4, step: 0.01 }).color('#1a1612'));
  b.static(g, { transform: at, solid: false });
  const shape = (u) => {
    const sway = 0.003 * Math.sin(TAU * u) + 0.0015 * Math.sin(TAU * 3 * u + 1) + 0.0008 * Math.sin(TAU * 7 * u + 2);
    const swayY = 0.002 * Math.sin(TAU * 2 * u + 0.5) + 0.001 * Math.sin(TAU * 5 * u);
    const tall = 1 + 0.12 * Math.sin(TAU * 4 * u + 0.3) + 0.06 * Math.sin(TAU * 9 * u);
    const prof = [[0, 0], [0.0035, 0.002], [0.0048, 0.007], [0.0042, 0.013], [0.0028, 0.019], [0.0012, 0.025], [0, 0.03]];
    const f = Geo.lathe(prof.map(([r, z]) => [r, z * tall]), 12);
    for (let i = 0; i < f.vertexCount; i++) {
      const z = f.p[i * 3 + 2] / (0.03 * tall);
      f.p[i * 3] += sway * z * z; f.p[i * 3 + 1] += swayY * z * z;
      f.uv[i * 2 + 1] = z;
    }
    return f.translate(0, 0, h + 0.004).color('#ffffff').mat(MAT.FLAME).tag(3).additive();
  };
  b.dynamic(shape, { times: [0, P], transform: () => at, caps: 'none', cycle: { period: 6, keys: 36, start } });
}

// ---------------------------------------------------------------- the music box

// Its tune: twenty bars of three half-second beats, the cylinder once round in
// 30 s.  Each note is a pin on the cylinder and a pluck of one of eighteen
// comb teeth (tooth 0 is D4, up the scale of D major to A6).  The scene's
// music plays the same tune, so what is heard is what the pins pluck.
const TUNE_SECONDS = 30;
const TEETH_MIDI = [62, 64, 66, 67, 69, 71, 73, 74, 76, 78, 79, 81, 83, 85, 86, 88, 90, 93];
const TUNE = (() => {
  const bass = [0, 0, 3, 0, 4, 4, 0, 0, 3, 3, 0, 5, 3, 4, 0, 0, 0, 3, 4, 0];
  const mel = ['9 - 11', '14 - 11', '12 11 10', '9 - -', '8 9 8', '13 - 11', '9 8 7', '9 - -', '10 12 14', '15 14 12',
    '14 11 9', '12 - 9', '10 9 8', '13 15 13', '14 - 16', '17 - 14', '16 14 11', '12 14 15', '13 11 8', '7 - -'];
  const notes = [];
  mel.forEach((bar, i) => {
    notes.push({ tooth: bass[i], t: i * 1.5 });
    bar.split(' ').forEach((n, k) => { if (n !== '-') notes.push({ tooth: +n, t: i * 1.5 + k * 0.5 }); });
  });
  return notes;
})();

function musicBox(b, at) {
  const W = 0.16, D = 0.11, H = 0.055;
  const g = new Geo();
  // the box, open, its lid standing up at the back with a mirror in it
  g.add(Geo.box(W, D, 0.008).translate(0, 0, 0.004));
  for (const sx of [-1, 1]) g.add(Geo.box(0.008, D, H).translate(sx * (W / 2 - 0.004), 0, H / 2));
  g.add(Geo.box(W, 0.008, H).translate(0, D / 2 - 0.004, H / 2));
  g.add(Geo.box(W, 0.008, H * 0.55).translate(0, -D / 2 + 0.004, H * 0.275));
  g.add(Geo.box(W, 0.008, 0.1).rotateX(-0.25).translate(0, D / 2 + 0.01, H + 0.05));
  g.color('#4a2a1a').gloss(0.65).mat(MAT.WOOD);
  g.add(Geo.box(W - 0.016, D - 0.016, 0.003).translate(0, 0, H - 0.022).color(COL.brass).gloss(0.6).mat(MAT.BRASS));   // the bedplate
  g.add(Geo.plane(W - 0.03, 0.08).rotateX(Math.PI / 2 - 0.25).translate(0, D / 2 + 0.006, H + 0.05).color('#9aa8b0').gloss(1));  // the mirror
  b.static(g, { transform: at, solid: false });
  const cz = H - 0.006, cy = 0.012, r = 0.012, len = 0.075;
  // cylinder bearings, the comb's base block
  const fixed = new Geo();
  for (const sx of [-1, 1]) fixed.add(Geo.box(0.006, 0.012, 0.022).translate(sx * (len / 2 + 0.005), cy, cz - 0.008));
  fixed.add(Geo.box(0.07, 0.012, 0.006).translate(0, -0.038, cz + r - 0.006));
  b.static(fixed.color(COL.brass).gloss(0.7).mat(MAT.BRASS), { transform: at, solid: false });
  // the comb: eighteen teeth, longer for the low notes
  const n = 18, pitchX = 0.0036, tipY = -r * Math.sin(0.45), tipZ = r * Math.cos(0.45) + 0.0006;
  const toothX = (k) => (k - (n - 1) / 2) * pitchX;
  const baseY = -0.034;
  // the cylinder and its pins, turning once in 30 s (a pose every 3 degrees)
  const cyl = Geo.lathe([[0, 0], [r, 0], ...Array.from({ length: 7 }, (_, i) => [r, (i + 1) * len / 8]), [r, len], [0, len]], 48, { smooth: false }).rotateY(Math.PI / 2).translate(-len / 2, 0, 0).color(COL.brass).gloss(0.75).mat(MAT.BRASS);
  const pins = new Geo();
  for (const note of TUNE) {
    const a = TAU * note.t / TUNE_SECONDS;
    // the pin stands where the tooth's tip is, turned back by the angle the cylinder turns before the note
    const pin = Geo.box(0.0007, 0.0007, 0.0012).translate(toothX(note.tooth), 0, r + 0.0004);
    pins.add(pin.transform(m4.mul(m4.rotationX(-a), m4.rotationX(-0.45))));
  }
  cyc(b, Geo.merge(cyl, pins.color('#d8d8d0').gloss(0.8).mat(MAT.STEEL)), m4.mul(at, m4.translation(0, cy, cz)), TUNE_SECONDS, 120, (u) => m4.rotationX(TAU * u), { shadow: false });
  // the teeth: each lifted by its pin over a tenth of a second, then let go,
  // to spring back and ring down (a pose every 50 ms)
  const keys = TUNE_SECONDS * 20;
  for (let k = 0; k < n; k++) {
    const L = Math.hypot(tipY - baseY, 0) + 0.002 + 0.0005 * (n - k) / n;
    const tooth = Geo.box(pitchX * 0.72, L, 0.0009).translate(0, L / 2, 0).color('#c8ccd2').gloss(0.85).mat(MAT.STEEL);
    const plucks = TUNE.filter((t) => t.tooth === k).map((t) => t.t);
    if (!plucks.length) { b.static(tooth, { transform: m4.mul(at, m4.translation(toothX(k), baseY, cz + tipZ - 0.0004)), solid: false }); continue; }
    const lift = (t) => {
      let a = 0;
      for (const tp of plucks) {
        let d = t - tp;
        d -= Math.round(d / TUNE_SECONDS) * TUNE_SECONDS;
        if (d > -0.1 && d <= 0) a += 0.05 * (1 + d / 0.1);                            // riding up the pin
        else if (d > 0 && d < 0.3) a += -0.015 * Math.exp(-d / 0.08) * Math.cos(d * TAU / 0.1);   // let go: it rings down
      }
      return a;
    };
    cyc(b, tooth, m4.mul(at, m4.translation(toothX(k), baseY, cz + tipZ - 0.0004)), TUNE_SECONDS, keys, (u) => m4.rotationX(lift(u * TUNE_SECONDS)), { shadow: false });
  }
  // the air brake that keeps the pace: a two-vaned fan spinning on its worm
  const fan = Geo.merge(Geo.box(0.022, 0.0005, 0.007), Geo.cylinder(0.0012, 0.012, 8).translate(0, 0, -0.006)).color(COL.steel).gloss(0.7).mat(MAT.STEEL);
  cyc(b, fan, m4.mul(at, m4.translation(0.055, -0.02, H - 0.006)), 0.6, 24, (u) => m4.rotationZ(TAU * u), { shadow: false });
  // and on a post at the side, a dancer turning on one toe, once in 6 s
  const dancer = new Geo();
  dancer.add(Geo.cylinder(0.0012, 0.03, 8).translate(0.0015, 0, 0).color('#f0d8c8'));                       // the standing leg
  dancer.add(rod([[0, 0, 0.028], [-0.012, 0.004, 0.032], [-0.02, 0.006, 0.04]], 0.0011, { seg: 6, step: 0.004 }).color('#f0d8c8'));   // the raised leg
  dancer.add(Geo.lathe([[0, 0], [0.018, 0.002], [0.016, 0.006], [0, 0.007]], 24).translate(0, 0, 0.029).color('#f4e4ec').gloss(0.3));  // the tutu
  dancer.add(Geo.lathe([[0.004, 0], [0.0045, 0.008], [0.0035, 0.016], [0.002, 0.018], [0, 0.019]], 16).translate(0, 0, 0.034).color('#e8b0c0'));
  dancer.add(Geo.sphere(0.0038, 14, 10).translate(0, 0, 0.057).color('#f0d8c8'));
  for (const sx of [-1, 1]) dancer.add(rod([[sx * 0.003, 0, 0.049], [sx * 0.008, 0, 0.058], [sx * 0.003, 0, 0.066]], 0.0008, { seg: 5, step: 0.003 }).color('#f0d8c8'));
  dancer.gloss(0.5).mat(MAT.PAINT);
  b.static(Geo.cylinder(0.006, 0.02, 16).translate(-0.055, -0.02, H - 0.022).color(COL.brass).mat(MAT.BRASS), { transform: at, solid: false });
  cyc(b, dancer, m4.mul(at, m4.translation(-0.055, -0.02, H - 0.002)), 6, 60, (u) => m4.rotationZ(TAU * u), { shadow: false });
}

// A ball-drop automaton: an arm turning one way round lifts a steel ball in
// its cup, slowly, easing in and out, and lets it go over an anvil; the ball
// falls 10 cm in a parabola and bounces, lower each time, until it lies still,
// and the arm comes round to scoop it up again.  Eight seconds a round.  The
// ball's flights are timed to the fiftieth of a second, so that every
// bounce falls on one of its poses (a pose each fiftieth).
function ballDrop(b, at, { start = 0 } = {}) {
  const T = 8, r = 0.008, g = GRAV, dt = 0.02, tf = 0.14, e = 0.66;
  const Az = 0.048, H = g * tf * tf / 2, Bz = Az + H;
  const d = 0.034, zc = Az + H / 2, R = Math.hypot(d, H / 2);
  const aA = Math.atan2(-H / 2, d), aB = Math.atan2(H / 2, d);
  const uc = 0.7; // when it lets go
  const ease = (x) => x * x * (3 - 2 * x);
  const angle = (u) => (u < uc ? aA + (aB - TAU - aA) * ease(u / uc) : aB - TAU + (aA - aB) * ease((u - uc) / (1 - uc)));
  const armAt = (u) => m4.mul(m4.translation(-d, 0, zc), m4.rotationY(-angle(u)));
  // the stand, the anvil, the motor box
  const st = new Geo();
  st.add(Geo.box(0.1, 0.06, 0.01).translate(-0.01, 0, 0.005).color('#2a2522'));
  st.add(Geo.box(0.022, 0.022, 0.03).translate(0, 0, 0.025).color('#55595e').gloss(0.7).mat(MAT.STEEL));
  st.add(Geo.box(0.03, 0.025, 0.04).translate(-d, 0.03, zc).color('#3a3430'));
  st.add(Geo.box(0.008, 0.008, zc).translate(-d, 0.03, zc / 2).color('#3a3430'));
  b.static(st, { transform: at, solid: false });
  // the arm and its cup, in front of the motor box
  const arm = Geo.merge(Geo.cylinder(0.006, 0.006, 20).rotateX(Math.PI / 2).translate(0, 0.012, 0), rod([[0, 0.012, 0], [R, 0.012, 0]], 0.0016, { seg: 6, step: 0.008 }),
    Geo.cylinder(0.0012, 0.012, 8).rotateX(Math.PI / 2).translate(R, 0.012, 0)).color(COL.brass).gloss(0.8).mat(MAT.BRASS);
  cyc(b, arm, at, T, 200, (u) => armAt(u), { start, reach: 0.1 });
  // the cup hangs level from the arm's end, and tips over to let the ball go
  const cup = Geo.lathe([[0.0005, -r - 0.0012], [0.006, -r - 0.0008], [0.0098, -0.003], [0.0102, -0.0015]], 18).color(COL.brass).gloss(0.8).mat(MAT.BRASS);
  const tip = (u) => (u < uc - 0.01 ? 0 : u < uc + 0.02 ? 1.3 * ease((u - uc + 0.01) / 0.03) : 1.3 * (1 - ease(Math.min(1, (u - uc - 0.02) / 0.2))));
  cyc(b, cup, at, T, 200, (u) => m4.mul(armAt(u), m4.translation(R, 0, 0), m4.rotationY(angle(u)), m4.rotationY(tip(u))), { start, reach: 0.1 });
  // the ball in the cup: there while it is carried, shrunk to nothing otherwise
  const ball = Geo.sphere(r, 14, 9).color('#d8dce0').gloss(0.95).mat(MAT.STEEL);
  cyc(b, ball, at, T, 200, (u) => m4.mul(armAt(u), m4.translation(R, 0, 0), m4.rotationY(angle(u)), m4.scaling(u <= uc + 1e-9 ? 1 : 0)), { start, reach: 0.1 });
  // the falling ball: its height over the round
  const flights = [];
  let v = g * tf;
  for (;;) { v *= e; const dur = Math.round(2 * v / g / dt) * dt; if (dur < 2 * dt) break; flights.push(dur); v = g * dur / 2; }
  const height = (t) => {
    let tau = t - uc * T;
    if (tau < 0) return null;
    if (tau <= tf) return Bz - g * tau * tau / 2;
    tau -= tf;
    for (const D of flights) { if (tau <= D) return Az + g / 2 * tau * (D - tau); tau -= D; }
    return Az;
  };
  const n = Math.round(T / dt);
  cyc(b, ball, at, T, n, (u) => {
    const h = height(Math.round(u * n) * dt);
    return h === null ? m4.mul(m4.translation(0, 0, Bz), m4.scaling(0)) : m4.translation(0, 0, h);
  }, { start, reach: 0.1 });
}

// ---------------------------------------------------------------- living things

// A ginger cat asleep on the rug by the fire, curled up: its body bent round
// into a crescent with its back to the room, its head down on its front paws
// at one end, its tail wrapped round from the other end to its nose.  It
// breathes (its flank swells and falls, four seconds a breath), an ear
// twitches now and then, and the tip of its tail flicks.  Stiff parts moved by
// matrices: the body, the head, an ear, the tail's tip.  In this frame the
// spine runs along x, the back towards +y, and the cat curls towards -y.
function cat(b, at) {
  const ginger = '#c27a3a', cream = '#ecd2a6', pink = '#c87a70';
  const ell = (rx, ry, rz, seg = 36, rings = 24) => Geo.sphere(1, seg, rings).scale(rx, ry, rz);
  const Rb = 0.17;
  // bend a mesh round a centre at (0, -Rb): x along the spine becomes an angle
  const bend = (g) => {
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.p[i * 3], y = g.p[i * 3 + 1], th = x / Rb, r = Rb + y;
      g.p[i * 3] = r * Math.sin(th); g.p[i * 3 + 1] = -Rb + r * Math.cos(th);
    }
    return g.computeNormals();
  };
  const bendPt = ([x, y, z]) => [(Rb + y) * Math.sin(x / Rb), -Rb + (Rb + y) * Math.cos(x / Rb), z];
  // the body: one long rounded form along the spine, fullest at the haunch,
  // bent round; cream underneath and on the inside of the curl
  const prof = (u) => 0.062 + 0.026 * Math.exp(-(((u - 0.2) / 0.22) ** 2)) + 0.01 * Math.exp(-(((u - 0.85) / 0.15) ** 2));
  const sp = [];
  for (let k = 0; k <= 28; k++) { const u = k / 28; sp.push([-0.2 + 0.36 * u, 0, prof(u) * 0.82]); }
  const torso = Geo.tube(sp, (u) => prof(u), 32, { caps: false });
  const capEnd = (r, x, v) => { const e = ell(r, r, r * 0.82, 32, 20).translate(x, 0, r * 0.82); for (let i = 0; i < e.vertexCount; i++) e.uv[i * 2 + 1] = v; return e; };
  torso.add(capEnd(prof(0), -0.2, 0)); torso.add(capEnd(prof(1), 0.16, 1));
  for (let i = 0; i < torso.vertexCount; i++) torso.p[i * 3 + 2] = Math.max(0.002, torso.p[i * 3 + 2] * 0.82 + 0.012);
  const mixC = (a, c, f) => { const A = parseCol(a), B = parseCol(c); return A.map((v, k) => v + (B[k] - v) * f); };
  const body = bend(torso).colorBy((p, nn) => mixC(ginger, cream, Math.min(1, Math.max(0, (-nn[1] - 0.2) * 1.6, (0.03 - p[2]) * 40)))).tag(2).mat(MAT.FUR);
  const breath = (u) => { const x = 0.5 - 0.5 * Math.cos(TAU * u); return x * x * (3 - 2 * x); };
  cyc(b, body, at, 4, 16, (u) => m4.mul(m4.translation(0, -0.02, 0), m4.scaling(1 + 0.02 * breath(u), 1 + 0.035 * breath(u), 1 + 0.05 * breath(u)), m4.translation(0, 0.02, 0)), { shadow: false });
  // the front paws, stretched out from the chest towards the curl's inside
  const paws = new Geo();
  for (const off of [0, 0.028]) {
    const p0 = bendPt([0.12 - off, -0.04, 0.02]), p1 = bendPt([0.09 - off * 1.2, -0.11, 0.014]);
    paws.add(Geo.tube([p0, v3.lerp(p0, p1, 0.5), p1], (u) => 0.017 - 0.003 * u, 18, { caps: true }).color(cream));
    paws.add(ell(0.018, 0.015, 0.011, 18, 12).translate(...p1).color(cream));
  }
  b.static(paws.mat(MAT.FUR), { transform: at, solid: false });
  // the head, chin on the paws, nose turned in towards the tail
  const head = new Geo();
  head.add(ell(0.052, 0.048, 0.042).color(ginger).tag(1));
  head.add(ell(0.024, 0.021, 0.016, 24, 16).translate(0.035, 0, -0.012).color(cream));            // muzzle
  head.add(ell(0.006, 0.005, 0.004, 12, 8).translate(0.057, 0, -0.005).color(pink));            // nose
  for (const sy of [-1, 1]) head.add(ell(0.009, 0.0018, 0.0014, 12, 6).rotateZ(sy * 0.35).translate(0.033, sy * 0.019, 0.012).color('#2a1a12'));   // shut eyes
  for (const sy of [-1, 1]) for (let w = 0; w < 3; w++) head.add(rod([[0.044, sy * 0.012, -0.012 + w * 0.003], [0.078, sy * (0.035 + w * 0.006), -0.02 + w * 0.006]], 0.0004, { seg: 3, step: 0.01 }).color('#f0e8d8'));
  const earG = () => Geo.lathe([[0.016, 0], [0.013, 0.008], [0.0095, 0.016], [0.006, 0.024], [0.003, 0.031], [0, 0.036]], 16).scale(1, 0.55, 1);
  head.add(earG().rotateX(-0.35).rotateY(-0.25).translate(-0.006, -0.024, 0.026).color(ginger));
  head.mat(MAT.FUR);
  const hp = bendPt([0.2, -0.05, 0.05]);
  const headAt = m4.mul(at, m4.translation(...hp), m4.rotationZ(Math.atan2(-0.13 - hp[1], 0.0 - hp[0]) + 0.3), m4.rotationY(0.22), m4.rotationX(0.15));
  cyc(b, head, headAt, 4, 16, (u) => m4.mul(m4.translation(0, 0, 0.003 * breath(u)), m4.rotationY(-0.02 * breath(u))), { shadow: false });
  const ear = earG().color(ginger).mat(MAT.FUR);
  const twitch = (u) => { const t = u * 24; let a = 0; for (const t0 of [5, 5.7, 17.2]) { const d = t - t0; if (d > 0 && d < 0.5) a += 0.55 * Math.sin(Math.PI * d / 0.5); } return a; };
  cyc(b, ear, m4.mul(headAt, m4.translation(-0.006, 0.024, 0.026), m4.rotationY(-0.25)), 24, 240, (u) => m4.rotationX(0.35 + twitch(u)), { shadow: false });
  // the tail: from the rump, round the curl's open side, to under the nose
  const tn = 24, tail = [];
  for (let k = 0; k <= tn; k++) {
    const u = k / tn;
    tail.push(bendPt([-0.19 + 0.31 * u, -0.06 - 0.09 * Math.sin(Math.PI * Math.min(1, u * 1.3)) - 0.02 * u, 0.018 - 0.005 * u]));
  }
  b.static(Geo.tube(tail, (u) => 0.02 - 0.006 * u, 18, { caps: true }).color(ginger).tag(2).mat(MAT.FUR), { transform: at, solid: false });
  // the tip: it stirs slowly, and twice in 13 s it flicks
  const tipPts = Array.from({ length: 9 }, (_, k) => [0.07 * k / 8, 0, 0.004 * Math.sin(k / 8 * Math.PI)]);
  const tip = Geo.tube(tipPts, (u) => 0.0135 - 0.007 * u, 18, { caps: true }).color(ginger).tag(2).mat(MAT.FUR);
  const end = tail[tn], before = tail[tn - 1], dirA = Math.atan2(end[1] - before[1], end[0] - before[0]);
  const flick = (t) => { let a = 0; for (const [t0, dur] of [[2, 0.5], [8.3, 0.7]]) { const d = t - t0; if (d > 0 && d < dur) a += 0.7 * Math.sin(TAU * d / dur * (dur > 0.6 ? 2 : 1)) * Math.sin(Math.PI * d / dur); } return a; };
  cyc(b, tip, m4.mul(at, m4.translation(...end), m4.rotationZ(dirA)), 13, 208, (u) => m4.mul(m4.rotationZ(0.12 * Math.sin(TAU * u) + flick(u * 13)), m4.rotationY(-0.1 * Math.max(0, flick(u * 13)))), { shadow: false });
}

// A rounded box: a sphere pushed out towards the box's corners
function roundedBox(sx, sy, sz, seg = 24, e = 0.25) {
  const g = Geo.sphere(1, seg, Math.round(seg * 0.75));
  for (let i = 0; i < g.vertexCount; i++) for (let k = 0; k < 3; k++) { const v = g.p[i * 3 + k]; g.p[i * 3 + k] = Math.sign(v) * Math.pow(Math.abs(v), e) * [sx, sy, sz][k] / 2; }
  return g.computeNormals();
}

// Goldfish in a bowl: two fish swimming round, each a stiff body on its
// round (12 s and 15 s) with a tail that beats twice a second.
function fishbowl(b, at) {
  const R = 0.11;
  b.static(Geo.cylinder(0.06, 0.012, 32).color('#2a2522'), { transform: at, solid: false });
  b.static(Geo.sphere(R, 96, 64).translate(0, 0, R + 0.01).color('#dfeeee').gloss(0.95).blend(0.14), { transform: at, solid: false });
  // the water's surface: rings of ripples running out from where the fish nose it, and a slow slop
  const zw = R + 0.01 + R * 0.36, rw = R * 0.93;
  const water = (u) => {
    const g = new Geo();
    const nr = 8, na = 48, src = [0.03, 0.01];
    const h = (x, y) => {
      const d = Math.hypot(x - src[0], y - src[1]);
      return 0.0012 * Math.sin(TAU * (d / 0.025 - 3 * u)) * Math.exp(-d / 0.06) + 0.0008 * Math.sin(TAU * u + x / rw * 2);
    };
    for (let j = 0; j <= nr; j++) for (let i = 0; i < na; i++) {
      const r = rw * j / nr, a = TAU * i / na, x = r * Math.cos(a), y = r * Math.sin(a);
      g.vert(x, y, h(x, y), 0, 0, 1, 0.5 + x / (2 * rw), 0.5 + y / (2 * rw));
    }
    for (let j = 0; j < nr; j++) for (let i = 0; i < na; i++) {
      const a = j * na + i, c = j * na + (i + 1) % na;
      g.quadIdx(a, c, c + na, a + na);
    }
    return g.computeNormals().color('#a8c8c0').gloss(0.9).blend(0.18);
  };
  b.dynamic(water, { times: [0, P], transform: () => m4.mul(at, m4.translation(0, 0, zw)), caps: 'none', cycle: { period: 4, keys: 24 } });
  // pebbles on the bottom
  const rand = rng(9), peb = new Geo();
  for (let i = 0; i < 40; i++) { const a = rand.range(0, TAU), d = rand.range(0, 0.06); peb.add(Geo.sphere(rand.range(0.004, 0.008), 8, 6).scale(1, 1, 0.6).translate(d * Math.cos(a), d * Math.sin(a), 0.02 + 0.006 * (1 - d / 0.06)).color(rand.pick(['#8a7f70', '#b0a48f', '#6a6258', '#c8b8a0']))); }
  b.static(peb, { transform: at, solid: false });
  // A goldfish: a turned body, deep and narrow, paler underneath, eyes, a
  // dorsal fin; and its forked tail fin, a mesh of its own.  As the tail
  // beats, the body sways a little the other way about a point behind its head.
  const prof = [[0, 0], [0.0022, 0.002], [0.0048, 0.008], [0.0068, 0.016], [0.0066, 0.023], [0.0046, 0.029], [0.0015, 0.0318], [0, 0.032]];
  const fish = Geo.lathe(prof, 16).rotateY(Math.PI / 2).translate(-0.017, 0, 0).scale(1, 0.55, 1.1)
    .colorBy((q) => (q[2] < -0.002 ? '#f4b070' : '#e8701e'));
  fish.add(Geo.triangle([-0.007, 0, 0.006], [0.004, 0, 0.0068], [-0.01, 0, 0.0125]).doubleSided().color('#f08a30'));
  for (const sy of [-1, 1]) fish.add(Geo.sphere(0.0014, 8, 5).translate(0.009, sy * 0.0031, 0.0018).color('#111'));
  fish.gloss(0.6).mat(MAT.PAINT);
  const tailFin = Geo.merge(Geo.triangle([0, 0, 0], [-0.015, 0, 0.009], [-0.009, 0, 0.0015]), Geo.triangle([0, 0, 0], [-0.009, 0, 0.0015], [-0.009, 0, -0.0005]),
    Geo.triangle([0, 0, 0], [-0.009, 0, -0.0005], [-0.015, 0, -0.007])).color('#f08a30').doubleSided().mat(MAT.PAINT);
  for (const [Tr, rr, z, dir, ph] of [[12, 0.055, R + 0.0, 1, 0], [15, 0.035, R - 0.035, -1, 2.0]]) {
    const beats = Tr * 2;
    const pos = (u) => { const a = dir * TAU * u + ph; return m4.mul(m4.translation(rr * Math.cos(a), rr * Math.sin(a), z + 0.008 * Math.sin(2 * TAU * u)), m4.rotationZ(a + dir * Math.PI / 2)); };
    const body = (u) => m4.mul(pos(u), m4.translation(0.007, 0, 0), m4.rotationZ(-0.12 * Math.sin(TAU * beats * u)), m4.translation(-0.007, 0, 0));
    cyc(b, fish, at, Tr, beats * 8, body, { shadow: false });
    cyc(b, tailFin, at, Tr, beats * 8, (u) => m4.mul(body(u), m4.translation(-0.0165, 0, 0.0005), m4.rotationZ(0.5 * Math.sin(TAU * beats * u))), { shadow: false });
  }
}

// A drinking bird on the window sill: it leans slowly further and further
// forward as its head cools, dips its beak, and swings back (14 s a round).
function drinkingBird(b, at) {
  const g = new Geo();
  for (const sx of [-1, 1]) g.add(rod([[sx * 0.02, 0, 0], [sx * 0.012, 0, 0.09]], 0.0015, { seg: 6, step: 0.02 }));
  g.add(Geo.box(0.05, 0.012, 0.004).translate(0, 0, 0.002));
  b.static(g.color('#3a7ab0').gloss(0.5), { transform: at, solid: false });
  b.static(Geo.cylinder(0.018, 0.03, 24).translate(0.07, 0, 0).color('#cfe0e8').gloss(0.9).blend(0.3), { transform: at, solid: false });
  const bird = Geo.merge(
    Geo.sphere(0.014, 14, 10).translate(0, 0, -0.03).color('#c03020').gloss(0.9),
    rod([[0, 0, -0.03], [0, 0, 0.07]], 0.003, { seg: 6, step: 0.025 }).color('#d8e8ec').gloss(0.9),
    Geo.sphere(0.011, 12, 8).translate(0, 0, 0.075).color('#c03020').gloss(0.8),
    Geo.cylinder(0.012, 0.004, 12).translate(0, 0, 0.083).color('#2a5a9a'),
    Geo.cone(0.003, 0.016, 8).rotateY(Math.PI / 2).translate(0.008, 0, 0.074).color('#e8e0c8'),
  ).mat(MAT.PAINT);
  // leaning angle over a round: slowly over (12 s), a quick dip and back (2 s), with a damped rock after it
  const lean = (u) => {
    const t = u * 14;
    if (t < 12) return 0.15 + 0.85 * (t / 12) ** 2 + 0.06 * Math.exp(-t / 1.5) * Math.cos(t * TAU / 1.2);
    const d = (t - 12) / 2;
    return 1.25 - 1.1 * d + 0.1 * Math.sin(Math.PI * d);
  };
  cyc(b, bird, m4.mul(at, m4.translation(0, 0, 0.09)), 14, 112, (u) => m4.rotationY(1.25 * lean(u) - 0.2), { reach: 0.12 });
}

// ---------------------------------------------------------------- round the room

// A toy railway on a shelf that runs right round the room under the ceiling:
// a locomotive with three pairs of driving wheels, coupled by rods, and its
// tender and four carriages, once round in five minutes.  The wheels turn as
// far as they roll (96 turns to the lap), the rods go round with the cranks.
const SHELF_Z = 2.3;
function shelfRailway(b) {
  const inset = 0.09, rc = 0.25;
  const x0 = -RX + inset, x1 = RX - inset, y0 = -RY + inset, y1 = RY - inset;
  // the line: straight along the walls, quarter circles at the corners
  const pts = [];
  const corner = (cx, cy, a0) => { for (let k = 0; k <= 12; k++) { const a = a0 + k / 12 * Math.PI / 2; pts.push([cx + rc * Math.cos(a), cy + rc * Math.sin(a), SHELF_Z]); } };
  corner(x1 - rc, y0 + rc, -Math.PI / 2); corner(x1 - rc, y1 - rc, 0); corner(x0 + rc, y1 - rc, Math.PI / 2); corner(x0 + rc, y0 + rc, Math.PI);
  const line = new Path(pts, { closed: true });
  const lap = 300, v = line.length / lap, turns = 96, rw = line.length / (turns * TAU);
  // the shelf and the rails
  const shelf = new Geo();
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  const d = 0.16;
  shelf.add(boxAt(-RX, RX, -RY, -RY + d, SHELF_Z - 0.03, SHELF_Z - 0.005));
  shelf.add(boxAt(-RX, RX, RY - d, RY, SHELF_Z - 0.03, SHELF_Z - 0.005));
  shelf.add(boxAt(-RX, -RX + d, -RY + d, RY - d, SHELF_Z - 0.03, SHELF_Z - 0.005));
  shelf.add(boxAt(RX - d, RX, -RY + d, RY - d, SHELF_Z - 0.03, SHELF_Z - 0.005));
  b.static(subdivide(shelf, 0.5).color(COL.oakDark).mat(MAT.WOOD), { solid: false });
  const rails = new Geo();
  for (const off of [-0.0165, 0.0165]) {
    const rp = [];
    for (let k = 0; k <= 400; k++) { const { p, dir } = line.at(k / 400 * line.length); rp.push([p[0] - dir[1] * off, p[1] + dir[0] * off, SHELF_Z + 0.002]); }
    rails.add(Geo.tube(rp, 0.0018, 4, { caps: false }));
  }
  b.static(rails.color('#8a8a88').gloss(0.7).mat(MAT.STEEL), { solid: false });
  const sleepers = [];
  for (let k = 0; k < Math.floor(line.length / 0.03); k++) { const { p, dir } = line.at(k * 0.03); sleepers.push(m4.mul(m4.translation(p[0], p[1], SHELF_Z), m4.rotationZ(Math.atan2(dir[1], dir[0])))); }
  b.instances(Geo.box(0.008, 0.05, 0.003).translate(0, 0, 0.0015).color('#3a2a1e'), sleepers, { solid: false });

  // where a car is: on the line, `back` metres behind the engine's front axle; its two bogies on the line
  const carAt = (back, len) => (t) => {
    const s = v * t - back;
    const a = line.at(s).p, c = line.at(s - len).p;
    const dir = v3.norm(v3.sub(a, c)), mid = v3.lerp(a, c, 0.5);
    return m4.mul(m4.translation(mid[0], mid[1], SHELF_Z), m4.rotationZ(Math.atan2(dir[1], dir[0]) - Math.PI / 2));
  };
  // keys where the line bends (within half a millimetre), two to a straight; the whole hour, twelve laps
  const keyed = new Map();
  const timesFor = (back, len) => {
    const k = `${back},${len}`;
    if (!keyed.has(k)) {
      const lapTimes = adaptiveTimes(carAt(back, len), 0, lap, { tolerance: 0.0005, size: 0.06, minStep: 0.1, maxStep: 30 });
      const all = [];
      for (let i = 0; i < P / lap; i++) for (const t of lapTimes) if (i === 0 || t > 0) all.push(i * lap + t);
      keyed.set(k, all);
    }
    return keyed.get(k);
  };
  // (The shelf runs above the window, where no sunlight reaches: nothing on it
  // casts a shadow, which keeps the train out of the shadow maps.)
  const run = (geo, back, len, o = {}) => b.dynamic(unshadowed(geo), { times: timesFor(back, len), transform: carAt(back, len), caps: 'none', ...o });
  // the engine: boiler, smokebox, chimney, dome, cab, in its frame (+Y forward, axles across)
  const eng = new Geo();
  eng.add(Geo.box(0.04, 0.15, 0.012).translate(0, 0, 0.018).color('#1c1c1c'));
  eng.add(Geo.cylinder(0.019, 0.11, 32).rotateX(-Math.PI / 2).translate(0, -0.035, 0.045).color('#1d4d2e').gloss(0.7).mat(MAT.PAINT));
  eng.add(Geo.cylinder(0.02, 0.02, 32).rotateX(-Math.PI / 2).translate(0, 0.065, 0.045).color('#1c1c1c').gloss(0.5));
  eng.add(Geo.cylinder(0.006, 0.03, 16, { r2: 0.008 }).translate(0, 0.07, 0.06).color('#1c1c1c').gloss(0.5));
  eng.add(Geo.sphere(0.009, 16, 10).scale(1, 1, 0.8).translate(0, 0.02, 0.064).color(COL.brass).gloss(0.9).mat(MAT.BRASS));
  eng.add(Geo.box(0.046, 0.045, 0.05).translate(0, -0.06, 0.06).color('#1d4d2e').gloss(0.6).mat(MAT.PAINT));
  eng.add(Geo.box(0.05, 0.052, 0.004).translate(0, -0.06, 0.087).color('#1c1c1c'));
  for (const sx of [-1, 1]) eng.add(Geo.cylinder(0.007, 0.03, 16).rotateX(-Math.PI / 2).translate(sx * 0.018, 0.045, 0.025).color('#1c1c1c'));   // cylinders
  // the engine's lamp
  eng.add(Geo.box(0.008, 0.006, 0.008).translate(0, 0.078, 0.03).color('#fff0c0').emissive(3));
  run(subdivide(eng, 0.02), 0, 0.075);
  // its driving wheels: three axles, a wheel each side with spokes, turning as they roll
  const wheelGeo = Geo.merge(...[-1, 1].map((sx) => wheel(16, rw, rw, { tooth: [[-0.25, 0], [0.25, 0]], w: 0.004, bore: 0.001, spokes: 10, rim: 0.78, color: '#7a1a14', gloss: 0.5 }).rotateY(Math.PI / 2).translate(sx * 0.0185, 0, 0)));
  const axles = [0.02, -0.012, -0.044];
  const wheelPeriod = lap / turns;
  for (const ay of axles) {
    run(wheelGeo, 0, 0.075, { cycle: { period: wheelPeriod, keys: 24, transform: (u) => m4.mul(m4.translation(0, ay, rw), m4.rotationX(-TAU * u)) } });
  }
  // the coupling rods: they go round with the crank pins, keeping level
  const rods = Geo.merge(...[-1, 1].map((sx) => Geo.box(0.002, 0.07, 0.003).translate(sx * 0.0225, -0.012, 0))).color('#b8bcc0').gloss(0.8).mat(MAT.STEEL);
  run(rods, 0, 0.075, { cycle: { period: wheelPeriod, keys: 24, transform: (u) => m4.translation(0, 0.0075 * Math.sin(TAU * u), rw + 0.0075 * Math.cos(TAU * u)) } });
  // the tender and four carriages, each on two axles
  const smallWheels = Geo.merge(...[-1, 1].map((sx) => Geo.cylinder(rw * 0.8, 0.003, 16).rotateY(Math.PI / 2).translate(sx * 0.018 - 0.0015, 0, 0))).color('#1c1c1c');
  const cars = [[0.105, 0.065, '#1d4d2e'], [0.185, 0.11, '#7a2a20'], [0.31, 0.11, '#7a2a20'], [0.435, 0.11, '#7a2a20'], [0.56, 0.11, '#2a3a6a']];
  cars.forEach(([back, len, col], i) => {
    const car = new Geo();
    car.add(Geo.box(0.042, len - 0.01, 0.045).translate(0, 0, 0.045).color(col).gloss(0.6).mat(MAT.PAINT));
    if (i > 0) {
      car.add(Geo.box(0.046, len - 0.006, 0.004).translate(0, 0, 0.07).color('#2a2a2a'));
      for (let k = 0; k < 4; k++) for (const sx of [-1, 1]) car.add(Geo.box(0.001, 0.014, 0.014).translate(sx * 0.0212, -len / 2 + 0.02 + k * (len - 0.035) / 3, 0.052).color('#f0d890').emissive(1.5));
    } else {
      car.add(Geo.box(0.036, len - 0.02, 0.012).translate(0, 0, 0.073).color('#141414'));
    }
    run(subdivide(car, 0.02), back, len);
    const r = rw * 0.8, keysW = 16; // 120 turns to the lap
    for (const fr of [0.25, -0.25]) run(smallWheels, back, len, { cycle: { period: lap / 120, keys: keysW, transform: (u) => m4.mul(m4.translation(0, fr * len, r), m4.rotationX(-TAU * u)) } });
  });
}

// The fireplace in the wall behind the player: a stone surround, logs, and
// flames that lick up in waves; a mantel shelf with a clock and candles.
function fireplace(b, cx) {
  const g = new Geo();
  const y = -RY;
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  // the chimney breast stands out from the wall; the fire is in a recess in it
  const F = 0.32;
  g.add(boxAt(cx - 0.6, cx - 0.32, y, y + F, 0, 1.0));
  g.add(boxAt(cx + 0.32, cx + 0.6, y, y + F, 0, 1.0));
  g.add(boxAt(cx - 0.32, cx + 0.32, y, y + F, 0.62, 1.0));
  g.add(boxAt(cx - 0.6, cx + 0.6, y, y + F, 1.05, RZ));         // the breast up to the ceiling
  g.add(boxAt(cx - 0.7, cx + 0.7, y, y + F + 0.06, 1.0, 1.05)); // the mantel shelf
  g.add(boxAt(cx - 0.7, cx + 0.7, y, y + F + 0.25, 0, 0.03));   // the hearth
  b.static(subdivide(g, 0.3).color('#a89880').mat(MAT.PLASTER));
  // the firebox: sooty back and sides
  const fb = new Geo();
  fb.add(boxAt(cx - 0.32, cx + 0.32, y, y + 0.04, 0, 0.62));
  fb.add(boxAt(cx - 0.34, cx - 0.3, y, y + F, 0, 0.62));
  fb.add(boxAt(cx + 0.3, cx + 0.34, y, y + F, 0, 0.62));
  b.static(fb.color('#1a1512'), { solid: false });
  const fy = y + 0.14;
  // logs
  const logs = new Geo();
  logs.add(Geo.cylinder(0.045, 0.42, 16).rotateY(Math.PI / 2).translate(cx - 0.21, fy - 0.04, 0.075));
  logs.add(Geo.cylinder(0.04, 0.38, 16).rotateY(Math.PI / 2).rotateZ(0.25).translate(cx - 0.18, fy + 0.02, 0.12));
  logs.add(Geo.cylinder(0.035, 0.34, 16).rotateY(Math.PI / 2).rotateZ(-0.3).translate(cx - 0.16, fy - 0.08, 0.11));
  b.static(subdivide(logs, 0.03).color('#3a2a1c').mat(MAT.LOG), { solid: false });
  // embers under the logs
  b.static(Geo.plane(0.52, 0.22, 26, 11).translate(cx, fy, 0.035).color('#ff5a14').mat(MAT.EMBER), { solid: false });
  // Flames: tongues of fire in three layers each (a deep orange outer one, a
  // yellow one inside it, a pale core), which rise, fall, swell and lean in
  // a wave that runs up them: a 4 s round of 48 poses.  One shape for each
  // layer, shared by all the tongues: each has its own size and its own
  // place in the round.
  const layer = (wide, tall, tag) => (u) => {
    const prof = [];
    for (let k = 0; k <= 12; k++) { const z = k / 12; prof.push([wide * Math.pow(Math.sin(Math.PI * Math.min(1, 0.15 + z * 0.95)), 0.8) * (1 - 0.65 * z) * (k === 12 ? 0 : 1), z]); }
    const h = tall * (1 + 0.22 * Math.sin(TAU * u) + 0.1 * Math.sin(TAU * (3 * u + 0.3)));
    const f = Geo.lathe(prof.map(([r, z]) => [r * (1 + 0.12 * Math.sin(TAU * (2 * u + 0.2))), z * h]), 18);
    for (let i = 0; i < f.vertexCount; i++) {
      const z = f.p[i * 3 + 2] / h;
      f.p[i * 3] += 0.022 * tall / 0.25 * z * z * Math.sin(TAU * u - z * 3.5);
      f.p[i * 3 + 1] += 0.012 * tall / 0.25 * z * z * Math.sin(TAU * (2 * u + 0.4) - z * 2.5);
      f.uv[i * 2 + 1] = z;
    }
    return f.color('#ffffff').mat(MAT.FLAME).tag(tag).additive();
  };
  const layers = [layer(0.03, 0.25, 0), layer(0.02, 0.19, 1), layer(0.011, 0.11, 2)];
  [[-0.17, 0.8], [-0.08, 1.1], [0.0, 0.95], [0.09, 1.2], [0.17, 0.75], [-0.03, 0.65], [0.12, 0.6], [-0.13, 0.55]].forEach(([dx, sz], i) => {
    const at = m4.mul(m4.translation(cx + dx, fy + 0.03 * Math.sin(i * 2.1), 0.07), m4.scaling(sz));
    layers.forEach((lay, k) => b.dynamic(lay, { times: [0, P], transform: () => at, caps: 'none', cycle: { period: 4, keys: 48, start: i * 0.53 + k * 0.07 } }));
  });
  // on the mantel: a clock and two candles
  const mc = new Geo();
  mc.add(Geo.box(0.22, 0.1, 0.2).translate(0, 0, 0.1).color(COL.walnut).gloss(0.6).mat(MAT.WOOD));
  mc.add(Geo.cylinder(0.11, 0.1, 32, { caps: true }).rotateX(Math.PI / 2).scale(1, 1, 0.6).translate(0, 0.05, 0.2).color(COL.walnut).gloss(0.6).mat(MAT.WOOD));
  b.static(mc, { transform: m4.translation(cx, y + F + 0.0, 1.05), solid: false });
  wallClockFace(b, place([cx, y + F + 0.052, 1.05 + 0.13], ...FACE.front), { r: 0.065 });
  // over the mantel, a sunburst clock: gilt rays round a brass-ringed dial
  {
    const at = place([cx, y + F + 0.02, 1.75], ...FACE.front);
    const rays = new Geo();
    for (let k = 0; k < 48; k++) {
      const a = k * TAU / 48, long = k % 2 ? 0.3 : 0.4, wd = k % 2 ? 0.012 : 0.02;
      const ray = Geo.extrude([[0.17, -wd / 2], [long, -wd * 0.15], [long + 0.012, 0], [long, wd * 0.15], [0.17, wd / 2]], 0.008).translate(0, 0, -0.012 - (k % 2) * 0.004);
      rays.add(subdivide(ray, 0.03).transform(m4.rotationZ(a)));
    }
    for (let k = 0; k < 24; k++) rays.add(Geo.sphere(0.009, 12, 8).translate(0.31 * Math.cos((k + 0.5) * TAU / 24), 0.31 * Math.sin((k + 0.5) * TAU / 24), -0.008));
    rays.add(Geo.cylinder(0.17, 0.03, 96).translate(0, 0, -0.03));
    b.static(rays.color('#b8903a').gloss(0.75).mat(MAT.BRASS), { transform: at, solid: false });
    wallClockFace(b, at, { r: 0.14, dial: 0, tick: true });
  }
  candle(b, m4.translation(cx - 0.45, y + F + 0.02, 1.09), { h: 0.16, start: 1.1 });
  candle(b, m4.translation(cx + 0.45, y + F + 0.02, 1.09), { h: 0.12, start: 4.4 });
}

// A bookcase: shelves of books, each a box of its own size (the shader colours them)
function bookcase(b, x0, x1) {
  const g = new Geo(), y = -RY, depth = 0.28;
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  g.add(boxAt(x0, x0 + 0.025, y, y + depth, 0, 2.0));
  g.add(boxAt(x1 - 0.025, x1, y, y + depth, 0, 2.0));
  for (let k = 0; k <= 5; k++) g.add(boxAt(x0, x1, y, y + depth, k * 0.38 + 0.05, k * 0.38 + 0.075));
  b.static(subdivide(g, 0.4).color(COL.oakDark).mat(MAT.WOOD));
  const books = new Geo(), rand = rng(77);
  for (let k = 0; k < 5; k++) {
    let x = x0 + 0.03;
    while (x < x1 - 0.06) {
      const w = rand.range(0.018, 0.045), h = rand.range(0.2, 0.31), d = rand.range(0.17, 0.23);
      if (rand() < 0.08) { x += 0.05; continue; }
      // a book: its boards, and a rounded spine facing the room
      books.add(boxAt(x, x + w, y + 0.03, y + 0.03 + d - w * 0.3, k * 0.38 + 0.075, k * 0.38 + 0.075 + h).uvTransform(1, 1));
      books.add(Geo.cylinder(w / 2, h, 12, { caps: true }).scale(1, 0.6, 1).translate(x + w / 2, y + 0.03 + d - w * 0.3, k * 0.38 + 0.075));
      x += w + 0.002;
    }
  }
  b.static(books.color('#ffffff').mat(MAT.BOOK), { solid: false });
}

// ---------------------------------------------------------------- the bench's clutter

// Things lying about that do not move: a tray of wheels waiting to be fitted,
// a vice, a loupe, tools in a rack on the wall, an oil can, jars.
function clutter(b) {
  const rand = rng(23);
  const g = new Geo();
  // a tray of spare wheels and pinions
  const tray = [-0.55, 1.28];
  g.add(Geo.box(0.2, 0.13, 0.006).translate(tray[0], tray[1], BENCH + 0.003).color('#3a2a1e').mat(MAT.WOOD));
  for (const sy of [-1, 1]) g.add(Geo.box(0.2, 0.006, 0.014).translate(tray[0], tray[1] + sy * 0.062, BENCH + 0.007).color('#3a2a1e').mat(MAT.WOOD));
  for (const sx of [-1, 1]) g.add(Geo.box(0.006, 0.13, 0.014).translate(tray[0] + sx * 0.097, tray[1], BENCH + 0.007).color('#3a2a1e').mat(MAT.WOOD));
  for (let i = 0; i < 14; i++) {
    const N = rand.pick([12, 16, 20, 30, 40, 48, 60]), m = rand.range(0.0005, 0.0009);
    const w = (N >= 30 ? spur(N, m, { spokes: rand.int(4, 6) }) : pinion(N, m)).clone();
    w.translate(tray[0] + rand.range(-0.08, 0.08), tray[1] + rand.range(-0.045, 0.045), BENCH + 0.007 + i * 0.0003);
    g.add(w);
  }
  // a bench vice at the front left
  const vice = new Geo();
  vice.add(Geo.box(0.07, 0.1, 0.05).translate(0, 0, 0.025));
  vice.add(Geo.box(0.09, 0.025, 0.045).translate(0, -0.06, 0.07));
  vice.add(Geo.box(0.09, 0.025, 0.045).translate(0, 0.02, 0.07));
  vice.add(rod([[0, -0.16, 0.06], [0, 0.04, 0.06]], 0.006, { seg: 10, step: 0.5 }));
  vice.add(rod([[-0.06, -0.16, 0.06], [0.06, -0.16, 0.06]], 0.004, { seg: 8, step: 0.5 }));
  g.add(vice.color('#4a5560').gloss(0.5).translate(-1.75, 1.2, BENCH));
  // a loupe on a stand
  g.add(Geo.cylinder(0.03, 0.008, 24).translate(-0.36, 1.2, BENCH).color("#222"));
  g.add(rod([[-0.36, 1.2, BENCH + 0.008], [-0.36, 1.2, BENCH + 0.12], [-0.31, 1.19, BENCH + 0.15]], 0.0025, { seg: 8, step: 0.5 }).color(COL.brass).mat(MAT.BRASS));
  g.add(Geo.torus(0.022, 0.003, 32, 6).rotateX(Math.PI / 2 - 0.4).translate(-0.29, 1.19, BENCH + 0.155).color('#222'));
  // an oil can, jars of brushes and screws
  g.add(Geo.lathe([[0.03, 0], [0.032, 0.005], [0.03, 0.05], [0.012, 0.06], [0.004, 0.065], [0.003, 0.12]], 24).translate(1.45, 1.75, BENCH).color(COL.copper).gloss(0.7));
  for (const [x, y, h] of [[0.2, 1.8, 0.09], [0.28, 1.82, 0.07], [-0.3, 1.82, 0.08]]) {
    g.add(Geo.cylinder(0.025, h, 24).translate(x, y, BENCH).color('#c8d8d0').gloss(0.9));
    for (let k = 0; k < 5; k++) g.add(rod([[x + rand.range(-0.01, 0.01), y + rand.range(-0.01, 0.01), BENCH + 0.01], [x + rand.range(-0.03, 0.03), y + rand.range(-0.03, 0.03), BENCH + h + rand.range(0.05, 0.1)]], 0.002, { seg: 5, step: 0.5 }).color(rand.pick(['#6a4a2a', '#2a2a2a', '#8a6a3a'])));
  }
  // a rack of tools on the back wall, over the left of the bench
  g.add(Geo.box(0.6, 0.02, 0.04).translate(-1.1, RY - 0.01, 1.14).color(COL.oakDark).mat(MAT.WOOD));
  for (let k = 0; k < 12; k++) {
    const x = -1.37 + k * 0.05, len = rand.range(0.1, 0.18);
    g.add(rod([[x, RY - 0.025, 1.14], [x, RY - 0.025, 1.14 - len * 0.7]], 0.0018, { seg: 6, step: 0.5 }).color('#9aa0a8').gloss(0.8).mat(MAT.STEEL));
    g.add(Geo.cylinder(0.006, 0.05, 10).translate(x, RY - 0.025, 1.15).color(rand.pick(['#7a3a20', '#2a4a7a', '#3a5a2a', '#6a5a3a'])));
  }
  b.static(g, { solid: false });
  // the loupe's lens
  b.static(Geo.disc(0.021, 32).rotateX(Math.PI / 2 - 0.4).translate(-0.29, 1.19, BENCH + 0.155).color('#e4ecec').gloss(0.95).blend(0.12).doubleSided(), { solid: false });
  benchWork(b);
}

// Where the clockmaker was working, under the loupe: a watch movement open in
// its holder on a square of baize, its balance going, and the tools put down
// round it.  Small things, drawn only from near by: the tools from 4 m (a
// screwdriver's handle is then two pixels across), and the movement's parts
// each from where it is about that size (see below).
function benchWork(b) {
  const at = (x, y, a = 0) => m4.mul(m4.translation(x, y, BENCH), m4.rotationZ(a));
  const rand = rng(57);
  b.static(Geo.box(0.15, 0.1, 0.002).translate(-0.235, 1.215, BENCH + 0.001).color('#2f4a34').mat(MAT.CLOTH), { solid: false });
  // The movement, going.  Its fourth wheel (60 teeth) turns once a minute and
  // drives the escape pinion (6), so that the escape wheel (15 teeth) turns
  // in 6 s, half a tooth at each beat; the pallet fork flicks over at every
  // beat, as the balance swings through the middle (it swings 150 degrees
  // each way and back 2.5 times a second, a watch's 18,000 beats an hour).
  // What is always there: the holder, the plate and the bridges; the wheels
  // and the balance from 4.5 m, where the balance's rim is two pixels across;
  // jewels, screws and the hairspring, a millimetre or so, from 1.5 m.
  const mv = [-0.285, 1.205, BENCH + 0.014], mm = 0.00024;
  const inMv = (x, y, z) => m4.translation(mv[0] + x, mv[1] + y, mv[2] + z);
  const QB = [0.009, 0.004], QE = [0.0005, 0.0005], Q4 = [QE[0] + mm * 33 * Math.cos(3.75), QE[1] + mm * 33 * Math.sin(3.75)];
  const QF = [(QE[0] + QB[0]) / 2 + 0.0004, (QE[1] + QB[1]) / 2 - 0.0003];
  const plain = new Geo();
  plain.add(Geo.lathe([[0, 0], [0.024, 0], [0.024, 0.004], [0.021, 0.006], [0.021, 0.012], [0, 0.012]], 40).translate(0, 0, -0.014).color(COL.brass).gloss(0.7).mat(MAT.BRASS));
  plain.add(Geo.cylinder(0.0195, 0.002, 48, { caps: true }).color('#d4c9a8').gloss(0.75).mat(MAT.BRASS));
  // the bridges, a little above the wheels: the barrel's, the train's over the fourth and escape arbors, the balance cock
  const bridge = (len, wd, a, x, y) => Geo.box(len, wd, 0.0012).translate(len / 2 - 0.003, 0, 0).rotateZ(a).translate(x, y, 0.0052).color('#d9cfa8').gloss(0.8).mat(MAT.BRASS);
  plain.add(bridge(0.018, 0.007, 0.2, -0.011, 0.006));
  plain.add(bridge(0.014, 0.0045, Math.atan2(QE[1] - Q4[1], QE[0] - Q4[0]), Q4[0], Q4[1]));
  const E = [QB[0] + 0.009 * Math.cos(-0.64), QB[1] + 0.009 * Math.sin(-0.64)];
  plain.add(bridge(0.015, 0.0045, Math.atan2(QB[1] - E[1], QB[0] - E[0]), E[0], E[1]));
  b.static(plain, { transform: m4.translation(...mv), solid: false });
  const fine = new Geo();
  for (const [x, y] of [Q4, QE, QB, [-0.0095, 0.0075]]) fine.add(Geo.cylinder(0.0008, 0.0006, 10).translate(x, y, 0.0058).color('#a0141c').gloss(0.95).mat(MAT.PAINT));
  for (const [x, y] of [[-0.017, 0.004], [-0.003, 0.0105], [Q4[0] - 0.002, Q4[1] - 0.0015], [E[0], E[1]]]) fine.add(Geo.cylinder(0.0011, 0.0006, 12).translate(x, y, 0.0058).color('#1d2a4a').gloss(0.8).mat(MAT.BLUED));
  // the hairspring over the balance: a flat spiral, its outer end fixed
  const hs = [];
  for (let k = 0; k <= 72; k++) { const a = k * TAU / 12, r = 0.0007 + 0.0035 * k / 72; hs.push([QB[0] + r * Math.cos(a), QB[1] + r * Math.sin(a), 0.0043]); }
  fine.add(Geo.tube(hs, 0.00012, 3).color('#3a4a6a').gloss(0.8).mat(MAT.STEEL));
  b.static(fine, { transform: m4.translation(...mv), solid: false, within: 1.5 });
  const dirTo = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  const phE = dirTo(QE, Q4) - (0 - dirTo(Q4, QE)) * 60 / 6 + Math.PI / 6;
  const four = spur(60, mm, { spokes: 4, w: 0.0004, bore: 0.0003 });
  cyc(b, four, inMv(Q4[0], Q4[1], 0.0025), 60, 120, (u) => m4.rotationZ(-u * TAU), { shadow: false, within: 4.5 });
  const escW = Geo.merge(pinion(6, mm, { w: 0.0005, bore: 0.0002 }), wheel(15, 0.0019, 0.0026, { tooth: ESCAPE, w: 0.0003, bore: 0.0002, rings: 1 }).translate(0, 0, 0.0005));
  cyc(b, escW, inMv(QE[0], QE[1], 0.0025), 6, 30 * BEAT_POSES, (u) => m4.rotationZ(phE + escPose(Math.round(u * 30 * BEAT_POSES)) * TAU / 30), { shadow: false, within: 4.5 });
  // the pallet fork: towards the escape wheel its two pallets, towards the balance its fork
  const fa = dirTo(QF, QE), fork = new Geo();
  fork.add(Geo.box(0.0055, 0.0005, 0.0003).translate(0.0005, 0, 0));
  fork.add(Geo.box(0.0004, 0.0032, 0.0003).translate(0.0026, 0, 0));
  for (const s of [-1, 1]) fork.add(Geo.box(0.0007, 0.0003, 0.0003).translate(-0.0025, s * 0.0004, 0));
  cyc(b, fork.color(COL.steel).gloss(0.85).mat(MAT.STEEL), inMv(QF[0], QF[1], 0.003), 0.4, 40, (u) => m4.rotationZ(fa + 0.2 * Math.max(-1, Math.min(1, 6 * Math.sin(TAU * u)))), { shadow: false, within: 4.5 });
  const bal = Geo.merge(Geo.torus(0.0052, 0.00045, 32, 4), Geo.box(0.0104, 0.0007, 0.0004),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => Geo.cylinder(0.0005, 0.0006, 6).translate(0.0057, 0, -0.0003).rotateZ(k * TAU / 8 + 0.2))).color(COL.brass).gloss(0.9).mat(MAT.BRASS);
  cyc(b, bal, inMv(QB[0], QB[1], 0.0036), 0.4, 40, (u) => m4.rotationZ(2.6 * Math.sin(TAU * u)), { shadow: false, within: 4.5 });

  // The tools: tweezers, three screwdrivers, a hammer, an oiler and its pot, a bench block
  const t = new Geo();
  const steel = (g) => g.color(COL.steel).gloss(0.85).mat(MAT.STEEL);
  const tweezers = new Geo();
  for (const s of [-1, 1]) tweezers.add(Geo.box(0.11, 0.0022, 0.0009).translate(0.055, 0, 0).rotateZ(s * 0.03).translate(0, 0, 0.0006));
  t.add(steel(tweezers).transform(at(-0.305, 1.252, 0.04)));
  [['#7a1a14', 0.05, 1.29, 0.2], ['#1d4d2e', 0.03, 1.31, 0.35], ['#2a3a6a', 0.04, 1.275, 0.05]].forEach(([col, len, y, a], i) => {
    const sd = new Geo();
    sd.add(Geo.cylinder(0.0042, len, 12).rotateY(Math.PI / 2).translate(-len, 0, 0.0042).color(col).gloss(0.4));
    sd.add(Geo.cylinder(0.0045, 0.006, 12).rotateY(Math.PI / 2).translate(-len - 0.006, 0, 0.0042).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
    sd.add(steel(rod([[0, 0, 0.0042], [0.03, 0, 0.0042]], 0.0011, { seg: 6, step: 0.1 })));
    t.add(sd.transform(at(-0.07 + i * 0.03, y + 0.06, a + 1.4)));
  });
  const hammer = new Geo();
  hammer.add(rod([[0, 0, 0.004], [0.13, 0, 0.004]], 0.0032, { seg: 10, step: 0.2 }).color('#6a4a2a').mat(MAT.WOOD));
  hammer.add(Geo.cylinder(0.0055, 0.032, 16, { caps: true }).rotateX(Math.PI / 2).translate(0.135, 0.016, 0.0055).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  t.add(hammer.transform(at(0.02, 1.32, -0.2)));
  t.add(Geo.lathe([[0, 0], [0.011, 0], [0.012, 0.004], [0.009, 0.014], [0, 0.014]], 24).translate(-0.06, 1.185, BENCH).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  t.add(Geo.cylinder(0.008, 0.004, 24).translate(-0.06, 1.185, BENCH + 0.009).color('#3a2a10').gloss(0.95));
  t.add(steel(rod([[-0.04, 1.172, BENCH + 0.003], [0.0, 1.19, BENCH + 0.003]], 0.0007, { seg: 4, step: 0.1 })));
  t.add(Geo.cylinder(0.022, 0.009, 32, { caps: true }).translate(0.06, 1.19, BENCH).color(COL.brass).gloss(0.7).mat(MAT.BRASS));
  // a few screws and a spare wheel lying about
  for (let i = 0; i < 9; i++) t.add(Geo.cylinder(0.0009, 0.002, 8).rotateX(rand() < 0.5 ? Math.PI / 2 : 0).translate(-0.215 + rand.range(-0.03, 0.03), 1.215 + rand.range(-0.02, 0.02), BENCH + 0.0029).color(rand() < 0.5 ? '#1d2a4a' : COL.steel).gloss(0.8).mat(MAT.STEEL));
  t.add(spur(40, 0.0003, { spokes: 4, w: 0.0006, bore: 0.0004 }).clone().translate(-0.18, 1.18, BENCH + 0.0023));
  b.static(t, { solid: false, within: 4 });
}

// ---------------------------------------------------------------- the watch case

// A glass-topped case of pocket watches against the right-hand wall, each
// lying open on velvet, going: hour and minute hands, and a small seconds
// hand in its own little dial, sweeping round once a minute.
function watchCase(b) {
  const x0 = RX - 0.46, x1 = RX - 0.02, y0 = -1.7, y1 = -0.4, top = 0.86;
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  const g = new Geo();
  g.add(boxAt(x0, x1, y0, y1, 0.08, top - 0.1));                                     // the body
  for (const [x, y] of [[x0 + 0.03, y0 + 0.03], [x1 - 0.03, y0 + 0.03], [x0 + 0.03, y1 - 0.03], [x1 - 0.03, y1 - 0.03]]) g.add(Geo.cylinder(0.022, 0.08, 16).translate(x, y, 0));
  // the glass box's frame
  for (const x of [x0, x1 - 0.02]) g.add(boxAt(x, x + 0.02, y0, y1, top - 0.1, top));
  for (const y of [y0, y1 - 0.02]) g.add(boxAt(x0, x1, y, y + 0.02, top - 0.1, top));
  for (const x of [x0 - 0.01, x1 - 0.03]) g.add(boxAt(x, x + 0.04, y0 - 0.01, y1 + 0.01, top, top + 0.012));
  for (const y of [y0 - 0.01, y1 - 0.03]) g.add(boxAt(x0 - 0.01, x1, y, y + 0.04, top, top + 0.012));
  // drawers in front
  for (let k = 0; k < 3; k++) {
    g.add(boxAt(x0 - 0.008, x0, y0 + 0.05 + k * 0.42, y0 + 0.43 + k * 0.42, 0.14, top - 0.16));
  }
  b.static(subdivide(g, 0.3).color(COL.walnut).gloss(0.6).mat(MAT.WOOD));
  b.static(boxAt(x0 + 0.02, x1 - 0.02, y0 + 0.02, y1 - 0.02, top - 0.1, top - 0.095).color('#4a1418').mat(MAT.CLOTH), { solid: false });
  b.static(Geo.plane(x1 - x0 - 0.04, y1 - y0 - 0.04).translate((x0 + x1) / 2, (y0 + y1) / 2, top - 0.003).color('#d8e4e8').gloss(0.95).blend(0.08), { solid: false });
  // knobs on the drawers
  const knobs = new Geo();
  for (let k = 0; k < 3; k++) knobs.add(Geo.sphere(0.012, 12, 8).translate(x0 - 0.018, y0 + 0.24 + k * 0.42, 0.45));
  b.static(knobs.color(COL.brass).gloss(0.8).mat(MAT.BRASS), { solid: false });
  // the watches: five rows of nine, each a little turned
  const rand = rng(61);
  const caseG = Geo.lathe([[0, -0.0045], [0.012, -0.0045], [0.019, -0.0035], [0.0215, -0.001], [0.022, 0.001], [0.0205, 0.004], [0.019, 0.0045]], 96).color(COL.brass).gloss(0.85).mat(MAT.BRASS);
  const silver = caseG.clone().color('#c8cdd2');
  const bow = Geo.merge(Geo.cylinder(0.003, 0.006, 12).rotateX(-Math.PI / 2).translate(0, 0.021, 0), Geo.torus(0.007, 0.0012, 40, 8).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0.033, 0).rotateY(Math.PI / 2));
  const watches = new Geo();
  const faces = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 9; j++) {
    const x = x0 + 0.065 + i * 0.077 + rand.range(-0.006, 0.006), y = y0 + 0.085 + j * 0.141 + rand.range(-0.012, 0.012), a = rand.range(-0.5, 0.5);
    const m = m4.mul(m4.translation(x, y, top - 0.09), m4.rotationZ(a + Math.PI / 2));
    watches.add((rand() < 0.5 ? caseG : silver).clone().transform(m4.mul(m, m4.translation(0, 0, 0.0045))));
    watches.add(bow.clone().color(COL.brass).gloss(0.8).mat(MAT.BRASS).transform(m4.mul(m, m4.translation(0, 0, 0.0045))));
    faces.push({ m: m4.mul(m, m4.translation(0, 0, 0.0092)), start: rand.range(0, 60) * 0 });
  }
  b.static(watches, { solid: false });
  for (const f of faces) watchFace(b, f.m);
}
// a pocket watch's face (facing +Z, 12 o'clock towards +Y)
function watchFace(b, at) {
  const r = 0.0175;
  const g = Geo.disc(r, 96).color(COL.enamel).gloss(0.4).mat(MAT.DIAL);
  g.add(annulus(0.0032, 0.0046, 24).translate(0, -0.0085, 0.0002).color(COL.enamel).mat(MAT.DIAL).tag(2));
  b.static(g, { transform: at, solid: false });
  const mh = blade(r * 0.8, r * 0.1, (y) => Math.max(0.0004, 0.0011 - 0.03 * Math.max(y, 0)), { step: 0.004, d: 0.0003 });
  const sh = blade(0.0042, 0.001, () => 0.0004, { step: 0.004, d: 0.0002 });
  // (the hour hand is painted on the dial: see MAT.DIAL in the shader)
  cyc(b, mh, m4.mul(at, m4.translation(0, 0, 0.0008)), 3600, 60, (u) => m4.rotationZ(-u * TAU), { shadow: false });
  cyc(b, sh, m4.mul(at, m4.translation(0, -0.0085, 0.0004)), 60, 60, (u) => m4.rotationZ(-u * TAU), { shadow: false });
}

// Panelling round the walls up to the dado: frames and raised panels
function wainscot(b) {
  const g = new Geo(), H = 0.95, d = 0.025;
  const run = (len, place2) => {
    const n = Math.max(1, Math.round(len / 0.55)), w = len / n;
    const part = new Geo();
    part.add(Geo.box(len, 0.012, H).translate(0, 0.006, H / 2));
    part.add(Geo.box(len, d, 0.04).translate(0, d / 2, H - 0.02));
    for (let k = 0; k < n; k++) {
      const cx = -len / 2 + (k + 0.5) * w;
      part.add(Geo.box(w - 0.12, 0.02, H - 0.36).translate(cx, 0.01, H / 2 + 0.04));
      part.add(Geo.box(w - 0.18, 0.026, H - 0.42).translate(cx, 0.013, H / 2 + 0.04));
    }
    g.add(part.transform(place2));
  };
  run(2 * RX, m4.mul(m4.translation(0, -RY, 0), m4.rotationZ(0)));
  run(2 * RY - 0.0, m4.mul(m4.translation(RX, 0, 0), m4.rotationZ(Math.PI / 2)));
  run(2 * RY, m4.mul(m4.translation(-RX, 0, 0), m4.rotationZ(-Math.PI / 2)));
  b.static(subdivide(g, 0.4).color('#6a4a30').gloss(0.35).mat(MAT.WOOD), { solid: false });
}

// ---------------------------------------------------------------- shelves

// A jar, a bottle or a tin: turned shapes, finely round
function vessel(kind, h, r, rand) {
  if (kind === 0) return Geo.lathe([[0, 0], [r, 0], [r * 1.02, h * 0.05], [r, h * 0.85], [r * 0.85, h * 0.9], [r * 0.85, h], [0, h]], 96);                       // a jar
  if (kind === 1) return Geo.lathe([[0, 0], [r, 0], [r, h * 0.55], [r * 0.9, h * 0.62], [r * 0.35, h * 0.75], [r * 0.3, h * 0.95], [r * 0.34, h], [0, h]], 80); // a bottle
  return Geo.lathe([[0, 0], [r, 0], [r, h], [r * 1.02, h], [r * 1.02, h * 1.06], [0, h * 1.06]], 80);                                       // a tin
}

// A clock waiting to be mended: a domed case of wood, a dial, its hands stopped
// at whatever time it stopped.
function stoppedClock(b, at, rand) {
  const g = new Geo();
  g.add(Geo.lathe([[0, 0], [0.075, 0], [0.078, 0.008], [0.07, 0.014], [0.07, 0.11], [0.06, 0.15], [0.035, 0.175], [0, 0.18]], 128).scale(1, 0.55, 1).color(COL.walnut).gloss(0.6).mat(MAT.WOOD));
  g.add(Geo.disc(0.045, 96).rotateX(Math.PI / 2).translate(0, -0.039, 0.095).color(COL.enamel).gloss(0.4).mat(MAT.DIAL).tag(3));
  g.add(Geo.torus(0.047, 0.003, 96, 8).rotateX(Math.PI / 2).translate(0, -0.04, 0.095).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  const h = rand.range(0, 12), mn = rand.range(0, 60);
  g.add(blade(0.026, 0.006, (y) => Math.max(0.001, 0.003 - 0.06 * Math.max(y, 0))).transform(m4.mul(m4.translation(0, -0.041, 0.095), m4.rotationX(Math.PI / 2), m4.rotationZ(-h * TAU / 12), m4.rotationX(Math.PI))));
  g.add(blade(0.038, 0.006, (y) => Math.max(0.0008, 0.0022 - 0.03 * Math.max(y, 0))).transform(m4.mul(m4.translation(0, -0.042, 0.095), m4.rotationX(Math.PI / 2), m4.rotationZ(-mn * TAU / 60), m4.rotationX(Math.PI))));
  b.static(g, { transform: at, solid: false });
}

// A clock's movement taken out of its case: two plates and the wheels between
// them, still (it is not wound)
function looseMovement(b, at, rand) {
  const g = new Geo();
  for (const z of [-0.012, 0.012]) g.add(Geo.box(0.09, 0.11, 0.002).translate(0, 0.055, z).color(COL.brass).gloss(0.7).mat(MAT.BRASS));
  for (const [x, y] of [[-0.04, 0.005], [0.04, 0.005], [-0.04, 0.105], [0.04, 0.105]]) g.add(Geo.cylinder(0.003, 0.024, 10).translate(x, y, -0.012).color(COL.brass).mat(MAT.BRASS));
  const m = 0.0006;
  for (const [N, x, y] of [[64, 0, 0.05], [8, 0.0216, 0.05], [60, 0.0216, 0.05], [30, -0.022, 0.085], [48, 0.015, 0.088]]) {
    const w = N >= 30 ? spur(N, m, { spokes: 4 }) : pinion(N, m);
    g.add(w.clone().rotateZ(rand.range(0, 1)).translate(x, y, rand.range(-0.006, 0.006)));
  }
  b.static(g, { transform: m4.mul(at, m4.rotationX(Math.PI / 2)), solid: false });
}

function shelves(b) {
  const rand = rng(97);
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  const wood = new Geo();
  // the left-hand shelf over the bench (in the sun), and one on the right under the clocks
  const runs = [[-2.3, -0.12, 1.3], [1.35, 2.3, 1.5]];
  for (const [xa, xb, z] of runs) {
    wood.add(boxAt(xa, xb, RY - 0.2, RY, z - 0.02, z));
    for (let x = xa + 0.1; x < xb; x += 0.6) wood.add(Geo.extrude([[0, 0], [0.16, 0], [0, -0.14]], 0.02).rotateX(Math.PI / 2).rotateZ(-Math.PI / 2).translate(x - 0.01, RY - 0.0, z - 0.02));
  }
  b.static(subdivide(wood, 0.4).color(COL.oakDark).gloss(0.4).mat(MAT.WOOD), { solid: false });
  const things = new Geo();
  const glassCols = ['#9ab8a8', '#7a9a6a', '#a88a5a', '#6a7a9a', '#c8c0a8', '#5a6a4a'];
  // On the left-hand shelf, among the jars, a row of eight metronomes all set
  // going together: in a level view they beat in step; tilt the view and they
  // beat one after another along the shelf, a wave running through them.
  const metros = Array.from({ length: 8 }, (_, k) => -2.12 + k * 0.27);
  for (const mx of metros) metronome(b, m4.mul(m4.translation(mx, RY - 0.1, 1.3), m4.scaling(0.8)), { lite: true, shadow: false });
  for (const [xa, xb, z] of runs) {
    let x = xa + 0.04;
    while (x < xb - 0.06) {
      // (on the left-hand shelf only jars, in the gaps between the metronomes)
      const pick = z === 1.3 ? 1 : rand();
      if (z === 1.3) {
        const clash = metros.find((mx) => x + 0.085 > mx - 0.05 && x < mx + 0.05);
        if (clash !== undefined) { x = clash + 0.055; continue; }
      }
      if (pick < 0.12 && xb - x > 0.2) {
        stoppedClock(b, m4.mul(m4.translation(x + 0.08, RY - 0.1, z), m4.rotationZ(rand.range(-0.2, 0.2))), rand);
        x += 0.18;
      } else if (pick < 0.22 && xb - x > 0.14) {
        looseMovement(b, m4.mul(m4.translation(x + 0.06, RY - 0.1, z), m4.rotationZ(rand.range(-0.3, 0.3))), rand);
        x += 0.13;
      } else {
        const kind = rand.int(0, 2), r = rand.range(0.018, z === 1.3 ? 0.03 : 0.04), h = rand.range(0.06, 0.16);
        const v = vessel(kind, h, r, rand).translate(x + r, RY - 0.1 + rand.range(-0.04, 0.04), z);
        v.color(kind === 2 ? rand.pick(['#7a2a1a', '#2a4a6a', '#8a7a3a', '#3a3a3a']) : rand.pick(glassCols)).gloss(kind === 2 ? 0.5 : 0.85);
        things.add(v);
        // what is in the jars: screws, springs, wheels (a darker core)
        if (kind === 0) things.add(Geo.cylinder(r * 0.85, h * 0.5, 64).translate(x + r, v.bounds().min[1] + (v.bounds().max[1] - v.bounds().min[1]) / 2, z + 0.004).color(rand.pick(['#6a5a3a', '#4a4a4a', '#8a6a3a'])));
        x += 2 * r + rand.range(0.005, 0.03);
      }
    }
  }
  b.static(things, { solid: false });
  // drawers along the front of the bench, with turned brass knobs
  const dr = new Geo(), knobs = new Geo();
  for (let k = 0; k < 10; k++) {
    const x = -2.1 + k * 0.465;
    dr.add(boxAt(x - 0.2, x + 0.2, BENCH_Y0 - 0.006, BENCH_Y0 + 0.01, BENCH - 0.19, BENCH - 0.065));
    knobs.add(Geo.lathe([[0, 0], [0.008, 0], [0.006, 0.006], [0.011, 0.014], [0.009, 0.02], [0, 0.021]], 48).rotateX(Math.PI / 2).translate(x, BENCH_Y0 - 0.006, BENCH - 0.128));
  }
  b.static(dr.color('#6a4428').gloss(0.4).mat(MAT.WOOD), { solid: false });
  b.static(knobs.color(COL.brass).gloss(0.85).mat(MAT.BRASS), { solid: false });
  // a watchmaker's lathe on the bench, between the orrery and the engine
  const lt = new Geo();
  lt.add(Geo.box(0.22, 0.03, 0.02).translate(0, 0, 0.01).color('#3a3a3e').gloss(0.6));
  lt.add(Geo.lathe([[0, 0], [0.022, 0], [0.022, 0.02], [0.016, 0.03], [0.016, 0.07], [0.01, 0.075], [0, 0.075]], 40).rotateY(Math.PI / 2).translate(-0.1, 0, 0.05).color('#4a4a50').gloss(0.7).mat(MAT.STEEL));
  lt.add(Geo.lathe([[0, 0], [0.03, 0], [0.03, 0.008], [0.024, 0.008], [0.024, 0.014], [0.03, 0.014], [0.03, 0.022], [0, 0.022]], 48).rotateY(Math.PI / 2).translate(-0.135, 0, 0.05).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  lt.add(Geo.lathe([[0, 0], [0.016, 0], [0.016, 0.05], [0.006, 0.06], [0.002, 0.075], [0, 0.076]], 32).rotateY(-Math.PI / 2).translate(0.1, 0, 0.05).color('#4a4a50').gloss(0.7).mat(MAT.STEEL));
  lt.add(Geo.box(0.03, 0.03, 0.04).translate(0.08, 0, 0.035).color('#3a3a3e'));
  b.static(lt, { transform: m4.mul(m4.translation(0.42, 1.68, BENCH), m4.rotationZ(0.1)), solid: false });
}

// ---------------------------------------------------------------- the clock wall

// A drop-dial: an octagonal surround, a round dial, and below it a trunk with a
// little window in which the bob of its short pendulum swings (once a second
// there and back: a tick every half second).  Faces +Z.
function dropDial(b, at, { r = 0.1, start = 0, dial = 0 } = {}) {
  const g = new Geo();
  const oct = Array.from({ length: 8 }, (_, k) => [r * 1.32 * Math.cos((k + 0.5) * TAU / 8), r * 1.32 * Math.sin((k + 0.5) * TAU / 8)]);
  g.add(Geo.extrude(oct, 0.03).translate(0, 0, -0.03));
  g.add(Geo.extrude([[-r * 0.55, -r * 1.1], [r * 0.55, -r * 1.1], [r * 0.45, -r * 2.4], [0, -r * 2.75], [-r * 0.45, -r * 2.4]], 0.05).translate(0, 0, -0.06));
  g.color(COL.walnut).gloss(0.55).mat(MAT.WOOD);
  g.add(Geo.torus(r * 1.08, r * 0.05, 64, 8).translate(0, 0, 0.002).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  g.add(Geo.box(r * 0.5, r * 0.35, 0.004).translate(0, -r * 1.9, -0.008).color('#1a120c'));
  b.static(g, { transform: at, solid: false });
  b.static(Geo.box(r * 0.5, r * 0.35, 0.002).translate(0, -r * 1.9, -0.009).color('#d8e4e8').gloss(0.95).blend(0.12), { transform: at, solid: false });
  wallClockFace(b, at, { r, dial, bezel: false, tick: true });
  const L = lengthFor(1);
  const pend = Geo.merge(rod([[0, 0, 0], [0, -L, 0]], 0.0012, { seg: 5, step: 0.02 }).color('#555'), lens(0.018, 0.006, 24).translate(0, -L, 0).color(COL.brass).gloss(0.85).mat(MAT.BRASS));
  cyc(b, pend, m4.mul(at, m4.translation(0, -r * 1.9 + L - 0.005, -0.02)), 1, 16, (u) => m4.rotationZ(0.09 * Math.sin(TAU * u)), { start, shadow: false });
}

// A Vienna regulator: a tall glazed case, a pendulum of 0.8 m (1.8 s there
// and back), two brass weights.  Faces +Z.
function regulator(b, at, { start = 0 } = {}) {
  const W = 0.26, H = 1.25, D = 0.12;
  const g = new Geo();
  g.add(Geo.box(W, H, 0.01).translate(0, -H / 2, -D));
  for (const sx of [-1, 1]) g.add(Geo.box(0.022, H, D).translate(sx * (W / 2 - 0.011), -H / 2, -D / 2));
  g.add(Geo.box(W + 0.04, 0.06, D + 0.02).translate(0, 0.03, -D / 2));
  g.add(Geo.box(W + 0.03, 0.05, D + 0.015).translate(0, -H - 0.025, -D / 2));
  g.add(Geo.extrude([[-0.08, 0], [0.08, 0], [0, 0.06]], D).translate(0, 0.06, -D));
  g.add(Geo.cone(0.03, 0.08, 16).rotateX(Math.PI).translate(0, -H - 0.05, -D / 2));
  g.color('#4a2a18').gloss(0.6).mat(MAT.WOOD);
  b.static(g, { transform: at, solid: false });
  b.static(Geo.plane(W - 0.044, H - 0.02).rotateX(0).translate(0, -H / 2, 0.001).color('#d8e4e8').gloss(0.95).blend(0.1), { transform: at, solid: false });
  const face = m4.mul(at, m4.translation(0, -0.12, -0.05));
  b.static(Geo.disc(0.1, 64).color(COL.enamel).gloss(0.35).mat(MAT.DIAL), { transform: face, solid: false });
  wallClockFace(b, face, { r: 0.09, bezel: false, tick: false });
  // (the rod in four pieces of its own: see rodParts)
  const L = lengthFor(1.8), pAt = m4.mul(at, m4.translation(0, -0.2, -0.085)), swing = (u) => m4.rotationZ(0.04 * Math.sin(TAU * u));
  for (const piece of rodParts([0, 0, 0], [0, -L, 0], 4, 0.0016, { seg: 5, step: 0.025 })) cyc(b, piece.color('#2a2a2a'), pAt, 1.8, 24, swing, { start, shadow: false });
  cyc(b, lens(0.045, 0.012, 32).translate(0, -L, 0).color(COL.brass).gloss(0.9).mat(MAT.BRASS), pAt, 1.8, 24, swing, { start, shadow: false });
  const w = new Geo();
  for (const sx of [-1, 1]) {
    w.add(Geo.lathe([[0, 0], [0.018, 0], [0.018, 0.14], [0.012, 0.15], [0, 0.15]], 32).translate(sx * 0.075, -0.6, -0.06));
    w.add(rod([[sx * 0.075, -0.45, -0.06], [sx * 0.075, -0.2, -0.06]], 0.0008, { seg: 4, step: 0.5 }));
  }
  b.static(w.color(COL.brass).gloss(0.85).mat(MAT.BRASS), { transform: at, solid: false });
}

// A turret clock, a church clock's movement brought in for overhaul, going on
// its iron stand: a great wheel turning once an hour with its barrel, a second
// wheel, an escape wheel that turns once a minute in jerks, an anchor and a
// seconds pendulum (two seconds there and back) a metre long.  Faces +Y.
function turretClock(b, at) {
  const Z = 1.0, m = 0.0025, Lf = 0.6;
  const iron = new Geo();
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  // the stand
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) iron.add(boxAt(sx * 0.3 - 0.025, sx * 0.3 + 0.025, sy * 0.16 - 0.025, sy * 0.16 + 0.025, 0, Z));
  for (const sy of [-1, 1]) iron.add(boxAt(-0.33, 0.33, sy * 0.16 - 0.03, sy * 0.16 + 0.03, Z - 0.04, Z));
  // the flatbed's two A-frames, and bars across
  for (const sy of [-1, 1]) {
    iron.add(boxAt(-Lf / 2, Lf / 2, sy * 0.1 - 0.012, sy * 0.1 + 0.012, Z, Z + 0.03));
    for (const x of [-0.22, 0.0, 0.2]) iron.add(Geo.extrude([[-0.05, 0], [0.05, 0], [0.012, 0.24], [-0.012, 0.24]], 0.024).rotateX(Math.PI / 2).translate(x, sy * 0.1 + 0.012, Z + 0.03));
  }
  iron.add(boxAt(-0.04, 0.04, -0.22, 0.13, Z + 0.27, Z + 0.3));     // the cock carrying the pendulum, out in front
  b.static(subdivide(iron, 0.2).color('#2a3a34').gloss(0.4).mat(MAT.PAINT), { transform: at });
  // The train, laid out so that it meshes: the great wheel (90, once an
  // hour) drives a pinion of 12 on the second arbor (8 minutes), whose wheel
  // (64, a finer module, in front) drives the escape pinion of 8 (a minute);
  // the escape wheel is in front of that again.  Each arbor is as far from the
  // last as their pitch circles say, and each pair in one plane.  In this
  // frame the wheels stand across y, x along the frame and z up; y = 0 is the
  // great wheel's plane, the front (the pendulum's side) is towards -y, and
  // the barrel is behind.
  const m2 = 0.002;
  const step = (p, d, deg) => [p[0] + d * Math.cos(deg * Math.PI / 180), p[1] + d * Math.sin(deg * Math.PI / 180)];
  const P0 = [-0.2, Z + 0.15], P1 = step(P0, m * (90 + 12) / 2, 10), P2 = step(P1, m2 * (64 + 8) / 2, 25);
  const piv = [P2[0], P2[1] + 0.078];   // the anchor's and the pendulum's arbor, in the cock
  // arbors (static), the barrel's cable going down through the floor
  const fix = new Geo();
  for (const [x, z] of [P0, P1, P2, piv]) fix.add(Geo.cylinder(0.006, z === piv[1] ? 0.35 : 0.26, 12).rotateX(Math.PI / 2).translate(x, 0.13, z).color(COL.steel).gloss(0.7).mat(MAT.STEEL));
  fix.add(rod([[P0[0] - 0.07, 0.04, P0[1]], [P0[0] - 0.07, 0.04, 0.05]], 0.0025, { seg: 6, step: 0.5 }).color('#6a6a68'));
  b.static(fix, { transform: at, solid: false });
  // (a wheel's own frame: z its axle, towards the back, and y down the frame's z)
  const place = (p, y) => m4.mul(at, m4.translation(p[0], y, p[1]), m4.rotationX(-Math.PI / 2));
  const great = Geo.merge(spur(90, m, { w: 0.008, spokes: 6, bore: 0.006, color: '#8a6a3a' }), Geo.cylinder(0.07, 0.08, 48).translate(0, 0, 0.01).color('#3a3a38'));
  const second = Geo.merge(pinion(12, m, { w: 0.012, color: COL.steel }), spur(64, m2, { w: 0.006, spokes: 5, bore: 0.005, color: '#8a6a3a' }).translate(0, 0, -0.03));
  const escape = Geo.merge(pinion(8, m2, { w: 0.01, color: COL.steel }).translate(0, 0, -0.03), wheel(30, 0.05, 0.062, { tooth: ESCAPE, w: 0.005, spokes: 4, rim: 0.85, bore: 0.005, color: '#9a7a4a' }).translate(0, 0, -0.06));
  // their phases, teeth in gaps (worked out in the wheels' own frame, where z goes down)
  const own = (p) => [p[0], -p[1]];
  const dirTo = (a, c) => Math.atan2(c[1] - a[1], c[0] - a[0]);
  const meshed = (alpha, pa, Na, pb, Nb) => dirTo(own(pb), own(pa)) - (alpha - dirTo(own(pa), own(pb))) * Na / Nb + Math.PI / Nb;
  const ph1 = meshed(0, P0, 90, P1, 12), phE = meshed(ph1, P1, 64, P2, 8);
  // the escape wheel moves half a tooth each beat (a second), in jerks; the rest creep round
  const keysE = 60 * BEAT_POSES;
  cyc(b, great, place(P0, 0), 3600, 120, (u) => m4.rotationZ(-u * TAU), { shadow: false });
  cyc(b, second, place(P1, 0), 480, 96, (u) => m4.rotationZ(ph1 + u * TAU), { shadow: false });
  cyc(b, escape, place(P2, 0), 60, keysE, (u) => m4.rotationZ(phE - escPose(Math.round(u * keysE)) * TAU / 60), { shadow: false });
  // The anchor, in the escape wheel's plane, and the pendulum out in front of
  // the frame, rocking together on one arbor: the anchor's pallets reach down
  // to the escape wheel's teeth either side of its top.  (The rod in five
  // pieces of its own: see rodParts.)
  const L = lengthFor(2), pAt = m4.mul(at, m4.translation(piv[0], 0, piv[1])), swing = (u) => m4.rotationY(0.05 * Math.sin(TAU * u));
  const anchor = new Geo();
  for (const sx of [-1, 1]) {
    const a = 0.6, tip = [sx * 0.062 * Math.sin(a), 0, P2[1] - piv[1] + 0.062 * Math.cos(a)];
    anchor.add(rod([[0, 0, 0], [tip[0] * 0.75, 0, tip[2] * 0.35], tip], 0.003, { seg: 6, step: 0.012 }));
    anchor.add(Geo.box(0.006, 0.006, 0.012).rotateY(-sx * a).translate(tip[0], 0, tip[2]));
  }
  anchor.add(Geo.cylinder(0.012, 0.008, 16).rotateX(Math.PI / 2).translate(0, 0.004, 0));
  cyc(b, anchor.translate(0, -0.06, 0).color(COL.steel).gloss(0.7).mat(MAT.STEEL), pAt, 2, 24, swing, { shadow: false });
  const pend = [...rodParts([0, -0.205, 0], [0, -0.205, -L], 5, 0.004, { seg: 6, step: 0.025 }).map((g) => g.color('#3a3632')),
    Geo.cylinder(0.06, 0.05, 40).rotateX(Math.PI / 2).translate(0, -0.18, -L).color('#5a5a58').gloss(0.5)];
  for (const piece of pend) cyc(b, piece, pAt, 2, 24, swing, { shadow: false });
  // a setting dial on the frame's end, its minute hand driven from the great wheel
  const dialAt = m4.mul(at, m4.translation(Lf / 2 + 0.01, 0, Z + 0.16), m4.rotationZ(Math.PI / 2), m4.rotationX(Math.PI / 2));
  b.static(Geo.disc(0.07, 48).color(COL.enamel).mat(MAT.DIAL), { transform: dialAt, solid: false });
  wallClockFace(b, dialAt, { r: 0.065, bezel: true, tick: true });
}

// A model beam engine: a vertical cylinder whose piston rocks a beam on its
// pillars, and from the beam's other end a connecting rod turns a crank and a
// flywheel, once round in 5 s.  The beam's angle is worked out from the crank
// for every pose (the linkage closes exactly), 40 poses to the turn.  All of it
// moves in one upright plane.  Faces -Y (towards the room).
function beamEngine(b, at) {
  const T = 5, keys = 40;
  const Zb = 0.3, A = 0.17, B = 0.17;              // beam pivot height, half-lengths of the beam
  const xc = 0.2, zc = 0.1, R = 0.045, l = 0.2;    // crank shaft, crank throw, connecting rod
  const crank = (u) => TAU * u;
  const pin = (u) => [xc + R * Math.cos(crank(u)), zc + R * Math.sin(crank(u))];
  const end = (phi) => [B * Math.cos(phi), Zb - B * Math.sin(phi)];
  // the beam's angle for which the rod from the pin to the beam's end is l long
  const beamAt = (u) => {
    const k = pin(u);
    let lo = -0.6, hi = 0.6;
    const f = (phi) => { const e = end(phi); return Math.hypot(e[0] - k[0], e[1] - k[1]) - l; };
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  };
  const g = new Geo();
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  g.add(boxAt(-0.26, 0.32, -0.07, 0.07, 0, 0.015).color(COL.walnut).mat(MAT.WOOD));
  // the beam's pillars (an A-frame either side) and the bearing
  for (const y of [-0.03, 0.03]) for (const sx of [-1, 1]) g.add(rod([[sx * 0.06, y, 0.015], [0, y, Zb]], 0.004, { seg: 8, step: 0.5 }).color('#2a3a34').gloss(0.5));
  // the cylinder, on the left, standing up
  g.add(Geo.lathe([[0.03, 0], [0.034, 0.005], [0.03, 0.01], [0.028, 0.1], [0.032, 0.105], [0.032, 0.115], [0, 0.115]], 48).translate(-A, 0, 0.015).color('#6a4a2e').gloss(0.4).mat(MAT.WOOD));
  for (const z of [0.025, 0.11]) g.add(Geo.torus(0.031, 0.003, 48, 6).translate(-A, 0, z).color(COL.brass).gloss(0.85).mat(MAT.BRASS));
  // the crank shaft's bearings and the shaft
  for (const y of [-0.035, 0.035]) g.add(boxAt(xc - 0.012, xc + 0.012, y - 0.006, y + 0.006, 0.015, zc + 0.008).color('#2a3a34'));
  g.add(Geo.cylinder(0.005, 0.12, 12).rotateX(Math.PI / 2).translate(xc, 0.06, zc).color(COL.steel).gloss(0.8).mat(MAT.STEEL));
  b.static(g, { transform: at, solid: false });
  // (moving parts: in this frame x along the engine, z up, y towards the back)
  const piv = (x, z) => m4.mul(at, m4.translation(x, 0, z));
  // the beam: a long diamond-shaped plate in pieces, rocking about its middle
  const beam = Geo.merge(Geo.extrude([[-A - 0.01, -0.006], [0, -0.022], [B + 0.01, -0.006], [B + 0.01, 0.006], [0, 0.022], [-A - 0.01, 0.006]], 0.008).rotateX(Math.PI / 2).translate(0, 0.004, 0),
    Geo.cylinder(0.008, 0.02, 16).rotateX(Math.PI / 2).translate(0, 0.01, 0)).color('#3a4a42').gloss(0.5);
  cyc(b, subdivide(beam, 0.04), piv(0, Zb), T, keys, (u) => m4.rotationY(beamAt(u)), { shadow: false });
  // the piston rod, sliding straight up and down out of the cylinder to the beam's left end
  const prod = rod([[0, 0, -0.19], [0, 0, 0]], 0.0025, { seg: 8, step: 0.012 }).color(COL.steel).gloss(0.85).mat(MAT.STEEL);
  cyc(b, prod, piv(-A, 0), T, keys, (u) => m4.translation(0, 0, Zb + A * Math.sin(beamAt(u))), { shadow: false });
  // the connecting rod from the beam's right end down to the crank pin
  const crod = Geo.merge(rod([[0, 0, 0], [l, 0, 0]], 0.003, { seg: 8, step: 0.012 }), Geo.box(0.012, 0.01, 0.012), Geo.box(0.012, 0.01, 0.012).translate(l, 0, 0)).color(COL.steel).gloss(0.8).mat(MAT.STEEL);
  cyc(b, crod, piv(0, 0).map((v, i) => (i === 13 ? v - 0.012 : v)), T, keys, (u) => {
    const k = pin(u), e = end(beamAt(u));
    return m4.mul(m4.translation(k[0], 0, k[1]), m4.rotationY(-Math.atan2(e[1] - k[1], e[0] - k[0])));
  }, { shadow: false });
  // the crank and the flywheel, turning together
  // (two meshes: each is drawn at the steps that its own depth asks for)
  const fly = wheel(40, 0.095, 0.095, { tooth: [[-0.25, 0], [0.25, 0]], w: 0.01, bore: 0.006, rings: 6, spokes: 6, rim: 0.82, color: '#6a2218', gloss: 0.6 }).rotateX(Math.PI / 2);
  cyc(b, fly, piv(xc, zc).map((v, i) => (i === 13 ? v + 0.045 : v)), T, keys, (u) => m4.rotationY(-crank(u)), { shadow: false });
  // (its pin points forward, to the connecting rod)
  const crankArm = subdivide(Geo.merge(Geo.box(R + 0.012, 0.006, 0.016).translate(R / 2, 0, 0), Geo.cylinder(0.004, 0.02, 10).rotateX(-Math.PI / 2).translate(R, 0, 0)).color('#6a2218'), 0.01);
  cyc(b, crankArm, piv(xc, zc).map((v, i) => (i === 13 ? v - 0.03 : v)), T, keys, (u) => m4.rotationY(-crank(u)), { shadow: false });
}

// ---------------------------------------------------------------- more life

// Moths at the lamp: each flutters round under the shade on a looping path of
// its own (7, 9 and 11 s round), its wings beating eight times a second.
function moths(b) {
  const c = [2.12, 1.52, 1.2];
  // a furry body with a head and feelers, and each wing (fore and hind as one) a fan of five triangles, pale buff
  const body = Geo.merge(Geo.sphere(1, 8, 5).scale(0.003, 0.011, 0.003), Geo.sphere(0.0028, 8, 5).translate(0, 0.01, 0.0006),
    ...[-1, 1].map((sx) => rod([[sx * 0.001, 0.012, 0.001], [sx * 0.003, 0.016, 0.003], [sx * 0.006, 0.019, 0.003]], 0.00025, { seg: 3, step: 0.01 }))).color('#6a5a48').mat(MAT.FUR);
  const wing = (side) => {
    const rim = [[0.0, 0.006], [0.005, 0.008], [0.013, 0.006], [0.017, 0.0], [0.013, -0.006], [0.006, -0.01], [0.0, -0.006]];
    const g = new Geo();
    for (let k = 0; k + 1 < rim.length; k++) g.add(Geo.triangle([0, 0.001, 0], [side * rim[k][0], rim[k][1], 0], [side * rim[k + 1][0], rim[k + 1][1], 0]));
    return g.doubleSided().color('#c8b48e').mat(MAT.FUR);
  };
  const wings = [wing(1), wing(-1)];
  [[7, 0.09, 0.0], [9, 0.07, 2.0], [11, 0.11, 4.1]].forEach(([T, R, ph], i) => {
    const flaps = 8 * T, keys = flaps * 4;
    const pos = (u) => {
      const a = TAU * u + ph;
      return [c[0] + R * Math.cos(a), c[1] + R * 0.8 * Math.sin(a) + 0.025 * Math.sin(3 * a), c[2] + 0.03 * Math.sin(2 * a + ph) - 0.01 * i];
    };
    const at = (u) => {
      const p = pos(u), q = pos(u + 0.01);
      return m4.mul(m4.translation(...p), m4.rotationZ(Math.atan2(q[1] - p[1], q[0] - p[0]) - Math.PI / 2), m4.rotationY(0.3 * Math.sin(TAU * 3 * u)));
    };
    cyc(b, body, m4.identity(), T, keys, at, { shadow: false });
    wings.forEach((w, side) => cyc(b, w, m4.identity(), T, keys, (u) => m4.mul(at(u), m4.rotationY((side ? -1 : 1) * 0.9 * Math.sin(TAU * flaps * u))), { shadow: false }));
  });
}

// A gyroscope on its tower: the rotor spins too fast to see, and the whole
// thing, held out level on its pivot, walks round (precesses) once in 12 s,
// nodding a little as it goes.
function gyroscope(b, at) {
  const g = new Geo();
  g.add(Geo.lathe([[0, 0], [0.03, 0], [0.03, 0.006], [0.008, 0.012], [0.006, 0.07], [0.004, 0.075], [0, 0.076]], 32).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  b.static(g, { transform: at, solid: false });
  const gyro = new Geo();
  // the frame ring round the rotor (in the y-z plane), its ball end resting on the tower's tip
  gyro.add(Geo.torus(0.035, 0.0022, 48, 6).rotateY(Math.PI / 2).translate(0.045, 0, 0));
  gyro.add(rod([[0, 0, 0], [0.01, 0, 0]], 0.002, { seg: 8, step: 0.01 }));
  gyro.add(rod([[0.08, 0, 0], [0.09, 0, 0]], 0.002, { seg: 8, step: 0.01 }));
  gyro.add(Geo.sphere(0.003, 10, 6));
  gyro.color(COL.steel).gloss(0.85).mat(MAT.STEEL);
  // the rotor: a heavy brass disc on its axle (it spins about x; a round disc spinning looks still)
  gyro.add(Geo.cylinder(0.031, 0.008, 48).rotateY(Math.PI / 2).translate(0.041, 0, 0).color(COL.brass).gloss(0.9).mat(MAT.BRASS));
  gyro.add(rod([[0.01, 0, 0], [0.08, 0, 0]], 0.0015, { seg: 6, step: 0.02 }).color(COL.steel).mat(MAT.STEEL));
  cyc(b, gyro, m4.mul(at, m4.translation(0, 0, 0.078)), 12, 72, (u) => m4.mul(m4.rotationZ(TAU * u), m4.rotationY(-0.06 - 0.03 * Math.sin(TAU * 4 * u))), { shadow: false });
}

// A cuckoo clock on the right-hand wall: a carved house, a short pendulum,
// pine-cone weights, and every half minute the little door opens, the bird
// comes out, bows twice as it calls, and goes back in.  Faces +Z.
function cuckooClock(b, at) {
  const g = new Geo();
  const W = 0.22, H = 0.26;
  g.add(Geo.box(W, H, 0.1).translate(0, 0, -0.05));
  g.add(Geo.extrude([[-W / 2 - 0.04, 0], [W / 2 + 0.04, 0], [0, 0.11]], 0.12).translate(0, H / 2, -0.11));     // the roof
  for (let k = 0; k < 7; k++) g.add(Geo.sphere(0.018, 10, 7).scale(1.4, 0.8, 0.4).translate(-0.09 + k * 0.03, -H / 2 - 0.01, 0.0));   // carved leaves
  g.add(Geo.box(0.05, 0.05, 0.012).translate(0, H / 2 - 0.03, -0.003).color('#2a1a10'));                           // the doorway, dark
  g.color('#5a3820').gloss(0.4).mat(MAT.WOOD);
  b.static(g, { transform: at, solid: false });
  const face = m4.mul(at, m4.translation(0, -0.03, 0.002));
  b.static(Geo.disc(0.07, 48).color('#f0e6d0').mat(MAT.DIAL), { transform: face, solid: false });
  // (no seconds hand: a cuckoo clock has none)
  wallClockFace(b, face, { r: 0.065, bezel: false, seconds: false });
  // weights on chains, and the pendulum (a carved leaf on a rod: 0.9 s there and back)
  const w = new Geo();
  for (const sx of [-0.05, 0.05]) {
    w.add(rod([[sx, -H / 2, -0.04], [sx, -H / 2 - 0.45, -0.04]], 0.0012, { seg: 4, step: 0.5 }).color('#6a6050'));
    w.add(Geo.lathe([[0, 0], [0.016, 0.01], [0.018, 0.05], [0.012, 0.09], [0, 0.1]], 16).rotateX(Math.PI).translate(sx, -H / 2 - 0.45, -0.04).color('#3a2a1a'));
  }
  b.static(w, { transform: at, solid: false });
  const L = lengthFor(0.9);
  const pend = Geo.merge(rod([[0, 0, 0], [0, -L, 0]], 0.0012, { seg: 5, step: 0.02 }).color('#555'), Geo.sphere(1, 16, 10).scale(0.025, 0.035, 0.004).translate(0, -L, 0).color('#5a3820').mat(MAT.WOOD));
  cyc(b, pend, m4.mul(at, m4.translation(0, -H / 2 + 0.04, -0.075)), 0.9, 16, (u) => m4.rotationZ(0.12 * Math.sin(TAU * u)), { shadow: false });
  // the door and the bird: a 30 s round, a pose every 50 ms
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const open = (t) => ease(t / 0.4) - ease((t - 2.6) / 0.4);
  const out = (t) => ease((t - 0.3) / 0.5) - ease((t - 2.1) / 0.5);
  const bow = (t) => 0.5 * (Math.max(0, Math.sin(Math.PI * (t - 0.9) / 0.5)) * (t > 0.9 && t < 1.4) + Math.max(0, Math.sin(Math.PI * (t - 1.5) / 0.5)) * (t > 1.5 && t < 2.0));
  const keys = 600;
  const door = subdivide(Geo.box(0.05, 0.05, 0.004).translate(0.025, 0, 0.002).color('#6a4428').mat(MAT.WOOD), 0.01);
  cyc(b, door, m4.mul(at, m4.translation(-0.025, H / 2 - 0.03, 0.003)), 30, keys, (u) => m4.rotationY(-1.9 * open(u * 30)), { shadow: false });
  const bird = Geo.merge(Geo.sphere(1, 14, 10).scale(0.012, 0.01, 0.016), Geo.sphere(0.008, 12, 8).translate(0, 0.012, 0.012), Geo.cone(0.003, 0.01, 8).rotateX(Math.PI / 2).translate(0, 0.012, 0.02),
    Geo.box(0.02, 0.003, 0.012).translate(0, -0.004, -0.016)).color('#8a5a2a').gloss(0.4).mat(MAT.PAINT);
  cyc(b, bird, m4.mul(at, m4.translation(0, H / 2 - 0.035, -0.03)), 30, keys, (u) => { const t = u * 30; return m4.mul(m4.translation(0, 0, 0.055 * out(t)), m4.rotationX(bow(t))); }, { shadow: false });
}

// ---------------------------------------------------------------- the hearth side

// A rug in front of the fire, its border and pattern painted by the shader, a
// fringe at both ends; fire irons and a coal scuttle on the hearth.
function hearthSide(b) {
  const rug = Geo.plane(1.9, 1.2, 76, 48).translate(-0.35, -0.85, 0.004).color('#7a2a20').mat(MAT.RUG);
  b.static(rug, { solid: false });
  const fringe = new Geo();
  for (const y of [-1.45, -0.25]) for (let k = 0; k < 60; k++) fringe.add(Geo.box(0.004, 0.035, 0.002).translate(-1.29 + k * 0.032, y + (y < -1 ? -0.017 : 0.017), 0.004));
  b.static(fringe.color('#c8b890'), { solid: false });
  const irons = new Geo(), cx = 0.45 + 0.75, y = -RY + 0.4;
  irons.add(Geo.lathe([[0, 0], [0.06, 0], [0.06, 0.008], [0.015, 0.016], [0.012, 0.06], [0.02, 0.07], [0, 0.075]], 48).translate(cx, y, 0.03));
  irons.add(rod([[cx, y, 0.1], [cx, y, 0.7]], 0.006, { seg: 10, step: 0.5 }));
  for (const [a, len] of [[0.1, 0.62], [-0.12, 0.6], [0.25, 0.58]]) {
    irons.add(rod([[cx, y, 0.7], [cx + Math.sin(a) * 0.2, y + Math.cos(a) * 0.02, 0.7 - len]], 0.005, { seg: 8, step: 0.5 }));
    irons.add(Geo.sphere(0.014, 16, 10).translate(cx, y, 0.72));
  }
  b.static(irons.color(COL.brass).gloss(0.8).mat(MAT.BRASS), { solid: false });
  const scuttle = Geo.lathe([[0, 0], [0.12, 0], [0.13, 0.02], [0.13, 0.2], [0.115, 0.26], [0.12, 0.28], [0, 0.28]], 64).color(COL.copper).gloss(0.7);
  scuttle.add(Geo.torus(0.1, 0.008, 48, 8).rotateX(Math.PI / 2).translate(0, 0, 0.3).color(COL.brass).gloss(0.8).mat(MAT.BRASS));
  b.static(scuttle, { transform: m4.translation(-0.35, -RY + 0.3, 0.0) });
}

// A stool at the bench, where the clockmaker sits to work under the loupe:
// a turned seat on three splayed legs, with a ring between them.  The seat
// is solid; the legs are not (they would only snag a walker).
function stool(b, x, y) {
  const H = 0.6, at = m4.translation(x, y, 0);
  b.static(Geo.lathe([[0, 0], [0.165, 0], [0.175, 0.012], [0.175, 0.028], [0.165, 0.04], [0, 0.04]], 48).translate(0, 0, H - 0.04).color(COL.walnut).gloss(0.45).mat(MAT.WOOD), { transform: at });
  const legs = new Geo();
  for (let k = 0; k < 3; k++) {
    const a = k * TAU / 3 + 0.4;
    legs.add(rod([[0.1 * Math.cos(a), 0.1 * Math.sin(a), H - 0.04], [0.19 * Math.cos(a), 0.19 * Math.sin(a), 0]], 0.015, { seg: 10, step: 0.2 }));
  }
  legs.add(Geo.torus(0.158, 0.007, 48, 6).translate(0, 0, 0.2));
  b.static(legs.color(COL.walnut).gloss(0.45).mat(MAT.WOOD), { transform: at, solid: false });
}

// A framed drawing of an anchor escapement, under glass (the shader draws
// it: see MAT.DRAWING).  Faces +Z.
function drawing(b, at) {
  const W = 0.34, H = 0.46, f = 0.03;
  b.static(Geo.plane(W, H, 4, 6).translate(0, 0, 0.008).color('#ffffff').mat(MAT.DRAWING), { transform: at, solid: false });
  const fr = new Geo();
  for (const sy of [-1, 1]) fr.add(Geo.box(W + 2 * f, f, 0.022).translate(0, sy * (H + f) / 2, 0.011));
  for (const sx of [-1, 1]) fr.add(Geo.box(f, H, 0.022).translate(sx * (W + f) / 2, 0, 0.011));
  b.static(fr.color('#3a2416').gloss(0.5).mat(MAT.WOOD), { transform: at, solid: false });
  b.static(Geo.plane(W, H).translate(0, 0, 0.017).color('#dfe8e4').gloss(0.9).blend(0.06), { transform: at, solid: false });
}

// A cabinet of little drawers for parts, against the left-hand wall by the
// front corner: eight rows of six, each with a brass label holder and a
// turned knob.
function partsCabinet(b) {
  const x0 = -RX, depth = 0.34, y0 = -1.86, y1 = -1.3, H = 1.22;
  const boxAt = (xa, xb, ya, yb, za, zb) => Geo.box(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2);
  const g = new Geo();
  g.add(boxAt(x0, x0 + depth, y0, y1, 0.06, H));
  g.add(boxAt(x0, x0 + depth + 0.03, y0 - 0.02, y1 + 0.02, H, H + 0.03));
  g.add(boxAt(x0, x0 + depth + 0.01, y0 - 0.01, y1 + 0.01, 0, 0.06));
  b.static(subdivide(g, 0.3).color(COL.walnut).gloss(0.5).mat(MAT.WOOD));
  const fronts = new Geo(), brass = new Geo();
  const rows = 8, cols = 6, dw = (y1 - y0 - 0.02) / cols, dh = (H - 0.1) / rows;
  const knob = Geo.lathe([[0, 0], [0.006, 0], [0.004, 0.005], [0.008, 0.012], [0.0065, 0.016], [0, 0.017]], 32).rotateY(Math.PI / 2);
  const holder = Geo.merge(Geo.box(0.002, 0.04, 0.022), Geo.box(0.003, 0.034, 0.003).translate(0.001, 0, -0.011));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const y = y0 + 0.01 + (c + 0.5) * dw, z = 0.09 + (r + 0.5) * dh;
    fronts.add(boxAt(x0 + depth, x0 + depth + 0.012, y - dw / 2 + 0.004, y + dw / 2 - 0.004, z - dh / 2 + 0.004, z + dh / 2 - 0.004));
    brass.add(knob.clone().translate(x0 + depth + 0.012, y, z - 0.015));
    brass.add(holder.clone().translate(x0 + depth + 0.013, y, z + 0.022));
  }
  b.static(fronts.color('#5a3a22').gloss(0.45).mat(MAT.WOOD), { solid: false });
  b.static(brass.color(COL.brass).gloss(0.85).mat(MAT.BRASS), { solid: false });
}

// An oil lamp hanging from the middle beam (not lit: it is still day), and a
// geranium on the window sill in the sun.
function lampAndPlant(b) {
  const g = new Geo(), x = 0.0, y = -0.3, z = 2.05;
  g.add(rod([[x, y, RZ - 0.16], [x, y, z + 0.3]], 0.003, { seg: 8, step: 0.5 }));
  g.add(Geo.lathe([[0, 0], [0.09, 0.0], [0.11, 0.015], [0.1, 0.03], [0.05, 0.05], [0.03, 0.09], [0.045, 0.12], [0.04, 0.13], [0, 0.13]], 128).translate(x, y, z - 0.05));
  g.add(Geo.torus(0.16, 0.006, 128, 8).translate(x, y, z + 0.06));
  for (let k = 0; k < 3; k++) { const a = k * TAU / 3; g.add(rod([[x + 0.16 * Math.cos(a), y + 0.16 * Math.sin(a), z + 0.06], [x, y, z + 0.3]], 0.0025, { seg: 6, step: 0.5 })); }
  g.color(COL.brass).gloss(0.8).mat(MAT.BRASS);
  g.add(Geo.lathe([[0.035, 0], [0.045, 0.04], [0.042, 0.09], [0.025, 0.13], [0.02, 0.2], [0.022, 0.22], [0, 0.22]], 96).translate(x, y, z + 0.08).color('#e0e8e8').gloss(0.95));
  g.add(Geo.lathe([[0, 0], [0.14, 0.05], [0.16, 0.06], [0.04, 0.1], [0, 0.1]], 128).translate(x, y, z + 0.32).color('#f0ece0').gloss(0.5));
  b.static(g, { solid: false });
  // the geranium: a clay pot, stems, round leaves, red flower heads
  const rand = rng(31), p = new Geo(), [px, py, pz] = [-RX + 0.04, 0.45, WIN.z0];
  p.add(Geo.lathe([[0, 0], [0.05, 0], [0.065, 0.1], [0.07, 0.1], [0.07, 0.115], [0, 0.115]], 48).color('#a85a3a'));
  const leaves = new Geo(), flowers = new Geo();
  for (let k = 0; k < 22; k++) {
    const a = rand.range(0, TAU), r = rand.range(0.02, 0.12), h = rand.range(0.13, 0.3);
    const tip = [r * Math.cos(a), r * Math.sin(a) * 0.8, h];
    p.add(rod([[0, 0, 0.1], [tip[0] * 0.5, tip[1] * 0.5, h * 0.8], tip], 0.002, { seg: 5, step: 0.04 }).color('#4a6a2a'));
    const leaf = Geo.disc(rand.range(0.025, 0.04), 16);
    for (let i = 0; i < leaf.vertexCount; i++) { const d = Math.hypot(leaf.p[i * 3], leaf.p[i * 3 + 1]); leaf.p[i * 3 + 2] = -6 * d * d; }
    leaves.add(leaf.computeNormals().doubleSided().transform(m4.mul(m4.translation(...tip), m4.rotationZ(a), m4.rotationY(rand.range(-0.4, 0.4)))));
    if (k % 4 === 0) for (let f = 0; f < 9; f++) flowers.add(Geo.sphere(0.007, 8, 6).translate(tip[0] + rand.range(-0.015, 0.015), tip[1] + rand.range(-0.015, 0.015), tip[2] + 0.06 + rand.range(-0.01, 0.01)));
  }
  p.add(leaves.color('#3a6a2a').gloss(0.3)).add(flowers.color('#c8202a'));
  b.static(p, { transform: m4.translation(px + 0.1, py, pz), solid: false });
}

// ---------------------------------------------------------------- the scene

export default {
  id: 'workshop',
  name: 'Clockmaker\'s Workshop',
  blurb: 'A clockmaker\'s workshop on a late afternoon: a sunbeam across the bench, and hundreds of wheels, pendulums, hands and small creatures moving at a few centimetres a second.',
  C,
  mode: 'walk',
  modes: ['walk', 'fly'],
  spawn: { pos: [0, 0.2, 0], t: T_SPAWN, yaw: 0, pitch: -13 },
  period: P,
  viewDistance: 9,
  skyDistance: 60,
  exposure: 1.6,
  bloom: 0.25,
  // two shadow maps laid out about the sunlit end of the bench: a fine one
  // (1.6 mm a pixel) over the clockwork in the sun, and one over the whole room
  shadowRadii: [1.6, 6],
  shadowCentre: [-1.0, 1.3, 1.1],
  shadowDepth: 8,
  near: 0.01,
  body: { walk: { r: 0.2 }, fly: { r: 0.03 } },
  solidGrid: 0.25,
  walkSpeed: 0.2,
  runSpeed: 0.5,
  // A hop, not the engine's leap of 1.27 m: one that reaches C metres (30 cm,
  // in half a second).  In a view tilted up, where a jump goes through time,
  // that keeps it to the room's own scale: at 90 degrees one second forward
  // and back, a tick of the clocks, and at 45 21 cm up and 0.7 s.  In a
  // level view the head stays well clear of the ceiling beams.  There is
  // nothing here to be climbed: the lowest thing that can be stood on is the
  // armchair's cushion, 49 cm up, and the bench leaves no room for a head.
  jumpSpeed: Math.sqrt(2 * GRAV * C),
  eyeHeight: { walk: 1.6 },
  ceiling: RZ - 0.05,
  wgsl,

  // The music: the music box's own tune, note for note as its pins pluck the
  // comb (30 s, once round the cylinder), over a soft wash of its chords, and
  // the clocks ticking on every whole second.
  music: {
    seconds: TUNE_SECONDS, reverb: 1.6, echo: [0.5, 0.18], seed: 5,
    build(m) {
      const box = m.track({ pan: 0.15, hall: 0.35, echo: 0.12 });
      const soft = m.track({ hall: 0.6, lowpass: 1800 });
      const clock = m.track({ pan: -0.25, hall: 0.15, gain: 0.8 });
      for (const n of TUNE) m.bell(box, n.t, TEETH_MIDI[n.tooth], { partials: 'box', gain: n.tooth < 5 ? 0.16 : 0.2, decay: 1.8 });
      const chords = { D: 'D3 A3 F#4', G: 'G3 B3 D4', A: 'A3 C#4 E4', Bm: 'B2 F#3 D4' };
      'D D G D A A D D G G D Bm G A D D D G A D'.split(' ').forEach((c, i) => m.pad(soft, i * 1.5, 1.5, m.notes(chords[c]), { type: 'triangle', cutoff: 900, gain: 0.03, a: 0.5, r: 0.8 }));
      for (let t = 0; t < TUNE_SECONDS; t++) m.tick(clock, t, t % 2 ? 0.55 : 0.7, t % 2 ? 1900 : 2300);
    },
  },

  build(b) {
    room(b);
    // the bench
    {
      const g = new Geo();
      const boxAt = (x0, x1, y0, y1, z0, z1) => Geo.box(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      g.add(boxAt(-RX + 0.05, RX - 0.05, BENCH_Y0 + 0.01, BENCH_Y0 + 0.03, BENCH - 0.2, BENCH - 0.05));
      for (const x of [-RX + 0.1, -0.8, 0.8, RX - 0.1]) for (const y of [BENCH_Y0 + 0.05, RY - 0.05]) g.add(boxAt(x - 0.04, x + 0.04, y - 0.04, y + 0.04, 0, BENCH - 0.05));
      g.color(COL.oak).mat(MAT.WOOD);
      // (the top has a material of its own, for its wear: see MAT.BENCH in the shader)
      g.add(boxAt(-RX + 0.05, RX - 0.05, BENCH_Y0, RY, BENCH - 0.05, BENCH).color(COL.oak).mat(MAT.BENCH));
      b.static(subdivide(g, 0.5));
    }
    stool(b, -0.3, 0.85);
    drawing(b, onWall('right', [RX - 0.012, -0.22, 1.5]));
    // wall clocks over the bench
    wallClock(b, onWall('back', [-1.75, RY - 0.07, 1.78]), { r: 0.13 });
    wallClock(b, onWall('back', [-0.55, RY - 0.07, 1.86]), { r: 0.1, dial: 1, tick: false });
    wallClock(b, onWall('back', [0.65, RY - 0.07, 1.8]), { r: 0.15 });
    // a second board of wheels on the back wall, over the lamp
    {
      const at = onWall('back', [0, RY - 0.02, 0]);
      train(b, at, 0.003, [
        { N: 60, pos: [1.5, 1.95], T: 120, sense: -1 },
        { N: 20, on: 0, dir: 0 },
        { N: 50, with: 1 },
        { N: 25, on: 2, dir: 20 },
        { N: 45, on: 3, dir: -30 },
        { N: 30, on: 4, dir: 25 },
        { N: 45, on: 5, dir: -20 },
        { N: 20, on: 6, dir: 40 },
        { N: 36, on: 0, dir: 200 },
      ], { faceZ: 0.006, board: ['#7a5a40', 0.018] });
    }
    // the skeleton clock, in the sun
    skeletonClock(b, place([-1.35, 1.5, BENCH]));
    cradle(b, m4.translation(-2.0, 1.45, BENCH));
    pendulumWave(b, m4.translation(-0.98, 1.5, BENCH));
    orrery(b, m4.translation(0.0, 1.5, BENCH));
    metronome(b, m4.translation(1.55, 1.45, BENCH));
    steamEngine(b, m4.translation(0.78, 1.42, BENCH));
    // the wheel board on the back wall, between the clocks
    {
      const at = onWall('back', [0, RY - 0.02, 0]);
      train(b, at, 0.003, [
        { N: 60, pos: [0.42, 1.36], T: 120, sense: -1 },
        { N: 20, on: 0, dir: -25 },
        { N: 48, with: 1 },
        { N: 12, on: 2, dir: 20 },
        { N: 36, with: 3 },
        { N: 18, on: 4, dir: -35 },
        { N: 45, on: 5, dir: 15 },
        { N: 36, on: 6, dir: -20 },
        { N: 30, on: 0, dir: 160 },
        { N: 15, on: 8, dir: 200 },
        { N: 40, on: 7, dir: 40 },
        { N: 24, on: 10, dir: -10 },
        { N: 60, on: 11, dir: 15 },
      ], { faceZ: 0.006, board: ['#7a5a40', 0.018] });
    }
    deskLamp(b);
    hearthSide(b);
    lampAndPlant(b);
    partsCabinet(b);
    moths(b);
    gyroscope(b, m4.translation(0.92, 1.22, BENCH));
    beamEngine(b, m4.translation(1.72, 1.72, BENCH));
    shelves(b);
    watchCase(b);
    wainscot(b);
    clutter(b);
    shelfRailway(b);
    fireplace(b, 0.45);
    bookcase(b, 1.25, 2.1);
    musicBox(b, m4.translation(1.08, 1.4, BENCH));
    ballDrop(b, m4.translation(1.76, 1.3, BENCH), { start: 0 });
    ballDrop(b, m4.translation(1.9, 1.36, BENCH), { start: 2.7 });
    ballDrop(b, m4.translation(2.04, 1.3, BENCH), { start: 5.3 });
    drinkingBird(b, m4.translation(-RX + 0.03, 0.75, WIN.z0));
    // the armchair by the fire: a padded seat and back, rolled arms, turned legs
    {
      const at = m4.mul(m4.translation(-0.55, -1.15, 0), m4.rotationZ(-2.2 + Math.PI));
      const ch = new Geo();
      ch.add(roundedBox(0.6, 0.58, 0.16, 28).translate(0, 0.02, 0.33));                           // seat
      ch.add(roundedBox(0.5, 0.48, 0.1, 24).translate(0, 0.03, 0.44));                             // cushion
      ch.add(roundedBox(0.62, 0.16, 0.55, 28).rotateX(-0.12).translate(0, 0.3, 0.66));             // back
      ch.add(Geo.cylinder(0.08, 0.62, 32).rotateY(Math.PI / 2).translate(-0.31, 0.3, 0.93));        // the roll along the top of the back
      for (const sx of [-1, 1]) {
        ch.add(roundedBox(0.1, 0.56, 0.24, 20).translate(sx * 0.29, 0.0, 0.48));                   // arm
        ch.add(Geo.cylinder(0.065, 0.58, 32).rotateX(Math.PI / 2).translate(sx * 0.3, 0.29, 0.6));   // rolled top of the arm
      }
      ch.color('#6a3a34').gloss(0.2).mat(MAT.CLOTH);
      const legs = new Geo();
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) legs.add(Geo.lathe([[0.02, 0], [0.026, 0.03], [0.018, 0.08], [0.024, 0.12], [0.028, 0.25], [0, 0.25]], 24).translate(sx * 0.26, sy * 0.24, 0));
      ch.add(legs.color(COL.walnut).gloss(0.5).mat(MAT.WOOD));
      b.static(ch, { transform: at });
    }
    cat(b, m4.mul(m4.translation(0.25, -1.12, 0.006), m4.rotationZ(Math.PI + 0.35)));
    // the front wall, left of the fireplace: a board of wheels and a wall of clocks
    {
      // a wall of wheels, a metre and a third across, driven round once in four minutes
      const at = onWall('front', [0, -RY + 0.02, 0]);
      train(b, at, 0.004, [
        { N: 80, pos: [0.85, 1.25], T: 240, sense: 1 },
        { N: 20, on: 0, dir: 40 },
        { N: 64, with: 1 },
        { N: 16, on: 2, dir: 60 },
        { N: 48, with: 3 },
        { N: 24, on: 4, dir: -10 },
        { N: 60, on: 5, dir: 30 },
        { N: 30, on: 6, dir: -40 },
        { N: 45, on: 7, dir: 10 },
        { N: 36, on: 8, dir: 70 },
        { N: 72, on: 9, dir: 120 },
        { N: 24, on: 10, dir: 180 },
        { N: 50, on: 0, dir: 150 },
        { N: 30, on: 12, dir: 90 },
        { N: 40, on: 13, dir: 30 },
        { N: 60, on: 14, dir: 70 },
        { N: 30, on: 15, dir: 10 },
        { N: 75, on: 16, dir: 0 },
        { N: 40, on: 8, dir: -60 },
        { N: 64, on: 18, dir: -100 },
        { N: 24, on: 19, dir: 180 },
        { N: 48, on: 20, dir: 170 },
      ], { faceZ: 0.008, w: 0.006, board: ['#6a4a32', 0.02] });
      dropDial(b, onWall('front', [-2.2, -RY + 0.03, 1.85]), { r: 0.1, start: 0.3 });
      regulator(b, onWall('front', [-0.3, -RY + 0.13, 2.2]), { start: 0.4 });
    }
    turretClock(b, m4.mul(m4.translation(-1.35, -0.75, 0), m4.rotationZ(-0.35)));
    // a small table under the left-hand clocks with the goldfish bowl
    {
      const t = new Geo();
      t.add(Geo.cylinder(0.25, 0.03, 40).translate(0, 0, 0.7));
      t.add(Geo.cylinder(0.03, 0.7, 12));
      t.add(Geo.cylinder(0.18, 0.03, 24));
      b.static(t.color(COL.oak).mat(MAT.WOOD), { transform: m4.translation(-2.05, -0.95, 0) });
      fishbowl(b, m4.translation(-2.05, -0.95, 0.73));
    }
    dust(b);
    for (const [y, st] of [[WIN.y0 - 0.2, 0], [WIN.y1 + 0.17, 3.1]]) curtain(b, m4.mul(m4.translation(-RX + 0.06, y, WIN.z1 + 0.12), m4.rotationZ(Math.PI / 2), m4.translation(0, 0, -1.55)), { start: st });
    carriageClock(b, m4.translation(0.35, 1.28, BENCH), { start: 0.13 });
    carriageClock(b, m4.mul(m4.translation(1.3, 1.3, BENCH), m4.rotationZ(0.25)), { start: 0.37 });
    carriageClock(b, m4.mul(m4.translation(-0.35, 1.32, BENCH), m4.rotationZ(-0.2)), { start: 0.05 });
    candle(b, m4.translation(1.62, 1.25, BENCH + 0.04), { start: 0 });
    candle(b, m4.translation(-0.12, 1.24, BENCH + 0.04), { h: 0.1, start: 2.3 });
    // clocks round the rest of the room: on the left wall beside the window, the right wall, and behind
    wallClock(b, onWall('left', [-RX + 0.07, -0.55, 1.72]), { r: 0.14, dial: 1 });
    wallClock(b, onWall('left', [-RX + 0.07, -1.35, 1.6]), { r: 0.09, tick: false });
    cuckooClock(b, onWall('right', [RX - 0.01, -0.85, 1.78]));
    wallClock(b, onWall('right', [RX - 0.07, -1.35, 1.62]), { r: 0.1, dial: 1, tick: false });
    wallClock(b, onWall('front', [0.3, -RY + 0.07, 1.85]), { r: 0.16, dial: 1 });
    wallClock(b, onWall('front', [1.4, -RY + 0.07, 1.7]), { r: 0.11, tick: false });
    longcase(b, m4.mul(m4.translation(RX - 0.16, 0.45, 0), m4.rotationZ(-Math.PI / 2)));
  },
};
