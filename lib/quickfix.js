'use strict';
// Simple fixes derived from a diagnostic; a rule's strength is addressed via the AST.
const { walk } = require('./syntax-actions');
const { ByteMap } = require('./offsets');

// Fixes act on the machine facts of a diagnostic (§225 `machineData`), never
// on its message: the contract of a static diagnostic is its code and those
// facts, and the wording is free to change.

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
    const data = diag.machineData?.kind === 'sourceHashMismatch' ? diag.machineData : null;
    if (data?.declared && data.actual) {
      const { declared, actual } = data;
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
