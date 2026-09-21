'use strict';
// Conformance vectors: `lawc eval <directory>` executes ir.json + case.json +
// query.json and prints the canonical bytes of the result.
//
// Comparison against the golden is not textual: expected.json is stored
// unfolded, and eval prints canonical bytes, so the canonical bytes of both
// sides are compared (`lawc canon expected.json`) — exactly the equality
// relation used by the vector runner and the §208 gates.

const REQUIRED = ['ir.json', 'query.json'];

/** Lens header and what can be done with this vector. */
function summarize(meta, present) {
  const files = new Set(present);
  const head = [meta?.id, meta?.layer, meta?.status, meta?.artifacts?.mode].filter(Boolean).join(' · ');
  const refs = (meta?.specRefs ?? []).join(', ');
  const requirement = meta?.requirement ? ` — ${meta.requirement}` : '';
  const evaluable = REQUIRED.every((f) => files.has(f));
  return {
    title: [head, refs].filter(Boolean).join(' · ') + requirement,
    evaluable,
    comparable: evaluable && files.has('expected.json'),
  };
}

module.exports = { summarize, REQUIRED };
