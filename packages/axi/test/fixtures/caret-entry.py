# A native GTK text entry for the caret proof: no browser paint involved.
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
win = Gtk.Window(title='Caret entry')
win.set_default_size(420, 70)
win.move(40, 40)
entry = Gtk.Entry()
entry.set_margin_start(16); entry.set_margin_end(16); entry.set_margin_top(20); entry.set_margin_bottom(20)
win.add(entry)
win.connect('destroy', Gtk.main_quit)
win.show_all()
Gtk.main()
