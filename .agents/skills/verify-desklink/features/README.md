# desklink feature map

Run from the repository root. [The skill](../SKILL.md) owns Launch, Doctor,
Evidence and Cleanup. Never use a person's display; every desktop journey must
use the ownership-verified private lab.

| User feature | Drive | Observable proof |
|---|---|---|
| [Live desktop in a browser](live-desktop-in-browser.md) | Bridge URL → real pointer click on `#video` | Numeric fixture edges and returned marker pixels; automated helper |
| [Phone form factors](phone-form-factors.md) | Same engine, portrait 390×844 and landscape 844×390 | Measured picture fit per form factor, fixture button edge from a tap, recorded pinch zoom |
| [Machine capabilities](capabilities-report.md) | `desklink-host capabilities` | Actual capability JSON and engine child exit; helper Doctor |
| [Desktop control from the agent CLI](agent-cli-desktop-as-text.md) | Existing private-lab CLI flow | Independent X11 click/typing/clipboard effects; separate journey |

The browser input journey and both phone form factors are the executed seed
proofs, and one run covers both in `~/lab-tmp/desklink-verify/latest/`: the
skill's coverage table names every theme and form factor, with a capture for
each and the reason written down where a surface cannot be captured here. The
capability command is also exercised within its Doctor. The agent-CLI journey is a
source-grounded recipe, **not a claimed pass from this run**. Keyboard/clipboard
in the browser, portal and other platform surfaces are outside this map and
require their own later proofs. Do not infer them from a browser click.
