'use strict';

// Source-only refactorings for DECISION-0183/0185/0187. AST selects the construct;
// shell checks refuse trivia that would be lost. The caller MUST reparse the
// candidate and compare normalized ASTs before offering Apply.
const { ByteMap } = require('./offsets');
const { compactActions } = require('./compact-actions');

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 2 && Number.isInteger(value.start) && Number.isInteger(value.end)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['span', 'body_span', 'title_span'].includes(key))
    .map(([key, child]) => [key, normalized(child)]));
}

function equivalent(before, after) {
  return JSON.stringify(normalized(before)) === JSON.stringify(normalized(after));
}

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < sorted.length; i++) {
    const edit = sorted[i];
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length
      || (i && sorted[i - 1].end > edit.start)) throw new Error('Overlapping or invalid edit ranges');
  }
  for (const edit of sorted.reverse()) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
  return text;
}

function candidates(text, ast) {
  const map = new ByteMap(text);
  const index = (byte) => map.offsetOf(map.positionAt(byte));
  const slice = (span) => text.slice(index(span.start), index(span.end));
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const indentAt = (offset) => /^[\t ]*/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1))[0];
  const out = [];
  const add = (id, title, span, edits) => out.push({ id, title,
    start: Math.min(index(span.start), ...edits.map((e) => e.start)), end: index(span.end), edits });
  walk(ast, (node) => {
    compactActions(node, { text, index, slice, add });
    const rule = node.kind;
    if (['rule', 'presumption', 'constraint', 'term'].includes(rule?.kind) && rule.quantifiers?.length) {
      const params = rule.quantifiers;
      const nameEnd = index(rule.name.span.end);
      const bodyBrace = text.indexOf('{', nameEnd);
      if (bodyBrace < 0) return;
      const strengthStart = rule.strength ? index(rule.strength.span.start) : bodyBrace;
      const bodyAnchor = rule.strength ? index(rule.strength.span.end) : bodyBrace;
      const title = rule.kind === 'rule' ? 'rule' : rule.kind;
      // Labels have their own attachment semantics; never move them implicitly.
      if (params.some((p) => p.labels?.length || /\/\/|\/\*/.test(slice(p.span)))) return;
      const rendered = params.map((p) => `${slice(p.name.span)}: ${slice(p.ty.span)}`);
      if (index(params[0].name.span.start) < strengthStart) {
        const header = text.slice(nameEnd, strengthStart);
        const match = /^(\s*)\([\s\S]*\)(\s*)$/.exec(header);
        const body = /^\s*\{/.exec(text.slice(bodyAnchor));
        if (!match || !body || /\/\/|\/\*/.test(header)) return;
        const bodyStart = bodyAnchor + body[0].length;
        add(`${rule.kind}-full`, `${title} parameters → for in the body`, node.span, [
          { start: nameEnd + match[1].length, end: strengthStart - match[2].length, newText: '' },
          { start: bodyStart, end: bodyStart,
            newText: newline + rendered.map((p) => `${indentAt(nameEnd)}    for ${p};`).join(newline)
              + (/^[\t ]*\r?\n/.test(text.slice(bodyStart)) ? '' : newline) },
        ]);
      } else {
        const groups = new Map();
        for (const p of params) {
          const end = index(p.ty.span.end);
          if (!groups.has(end)) groups.set(end, []);
          groups.get(end).push(p);
        }
        const edits = [];
        for (const [end, group] of groups) {
          const start = index(group[0].name.span.start);
          const prefix = /\bfor\s*$/.exec(text.slice(0, start));
          const suffix = /^\s*;/.exec(text.slice(end));
          if (!prefix || !suffix || /\/\/|\/\*/.test(text.slice(prefix.index, end + suffix[0].length))) return;
          // Reject a textual `for` inside a line comment before the real binder.
          if (text.slice(text.lastIndexOf('\n', prefix.index - 1) + 1, prefix.index).includes('//')) return;
          edits.push({ start: prefix.index, end: end + suffix[0].length, newText: '' });
        }
        // Remove otherwise empty binder lines, retaining comment-bearing lines.
        const merged = [];
        for (const edit of edits.sort((a, b) => a.start - b.start)) {
          const previous = merged.at(-1);
          if (previous && /^[\t ]*$/.test(text.slice(previous.end, edit.start))) previous.end = edit.end;
          else merged.push(edit);
        }
        for (const edit of merged) {
          const lineStart = text.lastIndexOf('\n', edit.start - 1) + 1;
          const nextLine = text.indexOf('\n', edit.end);
          const lineEnd = nextLine < 0 ? text.length : nextLine;
          if (!text.slice(lineStart, edit.start).trim() && !text.slice(edit.end, lineEnd).trim()) {
            edit.start = lineStart;
            edit.end = nextLine < 0 ? lineEnd : lineEnd + 1;
          }
        }
        let header = `(${rendered.join(', ')})`;
        if (nameEnd - text.lastIndexOf('\n', nameEnd - 1) + header.length + (rule.strength?.text.length ?? 0) + 3 > 100) {
          header = `(${newline}${rendered.map((p) => `${indentAt(nameEnd)}    ${p},`).join(newline)}${newline}${indentAt(nameEnd)})`;
        }
        merged.push({ start: nameEnd, end: nameEnd, newText: header });
        add(`${rule.kind}-compact`, `for in the body → ${title} parameters`, node.span, merged);
      }
    }
    if (node.modality?.text !== 'duty' || !node.goal) return;
    const goal = node.goal;
    if (!['achievement', 'maintenance'].includes(goal.kind?.text)
      || !goal.condition || !goal.window || goal.fields?.length
      || goal.schedule || goal.over || goal.inner || goal.activation) return;
    let start = index(goal.span.start);
    let end = index(goal.span.end);
    const condition = slice(goal.condition.span);
    const window = slice(goal.window.span);
    let shell = text.slice(start, end);
    const pieces = [
      { start: index(goal.condition.span.start) - start, end: index(goal.condition.span.end) - start, newText: 'CONDITION' },
      { start: index(goal.window.span.start) - start, end: index(goal.window.span.end) - start, newText: 'WINDOW' },
    ];
    shell = applyEdits(shell, pieces);
    const verb = goal.kind.text === 'achievement' ? 'achieve' : 'maintain';
    const full = /^(achievement|maintenance)\s*\{\s*(?:condition\s+CONDITION\s*;\s*window\s+WINDOW\s*;|window\s+WINDOW\s*;\s*condition\s+CONDITION\s*;)\s*\}$/;
    if (full.test(shell)) {
      const prefix = /\bgoal\s*$/.exec(text.slice(index(node.span.start), start));
      if (!prefix) return;
      start = index(node.span.start) + prefix.index;
      if (text.slice(text.lastIndexOf('\n', start - 1) + 1, start).includes('//')) return;
      const suffix = /^\s*;/.exec(text.slice(end));
      if (suffix) end += suffix[0].length;
      add('goal-compact', `Duty goal → ${verb} … during …`, goal.span,
        [{ start, end, newText: `${verb} ${condition} during ${window};` }]);
    } else if (/^(achieve|maintain)\s+CONDITION\s+during\s+WINDOW$/.test(shell)) {
      const suffix = /^\s*;/.exec(text.slice(end));
      if (!suffix) return;
      end += suffix[0].length;
      const indent = indentAt(start);
      add('goal-full', 'Short goal → full goal block', goal.span, [{ start, end,
        newText: `goal ${goal.kind.text} {${newline}${indent}    condition ${condition};${newline}${indent}    window ${window};${newline}${indent}}` }]);
    }
  });
  return out;
}

module.exports = { walk, normalized, equivalent, applyEdits, candidates };
