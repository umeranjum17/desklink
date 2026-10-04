---
name: verify-desklink
description: "Verify desklink's real client journeys on an owned private Xvfb: launch the bridge, doctor the lab, drive the browser reference client and the phone client in every theme and form factor desklink ships, record motion where the change moves something, save screenshots, recordings and fixture events into one stable evidence folder, and prove cleanup. Use before declaring changes to host/client/reference-client behavior complete."
---

# Verify desklink

Use the real reference client served by `desklink-host bridge`, not internal
setters. Pi discovers this project skill in `.agents/skills/`; do not duplicate
it into other host roots. Read the [feature map](features/README.md) first.

## Launch

From the repository root, with Node dependencies already installed:

```sh
npm run build
export CARGO_TARGET_DIR="$HOME/.cache/desklink-verify/cargo-$(git rev-parse --short HEAD)"
cargo build -j 2 --manifest-path packages/desktop-host/engine/Cargo.toml \
  --bin desklink-host --example x11_target --example x11_clip
export DESKLINK_ENGINE="$CARGO_TARGET_DIR/debug/desklink-host"
export DESKLINK_VERIFY_TARGET="$CARGO_TARGET_DIR/debug/examples/x11_target"
node packages/desktop-host/bin/desklink-host.mjs path
"$DESKLINK_ENGINE" version
```

Requirements: Linux, Xvfb, xauth, installed `playwright-core`, and headless
Chromium. The helper defaults to `/usr/lib/chromium/chromium`; set
`DESKLINK_CHROME` to another installed executable if needed. It does not install
anything or reuse a person's browser/profile. Missing tools fail with the cause.

The helper launches the existing CLI `bridge --source x11 --display` using its
verified private display and an ephemeral loopback port. Readiness is the actual
printed `open` URL followed by decoded video in `#video`, not an ICE event or
`Live · connecting`. The page's `#status` is also recorded.

## Doctor

Read-only engine check (no capture session):

```sh
env -u DISPLAY -u WAYLAND_DISPLAY \
  node packages/desktop-host/bin/desklink-host.mjs capabilities
```

The proof additionally verifies Xvfb PID/start-time, lock and listening socket
ownership through `packages/desktop-host/test/lab-safety.mjs`, probes X.Org / no
Xwayland / 1280×720 through the repository fixture, checks pointer availability,
and verifies the actual browser URL, viewport and hit-test **before input**.
Capabilities alone do not establish a healthy owned display.

## Drive

One run covers both clients and lands in one directory:

```sh
EVIDENCE_ROOT="$HOME/lab-tmp/desklink-verify"
EVIDENCE="$EVIDENCE_ROOT/runs/$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
env -u DISPLAY -u WAYLAND_DISPLAY \
  node .agents/skills/verify-desklink/prove-live-desktop.mjs "$EVIDENCE" &&
env -u DISPLAY -u WAYLAND_DISPLAY \
  node .agents/skills/verify-desklink/prove-phone-form-factors.mjs "$EVIDENCE"
ln -sfn "$EVIDENCE" "$EVIDENCE_ROOT/latest"
```

The desktop helper runs first and creates the directory; the phone helper writes
into the same one and refuses to overwrite its own evidence. Both must exit 0.

`prove-live-desktop.mjs` is executable and uses installed Playwright with its own
headless Chromium profile and `TMPDIR` under `~/.cache/desklink-verify/`.
It drives `#video` with a **real locator pointer click**, not DOM `.click()` or
`dispatchEvent`. It deliberately clicks the hit-tested quarter-point: the hidden
`#remote-keyboard` textarea overlays the exact center. On this 1280×720 desktop,
the intended fixture coordinate is `(320,180)`.

The repository `x11_target` app independently reports numeric button 1 down/up;
it paints a 12×12 black marker with a 4×4 white center. The proof checks a known
black-border patch in decoded video before/after, plus trusted browser events,
not engine self-reports. A wrong-token handshake must fail without fixture change.
Stop at the first failed boundary; do not patch product code during verification.

`prove-phone-form-factors.mjs` runs the same engine, bridge and fixture, then
builds a page from the phone client's **own web source** (`useDesktopSession` plus
`native.web.ts`, the exact two calls `DesktopView.web.tsx` makes) with vite, and
drives it in Chromium at two phone viewports. It requires real decoded frames
before it screenshots, and the fixture's own numeric button edge for the tap, so
the phone captures are not pictures of a blank surface.

## Coverage

Every theme and form factor desklink ships is a named case with a capture in the
run directory. Add a row the day a surface is added; never silently drop one.

| Case | Surface | Proof | File |
|---|---|---|---|
| Desktop browser, dark theme | reference client, 1340×860 | real pointer click, fixture edges, marker pixels | `01-before.png`, `02-after.png` |
| Desktop browser, light theme | reference client | measured, not asserted from a claim | `03-theme-light-emulated.png`, `run.json` → `theme` |
| Desktop browser motion | reference client | recorded through the click | `desktop-motion.webm` |
| Phone, portrait fit-width | `@desklink/react-native`, 390×844 | picture fills the width, letterboxed above and below | `phone-portrait.png` |
| Phone, landscape fit | `@desklink/react-native`, 844×390 | whole desktop fitted to the short axis | `phone-landscape.png` |
| Phone motion: tap, pinch zoom | `@desklink/react-native` | fixture button edge from the tap, picture width grows under the zoom, both recorded | `phone-motion.webm`, `phone-zoom.png` |

**Light theme is not shipped, and the run proves that rather than asserting it.**
The reference client declares `:root { color-scheme: dark }` and hard-codes its
chrome colours; the phone client's chrome is `#000`/`#fff`. The helper reads the
computed `color-scheme`, background and text colour under `prefers-color-scheme:
dark` **and** `light`, and writes `theme.clientShipsLightTheme` to `run.json`.
That boolean is `false`: the two schemes paint the same pixels, so a "light
theme screenshot" would be the dark screenshot under another filename. When a
light theme lands, this row becomes a real capture and that boolean turns `true`.

Two more surfaces move, and neither is capturable in this harness, so neither is
claimed: the example app's **key row** (`ModifierKeys`, drawn by
`packages/desktop-client/example/App.tsx`) and the package's **clipboard
confirmation pill** (`ClipboardConfirmation`) are React Native components with no
DOM output under the RN stub. The harness mounts the client's picture surface,
not an app screen. Prove those where the runtime is real:
`packages/desktop-client/test/ios-flow.mjs` on a macOS simulator, or the example
app on an emulator. Naming a case without a capture in the run directory is a
false claim; naming it here with the reason is not.

## Motion

Record video for **every interaction the change under review moves**, not
optionally. Both helpers already record their whole session, so a motion case is
covered by keeping the run: the desktop recording spans the click and the marker
appearing in decoded pixels; the phone recording spans the tap, the pointer
appearing, and the pinch zoom in and back out. A change that adds or moves
chrome in one of the surfaces this skill can drive needs no new harness — say in
the report which recording shows it. A change in the RN-only surfaces named above
cannot be recorded here; say that instead of attaching a recording that does not
show the change.

## Evidence

One stable folder holds every run and survives teardown:

```
~/lab-tmp/desklink-verify/            # stable root, never /tmp, never a lab path
├── latest -> runs/20261004T150231Z-79693f1
└── runs/20261004T150231Z-79693f1/
    ├── 01-before.png  02-after.png   # desktop journey around the click
    ├── 03-theme-light-emulated.png   # light-scheme reading of the chrome
    ├── desktop-motion.webm           # the desktop interaction, recorded
    ├── phone-portrait.png  phone-landscape.png  phone-zoom.png
    ├── phone-motion.webm             # tap, pointer, pinch zoom, recorded
    ├── events.jsonl  phone-events.jsonl   # each fixture's own pointer/button log
    ├── run.json  phone.json          # per-helper receipts, see below
    └── bridge.log  fixture.log  xvfb.log  phone-*.log  capabilities.json
```

A reviewer opens it with any file manager or browser
(`xdg-open ~/lab-tmp/desklink-verify/latest/`, or open `desktop-motion.webm` /
`phone-motion.webm` in a video player), then reads `run.json` and `phone.json`
for what was actually measured. Both receipts carry the source HEAD, engine,
fixture and helper hashes, browser version, target readbacks, trusted input,
pixel samples and the owned cleanup receipt. Use a **new** named run directory
each time; existing evidence is never overwritten, and `latest` only ever moves
forward to the run that just passed.

Exit 0 from both helpers means the entire input→desktop→returned-picture chain,
both form factors and teardown passed. Exit 1 is not partial success: inspect
`run.json` / `phone.json`. Raw URLs/logs contain temporary bridge tokens; keep
them private. Never commit media, credentials or evidence to PR branches. A
build, capabilities, a displayed video or a dispatched input alone is not the
proof. Other map entries remain distinct journeys, not implied passes.

## Cleanup

The helper's `finally` closes its own browser context, stops its bridge (which
reaps the engine), fixture and owned Xvfb, then checks recorded PID/start-time
identities and the bridge port. It removes only task scratch/profile state;
evidence stays. Teardown failure makes the run fail. Never kill by process name
or adopt a session-tagged PID. Never touch a person's live display: ambient
`DISPLAY`/`WAYLAND_DISPLAY` are refused; capture uses only the ownership-verified
private `:170+` lab and empty `WAYLAND_DISPLAY`. Never override Chromium's
`XDG_RUNTIME_DIR`.

Keep the feature map current using `maintain-verification-skill` when behavior
changes. That maintenance pass is separate from this single-feature proof.
