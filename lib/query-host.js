
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
// LawQL providers, tasks.

// ------------------------------------------------------------- LawQL (.lawq)

/**
 * Queries against the formalization: `lawc query` (DECISION-0129;
 * docs/authoring/reference/authoring/QL-COOKBOOK.ru.md).
 *
 * There is one executor — the oracle; the extension sends it the file (or
 * the selection's / unsaved buffer's text) with `--json`, lays the
 * canonical `queryResult` out as a table in a neighboring tab, and puts
 * `queryError` into Problems using the oracle's line and column. There is
 * nothing to compute over the result here, and it's not allowed to
 * (invariant 5): all that's shown is the row values as they arrived.
 *
 * The snapshot schema (`--schema --json`, ~3s for the whole corpus) is
 * asked for once per session and feeds field and relation completion; until
 * it arrives, only keywords and functions are offered — they don't depend
 * on the snapshot.
 */


function queryOptions() {
  const c = config();
  return {
    corpus: c.get('query.corpus', '*'),
    limit: c.get('query.limit', 0),
  };
}

function lawqlFolder(document) {
  const folder = vscode.workspace.getWorkspaceFolder(document?.uri)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showWarningMessage('LawQL: open the repository workspace folder — the law-cli binary and corpus/clir are looked up from it.');
    return null;
  }
  return folder;
}

function schemaFor(folder) {
  if (querySchema) return Promise.resolve(querySchema);
  if (!querySchemaPending) {
    querySchemaPending = runLawc(lawql.schemaArgs(queryOptions().corpus), folder, QUERY_TIMEOUT_MS)
      .then((result) => {
        const doc = lawql.parseOutput(result?.stdout);
        if (doc && doc.kind === 'querySchema') querySchema = doc;
        else output.appendLine(`lawc query --schema: ${corpus.refusalOf(result) ?? 'response is not querySchema'}`);
        querySchemaPending = null;
        return querySchema;
      });
  }
  return querySchemaPending;
}

function publishQueryError(document, error) {
  const line = Math.max(0, (error.line ?? 1) - 1);
  const column = Math.max(0, (error.column ?? 1) - 1);
  const lineText = document.lineCount > line ? document.lineAt(line).text : '';
  const end = error.line ? Math.max(column + 1, lineText.length) : 0;
  const item = new vscode.Diagnostic(
    new vscode.Range(line, column, line, error.line ? end : 0),
    lawql.errorMessage(error),
    vscode.DiagnosticSeverity.Error,
  );
  item.code = error.code;
  item.source = 'lawc query';
  queryCollection.set(document.uri, [item]);
}

/**
 * What to run: a selection → its text; a saved file → the path (then
 * relative `case`/`eval()` are resolved from the file's directory, as in
 * the CLI); an unsaved buffer → the text with cwd at the document's
 * directory — the same base path the file would have.
 */
function querySource(editor) {
  const document = editor.document;
  const selection = editor.selection;
  const selected = selection && !selection.isEmpty ? document.getText(selection) : '';
  const dir = document.isUntitled ? undefined : path.dirname(document.uri.fsPath);
  if (selected.trim()) return { source: selected, cwd: dir, label: 'selection' };
  if (!document.isDirty && !document.isUntitled) {
    return { source: document.uri.fsPath, cwd: dir, label: path.basename(document.uri.fsPath) };
  }
  return { source: document.getText(), cwd: dir, label: `${path.basename(document.uri.fsPath)} (buffer)` };
}

async function runQuery({ raw = false } = {}) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'lawq') {
    vscode.window.showInformationMessage('LawQL: open a .lawq file.');
    return;
  }
  const document = editor.document;
  const folder = lawqlFolder(document);
  if (!folder) return;
  const { source, cwd, label } = querySource(editor);
  if (!source.trim()) return;
  const started = Date.now();
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `lawc query: ${label}` },
    () => runLawc(lawql.queryArgs(source, queryOptions()), folder, QUERY_TIMEOUT_MS, { cwd: cwd ?? folder }),
  );
  const doc = lawql.parseOutput(result?.stdout);
  if (!doc) {
    const refusal = corpus.refusalOf(result) ?? ((result?.stderr ?? '').trim() || 'response is not JSON');
    output.appendLine(`lawc query ${label}: ${refusal}`);
    vscode.window.showWarningMessage(`lawc did not answer the query: details in the "Arxo Law" channel.`);
    return;
  }
  const error = lawql.errorOf(doc);
  if (error) {
    publishQueryError(document, error);
    output.appendLine(`lawc query ${label}: ${error.code} ${lawql.errorMessage(error)}`);
    vscode.window.showWarningMessage(`${error.code}: ${error.message}`);
    return;
  }
  queryCollection.delete(document.uri);
  output.appendLine(`lawc query ${label}: ${doc.kind}, ${(Date.now() - started) / 1000} s`);
  const content = raw || doc.kind !== 'queryResult'
    ? JSON.stringify(doc, null, 2)
    : lawql.renderResult(doc, { title: `LawQL: ${label}`, source: source === document.uri.fsPath ? document.getText() : source });
  const shown = await vscode.workspace.openTextDocument({
    content, language: raw || doc.kind !== 'queryResult' ? 'json' : 'markdown',
  });
  await vscode.window.showTextDocument(shown, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function showQuerySchema() {
  const folder = lawqlFolder(vscode.window.activeTextEditor?.document);
  if (!folder) return;
  querySchema = null;
  const schema = await schemaFor(folder);
  if (!schema) {
    vscode.window.showWarningMessage('The LawQL schema was not obtained — details in the "Arxo Law" channel.');
    return;
  }
  const shown = await vscode.workspace.openTextDocument({ content: JSON.stringify(schema, null, 2), language: 'json' });
  await vscode.window.showTextDocument(shown, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function showQueryCatalog() {
  const folder = lawqlFolder(vscode.window.activeTextEditor?.document);
  if (!folder) return;
  const result = await runLawc(lawql.catalogArgs(), folder, 60000);
  const doc = lawql.parseOutput(result?.stdout);
  if (!doc || doc.kind !== 'queryCatalog') {
    output.appendLine(`lawc query --list: ${corpus.refusalOf(result) ?? 'response is not queryCatalog'}`);
    vscode.window.showWarningMessage('The LawQL catalog was not obtained — details in the "Arxo Law" channel.');
    return;
  }
  const shown = await vscode.workspace.openTextDocument({ content: lawql.renderCatalog(doc), language: 'markdown' });
  await vscode.window.showTextDocument(shown, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

const QUERY_ITEM_KINDS = {
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  relation: vscode.CompletionItemKind.Class,
  field: vscode.CompletionItemKind.Field,
  value: vscode.CompletionItemKind.EnumMember,
};

function queryCompletionProvider() {
  return {
    async provideCompletionItems(document, position) {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (folder) schemaFor(folder);
      const before = document.lineAt(position.line).text.slice(0, position.character);
      const afterDot = /\.[A-Za-z_]*$/.test(before);
      const afterKind = /\.kind\s*(?:==|!=|in\s*\[)\s*"?[A-Za-z_]*$/.test(before);
      return lawql.completions(querySchema, { afterDot, afterKind }).map((item) => {
        const ci = new vscode.CompletionItem(item.label, QUERY_ITEM_KINDS[item.kind]);
        ci.detail = item.detail;
        if (item.doc) ci.documentation = item.doc;
        if (item.snippet) ci.insertText = new vscode.SnippetString(item.snippet);
        return ci;
      });
    },
  };
}

function queryHoverProvider() {
  return {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position, WORD);
      if (!range) return null;
      const text = lawql.hoverFor(document.getText(range), querySchema);
      return text ? new vscode.Hover(new vscode.MarkdownString(text), range) : null;
    },
  };
}
// ------------------------------------------------------------ gate tasks

// Scripts run as-is, without a shell: the arguments are fixed, and
// ProcessExecution doesn't substitute anything on its own.
function taskProvider() {
  return {
    provideTasks() {
      const tasks = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const root = folder.uri.fsPath;
        for (const gate of tasksFor((relative) => fs.existsSync(path.join(root, relative)))) {
          const task = new vscode.Task(
            { type: 'law', task: gate.id },
            folder,
            gate.name,
            'law',
            new vscode.ProcessExecution(gate.command, gate.args, { cwd: root }),
            ['$lawc'],
          );
          task.detail = gate.detail;
          task.group = vscode.TaskGroup.Test;
          tasks.push(task);
        }
      }
      return tasks;
    },
    resolveTask() {
      return undefined; // the set of tasks is fixed by provideTasks
    },
  };
}

Object.assign(S, {
  queryOptions,
  lawqlFolder,
  schemaFor,
  publishQueryError,
  querySource,
  runQuery,
  showQuerySchema,
  showQueryCatalog,
  queryCompletionProvider,
  queryHoverProvider,
  taskProvider,
});

}
}
})();
