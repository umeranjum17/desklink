# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Never test capture/input on a person's actual display. Follow the private-lab guidance in `README.md`; shared Xvfb ownership and teardown checks live in `packages/desktop-host/test/lab-safety.mjs`.
- Desktop engine wire contract: `packages/desktop-host/docs/PROTOCOL.md` is the authority for the wire shape — read it before inferring the shape from `bridge.ts`/`session.rs`. AXI integration proof: `packages/axi/test/flow.mjs` on its own Xvfb; set `DESKLINK_AXI_ENGINE` and a task-owned `CARGO_TARGET_DIR`.
- Consumer-fed video proof: `packages/desktop-host/test/encoded-flow.mjs` — it feeds the Annex-B fixture in `test/fixtures/` to an `encoded` source, decodes it in real Chrome (through `packages/desktop-client/src/native.web.ts`, served by vite), and checks the click that comes back as `session.input`. It needs no display, and it skips itself with a printed reason when no Chrome is found.
- Accessibility/marks proof: `packages/axi/test/a11y-flow.mjs` (same env as flow.mjs). It builds a fully private D-Bus + AT-SPI cage — the a11y bus is per-user, so without a task-owned `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`/`AT_SPI_BUS_ADDRESS`, fixture apps register on the user's live accessibility bus.
- Never override `XDG_RUNTIME_DIR` for Chromium — it fails platform init; isolate via unique `DESKLINK_AXI_SESSION` + task-owned profile instead.
- Browser-lane proof: `node packages/axi/test/browser-flow.mjs` (needs chromium; no engine). Clean-tree smoke: `node packages/axi/test/smoke.mjs`. Comparative bench: `packages/axi/test/bench.mjs` (bounded per call/run; records not-completed lanes with reasons).
- macOS TCC installation and signing identity: follow `packages/desktop-host/README.md` (§macOS preview).
- Keep `evidence/` directories out of PR branches; they are session work artifacts, not review content.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
