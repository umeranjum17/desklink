use crate::convert::{to_bgrx, to_i420, PixelFormat, I420};
use crate::portal::PortalSession;
use anyhow::{Context, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub type FrameSink = Box<dyn Fn(I420, u64, Vec<u8>) + Send + 'static>;

pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn start(
    session: PortalSession,
    width: usize,
    height: usize,
    max_fps: u32,
    sink: FrameSink,
) -> Result<Capture> {
    let source = session.source;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread = std::thread::Builder::new()
        .name(String::from("desklink-screencapturekit"))
        .spawn(move || {
            let interval = Duration::from_secs_f64(1.0 / max_fps.max(1) as f64);
            let mut sequence = 0;
            while !thread_stop.load(Ordering::Relaxed) {
                let started = Instant::now();
                match crate::mac::capture_display(source.node_id) {
                    Ok((pixels, source_width, source_height, stride)) => {
                        let raw = to_bgrx(
                            &pixels,
                            source_width,
                            source_height,
                            stride,
                            PixelFormat::Bgra,
                            width,
                            height,
                        );
                        let frame = to_i420(
                            &pixels,
                            source_width,
                            source_height,
                            stride,
                            PixelFormat::Bgra,
                            width,
                            height,
                        );
                        match (frame, raw) {
                            (Some(frame), Some(raw)) => {
                                sink(frame, sequence, raw);
                                sequence += 1;
                            }
                            _ => {
                                eprintln!("ScreenCaptureKit returned an unsupported pixel buffer");
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!("ScreenCaptureKit capture failed: {error:#}");
                        break;
                    }
                }
                let elapsed = started.elapsed();
                if elapsed < interval {
                    std::thread::sleep(interval - elapsed);
                }
            }
        })
        .context("could not start the ScreenCaptureKit capture thread")?;
    Ok(Capture {
        stop,
        thread: Some(thread),
    })
}
