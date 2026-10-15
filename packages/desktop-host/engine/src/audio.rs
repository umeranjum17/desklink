//! Can this machine capture the desktop's system audio? Asked, never taken.
//!
//! Linux captures through a PipeWire monitor of a sink, so the machine fact is
//! "a reachable sink exposes monitor ports". `capabilities` may answer that: it
//! must not prompt and must not start a capture, so this connects as any client
//! does, reads the registry and leaves — no portal, no D-Bus, no consent dialog,
//! no stream. It answers for the machine and not for the build: the same binary
//! says `false` where no PipeWire, or no sink, is reachable, and a host running
//! PulseAudio without PipeWire is `false` too, because this build has no
//! PulseAudio client and no capture path that could use one.

use anyhow::Context as _;
use pipewire as pw;
use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::rc::Rc;
use std::result::Result;
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

/// The sample format this seam carries. It describes this build, so it is
/// reported whether or not this machine has a sink; the capture asks PipeWire
/// for exactly it.
pub const FORMAT: &str = "s16le";
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;

/// The sample format a session would carry, best first.
pub const FORMATS: &[&str] = &[FORMAT];

/// What a session would capture from, and in what format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSource {
    /// Names the mechanism, so a consumer can tell a sink monitor from a future
    /// consent-carrying portal audio node.
    pub name: &'static str,
    pub formats: &'static [&'static str],
}

/// The desktop's own mix, as the sink sends it to its monitor ports.
const MONITOR: AudioSource = AudioSource {
    name: "pipewire-monitor",
    formats: FORMATS,
};

/// How long the registry may take to answer; `capabilities` must not hang
/// behind a server that is up but silent.
const TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Default)]
struct Scan {
    /// Node ids whose `media.class` is `Audio/Sink`, and the node id each
    /// `port.monitor` output port belongs to. A sink with a monitor is the node
    /// a capture stream would link to; a sink without one cannot be captured
    /// this way.
    sinks: HashSet<u32>,
    monitors: HashSet<u32>,
    answered: bool,
    failed: bool,
}

/// `Some(source)` exactly when opening a session with audio here would capture
/// the desktop's system audio without prompting; `None` otherwise.
pub fn probe() -> Option<AudioSource> {
    pw::init();
    let main_loop = pw::main_loop::MainLoopRc::new(None).ok()?;
    let context = pw::context::ContextRc::new(&main_loop, None).ok()?;
    let core = context.connect_rc(None).ok()?;
    let registry = core.get_registry().ok()?;

    // The round trip is asked for before its listener exists; a reply cannot be
    // dispatched until the loop below iterates, so nothing is missed.
    let pending = core.sync(0).ok();
    let scan = Rc::new(RefCell::new(Scan::default()));

    let _core = core
        .add_listener_local()
        .done({
            let scan = Rc::clone(&scan);
            move |_, seq| {
                if Some(seq) == pending {
                    scan.borrow_mut().answered = true;
                }
            }
        })
        .error({
            let scan = Rc::clone(&scan);
            move |_, _, _, _| {
                let mut scan = scan.borrow_mut();
                scan.failed = true;
                scan.answered = true;
            }
        })
        .register();

    let _registry = registry
        .add_listener_local()
        .global({
            let scan = Rc::clone(&scan);
            move |global| {
                let Some(props) = global.props else { return };
                let mut scan = scan.borrow_mut();
                match global.type_ {
                    pw::types::ObjectType::Node
                        if props.get(*pw::keys::MEDIA_CLASS) == Some("Audio/Sink") =>
                    {
                        scan.sinks.insert(global.id);
                    }
                    pw::types::ObjectType::Port
                        if props.get(*pw::keys::PORT_MONITOR) == Some("true")
                            && props.get(*pw::keys::PORT_DIRECTION) == Some("out") =>
                    {
                        if let Some(node) = props.get(*pw::keys::NODE_ID).and_then(|id| id.parse().ok()) {
                            scan.monitors.insert(node);
                        }
                    }
                    _ => {}
                }
            }
        })
        .register();

    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        if main_loop
            .loop_()
            .iterate(pw::loop_::Timeout::Finite(Duration::from_millis(50)))
            < 0
        {
            break;
        }
        let scan = scan.borrow();
        if scan.answered {
            let capturable = !scan.failed && scan.sinks.intersection(&scan.monitors).next().is_some();
            return capturable.then_some(MONITOR);
        }
    }
    None
}

/// s16le interleaved: the bytes of one sample frame across every channel.
pub const BYTES_PER_FRAME: u64 = 2 * CHANNELS as u64;

/// 100 ms per chunk: prompt enough to show progress, calm enough that one
/// chunk is worth its own file write and its own change event.
const CHUNK_FRAMES: usize = SAMPLE_RATE as usize / 10;
const CHUNK_BYTES: usize = CHUNK_FRAMES * BYTES_PER_FRAME as usize;

/// Chunks that may wait for the consumer; past this the newest chunk is
/// dropped and counted, so what is read stays in order.
const QUEUE_CHUNKS: usize = 8;

/// One captured chunk, s16le interleaved, stamped on the engine clock.
pub struct Chunk {
    pub seq: u64,
    pub at: Instant,
    pub bytes: Vec<u8>,
    /// How far this chunk's start fell behind the previous chunk's end: an
    /// under-run reads as a gap, never as silence.
    pub gap_micros: u64,
}

/// A chunk announcement that borrows nothing, so the callback runs outside
/// the lock.
#[derive(Clone, Copy)]
pub struct ChunkNotice {
    pub seq: u64,
    pub at: Instant,
    pub bytes: u64,
    pub gap_micros: u64,
}

#[derive(Default)]
struct Queue {
    chunks: VecDeque<Chunk>,
    frames: u64,
    bytes: u64,
    dropped_bytes: u64,
    gap_micros: u64,
}

/// What the capture thread and its session share.
struct Shared {
    queue: Mutex<Queue>,
    ready: Mutex<Option<mpsc::Sender<Result<(), String>>>>,
    on_chunk: Box<dyn Fn(ChunkNotice) + Send + Sync>,
}

impl Shared {
    fn report(&self, result: Result<(), String>) {
        if let Some(ready) = lock(&self.ready).take() {
            let _ = ready.send(result);
        }
    }
}

/// A running capture. Dropping it quits the PipeWire loop and joins the
/// thread; the session holds it for the session's lifetime.
pub struct AudioCapture {
    shared: Arc<Shared>,
    quit: pw::channel::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AudioCapture {
    /// Capture the default sink's monitor over this session's own PipeWire
    /// connection. Returns once the stream is up on the negotiated format; a
    /// machine with no capturable sink fails here with a readable reason.
    pub fn start(on_chunk: Box<dyn Fn(ChunkNotice) + Send + Sync>) -> Result<Self, String> {
        let (ready, ready_rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::default()),
            ready: Mutex::new(Some(ready)),
            on_chunk,
        });
        let (quit, stop) = pw::channel::channel();
        let thread = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("desklink-audio".into())
                .spawn(move || {
                    if let Err(error) = run(stop, Arc::clone(&shared)) {
                        // After the stream is up this is meaningless; before
                        // that it is the only path the reason has out.
                        shared.report(Err(format!("{error:#}")));
                    }
                })
                .map_err(|error| format!("failed to spawn audio capture: {error}"))?
        };
        let reason = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => return Ok(Self { shared, quit, thread: Some(thread) }),
            Ok(Err(reason)) => reason,
            Err(_) => String::from(
                "the audio stream did not start within 5s: no sink to capture, or no session manager to link it",
            ),
        };
        let _ = quit.send(());
        let _ = thread.join();
        Err(reason)
    }

    /// The next chunk in order, or `None` once everything captured is read.
    pub fn take(&self) -> Option<Chunk> {
        lock(&self.shared.queue).chunks.pop_front()
    }

    /// Captured frames, captured bytes, dropped bytes, under-run microseconds.
    pub fn totals(&self) -> (u64, u64, u64, u64) {
        let queue = lock(&self.shared.queue);
        (queue.frames, queue.bytes, queue.dropped_bytes, queue.gap_micros)
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        let _ = self.quit.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The capture thread's own state: the chunk being filled, where it started,
/// when the last one ended, and the next sequence number.
#[derive(Default)]
struct Stream {
    pending: Vec<u8>,
    started: Option<Instant>,
    end: Option<Instant>,
    seq: u64,
}

fn chunk_span() -> Duration {
    Duration::from_secs_f64(CHUNK_FRAMES as f64 / SAMPLE_RATE as f64)
}

/// Hand one chunk over, or drop and count it when the consumer lags; the
/// sequence always advances, so a drop reads as a gap, not contiguous audio.
fn enqueue(shared: &Shared, state: &mut Stream, bytes: Vec<u8>, started: Instant) {
    state.seq += 1;
    let len = bytes.len() as u64;
    let gap = state.end.map_or(Duration::ZERO, |end| started.saturating_duration_since(end));
    state.end = Some(started + chunk_span());
    let notice = ChunkNotice { seq: state.seq, at: started, bytes: len, gap_micros: gap.as_micros() as u64 };
    let chunk = Chunk { seq: notice.seq, at: started, bytes, gap_micros: notice.gap_micros };
    {
        let mut queue = lock(&shared.queue);
        queue.frames += len / BYTES_PER_FRAME;
        queue.bytes += len;
        queue.gap_micros += notice.gap_micros;
        if queue.chunks.len() < QUEUE_CHUNKS {
            queue.chunks.push_back(chunk);
        } else {
            queue.dropped_bytes += len;
        }
    }
    (shared.on_chunk)(notice);
}

fn run(stop: pw::channel::Receiver<()>, shared: Arc<Shared>) -> anyhow::Result<()> {
    pw::init();
    let main_loop = pw::main_loop::MainLoopRc::new(None).context("pw_main_loop_new failed")?;
    let _stop = stop.attach(main_loop.loop_(), {
        let main_loop = main_loop.clone();
        move |_| main_loop.quit()
    });
    let context = pw::context::ContextBox::new(main_loop.loop_(), None).context("pw_context_new failed")?;
    // The video path arrives holding a portal fd; audio has none and connects
    // to this session's own PipeWire, which is what makes a private runtime
    // directory the isolation boundary.
    let core = context.connect(None).context("pw_context_connect failed")?;

    let props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Music",
        // The sink's own output, not a source's input: the desktop's mix.
        *pw::keys::STREAM_CAPTURE_SINK => "true",
    };
    let stream =
        pw::stream::StreamBox::new(&core, "desklink-audio", props).context("pw_stream_new failed")?;

    let listener = stream
        .add_local_listener_with_user_data(Stream::default())
        .state_changed({
            let shared = Arc::clone(&shared);
            move |_, _, _old, new| match new {
                pw::stream::StreamState::Streaming => shared.report(Ok(())),
                pw::stream::StreamState::Error(message) => shared.report(Err(format!("PipeWire audio stream stopped: {message}"))),
                _ => {}
            }
        })
        .process({
            let shared = Arc::clone(&shared);
            move |stream, state| {
                let Some(mut buffer) = stream.dequeue_buffer() else { return };
                let datas = buffer.datas_mut();
                let Some(data) = datas.first_mut() else { return };
                let c = data.chunk();
                let (offset, size) = (c.offset() as usize, c.size() as usize);
                let Some(bytes) = data.data() else { return };
                let Some(bytes) = bytes.get(offset..offset.saturating_add(size)) else { return };
                if bytes.is_empty() { return; }
                // A chunk starts when its first byte arrives, so a stall reads
                // as a gap; a split inside one buffer keeps the sample-derived span.
                let mut started = Instant::now();
                if !state.pending.is_empty() {
                    started = state.started.unwrap_or(started);
                }
                state.pending.extend_from_slice(bytes);
                while state.pending.len() >= CHUNK_BYTES {
                    let rest = state.pending.split_off(CHUNK_BYTES);
                    let filled = std::mem::replace(&mut state.pending, rest);
                    enqueue(&shared, state, filled, started);
                    started += chunk_span();
                }
                state.started = (!state.pending.is_empty()).then_some(started);
            }
        })
        .register()
        .context("pw_stream_add_listener failed")?;

    // Ask for the one format this seam carries; `audioconvert` adapts the sink.
    let mut info = pw::spa::param::audio::AudioInfoRaw::new();
    info.set_format(pw::spa::param::audio::AudioFormat::S16LE);
    info.set_rate(SAMPLE_RATE);
    info.set_channels(CHANNELS);
    let object = pw::spa::pod::Object {
        type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: pw::spa::param::ParamType::EnumFormat.as_raw(),
        properties: info.into(),
    };
    let pod = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(object),
    )
    .map_err(|error| anyhow::anyhow!("format pod serialization failed: {error}"))?;
    let pod = pod.0.into_inner();
    let mut params =
        [pw::spa::pod::Pod::from_bytes(&pod).context("the format pod is not a valid pod")?];
    stream
        .connect(
            pw::spa::utils::Direction::Input,
            None,
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .context("pw_stream_connect failed")?;

    main_loop.run();
    drop(listener);
    Ok(())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
