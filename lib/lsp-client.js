'use strict';

// Name resolution and editor semantics live in law-lsp. The shipped parity
// ledger decides which features the client may register. Every remaining
// feature stays with the JavaScript provider until its row passes.
const fs = require('node:fs');
const path = require('node:path');
const { registerSensitivePreview } = require('./sensitive-preview');
const { registerRelockPreview } = require('./relock-preview');

const CAPABILITIES = {
  hover: 'hoverProvider', definitions: 'definitionProvider', references: 'referencesProvider',
  highlights: 'documentHighlightProvider', completion: 'completionProvider',
  inlays: 'inlayHintProvider', actions: 'codeActionProvider', symbols: 'documentSymbolProvider',
  semanticTokens: 'semanticTokensProvider', rename: 'renameProvider', formatting: 'documentFormattingProvider',
  workspaceSymbols: 'workspaceSymbolProvider',
};
const FEATURE_PROVIDERS = {
  'textDocument/hover': 'hover', 'textDocument/definition': 'definitions',
  'textDocument/references': 'references', 'textDocument/documentHighlight': 'highlights',
  'textDocument/completion': 'completion', 'textDocument/inlayHint': 'inlays',
  'textDocument/codeAction': 'actions', 'textDocument/documentSymbol': 'symbols',
  'textDocument/semanticTokens': 'semanticTokens', 'textDocument/rename': 'rename',
  'textDocument/formatting': 'formatting', 'workspace/symbol': 'workspaceSymbols',
};
const DOCUMENT_SELECTOR = [
  { language: 'law', scheme: 'file' },
  { language: 'markdown', scheme: 'file', pattern: '**/*.law.md' },
  // The §10 manifest: the server reads it against the manifest schema.
  { language: 'law-manifest', scheme: 'file' },
];

function configuredCommand(vscode, value) {
  const command = String(value ?? '').trim();
  if (!command) return null;
  if (path.isAbsolute(command) || !command.includes(path.sep)) return command;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ? path.resolve(folder, command) : command;
}

function parity(context) {
  try { return JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'data', 'lsp-parity.json'), 'utf8')); }
  catch { return { status: 'TODO', providers: {} }; }
}

/** Command names the extension's own manifest contributes. */
function contributedCommands(context) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8'));
    return (manifest.contributes?.commands ?? []).map((entry) => entry.command).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Makes the client's `workspace/executeCommand` feature skip the names the
 * extension owns and register the rest one name per call: a name the editor
 * refuses for any other reason (a command the extension registers without
 * contributing it) must cost that one command, never the client.
 */
function guardExecuteCommands(feature, ownedCommands, output) {
  if (feature.registrationType?.method !== 'workspace/executeCommand' || typeof feature.register !== 'function') return;
  const register = feature.register.bind(feature);
  feature.register = (data) => {
    for (const name of data.registerOptions?.commands ?? []) {
      if (ownedCommands.has(name)) continue;
      try {
        register({ id: `${data.id}:${name}`, registerOptions: { ...data.registerOptions, commands: [name] } });
      } catch (error) {
        output.appendLine(`law-lsp command ${name} is not registered by the client: ${error.message}`);
      }
    }
  };
}

function greenProviders(record) {
  return Object.entries(record.providers ?? {}).filter(([, entry]) => entry.status === 'PASS').map(([name]) => name);
}

function matchesParity(record, capabilities) {
  const green = greenProviders(record);
  return green.length > 0 && green.every((name) => CAPABILITIES[name] && capabilities[CAPABILITIES[name]]);
}

const INLAY_SETTINGS = ['inlay.language', 'inlay.maxLength', 'inlay.labels',
  'inlay.parameters', 'inlay.parameterForm'];
function inlayOptions(vscode) {
  const config = vscode.workspace.getConfiguration('law');
  return {
    inlayLanguage: config.get('inlay.language', 'ru-KZ'),
    inlayMaxLength: config.get('inlay.maxLength', 40),
    inlayLabels: config.get('inlay.labels', true),
    inlayParameters: config.get('inlay.parameters', 'all'),
    inlayParameterForm: config.get('inlay.parameterForm', 'smart'),
  };
}

function start(vscode, context, output, { onReady, onFallback }) {
  const config = vscode.workspace.getConfiguration('law');
  if (config.get('lsp.legacyProviders', false)) return null;
  const record = parity(context);
  const green = greenProviders(record);
  if (!['TODO', 'PASS'].includes(record.status)
      || green.length === 0 || green.some((name) => !CAPABILITIES[name])) {
    output.appendLine('law-lsp migration is held by the parity ledger; legacy providers remain active.');
    return null;
  }
  const command = configuredCommand(vscode, config.get('lsp.path', 'law-lsp'));
  if (!command) return null;
  let LanguageClient;
  try { ({ LanguageClient } = require('vscode-languageclient/node')); }
  catch (error) { output.appendLine(`law-lsp client is unavailable: ${error.message}`); onFallback(); return null; }
  const enabled = new Set(green);
  const diagnostics = green.length === Object.keys(CAPABILITIES).length;
  // Commands the extension owns: the ones its manifest contributes. The server
  // advertises its `executeCommandProvider` list, and the language client
  // registers every name in it as an editor command; a name the extension
  // also registers (`law.whyNot`, `law.relockExpansions`) would be registered
  // twice, and the editor rejects the whole client start with "command
  // already exists". The manifest is read rather than the live command list:
  // the extension registers its commands AFTER this client is created, so a
  // snapshot taken here does not contain them yet (that is how the first fix
  // failed in Cursor on 30.09.2026). Owned names stay with the extension,
  // which reaches the server through `workspace/executeCommand` requests.
  const ownedCommands = new Set(contributedCommands(context));
  class ParityLanguageClient extends LanguageClient {
    registerFeature(feature) {
      guardExecuteCommands(feature, ownedCommands, output);
      const provider = FEATURE_PROVIDERS[feature.registrationType?.method];
      if (!provider || enabled.has(provider)) super.registerFeature(feature);
    }
  }
  const client = new ParityLanguageClient('law-lsp', 'Arxo Law Language Server',
    { command, args: ['--stdio'], options: { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath } },
    { documentSelector: DOCUMENT_SELECTOR, diagnosticCollectionName: 'law-lsp',
      initializationOptions: { ...inlayOptions(vscode), backgroundAnalysis: diagnostics },
      // A manifest has no JavaScript provider, so its diagnostics are the
      // server's whatever the parity ledger says about `.law`.
      middleware: { handleDiagnostics: (uri, items, next) => {
        if (diagnostics || uri?.path?.endsWith('/law.toml')) next(uri, items);
      } },
      outputChannel: output, synchronize: { configurationSection: 'law.lsp' } });
  let stopped = false;
  let previewRegistration = null;
  let relockRegistration = null;
  let configurationRegistration = null;
  const fallback = (message) => {
    if (stopped) return;
    stopped = true;
    previewRegistration?.dispose();
    relockRegistration?.dispose();
    configurationRegistration?.dispose();
    output.appendLine(message);
    Promise.resolve(client.stop()).finally(onFallback);
  };
  Promise.resolve(client.start()).then(() => {
    const capabilities = client.initializeResult?.capabilities ?? {};
    if (!matchesParity(record, capabilities)) {
      fallback('law-lsp capabilities do not match green parity rows; legacy providers remain active.');
      return;
    }
    previewRegistration = registerSensitivePreview(vscode, client);
    relockRegistration = registerRelockPreview(vscode, client);
    const updateInlays = () => Promise.resolve().then(() => client.sendNotification(
      'workspace/didChangeConfiguration', { settings: inlayOptions(vscode) })).catch((error) =>
      fallback(`law-lsp inlay settings could not be updated: ${error.message}`));
    configurationRegistration = vscode.workspace.onDidChangeConfiguration((event) => {
      if (INLAY_SETTINGS.some((key) => event.affectsConfiguration(`law.${key}`))) updateInlays();
    });
    updateInlays();
    onReady(green);
  }).catch((error) => fallback(`law-lsp did not start: ${error.message}`));
  return { providers: green, diagnostics, dispose: () => {
    stopped = true;
    previewRegistration?.dispose();
    relockRegistration?.dispose();
    configurationRegistration?.dispose();
    return client.stop();
  } };
}

module.exports = { CAPABILITIES, FEATURE_PROVIDERS, DOCUMENT_SELECTOR, configuredCommand, greenProviders, matchesParity, contributedCommands, guardExecuteCommands, start };
