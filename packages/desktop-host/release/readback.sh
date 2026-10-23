# Read-back helpers shared by the release workflow and this package's manual
# route. npm states a freshly published version "may take a few minutes to
# become available", so a dependent waits that window before treating a version
# as missing; a genuinely missing version still fails in bounded time. In the
# 0.5.10 release the registry recorded the linux-x64-gnu engine 7m20s after its
# publish returned, and the packument is then CDN-cached for up to 300s, so the
# budget (30 minutes) is well past that ~12.5-minute worst case.
#
# The budget lives in readback-budget.json, the single source this file and
# readback.mjs both read, so the workflow and release/publish.mjs cannot drift.
# Sourced, not executed: it defines functions for the caller's publish step.

_readback_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
_readback_budget="${_readback_dir}/readback-budget.json"
READBACK_ATTEMPTS="$(node -e 'process.stdout.write(String(require(process.argv[1]).attempts))' "$_readback_budget")"
READBACK_INTERVAL_SECONDS="$(node -e 'process.stdout.write(String(require(process.argv[1]).intervalSeconds))' "$_readback_budget")"
readonly READBACK_ATTEMPTS READBACK_INTERVAL_SECONDS

# Print published | missing | error for a spec such as @desklink/host@0.5.4.
# Only E404 counts as missing; any other failure is an error the caller must
# never mistake for a version that is not on the registry.
registry_state() {
    local out
    if out="$(npm view "$1" version 2>&1)"; then
        echo published
    elif grep -q E404 <<<"$out"; then
        echo missing
    else
        echo "::error::npm registry check for $1 failed (registry, auth or network), not a missing version:" >&2
        echo "$out" >&2
        echo error
    fi
}

# Wait up to the shared budget for a just-published spec to be served. Returns 0
# once it is published, 1 if the last check answered E404 (still absent) at the
# bound, and 2 if the last check failed (registry, auth or network) - an error
# the caller reports as such, never as a version that is not on the registry.
wait_published() {
    local attempt state
    for attempt in $(seq 1 "$READBACK_ATTEMPTS"); do
        state="$(registry_state "$1")"
        [ "$state" = published ] && return 0
        [ "$attempt" -eq "$READBACK_ATTEMPTS" ] || sleep "$READBACK_INTERVAL_SECONDS"
    done
    [ "$state" = missing ] && return 1
    return 2
}
