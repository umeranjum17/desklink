# Machine capabilities

## Sub-features

Resolve the engine, report capture/encode/input/clipboard support and remedies
for unavailable backends, then stop the diagnostic engine child without opening
a desktop session. The viewer uses this report to disable unavailable controls.

## How to get to it (user POV)

When the desktop will not appear, run `desklink-host capabilities` before starting
a session. From the built repository:

```sh
env -u DISPLAY -u WAYLAND_DISPLAY \
  node packages/desktop-host/bin/desklink-host.mjs capabilities
```

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
