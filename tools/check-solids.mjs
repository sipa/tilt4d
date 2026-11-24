// Builds a scene in node (no browser, no GPU) and checks what the player can
// run into.
//
//   node tools/check-solids.mjs <scene> [--seconds 40] [--runs 12]
//
// It prints how long the scene takes to build and how many of its static
// triangles are solid, and then checks that
//   - the spawn point is clear of anything solid,
//   - the player can get away from it: travelling straight ahead for a
//     minute, with and without collisions, for comparison,
//   - roaming at random from the spawn point, in each of the scene's control
//     modes, with the view tilted this way and that and (walking) a jump now
//     and then, never crosses a solid surface.
// Exits with status 1 if the spawn point is blocked or a surface was crossed.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SceneBuilder } from '../src/builder.js';
import { Colliders } from '../src/collide.js';
import { Player, MODES } from '../src/player.js';
import { rng } from '../src/util.js';

const args = { seconds: 40, runs: 12 };
let id = null;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = Number(process.argv[++i]);
  else id = a;
}
if (!id) {
  console.log('usage: node tools/check-solids.mjs <scene> [--seconds 40] [--runs 12]');
  process.exit(2);
}
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/scenes');
const def = (await import(pathToFileURL(path.join(dir, id + '.js')))).default;

let t0 = performance.now();
const builder = new SceneBuilder();
def.build(builder);
const data = builder.finalize();
const buildMs = performance.now() - t0;
t0 = performance.now();
const onGround = def.ground || (MODES[def.mode || 'walk'].ground ? () => 0 : null);
const solids = def.solid === false ? null : new Colliders(data.solidTris, onGround, def.solidGrid);
const solidMs = performance.now() - t0;
console.log(`${id}: built in ${buildMs.toFixed(0)} ms: ${JSON.stringify(data.stats)}`);
if (!solids) {
  console.log('collisions are switched off for this scene (solid: false)');
  process.exit(0);
}
console.log(`solid triangles: ${solids.count} of ${data.solidTris.length / 9} static ones that could be `
  + `(the rest lie on the ground), prepared in ${solidMs.toFixed(0)} ms`);

const idle = () => ({ move: [0, 0, 0], look: [0, 0], roll: 0, run: false, jump: false, brake: false, tilt: 0, wheel: 0, twist: 0 });
const spawn = def.spawn || {};
function player(mode, withSolids = true) {
  const p = new Player();
  p.configure(def);
  p.solids = withSolids ? solids : null;
  p.mode = mode;
  p.setMode(mode);
  p.setPose(spawn);
  // a spawn point on the ground is under the floor of free movement
  if (!MODES[mode].ground) p._bounds();
  return p;
}
// Does the straight line from a to b pass through a solid triangle?
function crosses(a, b) {
  const r = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 + 0.01;
  const n = solids._gather((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, r), t = solids.t;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  for (let k = 0; k < n; k++) {
    const o = solids.cand[k] * 9;
    const e1 = [t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2]];
    const e2 = [t[o + 6] - t[o], t[o + 7] - t[o + 1], t[o + 8] - t[o + 2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [a[0] - t[o], a[1] - t[o + 1], a[2] - t[o + 2]];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const w = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (w >= 0 && w <= 1) return true;
  }
  return false;
}

// Moves a player for `seconds`; input(t) gives the controls for each frame.
function travel(p, seconds, input) {
  let crossed = 0, dist = 0, contacts = 0, frames = 0;
  const blocked = p._blocked.bind(p);
  let touched = false;
  p._blocked = (n) => { touched = true; blocked(n); };
  const ground = MODES[p.mode].ground;
  for (let t = 0; t < seconds; t += 1 / 60) {
    const a = p.P.slice();
    touched = false;
    p.update(1 / 60, input(t));
    if (touched) contacts++;
    frames++;
    if (p.solids) {
      // the body's path, at three heights for a body standing on the ground
      for (const h of ground ? [0.6, 1.0, 1.7] : [null]) {
        // (on the ground the eye is p.eye above the feet, wherever those are)
        const za = h === null ? a[2] : a[2] - p.eye + h, zb = h === null ? p.P[2] : p.P[2] - p.eye + h;
        if (crosses([a[0], a[1], za], [p.P[0], p.P[1], zb])) { crossed++; break; }
      }
    }
    dist += Math.hypot(p.P[0] - a[0], p.P[1] - a[1], ground ? 0 : p.P[2] - a[2]);
  }
  return { crossed, dist, contacts, frames };
}

let failed = false;
const mode = def.mode || 'walk';

// 1. the spawn point
{
  const p = player(mode);
  const before = p.P.slice(0, 3);
  p._collide();
  const moved = Math.hypot(p.P[0] - before[0], p.P[1] - before[1], p.P[2] - before[2]);
  if (moved > 1e-6) {
    failed = true;
    console.log(`FAIL: the spawn point (${before.map((v) => v.toFixed(2)).join(', ')}) overlaps something solid (pushed ${moved.toFixed(2)} m)`);
  } else {
    console.log('spawn point: clear');
  }
}

// 2. straight ahead from the spawn point
for (const withSolids of [true, false]) {
  const p = player(mode, withSolids);
  const r = travel(p, 60, () => ({ ...idle(), move: [0, 0, 1], run: true }));
  console.log(`straight ahead for 60 s in ${mode} mode, ${withSolids ? 'with' : 'without'} collisions: ${r.dist.toFixed(0)} m`
    + (withSolids ? `, touching something in ${r.contacts} of ${r.frames} frames` : ''));
}

// 3. roaming at random
const rand = rng(20261122);
for (const m of def.modes || ['walk', 'drive', 'fly', 'swim']) {
  let crossed = 0, dist = 0, contacts = 0, frames = 0;
  for (let k = 0; k < args.runs; k++) {
    const p = player(m);
    let look = [0, 0], tilt = 0;
    const r = travel(p, args.seconds, (t) => {
      if (Math.floor(t * 60) % 90 === 0) {
        look = [rand.range(-0.03, 0.03), MODES[m].ground ? 0 : rand.range(-0.008, 0.008)];
        // every other run keeps a level view; the rest tilt it back and forth
        tilt = k % 2 ? rand.pick([-1, 0, 0, 1]) : 0;
      }
      // a walker also jumps now and then, which may land them on top of things
      return { ...idle(), move: [0, 0, 1], look, tilt, run: rand() < 0.5, jump: m === 'walk' && rand() < 0.02 };
    });
    crossed += r.crossed; dist += r.dist; contacts += r.contacts; frames += r.frames;
  }
  if (crossed) failed = true;
  console.log(`${crossed ? 'FAIL' : 'ok'}: roaming in ${m} mode, ${args.runs} runs of ${args.seconds} s: ${dist.toFixed(0)} m, `
    + `touching something in ${(100 * contacts / frames).toFixed(0)}% of frames, surfaces crossed: ${crossed}`);
}
process.exit(failed ? 1 : 0);
