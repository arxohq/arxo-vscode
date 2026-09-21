'use strict';
// Hover card for a declaration: what the compiler already puts in the AST
// but the hover used to discard — §218 labels, §45 relation kind, key, §15
// annotations, §35 entity fields, §28 fragment official text, and the
// declaration's own source slice.
//
// Carries no semantics of its own (invariant 5): it prints either an AST
// field as is, or a slice of the author's text. Expressions (`when`,
// `then`, `require`) are NOT reassembled into text: they are printed by
// `lawc fmt`, and a parallel expression renderer in the extension would be
// a second, diverging printer. That is why a rule's body is shown as a
// source slice, not by walking nodes.

const MAX_LABELS = 4;
const MAX_TEXT = 700;
const MAX_COMMENT_LINES = 8;
const MAX_FIELDS = 8;
const MAX_LITERAL = 28;

const textOf = (n) => (n && typeof n.text === 'string' ? n.text : null);
const typeOf = (n) => (n && typeof n.name === 'string' ? n.name : null);
const nameOf = (n) => textOf(n) ?? typeOf(n);

const trim = (s, max) => (s.length <= max ? s : `${s.slice(0, max)} …`);

// A §35/§28 field literal as written: path, string, number, temporal.
function literal(value) {
  if (!value || typeof value !== 'object') return null;
  switch (value.kind) {
    case 'path': return (value.parts ?? []).map((p) => p.text).join('.');
    // Long literals in the card are usually a `content_hash` §194: it must
    // be visible (without it, the pin cannot be checked), but must not take
    // up the whole line.
    case 'str': return JSON.stringify(trim(value.value ?? '', MAX_LITERAL));
    case 'int': case 'dec': case 'temporal': case 'duration': return value.text ?? null;
    case 'bool': return String(value.value);
    case 'infinity': return '∞';
    case 'interval': {
      const bound = (b) => (b?.kind === 'infinity' ? '∞' : (literal(b) ?? '…'));
      return `${value.start_inclusive ? '[' : '('}${bound(value.start)}, ${bound(value.end)}${value.end_inclusive ? ']' : ')'}`;
    }
    default: return null;
  }
}

/** §218 labels: "text" — language · status. Official labels come before translations. */
function labelsOf(node) {
  const labels = node?.labels ?? [];
  const rank = (l) => (l.status === 'official' ? 0 : l.status === 'unofficial' ? 1 : 2);
  return [...labels]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_LABELS)
    .map((l) => `«${l.text}» — \`${l.language}\` · ${l.status}`);
}

/** §15 annotations as a line: `@source(X)` · `@id("urn:…")`. */
function annotationsOf(node) {
  const items = (node?.annotations ?? [])
    .map((a) => {
      const name = textOf(a.name);
      if (!name) return null;
      const args = (a.args ?? []).join(', ');
      return `\`@${name}${args ? `(${args})` : ''}\``;
    })
    .filter(Boolean);
  return items.length ? items.join(' · ') : null;
}

/** Modifiers in the header: visibility, relation kind, rule strength, purity. */
function modifiersOf(node) {
  const kind = node?.kind ?? {};
  const out = [];
  if (node?.public) out.push('pub');
  const relationKind = textOf(kind.relation_kind);
  if (relationKind) out.push(relationKind);
  const strength = textOf(kind.strength);
  if (strength) out.push(strength);
  if (kind.pure === true) out.push('pure');
  if (kind.judgment) out.push('judgment');
  if (kind.external_opaque || kind.external_snapshot) out.push('external');
  const mode = textOf(kind.mode);
  if (mode) out.push(mode);
  return out;
}

// Key lines that stay visible even when the source slice is cut off by
// length. Order goes from recognizing the construct to its specifics.
function factsOf(node) {
  const kind = node?.kind ?? {};
  const out = [];

  if (kind.parent && kind.parent.text) out.push(`extends \`${kind.parent.text}\``);

  const keys = (kind.keys ?? []).map((key) => (key ?? []).map((p) => p.text).join(', '));
  for (const key of keys) if (key) out.push(`\`key(${key})\` — §51`);

  if (kind.judgment) {
    const authority = nameOf(kind.judgment.authority) ?? textOf(kind.judgment) ?? '';
    out.push(`decided by a court §47.3${authority ? `: \`${authority}\`` : ''}`);
  }

  const ret = typeOf(kind.return_type);
  if (ret) out.push(`returns \`${ret}\``);

  if (Array.isArray(kind.variants) && kind.variants.length) {
    out.push(`variants: ${kind.variants.map((v) => `\`${v.text}\``).join(' | ')}`);
  }

  const fields = (kind.fields ?? []).map((f) => {
    const name = textOf(f.name);
    if (!name) return null;
    const ty = typeOf(f.ty);
    const value = literal(f.value);
    if (ty) return `\`${name}: ${ty}\`${f.constraint ? ' *(constraint)*' : ''}`;
    return value ? `\`${name}\` = ${value}` : `\`${name}\``;
  }).filter(Boolean);
  if (fields.length) {
    out.push(fields.slice(0, MAX_FIELDS).join(' · ') + (fields.length > MAX_FIELDS ? ' …' : ''));
  }

  const edition = textOf(kind.in_edition) ?? textOf(kind.of_source) ?? textOf(kind.of_edition);
  if (edition) out.push(`in \`${edition}\``);

  const effective = literal(kind.effective);
  if (effective) out.push(`\`effective ${effective}\` — §31`);
  for (const g of kind.governs ?? []) {
    const axis = textOf(g.axis);
    const interval = literal(g.interval);
    if (axis && interval) out.push(`\`governs ${axis} ${interval}\``);
  }

  const severity = textOf(kind.severity);
  if (severity) out.push(`severity \`${severity}\``);

  if (Array.isArray(kind.exceptions) && kind.exceptions.length) {
    const words = kind.exceptions.map((e) => textOf(e.keyword) ?? 'unless');
    out.push(`exceptions: ${[...new Set(words)].map((w) => `\`${w}\``).join(', ')} × ${kind.exceptions.length}`);
  }
  if (kind.defeat) out.push('carries `defeat` — §107');

  if (Array.isArray(kind.states) && kind.states.length) {
    const initial = kind.states.find((s) => s.initial);
    const terminal = kind.states.filter((s) => s.terminal).length;
    out.push(`states ${kind.states.length}${initial ? ` (from \`${initial.name.text}\`)` : ''}`
      + `, transitions ${(kind.transitions ?? []).length}, terminal ${terminal}`);
  }

  const authority = nameOf(kind.authority);
  if (authority) out.push(`authority \`${authority}\``);
  const status = textOf(kind.status);
  if (status) out.push(`status \`${status}\``);

  if (typeof kind.message === 'string' && kind.message) out.push(`message: «${trim(kind.message, 200)}»`);

  return out;
}

/** §28 fragment official texts — as a quote, exactly as in the source. */
function textsOf(node) {
  return (node?.kind?.texts ?? [])
    .filter((t) => typeof t.raw === 'string' && t.raw)
    .map((t) => ({
      head: `\`${t.language}\` · ${t.officiality ?? ''}`.trim(),
      body: trim(t.raw, MAX_TEXT),
    }));
}

// The comment above a declaration: in the corpus this is exactly where a
// norm's rationale lives, and this language has no `///` — we take
// ordinary consecutive `//` lines. Annotations (`@source(…)`) between the
// comment and the declaration are skipped.
function leadingComment(text, startIndex, maxLines = MAX_COMMENT_LINES) {
  if (typeof text !== 'string' || !Number.isInteger(startIndex)) return null;
  const head = text.slice(0, startIndex);
  const lines = head.split('\n');
  lines.pop(); // the declaration's own line — up to its start
  const picked = [];
  let gap = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) {
      if (picked.length) break; // the comment ended — above is someone else's text
      // One blank line between the comment and the declaration is normal in
      // the corpus: an annotation block sits between them. Two is already a
      // break: the comment is about a file section, not this declaration.
      if (++gap > 1) return null;
      continue;
    }
    if (line.startsWith('@')) { if (picked.length) break; else continue; }
    if (!line.startsWith('//')) break;
    const body = line.replace(/^\/{2,3}\s?/, '');
    // A section frame ("--- Жарғы 7 … ------") titles a chunk of the file,
    // not the declaration below it: the declaration's comment ends there.
    if (/^-{3,}|-{3,}$/.test(body.trim())) break;
    picked.push(body);
    if (picked.length >= maxLines + 1) break;
  }
  picked.reverse();
  while (picked.length && /^[-=\s]*$/.test(picked[0])) picked.shift();
  if (!picked.length) return null;
  const cut = picked.length > maxLines;
  return (cut ? picked.slice(0, maxLines) : picked).join('\n') + (cut ? '\n…' : '');
}

/** A declaration's source slice, truncated by number of lines. */
function sourceSlice(text, maxLines) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.replace(/\s+$/, '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more lines.`;
}

const quote = (t) => `> ${t.head}\n>\n> ${t.body.split('\n').join('\n> ')}`;

/**
 * A verbalization block's body without boilerplate lines: the `###`
 * heading, the line with the node id and anchors (italic) — the card
 * already has those as its own fields.
 */
function spokenBody(blockText) {
  if (typeof blockText !== 'string') return null;
  const lines = blockText.replace(/\s+$/, '').split('\n')
    .filter((line) => !line.startsWith('### ') && !/^\*.*`[^`]+`\*$/.test(line.trim()));
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return body || null;
}

/**
 * Markdown for the card. Order: what exactly the name is -> what it means
 * in human terms (labels) -> author's rationale -> source -> verbalization
 * -> legal source -> where declared -> spec §.
 */
function card({ decl, node, entry, comment, slice, sources = [], origin = null, usages = 0, compact = false, spoken = null } = {}) {
  const parts = [];
  if (decl) {
    const modifiers = compact ? (node?.public ? ['pub'] : []) : modifiersOf(node);
    parts.push(`**${decl.kind}** \`${decl.name}\`${modifiers.length ? ` · ${modifiers.join(' · ')}` : ''}`);

    if (!compact) {
      const labels = labelsOf(node);
      if (labels.length) parts.push(labels.join('\\\n'));
      const facts = factsOf(node);
      if (facts.length) parts.push(facts.join('\\\n'));
      if (comment) parts.push(comment.split('\n').map((l) => `> ${l}`).join('\n'));
    }

    // A §28 fragment's value is its official text, not the declaration
    // record: the quote replaces the source slice, otherwise the same text
    // would be printed twice.
    const own = compact ? [] : textsOf(node);
    if (own.length) parts.push(own.map(quote).join('\n\n'));
    else if (slice) parts.push(`\`\`\`law\n${slice}\n\`\`\``);
    else if (decl.detail) {
      parts.push(`\`\`\`law\n${decl.name}${decl.detail.startsWith('(') ? '' : ' '}${decl.detail}\n\`\`\``);
    }
    // In compact mode annotations are not printed in full, but §15 @id is
    // the norm's name in the outside world, and it must not be lost.
    if (compact && decl.id) parts.push(`\`@id(${decl.id})\``);

    if (!compact) {
      // Node verbalization (`lawref verbalize`, B1): from the package's
      // cache only — the hover does not launch the oracle, that is done by
      // the "in plain language" lens.
      if (spoken) parts.push(`**In plain language**\n\n${spoken}`);
      const annotations = annotationsOf(node);
      if (annotations) parts.push(annotations);

      for (const source of sources) {
        const head = [`**${source.name}**`, ...factsOf(source.node)].join(' · ');
        parts.push([head, ...textsOf(source.node).map(quote)].join('\n'));
      }

      const where = [];
      if (origin) where.push(`declared in \`${origin}\``);
      if (usages > 1) where.push(`occurrences in file: ${usages}`);
      if (where.length) parts.push(`*${where.join(' · ')}*`);
    }
  }

  if (entry) {
    if (parts.length) parts.push('---');
    parts.push(`**SPEC §${entry.sec}. ${entry.title}**`);
    parts.push(entry.doc);
    if (entry.also && entry.also.length) {
      parts.push(`*see also: ${entry.also.map((s) => `§${s}`).join(', ')}*`);
    }
  }
  return parts.join('\n\n');
}

module.exports = {
  card, labelsOf, annotationsOf, modifiersOf, factsOf, textsOf, leadingComment, sourceSlice, literal, spokenBody,
};
