// The scene builder, run in a worker: the page stays alive while a scene's
// geometry is made, and can show how far the work has got.
//
//   in:   { id, flat }       the scene's file name without ".js"; flat: the
//                            ground is level where the scene has no `ground`
//   out:  { ready: true }    once, when the worker can take a job
//         { progress }       now and then: bytes of geometry made so far
//         { data, solids, buildMs }   what SceneBuilder.finalize returns, and
//                            the collision structure (see Colliders.revive)
//      or { error }          the message of whatever the scene's code threw

import { SceneBuilder } from './builder.js';
import { Colliders } from './collide.js';

self.onmessage = async (e) => {
  const { id, flat } = e.data;
  try {
    const def = (await import(`./scenes/${id}.js`)).default;
    const t0 = performance.now();
    const builder = new SceneBuilder();
    let last = 0;
    builder.onProgress = (bytes) => {
      const now = performance.now();
      if (now - last > 30) { last = now; self.postMessage({ progress: bytes }); }
    };
    def.build(builder);
    const data = builder.finalize();
    const buildMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const onGround = def.ground || (flat ? () => 0 : null);
    const solids = def.solid === false ? null : new Colliders(data.solidTris, onGround);
    data.stats.solidTriangles = solids ? solids.count : 0;
    data.stats.solidMs = Math.round(performance.now() - t1);
    data.solidTris = null; // (only the structure made from them is needed now)
    // the big arrays are handed over, not copied
    const buffers = new Set();
    const collect = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 4) return;
      if (ArrayBuffer.isView(v)) buffers.add(v.buffer);
      else if (!(v instanceof Map)) for (const x of Array.isArray(v) ? v : Object.values(v)) collect(x, depth + 1);
    };
    collect(data, 0);
    if (solids) { buffers.add(solids.t.buffer); buffers.add(solids.zr.buffer); }
    self.postMessage({ data, solids: solids && { ...solids }, buildMs }, [...buffers]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
self.postMessage({ ready: true });
