//! H.264 through Cisco's prebuilt openh264 library, the software fallback for
//! a Linux machine with no hardware encoder.
//!
//! Cisco's patent licence covers only its own binary, downloaded onto the
//! machine that runs it: so the library is never built from source and never
//! shipped here. [`fetch_once`] downloads the pinned release from Cisco into
//! the user's cache, and [`Encoder::open`] loads it with `dlopen` only after
//! its sha256 matches the pin — a distribution's own libopenh264 is a source
//! build and is never looked at.
//!
//! `DESKLINK_OPENH264=off` disables the backend; any other value names the
//! library file to load instead of the cached one (still hash-checked).

use crate::convert::I420;
use crate::encoder::EncodedFrame;
use anyhow::{Context, Result};
use openh264_sys2::{
    videoFormatI420, videoFrameTypeIDR, DynamicAPI, ISVCEncoder, ISVCEncoderVtbl, SBitrateInfo,
    SEncParamExt, SEncoderStatistics, SFrameBSInfo, SSourcePicture, API, CAMERA_VIDEO_REAL_TIME,
    CONSTANT_ID, ENCODER_OPTION_BITRATE, ENCODER_OPTION_GET_STATISTICS, ENCODER_OPTION_RC_MODE,
    ENCODER_OPTION_TRACE_LEVEL, PRO_BASELINE, RC_BITRATE_MODE, RC_MODES, RC_OFF_MODE,
    SM_FIXEDSLCNUM_SLICE, SM_SINGLE_SLICE, SPATIAL_LAYER_ALL, WELS_LOG_QUIET,
};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::raw::{c_int, c_void};
use std::path::PathBuf;
use std::ptr::NonNull;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The Cisco release the bindings were generated against, as (file name,
/// sha256 of the decompressed library). Hashes checked against Cisco's
/// download; the `openh264-sys2` crate lists the same ones.
#[cfg(target_arch = "x86_64")]
const BLOB: Option<(&str, &str)> = Some((
    "libopenh264-2.6.0-linux64.8.so",
    "2f0cde7c6a6abcf5cae76942894ea42897fa677bce4ed6c91a24dd1b041d5f04",
));
#[cfg(target_arch = "aarch64")]
const BLOB: Option<(&str, &str)> = Some((
    "libopenh264-2.6.0-linux-arm64.8.so",
    "12e7b33623667cdab0e575170c147b1b36eadb77d0d2aa7ceb5afd3e58902140",
));
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
const BLOB: Option<(&str, &str)> = None;

/// Plain HTTP: the pinned hash is the integrity check, so TLS would add a large
/// dependency and no assurance. Cisco serves the same files over both.
const HOST: &str = "ciscobinary.openh264.org";

pub struct Encoder {
    native: NonNull<ISVCEncoder>,
    /// Copy of the encoder's vtable, validated at open. Every call goes
    /// through this, so no path dereferences the library's pointers unchecked.
    vtable: ISVCEncoderVtbl,
    width: usize,
    height: usize,
    fps: u32,
    frames: u64,
    /// The last frame was a refinement, coded with rate control off.
    refined: bool,
    bitstream: Box<SFrameBSInfo>,
    /// Keeps the library mapped while `native` lives; dropped after it.
    _api: DynamicAPI,
}

// Moved to the pipeline thread and used only there; openh264 asks nothing more
// of a caller than not entering one encoder concurrently.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn open(width: usize, height: usize, bitrate_kbps: u32, fps: u32) -> Result<Self> {
        let path = library()?;
        let (_, sha256) =
            BLOB.context("Cisco publishes no openh264 build for this architecture")?;
        let bytes = std::fs::read(&path)
            .with_context(|| format!("openh264 is not in place at {}", path.display()))?;
        if hex(&Sha256::digest(&bytes)) != sha256 {
            anyhow::bail!("{} is not Cisco's openh264 2.6.0", path.display());
        }
        drop(bytes);
        let api = DynamicAPI::from_blob_path(&path)
            .map_err(|e| anyhow::anyhow!("cannot load {}: {e}", path.display()))?;

        let mut raw: *mut ISVCEncoder = std::ptr::null_mut();
        if unsafe { api.WelsCreateSVCEncoder(&mut raw) } != 0 {
            anyhow::bail!("openh264 could not create an encoder");
        }
        let native = NonNull::new(raw).context("openh264 returned a null encoder")?;
        // The handle's first word is its vtable pointer; reject a null one
        // here so no later call dereferences an unchecked pointer.
        let vtable = NonNull::new(unsafe { *native.as_ptr() } as *mut ISVCEncoderVtbl)
            .context("openh264 returned an encoder with no vtable")?;
        let vtable = unsafe { *vtable.as_ptr() };
        let mut encoder = Self {
            native,
            vtable,
            width,
            height,
            fps: fps.max(1),
            frames: 0,
            refined: false,
            bitstream: Box::default(),
            _api: api,
        };
        // Before initialising, so its warnings never reach the terminal either.
        let mut quiet = WELS_LOG_QUIET;
        encoder.option(ENCODER_OPTION_TRACE_LEVEL, &mut quiet)?;

        let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(4));
        let mut params = SEncParamExt::default();
        let vt = encoder.vtable();
        let get_defaults = vt
            .GetDefaultParams
            .context("openh264 lacks GetDefaultParams")?;
        let initialize = vt.InitializeExt.context("openh264 lacks InitializeExt")?;
        unsafe { get_defaults(encoder.native.as_ptr(), &mut params) };
        let bps = (bitrate_kbps.max(1) as c_int).saturating_mul(1000);
        // Camera mode, not screen content: the screen mode switches scene
        // change detection back on whatever it is told, and codes an unasked
        // IDR on every large change — every window switch, and every frame of
        // a full-screen scroll. Adaptive quantization is off in both modes.
        params.iUsageType = CAMERA_VIDEO_REAL_TIME;
        params.bEnableSceneChangeDetect = false;
        params.bEnableBackgroundDetection = false;
        params.iPicWidth = width as c_int;
        params.iPicHeight = height as c_int;
        params.iTargetBitrate = bps;
        params.iRCMode = RC_BITRATE_MODE;
        params.fMaxFrameRate = encoder.fps as f32;
        // Every frame must come out: a skipped frame is a frame the far end
        // never gets. The rate is then held by the quantizer alone.
        params.bEnableFrameSkip = false;
        // The whole quantizer range: without frame skipping it is all that
        // holds a low rate. 12 is openh264's own floor.
        params.iMinQp = 12;
        params.iMaxQp = 51;
        params.uiIntraPeriod = 0;
        params.eSpsPpsIdStrategy = CONSTANT_ID;
        params.iEntropyCodingModeFlag = 0;
        params.iTemporalLayerNum = 1;
        params.iSpatialLayerNum = 1;
        params.iMultipleThreadIdc = threads as u16;
        let layer = &mut params.sSpatialLayers[0];
        layer.iVideoWidth = width as c_int;
        layer.iVideoHeight = height as c_int;
        layer.fFrameRate = encoder.fps as f32;
        layer.iSpatialBitrate = bps;
        layer.uiProfileIdc = PRO_BASELINE;
        // The fixed quantizer of the rate-control-off mode `refine` switches to.
        layer.iDLayerQp = crate::h264::REFINE_MAX_QP as c_int;
        // openh264 threads by slice: one slice per thread.
        layer.sSliceArgument.uiSliceMode = if threads > 1 {
            SM_FIXEDSLCNUM_SLICE
        } else {
            SM_SINGLE_SLICE
        };
        layer.sSliceArgument.uiSliceNum = threads as u32;
        if unsafe { initialize(encoder.native.as_ptr(), &params) } != 0 {
            anyhow::bail!("openh264 refused a {width}x{height} encoder at {bitrate_kbps} kbps");
        }
        Ok(encoder)
    }

    fn vtable(&self) -> &ISVCEncoderVtbl {
        &self.vtable
    }

    fn option<T>(&mut self, id: openh264_sys2::ENCODER_OPTION, value: &mut T) -> Result<()> {
        let set = self
            .vtable()
            .SetOption
            .context("openh264 lacks SetOption")?;
        if unsafe { set(self.native.as_ptr(), id, value as *mut T as *mut c_void) } != 0 {
            anyhow::bail!("openh264 refused option {id}");
        }
        Ok(())
    }

    fn rc_mode(&mut self, mut mode: RC_MODES) -> Result<()> {
        self.option(ENCODER_OPTION_RC_MODE, &mut mode)
    }

    /// The average quantizer of the frame coded last.
    fn last_qp(&self) -> Result<u32> {
        let get = self
            .vtable()
            .GetOption
            .context("openh264 lacks GetOption")?;
        let mut stats = SEncoderStatistics::default();
        let status = unsafe {
            get(
                self.native.as_ptr(),
                ENCODER_OPTION_GET_STATISTICS,
                &mut stats as *mut SEncoderStatistics as *mut c_void,
            )
        };
        if status != 0 {
            anyhow::bail!("openh264 refused its statistics");
        }
        Ok(stats.uiAverageFrameQP)
    }
}

impl crate::h264::Backend for Encoder {
    fn encode(&mut self, frame: &I420, keyframe: bool) -> Result<EncodedFrame> {
        self.refined = false;
        if frame.width != self.width || frame.height != self.height {
            anyhow::bail!(
                "encoder is {}x{} but was given {}x{}",
                self.width,
                self.height,
                frame.width,
                frame.height
            );
        }
        let (w, h) = (self.width, self.height);
        let luma = w * h;
        let chroma = (w / 2) * (h / 2);
        if frame.data.len() < luma + 2 * chroma {
            anyhow::bail!("a {w}x{h} frame needs {} bytes", luma + 2 * chroma);
        }
        let vt = self.vtable();
        let encode = vt.EncodeFrame.context("openh264 lacks EncodeFrame")?;
        let force = vt
            .ForceIntraFrame
            .context("openh264 lacks ForceIntraFrame")?;
        if keyframe && unsafe { force(self.native.as_ptr(), true) } != 0 {
            anyhow::bail!("openh264 refused to force an IDR");
        }
        // The encoder only reads the planes; the API is not const-correct.
        let base = frame.data.as_ptr() as *mut u8;
        let source = SSourcePicture {
            iColorFormat: videoFormatI420 as c_int,
            iStride: [w as c_int, (w / 2) as c_int, (w / 2) as c_int, 0],
            pData: unsafe {
                [
                    base,
                    base.add(luma),
                    base.add(luma + chroma),
                    std::ptr::null_mut(),
                ]
            },
            iPicWidth: w as c_int,
            iPicHeight: h as c_int,
            uiTimeStamp: (self.frames * 1000 / self.fps as u64) as i64,
            bPsnrY: false,
            bPsnrU: false,
            bPsnrV: false,
        };
        self.frames += 1;
        if unsafe { encode(self.native.as_ptr(), &source, &mut *self.bitstream) } != 0 {
            anyhow::bail!("openh264 rejected a {w}x{h} frame");
        }
        let info = &*self.bitstream;
        let sizes = validated_layer_sizes(info)?;
        let mut data = Vec::with_capacity(info.iFrameSizeInBytes.max(0) as usize);
        for (layer, &size) in info.sLayerInfo[..sizes.len()].iter().zip(&sizes) {
            if size == 0 {
                continue;
            }
            // Non-null with this length by validated_layer_sizes; copied into
            // the owned Vec so no borrow of the library's buffers escapes.
            data.extend_from_slice(unsafe { std::slice::from_raw_parts(layer.pBsBuf, size) });
        }
        if data.is_empty() {
            anyhow::bail!("openh264 produced no access unit for a frame");
        }
        Ok(EncodedFrame {
            data,
            keyframe: info.eFrameType == videoFrameTypeIDR,
        })
    }

    /// openh264 cannot change its quantizer ceiling after initialisation, so
    /// the pass runs with rate control off at the fixed quantizer set at open,
    /// [`crate::h264::REFINE_MAX_QP`] (screen content has no adaptive
    /// quantization, so every macroblock gets it), then rate control resumes
    /// without having seen the pass's bits. When rate control is already
    /// coding finer than the ceiling, the pass is an ordinary frame instead.
    fn refine(&mut self, frame: &I420) -> Result<EncodedFrame> {
        // After a refinement the last QP is the refinement's own, which says
        // nothing about where rate control would put this one.
        let packet = if !self.refined && self.last_qp()? <= crate::h264::REFINE_MAX_QP {
            self.encode(frame, false)
        } else {
            self.rc_mode(RC_OFF_MODE)?;
            let packet = self.encode(frame, false);
            self.rc_mode(RC_BITRATE_MODE)?;
            packet
        };
        self.refined = true;
        packet
    }

    fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<()> {
        let mut info = SBitrateInfo {
            iLayer: SPATIAL_LAYER_ALL,
            iBitrate: (bitrate_kbps.max(1) as c_int).saturating_mul(1000),
        };
        self.option(ENCODER_OPTION_BITRATE, &mut info)
    }
}

/// Each layer's bitstream size, validated before any slice is built from
/// what the library handed back: the layer count is clamped to the array,
/// NAL counts and lengths must be non-negative with their length pointers
/// present, sums use checked arithmetic, a non-empty layer needs its buffer,
/// and the running total stays within the reported frame size. Pure over the
/// header, so tests cover it without the library.
fn validated_layer_sizes(info: &SFrameBSInfo) -> Result<Vec<usize>> {
    let layers = info.iLayerNum.clamp(0, info.sLayerInfo.len() as c_int) as usize;
    let mut sizes = Vec::with_capacity(layers);
    let mut total = 0usize;
    for layer in &info.sLayerInfo[..layers] {
        if layer.iNalCount < 0 {
            anyhow::bail!("openh264 reported a negative NAL count");
        }
        let count = layer.iNalCount as usize;
        if count > 0 && layer.pNalLengthInByte.is_null() {
            anyhow::bail!("openh264 reported NALs with no lengths");
        }
        let lengths = if count == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(layer.pNalLengthInByte, count) }
        };
        let mut size = 0usize;
        for &len in lengths {
            if len < 0 {
                anyhow::bail!("openh264 reported a negative NAL length");
            }
            size = size
                .checked_add(len as usize)
                .context("openh264 NAL lengths overflow")?;
        }
        if size > 0 && layer.pBsBuf.is_null() {
            anyhow::bail!("openh264 reported bytes with no buffer");
        }
        total = total
            .checked_add(size)
            .context("openh264 layer sizes overflow")?;
        if info.iFrameSizeInBytes > 0 && total > info.iFrameSizeInBytes as usize {
            anyhow::bail!("openh264 reported more bytes than the frame holds");
        }
        sizes.push(size);
    }
    Ok(sizes)
}

impl Drop for Encoder {
    fn drop(&mut self) {
        if let Some(uninitialize) = self.vtable().Uninitialize {
            unsafe { uninitialize(self.native.as_ptr()) };
        }
        unsafe { self._api.WelsDestroySVCEncoder(self.native.as_ptr()) };
    }
}

/// Where the library is loaded from, or why it is not.
fn library() -> Result<PathBuf> {
    match std::env::var_os("DESKLINK_OPENH264") {
        Some(v) if v == "off" => anyhow::bail!("disabled by DESKLINK_OPENH264=off"),
        Some(v) if !v.is_empty() => Ok(PathBuf::from(v)),
        _ => cached().context("no cache directory (neither XDG_CACHE_HOME nor HOME is set)"),
    }
}

/// `$XDG_CACHE_HOME/desklink/openh264/<file>`, falling back to `~/.cache`.
fn cached() -> Option<PathBuf> {
    let (file, _) = BLOB?;
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(".cache")))?;
    Some(base.join("desklink/openh264").join(file))
}

/// Fetch Cisco's library once per process; true when it is now in place.
pub fn fetch_once() -> bool {
    static FETCHED: OnceLock<bool> = OnceLock::new();
    *FETCHED.get_or_init(|| {
        // An explicit path or `off` is the operator's choice; never override it.
        if std::env::var_os("DESKLINK_OPENH264").is_some_and(|v| !v.is_empty()) {
            return false;
        }
        match fetch() {
            Ok(()) => true,
            Err(error) => {
                eprintln!("openh264: {error:#}");
                false
            }
        }
    })
}

fn fetch() -> Result<()> {
    let (file, sha256) = BLOB.context("Cisco publishes no openh264 build for this architecture")?;
    let target = cached().context("no cache directory (neither XDG_CACHE_HOME nor HOME is set)")?;
    if std::fs::read(&target).is_ok_and(|b| hex(&Sha256::digest(&b)) == sha256) {
        return Ok(());
    }
    let compressed = http_get(&format!("/{file}.bz2"))?;
    let mut library = Vec::new();
    bzip2_rs::DecoderReader::new(compressed.as_slice())
        .take(16 << 20)
        .read_to_end(&mut library)
        .context("Cisco's download is not valid bzip2")?;
    if hex(&Sha256::digest(&library)) != sha256 {
        anyhow::bail!("Cisco's {file} does not match its pinned sha256");
    }
    let dir = target.parent().context("cache path has no parent")?;
    std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let temp = dir.join(format!(".{file}.{}", std::process::id()));
    let written = (|| {
        use std::os::unix::fs::OpenOptionsExt;
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o644)
            .open(&temp)?;
        out.write_all(&library)?;
        out.sync_all()?;
        std::fs::rename(&temp, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written.with_context(|| format!("cannot write {}", target.display()))
}

/// A bounded HTTP/1.0 GET of `path` from [`HOST`] (1.0, so never chunked): 5 s
/// to connect, 20 s in all. Name resolution is the system resolver's own bound.
fn http_get(path: &str) -> Result<Vec<u8>> {
    use std::net::{TcpStream, ToSocketAddrs};
    let deadline = Instant::now() + Duration::from_secs(20);
    let addrs = (HOST, 80)
        .to_socket_addrs()
        .with_context(|| format!("cannot resolve {HOST}"))?;
    let mut stream = addrs
        .into_iter()
        .find_map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(5)).ok())
        .with_context(|| format!("cannot connect to {HOST}"))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    write!(
        stream,
        "GET {path} HTTP/1.0\r\nHost: {HOST}\r\nConnection: close\r\nUser-Agent: desklink\r\n\r\n"
    )?;
    let mut response = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || response.len() > 8 << 20 {
            anyhow::bail!("download from {HOST} took too long or grew too large");
        }
        stream.set_read_timeout(Some(left))?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e).context(format!("download from {HOST} failed")),
        }
    }
    let end = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .context("malformed HTTP response")?;
    let head = String::from_utf8_lossy(&response[..end]).into_owned();
    let status = head.lines().next().unwrap_or_default();
    if status.split_whitespace().nth(1) != Some("200") {
        anyhow::bail!("{HOST} answered {status}");
    }
    let body = response.split_off(end + 4);
    // A truncated body would only fail the hash later; say so plainly here.
    let length = head.lines().find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())?
    });
    if length.is_some_and(|n| n != body.len()) {
        anyhow::bail!("download from {HOST} was cut short");
    }
    Ok(body)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
