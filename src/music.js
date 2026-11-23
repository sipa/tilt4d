// Background music.  A scene can have a piece of its own, the `music` of its
// definition, and nothing is downloaded: the piece is synthesised when the
// scene is loaded, as a loop of half a minute to a minute, and kept as
// samples.
//
// The music belongs to the scene's time, not to the clock on the wall.  The
// moment of the piece that sounds is the moment of scene time the player is
// at, so it plays at the pace at which time passes for them: slower and lower
// in a tilted view, not at all at 90 degrees, backwards beyond, and back at
// the same bar whenever they come back to the same moment.
//
// Two parts follow: making a piece (a small synthesiser on an
// OfflineAudioContext, which the scenes' scores are written against), and
// playing one (the Music class).
//
// A score, as a scene gives it:
//   seconds   the length of the loop
//   bpm       beats a minute, which sets m.beat (optional)
//   reverb    how long the hall rings, seconds
//   tail      how long after the loop's end sounds may ring on (they are
//             carried over to its start); 4 unless given
//   echo      [seconds between repeats, how much of each comes back]
//   lowpass   a filter over the whole piece, Hz (optional)
//   seed      for m.rand(), which is the same every time
//   build(m)  puts the notes down, with the calls of the Score class below
// Second 0 of the loop sounds at scene time 0.  So a loop whose length
// divides one of the scene's own cycles stays in step with it, and a beat
// that falls on whole seconds stays in step with clocks.

const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
const RATE = 32000; // samples a second of a piece as it is kept
const MAX_RATE = 4; // the fastest a piece is played, either way
const LOUD = 0.1; // what every piece is brought to (root mean square), so that they are equally loud
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const mod = (a, n) => ((a % n) + n) % n;

// Notes by name, for the scores (they are handed them as m.n, m.notes and
// m.tune).  "F#4" -> 66, the MIDI number; C4 is middle C.
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const n = (name) => {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  return STEP[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (Number(m[3]) + 1);
};
// "C3 E3 G3" -> [48, 52, 55]
const notes = (text) => text.trim().split(/\s+/).map(n);
// A line of notes: "E5 G5:2 -:.5" is E5 for one `unit` (seconds), G5 for two,
// a rest of half a unit, from `start` on.  play(time, seconds, pitch) is
// called for each note.
function tune(start, unit, text, play) {
  let t = start;
  for (const word of text.trim().split(/\s+/)) {
    const [name, len = '1'] = word.split(':'), d = Number(len) * unit;
    if (name !== '-') play(t, d, n(name));
    t += d;
  }
}

// (mulberry32: the same piece every time)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- making a piece ----------------------------------------------------------

// How a struck bar, a music box and a glass sound: [multiple of the pitch,
// loudness, share of the decay time] for each partial.
const PARTIALS = {
  bars: [[1, 1, 1], [4, 0.25, 0.3], [9.2, 0.08, 0.12]],
  box: [[1, 1, 1], [2, 0.3, 0.6], [3.01, 0.16, 0.4], [5.03, 0.07, 0.2]],
  glass: [[1, 1, 1], [2.76, 0.28, 0.55], [5.4, 0.12, 0.3]],
};

// What a score's build(m) is given.  Times are seconds from the start of the
// loop (m.beat is the length of a beat), pitches are MIDI note numbers (60 is
// middle C; fractions are allowed).  A sound goes to a track, which places it
// (left or right, how much of the hall and of the echo it gets).  Whatever
// still sounds when the loop ends is carried over to its start.
class Score {
  constructor(c, def) {
    this.c = c;
    this.seconds = def.seconds;
    this.beat = def.bpm ? 60 / def.bpm : 1;
    this.rand = rng(def.seed || 1);
    Object.assign(this, { n, notes, tune }); // (notes by name: see above)
    // everything -> (a lowpass over the whole piece) -> a gentle compressor -> out
    const out = c.createDynamicsCompressor();
    out.threshold.value = -18; out.knee.value = 12; out.ratio.value = 3; out.attack.value = 0.01; out.release.value = 0.25;
    out.connect(c.destination);
    this.master = out;
    if (def.lowpass) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = def.lowpass; f.Q.value = 0.5;
      f.connect(out);
      this.master = f;
    }
    // the hall: noise that dies away and darkens, as an impulse response
    const len = Math.round((def.reverb ?? 2) * c.sampleRate), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const x = (this.rand() * 2 - 1) * Math.exp(-6.9 * i / len) * Math.min(1, i / (0.004 * c.sampleRate));
        y += (0.2 + 0.75 * Math.exp(-3 * i / len)) * (x - y);
        d[i] = y;
      }
    }
    this.hall = c.createConvolver();
    this.hall.buffer = ir;
    this.hall.connect(this.master);
    // the echo: [seconds between repeats, how much of each comes back]
    const [time, back] = def.echo || [0.375, 0.3];
    this.echo = c.createDelay(2);
    this.echo.delayTime.value = time;
    const dull = c.createBiquadFilter(), again = c.createGain();
    dull.type = 'lowpass'; dull.frequency.value = 3200;
    again.gain.value = back;
    this.echo.connect(dull); dull.connect(again); again.connect(this.echo);
    dull.connect(this.master);
    // two seconds of hiss for everything that is made of noise
    this.hiss = c.createBuffer(1, 2 * c.sampleRate, c.sampleRate);
    const h = this.hiss.getChannelData(0);
    for (let i = 0; i < h.length; i++) h[i] = this.rand() * 2 - 1;
  }

  // A place in the mix.  pan: -1 left .. 1 right; hall, echo: how much of
  // each; lowpass, highpass: a filter over the whole track, in Hz; vib:
  // [times a second, cents] of vibrato for every tone on it.
  track({ gain = 1, pan = 0, hall = 0, echo = 0, lowpass = 0, highpass = 0, vib = null } = {}) {
    const c = this.c, input = c.createGain();
    input.gain.value = gain;
    let node = input;
    for (const [type, f] of [['lowpass', lowpass], ['highpass', highpass]]) {
      if (!f) continue;
      const b = c.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = 0.5;
      node.connect(b); node = b;
    }
    if (pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      node.connect(p); node = p;
    }
    node.connect(this.master);
    for (const [amount, to] of [[hall, this.hall], [echo, this.echo]]) {
      if (!amount) continue;
      const s = c.createGain();
      s.gain.value = amount;
      node.connect(s); s.connect(to);
    }
    if (vib) {
      const l = c.createOscillator(), g = c.createGain();
      l.frequency.value = vib[0]; g.gain.value = vib[1];
      l.connect(g); l.start(0);
      input.vib = g;
    }
    return input;
  }

  // A sustained tone: an oscillator (two, a little apart, with `detune` in
  // cents) through an envelope: attack a, decay d to the share s, release r
  // after dur.  cutoff: a lowpass, which can sweep to cutTo within cutTime.
  // from: the pitch it slides in from, within `glide` seconds.
  tone(tr, t, dur, midi, o = {}) {
    const { type = 'sine', gain = 0.2, a = 0.01, d = 0.2, s = 0.7, r = 0.2, detune = 0, cutoff = 0, cutTo = 0, cutTime = 0.2, q = 0.7, from = null, glide = 0.1 } = o;
    const c = this.c, env = c.createGain(), held = Math.max(dur, a), end = t + held + r * 3, peak = gain * (detune ? 0.7 : 1);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + a);
    env.gain.setTargetAtTime(peak * s, t + a, d / 3);
    env.gain.setTargetAtTime(0, t + held, r / 3);
    let into = env;
    if (cutoff) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = q;
      f.frequency.setValueAtTime(cutoff, t);
      if (cutTo) f.frequency.exponentialRampToValueAtTime(cutTo, t + cutTime);
      f.connect(env);
      into = f;
    }
    for (const cents of detune ? [-detune, detune] : [0]) {
      const osc = c.createOscillator();
      osc.type = type;
      if (from !== null) {
        osc.frequency.setValueAtTime(hz(from), t);
        osc.frequency.exponentialRampToValueAtTime(hz(midi), t + glide);
      } else {
        osc.frequency.value = hz(midi);
      }
      osc.detune.value = cents;
      if (tr.vib) tr.vib.connect(osc.detune);
      osc.connect(into);
      osc.start(t); osc.stop(end);
    }
    env.connect(tr);
  }

  // Something struck that rings, dying away within about `decay` seconds:
  // partials 'bars' (a marimba, a glockenspiel), 'box' (a music box) or
  // 'glass'.
  bell(tr, t, midi, { gain = 0.2, decay = 1.6, partials = 'box' } = {}) {
    const c = this.c, f = hz(midi);
    for (const [ratio, amp, share] of PARTIALS[partials]) {
      if (f * ratio > 0.45 * c.sampleRate) continue;
      const osc = c.createOscillator(), g = c.createGain(), time = decay * share;
      osc.frequency.value = f * ratio;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain * amp, t + 0.003);
      g.gain.setTargetAtTime(0, t + 0.003, time / 4.5);
      osc.connect(g); g.connect(tr);
      osc.start(t); osc.stop(t + time * 1.5 + 0.05);
    }
  }

  // A plucked string: bright at first, dull as it dies away.
  pluck(tr, t, midi, { gain = 0.25, decay = 0.35, type = 'triangle', bright = 3500, dark = 500 } = {}) {
    const c = this.c, osc = c.createOscillator(), f = c.createBiquadFilter(), env = c.createGain();
    osc.type = type; osc.frequency.value = hz(midi);
    f.type = 'lowpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(bright, t);
    f.frequency.exponentialRampToValueAtTime(dark, t + decay);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.002);
    env.gain.setTargetAtTime(0, t + 0.002, decay / 3.5);
    osc.connect(f); f.connect(env); env.connect(tr);
    osc.start(t); osc.stop(t + decay * 2);
  }

  // A soft chord that swells and fades: every note two oscillators a little
  // apart, all through one lowpass.  The fades are straight lines, so that a
  // chord fading out over the next one fading in keeps the level.
  pad(tr, t, dur, midis, { gain = 0.06, type = 'sawtooth', cutoff = 800, a = 1.2, r = 1.5, detune = 7, q = 0.5 } = {}) {
    const c = this.c, env = c.createGain(), f = c.createBiquadFilter(), held = Math.max(dur, a);
    f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = q;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + a);
    env.gain.setValueAtTime(gain, t + held);
    env.gain.linearRampToValueAtTime(0, t + held + r);
    f.connect(env); env.connect(tr);
    for (const m of midis) {
      for (const cents of [-detune, detune]) {
        const osc = c.createOscillator();
        osc.type = type; osc.frequency.value = hz(m); osc.detune.value = cents;
        osc.connect(f);
        osc.start(t); osc.stop(t + held + r + 0.05);
      }
    }
  }

  // A note held through the whole loop without a seam: its pitch is nudged
  // to a whole number of cycles per loop, and it is faded over itself where
  // the loop closes.  swell: [times per loop, depth 0..1] of a slow rise and
  // fall of its loudness.
  drone(tr, midi, { gain = 0.1, type = 'sine', fade = 3, swell = null, cutoff = 0 } = {}) {
    const c = this.c, L = this.seconds, osc = c.createOscillator(), env = c.createGain();
    osc.type = type;
    osc.frequency.value = Math.round(hz(midi) * L) / L;
    env.gain.setValueAtTime(0, 0);
    env.gain.linearRampToValueAtTime(gain, fade);
    env.gain.setValueAtTime(gain, L);
    env.gain.linearRampToValueAtTime(0, L + fade);
    let node = osc;
    if (cutoff) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = cutoff;
      node.connect(f); node = f;
    }
    node.connect(env);
    let last = env;
    if (swell) {
      const lfo = c.createOscillator(), depth = c.createGain(), g = c.createGain();
      lfo.frequency.value = swell[0] / L;
      depth.gain.value = swell[1] / 2;
      g.gain.value = 1 - swell[1] / 2;
      lfo.connect(depth); depth.connect(g.gain);
      env.connect(g); last = g;
      lfo.start(0);
    }
    last.connect(tr);
    osc.start(0); osc.stop(L + fade);
  }

  // A burst of filtered hiss: type and freq (and q) of the filter, dying
  // away within about dur.
  noise(tr, t, { dur = 0.05, gain = 0.2, type = 'highpass', freq = 7000, q = 0.8, a = 0.001 } = {}) {
    const c = this.c, src = c.createBufferSource(), f = c.createBiquadFilter(), env = c.createGain();
    src.buffer = this.hiss;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + a);
    env.gain.setTargetAtTime(0, t + a, dur / 3);
    src.connect(f); f.connect(env); env.connect(tr);
    src.start(t, this.rand() * 1.4); src.stop(t + a + dur * 3);
  }

  // Drums and the like.  v: how hard, 0..1.
  kick(tr, t, v = 1, { from = 140, to = 46, dur = 0.22 } = {}) {
    const c = this.c, osc = c.createOscillator(), env = c.createGain();
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.55);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.9 * v, t + 0.003);
    env.gain.setTargetAtTime(0, t + 0.012, dur / 3);
    osc.connect(env); env.connect(tr);
    osc.start(t); osc.stop(t + dur * 2);
  }

  snare(tr, t, v = 1) {
    this.noise(tr, t, { dur: 0.11, gain: 0.45 * v, type: 'bandpass', freq: 2100, q: 0.7 });
    this.tone(tr, t, 0.03, 54, { type: 'triangle', gain: 0.25 * v, a: 0.002, d: 0.05, s: 0, r: 0.04 });
  }

  hat(tr, t, v = 1, open = false) {
    this.noise(tr, t, { dur: open ? 0.2 : 0.03, gain: 0.22 * v, type: 'highpass', freq: 8500 });
  }

  // the tick of a clock: `pitch` in Hz
  tick(tr, t, v = 1, pitch = 2400) {
    const c = this.c, osc = c.createOscillator(), env = c.createGain();
    osc.frequency.value = pitch;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.28 * v, t + 0.001);
    env.gain.setTargetAtTime(0, t + 0.001, 0.006);
    osc.connect(env); env.connect(tr);
    osc.start(t); osc.stop(t + 0.06);
    this.noise(tr, t, { dur: 0.008, gain: 0.2 * v, type: 'bandpass', freq: pitch * 1.5, q: 2 });
  }

  // a hand drum
  thud(tr, t, v = 1) {
    this.kick(tr, t, v * 0.8, { from: 115, to: 62, dur: 0.16 });
    this.noise(tr, t, { dur: 0.04, gain: 0.25 * v, type: 'lowpass', freq: 700 });
  }

  // little bells shaken: a tambourine, a sleigh
  jingle(tr, t, v = 1) {
    this.noise(tr, t, { dur: 0.06, gain: 0.2 * v, type: 'bandpass', freq: 7600, q: 2 });
    this.noise(tr, t + 0.012, { dur: 0.035, gain: 0.14 * v, type: 'highpass', freq: 10500 });
  }

  // a bubble: a short tone that slides up from `pitch` Hz
  bubble(tr, t, pitch, v = 1) {
    const c = this.c, osc = c.createOscillator(), env = c.createGain();
    osc.frequency.setValueAtTime(pitch, t);
    osc.frequency.exponentialRampToValueAtTime(pitch * 1.75, t + 0.09);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.2 * v, t + 0.008);
    env.gain.linearRampToValueAtTime(0, t + 0.1);
    osc.connect(env); env.connect(tr);
    osc.start(t); osc.stop(t + 0.11);
  }
}

// Synthesises the piece of a score: two buffers, the loop and the loop
// backwards.
export async function renderPiece(def) {
  const tail = def.tail ?? 4;
  let c;
  try { c = new OAC(2, Math.round((def.seconds + tail) * RATE), RATE); } catch { c = new OAC(2, Math.round((def.seconds + tail) * 44100), 44100); }
  const rate = c.sampleRate, n = Math.round(def.seconds * rate);
  def.build(new Score(c, def));
  const got = await new Promise((resolve, reject) => {
    c.oncomplete = (e) => resolve(e.renderedBuffer);
    const p = c.startRendering();
    if (p && p.then) p.then(resolve, reject);
  });
  // what rings on after the end of the loop belongs at its start
  const chans = [];
  let peak = 0, sum = 0;
  for (let ch = 0; ch < 2; ch++) {
    const x = got.getChannelData(ch), y = new Float32Array(n);
    y.set(x.subarray(0, n));
    for (let i = n; i < x.length; i++) y[(i - n) % n] += x[i];
    for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(y[i])); sum += y[i] * y[i]; }
    chans.push(y);
  }
  const k = Math.min(0.9 / (peak || 1), LOUD / (Math.sqrt(sum / (2 * n)) || 1));
  const forward = c.createBuffer(2, n, rate), backward = c.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const y = chans[ch], f = forward.getChannelData(ch), b = backward.getChannelData(ch);
    for (let i = 0; i < n; i++) { f[i] = y[i] * k; b[n - 1 - i] = f[i]; }
  }
  return { seconds: n / rate, forward, backward };
}

// ---- playing one --------------------------------------------------------------

// How loud the music is at a pace of time `r`: it fades away as time comes to
// a standstill, where it would be a rumble and then nothing.
const fade = (r) => { const x = Math.min(1, Math.max(0, (Math.abs(r) - 0.03) / 0.17)); return x * x * (3 - 2 * x); };

export class Music {
  constructor() {
    this._level = 1;
    this.score = null; // the score whose piece is wanted
    this.ctx = null;
    this.piece = null;
    this.src = null; // the buffer that is playing: the loop, or the loop backwards
    this.dir = 1; // which of the two
    this.pos = 0; // where in the loop the playing has got to, seconds
    this.speed = 0; // how fast it is being played
    this.then = 0;
    this.loads = 0;
  }

  // How loud: 0 (off) to 1.  While it is off no piece is made at all; one is
  // when it is turned on.
  get level() { return this._level; }
  set level(v) {
    this._level = v;
    if (v > 0 && !this.piece && this.score) this.load(this.score);
  }

  // Browsers only let a page make a sound once the user has done something
  // on it: call this from a click or a key press.
  unlock() {
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      this.out = this.ctx.createGain();
      this.out.gain.value = 0;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume?.()?.catch?.(() => {});
  }

  // Makes the piece of `score` (a scene's `music`, or nothing for a scene
  // without) the one to play, once it has been synthesised: which takes a
  // second or so, off the page's own thread.
  async load(score) {
    const mine = ++this.loads;
    this._stop();
    this.piece = null;
    this.score = score || null;
    if (!score || !OAC || !this._level) return;
    try {
      const piece = await renderPiece(score);
      if (mine === this.loads) this.piece = piece;
    } catch (e) {
      console.warn(`no music: ${e.message}`);
    }
  }

  _stop() {
    if (!this.src) return;
    const now = this.ctx.currentTime;
    this.srcGain.gain.setTargetAtTime(0, now, 0.01);
    this.src.stop(now + 0.08);
    this.src = null;
  }

  // Starts the loop (dir 1) or the loop backwards (dir -1) at `pos`.
  _start(pos, dir, now) {
    this._stop();
    const ctx = this.ctx, p = this.piece, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = dir > 0 ? p.forward : p.backward;
    src.loop = true;
    src.playbackRate.value = 0;
    g.gain.setValueAtTime(0, now);
    g.gain.setTargetAtTime(1, now, 0.01);
    src.connect(g); g.connect(this.out);
    src.start(now, mod(dir > 0 ? pos : p.seconds - pos, p.seconds));
    Object.assign(this, { src, srcGain: g, pos, dir, speed: 0, then: now });
  }

  // Once a frame while the scene is being played: t is the scene time the
  // player is at, rate how fast that is passing for them (seconds of it per
  // second; negative when it runs backwards).
  update(t, rate) {
    const ctx = this.ctx, p = this.piece;
    if (!ctx || !p || ctx.state !== 'running') return;
    const now = ctx.currentTime, L = p.seconds;
    if (this.src) this.pos = mod(this.pos + this.dir * this.speed * (now - this.then), L);
    this.then = now;
    const want = mod(t, L);
    const within = Math.abs(rate) <= MAX_RATE; // (beyond that the piece cannot keep up with the scene, and is let go)
    // which way to play: the way time runs, but left as it is while time all but stands still
    const dir = rate > 0.02 ? 1 : rate < -0.02 ? -1 : this.dir;
    // how far the playing is from the scene's time, the short way round the loop
    let off = mod(want - this.pos + L / 2, L) - L / 2;
    if (!this.src || dir !== this.dir || (within && Math.abs(off) > 0.3)) {
      this._start(within || !this.src ? want : this.pos, dir, now);
      off = 0;
    }
    // at the pace of time, and a little faster or slower to close what gap
    // there is: by no more than three tenths of the pace, so that a frame
    // that took long (the piece runs on by itself meanwhile) is made up for
    // over a second or so and not by stopping dead
    const along = rate * this.dir; // (negative only while time creeps the other way: then the playing waits)
    const most = 0.3 * Math.abs(along) + 0.02;
    const pull = within ? Math.max(-most, Math.min(most, this.dir * off * 2)) : 0;
    this.speed = Math.min(MAX_RATE * 1.25, Math.max(0, along + pull));
    this.src.playbackRate.value = this.speed;
    const loud = 0.6 * this.level * fade(rate);
    if (loud !== this.loud) this.out.gain.setTargetAtTime(this.loud = loud, now, 0.06);
  }

  // No sound for now (the menu is up, the page is hidden): the piece stays
  // where it is.
  hush() {
    if (!this.ctx || !this.out) return;
    this.out.gain.setTargetAtTime(this.loud = 0, this.ctx.currentTime, 0.04);
    if (this.src) this.src.playbackRate.value = 0;
    this.speed = 0;
  }
}
