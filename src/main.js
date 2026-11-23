import { Renderer } from './renderer.js';
import { SceneBuilder } from './builder.js';
import { Player, MODES } from './player.js';
import { Colliders } from './collide.js';
import { SCENES } from './scenes/index.js';
import { Hud, CONTROLS, keyCaps } from './hud.js';
import { TouchControls, TOUCH_CONTROLS } from './touch.js';
import { UNITS, roundLength, roundSpeed, withUnits } from './units.js';

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
// A few choices are kept from one visit to the next (where the browser lets
// the page store anything).
const stored = (key) => { try { return localStorage.getItem(`tilt4d.${key}`); } catch { return null; } };
const kept = (key, fallback) => { const v = stored(key); return v === null ? fallback : Number(v); };
const keep = (key, value) => { try { localStorage.setItem(`tilt4d.${key}`, typeof value === 'string' ? value : String(Number(value))); } catch { /* nowhere to keep it */ } };
// (one of the values on offer, or the fallback: what was kept may be from an older version of the page)
const keptOf = (key, values, fallback) => { const v = kept(key, fallback); return values.includes(v) ? v : fallback; };
let hudWanted = shot ? true : !!kept('hud', 1);
// The colouring by time, which T goes round: 1 a slight warm cast on what lies
// in your past and a cool one on your future, 2 amber and blue outright with a
// line per second, 0 none.
let timeTint = shot ? 1 : [0, 1, 2].includes(kept('tint', 1)) ? kept('tint', 1) : 1;
let redraw = true; // the picture behind the menu has to be drawn again
// The other choices of the menu's settings panel (see SETTINGS below).  A
// still frame for the tools takes none of them from the browser.
const FOVS = [50, 62, 75, 90], LOOK_SPEEDS = [0.5, 0.75, 1, 1.5, 2], RESOLUTIONS = [0, 1, 0.75, 0.5];
const DEFAULTS = { tint: 1, hud: 1, units: 'ms', fov: 62, look: 1, invert: 0, res: 0 };
let units = !shot && UNITS[stored('units')] ? stored('units') : DEFAULTS.units; // a key of UNITS
let fovDeg = params.has('fov') ? num('fov', 62) : shot ? 62 : keptOf('fov', FOVS, DEFAULTS.fov); // the vertical field of view (?fov=70 sets any)
let lookSpeed = shot ? 1 : keptOf('look', LOOK_SPEEDS, DEFAULTS.look); // a factor on how far the mouse or a dragging finger turns the view
let invertLook = shot ? 0 : keptOf('invert', [0, 1], DEFAULTS.invert); // 1: pushing the mouse forward looks down
let resolution = shot ? 0 : keptOf('res', RESOLUTIONS, DEFAULTS.res); // a share of the full resolution, or 0: lowered as far as it takes to keep the frame rate up
let touchMode = false; // true once the screen has been touched (and until a mouse is used)

const keys = new Set();
const look = [0, 0];
let wheel = 0;
let jumpPressed = false; // Space went down since the last frame (a quick tap can be over before the next one)

// for poking at things from the browser console
window.tilt4d = {
  player, get renderer() { return renderer; }, get scene() { return current; }, measure: () => measure(),
  get settings() { return { mode: player.mode, tint: timeTint, units, hud: +hudWanted, pace: player.timeScale, fov: fovDeg, look: lookSpeed, invert: invertLook, res: resolution }; },
};

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', isError);
}

// ---- scenes -----------------------------------------------------------------

// How far the loading of a scene has got (0..1, or null when there is none):
// a bar across the top of the page, another on the scene's card, and words.
const loadbar = $('loadbar');
function setProgress(p, text = '', id = '') {
  loadbar.hidden = p === null;
  for (const el of document.querySelectorAll('.scene-card.loading')) if (p === null || el.dataset.id !== id) el.classList.remove('loading');
  if (p === null) return;
  loadbar.firstElementChild.style.transform = `scaleX(${p})`;
  const card = document.querySelector(`.scene-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('loading');
    card.style.setProperty('--p', p);
  }
  setStatus(`${text} ${Math.round(p * 100)}%`);
}

// A scene's geometry is built in a worker where that works (see
// build-worker.js), which leaves the page free to go on drawing and to show
// the progress; otherwise in the page itself, as the tools do.
let useWorker = typeof Worker === 'function' && (shot ? params.get('worker') === '1' : params.get('worker') !== '0');
let buildWorker = null; // a promise of the worker, once one has been asked for
function startBuildWorker() {
  return new Promise((resolve, reject) => {
    let w;
    try {
      if (typeof TILT4D_ONE_FILE !== 'undefined') {
        // the single-file build (tools/bundle.mjs): the page's one script is the worker's as well
        const text = document.querySelector('script[type="module"]').textContent;
        w = new Worker(URL.createObjectURL(new Blob([text], { type: 'text/javascript' })));
      } else {
        w = new Worker(new URL('./build-worker.js', import.meta.url), { type: 'module' });
      }
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => { w.terminate(); reject(new Error('the build worker did not start')); }, 8000);
    w.onmessage = (e) => { if (e.data.ready) { clearTimeout(timer); resolve(w); } };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'the build worker could not be loaded')); };
  });
}
async function buildInWorker(id, flat, onProgress) {
  const w = await (buildWorker || (buildWorker = startBuildWorker()));
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.progress !== undefined) onProgress(m.progress);
      else if (m.error !== undefined) reject(Object.assign(new Error(m.error), { inScene: true }));
      else if (m.data) resolve(m);
    };
    w.onerror = (e) => { buildWorker = null; w.terminate(); reject(new Error(e.message || 'the build worker failed')); };
    w.postMessage({ id, flat });
  });
}

// How much geometry a scene came to the last time it was built here (the
// `work` of its statistics), which is what its progress is measured against;
// the first time, the figure in the scene list.
const sizeKey = (id) => `tilt4d.work.${id}`;
function expectedBytes(entry) {
  try { return Number(localStorage.getItem(sizeKey(entry.id))) || entry.work || 0; } catch { return entry.work || 0; }
}

async function loadScene(id) {
  // An id that is not in the list is tried as a module name, so that a scene
  // under development can be opened with ?scene=<file name> before it is listed.
  const entry = SCENES.find((s) => s.id === id)
    || (/^[\w-]+$/.test(id || '') ? { id, name: id, mode: 'walk', load: () => import(`./scenes/${id}.js`) } : SCENES[0]);
  const progress = (p, what) => setProgress(p, `Loading “${entry.name}”: ${what}…`, entry.id);
  try {
    progress(0, 'fetching it');
    await new Promise((r) => setTimeout(r, 30)); // let the message paint
    const def = (await entry.load()).default;
    progress(0.04, 'building it');
    // Static surfaces are solid.  Where the player is kept on the ground, what
    // lies on the ground (paving, the terrain itself) is not an obstacle.
    const flat = !!MODES[def.mode || 'walk'].ground;
    let built = null;
    if (useWorker) {
      const expected = expectedBytes(entry);
      try {
        built = await buildInWorker(entry.id, flat, (bytes) => { if (expected) progress(0.04 + 0.56 * Math.min(0.98, bytes / expected), 'building it'); });
        built.solids = built.solids && Colliders.revive(built.solids);
      } catch (e) {
        // A fault in the scene's own code shows again below, with its details.
        // Anything else means workers are no use here.
        if (!e.inScene) {
          useWorker = false;
          console.warn(`building scenes in the page instead: ${e.message}`);
        }
      }
    }
    if (!built) {
      await new Promise((r) => setTimeout(r, 30));
      const t0 = performance.now();
      const builder = new SceneBuilder();
      def.build(builder);
      const data = builder.finalize();
      const buildMs = Math.round(performance.now() - t0);
      const t1 = performance.now();
      const onGround = def.ground || (flat ? () => 0 : null);
      const solids = def.solid === false ? null : new Colliders(data.solidTris, onGround);
      data.stats.solidTriangles = solids ? solids.count : 0;
      data.stats.solidMs = Math.round(performance.now() - t1);
      built = { data, solids, buildMs };
    }
    const { data, buildMs } = built;
    progress(0.6, 'handing it to the graphics card');
    await renderer.setScene(data, def, (f) => progress(0.6 + 0.4 * f, 'handing it to the graphics card'));
    try { localStorage.setItem(sizeKey(entry.id), String(data.stats.work)); } catch { /* (no storage here: the next load goes by the scene list's figure again) */ }
    current = { entry, def, stats: data.stats, buildMs };
    autoScale = 1;
    player.configure(def);
    player.solids = built.solids;
    player.mode = def.mode || 'walk';
    player.setMode(player.mode);
    player.setPose(def.spawn);
    applyMode();
    showUnits();
    setStatus('');
    redraw = true;
    console.info(`scene ${entry.id}: built in ${buildMs} ms`, data.stats);
    for (const el of document.querySelectorAll('.scene-card')) el.classList.toggle('current', el.dataset.id === entry.id);
  } finally {
    setProgress(null);
  }
}

function applyMode() {
  hud.setMode(player.mode, MODES[player.mode].name);
  $('controls-mode').textContent = `· ${MODES[player.mode].name}`;
  const table = touchMode ? TOUCH_CONTROLS : CONTROLS;
  // keyboard entries name one key per word; touch entries are whole phrases
  const caps = touchMode ? (k) => k.split(' / ').map((x) => `<kbd>${x}</kbd>`).join(' / ') : keyCaps;
  // (a description that names speeds is a function: see hud.js)
  const about = { mark: (k) => roundSpeed(UNITS[units], k * player.C) };
  $('controls').innerHTML = table[player.mode].map(([k, d]) => `<tr><td>${caps(k)}</td><td>${typeof d === 'function' ? d(about) : d}</td></tr>`).join('');
  $('controls-common').innerHTML = table.common.map(([k, d]) => `<span>${caps(k)} ${d}</span>`).join('');
  $('how-to-enter').innerHTML = touchMode
    ? 'Tap a scene to enter. <kbd>\u2630</kbd> brings this page back.'
    : 'Click a scene to enter. <kbd>Esc</kbd> brings this page back.';
  touch.setMode(player.mode, MODES[player.mode].name);
  renderSettings();
}

// Puts everything on the page that names a speed or a length in the units
// chosen: the HUD, the scene cards, the introduction and the list of controls.
function showUnits() {
  const u = UNITS[units];
  hud.setUnits(u);
  for (const s of SCENES) {
    const el = document.querySelector(`.scene-card[data-id="${s.id}"] span`);
    if (el) el.textContent = withUnits(u, s.blurb);
  }
  if (current) {
    // how far ahead the view is a second back at a tilt of 45 degrees: every scene has its own scale
    $('about-length').textContent = roundLength(u, player.C);
    $('about-scene').textContent = ` (in “${current.entry.name}”, the scene loaded now: each has its own scale)`;
    applyMode();
  }
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
  keep('tint', timeTint);
  renderSettings();
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

const sceneModes = () => (current ? current.def.modes || Object.keys(MODES) : []);
function cycleMode() {
  const modes = sceneModes();
  const next = modes[(modes.indexOf(player.mode) + 1) % modes.length];
  player.setMode(next);
  applyMode();
  hud.flash(`${MODES[next].name} mode`);
}

// ---- settings ---------------------------------------------------------------

// The panel on the menu: one row of choices for each.  `key` is the key that
// does the same while playing.  All but the mode and the pace are kept from
// one visit to the next (under `keep`'s name for them).
const SETTINGS = [
  { id: 'mode', label: 'Mode', key: 'M', options: () => sceneModes().map((m) => [m, MODES[m].name]),
    get: () => player.mode, set: (v) => { player.setMode(v); applyMode(); } },
  { id: 'tint', label: 'Time colouring', key: 'T', options: [[0, 'off'], [1, 'slight'], [2, 'full']],
    get: () => timeTint, set: (v) => { timeTint = v; } },
  { id: 'units', label: 'Units', options: Object.entries(UNITS).map(([id, u]) => [id, u.label]),
    get: () => units, set: (v) => { units = v; showUnits(); } },
  { id: 'hud', label: 'Readouts', key: 'H', options: [[1, 'shown'], [0, 'hidden']],
    get: () => +hudWanted, set: (v) => { hudWanted = !!v; } },
  { id: 'pace', label: 'Pace', key: '[ ]', options: [[0.125, '⅛'], [0.25, '¼'], [0.5, '½'], [1, '1'], [2, '2'], [4, '4'], [8, '8']],
    get: () => player.timeScale, set: (v) => { player.timeScale = v; } },
  { id: 'fov', label: 'Field of view', options: FOVS.map((v) => [v, `${v}°`]),
    get: () => fovDeg, set: (v) => { fovDeg = v; } },
  { id: 'look', label: 'Look speed', options: LOOK_SPEEDS.map((v) => [v, { 0.5: '½', 0.75: '¾', 1.5: '1½' }[v] || String(v)]),
    get: () => lookSpeed, set: (v) => { lookSpeed = v; } },
  { id: 'invert', label: 'Look up / down', options: [[0, 'normal'], [1, 'inverted']],
    get: () => invertLook, set: (v) => { invertLook = v; } },
  { id: 'res', label: 'Resolution', options: RESOLUTIONS.map((v) => [v, { 0: 'auto', 1: 'full', 0.75: '¾', 0.5: '½' }[v]]),
    get: () => resolution, set: (v) => { resolution = v; autoScale = 1; } },
];
const settingOptions = (s) => (typeof s.options === 'function' ? s.options() : s.options);

function renderSettings() {
  $('settings').innerHTML = SETTINGS.map((s) => {
    const options = settingOptions(s), now = s.get();
    if (!options.length) return '';
    return `<span class="set-name">${s.label}${s.key ? ` <i>${keyCaps(s.key)}</i>` : ''}</span><span class="seg" role="group" aria-label="${s.label}">`
      + options.map(([v, text], i) => `<button type="button" data-set="${s.id}" data-i="${i}" aria-pressed="${v === now}"${v === now ? ' class="on"' : ''}>${text}</button>`).join('')
      + '</span>';
  }).join('');
}

function applySetting(id, value) {
  const s = SETTINGS.find((x) => x.id === id);
  s.set(value);
  if (id in DEFAULTS) keep(id, value);
  redraw = true;
  renderSettings();
}

$('settings').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-set]');
  if (!b) return;
  const s = SETTINGS.find((x) => x.id === b.dataset.set);
  applySetting(s.id, settingOptions(s)[Number(b.dataset.i)][0]);
  // (the buttons have been made anew: someone going through them with the keyboard stays where they were)
  if (e.detail === 0) $('settings').querySelector(`button[data-set="${b.dataset.set}"][data-i="${b.dataset.i}"]`)?.focus();
});
$('settings-reset').addEventListener('click', () => {
  for (const [id, value] of Object.entries(DEFAULTS)) applySetting(id, value);
});
// The panel opens under its button in the menu's head, and closes by the
// button, by Esc, or by a click anywhere else.
function showSettings(open) {
  $('settings-panel').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
}
$('settings-toggle').addEventListener('click', () => showSettings($('settings-panel').hidden));
addEventListener('pointerdown', (e) => { if (!$('settings-panel').hidden && !e.target.closest?.('.settings-box')) showSettings(false); });

function buildSceneList() {
  const list = $('scene-list');
  list.innerHTML = '';
  for (const s of SCENES) {
    const b = document.createElement('button');
    b.className = 'scene-card';
    b.dataset.id = s.id;
    // (how heavy the scene is to draw, as one to six marks)
    const w = Math.max(1, Math.min(6, s.weight || 1));
    const weight = `<em class="weight" title="How much there is to draw: ${['very little', 'little', 'a fair amount', 'a lot', 'a great deal: for desktop graphics cards', 'a very great deal: for fast desktop graphics cards'][w - 1]}">${'<u></u>'.repeat(w)}${'<s></s>'.repeat(6 - w)}</em>`;
    b.innerHTML = `<b>${s.name}</b><i>${MODES[s.mode]?.name ?? ''} ${weight}</i><span>${withUnits(UNITS[units], s.blurb)}</span>`;
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
  showSettings(false);
  const hint = (touchMode && current.entry.touchHint) || current.entry.hint;
  if (hint && !current.hinted) {
    current.hinted = true;
    hud.hint(withUnits(UNITS[units], hint));
  }
  overlay.hidden = true;
  hud.setVisible(hudWanted);
  touch.setActive(touchMode);
  keys.clear();
}

function leave() {
  playing = false;
  redraw = true;
  if (document.pointerLockElement === canvas) document.exitPointerLock?.(); // (Esc lets go of the mouse by itself; the other ways here do not)
  renderSettings(); // (the keys may have changed some of them)
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
  const tanY = Math.tan(fovDeg * Math.PI / 360);
  return 2 * Math.atan(Math.min(1.3, Math.max(tanY, 0.75 / aspect)));
}

addEventListener('keydown', (e) => {
  if (!playing) {
    if (e.code === 'Escape' && !$('settings-panel').hidden) { showSettings(false); $('settings-toggle').focus(); }
    // on the menu, Enter goes (back) into the scene that is loaded, unless a button has the focus and takes it itself
    if (e.code === 'Enter' && !overlay.hidden && document.activeElement?.tagName !== 'BUTTON') document.querySelector('.scene-card.current:not([disabled])')?.click();
    return;
  }
  if (e.code === 'Escape') { leave(); return; }
  keys.add(e.code);
  if (['Space', 'Tab', 'Backspace'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  switch (e.code) {
    case 'Space': jumpPressed = true; break;
    case 'KeyM': cycleMode(); break;
    case 'KeyR': levelAndStop(); break;
    case 'KeyP': player.paused = !player.paused; break;
    case 'KeyH': hudWanted = !hudWanted; keep('hud', hudWanted); hud.setVisible(hudWanted); renderSettings(); break;
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
  // With Shift held (running), Chrome and Edge report a wheel's notches as
  // sideways scrolling: those tilt just the same.
  const delta = e.deltaY || (e.shiftKey ? e.deltaX : 0);
  // Rolling the wheel away from you tilts the view ahead into the past.
  wheel -= Math.max(-1, Math.min(1, delta / notch));
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
    look: [(look[0] + t.look[0]) * lookSpeed, (look[1] + t.look[1]) * lookSpeed * (invertLook ? -1 : 1)],
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
  // Behind the menu, a scene that has been entered stands still: there is
  // nothing new to draw until something changes, so nothing is drawn.
  if (current && !playing && entered) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!redraw && w === frame.w && h === frame.h) { requestAnimationFrame(frame); return; }
    frame.w = w; frame.h = h;
  }
  redraw = false;
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
    // (unless the settings name a share of the full resolution, which then holds)
    const share = resolution || autoScale;
    // ... and with detail that is only drawn from near by shown from less far
    renderer.detail = params.has('scale') ? 1 : share;
    // (behind the menu, which dims and covers nearly all of it, half the resolution does)
    const scale = Math.min(devicePixelRatio || 1, 1.5) * (params.has('scale') ? num('scale', 1) : share * (playing ? 1 : 0.5));
    renderer.resize(canvas.clientWidth * scale, canvas.clientHeight * scale);
    renderer.render({ ...player.camera(), fovY: fovFor(canvas.clientWidth / canvas.clientHeight), time: now / 1000, timeTint, timeCast });
    if (playing && hudWanted) hud.update(player.status(), current.entry.name, player, dt, renderer.info);
  }
  requestAnimationFrame(frame);
}

async function start() {
  buildSceneList();
  hud.setUnits(UNITS[units]);
  renderSettings();
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
  if (params.has('cull')) renderer.cull = num('cull', 31) | 0; // (0: draw everything in every pass, to compare with; see renderer.js)
  if (params.get('order') === '0') renderer.nearFirst = false; // (draw static geometry in the order it is stored, to compare with)
  // Browsers take the graphics device away now and then (a phone that had
  // the page in the background, a driver that was restarted).
  renderer.device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    console.error('device lost', info.message);
    if (playing) { document.exitPointerLock?.(); leave(); }
    setStatus('The browser has taken the graphics device away from this page (this happens after a while in the background, or when the graphics driver restarts). Reload the page to go on.', true);
    for (const el of document.querySelectorAll('.scene-card')) el.disabled = true;
  });

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
        renderer.render({ ...player.camera(), fovY: fovDeg * Math.PI / 180, time: 0, timeTint: num('tint', 1), timeCast, still: true });
        await renderer.settle();
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
