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

use pipewire as pw;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// The sample format a session would carry, best first. It describes this
/// build's seam, so it is reported whether or not this machine has a sink.
pub const FORMATS: &[&str] = &["s16le"];

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
