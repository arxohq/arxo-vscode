# Arxo Law

Syntax, diagnostics and compiler-backed hints for [Arxo Law](https://arxo.io) in VS Code and Cursor.

The extension has **no semantics of its own**. Highlighting is TextMate, hover text is a generated dictionary from the spec, diagnostics and layout are the compiler’s output as-is.

## What you get

- Highlighting for `.law`, cases `.lawcase`, scenarios `.lawtest`, LawQL `.lawq`, and `law` fenced blocks inside literate `.law.md`
- Hover cards with spec § references
- `lawc check` diagnostics with quick fixes
- Formatting via `lawc fmt` (needs the native CLI; see below)
- File outline, semantic tokens, inlay hints for §218 labels and parameter names
- Proof and “why not” explorer views, scene lenses, LawQL commands

The extension also activates on Markdown so law blocks inside `.law.md` are highlighted. That does not turn every Markdown file into a Law document.

## Installation

Install **Arxo Law** (`arxo.law`) from the Visual Studio Marketplace or Open VSX, then reload the window.

Identifier: `arxo.law`. Homepage: [arxo.io](https://www.arxo.io). Source and issues: [github.com/arxohq/arxo-vscode](https://github.com/arxohq/arxo-vscode).

## What runs without Rust

This package ships a WebAssembly build of the compiler (`law_wasm.wasm`, on the order of 6–7 MB). With that bundle present, the §225 palette works in the editor without a native binary:

`parse`, `check`, `layer`, `lower`, `expand`, `test`, `explain`, `why-not`, `graph`.

## What still needs `law-cli`

These commands go through the native compiler. Put `law-cli` on `PATH` or set `law.lawcPath`:

- `fmt` (including format-on-save)
- `package-root`
- `semhash`
- `eval` on a vector
- the strict `--imports` check

Settings `law.engine` (`auto` / `wasm` / `cli`) and `law.enginePath` choose how the palette is computed. The default is `auto`: wasm when the bundle is found, otherwise the binary.

## Commands that only work inside the Arxo monorepo

A few commands read files that exist only in the Arxo development tree and are silently absent elsewhere: the repository gates offered as editor tasks (`verify/ci/...`), `Law: verbalize` (needs the `lawref` oracle in the workspace) and `Law: what this change affects` (needs `corpus/`). Everything listed under "What you get" works on any folder of `.law` files.

## What this is not

- Not an LSP. Typed completion, cross-package rename and a full resolver are a separate server (`law-lsp`), not this release.
- Not a substitute for reading the act. The extension renders compiler output; it does not decide the law.

## License

Code: Apache-2.0. Hover dictionary, snippets and schema copies are derived from the specification (`spec/`), CC BY 4.0. See `LICENSE` and `NOTICE` in the package. Source: <https://github.com/arxohq/arxo-vscode>.
