'use strict';
// Shared session for the VS Code host: mutable editor state, vscode stub,
// and small helpers. Feature modules bind it with `with (S)` so a re-require
// of extension.js (smoke tests) can swap vscode without reloading them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assembledToMdByte, lawBlockAt, isSuppressed } = require('./lawcontext');
const { ByteMap } = require('./offsets');
const { card } = require('./hovercard');
const { statusOf } = require('./status');

const S = module.exports;

S.LAW = { language: 'law' };
S.LITERATE = { language: 'markdown', pattern: '**/*.law.md' };
S.LAWQ = { language: 'lawq' };
S.WORD = /[A-Za-z_][A-Za-z0-9_]*/;
S.DEBOUNCE_MS = 500;
S.TOKEN_TYPES = ['namespace', 'type', 'function', 'parameter', 'variable', 'keyword', 'decorator', 'property', 'lawStatus'];
S.TOKEN_MODIFIERS = ['declaration', 'defaultLibrary'];
S.PACKAGE_TIMEOUT_MS = 60000;
S.QUERY_TIMEOUT_MS = 600000;
S.VERBALIZE_SCHEME = 'law-verbalize';

S.vscode = null;
S.entries = null;
S.output = null;
S.collection = null;
S.strictCollection = null;
S.queryCollection = null;
S.resolvedBin = null;
S.activeContext = null;
S.tempRoot = null;
S.timers = new Map();
S.astCache = new Map();
S.lastCheck = new Map();
S.astFailures = new Map();
S.status = null;
S.wasmEngine = null;
S.wasmAnnounced = null;
S.packageRoots = new Map();
S.packageChecks = new Map();
S.consumersCache = new Map();
S.lastPackagePublish = new Map();
S.siblingCache = new Map();
S.keywordItems = null;
S.packageDirs = new Map();
S.clirIndexes = new Map();
S.clirCache = new Map();
S.sceneFiles = new Map();
S.testController = null;
S.testExplorerState = null;
S.keywordSet = null;
S.clirNodes = new Map();
S.namespaceRoots = new Map();
S.lastVerdict = new Map();
S.lastStrictPublish = new Map();
S.verbalizations = new Map();
S.verbalizedChanged = null;
S.querySchema = null;
S.querySchemaPending = null;
S.packageTree = null;
S.proofTree = null;
S.whyNotPanel = null;
S.lspActive = false;
S.lspStarting = false;

S.config = () => S.vscode.workspace.getConfiguration('law');
S.isLaw = (document) =>
  document.languageId === 'law' || (document.languageId === 'markdown' && document.uri.fsPath.endsWith('.law.md'));
S.lspHandles = (document) => (S.lspActive || S.lspStarting) && document.uri.scheme === 'file'
  && (document.languageId === 'law'
    || (document.languageId === 'markdown' && document.uri.fsPath.endsWith('.law.md')));

function dictionary(context) {
  if (!S.entries) {
    const file = path.join(context.extensionPath, 'data', 'hover.json');
    S.entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
  }
  return S.entries;
}

function render(parts) {
  return new S.vscode.Hover(new S.vscode.MarkdownString(card(parts)));
}

function positionMapper(document) {
  const text = document.getText();
  const map = new ByteMap(text);
  if (document.languageId === 'markdown') {
    const toMd = assembledToMdByte(text);
    return (byteOffset) => map.positionAt(toMd(byteOffset));
  }
  return (byteOffset) => map.positionAt(byteOffset);
}

function slicerFor(document) {
  const text = document.getText();
  const map = new ByteMap(text);
  const at = positionMapper(document);
  return { text, index: (byte) => map.offsetOf(at(byte)) };
}

function wordAt(document, position, literate) {
  const range = document.getWordRangeAtPosition(position, S.WORD);
  if (!range) return null;
  const text = document.getText();
  const offset = document.offsetAt(range.start);
  const block = literate ? lawBlockAt(text, offset) : null;
  if (literate && !block) return null;
  const scope = block ? text.slice(block.start, block.end) : text;
  if (isSuppressed(scope, block ? offset - block.start : offset)) return null;
  return { word: document.getText(range), range, offset };
}

function spanContains(document, offset) {
  const at = positionMapper(document);
  const offsetOf = (byte) => {
    const p = at(byte);
    return document.offsetAt(new S.vscode.Position(p.line, p.character));
  };
  return (span) => {
    const start = offsetOf(span.start);
    const end = offsetOf(span.end);
    return start <= offset && offset < end;
  };
}

// Machine facts of published diagnostics. The editor hands a code action
// provider copies of the diagnostics, and a copy keeps only the standard
// fields, so the facts are looked up by those fields.
const machineFacts = new Map();
const MACHINE_FACTS_LIMIT = 4000;
const factKey = (code, range, message) => [code, range.start.line, range.start.character,
  range.end.line, range.end.character, message].join('\u0000');
function rememberMachineData(item, machineData) {
  if (!machineData) return;
  if (machineFacts.size >= MACHINE_FACTS_LIMIT) machineFacts.clear();
  machineFacts.set(factKey(String(item.code), item.range, item.message), machineData);
}
/** Machine facts §225 of a diagnostic the editor passed back, or null. */
function machineDataOf(diag) {
  if (diag.machineData) return diag.machineData;
  const range = diag.range;
  if (!range || typeof range.start?.line !== 'number') return null;
  return machineFacts.get(factKey(String(diag.code), range, diag.message)) ?? null;
}

const toItems = (located, source) => located.map((d) => {
  const item = new S.vscode.Diagnostic(
    new S.vscode.Range(d.start.line, d.start.character, d.end.line, d.end.character),
    d.message,
    d.severity === 'warning' ? S.vscode.DiagnosticSeverity.Warning : S.vscode.DiagnosticSeverity.Error,
  );
  item.code = d.code;
  item.source = source;
  rememberMachineData(item, d.machineData);
  return item;
});

const toRange = (at, span) => {
  const start = at(span.start);
  const end = at(span.end);
  return new S.vscode.Range(start.line, start.character, end.line, end.character);
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function readCached(file) {
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const hit = S.sceneFiles.get(file);
  if (hit && hit.mtime === mtime) return hit.text;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  S.sceneFiles.set(file, { mtime, text });
  return text;
}

function filesUnder(dir, suffix, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, suffix, out);
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

const textsOfFiles = (files) => files.map((file) => ({ file, text: readCached(file) })).filter((f) => f.text !== null);

const pretty = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

function scratchFile(name) {
  S.tempRoot = S.tempRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'law-dsl-'));
  const dir = path.join(S.tempRoot, 'corpus');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

const builtAt = (file) => {
  try { return new Date(fs.statSync(file).mtimeMs).toISOString().slice(0, 16).replace('T', ' '); } catch { return null; }
};

function engineState() {
  const binaryBuilt = S.resolvedBin && S.resolvedBin.includes(path.sep) ? builtAt(S.resolvedBin) : null;
  if (S.wasmEngine) {
    return { kind: 'wasm', module: S.wasmEngine.assets.wasm, moduleBuilt: builtAt(S.wasmEngine.assets.wasm), binaryBuilt };
  }
  return S.resolvedBin ? { kind: 'cli', binaryBuilt } : null;
}

function updateStatus() {
  if (!S.status) return;
  const document = S.vscode.window.activeTextEditor?.document;
  if (!document || !S.isLaw(document)) {
    S.status.hide();
    return;
  }
  const folder = S.vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const view = statusOf({
    binary: S.resolvedBin,
    folder,
    engine: engineState(),
    astFailed: S.astFailures.get(document.uri.toString()) ?? null,
    ...(S.lastCheck.get(document.uri.toString()) ?? {}),
  });
  S.status.text = view.text;
  S.status.tooltip = `${view.tooltip}\n\nClick to open the "Arxo Law" channel.`;
  S.status.backgroundColor = view.severity === 'error'
    ? new S.vscode.ThemeColor('statusBarItem.errorBackground')
    : view.severity === 'warning'
      ? new S.vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  S.status.show();
}

Object.assign(S, {
  dictionary, render, positionMapper, slicerFor, wordAt, spanContains,
  toItems, machineDataOf, toRange, mapLimit, readCached, filesUnder, textsOfFiles, pretty,
  scratchFile, builtAt, engineState, updateStatus,
});

const MAPS = [
  'timers', 'astCache', 'lastCheck', 'astFailures', 'packageRoots', 'packageChecks',
  'consumersCache', 'lastPackagePublish', 'siblingCache', 'packageDirs', 'clirIndexes',
  'clirCache', 'sceneFiles', 'clirNodes', 'namespaceRoots', 'lastVerdict',
  'lastStrictPublish', 'verbalizations',
];

S.boot = function boot(vscode) {
  S.vscode = vscode;
  S.entries = null;
  S.output = null;
  S.collection = null;
  S.strictCollection = null;
  S.queryCollection = null;
  S.resolvedBin = null;
  S.activeContext = null;
  S.status = null;
  S.wasmEngine?.dispose?.();
  S.wasmEngine = null;
  S.wasmAnnounced = null;
  S.keywordItems = null;
  S.testController = null;
  S.testExplorerState = null;
  S.keywordSet = null;
  S.querySchema = null;
  S.querySchemaPending = null;
  for (const name of MAPS) S[name].clear();
};
