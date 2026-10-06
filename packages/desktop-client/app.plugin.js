/**
 * Opt-in config plugin: an iPad trackpad's or mouse's presses reach the
 * desktop with the button that made them — a drag selects, a secondary click
 * is a right click. It sets `UIApplicationSupportsIndirectInputEvents`, which
 * changes how every screen of the app receives that input, so the package
 * never sets it on its own. Hover, scroll and the hardware keyboard work
 * without it.
 *
 *   "plugins": ["@desklink/react-native"]
 *
 * The plugin also repairs `expo-modules-jsi` 57.x for Xcode 26 (Swift 6.2).
 * Two defects, both fatal, both fixed upstream in expo-modules-jsi 58 (SDK 58
 * is out of scope and the 57 line has no fixed patch release):
 *
 * 1. `RuntimeScheduler.h` annotates two C++ constructors with
 *    `SWIFT_RETURNS_RETAINED`, which Swift 6.2 rejects as a hard error
 *    ("not returning a SWIFT_SHARED_REFERENCE type"), so no 57-line app
 *    compiles. Mirrored from 58: private constructors plus static `create`
 *    factories carrying the annotation, with the Swift call sites moved over.
 * 2. `JavaScriptRuntime.swift` captures raw JSI pointers through
 *    `nonisolated(unsafe)` locals into `JavaScriptActor.assumeIsolated`
 *    closures, which Swift 6.2 rejects ("sending ... risks causing data
 *    races") now that `assumeIsolated` takes a `sending` closure. Mirrored
 *    from 58: an `UncheckedSendable` box plus `.value` at the use sites.
 *
 * Applied to the installed package at prebuild time, before `pod install`
 * compiles it. Scoped to the 57 line: other versions skip untouched.
 */
const fs = require('fs');
const path = require('path');

const JSI_HEADER = 'apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h';
const JSI_SWIFT = 'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntime.swift';
const JSI_BOX = 'apple/Sources/ExpoModulesJSI/Utilities/UncheckedSendable.swift';

// The exact 57.x constructor block: constructors carrying the annotation that
// Swift 6.2 rejects. (\u2014 is the em dash in the original comment.)
const BROKEN_CONSTRUCTORS = `public:
  /**
   Constructs a scheduler bound to a host-provided native RuntimeScheduler.
   \`scheduleTask\` dispatches through \`fn\`, which the host implements against
   the real react::RuntimeScheduler.
   */
  SWIFT_RETURNS_RETAINED RuntimeScheduler(void *scheduler, ScheduleFn fn) noexcept
      : nativeScheduler(scheduler), scheduleFn(fn) {}

  /**
   Constructs a no-op scheduler. Scheduled tasks run synchronously on the
   caller's thread \u2014 intended for standalone runtimes (e.g. tests) that have
   no React scheduler.
   */
  SWIFT_RETURNS_RETAINED RuntimeScheduler() {}`;

// The 58-shaped replacement: unannotated private constructors plus annotated
// static factories, which every Swift version accepts.
const FIXED_CONSTRUCTORS = `  RuntimeScheduler(void *scheduler, ScheduleFn fn) noexcept
      : nativeScheduler(scheduler), scheduleFn(fn) {}

  RuntimeScheduler() noexcept {}

public:
  // Swift creates instances through the static \`create\` functions below, not
  // the constructors: \`SWIFT_RETURNS_RETAINED\` on a constructor is a hard
  // error on Swift 6.2 (Xcode 26), while a static function returning the shared
  // reference accepts the annotation on every Swift version. This mirrors the
  // fix Expo ships in expo-modules-jsi 58; the 57 line has no such release.

  /**
   Creates a scheduler bound to a host-provided native RuntimeScheduler.
   \`scheduleTask\` dispatches through \`fn\`, which the host implements against
   the real react::RuntimeScheduler.
   */
  static RuntimeScheduler *create(void *scheduler, ScheduleFn fn) noexcept SWIFT_RETURNS_RETAINED {
    return new RuntimeScheduler(scheduler, fn);
  }

  /**
   Creates a no-op scheduler. Scheduled tasks run synchronously on the
   caller's thread \u2014 intended for standalone runtimes (e.g. tests) that have
   no React scheduler.
   */
  static RuntimeScheduler *create() noexcept SWIFT_RETURNS_RETAINED {
    return new RuntimeScheduler();
  }`;

// Verbatim from expo-modules-jsi 58's Utilities/UncheckedSendable.swift: an
// allocation-free `@unchecked Sendable` box. Swift 6.2 still reports
// "sending ... risks causing data races" for `nonisolated(unsafe)` locals
// captured by a `sending` closure, while a captured `Sendable` value passes.
const UNCHECKED_SENDABLE = `/// Immutable wrapper that makes a non-Sendable value capturable by a \`@Sendable\` closure without compiler enforcement.
/// Unlike \`NonisolatedUnsafeVar\`, it is a struct, so wrapping a value doesn't allocate.
///
/// Use it instead of a \`nonisolated(unsafe) let\` local captured by such a closure: Swift 6.2 still reports
/// "sending '...' risks causing data races" for those, while a capture of a \`Sendable\` value passes on every version.
/// The caller is responsible for making sure the value is never accessed concurrently.
internal struct UncheckedSendable<Value>: @unchecked Sendable {
  let value: Value

  init(_ value: Value) {
    self.value = value
  }
}
`;

function countOf(text, snippet) {
    return text.split(snippet).length - 1;
}

function replaceOnceOrThrow(text, oldText, newText, what) {
    if (countOf(text, oldText) !== 1) {
        throw new Error('[desklink] expo-modules-jsi ' + what + ': expected one match, refusing to patch.');
    }
    return text.replace(oldText, newText);
}

/**
 * Apply the 58-shaped Xcode 26 fixes to the installed expo-modules-jsi.
 * Idempotent: a second prebuild (or an upstream-fixed copy) is a no-op.
 * Scoped to the 57 line; anything else is left untouched. Throws on an
 * unrecognised 57 layout rather than shipping a guess.
 */
function patchExpoModulesJsi(projectRoot) {
    const root = path.join(projectRoot, 'node_modules/expo-modules-jsi');
    const header = path.join(root, JSI_HEADER);
    if (!fs.existsSync(header)) {
        console.log('[desklink] expo-modules-jsi header not installed, skipping Xcode 26 fix');
        return;
    }
    let version = '';
    try {
        version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '';
    } catch { /* unknown version: the layout checks below decide */ }
    if (!version.startsWith('57.')) {
        if (version === '') {
            throw new Error('[desklink] expo-modules-jsi has no readable version; refusing to patch blind.');
        }
        console.log(`[desklink] expo-modules-jsi ${version} is not a 57 release, skipping Xcode 26 fix`);
        return;
    }
    const before = fs.readFileSync(header, 'utf8');
    if (!before.includes('static RuntimeScheduler *create(')) {
        if (countOf(before, BROKEN_CONSTRUCTORS) !== 1) {
            throw new Error(
                '[desklink] expo-modules-jsi ' + version + ' RuntimeScheduler.h has an unrecognised layout; ' +
                'refusing to patch. Update this plugin workaround for the installed version.'
            );
        }
        fs.writeFileSync(header, before.replace(BROKEN_CONSTRUCTORS, FIXED_CONSTRUCTORS));
    }

    // The header's only constructor callers are the Swift file beside it:
    // point them at the factories. Member accesses (`.Priority(`, `.ScheduleFn`)
    // never match `RuntimeScheduler(`.
    const swift = path.join(root, JSI_SWIFT);
    if (!fs.existsSync(swift)) {
        throw new Error('[desklink] expo-modules-jsi ' + version + ' ships no ' + JSI_SWIFT + '.');
    }
    let swiftText = fs.readFileSync(swift, 'utf8');
    if (!swiftText.includes('expo.RuntimeScheduler.create(')) {
        const migrated = swiftText.replace(/expo\.RuntimeScheduler\(/g, 'expo.RuntimeScheduler.create(');
        if (migrated === swiftText || /expo\.RuntimeScheduler\(/.test(migrated)) {
            throw new Error('[desklink] expo-modules-jsi JavaScriptRuntime.swift call sites not fully migrated.');
        }
        swiftText = migrated;
    }

    // Capture the JSI pointers through UncheckedSendable instead of
    // `nonisolated(unsafe)`, which Swift 6.2 rejects at `sending` closures.
    if (!swiftText.includes('resultPtr.value')) {
        if (countOf(swiftText, 'nonisolated(unsafe) let resultPtr = resultPtr') !== 3) {
            throw new Error('[desklink] expo-modules-jsi JavaScriptRuntime.swift pointer captures have an unrecognised layout.');
        }
        swiftText = replaceOnceOrThrow(swiftText,
            'let propertyName = String(cString: propertyName)\n      nonisolated(unsafe) let resultPtr = resultPtr',
            'let propertyName = String(cString: propertyName)\n      let resultPtr = UncheckedSendable(resultPtr)',
            'getter capture');
        swiftText = swiftText.split(
            '    nonisolated(unsafe) let thisPtr = thisPtr\n' +
            '    nonisolated(unsafe) let argumentsPtr = argumentsPtr\n' +
            '    nonisolated(unsafe) let resultPtr = resultPtr').join(
            '    let thisPtr = UncheckedSendable(thisPtr)\n' +
            '    let argumentsPtr = UncheckedSendable(argumentsPtr)\n' +
            '    let resultPtr = UncheckedSendable(resultPtr)');
        if (countOf(swiftText, 'let thisPtr = UncheckedSendable(thisPtr)') !== 2) {
            throw new Error('[desklink] expo-modules-jsi JavaScriptRuntime.swift trampoline captures not fully migrated.');
        }
        const writes = countOf(swiftText, 'writeJSIValue(to: resultPtr)');
        if (writes !== 3) {
            throw new Error('[desklink] expo-modules-jsi JavaScriptRuntime.swift result writes have an unrecognised layout.');
        }
        swiftText = swiftText.replace(/writeJSIValue\(to: resultPtr\)/g, 'writeJSIValue(to: resultPtr.value)');
        swiftText = replaceOnceOrThrow(swiftText,
            'UnsafeMutablePointer(mutating: thisPtr)', 'UnsafeMutablePointer(mutating: thisPtr.value)',
            'owning-this use');
        const starts = countOf(swiftText, 'start: argumentsPtr, count:');
        if (starts !== 2) {
            throw new Error('[desklink] expo-modules-jsi JavaScriptRuntime.swift buffer starts have an unrecognised layout.');
        }
        swiftText = swiftText.replace(/start: argumentsPtr, count:/g, 'start: argumentsPtr.value, count:');
        swiftText = replaceOnceOrThrow(swiftText,
            'JavaScriptUnownedValue(runtime.pointee, thisPtr)', 'JavaScriptUnownedValue(runtime.pointee, thisPtr.value)',
            'unowned-this use');
        swiftText = replaceOnceOrThrow(swiftText,
            'so the `nonisolated(unsafe)` capture is sound.', 'so capturing them through `UncheckedSendable` is sound.',
            'trampoline comment');
        fs.writeFileSync(swift, swiftText);
    }

    const box = path.join(root, JSI_BOX);
    if (!fs.existsSync(box)) {
        fs.writeFileSync(box, UNCHECKED_SENDABLE);
    }
    console.log('[desklink] patched expo-modules-jsi ' + version + ' for Xcode 26');
}

function withDesklinkPointer(config) {
    return {
        ...config,
        ios: { ...config.ios, infoPlist: { ...config.ios?.infoPlist, UIApplicationSupportsIndirectInputEvents: true } },
    };
}

function withExpoJsiSwiftFix(config) {
    let withDangerousMod;
    try {
        withDangerousMod = require('expo/config-plugins').withDangerousMod;
    } catch {
        throw new Error('[desklink] expo/config-plugins is required to apply the Xcode 26 patch.');
    }
    return withDangerousMod(config, ['ios', async (config) => {
        patchExpoModulesJsi(config.modRequest.projectRoot);
        return config;
    }]);
}

module.exports = function withDesklink(config) {
    return withExpoJsiSwiftFix(withDesklinkPointer(config));
};
module.exports.patchExpoModulesJsi = patchExpoModulesJsi;
