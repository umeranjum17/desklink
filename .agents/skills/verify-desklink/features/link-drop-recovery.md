# The client recovers from a dropped link

## Sub-features

The network drops mid-session. The client notices, does not hang and does not
die, keeps the last picture on screen, and once the link comes back it is
showing the live desktop again with control working. A slow link degrades the
picture without losing it.

## How to get to it (user POV)

Open a desktop from the phone, lose Wi-Fi for a few seconds, and the screen
must not blank out or wedge: it shows the last picture, comes back on its own,
and taps work again. For verification, never cut a real network; shape a
private one.

## How the link is shaped, and what it is called

A **userspace-shaped link**: a `dgram` relay inside the flow, sitting between
Chromium's ICE agent and the engine's, forwarding every datagram itself and
choosing per datagram to forward it now, forward it after a delay, or discard
it. It is **not** kernel netem, **not** `tc`, **not** an iptables or nftables
rule, and it needs no sudo, no root, no firewall rule and no change to the host
firewall. Say "userspace-shaped link" in every report about it; never "netem".

The relay rewrites the ICE candidates that cross the signalling channel, so the
two peers only ever see a loopback socket the relay owns. Two sockets, one per
direction, and every datagram leaves from the *other* one — that is what keeps
the directions apart, and it is written up at length in the flow's own header
because the obvious design silently works until the first drop.

The signalling WebSocket is deliberately **not** cut: it is the application's
channel, and the client's recovery surface is the ICE restart and reopen it
drives over it. What is cut is the WebRTC link, media and data channel both.

## Driving it

```sh
npm run build
cargo build --manifest-path packages/desktop-host/engine/Cargo.toml --example x11_target
env -u DISPLAY -u WAYLAND_DISPLAY \
  node packages/desktop-client/test/link-drop-flow.mjs "$HOME/lab-tmp/dl-pm-8-recovery/<run>"
```

The flow owns a private Xvfb, the `x11_target` fixture on it, the engine, a
vite page built from the client's **own** `useDesktopSession` plus
`native.web.ts`, and Chromium. Four stages, one capture each:

| Stage | What is asserted |
|---|---|
| live | `status: live`, frames advancing, decoded picture not black |
| throttled | 400 ms added per datagram; the relay's own delayed-datagram count grows, the frame rate drops, the picture stays up, the session stays live |
| dropped | every datagram discarded; `reconnecting` within seconds, the relay forwarded zero datagrams while discarding traffic, the page still answers with the last picture held, no page error |
| recovered | frames advance again, status `live` again, the fixture's moving marker moves again, and a pointer the page sends is reported by the desktop itself |

## Gotchas

- The client's `getStats` withholds network addresses and the round trip with
  them, by design. Do not assert a latency number from it; assert the relay's
  own counters and the frame rate instead.
- Chrome hides its candidates behind mDNS unless the browser is launched with
  `--disable-features=WebRtcHideLocalIpsWithMdns`. Without it the relay has no
  address to forward to.
- A relay that keeps the browser's *first* seen address fails after a drop, not
  before: an ICE restart rebinds the browser's socket too. Follow the latest,
  with a small stickiness so two live sockets do not flap.
- Advertise exactly one candidate per peer per session. Two remote candidates
  make the engine run two browser sockets at once and nothing settles.
- Expect recovery through a session *reopen*, not an in-session ICE restart: the
  engine's own consent takes about 30 s to declare a silent path lost, so a cut
  shorter than that always ends in a reopen. That is the client's designed path,
  not a defect — but a report must not claim an ICE restart healed it.
