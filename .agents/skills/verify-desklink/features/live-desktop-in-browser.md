# Live desktop in a browser tab

## Sub-features

The bridge serves the reference client; real video decodes; a pointer click lands
on the desktop; its resulting pixels return to the viewer. The URL token grants
available access, and stopping the bridge revokes that URL.

## How to get to it (user POV)

Run `desklink-host bridge`, open its printed `open` URL, click the picture.
For verification, the skill's helper launches the same CLI on its verified private
Xvfb source; never run the ambient desktop command unattended.

## Driving it with Playwright

After [Launch](../SKILL.md#launch), from the repo root:

```sh
EVIDENCE="$HOME/lab-tmp/desklink-verify/$(date -u +%Y%m%dT%H%M%SZ)"
env -u DISPLAY -u WAYLAND_DISPLAY \
  node .agents/skills/verify-desklink/prove-live-desktop.mjs "$EVIDENCE"
```

The helper waits for actual decoded 1280×720 video, reads `#status`, verifies the
1340×860 viewport and `elementFromPoint()` target, saves BEFORE, then performs
`page.locator('#video').click({position: …})` at the picture's quarter-point.
Trusted pointer edges must reach the repository fixture as numeric button 1
`down`/`up` at `(320,180)`. The fixture paints a black border around its white
click marker; the helper samples `(323,179)` inside that border in the decoded
video, requires changed colored→black RGB pixels, saves AFTER, and checks cleanup.
The fixture log plus returned pixels, not transport acknowledgements, prove it.

## Gotchas

- The invisible `#remote-keyboard` textarea covers the exact video center. Hit-test
  before clicking and choose an unobstructed point; do not hide/remove the editor.
- `Live · connecting` or `Live · connected` can precede presented video; use
  `videoWidth`/`readyState`, not the status string alone.
- `x11_target` emits numeric `button: 1`, not a string. Initial pointer motion at
  `(640,360)` is not the action under test.
- Wrong-token refusal and cleanup are included. Existing evidence is never
  overwritten; failed attempts preserve diagnostics and settle owned processes.
