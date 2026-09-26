# M2 MacBook Air evidence

- Mac: macOS 15.7.4, arm64; Rust 1.89.0.
- `cargo build --release` succeeds with `CARGO_TARGET_DIR=~/fm-desklink-mac/target`. `Info.plist` is embedded; ad-hoc signing sets the proof identifier to `dev.desklink.host`.
- `desklink-host capabilities` non-promptingly reports display 1 as 3420×2224 pixels / 1710×1112 points / scale 2.0, current keyboard layout `com.apple.keylayout.ABC`, `session.on_console=true`, no capture/input/clipboard backends yet, and `encode.codecs=[]` until later slices.
- The captain granted Screen Recording to an earlier ad-hoc build; `serve`'s disclaimed protocol `hello` reported `capture.grant=granted` on that exact binary. Subsequent M2 display/layout changes required a rebuild and changed the ad-hoc cdhash; the current binary correctly reports `missing-screen-recording` and `missing-accessibility` until those grants apply to it.
- The current `capture-probe` code requests Screen Recording when preflight is missing and reports that real ScreenCaptureKit session/frame capture is M3 work. No frames are claimed for M2. The captain confirmed the earlier system prompt named `desklink-host`; re-running the prompt against the final ad-hoc build requires the captain at the Air.
- Final Mac binary test: 1 passed. Linux `cargo test` in this worktree: 36 passed. Plain Mac `cargo test` also builds the Linux-only `x11_target` example; use `cargo test --bin desklink-host` for Mac-specific tests.
