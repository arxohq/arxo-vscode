
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
// Hover: dictionary card, expansion parameter, qualified name.

// §28 source texts for `@source(X)` annotations: an identifier argument is
// resolved as an ordinary package name — first in the file, then in siblings.
// A string argument is not resolved: it is a locator, not a declaration name.
async function annotatedSources(document, ast, node) {
  const names = (node?.annotations ?? [])
    .filter((a) => a.name?.text === 'source')
    .flatMap((a) => a.args ?? [])
    .filter((arg) => typeof arg === 'string' && WORD.test(arg) && !arg.startsWith('"'));
  const out = [];
  for (const name of [...new Set(names)]) {
    const local = ast ? declarationNamed(ast, name) : null;
    const decl = local ?? (await siblingDeclaration(document, name))?.decl ?? null;
    if (decl) out.push({ name: decl.name, node: decl.node });
  }
  return out;
}
function hoverProvider(context, literate) {
  return {
    async provideHover(document, position) {
      if (!config().get('hover.enabled', true)) return null;
      const hit = wordAt(document, position, literate);
      if (!hit) return null;

      const ast = await astFor(document);
      const words = dictionary(context);
      const binding = ast ? ruleBindingAt(ast, hit.offset, slicerFor(document).index) : null;
      if (binding) {
        const markdown = new vscode.MarkdownString();
        markdown.appendCodeblock(`${binding.name}: ${binding.type}`, 'law');
        markdown.appendText(`Parameter of ${binding.ownerKind} ${binding.owner}${binding.header === null ? '' : `; declared ${binding.header ? 'in the header' : 'in for'}`}.`);
        return new vscode.Hover(markdown, hit.range);
      }
      // A parameter name in an `expand` instance (§279.1.3) is not declared
      // here but in the expansion definition: its card is built from that
      // before the dictionary — otherwise `guilt` or `elements` would be
      // silently treated as unknown words.
      const parameter = ast ? await expansionHover(document, ast, hit, words) : null;
      if (parameter) return parameter;
      // `pkg::name` — a DEPENDENCY declaration (§23–§25); look it up before
      // local ones, since a same-named local declaration would otherwise
      // shadow the foreign one.
      const alias = ast ? stdLibrary.aliasAt(ast, hit.offset, slicerFor(document).index) : null;
      if (alias) {
        const markdown = new vscode.MarkdownString();
        markdown.appendCodeblock(`${alias.alias}(...) → ${alias.result}`, 'law');
        markdown.appendMarkdown(`Alternative spelling of \`${alias.canonical}\` (§259.0). Arguments and precision rules are the same.`);
        return new vscode.Hover(markdown, hit.range);
      }
      const qualified = ast ? await qualifiedDeclaration(document, ast, hit) : null;
      if (qualified) return qualifiedCard(document, ast, qualified, words);
      // the declaration is looked up in the file, then in sibling files of
      // the §22 package — hover must answer wherever go-to-definition answers
      const local = ast ? declarationNamed(ast, hit.word) : null;
      const found = local ? null : await siblingDeclaration(document, hit.word);
      const decl = local ?? found?.decl ?? null;
      // A rule variable in a call argument is not itself a declaration: its
      // card is the signature parameter (type, position) and the `for` quantifier.
      const argument = !decl && ast ? await argumentCard(document, ast, hit) : null;
      if (argument) return argument;
      const entry = decl ? words[decl.kind] : words[hit.word];
      if (!decl && !entry) return null;

      const compact = config().get('hover.detail', 'full') !== 'full';
      if (!decl || compact) return render({ entry, decl, node: decl?.node, compact: true });

      // The declaration's source, the comment above it, and its occurrences
      // are read from whichever file the declaration lives in: the local one
      // from the document, a sibling's from the sibling parse cache, where
      // the text has already been read for the byte map.
      const maxLines = Math.max(1, config().get('hover.maxLines', 14));
      const where = local ? slicerFor(document) : found?.entry ?? null;
      let slice = null;
      let comment = null;
      if (where && decl.span) {
        const start = where.index(decl.span.start);
        slice = sourceSlice(where.text.slice(start, where.index(decl.span.end)), maxLines);
        comment = leadingComment(where.text, start);
      }
      return render({
        decl,
        node: decl.node,
        entry,
        slice,
        comment,
        sources: await annotatedSources(document, ast, decl.node),
        origin: found ? path.basename(found.sibling) : null,
        usages: ast ? occurrences(ast, hit.word).length : 0,
        spoken: ast ? await spokenFor(document, ast, decl) : null,
      });
    },
  };
}
// Call argument card: `z: Integer — parameter 1 of 3 of element_mass` plus
// the enclosing rule's `for z: Integer` quantifier. The argument's span
// (AST bytes) is compared with the cursor position via positionMapper — for
// literate this accounts for the §217 assembly.
async function argumentCard(document, ast, hit) {
  const contains = spanContains(document, hit.offset);
  const index = signatureIndex(await worldAsts(document, ast));
  const found = argumentHover(ast, index, hit.word, contains);
  if (!found) return null;
  const parts = [`**parameter** ${found.text}`];
  if (found.binding) {
    const type = found.binding.type ? `: ${found.binding.type}` : '';
    parts.push(`\`for ${found.binding.name}${type}\`${found.binding.owner ? ` — variable \`${found.binding.owner}\`` : ''}`);
  }
  return new vscode.Hover(new vscode.MarkdownString(parts.join('\n\n')), hit.range);
}

Object.assign(S, {
  annotatedSources,
  hoverProvider,
  argumentCard,
});

}
}
})();
