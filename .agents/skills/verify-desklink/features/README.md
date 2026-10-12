# desklink feature map

Run from the repository root. [The skill](../SKILL.md) owns Launch, Doctor,
Evidence and Cleanup. Never use a person's display; every desktop journey must
use the ownership-verified private lab.

| User feature | Drive | Observable proof |
|---|---|---|
| Catchable engine control-pipe failure | `npx vitest run packages/desktop-host/src/engineProcess.pipe.spec.ts` after `npm run build` | Real Node child: healthy hello, local write-after-end and remote fd-close mid-request reject as `EngineRefused` with original code/cause; every pending request settles and stop reaps the child; no display needed |
| Bounded engine event retention | `npx vitest run packages/desktop-host/src/engineProcess.queue.spec.ts` after `npm run build` | Real Node child streams description/candidate/frame/cursor/state: with `onEvent` set every event is delivered and `drainEvents()` stays empty; without `onEvent` the same events are retained for `drainEvents()`; no display needed |
| ICE restart keeps media on the selected pair | `cargo test --manifest-path packages/desktop-host/engine/Cargo.toml a_restart_keeps_media_flowing -- --nocapture` (no display) | Two real peers connect over loopback with a VP9 track flowing; an `session.restart_ice` offer/answer round keeps inbound packets arriving with no gap ≥200 ms while the old pair stays reachable, and the ICE ufrag turns over. New-address recovery stays green in `test/roam-flow.mjs --path new-address --driver-restart`. Fail-on-main baseline: 359 ms gap with the unpatched engine |
| [Live desktop in a browser](live-desktop-in-browser.md) | Bridge URL → real pointer click on `#video` | Numeric fixture edges and returned marker pixels; automated helper |
| [Phone form factors](phone-form-factors.md) | Same engine, portrait 390×844 and landscape 844×390 | Measured picture fit per form factor, fixture button edge from a tap, recorded pinch zoom |
| [iOS phone journeys](ios-phone-journeys.md) | Example app on the Mac's own simulator, driven by `test/ios-flow.mjs` | Readable live desktop with frames advancing; phone-only click, drag, scroll, typing, sticky modifiers, clipboard both ways; measured arrow tip; over five fresh landscape launches with the app shrinking its surface for the keyboard, a tapped field low on the picture stays above the raised keyboard and is never pinned back to the desktop's top-left (`step-09-keyboard-{1..5}-{closed,open}.png`) |
| iOS native baseline through a Mac-local relay (baseline) | Example app on the Mac's own simulator, `test/ios-recovery-flow.mjs --only live` | The app holds `Connected` through a task-owned Mac-local relay (the same ShapedLink, `mac-relay.mjs`) that reaches this host's loopback bridge over an SSH reverse-forward; the decoded picture keeps advancing in the DEFAULT portrait cover crop; the fixture's own log confirms a pointer down+up and a key down+up; the receipt carries the relay's own counters, both picture-only frame hashes, the recording and the fixture events. Cuts nothing; the Wi-Fi path cut and the recovery matrix belong to the dl-roam-mac-cut / dl-roam-native-matrix follow-ups |
| [Machine capabilities](capabilities-report.md) | `desklink-host capabilities` | Actual capability JSON and engine child exit; helper Doctor |
| [Desktop control from the agent CLI](agent-cli-desktop-as-text.md) | Existing private-lab CLI flow | Independent X11 click/typing/clipboard effects; separate journey |
| Signaling carrier reattachment | `test/roam-flow.mjs --product-retention` on owned Xvfb | 12s outage preserves id without close; abandon closes at 30s ±0.5s; bridge shutdown inside window ≤1s; standalone 20s recovery records its actual outcome and old-pair vs restart mechanism |
| Roaming keeps the session (client hook) | `test/roam-flow.mjs --adapter hook` on owned Xvfb, per the skill's Hook reattach section | 12s outage, same and new address: picture back ≤2s after path-back on the same session, one open, still advancing at +45s (new address through `restart_ice`); the data channel resumes on the new pair, not only the picture: a new-address run asserts fixture-confirmed key and pointer, an exact clipboard round trip through the hook, decoded frames still advancing, and generation-2 relay media (`controlProof`, `hookGeneration2Port`, `hookControlMarkers`), all under one open and no close; 40s: reopen ≤500ms after the first carrier, picture ≤3s; `--authorize-revoked`: `ended`, one authorize, held session ended by the host; `--media-cut`/`--stall-carrier`: the client's own ICE `failed` holds the session ~30s and it recovers on the same one; `--corrupt-offer`: an SDP-apply failure stays terminal |
| [Recovery from a dropped link](link-drop-recovery.md) | Private lab, Chromium, `test/link-drop-flow.mjs` | Userspace-shaped link throttled, cut and restored; `reconnecting` inside the cut with the last picture held, frames and control back after |

The browser input journey and both phone form factors are the executed seed
proofs, and one run covers both in `~/lab-tmp/desklink-verify/latest/`: the
skill's coverage table names every theme and form factor, with a capture for
each and the reason written down where a surface cannot be captured here. The
link-drop proof is its own flow and its own run directory, because it needs a
shaped link rather than a live desktop: it writes to
`~/lab-tmp/dl-pm-8-recovery/<run>/`. The shaping is a **userspace-shaped
link**, never kernel netem. The
iOS journeys run separately on the Mac (`~/lab-tmp/dl-pm-iphone/<run>/`),
because the phone-only control and the pointer mark exist only on the real iOS
runtime. The capability command is also exercised within its Doctor. The
agent-CLI journey is a
source-grounded recipe, **not a claimed pass from this run**. Keyboard/clipboard
in the browser, portal and other platform surfaces are outside this map and
require their own later proofs. Do not infer them from a browser click.
