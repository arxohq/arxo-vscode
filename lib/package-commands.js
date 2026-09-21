
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
// Package commands: strict check, verbalize, impact.

// -------------------------------------------------------- status bar

// ------------------------------- corpus and the О-track add-on (LAYERS-NEXT)

// What the strict check published — its own log, so a fix in a sibling
// package file is cleared the same way as for the regular check.

/**
 * The active editor's package, or `null` with the reason already shown.
 *
 * All three commands below operate on a PACKAGE, not a file: the §23
 * resolve context, B1 verbalization, and О-1 impact are defined on the §22
 * compilation unit, and "what will this edit change" makes no sense for a
 * single file of a package.
 */
async function activePackage(what) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isLaw(editor.document)) {
    vscode.window.showWarningMessage(`Open a .law or .law.md file: ${what} works on a §22 package.`);
    return null;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;
  if (!folder) {
    vscode.window.showWarningMessage(`${what}: an open repository workspace folder is needed.`);
    return null;
  }
  const scope = await packageRootOf(editor.document);
  if (!scope.packaged) {
    vscode.window.showWarningMessage(
      `${what}: the file does not belong to a package — there is no law.toml nearby (§10).`);
    return null;
  }
  return { editor, root: scope.root, folder };
}


/**
 * The package's §23 resolve context into a temp file, or `null` with the
 * reason in the channel.
 *
 * Needed by all three commands, not just the strict check: WITHOUT it,
 * `lawc lower` on a package with imports fails entirely (LDC-E1105 on the
 * very first qualified reference), meaning such a package can neither be
 * verbalized nor compared against the corpus. Measured: 118 of 470 corpus
 * packages have imports — without the context both commands would go silent
 * on exactly a quarter of the tree.
 *
 * It's assembled by the compiler (`lawc imports-context`, DECISION-0128 §7)
 * from the bytes of committed dependency CLIRs — the same JSON as the
 * corpus generator (`gen_kz_clir --imports-for`); equality is enforced by
 * the differential gate. Python on the "click → paragraph" path is no
 * longer needed.
 */
async function resolveContext(scope) {
  const context = await runLawc(corpus.importsForArgs(scope.root), scope.folder, PACKAGE_TIMEOUT_MS);
  const refusal = corpus.refusalOf(context);
  if (refusal) {
    output.appendLine(`§23 resolve context for ${scope.root}: not assembled — ${refusal}`);
    return null;
  }
  const file = scratchFile('imports.json');
  fs.writeFileSync(file, context.stdout, 'utf8');
  return file;
}

/**
 * Strict package check: `check --imports` with the resolve context supplied.
 *
 * A separate command, not a check-on-every-edit mode, and this is a
 * measurement, not caution: the context is assembled by the corpus generator
 * from the CLIR bytes of all dependencies and costs about 1.7s. Keeping it
 * on the 500ms debounce would mean running it on every keystroke. Caching it
 * would mean building a second mechanism that one day presents a context
 * from yesterday's dependencies without saying so; that kind of failure is
 * more expensive here than waiting.
 */
async function checkStrict() {
  const scope = await activePackage('strict check');
  if (!scope) return;
  output.appendLine(`check --imports: assembling the §23 resolve context for ${scope.root}`);
  const contextFile = await resolveContext(scope);
  if (!contextFile) {
    vscode.window.showWarningMessage(
      'The §23 resolve context was not assembled: the package is not registered in LOWERED_ACTS, or '
      + 'the dependency CLIR was not committed. Details in the "Arxo Law" channel.');
    return;
  }
  const result = await runLawc(
    [...corpus.strictCheckArgs(scope.root, contextFile), ...expansionsArgs(scope.root)],
    scope.folder, PACKAGE_TIMEOUT_MS);
  if (!result) {
    vscode.window.showWarningMessage('lawc not found: set law.lawcPath.');
    return;
  }
  const { diagnostics, crash, parsed } = parseCheckJson(result.stdout, result.stderr);
  if (crash || !parsed) {
    output.appendLine(`check --imports:\n${result.stderr || result.stdout}`);
    vscode.window.showWarningMessage(
      'The strict check did not return a machine response — details in the "Arxo Law" channel.');
    return;
  }
  publishPackage(strictCollection, lastStrictPublish, diagnostics, {
    source: 'lawc check --imports',
    root: scope.root,
    base: scope.folder,
    activePath: scope.editor.document.uri.fsPath,
    activeText: scope.editor.document.getText(),
  });
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  output.appendLine(`check --imports ${scope.root}: errors ${errors}, warnings ${warnings}`);
  if (!diagnostics.length) {
    vscode.window.showInformationMessage(
      `${path.basename(scope.root)}: the §23/§24 strict check is clean — the package boundary was checked.`);
    return;
  }
  // The comparison base is named plainly. The context is assembled from
  // COMMITTED dependency CLIRs, so LDC-E1105 "symbol not exported" means
  // either a §24 debt of the package itself, or a stale dependency CLIR —
  // only a human can tell them apart, and the command does not render a
  // verdict about the package's text (measured 2026-09-04: kz.corpus.budget_code
  // has 6 exports on a fresh lowering and 0 in the committed CLIR).
  vscode.window.showWarningMessage(
    `${path.basename(scope.root)}: strict check — errors ${errors}, warnings ${warnings}; `
    + 'they are in the Problems panel with source "lawc check --imports". The base is the committed '
    + 'corpus/clir: a §24 discrepancy may also mean a stale dependency CLIR.');
}

/**
 * CLIR of the package's current tree into a temp file, or `null` with a reason.
 *
 * The context is supplied when the package is registered in the corpus:
 * without it, lowering a package with imports fails at the first qualified
 * reference. A package outside the corpus has no context and cannot have
 * one — it's lowered as-is, and any failure that comes back is about the
 * PACKAGE ITSELF, not an unsupplied input.
 */
async function loweredToScratch(scope, name) {
  const context = await resolveContext(scope);
  const args = context ? ['lower', scope.root, '--imports', context] : ['lower', scope.root];
  args.push(...expansionsArgs(scope.root));
  const result = await runLawc(args, scope.folder, PACKAGE_TIMEOUT_MS);
  if (!result || !(result.stdout ?? '').trim()) {
    output.appendLine(`lower ${scope.root}`
      + (context ? ' (with §23 resolve context)' : ' (no context — package outside the corpus)')
      + `:\n${result ? result.stderr : 'lawc did not start'}`);
    return null;
  }
  const file = scratchFile(name);
  fs.writeFileSync(file, result.stdout, 'utf8');
  return file;
}

/**
 * Package verbalization (B1, LS §3): a `.lawread.md` review document.
 *
 * Since DECISION-0128 the verbalizer exists in both implementations: the
 * reference is the oracle's `lawref verbalize`, the port is `lawc verbalize`
 * (the law-verbalize crate), the bytes are identical (ver goldens,
 * differential). The extension calls the compiler — the same binary as
 * check and lower, no second interpreter — and shows its stdout as-is. §3.3
 * totality gaps (LDC-E8201) and the content hash go to stderr; they are
 * surfaced to the human, not lost: incomplete verbalization means that for
 * the affected norms no "official text ↔ verbalization" pair was built, and
 * there is nothing to compare.
 */
async function verbalize() {
  const scope = await activePackage('verbalization');
  if (!scope) return;
  const ir = await loweredToScratch(scope, 'verbalize.lawir.json');
  if (!ir) {
    vscode.window.showWarningMessage('lawc lower did not produce CLIR — details in the "Arxo Law" channel.');
    return;
  }
  const result = await runLawc(corpus.verbalizeArgs(ir), scope.folder, PACKAGE_TIMEOUT_MS);
  const refusal = corpus.refusalOf(result);
  if (refusal) {
    output.appendLine(`lawc verbalize: ${refusal}`);
    vscode.window.showWarningMessage(
      `The compiler did not verbalize the package: ${refusal}. Details in the "Arxo Law" channel.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ content: result.stdout, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  const notes = (result.stderr ?? '').trim();
  if (notes) output.appendLine(`lawc verbalize ${scope.root}:\n${notes}`);
  if (notes.includes('LDC-E8201')) {
    vscode.window.showWarningMessage(
      'Verbalization is incomplete (LDC-E8201): for part of the norms no "text ↔ verbalization" pair '
      + 'was built — the gaps are named in the "Arxo Law" channel.');
  }
}

// ------------------------------------------- verbalizing a rule in place

//: Scope root → { generation, text, namespace, blocks: Map(node id → { text, heading, line, lines }), gaps }.
//: Verbalization is package-wide (lower + `lawref verbalize --json`), a
//: rule's paragraph is taken from it by node id; the cache holds until the
//: saved files change.
const VERBALIZE_LENS_KINDS = new Set([
  'rule', 'presumption', 'priority', 'constraint', 'decision', 'closure', 'fiction',
  'classification', 'definition', 'counterfactual', 'entrenchment', 'expand',
]);

// A scope's generation — all `.law`, law.toml, and law.lock by mtime and
// size: `lawc lower` reads disk, so verbalization is only accountable for
// SAVED files, and the cache is valid exactly until they change.
function packageGeneration(root) {
  let files;
  try {
    files = fs.statSync(root).isDirectory()
      ? [...packageLawFiles(root, null), path.join(root, 'law.toml'), path.join(root, 'law.lock')]
      : [root];
  } catch { files = [root]; }
  return files.map((file) => {
    try { const s = fs.statSync(file); return `${file}:${s.mtimeMs}:${s.size}`; } catch { return `${file}:-`; }
  }).join('\n');
}

// A document's verbalization scope: a §22 package, or a single file (an example, a vector).
async function verbalizeScope(document) {
  const { root, packaged } = await packageRootOf(document);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  return { root: packaged ? root : document.uri.fsPath, folder };
}

/** Scope verbalization from the cache by generation; `compute=false` — cache only. */
async function verbalizationFor(scope, compute) {
  const generation = packageGeneration(scope.root);
  const cached = verbalizations.get(scope.root);
  if (cached && cached.generation === generation) return cached;
  if (!compute || !scope.folder) return null;
  const ir = await loweredToScratch(scope, 'verbalize.lawir.json');
  if (!ir) return null;
  // The verbalizer is the Rust core (DECISION-0128): the same binary as
  // check and lower, no second interpreter; the bytes match the oracle's.
  const result = await runLawc(corpus.verbalizeArgs(ir, [], { json: true }), scope.folder, PACKAGE_TIMEOUT_MS);
  const refusal = corpus.refusalOf(result);
  if (refusal) {
    output.appendLine(`lawc verbalize --json: ${refusal}`);
    return null;
  }
  let payload;
  try { payload = JSON.parse(result.stdout); } catch (e) {
    output.appendLine(`lawc verbalize --json: response is not JSON — ${e && e.message ? e.message : e}`);
    return null;
  }
  const entry = { generation, ...blockIndex(payload) };
  verbalizations.set(scope.root, entry);
  verbalizedChanged.fire(verbalizedUri(scope.root));
  const notes = (result.stderr ?? '').trim();
  if (notes) output.appendLine(`lawc verbalize ${scope.root}:\n${notes}`);
  return entry;
}

// The nodes' namespace — from the scope's CLIR (a package has exactly one
// there); the file header is the fallback for a single file without lowering.
const namespaceOf = (entry, ast) => entry?.namespace ?? ast?.namespace?.uri ?? null;

/** Verbalization paragraphs for a declaration — from the cache only (hover doesn't call the oracle). */
async function spokenFor(document, ast, decl) {
  if (!VERBALIZE_LENS_KINDS.has(decl.kind)) return null;
  const entry = await verbalizationFor(await verbalizeScope(document), false);
  if (!entry) return null;
  const bodies = nodeIdsFor(namespaceOf(entry, ast), decl, entry.blocks)
    .map((id) => spokenBody(entry.blocks.get(id)?.text)).filter(Boolean);
  return bodies.length ? bodies.join('\n\n') : null;
}

// The `law-verbalize:` virtual document — the whole scope's verbalization;
// a rule's paragraph is shown from it via peek, next to the declaration.
// The scope root travels in the query: the editor stores Uri components
// decoded, and the root's slashes in the path would break the address.
function verbalizedUri(root) {
  const name = path.basename(root).replace(/\.law$/, '');
  return vscode.Uri.parse(`${VERBALIZE_SCHEME}:/${name}.lawread.md?${encodeURIComponent(root)}`);
}

function verbalizedContentProvider() {
  return {
    onDidChange: verbalizedChanged.event,
    provideTextDocumentContent(uri) {
      const raw = String(uri.query ?? '');
      let root;
      try { root = decodeURIComponent(raw); } catch { root = raw; }
      return verbalizations.get(root)?.text ?? 'Verbalization has not been built yet: the "in prose" lens above the rule.';
    },
  };
}

function withProgressMaybe(title, task) {
  if (typeof vscode.window.withProgress !== 'function') return task();
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task);
}

/**
 * Verbalizing a rule in place: `lawref verbalize` only knows how to handle a
 * package, so the package is verbalized once per file generation, and the
 * lens pulls its own node's paragraph out of it and shows it via peek under
 * the declaration. An expansion instance has several paragraphs — one per
 * generated node.
 */
async function verbalizeRule(fsPath, name) {
  const document = fsPath
    ? await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath))
    : vscode.window.activeTextEditor?.document;
  if (!document || !isLaw(document)) {
    vscode.window.showWarningMessage('Open a .law file: a rule\'s verbalization is taken from its package.');
    return;
  }
  const ast = await astFor(document);
  const decl = ast ? declarationNamed(ast, name) : null;
  if (!decl) {
    vscode.window.showInformationMessage(`\`${name}\`: declaration not found in the file.`);
    return;
  }
  const scope = await verbalizeScope(document);
  if (!scope.folder) {
    vscode.window.showWarningMessage('Verbalization: an open repository workspace folder is needed (the lawref oracle).');
    return;
  }
  const entry = await withProgressMaybe(`Verbalizing ${path.basename(scope.root)}…`, () => verbalizationFor(scope, true));
  if (!entry) {
    vscode.window.showWarningMessage('The oracle did not verbalize the package — details in the "Arxo Law" channel.');
    return;
  }
  const ids = nodeIdsFor(namespaceOf(entry, ast), decl, entry.blocks);
  if (!ids.length) {
    vscode.window.showInformationMessage(
      `\`${name}\`: the scope's CLIR (${namespaceOf(entry, ast) ?? 'no namespace'}) has no node `
      + 'with this id — the declaration does not lower, there is nothing to verbalize.');
    return;
  }
  const at = positionMapper(document);
  const anchor = toRange(at, decl.selection).start;
  const uri = verbalizedUri(scope.root);
  const locations = ids.map((id) => entry.blocks.get(id))
    .map((block) => new vscode.Location(uri, new vscode.Range(block.line, 0, block.line + block.lines, 0)));
  try {
    await vscode.commands.executeCommand('editor.action.peekLocations', document.uri, anchor, locations, 'peek');
  } catch (e) {
    output.appendLine(`peek verbalization: ${e && e.message ? e.message : e}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    editor.revealRange(locations[0].range, vscode.TextEditorRevealType.InCenter);
  }
  if (entry.gaps) {
    output.appendLine(`verbalization ${scope.root}: totality gaps ${entry.gaps} (LDC-E8201)`);
  }
}

function verbalizeLensProvider() {
  return {
    async provideCodeLenses(document) {
      if (!config().get('lens.verbalize', true) || surfaceOf(document.uri.fsPath) !== '.law') return [];
      const ast = await astFor(document);
      if (!ast) return [];
      const at = positionMapper(document);
      return declarations(ast)
        .filter((decl) => VERBALIZE_LENS_KINDS.has(decl.kind))
        .map((decl) => new vscode.CodeLens(toRange(at, decl.selection), {
          title: '☰ in prose',
          command: 'law.verbalizeRule',
          arguments: [document.uri.fsPath, decl.name],
        }));
    },
  };
}

/**
 * О-1 impact: what an edit will change against the committed corpus.
 *
 * "Before" is CLIR from `corpus/clir/`, "after" is a lowering of the
 * WORKING tree. The comparison base's address is asked of the registry
 * owner (`lawc clir-for`), because the "package → CLIR file" mapping is
 * maintained by `LOWERED_ACTS`, not by a rule over the name (parsing —
 * lib/corpus.js).
 *
 * Scenarios are taken from `<package>/scenarios/` if it exists; otherwise
 * the report is computed on the empty set and carries the §215 semantic
 * diff and coverage targets — exactly like the MCP server's
 * `law_draft_impact`. The report is computed by `lawc impact`
 * (DECISION-0133, a port of `lawref impact`); a nonzero exit code here is
 * not a failure but a verdict: 1 means "semantics changed".
 */
async function impact() {
  const scope = await activePackage('impact');
  if (!scope) return;
  const located = await runLawc(corpus.clirForArgs(scope.root), scope.folder, 30000);
  const refusal = corpus.refusalOf(located);
  if (refusal) {
    output.appendLine(`impact: no comparison base — ${refusal}`);
    vscode.window.showWarningMessage(
      'The package is not among the corpus outputs (LOWERED_ACTS): there is nothing to compare against. '
      + 'Details in the "Arxo Law" channel.');
    return;
  }
  const before = path.resolve(scope.folder, located.stdout.trim());
  const after = await loweredToScratch(scope, 'impact-after.lawir.json');
  if (!after) {
    vscode.window.showWarningMessage('lawc lower did not produce CLIR — details in the "Arxo Law" channel.');
    return;
  }
  let scenarios = corpus.scenarioDir(scope.root, (p) => fs.existsSync(p));
  if (!scenarios) {
    scenarios = scratchFile('scenarios');
    fs.mkdirSync(scenarios, { recursive: true });
  }
  // A exit code of 1 here is a "semantics changed" verdict, not a failure:
  // stdout is read, and stderr is printed only when the report is empty.
  const result = await runLawc(corpus.impactArgs(before, after, scenarios), scope.folder, 300000);
  if (!result || !(result.stdout ?? '').trim()) {
    output.appendLine(`lawc impact:\n${result ? result.stderr : 'law-cli did not start'}`);
    vscode.window.showWarningMessage('The impact report is empty — details in the "Arxo Law" channel.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ content: result.stdout, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  output.appendLine(`lawc impact ${scope.root}: base ${path.relative(scope.folder, before)}, `
    + `scenarios ${path.relative(scope.folder, scenarios) || '—'}`);
}

Object.assign(S, {
  activePackage,
  resolveContext,
  checkStrict,
  loweredToScratch,
  verbalize,
  packageGeneration,
  verbalizeScope,
  verbalizationFor,
  namespaceOf,
  spokenFor,
  verbalizedUri,
  verbalizedContentProvider,
  withProgressMaybe,
  verbalizeRule,
  verbalizeLensProvider,
  impact,
});

S.verbalizedChanged = S.verbalizedChanged ?? new vscode.EventEmitter();

}
}
})();
