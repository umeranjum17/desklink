<h1 align="center">desklink</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@desklink/host"><img alt="npm" src="https://img.shields.io/npm/v/@desklink/host?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/desklink/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/desklink/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Linux; macOS behind DESKLINK_MACOS" src="https://img.shields.io/badge/Linux%20%7C%20macOS%20behind%20DESKLINK__MACOS-111?style=flat" />
</p>

<p align="center">
  <strong>Your own desktop, live in a browser or an app, over a channel you already trust.</strong><br/>
  desklink captures a Linux desktop, encodes it, carries it over WebRTC and applies the viewer's pointer, keyboard and clipboard back to the same desktop. It is a per-user process with a documented local protocol, not a service: no account, no pairing ceremony, no second identity system. Your application carries the offer and answer over the connection it already has, and a React Native view and an agent CLI sit on the same engine.
</p>

<h3 align="center"><a href="#try-it"><ins>Try it in one command</ins></a></h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@desklink/host">@desklink/host on npm</a> ·
  <a href="https://www.npmjs.com/package/@desklink/react-native">@desklink/react-native on npm</a> ·
  <a href="packages/axi">@desklink/axi</a> ·
  <a href="packages/desktop-host/docs/PROTOCOL.md">The protocol</a>
</p>

<p align="center">
  <picture><source srcset="docs/assets/readme/hero.webp" type="image/webp"><img src="docs/assets/readme/hero.jpg" alt="The reference client in a browser showing a private desktop live: the pointer picks notes in a notes app, clicks into a checklist, types a new line and presses Save" width="960" /></picture>
</p>

## Install

```sh
npm install @desklink/host               # the engine
npx expo install @desklink/react-native  # the view and session
```

| Package | Latest | Unpacked size | Release tag |
| --- | --- | --- | --- |
| `@desklink/host` (plus the `@desklink/host-linux-x64-gnu` platform package) | 0.2.0 | ~1.1 MB (platform package ~17 MB) | [`desklink-host-v0.2.0`](https://github.com/umeranjum17/desklink/releases/tag/desklink-host-v0.2.0) |
| `@desklink/react-native` | 0.2.0 | ~266 KB | [`desklink-react-native-v0.2.0`](https://github.com/umeranjum17/desklink/releases/tag/desklink-react-native-v0.2.0) |

The npm version badges at the top of this page track the registry, so they never go stale. npm verifies each package's integrity on install, so there is no separate checksum to copy. The GitHub releases carry no attached assets — npm is the distribution channel: [latest release](https://github.com/umeranjum17/desklink/releases/latest).

Supported platforms: Linux x64 with glibc 2.36 or newer (prebuilt engine); macOS stays behind `DESKLINK_MACOS=1` with a source build and has no published platform package yet.

`@desklink/axi` is not published yet — build it from source as its [README](packages/axi/README.md#install) describes.

## Why desklink exists

Reaching your own computer from somewhere else usually means handing it to someone else's service: an account, a relay, a pairing flow, and a second identity system beside the one your application already has. desklink turns that inside out. The engine runs as you, starts when asked and stops when told, and trusts the application that started it to decide who may see the desktop.

What it does own is the hard middle: capture with the compositor's consent, a real-time encoder tuned for text that has to stay readable on a phone, WebRTC transport, and input and clipboard that reach only the session they were granted to. An application that needs an account, a relay or a pairing flow adds those through the BYOKit kits — [@byokit/link](https://www.npmjs.com/package/@byokit/link) for pairing, [@byokit/relay](https://www.npmjs.com/package/@byokit/relay) for the relay, [@byokit/reach](https://www.npmjs.com/package/@byokit/reach) for reachable addresses — desklink itself implements none of them.

## See it in action

### A desktop in a browser tab

`desklink-host bridge` re-serves the engine over a WebSocket and serves the reference client, one HTML file with no build step. Open the URL it prints and the desktop is live: click, type and scroll on the picture, open the on-screen keyboard, and copy or paste when the capture source supports the clipboard.

<p align="center">
  <picture><source srcset="docs/assets/readme/reference-client.webp" type="image/webp"><img src="docs/assets/readme/reference-client.jpg" alt="The reference client showing a private desktop live: a notes app with a new line typed through the browser" width="720" /></picture>
</p>

### The same desktop in a React Native app

`@desklink/react-native` is a view and a session, not a screen: it draws the picture, turns touch into a desktop pointer the phone can see, and leaves the buttons to the app. Below, its web build in a landscape phone viewport: a tap selected the note, the drawn pointer shows where it landed, and the key row is the app's own, using the package's sticky modifiers.

<p align="center">
  <picture><source srcset="docs/assets/readme/react-native.webp" type="image/webp"><img src="docs/assets/readme/react-native.jpg" alt="The React Native view in a phone-sized landscape viewport: the desktop fills the view with a large drawn pointer, above an app-drawn row of Ctrl, Shift, Esc, Tab and Keyboard keys" width="640" /></picture>
</p>

### A desktop an agent can drive

`desklink-axi` gives a coding agent the desktop as text first: OCR items with refs it can click, changed regions since the last look, and pixels only when it asks for a crop. This is one agent turn on the same private desktop, trimmed:

```text
$ desklink-axi screen --query "Reading list"
screen: 1280x720 frame=58 settled=true estimated_tokens=~12
text[1 of 1]{ref,text,x,y}:
  "@58.10","Reading list",15,310
$ desklink-axi click @58.10 --wait settle
input: applied; frame: ready
$ desklink-axi screen --query typography
text[1 of 1]{ref,text,x,y}:
  "@72.14","- Abook on typography",309,163
$ desklink-axi click @72.14
$ desklink-axi press End
$ desklink-axi type $'\n- Notes on remote desktops' --wait settle
input: applied; frame: ready
$ desklink-axi diff
changed: 2 region since frame 72
appeared[3 of 3]{ref,text,x,y}:
  "@78.15","- Notes on remote desktops|",310,187
$ desklink-axi look --region 288,60,420,170
region: 288,60,420,170 cost: ~95 tokens to view
```

<p align="center">
  <picture><source srcset="docs/assets/readme/axi-look.webp" type="image/webp"><img src="docs/assets/readme/axi-look.jpg" alt="The crop the agent asked for: the Reading list note with the line it just typed" width="422" /></picture>
</p>

### Measured, not guessed

A glass-to-glass lab runs the engine against a private X display showing a stamp window: its top row encodes the wall clock at the moment it was painted, and a headless browser decodes that stamp from every presented frame, so latency is measured from pixel to pixel. When the current motion encoder landed, the lab measured, at 60 fps maximum on a shared 32-thread host (load 26–76), median of four interleaved runs ([the numbers and method](https://github.com/umeranjum17/desklink/pull/28)):

| Scenario | fps | Glass-to-glass p50 | p95 |
| --- | --- | --- | --- |
| 1920×1080, typing | 52.3 | 41.5 ms | 53 ms |
| 1920×1080, full-screen motion | 54.6 | 46 ms | 60.5 ms |
| 2560×1440, full-screen motion | 42.0 | 56.5 ms | 71 ms |

Load moves these numbers, which is why every lab run records it: rerun for this page on a host at load 125–140, 1080p typing measured 26.5 fps and 95 ms p50, and full-screen motion 9.5 fps and 288 ms p50. [`portal-g2g-flow.mjs`](packages/desktop-host/test/portal-g2g-flow.mjs) measures the ScreenCast portal and PipeWire path the same way, inside a private namespace cage.

<p align="center">
  <picture><source srcset="docs/assets/readme/lab.webp" type="image/webp"><img src="docs/assets/readme/lab.jpg" alt="The lab's stamp window seen through the reference client: a top row of black and white clock blocks above a full-screen field of moving marks" width="560" /></picture>
</p>

## Packages

| Package | What it is |
| --- | --- |
| [`@desklink/host`](packages/desktop-host) | The per-user engine: screen capture, VP9/H.264 encode, WebRTC, pointer/keyboard/clipboard input, behind a [versioned local protocol](packages/desktop-host/docs/PROTOCOL.md). A prebuilt engine ships for Linux x64 (glibc 2.36+). |
| [`@desklink/react-native`](packages/desktop-client) | A view and a session that render that desktop in a React Native app (Android, iOS, web) and turn touch, keyboard and clipboard into its input. |
| [`@desklink/axi`](packages/axi) | A [desktop CLI](packages/axi/README.md) for agents: text and changed regions by default, image crops on request. |

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
npm run build          # compile @desklink/host and @desklink/axi
npm test               # the TypeScript packages' tests
npm run test:engine    # the Rust engine's tests; needs the native libraries CI installs
```

Releasing, including the reproducible engine build, is in
[packages/desktop-host/README.md](packages/desktop-host/README.md#building-and-packing-a-release).

The pictures on this page are real captures from a private X display, never the
machine's own desktop, and live in [`docs/assets/readme/`](docs/assets/readme).

## License

[Apache-2.0](LICENSE).
