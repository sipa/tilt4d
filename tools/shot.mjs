// Renders one frame of a scene in headless Chromium and saves it as a PNG
// (or, where --out ends in .jpg, as a JPEG).
//
//   node tools/shot.mjs --scene lab --out /tmp/lab.png [options]
//
//   --pos x,y,z     camera position (default: the scene's spawn point)
//   --t seconds     scene time
//   --yaw deg       heading, clockwise from +Y seen from above
//   --pitch deg     look up (+) or down (-)
//   --tilt deg      tilt of the slice against a level one (0 = an ordinary
//                   view, 90 = the view runs along time, >90 = mirrored)
//   --tiltdir deg   which way the future then lies, clockwise from the
//                   heading: 90 (the default) = to the right, with the past
//                   to the left, which is what rolling the wheel forward
//                   makes of a level view; 270 = to the left (the wheel
//                   rolled back); 0 = ahead; 180 = behind, the past ahead
//   --lift deg      tilt of the slice up and down, on top of that: with a
//                   positive one the future lies above and the past below
//   --mode name     walk | drive | fly | swim
//   --size WxH      image size (default 960x540)
//   --fov deg       vertical field of view (default 62); a small value zooms in
//   --hud           include the HUD in the picture
//   --card          lay the page's mark, name and tagline over the foot of the
//                   picture: this is how preview.jpg is made, the picture that
//                   a link to the page shows where it is posted (see README.md)
//   --tint n        the colouring by time: 1 slight, as the page starts out (the
//                   default), 0 none, 2 full: amber = the player's past, blue =
//                   their future, a line per second
//
//   --query "a=1&b=2"   more parameters for the page's address, for a scene
//                   that reads some of its own while it is being developed
//   --page file     the page to load, relative to the project (default
//                   index.html); dist/index.html checks the single-file build
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
  for (const k of ['pos', 't', 'yaw', 'pitch', 'tilt', 'tiltdir', 'lift', 'mode', 'hud', 'fov', 'tint', 'cast']) if (args[k] !== undefined) q.set(k, args[k]);
  await page.goto(`http://127.0.0.1:${port}/${(args.page || '').replace(/^\/+/, '')}?${q}${args.query ? '&' + args.query : ''}`);
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
  if (args.card && !failed) {
    // The name, the tagline and the mark are the page's own (index.html).
    await page.evaluate(() => {
      const card = document.createElement('div');
      card.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;justify-content:flex-end;padding:0 5vw 6.5vh;'
        + 'background:linear-gradient(to top,rgba(5,7,10,.94) 0%,rgba(5,7,10,.8) 30%,rgba(5,7,10,0) 62%);'
        + 'font-family:Inter,"Helvetica Neue","Segoe UI",system-ui,sans-serif;color:#e9edf2;';
      const name = document.createElement('div');
      name.style.cssText = 'display:flex;align-items:center;gap:2.6vh;font-size:13vh;font-weight:700;letter-spacing:-.03em;line-height:1.1;';
      const mark = new Image();
      mark.src = document.querySelector('link[rel=icon]').href;
      mark.style.cssText = 'width:11.5vh;height:11.5vh;';
      name.append(mark, document.querySelector('h1').textContent);
      const line = document.createElement('div');
      line.style.cssText = 'margin-top:2.2vh;max-width:86vw;font-size:5vh;font-weight:500;line-height:1.3;text-wrap:balance;';
      line.innerHTML = document.querySelector('.tagline').innerHTML;
      card.append(name, line);
      document.body.append(card);
      return Promise.all([mark.decode(), document.fonts.ready]);
    });
  }
  await page.screenshot(/\.jpe?g$/i.test(out) ? { path: out, type: 'jpeg', quality: 88 } : { path: out });
  console.log('wrote ' + out);
} catch (e) {
  failed = true;
  console.log('shot failed: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
