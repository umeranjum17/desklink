//! A latency stamp for a Wayland compositor this process owns.
//!
//! It asks for a fullscreen toplevel and repaints on its own clock (120 Hz by
//! default), never waiting for the compositor's frame callback. Each repaint
//! writes the wall clock in milliseconds (low 24 bits of `CLOCK_REALTIME`) as 24
//! black-or-white 48 px blocks along the top-left edge. A receiver that decodes
//! those blocks from a presented frame knows how old that frame's picture is.
//!
//! `--mode typing` changes only the stamp strip; `--mode scroll` also redraws a
//! full-screen field of shifted stripes on every repaint, a worst case like
//! dense scrolling text; `--mode still` freezes the stamp after two seconds, so
//! a receiver can check that a still screen gets its sharp refine pass.
//!
//! ```sh
//! WAYLAND_DISPLAY=wayland-1 cargo run --example wl_stamp_target -- --mode scroll
//! ```

use anyhow::{bail, Context, Result};
use std::fs::File;
use std::os::fd::AsFd;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wayland_client::protocol::{
    wl_buffer, wl_compositor, wl_output, wl_registry, wl_shm, wl_shm_pool, wl_surface,
};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

const BLOCK: usize = 48;
const BITS: usize = 24;
const WHITE: u32 = 0x00ff_ffff;
const BLACK: u32 = 0;
/// Enough buffers that one is nearly always released by the next repaint.
const BUFFERS: usize = 4;

#[derive(PartialEq)]
enum Mode {
    Typing,
    Scroll,
    Still,
}

#[derive(Default)]
struct State {
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    wm_base: Option<xdg_wm_base::XdgWmBase>,
    /// Size the compositor configured, once acknowledged.
    size: Option<(usize, usize)>,
    pending_size: (usize, usize),
    /// The output's current mode: the size to use when the first configure
    /// leaves it to the client, as a compositor does before a surface maps.
    output_size: (usize, usize),
    busy: [bool; BUFFERS],
    closed: bool,
}

fn main() -> Result<()> {
    let mut mode = Mode::Typing;
    let mut rate = 120u64;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mode" => {
                mode = match args.next().as_deref() {
                    Some("typing") => Mode::Typing,
                    Some("scroll") => Mode::Scroll,
                    Some("still") => Mode::Still,
                    other => bail!("--mode must be typing, scroll or still, not {other:?}"),
                }
            }
            "--rate" => rate = args.next().context("--rate needs a value")?.parse()?,
            other => bail!("unknown argument {other}"),
        }
    }

    let connection =
        Connection::connect_to_env().context("no Wayland compositor in WAYLAND_DISPLAY")?;
    let mut queue = connection.new_event_queue();
    let qh = queue.handle();
    connection.display().get_registry(&qh, ());
    let mut state = State::default();
    // Two round trips: the globals, then the output's mode events.
    queue.roundtrip(&mut state)?;
    queue.roundtrip(&mut state)?;
    let compositor = state.compositor.clone().context("no wl_compositor")?;
    let shm = state.shm.clone().context("no wl_shm")?;
    let wm_base = state.wm_base.clone().context("no xdg_wm_base")?;

    let surface = compositor.create_surface(&qh, ());
    let xdg = wm_base.get_xdg_surface(&surface, &qh, ());
    let toplevel = xdg.get_toplevel(&qh, ());
    toplevel.set_app_id("desklink-stamp".into());
    toplevel.set_fullscreen(None);
    surface.commit();
    while state.size.is_none() {
        queue.blocking_dispatch(&mut state)?;
    }
    let (width, height) = state.size.unwrap();
    if width == 0 || height == 0 {
        bail!("the compositor gave no size and reported no output mode");
    }
    let frame_bytes = width * height * 4;

    let file = memfd(frame_bytes * BUFFERS)?;
    // SAFETY: the file is ours, sized above, and only this process writes it.
    let map = unsafe { memmap(&file, frame_bytes * BUFFERS)? };
    let pool = shm.create_pool(file.as_fd(), (frame_bytes * BUFFERS) as i32, &qh, ());
    let buffers: Vec<_> = (0..BUFFERS)
        .map(|index| {
            pool.create_buffer(
                (index * frame_bytes) as i32,
                width as i32,
                height as i32,
                (width * 4) as i32,
                wl_shm::Format::Xrgb8888,
                &qh,
                index,
            )
        })
        .collect();
    for pixel in map.chunks_exact_mut(4) {
        pixel.copy_from_slice(&WHITE.to_le_bytes());
    }

    println!("{{\"ready\":true,\"width\":{width},\"height\":{height}}}");
    let interval = Duration::from_nanos(1_000_000_000 / rate.max(1));
    let started = Instant::now();
    let mut next = Instant::now();
    let mut frame = 0usize;
    let mut frozen_ms = None;
    let mut frozen_at = 0usize;
    while !state.closed {
        queue.dispatch_pending(&mut state)?;
        connection.flush()?;
        if let Some(guard) = queue.prepare_read() {
            let timeout = next.saturating_duration_since(Instant::now());
            let mut poll = libc::pollfd {
                fd: std::os::fd::AsRawFd::as_raw_fd(&guard.connection_fd()),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd for the duration of the call.
            let ready = unsafe { libc::poll(&mut poll, 1, timeout.as_millis() as i32) };
            if ready > 0 {
                guard.read()?;
            }
        }
        queue.dispatch_pending(&mut state)?;
        if Instant::now() < next {
            continue;
        }
        next += interval;
        if Instant::now() > next {
            next = Instant::now() + interval;
        }
        // A still screen is one that stops committing: once the frozen stamp
        // is shown, the compositor has nothing new to capture.
        if frozen_ms.is_some() && frame > frozen_at {
            continue;
        }
        let Some(index) = (0..BUFFERS).find(|&i| !state.busy[i]) else {
            continue;
        };
        let pixels = &mut map[index * frame_bytes..(index + 1) * frame_bytes];
        let pixels: &mut [u32] = bytemuck(pixels);
        if mode == Mode::Scroll {
            fill(
                pixels,
                width,
                0,
                2 * BLOCK,
                width,
                height - 2 * BLOCK,
                WHITE,
            );
            let mut y = 2 * BLOCK;
            while y + 12 <= height {
                let mut x = (frame * 7 + y) % 37;
                while x < width {
                    fill(pixels, width, x, y, 3 + (x + y) % 11, 12, BLACK);
                    x += 37;
                }
                y += 24;
            }
        }
        let now = now_ms();
        let ms = if mode == Mode::Still && started.elapsed() > Duration::from_secs(2) {
            *frozen_ms.get_or_insert_with(|| {
                frozen_at = frame;
                now
            })
        } else {
            now
        } & 0xff_ffff;
        for bit in 0..BITS {
            let on = (ms >> (BITS - 1 - bit)) & 1 == 1;
            fill(
                pixels,
                width,
                bit * BLOCK,
                0,
                BLOCK,
                BLOCK,
                if on { WHITE } else { BLACK },
            );
        }
        state.busy[index] = true;
        surface.attach(Some(&buffers[index]), 0, 0);
        if mode == Mode::Scroll {
            surface.damage_buffer(0, 0, width as i32, height as i32);
        } else {
            surface.damage_buffer(0, 0, (BITS * BLOCK) as i32, BLOCK as i32);
        }
        surface.commit();
        frame += 1;
    }
    drop(toplevel);
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn fill(pixels: &mut [u32], stride: usize, x: usize, y: usize, w: usize, h: usize, colour: u32) {
    let height = pixels.len() / stride;
    for row in y..(y + h).min(height) {
        let start = row * stride + x.min(stride);
        let end = row * stride + (x + w).min(stride);
        pixels[start..end].fill(colour);
    }
}

fn bytemuck(bytes: &mut [u8]) -> &mut [u32] {
    assert_eq!(bytes.as_ptr() as usize % 4, 0);
    // SAFETY: aligned (checked), and every bit pattern is a valid u32.
    unsafe { std::slice::from_raw_parts_mut(bytes.as_mut_ptr().cast(), bytes.len() / 4) }
}

fn memfd(len: usize) -> Result<File> {
    // SAFETY: a static C string name; the fd is owned by the returned File.
    let fd = unsafe { libc::memfd_create(c"desklink-stamp".as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        bail!("memfd_create failed: {}", std::io::Error::last_os_error());
    }
    // SAFETY: fd was just created and is owned by nothing else.
    let file = unsafe { <File as std::os::fd::FromRawFd>::from_raw_fd(fd) };
    file.set_len(len as u64)?;
    Ok(file)
}

/// # Safety
/// `file` must be at least `len` bytes and must outlive the mapping.
unsafe fn memmap(file: &File, len: usize) -> Result<&'static mut [u8]> {
    let ptr = libc::mmap(
        std::ptr::null_mut(),
        len,
        libc::PROT_READ | libc::PROT_WRITE,
        libc::MAP_SHARED,
        std::os::fd::AsRawFd::as_raw_fd(file),
        0,
    );
    if ptr == libc::MAP_FAILED {
        bail!("mmap failed: {}", std::io::Error::last_os_error());
    }
    Ok(std::slice::from_raw_parts_mut(ptr.cast(), len))
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
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            match interface.as_str() {
                "wl_compositor" => {
                    state.compositor = Some(registry.bind(name, version.min(4), qh, ()))
                }
                "wl_shm" => state.shm = Some(registry.bind(name, 1, qh, ())),
                "xdg_wm_base" => state.wm_base = Some(registry.bind(name, 1, qh, ())),
                "wl_output" => {
                    registry.bind::<wl_output::WlOutput, _, _>(name, 1, qh, ());
                }
                _ => {}
            }
        }
    }
}

impl Dispatch<xdg_wm_base::XdgWmBase, ()> for State {
    fn event(
        _: &mut Self,
        base: &xdg_wm_base::XdgWmBase,
        event: xdg_wm_base::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_wm_base::Event::Ping { serial } = event {
            base.pong(serial);
        }
    }
}

impl Dispatch<xdg_surface::XdgSurface, ()> for State {
    fn event(
        state: &mut Self,
        surface: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            surface.ack_configure(serial);
            // The stamp keeps the first real size; a later reconfigure would
            // need new buffers, which a fixed-size lab output never asks for.
            if state.size.is_none() {
                let (w, h) = state.pending_size;
                state.size = Some(if w > 0 && h > 0 {
                    (w, h)
                } else {
                    state.output_size
                });
            }
        }
    }
}

impl Dispatch<xdg_toplevel::XdgToplevel, ()> for State {
    fn event(
        state: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        event: xdg_toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            xdg_toplevel::Event::Configure { width, height, .. } => {
                state.pending_size = (width.max(0) as usize, height.max(0) as usize)
            }
            xdg_toplevel::Event::Close => state.closed = true,
            _ => {}
        }
    }
}

impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Mode {
            flags,
            width,
            height,
            ..
        } = event
        {
            if flags
                .into_result()
                .is_ok_and(|f| f.contains(wl_output::Mode::Current))
            {
                state.output_size = (width.max(0) as usize, height.max(0) as usize);
            }
        }
    }
}

impl Dispatch<wl_buffer::WlBuffer, usize> for State {
    fn event(
        state: &mut Self,
        _: &wl_buffer::WlBuffer,
        event: wl_buffer::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release = event {
            state.busy[*index] = false;
        }
    }
}

wayland_client::delegate_noop!(State: ignore wl_compositor::WlCompositor);
wayland_client::delegate_noop!(State: ignore wl_surface::WlSurface);
wayland_client::delegate_noop!(State: ignore wl_shm::WlShm);
wayland_client::delegate_noop!(State: ignore wl_shm_pool::WlShmPool);
