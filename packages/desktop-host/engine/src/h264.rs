//! H.264 encoding of captured desktops, offered alongside VP9.
//!
//! VP9 stays the default: a receiver that states no preference gets it, as it
//! always has. H.264 exists for receivers whose platform decodes it in
//! hardware and VP9 only in software — an iPhone's WebRTC stack is one — so the
//! engine offers both and codes whichever the receiver's answer puts first.
//!
//! Platform encoders come first: VideoToolbox on macOS, NVENC or VA-API on
//! Linux. Where a Linux machine has neither, the engine loads Cisco's prebuilt
//! openh264 library, fetched at runtime from Cisco and checked against its
//! published hash — never a copy built from source, and never one shipped in
//! this package, because Cisco's patent licence covers only its own binary.
//!
//! Every backend emits the same stream: Constrained Baseline, Annex-B, no
//! B-frames and no lookahead (one frame in, one access unit out), an IDR only
//! when asked for, and the SPS and PPS in front of every IDR so a decoder can
//! start on any of them. Coded size never changes within a session: the VP9
//! path's half-size motion has no H.264 counterpart here, since a size change
//! costs H.264 a new sequence, not just a key frame.

use crate::convert::I420;
use crate::encoder::EncodedFrame;
use anyhow::Result;
use std::sync::Mutex;

/// One H.264 encoder backend. All take I420 at the size they were opened with.
pub trait Backend: Send {
    /// Code `frame`; `keyframe` forces an IDR. The access unit is Annex-B, and
    /// an IDR carries its SPS and PPS in front of the slice.
    fn encode(&mut self, frame: &I420, keyframe: bool) -> Result<EncodedFrame>;
    /// Code `frame` again, unchanged, as an inter frame under
    /// [`REFINE_MAX_QP`]: the detail the motion frames could not afford.
    fn refine(&mut self, frame: &I420) -> Result<EncodedFrame>;
    /// Change the rate target, in kilobits per second, for the frames that follow.
    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<()>;
}

/// The quantizer ceiling of a refinement pass, on H.264's 0–51 scale: small
/// text reads sharp, and the pass happens once per still, not per frame.
pub const REFINE_MAX_QP: u32 = 20;

/// The `profile-level-id` every backend's stream satisfies: Constrained
/// Baseline (`42e0`) at level 5.2, the bound for a 4K desktop at 60 fps. A
/// receiver matches on the profile; the level is an upper bound, and the
/// offer's `level-asymmetry-allowed=1` lets each side keep its own.
pub const PROFILE_LEVEL_ID: &str = "42e034";

/// Which encoder a session would get.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    /// `videotoolbox`, `nvenc`, `vaapi` or `openh264`.
    pub encoder: &'static str,
    pub hardware: bool,
}

type Opener = fn(usize, usize, u32, u32) -> Result<Box<dyn Backend>>;

/// Level 5.2's frame size limit, in 16x16 macroblocks: the most the offer's
/// `PROFILE_LEVEL_ID` promises, and more than a 4096x2160 desktop needs.
const MAX_MACROBLOCKS: usize = 36_864;

/// `DESKLINK_H264_ENCODER`: one backend to use alone, `off` for none.
fn only() -> Option<String> {
    std::env::var("DESKLINK_H264_ENCODER")
        .ok()
        .filter(|only| !only.is_empty())
}

/// The backends this build has, best first.
fn candidates() -> Vec<(Info, Opener)> {
    let mut all: Vec<(Info, Opener)> = Vec::new();
    #[cfg(target_os = "macos")]
    all.push((
        Info {
            encoder: "videotoolbox",
            hardware: true,
        },
        |w, h, kbps, fps| Ok(Box::new(crate::h264_vt::Encoder::open(w, h, kbps, fps)?)),
    ));
    #[cfg(target_os = "linux")]
    {
        all.push((
            Info {
                encoder: "nvenc",
                hardware: true,
            },
            |w, h, kbps, fps| Ok(Box::new(crate::h264_nvenc::Encoder::open(w, h, kbps, fps)?)),
        ));
        all.push((
            Info {
                encoder: "vaapi",
                hardware: true,
            },
            |w, h, kbps, fps| Ok(Box::new(crate::h264_vaapi::Encoder::open(w, h, kbps, fps)?)),
        ));
        all.push((
            Info {
                encoder: "openh264",
                hardware: false,
            },
            |w, h, kbps, fps| {
                Ok(Box::new(crate::h264_openh264::Encoder::open(
                    w, h, kbps, fps,
                )?))
            },
        ));
    }
    if let Some(only) = only() {
        all.retain(|(info, _)| info.encoder == only);
    }
    all
}

/// Whether H.264 is offered for a surface this size. Some encoders open at
/// sizes they then refuse to code, so a session is refused H.264 at its offer
/// rather than ended by its first frame.
pub fn fits(width: usize, height: usize) -> bool {
    width >= 16 && height >= 16 && width.div_ceil(16) * height.div_ceil(16) <= MAX_MACROBLOCKS
}

/// Open the best backend that starts for this size.
pub fn open(
    width: usize,
    height: usize,
    bitrate_kbps: u32,
    fps: u32,
) -> Result<(Box<dyn Backend>, Info)> {
    if !fits(width, height) {
        anyhow::bail!("H.264 is not offered for a {width}x{height} surface");
    }
    // One backend opens at a time: driver libraries initialize on first use,
    // and two GPU stacks coming up together in one process is where drivers
    // have been seen to deadlock.
    static OPENING: Mutex<()> = Mutex::new(());
    let _opening = OPENING.lock().unwrap_or_else(|p| p.into_inner());
    let mut refusals = Vec::new();
    for (info, open) in candidates() {
        match open(width, height, bitrate_kbps.max(1), fps.max(1)) {
            Ok(backend) => return Ok((backend, info)),
            Err(error) => refusals.push(format!("{}: {error:#}", info.encoder)),
        }
    }
    anyhow::bail!(
        "no H.264 encoder starts for {width}x{height} ({})",
        if refusals.is_empty() {
            String::from("none enabled")
        } else {
            refusals.join("; ")
        }
    )
}

/// What the last probe found; `None` until one has run.
static PROBED: Mutex<Option<Option<Info>>> = Mutex::new(None);

/// The backend a session would get, found by starting a small encoder and
/// coding one frame with it — a driver that lists H.264 but cannot open a
/// session is common enough that listing is no evidence. Cached: opening a
/// hardware session is not free. Never fetches anything.
pub fn probe() -> Option<Info> {
    let mut probed = PROBED.lock().unwrap_or_else(|p| p.into_inner());
    *probed.get_or_insert_with(|| {
        let (width, height) = (320, 240);
        let blank = I420 {
            width,
            height,
            data: vec![128u8; width * height * 3 / 2],
        };
        let (mut backend, info) = open(width, height, 500, 30).ok()?;
        backend.encode(&blank, true).ok()?;
        Some(info)
    })
}

/// The backend for a session about to be offered: [`probe`], and on Linux,
/// when no encoder is present, fetch Cisco's openh264 once and probe again.
/// Blocks for the fetch; call it off the async runtime.
pub fn prepare() -> Option<Info> {
    if let Some(info) = probe() {
        return Some(info);
    }
    #[cfg(target_os = "linux")]
    if only().is_none_or(|only| only == "openh264") && crate::h264_openh264::fetch_once() {
        *PROBED.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return probe();
    }
    None
}
