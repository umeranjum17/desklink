#!/usr/bin/env bash
# Proof for the Wayland portal keyboard: a mock RemoteDesktop portal on a private
# dbus-daemon (own bus, nothing on the user's session) receives the engine's keys
# in order, no /dev/uinput fd is open, and capabilities choose uinput where it
# works and the portal keyboard only where it does not. Writes stills and
# steps.json into the folder it is given (default $DONE_DONE_EVIDENCE_ROOT).
set -euo pipefail
out=${1:-${DONE_DONE_EVIDENCE_ROOT:?evidence folder}}
root=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$out"
scratch=$(mktemp -d "$HOME/.cache/desklink-portal-keys.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/.cache/desklink-portal-keys-target} TMPDIR=$scratch
cd "$root/packages/desktop-host/engine"

cargo test --offline input_portal -- --nocapture 2>&1 | grep -E '^(test |capabilities input|test result)' > "$out/test.log"
grep -q 'test .* ok$' "$out/test.log"

{
  echo '$ cargo test input_portal   (mock RemoteDesktop portal, private dbus-daemon)'
  grep -E '^test [a-z_:]+ \.\.\.' "$out/test.log" | sed 's/^test input_portal::tests::/test /' | sort -u
  echo 'asserted: keys 35,35,30,30 reached the portal in order; session closed on drop;'
  echo 'asserted: no /dev/uinput file descriptor open while the portal carried the keys'
} > "$scratch/run.txt"

line() { python3 -c "import json,sys; i=json.loads(sys.argv[1]); print('mechanism=%-22s pointer=%-5s wheel=%-5s keyboard=%-5s grant=%s' % (i['mechanism'], i['pointer'], i['wheel'], i['keyboard'], i['grant']))" "$1"; }
{
  echo 'capabilities input (portal offers a keyboard in both rows)'
  echo '1. uinput works  : '"$(line "$(grep '^capabilities' "$out/test.log" | sed -n 2p | cut -d' ' -f3-)")"
  echo '2. uinput missing: '"$(line "$(grep '^capabilities' "$out/test.log" | sed -n 3p | cut -d' ' -f3-)")"
  printf '%s\n' '   (no portal at all, real binary, private bus:)'
  cat > "$scratch/bus.conf" <<'CONF'
<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
CONF
  caps=$(dbus-run-session --config-file="$scratch/bus.conf" -- env -u WAYLAND_DISPLAY -u DISPLAY "$CARGO_TARGET_DIR/debug/desklink-host" capabilities 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["input"]))')
  echo '3. real binary   : '"$(line "$caps")"
} > "$scratch/caps.txt"

font=$(fc-match -f '%{file}' monospace)
for name in run caps; do
  magick -background '#1e1e1e' -fill '#e6e6e6' -font "$font" -pointsize 18 "label:@$scratch/$name.txt" \
    -bordercolor '#1e1e1e' -border 24 "$out/$([ $name = run ] && echo test-run || echo capability-lines).png"
done

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
python3 - "$out/steps.json" "$version" <<'PY'
import json, sys
json.dump({
  "target": {"version": sys.argv[2]},
  "start": "a Wayland session whose portal offers a RemoteDesktop keyboard, on a private bus",
  "steps": [
    "the engine opens a keyboard-only RemoteDesktop portal session",
    "the client's keys 35, 35, 30, 30 are sent through the engine",
    "the mock portal receives them in order and the session closes on drop",
    "capabilities report uinput when it works and the portal keyboard only when it does not",
  ],
  "result": "keys reach the portal with no uinput device open; pointer and wheel stay on uinput where it exists",
}, open(sys.argv[1], "w"), indent=1)
PY
