// A scratch scene that exercises the newer engine features one by one, laid
// out left to right along x in front of the spawn point:
//   x = -24  spare values: a box shaded by aux (smooth) and tag (per face)
//   x = -16  a mesh with holes (cutout), and its shadow
//   x =  -8  see-through panes (blend), static and moving
//   x =   0  instances: a field of posts, tinted (their sign boards are marked
//             untinted and stay white), one of them mirrored; and in front of
//             them a row of lamps, copies with a time window each
//   x =   8  textures: a checker table and a float table
//   x =  16  reflections: a glossy ball and a glossy floor tile
// plus a ridge to the west whose shadow comes from a horizon map (and a mast
// in that shadow whose top is high enough to be in the sun), and a tower 300 m
// to the south-west that needs the third shadow cascade.
// Behind the row of moving things at y = 12 there is a second one at y = 24,
// of things with a movement of their own that repeats (`cycle`): a walker, a
// rolling wheel, a flag, a bird, a pulsing ball that is only there for a
// while, and a see-through panel that turns, placed by a mirroring matrix.
// With ?cyclebrute=1 in the address the same things are built the long way
// round, every pose stored at every key: the two must give the same picture.

import { Geo } from '../geom.js';
import { m4 } from '../math.js';
import { dayNightEnv } from '../env.js';
import { rng } from '../util.js';

const MAT_GROUND = 1, MAT_SPARE = 2, MAT_HOLES = 3, MAT_CHECK = 4, MAT_FLOAT = 5, MAT_POST = 6, MAT_CHROME = 7, MAT_MAST = 8;

// (a page's address has parameters; a worker's and node have none)
const BRUTE = new URLSearchParams(globalThis.location?.search ?? '').get('cyclebrute') === '1';
// b.dynamic(geo, o) for a mesh with a cycle, or the same thing without the
// engine's help: a key at every pose and at every key of `times`, the mesh
// worked out at each as the engine would have it there.
function cyclic(b, geo, o) {
  if (!BRUTE) return b.dynamic(geo, o);
  const { cycle, transform, from, to, step, ...rest } = o;
  const times = o.times || Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
  delete rest.times;
  const n = cycle.keys ?? 4, dt = cycle.period / n, start = cycle.start ?? 0;
  const mod = (m) => ((m % n) + n) % n;
  const pose = (i) => {
    let g = typeof geo === 'function' ? geo(i / n) : geo;
    if (cycle.transform) g = g.clone().transform(cycle.transform(i / n));
    if (cycle.paint) { g = g.clone(); const pt = cycle.paint(i / n); if (pt.color !== undefined) g.color(pt.color); if (pt.emissive !== undefined) g.emissive(pt.emissive); }
    return g;
  };
  const poses = Array.from({ length: n }, (_, i) => pose(i));
  const t0 = times[0], t1 = times[times.length - 1];
  const all = [...times];
  for (let m = Math.ceil((t0 - start) / dt); start + m * dt < t1; m++) all.push(start + m * dt);
  const keys = all.sort((x, y) => x - y).filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-6);
  const mats = times.map((t) => (transform ? transform(t) : m4.identity()));
  const placed = (t) => {
    let k = 0;
    while (k < times.length - 2 && times[k + 1] <= t) k++;
    const w = Math.min(1, Math.max(0, (t - times[k]) / (times[k + 1] - times[k])));
    return mats[k].map((v, i) => v + (mats[k + 1][i] - v) * w);
  };
  const at = (t) => {
    const x = (t - start) / dt, m = Math.floor(x + 1e-9), u = Math.min(1, Math.max(0, x - m));
    const a = poses[mod(m)], c = poses[mod(m + 1)], g = a.clone();
    for (let i = 0; i < g.p.length; i++) { g.p[i] += (c.p[i] - a.p[i]) * u; g.n[i] += (c.n[i] - a.n[i]) * u; g.c[i] += (c.c[i] - a.c[i]) * u; }
    for (let i = 0; i < g.a.length; i += 4) g.a[i] += (c.a[i] - a.a[i]) * u;
    return g;
  };
  return b.dynamic(at, { ...rest, times: keys, transform: placed });
}
const ridge = (x, y) => 60 * Math.exp(-((x + 220) * (x + 220)) / (2 * 40 * 40)) * (0.75 + 0.25 * Math.cos(y / 90));

const wgsl = dayNightEnv({ dayLength: 240, startHour: 15.5, fog: 0.0012, clouds: 0.3 }) + /* wgsl */ `
fn cutout(s: Surface) -> f32 {
  if (s.mat != ${MAT_HOLES}u) { return 1.0; }
  // round holes on a 0.5 m grid: a soft edge half way
  let q = fract(s.uv * 6.0) - 0.5;
  return smoothstep(0.26, 0.34, length(q));
}
fn surface(sIn: Surface) -> Surface {
  var s = sIn;
  if (s.mat == ${MAT_GROUND}u) {
    let g = abs(fract(s.pos.xy / 4.0 - 0.5) - 0.5) * 4.0;
    s.color = mix(s.color, s.color * 0.8, step(min(g.x, g.y), 0.04));
    // the ridge's shadow, for the sun as it stands at this surface's own time
    s.sun *= landSun(s.pos, envSun(s.t).dir);
  } else if (s.mat == ${MAT_SPARE}u) {
    // aux runs from -1 at the bottom to 1 at the top; tag numbers the faces
    s.color = mix(vec3f(0.1, 0.2, 0.9), vec3f(0.95, 0.85, 0.1), s.aux * 0.5 + 0.5);
    if (s.tag == 3u) { s.color = vec3f(0.9, 0.1, 0.1); }
  } else if (s.mat == ${MAT_CHECK}u) {
    s.color = checker(s.uv).rgb;
  } else if (s.mat == ${MAT_FLOAT}u) {
    let v = ramp(s.uv);
    s.color = vec3f(v.r * 0.25, v.g, v.b);   // r goes up to 4: beyond what a byte table could hold
  } else if (s.mat == ${MAT_POST}u) {
    s.emissive = s.inst.w;   // the copy's own number
  } else if (s.mat == ${MAT_MAST}u) {
    // something tall standing in the ridge's shadow: its own height over the land counts
    s.sun *= landSunAt(s.pos, envSun(s.t).dir, s.pos.z);
  } else if (s.mat == ${MAT_CHROME}u) {
    // (a look straight at the reflection picture, for testing)
    s.color = probeSample(reflect(s.view, s.n));
  }
  return s;
}
`;

export default {
  id: 'enginetest',
  name: 'Engine test',
  C: 10,
  mode: 'walk',
  modes: ['walk', 'fly'],
  spawn: { pos: [0, -22, 0], t: 0, yaw: 0, pitch: 0 },
  period: 20,
  viewDistance: 900,
  skyDistance: 1500,
  shadowRadii: [30, 120, 700],
  shadowDepth: 1200,
  reflections: true,
  wgsl,

  build(b) {
    const rand = rng(5);
    b.static(Geo.plane(1600, 1600, 40, 40).color('#8a8f86').mat(MAT_GROUND));
    // the ridge (its mesh is not on the ground function, which is flat here, so it is solid)
    b.static(Geo.heightfield(-340, -500, -100, 500, 24, 60, ridge).color('#7b8472'));
    b.horizon('land', ridge, { x0: -800, y0: -800, x1: 800, y1: 800, nx: 128, ny: 128, reach: 900 });

    // spare values
    {
      const g = Geo.box(3, 3, 3).translate(0, 0, 1.5).mat(MAT_SPARE);
      g.aux((p) => (p[2] - 1.5) / 1.5);
      for (let i = 0; i < g.vertexCount; i++) g.x[i * 2 + 1] = Math.floor(i / 4);
      b.static(g, { transform: m4.translation(-24, 0, 0) });
    }
    // holes
    b.static(Geo.plane(4, 4).rotateX(Math.PI / 2).translate(0, 0, 2.2).doubleSided().cutout().color('#c9a25f').mat(MAT_HOLES), { transform: m4.mul(m4.translation(-16, 0, 0), m4.rotationZ(0.5)) });
    b.dynamic(Geo.plane(2, 2).rotateX(Math.PI / 2).translate(0, 0, 1.2).doubleSided().cutout().color('#5fa2c9').mat(MAT_HOLES), {
      from: 0, to: 20, step: 0.5, caps: 'none', transform: (t) => m4.mul(m4.translation(-16, -5 + 2 * Math.sin(t * Math.PI / 5), 0), m4.rotationZ(t * Math.PI / 5)),
    });
    // see-through
    b.static(Geo.plane(4, 3).rotateX(Math.PI / 2).translate(0, 0, 1.6).doubleSided().color('#c0392b').blend(0.45), { transform: m4.translation(-8, 2, 0) });
    b.static(Geo.plane(4, 3).rotateX(Math.PI / 2).translate(0, 0, 1.6).doubleSided().color('#2e86c1').blend(0.45), { transform: m4.translation(-7, 0, 0) });
    b.static(Geo.box(1, 1, 3).translate(0, 0, 1.5).color('#f1c40f'), { transform: m4.translation(-8, 4, 0) });
    b.dynamic(Geo.sphere(1.2, 16, 10).color('#30343a').blend((p) => 0.75 * Math.max(0, 1 - Math.hypot(p[0], p[1]) / 1.2)).noShadow(), {
      from: 0, to: 20, step: 1, caps: 'none', transform: (t) => m4.translation(-8, -3, 1 + 0.25 * t),
    });
    // instances
    {
      const post = Geo.merge(Geo.cylinder(0.12, 1.6, 8).translate(0, 0, 0.8).color('#ffffff'), Geo.box(0.5, 0.1, 0.3).translate(0.25, 0, 1.45).color('#ffffff').untinted()).mat(MAT_POST);
      const at = [];
      for (let i = 0; i < 300; i++) {
        const x = rand.range(-3, 3), y = rand.range(3, 40);
        at.push({ transform: m4.mul(m4.translation(x, y, 0), m4.rotationZ(rand.range(0, 6.28)), m4.scaling(rand.range(0.7, 1.3), rand.range(0.7, 1.3), rand.range(0.6, 1.6))), tint: [rand.range(0.3, 1), rand.range(0.3, 1), rand.range(0.3, 1)], data: i % 37 === 0 ? 3 : 0 });
      }
      at.push({ transform: m4.mul(m4.translation(0, 1, 0), m4.scaling(-2, 2, 2)), tint: '#ff00ff' }); // mirrored
      at.push(m4.mul(m4.translation(1.5, 1, 0), m4.scaling(2, 2, 2))); // a bare matrix
      b.instances(post, at);
      // a row of lamps, each lit for half a second out of every two, one after another
      const lamps = [];
      for (let i = 0; i < 16; i++) lamps.push({ transform: m4.translation(-3.75 + i * 0.5, -2, 0.4), from: i * 0.125, to: i * 0.125 + 0.5, period: 2, tint: i % 2 ? '#ffd27f' : '#7fe3ff' });
      b.instances(Geo.sphere(0.18, 10, 6).color('#ffffff').emissive(8), lamps);
      // and a group whose copies share one window: it is skipped altogether while that is closed
      b.instances(Geo.box(0.3, 0.3, 0.3).translate(0, 0, 0.15).color('#ff3b30'), [m4.translation(-4.5, -2, 0), m4.translation(4.5, -2, 0)], { from: 10, to: 12, period: 20 });
    }
    // textures
    {
      const checker = new Uint8Array(8 * 8 * 4);
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) checker.set((i + j) & 1 ? [230, 230, 230, 255] : [200, 30, 30, 255], (j * 8 + i) * 4);
      checker.set([30, 200, 30, 255], 0); // entry (0, 0): green, at uv (0, 0)
      b.texture('checker', { width: 8, height: 8, data: checker, nearest: true });
      const ramp = new Float32Array(16 * 4 * 4);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 16; i++) ramp.set([i / 15 * 4, j / 3, 0.2, 1], (j * 16 + i) * 4);
      b.texture('ramp', { width: 16, height: 4, data: ramp });
      b.static(Geo.plane(3, 3).rotateX(Math.PI / 2).translate(0, 0, 1.6).doubleSided().mat(MAT_CHECK), { transform: m4.translation(7, 0, 0) });
      b.static(Geo.plane(3, 3).rotateX(Math.PI / 2).translate(0, 0, 1.6).doubleSided().mat(MAT_FLOAT), { transform: m4.translation(10.5, 0, 0) });
    }
    // reflections
    b.static(Geo.sphere(1.5, 32, 20).translate(0, 0, 1.6).color('#d9dde2').gloss(1), { transform: m4.translation(16, 0, 0) });
    b.static(Geo.sphere(1.2, 32, 20).translate(0, 0, 1.3).mat(MAT_CHROME).unlit(), { transform: m4.translation(19.5, -3, 0) });
    b.static(Geo.plane(10, 4).rotateX(Math.PI / 2).translate(0, 0, 2).doubleSided().color('#0c0e12').gloss(1), { transform: m4.mul(m4.translation(26, -2, 0), m4.rotationZ(Math.PI / 2)) });
    b.static(Geo.plane(8, 8).translate(0, 0, 0.36).color('#101216').gloss(0.95), { transform: m4.translation(18, -8, 0), solid: false });
    b.static(Geo.box(2, 2, 5).translate(0, 0, 2.5).color('#e74c3c'), { transform: m4.translation(22, 4, 0) });
    b.static(Geo.box(2, 2, 3).translate(0, 0, 1.5).color('#27ae60').emissive(0.6), { transform: m4.translation(12, -12, 0) });
    b.dynamic(Geo.box(1, 1, 1).color('#f39c12').emissive(2), { from: 0, to: 20, step: 0.25, caps: 'none', transform: (t) => m4.translation(16 + 4 * Math.cos(t * Math.PI / 5), 4 * Math.sin(t * Math.PI / 5), 3) });
    // a mast east of the ridge: at sunset its foot is in the ridge's shadow and its top is not
    b.static(Geo.box(1.5, 1.5, 60).translate(0, 0, 30).color('#e8e8e8').mat(MAT_MAST), { transform: m4.translation(-60, 60, 0) });
    // Detail that is drawn only from near by (within): a ring of rivets round
    // the mast's foot, a cap on every post, and a stud on the orbiting box.
    {
      const rivets = [];
      for (let i = 0; i < 16; i++) rivets.push(Geo.sphere(0.06, 6, 4).translate(-60 + 0.82 * Math.cos(i * Math.PI / 8), 60 + 0.82 * Math.sin(i * Math.PI / 8), 0.5));
      b.static(Geo.merge(...rivets).color('#c0392b'), { within: 12 });
      const caps = [];
      const r2 = rng(5);
      for (let i = 0; i < 300; i++) { const x = r2.range(-3, 3), y = r2.range(3, 40); r2.range(0, 6.28); r2.range(0.7, 1.3); r2.range(0.7, 1.3); const h = r2.range(0.6, 1.6); r2.range(0.3, 1); r2.range(0.3, 1); r2.range(0.3, 1); caps.push(m4.translation(x, y, 1.6 * h)); }
      b.instances(Geo.sphere(0.07, 6, 4).color('#111111'), caps, { within: 8, solid: false });
      b.dynamic(Geo.sphere(0.12, 8, 6).color('#ffffff').emissive(3), { from: 0, to: 20, step: 0.25, caps: 'none', within: 10, transform: (t) => m4.translation(16 + 4 * Math.cos(t * Math.PI / 5), 4 * Math.sin(t * Math.PI / 5), 3.62) });
    }
    // The same on something that goes a long way between two keys: a sledge
    // crossing the ground in one straight run of 20 s, with a flag that is
    // only drawn within 15 m of where the sledge is seen.
    {
      const run = (t) => m4.translation(-150 + 15 * t, -30, 0);
      b.dynamic(Geo.box(2, 0.8, 0.5).translate(0, 0, 0.25).color('#34495e'), { times: [0, 20], caps: 'none', transform: run });
      b.dynamic(Geo.merge(Geo.cylinder(0.03, 1.2, 6).translate(0, 0, 1.1), Geo.box(0.5, 0.02, 0.3).translate(0.25, 0, 1.55)).color('#e74c3c'), { times: [0, 20], caps: 'none', within: 15, transform: run });
    }
    // Moving things of every kind the builder tells apart, side by side at
    // y = 12: one that is only moved (stored once, placed by its keys), one
    // moved by a mirroring matrix that also stretches it, one that changes
    // shape, and one that is repainted.
    {
      const arrow = Geo.merge(Geo.box(1.6, 0.5, 0.5).translate(0, 0, 0.25), Geo.box(0.5, 0.5, 1.2).translate(0.55, 0, 0.6)).color('#3498db');
      const spin = (x) => (t) => m4.mul(m4.translation(x, 12, 0.6 + 0.3 * Math.sin(t * Math.PI / 5)), m4.rotationZ(t * Math.PI / 10));
      b.dynamic(arrow, { from: 0, to: 20, step: 0.5, transform: spin(24) });
      b.dynamic(arrow, { from: 0, to: 20, step: 0.5, transform: (t) => m4.mul(spin(28)(t), m4.scaling(-1, 1.6, 0.7)) });
      b.dynamic((t) => Geo.box(1 + 0.5 * Math.sin(t * Math.PI / 5), 1, 1).translate(0, 0, 0.5).color('#2ecc71'), { from: 0, to: 20, step: 0.5, transform: spin(32) });
      b.dynamic(arrow, { from: 0, to: 20, step: 0.5, transform: spin(36), paint: (t) => ({ color: [0.9, 0.5 + 0.4 * Math.sin(t * Math.PI / 5), 0.2] }) });
      // and one that is only there for a while, with its ends in time sealed
      b.dynamic(arrow, { from: 4, to: 9, step: 0.5, transform: spin(40) });
    }
    // Things with a movement of their own that repeats, at y = 24.
    {
      const TAU = 2 * Math.PI;
      // a walker: a body, and two legs that swing between two ends (so two
      // poses are all of it), going up and down a line and turning round at
      // its ends, a key every tenth of a second while it turns.  (This is the
      // least a cycle can be, for testing: straight legs on two poses cross
      // like an X at mid-stride.  A walker to look at wants four poses and
      // knees: see docs/SCENES.md.)
      const walker = (u) => {
        const a = 0.5 * Math.cos(TAU * u);
        const leg = (x, ang) => Geo.box(0.16, 0.16, 0.8).translate(0, 0, -0.4).rotateX(ang).translate(x, 0, 0.8);
        return Geo.merge(Geo.box(0.5, 0.3, 0.7).translate(0, 0, 1.15).color('#8e44ad'), Geo.sphere(0.16, 8, 6).translate(0, 0, 1.68).color('#f0c9a0'), leg(-0.13, a).color('#2c3e50'), leg(0.13, -a).color('#2c3e50'));
      };
      const walk = (t) => {
        const s = ((t % 20) + 20) % 20;
        if (s < 9) return m4.translation(24, 21 + s * 2 / 3, 0);
        if (s < 10) return m4.mul(m4.translation(24, 27, 0), m4.rotationZ((s - 9) * Math.PI));
        if (s < 19) return m4.mul(m4.translation(24, 27 - (s - 10) * 2 / 3, 0), m4.rotationZ(Math.PI));
        return m4.mul(m4.translation(24, 21, 0), m4.rotationZ(Math.PI + (s - 19) * Math.PI));
      };
      const turn = (from) => Array.from({ length: 11 }, (_, i) => from + i / 10);
      cyclic(b, walker, { times: [0, ...turn(9), ...turn(19)], transform: walk, caps: 'none', cycle: { period: 1, keys: 2 } });
      // a wheel that rolls: turned within its own frame by the cycle, a pose
      // every 22.5 degrees, and taken there and back by three keys (which
      // start before the scene's own time does)
      const wheel = Geo.merge(Geo.cylinder(0.6, 0.2, 16).translate(0, 0, -0.1).rotateY(Math.PI / 2).color('#34495e'), Geo.box(0.26, 1.0, 0.12).color('#ecf0f1'), Geo.box(0.26, 0.12, 1.0).color('#e74c3c'));
      cyclic(b, wheel, {
        times: [-2, 8, 18], caps: 'none', transform: (t) => m4.translation(28, 21 + 6 * (1 - Math.abs((((t + 2) % 20) + 20) % 20 - 10) / 10), 0.6),
        cycle: { period: 2, keys: 16, start: 0.25, transform: (u) => m4.rotationX(-TAU * u) },
      });
      // a flag: it stays where it is and changes shape, eight poses to a wave
      const flag = (u) => {
        const g = Geo.plane(2, 1.2, 8, 3).rotateX(Math.PI / 2).translate(1, 0, 3).doubleSided().color('#e67e22');
        for (let i = 0; i < g.vertexCount; i++) g.p[i * 3 + 1] += 0.18 * (g.p[i * 3] / 2) * Math.sin(TAU * (u - g.p[i * 3] / 2));
        return g;
      };
      b.static(Geo.cylinder(0.05, 3.7, 8).color('#bdc3c7'), { transform: m4.translation(32, 24, 0) });
      cyclic(b, flag, { times: [0, 20], caps: 'none', transform: () => m4.translation(32, 24, 0), cycle: { period: 2, keys: 8 } });
      // a bird: round in a circle, a key every half second, beating its wings
      // 25 times on the way (up, level, down, level), out of step with those keys
      const bird = (u) => {
        const lift = 0.5 * (1 - 4 * Math.abs(u - 0.5)) * 0.9;
        const wing = (side) => Geo.quad([0, 0.25, 0], [0, -0.25, 0], [side * 0.9, -0.2, lift], [side * 0.9, 0.2, lift]).doubleSided();
        return Geo.merge(Geo.box(0.2, 0.7, 0.16), wing(1), wing(-1)).color('#ecf0f1');
      };
      const round = (t) => m4.mul(m4.translation(36, 24, 2.6), m4.rotationZ(TAU * t / 10), m4.translation(2, 0, 0));
      cyclic(b, bird, { from: 0, to: 20, step: 0.5, caps: 'none', transform: round, cycle: { period: 0.8, keys: 4, start: 0.13 } });
      // ... with something on its back that is only drawn from near by
      cyclic(b, Geo.box(0.1, 0.1, 0.1).translate(0, 0, 0.2).color('#c0392b').emissive(2), { from: 0, to: 20, step: 0.5, caps: 'none', within: 12, transform: round, cycle: { period: 0.8, keys: 4, start: 0.13, transform: (u) => m4.translation(0, 0, 0.1 * Math.sin(TAU * u)) } });
      // a ball that is only there for a while (its ends in time sealed), and
      // meanwhile bobs up and down and glows and fades
      cyclic(b, Geo.sphere(0.5, 12, 8).color('#16a085'), {
        times: [4.3, 9.1], transform: (t) => m4.translation(40, 22 + (t - 4.3) * 0.8, 1.2),
        cycle: { period: 1.2, keys: 6, transform: (u) => m4.translation(0, 0, 0.4 * Math.sin(TAU * u)), paint: (u) => ({ color: [0.1 + 0.8 * u, 0.6, 0.5], emissive: 1.5 * (1 - Math.cos(TAU * u)) }) },
      });
      // a see-through panel that turns, placed by a matrix that mirrors it;
      // it stands still before and after its run
      cyclic(b, Geo.merge(Geo.plane(1.6, 1.2).rotateX(Math.PI / 2).translate(0.5, 0, 1.4).doubleSided().color('#2980b9').blend(0.5), Geo.box(0.1, 0.1, 2.2).translate(0, 0, 1.1).color('#7f8c8d')), {
        times: [6, 14], holdBefore: true, holdAfter: true, transform: (t) => m4.mul(m4.translation(44, 21 + (t - 6) * 0.75, 0), m4.scaling(-1, 1, 1)),
        cycle: { period: 4, keys: 12, start: 6, transform: (u) => m4.rotationZ(TAU * u) },
      });
    }
    // a distant tower for the third shadow cascade
    b.static(Geo.box(12, 12, 90).translate(0, 0, 45).color('#b9b2a4'), { transform: m4.translation(120, -330, 0) });
  },
};
