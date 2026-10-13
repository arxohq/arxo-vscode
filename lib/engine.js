'use strict';
// The compiler inside the extension: the §225 palette from `law_wasm.wasm`
// in a node:worker_threads worker, instead of spawning `law-cli` for every
// hover and check.
//
// What this buys us. File parsing and checking run without spawning a
// process and without building Rust on the machine: an installed .vsix
// carries the wasm and works where `cargo` is unavailable. The response is
// the same bytes as `lawc … --json` (gates 27/45 hold this equality across
// the whole palette), so the consumers of the result in extension.js do not
// change: the worker answers with the same string they used to read from
// stdout. A large package's heavy check is computed in the worker — the
// editor window does not freeze; a hung call is cleared by terminating the
// worker, the way a process would be killed.
//
// What this does not do. Operations outside the palette (`fmt`,
// `package-root`, `eval` and `why-not` on a vector, `semhash`) and strict
// `--imports` checking (the context is tens of megabytes of dependency
// CLIR) still go to `law-cli`: `requestFor` returns null for them, and
// runLawc uses the binary. No semantics live here (invariant 5): the module
// only translates argv into a palette request and back.

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

//: Files the compiler is allowed to ask the host for (law_vfs): sources,
//: manifests, scenes, literate files, contexts. Binaries and unrelated
//: files are never sent.
const TEXT_EXTENSIONS = new Set(['.law', '.md', '.lawtest', '.lawcase', '.lawq', '.toml', '.lock', '.json', '.txt', '.ebnf']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Where the bindings (`index.js`, `worker.js`) and the `law_wasm.wasm`
 * module live. Order: configured setting -> the installed extension bundle
 * (`engine/`, placed there by package.sh) -> a repository build for source
 * development. The wasm is
 * useless without the bindings: the pair must be complete.
 */
function engineAssets({ folder = null, extensionPath = null, configured = '' } = {}) {
  const candidates = [];
  if (configured) candidates.push({ dist: configured, wasm: path.join(configured, 'law_wasm.wasm') });
  if (extensionPath) {
    const dist = path.join(extensionPath, 'engine');
    candidates.push({ dist, wasm: path.join(dist, 'law_wasm.wasm') });
  }
  if (folder) {
    const dist = path.join(folder, 'apps/npm/law-engine/dist');
    candidates.push({ dist, wasm: path.join(folder, 'engines/lawc/target/wasm-dist/law_wasm.wasm') });
    candidates.push({ dist, wasm: path.join(dist, 'law_wasm.wasm') });
  }
  for (const candidate of candidates) {
    const complete = ['index.js', 'worker.js'].every((f) => fs.existsSync(path.join(candidate.dist, f)))
      && fs.existsSync(candidate.wasm);
    if (complete) return candidate;
  }
  return null;
}

/** A worker holding the module: one per session, recreated after being killed on timeout. */
class WasmEngine {
  constructor(assets, log = () => {}) {
    this.assets = assets;
    this.log = log;
    this.worker = null;
    this.pending = new Map();
    this.next = 1;
    this.calls = 0;
  }

  spawn() {
    const worker = new Worker(path.join(__dirname, 'engine-worker.mjs'), { workerData: this.assets });
    worker.on('message', (data) => {
      const entry = this.pending.get(data?.id);
      if (!entry) return;
      this.pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data);
      else entry.reject(new Error(data.error));
    });
    worker.on('error', (error) => this.fail(`worker crashed: ${error?.message ?? error}`));
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0) this.fail(`worker exited with code ${code}`);
    });
    this.worker = worker;
    return worker;
  }

  /** All pending calls receive a refusal; the next call spins the worker back up. */
  fail(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  send(kind, payload, timeoutMs) {
    const worker = this.worker ?? this.spawn();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Wasm cannot be interrupted — only killing the worker works, as with a process.
        if (!this.pending.delete(id)) return;
        this.log(`wasm: ${kind} exceeded ${timeoutMs} ms — worker killed`);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        reject(new Error(`wasm: ${kind} exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, kind, ...payload });
    });
  }

  async init(timeoutMs = 30000) {
    return (await this.send('init', {}, timeoutMs)).value;
  }

  /** A single palette operation: the canonical §208 response bytes as a string. */
  async callBytes(request, timeoutMs = 15000) {
    this.calls += 1;
    return (await this.send('call', { request }, timeoutMs)).bytes;
  }

  dispose() {
    this.fail('engine stopped');
    this.worker?.terminate();
    this.worker = null;
  }
}

// ------------------------------------------------------- argv -> §225 request

function readText(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** All text files of a directory (recursively), keyed by absolute path. */
function gatherDir(dir, files) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) gatherDir(full, files);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name)) || entry.name === 'law.lock') {
      const text = readText(full);
      if (text !== null) files[full] = text;
    }
  }
}

/** A file and its directory siblings — same as the wasm gate's `files_for`. */
function gatherFile(file, files) {
  const text = readText(file);
  if (text === null) return false;
  files[file] = text;
  let siblings = [];
  try { siblings = fs.readdirSync(path.dirname(file), { withFileTypes: true }); } catch { /* directory unavailable */ }
  for (const entry of siblings) {
    if (!entry.isFile()) continue;
    const full = path.join(path.dirname(file), entry.name);
    if (full !== file && (TEXT_EXTENSIONS.has(path.extname(entry.name)) || entry.name === 'law.lock')) {
      const sibling = readText(full);
      if (sibling !== null) files[full] = sibling;
    }
  }
  return true;
}

/** `law.toml` up the tree to the workspace root (§10: package-root marker). */
function gatherManifestsUp(start, stop, files) {
  let probe = start;
  for (;;) {
    const manifest = path.join(probe, 'law.toml');
    if (!(manifest in files)) {
      const text = readText(manifest);
      if (text !== null) files[manifest] = text;
    }
    if (!stop || probe === stop || path.dirname(probe) === probe) break;
    probe = path.dirname(probe);
  }
}

/**
 * The §279.1.8 expansion pin context: the context file and the definition
 * directories' files go into the VFS by their own absolute paths — the
 * entries' `root` is already absolute (expansionsArgs), nothing to rewrite.
 */
function gatherExpansions(contextFile, files) {
  const text = readText(contextFile);
  if (text === null) return false;
  let entries;
  try { entries = JSON.parse(text); } catch { return false; }
  files[contextFile] = text;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.root !== 'string') continue;
    let names = [];
    try { names = fs.readdirSync(entry.root, { withFileTypes: true }); } catch { continue; }
    for (const item of names) {
      if (!item.isFile()) continue;
      const full = path.join(entry.root, item.name);
      const content = readText(full);
      if (content !== null) files[full] = content;
    }
  }
  return true;
}

function flagValue(args, flag) {
  const at = args.indexOf(flag);
  return at !== -1 && at + 1 < args.length ? args[at + 1] : null;
}

//: Palette operations the extension calls with flags that translate into
//: the request's `args`. `--imports` (strict §23 checking) is deliberately absent.
const TRANSLATABLE = new Set(['parse', 'check', 'layer', 'lower', 'expand', 'why-not', 'test', 'explain', 'graph']);

/**
 * `law-cli` arguments -> a palette request, and how to build from the
 * response the stdout string that consumers read. `null` means the
 * operation or a flag is outside the palette: the call goes to the binary.
 */
function requestFor(args, { folder = null, overrides = null } = {}) {
  if (!Array.isArray(args) || args.length < 2 || !TRANSLATABLE.has(args[0])) return null;
  const [op, target] = args;
  if (!path.isAbsolute(target) || args.includes('--imports')) return null;
  const flags = args.slice(2);
  const files = {};
  let isDir = false;
  try { isDir = fs.statSync(target).isDirectory(); } catch { return null; }
  if (isDir) gatherDir(target, files);
  else if (!gatherFile(target, files)) return null;
  gatherManifestsUp(isDir ? target : path.dirname(target), folder, files);
  const request = { op, path: target, files, args: {} };
  const expansions = flagValue(flags, '--expansions');
  if (expansions) {
    if (!gatherExpansions(expansions, files)) return null;
    request.args.expansions = expansions;
  }
  const layer = flagValue(flags, '--layer');
  if (layer) request.args.layer = layer;
  const symbol = flagValue(flags, '--symbol');
  if (symbol) request.args.symbol = symbol;
  if (op === 'expand' && !symbol) return null;
  // §169 test-and-explain program: a file or directory next to the vector.
  const program = flagValue(flags, '--program');
  if (program) {
    if (!path.isAbsolute(program)) return null;
    let programDir = false;
    try { programDir = fs.statSync(program).isDirectory(); } catch { return null; }
    if (programDir) gatherDir(program, files);
    else if (!gatherFile(program, files)) return null;
    request.args.program = program;
  }
  const node = flagValue(flags, '--node');
  if (node) request.args.node = node;
  if (flags.includes('--lawtest')) request.args.lawtest = true;
  if (op === 'parse') {
    if (flags.includes('--ast')) request.args.ast = true;
    else if (!flags.includes('--json')) return null;
  }
  // Known flags are accounted for; an unknown one would mean silently losing meaning.
  const known = new Set(['--ast', '--json', '--lawtest', '--expansions', expansions, '--layer', layer,
    '--symbol', symbol, '--program', program, '--node', node]);
  if (flags.some((flag) => !known.has(flag))) return null;
  // Unsaved buffers: editor text instead of bytes from disk — under the
  // same absolute path, no temporary copies. A key outside the gathered
  // tree is also sent: the file may have been created in the editor and
  // not yet written.
  for (const [file, text] of Object.entries(overrides ?? {})) {
    if (path.isAbsolute(file) && typeof text === 'string') files[file] = text;
  }
  return { request, render: (answer, bytes) => renderStdout(op, flags, answer, bytes, files) };
}

/** All `uri`s in the response — back to absolute paths: the VFS strips the leading `/`. */
function restoreUris(node, files) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => restoreUris(item, files));
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'uri' && typeof value === 'string' && !path.isAbsolute(value) && (`/${value}` in files)) out[key] = `/${value}`;
    else out[key] = restoreUris(value, files);
  }
  return out;
}

/** The string the CLI would print to stdout for the same arguments. */
function renderStdout(op, flags, answer, bytes, files) {
  if (op === 'parse' && flags.includes('--ast') && !flags.includes('--json')) {
    // `lawc parse --ast` prints the bare AST even on errors; the palette
    // envelope puts it in the `ast` field. With --json we keep the
    // envelope together with ok/diagnostics: a refactor must not mistake
    // this for a recovery AST.
    return answer && typeof answer === 'object' && answer.ast ? JSON.stringify(answer.ast) : '';
  }
  // `lower` responds not with an envelope but with `{bytes}` holding the
  // canonical §208 CLIR bytes: the CLI prints exactly those.
  if (op === 'lower') return answer && typeof answer === 'object' && typeof answer.bytes === 'string' ? answer.bytes : '';
  const fixed = restoreUris(answer, files);
  return fixed === answer ? bytes : JSON.stringify(fixed);
}

module.exports = { engineAssets, WasmEngine, requestFor, restoreUris, renderStdout, TEXT_EXTENSIONS };
