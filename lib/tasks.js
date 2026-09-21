'use strict';
// Repository gates as editor tasks.
//
// The list is not invented: these are the same scripts called by
// verify/ci/run_all.sh and the WP-38 workflow. A task is only offered if its
// script exists in the workspace folder — otherwise the list would lie
// about the capabilities of someone else's checkout.

const GATES = [
  { id: 'vectors', name: 'vectors: check', script: 'verify/vectors/run_vectors.py', args: [] },
  { id: 'vectors-report', name: 'vectors: report', script: 'verify/vectors/run_vectors.py', args: ['--report'] },
  { id: 'lower', name: 'lower gate (G-M1b)', script: 'verify/ci/gates/compiler/check_lower.py', args: [] },
  { id: 'differential', name: 'differential: lawc ↔ lawref', script: 'verify/ci/gates/differential/check_differential.py', args: [] },
  { id: 'kz-differential', name: 'differential: KZ corpus', script: 'verify/ci/gates/differential/check_kz_differential.py', args: [] },
  { id: 'determinism', name: 'lawref determinism', script: 'verify/ci/gates/repo/check_lawref_determinism.py', args: [] },
  { id: 'cross-canon', name: 'cross-canonicalization', script: 'verify/ci/gates/differential/cross_canon.py', args: [] },
  { id: 'kz-regression', name: 'KZ corpus regression', script: 'corpus/run_kz_regression.py', args: [] },
  { id: 'all', name: 'gates: all (verify/ci/run_all.sh)', script: 'verify/ci/run_all.sh', args: [], shell: 'sh' },
];

/**
 * @param exists (relative path) → boolean
 * @returns [{ id, name, command, args, detail }]
 */
function tasksFor(exists) {
  return GATES.filter((gate) => exists(gate.script)).map((gate) => ({
    id: gate.id,
    name: gate.name,
    command: gate.shell ?? 'python3',
    args: [gate.script, ...gate.args],
    detail: `${gate.shell ?? 'python3'} ${[gate.script, ...gate.args].join(' ')}`,
  }));
}

module.exports = { tasksFor, GATES };
