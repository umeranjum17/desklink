#!/usr/bin/env bash
# Dex the multi-pointer touch injector so `uiautomator runtest` can drive real
# MotionEvents on a device. Sources: the uiautomator injector first written for
# the phone proof (fm/dl-j2-android-proof), unchanged except for the
# hold-before-move a drag needs; the stub classes stand in for the framework's
# own package-private ones, which is why the injector runs as
# com.android.uiautomator.core.Touch and takes the real one at runtime.
#
# Usage: build.sh <out.jar>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(readlink -f "${1:?usage: build.sh <out.jar>}")
work=$(dirname "$out")/inject-build
framework=${DESKLINK_UIAUTOMATOR_JAR:-${ANDROID_HOME:-$HOME/Android/Sdk}/platforms/android-36/android.jar}
rm -rf "$work"
mkdir -p "$work/classes" "$work/dex"
javac -nowarn -source 8 -target 8 -bootclasspath "$framework" -d "$work/classes" \
    $(find "$here/src" -name '*.java')
d8=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/d8 | sort -V | tail -1)
# The test class is dexed, plus the one annotation a current device image no
# longer ships (see its javadoc); the stub classes exist for javac alone, and
# the device's own /system/framework/uiautomator.jar supplies the framework
# classes at run time, jar first, or its real ones are shadowed.
"$d8" --min-api 26 --output "$work/dex" \
    "$work/classes/com/android/uiautomator/core/Touch.class" \
    "$work/classes/android/test/RepetitiveTest.class"
(cd "$work/dex" && jar cf "$out" classes.dex)
echo "$out"
