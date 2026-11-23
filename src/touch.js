// On-screen controls for touch screens.
//
//   left thumb    a stick that appears wherever the thumb lands in the left
//                 part of the screen: movement or thrust
//   right thumb   drag anywhere else to look
//   buttons       a row of general ones along the top; at the lower right the
//                 two that tilt the view, and under them a few that depend on
//                 the control mode
//
// read() returns the same kind of input the keyboard and mouse produce.

const STICK_RADIUS = 56; // pixels of thumb travel for full deflection
const DEAD = 0.12;

// Lower-right buttons.  `hold` buttons act while pressed.  The tilt is there
// in every control mode, with the mode's own buttons in a row beneath it.
const TILT_BUTTONS = [{ id: 'tiltBack', label: '−', hold: true }, { id: 'tiltOn', label: '+', hold: true }];
const MODE_BUTTONS = {
  walk: [{ id: 'jump', label: 'jump', hold: true, wide: true }],
  drive: [{ id: 'brake', label: 'brake', hold: true, wide: true }],
  fly: [{ id: 'brake', label: 'brake', hold: true, wide: true }, { id: 'down', label: '▼', hold: true }, { id: 'up', label: '▲', hold: true }],
  swim: [{ id: 'down', label: '▼', hold: true }, { id: 'up', label: '▲', hold: true }],
};

// Top row: each one calls onAction(id) when tapped.
const TOP_BUTTONS = [
  { id: 'level', label: 'level' },
  { id: 'tint', label: 'time' },
  { id: 'mode', label: 'mode' },
  { id: 'full', label: '⛶' },
  { id: 'menu', label: '☰' },
];

// The one control that is not in other games, the same in every mode.
const TILT = ['− / +', 'Hold to tilt the view into time: with +, what lies ahead turns to the past, further back the further off it is; with −, to the future. Except in flight, your own time slows with the tilt: it stands still at 90° and runs backwards beyond. The tilt stops for a moment when level and at 90°.'];

export const TOUCH_CONTROLS = {
  walk: [
    TILT,
    ['Left thumb', 'Walk, where the view shows: in a tilted view, forward is also earlier. Push the stick all the way to run.'],
    ['Right thumb', 'Drag to look around.'],
    ['jump', 'Jump: over a fence, or onto a low wall, where you can stand and walk.'],
  ],
  drive: [
    TILT,
    ['Left thumb', (c) => `Up and down speed up and slow down; left and right steer. Left alone the car rolls out: slowly below ${c.mark(1)}, a speed that takes little to hold, and quickly above it. Its top speed is ${c.mark(2)}.`],
    ['Right thumb', 'Drag sideways to steer too: the car turns with the view. Up and down only looks.'],
    ['brake', 'Hold to stop.'],
  ],
  fly: [
    TILT,
    ['Left thumb', 'Thrust forwards, back and sideways. There is no drag, so you keep coasting.'],
    ['Right thumb', 'Drag to turn and pitch.'],
    ['Two fingers', 'Twist them on the right to roll.'],
    ['▲ / ▼', 'Thrust up / down.'],
    ['brake', 'Hold to stop.'],
  ],
  swim: [
    TILT,
    ['Left thumb', 'Swim where you look; all the way to sprint. The water slows you back to rest.'],
    ['Right thumb', 'Drag to turn and pitch.'],
    ['▲ / ▼', 'Rise / sink.'],
  ],
  common: [['level', 'level the view and stop'], ['time', 'colour by time'], ['walk', 'the control mode: tap to change'], ['⛶', 'full screen'], ['☰', 'this page']],
};

export class TouchControls {
  constructor(canvas, root, onAction) {
    this.canvas = canvas;
    this.root = root;
    this.onAction = onAction;
    this.active = false;
    this.mode = 'walk';
    this.stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.lookers = new Map(); // pointer id -> last position
    this.look = [0, 0];
    this.twist = 0; // radians the two looking fingers have turned about each other
    this.held = new Set();
    this.pressed = new Set(); // hold buttons that went down since the last read (a quick tap can be over before it)
    this.ring = root.querySelector('.t-stick');
    this.knob = root.querySelector('.t-knob');
    this.actions = root.querySelector('.t-actions');
    this.top = root.querySelector('.t-top');

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    for (const b of TOP_BUTTONS) this.top.appendChild(this._button(b, (id) => this.onAction(id)));
    this._placeStick();
  }

  // Shows or hides the controls (they are only wanted while playing by touch).
  setActive(on) {
    this.active = on;
    this.root.hidden = !on;
    if (!on) this._release();
  }

  // name: what the mode button should read, e.g. "walk"
  setMode(mode, name = mode) {
    this.mode = mode;
    this.top.querySelector('[data-id="mode"]').textContent = name;
    this.actions.innerHTML = '';
    this.held.clear();
    const row = (buttons, caption) => {
      const el = document.createElement('div');
      el.className = 't-row';
      if (caption) {
        const c = document.createElement('span');
        c.className = 't-caption';
        c.textContent = caption;
        el.appendChild(c);
      }
      for (const b of buttons) el.appendChild(this._button(b, () => {}));
      this.actions.appendChild(el);
    };
    row(TILT_BUTTONS, 'tilt');
    if (MODE_BUTTONS[mode].length) row(MODE_BUTTONS[mode]);
  }

  // Input since the last call: { move: [right, up, forward], look: [dx, dy], run, jump, brake, tilt, twist }.
  read() {
    const s = this.stick;
    let x = 0, y = 0, mag = 0;
    if (s.id !== null) {
      mag = Math.hypot(s.x, s.y);
      if (mag > DEAD) {
        const k = (mag - DEAD) / (1 - DEAD) / mag;
        x = s.x * k; y = s.y * k;
      }
    }
    const out = {
      move: [x, (this.held.has('up') ? 1 : 0) - (this.held.has('down') ? 1 : 0), y],
      look: [this.look[0], this.look[1]],
      // pushing the stick right to its edge is running (walk) or sprinting (swim)
      run: (this.mode === 'walk' || this.mode === 'swim') && mag > 0.9,
      brake: this.held.has('brake'),
      jump: this.held.has('jump') || this.pressed.has('jump'),
      tilt: (this.held.has('tiltOn') ? 1 : 0) - (this.held.has('tiltBack') ? 1 : 0),
      twist: this.twist,
    };
    this.look[0] = this.look[1] = 0;
    this.twist = 0;
    this.pressed.clear();
    return out;
  }

  _button(def, fire) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 't-btn' + (def.wide ? ' wide' : '');
    el.textContent = def.label;
    el.dataset.id = def.id;
    const stop = () => {
      this.held.delete(def.id);
      el.classList.remove('down');
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('down');
      if (def.hold) { this.held.add(def.id); this.pressed.add(def.id); }
    });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    // Plain buttons act on the click that follows the touch, not on the touch
    // itself: otherwise that click would land on whatever the action put
    // under the finger (the menu button would press a scene card).
    if (!def.hold) el.addEventListener('click', () => fire(def.id));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }

  _down(e) {
    if (!this.active || e.pointerType === 'mouse') return;
    e.preventDefault(); // also keeps the browser from sending made-up mouse events
    this.canvas.setPointerCapture?.(e.pointerId);
    if (this.stick.id === null && e.clientX < window.innerWidth * 0.45) {
      Object.assign(this.stick, { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
      this._placeStick();
    } else {
      this.lookers.set(e.pointerId, [e.clientX, e.clientY]);
    }
  }

  _move(e) {
    const s = this.stick;
    if (e.pointerId === s.id) {
      let dx = (e.clientX - s.ox) / STICK_RADIUS, dy = (e.clientY - s.oy) / STICK_RADIUS;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        // the stick's centre is dragged along once the thumb passes its edge
        s.ox += (dx - dx / len) * STICK_RADIUS;
        s.oy += (dy - dy / len) * STICK_RADIUS;
        dx /= len; dy /= len;
      }
      s.x = dx; s.y = -dy;
      this._placeStick();
      return;
    }
    const last = this.lookers.get(e.pointerId);
    if (!last) return;
    if (this.lookers.size === 2) {
      // two fingers: turning them about each other rolls (used in fly mode)
      const [a, b] = [...this.lookers.values()];
      const before = Math.atan2(b[1] - a[1], b[0] - a[0]);
      last[0] = e.clientX; last[1] = e.clientY;
      let d = Math.atan2(b[1] - a[1], b[0] - a[0]) - before;
      if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
      this.twist += d;
      return;
    }
    // a drag across the whole screen turns about 170 degrees
    const k = 3 / Math.max(window.innerWidth, window.innerHeight);
    this.look[0] += (e.clientX - last[0]) * k;
    this.look[1] += (e.clientY - last[1]) * k;
    last[0] = e.clientX; last[1] = e.clientY;
  }

  _up(e) {
    if (e.pointerId === this.stick.id) {
      Object.assign(this.stick, { id: null, x: 0, y: 0 });
      this._placeStick();
    }
    this.lookers.delete(e.pointerId);
  }

  _release() {
    Object.assign(this.stick, { id: null, x: 0, y: 0 });
    this.lookers.clear();
    this.held.clear();
    this.pressed.clear();
    this.look[0] = this.look[1] = this.twist = 0;
    for (const el of this.root.querySelectorAll('.t-btn.down')) el.classList.remove('down');
    this._placeStick();
  }

  // Draws the stick where the thumb is, or faintly at its resting place.
  _placeStick() {
    const s = this.stick, on = s.id !== null;
    this.ring.classList.toggle('on', on);
    if (on) {
      this.ring.style.left = `${s.ox}px`;
      this.ring.style.top = `${s.oy}px`;
      this.ring.style.bottom = 'auto';
    } else {
      this.ring.style.left = this.ring.style.top = this.ring.style.bottom = '';
    }
    this.knob.style.transform = `translate(${s.x * STICK_RADIUS}px, ${-s.y * STICK_RADIUS}px)`;
  }
}
