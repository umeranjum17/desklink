# desklink local control protocol (v3)

The host engine is a per-user, on-demand process. A consumer that already owns
the user's session starts it and talks to it over an inherited private channel —
the engine never opens a public listener, never runs as root, and never installs
a service.

This document describes the shared Linux and macOS engine protocol. The macOS
engine uses the same v3 stdio/WebRTC session path, with native display capture,
input and clipboard adapters. The protocol contains no application concepts:
no accounts, no chat, no machine ids, no pane ids.

## Starting the engine

```
desklink-host serve
```

The consumer spawns this process, keeps its `stdin`/`stdout` and parses them as
newline-delimited JSON. `stdout` carries protocol messages only; diagnostics go
to `stderr`. One JSON object per line, no length prefix, UTF-8.

Why stdio rather than a socket: the consumer already holds the process, so the
channel inherits the consumer's own access control (same uid, same session, no
filesystem permission to get wrong) and no second authorization mechanism has to
exist. A consumer that wants a socket can wrap this process. (A screen that
needs no protocol at all — a private `Xvfb` whose windows should simply be kept
in order and reported — can run the engine as a display keeper instead; see
"Display keeper" below.)

Cancellation is by closing the consumer's end. The engine treats EOF on `stdin`
exactly like `shutdown`: it releases held input, stops capture, closes peers, and
exits.

## Message shape

Requests (consumer → engine) carry an `id`; responses repeat it. Engine-initiated
notifications carry `event` and never an `id`.

```jsonc
// request
{"id": 7, "method": "session.open", "params": { }}
// success
{"id": 7, "result": { }}
// failure — the request was refused or could not run
{"id": 7, "error": {"code": "unsupported-source", "message": "human readable"}}
// notification
{"event": "session.state", "params": { }}
```

`error.code` is a stable machine token; `message` is for logs, not for display.

Every engine notification carries the `sessionId` it belongs to, so a consumer
that has served more than one session in a process can attribute it to the
right one.

Request parameters use the engine's own snake_case names (`session_id`,
`max_width`, `sdp_mid`, …); the examples below are the wire names to send.

## Handshake

```jsonc
{"id":1,"method":"hello","params":{"protocol":3}}
```

Result:

```jsonc
{"protocol":3,"engine":"desklink-host/0.2.0","platform":"linux", /* the rest of Capabilities */ }
```

The consumer must send `hello` first, and a version the engine does not speak is
refused with `error.code = "unsupported-protocol"`. Until a supported `hello`
arrives, every other request is refused the same way; `capabilities` and
`shutdown` are the two that answer without a handshake.

## macOS

macOS speaks protocol 3 and shares the session lifecycle below. It captures the
selected display with ScreenCaptureKit, encodes VP9, and uses the same WebRTC
offer, ICE, control-channel, lease, and metrics flow as Linux. Capture currently
uses one bounded ScreenCaptureKit stream (three-frame queue); the backend may
supply fewer frames. Audio is not captured.

`capabilities` is non-prompting and reports active displays (pixel and point
dimensions, origin and scale), the current keyboard layout, console state, and
Screen Recording/Accessibility grant states. A `display` source accepts an
optional `display_id` from `capture.displays`; an absent ID selects the main
display. Screen Recording consent is requested by `session.open` when capture
is needed. Control may request Accessibility consent; if it remains unavailable,
open fails with `input-unavailable`. TCC permissions attach to the responsible
launching app (for example Terminal, iTerm, or the Node.js host), not to a
separate DesklinkHost.app bundle. Enable that app in **System Settings → Privacy
& Security → Screen & System Audio Recording** and **Accessibility**, then
reconnect. No TCC state is pre-seeded or bypassed.

macOS clipboard read/write is plain text and requires the session's `clipboard`
permission. `restore_token` is not supported by this native backend; a new
session may require fresh consent. The macOS engine requires a VP9-enabled build
(`DESKLINK_VPX_STATIC_DIR`) for `serve`.

## Capabilities

```jsonc
{"id":2,"method":"capabilities"}
```

```jsonc
{
  "protocol": 3,
  "engine": "desklink-host/0.2.0",
  "platform": "linux",
  "session": {"kind": "wayland"},
  "x11": {"available": true, "size": [2560, 1440]},
  "capture": {
    "mechanism": "portal-screencast+pipewire",
    "backends": ["portal-screencast+pipewire", "x11-root"],
    "formats": ["bgrx", "bgra", "rgbx", "rgba"],
    "cursor": "embedded",
    "audio": false
  },
  "encode": {"codecs": ["vp9"], "hardware": false},
  "input": {
    "mechanism": "inputtino/uinput",
    "pointer": true, "wheel": true, "keyboard": true,
    "text": ["layout-reachable"],
    "layout": "us",
    "unavailable_reason": null,
    "grant": "granted"
  },
  "clipboard": {"read": true, "write": true, "mime": ["text/plain;charset=utf-8"], "maxBytes": 262144},
  "encoded": {"codecs": ["h264"]}
}
```

`encoded` lists the codecs this build will carry when the consumer supplies the
video itself (see *Encoded sources*): a consumer reads it rather than inferring
support from the engine's version string.

`input.mechanism` names the build's portal input path, `inputtino/uinput`,
where the engine creates its own virtual devices. A session opened against an X
display applies input through XTest instead, where the X server applies the
events and nothing the engine does can reach another session's keyboard.
`input.layout` is the keymap the engine compiled for typing, taken from the
session's `XKB_DEFAULT_*` variables and `us` on `evdev`/`pc105` when it exports
none. It is not yet the compositor's live layout, so a mismatch with the
desktop is visible here rather than silent. `capture.backends` lists what this
build has, not what this machine can necessarily use.

`input.unavailable_reason` and `input.grant` describe the portal/uinput path:
without kernel input access a portal session may request `view`, but an open
requesting `control` is refused. X display capture uses XTest instead and does
not require that grant. The muxr host and WebSocket bridge report clipboard
unavailable for an X display, regardless of the engine's Wayland clipboard
probe. On Linux the engine never asks for privileges on its own; macOS may
request Screen Recording or Accessibility consent at `session.open`.

`capabilities` is safe to call before any consent has been given and must not
trigger a capture request.

## Opening a session

```jsonc
{"id":4,"method":"session.open","params":{
  "source": {"kind":"portal"},          // or {"kind":"x11","display":":99"}
                                           // macOS: {"kind":"display","display_id":123}
                                           // or {"kind":"encoded","codec":"h264","width":486,"height":1080}
  "permissions": ["view","control","clipboard"],
  "max_width": 3840, "max_height": 2160, // encode box (default); never upscales
  "bitrate_kbps": 0,                    // 0 (default): sized to the encoded surface
  "max_fps": 30,
  "ice_servers": [{"urls":["stun:..."],"username":null,"credential":null}],
  "restore_token": null,                // from a previous session.restoreToken
  "ttl_seconds": 3600,                 // session lease; default 3600
  "loopback_tcp": false,               // also offer ICE over TCP on 127.0.0.1; default false
  "agent_indicator": false             // local input feedback; default false (phone control)
}}
```

Result:

```jsonc
{"sessionId":"<opaque>","generation":1,
 "source":{"kind":"monitor","width":2560,"height":1440,"origin":{"x":0,"y":0}},
 "geometry":{"source":{"width":2560,"height":1440},
             "encoded":{"width":2560,"height":1440},
             "origin":{"x":0,"y":0}}}
```

`source` selects the desktop. `portal` (or absent) asks the compositor for a
screen cast, which is the only path that carries a Wayland user's consent;
`x11` reads a named X display's root window and applies input through XTest;
`display` selects a macOS display by the ID reported in capabilities (or the
main display when omitted); `encoded` carries video the consumer encoded itself.
The choice is normally the *consumer's* decision, because a client is not in a
position to know which backend a machine can offer.

`permissions` are the engine's authority for this session. `view` is required
to open a session. The engine enforces the remaining scopes on every input and
clipboard action and never infers them from a source, a peer or an SDP.
`control` without a working input backend is refused at `session.open` with
`error.code = "input-unavailable"` — the consumer must ask for `view` explicitly instead.

`max_fps` defaults to 30 and is bounded to 1–60. It caps the encoded frame
rate and X11 capture loop; portal capture offers it as the preferred PipeWire
frame rate, and macOS sets its ScreenCaptureKit stream minimum frame interval.
A source may still supply fewer frames.

`agent_indicator` is opt-in local feedback for an agent controller; desklink-axi
sets it for control sessions, never for view-only or human phone control. It
adds an eased pointer halo, click ripple, and typing pulse. On Wayland it uses
a click-through layer-shell surface with an edge glow; its bounded area is
masked before capture/diff (pixels behind the effect can remain briefly stale).
On bare X11 it replaces the pointer sprite instead, which XGetImage excludes:
there is no edge glow on that path. macOS uses a nonactivating, click-through
window excluded by the ScreenCaptureKit content filter. Closing the session
fades and removes the indicator.

`session.open` is where the capture request happens, which is where the user's
consent appears. It is not implicit and it is not retried silently.

### Description and ICE exchange

The engine is the media offerer; the consumer's authenticated signaling carries
the SDP and candidates to the client and brings back the answer.

```jsonc
{"event":"session.description","params":{"sessionId":"…","generation":1,
  "description":{"type":"offer","sdp":"v=0\r\n…"}}}
```

```jsonc
{"id":5,"method":"session.description","params":{"session_id":"…","generation":1,
  "description":{"type":"answer","sdp":"v=0\r\n…"}}}
```

```jsonc
{"event":"session.candidate","params":{"sessionId":"…","generation":1,
  "candidate":"candidate:…","sdpMid":"0","sdpMLineIndex":0}}
{"id":6,"method":"session.candidate","params":{"session_id":"…","generation":1,
  "candidate":"candidate:…","sdp_mid":"0","sdp_m_line_index":0}}
```

A candidate that arrives before the remote description is buffered, not dropped.

A client whose ICE connection goes `disconnected` may restart ICE on the same
peer connection instead of opening a new session: it sends
`session.restart_ice` with the session's id and generation, and the engine
re-offers — a fresh offer with a new ICE generation — as a new
`session.description` event, which the client answers as usual. The session
and its generation survive; only the ICE generation turns over. Fresh
candidates from the restart trickle through `session.candidate` on both sides
exactly as the initial ones do.

```jsonc
{"id":7,"method":"session.restart_ice","params":{"session_id":"…","generation":1}}
// → {"id":7,"result":{"accepted":true}}
// …then {"event":"session.description","params":{"sessionId":"…","generation":1,
//   "description":{"type":"offer","sdp":"v=0\r\n…"}}}
```

With `loopback_tcp`, the engine also listens for ICE over TCP on
`127.0.0.1` and offers that passive candidate. It is for a client whose only
way to this computer is a forward of its loopback, such as an SSH tunnel: the
client forwards that port over the connection it already has and connects to
its own end of the forward. The picture and control channel then ride that
forward, still inside DTLS. A client with a UDP path prefers it, as ICE
always does.

### State

```jsonc
{"event":"session.state","params":{"sessionId":"…",
  "capture":"streaming",              // consented|streaming|ended
  "transport":"connected",            // new|connecting|connected|disconnected|failed|closed
  "firstFrame":true}}                 // false until a frame has been encoded
```

`disconnected` is ICE losing the path: the picture is frozen but the session
is alive, and a client should show reconnecting and may restart ICE (above)
rather than open a new session. `failed` is terminal: the engine revokes and
closes the session, and only a new `session.open` recovers it.

While its control channel is open the engine also sends a heartbeat twice a
second, `{"kind":"ping"}`. It lets a client notice a stalled path within
about a second and a half, long before ICE consent timers declare it
`disconnected` — and a resumed heartbeat is the path working again. Clients
that predate it ignore the unknown kind.

A stopped capture emits `{"event":"session.capture.stopped","params":{"sessionId":"…","reason":"SCStream stopped (SCStreamErrorDomain -3821): …"}}`. Frame requests then return `stream-stopped` rather than stale pixels. On macOS the engine retries opening the stream up to three times and emits `session.state` with `capture=streaming` on recovery; Linux capture errors also surface instead of serving an old frame.\n\nThe `geometry` a client maps touch against is the one `session.open` returned,
and the one the control channel's `hello` repeats. A session keeps the one
`generation` it was opened with: a different source or scale is a new
`session.open`, not a generation change within a session.

```jsonc
{"event":"session.restoreToken","params":{"sessionId":"…","token":"…"}}
```

The portal handed back a restore token for a later `session.open`. The engine
requests persistence until explicitly revoked (`persist_mode = 2`); the portal
still decides whether to grant it. Tokens are single-use: consume a saved token
before sending it, and atomically persist each replacement in private host-local
storage, even if it arrives before the open response. Never log tokens or forward
them to a remote controller. A consumer that does not persist one can ignore this
notification and request consent again next time. The WebSocket bridge delivers
this event only to its host-local `engineOptions.onEvent`, not to sockets.

A revoked grant or unavailable source falls back to the portal's normal consent
picker; restoration is silent only where the backend supports it. Cancellation
is an error, not a reason to retry or bypass consent.

```jsonc
{"event":"session.revoked","params":{"sessionId":"…","reason":"…"}}
```

The session ended on the engine's side; there is nothing further to drain.

Metrics are a request, not a notification:

```jsonc
{"id":7,"method":"session.metrics","params":{"session_id":"…"}}
```

```jsonc
{"id":7,"result":{"captured_frames":812,"dropped_frames":3,"encoded_frames":809,
  "encoded_bytes":12345678,"key_frames":1,"refined_frames":37,
  "encode_micros":7390000,"target_kbps":16430,"input_applied":44,"input_rejected":0,
  "fed_frames":0,"input_forwarded":0}}
```

`dropped_frames` counts frames superseded by a newer one before they were coded;
the newest frame is always coded. `refined_frames` counts refinement passes: a
desktop that stops changing is coded once more at a fine quantizer, so it reads
sharp. Key frames are sent only for the first frame and when the receiver asks
(RTCP PLI or FIR). `target_kbps` is the current rate target after any back-off
for loss the receiver reported.

## Input and clipboard: the session's control channel

Input does **not** travel the local protocol. It rides the WebRTC data channel
the engine creates for the session, which is inside the DTLS/SRTP session that
was opened for one authorized grant: it inherits that session's identity and dies
with it, so a client that kept a socket open cannot keep driving a session that
was revoked, and the consumer's request path never carries a pointer move.

The engine is the offerer and creates a data channel labelled `control`. Messages
are JSON, one per message:

```jsonc
{"kind":"pointer","phase":"down","x":812,"y":433,"button":1,"seq":44}
{"kind":"wheel","dx":0,"dy":2,"seq":45}
{"kind":"key","name":"Enter","down":true,"modifiers":["Control"],"seq":46}
{"kind":"text","text":"hello","seq":47}
{"kind":"release_all"}
{"kind":"clipboard_read","request":"<opaque>","seq":48}
{"kind":"clipboard_write","request":"<opaque>","text":"…","seq":49}
```

| kind | fields | notes |
|---|---|---|
| `pointer` | `phase`: `move`\|`down`\|`up`\|`cancel`, `x`, `y`, `button` (default 1) | `x`/`y` are integers in the **encoded surface's** own pixels, i.e. `geometry.encoded` |
| `wheel` | `dx`, `dy` (detents; fractions allowed) | Positive `dx` scrolls right; positive `dy` scrolls down. A fraction is a smooth partial scroll on a desktop with high-resolution wheel support (120 units per detent); an X display receives whole detents as they accumulate. Native adapters normalize platform wheel signs. |
| `key` | `name` (a named key or modifier) or `character` (one character), `down`, `modifiers` | the engine maps `character` through the layout it compiled (`input.layout` in `capabilities`), and refuses a character that layout cannot produce |
| `text` | `text` (≤ 4096 bytes) | applied as real key events, not as a clipboard paste |
| `release_all` | — | explicit safety net; the engine also does this on close and on channel loss |
| `clipboard_read` / `clipboard_write` | `request` (echoed back), `text` | explicit, on user action; never polled |

The engine answers on the same channel, and sends two things unprompted:

```jsonc
{"kind":"hello","protocol":3,"geometry":{…}}     // once, when the channel opens
{"kind":"ping"}                                  // heartbeat, twice a second; see "State" above
{"kind":"ack","seq":44}
{"kind":"rejected","seq":44,"code":"coordinates","message":"(9000,4) is outside the 1280x720 surface"}
{"kind":"clipboard","request":"…","text":"…","truncated":false}   // an empty "text" with "error" when the read failed
{"kind":"revoked","reason":"…"}
```

Refusal codes: `permission`, `session`, `input-replay`, `coordinates`,
`text-too-large`, `text-unsupported`, `input-unavailable`, `operation`.

`seq` is monotonic per session. A repeat or a lower value is refused with
`input-replay` and **no side effect**, so a replayed message cannot move the
pointer twice. Validation, permission and ordering checks all run before any
physical effect.

The engine holds its own pressed-key/button state. `close`, `release_all`,
control-channel loss and process exit all synthesize releases for exactly the
keys and buttons this session pressed, so a dropped connection cannot leave a
modifier stuck down on the desktop. On Linux, `input.text` in `capabilities` states the characters the compiled
layout can produce. macOS reports Unicode text support and currently maps
`key.character` chords through a US ANSI virtual-key map; the reported keyboard
layout is diagnostic, not proof that this map matches it. Anything outside the
map is refused with `text-unsupported`.

## Encoded sources

An `encoded` source is video the **consumer** produced: a phone mirror from a
device helper, a simulator, a camera. The engine captures nothing, encodes
nothing and holds no input device for it; it packetizes what it is handed and
returns the client's control messages to the consumer, which owns whatever
device the picture came from. That is the whole point of the source: the helper
that already speaks H.264 keeps its own encoder, and the engine keeps the
WebRTC, congestion and teardown logic that is already proven on this path.

```jsonc
{"source": {"kind":"encoded","codec":"h264","width":486,"height":1080}}
```

`codec` is `h264`, the only one this build carries (`capabilities.encoded`).
`width`/`height` are the stream's own pixel size, chosen by the consumer because
it is the only party that knows them (`1..7680` by `1..4320`). Nothing is scaled:
`geometry.source` and `geometry.encoded` are both that size, the client aims at
those pixels, and the consumer maps them to its device. `max_width`/
`max_height`/`bitrate_kbps` are ignored for this source, and `permissions` works
as it does anywhere else — with one difference: `control` needs no local input
backend, because nothing is applied locally.

`session.open` returns before any offer exists. The offer must name the profile
the stream actually is (`packetization-mode=1` and the SPS's own
`profile-level-id`), and the only place that is written down is the stream's own
SPS, so the engine sends `session.description` **after** the first fed access
unit that carries one. A consumer must therefore not wait for the offer before
it starts feeding, and a consumer that never feeds an SPS gets no offer at all.

### Feeding access units

```jsonc
{"id":8,"method":"session.feed","params":{
  "session_id":"…",
  "keyframe":true,                       // this unit is an IDR
  "data_b64":"AAAA…"                     // one Annex-B access unit, base64
}}
```

```jsonc
{"id":8,"result":{"accepted":true}}
```

One request is one access unit: start codes and all, exactly as the encoder
emitted it, with SPS/PPS in the unit that carries the IDR. `keyframe` is the
consumer's own statement about the unit; the engine uses it for `session.metrics`
and for nothing else, because the RTP payloader reads the NAL types itself. The
reply acknowledges the hand-off, not the picture: units are packetized behind
the request, and `session.metrics` reports what was sent and what was dropped.

Base64 in the same JSON line keeps one ordered channel and one inherited fd.
Measured, that is not a close call: one second of a 2 Mbit/s stream is 250 KB,
and base64 costs about 0.09 ms to encode on the consumer's side and 1.0 ms to
decode on the engine's — roughly a tenth of one per cent of a core, against the
5 % that would have justified a second fd. Decoded units are
limited to 8 MiB (`malformed` beyond that); a unit the buffer cannot hold right
away is **dropped, not queued** — a live picture is worth more than a backlog of
stale ones — and is counted in `dropped_frames`.

An access unit is dropped until the transport connects, because nothing sent
before it arrives. The engine therefore asks for a key frame the moment the
transport connects (below); a consumer that ignores that request shows a black
picture.

### Key frames the engine cannot make

```jsonc
{"event":"session.keyframeRequest","params":{"sessionId":"…","generation":1}}
```

Raised when the receiver reports a loss it cannot repair (RTCP PLI or FIR), and
once when the transport connects. The consumer responds by feeding a keyframe
access unit — for a device helper, "reset the video stream". This is the encoded
source's version of the reference frame the engine's own encode loop sends when
the same thing happens on a captured desktop.

### Input belongs to the consumer

For this source only, the control channel is **forwarded, not applied**:
`pointer`, `wheel`, `key`, `text` and `release_all` arrive as events, and the
consumer injects them wherever the picture came from (a device helper's own
touch injection, for instance). Coordinates are the encoded surface's own
pixels, exactly as a client sends them.

```jsonc
{"event":"session.input","params":{"sessionId":"…",
  "input":{"kind":"pointer","phase":"down","x":100,"y":200,"button":1,"seq":4}}}
```

The event carries the control message as it arrived. The engine still validates
permission, ordering and replay before forwarding, so the client keeps the same
`ack`/`rejected` behaviour and a replayed gesture still cannot be delivered
twice. `ack` means "accepted for this session", not "applied to a desktop" —
`session.metrics.input_forwarded` counts what was handed on, and `input_applied`
stays zero. Clipboard messages are answered with an empty `clipboard` reply and
an error, because this source has no desktop clipboard: the device's clipboard
is the consumer's to carry.

`session.frame` and `session.wait_frame` are refused with `error.code =
"operation"` — there is no lossless frame to read — and `captured_frames`,
`refined_frames` and `target_kbps` stay at zero while `fed_frames` counts what
the consumer handed over and `encoded_frames`, `encoded_bytes`, `key_frames`
and `encode_micros` describe what was packetized and sent.

## Latest frame over the local protocol

`session.frame` requires `view` permission. It writes the latest pre-encode frame as
packed BGRX bytes to the caller's path, with optional `[x,y,w,h]` `region`.
The directory must already exist and be private to the caller; pixels never
travel through JSON. `seq` advances only when capture changes, `still_ms` is
elapsed time since that capture, and `damage` bounds the changed 32-pixel
tiles since `since` (full frame when the requested sequence is older than the
previous capture). A request with the current sequence reports empty damage;
omitting `path` requests metadata only (`written: false`). `after_seq` waits for
`seq` to exceed that value; `still_ms` waits for that many milliseconds
of stillness. When both are supplied, both conditions must hold.
`timeout_ms` alone waits for 150 ms of stillness. The default deadline is 5 s;
`timeout_ms` can extend it to at most 120 s. An unmet condition returns
`frame-timeout`. Damage is grouped by connected 32-pixel tiles.
Each changed capture emits a local `session.frame.changed` event with `sessionId`,
`seq` and `damage`, allowing a co-located consumer to track animation across
observations. Neither the event nor this file-writing method is forwarded by
the remote WebSocket bridge.

```json
{"id":20,"method":"session.frame","params":{"session_id":"…","since":7,"path":"/run/user/1000/frame.raw"}}
{"id":20,"result":{"seq":8,"still_ms":210,"width":1280,"height":720,"format":"bgrx","damage":[[32,32,32,32]],"written":true}}
```

## Clipboard over the local protocol

The control channel is the path a controller uses (above). A co-located consumer
— a test harness, or a script on the same machine — can use the local protocol
instead; both reach the same clipboard:

```jsonc
{"id":9,"method":"session.clipboard.read","params":{"session_id":"…"}}
{"id":9,"result":{"text":"…","truncated":false}}
{"id":10,"method":"session.clipboard.write","params":{"session_id":"…","text":"…"}}
{"id":10,"result":{"written":true}}
```

Refused with `error.code = "clipboard"` when the session lacks `clipboard`, or
when the desktop's clipboard has no text. A read is bounded by
`capabilities.clipboard.maxBytes`; when the desktop's text is longer, `truncated`
is true and the text is cut on a character boundary, so the returned text is
still valid.

## Close

```jsonc
{"id":12,"method":"session.close","params":{"session_id":"…"}}
```

Closing is terminal for that session: held input is released, capture stops,
the peer is closed and the consent-bearing PipeWire stream is dropped. A close
naming a generation that is no longer current is refused with
`error.code = "generation"` and never closes a newer session; a close for a
session that has already ended is refused with `error.code = "session"`.

```jsonc
{"id":13,"method":"shutdown"}
```

Closes every session and exits.

## Display keeper

```
desklink-host keep --display :42
```

A kiosk window manager for one X screen the consumer created itself — typically
one `Xvfb` per screen, with its own `-auth` cookie file. It is not for the
user's desktop: it takes SubstructureRedirect on the root window, so it is that
screen's window manager, and a display that already has one refuses the keeper.
Authentication is the ambient `XAUTHORITY`; a screen the consumer created should
have its own cookie file, and the keeper inherits whatever the consumer's
environment carries. There is no handshake and no stdin: the contract is a
stdout JSON-lines stream, and closing the consumer's stdout end ends the keeper.

The keeper fills the screen with every normal (non-override-redirect,
input-output) top-level window at `0,0,W,H`, raises the newest one and keeps the
input focus on the newest content window, so keyboard events an engine session
injects on that display land where a person looking at the screen would expect. A top-level window
smaller than 120 px on either side is not content — an emulator draws its side
toolbar as a tiny second window — and is parked far off-screen instead, so a
capture of the screen never shows it.

On startup, and after every change on the screen, it writes one line:

```jsonc
{"windows":[{"id":4194305,"title":"Pricing — Acme Store - Chromium","class":"Chromium","pid":31671,"width":1280,"height":800}]}
```

`windows` lists every visible top-level window, bottom of the stacking order
first, newest last. `id` is the X window id; `title` comes from `_NET_WM_NAME`
with `WM_NAME` as the fallback; `class` is the second string of `WM_CLASS` (the
one consumers filter on, e.g. `Chromium`, `Google-chrome`); `pid` is
`_NET_WM_PID`. Fields the window does not carry are `null`, never absent. A
change is reported after 100 ms of quiet, and never later than 300 ms after the
first unreported change, so a busy screen cannot starve its consumer.

A refused startup is one error line and a non-zero exit:

```jsonc
{"error":"another window manager"}
```

The same shape reports a display that could not be opened. When the display
goes away — an `Xvfb` the consumer stopped, most commonly — the keeper exits 0
on its own; a consumer treats the process ending as the screen ending.

The keeper deliberately does not decorate, move, resize on request, or remember
anything across runs. A screen with no windows produces one `"windows":[]` line
at startup and then nothing: the absence of a report is the absence of
anything to show.

## What the engine deliberately does not do

- It does not decide *who* the user is. It trusts the consumer's local
  permission decision and enforces the resulting scope; there is no second
  account, token or pairing ceremony.
- It does not open ports, register a service, install udev rules, join groups or
  raise capabilities. Kernel input access is a separate, explicit, guided step
  (`desklink-host setup-input` reports what is missing; it does not change it).
- It does not carry audio. A phone watching and driving a desktop needs pixels
  and input; audio is a different product decision.
- It does not arbitrate between two controllers. One session, one controller.
- It does not auto-reconnect with authority it no longer holds: after a lease
  expiry or owner disconnect it requires a fresh `session.open`.
