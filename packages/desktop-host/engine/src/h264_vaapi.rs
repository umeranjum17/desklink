//! H.264 through VA-API, the Linux encode interface of Intel and AMD GPUs,
//! wrapping the slice encoder through the C shim in `native/vaapi_shim.c`.
//!
//! libva is loaded at runtime, so a machine without it (or without a GPU that
//! encodes H.264) still starts the engine and this backend just declines. The
//! first DRM render node whose driver has a Constrained Baseline encoder wins —
//! a machine may also carry a GPU whose VA driver only decodes — and
//! `DESKLINK_VAAPI_DEVICE` names one node to use instead.

use crate::convert::I420;
use crate::encoder::EncodedFrame;
use crate::h264::REFINE_MAX_QP;
use anyhow::Result;
use std::ffi::CString;
use std::os::raw::{c_char, c_int};

#[repr(C)]
struct NativeEncoder {
    _private: [u8; 0],
}

extern "C" {
    fn dl_vaapi_create(
        device: *const c_char,
        width: c_int,
        height: c_int,
        bitrate_kbps: c_int,
        fps: c_int,
        error: *mut c_char,
        error_size: usize,
    ) -> *mut NativeEncoder;
    fn dl_vaapi_encode(
        encoder: *mut NativeEncoder,
        i420: *const u8,
        force_keyframe: c_int,
        max_qp: c_int,
    ) -> c_int;
    fn dl_vaapi_set_bitrate(encoder: *mut NativeEncoder, bitrate_kbps: c_int);
    fn dl_vaapi_motion_max_qp() -> c_int;
    fn dl_vaapi_packet_data(encoder: *const NativeEncoder) -> *const u8;
    fn dl_vaapi_packet_size(encoder: *const NativeEncoder) -> usize;
    fn dl_vaapi_packet_is_key(encoder: *const NativeEncoder) -> c_int;
    fn dl_vaapi_destroy(encoder: *mut NativeEncoder);
}

pub struct Encoder {
    native: *mut NativeEncoder,
    width: usize,
    height: usize,
}

// Moved to the pipeline thread and only used there; a VA display has no
// thread affinity, only a ban on concurrent calls into one context.
unsafe impl Send for Encoder {}

/// The render nodes to try, in order.
fn devices() -> Vec<String> {
    if let Some(device) = std::env::var_os("DESKLINK_VAAPI_DEVICE").filter(|d| !d.is_empty()) {
        return vec![device.to_string_lossy().into_owned()];
    }
    let mut nodes: Vec<String> = std::fs::read_dir("/dev/dri")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("renderD"))
        // NVIDIA's VA driver only decodes, and loading it brings up CUDA,
        // which was seen to deadlock against an NVENC session opening in
        // another thread; NVENC is the encoder for that GPU.
        .filter(|entry| {
            let driver = std::path::Path::new("/sys/class/drm")
                .join(entry.file_name())
                .join("device/driver");
            std::fs::read_link(driver)
                .map_or(true, |driver| !driver.ends_with("nvidia"))
        })
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect();
    nodes.sort();
    nodes
}

impl Encoder {
    pub fn open(width: usize, height: usize, bitrate_kbps: u32, fps: u32) -> Result<Self> {
        let mut refusals = Vec::new();
        for device in devices() {
            let Ok(path) = CString::new(device.as_str()) else {
                continue;
            };
            let mut error = [0 as c_char; 256];
            let native = unsafe {
                dl_vaapi_create(
                    path.as_ptr(),
                    width as c_int,
                    height as c_int,
                    bitrate_kbps.max(1) as c_int,
                    fps.max(1) as c_int,
                    error.as_mut_ptr(),
                    error.len(),
                )
            };
            if !native.is_null() {
                return Ok(Self {
                    native,
                    width,
                    height,
                });
            }
            let reason = unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) };
            refusals.push(reason.to_string_lossy().into_owned());
        }
        if refusals.is_empty() {
            anyhow::bail!("no DRM render node");
        }
        anyhow::bail!("{}", refusals.join("; "))
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
            unsafe { dl_vaapi_encode(self.native, frame.data.as_ptr(), keyframe as c_int, max_qp) };
        if status != 1 {
            anyhow::bail!("VA-API rejected a {}x{} frame", self.width, self.height);
        }
        let data = unsafe {
            std::slice::from_raw_parts(
                dl_vaapi_packet_data(self.native),
                dl_vaapi_packet_size(self.native),
            )
        }
        .to_vec();
        Ok(EncodedFrame {
            data,
            keyframe: unsafe { dl_vaapi_packet_is_key(self.native) } != 0,
        })
    }
}

impl crate::h264::Backend for Encoder {
    fn encode(&mut self, frame: &I420, keyframe: bool) -> Result<EncodedFrame> {
        self.code(frame, keyframe, unsafe { dl_vaapi_motion_max_qp() })
    }

    /// The ceiling rides in this frame's rate-control parameters; the next
    /// frame carries the motion ceiling again.
    fn refine(&mut self, frame: &I420) -> Result<EncodedFrame> {
        self.code(frame, false, REFINE_MAX_QP as c_int)
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<()> {
        unsafe { dl_vaapi_set_bitrate(self.native, bitrate_kbps.max(1) as c_int) };
        Ok(())
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { dl_vaapi_destroy(self.native) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::h264::Backend;

    /// A diagonal gradient shifted by `t`, so successive frames differ.
    fn pattern(width: usize, height: usize, t: usize) -> I420 {
        let mut data = vec![128u8; width * height * 3 / 2];
        for y in 0..height {
            for x in 0..width {
                data[y * width + x] = ((x + y + 4 * t) & 0xff) as u8;
            }
        }
        I420 {
            width,
            height,
            data,
        }
    }

    /// NAL unit types in Annex-B order.
    fn nal_types(data: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut i = 0;
        while i + 3 < data.len() {
            if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
                types.push(data[i + 3] & 0x1f);
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
                eprintln!("skipping: VA-API H.264 unavailable: {error:#}");
                None
            }
        }
    }

    fn slices(types: &[u8]) -> Vec<u8> {
        types
            .iter()
            .copied()
            .filter(|t| !matches!(t, 6 | 9))
            .collect()
    }

    #[test]
    fn codes_idr_then_p_frames_and_refines() {
        let (w, h) = (640, 480);
        let Some(mut encoder) = open(w, h) else {
            return;
        };
        let first = encoder.encode(&pattern(w, h, 0), false).unwrap();
        assert!(first.keyframe);
        assert!(first.data.starts_with(&[0, 0, 0, 1]));
        assert_eq!(slices(&nal_types(&first.data))[..3], [7, 8, 5]);
        let next = encoder.encode(&pattern(w, h, 1), false).unwrap();
        assert!(!next.keyframe);
        assert_eq!(slices(&nal_types(&next.data)), [1]);
        let forced = encoder.encode(&pattern(w, h, 2), true).unwrap();
        assert!(forced.keyframe);
        assert_eq!(slices(&nal_types(&forced.data))[..3], [7, 8, 5]);
        let motion = encoder.encode(&pattern(w, h, 3), false).unwrap();
        let refined = encoder.refine(&pattern(w, h, 3)).unwrap();
        assert!(!refined.keyframe);
        assert_eq!(slices(&nal_types(&refined.data)), [1]);
        eprintln!(
            "motion frame {} bytes, refinement {} bytes",
            motion.data.len(),
            refined.data.len()
        );
        encoder.set_bitrate(1000).unwrap();
        let slower = encoder.encode(&pattern(w, h, 4), false).unwrap();
        assert!(!slower.keyframe);
        assert_eq!(slices(&nal_types(&slower.data)), [1]);
        assert!(encoder.encode(&pattern(320, 240, 5), false).is_err());
    }

    #[test]
    fn codes_sizes_off_the_macroblock_grid() {
        for (w, h) in [(1366, 768), (1918, 1078)] {
            let Some(mut encoder) = open(w, h) else {
                return;
            };
            assert!(encoder.encode(&pattern(w, h, 0), false).unwrap().keyframe);
            assert!(!encoder.encode(&pattern(w, h, 1), false).unwrap().keyframe);
        }
    }
}
