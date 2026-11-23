// Time Lab: a plain test range that makes the tilt easy to read.  Every clock
// panel displays the moment at which you are seeing it, so the clocks down the
// runway run behind once you start moving, and the ones behind you run ahead.
//
// This file doubles as the reference example for the scene API (docs/SCENES.md).

import { Geo } from '../geom.js';
import { m4 } from '../math.js';
import { dayNightEnv } from '../env.js';
import { Path, follow, timeRange, rng } from '../util.js';

const PERIOD = 60; // every moving thing repeats after this many seconds
const MAT_GROUND = 1, MAT_CLOCK = 2, MAT_DIAL = 3, MAT_STENCIL = 4, MAT_CAR = 5, MAT_CAB = 6, MAT_WHEEL = 7,
  MAT_TRAM = 8, MAT_PLATE = 9, MAT_STRIPES = 10, MAT_SCALE = 11;

// The cars' loop, and how often their wheels turn on it in one period (the shader turns them).
const LOOP = new Path([[-70, 50, 0], [70, 50, 0], [70, 90, 0], [-70, 90, 0]], { closed: true, smooth: 8 });
const WHEEL_R = 0.36, WHEEL_TURNS = Math.round(LOOP.length / (2 * Math.PI * WHEEL_R));

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
  let fw = fwidth(s.pos.xy);
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
    s.color = mix(vec3f(0.92, 0.9, 0.84), vec3f(0.05), max(max(hours, mins), step(0.96, r)));
  } else if (s.mat == ${MAT_CAR}u) {
    // a car's body, a box with uv 0..1 across each face.  Its .aux() is 1 on the
    // front face and -1 on the back one, its .tag() the car's number.
    let lamps = step(abs(abs(u.x - 0.5) - 0.34), 0.11) * step(abs(u.y - 0.62), 0.14);
    let bumper = step(u.y, 0.33);   // a dark strip where the bumpers are (modelled from near by)
    if (s.aux > 0.5) {         // front: a grille between white headlamps
      let grille = step(abs(u.x - 0.5), 0.17) * step(abs(u.y - 0.62), 0.16) * step(0.4, fract(u.y * 10.0));
      s.color = mix(mix(s.color, vec3f(0.03), max(grille, bumper)), vec3f(1.0, 0.96, 0.85), lamps);
      s.emissive = lamps * 6.0;
    } else if (s.aux < -0.5) { // back: red tail lamps, and a plate with the number
      let plate = step(abs(u.x - 0.5), 0.14) * step(abs(u.y - 0.47), 0.13);
      let digits = number7((u - vec2f(0.38, 0.36)) / vec2f(0.24, 0.22), f32(s.tag), 2);
      s.color = mix(mix(s.color, vec3f(0.9, 0.85, 0.45), plate), vec3f(0.02), max(digits, bumper));
      s.color = mix(s.color, vec3f(1.0, 0.04, 0.02), lamps);
      s.emissive = lamps * 4.0;
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
      // a side, in metres: a row of windows, two doors and a stripe
      let p = u * vec2f(12.0, 2.6);
      let door = step(abs(abs(p.x - 6.0) - 2.25), 0.6) * step(0.1, p.y) * step(p.y, 2.25);
      let win = step(abs(fract(p.x / 1.5) - 0.5), 0.42) * step(abs(p.y - 1.75), 0.45);
      s.color = mix(s.color, vec3f(0.12, 0.45, 0.4), step(abs(p.y - 0.5), 0.12) * (1.0 - door));
      s.color = mix(mix(s.color, vec3f(0.3, 0.32, 0.35), door), vec3f(0.03, 0.045, 0.06), win);
      s.gloss = mix(s.gloss, 0.95, win);
    }
  } else if (s.mat == ${MAT_PLATE}u) {
    // the plate under a pylon's clocks: each copy's own number (its data, s.inst.w)
    let d = number7((u - vec2f(0.1, 0.18)) / vec2f(0.8, 0.64), s.inst.w, 3);
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
  }
  return s;
}
`;

// A vertical panel of size w x h whose front faces -Y, standing on z = 0.
const panel = (w, h) => Geo.plane(w, h).rotateX(Math.PI / 2).translate(0, 0, h / 2);

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
  period: PERIOD,
  viewDistance: 700,
  // about where the fog has swallowed everything, so the horizon matches the sky
  skyDistance: 900,
  wgsl,

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
      const hand = Geo.box(0.16, 0.1, 2.6).translate(0, 0, 1.1).color('#b3271e');
      b.dynamic(hand, {
        times: timeRange(0, PERIOD, 0.5),
        // seen from the front (-Y side), clockwise means turning from +Z towards +X
        transform: (t) => m4.mul(m4.translation(tx, ty - 3.63, 24.5), m4.rotationY(t / PERIOD * 2 * Math.PI)),
        caps: 'none',
      });
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
      const xs = [[0, -120], [26, 120], [30, 120], [56, -120], [60, -120]];
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
    }

    // bouncing balls: keys land exactly on the bounces, where the motion kinks
    for (let i = 0; i < 4; i++) {
      const bounce = [2, 3, 4, 5][i], height = [3, 5, 8, 12][i];
      const ball = Geo.sphere(0.6, 8, 5).color(['#e4572e', '#17bebb', '#ffc914', '#76b041'][i]).gloss(0.6).mat(MAT_STRIPES);
      b.dynamic(ball, {
        times: timeRange(0, PERIOD, bounce / 12),
        transform: (t) => {
          const u = (t / bounce) % 1;
          return m4.translation(-14 - i * 3, 20, 0.6 + height * 4 * u * (1 - u));
        },
        caps: 'none',
      });
    }

    // windmill
    {
      const [wx, wy] = [-40, 150];
      b.static(Geo.cylinder(1.6, 22, 12, { r2: 0.9 }).translate(wx, wy, 0).color('#e8e4da'));
      b.static(Geo.box(1.6, 2.2, 1.6).translate(wx, wy - 0.4, 22).color('#e8e4da')); // the nacelle
      const rotor = new Geo();
      for (let k = 0; k < 3; k++) rotor.add(Geo.box(0.9, 0.2, 13).translate(0, 0, 6.5).rotateY(k * 2 * Math.PI / 3).color('#f4f1ea'));
      rotor.add(Geo.sphere(1.0, 8, 4).color('#c44536'));
      b.dynamic(rotor, {
        times: timeRange(0, PERIOD, 0.15),
        transform: (t) => m4.mul(m4.translation(wx, wy - 1.9, 22), m4.rotationY(t / 6 * 2 * Math.PI)),
        caps: 'none',
      });
    }

    // pendulum under a gantry, hanging from a pin in a bracket, with a scale under its arc
    {
      const [px, py, top] = [14, 40, 9], pivot = top - 0.45;
      const g = new Geo();
      for (const x of [-5.4, 5.4]) g.add(Geo.box(0.4, 0.4, top).translate(x, 0, top / 2));
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
      b.static(g.color('#59606a').add(scale.color('#e9e6dc').mat(MAT_SCALE)).translate(px, py, 0));
      const bob = new Geo();
      bob.add(Geo.box(0.06, 0.06, 7).translate(0, 0, -3.5).color('#c9ccd1'));
      bob.add(Geo.sphere(0.7, 8, 5).translate(0, 0, -7).color('#d4a017').gloss(0.9).mat(MAT_STRIPES).tag(1));
      b.dynamic(bob, {
        times: timeRange(0, PERIOD, 0.2),
        transform: (t) => m4.mul(m4.translation(px, py, pivot), m4.rotationY(0.7 * Math.sin(t / 4 * 2 * Math.PI))),
        caps: 'none',
      });
    }

    // monoliths that exist for only part of the time: a tilted slice cuts them open
    for (let i = 0; i < 5; i++) {
      const g = Geo.box(3, 3, 9).translate(20 + i * 7, 10, 4.5).color(['#6c5ce7', '#00b894', '#e17055', '#0984e3', '#fdcb6e'][i]);
      b.static(g, { from: i * 2, to: i * 2 + 6, period: 12 });
    }

    // a cube that pops into existence, drifts and pops out again (sealed with caps)
    b.dynamic(Geo.box(4).color('#e84393').gloss(0.4), {
      times: [10, 30],
      transform: (t) => m4.translation(-26 + (t - 10) * 0.6, 45, 2 + (t - 10) * 0.1),
    });
    // ... and a sphere that grows out of nothing and shrinks back (needs no caps)
    b.dynamic(Geo.sphere(1, 16, 10).color('#00cec9').gloss(0.8), {
      times: timeRange(35, 55, 0.5),
      transform: (t) => m4.mul(m4.translation(-26, 60, 3), m4.scaling(3 * Math.sin((t - 35) / 20 * Math.PI))),
      caps: 'none',
    });

    // lighthouse beam: additive geometry sweeping round every 10 s
    {
      const [lx, ly] = [-60, 20];
      b.static(Geo.cylinder(1.4, 14, 12, { r2: 1.0 }).translate(lx, ly, 0).color('#f1ece2'));
      b.static(Geo.sphere(1.0, 12, 8).translate(lx, ly, 14.6).color('#fff2b0').emissive(10));
      const beam = Geo.cylinder(0.3, 60, 8, { r2: 5, caps: false }).rotateX(-Math.PI / 2).color('#fff2b0').emissive(0.35).additive();
      b.dynamic(beam, {
        times: timeRange(0, PERIOD, 0.125),
        transform: (t) => m4.mul(m4.translation(lx, ly, 14.6), m4.rotationZ(-t / 10 * 2 * Math.PI)),
        caps: 'none',
      });
    }

    // scattered blocks for parallax: copies of one unit box, each placed, stretched
    // and tinted.  The tint multiplies the mesh's colour, so the box is made white
    // (a new mesh is light grey).
    const blocks = [];
    for (let i = 0; i < 60; i++) {
      const x = rand.range(-300, 300), y = rand.range(-120, 520);
      if (Math.abs(x) < 16 && y > -50) continue;
      if (Math.abs(x) < 130 && y > 0 && y < 170) continue;
      const w = rand.range(4, 14), h = rand.range(3, 22);
      const tone = rand.range(0.45, 0.8);
      blocks.push({ transform: m4.mul(m4.translation(x, y, 0), m4.scaling(w, rand.range(4, 14), h)), tint: [tone, tone * 0.97, tone * 0.92] });
    }
    b.instances(Geo.box(1, 1, 1).translate(0, 0, 0.5).color('#ffffff'), blocks);
  },
};
