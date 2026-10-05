#!/usr/bin/env python3
"""A lab document fixture: a real text document on a display this task owns.

The colour-band target in `examples/x11_target.rs` proves that pixels and events
cross the wire. It cannot prove that a *drag* selects text, that a right click
opens something, that a wheel moves a page, or that typed characters are the
ones the user typed: bands have no text to select. This fixture is that other
half - one GTK text view holding a real document, long enough to scroll, whose
own events are recorded so the check can compare what the phone asked for with
what the desktop received.

Run it against a server you own:

    Xvfb :170 -screen 0 1280x720x24 &
    DISPLAY=:170 python3 notes-document.py --events /tmp/events.jsonl \\
        --text /tmp/document.txt

It owns no clipboard: `examples/x11_clip.rs` holds CLIPBOARD for the clipboard
journey, and two owners would make the readback ambiguous.
"""

import argparse
import json
import os
import sys
import time

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

WIDTH = 1280
HEIGHT = 720

DOCUMENT = """Umer demo notes - pointer and keyboard journey

This document is the desktop side of the phone proof. It has real words in a
real text view, so a drag can leave a visible selection, a wheel can move a real
page, and what the user typed can be read back byte for byte.

Pointer accuracy
The phone draws a pointer whose tip is the click target. Tap a word and the
word under the tip is the one that changes, which is the whole claim: within two
desktop pixels, the tip and the event agree.

Drag to select
Press and hold near the start of this sentence, drag across it and release. The
selected words stay highlighted in blue while the button is down and after it
comes up, so the result is visible in the captured picture and not only in this
event log.

Right click
A long press on the text opens a menu. Its items are Cut, Copy and Paste, so a
menu that opened is visible in the picture itself.

Scroll
Two fingers on the picture scroll the document. It is deliberately longer than
the window, so a scroll that lands is a scroll you can see.

Keyboard
The phone's own keyboard types into this view, with the sticky Ctrl, Shift, Alt
and Meta keys arming a modifier for the next keystroke.

Clipboard
The desktop clipboard is held by the separate clipboard fixture, so that the
copy to phone and the paste from phone journeys have one unambiguous owner.
"""


class Fixture:
    def __init__(self, args):
        self.events = open(args.events, "a", buffering=1)
        self.text_path = args.text
        self.selection_path = args.selection
        self.args = args
        self.buffer = None

    def log(self, kind, **fields):
        row = {"kind": kind, "t": round(time.time(), 4)}
        row.update(fields)
        self.events.write(json.dumps(row, sort_keys=True) + "\n")

    def dump(self):
        text = self.buffer.get_text(self.buffer.get_start_iter(), self.buffer.get_end_iter(), False)
        with open(self.text_path, "w") as handle:
            handle.write(text)
        start, end = self.buffer.get_selection_bounds() or (None, None)
        selected = self.buffer.get_text(start, end, False) if start else ""
        with open(self.selection_path, "w") as handle:
            handle.write(selected)

    def pointer(self, _controller, x, y):
        self.log("pointer", x=round(x), y=round(y))
        # The GTK pointer sits inside the window; the lab window is at 0,0, so
        # view coordinates are desktop coordinates.
        return False

    def primary_down(self, _controller, _n_press, x, y):
        self.log("button", x=round(x), y=round(y), button=1, phase="down")
        return True

    def primary_up(self, _controller, _n_press, x, y):
        self.log("button", x=round(x), y=round(y), button=1, phase="up")
        GLib.timeout_add(60, self.dump)
        return True

    def secondary_down(self, _controller, _n_press, x, y):
        self.log("button", x=round(x), y=round(y), button=3, phase="down")
        return True

    def secondary_up(self, _controller, _n_press, x, y):
        self.log("button", x=round(x), y=round(y), button=3, phase="up")
        menu = Gtk.PopoverMenu.from_model(
            Gtk.StringList.new(["Cut", "Copy", "Paste", "Select all"])
        )
        menu.set_parent(self.window)
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        menu.set_pointing_to(rect)
        menu.set_has_arrow(False)
        menu.popup()
        self.log("menu", x=round(x), y=round(y), open=True)
        return True

    def scroll(self, _controller, dx, dy):
        self.log("wheel", dx=round(dx, 3), dy=round(dy, 3))
        return False

    def key(self, _controller, keyval, _code, state):
        text = chr(keyval) if 32 <= keyval < 0x110000 else ""
        mods = []
        if state & Gtk.ModifierType.CONTROL_MASK:
            mods.append("Control")
        if state & Gtk.ModifierType.SHIFT_MASK:
            mods.append("Shift")
        self.log("key", keyval=int(keyval), character=text, modifiers=mods)
        self.dump()
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--selection", default=None)
    parser.add_argument("--pointer-file", default=None, help="last pointer position, for a readback")
    args = parser.parse_args()
    if args.selection is None:
        args.selection = args.text + ".selection"

    fixture = Fixture(args)
    window = Gtk.Window(title="Umer demo notes")
    window.set_default_size(WIDTH, HEIGHT)
    fixture.window = window

    scroller = Gtk.ScrolledWindow()
    scroller.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
    view = Gtk.TextView()
    view.set_monospace(False)
    view.set_wrap_mode(Gtk.WrapMode.WORD)
    view.set_left_margin(28)
    view.set_right_margin(28)
    view.set_top_margin(20)
    buffer = view.get_buffer()
    buffer.set_text(DOCUMENT)
    fixture.buffer = buffer
    scroller.set_child(view)
    window.set_child(scroller)

    motion = Gtk.EventControllerMotion()
    motion.connect("motion", fixture.pointer)
    view.add_controller(motion)
    left = Gtk.GestureClick(button=1)
    left.connect("pressed", fixture.primary_down)
    left.connect("released", fixture.primary_up)
    view.add_controller(left)
    right = Gtk.GestureClick(button=3)
    right.connect("pressed", fixture.secondary_down)
    right.connect("released", fixture.secondary_up)
    view.add_controller(right)
    wheel = Gtk.EventControllerScroll()
    wheel.connect("scroll", fixture.scroll)
    view.add_controller(wheel)
    keys = Gtk.EventControllerKey()
    keys.connect("key-pressed", fixture.key)
    window.add_controller(keys)

    window.set_focus_child(scroller)

    def start():
        window.present()
        view.grab_focus()
        fixture.log("ready", width=WIDTH, height=HEIGHT)
        fixture.dump()
        loop = GLib.MainLoop()
        GLib.timeout_add(600_000, lambda: (loop.quit(), False)[1])
        loop.run()

    fixture.dump()
    sys.exit(start())


if __name__ == "__main__":
    main()
