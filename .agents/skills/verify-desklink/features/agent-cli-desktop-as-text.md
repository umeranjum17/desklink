# Desktop control from the agent CLI

## Sub-features

`screen` returns OCR items with clickable refs; `click`, `type` and `press` apply
input; `diff` reports changed regions; `look` returns pixels on request. Clipboard
commands transfer text through the paired session.

## How to get to it (user POV)

Use `desklink-axi` from a terminal, starting a session before `screen`, input and
`diff`, then `stop`. See `packages/axi/README.md` for commands. Never point this
verification recipe at an ambient display.

## Driving it with the repository private-lab flow

After the skill's Launch sets a matching `DESKLINK_ENGINE` and task-owned
`CARGO_TARGET_DIR`, the existing executable consumer journey is:

```sh
env -u DISPLAY -u WAYLAND_DISPLAY DESKLINK_AXI_ENGINE="$DESKLINK_ENGINE" \
  node packages/axi/test/flow.mjs
```

It claims/verifies its own Xvfb, drives actual CLI capture/click/type, observes
independent fixture input and text output, tests clipboard with a separate X11
owner/reader, and asserts owned cleanup. Save its stdout/stderr in a new evidence
folder. This is an integration journey, not a unit-test substitute. It is not
executed by the browser helper and is not claimed verified by that proof.

## Gotchas

- Keep `CARGO_TARGET_DIR` task-owned and the engine matched to the checkout.
- OCR needs installed `tesseract`; whole-frame `look` does not imply OCR works.
- Fresh region refs exist only after `diff`; refs from old frames need revalidation.
- The accessibility and browser lanes are distinct journeys. Do not substitute
  DOM/API setters for native desktop input or infer their results from this map.
