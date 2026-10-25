<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/logo-light.svg" />
    <img src="docs/assets/readme/logo-light.svg" alt="desklink" width="260" height="52" />
  </picture>
</p>

<p align="center"><strong>A live, clickable desktop inside the app you already have.</strong></p>

<p align="center">For developers adding a remote desktop to their own app: the picture, clicks, keys and clipboard. Nothing else.</p>

<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/assets/readme/hero-phone-dark.webp" />
    <source media="(max-width: 600px)" srcset="docs/assets/readme/hero-phone-light.webp" />
    <img src="docs/assets/readme/hero.webp" alt="A short loop from the desklink browser client on a private demo desktop: a click places the caret in the open note, Paste to desktop sends this computer's clipboard over, and the line Call Umer about the cabin appears in the note. The footer reads Client 0.5.12 · Host 0.5.12." width="880" />
  </picture>
</p>

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#packages">Packages</a> · <a href="packages/desktop-host/README.md">Docs</a> · <a href="VISION.md">Vision</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@desklink/host"><img alt="npm version" src="https://img.shields.io/npm/v/@desklink/host?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/desklink/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/desklink/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Linux, macOS preview" src="https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20(preview)-111?style=flat" />
</p>

## Quick start

On a Linux x64 X11 desktop, with Node.js 22+:

```sh
npx @desklink/host bridge --source x11
```

Keep that terminal open. It prints an `open` link; open it in a browser on the
same computer. The desktop is live: click the picture, type, scroll, and copy
text in either direction. **Ctrl+C** ends the session.

On Wayland, run `npx @desklink/host bridge` and approve the screen-share prompt.
On macOS arm64 (preview), follow the [host setup guide](packages/desktop-host/README.md#install-and-run).
To put the view in a phone app, follow [put the desktop in a phone app](docs/quickstart-phone.md).

<details>
<summary>Not starting? Check what this computer can share</summary>

```sh
npx @desklink/host capabilities
```

It prints the capture backends, input injection, clipboard and audio options this
machine reports right now, so a missing portal, `uinput` permission or X display
shows up before a session is opened. The [host setup guide](packages/desktop-host/README.md#install-and-run)
covers what each one needs.

</details>

## Why desklink

- **Over a VNC or RDP server:** no second credential and no listening service of
  its own. The engine is a per-user process your app starts and stops, and it is
  not reachable at all unless your app opens a session.
- **Over a hosted remote-desktop service:** the session does not become someone
  else's session. Media is WebRTC between the two peers, carried over the relay
  you already run if the path needs one.
- **Over building it yourself:** capture, VP9 and H.264 encode, pointer and
  keyboard injection, explicit clipboard, the React Native view and an agent CLI
  are written, tested and Apache-2.0.

Desklink does not implement pairing, identity or signaling. Your app brings its
own, and keeps the last word on who gets in.

## What you get

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/assets/readme/browser.webp" alt="Browser reference client with the Reading list open on a private demo desktop." width="480" /><br/><strong>In your browser</strong><br/>Click, type and scroll. No client build needed.</td>
    <td width="50%" valign="top"><img src="docs/assets/readme/phone.webp" alt="React Native example app on a landscape Android emulator: a tap selects Groceries, with touch pointer and key controls visible." width="480" /><br/><strong>In your phone app</strong><br/>The React Native view, on an Android emulator.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="docs/assets/readme/agent.webp" alt="A close-up of the real agent CLI: read Groceries as text, click the Bread item, then press End." width="480" /><br/><strong>With your agent</strong><br/>Read the screen as text. Ask for pixels when needed.</td>
    <td width="50%" valign="top"><img src="docs/assets/readme/clipboard.webp" alt="The browser client copies Book the cabin by the lake from the desktop note, then pastes Call Umer about the cabin back into it." width="480" /><br/><strong>Keys and clipboard, too</strong><br/>Copy text over and send it back, only when you ask.</td>
  </tr>
</table>

All four are real captures from the demo lab, with seed notes on a private
desktop and an Android emulator. The loop above is 0.5.12 driving that desktop
through the browser client: a click, then a paste from this computer's clipboard.

- **Live, readable video** — sharp still text, smooth motion, and pinch to zoom on a phone.
- **Touch becomes a pointer** — tap, drag, scroll and type on the same desktop.
- **Your app owns access** — bring your connection; close sessions when access ends.
- **Share one window** — show a single window instead of the whole desktop; on Hyprland, taps land on that window.
- **Survives a network change** — a phone that moves from Wi-Fi to mobile data keeps the same session.
- **System audio on Linux** — opt in to capture what the computer plays.

## Proof

Measured on a physical phone against a 1920×1080 desktop, one quiet host, the
release engine and the example app from this repository:

| Scenario | fps (median of 1 s windows) | fps p05 | Excess latency p50 | p95 |
| --- | :-: | :-: | :-: | :-: |
| typing, keys sent to the desktop | **59.9** | 59.0 | **47 ms** | 66 ms |
| scrolling, swipes sent to the desktop | **59.8** | 59.3 | **38 ms** | 58 ms |

Read these as written: the transport was **USB**, not Wi-Fi, and the latency is
**excess over the fastest frame in the same run**, so the absolute floor is at
least 47 ms typing and 38 ms scrolling. The [full method, the receipt and what is
not verified](docs/phone-wifi-latency.md) sit next to the numbers.

Everything else here is a run you can repeat:

- **A click, round trip, with no display needed:** `node packages/desktop-host/test/encoded-flow.mjs` feeds a real Annex-B stream into the engine, decodes it in Chrome through the browser client, and checks that the click comes back as input.
- **A live desktop in a private lab:** the [done-done journeys](.done-done.yaml) open a desktop, click into it and check the picture that comes back.
- **Published packages:** [@desklink/host](https://www.npmjs.com/package/@desklink/host), [@desklink/react-native](https://www.npmjs.com/package/@desklink/react-native) and [@desklink/axi](https://www.npmjs.com/package/@desklink/axi) release together, currently 0.5.12 on protocol 3.

## Known limits

- **Linux x64 is the qualified target** (glibc 2.36 or newer, X11 or a Wayland compositor with the ScreenCast portal). **macOS arm64 is a preview.** **Windows is not supported.**
- **The clients have dark controls only.** There is no light or dark theme switch in the client yet.
- **The bridge token is full access.** `ws://` is plaintext: keep it on a private network, or put it behind TLS.
- **A phone with no UDP path to the computer** needs the opt-in ICE-over-TCP route; see [put the desktop in a phone app](docs/quickstart-phone.md#when-the-phone-has-no-udp-route-to-the-computer).
- **A phone app needs a development build.** The view is native code, so Expo Go is not enough.
- **On Wayland**, clipboard writes from the desktop need `wl-copy` from `wl-clipboard`.
- **No account, pairing or relay service of its own.** Those stay with your app; desklink implements none of them.
- **Wi-Fi glass-to-glass latency is not qualified yet.** The numbers above are USB, and the absolute floor is not measurable on that device.

## Packages

| Package | What it is | Install |
| --- | --- | --- |
| [@desklink/host](packages/desktop-host) | The engine and its CLI: capture, encode, input, clipboard, a local protocol, and a bridge that prints a browser link | `npm i @desklink/host` |
| [@desklink/react-native](packages/desktop-client) | The view for Android, iOS and web apps, with gestures, keyboard, clipboard and the signaling interface | `npx expo install @desklink/react-native` |
| [@desklink/axi](packages/axi) | An agent-facing CLI: read the screen as text or pixels, then click and type | `npm i @desklink/axi` |

<details>
<summary>How it fits your app's connection</summary>

The engine is a per-user process, not a service. Your application starts and
stops it, and carries the offer and answer over its own authenticated channel.

An application supplies pairing, identity and signaling transport through the
BYOKit kits — [@byokit/link](https://www.npmjs.com/package/@byokit/link) for pairing
and revocation, [@byokit/relay](https://www.npmjs.com/package/@byokit/relay) for the
relay, [@byokit/reach](https://www.npmjs.com/package/@byokit/reach) for reachable
addresses. Desklink implements none of those pieces; the app adapts its channel
to the client's [Signaling interface](packages/desktop-client/README.md#signaling).
The app maps each pairing to the sessions it opened; on revocation it explicitly
closes those sessions and refuses future opens from that pairing. Dropping
signaling alone does not revoke a retained bridge session. WebRTC media and input
use a separate session, with app-supplied `iceServers` when needed; a signaling
relay alone does not relay that traffic.

See [where each piece's responsibility ends](packages/desktop-host/docs/BOUNDARY.md)
and the [local protocol](packages/desktop-host/docs/PROTOCOL.md).

</details>

## More

| I want to… | Start here |
| --- | --- |
| Run or embed the desktop engine | [@desklink/host](packages/desktop-host) |
| Add a view to an Android, iOS or web app | [@desklink/react-native](packages/desktop-client) |
| Let an agent see and control a desktop | [@desklink/axi](packages/axi) |
| Understand the wire format | [Protocol](packages/desktop-host/docs/PROTOCOL.md) |
| Read the measured phone numbers | [Phone latency and frame rate](docs/phone-wifi-latency.md) |
| See what's changed | [Changelog](CHANGELOG.md) |
| See where desklink is headed | [Vision](VISION.md) |
| Report a problem or suggest an idea | [Issues](https://github.com/umeranjum17/desklink/issues) |

## Develop

<details>
<summary>Contribute and test safely</summary>

```sh
npm install
npm run build
npm test
npm run test:engine
```

Before opening a PR, repeat the tests your change adds or edits:

```sh
scripts/repeat-changed-tests.sh
```

On Linux, it compares against `origin/main` and finds changed engine `#[test]`
functions plus changed vitest test files. It runs each of them with half the
repeats pinned to one busy core, prints one line per test, and exits non-zero
on any failure. Engine tests default to 1000 repeats because their timing flakes
are rare; vitest files default to 20. Tests marked `#[ignore]`, including the
ones that need a task-owned lab compositor, are listed as skipped and never run.
`--runs N` and `--base <ref>` override the defaults.

Capture and input tests never touch a real display. They refuse ambient
`DISPLAY`/`WAYLAND_DISPLAY` before contact, and use one verified, task-owned
Xvfb lab at a time; `Xvfb -displayfd` can choose the live Xwayland `:0`. The labs
authenticate clients and verify Xvfb PID/socket ownership; cleanup never adopts an
unknown session-tagged PID. Compile checks need no desktop. On Linux, prove
refusal and owned teardown with:

```sh
env -u DISPLAY -u WAYLAND_DISPLAY npm run test:lab-safety
```

See the [done-done journeys](.done-done.yaml),
[AXI browser lane](packages/axi/README.md#browser-lane-opt-in-loopback-only), and
[release guide](packages/desktop-host/README.md#building-and-packing-a-release).

</details>

[Apache-2.0](LICENSE)
