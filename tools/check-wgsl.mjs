// Validates the assembled shader of each scene with naga, the WGSL compiler
// Firefox uses, as a cross-check on Chromium's (which tools/shot.mjs runs).
//
//   node tools/check-wgsl.mjs [scene ...]      (default: every scene file)
//
// Needs the `naga` command (cargo install naga-cli).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Renderer } from '../src/renderer.js';
import { SceneBuilder } from '../src/builder.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/scenes');
const ids = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js').map((f) => f.slice(0, -3));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tilt4d-wgsl-'));
let failed = false;
for (const id of ids) {
  const def = (await import(pathToFileURL(path.join(dir, id + '.js')))).default;
  // (the scene is built, because its textures are declared in the shader)
  const builder = new SceneBuilder();
  def.build(builder);
  const { code, hookLine } = Renderer.shaderSource(def, builder.textures);
  const file = path.join(tmp, id + '.wgsl');
  writeFileSync(file, code);
  const r = spawnSync('naga', [file], { encoding: 'utf8' });
  if (r.error) {
    console.log('could not run naga: ' + r.error.message);
    process.exit(2);
  }
  if (r.status === 0) {
    console.log(`${id}: ok`);
  } else {
    failed = true;
    console.log(`${id}: FAILED (the scene's own WGSL starts at line ${hookLine + 1} of ${file})`);
    console.log((r.stderr || r.stdout).trim());
  }
}
process.exit(failed ? 1 : 0);
