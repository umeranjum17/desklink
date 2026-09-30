#!/usr/bin/env bash
# Build the unsigned macOS arm64 CLI engine on the Mac that will run it.
# Requires Rust 1.97+, Homebrew libvpx with static libvpx.a, and Node.
set -euo pipefail

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'must build on macOS arm64' >&2; exit 2; }
release="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$(dirname "$release")"
engine="$package/engine"
out="${DESKLINK_RELEASE_OUT:-$(git -C "$package" rev-parse --show-toplevel)/dist-desklink/engine-darwin-arm64}"
target=aarch64-apple-darwin
vpx="${DESKLINK_VPX_STATIC_DIR:-$(brew --prefix libvpx)}"
[[ -f "$vpx/lib/libvpx.a" ]] || { echo "missing static libvpx: $vpx/lib/libvpx.a" >&2; exit 1; }

if git -C "$package" rev-parse --show-toplevel >/dev/null 2>&1; then
  commit="${DESKLINK_SOURCE_COMMIT:-$(git -C "$package" rev-parse HEAD)}"
  dirty="${DESKLINK_SOURCE_DIRTY:-$( [[ -n "$(git -C "$package" status --porcelain)" ]] && echo true || echo false )}"
else
  : "${DESKLINK_SOURCE_COMMIT:?set DESKLINK_SOURCE_COMMIT when source has no .git}"
  : "${DESKLINK_SOURCE_DIRTY:?set DESKLINK_SOURCE_DIRTY when source has no .git}"
  commit="$DESKLINK_SOURCE_COMMIT"
  dirty="$DESKLINK_SOURCE_DIRTY"
fi

metadata="$(mktemp -t desklink-cargo-metadata)"
notices="$(mktemp -d -t desklink-notices)"
trap 'rm -f "$metadata"; rm -rf "$notices"' EXIT
cargo metadata --manifest-path "$engine/Cargo.toml" --locked --format-version 1 \
  --filter-platform "$target" > "$metadata"
DESKLINK_MACOS_CLI=1 DESKLINK_VPX_STATIC_DIR="$vpx" \
  cargo build --manifest-path "$engine/Cargo.toml" --locked --release --target "$target" --bin desklink-host

mkdir -p "$notices/libvpx" "$notices/inputtino" "$notices/nv-codec-headers" "$notices/libva"
cp "$metadata" "$notices/cargo-metadata.json"
cp "$package/LICENSE" "$notices/Apache-2.0.txt"
cp "$package/engine/vendor/inputtino/LICENSE" "$notices/inputtino/LICENSE"
cp "$package/engine/vendor/nv-codec-headers/LICENSE" "$notices/nv-codec-headers/LICENSE"
cp "$package/engine/vendor/libva/COPYING" "$notices/libva/COPYING"
cp "$vpx/LICENSE" "$notices/libvpx/LICENSE"
[[ ! -f "$vpx/PATENTS" ]] || cp "$vpx/PATENTS" "$notices/libvpx/PATENTS"
node "$release/notices.mjs" "$notices" > "$notices/THIRD_PARTY_LICENSES.txt"
cp "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" "$notices/COPYRIGHT-rust-library.html"

rm -rf "$out"
mkdir -p "$out"
bin="$out/desklink-host"
cp "${CARGO_TARGET_DIR:-$engine/target}/$target/release/desklink-host" "$bin"
chmod 755 "$bin"
version="$("$bin" version)"
sha="$(shasum -a 256 "$bin" | awk '{print $1}')"
rust="$(rustc --version)"
cp "$notices/THIRD_PARTY_LICENSES.txt" "$out/THIRD_PARTY_LICENSES.txt"
cp "$notices/COPYRIGHT-rust-library.html" "$out/COPYRIGHT-rust-library.html"
node - "$out/provenance.json" "$version" "$sha" "$commit" "$dirty" "$rust" <<'NODE'
const fs = require('node:fs');
const [, , path, engine, sha256, commit, dirty, rust] = process.argv;
fs.writeFileSync(path, `${JSON.stringify({engine, target:'aarch64-apple-darwin', sha256,
  source:{commit, dirty:dirty === 'true'}, rust, libvpx:{linkage:'static'},
  signing:'unsigned CLI'}, null, 2)}\n`);
NODE
printf 'engine  %s\nsha256  %s\n' "$bin" "$sha"
