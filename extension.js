'use strict';
// Law DSL extension: composition root. Host logic lives in lib/run.js,
// lib/hover-host.js, lib/navigation.js, lib/inlays.js, lib/commands.js,
// lib/package-commands.js and lib/query-host.js. Shared mutable state is
// lib/session.js — vscode is injected here so a smoke-test re-require of
// this file picks up a swapped stub.

const vscode = require('vscode');
const fs = require('node:fs');
const S = require('./lib/session');
S.vscode = vscode;
require('./lib/run');
require('./lib/hover-host');
require('./lib/navigation');
require('./lib/inlays');
require('./lib/commands');
require('./lib/package-commands');
require('./lib/query-host');

const { registerSyntaxPreview } = require('./lib/syntax-preview');
const lsp = require('./lib/lsp-client');
const { legacyEditorProviders } = require('./lib/legacy-providers');


function activate(context) {
  S.boot(require('vscode'));
  S.activeContext = context;
  S.testExplorer(context);
  S.output = vscode.window.createOutputChannel('Arxo Law');
  S.collection = vscode.languages.createDiagnosticCollection('law');
  S.strictCollection = vscode.languages.createDiagnosticCollection('law-strict');
  S.queryCollection = vscode.languages.createDiagnosticCollection('lawq');
  const legend = new vscode.SemanticTokensLegend(S.TOKEN_TYPES, S.TOKEN_MODIFIERS);
  S.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  S.status.command = 'law.showOutput';
  const legacy = legacyEditorProviders(vscode, S, context, legend);
  const activateLegacy = () => {
    S.lspStarting = false;
    S.lspActive = false;
    context.subscriptions.push(...legacy.restoreProviders());
    for (const d of vscode.workspace.textDocuments) if (!S.lspHandles(d)) S.scheduleCheck(d, 0);
  };
  let lspOwnsDiagnostics = false;
  const lspDisposable = lsp.start(vscode, context, S.output, {
    onReady: () => { S.lspStarting = false; S.lspActive = lspOwnsDiagnostics; },
    onFallback: activateLegacy,
  });
  if (lspDisposable) legacy.disposeProviders(lspDisposable.providers);
  lspOwnsDiagnostics = Boolean(lspDisposable?.diagnostics);
  S.lspStarting = lspOwnsDiagnostics;

  context.subscriptions.push(
    S.output,
    S.collection,
    S.strictCollection,
    S.queryCollection,
    S.status,
    ...(lspDisposable ? [lspDisposable] : []),
    vscode.tasks.registerTaskProvider('law', S.taskProvider()),
    vscode.commands.registerCommand('law.showOutput', () => S.output.show(true)),
    vscode.window.onDidChangeActiveTextEditor(() => S.updateStatus()),
    ...legacy.subscriptions,
    vscode.commands.registerCommand('law.check', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) S.scheduleCheck(editor.document, 0);
    }),
    vscode.commands.registerCommand('law.showClir', () => S.showLawcJson('lower', 'CLIR')),
    vscode.commands.registerCommand('law.showExpanded', () => S.showLawcJson('expand', 'expand')),
    vscode.commands.registerCommand('law.semanticHash', () => S.showSemanticHash()),
    vscode.commands.registerCommand('law.evalVector', (dir) => S.evalVector(dir)),
    vscode.commands.registerCommand('law.diffVector', (dir) => S.diffVector(dir)),
    vscode.commands.registerCommand('law.showProof', (dir) => S.showProof(dir)),
    vscode.commands.registerCommand('law.whyNot', (dir) => S.showWhyNot(dir)),
    vscode.commands.registerCommand('law.runTest', (file) => S.runTest(file)),
    vscode.commands.registerCommand('law.checkStrict', () => S.checkStrict()),
    vscode.commands.registerCommand('law.verbalize', () => S.verbalize()),
    vscode.commands.registerCommand('law.impact', () => S.impact()),
    vscode.commands.registerCommand('law.revealProofSource', (node, origin) => S.revealProofSource(node, origin)),
    vscode.commands.registerCommand('law.query', () => S.runQuery()),
    vscode.commands.registerCommand('law.queryJson', () => S.runQuery({ raw: true })),
    vscode.commands.registerCommand('law.querySchema', () => S.showQuerySchema()),
    vscode.commands.registerCommand('law.queryCatalog', () => S.showQueryCatalog()),
    vscode.languages.registerCompletionItemProvider(S.LAWQ, S.queryCompletionProvider(), '.', '"'),
    vscode.languages.registerHoverProvider(S.LAWQ, S.queryHoverProvider()),
    vscode.window.registerTreeDataProvider('lawProof', S.proofTree),
    vscode.window.registerTreeDataProvider('lawWhyNot', S.whyNotPanel),
    vscode.languages.registerCodeLensProvider(S.LAW, S.codeLensProvider()),
    vscode.languages.registerCodeLensProvider(S.LAW, S.sceneLensProvider()),
    vscode.languages.registerCodeLensProvider(S.LAW, S.verbalizeLensProvider()),
    vscode.commands.registerCommand('law.verbalizeRule', (fsPath, name) => S.verbalizeRule(fsPath, name)),
    vscode.workspace.registerTextDocumentContentProvider(S.VERBALIZE_SCHEME, S.verbalizedContentProvider()),
    vscode.commands.registerCommand('law.showScenes', (places, name) => S.showScenes(places, name)),
    vscode.commands.registerCommand('law.relockExpansions', (fsPath) => S.relockExpansions(fsPath)),
    vscode.commands.registerCommand('law.sceneFromRule', (fsPath, name) => S.sceneFromRule(fsPath, name)),
    vscode.commands.registerCommand('law.showClirNode', (fsPath, name) => S.showClirNode(fsPath, name)),
    vscode.workspace.registerTextDocumentContentProvider('law-clir', S.clirContentProvider()),
    vscode.languages.registerDefinitionProvider([{ scheme: 'law-clir' }, { language: 'json', pattern: '**/*.json' }], S.clirDefinitionProvider()),
    vscode.window.registerTreeDataProvider('lawPackage', S.packageTree),
    vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor && S.isLaw(editor.document)) S.packageTree.show(editor.document); }),
    vscode.workspace.onDidOpenTextDocument((d) => { if (!S.lspHandles(d)) S.scheduleCheck(d, 0); }),
    vscode.workspace.onDidSaveTextDocument((d) => { if (!S.lspHandles(d)) S.scheduleCheck(d, 0); }),
    vscode.workspace.onDidChangeTextDocument((e) => { if (!S.lspHandles(e.document)) S.scheduleCheck(e.document); }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'lawq') S.queryCollection.delete(e.document.uri);
    }),
    (() => {
      const manifests = vscode.workspace.createFileSystemWatcher('**/law.toml');
      const reset = () => {
        S.packageRoots.clear();
        S.consumersCache.clear();
        S.namespaceRoots.clear();
        S.packageDirs.clear();
        S.clirIndexes.clear();
      };
      manifests.onDidCreate(reset);
      manifests.onDidChange(reset);
      manifests.onDidDelete(reset);
      return manifests;
    })(),
    vscode.workspace.onDidCloseTextDocument((d) => {
      S.collection.delete(d.uri);
      S.strictCollection.delete(d.uri);
      S.queryCollection.delete(d.uri);
      S.astCache.delete(d.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('law.lawcPath')) S.resolvedBin = null;
      if (e.affectsConfiguration('law.query.corpus')) S.querySchema = null;
      if (e.affectsConfiguration('law')) {
        for (const d of vscode.workspace.textDocuments) if (!S.lspHandles(d)) S.scheduleCheck(d, 0);
      }
    }),
  );

  registerSyntaxPreview(vscode, context, S.parseSyntaxSnapshot);
  for (const d of vscode.workspace.textDocuments) if (!S.lspHandles(d)) S.scheduleCheck(d, 0);
  S.updateStatus();
}

function deactivate() {
  S.wasmEngine?.dispose();
  S.wasmEngine = null;
  for (const t of S.timers.values()) clearTimeout(t);
  S.timers.clear();
  S.astCache.clear();
  S.lastCheck.clear();
  S.lastVerdict.clear();
  if (S.tempRoot) fs.rmSync(S.tempRoot, { recursive: true, force: true });
  S.tempRoot = null;
  S.lspActive = false;
  S.lspStarting = false;
}

module.exports = {
  activate,
  deactivate,
  __engine: () => S.wasmEngine,
  __testing: () => S.testExplorerState,
  __package: () => S.packageTree,
};
