#!/bin/bash
# Refresh a task-owned, already-granted macOS dev app; never run while it is open.
set -euo pipefail
if [[ $# != 4 ]]; then echo "usage: $0 <app> <engine> <signing.pem> <rcodesign>" >&2; exit 2; fi
app=$1 engine=$2 pem=$3 signer=$4
binary="$app/Contents/MacOS/desklink-host"
for file in "$binary" "$engine" "$pem" "$signer"; do [[ -f "$file" ]] || { echo "missing: $file" >&2; exit 1; }; done
identity=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist")
[[ -n "$identity" ]] || { echo 'missing bundle identity' >&2; exit 1; }
backup=$(mktemp "${TMPDIR:-/tmp}/desklink-host.XXXXXX")
cp "$binary" "$backup"
restore() {
  if [[ -f "$backup" ]]; then
    cp "$backup" "$binary"
    "$signer" sign --pem-file "$pem" --binary-identifier "$identity" --timestamp-url none "$app" >&2 || true
    rm -f "$backup"
  fi
}
trap restore EXIT
cp "$engine" "$binary"
"$signer" sign --pem-file "$pem" --binary-identifier "$identity" --timestamp-url none "$app"
codesign --verify --deep --strict "$app"
rm -f "$backup"
trap - EXIT
echo "refreshed signed $identity; launch app and verify capture/input grants"
