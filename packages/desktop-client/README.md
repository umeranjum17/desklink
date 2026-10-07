<h1 align="center">@desklink/react-native</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@desklink/react-native"><img alt="npm" src="https://img.shields.io/npm/v/@desklink/react-native?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/desklink/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/desklink/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Android, iOS and web" src="https://img.shields.io/badge/Android%20%7C%20iOS%20%7C%20web-111?style=flat" />
</p>

<p align="center">
  <strong>Show a live desktop in a React Native app, and drive it from the phone.</strong><br/>
  It renders a desktop that <code>@desklink/host</code> serves on Android, iOS and the web, with touch as a desktop pointer the phone can see, sticky modifier keys, and a session that recovers from a dropped network on its own.
</p>

The package is a **view and a session**, not a screen: it renders the picture and
turns touch, the keyboard and the clipboard into that session's input. Where it
sits, how it starts, what the buttons look like and where "back" goes belong to
the application.

## Install

The npm badge at the top of this page tracks the registry version, and npm
verifies package integrity on install. See the [changelog](../../CHANGELOG.md)
for release changes. Supported platforms: Android, iOS and web.

The package contains native code and is not an Expo Go package. Inside this
repository it resolves through the workspace; anywhere else, install it from npm:

```sh
npx expo install @desklink/react-native      # or yarn add, then prebuild/rebuild
```

Expo SDK 55 and later are supported, including the SDK a fresh
`npx create-expo-app` resolves today: no SDK pin is needed.

Android uses an Expo native module; iOS uses the app's existing
`react-native-webrtc` peer connection and `RTCView` from JavaScript, plus a small
Expo module of its own for the hardware keyboard and an iPad pointer. Both need a
dev client or native build containing that binding ([development builds](https://docs.expo.dev/develop/development-builds/introduction/); [Expo Go](https://docs.expo.dev/workflow/expo-go/) cannot load them). Web uses the browser's WebRTC.
No second WebRTC binary is linked. The Android module has its own hardware-first
decoder factory; iOS uses the decoder shipped by `react-native-webrtc` and asks
the host for H.264, which that decoder runs in hardware.

On iOS the WebRTC binding also needs its config plugin
(`@config-plugins/react-native-webrtc` — 14.x for Expo SDK 55, 15.x for
Expo SDK 56 and later):

```json
{ "expo": { "plugins": ["@config-plugins/react-native-webrtc", "@desklink/react-native"] } }
```

On iPad, a trackpad or mouse hovers and scrolls the desktop as it is. For its
presses to carry their buttons — a click-drag that selects, a secondary click
that is a right click — the package's entry in the plugins list above sets
[`UIApplicationSupportsIndirectInputEvents`](https://developer.apple.com/documentation/bundleresources/information-property-list/uiapplicationsupportsindirectinputevents).

That key changes how every screen of the app receives trackpad input, so the
package never sets it on its own; without the plugin nothing about the app
changes, and trackpad presses reach the desktop as touches.

## Use

```tsx
import { DesktopView, useDesktopSession } from '@desklink/react-native';
import * as Clipboard from 'expo-clipboard';

const desktop = useDesktopSession({
    authorize: async () => ({
        signaling,                                   // your authenticated channel to the host
        session: {},
    }),
});

// Opening is a user action, so the app decides when it happens.
await desktop.connect();

<DesktopView sessionId={desktop.nativeId} style={{ flex: 1 }} keyboardClearance={96} />;
// On a deliberate control action, once the picture is live:
desktop.setInputEnabled(true);
desktop.showKeyboard();
desktop.setOrientation('landscape');   // Android only; iOS apps configure supported orientations themselves
await desktop.copyRemoteToLocal(async (text) => {
    if (!await Clipboard.setStringAsync(text)) throw new Error('Clipboard write refused');
});
await desktop.pasteLocalToRemote(await Clipboard.getStringAsync());
// Optional receiver evidence: codec, decoder and video counters; no ICE addresses.
const stats = await desktop.getStats();
```

Pairing is the only trust boundary. `authorize` is the app's pairing check: it
returns a channel to a paired computer or throws, and it runs again on every
reconnect, so a revoked pairing cannot reopen. A paired session has view,
input and clipboard; there are no in-app grants, and `session.permissions` is
ignored. Only the operating system's own consent (screen recording,
accessibility, a screen-sharing prompt) still applies on the computer.

A screen that only decides *whether* to offer a desktop does not need the
session: import the flag from its own entry, which is a constant on web and a
check for the platform module elsewhere, so the hook and the view stay out of
the first paint.

```tsx
import { desktopAvailable } from '@desklink/react-native/availability';

{desktopAvailable && <ComputerAction onPress={openDesktop} />}
```

### Frame rate and encode size

The engine streams at up to 60 fps unless `session.maxFps` names a lower cap —
omit it for the smooth path. A still desktop costs nothing at 60, because the
engine only produces frames on change.

Keep the encoded picture inside a 1920×1080 box:

```tsx
session: { maxWidth: 1920, maxHeight: 1080 },
```

The engine never upscales, so a smaller desktop is sent at its own size and a
larger one is scaled to fit. Above that box the encoder cannot sustain 50+ fps
under full-screen motion.

On iOS, keep the box at or below the device's own pixels and `maxFps` at 30:
the iOS receiver asks the engine for H.264, which iOS decodes in hardware
(VideoToolbox), but a host without an H.264 encoder still sends VP9, which
iOS decodes in software — so a 1440p or 4K picture on such a host costs CPU,
heat and battery.

### Paths with no UDP route

`session.loopbackTcp` asks the engine to also offer ICE over TCP on its own
`127.0.0.1`, for a client whose only way to the computer is a forward of that
loopback — an SSH tunnel, `adb reverse`:

```tsx
session: { loopbackTcp: true },
```

It is off by default, like the wire field it sets. A client with a UDP path
keeps it: ICE prefers UDP whenever it has one. The engine picks that port per
session, so the forward has to follow it (`adb reverse tcp:<port> tcp:<port>`,
`ssh -L <port>:127.0.0.1:<port> <computer>`) with `<port>` from the
`session.candidate` the engine offers. Without it a connection that never
forms fails after 20 seconds with that reason, rather than sitting on an empty
view.

### What the package guarantees

- **Hardware decoding where the platform has it.** Android and web decode the
  host's default VP9; Android builds a session-scoped hardware-first decoder
  factory with software fallback. iOS uses the app's `react-native-webrtc`
  decoder, which decodes H.264 through VideoToolbox but VP9 only in software,
  so the iOS receiver asks for H.264 by putting it first in the offer it
  applies; a host with an H.264 encoder then sends H.264, and one without sends
  VP9. Neither platform links a second WebRTC stack.
- **A sharp, zoomable picture.** In portrait the default is fit-width;
  in landscape it covers the screen below the status bar (as far as the 2.5
  zoom limit allows). The `cover` prop opts portrait into the same
  coverage, cropping the overflowing sides instead of letterboxing. The picture stays undistorted. One finger pans cropped
  content; pinch to zoom before panning when the whole desktop already fits.
  Pass the screen's safe-area `insets` (for example from
  `react-native-safe-area-context`) so the default starts below the status bar
  and beside a camera cutout. `onPictureFrame` reports where the picture
  ended whenever it moves, so a tall screen's band below it can carry the
  application's own controls instead of empty space. Panning brings each desktop edge inside the safe
  area, while landscape coverage extends beneath the cutout and home indicator
  to limit black bars. A pinch zooms up to 2.5 view
  pixels per desktop pixel, or out to the whole desktop. On Android the decoded frame is copied once into the view's
  own texture and drawn with a multi-tap filter when it is shown smaller than
  its size, so a fitted 4K desktop does not alias and a pinch redraws at once.
  iOS uses `RTCView`'s native renderer. That renderer draws a frame only when
  its timestamp is new, and a receiver honouring the engine's zero playout delay
  stamps every frame alike, so the iOS peer declines that hint and keeps the
  receiver's usual jitter buffer. `fitToView()` shows the whole desktop; a new
  desktop size or a rotation reapplies the orientation default from the top-left.
- **A pointer a phone can see.** Once a touch has sent the desktop's pointer
  somewhere, the view draws an outlined arrow there at a readable size, over a
  picture whose own cursor is a few pixels tall or not captured at all. On iOS,
  the arrow tip marks the desktop pointer position. Android hides the extra
  mark when a mouse is attached, iOS when an iPad trackpad or mouse drives it,
  and the `device` profile draws no mark on any platform — the screen being
  touched shows the finger itself.
- **The picture above the keyboard.** While the phone's keyboard is up, the
  picture sits above it and above the room the app keeps for its own controls
  (`keyboardClearance`). Only the part of the view the keyboard really covers
  counts, and a picture taller than what is left moves so the pointer, where
  a tap just put the caret, stays in sight. Android also follows the keyboard
  animation frame by frame; iOS moves once, as the keyboard shows or hides.
- **Contained geometry.** Touch maps through the picture's actual placement.
  On the whole desktop, a one-finger drag starting in the letterbox does not move the pointer; a
  second finger on the picture can still start a pinch or scroll. A drag that
  leaves the picture is held to its edge rather than released somewhere unseen.
- **The gestures remote-desktop viewers settled on,** with a slop threshold:
  tap to click, and a second tap close by is a double click on
  the same point; hold and release for a right click where the finger rested
  (every desktop app's context menu); hold then drag for the left button
  (select text, move a window); on the whole desktop a finger that moves
  carries the pointer with it, without a button, and the drawn pointer stays
  under the finger while the picture catches up; two fingers scroll the desktop
  under them, or pinch; a quick two-finger tap is a right click too. Scrolling
  is fractional wheel steps, smooth where the desktop supports high-resolution
  wheels. Android coalesces pending pointer moves under congestion. The
  `gestures` prop reshapes one finger for what the picture shows, and can be
  changed mid-session: `browser` scrolls the page under one finger (a tap
  still clicks and a hold still right-clicks), `device` presses the screen —
  the finger lands with the button down, drags with it held and lifts to
  release, so a tap clicks and a hold holds with no long-press right click,
  and no drawn pointer — while the default `desktop` is the trackpad above.
  Two fingers scroll and pinch the same under every profile.
- **A hardware keyboard and a trackpad.** A hardware keyboard's keys reach the
  desktop with their down and up and what is held: arrows, Esc, Tab, Home/End,
  Page Up/Down, Delete and the modifiers, with Control and Command
  chords as the key's own letter (iOS sends Command as the desktop's Meta);
  other keys type their text. On iOS the view holds the keyboard while control
  is enabled and gives it to the on-screen keyboard while the app shows it;
  shortcuts the system keeps, such as Command-Tab and the Globe key, stay with
  the system. An iPad pointer hovers the desktop's pointer, scrolls under it,
  and — with the config plugin — presses, drags and right-clicks with its own
  buttons.
- **The keys a phone lacks.** `modifiers`, `tapModifier` and `pressKey` give
  sticky Ctrl and Shift: tap arms one for the next key, tap again locks it.
  While one is armed, the next key or character the phone's keyboard types is
  sent as that key's chord, so Ctrl then v is Ctrl+V. `modifiers` holds each
  key's state (`off`, `once` for latched, `lock`) for the app to read.
  `<ModifierKeys modifiers={desktop.modifiers} onTap={desktop.tapModifier} />`
  draws them as a backed key row: off is an outlined key, latched a filled
  one, locked a filled one with a white rim and a bar under its label, and a
  screen reader hears off, latched or locked. Its `grow` prop makes it a
  tablet's row: the keys take the width and the height the row is given
  instead of sitting at 44 pt. An app may draw its own keys
  from `modifiers` instead.
- **Readiness is a rendered frame.** Android marks the first draw; iOS marks
  the first `RTCView` video-dimensions callback and ignores later ones; web
  marks the first presented frame and ignores later repaints, so a resize,
  remount, or renegotiation repaint during a reconnect does not read as live.
  No platform marks a track or ICE connection as live.
- **Connection states, as they happen.** The session status is `idle`,
  `opening`, `connecting`, `live`, `reconnecting`, `ended` or `failed`. The
  peer's ICE state and the engine's `session.state` both feed it: a
  `disconnected` path reads as `reconnecting` within about a second of the
  drop — never a frozen picture that still says live — and a recovered path
  reads as `live` again once the picture is advancing again (ICE `connected`
  alone does not restore `live` while the picture is frozen). A path that reports
  `failed` reopens the session with fresh authority instead of staying stuck.
  Every event carries its engine session id where the carrier preserves it,
  and the session ignores anything naming a session it no longer holds, so a
  previous generation's queued offer or revocation cannot corrupt or kill a
  healthy recovery.
  Detection is three-layered: ICE and engine `session.state` events, the
  engine's twice-a-second control-channel heartbeat (`{"kind":"ping"}`) — a
  path that stops heartbeating reads as stalled within ~1.5 s even while ICE
  consent timers are still making up their minds, and resumed heartbeats read
  as recovered — and a half-second poll of the receiver's own video counters
  while a picture is shown: a picture stopped for ~2 s reads as not `live`
  even while signalling, ICE and control all answer. Clients on engines that
  predate the heartbeat simply never arm that watchdog.
- **ICE restarts before reopens.** When the path drops after frames were
  shown, the session asks the engine (`session.restart_ice`) to re-offer on
  the same peer connection: the fresh offer arrives as the usual
  `session.description` event and is answered as usual, all without reopening
  the session. The first restart waits ~2 s for blips that heal alone;
  retries back off across ~60 s, so a 30–60 s outage still recovers when the
  network returns — except while the picture is frozen, when the short ~2 s
  retry keeps being spent without consuming the reopen budget until frames
  move again. When the restart schedule is spent without the peer
  reporting `failed`, the session reopens instead of sitting in
  `reconnecting`. An engine revocation with code `transport` (the path was
  lost) also reopens the session; any other revocation code, or none, ends
  it, as does a deliberate close. A return to the foreground after ~30 s away
  reopens at once rather than spending restarts on a lapsed path. Those
  reopens back off across ~60 s too instead of spending one attempt while the
  network is still down. Renegotiation transients from a restart the session
  asked for itself are expected, not a new outage: they neither flip the
  status nor trigger another restart for a short grace window.
- **Input starts disarmed.** This is a local arm against accidental touches,
  not a permission: the session already has input. `setInputEnabled(true)` arms
  pointer, keyboard and clipboard input; `setInputEnabled(false)` blocks new
  input, releases held keys and buttons, and resets pending gestures. The app
  decides when to arm it after a deliberate action and must disarm it on
  background or lost readiness; a clipboard write already in flight may still
  finish.
- **Released state.** The app disables input on background and unmount;
  session close and a lost control channel release what the desktop was holding.
- **Explicit clipboard.** Two methods, called on a user action while control is
  enabled. The package never polls the clipboard or uses it as a way to type.
  `copyRemoteToLocal(writeLocal)` awaits the caller-owned local writer, which
  must reject on failure or refusal, before recording completion. The returned
  text and truncation flag describe what was written. `pasteLocalToRemote(text)`
  records completion only after the desktop acknowledges the write.
  `clipboard` is the last transfer that completed, and
  `<ClipboardConfirmation transfer={desktop.clipboard} />` confirms each one
  with a backed pill — where it went and the start of the text —
  that ignores touches and leaves after 1.5 s. Place it in a reserved area
  outside `DesktopView`, keeping that area present when the pill is dismissed.

### `Signaling`

The one thing the app must supply. It carries the engine's local protocol over
whatever authenticated channel the app already has.

See the [BYOKit integration guidance](../../README.md#why-desklink-exists)
for the application's pairing, identity and signaling transport.

```ts
interface Signaling {
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    subscribe(handler: (event: SessionEvent) => void): () => void;
}
```

`method` is one of `session.open`, `session.description`, `session.candidate`,
`session.restart_ice`, `session.close`; `SessionEvent` is the engine's offer,
candidates, state and revocation. Pixels and input do **not** use this
channel — they are the desktop's own WebRTC session.

`authorize()` must wait for the authenticated carrier to open before returning
its `Signaling`. When that carrier is gone, reject pending and future requests
with `code: 'transport'`; do not queue them indefinitely. An adapter may emit
`{ kind: 'carrier-closed' }` once to notify subscribers of that loss. This is
not the native peer's `closed` event or an engine revocation. Preserve the
engine's `session.revoked` code: `transport` indicates path loss; other codes
(or no code) are final. The demo adapter bounds connection setup to five seconds
and closes its socket and pending queue when disposed.

## Shipping on iOS

What the consuming app — not this package — must get right before review.

- **Local network.** A direct LAN session connects to host ICE candidates,
  which prompts for local-network access, so the app needs
  `NSLocalNetworkUsageDescription`. The first connection can be denied before
  the user answers; the session's restart/reopen path recovers from that.
  `NSBonjourServices` is only needed if the app adds its own Bonjour
  discovery — desklink discovers no hosts. Relay-only sessions never prompt.
  For app-supplied routes, see the
  [BYOKit integration guidance](../../README.md#why-desklink-exists).
  See [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
- **Export compliance.** The viewer's DTLS-SRTP comes from libwebrtc bundled
  with `react-native-webrtc`, not from the OS, so the app must check the
  exemption criteria itself rather than assume
  `ITSAppUsesNonExemptEncryption` is `NO` — standard-protocol encryption is
  commonly exempt but can still need a yearly self-classification report.
  See [complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).
- **Review.** A viewer that mirrors the whole host device generically falls
  outside the remote-desktop conditions; one that mirrors only specific
  software must connect LAN-only to a user-owned host. Which case applies is
  the app's product shape to decide. Declare no `audio` or `voip` background
  mode to keep the stream alive — review rejects that. See the
  [App Store review guidelines](https://developer.apple.com/app-store/review/guidelines/)
  (§4.2.7, §2.5.4).
- **Backgrounding.** There is no compliant background mode for a desktop
  stream: an app away longer than ~30 s comes back to a closed session, and
  the session reopens on return to the foreground rather than resuming. Keep
  disabling input on background; the engine releases held keys within
  seconds of the path dying, so nothing stays stuck.

## Example app proof

`example/` is the smallest app that shows a desktop: a native (non-Expo Go)
build with `react-native-webrtc`, connecting to `desklink-host bridge` with the
URL it is launched with on iOS, or the connection link it is opened with on
Android. Its hidden accessibility status shows plain messages: `Connected`
once a frame is presented, `Can’t reach your desktop. Reconnecting…` while
retrying, and `Your desktop ended this session` after revocation. It never
displays the bridge URL, pairing token, raw failure text or frame metrics.
`test/ios-flow.mjs` builds it for the iOS simulator on
a Mac over ssh, serves a private Xvfb desktop from this machine through the
bridge, and checks that the first frame is presented, that the answer puts
H.264 first with NACK when the host offers it (VP9 otherwise; both descriptions
are written out), that a tap clicks the host, that
the picture keeps following the desktop afterwards, and that hardware keys
pressed on the simulator reach the desktop. It then drives the whole
**phone-only control** journey from the phone's own screen, with no input sent
to the desktop from this machine: a click, a drag that holds the button and
selects, a two-finger scroll, typed text, a sticky modifier that chords the next
key and clears, the clipboard in both directions, and the drawn pointer mark's
shape and tip. Every step has its own capture, the journey is recorded as one
screen recording on the simulator, and the phone's own screen is read to prove it
carries no diagnostic text.
With `DESKLINK_IOS_IPAD=1` it runs on
an iPad simulator and also drives a trackpad through XCUITest
(`test/ios-pointer/`): hover, a click-drag that selects text, a right click and
a scroll:

```sh
npm run build && cargo build --manifest-path packages/desktop-host/engine/Cargo.toml
env -u DISPLAY -u WAYLAND_DISPLAY DESKLINK_IOS_MAC=user@mac \
  DESKLINK_IOS_DEVICE='fm-iPhone 17 Pro' npm run test:ios --workspace @desklink/react-native
```

The Mac needs Xcode with an iOS simulator runtime, CocoaPods, node and
[`axe`](https://github.com/cameroncooke/AXe) on its login `PATH`; everything
the run builds or caches stays in `~/desklink-ios` there. The run creates a
uniquely named simulator and deletes it during cleanup. Set
`DESKLINK_IOS_DEVICE` to the name or udid of one of the Mac's own simulators to
run on that instead and leave it in place. For host desktop isolation, see the
[private-lab guidance](../../README.md#develop). When the selected
Xcode has no simulator platform, point `DESKLINK_IOS_XCODE` at one that does;
`DESKLINK_IOS_RUNTIME` picks the iOS version (for example `18.6`); the
script's header lists the other settings. To capture the cursor tip proof, set
`DESKLINK_IOS_POINTER_PROOF=before` or `after`; the run writes a 4x crop, device
frame, proof metadata, and host click log under `DESKLINK_IOS_OUT`. Set
`DESKLINK_IOS_APP` to reuse an app bundle under the lane's directory when
running with `DESKLINK_IOS_SKIP_BUILD=1`. `DESKLINK_IOS_DIR` is the shared Mac
lab root (`fm-desklink-ios`) and `DESKLINK_IOS_LANE` names this lane's own
subdirectory within it; the run deletes that subdirectory and nothing else when
it finishes, so two lanes can build at once without one cleanup deleting the
other's build. Set `DESKLINK_IOS_KEEP=1` to keep it. Run once with `before`
before the change and
once with `after` after it, on both iPhone and iPad simulators, to compare the
pointer crop and verify the host click is within two desktop pixels of the tip.
To try the example by hand against any bridge:

```sh
xcrun simctl launch <device> dev.desklink.example -desklinkUrl 'ws://HOST:PORT/desktop?token=TOKEN'
```

On Android, build the same example with `npm run android` and open a connection
link whose `url` query parameter is the URL-encoded bridge WebSocket address:
`desklink-example://connect?url=ws%3A%2F%2FHOST%3APORT%2Fdesktop%3Ftoken%3DTOKEN`.
The example allows the bridge's plaintext private-network connection; consumer
apps choose their own transport policy. A new link replaces the open session.
The live picture has no diagnostic overlay. Its accessibility status remains
available as `desklink-status`. The key row (`Ctrl`, `Shift`, `Alt`, `Meta`) and
the `Copy` and `Paste` buttons are the app's own chrome over the picture, and a
clipboard transfer is confirmed by a pill above them.

For device evidence, an optional `report` query parameter accepts a URL-encoded
HTTP endpoint. While live, the example posts receiver statistics and connection
and first-presentation timestamps once per second. Collection failures do not
interrupt the session. Without that parameter, no evidence is posted.

## Licence

Apache-2.0. See `NOTICE`.
