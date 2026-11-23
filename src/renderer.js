// WebGPU renderer.  Per frame:
//   1. two or three shadow cascades (depth only)
//   2. for scenes that ask for reflections: one side of a picture of the
//      scene all round the player (a cube map), which glossy surfaces mirror
//   3. the scene into a multisampled HDR target: static geometry, sliced
//      tetrahedra, sky, then see-through geometry from the furthest to the
//      nearest, then additive geometry
//   4. bloom and tone mapping onto the canvas

import { COMMON, SCENE_PIPELINES, POST, DEFAULT_SURFACE, DEFAULT_REFLECT, DEFAULT_CUTOUT, textureDecls } from './wgsl.js';
import { dayNightEnv } from './env.js';
import { STATIC_STRIDE, INSTANCE_STRIDE, MAX_TEXTURES, toHalf } from './builder.js';
import { f4 } from './math.js';

const HDR = 'rgba16float';
const DEPTH = 'depth32float';
const SAMPLES = 4;
const SHADOW_SIZE = 2048;
const PROBE_SIZE = 256;
const GLOBALS = 60; // floats in the Globals uniform (see wgsl.js)
const MAX_COPIES = 24;
const SLOT = 256;
const BLOOM_LEVELS = 5;
const ENV_HOOKS = ['envSun', 'envSky', 'envAmbient', 'envFog'];

// A list of instance ranges to draw, one list per time-repeat slot.  Chunks
// are visited in buffer order; ones that are neighbours, or separated only by
// a small gap, merge into a single draw call (tetrahedra in the gap do not
// meet the slice, so the vertex shader throws them away).
const BRIDGE = 768;
class DrawList {
  constructor() { this.slots = []; this.tets = 0; }
  add(slot, first, count) {
    const list = this.slots[slot] || (this.slots[slot] = []);
    const last = list[list.length - 1];
    if (last && first - (last.first + last.count) <= BRIDGE) {
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
    this.info = { tets: 0, triangles: 0, draws: 0, liveDraws: 0 };
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
  async setScene(data, def) {
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
      dynTets: buffer(data.tets, U.STORAGE),
      staticAlways: data.staticAlways,
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
        { binding: 1, resource: { buffer: next.dynTets } },
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
    if (old) for (const b of [old.vbuf, old.ibuf, old.instBuf, old.dynVerts, old.dynTets, ...old.textures]) b?.destroy();
  }

  // Static geometry to draw, as index ranges per layer: everything without a
  // time window, plus those windowed pieces whose window the slice reaches
  // somewhere within their bounding box.  (The time at which the slice meets
  // a static point is linear in its position, so over a box it spans a simple
  // interval.)  Ranges separated by only a small gap are joined, since the
  // shader discards out-of-window pixels anyway.  See-through pieces (layer
  // 2) are listed one by one with their distance, to be drawn in order.
  // Instanced groups are listed likewise, each of them unless it has one time
  // window for all its copies that the slice cannot reach.
  // Returns { ranges, groups }, each a list per layer.
  _staticDraws(cam, sc, invOw) {
    const out = [[], [], []];
    for (let layer = 0; layer < 3; layer++) {
      const a = sc.staticAlways[layer];
      if (a && a.count) out[layer].push({ first: a.first, count: a.count });
    }
    const T = sc.staticTimed, B = T.box, R = T.range, O = cam.O, P = cam.P, C = cam.C;
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
    const groups = [[], [], []];
    for (let layer = 0; layer < 3; layer++) {
      for (const g of sc.instanced[layer]) {
        if ((g.from > -1e29 || g.to < 1e29) && !reached(g.box, 0, g.from, g.to, g.period)) continue;
        groups[layer].push(layer === 2 ? { group: g, dist: Math.hypot(g.box[0] - P[0], g.box[1] - P[1], g.box[2] - P[2]) } : g);
      }
    }
    for (let i = 0; i < T.count; i++) {
      const o = i * 9;
      if (!reached(B, o + 3, B[o], B[o + 1], B[o + 2])) continue;
      const list = out[T.layer[i]], last = list[list.length - 1];
      const first = R[i * 2], count = R[i * 2 + 1];
      if (T.layer[i] === 2) list.push({ first, count, dist: Math.hypot(B[o + 3] - P[0], B[o + 4] - P[1], B[o + 5] - P[2]) });
      else if (last && first - (last.first + last.count) <= 600) last.count = first + count - last.first;
      else list.push({ first, count });
    }
    this.info.triangles = 0;
    for (const list of out) for (const r of list) this.info.triangles += r.count / 3;
    for (const list of groups) for (const e of list) { const g = e.group || e; this.info.triangles += g.count / 3 * g.instances; }
    return { ranges: out, groups };
  }

  // Works out which chunks of tetrahedra the slice can touch.  A chunk is a
  // box in (x, y, z, t); the slice is the hyperplane through the player with
  // normal O.  The box meets it exactly when the distance of its centre from
  // the hyperplane is no more than the box's extent along O.  For a periodic
  // scene the same test is solved for the repeat number k.  Returns
  // { lists, blend }: draw lists [main, shadow cascade 0, 1, 2], each
  // [opaque, additive], and the see-through chunks one by one with their
  // distance.
  _dynDraws(cam, sc, radii) {
    const out = [0, 1, 2, 3].map(() => [new DrawList(), new DrawList()]);
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
    let blendTets = 0;
    for (let i = 0; i < ch.count; i++) {
      const o = i * 9;
      const dx = B[o + 2] - P[0], dy = B[o + 3] - P[1], dz = B[o + 4] - P[2];
      const centre = Math.hypot(dx, dy, dz), dist = centre - B[o + 8];
      if (dist > viewDist) continue;
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
      for (let k = ka; k <= kb; k++) {
        if (layer === 2) {
          blend.push({ slot: k - k0, first, count, dist: centre });
          blendTets += count;
          continue;
        }
        out[0][layer].add(k - k0, first, count);
        if (layer === 0) {
          for (let c = 1; c <= 3; c++) if (dist < reach[c]) out[c][0].add(k - k0, first, count);
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

    const { lists: [draws, ...shadowDraws], blend: blendDyn } = this._dynDraws(cam, sc, radii);
    const { ranges: staticDraws, groups } = this._staticDraws(cam, sc, g[24]);
    const enc = d.createCommandEncoder();
    let nDraws = 0;
    const drawStatic = (pass, pipes, bg, layer, ranges, batches) => {
      if (!ranges.length && !batches.length) return;
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, sc.vbuf);
      pass.setIndexBuffer(sc.ibuf, 'uint32');
      if (ranges.length) {
        pass.setPipeline(pipes.static[layer]);
        for (const r of ranges) {
          pass.drawIndexed(r.count, 1, r.first);
          nDraws++;
        }
      }
      if (batches.length) {
        pass.setPipeline(pipes.inst[layer]);
        pass.setVertexBuffer(1, sc.instBuf);
        for (const b of batches) {
          pass.drawIndexed(b.count, b.instances, b.first, 0, b.firstInstance);
          nDraws++;
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
          nDraws++;
        }
      });
    };

    for (let c = 0; c < sc.cascades; c++) {
      const pass = enc.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowLayers[c], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      drawStatic(pass, sc.shadowPipes, sc.bgShadow[c], 0, staticDraws[0], groups[0]);
      drawDyn(pass, sc.shadowPipes.dyn[0], sc.bgShadow[c], shadowDraws[c][0]);
      pass.end();
    }

    // The reflection picture: normally one side a frame, in turn; all six for
    // a still, for a scene's first frame, and when its axes have jumped.
    let probeDraws = 0, probeSides = 0;
    if (sc.reflections) {
      const p = this.probe, before = nDraws;
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
        drawStatic(pass, pipes, bg, 0, staticDraws[0], groups[0]);
        drawDyn(pass, pipes.dyn[0], bg, draws[0]);
        pass.setPipeline(pipes.sky);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        drawStatic(pass, pipes, bg, 1, staticDraws[1], groups[1]);
        drawDyn(pass, pipes.dyn[1], bg, draws[1]);
        pass.end();
        probeSides++;
      }
      sc.probeAge++;
      probeDraws = nDraws - before;
    }

    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.hdrMS, resolveTarget: this.hdr, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'discard' }],
        depthStencilAttachment: { view: this.depthMS, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      const pipes = sc.pipes, bg = sc.bgMain;
      drawStatic(pass, pipes, bg, 0, staticDraws[0], groups[0]);
      drawDyn(pass, pipes.dyn[0], bg, draws[0]);
      pass.setPipeline(pipes.sky);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      // See-through geometry, from the furthest to the nearest.  (An
      // instanced group goes by the middle of all its copies, which are not
      // put in order among themselves.)
      const seeThrough = [...staticDraws[2], ...groups[2], ...blendDyn].sort((a, b) => b.dist - a.dist);
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
        } else if (kind === 'inst') {
          pass.drawIndexed(r.group.count, r.group.instances, r.group.first, 0, r.group.firstInstance);
        } else {
          pass.drawIndexed(r.count, 1, r.first);
        }
        nDraws++;
      }
      drawStatic(pass, pipes, bg, 1, staticDraws[1], groups[1]);
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
    this.info.liveDraws = probeSides > 1 ? Math.round(nDraws - probeDraws * (probeSides - 1) / probeSides) : nDraws;
    this.frame++;
  }
}
