#!/bin/bash
# Build an app from an already-built engine; run in the Mac's logged-in session.
set -euo pipefail
if [[ $# != 2 && $# != 3 ]]; then
  echo "usage: $0 <engine> <absolute DesklinkHost.app path> [existing signing PEM]" >&2
  exit 2
fi
engine=$1 app=$2
[[ $(uname -s) == Darwin && -f $engine && $app == /* && $app == *.app ]] || { echo 'requires macOS, an engine, and an absolute .app path' >&2; exit 2; }
keychain="$HOME/Library/Keychains/login.keychain-db"
identity=$(security find-identity -v -p codesigning "$keychain" | awk '/"(Developer ID Application|Apple Development): / { print $2; exit }')
if [[ -z $identity ]]; then
  # Keep the same private key and certificate across rebuilds; never regenerate on update.
  signing_dir="$HOME/Library/Application Support/Desklink"
  mkdir -p "$signing_dir"
  chmod 700 "$signing_dir"
  pem="$signing_dir/signing.pem"
  if [[ ! -f $pem ]]; then
    if [[ $# == 3 ]]; then
      cp "$3" "$pem"
    else
      openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
        -subj '/CN=Desklink Host Local Signing' \
        -keyout "$pem" -out "$signing_dir/signing.crt"
      cat "$signing_dir/signing.crt" >> "$pem"
    fi
    chmod 600 "$pem"
  fi
  openssl x509 -in "$pem" -out "$signing_dir/signing.crt"
  fingerprint=$(openssl x509 -in "$pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
  if ! security find-identity -p codesigning "$keychain" | grep -q "$fingerprint"; then
    p12=$(mktemp "${TMPDIR:-/tmp}/desklink-sign.XXXXXX.p12")
    trap 'rm -f "$p12"' EXIT
    openssl pkcs12 -export -in "$pem" -inkey "$pem" -out "$p12" -passout pass:
    security import "$p12" -k "$keychain" -P '' -T /usr/bin/codesign || { echo 'Unlock the login keychain in the Mac GUI, then rerun; signing identity was retained.' >&2; exit 1; }
    rm -f "$p12"
    trap - EXIT
  fi
  if ! security find-identity -v -p codesigning "$keychain" | grep -q "$fingerprint"; then
    security add-trusted-cert -r trustRoot -k "$keychain" "$signing_dir/signing.crt" || { echo 'Approve the login-keychain trust dialog in the Mac GUI, then rerun.' >&2; exit 1; }
  fi
  identity=$fingerprint
fi
parent=$(dirname "$app")
mkdir -p "$parent"
stage=$(mktemp -d "$parent/.DesklinkHost.XXXXXX")
trap 'rm -rf "$stage"' EXIT
bundle="$stage/DesklinkHost.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$(dirname "$0")/../engine/Info.plist" "$bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName DesklinkHost' "$bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string desklink-host' "$bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$bundle/Contents/Info.plist"
cp "$engine" "$bundle/Contents/MacOS/desklink-host"
chmod 755 "$bundle/Contents/MacOS/desklink-host"
codesign --force --sign "$identity" "$bundle"
codesign --verify --deep --strict "$bundle"
codesign -dr - "$bundle"
if [[ -e $app ]]; then
  # Replace only this exact install path; do not change its bundle identifier or signing key.
  old="$stage/previous.app"
  mv "$app" "$old"
  if ! mv "$bundle" "$app"; then mv "$old" "$app"; exit 1; fi
else
  mv "$bundle" "$app"
fi
codesign --verify --deep --strict "$app"
echo "Installed $app; launch it from the Mac GUI, grant Screen Recording and Accessibility once."
