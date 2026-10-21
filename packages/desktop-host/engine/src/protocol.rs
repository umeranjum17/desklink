//! Wire types for the local control protocol and for the session's control
//! channel. Documented in `docs/PROTOCOL.md`; this module is the definition.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 3;

/// A request from the consumer to the engine.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<u64>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A reply to one request. Exactly one of `result`/`error` is set.
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl ErrorBody {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

/// A notification the engine sends on its own.
#[derive(Debug, Serialize)]
pub struct Event {
    pub event: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Default, Deserialize)]
pub struct HelloParams {
    #[serde(default)]
    pub protocol: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IceServerParam {
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// Which desktop to capture.
///
/// The portal is the default because on a Wayland desktop it is what carries the
/// user's consent. An explicit X display is the other supported backend: a
/// machine with no working screen-cast portal, a headless X server, or a remote
/// X session. Asking for one is a deployment choice, not a test switch.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRequest {
    Portal,
    Display {
        #[serde(default)]
        display_id: Option<u32>,
    },
    X11 {
        #[serde(default)]
        display: Option<String>,
    },
    /// Video the consumer already encoded, fed access unit by access unit with
    /// `session.feed`. The engine has no capture backend, no encoder and no
    /// input backend for this source: it packetizes what it is handed and
    /// forwards control messages back to the consumer, which owns the device.
    Encoded {
        codec: EncodedCodec,
        /// The stream's own pixel size. The consumer is the only party that
        /// knows it, and nothing here is scaled: the client aims at these
        /// pixels and the consumer maps them to its device.
        width: usize,
        height: usize,
    },
}

/// A codec the consumer may feed. Only H.264 is accepted today, because it is
/// what the device helpers emit and what the clients can already decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodedCodec {
    H264,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorMode {
    #[default]
    Embedded,
    Hidden,
}

#[derive(Debug, Deserialize)]
pub struct OpenParams {
    #[serde(default)]
    pub cursor: CursorMode,
    /// Absent means "the portal, with the user's consent".
    #[serde(default)]
    pub source: Option<SourceRequest>,
    #[serde(default = "default_max_width")]
    pub max_width: usize,
    #[serde(default = "default_max_height")]
    pub max_height: usize,
    #[serde(default = "default_bitrate")]
    pub bitrate_kbps: u32,
    #[serde(default = "default_fps")]
    pub max_fps: u32,
    #[serde(default)]
    pub ice_servers: Vec<IceServerParam>,
    #[serde(default)]
    pub restore_token: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    /// Also listen for ICE over TCP on this computer's loopback, for a client
    /// whose only way here is a local forward (an SSH tunnel).
    #[serde(default)]
    pub loopback_tcp: bool,
    /// Show local, capture-excluded feedback for an agent controlling this session.
    #[serde(default)]
    pub agent_indicator: bool,
    /// Keep the latest pre-encode frame for `session.frame` and emit
    /// `session.frame.changed`. A consumer that only streams turns it off, and
    /// the engine then spends nothing per frame on either.
    #[serde(default = "default_local_frames")]
    pub local_frames: bool,
    /// Capture the desktop's own system audio for `session.audio`. Absent means
    /// video only; there is never a silent downgrade, so a caller that asks and
    /// cannot be answered is refused.
    #[serde(default)]
    pub audio: bool,
    /// Observe this computer's own pointer buttons, cursor and keys and raise
    /// them as `session.input.observed` and `session.cursor`. Off unless asked:
    /// it reports every key typed on the desktop, in every application.
    #[serde(default)]
    pub observe_input: bool,
}

fn default_local_frames() -> bool {
    true
}

/// The encode box when the consumer names none: a desktop's own pixels up to
/// 4K, because a phone zooms into the picture and text has to survive that.
fn default_max_width() -> usize {
    3840
}
fn default_max_height() -> usize {
    2160
}
/// Zero asks the engine to size the rate to the encoded surface.
fn default_bitrate() -> u32 {
    0
}
/// A still desktop costs nothing at 60: frames are only produced on change,
/// so consumers get the smooth path without naming a rate.
fn default_fps() -> u32 {
    60
}

/// A host-only visual cue; never an input message.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointParams {
    pub session_id: String,
    pub x: Option<i64>,
    pub y: Option<i64>,
    #[serde(default)]
    pub label: String,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub clear: bool,
}

#[derive(Debug, Deserialize)]
pub struct FrameParams {
    pub session_id: String,
    #[serde(default)]
    pub since: Option<u64>,
    #[serde(default)]
    pub after_seq: Option<u64>,
    #[serde(default)]
    pub still_ms: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub region: Option<[usize; 4]>,
}

/// One access unit of a consumer-encoded stream.
///
/// Base64 inside the same JSON line keeps one ordered channel and one fd: one
/// second of a 2 Mbit/s stream costs about 1 ms to decode here and 0.09 ms to
/// encode on the consumer's side, against the 5 % of a core that would have
/// justified a second fd (see `docs/PROTOCOL.md`, "Encoded sources").
#[derive(Debug, Deserialize)]
pub struct FeedParams {
    pub session_id: String,
    /// True for an IDR access unit. The first one also carries the SPS whose
    /// profile-level-id the offer negotiates.
    pub keyframe: bool,
    pub data_b64: String,
}

/// The largest access unit this protocol accepts, once decoded. A 4K key frame
/// at a quality worth sending is a few hundred kilobytes; this refuses a request
/// that is not a picture rather than acting as a rate limit.
pub const MAX_ACCESS_UNIT_BYTES: usize = 8 * 1024 * 1024;

impl FeedParams {
    /// The access unit's own bytes, or why this request is not one.
    pub fn access_unit(&self) -> std::result::Result<Vec<u8>, String> {
        let data = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            self.data_b64.as_bytes(),
        )
        .map_err(|error| format!("data_b64 is not base64: {error}"))?;
        if data.len() > MAX_ACCESS_UNIT_BYTES {
            return Err(format!(
                "an access unit is {} bytes; the limit is {MAX_ACCESS_UNIT_BYTES}",
                data.len()
            ));
        }
        Ok(data)
    }
}

#[derive(Debug, Deserialize)]
pub struct SessionRef {
    pub session_id: String,
    #[serde(default)]
    pub generation: Option<u64>,
}

/// Read the desktop's own audio, the way `FrameParams` reads a frame: bytes go
/// to the caller's path and JSON carries only metadata.
#[derive(Debug, Deserialize)]
pub struct AudioParams {
    pub session_id: String,
    #[serde(default)]
    pub path: String,
    /// The most bytes to write. Bounded to whole sample frames, so a truncated
    /// chunk never ends mid-sample.
    #[serde(default = "default_max_audio_bytes")]
    pub max_bytes: usize,
}

fn default_max_audio_bytes() -> usize {
    1 << 20
}

#[derive(Debug, Deserialize)]
pub struct DescriptionParams {
    pub session_id: String,
    #[serde(default)]
    pub generation: Option<u64>,
    pub description: RtcDescription,
}

#[derive(Debug, Deserialize)]
pub struct RtcDescription {
    #[serde(rename = "type")]
    pub kind: String,
    pub sdp: String,
}

#[derive(Debug, Deserialize)]
pub struct CandidateParams {
    pub session_id: String,
    #[serde(default)]
    pub generation: Option<u64>,
    pub candidate: String,
    #[serde(default)]
    pub sdp_mid: Option<String>,
    #[serde(default, rename = "sdpMLineIndex", alias = "sdp_m_line_index")]
    pub sdp_m_line_index: Option<u16>,
}

#[derive(Debug, Deserialize)]
pub struct ClipboardParams {
    pub session_id: String,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// Messages the client sends on the session's control channel.
///
/// `seq` is the client's own ordering. The engine refuses a repeat or a lower
/// value rather than re-applying an action, so a replayed frame cannot move the
/// pointer twice.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlMessage {
    Pointer {
        phase: PointerPhase,
        x: i64,
        y: i64,
        #[serde(default = "left_button")]
        button: i64,
        #[serde(default)]
        seq: u64,
    },
    /// Detents; fractions scroll smoothly where the desktop supports it.
    Wheel {
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
        #[serde(default)]
        seq: u64,
    },
    Key {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        character: Option<String>,
        down: bool,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default)]
        seq: u64,
    },
    Text {
        text: String,
        #[serde(default)]
        seq: u64,
    },
    ReleaseAll {
        #[serde(default)]
        seq: u64,
    },
    ClipboardRead {
        request: String,
        #[serde(default)]
        seq: u64,
    },
    ClipboardWrite {
        request: String,
        text: String,
        #[serde(default)]
        seq: u64,
    },
}

fn left_button() -> i64 {
    1
}

impl ControlMessage {
    pub fn seq(&self) -> u64 {
        match self {
            Self::Pointer { seq, .. }
            | Self::Wheel { seq, .. }
            | Self::Key { seq, .. }
            | Self::Text { seq, .. }
            | Self::ReleaseAll { seq }
            | Self::ClipboardRead { seq, .. }
            | Self::ClipboardWrite { seq, .. } => *seq,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerPhase {
    Move,
    Down,
    Up,
    Cancel,
}

/// A pointer button or key the person pressed on the observed desktop. The
/// vocabulary is the control channel's own (`pointer` and `key`), so a consumer
/// reads what it sent and what it saw the same way. `x`/`y` are in the source's
/// own pixels (`geometry.source`); `modifiers` is the modifier state after the
/// event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObservedInput {
    Pointer {
        phase: PointerPhase,
        x: i64,
        y: i64,
        button: i64,
    },
    Key {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        character: Option<String>,
        down: bool,
        modifiers: Vec<String>,
    },
}

/// Messages the engine sends back on the control channel.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlReply<'a> {
    Hello {
        protocol: u32,
        geometry: serde_json::Value,
    },
    Ack {
        seq: u64,
    },
    Rejected {
        seq: u64,
        code: &'a str,
        message: &'a str,
    },
    Clipboard {
        request: &'a str,
        text: String,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
    Revoked {
        reason: &'a str,
        code: &'a str,
    },
}

/// Monotonic engine-process clock shared by local frame and cursor notices.
pub fn timestamp_us(at: std::time::Instant) -> u64 {
    static EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    at.saturating_duration_since(*EPOCH.get_or_init(|| at))
        .as_micros() as u64
}

#[derive(Debug, Clone, Copy)]
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
    pub visible: bool,
    pub hotspot: Option<(i32, i32)>,
    pub timestamp_us: u64,
}
