# Changelog

## 0.3.0

- Enable the macOS engine by default and distribute a prebuilt Apple Silicon engine alongside Linux x64. `DESKLINK_MACOS=0` remains an explicit opt-out. macOS qualification passed a full journey and a 30-minute soak without capture stops at about 57 fps.
- Speed up X11 capture with MIT-SHM and damage tracking, reduce repeated frame conversions, and time encoding to captured frames.
- Adapt network bitrate to delay and default capture to 60 fps.
- Offer H.264 for captured desktops, including hardware encoding where available, and bring the iOS receiver to parity with hardware H.264 decoding.
- Recover interrupted sessions and fix the first-frame freeze on iOS.
- Add native iOS hardware keyboard and pointer input.
- Document installation for the host, React Native receiver and AXI CLI. Release all packages at 0.3.0.
