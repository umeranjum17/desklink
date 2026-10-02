# Changelog

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
