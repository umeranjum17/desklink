# Changelog

## 0.5.1

Patch release of `@desklink/host`, `@desklink/host-linux-x64-gnu`,
`@desklink/host-darwin-arm64`, `@desklink/react-native` and `@desklink/axi`.
It carries one change — the Android startup crash a fresh install hit — and
nothing else. The protocol is unchanged at version 3, and a 0.5.0 AXI still
needs a 0.5.1 engine.

### Verification

- Pack-level: the five tarballs were built by `release/pack.mjs` from this
  release commit and installed into an empty project by
  `release/check-install.sh`, which resolves the pinned engine, completes the
  protocol handshake and probes capabilities without opening a capture session.
- Registry: all five packages report `latest = 0.5.1`, and each tarball's
  integrity matches the byte-for-byte SHA-512 `release/publish.mjs` recorded.
  Every file npm serves exists in this repository at the same path.
- Android: a fresh `create-expo-app` project that installs
  `@desklink/react-native@0.5.1` from npm builds, installs and starts on an
  API 36 device without the Expo module registration crash. The release pull
  request records the device proof and its limits.

### Fixed

- **A fresh Expo app starts.** `@desklink/react-native@0.5.0` threw
  `UnsupportedOperationException: This function has a reified type parameter`
  out of `DesklinkModule.definition()` while the module registered, so the app
  died before it could contact a desktop. The Android module declared a bare
  `kotlin-android`, but expo-modules-core reaches its type descriptors through
  the `pika` compiler plugin, which `expo-module-gradle-plugin` applies; without
  it 52 reified calls stayed runtime markers. Applying Expo's own plugin also
  supplies `kotlin-android` and the default Expo module dependencies.
  [PR95](https://github.com/umeranjum17/desklink/pull/95)
- **No second expo-modules-core.** The peer range `expo-modules-core ">=55 <56"`
  made npm install and hoist a core 55 beside the 57 the app uses, and the
  module compiled against the wrong one. The range is widened, so one core
  resolves and a fresh `npx create-expo-app` needs no SDK pin. Expo SDK 55 and
  later are supported.
  [PR95](https://github.com/umeranjum17/desklink/pull/95)

### Known issues and limits

- Everything 0.5.0 listed under *Known issues and limits* still applies: macOS
  arm64 remains an unsigned, default-enabled **preview** whose Screen Recording
  and Accessibility permissions belong to the app that launches it; `getStats()`
  is receiver-side counters, not latency; iOS picture fill, the iOS simulator
  pointer, interactive macOS/Windows capture and input, Wayland
  portal-producer journeys, Wayland clipboard and the arm64/musl native package
  are not established.
- 0.5.1 changes the engine's crate version string only. The Linux and macOS
  engines are rebuilt from this commit.

### Install

```sh
npm install @desklink/host@0.5.1
npm install @desklink/react-native@0.5.1
npm install --global @desklink/axi@0.5.1
```

The host selects its exact-version optional native package automatically.

## 0.5.0

Tester build of `@desklink/host`, `@desklink/host-linux-x64-gnu`,
`@desklink/host-darwin-arm64`, `@desklink/react-native` and `@desklink/axi`.
Everything published here already existed in 0.4.0 except the receiver changes
below; the protocol is unchanged at version 3.

### New

- **The desktop fills the phone screen.** In portrait the picture fits the width;
  in landscape it covers the screen below the status bar, within the 2.5x zoom
  limit, and stays undistorted. Pass the screen's safe-area `insets` (for
  example from `react-native-safe-area-context`) so the default starts below a
  status bar and beside a camera cutout, panning brings each desktop edge inside
  the safe area, and landscape coverage extends beneath the cutout and home
  indicator to limit black bars. A new desktop size or a rotation reapplies the
  orientation default from the top-left. `fitToView()` still shows the whole
  desktop. [PR70](https://github.com/umeranjum17/desklink/pull/70)
- **Android connection links and receiver diagnostics.** The Android receiver
  accepts the connection link it is launched with, and
  `desktop.getStats()` returns receiver-side video and codec counters (packets,
  loss, frames decoded/dropped, fps, resolution, decoder implementation and
  timing) for evidence about the picture. The snapshot deliberately excludes ICE
  addresses and control content. [PR71](https://github.com/umeranjum17/desklink/pull/71)

### Fixed

- The default example no longer shows developer text such as
  `live presented WxH`, `Desklink iOS QA` or raw channel JSON; the receiver's
  status line stays plain user-facing copy. [PR70](https://github.com/umeranjum17/desklink/pull/70)
- Reconnect flows accept an engine override through `DESKLINK_ENGINE`, so a
  receiver test can use a locally built engine instead of an installed one.
  [PR69](https://github.com/umeranjum17/desklink/pull/69)

### Known issues and limits

- Protocol 3 is unchanged, and 0.5.0 AXI requires its matching 0.5.0 engine.
- The screen-fill default is qualified on the Android test phone. Physical iOS
  picture fill, iOS simulator pointer and interactive macOS/Windows capture and
  input are not established by this release. Wayland portal-producer journeys,
  Wayland clipboard and a Windows or Linux arm64/musl native package remain
  unfinished.
- `getStats()` reports receiver-side counters only. It is not a latency
  measurement, and it does not make a second WebRTC stack: neither platform
  links one.
- macOS arm64 remains an unsigned CLI, default-enabled **preview**, with Screen
  Recording and Accessibility belonging to the app that launches it.

### Install

```sh
npm install @desklink/host@0.5.0
npm install @desklink/react-native@0.5.0
npm install --global @desklink/axi@0.5.0
```

The host selects its exact-version optional native package automatically.

## 0.4.0

Joint release of `@desklink/host`, `@desklink/host-linux-x64-gnu`,
`@desklink/host-darwin-arm64`, `@desklink/react-native` and `@desklink/axi`.
Publication is gated on the matching native artifacts and integrated qualification;
this changelog is not a claim that unpublished packages are available.

### New

- Pairing is the only application trust boundary. A paired client gets every available view, input and clipboard capability; an unpaired client gets none. The consumer closes live sessions and refuses future access when pairing is revoked. OS-forced consent still applies. Pairing and revocation belong to the consumer, using published [@byokit/link](https://www.npmjs.com/package/@byokit/link), not a second identity system in the engine. [Backend change](https://github.com/umeranjum17/desklink/pull/63).
- X11 CLIPBOARD read/write uses the session's selected display. Explicit Copy/Paste requests work through the local API and WebRTC control channel; there is no background clipboard synchronization.

### Fixed

- `@desklink/react-native` peers `expo-modules-core` at the SDK line (`>=55 <56`). Left unbounded, npm resolves the peer to a newer major than the app's Expo SDK, whose podspec needs a higher iOS deployment target than the generated Podfile, and `pod install` fails with `Unable to find a specification for ExpoModulesCore depended upon by ExpoAsset`. Every clean iOS build of an example app hit this.
- The React Native example shows plain states such as Connected or Your desktop ended this session, without bridge URLs, pairing tokens, raw failure text or developer frame metrics. SDK failure messages are diagnostic data, not safe user-facing copy. [Status/privacy fix](https://github.com/umeranjum17/desklink/pull/65).
- The React Native client always sends the legacy `view`, `control`, `clipboard` wire permission set, even when the app specifies no permissions or only `view`. This retains access to published 0.3.1 hosts while new hosts ignore scopes. [Client/reference change](https://github.com/umeranjum17/desklink/pull/64).
- Unsupported input backends refuse the individual action without denying otherwise available view or clipboard access. Failure to create an optional driving indicator does not become a second consent gate.

### Improved

- Legacy `permissions` remains compatibility-only. AXI always connects its control channel; hidden `start --control` is an ignored no-op and `start`/`home` no longer print permission scopes.
- Linux agent-driving indicators have more visible arrows/halos and reveal/retract motion. [Indicator change](https://github.com/umeranjum17/desklink/pull/60), [wording clarification](https://github.com/umeranjum17/desklink/pull/62).
- Hosted ARM64 macOS CI now produces a downloadable release artifact through the existing build and clean-install path. See the [packaging guide](packages/desktop-host/README.md#building-and-packing-a-release) for provenance checks and qualification limits.

### Known issues and limits

- X11 reads wait at most 2.5 seconds and are bounded to 256 KiB; longer valid UTF-8 reads report truncation. Writes over 256 KiB or the X server's single-request limit are refused. INCR transfers are explicitly unsupported. STRING, PRIMARY and clipboard persistence after engine exit are not implemented. Empty/no-text or nonresponsive owners fail rather than report a successful copy.
- Protocol 3 is unchanged. New AXI requires its matching 0.4.0 engine; overriding with a 0.3.x engine is unsupported. The bundled reference page opens without legacy scopes and requires the new paired-only host; it is not a standalone 0.3.1-host client. The new React Native receiver retains 0.3.1-host compatibility; a stopped old bridge may appear as transport failure/reconnecting rather than an explicit revoked status, but grants no access.
- Linux X11 clipboard and Android emulator SDK/native-clipboard transfer are the release qualification targets. The lab-only SDK fixture is not shipped UI. The separately owned clipboard success pill, live accessibility announcement and iOS layout remain unfinished/unqualified; older mixed UI/host evidence is not final 0.4.0 shipping proof. Android may also show its own system clipboard preview overlay.
- The Android SDK fixture uses stock Expo 55.0.31, React Native 0.83.10, `expo-modules-core` 55.0.26 and `expo-clipboard` 55.0.17. Keep `expo-modules-core` aligned with the app's Expo version (`npx expo install expo-modules-core`); allowing the SDK's broad peer range to auto-select core 57 beside Expo 55 fails native compilation. No SDK or upstream patch is needed.
- OS consent is not bypassed or expanded. Wayland portal-producer/consent journeys, Wayland clipboard, native macOS/Windows interactive clipboard/input, physical Android and iOS are not established by these private Linux/emulator checks. macOS arm64 remains an unsigned CLI, default-enabled **preview**, with Screen Recording/Accessibility belonging to its responsible launching app. No Windows, Linux arm64 or musl native package is added.

### Install, downloads and provenance

After publication, install exact packages from npm:

```sh
npm install @desklink/host@0.4.0
npm install @desklink/react-native@0.4.0
npm install --global @desklink/axi@0.4.0
```

The host selects its exact-version optional native package automatically. Release
notes/downloads live at [GitHub Releases](https://github.com/umeranjum17/desklink/releases);
package installation and OS prerequisites are in the [host guide](packages/desktop-host/README.md#install-and-run)
and [receiver guide](packages/desktop-client/README.md). No workspace link or temporary
SDK patch is distributed. Each native package includes `provenance.json` with its
exact source commit, target, engine version and executable SHA-256 plus linked
third-party notices. Linux build inputs are pinned by the existing container recipe;
Darwin's hosted build manifest also records the actual Homebrew/static-libvpx inputs.
Keep the release's frozen tarball hashes and runtime evidence alongside the release
receipt; a tag or a successful upload alone is not binary provenance.

## 0.3.1

- Pin checkpoint workspace dependencies and align the host, engine, React Native receiver and AXI package versions.
- Label macOS desktop support as preview; see the [host installation guide](packages/desktop-host/README.md#macos-preview) for its support status and setup.
- Prevent the macOS release engine from linking Homebrew's libvpx dylib.
- Refuse ambient desktop endpoints in integration labs and verify owned Xvfb and browser process identities before contact or cleanup.
- Harden browser-helper teardown and benchmark process inventory handling during shutdown.

## 0.3.0

- Enable the macOS engine by default and distribute a prebuilt Apple Silicon engine alongside Linux x64. A macOS lab run passed a full journey and a 30-minute soak without capture stops at about 57 fps; this did not establish qualified desktop support. See the [host installation guide](packages/desktop-host/README.md#macos-preview) for current support and the opt-out.
- Speed up X11 capture with MIT-SHM and damage tracking, reduce repeated frame conversions, and time encoding to captured frames.
- Adapt network bitrate to delay and default capture to 60 fps.
- Offer H.264 for captured desktops, including hardware encoding where available, and bring the iOS receiver to parity with hardware H.264 decoding.
- Recover interrupted sessions and fix the first-frame freeze on iOS.
- Add native iOS hardware keyboard and pointer input.
- Document installation for the host, React Native receiver and AXI CLI. Release all packages at 0.3.0.
