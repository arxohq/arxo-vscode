'use strict';

// DECISION-0187 source rewrites. The preview reparses every candidate and
// compares ASTs before offering Apply. Extended shells stay in their full form.
function hasComment(text) {
  return [...text.matchAll(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|(\/\/|\/\*)/g)].some((match) => Boolean(match[1]));
}

function compactActions(node, { text, index, slice, add }) {
  const priority = node.kind;
  if (priority?.kind === 'priority' && !priority.policy && !priority.binders?.length
    && !priority.when && priority.reason && !node.labels?.length) {
    const start = index(priority.name.span.end);
    const end = index(node.span.end);
    const shell = text.slice(start, end);
    if (!hasComment(shell) && /^\s*\{\s*prefer\s+[^;]+;\s*reason\s+[^;]+;\s*\}\s*$/.test(shell)) {
      add('priority-compact', 'Priority → compact notation', node.span, [{ start, end,
        newText: `: ${slice(priority.prefer.span)} > ${slice(priority.over.span)} reason ${slice(priority.reason.span)};` }]);
    }
  }

  // FactsDecl contains untagged AssertDecl objects as well as tagged asserts.
  if (node.atom && typeof node.negated === 'boolean' && node.fields?.length && node.span) {
    const ids = node.fields.filter((f) => f.name.text === 'id');
    const field = ids[0];
    if (ids.length === 1 && field === node.fields[0] && field.value.kind === 'str') {
      const start = index(field.span.start);
      const end = index(field.span.end);
      const insert = index(node.span.start) + 'assert'.length;
      const tail = /^\s*;/.exec(text.slice(end));
      if (text.slice(start, start + 2) === 'id' && tail
        && text.slice(index(node.span.start), insert) === 'assert'
        && !hasComment(text.slice(start, end))) {
        add('assert-compact', 'Assertion ID → assert header', node.span, [
          { start: insert, end: insert, newText: ` ${slice(field.value.span)}:` },
          { start, end: end + tail[0].length, newText: '' },
        ]);
      }
    }
  }

  if (node.kind !== 'call' || node.args?.length !== 1 || node.arg_names?.length) return;
  const callee = node.callee;
  const collect = node.args[0];
  if (callee.kind !== 'path' || callee.qualified || callee.parts.length !== 1
    || !['sum', 'count', 'min', 'max'].includes(callee.parts[0].text) || collect.kind !== 'collect') return;
  const start = index(node.span.start);
  const end = index(node.span.end);
  if (!/^\s*\(/.test(text.slice(index(callee.span.end)))
    || hasComment(text.slice(start, end)) || text[end - 1] !== ')') return;
  const lastType = collect.binders?.at(-1)?.ty ?? collect.ty;
  const suffixStart = index(lastType.span.end);
  const where = /^\s*where\s+/.exec(text.slice(suffixStart, end));
  if (!where) return;
  const typed = (name, ty) => `${slice(name.span)}: ${slice(ty.span)}`;
  const extra = collect.binders?.length
    ? ` for ${collect.binders.map((p) => typed(p.name, p.ty)).join(', ')}` : '';
  // Keep transparent parentheses around the generator from the source, and
  // delimit the whole aggregate in any enclosing comparison or arithmetic.
  const generator = text.slice(suffixStart + where[0].length, end - 1);
  add('aggregate-compact', 'Aggregate → explicit all / distinct projection', node.span, [{ start, end,
    newText: `(${callee.parts[0].text} ${collect.distinct ? 'distinct' : 'all'} ${typed(collect.name, collect.ty)}${extra} where ${generator})` }]);
}

module.exports = { compactActions };
