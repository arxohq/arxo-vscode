'use strict';
// LawQL (.lawq): oracle argv, parsing its machine response, and rendering
// the result. No semantics and no vscode API — pure functions, so they can
// be checked directly by the smoke test (apps/site/tools/check-extension.mjs).
//
// LawQL answers questions about the formalization ITSELF (which norms,
// labels, anchors exist in a package), not about a case
// (docs/reference/authoring/QL-COOKBOOK.ru.md). It is executed by the Rust
// port `lawc query` (DECISION-0129, crate `law-ql`): the same documents
// byte for byte as the `python3 -m lawref query` oracle — equality is held
// by the differential gate. The extension calls the CLI with `--json` and
// displays the canonical `queryResult` — as a table for reading and as
// bytes for comparison. "Computing a little extra" here is forbidden
// (CLAUDE.md, invariant 5): every line below either assembles argv or lays
// out an already-produced document line by line.
//
// The language's vocabulary lives in the oracle, and the lists below are
// its copy FOR HIGHLIGHTING AND COMPLETION: keywords — `KEYWORDS` in
// `lawref/query/parser.py`, functions — `_call` branches in
// `lawref/query/engine.py`, query-over clauses — `lawref/query/inference.py`.
// Drift between the copy and the original, and between the copy and the
// port, is caught by the smoke test (it reads both sources with a regex);
// relations and their fields are not copied at all — they are asked of
// `--schema --json` on first completion.

/** Keywords of a structural query (parser.py: KEYWORDS). */
const KEYWORDS = [
  'from', 'in', 'where', 'select', 'as', 'and', 'or', 'exists', 'not',
  'let', 'eval', 'true', 'false', 'null', 'query', 'over',
];

/** Clauses of a `query … over … { … }` body (inference.py). */
const INFERENCE_CLAUSES = ['for', 'case', 'where', 'select'];

/** LawQL functions with their signature and purpose (engine.py: `_call`). */
const FUNCTIONS = {
  anchor: { signature: 'anchor(node)', doc: 'A node\'s §194 anchors: act, locator, fragment, CLIR path.' },
  labels: { signature: 'labels(node[, lang])', doc: 'A node\'s §218 labels; with `lang` — only in that language.' },
  short: { signature: 'short(id)', doc: 'The identifier tail after `#` and `:`.' },
  contains: { signature: 'contains(collection, item)', doc: 'True if a string or list contains the element.' },
  overlaps: { signature: 'overlaps(a, b)', doc: 'True if the two lists share an element.' },
  starts_with: { signature: 'starts_with(text, prefix)', doc: 'The string starts with the prefix.' },
  ends_with: { signature: 'ends_with(text, suffix)', doc: 'The string ends with the suffix.' },
  position: { signature: 'position(doc, template)', doc: 'Norm positions from a materialized `eval(…)` document.' },
  derivation: { signature: 'derivation(doc, id)', doc: 'Nodes of a materialized document\'s §235 proof graph by id or conclusion.' },
};

/** Binding sources: `from r in corpus("kz.*").rules`, `package("x").nodes`. */
const SOURCES = {
  corpus: { signature: 'corpus(glob)', doc: 'A corpus snapshot by a `package.name` glob; `"*"` — the whole corpus.' },
  package: { signature: 'package(name)', doc: 'A single package by exact name.' },
};

/** law-cli subcommand; the format is always machine-readable. */
const MODULE = ['query'];

/**
 * argv for running a query.
 *
 * `source` is either a path to a `.lawq` file OR the query text: the CLI
 * tells them apart itself (`query_source`: file, catalog name, otherwise
 * inline). Relative paths in `case`/`eval()` inside the query are resolved
 * by the CLI relative to the file's directory, and for inline text relative
 * to cwd — so the caller must set cwd to the document's directory when
 * sending the text of an unsaved buffer. There is only one materialization
 * engine — the lawc core; there is no `--engine` flag in argv.
 */
function queryArgs(source, { corpus, pkg, limit } = {}) {
  const args = [...MODULE, source, '--json'];
  if (corpus && corpus !== '*') args.push('--corpus', corpus);
  if (pkg) args.push('--pkg', pkg);
  if (Number.isInteger(limit) && limit > 0) args.push('--limit', String(limit));
  return args;
}

/** `--schema --json`: relations, fields, node kinds, and snapshot counts. */
function schemaArgs(corpus) {
  const args = [...MODULE, '--schema', '--json'];
  if (corpus && corpus !== '*') args.push('--corpus', corpus);
  return args;
}

/** `--list --json`: named queries from the `corpus/ql/lints` catalog. */
const catalogArgs = () => [...MODULE, '--list', '--json'];

/**
 * Parse stdout: the canonical document, or `null` if it is not JSON.
 *
 * On a query error the oracle prints `{"kind":"queryError",…}` to stdout
 * with exit code 2 — that is a RESPONSE, not a launch failure; an
 * interpreter panic arrives as a traceback on stderr with empty stdout —
 * that is a failure.
 */
function parseOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Diagnostic from `queryError`: code `LDC-Qxxxx`, message, hints, position.
 *
 * The oracle's line and column are 1-based and exist only for parse
 * errors; execution errors (`LDC-Q2001` unknown relation) have no
 * position — then `line`/`column` are `null`, and the caller places the
 * diagnostic at the start of the file.
 */
function errorOf(doc) {
  if (!doc || doc.kind !== 'queryError' || !doc.error) return null;
  const e = doc.error;
  return {
    code: String(e.code ?? 'LDC-Q0000'),
    message: String(e.message ?? ''),
    hints: Array.isArray(e.hints) ? e.hints.map(String) : [],
    line: Number.isInteger(e.line) ? e.line : null,
    column: Number.isInteger(e.column) ? e.column : null,
  };
}

/** Diagnostic text for Problems: message and hints on one line. */
function errorMessage(error) {
  const hints = error.hints.length ? ` Hint: ${error.hints.join('; ')}` : '';
  return `${error.message}.${hints}`;
}

const cell = (value) => {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};
const escapeCell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * `queryResult` -> Markdown: a column table, provenance, warnings, manifest
 * header. Only lays out already-produced values: no aggregation, no
 * filtering — whatever the oracle returned is what appears on screen.
 */
function renderResult(doc, { title = 'LawQL', source = '' } = {}) {
  const columns = Array.isArray(doc.columns) ? doc.columns : [];
  const rows = Array.isArray(doc.rows) ? doc.rows : [];
  const manifest = doc.manifest ?? {};
  const packages = Array.isArray(manifest.corpus) ? manifest.corpus : [];
  const lines = [`# ${title}`, ''];
  if (source) lines.push('```lawq', source.trim(), '```', '');
  lines.push(`Rows: **${rows.length}**; packages in snapshot: ${packages.length}`
    + (manifest.materializations ? `; materializations: ${manifest.materializations}` : '')
    + (manifest.queryHash ? `; \`${manifest.queryHash}\`` : '') + '.', '');
  if (!rows.length) {
    lines.push('No matches.', '');
    const explain = doc.explain;
    if (explain && Array.isArray(explain.funnel) && explain.funnel.length) {
      lines.push('Funnel by clause:', '');
      for (const step of explain.funnel) lines.push(`- \`${step.clause}\`: ${step.rows}`);
      if (explain.emptyAt) lines.push('', `Result went empty at: \`${explain.emptyAt}\`.`);
      lines.push('');
    }
  } else {
    lines.push(`| # | ${columns.map(escapeCell).join(' | ')} | nodes |`);
    lines.push(`|---|${columns.map(() => '---').join('|')}|---|`);
    rows.forEach((row, index) => {
      const values = row.values ?? {};
      const nodes = row.provenance?.nodes ?? [];
      lines.push(`| ${index + 1} | ${columns.map((c) => escapeCell(cell(values[c]))).join(' | ')} | ${nodes.length} |`);
    });
    lines.push('');
  }
  const warnings = Array.isArray(doc.warnings) ? doc.warnings : [];
  if (warnings.length) {
    lines.push('## Warnings', '');
    for (const w of warnings) lines.push(`- ⚠ \`${w.code}\`: ${w.message}`);
    lines.push('');
  }
  if (packages.length) {
    lines.push('## Corpus snapshot', '');
    for (const p of packages) lines.push(`- \`${p.package}\` — \`${p.semanticHash ?? '—'}\``);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * `queryCatalog` -> Markdown list for "Law: LawQL lint catalog".
 */
function renderCatalog(doc) {
  const queries = Array.isArray(doc?.queries) ? doc.queries : [];
  const lines = ['# LawQL catalog (`corpus/ql/lints`)', ''];
  if (!queries.length) lines.push('The catalog is empty.');
  for (const q of queries) {
    const params = q.params?.length ? ` (${q.params.join(', ')})` : '';
    lines.push(`- **${q.name}**${params} — ${q.description ?? ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Completion from the schema: relations with their fields, node kinds as
 * string `kind` values. `schema` is the `--schema --json` response, or
 * `null` before it arrives; then only keywords, functions, and sources are
 * offered — they do not depend on the snapshot.
 */
function completions(schema, { afterDot = false, afterKind = false } = {}) {
  const items = [];
  const relations = Array.isArray(schema?.relations) ? schema.relations : [];
  if (afterKind) {
    for (const k of Array.isArray(schema?.nodeKinds) ? schema.nodeKinds : []) {
      items.push({ label: k.name, kind: 'value', detail: `node kind · ${k.count}` });
    }
    return items;
  }
  if (afterDot) {
    const seen = new Set();
    for (const r of relations) {
      for (const f of r.fields ?? []) {
        if (seen.has(f)) continue;
        seen.add(f);
        items.push({ label: f, kind: 'field', detail: `field of ${r.name}` });
      }
    }
    for (const r of relations) items.push({ label: r.name, kind: 'relation', detail: `corpus(…).${r.name}` });
    return items;
  }
  for (const w of KEYWORDS) items.push({ label: w, kind: 'keyword', detail: 'LawQL' });
  for (const w of INFERENCE_CLAUSES) {
    if (!KEYWORDS.includes(w)) items.push({ label: w, kind: 'keyword', detail: 'query … over' });
  }
  for (const [name, f] of Object.entries(FUNCTIONS)) {
    items.push({ label: name, kind: 'function', detail: f.signature, doc: f.doc, snippet: `${name}($0)` });
  }
  for (const [name, f] of Object.entries(SOURCES)) {
    items.push({ label: name, kind: 'function', detail: f.signature, doc: f.doc, snippet: `${name}("$0")` });
  }
  for (const r of relations) {
    items.push({ label: r.name, kind: 'relation',
      detail: `${r.name}(${(r.fields ?? []).join(', ')}) · ${r.count}` });
  }
  return items;
}

/** Hover card: a function, source, or schema relation. */
function hoverFor(word, schema) {
  const fn = FUNCTIONS[word] ?? SOURCES[word];
  if (fn) return `\`${fn.signature}\`\n\n${fn.doc}`;
  const relation = (schema?.relations ?? []).find((r) => r.name === word);
  if (relation) {
    return `\`${relation.name}(${(relation.fields ?? []).join(', ')})\`\n\nRows in snapshot: ${relation.count}.`;
  }
  return null;
}

module.exports = {
  KEYWORDS,
  INFERENCE_CLAUSES,
  FUNCTIONS,
  SOURCES,
  queryArgs,
  schemaArgs,
  catalogArgs,
  parseOutput,
  errorOf,
  errorMessage,
  renderResult,
  renderCatalog,
  completions,
  hoverFor,
};
