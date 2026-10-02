# Changelog

## Unreleased (planned joint 0.4.0)

- Make consumer pairing the only trust boundary: paired sessions get all available view, input and clipboard access. Legacy `permissions` is accepted and ignored; OS consent remains required and missing input backends fail per action.
- Add bounded X11 CLIPBOARD read/write on the selected display, without INCR transfers or persistence after engine exit.
- AXI always connects its control channel. Legacy `start --control` is an ignored no-op; `start` and `home` no longer print `permissions=`.
- The React Native example's status line shows plain states such as Connected or Your desktop ended this session. It no longer shows the bridge address, pairing token, raw failure text or frame metrics.
- Host and engine stay pinned together with protocol 3. New AXI requires the matching engine; overriding it with a 0.3.x engine is unsupported. Release waits for the React Native compatibility update and integrated proof.

## 0.3.1

- Pin checkpoint workspace dependencies and align the host, engine, React Native receiver and AXI package versions.
- Label macOS desktop support as preview; see the [host installation guide](packages/desktop-host/README.md#macos-preview) for its support status and setup.
- Prevent the macOS release engine from linking Homebrew's libvpx dylib.
- Refuse ambient desktop endpoints in integration labs and verify owned Xvfb and browser process identities before contact or cleanup.
- Harden browser-helper teardown and benchmark process inventory handling during shutdown.

## 0.3.0

- Enable the macOS engine by default and distribute a prebuilt Apple Silicon engine alongside Linux x64. A macOS lab run passed a full journey and a 30-minute soak without capture stops at about 57 fps; this did not establish qualified desktop support. See the [host installation guide](packages/desktop-host/README.md#macos-preview) for current support and the opt-out.
- Speed up X11 capture with MIT-SHM and damage tracking, reduce repeated frame conversions, and time encoding to captured frames.
- Adapt network bitrate to delay and default capture to 60 fps.
- Offer H.264 for captured desktops, including hardware encoding where available, and bring the iOS receiver to parity with hardware H.264 decoding.
- Recover interrupted sessions and fix the first-frame freeze on iOS.
- Add native iOS hardware keyboard and pointer input.
- Document installation for the host, React Native receiver and AXI CLI. Release all packages at 0.3.0.
