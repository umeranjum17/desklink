use crate::convert::{to_bgrx, to_i420, PixelFormat, I420};
use crate::portal::PortalSession;
use anyhow::{bail, Result};
use std::ffi::{c_char, c_void, CStr};
use std::sync::Mutex;

pub type FrameSink = Box<dyn Fn(I420, u64, Vec<u8>) + Send + 'static>;

struct State {
    sink: FrameSink,
    sequence: u64,
    width: usize,
    height: usize,
}

pub struct Capture {
    handle: *mut c_void,
    state: *mut Mutex<State>,
}

unsafe impl Send for Capture {}

#[link(name = "dlmacstream", kind = "static")]
unsafe extern "C" {
    fn dl_mac_stream_start(
        display_id: u32,
        width: usize,
        height: usize,
        fps: u32,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const u8, usize, usize, usize, usize),
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    fn dl_mac_stream_stop(handle: *mut c_void) -> bool;
}

extern "C" fn receive_frame(
    context: *mut c_void,
    pixels: *const u8,
    length: usize,
    source_width: usize,
    source_height: usize,
    stride: usize,
) {
    if pixels.is_null()
        || source_width == 0
        || source_height == 0
        || stride
            .checked_mul(source_height)
            .is_none_or(|bytes| bytes > length)
    {
        return;
    }
    let state = unsafe { &*(context as *const Mutex<State>) };
    let Ok(mut state) = state.lock() else { return };
    let source = unsafe { std::slice::from_raw_parts(pixels, length) };
    let raw = to_bgrx(
        source,
        source_width,
        source_height,
        stride,
        PixelFormat::Bgra,
        state.width,
        state.height,
    );
    let frame = to_i420(
        source,
        source_width,
        source_height,
        stride,
        PixelFormat::Bgra,
        state.width,
        state.height,
    );
    if let (Some(frame), Some(raw)) = (frame, raw) {
        (state.sink)(frame, state.sequence, raw);
        state.sequence += 1;
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            if dl_mac_stream_stop(self.handle) {
                drop(Box::from_raw(self.state));
            } // A timed-out stop may still deliver a callback; leak the context instead of a UAF.
        }
    }
}

pub fn start(
    session: PortalSession,
    width: usize,
    height: usize,
    max_fps: u32,
    sink: FrameSink,
) -> Result<Capture> {
    let state = Box::into_raw(Box::new(Mutex::new(State {
        sink,
        sequence: 0,
        width,
        height,
    })));
    let mut error = [0i8; 512];
    let handle = unsafe {
        dl_mac_stream_start(
            session.source.node_id,
            width,
            height,
            max_fps,
            state.cast(),
            receive_frame,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if handle.is_null() {
        unsafe {
            drop(Box::from_raw(state));
        }
        bail!(
            "ScreenCaptureKit stream: {}",
            unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy()
        );
    }
    Ok(Capture { handle, state })
}
