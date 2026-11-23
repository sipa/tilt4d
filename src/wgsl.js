// WGSL sources.  The scene shader is assembled as
//   COMMON  +  the scene's textures  +  scene hooks (or defaults)  +  SCENE_PIPELINES

// For every sign pattern of a tetrahedron's four corners relative to the
// slicing hyperplane: the (up to four) edges that are cut, in triangle-strip
// order, packed as 4 bits per strip vertex (edge from corner i to corner j is
// i | j << 2).
function tetTable() {
  const codes = [];
  for (let mask = 0; mask < 16; mask++) {
    const pos = [], neg = [];
    for (let k = 0; k < 4; k++) ((mask >> k) & 1 ? pos : neg).push(k);
    let edges;
    if (pos.length === 0 || pos.length === 4) { codes.push('0xffffffffu'); continue; }
    if (pos.length === 1) edges = [[pos[0], neg[0]], [pos[0], neg[1]], [pos[0], neg[2]], [pos[0], neg[2]]];
    else if (pos.length === 3) edges = [[neg[0], pos[0]], [neg[0], pos[1]], [neg[0], pos[2]], [neg[0], pos[2]]];
    else edges = [[pos[0], neg[0]], [pos[0], neg[1]], [pos[1], neg[0]], [pos[1], neg[1]]];
    let code = 0;
    edges.forEach(([i, j], v) => { code |= (i | (j << 2)) << (v * 4); });
    codes.push(`0x${code.toString(16)}u`);
  }
  return `const TET_TABLE = array<u32, 16>(${codes.join(', ')});`;
}

export const COMMON = /* wgsl */ `
struct Globals {
  camR: vec4f,      // camera right / up / forward as 4D unit vectors (x, y, z, C*t)
  camU: vec4f,
  camF: vec4f,
  O: vec4f,         // the fourth axis of the player's frame: the normal of the visible slice
  P: vec4f,         // the player's position (x, y, z, t)
  proj: vec4f,      // fx, fy, near, C
  misc: vec4f,      // 1 / O.w (clamped), mirror sign, sky distance, exposure
  shadow: vec4f,    // enabled, cascade 0 radius, cascade 1 radius, depth half-range
  viewport: vec4f,  // width, height, 1 / width, 1 / height
  timeInfo: vec4f,  // wall-clock seconds, scene period, shadow map size, colouring by time (see timeTint)
  shadow2: vec4f,   // cascade 2 radius, number of cascades, -, -
  probe: vec4f,     // 1 if glossy surfaces mirror the scene around the player, 1 while that picture itself is drawn, -, -
  probeX: vec4f,    // the axes of that picture: 4D unit vectors inside the slice
  probeY: vec4f,
  probeZ: vec4f,
};
@group(0) @binding(0) var<uniform> G: Globals;

struct Light {
  dir: vec3f,       // unit vector towards the light
  color: vec3f,
};

struct Surface {
  pos: vec3f,       // world position, metres
  t: f32,           // world time, seconds
  n: vec3f,         // unit world normal
  uv: vec2f,
  view: vec3f,      // unit direction in space from the eye towards the surface
  dist: f32,        // distance along the line of sight
  color: vec3f,     // albedo (linear)
  emissive: f32,    // self-illumination, as a multiple of the albedo
  gloss: f32,       // 0 matte .. 1 mirror
  light: vec3f,     // extra incoming light to add (local lamps and such)
  sun: f32,         // multiplier on direct sunlight (1 = unchanged)
  ambient: f32,     // multiplier on ambient light (1 = unchanged)
  mat: u32,         // material id given to the geometry
  alpha: f32,       // opacity of see-through (blended) geometry: 0 clear .. 1 solid
  aux: f32,         // the geometry's spare value, -1..1, interpolated across the triangle
  tag: u32,         // the geometry's spare whole number, 0..255
  inst: vec4f,      // for instanced geometry: rgb the copy's tint (already applied to color), w its own number
};

const PI = 3.14159265;
const TAU = 6.2831853;

// (interpolated colours can come out a hair below zero, and pow of a negative is undefined)
fn srgbToLinear(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }
fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

// --- hashes and noise (all return 0..1) ---
fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031); x *= x + 33.33; x *= x + x; return fract(x);
}
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z);
}
fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn hash31(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z);
}
fn hash33(p: vec3f) -> vec3f {
  var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
fn noise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn noise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3f(1.0, 0.0, 0.0)), u.x),
        mix(hash31(i + vec3f(0.0, 1.0, 0.0)), hash31(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash31(i + vec3f(0.0, 0.0, 1.0)), hash31(i + vec3f(1.0, 0.0, 1.0)), u.x),
        mix(hash31(i + vec3f(0.0, 1.0, 1.0)), hash31(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
fn fbm2(p: vec2f) -> f32 {
  var a = 0.5; var s = 0.0; var q = p;
  for (var i = 0; i < 4; i++) { s += a * noise2(q); q = q * 2.03 + vec2f(17.3, 9.1); a *= 0.5; }
  return s / 0.9375;
}
fn fbm3(p: vec3f) -> f32 {
  var a = 0.5; var s = 0.0; var q = p;
  for (var i = 0; i < 4; i++) { s += a * noise3(q); q = q * 2.03 + vec3f(17.3, 9.1, 4.7); a *= 0.5; }
  return s / 0.9375;
}

// --- seven-segment displays (uv in 0..1, v up; return coverage 0..1) ---
fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a; let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
fn digit7(uv: vec2f, d: i32) -> f32 {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || d < 0 || d > 9) { return 0.0; }
  var masks = array<u32, 10>(0x3Fu, 0x06u, 0x5Bu, 0x4Fu, 0x66u, 0x6Du, 0x7Du, 0x07u, 0x7Fu, 0x6Fu);
  let m = masks[d];
  let xl = 0.25; let xr = 0.75; let yb = 0.12; let ym = 0.5; let yt = 0.88; let g = 0.05;
  var e = 1e9;
  if ((m & 1u) != 0u) { e = min(e, sdSegment(uv, vec2f(xl + g, yt), vec2f(xr - g, yt))); }
  if ((m & 2u) != 0u) { e = min(e, sdSegment(uv, vec2f(xr, yt - g), vec2f(xr, ym + g))); }
  if ((m & 4u) != 0u) { e = min(e, sdSegment(uv, vec2f(xr, ym - g), vec2f(xr, yb + g))); }
  if ((m & 8u) != 0u) { e = min(e, sdSegment(uv, vec2f(xl + g, yb), vec2f(xr - g, yb))); }
  if ((m & 16u) != 0u) { e = min(e, sdSegment(uv, vec2f(xl, ym - g), vec2f(xl, yb + g))); }
  if ((m & 32u) != 0u) { e = min(e, sdSegment(uv, vec2f(xl, yt - g), vec2f(xl, ym + g))); }
  if ((m & 64u) != 0u) { e = min(e, sdSegment(uv, vec2f(xl + g, ym), vec2f(xr - g, ym))); }
  return 1.0 - smoothstep(0.05, 0.075, e);
}
// A non-negative whole number, right-aligned in 'digits' cells across the unit square.
fn number7(uv: vec2f, value: f32, digits: i32) -> f32 {
  if (uv.x < 0.0 || uv.x >= 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
  let x = uv.x * f32(digits);
  let place = digits - 1 - i32(floor(x));
  let v = floor(max(value, 0.0) / pow(10.0, f32(place)) + 0.0001);
  if (v < 1.0 && place > 0) { return 0.0; }
  return digit7(vec2f(fract(x), uv.y), i32(v - 10.0 * floor(v / 10.0)));
}
// "MM:SS" for a time in seconds (wraps every hour), across the unit square.
fn clock7(uv: vec2f, seconds: f32) -> f32 {
  if (uv.x < 0.0 || uv.x >= 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
  // the small offset keeps a time that is a whole number of seconds, up to rounding, from showing the second before
  let s0 = seconds + 0.002;
  let s = s0 - floor(s0 / 3600.0) * 3600.0;
  let mins = i32(floor(s / 60.0)); let secs = i32(floor(s)) - mins * 60;
  let x = uv.x * 5.0; let cell = i32(floor(x)); let l = vec2f(fract(x), uv.y);
  if (cell == 0) { return digit7(l, mins / 10); }
  if (cell == 1) { return digit7(l, mins % 10); }
  if (cell == 2) {
    let d = min(distance(l, vec2f(0.5, 0.33)), distance(l, vec2f(0.5, 0.67)));
    return 1.0 - smoothstep(0.06, 0.085, d);
  }
  if (cell == 3) { return digit7(l, secs / 10); }
  return digit7(l, secs % 10);
}
`;

export const DEFAULT_SURFACE = /* wgsl */ `
fn surface(s: Surface) -> Surface { return s; }
`;

// For scenes without geometry that has holes.
export const DEFAULT_CUTOUT = /* wgsl */ `
fn cutout(s: Surface) -> f32 { return 1.0; }
`;

const num = (v) => {
  const s = Number(v).toString();
  return /[.e]/.test(s) ? s : s + '.0';
};

// Declarations for the scene's textures: each becomes a function of its
// name, uv -> vec4f.  A horizon map also gets <name>Sun (see
// SceneBuilder.horizon).  `textures` is what the builder collected.
export function textureDecls(textures) {
  return (textures || []).map((t, i) => {
    let code = `
@group(0) @binding(${6 + i}) var ${t.name}_tex: texture_2d<f32>;
@group(0) @binding(${10 + i}) var ${t.name}_smp: sampler;
fn ${t.name}(uv: vec2f) -> vec4f { return textureSampleLevel(${t.name}_tex, ${t.name}_smp, uv, 0.0); }
`;
    const h = t.horizon;
    if (h) {
      code += `
// 0 where the land hides a light in the direction l from a point at p, 1
// where it does not.  \`above\` is how high p is over the land, in metres.
fn ${t.name}SunAt(p: vec3f, l: vec3f, above: f32) -> f32 {
  let hl = length(l.xy);
  let q = (p.xy - vec2f(${num(h.x0)}, ${num(h.y0)})) / vec2f(${num(h.x1 - h.x0)}, ${num(h.y1 - h.y0)});
  if (l.z <= 0.0 || hl < 1e-5 || q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) { return 1.0; }
  // sixteen directions, four to a tile.  The tiles lie four to a row: two
  // with the angle of the horizon, then two with the distance of what makes it.
  let e = vec2f(${num(0.5 / h.nx)}, ${num(0.5 / h.ny)});
  let uv = clamp(q, e, vec2f(1.0) - e) * vec2f(0.25, 0.5);
  let az = fract(atan2(l.y, l.x) / TAU + 1.0) * 16.0;
  let i0 = u32(az) % 16u; let i1 = (i0 + 1u) % 16u;
  let o0 = vec2f(f32((i0 >> 2u) & 1u) * 0.25, f32(i0 >> 3u) * 0.5);
  let o1 = vec2f(f32((i1 >> 2u) & 1u) * 0.25, f32(i1 >> 3u) * 0.5);
  var rise = mix(${t.name}(uv + o0)[i0 & 3u], ${t.name}(uv + o1)[i1 & 3u], fract(az)) * (PI / 2.0);
  if (above > 0.0) {
    // from higher up the horizon lies lower, the more so the nearer the land that makes it
    let far = vec2f(0.5, 0.0);
    let k = mix(${t.name}(uv + o0 + far)[i0 & 3u], ${t.name}(uv + o1 + far)[i1 & 3u], fract(az));
    rise = atan(tan(rise) - above / (${num(h.near)} * pow(${num(h.far / h.near)}, k)));
  }
  return smoothstep(${num(-h.soft)}, ${num(h.soft)}, atan2(l.z, hl) - rise);
}
// The same for a point on the ground.
fn ${t.name}Sun(p: vec3f, l: vec3f) -> f32 { return ${t.name}SunAt(p, l, 0.0); }
`;
    }
    return code;
  }).join('');
}

// For scenes that write their own sky but no envReflect: glossy surfaces
// mirror that sky as it is.
export const DEFAULT_REFLECT = /* wgsl */ `
fn envReflect(dir: vec3f, t: f32, lit: f32) -> vec3f { return envSky(dir, t); }
`;

export const SCENE_PIPELINES = /* wgsl */ `
${tetTable()}

@group(0) @binding(1) var shadowTex: texture_depth_2d_array;
@group(0) @binding(2) var shadowSamp: sampler_comparison;
struct PassU { cascade: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(3) var<uniform> passU: PassU;
@group(0) @binding(4) var probeTex: texture_cube<f32>;
@group(0) @binding(5) var probeSamp: sampler;

struct DynVert { pos: vec4f, nrm: u32, col: u32, prm: u32, uv: u32 };
struct DrawU { tRel: f32, p0: f32, p1: f32, p2: f32 };
@group(1) @binding(0) var<storage, read> dynVerts: array<DynVert>;
@group(1) @binding(1) var<storage, read> dynTets: array<vec4u>;
@group(1) @binding(2) var<uniform> drawU: DrawU;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) wpos: vec3f,
  @location(1) t: f32,
  @location(2) nrm: vec4f,      // xyz the normal, w the mesh's spare value (aux)
  @location(3) col: vec4f,
  @location(4) uv: vec2f,
  @location(5) view: vec3f,
  @location(6) @interpolate(flat) prm: vec4u,   // material, gloss, flags, tag
  @location(7) @interpolate(flat) win: vec3f,
  // dynamic geometry only: the 4D normal of the tetrahedron this came from
  @location(8) @interpolate(flat) n4: vec4f,
  // instanced geometry: the copy's tint and number (1, 1, 1, 0 otherwise)
  @location(9) @interpolate(flat) inst: vec4f,
};

struct ShadowOut {
  @builtin(position) clip: vec4f,
  @location(0) t: f32,
  @location(1) @interpolate(flat) win: vec3f,
  // the rest is for meshes with holes, whose shadow has them too
  @location(2) wpos: vec3f,
  @location(3) uv: vec2f,
  @location(4) col: vec4f,      // rgb the colour, a the spare value (aux)
  @location(5) @interpolate(flat) prm: vec4u,
  @location(6) @interpolate(flat) inst: vec4f,
};

fn toView(d: vec4f) -> vec3f { return vec3f(dot(G.camR, d), dot(G.camU, d), dot(G.camF, d)); }
// Reversed, infinite-far depth: depth = near / distance.  A vertex exactly in
// the camera's own plane would get w = 0, which some rasterizers mishandle.
fn toClip(v: vec3f) -> vec4f {
  return vec4f(v.x * G.proj.x, v.y * G.proj.y, G.proj.z, select(v.z, -0.001, abs(v.z) < 0.001));
}

// ---- shadow maps: orthographic views of *space* along the sun direction at
// the player's own time, two or three of them covering ever larger areas
// round the player.  Static geometry casts exact shadows whatever the tilt;
// moving things cast the shadow of wherever the slice finds them.
fn shadowBasis(l: vec3f) -> mat3x3f {
  var up = vec3f(0.0, 0.0, 1.0);
  if (abs(l.z) > 0.99) { up = vec3f(0.0, 1.0, 0.0); }
  let ex = normalize(cross(up, l));
  return mat3x3f(ex, cross(l, ex), l);
}
fn shadowCoord(wpos: vec3f, B: mat3x3f, cascade: u32) -> vec3f {
  var r = select(G.shadow.z, G.shadow.y, cascade == 0u);
  if (cascade == 2u) { r = G.shadow2.x; }
  let texel = 2.0 * r / G.timeInfo.z;
  let c = G.P.xyz * B;
  let q = wpos * B;
  let cs = floor(c.xy / texel) * texel;
  return vec3f((q.xy - cs) / r, 0.5 - (q.z - c.z) / (2.0 * G.shadow.w));
}
fn shadowClip(wpos: vec3f) -> vec4f {
  let B = shadowBasis(normalize(envSun(G.P.w).dir));
  return vec4f(shadowCoord(wpos, B, passU.cascade), 1.0);
}
fn shadowTap(sc: vec3f, layer: u32, bias: f32) -> f32 {
  let uv = sc.xy * vec2f(0.5, -0.5) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) { return 1.0; }
  let ts = 1.0 / G.timeInfo.z;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowTex, shadowSamp, uv + vec2f(f32(x), f32(y)) * ts, layer, sc.z - bias);
    }
  }
  return sum / 9.0;
}
fn sunShadow(wpos: vec3f, n: vec3f, sunDir: vec3f) -> f32 {
  if (G.shadow.x < 0.5) { return 1.0; }
  let l = normalize(envSun(G.P.w).dir);
  // The maps were made for the sun as it stands at the player's time; fade
  // them out where this surface's own time has the sun somewhere else.
  let valid = smoothstep(0.90, 0.985, dot(l, sunDir));
  if (valid <= 0.0) { return 1.0; }
  let B = shadowBasis(l);
  let dist = length(wpos - G.P.xyz);
  let r0 = G.shadow.y; let r1 = G.shadow.z; let r2 = G.shadow2.x;
  let three = G.shadow2.y > 2.5;
  let texel0 = 2.0 * r0 / G.timeInfo.z; let texel1 = 2.0 * r1 / G.timeInfo.z; let texel2 = 2.0 * r2 / G.timeInfo.z;
  let depthScale = 1.0 / (2.0 * G.shadow.w);
  var s = 1.0;
  if (dist < r0 * 0.92) {
    s = shadowTap(shadowCoord(wpos + n * texel0 * 2.0, B, 0u), 0u, texel0 * 1.5 * depthScale);
    let f = smoothstep(r0 * 0.75, r0 * 0.92, dist);
    if (f > 0.0) { s = mix(s, shadowTap(shadowCoord(wpos + n * texel1 * 1.5, B, 1u), 1u, texel1 * 1.5 * depthScale), f); }
  } else if (dist < r1 * select(1.0, 0.92, three)) {
    s = shadowTap(shadowCoord(wpos + n * texel1 * 1.5, B, 1u), 1u, texel1 * 1.5 * depthScale);
    if (three) {
      let f = smoothstep(r1 * 0.75, r1 * 0.92, dist);
      if (f > 0.0) { s = mix(s, shadowTap(shadowCoord(wpos + n * texel2 * 1.5, B, 2u), 2u, texel2 * 1.5 * depthScale), f); }
    } else {
      s = mix(s, 1.0, smoothstep(r1 * 0.8, r1, dist));
    }
  } else if (three && dist < r2) {
    s = shadowTap(shadowCoord(wpos + n * texel2 * 1.5, B, 2u), 2u, texel2 * 1.5 * depthScale);
    s = mix(s, 1.0, smoothstep(r2 * 0.8, r2, dist));
  }
  return mix(1.0, s, valid);
}

// ---- static geometry: a mesh extruded along time.  Each vertex's world line
// meets the slice exactly once, at the time solved for here.
struct SIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec4f,
  @location(2) col: vec4f,
  @location(3) prm: vec4u,
  @location(4) win: vec3f,
  @location(5) uv: vec2f,
};
// One copy of an instanced mesh: where it stands (a 3 x 4 matrix by rows),
// its tint and number, and its time window (from, to, period).
struct IIn {
  @location(6) m0: vec4f,
  @location(7) m1: vec4f,
  @location(8) m2: vec4f,
  @location(9) inst: vec4f,
  @location(10) win: vec4f,
};
fn instPos(p: vec3f, i: IIn) -> vec3f {
  let q = vec4f(p, 1.0);
  return vec3f(dot(i.m0, q), dot(i.m1, q), dot(i.m2, q));
}
// (by the cofactor matrix, which is right for any scaling)
fn instNrm(n: vec3f, i: IIn) -> vec3f {
  let a = i.m0.xyz; let b = i.m1.xyz; let c = i.m2.xyz;
  return normalize(vec3f(dot(cross(b, c), n), dot(cross(c, a), n), dot(cross(a, b), n)));
}
fn staticDelta(pos: vec3f) -> vec4f {
  let dx = pos - G.P.xyz;
  return vec4f(dx, -dot(G.O.xyz, dx) * G.misc.x);
}
fn staticOut(in: SIn, pos: vec3f, nrm: vec3f, inst: vec4f, win: vec3f) -> VOut {
  var o: VOut;
  let d = staticDelta(pos);
  o.view = toView(d);
  o.clip = toClip(o.view);
  o.wpos = pos;
  o.t = G.P.w + d.w / G.proj.w;
  o.nrm = vec4f(nrm, in.nrm.w);
  o.col = in.col;
  o.uv = in.uv;
  o.prm = in.prm;
  o.win = win;
  o.inst = inst;
  return o;
}
fn staticShadowOut(in: SIn, pos: vec3f, inst: vec4f, win: vec3f) -> ShadowOut {
  var o: ShadowOut;
  let d = staticDelta(pos);
  o.clip = shadowClip(pos);
  if ((in.prm.z & 4u) != 0u) { o.clip = vec4f(0.0, 0.0, 2.0, 1.0); } // flagged as casting no shadow
  o.t = G.P.w + d.w / G.proj.w;
  o.win = win;
  o.wpos = pos;
  o.uv = in.uv;
  o.col = vec4f(in.col.rgb, in.nrm.w);
  o.prm = in.prm;
  o.inst = inst;
  return o;
}
@vertex fn vs_static(in: SIn) -> VOut { return staticOut(in, in.pos, in.nrm.xyz, vec4f(1.0, 1.0, 1.0, 0.0), in.win); }
@vertex fn vs_static_i(in: SIn, i: IIn) -> VOut { return staticOut(in, instPos(in.pos, i), instNrm(in.nrm.xyz, i), i.inst, i.win.xyz); }
@vertex fn vs_static_shadow(in: SIn) -> ShadowOut { return staticShadowOut(in, in.pos, vec4f(1.0, 1.0, 1.0, 0.0), in.win); }
@vertex fn vs_static_i_shadow(in: SIn, i: IIn) -> ShadowOut { return staticShadowOut(in, instPos(in.pos, i), i.inst, i.win.xyz); }

// ---- dynamic geometry: tetrahedra in (x, y, z, t), cut by the slice.
struct TetCut { ok: bool, a: u32, b: u32, s: f32, d: vec4f, n4: vec4f };
fn cutTet(ii: u32, vi: u32) -> TetCut {
  var r: TetCut;
  r.ok = false;
  // the top bit of the first index records the tetrahedron's orientation
  let raw = dynTets[ii];
  let tet = vec4u(raw.x & 0x7fffffffu, raw.yzw);
  var q: array<vec4f, 4>;
  var dd: array<f32, 4>;
  var mask = 0u;
  for (var k = 0u; k < 4u; k++) {
    let p = dynVerts[tet[k]].pos;
    let dl = vec4f(p.xyz - G.P.xyz, (p.w - drawU.tRel) * G.proj.w);
    q[k] = dl;
    dd[k] = dot(G.O, dl);
    if (dd[k] > 0.0) { mask |= (1u << k); }
  }
  var table = TET_TABLE;
  let code = table[mask];
  if (code == 0xffffffffu) { return r; }
  let e = (code >> (vi * 4u)) & 15u;
  let i = e & 3u; let j = e >> 2u;
  r.ok = true;
  r.a = tet[i]; r.b = tet[j];
  r.s = dd[i] / (dd[i] - dd[j]);
  r.d = mix(q[i], q[j], r.s);
  // The tetrahedron is a piece of the 3D boundary of a world-volume.  Its
  // outward normal in 4D (the generalised cross product of three edges, with
  // the sign the builder worked out) tells which side of that boundary a line
  // of sight arrives from.
  let e1 = q[1] - q[0]; let e2 = q[2] - q[0]; let e3 = q[3] - q[0];
  r.n4 = vec4f(
    determinant(mat3x3f(e1.yzw, e2.yzw, e3.yzw)),
    -determinant(mat3x3f(e1.xzw, e2.xzw, e3.xzw)),
    determinant(mat3x3f(e1.xyw, e2.xyw, e3.xyw)),
    -determinant(mat3x3f(e1.xyz, e2.xyz, e3.xyz))) * select(1.0, -1.0, (raw.x & 0x80000000u) != 0u);
  return r;
}
@vertex fn vs_dyn(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let c = cutTet(ii, vi);
  if (!c.ok) { o.clip = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  let va = dynVerts[c.a]; let vb = dynVerts[c.b];
  o.view = toView(c.d);
  o.clip = toClip(o.view);
  o.wpos = G.P.xyz + c.d.xyz;
  o.t = G.P.w + c.d.w / G.proj.w;
  o.nrm = mix(unpack4x8snorm(va.nrm), unpack4x8snorm(vb.nrm), c.s);
  o.n4 = c.n4;
  o.col = mix(unpack4x8unorm(va.col), unpack4x8unorm(vb.col), c.s);
  o.uv = mix(unpack2x16float(va.uv), unpack2x16float(vb.uv), c.s);
  o.prm = vec4u(va.prm & 255u, (va.prm >> 8u) & 255u, (va.prm >> 16u) & 255u, va.prm >> 24u);
  o.win = vec3f(-1e30, 1e30, 0.0);
  o.inst = vec4f(1.0, 1.0, 1.0, 0.0);
  return o;
}
@vertex fn vs_dyn_shadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ShadowOut {
  var o: ShadowOut;
  o.win = vec3f(-1e30, 1e30, 0.0);
  o.inst = vec4f(1.0, 1.0, 1.0, 0.0);
  let c = cutTet(ii, vi);
  if (!c.ok || (dynVerts[c.a].prm & 0x40000u) != 0u) { o.clip = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  o.wpos = G.P.xyz + c.d.xyz;
  o.clip = shadowClip(o.wpos);
  o.t = G.P.w + c.d.w / G.proj.w;
  let va = dynVerts[c.a];
  o.prm = vec4u(va.prm & 255u, (va.prm >> 8u) & 255u, (va.prm >> 16u) & 255u, va.prm >> 24u);
  if ((o.prm.z & 16u) != 0u) {
    // a mesh with holes: what the cutout hook may need
    let vb = dynVerts[c.b];
    o.uv = mix(unpack2x16float(va.uv), unpack2x16float(vb.uv), c.s);
    o.col = vec4f(mix(unpack4x8unorm(va.col), unpack4x8unorm(vb.col), c.s).rgb, mix(unpack4x8snorm(va.nrm).w, unpack4x8snorm(vb.nrm).w, c.s));
  }
  return o;
}

const TINT_FULL = 30.0;
const TINT_GAIN = 1.2;
// The colouring by time: what lies in the player's past (dt < 0) turns
// towards amber, what lies in their future towards blue.  G.timeInfo.w says
// how:
//   above 0   slightly: a warm or a cool cast, stronger the more time lies
//             between, as strong as it gets times the value given (1 is usual)
//   below 0   outright, as a teaching aid, with a contour line at every whole second
// strength is how much of it the caller's kind of thing takes (the sky less).
fn timeTint(c: vec3f, dt: f32, dtWidth: f32, strength: f32) -> vec3f {
  let k = G.timeInfo.w;
  if (k == 0.0) { return c; }
  let tint = select(vec3f(0.30, 0.78, 1.0), vec3f(1.0, 0.64, 0.22), dt < 0.0);
  if (k > 0.0) {
    // A colour filter of the tint's hue, which leaves a grey as bright as it
    // was.  It goes as the cube root of the time between, so that it shows
    // on things a fraction of a second away and still grows a long way off:
    // twice as strong for every eight times as long, up to TINT_FULL seconds.
    // (Right at no time between it fades in smoothly, so that a level view,
    // where everything is now, is left alone.)
    let hue = tint / dot(tint, vec3f(0.2126, 0.7152, 0.0722));
    let x = abs(dt);
    let amount = min(1.0, pow(x / TINT_FULL, 1.0 / 3.0)) * smoothstep(0.0, 0.02, x);
    return c * mix(vec3f(1.0), hue, min(1.0, amount * strength * TINT_GAIN * k));
  }
  let lum = dot(c, vec3f(0.3, 0.6, 0.1));
  let amount = (1.0 - exp(-abs(dt) * 0.7)) * strength;
  var o = mix(c, tint * (lum * 1.1 + 0.03), amount);
  let line = 1.0 - smoothstep(0.6, 1.6, abs(fract(dt + 0.5) - 0.5) / max(dtWidth, 1e-6));
  o = mix(o, tint * 1.2, line * 0.55 * step(0.5, abs(dt)));
  return o;
}

// The tint of an instanced copy, which the parts of its mesh marked as
// untinted do not take.  (The flag's bit means something else on moving
// geometry, which is never instanced.)
fn tintOf(flags: u32, inst: vec4f) -> vec3f {
  return select(inst.rgb, vec3f(1.0), (flags & 0xC0u) == 0x80u);
}

fn outsideWindow(t: f32, win: vec3f) -> bool {
  if (win.z > 0.0) {
    let ph = t - win.x;
    return (ph - floor(ph / win.z) * win.z) >= (win.y - win.x);
  }
  return t < win.x || t >= win.y;
}

// A mesh with holes casts a shadow with the same holes.  (The hook is asked
// with what the shadow pass knows: no normal, view or distance.)
@fragment fn fs_shadow(in: ShadowOut) {
  if (outsideWindow(in.t, in.win)) { discard; }
  var s: Surface;
  s.pos = in.wpos;
  s.t = in.t;
  s.n = vec3f(0.0, 0.0, 1.0);
  s.uv = in.uv;
  s.view = vec3f(0.0, 0.0, -1.0);
  s.dist = 0.0; // (documented: this is how the hook can tell that it is asked for a shadow)
  s.color = srgbToLinear(in.col.rgb) * tintOf(in.prm.z, in.inst);
  s.gloss = f32(in.prm.y) / 255.0;
  s.sun = 1.0;
  s.ambient = 1.0;
  s.mat = in.prm.x;
  s.alpha = 1.0;
  s.aux = in.col.a;
  s.tag = in.prm.w;
  s.inst = in.inst;
  let cover = cutout(s);
  if ((in.prm.z & 16u) != 0u && cover < 0.5) { discard; }
}

struct Frag { s: Surface, interior: bool, flags: u32, tSky: f32, cover: f32, coverWidth: f32 };

fn prepare(in: VOut, ff: bool) -> Frag {
  var f: Frag;
  f.flags = in.prm.z;
  f.interior = (f.flags & 0xC0u) == 0xC0u; // (moving geometry's caps in time)
  var n = normalize(in.nrm.xyz);
  if ((f.flags & 0x40u) == 0u) {
    if (outsideWindow(in.t, in.win)) { discard; }
    // Looking at the inside of a mesh: for something cut open by its time
    // window that is the cut itself; otherwise (and for anything marked as a
    // thin sheet) treat the mesh as two-sided.
    if (ff != (G.misc.y > 0.0)) {
      if ((in.win.x > -1e29 || in.win.y < 1e29) && (f.flags & 8u) == 0u) { f.interior = true; } else { n = -n; }
    }
  }
  let dv = normalize(in.view);
  let D = dv.x * G.camR + dv.y * G.camU + dv.z * G.camF;
  let sl = length(D.xyz);
  // A moving thin sheet (a fin, a flag) seen from behind is lit as the side
  // that is actually visible.  This is only done for meshes marked as thin:
  // on a closed object with sparse keys the tetrahedra can fold a little, and
  // its smooth normals hide that better than a flip would.
  if ((f.flags & 0x48u) == 0x48u && dot(in.n4, D) > 0.0) { n = -n; }
  var s: Surface;
  s.pos = in.wpos;
  s.t = in.t;
  s.n = n;
  s.uv = in.uv;
  s.view = select(vec3f(0.0, 0.0, -1.0), D.xyz / max(sl, 1e-6), sl > 1e-4);
  s.dist = length(in.view);
  s.color = srgbToLinear(in.col.rgb) * tintOf(f.flags, in.inst);
  s.emissive = max(in.col.a, 0.0) * in.col.a * 32.0;
  s.gloss = f32(in.prm.y) / 255.0;
  s.light = vec3f(0.0);
  s.sun = 1.0;
  s.ambient = 1.0;
  s.mat = in.prm.x;
  // see-through geometry keeps its opacity in the spare value
  s.alpha = select(1.0, saturate(in.nrm.w), (f.flags & 32u) != 0u);
  s.aux = in.nrm.w;
  s.tag = in.prm.w;
  s.inst = in.inst;
  // Fog takes the colour of the sky behind the surface, at the sky's time.
  f.tSky = G.P.w + G.misc.z * D.w / G.proj.w;
  f.cover = cutout(s);
  f.coverWidth = fwidth(f.cover);
  f.s = surface(s);
  f.s.n = normalize(f.s.n);
  return f;
}

// What a glossy surface mirrors in the direction r (in space): the picture of
// the scene around the player, looked up along the ray inside the slice that
// runs that way.
fn probeSample(r: vec3f) -> vec3f {
  let d = vec4f(r, -dot(G.O.xyz, r) * G.misc.x);
  return textureSampleLevel(probeTex, probeSamp, vec3f(dot(G.probeX, d), dot(G.probeY, d), dot(G.probeZ, d)), 0.0).rgb;
}

// The colour of a lit surface, fog and all.
fn shade(f: Frag, dtWidth: f32) -> vec3f {
  let s = f.s;
  var c: vec3f;
  if ((f.flags & 2u) != 0u) {
    c = s.color * (1.0 + s.emissive);
  } else if (f.interior) {
    c = s.color * (0.45 * s.ambient * envAmbient(vec3f(0.0, 0.0, 1.0), s.t) + s.light) + s.color * s.emissive;
  } else {
    let sun = envSun(s.t);
    let ndl = max(dot(s.n, sun.dir), 0.0);
    var sh = 1.0;
    if (ndl > 0.0) { sh = sunShadow(s.pos, s.n, sun.dir); }
    sh *= s.sun;
    let direct = sun.color * (ndl * sh);
    c = s.color * (direct + s.ambient * envAmbient(s.n, s.t) + s.light);
    // highlight and reflection
    let h = normalize(sun.dir - s.view);
    let sp = mix(12.0, 600.0, s.gloss * s.gloss);
    c += sun.color * (sh * step(0.0001, ndl) * s.gloss * (sp + 8.0) / 25.0 * pow(max(dot(s.n, h), 0.0), sp)) * 0.25;
    let mirror = (0.04 + 0.96 * pow(1.0 - max(dot(s.n, -s.view), 0.0), 5.0)) * s.gloss * s.gloss;
    if (mirror > 0.004) {
      let rd = reflect(s.view, s.n);
      if (G.probe.x > 0.5) {
        c += probeSample(rd) * mirror;
      } else {
        c += envReflect(rd, s.t, sh * step(0.0001, ndl)) * mirror;
      }
    }
    c += s.color * s.emissive;
  }
  let fog = envFog(s.view, f.tSky, s.dist);
  c = mix(c, fog.rgb, saturate(fog.a));
  c = timeTint(c, mix(s.t, f.tSky, saturate(fog.a)) - G.P.w, dtWidth, 0.7);
  return min(c, vec3f(64.0));
}

// Opaque geometry.  For a mesh with holes the alpha that comes out says how
// much of the pixel is covered, which the multisampling turns into smooth edges.
@fragment fn fs_main(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let dtWidth = fwidth(in.t);
  let f = prepare(in, ff);
  var alpha = 1.0;
  if ((f.flags & 16u) != 0u) {
    if (G.probe.y > 0.5) {
      alpha = step(0.5, f.cover); // that picture has one sample per pixel: a plain cut
    } else {
      alpha = saturate((f.cover - 0.5) / max(f.coverWidth, 1e-5) + 0.5);
    }
    if (alpha < 0.004) { discard; }
  }
  return vec4f(shade(f, dtWidth), alpha);
}

// See-through geometry: lit like the rest, then blended by its opacity.
@fragment fn fs_blend(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let dtWidth = fwidth(in.t);
  let f = prepare(in, ff);
  let a = saturate(f.s.alpha);
  return vec4f(shade(f, dtWidth) * a, a);
}

// Additive geometry is pure light: colour * emissive, dimmed by fog.
@fragment fn fs_add(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let f = prepare(in, ff);
  let fog = envFog(f.s.view, f.tSky, f.s.dist);
  return vec4f(min(f.s.color * f.s.emissive * (1.0 - saturate(fog.a)), vec3f(64.0)), 1.0);
}

// ---- sky: every pixel is a ray inside the slice.  It ends on a far shell,
// which fixes both the direction in space and the moment in time it shows.
struct SkyOut { @builtin(position) clip: vec4f, @location(0) ndc: vec2f };
@vertex fn vs_sky(@builtin(vertex_index) vi: u32) -> SkyOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  return SkyOut(vec4f(p, 0.0, 1.0), p);
}
@fragment fn fs_sky(in: SkyOut) -> @location(0) vec4f {
  let dv = normalize(vec3f(in.ndc.x / G.proj.x, in.ndc.y / G.proj.y, 1.0));
  let D = dv.x * G.camR + dv.y * G.camU + dv.z * G.camF;
  let sl = length(D.xyz);
  let dir = select(vec3f(0.0, 0.0, 1.0), D.xyz / max(sl, 1e-6), sl > 1e-4);
  let t = G.P.w + G.misc.z * D.w / G.proj.w;
  var c: vec3f;
  // (the picture that glossy surfaces mirror takes the sky as they should see it)
  if (G.probe.y > 0.5) { c = envReflect(dir, t, 1.0); } else { c = envSky(dir, t); }
  return vec4f(min(timeTint(c, t - G.P.w, 1e9, 0.45), vec3f(64.0)), 1.0);
}
`;

export const POST = /* wgsl */ `
struct PostU { texel: vec2f, exposure: f32, bloom: f32, threshold: f32, time: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var<uniform> U: PostU;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var src2: texture_2d<f32>;

struct FsIn { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> FsIn {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return FsIn(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}

fn down(uv: vec2f) -> vec3f {
  let h = U.texel * 0.5;
  var c = textureSampleLevel(src, samp, uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(src, samp, uv - h, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + h, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(h.x, -h.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv - vec2f(h.x, -h.y), 0.0).rgb;
  return c / 8.0;
}
// First bloom step: keep only what is brighter than the threshold.
@fragment fn fs_prefilter(in: FsIn) -> @location(0) vec4f {
  let c = min(down(in.uv) * U.exposure, vec3f(24.0));
  let l = max(c.r, max(c.g, c.b));
  let k = max(l - U.threshold, 0.0) / max(l, 1e-4);
  return vec4f(c * k * k, 1.0);
}
@fragment fn fs_down(in: FsIn) -> @location(0) vec4f { return vec4f(down(in.uv), 1.0); }
@fragment fn fs_up(in: FsIn) -> @location(0) vec4f {
  let h = U.texel * 0.5;
  var c = textureSampleLevel(src, samp, in.uv + vec2f(-h.x * 2.0, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, h.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2f(0.0, h.y * 2.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(h.x, h.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2f(h.x * 2.0, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(h.x, -h.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, in.uv + vec2f(0.0, -h.y * 2.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, -h.y), 0.0).rgb * 2.0;
  return vec4f(c / 12.0, 1.0);
}
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
@fragment fn fs_composite(in: FsIn) -> @location(0) vec4f {
  var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb * U.exposure;
  c += textureSampleLevel(src2, samp, in.uv, 0.0).rgb * U.bloom;
  c = aces(c);
  let q = in.uv - 0.5;
  c *= 1.0 - 0.35 * dot(q, q);
  c = pow(c, vec3f(1.0 / 2.2));
  let n = fract(sin(dot(in.clip.xy + U.time, vec2f(12.9898, 78.233))) * 43758.5453);
  return vec4f(c + (n - 0.5) / 255.0, 1.0);
}
`;
