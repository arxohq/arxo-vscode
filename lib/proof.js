'use strict';
// Proof tree from the proof graph §235: `lawc eval` returns nodes with a
// conclusion, premises and — for a rule application — a reference to the
// rule itself.
//
// The graph is a DAG, not a tree: one premise can support several
// conclusions. We unfold it into a tree, showing repeats as they are, but we
// remember the path so that a cycle (which should not exist in L0, but is
// cheaper to check for than to hang on) breaks off with a marker instead of infinite recursion.

const KIND_LABELS = {
  query_evaluation: 'query',
  rule_application: 'rule',
  assertion: 'assertion',
  closure: 'closure',
  comprehension: 'comprehension',
};

/** `urn:law:vectors:t012#Governs` → `Governs`; `urn:entity:acme` → `acme`. */
function shortId(urn) {
  if (typeof urn !== 'string') return String(urn ?? '');
  const hash = urn.lastIndexOf('#');
  if (hash !== -1) return urn.slice(hash + 1);
  const colon = urn.lastIndexOf(':');
  return colon !== -1 ? urn.slice(colon + 1) : urn;
}

function formatArg(arg) {
  if (arg === null || typeof arg !== 'object') return String(arg);
  if (arg.kind === 'entity_ref') return shortId(arg.id);
  if (arg.kind === 'var') return `?${arg.var}`;
  if ('value' in arg) return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
  return arg.id ? shortId(arg.id) : JSON.stringify(arg);
}

function formatLiteral(literal) {
  if (!literal || typeof literal !== 'object') return '—';
  const name = shortId(literal.predicate);
  const args = (literal.args ?? []).map(formatArg).join(', ');
  const negated = literal.polarity === 'negative' ? '¬' : '';
  return `${negated}${name}${args ? `(${args})` : ''}`;
}

// A conclusion is not always a literal: for collect §52.1 it is a
// comprehension, for nested formulas — a status wrapper. We format by kind,
// we don't invent the unknown, we show it as-is.
function formatFormula(formula) {
  if (!formula || typeof formula !== 'object') return '—';
  switch (formula.kind) {
    case 'literal':
      return formatLiteral(formula);
    case 'status': {
      const inner = formatFormula(formula.formula ?? formula.literal);
      return formula.status ? `${inner}: ${formula.status}` : inner;
    }
    case 'comprehension': {
      const element = formatArg(formula.element);
      const generator = formatFormula(formula.generator);
      return `collect${formula.distinct ? ' distinct' : ''} ${element} | ${generator}`;
    }
    case 'and':
    case 'or': {
      const items = (formula.items ?? []).map(formatFormula);
      return items.length ? items.join(formula.kind === 'and' ? ' and ' : ' or ') : formula.kind;
    }
    case 'not':
      return `not ${formatFormula(formula.formula ?? formula.item)}`;
    default:
      return formula.predicate ? formatLiteral(formula) : (formula.kind ?? '—');
  }
}

/** Node conclusion: for a query it's wrapped together with truthStatus or count. */
function conclusionOf(node) {
  const conclusion = node?.conclusion;
  if (!conclusion || typeof conclusion !== 'object') return { text: '—', status: null };
  const status = conclusion.truthStatus
    ?? (Number.isInteger(conclusion.count) ? `elements: ${conclusion.count}` : null);
  if (conclusion.literal) return { text: formatFormula(conclusion.literal), status };
  if (conclusion.comprehension) return { text: formatFormula(conclusion.comprehension), status };
  return { text: formatFormula(conclusion), status };
}

/** Node caption: what justifies it. */
function describe(node) {
  const kind = KIND_LABELS[node.kind] ?? node.kind;
  if (node.rule) return `${kind} ${shortId(node.rule)}`;
  if (node.attributes && node.attributes.assertion) return `${kind} ${shortId(node.attributes.assertion)}`;
  return kind;
}

/**
 * proofGraph → array of tree roots.
 * Node: { id, label, description, kind, rule, status, children, repeated }
 */
function buildTree(graph) {
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  const roots = graph?.roots?.length ? graph.roots : [...byId.keys()];

  const expand = (id, path) => {
    const node = byId.get(id);
    if (!node) return { id, label: shortId(id), description: 'node not found', kind: 'missing', children: [] };
    const { text, status } = conclusionOf(node);
    if (path.has(id)) {
      return { id, label: text, description: `${describe(node)} · cycle`, kind: node.kind, status, children: [], repeated: true };
    }
    const next = new Set(path).add(id);
    // Navigation anchor: a rule lives in source.law, an assertion in case.json.
    const anchor = node.rule
      ? { kind: 'rule', name: shortId(node.rule) }
      : (node.attributes && node.attributes.assertion
        ? { kind: 'assertion', name: shortId(node.attributes.assertion) }
        : null);
    return {
      id,
      label: text,
      description: describe(node),
      kind: node.kind,
      anchor,
      status,
      children: (node.premises ?? []).map((premise) => expand(premise, next)),
    };
  };

  return roots.map((id) => expand(id, new Set()));
}

const countNodes = (roots) => roots.reduce((n, r) => n + 1 + countNodes(r.children ?? []), 0);

module.exports = { buildTree, conclusionOf, describe, formatFormula, formatLiteral, shortId, countNodes, KIND_LABELS };
