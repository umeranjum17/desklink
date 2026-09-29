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

The package contains native code and is not an Expo Go package. Inside this
repository it resolves through the workspace; anywhere else, install it from npm:

```sh
npx expo install @desklink/react-native      # or yarn add, then prebuild/rebuild
```

Android uses an Expo native module; iOS uses the app's existing
`react-native-webrtc` peer connection and `RTCView` from JavaScript. Both need a
dev client or native build containing that binding. Web uses the browser's WebRTC.
No second WebRTC binary is linked. The Android module has its own hardware-first
decoder factory; iOS uses the decoder shipped by `react-native-webrtc`.

## Use

```tsx
import { DesktopView, useDesktopSession, CONTROL_PERMISSIONS } from '@desklink/react-native';

const desktop = useDesktopSession({
    authorize: async () => ({
        signaling,                                   // your authenticated channel to the host
        session: { permissions: CONTROL_PERMISSIONS },
    }),
});

// Opening is a user action, so the app decides when it happens.
await desktop.connect();

<DesktopView sessionId={desktop.nativeId} style={{ flex: 1 }} keyboardClearance={96} />;
// On a deliberate control action, once the picture is live:
desktop.setInputEnabled(true);
desktop.showKeyboard();
desktop.setOrientation('landscape');   // Android only; iOS apps configure supported orientations themselves
await desktop.pasteLocalToRemote(await Clipboard.getStringAsync());
```

A screen that only decides *whether* to offer a desktop does not need the
session: import the flag from its own entry, which is a constant on web and a
check for the platform module elsewhere, so the hook and the view stay out of
the first paint.

```tsx
import { desktopAvailable } from '@desklink/react-native/availability';

{desktopAvailable && <ComputerAction onPress={openDesktop} />}
```

### What the package guarantees

- **VP9 decoding.** Android builds a session-scoped hardware-first decoder
  factory with software fallback. iOS uses the app's `react-native-webrtc`
  decoder; neither platform links a second WebRTC stack.
- **A sharp, zoomable picture.** The desktop fits the view by default; a pinch
  zooms up to 2.5 view pixels per desktop pixel and one finger moves around the
  zoomed desktop. On Android the decoded frame is copied once into the view's
  own texture and drawn with a multi-tap filter when it is shown smaller than
  its size, so a fitted 4K desktop does not alias and a pinch redraws at once.
  iOS uses `RTCView`'s native renderer. `fitToView()` shows the whole desktop again.
- **A pointer a phone can see.** Once a touch has sent the desktop's pointer
  somewhere, the view draws it there at a readable size, over a picture whose
  own cursor is a few pixels tall or not captured at all. Android hides the
  extra mark when a mouse is attached, and the `device` profile draws no mark
  on any platform — the screen being touched shows the finger itself.
- **The picture above the keyboard.** While the phone's keyboard is up, the
  picture sits above it and above the room the app keeps for its own controls
  (`keyboardClearance`). Android follows the keyboard animation and keeps the
  pointer in sight; iOS follows the keyboard show/hide bounds.
- **Contained geometry.** Touch maps through the picture's actual placement.
  A one-finger drag starting in the letterbox does not move the pointer; a
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
- **The keys a phone lacks.** `modifiers`, `tapModifier` and `pressKey` give
  sticky Ctrl and Shift: tap arms one for the next key, tap again locks it.
  While one is armed, the next key or character the phone's keyboard types is
  sent as that key's chord, so Ctrl then v is Ctrl+V. The app draws the keys.
- **Readiness is a rendered frame.** Android marks the first draw; iOS marks
  the first `RTCView` video-dimensions callback and ignores later ones, so a
  resize or remount during a reconnect does not read as live. Neither marks
  a track or ICE connection as live.
- **Connection states, as they happen.** The session status is `idle`,
  `opening`, `connecting`, `live`, `reconnecting`, `ended` or `failed`. The
  peer's ICE state and the engine's `session.state` both feed it: a
  `disconnected` path reads as `reconnecting` within about a second of the
  drop — never a frozen picture that still says live — and a recovered path
  reads as `live` again once ICE is `connected`. `failed` stays terminal.
  Every event carries its engine session id where the carrier preserves it,
  and the session ignores anything naming a session it no longer holds, so a
  previous generation's queued offer or revocation cannot corrupt or kill a
  healthy recovery.
  Detection is two-layered: ICE and engine `session.state` events, plus the
  engine's twice-a-second control-channel heartbeat (`{"kind":"ping"}`) — a
  path that stops heartbeating reads as stalled within ~1.5 s even while ICE
  consent timers are still making up their minds, and resumed heartbeats read
  as recovered. Clients on engines that predate the heartbeat simply never
  arm that watchdog.
- **ICE restarts before reopens.** When the path drops after frames were
  shown, the session asks the engine (`session.restart_ice`) to re-offer on
  the same peer connection: the fresh offer arrives as the usual
  `session.description` event and is answered as usual, all without reopening
  the session. The first restart waits ~2 s for blips that heal alone;
  retries back off across ~60 s, so a 30–60 s outage still recovers when the
  network returns. Only a terminal `failed` reopens the session, and those
  reopens back off across ~60 s too instead of spending one attempt while the
  network is still down. Renegotiation transients from a restart the session
  asked for itself are expected, not a new outage: they neither flip the
  status nor trigger another restart for a short grace window.
- **Control starts off.** `setInputEnabled(true)` enables pointer, keyboard and
  clipboard input; `setInputEnabled(false)` blocks new input, releases held keys
  and buttons, and resets pending gestures. The app decides when to enable it
  after a deliberate action and must disable it on background or lost readiness;
  a clipboard write already in flight may still finish.
- **Released state.** The app disables input on background and unmount;
  session close and a lost control channel release what the desktop was holding.
- **Explicit clipboard.** Two methods, called on a user action while control is
  enabled. The package never polls the clipboard or uses it as a way to type.

### `Signaling`

The one thing the app must supply. It carries the engine's local protocol over
whatever authenticated channel the app already has:

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

## Licence

Apache-2.0. See `NOTICE`.
