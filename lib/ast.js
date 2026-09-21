'use strict';
// File structure and semantic tokens from the compiler's AST
// (`lawc parse <file> --ast`). Spans in the AST are byte spans; converting
// them to editor positions is done by offsets.js — the work here is only
// with offsets.
//
// The point of semantic tokens is not cosmetic: TextMate colors a word by
// appearance, so a contextual keyword in a name position looks like a
// keyword. The parser has a span for the name even where it complains about
// this construct (bvr.law: `event` as a parameter name, LDC-E0203) — so the
// name can be colored as a name.

// Declaration kind → token type and symbol kind in the file structure.
const DECL_KINDS = {
  entity: ['type', 'Class'],
  enum: ['type', 'Enum'],
  record: ['type', 'Struct'],
  type: ['type', 'Class'],
  concept: ['type', 'Interface'],
  role: ['type', 'Interface'],
  relation: ['function', 'Function'],
  function: ['function', 'Function'],
  rule: ['function', 'Method'],
  constraint: ['function', 'Method'],
  presumption: ['function', 'Method'],
  priority: ['function', 'Method'],
  source: ['namespace', 'Namespace'],
  edition: ['namespace', 'Namespace'],
  publication: ['namespace', 'Namespace'],
  fragment: ['namespace', 'Field'],
  const: ['variable', 'Constant'],
  case: ['variable', 'Struct'],
  test: ['function', 'Method'],
  // Parser growth on 30.08.2026: event, action and interpretation stopped
  // being opaque nodes and now arrive as proper declarations (fields/body in the AST).
  event: ['type', 'Struct'],
  action: ['type', 'Struct'],
  interpretation: ['namespace', 'Namespace'],
  // The rest of the `DeclKind::kind_name` registry (law-syntax/src/ast.rs)
  // and 0.2 forms (DECISION-0111: `term`, `stage`, `deadline policy`,
  // `precedent`, `factors`, lexical blocks). Without a row here the kind
  // falls into FALLBACK and shows up in the file structure as an unnamed "Object".
  interpretation_group: ['namespace', 'Namespace'],
  decision: ['function', 'Method'],
  counterfactual: ['function', 'Method'],
  fiction: ['function', 'Method'],
  classification: ['function', 'Method'],
  definition: ['function', 'Method'],
  closure: ['function', 'Method'],
  entrenchment: ['function', 'Method'],
  procedure: ['type', 'Class'],
  term: ['function', 'Method'],
  'deadline policy': ['variable', 'Constant'],
  temporal_resolution_policy: ['variable', 'Constant'],
  unit: ['variable', 'Constant'],
  snapshot: ['namespace', 'Namespace'],
  stage: ['type', 'Struct'],
  precedent: ['namespace', 'Namespace'],
  factors: ['variable', 'Struct'],
  property: ['function', 'Method'],
  query: ['function', 'Method'],
  calendar: ['variable', 'Constant'],
  reference: ['namespace', 'Field'],
  align: ['namespace', 'Field'],
  revision: ['namespace', 'Namespace'],
  evidence: ['variable', 'Struct'],
  support: ['variable', 'Struct'],
  facts: ['variable', 'Struct'],
  assert: ['variable', 'Struct'],
  map: ['variable', 'Struct'],
  context: ['variable', 'Struct'],
  // Expansion profile DECISION-0126 (§279.1): a scheme's definition and its
  // instance in an act; evidence policy is a 0.2 form.
  expansion: ['function', 'Method'],
  expand: ['function', 'Method'],
  'evidence policy': ['variable', 'Constant'],
};
const FALLBACK = ['variable', 'Object'];
const declKind = (kind) => DECL_KINDS[kind] ?? FALLBACK;

const named = (n) => (n && n.span ? n : null);
const std = require('./std');

function declName(kind) {
  // A test §267 is named by a string header, not an identifier: the node
  // carries `title` (text without quotes) and `title_span` (with quotes)
  // instead of a { text, span } pair. Without this branch a test drops out
  // of the file structure entirely — silently, because `symbols` skips unnamed declarations.
  if (typeof kind.title === 'string' && kind.title_span) {
    return { text: kind.title, span: kind.title_span };
  }
  if (kind.kind === 'assert') {
    const id = kind.fields?.find((f) => f.name?.text === 'id' && f.value?.kind === 'str');
    if (id) return { text: id.value.value, span: id.value.span };
  }
  return named(kind.name) ?? named(kind.alias) ?? named(kind.keyword);
}

function detailOf(kind) {
  if (kind.kind === 'opaque') return kind.keyword ? kind.keyword.text : '';
  // The construct's kind stays visible in the structure, as it was with the opaque node.
  if (kind.kind === 'event' || kind.kind === 'action') return kind.kind;
  if (kind.parent && kind.parent.text) return `: ${kind.parent.text}`;
  const params = (kind.params ?? []).map((p) => `${p.name?.text ?? '?'}: ${p.ty?.name ?? '?'}`);
  if (params.length) return `(${params.join(', ')})`;
  if (kind.strength && kind.strength.text) return kind.strength.text;
  return '';
}

/** File structure tree: declarations, with parameters and quantifiers inside. */
function symbols(file) {
  const out = [];
  for (const decl of file.decls ?? []) {
    const kind = decl.kind ?? {};
    const name = declName(kind);
    if (!name || !decl.span) continue;
    const [, symbolKind] = declKind(kind.kind);
    const children = [];
    for (const p of kind.params ?? []) {
      if (p.name && p.name.span) {
        children.push({
          name: p.name.text,
          detail: p.ty?.name ?? '',
          kind: 'Variable',
          span: p.span ?? p.name.span,
          selection: p.name.span,
          children: [],
        });
      }
    }
    for (const q of kind.quantifiers ?? []) {
      if (q.name && q.name.span) {
        children.push({
          name: q.name.text,
          detail: q.ty?.name ?? '',
          kind: 'Variable',
          span: q.name.span,
          selection: q.name.span,
          children: [],
        });
      }
    }
    for (const f of kind.fields ?? []) {
      if (f.name && f.name.span) {
        children.push({
          name: f.name.text,
          detail: f.ty?.name ?? '',
          kind: 'Field',
          span: f.span ?? f.name.span,
          selection: f.name.span,
          children: [],
        });
      }
    }
    out.push({
      name: name.text,
      detail: detailOf(kind),
      kind: kind.kind === 'opaque' ? 'Object' : symbolKind,
      span: decl.span,
      selection: name.span,
      children,
    });
  }
  return out;
}

// A type reference in the AST is an object { name: string, args: [], span };
// this differs from a declaration name, where name is an object { text, span }.
function collectTypeRefs(node, push, options) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypeRefs(item, push, options);
    return;
  }
  if (typeof node.name === 'string' && node.span && Array.isArray(node.args)) {
    std.typeTokens(node, push, options);
  }
  for (const value of Object.values(node)) collectTypeRefs(value, push, options);
}

/** Flat list of semantic tokens, sorted and non-overlapping. */
function tokens(file, options = {}) {
  const localTypes = new Set(options.localTypes ?? (file.decls ?? [])
    .filter((d) => declKind(d.kind?.kind)[0] === 'type')
    .map((d) => d.kind.name?.text));
  const packages = new Set((file.imports ?? []).map((i) => i.package.parts.map((p) => p.text).join('.')));
  if (file.package) packages.add(file.package.name.parts.map((p) => p.text).join('.'));
  const raw = [];
  const push = (span, type, modifiers = []) => {
    if (span && Number.isInteger(span.start) && span.end > span.start) {
      raw.push({ start: span.start, end: span.end, type, modifiers });
    }
  };

  for (const part of file.package?.name?.parts ?? []) push(part.span, 'namespace');
  for (const decl of file.decls ?? []) {
    const kind = decl.kind ?? {};
    for (const ann of decl.annotations ?? []) push(ann.name?.span, 'decorator');
    push(kind.keyword?.span, 'keyword');
    const name = named(kind.name) ?? named(kind.alias);
    if (name) push(name.span, declKind(kind.kind)[0], ['declaration']);
    for (const p of kind.params ?? []) push(p.name?.span, 'parameter', ['declaration']);
    for (const q of kind.quantifiers ?? []) push(q.name?.span, 'variable', ['declaration']);
    for (const f of kind.fields ?? []) {
      // A header ID synthesizes a field whose name span is the quoted ID.
      // Keep the string highlighting instead of painting it as property `id`.
      if (f.name?.text === 'id' && f.value?.kind === 'str'
        && f.name.span.start === f.value.span.start) continue;
      push(f.name?.span, 'property', ['declaration']);
    }
    for (const key of kind.keys ?? []) for (const part of key ?? []) push(part.span, 'parameter');
    collectTypeRefs(kind, push, { ...options, localTypes });
    std.expressionTokens(kind, push, { localTypes, packages });
    walk(kind, (node) => {
      for (const name of node.arg_names ?? []) push(name?.span, 'parameter');
    });
  }

  // The semantic tokens protocol requires non-overlapping tokens in ascending order.
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const token of raw) {
    const previous = out[out.length - 1];
    if (previous && token.start < previous.end) continue;
    out.push(token);
  }
  return out;
}

// AST traversal: identifier nodes arrive as { text, span } (names, path
// parts in expressions), type references as { name: string, args, span }.
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

/** All occurrences of an identifier in the file, in ascending order of offset. */
function occurrences(file, name) {
  const spans = [];
  const argumentLabels = new Set();
  walk(file, (node) => {
    for (const label of node.arg_names ?? []) if (label?.span) argumentLabels.add(label.span.start);
  });
  walk(file, (node) => {
    if (!node.span || !Number.isInteger(node.span.start)) return;
    // Named argument labels refer to the callee's signature, not to a
    // same-named symbol in the caller. Generic file rename cannot resolve them.
    if (argumentLabels.has(node.span.start)) return;
    if (node.text === name || (typeof node.name === 'string' && node.name === name && Array.isArray(node.args))) {
      spans.push(node.span);
    }
  });
  const unique = new Map(spans.map((s) => [`${s.start}:${s.end}`, s]));
  return [...unique.values()].sort((a, b) => a.start - b.start);
}

/** Flat list of the file's declarations: name, kind, detail, spans. */
function declarations(file) {
  const out = [];
  for (const decl of file.decls ?? []) {
    const kind = decl.kind ?? {};
    const name = declName(kind);
    if (!name || !decl.span) continue;
    out.push({
      name: name.text,
      kind: kind.kind === 'opaque' ? (kind.keyword?.text ?? 'opaque') : kind.kind,
      detail: detailOf(kind),
      id: (decl.annotations ?? []).find((a) => a.name?.text === 'id')?.args?.[0] ?? null,
      public: Boolean(decl.public),
      span: decl.span,
      selection: name.span,
      // The whole node — for hover: labels §218, annotations §15, fields §35
      // and fragment texts §28 live in it, and a flat record cannot hold them.
      node: decl,
    });
  }
  return out;
}

const declarationNamed = (file, name) => declarations(file).find((d) => d.name === name) ?? null;

module.exports = { symbols, tokens, occurrences, declarations, declarationNamed, DECL_KINDS };
