'use strict';
// Converting compiler coordinates to editor positions.
//
// lawc has two different units, and they must not be confused
// (law-syntax/src/diag.rs):
//   * AST spans — BYTE offsets (§13: source is UTF-8, official texts' bytes
//     are preserved exactly) → positionAt / fromByteColumn;
//   * the column in `path:line:col` — a CHARACTER (Unicode scalar value),
//     because this is the human-readable interface §198 → fromCharColumn.
// The editor addresses text in UTF-16, so both units need recalculation: on
// a line with Cyrillic text before the error location — and in this
// language that's everywhere — the underline drifts off without it.

class ByteMap {
  constructor(text) {
    this.lines = text.split('\n');
    this.lineStartBytes = new Array(this.lines.length);
    let acc = 0;
    for (let i = 0; i < this.lines.length; i++) {
      this.lineStartBytes[i] = acc;
      acc += Buffer.byteLength(this.lines[i], 'utf8') + 1; // + '\n'
    }
  }

  /** Diagnostic line and column (1-based, column in characters) → position. */
  fromCharColumn(line1, charColumn1) {
    const line = Math.min(Math.max(0, line1 - 1), Math.max(0, this.lines.length - 1));
    const source = this.lines[line] ?? '';
    const target = Math.max(0, charColumn1 - 1);
    let seen = 0;
    let character = 0;
    for (const ch of source) {
      if (seen >= target) break;
      seen += 1; // code point
      character += ch.length; // code units
    }
    return { line, character };
  }

  /** Line and byte column (1-based) → position; for AST spans. */
  fromByteColumn(line1, byteColumn1) {
    const line = Math.min(Math.max(0, line1 - 1), Math.max(0, this.lines.length - 1));
    const source = this.lines[line] ?? '';
    const targetBytes = Math.max(0, byteColumn1 - 1);
    let bytes = 0;
    let character = 0;
    for (const ch of source) {
      if (bytes >= targetBytes) break;
      bytes += Buffer.byteLength(ch, 'utf8');
      character += ch.length; // code units, not code points
    }
    return { line, character };
  }

  /** Absolute byte offset (AST span) → position. */
  positionAt(byteOffset) {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStartBytes[mid] <= byteOffset) lo = mid;
      else hi = mid - 1;
    }
    return this.fromByteColumn(lo + 1, byteOffset - this.lineStartBytes[lo] + 1);
  }

  /** Position → offset in UTF-16 code units (for quick fix edits). */
  offsetOf(position) {
    let offset = 0;
    for (let i = 0; i < position.line && i < this.lines.length; i++) offset += this.lines[i].length + 1;
    return offset + position.character;
  }

  /** Offset in UTF-16 code units → position. */
  positionOfOffset(offset) {
    let rest = Math.max(0, offset);
    for (let line = 0; line < this.lines.length; line++) {
      const len = this.lines[line].length;
      if (rest <= len) return { line, character: rest };
      rest -= len + 1;
    }
    const line = Math.max(0, this.lines.length - 1);
    return { line, character: this.lines[line].length };
  }
}

// A diagnostic carries only the start. Underlining a single character is
// useless, so the range is stretched over the token: an identifier — to the
// end of the word, a string — to the closing quote (for §194 the diagnostic
// sits exactly on the content_hash literal, and the whole thing must be underlined).
function tokenEndOffset(text, offset) {
  if (offset >= text.length) return offset;
  const ch = text[offset];
  if (ch === '"') {
    const close = text.indexOf('"', offset + 1);
    return close === -1 ? offset + 1 : close + 1;
  }
  if (/[A-Za-z0-9_`]/.test(ch)) {
    let end = offset;
    while (end < text.length && /[A-Za-z0-9_`]/.test(text[end])) end++;
    return end;
  }
  return offset + 1;
}

module.exports = { ByteMap, tokenEndOffset };
