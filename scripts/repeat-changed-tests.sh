#!/usr/bin/env bash
# Linux-only pre-PR check: repeat the tests this branch adds or changes, half
# of them under CPU contention. See scripts/repeat-changed-tests.mjs.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/repeat-changed-tests.mjs" "$@"
