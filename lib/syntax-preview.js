'use strict';

const { candidates, applyEdits, equivalent } = require('./syntax-actions');
const { surfaceOf, generated } = require('./files');

// Read-only snapshots stay available while a diff tab is open. Applying is a
// separate user action, guarded by the original document version and content.
function registerSyntaxPreview(vscode, context, parse) {
  const previews = new Map();
  let serial = 0;
  const allowed = (document) => (!document.uri.scheme || ['file', 'untitled'].includes(document.uri.scheme))
    && surfaceOf(document.uri.fsPath) === '.law'
    && !generated(document.uri.fsPath, vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath);
  const unchanged = (document, version, source) => !document.isClosed
    && document.version === version && document.getText() === source;
  async function preview(uri, offset, id) {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || !allowed(document)) {
      await vscode.window.showInformationMessage('The transform is available in .law source files.');
      return;
    }
    const version = document.version;
    const source = document.getText();
    offset ??= document.offsetAt(vscode.window.activeTextEditor.selection.active);
    try {
      const ast = await parse(source, document);
      const choices = candidates(source, ast).filter((c) => c.start <= offset && offset <= c.end && (!id || c.id === id));
      const choice = choices.length === 1 ? choices[0] : choices.length
        ? await vscode.window.showQuickPick(choices.map((c) => ({ label: c.title, ...c })), { placeHolder: 'Syntax transform' }) : null;
      if (!choice) {
        if (!choices.length) await vscode.window.showInformationMessage('No safe transform here. Place the cursor on a declaration, aggregate or target; comments and extra fields may require a manual edit.');
        return;
      }
      const updated = applyEdits(source, choice.edits);
      const after = await parse(updated, document);
      if (!equivalent(ast, after)) throw new Error('The AST changed beyond coordinates; the transform was cancelled.');
      if (!unchanged(document, version, source)) throw new Error('The document has changed. Open a new preview.');
      const key = ++serial;
      const left = vscode.Uri.parse(`law-syntax-preview:/${key}/before.law`);
      const right = vscode.Uri.parse(`law-syntax-preview:/${key}/after.law`);
      previews.set(left.toString(), source);
      previews.set(right.toString(), updated);
      await vscode.commands.executeCommand('vscode.diff', left, right, choice.title, { preview: true });
      const answer = await vscode.window.showInformationMessage('The AST matches. Apply the shown transform?', 'Apply');
      if (answer !== 'Apply') return;
      if (!unchanged(document, version, source)) throw new Error('The document changed after the preview. Open a new preview.');
      const edit = new vscode.WorkspaceEdit();
      for (const change of choice.edits) {
        edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.newText);
      }
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('The editor did not apply the edits.');
    } catch (error) {
      await vscode.window.showErrorMessage(`Law: ${error.message}`);
    }
  }
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('law-syntax-preview', {
      provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? '',
    }),
    vscode.workspace.onDidCloseTextDocument((document) => previews.delete(document.uri.toString())),
    { dispose: () => previews.clear() },
    vscode.commands.registerCommand('law.refactorSyntax', preview),
    vscode.languages.registerCodeActionsProvider({ language: 'law', pattern: '**/*.law' }, {
      async provideCodeActions(document, range, context) {
        if (!allowed(document) || (context.only && !context.only.contains(vscode.CodeActionKind.RefactorRewrite))) return [];
        const version = document.version;
        const source = document.getText();
        try {
          const ast = await parse(source, document);
          if (!unchanged(document, version, source)) return [];
          const offset = document.offsetAt(range.start);
          return candidates(source, ast).filter((c) => c.start <= offset && offset <= c.end).map((candidate) => {
            const action = new vscode.CodeAction(`${candidate.title} — preview`, vscode.CodeActionKind.RefactorRewrite);
            action.command = { command: 'law.refactorSyntax', title: action.title, arguments: [document.uri, offset, candidate.id] };
            return action;
          });
        } catch { return []; } // Incomplete buffers must not offer speculative edits.
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] }),
  );
}

module.exports = { registerSyntaxPreview };
