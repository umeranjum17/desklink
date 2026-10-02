//! PipeWire capture of the portal's screen cast node.
//!
//! The portal hands us a PipeWire remote fd and a node id. We connect that
//! remote, ask the node for a format we can read on the CPU, and pull frames.
//! Everything PipeWire lives on this module's own thread because its objects are
//! not `Send`; frames and state changes leave through channels.

use crate::convert::{to_i420, PixelFormat, I420};
use crate::portal::{PortalSession, SelectedSource};
use anyhow::{Context, Result};
use pipewire as pw;
use pw::spa;
use pw::spa::pod::{serialize::PodSerializer, Pod};
use std::io::Cursor;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

impl PixelFormat {
    fn from_spa(raw: u32) -> Self {
        match raw {
            v if v == spa::param::video::VideoFormat::BGRx.as_raw() => Self::Bgrx,
            v if v == spa::param::video::VideoFormat::RGBx.as_raw() => Self::Rgbx,
            v if v == spa::param::video::VideoFormat::BGRA.as_raw() => Self::Bgra,
            v if v == spa::param::video::VideoFormat::RGBA.as_raw() => Self::Rgba,
            v if v == spa::param::video::VideoFormat::BGR.as_raw() => Self::Bgr,
            v if v == spa::param::video::VideoFormat::RGB.as_raw() => Self::Rgb,
            _ => Self::Unsupported,
        }
    }
}

/// Everything we learned about the negotiated stream, reported to the consumer
/// so it can map input against the real surface.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StreamGeometry {
    pub source_width: usize,
    pub source_height: usize,
    pub origin_x: i32,
    pub origin_y: i32,
    pub format: String,
    pub buffer_type: String,
}

/// Receives each converted frame, its sequence number and a way to produce the
/// frame's packed BGRX pixels, which only a local frame consumer needs; the
/// sink calls it at most once, and only then are the pixels copied.
pub type FrameSink = Box<dyn Fn(I420, u64, Pixels) + Send + 'static>;
pub type Pixels<'a> = &'a mut dyn FnMut() -> Option<Vec<u8>>;

/// A running capture. Dropping it quits the PipeWire loop and joins its thread.
pub struct Capture {
    quit: pw::channel::Sender<()>,
    thread: Option<JoinHandle<()>>,
    pub source: SelectedSource,
    cursor_positions: Arc<AtomicBool>,
    geometry: Arc<Mutex<Option<StreamGeometry>>>,
    frames: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    pub encoded_width: usize,
    pub encoded_height: usize,
}

impl Capture {
    pub fn cursor_positions(&self) -> bool {
        self.cursor_positions.load(Ordering::Relaxed)
    }
    pub fn geometry(&self) -> Option<StreamGeometry> {
        self.geometry.lock().ok().and_then(|g| g.clone())
    }

    pub fn frame_count(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // The channel queues a stop even before the loop starts, and remains
        // safe if setup already failed. A shared raw loop pointer does neither.
        let _ = self.quit.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A raw `spa_format`/parameter key, so `property!` can take the `spa_sys`
/// constants that have no `as_raw()` of their own.
struct RawKey(u32);

impl RawKey {
    fn as_raw(&self) -> u32 {
        self.0
    }
}

/// Build the `EnumFormat` we can consume: packed 4-byte colour, at whatever
/// size the compositor picked.
///
/// Deliberately carries **no** `modifier` property. A compositor's screen cast
/// node reads that as "the client wants a DMA-BUF" and hands back a buffer this
/// process could not read without a GPU download step; without it the same node
/// produces a CPU-mappable shared-memory buffer.
fn format_pod(buffer: &mut Vec<u8>, max_fps: u32) -> Result<()> {
    use spa::param::format::{FormatProperties, MediaSubtype, MediaType};
    use spa::param::video::VideoFormat;
    use spa::pod::{object, property, Value};
    use spa::utils::{Fraction, Rectangle, SpaTypes};

    let obj = object!(
        SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        property!(FormatProperties::MediaType, Id, MediaType::Video),
        property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA
        ),
        property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle {
                width: 2560,
                height: 1440
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: 7680,
                height: 4320
            }
        ),
        property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction {
                num: max_fps.min(1000),
                denom: 1
            },
            Fraction { num: 0, denom: 1 },
            Fraction {
                num: 1000,
                denom: 1
            }
        ),
    );
    PodSerializer::serialize(Cursor::new(buffer), &Value::Object(obj))
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("failed to build EnumFormat pod: {e}"))
}

/// Ask for CPU-mappable buffers first. A compositor that only produces
/// DMA-BUFs will ignore the choice and we report that instead of reading garbage.
fn buffer_pod(buffer: &mut Vec<u8>) -> Result<()> {
    use spa::pod::ChoiceValue;
    use spa::pod::{object, property, Value};
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, SpaTypes};
    let obj = object!(
        SpaTypes::ObjectParamBuffers,
        spa::param::ParamType::Buffers,
        property!(
            RawKey(spa::sys::SPA_PARAM_BUFFERS_dataType),
            Value::Choice(ChoiceValue::Int(Choice(
                ChoiceFlags::empty(),
                ChoiceEnum::Flags {
                    default: (1 << spa::buffer::DataType::MemFd.as_raw()) as i32,
                    flags: vec![
                        (1 << spa::buffer::DataType::MemFd.as_raw()) as i32,
                        (1 << spa::buffer::DataType::DmaBuf.as_raw()) as i32,
                    ],
                }
            )))
        ),
    );
    PodSerializer::serialize(Cursor::new(buffer), &Value::Object(obj))
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("failed to build Buffers pod: {e}"))
}

/// Start capturing `session`'s node, delivering I420 frames to `sink`.
#[allow(clippy::too_many_arguments)]
pub fn start(
    session: PortalSession,
    encoded_width: usize,
    encoded_height: usize,
    max_fps: u32,
    cursor_sink: Option<crate::cursor::CursorSink>,
    sink: FrameSink,
    indicator_position: Option<Arc<Mutex<Option<(i64, i64)>>>>,
    on_stop: Box<dyn Fn(String) + Send>,
) -> Result<Capture> {
    let PortalSession {
        fd,
        source,
        cursor_mode,
        ..
    } = session;
    let cursor_positions = Arc::new(AtomicBool::new(false));
    let cursor_sink = if cursor_mode == "metadata" {
        cursor_sink
    } else {
        None
    };
    let geometry = Arc::new(Mutex::new(None));
    let frames = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let (quit, stop) = pw::channel::channel();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let node_id = source.node_id;
    let source_size = (source.width.max(1) as usize, source.height.max(1) as usize);
    let thread = {
        let cursor_positions = cursor_positions.clone();
        let geometry = geometry.clone();
        let frames = frames.clone();
        let dropped = dropped.clone();
        let ready = ready_tx;
        std::thread::Builder::new()
            .name("desklink-capture".into())
            .spawn(move || {
                let result = run_loop(
                    fd,
                    node_id,
                    source_size,
                    encoded_width,
                    encoded_height,
                    max_fps,
                    cursor_sink,
                    cursor_positions,
                    sink,
                    indicator_position,
                    on_stop,
                    geometry,
                    frames,
                    dropped,
                    stop,
                    ready.clone(),
                );
                // Only a delivered frame means ready. A loop that ended without
                // one must not turn an early exit into a successful start.
                let error = result
                    .err()
                    .map(|e| format!("{e:#}"))
                    .unwrap_or_else(|| String::from("capture ended before its first frame"));
                let _ = ready.send(Err(error));
            })
            .context("failed to spawn capture thread")?
    };

    // Own cleanup before waiting: timeout, setup failure and panic all stop and
    // join the worker, not just a successfully returned Capture.
    let capture = Capture {
        quit,
        thread: Some(thread),
        source,
        cursor_positions,
        geometry,
        frames,
        dropped,
        encoded_width,
        encoded_height,
    };
    match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(capture),
        Ok(Err(e)) => anyhow::bail!("capture failed: {e}"),
        Err(mpsc::RecvTimeoutError::Timeout) => anyhow::bail!("capture did not start within 10s"),
        Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("capture thread died"),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_loop(
    fd: OwnedFd,
    node_id: u32,
    source_size: (usize, usize),
    encoded_width: usize,
    encoded_height: usize,
    max_fps: u32,
    cursor_sink: Option<crate::cursor::CursorSink>,
    cursor_positions: Arc<AtomicBool>,
    sink: FrameSink,
    indicator_position: Option<Arc<Mutex<Option<(i64, i64)>>>>,
    on_stop: Box<dyn Fn(String) + Send>,
    geometry: Arc<Mutex<Option<StreamGeometry>>>,
    frames: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    stop: pw::channel::Receiver<()>,
    ready: mpsc::Sender<Result<(), String>>,
) -> Result<()> {
    pw::init();
    let main_loop = pw::main_loop::MainLoopRc::new(None).context("pw_main_loop_new failed")?;
    let _stop = stop.attach(main_loop.loop_(), {
        let main_loop = main_loop.clone();
        move |_| main_loop.quit()
    });

    let context =
        pw::context::ContextBox::new(main_loop.loop_(), None).context("pw_context_new failed")?;
    let core = context
        .connect_fd(fd, None)
        .context("pw_context_connect_fd failed")?;

    let mut props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Video",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Screen",
    };
    props.insert(*pw::keys::TARGET_OBJECT, node_id.to_string());
    let stream = pw::stream::StreamBox::new(&core, "desklink-capture", props)
        .context("pw_stream_new failed")?;

    let wants_cursor_meta = cursor_sink.is_some();
    let mut cursor = cursor_sink.map(crate::cursor::Reporter::new);
    let mut state = StreamState {
        box_w: encoded_width,
        box_h: encoded_height,
        format: None,
        buffer_type: String::from("unknown"),
        sink,
        on_stop,
        mask: indicator_position.map(IndicatorMask::new),
        geometry,
        frames,
        dropped,
        logical_w: 0,
        logical_h: 0,
    };

    let mut ready = Some(ready);
    let _listener = stream
        .add_local_listener_with_user_data(&mut state)
        .state_changed({
            let main_loop = main_loop.clone();
            move |_, state, old, new| {
                let reason = match new {
                    pw::stream::StreamState::Error(message) => {
                        Some(format!("PipeWire stream stopped: {message}"))
                    }
                    pw::stream::StreamState::Unconnected
                        if old == pw::stream::StreamState::Streaming =>
                    {
                        Some(String::from("PipeWire stream disconnected"))
                    }
                    _ => None,
                };
                if let Some(reason) = reason {
                    (state.on_stop)(reason);
                    main_loop.quit();
                }
            }
        })
        .param_changed(|_, state, id, param| {
            if id != pw::spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Some(param) = param else { return };
            // SAFETY: PipeWire guarantees `param` is a valid spa_pod for the
            // duration of this callback; `Pod` is a transparent wrapper over it.
            let pod = param;
            if let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(pod) {
                if media_type != spa::param::format::MediaType::Video
                    || media_subtype != spa::param::format::MediaSubtype::Raw
                {
                    return;
                }
            }
            let mut info = spa::param::video::VideoInfoRaw::new();
            if info.parse(pod).is_err() {
                return;
            }
            state.format = Some(PixelFormat::from_spa(info.format().as_raw()));
            state.logical_w = info.size().width as usize;
            state.logical_h = info.size().height as usize;
        })
        .process(move |stream, state| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            if let Some(cursor) = cursor.as_mut() {
                if let Some(meta) = buffer.find_meta::<spa::buffer::meta::MetaCursor>() {
                    cursor_positions.store(true, Ordering::Relaxed);
                    // The wrapper's size check bounds the bitmap header;
                    // never follow an unchecked bitmap offset.
                    let bitmap = buffer
                        .find_meta::<CursorWithBitmap>()
                        .filter(|m| {
                            m.cursor.bitmap_offset as usize
                                == std::mem::size_of::<spa::sys::spa_meta_cursor>()
                        })
                        .map(|m| &m.bitmap);
                    if state.logical_w == 0 || state.logical_h == 0 {
                        return;
                    }
                    let mut position = *meta.as_raw();
                    position.position.x = (i64::from(position.position.x) * source_size.0 as i64)
                        .div_euclid(state.logical_w as i64)
                        as i32;
                    position.position.y = (i64::from(position.position.y) * source_size.1 as i64)
                        .div_euclid(state.logical_h as i64)
                        as i32;
                    cursor.update_spa(&position, bitmap, source_size.0, source_size.1);
                }
            }
            let Some(format) = state.format else { return };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let data = &mut datas[0];
            let kind = data.type_();
            let chunk = data.chunk();
            let stride = chunk.stride().max(0) as usize;
            let offset = chunk.offset() as usize;
            let size = chunk.size() as usize;
            state.buffer_type = format!("{kind:?}");
            let (w, h) = (state.logical_w, state.logical_h);
            if w == 0 || h == 0 {
                return;
            }
            let Some(bytes) = data.data() else {
                // Not a CPU-mappable buffer (a DMA-BUF the compositor refused to
                // convert). Count it and stay honest; the consumer reads
                // `buffer_type` to report an unsupported source.
                state.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            };
            let stride = if stride == 0 { w * 4 } else { stride };
            let Some(chunk_bytes) = bytes.get(offset..offset.saturating_add(size)) else {
                state.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            };
            // Exactly the encoder's size: fitting again here would round a
            // second time and hand the encoder a frame it refuses whenever the
            // stream's size differs from the one the portal reported.
            let seq = state.frames.load(Ordering::Relaxed);
            let (box_w, box_h) = (state.box_w, state.box_h);
            // The capture indicator is masked out of BGRX pixels, so a masked
            // frame is converted from that copy; otherwise straight from the
            // stream, and BGRX is only made if the sink asks for it.
            let mut masked = None;
            let frame = if let Some(mask) = state.mask.as_mut() {
                let Some(mut raw) =
                    crate::convert::to_bgrx(chunk_bytes, w, h, stride, format, box_w, box_h)
                else {
                    state.dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                };
                mask.apply(&mut raw, box_w, box_h, w, h);
                let frame = to_i420(
                    &raw,
                    box_w,
                    box_h,
                    box_w * 4,
                    PixelFormat::Bgrx,
                    box_w,
                    box_h,
                );
                masked = Some(raw);
                frame
            } else {
                to_i420(chunk_bytes, w, h, stride, format, box_w, box_h)
            };
            if let Some(i420) = frame {
                if state.geometry.lock().map(|g| g.is_none()).unwrap_or(false) {
                    if let Ok(mut g) = state.geometry.lock() {
                        *g = Some(StreamGeometry {
                            source_width: w,
                            source_height: h,
                            origin_x: 0,
                            origin_y: 0,
                            format: format!("{format:?}").to_lowercase(),
                            buffer_type: state.buffer_type.clone(),
                        });
                    }
                }
                state.frames.fetch_add(1, Ordering::Relaxed);
                (state.sink)(i420, seq, &mut || {
                    masked.take().or_else(|| {
                        crate::convert::to_bgrx(chunk_bytes, w, h, stride, format, box_w, box_h)
                    })
                });
                // The first frame the loop actually delivers is the only
                // proof capture started; sending this when `run_loop`
                // returns would be after the main loop quits, too late for
                // `start` to wait on.
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Ok(()));
                }
            } else {
                state.dropped.fetch_add(1, Ordering::Relaxed);
            }
        })
        .register()
        .context("pw_stream_add_listener failed")?;

    let mut format_buf = Vec::new();
    format_pod(&mut format_buf, max_fps)?;
    let mut buffer_buf = Vec::new();
    buffer_pod(&mut buffer_buf)?;
    let mut cursor_buf = Vec::new();
    cursor_pod(&mut cursor_buf)?;
    let mut params = vec![
        Pod::from_bytes(&format_buf).context("invalid EnumFormat pod")?,
        Pod::from_bytes(&buffer_buf).context("invalid Buffers pod")?,
    ];
    if wants_cursor_meta {
        params.push(Pod::from_bytes(&cursor_buf).context("invalid Cursor Meta pod")?);
    }

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .context("pw_stream_connect failed")?;

    main_loop.run();
    Ok(())
}

// The portal composites layer-shell into its pixels. Keep the last clean
// backing for the helper's bounded circle and edge strips before diff/encode;
// the center (4 logical px, which the cue leaves clear) stays live so a
// click marker at the caret remains observable.
struct IndicatorMask {
    position: Arc<Mutex<Option<(i64, i64)>>>,
    clean: Option<Vec<u8>>,
    last: Option<(i64, i64)>,
    from: Option<(i64, i64)>,
    moved_at: Option<Instant>,
}

impl IndicatorMask {
    fn new(position: Arc<Mutex<Option<(i64, i64)>>>) -> Self {
        Self {
            position,
            clean: None,
            last: None,
            from: None,
            moved_at: None,
        }
    }

    fn apply(
        &mut self,
        raw: &mut [u8],
        width: usize,
        height: usize,
        source_w: usize,
        source_h: usize,
    ) {
        let position = self.position.lock().ok().and_then(|value| *value);
        if position != self.last {
            self.from = self.last;
            self.last = position;
            self.moved_at = Some(Instant::now());
        }
        if let Some(clean) = self.clean.as_ref().filter(|clean| clean.len() == raw.len()) {
            let x = position.map_or(-1000, |point| point.0 * width as i64 / source_w as i64);
            let y = position.map_or(-1000, |point| point.1 * height as i64 / source_h as i64);
            let from = self
                .from
                .filter(|_| {
                    self.moved_at
                        .is_some_and(|at| at.elapsed() < Duration::from_millis(800))
                })
                .map(|point| {
                    (
                        point.0 * width as i64 / source_w as i64,
                        point.1 * height as i64 / source_h as i64,
                    )
                });
            let radius = (150 * width / source_w).max(55) as i64;
            let hole = (4 * width / source_w) as i64;
            let edge = (20 * width / source_w)
                .max(8)
                .min(width / 2)
                .min(height / 2);
            for row in 0..height {
                let start = row * width * 4;
                if row < edge || row + edge >= height {
                    raw[start..start + width * 4].copy_from_slice(&clean[start..start + width * 4]);
                    continue;
                }
                raw[start..start + edge * 4].copy_from_slice(&clean[start..start + edge * 4]);
                let end = start + width * 4;
                raw[end - edge * 4..end].copy_from_slice(&clean[end - edge * 4..end]);
                let start_y = from.map_or(y, |point| y.min(point.1));
                let end_y = from.map_or(y, |point| y.max(point.1));
                if (row as i64) < start_y - radius || (row as i64) > end_y + radius {
                    continue;
                }
                let start_x = from.map_or(x, |point| x.min(point.0));
                let end_x = from.map_or(x, |point| x.max(point.0));
                for col in (start_x - radius).max(0) as usize
                    ..=(end_x + radius).min(width as i64 - 1).max(0) as usize
                {
                    let dx = col as i64 - x;
                    let dy = row as i64 - y;
                    let distance = dx * dx + dy * dy;
                    let along = from.is_some_and(|(fx, fy)| {
                        let vx = x - fx;
                        let vy = y - fy;
                        let projection = ((col as i64 - fx) * vx + (row as i64 - fy) * vy)
                            .clamp(0, vx * vx + vy * vy);
                        let length = vx * vx + vy * vy;
                        let (cx, cy) = if length == 0 {
                            (x, y)
                        } else {
                            (fx + projection * vx / length, fy + projection * vy / length)
                        };
                        (col as i64 - cx).pow(2) + (row as i64 - cy).pow(2) <= radius * radius
                    });
                    if (distance <= radius * radius || along) && distance > hole * hole {
                        let at = start + col * 4;
                        raw[at..at + 4].copy_from_slice(&clean[at..at + 4]);
                    }
                }
            }
        }
        self.clean = Some(raw.to_vec());
    }
}

struct StreamState {
    box_w: usize,
    box_h: usize,
    format: Option<PixelFormat>,
    buffer_type: String,
    sink: FrameSink,
    on_stop: Box<dyn Fn(String) + Send>,
    mask: Option<IndicatorMask>,
    geometry: Arc<Mutex<Option<StreamGeometry>>>,
    frames: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    logical_w: usize,
    logical_h: usize,
}

// PipeWire callbacks only touch this from the capture thread.
unsafe impl Send for StreamState {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn layer_mask_keeps_click_center_and_removes_ring_and_edge() {
        let position = Arc::new(Mutex::new(Some((50, 50))));
        let mut mask = IndicatorMask::new(position.clone());
        mask.apply(&mut vec![1; 100 * 100 * 4], 100, 100, 100, 100);
        let mut frame = vec![2; 100 * 100 * 4];
        mask.apply(&mut frame, 100, 100, 100, 100);
        assert_eq!(frame[(50 * 100 + 50) * 4], 2);
        assert_eq!(frame[(50 * 100 + 60) * 4], 1);
        assert_eq!(frame[0], 1);
        *position.lock().unwrap() = Some((75, 50));
        let mut moved = vec![3; 100 * 100 * 4];
        mask.apply(&mut moved, 100, 100, 100, 100);
        assert_eq!(moved[(50 * 100 + 60) * 4], 1, "eased path is masked");
        assert_eq!(moved[(50 * 100 + 75) * 4], 3, "click center remains live");
    }

    #[test]
    fn dropping_capture_stops_and_joins_its_live_pipewire_loop() {
        // Exercise the real event-loop/channel lifetime without a portal,
        // compositor, screen capture or input device.
        let (quit, stop) = pw::channel::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (ended_tx, ended_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            pw::init();
            let main_loop = pw::main_loop::MainLoopRc::new(None).unwrap();
            let _stop = stop.attach(main_loop.loop_(), {
                let main_loop = main_loop.clone();
                move |_| main_loop.quit()
            });
            let timer = main_loop.loop_().add_timer(move |_| {
                let _ = ready_tx.send(());
            });
            timer
                .update_timer(Some(Duration::from_millis(1)), None)
                .into_result()
                .unwrap();
            main_loop.run();
        });
        let capture = Capture {
            quit,
            thread: Some(thread),
            source: SelectedSource {
                node_id: 0,
                width: 2,
                height: 2,
                position: None,
                source_type: None,
                origin_x: 0,
                origin_y: 0,
            },
            cursor_positions: Arc::new(AtomicBool::new(false)),
            geometry: Arc::new(Mutex::new(None)),
            frames: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            encoded_width: 2,
            encoded_height: 2,
        };
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the loop is running");
        // Keep a broken join bounded so a missing stop is a failed check rather
        // than a test process that hangs forever.
        std::thread::spawn(move || {
            drop(capture);
            ended_tx.send(()).unwrap();
        });
        ended_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("capture stopped and joined");
    }
}

fn cursor_pod(buffer: &mut Vec<u8>) -> Result<()> {
    use spa::pod::{object, property, Value};
    let obj = object!(
        spa::utils::SpaTypes::ObjectParamMeta,
        spa::param::ParamType::Meta,
        property!(
            RawKey(spa::sys::SPA_PARAM_META_type),
            Id,
            RawKey(spa::sys::SPA_META_Cursor)
        ),
        property!(
            RawKey(spa::sys::SPA_PARAM_META_size),
            Int,
            (std::mem::size_of::<CursorWithBitmap>() + 256 * 256 * 4) as i32
        )
    );
    PodSerializer::serialize(Cursor::new(buffer), &Value::Object(obj))
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("failed to build Cursor Meta pod: {e}"))
}

#[repr(C)]
struct CursorWithBitmap {
    cursor: spa::sys::spa_meta_cursor,
    bitmap: spa::sys::spa_meta_bitmap,
}
impl spa::buffer::meta::Metadata for CursorWithBitmap {
    const META_TYPE: u32 = spa::sys::SPA_META_Cursor;
}
