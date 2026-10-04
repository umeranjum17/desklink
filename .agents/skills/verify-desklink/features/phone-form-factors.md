# The phone client in a phone viewport

## Sub-features

`@desklink/react-native`'s picture surface fits itself to the screen it is
given: a portrait phone gets the desktop at full width with the tall axis
letterboxed, a landscape phone gets the whole desktop fitted to the short axis.
A tap becomes a desktop button press, and a pinch zooms the picture without
distorting it.

## How to get to it (user POV)

Mount `DesktopView` (or, in a browser, its own `attachSurface` mount) around a
live session. On a phone held upright the desktop fills the width; turned
sideways it fits whole. Pinch to zoom in, and the picture grows around the pinch
focus.

## Driving it with Playwright

The skill's second helper does this for real: same engine, bridge and fixture as
the desktop journey, a page built from `useDesktopSession` + `native.web.ts`, and
two phone viewports.

```sh
EVIDENCE="$HOME/lab-tmp/desklink-verify/runs/<utc>-<sha>"   # the desktop helper's directory
env -u DISPLAY -u WAYLAND_DISPLAY \
  node .agents/skills/verify-desklink/prove-phone-form-factors.mjs "$EVIDENCE"
```

It waits for real decoded frames, then measures the picture box in a 844×390
landscape viewport (must equal the whole desktop fitted to 390 high) and a 390×844
portrait viewport (must fill the width and be shorter than the viewport). It taps
the picture and requires the fixture's own numeric button 1 edge, screenshots
both form factors, then pinch-zooms with the client's documented ctrl-wheel pinch
path and requires the picture box to grow, recording the whole sequence as
`phone-motion.webm`. Evidence lands in the run directory the desktop helper
created; the receipts are `phone.json` and `phone-events.jsonl`.

## Gotchas

- The client shows nothing before real frames arrive: `live` status alone is not
  a picture. Wait for presented frames before a screenshot.
- Under the RN stub the surface is a plain box, so `#stage video` is the picture
  to measure. Do not measure the page.
- Portrait fits **width**; landscape fits **height**. Asserting the other one
  passes a letterboxed black picture as a capture.
- The pinch is driven as a ctrl-wheel because that is the client's documented
  trackpad-pinch path (`native.web.ts`); Playwright has no two-finger touch.
- The example app's key row and the clipboard pill are RN-only and are not
  captured here. See the coverage table in the skill for where they are proven.