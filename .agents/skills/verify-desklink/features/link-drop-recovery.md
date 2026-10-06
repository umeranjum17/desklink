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
drives over it. The whole-link stage cuts the WebRTC link, media and data
channel both.

A second stage cuts **only the media**: the relay drops RTP and RTCP (the first
byte is `0x80`–`0xBF` for both, while STUN leads with `0x00`–`0x03` and DTLS
with `0x14`–`0x19`) and forwards everything else. Signalling, ICE consent and
the control channel stay up, so the transport keeps saying everything is fine
while the picture is stopped — the only case where a client has to read the
media path itself to know it is not live.

## Driving it

```sh
npm run build
cargo build --manifest-path packages/desktop-host/engine/Cargo.toml --example x11_target
env -u DISPLAY -u WAYLAND_DISPLAY \
  node packages/desktop-client/test/link-drop-flow.mjs "$HOME/lab-tmp/dl-pm-8-recovery/<run>"
```

The flow owns a private Xvfb, the `x11_target` fixture on it, the engine, a
vite page built from the client's **own** `useDesktopSession` plus
`native.web.ts`, and Chromium. Six stages, one capture each:

| Stage | What is asserted |
|---|---|
| live | `status: live`, frames advancing, decoded picture not black |
| media-frozen | only RTP/RTCP dropped; decoded frames stop while signalling and control keep working, the status leaves `live`, the picture is held, and a pointer sent now still lands on the desktop |
| media-restored | frames advance again within a second on the **same** session, status `live`, the fixture's marker moving again |
| throttled | 400 ms added per datagram; the relay's own delayed-datagram count grows, the frame rate drops, the picture stays up, the session never fails |
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
- What a cut heals through, measured: with the link cut and then restored, the
  receipt shows `sessionOpens: 1` and frames advancing again about half a second
  after forwarding resumed — the same session coming back, not a reopen. A
  claim that a cut *always* ends in a session reopen is wrong and came from an
  earlier, faulty measurement (see below); do not repeat it.
- **Do not claim more mechanism than the evidence supports.** The flow asserts
  what the receipt shows: the status left `live`, the relay forwarded zero
  datagrams while discarding traffic, frames advanced again on the *same*
  session, and control worked. It does not assert which internal mechanism
  produced that — it never counts `session.restart_ice` calls. Say "the same
  session came back", and leave the mechanism to the client's own README.
- The client's README describes a restart-with-backoff path that spans about a
  minute. That is the client's general behaviour and is **not** what this
  journey measures: an 8 s cut here heals far faster than that schedule, so the
  two documents are about different situations and neither contradicts the
  other. Do not "fix" the README to match this page, or the reverse.
- The relay is one path, not the only one: the engine's offer carries its real
  host candidates as well as the trickled ones, so the two peers also reach each
  other directly. A whole-link cut of the relay therefore does **not** stop the
  picture — measured, frames keep advancing through it and `live` is correct.
  To stop the picture, cut the media (see above); to prove the relay's own path,
  assert its counters.
- Count decoded frames from the session's own `getStats`
  (`framesDecoded`/`packetsReceived`), never from the page. `requestVideoFrameCallback`
  and `getVideoPlaybackQuality().totalVideoFrames` both keep climbing on a dead
  media path, because the renderer re-presents the frame it already holds.
- Measure a cut at the relay, never in the browser. A renderer keeps presenting
  frames it already holds for a while after the last datagram arrives, so a
  frame counter read through a cut measures the jitter buffer, not the link —
  and that is how an earlier version of this flow "passed" a cut while counting
  ~65 frames of pure buffer. It also made a healthy recovery look like a 27 s
  session reopen, which is the wrong claim this page used to carry.
