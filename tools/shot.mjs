// Renders one frame of a scene in headless Chromium and saves it as a PNG.
//
//   node tools/shot.mjs --scene lab --out /tmp/lab.png [options]
//
//   --pos x,y,z     camera position (default: the scene's spawn point)
//   --t seconds     scene time
//   --yaw deg       heading, clockwise from +Y seen from above
//   --pitch deg     look up (+) or down (-)
//   --tilt deg      tilt of the slice against a level one (0 = an ordinary
//                   view, 90 = the view runs along time, >90 = mirrored)
//   --tiltdir deg   which way it is tilted, relative to the heading (0 = the
//                   past lies ahead, 90 = to the right, 180 = behind)
//   --mode name     walk | drive | fly | swim
//   --size WxH      image size (default 960x540)
//   --fov deg       vertical field of view (default 62); a small value zooms in
//   --hud           include the HUD in the picture
//   --tint n        the colouring by time: 1 slight, as the page starts out (the
//                   default), 0 none, 2 full: amber = the player's past, blue =
//                   their future, a line per second
//
//   --page file     the page to load, relative to the project (default
//                   index.html); dist/tilt4d.html checks the single-file build
//
//   --browser firefox   render in Firefox instead of Chromium: a second,
//                   independent WebGPU implementation.  Needs a display (run
//                   under `xvfb-run -a`) and a Vulkan driver such as Mesa's.
//
// Prints the scene's build statistics and any shader or runtime errors.
// Exits with status 1 if the scene failed to load.

import { chromium, firefox } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || /^--[a-z]/.test(next)) args[a.slice(2)] = '1';
  else { args[a.slice(2)] = next; i++; }
}
const out = args.out || 'shot.png';
const [width, height] = (args.size || '960x540').split('x').map(Number);

const { server, port } = await listen(0);
const useFirefox = args.browser === 'firefox';
if (useFirefox && !process.env.DISPLAY) {
  console.log('Firefox needs a display: run this under `xvfb-run -a`.');
  process.exit(1);
}
const browser = useFirefox
  ? await firefox.launch({
    headless: false, // WebGPU is switched off in Firefox's headless mode
    firefoxUserPrefs: { 'dom.webgpu.enabled': true, 'gfx.webgpu.ignore-blocklist': true },
  })
  : await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    // Software rendering, pinned to SwiftShader so results do not depend on
    // which Vulkan drivers happen to be installed.  Set TILT4D_GPU_ARGS to
    // override (space-separated Chromium flags), e.g. to use a real GPU.
    args: process.env.TILT4D_GPU_ARGS
      ? process.env.TILT4D_GPU_ARGS.split(' ')
      : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
  });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => { console.log('[pageerror] ' + e.message); });
  const q = new URLSearchParams({ shot: '1', scene: args.scene || 'lab' });
  for (const k of ['pos', 't', 'yaw', 'pitch', 'tilt', 'tiltdir', 'mode', 'hud', 'fov', 'tint', 'cast']) if (args[k] !== undefined) q.set(k, args[k]);
  await page.goto(`http://127.0.0.1:${port}/${(args.page || '').replace(/^\/+/, '')}?${q}`);
  await page.waitForFunction(() => window.__shot && (window.__shot.ready || window.__shot.error), null, { timeout: 180000 });
  const state = await page.evaluate(() => window.__shot);
  if (state.error) {
    failed = true;
    console.log('SCENE FAILED TO LOAD:\n' + state.error);
  } else {
    console.log('stats: ' + JSON.stringify(state.stats));
    // (a still redraws all six sides of the reflection picture, where a scene has one; a running frame only one)
    const running = state.liveDraws !== state.draws ? ` (${state.liveDraws} in a running frame)` : '';
    console.log(`build ${state.buildMs} ms; drawing ${state.triangles} static triangles and ${state.tets} tetrahedra in ${state.draws} draw calls for this view${running}`);
  }
  await page.screenshot({ path: out });
  console.log('wrote ' + out);
} catch (e) {
  failed = true;
  console.log('shot failed: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
