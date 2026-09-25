# desklink

See and drive your own Linux desktop from somewhere else, over WebRTC, through a
channel your application already trusts.

| Package | What it is |
| --- | --- |
| [`@desklink/host`](packages/desktop-host) | The per-user engine: screen capture, VP9 encode, WebRTC, pointer/keyboard/clipboard input, behind a [versioned local protocol](packages/desktop-host/docs/PROTOCOL.md). A prebuilt engine ships for Linux x64 (glibc 2.36+). |
| [`@desklink/react-native`](packages/desktop-client) | A view and a session that render that desktop in a React Native app (Android, web) and turn touch, keyboard and clipboard into its input. |

Where each piece's responsibility ends is in
[docs/BOUNDARY.md](packages/desktop-host/docs/BOUNDARY.md).

## Try it

On a Linux x64 desktop session:

```sh
npx @desklink/host capabilities          # what this machine can do
npx @desklink/host bridge --listen 127.0.0.1:19400
```

Open the `open` URL it prints, and your desktop appears in a browser tab. The page
is [`examples/reference-client.html`](packages/desktop-host/examples/reference-client.html):
one file, no build step, a complete client of the protocol. Portal capture asks
the compositor for consent first; input needs [kernel input access](packages/desktop-host/README.md#kernel-input-access).

## Develop

```sh
npm install
npm run build          # compile @desklink/host
npm test               # the TypeScript packages' tests
npm run test:engine    # the Rust engine's tests; needs the native libraries CI installs
```

Releasing, including the reproducible engine build, is in
[packages/desktop-host/README.md](packages/desktop-host/README.md#building-and-packing-a-release).

## License

[Apache-2.0](LICENSE).
