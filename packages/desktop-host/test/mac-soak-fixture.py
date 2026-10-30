#!/usr/bin/env python3
"""The window the macOS soak types into and watches.

Started by `mac-soak-flow.mjs` on the private Mac lab: `mac-soak-fixture.py X Y W H LOG FOCUS_LOG`
(points, display origin top-left). It is a borderless window this script owns, in two
halves: the left cell flips black/white 60 times a second, so capture keeps running at
its full frame rate while nothing else on the desktop moves; the right cell flips on
every key it receives, so the client can time a keystroke from the control channel to
the picture. Each key is also appended to LOG as `<wall-clock ms> <character>`, which
is the ground truth that typing reached the Mac.

It re-takes key focus when the Mac wakes. It never answers a system sheet.
"""

import sys
import time

from AppKit import (NSApplication, NSApplicationActivationPolicyRegular, NSBackingStoreBuffered, NSColor,
                    NSFloatingWindowLevel, NSScreen, NSView, NSWindow, NSWindowStyleMaskBorderless,
                    NSWorkspace, NSWorkspaceDidWakeNotification)
from Foundation import NSTimer


class Fixture(NSWindow):
    def canBecomeKeyWindow(self):
        return True

    def keyDown_(self, event):
        text = event.characters() or ""
        with open(LOG, "a") as log:
            log.write(f"{int(time.time() * 1000)} {text}\n")
        self.echo_on = not self.echo_on
        paint(self.echo, self.echo_on)


def paint(view, on):
    color = NSColor.whiteColor() if on else NSColor.blackColor()
    view.layer().setBackgroundColor_(color.CGColor())


def cell(frame):
    view = NSView.alloc().initWithFrame_(frame)
    view.setWantsLayer_(True)
    paint(view, False)
    return view


def main(argv):
    global LOG, FOCUS_LOG
    x, y, width, height = (float(value) for value in argv[:4])
    LOG, FOCUS_LOG = argv[4:6]
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    cocoa_y = NSScreen.mainScreen().frame().size.height - y - height
    window = Fixture.alloc().initWithContentRect_styleMask_backing_defer_(
        ((x, cocoa_y), (width, height)), NSWindowStyleMaskBorderless, NSBackingStoreBuffered, False)
    window.setLevel_(NSFloatingWindowLevel)
    window.setOpaque_(True)
    window.setHasShadow_(False)
    window.setReleasedWhenClosed_(False)
    half = width / 2
    window.pulse = cell(((0, 0), (half, height)))
    window.echo = cell(((half, 0), (half, height)))
    window.echo_on = False
    window.pulse_on = False
    window.contentView().addSubview_(window.pulse)
    window.contentView().addSubview_(window.echo)

    def tick(_timer):
        window.pulse_on = not window.pulse_on
        paint(window.pulse, window.pulse_on)

    def focus(*_):
        app.activateIgnoringOtherApps_(True)
        window.makeKeyAndOrderFront_(None)

    def sample_focus(_timer):
        current = (bool(app.isActive()), bool(window.isKeyWindow()))
        with open(FOCUS_LOG, "a") as log:
            log.write(f"{int(time.time() * 1000)} active={int(current[0])} key={int(current[1])}\n")

    NSTimer.scheduledTimerWithTimeInterval_repeats_block_(0.5, True, sample_focus)
    NSTimer.scheduledTimerWithTimeInterval_repeats_block_(1 / 60, True, tick)
    NSWorkspace.sharedWorkspace().notificationCenter().addObserverForName_object_queue_usingBlock_(
        NSWorkspaceDidWakeNotification, None, None, focus)
    focus()
    print("READY", flush=True)
    app.run()
    return 0


LOG = None
FOCUS_LOG = None

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
