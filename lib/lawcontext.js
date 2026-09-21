'use strict';
// Positional checks without semantics: where in the text a hint can be
// shown, and where it can't. Factored out of extension.js so it can be
// tested without the vscode API.

// Boundaries of a law block in literate `.law.md`. The opening and closing
// condition is the same as the compiler's
// (engines/lawc/crates/law-syntax/src/literate.rs): exactly three backticks
// and info-string `law`, closing is a ``` line. A block the compiler
// doesn't pick up gets no hints either.
function lawBlocks(text) {
  const blocks = [];
  let pos = 0;
  let inLaw = false;
  let start = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const next = pos + line.length;
    const trimmed = line.replace(/[\r\n]+$/, '').trimStart();
    if (!inLaw) {
      if (trimmed === '```law' || trimmed.startsWith('```law ')) {
        inLaw = true;
        start = next;
      }
    } else if (trimmed === '```') {
      blocks.push({ start, end: pos });
      inLaw = false;
    }
    pos = next;
  }
  // An unclosed block: the file is being typed.
  if (inLaw) blocks.push({ start, end: text.length });
  return blocks;
}

function lawBlockAt(text, offset) {
  return lawBlocks(text).find((b) => offset >= b.start && offset < b.end) ?? null;
}

// The assembled source is a concatenation of the RAW BYTES of law blocks in
// document order (literate.rs's contract), so AST spans that arrive from
// the compiler in the assembled source's coordinates are translated back
// cumulatively. The CLI doesn't expose the block map — we compute it
// ourselves, by the same rule used to find blocks for hints.
function assembledToMdByte(text) {
  const blocks = lawBlocks(text).map((b) => ({
    mdByteStart: Buffer.byteLength(text.slice(0, b.start), 'utf8'),
    byteLength: Buffer.byteLength(text.slice(b.start, b.end), 'utf8'),
  }));
  let acc = 0;
  for (const b of blocks) {
    b.assembledStart = acc;
    acc += b.byteLength;
  }
  return (assembledByte) => {
    for (const b of blocks) {
      if (assembledByte >= b.assembledStart && assembledByte <= b.assembledStart + b.byteLength) {
        return b.mdByteStart + (assembledByte - b.assembledStart);
      }
    }
    return blocks.length ? blocks[blocks.length - 1].mdByteStart : 0;
  };
}

// Positions where a keyword is not a keyword: the source's official text
// (text block §17), a string, and a comment. The check is crude — without a
// parser it can't be more precise, and a false hint over a normative
// quotation is worse than a missed one.
function isSuppressed(text, offset) {
  const before = text.slice(0, offset);
  const triples = (before.match(/"""/g) ?? []).length;
  if (triples % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf('\n') + 1);
  if (line.includes('//')) return true;
  return ((line.match(/"/g) ?? []).length % 2) === 1;
}

module.exports = { lawBlocks, lawBlockAt, assembledToMdByte, isSuppressed };
