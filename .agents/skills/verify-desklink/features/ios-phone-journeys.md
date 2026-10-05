# The phone journeys on iOS

## Sub-features

Two journeys, both on a real iOS simulator running the example app against a
desktop this machine serves through the bridge:

- **a live, readable desktop on the phone** — the picture fills the agreed fit,
  carries no diagnostic text, and its decoded frames keep advancing;
- **controlling that desktop from the phone alone** — pointer, click, drag,
  two-finger scroll, typing, sticky modifiers and the clipboard both ways, with
  no input sent to the desktop from this machine.

## How to get to it (user POV)

Launch the example app with the bridge URL. Wait for `Connected`. The picture
fills the screen inside its safe area, the key row arms Ctrl/Shift/Alt/Meta, Copy
brings the desktop's clipboard over and Paste sends the phone's clipboard to the
desktop. A tap clicks, a finger that rests and travels drags, two fingers scroll,
the keyboard types, and the drawn arrow's tip marks the desktop's pointer.

## Driving it

`packages/desktop-client/test/ios-flow.mjs` runs the whole journey on the Mac
over ssh and serves the desktop from a private Xvfb here.

```sh
env -u DISPLAY -u WAYLAND_DISPLAY \
  DESKLINK_IOS_MAC=user@mac DESKLINK_IOS_DIR=fm-desklink-ios \
  DESKLINK_IOS_DEVICE="fm-iPhone 17 Pro" \
  DESKLINK_IOS_OUT="$HOME/lab-tmp/dl-pm-iphone/run" \
  node packages/desktop-client/test/ios-flow.mjs
```

`DESKLINK_IOS_DEVICE` runs on one of the Mac's own named simulators and leaves it
in place; without it the flow creates a `desklink-ios-flow-*` simulator and
deletes it. `DESKLINK_IOS_IPAD=1` adds the iPad trackpad checks.

## Observable proof

The phone-only control section records one screen recording on the simulator
(`phone-control.mp4`), a capture per step (`step-00-live-desktop.png` …
`step-08-pointer-arrow.png`), the events the desktop's own page logged
(`step-02-drag-events.json`, `pointer-events.json`), what the phone's screen said
(`visible-text.json`) and the arrow's measured geometry
(`step-08-pointer-arrow-4x.png`, `step-08-pointer.json`). `phone-control.json`
lists every step with its result.

What each step proves, from the desktop side rather than the app's own report:
a tap is one `mousedown`/`mouseup` at the desktop pixel under the finger; a drag
holds the button through its moves and selects the text it passed; two fingers
turn the wheel; typed characters land in the desktop's own field; a latched
modifier chords the next key and clears; the clipboard round-trips through the
engine in both directions; and the drawn mark is an arrow (0.3 pt at its tip,
13.9 pt at its widest) whose tip is within 2 pt of the desktop's pointer.

## What the run does not claim, and how it avoids fooling itself

- **Portrait does not "fill" the phone.** The documented default is fit-width, so
  a 16:9 desktop on a tall phone is a band at the top (measured: 401×226 pt on a
  402×874 pt screen) with letterbox and the app's own chrome below. The step says
  so and asserts the measured band against the predicted one; landscape, which
  covers, is asserted separately at 0% bars. Changing the portrait default is a
  product decision, not a test fix.
- **The accessibility tree says some words twice.** React Native hands it a
  wrapper and its inner text node at the same frame and pid: one word on screen,
  two nodes. The flow collapses by frame, keeps the named node, records every
  string with its frame in `visible-text.json`, and asserts the live status reads
  `Connected` once. `DESKLINK_IOS_TREE=<path>` writes the raw tree when a reviewer
  wants to see which node said what.
- **Every step starts from a cleared desktop.** The page's `window.reset()` takes
  the click dots and the event logs away before each step, so a capture carries
  only what that step did.
- **A keystroke arrives once.** The page's own key log is the truth: typing
  `desklink` must produce exactly eight keydowns, the field must read `desklink`,
  and the notes line's mirror must be unchanged. A fixture that mirrors every
  printable key into a line *and* lets a focused field take it will look like
  duplicate delivery when it is the fixture showing both.

## Gotchas

- **A chord goes to the desktop, and the desktop reacts.** `Control+J` is Chrome's
  Downloads: the lab desktop navigates away and every later step sees a different
  page. Use a chord with no host binding, and assert the page is still there.
- **Phones take no pointer events.** `XCUICoordinate` actions (`hover`,
  `click(forDuration:thenDragTo:)`, `rightClick`, `scroll`) throw "Pointer events
  are not supported for this device" on an iPhone simulator. Drag and two-finger
  scroll have to be synthesized touch (`XCSynthesizedEventRecord` +
  `XCPointerEventPath`), and a path's lift offset must be later than its last
  move.
- **Expo names the generated project after the app, not the package.** The
  workspace, scheme and `.app` are `Desklink*`, and the flow discovers them
  instead of assuming `desklinkexample`.
- **The simulator shares the Mac's pasteboard.** Reading the phone's clipboard
  through `simctl pbpaste` proves the Mac's, and writing it with `pbcopy` raises
  an OS paste prompt. Read the app's own confirmation pill instead.
- **The clipboard pill lives about 1.5 s** and `axe describe-ui` takes about a
  second: poll for the pill, not once before it.
- **The committed `target/debug/desklink-host` can be stale**, and a stale engine
  refuses X11 clipboard transfers that the current source offers. Build it before
  a run.
- **A first run against a new simulator loses the session.** On a simulator the
  flow has never run on, `xcodebuild test` has to install the XCUITest runner
  first, and the app under test comes back saying `Your desktop ended this
  session` — the drag step then gets nothing from the desktop, not because the
  touch failed. Reuse one named simulator (`DESKLINK_IOS_DEVICE`) and the runner
  is already installed. Unfixed; the flow reports it by that reason rather than
  as a missing drag.
