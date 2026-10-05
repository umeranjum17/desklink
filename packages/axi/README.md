<h1 align="center">@desklink/axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@desklink/axi"><img alt="npm" src="https://img.shields.io/npm/v/@desklink/axi?style=flat" /></a>
  <a href="https://github.com/umeranjum17/desklink/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/desklink/ci.yml?style=flat&branch=main" /></a>
  <a href="https://github.com/umeranjum17/desklink/blob/main/LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Linux and macOS (preview)" src="https://img.shields.io/badge/Linux%20%7C%20macOS%20%28preview%29-111?style=flat" />
</p>

<p align="center">
  <strong>See and drive a live desktop from an agent: text first, pixels on request.</strong><br/>
  A desktop CLI for coding agents on the desklink engine. It answers with OCR text, refs to click and changed regions, and returns an image crop only when asked, so a turn costs text tokens rather than screenshots.
</p>

## Install

Install from npm; the badge above tracks the registry version:

```sh
npm install -g @desklink/axi
```

Or build from the repository root with `npm install && npm run build`.
Delete copied `*.tsbuildinfo` before rebuilding a moved worktree.
The engine is resolved by `@desklink/host`; see its [installation guide](../desktop-host/README.md#install-and-run)
for supported platforms and [macOS setup](../desktop-host/README.md#macos-preview).
Set `DESKLINK_AXI_ENGINE` for a matching source build. An override pointing new AXI at a 0.3.x engine is unsupported; host and engine versions must match.

A Linux desktop AXI with macOS in preview. It runs a private bridge per session, captures read-only frames through `@desklink/host` protocol v3, and sends input only through a WebRTC `control` channel. The bridge's Unix socket lives in `$XDG_RUNTIME_DIR/desklink-axi` (or the OS temp directory), with `DESKLINK_AXI_SESSION` selecting an isolated socket. It opens a separate engine session; don't drive the desktop while someone else is controlling it.

For macOS source prerequisites, signing and permission attribution, follow the [host setup guide](../desktop-host/README.md#macos-preview). To launch AXI through its signed local harness, use `open -n /absolute/DesklinkHost.app --args axi-bridge /absolute/path/to/packages/axi/bin/desklink-axi.js` from the logged-in Mac session. OCR needs the optional `tesseract` executable (`brew install tesseract`, `sudo pacman -S tesseract` or `sudo apt install tesseract-ocr`); on macOS AXI also finds Homebrew's standard install paths when LaunchServices omits them from PATH. `look` works without it.

```
desklink-axi start --source x11 --display :97
desklink-axi screen --query "Budget"
desklink-axi tree --query "Save"
desklink-axi type "hello" --into @a3.10
desklink-axi click @a3.7
desklink-axi marks
desklink-axi click 100,120
desklink-axi type "hello"
desklink-axi batch '[[{"verb":"snapshot","name":"ui"},{"verb":"click","args":["@ui.2"]},{"verb":"assert","args":["Saved"]}]]'
desklink-axi diff
desklink-axi look @r1
desklink-axi stop
```

`start --cursor hidden` opts into cursor-free capture; omit it for existing behavior. Use `desklink-axi cursor` to drain source-coordinate cursor samples (`x`, `y`, `visible`, `timestamp_us`, plus `hotspot` where the compositor reports it) from the live session; `dropped:N` reports older samples overwritten after its 10,000-sample buffer fills. On Wayland a hidden session still runs when positions are unavailable and says why in `cursor.limitation`; see the [cursor protocol](../desktop-host/docs/PROTOCOL.md#cursor-free-capture).

`health` reports capture state, latest frame sequence, and a stream-stop reason without OCR. `start` grants all available access to its same-user paired consumer; Linux uses the portal unless `--source x11 --display :N` is given, and macOS uses the main display unless `--source display --display <id>` is given. The portal can require a desktop consent prompt; its single-use restore token is kept in `$XDG_STATE_HOME/desklink-axi/portal-token` (otherwise `~/.local/state/desklink-axi/portal-token`), atomically replaced with mode 0600 after each grant. Set `DESKLINK_AXI_RESTORE_TOKEN_FILE` to use a different path. macOS Screen Recording and Accessibility belong to the app that launches the bridge and its engine child. Do not run it unattended against someone else's display. Input and clipboard need no app grants; unavailable OS backends fail per action. Legacy `start --control` is accepted and ignored. See the [clipboard protocol](../desktop-host/docs/PROTOCOL.md#clipboard-over-the-local-protocol) for X11 targets, transfer limits and selection lifetime. `stop` releases held input. Actions acknowledge `input: applied` immediately, without waiting for a frame. Every action (`click`, `type`, `press`, `scroll`, `drag`) accepts `--wait settle|change|none|<milliseconds>`; frame timeout after applied input returns `input: applied; frame: timed out` with success status. `batch` takes a JSON array of 1–30 `[verb, ...args]` steps (click/type/press/scroll/wait/snapshot/assert/tree/marks), runs them in order in one socket round trip, stops on the first failed step and returns a compact per-step result. OCR refs survive advancing frame numbers only while their text and position still match a fresh crop; moved or ambiguous text requires `screen --query`. `screen --query` reuses a prior matching text location for a targeted crop before falling back to full OCR, and reports estimated text tokens. Start with `screen --query` or `--region` before `--full`. For web pages prefer DOM/browser automation when available; AXI is for native apps or whole-desktop tasks. `wait change` and `wait settle` block on engine frame signals rather than polling. `diff` reports repeatedly changing regions separately as `animating`; `diff --include-animating` includes them among ordinary changes. `look` writes a PNG crop. `--help` lists the commands and their flags. Errors are structured and the CLI does not prompt.
To guide the person without input, use `desklink-axi point 400,300 --label "Here" --timeout 3000`, or `desklink-axi point --clear`. See the [host protocol reference](../desktop-host/docs/PROTOCOL.md#point-on-the-host-desktop) for supported sources, coordinates, and limits.

## Browser lane (opt-in, loopback-only)

For web pages the browser lane gives semantic control through [playwright-core](https://www.npmjs.com/package/playwright-core) over CDP; the desktop lane stays for native apps and whole-desktop tasks. Nothing is attached implicitly:

```
desklink-axi browser attach --cdp 127.0.0.1:9222   # a Chromium YOU started with --remote-debugging-port (loopback only)
desklink-axi browser launch --profile /tmp/task-profile   # or: isolated task-owned Chromium, debug port on loopback only
desklink-axi browser tabs          # 'selected' = this lane's page, 'front' = the browser's actual activated tab
desklink-axi browser snapshot      # compact accessibility snapshot with [ref=eN] elements; no screenshots
desklink-axi browser click @e12 / fill @e5 "text" / upload @e9 /tmp/report.pdf / press Enter
desklink-axi browser select 1 / open <url> / navigate <url> / close 1 / detach
```

Non-loopback endpoints are refused; `launch` renders on `$DISPLAY` (X11) so it never follows `WAYLAND_DISPLAY` to another desktop, and `--arg <chromium flag>` (repeatable) passes extra flags such as `--arg=--window-size=1280,640`. Snapshot refs are re-derived on every command and rejected as `stale-ref` when the page changed. `upload` only sets files on `<input type=file>`; for OS-level dialogs it returns `not-supported` and names the desktop lane (`desklink-axi click/type`), which is also the route for real native-dialog navigation — a DOM upload is not equivalent to completing a native file dialog. `detach` stops the browser only if this lane launched it; a passed `--profile` directory is kept, a lane-created temp profile is removed.

On Linux, a lane-launched browser's recorded PID and start time must match
before connection or cleanup. Cached sessions from older versions without a
recorded start time are refused; use a fresh `DESKLINK_AXI_SESSION` and profile.
Cleanup verifies helper PID/start-time pairs against the private launch marker
before signalling them. Browsers attached through `--cdp` remain caller-owned.

## Batch outcomes

`batch` steps are `[verb, ...args]` arrays or `{verb, args?, name?, wait?}` objects with verbs `click, type, press, scroll, wait, snapshot, assert, tree, marks`. A named snapshot step binds its OCR items so later steps can target `@name.n`; `assert` steps make success depend on observed screen text; per-step lines separate `input: applied` (transport acknowledgement) from `effect: change observed | none within timeout`, and the footer says `effects: asserted[n]` or `effects: unverified (input acknowledgements only)` — an input acknowledgement is never a verified outcome, so wrong-focus typing or a no-op click fails the batch instead of reporting success.

## Proofs and measurements

From the repository root with a task-built engine (`DESKLINK_AXI_ENGINE`) on
Linux, following the [private-lab guidance](../../README.md#develop):

- `node packages/axi/test/smoke.mjs` — clean-tree rebuild of host+axi, then `batch` and `click` on a private Xvfb; asserts no task-owned survivors.
- `node packages/axi/test/flow.mjs` — full desktop proof (frame/damage, point coordinates/timeout/clear without pointer or focus changes, click-through, input, chords, batch outcomes, injected-failure cleanup).
- `node packages/axi/test/browser-flow.mjs` — the open/form/two-tab fixture through the browser lane with semantic refs on a private Xvfb; also proves selected-vs-front, stale-ref rejection, DOM upload and the not-supported fallback.
- `node packages/axi/test/bench.mjs [runs]` — comparative p50/p95 (default 20 measured runs after 3 warmups) for the browser lane vs the AXI fallback over the open/form/tabs/native fixtures; text-token proxy is `ceil(stdout chars/4)`, a proxy, not a tokenizer.

Measured on one private 1280x720 Xvfb with a task-owned Chromium 151 (`--window-position=0,0 --window-size=1280,640`, 20 measured runs per task after 3 warmups, CLI wall time per run; Chromium for Testing 151.0.7922.34, playwright-core 1.62.1):

| task | lane | p50 ms | p95 ms | calls/run | retries | text-token proxy/run | failures |
|---|---|---|---|---|---|---|---|
| native typing | axi | 57 | 68 | 1.0 | 0 | 22 | 1/23 |
| open + verify heading | browser | 532 | 558 | 2.0 | 0 | 149 | 0/23 |
| open + verify heading | axi | 6043 | 8659 | 2.0 | 0 | 107 | 0/23 |
| form fill+save+verify | browser | 1735 | 6082 | 4.0 | 0 | 290 | 0/23 |
| two tabs read both | browser | 5176 | 6007 | 17.0 | 0 | 900 | 0/23 |
| form fill+save+verify | axi | not completed — OCR word-target steps (`--into Name`, `click Save`) are flaky in the bench sequence; the same steps pass in isolation and the batch/assert machinery is proven in flow.mjs. Follow-up: stabilize, then re-measure. |
| two tabs read both | axi | not completed — same OCR word-target limitation on the popup-link click; works in isolation, not yet in the measured sequence. |

The browser lane completed every web task 23/23 with compact text snapshots; the desktop lane's OCR fallback stays reliable for the native proof and degrades on small web text, matching the two-lane ranking in the 2026-09-27 computer-use benchmark.

For a remote signed Mac bridge, start it once **inside the permission-granted app**, then forward its Unix socket over one persistent SSH connection: `ssh -N -L "$LOCAL_RUNTIME/desklink-axi/default.sock:$REMOTE_RUNTIME/desklink-axi/default.sock" mac-host`. Set `XDG_RUNTIME_DIR=$LOCAL_RUNTIME` on the client (create `$LOCAL_RUNTIME/desklink-axi` mode 0700 first), and run `desklink-axi screen`, `batch`, etc. locally. The SSH login does not launch the engine, and the forwarded socket grants control: use a private directory and close SSH when done. Do not run local `start` against a forwarded socket. Never swap and re-sign the executable per run. Update the complete app at its existing path with the same key using `packages/desktop-host/release/install-mac-app.sh`; verify grants after updating.

`desklink-axi setup hooks` adds a Claude `SessionStart` hook to `.claude/settings.local.json` in the current directory; it does not start capture.

For an isolated integration proof run `DESKLINK_AXI_ENGINE=/path/to/engine CARGO_TARGET_DIR=/tmp/task-owned-target node packages/axi/test/flow.mjs` from the repository root. It launches and kills its own Xvfb process by exact PID. `test/a11y-flow.mjs` is the accessibility + marks proof: it also starts a private D-Bus session bus, a private AT-SPI bus, and a GTK3 fixture app (all task-owned, private `XDG_RUNTIME_DIR`), asserts semantic-ref driving of form controls and a file dialog, and prints per-command p50/p95 with `--measure 20`. It skips itself when `busctl`/`dbus-daemon`/`at-spi2-core`/GTK are absent and never touches the user's accessibility bus.

For the 200-word OCR and query proof, add `DESKLINK_OCR_SCALE=1` or `DESKLINK_OCR_SCALE=1.5` and `DESKLINK_OCR_EVIDENCE=/absolute/output/directory` to that command. The latter uses a private 3840×2160 display at 1.5 scale. Each run saves the ground truth, OCR, word diff, screenshot and every visible-label query. Add `DESKLINK_OCR_UPDATE_README=1` to the 1x run to replace the README transcript directly with CLI output; no transcript lines are edited by hand. Use `DESKLINK_OCR_SHOWCASE_ONLY=1` with the 1x command to replay the edit and regenerate the transcript without repeating the label-query checks. This proof needs Chromium and Tesseract. Known limitation: a text insertion caret visible in the captured pixels may be read as part of nearby item text (for example a trailing `|`), because frames carry pixels without caret identity. Full-frame OCR upscales 3x in software before Tesseract, so a 3840x2160 frame transiently needs a 11520x6480 (~74.6M px, ~298MB RGBA) buffer plus PNG encode plus Tesseract on the enlarged image.

To check the CLI against the AXI spec, run `axi-axi validate "node bin/desklink-axi.js" --dir .` from `packages/axi`.

Measured on a private 1280×720 Xvfb client: `diff → click 100,100 → look @r1 → type abc` returned 79 + 79 + 39 + 30 = **227 text tokens** (`@anthropic-ai/tokenizer` 0.0.4), plus ~5 tokens for the 64×64 crop. Four full screenshots would cost ~4×1,229 = **4,916 image tokens** under the same published width×height/750 estimate (~21× difference). This is a short synthetic task, not a production-workload benchmark; the tokenizer is legacy, so absolute counts are approximate.

## Accessibility tree (`tree`) — Linux AT-SPI

`tree` reads the desktop's AT-SPI accessibility tree over D-Bus and returns bounded TOON rows of `ref,role,name,value,x,y,w,h,states`. Read and input actions share the same paired session. Refs are generation-tagged (`@a<gen>.<n>`), stay usable across newer snapshots, and are revalidated at use time: a ref whose role, name, or screen extents changed — or whose object is gone — returns `stale-ref` instead of acting blind.

- Capability probe: the bus is resolved from `AT_SPI_BUS_ADDRESS`, else `org.a11y.Bus.GetAddress` on the session bus. Unavailable → structured `a11y-unavailable` error; every other command keeps working. macOS AX is **not implemented** and labeled as such.
- Values: text and value widgets expose their content in the `value` column (Text/Value interfaces), so a typed entry can be verified without pixels.
- States include `enabled`, `showing`, `focused`, `editable`, `checked`; acting on a disabled or hidden ref returns `not-actionable`.
- `click @a<gen>.<n>` performs the widget's own AT-SPI action (`input: applied (atspi action "Click")`); a node without an action interface falls back to a coordinate click at its center (`coordinate fallback`). `type "text" --into @a<n>` grabs AT-SPI focus first (`atspi focus`; coordinate fallback when the toolkit refuses). Raw screenshot/coordinate/OCR paths are unchanged.
- `tree --query <words>` filters by name/role/value; output is bounded at 40 rows unless `--full`; `--fields` selects columns. `tree` and `marks` are usable as `batch` steps.

Measured facts (private Xvfb + private bus, September 2026; `test/a11y-flow.mjs`):

- GTK3 (3.24, atk-bridge): full exposure. Named roles, bounds, states, values, and actions all work over D-Bus; semantic clicks carry real effects (fixture-verified file export). While a `GtkDialog.run()` modal loop is up, atk-bridge answers **no** AT-SPI method calls at all (measured 25 s timeouts) — dialogs must be read before they are opened or shown non-modally.
- Qt6 (6.11, QtAtSpi): registers the application on the a11y bus with duplicated registry entries (three roots for one app, two sharing one bus name), and its named form controls are visible to the walk (3/3 in the fixture); some roots reject the `GetChildCount` method (property-only), which the walk tolerates. Treat per-toolkit role spellings ("push button" vs "button") and duplicated roots as normal input.
- Wayland/portal: the a11y bus is display-protocol independent, but exposure through the compositor's portal/permission paths was **not measured** in this task (no owned Wayland fixture); scope before relying on it.
- Measured over 20 warm runs (1280×720 Xvfb, GTK3 fixture, private bus): `tree --full` p50 472 ms / p95 573 ms, semantic `click` p50 69 ms / p95 85 ms, `type --into` p50 69 ms / p95 83 ms, `marks` p50 657 ms / p95 774 ms, 0 stale-ref retries across the whole suite. Each `tree`/`marks` walk is bounded (~100–400 bounded busctl spawns, parallelized per level).

## Marks (`marks`) — numbered visual fallback

`marks` overlays numbered boxes on a crop for actionable candidates — AT-SPI nodes with actions plus OCR text — and returns both the image path and a compact `mark,ref,label,role` map. Pick a control from the numbered image, then act on its ref; no pixel guessing. The cost line reports the crop's dimensions and estimated image tokens (`dimensions=1280x720 cost: ~1229 tokens`). Refs in the map expire exactly like `tree` refs: changed geometry or content returns `stale-ref` on use. `--region x,y,w,h` scopes the crop; `--out <path>` chooses the artifact path (default writes next to the session). The overlay drawing is a pure buffer op (`src/marks.ts`); no bundled detector.
