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
const TILT = ['Wheel / Z X', 'Tilt the view into time: what lies ahead turns to the past (or, the other way, the future), further back the further off it is. Except in flight, your own time slows with the tilt: it stands still at 90° and runs backwards beyond. The tilt stops for a moment when level and at 90°.'];

export const CONTROLS = {
  walk: [
    TILT,
    ['W A S D', 'Walk, where the view shows: in a tilted view, forward is also earlier.'],
    ['Shift', 'Run.'],
    ['Space', 'Jump: over a fence, or onto a low wall, where you can stand and walk.'],
    ['Mouse', 'Look around.'],
  ],
  drive: [
    TILT,
    ['W / S', (c) => `Faster / slower; S from rest reverses. Left alone the car rolls out: slowly below ${c.mark(1)}, a speed that takes little to hold, and quickly above it. Hills slow it, and ground steeper than 45° it cannot climb.`],
    ['A / D', 'Steer.'],
    ['Shift', (c) => `More power: a top speed of ${c.mark(2.8)} instead of ${c.mark(2)}.`],
    ['Space', 'Brake.'],
    ['Mouse', 'Steer too: the car turns with the view. Up and down only looks.'],
  ],
  fly: [
    TILT,
    ['Mouse', 'Turn and pitch.'],
    ['W A S D', 'Thrust. There is no drag, so you keep coasting.'],
    ['Space / C', 'Thrust up / down.'],
    ['Q / E', 'Roll.'],
    ['Shift', 'Stronger thrust.'],
    ['B', 'Brake.'],
  ],
  swim: [
    TILT,
    ['Mouse', 'Turn and pitch.'],
    ['W A S D', 'Swim where you look. The water slows you back to rest.'],
    ['Space / C', 'Rise / sink.'],
    ['Shift', 'Sprint.'],
  ],
  common: [
    ['M', 'control mode'], ['R', 'level the view and stop'], ['P', 'freeze and look around'],
    ['[ / ]', 'slow motion / fast forward'], ['T', 'time colouring: slight, full, off'], ['Backspace', 'back to the start'], ['H', 'hide the HUD'], ['F', 'full screen'], ['G', 'measure the frame time'],
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
      speed: $('ro-speed'), space: $('ro-space'), time: $('ro-time'), rate: $('ro-rate'), clock: $('ro-clock'), tilt: $('ro-tilt'), look: $('ro-look'),
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
    const g = st.lookGradient * u.span / u.perM;
    put(el.look, Math.abs(g) < 0.005 ? 'the present' : `${Math.abs(g).toFixed(2)} s ${g < 0 ? 'earlier' : 'later'} per ${u.span} ${u.length}`);
    tint(el.look, g);
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) {
      el.fps.textContent = `${Math.round(this.fpsN / this.fpsAcc)} fps · ${info.tets.toLocaleString()} tets`;
      this.fpsAcc = 0; this.fpsN = 0;
    }
    this.drawGauge(st);
  }

  // A little spacetime diagram of the plane containing your line of sight and
  // the scene's time axis: up is later, right is further ahead.  The coloured
  // line is the line of sight (and, dotted, its continuation behind you); the
  // arrow is your motion through spacetime, as far as it lies in this plane:
  // straight up while you stand still, and as long as the radius when it
  // takes in as much as time ordinarily passing does.
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
    c.fillText('ahead', cx + r - 14, cy + r + 8);

    // line of sight: (space, time), time upwards
    const [sx, sT] = st.sight, L = r - 6;
    const lean = Math.abs(sT) > 0.004;
    const ahead = !lean ? INK : sT < 0 ? PAST : FUTURE, behind = !lean ? INK : sT < 0 ? FUTURE : PAST;
    c.lineWidth = 6;
    c.strokeStyle = ahead;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + sx * L, cy - sT * L); c.stroke();
    c.strokeStyle = behind; c.setLineDash([2, 12]);
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx - sx * L, cy + sT * L); c.stroke();
    c.setLineDash([]);
    if (lean) {
      // label beside the line, on the side away from the arrow
      const off = sT < 0 ? 22 : -22;
      c.fillStyle = ahead;
      c.fillText(sT < 0 ? 'past' : 'future', cx + sx * L * 0.62 + sT * off, cy - sT * L * 0.62 + sx * off);
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

  // Shows a sentence of advice near the top of the screen for a while.
  hint(text, ms = 9000) {
    const el = this.el.hint;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
}
