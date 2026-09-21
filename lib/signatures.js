'use strict';
// Inlays with parameter names: an argument of a relation call gets the
// parameter name from the declaration placed before it —
// `limiting_ratio(r, numerator: n0, denominator: d0)`,
// while the parameter's type goes into the inlay's tooltip. Signatures live
// with declarations (in the file and in package neighbors §22), calls live
// in rule expressions, heads, assertions and facts.
//
// Has no semantics of its own (invariant 5): the declaration's `params` is
// printed as-is, by argument position. The argument's type is not checked
// against the parameter's type — that is the compiler's job (§220), not the
// hints'; arity mismatch is also not diagnosed here: extra arguments simply
// get no inlay.

const { splitQualified, qualifiedKey } = require('./dependencies');

/**
 * Index "declaration name → parameters [{ name, type, origin }]" over the
 * package's files [{ ast, origin }]. The first declaration of a name wins:
 * names are unique within a package (§24), and file order is the compiler's
 * order. Declarations without parameters don't enter the index: there is
 * nothing for an inlay to show them. A dependency file carries `package`:
 * its declarations go under the `pkg::name` key, and only when `pub` (§24).
 */
/** Type written as in the source: `Name<A, B>` (grammar's type_ref); no arguments — just the name. */
function typeText(ty) {
  if (!ty || typeof ty.name !== 'string') return null;
  const args = (ty.args ?? []).map(typeText).filter(Boolean);
  return args.length ? `${ty.name}<${args.join(', ')}>` : ty.name;
}

function signatureIndex(files) {
  const index = new Map();
  for (const { ast, origin = null, package: pkg = null } of files) {
    for (const decl of ast?.decls ?? []) {
      const name = decl.kind?.name?.text;
      const params = decl.kind?.params ?? [];
      if (!name || !params.length) continue;
      if (pkg && !decl.public) continue;
      const key = pkg ? qualifiedKey(pkg, name) : name;
      if (index.has(key)) continue;
      index.set(key, {
        origin,
        kind: decl.kind?.kind ?? null,
        params: params.map((p) => ({ name: p.name?.text ?? null, type: typeText(p.ty) })),
      });
    }
  }
  return index;
}

/**
 * Arguments of relation calls in the file: for each `call` with a path
 * callee — the relation name, the argument's position, its span and text
 * (for a single-part path; expression arguments have no text). Qualified
 * `pkg::name` go under the `pkg::name` key — their signatures live with the
 * dependency (lib/dependencies.js). Order is by offset.
 */
function argumentSites(ast) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.kind === 'call' && node.callee?.kind === 'path' && node.callee.parts?.length) {
      const relation = splitQualified(node.callee)?.key ?? node.callee.parts.at(-1)?.text;
      (node.args ?? []).forEach((arg, position) => {
        const span = arg?.span;
        if (!relation || !span || !Number.isInteger(span.start)) return;
        const key = `${span.start}:${span.end}`;
        if (seen.has(key)) return;
        seen.add(key);
        const text = arg.kind === 'path' && arg.parts?.length === 1 ? arg.parts[0]?.text ?? null : null;
        out.push({ relation, position, span, text, argumentName: node.arg_names?.[position]?.text ?? null });
      });
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'span') walk(value);
  };
  walk(ast?.decls ?? []);
  return out.sort((a, b) => a.span.start - b.span.start);
}

/** Signature parameter for an argument: `{ name, type, position, count, relation, origin }` or null. */
function parameterOf(site, index) {
  const signature = index.get(site.relation);
  const position = site.argumentName == null ? site.position
    : signature?.params?.findIndex((p) => p.name === site.argumentName);
  const param = signature?.params?.[position];
  if (!param?.name) return null;
  return {
    name: param.name,
    type: param.type,
    position,
    count: signature.params.length,
    relation: site.relation,
    origin: signature.origin,
  };
}

/** One line about the parameter: `` `numerator: Integer` — parameter 2 of 3 in `limiting_ratio` · declared in `03-yield.law` ``. */
function describe(param) {
  const type = param.type ? `: ${param.type}` : '';
  const where = param.origin ? ` · declared in \`${param.origin}\`` : '';
  return `\`${param.name}${type}\` — parameter ${param.position + 1} of ${param.count} in \`${param.relation}\`${where}`;
}

/**
 * Argument inlays: `{ span, side, text, tooltip }` for each argument with a
 * known parameter; `side` is `before` (parameter name, `atoms: k`) or
 * `after` (type, `g: Galaxy`). Form `form`:
 *   name  — name before the argument;
 *   type  — type after the argument;
 *   both  — name before and type after (`atoms: k: Integer`);
 *   smart — type if the argument's name matches the parameter's name,
 *           otherwise name: each argument carries one new piece of
 *           information, the other one goes into the tooltip.
 * With `skipMatching`, an argument whose name matches the parameter
 * (`limiting_ratio(r, …)` with parameter `r`) gets no inlay at all.
 */
function parameterInlays(ast, index, { skipMatching = false, form = 'name' } = {}) {
  const out = [];
  for (const site of argumentSites(ast)) {
    const param = parameterOf(site, index);
    if (!param) continue;
    const matching = param.name === site.text;
    if (site.argumentName != null) {
      // The source already names this parameter. Only a requested type hint adds information.
      if (['type', 'both', 'smart'].includes(form) && param.type) {
        out.push({ span: site.span, side: 'after', text: `: ${param.type}`, tooltip: describe(param) });
      }
      continue;
    }
    if (skipMatching && matching) continue;
    const tooltip = describe(param);
    const before = () => out.push({ span: site.span, side: 'before', text: `${param.name}:`, tooltip });
    const after = () => { if (param.type) out.push({ span: site.span, side: 'after', text: `: ${param.type}`, tooltip }); };
    switch (form) {
      case 'type': after(); break;
      case 'both': before(); after(); break;
      case 'smart': if (matching && param.type) after(); else before(); break;
      default: before();
    }
  }
  return out;
}

/**
 * Argument under the cursor for a hover: the identifier argument `word`
 * whose span contains the position (the position check is done by
 * `contains(span)` — the caller converts the AST's byte spans to document
 * characters). Returns the parameter's description and, if present, the
 * declaration of the same variable by a quantifier or a parameter of the
 * enclosing declaration (`for z: Integer`) — as written, without checking
 * against the parameter's type (§220 is the compiler's job).
 */
function argumentHover(ast, index, word, contains) {
  const site = argumentSites(ast).find((s) => s.text === word && contains(s.span));
  if (!site) return null;
  const param = parameterOf(site, index);
  if (!param) return null;
  const decl = (ast?.decls ?? []).find((d) => d.span && d.span.start <= site.span.start && site.span.end <= d.span.end);
  const binder = [...(decl?.kind?.quantifiers ?? []), ...(decl?.kind?.params ?? [])].find((q) => q.name?.text === word);
  return {
    param,
    text: describe(param),
    binding: binder ? { name: word, type: typeText(binder.ty), owner: decl?.kind?.name?.text ?? null } : null,
  };
}

module.exports = { signatureIndex, argumentSites, parameterInlays, argumentHover, typeText };
