'use strict';
// Parsing `lawc check` output.
//
// The main path is the MACHINE mode `--json` (§225, WP-35): an envelope with
// an array of diagnostics per the normative `diagnostic.schema.json`. It
// gives what a text line fundamentally lacks — the END of the span, so the
// underline is no longer stretched by a token heuristic but comes from the
// compiler.
//
// Text parsing remains a fallback path and will not be removed: on a panic
// the compiler doesn't print JSON at all, and the only signal is a line in
// stderr. The format is law-syntax/src/diag.rs,
// `path:line:col: severity CODE: message`, column in CHARACTERS
// (DECISION-0002, decision A: human-readable interface §198). Both units of
// the machine mode — `character` in characters and `offset` in bytes — are
// the same numbers; the match between the two modes is held by gate
// verify/ci/gates/compiler/check_cli_json.py, the text path's unit by the
// smoke test apps/site/tools/check-extension.mjs.

const { ByteMap, tokenEndOffset } = require('./offsets');

const DIAG_RE = /^(.*?):(\d+):(\d+): (error|warning) ([A-Z]+-[A-Z0-9]+): ([^\n]*)$/;

/** stderr → structured diagnostics + a compiler-crash flag. */
function parseCheckOutput(stderr) {
  const diagnostics = [];
  let crash = null;
  for (const raw of String(stderr).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (line.includes('panicked at')) {
      crash = crash ?? line.trim();
      continue;
    }
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    diagnostics.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4],
      code: m[5],
      message: m[6],
    });
  }
  return { diagnostics, crash };
}

/** stdout(--json) + stderr → the same structured diagnostics, but with the full span.
 *
 * A compiler panic produces no JSON: it goes to stderr as text and is caught
 * by the same flag as before. Missing or malformed JSON is not "the file is
 * clean" but a parse failure: the caller must tell the two apart, so
 * `parsed: false` is returned here, not an empty list.
 */
function parseCheckJson(stdout, stderr) {
  let crash = null;
  for (const raw of String(stderr).split('\n')) {
    if (raw.includes('panicked at')) { crash = raw.trim(); break; }
  }
  if (crash) return { diagnostics: [], crash, parsed: true };
  let envelope;
  try {
    envelope = JSON.parse(String(stdout));
  } catch {
    return { diagnostics: [], crash: null, parsed: false };
  }
  if (!envelope || !Array.isArray(envelope.diagnostics)) {
    return { diagnostics: [], crash: null, parsed: false };
  }
  const diagnostics = envelope.diagnostics.map((d) => ({
    file: d.primarySpan.uri,
    line: d.primarySpan.start.line,
    column: d.primarySpan.start.character,
    severity: d.severity,
    code: d.code,
    message: d.message,
    // Byte offsets §13 — the exact span from the compiler, no heuristics.
    byteStart: d.primarySpan.start.offset,
    byteEnd: d.primarySpan.end.offset,
  }));
  return { diagnostics, crash: null, parsed: true };
}

/** Compiler diagnostics → ranges in editor coordinates.
 *
 * The span from machine mode is taken as-is; the text path has no end, and
 * it is still filled in from the token. A zero-width span (the compiler
 * pointed at a location) is stretched the same way: an empty range is
 * invisible in Problems.
 */
function locate(text, parsed) {
  const map = new ByteMap(text);
  return parsed.map((d) => {
    // The compiler's span is in BYTES (§13), while this module's
    // `startOffset`/`endOffset` are offsets in UTF-16 code units, which the
    // editor addresses by. The conversion is mandatory and goes through a
    // position: substituting bytes directly would miss by exactly the
    // length of any Cyrillic text earlier in the file.
    const hasSpan = Number.isInteger(d.byteStart) && Number.isInteger(d.byteEnd);
    const start = hasSpan ? map.positionAt(d.byteStart) : map.fromCharColumn(d.line, d.column);
    const startOffset = map.offsetOf(start);
    const endOffset = hasSpan && d.byteEnd > d.byteStart
      ? map.offsetOf(map.positionAt(d.byteEnd))
      : tokenEndOffset(text, startOffset);
    return { ...d, start, end: map.positionOfOffset(endOffset), startOffset, endOffset };
  });
}

module.exports = { parseCheckOutput, parseCheckJson, locate };
