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
  TERRAIN: 1, ROCK: 2, CORAL: 3, BRAIN: 4, FAN: 5, KELP: 6, SHAFT: 7, BUBBLE: 8, JELLY: 9,
  BEACON: 10, SPOTS: 11, THIN: 12, GLOW: 13, RUST: 14, BEAM: 15, SHELL: 16, SPONGE: 17, LAMP: 18, FROND: 19,
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
  if (s.mat == ${MAT.RUST}u && s.aux > 0.0) {
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

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  let m = s.mat;
  // instanced reef life: parts that keep their own colour, or take the copy's second one
  if (s.tag == 1u) {
    s.color /= max(s.inst.rgb, vec3f(1e-4));
  } else if (s.tag >= 2u) {
    let c2 = secondColor(u32(s.inst.w + 0.5));
    s.color = srgbToLinear(select(c2, mix(pow(s.inst.rgb, vec3f(1.0 / 2.2)), c2, 0.55), s.tag == 2u));
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
  if (m == ${MAT.THIN}u || m == ${MAT.KELP}u || m == ${MAT.FROND}u || m == ${MAT.FAN}u || m == ${MAT.JELLY}u) {
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
  } else if (m == ${MAT.BRAIN}u) {
    // meandering grooves
    let g = sin(noise3(s.pos * 2.2) * 34.0);
    let k = (1.0 - smoothstep(6.0, 20.0, s.dist));
    s.color *= 1.0 + 0.3 * g * k;
    s.ambient *= 1.0 - 0.25 * (g * 0.5 + 0.5) * k;
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
  } else if (m == ${MAT.RUST}u) {
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
    // whale shark: pale spots on the dark back
    let belly = 1.0 - smoothstep(-0.45, -0.1, s.n.z);
    let back = 1.0 - belly;
    s.color = mix(s.color, vec3f(0.72, 0.76, 0.78), belly);
    let q = s.uv * vec2f(22.0, 30.0);
    let cell = floor(q);
    let jit = hash22(cell) - 0.5;
    let d = length(fract(q) - 0.5 - jit * 0.4);
    let spot = (1.0 - smoothstep(0.16, 0.24, d)) * back;
    s.color = mix(s.color, vec3f(0.75, 0.78, 0.78), spot);
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
    s.emissive *= (0.15 + 1.6 * rim) * 0.6 / s.alpha;
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
    mesh: () => {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * TAU, r = i % 2 ? 0.07 : 0.2;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return Geo.extrude(pts, 0.04).color(WHITE).mat(MAT.CORAL);
    },
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

// A fish of thirteen triangles: a six-sided double pyramid body, coloured in
// bands (back, flanks, belly), and a tail fin.  Every triangle has a single
// colour: tiny moving triangles must not carry colour gradients, because a
// pixel that only grazes one gets its colour extrapolated, possibly below zero.
function fishGeo(len, height, width, cTop, cSide, cBelly, cTail, gloss = 0.35) {
  const g = new Geo();
  const L = len, h = height / 2, w = width / 2, y = 0.1 * L;
  const nose = [0, 0.5 * L, -0.02 * L], tail = [0, -0.3 * L, 0.02 * L];
  const ring = [[0, y, h], [w, y, h * 0.45], [w * 0.9, y, -h * 0.45], [0, y, -h * 0.9], [-w * 0.9, y, -h * 0.45], [-w, y, h * 0.45]];
  const band = [cTop, cSide, cBelly, cBelly, cSide, cTop];
  const c = [0, y, 0];
  for (let i = 0; i < 6; i++) {
    const a = ring[i], b = ring[(i + 1) % 6];
    const part = new Geo();
    triAway(part, nose, a, b, c);
    triAway(part, tail, a, b, c);
    g.add(part.color(band[i]));
  }
  g.gloss(gloss);
  g.add(Geo.triangle(tail, [0, -0.52 * L, 0.24 * L], [0, -0.52 * L, -0.2 * L]).color(cTail).mat(MAT.THIN));
  return g;
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
  g.add(Geo.sphere(0.12, 6, 3).scale(1, 1.3, 0.85).translate(0, 0.64, 0.01).color('#8a7c58'));
  const a = 0.75 * Math.sin(TAU * t / 4), sweep = 0.25 * Math.cos(TAU * t / 4);
  for (const side of [1, -1]) {
    // front flipper: a long blade rowing up and down around its root
    const root = [0.3, 0.3];
    const blade = [[0.28, 0.36], [0.72, 0.3], [1.02, 0.02], [0.28, 0.16]].map(([x, y]) => {
      let dx = x - root[0], dy = y - root[1];
      [dx, dy] = [dx * Math.cos(sweep) - dy * Math.sin(sweep), dx * Math.sin(sweep) + dy * Math.cos(sweep)];
      return [side * (root[0] + dx * Math.cos(a)), root[1] + dy, -dx * Math.sin(a)];
    });
    g.add(Geo.triangle(blade[0], blade[1], blade[2]).color('#8a7c58').mat(MAT.THIN));
    g.add(Geo.triangle(blade[0], blade[2], blade[3]).color('#8a7c58').mat(MAT.THIN));
    const b2 = 0.2 * Math.sin(TAU * t / 4 + 1.5);
    g.add(Geo.triangle([side * 0.18, -0.32, 0], [side * 0.4, -0.52, -b2], [side * 0.14, -0.48, 0]).color('#8a7c58').mat(MAT.THIN));
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
        const k = g.vert(W * cc / 4 * (1 - 0.06 * r * s), y, flap + sgn * thick, 0, 0, sgn);
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
    g.computeNormals(true);
    // the white belly catches the light thrown up from the sand
    if (sgn < 0) g.emissive(0.3);
    out.add(g);
  }
  for (const side of [1, -1]) {
    out.add(Geo.triangle([side * 0.22, L * 0.4, 0], [side * 0.3, L * 0.58, -0.06], [side * 0.14, L * 0.52, -0.1]).color('#1e242c').mat(MAT.THIN));
  }
  const tw = 0.15 * Math.sin(ph - 1);
  out.add(Geo.triangle([-0.05, -L * 0.36, 0], [0.05, -L * 0.36, 0], [tw, -L * 0.36 - 1.4, 0.05]).color('#1e242c').mat(MAT.THIN));
  return out.gloss(0.25);
}

// Whale shark: a broad, flattened body whose tail sweeps every 7.5 s.
const SHARK_L = 9;
function sharkBase() {
  const L = SHARK_L;
  const body = Geo.lathe([[0.03, 0], [0.24, 0.7], [0.45, 2.0], [0.68, 3.8], [0.8, 5.6], [0.78, 7.2], [0.6, 8.4], [0.3, 8.95], [0, 9.05]], 7)
    .rotateX(-Math.PI / 2).translate(0, -L / 2, 0).scale(1.2, 1, 0.8);
  body.color('#3f4d60').mat(MAT.SPOTS).gloss(0.3);
  const fins = new Geo();
  const fin = (a, b, c) => fins.add(Geo.triangle(a, b, c));
  fin([0, -0.4, 0.55], [0, -1.8, 0.48], [0, -1.5, 1.9]);
  fin([0, -2.8, 0.3], [0, -3.3, 0.26], [0, -3.45, 0.85]);
  fin([0.8, 1.6, -0.25], [0.8, 0.6, -0.3], [2.2, 0.2, -0.85]);
  fin([-0.8, 1.6, -0.25], [-0.8, 0.6, -0.3], [-2.2, 0.2, -0.85]);
  fin([0, -4.2, 0.08], [0, -4.75, 0.0], [0, -5.7, 2.1]);
  fin([0, -4.3, -0.05], [0, -4.8, 0.0], [0, -5.3, -1.1]);
  fins.color('#3f4d60').mat(MAT.THIN);
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
  const g = Geo.lathe([[0.42, 0.0], [0.52, 0.08], [0.44, 0.34], [0.0, 0.52]], 6).color(color).mat(MAT.JELLY);
  for (let i = 0; i < 6; i++) {
    const a = (i + 0.5) / 6 * TAU, r = 0.4, len = 1.2 + 0.5 * (i % 2);
    g.add(Geo.triangle([Math.cos(a) * r, Math.sin(a) * r, 0.02], [Math.cos(a + 0.12) * r, Math.sin(a + 0.12) * r, 0.02],
      [Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, -len]).color(color).mat(MAT.JELLY));
  }
  g.add(Geo.quad([-0.06, 0, 0.05], [0.06, 0, 0.05], [0.02, 0.02, -0.9], [-0.03, 0.02, -0.9]).color('#f0b8e8').mat(MAT.JELLY));
  // see-through (the bell's opacity is set in `surface`)
  return g.emissive(0.4).blend(0.6);
}

function subGeo() {
  const g = Geo.lathe([[0.04, 0], [0.38, 0.3], [0.62, 0.9], [0.66, 1.8], [0.6, 2.6], [0.38, 3.05], [0, 3.22]], 8)
    .rotateX(-Math.PI / 2).translate(0, -1.6, 0).color('#f2c12e').gloss(0.6);
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
      const g = Geo.heightfield(X0, Y0, X1, Y1, 160, 193, H, (x, y) => {
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
      g.color('#9a6c52').mat(MAT.RUST).cutout();
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
      taken.push([wreck.x, wreck.y, 12]);
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
    const bubbleSmall = Geo.sphere(1, 6, 4).color('#cdeeff').mat(MAT.BUBBLE).emissive(1).additive();
    const bubbleBig = Geo.sphere(1, 9, 5).color('#cdeeff').mat(MAT.BUBBLE).emissive(1).additive();
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
    for (let y = -36; y <= 56; y += 10) {
      const x = chanX(y);
      const z0 = H(x, y) + 0.1;
      // a ring of stones around the vent
      for (let k = 0; k < 4; k++) {
        const a = k / 4 * TAU + rand() * 0.6, d = rand.range(0.45, 0.6);
        life.plant(rock(rand, rand.range(0.25, 0.4), rand.range(0.2, 0.32)), m4.translation(x + Math.cos(a) * d, y + Math.sin(a) * d, z0 - 0.15));
      }
      for (let k = 0; k < P / 4; k++) {
        for (let j = 0; j < 5; j++) emitBubble(x, y, z0 + 0.2, k * 4 + j * 0.14, rand.range(0.09, 0.15), 0.35);
      }
    }
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
      const eel = Geo.tube([[0, 0, -0.85], [0, 0, 0.1], [0.04, 0, 0.45], [0.12, 0, 0.6]], 0.035, 4, { caps: false }).color('#efe6cc');
      eel.add(Geo.sphere(0.04, 4, 2).translate(0.12, 0, 0.6).color('#efe6cc'));
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
    // (every coral, sponge and rock has been placed by now)
    life.grow();

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
      const geo = fishGeo(0.48, 0.15, 0.08, '#ffcf3a', '#3f8ff0', '#eef4f8', '#ffd23f');
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
      const geo = fishGeo(0.34, 0.13, 0.06, '#f0c419', '#ffd84a', '#f6f0d0', '#f0c419', 0.4);
      for (let i = 0; i < 40; i++) {
        const offset = (Math.floor(i / 2) / 20 + rand.range(-0.006, 0.006)) * loop.length;
        addFollower(b, geo, laneTf(loop, { speed: loop.length / P, offset, dx: (i % 2) * 0.5 - 0.25, dz: rand.range(-0.25, 0.25) }), P, 0.2);
      }
    }

    // a cloud of blue chromis circling over the first bommie
    {
      const [u, y] = bommies[0];
      const x = chanX(y) + u, z = H(x, y) + 3.0;
      const geo = fishGeo(0.2, 0.085, 0.045, '#3a8cf0', '#5cc4ff', '#b2e6ff', '#3a8cf0', 0.5);
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
      const geo = fishGeo(0.6, 0.2, 0.08, '#5d7280', '#c4d0d8', '#eef2f4', '#a9b8c2', 0.85);
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
      const geo = fishGeo(0.26, 0.2, 0.04, '#f2c30f', '#ffd52a', '#ffe680', '#fff0a0', 0.4);
      for (let i = 0; i < 16; i++) {
        addFollower(b, geo, laneTf(loop, { speed: loop.length / P, offset: rand.range(0, 5), dx: rand.range(-1.2, 1.2), dz: rand.range(-0.5, 0.6) }), P, 0.15);
      }
    }

    // parrotfish grazing along the ridges
    {
      const geo = fishGeo(0.7, 0.24, 0.13, '#23877c', '#45c4a0', '#a8e6cf', '#e86fae', 0.4);
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
