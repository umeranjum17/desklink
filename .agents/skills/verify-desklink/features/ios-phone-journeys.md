# The phone journeys on iOS

## Sub-features

Two journeys, both on a real iOS simulator running the example app against a
desktop this machine serves through the bridge:

- **a live, readable desktop on the phone** — the picture fills the agreed fit,
  carries no diagnostic text, and its decoded frames keep advancing;
- **controlling that desktop from the phone alone** — pointer, click, drag,
  two-finger scroll, typing, sticky modifiers and the clipboard both ways, with
  no input sent to the desktop from this machine;
- **finger-on-glass control (glass mode)** — the same six steps driven only by
  the XCTest UI-automation runner, so each input enters at UIKit's hit-testing
  and React Native's responder system rather than at the view's handlers;
- **a tapped desktop field stays in sight over the keyboard** — on a fresh
  landscape launch, with the app shrinking its surface the way a consumer's
  keyboard-avoiding screen does, the picture pans so the focused field stays
  wholly above the raised keyboard instead of snapping back to the desktop's
  top-left corner. Proven over five fresh launches, light and dark. Upright,
  one fresh launch proves the portrait sibling: the shortened band flips the
  view's own aspect while the window stays portrait, and the picture still pans
  the tapped low field into sight instead of mistaking the flip for a rotation.

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
  DESKLINK_IOS_MAC=user@mac DESKLINK_IOS_DIR=fm-desklink-ios DESKLINK_IOS_LANE=dl-ios-harness-polling \
  DESKLINK_IOS_DEVICE="fm-iPhone 17 Pro" \
  DESKLINK_IOS_OUT="$HOME/lab-tmp/dl-pm-iphone/run" \
  node packages/desktop-client/test/ios-flow.mjs
```

`DESKLINK_IOS_DEVICE` runs on one of the Mac's own named simulators and leaves it
in place; without it the flow creates a `desklink-ios-flow-*` simulator and
deletes it. `DESKLINK_IOS_IPAD=1` adds the iPad trackpad checks.

### Finger on glass (glass mode)

`DESKLINK_IOS_GLASS=1` proves the same six control steps through the glass: every
touch in the journey is synthesized by the XCTest UI-automation runner
(`test/ios-pointer/`), and the app is launched with `-desklinkUrl` only, so the
run has no `-desklinkJourney` handler-injection path in it at all. Run it on an
iPad simulator, which is what the captain's iPad question is about:

```sh
env -u DISPLAY -u WAYLAND_DISPLAY \
  DESKLINK_IOS_MAC=user@mac DESKLINK_IOS_DIR=fm-desklink-ios DESKLINK_IOS_LANE=dl-ipad-glass-touch \
  DESKLINK_IOS_DEVICE='fm-iPad (A16)' DESKLINK_IOS_IPAD=1 DESKLINK_IOS_GLASS=1 \
  DESKLINK_IOS_APP=Desklink.app DESKLINK_IOS_SKIP_BUILD=1 DESKLINK_IOS_KEEP=1 \
  DESKLINK_IOS_OUT="$HOME/lab-tmp/dl-ipad-glass-touch/glass-ipad" \
  node packages/desktop-client/test/ios-flow.mjs
```

It stops after the six control steps and the pointer mark, skipping the trackpad,
panning, pinch and keyboard-fit sections, so its one recording covers the touch
journey alone. `DESKLINK_IOS_APP` points at an app the lane built earlier (see
`test/mac-lane.mjs` for the one-lane-one-directory rule); without
`DESKLINK_IOS_SKIP_BUILD` the flow builds its own on the Mac.

Who delivers what, and what each step proves at the desktop:

| Step | Delivered by | Desktop sees |
|---|---|---|
| tap | `XCUICoordinate.tap()` | `mousedown`+`mouseup`, button 0, within one desktop pixel of where it was aimed |
| drag | `XCSynthesizedEventRecord` + `XCPointerEventPath` touch path | press, 31 held moves, release, and the page's text selected |
| two-finger scroll | two touch paths together | `wheel` events (measured, the engine coalesces: 2 events, `deltaY` -240) |
| typing | `axe type` (HID keyboard) | one `keydown` per character, the desktop's own field holding the text |
| sticky modifier | `XCUIElement.tap()` on the app's own `desklink-key-Control` | the next key as `Control+a`, then the latch cleared |
| clipboard out / in | `XCUIElement.tap()` on `desklink-copy` / `desklink-paste` | the phone's own confirmation pill, read by the runner in the same run, and the pasted text in the desktop's field |

The runner's aim is measured, not assumed: `touch-inset-the-phone-only-steps.json`
records a coordinate tap and a synthesized touch aimed at five desktop positions,
landing within one pixel at each with one fixed offset. A miss that moved with
the position would fail the run.

**What glass mode does not prove.** The simulator's glass is a synthesized HID
stream from the Mac, not a digitizer: this is proof of the delivery path (UIKit
hit-testing into React Native's responder system and the package's native input
view) and of the desktop's response, not of a human finger on a physical iPad.
The physical-iPad XCUITest route stays out of scope: it needs the one-time Touch
ID "Enable UI Automation" approval the captain's standing no-captain-touch rule
forbids, and no physical iPad is touched by any of this. Typing and chords are
HID keystrokes from `axe` (XCTest has no iOS hardware-keyboard API), delivered
through UIKit's `pressesBegan` into the package's native input view. Two things
worth knowing when reading the evidence: the confirmation pills live 1.5 s, so
the runner reads them in-run and writes them to `pointer-note-*.txt` rather than
letting the flow look after `xcodebuild` returns; and the lane's `DerivedData`
lives on the Mac's shared disk, which other lanes' pressure can delete - the app
can be recovered from the simulator's own installed container with
`xcrun simctl get_app_container <udid> dev.desklink.example app`.

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

The keyboard section launches the app five times fresh, each with
`-desklinkKeyboardFit 1` (the example wraps the picture in a keyboard-avoiding
container, so the surface shrinks as a consumer's does), turns the phone
sideways, taps a field the page placed low on the desktop, raises the keyboard
and reads the tap's own dot and the keyboard's first key row: every launch keeps
the whole field above the raised keyboard (`step-09-keyboard-{1..5}-{closed,open}.png`,
`step-09-keyboard-{1..5}.json`). A picture that snaps back to the desktop's
top-left corner fails every launch. The section then checks the light and dark
looks and that typing reaches the field, and copies `keyboard-landscape.mp4`.

A portrait sibling on one fresh launch taps a field placed low on the picture
itself, shortens the surface the same way and requires the same pan: the
shortened band flips the view's own aspect while the window stays portrait, so
mistaking that flip for a rotation would snap the picture back to the desktop's
top-left instead (`step-09-keyboard-portrait-{closed,open,typed}.png`,
`step-09-keyboard-portrait.json`, `keyboard-portrait.mp4`).

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

## One directory per lane, and who may delete what

The Mac lab disk is shared with other projects, so every Mac lane has to give
its space back when it finishes - but they all build under `~/fm-desklink-ios`.
Each lane therefore builds in its own subdirectory named for the task, through
`DESKLINK_IOS_DIR` (the shared root) and `DESKLINK_IOS_LANE` (required, this
lane's name). Two lanes can build at the same time; when a run finishes it
deletes **only its own lane directory**, and `test/mac-lane.mjs`'s `CLEAN_SCRIPT`
refuses to delete the shared root or anything outside it rather than guessing.
`DESKLINK_IOS_KEEP=1` keeps the directory instead (implied by
`DESKLINK_IOS_SKIP_BUILD=1`, which reuses what the lane last built).

Shared on purpose, under the root and never deleted by a lane's cleanup:
`.npm`, `.cocoapods` and `.cocoapods-cache`. Two lanes writing package caches
at once is safe; one lane deleting them mid-install is not. Everything a lane
builds - `node_modules`, `Pods`, `DerivedData`, its `TMPDIR`, its copy of this
checkout - is inside its own lane directory.

`~/fm-desklink-mac` is a separate preserved directory: no lane reads, writes or
cleans it.

## Gotchas

- **An iPad simulator needs a clean `npm install` after the SDK moves.** The
  package peers `expo-modules-core`, and npm resolves that peer on its own: left
  unbounded it hoists a newer major than the SDK uses, whose podspec asks for a
  higher iOS than the app's deployment target, and `pod install` then fails with
  `Unable to find a specification for ExpoModulesCore depended upon by ExpoAsset`.
  The peer is pinned to the SDK line for this reason; if a machine's
  `node_modules` predates that, delete `package-lock.json`,
  `node_modules/.package-lock.json` and `node_modules/expo-modules-core` before
  installing again, or npm keeps the hoisted copy it already resolved.
- **The iPad's "one inset low" miss was the flow's own stale picture, not
  XCUITest's aim.** Measured on the `fm-iPad (A16)` simulator (820x1180 pt,
  picture 819x461 pt at 0.64 screen pt per desktop pixel): the app starts with
  the picture under the status bar, at (0, 32), and moves it to (0, 0) once the
  session settles. The flow measured the picture once, up front, so every later
  aimed step - XCUITest's presses and `axe` taps alike - aimed a picture that had
  already moved, landing one status-bar inset (32 pt, about 50 desktop pixels)
  off. XCUITest aims exactly: re-measured after the app settled, a coordinate
  press and a pointer drag aimed at (150, 250) land on the desktop's (150, 249)
  and (150, 250). The flow now re-reads the picture and re-measures each
  instrument's miss at five positions before every section that aims, writes
  `touch-inset-<section>.json`, and takes the measured offset off every
  coordinate it hands a tool. Do not hard-code 32 pt anywhere.

- **After several XCUITest runs the simulator's accessibility tree goes empty.**
  `axe describe-ui` then returns one `AXApplication` node with no children and a
  0x0 frame, whatever is in front, and the flow fails with
  `the simulator never showed the desktop: status null`. `xcrun simctl shutdown`
  and `boot` the device (bootstatus -b) and the tree comes back; nothing about the
  app was wrong.

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
- **A first run against a new simulator used to lose the session.** On a
  simulator the flow had never run on, `xcodebuild test` had to install the
  XCUITest runner first, and the app under test came back saying `Your desktop
  ended this session` — the drag step then got nothing from the desktop, not
  because the touch failed. After #84 and #85 it did not reproduce: three cold
  runs, each on a simulator the flow created for itself, passed end to end. What
  fixed it is not isolated. Reusing one named simulator
  (`DESKLINK_IOS_DEVICE`) is still the cheaper path, and the flow reports the
  loss by that reason rather than as a missing drag.
