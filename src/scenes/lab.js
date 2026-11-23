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
const MAT_GROUND = 1, MAT_CLOCK = 2, MAT_DIAL = 3, MAT_STENCIL = 4;

const wgsl = dayNightEnv({ dayLength: 300, startHour: 10, fog: 0.0035, clouds: 0.5 }) + /* wgsl */ `
// How much of a mesh marked .cutout() is there at each pixel (1 solid .. 0 a
// hole), in the picture and in its shadow.  It is asked for every opaque mesh,
// so whatever has no holes returns 1 at once.
fn cutout(s: Surface) -> f32 {
  if (s.mat != ${MAT_STENCIL}u) { return 1.0; }
  // the stencil clock: its digits, at the time at which it is seen, are holes
  return 1.0 - clock7(s.uv, s.t);
}

fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  // Derivatives must be taken before any branching.
  let fw = fwidth(s.pos.xy);
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
      let dash = step(abs(s.pos.x), 0.12) * step(fract(s.pos.y / 10.0), 0.5);
      let edge = step(abs(abs(s.pos.x) - 3.7), 0.1);
      s.color = mix(s.color, vec3f(0.85, 0.82, 0.7), max(dash, edge));
    }
  } else if (s.mat == ${MAT_CLOCK}u) {
    // a digital clock showing the time at which this surface is being seen
    let on = clock7((s.uv - vec2f(0.06, 0.12)) / vec2f(0.88, 0.76), s.t);
    s.color = mix(vec3f(0.012, 0.014, 0.018), vec3f(1.0, 0.62, 0.12), on);
    s.emissive = on * 5.0;
    s.gloss = 0.5;
  } else if (s.mat == ${MAT_DIAL}u) {
    // hour ticks on the tower's analogue dial (uv 0..1 across the face)
    let q = s.uv - 0.5;
    let r = length(q) * 2.0;
    let a = fract(atan2(q.x, q.y) / TAU * 12.0 + 0.5) - 0.5;
    let tick = step(abs(a), 0.06) * step(0.78, r) * step(r, 0.95);
    s.color = mix(vec3f(0.92, 0.9, 0.84), vec3f(0.05), max(tick, step(0.97, r)));
  }
  return s;
}
`;

// A vertical panel of size w x h whose front faces -Y, standing on z = 0.
const panel = (w, h) => Geo.plane(w, h).rotateX(Math.PI / 2).translate(0, 0, h / 2);

function car(color) {
  const g = new Geo();
  g.add(Geo.box(1.8, 4.2, 0.7).translate(0, 0, 0.65).color(color).gloss(0.7));
  g.add(Geo.box(1.6, 2.2, 0.6).translate(0, -0.3, 1.3).color('#1c2733').gloss(0.9));
  for (const [x, y] of [[-0.9, 1.3], [0.9, 1.3], [-0.9, -1.3], [0.9, -1.3]]) {
    g.add(Geo.cylinder(0.36, 0.3, 6).rotateY(Math.PI / 2).translate(x - 0.15, y, 0.36).color('#15161a'));
  }
  g.add(Geo.box(0.4, 0.08, 0.16).translate(-0.6, 2.11, 0.75).color('#fff3c4').emissive(6));
  g.add(Geo.box(0.4, 0.08, 0.16).translate(0.6, 2.11, 0.75).color('#fff3c4').emissive(6));
  g.add(Geo.box(1.5, 0.08, 0.12).translate(0, -2.11, 0.8).color('#ff2a1a').emissive(4));
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
    pylon.add(Geo.box(2.7, 0.24, 1.3).translate(0, 0, 3.75).color('#22262c'));
    pylon.add(panel(2.5, 1.1).translate(0, -0.13, 3.2).mat(MAT_CLOCK));
    pylon.add(panel(2.5, 1.1).rotateZ(Math.PI).translate(0, 0.13, 3.2).mat(MAT_CLOCK));
    const pylons = [], lamps = [];
    for (let i = 0; i <= 20; i++) {
      const y = i * 20;
      for (const x of [-6, 6]) {
        pylons.push(m4.translation(x, y, 0));
        // a lamp that is lit for 0.4 s out of every 2 s, a little later at each
        // pylon: a copy can have a time window of its own
        lamps.push({ transform: m4.translation(x, y, 4.75), from: i * 0.1, to: i * 0.1 + 0.4, period: 2 });
      }
    }
    b.instances(pylon, pylons);
    b.instances(Geo.sphere(0.22, 10, 6).color('#7fe3ff').emissive(14), lamps);

    // clock tower with an analogue dial; the hand goes round once a minute
    {
      const [tx, ty] = [28, 120];
      const g = new Geo();
      g.add(Geo.box(7, 7, 30).translate(0, 0, 15).color('#b9a58c'));
      g.add(Geo.cone(6.2, 7, 4).rotateZ(Math.PI / 4).translate(0, 0, 30).color('#7a3b2e'));
      g.add(panel(5.5, 2.4).translate(0, -3.52, 17).mat(MAT_CLOCK));
      g.add(Geo.disc(2.9, 48).rotateX(Math.PI / 2).translate(0, -3.53, 24.5).mat(MAT_DIAL));
      b.static(g.translate(tx, ty, 0));
      const hand = Geo.box(0.16, 0.1, 2.6).translate(0, 0, 1.1).color('#b3271e');
      b.dynamic(hand, {
        times: timeRange(0, PERIOD, 0.5),
        // seen from the front (-Y side), clockwise means turning from +Z towards +X
        transform: (t) => m4.mul(m4.translation(tx, ty - 3.62, 24.5), m4.rotationY(t / PERIOD * 2 * Math.PI)),
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
      const loop = new Path([[-70, 50, 0], [70, 50, 0], [70, 90, 0], [-70, 90, 0]], { closed: true, smooth: 8 });
      const speed = loop.length / PERIOD;
      ['#c8402f', '#2f6fc8', '#e0b530'].forEach((color, i) => {
        b.dynamic(car(color), {
          times: timeRange(0, PERIOD, 0.4),
          transform: follow(loop, { speed, offset: i * loop.length / 3, span: 5 }),
          caps: 'none',
        });
      });
      b.static(Geo.box(110, 22, 0.3).translate(0, 70, 0.15).color('#3f5a3a'));
    }

    // a tram shuttling in a straight line: constant velocity needs only two keys per leg
    {
      const tram = new Geo();
      tram.add(Geo.box(2.6, 12, 2.6).translate(0, 0, 1.9).color('#d8d2c4').gloss(0.5));
      tram.add(Geo.box(2.64, 11, 0.9).translate(0, 0, 2.3).color('#1d2a36').gloss(0.9));
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
    }

    // bouncing balls: keys land exactly on the bounces, where the motion kinks
    for (let i = 0; i < 4; i++) {
      const bounce = [2, 3, 4, 5][i], height = [3, 5, 8, 12][i];
      const ball = Geo.sphere(0.6, 8, 5).color(['#e4572e', '#17bebb', '#ffc914', '#76b041'][i]).gloss(0.6);
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
      const rotor = new Geo();
      for (let k = 0; k < 3; k++) {
        rotor.add(Geo.box(0.9, 0.2, 13).translate(0, 0, 6.5).rotateY(k * 2 * Math.PI / 3).color('#f4f1ea'));
      }
      rotor.add(Geo.sphere(1.0, 8, 4).color('#c44536'));
      b.dynamic(rotor, {
        times: timeRange(0, PERIOD, 0.15),
        transform: (t) => m4.mul(m4.translation(wx, wy - 1.9, 22), m4.rotationY(t / 6 * 2 * Math.PI)),
        caps: 'none',
      });
    }

    // pendulum under a gantry
    {
      const [px, py, top] = [14, 40, 9];
      const g = new Geo();
      g.add(Geo.box(0.4, 0.4, top).translate(-3, 0, top / 2).color('#59606a'));
      g.add(Geo.box(0.4, 0.4, top).translate(3, 0, top / 2).color('#59606a'));
      g.add(Geo.box(6.4, 0.4, 0.4).translate(0, 0, top).color('#59606a'));
      b.static(g.translate(px, py, 0));
      const bob = new Geo();
      bob.add(Geo.box(0.08, 0.08, 7).translate(0, 0, -3.5).color('#c9ccd1'));
      bob.add(Geo.sphere(0.7, 8, 5).translate(0, 0, -7).color('#d4a017').gloss(0.9));
      b.dynamic(bob, {
        times: timeRange(0, PERIOD, 0.2),
        transform: (t) => m4.mul(m4.translation(px, py, top), m4.rotationY(0.7 * Math.sin(t / 4 * 2 * Math.PI))),
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
