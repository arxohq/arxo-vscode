'use strict';
// A package's dependencies for hovers, inlays, and go-to-definition: what
// stands behind `pkg::name` (§23–§25). Two tiers, in this order:
//
//   1. Dependency SOURCES — if its directory (a law.toml with the same
//      `name`) is found in the workspace: the same `lawc parse --ast` as
//      for a package's siblings, so §218 labels, parameters, a declaration
//      slice, and go-to-span are all available.
//   2. Dependency CLIR from `corpus/clir` — if there is no source: the
//      "package name -> file" index comes from `lawc imports-context --index`
//      (DECISION-0128 §7), and `symbol_decl`/`type_decl`/… nodes carry
//      labels, parameters, and visibility. CLIR has no spans, so the card
//      and inlays exist but go-to-definition does not.
//
// Carries no semantics of its own (invariant 5): only name decomposition
// here (`parts` of a qualified path -> package and name) and rewriting
// CLIR nodes into the AST declaration shape already read by labels.js,
// signatures.js, and hovercard.js. §24 visibility is not computed, it is
// read: `public` on a source declaration, `visibility`/`public` on a CLIR node.

const { manifestField, manifestDependencies } = require('./workspace');

/** Index-key separator for a foreign declaration: `openstax.relativity::speed_of_light`. */
const qualifiedKey = (pkg, name) => `${pkg}::${name}`;

/**
 * A qualified AST path -> { package, name, key, span, nameSpan }; for an
 * unqualified one — null. `qualified_at` is the index of the name part,
 * everything before it is the package name joined by dots (parser's
 * shape, see workspace.qualifiedRefs).
 */
function splitQualified(node) {
  if (!node || node.kind !== 'path' || node.qualified !== true) return null;
  const parts = node.parts ?? [];
  const at = Number.isInteger(node.qualified_at) ? node.qualified_at : parts.length - 1;
  const pkg = parts.slice(0, at).map((p) => p.text).join('.');
  const last = parts[at];
  if (!pkg || !last?.text) return null;
  return { package: pkg, name: last.text, key: qualifiedKey(pkg, last.text), span: node.span ?? last.span, nameSpan: last.span };
}

/**
 * A qualified reference whose name part contains the cursor: position is
 * given by `contains(span)` — the caller translates AST byte spans into
 * document positions (for literate mode this accounts for the §217 build).
 */
function qualifiedAt(ast, contains) {
  let found = null;
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const q = splitQualified(node);
    if (q?.nameSpan && contains(q.nameSpan)) { found = q; return; }
    for (const [key, value] of Object.entries(node)) if (key !== 'span') walk(value);
  };
  walk(ast?.decls ?? []);
  return found;
}

/** Names of packages the file references qualified, without duplicates. */
// §259.0 standard call-alias namespaces (E-0178): `math::sqrt`,
// `bounds::round` are shorthand for canonical terms, not a package
// reference. Same rule as the compiler (law-hir/src/std_source_aliases.rs):
// a two-part path whose first part is not declared as a package or import
// by the file resolves against the STD_SOURCE_ALIASES table; a declared
// package of the same name wins. The set of namespaces follows that table.
const STD_ALIAS_NAMESPACES = new Set(['math', 'bounds']);

function joinedName(name) {
  return (name?.parts ?? []).map((p) => p.text).join('.');
}

/** Packages declared by the file itself: `package` and `import`s. */
function declaredPackages(ast) {
  const out = new Set();
  const own = joinedName(ast?.package?.name);
  if (own) out.add(own);
  for (const imp of ast?.imports ?? []) {
    const name = joinedName(imp?.package ?? imp?.name ?? imp);
    if (name) out.add(name);
  }
  return out;
}

function isStdAlias(node, declared) {
  return node.qualified_at === 1 && (node.parts ?? []).length === 2
    && STD_ALIAS_NAMESPACES.has(node.parts[0].text) && !declared.has(node.parts[0].text);
}

function referencedPackages(ast) {
  const out = new Set();
  const declared = declaredPackages(ast);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const q = splitQualified(node);
    if (q && !isStdAlias(node, declared)) out.add(q.package);
    for (const [key, value] of Object.entries(node)) if (key !== 'span') walk(value);
  };
  walk(ast?.decls ?? []);
  return [...out];
}

/**
 * Packages worth resolving for the document: the package manifest's
 * `[dependencies]` plus everything the file names qualified (a file
 * without a manifest — §279.1 vectors — would otherwise be left with no
 * dependencies at all). Order: manifest first, then references; no duplicates.
 */
function dependencyNames(ast, manifestText) {
  const out = [];
  const seen = new Set();
  for (const name of [...manifestDependencies(manifestText), ...referencedPackages(ast)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * A "package name -> directory" index built from workspace manifests: the
 * [package] section's `name = "…"`. The first directory for a name wins;
 * `readText(path)` reads the manifest (caching is the caller's concern).
 */
function packageDirIndex(manifestDirs, readText, joinPath) {
  const index = new Map();
  for (const dir of manifestDirs) {
    const name = manifestField(readText(joinPath(dir, 'law.toml')) ?? '', 'name');
    if (name && !index.has(name)) index.set(name, dir);
  }
  return index;
}

// ------------------------------------------------------------ CLIR nodes

/** Local name of a StableId/type: `urn:law:std#Quantity` -> `Quantity`; otherwise as is. */
function localName(id) {
  const text = String(id ?? '');
  const hash = text.indexOf('#');
  return hash >= 0 ? text.slice(hash + 1) : text;
}

/** AST declaration kind for a CLIR node: `symbol_decl`+`relation` -> `relation`, etc. */
function declKindOf(node) {
  switch (node.kind) {
    case 'symbol_decl': return node.symbolKind ?? 'relation';
    case 'type_decl': return node.typeKind ?? 'type';
    case 'function_decl': return 'function';
    case 'rule': return 'rule';
    case 'fragment': return 'fragment';
    case 'interpretation': return 'interpretation';
    case 'unit_decl': return 'unit';
    default: return null;
  }
}

/** A CLIR node's visibility: `visibility: "public"` on declarations, `public: true` on units. */
const isPublic = (node) => node.visibility === 'public' || node.public === true;

/**
 * CLIR document -> pseudo-AST `{ decls }` in the parser's declaration
 * shape: labels in `labels`, name in `kind.name.text`, parameters in
 * `kind.params[{ name, ty }]`, `public` from visibility. Spans are zero:
 * CLIR has no source, and the declaration is tagged `clir: { id, file }`
 * so the card does not look for a slice.
 * Only named nodes are taken; private nodes are not dropped — the card
 * should say "without pub", not stay silent.
 */
function clirDecls(document, file) {
  const zero = { start: 0, end: 0 };
  const decls = [];
  for (const node of document?.nodes ?? []) {
    const kind = declKindOf(node);
    if (!kind) continue;
    const name = node.name ?? node.unitName ?? (node.kind === 'rule' || node.kind === 'fragment' ? localName(node.id) : null);
    if (!name) continue;
    const params = (node.parameters ?? []).map((p) => ({ name: { text: p.name, span: zero }, ty: { name: localName(p.type?.name), args: [], span: zero } }));
    decls.push({
      public: isPublic(node),
      labels: node.labels ?? [],
      annotations: [],
      span: zero,
      clir: { id: node.id, file },
      kind: {
        kind,
        name: { text: name, span: zero },
        params,
        relation_kind: node.relationKind ? { text: node.relationKind } : null,
        strength: node.strength ? { text: node.strength } : null,
      },
    });
  }
  return { decls, package: document?.package ?? null };
}

/**
 * Parsing a large CLIR file without the full rule tree: the document is
 * parsed whole (JSON.parse), but only declarations are returned. A parse
 * error yields null.
 */
function parseClir(text, file) {
  try { return clirDecls(JSON.parse(text), file); } catch { return null; }
}

/** `imports-context --index` -> Map "package name -> CLIR path"; a non-object yields an empty map. */
function parseClirIndex(text) {
  try {
    const value = JSON.parse(text);
    return new Map(Object.entries(value && typeof value === 'object' ? value : {}));
  } catch { return new Map(); }
}

module.exports = {
  qualifiedKey, splitQualified, qualifiedAt, referencedPackages, dependencyNames,
  packageDirIndex, localName, clirDecls, parseClir, parseClirIndex, declKindOf,
};
