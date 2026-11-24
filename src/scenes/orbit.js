// Orbital Station: a spinning ring station above a blue planet.  Shuttles come
// and go along a tunnel of chasing beacons, freighter convoys circle between a
// cargo depot and an asteroid mine, a mass driver flings ore pods across the
// scene, satellites race round a moonlet and a comet drifts past.
//
// Fly fast and the far side of everything is seen in the past: the spokes of
// the wheel bend, the beacon pulses stall or run backwards, and the clouds on
// the planet ahead and behind you are a minute and a half apart.
//
// Close up, most of the detail is painted by the shaders from uv and tags
// (hull panels, hatches, numbers, windows, container doors), which costs no
// triangles; the few small parts that are geometry (engine bells, aerials,
// handrails, docking ports, beacon cages, lattices) are added with `within`,
// so that they are drawn only from near by.

import { Geo } from '../geom.js';
import { m4, v3 } from '../math.js';
import { Path, adaptiveTimes, timeRange, rng } from '../util.js';

const PERIOD = 120;
const C = 200;
const SPIN = 30; // seconds per turn of the habitat ring: four turns per period
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const MAT = {
  HULL: 1, HULLW: 2, RING_SIDE: 3, RING_INNER: 4, RING_OUTER: 5, RING_PANEL: 6, HUB: 7,
  SPOKE: 8, SOLAR: 9, CLOCK: 10, SPINCOUNT: 11, CARGO: 12, ROCK: 13, ROCKD: 14, GATE: 15,
  RAIL: 16, BLINK: 17, WINDOWS: 18, CONTAINER: 19, MOON: 20, GLOW: 21, BEACON: 22,
  SHIP: 23, CANOPY: 24, TUG: 25, CNT: 26, LENS: 27, PORT: 28, RADIATOR: 29, LATTICE: 30, BLOCK: 31, FOIL: 32, DIST: 40,
};

// how long a beacon's flash and the afterglow that follows it last, in seconds
const BEACON_ON = 0.3, BEACON_AFTER = 0.7;

// direction from an azimuth (degrees clockwise from +Y) and an elevation
const dirAE = (az, el) => [Math.sin(az * DEG) * Math.cos(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG)];

// ---------------------------------------------------------------------------
// Layout.  The station sits at the origin; its axis AX points down the main
// approach lane.  Station-local coordinates: x = XL, y = YL (roughly up),
// z = along the axis.

const AX = v3.norm([-0.5, -1, 0.12]);
const XL = v3.norm(v3.cross([0, 0, 1], AX));
const YL = v3.cross(AX, XL);
const STATION = m4.fromBasis(XL, YL, AX, [0, 0, 0]);
const L2W = (p) => m4.point(STATION, p);

const SPAWN_POS = v3.add(v3.scale(v3.add(v3.scale(AX, Math.cos(28 * DEG)), v3.scale(XL, Math.sin(28 * DEG))), 740), v3.scale(YL, 45)).map(Math.round);
const LOOK_AT = [-50, 0, -70];
const SPAWN_YAW = Math.round(Math.atan2(LOOK_AT[0] - SPAWN_POS[0], LOOK_AT[1] - SPAWN_POS[1]) / DEG * 10) / 10;
const SPAWN_PITCH = Math.round(Math.atan2(LOOK_AT[2] - SPAWN_POS[2], Math.hypot(LOOK_AT[0] - SPAWN_POS[0], LOOK_AT[1] - SPAWN_POS[1])) / DEG * 10) / 10;

const SUN_DIR = dirAE(SPAWN_YAW - 108, 22);
const PL_DIR = dirAE(SPAWN_YAW + 14, -36);
const PL_ANG = 34; // angular radius of the planet, degrees
const PL_AX = v3.norm([0.22, 0.15, 1]);
const PL_E1 = v3.norm(v3.cross(PL_AX, [1, 0, 0]));
const PL_E2 = v3.cross(PL_AX, PL_E1);
const NEB_N = v3.norm([0.55, -0.35, 0.75]);

const MINE = [-1900, 250, -300];
const DEPOT = [1900, 250, -300];
const MOON = [1350, 2700, 820];
const MOON_R = 170;

// ---------------------------------------------------------------------------
// Shader hooks

const f = (v) => Number(v).toFixed(6);
const vec = (a) => `vec3f(${a.map(f).join(', ')})`;
const matConsts = Object.entries(MAT).map(([k, v]) => `const MAT_${k} = ${v}u;`).join('\n');

const WGSL = /* wgsl */ `
${matConsts}
const SUN_DIR = ${vec(v3.norm(SUN_DIR))};
const SUN_COL = vec3f(1.95, 1.84, 1.66);
const PL_DIR = ${vec(v3.norm(PL_DIR))};
const PL_R = ${f(Math.sin(PL_ANG * DEG))};
const PL_AX = ${vec(PL_AX)};
const PL_E1 = ${vec(PL_E1)};
const PL_E2 = ${vec(PL_E2)};
const NEB_N = ${vec(NEB_N)};
const ST_X = ${vec(XL)};
const ST_Y = ${vec(YL)};
const ST_Z = ${vec(AX)};
const SPIN = ${f(SPIN)};
const BEACON_ON = ${f(BEACON_ON)};
const BEACON_AFTER = ${f(BEACON_AFTER)};

// The lamps of the beacon lanes are copies of one mesh (see beacon() below):
// a flash shell (tag 0) and a slightly smaller afterglow shell (tag 1), each
// there only during its own part of the copy's cycle.  The copy's number holds
// its phase and how often it flashes (phase + 8 * every); the test is the one
// the engine makes for a time window, so a tilted slice cuts the lamps just
// as it would cut windowed static geometry.
// An open lattice of chords, posts and alternating diagonals, one bay per
// unit of uv (the trusses of the station's solar wings).
fn lattice(uv: vec2f) -> f32 {
  let f = fract(uv);
  let edge = min(min(f.y, 1.0 - f.y), min(f.x, 1.0 - f.x) * 1.6);
  let diag = abs(select(f.x, 1.0 - f.x, fract(uv.x * 0.5) >= 0.5) - f.y) * 0.7071;
  return 1.0 - smoothstep(0.055, 0.075, min(edge, diag * 1.15));
}

fn cutout(s: Surface) -> f32 {
  if (s.mat == MAT_LATTICE) { return lattice(s.uv); }
  if (s.mat != MAT_BEACON) { return 1.0; }
  let every = floor(s.inst.w / 8.0);
  let glow = s.tag == 1u;
  let start = s.inst.w - every * 8.0 + select(0.0, BEACON_ON, glow);
  let dur = select(BEACON_ON, BEACON_AFTER, glow);
  let ph = s.t - start;
  return select(0.0, 1.0, ph - floor(ph / every) * every < dur);
}

fn rotAround(v: vec3f, k: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return v * c + cross(k, v) * s + k * (dot(k, v) * (1.0 - c));
}

fn envSun(t: f32) -> Light { return Light(SUN_DIR, SUN_COL); }

fn starField(dir: vec3f) -> vec3f {
  var c = vec3f(0.0);
  {
    let g = dir * 150.0;
    let h = hash33(floor(g));
    let d = length(fract(g) - 0.5 - (h.yzx - 0.5) * 0.5);
    let tint = mix(vec3f(1.0, 0.8, 0.6), vec3f(0.7, 0.84, 1.0), h.z);
    c += tint * (step(0.9, h.x) * smoothstep(0.22, 0.0, d) * (0.15 + 1.4 * h.y * h.y));
  }
  {
    let g = dir * 48.0;
    let h = hash33(floor(g) + 17.0);
    let d = length(fract(g) - 0.5 - (h.yzx - 0.5) * 0.6);
    c += vec3f(0.95, 0.97, 1.0) * (step(0.94, h.x) * smoothstep(0.08, 0.0, d) * (2.0 + 10.0 * h.y * h.y));
  }
  return c;
}

fn nebula(dir: vec3f) -> vec3f {
  let b = dot(dir, NEB_N);
  let w = exp(-b * b * 7.0);
  let n1 = fbm3(dir * 2.4 + vec3f(3.0, 7.0, 1.0));
  let n2 = noise3(dir * 6.5 + vec3f(n1 * 2.5)) * 0.65 + noise3(dir * 13.0) * 0.35;
  let dens = smoothstep(0.38, 0.9, n1 * 0.55 + n2 * 0.55) * w;
  let col = mix(vec3f(0.07, 0.02, 0.09), vec3f(0.012, 0.05, 0.07), smoothstep(0.35, 0.65, n2));
  return col * dens * 1.3 + vec3f(0.006, 0.006, 0.011) * w;
}

fn planetSurface(n: vec3f, dir: vec3f, t: f32) -> vec3f {
  let lat = dot(n, PL_AX);
  // the ground turns once every 15 minutes
  let nr = rotAround(n, PL_AX, -t * (TAU / 900.0));
  let cont = fbm3(nr * 2.3 + vec3f(5.2, 1.3, 7.7));
  let detail = noise3(nr * 9.0 + 2.0) * 0.65 + noise3(nr * 21.0) * 0.35;
  let land = smoothstep(0.54, 0.585, cont + (detail - 0.5) * 0.08);
  var alb = mix(vec3f(0.004, 0.016, 0.055), vec3f(0.008, 0.032, 0.08), detail);
  let landCol = mix(vec3f(0.13, 0.105, 0.065), vec3f(0.04, 0.07, 0.03), smoothstep(0.4, 0.68, detail));
  alb = mix(alb, landCol, land);
  let ice = smoothstep(0.8, 0.87, abs(lat) + (detail - 0.5) * 0.12);
  alb = mix(alb, vec3f(0.75, 0.8, 0.86), ice);
  // cloud bands: every band of latitude drifts at its own rate
  let lb = asin(clamp(lat, -1.0, 1.0)) / PI + 0.5;
  let bf = lb * 11.0;
  let band = floor(bf);
  let edge = abs(fract(bf) - 0.5) * 2.0;
  let rate = (0.6 + hash11(band * 7.31 + 0.5)) * (TAU / 520.0) * select(-0.6, 1.0, hash11(band + 3.1) > 0.35);
  let nc = rotAround(n, PL_AX, -t * rate - band * 1.7);
  let q = vec3f(dot(nc, PL_E1), dot(nc, PL_E2), dot(nc, PL_AX) * 3.0);
  let cl = fbm3(q * 4.5 + vec3f(band * 3.1, 0.0, 1.0)) * 0.7 + noise3(q * 13.0) * 0.3;
  let cloud = smoothstep(0.5, 0.72, cl) * (1.0 - smoothstep(0.65, 1.0, edge) * 0.9);
  alb = mix(alb, vec3f(0.8, 0.82, 0.86), cloud);
  // sunlight
  let ndl = dot(n, SUN_DIR);
  let day = smoothstep(-0.1, 0.2, ndl);
  var c = alb * SUN_COL * 0.8 * max(ndl, 0.0);
  c += alb * vec3f(1.0, 0.4, 0.15) * (smoothstep(-0.12, 0.04, ndl) * (1.0 - smoothstep(0.04, 0.3, ndl)) * 0.25);
  let r = reflect(dir, n);
  c += SUN_COL * (pow(max(dot(r, SUN_DIR), 0.0), 50.0) * 0.5 * (1.0 - land) * (1.0 - cloud) * step(0.0, ndl));
  // city lights on the night side
  if (ndl < 0.05 && land > 0.0) {
    let city = (1.0 - ice) * step(0.86, hash31(floor(nr * 150.0))) * smoothstep(0.45, 0.65, noise3(nr * 4.0 + 9.0));
    c += vec3f(1.0, 0.62, 0.28) * (land * city * (1.0 - smoothstep(-0.2, 0.05, ndl)) * (1.0 - cloud * 0.85) * 0.25);
  }
  // atmosphere at grazing angles, and a blue haze over the day side
  let mu = max(dot(n, -dir), 0.0);
  let rim = pow(1.0 - mu, 3.0);
  c += vec3f(0.2, 0.45, 1.0) * (rim * smoothstep(-0.25, 0.35, ndl) * 0.7);
  c += vec3f(0.004, 0.012, 0.035) * day;
  return c;
}

fn envSky(dir: vec3f, t: f32) -> vec3f {
  var bg = starField(dir) + nebula(dir);
  let sd = dot(dir, SUN_DIR);
  bg += vec3f(1.0, 0.93, 0.82) * (70.0 * smoothstep(0.99988, 0.99995, sd));
  bg += vec3f(1.0, 0.82, 0.62) * (pow(max(sd, 0.0), 900.0) * 3.0 + pow(max(sd, 0.0), 40.0) * 0.06);
  let b = dot(dir, PL_DIR);
  if (b <= 0.0) { return bg; }
  let d = sqrt(max(1.0 - b * b, 0.0));
  let cov = smoothstep(PL_R + 0.001, PL_R - 0.001, d);
  var c = bg;
  if (cov > 0.0) {
    let h = max(PL_R * PL_R - d * d, 0.0);
    let s = b - sqrt(h);
    let n = normalize(dir * s - PL_DIR);
    c = mix(bg, planetSurface(n, dir, t), cov);
  }
  // the thin bright line of atmosphere just outside the limb
  let limbN = normalize(dir - PL_DIR * b);
  let lit = smoothstep(-0.4, 0.5, dot(limbN, SUN_DIR));
  let above = max(d - PL_R, 0.0);
  c += vec3f(0.3, 0.55, 1.0) * ((exp(-above / 0.004) * 0.8 + exp(-above / 0.03) * 0.08) * lit * (1.0 - cov));
  return c;
}

fn envAmbient(n: vec3f, t: f32) -> vec3f {
  let pl = dot(n, PL_DIR) * 0.5 + 0.5;
  return vec3f(0.010, 0.012, 0.018) + vec3f(0.04, 0.07, 0.12) * (pl * pl);
}

fn envFog(dir: vec3f, t: f32, dist: f32) -> vec4f { return vec4f(0.0); }

// 1 inside a band of half-width w (in cells) centred in every unit cell,
// filtered over a footprint of fw cells (fades to the average when tiny)
fn stripe(x: f32, w: f32, fw: f32) -> f32 {
  let q = abs(fract(x) - 0.5);
  let e = fw * 0.5 + 0.0005;
  let sharp = 1.0 - smoothstep(w - e, w + e, q);
  return mix(sharp, 2.0 * w, saturate(fw * 1.2 - 0.3));
}

// panel seams projected along the main axis of the normal: x = seam, y = panel tint
fn hullPanels(p: vec3f, n: vec3f, px: f32) -> vec2f {
  let an = abs(n);
  var q = p.xy;
  if (an.x >= an.y && an.x >= an.z) { q = p.yz; } else if (an.y >= an.z) { q = p.xz; }
  let g = q / vec2f(6.0, 3.0);
  let seam = max(1.0 - stripe(g.x, 0.5 - 0.08 / 6.0, px / 6.0), 1.0 - stripe(g.y, 0.5 - 0.08 / 3.0, px / 3.0));
  let tint = mix(1.0, 0.84 + 0.3 * hash21(floor(g) + floor(p.z / 3.0) * 0.0), saturate(1.4 - px * 0.4));
  return vec2f(seam, tint);
}

// craters: random spheres on a 3D grid of cells of size metres, each a bowl
// with a raised rim.  Returns the normal bent by the bowls, and a darkening.
fn craters(p: vec3f, n: vec3f, size: f32, density: f32) -> vec4f {
  let g = p / size;
  let i = floor(g);
  var grad = vec3f(0.0);
  var dark = 0.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let cell = i + vec3f(f32(x), f32(y), f32(z));
        let h = hash33(cell);
        if (h.x > density) { continue; }
        let c = cell + 0.2 + hash33(cell + 7.7) * 0.6;
        let r = 0.3 + 0.45 * h.y;
        let q = (g - c) / r;
        let d = length(q);
        if (d < 1.5) {
          let e = exp(-(d - 1.0) * (d - 1.0) / 0.03);
          let dfd = select(0.0, 2.0 * d, d < 1.0) - 0.35 * 2.0 * (d - 1.0) / 0.03 * e;
          grad += 0.22 * dfd * q / max(d, 1e-4);
          dark += (1.0 - smoothstep(0.5, 1.0, d)) * 0.25 + e * -0.12;
        }
      }
    }
  }
  let gt = grad - n * dot(grad, n);
  return vec4f(normalize(n - gt), dark);
}

// a small round lamp at distance d (metres) from its centre, radius r
fn lampDot(d: f32, r: f32, px: f32) -> vec2f {
  let cov = 1.0 - smoothstep(r, r + px, d);
  let k = r / (r + px * 0.5);
  return vec2f(cov, k * k);
}

// signed distance to a rectangle of half-size h with corners rounded by r
fn sdRect(q: vec2f, h: vec2f, r: f32) -> f32 {
  let d = abs(q) - h + r;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}
// coverage of the inside of a distance field, and of a line of half-width w
// along its edge (fading out once it is thinner than a pixel)
fn fillSd(d: f32, px: f32) -> f32 { return 1.0 - smoothstep(-px * 0.5, px * 0.5, d); }
fn lineSd(d: f32, w: f32, px: f32) -> f32 {
  return (1.0 - smoothstep(w - px * 0.5, w + px * 0.5, abs(d))) * saturate(w * 2.0 / px);
}
// seams at every multiple of cell (metres), half-width w
fn seams(q: vec2f, cell: vec2f, w: f32, px: f32) -> f32 {
  return max(1.0 - stripe(q.x / cell.x, 0.5 - w / cell.x, px / cell.x), 1.0 - stripe(q.y / cell.y, 0.5 - w / cell.y, px / cell.y));
}
// a thruster pad centred on c: a dark plate with two nozzle holes
fn rcsPad(q: vec2f, c: vec2f, s: f32, px: f32) -> f32 {
  let d = q - c;
  let pad = fillSd(sdRect(d, vec2f(0.2, 0.13) * s, 0.03 * s), px);
  let hole = fillSd(min(length(d - vec2f(0.09 * s, 0.0)), length(d + vec2f(0.09 * s, 0.0))) - 0.045 * s, px);
  return pad * 0.5 + hole * 0.45;
}
// painted digits in a box from lo to hi (metres on the face), read left to right
// whichever side of the ship they are on (dir = -1 mirrors the face's x)
fn label7(q: vec2f, lo: vec2f, hi: vec2f, dir: f32, value: f32, digits: i32, px: f32) -> f32 {
  var u = (q - lo) / (hi - lo);
  if (dir < 0.0) { u.x = 1.0 - u.x; }
  if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) { return 0.0; }
  return number7(u, value, digits) * saturate(2.0 - px * 12.0 / (hi.y - lo.y));
}
// the shuttles' and tugs' hulls: q = model coordinates across the face,
// fam = which way it faces (0 side, 1 top or bottom, 2 front or back), neg =
// towards -x, -z or -y, part = 0 hull, 1 accent and fin, 2 wing, 3 engine
// block.  Returns the colour change in rgb (multiplier) and a glow in w.
fn shuttleSkin(q: vec2f, fam: u32, neg: bool, part: u32, id: f32, base: vec3f, px: f32) -> vec4f {
  var c = base;
  var glow = 0.0;
  let dir = select(1.0, -1.0, neg);
  if (part == 0u) {
    c *= 1.0 - 0.4 * seams(q + vec2f(0.4, 0.0), vec2f(2.0, 1.25), 0.012, px);
    if (fam == 0u) {
      // side: a hatch with a handle and a status light, the registration, thruster pads
      let hd = sdRect(q - vec2f(5.75, 0.05), vec2f(0.62, 1.05), 0.22);
      c *= (1.0 - 0.6 * lineSd(hd, 0.03, px)) * (1.0 - 0.08 * fillSd(hd, px));
      c *= 1.0 - 0.7 * fillSd(sdRect(q - vec2f(5.75 - 0.42 * dir, 0.05), vec2f(0.04, 0.16), 0.03), px);
      let sill = fillSd(sdRect(q - vec2f(5.75, -1.18), vec2f(0.62, 0.05), 0.0), px);
      let hz = step(0.5, fract((q.x + q.y) * 3.0));
      c = mix(c, mix(vec3f(0.02), vec3f(0.9, 0.62, 0.05), hz), sill);
      let ld = lampDot(length(q - vec2f(5.75, 1.3)), 0.06, px);
      c = mix(c, vec3f(0.2, 1.0, 0.3), ld.x);
      glow += ld.x * ld.y * 6.0;
      let reg = label7(q, vec2f(-8.3, 0.25), vec2f(-4.9, 1.55), dir, 100.0 + id * 37.0, 3, px);
      c = mix(c, vec3f(0.08, 0.09, 0.11), reg);
      c *= 1.0 - rcsPad(q, vec2f(8.6, 0.6), 1.0, px) - rcsPad(q, vec2f(-8.3, 1.35), 1.0, px);
    } else if (fam == 1u && !neg) {
      // roof: a docking hatch, walkway lines, thruster pads by the nose
      let r = length(q - vec2f(-1.8, 0.0));
      c *= (1.0 - 0.55 * lineSd(r - 0.82, 0.05, px)) * (1.0 - 0.12 * fillSd(r - 0.7, px));
      c *= 1.0 - 0.5 * fillSd(sdRect(q - vec2f(-1.8, 0.0), vec2f(0.32, 0.05), 0.04), px);
      let walk = lineSd(abs(q.y) - 1.25, 0.03, px) * step(abs(q.x + 0.5), 6.5) * step(0.4, fract(q.x * 1.2));
      c = mix(c, vec3f(0.85, 0.6, 0.06), walk);
      c *= 1.0 - rcsPad(q.yx, vec2f(2.15, 6.6), 1.0, px) - rcsPad(q.yx, vec2f(-2.15, 6.6), 1.0, px);
    } else if (fam == 1u) {
      // belly: dark heat tiles and the doors of the landing gear
      let tile = 1.0 - seams(q, vec2f(0.5, 0.5), 0.01, px) * 0.5;
      let h = hash21(floor(q * 2.0));
      c = mix(c, vec3f(0.07, 0.075, 0.08) * (0.8 + 0.4 * h) * tile, step(abs(q.y), 2.3));
      let gear = min(sdRect(q - vec2f(4.2, 0.0), vec2f(0.9, 0.55), 0.1), sdRect(q - vec2f(-5.5, 0.0), vec2f(1.0, 1.4), 0.1));
      c *= 1.0 - 0.6 * lineSd(gear, 0.025, px);
    } else {
      // stern: white lights either side of the engines; bow: thruster pads
      if (neg) {
        let ld = lampDot(length(vec2f(abs(q.x) - 2.45, q.y + 0.1)), 0.14, px);
        c = mix(c, vec3f(1.0, 0.97, 0.9), ld.x);
        glow += ld.x * ld.y * 22.0;
      } else {
        c *= 1.0 - rcsPad(vec2f(abs(q.x), q.y), vec2f(1.6, -0.1), 0.8, px);
      }
    }
  } else if (part == 1u) {
    // accent stripe and fin: a pinstripe and a roundel with the ship's number
    c = mix(c, vec3f(0.85), lineSd(q.y + 0.1, 0.035, px) * step(f32(fam), 0.5));
    if (fam == 0u && q.y > 1.9) {
      let r = length(q - vec2f(-7.0, 3.1));
      let ring = fillSd(r - 0.85, px) - fillSd(r - 0.7, px);
      c = mix(c, vec3f(0.85), ring);
      c = mix(c, vec3f(0.9), label7(q, vec2f(-7.3, 2.75), vec2f(-6.7, 3.45), dir, id + 1.0, 1, px));
    }
  } else if (part == 2u) {
    // wing: panels, walkway lines by the root, red and green tips
    c *= 1.0 - 0.4 * seams(q, vec2f(1.6, 1.3), 0.012, px);
    if (fam == 1u) {
      c *= 1.0 - 0.35 * lineSd(abs(q.y) - 3.3, 0.025, px);
      let tip = smoothstep(5.55 - px, 5.55 + px, abs(q.y));
      c = mix(c, select(vec3f(0.1, 0.55, 0.15), vec3f(0.7, 0.08, 0.05), q.y < 0.0), tip);
    }
  } else if (part == 3u) {
    // engine block: cooling fins along it
    c *= 0.75 + 0.35 * stripe(q.x * 4.0, 0.3, px * 4.0);
  } else if (part == 4u) {
    // the tug's cab: panels, a big number, a hatch, a striped bow
    c *= 1.0 - 0.4 * seams(q, vec2f(2.5, 1.5), 0.02, px);
    if (fam == 0u) {
      c = mix(c, vec3f(0.07, 0.08, 0.1), label7(q, vec2f(21.4, -1.2), vec2f(26.6, 2.6), dir, 200.0 + id * 41.0, 3, px));
      let hd = sdRect(q - vec2f(31.0, -1.6), vec2f(0.75, 1.3), 0.3);
      c *= (1.0 - 0.6 * lineSd(hd, 0.04, px)) * (1.0 - 0.6 * fillSd(sdRect(q - vec2f(31.0 - 0.5 * dir, -1.6), vec2f(0.06, 0.22), 0.04), px));
      let band = step(abs(q.y + 3.7), 0.35) * step(q.x, 29.8);
      c = mix(c, mix(vec3f(0.03), vec3f(0.9, 0.62, 0.05), step(0.5, fract((q.x + q.y) * 0.8))), band);
      c *= 1.0 - rcsPad(q, vec2f(32.0, 3.2), 2.0, px);
    } else if (fam == 2u && !neg) {
      let ch = step(0.5, fract((abs(q.x) - q.y) * 0.5));
      c = mix(vec3f(0.03), vec3f(0.9, 0.62, 0.05), ch);
      let ld = lampDot(length(q - vec2f(0.0, 0.7)), 0.3, px);
      c = mix(c, vec3f(1.0, 0.97, 0.9), ld.x);
      glow += ld.x * ld.y * 18.0;
    } else if (fam == 1u && !neg) {
      let r = length(q - vec2f(24.0, 0.0));
      c *= (1.0 - 0.55 * lineSd(r - 1.4, 0.07, px)) * (1.0 - 0.12 * fillSd(r - 1.25, px));
      c = mix(c, vec3f(0.85, 0.6, 0.06), lineSd(abs(q.y) - 4.0, 0.06, px) * step(0.4, fract(q.x * 0.6)));
    }
  } else if (part == 5u) {
    // the spine: an open lattice of struts
    let a = stripe((q.x + q.y) / 3.0, 0.07, px / 3.0);
    let b = stripe((q.x - q.y) / 3.0, 0.07, px / 3.0);
    let e = 1.0 - stripe(q.y / 3.0, 0.38, px / 3.0);
    c = mix(vec3f(0.015, 0.017, 0.02), c, max(max(a, b), e));
  } else if (part == 6u) {
    c *= 1.0 - 0.4 * seams(q, vec2f(2.5, 1.5), 0.02, px);
    let tip = smoothstep(7.6 - px, 7.6 + px, abs(q.y)) * step(f32(fam), 1.5);
    c = mix(c, select(vec3f(0.1, 0.55, 0.15), vec3f(0.7, 0.08, 0.05), q.y < 0.0), tip);
  } else {
    // the tug's engine block: fins, and white stern lights at its corners
    c *= 0.72 + 0.38 * stripe(q.x * 2.0, 0.3, px * 2.0);
    if (fam == 2u && neg) {
      let ld = lampDot(length(vec2f(abs(q.x) - 4.6, q.y - 3.6)), 0.32, px);
      c = mix(c, vec3f(1.0, 0.97, 0.9), ld.x);
      glow += ld.x * ld.y * 22.0;
      c *= 1.0 - 0.5 * lineSd(length(q) - 3.55, 0.12, px);
    }
  }
  return vec4f(c, glow);
}

// The blocks where the spokes meet the ring (10 m deep, 18 wide, 26 along
// the axis), in model coordinates as for shuttleSkin: lit windows on the faces
// towards the axis, an airlock on the faces along the ring, the spoke's number.
fn blockSkin(q: vec2f, fam: u32, neg: bool, id: f32, base: vec3f, px: f32, t: f32) -> vec3f {
  var c = base * (1.0 - 0.4 * seams(q, vec2f(3.0, 2.0), 0.02, px));
  if (fam == 1u) {
    // q = (across the ring, radial): two rows of windows, the number
    let wq = vec2f(q.x / 2.6, (q.y + 1.0) / 2.4);
    let win = stripe(wq.x, 0.3, px / 2.6) * stripe(wq.y, 0.2, px / 2.4) * step(abs(q.x), 7.5) * step(abs(q.y + 1.0), 2.4);
    c = mix(c, vec3f(1.0, 0.8, 0.52) * 1.6, win);
  } else if (fam == 2u) {
    let hd = sdRect(q - vec2f(0.0, -4.0), vec2f(1.1, 1.5), 0.45);
    c *= (1.0 - 0.6 * lineSd(hd, 0.04, px)) * (1.0 - 0.1 * fillSd(hd, px));
    c = mix(c, vec3f(0.85, 0.65, 0.12), lineSd(abs(q.x) - 1.8, 0.04, px) * step(abs(q.y + 4.0), 1.6));
    c = mix(c, vec3f(0.1, 0.11, 0.13), label7(q, vec2f(-1.5, 3.0), vec2f(1.5, 7.0), select(1.0, -1.0, !neg), id + 1.0, 1, px));
  }
  return c;
}

// A freight container's face of sz metres, from its corner (q in metres):
// kind 0 side, 1 front end, 2 door end, 3 roof or floor.  Frame rails and
// corner castings, corrugated walls, lock rods on the doors, numbers, and on
// the convoys' containers the grapple's strap.
fn containerSkin(q: vec2f, sz: vec2f, kind: u32, serial: f32, base: vec3f, px: f32, strap: bool) -> vec3f {
  let cq = min(q, sz - q);
  let edge = min(cq.x, cq.y);
  var c = base;
  // corrugation
  let ribs = select(q.x, q.y, kind == 3u) / 0.6;
  c *= 1.0 - 0.22 * (0.5 + 0.5 * sin(ribs * TAU)) * saturate(1.0 - px * 3.0);
  let number = 4100.0 + serial * 173.0;
  if (kind == 2u) {
    // two door leaves, four lock rods with their cams and handles
    let h = sz.x * 0.5;
    c *= 1.0 - 0.7 * lineSd(q.x - h, 0.03, px);
    let rx = abs(abs(q.x - h) - 0.26 * sz.x) - 0.1 * sz.x;
    let rod = lineSd(rx, 0.06, px) * step(0.5, cq.y);
    c = mix(c, vec3f(0.55, 0.57, 0.6), rod);
    c *= 1.0 - 0.5 * lineSd(rx - 0.11, 0.03, px) * step(0.5, cq.y);
    let cam = fillSd(sdRect(vec2f(rx, cq.y - 0.75), vec2f(0.13, 0.09), 0.03), px);
    c = mix(c, vec3f(0.25, 0.26, 0.28), cam);
    let handle = fillSd(sdRect(vec2f(rx + 0.25, q.y - 0.42 * sz.y), vec2f(0.22, 0.05), 0.04), px);
    c = mix(c, vec3f(0.2, 0.21, 0.23), handle);
    c = mix(c, vec3f(0.95), label7(q, vec2f(0.56 * sz.x, sz.y - 1.4), vec2f(0.78 * sz.x, sz.y - 0.7), 1.0, number, 4, px));
  } else if (kind == 0u) {
    // the owner's band and a big number up top, a placard down low
    c = mix(c, vec3f(0.92), label7(q, vec2f(0.5, sz.y - 2.4), vec2f(4.4, sz.y - 1.0), 1.0, number, 4, px));
    let band = step(abs(q.y - sz.y + 3.2), 0.18) * step(0.6, q.x) * step(q.x, sz.x - 0.6);
    c = mix(c, vec3f(0.92), band);
    let dmd = abs(q.x - sz.x + 1.5) + abs(q.y - 1.6) - 0.55;
    c = mix(c, mix(vec3f(0.95), vec3f(0.95, 0.45, 0.05), step(0.0, q.y - 1.6)), fillSd(dmd, px));
  }
  // the grapple's strap round the middle, over the roof and down the sides
  if (strap && (kind == 0u || kind == 3u)) {
    let sq = select(q.x, q.y, kind == 3u) - 5.0;
    let strapCov = fillSd(abs(sq) - 0.3, px);
    c = mix(c, vec3f(0.62, 0.5, 0.16) * (1.0 - 0.4 * lineSd(abs(sq) - 0.22, 0.02, px)), strapCov);
    c *= 1.0 - 0.45 * lineSd(abs(sq) - 0.33, 0.03, px);
  }
  // frame rails and corner castings, with their slots
  let rail = 1.0 - smoothstep(0.28 - px * 0.5, 0.28 + px * 0.5, edge);
  c = mix(c, base * 0.62, rail);
  let casting = fillSd(max(cq.x, cq.y) - 0.45, px);
  c = mix(c, vec3f(0.16, 0.17, 0.18), casting);
  c *= 1.0 - 0.8 * fillSd(sdRect(cq - vec2f(0.24, 0.24), vec2f(0.1, 0.05), 0.045), px);
  return c;
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  let fwP = fwidth(s.pos);
  let fwU = fwidth(s.uv);
  let px = max(max(fwP.x, fwP.y), fwP.z) + 1e-4;
  let m = s.mat;
  if (m == MAT_HULL || m == MAT_HULLW) {
    var p = s.pos; var n = s.n;
    if (m == MAT_HULL) {
      p = vec3f(dot(s.pos, ST_X), dot(s.pos, ST_Y), dot(s.pos, ST_Z));
      n = vec3f(dot(s.n, ST_X), dot(s.n, ST_Y), dot(s.n, ST_Z));
    }
    let pn = hullPanels(p, n, px);
    s.color *= pn.y * (1.0 - 0.5 * pn.x);
  } else if (m == MAT_RING_SIDE) {
    // windows on the flat faces of the spinning ring (this mesh stands still:
    // the pattern turns with the ring's own time)
    let ub = fract(s.uv.x - s.t / SPIN);
    let X = ub * 420.0; let fX = fwU.x * 420.0;
    let rows = s.uv.y * 2.0;
    let win0 = stripe(X, 0.2, fX) * stripe(rows, 0.11, fwU.y * 2.0);
    let nearSpoke = abs(fract(ub * 6.0 + 0.5) - 0.5) * 70.0;
    let win = win0 * step(3.0, nearSpoke);
    let id = floor(X) + floor(rows) * 997.0;
    let lit = step(0.45, hash11(id * 1.37 + floor(s.t / 24.0 + hash11(id) * 5.0) * 7.31));
    let warm = mix(vec3f(1.0, 0.7, 0.4), vec3f(0.78, 0.9, 1.0), step(0.82, hash11(id * 3.1 + 0.2)));
    let seam = max(1.0 - stripe(X / 14.0, 0.5 - 0.03, fX / 14.0), 1.0 - stripe(rows + 0.5, 0.5 - 0.02, fwU.y * 2.0));
    let rib = (1.0 - stripe(ub * 6.0 + 0.5, 0.5 - 0.012, fwU.x * 6.0));
    // inside each window a room: brighter under its ceiling (towards the axis,
    // since the spin makes "down" outward) and something standing on its floor
    let outward = select(-1.0, 1.0, dot(s.n, ST_Z) < 0.0);
    let wy = (fract(rows) - 0.5) / 0.22 * outward;
    let wx = (fract(X) - 0.5) / 0.4;
    let ceilLight = 0.55 + 0.9 * smoothstep(0.0, -0.45, wy);
    let hs = hash11(id * 0.71 + 3.0);
    let thing = step(abs(wx - (hs - 0.5) * 0.6), 0.12 + 0.2 * hs) * step(0.5 - 0.35 * fract(hs * 7.0), wy);
    let room = warm * ceilLight * (1.0 - 0.75 * thing * saturate(1.0 - fX * 2.0));
    let frame = stripe(X, 0.25, fX) * stripe(rows, 0.135, fwU.y * 2.0) - win0;
    // a handrail between the rows of windows, with its shadow
    let rm = (fract(rows + 0.5) - 0.5) * 8.0;
    let rail = lineSd(rm - 0.4 * outward, 0.035, px);
    let railShade = lineSd(rm - 0.5 * outward, 0.03, px);
    var hull = s.color * (1.0 - 0.45 * seam) * (1.0 - 0.35 * rib) * (1.0 - 0.5 * frame) * (1.0 - 0.5 * railShade);
    hull = mix(hull, vec3f(0.85, 0.65, 0.12), rail);
    s.color = mix(hull, mix(vec3f(0.012, 0.016, 0.024), room, lit), win);
    s.emissive = win * lit * 2.2 * ceilLight;
    s.gloss = mix(s.gloss, 0.8, win);
  } else if (m == MAT_RING_INNER) {
    let ub = fract(s.uv.x - s.t / SPIN);
    let X = ub * 84.0; let fX = fwU.x * 84.0;
    let win = stripe(X, 0.4, fX) * stripe(s.uv.y, 0.33, fwU.y) * (1.0 - (1.0 - stripe(X * 4.0, 0.46, fX * 4.0)) * 0.7);
    let wave = 0.7 + 0.3 * sin(TAU * (ub * 2.0 - s.t / 60.0));
    s.color = mix(s.color, vec3f(0.78, 1.0, 0.74), win);
    s.emissive = win * 1.5 * wave;
    s.gloss = mix(s.gloss, 0.7, win);
  } else if (m == MAT_RING_OUTER || m == MAT_RING_PANEL) {
    let ub = fract(s.uv.x - s.t / SPIN);
    let X = ub * 140.0; let fX = fwU.x * 140.0;
    let seam = max(1.0 - stripe(X, 0.5 - 0.02, fX), 1.0 - stripe(s.uv.y * 2.0 + 0.5, 0.5 - 0.03, fwU.y * 2.0));
    let tint = mix(1.0, 0.86 + 0.26 * hash11(floor(X) + floor(s.uv.y * 2.0) * 31.0), saturate(1.0 - fX));
    s.color *= tint * (1.0 - 0.45 * seam);
    if (m == MAT_RING_OUTER) {
      let k = floor(ub * 24.0);
      let lx = (fract(ub * 24.0) - 0.5) * 55.5;
      let ly = (s.uv.y - 0.5) * 14.0;
      let ld = lampDot(length(vec2f(lx, ly)), 0.9, px);
      let red = fract(k * 0.5) > 0.25;
      let col = select(vec3f(1.0, 0.95, 0.9), vec3f(1.0, 0.12, 0.06), red);
      let on = step(fract(s.t / 2.0 + select(0.0, 0.5, red)), 0.1);
      // in metres on the face: an airlock with a porthole and a striped
      // frame, two handrails, a vent, and the section's number
      let hd = sdRect(vec2f(lx - 14.0, ly), vec2f(1.0, 1.4), 0.45);
      let frameZ = step(0.0, hd) * step(hd, 0.28);
      s.color = mix(s.color, mix(vec3f(0.03), vec3f(0.9, 0.62, 0.05), step(0.5, fract((lx + ly) * 1.4))), frameZ);
      s.color *= (1.0 - 0.6 * lineSd(hd, 0.03, px)) * (1.0 - 0.6 * fillSd(sdRect(vec2f(lx - 14.75, ly), vec2f(0.05, 0.3), 0.04), px));
      let port = lampDot(length(vec2f(lx - 14.0, ly - 0.55)), 0.28, px);
      s.color = mix(s.color, vec3f(1.0, 0.8, 0.5), port.x);
      let rail = lineSd(abs(ly) - 5.3, 0.04, px);
      s.color *= 1.0 - 0.5 * lineSd(abs(ly) - 5.45, 0.035, px);
      s.color = mix(s.color, vec3f(0.85, 0.65, 0.12), rail);
      let vent = fillSd(sdRect(vec2f(lx + 9.0, ly), vec2f(1.6, 0.7), 0.1), px);
      s.color *= 1.0 - vent * (0.5 + 0.3 * stripe(lx * 5.0, 0.25, px * 5.0));
      s.color = mix(s.color, vec3f(0.08, 0.09, 0.11), label7(vec2f(lx, ly), vec2f(-23.0, -1.6), vec2f(-17.0, 1.6), 1.0, k + 1.0, 2, px));
      s.color = mix(s.color, col, ld.x);
      s.emissive = ld.x * (on * 30.0 + 1.0) * ld.y + port.x * port.y * 3.0;
    }
  } else if (m == MAT_HUB) {
    let ub = fract(s.uv.x - s.t / SPIN);
    let X = ub * 24.0; let fX = fwU.x * 24.0;
    let tint = mix(1.0, select(0.78, 1.0, fract(X * 0.5) < 0.5), saturate(1.0 - fX));
    s.color *= tint * (1.0 - 0.4 * (1.0 - stripe(X, 0.5 - 0.02, fX)));
    let lx = (fract(ub * 6.0 + 0.5) - 0.5) * 39.8;
    let ld = lampDot(abs(lx), 1.2, px) * stripe(s.uv.y * 6.0, 0.25, fwU.y * 6.0);
    // on the collar's outer drum (the third piece of its profile): two rows of
    // lit windows, and an airlock half way between each pair of spokes
    let sg = s.uv.y * 6.0;
    if (sg > 2.0 && sg < 3.0) {
      let zm = (sg - 2.0) * 26.0 - 13.0;
      let am = ub * 238.8;
      let win = stripe(am / 3.0, 0.2, px / 3.0) * fillSd(abs(abs(zm) - 6.0) - 0.9, px) * step(4.5, abs(lx)) * step(abs(lx), 16.5);
      let h = hash11(floor(am / 3.0) + step(0.0, zm) * 97.0);
      s.color = mix(s.color, mix(vec3f(1.0, 0.78, 0.48), vec3f(0.75, 0.88, 1.0), step(0.75, h)), win);
      s.emissive += win * select(2.0, 0.2, h < 0.15);
      let hd = sdRect(vec2f(19.9 - abs(lx), zm), vec2f(1.0, 1.5), 0.45);
      s.color *= (1.0 - 0.6 * lineSd(hd, 0.04, px)) * (1.0 - 0.1 * fillSd(hd, px));
      s.color = mix(s.color, vec3f(0.85, 0.65, 0.12), lineSd(abs(19.9 - abs(lx)) - 1.7, 0.04, px) * step(abs(zm), 1.6));
    }
    s.color = mix(s.color, vec3f(0.35, 0.85, 1.0), ld.x);
    s.emissive = max(s.emissive, ld.x * 12.0 * ld.y);
  } else if (m == MAT_SPOKE) {
    // light rings running outward along the spokes
    let y = s.uv.y * 19.0;
    let band = stripe(y, 0.05, fwU.y * 19.0);
    let on = step(0.8, fract(floor(y) / 5.0 - s.t * 0.5));
    s.color = mix(s.color, vec3f(0.35, 0.85, 1.0), band * (0.3 + 0.7 * on));
    s.emissive = band * (on * 9.0 + 0.15);
    // two handrails along the spoke
    let hr = stripe(s.uv.x * 2.0 + 0.25, 0.012, fwU.x * 2.0);
    s.color = mix(s.color, vec3f(0.85, 0.65, 0.12), hr * (1.0 - band));
  } else if (m == MAT_BLOCK) {
    s.color = blockSkin(s.uv * 8.0, s.tag & 3u, (s.tag & 4u) != 0u, f32(s.tag >> 5u), s.color, px, s.t);
  } else if (m == MAT_SOLAR) {
    // cells in a light grid, each cut in four with thin silver lines, and a
    // busbar every sixth row
    let cell = stripe(s.uv.x, 0.44, fwU.x) * stripe(s.uv.y, 0.42, fwU.y);
    let sub = 1.0 - 0.6 * seams(s.uv * 2.0, vec2f(1.0), 0.012, max(fwU.x, fwU.y) * 2.0);
    let bus = 1.0 - stripe(s.uv.y / 6.0, 0.5 - 0.06 / 6.0, fwU.y / 6.0);
    s.color = mix(vec3f(0.5, 0.52, 0.56), vec3f(0.012, 0.03, 0.085) * (0.8 + 0.4 * hash21(floor(s.uv))), cell * sub);
    s.color = mix(s.color, vec3f(0.62, 0.55, 0.38), bus);
    s.gloss = mix(0.3, 0.72, cell);
  } else if (m == MAT_RADIATOR) {
    // radiator panels: coolant tubes in a frame, headers top and bottom
    let tubes = stripe(s.uv.x * 40.0, 0.12, fwU.x * 40.0);
    let frame = seams(s.uv * vec2f(4.0, 5.0), vec2f(1.0), 0.012, max(fwU.x * 4.0, fwU.y * 5.0));
    let header = 1.0 - stripe(s.uv.y, 0.47, fwU.y);
    s.color *= (1.0 - 0.25 * tubes) * (1.0 - 0.45 * frame);
    s.color = mix(s.color, vec3f(0.55, 0.57, 0.6), header);
    s.gloss = mix(s.gloss, 0.7, tubes);
  } else if (m == MAT_PORT) {
    // a docking port: a striped seal ring, the hatch with its bolts and
    // handles, a target cross and a lamp that shows when it is free
    let q = (s.uv - 0.5) * 2.0;
    let r = length(q);
    let pr = px * 2.0 / s.aux;
    let ang = atan2(q.y, q.x);
    let ring = step(0.8, r) * step(r, 0.96);
    s.color = mix(s.color, mix(vec3f(0.03), vec3f(0.9, 0.62, 0.05), step(0.5, fract(ang / TAU * 16.0))), ring);
    s.color *= 1.0 - 0.7 * lineSd(r - 0.62, 0.025, pr);
    let bolt = lineSd(length(vec2f(r - 0.7, fract(ang / TAU * 12.0 + 0.5) - 0.5)), 0.03, pr);
    s.color *= 1.0 - 0.6 * bolt;
    let cross = min(abs(q.x), abs(q.y));
    s.color *= 1.0 - 0.7 * lineSd(cross, 0.02, pr) * step(r, 0.5) * step(0.1, r);
    let hd = fillSd(sdRect(vec2f(abs(q.x) - 0.38, q.y), vec2f(0.035, 0.12), 0.03), pr);
    s.color = mix(s.color, vec3f(0.85, 0.65, 0.1), hd);
    let ld = lampDot(r, 0.06, pr);
    let free = step(0.5, fract(s.t / 3.0));
    s.color = mix(s.color, mix(vec3f(1.0, 0.2, 0.1), vec3f(0.2, 1.0, 0.35), free), ld.x);
    s.emissive = ld.x * ld.y * 10.0;
  } else if (m == MAT_CLOCK) {
    let on = clock7((s.uv - vec2f(0.05, 0.14)) / vec2f(0.9, 0.72), s.t);
    s.color = mix(vec3f(0.01, 0.012, 0.016), vec3f(1.0, 0.6, 0.14), on);
    s.emissive = on * 7.0;
    s.gloss = 0.5;
  } else if (m == MAT_SPINCOUNT || m == MAT_CARGO || (m >= MAT_DIST && m < MAT_DIST + 60u)) {
    var value = 0.0;
    var digits = 4;
    var col = vec3f(0.35, 0.85, 1.0);
    if (m == MAT_SPINCOUNT) { value = floor(s.t / SPIN); }
    else if (m == MAT_CARGO) { value = floor(s.t / 2.0); digits = 5; col = vec3f(1.0, 0.6, 0.14); }
    else { value = f32(m - MAT_DIST) * 100.0; }
    let on = number7((s.uv - vec2f(0.05, 0.14)) / vec2f(0.9, 0.72), value, digits);
    s.color = mix(vec3f(0.01, 0.012, 0.016), col, on);
    s.emissive = on * 7.0;
    s.gloss = 0.5;
  } else if (m == MAT_ROCK || m == MAT_MOON) {
    let sc = select(0.035, 0.012, m == MAT_MOON);
    let n1 = fbm3(s.pos * sc);
    let n2 = noise3(s.pos * sc * 12.0);
    s.color *= 0.4 + 0.95 * n1 + 0.2 * (n2 - 0.5);
    let big = select(18.0, 70.0, m == MAT_MOON);
    let fade = saturate(2.0 - px / big * 12.0);
    if (fade > 0.0) {
      let c1 = craters(s.pos, s.n, big, 0.45);
      let c2 = craters(s.pos + 31.7, c1.xyz, big * 0.33, 0.5);
      s.n = normalize(mix(s.n, c2.xyz, fade));
      s.color *= 1.0 - (c1.w + c2.w * 0.7) * fade;
    }
  } else if (m == MAT_ROCKD) {
    s.color *= 0.45 + 0.9 * fbm2(s.uv * vec2f(5.0, 3.0));
  } else if (m == MAT_GATE) {
    // pulses chasing round the gate ring
    let x = fract(s.uv.x * 3.0 - s.t * 0.9);
    let pulse = pow(x, 14.0);
    s.color = vec3f(0.4, 0.85, 1.0);
    s.emissive = 0.5 + pulse * 22.0;
  } else if (m == MAT_RAIL) {
    let x = fract(s.uv.y * 8.0 - s.t * 2.0);
    s.color = vec3f(1.0, 0.62, 0.2);
    s.emissive = 0.4 + pow(x, 10.0) * 16.0;
  } else if (m == MAT_BLINK) {
    let on = step(fract(s.t * 0.75), 0.1);
    s.emissive = on * 26.0 + 0.4;
  } else if (m == MAT_WINDOWS) {
    // a lit room behind every pane: a ceiling light, a few dark or bluish rooms, a frame
    let win = stripe(s.uv.x, 0.3, fwU.x) * stripe(s.uv.y, 0.3, fwU.y);
    let frame = stripe(s.uv.x, 0.36, fwU.x) * stripe(s.uv.y, 0.36, fwU.y) - win;
    let h = hash21(floor(s.uv) + 0.37);
    let room = mix(vec3f(1.0, 0.78, 0.48), vec3f(0.72, 0.86, 1.0), step(0.78, h));
    let ceil = 0.55 + 0.9 * smoothstep(0.3, 0.75, fract(s.uv.y)) * saturate(1.5 - fwU.y * 3.0);
    let on = select(1.0, 0.12, h < 0.1);
    s.color = mix(s.color * (1.0 - 0.6 * frame), room, win);
    s.emissive = win * 4.0 * on * mix(1.0, ceil, 0.8);
  } else if (m == MAT_SHIP || m == MAT_TUG) {
    let sc = select(4.0, 8.0, m == MAT_TUG);
    let part = (s.tag >> 3u) & 3u;
    let sk = shuttleSkin(s.uv * sc, s.tag & 3u, (s.tag & 4u) != 0u, select(part, part + 4u, m == MAT_TUG), f32(s.tag >> 5u), s.color, px);
    s.color = sk.rgb;
    s.emissive = max(s.emissive, sk.w);
  } else if (m == MAT_CANOPY) {
    // cockpit glazing: four panes in a dark frame, lit from inside
    let u = s.uv.x * 4.0;
    let pane = stripe(u, 0.42, fwU.x * 4.0) * stripe(s.uv.y, 0.36, fwU.y);
    s.color = mix(vec3f(0.06, 0.065, 0.075), s.color * (0.55 + 0.6 * s.uv.y), pane);
    s.emissive *= pane * (0.6 + 0.6 * (1.0 - s.uv.y));
    s.gloss = mix(0.35, 0.95, pane);
  } else if (m == MAT_LENS) {
    // Fresnel rings on a beacon's lens
    s.emissive *= 0.65 + 0.7 * stripe(s.uv.y * 9.0, 0.3, fwU.y * 9.0);
  } else if (m == MAT_CNT) {
    s.color = containerSkin(s.uv * 10.0, vec2f(10.0), s.tag & 7u, f32(s.tag >> 3u), s.color, px, true);
  } else if (m == MAT_GLOW) {
    // additive glows fade towards their silhouette, so a sphere becomes a soft halo
    let k = abs(dot(s.n, s.view));
    s.emissive *= k * k * k * 1.5;
  } else if (m == MAT_CONTAINER) {
    // the depot's racks: 18 by 6 by 6 m boxes, numbered by the copy
    let kind = s.tag & 7u;
    let sz = select(vec2f(18.0, 6.0), vec2f(6.0), kind == 1u || kind == 2u);
    s.color = containerSkin(s.uv * sz, sz, kind, s.inst.w, s.color, px, false);
  } else if (m == MAT_FOIL) {
    // gold foil, crinkled, in panels
    s.color *= (0.7 + 0.6 * noise2(s.uv * vec2f(7.0, 9.0))) * (1.0 - 0.35 * seams(s.uv * 3.0, vec2f(1.0), 0.01, max(fwU.x, fwU.y) * 3.0));
  }
  return s;
}
`;

// ---------------------------------------------------------------------------
// Geometry helpers

// A box from point a to point b with a w x h cross-section.
function beam(a, b, w, h = w) {
  const d = v3.sub(b, a), len = v3.len(d);
  const up = Math.abs(d[2]) > 0.98 * len ? [1, 0, 0] : [0, 0, 1];
  return Geo.box(w, len, h).transform(m4.facing(v3.lerp(a, b, 0.5), d, up));
}

// A square lattice truss from a to b.
function truss(a, b, w, step, thick = 0.5) {
  const g = new Geo();
  const d = v3.sub(b, a), len = v3.len(d), fwd = v3.norm(d);
  const r = v3.norm(v3.cross(fwd, Math.abs(fwd[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1]));
  const u = v3.cross(r, fwd);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => v3.add(v3.scale(r, x * w / 2), v3.scale(u, y * w / 2)));
  for (const c of corners) g.add(beam(v3.add(a, c), v3.add(b, c), thick));
  const n = Math.max(1, Math.round(len / step));
  for (let i = 0; i < n; i++) {
    const p0 = v3.add(a, v3.scale(d, i / n)), p1 = v3.add(a, v3.scale(d, (i + 1) / n));
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k], c1 = corners[(k + 1) % 4];
      g.add(i % 2 ? beam(v3.add(p0, c1), v3.add(p1, c0), thick * 0.6) : beam(v3.add(p0, c0), v3.add(p1, c1), thick * 0.6));
      if (i < n - 1) g.add(beam(v3.add(p1, c0), v3.add(p1, c1), thick * 0.6));
    }
  }
  return g;
}

// A hull outline given as a side profile [[y, z], ...] (y forward), extruded across x.
function sideHull(prof, width) {
  return Geo.extrude(prof, width).transform(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [-width / 2, 0, 0]));
}

// Colour faded by k.  Never exactly black: Firefox shows a black vertex colour
// on additive geometry as a bright white outline.
const fadeCol = (rgb, k) => rgb.map((c) => Math.max(c * k, 0.012));

const lamp = (r, col, e) => Geo.sphere(r, 6, 3).color(col).emissive(e);
const navLight = (r, col, e = 18) => Geo.sphere(r, 4, 2).color(col).emissive(e);

// A lumpy rock: a sphere pushed in and out by a few broad bumps, flat shaded.
function hash3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k, seed);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

function rockGeo(r, seed, { seg = 10, rings = 7, rough = 0.32, squash = [1, 1, 1], crag = 0.12, smooth = false } = {}) {
  const R = rng(seed);
  const g = Geo.sphere(1, seg, rings);
  const bumps = [];
  for (let i = 0; i < 9; i++) bumps.push([v3.norm([R() * 2 - 1, R() * 2 - 1, R() * 2 - 1]), R.range(-1, 1) * rough, R.range(0.3, 0.8)]);
  for (let i = 0; i < g.p.length; i += 3) {
    const d = v3.norm([g.p[i], g.p[i + 1], g.p[i + 2]]);
    let s = 1;
    for (const [c, a, w] of bumps) s += a * Math.exp(-(1 - v3.dot(d, c)) / (w * w));
    s += crag * ((noise3(d[0] * 3, d[1] * 3, d[2] * 3, seed) - 0.5) + 0.5 * (noise3(d[0] * 7, d[1] * 7, d[2] * 7, seed + 1) - 0.5));
    g.p[i] = d[0] * s * r * squash[0]; g.p[i + 1] = d[1] * s * r * squash[1]; g.p[i + 2] = d[2] * s * r * squash[2];
  }
  return g.computeNormals(!smooth ? false : true);
}

// A closed racetrack loop: straight from a to b on one side, round b, back on
// the other side and round a.  Travel along the first straight goes from a to b.
// Returns the path and the distances of the two turn apexes (beyond b, beyond a).
function racetrack(a, b, w, up = [0, 0, 1], arcSteps = 32) {
  const fwd = v3.norm(v3.sub(b, a));
  const side = v3.norm(v3.cross(fwd, up));
  const len = v3.dist(a, b);
  const pts = [];
  const arc = (c, a0, a1) => {
    for (let i = 0; i <= arcSteps; i++) {
      const ang = a0 + (a1 - a0) * i / arcSteps;
      pts.push(v3.add(c, v3.add(v3.scale(side, w * Math.cos(ang)), v3.scale(fwd, w * Math.sin(ang)))));
    }
  };
  arc(b, 0, Math.PI);
  arc(a, Math.PI, 2 * Math.PI);
  pts.pop(); // the loop closes itself
  // rotate the list so that it starts at the beginning of the a -> b straight
  const path = new Path([v3.add(a, v3.scale(side, w)), ...pts], { closed: true });
  return { path, apexB: len + w * Math.PI / 2, apexA: 2 * len + w * Math.PI * 1.5, side, fwd, len };
}

// Distance travelled along a closed loop of length L at time t, for a vehicle
// that goes round `laps` times per period and stops at the given distances for
// `dwell` seconds each, easing in and out of every stop over `ramp` seconds.
function schedule(L, stops, { laps = 1, ramp = 4 } = {}) {
  const T = PERIOD / laps;
  const ss = stops.slice().sort((p, q) => p.d - q.d);
  const n = ss.length;
  const dwellSum = ss.reduce((acc, s) => acc + s.dwell, 0);
  const v = L / (T - dwellSum - n * ramp);
  const segs = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = ss[i], next = ss[(i + 1) % n];
    const len = n === 1 ? L : ((next.d - s.d) % L + L) % L;
    segs.push({ t0: t, t1: t + s.dwell, d0: s.d, len: 0, dwell: true });
    t += s.dwell;
    const dur = len / v + ramp;
    segs.push({ t0: t, t1: t + dur, d0: s.d, len, dwell: false });
    t += dur;
  }
  const ease = (x) => v / 2 * (x - ramp / Math.PI * Math.sin(Math.PI * x / ramp));
  return (time) => {
    const lap = Math.floor(time / T);
    const u = time - lap * T;
    for (const g of segs) {
      if (u <= g.t1) {
        if (g.dwell) return lap * L + g.d0;
        const x = u - g.t0, D = g.t1 - g.t0;
        let dist;
        if (x < ramp) dist = ease(x);
        else if (x > D - ramp) dist = g.len - ease(D - x);
        else dist = v * ramp / 2 + v * (x - ramp);
        return lap * L + g.d0 + dist;
      }
    }
    return (lap + 1) * L + segs[0].d0;
  };
}

// Transform for a model (+Y forward, +Z up) moved along a path by a distance function.
const along = (path, distAt, span = 8) => (t) => {
  const { p, dir } = path.smoothAt(distAt(t), span);
  return m4.facing(p, dir);
};

// Static beacon with a running light: a dim housing that is always there, a
// bright flash for BEACON_ON seconds starting at `phase` (every `every`
// seconds) and a fading afterglow for BEACON_AFTER seconds.  There are over
// three hundred of them, so they are not added one by one but collected in
// `list` and drawn as copies of two meshes (addBeacons): the housings, and the
// lamps, whose flashes are holes in time cut by the `cutout` hook.  Every copy
// takes its colour from its tint, so all the lanes share the two meshes.
const beaconHousing = Geo.sphere(0.72, 4, 2).color('#ffffff').emissive(1.6);
const beaconLamp = Geo.merge(
  Geo.sphere(1, 6, 3).emissive(13).tag(0),        // the flash
  Geo.sphere(0.95, 6, 3).emissive(3.5).tag(1),    // the afterglow
).color('#ffffff').mat(MAT.BEACON).cutout();

function beacon(list, pos, phase, every, color, { r = 1.8 } = {}) {
  const ph = ((phase % every) + every) % every;
  const transform = m4.mul(m4.translation(...pos), m4.scaling(r));
  list.housings.push({ transform, tint: color });
  list.lamps.push({ transform, tint: color, data: ph + 8 * every });
}

// Seen from near by a beacon is a buoy: a ribbed lens inside the lamp, a band
// and four struts round it, a cap with an aerial, and a base with two small
// solar fins.  Only the lens takes the lane's colour.
const beaconDetail = (() => {
  const metal = '#5f656e';
  const g = new Geo();
  g.add(Geo.sphere(0.76, 10, 5).color('#ffffff').emissive(1.6).gloss(0.8).mat(MAT.LENS));
  const parts = new Geo();
  parts.add(Geo.cylinder(1.07, 0.14, 12, { caps: false }).translate(0, 0, -0.07));
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4, c = Math.cos(a), sn = Math.sin(a);
    const P = (r, z) => [r * c, r * sn, z];
    const w = [-sn * 0.035, c * 0.035, 0];
    const strip = (p0, p1) => Geo.quad(v3.sub(p0, w), v3.add(p0, w), v3.add(p1, w), v3.sub(p1, w)).doubleSided();
    parts.add(strip(P(1.07, 0.07), P(0.8, 0.75)));
    parts.add(strip(P(0.8, 0.75), P(0.3, 1.04)));
    parts.add(strip(P(1.07, -0.07), P(0.8, -0.75)));
    parts.add(strip(P(0.8, -0.75), P(0.45, -1.0)));
  }
  parts.add(Geo.cone(0.34, 0.25, 8).translate(0, 0, 0.98));
  parts.add(Geo.merge(Geo.triangle([-0.03, 0, 1.2], [0.03, 0, 1.2], [0, 0, 2.3]), Geo.triangle([0, -0.03, 1.2], [0, 0.03, 1.2], [0, 0, 2.3])).doubleSided());
  parts.color(metal);
  parts.add(Geo.lathe([[0.01, -1.9], [0.32, -1.9], [0.46, -1.76], [0.46, -1.1], [0.56, -1.0], [0.2, -0.88]], 6, { smooth: false }).color('#7a8089'));
  for (const sx of [-1, 1]) parts.add(Geo.box(0.9, 0.03, 0.42).translate(sx * 0.95, 0, -1.45).color('#ffffff').mat(MAT.SOLAR));
  g.add(parts.untinted());
  return g;
})();

function addBeacons(b, list) {
  b.instances(beaconHousing, list.housings);
  b.instances(beaconDetail, list.housings, { within: 80, solid: false });
  // (the lamps are only there part of the time, so they are not solid, as
  // anything with a time window is not)
  b.instances(beaconLamp, list.lamps, { solid: false });
}

// ---------------------------------------------------------------------------
// Vehicles (all modelled with +Y forward and +Z up)

// What the hull shaders (shuttleSkin, containerSkin) are told about a flat
// mesh, in model coordinates: uv = the two coordinates across each face, in
// units of `scale` metres, and a tag: bits 0-1 which way the face looks (0
// side, 1 top or bottom, 2 front or back), bit 2 set for -x, -z or -y, bits
// 3-4 which part of the ship it is, bits 5-7 which ship.  Patterns painted
// from these cost no triangles, which matters on anything that moves.
function hullUV(g, scale, part, id) {
  for (let i = 0; i < g.vertexCount; i++) {
    const n = g.n.slice(i * 3, i * 3 + 3), p = g.p.slice(i * 3, i * 3 + 3), a = n.map(Math.abs);
    let fam, neg, u, v;
    if (a[0] >= a[1] && a[0] >= a[2]) { fam = 0; neg = n[0] < 0; u = p[1]; v = p[2]; }
    else if (a[2] >= a[1]) { fam = 1; neg = n[2] < 0; u = p[1]; v = p[0]; }
    else { fam = 2; neg = n[1] < 0; u = p[0]; v = p[2]; }
    g.uv[i * 2] = u / scale; g.uv[i * 2 + 1] = v / scale;
    g.x[i * 2 + 1] = fam + (neg ? 4 : 0) + part * 8 + id * 32;
  }
  return g;
}

// A container's faces for containerSkin: kind (0 side, 1 front end, 2 door
// end, 3 roof or floor) in bits 0-2 and a serial number in bits 3-7.
function containerTags(g, serial) {
  const kinds = [0, 0, 1, 2, 3, 3]; // Geo.box's faces: +x, -x, +y, -y, +z, -z
  for (let i = 0; i < g.vertexCount; i++) g.x[i * 2 + 1] = kinds[Math.floor(i / 4)] + serial * 8;
  return g;
}

const SHIP_SCALE = 4, TUG_SCALE = 8; // metres per unit of uv (MAT.SHIP, MAT.TUG)

function shuttle(accent, id) {
  const g = new Geo();
  const ship = (geo, part) => hullUV(geo, SHIP_SCALE, part, id).mat(MAT.SHIP);
  const prof = [[-9, -1.5], [5, -1.5], [9.5, -0.6], [10.5, 0.4], [7.5, 1.9], [-8, 2.1], [-9.5, 1.0]];
  g.add(ship(sideHull(prof, 5.6), 0).color('#d9dbe0').gloss(0.35));
  g.add(ship(Geo.box(5.75, 10, 0.6).translate(0, -1.5, -0.3), 1).color(accent));
  g.add(Geo.box(5.8, 7, 0.8).translate(0, 0.5, 0.9).mat(MAT.WINDOWS).uvTransform(6, 1).color('#26303a'));
  g.add(Geo.box(3.8, 0.4, 1.0).rotateX(-0.75).translate(0, 8.95, 1.2).color('#a8dcff').emissive(2.5).gloss(0.9).mat(MAT.CANOPY));
  g.add(ship(Geo.box(13, 3.2, 0.35).translate(0, -5.5, -0.6), 2).color('#9aa0a8'));
  g.add(ship(Geo.box(0.35, 3.5, 2.6).translate(0, -7, 3.1), 1).color(accent));
  g.add(ship(Geo.box(4.4, 2.6, 2.4).translate(0, -10.2, 0.2), 3).color('#4a4f57'));
  g.add(engineDiscs(-11.52, 0.5));
  g.add(navLight(0.35, '#ff2a1a').translate(-6.5, -5.5, -0.6));
  g.add(navLight(0.35, '#22ff66').translate(6.5, -5.5, -0.6));
  g.add(navLight(0.3, '#ffffff', 1).mat(MAT.BLINK).translate(0, -7.5, 4.5));
  return g;
}

// The exhaust and the glow in the engines, kept apart from the hull so that
// addShuttle can change them with the shuttle's speed: the plume is scaled,
// and the bright discs slide out of the engine block when it is under way and
// back into it, behind the dim discs that are part of the hull, when it stops.
// All three are stored once for all the shuttles: the discs as they are, the
// plume as the six poses of its flicker (see FLICKER).
const SHUTTLE_TAIL = [0, -11.6, 0.2];
const engineDiscs = (y, e) => Geo.merge(...[-1.15, 1.15].map((x) => Geo.disc(0.78, 6).rotateX(Math.PI / 2).translate(x, y, 0.2))).color('#bfe6ff').emissive(e);
const shuttleFires = () => engineDiscs(-11.6, 16);
const shuttlePlume = () => Geo.cylinder(1.6, 9, 6, { r2: 0.2, caps: false }).rotateX(Math.PI / 2).translate(...SHUTTLE_TAIL)
  .color([0.3, 0.55, 1.0]).emissive(4).additive().mat(MAT.GLOW);
const SHUTTLE_PLUME = shuttlePlume(), SHUTTLE_FIRES = shuttleFires(); // one of each for all the shuttles

// The exhaust plumes of the shuttles and the tugs flicker: a round of a
// quarter of a second in six poses, in each of which the plume is a little
// brighter or dimmer (by the first number) and longer or shorter (by the
// second) than it is.  The glow in the engines stays steady.  Every engine
// has its own start, so no two flicker together.
const FLICKER = [[1, 1], [0.8, 0.93], [1.15, 1.05], [0.88, 0.96], [1.08, 1.02], [0.74, 0.91]];
const flicker = (tail, emissive, start) => {
  const at = (u) => FLICKER[Math.round(u * FLICKER.length) % FLICKER.length];
  return {
    period: 0.24, keys: FLICKER.length, start,
    transform: (u) => m4.mul(m4.translation(...tail), m4.scaling(1, at(u)[1], 1), m4.translation(...tail.map((v) => -v))),
    paint: (u) => ({ emissive: emissive * at(u)[0] }),
  };
};

// Small parts seen only from near by: the engine bells, two aerials, the
// hatch collar and the thruster blocks by the nose.
function shuttleDetail() {
  const g = new Geo();
  for (const x of [-1.15, 1.15]) {
    g.add(Geo.cylinder(0.8, 1.05, 6, { r2: 1.02, caps: false }).rotateX(Math.PI / 2).translate(x, -11.45, 0.2).color('#2c2f34').gloss(0.55));
  }
  const whip = (base, tip, w) => Geo.merge(
    Geo.triangle(v3.add(base, [-w, 0, 0]), v3.add(base, [w, 0, 0]), tip),
    Geo.triangle(v3.add(base, [0, -w, 0]), v3.add(base, [0, w, 0]), tip),
  ).doubleSided().color('#33373d');
  g.add(whip([1.5, 2.6, 1.9], [1.5, 1.2, 3.9], 0.05));
  g.add(whip([-1.5, -2.5, -1.45], [-1.5, -3.6, -2.5], 0.04));
  // the collar round the roof hatch, and thruster blocks on the painted pads
  g.add(Geo.cylinder(0.95, 0.22, 8, { caps: false }).translate(0, -1.8, 1.98).color('#9aa0a8').gloss(0.4));
  for (const x of [-2.86, 2.86]) g.add(Geo.box(0.12, 0.42, 0.28).translate(x, 8.6, 0.6).color('#3a3f46'));
  return g;
}

const SHUTTLE_DETAIL = shuttleDetail(); // (one mesh for all of them)

// Detail that rides on a moving object whose keys are `times`.  Its keys are
// the object's own, with any interval longer than `span` metres cut into
// pieces by interpolating between them (the object's vertices move in
// straight lines between its keys, so the detail stays exactly where it
// belongs), and it is added as runs of keys no more than `span` apart, each a
// call of its own: `within` is measured to the box of a run, and a run that
// went a long way would be drawn from far away.  (This costs a few keys more
// than one call with the object's own keys would.)  `more`: further options
// for every call, such as a cycle.
function addRiding(b, geo, times, tf, within, span, more = {}) {
  const mats = new Map(times.map((t) => [t, tf(t)]));
  const pos = (t) => { const m = mats.get(t); return [m[12], m[13], m[14]]; };
  const keys = [times[0]];
  for (let i = 1; i < times.length; i++) {
    const t0 = times[i - 1], t1 = times[i], m0 = mats.get(t0), m1 = mats.get(t1);
    const n = Math.ceil(v3.dist(pos(t0), pos(t1)) / span);
    for (let k = 1; k < n; k++) {
      const t = t0 + (t1 - t0) * k / n;
      mats.set(t, m0.map((v, j) => v + (m1[j] - v) * k / n));
      keys.push(t);
    }
    keys.push(t1);
  }
  const transform = (t) => mats.get(t);
  for (let start = 0; start < keys.length - 1;) {
    let end = start + 1;
    while (end + 1 < keys.length && v3.dist(pos(keys[start]), pos(keys[end + 1])) <= span) end++;
    b.dynamic(geo, { times: keys.slice(start, end + 1), transform, caps: 'none', within, ...more });
    start = end;
  }
}

// A shuttle on its way: the hull, the exhaust scaled by speed, and the detail.
function addShuttle(b, accent, id, tf, distAt) {
  const times = adaptiveTimes(tf, 0, PERIOD, { size: 10, tolerance: 0.3, maxStep: 8 });
  // The exhaust is full length and the engines full bright at 60 m/s and
  // more; standing still, a stub and a dim glow.
  const thrust = (t) => Math.min(1, Math.abs(distAt(t + 0.05) - distAt(t - 0.05)) / 0.1 / 60);
  b.dynamic(shuttle(accent, id), { times, transform: tf, caps: 'none' });
  const plume = (t) => {
    const k = thrust(t);
    return m4.mul(tf(t), m4.translation(...SHUTTLE_TAIL), m4.scaling(0.25 + 0.75 * k, 0.04 + 0.96 * k, 0.25 + 0.75 * k), m4.translation(...SHUTTLE_TAIL.map((v) => -v)));
  };
  b.dynamic(SHUTTLE_PLUME, { times, transform: plume, caps: 'none', cycle: flicker(SHUTTLE_TAIL, 4, id * 0.093) });
  // (from a third of full thrust up the bright discs are out in front of the
  // dim ones; below that they are behind them or inside the engine block)
  const fires = (t) => m4.mul(tf(t), m4.translation(0, 0.12 * (1 - thrust(t)), 0));
  b.dynamic(SHUTTLE_FIRES, { times, transform: fires, caps: 'none' });
  addRiding(b, SHUTTLE_DETAIL, times, tf, 90, 500);
}

// The tug's engine bell, radar mast and grapples, seen only from near by.
const RADAR_AT = [4.0, 24.2, 10.5]; // the top of the mast
function freighterDetail() {
  const g = new Geo();
  g.add(Geo.cylinder(3.35, 3.2, 8, { r2: 4.3, caps: false }).rotateX(Math.PI / 2).translate(0, -32.9, 0).color('#2c2f34').gloss(0.5));
  g.add(Geo.merge(
    Geo.triangle([3.9, 25.2, 5.3], [4.1, 25.2, 5.3], RADAR_AT),
    Geo.triangle([4.0, 25.1, 5.3], [4.0, 25.3, 5.3], RADAR_AT),
  ).doubleSided().color('#33373d'));
  g.add(Geo.box(0.36, 0.36, 0.4).translate(RADAR_AT[0], RADAR_AT[1], RADAR_AT[2] + 0.1).color('#33373d'));
  g.add(Geo.box(0.5, 0.5, 0.2).translate(RADAR_AT[0], RADAR_AT[1], RADAR_AT[2] + 0.4).color('#4a4f57'));
  // the grapples: a band over the middle of each container and down both
  // sides, standing a hand's breadth off it (over the painted strap)
  for (let i = 0; i < 4; i++) {
    const y = 13 - i * 11.5, h = 5.15, w = 0.35;
    const P = (x, z, dy) => [x, y + dy, z];
    const band = new Geo();
    band.add(Geo.quad(P(-h, h, -w), P(h, h, -w), P(h, h, w), P(-h, h, w)));
    for (const x of [-h, h]) band.add(Geo.quad(P(x, 1.5, -w), P(x, h, -w), P(x, h, w), P(x, 1.5, w)));
    g.add(band.doubleSided().color('#6d6450').gloss(0.4));
  }
  return g;
}

const FREIGHTER_DETAIL = freighterDetail();

// The radar on top of the mast: a bar on the turntable, turning once every
// three seconds (clockwise seen from above), a pose every 20 degrees.  It
// rides with the rest of the detail, on the very same keys.
const TUG_RADAR = Geo.box(5, 0.28, 0.55).translate(0, 0.08, 0.8).color('#e4e4de').gloss(0.3);
const tugRadar = (start) => ({
  cycle: { period: 3, keys: 18, start, transform: (u) => m4.mul(m4.translation(...RADAR_AT), m4.rotationZ(-TAU * u)) },
});

// The tug's exhaust, apart from the rest so that it can flicker (see FLICKER).
const TUG_TAIL = [0, -33.1, 0];
const TUG_PLUME = Geo.cylinder(4.5, 22, 6, { r2: 0.6, caps: false }).rotateX(Math.PI / 2).translate(...TUG_TAIL)
  .color([0.3, 0.55, 1.0]).emissive(3).additive().mat(MAT.GLOW);

function freighter(colors, id) {
  const g = new Geo();
  const tug = (geo, part) => hullUV(geo, TUG_SCALE, part, id).mat(MAT.TUG);
  g.add(tug(Geo.box(3, 50, 3), 1).color('#5d636b'));
  g.add(tug(sideHull([[22, -4.5], [30, -4.5], [33.5, -1.5], [33, 3], [26, 5.5], [21, 5.5]], 12), 0).color('#cfd2d6').gloss(0.3));
  g.add(Geo.box(12.1, 4, 1.4).translate(0, 29.5, 2.2).mat(MAT.WINDOWS).uvTransform(6, 1).color('#22303a'));
  colors.forEach((c, i) => {
    g.add(containerTags(Geo.box(10, 10, 10), id * 4 + i).translate(0, 13 - i * 11.5, 0).color(c).mat(MAT.CNT));
  });
  g.add(tug(Geo.box(18, 5, 0.4).translate(0, -24, 0), 2).color('#a9adb3'));
  g.add(tug(Geo.box(11, 8, 9).translate(0, -29, 0), 3).color('#474c54'));
  g.add(Geo.disc(3.2, 8).rotateX(Math.PI / 2).translate(0, -33.05, 0).color('#c2e4ff').emissive(14));
  g.add(navLight(0.6, '#ff2a1a').translate(-9, -24, 0));
  g.add(navLight(0.6, '#22ff66').translate(9, -24, 0));
  g.add(navLight(0.5, '#ffffff', 1).mat(MAT.BLINK).translate(0, 26, 6.2));
  return g;
}

function satellite(accent) {
  const g = new Geo();
  g.add(Geo.box(3, 3, 3.6).color('#c9a227').gloss(0.7).mat(MAT.FOIL));
  g.add(Geo.box(15, 2.6, 0.2).color('#1b2a55').gloss(0.7).mat(MAT.SOLAR).uvTransform(16, 3));
  g.add(Geo.cone(1.4, 1.2, 6).rotateY(Math.PI / 2).translate(1.5, 0, 1.0).color('#e6e6e6'));
  g.add(Geo.box(0.3, 0.3, 3).translate(0, 0, 3).color(accent));
  g.add(navLight(0.45, '#ff3a2a', 1).mat(MAT.BLINK).translate(0, 0, 4.6));
  return g;
}

// ---------------------------------------------------------------------------
// Station (built in station-local coordinates, axis = local z)

// solar wings turned about their truss to face the sun
const WING_TILT = Math.atan2(-v3.dot(SUN_DIR, AX), -v3.dot(SUN_DIR, YL));
const R_IN = 188, R_OUT = 212, R_H = 11, R_CH = 4, RING_SEG = 144;

function stationStatic(b) {
  const tf = { transform: STATION };
  // habitat ring: one lathe per face so that every face has its own material
  const face = (p0, p1, mat, color) => Geo.lathe([p0, p1], RING_SEG, { smooth: false }).color(color).mat(mat).gloss(0.25);
  const ring = new Geo();
  ring.add(face([R_IN + R_CH, -R_H], [R_OUT - R_CH, -R_H], MAT.RING_SIDE, '#a9adb4'));
  ring.add(face([R_OUT - R_CH, R_H], [R_IN + R_CH, R_H], MAT.RING_SIDE, '#a9adb4'));
  ring.add(face([R_OUT, -R_H + R_CH], [R_OUT, R_H - R_CH], MAT.RING_OUTER, '#9ea3ab'));
  ring.add(face([R_IN, R_H - R_CH], [R_IN, -R_H + R_CH], MAT.RING_INNER, '#7f858e'));
  ring.add(face([R_OUT - R_CH, -R_H], [R_OUT, -R_H + R_CH], MAT.RING_PANEL, '#aeb3ba'));
  ring.add(face([R_OUT, R_H - R_CH], [R_OUT - R_CH, R_H], MAT.RING_PANEL, '#aeb3ba'));
  ring.add(face([R_IN + R_CH, R_H], [R_IN, R_H - R_CH], MAT.RING_PANEL, '#aeb3ba'));
  ring.add(face([R_IN, -R_H + R_CH], [R_IN + R_CH, -R_H], MAT.RING_PANEL, '#aeb3ba'));
  // conduits along the outer edges (round, so they may stand still)
  ring.add(Geo.torus(R_OUT - 1, 1.3, RING_SEG, 5).translate(0, 0, R_H - 0.5).color('#7d838c'));
  ring.add(Geo.torus(R_OUT - 1, 1.3, RING_SEG, 5).translate(0, 0, -R_H + 0.5).color('#7d838c'));
  b.static(ring, tf);

  // spinning hub collar
  b.static(Geo.lathe([[20, -24], [32, -20], [38, -13], [38, 13], [32, 20], [20, 24], [20, -24]], 36, { smooth: false })
    .color('#a8adb4').mat(MAT.HUB).gloss(0.3), tf);

  // the despun spindle along the axis
  const spindle = Geo.lathe([
    [0, -205], [9, -205], [15, -199], [24, -190], [24, -140], [17, -133], [9, -129], [9, -28],
    [17, -26], [17, 26], [9, 28], [9, 118], [16, 122], [19, 127], [19, 152], [13, 158], [7.5, 162],
    [7.5, 200], [10, 202], [10, 207], [0, 207],
  ], 24, { smooth: false }).color('#a7abb2').mat(MAT.HULL).gloss(0.3);
  b.static(spindle, tf);

  const g = new Geo();
  // bearing rings either side of the collar
  for (const z of [-27, 27]) g.add(Geo.torus(17, 2.2, 24, 6).translate(0, 0, z).color('#6d737b'));
  // modules round the forward spindle
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    g.add(Geo.box(11, 11, 46).translate(16, 0, 70).rotateZ(a).color(k % 2 ? '#d3d0c8' : '#b8bec6').mat(MAT.HULL));
    g.add(Geo.box(3, 3, 40).translate(22.2, 0, 70).rotateZ(a).mat(MAT.WINDOWS).uvTransform(1, 6).color('#2a3038'));
  }
  // rear radiator fins
  for (let k = 0; k < 4; k++) {
    g.add(Geo.box(46, 1.2, 50).translate(48, 0, -165).rotateZ(k * Math.PI / 2).color('#e4e6ea').mat(MAT.RADIATOR).gloss(0.4));
  }
  // solar wings on a truss across the rear
  g.add(beam([-230, 0, -112], [230, 0, -112], 3));
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const x0 = sx * (42 + i * 47);
      g.add(Geo.plane(44, 34, 2, 2).rotateX(Math.PI / 2).rotateX(WING_TILT).translate(x0, 0, -112).uvTransform(18, 14).color('#ffffff').mat(MAT.SOLAR).gloss(0.6));
    }
  }
  // docking arms at the front hub
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    const arm = new Geo();
    arm.add(Geo.box(52, 5, 5).translate(44, 0, 140).color('#b2b7be').mat(MAT.HULL));
    arm.add(Geo.box(9, 10, 12).translate(73, 0, 140).color('#d8d8d2').mat(MAT.HULL));
    arm.add(Geo.box(1.2, 6, 6).translate(78, 0, 140).color('#2a2f36'));
    g.add(arm.rotateZ(a));
  }
  // docking tube in front of the nose
  g.add(Geo.cylinder(3.2, 16, 10).translate(0, 0, 207).color('#d0d2d6').mat(MAT.HULL));
  g.add(Geo.torus(4.2, 0.8, 12, 5).translate(0, 0, 222).color('#3b4048'));
  // antenna masts
  for (const sy of [-1, 1]) g.add(beam([0, sy * 9, -90], [0, sy * 34, -90], 2.2));
  b.static(g, tf);

  // big clock and revolution counter facing down the approach lane
  const disp = new Geo();
  disp.add(Geo.box(50, 30, 3).translate(0, 98, 150).color('#2b3038').mat(MAT.HULL));
  disp.add(beam([0, 70, 140], [0, 84, 148], 3).color('#7b818a'));
  disp.add(Geo.plane(46, 15).translate(0, 104, 151.6).mat(MAT.CLOCK));
  disp.add(Geo.plane(30, 10).translate(-7, 89, 151.6).mat(MAT.SPINCOUNT));
  disp.add(Geo.box(9, 6, 0.5).translate(16, 89, 151.6).color('#2fbfff').emissive(3));
  b.static(disp, tf);

  // navigation lights on the arms and the nose
  const blink = (p, col, phase, every = 2, on = 0.25) => b.static(lamp(1.3, col, 30).translate(...L2W(p)), { from: phase, to: phase + on, period: every });
  blink([80, 0, 140], '#22ff66', 0);
  blink([-80, 0, 140], '#ff2a1a', 0);
  blink([0, 80, 140], '#ffffff', 1);
  blink([0, -80, 140], '#ffffff', 1);
  blink([0, 0, 224], '#ffffff', 0.5, 1, 0.12);
  blink([0, 0, -207], '#ff2a1a', 0, 3, 0.4);
}

// A thin rod from a to b: handrails, struts, masts.
function rod(a, b, r, seg = 4) {
  const d = v3.sub(b, a), len = v3.len(d);
  const up = Math.abs(d[2]) > 0.98 * len ? [1, 0, 0] : [0, 0, 1];
  return Geo.cylinder(r, len, seg, { caps: false }).rotateX(-Math.PI / 2).transform(m4.facing(a, d, up));
}

// A yellow handrail from a to b, standing h off a surface whose outward normal is n.
function handrail(a, b, n, h = 0.3, every = 2.5) {
  const g = new Geo();
  const off = v3.scale(n, h);
  g.add(rod(v3.add(a, off), v3.add(b, off), 0.04, 3));
  const k = Math.max(1, Math.round(v3.dist(a, b) / every));
  for (let i = 0; i <= k; i++) {
    const p = v3.lerp(a, b, i / k);
    g.add(rod(p, v3.add(p, off), 0.03, 3));
  }
  return g.color('#d8b23a').gloss(0.4);
}

// A docking port's face (MAT.PORT): a disc of radius r facing +z.  The
// shader is told the radius in aux, to size its lines in metres.
const portFace = (r, seg = 16) => Geo.disc(r, seg).color('#c9cdd3').mat(MAT.PORT).aux(r / 4);

// Parts of the station that are seen only from near by: docking ports,
// handrails, floodlights, aerials, and the lattice of the solar truss.  Each
// is its own piece, so that only those near the viewer are drawn.
function stationDetail(b) {
  const near = (g, within) => b.static(g, { transform: STATION, within, solid: false });
  const cyl = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];

  // the docking tube on the nose: a port on its end, handrails along it,
  // floodlights round its foot
  {
    const g = new Geo();
    g.add(portFace(2.7).translate(0, 0, 223.03));
    for (let k = 0; k < 4; k++) {
      const a = (k + 0.5) * Math.PI / 2;
      g.add(handrail(cyl(3.2, a, 208.5), cyl(3.2, a, 220.5), cyl(1, a, 0), 0.35, 4));
      g.add(navLight(0.3, '#fff1d0', 12).translate(...cyl(7.6, a + 0.4, 207.4)));
    }
    near(g, 70);
  }

  // the four docking arms: a collar and a port on each end block,
  // handrails along the top, a mast with a lamp
  for (let k = 0; k < 4; k++) {
    const g = new Geo();
    g.add(Geo.cylinder(2.9, 1.0, 12, { caps: false }).rotateY(Math.PI / 2).translate(78.3, 0, 140).color('#3b4048').gloss(0.5));
    g.add(portFace(2.5).rotateY(Math.PI / 2).translate(78.65, 0, 140));
    for (const y of [-1.7, 1.7]) g.add(handrail([21, y, 142.5], [67, y, 142.5], [0, 0, 1], 0.3, 4.2));
    for (const y of [-2.5, 2.5]) g.add(handrail([70, y * 2, 146], [76, y * 2, 146], [0, 0, 1], 0.3, 3));
    g.add(rod([72, -3.5, 146], [72, -3.5, 152], 0.06).color('#8a9099'));
    g.add(navLight(0.25, '#ffffff', 14).translate(72, -3.5, 152.3));
    near(g.rotateZ(k * Math.PI / 2), 80);
  }

  // the four modules round the forward spindle: handrails along their
  // outer faces, a port on their forward ends
  for (let k = 0; k < 4; k++) {
    const g = new Geo();
    for (const y of [-3.6, 3.6]) g.add(handrail([21.5, y, 50], [21.5, y, 90], [1, 0, 0], 0.3, 4));
    g.add(portFace(2.4).translate(16, 0, 93.03));
    near(g.rotateZ(k * Math.PI / 2 + Math.PI / 4), 60);
  }

  // a dish aerial on a mast between two of the arms
  {
    const g = new Geo();
    g.add(rod([5.5, 0, 180], [15, 0, 180], 0.35, 6).color('#8a9099'));
    const dish = new Geo();
    dish.add(Geo.lathe([[0.01, 0], [1.5, 0.2], [3, 0.8], [4.2, 1.6]], 10).color('#e8e8e4').gloss(0.3));
    for (let k = 0; k < 3; k++) {
      const q = k * TAU / 3;
      dish.add(rod([4.1 * Math.cos(q), 4.1 * Math.sin(q), 1.55], [0, 0, 3.4], 0.05, 3).color('#8a9099'));
    }
    dish.add(Geo.box(0.6, 0.6, 0.8).translate(0, 0, 3.6).color('#3a3f47'));
    g.add(dish.rotateY(-0.5).translate(15.5, 0, 181));
    near(g.rotateZ(Math.PI / 4), 150);
  }

  // two pipes lying along the outer face of the ring: round, so they may
  // stand still while the ring turns under them, and in short arcs so that
  // only those near the viewer are drawn
  for (let k = 0; k < 24; k++) {
    const g = new Geo();
    for (const z of [-3.2, 3.2]) {
      const pts = [];
      for (let i = 0; i <= 4; i++) pts.push(cyl(R_OUT + 0.2, (k + i / 4) * TAU / 24, z));
      g.add(Geo.tube(pts, 0.16, 4, { caps: false }));
    }
    near(g.color('#8d939b').gloss(0.5), 80);
  }

  // a lattice truss round the beam that carries the solar wings
  for (let i = -5; i < 5; i++) {
    const g = Geo.box(46, 6, 6).translate(i * 46 + 23, 0, -112).uvTransform(46 / 6, 1).color('#9aa1aa').mat(MAT.LATTICE).cutout();
    near(g, 300);
  }
}

// An astronaut in a white suit (+Y forward, +Z up, feet at the origin): the
// body, which is only moved, and the legs and arms, which go through a stride.
const SUIT = '#e9e7e1';
function astronaut() {
  const g = new Geo();
  g.add(Geo.box(0.55, 0.36, 0.7).translate(0, 0, 1.38).color(SUIT));
  g.add(Geo.box(0.5, 0.26, 0.62).translate(0, -0.3, 1.42).color('#9aa0a8'));
  g.add(Geo.sphere(0.2, 6, 4).translate(0, 0.02, 1.92).color(SUIT));
  g.add(Geo.box(0.26, 0.06, 0.16).translate(0, 0.19, 1.93).color('#d9a640').gloss(0.95));
  g.add(navLight(0.045, '#fff3dc', 12).translate(0.2, 0.12, 2.0));
  return g;
}

// The legs and arms at the share u of a stride (two steps): each leg swung
// forward by up to `a` about the hip, the one going forward drawn up by up to
// `lift` metres at the foot, the arms swung against the legs by up to `b`
// about the shoulders.  The four poses of a round are the two ends of the
// stride (u = 0, 0.5) and the two moments when the feet pass each other, one
// of them raised (u = 0.25, 0.75); between them the foot on the hull goes
// back in a straight line at a steady pace, so a stride of period P carries
// the astronaut 2 * 0.95 * sin(a) metres every P / 2 seconds without its
// boots sliding.  With a = b = 0 it steps on the spot (for turning round),
// and it is the same as a walking stride where the feet pass.
const LEG = 0.95, HIP = 0.975;
const astronautLimbs = (a, b, lift) => (u) => {
  const c = Math.cos(TAU * u), s = Math.sin(TAU * u);
  const g = new Geo();
  for (const [x, ang, up] of [[-0.14, a * c, lift * Math.max(0, -s)], [0.14, -a * c, lift * Math.max(0, s)]]) {
    g.add(Geo.box(0.18, 0.2, LEG).translate(0, 0, -LEG / 2).scale(1, 1, (LEG - up) / LEG).rotateX(ang).translate(x, 0.04, HIP));
  }
  for (const [x, ang] of [[-0.36, -b * c], [0.36, b * c]]) {
    g.add(Geo.box(0.14, 0.14, 0.62).rotateX(-0.9).translate(0, 0.24, -0.14).rotateX(ang).translate(x, -0.02, 1.62));
  }
  return g.color(SUIT);
};

// A small service pod (+Y forward): a round cab with a window, thruster
// blocks, two manipulator arms, navigation lights and a floodlight.
function servicePod() {
  const g = new Geo();
  g.add(Geo.sphere(1.3, 8, 5).scale(1, 1.1, 0.9).color('#e8e2d2').gloss(0.4));
  g.add(Geo.disc(0.72, 8).rotateX(-Math.PI / 2).translate(0, 1.33, 0.25).color('#9fd4ff').emissive(1.5).gloss(0.9).mat(MAT.CANOPY));
  for (const x of [-1.3, 1.3]) g.add(Geo.box(0.3, 0.9, 0.5).translate(x, -0.2, 0).color('#5d636b'));
  for (const x of [-0.5, 0.5]) {
    g.add(rod([x, 0.9, -0.6], [x * 1.3, 2.1, -0.9], 0.06).color('#8a9099'));
    g.add(rod([x * 1.3, 2.1, -0.9], [x * 1.1, 2.6, -0.5], 0.05).color('#8a9099'));
  }
  g.add(Geo.disc(0.35, 6).rotateX(Math.PI / 2).translate(0, -1.44, 0).color('#bfe6ff').emissive(10));
  g.add(navLight(0.09, '#ff2a1a').translate(-1.47, -0.2, 0.2));
  g.add(navLight(0.09, '#22ff66').translate(1.47, -0.2, 0.2));
  g.add(navLight(0.08, '#ffffff', 14).translate(0, -1.3, 0.55));
  g.add(lamp(0.12, '#fff1d0', 16).translate(0, 1.25, -0.55));
  return g;
}

// People and small craft at work round the hub: an astronaut working along
// the handrail of a docking arm, and a service pod going round the modules.
function stationWorkers(b) {
  // Two astronauts in magnetic boots, each walking over and back along a
  // handrail once a period and turning round on the spot at each end (in
  // eight seconds, a key every half second).  frame(d) places one at distance
  // d along its way (+Y forward, +Z away from the hull).  A stride of P
  // seconds carries one v * P / 2 metres a step, which sets the swing of the
  // legs.  The legs go through their stride while it walks and step on the
  // spot while it turns: two meshes that are the same where the feet pass,
  // and it walks off and stops there (u = 0.25 or 0.75 at t = 0, 50, 58 and
  // 110, which P = 1, 4/3 or 2 with the given start sees to).
  const patrol = (frame, d0, d1, P, start, lift, arms) => {
    const pose = (t) => {
      if (t <= 50) return [d0 + (d1 - d0) * t / 50, 0];
      if (t <= 58) return [d1, (t - 50) / 2];
      if (t <= 110) return [d1 + (d0 - d1) * (t - 58) / 52, 4];
      return [d0, Math.min(8, 4 + (t - 110) / 2)];
    };
    const tf = (t) => { const [d, turn] = pose(t); return m4.mul(frame(d), m4.rotationZ(turn * Math.PI / 4)); };
    const turning = (t0) => timeRange(t0, t0 + 8, 0.5);
    const o = { transform: tf, caps: 'none', within: 300 };
    b.dynamic(astronaut(), { ...o, times: [0, 50, ...turning(50).slice(1), 110, ...turning(110).slice(1), 120] });
    const step = Math.abs(d1 - d0) / 50 * P / 2;
    const cycle = { period: P, keys: 4, start };
    for (const times of [[0, 50], [58, 110]]) b.dynamic(astronautLimbs(Math.asin(step / (2 * LEG)), arms, lift), { ...o, times, cycle });
    for (const times of [turning(50), [...turning(110), 120]]) b.dynamic(astronautLimbs(0, 0, lift), { ...o, times, cycle });
  };
  // on top of the first docking arm (station-local +x, its top towards +z):
  // 32 m in 50 s, three steps of 43 cm every two seconds
  patrol((x) => m4.mul(STATION, m4.translation(x, -0.9, 142.55), m4.fromBasis([0, -1, 0], [1, 0, 0], [0, 0, 1], [0, 0, 0])), 28, 60, 4 / 3, -1 / 3, 0.09, 0.2);
  // along the docking tube on the nose, beside one of its handrails: 10 m in
  // 50 s, a step of 20 cm a second
  {
    const a = Math.PI / 4 + 0.28, c = Math.cos(a), sn = Math.sin(a);
    patrol((z) => m4.mul(STATION, m4.fromBasis([-sn, c, 0], [0, 0, 1], [c, sn, 0], [3.2 * c, 3.2 * sn, z])), 209, 219, 2, 0.5, 0.06, 0.1);
  }
  {
    // round the forward spindle at 32 m, stopping at each of six corners to
    // turn: it arrives at t0 = 20 k, has turned by t0 + 3 and flies straight on
    const corner = (k) => [32 * Math.cos(k * TAU / 6), 32 * Math.sin(k * TAU / 6), 104];
    const pose = (p, heading) => m4.mul(STATION, m4.facing(p, heading, [0, 0, 1]));
    const mats = new Map();
    for (let k = 0; k <= 6; k++) {
      const p = corner(k), din = v3.norm(v3.sub(p, corner(k - 1))), dout = v3.norm(v3.sub(corner(k + 1), p));
      mats.set(20 * k, pose(p, din));
      if (k < 6) {
        mats.set(20 * k + 1.5, pose(p, v3.add(din, dout)));
        mats.set(20 * k + 3, pose(p, dout));
      }
    }
    const final = [...mats.keys()];
    b.dynamic(servicePod(), { times: final, transform: (t) => mats.get(t), caps: 'none', within: 400 });
  }
}

function stationDynamic(b) {
  // spokes and the blocks where they meet the ring: the only parts of the wheel
  // that have to move, since everything round can stand still and let its
  // surface pattern turn
  const g = new Geo();
  for (let k = 0; k < 6; k++) {
    const a = k * TAU / 6;
    g.add(Geo.cylinder(3.6, 152, 6, { caps: false }).rotateY(Math.PI / 2).translate(36, 0, 0).rotateZ(a).color('#b7bcc4').mat(MAT.SPOKE));
    g.add(hullUV(Geo.box(10, 18, 26), 8, 0, k).translate(R_IN - 3, 0, 0).rotateZ(a).color('#9097a1').mat(MAT.BLOCK));
  }
  b.dynamic(g, {
    times: timeRange(0, PERIOD, SPIN / 64),
    transform: (t) => m4.mul(STATION, m4.rotationZ(TAU * t / SPIN)),
    caps: 'none',
  });

  // two antenna dishes sweeping back and forth on the spindle
  for (const sy of [-1, 1]) {
    const dish = new Geo();
    dish.add(Geo.lathe([[0.01, 0], [3, 0.35], [6, 1.4], [8.5, 2.9]], 10).color('#e8e8e4').gloss(0.3));
    dish.add(Geo.cylinder(0.25, 6, 4, { caps: false }).color('#888'));
    dish.add(Geo.box(1.2, 1.2, 1.2).translate(0, 0, 6).color('#3a3f47'));
    dish.add(Geo.box(3, 3, 3).translate(0, 0, -1.5).color('#7a8089'));
    dish.rotateY(Math.PI / 2); // boresight along +x
    const ph = sy > 0 ? 0 : 0.5;
    const tf = (t) => m4.mul(STATION, m4.translation(0, sy * 37, -90), m4.rotationY(0.9 * Math.sin(TAU * (t / 20 + ph))), m4.rotationZ(sy * 0.4));
    b.dynamic(dish, { times: adaptiveTimes(tf, 0, PERIOD, { size: 9, tolerance: 0.15, maxStep: 4 }), transform: tf, caps: 'none' });
  }
}

// ---------------------------------------------------------------------------
// Scene

export default {
  id: 'orbit',
  name: 'Orbital Station',
  blurb: 'Free flight round a spinning ring station above a blue planet, with shuttles, convoys and lanes of chasing beacons. Speed up and the far side of the wheel is seen in the past.',
  C,
  mode: 'fly',
  modes: ['fly', 'swim'],
  spawn: { pos: SPAWN_POS, t: 0, yaw: SPAWN_YAW, pitch: SPAWN_PITCH },
  period: PERIOD,
  viewDistance: 7000,
  skyDistance: 20000,
  exposure: 1.1,
  bloom: 0.4,
  shadows: true,
  shadowRadii: [250, 2500],
  shadowDepth: 8000,
  near: 0.5,
  wgsl: WGSL,

  // The music (see "Music" in docs/SCENES.md).
  // The Orbital Station: slow and wide.  A deep held note, four chords of a
  // quarter of a minute each (the ring turns once in two of them), far glassy
  // notes, and the beacons' pulse.
  music: {
    seconds: 60, reverb: 5, tail: 7, echo: [0.75, 0.45], seed: 23,
    build(m) {
      const { n, notes } = m;
      const deep = m.track({ hall: 0.3 }), wide = m.track({ hall: 0.6 });
      const stars = [m.track({ pan: -0.6, hall: 0.9, echo: 0.5 }), m.track({ pan: 0.6, hall: 0.9, echo: 0.5 }), m.track({ hall: 0.9, echo: 0.5 })];
      const beacon = [m.track({ pan: -0.8, hall: 0.5 }), m.track({ pan: 0.8, hall: 0.5 })];
      m.drone(deep, n('D1'), { gain: 0.06, swell: [4, 0.5] });
      m.drone(deep, n('D2'), { gain: 0.07, swell: [3, 0.4] });
      m.drone(deep, n('A2'), { gain: 0.045, swell: [5, 0.6] });
      ['D3 A3 E4 F4', 'Bb2 F3 A3 D4', 'G2 D3 Bb3 A3', 'A2 E3 D4 E4'].map(notes)
        .forEach((ch, k) => m.pad(wide, k * 15, 15, ch, { cutoff: 1000, gain: 0.08, a: 4, r: 4, detune: 9 }));
      const scale = notes('D5 F5 G5 A5 C6 D6 F6');
      for (let i = 0; i < 22; i++) {
        m.bell(stars[i % 3], (i + m.rand() * 0.8) * 60 / 22, scale[Math.floor(m.rand() * scale.length)], { partials: 'glass', gain: 0.12 + 0.08 * m.rand(), decay: 4 });
      }
      for (let i = 0; i < 16; i++) m.tone(beacon[i % 2], i * 3.75, 0.08, n('A5'), { gain: 0.08, a: 0.005, d: 0.1, s: 0.3, r: 0.25 });
    },
  },

  build(b) {
    const rand = rng(1234);
    stationStatic(b);
    stationDetail(b);
    stationWorkers(b);
    stationDynamic(b);

    const avoid = []; // points rocks keep clear of: [point, radius]
    const beacons = { housings: [], lamps: [] }; // see beacon()

    // ---- lane A: the main approach, a tunnel of chasing beacons ----------
    {
      const z0 = 300, z1 = 1900;
      const corners = [[-60, -42], [60, -42], [60, 42], [-60, 42]];
      for (let z = z0; z <= z1; z += 40) {
        for (const [x, y] of corners) beacon(beacons, L2W([x, y, z]), (z1 - z) / C, 2, '#ffcf87', { r: 2.1 });
      }
      // gateway frames with a clock and the distance to the dock
      [560, 940, 1320, 1700].forEach((z, i) => {
        const fr = new Geo();
        const P = (x, y) => [x, y, z];
        fr.add(beam(P(-66, -48), P(66, -48), 3));
        fr.add(beam(P(-66, 48), P(66, 48), 3));
        fr.add(beam(P(-66, -48), P(-66, 48), 3));
        fr.add(beam(P(66, -48), P(66, 48), 3));
        for (const [x, y] of [[-66, -48], [66, -48], [66, 48], [-66, 48]]) fr.add(Geo.box(7, 7, 7).translate(x, y, z).color('#d5d7db'));
        fr.color('#9aa1aa').mat(MAT.HULL);
        fr.add(Geo.box(34, 12, 2).translate(0, 57, z).color('#262b33').mat(MAT.HULL));
        fr.add(Geo.plane(31, 10).translate(0, 57, z + 1.05).mat(MAT.CLOCK));
        fr.add(Geo.plane(31, 10).rotateY(Math.PI).translate(0, 57, z - 1.05).mat(MAT.CLOCK));
        fr.add(Geo.box(24, 10, 2).translate(0, -57, z).color('#262b33').mat(MAT.HULL));
        fr.add(Geo.plane(21, 8).translate(0, -57, z + 1.05).mat(MAT.DIST + Math.round((z - 230) / 100)));
        b.static(fr, { transform: STATION });
        // from near by, an open lattice round each beam of the frame
        const lat = new Geo();
        for (const [a, c] of [[[-62.5, -48], [62.5, -48]], [[-62.5, 48], [62.5, 48]], [[-66, -44.5], [-66, 44.5]], [[66, -44.5], [66, 44.5]]]) {
          for (let k = 0; k < 2; k++) {
            const p0 = P(a[0] + (c[0] - a[0]) * k / 2, a[1] + (c[1] - a[1]) * k / 2), p1 = P(a[0] + (c[0] - a[0]) * (k + 1) / 2, a[1] + (c[1] - a[1]) * (k + 1) / 2);
            const len = v3.dist(p0, p1);
            lat.add(Geo.box(6, len, 6).uvTransform(len / 6, 1).transform(m4.facing(v3.lerp(p0, p1, 0.5), v3.sub(p1, p0), [0, 0, 1])));
          }
        }
        b.static(lat.color('#aab1ba').mat(MAT.LATTICE).cutout(), { transform: STATION, within: 250, solid: false });
      });

      // shuttles: in along one side, round the nose of the station, a pause at
      // the docking tube, out along the other side and round again far away
      const rt = racetrack(L2W([0, 0, 270]), L2W([0, 0, 1960]), 40, YL, 24);
      const dist = schedule(rt.path.length, [{ d: rt.apexA, dwell: 6 }, { d: rt.apexB, dwell: 0.5 }], { laps: 2, ramp: 4 });
      ['#e0782e', '#2f9fd6', '#d9b53a'].forEach((accent, i) => {
        const distAt = (t) => dist(t + i * 20);
        addShuttle(b, accent, i, along(rt.path, distAt, 10), distAt);
      });
    }

    // ---- lane B: freighter convoys circling between the mine and the depot --
    const conv = racetrack(MINE, DEPOT, 240, [0, 0, 1], 96);
    {
      const L = conv.path.length;
      const speed = L / PERIOD;
      const palettes = [
        ['#b5532a', '#8a8f96', '#c9c6bd', '#8a8f96'],
        ['#c9c6bd', '#2f7f86', '#8a8f96', '#c9c6bd'],
        ['#8a8f96', '#c9c6bd', '#b5532a', '#6f757d'],
        ['#6f757d', '#8a8f96', '#c9c6bd', '#c8962f'],
      ];
      for (const base of [0.1 * L, 0.6 * L]) {
        for (let i = 0; i < 4; i++) {
          const off = base - i * 130;
          const tf = along(conv.path, (t) => off + speed * t, 40);
          const times = adaptiveTimes(tf, 0, PERIOD, { size: 30, tolerance: 0.5, maxStep: 10 });
          b.dynamic(freighter(palettes[i], (base > L / 2 ? 4 : 0) + i), { times, transform: tf, caps: 'none' });
          b.dynamic(TUG_PLUME, { times, transform: tf, caps: 'none', cycle: flicker(TUG_TAIL, 3, (base > L / 2 ? 0.11 : 0.02) + i * 0.057) });
          addRiding(b, FREIGHTER_DETAIL, times, tf, 150, 900);
          addRiding(b, TUG_RADAR, times, tf, 150, 900, tugRadar((base > L / 2 ? 1.9 : 0.3) + i * 0.71));
        }
      }
      // beacon chains along both straights, flashing in the direction of travel
      const n = Math.floor(conv.len / 60);
      for (let i = 0; i <= n; i++) {
        const x = i * conv.len / n;
        const p1 = v3.add(v3.add(MINE, v3.scale(conv.fwd, x)), v3.scale(conv.side, 240 + 30));
        const p2 = v3.add(v3.add(MINE, v3.scale(conv.fwd, x)), v3.scale(conv.side, -240 - 30));
        beacon(beacons, p1, x / 100, 6, '#7fe6ff', { r: 2.2 });
        beacon(beacons, p2, (conv.len - x) / 100, 6, '#7fe6ff', { r: 2.2 });
      }
      for (let d = 0; d < L; d += 20) avoid.push([conv.path.at(d).p, 70]);
    }

    // ---- the gate on the convoy lane: pulses chase round it ---------------
    {
      const gp = v3.add(v3.add(MINE, v3.scale(conv.fwd, 1450)), v3.scale(conv.side, 240));
      const place = m4.mul(m4.facing(gp, conv.fwd), m4.rotationX(-Math.PI / 2));
      const g = new Geo();
      g.add(Geo.torus(78, 5, 72, 8).color('#8e959e').mat(MAT.HULLW));
      g.add(Geo.torus(71, 1.4, 96, 6).mat(MAT.GATE));
      for (let k = 0; k < 8; k++) {
        g.add(Geo.box(16, 12, 16).translate(80, 0, 0).rotateZ(k * TAU / 8 + TAU / 16).color('#cfd2d6').mat(MAT.HULLW));
      }
      b.static(g, { transform: place });
      for (let k = 0; k < 48; k++) {
        const a = k * TAU / 48;
        const p = m4.point(place, [Math.cos(a) * 84.5, Math.sin(a) * 84.5, 0]);
        b.static(lamp(1.6, '#ffcf87', 28).translate(...p), { from: k * 2 / 48, to: k * 2 / 48 + 0.18, period: 2 });
      }
      avoid.push([gp, 140]);
    }

    // ---- the mine: an asteroid with a rig and a mass driver -----------------
    const railStart = v3.add(MINE, [150, 0, 0]);
    const railEnd = v3.add(MINE, [470, 0, 0]);
    {
      const rock = rockGeo(150, 7, { seg: 40, rings: 26, rough: 0.28, crag: 0.3, squash: [1.25, 1, 0.8] });
      // height of the rock's surface above a point, for setting things down on it
      const groundAt = (x, y, rad = 12) => {
        let z = -Infinity;
        for (let i = 0; i < rock.p.length; i += 3) if (Math.hypot(rock.p[i] - x, rock.p[i + 1] - y) < rad) z = Math.max(z, rock.p[i + 2]);
        return z;
      };
      b.static(rock.clone().translate(...MINE).color('#5e554b').mat(MAT.ROCK));
      avoid.push([MINE, 420]);
      const rig = new Geo();
      // launcher housing and rail
      rig.add(Geo.box(56, 34, 34).translate(...v3.add(MINE, [150, 0, 0])).color('#b9b4a8').mat(MAT.HULLW));
      rig.add(Geo.box(56.4, 34.4, 3).translate(...v3.add(MINE, [150, 0, 8])).mat(MAT.WINDOWS).uvTransform(10, 1).color('#2a2f36'));
      const railLen = v3.dist(railStart, railEnd);
      rig.add(Geo.cylinder(2.2, railLen, 10, { caps: false }).rotateY(Math.PI / 2).translate(...railStart).mat(MAT.RAIL));
      for (const dz of [-6, 6]) rig.add(beam(v3.add(railStart, [0, 0, dz]), v3.add(railEnd, [0, 0, dz]), 1.6).color('#7c828b'));
      for (let x = 20; x < railLen; x += 25) {
        rig.add(Geo.torus(8, 1.1, 12, 4).rotateY(Math.PI / 2).translate(...v3.add(railStart, [x, 0, 0])).color('#c9ccd1'));
      }
      rig.add(truss(v3.add(MINE, [150, 0, -20]), v3.add(railStart, [170, 0, -9]), 6, 12, 0.6).color('#8a9099'));
      // the mining camp on top: a deck, two habitat blocks, a derrick and a crusher
      const camp = (x, y) => v3.add(MINE, [x, y, groundAt(x, y)]);
      const deck = camp(10, 0);
      rig.add(Geo.box(110, 70, 14).translate(...v3.add(deck, [0, 0, -3])).color('#8f8b82').mat(MAT.HULLW));
      for (const [dx, dy, w, l, h] of [[-30, -18, 36, 22, 22], [-30, 16, 30, 20, 16]]) {
        rig.add(Geo.box(w, l, h).translate(...v3.add(deck, [dx, dy, 4 + h / 2])).color('#d8d4c8').mat(MAT.HULLW));
        rig.add(Geo.box(w + 0.4, l + 0.4, 3).translate(...v3.add(deck, [dx, dy, 4 + h * 0.6])).mat(MAT.WINDOWS).uvTransform(Math.round(w / 3), 1).color('#2a2f36'));
      }
      rig.add(truss(v3.add(deck, [25, 0, 4]), v3.add(deck, [25, 0, 130]), 9, 10, 0.7).color('#c8a04a'));
      rig.add(beam(v3.add(deck, [25, -30, 124]), v3.add(deck, [25, 30, 124]), 2.5).color('#c8a04a'));
      rig.add(Geo.cylinder(10, 26, 12).translate(...v3.add(deck, [40, 22, 4])).color('#9a958b').mat(MAT.HULLW));
      rig.add(Geo.cone(10, 10, 12).translate(...v3.add(deck, [40, 22, 30])).color('#c8a04a'));
      rig.add(beam(v3.add(deck, [40, 22, 20]), v3.add(MINE, [150, 10, 18]), 3).color('#7c828b'));
      b.static(rig);
      for (const [dx, dy] of [[-50, 36], [50, -36], [25, 30]]) {
        const lp = v3.add(deck, [dx, dy, dx === 25 ? 120 : 12]);
        b.static(lamp(1.8, '#fff1d0', 20).translate(...lp));
        const out = v3.norm([dx, dy, 0]);
        b.static(Geo.cylinder(1.4, 140, 10, { r2: 45, caps: false }).colorBy((p) => fadeCol([1, 0.92, 0.75], 1 - p[2] / 140))
          .emissive(0.16).additive().mat(MAT.GLOW).transform(m4.mul(m4.translation(...lp), m4.facing([0, 0, 0], [out[0], out[1], dx === 25 ? -1.2 : -0.35]), m4.rotationX(-Math.PI / 2))));
      }
      const top = v3.add(deck, [25, 0, 130]);
      b.static(lamp(1.6, '#ff2a1a', 30).translate(...v3.add(top, [0, 0, 3])), { from: 0, to: 0.4, period: 2 });
      for (const sy of [-1, 1]) b.static(lamp(1.2, '#ff2a1a', 30).translate(...v3.add(top, [0, sy * 30, -6])), { from: 0, to: 0.4, period: 2 });
      b.static(lamp(1.6, '#ff2a1a', 30).translate(...v3.add(railEnd, [0, 0, 10])), { from: 1, to: 1.4, period: 2 });
    }

    // ---- the depot ----------------------------------------------------------
    const catchMouth = v3.add(DEPOT, [-225, 0, 0]);
    const catchThroat = v3.add(DEPOT, [-178, 0, 0]);
    const berth = v3.add(DEPOT, [-120, -40, 34]);
    {
      const D = (x, y, z) => v3.add(DEPOT, [x, y, z]);
      const g = new Geo();
      g.add(truss(D(-170, 0, 0), D(170, 0, 0), 12, 14, 0.7).color('#8c939c'));
      g.add(Geo.box(330, 6, 6).translate(...D(0, 0, 0)).color('#b8bcc2').mat(MAT.HULLW));
      for (const x of [-90, -30, 30, 90]) {
        g.add(Geo.box(48, 1, 26).translate(...D(x, 0, 38)).color('#e2e4e8').mat(MAT.HULLW).gloss(0.4));
        g.add(beam(D(x, 0, 6), D(x, 0, 26), 1.4).color('#8c939c'));
      }
      // the containers on the racks: copies of one box, each in its own colour
      const cols = ['#8a8f96', '#8a8f96', '#c9c6bd', '#c9c6bd', '#6f757d', '#b5532a', '#2f7f86', '#c8962f'];
      const containers = [];
      for (const x of [-120, -60, 0, 60, 120]) {
        g.add(beam(D(x, -42, 0), D(x, 42, 0), 1.6).color('#6f767f'));
        g.add(beam(D(x, 0, -24), D(x, 0, 24), 1.6).color('#6f767f'));
        for (const sy of [-1, 1]) {
          for (const y of [13, 20, 27, 34]) {
            for (const z of [-14, -7, 0, 7, 14]) {
              if (rand() < 0.28) continue;
              containers.push({ transform: m4.translation(...D(x, sy * y, z)), tint: rand.pick(cols), data: containers.length + 40 });
            }
          }
        }
      }
      const box = Geo.box(18, 6, 6);
      for (let i = 0; i < box.vertexCount; i++) box.x[i * 2 + 1] = [2, 1, 0, 0, 3, 3][Math.floor(i / 4)];
      b.instances(box.color('#ffffff').mat(MAT.CONTAINER), containers);
      // control tower with a big clock and a cargo counter
      g.add(Geo.box(26, 26, 64).translate(...D(150, 0, 8)).color('#d0d1cd').mat(MAT.HULLW));
      for (const z of [-12, 0, 12, 24]) g.add(Geo.box(26.4, 26.4, 3).translate(...D(150, 0, z)).mat(MAT.WINDOWS).uvTransform(9, 1).color('#232a33'));
      g.add(Geo.box(4, 4, 40).translate(...D(150, 0, 60)).color('#9aa0a8'));
      // catcher funnel for the ore pods
      g.add(Geo.lathe([[7, 0], [12, 18], [22, 36], [34, 48]], 20, { smooth: false }).rotateY(-Math.PI / 2).translate(...catchThroat).color('#b8b2a4').mat(MAT.HULLW));
      g.add(Geo.cylinder(9, 30, 12).rotateY(Math.PI / 2).translate(...catchThroat).color('#8d939b').mat(MAT.HULLW));
      // berth for the station tugs
      g.add(beam(D(-120, -6, 6), v3.add(berth, [0, 6, 0]), 3).color('#9aa0a8'));
      g.add(Geo.box(10, 8, 10).translate(...v3.add(berth, [0, 8, 0])).color('#d8d8d2').mat(MAT.HULLW));
      b.static(g);
      // display boards turned towards the station
      const face = v3.norm([SPAWN_POS[0] - DEPOT[0], SPAWN_POS[1] - DEPOT[1], 0]);
      const rz = Math.atan2(face[0], -face[1]);
      const board = new Geo();
      board.add(Geo.box(50, 2, 34).translate(0, 0, 0).color('#242931').mat(MAT.HULLW));
      board.add(Geo.plane(46, 15).rotateX(Math.PI / 2).translate(0, -1.05, 8).mat(MAT.CLOCK));
      board.add(Geo.plane(40, 13).rotateX(Math.PI / 2).translate(0, -1.05, -8).mat(MAT.CARGO));
      b.static(board.rotateZ(rz).translate(...D(150, 0, 0)).translate(...v3.scale(face, 16)).translate(0, 0, 66));
      // floodlights on the racks
      for (const x of [-90, 30]) {
        for (const sy of [-1, 1]) {
          const lp = D(x, sy * 50, 30);
          b.static(lamp(1.5, '#fff1d0', 20).translate(...lp));
          const beamG = Geo.cylinder(1.2, 70, 10, { r2: 22, caps: false }).colorBy((p) => fadeCol([1, 0.92, 0.75], 1 - p[2] / 70))
            .emissive(0.22).additive().mat(MAT.GLOW);
          b.static(beamG.transform(m4.mul(m4.translation(...lp), m4.rotationX(sy * 2.3))));
        }
      }
      // blinking corner lights and lights round the catcher mouth
      for (const x of [-170, 170]) for (const sy of [-1, 1]) b.static(lamp(1.3, '#ff2a1a', 30).translate(...D(x, sy * 9, 9)), { from: 0, to: 0.35, period: 2.5 });
      b.static(lamp(1.4, '#ffffff', 30).translate(...D(150, 0, 81)), { from: 0.2, to: 0.32, period: 1.5 });
      for (let k = 0; k < 16; k++) {
        const a = k * TAU / 16;
        const p = v3.add(catchMouth, [0, Math.cos(a) * 36, Math.sin(a) * 36]);
        b.static(lamp(1.2, '#ffcf87', 26).translate(...p), { from: 0, to: 0.3, period: 2 });
      }
      avoid.push([DEPOT, 320]);

      // two gantry cranes running up and down the racks, pausing at each end
      const crane = new Geo();
      // (the legs and the bridge are painted as open lattices: MAT.TUG's part 1)
      for (const sy of [-1, 1]) crane.add(hullUV(Geo.box(3, 3, 64).translate(0, sy * 44, 0), TUG_SCALE, 1, 0).color('#c8a04a').mat(MAT.TUG));
      crane.add(hullUV(Geo.box(3, 91, 3).translate(0, 0, 32), TUG_SCALE, 1, 0).color('#c8a04a').mat(MAT.TUG));
      crane.add(Geo.box(6, 8, 4).translate(0, 18, 28).color('#555b63'));
      crane.add(Geo.box(1, 1, 20).translate(0, 18, 16).color('#2b2f35'));
      crane.add(navLight(0.9, '#ffb030', 1).mat(MAT.BLINK).translate(0, 0, 34.5));
      const travel = 220;
      const run = schedule(2 * travel, [{ d: 0, dwell: 6 }, { d: travel, dwell: 6 }], { laps: 4, ramp: 3 });
      [0, 15].forEach((dt, i) => {
        const tf = (t) => {
          const d = ((run(t + dt) % (2 * travel)) + 2 * travel) % (2 * travel);
          const x = (d < travel ? d : 2 * travel - d) - travel / 2;
          return m4.translation(...D(i ? -x : x, 0, 0));
        };
        b.dynamic(crane, { times: adaptiveTimes(tf, 0, PERIOD, { size: 45, tolerance: 0.3, maxStep: 8 }), transform: tf, caps: 'none' });
      });
    }

    // ---- ore pods flung from the mine to the depot, one every two seconds ---
    {
      const vPod = 160;
      const railLen = v3.dist(railStart, railEnd);
      const acc = vPod * vPod / (2 * railLen);
      const tAcc = vPod / acc;
      const cruise = v3.dist(railEnd, catchThroat) / vPod;
      const life = tAcc + cruise;
      const pod = new Geo();
      pod.add(Geo.box(3, 5, 3).color('#d9a54a').gloss(0.5));
      pod.add(Geo.sphere(4, 6, 4).color([1.0, 0.62, 0.25]).emissive(4).additive().mat(MAT.GLOW));
      const posAt = (u) => {
        if (u < tAcc) return v3.add(railStart, [acc * u * u / 2, 0, 0]);
        return v3.add(railEnd, [vPod * (u - tAcc), 0, 0]);
      };
      const keys = [];
      const nAcc = Math.ceil(tAcc / 0.4);
      for (let k = 0; k < nAcc; k++) keys.push(k * tAcc / nAcc);
      keys.push(tAcc, life - 0.4, life);
      for (let i = 0; i < PERIOD / 2; i++) {
        const t0 = i * 2;
        b.dynamic(pod, {
          times: keys.map((u) => t0 + u),
          transform: (t) => {
            const u = t - t0;
            const s = Math.min(1, u / 0.4, (life - u) / 0.4);
            return m4.mul(m4.translation(...posAt(u)), m4.rotationZ(-Math.PI / 2), m4.scaling(Math.max(s, 0)));
          },
          caps: 'none',
        });
      }
      for (let x = 0; x < v3.dist(railStart, catchMouth); x += 25) avoid.push([v3.add(railStart, [x, 0, 0]), 50]);
    }

    // ---- lane C: tugs between the station and the depot --------------------
    {
      const sd = L2W([86, 0, 140]);
      const fwd = v3.norm(v3.sub(berth, sd));
      const a = v3.add(sd, v3.scale(fwd, 20)), bb = v3.sub(v3.add(berth, [0, 0, 0]), v3.scale(fwd, 20));
      const rt = racetrack(a, bb, 20, [0, 0, 1], 20);
      const dist = schedule(rt.path.length, [{ d: rt.apexA, dwell: 7 }, { d: rt.apexB, dwell: 7 }], { laps: 2, ramp: 5 });
      ['#c8402f', '#8a8f96'].forEach((accent, i) => {
        const distAt = (t) => dist(t + i * 30);
        addShuttle(b, accent, 3 + i, along(rt.path, distAt, 10), distAt);
      });
      const n = Math.floor(rt.len / 55);
      for (let i = 1; i < n; i++) {
        const p = v3.lerp(a, bb, i / n);
        beacon(beacons, v3.add(p, [0, 0, -14]), i * 0.25, 5, '#ffffff', { r: 1.5 });
      }
      for (let d = 0; d < rt.path.length; d += 20) avoid.push([rt.path.at(d).p, 50]);
    }

    // ---- the moonlet and its satellites -------------------------------------
    {
      b.static(rockGeo(MOON_R, 99, { seg: 48, rings: 32, rough: 0.08, crag: 0.06, smooth: true }).translate(...MOON).color('#77736e').mat(MAT.MOON));
      avoid.push([MOON, 500]);
      [[270, 20, 0.35, 0.2, '#ffcf87'], [340, 30, -0.5, 1.9, '#7fe6ff'], [420, 40, 0.9, 3.8, '#ffffff']].forEach(([r, T, inc, node, accent], i) => {
        const tf = (t) => m4.mul(m4.translation(...MOON), m4.rotationZ(node), m4.rotationX(inc), m4.rotationZ(TAU * t / T + i * 2.1), m4.translation(r, 0, 0));
        b.dynamic(satellite(accent).scale(2.2), { times: timeRange(0, PERIOD, T / 56), transform: tf, caps: 'none' });
      });
    }

    // ---- asteroids: a field round the mine, a few strays, some tumbling -----
    {
      const clear = (p, r) => avoid.every(([q, rr]) => v3.dist(p, q) > rr + r);
      let placed = 0, tries = 0;
      while (placed < 150 && tries++ < 4000) {
        const nearMine = placed < 110;
        const p = nearMine
          ? v3.add(MINE, [rand.range(-900, 700), rand.range(-800, 900), rand.range(-500, 400)])
          : [rand.range(-3000, 3000), rand.range(-2500, 3200), rand.range(-900, 900)];
        const r = nearMine ? 4 + Math.pow(rand(), 3) * 45 : 6 + Math.pow(rand(), 2) * 30;
        if (!clear(p, r + 20)) continue;
        if (v3.dist(p, [0, 0, 0]) < 700 || v3.dist(p, SPAWN_POS) < 300) continue;
        // keep the main approach lane clear
        const lz = v3.dot(p, AX), lx = v3.dot(p, XL), ly = v3.dot(p, YL);
        if (lz > 0 && lz < 2200 && Math.abs(lx) < 200 && Math.abs(ly) < 160) continue;
        const tone = rand.range(0.2, 0.34);
        b.static(rockGeo(r, 1000 + placed, { rough: rand.range(0.2, 0.4), squash: [1, rand.range(0.7, 1.1), rand.range(0.6, 0.95)] })
          .rotateZ(rand.range(0, TAU)).rotateX(rand.range(0, TAU)).translate(...p)
          .color([tone, tone * 0.93, tone * 0.85]).mat(MAT.ROCK));
        placed++;
      }
      // tumbling rocks: a whole number of turns per period
      for (let i = 0; i < 6; i++) {
        let p;
        do { p = v3.add(MINE, [rand.range(-700, 600), rand.range(-700, 800), rand.range(-400, 350)]); } while (!clear(p, 40));
        const r = rand.range(12, 26);
        const axis = v3.norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
        const turns = 1 + (i % 2);
        const tone = rand.range(0.22, 0.32);
        b.dynamic(rockGeo(r, 500 + i, { seg: 8, rings: 6 }).color([tone, tone * 0.92, tone * 0.84]).mat(MAT.ROCKD), {
          times: timeRange(0, PERIOD, PERIOD / (turns * 24)),
          transform: (t) => m4.mul(m4.translation(...p), m4.rotationAxis(axis, TAU * turns * t / PERIOD)),
          caps: 'none',
        });
      }
    }

    // ---- a comet drifting across the sky ------------------------------------
    {
      const c0 = [-2100, 3600, 1150];
      const vel = [125, -25, 12];
      const tailDir = v3.scale(SUN_DIR, -1);
      const g = new Geo();
      g.add(rockGeo(26, 77, { seg: 9, rings: 6 }).color('#5b5650'));
      for (const [r, e] of [[170, 0.35], [60, 0.8]]) g.add(Geo.sphere(r, 14, 9).color([0.6, 0.85, 1.0]).emissive(e).additive().mat(MAT.GLOW));
      const tailLen = 2400;
      const prof = [];
      for (let k = 0; k <= 16; k++) { const z = k / 16 * tailLen; prof.push([12 + 260 * Math.pow(k / 16, 0.8), z]); }
      const tail = Geo.lathe(prof, 12).colorBy((p) => fadeCol([0.5, 0.72, 1.0], Math.pow(1 - p[2] / tailLen, 1.6)))
        .emissive(0.3).additive().mat(MAT.GLOW);
      const ion = Geo.lathe(prof.map(([r, z]) => [r * 0.25, z * 1.2]), 8).colorBy((p) => fadeCol([0.35, 0.6, 1.0], Math.pow(1 - p[2] / (tailLen * 1.2), 1.2)))
        .emissive(0.6).additive().mat(MAT.GLOW);
      const orient = m4.facing([0, 0, 0], tailDir); // +Y along the tail
      g.add(tail.rotateX(-Math.PI / 2).transform(orient));
      g.add(ion.rotateX(-Math.PI / 2).transform(orient));
      // It is at c0 at t = 0 (= 120) and flies in a straight line, so the
      // period is split in two halves joined at t = 60, when the comet is
      // 7.5 km away at either end of its track and shrinks to nothing.
      const at = (t, base, scale) => m4.mul(m4.translation(...v3.add(c0, v3.scale(vel, t - base))), m4.scaling(scale));
      b.dynamic(g, { times: [0, 56, 57, 58, 59, 60], transform: (t) => at(t, 0, Math.min(1, (60 - t) / 4)), caps: 'none' });
      b.dynamic(g, { times: [60, 61, 62, 63, 64, 120], transform: (t) => at(t, 120, Math.min(1, (t - 60) / 4)), caps: 'none' });
    }

    addBeacons(b, beacons);
  },
};
