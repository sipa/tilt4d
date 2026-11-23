// Ready-made environment shader hooks (sun, sky, ambient light, fog).
// A scene can use these as is, or write its own versions of the hooks.

import { parseColor } from './geom.js';

const f = (v) => {
  const s = Number(v).toString();
  return /[.e]/.test(s) ? s : s + '.0';
};
const lin = (c) => parseColor(c).map((v) => Math.pow(v, 2.2));
const vec = (c) => `vec3f(${c.map(f).join(', ')})`;

// An outdoor day/night cycle.
//   dayLength    seconds of scene time per full day
//   startHour    time of day at t = 0 (0..24)
//   sunTilt      how far the sun's arc leans away from the zenith, radians
//   fog          fog density per metre
//   clouds       cloud cover 0..1 (0 disables the cloud layer)
//   zenith, horizon   daytime sky colours (sRGB)
//   own          names of functions the scene defines itself in place of the
//                ones here: 'envDayPhase' and/or 'envSunVec' (see below)
// Besides the hooks this defines envSunVec(t) (the sun's direction, which
// keeps going below the horizon), envDayPhase(t) (0 = midnight, 0.5 = noon)
// and envDaylight(t) (0 at night .. 1 in full day) for use in `surface`.
// Everything else here goes by those two, so a scene can bend the day by
// writing its own: with own: ['envDayPhase'], say, the scene's WGSL defines
// fn envDayPhase(t: f32) -> f32 (hours that run unevenly, a day that stands
// still), and with 'envSunVec' the sun's path.  The ones made here are there
// under the names envDayPhase0 and envSunVec0 to build on.
// It also defines the optional hook envReflect: glossy surfaces mirror the sky
// without its stars, and with the sun or moon only where that shines on them.
export function dayNightEnv(o = {}) {
  const dayLength = o.dayLength ?? 600, startHour = o.startHour ?? 9, sunTilt = o.sunTilt ?? 0.6;
  const fog = o.fog ?? 0.0015, clouds = o.clouds ?? 0.45;
  const zenith = lin(o.zenith ?? '#3d7fd6'), horizon = lin(o.horizon ?? '#b9d7ee');
  const own = o.own || [];
  // (the plain ones, unless the scene brings its own)
  const plain = (own.includes('envDayPhase') ? '' : 'fn envDayPhase(t: f32) -> f32 { return envDayPhase0(t); }\n')
    + (own.includes('envSunVec') ? '' : 'fn envSunVec(t: f32) -> vec3f { return envSunVec0(t); }\n');
  return plain + /* wgsl */ `
const ENV_DAY = ${f(dayLength)};
const ENV_T0 = ${f(startHour / 24)};
const ENV_TILT = ${f(sunTilt)};
const ENV_FOG = ${f(fog)};
const ENV_CLOUDS = ${f(clouds)};
const ENV_ZENITH = ${vec(zenith)};
const ENV_HORIZON = ${vec(horizon)};

fn envDayPhase0(t: f32) -> f32 { return fract(t / ENV_DAY + ENV_T0); }
fn envSunVec0(t: f32) -> vec3f {
  let a = (envDayPhase(t) - 0.25) * TAU;
  return normalize(vec3f(cos(a), -sin(a) * sin(ENV_TILT), sin(a) * cos(ENV_TILT)));
}
fn envDaylight(t: f32) -> f32 { return smoothstep(-0.12, 0.25, envSunVec(t).z); }

fn envSun(t: f32) -> Light {
  let s = envSunVec(t);
  if (s.z > -0.06) {
    let warm = mix(vec3f(1.0, 0.40, 0.14), vec3f(1.0, 0.95, 0.88), smoothstep(0.0, 0.45, s.z));
    return Light(s, warm * (1.35 * smoothstep(-0.06, 0.10, s.z)));
  }
  // moonlight, from the other side of the sky
  let m = normalize(vec3f(-s.x, -s.y, max(-s.z, 0.25)));
  return Light(m, vec3f(0.045, 0.065, 0.11) * smoothstep(-0.06, -0.22, s.z));
}

fn envSkyBase(dir: vec3f, t: f32) -> vec3f {
  let s = envSunVec(t);
  let day = smoothstep(-0.12, 0.25, s.z);
  let dusk = smoothstep(-0.28, 0.0, s.z) * (1.0 - smoothstep(0.0, 0.42, s.z));
  let up = max(dir.z, 0.0);
  let zen = mix(vec3f(0.0025, 0.004, 0.011), ENV_ZENITH, day);
  let hor = mix(vec3f(0.008, 0.011, 0.024), ENV_HORIZON, day);
  var c = mix(hor, zen, pow(up, 0.42));
  let toSun = max(dot(dir, s), 0.0);
  c += vec3f(1.0, 0.36, 0.09) * (dusk * pow(1.0 - up, 5.0) * (0.25 + 0.75 * pow(toSun, 4.0)));
  if (dir.z < 0.0) { c = mix(c, hor * 0.55, smoothstep(0.0, -0.3, dir.z)); }
  return c;
}

// The sky, with the sun and moon scaled by \`discs\` and the stars by \`stars\`.
fn envSkyWith(dir: vec3f, t: f32, discs: f32, stars: f32) -> vec3f {
  var c = envSkyBase(dir, t);
  let s = envSunVec(t);
  let above = smoothstep(-0.02, 0.03, dir.z);
  let sd = dot(dir, s);
  // sun disc and glare
  c += (vec3f(1.0, 0.85, 0.6) * 60.0 * smoothstep(0.99962, 0.99985, sd)
      + vec3f(1.0, 0.65, 0.35) * 0.5 * pow(max(sd, 0.0), 90.0)) * (discs * above * smoothstep(-0.07, 0.04, s.z));
  let night = 1.0 - smoothstep(-0.2, 0.05, s.z);
  if (night > 0.0 && dir.z > 0.0) {
    // moon
    let m = normalize(vec3f(-s.x, -s.y, max(-s.z, 0.25)));
    c += vec3f(0.8, 0.85, 1.0) * (3.0 * smoothstep(0.9993, 0.9996, dot(dir, m)) * night * discs);
    if (stars > 0.0) {
      let g = dir * 110.0;
      let cell = floor(g);
      let h = hash33(cell);
      let star = step(0.965, h.x) * smoothstep(0.28, 0.0, length(fract(g) - 0.5 - (h.yzx - 0.5) * 0.4));
      c += vec3f(0.9, 0.95, 1.0) * (star * (0.5 + 3.0 * h.y) * night * stars * smoothstep(0.0, 0.2, dir.z));
    }
  }
  if (ENV_CLOUDS > 0.0 && dir.z > 0.015) {
    let p = dir.xy / (dir.z + 0.12) * 1.4 + vec2f(t * 0.006, t * 0.0022);
    let d = fbm2(p) * 0.7 + fbm2(p * 3.1 + 4.0) * 0.3;
    let cov = smoothstep(1.0 - ENV_CLOUDS * 0.9, 1.08 - ENV_CLOUDS * 0.6, d) * smoothstep(0.015, 0.16, dir.z);
    let day = smoothstep(-0.12, 0.25, s.z);
    let lit = mix(vec3f(0.012, 0.016, 0.03), vec3f(1.0, 0.98, 0.95), day)
            + vec3f(1.0, 0.4, 0.12) * (1.0 - day) * smoothstep(-0.25, 0.0, s.z) * 0.6;
    c = mix(c, lit * (0.75 + 0.25 * d), cov * 0.85);
  }
  return c;
}

fn envSky(dir: vec3f, t: f32) -> vec3f { return envSkyWith(dir, t, 1.0, 1.0); }

// What a glossy surface mirrors.  Nothing tells a surface which buildings
// stand between it and the sky, so the mirrored sky leaves out what would give
// that away: the stars (points of light in a dark wall, which also sparkle as
// the view moves), and the sun or moon wherever the surface lies in shadow.
fn envReflect(dir: vec3f, t: f32, lit: f32) -> vec3f { return envSkyWith(dir, t, lit, 0.0); }

fn envAmbient(n: vec3f, t: f32) -> vec3f {
  let day = envDaylight(t);
  let sky = mix(vec3f(0.010, 0.014, 0.030), ENV_ZENITH * 0.45 + ENV_HORIZON * 0.22, day);
  let gnd = mix(vec3f(0.005, 0.006, 0.009), vec3f(0.13, 0.115, 0.095), day);
  return mix(gnd, sky, n.z * 0.5 + 0.5);
}

fn envFog(dir: vec3f, t: f32, dist: f32) -> vec4f {
  let flat_ = normalize(vec3f(dir.xy, max(dir.z, 0.0) * 0.35 + 0.03));
  return vec4f(envSkyBase(flat_, t), 1.0 - exp(-dist * ENV_FOG));
}
`;
}
