// Time Lab: a plain test range that makes the tilt easy to read.  Every clock
// panel displays the moment at which you are seeing it, so the clocks down the
// runway run behind once you start moving, and the ones behind you run ahead.
// A frame of clocks one above another, with a ramp up to a platform behind it,
// does the same for the tilt up and down.
//
// This file doubles as the reference example for the scene API (docs/SCENES.md).

import { Geo } from '../geom.js';
import { m4 } from '../math.js';
import { dayNightEnv } from '../env.js';
import { Path, follow, timeRange, rng } from '../util.js';

const PERIOD = 60; // every moving thing repeats after this many seconds
const MAT_GROUND = 1, MAT_CLOCK = 2, MAT_DIAL = 3, MAT_STENCIL = 4, MAT_CAR = 5, MAT_CAB = 6, MAT_WHEEL = 7,
  MAT_TRAM = 8, MAT_PLATE = 9, MAT_STRIPES = 10, MAT_SCALE = 11, MAT_BEAM = 12, MAT_STAFF = 13, MAT_CONCRETE = 14,
  MAT_BLOCK = 15, MAT_COUNT = 16;

// The cars' loop, and how often their wheels turn on it in one period (the shader turns them).
const LOOP = new Path([[-70, 50, 0], [70, 50, 0], [70, 90, 0], [-70, 90, 0]], { closed: true, smooth: 8 });
const WHEEL_R = 0.36, WHEEL_TURNS = Math.round(LOOP.length / (2 * Math.PI * WHEEL_R));

// The climb by the frame of clocks (see build): a ramp 4 m wide from the ground at y = 15 to a
// platform 10 m up at y = 40, which reaches east from its top, all of it walled round.  A walker
// follows the scene's `ground` up a slope, but can only stand on something solid that is at
// least 0.45 m above it, and gets onto that by jumping.  So a ramp or stairs that start at the
// ground have to be part of `ground`, with the meshes drawn to match it, so that they count as
// ground and not as obstacles.  The ramp rises 10 m in 25, about 22 degrees: briskly on foot,
// and a car gets up it too.  Everywhere else the range is flat at 0, as for a scene without
// `ground`; and flying or swimming, `ground` is a floor that keeps the player out of it.
const EYE = 1.7; // a walker's eye height (the default)
const RAMP = { x0: -50, x1: -46, y0: 15, y1: 40 }, DECK = { x0: -50, x1: -36, y0: 40, y1: 46, z: 10 };
function ground(x, y) {
  if (x < DECK.x0 || x > DECK.x1 || y < RAMP.y0 || y > DECK.y1) return 0;
  if (y >= DECK.y0) return DECK.z;
  return x <= RAMP.x1 ? DECK.z * (y - RAMP.y0) / (RAMP.y1 - RAMP.y0) : 0;
}

const wgsl = dayNightEnv({ dayLength: 300, startHour: 10, fog: 0.0035, clouds: 0.5 }) + /* wgsl */ `
// How much of a mesh marked .cutout() is there at each pixel (1 solid .. 0 a
// hole), in the picture and in its shadow.  It is asked for every opaque mesh,
// so whatever has no holes returns 1 at once.
fn cutout(s: Surface) -> f32 {
  if (s.mat != ${MAT_STENCIL}u) { return 1.0; }
  // the stencil clock: its digits, at the time at which it is seen, are holes
  return 1.0 - clock7(s.uv, s.t);
}

// Most small detail here is painted on, not modelled: patterns laid out from
// the mesh's uv, with .aux() and .tag() telling its parts apart.  That costs
// no triangles, which matters most on moving things.
fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  // Derivatives must be taken before any branching.
  let fw3 = fwidth(s.pos);
  let fw = fw3.xy;
  let u = s.uv;
  if (s.mat == ${MAT_GROUND}u) {
    // metre grid, bolder every ten metres, plus the runway markings
    let g1 = abs(fract(s.pos.xy - 0.5) - 0.5) / max(fw, vec2f(1e-4));
    let g10 = abs(fract(s.pos.xy / 10.0 - 0.5) - 0.5) * 10.0 / max(fw, vec2f(1e-4));
    let fade = 1.0 / (1.0 + s.dist * 0.02);
    let l1 = (1.0 - saturate(min(g1.x, g1.y))) * 0.25 * fade;
    let l10 = 1.0 - saturate(min(g10.x, g10.y) - 0.5);
    s.color = mix(s.color, vec3f(0.55, 0.6, 0.65), max(l1, l10 * 0.7));
    if (abs(s.pos.x) < 4.0 && s.pos.y > -40.0 && s.pos.y < 400.0) {
      s.color = mix(s.color, vec3f(0.035, 0.037, 0.042), 0.85);
      let dash = step(abs(s.pos.x), 0.12) * step(fract(s.pos.y / 10.0), 0.5) * step(-12.0, s.pos.y);
      let edge = step(abs(abs(s.pos.x) - 3.7), 0.1);
      var paint = max(dash, edge);
      if (s.pos.y < -18.0) {
        // threshold bars, and the runway's number (it points north: 36) in seven segments.  They lie
        // before the start, so only that end of the runway is asked about them: what a pixel does
        // not need should sit behind a test, since this runs for every pixel of the ground.
        let bars = step(s.pos.y, -33.0) * step(abs(s.pos.x), 3.3) * step(fract(s.pos.x / 0.8), 0.5);
        let num = number7((s.pos.xy + vec2f(2.0, 25.0)) / vec2f(4.0, 6.0), 36.0, 2);
        paint = max(paint, max(bars, num));
      }
      s.color = mix(s.color, vec3f(0.85, 0.82, 0.7), paint);
    }
    if (abs(s.pos.y - 140.0) < 1.5) {   // ballast and sleepers under the tram's rails
      s.color = mix(vec3f(0.3, 0.28, 0.25), vec3f(0.16, 0.11, 0.08), step(fract(s.pos.x / 0.7), 0.3) * step(abs(s.pos.y - 140.0), 1.2));
    }
    if (abs(s.pos.y - 2.0) < 0.5 && abs(s.pos.x - 17.1) < 8.0) {
      // under the row of pendulums, a line along it and a tick where each bob hangs at rest: in
      // step, every bob is as far from its tick; tilted, they make a wave along the line
      let tick = step(abs(fract((s.pos.x - 10.5) / 2.2 + 0.5) - 0.5) * 2.2, 0.05) * step(abs(s.pos.y - 2.0), 0.45);
      s.color = mix(s.color, vec3f(0.85, 0.82, 0.7), max(tick, step(abs(s.pos.y - 2.0), 0.04)));
    }
    let pad = length(s.pos.xy - vec2f(-20.0, -24.0));
    if (pad < 5.0) {
      // a concrete pad round the stencil clock, plain for the time in its shadow to be read on
      s.color = mix(s.color, vec3f(0.3, 0.3, 0.28), 1.0 - smoothstep(4.85, 5.0, pad));
    }
  } else if (s.mat == ${MAT_CLOCK}u) {
    // a digital clock showing the time at which this surface is being seen, in a thin frame
    let on = clock7((u - vec2f(0.06, 0.12)) / vec2f(0.88, 0.76), s.t);
    let frame = step(min(min(u.x, 1.0 - u.x) * 20.0, min(u.y, 1.0 - u.y) * 9.0), 0.25);
    s.color = mix(mix(vec3f(0.012, 0.014, 0.018), vec3f(0.3), frame), vec3f(1.0, 0.62, 0.12), on);
    s.emissive = on * 5.0;
    s.gloss = 0.5;
  } else if (s.mat == ${MAT_DIAL}u) {
    // hour bars and minute ticks on the tower's analogue dial (uv 0..1 across the face)
    let q = u - 0.5;
    let r = length(q) * 2.0;
    let a = atan2(q.x, q.y) / TAU;
    let hours = step(abs(fract(a * 12.0 + 0.5) - 0.5), 0.045) * step(0.7, r) * step(r, 0.9);
    let mins = step(abs(fract(a * 60.0 + 0.5) - 0.5), 0.1) * step(0.84, r) * step(r, 0.9);
    let ink = max(max(hours, mins), step(0.96, r));
    s.color = mix(vec3f(0.92, 0.9, 0.84), vec3f(0.05), ink);
    // lit from within after dark (envDaylight comes with the built-in sky: 1 by day, 0 at night)
    s.emissive = (1.0 - ink) * (1.0 - envDaylight(s.t)) * 0.7;
  } else if (s.mat == ${MAT_CAR}u) {
    // a car's body, a box with uv 0..1 across each face.  Its .aux() is 1 on the
    // front face and -1 on the back one, its .tag() the car's number.  The lamps
    // are switched on after sunset (by the time at which they are seen), so that
    // at dusk a tilted view has the cars on its later side lit and the others not.
    let lamps = step(abs(abs(u.x - 0.5) - 0.34), 0.11) * step(abs(u.y - 0.62), 0.14);
    let bumper = step(u.y, 0.33);   // a dark strip where the bumpers are (modelled from near by)
    let on = step(envDaylight(s.t), 0.5);
    if (s.aux > 0.5) {         // front: a grille between white headlamps
      let grille = step(abs(u.x - 0.5), 0.17) * step(abs(u.y - 0.62), 0.16) * step(0.4, fract(u.y * 10.0));
      s.color = mix(mix(s.color, vec3f(0.03), max(grille, bumper)), vec3f(1.0, 0.96, 0.85), lamps);
      s.emissive = lamps * mix(0.3, 8.0, on);
    } else if (s.aux < -0.5) { // back: red tail lamps, and a plate with the number
      let plate = step(abs(u.x - 0.5), 0.14) * step(abs(u.y - 0.47), 0.13);
      let digits = number7((u - vec2f(0.38, 0.36)) / vec2f(0.24, 0.22), f32(s.tag), 2);
      s.color = mix(mix(s.color, vec3f(0.9, 0.85, 0.45), plate), vec3f(0.02), max(digits, bumper));
      s.color = mix(s.color, mix(vec3f(0.45, 0.03, 0.02), vec3f(1.0, 0.04, 0.02), on), lamps);
      s.emissive = lamps * 5.0 * on;
    } else if (abs(s.n.z) < 0.5) {  // sides, in metres: wheel arches, and the number on a disc
      let p = (u - 0.5) * vec2f(4.2, 0.55);
      let arch = step(length(vec2f(abs(p.x) - 1.3, p.y + 0.24)), 0.43);
      let disc = step(length(p - vec2f(-0.05, 0.02)), 0.21);
      let digits = number7((p - vec2f(-0.25, -0.15)) / vec2f(0.4, 0.34), f32(s.tag), 2);
      s.color = mix(mix(s.color, vec3f(0.92), disc), vec3f(0.02), max(digits, arch));
    }
  } else if (s.mat == ${MAT_CAB}u) {
    // a car's cabin: on its sides (aux 1 or -1) uv is in metres along the car and up, so the
    // windows can follow the pillars; elsewhere it runs 0..1 across each face, all glass but the roof
    let side = step(0.08, u.y) * step(u.y, 0.47) * step(-1.38 + 0.55 * u.y, u.x) * step(u.x, 0.8 - u.y) * step(0.05, abs(u.x + 0.3));
    let glass = select(step(abs(u.x - 0.5), 0.42) * step(abs(u.y - 0.5), 0.44) * step(s.n.z, 0.8), side, abs(s.aux) > 0.5);
    s.color = mix(s.color, vec3f(0.03, 0.045, 0.06), glass);
    s.gloss = mix(s.gloss, 0.95, glass);
  } else if (s.mat == ${MAT_WHEEL}u) {
    // a wheel's outer face: tyre, rim and five spokes that turn with the time at
    // which they are seen, so they need no key times (aux: 1 right, -1 left)
    let q = u * 2.0 - 1.0;
    let r = length(q);
    let turn = fract(fract(s.t / ${PERIOD}.0) * ${WHEEL_TURNS}.0);
    let spoke = step(0.55, cos(5.0 * (atan2(q.y, q.x) + s.aux * TAU * turn)));
    s.color = mix(vec3f(0.06), vec3f(0.65), max(spoke, step(r, 0.2)));
    s.color = select(vec3f(0.025), s.color, r < 0.64);
    s.color = mix(s.color, vec3f(0.75), step(abs(r - 0.62), 0.04));
    s.gloss = select(0.15, 0.8, r < 0.66);
  } else if (s.mat == ${MAT_TRAM}u) {
    // the tram's body: aux is 1 on one end, -1 on the other and 0 on the sides
    if (abs(s.aux) > 0.5) {
      // an end: windscreen, route number, and lamps, white at the front and red at the back.  The tram
      // runs east (the -1 end first) in the first half of each period, so the lamps change over then.
      let ahead = (s.aux < 0.0) == (fract(s.t / ${PERIOD}.0) < 0.5);
      let screen = step(abs(u.x - 0.5), 0.4) * step(abs(u.y - 0.64), 0.17);
      let lamp = step(length(vec2f(abs(u.x - 0.5) - 0.34, u.y - 0.2)), 0.05);
      let route = number7((u - vec2f(0.44, 0.85)) / vec2f(0.12, 0.12), 4.0, 1);
      s.color = mix(mix(s.color, vec3f(0.03, 0.045, 0.06), screen), vec3f(1.0, 0.62, 0.12), route);
      s.color = mix(s.color, select(vec3f(1.0, 0.04, 0.02), vec3f(1.0, 0.96, 0.85), ahead), lamp);
      s.emissive = max(lamp, route) * 5.0;
      s.gloss = mix(s.gloss, 0.95, screen);
    } else if (abs(s.n.z) < 0.5) {
      // a side, in metres: a row of windows, lit from inside after sunset, two doors and a stripe
      let p = u * vec2f(12.0, 2.6);
      let door = step(abs(abs(p.x - 6.0) - 2.25), 0.6) * step(0.1, p.y) * step(p.y, 2.25);
      let win = step(abs(fract(p.x / 1.5) - 0.5), 0.42) * step(abs(p.y - 1.75), 0.45);
      let lit = win * step(envDaylight(s.t), 0.5);
      s.color = mix(s.color, vec3f(0.12, 0.45, 0.4), step(abs(p.y - 0.5), 0.12) * (1.0 - door));
      s.color = mix(mix(mix(s.color, vec3f(0.3, 0.32, 0.35), door), vec3f(0.03, 0.045, 0.06), win), vec3f(1.0, 0.86, 0.62), lit);
      s.gloss = mix(s.gloss, 0.95, win - lit);
      s.emissive = lit * 1.4;
    }
  } else if (s.mat == ${MAT_PLATE}u) {
    // the plate under a pylon's clocks: each copy's own number (its data, s.inst.w).  The height
    // plates on the frame of clocks are plain static geometry, which has no data: they carry
    // their number as .tag() instead, in two digits.
    let tagged = s.tag > 0u;
    let d = number7((u - vec2f(0.1, 0.18)) / vec2f(0.8, 0.64), select(s.inst.w, f32(s.tag), tagged), select(3, 2, tagged));
    s.color = mix(s.color, vec3f(0.02), d * step(0.5, abs(s.n.y)));
  } else if (s.mat == ${MAT_STRIPES}u) {
    // stripes on a sphere, whose uv.x goes round it and uv.y from pole to pole: .tag() 0
    // gives white beach-ball gores (the balls), 1 a dark band round the middle (the bob)
    let bob = s.tag == 1u;
    let stripe = select(step(0.5, fract(u.x * 4.0)), step(abs(u.y - 0.5), 0.08), bob);
    s.color = mix(s.color, select(vec3f(0.92), vec3f(0.3, 0.05, 0.03), bob), stripe);
  } else if (s.mat == ${MAT_SCALE}u) {
    // the pendulum's scale: u is the angle, -42 to 42 degrees.  A tick every 5 degrees,
    // longer every 15, and red ones at 40, as far as the pendulum swings.
    let deg = (u.x - 0.5) * 84.0;
    let tick = step(abs(fract(deg / 5.0 + 0.5) - 0.5), 0.04);
    let major = step(abs(fract(deg / 15.0 + 0.5) - 0.5), 0.014);
    let ink = select(vec3f(0.05), vec3f(0.75, 0.08, 0.05), abs(abs(deg) - 40.0) < 0.25);
    s.color = mix(s.color, ink, tick * step(0.5 - 0.5 * major, u.y));
  } else if (s.mat == ${MAT_BEAM}u) {
    // The lighthouse's beam: a cone drawn as added light, both of its sides.  To look like lit
    // haze rather than a sheet, it is bright where a line of sight crosses much of it (through
    // its middle, where the cone faces the eye; at its edges the eye only grazes it) and near
    // the lamp (its uv.y is 0 there and 1 at the far end), and fainter by day than by night.
    let across = abs(dot(s.n, s.view));
    s.emissive = across * (1.0 - u.y) * mix(1.2, 0.4, envDaylight(s.t));
  } else if (s.mat == ${MAT_STAFF}u) {
    // the posts of the frame of clocks, painted like a surveyor's pole: red and white a metre
    // each, from the ground up, with a black line at every 10 m
    let z = s.pos.z;
    let ten = 1.0 - smoothstep(0.05, 0.05 + fw3.z, abs(z - 10.0 * round(z / 10.0)));
    s.color = mix(select(vec3f(0.78, 0.78, 0.76), vec3f(0.6, 0.05, 0.035), fract(z * 0.5) < 0.5), vec3f(0.02), ten);
  } else if (s.mat == ${MAT_CONCRETE}u) {
    // cast concrete: the joints its formwork left, panels 2.4 m long and a metre high (so that a
    // wall along the ramp is lined at every metre of height), a mottle, and a darker top
    let alongY = abs(s.n.x) > 0.5;
    let q = abs(fract(vec2f(select(s.pos.x, s.pos.y, alongY) / 2.4, s.pos.z) + 0.5) - 0.5) * vec2f(2.4, 1.0);
    let px = q / max(vec2f(select(fw.x, fw.y, alongY), fw3.z), vec2f(1e-4));
    let joint = (1.0 - saturate(min(px.x, px.y) - 0.5)) * step(abs(s.n.z), 0.5);
    let mottle = 0.9 + 0.18 * noise2(vec2f(select(s.pos.x, s.pos.y, alongY), s.pos.z) * 1.7);
    s.color *= mottle * (1.0 - 0.4 * joint) * select(1.0, 0.78, s.n.z > 0.5);
  } else if (s.mat == ${MAT_BLOCK}u && abs(s.n.z) < 0.5) {
    // The scattered blocks are buildings: on their walls a window every 2.8 m along and 3.2 m up,
    // laid out in world coordinates (a copy's uv runs 0..1 across a face however it is scaled).
    // After sunset each window lights at a moment of its own, from a hash of the window and of
    // its copy's tint, which differs from block to block; some stay dark.  So at dusk a view
    // tilted sideways has more windows lit on its later side.  A hangar (its copy's number,
    // s.inst.w, is 1) has one row of windows high up, and below them doors in panels 1.4 m wide.
    let along = select(s.pos.x, s.pos.y, abs(s.n.x) > 0.5);
    let hangar = s.inst.w > 0.5;
    let cell = vec2f(along / 2.8, s.pos.z / 3.2);
    let f = fract(cell);
    let win = step(abs(f.x - 0.5), 0.26) * select(step(abs(f.y - 0.55), 0.2), step(abs(s.pos.z - 9.3), 0.5), hangar);
    let seam = select(0.0, step(0.93, fract(along / 1.4)) * step(s.pos.z, 7.5), hangar);
    let h = hash21(floor(cell) + s.inst.x * 97.0);
    let lit = win * step(h, 0.75) * step(0.15 + h, 1.0 - envDaylight(s.t));
    s.color = mix(mix(s.color * (1.0 - 0.5 * seam), vec3f(0.05, 0.06, 0.075), win), vec3f(1.0, 0.72, 0.4), lit);
    s.gloss = 0.7 * win;
    s.emissive = lit * 1.5;
  } else if (s.mat == ${MAT_COUNT}u && abs(s.n.z) < 0.5) {
    // The monoliths and the cube that come and go count down on each side the whole seconds
    // they have left: a monolith (.tag() its number k) is there from 2k to 2k + 6 s of every 12,
    // the cube (.tag() 9) from 10 to 30 s of every 60.  So a player can see one coming to its
    // end, and in a tilted view watch the cut that takes it away pass across it after its 1.
    let cube = s.tag == 9u;
    let left = select(6.0 - fract((s.t - 2.0 * f32(s.tag)) / 12.0) * 12.0, 20.0 - fract((s.t - 10.0) / 60.0) * 60.0, cube);
    let box = select(vec4f(0.2, 0.55, 0.6, 0.25), vec4f(0.15, 0.3, 0.7, 0.4), cube);
    let d = number7((u - box.xy) / box.zw, ceil(left), select(1, 2, cube));
    s.color = mix(s.color, vec3f(0.95), d);
    s.emissive = d * 0.5;
  }
  return s;
}
`;

// A vertical panel of size w x h whose front faces -Y, standing on z = 0.
const panel = (w, h) => Geo.plane(w, h).rotateX(Math.PI / 2).translate(0, 0, h / 2);

// A bar from p to q (a strut, a rail, a post), `size` across: a tube of four sides without ends,
// built along +Z, laid along +Y and then turned by `m4.facing` to point from p to q.  A box would
// take 24 vertices, this takes 10, and every vertex of static geometry is 44 bytes to store and
// to load; as thin as these are, its smooth normals make it pass for round.
function bar(p, q, size) {
  const d = [0, 1, 2].map((k) => q[k] - p[k]);
  return Geo.cylinder(size / 2, Math.hypot(...d), 4, { caps: false }).rotateX(-Math.PI / 2).transform(m4.facing(p, d));
}

// A car, built with +Y forward (the way `follow` carries it).  Moving meshes cost three tetrahedra
// per triangle per key time, so lamps, windows, number and hubs are painted on by the shader.
function car(color, number) {
  const g = new Geo();
  // the body: .aux() marks its front face 1 and its back face -1, for the head and tail lamps,
  // and .tag() carries the car's number
  g.add(Geo.box(1.8, 4.2, 0.55).aux((p, n) => n[1]).tag(number).translate(0, 0, 0.6).color(color).gloss(0.7).mat(MAT_CAR));
  // the cabin: its side view (along the car, up) extruded across the car and turned so
  // that the profile stands along Y and Z; .aux() marks its two sides
  const cab = Geo.extrude([[-1.5, 0], [0.9, 0], [0.35, 0.55], [-1.2, 0.55]], 1.6).translate(0, 0, -0.8);
  g.add(cab.rotateX(Math.PI / 2).rotateZ(Math.PI / 2).aux((p, n) => n[0]).translate(0, 0, 0.87).color(color).gloss(0.7).mat(MAT_CAB));
  for (const [x, y] of [[-1, 1.3], [1, 1.3], [-1, -1.3], [1, -1.3]]) {
    // a wheel: a plain tread, and an outer face on which the shader paints tyre and hub
    const w = Geo.cylinder(WHEEL_R, 0.26, 8, { caps: false }).translate(0, 0, -0.13).color('#15161a');
    w.add(Geo.disc(WHEEL_R, 8).translate(0, 0, 0.13).aux(x).mat(MAT_WHEEL));
    g.add(w.rotateY(Math.PI / 2).rotateZ(x < 0 ? Math.PI : 0).translate(0.84 * x, y, WHEEL_R));
  }
  return g;
}

export default {
  id: 'lab',
  name: 'Time Lab',
  blurb: 'A test range of clocks, traffic and pendulums. Every clock shows the moment you are seeing it at.',
  C: 10,
  mode: 'walk',
  modes: ['walk', 'drive', 'fly', 'swim'],
  spawn: { pos: [0, -30, 0], t: 0, yaw: 0 },
  ground,
  period: PERIOD,
  viewDistance: 700,
  // about where the fog has swallowed everything, so the horizon matches the sky
  skyDistance: 900,
  wgsl,

  // The music (see "Music" in docs/SCENES.md).
  // The Time Lab: clockwork.  A tick on every second of scene time, so that
  // it keeps step with the clocks on the runway, and a figure of struck bars
  // going round four chords.
  music: {
    seconds: 32, bpm: 120, reverb: 1.8, echo: [0.375, 0.28], seed: 11,
    build(m) {
      const { notes } = m;
      const clock = m.track({ gain: 0.9, hall: 0.12 });
      const left = m.track({ pan: -0.35, hall: 0.25, echo: 0.22 }), right = m.track({ pan: 0.35, hall: 0.25, echo: 0.22 });
      const soft = m.track({ hall: 0.5 }), high = m.track({ pan: 0.15, hall: 0.7, echo: 0.3 });
      for (let s = 0; s < 32; s++) m.tick(clock, s, s % 4 === 0 ? 1.3 : 0.95, s % 2 ? 1900 : 2500);
      const chords = ['A3 C4 E4 A4 C5 E5', 'F3 A3 C4 F4 A4 C5', 'D3 F3 A3 D4 F4 A4', 'E3 G3 B3 E4 G4 B4'].map(notes);
      const figure = [0, 2, 3, 2, 4, 2, 3, 1];
      chords.forEach((ch, k) => {
        const t0 = k * 8;
        m.pad(soft, t0, 8, [ch[0], ch[1], ch[2], ch[3]], { type: 'triangle', cutoff: 1100, gain: 0.07, a: 1.5, r: 1.5 });
        for (const t of [t0, t0 + 4]) m.tone(soft, t, 3.2, ch[0] - 12, { gain: 0.07, a: 0.02, d: 1.5, s: 0.4, r: 0.8 });
        for (let i = 0; i < 32; i++) {
          m.bell(left, t0 + i * 0.25, ch[figure[i % 8]], { partials: 'bars', gain: i % 4 === 0 ? 0.27 : 0.19, decay: 0.5 });
          // the same figure three quavers later and an octave up, on the other side
          if (k % 2 === 1 || i >= 16) m.bell(right, t0 + (i + 3) * 0.25, ch[figure[i % 8]] + 12, { partials: 'bars', gain: 0.13, decay: 0.4 });
        }
        m.bell(high, t0, ch[4] + 12, { partials: 'glass', gain: 0.1, decay: 3 });
        m.bell(high, t0 + 5, ch[5] + 12, { partials: 'glass', gain: 0.07, decay: 3 });
      });
    },
  },

  build(b) {
    const rand = rng(7);

    // ground: subdivided, because near a tilt of 90 degrees everything is stretched
    // enormously along the direction of the tilt and huge triangles lose precision
    b.static(Geo.plane(3000, 3000, 30, 30).color('#5d6a5a').mat(MAT_GROUND));

    // runway pylons, each with a clock on both faces and a chasing beacon.  The
    // pylon is built once and drawn at every placement with b.instances.
    const pylon = new Geo();
    pylon.add(Geo.box(0.35, 0.35, 3.2).translate(0, 0, 1.6).color('#8b939c'));
    pylon.add(Geo.box(0.9, 0.9, 0.08).translate(0, 0, 0.04).color('#70777f'));   // base plate
    pylon.add(Geo.box(0.14, 0.26, 0.36).translate(0.245, 0, 1.0).color('#5b6168')); // junction box
    pylon.add(Geo.box(2.7, 0.24, 1.3).translate(0, 0, 3.75).color('#22262c'));
    pylon.add(Geo.box(2.8, 0.6, 0.05).translate(0, 0, 4.42).color('#22262c'));     // a hood over the displays
    pylon.add(panel(2.5, 1.1).translate(0, -0.13, 3.2).mat(MAT_CLOCK));
    pylon.add(panel(2.5, 1.1).rotateZ(Math.PI).translate(0, 0.13, 3.2).mat(MAT_CLOCK));
    // a plate on which the shader writes each copy's own number (MAT_PLATE)
    pylon.add(Geo.box(0.5, 0.41, 0.26).translate(0, 0, 2.6).color('#e8e4d8').mat(MAT_PLATE));
    // small parts: bolts in the base plate, a cable from the junction box, a stem for the lamp
    const parts = new Geo(), bolt = Geo.box(0.07, 0.07, 0.05).color('#a3aab1');
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.add(bolt, m4.translation(0.34 * x, 0.34 * y, 0.1));
    parts.add(Geo.box(0.05, 0.05, 1.92).translate(0.2, 0.06, 2.14).color('#24272c'));
    parts.add(Geo.cylinder(0.06, 0.25, 6, { caps: false }).translate(0, 0, 4.4).color('#5b6168'));
    const pylons = [], lamps = [];
    for (let i = 0; i <= 20; i++) {
      const y = i * 20;
      for (const x of [-6, 6]) {
        // `data` is a number of the scene's own for each copy: here its distance down the runway
        pylons.push({ transform: m4.translation(x, y, 0), data: y });
        // a lamp that is lit for 0.4 s out of every 2 s, a little later at each
        // pylon: a copy can have a time window of its own
        lamps.push({ transform: m4.translation(x, y, 4.75), from: i * 0.1, to: i * 0.1 + 0.4, period: 2 });
      }
    }
    b.instances(pylon, pylons);
    // The small parts go at the same places, but `within: 30` draws them only for the copies
    // within 30 m of the viewer (tested a cluster at a time): beyond that a 7 cm bolt is a
    // pixel or two, not worth its triangles and draw calls.
    b.instances(parts, pylons, { within: 30 });
    b.instances(Geo.sphere(0.22, 10, 6).color('#7fe3ff').emissive(14), lamps);

    // runway edge lights between the pylons, and green ones across the threshold: the
    // tint colours each copy's lamp, while the post keeps its colour (.untinted())
    const fitting = Geo.box(0.06, 0.06, 0.24).translate(0, 0, 0.12).color('#4d535a').untinted();
    fitting.add(Geo.box(0.14, 0.14, 0.08).translate(0, 0, 0.28).color('#ffffff').emissive(4));
    const edgeLights = [];
    for (let y = -30; y < 400; y += 20) for (const x of [-4.3, 4.3]) edgeLights.push({ transform: m4.translation(x, y, 0), tint: '#fff1cc' });
    for (let x = -3.5; x <= 3.5; x++) edgeLights.push({ transform: m4.translation(x, -40.3, 0), tint: '#5dff7a' });
    b.instances(fitting, edgeLights, { solid: false });

    // clock tower with an analogue dial; the hand goes round once a minute
    {
      const [tx, ty] = [28, 120];
      const g = new Geo();
      g.add(Geo.box(7, 7, 30).translate(0, 0, 15).color('#b9a58c'));
      g.add(Geo.box(8, 8, 0.4).translate(0, 0, 0.2).color('#9d8c77'));     // a plinth, low enough to step onto
      g.add(Geo.box(7.6, 7.6, 0.6).translate(0, 0, 29.7).color('#9d8c77')); // a cornice
      g.add(Geo.cone(6.2, 7, 4).rotateZ(Math.PI / 4).translate(0, 0, 30).color('#7a3b2e'));
      g.add(panel(5.5, 2.4).translate(0, -3.52, 17).mat(MAT_CLOCK));
      g.add(Geo.box(6.6, 0.1, 6.6).translate(0, -3.5, 24.5).color('#8e7d68'));  // the dial's surround
      g.add(Geo.disc(2.9, 48).rotateX(Math.PI / 2).translate(0, -3.57, 24.5).mat(MAT_DIAL));
      g.add(Geo.cylinder(0.22, 0.15, 8).rotateX(Math.PI / 2).translate(0, -3.6, 24.5).color('#2a2a2a')); // the hand's hub
      g.add(Geo.box(1.5, 0.06, 2.5).translate(0, -3.52, 1.65).color('#4a2f22'));  // the door, and a lamp over it
      g.add(Geo.box(0.3, 0.24, 0.3).translate(0, -3.62, 3.6).color('#fff1c9').emissive(3));
      b.static(g.translate(tx, ty, 0));
      // The door's frame and handle are parts a few centimetres deep: `within: 100` leaves them
      // out whenever the viewer is further away than that (as at the start, 150 m off), where
      // they would be a pixel or two.  One call per building: the distance is to its bounds.
      const d = new Geo();
      for (const x of [-0.88, 0.88]) d.add(Geo.box(0.26, 0.2, 2.8).translate(x, -3.55, 1.8));
      d.add(Geo.box(2.02, 0.2, 0.3).translate(0, -3.55, 3.05)).color('#9d8c77');
      d.add(Geo.box(0.05, 0.08, 0.3).translate(0.55, -3.58, 1.5).color('#c9b037').gloss(0.8));
      b.static(d.translate(tx, ty, 0), { within: 100 });
      // The hand turns once a minute, over and over, in one place: a `cycle` of one turn in 120
      // poses (one every half second).  It is stiff and the turn only moves it (`cycle.transform`,
      // with no `geo` function and no paint), so it is kept as the mesh, once, and a matrix of 64
      // bytes for each pose; `times` has only to follow where it is taken, which is nowhere.  That
      // is the way to keep anything stiff that does the same thing over and over.
      const hand = Geo.box(0.16, 0.1, 2.6).translate(0, 0, 1.1).color('#b3271e');
      b.dynamic(hand, {
        times: [0, PERIOD],
        transform: () => m4.translation(tx, ty - 3.63, 24.5),
        caps: 'none',
        // seen from the front (-Y side), clockwise means turning from +Z towards +X
        cycle: { period: PERIOD, keys: 120, transform: (u) => m4.rotationY(2 * Math.PI * u) },
      });
    }

    // A frame of clocks one above another, every 10 m of height, for the tilt up and down: with
    // the view tilted up by 45 degrees each reads a second later than the one below it.  The
    // lowest is at a walker's eye height, so it shows a walker on the ground their own time, and
    // the second does the same for one on the platform behind the frame, 10 m up, which the ramp
    // beside it climbs (see `ground` at the head of the file).  The clocks on the back of the
    // frame face the platform.  The walk up in such a view takes the walker a second on, over and
    // above the time that passes anyway: they come up at the moment the second clock showed them
    // from below.
    {
      const [fx, fy] = [-41, 39.6];
      const g = new Geo();
      // The posts are measuring poles (MAT_STAFF paints them by height), and at every 10 m a plate
      // beside the right one gives the height in metres.  Between the clocks, cross-bracing.
      for (const x of [-3.45, 3.45]) g.add(Geo.box(0.4, 0.4, 34).translate(x, 0, 17).mat(MAT_STAFF));
      g.add(Geo.box(7.3, 0.4, 0.4).translate(0, 0, 34.2).color('#8b939c'));
      for (let k = 0; k < 4; k++) {
        const z = EYE + 10 * k;
        g.add(Geo.box(6.5, 0.3, 3).translate(0, 0, z).color('#22262c'));
        g.add(Geo.box(6.7, 0.7, 0.06).translate(0, 0, z + 1.53).color('#22262c'));  // a hood over the displays
        g.add(panel(6, 2.6).translate(0, -0.16, z - 1.3).mat(MAT_CLOCK));
        g.add(panel(6, 2.6).rotateZ(Math.PI).translate(0, 0.16, z - 1.3).mat(MAT_CLOCK));
        if (k === 0) continue;
        g.add(Geo.box(1.7, 0.08, 1.0).translate(4.5, 0, 10 * k).color('#e8e4d8').tag(10 * k).mat(MAT_PLATE));
        const [lo, hi] = [z - 8.4, z - 1.55];
        for (const s of [-1, 1]) g.add(bar([-3.25 * s, 0, lo], [3.25 * s, 0, hi], 0.18).color('#8b939c'));
      }
      g.add(Geo.sphere(0.3, 8, 4).translate(0, 0, 34.7).color('#ff4a36').emissive(6)); // a lamp on top
      b.static(g.translate(fx, fy, 0));
      // The platform and the ramp: walls 0.25 m thick and 0.6 m higher than what they stand round,
      // so that their tops are a parapet, and the surfaces to walk on, laid exactly on `ground`
      // and drawn with the ground's material (its metre grid).  A wall along the ramp is its side
      // view (along y, up) extruded and turned to stand along Y and Z, as the cars' cabins are.
      const [r, d, w] = [RAMP, DECK, 0.25], top = d.z + 0.6;
      const side = (profile, x) => Geo.extrude(profile, w).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(x, 0, 0);
      const walls = new Geo();
      walls.add(side([[r.y0, 0], [d.y1, 0], [d.y1, top], [d.y0, top], [r.y0, 0.6]], r.x0));
      walls.add(side([[r.y0, 0], [r.y1, 0], [r.y1, top], [r.y0, 0.6]], r.x1 - w));
      walls.add(Geo.box(d.x1 - r.x1 + w, w, top).translate((r.x1 - w + d.x1) / 2, d.y0 + w / 2, top / 2));
      walls.add(Geo.box(w, d.y1 - d.y0, top).translate(d.x1 - w / 2, (d.y0 + d.y1) / 2, top / 2));
      walls.add(Geo.box(d.x1 - d.x0, w, top).translate((d.x0 + d.x1) / 2, d.y1 - w / 2, top / 2));
      b.static(walls.color('#9e9d94').mat(MAT_CONCRETE));
      // A handrail along the middle of each wall's top, 0.45 m above it, on posts about 2.5 m apart.
      // `at` is a point that far above the top of the wall at (x, y), which climbs with the ramp.
      const rails = new Geo(), RAIL = 0.45;
      const at = (x, y, dz) => [x, y, (y >= d.y0 ? top : 0.6 + d.z * (y - r.y0) / (r.y1 - r.y0)) + dz];
      const runs = [[r.x0 + w / 2, r.y0, r.x0 + w / 2, d.y1], [r.x1 - w / 2, r.y0, r.x1 - w / 2, r.y1],
        [r.x1 - w, d.y0 + w / 2, d.x1, d.y0 + w / 2], [d.x1 - w / 2, d.y0, d.x1 - w / 2, d.y1], [d.x0, d.y1 - w / 2, d.x1, d.y1 - w / 2]];
      for (const [x0, y0, x1, y1] of runs) {
        // the rail is straight from end to end, but bends where a wall along the ramp levels off
        const corners = [[x0, y0], ...(y0 < d.y0 && y1 > d.y0 ? [[x0, d.y0]] : []), [x1, y1]];
        for (let i = 1; i < corners.length; i++) rails.add(bar(at(...corners[i - 1], RAIL), at(...corners[i], RAIL), 0.07));
        const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2.5);
        for (let i = 0; i <= n; i++) {
          const [x, y] = [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n];
          rails.add(bar(at(x, y, 0), at(x, y, RAIL), 0.06));
        }
      }
      b.static(rails.color('#8f969d').gloss(0.5));
      const floor = Geo.quad([r.x0, r.y0, 0], [r.x1, r.y0, 0], [r.x1, r.y1, d.z], [r.x0, r.y1, d.z]);
      floor.add(Geo.plane(d.x1 - d.x0, d.y1 - d.y0).translate((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, d.z));
      b.static(floor.color('#8e928c').mat(MAT_GROUND));
    }

    // a stencil clock left of the start: a sheet whose digits are holes (see `cutout`
    // in the shader), so the sun shining through it writes the time on the ground
    {
      const g = panel(4.5, 1.8).translate(0, 0, 2.1).doubleSided().cutout().color('#2b3038').mat(MAT_STENCIL);
      g.add(Geo.box(0.2, 0.2, 3.9).translate(-2.35, 0, 1.95).color('#59606a'));
      g.add(Geo.box(0.2, 0.2, 3.9).translate(2.35, 0, 1.95).color('#59606a'));
      b.static(g, { transform: m4.mul(m4.translation(-20, -24, 0), m4.rotationZ(1.0)) });
    }

    // three cars circling a rounded block: the loop takes exactly one period
    {
      const bumpers = Geo.box(1.9, 0.16, 0.2).translate(0, 2.1, 0.42).add(Geo.box(1.9, 0.16, 0.2).translate(0, -2.1, 0.42)).color('#2b2e33');
      ['#c8402f', '#2f6fc8', '#e0b530'].forEach((color, i) => {
        const motion = {
          times: timeRange(0, PERIOD, 0.4),
          transform: follow(LOOP, { speed: LOOP.length / PERIOD, offset: i * LOOP.length / 3, span: 5 }),
          caps: 'none',
        };
        b.dynamic(car(color, [12, 27, 45][i]), motion);
        // The bumpers move with the car, but `within: 40` draws them only while the viewer is
        // within 40 m of that stretch of the loop; beyond, the shader's dark strip will do.
        b.dynamic(bumpers, { ...motion, within: 40 });
      });
      b.static(Geo.box(110, 22, 0.3).translate(0, 70, 0.15).color('#3f5a3a'));
    }

    // a tram shuttling in a straight line: constant velocity needs only two keys per leg,
    // so it can afford more triangles than the cars.  Its rails lie on the ground.
    {
      // the body: .aux() marks its two ends 1 and -1, for the shader's windscreens and lamps
      const tram = Geo.box(2.6, 12, 2.6).aux((p, n) => n[1]).translate(0, 0, 1.9).color('#d8d2c4').gloss(0.5).mat(MAT_TRAM);
      for (const y of [-3.8, 3.8]) tram.add(Geo.box(2.2, 2.6, 0.6).translate(0, y, 0.32).color('#30343a')); // bogies
      tram.add(Geo.box(1.4, 3.4, 0.3).translate(0, 1.5, 3.35).color('#8a9099'));                           // roof gear
      // a pantograph on the roof gear, its head pressed up against the overhead wire
      const pan = Geo.merge(bar([0, 0.3, 3.5], [0, 2.2, 4.4], 0.08), bar([0, 2.2, 4.4], [0, 1.0, 5.46], 0.06), bar([-0.75, 1.0, 5.48], [0.75, 1.0, 5.48], 0.06));
      tram.add(pan.color('#2b2e33'));
      const xs =[[0, -120], [26, 120], [30, 120], [56, -120], [60, -120]];
      const xAt = (t) => {
        for (let i = 1; i < xs.length; i++) {
          if (t <= xs[i][0]) return xs[i - 1][1] + (xs[i][1] - xs[i - 1][1]) * (t - xs[i - 1][0]) / (xs[i][0] - xs[i - 1][0]);
        }
        return xs[xs.length - 1][1];
      };
      b.dynamic(tram, {
        times: xs.map((k) => k[0]),
        transform: (t) => m4.mul(m4.translation(xAt(t), 140, 0), m4.rotationZ(Math.PI / 2)),
        caps: 'none',
      });
      const rails = new Geo();
      for (const y of [139.28, 140.72]) for (const x of [-65, 65]) rails.add(Geo.box(130, 0.08, 0.12).translate(x, y, 0.06));
      b.static(rails.color('#8d9299').gloss(0.8));
      // the overhead line: masts beside the track (none on the runway), each with an arm over it,
      // and the wire hung from arm to arm at the height of the pantograph's head
      const line = new Geo(), masts = [-128, -100, -70, -40, -12, 12, 40, 70, 100, 128];
      masts.forEach((x, i) => {
        line.add(bar([x, 142.4, 0], [x, 142.4, 5.8], 0.2));
        line.add(bar([x, 142.5, 5.6], [x, 139.8, 5.6], 0.08));
        if (i > 0) line.add(bar([masts[i - 1], 140, 5.53], [x, 140, 5.53], 0.03));
      });
      b.static(line.color('#4d535a'));
    }

    // bouncing balls, each over and over in one place: a cycle again, of one bounce in twelve
    // poses, the first of them where the ball lands and the motion kinks.  A bounce is kept as
    // twelve matrices, 768 bytes, however long it goes on; on plain keys, one every twelfth of a
    // bounce for the whole period, it would be 145 to 361 of them.  (What it costs to draw is in
    // the note on the lighthouse's beam.)
    for (let i = 0; i < 4; i++) {
      const bounce = [2, 3, 4, 5][i], height = [3, 5, 8, 12][i], x = -14 - i * 3;
      const ball = Geo.sphere(0.6, 8, 5).color(['#e4572e', '#17bebb', '#ffc914', '#76b041'][i]).gloss(0.6).mat(MAT_STRIPES);
      const hop = (u) => m4.translation(0, 0, height * 4 * u * (1 - u)); // u: how much of the bounce is done
      b.dynamic(ball, { times: [0, PERIOD], transform: () => m4.translation(x, 20, 0.6), caps: 'none', cycle: { period: bounce, keys: 12, transform: hop } });
      // behind it a measuring pole as tall as its bounce, painted as the frame of clocks' posts
      // are, with an arm that the top of the ball just reaches
      const top = height + 1.2;
      b.static(Geo.merge(bar([x, 21.2, 0], [x, 21.2, top + 0.05], 0.14).mat(MAT_STAFF), bar([x, 21.25, top + 0.03], [x, 20.45, top + 0.03], 0.06).color('#22262c')));
    }

    // windmill
    {
      const [wx, wy] = [-40, 150];
      b.static(Geo.cylinder(1.6, 22, 12, { r2: 0.9 }).translate(wx, wy, 0).color('#e8e4da'));
      b.static(Geo.box(1.6, 2.2, 1.6).translate(wx, wy - 0.4, 22).color('#e8e4da')); // the nacelle
      b.static(Geo.sphere(1.0, 8, 4).translate(wx, wy - 1.9, 22).color('#c44536'));  // the hub (a ball: it need not turn)
      // A blade: a board 0.9 x 0.2 m and 13 m long (its inner end is in the hub), with its long
      // faces in three lengths: a long triangle that turns comes out bent between poses, more so
      // the more its ends move from one to the next.  The blades turn once every 6 s.  One
      // blade's turn is a `cycle` of 36 poses (one every 10 degrees), stored once; the three
      // blades are three copies of it, each a third of a turn (2 s) further on.  (A round of a
      // third of a turn would not do: after its last pose comes its first, and each blade would
      // go back to where it started.)
      const blade = new Geo();
      for (const [sx, half, turn] of [[0.9, 0.1, 0], [0.9, 0.1, Math.PI], [0.2, 0.45, Math.PI / 2], [0.2, 0.45, -Math.PI / 2]]) {
        blade.add(Geo.plane(sx, 13, 1, 3).rotateX(Math.PI / 2).translate(0, -half, 6.5).rotateZ(turn));
      }
      blade.add(Geo.plane(0.9, 0.2).translate(0, 0, 13)).color('#f4f1ea');
      for (let k = 0; k < 3; k++) {
        b.dynamic(blade, {
          times: [0, PERIOD],
          transform: () => m4.translation(wx, wy - 1.9, 22),
          caps: 'none',
          cycle: { period: 6, keys: 36, start: -2 * k, transform: (u) => m4.rotationY(2 * Math.PI * u) },
        });
      }
    }

    // pendulum under a gantry, hanging from a pin in a bracket, with a scale under its arc
    {
      const [px, py, top] = [14, 40, 9], pivot = top - 0.45;
      const g = new Geo();
      // A-frames of tube at the ends, with a tie between the legs at the height of the scale's ends
      for (const x of [-5.4, 5.4]) {
        for (const y of [-1.8, 1.8]) g.add(bar([x, y, 0], [x, y * 0.05, top], 0.3));
        g.add(bar([x, -1.26, 2.7], [x, 1.26, 2.7], 0.16));
      }
      g.add(Geo.box(11.2, 0.4, 0.4).translate(0, 0, top));
      for (const y of [-0.09, 0.09]) g.add(Geo.box(0.3, 0.05, 0.5).translate(0, y, pivot));
      g.add(Geo.cylinder(0.04, 0.3, 6).rotateX(Math.PI / 2).translate(0, 0.15, pivot));
      // the scale: a strip of 12 panels, bent into an arc round the pivot by moving its
      // vertices, just beyond the reach of the bob and with its ends in the posts
      const scale = Geo.plane(1, 1, 12, 1).rotateX(Math.PI / 2);
      for (let i = 0; i < scale.p.length; i += 3) {
        const a = scale.p[i] * 84 * Math.PI / 180, r = 7.85 + 0.5 * (0.5 - scale.p[i + 2]);
        scale.p[i] = r * Math.sin(a); scale.p[i + 2] = pivot - r * Math.cos(a);
      }
      b.static(g.color('#4a6380').add(scale.color('#e9e6dc').mat(MAT_SCALE)).translate(px, py, 0));
      const bob = new Geo();
      // the rod in three lengths: a long triangle that turns comes out bent between poses, more so
      // the more its ends move from one pose to the next
      bob.add(Geo.tube([[0, 0, 0], [0, 0, -7 / 3], [0, 0, -14 / 3], [0, 0, -7]], 0.042, 4, { caps: false }).rotateZ(Math.PI / 4).color('#c9ccd1'));
      bob.add(Geo.sphere(0.7, 8, 5).translate(0, 0, -7).color('#d4a017').gloss(0.9).mat(MAT_STRIPES).tag(1));
      // It swings once every 4 s, 0.7 rad either way, and hangs where it is: one swing is a
      // cycle of twenty poses (one every 0.2 s), and `times` has only to say that it stays put.
      b.dynamic(bob, {
        times: [0, PERIOD],
        transform: () => m4.translation(px, py, pivot),
        caps: 'none',
        cycle: { period: 4, keys: 20, transform: (u) => m4.rotationY(0.7 * Math.sin(2 * Math.PI * u)) },
      });
    }

    // A row of seven smaller pendulums, swinging in step with that one (once every 4 s) until
    // a tilt puts them out of step: the ones further to the right are then seen later.  The
    // swing is a `cycle` as the big one's is, of eight poses, and as the seven are the same mesh
    // with the same poses they share it: the mesh and its eight matrices are stored once, and
    // each pendulum adds only where it hangs.  The rod is in two lengths, as the big one's is in
    // three.
    {
      const L = 9.81 * (4 / (2 * Math.PI)) ** 2, pivot = 4.7, swing = 0.26; // 3.97 m swings in 4 s
      const [x0, y0, gap, n] = [10.5, 2, 2.2, 7];
      const bob = Geo.tube([[0, 0, 0], [0, 0, -L / 2], [0, 0, -L]], 0.025, 3, { caps: false }).color('#c9ccd1');
      bob.add(Geo.sphere(0.28, 8, 5).translate(0, 0, -L).color('#d4a017').gloss(0.9).mat(MAT_STRIPES).tag(1));
      const frame = new Geo();
      for (const x of [x0 - 1.2, x0 + (n - 1) * gap + 1.2]) {
        for (const y of [-1.2, 1.2]) frame.add(bar([x, y0 + y, 0], [x, y0 + y * 0.05, pivot + 0.25], 0.2));
        frame.add(bar([x, y0 - 0.85, 1.4], [x, y0 + 0.85, 1.4], 0.1));
      }
      frame.add(Geo.box((n - 1) * gap + 2.65, 0.25, 0.25).translate(x0 + (n - 1) * gap / 2, y0, pivot + 0.125));
      b.static(frame.color('#4a6380'));
      for (let i = 0; i < n; i++) {
        b.dynamic(bob, {
          times: [0, PERIOD],
          transform: () => m4.translation(x0 + i * gap, y0, pivot),
          caps: 'none',
          // in time with the big pendulum, 0.26 rad either way: a pose every eighth of a swing
          cycle: { period: 4, keys: 8, transform: (u) => m4.rotationY(swing * Math.sin(2 * Math.PI * u)) },
        });
      }
    }

    // monoliths that exist for only part of the time, each counting down the seconds it has left
    // (MAT_COUNT): a tilted slice cuts them open
    for (let i = 0; i < 5; i++) {
      const g = Geo.box(3, 3, 9).translate(20 + i * 7, 10, 4.5).color(['#6c5ce7', '#00b894', '#e17055', '#0984e3', '#fdcb6e'][i]);
      b.static(g.mat(MAT_COUNT).tag(i), { from: i * 2, to: i * 2 + 6, period: 12 });
    }

    // a cube that pops into existence, drifts and pops out again (sealed with caps), counting down
    b.dynamic(Geo.box(4).color('#e84393').gloss(0.4).mat(MAT_COUNT).tag(9), {
      times: [10, 30],
      transform: (t) => m4.translation(-26 + (t - 10) * 0.6, 45, 2 + (t - 10) * 0.1),
    });
    // ... and a sphere that grows out of nothing and shrinks back (needs no caps)
    b.dynamic(Geo.sphere(1, 16, 10).color('#00cec9').gloss(0.8), {
      times: timeRange(35, 55, 0.5),
      transform: (t) => m4.mul(m4.translation(-26, 60, 3), m4.scaling(3 * Math.sin((t - 35) / 20 * Math.PI))),
      caps: 'none',
    });

    // a lighthouse, and its beam: additive geometry sweeping round every 10 s
    {
      const [lx, ly, lz] = [-60, 20, 14.9];
      // the tower, with two red bands a hair proud of it (so that the two do not fight over the
      // same pixels), a gallery with a rail round it, and the lantern: glazing bars round the
      // lamp under a roof
      const g = Geo.cylinder(1.4, 14, 12, { r2: 1.0 }).color('#f1ece2');
      const radius = (z) => 1.412 - 0.4 * z / 14;
      for (const z of [3.5, 8.5]) g.add(Geo.cylinder(radius(z), 2.2, 12, { r2: radius(z + 2.2), caps: false }).translate(0, 0, z).color('#b3271e'));
      const iron = new Geo();
      iron.add(Geo.cylinder(1.65, 0.2, 16).translate(0, 0, 13.95));
      iron.add(Geo.torus(1.6, 0.035, 16, 4).translate(0, 0, 15.0));
      for (let i = 0; i < 10; i++) {
        const [c, s] = [Math.cos(i * Math.PI / 5), Math.sin(i * Math.PI / 5)];
        iron.add(bar([1.6 * c, 1.6 * s, 14.15], [1.6 * c, 1.6 * s, 15.0], 0.05));
      }
      for (let i = 0; i < 8; i++) {
        const [c, s] = [Math.cos((i + 0.5) * Math.PI / 4), Math.sin((i + 0.5) * Math.PI / 4)];
        iron.add(bar([0.75 * c, 0.75 * s, 14.15], [0.75 * c, 0.75 * s, 15.6], 0.09));
      }
      iron.add(Geo.cylinder(0.82, 0.12, 8).rotateZ(Math.PI / 8).translate(0, 0, 15.55));
      iron.add(Geo.sphere(0.12, 6, 4).translate(0, 0, 16.45));
      g.add(iron.color('#33383e'));
      g.add(Geo.cone(0.95, 0.8, 8).rotateZ(Math.PI / 8).translate(0, 0, 15.67).color('#7a3b2e'));
      g.add(Geo.sphere(0.5, 12, 8).translate(0, 0, lz).color('#fff2b0').emissive(10));
      b.static(g.translate(lx, ly, 0));
      // The beam is stiff and goes round six times in the period, yet it stays on plain keys (one
      // every 0.125 s, 481 matrices).  A cycle of one turn would keep a sixth of that, but would
      // cost more to draw: which of a cycle's poses a slice can touch is worked out from the box
      // round all of them, here a circle 120 m across that a tilted slice stays near for many
      // seconds, where each stretch between two plain keys has a box of its own.  Measured with
      // tools/cost.mjs, the view from the start tilted 75 degrees drew nearly a third more
      // tetrahedra.  So for a thing that goes far for its size, measure both: the balls' bounces,
      // 13 m tall, draw a tenth more in a view tilted 75 degrees up, which their saving is worth.
      // Between two keys the beam turns 4.5 degrees and its far end moves 4.7 m.  A long triangle
      // that turns folds between keys by about a quarter of that, and in a tilted view the folds
      // of a sheet of added light show as bright seams across it; so the cone is made of three
      // lengths, each of which folds a third as much (their uv.y runs on from 0 to 1 over all
      // three).  It has no emissive of its own: the shader (MAT_BEAM) sets how bright it is.
      const beam = new Geo(), r = (z) => 0.3 + 4.7 * z / 60;
      for (const z of [0, 20, 40]) beam.add(Geo.cylinder(r(z), 20, 8, { r2: r(z + 20), caps: false }).uvTransform(1, 1 / 3, 0, z / 60).translate(0, 0, z));
      b.dynamic(beam.rotateX(-Math.PI / 2).color('#fff2b0').additive().mat(MAT_BEAM), {
        times: timeRange(0, PERIOD, 0.125),
        // it points west at the start, away from the runway: the first picture of the scene, which
        // is the first a visitor sees, is clear of it
        transform: (t) => m4.mul(m4.translation(lx, ly, lz), m4.rotationZ(Math.PI / 2 - t / 10 * 2 * Math.PI)),
        caps: 'none',
      });
    }

    // The buildings round the range: copies of one unit box, each placed, stretched and tinted,
    // with windows painted on (MAT_BLOCK).  The tint multiplies the mesh's colour, so the box is
    // made white (a new mesh is light grey).  A town beyond the far end of the runway, on a grid
    // of plots and tallest round its middle; hangars along the east side, whose own number
    // (`data`) is 1 so that the shader gives them doors and one high row of windows; sheds to the
    // west; and open land behind the start, with a few low roofs far off.
    const blocks = [];
    const put = (x, y, w, d, h, hangar = 0) => {
      const tone = rand.range(0.45, 0.8);
      blocks.push({ transform: m4.mul(m4.translation(x, y, 0), m4.scaling(w, d, h)), tint: [tone, tone * 0.97, tone * 0.92], data: hangar });
    };
    for (let x = -250; x <= 250; x += 36) {
      for (let y = 240; y <= 520; y += 40) {
        if (Math.abs(x) < 30 || rand() < 0.35) continue;   // the runway runs on into the town
        const core = Math.max(0, 1 - Math.hypot(x, (y - 420) * 1.3) / 240);
        put(x + rand.range(-5, 5), y + rand.range(-5, 5), rand.range(12, 24), rand.range(12, 24), 9 + 38 * core * rand.range(0.6, 1) + rand.range(0, 8));
      }
    }
    for (const y of [-70, -25, 20, 65]) put(150, y, 28, 36, 11, 1);
    for (let i = 0; i < 8; i++) put(rand.range(-300, -150), rand.range(-90, 200), rand.range(10, 30), rand.range(10, 24), rand.range(5, 12));
    for (const x of [-210, -120, 110, 230]) put(x + rand.range(-15, 15), rand.range(-290, -230), rand.range(16, 34), rand.range(12, 24), rand.range(4, 8));
    b.instances(Geo.box(1, 1, 1).translate(0, 0, 0.5).color('#ffffff').mat(MAT_BLOCK), blocks);
  },
};
