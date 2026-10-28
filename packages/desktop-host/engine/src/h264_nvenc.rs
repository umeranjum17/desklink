//! H.264 on NVIDIA GPUs through NVENC, wrapped by the C shim in
//! `native/nvenc_shim.c`.
//!
//! The driver's libraries are opened at runtime, so the engine starts the same
//! on a machine without an NVIDIA GPU; there [`Encoder::open`] just fails with
//! the reason. Synchronous, P frames only, ultra-low-latency tuning: the access
//! unit is complete when `encode` returns.

use crate::convert::I420;
use crate::encoder::EncodedFrame;
use crate::h264::REFINE_MAX_QP;
use anyhow::Result;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int};

#[repr(C)]
struct NativeEncoder {
    _private: [u8; 0],
}

extern "C" {
    fn dl_nvenc_create(
        width: c_int,
        height: c_int,
        bitrate_kbps: c_int,
        fps: c_int,
        error: *mut c_char,
        error_len: usize,
    ) -> *mut NativeEncoder;
    fn dl_nvenc_encode(encoder: *mut NativeEncoder, i420: *const u8, force_idr: c_int) -> c_int;
    fn dl_nvenc_reconfigure(
        encoder: *mut NativeEncoder,
        bitrate_kbps: c_int,
        max_qp: c_int,
    ) -> c_int;
    fn dl_nvenc_packet_data(encoder: *const NativeEncoder) -> *const u8;
    fn dl_nvenc_packet_size(encoder: *const NativeEncoder) -> usize;
    fn dl_nvenc_packet_is_key(encoder: *const NativeEncoder) -> c_int;
    fn dl_nvenc_error(encoder: *const NativeEncoder) -> *const c_char;
    fn dl_nvenc_destroy(encoder: *mut NativeEncoder);
}

pub struct Encoder {
    native: *mut NativeEncoder,
    width: usize,
    height: usize,
    bitrate_kbps: u32,
}

// Moved to the pipeline thread and only used there; the shim makes its CUDA
// context current around each call rather than binding it to a thread.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn open(width: usize, height: usize, bitrate_kbps: u32, fps: u32) -> Result<Self> {
        let mut error = [0 as c_char; 256];
        let native = unsafe {
            dl_nvenc_create(
                width as c_int,
                height as c_int,
                bitrate_kbps.max(1) as c_int,
                fps.max(1) as c_int,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if native.is_null() {
            let reason = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
            anyhow::bail!("{reason}");
        }
        Ok(Self {
            native,
            width,
            height,
            bitrate_kbps: bitrate_kbps.max(1),
        })
    }

    fn failure(&self, what: &str) -> anyhow::Error {
        let reason = unsafe { CStr::from_ptr(dl_nvenc_error(self.native)) }.to_string_lossy();
        anyhow::anyhow!("NVENC {what}: {reason}")
    }
}

impl crate::h264::Backend for Encoder {
    fn encode(&mut self, frame: &I420, keyframe: bool) -> Result<EncodedFrame> {
        if frame.width != self.width || frame.height != self.height {
            anyhow::bail!(
                "encoder is {}x{} but was given {}x{}",
                self.width,
                self.height,
                frame.width,
                frame.height
            );
        }
        if frame.data.len() < self.width * self.height * 3 / 2 {
            anyhow::bail!("an I420 frame of {} bytes is short", frame.data.len());
        }
        if unsafe { dl_nvenc_encode(self.native, frame.data.as_ptr(), keyframe as c_int) } != 1 {
            return Err(self.failure("could not code a frame"));
        }
        let (data, size) = unsafe {
            (
                dl_nvenc_packet_data(self.native),
                dl_nvenc_packet_size(self.native),
            )
        };
        Ok(EncodedFrame {
            data: unsafe { std::slice::from_raw_parts(data, size) }.to_vec(),
            keyframe: unsafe { dl_nvenc_packet_is_key(self.native) } != 0,
        })
    }

    /// NVENC caps the quantizer through its rate-control config, which it
    /// changes in place between frames without an IDR: the ceiling goes down
    /// for this one frame and comes back off after it.
    fn refine(&mut self, frame: &I420) -> Result<EncodedFrame> {
        let bitrate = self.bitrate_kbps as c_int;
        if unsafe { dl_nvenc_reconfigure(self.native, bitrate, REFINE_MAX_QP as c_int) } != 0 {
            return Err(self.failure("refused the refinement ceiling"));
        }
        let coded = self.encode(frame, false);
        if unsafe { dl_nvenc_reconfigure(self.native, bitrate, 0) } != 0 {
            return Err(self.failure("refused to lift the refinement ceiling"));
        }
        coded
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<()> {
        let bitrate_kbps = bitrate_kbps.max(1);
        if unsafe { dl_nvenc_reconfigure(self.native, bitrate_kbps as c_int, 0) } != 0 {
            return Err(self.failure(&format!("refused a {bitrate_kbps} kbps target")));
        }
        self.bitrate_kbps = bitrate_kbps;
        Ok(())
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { dl_nvenc_destroy(self.native) };
    }
}
