
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
// Commands: CLIR, vectors, proof, why-not, tests.

// ------------------------------------------------------------------- commands

// `lawc lower|expand` print the canonical CLIR on one line — expanded here
// for readability; the canonical bytes are taken from the CLI's raw output.
async function showLawcJson(command, title) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isLaw(editor.document)) {
    vscode.window.showWarningMessage('Open a .law or .law.md file.');
    return null;
  }
  const result = await runLawcOn(editor.document, (target) => [command, target]);
  if (!result) {
    vscode.window.showWarningMessage('lawc not found: set law.lawcPath.');
    return null;
  }
  if (!result.stdout.trim()) {
    output.appendLine(`${command}:\n${result.stderr}`);
    vscode.window.showWarningMessage(`lawc ${command} returned nothing — details in the "Arxo Law" channel.`);
    return null;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const doc = await vscode.workspace.openTextDocument({
    content: parsed ? JSON.stringify(parsed, null, 2) : result.stdout,
    language: 'json',
  });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  output.appendLine(`${title}: ${editor.document.uri.fsPath}`);
  return parsed;
}

async function showSemanticHash() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isLaw(editor.document)) return;
  const result = await runLawcOn(editor.document, (target) => ['lower', target]);
  if (!result || !result.stdout.trim()) {
    vscode.window.showWarningMessage('Semantic hash unavailable: lawc not found or the file does not lower to CLIR.');
    if (result) output.appendLine(`lower:\n${result.stderr}`);
    return;
  }
  let hash = null;
  try {
    hash = JSON.parse(result.stdout).semanticHash;
  } catch (e) {
    output.appendLine(`lower: ${e && e.message ? e.message : e}`);
  }
  if (!hash) {
    vscode.window.showWarningMessage('The lower output has no semanticHash.');
    return;
  }
  output.appendLine(`semanticHash ${editor.document.uri.fsPath}: ${hash}`);
  const copy = 'Copy';
  const chosen = await vscode.window.showInformationMessage(`semantic hash §209: ${hash}`, copy);
  if (chosen === copy) await vscode.env.clipboard.writeText(hash);
}

// -------------------------------------------------------- conformance vectors

function vectorContext(document) {
  const file = document?.uri?.fsPath;
  if (!file || !file.endsWith('.law')) return null;
  const dir = path.dirname(file);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'vector.json'), 'utf8'));
  } catch {
    return null; // not a vector — no sibling vector.json, or it's broken
  }
  return { dir, meta, ...summarize(meta, fs.readdirSync(dir)) };
}

function codeLensProvider() {
  return {
    provideCodeLenses(document) {
      const top = new vscode.Range(0, 0, 0, 0);
      const lenses = [];
      const context = vectorContext(document);
      if (context) lenses.push(new vscode.CodeLens(top, { title: context.title, command: '' }));
      if (context?.evaluable) {
        lenses.push(new vscode.CodeLens(top,
          { title: '▶ run (lawc eval)', command: 'law.evalVector', arguments: [context.dir] }));
      }
      if (context?.comparable) {
        lenses.push(new vscode.CodeLens(top,
          { title: '⇄ diff against expected', command: 'law.diffVector', arguments: [context.dir] }));
      }
      if (context?.evaluable) {
        lenses.push(new vscode.CodeLens(top,
          { title: '⊢ proof', command: 'law.showProof', arguments: [context.dir] }));
        lenses.push(new vscode.CodeLens(top,
          { title: '⊘ why not', command: 'law.whyNot', arguments: [context.dir] }));
      }
      // A test runs against a file and doesn't need a vector: the lens
      // appears on any `.lawtest` that has found a §169 program alongside
      // it — including outside the vector tree.
      if (surfaceOf(document.uri.fsPath) === '.lawtest') {
        const dir = path.dirname(document.uri.fsPath);
        const program = fs.existsSync(dir) ? programFor(fs.readdirSync(dir)) : null;
        if (program) {
          lenses.push(new vscode.CodeLens(top, {
            title: `▶ run test (lawc test · ${program})`,
            command: 'law.runTest',
            arguments: [document.uri.fsPath],
          }));
        }
      }
      return lenses;
    },
  };
}

async function showScenes(places, name) {
  if (!Array.isArray(places) || !places.length) {
    vscode.window.showInformationMessage(`\`${name}\`: no .lawtest scenes or corpus scenarios with this head were found.`);
    return;
  }
  const items = places.map((place) => ({
    label: place.title ? `${place.title}` : path.basename(place.file),
    description: `${path.basename(place.file)}:${place.line + 1}`,
    detail: place.kind === 'scenario' ? `corpus scenario · ${place.name}` : `scene · ${place.name}`,
    place,
  }));
  const picked = items.length === 1 ? items[0]
    : await vscode.window.showQuickPick(items, { placeHolder: `${name}: where it's checked` });
  if (!picked) return;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.place.file));
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  const range = new vscode.Range(picked.place.line, 0, picked.place.line, 0);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function vectorDir(argument) {
  if (typeof argument === 'string') return argument;
  const context = vectorContext(vscode.window.activeTextEditor?.document);
  if (!context) {
    vscode.window.showWarningMessage('This is not a vector: there is no vector.json next to the file.');
    return null;
  }
  return context.dir;
}

async function evalVector(argument) {
  const dir = vectorDir(argument);
  if (!dir) return;
  const result = await runLawc(['eval', dir], path.dirname(dir));
  if (!result) {
    vscode.window.showWarningMessage('lawc not found: set law.lawcPath.');
    return;
  }
  if (!result.stdout.trim()) {
    output.appendLine(`eval ${dir}:\n${result.stderr}`);
    vscode.window.showWarningMessage('lawc eval returned nothing — details in the "Arxo Law" channel.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ content: pretty(result.stdout), language: 'json' });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function diffVector(argument) {
  const dir = vectorDir(argument);
  if (!dir) return;
  const folder = path.dirname(dir);
  const evaluated = await runLawc(['eval', dir], folder);
  const golden = await runLawc(['canon', path.join(dir, 'expected.json')], folder);
  if (!evaluated || !golden) {
    vscode.window.showWarningMessage('lawc not found: set law.lawcPath.');
    return;
  }
  if (!evaluated.stdout.trim() || !golden.stdout.trim()) {
    output.appendLine(`diff ${dir}:\n${evaluated.stderr}${golden.stderr}`);
    vscode.window.showWarningMessage('The comparison failed — details in the "Arxo Law" channel.');
    return;
  }
  const name = path.basename(dir);
  if (evaluated.stdout === golden.stdout) {
    vscode.window.showInformationMessage(`${name}: lawc eval matches expected.json byte-for-byte (§208).`);
    return;
  }
  const left = await vscode.workspace.openTextDocument({ content: pretty(golden.stdout), language: 'json' });
  const right = await vscode.workspace.openTextDocument({ content: pretty(evaluated.stdout), language: 'json' });
  await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${name}: expected ↔ lawc eval`);
}

// ------------------------------------------------- §235 proof tree

// The §185 "why not" panel: the same nodes, a different kind dictionary.
const WHYNOT_ICONS = {
  status: 'question',
  blocker: 'error',
  observation: 'info',
  none: 'check',
  undeterminable: 'circle-outline',
  inapplicable: 'circle-slash',
  error: 'warning',
};

const PROOF_ICONS = {
  query_evaluation: 'search',
  rule_application: 'symbol-method',
  assertion: 'note',
  closure: 'type-hierarchy',
  comprehension: 'list-unordered',
  missing: 'warning',
};

// One tree for two panels: the §235 proof and the §185 "why not" — different
// questions about the same vector, but they share one node shape (label,
// detail, kind, anchor). A second copy of the class would drift from the
// first on the very first rendering change.
class LawTree {
  constructor(icons, revealCommand) {
    this.icons = icons;
    this.revealCommand = revealCommand;
    this.roots = [];
    this.origin = null;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  show(roots, origin) {
    this.roots = roots;
    this.origin = origin;
    this.changed.fire();
  }

  getChildren(node) {
    return node ? node.children : this.roots;
  }

  getTreeItem(node) {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.status ? `${node.description} · ${node.status}` : node.description;
    item.tooltip = node.id;
    item.iconPath = new vscode.ThemeIcon(this.icons[node.kind] ?? 'circle-outline');
    if (node.anchor) {
      // The vector's directory is passed as an argument: there are two
      // panels, and "where this node comes from" is known by the tree, not
      // the command.
      item.command = {
        command: this.revealCommand,
        title: 'Open source',
        arguments: [node, this.origin],
      };
    }
    return item;
  }
}


async function showProof(argument) {
  const dir = vectorDir(argument);
  if (!dir) return;
  const result = await runLawc(['eval', dir], path.dirname(dir));
  if (!result || !result.stdout.trim()) {
    if (result) output.appendLine(`eval ${dir}:\n${result.stderr}`);
    vscode.window.showWarningMessage('Proof unavailable: lawc not found or the vector does not evaluate.');
    return;
  }
  let graph = null;
  try {
    graph = JSON.parse(result.stdout).proofGraph;
  } catch (e) {
    output.appendLine(`proof: ${e && e.message ? e.message : e}`);
  }
  if (!graph) {
    vscode.window.showWarningMessage('The evaluation result has no proofGraph.');
    return;
  }
  const roots = buildTree(graph);
  proofTree.show(roots, dir);
  await vscode.commands.executeCommand('setContext', 'lawProofAvailable', true);
  output.appendLine(`proofGraph ${dir}: nodes ${countNodes(roots)}, ${graph.proofHash ?? ''}`);
}

// ------------------------------------------------------------- running a test

// `.lawtest` diagnostics come not from checking the file but from running
// it: `check` won't tell the truth about a test (lib/files.js), but the
// §267 runner will — it lowers the test, calls the engine, and compares the
// §174 result fields against expectations. A failed expectation is a file
// diagnostic, and its place is in Problems.

// A diagnostic for an expectation line: the underline is placed by TEXT
// OCCURRENCE, not by a guessed position — the runner prints exactly what the
// author wrote after `expect`. If not found (different whitespace, a
// failure unrelated to an expectation, a §270 property declared outside the
// test at all) — the entry goes at the start of the file, not a random underline.
function verdictDiagnostic(document, text, message, anchor) {
  const at = locateExpectation(text, anchor);
  const range = at
    ? new vscode.Range(document.positionAt(at.start), document.positionAt(at.end))
    : new vscode.Range(0, 0, 0, 0);
  const item = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
  item.source = 'lawc test';
  return item;
}

/**
 * The §267 runner's report to the Problems panel.
 *
 * There are two kinds of entries, and both must get through: a failed test
 * EXPECTATION and an unmet §270 PROPERTY. The runner counts them separately
 * ("N/M tests passed" and "N/M §270 properties hold"), and before the
 * switch to machine mode the second kind was lost entirely — text parsing
 * found `test PASS` before `property FAIL` and declared the run green on a
 * nonzero exit code.
 */
function publishReport(document, report, program) {
  const text = document.getText();
  const items = [];
  for (const verdict of report.tests) {
    for (const failure of verdict.failures) {
      items.push(verdictDiagnostic(document, text, failure.message, failure.expectation));
    }
  }
  for (const property of report.properties) {
    items.push(verdictDiagnostic(document, text, property.message, property.name));
  }
  collection.set(document.uri, items);
  lastVerdict.set(document.uri.toString(), { version: document.version, failures: items.length });
  const failedTests = report.tests.filter((v) => !v.passed).length;
  const title = report.tests.map((v) => v.title).join(', ') || document.uri.fsPath;
  output.appendLine(`test ${document.uri.fsPath} (program ${program}): `
    + `tests ${report.tests.length}, failures ${failedTests}, `
    + `§270 properties not holding ${report.properties.length}`);
  if (!items.length) {
    vscode.window.showInformationMessage(`${title}: test passed (${program}).`);
    return;
  }
  // A property is reported separately: "N failures" about a failed property
  // on an otherwise passing test would be lying about both — the same
  // reasoning by which the runner keeps its own separate count.
  const parts = [];
  if (failedTests) parts.push(`failures ${failedTests}`);
  if (report.properties.length) parts.push(`§270 properties not holding ${report.properties.length}`);
  vscode.window.showWarningMessage(`${title}: ${parts.join(', ')} — details in the Problems panel.`);
}

async function runTest(argument) {
  const target = typeof argument === 'string'
    ? argument
    : vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!target || surfaceOf(target) !== '.lawtest') {
    vscode.window.showWarningMessage('Open a `.lawtest`: a §267 test runs against a file.');
    return;
  }
  const dir = path.dirname(target);
  const program = programFor(fs.readdirSync(dir));
  if (!program) {
    vscode.window.showWarningMessage(
      'There is no program next to the test: source.law, a single *.law, or ir.json is needed (§169).');
    return;
  }
  const result = await runLawc(
    ['test', target, '--program', path.join(dir, program), '--json'], path.dirname(dir));
  if (!result) {
    vscode.window.showWarningMessage('lawc not found: set law.lawcPath.');
    return;
  }
  // §225 machine mode is the main path; text parsing remains a fallback for
  // a compiler panic and an old binary where `--json` isn't printed at all.
  let report = parseVerdictsJson(result.stdout, result.stderr);
  if (report && report.refusal) {
    // A refusal BEFORE the run is not a verdict: the program wasn't found, the test doesn't lower.
    output.appendLine(`test ${target}: runner refusal — ${report.refusal}`);
    vscode.window.showWarningMessage(`Runner refused: ${report.refusal}`);
    return;
  }
  if (!report) {
    const verdict = parseVerdict(result.stdout, result.stderr);
    if (!verdict) {
      // Neither an envelope nor a verdict line — the runner never got to
      // it (a panic, a lowering failure). Silence here would read as a green test.
      output.appendLine(`test ${target}:\n${result.stderr || result.stdout}`);
      vscode.window.showWarningMessage('The runner did not reach a verdict — details in the "Arxo Law" channel.');
      return;
    }
    output.appendLine(`test ${target}: machine mode didn't parse, the verdict was taken from text`);
    report = { refusal: null, tests: [verdict], properties: [] };
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  publishReport(document, report, program);
}

// The §185 "why not": the command builds the explanation, the extension
// only lays its answer out in the panel. Machine mode, not human text:
// parsing the compiler's printout would mean building a second explanation
// parser that would drift from the first silently.
async function showWhyNot(argument) {
  const dir = vectorDir(argument);
  if (!dir) return;
  const result = await runLawc(['why-not', dir, '--json'], path.dirname(dir));
  if (!result || !result.stdout.trim()) {
    if (result) output.appendLine(`why-not ${dir}:\n${result.stderr}`);
    vscode.window.showWarningMessage('"Why not" is unavailable: lawc not found or the vector does not evaluate.');
    return;
  }
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch (e) {
    output.appendLine(`why-not: ${e && e.message ? e.message : e}`);
    vscode.window.showWarningMessage('The why-not response did not parse — details in the "Arxo Law" channel.');
    return;
  }
  // A command refusal (`ok: false`) also lands in the panel: an empty tree
  // for "why not" is indistinguishable from "no reasons found".
  whyNotPanel.show(whyNotTree(payload), dir);
  await vscode.commands.executeCommand('setContext', 'lawWhyNotAvailable', true);
  output.appendLine(
    `why-not ${dir}: status ${payload.status ?? '—'}, blockers ${(payload.blockers ?? []).length}`);
}

// A rule is declared in source.law, an assertion arrives as a fact from
// case.json — we open wherever it's actually recorded.
async function revealProofSource(node, origin) {
  const dir = origin ?? proofTree.origin;
  if (!dir || !node || !node.anchor) return;
  const { kind, name } = node.anchor;
  const file = path.join(dir, kind === 'rule' ? 'source.law' : 'case.json');
  if (!fs.existsSync(file)) {
    vscode.window.showWarningMessage(`There is no file ${path.basename(file)} next to the vector.`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  let range = null;
  let peek = null;
  if (kind === 'rule') {
    const ast = await astFor(document);
    const decl = ast ? declarationNamed(ast, name) : null;
    if (decl) {
      const at = positionMapper(document);
      range = toRange(at, decl.selection);
    } else if (ast) {
      const bridge = await expansionBridge(document, ast, name);
      if (bridge) ({ range, peek } = bridge);
    }
  } else {
    const at = document.getText().indexOf(name);
    if (at !== -1) range = new vscode.Range(document.positionAt(at), document.positionAt(at + name.length));
  }
  if (!range) {
    vscode.window.showInformationMessage(`\`${name}\` was not found in ${path.basename(file)}.`);
    return;
  }
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  if (peek) {
    // The definition's `emit` line — in a popup under the instance: both
    // ends of the bridge are visible at once, and the cursor stays in the act.
    try {
      await vscode.commands.executeCommand('editor.action.peekLocations', document.uri, range.start, [peek], 'peek');
    } catch (e) {
      output.appendLine(`peek emit: ${e && e.message ? e.message : e}`);
    }
  }
}

Object.assign(S, {
  showLawcJson,
  showSemanticHash,
  vectorContext,
  codeLensProvider,
  showScenes,
  vectorDir,
  evalVector,
  diffVector,
  showProof,
  verdictDiagnostic,
  publishReport,
  runTest,
  showWhyNot,
  revealProofSource,
});

S.proofTree = S.proofTree ?? new LawTree(PROOF_ICONS, 'law.revealProofSource');
S.whyNotPanel = S.whyNotPanel ?? new LawTree(WHYNOT_ICONS, 'law.revealProofSource');

}
}
})();
