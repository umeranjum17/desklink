//! One authorized desktop session: capture in, VP9 out, control channel in,
//! desktop input out, and a bounded teardown.
//!
//! The engine trusts the consumer's local permission decision and enforces the
//! resulting scope. It has no second identity system, no account and no notion
//! of which application asked.

use crate::capture::{self, Capture};
use crate::clipboard;
use crate::convert::{fit, I420};
use crate::encoder::Encoder;
use crate::input::{Button, HeldState, InputDevices};
use crate::keymap::{self, Layout};
use crate::peer::{
    h264_profile_level_id, PathReport, PeerEvent, TransportOptions, VideoCodec, VideoPeer,
};
use crate::portal::{self, SelectedSource};
use crate::protocol::{
    ControlMessage, ControlReply, EncodedCodec, Permission, PointerPhase, SourceRequest,
};
use crate::x11::X11Desktop;
use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc as tokio_mpsc;

/// How long a clipboard operation may take before it is reported as unanswered.
///
/// A compositor with no clipboard service must produce an error the user can
/// read, not a request that never returns.
const CLIPBOARD_TIMEOUT: Duration = Duration::from_secs(3);

/// Run a clipboard operation off the async runtime and bounded.
///
/// Both halves matter. The clipboard backends block, and running one inline on
/// a runtime thread stalls the session's own input and lifecycle events; and a
/// desktop whose clipboard cannot answer must fail visibly rather than hang.
async fn clipboard_task<T: Send + 'static>(
    operation: impl FnOnce() -> std::result::Result<T, String> + Send + 'static,
) -> std::result::Result<T, String> {
    match tokio::time::timeout(CLIPBOARD_TIMEOUT, tokio::task::spawn_blocking(operation)).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(format!("the clipboard operation failed: {join}")),
        Err(_) => Err(String::from("the desktop clipboard did not answer")),
    }
}

/// How the capture → encode → send path is doing, reported to the consumer.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Metrics {
    pub captured_frames: u64,
    pub dropped_frames: u64,
    pub encoded_frames: u64,
    pub encoded_bytes: u64,
    /// Key frames sent: the first, one per receiver request, and one each time
    /// motion starts or stops being coded at half size.
    pub key_frames: u64,
    /// Refinement passes: a still desktop re-coded once, sharp.
    pub refined_frames: u64,
    /// Motion frames coded at half size because full size could not keep up.
    pub halved_frames: u64,
    /// Fresh captures coded at the pace of change: a motion pass on a frame
    /// the encoder had not coded yet — the population `queue_micros` is over.
    pub motion_frames: u64,
    /// Time spent in the encoder, in microseconds, over every encoded frame.
    pub encode_micros: u64,
    /// Time spent grabbing and converting a frame on the capture thread, in
    /// microseconds, over every frame forwarded to the encoder. On X11 this
    /// is `GetImage` plus the downscale to I420; unchanged polls are hashed,
    /// recognised, and never forwarded, so their grab cost stays out; the lab
    /// harness reads it as the grab cost L1 owns.
    pub capture_micros: u64,
    /// Time spent hashing a captured frame and working out its damage on the
    /// capture thread, in microseconds, over every forwarded frame; the hash
    /// branch runs only when `local_frames` is on.
    pub convert_micros: u64,
    /// Time a freshly captured frame waited between the capture handoff and
    /// the start of its encode, in microseconds, over motion frames.
    pub queue_micros: u64,
    /// Time spent packetizing a frame and handing it to the transport, in
    /// microseconds, over every sent frame.
    pub send_micros: u64,
    /// The current rate target, after any loss back-off.
    pub target_kbps: u32,
    pub input_applied: u64,
    pub input_rejected: u64,
    /// Access units the consumer fed to an encoded source.
    pub fed_frames: u64,
    /// Control messages forwarded back to the consumer that owns the device,
    /// instead of being applied to a desktop this engine holds.
    pub input_forwarded: u64,
}

fn tile_hashes(raw: &[u8], width: usize, height: usize) -> Vec<u64> {
    use std::hash::{Hash, Hasher};
    let mut hashes = Vec::new();
    for y in (0..height).step_by(32) {
        for x in (0..width).step_by(32) {
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            for row in y..(y + 32).min(height) {
                raw[(row * width + x) * 4..(row * width + (x + 32).min(width)) * 4].hash(&mut hash);
            }
            hashes.push(hash.finish());
        }
    }
    hashes
}

/// Group changed 32-pixel tiles without merging unrelated regions.
fn dirty_regions(hashes: &[u64], previous: &[u64], width: usize, height: usize) -> Vec<[usize; 4]> {
    if hashes.len() != previous.len() {
        return vec![[0, 0, width, height]];
    }
    let columns = width.div_ceil(32);
    let mut dirty: Vec<bool> = hashes
        .iter()
        .zip(previous)
        .map(|(now, before)| now != before)
        .collect();
    let mut regions = Vec::new();
    for index in 0..dirty.len() {
        if !dirty[index] {
            continue;
        }
        dirty[index] = false;
        let mut stack = vec![index];
        let (mut left, mut top, mut right, mut bottom) = (
            index % columns,
            index / columns,
            index % columns,
            index / columns,
        );
        while let Some(tile) = stack.pop() {
            let col = tile % columns;
            let row = tile / columns;
            left = left.min(col);
            right = right.max(col);
            top = top.min(row);
            bottom = bottom.max(row);
            for neighbor in [
                tile.checked_sub(columns),
                (row + 1 < height.div_ceil(32)).then_some(tile + columns),
                (col > 0).then(|| tile - 1),
                (col + 1 < columns).then_some(tile + 1),
            ]
            .into_iter()
            .flatten()
            {
                if dirty[neighbor] {
                    dirty[neighbor] = false;
                    stack.push(neighbor);
                }
            }
        }
        let x = left * 32;
        let y = top * 32;
        regions.push([
            x,
            y,
            ((right + 1) * 32).min(width) - x,
            ((bottom + 1) * 32).min(height) - y,
        ]);
    }
    regions
}

/// Dropping either variant stops its capture: the portal releases consent and
/// the X11 variant stops reading its server.
enum FrameSource {
    Portal(Capture),
    X11(X11Capture),
}

/// Root-window capture on an X display this engine was pointed at.
struct X11Capture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for X11Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What a chosen capture backend gives the session.
struct Selected {
    source: SelectedSource,
    capture: FrameSource,
    /// Present only on the X11 path, where the same connection applies input.
    x11: Option<Arc<Mutex<X11Desktop>>>,
}

/// Open an X display, start reading its root window, and hand back the same
/// shape the portal path produces.
fn select_x11(
    display: Option<&str>,
    max_width: usize,
    max_height: usize,
    max_fps: u32,
    metrics: Arc<Mutex<Metrics>>,
    sink: capture::FrameSink,
    on_stop: Box<dyn Fn(String) + Send>,
) -> Result<Selected> {
    let desktop = Arc::new(Mutex::new(X11Desktop::connect(display)?));
    let (width, height) = {
        let desktop = lock(&desktop);
        eprintln!("x11 capture path: {}", desktop.capture_path());
        desktop.screen_size()
    };
    let source = SelectedSource {
        node_id: 0,
        width,
        height,
        position: Some((0, 0)),
        source_type: Some(String::from("x11-root")),
        origin_x: 0,
        origin_y: 0,
    };

    let stop = Arc::new(AtomicBool::new(false));
    let captured = metrics.clone();
    let thread = {
        let desktop = desktop.clone();
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("desklink-x11-capture".into())
            .spawn(move || {
                let interval = frame_interval(max_fps);
                let mut sequence = 0u64;
                let mut last_sent: Option<Instant> = None;
                // Without XDamage there is no change signal, so an unchanged
                // screen is recognised by its pixels exactly as before.
                let hashed = !lock(&desktop).damage_armed();
                let mut last_hash = None;
                // The first frame is always grabbed; afterwards Damage wakes
                // the loop, so a still screen costs no grab, no conversion
                // and no hash. The fps cap stays a minimum spacing.
                let mut first = true;
                while !stop.load(Ordering::SeqCst) {
                    if !first {
                        let changed = lock(&desktop).take_damage();
                        if !changed {
                            std::thread::sleep(interval);
                            continue;
                        }
                        if let Some(sent) = last_sent {
                            let elapsed = sent.elapsed();
                            if elapsed < interval {
                                std::thread::sleep(interval - elapsed);
                            }
                        }
                    }
                    let started = Instant::now();
                    let grabbed = Instant::now();
                    let frame = {
                        let mut desktop = lock(&desktop);
                        desktop.capture_with_pixels(max_width, max_height)
                    };
                    let grab_micros = grabbed.elapsed().as_micros() as u64;
                    match frame {
                        Ok((frame, raw)) => {
                            let changed = if hashed {
                                use std::hash::{Hash, Hasher};
                                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                                raw.hash(&mut hasher);
                                let hash = hasher.finish();
                                if last_hash == Some(hash) {
                                    false
                                } else {
                                    last_hash = Some(hash);
                                    true
                                }
                            } else {
                                true
                            };
                            if changed {
                                // Handing an unchanged frame on would keep the
                                // encoder busy and a still desktop would never
                                // be refined.
                                if let Ok(mut m) = captured.lock() {
                                    m.capture_micros += grab_micros;
                                }
                                let (w, h) = (frame.width, frame.height);
                                let (screen_w, screen_h) = (width as usize, height as usize);
                                sink(frame, sequence, &mut || {
                                    crate::convert::to_bgrx(
                                        &raw,
                                        screen_w,
                                        screen_h,
                                        screen_w * 4,
                                        crate::convert::PixelFormat::Bgrx,
                                        w,
                                        h,
                                    )
                                });
                                sequence += 1;
                                last_sent = Some(started);
                                first = false;
                            }
                        }
                        Err(error) => {
                            if let Ok(mut m) = captured.lock() {
                                m.dropped_frames += 1;
                            }
                            // A display that has gone away is not recoverable by
                            // retrying, so stop rather than spin on the error.
                            if error.to_string().contains("the X11 connection dropped") {
                                on_stop(format!("X11 capture stopped: {error}"));
                                break;
                            }
                            if !hashed {
                                let elapsed = started.elapsed();
                                if elapsed < interval {
                                    std::thread::sleep(interval - elapsed);
                                }
                            }
                        }
                    }
                    // With Damage the fps cap paced the grab above; without
                    // it the loop keeps its old trailing sleep.
                    if hashed {
                        let elapsed = started.elapsed();
                        if elapsed < interval {
                            std::thread::sleep(interval - elapsed);
                        }
                    }
                }
            })
            .ok()
    };

    Ok(Selected {
        source,
        capture: FrameSource::X11(X11Capture { stop, thread }),
        x11: Some(desktop),
    })
}

/// Where input goes. One controller, one applier, one held-state record.
struct InputTarget {
    applier: Applier,
    held: HeldState,
    explicit_modifiers: Vec<i16>,
    chord_modifiers: Vec<i16>,
    chord_keys: Vec<(i16, Vec<i16>)>,
    /// Fractions of a detent an X server, which only knows whole wheel clicks,
    /// has not been sent yet.
    wheel_rest: (f64, f64),
}

enum Applier {
    Uinput(InputDevices),
    X11(Arc<Mutex<X11Desktop>>),
    #[cfg(test)]
    Recording(Arc<Mutex<Vec<(i16, bool)>>>),
}

impl InputTarget {
    fn move_absolute(&mut self, x: i64, y: i64) -> Result<()> {
        match &mut self.applier {
            Applier::Uinput(devices) => {
                devices.move_absolute(x, y);
                Ok(())
            }
            Applier::X11(desktop) => lock(desktop).move_pointer(x, y),
            #[cfg(test)]
            Applier::Recording(_) => Ok(()),
        }
    }

    fn button(&mut self, button: Button, down: bool) -> Result<()> {
        self.held.button(button, down);
        match &mut self.applier {
            Applier::Uinput(devices) => {
                devices.button(button, down);
                Ok(())
            }
            Applier::X11(desktop) => lock(desktop).button(x11_button(button), down),
            #[cfg(test)]
            Applier::Recording(log) => {
                if let Ok(mut log) = log.lock() {
                    log.push((-1, down));
                }
                Ok(())
            }
        }
    }

    fn scroll(&mut self, dx: f64, dy: f64) -> Result<()> {
        match &mut self.applier {
            Applier::Uinput(devices) => {
                devices.scroll(dx, dy);
                Ok(())
            }
            Applier::X11(desktop) => {
                let (rest_x, rest_y) = (self.wheel_rest.0 + dx, self.wheel_rest.1 + dy);
                let (whole_x, whole_y) = (rest_x.trunc(), rest_y.trunc());
                self.wheel_rest = (rest_x - whole_x, rest_y - whole_y);
                lock(desktop).scroll(whole_x as i64, whole_y as i64)
            }
            #[cfg(test)]
            Applier::Recording(_) => Ok(()),
        }
    }

    fn check_keys(&self, codes: impl IntoIterator<Item = i16>) -> Result<()> {
        if matches!(&self.applier, Applier::Uinput(_)) {
            for code in codes {
                crate::input::native_keycode(code)?;
            }
        }
        Ok(())
    }

    fn key(&mut self, code: i16, down: bool) -> Result<()> {
        match &mut self.applier {
            Applier::Uinput(devices) => devices.key(code, down),
            Applier::X11(desktop) => lock(desktop).key(code, down),
            #[cfg(test)]
            Applier::Recording(log) => {
                if let Ok(mut log) = log.lock() {
                    log.push((code, down));
                }
                Ok(())
            }
        }?;
        self.held.key(code, down);
        Ok(())
    }

    fn modifier(&mut self, code: i16, down: bool, explicit: bool) -> Result<()> {
        let own = if explicit {
            &self.explicit_modifiers
        } else {
            &self.chord_modifiers
        };
        let other = if explicit {
            &self.chord_modifiers
        } else {
            &self.explicit_modifiers
        };
        if down {
            if explicit && own.contains(&code) {
                return Ok(());
            }
            if !own.contains(&code) && !other.contains(&code) {
                self.key(code, true)?;
            }
        } else {
            let Some(index) = own.iter().position(|held| *held == code) else {
                return Ok(());
            };
            if own.iter().filter(|held| **held == code).count() == 1 && !other.contains(&code) {
                self.key(code, false)?;
            }
            let own = if explicit {
                &mut self.explicit_modifiers
            } else {
                &mut self.chord_modifiers
            };
            own.remove(index);
            return Ok(());
        }
        let own = if explicit {
            &mut self.explicit_modifiers
        } else {
            &mut self.chord_modifiers
        };
        own.push(code);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn unicode_text(&mut self, text: &str) -> Result<()> {
        match &mut self.applier {
            #[cfg(target_os = "macos")]
            Applier::Uinput(devices) => devices.unicode_text(text),
            #[cfg(target_os = "linux")]
            Applier::Uinput(_) => anyhow::bail!("Unicode text input is unavailable on Linux"),
            Applier::X11(_) => anyhow::bail!("Unicode text input is unavailable for X11"),
            #[cfg(test)]
            Applier::Recording(_) => Ok(()),
        }
    }

    fn chord(&mut self, code: i16, modifiers: Vec<i16>, down: bool) -> Result<()> {
        if down {
            if self.chord_keys.iter().any(|(held, _)| *held == code) {
                return Ok(());
            }
            self.check_keys(modifiers.iter().copied().chain(std::iter::once(code)))?;
            for modifier in &modifiers {
                self.modifier(*modifier, true, false)?;
            }
            self.key(code, true)?;
            self.chord_keys.push((code, modifiers));
        } else if let Some(index) = self.chord_keys.iter().position(|(held, _)| *held == code) {
            self.key(code, false)?;
            let (_, modifiers) = self.chord_keys.remove(index);
            for modifier in modifiers.iter().rev() {
                self.modifier(*modifier, false, false)?;
            }
        }
        Ok(())
    }

    /// Release exactly what this session pressed, once, buttons before keys.
    fn release_all(&mut self) -> Result<()> {
        self.explicit_modifiers.clear();
        self.chord_modifiers.clear();
        self.chord_keys.clear();
        let (buttons, keys) = self.held.release_plan();
        for button in buttons {
            match &mut self.applier {
                Applier::Uinput(devices) => devices.button(button, false),
                Applier::X11(desktop) => lock(desktop).button(x11_button(button), false)?,
                #[cfg(test)]
                Applier::Recording(log) => {
                    if let Ok(mut log) = log.lock() {
                        log.push((-1, false));
                    }
                }
            }
        }
        for code in keys {
            match &mut self.applier {
                Applier::Uinput(devices) => devices.key(code, false)?,
                Applier::X11(desktop) => lock(desktop).key(code, false)?,
                #[cfg(test)]
                Applier::Recording(log) => {
                    if let Ok(mut log) = log.lock() {
                        log.push((code, false));
                    }
                }
            }
        }
        Ok(())
    }
}

fn x11_button(button: Button) -> u8 {
    match button {
        Button::Left => crate::x11::button::LEFT,
        Button::Middle => crate::x11::button::MIDDLE,
        Button::Right => crate::x11::button::RIGHT,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A poisoned lock means a previous input call panicked while applying; the
    // desktop is then in unknown state, so the session is closed rather than
    // continuing to drive it.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why a session could not do what was asked, in the protocol's own vocabulary.
#[derive(Debug)]
pub struct SessionError {
    pub code: &'static str,
    pub message: String,
}

impl SessionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct OpenRequest {
    /** Which desktop to capture; absent means the portal. */
    pub source: Option<SourceRequest>,
    pub permissions: Vec<Permission>,
    pub max_width: usize,
    pub max_height: usize,
    pub bitrate_kbps: u32,
    pub max_fps: u32,
    pub ice_servers: Vec<(String, Option<String>, Option<String>)>,
    pub restore_token: Option<String>,
    pub ttl: Option<Duration>,
    /// Offer a passive ICE-TCP candidate on the loopback, for a forwarded client.
    pub loopback_tcp: bool,
    pub agent_indicator: bool,
    /// Keep the latest frame and its tile hashes for `session.frame` and
    /// `session.frame.changed`; off, a frame is converted once, for the encoder.
    pub local_frames: bool,
}

/// Events a session raises for its consumer.
#[derive(Debug)]
pub enum SessionEvent {
    Description {
        generation: u64,
        sdp: String,
    },
    Candidate {
        generation: u64,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    },
    State {
        capture: &'static str,
        transport: String,
        first_frame: bool,
    },
    Frame {
        seq: u64,
        damage: Vec<[usize; 4]>,
    },
    /// One control-channel message from the client, for a source whose device
    /// the consumer drives. The engine applied nothing locally.
    Input {
        input: serde_json::Value,
    },
    /// The far end needs a fresh reference frame and only the consumer can make
    /// one: the encoder for this track is on its side. Raised by an RTCP PLI or
    /// FIR, and once when the transport connects, because everything sent before
    /// that was dropped.
    KeyframeRequest {
        generation: u64,
    },
    RestoreToken(String),
    CaptureStopped {
        reason: String,
    },
    /// The session ended on the engine's side. `code` says whether a new
    /// session may recover it: `transport` is the path to the consumer's peer
    /// lost, which a fresh `session.open` can heal; `lease` and `error` are
    /// the session's authority ending or a fault, which it cannot.
    Revoked {
        reason: String,
        code: &'static str,
    },
}

/// One notification plus the session it belongs to. The engine serves one
/// session at a time, but its queue outlives a session, so a consumer needs the
/// identity to attribute an event to the record that asked for it.
#[derive(Debug)]
pub struct Notice {
    pub session_id: String,
    pub event: SessionEvent,
}

type FrameSnapshot = (u64, Instant, usize, usize, Vec<u8>, Vec<u64>, Vec<u64>);

/// Everything a session's background tasks need, shared rather than borrowed so
/// the consumer can own the `Session` handle while the pipeline runs.
struct Inner {
    id: String,
    generation: u64,
    permissions: Vec<Permission>,
    source: SelectedSource,
    geometry: serde_json::Value,
    metrics: Arc<Mutex<Metrics>>,
    latest: Arc<Mutex<Option<FrameSnapshot>>>,
    capture_error: Arc<Mutex<Option<String>>>,
    frame_changes: tokio::sync::watch::Receiver<u64>,
    /// Built when the codec is known: with `session.open` for a captured
    /// desktop, and with the first fed access unit for an encoded source, whose
    /// offer has to name the profile the stream's own SPS declares.
    peer: Mutex<Option<Arc<VideoPeer>>>,
    /// Absent for an encoded source: the consumer is the encoder.
    encoder: Mutex<Option<Encoder>>,
    input: Mutex<Option<InputTarget>>,
    indicator: Mutex<Option<crate::indicator::Indicator>>,
    capture: Mutex<Option<FrameSource>>,
    /// Absent for an encoded source: there is no local keyboard to translate a
    /// character through, because the client's keys are forwarded instead.
    layout: Mutex<Option<Layout>>,
    last_seq: Mutex<u64>,
    control_open: AtomicBool,
    closed: AtomicBool,
    /// Set false to stop the encode loop; owned here so closing is reachable
    /// from the lease as well as from the consumer.
    pipeline: Arc<AtomicBool>,
    events: tokio_mpsc::UnboundedSender<Notice>,
    /// Present only for an encoded source.
    encoded: Mutex<Option<Encoded>>,
    /// `OpenRequest::local_frames`: whether `latest` is kept at all.
    local_frames: bool,
}

/// A source whose video arrives already encoded.
struct Encoded {
    /// What the consumer said it would feed. Only H.264 exists today; the offer
    /// is built from this rather than assumed, so a second codec is one arm here.
    codec: EncodedCodec,
    /// The transport settings the consumer chose in `session.open`, kept until
    /// the peer that uses them can be built.
    transport: TransportOptions,
    /// Where the peer's events go once it exists.
    peer_events: tokio_mpsc::UnboundedSender<PeerEvent>,
    /// Access units waiting to be packetized.
    feed: tokio_mpsc::Sender<FedAccessUnit>,
}

/// One access unit a consumer fed, with the keyframe flag it declared.
struct FedAccessUnit {
    keyframe: bool,
    data: Vec<u8>,
}

/// How many fed access units may wait. A live stream drops the newest rather
/// than queue: the packetizer is the only consumer, and a backlog of
/// milliseconds-old pictures is worse than a gap the receiver asks to repair.
const FEED_BACKLOG: usize = 8;

pub struct Session {
    inner: Arc<Inner>,
}

#[cfg(target_os = "linux")]
fn wayland_clipboard_available() -> bool {
    std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// What the engine can actually do on this machine right now.
#[cfg(target_os = "linux")]
pub fn capabilities() -> serde_json::Value {
    let session_kind = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        "wayland"
    } else if std::env::var_os("DISPLAY").is_some() {
        "x11"
    } else {
        "none"
    };
    // Clipboard transfer needs Wayland; writes also need a selection server
    // that can outlive this engine. Do not offer it when that tool is absent.
    let clipboard = wayland_clipboard_available();
    let x11 = crate::x11::X11Desktop::connect(None)
        .map(|desktop| serde_json::json!([desktop.screen_size().0, desktop.screen_size().1]))
        .unwrap_or(serde_json::Value::Null);
    let (input, grant_state, unavailable) = match crate::input::probe() {
        Ok(()) => (serde_json::json!(true), "granted", serde_json::Value::Null),
        Err(unavailable) => (
            serde_json::json!(false),
            "missing-device-access",
            serde_json::json!({
                "reason": unavailable.reason,
                "remedy": unavailable.remedy,
            }),
        ),
    };
    serde_json::json!({
        "protocol": crate::protocol::PROTOCOL_VERSION,
        "engine": format!("desklink-host/{}", env!("CARGO_PKG_VERSION")),
        "platform": "linux",
        "session": { "kind": session_kind },
        "x11": { "available": x11.is_array(), "size": x11 },
        "capture": {
            "mechanism": "portal-screencast+pipewire",
            // Backends this build has, not a claim that both are usable here; the
            // portal is preferred and needs the user's consent, the X display is
            // available whenever DISPLAY points at a server.
            "backends": ["portal-screencast+pipewire", "x11-root"],
            "formats": ["bgrx", "bgra", "rgbx", "rgba"],
            "cursor": "embedded",
            "audio": false,
        },
        "encode": { "codecs": ["vp9"], "hardware": false },
        "input": {
            "mechanism": "inputtino/uinput",
            "pointer": input,
            "wheel": input,
            "keyboard": input,
            "text": ["layout-reachable"],
            "layout": keymap::LayoutNames::from_environment().identity(),
            "unavailable_reason": unavailable,
            "grant": grant_state,
        },
        "clipboard": { "read": clipboard, "write": clipboard && clipboard::writer_available(), "mime": ["text/plain;charset=utf-8"],
                       "maxBytes": clipboard::MAX_CLIPBOARD_BYTES },
        // Video this engine does not capture or encode but can carry, so a
        // consumer can tell an old engine from one that takes `session.feed`
        // without guessing from a version string.
        "encoded": { "codecs": ["h264"] },
    })
}

#[cfg(target_os = "macos")]
fn wayland_clipboard_available() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn capabilities() -> serde_json::Value {
    let capture_granted = unsafe { crate::mac::CGPreflightScreenCaptureAccess() };
    let (input, input_grant, unavailable) = match crate::input::probe() {
        Ok(()) => (true, "granted", serde_json::Value::Null),
        Err(error) => (
            false,
            "missing-accessibility",
            serde_json::json!({
                "reason": error.reason,
                "remedy": error.remedy,
            }),
        ),
    };
    serde_json::json!({
        "protocol": crate::protocol::PROTOCOL_VERSION,
        "engine": format!("desklink-host/{}", env!("CARGO_PKG_VERSION")),
        "platform": "macos",
        "session": { "kind": "quartz", "on_console": crate::mac::on_console() },
        "x11": { "available": false, "size": null },
        "capture": {
            "mechanism": "screencapturekit",
            "backends": ["screencapturekit"],
            "formats": ["bgra"],
            "cursor": "embedded",
            "audio": false,
            "displays": crate::mac::displays(),
            "grant": if capture_granted { "granted" } else { "missing-screen-recording" },
            "unavailable_reason": if capture_granted { serde_json::Value::Null } else { serde_json::json!({
                "reason": format!("Screen Recording permission has not been granted to {}.", crate::mac::tcc_responsible_app_name()),
                "remedy": format!("Allow {} in System Settings › Privacy & Security › Screen & System Audio Recording, then reconnect.", crate::mac::tcc_responsible_app_name())
            }) }
        },
        "encode": { "codecs": ["vp9"], "hardware": false },
        "input": {
            "mechanism": "quartz-cgevent",
            "pointer": input,
            "wheel": input,
            "keyboard": input,
            "text": ["unicode", "us-ansi-keymap"],
            "layout": keymap::LayoutNames::from_environment().identity(),
            "unavailable_reason": unavailable,
            "grant": input_grant,
        },
        "clipboard": { "read": true, "write": true, "mime": ["text/plain;charset=utf-8"],
            "maxBytes": clipboard::MAX_CLIPBOARD_BYTES },
        "encoded": { "codecs": ["h264"] },
    })
}

impl Session {
    pub async fn open(
        request: OpenRequest,
        events: tokio_mpsc::UnboundedSender<Notice>,
    ) -> std::result::Result<Self, SessionError> {
        if !request.permissions.contains(&Permission::View) {
            return Err(SessionError::new(
                "permission",
                "session.open requires the view permission",
            ));
        }
        let id = opaque_id();
        let wants_control = request.permissions.contains(&Permission::Control);
        let wants_x11 = matches!(request.source, Some(SourceRequest::X11 { .. }));
        let max_fps = request.max_fps.clamp(1, 60);
        // A source the consumer feeds needs no capture backend, no encoder and
        // no local input device: the device the client drives is the consumer's,
        // and the offer has to wait for the stream's own SPS.
        if let Some(SourceRequest::Encoded {
            codec,
            width,
            height,
        }) = request.source.clone()
        {
            return Self::open_encoded(request, codec, width, height, events).await;
        }
        // Which desktop decides which input path is even available: an X display
        // takes XTest, which cannot reach any other session, while a portal
        // desktop needs kernel input access.
        if wants_control && !wants_x11 {
            // Refuse up front rather than presenting a control surface that
            // silently does nothing.
            if crate::input::probe().is_err() {
                #[cfg(target_os = "macos")]
                let _ = crate::input::request_access();
                if let Err(unavailable) = crate::input::probe() {
                    return Err(SessionError::new(
                        "input-unavailable",
                        format!("{}; {}", unavailable.reason, unavailable.remedy),
                    ));
                }
            }
        }

        let metrics = Arc::new(Mutex::new(Metrics::default()));
        let mut indicator = None;
        let (frame_tx, frame_rx) = latest_frame();
        let latest = Arc::new(Mutex::new(None::<FrameSnapshot>));
        let observed = latest.clone();
        let frame_sequence = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let capture_error = Arc::new(Mutex::new(None::<String>));
        let stopped_error = capture_error.clone();
        let stopped_latest = latest.clone();
        let stopped_events = events.clone();
        let stopped_id = id.clone();
        let (frame_tx_signal, frame_changes) = tokio::sync::watch::channel(0u64);
        let captured = metrics.clone();
        let stop_signal = frame_tx_signal.clone();
        let on_capture_status = move |running: bool, reason: String| {
            if let Ok(mut error) = stopped_error.lock() {
                *error = if running { None } else { Some(reason.clone()) };
            }
            if let Ok(mut frame) = stopped_latest.lock() {
                *frame = None;
            }
            stop_signal.send_replace(0);
            let _ = stopped_events.send(Notice {
                session_id: stopped_id.clone(),
                event: if running {
                    SessionEvent::State {
                        capture: "streaming",
                        transport: String::from("connected"),
                        first_frame: false,
                    }
                } else {
                    SessionEvent::CaptureStopped { reason }
                },
            });
        };
        let capture_status = Arc::new(on_capture_status);
        let frame_events = events.clone();
        let frame_session_id = id.clone();
        let local_frames = request.local_frames;
        let sink = Box::new(move |frame: I420, _seq: u64, pixels: capture::Pixels| {
            // The frame's RTP time: when capture handed it over, not when it
            // was coded, so the receiver never sees encode jitter as cadence.
            // ponytail: stamped after the backend's grab and conversion; a
            // grab-start instant from each backend needs a FrameSink change.
            let captured_at = Instant::now();
            let raw = if local_frames { pixels() } else { None };
            let hashes = raw
                .as_ref()
                .map(|raw| tile_hashes(raw, frame.width, frame.height));
            if let (Some(raw), Some(hashes), Ok(mut held)) = (raw, hashes, observed.lock()) {
                let unchanged =
                    held.as_ref()
                        .is_some_and(|(_, _, width, height, _, current, _)| {
                            *width == frame.width && *height == frame.height && current == &hashes
                        });
                if !unchanged {
                    let seq = frame_sequence.fetch_add(1, Ordering::Relaxed) + 1;
                    let previous = held
                        .as_ref()
                        .map(|(_, _, _, _, _, current, _)| current.clone())
                        .unwrap_or_default();
                    let damage = dirty_regions(&hashes, &previous, frame.width, frame.height);
                    *held = Some((
                        seq,
                        Instant::now(),
                        frame.width,
                        frame.height,
                        raw,
                        hashes,
                        previous,
                    ));
                    frame_tx_signal.send_replace(seq);
                    let _ = frame_events.send(Notice {
                        session_id: frame_session_id.clone(),
                        event: SessionEvent::Frame { seq, damage },
                    });
                }
            }
            if let Ok(mut m) = captured.lock() {
                m.captured_frames += 1;
                m.convert_micros += captured_at.elapsed().as_micros() as u64;
            }
            // An encoder that is behind gets the newest frame, not a queue: a
            // desktop stream is live, and the last state is the one that counts.
            if frame_tx.put(frame, captured_at) {
                if let Ok(mut m) = captured.lock() {
                    m.dropped_frames += 1;
                }
            }
        });

        let Selected {
            source,
            capture,
            x11,
        } = match request.source.clone() {
            Some(SourceRequest::X11 { display }) => select_x11(
                display.as_deref(),
                request.max_width,
                request.max_height,
                max_fps,
                metrics.clone(),
                sink,
                Box::new({
                    let status = capture_status.clone();
                    move |reason| status(false, reason)
                }),
            )
            .map_err(|error| SessionError::new("source", format!("{error:#}")))?,
            _ => {
                let portal = match request.source.as_ref() {
                    Some(SourceRequest::Display { display_id }) => {
                        portal::open_display(*display_id).await
                    }
                    _ => portal::open(request.restore_token.as_deref()).await,
                }
                .map_err(|error| SessionError::new("source", format!("{error:#}")))?;
                if let Some(token) = &portal.restore_token {
                    let _ = events.send(Notice {
                        session_id: id.clone(),
                        event: SessionEvent::RestoreToken(token.clone()),
                    });
                }
                let source = portal.source.clone();
                let source_w = source.width.max(1) as usize;
                let source_h = source.height.max(1) as usize;
                let (width, height) =
                    fit(source_w, source_h, request.max_width, request.max_height);
                #[cfg(target_os = "linux")]
                if request.agent_indicator && wants_control {
                    indicator = Some(
                        crate::indicator::Indicator::start_wayland(source_w, source_h).map_err(
                            |error| {
                                SessionError::new("indicator-unavailable", format!("{error:#}"))
                            },
                        )?,
                    );
                }
                #[cfg(target_os = "macos")]
                if request.agent_indicator && wants_control {
                    indicator = Some(
                        crate::indicator::Indicator::start(source.node_id, source_w, source_h)
                            .map_err(|error| {
                                SessionError::new("indicator", format!("{error:#}"))
                            })?,
                    );
                }
                #[cfg(target_os = "macos")]
                let capture = capture::start(
                    portal,
                    width,
                    height,
                    max_fps,
                    sink,
                    indicator.as_ref().map(crate::indicator::Indicator::pid),
                    Box::new({
                        let status = capture_status.clone();
                        move |running, reason| status(running, reason)
                    }),
                )
                .map_err(|error| SessionError::new("source", format!("{error:#}")))?;
                #[cfg(target_os = "linux")]
                let capture = capture::start(
                    portal,
                    width,
                    height,
                    max_fps,
                    sink,
                    indicator
                        .as_ref()
                        .map(crate::indicator::Indicator::position),
                    Box::new({
                        let status = capture_status.clone();
                        move |reason| status(false, reason)
                    }),
                )
                .map_err(|error| SessionError::new("source", format!("{error:#}")))?;
                #[cfg(target_os = "linux")]
                if let Some(indicator) = indicator.as_mut() {
                    indicator.event('A', -1, -1);
                }
                Selected {
                    source,
                    capture: FrameSource::Portal(capture),
                    x11: None,
                }
            }
        };

        let source_w = source.width.max(1) as usize;
        let source_h = source.height.max(1) as usize;
        #[cfg(target_os = "linux")]
        if request.agent_indicator && wants_control && wants_x11 {
            let display = match &request.source {
                Some(SourceRequest::X11 {
                    display: Some(display),
                }) => display.clone(),
                _ => std::env::var("DISPLAY")
                    .map_err(|_| SessionError::new("indicator-unavailable", "no X display"))?,
            };
            indicator = Some(
                crate::indicator::Indicator::start(&display, source_w, source_h)
                    .map_err(|error| SessionError::new("indicator", format!("{error:#}")))?,
            );
        }
        let (width, height) = fit(source_w, source_h, request.max_width, request.max_height);

        let bitrate_kbps = if request.bitrate_kbps == 0 {
            auto_bitrate(width, height)
        } else {
            request.bitrate_kbps
        };
        let encoder = Encoder::new(
            width,
            height,
            bitrate_kbps,
            max_fps,
            available_parallelism().min(8) as u32,
        )
        .map_err(|error| SessionError::new("encode", format!("{error:#}")))?;

        // Everything that can still refuse the session comes before the peer:
        // a peer created and then abandoned keeps its socket and tasks alive.
        let input = if !wants_control {
            None
        } else {
            Some(match &x11 {
                Some(desktop) => InputTarget {
                    applier: Applier::X11(desktop.clone()),
                    held: HeldState::default(),
                    explicit_modifiers: Vec::new(),
                    chord_modifiers: Vec::new(),
                    chord_keys: Vec::new(),
                    wheel_rest: (0.0, 0.0),
                },
                None => InputTarget {
                    applier: Applier::Uinput({
                        #[cfg(target_os = "linux")]
                        let devices = InputDevices::create(source_w as i32, source_h as i32);
                        #[cfg(target_os = "macos")]
                        let devices = InputDevices::create_for_display(
                            source_w as i32,
                            source_h as i32,
                            source.node_id,
                        );
                        devices.map_err(|error| {
                            SessionError::new("input-unavailable", format!("{error:#}"))
                        })?
                    }),
                    held: HeldState::default(),
                    explicit_modifiers: Vec::new(),
                    chord_modifiers: Vec::new(),
                    chord_keys: Vec::new(),
                    wheel_rest: (0.0, 0.0),
                },
            })
        };

        let layout = Layout::from_environment().map_err(|error| {
            SessionError::new("input", format!("no keyboard layout: {error:#}"))
        })?;

        let (peer_events_tx, peer_events_rx) = tokio_mpsc::unbounded_channel::<PeerEvent>();
        let (peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: request.ice_servers.clone(),
                loopback_tcp: request.loopback_tcp,
                // Well above the rate target, so pacing only spreads a large
                // frame over a few tens of milliseconds and never queues.
                pace_bps: (bitrate_kbps as f64 * 3_000.0).max(20_000_000.0),
            },
            peer_events_tx,
            VideoCodec::Vp9,
        )
        .await
        .map_err(|error| SessionError::new("transport", format!("{error:#}")))?;
        let peer = Arc::new(peer);

        let generation = 1u64;
        let geometry = serde_json::json!({
            "source": { "width": source_w, "height": source_h },
            "encoded": { "width": width, "height": height },
            "origin": { "x": source.origin_x, "y": source.origin_y },
        });

        let pipeline = Arc::new(AtomicBool::new(true));
        let inner = Arc::new(Inner {
            id,
            generation,
            permissions: request.permissions,
            source,
            geometry,
            metrics,
            latest,
            capture_error,
            frame_changes,
            peer: Mutex::new(Some(peer.clone())),
            encoder: Mutex::new(Some(encoder)),
            input: Mutex::new(input),
            indicator: Mutex::new(indicator),
            capture: Mutex::new(Some(capture)),
            layout: Mutex::new(Some(layout)),
            last_seq: Mutex::new(0),
            control_open: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            pipeline: pipeline.clone(),
            events: events.clone(),
            encoded: Mutex::new(None),
            local_frames: request.local_frames,
        });

        inner.notify(SessionEvent::Description {
            generation,
            sdp: offer,
        });
        inner.notify(SessionEvent::State {
            capture: "consented",
            transport: String::from("new"),
            first_frame: false,
        });

        spawn_pipeline(&inner, peer, frame_rx, pipeline, max_fps, bitrate_kbps);
        spawn_peer_events(&inner, peer_events_rx);
        spawn_lease(&inner, request.ttl.unwrap_or(Duration::from_secs(3600)));

        Ok(Self { inner })
    }

    /// Open a session over video the consumer already encoded.
    ///
    /// Nothing is captured, encoded or driven locally: the engine packetizes
    /// what it is fed and sends the client's control messages back to the
    /// consumer, which owns the device. The peer is deliberately absent here —
    /// the offer must name the profile-level-id of the stream's own SPS, and
    /// that only exists once the first access unit arrives.
    async fn open_encoded(
        request: OpenRequest,
        codec: EncodedCodec,
        width: usize,
        height: usize,
        events: tokio_mpsc::UnboundedSender<Notice>,
    ) -> std::result::Result<Self, SessionError> {
        if width == 0 || height == 0 || width > 7680 || height > 4320 {
            return Err(SessionError::new(
                "source",
                format!(
                    "an encoded surface must be 1..7680 by 1..4320 pixels, not {width}x{height}"
                ),
            ));
        }
        let id = opaque_id();
        let generation = 1u64;
        let metrics = Arc::new(Mutex::new(Metrics::default()));
        // Nothing raises it, and nothing waits for it: an encoded source has no
        // frame to read, only an encoded stream to forward.
        let (_frame_signal, frame_changes) = tokio::sync::watch::channel(0u64);
        let (peer_events, peer_events_rx) = tokio_mpsc::unbounded_channel::<PeerEvent>();
        let (feed, feed_rx) = tokio_mpsc::channel::<FedAccessUnit>(FEED_BACKLOG);
        let geometry = serde_json::json!({
            "source": { "width": width, "height": height },
            // Nothing is scaled: the client aims at the stream's own pixels, and
            // the consumer maps them to its device.
            "encoded": { "width": width, "height": height },
            "origin": { "x": 0, "y": 0 },
        });
        let inner = Arc::new(Inner {
            id,
            generation,
            permissions: request.permissions,
            source: SelectedSource {
                node_id: 0,
                width: width as i32,
                height: height as i32,
                position: Some((0, 0)),
                source_type: Some(String::from("encoded")),
                origin_x: 0,
                origin_y: 0,
            },
            geometry,
            metrics,
            latest: Arc::new(Mutex::new(None)),
            capture_error: Arc::new(Mutex::new(None)),
            frame_changes,
            peer: Mutex::new(None),
            encoder: Mutex::new(None),
            input: Mutex::new(None),
            indicator: Mutex::new(None),
            capture: Mutex::new(None),
            layout: Mutex::new(None),
            last_seq: Mutex::new(0),
            control_open: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            pipeline: Arc::new(AtomicBool::new(false)),
            events: events.clone(),
            encoded: Mutex::new(Some(Encoded {
                codec,
                transport: TransportOptions {
                    ice_servers: request.ice_servers,
                    loopback_tcp: request.loopback_tcp,
                    // A device stream is a few megabits; pacing exists to spread
                    // a large frame, not to shape a rate this engine does not set.
                    pace_bps: 20_000_000.0,
                },
                peer_events,
                feed,
            })),
            local_frames: false,
        });
        inner.notify(SessionEvent::State {
            capture: "consented",
            transport: String::from("new"),
            first_frame: false,
        });
        spawn_peer_events(&inner, peer_events_rx);
        spawn_encoded(&inner, feed_rx);
        spawn_lease(&inner, request.ttl.unwrap_or(Duration::from_secs(3600)));
        Ok(Self { inner })
    }

    /// Take one access unit of an encoded source.
    ///
    /// The reply acknowledges the hand-off, not the picture: the unit is
    /// packetized behind this request, and `session.metrics` reports what was
    /// sent and what was dropped.
    pub fn feed(&self, keyframe: bool, data: Vec<u8>) -> std::result::Result<(), SessionError> {
        if self.inner.closed.load(Ordering::Relaxed) {
            return Err(SessionError::new("session", "the session has ended"));
        }
        let encoded = lock(&self.inner.encoded);
        let Some(encoded) = encoded.as_ref() else {
            return Err(SessionError::new(
                "operation",
                "this session has no encoded source to feed",
            ));
        };
        if data.is_empty() {
            return Err(SessionError::new(
                "operation",
                "an access unit cannot be empty",
            ));
        }
        if let Ok(mut m) = self.inner.metrics.lock() {
            m.fed_frames += 1;
        }
        if encoded
            .feed
            .try_send(FedAccessUnit { keyframe, data })
            .is_err()
        {
            if let Ok(mut m) = self.inner.metrics.lock() {
                m.dropped_frames += 1;
            }
        }
        Ok(())
    }

    pub fn id(&self) -> &str {
        &self.inner.id
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    pub fn geometry(&self) -> &serde_json::Value {
        &self.inner.geometry
    }

    pub fn source(&self) -> &SelectedSource {
        &self.inner.source
    }

    pub async fn wait_frame(
        &self,
        after_seq: Option<u64>,
        still_ms: Option<u64>,
        timeout_ms: u64,
    ) -> std::result::Result<(), SessionError> {
        if lock(&self.inner.encoded).is_some() {
            return Err(SessionError::new(
                "operation",
                "this session forwards an encoded stream and keeps no frame",
            ));
        }
        self.keeps_frames()?;
        let mut changes = self.inner.frame_changes.clone();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.min(120_000));
        loop {
            if let Some(reason) = lock(&self.inner.capture_error).clone() {
                return Err(SessionError::new("stream-stopped", reason));
            }
            let (seq, still) = self
                .inner
                .latest
                .lock()
                .ok()
                .and_then(|held| held.as_ref().map(|(seq, at, ..)| (*seq, at.elapsed())))
                .unwrap_or((0, Duration::ZERO));
            let target = still_ms.or(if after_seq.is_none() { Some(150) } else { None });
            let advanced = after_seq.is_none_or(|after| seq > after);
            if seq > 0 && advanced && target.is_none_or(|ms| still >= Duration::from_millis(ms)) {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(SessionError::new(
                    "frame-timeout",
                    "frame condition not met before deadline",
                ));
            }
            let until_still = if seq > 0 && advanced {
                target.map_or(remaining, |ms| {
                    Duration::from_millis(ms).saturating_sub(still)
                })
            } else {
                remaining
            };
            let _ = tokio::time::timeout(remaining.min(until_still), changes.changed()).await;
        }
    }

    fn keeps_frames(&self) -> std::result::Result<(), SessionError> {
        if self.inner.local_frames {
            return Ok(());
        }
        Err(SessionError::new(
            "operation",
            "this session was opened with local_frames off and keeps no frame",
        ))
    }

    /// Write only the requested lossless frame bytes; JSON carries metadata, never pixels.
    pub fn frame(
        &self,
        since: Option<u64>,
        path: &str,
        region: Option<[usize; 4]>,
    ) -> std::result::Result<serde_json::Value, SessionError> {
        if !self.inner.permissions.contains(&Permission::View) {
            return Err(SessionError::new(
                "permission",
                "view permission is required",
            ));
        }
        if lock(&self.inner.encoded).is_some() {
            return Err(SessionError::new(
                "operation",
                "this session forwards an encoded stream and keeps no frame",
            ));
        }
        self.keeps_frames()?;
        if let Some(reason) = lock(&self.inner.capture_error).clone() {
            return Err(SessionError::new("stream-stopped", reason));
        }
        let held = lock(&self.inner.latest);
        let (seq, at, width, height, raw, hashes, previous) = held
            .as_ref()
            .ok_or_else(|| SessionError::new("frame", "the first frame has not arrived"))?;
        let [x, y, w, h] = region.unwrap_or([0, 0, *width, *height]);
        if w == 0
            || h == 0
            || x.checked_add(w).is_none_or(|end| end > *width)
            || y.checked_add(h).is_none_or(|end| end > *height)
        {
            return Err(SessionError::new(
                "coordinates",
                "region exceeds the encoded surface",
            ));
        }
        let damage = if since == Some(*seq) {
            Vec::new()
        } else if since == seq.checked_sub(1) && previous.len() == hashes.len() {
            dirty_regions(hashes, previous, *width, *height)
        } else {
            vec![[0, 0, *width, *height]]
        };
        // An empty path asks for metadata only; no pixels are copied or written.
        let pixels = if path.is_empty() {
            None
        } else {
            let mut pixels = Vec::with_capacity(w * h * 4);
            for row in y..y + h {
                pixels.extend_from_slice(&raw[(row * width + x) * 4..(row * width + x + w) * 4]);
            }
            Some(pixels)
        };
        let result = serde_json::json!({ "seq": seq, "still_ms": at.elapsed().as_millis() as u64,
            "width": w, "height": h, "format": "bgrx", "damage": damage, "written": !path.is_empty() });
        drop(held);
        if let Some(pixels) = pixels {
            std::fs::write(path, pixels)
                .map_err(|error| SessionError::new("frame", error.to_string()))?;
        }
        Ok(result)
    }

    pub fn metrics(&self) -> Metrics {
        self.inner
            .metrics
            .lock()
            .map(|m| m.clone())
            .unwrap_or_default()
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<()> {
        self.current_peer()?
            .accept_answer(sdp)
            .await
            .map(|_applied| ())
    }

    /// The peer for this session, which an encoded source does not have until
    /// its first access unit has named the codec.
    fn current_peer(&self) -> Result<Arc<VideoPeer>> {
        self.inner
            .peer
            .lock()
            .ok()
            .and_then(|peer| peer.clone())
            .ok_or_else(|| anyhow::anyhow!("no offer has been made for this session yet"))
    }

    /// Restart ICE: a fresh offer on the same peer, announced as a new
    /// `session.description` event for the client to answer as usual.
    pub async fn restart_ice(&self) -> Result<()> {
        let offer = self.current_peer()?.restart_ice().await?;
        self.inner.notify(SessionEvent::Description {
            generation: self.inner.generation,
            sdp: offer,
        });
        Ok(())
    }

    pub async fn add_candidate(
        &self,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> Result<()> {
        self.current_peer()?
            .add_candidate(candidate, sdp_mid, sdp_m_line_index)
            .await
    }

    /// Read the desktop clipboard for the consumer. Explicit, never polled.
    pub async fn read_clipboard(&self) -> std::result::Result<(String, bool), String> {
        if let Some((_, reason)) = self.inner.clipboard_refusal() {
            return Err(reason.to_owned());
        }
        clipboard_task(move || clipboard::read_or_explain()).await
    }

    pub async fn write_clipboard(&self, text: String) -> std::result::Result<(), String> {
        if let Some((_, reason)) = self.inner.clipboard_refusal() {
            return Err(reason.to_owned());
        }
        clipboard_task(move || {
            clipboard::write(&text)
                .map(|()| String::new())
                .map_err(|error| format!("{error:#}"))
        })
        .await
        .map(|_written| ())
    }

    pub fn mark_closed_reason(&self) -> Option<String> {
        self.inner.revoked_reason()
    }

    /// The source kind this session captures, e.g. `monitor`.
    pub fn restore_source(&self) -> String {
        self.inner
            .source
            .source_type
            .clone()
            .unwrap_or_else(|| String::from("monitor"))
    }

    pub async fn close(&self, reason: &str) {
        self.inner.close(reason, "closed").await;
    }
}

impl Inner {
    /// Send one notification, stamped with the session it belongs to.
    fn notify(&self, event: SessionEvent) {
        let _ = self.events.send(Notice {
            session_id: self.id.clone(),
            event,
        });
    }

    /// Stop everything and release whatever input this session held. Idempotent,
    /// and the one teardown both an explicit close and a lease expiry take.
    async fn close(&self, reason: &str, code: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.control_open.store(false, Ordering::SeqCst);
        self.pipeline.store(false, Ordering::SeqCst);
        drop(lock(&self.encoded).take());
        if let Ok(mut indicator) = self.indicator.lock() {
            indicator.take();
        }
        // Release first, then tear down: a stuck modifier is the one failure the
        // user cannot undo by reconnecting.
        if let Ok(mut input) = self.input.lock() {
            if let Some(target) = input.as_mut() {
                let _ = target.release_all();
            }
            *input = None;
        }
        if let Some(peer) = self.peer.lock().ok().and_then(|peer| peer.clone()) {
            let _ = peer
                .send_control(
                    &serde_json::to_string(&ControlReply::Revoked { reason, code }).unwrap_or_else(
                        |_| String::from(r#"{"kind":"revoked","reason":"closed","code":"closed"}"#),
                    ),
                )
                .await;
            peer.close().await;
        }
        // Dropping the capture stops the PipeWire stream and joins its thread,
        // which is what releases the compositor's consent for this session. It
        // has to happen synchronously, not when the last handle happens to fall
        // out of scope, so the consumer can truthfully say the desktop stopped.
        let capture = self.capture.lock().ok().and_then(|mut held| held.take());
        drop(capture);
        self.notify(SessionEvent::State {
            capture: "ended",
            transport: String::from("closed"),
            first_frame: false,
        });
    }

    fn revoked_reason(&self) -> Option<String> {
        if self.closed.load(Ordering::Relaxed) {
            Some(String::from("session closed"))
        } else {
            None
        }
    }

    fn has(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    fn clipboard_refusal(&self) -> Option<(&'static str, &'static str)> {
        if matches!(
            self.source.source_type.as_deref(),
            Some("x11-root") | Some("encoded")
        ) || !wayland_clipboard_available()
        {
            return Some((
                "clipboard-unsupported",
                "clipboard is unavailable for this desktop source",
            ));
        }
        if !self.has(Permission::Clipboard) {
            return Some(("permission", "this session has no clipboard permission"));
        }
        None
    }

    fn reject(&self, seq: u64, code: &'static str, message: &str) {
        if let Ok(mut m) = self.metrics.lock() {
            m.input_rejected += 1;
        }
        let payload = ControlReply::Rejected { seq, code, message };
        let _ = self.reply(&payload);
    }

    fn reply(&self, payload: &ControlReply<'_>) -> Result<()> {
        let text = serde_json::to_string(payload)?;
        let Some(peer) = self.peer.lock().ok().and_then(|peer| peer.clone()) else {
            // An encoded source has no peer until its first access unit, so a
            // rejection raised before then has nowhere to go; the request that
            // caused it is refused in the same breath.
            return Ok(());
        };
        // The channel is asynchronous; a failure here means the peer is gone,
        // which the connection-state handler closes anyway.
        tokio::spawn(async move {
            let _ = peer.send_control(&text).await;
        });
        Ok(())
    }

    /// Admit one client action. Validation, permission and ordering checks all
    /// happen before any physical effect, so a refused action leaves the desktop
    /// exactly as it was.
    fn apply(self: &Arc<Self>, message: ControlMessage) {
        let seq = message.seq();
        if self.closed.load(Ordering::Relaxed) {
            self.reject(seq, "session", "the session has ended");
            return;
        }
        if !self.control_open.load(Ordering::Relaxed) {
            self.reject(seq, "session", "the control channel is not open");
            return;
        }
        if !self.has(Permission::Control) {
            self.reject(seq, "permission", "this session is view-only");
            return;
        }
        if seq != 0 {
            let mut last = match self.last_seq.lock() {
                Ok(last) => last,
                Err(_) => return,
            };
            if seq <= *last {
                drop(last);
                self.reject(seq, "input-replay", "sequence already applied");
                return;
            }
            *last = seq;
        }
        let feedback = match &message {
            ControlMessage::Pointer { phase, x, y, .. } if lock(&self.encoded).is_none() => {
                let (x, y) = to_source_pixels(*x, *y, self.encoded_size(), &self.source);
                Some((
                    if matches!(phase, PointerPhase::Down) {
                        'C'
                    } else {
                        'M'
                    },
                    x,
                    y,
                ))
            }
            ControlMessage::Text { text, .. } if !text.is_empty() => Some(('T', -1, -1)),
            ControlMessage::Key { down: true, .. } => Some(('T', -1, -1)),
            _ => None,
        };
        // A source the consumer feeds is a device the consumer drives. Nothing is
        // applied to this machine: the message travels back as an event, and the
        // consumer injects it where the picture actually came from.
        if lock(&self.encoded).is_some() {
            self.forward(message);
            return;
        }
        let outcome = match message {
            ControlMessage::Pointer {
                phase,
                x,
                y,
                button,
                ..
            } => self.pointer(phase, x, y, button, seq),
            ControlMessage::Wheel { dx, dy, .. } => self.wheel(dx, dy, seq),
            ControlMessage::Key {
                name,
                character,
                down,
                modifiers,
                ..
            } => self.key(name, character, down, modifiers, seq),
            ControlMessage::Text { text, .. } => self.text(&text, seq),
            ControlMessage::ReleaseAll { .. } => {
                if let Ok(mut input) = self.input.lock() {
                    if let Some(target) = input.as_mut() {
                        let _ = target.release_all();
                    }
                }
                Ok(())
            }
            ControlMessage::ClipboardRead { request, .. } => {
                self.clipboard_read(request);
                return;
            }
            ControlMessage::ClipboardWrite { request, text, .. } => {
                self.clipboard_write(request, text);
                return;
            }
        };
        match outcome {
            Ok(()) => {
                if let Some((kind, x, y)) = feedback {
                    if let Ok(mut indicator) = self.indicator.lock() {
                        if let Some(indicator) = indicator.as_mut() {
                            indicator.event(kind, x, y);
                        }
                    }
                }
                if let Ok(mut m) = self.metrics.lock() {
                    m.input_applied += 1;
                }
                let _ = self.reply(&ControlReply::Ack { seq });
            }
            Err((code, message)) => self.reject(seq, code, &message),
        }
    }

    /// Hand one client action back to the consumer, which owns the device this
    /// stream came from. The audit trail is the event itself and the count in
    /// `session.metrics`; nothing was applied here.
    fn forward(&self, message: ControlMessage) {
        let seq = message.seq();
        // The clipboard belongs to the device the consumer drives, and this
        // engine has none for this source; saying so is better than a request
        // that never answers.
        match &message {
            ControlMessage::ClipboardRead { request, .. }
            | ControlMessage::ClipboardWrite { request, .. } => {
                let _ = self.reply(&ControlReply::Clipboard {
                    request,
                    text: String::new(),
                    truncated: false,
                    error: Some("this source's clipboard belongs to the consumer"),
                });
                return;
            }
            _ => {}
        }
        let input = match serde_json::to_value(&message) {
            Ok(input) => input,
            Err(_) => {
                self.reject(seq, "operation", "unrecognised control message");
                return;
            }
        };
        self.notify(SessionEvent::Input { input });
        if let Ok(mut m) = self.metrics.lock() {
            m.input_forwarded += 1;
        }
        let _ = self.reply(&ControlReply::Ack { seq });
    }

    fn with_input<T>(
        &self,
        action: impl FnOnce(&mut InputTarget) -> Result<T>,
    ) -> std::result::Result<T, (&'static str, String)> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| ("session", String::from("the input device is unavailable")))?;
        match input.as_mut() {
            Some(target) => action(target).map_err(|error| ("input", format!("{error:#}"))),
            None => Err(("input-unavailable", String::from("no input backend"))),
        }
    }

    fn pointer(
        &self,
        phase: PointerPhase,
        x: i64,
        y: i64,
        button: i64,
        _seq: u64,
    ) -> std::result::Result<(), (&'static str, String)> {
        let (width, height) = self.encoded_size();
        if !(0..width as i64).contains(&x) || !(0..height as i64).contains(&y) {
            return Err((
                "coordinates",
                format!("({x},{y}) is outside the {width}x{height} surface"),
            ));
        }
        // The client sends the encoded surface's own pixels; the applier is
        // created for, and clamps to, the source's own pixels. One conversion
        // here keeps every caller honest.
        let (x, y) = to_source_pixels(x, y, (width, height), &self.source);
        self.with_input(|target| match phase {
            PointerPhase::Move => target.move_absolute(x, y),
            PointerPhase::Down => {
                target.move_absolute(x, y)?;
                target.button(Button::from_number(button), true)
            }
            PointerPhase::Up => {
                target.move_absolute(x, y)?;
                target.button(Button::from_number(button), false)
            }
            PointerPhase::Cancel => target.release_all(),
        })
    }

    fn wheel(
        &self,
        dx: f64,
        dy: f64,
        _seq: u64,
    ) -> std::result::Result<(), (&'static str, String)> {
        if !dx.is_finite() || !dy.is_finite() || dx.abs() > 100.0 || dy.abs() > 100.0 {
            return Err(("coordinates", String::from("scroll delta is out of range")));
        }
        self.with_input(|target| target.scroll(dx, dy))
    }

    fn key(
        &self,
        name: Option<String>,
        character: Option<String>,
        down: bool,
        modifiers: Vec<String>,
        _seq: u64,
    ) -> std::result::Result<(), (&'static str, String)> {
        // A named modifier is applied directly: it is the same key the user
        // would press, and it does not depend on the layout.
        if let Some(name) = &name {
            if let Some(code) = keymap::modifier_key(name) {
                return self.with_input(|target| target.modifier(code, down, true));
            }
        }

        let stroke = {
            let held = self
                .layout
                .lock()
                .map_err(|_| ("session", String::from("no keyboard layout")))?;
            let layout = held
                .as_ref()
                .ok_or(("session", String::from("no keyboard layout")))?;
            if let Some(name) = name {
                keymap::named_key(&name)
                    .ok_or(("text-unsupported", format!("unknown key {name}")))?
            } else if let Some(character) = character {
                let mut characters = character.chars();
                let wanted = characters
                    .next()
                    .ok_or(("text-unsupported", String::from("empty character")))?;
                if characters.next().is_some() {
                    return Err((
                        "text-unsupported",
                        String::from("character must contain exactly one Unicode scalar"),
                    ));
                }
                layout.keystroke_for_char(wanted).ok_or((
                    "text-unsupported",
                    format!("the active layout cannot produce {wanted:?}"),
                ))?
            } else {
                return Err(("text-unsupported", String::from("no key given")));
            }
        };

        // Explicitly requested modifiers travel with this key only.
        let mut requested: Vec<i16> = modifiers
            .iter()
            .filter_map(|name| keymap::modifier_key(name))
            .collect();
        requested.extend(stroke.modifiers());
        requested.sort_unstable();
        requested.dedup();

        self.with_input(|target| target.chord(stroke.code, requested, down))
    }

    fn text(&self, text: &str, seq: u64) -> std::result::Result<(), (&'static str, String)> {
        if text.len() > 4096 {
            return Err(("text-too-large", String::from("text exceeds 4096 bytes")));
        }
        #[cfg(target_os = "macos")]
        {
            let _ = seq;
            return self.with_input(|target| target.unicode_text(text));
        }
        #[cfg(target_os = "linux")]
        {
            let held = self
                .layout
                .lock()
                .map_err(|_| ("session", String::from("no keyboard layout")))?;
            let layout = held
                .as_ref()
                .ok_or(("session", String::from("no keyboard layout")))?;
            let (plan, unreachable) = layout.plan_text(text);
            drop(held);
            if !unreachable.is_empty() {
                return Err((
                    "text-unsupported",
                    format!("the active layout cannot produce {unreachable:?}; use the clipboard"),
                ));
            }
            let _ = seq;
            self.with_input(|target| {
                // Uinput's immediate down/up pairs can be collapsed by a compositor's
                // event loop. XTest flushes each edge, so pace only the virtual device.
                let paced = matches!(&target.applier, Applier::Uinput(_));
                let pause = || {
                    if paced {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                };
                target.check_keys(
                    plan.iter()
                        .flatten()
                        .flat_map(|stroke| std::iter::once(stroke.code).chain(stroke.modifiers())),
                )?;
                for keystroke in plan {
                    for stroke in keystroke {
                        let modifiers = stroke.modifiers();
                        for modifier in &modifiers {
                            target.modifier(*modifier, true, false)?;
                            pause();
                        }
                        target.key(stroke.code, true)?;
                        pause();
                        target.key(stroke.code, false)?;
                        pause();
                        for modifier in modifiers.iter().rev() {
                            target.modifier(*modifier, false, false)?;
                            pause();
                        }
                    }
                }
                Ok(())
            })
        }
    }

    fn clipboard_read(self: &Arc<Self>, request: String) {
        if let Some((code, reason)) = self.clipboard_refusal() {
            self.reject(0, code, reason);
            return;
        }
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let (text, truncated, error) = match clipboard_task(clipboard::read_or_explain).await {
                Ok((text, truncated)) => (text, truncated, None),
                Err(reason) => (String::new(), false, Some(reason)),
            };
            let _ = inner.reply(&ControlReply::Clipboard {
                request: &request,
                text,
                truncated,
                error: error.as_deref(),
            });
        });
    }

    fn clipboard_write(self: &Arc<Self>, request: String, text: String) {
        if let Some((code, reason)) = self.clipboard_refusal() {
            self.reject(0, code, reason);
            return;
        }
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let error = clipboard_task(move || {
                clipboard::write(&text)
                    .map(|()| String::new())
                    .map_err(|error| format!("{error:#}"))
            })
            .await
            .err();
            let _ = inner.reply(&ControlReply::Clipboard {
                request: &request,
                text: String::new(),
                truncated: false,
                error: error.as_deref(),
            });
        });
    }

    fn encoded_size(&self) -> (usize, usize) {
        let encoded = &self.geometry["encoded"];
        (
            encoded["width"].as_u64().unwrap_or(0) as usize,
            encoded["height"].as_u64().unwrap_or(0) as usize,
        )
    }
}

/// The interval between frames at `max_fps`. The requested rate is a cap, so the
/// pipeline and the X11 capture loop derive their cadence from the same rule.
fn frame_interval(max_fps: u32) -> Duration {
    Duration::from_secs_f64(1.0 / max_fps.max(1) as f64)
}

/// The newest captured frame and when it was captured, handed from the capture
/// thread to the encoder. A newer frame replaces one the encoder has not taken,
/// so however far behind it falls, what it codes next is the desktop as it is
/// now. The instant travels with the picture so the pipeline can report how
/// long a coded frame waited for its encode.
struct FrameSlot {
    frame: Mutex<(Option<(I420, Instant)>, bool)>,
    ready: Condvar,
}

struct FrameSender(Arc<FrameSlot>);
struct FrameReceiver(Arc<FrameSlot>);

fn latest_frame() -> (FrameSender, FrameReceiver) {
    let slot = Arc::new(FrameSlot {
        frame: Mutex::new((None, false)),
        ready: Condvar::new(),
    });
    (FrameSender(slot.clone()), FrameReceiver(slot))
}

impl FrameSender {
    /// Hand over a frame; true when it replaced one the encoder never took.
    fn put(&self, frame: I420, captured: Instant) -> bool {
        let mut held = self
            .0
            .frame
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let replaced = held.0.replace((frame, captured)).is_some();
        self.0.ready.notify_one();
        replaced
    }
}

impl Drop for FrameSender {
    /// The capture stopped: the encoder ends once it has taken what is left.
    fn drop(&mut self) {
        let mut held = self
            .0
            .frame
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        held.1 = true;
        self.0.ready.notify_one();
    }
}

enum Taken {
    Frame(I420, Instant),
    Timeout,
    Ended,
}

impl FrameReceiver {
    /// Whether a frame is waiting to be taken.
    fn waiting(&self) -> bool {
        self.0
            .frame
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0
            .is_some()
    }

    fn take(&self, wait: Duration) -> Taken {
        let held = self
            .0
            .frame
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (mut held, _) = self
            .0
            .ready
            .wait_timeout_while(held, wait, |(frame, ended)| frame.is_none() && !*ended)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match held.0.take() {
            Some((frame, captured)) => Taken::Frame(frame, captured),
            None if held.1 => Taken::Ended,
            None => Taken::Timeout,
        }
    }
}

/// How long the desktop has to stay still before its last frame is refined.
/// Long enough that a pause between keystrokes does not pay for a refinement
/// the next key makes stale; short enough that reading does not wait for it.
const REFINE_AFTER: Duration = Duration::from_millis(150);

/// The longest the stream goes without a frame while the desktop is still. A
/// WebRTC receiver that has had no decodable frame for a few seconds asks for
/// a key frame (a 4K one is hundreds of kilobytes), then asks again after the
/// next quiet spell. An unchanged frame costs a few hundred bytes and keeps it
/// satisfied.
const KEEPALIVE_AFTER: Duration = Duration::from_millis(1000);

/// The rate target for a surface when the consumer did not choose one: enough
/// for a scroll across a full 4K desktop to stay legible. A still desktop costs
/// almost nothing whatever this says.
fn auto_bitrate(width: usize, height: usize) -> u32 {
    (1500 + (width * height * 18 / 10_000) as u32).min(25_000)
}

/// Queueing delay that means the link carries more than it drains: well under
/// the latency budget, well over the noise of a busy host's scheduling.
const QUEUE_HIGH: Duration = Duration::from_millis(25);
/// Below this the path has room again and the target may creep back up.
const QUEUE_LOW: Duration = Duration::from_millis(10);
/// How often queueing delay may back the target off: long enough for the last
/// back-off to reach the far end and show in its feedback, short enough that a
/// queue is drained in a few steps rather than a few seconds.
const DELAY_BACKOFF_EVERY: Duration = Duration::from_millis(300);

/// The rate target: back off when the far end reports a standing queue or
/// loss, creep back when it reports neither, never above what the session
/// asked for.
///
/// Delay leads. A link with a deep buffer (most Wi-Fi and cellular ones) never
/// loses a packet it can queue, so loss alone lets queueing delay grow to
/// seconds before anything reacts. A standing queue backs the target off to
/// 85% of what the path delivered, which drains it; never more than halving
/// per step, so a stream that was idle and sent little is not taken for a
/// slow link. Receivers without transport-wide feedback leave it loss-only.
struct RateControl {
    ceiling: u32,
    target: u32,
    last_change: Option<Instant>,
    /// The last queueing delay reported, while the path reports one.
    queue: Option<Duration>,
}

impl RateControl {
    fn new(ceiling: u32) -> Self {
        Self {
            ceiling,
            target: ceiling,
            last_change: None,
            queue: None,
        }
    }

    /// The new target when these loss reports (RFC 3550 fractions, /256) or
    /// this path report move it: down on a standing queue at most every
    /// `DELAY_BACKOFF_EVERY`, otherwise at most once a second.
    fn update(&mut self, reports: &[u8], path: Option<PathReport>, now: Instant) -> Option<u32> {
        if let Some(path) = path {
            self.queue = Some(path.queue_delay);
        }
        let since = self.last_change.map(|at| now.duration_since(at));
        let waited = |gap: Duration| since.is_none_or(|since| since >= gap);
        let floor = (self.ceiling / 8).max(500);
        let next = if let Some(path) = path.filter(|path| path.queue_delay > QUEUE_HIGH) {
            if !waited(DELAY_BACKOFF_EVERY) {
                return None;
            }
            let delivered = path.delivered_kbps.clamp(self.target / 2, self.target);
            ((delivered as f64 * 0.85) as u32).max(floor)
        } else {
            let worst = *reports.iter().max()?;
            if !waited(Duration::from_secs(1)) {
                return None;
            }
            let loss = worst as f64 / 256.0;
            let roomy = self.queue.is_none_or(|queue| queue < QUEUE_LOW);
            if loss > 0.10 {
                ((self.target as f64 * 0.7) as u32).max(floor)
            } else if loss < 0.02 && roomy {
                ((self.target as f64 * 1.08) as u32 + 64).min(self.ceiling)
            } else {
                self.target
            }
        };
        if next == self.target {
            return None;
        }
        self.target = next;
        self.last_change = Some(now);
        Some(next)
    }
}

/// How far the stream may run ahead of its rate target before the next frame
/// waits: one large frame (a key frame, a refinement) goes at once, but the
/// frames behind it hold until the link has had time to carry it, instead of
/// queueing behind it. The frame that goes then is the newest one.
const FRAME_BURST: Duration = Duration::from_millis(60);

/// How much faster than the target the budget drains. A rate-controlled
/// encoder averages its target but overshoots it frame to frame; drained at
/// the target itself, that ordinary overshoot would add up and hold frames on
/// a link with room to spare. The rate control, not this, keeps the average
/// under what the path carries.
const BUDGET_HEADROOM: f64 = 1.25;

/// What has been sent beyond the rate target, draining a little faster than
/// it: a leaky bucket that bounds a burst to `FRAME_BURST` plus one frame.
#[derive(Default)]
struct SendBudget {
    bits: f64,
    at: Option<Instant>,
}

impl SendBudget {
    /// The drain rate, in bits per second.
    fn rate(kbps: u32) -> f64 {
        kbps.max(1) as f64 * 1000.0 * BUDGET_HEADROOM
    }

    fn drained(&self, now: Instant, kbps: u32) -> f64 {
        let elapsed = self
            .at
            .map_or(0.0, |at| now.saturating_duration_since(at).as_secs_f64());
        (self.bits - elapsed * Self::rate(kbps)).max(0.0)
    }

    /// How long until a frame may go; zero when it may go now.
    fn wait(&self, now: Instant, kbps: u32) -> Duration {
        let rate = Self::rate(kbps);
        let over = self.drained(now, kbps) - FRAME_BURST.as_secs_f64() * rate;
        Duration::from_secs_f64((over / rate).max(0.0))
    }

    fn sent(&mut self, now: Instant, bytes: usize, kbps: u32) {
        self.bits = self.drained(now, kbps) + bytes as f64 * 8.0;
        self.at = Some(now);
    }
}

/// Whether motion is coded at half size. A full-size frame is slow when it
/// took longer to code than a frame interval and the source already had a
/// newer frame waiting: the encoder, not the source, set the pace. Content that
/// arrives slower than the frame cap (30 fps into a 60 fps session) is never
/// slow however long a frame takes, as long as it is done before the next one.
/// Several slow frames that each change much of the picture (a packet over a
/// quarter of the per-frame rate budget) mean full size cannot reach the frame
/// rate, so the rest of the motion is coded at half size, until it stops (the
/// refinement pass is always full size) or a run of frames that are both small
/// and not slow shows full size would keep up again. Packet size or coding time
/// alone never returns it to full size, so heavy motion does not flap between
/// sizes; each change costs a key frame. Both directions need a run of frames
/// rather than one, so a slow key frame or a busy moment on the host does not
/// flip it, and typing never halves.
#[derive(Default)]
struct MotionSize {
    half: bool,
    run: u32,
}

impl MotionSize {
    const SLOW_RUN: u32 = 5;
    const SMALL_RUN: u32 = 30;

    /// Account for a motion frame coded at the current size in `took`; `large`
    /// when its packet was over a quarter of the per-frame rate budget, `behind`
    /// when a newer frame was already waiting once it was coded.
    fn coded(&mut self, took: Duration, large: bool, behind: bool, interval: Duration) {
        let slow = took > interval && behind;
        let (counts, needed) = if self.half {
            (!large && !slow, Self::SMALL_RUN)
        } else {
            (large && slow, Self::SLOW_RUN)
        };
        self.run = if counts { self.run + 1 } else { 0 };
        if self.run >= needed {
            self.half = !self.half;
            self.run = 0;
        }
    }
}

/// The rate cap as a deadline rather than a minimum gap. `due` is where the
/// next frame falls on the `max_fps` cadence the stream has kept so far, and a
/// frame may go up to one interval before it, so a late frame's lost time is
/// made up by the next. A capture clock that jitters around the cap is then
/// coded the moment each frame arrives, instead of beating against a second
/// clock that delays a frame or lets the next one supersede it; the sustained
/// rate still never exceeds the cap, and no window holds more than one frame
/// over it.
struct Cadence {
    interval: Duration,
    due: Instant,
}

impl Cadence {
    fn new(interval: Duration, now: Instant) -> Self {
        Self { interval, due: now }
    }

    /// How long until a frame may go; zero when it may go now.
    fn wait(&self, now: Instant) -> Duration {
        self.due.saturating_duration_since(now + self.interval)
    }

    fn sent(&mut self, now: Instant) {
        self.due = self.due.max(now) + self.interval;
    }
}

enum Pass {
    Motion {
        keyframe: bool,
        half: bool,
    },
    Refine,
    /// The same picture again, so a still stream never looks stalled.
    Keepalive,
}

/// Encode and send frames off the async runtime: libvpx blocks for the duration
/// of a frame and the send is asynchronous, so a plain thread driving the
/// runtime handle keeps both honest.
///
/// PipeWire delivers a frame only when the desktop changes. Every frame that
/// arrives is either coded or superseded by a newer one within one frame
/// interval, so the phone never shows a state older than the desktop's; the
/// rate cap delays a frame rather than dropping the last one of a burst. When
/// the desktop goes still the last frame is coded once more, sharp.
fn spawn_pipeline(
    inner: &Arc<Inner>,
    peer: Arc<VideoPeer>,
    frame_rx: FrameReceiver,
    running: Arc<AtomicBool>,
    max_fps: u32,
    bitrate_kbps: u32,
) {
    let inner = inner.clone();
    let handle = tokio::runtime::Handle::current();
    std::thread::Builder::new()
        .name("desklink-encode".into())
        .spawn(move || {
            let interval = frame_interval(max_fps);
            let mut rate = RateControl::new(bitrate_kbps);
            if let Ok(mut m) = inner.metrics.lock() {
                m.target_kbps = bitrate_kbps;
            }
            let mut latest: Option<(I420, Instant)> = None;
            // `pending`: the latest frame has not been coded. `refined`: it has
            // had its refinement pass, or there is nothing to refine.
            let mut pending = false;
            let mut refined = true;
            let mut keyframe = true;
            let mut still_since = Instant::now();
            let mut last_sent: Option<Instant> = None;
            let mut size = MotionSize::default();
            let mut cadence = Cadence::new(interval, Instant::now());
            let mut budget = SendBudget::default();
            // What the last frame was stamped with: the RTP clock never runs
            // backwards, even for a re-coded picture.
            let mut last_stamp: Option<Instant> = None;
            loop {
                let now = Instant::now();
                let slot = cadence.wait(now).max(budget.wait(now, rate.target));
                let connected = peer.is_connected();
                let wait = if !connected {
                    // Nothing sent before the transport connects arrives; the
                    // first frame after it is a key frame.
                    Duration::from_millis(50)
                } else if pending {
                    slot
                } else if !refined {
                    REFINE_AFTER
                        .saturating_sub(now.duration_since(still_since))
                        .max(slot)
                } else {
                    last_sent
                        .map_or(Duration::from_millis(100), |at| {
                            KEEPALIVE_AFTER.saturating_sub(now.duration_since(at))
                        })
                        .clamp(Duration::from_millis(10), Duration::from_millis(100))
                };
                match frame_rx.take(wait) {
                    Taken::Frame(frame, captured) => {
                        if pending {
                            if let Ok(mut m) = inner.metrics.lock() {
                                m.dropped_frames += 1;
                            }
                        }
                        latest = Some((frame, captured));
                        pending = true;
                        refined = false;
                        still_since = Instant::now();
                    }
                    Taken::Timeout => {}
                    Taken::Ended => break,
                }
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                if peer.take_keyframe_request() || !connected {
                    keyframe = true;
                }
                let reports = peer.take_loss_reports();
                let path = peer.take_path_report();
                if let Some(kbps) = rate.update(&reports, path, Instant::now()) {
                    let applied = inner.encoder.lock().map(|mut encoder| {
                        encoder
                            .as_mut()
                            .map(|encoder| encoder.set_bitrate(kbps))
                            .unwrap_or(Ok(()))
                    });
                    if matches!(applied, Ok(Ok(()))) {
                        if let Ok(mut m) = inner.metrics.lock() {
                            m.target_kbps = kbps;
                        }
                    }
                }
                let Some((frame, captured)) = latest.as_ref() else {
                    continue;
                };
                if !connected {
                    continue;
                }
                let now = Instant::now();
                if !cadence.wait(now).is_zero() || !budget.wait(now, rate.target).is_zero() {
                    continue;
                }
                let pass = if pending || keyframe {
                    Pass::Motion {
                        keyframe,
                        half: size.half,
                    }
                } else if !refined && now.duration_since(still_since) >= REFINE_AFTER {
                    Pass::Refine
                } else if refined
                    && last_sent.is_some_and(|at| now.duration_since(at) >= KEEPALIVE_AFTER)
                {
                    Pass::Keepalive
                } else {
                    continue;
                };

                let started = Instant::now();
                let packet = {
                    let mut held = match inner.encoder.lock() {
                        Ok(held) => held,
                        Err(_) => break,
                    };
                    let Some(encoder) = held.as_mut() else {
                        break;
                    };
                    match pass {
                        Pass::Motion { keyframe, half } => encoder.encode(frame, keyframe, half),
                        Pass::Refine => encoder.refine(frame),
                        Pass::Keepalive => encoder.encode(frame, false, false),
                    }
                };
                let packet = match packet {
                    Ok(packet) => packet,
                    Err(error) => {
                        if let Ok(mut m) = inner.metrics.lock() {
                            m.dropped_frames += 1;
                        }
                        // The encoder refusing a frame means it is not the size
                        // it was built for, or libvpx rejected it. Both leave a
                        // permanently black desktop, so end the session instead
                        // of dropping frames in silence; the client turns this
                        // reason into what it shows the user.
                        eprintln!("the encoder rejected a frame: {error:#}");
                        let reason = String::from("the encoder rejected a frame");
                        inner.notify(SessionEvent::Revoked {
                            reason: reason.clone(),
                            code: "error",
                        });
                        let target = inner.clone();
                        handle.spawn(async move {
                            target.close(&reason, "error").await;
                        });
                        break;
                    }
                };
                let took = started.elapsed();
                if let Ok(mut m) = inner.metrics.lock() {
                    m.encoded_frames += 1;
                    m.encoded_bytes += packet.data.len() as u64;
                    m.encode_micros += took.as_micros() as u64;
                    m.key_frames += packet.keyframe as u64;
                    if matches!(pass, Pass::Motion { .. }) && pending {
                        m.queue_micros += started.duration_since(*captured).as_micros() as u64;
                        m.motion_frames += 1;
                    }
                    match pass {
                        Pass::Motion { half: true, .. } => m.halved_frames += 1,
                        Pass::Refine => m.refined_frames += 1,
                        Pass::Motion { half: false, .. } | Pass::Keepalive => {}
                    }
                }
                match pass {
                    Pass::Motion { .. } => {
                        pending = false;
                        keyframe = false;
                        refined = false;
                        still_since = now;
                        let budget = rate.target as u64 * 1000 / 8 / max_fps.max(1) as u64;
                        let large = packet.data.len() as u64 * 4 > budget;
                        size.coded(took, large, frame_rx.waiting(), interval);
                    }
                    Pass::Refine => {
                        refined = true;
                        size = MotionSize::default();
                    }
                    Pass::Keepalive => {}
                }
                last_sent = Some(now);
                cadence.sent(now);
                budget.sent(now, packet.data.len(), rate.target);
                // A new picture carries the moment it was captured, so the
                // receiver paces playout by the desktop's clock rather than by
                // encode time; a re-coded one (refinement, keepalive) is new
                // content now.
                let stamp = match pass {
                    Pass::Motion { .. } => *captured,
                    Pass::Refine | Pass::Keepalive => now,
                };
                let stamp = last_stamp.map_or(stamp, |at| stamp.max(at + Duration::from_millis(1)));
                last_stamp = Some(stamp);
                let sending = Instant::now();
                if let Err(error) =
                    handle.block_on(peer.send_frame(&packet.data, packet.keyframe, stamp))
                {
                    // The transport is gone. End the session rather than leave
                    // the desktop captured behind a picture that stopped.
                    eprintln!("the video track refused an encoded frame: {error:#}");
                    let reason = String::from("the connection to the phone was lost");
                    inner.notify(SessionEvent::Revoked {
                        reason: reason.clone(),
                        code: "transport",
                    });
                    let target = inner.clone();
                    handle.spawn(async move {
                        target.close(&reason, "transport").await;
                    });
                    break;
                }
                if let Ok(mut m) = inner.metrics.lock() {
                    m.send_micros += sending.elapsed().as_micros() as u64;
                }
            }
        })
        .ok();
}

/// Packetize what a consumer feeds an encoded source, building the peer on the
/// first access unit that carries an SPS.
///
/// That order is forced by the contract: the offer must name the profile the
/// stream actually is, and the only place that is written down is the stream's
/// own SPS. Until one arrives there is nothing that could be offered.
fn spawn_encoded(inner: &Arc<Inner>, mut feed: tokio_mpsc::Receiver<FedAccessUnit>) {
    let inner = inner.clone();
    tokio::spawn(async move {
        while let Some(unit) = feed.recv().await {
            if inner.closed.load(Ordering::SeqCst) {
                return;
            }
            if current_peer(&inner).is_none() {
                let Some(profile) = h264_profile_level_id(&unit.data) else {
                    if let Ok(mut m) = inner.metrics.lock() {
                        m.dropped_frames += 1;
                    }
                    continue;
                };
                let (transport, peer_events, codec) = {
                    let encoded = lock(&inner.encoded);
                    let Some(encoded) = encoded.as_ref() else {
                        return;
                    };
                    let codec = match encoded.codec {
                        EncodedCodec::H264 => VideoCodec::H264 {
                            profile_level_id: profile,
                        },
                    };
                    (
                        encoded.transport.clone(),
                        encoded.peer_events.clone(),
                        codec,
                    )
                };
                let offered = VideoPeer::offer(transport, peer_events, codec).await;
                match offered {
                    Ok((peer, offer)) => {
                        let peer = Arc::new(peer);
                        let stored = {
                            let mut held = lock(&inner.peer);
                            if inner.closed.load(Ordering::SeqCst) {
                                false
                            } else {
                                *held = Some(peer.clone());
                                true
                            }
                        };
                        if !stored {
                            peer.close().await;
                            return;
                        }
                        inner.notify(SessionEvent::Description {
                            generation: inner.generation,
                            sdp: offer,
                        });
                    }
                    Err(error) => {
                        revoke(
                            &inner,
                            format!("the transport refused the encoded stream: {error:#}"),
                            "error",
                        )
                        .await;
                        return;
                    }
                }
            }
            let Some(peer) = current_peer(&inner) else {
                return;
            };
            let started = Instant::now();
            let sent = peer.send_frame(&unit.data, unit.keyframe, started).await;
            match sent {
                Ok(()) => {
                    if let Ok(mut m) = inner.metrics.lock() {
                        m.encoded_frames += 1;
                        m.encoded_bytes += unit.data.len() as u64;
                        m.encode_micros += started.elapsed().as_micros() as u64;
                        if unit.keyframe {
                            m.key_frames += 1;
                        }
                    }
                }
                Err(error) => {
                    eprintln!("the video track refused a fed access unit: {error:#}");
                    revoke(
                        &inner,
                        String::from("the connection to the phone was lost"),
                        "transport",
                    )
                    .await;
                    return;
                }
            }
        }
    });
}

fn current_peer(inner: &Arc<Inner>) -> Option<Arc<VideoPeer>> {
    inner.peer.lock().ok().and_then(|peer| peer.clone())
}

/// End the session with a reason the consumer can show, exactly as the encode
/// pipeline does when its transport goes away.
async fn revoke(inner: &Arc<Inner>, reason: String, code: &'static str) {
    inner.notify(SessionEvent::Revoked {
        reason: reason.clone(),
        code,
    });
    inner.close(&reason, code).await;
}

fn spawn_peer_events(inner: &Arc<Inner>, mut events: tokio_mpsc::UnboundedReceiver<PeerEvent>) {
    let inner = inner.clone();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if inner.closed.load(Ordering::SeqCst) {
                break;
            }
            match event {
                PeerEvent::Candidate {
                    candidate,
                    sdp_mid,
                    sdp_m_line_index,
                } => {
                    inner.notify(SessionEvent::Candidate {
                        generation: inner.generation,
                        candidate,
                        sdp_mid,
                        sdp_m_line_index,
                    });
                }
                PeerEvent::State(state) => {
                    use webrtc::peer_connection::RTCPeerConnectionState as State;
                    // The far end needs a reference frame to start from, and only
                    // the consumer can make one for a stream it encodes. A
                    // captured desktop manages this in its encode loop; a fed one
                    // has to ask — and everything sent before the transport
                    // connected was dropped, so this is not optional.
                    if lock(&inner.encoded).is_some() && matches!(state, State::Connected) {
                        inner.notify(SessionEvent::KeyframeRequest {
                            generation: inner.generation,
                        });
                    }
                    // ICE loss need not close SCTP. Never leave a drag or chord
                    // held while waiting for that independent notification.
                    if matches!(state, State::Disconnected | State::Failed | State::Closed) {
                        if let Ok(mut input) = inner.input.lock() {
                            if let Some(target) = input.as_mut() {
                                let _ = target.release_all();
                            }
                        }
                    }
                    if matches!(state, State::Failed | State::Closed) {
                        let reason = String::from("the connection to the phone was lost");
                        inner.notify(SessionEvent::Revoked {
                            reason: reason.clone(),
                            code: "transport",
                        });
                        inner.close(&reason, "transport").await;
                        continue;
                    }
                    inner.notify(SessionEvent::State {
                        capture: if inner.metrics.lock().map(|m| m.encoded_frames).unwrap_or(0) > 0
                        {
                            "streaming"
                        } else {
                            "consented"
                        },
                        transport: format!("{state}").to_lowercase(),
                        first_frame: inner.metrics.lock().map(|m| m.encoded_frames).unwrap_or(0)
                            > 0,
                    });
                }
                PeerEvent::ControlOpen => {
                    inner.control_open.store(true, Ordering::SeqCst);
                    let payload = ControlReply::Hello {
                        protocol: crate::protocol::PROTOCOL_VERSION,
                        geometry: inner.geometry.clone(),
                    };
                    let _ = inner.reply(&payload);
                }
                PeerEvent::ControlClosed => {
                    inner.control_open.store(false, Ordering::SeqCst);
                    // A client that vanished must not leave a button held.
                    if let Ok(mut input) = inner.input.lock() {
                        if let Some(target) = input.as_mut() {
                            let _ = target.release_all();
                        }
                    }
                }
                PeerEvent::KeyframeRequest => {
                    inner.notify(SessionEvent::KeyframeRequest {
                        generation: inner.generation,
                    });
                }
                PeerEvent::ControlMessage(text) => {
                    match serde_json::from_str::<ControlMessage>(&text) {
                        Ok(message) => inner.apply(message),
                        Err(_) => inner.reject(0, "operation", "unrecognised control message"),
                    }
                }
            }
        }
    });
}

fn spawn_lease(inner: &Arc<Inner>, ttl: Duration) {
    let inner = inner.clone();
    tokio::spawn(async move {
        tokio::time::sleep(ttl).await;
        if inner.closed.load(Ordering::SeqCst) {
            return;
        }
        let reason = String::from("the session lease expired");
        inner.notify(SessionEvent::Revoked {
            reason: reason.clone(),
            code: "lease",
        });
        // An expiry ends the session exactly as an explicit close does; the
        // notification above is not a substitute for stopping the desktop.
        inner.close(&reason, "lease").await;
    });
}

fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Encoded-surface pixels to the source's own pixels. The client aims at what it
/// sees; the applier is sized and clamped to the source, so the layout origin
/// must not be added here.
fn to_source_pixels(
    x: i64,
    y: i64,
    encoded: (usize, usize),
    source: &SelectedSource,
) -> (i64, i64) {
    let (width, height) = encoded;
    (
        x * source.width as i64 / width as i64,
        y * source.height as i64 / height as i64,
    )
}

fn opaque_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_closed_encoded_session_ends_the_tasks_its_channels_park() {
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let (peer_events, peer_events_rx) = tokio_mpsc::unbounded_channel::<PeerEvent>();
        let (feed, feed_rx) = tokio_mpsc::channel::<FedAccessUnit>(FEED_BACKLOG);
        let inner = Arc::new(Inner {
            id: String::from("encoded-session"),
            generation: 1,
            permissions: Vec::new(),
            source: SelectedSource {
                node_id: 0,
                width: 640,
                height: 480,
                position: None,
                source_type: Some(String::from("encoded")),
                origin_x: 0,
                origin_y: 0,
            },
            geometry: serde_json::json!({
                "source": { "width": 640, "height": 480 },
                "encoded": { "width": 640, "height": 480 },
                "origin": { "x": 0, "y": 0 },
            }),
            metrics: Arc::new(Mutex::new(Metrics::default())),
            latest: Arc::new(Mutex::new(None)),
            capture_error: Arc::new(Mutex::new(None)),
            frame_changes: tokio::sync::watch::channel(0).1,
            peer: Mutex::new(None),
            encoder: Mutex::new(None),
            input: Mutex::new(None),
            indicator: Mutex::new(None),
            capture: Mutex::new(None),
            layout: Mutex::new(None),
            last_seq: Mutex::new(0),
            control_open: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            pipeline: Arc::new(AtomicBool::new(false)),
            events,
            encoded: Mutex::new(Some(Encoded {
                codec: EncodedCodec::H264,
                transport: TransportOptions {
                    ice_servers: Vec::new(),
                    loopback_tcp: false,
                    pace_bps: 20_000_000.0,
                },
                peer_events,
                feed,
            })),
            local_frames: false,
        });
        spawn_peer_events(&inner, peer_events_rx);
        spawn_encoded(&inner, feed_rx);
        inner.close("test", "closed").await;
        for _ in 0..100 {
            if Arc::strong_count(&inner) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            Arc::strong_count(&inner),
            1,
            "closing must end the tasks whose channels the close takes away",
        );
    }

    #[test]
    fn tile_damage_at_origin_does_not_underflow_or_hide_other_tiles() {
        assert_eq!(
            dirty_regions(&[1, 0, 0, 1], &[0; 4], 64, 64),
            vec![[0, 0, 32, 32], [32, 32, 32, 32]]
        );
    }

    #[test]
    fn frames_that_jitter_around_the_cap_go_at_once_and_a_flood_stays_capped() {
        let interval = Duration::from_millis(20);
        let start = Instant::now();
        let mut cadence = Cadence::new(interval, start);
        // Captured at the cap, each a few ms early or late: none waits, so
        // none is delayed or superseded by the next.
        for (n, jitter) in [0i64, -6, 5, -8, 7, -3, 0, -9, 9, -5].iter().enumerate() {
            let at = start + interval * n as u32 + Duration::from_millis(9);
            let at = if *jitter < 0 {
                at - Duration::from_millis(jitter.unsigned_abs())
            } else {
                at + Duration::from_millis(*jitter as u64)
            };
            assert_eq!(cadence.wait(at), Duration::ZERO, "frame {n} waited");
            cadence.sent(at);
        }

        // A source far above the cap: one second of 1 ms frames sends at most
        // one frame over the cap.
        let start = start + Duration::from_secs(10);
        let mut cadence = Cadence::new(interval, start);
        let sent = (0..1000)
            .map(|ms| start + Duration::from_millis(ms))
            .filter(|&at| {
                let go = cadence.wait(at).is_zero();
                if go {
                    cadence.sent(at);
                }
                go
            })
            .count();
        assert!((50..=51).contains(&sent), "sent {sent} at a 50 fps cap");
    }

    #[test]
    fn a_small_source_is_never_upscaled() {
        assert_eq!(fit(1000, 600, 1280, 800), (1000, 600));
    }

    #[test]
    fn a_large_source_is_fitted_into_the_box_with_even_dimensions() {
        let (w, h) = fit(2560, 1440, 1280, 800);
        assert_eq!((w, h), (1280, 720));
        assert_eq!((w % 2, h % 2), (0, 0));
    }

    #[test]
    fn fit_keeps_the_aspect_ratio_when_the_box_is_the_constraint() {
        assert_eq!(fit(2560, 1440, 1200, 600), (1066, 600));
    }

    #[test]
    fn an_encoded_surface_pixel_maps_to_the_sources_own_pixel() {
        let source = SelectedSource {
            node_id: 0,
            width: 2560,
            height: 1440,
            position: Some((1920, 0)),
            source_type: None,
            origin_x: 1920,
            origin_y: 0,
        };
        // A tap at the centre of a 1280x720 surface must reach the centre of the
        // 2560x1440 source, not two thirds of the way there; a tap in the right
        // half must stay source-local rather than land on a layout origin the
        // applier would clamp away.
        assert_eq!(
            to_source_pixels(640, 360, (1280, 720), &source),
            (1280, 720)
        );
        assert_eq!(
            to_source_pixels(1279, 719, (1280, 720), &source),
            (2558, 1438)
        );
        assert_eq!(to_source_pixels(0, 0, (1280, 720), &source), (0, 0));
    }

    async fn test_inner(
        events: tokio_mpsc::UnboundedSender<Notice>,
    ) -> (Arc<Inner>, Arc<Mutex<Vec<(i16, bool)>>>) {
        let (peer_events, _peer_events_rx) = tokio_mpsc::unbounded_channel();
        let (peer, _offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                loopback_tcp: false,
                pace_bps: 20_000_000.0,
            },
            peer_events,
            VideoCodec::Vp9,
        )
        .await
        .expect("a peer connection builds without a network");
        // The pipeline codes nothing before the transport connects.
        peer.assume_connected();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let inner = Arc::new(Inner {
            id: String::from("test-session"),
            generation: 1,
            permissions: vec![Permission::Control],
            source: SelectedSource {
                node_id: 0,
                width: 640,
                height: 480,
                position: None,
                source_type: None,
                origin_x: 0,
                origin_y: 0,
            },
            geometry: serde_json::json!({
                "source": { "width": 640, "height": 480 },
                "encoded": { "width": 640, "height": 480 },
                "origin": { "x": 0, "y": 0 },
            }),
            metrics: Arc::new(Mutex::new(Metrics::default())),
            latest: Arc::new(Mutex::new(None)),
            capture_error: Arc::new(Mutex::new(None)),
            frame_changes: tokio::sync::watch::channel(0).1,
            peer: Mutex::new(Some(Arc::new(peer))),
            encoder: Mutex::new(Some(Encoder::new(64, 64, 1000, 30, 1).expect("an encoder"))),
            input: Mutex::new(Some(InputTarget {
                applier: Applier::Recording(recorded.clone()),
                held: HeldState::default(),
                explicit_modifiers: Vec::new(),
                chord_modifiers: Vec::new(),
                chord_keys: Vec::new(),
                wheel_rest: (0.0, 0.0),
            })),
            capture: Mutex::new(None),
            indicator: Mutex::new(None),
            layout: Mutex::new(Some(Layout::from_environment().expect("a keymap"))),
            last_seq: Mutex::new(0),
            control_open: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            pipeline: Arc::new(AtomicBool::new(true)),
            events,
            encoded: Mutex::new(None),
            local_frames: true,
        });
        (inner, recorded)
    }

    #[tokio::test]
    async fn a_lease_that_expires_ends_the_session_and_releases_held_input() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let (inner, recorded) = test_inner(events).await;

        inner.apply(ControlMessage::Key {
            name: None,
            character: Some(String::from("a")),
            down: true,
            modifiers: Vec::new(),
            seq: 1,
        });
        assert!(
            recorded.lock().unwrap().iter().any(|(_, down)| *down),
            "the press reached the desktop",
        );

        spawn_lease(&inner, Duration::from_millis(20));
        tokio::time::sleep(Duration::from_millis(150)).await;

        assert!(
            inner.revoked_reason().is_some(),
            "an expired lease must end the session"
        );
        assert!(
            !inner.pipeline.load(Ordering::SeqCst),
            "an expired lease must stop capture",
        );
        assert!(
            recorded.lock().unwrap().iter().any(|(_, down)| !*down),
            "an expired lease must release what the session pressed",
        );
        assert!(
            matches!(
                received.try_recv(),
                Ok(Notice {
                    event: SessionEvent::Revoked { code: "lease", .. },
                    ..
                })
            ),
            "the consumer is still told the session's authority ended",
        );

        let rejected = inner.metrics.lock().unwrap().input_rejected;
        inner.apply(ControlMessage::Key {
            name: None,
            character: Some(String::from("b")),
            down: true,
            modifiers: Vec::new(),
            seq: 2,
        });
        assert_eq!(
            inner.metrics.lock().unwrap().input_rejected,
            rejected + 1,
            "a control message after expiry must be refused",
        );
    }

    #[tokio::test]
    async fn a_held_modifier_survives_character_named_and_text_chords() {
        use crate::input::keycode;
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let (inner, recorded) = test_inner(events).await;
        for (seq, name) in ["Control", "Shift", "Alt", "Meta"].iter().enumerate() {
            inner.apply(ControlMessage::Key {
                name: Some((*name).into()),
                character: None,
                down: true,
                modifiers: Vec::new(),
                seq: seq as u64 + 1,
            });
        }
        inner.apply(ControlMessage::Key {
            name: None,
            character: Some(String::from("C")),
            down: true,
            modifiers: vec![String::from("Control"), String::from("Shift")],
            seq: 5,
        });
        inner.apply(ControlMessage::Key {
            name: None,
            character: Some(String::from("C")),
            down: false,
            modifiers: vec![String::from("Control"), String::from("Shift")],
            seq: 6,
        });
        inner.apply(ControlMessage::Key {
            name: Some(String::from("ArrowLeft")),
            character: None,
            down: true,
            modifiers: vec![String::from("Alt"), String::from("Meta")],
            seq: 7,
        });
        inner.apply(ControlMessage::Key {
            name: Some(String::from("ArrowLeft")),
            character: None,
            down: false,
            modifiers: vec![String::from("Alt"), String::from("Meta")],
            seq: 8,
        });
        inner.apply(ControlMessage::Text {
            text: String::from("C"),
            seq: 9,
        });
        let modifiers = [
            keycode::LEFT_CTRL,
            keycode::LEFT_SHIFT,
            keycode::LEFT_ALT,
            keycode::LEFT_META,
        ];
        let strokes = recorded.lock().unwrap().clone();
        for code in modifiers {
            assert_eq!(
                strokes
                    .iter()
                    .filter(|stroke| **stroke == (code, true))
                    .count(),
                1
            );
            assert!(
                !strokes.contains(&(code, false)),
                "the separate key still holds {code}"
            );
        }
        for (seq, name) in ["Control", "Shift", "Alt", "Meta"].iter().enumerate() {
            inner.apply(ControlMessage::Key {
                name: Some((*name).into()),
                character: None,
                down: false,
                modifiers: Vec::new(),
                seq: seq as u64 + 10,
            });
        }
        {
            let strokes = recorded.lock().unwrap();
            for code in modifiers {
                assert_eq!(
                    strokes
                        .iter()
                        .filter(|stroke| **stroke == (code, false))
                        .count(),
                    1
                );
            }
        }
        inner.apply(ControlMessage::Key {
            name: Some(String::from("ArrowLeft")),
            character: None,
            down: true,
            modifiers: vec![String::from("Control")],
            seq: 14,
        });
        inner.apply(ControlMessage::Key {
            name: Some(String::from("ArrowLeft")),
            character: None,
            down: false,
            modifiers: vec![String::from("Control")],
            seq: 15,
        });
        {
            let strokes = recorded.lock().unwrap();
            assert_eq!(
                strokes
                    .iter()
                    .filter(|stroke| **stroke == (keycode::LEFT_CTRL, true))
                    .count(),
                2
            );
            assert_eq!(
                strokes
                    .iter()
                    .filter(|stroke| **stroke == (keycode::LEFT_CTRL, false))
                    .count(),
                2
            );
        }
        inner.apply(ControlMessage::Key {
            name: Some(String::from("Control")),
            character: None,
            down: true,
            modifiers: Vec::new(),
            seq: 16,
        });
        for seq in [17, 18] {
            inner.apply(ControlMessage::Key {
                name: None,
                character: Some(String::from("c")),
                down: true,
                modifiers: vec![String::from("Control")],
                seq,
            });
        }
        inner.apply(ControlMessage::Key {
            name: Some(String::from("Control")),
            character: None,
            down: false,
            modifiers: Vec::new(),
            seq: 19,
        });
        assert!(!recorded
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(2)
            .any(|event| *event == (keycode::LEFT_CTRL, false)));
        inner.apply(ControlMessage::Key {
            name: None,
            character: Some(String::from("c")),
            down: false,
            modifiers: Vec::new(),
            seq: 20,
        });
        inner.apply(ControlMessage::Key {
            name: Some(String::from("ArrowLeft")),
            character: None,
            down: true,
            modifiers: vec![String::from("Shift")],
            seq: 21,
        });
        inner.apply(ControlMessage::Key {
            name: Some(String::from("ArrowLeft")),
            character: None,
            down: false,
            modifiers: Vec::new(),
            seq: 22,
        });
        let strokes = recorded.lock().unwrap();
        assert_eq!(
            strokes
                .iter()
                .filter(|stroke| **stroke == (keycode::LEFT_CTRL, true))
                .count(),
            3
        );
        assert_eq!(
            strokes
                .iter()
                .filter(|stroke| **stroke == (keycode::LEFT_CTRL, false))
                .count(),
            3
        );
        assert_eq!(
            strokes
                .iter()
                .filter(|stroke| **stroke == (keycode::LEFT_SHIFT, false))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn x11_capture_refuses_both_clipboard_directions() {
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let (mut inner, _recorded) = test_inner(events).await;
        let owned = Arc::get_mut(&mut inner).unwrap();
        owned.source.source_type = Some(String::from("x11-root"));
        owned.permissions.push(Permission::Clipboard);
        let session = Session {
            inner: inner.clone(),
        };
        assert!(session
            .read_clipboard()
            .await
            .unwrap_err()
            .contains("unavailable"));
        assert!(session
            .write_clipboard(String::from("secret"))
            .await
            .unwrap_err()
            .contains("unavailable"));
        inner.clipboard_read(String::from("read"));
        inner.clipboard_write(String::from("write"), String::from("secret"));
        assert_eq!(inner.metrics.lock().unwrap().input_rejected, 2);
    }

    #[tokio::test]
    async fn a_stopped_capture_never_serves_the_last_frame() {
        let (events, _) = tokio_mpsc::unbounded_channel();
        let (mut inner, _) = test_inner(events).await;
        Arc::get_mut(&mut inner)
            .unwrap()
            .permissions
            .push(Permission::View);
        let session = Session { inner };
        *lock(&session.inner.latest) =
            Some((1, Instant::now(), 2, 2, vec![0; 16], vec![1], vec![]));
        *lock(&session.inner.capture_error) = Some(String::from("SCStreamErrorDomain -3821"));
        assert_eq!(
            session.frame(None, "", None).unwrap_err().code,
            "stream-stopped"
        );
        assert_eq!(
            session.wait_frame(None, None, 10).await.unwrap_err().code,
            "stream-stopped"
        );
    }

    #[tokio::test]
    async fn a_frame_the_encoder_refuses_ends_the_session_with_a_reason() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let (inner, _recorded) = test_inner(events).await;
        let (frame_tx, frame_rx) = latest_frame();
        spawn_pipeline(
            &inner,
            current_peer(&inner).expect("the test's peer"),
            frame_rx,
            Arc::new(AtomicBool::new(true)),
            30,
            1000,
        );

        // The encoder is 64x64; a 32x32 frame is the dimension mismatch that
        // used to be counted and dropped behind a permanently black picture.
        frame_tx.put(
            I420 {
                width: 32,
                height: 32,
                data: vec![128u8; 32 * 32 + 2 * 16 * 16],
            },
            Instant::now(),
        );
        tokio::time::sleep(Duration::from_millis(150)).await;

        let mut reason = None;
        while let Ok(event) = received.try_recv() {
            if let Notice {
                event: SessionEvent::Revoked { reason: why, code },
                ..
            } = event
            {
                assert_eq!(code, "error", "a refused frame is a fault, not a lost path");
                reason = Some(why);
            }
        }
        let reason = reason.expect("a refused frame must surface as a revocation");
        assert_eq!(
            reason, "the encoder rejected a frame",
            "the reason is a stable token the client can map to copy",
        );
        assert!(
            inner.revoked_reason().is_some(),
            "the session is closed, not left black"
        );
    }

    /// A consumer-fed stream: a keyframe carrying SPS, PPS and an IDR slice.
    fn fed_keyframe() -> Vec<u8> {
        let mut stream = vec![0x00, 0x00, 0x00, 0x01];
        stream.extend_from_slice(&[0x67, 0x42, 0xc0, 0x29, 0x8c, 0x8d]);
        stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);
        stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]);
        stream
    }

    fn encoded_open() -> OpenRequest {
        OpenRequest {
            source: Some(SourceRequest::Encoded {
                codec: EncodedCodec::H264,
                width: 486,
                height: 1080,
            }),
            permissions: vec![Permission::View, Permission::Control],
            max_width: 3840,
            max_height: 2160,
            bitrate_kbps: 0,
            max_fps: 30,
            ice_servers: Vec::new(),
            restore_token: None,
            ttl: Some(Duration::from_secs(30)),
            loopback_tcp: false,
            agent_indicator: false,
            local_frames: true,
        }
    }

    async fn next_notice(received: &mut tokio_mpsc::UnboundedReceiver<Notice>) -> Notice {
        tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .expect("a notification arrives")
            .expect("the channel stays open")
    }

    #[tokio::test]
    async fn an_encoded_session_opens_without_capture_encoder_or_input() {
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let session = Session::open(encoded_open(), events)
            .await
            .expect("an encoded source needs no display and no input device");
        let inner = &session.inner;
        assert_eq!(session.restore_source(), "encoded");
        assert_eq!(session.geometry()["encoded"]["width"], 486);
        assert_eq!(session.geometry()["encoded"]["height"], 1080);
        assert!(
            inner.encoder.lock().unwrap().is_none(),
            "the consumer is the encoder for this source"
        );
        assert!(
            inner.capture.lock().unwrap().is_none(),
            "there is nothing to capture"
        );
        assert!(
            inner.input.lock().unwrap().is_none(),
            "the client's input belongs to the consumer's device"
        );
        assert!(
            inner.peer.lock().unwrap().is_none(),
            "the offer waits for the stream's own SPS"
        );
    }

    #[tokio::test]
    async fn the_offer_for_a_fed_stream_names_that_streams_own_profile() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let session = Session::open(encoded_open(), events)
            .await
            .expect("an encoded session");
        let first = next_notice(&mut received).await;
        assert!(
            matches!(
                first.event,
                SessionEvent::State {
                    capture: "consented",
                    ..
                }
            ),
            "the session is open before any offer exists: {:?}",
            first.event,
        );

        session
            .feed(true, fed_keyframe())
            .expect("a keyframe is taken");
        let offered = loop {
            let notice = next_notice(&mut received).await;
            if let SessionEvent::Description { sdp, .. } = notice.event {
                break sdp;
            }
        };
        assert!(
            offered.contains("H264/90000"),
            "the fed track is offered as H.264: {offered}"
        );
        assert!(
            offered.contains("profile-level-id=42c029"),
            "the profile-level-id comes from the fed SPS, not a default: {offered}"
        );
        assert_eq!(session.metrics().fed_frames, 1);
    }

    #[tokio::test]
    async fn a_fed_stream_forwards_its_controls_instead_of_applying_them() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let session = Session::open(encoded_open(), events)
            .await
            .expect("an encoded session");
        session.inner.control_open.store(true, Ordering::SeqCst);

        session.inner.apply(ControlMessage::Pointer {
            phase: PointerPhase::Down,
            x: 10,
            y: 20,
            button: 1,
            seq: 1,
        });

        let forwarded = loop {
            let notice = next_notice(&mut received).await;
            if let SessionEvent::Input { input } = notice.event {
                break input;
            }
        };
        assert_eq!(forwarded["kind"], "pointer");
        assert_eq!(forwarded["phase"], "down");
        assert_eq!(forwarded["x"], 10);
        assert_eq!(forwarded["seq"], 1);
        assert_eq!(session.metrics().input_forwarded, 1);
        assert_eq!(
            session.metrics().input_applied,
            0,
            "nothing was applied to this machine"
        );

        // The stream's own coordinates are what travels, so an encoded surface
        // cannot be driven by a coordinate the far end never rendered.
        session.inner.apply(ControlMessage::Pointer {
            phase: PointerPhase::Move,
            x: 9_000,
            y: 20,
            button: 1,
            seq: 2,
        });
        assert_eq!(session.metrics().input_forwarded, 2);
    }

    #[tokio::test]
    async fn a_capture_session_refuses_a_fed_stream() {
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let (inner, _recorded) = test_inner(events).await;
        let session = Session { inner };
        assert_eq!(
            session.feed(true, fed_keyframe()).unwrap_err().code,
            "operation",
            "only an encoded source takes access units",
        );
    }

    #[tokio::test]
    async fn an_encoded_session_has_no_frame_to_read() {
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let session = Session::open(encoded_open(), events)
            .await
            .expect("an encoded session");
        assert_eq!(session.frame(None, "", None).unwrap_err().code, "operation");
        assert_eq!(
            session.wait_frame(None, None, 10).await.unwrap_err().code,
            "operation"
        );
        assert_eq!(
            session.read_clipboard().await.unwrap_err(),
            "clipboard is unavailable for this desktop source",
        );
    }

    #[tokio::test]
    async fn opening_without_view_permission_is_refused_before_capture() {
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let result = Session::open(
            OpenRequest {
                source: None,
                permissions: vec![Permission::Control],
                max_width: 640,
                max_height: 480,
                bitrate_kbps: 0,
                max_fps: 30,
                ice_servers: Vec::new(),
                restore_token: None,
                ttl: None,
                loopback_tcp: false,
                agent_indicator: false,
                local_frames: true,
            },
            events,
        )
        .await;
        let error = match result {
            Ok(_) => panic!("a viewless session must not open"),
            Err(error) => error,
        };
        assert_eq!(error.code, "permission");
    }

    #[tokio::test]
    async fn a_lost_transport_releases_input_then_ends_the_session_without_sctp_close() {
        use webrtc::peer_connection::RTCPeerConnectionState as State;
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let (inner, recorded) = test_inner(events).await;
        inner.apply(ControlMessage::Key {
            name: Some(String::from("Control")),
            character: None,
            down: true,
            modifiers: Vec::new(),
            seq: 1,
        });
        assert!(recorded.lock().unwrap().iter().any(|(_, down)| *down));

        let (peer_tx, peer_rx) = tokio_mpsc::unbounded_channel();
        spawn_peer_events(&inner, peer_rx);
        peer_tx.send(PeerEvent::State(State::Disconnected)).unwrap();
        tokio::time::timeout(Duration::from_secs(2), received.recv())
            .await
            .unwrap();
        assert!(
            recorded.lock().unwrap().iter().any(|(_, down)| !*down),
            "a disconnected transport must release held input without SCTP OnClose"
        );
        assert!(
            inner.revoked_reason().is_none(),
            "a transient loss may recover"
        );

        peer_tx.send(PeerEvent::State(State::Failed)).unwrap();
        let mut transport_lost = false;
        tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(notice) = received.recv().await {
                // A lost path is the one revocation a new session can heal.
                transport_lost |= matches!(
                    notice.event,
                    SessionEvent::Revoked {
                        code: "transport",
                        ..
                    }
                );
                if matches!(
                    notice.event,
                    SessionEvent::State {
                        capture: "ended",
                        ..
                    }
                ) {
                    return;
                }
            }
            panic!("failed transport did not end capture");
        })
        .await
        .unwrap();
        assert!(
            transport_lost,
            "a failed transport must revoke with code transport"
        );
        assert!(inner.revoked_reason().is_some());
        assert!(!inner.pipeline.load(Ordering::SeqCst));
        assert!(inner.input.lock().unwrap().is_none());
    }

    #[test]
    fn a_standing_queue_backs_the_rate_off_to_what_the_path_delivers() {
        let start = Instant::now();
        let queued = |ms: u64, delivered_kbps: u32| {
            Some(PathReport {
                queue_delay: Duration::from_millis(ms),
                delivered_kbps,
            })
        };
        let mut rate = RateControl::new(8000);
        // A burst's worth of queue and no loss moves nothing.
        assert_eq!(rate.update(&[], queued(15, 3000), start), None);
        // A standing queue on a 4 Mbps link: 85% of what got through, at once,
        // with no loss reported at all.
        assert_eq!(rate.update(&[], queued(80, 4000), start), Some(3400));
        // Not again until the back-off has had time to show in the feedback.
        assert_eq!(
            rate.update(&[], queued(80, 3400), start + Duration::from_millis(100)),
            None
        );
        assert_eq!(
            rate.update(&[], queued(60, 3400), start + Duration::from_millis(300)),
            Some(2890)
        );
        // A stream that sent little is not taken for a slow link: at most half.
        assert_eq!(
            rate.update(&[], queued(60, 100), start + Duration::from_millis(600)),
            Some(1228)
        );
        // Clean loss reports do not raise it while the queue has not drained...
        assert_eq!(
            rate.update(&[0], queued(15, 1200), start + Duration::from_secs(2)),
            None
        );
        // ...and do once it has.
        assert_eq!(
            rate.update(&[0], queued(2, 1200), start + Duration::from_secs(3)),
            Some(1390)
        );
        // Nothing drops below the floor.
        let mut rate = RateControl::new(8000);
        for step in 0..20u64 {
            rate.update(
                &[],
                queued(200, 1),
                start + DELAY_BACKOFF_EVERY * step as u32,
            );
        }
        assert_eq!(rate.target, 1000);
    }

    #[test]
    fn without_transport_feedback_the_rate_follows_loss_alone() {
        let start = Instant::now();
        let mut rate = RateControl::new(8000);
        assert_eq!(rate.update(&[], None, start), None);
        assert_eq!(rate.update(&[64], None, start), Some(5600));
        assert_eq!(
            rate.update(&[64], None, start + Duration::from_millis(500)),
            None
        );
        assert_eq!(
            rate.update(&[10], None, start + Duration::from_secs(1)),
            None
        );
        assert_eq!(
            rate.update(&[0], None, start + Duration::from_secs(2)),
            Some(6112)
        );
    }

    #[test]
    fn a_large_frame_holds_the_next_until_the_link_has_carried_it() {
        let start = Instant::now();
        let mut budget = SendBudget::default();
        // Frames at the target, one per 20 ms at 4000 kbps, never wait, and
        // neither does the ordinary overshoot of a frame at twice the budget.
        for n in 0..50u32 {
            let at = start + Duration::from_millis(20) * n;
            assert_eq!(budget.wait(at, 4000), Duration::ZERO, "frame {n} waited");
            budget.sent(at, if n % 5 == 0 { 20_000 } else { 10_000 }, 4000);
        }
        // A 100 kB key frame drains in 160 ms (4000 kbps and a quarter): it
        // goes at once, and the next waits out all of it past the 60 ms burst
        // allowance.
        let at = start + Duration::from_secs(1);
        assert_eq!(budget.wait(at, 4000), Duration::ZERO);
        budget.sent(at, 100_000, 4000);
        let wait = budget.wait(at, 4000);
        assert!(
            (Duration::from_millis(99)..=Duration::from_millis(101)).contains(&wait),
            "waited {wait:?}"
        );
        assert_eq!(budget.wait(at + wait, 4000), Duration::ZERO);
    }

    #[test]
    fn motion_halves_only_when_the_encoder_sets_the_pace_and_does_not_flap() {
        let interval = Duration::from_millis(16);
        let (slow, fast) = (Duration::from_millis(30), Duration::from_millis(2));
        let mut size = MotionSize::default();
        for _ in 0..MotionSize::SLOW_RUN * 4 {
            size.coded(slow, false, true, interval);
        }
        assert!(
            !size.half,
            "slow small frames (typing on a busy host) keep full size"
        );
        for _ in 0..MotionSize::SLOW_RUN * 4 {
            size.coded(slow, true, false, interval);
        }
        assert!(
            !size.half,
            "a source slower than the cap (30 fps, 30 ms encode) never halves"
        );
        for _ in 0..MotionSize::SLOW_RUN - 1 {
            size.coded(slow, true, true, interval);
        }
        size.coded(fast, true, true, interval);
        assert!(!size.half, "a broken run of slow frames keeps full size");
        for _ in 0..MotionSize::SLOW_RUN {
            size.coded(slow, true, true, interval);
        }
        assert!(size.half, "a run of slow large frames halves");
        // The marginal band: half-size frames that are small but still slow,
        // between large ones. Neither may send it back to full size.
        for i in 0..MotionSize::SMALL_RUN * 10 {
            size.coded(slow, i % 7 == 0, true, interval);
            assert!(size.half, "marginal half-size motion must not flap back");
        }
        for _ in 0..MotionSize::SMALL_RUN * 2 {
            size.coded(fast, true, true, interval);
        }
        assert!(size.half, "large half-size frames stay half, however fast");
        for _ in 0..MotionSize::SMALL_RUN {
            size.coded(fast, false, true, interval);
        }
        assert!(
            !size.half,
            "a run of small, fast half-size frames returns to full size"
        );
    }

    #[tokio::test]
    async fn the_pipeline_caps_the_rate_codes_the_last_frame_and_refines_a_still_desktop_once() {
        let (events, _events_rx) = tokio_mpsc::unbounded_channel();
        let (inner, _recorded) = test_inner(events).await;
        let (frame_tx, frame_rx) = latest_frame();
        spawn_pipeline(
            &inner,
            current_peer(&inner).expect("the test's peer"),
            frame_rx,
            Arc::new(AtomicBool::new(true)),
            20,
            1000,
        );

        // 40 frames over 200 ms is 200 fps; the requested 20 fps caps what leaves.
        for _ in 0..40 {
            frame_tx.put(
                I420 {
                    width: 64,
                    height: 64,
                    data: vec![128u8; 64 * 64 + 2 * 32 * 32],
                },
                Instant::now(),
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let motion = inner.metrics.lock().unwrap().encoded_frames;
        assert!(
            motion <= 7,
            "the requested rate is a cap, got {motion} of 40"
        );
        assert!(
            motion >= 2,
            "the pipeline must still emit frames, got {motion}"
        );

        // Still for longer than a refinement takes: the last frame of the burst
        // is coded (a refinement only follows a coded frame), then refined once.
        tokio::time::sleep(Duration::from_millis(450)).await;
        let metrics = inner.metrics.lock().unwrap().clone();
        assert_eq!(
            metrics.refined_frames, 1,
            "a still desktop is refined exactly once"
        );
        assert_eq!(metrics.key_frames, 1, "only the first frame is a key frame");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            inner.metrics.lock().unwrap().encoded_frames,
            metrics.encoded_frames,
            "nothing is sent while still"
        );

        // A still stream is kept alive, so a receiver never waits long enough
        // to ask for a key frame; the keepalive is neither a key frame nor
        // another refinement.
        tokio::time::sleep(Duration::from_millis(900)).await;
        let later = inner.metrics.lock().unwrap().clone();
        assert!(
            later.encoded_frames > metrics.encoded_frames,
            "a still stream still sends"
        );
        assert_eq!((later.key_frames, later.refined_frames), (1, 1));
    }
}
