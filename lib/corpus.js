'use strict';
// Calls into the CORPUS and the COMPILER: a package's address in
// `corpus/clir/`, the §23 resolve context for strict checking, and the
// Track O add-on (`lawc verbalize`, `lawc impact`).
//
// Only argv assembly and response parsing live here — not a line of
// semantics, not a single opinion of our own about the law (invariant 5).
// Each function names SOMEONE ELSE's tool that already knows how to
// answer, and the module exists for one reason: those tools' signatures
// must be recorded in ONE place and pinned by the smoke test. A drifted
// signature would otherwise show up to a person in the editor as a silent
// "returned nothing".
//
// Why the package address is asked of the generator instead of computed
// here. The "package directory -> CLIR file" mapping is kept by the
// `LOWERED_ACTS` registry in `corpus/gen_kz_clir.py` (470 lines). The
// output name is NOT derivable from the package name: `us.optn.kidney_allocation`
// lives in `us-kidney-allocation.lawir.json`, and a mechanical rule only
// matches 106 of 487 — i.e. it would be wrong four times out of five, and
// silently, with a WRONG package as the comparison base. A brute-force
// search was also rejected by measurement: 487 files, 281 MB, a second to
// parse. The registry's owner is asked instead — `--clir-for`.
const path = require('path');

/** Path to the corpus generator from the workspace root. */
const GENERATOR = 'corpus/gen_kz_clir.py';

/** `--clir-for`: address of the package's committed CLIR (impact comparison base). */
/** `lawc clir-for <root>`: path to the committed CLIR by the package name from law.toml (DECISION-0131). */
const clirForArgs = (root) => ['clir-for', root];

/**
 * `lawc imports-context <root>`: the §23 resolve context from the bytes of
 * dependency CLIR in `corpus/clir` — the same JSON as
 * `gen_kz_clir --imports-for`, but produced by the compiler (DECISION-0128
 * §7): no Python and no registry — the compiler finds `corpus/clir` by
 * walking up from the package root.
 */
const importsForArgs = (root) => ['imports-context', root];

/**
 * Strict §23/§24 package check (DECISION-0102, E-0121).
 *
 * Without `--imports`, the compiler does NOT judge dependencies for a
 * package WITH imports: LDC-E1104 (unpinned dependency), LDC-E1105
 * (unresolvable qualified reference), LDC-W1105 (unverified export
 * composition), and LDC-E1327 (§23.1 fact group not presented) are
 * suppressed as a property of the INPUT — no context was presented
 * (`pkg::resolve_context_diagnostic`). The suppression is deliberate:
 * otherwise `check` would fail on a hundred corpus packages for a reason
 * unrelated to their text. The cost is that the editor's ordinary check on
 * the 118 corpus packages with imports is blind to the package boundary —
 * exactly the blindness that a presented context removes.
 */
const strictCheckArgs = (root, context) => ['check', root, '--imports', context, '--json'];

/**
 * `lawc verbalize <ir>` — the B1 review document (LS §3) on stdout;
 * `{ json: true }` — structured form: text plus blocks keyed by CLIR node
 * (for verbalizing a rule in place). Since DECISION-0128 the verbalizer
 * lives in the Rust core and is called with the same binary as check and
 * lower: the same bytes as the `lawref verbalize` oracle are held by the
 * ver goldens and the differential gate.
 */
function verbalizeArgs(ir, labels = [], { json = false } = {}) {
  const args = ['verbalize', ir];
  for (const overlay of labels) args.push('--labels', overlay);
  if (json) args.push('--json');
  return args;
}

/**
 * `lawc impact <before> <after> --scenarios <dir>` — the O-1 report
 * (DECISION-0133: Rust port of `lawref impact`, same bytes, text, and exit
 * codes).
 *
 * `--scenarios` is required, and an empty directory is a legitimate
 * argument: the report then carries the §215 semantic diff and coverage
 * targets, just without a "scenario outcome changed" section. The MCP
 * server's `law_draft_impact` is built the same way (`law_impact` without
 * scenarios), and the extension does not invent a second answer to the
 * same question.
 */
const impactArgs = (before, after, scenarios) =>
  ['impact', before, after, '--scenarios', scenarios];

/**
 * A package's scenario directory, if it has one.
 *
 * Corpus convention: `<package>/scenarios/*.json` of the form
 * `{"case","query"}` (`kz/laws/qantar-2022`, `us/liver-status`). No
 * directory — `null`, and the caller substitutes an empty one: "0
 * scenarios" is an honest answer, while a made-up scenario would be a
 * computation about the law.
 */
const scenarioDir = (root, exists) => {
  const candidate = path.join(root, 'scenarios');
  return exists(candidate) ? candidate : null;
};

/**
 * The Python entry point's refusal, or `null` if it answered.
 *
 * Three distinct cases, all of which would look like the same empty
 * response in the editor: the interpreter failed to start (a string spawn
 * error code), the tool refused (non-zero exit), the tool stayed silent
 * (empty stdout with a zero exit). The last one is not success:
 * `--clir-for` on an unregistered package prints a refusal to stderr, and
 * an empty string here would mean "CLIR at path \"\"".
 */
function refusalOf(result) {
  if (!result) return 'interpreter does not start';
  if (result.error && typeof result.error.code === 'string') return `launch: ${result.error.code}`;
  const stderr = (result.stderr ?? '').trim();
  if (result.error) return stderr || `exit code ${result.error.code ?? '?'}`;
  if (!(result.stdout ?? '').trim()) return stderr || 'empty response';
  return null;
}

module.exports = {
  GENERATOR,
  clirForArgs,
  importsForArgs,
  strictCheckArgs,
  verbalizeArgs,
  impactArgs,
  scenarioDir,
  refusalOf,
};
