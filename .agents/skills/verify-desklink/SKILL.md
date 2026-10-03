---
name: verify-desklink
description: "Verify desklink's real browser desktop journey on an owned private Xvfb: launch the bridge, doctor the lab, click the reference client, save screenshots and fixture events, and prove cleanup. Use before declaring changes to host/client/reference-client behavior complete."
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

```sh
EVIDENCE="$HOME/lab-tmp/desklink-verify/$(date -u +%Y%m%dT%H%M%SZ)"
env -u DISPLAY -u WAYLAND_DISPLAY \
  node .agents/skills/verify-desklink/prove-live-desktop.mjs "$EVIDENCE"
```

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

## Evidence

Use a **new** named output directory; existing evidence is never overwritten.
It survives cleanup and contains:

- `01-before.png`, `02-after.png`: complete page PNGs around the actual click;
- `events.jsonl`: the fixture's independent pointer/button log;
- `run.json`: source HEAD, engine/fixture/helper hashes, browser version, target
  readback, trusted input, before/after pixel samples and owned cleanup receipt;
- `capabilities.json`, `bridge.log`, `fixture.log`, `xvfb.log`: diagnostics.

Exit 0 means the entire input→desktop→returned-picture chain and teardown passed.
Exit 1 is not partial success: inspect `run.json`. Raw URLs/logs contain temporary
bridge tokens; keep them private. Never commit media, credentials or evidence to
PR branches. A build, capabilities, a displayed video or a dispatched input alone
is not the proof. Other map entries remain distinct journeys, not implied passes.

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
