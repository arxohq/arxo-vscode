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

  context.subscriptions.push(
    S.output,
    S.collection,
    S.strictCollection,
    S.queryCollection,
    S.status,
    vscode.tasks.registerTaskProvider('law', S.taskProvider()),
    vscode.commands.registerCommand('law.showOutput', () => S.output.show(true)),
    vscode.window.onDidChangeActiveTextEditor(() => S.updateStatus()),
    vscode.languages.registerHoverProvider(S.LAW, S.hoverProvider(context, false)),
    vscode.languages.registerHoverProvider(S.LITERATE, S.hoverProvider(context, true)),
    vscode.languages.registerCodeActionsProvider(S.LAW, S.codeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCodeActionsProvider(S.LITERATE, S.codeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerDocumentSymbolProvider(S.LAW, S.symbolProvider()),
    vscode.languages.registerDocumentSymbolProvider(S.LITERATE, S.symbolProvider()),
    vscode.languages.registerDocumentSemanticTokensProvider(S.LAW, S.semanticTokensProvider(legend), legend),
    vscode.languages.registerDocumentSemanticTokensProvider(S.LITERATE, S.semanticTokensProvider(legend), legend),
    vscode.languages.registerDefinitionProvider(S.LAW, S.definitionProvider(false)),
    vscode.languages.registerDefinitionProvider(S.LITERATE, S.definitionProvider(true)),
    vscode.languages.registerReferenceProvider(S.LAW, S.referenceProvider(false)),
    vscode.languages.registerReferenceProvider(S.LITERATE, S.referenceProvider(true)),
    vscode.languages.registerDocumentHighlightProvider(S.LAW, S.highlightProvider(false)),
    vscode.languages.registerDocumentHighlightProvider(S.LITERATE, S.highlightProvider(true)),
    vscode.languages.registerCompletionItemProvider(S.LAW, S.completionProvider(context)),
    vscode.languages.registerCompletionItemProvider(S.LITERATE, S.completionProvider(context)),
    vscode.languages.registerDocumentFormattingEditProvider(S.LAW, S.formattingProvider()),
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
    vscode.languages.registerInlayHintsProvider(S.LAW, S.inlayHintsProvider()),
    vscode.languages.registerInlayHintsProvider(S.LITERATE, S.inlayHintsProvider()),
    vscode.commands.registerCommand('law.showScenes', (places, name) => S.showScenes(places, name)),
    vscode.commands.registerCommand('law.relockExpansions', (fsPath) => S.relockExpansions(fsPath)),
    vscode.commands.registerCommand('law.sceneFromRule', (fsPath, name) => S.sceneFromRule(fsPath, name)),
    vscode.commands.registerCommand('law.showClirNode', (fsPath, name) => S.showClirNode(fsPath, name)),
    vscode.languages.registerRenameProvider(S.LAW, S.renameProvider(context, false)),
    vscode.languages.registerRenameProvider(S.LITERATE, S.renameProvider(context, true)),
    vscode.languages.registerWorkspaceSymbolProvider(S.workspaceSymbolProvider()),
    vscode.workspace.registerTextDocumentContentProvider('law-clir', S.clirContentProvider()),
    vscode.languages.registerDefinitionProvider([{ scheme: 'law-clir' }, { language: 'json', pattern: '**/*.json' }], S.clirDefinitionProvider()),
    vscode.window.registerTreeDataProvider('lawPackage', S.packageTree),
    vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor && S.isLaw(editor.document)) S.packageTree.show(editor.document); }),
    vscode.workspace.onDidOpenTextDocument((d) => S.scheduleCheck(d, 0)),
    vscode.workspace.onDidSaveTextDocument((d) => S.scheduleCheck(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => S.scheduleCheck(e.document)),
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
        for (const d of vscode.workspace.textDocuments) S.scheduleCheck(d, 0);
      }
    }),
  );

  registerSyntaxPreview(vscode, context, S.parseSyntaxSnapshot);
  for (const d of vscode.workspace.textDocuments) S.scheduleCheck(d, 0);
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
}

module.exports = {
  activate,
  deactivate,
  __engine: () => S.wasmEngine,
  __testing: () => S.testExplorerState,
  __package: () => S.packageTree,
};
