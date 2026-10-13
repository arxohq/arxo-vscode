'use strict';
// The §267 test as a source of diagnostics for `.lawtest`.
//
// There is no, and cannot be, compiler checking for a case or a test
// (rationale and measurement are in lib/files.js), but a test has its OWN
// source of truth: the runner `lawc test <file>.lawtest --program <file>`
// lowers the test, calls the engine, and compares the §174 result fields
// against the §267 expectations. A failed expectation is a file
// diagnostic, and belongs in Problems, not in a popup message.
//
// The main path is the MACHINE mode `--json` (§225); text parsing is the
// fallback. Compiler diagnostics are built the same way (lib/diagnostics.js),
// and for the same reason: the runner's printed output has already moved
// (before 27.08 PASS went to stdout and FAIL to stderr), while the §208
// envelope does not move.
//
// The switch closed a defect that text parsing could not see by
// construction. The runner counts §270 PROPERTIES as a separate tally
// ("N/M §270 properties hold") and prints them BEFORE the verdict line;
// `parseVerdict` looks for `test PASS` first, and on the
// LAY-L0-PROPERTY-COMPARISON vector it returned `passed: true` when a
// property had failed, with a non-zero exit code and a `property FAIL`
// line two lines above. The extension said "test passed" about a run the
// runner had failed. In machine mode, properties arrive as a `properties`
// array alongside `tests`, and they cannot be lost.
//
// Text parsing stays: `--json` is not printed at all on a compiler panic
// or with an old binary, and the streams remain the only signal. Both
// streams are read in full — for the same history of the move.

// An expectation in the form it is written in the source: `field == VALUE`.
// The runner's line is `<field> <op> <expectation>: in the document <fact>`;
// what precedes the colon is exactly what the author wrote after `expect`,
// so the underline is placed by SUBSTRING MATCH, not by guessing a position.
const EXPECTATION = /^([a-z_]+ (?:==|!=) [^:]+): /;

const FAILURE_LINE = /^ {2}(\S.*)$/;

const expectationOf = (message) => {
  const match = EXPECTATION.exec(message);
  return match ? match[1].trim() : null;
};

/**
 * The runner's verdict, or `null` if it never reached one.
 *
 * `null` does not mean "test passed": a lowering refusal, a program not
 * found, or a panic all print anything but a verdict line, and silence
 * here would mean a green test where none was ever run.
 */
function parseVerdict(stdout = '', stderr = '') {
  const both = `${stdout}\n${stderr}`;
  const passed = /^test PASS: (.*)$/m.exec(both);
  if (passed) return { title: passed[1].trim(), passed: true, failures: [] };
  const failed = /^test FAIL: (.*)$/m.exec(both);
  if (!failed) return null;
  const failures = [];
  for (const line of both.split('\n')) {
    const match = FAILURE_LINE.exec(line.replace(/\r$/, ''));
    if (match) failures.push({ message: match[1], expectation: expectationOf(match[1]) });
  }
  return { title: failed[1].trim(), passed: false, failures };
}

/**
 * A §169 program for the test among sibling files.
 *
 * Order — from most specific to most general: `source.law` (the name used
 * for the program across every vector in the tree), then a single `*.law`,
 * then `ir.json` (ready CLIR — the runner accepts that too). Two `.law`
 * files without `source.law` give `null`: choosing on the author's behalf
 * would mean running the test against the wrong program and calling the
 * result a verdict.
 */
function programFor(names = []) {
  if (names.includes('source.law')) return 'source.law';
  const laws = names.filter((n) => n.endsWith('.law'));
  if (laws.length === 1) return laws[0];
  if (laws.length === 0 && names.includes('ir.json')) return 'ir.json';
  return null;
}

/** Offsets of an expectation in the test source (UTF-16, as the editor addresses). */
function locate(text, expectation) {
  if (!expectation) return null;
  const at = text.indexOf(expectation);
  return at === -1 ? null : { start: at, end: at + expectation.length };
}

/**
 * The runner's report from machine mode (`test <file>.lawtest --program … --json`).
 *
 * `null` means there is no envelope (old binary, panic): call `parseVerdict`.
 * `{ refusal }` means the runner refused BEFORE running (no program, the
 * test does not lower): this is neither "test failed" nor "test passed".
 * Otherwise `{ tests, properties }` — one entry per §267 `test` in the
 * file, and per §270 property that did NOT hold.
 */
function parseVerdictsJson(stdout = '', stderr = '') {
  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || payload.command !== 'test') return null;
  // A §208 refusal envelope carries `error` and no `tests`; an empty tests
  // array with `ok: true` is a legitimate response (no tests in the file),
  // and is not a refusal.
  if (typeof payload.error === 'string') {
    return { refusal: payload.error, tests: [], properties: [] };
  }
  if (!Array.isArray(payload.tests)) return null;
  const tests = payload.tests.map((entry) => ({
    title: String(entry?.title ?? ''),
    passed: Boolean(entry?.passed),
    failures: (Array.isArray(entry?.failures) ? entry.failures : []).map((message) => ({
      message: String(message),
      expectation: expectationOf(String(message)),
    })),
  }));
  const properties = (Array.isArray(payload.properties) ? payload.properties : [])
    .filter((entry) => entry && entry.held === false)
    .map((entry) => ({ name: String(entry.property ?? ''), message: propertyMessage(entry) }));
  return { refusal: null, tests, properties };
}

/**
 * Message about a §270 property that did not hold — in the exact same
 * words the runner itself prints (`law-cli-core/src/engine.rs`, the `test`
 * text-printing branch). This wording is intentionally left in Russian
 * below: it must match the Rust CLI's literal output byte for byte, which
 * the `ext:test` smoke test verifies.
 *
 * The machine envelope carries fields, not a phrase, so the phrase is
 * assembled here — and this is the only place in the extension where the
 * runner's text is reconstructed rather than taken ready-made. The
 * `ext:test` smoke test keeps them in sync: it runs BOTH modes on the same
 * vector and checks that the assembled text matches what was printed. If
 * they drift, the smoke test goes red, instead of the two modes reporting
 * two different messages about the same property.
 */
function propertyMessage(entry) {
  const lines = [`property FAIL: ${entry.property} (domain: ${entry.domain} items)`];
  for (const item of entry.counterexamples ?? []) lines.push(`  counterexample: ${item}`);
  for (const item of entry.skipped ?? []) lines.push(`  NOT CHECKED — ${item}`);
  return lines.join('\n');
}

module.exports = { parseVerdict, parseVerdictsJson, propertyMessage, programFor, locate, expectationOf };
