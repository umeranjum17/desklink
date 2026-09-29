//! H.264 through VideoToolbox, the macOS host's hardware encoder, wrapped by
//! the C shim in `native/vt_shim.c`.
//!
//! Low-latency rate control where the machine's encoder offers it for
//! Constrained Baseline, the ordinary real-time mode otherwise; either way no
//! reordering and no lookahead, and the shim flushes each frame before it
//! returns, so one frame in is one access unit out. VideoToolbox is a system
//! framework present on every supported macOS, so it is linked, not loaded.

use crate::convert::I420;
use crate::encoder::EncodedFrame;
use crate::h264::REFINE_MAX_QP;
use anyhow::Result;
use std::os::raw::c_int;

#[repr(C)]
struct NativeEncoder {
    _private: [u8; 0],
}

extern "C" {
    fn dl_vt_create(
        width: c_int,
        height: c_int,
        bitrate_kbps: c_int,
        fps: c_int,
        out: *mut *mut NativeEncoder,
    ) -> i32;
    fn dl_vt_encode(
        encoder: *mut NativeEncoder,
        i420: *const u8,
        force_keyframe: c_int,
        max_qp: c_int,
    ) -> i32;
    fn dl_vt_set_bitrate(encoder: *mut NativeEncoder, bitrate_kbps: c_int) -> i32;
    fn dl_vt_low_latency(encoder: *const NativeEncoder) -> c_int;
    fn dl_vt_out_data(encoder: *const NativeEncoder) -> *const u8;
    fn dl_vt_out_size(encoder: *const NativeEncoder) -> usize;
    fn dl_vt_out_is_key(encoder: *const NativeEncoder) -> c_int;
    fn dl_vt_destroy(encoder: *mut NativeEncoder);
}

/// The shim's report of a frame the rate control skipped on every attempt
/// (`DL_VT_DROPPED`, `DL_VT_ATTEMPTS`).
const DROPPED: i32 = 1;
const ATTEMPTS: u32 = 6;

/// H.264's own quantizer ceiling: no cap outside a refinement pass.
const MOTION_MAX_QP: c_int = 51;

pub struct Encoder {
    native: *mut NativeEncoder,
    width: usize,
    height: usize,
}

// Moved to the pipeline thread and only used there. The output callback runs
// inside the encode call, which waits for it.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn open(width: usize, height: usize, bitrate_kbps: u32, fps: u32) -> Result<Self> {
        let mut native = std::ptr::null_mut();
        let status = unsafe {
            dl_vt_create(
                width as c_int,
                height as c_int,
                bitrate_kbps.max(1) as c_int,
                fps.max(1) as c_int,
                &mut native,
            )
        };
        if status != 0 || native.is_null() {
            anyhow::bail!(
                "VideoToolbox refused an H.264 session for {width}x{height} (OSStatus {status})"
            );
        }
        Ok(Self {
            native,
            width,
            height,
        })
    }

    /// Whether the session runs VideoToolbox's low-latency rate control.
    #[cfg(test)]
    fn low_latency(&self) -> bool {
        unsafe { dl_vt_low_latency(self.native) != 0 }
    }

    fn code(&mut self, frame: &I420, keyframe: bool, max_qp: c_int) -> Result<EncodedFrame> {
        if frame.width != self.width || frame.height != self.height {
            anyhow::bail!(
                "encoder is {}x{} but was given {}x{}",
                self.width,
                self.height,
                frame.width,
                frame.height
            );
        }
        let status =
            unsafe { dl_vt_encode(self.native, frame.data.as_ptr(), keyframe as c_int, max_qp) };
        if status == DROPPED {
            anyhow::bail!("VideoToolbox skipped the same frame {ATTEMPTS} times; the rate is too low for this size");
        }
        if status != 0 {
            anyhow::bail!("VideoToolbox failed to code a frame (OSStatus {status})");
        }
        let size = unsafe { dl_vt_out_size(self.native) };
        let data = unsafe { dl_vt_out_data(self.native) };
        if data.is_null() || size == 0 {
            anyhow::bail!("VideoToolbox produced an empty access unit");
        }
        Ok(EncodedFrame {
            data: unsafe { std::slice::from_raw_parts(data, size) }.to_vec(),
            keyframe: unsafe { dl_vt_out_is_key(self.native) } != 0,
        })
    }
}

impl crate::h264::Backend for Encoder {
    fn encode(&mut self, frame: &I420, keyframe: bool) -> Result<EncodedFrame> {
        self.code(frame, keyframe, MOTION_MAX_QP)
    }

    /// `MaxAllowedFrameQP` lowered for this one frame, then restored. Only
    /// low-latency mode honours it: the ordinary mode accepts the property and
    /// codes at the rate target anyway, so there a refinement is a plain
    /// re-code of the still.
    fn refine(&mut self, frame: &I420) -> Result<EncodedFrame> {
        self.code(frame, false, REFINE_MAX_QP as c_int)
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<()> {
        let status = unsafe { dl_vt_set_bitrate(self.native, bitrate_kbps.max(1) as c_int) };
        if status != 0 {
            anyhow::bail!("VideoToolbox refused a {bitrate_kbps} kbps target (OSStatus {status})");
        }
        Ok(())
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { dl_vt_destroy(self.native) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::h264::Backend;

    /// A box that moves with `t` over a gradient: something to predict from.
    fn pattern(width: usize, height: usize, t: usize) -> I420 {
        let mut data = vec![128u8; width * height * 3 / 2];
        for y in 0..height {
            for x in 0..width {
                let inside = (x + width - (t * 8) % width) % width < width / 4
                    && y > height / 3
                    && y < height * 2 / 3;
                data[y * width + x] = if inside {
                    235
                } else {
                    ((x + y + t * 3) % 200) as u8 + 16
                };
            }
        }
        I420 {
            width,
            height,
            data,
        }
    }

    /// NAL unit types of an Annex-B access unit, in order.
    fn nal_types(au: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut i = 0;
        while i + 3 < au.len() {
            if au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1 {
                types.push(au[i + 3] & 0x1f);
                i += 3;
            } else {
                i += 1;
            }
        }
        types
    }

    fn open(width: usize, height: usize, kbps: u32, fps: u32) -> Option<Encoder> {
        match Encoder::open(width, height, kbps, fps) {
            Ok(encoder) => Some(encoder),
            Err(error) => {
                eprintln!("skipping: {error:#}");
                None
            }
        }
    }

    fn assert_idr(frame: &EncodedFrame) {
        let types = nal_types(&frame.data);
        assert!(frame.keyframe, "{types:?}");
        let sps = types.iter().position(|&t| t == 7).expect("SPS");
        let pps = types.iter().position(|&t| t == 8).expect("PPS");
        let idr = types.iter().position(|&t| t == 5).expect("IDR slice");
        assert!(sps < pps && pps < idr, "{types:?}");
        assert!(frame.data.starts_with(&[0, 0, 0, 1]));
        // Constrained Baseline: profile_idc 66, constraint_set1.
        let at = frame
            .data
            .windows(4)
            .position(|w| w[..3] == [0, 0, 1] && w[3] & 0x1f == 7)
            .unwrap()
            + 4;
        assert_eq!(frame.data[at], 66, "profile_idc");
        assert!(frame.data[at + 1] & 0x40 != 0, "constraint_set1_flag");
    }

    fn assert_inter(frame: &EncodedFrame) {
        let types = nal_types(&frame.data);
        assert!(!frame.keyframe, "{types:?}");
        assert!(types.contains(&1) && !types.contains(&5), "{types:?}");
    }

    #[test]
    fn h264_vt_meets_the_stream_contract() {
        let (w, h) = (640, 360);
        let Some(mut encoder) = open(w, h, 2000, 30) else {
            return;
        };
        eprintln!("low latency rate control: {}", encoder.low_latency());
        assert_idr(&encoder.encode(&pattern(w, h, 0), false).unwrap());
        for t in 1..5 {
            assert_inter(&encoder.encode(&pattern(w, h, t), false).unwrap());
        }
        assert_idr(&encoder.encode(&pattern(w, h, 5), true).unwrap());
        assert_inter(&encoder.encode(&pattern(w, h, 6), false).unwrap());
        let still = encoder.encode(&pattern(w, h, 6), false).unwrap();
        assert_inter(&still);
        let refined = encoder.refine(&pattern(w, h, 6)).unwrap();
        assert_inter(&refined);
        eprintln!(
            "static frame {} bytes, refined {} bytes",
            still.data.len(),
            refined.data.len()
        );
        encoder.set_bitrate(500).unwrap();
        assert_inter(&encoder.encode(&pattern(w, h, 7), false).unwrap());
        assert!(encoder.encode(&pattern(320, 240, 0), false).is_err());
    }

    #[test]
    fn h264_vt_codes_sizes_that_are_not_macroblock_multiples() {
        for (w, h) in [(1366, 768), (1918, 1078)] {
            let Some(mut encoder) = open(w, h, 4000, 30) else {
                return;
            };
            assert_idr(&encoder.encode(&pattern(w, h, 0), false).unwrap());
            assert_inter(&encoder.encode(&pattern(w, h, 1), false).unwrap());
        }
    }

    /// Writes `$DESKLINK_VT_DUMP` (60 frames of motion, an IDR and a refine in
    /// the middle) for an external decoder, and times 1080p and 4K. The rate is
    /// low so motion frames sit above the refinement ceiling.
    #[test]
    #[ignore]
    fn h264_vt_dump_and_time() {
        let Ok(path) = std::env::var("DESKLINK_VT_DUMP") else {
            return;
        };
        let (w, h) = (1366, 768);
        let Some(mut encoder) = open(w, h, 1000, 30) else {
            return;
        };
        let mut out = Vec::new();
        for t in 0..60 {
            let frame = pattern(w, h, t);
            let coded = match t {
                30 => encoder.encode(&frame, true),
                45 => encoder.refine(&pattern(w, h, 44)),
                _ => encoder.encode(&frame, false),
            }
            .unwrap_or_else(|error| panic!("frame {t}: {error:#}"));
            out.extend_from_slice(&coded.data);
        }
        std::fs::write(&path, out).unwrap();
        for (w, h, kbps) in [(1920, 1080, 8000), (3840, 2160, 20000)] {
            let frames: Vec<_> = (0..8).map(|t| pattern(w, h, t)).collect();
            let mut encoder = open(w, h, kbps, 60).unwrap();
            let start = std::time::Instant::now();
            for t in 0..60 {
                encoder.encode(&frames[t % 8], t == 0).unwrap();
            }
            eprintln!("{w}x{h}: {:?} per frame", start.elapsed() / 60);
        }
    }
}
