# Put the desktop in a phone app

The React Native view is native code, so it needs a development build, not Expo
Go. This walkthrough is the shortest path to a live desktop on a phone.

## 1. Start the bridge where the phone can reach it

On the computer whose desktop you want to share, on a private network:

```sh
npx @desklink/host bridge --listen 0.0.0.0:19400 --source x11
```

It prints the URL and the token. Keep both; `ws://` is plaintext and the token is
full access, so keep this to a private network or put it behind TLS and use
`wss://`. On Wayland, drop `--source x11` and approve the screen-share prompt.

## 2. Make an app with the view in it

Expo SDK 55 and later are supported. One `expo install` adds the view, its
WebRTC binding, the [`@byokit/signaling`](https://www.npmjs.com/package/@byokit/signaling)
WebSocket adapter for the bridge, and both config plugins to `app.json`:

```sh
npx create-expo-app@latest desklink-quickstart --template blank-typescript
cd desklink-quickstart
npx expo install @desklink/react-native react-native-webrtc @config-plugins/react-native-webrtc@15 @byokit/signaling@0.1.0
```

Replace `App.tsx` with this, putting in the computer's address and the token the
bridge printed:

```tsx
import { useEffect } from 'react';
import { Button, View } from 'react-native';
import { authorizeBridge } from '@byokit/signaling';
import { DesktopView, useDesktopSession } from '@desklink/react-native';

const BRIDGE = 'ws://192.168.1.20:19400/desktop?token=PASTE_THE_TOKEN';
const authorize = authorizeBridge(BRIDGE, {});

export default function App() {
  const desktop = useDesktopSession({ authorize });
  const { status, failure } = desktop.snapshot;
  useEffect(() => desktop.setInputEnabled(status === 'live'), [status]);
  return (
    <View style={{ flex: 1, backgroundColor: 'black', paddingVertical: 48 }}>
      <DesktopView sessionId={desktop.nativeId} style={{ flex: 1 }} />
      {status !== 'live' && (
        <Button title={failure ? `Retry (${failure.code})` : status === 'idle' ? 'Connect' : status}
          onPress={() => void desktop.connect()} />
      )}
    </View>
  );
}
```

## 3. Run it

```sh
npx expo run:android    # or: npx expo run:ios
```

Tap Connect, approve the screen-sharing prompt if the computer shows one, and the
desktop appears. Tap it to click; the view also takes drag, scroll, pinch, the
keyboard, the clipboard and safe-area options.

## When the phone has no UDP route to the computer

An SSH tunnel or `adb reverse` carries TCP only, and the engine's own addresses
are UDP, so nothing connects and the view stays empty. Ask for the loopback route
instead:

```tsx
const authorize = authorizeBridge(BRIDGE, { loopbackTcp: true });
```

The engine then also offers ICE over TCP on `127.0.0.1` and the existing forward
carries it; a phone with a UDP path is unaffected, because ICE always prefers UDP
when it has one. The engine picks that port per session, so the forward has to
follow it: `adb reverse tcp:<port> tcp:<port>` or
`ssh -L <port>:127.0.0.1:<port> <computer>`, with `<port>` taken from the
`session.candidate` the engine offers. A session that shows no picture within 20
seconds says so, instead of leaving a black screen.

## Next

- Every gesture, keyboard, clipboard and safe-area option: [the receiver package](../packages/desktop-client/README.md#what-the-package-guarantees).
- Pairing, relay and reachable addresses: [@byokit/link](https://www.npmjs.com/package/@byokit/link), [@byokit/relay](https://www.npmjs.com/package/@byokit/relay), [@byokit/reach](https://www.npmjs.com/package/@byokit/reach).
- What the engine does below this: [the host package](../packages/desktop-host/README.md).
