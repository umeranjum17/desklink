#!/usr/bin/env python3
"""Session::point proof on a PRIVATE headless sway (never an ambient socket).

CARGO_TARGET_DIR=<task-owned target> DESKLINK_POINT_EVIDENCE_DIR=<private dir> \
  python3 packages/desktop-host/engine/test/point-wayland-flow.py
Needs sway, foot, grim and Pillow; SWAY_BIN/SWAYMSG_BIN may name local binaries.
The Rust fixture supplies a selected portal monitor without needing a consent UI.
"""
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import struct
import threading
import subprocess
import time
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[4]
ENGINE = ROOT / "packages/desktop-host/engine"
EVIDENCE = Path(os.environ["DESKLINK_POINT_EVIDENCE_DIR"]).resolve()
TARGET = Path(os.environ["CARGO_TARGET_DIR"]).resolve()
EVIDENCE.mkdir(parents=True, exist_ok=True)
runtime = EVIDENCE / "runtime"
runtime.mkdir(mode=0o700, exist_ok=True)
assert not any(runtime.glob("wayland-*")), "runtime must have no preexisting compositor socket"
for path in EVIDENCE.glob("*.ready"):
    path.unlink()
for path in EVIDENCE.glob("*.continue"):
    path.unlink()
env = os.environ.copy()
for key in ["WAYLAND_DISPLAY", "DISPLAY", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS"]:
    env.pop(key, None)
env.update(XDG_RUNTIME_DIR=str(runtime), XDG_CONFIG_HOME=str(EVIDENCE / "config"),
           WLR_BACKENDS="headless", WLR_HEADLESS_OUTPUTS="2", WLR_RENDERER="pixman")
config = EVIDENCE / "sway.conf"
config.write_text("""output HEADLESS-1 mode 1280x720 position 0 0
output HEADLESS-2 mode 1280x720 position 1280 0
seat seat0 fallback true
focus_follows_mouse no
mouse_warping none
xwayland disable
""")
sway = os.environ.get("SWAY_BIN", "sway")
swaymsg = os.environ.get("SWAYMSG_BIN", "swaymsg")
children = []
logs = []

def start(args, log):
    output = open(EVIDENCE / log, "w")
    logs.append(output)
    child = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=output,
                             stderr=subprocess.STDOUT, start_new_session=True)
    children.append(child)
    return child

def wait_until(predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "private flow timed out"
        time.sleep(0.02)

def ipc(*args):
    return json.loads(subprocess.check_output([swaymsg, "-r", *args], env=env))

def focus(tree):
    if tree.get("focused"):
        return tree.get("id")
    for node in tree.get("nodes", []) + tree.get("floating_nodes", []):
        found = focus(node)
        if found is not None:
            return found

def fixture_window(tree):
    if tree.get("app_id") == "foot":
        return tree.get("id")
    for node in tree.get("nodes", []) + tree.get("floating_nodes", []):
        found = fixture_window(node)
        if found is not None:
            return found

def capture(name, output="HEADLESS-2"):
    path = EVIDENCE / f"desklink-point-here-wayland-{name}.png"
    subprocess.run(["grim", "-c", "-o", output, str(path)], env=env, check=True)
    return Image.open(path).convert("RGB")

def equal(left, right):
    return ImageChops.difference(left, right).getbbox() is None

# Virtual-pointer wire signatures: Copyright (c) 2019 Josef Gajdusek.
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
def request(connection, object_id, opcode, body=b""):
    connection.sendall(struct.pack("=II", object_id, ((8 + len(body)) << 16) | opcode) + body)

def messages(connection):
    pending = b""
    while True:
        while len(pending) < 8:
            part = connection.recv(4096)
            if not part:
                return
            pending += part
        object_id, header = struct.unpack("=II", pending[:8])
        length, opcode = header >> 16, header & 0xffff
        while len(pending) < length:
            pending += connection.recv(4096)
        yield object_id, opcode, pending[8:length]
        pending = pending[length:]

def wire_string(value):
    value = value.encode() + b"\0"
    return struct.pack("=I", len(value)) + value + b"\0" * (-len(value) % 4)

def virtual_pointer(path):
    connection = socket.socket(socket.AF_UNIX)
    connection.connect(path)
    request(connection, 1, 1, struct.pack("=I", 2))  # display.get_registry
    request(connection, 1, 0, struct.pack("=I", 3))  # display.sync
    manager = None
    for object_id, opcode, body in messages(connection):
        if object_id == 2 and opcode == 0:
            name, length = struct.unpack("=II", body[:8])
            if body[8:8 + length].rstrip(b"\0") == b"zwlr_virtual_pointer_manager_v1":
                manager = name
        if object_id == 3:
            break
    assert manager is not None, "private compositor needs virtual-pointer for pointer proof"
    request(connection, 2, 0, struct.pack("=I", manager) + wire_string("zwlr_virtual_pointer_manager_v1") + struct.pack("=II", 1, 4))
    request(connection, 4, 0, struct.pack("=II", 0, 5))  # create_virtual_pointer
    return connection

def pointer_move(connection, x, y):
    request(connection, 5, 1, struct.pack("=IIIII", 1, x, y, 2560, 720))
    request(connection, 5, 4)

def no_layer_shell_server(path):
    # A minimal private Wayland registry with no layer-shell global. Exercises
    # the real helper's discovery/refusal; no desktop or external bus involved.
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(path)); listener.listen()
    def serve():
        while True:
            try:
                connection, _ = listener.accept()
            except OSError:
                return
            with connection:
                try:
                    for object_id, opcode, body in messages(connection):
                        if object_id == 1 and opcode == 0:
                            callback, = struct.unpack("=I", body)
                            request(connection, callback, 0, struct.pack("=I", 1))
                            request(connection, 1, 1, struct.pack("=I", callback))
                except (BrokenPipeError, ConnectionResetError):
                    pass  # probe may exit as soon as it sees callback.done
    threading.Thread(target=serve, daemon=True).start()
    return listener

pointer = unavailable = None
try:
    compositor = start([sway, "-c", str(config)], "compositor.log")
    wait_until(lambda: list(runtime.glob("wayland-*.lock")) or compositor.poll() is not None)
    assert compositor.poll() is None, (EVIDENCE / "compositor.log").read_text()
    socket_lock = next(runtime.glob("wayland-*.lock"))
    env["WAYLAND_DISPLAY"] = str(socket_lock.with_suffix(""))  # absolute PRIVATE socket
    env["SWAYSOCK"] = str(next(runtime.glob("sway-ipc.*.sock")))
    outputs = ipc("-t", "get_outputs")
    assert {o["name"] for o in outputs} == {"HEADLESS-1", "HEADLESS-2"}
    pointer = virtual_pointer(env["WAYLAND_DISPLAY"])
    unavailable_path = runtime / "no-layer-shell"
    if unavailable_path.exists(): unavailable_path.unlink()
    unavailable = no_layer_shell_server(unavailable_path)
    fixture = start(["foot", "-c", "/dev/null", "-o", "cursor.blink=no", "sh", "-c",
                     "printf 'Desklink: point here\nPrivate Wayland output\n\033[?1000h\033[?1006h'; stty -echo -icanon; exec cat > "+shlex.quote(str(EVIDENCE / "click.bin"))], "fixture.log")
    wait_until(lambda: fixture_window(ipc("-t", "get_tree")) is not None)
    ipc("[app_id=foot]", "move", "to", "output", "HEADLESS-2")
    pointer_move(pointer, 1350, 80)
    time.sleep(0.2)
    ipc("[app_id=foot]", "focus")
    wait_until(lambda: focus(ipc("-t", "get_tree")) == fixture_window(ipc("-t", "get_tree")))
    time.sleep(1)
    baseline_focus = focus(ipc("-t", "get_tree"))
    assert baseline_focus == fixture_window(ipc("-t", "get_tree"))
    env.update(DESKLINK_POINT_UNSUPPORTED_SOCKET=str(unavailable_path), DESKLINK_POINT_TEST_DIR=str(EVIDENCE), DESKLINK_POINT_TEST_ENGINE=str(TARGET / "debug/desklink-host"))
    test = start(["cargo", "test", "--manifest-path", str(ENGINE / "Cargo.toml"),
                  "point_wayland_private_flow", "--", "--ignored", "--nocapture"], "session-point.log")
    baseline = other = shown = None
    for stage in ["before", "after", "invalid", "expired", "replaced", "cleared", "clickthrough", "closed"]:
        wait_until(lambda: (EVIDENCE / f"{stage}.ready").exists() or test.poll() is not None)
        assert test.poll() is None, (EVIDENCE / "session-point.log").read_text()
        time.sleep(0.15)  # compositor presentation, not just submission
        image = capture(stage)
        current_other = capture(stage + "-other", "HEADLESS-1")
        assert focus(ipc("-t", "get_tree")) == baseline_focus, "cue changed keyboard focus"
        if stage == "before":
            baseline, other = image, current_other
            # This part of the fixture is blank except for the configured cursor.
            cursor_region = baseline.crop((40, 40, 120, 120))
            assert len(cursor_region.getcolors(6400) or []) > 1, "pointer proof needs a visible cursor"
        else:
            assert equal(other, current_other), "cue/pointer appeared on the wrong output"
            # Pointer sits at (70,80) on this output. Its captured pixels never change.
            assert equal(baseline.crop((40, 40, 120, 120)), image.crop((40, 40, 120, 120))), "pointer moved"
        if stage == "after":
            assert image.getpixel((400, 300)) == (76, 158, 208), "center misplaced"
            assert image.getpixel((418, 300)) == (76, 158, 208), "ring misplaced"
            assert not equal(baseline.crop((430, 286, 480, 314)), image.crop((430, 286, 480, 314))), "label missing"
            shown = image
        elif stage == "invalid":
            assert equal(shown, image), "invalid request changed cue"
        elif stage in ["expired", "cleared", "closed"]:
            assert equal(baseline, image), f"cue/pointer survived {stage}"
        elif stage == "replaced":
            assert image.getpixel((700, 500)) == (76, 158, 208)
            assert image.getpixel((400, 300)) == baseline.getpixel((400, 300))
        if stage == "clickthrough":
            pointer_move(pointer, 1680, 300)
            time.sleep(0.1)
            request(pointer, 5, 2, struct.pack("=III", 2, 0x110, 1))
            request(pointer, 5, 4)
            request(pointer, 5, 2, struct.pack("=III", 3, 0x110, 0))
            request(pointer, 5, 4)
            wait_until(lambda: (EVIDENCE / "click.bin").stat().st_size > 0)
            assert b"\x1b[<0;" in (EVIDENCE / "click.bin").read_bytes(), "cue swallowed pointer click"
            pointer_move(pointer, 1350, 80)
        (EVIDENCE / f"{stage}.continue").touch()
    assert test.wait(timeout=10) == 0, (EVIDENCE / "session-point.log").read_text()
    print("PASS: selected output, ring + label, pointer/focus unchanged, invalid preservation, timeout, replacement, clear, click-through, close/reap, missing-layer-shell refusal")
finally:
    if pointer: pointer.close()
    if unavailable: unavailable.close()
    for child in reversed(children):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
    for log in logs:
        log.close()
