// Heads-up display: the tilt gauge, the readouts and the key hints.

import { UNITS, speedText } from './units.js';

const PAST = '#ffb454', FUTURE = '#5ad1ff', INK = '#e9edf2', DIM = 'rgba(233,237,242,0.35)';

const TILT_HINT = ['Wheel', 'tilt into time'];
const KEY_HINTS = {
  walk: [['W A S D', 'move'], ['Shift', 'run'], ['Space', 'jump'], ['Mouse', 'look']],
  drive: [['W S', 'faster / slower'], ['A D', 'steer'], ['Space', 'brake'], ['Mouse', 'steer and look']],
  fly: [['W A S D', 'thrust'], ['Space C', 'up / down'], ['Q E', 'roll'], ['B', 'brake'], ['Mouse', 'turn']],
  swim: [['W A S D', 'swim'], ['Space C', 'up / down'], ['Shift', 'sprint'], ['Mouse', 'turn']],
};
const COMMON_HINTS = [['M', 'mode'], ['T', 'time colouring'], ['R', 'level and stop'], ['P', 'freeze'], ['[ ]', 'pace'], ['Esc', 'menu']];

// A description can be a function instead of a text: it is given
// { mark(k) }, which writes out k times the speed that the scene's car treats
// as its mark (see DRAG in player.js) in the units chosen.

// The one control that is not in other games, the same in every mode.
const TILT = ['Wheel / Z X', 'Tilt the view into time: with the wheel rolled forward (or X), what lies to your right turns to the future and what lies to your left to the past, further the further off it is; rolled back (or Z), the other way round. Except in flight, your own time slows with the tilt: it stands still at 90° and runs backwards beyond. The tilt stops for a moment when level and at 90°.'];
const TILT_UP = ['V + Wheel', 'With V held (or Ctrl, or the right mouse button), the wheel and Z X tilt the view up and down instead: rolled forward, what lies above you turns to the future and what lies below to the past.'];

export const CONTROLS = {
  walk: [
    TILT,
    TILT_UP,
    ['W A S D', 'Walk, where the view shows: in a tilted view, a step to the side is also a step through time, on or back.'],
    ['Shift', 'Run.'],
    ['Space', 'Jump: over a fence, or onto a low wall, where you can stand and walk.'],
    ['Mouse', 'Look around.'],
  ],
  drive: [
    TILT,
    TILT_UP,
    ['W / S', (c) => `Faster / slower; S from rest reverses. Left alone the car rolls out: slowly below ${c.mark(1)}, a speed that takes little to hold, and quickly above it. Hills slow it, and ground steeper than 45° it cannot climb.`],
    ['A / D', 'Steer. In a tilted view that also turns the car in time: towards the side that shows the future, it heads into the future.'],
    ['Shift', (c) => `More power: a top speed of ${c.mark(2.8)} instead of ${c.mark(2)}.`],
    ['Space', 'Brake.'],
    ['Mouse', 'Steer too: the car turns with the view. Up and down only looks.'],
  ],
  fly: [
    TILT,
    TILT_UP,
    ['Mouse', 'Turn and pitch.'],
    ['W A S D', 'Thrust. There is no drag, so you keep coasting.'],
    ['Space / C', 'Thrust up / down.'],
    ['Q / E', 'Roll.'],
    ['Shift', 'Stronger thrust.'],
    ['B', 'Brake.'],
  ],
  swim: [
    TILT,
    TILT_UP,
    ['Mouse', 'Turn and pitch.'],
    ['W A S D', 'Swim where you look. The water slows you back to rest.'],
    ['Space / C', 'Rise / sink.'],
    ['Shift', 'Sprint.'],
  ],
  common: [
    ['M', 'control mode'], ['R', 'level the view and stop'], ['P', 'freeze and look around'],
    ['[ / ]', 'slow motion / fast forward'], ['T', 'time colouring: slight, full, off'], ['N', 'music: soft, off, full'], ['Backspace', 'back to the start'], ['H', 'hide the HUD'], ['F', 'full screen'], ['G', 'measure the frame time'],
  ],
};

// "W / S" -> <kbd>W</kbd> / <kbd>S</kbd>
export const keyCaps = (keys) => keys.split(' / ').map((x) => x.split(' ').map((y) => `<kbd>${y}</kbd>`).join(' ')).join(' / ');

const $ = (id) => document.getElementById(id);

function fmtClock(t) {
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${neg ? '−' : ''}${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export class Hud {
  constructor() {
    this.root = $('hud');
    this.gauge = $('gauge').getContext('2d');
    this.el = {
      scene: $('hud-scene'), mode: $('hud-mode'), state: $('hud-state'), fps: $('hud-fps'), keys: $('hud-keys'), hint: $('hud-hint'),
      speed: $('ro-speed'), space: $('ro-space'), time: $('ro-time'), rate: $('ro-rate'), clock: $('ro-clock'), tilt: $('ro-tilt'), side: $('ro-side'), up: $('ro-up'), upName: $('ro-up-name'), look: $('ro-look'),
    };
    this.mode = null;
    this.units = UNITS.ms;
    this.fpsAcc = 0; this.fpsN = 0; this.fpsText = '';
  }

  setVisible(v) { this.root.hidden = !v; }

  // The units of the readouts (one of UNITS).
  setUnits(u) { this.units = u; }

  setMode(mode, modeName) {
    this.mode = mode;
    this.el.mode.textContent = modeName;
    this.el.keys.innerHTML = [TILT_HINT, ...KEY_HINTS[mode], ...COMMON_HINTS].map(([k, d]) => `<span><kbd>${k}</kbd> ${d}</span>`).join('');
  }

  update(st, sceneName, player, dt, info) {
    const el = this.el;
    // (the page is only touched where a text has changed: most of these stay the same from frame to frame)
    const put = (e, text) => { if (e.shown !== text) { e.shown = text; e.textContent = text; } };
    put(el.scene, sceneName);
    const sticky = player.paused ? 'frozen' : player.timeScale !== 1 ? `everything at ×${player.timeScale}` : '';
    put(el.state, this.flashText && performance.now() < this.flashUntil ? this.flashText : sticky);
    // the speed in the slice, and its parts through space and through time
    const u = this.units;
    const tint = (e, v) => { const colour = Math.abs(v) < 0.005 ? '' : v < 0 ? PAST : FUTURE; if (e.colour !== colour) { e.colour = colour; e.style.color = colour; } };
    const rate = (v, plus) => `${Math.abs(v) < 0.005 ? '' : v < 0 ? '−' : plus}${Math.abs(v).toFixed(2)} s/s`;
    put(el.speed, speedText(u, st.slice));
    put(el.space, speedText(u, st.speed));
    put(el.time, rate(st.through, '+'));
    tint(el.time, st.through);
    put(el.rate, rate(st.timeRate, ''));
    put(el.clock, fmtClock(st.t));
    const deg = st.tilt * 180 / Math.PI;
    put(el.tilt, deg < 0.05 ? 'level' : `${deg.toFixed(deg < 10 || Math.abs(deg - 90) < 10 ? 1 : 0)}°`);
    // how much earlier or later the view shows things, by their distance: to the right, and along the line of sight
    const when = (e, perMetre) => {
      const g = perMetre * u.span / u.perM;
      put(e, Math.abs(g) < 0.005 ? 'the present' : `${Math.abs(g).toFixed(2)} s ${g < 0 ? 'earlier' : 'later'} per ${u.span} ${u.length}`);
      tint(e, g);
    };
    when(el.side, st.sideGradient);
    when(el.look, st.lookGradient);
    // and upwards, which is only there while the view is tilted that way
    const lifted = Math.abs(st.upGradient * u.span / u.perM) >= 0.005;
    if (el.up.lifted !== lifted) { el.up.lifted = lifted; el.up.hidden = el.upName.hidden = !lifted; }
    if (lifted) when(el.up, st.upGradient);
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) {
      el.fps.textContent = `${Math.round(this.fpsN / this.fpsAcc)} fps · ${info.tets.toLocaleString()} tets`;
      this.fpsAcc = 0; this.fpsN = 0;
    }
    this.drawGauge(st);
  }

  // A little spacetime diagram of the plane containing the view's own
  // left-to-right direction and the scene's time axis: up is later, right is
  // further to your right.  The coloured line is the view from side to side:
  // the half that rises shows the future, the half that dips the past.  The
  // arrow is your motion through spacetime, as far as it lies in this plane:
  // straight up while you stand still or go straight on, and as long as the
  // radius when it takes in as much as time ordinarily passing does.
  drawGauge(st) {
    const c = this.gauge, S = 300, cx = S / 2, cy = S / 2, r = 112;
    c.clearRect(0, 0, S, S);
    c.lineCap = 'round';
    c.font = '500 19px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    c.strokeStyle = DIM; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    c.setLineDash([4, 8]);
    c.beginPath(); c.moveTo(cx, cy + r); c.lineTo(cx, cy - r); c.moveTo(cx - r, cy); c.lineTo(cx + r, cy); c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(233,237,242,0.55)';
    c.fillText('later', cx, cy - r - 16);
    c.fillText('right', cx + r - 14, cy + r + 8);

    // the view from side to side: (space, time), time upwards
    const [sx, sT] = st.across, L = r - 6;
    const lean = Math.abs(sT) > 0.004;
    const right = !lean ? INK : sT < 0 ? PAST : FUTURE, left = !lean ? INK : sT < 0 ? FUTURE : PAST;
    c.lineWidth = 6;
    c.strokeStyle = right;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + sx * L, cy - sT * L); c.stroke();
    c.strokeStyle = left;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx - sx * L, cy + sT * L); c.stroke();
    if (lean) {
      // a label beside each half: under the one that rises, over the one that dips, clear of the arrow
      const off = sT < 0 ? -22 : 22;
      const dx = sx * L * 0.62 + sT * off, dy = -sT * L * 0.62 + sx * off;
      c.fillStyle = right;
      c.fillText(sT < 0 ? 'past' : 'future', cx + dx, cy + dy);
      c.fillStyle = left;
      c.fillText(sT < 0 ? 'future' : 'past', cx - dx, cy - dy);
    }

    // the player's motion
    const [vx, vt] = st.travel, vl = Math.hypot(vx, vt);
    c.strokeStyle = INK; c.fillStyle = INK; c.lineWidth = 5;
    if (vl > 0.05) {
      const ux = vx / vl, uy = -vt / vl, len = Math.max(24, Math.min(1, vl) * (r - 4));
      const bx = cx + ux * (len - 16), by = cy + uy * (len - 16);
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(bx, by); c.stroke();
      c.beginPath();
      c.moveTo(cx + ux * len, cy + uy * len);
      c.lineTo(bx - uy * 11, by + ux * 11);
      c.lineTo(bx + uy * 11, by - ux * 11);
      c.closePath(); c.fill();
    }
    c.beginPath(); c.arc(cx, cy, 6, 0, Math.PI * 2); c.fill();
  }

  // Shows a short message in the top bar for a moment.
  flash(text, ms = 1800) {
    this.flashText = text;
    this.flashUntil = performance.now() + ms;
  }

  // Shows a piece of advice near the top of the screen for as long as it
  // takes to read (nine seconds at least); or several, one after another.
  hint(text, ms) {
    const el = this.el.hint, [first, ...rest] = Array.isArray(text) ? text : [text];
    el.textContent = first;
    el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      el.classList.remove('show');
      // (the next one once this one has faded)
      if (rest.length) this.hintTimer = setTimeout(() => this.hint(rest), 1200);
    }, ms ?? Math.max(9000, first.length * 55));
  }
}
