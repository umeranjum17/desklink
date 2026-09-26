# @desklink/axi

A Linux desktop AXI. It runs a private bridge per session, captures read-only frames through `@desklink/host` protocol v3, and sends input only through a WebRTC `control` channel. The bridge's Unix socket lives in `$XDG_RUNTIME_DIR/desklink-axi` (or the OS temp directory), with `DESKLINK_AXI_SESSION` selecting an isolated socket. It opens a separate engine session; don't drive the desktop while someone else is controlling it.

Build: `npm install && npm run build` from the repository root. The engine is resolved by `@desklink/host`; set `DESKLINK_AXI_ENGINE` to an executable built from source if no packaged binary is installed. OCR needs the optional `tesseract` executable (`sudo pacman -S tesseract` or `sudo apt install tesseract-ocr`); `look` works without it.

```
desklink-axi start --control --source x11 --display :97
desklink-axi screen --query "Budget"
desklink-axi click 100,120
desklink-axi type "hello"
desklink-axi diff
desklink-axi look @r1
desklink-axi stop
```

`start` defaults to view-only; without `--source x11 --display :N` it uses the portal, which can require a desktop consent prompt. Do not run it unattended against someone else's display. Input and clipboard read/write require `start --control`; view-only clipboard calls return a structured error naming that flag. `stop` releases held input. Actions wait for a post-action frame and stillness by default, with a bounded timeout; `click --wait settle|change|none|<milliseconds>` changes that wait. `wait change` and `wait settle` block on engine frame signals rather than polling. `diff` reports repeatedly changing regions separately as `animating`; `diff --include-animating` includes them among ordinary changes. `look` writes a PNG crop. `--help` lists the 14 commands and their flags. Errors are structured and the CLI does not prompt.

`desklink-axi setup hooks` adds a Claude `SessionStart` hook to `.claude/settings.local.json` in the current directory; it does not start capture.

For an isolated integration proof run `DESKLINK_AXI_ENGINE=/path/to/engine CARGO_TARGET_DIR=/tmp/task-owned-target node packages/axi/test/flow.mjs` from the repository root. It launches and kills its own Xvfb process by exact PID.

To check the CLI against the AXI spec, run `axi-axi validate "node bin/desklink-axi.js" --dir .` from `packages/axi`.

Measured on a private 1280×720 Xvfb client: `diff → click 100,100 → look @r1 → type abc` returned 79 + 79 + 39 + 30 = **227 text tokens** (`@anthropic-ai/tokenizer` 0.0.4), plus ~5 tokens for the 64×64 crop. Four full screenshots would cost ~4×1,229 = **4,916 image tokens** under the same published width×height/750 estimate (~21× difference). This is a short synthetic task, not a production-workload benchmark; the tokenizer is legacy, so absolute counts are approximate.
