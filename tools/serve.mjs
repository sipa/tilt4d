// Minimal static file server for the demo.
//
//   node tools/serve.mjs [port] [host]
//   node tools/serve.mjs --host 0.0.0.0 --https
//
//   --port n      port to listen on (default 8080)
//   --host addr   address to listen on (default 127.0.0.1; 0.0.0.0 or :: for all)
//   --https       serve over HTTPS.  Browsers only offer WebGPU to pages from
//                 https or from localhost, so this is what other machines need.
//                 Uses --cert and --key if given; otherwise makes a
//                 self-signed certificate with openssl and keeps it in
//                 ~/.cache/tilt4d (the browser will ask you to accept it).
//   --cert file, --key file   certificate and private key in PEM format

import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8',
};

async function handle(req, res) {
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) throw new Error('outside root');
    // nothing hidden (.git and the like) is served
    if (path.relative(ROOT, file).split(path.sep).some((part) => part.startsWith('.'))) throw new Error('hidden');
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// tls: { cert, key } (PEM strings or buffers) for HTTPS; omit for plain HTTP.
export function createServer(tls = null) {
  return tls ? https.createServer(tls, handle) : http.createServer(handle);
}

// Resolves with the port once the server is listening (0 = any free port).
export function listen(port = 0, host = '127.0.0.1', tls = null) {
  return new Promise((resolve, reject) => {
    const server = createServer(tls);
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port }));
  });
}

// The addresses other machines can reach this one at.
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!a.internal && !(a.family === 'IPv6' && a.address.startsWith('fe80'))) out.push(a.address);
    }
  }
  return out;
}

// A self-signed certificate naming this machine's host name and addresses,
// made once and reused so the browser's exception for it keeps working.
function selfSigned() {
  const dir = path.join(os.homedir(), '.cache', 'tilt4d');
  const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem'), names = path.join(dir, 'names.txt');
  const alt = ['DNS:localhost', `DNS:${os.hostname()}`, 'IP:127.0.0.1', 'IP:::1', ...addresses().map((a) => `IP:${a}`)].join(',');
  if (!existsSync(cert) || !existsSync(key) || !existsSync(names) || readFileSync(names, 'utf8') !== alt) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-keyout', key, '-out', cert, '-subj', '/CN=tilt4d', '-addext', `subjectAltName=${alt}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chmodSync(key, 0o600);
    writeFileSync(names, alt);
    console.log(`made a self-signed certificate in ${dir}`);
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opt = {}, rest = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--https') opt.https = true;
    else if (a.startsWith('--')) opt[a.slice(2)] = process.argv[++i];
    else rest.push(a);
  }
  const host = opt.host ?? rest[1] ?? '127.0.0.1';
  const secure = opt.https || (opt.cert && opt.key);
  let tls = null;
  if (secure) {
    try {
      tls = opt.cert && opt.key ? { cert: readFileSync(opt.cert), key: readFileSync(opt.key) } : selfSigned();
    } catch (e) {
      console.error(`could not set up HTTPS: ${e.message}`);
      process.exit(1);
    }
  }
  const { port } = await listen(Number(opt.port ?? rest[0]) || 8080, host, tls);
  const scheme = tls ? 'https' : 'http';
  const everywhere = host === '0.0.0.0' || host === '::';
  const local = everywhere || host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const url = (h) => `${scheme}://${h.includes(':') ? `[${h}]` : h}:${port}/`;
  console.log('tilt4d is at');
  if (local) console.log('  ' + url('localhost'));
  for (const h of everywhere ? addresses() : local ? [] : [host]) console.log('  ' + url(h));
  if (!local || everywhere) {
    if (!tls) {
      console.log('Over plain HTTP, browsers only offer WebGPU on localhost, so the demo will not start');
      console.log('from another machine at these addresses. Add --https, or keep this on localhost and');
      console.log(`forward the port instead:  ssh -L ${port}:localhost:${port} <this machine>`);
    } else if (!opt.cert) {
      console.log('The certificate is self-signed: the browser will warn once and ask you to accept it.');
    }
  }
}
