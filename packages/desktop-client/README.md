# @desklink/react-native

Show a live desktop in a React Native app, and drive it from the phone.

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
  extra mark when a mouse is attached.
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
  wheels. Android coalesces pending pointer moves under congestion.
- **The keys a phone lacks.** `modifiers`, `tapModifier` and `pressKey` give
  sticky Ctrl and Shift: tap arms one for the next key, tap again locks it.
  While one is armed, the next key or character the phone's keyboard types is
  sent as that key's chord, so Ctrl then v is Ctrl+V. The app draws the keys.
- **Readiness is a rendered frame.** Android marks the first draw; iOS uses
  `RTCView`'s native video-dimensions callback, which fires after a decoded
  picture arrives. Neither marks a track or ICE connection as live.
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
`session.close`; `SessionEvent` is the engine's offer, candidates, state and
revocation. Pixels and input do **not** use this channel — they are the
desktop's own WebRTC session.

## Licence

Apache-2.0. See `NOTICE`.
