---
name: desklink-axi
description: "See and drive a live Linux or macOS desktop and an opted-in browser through desklink; text and changes by default, pixels on request"
---

# desklink-axi

See and drive a live Linux or macOS desktop and an opted-in browser through desklink; text and changes by default, pixels on request (axi/1.0-2026-07).

```
desklink-axi: desklink-axi — See and drive a live Linux or macOS desktop and an opted-in browser through desklink; text and changes by default, pixels on request
help[5]:
  desklink-axi start --control --source x11 --display :97
  desklink-axi screen --query "<words>"
  desklink-axi tree --query "<words>"
  desklink-axi look @r1
  desklink-axi browser snapshot
```

Two lanes: the desktop lane (capture, OCR refs, AT-SPI tree, input) and the browser lane (semantic web control through an opted-in Chromium). On the desktop, `tree --query "<words>"` reads the AT-SPI accessibility tree into generation-tagged `@a<gen>.<n>` refs (values included), and `marks` overlays numbered candidates for icon-only controls. For web pages use the browser lane: `desklink-axi browser attach --cdp 127.0.0.1:<port>` for a browser you started with `--remote-debugging-port` (loopback only), or `desklink-axi browser launch` for an isolated task-owned profile. Then `browser tabs`, `browser snapshot` (compact accessibility refs, no screenshots), `browser click/fill/upload @e<N>`, `browser select <tab>`. Page selection (selected) and the browser's actually activated tab (front) are reported separately. OS-level dialogs are not-supported in the browser lane: fall back to the desktop lane (click/type on the dialog).

Read with screen --query or --region before screen --full. Actions acknowledge input immediately; add --wait change|settle|<milliseconds> when needed. Batch sequential steps in one socket round trip: desklink-axi batch '[["press","Meta+l"],["type","https://example.com"],["press","Return"],["wait","change"]]'. Steps may be {verb,args?,name?,wait?} objects; a named snapshot binds OCR refs for later @name.n steps, and assert steps (`["assert","text"]`, `["assert","--absent","text"]`) make the batch outcome depend on observed screen text. The footer reports effects: asserted[n] or effects: unverified (input acknowledgements only) — an input ack is never a verified outcome.

Guide without input using `point 400,300 --label "Here" --timeout 3000`; use `point --clear` to remove the cue. See the [host protocol reference](../../../desktop-host/docs/PROTOCOL.md#point-on-the-host-desktop) for supported sources and limits. Every command supports --help. Exit 0 success, 1 operational error, 2 usage error. No screen text at startup unless requested.
