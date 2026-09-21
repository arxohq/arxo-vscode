'use strict';
// Test Explorer for `.lawtest`: a file is a suite, a scene `test "…" {` is a
// test. The run is the same `lawc test <file> --program <program> --json`
// as the law.runTest command; here there is only the run plan and the
// layout of the §267 report over scenes. No semantics: verdicts come from
// the runner, the extension just displays them.
//
// Program §169 (`--program`): the file's neighbors by rule lawtest.programFor
// (source.law → the single *.law → ir.json), and for scenes in a package's
// `tests/` — the package itself (the directory with law.toml above
// `tests/`). Packages with `[expansions]` are not accepted by the runner
// (`lawc test` has no pin context) — the refusal arrives as text.

const fs = require('node:fs');
const path = require('node:path');
const { programFor } = require('./lawtest');
const { scenesOf } = require('./scenes');

/** Program for a scene file: a path, or null with a reason. */
function programForTest(file) {
  const dir = path.dirname(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { program: null, reason: 'directory unavailable' }; }
  const sibling = programFor(names.filter((n) => n !== path.basename(file)));
  if (sibling) return { program: path.join(dir, sibling), reason: null };
  // tests/ inside a package §22: the program is the package as a whole.
  const parent = path.dirname(dir);
  if (path.basename(dir) === 'tests' && fs.existsSync(path.join(parent, 'law.toml'))) return { program: parent, reason: null };
  if (fs.existsSync(path.join(dir, 'law.toml'))) return { program: dir, reason: null };
  return { program: null, reason: 'no §169 program nearby: source.law, a single *.law, ir.json, or a package with law.toml' };
}

/** File scenes as tree items: { id, label, line }. */
function sceneItems(file, text) {
  return scenesOf(text).map((scene) => ({ id: `${file}#${scene.title}`, label: scene.title, line: scene.line }));
}

/**
 * Layout of the runner's report (lawtest.parseVerdictsJson) over the file's
 * scenes: [{ id, status: 'passed'|'failed'|'errored'|'skipped', messages }].
 * A runner refusal is errored for all scenes, with its text; a scene with
 * no entry in the report is skipped (the runner didn't see it, and staying
 * silent about that is not allowed).
 */
function applyReport(report, items) {
  if (!report) return items.map((item) => ({ id: item.id, status: 'errored', messages: ['the runner report could not be parsed'] }));
  if (report.refusal) return items.map((item) => ({ id: item.id, status: 'errored', messages: [`runner refused: ${report.refusal}`] }));
  const byTitle = new Map(report.tests.map((t) => [t.title, t]));
  return items.map((item) => {
    const entry = byTitle.get(item.label);
    if (!entry) return { id: item.id, status: 'skipped', messages: ['scene is not in the runner report'] };
    return {
      id: item.id,
      status: entry.passed ? 'passed' : 'failed',
      messages: entry.failures.map((f) => f.message),
    };
  });
}

/** Scene files → runs: one per file, even if individual scenes were selected. */
function plan(requested) {
  const byFile = new Map();
  for (const item of requested) {
    const [file] = item.id.split('#');
    if (!byFile.has(file)) byFile.set(file, []);
    if (item.id.includes('#')) byFile.get(file).push(item.id);
  }
  return [...byFile.entries()].map(([file, only]) => ({ file, only }));
}

module.exports = { programForTest, sceneItems, applyReport, plan };
