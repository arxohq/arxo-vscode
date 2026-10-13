'use strict';

// Own the reversible JS provider registrations during an LSP handoff.
function legacyEditorProviders(vscode, S, context, legend) {
  const surfaces = [
    ['law', S.LAW, false],
    ['literate', S.LITERATE, true],
  ];
  const out = [];
  const registrations = new Map();
  const names = ['hover', 'actions', 'symbols', 'semanticTokens', 'definitions', 'references', 'highlights', 'completion', 'inlays', 'rename'];
  const register = (name, selector, literate) => ({
    hover: () => vscode.languages.registerHoverProvider(selector, S.hoverProvider(context, literate)),
    actions: () => vscode.languages.registerCodeActionsProvider(selector, S.codeActionProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    symbols: () => vscode.languages.registerDocumentSymbolProvider(selector, S.symbolProvider()),
    semanticTokens: () => vscode.languages.registerDocumentSemanticTokensProvider(selector, S.semanticTokensProvider(legend), legend),
    definitions: () => vscode.languages.registerDefinitionProvider(selector, S.definitionProvider(literate)),
    references: () => vscode.languages.registerReferenceProvider(selector, S.referenceProvider(literate)),
    highlights: () => vscode.languages.registerDocumentHighlightProvider(selector, S.highlightProvider(literate)),
    completion: () => vscode.languages.registerCompletionItemProvider(selector, S.completionProvider(context)),
    inlays: () => vscode.languages.registerInlayHintsProvider(selector, S.inlayHintsProvider()),
    rename: () => vscode.languages.registerRenameProvider(selector, S.renameProvider(context, literate)),
    formatting: () => vscode.languages.registerDocumentFormattingEditProvider(selector, S.formattingProvider()),
  })[name]();
  const add = (name, surface, selector, literate) => {
    const registration = register(name, selector, literate);
    if (!registrations.has(name)) registrations.set(name, new Map());
    registrations.get(name).set(surface, registration);
    out.push(registration);
    return registration;
  };
  for (const [surface, selector, literate] of surfaces) {
    names.forEach((name) => add(name, surface, selector, literate));
  }
  add('formatting', 'law', S.LAW, false);
  add('formatting', 'literate', S.LITERATE, true);
  const addWorkspaceSymbols = () => {
    const registration = vscode.languages.registerWorkspaceSymbolProvider(S.workspaceSymbolProvider());
    registrations.set('workspaceSymbols', new Map([['workspace', registration]]));
    out.push(registration);
    return registration;
  };
  addWorkspaceSymbols();
  return {
    subscriptions: out,
    disposeProviders: (providers) => providers.forEach((name) => {
      const bySurface = registrations.get(name);
      bySurface?.forEach((registration) => registration.dispose());
      registrations.delete(name);
    }),
    restoreProviders: () => {
      const restored = [];
      names.forEach((name) => {
        if (registrations.has(name)) return;
        surfaces.forEach(([surface, selector, literate]) => {
          restored.push(add(name, surface, selector, literate));
        });
      });
      if (!registrations.has('formatting')) {
        surfaces.forEach(([surface, selector, literate]) => {
          restored.push(add('formatting', surface, selector, literate));
        });
      }
      if (!registrations.has('workspaceSymbols')) {
        restored.push(addWorkspaceSymbols());
      }
      return restored;
    },
  };
}


module.exports = { legacyEditorProviders };
