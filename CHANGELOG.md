# Changelog

## 0.4.0

Joint release of `@desklink/host`, `@desklink/host-linux-x64-gnu`,
`@desklink/host-darwin-arm64`, `@desklink/react-native` and `@desklink/axi`.
Publication is gated on the matching native artifacts and integrated qualification;
this changelog is not a claim that unpublished packages are available.

### New

- Pairing is the only application trust boundary. A paired client gets every available view, input and clipboard capability; an unpaired client gets none. The consumer closes live sessions and refuses future access when pairing is revoked. OS-forced consent still applies. Pairing and revocation belong to the consumer, using published [@byokit/link](https://www.npmjs.com/package/@byokit/link), not a second identity system in the engine. [Backend change](https://github.com/umeranjum17/desklink/pull/63).
- X11 CLIPBOARD read/write uses the session's selected display. Explicit Copy/Paste requests work through the local API and WebRTC control channel; there is no background clipboard synchronization.

### Fixed

- The React Native client always sends the legacy `view`, `control`, `clipboard` wire permission set, even when the app specifies no permissions or only `view`. This retains access to published 0.3.1 hosts while new hosts ignore scopes. [Client/reference change](https://github.com/umeranjum17/desklink/pull/64).
- Unsupported input backends refuse the individual action without denying otherwise available view or clipboard access. Failure to create an optional driving indicator does not become a second consent gate.

### Improved

- Legacy `permissions` remains compatibility-only. AXI always connects its control channel; hidden `start --control` is an ignored no-op and `start`/`home` no longer print permission scopes.
- Linux agent-driving indicators have more visible arrows/halos and reveal/retract motion. [Indicator change](https://github.com/umeranjum17/desklink/pull/60), [wording clarification](https://github.com/umeranjum17/desklink/pull/62).
- The standard hosted ARM64 macOS CI job uses the existing release builder and clean-install smoke, recording architecture, source/archive and dependency hashes, static libvpx, executable hash and capabilities with its downloadable artifact. This is non-interactive artifact qualification, not macOS desktop qualification.

### Known issues and limits

- X11 reads wait at most 2.5 seconds and are bounded to 256 KiB; longer valid UTF-8 reads report truncation. Writes over 256 KiB or the X server's single-request limit are refused. INCR transfers are explicitly unsupported. STRING, PRIMARY and clipboard persistence after engine exit are not implemented. Empty/no-text or nonresponsive owners fail rather than report a successful copy.
- Protocol 3 is unchanged. New AXI requires its matching 0.4.0 engine; overriding with a 0.3.x engine is unsupported. The bundled reference page opens without legacy scopes and requires the new paired-only host; it is not a standalone 0.3.1-host client. The new React Native receiver retains 0.3.1-host compatibility; a stopped old bridge may appear as transport failure/reconnecting rather than an explicit revoked status, but grants no access.
- Linux X11 clipboard and Android emulator SDK/native-clipboard transfer are the release qualification targets. The lab-only SDK fixture is not shipped UI. The separately owned clipboard success pill, live accessibility announcement and iOS layout remain unfinished/unqualified; older mixed UI/host evidence is not final 0.4.0 shipping proof. Android may also show its own system clipboard preview overlay.
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
