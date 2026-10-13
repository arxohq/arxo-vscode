
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('./session');

const { declarations, declarationNamed, occurrences, symbols, tokens } = require('./ast');
const { parseCheckOutput, parseCheckJson, locate } = require('./diagnostics');
const { assembledToMdByte, lawBlockAt, isSuppressed } = require('./lawcontext');
const { ByteMap } = require('./offsets');
const { checkable, formattable, generated, bufferName, surfaceOf } = require('./files');
const { parseVerdict, parseVerdictsJson, programFor, locate: locateExpectation } = require('./lawtest');
const { fixesFor } = require('./quickfix');
const { ruleBindings, ruleBindingAt } = require('./rule-bindings');
const { card, leadingComment, sourceSlice, spokenBody, labelsOf: labelsOfNode } = require('./hovercard');
const { blockIndex, nodeIdsFor } = require('./verbalize');
const {
  expansionArgumentAt, expansionNamed, parameterNamed, parameterCard, targetSpan,
  generatedRuleName, instanceNamed, caseNamed, emitFor, instanceAt, expansionCompletions, instanceFixes,
  definitionParamAt, instanceReferences, emitCount, instanceInlays,
} = require('./expansions');
const testing = require('./testing');
const workspaceLib = require('./workspace');
const { buildTree, countNodes } = require('./proof');
const { whyNotTree } = require('./whynot');
const { statusOf } = require('./status');
const { tasksFor } = require('./tasks');
const { summarize } = require('./vectors');
const corpus = require('./corpus');
const { labelIndex, labelUses, hintText } = require('./labels');
const { signatureIndex, parameterInlays, argumentHover } = require('./signatures');
const dependenciesLib = require('./dependencies');
const { sceneIndex, scenarioIndex, headsOf, placesFor, lensTitle, sceneSkeleton, plural } = require('./scenes');
const { engineAssets, WasmEngine, requestFor } = require('./engine');
const lawql = require('./query');
const stdLibrary = require('./std');

const D = {
  execFile, crypto, fs, os, path,
  declarations, declarationNamed, occurrences, symbols, tokens,
  parseCheckOutput, parseCheckJson, locate,
  assembledToMdByte, lawBlockAt, isSuppressed, ByteMap,
  checkable, formattable, generated, bufferName, surfaceOf,
  parseVerdict, parseVerdictsJson, programFor, locateExpectation,
  fixesFor, ruleBindings, ruleBindingAt,
  card, leadingComment, sourceSlice, spokenBody, labelsOfNode,
  blockIndex, nodeIdsFor,
  expansionArgumentAt, expansionNamed, parameterNamed, parameterCard, targetSpan,
  generatedRuleName, instanceNamed, caseNamed, emitFor, instanceAt, expansionCompletions,
  instanceFixes, definitionParamAt, instanceReferences, emitCount, instanceInlays,
  testing, workspaceLib, buildTree, countNodes, whyNotTree, statusOf, tasksFor,
  summarize, corpus, labelIndex, labelUses, hintText, signatureIndex, parameterInlays,
  argumentHover, dependenciesLib, sceneIndex, scenarioIndex, headsOf, placesFor,
  lensTitle, sceneSkeleton, plural, engineAssets, WasmEngine, requestFor, lawql, stdLibrary,
};

(function () {
with (D) {
with (S) {
// Compiler process, wasm §225 palette, package root, check, format.

// -------------------------------------------------------------- diagnostics

// Path to the binary: first the setting (a relative path is resolved from the
// workspace root), then monorepo builds, and only then PATH. This order is
// deliberate: a name from PATH is the least reliable candidate (PATH is
// trimmed in a GUI app), while a build under engines/lawc/target exists for
// anyone working in the repository. The first one that runs is remembered
// for the session.
function binaryCandidates(folder) {
  const configured = config().get('lawcPath', '');
  const list = [];
  if (configured) {
    list.push(configured.includes(path.sep) && folder ? path.resolve(folder, configured) : configured);
  }
  // Builds are looked for both at the invocation directory AND the workspace
  // folder: commands on vectors pass the vector's own directory, where
  // `engines/` doesn't exist, and before wasm this saved the path cache from
  // the very first file check. With wasm the first process spawns later and
  // from a different place — the cache is empty, and the binary must be
  // found from the workspace folder on its own.
  const roots = [folder];
  try {
    if (folder) roots.push(vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(folder))?.uri.fsPath);
  } catch { /* stub without Uri — this candidate is skipped */ }
  for (const ws of vscode.workspace.workspaceFolders ?? []) roots.push(ws?.uri?.fsPath);
  for (const root of new Set(roots.filter(Boolean))) {
    // release before debug: the §22 package check was measured on both —
    // civil-procedure 3.2s vs 15.2s; debug on a large package doesn't even
    // fit the timeout. A stale debug binary (CLAUDE.md) is just as true for
    // the release binary, but the choice here is among already-built ones.
    // The `gate` profile (DECISION-0072: release + overflow-checks) is what
    // the gates build; on a machine where only run_all.sh has run, it can be
    // the only fresh build.
    list.push(path.join(root, 'engines/lawc/target/release/law-cli'));
    list.push(path.join(root, 'engines/lawc/target/gate/law-cli'));
    list.push(path.join(root, 'engines/lawc/target/debug/law-cli'));
  }
  list.push('law-cli');
  list.push('law');
  return [...new Set(list)];
}

function compilerArgs(bin, args) {
  // The public distribution exposes the compiler under `law engine`;
  // monorepo law-cli builds retain the direct low-level interface.
  if (!/^law(?:\.exe)?$/i.test(path.basename(bin))) return args;
  return args[0] === 'query' ? args : ['engine', ...args];
}

function spawnLawc(bin, args, cwd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, compilerArgs(bin, args), { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr }));
  });
}

// The compiler reads the file from disk, so an unsaved buffer is checked via
// a temporary copy; the extension is kept so literate mode §217 activates.
function bufferPath(document) {
  tempRoot = tempRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'law-dsl-'));
  const key = crypto.createHash('sha256').update(document.uri.toString()).digest('hex').slice(0, 16);
  const dir = path.join(tempRoot, key);
  fs.mkdirSync(dir, { recursive: true });
  const name = bufferName(document.uri.fsPath);
  const file = path.join(dir, name);
  fs.writeFileSync(file, document.getText(), 'utf8');
  return file;
}

function notice(document, code, message) {
  const item = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 0),
    message,
    vscode.DiagnosticSeverity.Warning,
  );
  item.code = code;
  item.source = 'lawc';
  collection.set(document.uri, [item]);
}

// Running the compiler on a document: an unsaved buffer goes to a temporary
// copy, the path to the binary is picked once per session.
// A LAUNCH error arrives as a string code (ENOENT — no file, EACCES — no
// execute permission, EPERM, and others): that candidate doesn't work, try
// the next one. A nonzero exit of the compiler itself arrives as a numeric
// code — that's not a launch failure but a result: for `check` it means
// "there are errors in the file". Checking only for ENOENT broke the chain
// at the first candidate, and everything that calls the compiler silently
// returned emptiness.
const isSpawnFailure = (error) => Boolean(error) && typeof error.code === 'string';

// ---------------------------------------------------- compiler in wasm

// One worker per session; `null` means it hasn't been started yet or was torn
// down. The reason wasm wasn't taken is printed once: a silent fallback to
// the binary is indistinguishable from wasm working.

function wasmEngineFor(folder, context = activeContext) {
  const mode = config().get('engine', 'auto');
  if (mode === 'cli') return null;
  if (wasmEngine) return wasmEngine;
  const assets = engineAssets({
    folder, extensionPath: context?.extensionPath ?? null, configured: config().get('enginePath', ''),
  });
  if (!assets) {
    if (wasmAnnounced !== 'missing') {
      wasmAnnounced = 'missing';
      output?.appendLine(mode === 'wasm'
        ? 'engine: law.engine = wasm, but law_wasm.wasm with its bindings were not found (apps/npm/law-engine/dist, extension engine/, law.enginePath) — falling back to law-cli'
        : 'engine: wasm not found, falling back to law-cli');
    }
    return null;
  }
  wasmEngine = new WasmEngine(assets, (line) => output?.appendLine(line));
  let built = '';
  try { built = new Date(fs.statSync(assets.wasm).mtimeMs).toISOString().slice(0, 16).replace('T', ' '); } catch { /* no date */ }
  output?.appendLine(`engine: wasm in worker_threads (${assets.wasm}${built ? `, built ${built}` : ''}; bindings ${assets.dist})`);
  wasmAnnounced = 'wasm';
  return wasmEngine;
}

// Calling the in-process engine instead of a process: `null` means the
// operation doesn't translate (goes to the binary) or the worker failed
// (then also the binary, with a note in the channel). The response has the
// shape of a process result: stdout with the string the CLI would print.
async function runViaWasm(args, folder, timeout, overrides = null) {
  const engine = wasmEngineFor(folder);
  if (!engine) return null;
  const translated = requestFor(args, { folder, overrides });
  if (!translated) return null;
  try {
    const bytes = await engine.callBytes(translated.request, timeout ?? 15000);
    let answer = null;
    try { answer = JSON.parse(bytes); } catch { answer = null; }
    if (answer && typeof answer === 'object' && answer.error && typeof answer.error === 'object') {
      // A failure of the engine itself (not a file diagnostic): treated like a nonzero CLI exit.
      return { error: { code: 2 }, stdout: '', stderr: `${answer.error.code ?? 'error'}: ${answer.error.message ?? ''}` };
    }
    return { error: null, stdout: translated.render(answer, bytes), stderr: '', engine: 'wasm' };
  } catch (error) {
    output?.appendLine(`wasm ${args[0]} ${args[1]}: ${error?.message ?? error} — falling back to law-cli`);
    return null;
  }
}

// `overrides` — unsaved buffers {path: text}: only wasm (VFS) sees them;
// the binary reads disk, and a call with overrides without wasm returns
// null — the caller decides whether to wait for save or provide a temp copy.
// `cwd` — the directory the binary runs from, when it differs from the
// workspace folder: an inline LawQL query resolves relative paths from cwd
// (the document's directory).
async function runLawc(args, folder, timeout, { overrides = null, cwd = null } = {}) {
  const viaWasm = await runViaWasm(args, folder, timeout, overrides);
  if (viaWasm) return viaWasm;
  if (overrides) return null;
  const tried = [];
  for (const bin of resolvedBin ? [resolvedBin] : binaryCandidates(folder)) {
    const attempt = await spawnLawc(bin, args, cwd ?? folder, timeout);
    if (isSpawnFailure(attempt.error)) {
      tried.push(`${bin} → ${attempt.error.code}`);
      continue;
    }
    resolvedBin = bin;
    return attempt;
  }
  resolvedBin = null;
  if (tried.length) output.appendLine(`lawc won't start: ${tried.join('; ')}`);
  return null;
}

async function runLawcOn(document, argsFor) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const unsaved = document.isDirty || document.isUntitled;
  // An unsaved buffer with a real path goes into the wasm VFS at that same
  // path: package siblings and law.toml are found alongside it, no on-disk
  // temp copy needed. Without wasm or without a path (untitled) — the
  // previous temp-copy approach.
  if (unsaved && !document.isUntitled && wasmEngineFor(folder)) {
    const viaWasm = await runLawc(argsFor(document.uri.fsPath), folder, undefined,
      { overrides: { [document.uri.fsPath]: document.getText() } });
    if (viaWasm) return viaWasm;
  }
  const target = unsaved ? bufferPath(document) : document.uri.fsPath;
  return runLawc(argsFor(target), folder);
}

// Both parses use immutable snapshots, including unsaved edits. Never accept
// the recovery AST returned by a failed parse for a source transformation.
async function parseSyntaxSnapshot(source, document) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'law-syntax-preview-'));
  try {
    const target = path.join(directory, 'snapshot.law');
    fs.writeFileSync(target, source, 'utf8');
    const result = await runLawc(['parse', target, '--ast', '--json'], folder);
    if (!result || result.error) throw new Error('Failed to parse the source snapshot. Check the lawc output.');
    const response = JSON.parse(result.stdout);
    if (!response.ok || !response.ast || response.diagnostics?.some((d) => d.severity === 'error')) {
      throw new Error('Fix the parse errors before transforming the syntax.');
    }
    return response.ast;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// ------------------------------------------- package root (§10, DECISION-0033)

// A package-wide check of a large package is more expensive than a per-file
// one (measured: personal-data 0.6s, civil-procedure 3.2s on release) — the
// standard 15s isn't enough for a debug build.

// Cache "file → package root". The root rule lives in the COMPILER
// (`lawc package-root`: climb to the nearest law.toml, §10) — not a line of
// semantics here (invariant 5). The cache is cleared by editing any
// law.toml (watcher in activate) — that marker is the only thing the answer
// depends on.

async function packageRootOf(document) {
  const fsPath = document.uri.fsPath;
  const cached = packageRoots.get(fsPath);
  if (cached) return cached;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const result = await runLawc(['package-root', fsPath, '--json'], folder);
  // An old binary without package-root replies with a usage error — the file
  // stays a single-file package, i.e. the previous behavior, not a failure.
  let resolved = { root: fsPath, packaged: false };
  if (result && !result.error && result.stdout) {
    try {
      const payload = JSON.parse(result.stdout);
      if (payload.ok && payload.root) {
        resolved = { root: payload.root, packaged: Boolean(payload.packaged) };
      }
    } catch { /* not JSON — treated as the command being absent */ }
  }
  packageRoots.set(fsPath, resolved);
  return resolved;
}

// One run per package: N open files of a package on the same event share one
// compiler invocation instead of spawning N identical ones.

// §279.1.8 expansion pin context (DECISION-0126): a package with
// `[expansions]` in law.toml but without `--expansions` is rejected by the
// compiler (LDC-E1340), so the `expansions` section entries of its law.lock
// are supplied via a temp file with the absolute `root` of each definition;
// the compiler itself checks contentHash against the package's bytes. A
// package without the context section gets none.
// Alias → path from a package's `[expansions]` law.toml (§279.1.8): a line
// like `alias = { name = "…", version = "…", path = "…" }`. Paths are
// relative to the manifest's directory; without a manifest or section —
// an empty map.
function expansionPaths(dir) {
  const paths = new Map();
  const manifest = path.join(dir, 'law.toml');
  if (!fs.existsSync(manifest)) return paths;
  for (const line of fs.readFileSync(manifest, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"/.exec(line);
    if (m) paths.set(m[1], m[2]);
  }
  return paths;
}

// Full `[expansions]` manifest entries: alias → { path, name, version }.
function expansionSpecs(dir) {
  const specs = new Map();
  const manifest = path.join(dir, 'law.toml');
  if (!fs.existsSync(manifest)) return specs;
  for (const line of fs.readFileSync(manifest, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\{([^}]*)\}/.exec(line);
    if (!m) continue;
    const field = (name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(m[2])?.[1] ?? null;
    if (field('path')) specs.set(m[1], { path: field('path'), name: field('name'), version: field('version') });
  }
  return specs;
}

/** Aliases pinned in the package's law.lock (expansions section). */
function lockedAliases(dir) {
  try {
    return new Set((JSON.parse(fs.readFileSync(path.join(dir, 'law.lock'), 'utf8')).expansions ?? []).map((e) => e.alias));
  } catch { return null; }
}

// Consumers of a definition: workspace packages whose `[expansions]` points
// into the definition's directory. The tree walk happens once per session
// (cleared by editing any law.toml); build, dependency, and sibling worktree
// directories (`.claude/worktrees`) are not walked — they hold full repo copies.

function manifestsUnder(folder) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name.startsWith('target')
          || ['node_modules', 'dist', 'release', '__pycache__'].includes(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.name === 'law.toml') out.push(dir);
    }
  };
  walk(folder, 0);
  return out;
}

function consumersOf(folder, definitionRoot) {
  if (!folder) return [];
  let manifests = consumersCache.get(folder);
  if (!manifests) {
    manifests = manifestsUnder(folder);
    consumersCache.set(folder, manifests);
  }
  const realDefinition = (() => { try { return fs.realpathSync(definitionRoot); } catch { return definitionRoot; } })();
  const out = [];
  for (const dir of manifests) {
    for (const [alias, spec] of expansionSpecs(dir)) {
      let target = path.resolve(dir, spec.path);
      try { target = fs.realpathSync(target); } catch { /* directory doesn't exist — not a consumer */ }
      if (target === realDefinition) out.push({ dir, alias });
    }
  }
  return out;
}

function expansionsArgs(root) {
  try {
    const dir = fs.statSync(root).isDirectory() ? root : path.dirname(root);
    const manifest = path.join(dir, 'law.toml');
    const lock = path.join(dir, 'law.lock');
    if (!fs.existsSync(manifest) || !fs.existsSync(lock)) return [];
    const entries = JSON.parse(fs.readFileSync(lock, 'utf8')).expansions ?? [];
    if (!entries.length) return [];
    const paths = expansionPaths(dir);
    const context = entries
      .filter((e) => paths.has(e.alias))
      .map((e) => ({ ...e, root: path.resolve(dir, paths.get(e.alias)) }));
    if (!context.length) return [];
    const file = scratchFile(`expansions-${path.basename(dir)}.json`);
    fs.writeFileSync(file, JSON.stringify(context));
    return ['--expansions', file];
  } catch (error) {
    output?.appendLine(`expansions context ${root}: ${error.message}`);
    return [];
  }
}

function runPackageCheck(root, folder, overrides = null) {
  // Key — the root and buffer versions: identical requests share one run.
  const key = overrides ? `${root}\u0000${JSON.stringify(Object.keys(overrides).sort().map((f) => [f, overrides[f].length]))}` : root;
  let running = packageChecks.get(key);
  if (!running) {
    running = runLawc(['check', root, '--json', ...expansionsArgs(root)], folder, PACKAGE_TIMEOUT_MS, { overrides })
      .finally(() => packageChecks.delete(key));
    packageChecks.set(key, running);
  }
  return running;
}

// A package's unsaved buffers: all open dirty documents under the root.
function dirtyOverrides(root) {
  const overrides = {};
  for (const d of vscode.workspace.textDocuments ?? []) {
    if (!isLaw(d) || !d.isDirty || d.isUntitled) continue;
    if (d.uri.fsPath === root || d.uri.fsPath.startsWith(`${root}${path.sep}`)) overrides[d.uri.fsPath] = d.getText();
  }
  return Object.keys(overrides).length ? overrides : null;
}

// What's been published per root — so that a fix in a sibling file is
// cleared explicitly, instead of hanging around until that file is opened.

// The file's §1.3 layer: computed by the compiler (`lawc layer --json`), the
// extension only displays it. A separate run because `check --json` doesn't
// carry the layer, yet it's needed on the SAME event: otherwise the status
// bar lags behind an edit and lies exactly at the moment the file climbs the
// tower.
async function layerOf(document, explicitTarget = null) {
  // A package file read on its own is read below its own package (it lacks
  // foreign constructs) — the layer must be computed from the same input as check.
  const result = explicitTarget
    ? await runLawc(['layer', explicitTarget, '--json'],
                    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
                    PACKAGE_TIMEOUT_MS)
    : await runLawcOn(document, (target) => ['layer', target, '--json']);
  if (!result || result.error || !result.stdout) {
    if (result && result.stderr) output.appendLine(`layer ${document.uri.fsPath}: ${result.stderr.trim()}`);
    return null;
  }
  try {
    const payload = JSON.parse(result.stdout);
    if (!payload.layer) return null;
    return { layer: payload.layer, motto: payload.motto ?? '', constructs: payload.constructs ?? [] };
  } catch (e) {
    output.appendLine(`layer: ${e && e.message ? e.message : e}`);
    return null;
  }
}

async function check(document) {
  if (!isLaw(document) || !collection) return;
  // A §168 case and a §267 test are not a package program (LDC-E1314): their
  // predicates are declared in a sibling program, and a standalone check
  // reports an `LDC-E2102` for each. Rationale and measurement — in lib/files.js.
  if (!checkable(document.uri.fsPath)) {
    // The test verdict is a diagnostic of THIS file version: it stays until
    // the first edit and is cleared by it. A stale verdict is worse than none.
    const verdict = lastVerdict.get(document.uri.toString());
    if (verdict && verdict.version === document.version) return;
    lastVerdict.delete(document.uri.toString());
    collection.delete(document.uri);
    return;
  }
  if (!config().get('check.enabled', true)) {
    collection.delete(document.uri);
    return;
  }

  const text = document.getText();
  // §10/DECISION-0033: a file of a multi-file package is checked as a
  // PACKAGE from the root the compiler names (`lawc package-root`, nearest
  // law.toml) — a per-file check used to lie with a flood of LDC-E2101/E2102
  // about declarations from sibling files. An unsaved buffer of a package
  // file is not checked until it's saved: checking the buffer alone would be
  // the old lie, and the on-disk package isn't the same text. Previous
  // diagnostics are not cleared meanwhile: stale for the length of the batch
  // is more honest than phantom.
  const scope = await packageRootOf(document);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  // With wasm, an unsaved package file is checked as a PACKAGE with buffer
  // text in the VFS: the on-disk package isn't the same text, and there's no
  // need to wait for a save anymore.
  const unsavedPackaged = scope.packaged && (document.isDirty || document.isUntitled);
  const overrides = unsavedPackaged && !document.isUntitled && wasmEngineFor(folder)
    ? { ...(dirtyOverrides(scope.root) ?? {}), [document.uri.fsPath]: text } : null;
  if (unsavedPackaged && !overrides) return;
  const packaged = scope.packaged;
  const result = packaged
    ? await runPackageCheck(scope.root, folder, overrides)
    : await runLawcOn(document, (target) => ['check', target, '--json']);
  if (!result) {
    lastCheck.delete(document.uri.toString());
    updateStatus();
    notice(document, 'lawc-missing',
      'lawc could not be started. Build it (`cargo build -p law-cli` in engines/lawc/) or set the path via '
      + 'law.lawcPath; which candidates were tried and why they failed — in the "Arxo Law" output channel.');
    return;
  }

  // §225 machine mode; if the JSON didn't parse (old binary without --json),
  // the text stderr is read instead — otherwise a compiler change would
  // silently turn "couldn't parse" into "file is clean".
  let { diagnostics, crash, parsed } = parseCheckJson(result.stdout, result.stderr);
  if (!parsed) {
    ({ diagnostics, crash } = parseCheckOutput(result.stderr));
  }
  if (crash) {
    output.appendLine(`[${new Date().toISOString()}] ${document.uri.fsPath}\n${result.stderr}`);
    notice(document, 'lawc-crash', `lawc crashed, file diagnostics are unavailable: ${crash}`);
    lastCheck.set(document.uri.toString(), { crashed: true, file: path.basename(document.uri.fsPath) });
    updateStatus();
    return;
  }

  lastCheck.set(document.uri.toString(), {
    checked: true,
    // The count covers the whole checked input: for a package file that's
    // the package, and the name in the status bar names the package, so
    // "3 errors" isn't read as errors of this file specifically.
    file: packaged ? `${path.basename(scope.root)}/` : path.basename(document.uri.fsPath),
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
    layer: await layerOf(document, packaged ? scope.root : null),
  });
  updateStatus();

  if (!packaged) {
    collection.set(document.uri, toItems(locate(text, diagnostics), 'lawc'));
    return;
  }
  publishPackage(collection, lastPackagePublish, diagnostics, {
    source: 'lawc',
    root: scope.root,
    base: folder ?? path.dirname(scope.root),
    activePath: document.uri.fsPath,
    activeText: text,
  });
}

/**
 * Distributes package diagnostics across files, in EACH file's own text coordinates.
 *
 * The compiler's `primarySpan.uri` (§225) names the diagnostic's file, so the
 * entry is published to its own file, not the one the check was run from.
 * Vanished entries are cleared across the WHOLE package: otherwise a fix in
 * a sibling file would hang around until that file was opened on its own.
 *
 * The function is shared between the regular and strict check. A second copy
 * of the distribution logic would drift from the first on the very first
 * edit — the same reasoning by which the proof and "why not" panels share
 * one node between them.
 */
function publishPackage(target, ledger, diagnostics, { source, root, base, activePath, activeText }) {
  const byFile = new Map();
  for (const d of diagnostics) {
    const file = d.file
      ? (path.isAbsolute(d.file) ? d.file : path.resolve(base, d.file))
      : activePath;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(d);
  }
  const published = new Set();
  for (const [file, fileDiags] of byFile) {
    let fileText;
    if (file === activePath) {
      fileText = activeText;
    } else {
      try { fileText = fs.readFileSync(file, 'utf8'); } catch { fileText = ''; }
    }
    target.set(vscode.Uri.file(file), toItems(locate(fileText, fileDiags), source));
    published.add(file);
  }
  for (const stale of ledger.get(root) ?? []) {
    if (!published.has(stale)) target.delete(vscode.Uri.file(stale));
  }
  if (activePath && !published.has(activePath)) target.delete(vscode.Uri.file(activePath));
  ledger.set(root, published);
  return published;
}

function scheduleCheck(document, delay = DEBOUNCE_MS) {
  if (!isLaw(document)) return;
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    check(document).catch((e) => output.appendLine(`check: ${e && e.stack ? e.stack : e}`));
  }, delay));
}

// ----------------------------------------------------------- quick fixes

// Fixes for expansion codes need the AST and the definition (§279.1.3); text
// fixes don't need this, but there is one provider, and it's async.
const RELOCK_CODE = 'LDC-E1340';

async function expansionFixes(document, located) {
  if (located.code !== 'LDC-E1337' && located.code !== 'LDC-E1339') return [];
  const ast = await astFor(document);
  if (!ast) return [];
  const where = slicerFor(document);
  const instance = (ast.decls ?? []).find((d) => d.kind?.kind === 'expand'
    && d.kind.name?.span && where.index(d.kind.name.span.start) === located.startOffset);
  const definition = instance?.kind?.reference?.text
    ? await expansionDefinition(document, instance.kind.reference.text, ast) : null;
  return instanceFixes(ast, where.text, where.index, located, definition?.decl ?? null);
}

function codeActionProvider() {
  return {
    async provideCodeActions(document, _range, context) {
      const text = document.getText();
      const version = document.version;
      const ast = context.diagnostics.some((d) => String(d.code) === 'LDC-E4103') ? await astFor(document) : null;
      if (version !== document.version) return [];
      const actions = [];
      for (const diag of context.diagnostics) {
        if (diag.source !== 'lawc' || !diag.code) continue;
        const located = {
          code: String(diag.code),
          message: diag.message,
          machineData: S.machineDataOf(diag),
          startOffset: document.offsetAt(diag.range.start),
          endOffset: document.offsetAt(diag.range.end),
        };
        if (located.code === RELOCK_CODE) {
          // The §279.1.8 expansion pin doesn't match or wasn't supplied: text
          // can't fix this — law.lock is rewritten by the generator from the
          // definition's bytes.
          const action = new vscode.CodeAction('§279.1.8: regenerate the expansions section in law.lock', vscode.CodeActionKind.QuickFix);
          action.command = { command: 'law.relockExpansions', title: 'Regenerate law.lock', arguments: [document.uri.fsPath] };
          action.diagnostics = [diag];
          actions.push(action);
          continue;
        }
        for (const fix of [...fixesFor(located, text, ast, slicerFor(document).index), ...(await expansionFixes(document, located))]) {
          const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
          action.edit = new vscode.WorkspaceEdit();
          for (const edit of fix.edits) {
            action.edit.replace(
              document.uri,
              new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
              edit.newText,
            );
          }
          action.diagnostics = [diag];
          actions.push(action);
        }
      }
      return version === document.version ? actions : [];
    },
  };
}

// ------------------------------------------------------------ formatting

// The layout is set by `lawc fmt` (§214, DECISION-0027); the extension only
// substitutes its output: a second style built here would drift from the
// first silently — and would drift exactly on the official §17 texts, where
// the cost of a mistake is a reddened §194 publication.
//
// Three boundaries, and the extension invented none of them:
//   * surface outside the §214 guarantees — literate (DECISION-0027 item 8a),
//     case and test (outside the `verify/ci/gates/compiler/check_fmt.py`
//     gate sample); parsing is in lib/files.js;
//   * generated source `verify/vectors/**` — fixed only by the generator
//     (CLAUDE.md, invariant 2; DECISION-0027 item 10), and format-on-save
//     would silently undo the regeneration and break gate 4;
//   * a nonzero exit or empty stdout — the document is not touched at all.
//     literate's refusal arrives exactly this way: code 1, empty stdout, the
//     reason in stderr.
function formattingRefusal(reason) {
  // Keep the observable refusal aligned with the LSP's ContentModified reply.
  // VS Code propagates provider failures to the format request rather than
  // interpreting an empty edit list as a successful no-op.
  const error = new Error(reason);
  error.code = -32803;
  return error;
}

function parseRefusedFormatting(result) {
  // `lawc parse --json` intentionally returns its structured diagnostics on
  // stdout with a nonzero exit code. Do not discard that proof as a generic
  // process error.
  if (!result || !result.stdout) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed.ok === false || (parsed.diagnostics ?? []).some((diagnostic) => diagnostic.severity === 'error');
  } catch {
    // An older or unavailable compiler cannot prove a parse refusal. Its
    // formatting result remains the only available evidence.
    return false;
  }
}

function formattingProvider() {
  return {
    async provideDocumentFormattingEdits(document) {
      const version = document.version;
      const text = document.getText();
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const refusal = !formattable(document.uri.fsPath)
        ? "outside the formatter's scope §214 (DECISION-0027)"
        : generated(document.uri.fsPath, folder)
          ? 'generated source — fixed only by the generator (invariant 2, DECISION-0027 §10)'
          : null;
      if (refusal) {
        output.appendLine(`fmt skipped: ${document.uri.fsPath} — ${refusal}`);
        return [];
      }

      const result = await runLawcOn(document, (target) => ['fmt', target]);
      if (!result) {
        vscode.window.showWarningMessage('lawc not found: set law.lawcPath.');
        return [];
      }
      if (result.error || !result.stdout) {
        const reason = result.stderr.trim().replace(/^lawc:\s*/, '') || 'formatter did not return text';
        output.appendLine(`fmt ${document.uri.fsPath}: ${reason}`);
        throw formattingRefusal(reason);
      }

      // `fmt` can normalize CRLF even on a parse error (§227).
      // So we check parse on both a non-empty output and a no-op.
      const parsed = await runLawcOn(document, (target) => ['parse', target, '--ast', '--json']);
      if (parseRefusedFormatting(parsed)) {
        const reason = '§227: the formatter left the text unchanged due to a parse error';
        output.appendLine(`fmt ${document.uri.fsPath}: ${reason}`);
        throw formattingRefusal(reason);
      }
      if (document.version !== version || document.getText() !== text) {
        throw formattingRefusal('the document changed while formatting was in progress');
      }
      if (result.stdout === text) return [];
      const whole = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      return [vscode.TextEdit.replace(whole, result.stdout)];
    },
  };
}

// ------------------------------------------------- structure and tokens from the AST

// `lawc parse --ast` prints the AST even on errors (diagnostics go to

Object.assign(S, {
  binaryCandidates,
  compilerArgs,
  spawnLawc,
  bufferPath,
  notice,
  isSpawnFailure,
  wasmEngineFor,
  runViaWasm,
  runLawc,
  runLawcOn,
  parseSyntaxSnapshot,
  packageRootOf,
  expansionPaths,
  expansionSpecs,
  lockedAliases,
  manifestsUnder,
  consumersOf,
  expansionsArgs,
  runPackageCheck,
  dirtyOverrides,
  layerOf,
  check,
  publishPackage,
  scheduleCheck,
  expansionFixes,
  codeActionProvider,
  formattingProvider,
  formattingRefusal,
  parseRefusedFormatting,
});

}
}
})();
