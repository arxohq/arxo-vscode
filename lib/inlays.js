
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
// Inlays, dependency cards, scene lens, Test Explorer.

// ------------------------------------------- label inlays and the scenes lens

// ASTs of all files in the document's package: its own — from the version
// cache, siblings — from the mtime cache (siblingAst). Order matches the
// compiler's (§211).
async function packageAsts(document, ast) {
  const files = [{ ast, origin: null, file: document.uri.fsPath }];
  const { root, packaged } = await packageRootOf(document);
  if (!packaged) return files;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const siblings = packageLawFiles(root, document.uri.fsPath);
  const fetched = await mapLimit(siblings, 8, (sibling) => siblingAst(sibling, folder));
  fetched.forEach((entry, index) => {
    if (entry) files.push({ ast: entry.ast, origin: path.basename(siblings[index]), file: siblings[index] });
  });
  return files;
}

// ------------------------------------------------ `pkg::name` dependencies

// Behind `openstax.relativity::speed_of_light` are declarations of ANOTHER
// package (§23–§25). Two tiers (lib/dependencies.js): the dependency's
// source, if its law.toml with the same `name` is found in the workspace —
// the same parsing as for siblings (siblingAst, mtime cache), with labels,
// signatures, a slice, and go-to; otherwise CLIR from `corpus/clir` via the
// `lawc imports-context --index` index — labels, signatures, and visibility
// exist, spans don't. Private declarations of a dependency don't make it
// into the indexes (§24), and the card says so plainly. Setting
// `law.dependencies`: auto | source | off.
const CLIR_INDEX_TTL_MS = 60000;

function dependencyMode() {
  const mode = String(config().get('dependencies', 'auto'));
  return ['auto', 'source', 'off'].includes(mode) ? mode : 'auto';
}

function packageDirIndex(folder) {
  const key = folder ?? '';
  let index = packageDirs.get(key);
  if (!index) {
    const dirs = folder ? manifestsUnder(folder) : [];
    index = dependenciesLib.packageDirIndex(dirs, readCached, path.join);
    packageDirs.set(key, index);
  }
  return index;
}

// The CLIR index — from the compiler (DECISION-0128 §7): it looks for
// `corpus/clir` upward from the package root. The cache is short-lived: a
// new sibling CLIR appears without editing law.toml, and a one-minute delay
// here is cheaper than a rescan on every hover.
async function clirIndex(root, folder) {
  const key = folder ?? root;
  const hit = clirIndexes.get(key);
  if (hit && Date.now() - hit.at < CLIR_INDEX_TTL_MS) return hit.index;
  const result = await runLawc(['imports-context', '--index'], folder, PACKAGE_TIMEOUT_MS, { cwd: root });
  const index = result && !result.error && result.stdout ? dependenciesLib.parseClirIndex(result.stdout) : new Map();
  if (!index.size && result?.stderr) output.appendLine(`CLIR index for dependencies: ${result.stderr.trim().split('\n')[0]}`);
  clirIndexes.set(key, { at: Date.now(), index });
  return index;
}

function clirAst(file) {
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const hit = clirCache.get(file);
  if (hit && hit.mtime === mtime) return hit.ast;
  let ast = null;
  try { ast = dependenciesLib.parseClir(fs.readFileSync(file, 'utf8'), file); } catch { ast = null; }
  if (!ast) output.appendLine(`dependency CLIR did not parse: ${file}`);
  clirCache.set(file, { mtime, ast });
  return ast;
}

/**
 * The document's dependency files [{ ast, origin, file, package, tier }]:
 * `tier` is `source` (a directory in the workspace; `entry` is a siblingAst
 * record with a slice and a map) or `clir` (a pseudo-AST from CLIR). Package
 * names come from the manifest's `[dependencies]` and the file's qualified
 * references.
 */
async function dependencyAsts(document, ast) {
  const mode = dependencyMode();
  if (mode === 'off' || !ast) return [];
  const { root, packaged } = await packageRootOf(document);
  const dir = packaged ? root : path.dirname(document.uri.fsPath);
  const names = dependenciesLib.dependencyNames(ast, readCached(path.join(dir, 'law.toml')) ?? '');
  if (!names.length) return [];
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const dirs = packageDirIndex(folder);
  const out = [];
  const viaClir = [];
  for (const name of names) {
    const target = dirs.get(name);
    if (target && target !== dir) {
      const files = packageLawFiles(target, null);
      const fetched = await mapLimit(files, 8, (file) => siblingAst(file, folder));
      fetched.forEach((entry, i) => {
        if (entry) out.push({ ast: entry.ast, entry, origin: `${name} · ${path.basename(files[i])}`, file: files[i], package: name, tier: 'source' });
      });
    } else if (mode === 'auto') viaClir.push(name);
  }
  if (viaClir.length) {
    const index = await clirIndex(dir, folder);
    for (const name of viaClir) {
      const file = index.get(name);
      const clir = file ? clirAst(file) : null;
      if (clir) out.push({ ast: clir, entry: null, origin: `${name} · CLIR`, file, package: name, tier: 'clir' });
      else output.appendLine(`dependency ${name}: neither a directory in the workspace nor a CLIR in corpus/clir`);
    }
  }
  return out;
}

/** The document package's AST plus its dependencies' ASTs — the world for hover hints and inlays. */
async function worldAsts(document, ast) {
  const own = await packageAsts(document, ast);
  return own.concat(await dependencyAsts(document, ast));
}

/**
 * The declaration behind a qualified reference at a byte offset: { ref,
 * file, entry, decl, tier, package } or { ref } without a declaration (the
 * package or name was not found), or null if the cursor is not on `pkg::name`.
 */
async function qualifiedDeclaration(document, ast, hit) {
  const contains = spanContains(document, hit.offset);
  const ref = dependenciesLib.qualifiedAt(ast, contains);
  if (!ref) return null;
  for (const dep of await dependencyAsts(document, ast)) {
    if (dep.package !== ref.package) continue;
    const decl = declarationNamed(dep.ast, ref.name);
    if (decl) return { ref, file: dep.file, entry: dep.entry, decl, tier: dep.tier, package: dep.package, origin: dep.origin };
  }
  return { ref };
}

// Card for a dependency declaration: like a sibling's — with the package
// label and tier. Without `pub` — say so plainly: the name isn't visible
// outside the package (§24, LDC-E1105 in the strict check), and staying
// silent here would look like "not found".
async function qualifiedCard(document, ast, found, words) {
  const { ref } = found;
  if (!found.decl) {
    return new vscode.Hover(new vscode.MarkdownString(
      `\`${ref.package}::${ref.name}\` — declaration not found: package \`${ref.package}\` is neither in the workspace nor in \`corpus/clir\`, `
      + 'or the name is not declared in it. Details — in the "Arxo Law" channel.'));
  }
  const { decl, entry } = found;
  const notes = [];
  if (!decl.public) notes.push('**no `pub`** — the name is not visible outside the package (§24)');
  if (found.tier === 'clir') notes.push(`via CLIR \`${path.basename(found.file)}\` — the source of package \`${found.package}\` was not found in the workspace, no go-to`);
  const compact = config().get('hover.detail', 'full') !== 'full' || found.tier === 'clir';
  const dictionaryEntry = words[decl.kind];
  let text;
  if (compact) {
    text = card({ entry: dictionaryEntry, decl, node: decl.node, compact: true, origin: found.origin });
    const labels = labelsOfNode(decl.node);
    if (labels.length) text = `${text.split('\n\n')[0]}\n\n${labels.join('\\\n')}\n\n${text.split('\n\n').slice(1).join('\n\n')}`;
  } else {
    const maxLines = Math.max(1, config().get('hover.maxLines', 14));
    let slice = null;
    let comment = null;
    if (entry && decl.span) {
      const start = entry.index(decl.span.start);
      slice = sourceSlice(entry.text.slice(start, entry.index(decl.span.end)), maxLines);
      comment = leadingComment(entry.text, start);
    }
    text = card({ decl, node: decl.node, entry: dictionaryEntry, slice, comment, origin: found.origin });
  }
  if (notes.length) text = `${text}\n\n*${notes.join(' · ')}*`;
  return new vscode.Hover(new vscode.MarkdownString(text), toRange(positionMapper(document), ref.nameSpan));
}

// A §218 label next to a relation name: `cast_intentionally «the spell was
// cast intentionally»`. Language and length are settings; a label in
// another language is not substituted. A parameter name before a call
// argument, or the type after it — `recession_speed(g: Galaxy, v: Quantity)`,
// `composition(…, atoms: k)`; form and mode are settings, both kinds of
// inlays can be disabled independently.
function inlayHintsProvider() {
  return {
    async provideInlayHints(document, range) {
      const showLabels = config().get('inlay.labels', true);
      const parametersMode = String(config().get('inlay.parameters', 'all'));
      const showParameters = parametersMode !== 'off';
      if (!showLabels && !showParameters) return [];
      const ast = await astFor(document);
      if (!ast) return [];
      const language = config().get('inlay.language', 'ru-KZ');
      const max = Math.max(8, Number(config().get('inlay.maxLength', 40)) || 40);
      const files = await worldAsts(document, ast);
      const index = labelIndex(files, language);
      const at = positionMapper(document);
      const hints = [];
      const visible = (position) => position.line >= range.start.line && position.line <= range.end.line;
      if (showParameters) {
        const form = String(config().get('inlay.parameterForm', 'smart'));
        for (const inlay of parameterInlays(ast, signatureIndex(files), { skipMatching: parametersMode === 'differing', form })) {
          const before = inlay.side === 'before';
          const position = at(before ? inlay.span.start : inlay.span.end);
          if (!visible(position)) continue;
          const kind = before ? vscode.InlayHintKind.Parameter : vscode.InlayHintKind.Type;
          const hint = new vscode.InlayHint(new vscode.Position(position.line, position.character), inlay.text, kind);
          if (before) hint.paddingRight = true;
          hint.tooltip = new vscode.MarkdownString(inlay.tooltip);
          hints.push(hint);
        }
      }
      if (!showLabels) return hints;
      for (const use of labelUses(ast)) {
        const label = index.get(use.name);
        if (!label) continue;
        const position = at(use.span.end);
        if (position.line < range.start.line || position.line > range.end.line) continue;
        const hint = new vscode.InlayHint(new vscode.Position(position.line, position.character), `«${hintText(label.text, max)}»`);
        hint.paddingLeft = true;
        hint.tooltip = new vscode.MarkdownString(
          `«${label.text}»\n\n\`${label.language}\` · ${label.status}${label.origin ? ` · declared in \`${label.origin}\`` : ''}`);
        hints.push(hint);
      }
      // `expand` instances: the definition's version and pin after the
      // reference, `min N` after a list name — things otherwise only
      // readable from law.toml and the lock file.
      if ((ast.decls ?? []).some((d) => d.kind?.kind === 'expand')) {
        const { root, packaged } = await packageRootOf(document);
        const dir = packaged ? root : path.dirname(document.uri.fsPath);
        const specs = expansionSpecs(dir);
        const locked = lockedAliases(dir);
        const definitions = new Map();
        for (const alias of new Set((ast.decls ?? []).filter((d) => d.kind?.kind === 'expand').map((d) => d.kind.reference?.text).filter(Boolean))) {
          definitions.set(alias, (await expansionDefinition(document, alias, ast))?.decl ?? null);
        }
        const specFor = (alias) => {
          const spec = specs.get(alias);
          return spec ? { ...spec, pinned: locked ? locked.has(alias) : null } : null;
        };
        for (const inlay of instanceInlays(ast, (alias) => definitions.get(alias) ?? null, specFor)) {
          const position = at(inlay.span.end);
          if (position.line < range.start.line || position.line > range.end.line) continue;
          const hint = new vscode.InlayHint(new vscode.Position(position.line, position.character), inlay.text);
          hint.paddingLeft = true;
          hint.tooltip = new vscode.MarkdownString(inlay.tooltip);
          hints.push(hint);
        }
      }
      return hints;
    },
  };
}


// "Who checks this rule": a lens over a rule, an `expand` instance, a
// presumption, a constraint, and a relation — the package's `.lawtest`
// scenes and corpus scenario files that mention the heads. Zero is also an
// answer: "no scenes" surfaces the coverage debt where it arose, not in a
// gate report.
const SCENE_LENS_KINDS = new Set(['rule', 'presumption', 'constraint', 'priority', 'expand', 'relation', 'closure', 'decision']);

function sceneLensProvider() {
  return {
    async provideCodeLenses(document) {
      if (!config().get('lens.scenes', true) || surfaceOf(document.uri.fsPath) !== '.law') return [];
      const ast = await astFor(document);
      if (!ast) return [];
      const { root, packaged } = await packageRootOf(document);
      const dir = packaged ? root : path.dirname(document.uri.fsPath);
      const scenes = sceneIndex(textsOfFiles(filesUnder(dir, '.lawtest')));
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const acts = folder ? path.join(folder, 'corpus', 'kz', 'acts') : null;
      const namespace = ast.namespace?.uri ?? null;
      const scenarios = acts && fs.existsSync(acts) ? scenarioIndex(textsOfFiles(filesUnder(acts, '.py')), namespace) : new Map();
      const at = positionMapper(document);
      const lenses = [];
      const specs = expansionSpecs(dir);
      const locked = lockedAliases(dir);
      for (const decl of declarations(ast)) {
        if (!SCENE_LENS_KINDS.has(decl.kind)) continue;
        const definition = decl.kind === 'expand'
          ? await expansionDefinition(document, decl.node.kind?.reference?.text, ast) : null;
        const places = placesFor(headsOf(decl.node, definition?.decl ?? null), scenes, scenarios);
        const range = toRange(at, decl.selection);
        lenses.push(new vscode.CodeLens(range, {
          title: lensTitle(places),
          command: 'law.showScenes',
          arguments: [places, decl.name],
        }));
        if (decl.kind === 'expand') {
          // Generated N nodes · definition and version · pin: a click leads to the definition.
          const alias = decl.node.kind?.reference?.text;
          const count = definition ? emitCount(definition.decl, decl.node) : null;
          const spec = specs.get(alias);
          const pin = locked === null ? 'no law.lock' : locked.has(alias) ? 'pinned in law.lock' : 'no pin (E1340)';
          const title = `${count ? `generated ${count.total} ${plural(count.total, ['node', 'nodes', 'nodes'])}${count.priorities || count.templates ? ` (${count.rules} rules${count.priorities ? `, ${count.priorities} priorities` : ''}${count.templates ? `, ${count.templates} norm templates` : ''})` : ''}` : 'definition not found'}`
            + ` · ${alias}${spec?.version ? ` v${spec.version}` : ''} · ${pin}`;
          lenses.push(new vscode.CodeLens(range, definition
            ? { title, command: 'vscode.open', arguments: [vscode.Uri.file(definition.file), { selection: toRange(definition.entry.at, definition.decl.kind?.name?.span ?? definition.decl.span) }] }
            : { title, command: '' }));
        }
        if (decl.kind === 'rule' || decl.kind === 'expand') {
          lenses.push(new vscode.CodeLens(range, {
            title: '✎ scene from rule',
            command: 'law.sceneFromRule',
            arguments: [document.uri.fsPath, decl.name],
          }));
        }
      }
      return lenses;
    },
  };
}

// Regenerating the law.lock `expansions` section (DECISION-0126 §3.6): corpus
// packages — `lawc lock --relock-expansions --no-resources --write` (which
// also refreshes `packages`), other packages — `lawc lock
// --relock-expansions-only` into the existing lock. There is no semantics in
// the extension: pins are computed by the core (DECISION-0131), the
// extension only calls it and re-checks the file.
async function relockExpansions(fsPath) {
  const target = fsPath ?? vscode.window.activeTextEditor?.document?.uri.fsPath;
  if (!target) return;
  const uri = vscode.Uri.file(target);
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  const { root, packaged } = await packageRootOf({ uri });
  if (!packaged || !folder) {
    vscode.window.showWarningMessage('Regenerating law.lock: the file is outside a package (no law.toml) or outside the workspace.');
    return;
  }
  // A corpus package — a full lock rebuild from the dependency CLIRs' bytes
  // (`gen_kz_clir --relock-expansions` mode); other packages — only the
  // expansions section in the existing lock (the previous RELOCK_SCRIPT).
  // Both modes go through `lawc lock` (DECISION-0131), no Python needed.
  const inCorpus = root.startsWith(path.join(folder, 'corpus', 'laws') + path.sep);
  const args = inCorpus
    ? ['lock', root, '--relock-expansions', '--no-resources', '--write']
    : ['lock', root, '--relock-expansions-only'];
  const result = await runLawc(args, folder, PACKAGE_TIMEOUT_MS);
  if (!result || result.error) {
    output.appendLine(`relock ${root}: ${result ? result.stderr || result.stdout : 'lawc not found'}`);
    vscode.window.showWarningMessage('law.lock was not regenerated — details in the "Arxo Law" channel.');
    return;
  }
  output.appendLine(`relock ${root}: ${(result.stdout || result.stderr || '').trim()}`);
  packageRoots.clear();
  for (const d of vscode.workspace.textDocuments ?? []) if (isLaw(d)) scheduleCheck(d, 0);
  vscode.window.showInformationMessage(`law.lock of package ${path.basename(root)}: the expansions section was rewritten.`);
}

// §267 scene skeleton from a rule: facts from the body's conjuncts, a query
// on the head; opens as a new unsaved `.lawtest` so the author can fill in
// values and place the file in the package's tests/. The date is today's:
// this is a draft, not an artifact.
async function sceneFromRule(fsPath, name) {
  const target = fsPath ?? vscode.window.activeTextEditor?.document?.uri.fsPath;
  if (!target || !name) return;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  const ast = await astFor(document);
  const decl = ast ? (ast.decls ?? []).find((d) => d.kind?.name?.text === name) : null;
  if (!decl) {
    vscode.window.showWarningMessage(`Scene from rule: \`${name}\` was not found in ${path.basename(target)}.`);
    return;
  }
  const definition = decl.kind?.kind === 'expand' ? await expansionDefinition(document, decl.kind.reference?.text, ast) : null;
  const content = sceneSkeleton(decl, { definition: definition?.decl ?? null, date: new Date().toISOString().slice(0, 10) });
  const scene = await vscode.workspace.openTextDocument({ language: 'law', content });
  await vscode.window.showTextDocument(scene, { preview: false });
  return content;
}

// Test Explorer: workspace scene files are suites, scenes are tests; the run
// uses the same `lawc test … --json` as law.runTest. The API is optional:
// without `vscode.tests` (an old editor, a test rig) there's no panel, but
// everything else keeps working.

function testExplorer(context) {
  if (!vscode.tests?.createTestController) return null;
  const controller = vscode.tests.createTestController('law', 'Arxo Law');
  testController = controller;
  context.subscriptions.push(controller);
  const items = new Map();
  const fileItem = (file) => {
    let item = controller.items.get(file);
    if (!item) {
      item = controller.createTestItem(file, path.basename(file), vscode.Uri.file(file));
      controller.items.add(item);
    }
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return item; }
    item.children.replace([]);
    for (const scene of testing.sceneItems(file, text)) {
      const child = controller.createTestItem(scene.id, scene.label, vscode.Uri.file(file));
      child.range = new vscode.Range(scene.line, 0, scene.line, 0);
      item.children.add(child);
      items.set(scene.id, child);
    }
    return item;
  };
  controller.resolveHandler = async () => {
    const found = vscode.workspace.findFiles
      ? await vscode.workspace.findFiles('**/*.lawtest', '**/{node_modules,target,dist,.claude,release}/**') : [];
    for (const uri of found) fileItem(uri.fsPath);
  };
  const run = async (request, token) => {
    const testRun = controller.createTestRun(request);
    const requested = request.include ?? [...controller.items].map(([, item]) => item);
    const flat = requested.map((item) => ({ id: item.id, item }));
    for (const { file, only } of testing.plan(flat)) {
      if (token?.isCancellationRequested) break;
      const parent = fileItem(file);
      const scenes = [...parent.children].map(([, child]) => ({ id: child.id, label: child.label, item: child }));
      const chosen = only.length ? scenes.filter((sc) => only.includes(sc.id)) : scenes;
      const { program, reason } = testing.programForTest(file);
      if (!program) {
        for (const sc of chosen) testRun.errored(sc.item, new vscode.TestMessage(reason));
        continue;
      }
      for (const sc of chosen) testRun.started(sc.item);
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath;
      const result = await runLawc(['test', file, '--program', program, '--json'], folder, PACKAGE_TIMEOUT_MS);
      const report = result ? parseVerdictsJson(result.stdout, result.stderr) : null;
      for (const verdict of testing.applyReport(report, chosen)) {
        const sc = chosen.find((c) => c.id === verdict.id);
        const messages = verdict.messages.map((m) => new vscode.TestMessage(m));
        if (verdict.status === 'passed') testRun.passed(sc.item);
        else if (verdict.status === 'failed') testRun.failed(sc.item, messages);
        else if (verdict.status === 'skipped') testRun.skipped(sc.item);
        else testRun.errored(sc.item, messages);
      }
    }
    testRun.end();
  };
  controller.createRunProfile('Run (lawc test)', vscode.TestRunProfileKind.Run, run, true);
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((d) => {
    if (surfaceOf(d.uri.fsPath) === '.lawtest') fileItem(d.uri.fsPath);
  }));
  testExplorerState = { controller, fileItem, run };
  return testExplorerState;
}

Object.assign(S, {
  packageAsts,
  dependencyMode,
  packageDirIndex,
  clirIndex,
  clirAst,
  dependencyAsts,
  worldAsts,
  qualifiedDeclaration,
  qualifiedCard,
  inlayHintsProvider,
  sceneLensProvider,
  relockExpansions,
  sceneFromRule,
  testExplorer,
});

}
}
})();
