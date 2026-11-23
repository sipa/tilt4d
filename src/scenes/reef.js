// Coral Reef: a sunlit reef seen through drifting blue water, explored by
// swimming.  Everything that moves keeps a steady rhythm: bubble columns rise
// at a constant speed (the vents in the channel puff in unison), fish swim
// their lanes evenly spaced, lantern anemones flash in a wave that runs up the
// channel, caustics and the shimmering surface drift overhead.  Swim fast and
// the bubbles, fish and lights ahead fall back into the past while the ones
// behind you run ahead into the future.
//
// Layout (x east, y north, z up; the water surface is at z = 20):
//   a sandy channel runs north from the spawn point, between two reef ridges,
//   under a rock arch, to a wreck on the sand plain beyond.  West of the
//   channel lies a reef flat with swaying kelp; east of it the reef ends in a
//   wall that drops into the deep.  South of the spawn is open sand and
//   seagrass.

import { Geo } from '../geom.js';
import { m4, v3 } from '../math.js';
import { Path, adaptiveTimes, timeRange, rng, clamp } from '../util.js';

const P = 60;           // every moving thing repeats after this many seconds
const SURF = 20;        // height of the water surface
const FOG = 0.045;      // water haze, per metre
const SUN = v3.norm([-0.28, -0.42, 0.92]);
const TAU = Math.PI * 2;

const MAT = {
  TERRAIN: 1, ROCK: 2, CORAL: 3, BRAIN: 4, FAN: 5, KELP: 6, SHAFT: 7, BUBBLE: 8,
  BEACON: 10, SPOTS: 11, THIN: 12, GLOW: 13, RUST: 14, BEAM: 15, SHELL: 16, SPONGE: 17, LAMP: 18, FROND: 19,
  // from here on the tag means something else than for the instanced reef life (see `surface`)
  FISH: 20, FIN: 21, MANTA: 22, JELLY: 23, BITS: 24, HULL: 25, CARGO: 26, TURTLE: 27, SUB: 28, EEL: 29, SHARKFIN: 30, VENT: 31, FLIPPER: 32,
};

// ---------------------------------------------------------------------------
// Noise and the shape of the sea floor

function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440670441)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  const h = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  return L(L(L(h(0, 0, 0), h(1, 0, 0), ux), L(h(0, 1, 0), h(1, 1, 0), ux), uy),
    L(L(h(0, 0, 1), h(1, 0, 1), ux), L(h(0, 1, 1), h(1, 1, 1), ux), uy), uz);
}
function fbm2(x, y) {
  let s = 0, a = 0.5;
  for (let i = 0; i < 4; i++) { s += a * noise2(x, y); x = x * 2.03 + 17.3; y = y * 2.03 + 9.1; a *= 0.5; }
  return s / 0.9375;
}
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// centre line of the channel, and the edge of the drop-off
const chanX = (y) => 5 * Math.sin(y * 0.028 + 0.6) + 2.5 * Math.sin(y * 0.067 + 2.1);
const dropX = (y) => 52 + 5 * Math.sin(y * 0.035 + 1.0) + 2 * Math.sin(y * 0.11 + 0.3);

// The floor is mapped over [X0, X1] x [Y0, Y1].
const X0 = -130, X1 = 110, Y0 = -140, Y1 = 150;

// Height of the floor, plus how much of it is reef and how much is wall.
function terrain(x, y) {
  const u = x - chanX(y);
  const wy = ss(-88, -52, y) * (1 - ss(50, 82, y));
  let ridge = u < 0 ? 6.8 * ss(6, 13.5, -u) * (1 - 0.6 * ss(24, 36, -u)) : 6.3 * ss(6, 13.5, u);
  ridge *= wy;
  const reef = ss(0.5, 2.4, ridge);
  const big = fbm2(x * 0.06, y * 0.06);
  const small = noise2(x * 0.32 + 40, y * 0.32 - 13);
  let z = ridge + reef * ((big - 0.5) * 3.2 + (small - 0.5) * 0.9);
  z += (1 - reef) * (fbm2(x * 0.025 + 7, y * 0.025) - 0.5) * 1.4;
  z -= 3.5 * ss(45, 100, y);
  const dx = dropX(y);
  const wall = ss(dx - 2, dx + 13, x);
  z += (-38 + (big - 0.5) * 6 - z) * wall;
  z += Math.sin(wall * Math.PI) * (small - 0.5) * 4;
  // towards the edges of the mapped floor it falls away into the deep
  const edge = Math.min(x - X0, X1 - x, y - Y0, Y1 - y);
  z -= 30 * (1 - ss(0, 35, edge));
  return { z, reef, wall };
}
const H = (x, y) => terrain(x, y).z;
// lowest floor height under a disc, for setting things down without gaps
function floorUnder(x, y, r) {
  let z = H(x, y);
  for (let k = 0; k < 6; k++) z = Math.min(z, H(x + r * Math.cos(k * TAU / 6), y + r * Math.sin(k * TAU / 6)));
  return z;
}

// Height of the floor as drawn: the terrain mesh (a grid of 160 by 193 cells,
// each split along its rising diagonal) between its corners, which can lie a
// little above or below H.  For setting small things down on it.
const FLOOR_NX = 160, FLOOR_NY = 193;
function floorMesh(x, y) {
  const gx = (x - X0) / (X1 - X0) * FLOOR_NX, gy = (y - Y0) / (Y1 - Y0) * FLOOR_NY;
  const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
  const at = (a, c) => H(X0 + (X1 - X0) * (i + a) / FLOOR_NX, Y0 + (Y1 - Y0) * (j + c) / FLOOR_NY);
  const z00 = at(0, 0), z11 = at(1, 1);
  return fx >= fy ? z00 + fx * (at(1, 0) - z00) + fy * (z11 - at(1, 0)) : z00 + fy * (at(0, 1) - z00) + fx * (z11 - at(0, 1));
}

// ---------------------------------------------------------------------------
// Colours

const mixC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

const PAL = {
  pink: '#f27a9b', coral: '#ff7f61', orange: '#f59a3a', yellow: '#f2cf4a', lime: '#b5d957', green: '#6cbf6a',
  teal: '#3cc4b4', blue: '#4d8fe0', purple: '#8e5ad6', violet: '#b16fd6', magenta: '#d94f9e', red: '#d9433f',
  cream: '#efe2c4', tan: '#c8a978', brown: '#8a6a4a',
};
// the second colours that instanced reef life can take (see "Reef life" below)
const SECOND = [PAL.cream, PAL.yellow, '#c6f0ff', PAL.magenta, PAL.red, PAL.purple];
const SECOND_WGSL = SECOND.map((c) => `vec3f(${hex(c).map((v) => v.toFixed(5)).join(', ')})`).join(', ');

// The kinds of fish (see fishGeo).  Sizes in metres; everything else in body
// lengths, along the fish (the snout at +0.5, the tail stalk at -0.3) and up:
// the dorsal and anal fins run from one place along the body to another and
// stand so high; the eye is at (along, up) with a radius.  `tag` picks the
// pattern painted in `surface`.
const FISH = {
  fusilier: { tag: 1, L: 0.48, h: 0.15, w: 0.08, back: '#ffcf3a', flank: '#3f8ff0', belly: '#eef4f8', fins: '#a9c9ec', tail: '#ffd23f',
    fork: 1.0, tailH: 1.0, dorsal: [0.26, -0.2, 0.07], anal: [0.0, -0.22, 0.05], eye: [0.345, 0.014, 0.032], iris: '#d8d0b0', gloss: 0.35 },
  snapper: { tag: 2, L: 0.34, h: 0.13, w: 0.06, back: '#e8b812', flank: '#ffd84a', belly: '#f6f0d0', fins: '#f7d34a', tail: '#f0c419',
    fork: 0.45, tailH: 0.95, dorsal: [0.27, -0.2, 0.09], anal: [0.0, -0.21, 0.07], eye: [0.34, 0.03, 0.037], iris: '#f0d890', gloss: 0.4 },
  chromis: { tag: 3, L: 0.2, h: 0.085, w: 0.045, back: '#2a74d8', flank: '#5cc4ff', belly: '#b2e6ff', fins: '#7ccfff', tail: '#3a8cf0',
    fork: 0.9, tailH: 1.05, dorsal: [0.26, -0.21, 0.11], anal: [0.02, -0.22, 0.09], eye: [0.335, 0.03, 0.05], iris: '#2a3a50', gloss: 0.5 },
  jack: { tag: 4, L: 0.6, h: 0.2, w: 0.08, back: '#4a5c6a', flank: '#c4d0d8', belly: '#eef2f4', fins: '#8d9ba6', tail: '#b8b58a',
    fork: 1.25, tailH: 1.1, dorsal: [0.2, -0.22, 0.08], anal: [0.0, -0.23, 0.06], eye: [0.345, 0.015, 0.04], iris: '#e8eef0', gloss: 0.85 },
  tang: { tag: 5, L: 0.26, h: 0.2, w: 0.04, back: '#f2c30f', flank: '#ffd52a', belly: '#ffe680', fins: '#ffd21c', tail: '#ffe14a',
    fork: 0.05, tailH: 1.05, dorsal: [0.24, -0.24, 0.16], anal: [0.04, -0.24, 0.14], tall: true, head: 0.74, mouth: 0.02,
    eye: [0.33, 0.08, 0.045], iris: '#20180a', gloss: 0.4 },
  parrot: { tag: 6, L: 0.7, h: 0.24, w: 0.13, back: '#23877c', flank: '#45c4a0', belly: '#a8e6cf', fins: '#e86fae', tail: '#e86fae',
    fork: 0.2, tailH: 0.95, dorsal: [0.24, -0.22, 0.06], anal: [0.0, -0.22, 0.05], head: 0.85, mouth: 0.0,
    eye: [0.35, 0.035, 0.03], iris: '#f0a040', gloss: 0.4 },
  clown: { tag: 7, L: 0.11, h: 0.05, w: 0.026, back: '#f06a10', flank: '#ff8a1e', belly: '#ffa040', fins: '#ff8a1e', tail: '#ff8a1e',
    fork: 0.0, tailH: 0.9, dorsal: [0.22, -0.24, 0.14], anal: [0.02, -0.22, 0.11], tall: true, head: 0.78, mouth: -0.01,
    eye: [0.35, 0.04, 0.05], iris: '#e07010', gloss: 0.5 },
  humbug: { tag: 8, L: 0.09, h: 0.055, w: 0.022, back: '#f4f4f0', flank: '#f4f4f0', belly: '#ffffff', fins: '#202020', tail: '#e8e8e8',
    fork: 0.35, tailH: 1.0, dorsal: [0.24, -0.2, 0.16], anal: [0.04, -0.22, 0.12], tall: true, head: 0.8,
    eye: [0.35, 0.05, 0.05], iris: '#303030', gloss: 0.4 },
};
// for the shader, per kind (by tag; 0 is unused): back, belly, eye (along, up, radius), iris, (mouth height, 0, 0)
const FISH_WGSL = (() => {
  const list = Object.values(FISH).sort((a, b) => a.tag - b.tag);
  const v = (c) => `vec3f(${c.map((x) => x.toFixed(4)).join(', ')})`;
  const rows = [list[0], ...list].map((f) => [v(hex(f.back)), v(hex(f.belly)), v(f.eye), v(hex(f.iris)), v([f.mouth ?? -0.02, 0, 0])]);
  return `array<vec3f, ${rows.length * 5}>(${rows.flat().join(', ')})`;
})();

// ---------------------------------------------------------------------------
// Shader hooks: water, light and materials

const wgsl = /* wgsl */ `
const SURF = ${SURF.toFixed(1)};
const FOGK = ${FOG};
const SUN_DIR = vec3f(${SUN.map((v) => v.toFixed(4)).join(', ')});
const W_HOR = vec3f(0.012, 0.068, 0.122);
const W_UP = vec3f(0.050, 0.215, 0.320);
const W_DEEP = vec3f(0.002, 0.009, 0.026);

// overall brightness of the water at a height: darker in the depths
fn depthDim(z: f32) -> f32 {
  return 0.25 + 0.75 * exp(-max(SURF - z, 0.0) * 0.032);
}

// colour of the water itself in a direction (no surface): also the fog colour
fn waterColor(dir: vec3f) -> vec3f {
  var c = mix(W_HOR, W_UP, smoothstep(0.0, 0.95, dir.z));
  c = mix(c, W_DEEP, smoothstep(0.0, 0.75, -dir.z));
  c += vec3f(0.03, 0.085, 0.085) * pow(max(dot(dir, SUN_DIR), 0.0), 6.0);
  return c * depthDim(G.P.z);
}

// moving ripples on the underside of the surface (0..1)
fn surfRipple(p: vec2f, t: f32) -> f32 {
  // two rotated layers of ridged noise over a slowly drifting warp
  let w = vec2f(noise2(p * 0.11 + vec2f(t * 0.04, 1.7)), noise2(p * 0.11 + vec2f(5.3, -t * 0.035))) - 0.5;
  let q = p + w * 7.0;
  let q1 = vec2f(q.x * 0.8 - q.y * 0.6, q.x * 0.6 + q.y * 0.8);
  let q2 = vec2f(q.x * 0.31 + q.y * 0.95, q.y * 0.31 - q.x * 0.95);
  let a = noise2(q1 * 0.23 + vec2f(t * 0.09, t * 0.035));
  let b = noise2(q2 * 0.5 + vec2f(-t * 0.06, t * 0.11) + 3.7);
  let r1 = saturate(1.0 - abs(a * 2.0 - 1.0));
  let r2 = saturate(1.0 - abs(b * 2.0 - 1.0));
  return saturate(pow(r1, 3.0) * 0.65 + pow(r2, 4.0) * 0.5);
}

fn envSun(t: f32) -> Light {
  return Light(SUN_DIR, vec3f(1.0, 1.04, 1.0) * 1.0);
}

fn envSky(dir: vec3f, t: f32) -> vec3f {
  var c = waterColor(dir);
  if (dir.z > 0.02) {
    // the surface overhead, seen from where the player is
    let h = max(SURF - G.P.z, 0.05);
    let d = h / dir.z;
    let p = G.P.xy + dir.xy * d;
    // ripples, smoothed out where they are far away and would only shimmer
    let r = mix(0.3, surfRipple(p, t), exp(-d * 0.045));
    // Snell's window: the sky shows through within ~49 degrees of straight up;
    // outside it the surface mirrors the dim water below, finely broken up
    let win = smoothstep(0.62, 0.69, dir.z);
    let rim = exp(-abs(dir.z - 0.655) * 28.0);
    let sky = vec3f(0.40, 0.76, 0.95) * (1.1 + 2.6 * r);
    var mirror = W_HOR;
    if (win < 1.0) {
      let rm = mix(0.3, surfRipple(p * 2.6 + 11.0, t * 1.3), exp(-d * 0.09));
      mirror = W_HOR * (0.85 + 1.1 * rm);
    }
    var s = mix(mirror, sky, win) + vec3f(0.35, 0.7, 0.75) * rim * (0.5 + r);
    let sd = max(dot(dir, SUN_DIR), 0.0);
    s += vec3f(1.0, 0.96, 0.85) * (pow(sd, 250.0) * 10.0 + pow(sd, 20.0) * 0.9) * (0.5 + r);
    c = mix(c, s, exp(-d * FOGK));
  }
  return c;
}

fn envAmbient(n: vec3f, t: f32) -> vec3f {
  return mix(vec3f(0.07, 0.15, 0.21), vec3f(0.17, 0.35, 0.47), n.z * 0.5 + 0.5);
}

fn envFog(dir: vec3f, t: f32, dist: f32) -> vec4f {
  return vec4f(waterColor(dir), 1.0 - exp(-dist * FOGK));
}

// distance to the nearest edge of an animated cell pattern
fn cellEdge(p: vec2f, t: f32) -> f32 {
  let i = floor(p);
  let f = fract(p);
  var d1 = 8.0;
  var d2 = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let h = hash22(i + g);
      let o = 0.5 + 0.38 * sin(t * (0.45 + 0.35 * h.yx) + TAU * h);
      let d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}

// caustics: the net of light focused by the waves (0..1)
fn caustic(p: vec2f, t: f32) -> f32 {
  let w = vec2f(noise2(p * 0.4 + vec2f(t * 0.08, 0.0)), noise2(p * 0.4 + vec2f(5.2, -t * 0.07))) - 0.5;
  let e1 = cellEdge(p + w * 1.7, t * 0.9);
  let e2 = cellEdge(p * 1.31 + vec2f(13.7, 4.1) - w * 1.3, t * 0.7 + 3.0);
  let l1 = exp(-e1 * 11.0);
  let l2 = exp(-e2 * 9.0);
  return saturate(l1 * 0.7 + l2 * 0.5 + l1 * l2 * 0.9);
}

// ---- meshes with holes (.cutout()): sea fans, kelp and the wreck's plating

// Sea fans (uv: 0..1 across, which is twice the fan's size, and 0..1 up its
// size): a net of fine branches along the edges of irregular cells.  The
// distance from the nearest branch, in cells.
const FAN_CELLS = 11.0;
fn fanNet(uv: vec2f) -> f32 {
  let p = vec2f(uv.x * 2.0, uv.y) * FAN_CELLS;
  let i = floor(p);
  let f = fract(p);
  var d1 = 8.0;
  var d2 = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let d = length(g + 0.1 + 0.8 * hash22(i + g + 31.0) - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return 0.5 * (d2 - d1);
}

// Kelp fronds (uv: 0..1 across, 0..1 from the holdfast up): a stipe up the
// middle and pointed blades along it, alternately to either side, slanting
// upwards, each a little longer or shorter.  How far inside a blade or the
// stipe a point lies (< 0 outside).
const KELP_BLADES = 14.0;
fn kelpLeaf(uv: vec2f) -> f32 {
  let a = uv.x * 2.0 - 1.0;
  let x = abs(a);
  let side = select(0.0, 0.5, a > 0.0);
  let q = uv.y * KELP_BLADES + side - x * 0.8;
  let v = abs(fract(q) - 0.5);
  let h = hash11(floor(q) * 2.0 + side * 2.0 + 0.5);
  let len = 0.7 + 0.3 * h;
  let halfw = (0.28 + 0.1 * h) * pow(sin(PI * min(x / len * 0.92 + 0.08, 1.0)), 0.7);
  return max(halfw - v, (0.07 - x) * 2.0);
}

// Where the holes of fans and kelp would be too fine to see they close up,
// here and in the shadow maps alike.
fn cutout(s: Surface) -> f32 {
  let fw = fwidth(s.uv);
  if (s.mat == ${MAT.FAN}u) {
    // the branches cover about half the fan close by; further off they
    // thicken and the holes close, so that a fan keeps its colour
    let far = smoothstep(0.08, 0.4, max(fw.x * 2.0, fw.y) * FAN_CELLS);
    return saturate(0.5 + (mix(0.14, 0.7, far) - fanNet(s.uv)) * 8.0);
  }
  if (s.mat == ${MAT.FROND}u) {
    let fade = smoothstep(0.2, 0.45, max(fw.y * KELP_BLADES, fw.x * 4.0));
    return mix(saturate(0.5 + kelpLeaf(s.uv) * 5.0), 1.0, fade);
  }
  if ((s.mat == ${MAT.RUST}u || s.mat == ${MAT.HULL}u) && s.aux > 0.0) {
    // ragged holes rusted through the wreck's plating, where aux allows them
    let r = noise3(s.pos * 0.7 + 3.0) * 0.65 + noise3(s.pos * 2.6 - 1.0) * 0.35 - (1.0 - s.aux) * 0.3;
    return saturate(0.5 + (0.54 - r) * 10.0);
  }
  return 1.0;
}

// the second colours of instanced reef life (SECOND, in sRGB)
fn secondColor(i: u32) -> vec3f {
  var c = array<vec3f, 6>(${SECOND_WGSL});
  return c[min(i, 5u)];
}

// A fish's body (uv: along and up it in body lengths, the snout at +0.5;
// aux: how high across the body, -1 belly .. 1 back; tag: the kind), painted:
// countershading, each kind's markings, the gill cover, mouth and eye.  The
// colours are sRGB.  fw is how much of a body length a pixel covers.
fn fishSkin(sp: u32, a: f32, v: f32, zn: f32, flank: vec3f, fw: f32) -> vec4f {
  // each kind's back, belly, eye (along, up, radius), iris and (mouth height, 0, 0)
  var tab = ${FISH_WGSL};
  let ti = min(sp, 8u) * 5u;
  let back = tab[ti];
  var c = mix(flank, back, smoothstep(0.35, 0.8, zn));
  c = mix(c, tab[ti + 1u], smoothstep(-0.25, -0.7, zn));
  let fine = 1.0 - smoothstep(0.004, 0.012, fw);   // markings finer than a pixel fade out
  if (sp == 1u) {
    // fusilier: the yellow back widens towards the tail until the stalk is all yellow
    let edge = mix(0.78, -0.6, smoothstep(0.18, -0.26, a));
    c = mix(c, back, smoothstep(edge - 0.08, edge + 0.08, zn));
  } else if (sp == 2u) {
    // snapper: four blue stripes edged in black, from the snout to the tail
    let q = abs(fract((zn + 0.7) * 2.4) - 0.5);
    let on = smoothstep(-0.72, -0.62, zn) * (1.0 - smoothstep(0.75, 0.85, zn)) * (1.0 - smoothstep(0.43, 0.47, a));
    c = mix(c, vec3f(0.08, 0.1, 0.12), on * (1.0 - smoothstep(0.12, 0.15, q)) * fine);
    c = mix(c, vec3f(0.25, 0.62, 1.0), on * (1.0 - smoothstep(0.075, 0.105, q)));
  } else if (sp == 4u) {
    // jack: a black spot high on the gill cover, and a row of dark scutes along the tail stalk
    c = mix(c, vec3f(0.06, 0.07, 0.08), 1.0 - smoothstep(0.016, 0.022, length(vec2f(a - 0.305, v - 0.055))));
    let sc = (1.0 - smoothstep(0.1, 0.18, abs(zn))) * smoothstep(0.02, -0.06, a);
    c = mix(c, c * (0.7 + 0.2 * step(0.5, fract(a * 60.0))), sc * fine);
  } else if (sp == 5u) {
    // tang: the white spine at the root of the tail
    c = mix(c, vec3f(0.97, 0.97, 0.92), 1.0 - smoothstep(0.7, 1.0, length(vec2f((a + 0.24) / 0.035, zn / 0.3))));
  } else if (sp == 7u) {
    // clownfish: three white bands edged in black
    let bd = min(min(abs(a - 0.29 + 0.03 * zn), abs(a - 0.03 - 0.05 * zn)), abs(a + 0.24));
    c = mix(c, vec3f(0.05), 1.0 - smoothstep(0.045, 0.055, bd));
    c = mix(c, vec3f(0.98, 0.98, 0.96), 1.0 - smoothstep(0.03, 0.04, bd));
  } else if (sp == 8u) {
    // humbug damselfish: three black bars, through the eye, mid-body and at the tail
    let bd = min(min(abs(a - 0.36 + 0.08 * zn), abs(a - 0.06 + 0.1 * zn)), abs(a + 0.22));
    c = mix(c, vec3f(0.04), 1.0 - smoothstep(0.045, 0.06, bd));
  } else if (sp == 6u) {
    // parrotfish: big scales edged in pink, pink bands across the face, a pale beak
    let q = vec2f(a * 26.0 + 0.5 * step(0.5, fract(v * 13.0)), v * 13.0);
    let e = abs(fract(q) - 0.5);
    c = mix(c, vec3f(0.85, 0.42, 0.62), smoothstep(0.36, 0.48, max(e.x, e.y)) * fine * 0.7 * step(a, 0.33));
    let band = abs(fract((v - 0.45 * a) * 18.0) - 0.5);
    c = mix(c, vec3f(0.9, 0.45, 0.65), (1.0 - smoothstep(0.12, 0.2, band)) * smoothstep(0.33, 0.37, a) * fine);
    c = mix(c, vec3f(0.9, 0.92, 0.85), smoothstep(0.462, 0.47, a));
  }
  // the edge of the gill cover, a curve just ahead of the widest point
  let gd = abs(a - (0.292 - 0.05 * zn * zn));
  c *= 1.0 - 0.5 * (1.0 - smoothstep(0.003, 0.006 + fw, gd)) * (1.0 - smoothstep(0.75, 0.9, abs(zn))) * fine;
  // the mouth: a dark line running back from the snout
  let mv = tab[ti + 4u].x;
  c *= 1.0 - 0.8 * (1.0 - smoothstep(0.004, 0.006 + fw, abs(v - mv))) * smoothstep(0.445, 0.455, a);
  // the eye: a ring of iris round a black pupil, with a dark rim and a glint
  let e = tab[ti + 2u];
  let d = length(vec2f(a, v) - e.xy) / e.z;
  var eye = 0.0;
  if (d < 1.1) {
    var ec = mix(tab[ti + 3u], vec3f(0.01), 1.0 - smoothstep(0.5, 0.6, d));
    ec = mix(ec, vec3f(0.04), smoothstep(0.85, 0.95, d));
    let glint = 1.0 - smoothstep(0.12, 0.2, length(vec2f(a, v) - e.xy - vec2f(0.2, 0.25) * e.z) / e.z);
    ec = mix(ec, vec3f(1.0), glint);
    eye = 1.0 - smoothstep(1.0, 1.08, d);
    c = mix(c, ec, eye);
  }
  return vec4f(c, eye);
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  let m = s.mat;
  let fwUV = fwidth(s.uv);
  // instanced reef life: parts that keep their own colour, or take the copy's second one
  if (m < ${MAT.FISH}u) {
    if (s.tag == 1u) {
      s.color /= max(s.inst.rgb, vec3f(1e-4));
    } else if (s.tag >= 2u) {
      let c2 = secondColor(u32(s.inst.w + 0.5));
      s.color = srgbToLinear(select(c2, mix(pow(s.inst.rgb, vec3f(1.0 / 2.2)), c2, 0.55), s.tag == 2u));
    }
  }
  let depth = max(SURF - s.pos.z, 0.0);
  var causticAmt = 1.0;

  // ---- pure light
  if (m == ${MAT.SHAFT}u) {
    // sun shafts: soft at the edges, strongest near the surface, shimmering
    let edge = pow(abs(dot(s.n, s.view)), 2.5);
    let along = smoothstep(0.0, 0.7, s.uv.y) * (1.0 - smoothstep(0.9, 1.0, s.uv.y));
    let flick = 0.5 + 0.5 * sin(s.t * 0.7 + noise2(s.pos.xy * 0.12 + s.t * 0.05) * 9.0);
    s.emissive *= edge * along * flick;
    return s;
  }
  if (m == ${MAT.BEAM}u) {
    let edge = pow(abs(dot(s.n, s.view)), 2.0);
    s.emissive *= edge * (1.0 - smoothstep(0.1, 1.0, s.uv.y));
    return s;
  }

  // thin sheets are lit from whichever side is seen
  if (m == ${MAT.THIN}u || m == ${MAT.KELP}u || m == ${MAT.FROND}u || m == ${MAT.FAN}u || m == ${MAT.JELLY}u || m == ${MAT.FIN}u || m == ${MAT.SHARKFIN}u || m == ${MAT.FLIPPER}u) {
    if (dot(s.n, s.view) > 0.0) { s.n = -s.n; }
  }

  if (m == ${MAT.TERRAIN}u) {
    let sandAmt = s.uv.x;
    let wallAmt = s.uv.y;
    let q = s.pos.xy;
    let near = 1.0 - smoothstep(12.0, 35.0, s.dist);
    // sand ripples, gently curving
    let warp = noise2(q * 0.11) * 7.0 + noise2(q * 0.37) * 1.6;
    let ph = dot(q, vec2f(0.53, 0.85)) * 6.5 + warp;
    let level = smoothstep(0.8, 0.97, s.n.z) * sandAmt * near;
    s.n = normalize(s.n - vec3f(0.53, 0.85, 0.0) * (cos(ph) * 0.3 * level));
    s.color *= 1.0 + (sin(ph) * 0.06 + (noise2(q * 2.7) - 0.5) * 0.22) * sandAmt;
    // reef rubble: coralline, algae and sponge patches, and a lumpy surface
    let reefAmt = (1.0 - sandAmt) * (1.0 - wallAmt);
    causticAmt = 0.55 + 0.45 * sandAmt;
    let pn = noise2(q * 0.8 + 3.0);
    let pn2 = noise2(q * 1.6 + 11.0);
    let pn3 = noise2(q * 1.2 - 7.0);
    var rc = s.color * (0.8 + 0.4 * noise2(q * 5.0) * near);
    rc = mix(rc, vec3f(0.34, 0.15, 0.27), smoothstep(0.6, 0.8, pn) * 0.5);
    rc = mix(rc, vec3f(0.20, 0.26, 0.10), smoothstep(0.58, 0.78, pn2) * 0.45);
    rc = mix(rc, vec3f(0.45, 0.24, 0.10), smoothstep(0.72, 0.86, pn3) * 0.45);
    s.color = mix(s.color, rc, reefAmt);
    // lumpy rubble and rock (3D noise, so that the steep wall is not streaked)
    let bq = s.pos * 1.7;
    let b0 = noise3(bq);
    let bx = noise3(bq + vec3f(0.2, 0.0, 0.0));
    let by = noise3(bq + vec3f(0.0, 0.2, 0.0));
    let bz = noise3(bq + vec3f(0.0, 0.0, 0.2));
    s.n = normalize(s.n - vec3f(bx - b0, by - b0, bz - b0) * (5.0 * (1.0 - sandAmt) * near));
    // the wall: grey stone in layers, with sponges and coralline crusts
    let w1 = noise3(s.pos * vec3f(0.4, 0.4, 1.4));
    let w2 = noise3(s.pos * 0.9 + 17.0);
    var wc = s.color * (0.7 + 0.6 * w1);
    wc = mix(wc, vec3f(0.42, 0.14, 0.32), smoothstep(0.62, 0.78, w2) * 0.6);
    wc = mix(wc, vec3f(0.55, 0.25, 0.08), (1.0 - smoothstep(0.22, 0.32, w2)) * 0.5);
    s.color = mix(s.color, wc, wallAmt);
  } else if (m == ${MAT.ROCK}u) {
    causticAmt = 0.7;
    let n3 = noise3(s.pos * 1.3);
    s.color *= 0.75 + 0.5 * n3;
    s.color = mix(s.color, vec3f(0.40, 0.14, 0.30), smoothstep(0.62, 0.8, noise3(s.pos * 0.7 + 4.0)) * 0.7);
    s.color = mix(s.color, vec3f(0.16, 0.25, 0.06), smoothstep(0.55, 0.85, s.n.z) * smoothstep(0.4, 0.7, noise3(s.pos * 2.1)) * 0.6);
  } else if (m == ${MAT.CORAL}u) {
    // tiny polyps
    let pp = noise3(s.pos * 14.0);
    s.color *= 0.82 + 0.36 * pp * (1.0 - smoothstep(4.0, 12.0, s.dist));
    if (s.dist < 5.0) {
      // close by, the polyps: pale specks with dark mouths
      let c = noise3(s.pos * 45.0);
      s.color *= 1.0 + (1.0 - smoothstep(2.5, 5.0, s.dist)) * (0.35 * smoothstep(0.55, 0.68, c) - 0.5 * smoothstep(0.74, 0.8, c));
    }
  } else if (m == ${MAT.BRAIN}u) {
    // meandering ridges with narrow dark valleys between them
    let g = sin(noise3(s.pos * 2.2) * 34.0);
    let k = (1.0 - smoothstep(6.0, 20.0, s.dist));
    let valley = smoothstep(-0.55, -0.9, g);
    s.color *= 1.0 + k * (0.18 * g - 0.5 * valley);
    s.ambient *= 1.0 - 0.3 * valley * k;
  } else if (m == ${MAT.FAN}u) {
    // a net of branches with water showing between them (see \`cutout\`),
    // a little darker towards their edges
    let net = 1.0 - smoothstep(0.0, 0.2, fanNet(s.uv));
    let k = 1.0 - smoothstep(4.0, 14.0, s.dist);
    s.color *= mix(1.0, 0.85 + 0.15 * net, k);
  } else if (m == ${MAT.KELP}u || m == ${MAT.FROND}u) {
    // light through the fronds
    s.color *= (0.75 + 0.5 * noise2(vec2f(s.uv.y * 30.0, s.uv.x * 3.0))) * mix(0.35, 1.25, smoothstep(0.0, 0.85, s.uv.y));
    s.light += vec3f(0.25, 0.28, 0.08) * s.uv.y * 0.6;
  } else if (m == ${MAT.SPONGE}u) {
    let pits = noise3(s.pos * 9.0);
    s.color *= 0.7 + 0.6 * smoothstep(0.25, 0.6, pits);
  } else if (m == ${MAT.RUST}u || m == ${MAT.HULL}u) {
    if (m == ${MAT.HULL}u && s.dist < 14.0) {
      // the hull's plates (uv: along and up the hull in metres): seams every 2 m
      // along and 0.9 m up, each with a row of rivets beside it
      let q = s.uv / vec2f(2.0, 0.9);
      let dy = (0.5 - abs(fract(q.x) - 0.5)) * 2.0;
      let dz = (0.5 - abs(fract(q.y) - 0.5)) * 0.9;
      let r1 = length(vec2f(dy - 0.07, (fract(s.uv.y / 0.13) - 0.5) * 0.13));
      let r2 = length(vec2f(dz - 0.07, (fract(s.uv.x / 0.13) - 0.5) * 0.13));
      let fine = 1.0 - smoothstep(6.0, 14.0, s.dist);
      let rivet = 1.0 - smoothstep(0.014, 0.022, min(r1, r2));
      s.color *= 1.0 - fine * (0.45 * (1.0 - smoothstep(0.012, 0.025, min(dy, dz))) - 0.35 * rivet);
      // patches of barnacles: pale cones with dark middles
      let bq = s.uv * 14.0;
      let bh = hash22(floor(bq));
      let bd = length(fract(bq) - 0.5 - 0.45 * (bh - 0.5)) / (0.6 + 0.6 * bh.x);
      let bar = step(0.7, noise2(s.uv * 0.6 + 3.0) + 0.1 * bh.y) * step(0.3, bh.y) * fine;
      let cone = 1.0 - smoothstep(0.1, 0.2, bd);
      s.color = mix(s.color, vec3f(0.55, 0.52, 0.45) * (0.7 + 0.3 * cone), bar * cone * smoothstep(0.03, 0.06, bd));
    }
    // rust, sponges and weed on the wreck
    let a = noise3(s.pos * 0.9);
    let b = noise3(s.pos * 1.7 + 9.0);
    let c = noise3(s.pos * 2.3 - 3.0);
    let d = noise3(s.pos * 3.1 + 5.0);
    s.color *= 0.8 + 0.45 * a;
    s.color = mix(s.color, vec3f(0.62, 0.24, 0.06), smoothstep(0.55, 0.75, b) * 0.7);
    s.color = mix(s.color, vec3f(0.85, 0.30, 0.12), smoothstep(0.74, 0.8, c) * 0.85);
    s.color = mix(s.color, vec3f(0.55, 0.12, 0.30), smoothstep(0.76, 0.82, d) * 0.8);
    s.color = mix(s.color, vec3f(0.25, 0.33, 0.12), smoothstep(0.5, 0.9, s.n.z) * 0.45);
    s.gloss = 0.05;
  } else if (m == ${MAT.SHELL}u) {
    // turtle shell plates
    let q = s.uv * vec2f(9.0, 5.0);
    let e = abs(fract(q + vec2f(noise2(q * 1.3), 0.0) * 0.35) - 0.5);
    s.color *= 0.6 + 0.4 * smoothstep(0.03, 0.15, min(e.x, e.y)) + 0.25 * noise2(q * 3.0);
    s.color = mix(s.color, vec3f(0.62, 0.55, 0.32), 1.0 - smoothstep(-0.6, -0.25, s.n.z));
  } else if (m == ${MAT.SPOTS}u) {
    // whale shark (uv: x around the body, 0 on its right, 0.25 under it, 0.75
    // on top; y along it, 0 at the tip of the tail and 1 at the snout): a pale
    // belly, a chequer of pale lines on the flanks with a pale spot in each
    // square and smaller ones on the head, gill slits, the mouth and the eyes
    let ph = s.uv.x * TAU;
    let up = -sin(ph);
    let y = s.uv.y * 9.05;
    let belly = 1.0 - smoothstep(-0.55, -0.2, up);
    let back = 1.0 - belly;
    s.color = mix(s.color, vec3f(0.72, 0.76, 0.78), belly);
    let head = smoothstep(7.0, 7.4, y);
    let q = vec2f(s.uv.x * mix(22.0, 40.0, head), y * mix(3.3, 6.5, head));
    let e = abs(fract(q) - 0.5);
    let jit = hash22(floor(q)) - 0.5;
    let d = length(fract(q) - 0.5 - jit * 0.35);
    // (no spots on the very snout, where the cells round the body narrow to slivers)
    let spot = (1.0 - smoothstep(0.15, 0.23, d)) * back * (1.0 - smoothstep(8.65, 8.8, y));
    let fine = 1.0 - smoothstep(4.0, 25.0, s.dist);
    let lines = smoothstep(0.44, 0.48, max(e.x, e.y) + 0.03 * jit.x) * back * (1.0 - head) * smoothstep(2.0, 4.0, y) * fine;
    s.color = mix(s.color, vec3f(0.75, 0.78, 0.78), max(spot, lines * 0.35));
    let side = smoothstep(0.2, 0.4, abs(cos(ph))) * (1.0 - smoothstep(0.45, 0.6, up)) * smoothstep(-0.6, -0.45, up);
    let slit = (1.0 - smoothstep(0.06, 0.12, abs(fract((y - 6.45) / 0.18) - 0.5))) * step(6.45, y) * step(y, 7.35) * side;
    s.color = mix(s.color, vec3f(0.08, 0.09, 0.11), slit * fine);
    let mouth = (1.0 - smoothstep(0.035, 0.06, abs(y - 8.86 - 0.08 * up))) * smoothstep(-0.8, -0.65, up) * (1.0 - smoothstep(0.1, 0.2, up));
    s.color = mix(s.color, vec3f(0.03, 0.03, 0.04), mouth);
    let eye = (1.0 - smoothstep(0.045, 0.06, length(vec2f((up - 0.05) * 0.7, y - 8.45)))) * smoothstep(0.5, 0.6, abs(cos(ph)));
    s.color = mix(s.color, vec3f(0.02), eye);
  } else if (m == ${MAT.FISH}u) {
    let f = fishSkin(s.tag, s.uv.x, s.uv.y, clamp(s.aux, -1.0, 1.0), pow(s.color, vec3f(1.0 / 2.2)), max(fwUV.x, fwUV.y));
    s.color = srgbToLinear(clamp(f.rgb, vec3f(0.0), vec3f(1.0)));
    s.gloss = mix(s.gloss, 0.9, f.a);
  } else if (m == ${MAT.FIN}u) {
    // fins: fine rays (along the tail, across the others), paler towards the rim
    let tailFin = s.uv.x < -0.3;
    let ray = select(s.uv.x, s.uv.y, tailFin);
    let fine = 1.0 - smoothstep(0.004, 0.012, max(fwUV.x, fwUV.y));
    let rim = saturate(s.aux);
    s.color *= (1.0 - 0.28 * fine * (0.5 + 0.5 * sin(ray * 260.0))) * (0.8 + 0.35 * rim);
    // the fusilier's tail lobes are tipped with black
    if (s.tag == 1u && tailFin) { s.color = mix(s.color, vec3f(0.01), smoothstep(0.8, 0.9, rim)); }
  } else if (m == ${MAT.MANTA}u) {
    // manta (uv: place on the ray in metres, the mouth at y = 0.97)
    let x = abs(s.uv.x);
    let y = s.uv.y;
    let mot = noise2(s.uv * 3.0);
    if (s.tag == 1u) {
      // the back: pale shoulder patches behind the head, sweeping out along the wings
      let band = y - (0.62 - 0.4 * x);
      let pale = smoothstep(-0.42, -0.34, band) * (1.0 - smoothstep(-0.08, 0.0, band)) * smoothstep(0.26, 0.36, x) * (1.0 - smoothstep(1.1, 1.5, x));
      s.color = mix(s.color, vec3f(0.42, 0.45, 0.47), pale * smoothstep(0.3, 0.5, mot + 0.2));
    } else {
      // the belly: dark spots of its own, gill slits, the mouth, and dark wing edges
      let cell = floor(s.uv * 7.0);
      let h = hash22(cell + 17.0);
      let sp = (1.0 - smoothstep(0.1, 0.16, length(fract(s.uv * 7.0) - 0.25 - 0.5 * h))) * step(0.72, h.x + h.y * 0.2);
      s.color = mix(s.color, vec3f(0.12, 0.13, 0.15), sp * (1.0 - smoothstep(0.35, 0.6, x)) * smoothstep(-0.7, -0.4, y) * (1.0 - smoothstep(0.2, 0.3, y)));
      let gq = (0.7 - y - 0.18 * (x - 0.2)) / 0.085;
      let slit = (1.0 - smoothstep(0.08, 0.16, abs(fract(gq) - 0.5) - 0.32)) * step(0.0, gq) * step(gq, 5.0) * smoothstep(0.18, 0.21, x) * (1.0 - smoothstep(0.43, 0.46, x));
      s.color = mix(s.color, vec3f(0.18, 0.2, 0.24), slit * 0.85);
      s.color = mix(s.color, vec3f(0.05, 0.05, 0.07), smoothstep(0.9, 0.93, y) * (1.0 - smoothstep(0.15, 0.18, x)));
      s.color = mix(s.color, vec3f(0.22, 0.25, 0.3), smoothstep(1.5, 2.3, x + 0.6 * mot));
    }
    // the eyes, on either side of the head behind the horns
    let ed = length(vec2f(x - 0.4, y - 0.8));
    s.color = mix(s.color, vec3f(0.55, 0.58, 0.6), 1.0 - smoothstep(0.05, 0.058, ed));
    s.color = mix(s.color, vec3f(0.01), 1.0 - smoothstep(0.034, 0.042, ed));
  } else if (m == ${MAT.TURTLE}u) {
    // the turtle's head (uv: round it, the snout at u = 0.25, and down it from
    // the crown): plates edged darker, a pale throat, dark glossy eyes
    let sc = abs(fract(vec2f(s.uv.x * 28.0, s.uv.y * 9.0)) - 0.5);
    s.color *= 1.0 - 0.4 * smoothstep(0.38, 0.47, max(sc.x, sc.y)) * (1.0 - smoothstep(0.5, 0.6, s.uv.y));
    s.color = mix(s.color, vec3f(0.85, 0.8, 0.62), smoothstep(0.55, 0.68, s.uv.y));
    let ed = min(length(vec2f((s.uv.x - 0.165) * 34.0, (s.uv.y - 0.43) * 15.0)), length(vec2f((s.uv.x - 0.335) * 34.0, (s.uv.y - 0.43) * 15.0)));
    let eye = 1.0 - smoothstep(0.8, 1.0, ed);
    s.color = mix(s.color, vec3f(0.02), eye);
    s.gloss = mix(s.gloss, 0.85, eye);
  } else if (m == ${MAT.FLIPPER}u) {
    // the turtle's flippers (uv: their flat outline in metres): dark scales edged pale
    let q = s.uv * vec2f(22.0, 26.0) + vec2f(0.5 * step(0.5, fract(s.uv.y * 13.0)), 0.0);
    let e = abs(fract(q) - 0.5);
    s.color *= mix(1.0, 0.6 + 0.6 * smoothstep(0.32, 0.46, max(e.x, e.y)), 1.0 - smoothstep(0.25, 0.5, max(fwUV.x, fwUV.y) * 26.0));
  } else if (m == ${MAT.SUB}u) {
    // the submarine (uv: x round the hull, 0 on its right and 0.5 on its left;
    // y along it in metres): three portholes a side with brass rims, and a dark band
    let side = min(min(abs(s.uv.x), abs(1.0 - s.uv.x)), abs(s.uv.x - 0.5)) * 4.1;
    let py = (fract((s.uv.y + 0.6) / 0.6 + 0.5) - 0.5) * 0.6;
    let pd = length(vec2f(side, py)) * step(-0.9, s.uv.y) * step(s.uv.y, 0.95) + step(0.95, s.uv.y) + step(s.uv.y, -0.9);
    s.color = mix(s.color, vec3f(0.55, 0.4, 0.12), 1.0 - smoothstep(0.13, 0.15, pd));
    s.color = mix(s.color, vec3f(0.02, 0.04, 0.06), 1.0 - smoothstep(0.095, 0.11, pd));
    s.gloss = mix(s.gloss, 0.95, 1.0 - smoothstep(0.095, 0.11, pd));
    s.color = mix(s.color, vec3f(0.12, 0.14, 0.18), (1.0 - smoothstep(0.02, 0.03, abs(side - 0.55))) * step(abs(s.uv.y), 1.3));
  } else if (m == ${MAT.VENT}u) {
    // a vent's crater (uv.y: 0 at its foot, 0.5 on the rim, 1 down its throat):
    // white and sulphur-yellow crusts round the rim, darkening into the throat
    let crust = smoothstep(0.2, 0.45, s.uv.y) * (1.0 - smoothstep(0.55, 0.7, s.uv.y));
    let n = noise2(vec2f(s.uv.x * 23.0, s.uv.y * 9.0));
    s.color = mix(s.color, mix(vec3f(0.85, 0.82, 0.72), vec3f(0.8, 0.72, 0.3), smoothstep(0.5, 0.8, n)), crust * smoothstep(0.25, 0.5, n + 0.2));
    s.color *= 1.0 - 0.9 * smoothstep(0.6, 0.9, s.uv.y);
  } else if (m == ${MAT.SHARKFIN}u) {
    // the whale shark's fins (uv 0..1 across each): pale spots, fewer towards the tips
    let q = s.uv * 7.0;
    let d = length(fract(q) - 0.5 - 0.3 * (hash22(floor(q) + 5.0) - 0.5));
    s.color = mix(s.color, vec3f(0.75, 0.78, 0.78), (1.0 - smoothstep(0.14, 0.22, d)) * (1.0 - smoothstep(0.5, 0.9, s.uv.y)));
  } else if (m == ${MAT.EEL}u) {
    // garden eels: dark spots along the body (uv.y up it), black eyes either side of the head (uv: round it, down it)
    if (s.tag == 1u) {
      let q = vec2f(s.uv.x * 4.0, s.uv.y * 30.0);
      let h = hash22(floor(q));
      s.color *= 1.0 - 0.75 * (1.0 - smoothstep(0.15, 0.25, length(fract(q) - 0.5 - 0.3 * (h - 0.5)))) * step(0.4, h.x);
    } else {
      let ed = min(length(vec2f(s.uv.x - 0.25, s.uv.y - 0.45)), length(vec2f(s.uv.x - 0.75, s.uv.y - 0.45)));
      s.color = mix(s.color, vec3f(0.01), 1.0 - smoothstep(0.08, 0.11, ed));
    }
  } else if (m == ${MAT.CARGO}u) {
    // crates of planks, barrels with iron hoops; both grown over a little
    if (s.tag == 1u) {
      let e = abs(fract(s.uv * vec2f(1.0, 4.0)) - 0.5);
      s.color *= (0.75 + 0.25 * noise2(s.uv * vec2f(2.0, 40.0))) * (1.0 - 0.5 * (1.0 - smoothstep(0.02, 0.05, 0.5 - e.y))) * (1.0 - 0.4 * smoothstep(0.42, 0.47, e.x));
    } else {
      let h = abs(fract(s.uv.y * 3.0) - 0.5);
      s.color = mix(s.color * (0.8 + 0.2 * sin(s.uv.x * 150.0)), vec3f(0.3, 0.16, 0.08), 1.0 - smoothstep(0.04, 0.07, abs(h - 0.35)));
    }
    s.color = mix(s.color, vec3f(0.25, 0.33, 0.12), smoothstep(0.55, 0.95, s.n.z) * smoothstep(0.4, 0.7, noise3(s.pos * 3.0)) * 0.6);
  } else if (m == ${MAT.BITS}u) {
    // small things on the sea bed (see bitsKit)
    let k = s.tag;
    if (k == 1u) {
      // cone shell: brown zigzag bands winding round it
      let q = s.uv.y * 7.0 + 0.6 * abs(fract(s.uv.x * 3.0) - 0.5);
      s.color *= 0.55 + 0.45 * smoothstep(0.3, 0.45, abs(fract(q) - 0.5));
      s.gloss = 0.5;
    } else if (k == 2u) {
      // scallop: ribs fanning out from the hinge, and growth rings
      s.color *= (0.8 + 0.2 * cos(s.uv.x * 50.0)) * (0.85 + 0.15 * smoothstep(0.2, 0.5, abs(fract(s.uv.y * 6.0) - 0.5)));
    } else if (k == 3u) {
      // starfish: rows of pale knobs, and a darker middle
      let q = s.uv * 90.0;
      let d = length(fract(q) - 0.5);
      let fade = 1.0 - smoothstep(0.25, 0.5, max(fwUV.x, fwUV.y) * 90.0);
      s.color = mix(s.color * (0.75 + 0.25 * smoothstep(0.02, 0.06, length(s.uv))), vec3f(0.95, 0.85, 0.7), (1.0 - smoothstep(0.18, 0.3, d)) * 0.5 * fade);
    } else if (k == 4u) {
      // sea cucumber: warty
      s.color *= 0.7 + 0.6 * smoothstep(0.55, 0.75, noise3(s.pos * 60.0));
    } else if (k == 5u) {
      // feather-duster crown: banded rays round the funnel
      s.color *= (0.6 + 0.4 * smoothstep(0.1, 0.3, abs(fract(s.uv.x * 14.0) - 0.5))) * (0.75 + 0.35 * step(0.5, fract(s.uv.y * 3.0)));
      s.light += s.color * 0.15;
    }
  } else if (m == ${MAT.BUBBLE}u) {
    // silvery bubbles (additive light): a faint body and a bright rim, dimmer in the depths
    let rim = pow(saturate(1.0 - abs(dot(s.n, s.view))), 2.0);
    s.color = vec3f(0.75, 0.93, 1.0);
    s.emissive = (0.05 + 0.9 * rim) * depthDim(s.pos.z);
    return s;
  } else if (m == ${MAT.JELLY}u) {
    let rim = saturate(1.0 - abs(dot(s.n, s.view)));
    // a see-through bell, clear in the middle and denser towards the rim, that
    // lets most light through; its glow is not dimmed by its clearness (both
    // sides of it glow now)
    s.alpha = mix(0.1, 0.75, rim);
    if (s.tag == 1u) {
      // the bell, laid out as seen from above: four pink gonad rings round the
      // middle, fine radial canals, and eight sense organs on the margin
      let p = s.uv;
      let r = length(p);
      let gon = 1.0 - smoothstep(0.012, 0.028, abs(length(abs(p) - vec2f(0.1)) - 0.07));
      let ang = atan2(p.y, p.x) * 1.2732;   // eighths of a turn
      let canal = (1.0 - smoothstep(0.004, 0.01, abs(fract(ang * 2.0) - 0.5) * r * 0.39)) * smoothstep(0.17, 0.25, r);
      let organ = (1.0 - smoothstep(0.015, 0.025, length(vec2f((fract(ang + 0.5) - 0.5) * r * 0.785, r - 0.43)))) * step(r, 0.47);
      s.color = mix(s.color, vec3f(0.95, 0.4, 0.75), gon);
      s.color = mix(s.color, vec3f(1.0, 0.95, 0.85), max(canal * 0.6, organ));
      s.alpha = max(s.alpha, max(gon * 0.55, max(canal * 0.25, organ * 0.8)));
    } else if (s.tag == 3u) {
      // oral arms with frilled, wavy edges
      let edge = 0.55 + 0.25 * sin(s.uv.y * 38.0) + 0.15 * sin(s.uv.y * 91.0 + 1.0);
      let frill = 1.0 - smoothstep(edge - 0.08, edge, abs(s.uv.x));
      s.alpha = mix(0.0, 0.65, frill) * (1.0 - smoothstep(0.75, 1.0, s.uv.y));
    }
    s.emissive *= (0.15 + 1.6 * rim) * 0.6 / max(s.alpha, 0.1);
    s.sun *= 0.5;
    return s;
  } else if (m == ${MAT.GLOW}u) {
    // lantern anemones: a pulse of light runs north along the channel every 3 s
    let ph = fract((s.t - s.pos.y / 6.0) / 3.0);
    let pulse = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.05, 0.5, ph));
    s.emissive = 0.25 + 9.0 * pulse;
    return s;
  } else if (m == ${MAT.BEACON}u) {
    // the submarine's beacon flashes for 0.2 s every 2 s
    let on = step(fract(s.t * 0.5), 0.1);
    s.emissive = 0.3 + 22.0 * on;
    return s;
  } else if (m == ${MAT.LAMP}u) {
    return s;
  }

  // ---- the water: caustics from above, light fading and colours cooling with depth
  let lp = s.pos.xy + SUN_DIR.xy / SUN_DIR.z * depth;
  let ca = caustic(lp * 1.2, s.t);
  let k = (1.0 - 0.55 * smoothstep(4.0, 40.0, depth)) * (1.0 - smoothstep(18.0, 40.0, s.dist)) * causticAmt;
  s.sun *= mix(0.85, 0.35 + 1.9 * ca, k) * exp(-depth * 0.02);
  s.ambient *= 0.5 + 0.5 * exp(-depth * 0.03);
  s.color *= exp(-depth * vec3f(0.036, 0.012, 0.007));
  return s;
}
`;

// ---------------------------------------------------------------------------
// Geometry helpers

// A matrix that turns +Z into `dir` and moves the origin to `pos`.
function alongDir(pos, dir) {
  const z = v3.norm(dir);
  const ref = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = v3.norm(v3.cross(ref, z));
  const y = v3.cross(z, x);
  return m4.fromBasis(x, y, z, pos);
}

// A triangle wound so that it faces away from `centre` (for convex shapes).
function triAway(g, a, b, c, centre) {
  const n = v3.cross(v3.sub(b, a), v3.sub(c, a));
  const mid = v3.scale(v3.add(v3.add(a, b), c), 1 / 3);
  if (v3.dot(n, v3.sub(mid, centre)) < 0) [b, c] = [c, b];
  return g.add(Geo.triangle(a, b, c));
}

// A unit sphere like Geo.sphere(1, seg, rings), with each vertex stored once.
function seamlessSphere(seg, rings) {
  const g = new Geo();
  const at = (j, i) => (j === 0 ? 0 : j === rings ? 1 + (rings - 1) * seg : 1 + (j - 1) * seg + (i % seg));
  for (let j = 0; j <= rings; j++) {
    const th = Math.PI * j / rings;
    for (let i = 0; i < (j === 0 || j === rings ? 1 : seg); i++) {
      const ph = TAU * i / seg, n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
      g.vert(n[0], n[1], n[2], n[0], n[1], n[2]);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      if (j > 0) g.tri(at(j, i), at(j + 1, i), at(j, i + 1));
      if (j < rings - 1) g.tri(at(j, i + 1), at(j + 1, i), at(j + 1, i + 1));
    }
  }
  return g.orientByNormals();
}

// Pushes every vertex out or in from the origin by a noise factor.
function lumpy(g, amp, freq, seed) {
  for (let i = 0; i < g.p.length; i += 3) {
    const x = g.p[i], y = g.p[i + 1], z = g.p[i + 2];
    const k = 1 + amp * (noise3(x * freq + seed, y * freq, z * freq) - 0.5) * 2;
    g.p[i] = x * k; g.p[i + 1] = y * k; g.p[i + 2] = z * k;
  }
  return g;
}

// ---------------------------------------------------------------------------
// Small things on the sea bed, drawn only from near by (see "sea-bed detail"
// in build()).  Each stands on z = 0, a few centimetres across; most are
// painted in `surface` (MAT.BITS, by tag):
//   1 a cone shell (uv: around, along it)    2 a scallop (uv: across 0..1, out from the hinge 0..1)
//   3 a starfish (uv: x, y across it)        4 a sea cucumber
//   5 a feather-duster worm's crown (uv: around, up)
// a domed starfish, 0.26 m across (uv: x, y across it)
function starfishGeo() {
  const g = new Geo();
  const c = g.vert(0, 0, 0.026, 0, 0, 1, 0, 0);
  const ring = [];
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU, r = i % 2 ? 0.045 : 0.13, x = Math.cos(a) * r, y = Math.sin(a) * r;
    ring.push(g.vert(x, y, i % 2 ? 0.012 : 0.003, 0, 0, 1, x, y));
  }
  for (let i = 0; i < 10; i++) g.tri(c, ring[i], ring[(i + 1) % 10]);
  return g.orientByNormals().computeNormals(true).color(WHITE).mat(MAT.BITS).tag(3);
}

function bitsKit() {
  const k = {};
  k.cone = Geo.lathe([[0.012, 0], [0.04, 0.03], [0.026, 0.07], [0.003, 0.1]], 4).rotateY(Math.PI / 2).rotateX(Math.PI / 4)
    .translate(-0.05, 0, 0.028).color(WHITE).mat(MAT.BITS).tag(1);
  {
    const g = new Geo(), n = 6;
    const hinge = g.vert(0, -0.03, 0.012, 0, 0, 1, 0.5, 0);
    const rim = [];
    for (let i = 0; i <= n; i++) {
      const a = (-0.55 + 1.1 * i / n) * Math.PI;
      rim.push(g.vert(Math.sin(a) * 0.05, -0.03 + Math.cos(a) * 0.05, 0.003, 0, 0, 1, i / n, 1));
    }
    for (let i = 0; i < n; i++) g.tri(hinge, rim[i], rim[i + 1]);
    k.clam = g.orientByNormals().computeNormals(true).color(WHITE).mat(MAT.BITS).tag(2);
  }
  k.star = starfishGeo();
  k.cuke = Geo.lathe([[0.02, 0], [0.04, 0.06], [0.036, 0.19], [0.01, 0.24]], 5).rotateX(-Math.PI / 2)
    .translate(0, -0.12, 0).scale(1, 1, 0.75).translate(0, 0, 0.026).color(WHITE).mat(MAT.BITS).tag(4);
  k.pebble = lumpy(seamlessSphere(5, 3), 0.35, 1.7, 61).computeNormals(true).scale(1, 1, 0.55).color(WHITE).mat(MAT.ROCK);
  k.sponge = lumpy(seamlessSphere(6, 3), 0.4, 2.3, 17).computeNormals(true).scale(1, 1, 0.6).color(WHITE).mat(MAT.SPONGE);
  {
    // a sea urchin: a dark ball bristling with long spines
    const g = seamlessSphere(6, 4).scale(0.05, 0.05, 0.045).translate(0, 0, 0.04).color('#1d1a24');
    for (let i = 0; i < 14; i++) {
      const a = i * 2.4, e = Math.asin(1 - (i + 0.5) / 14 * 1.2), len = 0.16 + 0.05 * Math.sin(i * 3.1);
      const dir = [Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)];
      g.add(Geo.cylinder(0.008, len, 3, { r2: 0, caps: false }).color('#2a2433'), alongDir([dir[0] * 0.04, dir[1] * 0.04, 0.04 + dir[2] * 0.035], dir));
    }
    k.urchin = g;
  }
  k.worm = Geo.cylinder(0.008, 0.12, 4, { caps: false }).color('#8a7660').untinted()
    .add(Geo.cylinder(0.008, 0.035, 6, { r2: 0.05, caps: false }).translate(0, 0, 0.115).color(WHITE).mat(MAT.BITS).tag(5));
  {
    // a crab, side on to its course: a squat shell, three legs a side, two claws and eye stalks
    const g = Geo.sphere(0.05, 6, 3).scale(1, 0.72, 0.42).translate(0, 0, 0.035).color('#d0502c');
    const legs = new Geo();
    for (const sx of [1, -1]) {
      for (let i = 0; i < 3; i++) {
        const y = -0.022 + i * 0.022, fx = sx * (0.1 + 0.01 * i), fy = y * 1.8 - 0.01;
        legs.add(Geo.triangle([sx * 0.04, y - 0.007, 0.035], [sx * 0.04, y + 0.007, 0.035], [fx, fy, 0.0]));
        legs.add(Geo.triangle([sx * 0.07, y * 1.4 - 0.005, 0.05], [sx * 0.07, y * 1.4 + 0.005, 0.05], [fx, fy, 0.0]));
      }
      legs.add(Geo.triangle([sx * 0.025, 0.03, 0.035], [sx * 0.045, 0.028, 0.03], [sx * 0.05, 0.085, 0.04]));
      legs.add(Geo.triangle([sx * 0.045, 0.06, 0.04], [sx * 0.07, 0.065, 0.03], [sx * 0.035, 0.1, 0.035]));
      legs.add(Geo.triangle([sx * 0.012, 0.03, 0.05], [sx * 0.02, 0.03, 0.05], [sx * 0.018, 0.04, 0.075]).color('#101010'));
    }
    k.crab = g.add(legs.color('#c84a28').mat(MAT.THIN));
  }
  return k;
}

// ---------------------------------------------------------------------------
// The wreck's fittings (see "the wreck" in build()).  The hull runs from the
// stern at y = -L/2 to the bow at +L/2 (f from 0 to 1), its gunwale hullS(f)
// up and its half-width there hullW(f).

const hullW = (f) => (f < 0.35 ? 2.5 + 0.7 * Math.sin(f / 0.35 * Math.PI / 2) : 3.2 * (1 - Math.pow((f - 0.35) / 0.65, 2)));
const hullS = (f) => 4 + 0.9 * f * f;

// Crates (tag 1, uv 0..1 on each face) and barrels (tag 2, uv.y up them), painted in `surface`.
const crateGeo = () => Geo.box(1, 1, 1).translate(0, 0, 0.5).color('#8a6a48').mat(MAT.CARGO).tag(1);
const barrelGeo = () => Geo.lathe([[0.27, 0], [0.32, 0.25], [0.32, 0.65], [0.27, 0.9], [0.0, 0.9]], 8).color('#6a5a4a').mat(MAT.CARGO).tag(2);

function wreckFittings(L) {
  const g = new Geo();
  const fOf = (y) => y / L + 0.5;
  // rails along both gunwales on stanchions, broken where a stanchion is gone
  for (const side of [1, -1]) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        for (const h of [0.45, 0.9]) g.add(Geo.tube(run.map(([x, y, z], i) => [x, y, z + h - 0.04 * Math.sin(i * 1.7)]), 0.03, 4, { caps: false }));
      }
      run = [];
    };
    for (let y = -11.2; y <= 10.3; y += 1.2) {
      const f = fOf(y), x = side * (hullW(f) - 0.05), z = hullS(f);
      if (hash2(Math.round(y * 10), side) < 0.2) { flush(); continue; }
      g.add(Geo.cylinder(0.03, 0.95, 4, { caps: false }).translate(x, y, z - 0.05));
      run.push([x, y, z]);
    }
    flush();
  }
  g.color('#7a6048').mat(MAT.RUST);
  // portholes down both sides and on the deck house: brass rims round dark glass
  const port = (pos, dir, r) => {
    g.add(Geo.lathe([[r, -0.02], [r * 1.25, 0.03], [r * 1.25, 0.07], [r * 0.95, 0.09]], 8).color('#7a8a5a').mat(MAT.RUST), alongDir(pos, dir));
    g.add(Geo.disc(r, 8).translate(0, 0, 0.045).color('#0c1418').gloss(0.8), alongDir(pos, dir));
  };
  for (const side of [1, -1]) {
    for (let y = -9.5; y <= 7; y += 2.2) {
      const f = fOf(y), w = hullW(f), sz = hullS(f), z = sz - 1.1;
      port([side * w * (0.98 + 0.02 * (z - 0.55 * sz) / (0.45 * sz)), y, z], [side, 0, 0.02], 0.17);
    }
    for (const y of [-8.6, -6.4]) port([side * 1.8, y, 5.3], [side, 0, 0], 0.15);
  }
  // a door in the front of the deck house, and its frame
  g.add(Geo.box(0.9, 0.06, 1.7).translate(0.6, -5.39, 4.75).color('#0a0c10'));
  g.add(Geo.box(1.1, 0.1, 0.1).translate(0.6, -5.37, 5.65).color('#7a6048').mat(MAT.RUST));
  for (const x of [0.07, 1.13]) g.add(Geo.box(0.1, 0.1, 1.8).translate(x, -5.37, 4.75).color('#7a6048').mat(MAT.RUST));
  // two hatches in the deck: raised coamings, one open onto the dark hold, the other's cover slid half off
  for (const [y, open] of [[-3.4, true], [5.4, false]]) {
    const f = fOf(y), z = 3.6 + 0.9 * f * f + 0.075;
    for (const [sx, sy, dx, dy] of [[1.6, 0.1, 0, 0.75], [1.6, 0.1, 0, -0.75], [0.1, 1.6, 0.75, 0], [0.1, 1.6, -0.75, 0]]) {
      g.add(Geo.box(sx, sy, 0.35).translate(dx, y + dy, z + 0.175).color('#806650').mat(MAT.RUST));
    }
    if (open) g.add(Geo.quad([-0.7, y - 0.7, z + 0.05], [0.7, y - 0.7, z + 0.05], [0.7, y + 0.7, z + 0.05], [-0.7, y + 0.7, z + 0.05]).color('#050608'));
    else g.add(Geo.box(1.5, 1.5, 0.08).translate(0, 0, 0.04).color('#806650').mat(MAT.RUST), m4.mul(m4.translation(0.6, y + 0.2, z + 0.32), m4.rotationZ(0.25), m4.rotationY(-0.12)));
  }
  // cargo in the open hold
  g.add(crateGeo().scale(0.9), m4.mul(m4.translation(0.3, -3.3, 2.6), m4.rotationZ(0.3)));
  g.add(crateGeo().scale(0.8), m4.mul(m4.translation(-0.6, -2.9, 2.5), m4.rotationZ(-0.2), m4.rotationX(0.15)));
  g.add(barrelGeo(), m4.mul(m4.translation(0.1, -3.9, 2.4), m4.rotationX(Math.PI / 2 - 0.1), m4.rotationZ(0.2)));
  return g;
}

// Around the wreck, in world coordinates: the anchor lying on the sand off the
// bow, its chain running up to the hawse, and crates and barrels spilled
// beside the hull.
function wreckSurroundings(pose, L) {
  const g = new Geo();
  const onSand = (lx, ly) => { const p = m4.point(pose, [lx, ly, 0]); return [p[0], p[1], floorMesh(p[0], p[1])]; };
  // the anchor: shank, stock and two flukes, lying on its side
  const a0 = onSand(2.2, L / 2 + 3.4), ad = v3.norm(v3.sub(onSand(2.6, L / 2 + 5), a0));
  const side = v3.norm(v3.cross(ad, [0, 0, 1]));
  const anc = new Geo();
  anc.add(Geo.cylinder(0.07, 1.7, 5, { caps: false }).rotateX(-Math.PI / 2).translate(0, 0, 0.09));
  anc.add(Geo.cylinder(0.05, 1.5, 5).rotateY(Math.PI / 2).translate(-0.75, 0.15, 0.35));
  anc.add(Geo.torus(0.13, 0.03, 8, 3).rotateY(Math.PI / 2).translate(0, -0.1, 0.12));
  for (const s of [1, -1]) {
    anc.add(Geo.cylinder(0.06, 0.8, 5, { caps: false }).rotateX(-Math.PI / 2).rotateZ(s * 0.9).translate(0, 1.7, 0.09));
    const tip = [s * Math.sin(0.9) * 0.8, 1.7 + Math.cos(0.9) * 0.8, 0.09];
    anc.add(Geo.quad([tip[0] * 0.55, tip[1] - 0.25, 0.09], [tip[0] * 1.15, tip[1] - 0.2, 0.09], [tip[0] * 1.05, tip[1] + 0.12, 0.12], [tip[0] * 0.6, tip[1] - 0.02, 0.12]).mat(MAT.THIN));
  }
  g.add(anc.color('#5a4a3c').mat(MAT.RUST), m4.fromBasis(side, ad, [0, 0, 1], a0));
  // the chain: links alternately turned, hanging from the hawse to the anchor's ring
  const hawse = m4.point(pose, [0.9, L / 2 - 1.6, 4.2]);
  const ring = v3.add(a0, v3.scale(ad, -0.1));
  const links = 26;
  let prev = null;
  for (let i = 0; i <= links; i++) {
    const t = i / links;
    const p = v3.add(v3.add(v3.scale(hawse, 1 - t), v3.scale(ring, t)), [0, 0, -1.2 * Math.sin(Math.PI * t) * (1 - t)]);
    p[2] = Math.max(p[2], floorMesh(p[0], p[1]) + 0.03);
    if (prev) {
      const mid = v3.scale(v3.add(prev, p), 0.5), d = v3.norm(v3.sub(p, prev));
      const ref = i % 2 ? [0, 0, 1] : v3.cross(d, [0, 0, 1]);
      const x = v3.norm(v3.cross(d, ref)), z = v3.cross(x, d);
      g.add(Geo.torus(0.1, 0.025, 6, 3).scale(0.75, 1.3, 1).color('#4a3c30').mat(MAT.RUST), m4.fromBasis(x, d, z, mid));
    }
    prev = p;
  }
  // the propeller, broken off its shaft and lying against the sand by the stern
  {
    const prop = Geo.cylinder(0.12, 0.5, 6).translate(0, 0, -0.25).add(Geo.sphere(0.2, 6, 3).scale(1, 1, 1.4).translate(0, 0, 0.1));
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + 0.4, c = Math.cos(a), sn = Math.sin(a);
      const P = (r, dz, t) => [c * r - sn * t, sn * r + c * t, dz];
      prop.add(Geo.quad(P(0.15, 0.12, -0.08), P(0.95, 0.06, -0.14), P(0.95, -0.06, 0.14), P(0.15, -0.12, 0.08)).mat(MAT.THIN));
    }
    const p = onSand(4.6, -9.2);
    g.add(prop.color('#8a7a4a').gloss(0.35), m4.mul(m4.translation(p[0], p[1], p[2] + 0.5), m4.rotationZ(1.1), m4.rotationX(1.15)));
  }
  // cargo spilled on the sand
  const spill = [[4.5, -2, 0.3, 1.0], [5.3, -0.6, 1.1, 0.8], [4.2, 0.8, 2.0, 0.9], [-4.6, 3.5, 0.7, 0.85], [-5.2, 5, 2.6, 0.8]];
  for (const [lx, ly, rot, sz] of spill) {
    const p = onSand(lx, ly);
    g.add(crateGeo().scale(sz), m4.mul(m4.translation(p[0], p[1], p[2] - 0.15), m4.rotationZ(rot), m4.rotationX(0.08 * Math.sin(rot * 5))));
  }
  for (const [lx, ly, rot, up] of [[4.9, 2.4, 0.4, false], [-4.4, 1.5, 1.3, true], [5.8, -3.4, 2.2, false]]) {
    const p = onSand(lx, ly);
    g.add(barrelGeo(), up ? m4.mul(m4.translation(p[0], p[1], p[2] - 0.05), m4.rotationZ(rot))
      : m4.mul(m4.translation(p[0], p[1], p[2] + 0.27), m4.rotationZ(rot), m4.rotationY(Math.PI / 2), m4.translation(0, 0, -0.45)));
  }
  return g;
}

// ---------------------------------------------------------------------------
// Reef life (static): corals, sponges, anemones, rocks and the like.
//
// They are drawn with b.instances.  Every kind of growth has a few prototype
// meshes, stored once, and each copy on the reef is one of them, placed with
// its own turn, size and colour (the copy's tint): some 1,800 copies of 28
// prototypes, one instanced draw per prototype.  A copy is made in two
// steps: a function such as `rock(rand, r, h)` below draws the copy's random
// numbers in the order the reef has always drawn them, so that everything
// stays where it was, and returns { kind, shape, pre, size, tint, second };
// `KIND[kind].mesh(shape)` builds a prototype from such numbers, at unit size
// (or at `size` for the kinds whose shape does not simply scale) and white
// wherever the tint is to show, and `pre` (or `fit`) puts it in the copy's
// own frame (standing on z = 0, as each mesh always has).
//
// Parts that keep a colour of their own are tagged (see the top of `surface`):
//   1  not tinted: the mesh's own colour (stalks, stems, the lanterns' columns)
//   2  the growing tips of branching coral: the copy's colour mixed with its second colour
//   3  the copy's second colour (an anemone's column)
// The second colour is one of SECOND (see "Colours"), given by the copy's number (s.inst.w).

const WHITE = '#ffffff';
const second = (c) => { const i = SECOND.indexOf(c); if (i < 0) throw new Error('reef: no second colour ' + c); return i; };
const scaled = (s) => m4.scaling(s, s, s);

// Set to true to give every copy a prototype of its own, built from its own
// numbers at its own size: the shapes exactly as they were before instancing,
// for checking (it costs some 1,800 draws per pass).
const ONE_PER_COPY = false;

const KIND = {
  rock: {
    variants: 4, seed: 101,
    shape: (rand) => rand() * 50,
    mesh: (seed) => lumpy(Geo.sphere(1, 9, 6), 0.3, 1.5, seed).computeNormals(false).color(WHITE).mat(MAT.ROCK),
  },
  brain: {
    variants: 1,
    mesh: () => Geo.lathe([[1, -0.15], [0.98, 0.25], [0.8, 0.55], [0.45, 0.75], [0, 0.8]], 14).color(WHITE).mat(MAT.BRAIN),
  },
  table: {
    variants: 1,
    mesh: () => Geo.cylinder(0.1, 0.55, 6, { caps: false }).color(PAL.brown).tag(1)
      .add(Geo.lathe([[0.1, 0.5], [1, 0.6], [1.02, 0.68], [0.12, 0.64]], 14).color(WHITE).mat(MAT.CORAL)),
  },
  // Branching (staghorn-like) coral: tapering branches that fork twice.  The
  // shape is the list of branches at unit size.
  branch: {
    variants: 5, seed: 202,
    shape: (rand) => {
      const out = [];
      const grow = (p, dir, len, r, depth) => {
        out.push({ p, dir, len, r, depth });
        if (depth === 0) return;
        const end = v3.add(p, v3.scale(v3.norm(dir), len));
        const n = depth === 2 ? rand.int(2, 3) : 2;
        for (let i = 0; i < n; i++) {
          const a = rand() * TAU;
          const nd = v3.norm([dir[0] + Math.cos(a) * 0.75, dir[1] + Math.sin(a) * 0.75, dir[2] + 0.35]);
          grow(end, nd, len * rand.range(0.65, 0.85), r * 0.7, depth - 1);
        }
      };
      const n = rand.int(2, 4);
      for (let i = 0; i < n; i++) {
        const a = rand() * TAU;
        grow([0, 0, 0], [Math.cos(a) * 0.4, Math.sin(a) * 0.4, 1], rand.range(0.4, 0.55), 0.07, 2);
      }
      return out;
    },
    mesh: (branches) => {
      const g = new Geo();
      for (const { p, dir, len, r, depth } of branches) {
        const seg = depth === 2 ? 5 : depth === 1 ? 4 : 3;
        const br = Geo.cylinder(r, len, seg, { r2: depth === 0 ? r * 0.55 : r * 0.7, caps: false }).color(WHITE).mat(MAT.CORAL);
        // the outermost branches are paler: the growing tips
        g.add(depth === 0 ? br.tag(2) : br, alongDir(p, dir));
      }
      return g;
    },
  },
  pillar: {
    variants: 2, seed: 303,
    shape: (rand) => {
      const n = rand.int(3, 6), out = [];
      for (let i = 0; i < n; i++) out.push([rand.range(0.12, 0.22), rand.range(0.6, 1.6), rand() * TAU, rand.range(0, 0.4)]);
      return out;
    },
    mesh: (list) => {
      const g = new Geo();
      for (const [r, h, a, d] of list) g.add(Geo.lathe([[r, -0.1], [r, h - r * 0.7], [0, h]], 6).translate(Math.cos(a) * d, Math.sin(a) * d, 0));
      return g.color(WHITE).mat(MAT.CORAL);
    },
  },
  // Sea fan: a cupped fan of branches on a short stem.  Its shape does not
  // simply scale with its size, so prototypes are made at a size of 1.2.
  fan: {
    variants: 3, seed: 404, size: 1.2,
    shape: (rand) => {
      const out = [];
      for (let k = 0; k < 5 * 12; k++) out.push(0.85 + 0.25 * rand(), (rand() - 0.5) * 0.04);
      return out;
    },
    mesh: (shape, size) => {
      const g = new Geo();
      const rings = 4, segs = 11;
      const verts = [];
      for (let j = 0, k = 0; j <= rings; j++) {
        for (let i = 0; i <= segs; i++, k += 2) {
          const a = (0.12 + 0.76 * i / segs) * Math.PI, rr = size * (j / rings) * shape[k];
          const x = Math.cos(a) * rr, z = Math.sin(a) * rr * 1.1 + 0.15, y = 0.15 * (x * x) / size + shape[k + 1];
          verts.push(g.vert(x, y, z, 0, -1, 0, 0.5 + x / size * 0.5, z / size));
        }
      }
      for (let j = 0; j < rings; j++) {
        for (let i = 0; i < segs; i++) {
          const a = j * (segs + 1) + i;
          g.quadIdx(verts[a], verts[a + segs + 2], verts[a + segs + 1], verts[a + 1]);
        }
      }
      g.computeNormals(true);
      g.color(WHITE).mat(MAT.FAN).cutout();
      g.add(Geo.cylinder(0.035, 0.2, 4, { caps: false }).color(PAL.brown).tag(1));
      return g;
    },
    fit: (size, s0) => scaled(size / s0),
  },
  // Barrel sponge; prototypes are made 0.6 wide and 1.2 tall.
  barrel: {
    variants: 1, size: [0.6, 1.2],
    mesh: (_, [r, h]) => Geo.lathe([[0.45 * r, -0.1], [0.7 * r, 0.3 * h], [r, 0.8 * h], [0.95 * r, h], [0.78 * r, h], [0.6 * r, 0.45 * h]], 12)
      .color(WHITE).mat(MAT.SPONGE),
    fit: ([r, h], [r0, h0]) => m4.scaling(r / r0, r / r0, h / h0),
  },
  tubes: {
    variants: 3, seed: 505,
    shape: (rand) => {
      const n = rand.int(3, 6), out = [];
      for (let i = 0; i < n; i++) out.push([rand.range(0.07, 0.13), rand.range(0.5, 1.3), rand() * TAU, rand.range(0.05, 0.3)]);
      return out;
    },
    mesh: (list) => {
      const g = new Geo();
      for (const [r, h, a, d] of list) {
        const tube = Geo.lathe([[r, -0.1], [r * 1.15, h], [r * 0.8, h], [r * 0.75, h * 0.6]], 5);
        g.add(tube, m4.mul(m4.translation(Math.cos(a) * d, Math.sin(a) * d, 0), m4.rotationAxis([-Math.sin(a), Math.cos(a), 0], d * 0.6)));
      }
      return g.color(WHITE).mat(MAT.SPONGE);
    },
  },
  // Anemone: a squat column with a crown of tentacles (unit size).  The
  // lanterns along the channel are a kind of their own, with fewer tentacles
  // that glow.
  anemone: {
    variants: 2, seed: 606,
    shape: (rand) => anemoneShape(rand, 18),
    mesh: (shape) => anemoneMesh(shape, false),
  },
  lantern: {
    variants: 1, seed: 707,
    shape: (rand) => anemoneShape(rand, 10),
    mesh: (shape) => anemoneMesh(shape, true),
  },
  soft: {
    variants: 3, seed: 808,
    shape: (rand) => {
      const n = rand.int(4, 7), out = [];
      for (let i = 0; i < n; i++) out.push([rand() * TAU, rand.range(0.05, 0.25), rand.range(0.3, 0.6), rand.range(0.13, 0.22), rand() * 9]);
      return out;
    },
    mesh: (list) => {
      const g = Geo.cylinder(0.08, 0.35, 5, { r2: 0.06, caps: false }).color(PAL.cream).tag(1);
      for (const [a, d, z, r, seed] of list) {
        g.add(lumpy(Geo.sphere(r, 5, 3), 0.3, 6, seed).translate(Math.cos(a) * d, Math.sin(a) * d, z).color(WHITE).mat(MAT.CORAL));
      }
      return g;
    },
  },
  starfish: {
    variants: 1,
    // (the domed, knobbly starfish of the sea-bed detail, at the size these always had)
    mesh: () => starfishGeo().scale(1.55, 1.55, 1.55),
  },
  urchin: {
    variants: 1, seed: 909,
    shape: (rand) => {
      const out = [];
      for (let i = 0; i < 18; i++) out.push([rand() * TAU, rand.range(-0.2, 1), rand.range(0.18, 0.3)]);
      return out;
    },
    mesh: (list) => {
      const g = Geo.sphere(0.1, 6, 4).color('#1d1a24').translate(0, 0, 0.06);
      for (const [a, e, len] of list) {
        const dir = [Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)];
        g.add(Geo.cylinder(0.012, len, 3, { r2: 0, caps: false }).color('#2a2433'), alongDir([dir[0] * 0.08, dir[1] * 0.08, 0.06 + dir[2] * 0.08], dir));
      }
      return g;
    },
  },
};

function anemoneShape(rand, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([rand() * 0.2, rand.range(0.6, 0.95)]);
  return out;
}
function anemoneMesh(tentacles, glow) {
  const g = Geo.cylinder(0.55, 0.5, 8, { r2: 0.75 }).color(glow ? '#5a4a5a' : WHITE).tag(glow ? 1 : 3);
  const n = tentacles.length;
  tentacles.forEach(([da, len], i) => {
    const a = i / n * TAU + da, rr = 0.35 + 0.35 * (i % 2);
    const dir = [Math.cos(a) * 0.7, Math.sin(a) * 0.7, 1];
    const t = Geo.cylinder(0.09, len, 3, { r2: 0, caps: false }).color(WHITE).mat(glow ? MAT.GLOW : MAT.CORAL);
    g.add(t, alongDir([Math.cos(a) * rr, Math.sin(a) * rr, 0.45], dir));
  });
  return g;
}

// The copies.  Each draws its random numbers as the old mesh builder of the
// same name did, in the same order.
function rock(rand, r, h) {
  const shape = KIND.rock.shape(rand);
  const sx = r * rand.range(0.8, 1.2), sy = r * rand.range(0.8, 1.2);
  const tint = hex(rand.pick(['#8d8274', '#7c7f7a', '#94877a', '#857a86']));
  return { kind: 'rock', shape, pre: m4.mul(m4.translation(0, 0, h * 0.25), m4.scaling(sx, sy, h)), tint };
}
const brain = (r, color) => ({ kind: 'brain', pre: scaled(r), tint: color });
const table = (r, color) => ({ kind: 'table', pre: scaled(r), tint: color });
function branch(rand, size, color, tip) {
  return { kind: 'branch', shape: KIND.branch.shape(rand), pre: m4.mul(m4.translation(0, 0, -0.1), scaled(size)), tint: color, second: second(tip) };
}
const pillar = (rand, color) => ({ kind: 'pillar', shape: KIND.pillar.shape(rand), pre: m4.identity(), tint: color });
const fan = (rand, size, color) => ({ kind: 'fan', shape: KIND.fan.shape(rand), size, tint: color });
const barrel = (r, h, color) => ({ kind: 'barrel', size: [r, h], tint: color });
const tubes = (rand, color) => ({ kind: 'tubes', shape: KIND.tubes.shape(rand), pre: m4.identity(), tint: color });
function anemone(rand, r, color, tip, glow = false) {
  const kind = glow ? 'lantern' : 'anemone';
  return { kind, shape: KIND[kind].shape(rand), pre: scaled(r), tint: color, second: glow ? 0 : second(tip) };
}
const softCoral = (rand, color) => ({ kind: 'soft', shape: KIND.soft.shape(rand), pre: m4.identity(), tint: color });
const starfish = (color) => ({ kind: 'starfish', pre: m4.identity(), tint: color });
const urchin = (rand) => ({ kind: 'urchin', shape: KIND.urchin.shape(rand), pre: m4.identity() });

// Collects the copies by prototype; `grow()` adds them to the scene, one
// b.instances call per prototype.
function garden(b) {
  const vary = rng(29); // which prototype each copy gets: kept apart from the layout's random numbers
  const protos = {};
  const beds = new Map();
  return {
    plant(c, m) {
      const k = KIND[c.kind];
      let geo, s0 = k.size;
      if (ONE_PER_COPY) {
        s0 = c.size ?? s0;
        geo = k.mesh(c.shape, s0);
      } else {
        protos[c.kind] ||= Array.from({ length: k.variants }, (_, i) => k.mesh(k.shape ? k.shape(rng(k.seed + i)) : null, s0));
        geo = protos[c.kind][k.variants > 1 ? vary.int(0, k.variants - 1) : 0];
      }
      const pre = k.fit ? k.fit(c.size, s0) : c.pre;
      if (!beds.has(geo)) beds.set(geo, []);
      beds.get(geo).push({ transform: m4.mul(m, pre), tint: c.tint, data: c.second ?? 0 });
    },
    grow() {
      for (const [geo, at] of beds) b.instances(geo, at);
    },
  };
}

// ---------------------------------------------------------------------------
// Animals (dynamic).  Models face +Y with +Z up.

// A fish of 26 triangles on 28 vertices (28 on 30 for the kinds with tall
// fins, whose dorsal and anal fins are quads): a smooth body (a pointed snout, a
// four-sided ring at the head, a six-sided one at the widest point, and the
// tail stalk), a forked tail, a dorsal and an anal fin and two pectoral fins.
// It is painted in `surface` (see FISH_WGSL): the body's uv is the point's
// place along and up the fish in body lengths (the snout at +0.5, the tail
// stalk at -0.3), its aux how high it lies across the body (-1 belly .. 1
// back), and its tag the kind of fish.  The vertex colours are flat (one per
// part): tiny moving triangles must not carry colour gradients, because a pixel
// that only grazes one gets its colour extrapolated, possibly below zero; the
// shader's patterns are clamped instead.  The vertices are shared where the
// body is smooth, since every key stores every vertex again.
function fishGeo(f) {
  const L = f.L, h = f.h / 2, w = f.w / 2;
  const yA = 0.37 * L, yB = 0.03 * L, hA = (f.head ?? 0.66) * h, wA = 0.82 * w, zN = (f.mouth ?? -0.02) * L, zT = 0.02 * L;
  const g = new Geo();
  const V = (x, y, z, zn) => { const k = g.vert(x, y, z, 0, 0, 1, y / L, z / L); g.x[k * 2] = zn; return k; };
  const N = V(0, 0.5 * L, zN, 0), T = V(0, -0.3 * L, zT, 0);
  const A = [[0, hA, 1], [wA, 0, 0], [0, -0.9 * hA, -1], [-wA, 0, 0]].map(([x, z, zn]) => V(x, yA, z, zn));
  const B = [[0, h, 1], [w, 0.45 * h, 0.45], [0.9 * w, -0.45 * h, -0.45], [0, -0.9 * h, -1], [-0.9 * w, -0.45 * h, -0.45], [-w, 0.45 * h, 0.45]]
    .map(([x, z, zn]) => V(x, yB, z, zn));
  // a triangle wound to face away from the body's axis
  const tri = (i, j, k) => {
    const P = (q) => [g.p[q * 3], g.p[q * 3 + 1], g.p[q * 3 + 2]];
    const a = P(i), b = P(j), c = P(k), mid = v3.scale(v3.add(v3.add(a, b), c), 1 / 3);
    const n = v3.cross(v3.sub(b, a), v3.sub(c, a));
    if (v3.dot(n, v3.sub(mid, [0, mid[1], 0])) < 0) g.tri(i, k, j); else g.tri(i, j, k);
  };
  for (let i = 0; i < 4; i++) tri(N, A[i], A[(i + 1) % 4]);
  for (let i = 0; i < 6; i++) tri(T, B[i], B[(i + 1) % 6]);
  // head ring to body ring: each side vertex of the head meets two of the body
  const pairs = [[0, 0], [1, 1], [1, 2], [2, 3], [3, 4], [3, 5], [0, 0]];
  for (let k = 0; k < 6; k++) {
    const [a0, b0] = pairs[k], [a1, b1] = pairs[k + 1];
    tri(A[a0], B[b0], B[b1 % 6]);
    if (a1 !== a0) tri(A[a0], B[b1 % 6], A[a1]);
  }
  g.computeNormals(true).color(f.flank).mat(MAT.FISH).gloss(f.gloss);
  // the outline of the back and belly at y, for setting the fins on
  const prof = (y, top) => {
    const pts = [[0.5 * L, zN], [yA, top ? hA : -0.9 * hA], [yB, top ? h : -0.9 * h], [-0.3 * L, zT]];
    for (let i = 1; i < pts.length; i++) {
      if (y >= pts[i][0]) { const [y0, z0] = pts[i - 1], [y1, z1] = pts[i]; return z1 + (z0 - z1) * (y - y1) / (y0 - y1); }
    }
    return zT;
  };
  // a flat fin: a fan of triangles; `edge` (aux) is 0 at its root and 1 at its rim
  const fin = (pts, edge, col) => {
    const n = v3.norm(v3.cross(v3.sub(pts[1], pts[0]), v3.sub(pts[2], pts[0])));
    const ks = pts.map((p, i) => { const k = g.vert(p[0], p[1], p[2], n[0], n[1], n[2], p[1] / L, p[2] / L); g.x[k * 2] = edge[i]; return k; });
    for (let i = 1; i + 1 < ks.length; i++) g.tri(ks[0], ks[i], ks[i + 1]);
    const c = hex(col);
    for (const k of ks) {
      g.c[k * 3] = c[0]; g.c[k * 3 + 1] = c[1]; g.c[k * 3 + 2] = c[2];
      g.a[k * 4 + 1] = 0.2; g.a[k * 4 + 2] = MAT.FIN;
    }
  };
  // tail: two lobes and the notch between them
  const yt = -0.52 * L, th = 0.22 * L * f.tailH, ty = -0.3 * L;
  fin([[0, ty, zT], [0, yt, zT + th * 1.1], [0, yt + 0.15 * L * f.fork, zT], [0, yt, zT - th]], [0, 1, 0.6, 1], f.tail);
  // dorsal and anal fins along the back and belly (a quad for the tall fins of a tang)
  const [d0, d1, dh] = f.dorsal, [a0, a1, ah] = f.anal;
  const yd0 = d0 * L, yd1 = d1 * L, ya0 = a0 * L, ya1 = a1 * L;
  const sink = 0.06 * h;
  if (f.tall) {
    fin([[0, yd0, prof(yd0, true) - sink], [0, yd1, prof(yd1, true) - sink], [0, yd1 + 0.04 * L, prof(yd1, true) + dh * L * 0.8], [0, yd0 - 0.12 * L, prof(yd0, true) + dh * L]], [0, 0, 1, 1], f.fins);
    fin([[0, ya0, prof(ya0, false) + sink], [0, ya1, prof(ya1, false) + sink], [0, ya1 + 0.04 * L, prof(ya1, false) - ah * L * 0.8], [0, ya0 - 0.12 * L, prof(ya0, false) - ah * L]], [0, 0, 1, 1], f.fins);
  } else {
    const yd = yd0 + (yd1 - yd0) * 0.7, ya = ya0 + (ya1 - ya0) * 0.7;
    fin([[0, yd0, prof(yd0, true) - sink], [0, yd1, prof(yd1, true) - sink], [0, yd, prof(yd, true) + dh * L]], [0, 0, 1], f.fins);
    fin([[0, ya0, prof(ya0, false) + sink], [0, ya1, prof(ya1, false) + sink], [0, ya, prof(ya, false) - ah * L]], [0, 0, 1], f.fins);
  }
  // pectoral fins just behind the gill covers, swept back and out
  for (const s of [1, -1]) {
    const x = s * 0.8 * w, out = s * (0.8 * w + 0.11 * L);
    fin([[x, 0.25 * L, -0.12 * h], [x, 0.21 * L, -0.42 * h], [out, 0.07 * L, -0.45 * h]], [0, 0, 1], f.fins);
  }
  return g.tag(f.tag);
}

// Moves a model along a closed path (either way round, by the sign of `speed`)
// with a fixed sideways and vertical offset.
function laneTf(path, { speed, offset = 0, dx = 0, dz = 0, span = 3 }) {
  return (t) => {
    const at = path.smoothAt(offset + speed * t, span);
    const p = at.p, dir = speed < 0 ? v3.scale(at.dir, -1) : at.dir;
    const r = v3.norm(v3.cross(dir, [0, 0, 1]));
    return m4.facing([p[0] + r[0] * dx, p[1] + r[1] * dx, p[2] + dz], dir);
  };
}

// Distance along a path of the point nearest to [x, y] (to place things at t = 0).
function nearestOn(path, [x, y]) {
  let best = 0, bd = Infinity;
  for (let d = 0; d < path.length; d += 0.25) {
    const { p } = path.at(d);
    const e = Math.hypot(p[0] - x, p[1] - y);
    if (e < bd) { bd = e; best = d; }
  }
  return best;
}

function addFollower(b, geo, tf, dur, size, extra = {}) {
  b.dynamic(geo, {
    times: adaptiveTimes(tf, 0, dur, { tolerance: 0.1, maxStep: 8, size }),
    transform: tf, caps: 'none', ...extra,
  });
}

function turtleGeo(t) {
  const g = new Geo();
  const shell = Geo.sphere(1, 8, 4);
  shell.color('#6b4e2e');
  for (let i = 2; i < shell.p.length; i += 3) if (shell.p[i] < 0) shell.p[i] *= 0.45;
  g.add(shell.scale(0.42, 0.56, 0.17).mat(MAT.SHELL));
  // the head (painted in `surface`: scales, eyes, a pale throat)
  g.add(Geo.sphere(0.12, 6, 3).scale(1, 1.3, 0.85).translate(0, 0.64, 0.01).color('#8a7c58').mat(MAT.TURTLE));
  const a = 0.75 * Math.sin(TAU * t / 4), sweep = 0.25 * Math.cos(TAU * t / 4);
  for (const side of [1, -1]) {
    // front flipper: a long blade rowing up and down around its root
    const root = [0.3, 0.3];
    const blade = [[0.28, 0.36], [0.72, 0.3], [1.02, 0.02], [0.28, 0.16]].map(([x, y]) => {
      let dx = x - root[0], dy = y - root[1];
      [dx, dy] = [dx * Math.cos(sweep) - dy * Math.sin(sweep), dx * Math.sin(sweep) + dy * Math.cos(sweep)];
      return [side * (root[0] + dx * Math.cos(a)), root[1] + dy, -dx * Math.sin(a)];
    });
    // (the flippers' uv is their flat outline, for the scales painted in `surface`)
    const flipper = (p, flat) => {
      const f = Geo.triangle(...p).color('#8a7c58').mat(MAT.FLIPPER);
      flat.forEach(([u, v], i) => { f.uv[i * 2] = u; f.uv[i * 2 + 1] = v; });
      g.add(f);
    };
    const flat = [[0.28, 0.36], [0.72, 0.3], [1.02, 0.02], [0.28, 0.16]];
    flipper([blade[0], blade[1], blade[2]], [flat[0], flat[1], flat[2]]);
    flipper([blade[0], blade[2], blade[3]], [flat[0], flat[2], flat[3]]);
    const b2 = 0.2 * Math.sin(TAU * t / 4 + 1.5);
    flipper([[side * 0.18, -0.32, 0], [side * 0.4, -0.52, -b2], [side * 0.14, -0.48, 0]], [[0.18, -0.32], [0.4, -0.52], [0.14, -0.48]]);
  }
  return g;
}

// Manta ray: a flexible two-layer wing that flaps in a slow wave every 6 s.
function mantaGeo(t) {
  const W = 2.4, L = 2.3, cols = 9, rows = 3, ph = TAU * t / 6;
  const out = new Geo();
  for (const sgn of [1, -1]) {
    const g = new Geo();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cc = c - 4, s = Math.abs(cc) / 4;
        // swept, curving leading edge; trailing edge bowed forward; pointed tips
        const yF = L * (0.42 - 0.72 * Math.pow(s, 1.6));
        const yB = L * (-0.36 + 0.42 * Math.sin(Math.PI * Math.min(1, s * 1.15)) * (1 - s) + 0.06 * s);
        const y = yF + (yB - yF) * r / (rows - 1);
        const flap = 1.0 * Math.pow(s, 1.6) * Math.sin(ph - 1.3 * s - 0.25 * r);
        const thick = 0.18 * Math.pow(1 - s, 1.5) * (r === 1 ? 1 : 0.55);
        // (uv: the point's place on the flat ray, for the markings painted in `surface`)
        const x = W * cc / 4 * (1 - 0.06 * r * s);
        const k = g.vert(x, y, flap + sgn * thick, 0, 0, sgn, x, y);
        const col = sgn > 0 ? hex('#262d36') : hex('#f2f6f7');
        g.c[k * 3] = col[0]; g.c[k * 3 + 1] = col[1]; g.c[k * 3 + 2] = col[2];
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        if (sgn > 0) g.quadIdx(a, a + cols, a + cols + 1, a + 1);
        else g.quadIdx(a, a + 1, a + cols + 1, a + cols);
      }
    }
    g.computeNormals(true).mat(MAT.MANTA).tag(sgn > 0 ? 1 : 2);
    // the white belly catches the light thrown up from the sand
    if (sgn < 0) g.emissive(0.3);
    out.add(g);
  }
  // the cephalic fins ("horns") either side of the mouth, rolled half up
  for (const side of [1, -1]) {
    out.add(Geo.quad([side * 0.2, 0.91, -0.02], [side * 0.32, 0.87, -0.13], [side * 0.36, 1.36, -0.17], [side * 0.27, 1.4, -0.06]).color('#1e242c').mat(MAT.THIN));
  }
  const tw = 0.15 * Math.sin(ph - 1);
  out.add(Geo.triangle([-0.05, -L * 0.36, 0], [0.05, -L * 0.36, 0], [tw, -L * 0.36 - 1.4, 0.05]).color('#1e242c').mat(MAT.THIN));
  return out.gloss(0.25);
}

// Whale shark: a broad, flattened body whose tail sweeps every 7.5 s.
const SHARK_L = 9;
function sharkBase() {
  const L = SHARK_L;
  const body = Geo.lathe([[0.03, 0], [0.24, 0.7], [0.45, 2.0], [0.68, 3.8], [0.8, 5.6], [0.78, 7.2], [0.6, 8.4], [0.3, 8.95], [0, 9.05]], 10)
    .rotateX(-Math.PI / 2).translate(0, -L / 2, 0).scale(1.2, 1, 0.8);
  body.color('#3f4d60').mat(MAT.SPOTS).gloss(0.3);
  // (uv.y: along the body from the tip of the tail, for the markings in `surface`)
  for (let i = 0; i < body.vertexCount; i++) body.uv[i * 2 + 1] = (body.p[i * 3 + 1] + L / 2) / 9.05;
  const fins = new Geo();
  const fin = (a, b, c) => fins.add(Geo.triangle(a, b, c));
  fin([0, -0.4, 0.55], [0, -1.8, 0.48], [0, -1.5, 1.9]);
  fin([0, -2.8, 0.3], [0, -3.3, 0.26], [0, -3.45, 0.85]);
  fin([0.8, 1.6, -0.25], [0.8, 0.6, -0.3], [2.2, 0.2, -0.85]);
  fin([-0.8, 1.6, -0.25], [-0.8, 0.6, -0.3], [-2.2, 0.2, -0.85]);
  fin([0, -4.2, 0.08], [0, -4.75, 0.0], [0, -5.7, 2.1]);
  fin([0, -4.3, -0.05], [0, -4.8, 0.0], [0, -5.3, -1.1]);
  fins.color('#3f4d60').mat(MAT.SHARKFIN);
  return body.add(fins);
}
function sharkAt(base, t) {
  const g = base.clone();
  const w = TAU * t / 7.5;
  const off = (y) => { const f = (SHARK_L / 2 - y) / SHARK_L; return (0.04 + 0.6 * f * f) * Math.sin(w - 2.4 * f); };
  for (let i = 0; i < g.p.length; i += 3) {
    const y = g.p[i + 1];
    g.p[i] += off(y);
    const slope = (off(y + 0.1) - off(y - 0.1)) / 0.2;
    const al = -Math.atan(slope), c = Math.cos(al), s = Math.sin(al);
    const nx = g.n[i], ny = g.n[i + 1];
    g.n[i] = nx * c - ny * s; g.n[i + 1] = nx * s + ny * c;
  }
  return g;
}

function jellyGeo(color) {
  // the bell (uv: where it lies seen from above, for its markings), open underneath
  const g = Geo.lathe([[0.42, 0.0], [0.52, 0.08], [0.44, 0.34], [0.0, 0.52]], 8).color(color).mat(MAT.JELLY).tag(1);
  for (let i = 0; i < g.vertexCount; i++) { g.uv[i * 2] = g.p[i * 3]; g.uv[i * 2 + 1] = g.p[i * 3 + 1]; }
  // a fringe of fine tentacles round the margin
  for (let i = 0; i < 12; i++) {
    const a = (i + 0.5) / 12 * TAU, r = 0.41, len = 1.1 + 0.6 * ((i * 5) % 3) / 2;
    g.add(Geo.triangle([Math.cos(a) * r, Math.sin(a) * r, 0.02], [Math.cos(a + 0.06) * r, Math.sin(a + 0.06) * r, 0.02],
      [Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, -len]).color(color).mat(MAT.JELLY).tag(2));
  }
  // four frilled oral arms hanging from the middle (uv: across -1..1, down 0..1)
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const q = Geo.quad([-0.08 * dx, -0.08 * dy, 0.08], [0.08 * dx, 0.08 * dy, 0.08], [0.05 * dx + 0.03, 0.05 * dy, -0.95], [-0.05 * dx + 0.03, -0.05 * dy, -0.95]);
    const uvs = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    for (let i = 0; i < 4; i++) { q.uv[i * 2] = uvs[i][0]; q.uv[i * 2 + 1] = uvs[i][1]; }
    g.add(q.color('#f0b8e8').mat(MAT.JELLY).tag(3));
  }
  // see-through (the bell's opacity is set in `surface`)
  return g.emissive(0.4).blend(0.6);
}

function subGeo() {
  const g = Geo.lathe([[0.04, 0], [0.38, 0.3], [0.62, 0.9], [0.66, 1.8], [0.6, 2.6], [0.38, 3.05], [0, 3.22]], 8)
    .rotateX(-Math.PI / 2).translate(0, -1.6, 0).color('#f2c12e').gloss(0.6).mat(MAT.SUB);
  // (uv.y: along the hull in metres, for the portholes painted in `surface`)
  for (let i = 0; i < g.vertexCount; i++) g.uv[i * 2 + 1] = g.p[i * 3 + 1];
  // a three-bladed propeller behind the tail fins
  g.add(Geo.cylinder(0.07, 0.25, 6, { caps: false }).rotateX(Math.PI / 2).translate(0, -1.6, 0).color('#2b3440'));
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * TAU, c = Math.cos(a), sn = Math.sin(a);
    const P = (r, dy, t) => [c * r - sn * t, -1.75 + dy, sn * r + c * t];
    g.add(Geo.quad(P(0.05, 0.05, -0.06), P(0.42, 0.03, -0.09), P(0.42, -0.03, 0.09), P(0.05, -0.05, 0.06)).color('#c8a040').gloss(0.5).mat(MAT.THIN));
  }
  g.add(Geo.box(0.5, 0.95, 0.55).translate(0, 0.25, 0.75).color('#f2c12e').gloss(0.6));
  g.add(Geo.box(1.3, 0.3, 0.05).translate(0, -1.35, 0).color('#2b3440'));
  g.add(Geo.box(0.05, 0.3, 1.1).translate(0, -1.35, 0).color('#2b3440'));
  g.add(Geo.sphere(0.36, 6, 3).scale(1, 0.6, 1).translate(0, 1.5, 0.02).color('#ffd9a0').mat(MAT.LAMP).emissive(1.6));
  g.add(Geo.sphere(0.09, 4, 2).translate(0, 0.35, 1.1).color('#ff3b2a').mat(MAT.BEACON));
  g.add(Geo.cylinder(0.3, 9, 6, { r2: 2.2, caps: false }).rotateX(-Math.PI / 2).translate(0, 1.6, 0)
    .color('#fff1c8').emissive(0.6).mat(MAT.BEAM).additive());
  return g;
}

// ---------------------------------------------------------------------------

export default {
  id: 'reef',
  name: 'Coral Reef',
  blurb: 'Swim a sunlit reef channel past bubbling vents, fish lanes, mantas and a wreck. Every bubble rises at the same steady pace, so speed shows the past ahead and the future behind.',
  C: 4,
  mode: 'swim',
  modes: ['swim', 'fly'],
  spawn: { pos: [chanX(-46), -46, 7], t: 0, yaw: 0, pitch: -3 },
  period: P,
  viewDistance: 72,
  skyDistance: 70,
  exposure: 1.0,
  bloom: 0.45,
  shadowRadii: [15, 70],
  shadowDepth: 120,
  ground: (x, y) => H(x, y),
  ceiling: SURF,
  accel: 0.6,
  wgsl,

  // The music (see "Music" in docs/SCENES.md).
  // The Coral Reef: under water, so muffled.  Chords that drift, a rising
  // figure like light coming down, the vents puffing together every six
  // seconds with single bubbles in between, and something large far off.
  music: {
    seconds: 48, reverb: 3.5, tail: 6, echo: [0.5, 0.4], lowpass: 4200, seed: 53,
    build(m) {
      const { n, notes } = m;
      const water = m.track({ hall: 0.5 }), deep = m.track({ hall: 0.2 }), far = m.track({ hall: 0.9, echo: 0.3 });
      const harp = [m.track({ pan: -0.4, hall: 0.6, echo: 0.4 }), m.track({ pan: 0.4, hall: 0.6, echo: 0.4 })];
      const fizz = [-0.7, -0.2, 0.3, 0.8].map((pan) => m.track({ pan, hall: 0.5 }));
      [['F2', 'C3 A3 E4 G4'], ['G2', 'D3 B3 E4 A4'], ['E2', 'B2 G3 D4 F#4'], ['A2', 'E3 G3 C4 D4']].forEach(([root, tones], k) => {
        const t0 = k * 12, ch = notes(tones);
        m.pad(water, t0, 12, ch, { cutoff: 1000, gain: 0.08, a: 3, r: 3, detune: 8 });
        m.pad(deep, t0, 12, [n(root)], { type: 'sine', cutoff: 400, gain: 0.07, a: 2, r: 3, detune: 3 });
        for (let j = 0; j < 4; j++) {
          [ch[0], ch[1], ch[2], ch[3], ch[1] + 12, ch[2] + 12].forEach((p, i) => m.pluck(harp[(k + j) % 2], t0 + j * 3 + i * 0.25, p + 12, { type: 'triangle', gain: 0.15 - i * 0.012, decay: 1.4, bright: 2500, dark: 800 }));
        }
      });
      for (let k = 0; k < 8; k++) {
        const many = 6 + Math.floor(m.rand() * 4);
        for (let i = 0; i < many; i++) m.bubble(fizz[Math.floor(m.rand() * 4)], k * 6 + 1.5 + m.rand() * 1.1, 500 + 900 * m.rand(), 0.35 + 0.4 * m.rand());
      }
      for (let i = 0; i < 40; i++) m.bubble(fizz[i % 4], m.rand() * 48, 700 + 1400 * m.rand(), 0.18 + 0.2 * m.rand());
      for (const [t, low, high] of [[8, 'A3', 'E4'], [31, 'G3', 'D4']]) {
        m.tone(far, t, 2.2, n(high), { from: n(low), glide: 1.6, gain: 0.07, a: 0.8, d: 1, s: 0.8, r: 1.5 });
        m.tone(far, t + 2.8, 2.4, n(low) - 2, { from: n(high), glide: 2, gain: 0.06, a: 0.8, d: 1, s: 0.8, r: 1.8 });
      }
    },
  },

  build(b) {
    const rand = rng(11);
    const wreck = { x: chanX(88) + 2, y: 88 };
    const taken = []; // discs already occupied: [x, y, r]
    const free = (x, y, r) => taken.every(([a, c, q]) => Math.hypot(x - a, y - c) > r + q);
    // the corals, sponges and rocks, gathered by prototype (see garden())
    const life = garden(b);
    const place = (copy, x, y, { r = 0.5, sink = 0.1, rot = rand() * TAU, scale = 1, keep = true } = {}) => {
      const z = floorUnder(x, y, r * scale) - sink * scale;
      life.plant(copy, m4.mul(m4.translation(x, y, z), m4.rotationZ(rot), m4.scaling(scale)));
      if (keep) taken.push([x, y, r * scale]);
    };

    // ---- the sea floor ------------------------------------------------------
    {
      const sandA = [], wallA = [];
      const g = Geo.heightfield(X0, Y0, X1, Y1, FLOOR_NX, FLOOR_NY, H, (x, y) => {
        const { reef, wall } = terrain(x, y);
        const sand = (1 - reef) * (1 - wall);
        sandA.push(sand); wallA.push(wall);
        const v = noise2(x * 0.15 + 3, y * 0.15);
        const sandC = mixC([0.9, 0.86, 0.75], [0.8, 0.75, 0.63], v);
        const reefC = mixC([0.52, 0.46, 0.42], [0.42, 0.44, 0.4], noise2(x * 0.2, y * 0.2 + 5));
        const wallC = mixC([0.38, 0.40, 0.44], [0.45, 0.38, 0.44], v);
        return mixC(mixC(sandC, reefC, 1 - sand), wallC, wall);
      });
      for (let i = 0; i < sandA.length; i++) { g.uv[i * 2] = sandA[i]; g.uv[i * 2 + 1] = wallA[i]; }
      b.static(g.mat(MAT.TERRAIN));
    }

    // ---- the arch over the channel ------------------------------------------
    const archY = -14;
    {
      const cx = chanX(archY);
      const pts = [];
      for (let i = 0; i <= 16; i++) {
        const a = Math.PI * i / 16;
        const x = cx - Math.cos(a) * 15.5, z = 2.5 + Math.sin(a) * 10.5;
        pts.push([x, archY + Math.sin(a * 2) * 1.2, z]);
      }
      pts[0][2] = H(pts[0][0], pts[0][1]) - 1.5;
      pts[16][2] = H(pts[16][0], pts[16][1]) - 1.5;
      const g = Geo.tube(pts, (u) => 2.0 + 1.8 * Math.pow(Math.abs(u - 0.5) * 2, 2.5), 10, { caps: false });
      for (let i = 0; i < g.p.length; i += 3) {
        const q = [g.p[i] * 0.4, g.p[i + 1] * 0.4, g.p[i + 2] * 0.4];
        const k = (noise3(q[0], q[1], q[2]) - 0.5) * 2.6 + (noise3(q[0] * 2.7, q[1] * 2.7, q[2] * 2.7) - 0.5) * 0.9;
        g.p[i] += g.n[i] * k; g.p[i + 1] += g.n[i + 1] * k; g.p[i + 2] += g.n[i + 2] * k;
      }
      b.static(g.computeNormals(false).color('#8a8178').mat(MAT.ROCK));
      // growth on top of the arch, set on the highest rock under each spot
      const topAt = (x, y) => {
        let z = -Infinity;
        for (let i = 0; i < g.p.length; i += 3) {
          if (Math.hypot(g.p[i] - x, g.p[i + 1] - y) < 0.8) z = Math.max(z, g.p[i + 2]);
        }
        return z;
      };
      for (let i = 1; i <= 15; i += 1) {
        for (let j = 0; j < 2; j++) {
          const x = pts[i][0] + rand.range(-0.8, 0.8), y = pts[i][1] + rand.range(-1.0, 1.0);
          const top = topAt(x, y);
          if (!isFinite(top)) continue;
          const kind = (i + j) % 4;
          const copy = kind === 0 ? tubes(rand, rand.pick([PAL.purple, PAL.yellow, PAL.orange]))
            : kind === 1 ? softCoral(rand, rand.pick([PAL.pink, PAL.violet, PAL.cream]))
              : kind === 2 ? fan(rand, rand.range(0.8, 1.3), rand.pick([PAL.red, PAL.orange, PAL.purple]))
                : branch(rand, 1.3, rand.pick([PAL.magenta, PAL.blue, PAL.tan]), PAL.cream);
          life.plant(copy, m4.mul(m4.translation(x, y, top - 0.25), m4.rotationZ(rand() * TAU), m4.scaling(1.3)));
        }
      }
      // keep the channel under the arch clear
      taken.push([cx - 15.5, archY, 3], [cx + 15.5, archY, 3]);
    }

    // ---- coral clusters on the reef ------------------------------------------
    const corals = [PAL.pink, PAL.coral, PAL.orange, PAL.yellow, PAL.lime, PAL.teal, PAL.blue, PAL.purple, PAL.violet, PAL.magenta, PAL.red];
    // corals are drawn a size up from life, so that they read against the big ridges
    const centrepiece = (x, y) => {
      const k = rand();
      if (k < 0.22) place(brain(rand.range(0.7, 1.3), rand.pick([PAL.tan, PAL.lime, PAL.yellow, '#b9a36a'])), x, y, { r: 1.1, sink: 0.12, scale: 1.35 });
      else if (k < 0.42) place(table(rand.range(1.0, 1.8), rand.pick(['#9ab8a6', PAL.tan, '#c49bd0', '#8fc0c8'])), x, y, { r: 0.3, sink: 0.05, scale: 1.25 });
      else if (k < 0.62) place(branch(rand, rand.range(1.4, 2.4), rand.pick(corals), rand.pick([PAL.cream, PAL.yellow, '#c6f0ff'])), x, y, { r: 1.0, sink: 0.1, scale: 1.4 });
      else if (k < 0.75) place(barrel(rand.range(0.45, 0.8), rand.range(0.9, 1.6), rand.pick(['#a5533b', '#9c4a6a', '#b0703a'])), x, y, { r: 0.7, sink: 0.1, scale: 1.35 });
      else if (k < 0.87) place(rock(rand, rand.range(1.0, 1.8), rand.range(0.8, 1.5)), x, y, { r: 1.2, sink: 0.4 });
      else place(pillar(rand, rand.pick([PAL.cream, PAL.tan, '#d6c38f'])), x, y, { r: 0.5, sink: 0.05, scale: 1.4 });
    };
    const small = (x, y) => {
      const k = rand();
      if (k < 0.22) place(fan(rand, rand.range(0.6, 1.3), rand.pick([PAL.purple, PAL.red, PAL.orange, PAL.yellow, PAL.magenta])), x, y, { r: 0.25, sink: 0.05, scale: 1.3 });
      else if (k < 0.4) place(tubes(rand, rand.pick([PAL.purple, PAL.yellow, PAL.blue, PAL.orange, PAL.red])), x, y, { r: 0.35, sink: 0.05, scale: 1.3 });
      else if (k < 0.58) place(softCoral(rand, rand.pick([PAL.pink, PAL.violet, PAL.cream, PAL.coral])), x, y, { r: 0.35, sink: 0.05, scale: 1.3 });
      else if (k < 0.7) place(anemone(rand, rand.range(0.25, 0.4), rand.pick(['#f0a6c9', '#a6e8b0', '#f5d08a']), rand.pick([PAL.magenta, PAL.red, PAL.purple])), x, y, { r: 0.35, sink: 0.05, scale: 1.3 });
      else if (k < 0.85) place(branch(rand, rand.range(0.6, 1.1), rand.pick(corals), rand.pick([PAL.cream, PAL.yellow])), x, y, { r: 0.5, sink: 0.05, scale: 1.3 });
      else place(brain(rand.range(0.3, 0.55), rand.pick([PAL.tan, PAL.lime, PAL.yellow, PAL.green])), x, y, { r: 0.45, sink: 0.08, scale: 1.3 });
    };
    // a few large pieces on the slopes just ahead of the spawn point
    {
      const at = (u, y) => [chanX(y) + u, y];
      place(fan(rand, 1.9, PAL.purple), ...at(-9.5, -33), { r: 0.4, rot: 0.15 });
      place(branch(rand, 2.6, PAL.magenta, PAL.cream), ...at(-12, -27), { r: 1.3, scale: 1.3 });
      place(branch(rand, 1.8, PAL.violet, PAL.cream), ...at(-8.2, -36.5), { r: 0.8, scale: 1.3 });
      place(barrel(0.7, 1.4, '#b0603a'), ...at(-13, -33), { r: 0.8, scale: 1.2 });
      place(softCoral(rand, PAL.violet), ...at(-11.5, -30.5), { r: 0.4, scale: 1.6 });
      place(tubes(rand, PAL.purple), ...at(-8.8, -30), { r: 0.4, scale: 1.5 });
      place(anemone(rand, 0.4, '#a6e8b0', PAL.purple), ...at(-7.2, -31.5), { r: 0.45, scale: 1.3 });
      place(softCoral(rand, PAL.pink), ...at(-7.4, -34.2), { r: 0.4, scale: 1.6 });
      place(tubes(rand, PAL.yellow), ...at(-10.2, -35.5), { r: 0.4, scale: 1.5 });
      place(fan(rand, 1.4, PAL.red), ...at(-7.8, -39), { r: 0.4, rot: -0.3 });
      place(brain(0.9, PAL.lime), ...at(-11, -38.5), { r: 1.0, scale: 1.3 });
      place(table(1.8, '#8fc0c8'), ...at(10.5, -30), { r: 0.3, scale: 1.3 });
      place(fan(rand, 1.6, PAL.orange), ...at(8.2, -37), { r: 0.4, rot: -0.2 });
      place(branch(rand, 2.2, PAL.blue, '#c6f0ff'), ...at(9.5, -41), { r: 1.1, scale: 1.3 });
      place(brain(1.1, PAL.tan), ...at(12, -36), { r: 1.2, scale: 1.3 });
      place(anemone(rand, 0.45, '#f0a6c9', PAL.magenta), ...at(7.6, -33.5), { r: 0.5, scale: 1.3 });
    }
    for (let tries = 0, n = 0; tries < 9000 && n < 240; tries++) {
      const x = rand.range(-75, 62), y = rand.range(-60, 62);
      const tr = terrain(x, y);
      if (tr.reef < 0.25 || tr.wall > 0.08) continue;
      // dense along the channel, where they are seen, sparser further away
      if (Math.abs(x - chanX(y)) > 24 && rand() > 0.35) continue;
      if (!free(x, y, 4.0)) continue;
      n++;
      centrepiece(x, y);
      const m = rand.int(4, 7);
      for (let i = 0; i < m; i++) {
        const a = rand() * TAU, d = rand.range(1.7, 4.2);
        const sx = x + Math.cos(a) * d, sy = y + Math.sin(a) * d;
        if (terrain(sx, sy).wall > 0.1 || !free(sx, sy, 0.3)) continue;
        small(sx, sy);
      }
    }
    // loose rocks and coral heads on the reef flat and sand
    for (let i = 0; i < 70; i++) {
      const x = rand.range(-92, 60), y = rand.range(-104, 112);
      const tr = terrain(x, y);
      if (tr.wall > 0.05 || !free(x, y, 2.5)) continue;
      if (Math.abs(x - chanX(y)) < 5 && y > -60 && y < 70) continue;
      place(rock(rand, rand.range(0.6, 1.6), rand.range(0.4, 1.1)), x, y, { r: 1.1, sink: 0.35 });
      if (rand() < 0.6) small(x + rand.range(-1.5, 1.5), y + rand.range(-1.5, 1.5));
    }

    // ---- life on the wall: sea fans, sponges and whips growing out of it -----
    for (let i = 0, n = 0; i < 900 && n < 260; i++) {
      const y = rand.range(-80, 100);
      const x = dropX(y) + rand.range(-1, 13);
      const tr = terrain(x, y);
      if (tr.wall < 0.08 || tr.wall > 0.97) continue;
      n++;
      const z = H(x, y), e = 0.3;
      // the outward (downhill) direction of the wall here
      const gx = (H(x + e, y) - H(x - e, y)) / (2 * e), gy = (H(x, y + e) - H(x, y - e)) / (2 * e);
      const out = v3.norm([-gx, -gy, 0]);
      const k = rand();
      let copy, up;
      if (k < 0.45) {
        copy = fan(rand, rand.range(0.9, 2.0), rand.pick([PAL.purple, PAL.red, PAL.orange, PAL.yellow, PAL.magenta, PAL.violet]));
        up = v3.norm([out[0] * 0.5, out[1] * 0.5, 1]);
      } else if (k < 0.7) {
        copy = barrel(rand.range(0.4, 0.75), rand.range(0.8, 1.4), rand.pick(['#a5533b', '#9c4a6a', '#b0703a', '#c08040']));
        up = v3.norm([out[0] * 0.8, out[1] * 0.8, 1]);
      } else if (k < 0.88) {
        copy = tubes(rand, rand.pick([PAL.purple, PAL.yellow, PAL.orange, PAL.blue]));
        up = v3.norm([out[0] * 1.2, out[1] * 1.2, 1]);
      } else {
        copy = softCoral(rand, rand.pick([PAL.pink, PAL.violet, PAL.coral]));
        up = v3.norm([out[0] * 1.0, out[1] * 1.0, 1]);
      }
      // stand it on the wall leaning out over the deep; fans turn their face to the open water
      const side = v3.norm(v3.cross(up, out));
      const fwd = v3.cross(up, side);
      const base = v3.sub([x, y, z], v3.scale(out, 0.25));
      life.plant(copy, m4.mul(m4.fromBasis(side, fwd, up, base), m4.scaling(1.3)));
    }

    // ---- bommies in the channel ---------------------------------------------
    const bommies = [[3.2, -31], [-3.5, -4], [3.8, 22], [-3.2, 44]];
    for (const [u, y] of bommies) {
      const x = chanX(y) + u;
      place(rock(rand, 1.8, 1.6), x, y, { r: 1.8, sink: 0.5 });
      const top = H(x, y) + 1.4;
      life.plant(brain(0.9, rand.pick([PAL.tan, PAL.lime])), m4.translation(x + 0.3, y - 0.2, top));
      life.plant(branch(rand, 1.4, rand.pick([PAL.purple, PAL.blue, PAL.magenta]), PAL.cream), m4.translation(x - 0.8, y + 0.5, top - 0.3));
      life.plant(fan(rand, 1.1, rand.pick([PAL.red, PAL.orange])), m4.mul(m4.translation(x + 0.9, y + 0.8, top - 0.5), m4.rotationZ(rand() * TAU)));
      life.plant(anemone(rand, 0.35, '#f0a6c9', PAL.magenta), m4.translation(x - 1.1, y - 0.9, top - 0.6));
    }

    // ---- lantern anemones along the foot of both channel walls ---------------
    for (let y = -40; y <= 50; y += 6) {
      for (const side of [-1, 1]) {
        const x = chanX(y) + side * 6.5;
        if (!free(x, y, 0.4)) continue;
        place(anemone(rand, 0.55, side < 0 ? '#7df4ff' : '#ff9be6', '#5a4a5a', true), x, y, { r: 0.45, sink: 0.08 });
      }
    }

    // ---- sand life: starfish, urchins, seagrass -------------------------------
    for (let i = 0; i < 70; i++) {
      const x = rand.range(-60, 50), y = rand.range(-100, 100);
      const tr = terrain(x, y);
      if (tr.reef > 0.3 || tr.wall > 0.02) continue;
      if (rand() < 0.5) place(starfish(rand.pick(['#e0533c', '#f08a2c', '#3f6fd0', '#d84a8a'])), x, y, { r: 0.2, sink: 0.01 });
      else place(urchin(rand), x, y, { r: 0.2, sink: 0.04 });
    }
    // seagrass meadows on the open sand south of the reef and around the wreck
    {
      const grass = new Geo();
      const meadow = (cx, cy, cr, n) => {
        if (terrain(cx, cy).wall > 0.01) return;
        for (let i = 0; i < n; i++) {
          const a = rand() * TAU, d = Math.sqrt(rand()) * cr;
          const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
          if (terrain(x, y).reef > 0.3 || !free(x, y, 0.05)) continue;
          const z = H(x, y) - 0.05, h = rand.range(0.4, 1.0) * (1 - 0.5 * d / cr), o = rand() * TAU, w = 0.05;
          const lean = [rand.range(-0.2, 0.2), rand.range(-0.2, 0.2)];
          grass.add(Geo.triangle([x - Math.cos(o) * w, y - Math.sin(o) * w, z], [x + Math.cos(o) * w, y + Math.sin(o) * w, z],
            [x + lean[0] * h, y + lean[1] * h, z + h]));
        }
      };
      for (let c = 0; c < 26; c++) meadow(rand.range(-45, 35), rand.range(-104, -58), rand.range(3, 7), rand.int(140, 260));
      for (let c = 0; c < 10; c++) meadow(rand.range(-35, 35), rand.range(70, 112), rand.range(2.5, 5), rand.int(90, 160));
      b.static(grass.color('#86b34c').mat(MAT.KELP));
    }
    // coral heads scattered over the open sand
    for (let i = 0, n = 0; i < 400 && n < 26; i++) {
      const y = rand() < 0.55 ? rand.range(-104, -58) : rand.range(62, 112), x = rand.range(-45, 40);
      const tr = terrain(x, y);
      if (tr.wall > 0.01 || tr.reef > 0.2 || !free(x, y, 5)) continue;
      if (Math.abs(x - wreck.x) < 16 && Math.abs(y - wreck.y) < 16) continue;
      n++;
      place(rock(rand, rand.range(1.0, 1.7), rand.range(0.7, 1.2)), x, y, { r: 1.3, sink: 0.4 });
      for (let k = 0; k < 3; k++) small(x + rand.range(-1.4, 1.4), y + rand.range(-1.4, 1.4));
    }

    // ---- the wreck on the sand plain north of the channel ---------------------
    {
      const g = new Geo();
      const L = 24, N = 10;
      const secs = [];
      for (let k = 0; k <= N; k++) {
        const f = k / N, y = (f - 0.5) * L;
        const w = f < 0.35 ? 2.5 + 0.7 * Math.sin(f / 0.35 * Math.PI / 2) : 3.2 * (1 - Math.pow((f - 0.35) / 0.65, 2));
        const s = 4 + 0.9 * f * f, kz = 0.3 * f * f * f;
        const half = [[w, s], [w * 0.98, s * 0.55], [w * 0.85, s * 0.2], [w * 0.5, 0.04 * s + kz], [0, kz]];
        const sec = [];
        for (let i = 0; i < half.length; i++) sec.push([half[i][0], y, half[i][1]]);
        for (let i = half.length - 2; i >= 0; i--) sec.push([-half[i][0], y, half[i][1]]);
        secs.push(sec);
      }
      for (let k = 0; k < N; k++) {
        for (let i = 0; i < secs[k].length - 1; i++) {
          const a = secs[k][i], bb = secs[k][i + 1], c = secs[k + 1][i + 1], d = secs[k + 1][i];
          const ctr = [0, (a[1] + c[1]) / 2, 2.6];
          triAway(g, a, bb, c, ctr); triAway(g, a, c, d, ctr);
        }
      }
      // transom
      for (let i = 0; i < secs[0].length - 1; i++) triAway(g, [0, -L / 2, 2.2], secs[0][i], secs[0][i + 1], [0, 0, 2.2]);
      // the plating is rusted through in places (see `cutout`): aux says where
      // it may be, from nothing at the gunwale and down at the sand to most
      // half way up the side
      g.aux((p) => { const s = 4 + 0.9 * Math.pow(p[1] / L + 0.5, 2); return clamp(1 - Math.abs(p[2] - 0.55 * s) / (0.35 * s)); });
      // (uv: along and up the hull, for its riveted plates)
      for (let i = 0; i < g.vertexCount; i++) { g.uv[i * 2] = g.p[i * 3 + 1]; g.uv[i * 2 + 1] = g.p[i * 3 + 2]; }
      g.color('#9a6c52').mat(MAT.HULL).cutout();
      // broken deck planking, a deck house and a snapped mast
      for (let k = 0; k < 9; k++) {
        if (k === 4 || k === 5) continue;
        const y = -9 + k * 2.1;
        const f = y / L + 0.5;
        const w = f < 0.35 ? 2.5 + 0.7 * Math.sin(f / 0.35 * Math.PI / 2) : 3.2 * (1 - Math.pow((f - 0.35) / 0.65, 2));
        g.add(Geo.box(w * 1.9, 1.7, 0.15).translate(0, y, 3.9 + 0.9 * f * f - 0.3).color('#8a7458').mat(MAT.RUST));
      }
      g.add(Geo.box(3.6, 4.2, 2.4).translate(0, -7.5, 5.0).color('#a07656').mat(MAT.RUST));
      for (let i = 0; i < 3; i++) g.add(Geo.box(0.6, 0.1, 0.5).translate(-1.0 + i, -9.62, 5.4).color('#0a0c10'));
      g.add(Geo.cylinder(0.25, 7, 8, { r2: 0.2 }).rotateX(0.25).translate(0, 3, 3.8).color('#7d6450').mat(MAT.RUST));
      g.add(Geo.cylinder(0.2, 6, 8).rotateY(Math.PI / 2).translate(3.5, 1.5, 0.1).color('#7d6450').mat(MAT.RUST));
      const pose = m4.mul(m4.translation(wreck.x, wreck.y, H(wreck.x, wreck.y) - 1.3), m4.rotationZ(0.6), m4.rotationY(0.24), m4.rotationX(0.04));
      b.static(g, { transform: pose });
      wreck.pose = pose;
      taken.push([wreck.x, wreck.y, 12]);
      // its fittings, drawn only from near by: rails, portholes, hatches,
      // propeller and rudder, cargo in the hold; and on the sand the anchor
      // with its chain and cargo that spilled
      b.static(wreckFittings(L), { transform: pose, within: 40, solid: false });
      b.static(wreckSurroundings(pose, L), { within: 40, solid: false });
      // life on and around the wreck
      for (let i = 0; i < 14; i++) {
        const local = [rand.range(-2.5, 2.5), rand.range(-10, 9), 4.1];
        const wp = m4.point(pose, local);
        const copy = i % 3 === 0 ? fan(rand, rand.range(0.7, 1.2), rand.pick([PAL.orange, PAL.red, PAL.purple]))
          : i % 3 === 1 ? tubes(rand, rand.pick([PAL.yellow, PAL.purple])) : softCoral(rand, rand.pick([PAL.pink, PAL.cream]));
        life.plant(copy, m4.mul(m4.translation(wp[0], wp[1], wp[2] - 0.2), m4.rotationZ(rand() * TAU)));
      }
      for (let i = 0; i < 6; i++) {
        const a = rand() * TAU, d = rand.range(9, 16);
        place(rock(rand, rand.range(0.5, 1.0), 0.4), wreck.x + Math.cos(a) * d, wreck.y + Math.sin(a) * d, { r: 0.8, sink: 0.25, keep: false });
      }
    }

    // ---- sun shafts ----------------------------------------------------------
    {
      const shafts = [[-2, -30, 1.6], [7, -20, 2.4], [-9, -8, 1.8], [4, 6, 2.6], [-6, 20, 2.0], [12, -42, 1.5], [-20, -25, 2.2],
        [22, 0, 2.0], [-30, 10, 2.4], [2, 40, 2.2], [-14, 55, 1.8], [30, -50, 2.0], [-40, -45, 2.4], [10, 75, 2.6]];
      for (const [u, y, r] of shafts) {
        const x = chanX(y) + u;
        const top = [x, y, SURF + 0.5];
        const len = (SURF + 0.5 - H(x, y) + 2) / SUN[2];
        const bottom = v3.sub(top, v3.scale(SUN, len));
        const g = Geo.cylinder(r * 1.3, len, 7, { r2: r * 0.8, caps: false }).color('#bfeeff').emissive(0.09).mat(MAT.SHAFT).additive();
        b.static(g, { transform: alongDir(bottom, SUN) });
      }
    }

    // ---- bubbles: rising at a constant speed, two keys each ------------------
    // small stream bubbles can be coarse; the big ones from the vents need rounder outlines
    // (the same triangles as Geo.sphere's, without the seam and the poles'
    // repeated vertices, which every bubble would store at both of its keys)
    const bubbleSmall = seamlessSphere(6, 4).color('#cdeeff').mat(MAT.BUBBLE).emissive(1).additive();
    const bubbleBig = seamlessSphere(9, 5).color('#cdeeff').mat(MAT.BUBBLE).emissive(1).additive();
    const RISE = 0.9;
    const emitBubble = (x, y, z0, te, r, spread) => {
      const z1 = SURF - 0.15;
      const T = (z1 - z0) / RISE;
      const ex = x + rand.range(-spread, spread), ey = y + rand.range(-spread, spread);
      b.dynamic(r > 0.085 ? bubbleBig : bubbleSmall, {
        times: [te, te + T],
        transform: (t) => {
          const f = (t - te) / T;
          const s = r * (0.75 + 0.5 * f);
          return m4.mul(m4.translation(x + (ex - x) * f, y + (ey - y) * f, z0 + (z1 - z0) * f), m4.scaling(s, s, s * 0.85));
        },
        caps: 'none',
      });
    };
    // puffing vents down the middle of the channel: all puff together every 4 s
    // Each is a low crater crusted pale round its dark throat (see MAT.VENT).
    const crater = Geo.lathe([[0.85, -0.12], [0.6, 0.08], [0.32, 0.2], [0.2, 0.15], [0.13, -0.25]], 10).color('#8a8070').mat(MAT.VENT);
    const craters = new Geo();
    for (let y = -36; y <= 56; y += 10) {
      const x = chanX(y);
      const z0 = H(x, y) + 0.1;
      craters.add(crater, m4.mul(m4.translation(x, y, floorMesh(x, y)), m4.rotationZ(y)));
      // a ring of stones around the vent
      for (let k = 0; k < 4; k++) {
        const a = k / 4 * TAU + rand() * 0.6, d = rand.range(0.45, 0.6);
        life.plant(rock(rand, rand.range(0.25, 0.4), rand.range(0.2, 0.32)), m4.translation(x + Math.cos(a) * d, y + Math.sin(a) * d, z0 - 0.15));
      }
      for (let k = 0; k < P / 4; k++) {
        for (let j = 0; j < 5; j++) emitBubble(x, y, z0 + 0.2, k * 4 + j * 0.14, rand.range(0.09, 0.15), 0.35);
      }
    }
    b.static(craters, { solid: false });
    // steady streams from cracks in the reef and on the sand
    const streams = [];
    for (let tries = 0; tries < 400 && streams.length < 14; tries++) {
      const x = rand.range(-50, 50), y = rand.range(-55, 70);
      const tr = terrain(x, y);
      if (tr.wall > 0.05) continue;
      if (Math.abs(x - chanX(y)) < 5) continue;
      if (streams.some(([a, c]) => Math.hypot(a - x, c - y) < 9)) continue;
      streams.push([x, y]);
    }
    streams.push([chanX(-52) + 2, -52], [chanX(-40) - 7, -36]);
    for (const [x, y] of streams) {
      const z0 = H(x, y) + 0.05;
      const step = rand.pick([0.4, 0.5, 0.6]);
      const ph = rand() * step;
      for (let te = ph; te < P; te += step) emitBubble(x, y, z0, te, rand.range(0.05, 0.09), 0.25);
    }
    // air escaping from the wreck in big, slow gulps
    {
      const wp = [wreck.x - 1.2, wreck.y + 3];
      const z0 = H(wp[0], wp[1]) + 3.2;
      for (let k = 0; k < P / 3; k++) {
        for (let j = 0; j < 3; j++) emitBubble(wp[0], wp[1], z0, k * 3 + j * 0.3, rand.range(0.16, 0.26), 0.5);
      }
    }

    // ---- garden eels: they duck into the sand in a wave that runs up the channel
    {
      // (painted in `surface`: dark spots down the body, eyes on the head)
      const eel = Geo.tube([[0, 0, -0.85], [0, 0, 0.1], [0.04, 0, 0.45], [0.12, 0, 0.6]], 0.035, 4, { caps: false }).color('#efe6cc').mat(MAT.EEL).tag(1);
      eel.add(Geo.sphere(0.04, 4, 2).translate(0.12, 0, 0.6).color('#efe6cc').mat(MAT.EEL).tag(2));
      for (let i = 0; i < 46; i++) {
        const y = rand.range(-44, -20), x = chanX(y) + rand.range(-4.5, 4.5);
        if (Math.abs(x - chanX(y)) < 0.8) continue;
        const z = H(x, y) - 0.05, rot = rand() * TAU;
        // the eels nearest the spawn point duck first, at t = 2 s, and the wave runs north at 4 m/s
        const phase = 7 + (y + 44) / 4 + rand.range(-0.15, 0.15);
        // a 12 s cycle: out 7 s, duck 0.5 s, hidden 2.5 s, rise 2 s
        const kinks = [[0, 0], [7, 0], [7.5, -0.95], [10, -0.95], [12, 0]];
        const hAt = (t) => {
          const u = ((t - phase) % 12 + 12) % 12;
          for (let k = 1; k < kinks.length; k++) {
            if (u <= kinks[k][0]) {
              const [t0, h0] = kinks[k - 1], [t1, h1] = kinks[k];
              return h0 + (h1 - h0) * (u - t0) / (t1 - t0);
            }
          }
          return 0;
        };
        const times = new Set([0, P]);
        for (let c = -2; c < 7; c++) for (const [kt] of kinks) { const tt = phase + c * 12 + kt; if (tt > 0 && tt < P) times.add(+tt.toFixed(6)); }
        const tl = [...times].sort((a, c) => a - c);
        b.dynamic(eel, { times: tl, transform: (t) => m4.mul(m4.translation(x, y, z + hAt(t)), m4.rotationZ(rot)), caps: 'none' });
      }
    }

    // ---- kelp swaying in the current on the west reef flat -----------------
    {
      const patches = [[-44, -22, 11, 30], [-42, 24, 9, 22], [-30, -50, 6, 12]];
      for (const [u, y0, rad, count] of patches) {
        const strands = [];
        for (let i = 0; i < count; i++) {
          const a = rand() * TAU, d = Math.sqrt(rand()) * rad;
          const y = y0 + Math.sin(a) * d, x = chanX(y0) + u + Math.cos(a) * d;
          strands.push({ x, y, z: H(x, y) - 0.1, h: rand.range(5, 11) * (1 - 0.4 * d / rad), w: rand.range(0.5, 0.8), o: rand() * TAU, ph: x * 0.12 + rand() * 0.4 });
          place(rock(rand, 0.35, 0.25), x, y, { r: 0.3, sink: 0.1 });
        }
        const segs = 5;
        const geoAt = (t) => {
          const g = new Geo();
          for (const s of strands) {
            // two crossed fronds per stalk, so that it never looks edge-on
            for (const o of [s.o, s.o + Math.PI / 2]) {
              const cw = Math.cos(o), sw = Math.sin(o);
              const base = g.vertexCount;
              for (let k = 0; k <= segs; k++) {
                const f = k / segs, a = TAU * t / 7.5 - s.ph - f * 0.6;
                const sway = 1.3 * Math.pow(f, 1.4) * (s.h / 8);
                const ox = sway * Math.sin(a), oy = sway * 0.35 * Math.cos(a);
                const w = s.w * (0.25 + 0.9 * Math.sin(Math.PI * Math.min(1, f * 0.85 + 0.12)));
                const px = s.x + ox, py = s.y + oy, pz = s.z + f * s.h;
                g.vert(px - cw * w / 2, py - sw * w / 2, pz, -sw, cw, 0.2, 0, f);
                g.vert(px + cw * w / 2, py + sw * w / 2, pz, -sw, cw, 0.2, 1, f);
              }
              for (let k = 0; k < segs; k++) g.quadIdx(base + k * 2, base + k * 2 + 1, base + k * 2 + 3, base + k * 2 + 2);
            }
          }
          g.color('#b0a046');
          // a stipe with blades along it, cut out of each frond (see `cutout`)
          return g.mat(MAT.FROND).cutout();
        };
        b.dynamic(geoAt, { times: timeRange(0, P, 7.5 / 8), caps: 'none' });
      }
    }
    // more growth on the wreck: sponges, soft corals, fans and tube sponges on
    // its sides (planted last, with random numbers of their own, so that the
    // copies above keep their shapes)
    {
      const gr = rng(919);
      for (let i = 0; i < 16; i++) {
        const side = i % 2 ? 1 : -1, y = gr.range(-9, 9), f = y / 24 + 0.5, w = hullW(f), sh = hullS(f);
        const z = gr.range(0.3, 0.9) * sh;
        const x = side * (z > 0.55 * sh ? w * (0.98 + 0.02 * (z - 0.55 * sh) / (0.45 * sh)) : w * (0.85 + 0.13 * (z - 0.2 * sh) / (0.35 * sh)));
        const base = m4.point(wreck.pose, [x - side * 0.05, y, z]);
        if (base[2] < H(base[0], base[1]) + 0.3) continue;
        const out = v3.norm(m4.dir(wreck.pose, [side, 0, 0])), up = v3.norm(v3.add(out, [0, 0, 0.9]));
        const sideV = v3.norm(v3.cross(up, out)), fwd = v3.cross(up, sideV);
        const k = gr();
        const copy = k < 0.3 ? barrel(gr.range(0.3, 0.5), gr.range(0.5, 0.9), gr.pick(['#a5533b', '#c08040', '#9c4a6a']))
          : k < 0.55 ? softCoral(gr, gr.pick([PAL.pink, PAL.cream, PAL.violet]))
            : k < 0.8 ? tubes(gr, gr.pick([PAL.yellow, PAL.purple, PAL.orange])) : fan(gr, gr.range(0.6, 1.0), gr.pick([PAL.red, PAL.orange, PAL.purple]));
        life.plant(copy, m4.mul(m4.fromBasis(sideV, fwd, up, base), m4.scaling(gr.range(0.8, 1.1))));
      }
    }

    // (every coral, sponge and rock has been placed by now)
    life.grow();

    // ---- sea-bed detail along the channel: shells, starfish, sea cucumbers,
    // pebbles, crabs and feather-duster worms, drawn only from near by (they
    // are lost in the haze further off).  They are merged into strips across
    // the channel, 8 m long, one static piece each: the few strips in reach
    // lie next to each other in the index buffer and are drawn together.
    {
      const kit = bitsKit();
      const rnd = rng(4242); // (its own random numbers, so that nothing else moves)
      const shellCols = ['#e8d6b8', '#d9b48a', '#f0e6d8', '#c99a70', '#e0c0c8'];
      const starCols = ['#e0533c', '#f08a2c', '#3f6fd0', '#d84a8a', '#e8b030'];
      const crumbCols = ['#a49a8c', '#8c8478', '#c8c0b0', '#b0a090', '#9a8c94', '#d8c8c0'];
      const wormCols = ['#ff5a3c', '#f2f2f2', '#ffcf3a', '#c060ff', '#40d0c0'];
      // a copy of a kit mesh with its white parts in a colour
      const tinted = (geo, col) => {
        const g = geo.clone(), c = hex(col);
        for (let i = 0; i < g.c.length; i += 3) if (g.c[i] + g.c[i + 1] + g.c[i + 2] > 2.99) { g.c[i] = c[0]; g.c[i + 1] = c[1]; g.c[i + 2] = c[2]; }
        return g;
      };
      // (strips down the channel, and then a few on the sand round the wreck, sparser)
      for (let y0 = -64; y0 < 112; y0 += 8) {
        const strip = new Geo();
        const nearWreck = y0 >= 64;
        for (let n = 0; n < (nearWreck ? 45 : 75); n++) {
          // (thicker down the middle of the channel)
          const y = y0 + rnd() * 8, x = nearWreck ? wreck.x + rnd.range(-22, 22) : chanX(y) + rnd.range(-13, 13) * (0.35 + 0.65 * rnd());
          const tr = terrain(x, y);
          const kind = rnd();
          if (tr.wall > 0.05 || !free(x, y, 0.25)) continue;
          const z = floorMesh(x, y), e = 0.2;
          const nrm = v3.norm([floorMesh(x - e, y) - floorMesh(x + e, y), floorMesh(x, y - e) - floorMesh(x, y + e), 2 * e]);
          const lying = (sink, size) => m4.mul(alongDir([x, y, z - sink], nrm), m4.rotationZ(rnd() * TAU), m4.scaling(size));
          const sand = tr.reef < 0.3;
          if (sand ? kind < 0.22 : kind < 0.12) strip.add(tinted(kit.cone, rnd.pick(shellCols)), lying(0.015, rnd.range(1.2, 2.0)));
          else if (sand ? kind < 0.38 : kind < 0.18) strip.add(tinted(kit.clam, rnd.pick(shellCols)), lying(0.006, rnd.range(1.2, 2.0)));
          else if (sand ? kind < 0.5 : kind < 0.3) strip.add(tinted(kit.star, rnd.pick(starCols)), lying(0.005, rnd.range(1.0, 1.6)));
          else if (sand ? kind < 0.57 : kind < 0.33) strip.add(tinted(kit.cuke, rnd.pick(['#6a5040', '#3c3836', '#9a7048'])), lying(0.02, rnd.range(1.4, 2.0)));
          else if (sand ? kind < 0.61 : kind < 0.4) strip.add(kit.crab, lying(0.0, rnd.range(1.2, 1.8)));
          else if (sand ? kind < 0.63 : kind < 0.46) strip.add(kit.urchin, lying(0.01, rnd.range(0.8, 1.2)));
          else if (!sand && kind < 0.56) {
            // encrusting sponges in bright colours
            const r = rnd.range(0.06, 0.14);
            strip.add(tinted(kit.sponge, rnd.pick(['#f08a2c', '#f2cf4a', '#d94f9e', '#8e5ad6', '#e0533c'])), lying(0.3 * r, r * rnd.range(0.8, 1.4)));
          }
          else if (sand ? kind < 0.7 : kind < 0.68) {
            // a little group of feather-duster worms, their crowns in one colour
            const worm = tinted(kit.worm, rnd.pick(wormCols)), m = rnd.int(2, 4);
            for (let i = 0; i < m; i++) {
              const a = rnd() * TAU, d = rnd.range(0.03, 0.15), px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
              strip.add(worm, m4.mul(m4.translation(px, py, floorMesh(px, py) - 0.02),
                m4.rotationAxis(v3.norm([rnd() - 0.5, rnd() - 0.5, 0]), rnd.range(0, 0.35)), m4.scaling(rnd.range(1.0, 1.7))));
            }
          } else {
            // pebbles and bits of broken coral
            const m = rnd.int(1, 3);
            for (let i = 0; i < m; i++) {
              const a = rnd() * TAU, d = rnd.range(0, 0.3), px = x + Math.cos(a) * d, py = y + Math.sin(a) * d, r = rnd.range(0.03, 0.09);
              strip.add(tinted(kit.pebble, rnd.pick(crumbCols)), m4.mul(m4.translation(px, py, floorMesh(px, py) + r * 0.15),
                m4.rotationZ(rnd() * TAU), m4.rotationX(rnd.range(-0.3, 0.3)), m4.scaling(r * rnd.range(0.8, 1.5), r, r)));
            }
          }
        }
        b.static(strip, { within: 14, solid: false });
      }
    }

    // ---- fish ----------------------------------------------------------------
    // A lane of fusiliers up the west half of the channel and back down the
    // east half, in ranks of three.  Each fish is authored over four periods
    // (one lap), so its repeats every period are three more fish in the lane.
    {
      const pts = [];
      for (let y = -66; y <= 66; y += 6) pts.push([chanX(y) - 3.4, y, Math.max(H(chanX(y) - 3.4, y), -3) + 3.0]);
      for (let i = 1; i < 12; i++) {
        const a = Math.PI - i / 12 * Math.PI;
        const x = wreck.x + Math.cos(a) * 17, y = wreck.y - 8 + Math.sin(a) * 20;
        pts.push([x, y, Math.max(H(x, y), -3) + 4.5]);
      }
      for (let y = 66; y >= -66; y -= 6) pts.push([chanX(y) + 3.6, y, Math.max(H(chanX(y) + 3.6, y), -3) + 5.0]);
      for (let i = 1; i < 6; i++) {
        const a = -i / 6 * Math.PI;
        pts.push([chanX(-70) + Math.cos(a) * 3.5, -70 + Math.sin(a) * 5, H(chanX(-70), -70) + 4]);
      }
      const lane = new Path(pts, { closed: true, smooth: 10 });
      const mult = 4, ranks = 28, dur = mult * P;
      const speed = lane.length / dur;
      const geo = fishGeo(FISH.fusilier);
      for (let rk = 0; rk < ranks; rk++) {
        for (let j = 0; j < 3; j++) {
          const offset = (rk + rand.range(-0.08, 0.08)) * lane.length / (ranks * mult);
          addFollower(b, geo, laneTf(lane, { speed, offset, dx: (j - 1) * 0.6 + rand.range(-0.1, 0.1), dz: rand.range(-0.3, 0.3) }), dur, 0.3);
        }
      }
    }

    // blue-striped snappers circling across the channel just ahead of the
    // spawn point, evenly spaced, one lap a minute
    {
      const cx = chanX(-36) - 1, cy = -36;
      const pts = Array.from({ length: 16 }, (_, k) => {
        const a = k / 16 * TAU, x = cx + Math.cos(a) * 13, y = cy + Math.sin(a) * 4.5;
        return [x, y, Math.max(H(x, y), 0) + 2.6 + 0.8 * Math.sin(a)];
      });
      const loop = new Path(pts, { closed: true, smooth: 5 });
      const geo = fishGeo(FISH.snapper);
      for (let i = 0; i < 40; i++) {
        const offset = (Math.floor(i / 2) / 20 + rand.range(-0.006, 0.006)) * loop.length;
        addFollower(b, geo, laneTf(loop, { speed: loop.length / P, offset, dx: (i % 2) * 0.5 - 0.25, dz: rand.range(-0.25, 0.25) }), P, 0.2);
      }
    }

    // a cloud of blue chromis circling over the first bommie
    {
      const [u, y] = bommies[0];
      const x = chanX(y) + u, z = H(x, y) + 3.0;
      const geo = fishGeo(FISH.chromis);
      for (let i = 0; i < 24; i++) {
        const ring = i % 3, rr = 1.4 + ring * 0.7, h = z + ring * 0.5 + rand.range(-0.2, 0.2);
        const loop = new Path(Array.from({ length: 16 }, (_, k) => [x + Math.cos(k / 16 * TAU) * rr, y + Math.sin(k / 16 * TAU) * rr, h]), { closed: true, smooth: 3 });
        const laps = ring === 1 ? 2 : 3;
        addFollower(b, geo, laneTf(loop, { speed: laps * loop.length / P, offset: rand() * loop.length, dz: rand.range(-0.15, 0.15) }), P, 0.12);
      }
    }

    // a ring of silver jacks off the drop-off
    {
      const cx = dropX(28) + 6, cy = 28;
      const geo = fishGeo(FISH.jack);
      for (let i = 0; i < 36; i++) {
        const layer = i % 3, rr = 5 + layer * 0.8, h = 5 + layer * 1.6;
        const loop = new Path(Array.from({ length: 20 }, (_, k) => [cx + Math.cos(k / 20 * TAU) * rr, cy + Math.sin(k / 20 * TAU) * rr, h + Math.sin(k / 20 * TAU * 2) * 0.6]), { closed: true, smooth: 3 });
        addFollower(b, geo, laneTf(loop, { speed: 2 * loop.length / P, offset: (Math.floor(i / 3) / 12 + layer * 0.03) * loop.length, dz: rand.range(-0.2, 0.2) }), P, 0.3);
      }
    }

    // yellow tangs wandering over the west reef in a loose group
    {
      const cx = chanX(0) - 26;
      const pts = [[cx - 8, -14], [cx + 4, -10], [cx + 8, 2], [cx + 2, 12], [cx - 9, 8], [cx - 12, -4]].map(([x, y]) => [x, y, H(x, y) + 1.8]);
      const loop = new Path(pts, { closed: true, smooth: 6 });
      const geo = fishGeo(FISH.tang);
      for (let i = 0; i < 16; i++) {
        addFollower(b, geo, laneTf(loop, { speed: loop.length / P, offset: rand.range(0, 5), dx: rand.range(-1.2, 1.2), dz: rand.range(-0.5, 0.6) }), P, 0.15);
      }
    }

    // parrotfish grazing along the ridges
    {
      const geo = fishGeo(FISH.parrot);
      const loops = [[-17, -38, 5], [16, -26, 6], [-20, 10, 5], [18, 30, 6]];
      for (const [u, y0, r] of loops) {
        const cx = chanX(y0) + u;
        const pts = Array.from({ length: 8 }, (_, k) => {
          const a = k / 8 * TAU, x = cx + Math.cos(a) * r * 1.3, y = y0 + Math.sin(a) * r;
          return [x, y, H(x, y) + 1.3];
        });
        const loop = new Path(pts, { closed: true, smooth: 5 });
        addFollower(b, geo, laneTf(loop, { speed: loop.length / P, offset: rand() * loop.length }), P, 0.35);
      }
    }

    // ---- clownfish over two anemones near the spawn point, and humbug
    // damselfish hiding in a branching coral there: each pacing a little loop
    // of its own; small, so drawn only from near by
    {
      const homes = [
        // the fish, where (across the channel and along it), the floor under the host, its height, the loops' size, how many
        { kind: FISH.clown, u: -7.2, y: -31.5, r: 0.585, top: 0.62, size: 0.35, n: 2 },
        { kind: FISH.clown, u: 7.6, y: -33.5, r: 0.65, top: 0.68, size: 0.4, n: 2 },
        { kind: FISH.humbug, u: 9.5, y: -41, r: 1.43, top: 2.2, size: 0.9, n: 4 },
      ];
      // and more humbugs in the branching corals on two of the bommies further up the channel
      for (const [u, y] of [bommies[1], bommies[2]]) {
        const x = chanX(y) + u;
        homes.push({ kind: FISH.humbug, at: [x - 0.8, y + 0.5, H(x, y) + 1.1 + 1.0], size: 0.6, n: 3 });
      }
      const fr = rng(777);
      for (const h of homes) {
        const geo = fishGeo(h.kind);
        const [cx, cy, cz] = h.at ?? [chanX(h.y) + h.u, h.y, floorUnder(chanX(h.y) + h.u, h.y, h.r) - 0.13 + h.top];
        for (let i = 0; i < h.n; i++) {
          const a0 = fr() * TAU, d = fr() * h.size * 0.25, rr = fr.range(0.1, 0.2) * (h.size / 0.4) ** 0.5;
          const ox = cx + Math.cos(a0) * d, oy = cy + Math.sin(a0) * d, oz = cz + fr.range(-0.1, 0.25) * h.size;
          const turns = fr.int(3, 5), sense = fr() < 0.5 ? 1 : -1, ph = fr() * TAU;
          const pts = Array.from({ length: 10 }, (_, k) => {
            const a = sense * k / 10 * TAU + ph;
            return [ox + Math.cos(a) * rr, oy + Math.sin(a) * rr * 0.6, oz + 0.04 * Math.sin(2 * a)];
          });
          const loop = new Path(pts, { closed: true, smooth: 3 });
          const tf = laneTf(loop, { speed: turns * loop.length / P, offset: fr() * loop.length });
          b.dynamic(geo, { times: adaptiveTimes(tf, 0, P, { tolerance: 0.04, maxStep: 4, size: 0.06 }), transform: tf, caps: 'none', within: 16 });
        }
      }
    }

    // ---- the turtle: along the west ridge, up for a breath and back down -----
    {
      const c = chanX(-25);
      const pts = [[-16, -42, 2.2], [-24, -30, 2.5], [-21, -16, 3.0], [-13, -12, 8], [-11, -20, 15], [-9, -27, 18.8], [-10, -36, 13], [-12, -44, 6]]
        .map(([u, y, h]) => [c + u, y, h > 6 ? h : H(c + u, y) + h]);
      const loop = new Path(pts, { closed: true, smooth: 8 });
      const tf = laneTf(loop, { speed: loop.length / P, offset: loop.length * 0.55, span: 4 });
      b.dynamic(turtleGeo, { times: timeRange(0, P, 0.4), transform: tf, caps: 'none' });
    }

    // ---- manta rays gliding laps over the channel ----------------------------
    {
      const pts = [];
      for (let y = -58; y <= 6; y += 8) pts.push([chanX(y) - 5, y, 13.2 + 1.2 * Math.sin(y * 0.08)]);
      for (let y = 6; y >= -58; y -= 8) pts.push([chanX(y) + 7, y, 15 + 1.2 * Math.sin(y * 0.1)]);
      const loop = new Path(pts, { closed: true, smooth: 6 });
      const dur = 2 * P;
      const tf = laneTf(loop, { speed: loop.length / dur, offset: nearestOn(loop, [chanX(-31) - 5, -31]), span: 6 });
      b.dynamic(mantaGeo, { times: timeRange(0, dur, 0.5), transform: tf, caps: 'none' });
    }

    // ---- whale sharks: a long loop along the drop-off and back over the east ridge
    {
      const pts = [];
      for (let y = -50; y <= 34; y += 12) pts.push([dropX(y) + 9, y, 3 + 2 * Math.sin(y * 0.05)]);
      pts.push([dropX(46) - 6, 48, 9]);
      for (let y = 36; y >= -50; y -= 12) pts.push([chanX(y) + 17, y, 12.5]);
      pts.push([chanX(-60) + 22, -62, 11]);
      const loop = new Path(pts, { closed: true, smooth: 6 });
      const dur = 3 * P;
      const base = sharkBase();
      const tf = laneTf(loop, { speed: loop.length / dur, offset: nearestOn(loop, [chanX(-4) + 17, -4]), span: 10 });
      b.dynamic((t) => sharkAt(base, t), { times: timeRange(0, dur, 7.5 / 8), transform: tf, caps: 'none' });
    }

    // ---- jellyfish pulsing over the drop-off: one beat every 3 s ------------
    {
      const geo = jellyGeo('#d8c8f4');
      for (let i = 0; i < 7; i++) {
        const y = -40 + i * 7 + rand.range(-2, 2), x = dropX(y) + rand.range(6, 16), z = rand.range(-1, 12);
        const phase = rand(), rad = rand.range(1.5, 3.5), a0 = rand() * TAU;
        const beat = (t) => { const u = ((t / 3 + phase) % 1 + 1) % 1; return u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8; };
        const tf = (t) => {
          const c = beat(t), a = a0 + TAU * t / P;
          return m4.mul(m4.translation(x + Math.cos(a) * rad, y + Math.sin(a) * rad, z + 0.35 * c), m4.scaling(1 - 0.22 * c, 1 - 0.22 * c, 1 + 0.12 * c));
        };
        const times = new Set([0, P]);
        for (let k = -1; k <= 21; k++) for (const f of [0, 0.2, 0.6]) { const tt = (k + f - phase) * 3; if (tt > 0 && tt < P) times.add(+tt.toFixed(6)); }
        b.dynamic(geo, { times: [...times].sort((a, c) => a - c), transform: tf, paint: (t) => ({ emissive: 0.35 + 1.3 * beat(t) }), caps: 'none' });
      }
    }

    // ---- the yellow submarine circling the wreck ------------------------------
    {
      const pts = Array.from({ length: 12 }, (_, k) => {
        const a = k / 12 * TAU, x = wreck.x + Math.cos(a) * 17, y = wreck.y + Math.sin(a) * 13;
        return [x, y, Math.max(H(x, y), -4) + 5 + 1.5 * Math.sin(a * 2)];
      });
      const loop = new Path(pts, { closed: true, smooth: 6 });
      addFollower(b, subGeo(), laneTf(loop, { speed: -loop.length / P, span: 4 }), P, 1.6);
    }
  },
};
