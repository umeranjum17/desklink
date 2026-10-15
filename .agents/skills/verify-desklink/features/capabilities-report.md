# Machine capabilities

## Sub-features

Resolve the engine, report capture/encode/input/clipboard support and remedies
for unavailable backends, then stop the diagnostic engine child without opening
a desktop session. The viewer uses this report to disable unavailable controls.

| Reported fact | Drive | Observable proof |
|---|---|---|
| `capture.audio` — this machine can capture the desktop's system audio | `node packages/desktop-host/test/capabilities-audio.mjs` (needs the `pipewire` and `wireplumber` daemons; prints a skip and passes where either is missing) | Two real, task-owned PipeWire servers: `true` with `audio_source: "pipewire-monitor"` where a sink exposes monitor ports, `false` with `audio_source: null` where no server is reachable — same binary, same command; `pw-dump` shows no capture stream was opened for either answer, and the run needs no session bus, so it cannot have prompted |

## How to get to it (user POV)

When the desktop will not appear, run `desklink-host capabilities` before starting
a session. From the built repository:

```sh
env -u DISPLAY -u WAYLAND_DISPLAY \
  node packages/desktop-host/bin/desklink-host.mjs capabilities
```

## System audio on this host

The audio answer is about the machine, so read it against the machine's own
audio stack, not against the lab:

```sh
pactl get-default-sink            # the sink a monitor capture would read
pactl list short sources          # its <sink>.monitor must be listed
env -u DISPLAY -u WAYLAND_DISPLAY \
  node packages/desktop-host/bin/desklink-host.mjs capabilities
```

`capture.audio` must agree with whether that monitor exists, and `false` must
appear when `PIPEWIRE_RUNTIME_DIR` points at a directory with no server socket
(that is the same private-runtime isolation the flow above uses, and with no
session bus reachable). Neither run may ask a question on screen or start a
capture: `pactl list short source-outputs` is unchanged by both.

## Driving it with the host CLI

Use the exact command above with the engine selected by Launch. Require exit 0
and parse the actual JSON; `input.pointer` is the browser-click prerequisite.
The browser proof repeats this command on its owned lab and saves
`capabilities.json`. Do not equate advertised capability with successful capture
or input: verify the actual user journey separately.

## Gotchas

The command starts/stops a real engine child but never opens a session. Machine
capabilities do not certify an owned display, browser permissions, WebRTC decode
or a specific remote desktop. Missing engine/library failures are setup causes,
not permission to fall back to a person's live display.

`capture.audio` describes the desktop's own mix, not a microphone: it is true
whenever a sink with monitor ports is reachable, including a dummy fallback sink
on a machine with no audio hardware, where the captured samples are silence.
Nothing carries audio to a consumer yet, so `capture.audio: true` is not a claim
that a session will deliver sound.
