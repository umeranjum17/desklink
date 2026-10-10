# desklink patch to vendored `rtc-ice` 0.21.0

## What

`Agent::apply_restart` (src/agent/mod.rs) no longer interrupts media that is
already flowing on the current selected ICE pair. When a restart is applied, the
pair media was using is remembered (`restart_media_pair`), and
`get_selected_candidate_pair` keeps returning it until the restarted generation
nominates a new pair. Everything else about the restart is unchanged: the new
local credentials are installed, remote credentials are dropped, binding
requests and candidate pairs are cleared, the agent re-checks, and the
connection state goes to `Checking`.

Every changed spot is marked with a `// desklink patch:` comment.

## Why

An ICE restart on the engine (a `session.restart_ice` from the client) used to
drop the selected pair before the client had even seen the offer. The engine's
RTP/DTLS send path stamps outgoing packets from
`Agent::get_selected_candidate_pair`, and drops them when there is none, so
media stopped until the new generation re-nominated a pair — 1.3–2.5 s on real
networks, which is inside the roam-persistence 2 s bar.

RFC 8445 §9 and libwebrtc keep media on the **previous selected pair** while a
restart's connectivity checks run, and move to the new pair once it is
nominated. rtc-ice 0.21.0 did not; this patch makes it do so. It is needed for
the desklink roam goal: after a network path change, the live picture must be
advancing again within 2 s of path-back on the same session, including the
client's 300 ms reattach grace being removed later.

The behavior is pinned by the engine integration test
`a_restart_keeps_media_flowing_on_the_selected_pair_until_the_new_one_nominates`
in `packages/desktop-host/engine/src/peer.rs`.

## Scope of the change

- `Agent` gains `restart_media_pair: Option<(Candidate, Candidate)>`, initialised
  to `None`.
- `apply_restart` clones the current `(local, remote)` into it before the
  teardown.
- `get_selected_candidate_pair` returns that clone when there is no live
  `selected_pair`.
- `set_selected_pair(.., Some(..))` clears it once a new pair is nominated.
- `update_connection_state` clears it on `Failed` / `Closed`, so a restart that
  never nominates does not keep media pointed at an unreachable pair.

No public API changed; no signalling or wire change.

## How to drop the patch

1. Remove the `[patch.crates-io] rtc-ice = { path = "vendor/rtc-ice" }` entry from
   `packages/desktop-host/engine/Cargo.toml`.
2. Delete `packages/desktop-host/engine/vendor/rtc-ice`.
3. Update `packages/desktop-host/engine/Cargo.lock` (`cargo update -p rtc-ice`).

Do this once upstream rtc-ice keeps the previous selected pair across a restart
on its own (an upstream PR is a follow-up; it needs the captain's word first,
since it would carry his name).
