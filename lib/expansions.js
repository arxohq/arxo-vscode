'use strict';
// Hover for an expansion parameter §279.1 (DECISION-0126). A name in the
// argument or `bind` position of an `expand` instance is not declared in
// this file — it is a parameter of the `expansion` DEFINITION, which lives
// in another package (an alias from `[expansions]` in law.toml, §279.1.8)
// or in a sibling file of the same package (§279.1.3). This file reads the
// AST of both sides and builds the card text; resolving the alias to a
// package and parsing the files is done by extension.js.
//
// Carries no semantics of its own (invariant 5): it prints the AST field as
// is, the author's parameter text slice, and the comment above it — the
// place where the parameter's explanation actually lives, in the definition
// packages.

const within = (span, offset, index) =>
  Boolean(span) && offset >= index(span.start) && offset < index(span.end);

/**
 * The `expand` instance parameter at a document offset: an argument, a
 * `case` field, or a `bind`. `index` maps an AST byte span to a document
 * offset (literate mode uses the block map); identity by default.
 */
function expansionArgumentAt(file, offset, index = (byte) => byte) {
  for (const decl of file?.decls ?? []) {
    const kind = decl.kind ?? {};
    if (kind.kind !== 'expand' || !within(decl.span, offset, index)) continue;
    const reference = kind.reference?.text ?? null;
    const instance = kind.name?.text ?? null;
    // The reference itself `expand <reference> …` is the go-to-definition target for `expansion <reference>`.
    if (within(kind.reference?.span, offset, index)) {
      return { reference, instance, param: null, role: 'reference' };
    }
    for (const bind of kind.binds ?? []) {
      if (within(bind.param?.span, offset, index)) {
        return { reference, instance, param: bind.param.text, role: 'bind' };
      }
    }
    for (const arg of kind.arguments ?? []) {
      if (within(arg.name?.span, offset, index)) {
        return { reference, instance, param: arg.name.text, role: 'argument' };
      }
    }
    for (const c of kind.cases ?? []) {
      if (within(c.param?.span, offset, index)) {
        return { reference, instance, param: c.param.text, role: 'case' };
      }
      for (const arg of c.arguments ?? []) {
        if (within(arg.name?.span, offset, index)) {
          return { reference, instance, param: arg.name.text, role: 'field', of: c.param?.text ?? null };
        }
      }
    }
    return null;
  }
  return null;
}

/** The `expansion <name>` definition in the file's AST; without a name, the file's sole definition. */
function expansionNamed(file, name = null) {
  const found = (file?.decls ?? []).filter((d) => d.kind?.kind === 'expansion');
  if (name) return found.find((d) => d.kind.name?.text === name) ?? null;
  return found.length === 1 ? found[0] : null;
}

/**
 * A definition parameter by name: top level, then `cases` fields
 * (§279.1.2: a `case` record field is named as a `cases`-parameter field).
 */
function parameterNamed(expansion, name, of = null) {
  const params = expansion?.kind?.params ?? [];
  if (of) {
    const owner = params.find((p) => p.name?.text === of);
    return (owner?.ty?.fields ?? []).find((f) => f.name?.text === name) ?? null;
  }
  const top = params.find((p) => p.name?.text === name);
  if (top) return top;
  for (const p of params) {
    const field = (p.ty?.fields ?? []).find((f) => f.name?.text === name);
    if (field) return field;
  }
  return null;
}

/**
 * Where to go-to-definition from an instance element: for a reference — the
 * definition's name; for a parameter, `bind`, `case`, or field — the
 * parameter's name in `params` (§279.1.2). `node` is a parameter already
 * found by parameterNamed; null if there is none.
 */
function targetSpan(definition, arg, node = null) {
  if (!definition) return null;
  if (arg?.role === 'reference') return definition.kind?.name?.span ?? definition.span ?? null;
  return node?.name?.span ?? node?.span ?? null;
}

// ------------------------------------------------ "rule -> instance" bridge

/**
 * Name of a generated node §279.1.4: `X/elements`, `X/exemption/Voluntary/excludes`
 * -> { instance: 'X', tail: [...] }. A plain name (no slash) yields null: a
 * slash is not allowed in a plain identifier, so there is no ambiguity.
 */
function generatedRuleName(name) {
  if (typeof name !== 'string') return null;
  const parts = name.split('/');
  if (parts.length < 2 || parts.some((part) => !part)) return null;
  return { instance: parts[0], tail: parts.slice(1) };
}

/** The `expand <reference> <name>` instance in the file's AST. */
const instanceNamed = (file, name) =>
  (file?.decls ?? []).find((d) => d.kind?.kind === 'expand' && d.kind.name?.text === name) ?? null;

/** An instance case by name (`case <param> <name> { … }`). */
const caseNamed = (instance, name) =>
  (instance?.kind?.cases ?? []).find((c) => c.name?.text === name) ?? null;

/**
 * A definition's `emit` by an id tail: `name` segments match literally, a
 * `key` segment (`key(c)`) accepts the case name — which is what gets
 * returned, so the target is the case, not the whole instance. Nested
 * `for each` is traversed.
 */
function emitFor(definition, tail) {
  const flat = [];
  const walk = (items) => {
    for (const item of items ?? []) {
      if (item.kind === 'each') walk(item.items);
      else if (item.path) flat.push(item);
    }
  };
  walk(definition?.kind?.emits);
  const match = (want) => {
    for (const emit of flat) {
      const segments = emit.path.segments ?? [];
      if (segments.length !== want.length) continue;
      let caseName = null;
      const ok = segments.every((segment, i) => {
        if (segment.kind === 'key') { caseName = tail[i]; return true; }
        return segment.text === want[i];
      });
      if (ok) return { emit, caseName };
    }
    return null;
  };
  const direct = match(tail);
  if (direct) return direct;
  // §279.2.4: the deontic emit's template node is `<rule path>/norm`;
  // resolves to the same emit, flagged as the second node.
  if (tail.length >= 2 && tail.at(-1) === 'norm') {
    const owner = match(tail.slice(0, -1));
    if (owner?.emit?.deontic) return { ...owner, template: true };
  }
  return null;
}

// ------------------------------------------------- completion inside expand

/** The `expand` instance whose body contains the offset, and the case if the cursor is inside its body. */
function instanceAt(file, offset, index = (byte) => byte) {
  for (const decl of file?.decls ?? []) {
    const kind = decl.kind ?? {};
    if (kind.kind !== 'expand' || !within(decl.span, offset, index)) continue;
    const inCase = (kind.cases ?? []).find((c) => within(c.span, offset, index)) ?? null;
    return { decl, reference: kind.reference?.text ?? null, instance: kind.name?.text ?? null, inCase };
  }
  return null;
}

/**
 * What is still missing in an instance (§279.1.3): a `bind` for each
 * binder, a value for each non-`cases` parameter exactly once; cases are
 * repeatable and always offered. Inside a case body — the unfilled fields
 * of its `cases` parameter.
 */
function unsetParameters(definition, instance, inCase = null) {
  const params = definition?.kind?.params ?? [];
  if (inCase) {
    const owner = params.find((p) => p.name?.text === inCase.param?.text);
    const set = new Set((inCase.arguments ?? []).map((a) => a.name?.text));
    return (owner?.ty?.fields ?? [])
      .filter((f) => !set.has(f.name?.text))
      .map((f) => ({ param: f, role: 'field', of: owner.name?.text ?? null }));
  }
  const kind = instance?.kind ?? {};
  const bound = new Set((kind.binds ?? []).map((b) => b.param?.text));
  const given = new Set((kind.arguments ?? []).map((a) => a.name?.text));
  const out = [];
  for (const param of params) {
    const ty = param.ty?.kind;
    const name = param.name?.text;
    if (ty === 'binder') { if (!bound.has(name)) out.push({ param, role: 'bind' }); }
    else if (ty === 'cases') out.push({ param, role: 'case' });
    else if (!given.has(name)) out.push({ param, role: 'argument' });
  }
  return out;
}

const LABEL_SNIPPET = 'label ru-KZ unofficial "${1}";';

/** Snippet forms §279.1.3 by parameter kind §279.1.2 — form, not semantics. */
function snippetsFor({ param, role }) {
  const name = param.name?.text ?? '?';
  const ty = param.ty ?? {};
  if (role === 'bind') return [{ label: `bind ${name}`, insert: `bind ${name} = \${1:x}: \${2:Type};`, param, role }];
  if (role === 'case') {
    const fields = (ty.fields ?? []).map((f, i) => `\t${f.name?.text ?? '?'} = \${${i + 3}};`).join('\n');
    return [{ label: `case ${name}`, insert: `case ${name} \${1:Name} {\n\t${LABEL_SNIPPET.replace('${1}', '${2}')}\n${fields}\n}`, param, role }];
  }
  switch (ty.kind) {
    case 'list': return [{ label: name, insert: `${name} = [\${1}];`, param, role }];
    case 'option': return [
      { label: name, insert: `${name} = some \${1:relation};`, param, role },
      { label: `${name} = none`, insert: `${name} = none;`, param, role },
    ];
    case 'integer': return [{ label: name, insert: `${name} = \${1:1};`, param, role }];
    // §279.2.2: a date term's duration is a calendar-unit quantity literal
    // or the name of a Quantity binder parameter.
    case 'quantity': return [
      { label: name, insert: `${name} = \${1:3} \${2|calendar_day,calendar_week,calendar_month,calendar_year|};`, param, role },
      { label: `${name} = <binder>`, insert: `${name} = \${1:span};`, param, role },
    ];
    case 'window': return [
      { label: name, insert: `${name} = between \${1:start} and \${2:end};`, param, role },
      { label: `${name} … from`, insert: `${name} = \${1:duration} from \${2:anchor};`, param, role },
    ];
    default: return [{ label: name, insert: `${name} = \${1:relation};`, param, role }];
  }
}

// -------------------------------------- definition -> instances (reverse)

/**
 * The parameter or name of the `expansion` definition at a document offset:
 * { definition, name, param } — `param` is null when the cursor is on the
 * definition's name. Fields of a `cases` parameter count as parameters
 * (`of` is the owner).
 */
function definitionParamAt(file, offset, index = (byte) => byte) {
  for (const decl of file?.decls ?? []) {
    const kind = decl.kind ?? {};
    if (kind.kind !== 'expansion' || !within(decl.span, offset, index)) continue;
    const name = kind.name?.text ?? null;
    if (within(kind.name?.span, offset, index)) return { definition: decl, name, param: null, of: null };
    for (const param of kind.params ?? []) {
      if (within(param.name?.span, offset, index)) return { definition: decl, name, param: param.name.text, of: null };
      for (const field of param.ty?.fields ?? []) {
        if (within(field.name?.span, offset, index)) return { definition: decl, name, param: field.name.text, of: param.name?.text ?? null };
      }
    }
    return null;
  }
  return null;
}

/**
 * Spans in the consumer file where `expand <alias>` instances set a
 * parameter: `bind`, argument, `case <param>`, a case field; without
 * `param` — the `expand <alias>` references themselves. Ordered by offset.
 */
function instanceReferences(file, alias, param = null, of = null) {
  const out = [];
  for (const decl of file?.decls ?? []) {
    const kind = decl.kind ?? {};
    if (kind.kind !== 'expand' || kind.reference?.text !== alias) continue;
    if (!param) { if (kind.reference?.span) out.push(kind.reference.span); continue; }
    if (!of) {
      for (const bind of kind.binds ?? []) if (bind.param?.text === param && bind.param.span) out.push(bind.param.span);
      for (const arg of kind.arguments ?? []) if (arg.name?.text === param && arg.name.span) out.push(arg.name.span);
      for (const c of kind.cases ?? []) if (c.param?.text === param && c.param.span) out.push(c.param.span);
    } else {
      for (const c of kind.cases ?? []) {
        if (c.param?.text !== of) continue;
        for (const arg of c.arguments ?? []) if (arg.name?.text === param && arg.name.span) out.push(arg.name.span);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * How many nodes an instance generates (§279.1.4): fixed `emit`s plus
 * `emit`s inside `for each c in <cases>` for each case of that parameter.
 * { rules, priorities, total }.
 */
function emitCount(definition, instance) {
  const cases = instance?.kind?.cases ?? [];
  const counts = { rules: 0, priorities: 0, templates: 0 };
  const walk = (items, factor) => {
    for (const item of items ?? []) {
      if (item.kind === 'each') {
        const source = item.source?.parts?.[0]?.text;
        walk(item.items, factor * cases.filter((c) => c.param?.text === source).length);
      } else if (item.kind === 'priority') counts.priorities += factor;
      else if (item.kind === 'rule') {
        counts.rules += factor;
        // §279.2.5: a deontic emit generates a second node — norm_template.
        if (item.deontic) counts.templates += factor;
      }
    }
  };
  walk(definition?.kind?.emits, 1);
  return { ...counts, total: counts.rules + counts.priorities + counts.templates };
}

/**
 * Inlays on an instance: after the reference — the definition's version per
 * the manifest (and its law.lock pin), after a list name — `min N` from the
 * definition. [{ span, text, tooltip }] in AST byte spans.
 */
function instanceInlays(file, definitionFor, specFor) {
  const out = [];
  for (const decl of file?.decls ?? []) {
    const kind = decl.kind ?? {};
    if (kind.kind !== 'expand') continue;
    const alias = kind.reference?.text;
    const definition = definitionFor(alias);
    const spec = specFor(alias);
    if (kind.reference?.span && spec?.version) {
      out.push({
        span: kind.reference.span,
        text: `v${spec.version}${spec.pinned === false ? ' · no pin' : ''}`,
        tooltip: `definition ${spec.name ?? alias} ${spec.version}${spec.pinned === false ? ' — no entry in law.lock (LDC-E1340)' : spec.pinned ? ' — pinned in law.lock' : ''}`,
      });
    }
    if (!definition) continue;
    for (const arg of kind.arguments ?? []) {
      const param = parameterNamed(definition, arg.name?.text);
      if (param?.ty?.kind === 'list' && Number.isInteger(param.ty.min) && arg.name?.span) {
        out.push({ span: arg.name.span, text: `min ${param.ty.min}`, tooltip: `list no shorter than ${param.ty.min} (§279.1.2, LDC-E1337 on violation)` });
      }
    }
  }
  return out;
}

/** Snippet -> plain text: `${1:x}` -> `x`, `${2}` -> empty. */
const plainText = (snippet) => String(snippet).replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '');

const MISSING_ARG_RE = /нет аргумента "([A-Za-z_][A-Za-z0-9_]*)"/;
const MISSING_BIND_RE = /нет `bind ([A-Za-z_][A-Za-z0-9_]*)`/;

/**
 * Instance fixes for a §279.1.3 contract diagnostic (LDC-E1337 "no
 * argument" / "no bind", LDC-E1339 "no label"): a line is inserted into the
 * instance body using the parameter's shape from the definition; without a
 * definition — only the label. `text` is the document text, `index` maps a
 * byte span to an offset. Returns [{ title, edits: [{ start, end, newText }] }]
 * in document offsets.
 */
function instanceFixes(ast, text, index, diag, definition = null) {
  const instance = (ast?.decls ?? []).find((d) => d.kind?.kind === 'expand'
    && d.kind.name?.span && index(d.kind.name.span.start) === diag.startOffset);
  if (!instance) return [];
  const open = text.indexOf('{', diag.endOffset);
  const close = text.lastIndexOf('}', index(instance.span.end));
  if (open === -1 || close === -1 || close <= open) return [];
  const bodyLine = /\n([ \t]+)\S/.exec(text.slice(open, close));
  const indent = bodyLine ? bodyLine[1] : '    ';
  const lineEnd = text.lastIndexOf('\n', close);
  const before = text.slice(lineEnd + 1, close);
  const insertAt = /^\s*$/.test(before) ? lineEnd + 1 : close;
  const fixes = [];
  if (diag.code === 'LDC-E1339') {
    fixes.push({
      title: '§279.1.4: add instance label',
      edits: [{ start: open + 1, end: open + 1, newText: `\n${indent}label ru-KZ unofficial "";` }],
    });
  }
  if (diag.code === 'LDC-E1337' && definition) {
    const bind = MISSING_BIND_RE.exec(diag.message);
    const arg = MISSING_ARG_RE.exec(diag.message);
    const name = bind ? bind[1] : arg ? arg[1] : null;
    const param = name ? parameterNamed(definition, name) : null;
    if (param) {
      const role = bind ? 'bind' : param.ty?.kind === 'cases' ? 'case' : 'argument';
      const [first] = snippetsFor({ param, role });
      const line = plainText(first.insert);
      fixes.push({
        title: `§279.1.3: add \`${line.split('\n')[0]}\``,
        edits: [{ start: insertAt, end: insertAt, newText: `${indent}${line.replace(/\n/g, `\n${indent}`)}\n` }],
      });
    }
  }
  return fixes;
}

/** All completions inside an instance or case: what's unset per the definition, plus a §279.1.4 label if missing. */
function expansionCompletions(definition, instance, inCase = null) {
  const out = unsetParameters(definition, instance, inCase).flatMap(snippetsFor);
  const labels = inCase ? (inCase.labels ?? []) : (instance?.labels ?? []);
  if (!labels.length) out.unshift({ label: 'label', insert: LABEL_SNIPPET, param: null, role: 'label' });
  return out;
}

/** Parameter type kind §279.1.2 from the AST: binder · relation · list … */
function kindOf(node) {
  const ty = node?.ty ?? null;
  if (!ty) return null;
  if (ty.kind === 'list' && Number.isInteger(ty.min)) return `list · min ${ty.min}`;
  return ty.kind ?? null;
}

/**
 * Markdown for a parameter card. Same order as the declaration card:
 * what the name is -> author's rationale -> source -> where declared -> §.
 */
function parameterCard({
  param, reference, instance = null, role = 'argument', of = null,
  node = null, comment = null, slice = null, origin = null, entry = null, missing = false,
} = {}) {
  const parts = [];
  if (role === 'reference') {
    // A reference to a definition: the `expansion` card itself is built by
    // the ordinary declaration card (hovercard.js); here — only the "not
    // found" case.
    parts.push(`**expansion** \`${reference}\``);
    if (instance) parts.push(`*instance \`${instance}\`*`);
    if (missing) parts.push(`*definition \`${reference}\` not found: neither in the package's files nor via the \`[expansions]\` law.toml alias (§279.1.3)*`);
    if (entry) parts.push('---', `**SPEC §${entry.sec}. ${entry.title}**`, entry.doc);
    return parts.join('\n\n');
  }
  const head = [`**parameter** \`${param}\``, `expansion \`${reference}\``];
  const kind = kindOf(node);
  if (kind) head.push(kind);
  if (role === 'bind') head.push('bind');
  if (role === 'field' && of) head.push(`field \`${of}\``);
  parts.push(head.join(' · '));
  if (instance) parts.push(`*instance \`${instance}\`*`);
  if (comment) parts.push(comment.split('\n').map((l) => `> ${l}`).join('\n'));
  if (slice) parts.push(`\`\`\`law\n${slice}\n\`\`\``);
  if (origin) parts.push(`*declared in \`${origin}\`*`);
  if (missing) {
    // Definition not found is a diagnosis, not silence: without it, a hint
    // by parameter name would be indistinguishable from "unknown word".
    parts.push(`*definition \`${reference}\` not found: neither in the package's files nor via the \`[expansions]\` law.toml alias (§279.1.3)*`);
  } else if (node === null) {
    parts.push(`*definition \`${reference}\` has no parameter \`${param}\` (LDC-E1337)*`);
  }
  if (entry) {
    parts.push('---');
    parts.push(`**SPEC §${entry.sec}. ${entry.title}**`);
    parts.push(entry.doc);
  }
  return parts.join('\n\n');
}

module.exports = {
  expansionArgumentAt, expansionNamed, parameterNamed, parameterCard, targetSpan, kindOf,
  generatedRuleName, instanceNamed, caseNamed, emitFor,
  instanceAt, unsetParameters, snippetsFor, expansionCompletions, plainText, instanceFixes,
  definitionParamAt, instanceReferences, emitCount, instanceInlays,
};
