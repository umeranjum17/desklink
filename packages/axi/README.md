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

`start` defaults to view-only; without `--source x11 --display :N` it uses the portal, which can require a desktop consent prompt. Do not run it unattended against someone else's display. `stop` releases held input. Every action reports a text diff; `look` alone writes PNG pixels. `--help` lists the 14 commands and each command's flags. Errors are structured and the CLI does not prompt.

For an isolated integration proof run `DESKLINK_AXI_ENGINE=/path/to/engine CARGO_TARGET_DIR=/tmp/task-owned-target node packages/axi/test/flow.mjs` from the repository root. It launches and kills its own Xvfb process by exact PID.

Measured on a private 1280×720 Xvfb client: `diff → click 100,100 → look @r1 → type abc` returned 77 + 77 + 39 + 30 = **223 text tokens** (`@anthropic-ai/tokenizer` 0.0.4), plus ~5 tokens for the 64×64 crop. Four full screenshots would cost ~4×1,229 = **4,916 image tokens** under the same published width×height/750 estimate (~22× difference). This is a short synthetic task, not a production-workload benchmark; the tokenizer is legacy, so absolute counts are approximate.
