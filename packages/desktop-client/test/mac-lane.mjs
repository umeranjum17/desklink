/**
 * Where a Mac lane builds, and how it cleans up.
 *
 * Every Mac lane shares one directory under the Mac's home (`~/fm-desklink-ios`)
 * so the disk stays usable for other projects, but a lane's build products live
 * in its own subdirectory named for the task. That is what keeps one lane's
 * end-of-lane cleanup from deleting another lane's half-finished build: the
 * only thing a lane may delete is the directory it created, and
 * {@link CLEAN_SCRIPT} refuses anything else - the shared root, a sibling
 * lane's directory, or a path outside the root - instead of guessing.
 *
 * Shared on purpose, under the root rather than inside a lane:
 *   .npm, .cocoapods, .cocoapods-cache  package caches, written concurrently,
 *                                        never deleted by a lane's cleanup
 * Everything a lane builds (node_modules, Pods, DerivedData, its rsync copy of
 * this checkout, its TMPDIR) is inside the lane's own directory.
 */
import assert from 'node:assert/strict';

/** The shared Mac lab directory; the base every lane's subdirectory lives in. */
export function macLane(env = process.env) {
    const base = env.DESKLINK_IOS_DIR ?? 'fm-desklink-ios';
    const lane = env.DESKLINK_IOS_LANE ?? '';
    assert.match(base, /^[\w.-]+(\/[\w.-]+)*$/, 'DESKLINK_IOS_DIR is a plain path under the Mac home');
    assert.match(lane, /^[\w][\w.-]*$/,
        'DESKLINK_IOS_LANE must name this lane (letters, digits, . _ -): one lane, one subdirectory of DESKLINK_IOS_DIR');
    assert.notEqual(lane, '.', 'DESKLINK_IOS_LANE must not be the shared root');
    return { base, lane, dir: `${base}/${lane}` };
}

/**
 * Remove the lane's own directory, and nothing else. `$R` is the shared root
 * and `$D` the lane directory, both as the flow's Mac prelude sets them.
 * Deleting the shared root or a sibling lane's directory exits non-zero rather
 * than reclaiming space, so a mistake costs disk instead of another lane's work.
 */
export const CLEAN_SCRIPT = `test -n "$R" && test -n "$D" || { echo "mac-lane: no lane directory to clean" >&2; exit 1; }
case "$D" in
    "$R"/*) ;;
    *) echo "mac-lane: refusing to clean $D, which is not inside $R" >&2; exit 1 ;;
esac
test "$D" != "$R" || { echo "mac-lane: refusing to clean the shared root $R" >&2; exit 1; }
rm -rf -- "$D"
echo "mac-lane: cleaned $D"`;