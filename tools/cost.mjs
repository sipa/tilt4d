// What a scene costs to draw: counted, not timed.  (Counts are the same on any
// machine and whatever else it is doing, and the machines this is developed on
// have no graphics card to time anything with.)
//
//   node tools/cost.mjs <scene> [--view "..."]... [--save file.json]
//                               [--against file.json [--budget 1.2]]
//
// For each of a set of views the page draws one running frame, and this reads
// off what was handed to the GPU over all the passes of that frame (the
// picture, the shadow maps, one side of the reflection picture):
//
//   triangles    static and instanced triangles
//   tetrahedra   pieces of moving geometry
//   draws        draw calls
//   score        triangles + 2 x tetrahedra + 400 x draws + 300,000
//
// The score is a rough common measure, for comparing a scene with itself
// before and after a change and for ranking scenes.  A tetrahedron is drawn as
// two triangles by a heavier vertex stage; a draw call costs the CPU about
// what a few hundred triangles cost the GPU; and the constant stands for what
// every frame pays whatever the scene (the sky, multisampling, the bloom and
// tone-mapping passes).  What the pixels cost is not in it: keep additions to
// a scene's `surface` hook cheap, and behind a test of the material.
//
// The views: the scene's starting point seen level, tilted 45 and 75 degrees
// with the past ahead, tilted 45 degrees with the past to the right, and
// looking back with a tilt of 30 (the past ahead again).
// --view adds one of your own, for a place where a lot is going on:
//   --view "pos=10,20,1.7 yaw=90 pitch=-5 tilt=60 tiltdir=90 t=12 mode=fly"
// (all parts optional; what is left out is as at the starting point, and
// tiltdir, the way the future lies, is 90: to the right, as the tilting
// control makes it).
//
// --query "a=1&b=2" adds parameters to the page's address, for a scene that
// reads some of its own while it is being developed.
//
// --save writes the result as JSON.  --against compares with a saved result,
// view by view, and exits with status 1 if a score, or the size of the
// scene's buffers, is more than --budget times what it was (default 1.2).

import { chromium } from 'playwright-core';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './serve.mjs';

function findChromium() {
  if (process.env.CHROMIUM && existsSync(process.env.CHROMIUM)) return process.env.CHROMIUM;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const exe = path.join(cache, dir, 'chrome-linux64', 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const args = { view: [] };
let scene = null;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--view') args.view.push(process.argv[++i]);
  else if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
  else scene = a;
}
if (!scene) {
  console.log('usage: node tools/cost.mjs <scene> [--view "pos=x,y,z yaw=.. pitch=.. tilt=.. tiltdir=.. t=.. mode=.."]... [--save file.json] [--against file.json [--budget 1.2]]');
  process.exit(2);
}
const budget = Number(args.budget || 1.2);

export const score = (f) => f.triangles + 2 * f.tets + 400 * f.draws + 300000;

const views = [
  { name: 'level', spec: {} },
  // (tiltdir is where the future lies: 180 is the past ahead, 270 the past to the right)
  { name: 'tilt 45 ahead', spec: { tilt: 45, tiltdir: 180 } },
  { name: 'tilt 75 ahead', spec: { tilt: 75, tiltdir: 180 } },
  { name: 'tilt 45 right', spec: { tilt: 45, tiltdir: 270 } },
  { name: 'back, tilt 30', spec: { turn: 180, tilt: 30, tiltdir: 180 } },
];
for (const text of args.view) {
  const spec = {};
  for (const part of text.trim().split(/\s+/)) {
    const [k, v] = part.split('=');
    spec[k] = k === 'pos' ? v.split(',').map(Number) : k === 'mode' ? v : Number(v);
  }
  views.push({ name: text.trim(), spec });
}

const { server, port } = await listen(0);
const browser = await chromium.launch({
  executablePath: findChromium(),
  headless: true,
  args: process.env.TILT4D_GPU_ARGS
    ? process.env.TILT4D_GPU_ARGS.split(' ')
    : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  // (a small picture: the counts do not depend on its size, only on its shape)
  const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => { console.log('[pageerror] ' + e.message); });
  await page.goto(`http://127.0.0.1:${port}/?shot=1&scene=${encodeURIComponent(scene)}${args.query ? '&' + args.query : ''}`);
  await page.waitForFunction(() => window.__shot && (window.__shot.ready || window.__shot.error), null, { timeout: 0 });
  const state = await page.evaluate(() => window.__shot);
  if (state.error) throw new Error('the scene failed to load:\n' + state.error);
  const result = { scene, buildMs: state.buildMs, stats: state.stats, bytes: state.stats.bytes ?? null, views: [] };
  for (const v of views) {
    const frame = await page.evaluate(async (spec) => {
      const { player, renderer, scene: sc } = window.tilt4d;
      const sp = sc.def.spawn || {};
      player.setMode(spec.mode || sc.def.mode || 'walk');
      player.setPose({
        pos: spec.pos ?? sp.pos, t: spec.t ?? sp.t ?? 0, yaw: (spec.yaw ?? sp.yaw ?? 0) + (spec.turn ?? 0), pitch: spec.pitch ?? sp.pitch ?? 0,
        tilt: spec.tilt ?? 0, tiltDir: spec.tiltdir ?? 90,
      });
      // Twice: the first frame at a new time draws its shadow maps in full.  The second, which is
      // counted, is drawn as a still: that draws all six sides of a scene's reflection picture, and
      // a sixth of them is counted.  (A running frame draws one side, in turn, and the sides are
      // not alike: counting whichever came up would make a view's figure depend on what was
      // measured before it.)
      for (let i = 0; i < 2; i++) {
        renderer.render({ ...player.camera(), fovY: 62 * Math.PI / 180, time: 0, timeTint: 1, still: i === 1 });
        await renderer.settle();
      }
      return { ...renderer.info.frame };
    }, v.spec);
    result.views.push({ name: v.name, ...frame, score: score(frame) });
  }

  const n = (x) => Math.round(x).toLocaleString('en-US');
  const before = args.against ? JSON.parse(readFileSync(args.against, 'utf8')) : null;
  console.log(`${scene}: ${n(state.stats.staticTriangles)} static triangles and ${n(state.stats.tetrahedra)} tetrahedra in all`
    + (result.bytes ? `, ${(result.bytes / 1e6).toFixed(1)} MB of buffers` : '') + `, built in ${state.buildMs} ms`);
  console.log('view                      triangles   tetrahedra  draws        score' + (before ? '   against' : ''));
  for (const v of result.views) {
    const b = before && before.views.find((x) => x.name === v.name);
    const ratio = b ? v.score / b.score : null;
    if (ratio !== null && ratio > budget + 1e-9) failed = true;
    console.log(`${v.name.slice(0, 24).padEnd(24)} ${n(v.triangles).padStart(10)} ${n(v.tets).padStart(12)} ${n(v.draws).padStart(6)} ${n(v.score).padStart(12)}`
      + (before ? (ratio === null ? '   (not in the saved result)' : `   x ${ratio.toFixed(2)}${ratio > budget + 1e-9 ? '  OVER' : ''}`) : ''));
  }
  if (before) {
    if (before.bytes && result.bytes) {
      const r = result.bytes / before.bytes;
      if (r > budget + 1e-9) failed = true;
      console.log(`buffers: ${(before.bytes / 1e6).toFixed(1)} MB before, x ${r.toFixed(2)}${r > budget + 1e-9 ? '  OVER' : ''}`);
    }
    console.log(`build time: ${before.buildMs} ms before, ${state.buildMs} ms now (it varies with what else the machine is doing)`);
    console.log(failed ? `OVER the budget of ${budget} times the saved result` : `within ${budget} times the saved result`);
  }
  if (args.save) {
    writeFileSync(args.save, JSON.stringify(result, null, 1));
    console.log('saved ' + args.save);
  }
} catch (e) {
  failed = true;
  console.log(e.message);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
