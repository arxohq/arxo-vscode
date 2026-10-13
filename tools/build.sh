#!/usr/bin/env bash
# Build the .vsix from this repository alone: the compiler bundle comes from
# the published npm package @arxo/law-engine (version pinned in engine.lock.json).
#
# Usage: tools/build.sh [output-directory]
# Requires Node >= 22 and network access for npm.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-$root}"
mkdir -p "$out_dir"
version="$(node -p "require('$root/package.json').version")"
name="$(node -p "require('$root/package.json').name")"
engine_version="$(node -p "require('$root/engine.lock.json').version")"

(cd "$root" && npm ci --ignore-scripts)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$work" && npm pack "@arxo/law-engine@$engine_version" --quiet >/dev/null && tar xzf ./*.tgz)
dist="$work/package/dist"

rm -rf "$root/engine"
mkdir -p "$root/engine"
for runtime in index.js worker.js worker-runtime.js host-error.js composition.js law_wasm.wasm; do
  cp "$dist/$runtime" "$root/engine/"
done
printf '%s\n' '{"type":"module"}' > "$root/engine/package.json"
node - "$root/engine" "$engine_version" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [directory, engineVersion] = process.argv.slice(2);
const bytes = fs.readFileSync(path.join(directory, 'law_wasm.wasm'));
const manifest = { package: 'arxo.law', engine: `@arxo/law-engine@${engineVersion}`,
  wasmBytes: bytes.length,
  wasmSha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` };
fs.writeFileSync(path.join(directory, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
JS

(cd "$root" && npx --yes @vscode/vsce@3.9.2 package --out "$out_dir/$name-$version.vsix")
echo "$out_dir/$name-$version.vsix"
