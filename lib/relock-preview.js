'use strict';

// §279.1.8/Р5: the lock is updated only after an explicit diff and confirmation.
function registerRelockPreview(vscode, client) {
  const previews = new Map();
  const scheme = 'law-relock-preview';
  let serial = 0;
  const content = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? '',
  });
  const closed = vscode.workspace.onDidCloseTextDocument((document) => {
    previews.delete(document.uri.toString());
  });
  const command = vscode.commands.registerCommand('law.previewRelockUi', async (argument) => {
    try {
      const uri = argument?.textDocument?.uri;
      const version = argument?.textDocument?.version;
      if (typeof uri !== 'string' || !Number.isInteger(version)) {
        throw new Error('Invalid law.lock preview argument.');
      }
      const source = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      if (source.isClosed || source.version !== version) {
        throw new Error('The source changed. Reopen the preview.');
      }
      const response = await client.sendRequest('workspace/executeCommand', {
        command: 'law.relockExpansions', arguments: [argument],
      });
      const preview = response?.preview;
      if (response?.schema !== 'law.relock-expansions/0.1' || response.uri !== uri
        || response.version !== version || preview?.schema !== 'law.relock-expansions-preview/0.1'
        || typeof preview.lockPath !== 'string' || typeof preview.beforeLock !== 'string'
        || typeof preview.renderedLock !== 'string' || typeof preview.changed !== 'boolean') {
        throw new Error('The server returned an inconsistent law.lock preview.');
      }
      const lockUri = vscode.Uri.file(preview.lockPath);
      const lock = await vscode.workspace.openTextDocument(lockUri);
      const lockVersion = lock.version;
      if (source.isClosed || source.version !== version || lock.isClosed
        || lock.getText() !== preview.beforeLock) {
        throw new Error('The source or law.lock changed. Reopen the preview.');
      }
      if (!preview.changed) {
        await vscode.window.showInformationMessage('The pins are already up to date.');
        return;
      }
      const key = ++serial;
      const left = vscode.Uri.parse(`${scheme}:/${key}/before.json`);
      const right = vscode.Uri.parse(`${scheme}:/${key}/after.json`);
      previews.set(left.toString(), preview.beforeLock);
      previews.set(right.toString(), preview.renderedLock);
      await vscode.commands.executeCommand('vscode.diff', left, right,
        'Law: law.lock preview', { preview: true });
      const answer = await vscode.window.showInformationMessage('Apply the shown law.lock?', 'Apply');
      if (answer !== 'Apply') return;
      if (source.isClosed || source.version !== version || lock.isClosed
        || lock.version !== lockVersion || lock.getText() !== preview.beforeLock) {
        throw new Error('The source or law.lock changed after the preview.');
      }
      // Between showing the diff and confirmation, expansion.toml or the
      // template could have changed. A repeat compiler preview must give the same bytes §279.1.8.
      const fresh = await client.sendRequest('workspace/executeCommand', {
        command: 'law.relockExpansions', arguments: [argument],
      });
      if (fresh?.schema !== response.schema || fresh.uri !== uri || fresh.version !== version
        || fresh.preview?.beforeLock !== preview.beforeLock
        || fresh.preview?.renderedLock !== preview.renderedLock) {
        throw new Error('The pins changed after the preview. Reopen it.');
      }
      if (source.isClosed || source.version !== version || lock.isClosed
        || lock.version !== lockVersion || lock.getText() !== preview.beforeLock) {
        throw new Error('The source or law.lock changed after the preview.');
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(lockUri, new vscode.Range(lock.positionAt(0), lock.positionAt(lock.getText().length)),
        preview.renderedLock);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('The editor did not apply law.lock.');
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

module.exports = { registerRelockPreview };
