# @desklink/axi

A Linux/macOS desktop AXI. It runs a private bridge per session, captures read-only frames through `@desklink/host` protocol v3, and sends input only through a WebRTC `control` channel. The bridge's Unix socket lives in `$XDG_RUNTIME_DIR/desklink-axi` (or the OS temp directory), with `DESKLINK_AXI_SESSION` selecting an isolated socket. It opens a separate engine session; don't drive the desktop while someone else is controlling it.

Build: `npm install && npm run build` from the repository root. The engine is resolved by `@desklink/host`; set `DESKLINK_AXI_ENGINE` to an executable built from source if no packaged binary is installed. On macOS use `PATH=/opt/homebrew/bin:$PATH`, Rust >= 1.97.1, delete copied `*.tsbuildinfo` before rebuilding a moved worktree, and `DESKLINK_VPX_STATIC_DIR=/opt/homebrew` (the install **prefix**, not `/opt/homebrew/lib`). For macOS start the bridge from a stable signed app, not `desklink-axi start` in Terminal/SSH: `open -n /absolute/DesklinkHost.app --args axi-bridge /absolute/path/to/packages/axi/bin/desklink-axi.js --control`. Install or update that app using `packages/desktop-host/release/install-mac-app.sh`; grant Screen Recording and Accessibility to it once. An SSH-launched Node helper does not inherit those grants. OCR needs the optional `tesseract` executable (`sudo pacman -S tesseract` or `sudo apt install tesseract-ocr`); `look` works without it.

```
desklink-axi start --control --source x11 --display :97
desklink-axi screen --query "Budget"
desklink-axi tree --query "Save"
desklink-axi type "hello" --into @a3.10
desklink-axi click @a3.7
desklink-axi marks
desklink-axi click 100,120
desklink-axi type "hello"
desklink-axi batch '[["press","Meta+l"],["type","https://example.com"],["press","Return"],["wait","change"]]'
desklink-axi diff
desklink-axi look @r1
desklink-axi stop
```

`health` reports capture state, latest frame sequence, and a stream-stop reason without OCR. `start` defaults to view-only; Linux uses the portal unless `--source x11 --display :N` is given, and macOS uses the main display unless `--source display --display <id>` is given. The portal can require a desktop consent prompt; its single-use restore token is kept in `$XDG_STATE_HOME/desklink-axi/portal-token` (otherwise `~/.local/state/desklink-axi/portal-token`), atomically replaced with mode 0600 after each grant. Set `DESKLINK_AXI_RESTORE_TOKEN_FILE` to use a different path. macOS Screen Recording and Accessibility belong to the app that launches the bridge and its engine child. Do not run it unattended against someone else's display. Input and clipboard read/write require `start --control`; view-only clipboard calls return a structured error naming that flag. `stop` releases held input. Actions acknowledge `input: applied` immediately, without waiting for a frame. Every action (`click`, `type`, `press`, `scroll`, `drag`) accepts `--wait settle|change|none|<milliseconds>`; frame timeout after applied input returns `input: applied; frame: timed out` with success status. `batch` takes a JSON array of 1–30 `[verb, ...args]` steps (click/type/press/scroll/wait/tree/marks), runs them in order in one socket round trip, stops on the first failed step and returns a compact per-step result. OCR refs survive advancing frame numbers only while their text and position still match a fresh crop; moved or ambiguous text requires `screen --query`. `screen --query` reuses a prior matching text location for a targeted crop before falling back to full OCR, and reports estimated text tokens. Start with `screen --query` or `--region` before `--full`. For web pages prefer DOM/browser automation when available; AXI is for native apps or whole-desktop tasks. `wait change` and `wait settle` block on engine frame signals rather than polling. `diff` reports repeatedly changing regions separately as `animating`; `diff --include-animating` includes them among ordinary changes. `look` writes a PNG crop. `--help` lists the commands and their flags. Errors are structured and the CLI does not prompt.

For a remote signed Mac bridge, start it once **inside the permission-granted app**, then forward its Unix socket over one persistent SSH connection: `ssh -N -L "$LOCAL_RUNTIME/desklink-axi/default.sock:$REMOTE_RUNTIME/desklink-axi/default.sock" mac-host`. Set `XDG_RUNTIME_DIR=$LOCAL_RUNTIME` on the client (create `$LOCAL_RUNTIME/desklink-axi` mode 0700 first), and run `desklink-axi screen`, `batch`, etc. locally. The SSH login does not launch the engine, and the forwarded socket grants control: use a private directory and close SSH when done. Do not run local `start` against a forwarded socket. Never swap and re-sign the executable per run. Update the complete app at its existing path with the same key using `packages/desktop-host/release/install-mac-app.sh`; verify grants after updating.\n\n`desklink-axi setup hooks` adds a Claude `SessionStart` hook to `.claude/settings.local.json` in the current directory; it does not start capture.

For an isolated integration proof run `DESKLINK_AXI_ENGINE=/path/to/engine CARGO_TARGET_DIR=/tmp/task-owned-target node packages/axi/test/flow.mjs` from the repository root. It launches and kills its own Xvfb process by exact PID. `test/a11y-flow.mjs` is the accessibility + marks proof: it also starts a private D-Bus session bus, a private AT-SPI bus, and a GTK3 fixture app (all task-owned, private `XDG_RUNTIME_DIR`), asserts semantic-ref driving of form controls and a file dialog, and prints per-command p50/p95 with `--measure 20`. It skips itself when `busctl`/`dbus-daemon`/`at-spi2-core`/GTK are absent and never touches the user's accessibility bus.

To check the CLI against the AXI spec, run `axi-axi validate "node bin/desklink-axi.js" --dir .` from `packages/axi`.

Measured on a private 1280×720 Xvfb client: `diff → click 100,100 → look @r1 → type abc` returned 79 + 79 + 39 + 30 = **227 text tokens** (`@anthropic-ai/tokenizer` 0.0.4), plus ~5 tokens for the 64×64 crop. Four full screenshots would cost ~4×1,229 = **4,916 image tokens** under the same published width×height/750 estimate (~21× difference). This is a short synthetic task, not a production-workload benchmark; the tokenizer is legacy, so absolute counts are approximate.

## Accessibility tree (`tree`) — Linux AT-SPI

`tree` reads the desktop's AT-SPI accessibility tree over D-Bus and returns bounded TOON rows of `ref,role,name,value,x,y,w,h,states`. It needs no `--control`; acting on refs does. Refs are generation-tagged (`@a<gen>.<n>`), stay usable across newer snapshots, and are revalidated at use time: a ref whose role, name, or screen extents changed — or whose object is gone — returns `stale-ref` instead of acting blind.

- Capability probe: the bus is resolved from `AT_SPI_BUS_ADDRESS`, else `org.a11y.Bus.GetAddress` on the session bus. Unavailable → structured `a11y-unavailable` error; every other command keeps working. macOS AX is **not implemented** and labeled as such.
- Values: text and value widgets expose their content in the `value` column (Text/Value interfaces), so a typed entry can be verified without pixels.
- States include `enabled`, `showing`, `focused`, `editable`, `checked`; acting on a disabled or hidden ref returns `not-actionable`.
- `click @a<gen>.<n>` performs the widget's own AT-SPI action (`input: applied (atspi action "Click")`); a node without an action interface falls back to a coordinate click at its center (`coordinate fallback`). `type "text" --into @a<n>` grabs AT-SPI focus first (`atspi focus`; coordinate fallback when the toolkit refuses). Raw screenshot/coordinate/OCR paths are unchanged.
- `tree --query <words>` filters by name/role/value; output is bounded at 40 rows unless `--full`; `--fields` selects columns. `tree` and `marks` are usable as `batch` steps.

Measured facts (private Xvfb + private bus, September 2026; `test/a11y-flow.mjs`):

- GTK3 (3.24, atk-bridge): full exposure. Named roles, bounds, states, values, and actions all work over D-Bus; semantic clicks carry real effects (fixture-verified file export). While a `GtkDialog.run()` modal loop is up, atk-bridge answers **no** AT-SPI method calls at all (measured 25 s timeouts) — dialogs must be read before they are opened or shown non-modally.
- Qt6 (6.11, QtAtSpi): registers the application on the a11y bus (three registry entries, duplicated roots), but `GetChildren`/`GetChildCount` fail on some roots and accessible names are not reachable through a method-based walk — 30 nodes visible, 0/3 named form controls. Property-based access is the likely fix and is not implemented here.
- Wayland/portal: the a11y bus is display-protocol independent, but exposure through the compositor's portal/permission paths was **not measured** in this task (no owned Wayland fixture); scope before relying on it.
- Measured over 20 warm runs (1280×720 Xvfb, GTK3 fixture, private bus): `tree --full` p50 472 ms / p95 573 ms, semantic `click` p50 69 ms / p95 85 ms, `type --into` p50 69 ms / p95 83 ms, `marks` p50 657 ms / p95 774 ms, 0 stale-ref retries across the whole suite. Each `tree`/`marks` walk is bounded (~100–400 bounded busctl spawns, parallelized per level).

## Marks (`marks`) — numbered visual fallback

`marks` overlays numbered boxes on a crop for actionable candidates — AT-SPI nodes with actions plus OCR text — and returns both the image path and a compact `mark,ref,label,role` map. Pick a control from the numbered image, then act on its ref; no pixel guessing. The cost line reports the crop's dimensions and estimated image tokens (`dimensions=1280x720 cost: ~1229 tokens`). Refs in the map expire exactly like `tree` refs: changed geometry or content returns `stale-ref` on use. `--region x,y,w,h` scopes the crop; `--out <path>` chooses the artifact path (default writes next to the session). The overlay drawing is a pure buffer op (`src/marks.ts`); no bundled detector.
