'use strict';

const { walk } = require('./syntax-actions');
const { typeText } = require('./signatures');

// Declared types only: no inference or package name resolution in the editor.
// A nested binder blocks the same outer name conservatively over its span.
function ruleBindings(ast, offset, index) {
  const contains = (span) => span && index(span.start) <= offset && offset < index(span.end);
  const rules = [];
  walk(ast, (node) => {
    if (['rule', 'presumption', 'constraint', 'term'].includes(node.kind?.kind) && contains(node.span)) rules.push(node);
  });
  rules.sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start));
  const rule = rules[0]?.kind;
  if (!rule) return [];
  const hidden = new Set();
  walk(rule, (node) => {
    if (!contains(node.span)) return;
    if (['let', 'collect', 'quantified'].includes(node.kind)) {
      if (node.name?.text) hidden.add(node.name.text);
      for (const binder of node.binders ?? []) hidden.add(binder.name?.text);
    }
    if (node.kind === 'opaque') for (const binder of rule.quantifiers ?? []) hidden.add(binder.name?.text);
  });
  return (rule.quantifiers ?? []).filter((p) => !hidden.has(p.name?.text)).map((p) => ({
    name: p.name.text, type: typeText(p.ty), span: p.name.span, owner: rule.name.text, ownerKind: rule.kind,
    header: rule.strength ? p.name.span.start < rule.strength.span.start : null,
  }));
}

function ruleBindingAt(ast, offset, index) {
  const bindings = ruleBindings(ast, offset, index);
  let hit = bindings.find((b) => index(b.span.start) <= offset && offset < index(b.span.end));
  if (hit) return hit;
  const callees = new Set();
  walk(ast, (node) => {
    if (node.kind === 'call' && node.callee?.span) callees.add(node.callee.span.start);
  });
  walk(ast, (node) => {
    if (node.kind !== 'path' || node.qualified || node.parts?.length !== 1 || callees.has(node.span?.start)) return;
    const part = node.parts[0];
    if (index(part.span.start) <= offset && offset < index(part.span.end)) {
      hit = bindings.find((b) => b.name === part.text);
    }
  });
  return hit ?? null;
}

module.exports = { ruleBindings, ruleBindingAt };
