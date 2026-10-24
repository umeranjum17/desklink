#!/usr/bin/env bash
set -euo pipefail
: "${DONE_DONE_EVIDENCE_ROOT:?run through done-done run -- bash packages/desktop-host/test/prove-versions.sh}"
exec env -u DISPLAY -u WAYLAND_DISPLAY node packages/desktop-host/test/versions-flow.mjs "$DONE_DONE_EVIDENCE_ROOT/versions"
