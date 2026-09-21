'use strict';
// Simple fixes derived from a diagnostic; a rule's strength is addressed via the AST.
const { walk } = require('./syntax-actions');
const { ByteMap } = require('./offsets');

const HASH_RE = /объявлен (sha256:[0-9a-fA-F]+), фактический (sha256:[0-9a-fA-F]+)/;
const KEYWORD_RE = /^`([A-Za-z_][A-Za-z0-9_]*)`/;

/**
 * @param diag diagnostic after locate(): code, message, startOffset, endOffset
 * @param text document text
 * @returns [{ title, edits: [{ start, end, newText }] }] in UTF-16 offsets
 */
function fixesFor(diag, text, ast = null, index = null) {
  if (!index) {
    const map = new ByteMap(text);
    index = (offset) => map.offsetOf(map.positionAt(offset));
  }
  const fixes = [];

  // §194: the official text's hash diverged from the declared content_hash.
  // The compiler has already computed and printed the actual hash — substitute it.
  if (diag.code === 'LDC-E5201') {
    const m = HASH_RE.exec(diag.message);
    if (m) {
      const [, declared, actual] = m;
      const inToken = text.indexOf(declared, diag.startOffset);
      const at = inToken !== -1 && inToken < diag.endOffset ? inToken : text.indexOf(declared);
      if (at !== -1) {
        fixes.push({
          title: `§194: substitute the actual ${actual.slice(0, 14)}…`,
          edits: [{ start: at, end: at + declared.length, newText: actual }],
        });
      }
    }
  }

  // §15: a hard keyword in name position. The legitimate way out is a quoted identifier §14.
  if (diag.code === 'LDC-E0203' || diag.code === 'LDC-E0201') {
    const m = KEYWORD_RE.exec(diag.message);
    const word = text.slice(diag.startOffset, diag.endOffset);
    if (m && m[1] === word) {
      fixes.push({
        title: `§14: wrap \`${word}\` in backticks`,
        edits: [{ start: diag.startOffset, end: diag.endOffset, newText: '`' + word + '`' }],
      });
    }
  }

  // §111 / DECISION-0088: a strict rule reads the defeated head. Between the
  // name and the strength in the header there can be parameters and comments.
  // Without an AST we don't guess which strict should be replaced.
  if (diag.code === 'LDC-E4103') {
    walk(ast, (rule) => {
      if (rule.kind !== 'rule' || rule.strength?.text !== 'strict'
        || !rule.name?.span || index(rule.name.span.start) !== diag.startOffset
        || index(rule.name.span.end) !== diag.endOffset) return;
      const start = index(rule.strength.span.start);
      const end = index(rule.strength.span.end);
      if (text.slice(start, end) !== 'strict') return;
      fixes.push({
        title: `§111: write rule \`${rule.name.text}\` as defeasible (DECISION-0088)`,
        edits: [{ start, end, newText: 'defeasible' }],
      });
    });
  }

  return fixes;
}

module.exports = { fixesFor };
