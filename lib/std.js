'use strict';
// Classification for styling, without evaluating terms (§257–§266).
// The list is a projection of the same catalogue the compiler reads; status
// constructs arrive as separate AST nodes, there is no list of their names here.
const catalogue = require('../data/std.json');
const types = new Set(catalogue.types);
const functions = new Set(catalogue.functions);

const library = ['defaultLibrary'];

function exported(pkg, name) {
  const names = Object.hasOwn(catalogue.exports, pkg) ? catalogue.exports[pkg] : null;
  return names && Object.hasOwn(names, name) ? names[name] : null;
}

function callToken(path, localTypes, packages) {
  if (path?.kind !== 'path') return null;
  const parts = path.parts ?? [];
  // Lazily: dependencies → workspace → ast; ast uses this module.
  const ref = require('./dependencies').splitQualified(path);
  if (ref) {
    // Don't color the member chain after a standard-library name.
    if (parts.length !== (path.qualified_at ?? parts.length - 1) + 1) return null;
    if (!packages.has(ref.package) && Object.hasOwn(catalogue.sourceAliases, `${ref.package}::${ref.name}`)) {
      return { span: ref.nameSpan, type: 'function' };
    }
    const kind = exported(ref.package, ref.name);
    return kind ? { span: ref.nameSpan, type: kind === 'type' ? 'type' : 'function' } : null;
  }
  if (path.qualified || parts.length !== 1) return null;
  const name = parts[0].text;
  if (functions.has(name)) return { span: parts[0].span, type: 'function' };
  if (types.has(name) && !localTypes.has(name)) return { span: parts[0].span, type: 'type' };
  return null;
}

// TypeRef.span includes generic arguments. We extract only the name,
// otherwise the token List<UserType> would color the argument and angle
// brackets with its own color.
// `slice` returns the source by the AST's byte span, including literate §217.
function typeNameParts(node, slice) {
  const source = slice ? slice(node.span) : node.name;
  const lexeme = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|\s+|[A-Za-z_][A-Za-z0-9_]*|::|\./gy;
  const parts = [];
  let normalized = '';
  let match;
  while ((match = lexeme.exec(source))) {
    const word = match[0];
    if (/^\s|^\//.test(word)) continue;
    normalized += word;
    if (/^[A-Za-z_]/.test(word)) {
      const start = node.span.start + Buffer.byteLength(source.slice(0, match.index));
      parts.push({ text: word, span: { start, end: start + word.length } });
    }
    if (normalized === node.name) return parts;
  }
  return [];
}

function typeTokens(node, push, { slice, localTypes = new Set() } = {}) {
  const parts = typeNameParts(node, slice);
  const name = parts.at(-1);
  if (!name) return;
  const split = node.name.indexOf('::');
  const standard = split >= 0
    ? exported(node.name.slice(0, split), node.name.slice(split + 2)) === 'type'
    : types.has(node.name) && (node.args.length > 0 || !localTypes.has(node.name));
  for (const part of parts.slice(0, -1)) push(part.span, 'namespace');
  push(name.span, 'type', standard ? library : []);
}

function expressionTokens(node, push, { localTypes = new Set(), packages = new Set() } = {}) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item) => expressionTokens(item, push, { localTypes, packages })); return; }
  if (node.kind === 'status' && typeof node.status === 'string' && node.span) {
    push({ start: node.span.start, end: node.span.start + Buffer.byteLength(node.status) }, 'lawStatus', library);
  }
  if (node.kind === 'call' || node.kind === 'record') {
    const token = callToken(node.callee ?? node.ty, localTypes, packages);
    if (token) push(token.span, token.type, library);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'span') expressionTokens(value, push, { localTypes, packages });
  }
}

function aliasAt(file, offset, index = (value) => value) {
  const packages = new Set((file.imports ?? []).map((i) => i.package.parts.map((p) => p.text).join('.')));
  if (file.package) packages.add(file.package.name.parts.map((p) => p.text).join('.'));
  let found = null;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const path = node.kind === 'call' ? node.callee : null;
    if (path?.kind === 'path' && path.qualified && path.qualified_at === 1 && path.parts.length === 2) {
      const [prefix, name] = path.parts;
      const alias = `${prefix.text}::${name.text}`;
      if (!packages.has(prefix.text) && Object.hasOwn(catalogue.sourceAliases, alias)
          && offset >= index(name.span.start) && offset < index(name.span.end)) {
        const canonical = catalogue.sourceAliases[alias];
        found = { alias, canonical, result: canonical === 'round_bounds' ? 'Integer | Decimal' : 'Bounds' };
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(file.decls);
  return found;
}

module.exports = { typeTokens, expressionTokens, aliasAt };
