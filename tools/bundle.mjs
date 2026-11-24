// Packs the whole demo into a single HTML file that needs nothing else: the
// stylesheet and every script, all the scenes included, go into the page
// itself, minified.  So are the shaders, which are text inside the scripts
// (see minify-shaders.mjs), and the page's own markup.
//
//   node tools/bundle.mjs [--out dist/index.html] [--no-minify]
//
// The file can be put on any web server under any name, or opened straight
// from disk.  It takes the same address parameters as the page it is made
// from (?scene=reef and so on).
//
// Needs esbuild (npm install).

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { minifyShaderStrings } from './minify-shaders.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--no-minify') args.minify = false;
  else if (a === '--out') args.out = process.argv[++i];
  else { console.log(`unknown argument ${a}\nusage: node tools/bundle.mjs [--out file.html] [--no-minify]`); process.exit(2); }
}
const out = path.resolve(args.out || path.join(ROOT, 'dist', 'index.html'));
const minify = args.minify !== false;

// The scenes are loaded on demand with import(): bundled, each of them becomes
// a part of the script that is not run until it is asked for.
const options = { bundle: true, minify, write: false, legalComments: 'none', logLevel: 'warning', target: 'es2022' };
// The shader code inside each script is minified before the script itself is.
const shaders = {
  name: 'shaders',
  setup(b) {
    b.onLoad({ filter: /\.js$/ }, async (file) => {
      const rel = path.relative(ROOT, file.path);
      const contents = minifyShaderStrings(await readFile(file.path, 'utf8'), (line, text) => {
        console.log(`note: ${rel}:${line} looks like shader code but is not marked /* wgsl */, so it is not minified ("${text.replace(/\s+/g, ' ')}")`);
      });
      return { contents, loader: 'js' };
    });
  },
};
// The one script serves two masters: the page, and the worker in which the
// page has its scenes built (src/build-worker.js), which is started from a
// copy of this same script's text.  TILT4D_ONE_FILE tells the page so.  It is
// written as a plain script, not a module, because a page opened from disk
// cannot start a worker from a module in every browser.  (The page's own
// way to its worker's file, by import.meta, is not used in this build: hence
// the silenced warning.)
const entry = "if (typeof document === 'undefined') import('./src/build-worker.js'); else import('./src/main.js');";
const js = '"use strict";\n' + (await build({
  ...options, stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'entry.js', loader: 'js' }, format: 'iife',
  define: { TILT4D_ONE_FILE: 'true' }, plugins: minify ? [shaders] : [], logOverride: { 'empty-import-meta': 'silent' },
})).outputFiles[0].text;
const css = (await build({ ...options, entryPoints: [path.join(ROOT, 'style.css')] })).outputFiles[0].text;

// Inside a page, a script ends at the first "</script" whatever it stands in
// (esbuild writes those as "<\/script" already; this makes sure of it).
const inScript = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const inStyle = (s) => s.replace(/<\/style/gi, '<\\/style');

let html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// The markup: runs of white space count as one space in a page (it has no
// <pre> or <textarea>, where they would not), and none is needed between
// the tags of the head or round the page's outermost elements.
if (minify) {
  if (/<(pre|textarea)\b/i.test(html)) { console.log('index.html has a <pre> or <textarea>, whose white space this tool would spoil.'); process.exit(1); }
  html = html.replace(/\s+/g, ' ').replace(/> <(?=\/?(?:html|head|body|meta|title|link|style|script)\b)/g, '><').replace(/(<\/?(?:html|head|body|meta|title|link|style|script)\b[^>]*>) </g, '$1<').trim();
}
const put = (what, find, text) => {
  if (html.split(find).length !== 2) {
    console.log(`index.html does not have exactly one ${what} (${find}): this tool needs updating to match it.`);
    process.exit(1);
  }
  html = html.replace(find, () => text);
};
put('stylesheet link', '<link rel="stylesheet" href="style.css">', `<style>\n${inStyle(css.trim())}\n</style>`);
put('script tag', '<script type="module" src="src/main.js"></script>', `<script type="module">\n${inScript(js.trim())}\n</script>`);
// The single file goes out on its own, so it carries the licence with it.
const licence = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').trim();
if (licence.includes('--')) { console.log('LICENSE has "--" in it, which cannot stand in a comment of a page.'); process.exit(1); }
put('doctype', '<!doctype html>', `<!doctype html>
<!--
tilt4d in one file, made by tools/bundle.mjs from index.html, style.css and src/. Edit those, not this.
The source is at https://github.com/sipa/tilt4d

${licence}
-->
`);
// anything else the page still asks a server for would be missing from the single file
const left = [...html.matchAll(/<(?:script|link|img|source|iframe)\b[^>]*\b(?:src|href)="(?!data:|#)([^"]*)"/g)].map((m) => m[1]);
if (left.length) {
  console.log(`index.html still refers to other files, which the single file would lack: ${left.join(', ')}`);
  process.exit(1);
}

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, html);
const kb = (n) => (n / 1024).toFixed(0) + ' kB';
const shown = path.relative(process.cwd(), out);
console.log(`wrote ${shown.startsWith('..') ? out : shown}: ${kb(Buffer.byteLength(html))} (${kb(gzipSync(html, { level: 9 }).length)} as a web server would send it compressed)`);
