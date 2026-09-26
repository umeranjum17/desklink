# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Desktop engine wire contract: `packages/desktop-host/docs/PROTOCOL.md`. AXI integration proof: `packages/axi/test/flow.mjs` on its own Xvfb; set `DESKLINK_AXI_ENGINE` and a task-owned `CARGO_TARGET_DIR`.
- Never test capture/input on a person's actual display; the flow test owns and tears down an isolated X server by exact PID.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
