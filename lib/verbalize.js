'use strict';
// Verbalization index by node, and paragraph addressing for a declaration.
// No semantics (invariant 5): node ids come from the CLIR via
// `lawref verbalize --json`, here it's only search over them.

/**
 * Response of `lawref verbalize --json` → { text, namespace, gaps, blocks },
 * where blocks is Map(node id → { text, heading, line, lines }). Blocks come
 * in document order, each one's address is the first occurrence of its text
 * after the previous one.
 */
function blockIndex(payload) {
  const text = payload?.text ?? '';
  const blocks = new Map();
  let cursor = 0;
  for (const block of payload?.blocks ?? []) {
    if (typeof block?.text !== 'string' || !block.nodeId) continue;
    const at = text.indexOf(block.text, cursor);
    if (at === -1) continue;
    const line = text.slice(0, at).split('\n').length - 1;
    const lines = block.text.replace(/\s+$/, '').split('\n').length;
    blocks.set(block.nodeId, { text: block.text, heading: block.heading ?? null, line, lines });
    cursor = at + block.text.length;
  }
  return { text, namespace: payload?.namespace ?? null, gaps: (payload?.gaps ?? []).length, blocks };
}

/**
 * A declaration's CLIR nodes: its own id (`@id` or `<ns>#<name>`) and those
 * generated from it (`<id>/…`: an expansion instance §279.1.4, suffixed
 * sugar forms §206 — `/R1`). The namespace is the package's, from the CLIR:
 * a multi-file package's module header carries no `namespace`, and the file
 * is not the source here.
 */
function nodeIdsFor(namespace, decl, blocks) {
  const own = decl?.id ?? (namespace && decl?.name ? `${namespace}#${decl.name}` : null);
  if (!own) return [];
  const ids = blocks.has(own) ? [own] : [];
  for (const id of blocks.keys()) if (id.startsWith(`${own}/`)) ids.push(id);
  return ids;
}

module.exports = { blockIndex, nodeIdsFor };
