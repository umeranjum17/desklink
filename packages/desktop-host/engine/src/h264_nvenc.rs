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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::h264::Backend;

    /// Fine detail, like text, scrolled sideways by `t`.
    fn pattern(width: usize, height: usize, t: usize) -> I420 {
        let mut data = vec![128u8; width * height * 3 / 2];
        for y in 0..height {
            for x in 0..width {
                data[y * width + x] = ((x + 4 * t) ^ (3 * y)) as u8;
            }
        }
        I420 {
            width,
            height,
            data,
        }
    }

    fn nal_types(au: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut i = 0;
        while i + 3 < au.len() {
            if au[i..i + 3] == [0, 0, 1] {
                types.push(au[i + 3] & 0x1f);
                i += 3;
            } else {
                i += 1;
            }
        }
        types
    }

    fn open(width: usize, height: usize) -> Option<Encoder> {
        match Encoder::open(width, height, 4000, 30) {
            Ok(encoder) => Some(encoder),
            Err(error) => {
                eprintln!("skipping: NVENC unavailable: {error:#}");
                None
            }
        }
    }

    #[test]
    fn idr_on_request_only_and_refine_is_inter() {
        let (w, h) = (640, 480);
        let Some(mut encoder) = open(w, h) else {
            return;
        };
        let first = encoder.encode(&pattern(w, h, 0), false).unwrap();
        assert!(first.data.starts_with(&[0, 0, 0, 1]), "Annex-B");
        assert_eq!(nal_types(&first.data), [7, 8, 5]);
        assert!(first.keyframe);

        let next = encoder.encode(&pattern(w, h, 1), false).unwrap();
        assert_eq!(nal_types(&next.data), [1]);
        assert!(!next.keyframe);

        let forced = encoder.encode(&pattern(w, h, 2), true).unwrap();
        assert_eq!(nal_types(&forced.data), [7, 8, 5]);
        assert!(forced.keyframe);

        let still = pattern(w, h, 3);
        let motion = encoder.encode(&still, false).unwrap();
        let refined = encoder.refine(&still).unwrap();
        assert_eq!(nal_types(&refined.data), [1]);
        assert!(!refined.keyframe);
        eprintln!(
            "motion frame {} bytes, refinement {} bytes",
            motion.data.len(),
            refined.data.len()
        );

        encoder.set_bitrate(1500).unwrap();
        let after = encoder.encode(&pattern(w, h, 4), false).unwrap();
        assert_eq!(nal_types(&after.data), [1]);
        assert!(!after.keyframe);

        assert!(encoder.encode(&pattern(320, 240, 0), false).is_err());
    }

    #[test]
    fn the_refinement_ceiling_is_lifted_for_the_motion_after_it() {
        let (w, h) = (640, 480);
        let Ok(mut encoder) = Encoder::open(w, h, 300, 30) else {
            return;
        };
        // Fresh detail every frame, which no reference predicts: the rate
        // control, not motion search, decides these sizes.
        let noise = |t: usize| {
            let mut frame = pattern(w, h, 0);
            for (i, pixel) in frame.data[..w * h].iter_mut().enumerate() {
                *pixel = ((i ^ t).wrapping_mul(2_654_435_761) >> 13) as u8;
            }
            frame
        };
        let coded = |encoder: &mut Encoder, from: usize| -> usize {
            (from..from + 10)
                .map(|t| encoder.encode(&noise(t), false).unwrap().data.len())
                .sum()
        };
        coded(&mut encoder, 0);
        let before = coded(&mut encoder, 10);
        encoder.refine(&noise(19)).unwrap();
        let after = coded(&mut encoder, 20);
        assert!(
            after < before * 2,
            "motion after a refinement is back under the rate target: {before} then {after} bytes"
        );
    }

    #[test]
    fn sizes_off_the_macroblock_grid_open_and_code() {
        for (w, h) in [(1366, 768), (1918, 1078)] {
            let Some(mut encoder) = open(w, h) else {
                return;
            };
            assert!(encoder.encode(&pattern(w, h, 0), false).unwrap().keyframe);
            assert!(!encoder.encode(&pattern(w, h, 1), false).unwrap().keyframe);
        }
    }

    /// Not a check: writes `$DESKLINK_NVENC_DUMP` (60 frames at 1282x722, an
    /// IDR at 30 and a refinement at 45) for an external decoder, and prints
    /// the mean encode time at 1080p and 4K.
    #[test]
    #[ignore]
    fn dump_and_time() {
        use std::time::Instant;
        if let Ok(path) = std::env::var("DESKLINK_NVENC_DUMP") {
            let (w, h) = (1282, 722);
            let Some(mut encoder) = Encoder::open(w, h, 1500, 30).ok() else {
                return;
            };
            let mut out = Vec::new();
            for t in 0..60 {
                let frame = pattern(w, h, t.min(44));
                let coded = match t {
                    45 => encoder.refine(&frame),
                    _ => encoder.encode(&frame, t == 30),
                }
                .unwrap();
                if (44..=46).contains(&t) {
                    eprintln!("frame {t}: {} bytes", coded.data.len());
                }
                out.extend_from_slice(&coded.data);
            }
            std::fs::write(path, out).unwrap();
        }
        for (w, h) in [(1920, 1080), (3840, 2160)] {
            let Some(mut encoder) = Encoder::open(w, h, 20_000, 60).ok() else {
                return;
            };
            let frames: Vec<_> = (0..4).map(|t| pattern(w, h, t)).collect();
            encoder.encode(&frames[0], true).unwrap();
            let start = Instant::now();
            for t in 0..60 {
                encoder.encode(&frames[t % 4], false).unwrap();
            }
            eprintln!("{w}x{h}: {:?} per frame", start.elapsed() / 60);
        }
    }
}
