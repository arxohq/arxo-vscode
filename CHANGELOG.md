# Changelog

Notable changes to the Arxo Law VS Code / Cursor extension (`arxo.law`).

The extension is versioned independently of Law DSL Core and of the `@arxo/law-*`
npm packages: `0.1` in a version of the *language* is not a version of this
extension.

## Unreleased

## 0.1.3 — 2026-10-09

### Fixed

- Discover the public `law` CLI and route native compiler commands through
  `law engine`, while retaining direct `law-cli` support.
- Refresh the packaged CLIR/vector schemas and English hover coverage.
- Export the extension dependency lockfile and pin the public VSIX packager,
  so a source-mirror build includes the language-client runtime.
- Refresh the grammar and generated hover dictionary against the current
  specification, including `subject`, normative effect forms and §11.1.
- Bundle every JavaScript module needed by the current WASM SDK and declare
  its ESM boundary, so the compiler worker starts from an installed VSIX.
- Prefer the installed compiler bundle over a repository's older build;
  `law.enginePath` still selects an explicit development runtime.
- Declare VS Code 1.82 or newer, matching the language client's requirement.
- Vector comparison honors `artifacts.files.expected` and reports evaluator
  refusals without opening a misleading comparison against the golden.
- Editor integration fixtures run temporary copies under the compiler's
  current exact semantic release; historical vectors and goldens stay intact.

### Added

- The package manifest `law.toml` is a language of the extension
  (`law-manifest`): its own TOML grammar, so highlighting no longer depends
  on a third-party TOML extension, and `law-lsp` on top of it — semantic
  tokens for known sections, keys, package names and closed vocabularies;
  diagnostics at the written place (unknown section or key, a value outside
  the schema's vocabulary, a scenario or case file that does not exist, a
  `.lawtest` no `[tests]` names, a dependency or world package the lock does
  not pin, `[package]` diverging from the §22 headers — LDC-E1109 from the
  manifest's side); F12 from a suite, a case path, an expansion path, a world
  package, a dependency and the package name; completion of sections, keys,
  vocabulary values, world packages and scenario files not named yet; hover
  with the schema's description; sections in the outline.
- Author-help layer for hovers: twenty dictionary words now print a generated
  SPEC card (relation, rule, when, then, strict, defeasible, defeater, key
  with role variants, plus package, import, namespace, entity, event,
  function, type, expansion, facts, query) instead of the flat SPEC excerpt —
  identically in the extension and in `law-lsp`. A declaration hover carries
  its kind's card meaning after the detail line, and completion items carry
  the same card as documentation.
- Signature help (`law-lsp` only, triggers `(` and `,`): the innermost call
  answers with its signature, the active parameter follows the cursor
  (including unfinished calls), and parameters document their §218 labels.

- The aggregate form `only(collect …)` (functional lookup, SPEC §51, errata
  E-0257): colored as a standard-library call only over a comprehension (a
  package function named `only` stays an ordinary call), offered in
  completion as a function with a `only(collect v: T where condition)`
  snippet, and explained on hover with the §51 card — in the extension's own
  providers and in `law-lsp` alike.

### Changed

- The Marketplace and Open VSX page shows the editor at work: pictures of
  diagnostics, the `@source` hover, completion, signature help and inlays,
  rendered from a real `law-lsp` session, plus
  install steps for `law-lsp` and the full settings table.

### Fixed

- `law-lsp` hover on a standard-library call answered nothing: the call has
  no package declaration. It now shows the SPEC dictionary card, the same one
  the extension shows for that word.

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
