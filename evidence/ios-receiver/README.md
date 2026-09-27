# iOS receiver simulator proof

On a task-owned iPhone 17 Pro iOS 26.3 simulator, the minimal Expo SDK 55 / React Native 0.83.1 dev client linked `react-native-webrtc` 124.0.8 and the local `@desklink/react-native` package. It connected to a task-owned Linux Xvfb `:175` verified as X.Org 1280×720 (not Xwayland), with a task-owned x11 test target and bridge. No person's display received capture or input.

- `live.png`: `live presented` after native `RTCView` reported video dimensions, with the X11 target's colored bands visible.
- `tap.png`: iOS touch at (201,520) mapped to desktop (640,435); target recorded pointer, left-button down/up at (640,435).
- `drag.png`: long-press then drag from (170,485) to (220,530); target recorded button down at (541,323), pointer movement, and button up at (700,467).
- `typing.png`: on the final candidate, typing `final` appended exactly `final` to the X11 target's saved text buffer.

Clipboard request/response sequencing is covered by `src/native.ios.spec.ts`. A live positive clipboard round trip cannot be exercised with this X11 source: the host intentionally rejects both clipboard directions for `x11-root` (`packages/desktop-host/engine/src/session.rs`, `clipboard_refusal`). The Mac signed engine's capture source is the person's real display, which this task must not use for input/capture QA. No live clipboard success is claimed.
