# Contributing

This repository is a **published mirror** of the extension source. The code is
developed in the Arxo monorepo and exported here at every release, without the
monorepo history: each commit on `main` is one release, tagged `v<version>`.

- Bug reports and feature requests: [issues](https://github.com/arxohq/arxo-vscode/issues).
- Pull requests are welcome as proposals. A merged change is carried back into
  the monorepo by the maintainers and appears here with the next export, so the
  commit on `main` will not be yours byte for byte.

## Building

```sh
tools/build.sh
```

Use Node.js 22 or newer. The script installs the locked extension dependencies,
takes the compiler bundle (`law_wasm.wasm` and its bindings) from the
npm package `@arxo/law-engine` at the version pinned in `engine.lock.json` and
packages the `.vsix` with `@vscode/vsce` 3.9.2. The `.vsix` attached to a GitHub
release and uploaded to the stores uses the selected release compiler bundle;
`engine/build-manifest.json` inside any `.vsix` names the
SHA-256 of the bundled module, so the two can be compared.

## Generated files

`data/hover.json`, `data/std.json`, `snippets/*.code-snippets` and
`schemas/*.schema.json` are generated from the Law DSL specification and the
standard library (CC BY 4.0, see `NOTICE`). Edit the generators, not these
files; a pull request that changes them by hand will be regenerated.

## Testing

The full test suite runs in the monorepo against a built compiler and is not
exported. CI here checks that every file parses and that the `.vsix` packages.
