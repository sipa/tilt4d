// What a running frame hands over of a scene's MOVING geometry, in tetrahedra,
// pass by pass: read off the renderer's draw lists without drawing anything.
//
//   node tools/count.mjs <scene> [--view "..."]... [--save file.json]
//                                [--against file.json [--budget 1.1]]
//
// tools/cost.mjs draws its views, which is the full measure (static triangles
// and draw calls as well) but takes software rendering minutes to hours for a
// view tilted close to 90 degrees, where a slice touches every moving thing for
// a long stretch of time.  This takes seconds for any view, and says which
// pass the load is in: the picture, the shadow maps, or a side of the
// reflection picture (its average side, and its worst).  "frame" is the
// picture, the shadow maps and the average side.
//
// The views: the starting point seen level, and tilted sideways and up by 75,
// 89 and 90 degrees.  --view adds one of your own, as for tools/cost.mjs:
//   --view "pos=10,20,1.7 yaw=90 pitch=-5 tilt=60 lift=30 t=12 mode=fly"
//
// --save writes the result as JSON.  --against compares with a saved result and
// exits with status 1 if any view's frame is more than --budget times what it
// was (default 1.1) and more than 20,000 tetrahedra above it.

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

const args = { view: [] }; let scene = null;
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === '--view') args.view.push(process.argv[++i]); else if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i]; else scene = a; }
if (!scene) { console.log('usage: node tools/count.mjs <scene> [--view "..."]... [--save f.json] [--against f.json [--budget 1.1]]'); process.exit(2); }
const views = [['level', {}], ['tilt 75', { tilt: 75 }], ['tilt 89', { tilt: 89 }], ['tilt 90', { tilt: 90 }], ['lift 75', { lift: 75 }], ['lift 89', { lift: 89 }], ['lift 90', { lift: 90 }]];
for (const text of args.view) { const spec = {}; for (const part of text.trim().split(/\s+/)) { const [k, v] = part.split('='); spec[k] = k === 'pos' ? v.split(',').map(Number) : k === 'mode' ? v : Number(v); } views.push([text.trim(), spec]); }
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
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/?shot=1&scene=${encodeURIComponent(scene)}`);
  await page.waitForFunction(() => window.__shot && (window.__shot.ready || window.__shot.error), null, { timeout: 0 });
  const state = await page.evaluate(() => window.__shot);
  if (state.error) throw new Error('the scene failed to load:\n' + state.error);
  const result = { scene, views: [] };
  for (const [name, spec] of views) {
    const r = await page.evaluate(async (spec) => {
      const { player, renderer, scene: sc } = window.tilt4d;
      const sp = sc.def.spawn || {};
      player.setMode(spec.mode || sc.def.mode || 'walk');
      player.setPose({ pos: spec.pos ?? sp.pos, t: spec.t ?? sp.t ?? 0, yaw: (spec.yaw ?? sp.yaw ?? 0) + (spec.turn ?? 0), pitch: spec.pitch ?? sp.pitch ?? 0, tilt: spec.tilt ?? 0, tiltDir: spec.tiltdir ?? 90, lift: spec.lift ?? 0 });
      await renderer.settle(); // (the light's direction, if a read-back of it is on its way)
      const orig = renderer._dynDraws;
      let got = null;
      renderer._dynDraws = function (...a) {
        const res = orig.apply(this, a);
        const sum = (l) => l[0].tets + l[1].tets;
        let blend = 0; for (const b of res.blend) blend += b.count;
        const sides = res.sides.map(sum);
        got = { picture: sum(res.lists[0]) + blend, shadows: sum(res.lists[1]) + sum(res.lists[2]) + sum(res.lists[3]), side: sides.length ? sides.reduce((p, q) => p + q, 0) / sides.length : 0, worstSide: Math.max(0, ...sides) };
        throw new Error('counted');
      };
      try { renderer.render({ ...player.camera(), fovY: 62 * Math.PI / 180, time: 0, timeTint: 1, still: true }); } catch (e) { if (e.message !== 'counted') got = { error: e.message }; }
      renderer._dynDraws = orig;
      return got;
    }, spec);
    if (r.error) throw new Error(`${name}: ${r.error}`);
    result.views.push({ name, ...r, frame: Math.round(r.picture + r.shadows + r.side) });
  }
  const n = (x) => Math.round(x).toLocaleString('en-US').padStart(11);
  const before = args.against ? JSON.parse(readFileSync(args.against, 'utf8')) : null;
  const budget = Number(args.budget || 1.1);
  console.log(`${scene}: moving geometry handed over, in tetrahedra (counted, not drawn)`);
  console.log(`${'view'.padEnd(24)}${'picture'.padStart(11)}${'shadow maps'.padStart(12)}${'refl. side'.padStart(11)}${'(worst)'.padStart(11)}${'frame'.padStart(11)}${before ? '   against before' : ''}`);
  for (const v of result.views) {
    let note = '';
    if (before) {
      const b = before.views.find((x) => x.name === v.name);
      if (!b) note = '   (not in the saved result)';
      else { const over = v.frame > b.frame * budget && v.frame > b.frame + 20000; if (over) failed = true; note = `   ${b.frame ? (v.frame / b.frame).toFixed(2) : '-'} of ${Math.round(b.frame).toLocaleString('en-US')}${over ? '  OVER' : ''}`; }
    }
    console.log(`${v.name.slice(0, 23).padEnd(24)}${n(v.picture)} ${n(v.shadows)}${n(v.side)}${n(v.worstSide)}${n(v.frame)}${note}`);
  }
  if (args.save) { writeFileSync(args.save, JSON.stringify(result, null, 1)); console.log('saved ' + args.save); }
  if (failed) console.log(`over budget: a view hands over more than ${budget} times what it did`);
} finally {
  await browser.close(); server.close();
}
process.exit(failed ? 1 : 0);
