// The player: a position in (x, y, z, t), a velocity, and an orthonormal 4D
// frame whose columns are
//   R  screen right     (starts as +X)
//   U  screen up        (starts as +Z)
//   F  facing direction (starts as +Y)
//   O  the fourth one, orthogonal to the other three (starts as +T)
// The time component of every vector is measured in metres (w = C * t).
//
// What is on screen is the 3D slice spanned by R, U and F.  O is the slice's
// normal and has no other job than to be rotated against.  Four controls turn
// the frame, each a rotation in the plane of two of its columns:
//   turning   F and R
//   pitching  F and U
//   rolling   U and R
//   tilting   F and O: F leans into the past (or the future), so that what
//             lies ahead is seen earlier (or later) the further away it is
//
// The velocity is not tied to the frame.  It has two parts:
//
//   rate  how fast the scene's time passes for a player who is left alone.
//         They stay where they are, and friction with the ground or the
//         water brings this to the time component of O, cos(tilt): one second
//         per second with a level slice, none at 90 degrees, backwards
//         beyond.  (One way to read it: the player is always carried along O
//         at speed C, and what stands still in the world holds back the
//         spatial part of that.)  In flight there is nothing to hold on to,
//         and there the rate is simply 1.
//   vel   what the controls add to that, as a 4-vector.  The controls are the
//         usual ones for walking, driving, flying and swimming, but they work
//         along the frame's own directions, time component included:
//         "forward" is F, so moving forward in a tilted slice also moves the
//         player back in time, by sin(tilt) / C seconds for every metre.
//
// What the tilt does to the view goes as its tangent (the scene is stretched
// by 1 / cos(tilt)), which runs off to infinity at 90 degrees.  So a held
// tilting key does not turn at a constant rate: the rate is multiplied by
//   ease + (1 - ease) * cos(tilt)^2
// which, with the small `ease` used, is a steady growth of tan(tilt) up to
// about 84 degrees and a slow steady turn (0.4 degrees a second) from there.
// The wheel's steps shrink in the same way.  And the tilt stops for a moment
// on every quarter turn (level, 90 degrees).
//
// A car goes where it points (along F), and the mouse turns it as it turns a
// walker.  Left alone it rolls out, by a friction that is small up to C and
// grows quickly beyond (see DRAG).

import { f4 } from './math.js';

const R = 0, U = 1, F = 2, O = 3;
const T_AXIS = [0, 0, 0, 1];
const Z_AXIS = [0, 0, 1, 0];
const HALF_PI = Math.PI / 2;
const MAX_SPEED = 4; // in units of C; nothing special happens there, it only keeps things in hand
// Driving: what slows the car, as a share of the engine's plain acceleration
// (0.25 * accel * C per second per second), at a speed of s times C:
//   DRAG[0] + DRAG[1] * s + DRAG[2] * max(0, s - 1)^2
// The first two are the road: a quarter of the engine holds C, and a car left
// alone at C takes about half a minute to roll out.  The third is what comes
// on top beyond C: at 1.5 C it takes half of the engine to keep going, and
// the engine's all is 2 C (2.8 C with Shift).  The speed meant is the car's
// own, along F: in a tilted view that is the speed at which the stretched
// scenery goes by, and 1 / cos(tilt) times the speed over the ground.
const DRAG = [0.1, 0.15, 0.6];
const GRAVITY = 9.81, JUMP = 5; // walking: a jump leaves the ground at 5 m/s, which carries the feet 1.27 m up
const MAX_CLIMB = Math.PI / 3; // walking: the slope of the ground at which there is no way up it any more

// The player's body for collisions: an upright cylinder from `lo` to `hi`
// above the feet on the ground, a sphere about the eye otherwise.  Things
// lower than `lo` are stepped over.
const BODY = {
  walk: { r: 0.35, lo: 0.45, hi: 1.8 },
  drive: { r: 0.9, lo: 0.35, hi: 1.3 },
  fly: { r: 0.45 },
  swim: { r: 0.45 },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const MODES = {
  walk: { name: 'Walk', ground: true },
  drive: { name: 'Drive', ground: true },
  fly: { name: 'Fly', ground: false },
  swim: { name: 'Swim', ground: false },
};

export class Player {
  constructor() {
    this.P = [0, 0, 0, 0];
    this.M = f4.identity();
    this.rate = 1; // seconds of scene time per second that pass for a player left alone
    this.vel = [0, 0, 0, 0]; // what the controls add to that, in m/s (the 4th: C * seconds per second)
    this.speed = 0; // drive mode: the car's speed along F
    this.viewPitch = 0; // the ground modes: looking up or down, which leaves the frame as it is
    this.mode = 'walk';
    this.C = 10;
    this.walkSpeed = 3;
    this.runSpeed = 8;
    this.accel = 1;
    // walk mode, off the ground: the height of the feet (null while they are
    // on the ground), how fast it is changing, and whether they are in the air
    this.feet = null;
    this.vz = 0;
    this.air = false;
    this.tiltHold = 0; // seconds for which the tilt stays put on a quarter turn
    this.ease = 0.01; // share of the tilting rate that is left at 90 degrees; 1 = no easing
    this.eye = 1.7;
    this.ground = null;
    this.solids = null; // a Colliders, set by whoever loads the scene
    this.align = true;
    this.timeScale = 1;
    this.paused = false;
    this.rest(0);
  }

  col(i) { return f4.col(this.M, i); }

  // Stand still with a level slice, facing `yaw` radians clockwise from +Y
  // (seen from above).
  rest(yaw = this.yaw()) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.M.set([c, -s, 0, 0, 0, 0, 1, 0, s, c, 0, 0, 0, 0, 0, 1]);
    this.tiltHold = 0;
    this.stop();
  }

  // Stand still, leaving the frame as it is: no motion, and time passing at
  // the rate that goes with the tilt.
  stop() {
    this._halt();
    this.rate = this._restRate();
  }

  // Back on the ground: ends a jump, or standing on top of something.
  _setDown() {
    this.feet = null;
    this.vz = 0;
    this.air = false;
  }

  // Takes away what the controls have added, and nothing else.
  _halt() {
    this.vel = [0, 0, 0, 0];
    this.speed = 0;
  }

  // The rate at which time passes for a player who is left alone: the time
  // component of O where the ground or the water holds them, 1 in flight.
  _restRate() {
    return this.mode === 'fly' ? 1 : this.M[15];
  }

  // Take the tilt out, keeping the way you face as far as possible: the
  // smallest rotation that takes O back onto the time axis.
  level() {
    const o = this.col(O);
    if (o[3] < -0.9999) {
      const vel = this.vel, speed = this.speed, rate = this.rate;
      this.rest();
      this.vel = vel; this.speed = speed; this.rate = rate;
    } else {
      f4.rotTowards(this.M, o, T_AXIS);
    }
    this.tiltHold = 0;
  }

  configure(def) {
    this.C = def.C ?? 10;
    this.ground = def.ground || null;
    this.solids = null;
    this.ceiling = def.ceiling ?? null;
    this.align = def.alignToGround ?? true;
    this.walkSpeed = def.walkSpeed ?? 3;
    this.runSpeed = def.runSpeed ?? 8;
    this._setDown();
    this.eyeHeights = { walk: 1.7, drive: 1.25, ...(def.eyeHeight || {}) };
    this.accel = def.accel ?? 1;
    this.tiltHold = 0;
    this.timeScale = 1;
    this.paused = false;
    this.stop();
  }

  // Changes the control mode.  The tilt and the heading are kept; the motion
  // is, too, between the two free modes.
  setMode(mode) {
    const was = MODES[this.mode], now = MODES[mode], M = this.M;
    this.mode = mode;
    this._setDown();
    this.eye = this.eyeHeights?.[mode] ?? 1.7;
    if (now.ground && !was.ground) {
      this.viewPitch = clamp(Math.asin(clamp(M[F * 4 + 2], -1, 1)), -1.55, 1.55);
      this._upright();
    } else if (was.ground && !now.ground) {
      f4.rotCols(M, F, U, this.viewPitch);
      this.viewPitch = 0;
    } else if (mode === 'walk') {
      this._upright(); // out of a car that leans with the slope: stand up, facing the same way on the map
    }
    if (now.ground || was.ground) this.stop();
    if (now.ground) {
      if (!was.ground) this._land();
      this._stickToGround(1, true);
      if (this.solids) this._collide();
    }
  }

  // Stands the frame upright for a ground mode: U becomes +Z, and the tilt
  // and the heading stay as they are as far as that allows.
  _upright() {
    const strip = (v, ...basis) => {
      let w = v.slice();
      for (const b of basis) {
        const d = f4.dot(w, b);
        w = w.map((x, k) => x - d * b[k]);
      }
      return w;
    };
    const long = (v) => Math.hypot(v[0], v[1], v[2], v[3]) > 0.05;
    const f = this.col(F), u = this.col(U);
    let o = strip(this.col(O), Z_AXIS);
    o = long(o) ? f4.norm(o) : T_AXIS; // the slice was tilted straight up or down: level it
    // the heading: where F points, or, looking straight up or down, where the top of the view was
    const back = f[2] > 0 ? -1 : 1;
    let h = null;
    for (const c of [f, u.map((x) => x * back), this.col(R)]) {
      const w = strip(c, Z_AXIS, o);
      if (long(w)) { h = f4.norm(w); break; }
    }
    if (!h) return this.rest(0);
    const M = this.M;
    f4.setCol(M, U, Z_AXIS);
    f4.setCol(M, F, h);
    f4.setCol(M, O, o);
    f4.setCol(M, R, f4.cross(Z_AXIS, h, o).map((x) => -x)); // keeps the frame's handedness
  }

  // Coming down from the air onto a roof would put the player inside the
  // building: set down at the nearest spot that is open to where they were.
  _land() {
    const s = this.solids, P = this.P;
    if (!s) return;
    const open = (x, y) => s.clearColumn(x, y, (this.ground ? this.ground(x, y, P[3]) : 0) + BODY.walk.lo, P[2]);
    if (open(P[0], P[1])) return;
    for (let d = 1; d <= 80; d += 1) {
      const n = Math.max(8, Math.round(d * 4));
      for (let i = 0; i < n; i++) {
        const a = i * 2 * Math.PI / n, x = P[0] + d * Math.cos(a), y = P[1] + d * Math.sin(a);
        // open at the spot itself and a body's width round it
        if (open(x, y) && open(x + 0.6, y) && open(x - 0.6, y) && open(x, y + 0.6) && open(x, y - 0.6)) {
          P[0] = x; P[1] = y;
          return;
        }
      }
    }
  }

  // pos [x, y, z], t, yaw/pitch in degrees, tilt in degrees towards the
  // direction tiltDir degrees clockwise from the heading.  The player stands
  // still.
  setPose({ pos = [0, 0, 0], t = 0, yaw = 0, pitch = 0, tilt = 0, tiltDir = 0 } = {}) {
    const rad = Math.PI / 180;
    this.P = [pos[0], pos[1], pos[2], t];
    this._setDown();
    this.rest(yaw * rad);
    this.viewPitch = 0;
    if (MODES[this.mode].ground) {
      this._stickToGround(1, true);
      this.viewPitch = pitch * rad;
    } else {
      f4.rotCols(this.M, F, U, pitch * rad);
    }
    if (tilt) {
      const h = this.col(F), r = this.col(R), a = tiltDir * rad;
      const dir = [0, 1, 2, 3].map((k) => Math.cos(a) * h[k] + Math.sin(a) * r[k]);
      f4.rotPlane(this.M, this.col(O), dir, tilt * rad);
    }
    this.rate = this._restRate();
  }

  // Heading of the camera in space, radians clockwise from +Y.
  yaw() {
    const c = this.camera().F;
    return Math.hypot(c[0], c[1]) > 1e-6 ? Math.atan2(c[0], c[1]) : 0;
  }

  // The factor on a gradual change of the tilt: 1 with a level slice, `ease`
  // at 90 degrees.
  _ease() {
    const c = this.M[15]; // cos(tilt)
    return this.ease + (1 - this.ease) * c * c;
  }

  // The tilting control: rotates F and O by `angle`, F leaning into the past
  // for a positive one.  A turn that would reach or pass a quarter turn of
  // the time axis in their plane (F level again, or F along time) lands
  // exactly on it, and the tilt then stays put for a moment, so that those
  // are easy to hit.  Returns whether that happened.
  _tilt(angle) {
    if (!angle || this.tiltHold > 0) return false;
    const M = this.M;
    const ft = M[F * 4 + 3], ot = M[O * 4 + 3];
    let landed = false;
    if (Math.hypot(ft, ot) > 1e-3) {
      const phi = Math.atan2(-ft, ot); // the tilt as it shows along F
      const q = phi / HALF_PI;
      const stop = (angle > 0 ? Math.floor(q + 1e-7) + 1 : Math.ceil(q - 1e-7) - 1) * HALF_PI;
      if (angle > 0 ? phi + angle >= stop - 1e-9 : phi + angle <= stop + 1e-9) {
        angle = stop - phi;
        this.tiltHold = 0.45;
        landed = true;
      }
    }
    f4.rotCols(M, O, F, angle);
    return landed;
  }

  // The wheel (or a tap on a − / + button) tilts in steps, which shrink
  // towards 90 degrees.
  _tiltSteps(notches) {
    const dir = Math.sign(notches);
    let left = Math.min(8, Math.abs(notches));
    while (left > 0) {
      const c = this.M[15];
      if (this._tilt(dir * Math.min(1, left) * 0.1 * (0.04 + 0.96 * c * c))) break;
      left -= 1;
    }
  }

  // input: { move: [right, up, forward], look: [dx, dy] radians, roll, run,
  //          jump, brake, tilt (-1..1, held), wheel (notches of tilt, may be
  //          fractional), twist }
  update(dt, input) {
    const M = this.M, C = this.C, vel = this.vel;
    const [lx, ly] = input.look;
    const rate = this.accel * (input.run ? (this.mode === 'swim' ? 1.9 : 2.5) : 1);
    const ground = MODES[this.mode].ground;

    // ---- the frame
    switch (this.mode) {
      case 'walk':
      case 'drive':
        // looking left or right turns the walker, and the car: it steers
        f4.rotCols(M, F, R, lx);
        this.viewPitch = clamp(this.viewPitch - ly, -1.55, 1.55);
        if (this.mode === 'drive' && input.move[0]) {
          // the steering keys turn it at a rate, which is higher while it is moving
          const moving = Math.min(1, Math.abs(this.speed) / (0.33 * C));
          f4.rotCols(M, F, R, input.move[0] * (0.35 + 0.65 * moving) * 0.9 * dt);
        }
        break;
      default:
        f4.rotCols(M, F, R, lx);
        f4.rotCols(M, F, U, -ly);
        if (input.roll) f4.rotCols(M, U, R, input.roll * 1.2 * dt);
        // a roll given directly as an angle (a two-finger twist): the view turns with the fingers
        if (input.twist) f4.rotCols(M, U, R, -input.twist);
    }
    this.tiltHold = Math.max(0, this.tiltHold - dt);
    if (input.wheel) this._tiltSteps(input.wheel);
    if (input.tilt) this._tilt(input.tilt * 0.7 * dt * this._ease());

    // ---- the velocity
    // The resting rate of time goes to where friction takes it: at once on
    // the ground, as slowly as the rest of the motion in water.  (In flight
    // it is 1 throughout; the easing there only smooths a change of mode.)
    this.rate += (this._restRate() - this.rate) * (1 - Math.exp(-dt / (this.mode === 'swim' ? 1.3 : this.mode === 'fly' ? 0.5 : 0.12)));
    const r = this.col(R), u = this.col(U), f = this.col(F);
    switch (this.mode) {
      case 'walk': {
        // towards the speed asked for, along F and R as they are now
        const mx = input.move[0], my = input.move[2], ml = Math.hypot(mx, my);
        const s = ml > 0.01 ? (input.run ? this.runSpeed : this.walkSpeed) / ml : 0;
        const want = [0, 1, 2, 3].map((i) => s * (my * f[i] + mx * r[i]));
        this._climb(want, f, r);
        const k = 1 - Math.exp(-dt / 0.12);
        for (let i = 0; i < 4; i++) vel[i] += (want[i] - vel[i]) * k;
        break;
      }
      case 'drive': {
        // a car goes where it points; the engine, the brake, and friction
        // (see DRAG), which like the brake stops the car but does not turn
        // it round
        const slow = (by) => { this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), by); };
        const s = Math.abs(this.speed) / C, over = Math.max(0, s - 1);
        const drag = (DRAG[0] + DRAG[1] * s + DRAG[2] * over * over) * 0.25 * this.accel * C * dt;
        this.speed += input.move[2] * 0.25 * rate * C * dt;
        if (input.brake) slow(C * dt);
        slow(drag);
        this.speed = clamp(this.speed, -MAX_SPEED * C, MAX_SPEED * C);
        for (let i = 0; i < 4; i++) vel[i] = this.speed * f[i];
        break;
      }
      default: {
        const m = input.move, ml = Math.hypot(m[0], m[1], m[2]);
        const swim = this.mode === 'swim';
        if (ml > 0.01) {
          const a = 0.5 * rate * C * Math.min(1, ml) * dt / ml;
          for (let i = 0; i < 4; i++) vel[i] += a * (m[0] * r[i] + m[1] * u[i] + m[2] * f[i]);
        }
        if (swim) {
          // water drag brings the swimmer back to rest; the body rights itself
          const k = Math.exp(-dt / 1.3);
          for (let i = 0; i < 4; i++) vel[i] *= k;
          f4.rotCols(M, R, U, Math.atan2(-r[2], u[2]) * Math.min(1, 2.5 * dt));
        }
        const v = Math.hypot(vel[0], vel[1], vel[2], vel[3]);
        if (v > 0) {
          const to = Math.min(input.brake ? Math.max(0, v - 1.6 * C * dt) : v, MAX_SPEED * C);
          for (let i = 0; i < 4; i++) vel[i] *= to / v;
        }
      }
    }

    // ---- travel: the scene's time passes at the resting rate, and the
    // velocity comes on top.
    // With solid surfaces about, in steps short enough that none of them can
    // be stepped across.
    let left = this.paused ? 0 : dt * this.timeScale;
    const stride = this.solids && this.solids.count ? BODY[this.mode].r * 0.5 : Infinity;
    const P = this.P;
    let jump = this.mode === 'walk' && !!input.jump;
    for (let i = 0; left > 0; i++) {
      const v = this.vel;
      const speed = Math.hypot(v[0], v[1], v[2]);
      const h = i === 255 || speed * left <= stride ? left : stride / speed;
      const x = P[0], y = P[1], z = P[2];
      P[0] += v[0] * h;
      P[1] += v[1] * h;
      P[2] += v[2] * h;
      P[3] += (this.rate + v[3] / C) * h;
      left -= h;
      if (this.mode === 'walk' && (jump || this.feet !== null)) this._vertical(h, jump);
      jump = false;
      if (stride === Infinity) continue;
      if (!ground) this._bounds();
      this._collide();
      if (!ground && this._bounds()) {
        this._collide();
        if (this._bounds()) {
          // wedged between a surface and the floor or ceiling: no way on
          P[0] = x; P[1] = y; P[2] = z;
          this._halt();
        }
      }
    }

    if (ground) {
      this._stickToGround(Math.min(1, 8 * dt), false);
      f4.orthonormalize(M, [U, O, F, R]);
    } else {
      f4.orthonormalize(M, [O, F, U, R]);
      this._bounds();
    }
  }

  // Walking on sloping ground.  The pace is kept along the slope, so on the
  // map the part of the motion that goes straight up or down the slope
  // shrinks by the slope's cosine.  Going up is harder than that: it shrinks
  // by 1 - (slope / MAX_CLIMB)^2 as well, so that a gentle hill is hardly
  // felt, a steep one is slow, and at 60 degrees there is no way up at all.
  // Ground that steep is like a wall to a walker: it can be walked along and
  // down, but not up, by any zigzag or by jumping at it.  (A peak with such
  // slopes all round is for flying to.)  The part of the motion along the
  // contour is left as it is.  As with walls, what is taken off v (a
  // velocity along f and r) lies in the slice.
  _climb(v, f, r) {
    const g = this.ground, P = this.P;
    if (!g || (this.feet !== null && !this.air)) return; // level ground, or standing on top of something
    const e = 0.4;
    const dx = (g(P[0] + e, P[1], P[3]) - g(P[0] - e, P[1], P[3])) / (2 * e);
    const dy = (g(P[0], P[1] + e, P[3]) - g(P[0], P[1] - e, P[3])) / (2 * e);
    const steep = Math.hypot(dx, dy);
    if (steep < 1e-4) return;
    const nx = dx / steep, ny = dy / steep; // uphill, on the map
    const up = v[0] * nx + v[1] * ny; // how fast v goes that way
    const slope = Math.atan(steep);
    const keep = Math.cos(slope) * (up > 0 ? Math.max(0, 1 - (slope / MAX_CLIMB) ** 2) : 1);
    // "uphill" as it appears in the slice, along f and r
    const mf = nx * f[0] + ny * f[1], mr = nx * r[0] + ny * r[1], ml2 = mf * mf + mr * mr;
    if (ml2 < 1e-12) return;
    const k = (1 - keep) * up / ml2;
    for (let i = 0; i < 4; i++) v[i] -= k * (mf * f[i] + mr * r[i]);
  }

  // Free movement still respects the scene's floor and ceiling, if any.
  // Returns whether the player had to be moved.
  _bounds() {
    const P = this.P, z = P[2], vel = this.vel;
    if (this.ground) {
      const floor = this.ground(P[0], P[1], P[3]) + 0.6;
      if (P[2] < floor) {
        P[2] = floor;
        if (vel[2] < 0) vel[2] = 0;
      }
    }
    if (this.ceiling !== null && this.ceiling !== undefined) {
      const top = (typeof this.ceiling === 'function' ? this.ceiling(P[0], P[1], P[3]) : this.ceiling) - 0.4;
      if (P[2] > top) {
        P[2] = top;
        if (vel[2] > 0) vel[2] = 0;
      }
    }
    return Math.abs(P[2] - z) > 1e-6;
  }

  // Walk mode, off the ground: moves the feet up or down over the time h.
  // A jump rises until gravity or a ceiling stops it, and comes down on the
  // ground or on top of something solid.  There the player stands, and can
  // walk on: up or down a small step, and off the edge into a fall.  (Things
  // lower than the body's `lo` cannot be stood on: those are walked through.)
  _vertical(h, jump) {
    const P = this.P, body = BODY.walk;
    const g = this.ground ? this.ground(P[0], P[1], P[3]) : 0;
    const s = this.solids && this.solids.count ? this.solids : null;
    // the highest thing to stand on that is no higher than z
    const floor = (z) => {
      const f = s ? s.floorBelow(P[0], P[1], z) : -Infinity;
      return f >= g + body.lo ? f : g;
    };
    if (this.feet === null) this.feet = g;
    if (!this.air) {
      const f = floor(this.feet + 0.25);
      if (jump) {
        this.air = true;
        this.vz = JUMP;
      } else if (f >= this.feet - 0.3) {
        this.feet = f;
      } else {
        this.air = true; // walked off the edge
        this.vz = 0;
      }
    }
    if (this.air) {
      // (the average of the speed before and after: the same arc at any frame rate)
      const before = this.vz;
      this.vz = Math.max(-50, before - GRAVITY * h);
      let z = this.feet + (before + this.vz) / 2 * h;
      if (z > this.feet) {
        // the head: stop under anything solid
        if (s && !s.clearColumn(P[0], P[1], this.feet + body.hi, z + body.hi + 0.05)) {
          z = this.feet;
          this.vz = 0;
        }
      } else {
        const f = floor(this.feet + 0.02);
        if (z <= f) {
          z = f;
          this.vz = 0;
          this.air = false;
        }
      }
      this.feet = Math.max(z, g);
    }
    if (!this.air && this.feet <= g + 1e-6) this._setDown();
  }

  // Moves the player out of whatever solid surface they have run into, and
  // takes away the part of their motion that was going into it.
  _collide() {
    const P = this.P, body = BODY[this.mode];
    let hits;
    if (MODES[this.mode].ground) {
      const g = this.ground ? this.ground(P[0], P[1], P[3]) : 0;
      // Standing, on the ground or on top of something, the body starts `lo`
      // above the feet.  In the air it starts at the feet, so that the player
      // only gets over what the feet are above, but never lower than it
      // would for someone walking there.
      const feet = this.feet ?? g;
      const from = this.air ? Math.max(feet + 0.05, g + body.lo) : feet + body.lo;
      hits = this.solids.pushCylinder(P, body.r, from, Math.max(from + 0.1, feet + body.hi));
    } else {
      hits = this.solids.pushSphere(P, body.r);
    }
    for (const n of hits) this._blocked(n);
  }

  // A surface with unit normal n (in space) is in the way: the speed towards
  // it is lost and the rest is kept, so the player slides along it.
  _blocked(n) {
    const v = this.vel;
    const into = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    if (into >= -1e-9) return;
    if (MODES[this.mode].ground) {
      // On the ground the velocity lies in the slice along F and R, and what
      // is taken away should too: the surface's normal as it appears in the
      // slice.  (Taking away n itself would leave a walker who is pressed
      // against a wall in a tilted slice travelling on through time.)
      const f = this.col(F), r = this.col(R);
      const mf = n[0] * f[0] + n[1] * f[1] + n[2] * f[2], mr = n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
      const ml = Math.hypot(mf, mr);
      const k = into / (ml * ml);
      if (ml > 1e-6 && Math.abs(k) * ml <= 1.5 * Math.hypot(v[0], v[1], v[2], v[3])) {
        for (let i = 0; i < 4; i++) v[i] -= k * (mf * f[i] + mr * r[i]);
        if (this.mode === 'drive') {
          // A car is turned along the wall it scrapes, forwards or backwards:
          // all the way at speed, less and less the slower it is, so that one
          // wedged between two walls comes to a stop instead of twitching
          // from the one to the other.
          const a = f4.dot(v, f), b = f4.dot(v, r), l = Math.hypot(a, b);
          if (l < 1e-6) return this._halt();
          const dir = this.speed < 0 ? -1 : 1;
          f4.rotCols(this.M, F, R, Math.atan2(dir * b, dir * a) * clamp(l / (0.1 * this.C) - 0.2, 0, 1));
          const nf = this.col(F);
          this.speed = f4.dot(v, nf);
          for (let i = 0; i < 4; i++) v[i] = this.speed * nf[i];
        }
        return;
      }
    }
    // In free movement, and when the velocity has left the slice: the
    // surface stands still, so its normal in 4D is n with no time component.
    v[0] -= into * n[0]; v[1] -= into * n[1]; v[2] -= into * n[2];
    if (this.mode === 'drive') this.speed = f4.dot(v, this.col(F));
  }

  // Keeps the eye at a fixed height above the ground (or above the feet,
  // when those are off it).  A car leans with the ground: its U becomes the
  // ground normal, which keeps F and R (and so its motion) tangent to the
  // ground.  A walker stands upright whatever the slope: U stays +Z, so the
  // horizon stays level (what a slope does to their pace is in _climb).
  _stickToGround(blend, snap) {
    const g = this.ground, P = this.P;
    const z = g ? g(P[0], P[1], P[3]) : 0;
    P[2] = (this.feet ?? z) + this.eye;
    let n = Z_AXIS;
    if (g && this.align && this.mode === 'drive') {
      const e = 0.4;
      const dx = (g(P[0] + e, P[1], P[3]) - g(P[0] - e, P[1], P[3])) / (2 * e);
      const dy = (g(P[0], P[1] + e, P[3]) - g(P[0], P[1] - e, P[3])) / (2 * e);
      const l = Math.hypot(dx, dy, 1);
      n = [-dx / l, -dy / l, 1 / l, 0];
    }
    const u = this.col(U);
    const ang = Math.acos(clamp(f4.dot(u, n), -1, 1));
    if (ang > 1e-6) f4.rotTowards(this.M, u, n, snap ? ang : ang * blend);
  }

  // Camera axes for the renderer: the frame, looking up or down by
  // viewPitch in the ground modes.
  camera() {
    const cp = Math.cos(this.viewPitch), sp = Math.sin(this.viewPitch);
    const u = this.col(U), f = this.col(F);
    const mix = (b, c) => [0, 1, 2, 3].map((k) => b * u[k] + c * f[k]);
    return {
      R: this.col(R),
      U: mix(cp, -sp),
      F: mix(sp, cp),
      O: this.col(O),
      P: this.P.slice(),
      C: this.C,
    };
  }

  // Numbers for the HUD.
  status() {
    const v = this.vel, o = this.col(O), cam = this.camera(), C = this.C;
    const sight = Math.hypot(cam.F[0], cam.F[1], cam.F[2]);
    const speed = Math.hypot(v[0], v[1], v[2]);
    const timeRate = this.rate + v[3] / C;
    return {
      // What the controls have added (see the head of this file): how fast
      // that is, counting its part through time as length, and its two
      // parts.  On the ground it lies in the slice, and `slice` is the speed
      // at which the scenery passes in the view.  (In flight it lies there
      // too unless the view is tilted while coasting: the velocity stays as
      // it is then and the slice turns away from it.)
      slice: Math.hypot(v[0], v[1], v[2], v[3]), // m/s
      speed, // through space, m/s
      through: v[3] / C, // through time, seconds of scene time per second
      timeRate, // all of the time that passes: the resting rate and `through`
      // the line of sight and the player's motion through spacetime (in units
      // of C), as (space, time) pairs in the plane that contains the line of
      // sight and the time axis
      sight: [sight, cam.F[3]],
      travel: [sight > 1e-6 ? (v[0] * cam.F[0] + v[1] * cam.F[1] + v[2] * cam.F[2]) / sight / C : 0, timeRate],
      tilt: Math.acos(clamp(o[3], -1, 1)), // of the slice against a level one, 0..pi
      // seconds of scene time per metre along the line of sight (negative = past)
      lookGradient: cam.F[3] / C,
      t: this.P[3],
    };
  }
}
