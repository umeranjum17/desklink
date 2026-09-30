#!/usr/bin/env bash
# Check the current platform's packed installation without capture or input.
# For platform-specific checks and release sequencing, see ../README.md,
# "Building and packing a release".
#
#   release/check-install.sh
#
# Reads the current platform's host and engine tarballs from dist-desklink/ at the
# repository root.
set -euo pipefail
if [ "$#" -ne 0 ]; then echo 'usage: release/check-install.sh' >&2; exit 2; fi

release="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$release" rev-parse --show-toplevel)"
tarballs="$root/dist-desklink"
version="$(node -p 'require(process.argv[1]).version' "$root/packages/desktop-host/package.json")"
if [[ "$(uname -s)" == Darwin ]]; then
    [[ "$(uname -m)" == arm64 ]] || { echo 'macOS install check requires arm64' >&2; exit 2; }
    for tarball in "desklink-host-$version.tgz" "desklink-host-darwin-arm64-$version.tgz"; do
        [[ -f "$tarballs/$tarball" ]] || { echo "missing release tarball: $tarballs/$tarball" >&2; exit 1; }
    done
    project="$(mktemp -d -t desklink-install)"
    trap 'rm -rf "$project"' EXIT
    cd "$project"
    npm init -y >/dev/null
    npm install --ignore-scripts --no-audit --no-fund "$tarballs/desklink-host-$version.tgz" "$tarballs/desklink-host-darwin-arm64-$version.tgz"
    env -u DESKLINK_ENGINE -u MUXR_DESKLINK_ENGINE -u DESKLINK_MACOS node --input-type=module - "$version" <<'NODE'
import { createRequire } from 'node:module';
import { EngineClient, resolveEngine } from '@desklink/host';
const require = createRequire(import.meta.url);
for (const name of ['@desklink/host', '@desklink/host-darwin-arm64']) {
    if (require(`${name}/package.json`).version !== process.argv[2]) throw new Error(`wrong version: ${name}`);
}
const engine = resolveEngine();
if (engine?.origin !== 'prebuilt') throw new Error(`no prebuilt engine: ${JSON.stringify(engine)}`);
const client = await EngineClient.start(engine.command, engine.args);
try {
    // Non-prompting: no session.open, capture, input or TCC changes.
    console.log(JSON.stringify({ resolved: engine, capabilities: await client.capabilities() }, null, 2));
} finally {
    await client.stop();
}
NODE
    exit 0
fi

for tarball in "desklink-host-$version.tgz" "desklink-host-linux-x64-gnu-$version.tgz"; do
    if [ ! -f "$tarballs/$tarball" ]; then echo "missing release tarball: $tarballs/$tarball" >&2; exit 1; fi
done
image=node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

docker run --rm --platform linux/amd64 --volume "$tarballs:/tarballs:ro" "$image" bash -euo pipefail -c '
    if command -v cargo || command -v rustc; then echo "a Rust toolchain is on PATH" >&2; exit 1; fi

    mkdir /project && cd /project
    npm init -y >/dev/null
    npm install --ignore-scripts --no-audit --no-fund "/tarballs/desklink-host-$1.tgz" "/tarballs/desklink-host-linux-x64-gnu-$1.tgz"
    node -e "
        const { version: host } = require(\"@desklink/host/package.json\");
        const { version: platform } = require(\"@desklink/host-linux-x64-gnu/package.json\");
        if (host !== process.argv[1] || platform !== process.argv[1]) {
            throw new Error(\"installed desktop packages do not match release \" + process.argv[1] + \": \" + host + \", \" + platform);
        }
    " "$1"
    ls -l node_modules/@desklink/host-linux-x64-gnu/desklink-host
    npx desklink-host path

    node --input-type=module -e "
        import { EngineClient, EngineRefused, resolveEngine } from \"@desklink/host\";
        const engine = resolveEngine();
        if (engine?.origin !== \"prebuilt\") throw new Error(\"no prebuilt engine resolved: \" + JSON.stringify(engine));
        try {
            const client = await EngineClient.start(engine.command, engine.args);
            await client.stop();
            throw new Error(\"engine started without system runtime libraries\");
        } catch (error) {
            if (!(error instanceof EngineRefused) || error.code !== \"missing-system-library\" ||
                ![\"libpipewire-0.3.so.0\", \"libxkbcommon.so.0\", \"libevdev.so.2\", \"libstdc++.so.6\", \"libXcursor.so.1\", \"libX11.so.6\", \"libwayland-client.so.0\"].some(
                    (name) => error.message === \"missing system library: \" + name)) throw error;
            console.log(error.message);
        }
    "

    apt-get update -qq
    apt-get install -y -qq --no-install-recommends libpipewire-0.3-0 libxkbcommon0 libevdev2 libstdc++6 libxcursor1 libx11-6 libwayland-client0 >/dev/null

    node --input-type=module -e "
        import { EngineClient, resolveEngine } from \"@desklink/host\";
        const engine = resolveEngine();
        if (engine?.origin !== \"prebuilt\") throw new Error(\"no prebuilt engine resolved: \" + JSON.stringify(engine));
        const client = await EngineClient.start(engine.command, engine.args, { onDiagnostic: (line) => console.error(line) });
        const capabilities = await client.capabilities();
        await client.stop();
        console.log(JSON.stringify({ resolved: engine, capabilities }, null, 2));
    "
' bash "$version"
