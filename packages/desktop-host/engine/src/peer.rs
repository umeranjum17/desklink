//! The WebRTC handoff: one video track out, one control data channel in.
//!
//! The engine is the offerer. The consumer's own authenticated channel carries
//! the SDP and ICE candidates to the client and brings the answer back; this
//! module never assumes anything about that channel, which is what keeps the
//! engine usable by an application that is not this one.
//!
//! Input and clipboard ride the session's data channel rather than the local
//! protocol. The channel is inside the DTLS/SRTP session the engine created for
//! one authorized grant, so it inherits that session's identity and dies with
//! it — a revoked session cannot be driven by a client that kept a socket open.

use anyhow::{Context, Result};
use rtc::interceptor::{
    Attribute, BandwidthEstimator, CongestionControlBuilder, Interceptor, PacerBuilder, Packet,
    PacketReport, Registry, Slot, StreamInfo, TaggedPacket, TwccSenderBuilder,
};
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::{
    MediaEngine, MIME_TYPE_H264, MIME_TYPE_VP9,
};
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::event::RTCPeerConnectionIceEvent;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::{RTCIceCandidateInit, RTCIceServer};
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtcp::receiver_report::ReceiverReport;
use rtc::rtp::extension::playout_delay_extension::PlayoutDelayExtension;
use rtc::rtp::extension::HeaderExtension;
use rtc::rtp_transceiver::rtp_sender::{
    RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters,
    RTCRtpEncodingParameters, RTCRtpHeaderExtensionCapability, RtpCodecKind,
};
use rtc::rtp_transceiver::PayloadType;
use rtc::sansio::Protocol;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCPeerConnectionState,
};
use webrtc::runtime::default_runtime;

/// VP9 clock rate, fixed by RFC 9628.
const VP9_CLOCK_RATE: u32 = 90_000;

/// Payload type the engine offers VP9 on. Any value in the dynamic range works;
/// this one is the common convention and keeps packet captures readable.
pub const VP9_PAYLOAD_TYPE: PayloadType = 98;

/// H.264's RTP clock is 90 kHz (RFC 6184), the same as VP9's.
const H264_CLOCK_RATE: u32 = 90_000;

/// Payload type the engine offers H.264 on, again a dynamic-range convention.
pub const H264_PAYLOAD_TYPE: PayloadType = 102;

/// Which video track this peer carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoCodec {
    /// VP9 in flexible mode, encoded by this engine from captured frames.
    Vp9,
    /// Captured frames again, offered as VP9 first and H.264 second: the
    /// receiver's answer picks, so one that states no preference keeps VP9,
    /// and one whose platform decodes only H.264 in hardware can ask for it.
    Vp9OrH264,
    /// H.264 the consumer encoded and feeds. The profile-level-id is read from
    /// the fed stream's own SPS, so a receiver's decoder is configured for the
    /// profile actually arriving rather than for one the engine guessed.
    H264 { profile_level_id: String },
}

fn vp9_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_VP9.to_owned(),
            clock_rate: VP9_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: Vec::new(),
        },
        payload_type: VP9_PAYLOAD_TYPE,
        ..Default::default()
    }
}

/// H.264 with `packetization-mode=1`, which is what the device helpers emit and
/// what every WebRTC receiver implements. Key frame requests are negotiated so
/// the receiver has a defined way to ask; for a fed stream the engine turns one
/// into a `session.keyframeRequest` for the consumer that owns the encoder.
fn h264_codec(profile_level_id: &str) -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: H264_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: format!(
                "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id={profile_level_id}"
            ),
            rtcp_feedback: [("nack", ""), ("nack", "pli"), ("ccm", "fir")]
                .into_iter()
                .map(|(typ, parameter)| RTCPFeedback {
                    typ: typ.to_owned(),
                    parameter: parameter.to_owned(),
                })
                .collect(),
        },
        payload_type: H264_PAYLOAD_TYPE,
        ..Default::default()
    }
}

/// The `profile-level-id` an H.264 Annex-B stream declares, as the three bytes
/// after an SPS NAL header: `profile_idc`, the constraint flags, `level_idc`.
///
/// This is the value the offer must carry, and it can only come from the stream
/// itself, so a peer for a fed stream is built after the first access unit
/// rather than at `session.open`.
pub fn h264_profile_level_id(annex_b: &[u8]) -> Option<String> {
    for nalu in AnnexBNalUnits::new(annex_b) {
        let Some(&first) = nalu.first() else {
            continue;
        };
        if first & 0x1f == SPS_NAL_TYPE && nalu.len() >= 4 {
            return Some(format!("{:02x}{:02x}{:02x}", nalu[1], nalu[2], nalu[3]));
        }
    }
    None
}

/// Whether an answer puts H.264 ahead of VP9 on its video section: the
/// receiver's preference, which the codec it is sent follows.
fn answer_prefers_h264(sdp: &str) -> bool {
    let Some(video) = sdp
        .split("\nm=")
        .find(|section| section.trim_start_matches("m=").starts_with("video "))
    else {
        return false;
    };
    let mut lines = video.lines();
    let formats: Vec<&str> = lines
        .next()
        .map(|line| line.split_whitespace().skip(3).collect())
        .unwrap_or_default();
    let names: Vec<(&str, &str)> = lines
        .filter_map(|line| line.trim_end().strip_prefix("a=rtpmap:"))
        .filter_map(|map| map.split_once(' '))
        .collect();
    formats
        .iter()
        .find_map(|format| {
            let (_, name) = names.iter().find(|(pt, _)| pt == format)?;
            let name = name.split('/').next()?.to_ascii_uppercase();
            match name.as_str() {
                "H264" => Some(true),
                "VP9" => Some(false),
                _ => None,
            }
        })
        .unwrap_or(false)
}

/// NAL type 7: sequence parameter set.
const SPS_NAL_TYPE: u8 = 7;

/// A byte stream's NAL units, delimited by the Annex-B start code
/// (`00 00 01`, optionally preceded by zero bytes).
struct AnnexBNalUnits<'a> {
    rest: &'a [u8],
}

impl<'a> AnnexBNalUnits<'a> {
    fn new(stream: &'a [u8]) -> Self {
        Self { rest: stream }
    }

    fn start_code(stream: &[u8]) -> Option<usize> {
        stream
            .windows(3)
            .position(|window| window == [0x00, 0x00, 0x01])
    }
}

impl<'a> Iterator for AnnexBNalUnits<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<Self::Item> {
        let start = Self::start_code(self.rest)? + 3;
        let body = &self.rest[start..];
        let end = Self::start_code(body).map_or(body.len(), |next| {
            // A four-byte start code includes the zero the three-byte search
            // left at the end of the previous unit.
            if next > 0 && body[next - 1] == 0x00 {
                next - 1
            } else {
                next
            }
        });
        self.rest = &body[end..];
        Some(&body[..end])
    }
}

/// What the consumer needs to know about a live peer.
#[derive(Debug, Clone)]
pub enum PeerEvent {
    /// A local ICE candidate to forward to the client.
    Candidate {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    },
    /// The transport reached a new state.
    State(RTCPeerConnectionState),
    /// The control channel opened; input may now be accepted.
    ControlOpen,
    /// The control channel closed.
    ControlClosed,
    /// A control message arrived from the client.
    ControlMessage(String),
    /// The far end asked for a fresh reference frame (RTCP PLI or FIR) on a
    /// track this engine does not encode itself, so the consumer must supply one.
    KeyframeRequest,
}

/// Transport settings the consumer chose for this session.
#[derive(Debug, Clone)]
pub struct TransportOptions {
    pub ice_servers: Vec<(String, Option<String>, Option<String>)>,
    /// Listen for ICE over TCP on the loopback too. A phone that reaches this
    /// computer only through SSH has no UDP path; it forwards this port over
    /// the SSH connection it already has, and the picture rides that.
    pub loopback_tcp: bool,
    /// The rate video packets are released at, in bits per second.
    pub pace_bps: f64,
}

/// What the pacer lets go back to back: a few dozen packets. A 4K key frame is
/// hundreds of packets, and released at once it overflows the receiver's
/// socket buffer, which loses the frame and draws another key frame request —
/// a loop that never shows a sharp picture.
const PACE_BURST_BITS: f64 = 256_000.0;

/// The receiver's playout delay, stated on every video packet: none. A
/// remote desktop answers the hand that is driving it, so a frame should be
/// shown when it is decoded rather than held in a jitter buffer to smooth
/// playback; a browser otherwise adds about 10 ms of buffering and paces
/// presentation to its own cadence, costing both latency and frames.
const PLAYOUT_DELAY_URI: &str = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay";
const NO_PLAYOUT_DELAY: HeaderExtension = HeaderExtension::PlayoutDelay(PlayoutDelayExtension {
    min_delay: 0,
    max_delay: 0,
});
/// What the far end's transport-wide feedback says about the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathReport {
    /// The queueing delay no packet escaped over the last `STANDING_WINDOW`:
    /// the lowest one-way delay in it above the lowest the path has shown. A
    /// burst that one frame queues up lifts some packets, not all of them; a
    /// link carrying more than it can drain lifts every one.
    pub queue_delay: Duration,
    /// What arrived over the last `DELIVERED_WINDOW`, in kbps.
    pub delivered_kbps: u32,
}

/// How long the lowest one-way delay is remembered: a path's base delay is the
/// lowest of the last one to two of these, so a queue that stands for a while
/// is still measured against the empty path, and a route change is learnt.
const FLOOR_WINDOW: Duration = Duration::from_secs(15);
const STANDING_WINDOW: Duration = Duration::from_millis(200);
const DELIVERED_WINDOW: Duration = Duration::from_millis(500);

/// Reads the queueing delay out of transport-wide congestion feedback (every
/// packet's departure here against its arrival there) for the session's rate
/// control to act on. The rate decision stays in the session, beside the
/// encoder it drives; this only measures. Its own "target" is the constant
/// pacing rate, so the pacer is never retargeted from here.
struct QueueDelay {
    report: Arc<Mutex<Option<PathReport>>>,
    pace_bps: f64,
    epoch: Option<Instant>,
    /// The lowest one-way delay in the previous and the current window, in µs
    /// on an arbitrary offset (the two clocks are not synchronized).
    floor: [i64; 2],
    floor_since: Option<Instant>,
    /// Recent arrivals: arrival and one-way delay in µs, size in bytes.
    recent: VecDeque<(i64, i64, usize)>,
}

impl QueueDelay {
    fn new(report: Arc<Mutex<Option<PathReport>>>, pace_bps: f64) -> Self {
        Self {
            report,
            pace_bps,
            epoch: None,
            floor: [i64::MAX; 2],
            floor_since: None,
            recent: VecDeque::new(),
        }
    }
}

impl BandwidthEstimator for QueueDelay {
    fn on_reports(&mut self, now: Instant, reports: &[PacketReport]) {
        let Some(first) = reports.first() else {
            return;
        };
        let epoch = *self.epoch.get_or_insert(first.departure);
        let before = self.recent.len();
        for report in reports {
            let Some(arrival) = report.arrival.filter(|_| report.arrived) else {
                continue;
            };
            let arrival = arrival.as_micros() as i64;
            let delay = arrival
                - report
                    .departure
                    .saturating_duration_since(epoch)
                    .as_micros() as i64;
            self.floor[1] = self.floor[1].min(delay);
            self.recent.push_back((arrival, delay, report.size));
        }
        let since = *self.floor_since.get_or_insert(now);
        if now.saturating_duration_since(since) >= FLOOR_WINDOW {
            self.floor = [self.floor[1], i64::MAX];
            self.floor_since = Some(now);
        }
        if self.recent.len() == before {
            return;
        }
        let latest = self.recent.iter().map(|(at, _, _)| *at).max().unwrap_or(0);
        let delivered_since = latest - DELIVERED_WINDOW.as_micros() as i64;
        self.recent.retain(|(at, _, _)| *at >= delivered_since);
        let standing_since = latest - STANDING_WINDOW.as_micros() as i64;
        let standing = self
            .recent
            .iter()
            .filter(|(at, _, _)| *at >= standing_since)
            .map(|(_, delay, _)| *delay)
            .min()
            .unwrap_or(0);
        let base = self.floor[0].min(self.floor[1]);
        let bytes: usize = self.recent.iter().map(|(_, _, size)| size).sum();
        *lock(&self.report) = Some(PathReport {
            queue_delay: Duration::from_micros(standing.saturating_sub(base).max(0) as u64),
            delivered_kbps: (bytes as u64 * 8 * 1000 / DELIVERED_WINDOW.as_micros() as u64)
                .min(u32::MAX as u64) as u32,
        });
    }

    fn target_bitrate(&self) -> f64 {
        self.pace_bps
    }
}

struct Handler {
    events: tokio::sync::mpsc::UnboundedSender<PeerEvent>,
    wants_keyframe: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
}

/// Watch the control channel the engine created.
///
/// The engine is the offerer, so it is the side that creates this channel, and
/// `on_data_channel` only fires for a channel the *remote* opened. Serving our
/// own channel is what makes the session two-way: a client that creates its own
/// channel with the same label gets an unrelated stream, its requests arrive
/// here and every reply lands on a channel nobody is reading.
async fn serve_control(
    channel: Arc<dyn DataChannel>,
    events: tokio::sync::mpsc::UnboundedSender<PeerEvent>,
) {
    // A heartbeat the client watches: ICE consent timers take seconds to call
    // a dead path disconnected, while a missing heartbeat reads as stalled
    // within about a second. Cheap on purpose — seventeen bytes twice a second.
    let mut ping = tokio::time::interval(std::time::Duration::from_millis(500));
    loop {
        tokio::select! {
            event = channel.poll() => {
                match event {
                    Some(DataChannelEvent::OnOpen) => {
                        let _ = events.send(PeerEvent::ControlOpen);
                    }
                    Some(DataChannelEvent::OnMessage(message)) => {
                        if let Ok(text) = String::from_utf8(message.data.to_vec()) {
                            let _ = events.send(PeerEvent::ControlMessage(text));
                        }
                    }
                    Some(DataChannelEvent::OnClose) => {
                        let _ = events.send(PeerEvent::ControlClosed);
                        break;
                    }
                    Some(_) => {}
                    None => break,
                }
            }
            _ = ping.tick() => {
                let _ = channel.send_text(r#"{"kind":"ping"}"#).await;
            }
        }
    }
    let _ = events.send(PeerEvent::ControlClosed);
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            let _ = self.events.send(PeerEvent::Candidate {
                candidate: init.candidate,
                sdp_mid: init.sdp_mid,
                sdp_m_line_index: init.sdp_mline_index,
            });
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let connected = matches!(state, RTCPeerConnectionState::Connected);
        if connected {
            self.wants_keyframe.store(true, Ordering::SeqCst);
        }
        self.connected.store(connected, Ordering::SeqCst);
        let _ = self.events.send(PeerEvent::State(state));
    }

    async fn on_data_channel(&self, _channel: Arc<dyn DataChannel>) {
        // The engine's own channel is served by `serve_control`. A channel the
        // remote opens is a second, unrelated stream and is deliberately not
        // adopted: two control channels would mean two ways to drive one
        // desktop, which is the ambiguity this protocol exists to avoid.
    }
}

/// Passes the application the inbound RTCP only it can act on: a receiver
/// asking for a key frame (PLI, FIR), and receiver reports, whose loss figure
/// sets how much the encoder may send. Everything else stays with the
/// interceptors that consume it (NACK, reports), and so does a copy of these:
/// this sits last, after all of them.
#[derive(Default)]
struct FeedbackForwarder {
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
}

fn is_feedback(packet: &Box<dyn rtc::rtcp::Packet>) -> bool {
    let packet = packet.as_any();
    packet.is::<PictureLossIndication>()
        || packet.is::<FullIntraRequest>()
        || packet.is::<ReceiverReport>()
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for FeedbackForwarder {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
            let wanted: Vec<Box<dyn rtc::rtcp::Packet>> = packets
                .iter()
                .filter(|packet| is_feedback(packet))
                .cloned()
                .collect();
            if wanted.is_empty() {
                return Ok(());
            }
            msg.message.packet = Packet::Rtcp(wanted);
            // Inbound RTCP ends at the chain's last stage unless marked for us.
            msg.message.add(Attribute::DeliverToApplication);
        }
        self.read.push_back(msg);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        self.write.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}

impl Interceptor for FeedbackForwarder {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}

/// Read the video sender's feedback until the peer closes it (by aborting this
/// task: the track's feedback channel outlives a closed peer): key frame
/// requests set `wants_keyframe`, receiver reports queue their loss fraction,
/// and a track whose encoder lives in the consumer is told to ask for one.
async fn serve_feedback(
    track: Arc<TrackLocalStaticRTP>,
    ssrc: u32,
    wants_keyframe: Arc<AtomicBool>,
    loss: Arc<Mutex<Vec<u8>>>,
    keyframe_requests: Option<tokio::sync::mpsc::UnboundedSender<PeerEvent>>,
) {
    loop {
        // The track is bound once the answer is applied; until then, and after
        // it is unbound, there is nothing to read.
        let Some(TrackLocalEvent::OnRtcpPacket(packets)) = track.poll().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        for packet in &packets {
            let packet = packet.as_any();
            if packet.is::<PictureLossIndication>() || packet.is::<FullIntraRequest>() {
                wants_keyframe.store(true, Ordering::SeqCst);
                if let Some(requests) = &keyframe_requests {
                    let _ = requests.send(PeerEvent::KeyframeRequest);
                }
            } else if let Some(report) = packet.downcast_ref::<ReceiverReport>() {
                let mut queue = lock(&loss);
                queue.extend(
                    report
                        .reports
                        .iter()
                        .filter(|r| r.ssrc == ssrc)
                        .map(|r| r.fraction_lost),
                );
                let excess = queue.len().saturating_sub(64);
                queue.drain(..excess);
            }
        }
    }
}

/// The largest RTP packet the engine sends, headers included: under every
/// path MTU a desktop stream meets, DTLS/SRTP and TURN overhead included.
const RTP_MTU: usize = 1200;
const RTP_HEADER: usize = 12;

/// One encoded track's packetizer. The engine builds RTP headers itself either
/// way — the payloaders below only decide how a frame's bytes are split — so the
/// codec only changes which ones run.
enum Packetizer {
    Vp9(Vp9Packetizer),
    H264(H264Packetizer),
}

impl Packetizer {
    fn packetize(
        &mut self,
        frame: &[u8],
        keyframe: bool,
        captured: Instant,
        ssrc: u32,
        payload_type: PayloadType,
    ) -> Result<Vec<rtc::rtp::Packet>> {
        match self {
            Self::Vp9(packetizer) => {
                Ok(packetizer.packetize(frame, keyframe, captured, ssrc, payload_type))
            }
            Self::H264(packetizer) => packetizer.packetize(frame, captured, ssrc, payload_type),
        }
    }
}

/// H.264 over RTP (RFC 6184), packetization mode 1: single NAL units, STAP-A for
/// the parameter sets, FU-A for anything over the MTU. The fragmentation itself
/// is webrtc-rs's own H.264 payloader (`RTCRtpCodec::payloader`), which already
/// implements those three payload shapes; only the RTP header is built here, so
/// the timestamp is the arrival time of the access unit rather than the moment
/// each fragment happened to be written.
struct H264Packetizer {
    sequence: u16,
    timestamp_base: u32,
    started: Instant,
    payloader: Box<dyn rtc::rtp::packetizer::Payloader>,
}

impl H264Packetizer {
    fn new(payloader: Box<dyn rtc::rtp::packetizer::Payloader>) -> Self {
        Self {
            sequence: rand::random(),
            timestamp_base: rand::random(),
            started: Instant::now(),
            payloader,
        }
    }

    fn packetize(
        &mut self,
        access_unit: &[u8],
        arrived: Instant,
        ssrc: u32,
        payload_type: PayloadType,
    ) -> Result<Vec<rtc::rtp::Packet>> {
        let payloads = self
            .payloader
            .payload(
                RTP_MTU - RTP_HEADER,
                &bytes::Bytes::copy_from_slice(access_unit),
            )
            .map_err(|error| {
                anyhow::anyhow!("the H.264 payloader refused an access unit: {error}")
            })?;
        let ticks = (arrived
            .saturating_duration_since(self.started)
            .as_secs_f64()
            * H264_CLOCK_RATE as f64) as u64 as u32;
        let timestamp = self.timestamp_base.wrapping_add(ticks);
        let last = payloads.len().saturating_sub(1);
        Ok(payloads
            .into_iter()
            .enumerate()
            .map(|(index, payload)| {
                let sequence_number = self.sequence;
                self.sequence = self.sequence.wrapping_add(1);
                rtc::rtp::Packet {
                    header: rtc::rtp::Header {
                        version: 2,
                        // The marker ends an access unit, which is what a video
                        // receiver uses to hand a complete picture to its decoder.
                        marker: index == last,
                        payload_type,
                        sequence_number,
                        timestamp,
                        ssrc,
                        ..Default::default()
                    },
                    payload,
                }
            })
            .collect())
    }
}

/// VP9 over RTP (RFC 9628) in flexible mode, one layer.
///
/// The payload descriptor is what a receiver builds its reference graph from,
/// so it has to tell the truth about each frame: a key frame is not
/// inter-predicted, and every other frame is, with the previous picture as its
/// reference. A descriptor that marks every frame as independent (as a generic
/// payloader does) makes the receiver drop the frames that are not really
/// independent and ask for key frames instead — the picture only moves on key
/// frames, which is exactly the failure a desktop cannot hide.
struct Vp9Packetizer {
    sequence: u16,
    picture_id: u16,
    timestamp_base: u32,
    started: Instant,
}

impl Vp9Packetizer {
    fn new() -> Self {
        Self {
            sequence: rand::random(),
            picture_id: rand::random::<u16>() & 0x7fff,
            timestamp_base: rand::random(),
            started: Instant::now(),
        }
    }

    fn packetize(
        &mut self,
        frame: &[u8],
        keyframe: bool,
        captured: Instant,
        ssrc: u32,
        payload_type: PayloadType,
    ) -> Vec<rtc::rtp::Packet> {
        // The RTP clock is the capture clock, so the receiver paces playout by
        // when frames were taken, not by when they happened to be sent.
        // Wraps, as the RTP clock does, rather than saturating after 13 hours.
        let ticks = (captured
            .saturating_duration_since(self.started)
            .as_secs_f64()
            * VP9_CLOCK_RATE as f64) as u64 as u32;
        let timestamp = self.timestamp_base.wrapping_add(ticks);
        let descriptor = if keyframe { 3 } else { 4 };
        let chunks: Vec<&[u8]> = frame.chunks(RTP_MTU - RTP_HEADER - descriptor).collect();
        let last = chunks.len().saturating_sub(1);
        let packets = chunks
            .into_iter()
            .enumerate()
            .map(|(index, chunk)| {
                let mut payload = bytes::BytesMut::with_capacity(descriptor + chunk.len());
                // I (picture id) and F (flexible mode) always; P for an inter
                // frame; B and E mark the frame's first and last packet.
                let mut first = 0x80 | 0x10;
                if !keyframe {
                    first |= 0x40;
                }
                if index == 0 {
                    first |= 0x08;
                }
                if index == last {
                    first |= 0x04;
                }
                payload.extend_from_slice(&[
                    first,
                    0x80 | (self.picture_id >> 8) as u8,
                    self.picture_id as u8,
                ]);
                if !keyframe {
                    // One reference: the previous picture (P_DIFF 1, N 0).
                    payload.extend_from_slice(&[1 << 1]);
                }
                payload.extend_from_slice(chunk);
                let sequence_number = self.sequence;
                self.sequence = self.sequence.wrapping_add(1);
                rtc::rtp::Packet {
                    header: rtc::rtp::Header {
                        version: 2,
                        marker: index == last,
                        payload_type,
                        sequence_number,
                        timestamp,
                        ssrc,
                        ..Default::default()
                    },
                    payload: payload.freeze(),
                }
            })
            .collect();
        self.picture_id = (self.picture_id + 1) & 0x7fff;
        packets
    }
}

pub struct VideoPeer {
    peer: Arc<dyn PeerConnection>,
    /// Set when the far end needs a fresh reference frame.
    ///
    /// The encoder's first frame is a key frame, but the far end is not
    /// receiving yet: ICE is still negotiating, and the decoder therefore starts
    /// mid-stream without the reference the following inter frames need. Asking
    /// for a key frame *when the transport connects* is what makes the picture
    /// appear at all; without it the browser reports frames received and zero
    /// frames decoded, which is exactly the failure this was.
    wants_keyframe: Arc<AtomicBool>,
    /// True while the transport is connected: frames sent before it are lost.
    connected: Arc<AtomicBool>,
    /// True when the answer accepted the playout-delay extension. A packet
    /// carrying an extension the answer declined is dropped whole by the
    /// sender, so a receiver that declines it would get no picture at all.
    playout_delay: AtomicBool,
    track: Arc<TrackLocalStaticRTP>,
    packetizer: Mutex<Packetizer>,
    ssrc: u32,
    control: Arc<dyn DataChannel>,
    /// The payload type frames go out on; H.264's once an answer to a
    /// `Vp9OrH264` offer prefers it.
    payload_type: std::sync::atomic::AtomicU8,
    /// Offered H.264 beside VP9, for the answer to pick.
    offers_h264: bool,
    /// The answer picked H.264: the encoder has to follow.
    sends_h264: AtomicBool,
    /// Loss fractions (RFC 3550, /256) the far end reported, oldest first.
    loss: Arc<Mutex<Vec<u8>>>,
    /// The latest queueing delay transport-wide feedback showed, if any.
    path: Arc<Mutex<Option<PathReport>>>,
    feedback: tokio::task::JoinHandle<()>,
    /// The engine is the offerer, so a candidate can arrive before the answer
    /// that supplies its remote description; those are held here until it does.
    candidates: Mutex<PendingCandidates>,
}

#[derive(Default)]
struct PendingCandidates {
    ready: bool,
    held: Vec<RTCIceCandidateInit>,
}

impl VideoPeer {
    /// Build the peer, add the video track and the control channel, and produce
    /// the offer for the consumer to carry to the client.
    pub async fn offer(
        options: TransportOptions,
        events: tokio::sync::mpsc::UnboundedSender<PeerEvent>,
        codec: VideoCodec,
    ) -> Result<(Self, String)> {
        let runtime = default_runtime().context("no WebRTC runtime is enabled")?;

        let mut media_engine = MediaEngine::default();
        // In preference order: the offer lists them so, and a receiver that
        // states no preference of its own answers with the first.
        let video_codecs = match &codec {
            VideoCodec::Vp9 => vec![vp9_codec()],
            VideoCodec::Vp9OrH264 => vec![
                vp9_codec(),
                h264_codec(crate::h264::PROFILE_LEVEL_ID),
            ],
            VideoCodec::H264 { profile_level_id } => vec![h264_codec(profile_level_id)],
        };
        let video_codec = video_codecs[0].clone();
        for offered in &video_codecs {
            media_engine
                .register_codec(offered.clone(), RtpCodecKind::Video)
                .with_context(|| format!("failed to offer {codec:?}"))?;
        }
        media_engine
            .register_header_extension(
                RTCRtpHeaderExtensionCapability {
                    uri: String::from(PLAYOUT_DELAY_URI),
                },
                RtpCodecKind::Video,
                None,
            )
            .context("failed to offer the playout-delay extension")?;
        let path = Arc::new(Mutex::new(None));
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?
            .with(
                Slot::Pacer,
                PacerBuilder::new()
                    .with_target_bitrate(options.pace_bps)
                    .with_burst_bits(PACE_BURST_BITS)
                    .build(),
            )
            // Number every packet transport-wide, so the receiver reports when
            // each one arrived, and read those reports for the queueing delay.
            .with(Slot::TwccSender, TwccSenderBuilder::new().build())
            .with(
                Slot::CongestionControl,
                CongestionControlBuilder::new(QueueDelay::new(path.clone(), options.pace_bps))
                    .build(),
            )
            // Last, so every interceptor has seen the whole of the inbound RTCP.
            .with(Slot::from(14_000), FeedbackForwarder::default());

        let mut builder = RTCConfigurationBuilder::new();
        if !options.ice_servers.is_empty() {
            builder = builder.with_ice_servers(
                options
                    .ice_servers
                    .iter()
                    .map(|(url, username, credential)| RTCIceServer {
                        urls: vec![url.clone()],
                        username: username.clone().unwrap_or_default(),
                        credential: credential.clone().unwrap_or_default(),
                    })
                    .collect(),
            );
        }
        let wants_keyframe = Arc::new(AtomicBool::new(true));
        let connected = Arc::new(AtomicBool::new(false));
        let control_events = events.clone();
        // A track this engine encodes itself needs no notification: the pipeline
        // reads `wants_keyframe` directly. A fed track's encoder lives in the
        // consumer, so a key frame request has to travel back as an event.
        let keyframe_requests = matches!(codec, VideoCodec::H264 { .. }).then(|| events.clone());
        let peer = PeerConnectionBuilder::<std::net::SocketAddr>::new()
            .with_configuration(builder.build())
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_handler(Arc::new(Handler {
                events,
                wants_keyframe: wants_keyframe.clone(),
                connected: connected.clone(),
            }))
            .with_runtime(runtime)
            // An ephemeral port on every interface: ICE needs a socket to gather
            // candidates from, and the peer needs no fixed port because the
            // consumer's authenticated channel carries the candidates.
            .with_udp_addrs(vec![std::net::SocketAddr::from(([0, 0, 0, 0], 0))])
            .with_tcp_addrs(if options.loopback_tcp {
                vec![std::net::SocketAddr::from(([127, 0, 0, 1], 0))]
            } else {
                Vec::new()
            })
            .build()
            .await
            .context("failed to create the peer connection")?;
        let peer: Arc<dyn PeerConnection> = Arc::new(peer);

        let ssrc = rand::random::<u32>();
        let track: Arc<TrackLocalStaticRTP> =
            Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
                String::from("desklink"),
                String::from("desktop"),
                String::from("desktop"),
                RtpCodecKind::Video,
                // One encoding per offered codec is how a track states its
                // codec preferences; one stream is sent, on the first.
                video_codecs
                    .iter()
                    .map(|offered| RTCRtpEncodingParameters {
                        rtp_coding_parameters: RTCRtpCodingParameters {
                            ssrc: Some(ssrc),
                            ..Default::default()
                        },
                        codec: offered.rtp_codec.clone(),
                        ..Default::default()
                    })
                    .collect(),
            )));
        let sender = peer
            .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
            .await
            .context("failed to add the video track")?;
        let payload_type = sender
            .get_parameters()
            .await?
            .rtp_parameters
            .codecs
            .first()
            .map(|codec| codec.payload_type)
            .context("the video sender has no negotiated codec")?;

        let control = peer
            .create_data_channel("control", None)
            .await
            .context("failed to create the control channel")?;
        tokio::spawn(serve_control(Arc::clone(&control), control_events));

        let loss = Arc::new(Mutex::new(Vec::new()));
        let feedback = tokio::spawn(serve_feedback(
            Arc::clone(&track),
            ssrc,
            wants_keyframe.clone(),
            loss.clone(),
            keyframe_requests,
        ));

        let packetizer = match &codec {
            VideoCodec::Vp9 | VideoCodec::Vp9OrH264 => Packetizer::Vp9(Vp9Packetizer::new()),
            VideoCodec::H264 { .. } => Packetizer::H264(H264Packetizer::new(
                video_codec
                    .rtp_codec
                    .payloader()
                    .context("the media engine has no H.264 payloader")?,
            )),
        };

        let offer = peer.create_offer(None).await?;
        peer.set_local_description(offer.clone()).await?;

        Ok((
            Self {
                peer,
                wants_keyframe,
                connected,
                playout_delay: AtomicBool::new(false),
                track,
                packetizer: Mutex::new(packetizer),
                ssrc,
                control,
                payload_type: std::sync::atomic::AtomicU8::new(payload_type),
                offers_h264: codec == VideoCodec::Vp9OrH264,
                sends_h264: AtomicBool::new(false),
                loss,
                path,
                feedback,
                candidates: Mutex::new(PendingCandidates::default()),
            },
            offer.sdp,
        ))
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<usize> {
        let answer = RTCSessionDescription::answer(sdp).context("the answer is not valid SDP")?;
        let prefers_h264 = self.offers_h264 && answer_prefers_h264(&answer.sdp);
        self.peer
            .set_remote_description(answer)
            .await
            .context("the peer refused the answer")?;
        // What the sender negotiated is what it checks each packet against.
        let mut playout_delay = false;
        for sender in self.peer.get_senders().await {
            if let Ok(parameters) = sender.get_parameters().await {
                playout_delay |= parameters
                    .rtp_parameters
                    .header_extensions
                    .iter()
                    .any(|extension| extension.uri == PLAYOUT_DELAY_URI);
            }
        }
        self.playout_delay.store(playout_delay, Ordering::SeqCst);
        let (first, held) = {
            let mut state = lock(&self.candidates);
            let first = !state.ready;
            state.ready = true;
            (first, std::mem::take(&mut state.held))
        };
        // The first answer picks the codec, before any frame has gone out; an
        // ICE restart's answer comes from the same receiver and keeps it.
        if first && prefers_h264 {
            let payloader = h264_codec(crate::h264::PROFILE_LEVEL_ID)
                .rtp_codec
                .payloader()
                .context("the media engine has no H.264 payloader")?;
            *lock(&self.packetizer) = Packetizer::H264(H264Packetizer::new(payloader));
            self.payload_type
                .store(H264_PAYLOAD_TYPE, Ordering::SeqCst);
            self.sends_h264.store(true, Ordering::SeqCst);
        }
        let mut applied = 0;
        for candidate in held {
            // Each was acknowledged when it arrived; a bad one must not turn the
            // answer into a failure.
            if self.peer.add_ice_candidate(candidate).await.is_ok() {
                applied += 1;
            }
        }
        Ok(applied)
    }

    /// Restart ICE on this peer: a fresh offer with a new ICE generation,
    /// for the client to answer as usual. The engine stays the offerer, so
    /// this is the same local-offer path as the initial negotiation.
    pub async fn restart_ice(&self) -> Result<String> {
        use rtc::peer_connection::configuration::RTCOfferOptions;
        let offer = self
            .peer
            .create_offer(Some(RTCOfferOptions {
                ice_restart: true,
                ..Default::default()
            }))
            .await
            .context("the peer would not offer an ICE restart")?;
        self.peer
            .set_local_description(offer.clone())
            .await
            .context("the peer refused its restart offer")?;
        Ok(offer.sdp)
    }

    pub async fn add_candidate(
        &self,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> Result<()> {
        let candidate = RTCIceCandidateInit {
            candidate,
            sdp_mid,
            sdp_mline_index: sdp_m_line_index,
            username_fragment: None,
            url: None,
        };
        {
            let mut state = lock(&self.candidates);
            if !state.ready {
                state.held.push(candidate);
                return Ok(());
            }
        }
        self.peer
            .add_ice_candidate(candidate)
            .await
            .context("the peer refused an ICE candidate")
    }

    /// Whether the answer asked for H.264 rather than VP9.
    pub fn sends_h264(&self) -> bool {
        self.sends_h264.load(Ordering::SeqCst)
    }

    /// Whether the transport is connected; a frame sent before it is lost.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Stand in for a connected transport, for a pipeline under test.
    #[cfg(test)]
    pub fn assume_connected(&self) {
        self.connected.store(true, Ordering::SeqCst);
    }

    /// Packetize one encoded frame and hand it to the track, paced by the
    /// interceptor chain. `captured` is when its picture was taken — for a fed
    /// stream, when its access unit arrived.
    pub async fn send_frame(&self, data: &[u8], keyframe: bool, captured: Instant) -> Result<()> {
        let packets = lock(&self.packetizer).packetize(
            data,
            keyframe,
            captured,
            self.ssrc,
            self.payload_type.load(Ordering::SeqCst),
        )?;
        let extensions: &[HeaderExtension] = if self.playout_delay.load(Ordering::SeqCst) {
            &[NO_PLAYOUT_DELAY]
        } else {
            &[]
        };
        for packet in packets {
            self.track
                .write_rtp_with_extensions(packet, extensions)
                .await
                .context("failed to hand a packet to the track")?;
        }
        Ok(())
    }

    /// Take the loss fractions reported since the last call, oldest first.
    pub fn take_loss_reports(&self) -> Vec<u8> {
        std::mem::take(&mut *lock(&self.loss))
    }

    /// Take the path report that arrived since the last call, if any; `None`
    /// also when the receiver sends no transport-wide feedback.
    pub fn take_path_report(&self) -> Option<PathReport> {
        lock(&self.path).take()
    }

    /// Take the pending "the far end needs a reference frame" request, if any.
    pub fn take_keyframe_request(&self) -> bool {
        self.wants_keyframe.swap(false, Ordering::SeqCst)
    }

    /// Send a control message back to the client (clipboard replies, revocation).
    pub async fn send_control(&self, message: &str) -> Result<()> {
        self.control
            .send_text(message)
            .await
            .context("the control channel is not writable")
    }

    pub async fn close(&self) {
        self.feedback.abort();
        let _ = self.control.close().await;
        let _ = self.peer.close().await;
    }
}

impl Drop for VideoPeer {
    fn drop(&mut self) {
        self.feedback.abort();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn a_standing_queue_is_measured_and_one_frames_burst_is_not() {
        let epoch = Instant::now();
        let report = Arc::new(Mutex::new(None));
        let mut estimator = QueueDelay::new(report.clone(), 20_000_000.0);
        let mut id = 0u64;
        // One 1200-byte packet every 10 ms, sent at `ms` and `extra` ms late
        // over a path with 20 ms of base delay.
        let mut feed = |from: u64, to: u64, extra: &dyn Fn(u64) -> u64| {
            let reports: Vec<PacketReport> = (from..to)
                .step_by(10)
                .map(|ms| {
                    id += 1;
                    PacketReport {
                        ssrc: 1,
                        id,
                        rtp_sequence_number: id as u16,
                        is_twcc: true,
                        twcc_sequence_number: id as u16,
                        size: 1200,
                        arrived: true,
                        departure: epoch + Duration::from_millis(ms),
                        arrival: Some(Duration::from_millis(1_000 + ms + 20 + extra(ms))),
                        ecn: Default::default(),
                    }
                })
                .collect();
            estimator.on_reports(epoch + Duration::from_millis(to + 20), &reports);
            lock(&report).take().expect("a report")
        };

        let quiet = feed(0, 1000, &|_| 0);
        assert_eq!(quiet.queue_delay, Duration::ZERO);
        // 51 packets of 1200 bytes arrived in the last 500 ms, both ends in.
        assert_eq!(quiet.delivered_kbps, 979);
        // A frame's burst lifts the packets at its tail, not the ones before.
        let burst = feed(1000, 1100, &|ms| if ms >= 1070 { 40 } else { 0 });
        assert_eq!(burst.queue_delay, Duration::ZERO);
        // A link that drains slower than it is fed lifts every packet: the
        // queue is the least any packet of the last 200 ms waited.
        let standing = feed(1100, 1400, &|ms| 30 + (ms - 1100) / 10);
        assert_eq!(standing.queue_delay, Duration::from_millis(41));
    }

    struct NoopHandler;

    impl PeerConnectionEventHandler for NoopHandler {}

    async fn answerer(offer: &str) -> Arc<dyn PeerConnection> {
        answerer_with(offer, vec![vp9_codec()]).await
    }

    /// A receiver that decodes `codecs`, in its order of preference.
    pub(crate) async fn answerer_with(
        offer: &str,
        codecs: Vec<RTCRtpCodecParameters>,
    ) -> Arc<dyn PeerConnection> {
        let mut media_engine = MediaEngine::default();
        for codec in codecs {
            media_engine
                .register_codec(codec, RtpCodecKind::Video)
                .expect("the codec registers");
        }
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .expect("interceptors register");
        let peer = PeerConnectionBuilder::<std::net::SocketAddr>::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_runtime(default_runtime().expect("a runtime"))
            .with_handler(Arc::new(NoopHandler))
            .with_udp_addrs(vec![std::net::SocketAddr::from(([0, 0, 0, 0], 0))])
            .build()
            .await
            .expect("an answering peer");
        peer.set_remote_description(
            RTCSessionDescription::offer(offer.to_owned()).expect("a valid offer"),
        )
        .await
        .expect("the offer is accepted");
        Arc::new(peer)
    }

    #[tokio::test]
    async fn an_encoded_offer_carries_the_streams_own_profile_and_level() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                loopback_tcp: false,
                pace_bps: 20_000_000.0,
            },
            events,
            VideoCodec::H264 {
                profile_level_id: String::from("42c029"),
            },
        )
        .await
        .expect("a peer connection");
        assert!(
            offer.contains("H264/90000"),
            "the encoded track must be offered as H.264: {offer}",
        );
        assert!(
            offer.contains("packetization-mode=1;profile-level-id=42c029"),
            "the offer must name the fed SPS's own profile-level-id: {offer}",
        );
        assert!(
            !offer.contains("VP9"),
            "an encoded source must not also offer the codec it cannot encode: {offer}",
        );
    }

    fn transport() -> TransportOptions {
        TransportOptions {
            ice_servers: Vec::new(),
            loopback_tcp: false,
            pace_bps: 20_000_000.0,
        }
    }

    /// The answer `codecs` make to a `Vp9OrH264` offer, applied to its peer.
    pub(crate) async fn answered(codecs: Vec<RTCRtpCodecParameters>) -> (VideoPeer, String) {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (peer, offer) = VideoPeer::offer(transport(), events, VideoCodec::Vp9OrH264)
            .await
            .expect("a peer connection");
        let other = answerer_with(&offer, codecs).await;
        let answer = other.create_answer(None).await.expect("an answer");
        other
            .set_local_description(answer.clone())
            .await
            .expect("a local description");
        peer.accept_answer(answer.sdp.clone())
            .await
            .expect("the answer is accepted");
        (peer, answer.sdp)
    }

    pub(crate) fn h264_receiver_codec() -> RTCRtpCodecParameters {
        h264_codec(crate::h264::PROFILE_LEVEL_ID)
    }

    #[tokio::test]
    async fn a_captured_offer_puts_vp9_first_and_h264_second() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_peer, offer) = VideoPeer::offer(transport(), events, VideoCodec::Vp9OrH264)
            .await
            .expect("a peer connection");
        let video = offer
            .lines()
            .find(|line| line.starts_with("m=video "))
            .expect("a video section");
        assert!(
            video.ends_with(&format!(" {VP9_PAYLOAD_TYPE} {H264_PAYLOAD_TYPE}")),
            "VP9 is the default a receiver with no preference answers with: {video}",
        );
        assert!(
            offer.contains(&format!(
                "a=fmtp:{H264_PAYLOAD_TYPE} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id={}",
                crate::h264::PROFILE_LEVEL_ID
            )),
            "H.264 is offered as the Constrained Baseline every backend emits: {offer}",
        );
    }

    #[tokio::test]
    async fn the_receivers_first_codec_is_the_one_sent() {
        let (peer, answer) = answered(vec![vp9_codec(), h264_receiver_codec()]).await;
        assert!(
            !peer.sends_h264(),
            "a receiver that keeps the offer's order gets VP9: {answer}"
        );
        let (peer, answer) = answered(vec![h264_receiver_codec()]).await;
        assert!(peer.sends_h264(), "an H.264 receiver gets H.264: {answer}");
        assert_eq!(
            peer.payload_type.load(Ordering::SeqCst),
            H264_PAYLOAD_TYPE,
            "frames go out on the payload type the answer kept",
        );
    }

    #[test]
    fn an_answer_is_read_for_its_video_sections_first_known_codec() {
        let answer = |formats: &str| {
            format!(
                "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n\
                 m=video 9 UDP/TLS/RTP/SAVPF {formats}\r\nc=IN IP4 0.0.0.0\r\n\
                 a=rtpmap:96 rtx/90000\r\na=rtpmap:98 VP9/90000\r\na=rtpmap:102 H264/90000\r\n\
                 m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=rtpmap:5 H264/90000\r\n"
            )
        };
        assert!(answer_prefers_h264(&answer("102 98")));
        assert!(answer_prefers_h264(&answer("96 102 98")), "rtx is skipped");
        assert!(!answer_prefers_h264(&answer("98 102")));
        assert!(!answer_prefers_h264(&answer("98")));
        assert!(!answer_prefers_h264("v=0\r\n"), "no video, no H.264");
    }

    #[tokio::test]
    async fn the_offer_asks_the_receiver_to_show_frames_without_playout_delay() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                loopback_tcp: false,
                pace_bps: 20_000_000.0,
            },
            events,
            VideoCodec::Vp9,
        )
        .await
        .expect("a peer connection");
        assert!(
            offer
                .lines()
                .any(|line| line.starts_with("a=extmap:") && line.ends_with(PLAYOUT_DELAY_URI)),
            "the video must negotiate the playout-delay extension its packets carry: {offer}",
        );
    }

    #[test]
    fn the_profile_level_id_comes_from_the_sps_in_the_stream() {
        // A leading zero byte, a four-byte start code and a three-byte one, so
        // the scanner is exercised on both forms.
        let mut stream = vec![0x00, 0x00, 0x00, 0x01];
        stream.extend_from_slice(&[0x67, 0x42, 0xc0, 0x29, 0x8c, 0x8d]);
        stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);
        stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]);
        assert_eq!(
            h264_profile_level_id(&stream).as_deref(),
            Some("42c029"),
            "profile_idc, constraint flags and level_idc, as the SDP needs them",
        );
        assert_eq!(
            h264_profile_level_id(&[0x00, 0x00, 0x01, 0x65, 0x88]),
            None,
            "a stream with no SPS cannot start a session",
        );
        let mut adjacent = vec![0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01];
        adjacent.extend_from_slice(&[0x67, 0x42, 0xc0, 0x29]);
        assert_eq!(
            h264_profile_level_id(&adjacent).as_deref(),
            Some("42c029"),
            "an empty NAL between start codes is skipped, not fatal to the scan",
        );
    }

    #[test]
    fn a_fed_keyframe_is_packetized_as_parameter_sets_then_a_slice() {
        let mut stream = vec![0x00, 0x00, 0x00, 0x01];
        stream.extend_from_slice(&[0x67, 0x42, 0xc0, 0x29, 0x8c, 0x8d]);
        stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);
        stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]);
        let payloader = h264_codec("42c029")
            .rtp_codec
            .payloader()
            .expect("the media engine has an H.264 payloader");
        let mut packetizer = H264Packetizer::new(payloader);
        let packets = packetizer
            .packetize(&stream, Instant::now(), 7, H264_PAYLOAD_TYPE)
            .expect("a keyframe packetizes");
        assert_eq!(
            packets.len(),
            2,
            "one STAP-A for the parameter sets, one slice"
        );
        assert_eq!(
            packets[0].payload[0], 0x78,
            "the parameter sets travel as a STAP-A",
        );
        assert_eq!(packets[1].payload[0], 0x65, "then the IDR slice itself");
        assert!(
            !packets[0].header.marker && packets[1].header.marker,
            "the marker ends the access unit, not the first fragment of it",
        );
        assert_eq!(
            packets[0].header.timestamp, packets[1].header.timestamp,
            "an access unit is one instant",
        );
        assert_eq!(packets[0].header.payload_type, H264_PAYLOAD_TYPE);
    }

    #[tokio::test]
    async fn a_candidate_that_arrives_before_the_answer_is_not_refused() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (peer, _offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                loopback_tcp: false,
                pace_bps: 20_000_000.0,
            },
            events,
            VideoCodec::Vp9,
        )
        .await
        .expect("a peer connection");

        // The engine is the offerer, so the remote description only arrives with
        // the answer; this candidate must be held, not refused.
        peer.add_candidate(
            String::from("candidate:1 1 udp 2113937151 192.0.2.1 40000 typ host"),
            Some(String::from("0")),
            Some(0),
        )
        .await
        .expect("a candidate that arrives before the answer is buffered");
    }

    #[tokio::test]
    async fn packets_ask_for_no_playout_delay_only_when_the_answer_accepts_it() {
        for accepts in [false, true] {
            let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
            let (peer, offer) = VideoPeer::offer(
                TransportOptions {
                    ice_servers: Vec::new(),
                    loopback_tcp: false,
                    pace_bps: 20_000_000.0,
                },
                events,
                VideoCodec::Vp9,
            )
            .await
            .expect("a peer connection");
            // This answerer knows no playout-delay extension, so it declines it.
            let other = answerer(&offer).await;
            let answer = other.create_answer(None).await.expect("an answer");
            let sdp = if accepts {
                answer.sdp.replacen(
                    "a=mid:0\r\n",
                    &format!("a=mid:0\r\na=extmap:1 {PLAYOUT_DELAY_URI}\r\n"),
                    1,
                )
            } else {
                answer.sdp
            };
            assert_eq!(sdp.contains(PLAYOUT_DELAY_URI), accepts);
            peer.accept_answer(sdp)
                .await
                .expect("the answer is accepted");
            assert_eq!(
                peer.playout_delay.load(Ordering::SeqCst),
                accepts,
                "a packet may carry the extension only when the answer accepted it",
            );
        }
    }

    #[tokio::test]
    async fn held_candidates_reach_the_peer_when_the_answer_arrives() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                loopback_tcp: false,
                pace_bps: 20_000_000.0,
            },
            events,
            VideoCodec::Vp9,
        )
        .await
        .expect("a peer connection");

        let other = answerer(&offer).await;
        let answer = other.create_answer(None).await.expect("an answer");
        other
            .set_local_description(answer.clone())
            .await
            .expect("a local description");

        peer.add_candidate(
            String::from("candidate:1 1 udp 2113937151 192.0.2.1 40000 typ host"),
            Some(String::from("0")),
            Some(0),
        )
        .await
        .expect("a candidate before the answer is buffered");

        let applied = peer
            .accept_answer(answer.sdp)
            .await
            .expect("the answer is accepted");
        assert_eq!(applied, 1, "the held candidate must reach the peer");
    }

    #[tokio::test]
    async fn an_ice_restart_offers_fresh_credentials_on_the_same_peer() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                loopback_tcp: false,
                pace_bps: 20_000_000.0,
            },
            events,
            VideoCodec::Vp9,
        )
        .await
        .expect("a peer connection");

        let other = answerer(&offer).await;
        let answer = other.create_answer(None).await.expect("an answer");
        other
            .set_local_description(answer.clone())
            .await
            .expect("a local description");
        peer.accept_answer(answer.sdp)
            .await
            .expect("the answer is accepted");

        let ufrag = |sdp: &str| {
            sdp.lines()
                .find_map(|line| line.strip_prefix("a=ice-ufrag:"))
                .expect("an ICE username fragment")
                .to_owned()
        };
        let restart = peer.restart_ice().await.expect("a restart offer");
        assert!(
            !restart.is_empty() && ufrag(&restart) != ufrag(&offer),
            "the restart must turn over the ICE generation"
        );
        // The far end answers the restart as usual, on the same peer.
        other
            .set_remote_description(RTCSessionDescription::offer(restart).expect("a valid offer"))
            .await
            .expect("the restart offer applies");
        let reanswer = other.create_answer(None).await.expect("an answer");
        other
            .set_local_description(reanswer.clone())
            .await
            .expect("a local description");
        peer.accept_answer(reanswer.sdp)
            .await
            .expect("the restart answer is accepted");
    }

    #[tokio::test]
    async fn a_forwarded_client_is_offered_ice_over_tcp_on_the_loopback() {
        let offered = |loopback_tcp: bool| async move {
            let (events, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
            let (_peer, offer) = VideoPeer::offer(
                TransportOptions {
                    ice_servers: Vec::new(),
                    loopback_tcp,
                    pace_bps: 20_000_000.0,
                },
                events,
                VideoCodec::Vp9,
            )
            .await
            .expect("a peer connection");
            let mut candidates = vec![offer];
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events_rx.recv()).await {
                if let PeerEvent::Candidate { candidate, .. } = event {
                    candidates.push(candidate);
                }
            }
            candidates.join("\n")
        };
        let passive = |text: &str| {
            text.lines().any(|line| {
                line.contains(" tcp ")
                    && line.contains(" 127.0.0.1 ")
                    && line.contains("tcptype passive")
            })
        };
        assert!(
            passive(&offered(true).await),
            "a client behind a forward needs a passive TCP candidate on the loopback"
        );
        assert!(
            !passive(&offered(false).await),
            "no one else is offered a port on the loopback"
        );
    }
}
