'use strict';
// The workspace folder as a whole: a declaration index for symbol search
// (Cmd+T), StableId ↔ declaration, package dependencies and `pub` debt.
//
// The symbol index is textual, over declaration lines, not the AST: the
// corpus holds hundreds of files, and parsing each one for a name search
// would be a second compiler on every keystroke. Precision here is grep
// precision: a line starting with a declaration kind and a name. Jumping to
// a found symbol lands on the line, and from there the open file's AST takes over.
//
// Has no semantics (invariant 5): StableId resolution is string
// decomposition of `<namespace>#<name>[/tail]`, `pub` debt is matching names
// from neighbors' qualified references against declarations' `public` flag.

const { DECL_KINDS } = require('./ast');

//: Declaration kinds in descending order of length: `deadline policy` before `deadline`.
const KINDS = Object.keys(DECL_KINDS).sort((a, b) => b.length - a.length);
const DECL_LINE = new RegExp(
  `^\\s*(?:pub\\s+)?(${KINDS.map((k) => k.replace(' ', '\\s+')).join('|')})\\s+(?:([A-Za-z0-9_.-]+)\\s+)?\`?([A-Za-z_][A-Za-z0-9_]*)\`?`,
);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * File declarations by line: { name, kind, line, public, file }. For
 * `expand` the second word is a reference to the definition, the name is
 * the third; other kinds have no second word, and its capture is empty.
 */
function declarationLines(file, text) {
  const out = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    const m = DECL_LINE.exec(line);
    if (!m) return;
    const [, kindRaw, second, third] = m;
    const kind = kindRaw.replace(/\s+/g, ' ');
    const name = kind === 'expand' ? third : (second && !third ? second : (second ? second : third));
    // A kind with a single-word name: `rule Name` → second='Name'? No: the
    // regex is greedy for the second word only when a third one is present;
    // without a third, the name is in second.
    const resolved = kind === 'expand' ? third : (second ?? third);
    if (!resolved || !IDENT.test(resolved)) return;
    out.push({ name: resolved, kind, line: i, public: /^\s*pub\s/.test(line), file });
  });
  return out;
}

/**
 * Index search: exact name → prefix → substring → subsequence (case
 * insensitive), in this order; an empty query is empty.
 */
function searchSymbols(entries, query, limit = 200) {
  const q = String(query ?? '').toLowerCase();
  if (!q) return [];
  const rank = (name) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    let i = 0;
    for (const ch of n) if (ch === q[i]) i += 1;
    return i === q.length ? 3 : null;
  };
  const scored = [];
  for (const entry of entries) {
    const r = rank(entry.name);
    if (r !== null) scored.push([r, entry]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name) || a[1].file.localeCompare(b[1].file));
  return scored.slice(0, limit).map(([, entry]) => entry);
}

// ------------------------------------------------------------- StableId

/** `urn:ns#Name`, `urn:ns#X/elements` → { namespace, name, tail }; otherwise null. */
function parseStableId(text) {
  const m = /^(urn:[^#\s"]+)#([A-Za-z_][A-Za-z0-9_]*)((?:\/[A-Za-z0-9_-]+)*)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { namespace: m[1], name: m[2], tail: m[3] ? m[3].slice(1).split('/') : [] };
}

/** StableId at a text-line offset (a JSON node): the longest urn:…#… string around it. */
function stableIdAt(text, offset) {
  const re = /urn:[^"\s]+#[A-Za-z_][A-Za-z0-9_/-]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (offset >= m.index && offset <= m.index + m[0].length) return { id: m[0], start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** `namespace "…"` and `name = "…"` of the manifest: law.toml string fields by key name. */
function manifestField(tomlText, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(String(tomlText ?? ''));
  return m ? m[1] : null;
}

/** Manifest dependencies: keys of the [dependencies] section (quoted or not). */
function manifestDependencies(tomlText) {
  const out = [];
  let inside = false;
  for (const raw of String(tomlText ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (/^\[/.test(line)) { inside = line === '[dependencies]'; continue; }
    if (!inside || !line) continue;
    const m = /^"?([A-Za-z0-9_.-]+)"?\s*=/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// ------------------------------------------------------------- package and pub

const packageNameOf = (ast) => (ast?.package?.name?.parts ?? []).map((p) => p.text).join('.') || null;
const importsOf = (ast) => (ast?.imports ?? []).map((i) => ({
  name: (i.package?.parts ?? []).map((p) => p.text).join('.'),
  version: i.version ?? null,
  span: i.span ?? null,
}));

/** File's qualified references: { package, name, span }. */
function qualifiedRefs(ast) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.kind === 'path' && node.qualified === true && Array.isArray(node.parts) && Number.isInteger(node.qualified_at)) {
      const pkg = node.parts.slice(0, node.qualified_at).map((p) => p.text).join('.');
      const name = node.parts[node.qualified_at]?.text;
      if (pkg && name) out.push({ package: pkg, name, span: node.span ?? node.parts[node.qualified_at].span });
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'span') walk(value);
  };
  walk(ast?.decls);
  return out;
}

/**
 * What neighbors read from package `ownName`: for each name — is it
 * declared, does it have `pub`, where it is read. Debt is what's read
 * without `pub` (LDC-E1105 §24 for a strict consumer) and what's read but
 * doesn't exist at all.
 * @param ownDecls [{ name, public }] over all files of the package
 * @param readers [{ file, ast }] consumer files
 */
function pubDebt(ownName, ownDecls, readers) {
  const declared = new Map(ownDecls.map((d) => [d.name, Boolean(d.public)]));
  const uses = new Map();
  for (const { file, ast } of readers) {
    for (const ref of qualifiedRefs(ast)) {
      if (ref.package !== ownName) continue;
      if (!uses.has(ref.name)) uses.set(ref.name, []);
      uses.get(ref.name).push({ file, span: ref.span });
    }
  }
  return [...uses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, places]) => ({
    name,
    declared: declared.has(name),
    public: declared.get(name) === true,
    places,
  }));
}

module.exports = {
  declarationLines, searchSymbols, parseStableId, stableIdAt, manifestField, manifestDependencies,
  packageNameOf, importsOf, qualifiedRefs, pubDebt, DECL_LINE,
};
