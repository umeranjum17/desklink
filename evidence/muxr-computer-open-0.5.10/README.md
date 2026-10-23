# muxr Computer view with @desklink/host 0.5.10

**Result: it opens and shows a live picture.** From muxr's Computer flow, the screen came up within about two seconds of tapping *View screen*, and it kept updating.

## What ran

- muxr at `main` commit `b477e58` ("bump @desklink/host to 0.5.10", muxr PR 1041), fresh clone, `yarn install --frozen-lockfile`, `yarn build`, web export with muxr's lab pairing flag.
- Installed engine: `@desklink/host` 0.5.10 and `@desklink/host-linux-x64-gnu` 0.5.10 (read from `node_modules`).
- muxr's real relay, real host and real engine (muxr's browser-pairing lab stack, which fakes only the terminal multiplexer). The host's desktop source was `MUXR_DESKTOP_SOURCE=x11` on a private Xvfb (`:91`), with `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` unset. The "desktop" was a Chromium window showing a ticking clock and a colour that changes every 50 ms, so a live picture is unmistakable.
- The viewer was muxr's web app in a second Chromium window on another private Xvfb (`:90`), paired through muxr's own pairing path.
- Private lab only: both displays, the relay and the browsers were started and stopped by this task. No live desktop, Sunshine setup or paired device was touched.

## Flow driven (what a user does)

Home -> open the Pi agent -> Pane actions -> Computers -> **View screen**.

## Captures

- `01-computers-sheet.png`: the Computers sheet with *View screen* for the lab computer.
- `02-computer-open.png`: the Computer view, a few seconds after the tap. It shows the lab desktop, `tick 6464`.
- `03-engine-desktop-same-moment.png`: the lab desktop itself, grabbed straight from Xvfb `:91` at the same moment, `tick 6462`. The two ticks differ by two, about 100 ms of transport and capture delay.
- `04-computer-later.png`: the same view about ten seconds later, with a different clock and colour.
- `computer-open.mp4`: 26 s screen recording of the viewer window (392x800) covering the sheet, the tap and the live picture. The clock and colour change throughout.

## Limits

- Linux X11 source only. The portal (Wayland) source and a real phone were not exercised here.
- The viewer is the web app in a desktop browser on the same machine, so the picture reached it over a local WebRTC path, not through a relay-only network.
- *This computer cannot share its clipboard* shows in `02-computer-open.png`. The picture is live, so the open did not fail; the cause of this notice was not investigated.
- Tapping the terminal's key-row "Computer" label in the lab produced a new shell pane instead of the Computer view; the proof uses Pane actions -> Computers -> View screen. Not investigated, and possibly a lab-stack artifact.
