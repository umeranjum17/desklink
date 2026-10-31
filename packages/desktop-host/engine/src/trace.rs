//! Why the picture stopped: the frame counters the engine already keeps, one
//! plain line a second plus the seconds around a stall, so a freeze that leaves
//! no trace can be read afterwards.
//!
//! On by default, because nobody exports a variable before a freeze: counters
//! and timestamps only, no pixels, no window content, no network, one
//! self-rolling file of at most 2 MB. `DESKLINK_TRACE=off` silences it and
//! `DESKLINK_TRACE_PATH=<file>` writes somewhere other than
//! `<cache>/desklink/engine-trace.log`. The sampler has its own thread and never
//! takes the encoder lock, so it cannot change frame timing; the encode thread
//! pays one relaxed store, only on a slow call.

use crate::session::Metrics;
use std::collections::VecDeque;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The sampler's beat and the counter line's period: fine enough to date a
/// 500 ms encode call, idle enough to cost nothing over a smooth picture.
const TICK: Duration = Duration::from_millis(250);
const LINE_EVERY: Duration = Duration::from_millis(1000);
/// The three ways a stall is seen: one encode call over 500 ms, capture still
/// taking frames 1 s after the last send, and a beat 1.2 s late, which only a
/// stopped process explains.
const SLOW_ENCODE: Duration = Duration::from_millis(500);
const NO_SEND: Duration = Duration::from_millis(1000);
const LATE_BEAT: Duration = Duration::from_millis(1200);
/// The 30 seconds a stall repeats, the one file's 2 MB ceiling, and the lines
/// allowed to wait in the writer: never one flush a line.
const KEPT: usize = 30;
const MAX_BYTES: u64 = 2 << 20;
const FLUSH_AFTER: usize = 10;

/// The last slow encode call: micros, or 0.
static SLOW_ENCODE_MICROS: AtomicU64 = AtomicU64::new(0);

/// Record one encode call from the encode thread: nothing per frame beyond the
/// comparison, one relaxed store when the call was slow.
pub fn note_encode(took: Duration) {
    if took >= SLOW_ENCODE {
        SLOW_ENCODE_MICROS.store(took.as_micros().min(u64::MAX as u128) as u64, Ordering::Relaxed);
    }
}

/// Start tracing this session, or nothing when it is off or has nowhere to
/// write. `running` is the pipeline flag: it clears on close and the sampler
/// leaves with it. A trace that cannot start is a missing diagnostic, never a
/// failed session.
pub fn spawn(metrics: Arc<Mutex<Metrics>>, running: Arc<AtomicBool>) {
    let Some(path) = destination() else { return };
    std::thread::Builder::new()
        .name("desklink-trace".into())
        .spawn(move || run(&metrics, &running, &path))
        .ok();
}

/// `DESKLINK_TRACE=off` for nowhere, `DESKLINK_TRACE_PATH` for an explicit file,
/// otherwise the platform cache directory; no cache directory, no trace.
fn destination() -> Option<PathBuf> {
    if std::env::var("DESKLINK_TRACE").is_ok_and(|value| value == "off" || value == "0") {
        return None;
    }
    if let Some(path) = std::env::var_os("DESKLINK_TRACE_PATH").filter(|path| !path.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(".cache")))?;
    Some(base.join("desklink/engine-trace.log"))
}

/// Decide what one beat saw, apart from the thread that reads it, so the rule is
/// checkable without a clock. `beat` is the time since the previous beat, `quiet`
/// the time since a frame was last sent, and `sent_captured` the captured count
/// at that send: capture still taking frames after it is what makes a quiet
/// encoder a stall rather than a still desktop. A session that has not sent its
/// first frame is opening, not stopping, so that is never a stall.
fn classify(
    current: &Metrics,
    beat: Duration,
    quiet: Duration,
    sent_captured: u64,
    slow_micros: u64,
) -> Option<(String, Option<Duration>)> {
    if slow_micros > 0 {
        return Some((format!("one encode call took {}ms", slow_micros / 1000), None));
    }
    if beat >= LATE_BEAT {
        let note = format!("the sampler beat {}ms late: the process was not running", beat.as_millis());
        return Some((note, Some(beat)));
    }
    if current.encoded_frames > 0 && quiet >= NO_SEND && current.captured_frames > sent_captured {
        let note = format!("no encoded frame sent for {}ms while the capture path took frames", quiet.as_millis());
        return Some((note, None));
    }
    None
}

/// One bounded, self-rolling file of plain lines.
struct Log {
    path: PathBuf,
    out: Option<BufWriter<std::fs::File>>,
    bytes: u64,
    unflushed: usize,
}

impl Log {
    fn open(path: &Path) -> Option<Log> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(path).ok()?;
        let bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        Some(Log { path: path.to_path_buf(), out: Some(BufWriter::new(file)), bytes, unflushed: 0 })
    }

    /// One line, buffered: a flush every [`FLUSH_AFTER`] lines, and the one file
    /// starts again at [`MAX_BYTES`] rather than grow with time.
    fn write(&mut self, line: &str) {
        if self.bytes >= MAX_BYTES {
            self.flush();
            let reopened = std::fs::OpenOptions::new().write(true).truncate(true).create(true).open(&self.path);
            if let Ok(file) = reopened {
                self.out = Some(BufWriter::new(file));
                self.bytes = 0;
            }
        }
        if let Some(out) = self.out.as_mut() {
            let _ = out.write_all(line.as_bytes());
            let _ = out.write_all(b"\n");
            self.bytes += line.len() as u64 + 1;
            self.unflushed += 1;
        }
        if self.unflushed >= FLUSH_AFTER {
            self.flush();
        }
    }

    /// A marker has to survive a hard kill, so it is flushed at once.
    fn mark(&mut self, text: &str) {
        self.write(text);
        self.flush();
    }

    fn flush(&mut self) {
        if let Some(out) = self.out.as_mut() {
            let _ = out.flush();
        }
        self.unflushed = 0;
    }
}

fn snapshot(metrics: &Mutex<Metrics>) -> Metrics {
    metrics.lock().map(|m| m.clone()).unwrap_or_default()
}

fn epoch_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_secs()).unwrap_or(0)
}

/// The counters the engine already keeps, then the rates and the rate target, as
/// plain `key=value` that a person and `grep` both read.
fn counter_line(uptime: Duration, elapsed: Duration, now: &Metrics, before: &Metrics, quiet: Duration) -> String {
    let seconds = elapsed.as_secs_f64().max(0.001);
    let rate = |now: u64, before: u64| now.saturating_sub(before) as f64 / seconds;
    let (captured, encoded) = (rate(now.captured_frames, before.captured_frames), rate(now.encoded_frames, before.encoded_frames));
    format!(
        "t={:.3} at={} captured={} encoded={} dropped={} halved={} refined={} key={} encode_us={} queue_us={} send_us={} captured_fps={captured:.1} encoded_fps={encoded:.1} target_kbps={} quiet_ms={}",
        uptime.as_secs_f64(), epoch_seconds(), now.captured_frames, now.encoded_frames, now.dropped_frames,
        now.halved_frames, now.refined_frames, now.key_frames, now.encode_micros, now.queue_micros,
        now.send_micros, now.target_kbps, quiet.as_millis(),
    )
}

fn run(metrics: &Mutex<Metrics>, running: &AtomicBool, path: &Path) {
    let Some(mut log) = Log::open(path) else { return };
    let started = Instant::now();
    let (mut beat, mut at_line) = (started, started);
    let mut previous = snapshot(metrics);
    // When a frame was last sent, and the captured count then: the pair that
    // tells a still desktop from a stopped encoder.
    let (mut sent_at, mut sent_captured) = (started, previous.captured_frames);
    // When the current stall began, and its length when a late beat knows it.
    let mut stalled: Option<(Instant, Option<Duration>)> = None;
    // The last [`KEPT`] lines, so a stall dump cannot grow with time.
    let mut kept: VecDeque<String> = VecDeque::with_capacity(KEPT);
    let stamp = |since: Instant| since.duration_since(started).as_secs_f64();
    log.mark(&format!("-- trace start pid={} at={}", std::process::id(), epoch_seconds()));
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(TICK);
        let now = Instant::now();
        let behind = now.duration_since(beat);
        beat = now;
        let current = snapshot(metrics);
        if current.encoded_frames != previous.encoded_frames {
            sent_at = now;
            sent_captured = current.captured_frames;
        }
        let quiet = now.duration_since(sent_at);
        let slow = SLOW_ENCODE_MICROS.swap(0, Ordering::Relaxed);
        let reason = classify(&current, behind, quiet, sent_captured, slow);
        if let Some((note, known)) = reason.as_ref() {
            if stalled.is_none() {
                stalled = Some((now, *known));
                log.mark(&format!("!! stall start t={:.3} at={} reason={note}", stamp(now), epoch_seconds()));
                // Before, during, after: the buffered seconds first, so the reader
                // sees the counters that were advancing until now.
                log.mark("<< last 30s");
                for line in kept.iter() {
                    log.write(line);
                }
                log.mark(">> during");
            }
        }
        if now.duration_since(at_line) >= LINE_EVERY {
            let line = counter_line(now.duration_since(started), now.duration_since(at_line), &current, &previous, quiet);
            // A marked line is the "during" half: against the buffered ones it
            // shows which counter stopped advancing.
            let line = if stalled.is_some() { format!("!! {line}") } else { line };
            log.write(&line);
            if kept.len() == KEPT {
                kept.pop_front();
            }
            kept.push_back(line);
            previous = current;
            at_line = now;
        }
        if stalled.is_some() && reason.is_none() {
            let (since, known) = stalled.take().unwrap_or((now, None));
            let lasted = known.unwrap_or_else(|| now.duration_since(since));
            log.mark(&format!("!! stall end t={:.3} at={} lasted={}ms", stamp(now), epoch_seconds(), lasted.as_millis()));
        }
    }
    log.mark("-- trace end");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(captured: u64, encoded: u64) -> Metrics {
        Metrics { captured_frames: captured, encoded_frames: encoded, ..Metrics::default() }
    }

    #[test]
    fn the_stall_rules_and_the_one_file_are_bounded() {
        let motion = metrics(600, 600);
        let ms = Duration::from_millis;
        assert_eq!(classify(&motion, TICK, ms(16), 590, 0), None, "60 fps sends and captures");
        assert_eq!(classify(&motion, TICK, ms(5000), 600, 0), None, "a still desktop captures nothing");
        assert_eq!(classify(&metrics(50, 0), TICK, ms(1200), 0, 0), None, "the first frame is not out yet");
        let stalled = classify(&metrics(700, 600), TICK, ms(1200), 660, 0);
        assert!(stalled.is_some_and(|(note, _)| note.contains("no encoded frame")));
        let slow = classify(&motion, TICK, ms(16), 590, 700_000);
        assert!(slow.is_some_and(|(note, _)| note.contains("700ms")));
        let frozen = classify(&motion, ms(1500), ms(16), 590, 0);
        assert_eq!(frozen.map(|(_, known)| known), Some(Some(ms(1500))));

        let path = std::env::temp_dir().join(format!("desklink-trace-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut log = Log::open(&path).expect("a trace file in the temp directory");
        for _ in 0..MAX_BYTES / 1024 + 4 {
            log.write(&"x".repeat(1024));
        }
        log.flush();
        let written = std::fs::metadata(&path).expect("the trace file").len();
        let _ = std::fs::remove_file(&path);
        assert!(written <= MAX_BYTES + 2048, "the one file stayed bounded: {written}");
    }
}
