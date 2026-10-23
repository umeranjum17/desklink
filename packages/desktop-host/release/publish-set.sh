#!/usr/bin/env bash
# Publish one release set from the tarballs the pack job wrote, for the
# release workflow's publish job:
#
#   packages/desktop-host/release/publish-set.sh dist-desklink
#
# The set is every engine platform package the packed host pins, then
# @desklink/host, then @desklink/axi (which pins the host), then
# @desklink/react-native, in that order. Before anything is uploaded, every
# tarball must be present and hold the version it should, and the registry must
# answer for each one; otherwise nothing is published. After each publish the
# next package waits for the registry to serve it (readback.sh), and the first
# failure stops the run, so a failed run only ever leaves a prefix of that order
# published and a re-run of the job picks up where it stopped.

set -uo pipefail

release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "$release_dir/../../.." && pwd)"
# An absolute path keeps npm reading each tarball argument as the local file it
# is: a bare "dist-desklink/x.tgz" is parsed as the git shorthand "user/repo"
# and fails on ssh auth instead of publishing.
dist="$(cd -- "${1:?usage: publish-set.sh <directory holding the packed tarballs>}" && pwd)" || {
    echo "::error::$1 is not a directory of packed tarballs; nothing was published. Re-run the workflow."
    exit 1
}
# shellcheck source=SCRIPTDIR/readback.sh
source "$release_dir/readback.sh"

# Print a JS expression over a tarball's package.json `m`.
manifest() {
    tar -xzOf "$1" package/package.json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const m=JSON.parse(s);process.stdout.write(String(new Function("m","return "+process.argv[1])(m)))})' "$2"
}
version_of() { node -p "require(process.argv[1]).version" "$root/packages/$1/package.json"; }

HOST_VER="$(version_of desktop-host)"
AXI_VER="$(version_of axi)"
RN_VER="$(version_of desktop-client)"
host_tgz="$dist/desklink-host-$HOST_VER.tgz"
if [ ! -f "$host_tgz" ]; then
    echo "::error::$host_tgz is missing from the pack job; nothing was published. Re-run the workflow."
    exit 1
fi

specs=()
tarballs=()
while IFS=$'\t' read -r name version; do
    [ -n "$name" ] || continue
    mangled="${name#@}"
    specs+=("$name@$version")
    tarballs+=("$dist/${mangled//\//-}-$version.tgz")
done < <(manifest "$host_tgz" 'Object.entries(m.optionalDependencies ?? {}).map(([n, v]) => n + "\t" + v + "\n").join("")')
if [ "${#specs[@]}" -eq 0 ]; then
    echo "::error::$host_tgz pins no engine platform package, so it was not packed by release/pack.mjs; nothing was published. Re-run the workflow."
    exit 1
fi
specs+=("@desklink/host@$HOST_VER" "@desklink/axi@$AXI_VER" "@desklink/react-native@$RN_VER")
tarballs+=("$host_tgz" "$dist/desklink-axi-$AXI_VER.tgz" "$dist/desklink-react-native-$RN_VER.tgz")

# Refuse a set that cannot all be published before uploading any package of it.
states=()
refused=0
for i in "${!specs[@]}"; do
    spec="${specs[$i]}"
    tarball="${tarballs[$i]}"
    if [ ! -f "$tarball" ]; then
        echo "::error::$tarball ($spec) was not produced by the pack job."
        refused=1
        continue
    fi
    held="$(manifest "$tarball" 'm.name + "@" + m.version')"
    if [ "$held" != "$spec" ]; then
        echo "::error::$tarball holds $held, not $spec."
        refused=1
        continue
    fi
    states[i]="$(registry_state "$spec")"
    [ "${states[$i]}" != error ] || refused=1
done
if [ "$refused" -ne 0 ]; then
    echo "::error::Nothing was published: the set ${specs[*]} cannot all be published (see the errors above). Fix them, then re-run the workflow."
    exit 1
fi

budget="$((READBACK_ATTEMPTS * READBACK_INTERVAL_SECONDS / 60)) minutes"
listed() { if [ "$#" -gt 0 ]; then echo "$*"; else echo none; fi; }
for i in "${!specs[@]}"; do
    spec="${specs[$i]}"
    reason=""
    if [ "${states[$i]}" = published ]; then
        echo "$spec is already on the registry; skipping publish."
    else
        echo "Publishing $spec ..."
        npm publish "${tarballs[$i]}" --provenance --access public || reason="npm publish failed"
    fi
    # The next package may pin this exact version, so it goes out only once the
    # registry serves this one; the last wait confirms the whole set is served.
    if [ -z "$reason" ]; then
        rc=0
        wait_published "$spec" || rc=$?
        case "$rc" in
            0) ;;
            1) reason="was published but the registry still does not serve it after $budget" ;;
            *) reason="was published but the registry check failed (registry, auth or network), so whether it is served is unknown" ;;
        esac
    fi
    if [ -n "$reason" ]; then
        echo "::error::$spec: $reason. Served before it: $(listed "${specs[@]:0:i}"). Not attempted: $(listed "${specs[@]:i+1}"). Fix the cause, then re-run this job; versions already on the registry are skipped."
        exit 1
    fi
done
echo "Published and served: ${specs[*]}."
