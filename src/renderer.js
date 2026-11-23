// WebGPU renderer.  Per frame:
//   1. two or three shadow cascades (depth only)
//   2. for scenes that ask for reflections: one side of a picture of the
//      scene all round the player (a cube map), which glossy surfaces mirror
//   3. the scene into a multisampled HDR target: static geometry, sliced
//      tetrahedra, sky, then see-through geometry from the furthest to the
//      nearest, then additive geometry
//   4. bloom and tone mapping onto the canvas
// Each of the passes 1 to 3 is handed only what it can see: static geometry
// comes from the builder in cells of neighbouring triangles and clusters of
// neighbouring copies, moving geometry in chunks of one key step, each with
// its bounds, and what lies wholly outside a pass's view volume is left out
// of it (see _staticDraws and _dynDraws).

import { COMMON, SCENE_PIPELINES, POST, DEFAULT_SURFACE, DEFAULT_REFLECT, DEFAULT_CUTOUT, textureDecls } from './wgsl.js';
import { dayNightEnv } from './env.js';
import { STATIC_STRIDE, INSTANCE_STRIDE, MAX_TEXTURES, BLOCK, toHalf } from './builder.js';
import { f4 } from './math.js';

const HDR = 'rgba16float';
const DEPTH = 'depth32float';
const SAMPLES = 4;
const SHADOW_SIZE = 2048;
const PROBE_SIZE = 256;
const GLOBALS = 60; // floats in the Globals uniform (see wgsl.js)
const MAX_COPIES = 24;
const SUN_SAMPLES = 256, SUN_STEP = 0.25; // the light's direction is read back for this many moments, this far apart (s)
const SLOT = 256;
const BLOOM_LEVELS = 5;
const ENV_HOOKS = ['envSun', 'envSky', 'envAmbient', 'envFog'];

// A list of instance ranges to draw, one list per time-repeat slot.  Chunks
// are visited in buffer order; ones that are neighbours, or separated only by
// a small gap, merge into a single draw call.  (Most tetrahedra in a gap do
// not meet the slice, and the vertex shader throws those away; the few that
// do are things out of sight or too far off, drawn after all.)  The gap is
// what a draw call is worth: bridging more than this costs more in wasted
// vertex work than the call it saves.
const BRIDGE = 192;
// a 16-bit float, as the GPU stores them, as a number
function fromHalf(h) {
  const e = (h >> 10) & 31, f = h & 1023;
  return (h & 0x8000 ? -1 : 1) * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15));
}

class DrawList {
  constructor() { this.slots = []; this.tets = 0; }
  // bridge: how many tetrahedra that were not asked for may be drawn along
  // with these to save a draw call (none for detail that is only drawn from
  // near by: what lies between two pieces of it is other things' detail)
  add(slot, first, count, bridge = BRIDGE) {
    const list = this.slots[slot] || (this.slots[slot] = []);
    const last = list[list.length - 1];
    if (last && first - (last.first + last.count) <= bridge) {
      this.tets += first + count - (last.first + last.count);
      last.count = first + count - last.first;
    } else {
      list.push({ first, count });
      this.tets += count;
    }
  }
}

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter was found.');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return new Renderer(device, context, format, canvas);
  }

  constructor(device, context, format, canvas) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.canvas = canvas;
    this.scene = null;
    this.size = [0, 0];
    this.frame = 0;
    this.info = { tets: 0, triangles: 0, draws: 0, liveDraws: 0, frame: { triangles: 0, tets: 0, draws: 0 } };
    // What is left out of a pass that cannot see it, as a sum of: 1 static
    // geometry from the picture, 2 static geometry from the shadow maps,
    // 4 moving geometry from the picture, 8 moving geometry from the shadow
    // maps, 16 static geometry from the sides of the reflection picture.
    // (0 draws everything in every pass, to compare with.)
    this.cull = 31;
    this.detail = 1;   // a factor on the distances from which detail given with `within` is drawn
    this.nearFirst = true; // draw the picture's opaque static geometry nearest first (false: in the order it is stored)
    this.onError = (msg) => console.error(msg);
    device.addEventListener('uncapturederror', (e) => this.onError('WebGPU: ' + e.error.message));

    const d = device;
    const U = GPUBufferUsage, S = GPUShaderStage;
    this.globals = new Float32Array(GLOBALS);
    this.globalsBuf = d.createBuffer({ size: GLOBALS * 4, usage: U.UNIFORM | U.COPY_DST });
    this.passBufs = [0, 1, 2].map((c) => {
      const b = d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
      d.queue.writeBuffer(b, 0, new Uint32Array([c, 0, 0, 0]));
      return b;
    });
    this.drawData = new Float32Array(MAX_COPIES * SLOT / 4);
    this.drawBuf = d.createBuffer({ size: MAX_COPIES * SLOT, usage: U.UNIFORM | U.COPY_DST });

    // the scene's own textures (up to four) and their samplers: bindings 6.. and 10..
    const sceneTextures = [];
    for (let i = 0; i < MAX_TEXTURES; i++) {
      sceneTextures.push({ binding: 6 + i, visibility: S.VERTEX | S.FRAGMENT, texture: {} });
      sceneTextures.push({ binding: 10 + i, visibility: S.VERTEX | S.FRAGMENT, sampler: {} });
    }
    this.bglMain = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} },
        { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 2, visibility: S.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 4, visibility: S.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 5, visibility: S.FRAGMENT, sampler: {} },
        ...sceneTextures,
      ],
    });
    this.bglShadow = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} },
        { binding: 3, visibility: S.VERTEX, buffer: {} },
        ...sceneTextures,
      ],
    });
    this.bglDyn = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: S.VERTEX, buffer: { hasDynamicOffset: true, minBindingSize: 16 } },
        { binding: 3, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.shadowSampler = d.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.shadowCount = 0; // layers in the shadow texture, made when a scene needs them
    // samplers for the scene's textures, and stand-ins for the slots a scene leaves empty
    this.samplers = {};
    for (const filter of ['linear', 'nearest']) {
      for (const mode of ['clamp-to-edge', 'repeat']) {
        this.samplers[`${filter} ${mode}`] = d.createSampler({ magFilter: filter, minFilter: filter, addressModeU: mode, addressModeV: mode });
      }
    }
    const TU = GPUTextureUsage;
    this.blank = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: TU.TEXTURE_BINDING | TU.COPY_DST }).createView();
    this.blankCube = d.createTexture({ size: [1, 1, 6], format: HDR, usage: TU.TEXTURE_BINDING | TU.COPY_DST }).createView({ dimension: 'cube' });
    this.probe = null; // the picture of the scene round the player, made when a scene asks for reflections

    this._initPost();
  }

  // The shadow maps: one layer per cascade.
  _shadows(count) {
    if (this.shadowCount === count) return;
    this.shadowTex?.destroy();
    this.shadowTex = this.device.createTexture({
      size: [SHADOW_SIZE, SHADOW_SIZE, count], format: DEPTH,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowCount = count;
    this.shadowLayers = [];
    for (let i = 0; i < count; i++) this.shadowLayers.push(this.shadowTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
    this.shadowView = this.shadowTex.createView({ dimension: '2d-array' });
  }

  // What glossy surfaces mirror in a scene with `reflections`: the scene as
  // seen from the player in all six directions.  Each side has its own copy
  // of the globals, since it is a view of its own.
  _probe() {
    if (this.probe) return this.probe;
    const d = this.device, TU = GPUTextureUsage;
    const tex = d.createTexture({ size: [PROBE_SIZE, PROBE_SIZE, 6], format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    const faces = [];
    for (let i = 0; i < 6; i++) faces.push(tex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
    this.probe = {
      faces,
      cube: tex.createView({ dimension: 'cube' }),
      depth: d.createTexture({ size: [PROBE_SIZE, PROBE_SIZE], format: DEPTH, usage: TU.RENDER_ATTACHMENT }).createView(),
      bufs: faces.map(() => d.createBuffer({ size: GLOBALS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })),
      globals: new Float32Array(GLOBALS),
    };
    return this.probe;
  }

  // ---- post-processing ------------------------------------------------------

  _initPost() {
    const d = this.device, S = GPUShaderStage;
    const module = d.createShaderModule({ code: POST });
    this.postSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const base = [
      { binding: 0, visibility: S.FRAGMENT, sampler: {} },
      { binding: 1, visibility: S.FRAGMENT, buffer: { hasDynamicOffset: true, minBindingSize: 32 } },
      { binding: 2, visibility: S.FRAGMENT, texture: {} },
    ];
    this.bglPost1 = d.createBindGroupLayout({ entries: base });
    this.bglPost2 = d.createBindGroupLayout({ entries: [...base, { binding: 3, visibility: S.FRAGMENT, texture: {} }] });
    this.postBuf = d.createBuffer({ size: 16 * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postData = new Float32Array(16 * SLOT / 4);
    const make = (entry, layout, targetFormat, blend) => d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: entry, targets: [{ format: targetFormat, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    this.pipePrefilter = make('fs_prefilter', this.bglPost1, HDR);
    this.pipeDown = make('fs_down', this.bglPost1, HDR);
    this.pipeUp = make('fs_up', this.bglPost1, HDR, add);
    this.pipeComposite = make('fs_composite', this.bglPost2, this.format);
  }

  resize(width, height) {
    width = Math.max(8, Math.floor(width));
    height = Math.max(8, Math.floor(height));
    if (this.size[0] === width && this.size[1] === height) return;
    this.size = [width, height];
    this.canvas.width = width;
    this.canvas.height = height;
    const d = this.device, TU = GPUTextureUsage;
    for (const t of this.targets || []) t.destroy();
    const tex = (w, h, format, sampleCount, usage) => {
      const t = d.createTexture({ size: [w, h], format, sampleCount, usage });
      this.targets.push(t);
      return t;
    };
    this.targets = [];
    this.hdrMS = tex(width, height, HDR, SAMPLES, TU.RENDER_ATTACHMENT).createView();
    this.depthMS = tex(width, height, DEPTH, SAMPLES, TU.RENDER_ATTACHMENT).createView();
    const hdr = tex(width, height, HDR, 1, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
    this.hdr = hdr.createView();
    this.mips = [];
    let w = width, h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      this.mips.push({ w, h, view: tex(w, h, HDR, 1, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING).createView() });
    }
    const bg1 = (view) => d.createBindGroup({
      layout: this.bglPost1,
      entries: [
        { binding: 0, resource: this.postSampler },
        { binding: 1, resource: { buffer: this.postBuf, size: 32 } },
        { binding: 2, resource: view },
      ],
    });
    // The chain of post passes: [pipeline, bind group, target view, source size]
    this.postPasses = [];
    this.postPasses.push({ pipe: this.pipePrefilter, bg: bg1(this.hdr), target: this.mips[0].view, sw: width, sh: height });
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this.postPasses.push({ pipe: this.pipeDown, bg: bg1(this.mips[i - 1].view), target: this.mips[i].view, sw: this.mips[i - 1].w, sh: this.mips[i - 1].h });
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      this.postPasses.push({ pipe: this.pipeUp, bg: bg1(this.mips[i].view), target: this.mips[i - 1].view, sw: this.mips[i].w, sh: this.mips[i].h, load: true });
    }
    this.bgComposite = d.createBindGroup({
      layout: this.bglPost2,
      entries: [
        { binding: 0, resource: this.postSampler },
        { binding: 1, resource: { buffer: this.postBuf, size: 32 } },
        { binding: 2, resource: this.hdr },
        { binding: 3, resource: this.mips[0].view },
      ],
    });
  }

  // ---- scene ----------------------------------------------------------------

  // Assembles the scene shader.  `textures` is the list the builder made of
  // the scene's textures.  Returns { code, hookLine } where hookLine is the
  // line at which the scene's own WGSL starts (for error messages).
  static shaderSource(def, textures = []) {
    const user = def.wgsl || '';
    const has = (name) => new RegExp(`\\bfn\\s+${name}\\s*\\(`).test(user);
    const n = ENV_HOOKS.filter(has).length;
    if (n !== 0 && n !== ENV_HOOKS.length) {
      throw new Error(`Scene WGSL must define all of ${ENV_HOOKS.join(', ')} or none of them (found ${ENV_HOOKS.filter(has).join(', ')}).`);
    }
    let head = COMMON + textureDecls(textures) + '\n';
    if (n === 0) head += dayNightEnv(def.env || {}) + '\n';
    else if (!has('envReflect')) head += DEFAULT_REFLECT + '\n';
    if (!has('surface')) head += DEFAULT_SURFACE + '\n';
    if (!has('cutout')) head += DEFAULT_CUTOUT + '\n';
    return { code: head + user + '\n' + SCENE_PIPELINES, hookLine: head.split('\n').length - 1 };
  }

  // Uploads a built scene and compiles its shader.  Throws with readable
  // messages if the scene's WGSL does not compile.
  // onProgress, if given, is called with how far this has got, 0..1 (most of
  // the time goes on compiling the scene's shader into its pipelines).
  async setScene(data, def, onProgress = null) {
    const d = this.device, U = GPUBufferUsage;
    const { code, hookLine } = Renderer.shaderSource(def, data.textures);
    d.pushErrorScope('validation');
    const module = d.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const userLines = (def.wgsl || '').split('\n').length;
    const errors = info.messages.filter((m) => m.type === 'error').map((m) => {
      const rel = m.lineNum - hookLine;
      const where = rel >= 1 && rel <= userLines ? `scene wgsl line ${rel}` : `engine shader line ${m.lineNum}`;
      return `${where}: ${m.message.split('\n')[0]}`;
    });
    if (errors.length) {
      await d.popErrorScope();
      throw new Error('Shader compilation failed:\n' + errors.join('\n'));
    }

    const buffer = (bytes, usage) => {
      const b = d.createBuffer({ size: Math.ceil(bytes.byteLength / 4) * 4, usage, mappedAtCreation: true });
      new Uint8Array(b.getMappedRange()).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      b.unmap();
      return b;
    };
    const instanced = data.instanced || [];
    const next = {
      def,
      vbuf: buffer(data.staticVerts, U.VERTEX),
      ibuf: buffer(data.staticIndices, U.INDEX),
      instBuf: instanced.length ? buffer(data.instances, U.VERTEX) : null,
      instanced: [0, 1, 2].map((layer) => instanced.filter((c) => c.layer === layer)),
      dynVerts: buffer(data.dynVerts, U.STORAGE),
      dynTmpl: buffer(data.dynTmpl, U.STORAGE),
      dynRuns: buffer(data.dynRuns, U.STORAGE),
      dynBlocks: buffer(data.dynBlocks, U.STORAGE),
      dynKeys: buffer(data.dynKeys, U.STORAGE),
      staticCells: data.staticCells,
      staticTimed: data.staticTimed,
      chunks: data.chunks,
      stats: data.stats,
      textures: [],
      cascades: def.shadows === false ? 0 : Math.min(3, (def.shadowRadii ?? [35, 260]).length),
      reflections: !!def.reflections,
      probeAge: 0, // sides of the reflection picture drawn so far
    };
    let tMin = Infinity, tMax = -Infinity;
    for (let i = 0; i < data.chunks.count; i++) {
      tMin = Math.min(tMin, data.chunks.box[i * 9]);
      tMax = Math.max(tMax, data.chunks.box[i * 9 + 1]);
    }
    next.tMin = tMin; next.tMax = tMax;
    next.bgDyn = d.createBindGroup({
      layout: this.bglDyn,
      entries: [
        { binding: 0, resource: { buffer: next.dynVerts } },
        { binding: 1, resource: { buffer: next.dynTmpl } },
        { binding: 3, resource: { buffer: next.dynRuns } },
        { binding: 4, resource: { buffer: next.dynBlocks } },
        { binding: 5, resource: { buffer: next.dynKeys } },
        { binding: 2, resource: { buffer: this.drawBuf, size: 16 } },
      ],
    });

    // the scene's textures, and the bind groups that carry them
    const sceneTextures = [];
    for (let i = 0; i < MAX_TEXTURES; i++) {
      const t = (data.textures || [])[i];
      let view = this.blank, sampler = this.samplers['linear clamp-to-edge'];
      if (t) {
        const format = (t.float ? ['r16float', 'rg16float', , 'rgba16float'] : ['r8unorm', 'rg8unorm', , 'rgba8unorm'])[t.channels - 1];
        const tex = d.createTexture({ size: [t.width, t.height], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const bytes = t.float ? Uint16Array.from(t.data, toHalf) : t.data;
        d.queue.writeTexture({ texture: tex }, bytes, { bytesPerRow: t.width * t.channels * (t.float ? 2 : 1) }, [t.width, t.height]);
        next.textures.push(tex);
        view = tex.createView();
        sampler = this.samplers[`${t.nearest ? 'nearest' : 'linear'} ${t.repeat ? 'repeat' : 'clamp-to-edge'}`];
      }
      sceneTextures.push({ binding: 6 + i, resource: view }, { binding: 10 + i, resource: sampler });
    }
    this._shadows(Math.max(2, next.cascades));
    const probe = next.reflections ? this._probe() : null;
    const mainGroup = (globals, cube) => d.createBindGroup({
      layout: this.bglMain,
      entries: [
        { binding: 0, resource: { buffer: globals } },
        { binding: 1, resource: this.shadowView },
        { binding: 2, resource: this.shadowSampler },
        { binding: 4, resource: cube },
        { binding: 5, resource: this.samplers['linear clamp-to-edge'] },
        ...sceneTextures,
      ],
    });
    next.bgMain = mainGroup(this.globalsBuf, probe ? probe.cube : this.blankCube);
    // (while the reflection picture is drawn it cannot be read as well)
    next.bgProbe = probe ? probe.bufs.map((b) => mainGroup(b, this.blankCube)) : [];
    next.bgShadow = this.passBufs.map((b) => d.createBindGroup({
      layout: this.bglShadow,
      entries: [{ binding: 0, resource: { buffer: this.globalsBuf } }, { binding: 3, resource: { buffer: b } }, ...sceneTextures],
    }));

    const perVertex = {
      arrayStride: STATIC_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'snorm8x4' },
        { shaderLocation: 2, offset: 16, format: 'unorm8x4' },
        { shaderLocation: 3, offset: 20, format: 'uint8x4' },
        { shaderLocation: 4, offset: 24, format: 'float32x3' },
        { shaderLocation: 5, offset: 36, format: 'float32x2' },
      ],
    };
    const perInstance = {
      arrayStride: INSTANCE_STRIDE,
      stepMode: 'instance',
      attributes: [6, 7, 8, 9, 10].map((shaderLocation, i) => ({ shaderLocation, offset: i * 16, format: 'float32x4' })),
    };
    // the three kinds of geometry: [vertex shader, its shadow version, vertex buffers, sliced tetrahedra?]
    const KINDS = {
      static: ['vs_static', 'vs_static_shadow', [perVertex], false],
      inst: ['vs_static_i', 'vs_static_i_shadow', [perVertex, perInstance], false],
      dyn: ['vs_dyn', 'vs_dyn_shadow', [], true],
    };
    // the three layers: [fragment shader, blending]
    const LAYER = [
      ['fs_main', undefined],
      ['fs_add', { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } }],
      ['fs_blend', { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }],
    ];
    const layout = (...l) => d.createPipelineLayout({ bindGroupLayouts: l });
    const main = (kind, layer, samples) => {
      const [vs, , buffers, dyn] = KINDS[kind], [fs, blend] = LAYER[layer];
      return d.createRenderPipelineAsync({
        layout: dyn ? layout(this.bglMain, this.bglDyn) : layout(this.bglMain),
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: fs, targets: [{ format: HDR, blend }] },
        primitive: { topology: dyn ? 'triangle-strip' : 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
        depthStencil: { format: DEPTH, depthWriteEnabled: layer === 0, depthCompare: 'greater' },
        // (for opaque meshes with holes: the alpha that comes out is how much of the pixel is covered)
        multisample: { count: samples, alphaToCoverageEnabled: layer === 0 && samples > 1 },
      });
    };
    const sky = (samples) => d.createRenderPipelineAsync({
      layout: layout(this.bglMain),
      vertex: { module, entryPoint: 'vs_sky', buffers: [] },
      fragment: { module, entryPoint: 'fs_sky', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      multisample: { count: samples },
    });
    const shadow = (kind) => {
      const [, vs, buffers, dyn] = KINDS[kind];
      return d.createRenderPipelineAsync({
        layout: dyn ? layout(this.bglShadow, this.bglDyn) : layout(this.bglShadow),
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: 'fs_shadow', targets: [] },
        primitive: { topology: dyn ? 'triangle-strip' : 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
      });
    };
    // Only what the scene uses is compiled: instanced kinds if it has
    // instances, the single-sample set if it has reflections.  (The
    // reflection picture leaves see-through geometry out.)
    const kinds = instanced.length ? ['static', 'inst', 'dyn'] : ['static', 'dyn'];
    const jobs = [];
    // what it takes to read back the direction of the light (see _sunDir)
    next.sun = null;
    if (next.cascades > 0) {
      const tex = d.createTexture({ size: [SUN_SAMPLES, 1], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const globals = d.createBuffer({ size: GLOBALS * 4, usage: U.UNIFORM | U.COPY_DST });
      const read = d.createBuffer({ size: SUN_SAMPLES * 8, usage: U.MAP_READ | U.COPY_DST });
      const sun = next.sun = { tex, view: tex.createView(), globals, read, bg: mainGroup(globals, this.blankCube), pipe: null, table: null, pending: false };
      jobs.push(d.createRenderPipelineAsync({
        layout: layout(this.bglMain),
        vertex: { module, entryPoint: 'vs_sky', buffers: [] },
        fragment: { module, entryPoint: 'fs_sun', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list' },
      }).then((p) => { sun.pipe = p; }));
    }
    onProgress?.(0.25);
    const set = (samples, layers) => {
      const out = { sky: null };
      for (const kind of kinds) {
        out[kind] = [];
        for (const layer of layers) jobs.push(main(kind, layer, samples).then((p) => { out[kind][layer] = p; }));
      }
      jobs.push(sky(samples).then((p) => { out.sky = p; }));
      return out;
    };
    next.pipes = set(SAMPLES, [0, 1, 2]);
    next.probePipes = next.reflections ? set(1, [0, 1]) : null;
    next.shadowPipes = {};
    for (const kind of kinds) jobs.push(shadow(kind).then((p) => { next.shadowPipes[kind] = [p]; }));
    let done = 0;
    for (const j of jobs) j.then(() => onProgress?.(0.25 + 0.75 * ++done / jobs.length), () => {});
    try {
      await Promise.all(jobs);
    } catch (e) {
      await d.popErrorScope();
      throw new Error('Pipeline creation failed: ' + e.message);
    }
    const err = await d.popErrorScope();
    if (err) throw new Error('WebGPU validation: ' + err.message);

    const old = this.scene;
    this.scene = next;
    if (old) for (const b of [old.vbuf, old.ibuf, old.instBuf, old.dynVerts, old.dynTmpl, old.dynRuns, old.dynBlocks, old.dynKeys, ...old.textures, old.sun?.tex, old.sun?.globals, old.sun?.pending ? null : old.sun?.read]) b?.destroy();
  }

  // Static geometry, in two steps.  First what there is to draw at all this
  // frame, whichever way anything looks: the cells of always-drawn triangles
  // need no test, but the pieces with a time window that the builder kept
  // apart, the pieces that are only drawn from near by, and the instanced
  // groups are each tested here.  A piece with a time window is skipped when
  // the slice, anywhere within the piece's bounds, stays outside the window;
  // the shader discards out-of-window pixels anyway.
  // Returns { timed: [numbers of pieces], groups: [per layer] }.
  _staticSet(cam, sc, invOw) {
    const T = sc.staticTimed, B = T.box, O = cam.O, P = cam.P, C = cam.C;
    const k = invOw / C, ak = Math.abs(k);
    // whether the slice, somewhere within a box, comes to a moment inside a time window
    const reached = (b, o, from, to, period) => {
      const mid = P[3] - (O[0] * (b[o] - P[0]) + O[1] * (b[o + 1] - P[1]) + O[2] * (b[o + 2] - P[2])) * k;
      const half = (Math.abs(O[0]) * b[o + 3] + Math.abs(O[1]) * b[o + 4] + Math.abs(O[2]) * b[o + 5]) * ak + 0.01;
      if (period > 0) {
        const start = ((mid - half - from) % period + period) % period; // phase at the earliest moment seen
        return 2 * half >= period || start < to - from || start + 2 * half >= period;
      }
      return mid + half >= from && mid - half < to;
    };
    // how far the viewer is from a box (centre and half-size at b[o..]), for detail that is drawn only from near by
    const away = (b, o) => Math.hypot(Math.max(Math.abs(b[o] - P[0]) - b[o + 3], 0), Math.max(Math.abs(b[o + 1] - P[1]) - b[o + 4], 0), Math.max(Math.abs(b[o + 2] - P[2]) - b[o + 5], 0));
    const groups = [[], [], []];
    for (let layer = 0; layer < 3; layer++) {
      for (const g of sc.instanced[layer]) {
        if (g.within < 1e29 && away(g.box, 0) > g.within * this.detail) continue;
        if ((g.from > -1e29 || g.to < 1e29) && !reached(g.box, 0, g.from, g.to, g.period)) continue;
        groups[layer].push(g);
      }
    }
    const timed = [];
    for (let i = 0; i < T.count; i++) {
      const o = i * 9;
      if (T.near[i] < Infinity && away(B, o + 3) > T.near[i] * this.detail) continue;
      if (!reached(B, o + 3, B[o], B[o + 1], B[o + 2])) continue;
      timed.push(i);
    }
    return { timed, groups };
  }

  // Then, for one pass, the part of that which lies inside the pass's
  // planes (see _viewPlanes and _cascadePlanes; none: everything), in the
  // layers of `mask` (bit 0: opaque, 1: additive, 2: see-through).  Cells and
  // pieces that are neighbours in the index buffer go into one draw call, and
  // so do neighbouring clusters of one instanced mesh.  See-through pieces
  // are listed one by one with their distance, to be drawn in order.
  // nearFirst: put the opaque draw calls in order of distance, nearest first,
  // so that what is hidden behind them fails the depth test before it is
  // shaded (for the picture; a shadow map has nothing to gain by it).
  // Returns { ranges, groups (each a list per layer), triangles }.
  _staticDraws(sc, set, planes, mask, P, nearFirst = false) {
    const ranges = [[], [], []], groups = [[], [], []];
    const np = planes.length;
    const inside = (b, o) => {
      for (let i = 0; i < np; i++) {
        const p = planes[i];
        if (p[0] * b[o] + p[1] * b[o + 1] + p[2] * b[o + 2] + Math.abs(p[0]) * b[o + 3] + Math.abs(p[1]) * b[o + 4] + Math.abs(p[2]) * b[o + 5] + p[3] < 0) return false;
      }
      return true;
    };
    // how far the viewer is from a box (centre and half-size at b[o..])
    const away = (b, o) => (nearFirst ? Math.hypot(Math.max(Math.abs(b[o] - P[0]) - b[o + 3], 0), Math.max(Math.abs(b[o + 1] - P[1]) - b[o + 4], 0), Math.max(Math.abs(b[o + 2] - P[2]) - b[o + 5], 0)) : 0);
    let triangles = 0;
    const add = (layer, first, count, near) => {
      const list = ranges[layer], last = list[list.length - 1];
      triangles += count / 3;
      if (last && first >= last.first + last.count && first - (last.first + last.count) <= 600) {
        triangles += (first - (last.first + last.count)) / 3;
        last.count = first + count - last.first;
        if (near < last.near) last.near = near;
      } else {
        list.push({ first, count, near });
      }
    };
    const cells = sc.staticCells, CB = cells.box, CR = cells.range;
    for (let i = 0; i < cells.count; i++) {
      const layer = cells.layer[i];
      if ((mask >> layer & 1) && inside(CB, i * 6)) add(layer, CR[i * 2], CR[i * 2 + 1], away(CB, i * 6));
    }
    const T = sc.staticTimed, B = T.box, R = T.range;
    for (const i of set.timed) {
      const layer = T.layer[i], o = i * 9;
      if (!(mask >> layer & 1) || !inside(B, o + 3)) continue;
      if (layer === 2) {
        ranges[2].push({ first: R[i * 2], count: R[i * 2 + 1], dist: Math.hypot(B[o + 3] - P[0], B[o + 4] - P[1], B[o + 5] - P[2]) });
        triangles += R[i * 2 + 1] / 3;
      } else {
        add(layer, R[i * 2], R[i * 2 + 1], away(B, o + 3));
      }
    }
    for (let layer = 0; layer < 3; layer++) {
      if (!(mask >> layer & 1)) continue;
      const list = groups[layer];
      for (const g of set.groups[layer]) {
        if (!inside(g.box, 0)) continue;
        triangles += g.count / 3 * g.instances;
        const last = list[list.length - 1];
        if (layer === 2) {
          list.push({ group: g, dist: Math.hypot(g.box[0] - P[0], g.box[1] - P[1], g.box[2] - P[2]) });
        } else if (last && last.first === g.first && last.count === g.count && last.firstInstance + last.instances === g.firstInstance) {
          last.instances += g.instances;
          last.near = Math.min(last.near, away(g.box, 0));
        } else {
          list.push({ first: g.first, count: g.count, firstInstance: g.firstInstance, instances: g.instances, near: away(g.box, 0) });
        }
      }
    }
    if (nearFirst) {
      ranges[0].sort((a, b) => a.near - b.near);
      groups[0].sort((a, b) => a.near - b.near);
    }
    return { ranges, groups, triangles };
  }

  // The planes that bound what a view takes in, for static geometry: each is
  // [a.x, a.y, a.z, d], with a point p inside where a.p + d >= 0.  The view
  // is of the slice, in which static geometry is sheared by the tilt (see
  // staticDelta in wgsl.js); that is a linear map of space, so the pyramid of
  // view is a pyramid in space as well.  R, U, F: the view's axes; fx, fy:
  // its projection scales.
  _viewPlanes(R, U, F, O, P, invOw, fx, fy, near) {
    const row = (A) => [A[0] - A[3] * invOw * O[0], A[1] - A[3] * invOw * O[1], A[2] - A[3] * invOw * O[2]];
    const x = row(R), y = row(U), z = row(F);
    const plane = (a, d) => [a[0], a[1], a[2], d - (a[0] * P[0] + a[1] * P[1] + a[2] * P[2]) + 0.05 * Math.hypot(a[0], a[1], a[2])];
    const mix = (v, f) => [z[0] + f * v[0], z[1] + f * v[1], z[2] + f * v[2]];
    return [plane(z, -near), plane(mix(x, -fx), 0), plane(mix(x, fx), 0), plane(mix(y, -fy), 0), plane(mix(y, fy), 0)];
  }

  // The same for a shadow map: the box of space it covers, round the player
  // and along the direction l of the light (as shadowBasis and shadowCoord in
  // wgsl.js), with some room for that direction being known only roughly
  // (see _sunDir) and for the shader's own rounding.
  _cascadePlanes(l, P, r, depth) {
    const up = Math.abs(l[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    let ex = [up[1] * l[2] - up[2] * l[1], up[2] * l[0] - up[0] * l[2], up[0] * l[1] - up[1] * l[0]];
    const n = Math.hypot(ex[0], ex[1], ex[2]);
    ex = [ex[0] / n, ex[1] / n, ex[2] / n];
    const ey = [l[1] * ex[2] - l[2] * ex[1], l[2] * ex[0] - l[0] * ex[2], l[0] * ex[1] - l[1] * ex[0]];
    const dot = (a) => a[0] * P[0] + a[1] * P[1] + a[2] * P[2];
    const texel = 2 * r / SHADOW_SIZE;
    const cx = Math.floor(dot(ex) / texel) * texel, cy = Math.floor(dot(ey) / texel) * texel, cl = dot(l);
    const m = r + 2 * texel + 1 + 0.004 * depth, dm = depth + 1;
    return [
      [ex[0], ex[1], ex[2], m - cx], [-ex[0], -ex[1], -ex[2], m + cx],
      [ey[0], ey[1], ey[2], m - cy], [-ey[0], -ey[1], -ey[2], m + cy],
      [l[0], l[1], l[2], dm - cl], [-l[0], -l[1], -l[2], dm + cl],
    ];
  }

  // The direction of the light at time t, or null if it is not known.  The
  // light is whatever the scene's envSun says, which only the GPU can work
  // out: so a stretch of it round the player's time is drawn into a strip of
  // pixels and read back, a few frames late, and looked up here.  Where it
  // jumps (the moon taking over from the sun) it counts as unknown, and the
  // shadow maps are then drawn in full, as they are until the first strip
  // has arrived.
  _sunDir(sc, t) {
    const s = sc.sun;
    if (!s) return null;
    const tb = s.table;
    if (!tb || t < tb.t0 + 8 * tb.dt || t > tb.t0 + (tb.n - 9) * tb.dt) this._sunRequest(sc, t);
    if (!tb) return null;
    const f = (t - tb.t0) / tb.dt, i = Math.floor(f), u = f - i;
    if (i < 0 || i >= tb.n - 1) return null;
    const d = tb.dirs, a = i * 3, b = a + 3;
    if (!(d[a] * d[b] + d[a + 1] * d[b + 1] + d[a + 2] * d[b + 2] > 0.9995)) return null;
    const v = [d[a] + (d[b] - d[a]) * u, d[a + 1] + (d[b + 1] - d[a + 1]) * u, d[a + 2] + (d[b + 2] - d[a + 2]) * u];
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  // Resolves when what has been drawn is done and a read-back of the light's
  // direction, if one is on its way, has arrived (for stills and for tools:
  // the next frame then leaves out of the shadow maps what it can).
  async settle() {
    await this.device.queue.onSubmittedWorkDone();
    const s = this.scene?.sun;
    for (let i = 0; i < 100 && s && s.pending; i++) await new Promise((r) => setTimeout(r, 10));
  }

  _sunRequest(sc, t) {
    const s = sc.sun, d = this.device;
    if (s.pending) return;
    s.pending = true;
    const n = SUN_SAMPLES, dt = SUN_STEP, t0 = t - n * dt / 2;
    const g = this.sunGlobals || (this.sunGlobals = new Float32Array(GLOBALS));
    g.set(this.globals);
    g[19] = t0; g[42] = dt; // (the strip's first moment in place of the player's, and its step)
    d.queue.writeBuffer(s.globals, 0, g);
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: s.view, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(s.pipe);
    pass.setBindGroup(0, s.bg);
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer({ texture: s.tex }, { buffer: s.read, bytesPerRow: n * 8 }, [n, 1]);
    d.queue.submit([enc.finish()]);
    s.read.mapAsync(GPUMapMode.READ).then(() => {
      const h = new Uint16Array(s.read.getMappedRange());
      const dirs = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) dirs[i * 3 + k] = fromHalf(h[i * 4 + k]);
      s.read.unmap();
      s.table = { t0, dt, n, dirs };
      s.pending = false;
    }, () => { s.pending = false; });
  }

  // Works out which chunks of tetrahedra the slice can touch.  A chunk is a
  // box in (x, y, z, t); the slice is the hyperplane through the player with
  // normal O.  The box meets it exactly when the distance of its centre from
  // the hyperplane is no more than the box's extent along O.  For a periodic
  // scene the same test is solved for the repeat number k.  Returns
  // { lists, blend }: draw lists [main, shadow cascade 0, 1, 2], each
  // [opaque, additive], and the see-through chunks one by one with their
  // distance.
  // shadowPlanes: for each shadow map, the planes that bound what can cast a
  // shadow into it (see _cascadePlanes), or null where that is not known and
  // distance has to do instead.
  _dynDraws(cam, sc, radii, fx, fy, near, shadowPlanes) {
    // the view, the three shadow maps, and everything (for the reflection picture, which looks all ways)
    const out = [0, 1, 2, 3, 4].map(() => [new DrawList(), new DrawList()]);
    const wantAll = sc.reflections;
    const blend = [];
    const ch = sc.chunks;
    this.info.tets = 0;
    if (!ch.count) return { lists: out, blend };
    const def = sc.def, C = cam.C, O = cam.O, P = cam.P;
    const viewDist = def.viewDistance ?? 1500;
    const sinTilt = Math.hypot(O[0], O[1], O[2]);
    const period = def.period || 0, now = P[3];
    // repeats that can fall inside the view at all: a point of the slice at
    // distance d is at most d * sin(tilt) / C away in time
    let k0 = 0, k1 = 0;
    if (period > 0) {
      const span = viewDist * sinTilt / C + 0.05;
      k0 = Math.ceil((now - span - sc.tMax) / period);
      k1 = Math.floor((now + span - sc.tMin) / period);
      if (k1 - k0 + 1 > MAX_COPIES) {
        k0 = Math.round(now / period - 0.5) - (MAX_COPIES >> 1) + 1;
        k1 = k0 + MAX_COPIES - 1;
      }
    }
    for (let k = k0; k <= k1; k++) this.drawData[(k - k0) * SLOT / 4] = now - k * period;
    this.device.queue.writeBuffer(this.drawBuf, 0, this.drawData, 0, (k1 - k0 + 1) * SLOT / 4);

    const ax = Math.abs(O[0]), ay = Math.abs(O[1]), az = Math.abs(O[2]), at = Math.abs(O[3]) * C;
    const step = O[3] * C * period; // how far one repeat moves a chunk along O
    const reach = [viewDist, 3 * radii[0], 1.5 * radii[1], sc.cascades > 2 ? 1.5 * radii[2] : 0];
    const B = ch.box, R = ch.range;
    // The view's pyramid, as planes over (x, y, z, C t) measured from the
    // player: [a.x, a.y, a.z, a.t, d], inside where a . delta + d >= 0.  A
    // chunk is a box in space and a stretch of time; if all of that lies
    // outside one of the planes, so does the part of it in the slice.
    const planes = [];
    if (this.cull & 4) {
      const along = (f, V) => {
        const a = [cam.F[0] + f * V[0], cam.F[1] + f * V[1], cam.F[2] + f * V[2], cam.F[3] + f * V[3]];
        return [...a, 0.05 * Math.hypot(...a)];
      };
      planes.push([cam.F[0], cam.F[1], cam.F[2], cam.F[3], 0.05 - near], along(-fx, cam.R), along(fx, cam.R), along(-fy, cam.U), along(fy, cam.U));
    }
    const tm = (o) => (B[o] + B[o + 1]) / 2;
    const seen = (o, dx, dy, dz, dt) => {
      const ht = (B[o + 1] - B[o]) / 2 * C;
      for (const p of planes) {
        if (p[0] * dx + p[1] * dy + p[2] * dz + p[3] * dt + Math.abs(p[0]) * B[o + 5] + Math.abs(p[1]) * B[o + 6] + Math.abs(p[2]) * B[o + 7] + Math.abs(p[3]) * ht + p[4] < 0) return false;
      }
      return true;
    };
    let blendTets = 0;
    for (let i = 0; i < ch.count; i++) {
      const o = i * 9;
      const dx = B[o + 2] - P[0], dy = B[o + 3] - P[1], dz = B[o + 4] - P[2];
      const centre = Math.hypot(dx, dy, dz), dist = centre - B[o + 8];
      if (dist > viewDist || dist > ch.near[i] * this.detail) continue; // (near: detail that is drawn only from close by)
      const d0 = O[0] * dx + O[1] * dy + O[2] * dz + O[3] * C * ((B[o] + B[o + 1]) / 2 - now);
      const ext = ax * B[o + 5] + ay * B[o + 6] + az * B[o + 7] + at * (B[o + 1] - B[o]) / 2 + 0.02;
      let ka = k0, kb = k1;
      if (Math.abs(step) > 1e-9) {
        const a = (-ext - d0) / step, b = (ext - d0) / step;
        ka = Math.max(k0, Math.ceil(Math.min(a, b)));
        kb = Math.min(k1, Math.floor(Math.max(a, b)));
      } else if (Math.abs(d0) > ext) {
        continue;
      }
      const layer = ch.layer[i], first = R[i * 2], count = R[i * 2 + 1];
      // (a chunk's run of numbers is rounded up to whole blocks: that much lies between neighbours anyway)
      const bridge = ch.near[i] < Infinity ? BLOCK - 1 : BRIDGE;
      // which shadow maps it can cast into: wherever the slice finds it, that is inside its box
      const casts = [false, false, false, false];
      if (layer === 0) {
        for (let c = 1; c <= 3; c++) {
          const pl = shadowPlanes[c - 1];
          if (!pl) { casts[c] = dist < reach[c]; continue; }
          let inside = true;
          for (const p of pl) {
            if (p[0] * B[o + 2] + p[1] * B[o + 3] + p[2] * B[o + 4] + Math.abs(p[0]) * B[o + 5] + Math.abs(p[1]) * B[o + 6] + Math.abs(p[2]) * B[o + 7] + p[3] < 0) { inside = false; break; }
          }
          casts[c] = inside;
        }
      }
      for (let k = ka; k <= kb; k++) {
        if (ch.near[i] < Infinity) {
          // Detail that is drawn only from near by: near to where the slice
          // finds the thing, that is, somewhere along this chunk's stretch of
          // its path (all but straight within a chunk).
          const Q = ch.path, q = i * 7, shift = (k * period - now) * C * O[3];
          const da = O[0] * (Q[q] - P[0]) + O[1] * (Q[q + 1] - P[1]) + O[2] * (Q[q + 2] - P[2]) + B[o] * C * O[3] + shift;
          const db = O[0] * (Q[q + 3] - P[0]) + O[1] * (Q[q + 4] - P[1]) + O[2] * (Q[q + 5] - P[2]) + B[o + 1] * C * O[3] + shift;
          const u = da === db ? 0.5 : Math.min(1, Math.max(0, da / (da - db)));
          const far = Math.hypot(Q[q] + (Q[q + 3] - Q[q]) * u - P[0], Q[q + 1] + (Q[q + 4] - Q[q + 1]) * u - P[1], Q[q + 2] + (Q[q + 5] - Q[q + 2]) * u - P[2]) - Q[q + 6];
          if (far > ch.near[i] * this.detail) continue;
        }
        const inView = seen(o, dx, dy, dz, (tm(o) + k * period - now) * C);
        if (layer === 2) {
          if (inView) {
            blend.push({ slot: k - k0, first, count, dist: centre });
            blendTets += count;
          }
          continue;
        }
        if (inView) out[0][layer].add(k - k0, first, count, bridge);
        if (wantAll) out[4][layer].add(k - k0, first, count, bridge);
        if (layer === 0) {
          for (let c = 1; c <= 3; c++) if (casts[c]) out[c][0].add(k - k0, first, count, bridge);
        }
      }
    }
    this.info.tets = out[0][0].tets + out[0][1].tets + blendTets;
    return { lists: out, blend };
  }

  // The frame in which the reflection picture is drawn: three 4D unit
  // vectors inside the slice, which stay put when the player turns (the
  // picture is brought up to date one side per frame).  The second is as
  // near to straight up as the slice allows.
  _probeAxes(O) {
    const strip = (v, basis) => {
      let w = v.slice();
      for (const b of basis) {
        const d = f4.dot(w, b);
        w = w.map((x, k) => x - d * b[k]);
      }
      return w;
    };
    const found = [];
    for (const c of [[0, 0, 1, 0], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1]]) {
      const w = strip(c, [O, ...found]);
      if (Math.hypot(w[0], w[1], w[2], w[3]) > 0.3) found.push(f4.norm(w));
      if (found.length === 2) break;
    }
    const [y, x] = found;
    // the third, with the same handedness as the camera's own axes
    const z = f4.norm(f4.cross(x, y, O)).map((v) => -v);
    return [x, y, z];
  }

  // cam: { R, U, F: camera axes as 4-vectors; O: the slice's normal; P: [x, y, z, t]; C; fovY; time;
  //        timeTint: the colouring by time: 0 none, 1 slight, 2 full; timeCast: the strength of the slight one (1 is usual);
  //        still: true for a single picture (everything is brought up to date at once) }
  render(cam) {
    const sc = this.scene;
    if (!sc || !this.size[0]) return;
    const d = this.device, def = sc.def;
    const [w, h] = this.size;
    const g = this.globals;
    g.set(cam.R, 0); g.set(cam.U, 4); g.set(cam.F, 8); g.set(cam.O, 12); g.set(cam.P, 16);
    const fy = 1 / Math.tan(cam.fovY / 2);
    g[20] = fy * h / w; g[21] = fy; g[22] = def.near ?? 0.1; g[23] = cam.C;
    const ow = cam.O[3];
    // Static geometry is stretched by 1 / O.w along the direction of the
    // tilt; the clamp keeps that finite at a tilt of exactly 90 degrees.
    g[24] = 1 / ((ow < 0 ? -1 : 1) * Math.max(Math.abs(ow), 2e-3));
    g[25] = ow < 0 ? -1 : 1;
    g[26] = def.skyDistance ?? 2000;
    g[27] = def.exposure ?? 1;
    const shadows = sc.cascades > 0;
    const radii = def.shadowRadii ?? [35, 260];
    g[28] = shadows ? 1 : 0; g[29] = radii[0]; g[30] = radii[1]; g[31] = def.shadowDepth ?? 800;
    g[32] = w; g[33] = h; g[34] = 1 / w; g[35] = 1 / h;
    g[36] = cam.time; g[37] = def.period || 0; g[38] = SHADOW_SIZE;
    g[39] = cam.timeTint === 2 ? -1 : cam.timeTint === 1 ? Math.max(0, cam.timeCast ?? 1) : 0;
    g[40] = radii[2] ?? 0; g[41] = sc.cascades; g[42] = 0; g[43] = 0;
    g[44] = sc.reflections ? 1 : 0; g[45] = 0; g[46] = 0; g[47] = 0;
    let axes = null;
    if (sc.reflections) {
      axes = this._probeAxes(cam.O);
      g.set(axes[0], 48); g.set(axes[1], 52); g.set(axes[2], 56);
    }
    d.queue.writeBuffer(this.globalsBuf, 0, g);

    // What each pass draws.  Each has its own view volume, and static
    // geometry that lies wholly outside it is left out (this.cull = false
    // draws everything in every pass, for comparison).
    const cull = this.cull;
    const sun = (cull & 10) && sc.cascades ? this._sunDir(sc, cam.P[3]) : null;
    const cascadePlanes = [0, 1, 2].map((c) => (c < sc.cascades ? (sun ? this._cascadePlanes(sun, cam.P, radii[c], g[31]) : null) : [[0, 0, 0, -1]]));
    const { lists: [draws, s1, s2, s3, allDyn], blend: blendDyn } = this._dynDraws(cam, sc, radii, g[20], g[21], g[22], cull & 8 ? cascadePlanes : [null, null, null]);
    const shadowDraws = [s1, s2, s3];
    const set = this._staticSet(cam, sc, g[24]);
    const view = this._staticDraws(sc, set, cull & 1 ? this._viewPlanes(cam.R, cam.U, cam.F, cam.O, cam.P, g[24], g[20], g[21], g[22]) : [], 7, cam.P, this.nearFirst);
    this.info.triangles = view.triangles;
    const enc = d.createCommandEncoder();
    // what is handed to the GPU, over all passes: draw calls, triangles and tetrahedra
    let nDraws = 0, nTris = 0, nTets = 0;
    const drawStatic = (pass, pipes, bg, layer, ranges, batches) => {
      if (!ranges.length && !batches.length) return;
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, sc.vbuf);
      pass.setIndexBuffer(sc.ibuf, 'uint32');
      if (ranges.length) {
        pass.setPipeline(pipes.static[layer]);
        for (const r of ranges) {
          pass.drawIndexed(r.count, 1, r.first);
          nDraws++; nTris += r.count / 3;
        }
      }
      if (batches.length) {
        pass.setPipeline(pipes.inst[layer]);
        pass.setVertexBuffer(1, sc.instBuf);
        for (const b of batches) {
          pass.drawIndexed(b.count, b.instances, b.first, 0, b.firstInstance);
          nDraws++; nTris += b.count / 3 * b.instances;
        }
      }
    };
    const drawDyn = (pass, pipe, bg, list) => {
      if (!list.tets) return;
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      list.slots.forEach((ranges, slot) => {
        pass.setBindGroup(1, sc.bgDyn, [slot * SLOT]);
        for (const r of ranges) {
          pass.draw(4, r.count, 0, r.first);
          nDraws++; nTets += r.count;
        }
      });
    };

    for (let c = 0; c < sc.cascades; c++) {
      const pass = enc.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowLayers[c], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      const lit = this._staticDraws(sc, set, (cull & 2 && cascadePlanes[c]) || [], 1, cam.P);
      drawStatic(pass, sc.shadowPipes, sc.bgShadow[c], 0, lit.ranges[0], lit.groups[0]);
      drawDyn(pass, sc.shadowPipes.dyn[0], sc.bgShadow[c], shadowDraws[c][0]);
      pass.end();
    }

    // The reflection picture: normally one side a frame, in turn; all six for
    // a still, for a scene's first frame, and when its axes have jumped.
    let probeDraws = 0, probeSides = 0, probeTris = 0, probeTets = 0;
    if (sc.reflections) {
      const p = this.probe, before = nDraws, trisBefore = nTris, tetsBefore = nTets;
      const jumped = sc.probeAxes && sc.probeAxes.some((a, i) => f4.dot(a, axes[i]) < 0.95);
      const all = cam.still || sc.probeAge === 0 || jumped;
      sc.probeAxes = axes;
      const [X, Y, Z] = axes, neg = (v) => v.map((x) => -x);
      // right, up and forward for the sides +X, -X, +Y, -Y, +Z, -Z of a cube map
      const SIDES = [[neg(Z), Y, X], [Z, Y, neg(X)], [X, neg(Z), Y], [X, Z, neg(Y)], [X, Y, Z], [neg(X), Y, neg(Z)]];
      const pg = p.globals;
      for (let side = 0; side < 6; side++) {
        if (!all && side !== sc.probeAge % 6) continue;
        pg.set(g);
        pg.set(SIDES[side][0], 0); pg.set(SIDES[side][1], 4); pg.set(SIDES[side][2], 8);
        pg[20] = 1; pg[21] = 1;
        pg[32] = PROBE_SIZE; pg[33] = PROBE_SIZE; pg[34] = 1 / PROBE_SIZE; pg[35] = 1 / PROBE_SIZE;
        pg[44] = 0; pg[45] = 1;
        d.queue.writeBuffer(p.bufs[side], 0, pg);
        const bg = sc.bgProbe[side], pipes = sc.probePipes;
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: p.faces[side], clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
          depthStencilAttachment: { view: p.depth, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        const S = SIDES[side];
        const seen = this._staticDraws(sc, set, cull & 16 ? this._viewPlanes(S[0], S[1], S[2], cam.O, cam.P, g[24], 1, 1, g[22]) : [], 3, cam.P);
        drawStatic(pass, pipes, bg, 0, seen.ranges[0], seen.groups[0]);
        drawDyn(pass, pipes.dyn[0], bg, allDyn[0]);
        pass.setPipeline(pipes.sky);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        drawStatic(pass, pipes, bg, 1, seen.ranges[1], seen.groups[1]);
        drawDyn(pass, pipes.dyn[1], bg, allDyn[1]);
        pass.end();
        probeSides++;
      }
      sc.probeAge++;
      probeDraws = nDraws - before; probeTris = nTris - trisBefore; probeTets = nTets - tetsBefore;
    }

    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.hdrMS, resolveTarget: this.hdr, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'discard' }],
        depthStencilAttachment: { view: this.depthMS, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      const pipes = sc.pipes, bg = sc.bgMain;
      drawStatic(pass, pipes, bg, 0, view.ranges[0], view.groups[0]);
      drawDyn(pass, pipes.dyn[0], bg, draws[0]);
      pass.setPipeline(pipes.sky);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      // See-through geometry, from the furthest to the nearest.  (An
      // instanced group goes by the middle of all its copies, which are not
      // put in order among themselves.)
      const seeThrough = [...view.ranges[2], ...view.groups[2], ...blendDyn].sort((a, b) => b.dist - a.dist);
      let bound = '';
      for (const r of seeThrough) {
        const kind = r.slot !== undefined ? 'dyn' : r.group ? 'inst' : 'static';
        if (bound !== kind) {
          bound = kind;
          pass.setPipeline(pipes[kind][2]);
          pass.setBindGroup(0, bg);
          if (kind !== 'dyn') {
            pass.setVertexBuffer(0, sc.vbuf);
            pass.setIndexBuffer(sc.ibuf, 'uint32');
            if (kind === 'inst') pass.setVertexBuffer(1, sc.instBuf);
          }
        }
        if (kind === 'dyn') {
          pass.setBindGroup(1, sc.bgDyn, [r.slot * SLOT]);
          pass.draw(4, r.count, 0, r.first);
          nTets += r.count;
        } else if (kind === 'inst') {
          pass.drawIndexed(r.group.count, r.group.instances, r.group.first, 0, r.group.firstInstance);
          nTris += r.group.count / 3 * r.group.instances;
        } else {
          pass.drawIndexed(r.count, 1, r.first);
          nTris += r.count / 3;
        }
        nDraws++;
      }
      drawStatic(pass, pipes, bg, 1, view.ranges[1], view.groups[1]);
      drawDyn(pass, pipes.dyn[1], bg, draws[1]);
      pass.end();
    }

    // bloom chain, then composite onto the canvas
    const pd = this.postData;
    const exposure = def.exposure ?? 1;
    const passes = this.postPasses;
    for (let i = 0; i <= passes.length; i++) {
      const o = i * SLOT / 4;
      const p = passes[i];
      pd[o] = 1 / (p ? p.sw : w); pd[o + 1] = 1 / (p ? p.sh : h);
      pd[o + 2] = exposure; pd[o + 3] = def.bloom ?? 0.35; pd[o + 4] = def.bloomThreshold ?? 1.0; pd[o + 5] = this.frame % 64;
    }
    d.queue.writeBuffer(this.postBuf, 0, pd, 0, (passes.length + 1) * SLOT / 4);
    passes.forEach((p, i) => {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: p.target, clearValue: [0, 0, 0, 1], loadOp: p.load ? 'load' : 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(p.pipe);
      pass.setBindGroup(0, p.bg, [i * SLOT]);
      pass.draw(3);
      pass.end();
    });
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(this.pipeComposite);
      pass.setBindGroup(0, this.bgComposite, [passes.length * SLOT]);
      pass.draw(3);
      pass.end();
    }
    d.queue.submit([enc.finish()]);
    this.info.draws = nDraws;
    // (a still brings all six sides of the reflection picture up to date, a running frame one)
    const spare = probeSides > 1 ? (probeSides - 1) / probeSides : 0;
    this.info.liveDraws = Math.round(nDraws - probeDraws * spare);
    // The work of one running frame over all its passes (the view, the shadow
    // maps, one side of the reflection picture): see tools/cost.mjs.
    this.info.frame = { triangles: Math.round(nTris - probeTris * spare), tets: Math.round(nTets - probeTets * spare), draws: this.info.liveDraws };
    this.frame++;
  }
}
