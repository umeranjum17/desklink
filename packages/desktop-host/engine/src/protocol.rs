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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    View,
    Control,
    Clipboard,
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

#[derive(Debug, Deserialize)]
pub struct OpenParams {
    /// Absent means "the portal, with the user's consent".
    #[serde(default)]
    pub source: Option<SourceRequest>,
    #[serde(default)]
    pub permissions: Vec<Permission>,
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
fn default_fps() -> u32 {
    30
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerPhase {
    Move,
    Down,
    Up,
    Cancel,
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
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pointer_message_round_trips_with_its_sequence() {
        let parsed: ControlMessage =
            serde_json::from_str(r#"{"kind":"pointer","phase":"down","x":10,"y":20,"seq":3}"#)
                .unwrap();
        match parsed {
            ControlMessage::Pointer {
                phase,
                x,
                y,
                seq,
                button,
            } => {
                assert!(matches!(phase, PointerPhase::Down));
                assert_eq!((x, y, seq, button), (10, 20, 3, 1));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn an_unknown_action_is_refused_rather_than_ignored() {
        assert!(serde_json::from_str::<ControlMessage>(r#"{"kind":"teleport"}"#).is_err());
    }

    #[test]
    fn display_source_round_trips_its_explicit_id() {
        let request: SourceRequest = serde_json::from_value(serde_json::json!({
            "kind": "display",
            "display_id": 42
        }))
        .unwrap();
        assert!(matches!(
            request,
            SourceRequest::Display {
                display_id: Some(42)
            }
        ));
    }

    #[test]
    fn an_encoded_source_names_its_codec_and_its_own_size() {
        let request: SourceRequest = serde_json::from_value(serde_json::json!({
            "kind": "encoded",
            "codec": "h264",
            "width": 486,
            "height": 1080
        }))
        .unwrap();
        assert!(matches!(
            request,
            SourceRequest::Encoded {
                codec: EncodedCodec::H264,
                width: 486,
                height: 1080
            }
        ));
    }

    #[test]
    fn an_unknown_encoded_codec_is_refused_rather_than_guessed() {
        assert!(serde_json::from_value::<SourceRequest>(serde_json::json!({
            "kind": "encoded",
            "codec": "av1",
            "width": 486,
            "height": 1080
        }))
        .is_err());
    }

    #[test]
    fn a_feed_request_is_one_access_unit_with_its_own_keyframe_flag() {
        let params: FeedParams =
            serde_json::from_str(r#"{"session_id":"s","keyframe":true,"data_b64":"AAAA"}"#)
                .unwrap();
        assert_eq!(params.session_id, "s");
        assert!(params.keyframe, "a feed says whether its unit is an IDR");
        assert_eq!(params.data_b64, "AAAA");
        assert_eq!(params.access_unit().unwrap(), vec![0x00, 0x00, 0x00]);
    }

    #[test]
    fn a_feed_request_that_is_not_base64_is_refused() {
        let params = FeedParams {
            session_id: String::from("s"),
            keyframe: false,
            data_b64: String::from("not base64!!"),
        };
        assert!(params.access_unit().is_err());
    }

    /// The reason this protocol carries bytes in base64 rather than adding a
    /// second inherited fd: at 2 Mbit/s it costs a fraction of a per cent of a
    /// core, against a whole second channel to keep ordered and bounded. The
    /// bound below is deliberately loose — it is a sanity check on the order of
    /// magnitude, not a benchmark, so it does not flake on a loaded machine.
    #[test]
    fn decoding_a_two_megabit_stream_is_nowhere_near_a_core() {
        // One second of a 2 Mbit/s stream, in access units.
        let unit: Vec<u8> = (0..8_000u32).map(|index| index as u8).collect();
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &unit);
        let params = FeedParams {
            session_id: String::from("s"),
            keyframe: false,
            data_b64: encoded,
        };
        let started = std::time::Instant::now();
        for _ in 0..(250_000 / unit.len()) {
            assert_eq!(params.access_unit().unwrap().len(), unit.len());
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "a second of 2 Mbit/s base64 took {elapsed:?}, which is far past 5 % of a core",
        );
        println!("a second of 2 Mbit/s stream decoded in {elapsed:?}");
    }

    #[test]
    fn open_defaults_keep_the_desktops_own_pixels_up_to_4k() {
        let params: OpenParams =
            serde_json::from_str(r#"{"permissions":["view","control"]}"#).unwrap();
        assert_eq!(params.max_width, 3840);
        assert_eq!(params.max_height, 2160);
        assert_eq!(
            params.bitrate_kbps, 0,
            "the engine sizes the rate to the surface"
        );
        assert_eq!(params.max_fps, 30);
        assert!(params.local_frames, "session.frame works unless turned off");
        assert!(
            !params.agent_indicator,
            "human control has no overlay by default"
        );
        let agent: OpenParams =
            serde_json::from_str(r#"{"permissions":["view","control"],"agent_indicator":true}"#)
                .unwrap();
        assert!(agent.agent_indicator);
    }
}
