'use strict';
// Which compiler command applies to which file. No semantics and no vscode
// API: pure predicates over the path, so they can be smoke-tested directly.
//
// The language has four surfaces, and each has its own set of applicable
// commands — listed here once, so they don't drift as copies across extension.js.

const PROGRAM = '.law';
const LITERATE = '.law.md';
const TEST = '.lawtest';
const CASE = '.lawcase';

/** Language surface by file name: '.law.md' | '.lawtest' | '.lawcase' | '.law' | null. */
function surfaceOf(fsPath) {
  const name = String(fsPath ?? '');
  // Order matters: `.law.md` ends in both `.md` and `.law` — it can't be checked against `.law`.
  for (const surface of [LITERATE, TEST, CASE, PROGRAM]) {
    if (name.endsWith(surface)) return surface;
  }
  return null;
}

/**
 * Whether `lawc check` will tell the truth about this file.
 *
 * Checking resolves names within a SINGLE file (§22), and a case §168 or a
 * test §267 is not a package program at all (`LDC-E1314`): their predicates
 * are declared in a neighboring program, and a standalone check reports
 * `LDC-E2102` "not declared as a relation in this file" for every one of
 * them. Measurement on 27.08.2026 over the tree: 118 files out of 132
 * produce diagnostics, 308 in total, and **every single one** is
 * `LDC-E2102`. There is currently no way to check a case together with its
 * program: directory traversal only collects `*.law` (`collect_law_files`
 * in law-cli/src/main.rs), and `--program` exists for `test` but not for `check`.
 */
function checkable(fsPath) {
  const surface = surfaceOf(fsPath);
  return surface === PROGRAM || surface === LITERATE;
}

/**
 * Whether the surface is covered by the §214 guarantees, i.e. whether it can be formatted.
 *
 * Program only. Literate is declared out of scope for formatter v1
 * (DECISION-0027 item 8a) — the compiler responds with a refusal and a
 * non-zero exit code. Case and test are not part of the sample for gate
 * `verify/ci/gates/compiler/check_fmt.py` (`*.law`), meaning neither
 * idempotence nor token-stream stability is asserted for them; the extension
 * will not format what the gate stays silent about. The cost of this
 * decision is zero and measured: the formatter changes none of the 132 case
 * and test files in the tree.
 */
function formattable(fsPath) {
  return surfaceOf(fsPath) === PROGRAM;
}

// Generated content is edited only by the generator (CLAUDE.md, invariant 2),
// and DECISION-0027 item 10 names the same boundary for the formatter:
// `verify/vectors/**/*.law` are produced by the ir→law renderer, so a manual
// edit is undone by the very next regeneration and trips gate 4. Format on
// save would do this silently.
// The path is multi-segment since DECISION-0059: vectors live in
// verify/vectors/, and comparing against a single first segment (`vectors`)
// after the root's hierarchization would silently declare EVERYTHING
// generated as hand-written — format on save could again undo regeneration.
const GENERATED_ROOTS = ['verify/vectors'];

/** Whether the file is in a directory owned by the generator. */
function generated(fsPath, folder) {
  if (!folder) return false;
  const root = String(folder).replace(/\/+$/, '');
  const file = String(fsPath ?? '');
  if (!file.startsWith(`${root}/`)) return false;
  const rel = file.slice(root.length + 1);
  return GENERATED_ROOTS.some((g) => rel === g || rel.startsWith(`${g}/`));
}

/**
 * Name of the temporary copy of an unsaved buffer.
 *
 * The surface must be preserved: the compiler picks the mode by extension —
 * literate §217 is switched on by it specifically.
 */
function bufferName(fsPath) {
  return `buffer${surfaceOf(fsPath) ?? PROGRAM}`;
}

module.exports = { surfaceOf, checkable, formattable, generated, bufferName, GENERATED_ROOTS };
