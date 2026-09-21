# Changelog

Notable changes to the Arxo Law VS Code / Cursor extension (`arxo.law`).

The extension is versioned independently of Law DSL Core and of the `@arxo/law-*`
npm packages: `0.1` in a version of the *language* is not a version of this
extension.

## 0.1.1 — 2026-09-21

Same code as 0.1.0. This release exists because the stores do not let a
published version change its manifest.

### Changed

- Source is public: <https://github.com/arxohq/arxo-vscode> (`repository`
  and `bugs` in the manifest; the store pages now link to the code and the
  issue tracker).
- The stores get the same `.vsix` that is attached to the GitHub release,
  with the SHA-256 of the bundled `law_wasm.wasm` in `engine/build-manifest.json`.

## 0.1.0 — 2026-09-19

First public release. Marketplace listing name: **Arxo Law**
(identifier `arxo.law`).

### Added

- Syntax highlighting for `.law`, `.lawtest`, `.lawcase`, literate `.law.md`
  blocks and LawQL `.lawq`.
- Hover cards with spec § references, compiler diagnostics with quick fixes,
  formatting via `lawc fmt`, file outline, semantic tokens, inlay hints (§218
  labels and parameter names).
- Proof and “why not” explorer views, scene lenses, LawQL query commands.
- Bundled WebAssembly compiler (`law_wasm.wasm`) for the §225 palette so
  parse/check/layer/lower/expand/test/explain/why-not/graph work without a
  native `law-cli` on the machine.

### Limits of this release

- `fmt`, `package-root`, `semhash`, vector `eval` and the strict `--imports`
  check still require `law-cli` on PATH or `law.lawcPath`.
- The extension has no semantics of its own and is not an LSP.
