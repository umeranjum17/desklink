# Phone numbers: what the J4 bar can and cannot be measured against today

Scorecard item J4 asks for real numbers from a physical phone on home Wi-Fi at
1080p: glass-to-glass under 50 ms at p50 and 70 ms at p95, 55 fps typing and
50 fps scrolling, holding on a loaded host, and 40 fps with p50 under 100 ms on a
4 Mbit link. This page records what was measured on a real phone, by what
method, and — as plainly — which parts of the bar are **not** verified, and why.

Nothing here is simulated and nothing is rounded in the product's favour. Where
the bar is not met or not resolvable, the real number and the reason are stated.

## The numbers

One run, one physical phone, one host, 1920×1080 desktop, `desklink-host`
release engine (`58ad04fb…`), stamp fixture (`3815e3d4…`), example app built
from this checkout (`b2ab2771…`). Host load was quiet for this run
(`/proc/loadavg` 7.98 before typing, 9.37 before scrolling); the phone was at 55%
battery, 31.5 °C.

| Scenario (1920×1080) | fps (median of 1 s windows) | fps p05 | Excess latency p50 | p95 |
| --- | --- | --- | --- | --- |
| typing (stamp only, keys sent to the desktop) | **59.9** | 59.0 | **47 ms** | 66 ms |
| scrolling (full-screen motion, swipes sent to the desktop) | **59.8** | 59.3 | **38 ms** | 58 ms |

**Transport: USB, not Wi-Fi.** The phone could not open a single connection to
this host over the network (both attempts below), so the harness pointed the
bridge at the phone through `adb reverse` and the session ran over USB. The
socket evidence agrees: during a live session the phone had no UDP peer at all,
and its only connections to this host were two established TCP connections to
`127.0.0.1` on the reversed bridge port. These are the phone's real decoded
frame counts, but they describe USB.

The full receipt, including every one of the 74+74 per-capture samples, is
[`phone-wifi-latency-run.json`](phone-wifi-latency-run.json).

Read the latency column exactly as written: it is **excess latency over the
fastest frame the harness saw in the same run** (each capture's difference from
the best one, clock-free). The absolute floor — what the fastest frame itself
cost — is not measurable on this device, for two reasons stated below. So the
absolute p50 is at least 47 ms typing and at least 38 ms scrolling, and could be
higher by an unknown amount.

Frame rate is not a qualified result for J4 either, because the transport in
this run was USB, not Wi-Fi (next section). It is, however, the phone's own
number: `framesDecoded` deltas from the app's inbound WebRTC statistics, posted
by the app itself, at one-second windows.

## Why the Wi-Fi leg did not run

The phone (192.168.1.68) and this host (192.168.1.144) share the home network and
ping each other, but this host's nftables ruleset (`/etc/nftables.conf`) has
`policy drop` on input and allows only icmp and sshd. The phone's TCP connect to
the bridge's port times out, and the run says so at preflight instead of hanging:

```
Error: the phone cannot reach 192.168.1.144:40031 over Wi-Fi (nc said 1);
this host drops inbound TCP except sshd (see /etc/nftables.conf),
so the Wi-Fi leg needs a firewall rule or another host
```

Two paths were tried before calling it unproven, one attempt each, as decided:

1. **Host-initiated outbound connection to the phone.** The only outbound path to
   the device that exists is adb, which is the USB transport the numbers above
   already describe. There is no server on the phone for the host to dial, and
   WebRTC still needs the device to reach the engine, so this path cannot carry
   the session.
2. **Both ends over Tailscale.** The phone is on the tailnet (as `honor-magic-v5`,
   currently 100.90.223.57) and this host is `extreme` at 100.124.161.1. A TCP
   connect from the phone to `100.124.161.1` timed out exactly like the LAN
   address did, because the nftables drop applies to every interface including
   `tailscale0`.

So no J4 Wi-Fi number exists, and the reason is recorded rather than worked
around. The USB run above was made so the harness itself is proven end to end on
real hardware, not as a substitute for the Wi-Fi leg.

## Why absolute latency is not claimed

Two independent problems, both properties of the environment rather than of the
product:

1. **The device clock and this host's disagree by more than the latency.** The
   phone's own `date`, paired with the moment its answer arrives here, puts it
   380 ms behind this host. The stamps in its picture and the capture times
   around them imply about 460 ms. That 80 ms gap is larger than the 50 ms the
   bar asks about, so any absolute figure would be reporting the clocks, not the
   product. The run publishes both answers instead of picking one.
2. **The capture window is wide.** `screencap` on this phone takes about 203 ms
   (p95 224 ms) from before the grab to after it, measured on the device in the
   same run. The harness reports the midpoint as its estimate and the half-window
   as its per-sample uncertainty (±93 ms). `screenrecord`, which would give exact
   device-side presentation timestamps, cannot be used here: on this device it
   runs in its own SELinux domain (`screen_record`) that cannot open a file
   anywhere adb can write, so it fails with `EACCES` on every path tried.

Together these mean this host cannot resolve glass-to-glass on this phone to
better than roughly ±90 ms, which is wider than the bar it would have to certify.
The relative numbers above are what survives.

## The 4 Mbit leg: shaped in user space, and why it still proves nothing

Kernel netem needs `CAP_NET_ADMIN`, which this host does not grant:

```
$ tc qdisc add dev eno1 root netem rate 4mbit
RTNETLINK answers: Operation not permitted
```

So the harness grew `--relay-rate 4mbit`: a userspace token bucket in front of
the bridge, on the connection the device already uses. It is labelled
`userspace token bucket (not kernel netem)` in every receipt it writes, and its
result is **not** published as a 4 Mbit number, because the measurement says so:

| Run | fps (median, p05) | size | Excess latency p50 | p95 |
| --- | --- | --- | --- | --- |
| 4 Mbit, userspace-shaped, scrolling | 59.8 (59.3) | 960×540 | 45 ms | 57 ms |

59.8 fps is the *unshaped* rate. A real 4 Mbit link at this resolution cannot
deliver 60 fps, so the shaped run proves the media does not ride the bridge
connection the relay sits on. The 4 Mbit media leg therefore stays unproven: no
privilege-free path tried reaches the media.

## Method

[`packages/desktop-client/test/phone-g2g-flow.mjs`](../packages/desktop-client/test/phone-g2g-flow.mjs)
is the harness, and it is the whole method:

```sh
CARGO_TARGET_DIR=~/.cache/desklink-target cargo build --release \
  --manifest-path packages/desktop-host/engine/Cargo.toml \
  --bin desklink-host --example stamp_target
cd packages/desktop-client/example \
  && npm install && npx expo prebuild --platform android --no-install \
  && (cd android && ./gradlew --no-daemon assembleDebug)
cd -
ANDROID_SERIAL=a4b93ea2 DESKLINK_ANDROID_HOST=192.168.1.144 \
  node packages/desktop-client/test/phone-g2g-flow.mjs \
    --scenarios typing,scroll --fps-seconds 10 --latency-seconds 15
```

Every adb call in the run happens under the test phone's lock:

```sh
/home/umer/firstmate/config/fm-device-lock.sh a4b93ea2 node packages/desktop-client/test/phone-g2g-flow.mjs ...
```

How each number is produced:

- **The host** is a private Xvfb (`:170`+) at 1920×1080, `WAYLAND_DISPLAY` empty,
  showing the `stamp_target` example: its top 48 rows are 24 black-or-white
  blocks encoding `CLOCK_REALTIME` milliseconds, low 24 bits — the same stamp the
  browser lab reads. `desklink-host bridge` serves it over the network. Host load
  (`/proc/loadavg`) and phone battery and temperature are recorded per leg.
- **Frame rate** is the app's own inbound-rtp `framesDecoded`, sampled once a
  second by the app and posted to the harness. It is the phone's count of frames
  it decoded and showed, not an estimate.
- **Latency** comes from reading that stamp back out of the phone's screen. The
  app's JavaScript arrives over USB (`adb reverse`), because a debug build loads
  its bundle from Metro; the media path (engine, network, decoder, display) is
  the one under test. Each capture is `screencap` to a device file, timestamped on
  the device immediately before and after, so no adb round trip enters the
  arithmetic.
- **Geometry is read from each frame, not assumed.** The app shrinks, pans and
  crops the picture (keyboard, safe-area insets, tablet layout), so the harness
  finds the picture's bright band, then tries every plausible block pitch and
  left edge against a sample of captures. A configuration only wins if it reads
  the strip in most frames, its stamps advance, and the capture times they pair
  with cluster together. The winning pitch is recorded per leg
  (`strip_geometry`): 26.5 px for a full-width picture, 13.5 px when the phone
  shows a half-width one.
- **The clock offset is measured per leg**, before and after the captures, by
  pairing each `adb shell date` with the moment its answer arrives — not by the
  usual midpoint round trip, which on this phone puts its ~100 ms shell startup
  entirely on one side, an error larger than the quantity being measured.
- **Everything the harness could not measure is named**, not dropped: unreadable
  captures, clock steps, and the capture window's own cost all appear in the
  receipt.

## What would close J4

1. A host the phone can reach — one without the input drop, or a phone and host
   pair on a network that accepts inbound TCP — then the same command with
   `--transport wifi`.
2. A shaping path that reaches the media rather than the bridge connection: a
   router that can shape the Wi-Fi link, or a TURN relay in front of the session.
3. A way to read device-side frame presentation times — a `screenrecord` that can
   write a file, or root on the phone — to remove the ±93 ms capture window, and
   a phone whose clock agrees with the host's to better than 50 ms, to make the
   absolute number measurable at all.
