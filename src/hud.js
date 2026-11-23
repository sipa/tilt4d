// Heads-up display: the tilt gauge, the readouts and the key hints.

const PAST = '#ffb454', FUTURE = '#5ad1ff', INK = '#e9edf2', DIM = 'rgba(233,237,242,0.35)';

const TILT_HINT = ['Wheel', 'tilt into time'];
const KEY_HINTS = {
  walk: [['W A S D', 'move'], ['Shift', 'run'], ['Space', 'jump'], ['Mouse', 'look']],
  drive: [['W S', 'faster / slower'], ['A D', 'steer'], ['Space', 'brake'], ['Mouse', 'look around']],
  fly: [['W A S D', 'thrust'], ['Space C', 'up / down'], ['Q E', 'roll'], ['B', 'brake'], ['Mouse', 'turn']],
  swim: [['W A S D', 'swim'], ['Space C', 'up / down'], ['Shift', 'sprint'], ['Mouse', 'turn']],
};
const COMMON_HINTS = [['M', 'mode'], ['T', 'time colouring'], ['R', 'level and stop'], ['P', 'freeze'], ['[ ]', 'pace'], ['Esc', 'menu']];

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
    ['W / S', 'Faster / slower. The speed holds; S from rest reverses.'],
    ['A / D', 'Steer.'],
    ['Space', 'Brake.'],
    ['Mouse', 'Look around without steering.'],
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
      speed: $('ro-speed'), rate: $('ro-rate'), clock: $('ro-clock'), tilt: $('ro-tilt'), look: $('ro-look'),
    };
    this.mode = null;
    this.fpsAcc = 0; this.fpsN = 0; this.fpsText = '';
  }

  setVisible(v) { this.root.hidden = !v; }

  setMode(mode, modeName) {
    this.mode = mode;
    this.el.mode.textContent = modeName;
    this.el.keys.innerHTML = [TILT_HINT, ...KEY_HINTS[mode], ...COMMON_HINTS].map(([k, d]) => `<span><kbd>${k}</kbd> ${d}</span>`).join('');
  }

  update(st, sceneName, player, dt, info) {
    const el = this.el;
    el.scene.textContent = sceneName;
    const sticky = player.paused ? 'frozen' : player.timeScale !== 1 ? `everything at ×${player.timeScale}` : '';
    el.state.textContent = this.flashText && performance.now() < this.flashUntil ? this.flashText : sticky;
    el.speed.textContent = `${st.speed.toFixed(1)} m/s  (${st.fraction.toFixed(2)} C)`;
    el.rate.textContent = `${st.timeRate >= 0 ? '' : '−'}${Math.abs(st.timeRate).toFixed(2)} s per second`;
    el.clock.textContent = fmtClock(st.t);
    const deg = st.tilt * 180 / Math.PI;
    el.tilt.textContent = deg < 0.05 ? 'level' : `${deg.toFixed(deg < 10 || Math.abs(deg - 90) < 10 ? 1 : 0)}°`;
    const g = st.lookGradient * 10;
    el.look.textContent = Math.abs(g) < 0.005 ? 'the present' : `${Math.abs(g).toFixed(2)} s ${g < 0 ? 'earlier' : 'later'} per 10 m`;
    el.look.style.color = Math.abs(g) < 0.005 ? '' : g < 0 ? PAST : FUTURE;
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
  // straight up while you stand still, as long as the radius at speed C.
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
