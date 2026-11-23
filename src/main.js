import { Renderer } from './renderer.js';
import { SceneBuilder } from './builder.js';
import { Player, MODES } from './player.js';
import { Colliders } from './collide.js';
import { SCENES } from './scenes/index.js';
import { Hud, CONTROLS, keyCaps } from './hud.js';
import { TouchControls, TOUCH_CONTROLS } from './touch.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const shot = params.has('shot');
const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);

const canvas = $('view');
const overlay = $('overlay');
const statusEl = $('status');
const hud = new Hud();
const player = new Player();
// ?ease=0.04 sets how much of the tilting rate is left at 90 degrees (1 = no easing; see player.js)
if (num('ease', 0) > 0) player.ease = Math.min(1, Math.max(0.001, num('ease', 0)));
// ?cast=2 makes the slight colouring by time twice as strong as usual
const timeCast = Math.min(4, Math.max(0, num('cast', 1)));
let renderer = null;
let current = null; // { entry, def, stats, buildMs }
let playing = false; // false while the menu is up
let entered = false; // becomes true the first time a scene is entered
let autoScale = 1; // render resolution factor, lowered when frames are slow
let slowTime = 0;
let hudWanted = true;
// The colouring by time, which T goes round: 1 a slight warm cast on what lies
// in your past and a cool one on your future, 2 amber and blue outright with a
// line per second, 0 none.
let timeTint = 1;
const baseFov = num('fov', 62) * Math.PI / 180;
let touchMode = false; // true once the screen has been touched (and until a mouse is used)

const keys = new Set();
const look = [0, 0];
let wheel = 0;
let jumpPressed = false; // Space went down since the last frame (a quick tap can be over before the next one)

// for poking at things from the browser console
window.tilt4d = { player, get renderer() { return renderer; }, get scene() { return current; }, measure: () => measure() };

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', isError);
}

// ---- scenes -----------------------------------------------------------------

async function loadScene(id) {
  // An id that is not in the list is tried as a module name, so that a scene
  // under development can be opened with ?scene=<file name> before it is listed.
  const entry = SCENES.find((s) => s.id === id)
    || (/^[\w-]+$/.test(id || '') ? { id, name: id, mode: 'walk', load: () => import(`./scenes/${id}.js`) } : SCENES[0]);
  setStatus(`Building “${entry.name}”…`);
  await new Promise((r) => setTimeout(r, 30)); // let the message paint
  const def = (await entry.load()).default;
  const t0 = performance.now();
  const builder = new SceneBuilder();
  def.build(builder);
  const data = builder.finalize();
  const buildMs = Math.round(performance.now() - t0);
  await renderer.setScene(data, def);
  current = { entry, def, stats: data.stats, buildMs };
  autoScale = 1;
  player.configure(def);
  // Static surfaces are solid.  Where the player is kept on the ground, what
  // lies on the ground (paving, the terrain itself) is not an obstacle.
  const t1 = performance.now();
  const onGround = def.ground || (MODES[def.mode || 'walk'].ground ? () => 0 : null);
  player.solids = def.solid === false ? null : new Colliders(data.solidTris, onGround);
  data.stats.solidTriangles = player.solids ? player.solids.count : 0;
  data.stats.solidMs = Math.round(performance.now() - t1);
  player.mode = def.mode || 'walk';
  player.setMode(player.mode);
  player.setPose(def.spawn);
  applyMode();
  setStatus('');
  console.info(`scene ${entry.id}: built in ${buildMs} ms`, data.stats);
  for (const el of document.querySelectorAll('.scene-card')) el.classList.toggle('current', el.dataset.id === entry.id);
}

function applyMode() {
  hud.setMode(player.mode, MODES[player.mode].name);
  $('controls-mode').textContent = `· ${MODES[player.mode].name}`;
  const table = touchMode ? TOUCH_CONTROLS : CONTROLS;
  // keyboard entries name one key per word; touch entries are whole phrases
  const caps = touchMode ? (k) => k.split(' / ').map((x) => `<kbd>${x}</kbd>`).join(' / ') : keyCaps;
  $('controls').innerHTML = table[player.mode].map(([k, d]) => `<tr><td>${caps(k)}</td><td>${d}</td></tr>`).join('');
  $('controls-common').innerHTML = table.common.map(([k, d]) => `<span>${caps(k)} ${d}</span>`).join('');
  $('how-to-enter').innerHTML = touchMode
    ? 'Tap a scene to enter. <kbd>\u2630</kbd> brings this page back.'
    : 'Click a scene to enter. <kbd>Esc</kbd> brings this page back.';
  touch.setMode(player.mode, MODES[player.mode].name);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
}

// The way back to an ordinary view: no tilt, no motion.
function levelAndStop() {
  player.level();
  player.stop();
  hud.flash('level and at rest');
}

function cycleTint() {
  timeTint = (timeTint + 1) % 3;
  hud.flash([
    'time colouring off',
    'time colouring, slight: past is warmer, future cooler',
    'time colouring, full: amber is past, blue is future',
  ][timeTint], 2600);
}

// The page starts out assuming a keyboard and mouse.  The first touch brings
// up the on-screen controls; using a mouse again puts them away.
function setTouchMode(on) {
  if (on === touchMode) return;
  touchMode = on;
  document.body.classList.toggle('touch', on);
  touch.setActive(on && playing);
  if (current) applyMode();
}

function cycleMode() {
  const modes = current.def.modes || Object.keys(MODES);
  const next = modes[(modes.indexOf(player.mode) + 1) % modes.length];
  player.setMode(next);
  applyMode();
  hud.flash(`${MODES[next].name} mode`);
}

function buildSceneList() {
  const list = $('scene-list');
  list.innerHTML = '';
  for (const s of SCENES) {
    const b = document.createElement('button');
    b.className = 'scene-card';
    b.dataset.id = s.id;
    b.innerHTML = `<b>${s.name}</b><i>${MODES[s.mode]?.name ?? ''}</i><span>${s.blurb}</span>`;
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      // While this is still a user gesture: capture the mouse or, on a touch
      // screen, go full screen and (where the browser allows) landscape.
      if (touchMode) {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
            ?.then?.(() => screen.orientation?.lock?.('landscape'))?.catch?.(() => {});
        }
      } else {
        canvas.requestPointerLock?.()?.catch?.(() => {});
      }
      try {
        if (!current || current.entry.id !== s.id) {
          for (const el of list.children) el.disabled = true;
          await loadScene(s.id);
        }
        enter();
      } catch (e) {
        setStatus(e.message, true);
        document.exitPointerLock?.();
      } finally {
        for (const el of list.children) el.disabled = false;
      }
    });
    list.appendChild(b);
  }
}

function enter() {
  playing = true;
  entered = true;
  const hint = (touchMode && current.entry.touchHint) || current.entry.hint;
  if (hint && !current.hinted) {
    current.hinted = true;
    hud.hint(hint);
  }
  overlay.hidden = true;
  hud.setVisible(hudWanted);
  touch.setActive(touchMode);
  keys.clear();
}

function leave() {
  playing = false;
  overlay.hidden = false;
  hud.setVisible(false);
  touch.setActive(false);
}

// ---- input ------------------------------------------------------------------

const touch = new TouchControls(canvas, $('touch'), (action) => {
  switch (action) {
    case 'menu': leave(); break;
    case 'mode': cycleMode(); break;
    case 'tint': cycleTint(); break;
    case 'level': levelAndStop(); break;
    case 'full': toggleFullscreen(); break;
  }
});
addEventListener('pointerdown', (e) => setTouchMode(e.pointerType !== 'mouse'), true);
// keep the page itself from zooming or scrolling under the controls
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// The vertical field of view.  On a tall, narrow screen it is widened so the
// view does not turn into a slit.
function fovFor(aspect) {
  const tanY = Math.tan(baseFov / 2);
  return 2 * Math.atan(Math.min(1.3, Math.max(tanY, 0.75 / aspect)));
}

addEventListener('keydown', (e) => {
  if (!playing) return;
  if (e.code === 'Escape') { leave(); return; }
  keys.add(e.code);
  if (['Space', 'Tab', 'Backspace'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  switch (e.code) {
    case 'Space': jumpPressed = true; break;
    case 'KeyM': cycleMode(); break;
    case 'KeyR': levelAndStop(); break;
    case 'KeyP': player.paused = !player.paused; break;
    case 'KeyH': hudWanted = !hudWanted; hud.setVisible(hudWanted); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'KeyT': cycleTint(); break;
    case 'KeyG': measure(); break;
    case 'BracketLeft': player.timeScale = Math.max(0.125, player.timeScale / 2); break;
    case 'BracketRight': player.timeScale = Math.min(8, player.timeScale * 2); break;
    case 'Backspace': player.setMode(player.mode); player.setPose(current.def.spawn); break;
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

canvas.addEventListener('click', () => {
  if (playing && !touchMode && document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {});
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas && playing) leave();
});
let dragging = false;
canvas.addEventListener('mousedown', () => { dragging = true; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (!playing) return;
  if (document.pointerLockElement === canvas || dragging) {
    look[0] += e.movementX * 0.0022;
    look[1] += e.movementY * 0.0022;
  }
});
addEventListener('wheel', (e) => {
  if (!playing) return;
  // One notch of a mouse wheel is about 100 pixels, or 3 lines; a trackpad
  // sends a stream of much smaller steps, which count as parts of a notch.
  const notch = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100;
  // Rolling the wheel away from you tilts the view ahead into the past.
  wheel -= Math.max(-1, Math.min(1, e.deltaY / notch));
}, { passive: true });

function readInput() {
  const k = (c) => (keys.has(c) ? 1 : 0);
  const t = touch.read();
  const unit = (v) => Math.max(-1, Math.min(1, v));
  const input = {
    move: [
      unit(k('KeyD') - k('KeyA') + t.move[0]),
      unit(k('Space') - Math.max(k('KeyC'), k('ControlLeft')) + t.move[1]),
      unit(k('KeyW') - k('KeyS') + t.move[2]),
    ],
    look: [look[0] + t.look[0], look[1] + t.look[1]],
    roll: k('KeyE') - k('KeyQ'),
    run: k('ShiftLeft') || k('ShiftRight') || t.run,
    jump: (player.mode === 'walk' && (k('Space') || jumpPressed)) || t.jump,
    brake: k('KeyB') || (player.mode === 'drive' && k('Space')) || t.brake,
    tilt: unit(k('KeyX') - k('KeyZ') + t.tilt),
    wheel,
    twist: t.twist,
  };
  look[0] = look[1] = 0;
  wheel = 0;
  jumpPressed = false;
  return input;
}

// ---- how much room is there? ------------------------------------------------

// The frame rate on screen is tied to the display, so it says nothing about
// how much faster the renderer could go.  This draws the present view a
// number of times back to back instead, without waiting for the screen in
// between, and times how long the page and the graphics card take over it.
let measuring = false;
let shownFps = 60; // frames per second that actually reach the screen, smoothed
async function measure() {
  if (measuring || !current || !renderer) return null;
  measuring = true;
  hud.flash('measuring…', 60000);
  const queue = renderer.device.queue;
  const cam = { ...player.camera(), fovY: fovFor(canvas.clientWidth / canvas.clientHeight), time: performance.now() / 1000, timeTint, timeCast };
  const burst = async (frames) => {
    await queue.onSubmittedWorkDone(); // start with nothing pending
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) renderer.render(cam);
    const t1 = performance.now();
    await queue.onSubmittedWorkDone();
    return { frames, ms: (performance.now() - t0) / frames, pageMs: (t1 - t0) / frames };
  };
  let r;
  try {
    r = await burst(1);
    // then about half a second's worth, unless single frames are that slow already
    if (r.ms < 150) r = await burst(Math.max(4, Math.min(120, Math.round(500 / Math.max(r.ms, 0.5)))));
  } catch (e) {
    hud.flash(`could not measure: ${e.message}`, 6000);
    return null;
  } finally {
    measuring = false;
  }
  const [width, height] = renderer.size;
  Object.assign(r, { fps: 1000 / r.ms, shownFps, width, height, scene: current.entry.id, tets: renderer.info.tets, triangles: renderer.info.triangles, draws: renderer.info.draws });
  const room = r.fps / shownFps;
  hud.flash(`${r.ms.toFixed(r.ms < 10 ? 1 : 0)} ms a frame at ${width}×${height}: `
    + (room >= 1.15 ? `room for ${Math.round(r.fps)} fps, ${room.toFixed(1)} times the ${Math.round(shownFps)} on screen` : `no room to spare (${r.fps.toFixed(0)} fps at best)`), 10000);
  console.info('frame time', r);
  return r;
}

// ---- main loop --------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const rawDt = (now - last) / 1000;
  const dt = Math.min(0.1, rawDt);
  last = now;
  if (measuring) { requestAnimationFrame(frame); return; } // the renderer is busy being timed
  if (rawDt > 0 && rawDt < 0.25) shownFps += (1 / rawDt - shownFps) * 0.05;
  if (current) {
    if (playing) {
      const input = readInput();
      player.update(dt, input);
      if (input.wheel || input.tilt) {
        const deg = Math.round(player.status().tilt * 1800 / Math.PI) / 10;
        const held = player.mode !== 'fly'; // the ground and the water tie the pace of time to the tilt
        hud.flash(deg === 0 ? 'level' : deg === 90 ? `tilt 90°: the view runs along time${held ? ', and time stands still' : ''}`
          : `tilt ${deg.toFixed(Math.abs(deg - 90) < 10 ? 1 : 0)}°${deg > 90 ? `: past 90°, the view is mirrored${held ? ' and time runs backwards' : ''}` : ''}`);
      }
    } else if (!entered) {
      player.P[3] += dt; // let the scene run behind the opening menu
    }
    // If the frame rate stays poor for a while, render at a lower resolution
    // (until the next scene is loaded).
    slowTime = rawDt > 1 / 40 && rawDt < 0.5 ? slowTime + rawDt : 0;
    if (slowTime > 1.5 && autoScale > 0.5) { autoScale = Math.max(0.5, autoScale * 0.85); slowTime = 0; }
    const scale = Math.min(devicePixelRatio || 1, 1.5) * (params.has('scale') ? num('scale', 1) : autoScale);
    renderer.resize(canvas.clientWidth * scale, canvas.clientHeight * scale);
    renderer.render({ ...player.camera(), fovY: fovFor(canvas.clientWidth / canvas.clientHeight), time: now / 1000, timeTint, timeCast });
    if (playing && hudWanted) hud.update(player.status(), current.entry.name, player, dt, renderer.info);
  }
  requestAnimationFrame(frame);
}

async function start() {
  buildSceneList();
  try {
    renderer = await Renderer.create(canvas);
  } catch (e) {
    setStatus(window.isSecureContext
      ? `${e.message}\n\nThis demo needs WebGPU: a recent Chrome or Edge, Safari 26, or Firefox 141+ (on Linux you may need to enable it in the browser's flags).`
      : `${e.message}\n\nBrowsers only provide WebGPU to pages loaded over https or from localhost, and this one came over plain http from another machine. Start the server with --https (node tools/serve.mjs --host 0.0.0.0 --https), or forward the port with ssh -L and open localhost.`, true);
    if (shot) window.__shot = { error: e.message };
    return;
  }
  renderer.onError = (msg) => { console.error(msg); setStatus(msg, true); };

  if (shot) {
    // Headless still frame for tools/shot.mjs: fixed pose, no menu.
    try {
      await loadScene(params.get('scene'));
      const def = current.def;
      if (params.has('mode')) player.setMode(params.get('mode'));
      const sp = def.spawn || {};
      player.setPose({
        pos: params.has('pos') ? params.get('pos').split(',').map(Number) : sp.pos,
        t: num('t', sp.t ?? 0), yaw: num('yaw', sp.yaw ?? 0), pitch: num('pitch', sp.pitch ?? 0),
        tilt: num('tilt', 0), tiltDir: num('tiltdir', 0),
      });
      applyMode();
      overlay.hidden = true;
      hudWanted = params.has('hud');
      hud.setVisible(hudWanted);
      renderer.resize(canvas.clientWidth, canvas.clientHeight);
      for (let i = 0; i < 2; i++) {
        renderer.render({ ...player.camera(), fovY: baseFov, time: 0, timeTint: num('tint', 1), timeCast, still: true });
        await renderer.device.queue.onSubmittedWorkDone();
      }
      if (hudWanted) hud.update(player.status(), current.entry.name, player, 1, renderer.info);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.__shot = { ready: true, stats: current.stats, buildMs: current.buildMs, tets: renderer.info.tets, triangles: renderer.info.triangles, draws: renderer.info.draws, liveDraws: renderer.info.liveDraws };
    } catch (e) {
      console.error(e);
      window.__shot = { error: e.message };
    }
    return;
  }

  try {
    await loadScene(params.get('scene') || SCENES[0].id);
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  }
  requestAnimationFrame(frame);
}

start();
