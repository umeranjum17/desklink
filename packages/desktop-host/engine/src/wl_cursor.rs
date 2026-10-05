//! Real cursor positions for hidden Wayland capture, from the compositor's
//! `ext-image-copy-capture-v1` pointer cursor session.
//!
//! The portal stream carries the pixels with the cursor left out; this module
//! asks the compositor directly where that cursor's hotspot is over the same
//! output. Nothing is captured through this connection and nothing is drawn: it
//! holds a seat pointer only because the protocol names the cursor by one.
//!
//! The compositor sends `position` only when the position changed and only
//! while the cursor is over the source, at its own commit cadence. So the last
//! position is latched and stays true until the compositor says otherwise; a
//! quiet compositor is a still cursor, not a missing one.

use crate::cursor::{CursorSink, Reporter};
use anyhow::{bail, Context, Result};
use std::os::fd::AsFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use wayland_client::protocol::{wl_output, wl_pointer, wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, QueueHandle, WEnum};
use wayland_protocols::ext::image_capture_source::v1::client::{
    ext_image_capture_source_v1, ext_output_image_capture_source_manager_v1 as source_manager,
};
use wayland_protocols::ext::image_copy_capture::v1::client::{
    ext_image_copy_capture_cursor_session_v1 as cursor_session,
    ext_image_copy_capture_manager_v1 as capture_manager,
};

pub const PROTOCOL: &str = "ext-image-copy-capture-v1";

/// A live cursor session. Dropping it disconnects and joins its thread.
pub struct Tracker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Tracker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Follow the cursor over the output at `origin` in the desktop layout, whose
/// portal source is `source_size` logical pixels. Waits up to `settle` for the
/// first delivered position: `Ok((tracker, true))` once one arrived, `Ok((tracker,
/// false))` while none has (the cursor may be off this output, or the compositor
/// may be withholding positions), and `Err` when the protocol is not available.
pub fn start(
    origin: (i32, i32),
    source_size: (usize, usize),
    sink: CursorSink,
    settle: Duration,
) -> Result<(Tracker, bool)> {
    let connection = Connection::connect_to_env().context("no Wayland compositor to ask")?;
    let mut queue = connection.new_event_queue();
    let qh = queue.handle();
    connection.display().get_registry(&qh, ());
    let mut state = State {
        reporter: Some(Reporter::new(sink)),
        source_size,
        // Hyprland sends logical coordinates relative to the source's logical
        // box (src/protocols/ImageCopyCapture.cpp, sendCursorEvents); the
        // protocol text, and wlroots, use the transformed buffer's pixels.
        logical: std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some(),
        ..State::default()
    };
    // The globals, then each output's geometry and mode.
    queue.roundtrip(&mut state)?;
    queue.roundtrip(&mut state)?;
    let (Some(_), Some(_), Some(_)) = (&state.capture, &state.sources, &state.seat) else {
        bail!("compositor does not offer {PROTOCOL} output cursor sessions");
    };
    let output = match state.outputs.as_slice() {
        [only] => only,
        many => many
            .iter()
            .find(|o| o.position == origin)
            .context("no Wayland output sits at the captured source's origin")?,
    };
    state.output = Some(output.output.clone());
    state.buffer_size = match output.transform {
        wl_output::Transform::_90
        | wl_output::Transform::_270
        | wl_output::Transform::Flipped90
        | wl_output::Transform::Flipped270 => (output.mode.1, output.mode.0),
        _ => output.mode,
    };
    let (first_tx, first_rx) = mpsc::channel();
    state.first = Some(first_tx);
    // The seat's capabilities arrive with the outputs; the session opens as
    // soon as there is a pointer, including one that only appears later.
    state.open(&qh);
    queue.roundtrip(&mut state)?;

    let stop = Arc::new(AtomicBool::new(false));
    if state.session.is_none() {
        log::warn!(
            "{PROTOCOL}: the seat has no pointer yet; cursor positions start when it has one"
        );
    }
    let thread = {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("desklink-wl-cursor".into())
            .spawn(move || {
                if let Err(error) = run(&connection, &mut queue, &mut state, &stop) {
                    log::warn!("{PROTOCOL}: cursor session ended: {error:#}");
                }
            })
            .context("failed to spawn cursor thread")?
    };
    let observed = first_rx.recv_timeout(settle).is_ok();
    Ok((
        Tracker {
            stop,
            thread: Some(thread),
        },
        observed,
    ))
}

fn run(
    connection: &Connection,
    queue: &mut wayland_client::EventQueue<State>,
    state: &mut State,
    stop: &AtomicBool,
) -> Result<()> {
    let mut warned = false;
    while !stop.load(Ordering::Relaxed) {
        queue.dispatch_pending(state)?;
        connection.flush()?;
        if let Some(guard) = queue.prepare_read() {
            let mut fds = [libc::pollfd {
                fd: std::os::fd::AsRawFd::as_raw_fd(&guard.connection_fd().as_fd()),
                events: libc::POLLIN,
                revents: 0,
            }];
            // SAFETY: one valid pollfd for the connection's own socket.
            if unsafe { libc::poll(fds.as_mut_ptr(), 1, 100) } > 0 {
                guard.read()?;
            }
        }
        // Hyprland, for one, answers enter and hotspot but withholds position
        // from a client its permission rules do not allow.
        if !warned
            && state.position.is_none()
            && state
                .entered_at
                .is_some_and(|at| at.elapsed() > Duration::from_secs(3))
        {
            warned = true;
            log::warn!("{PROTOCOL}: the cursor is over the source but the compositor sends no position; check its cursor permission for this engine");
        }
    }
    Ok(())
}

struct Output {
    output: wl_output::WlOutput,
    position: (i32, i32),
    mode: (usize, usize),
    transform: wl_output::Transform,
}

#[derive(Default)]
struct State {
    reporter: Option<Reporter>,
    capture: Option<capture_manager::ExtImageCopyCaptureManagerV1>,
    sources: Option<source_manager::ExtOutputImageCaptureSourceManagerV1>,
    seat: Option<wl_seat::WlSeat>,
    pointer: Option<wl_pointer::WlPointer>,
    outputs: Vec<Output>,
    output: Option<wl_output::WlOutput>,
    session: Option<cursor_session::ExtImageCopyCaptureCursorSessionV1>,
    source_size: (usize, usize),
    buffer_size: (usize, usize),
    logical: bool,
    entered: bool,
    entered_at: Option<Instant>,
    /// Last delivered hotspot position, already in source coordinates.
    position: Option<(i32, i32)>,
    first: Option<mpsc::Sender<()>>,
}

impl State {
    fn open(&mut self, qh: &QueueHandle<Self>) {
        let (Some(capture), Some(sources), Some(output), Some(pointer)) =
            (&self.capture, &self.sources, &self.output, &self.pointer)
        else {
            return;
        };
        if self.session.is_some() {
            return;
        }
        let source = sources.create_source(output, qh, ());
        self.session = Some(capture.create_pointer_cursor_session(&source, pointer, qh, ()));
    }

    fn map(&self, x: i32, y: i32) -> (i32, i32) {
        if self.logical {
            return (x, y);
        }
        let scale = |v: i32, to: usize, from: usize| {
            (i64::from(v) * to as i64).div_euclid(from.max(1) as i64) as i32
        };
        (
            scale(x, self.source_size.0, self.buffer_size.0),
            scale(y, self.source_size.1, self.buffer_size.1),
        )
    }

    fn report(&mut self) {
        if let (Some((x, y)), Some(reporter)) = (self.position, self.reporter.as_mut()) {
            reporter.update(x, y, self.entered);
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        else {
            return;
        };
        match interface.as_str() {
            "ext_image_copy_capture_manager_v1" => {
                state.capture = Some(registry.bind(name, 1, qh, ()));
            }
            "ext_output_image_capture_source_manager_v1" => {
                state.sources = Some(registry.bind(name, 1, qh, ()));
            }
            "wl_seat" if state.seat.is_none() => {
                state.seat = Some(registry.bind(name, version.min(7), qh, ()));
            }
            "wl_output" => {
                let output = registry.bind(name, version.min(4), qh, ());
                state.outputs.push(Output {
                    output,
                    position: (0, 0),
                    mode: (0, 0),
                    transform: wl_output::Transform::Normal,
                });
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        proxy: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.outputs.iter_mut().find(|o| &o.output == proxy) else {
            return;
        };
        match event {
            wl_output::Event::Geometry {
                x, y, transform, ..
            } => {
                output.position = (x, y);
                if let WEnum::Value(transform) = transform {
                    output.transform = transform;
                }
            }
            wl_output::Event::Mode {
                flags: WEnum::Value(flags),
                width,
                height,
                ..
            } if flags.contains(wl_output::Mode::Current) => {
                output.mode = (width.max(0) as usize, height.max(0) as usize);
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for State {
    fn event(
        state: &mut Self,
        seat: &wl_seat::WlSeat,
        event: wl_seat::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(capabilities),
        } = event
        {
            if capabilities.contains(wl_seat::Capability::Pointer) && state.pointer.is_none() {
                state.pointer = Some(seat.get_pointer(qh, ()));
                state.open(qh);
            }
        }
    }
}

impl Dispatch<cursor_session::ExtImageCopyCaptureCursorSessionV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &cursor_session::ExtImageCopyCaptureCursorSessionV1,
        event: cursor_session::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            cursor_session::Event::Enter => {
                state.entered = true;
                state.entered_at.get_or_insert_with(Instant::now);
                state.report();
            }
            // Off the source: the last position stands, now not visible.
            cursor_session::Event::Leave => {
                state.entered = false;
                state.report();
            }
            cursor_session::Event::Position { x, y } => {
                state.position = Some(state.map(x, y));
                state.report();
                if let Some(first) = state.first.take() {
                    let _ = first.send(());
                }
            }
            cursor_session::Event::Hotspot { x, y } => {
                let hotspot = state.map(x, y);
                if let Some(reporter) = state.reporter.as_mut() {
                    reporter.hotspot = Some(hotspot);
                }
                state.report();
            }
            _ => {}
        }
    }
}

wayland_client::delegate_noop!(State: ignore wl_pointer::WlPointer);
wayland_client::delegate_noop!(State: capture_manager::ExtImageCopyCaptureManagerV1);
wayland_client::delegate_noop!(State: source_manager::ExtOutputImageCaptureSourceManagerV1);
wayland_client::delegate_noop!(State: ext_image_capture_source_v1::ExtImageCaptureSourceV1);
