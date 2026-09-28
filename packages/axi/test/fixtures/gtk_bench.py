#!/usr/bin/env python3
"""GTK3 accessibility fixture for desklink-axi tree/marks tests.

Runs a small form on the private test display and prints one line per real
effect to stdout so tests can verify semantic actions independently of the
screen: typed/saved/icon pressed/dialog open/file chosen/resized/bye.
"""
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402


def say(line: str) -> None:
    print(line, flush=True)


def named(widget, name):
    widget.get_accessible().set_name(name)
    return widget


def build_icon_button():
    # Icon-only button: no text label and no accessible name, so neither OCR
    # nor the AX tree give it a name — the marks overlay is the usable ref.
    button = Gtk.Button()
    area = Gtk.DrawingArea()
    area.set_size_request(24, 24)

    def draw(_widget, cr):
        cr.set_source_rgb(0.85, 0.2, 0.1)
        cr.rectangle(4, 4, 16, 16)
        cr.fill()
        return False

    area.connect("draw", draw)
    button.add(area)
    button.set_tooltip_text("Record")
    return button


class Bench(Gtk.Window):
    def __init__(self):
        super().__init__(title="AXI A11y Bench")
        self.set_default_size(420, 200)
        self.connect("destroy", Gtk.main_quit)

        grid = Gtk.Grid(border_width=12, row_spacing=8, column_spacing=8)
        self.add(grid)

        label = Gtk.Label(label="Name")
        grid.attach(label, 0, 0, 1, 1)
        self.name = named(Gtk.Entry(), "Name field")
        self.name.set_placeholder_text("type a name")
        grid.attach(self.name, 1, 0, 2, 1)

        self.agree = named(Gtk.CheckButton(label="Agree"), "Agree")
        grid.attach(self.agree, 0, 1, 2, 1)

        self.status = named(Gtk.Label(label="idle"), "Status")
        grid.attach(self.status, 0, 2, 3, 1)

        self.save = named(Gtk.Button(label="Save"), "Save button")
        grid.attach(self.save, 0, 3, 1, 1)

        self.choose = named(Gtk.Button(label="Choose…"), "Choose button")
        grid.attach(self.choose, 1, 3, 1, 1)

        self.grow = named(Gtk.Button(label="Grow"), "Grow button")
        grid.attach(self.grow, 2, 3, 1, 1)

        self.icon = build_icon_button()
        grid.attach(self.icon, 3, 3, 1, 1)

        self.name.connect("changed", lambda e: say(f"typed {e.get_text()}"))
        self.save.connect("clicked", self.on_save)
        self.choose.connect("clicked", self.on_choose)
        self.grow.connect("clicked", self.on_grow)
        self.icon.connect("clicked", lambda b: say("icon pressed"))

    def on_save(self, _button):
        say(f"saved {self.name.get_text()} agree={str(self.agree.get_active()).lower()}")
        self.status.set_text(f"Saved {self.name.get_text()}")

    def on_grow(self, _button):
        # Resize AND move: both change every widget's screen-space extents, so
        # pre-move tree refs must go stale.
        pos = self.get_position()
        self.resize(self.get_size()[0] + 120, self.get_size()[1] + 10)
        self.move(pos[0] + 60, pos[1] + 40)
        say(f"resized {self.get_size()[0]}x{self.get_size()[1]}")

    def on_choose(self, _button):
        # Non-modal on purpose: with Gtk.Dialog.run()'s nested loop the atk
        # bridge stops answering AT-SPI method calls entirely (measured), so a
        # modal run() would hide the dialog from the accessibility tree.
        dialog = Gtk.FileChooserDialog(
            title="Export file", parent=self, action=Gtk.FileChooserAction.SAVE
        )
        dialog.add_buttons(
            "Cancel", Gtk.ResponseType.CANCEL, "Export", Gtk.ResponseType.OK
        )
        dialog.set_do_overwrite_confirmation(False)
        dialog.set_current_name("bench-export.txt")
        dialog.connect("response", self.on_dialog_response)
        self.dialog = dialog
        say("dialog open")
        dialog.show_all()

    def on_dialog_response(self, dialog, response):
        if response == Gtk.ResponseType.OK:
            chosen = dialog.get_filename()
            say(f"file chosen {chosen}")
            with open(chosen, "w") as handle:
                handle.write("bench export\n")
        dialog.destroy()
        self.dialog = None
        say("dialog closed")


win = Bench()
win.show_all()
win.name.set_text("preset")
say("ready")
Gtk.main()
say("bye")
