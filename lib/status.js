'use strict';
// Status bar line: which binary is in use and what the last check showed.
//
// Not added for looks: a silent failure to launch lawc is externally
// indistinguishable from a clean file — Problems is empty in both cases.
// Before this state was visible, a failure could only be spotted from the
// file's empty structure.

/** Short form of the binary path: from the workspace folder root, otherwise the last three segments. */
function shortenBinary(binary, folder) {
  if (!binary) return null;
  if (folder && binary.startsWith(`${folder}/`)) return binary.slice(folder.length + 1);
  const parts = binary.split('/');
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : binary;
}

// Layer §1.3 in the status bar line: "L0 · calc" next to the diagnostics counter.
//
// The layer is not cosmetic. The tower separates calculation from dispute,
// climbing it is a semantic extension, and until now it was visible
// nowhere: the checker's very first finding (STATUS.md) was a calculation
// act about a defect that had silently climbed to L3 through a neighboring
// session's edit. The numbers are taken from `lawc layer --json` as-is;
// construct line numbers are 1-based (DECISION-0002), so they are shown
// without recalculation.
function layerLine(state) {
  // An explicit check, not a default value: a `null` default would not include it.
  if (!state || !state.layer) return null;
  const { layer, motto, constructs = [] } = state;
  const head = `Layer: ${layer}${motto ? ` — ${motto}` : ''}`;
  if (!constructs.length) return head;
  const raised = constructs.slice(0, 3).map((c) => {
    const line = c.span?.start?.line;
    return `  ${c.construct}${line ? ` (line ${line})` : ''} → ${c.layer}`;
  });
  const more = constructs.length > 3 ? [`  ${constructs.length - 3} more`] : [];
  return [head, 'raised by:', ...raised, ...more].join('\n');
}

/**
 * @param state { binary, folder, file, errors, warnings, checked, crashed, layer }
 * @returns { text, tooltip, severity } — severity: none | warning | error
 */
function statusOf(state = {}) {
  const {
    binary, folder, file, errors = 0, warnings = 0, checked = false, crashed = false, layer = null,
    engine = null, astFailed = null,
  } = state;
  const where = shortenBinary(binary, folder);
  // Who is responding: wasm in a worker, or the binary; build dates next to
  // it — a stale compiler twice in one day looked like "no highlighting" (E1321 on expand).
  const wasm = engine?.kind === 'wasm';
  const label = wasm ? 'law·wasm' : 'lawc';
  const engineTip = wasm
    ? `Engine: wasm in a worker (${shortenBinary(engine.module, folder) ?? 'module'}${engine.moduleBuilt ? `, built ${engine.moduleBuilt}` : ''})`
      + `${where ? `\nBinary for the rest: ${where}${engine.binaryBuilt ? ` (built ${engine.binaryBuilt})` : ''}` : ''}`
    : where ? `Compiler: ${where}${engine?.binaryBuilt ? ` (built ${engine.binaryBuilt})` : ''}` : null;

  // AST unavailable — structure, highlighting and hints are silently empty;
  // this state must be visible before the diagnostics counters.
  if (astFailed) {
    return {
      text: `$(warning) ${label}: AST unavailable`,
      tooltip: [engineTip, `Parsing the file did not return an AST: ${astFailed}`, 'Structure, semantic highlighting and declaration hints are disabled until this is fixed — details in the "Arxo Law" channel.']
        .filter(Boolean).join('\n'),
      severity: 'warning',
    };
  }
  if (!binary && !wasm) {
    return {
      text: '$(warning) lawc is not starting',
      tooltip: 'No candidate started. The list of candidates and error codes is in the "Arxo Law" channel.',
      severity: 'warning',
    };
  }
  if (crashed) {
    return {
      text: '$(error) lawc crashed',
      tooltip: `Compiler: ${where}\nThe last run ended in a panic — details in the "Arxo Law" channel.`,
      severity: 'error',
    };
  }
  const layerText = layer?.layer ? ` · ${layer.layer}` : '';
  const layerTip = layerLine(layer);
  if (!checked) {
    return {
      text: `$(tools) ${label}${layerText}`,
      tooltip: [engineTip, layerTip].filter(Boolean).join('\n'),
      severity: 'none',
    };
  }

  const icon = errors ? '$(error)' : warnings ? '$(warning)' : '$(check)';
  const counts = errors || warnings ? ` ${errors}/${warnings}` : '';
  const verdict = errors
    ? `${errors} error(s), ${warnings} warning(s)`
    : warnings ? `${warnings} warning(s)` : 'no diagnostics';
  return {
    text: `${icon} ${label}${counts}${layerText}`,
    tooltip: [engineTip, `Checked ${file ?? 'file'}: ${verdict}`, layerTip]
      .filter(Boolean).join('\n'),
    severity: errors ? 'error' : warnings ? 'warning' : 'none',
  };
}

module.exports = { statusOf, shortenBinary, layerLine };
