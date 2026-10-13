
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
// AST cache, go-to, completion, rename, workspace symbols, package tree.

async function astFor(document) {
  const key = document.uri.toString();
  const version = document.version;
  const hit = astCache.get(key);
  if (hit && hit.version === document.version) return hit.ast;

  const result = await runLawcOn(document, (target) => ['parse', target, '--ast']);
  if (document.version !== version) return null;
  if (!result || !result.stdout) {
    // Silence here would mean "the file has no symbols", which is
    // indistinguishable from "the compiler didn't start": write to both the
    // output channel AND the status bar.
    const reason = result ? (result.stderr.trim().split('\n')[0] || 'empty response').slice(0, 200) : 'compiler did not start';
    output.appendLine(`ast unavailable for ${document.uri.fsPath}: ${reason}`);
    astFailures.set(key, reason);
    updateStatus();
    return null;
  }
  let ast = null;
  try {
    ast = JSON.parse(result.stdout);
  } catch (e) {
    const reason = `response is not JSON: ${e && e.message ? e.message : e}`;
    output.appendLine(`ast: ${reason}`);
    astFailures.set(key, reason);
    updateStatus();
    return null;
  }
  if (astFailures.delete(key)) updateStatus();
  astCache.set(key, { version, ast });
  return ast;
}

// AST spans arrive in bytes, and for literate — also in the coordinates of
// the assembled source: the block map is computed per the literate.rs contract.
function symbolProvider() {
  return {
    async provideDocumentSymbols(document) {
      const ast = await astFor(document);
      if (!ast) return [];
      const at = positionMapper(document);
      const build = (node) => {
        const range = toRange(at, node.span);
        const selection = toRange(at, node.selection ?? node.span);
        const item = new vscode.DocumentSymbol(
          node.name,
          node.detail,
          vscode.SymbolKind[node.kind] ?? vscode.SymbolKind.Object,
          range,
          range.contains(selection) ? selection : range,
        );
        item.children = (node.children ?? []).map(build);
        return item;
      };
      return symbols(ast).map(build);
    },
  };
}

function semanticTokensProvider(legend) {
  return {
    async provideDocumentSemanticTokens(document) {
      const ast = await astFor(document);
      if (!ast) return null;
      const at = positionMapper(document);
      const builder = new vscode.SemanticTokensBuilder(legend);
      const source = slicerFor(document);
      const own = await packageAsts(document, ast);
      const localTypes = own.flatMap(({ ast: file }) => declarations(file))
        .filter((decl) => ['entity', 'record', 'type', 'enum'].includes(decl.kind))
        .map((decl) => decl.name);
      for (const token of tokens(ast, {
        localTypes,
        slice: (span) => source.text.slice(source.index(span.start), source.index(span.end)),
      })) {
        const range = toRange(at, { start: token.start, end: token.end });
        if (range.start.line !== range.end.line) continue; // the token doesn't wrap across lines
        builder.push(range, token.type, token.modifiers);
      }
      return builder.build();
    },
  };
}

// ------------------------------------- go-to, references, and occurrence highlighting

// Name matching within the bounds of the §22 PACKAGE: the boundary comes
// from lawc package-root (the root rule lives in the compiler — invariant 5),
// and a file is a unit of authorship, not of meaning (DECISION-0011), so a
// declaration from a sibling file of the package is an ordinary go-to
// target. The extension still does not do CROSS-package resolution
// (`pkg::symbol`, §23–§25): identical short names from different packages
// are indistinguishable to it.
async function spansFor(document, position, literate, kind) {
  const hit = wordAt(document, position, literate);
  if (!hit) return null;
  const ast = await astFor(document);
  if (!ast) return null;
  const at = positionMapper(document);
  if (kind === 'definition') {
    const decl = declarationNamed(ast, hit.word);
    return decl ? [toRange(at, decl.selection)] : null;
  }
  return occurrences(ast, hit.word).map((span) => toRange(at, span));
}

// AST of a package sibling file: the same `lawc parse --ast` as in astFor,
// but by an on-disk path and cached by mtime — an edit to a sibling becomes
// visible to go-to after saving, exactly as it does to the compiler.

async function siblingAst(fsPath, folder) {
  let mtime;
  try { mtime = fs.statSync(fsPath).mtimeMs; } catch { return null; }
  const hit = siblingCache.get(fsPath);
  if (hit && hit.mtime === mtime) return hit;
  const result = await runLawc(['parse', fsPath, '--ast'], folder);
  if (!result || !result.stdout) return null;
  let ast = null;
  try { ast = JSON.parse(result.stdout); } catch { return null; }
  let text;
  try { text = fs.readFileSync(fsPath, 'utf8'); } catch { return null; }
  const map = new ByteMap(text);
  // text + index — for the hover card: it shows a slice of the sibling
  // file's source so the user isn't forced to jump there for a single line.
  const entry = {
    mtime,
    ast,
    text,
    at: (byteOffset) => map.positionAt(byteOffset),
    index: (byteOffset) => map.offsetOf(map.positionAt(byteOffset)),
  };
  siblingCache.set(fsPath, entry);
  return entry;
}

// A package's `*.law` files sorted by path — the same order as the
// compiler's collect_law_files (§211) — excluding the document itself.
function packageLawFiles(root, except) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('target') || ['node_modules', 'deps'].includes(e.name)) continue;
        walk(p);
      }
      else if (e.name.endsWith('.law') && p !== except) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// The first declaration of a name in sibling files of the package.
// Sequential with an early exit: names within a package are unique (§24,
// LDC-E1201), and by corpus convention declarations live in the first files
// (00-package) — usually one parse is enough, the cache handles the rest.
async function siblingDeclaration(document, word) {
  const { root, packaged } = await packageRootOf(document);
  if (!packaged) return null;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  for (const sibling of packageLawFiles(root, document.uri.fsPath)) {
    const entry = await siblingAst(sibling, folder);
    if (!entry) continue;
    const decl = declarationNamed(entry.ast, word);
    if (decl) return { sibling, entry, decl };
  }
  return null;
}

// Definition of `expansion <reference>` for an `expand` instance (§279.1.3):
// first the document package's files (local definition), then the alias
// directory from `[expansions]` law.toml (§279.1.8). Parsing is the same
// siblingAst as for siblings: cache by mtime, text and byte map for a source
// slice. The definition's name in the alias package usually matches the
// alias; otherwise the package's single definition is used.
async function expansionDefinition(document, reference, ast = null) {
  // A local definition in the document itself (§279.1 vectors — a single
  // file): its entry is assembled from the document, the way siblingAst
  // assembles one for a sibling.
  const own = ast ? expansionNamed(ast, reference) : null;
  if (own) {
    const where = slicerFor(document);
    return { file: document.uri.fsPath, decl: own, entry: { ast, text: where.text, index: where.index, at: positionMapper(document) } };
  }
  const { root, packaged } = await packageRootOf(document);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const dir = packaged ? root : path.dirname(root);
  const search = async (files, name) => {
    for (const file of files) {
      const entry = await siblingAst(file, folder);
      const decl = entry ? expansionNamed(entry.ast, name) : null;
      if (decl) return { file, entry, decl };
    }
    return null;
  };
  if (packaged) {
    const local = await search(packageLawFiles(root, document.uri.fsPath), reference);
    if (local) return local;
  }
  const target = expansionPaths(dir).get(reference);
  if (!target) return null;
  const files = packageLawFiles(path.resolve(dir, target), null);
  return (await search(files, reference)) ?? (await search(files, null));
}

// The `expand` instance element under the cursor and its place in the
// definition: an `expand <reference>` link leads to `expansion <reference>`,
// an argument name, `bind`, `case`, or field leads to a parameter in
// `params`. Shared point for hover and go-to: Cmd+Click and hover must answer
// the same way.
async function expansionTarget(document, ast, hit) {
  const where = slicerFor(document);
  const arg = expansionArgumentAt(ast, hit.offset, where.index);
  if (!arg || !arg.reference) return null;
  const found = await expansionDefinition(document, arg.reference, ast);
  const node = found && arg.role !== 'reference' ? parameterNamed(found.decl, arg.param, arg.of) : null;
  return { arg, found, node, span: found ? targetSpan(found.decl, arg, node) : null };
}

// "Rule → instance" bridge (§279.1.4): a generated node `X/elements` or
// `X/exemption/Voluntary/excludes` is declared not by a rule but by an
// `expand X` instance (its `Voluntary` case) and a definition's `emit` line.
// We lead to the instance or case; `emit` is shown alongside (peek), without
// taking the reader out of the act.
async function expansionBridge(document, ast, name) {
  const generated = generatedRuleName(name);
  const instance = generated ? instanceNamed(ast, generated.instance) : null;
  if (!instance) return null;
  const found = await expansionDefinition(document, instance.kind.reference?.text, ast);
  const hit = found ? emitFor(found.decl, generated.tail) : null;
  const target = (hit?.caseName ? caseNamed(instance, hit.caseName) : null)?.name?.span
    ?? instance.kind.name?.span ?? instance.span;
  const peek = hit ? new vscode.Location(vscode.Uri.file(found.file), toRange(found.entry.at, hit.emit.path.span)) : null;
  return { range: toRange(positionMapper(document), target), peek };
}

// Card for an instance element: a parameter is explained by the definition,
// a reference — by the `expansion`'s own card (like a sibling declaration, §22).
async function expansionHover(document, ast, hit, words) {
  const target = await expansionTarget(document, ast, hit);
  if (!target) return null;
  const { arg, found, node } = target;
  const maxLines = Math.max(1, config().get('hover.maxLines', 14));
  const sliceOf = (span) => {
    if (!found || !span) return { slice: null, comment: null };
    const start = found.entry.index(span.start);
    return {
      slice: sourceSlice(found.entry.text.slice(start, found.entry.index(span.end)), maxLines),
      comment: leadingComment(found.entry.text, start),
    };
  };
  if (arg.role === 'reference' && found) {
    const decl = declarationNamed(found.entry.ast, arg.reference);
    if (decl) {
      return render({
        decl, node: decl.node, entry: words.expansion ?? null, ...sliceOf(decl.span),
        sources: await annotatedSources(document, found.entry.ast, decl.node),
        origin: path.basename(found.file),
      });
    }
  }
  return new vscode.Hover(new vscode.MarkdownString(parameterCard({
    ...arg,
    node,
    ...sliceOf(node?.span),
    origin: found ? path.basename(found.file) : null,
    entry: words.expansion ?? null,
    missing: !found,
  })));
}

function definitionProvider(literate) {
  return {
    async provideDefinition(document, position) {
      const hit = wordAt(document, position, literate);
      if (!hit) return null;
      // An `expand` instance element (§279.1.3) is declared in the expansion
      // definition, before the file's own declarations: a parameter name is
      // never declared here.
      const ast = await astFor(document);
      const binding = ast ? ruleBindingAt(ast, hit.offset, slicerFor(document).index) : null;
      if (binding) return [new vscode.Location(document.uri, toRange(positionMapper(document), binding.span))];
      const target = ast ? await expansionTarget(document, ast, hit) : null;
      if (target?.span) {
        return [new vscode.Location(vscode.Uri.file(target.found.file), toRange(target.found.entry.at, target.span))];
      }
      // `pkg::name` leads to the dependency's source (source tier); via CLIR
      // there is no go-to — there are no spans there, the hover card says so.
      const qualified = ast ? await qualifiedDeclaration(document, ast, hit) : null;
      if (qualified) {
        if (qualified.decl && qualified.tier === 'source' && qualified.entry) {
          return [new vscode.Location(vscode.Uri.file(qualified.file), toRange(qualified.entry.at, qualified.decl.selection))];
        }
        return null;
      }
      const ranges = await spansFor(document, position, literate, 'definition');
      if (ranges) return ranges.map((range) => new vscode.Location(document.uri, range));
      const found = await siblingDeclaration(document, hit.word);
      if (!found) return null;
      return [new vscode.Location(
        vscode.Uri.file(found.sibling),
        toRange(found.entry.at, found.decl.selection),
      )];
    },
  };
}

function referenceProvider(literate) {
  return {
    async provideReferences(document, position) {
      const ranges = await spansFor(document, position, literate, 'all');
      const here = ranges ? ranges.map((range) => new vscode.Location(document.uri, range)) : [];
      const hit = wordAt(document, position, literate);
      if (!hit) return here.length ? here : null;
      const { root, packaged } = await packageRootOf(document);
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      // A parameter or the name of an `expansion` definition (§279.1.2):
      // references live in instances of consumer packages in the workspace
      // whose `[expansions]` points to this definition's directory. Without
      // this, a pack review is blind.
      const ast = await astFor(document);
      const definition = ast ? definitionParamAt(ast, hit.offset, slicerFor(document).index) : null;
      if (definition?.name) {
        const definitionRoot = packaged ? root : path.dirname(document.uri.fsPath);
        const consumers = consumersOf(folder, definitionRoot);
        const reverse = await mapLimit(consumers, 4, async ({ dir, alias }) => {
          const files = packageLawFiles(dir, null);
          const perFile = await mapLimit(files, 8, async (file) => {
            const entry = await siblingAst(file, folder);
            if (!entry) return [];
            return instanceReferences(entry.ast, alias, definition.param, definition.of)
              .map((span) => new vscode.Location(vscode.Uri.file(file), toRange(entry.at, span)));
          });
          return perFile.flat();
        });
        const all = [...here, ...reverse.flat()];
        return all.length ? all : null;
      }
      if (!packaged) return here.length ? here : null;
      const siblings = packageLawFiles(root, document.uri.fsPath);
      const found = await mapLimit(siblings, 8, async (sibling) => {
        const entry = await siblingAst(sibling, folder);
        if (!entry) return [];
        return occurrences(entry.ast, hit.word)
          .map((span) => new vscode.Location(vscode.Uri.file(sibling), toRange(entry.at, span)));
      });
      const all = [...here, ...found.flat()];
      return all.length ? all : null;
    },
  };
}

function highlightProvider(literate) {
  return {
    async provideDocumentHighlights(document, position) {
      const ranges = await spansFor(document, position, literate, 'all');
      return ranges ? ranges.map((range) => new vscode.DocumentHighlight(range)) : null;
    },
  };
}

// Completion: grammar keywords with § in the hint, and names declared in
// this file. There are no types here — typed autocomplete §220 needs a
// resolver and will arrive with WP-22.
function completionProvider(context) {
  return {
    async provideCompletionItems(document, position) {
      const literate = document.languageId === 'markdown';
      if (literate && !lawBlockAt(document.getText(), document.offsetAt(position))) return null;
      if (!keywordItems) {
        keywordItems = Object.entries(dictionary(context)).map(([word, entry]) => {
          // An aggregate form (errata E-0257) exists only over a comprehension:
          // offered as a function with that shape, the same as law-lsp.
          const form = entry.form === 'aggregate';
          const item = new vscode.CompletionItem(word, form
            ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Keyword);
          // A migrated word offers its default card (completion has no
          // cursor role: the invocation point is rarely on the keyword).
          item.detail = entry.detailText ?? `§${entry.sec} ${entry.title}`;
          item.documentation = new vscode.MarkdownString(entry.markdown ?? entry.doc);
          if (form) {
            item.insertText = new vscode.SnippetString(`${word}(collect \${1:v}: \${2:T} where \${3:condition})`);
          }
          return item;
        });
      }
      const ast = await astFor(document);
      const seen = new Set();
      const items = [];
      // Inside an `expand` instance (§279.1.3), what comes first is what it
      // is still missing per the definition: `bind` for a binder, a
      // parameter value, a case, a label; inside a case body — its unfilled
      // fields. The written form comes from the parameter's kind, the
      // explanation is the author's comment above it.
      const offset = document.offsetAt(position);
      if (ast) {
        const where = slicerFor(document);
        for (const binding of ruleBindings(ast, offset, where.index)) {
          seen.add(binding.name);
          const item = new vscode.CompletionItem(binding.name, vscode.CompletionItemKind.Variable);
          item.insertText = where.text.slice(where.index(binding.span.start), where.index(binding.span.end));
          item.detail = `${binding.name}: ${binding.type} — parameter of ${binding.ownerKind} ${binding.owner}`;
          item.sortText = `!${binding.name}`;
          items.push(item);
        }
        const inside = instanceAt(ast, offset, where.index);
        const found = inside?.reference ? await expansionDefinition(document, inside.reference, ast) : null;
        if (found) {
          expansionCompletions(found.decl, inside.decl, inside.inCase).forEach((c, i) => {
            const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind.Field);
            item.insertText = new vscode.SnippetString(c.insert);
            item.sortText = `!${String(i).padStart(2, '0')}`; // before own names and keywords
            if (c.param?.span) {
              const start = found.entry.index(c.param.span.start);
              item.detail = `${c.role === 'field' ? 'field' : 'parameter'} ${inside.reference} · ${found.entry.text.slice(start, found.entry.index(c.param.span.end))}`;
              const comment = leadingComment(found.entry.text, start);
              if (comment) item.documentation = new vscode.MarkdownString(comment);
            } else {
              item.detail = 'label §279.1.4: the instance and the case each need at least one';
            }
            items.push(item);
          });
        }
        // `expand <reference>`: aliases from `[expansions]` law.toml and local definitions.
        const line = document.getText().slice(0, offset).split('\n').pop();
        if (/^\s*expand\s+[A-Za-z0-9_]*$/.test(line)) {
          const { root, packaged } = await packageRootOf(document);
          const names = [...expansionPaths(packaged ? root : path.dirname(root)).keys()];
          for (const decl of ast.decls ?? []) if (decl.kind?.kind === 'expansion' && decl.kind.name?.text) names.push(decl.kind.name.text);
          for (const name of new Set(names)) {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
            item.detail = 'expansion §279.1.3: definition via an [expansions] alias or from the package';
            item.sortText = `!${name}`;
            items.push(item);
          }
        }
      }
      const add = (decl, where) => {
        if (seen.has(decl.name)) return;
        seen.add(decl.name);
        const item = new vscode.CompletionItem(decl.name, vscode.CompletionItemKind.Reference);
        item.detail = `${decl.kind}${decl.detail ? ` ${decl.detail}` : ''}${where ? ` — ${where}` : ''}`;
        item.sortText = `0${decl.name}`; // own items above keywords
        items.push(item);
      };
      for (const decl of ast ? declarations(ast) : []) add(decl, '');
      // names of sibling files of the §22 package: the first call warms the
      // mtime cache, after that it's a Map read — no cost is paid per keystroke
      const { root, packaged } = await packageRootOf(document);
      if (packaged) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        const siblings = packageLawFiles(root, document.uri.fsPath);
        const fetched = await mapLimit(siblings, 8, (sibling) => siblingAst(sibling, folder));
        fetched.forEach((entry, index) => {
          if (!entry) return;
          for (const decl of declarations(entry.ast)) add(decl, path.basename(siblings[index]));
        });
      }
      return [...items, ...keywordItems];
    },
  };
}
//: List of grammar words — to refuse renaming to something that's a keyword.
const isKeyword = (context, word) => {
  keywordSet ??= new Set(Object.keys(dictionary(context)));
  return keywordSet.has(word);
};

// Package-wide rename (F2): the declaration in the file or a sibling,
// occurrences by name across all package files — the same scope as
// reference search. Not a resolver: qualified `pkg::name` in foreign
// packages is not rewritten, and the result's hint says so.
function renameProvider(context, literate) {
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  return {
    async prepareRename(document, position) {
      const hit = wordAt(document, position, literate);
      if (!hit) throw new Error('there is nothing to rename here');
      const ast = await astFor(document);
      const decl = (ast ? declarationNamed(ast, hit.word) : null) ?? (await siblingDeclaration(document, hit.word))?.decl ?? null;
      if (!decl) throw new Error(`\`${hit.word}\` is not declared in the package — only declarations can be renamed`);
      return { range: hit.range, placeholder: hit.word };
    },
    async provideRenameEdits(document, position, newName) {
      const hit = wordAt(document, position, literate);
      if (!hit) return null;
      if (!IDENT.test(newName)) throw new Error(`\`${newName}\` is not a §14 identifier`);
      if (isKeyword(context, newName)) throw new Error(`\`${newName}\` is a §15 keyword; pick another name`);
      const edit = new vscode.WorkspaceEdit();
      const ast = await astFor(document);
      const at = positionMapper(document);
      let count = 0;
      for (const span of ast ? occurrences(ast, hit.word) : []) { edit.replace(document.uri, toRange(at, span), newName); count += 1; }
      const { root, packaged } = await packageRootOf(document);
      if (packaged) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        const siblings = packageLawFiles(root, document.uri.fsPath);
        const found = await mapLimit(siblings, 8, async (sibling) => {
          const entry = await siblingAst(sibling, folder);
          return entry ? occurrences(entry.ast, hit.word).map((span) => ({ sibling, range: toRange(entry.at, span) })) : [];
        });
        for (const { sibling, range } of found.flat()) { edit.replace(vscode.Uri.file(sibling), range, newName); count += 1; }
      }
      output?.appendLine(`rename ${hit.word} → ${newName}: occurrences ${count}; qualified references from foreign packages were not rewritten`);
      return edit;
    },
  };
}

// Workspace-wide symbol search (Cmd+T): an index of declaration lines of all
// `.law` files in the workspace, cached by mtime; the kind goes in
// containerName so same-named declarations from different packages are told
// apart by file.
const SYMBOL_KINDS = { entity: 'Class', enum: 'Enum', record: 'Struct', relation: 'Function', function: 'Function', rule: 'Method',
  presumption: 'Method', constraint: 'Method', priority: 'Method', const: 'Constant', expand: 'Method', expansion: 'Method',
  source: 'Namespace', edition: 'Namespace', fragment: 'Field', test: 'Method', role: 'Interface' };

function workspaceSymbolIndex(workspace = vscode.workspace) {
  const entries = [];
  for (const ws of workspace.workspaceFolders ?? []) {
    for (const file of filesUnder(ws.uri.fsPath, '.law')) {
      const text = readCached(file);
      if (text !== null) entries.push(...workspaceLib.declarationLines(file, text));
    }
  }
  return entries;
}

function workspaceSymbolProvider() {
  // A provider belongs to the host instance that registered it. Capturing
  // the workspace keeps a later test-host activation from moving this
  // provider's search root; VS Code itself keeps the same workspace object
  // for the extension lifetime.
  const workspace = vscode.workspace;
  return {
    provideWorkspaceSymbols(query) {
      return workspaceLib.searchSymbols(workspaceSymbolIndex(workspace), query).map((entry) => new vscode.SymbolInformation(
        entry.name,
        vscode.SymbolKind[SYMBOL_KINDS[entry.kind] ?? 'Variable'],
        `${entry.kind}${entry.public ? ' · pub' : ''} · ${path.relative(workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', path.dirname(entry.file))}`,
        new vscode.Location(vscode.Uri.file(entry.file), new vscode.Range(entry.line, 0, entry.line, 0)),
      ));
    },
  };
}

// A CLIR node for a declaration (§209 StableId = <namespace>#<name>): the
// package is lowered the same way as for the "show CLIR" command, the node
// (and the `name/…` it generates) is opened as a `law-clir:` virtual
// document — a corpus CLIR file weighs tens of megabytes on one line and
// can't be opened whole.

function clirContentProvider() {
  return { provideTextDocumentContent: (uri) => clirNodes.get(uri.path) ?? '// node not found or stale — repeat the command' };
}

async function showClirNode(fsPath, name) {
  const editor = vscode.window.activeTextEditor;
  const target = fsPath ?? editor?.document?.uri.fsPath;
  if (!target) return null;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  const ast = await astFor(document);
  let word = name;
  if (!word && editor && editor.document.uri.fsPath === target) {
    const range = editor.document.getWordRangeAtPosition(editor.selection.active, WORD);
    word = range ? editor.document.getText(range) : null;
  }
  const namespace = ast?.namespace?.uri;
  if (!ast || !word || !namespace) {
    vscode.window.showWarningMessage('CLIR node: place the cursor on a declaration name in a file with a `namespace`.');
    return null;
  }
  const scope = await packageRootOf(document);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const file = await loweredToScratch({ root: scope.packaged ? scope.root : target, folder }, `clir-${path.basename(target)}.json`);
  if (!file) return null;
  let ir;
  try { ir = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const id = `${namespace}#${word}`;
  const nodes = (ir.nodes ?? []).filter((n) => n?.id === id || (typeof n?.id === 'string' && n.id.startsWith(`${id}/`)));
  if (!nodes.length) {
    vscode.window.showInformationMessage(`There is no node \`${id}\` in the CLIR: the declaration doesn't lower (entity, type) or the name is wrong.`);
    return null;
  }
  const content = `${JSON.stringify(nodes.length === 1 ? nodes[0] : nodes, null, 2)}\n`;
  const key = `/${encodeURIComponent(id)}.json`;
  clirNodes.set(key, content);
  const uri = vscode.Uri.parse(`law-clir:${key}`);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  return content;
}

// The other way around: from JSON (a corpus CLIR file, a node's virtual
// document, a vector's expected.json), Cmd+Click on a StableId leads to the
// declaration: namespace → package via workspace manifests → a sibling's
// declaration; `X/…` — to the instance.

function packageByNamespace(folder, namespace) {
  if (!folder) return null;
  let map = namespaceRoots.get(folder);
  if (!map) {
    map = new Map();
    for (const dir of manifestsUnder(folder)) {
      const ns = workspaceLib.manifestField(readCached(path.join(dir, 'law.toml')) ?? '', 'namespace');
      if (ns && !map.has(ns)) map.set(ns, dir);
    }
    namespaceRoots.set(folder, map);
  }
  return map.get(namespace) ?? null;
}

function clirDefinitionProvider() {
  return {
    async provideDefinition(document, position) {
      const text = document.getText();
      const hit = workspaceLib.stableIdAt(text, document.offsetAt(position));
      const parsed = hit ? workspaceLib.parseStableId(hit.id) : null;
      if (!parsed) return null;
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const dir = packageByNamespace(folder, parsed.namespace);
      if (!dir) return null;
      for (const file of packageLawFiles(dir, null)) {
        const entry = await siblingAst(file, folder);
        if (!entry) continue;
        const decl = declarationNamed(entry.ast, parsed.name) ?? (instanceNamed(entry.ast, parsed.name)
          ? { selection: instanceNamed(entry.ast, parsed.name).kind.name.span } : null);
        if (decl) return [new vscode.Location(vscode.Uri.file(file), toRange(entry.at, decl.selection))];
      }
      return null;
    },
  };
}

// Package panel: imports, who imports this package, and what's read from it
// without `pub` (§24 debt: the strict consumer check reports LDC-E1105). The
// "reads" branch is computed on expand — the civil code has three dozen
// consumers, and there's no point parsing them on every editor switch.
class PackageTree {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.scope = null;
  }

  async show(document) {
    const { root, packaged } = await packageRootOf(document);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    this.scope = packaged ? { root, folder, document } : null;
    this.changed.fire();
    await vscode.commands.executeCommand('setContext', 'lawPackageAvailable', Boolean(this.scope));
  }

  async facts() {
    if (!this.scope) return null;
    const { root, folder, document } = this.scope;
    const ast = await astFor(document);
    const files = await packageAsts(document, ast);
    const name = files.map((f) => workspaceLib.packageNameOf(f.ast)).find(Boolean);
    const imports = [];
    const seen = new Set();
    for (const f of files) for (const imp of workspaceLib.importsOf(f.ast)) if (!seen.has(imp.name)) { seen.add(imp.name); imports.push({ ...imp, file: f.file }); }
    const consumers = name ? manifestsUnder(folder ?? root)
      .filter((dir) => dir !== root && workspaceLib.manifestDependencies(readCached(path.join(dir, 'law.toml')) ?? '').includes(name)) : [];
    const ownDecls = files.flatMap((f) => declarations(f.ast).map((d) => ({ name: d.name, public: d.public })));
    return { root, folder, name, imports, consumers, ownDecls, files };
  }

  async getChildren(node) {
    const facts = await this.facts();
    if (!facts) return [];
    if (!node) {
      return [
        { kind: 'section', id: 'imports', label: `Imports: ${facts.imports.length}`, children: facts.imports.map((imp) => ({ kind: 'import', label: `${imp.name}${imp.version ? ` ${imp.version}` : ''}`, file: imp.file, span: imp.span })) },
        { kind: 'section', id: 'consumers', label: `Import me: ${facts.consumers.length}`, children: facts.consumers.map((dir) => ({ kind: 'consumer', label: path.relative(facts.folder ?? path.dirname(dir), dir), file: path.join(dir, 'law.toml') })) },
        { kind: 'section', id: 'readers', label: 'Read from me (pub and debt)', lazy: true },
      ];
    }
    if (node.id === 'readers') {
      const readers = [];
      for (const dir of facts.consumers) {
        for (const file of packageLawFiles(dir, null)) {
          const entry = await siblingAst(file, facts.folder);
          if (entry) readers.push({ file, ast: entry.ast });
        }
      }
      const debt = workspaceLib.pubDebt(facts.name, facts.ownDecls, readers);
      if (!debt.length) return [{ kind: 'note', label: facts.consumers.length ? 'sibling packages do not read qualified names' : 'no consumers' }];
      return debt.map((item) => ({
        kind: item.public ? 'pub' : item.declared ? 'debt' : 'missing',
        label: `${item.name} — ${item.public ? 'pub' : item.declared ? 'NO pub (§24 debt)' : 'NOT declared'} · read by: ${item.places.length}`,
        file: item.places[0]?.file, span: item.places[0]?.span,
      }));
    }
    return node.children ?? [];
  }

  getTreeItem(node) {
    const collapsible = node.kind === 'section'
      ? (node.lazy ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.iconPath = new vscode.ThemeIcon({ import: 'arrow-down', consumer: 'arrow-up', pub: 'check', debt: 'warning', missing: 'error', section: 'package' }[node.kind] ?? 'circle-outline');
    if (node.file) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.file)] };
    }
    return item;
  }
}


Object.assign(S, {
  astFor,
  symbolProvider,
  semanticTokensProvider,
  spansFor,
  siblingAst,
  packageLawFiles,
  siblingDeclaration,
  expansionDefinition,
  expansionTarget,
  expansionBridge,
  expansionHover,
  definitionProvider,
  referenceProvider,
  highlightProvider,
  completionProvider,
  isKeyword,
  renameProvider,
  workspaceSymbolIndex,
  workspaceSymbolProvider,
  clirContentProvider,
  showClirNode,
  packageByNamespace,
  clirDefinitionProvider,
});

S.packageTree = S.packageTree ?? new PackageTree();

}
}
})();
