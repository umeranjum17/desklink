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

    Xvfb :170 -screen 0 1280x720x24 -nolisten tcp &
    DISPLAY=:170 python3 notes-document.py --events /tmp/events.jsonl \\
        --text /tmp/document.txt

Every recorded x/y is in root-window coordinates, so a pointer sample can be
compared with the desktop pixel a caller asked for without knowing where the
view sits inside the window. It owns no clipboard: `examples/x11_clip.rs` holds
CLIPBOARD for the clipboard journey, and two owners would make the readback
ambiguous.
"""

import argparse
import json
import sys
import time

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gio, GLib, Gtk  # noqa: E402

WIDTH = 1280
HEIGHT = 720

# The modifiers a sticky key row can arm, in the engine's names. A key event
# that arrives with only Super held has to say so, or "Super is sticky" cannot
# be told from "Super did nothing". GTK4 keeps these on Gdk, not Gtk.
MODIFIER_MASKS = (
    ("Control", Gdk.ModifierType.CONTROL_MASK),
    ("Shift", Gdk.ModifierType.SHIFT_MASK),
    ("Alt", Gdk.ModifierType.ALT_MASK),
    ("Super", Gdk.ModifierType.SUPER_MASK),
)

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


def printable(keyval):
    """The character a keyval types, or '' for keys that type nothing.

    `chr(keyval)` is wrong for Return and every other non-typable key: it
    reports U+FF0D for Return, so a byte-exact check against the character
    field would never match what a user actually typed.
    """
    codepoint = Gdk.keyval_to_unicode(keyval)
    if codepoint == 0:
        return ""
    character = chr(codepoint)
    return character if character.isprintable() else ""


class Fixture:
    def __init__(self, args):
        self.events = open(args.events, "a", buffering=1)
        self.text_path = args.text
        self.selection_path = args.selection
        self.window = None
        self.view = None
        self.buffer = None
        self.dragging = False

    def log(self, kind, **fields):
        row = {"kind": kind, "t": round(time.time(), 4)}
        row.update(fields)
        self.events.write(json.dumps(row, sort_keys=True) + "\n")

    def at(self, x, y):
        """Widget coordinates as root-window coordinates.

        The view sits inside margins and a scrolled window, so view-local x/y
        is tens of pixels away from the desktop pixel the caller meant. That
        would fail a two-pixel tip-versus-event check on a perfectly correct
        tap, so every sample is translated before it is recorded.
        """
        if self.view is None or self.window is None:
            return round(x), round(y)
        point = self.view.translate_coordinates(self.window, x, y)
        if point is None:
            return round(x), round(y)
        # PyGObject hands back a plain (x, y) tuple, not a Gdk.Point.
        gx, gy = point
        return round(gx), round(gy)

    def dump(self):
        text = self.buffer.get_text(self.buffer.get_start_iter(), self.buffer.get_end_iter(), False)
        with open(self.text_path, "w") as handle:
            handle.write(text)
        bounds = self.buffer.get_selection_bounds()
        # PyGObject returns (has_selection, start, end), and an empty tuple
        # when it cannot say; unpacking two names raises on the first.
        has_selection = len(bounds) == 3 and bool(bounds[0])
        selected = self.buffer.get_text(bounds[1], bounds[2], False) if has_selection else ""
        with open(self.selection_path, "w") as handle:
            handle.write(selected)

    def pointer(self, _controller, x, y):
        gx, gy = self.at(x, y)
        self.log("pointer", x=gx, y=gy)
        # A drag selects while the button is still down, and a release the
        # device drops must not cost the record of it: the selection is read
        # out of the buffer here, not only when the finger lifts.
        if self.dragging:
            self.dump()
        return False

    def primary_down(self, _controller, _n_press, x, y):
        gx, gy = self.at(x, y)
        self.dragging = True
        self.log("button", x=gx, y=gy, button=1, phase="down")
        return True

    def primary_up(self, _controller, _n_press, x, y):
        gx, gy = self.at(x, y)
        self.dragging = False
        self.log("button", x=gx, y=gy, button=1, phase="up")
        GLib.timeout_add(60, self.dump)
        return True

    def secondary_down(self, _controller, _n_press, x, y):
        gx, gy = self.at(x, y)
        self.log("button", x=gx, y=gy, button=3, phase="down")
        return True

    def secondary_up(self, _controller, _n_press, x, y):
        gx, gy = self.at(x, y)
        self.log("button", x=gx, y=gy, button=3, phase="up")
        # A popover menu takes a Gio.MenuModel; a Gtk.StringList of strings is
        # a GListModel and raises TypeError here, so the menu never opens.
        menu = Gio.Menu()
        section = Gio.Menu()
        for label in ("Cut", "Copy", "Paste", "Select all"):
            section.append(label, f"fixture.{label.lower().replace(' ', '-')}")
        menu.append_section(None, section)
        # The items carry no handlers: what this journey proves is that a
        # secondary click opens something a person can see, and a Gtk.Window is
        # not an action map, so registering actions here would only raise.
        popover = Gtk.PopoverMenu.new_from_model(menu)
        popover.set_parent(self.window)
        popover.set_has_arrow(False)
        popover.connect("show", lambda *_args: self.log("menu", x=gx, y=gy, open=True))
        rectangle = Gdk.Rectangle()
        rectangle.x, rectangle.y, rectangle.width, rectangle.height = gx, gy, 1, 1
        popover.set_pointing_to(rectangle)
        popover.popup()
        return True

    def scroll(self, _controller, dx, dy):
        self.log("wheel", dx=round(dx, 3), dy=round(dy, 3))
        return False

    def key(self, _controller, keyval, _code, state):
        modifiers = [name for name, mask in MODIFIER_MASKS if mask and state & mask]
        self.log("key", keyval=int(keyval), character=printable(keyval), modifiers=modifiers)
        self.dump()
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--selection", default=None)
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
    view.set_wrap_mode(Gtk.WrapMode.WORD)
    view.set_left_margin(28)
    view.set_right_margin(28)
    view.set_top_margin(20)
    buffer = view.get_buffer()
    buffer.set_text(DOCUMENT)
    fixture.view = view
    fixture.buffer = buffer
    scroller.set_child(view)
    window.set_child(scroller)
    window.set_focus_child(scroller)

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

    loop = GLib.MainLoop()

    def start():
        window.present()
        view.grab_focus()
        fixture.log("ready", width=WIDTH, height=HEIGHT)
        fixture.dump()
        # A lab fixture must never outlive its journey: if the harness dies,
        # this leaves on its own rather than spinning under a display forever.
        GLib.timeout_add(1_800_000, lambda: (loop.quit(), False)[1])
        loop.run()

    fixture.dump()
    start()
    sys.exit(0)


if __name__ == "__main__":
    main()
