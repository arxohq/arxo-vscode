'use strict';
// Inlays with §218 labels: a relation name in a rule's body or head, and in
// an `expand` instance's argument, gets its label's text in the selected
// language shown next to it — `cast_intentionally "the spell was cast
// intentionally"`. Labels live with declarations (in the file and in
// package neighbors §22), uses live in expressions.
//
// Has no semantics of its own (invariant 5): the AST's `labels` field is
// printed as-is; no translation, declension or §218.1 form selection is
// done here — the label's `text` is taken as-is. The user picks the
// language; a different language is never substituted: the absence of a
// label in the selected language shows up as the absence of an inlay.

const { splitQualified, qualifiedKey } = require('./dependencies');

const STATUS_RANK = { official: 0, unofficial: 1 };

/** Label in a language: exact match first, then the base language (`ru-KZ` → `ru`); official comes first. */
function choose(labels, language) {
  const wanted = String(language ?? '').toLowerCase();
  const base = wanted.split('-')[0];
  const of = (l) => String(l.language ?? '').toLowerCase();
  const exact = labels.filter((l) => of(l) === wanted);
  const pool = exact.length ? exact : labels.filter((l) => of(l).split('-')[0] === base);
  return [...pool].sort((a, b) => (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2))[0] ?? null;
}

/**
 * Index "declaration name → label in a language" over the package's files
 * [{ ast, origin }]. The first declaration of a name wins: names are unique
 * within a package (§24), and file order is the compiler's order. A
 * dependency file carries `package`: its declarations go under the
 * `pkg::name` key, and only when `pub` — only the export is visible from
 * outside (§24), and a reader is not entitled to a private declaration's label.
 */
function labelIndex(files, language) {
  const index = new Map();
  for (const { ast, origin = null, package: pkg = null } of files) {
    for (const decl of ast?.decls ?? []) {
      const name = decl.kind?.name?.text;
      const labels = decl.labels ?? [];
      if (!name || !labels.length) continue;
      if (pkg && !decl.public) continue;
      const key = pkg ? qualifiedKey(pkg, name) : name;
      if (index.has(key)) continue;
      const label = choose(labels, language);
      if (label) index.set(key, { text: label.text, language: label.language, status: label.status, origin });
    }
  }
  return index;
}

/**
 * Uses of relation names in the file: calls in expressions
 * (`callee.parts`), literals of premises and heads (`relation.parts`),
 * references in `expand` arguments (`reference`, `some`, `list` elements).
 * Qualified `pkg::name` go under the `pkg::name` key — their labels live
 * with the dependency (lib/dependencies.js). Order is by offset.
 */
function labelUses(ast) {
  const out = [];
  const seen = new Set();
  const push = (text, span) => {
    if (!text || !span) return;
    const key = `${span.start}:${span.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: text, span });
  };
  const pushPath = (pathNode) => {
    const q = splitQualified(pathNode);
    if (q) { push(q.key, q.nameSpan); return; }
    const last = pathNode.parts.at(-1);
    push(last?.text, last?.span);
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.kind === 'call' && node.callee?.kind === 'path' && node.callee.parts?.length) {
      pushPath(node.callee);
    } else if (node.relation?.parts?.length) {
      pushPath(node.relation);
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'span') walk(value);
  };
  for (const decl of ast?.decls ?? []) {
    const kind = decl.kind ?? {};
    if (kind.kind === 'expand') {
      const args = [...(kind.arguments ?? []), ...(kind.cases ?? []).flatMap((c) => c.arguments ?? [])];
      for (const arg of args) {
        const value = arg.value ?? {};
        if (value.kind === 'reference' || value.kind === 'some') push(value.text, value.span);
        if (value.kind === 'list') for (const item of value.items ?? []) push(item.text, item.span);
      }
      continue;
    }
    walk(kind);
  }
  return out.sort((a, b) => a.span.start - b.span.start);
}

/** Inlay text: the whole label if short; otherwise truncated with an ellipsis. */
function hintText(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

module.exports = { labelIndex, labelUses, hintText, choose };
