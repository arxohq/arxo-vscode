'use strict';

// §219/Р5: E5201 and E4103 change normatively significant bytes only after
// a separate compiler-backed preview and the author's confirmation.
function registerSensitivePreview(vscode, client) {
  const previews = new Map();
  let serial = 0;
  const scheme = 'law-sensitive-preview';
  const unchanged = (document, version, source) => !document.isClosed
    && document.version === version && document.getText() === source;

  const content = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? '',
  });
  const closed = vscode.workspace.onDidCloseTextDocument((document) => {
    previews.delete(document.uri.toString());
  });
  const command = vscode.commands.registerCommand('law.previewSensitiveEditUi', async (argument) => {
    try {
      const uri = argument?.textDocument?.uri;
      const version = argument?.textDocument?.version;
      if (typeof uri !== 'string' || !Number.isInteger(version) || !argument.diagnostic) {
        throw new Error('Invalid preview argument.');
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const source = document.getText();
      if (!unchanged(document, version, source)) throw new Error('The document changed. Reopen the preview.');
      const preview = await client.sendRequest('workspace/executeCommand', {
        command: 'law.previewSensitiveEdit', arguments: [argument],
      });
      if (preview?.schema !== 'law.sensitive-edit-preview/0.1'
        || preview.uri !== uri || preview.version !== version || preview.before !== source
        || typeof preview.after !== 'string' || preview.requiresConfirmation !== true) {
        throw new Error('The server returned an inconsistent preview.');
      }
      if (!unchanged(document, version, source)) throw new Error('The document changed. Reopen the preview.');
      const key = ++serial;
      const left = vscode.Uri.parse(`${scheme}:/${key}/before.law`);
      const right = vscode.Uri.parse(`${scheme}:/${key}/after.law`);
      previews.set(left.toString(), source);
      previews.set(right.toString(), preview.after);
      await vscode.commands.executeCommand('vscode.diff', left, right,
        `Law: ${preview.code} — preview`, { preview: true });

      if (!preview.edit) {
        await vscode.window.showInformationMessage('The client does not support confirmable edits. The preview is read-only.');
        return;
      }
      const answer = await vscode.window.showInformationMessage('Apply the shown edit?', 'Apply');
      if (answer !== 'Apply') return;
      if (!unchanged(document, version, source)) throw new Error('The document changed after the preview.');
      // The pinned dependencies could have changed while viewing. We ask the
      // compiler check again and require the same result bytes §219/Р5.
      const fresh = await client.sendRequest('workspace/executeCommand', {
        command: 'law.previewSensitiveEdit', arguments: [argument],
      });
      if (fresh?.schema !== preview.schema || fresh.uri !== uri || fresh.version !== version
        || fresh.code !== preview.code || fresh.before !== source
        || fresh.after !== preview.after || fresh.requiresConfirmation !== true
        || !fresh.edit) {
        throw new Error('The check result changed after the preview. Reopen it.');
      }
      if (!unchanged(document, version, source)) throw new Error('The document changed after the preview.');
      const changes = preview.edit.documentChanges;
      if (!Array.isArray(changes) || changes.length !== 1
        || changes[0].textDocument?.uri !== uri || changes[0].textDocument?.version !== version
        || !Array.isArray(changes[0].edits) || changes[0].edits.length !== 1) {
        throw new Error('The preview contains an unexpected edit.');
      }
      const change = changes[0].edits[0];
      const annotation = preview.edit.changeAnnotations?.[change.annotationId];
      if (annotation?.needsConfirmation !== true) throw new Error('The edit does not require confirmation in the protocol.');
      const range = new vscode.Range(change.range.start.line, change.range.start.character,
        change.range.end.line, change.range.end.character);
      const start = document.offsetAt(range.start);
      const end = document.offsetAt(range.end);
      const actualAfter = source.slice(0, start) + change.newText + source.slice(end);
      if (actualAfter !== preview.after) throw new Error('The edit text does not match the shown preview.');
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, range, change.newText);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('The editor did not apply the edit.');
    } catch (error) {
      await vscode.window.showErrorMessage(`Law: ${error.message}`);
    }
  });
  return { dispose: () => {
    command.dispose();
    closed.dispose();
    content.dispose();
    previews.clear();
  } };
}

module.exports = { registerSensitivePreview };
