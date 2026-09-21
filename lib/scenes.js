'use strict';
// "Who checks this rule": a lens over a rule names the package's `.lawtest`
// scenes and the corpus scenarios (`corpus/kz/acts/*.py`) where the rule's
// heads occur. The link is by predicate name, not by execution: this is an
// index of mentions for navigation, not a coverage measure (that is counted
// by the corpus gates).
//
// Has no semantics (invariant 5): scene text is cut by `test "…" {` headers,
// names — by identifier tokens. A scene where the head is only mentioned in
// a comment also lands in the list — that is the price of not having a
// second .lawtest parser in the extension, and it is visible from the line
// the jump leads to.

const TEST_HEAD = /^\s*test\s+"((?:[^"\\]|\\.)*)"\s*\{/;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Scenes of a .lawtest file: { title, line (0-based), names: Set }. */
function scenesOf(text) {
  const scenes = [];
  let current = null;
  String(text ?? '').split('\n').forEach((line, i) => {
    const head = TEST_HEAD.exec(line);
    if (head) {
      current = { title: head[1], line: i, names: new Set() };
      scenes.push(current);
    }
    if (current) for (const word of line.match(IDENT) ?? []) current.names.add(word);
  });
  return scenes;
}

/** Index "name → scenes" over files [{ file, text }]; order is files, then lines. */
function sceneIndex(files) {
  const index = new Map();
  for (const { file, text } of files) {
    for (const scene of scenesOf(text)) {
      for (const name of scene.names) {
        if (!index.has(name)) index.set(name, []);
        index.get(name).push({ kind: 'scene', file, line: scene.line, title: scene.title });
      }
    }
  }
  return index;
}

/**
 * Index "name → scenarios" over corpus files [{ file, text }] where the
 * package's `namespace` is mentioned: one entry per name and file — the
 * first line of mention.
 */
function scenarioIndex(files, namespace) {
  const index = new Map();
  if (!namespace) return index;
  for (const { file, text } of files) {
    if (!String(text ?? '').includes(namespace)) continue;
    const seen = new Set();
    String(text).split('\n').forEach((line, i) => {
      for (const word of line.match(IDENT) ?? []) {
        if (seen.has(word)) continue;
        seen.add(word);
        if (!index.has(word)) index.set(word, []);
        index.get(word).push({ kind: 'scenario', file, line: i, title: null });
      }
    });
  }
  return index;
}

/** Names of calls and norms in a subtree: `callee.parts`, `relation.parts`, `norms[].name`. */
function namesIn(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((item) => namesIn(item, out)); return out; }
  if (Array.isArray(node.norms)) {
    // Deontic head: the norm's name is the head itself; relations inside its
    // goal and conditions are read, not derived — we don't recurse into them.
    for (const norm of node.norms) if (norm.name?.text) out.add(norm.name.text);
    return out;
  }
  if (node.kind === 'call' && node.callee?.parts?.length) out.add(node.callee.parts.at(-1).text);
  else if (node.relation?.parts?.length && !node.callee) out.add(node.relation.parts.at(-1).text);
  for (const [key, value] of Object.entries(node)) if (key !== 'span') namesIn(value, out);
  return out;
}

/** Parameters of an `expansion` definition that stand in the heads of its `emit` (`then R`, `then not R`, `defeat R`). */
function headParams(definition) {
  const out = new Set();
  const walk = (items) => {
    for (const item of items ?? []) {
      if (item.kind === 'each') walk(item.items);
      else if (item.head?.literal?.relation?.parts?.length) out.add(item.head.literal.relation.parts[0].text);
      else if (item.head?.relation?.parts?.length) out.add(item.head.relation.parts[0].text);
      // §279.2.3: for a deontic head, the "head" is the goal relation (achieve/maintain/action).
      else if (item.deontic?.goal?.relation?.parts?.length) out.add(item.deontic.goal.relation.parts[0].text);
    }
  };
  walk(definition?.kind?.emits);
  return out;
}

/**
 * What to look for in scenes for a declaration: for a rule and its kin —
 * names in the head (`then`, `defeat`, norms), or its own name if there are
 * none; for an `expand` instance — argument values whose parameters stand in
 * the definition's `emit` heads (without a definition — all reference
 * values), plus the instance's own name (id of the generated rules); for a
 * relation — its name.
 */
function headsOf(decl, definition = null) {
  const kind = decl?.kind ?? {};
  const own = kind.name?.text ? [kind.name.text] : [];
  if (kind.kind === 'expand') {
    const wanted = headParams(definition);
    const names = new Set(own);
    const args = [...(kind.arguments ?? []), ...(kind.cases ?? []).flatMap((c) => c.arguments ?? [])];
    for (const arg of args) {
      if (wanted.size && !wanted.has(arg.name?.text)) continue;
      const value = arg.value ?? {};
      if ((value.kind === 'reference' || value.kind === 'some') && value.text) names.add(value.text);
      if (value.kind === 'list') for (const item of value.items ?? []) if (item.text) names.add(item.text);
    }
    return [...names];
  }
  if (kind.kind === 'relation' || kind.kind === 'function') return own;
  const heads = new Set();
  for (const field of ['then', 'defeat', 'head']) namesIn(kind[field], heads);
  return heads.size ? [...heads] : own;
}

// ------------------------------------------------------ scene from a rule

const pathText = (arg) => (arg?.kind === 'path' && arg.parts?.length ? arg.parts.map((p) => p.text).join('.') : null);

/** Call conjuncts of the body: [{ name, args: [argument text | null] }]; non-calls are counted separately. */
function callsIn(node, out = { calls: [], other: 0 }) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((item) => callsIn(item, out)); return out; }
  if (node.kind === 'and') { callsIn(node.items, out); return out; }
  if (node.kind === 'call' && node.callee?.parts?.length) {
    out.calls.push({ name: node.callee.parts.at(-1).text, args: (node.args ?? []).map(pathText) });
    return out;
  }
  if (node.kind) out.other += 1;
  return out;
}

const entityRef = (name) => `entity_ref("urn:x:${name ?? 'arg'}")`;

/**
 * Scene skeleton §267 for a rule or an `expand` instance: each conjunct of
 * the body becomes a fact with entities named after the variables, the head
 * becomes a truth query. This is a draft for the author, not an inference:
 * values, dates and non-literal premises are marked with comments. For an
 * instance, the premises are parameter values outside the definition's
 * `emit` heads, the head is the parameter value from `then`.
 */
function sceneSkeleton(decl, { definition = null, date = '2026-01-01' } = {}) {
  const kind = decl?.kind ?? {};
  const name = kind.name?.text ?? 'Rule';
  const facts = [];
  const notes = [];
  let head = null;
  if (kind.kind === 'expand') {
    const heads = headParams(definition);
    const vars = (kind.binds ?? []).map((b) => b.var?.text ?? b.param?.text);
    const args = [...(kind.arguments ?? []), ...(kind.cases ?? []).flatMap((c) => c.arguments ?? [])];
    for (const arg of args) {
      const value = arg.value ?? {};
      const names = value.kind === 'list' ? (value.items ?? []).map((i) => i.text)
        : (value.kind === 'reference' || value.kind === 'some') && value.text ? [value.text] : [];
      for (const rel of names) {
        if (heads.has(arg.name?.text)) { head ??= { name: rel, args: vars }; continue; }
        facts.push({ name: rel, args: vars });
      }
    }
    if (!definition) notes.push('expansion definition not found: premises are listed without parsing the heads');
  } else {
    const vars = (kind.quantifiers ?? []).map((q) => q.name?.text);
    const body = callsIn(kind.when);
    for (const call of body.calls) facts.push({ name: call.name, args: call.args.map((a, i) => a ?? vars[i] ?? null) });
    if (body.other) notes.push(`premises outside call literals: ${body.other} — add the facts or conditions by hand`);
    const heads = callsIn(kind.then);
    if (heads.calls.length) head = heads.calls[0];
    else notes.push('head is not a literal (deontic norm or empty): replace the query with positions(...)');
  }
  const lit = (call) => `${call.name}(${call.args.map((a) => entityRef(a)).join(', ')})`;
  const lines = [`test "${name}: scene draft" {`, '    given {', '        context {',
    `            decision_time @${date}T12:00:00Z;`, `            knowledge_time @${date}T12:00:00Z;`,
    `            legal_time @${date};`, '            timezone "UTC";', '        }'];
  facts.forEach((fact, i) => lines.push(`        assert ${lit(fact)} { id "f${i + 1}"; origin case_input; }`));
  if (!facts.length) lines.push('        // no facts derived from the body');
  lines.push('    }', '');
  lines.push(head ? `    evaluate truth(${lit(head)});` : '    evaluate truth(/* head */);', '');
  lines.push('    expect result_kind == PROPOSITION;', '    expect truth_status == TRUE_ONLY;', '    expect evaluation_status == COMPUTED;', '}');
  for (const note of notes) lines.push(`// ${note}`);
  return `${lines.join('\n')}\n`;
}

const plural = (n, forms) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
};

/** Places by names: scenes and scenarios without repeats (file:line), scenes first. */
function placesFor(names, scenes, scenarios) {
  const out = [];
  const seen = new Set();
  for (const source of [scenes, scenarios]) {
    for (const name of names) {
      for (const place of source?.get(name) ?? []) {
        const key = `${place.file}:${place.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...place, name });
      }
    }
  }
  return out;
}

/** Lens title: "checked by: 3 scenes · corpus scenarios: 2 files" or "no scenes". */
function lensTitle(places) {
  const scenes = places.filter((p) => p.kind === 'scene').length;
  const files = new Set(places.filter((p) => p.kind === 'scenario').map((p) => p.file)).size;
  const parts = [];
  if (scenes) parts.push(`${scenes} ${plural(scenes, ['scene', 'scenes', 'scenes'])}`);
  if (files) parts.push(`corpus scenarios: ${files} ${plural(files, ['file', 'files', 'files'])}`);
  return parts.length ? `checked by: ${parts.join(' · ')}` : 'no scenes';
}

module.exports = { scenesOf, sceneIndex, scenarioIndex, headsOf, headParams, placesFor, lensTitle, plural, namesIn, sceneSkeleton, callsIn };
