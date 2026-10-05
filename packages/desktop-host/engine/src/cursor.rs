//! Cursor metadata is independent of pixel damage and never painted into video.
use crate::protocol::{timestamp_us, CursorPosition};
use std::time::Instant;

pub type CursorSink = Box<dyn Fn(CursorPosition) + Send + 'static>;

pub struct Reporter {
    sink: CursorSink,
    last: Option<(i32, i32, bool, Option<(i32, i32)>)>,
    /// The cursor image's hotspot offset, where the source reports one.
    pub hotspot: Option<(i32, i32)>,
}
impl Reporter {
    pub fn new(sink: CursorSink) -> Self {
        Self {
            sink,
            last: None,
            hotspot: None,
        }
    }
    pub fn update(&mut self, x: i32, y: i32, visible: bool) {
        if self.last == Some((x, y, visible, self.hotspot)) {
            return;
        }
        self.last = Some((x, y, visible, self.hotspot));
        (self.sink)(CursorPosition {
            x,
            y,
            visible,
            hotspot: self.hotspot,
            timestamp_us: timestamp_us(Instant::now()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_initial_motion_and_visibility_but_not_unchanged_polls() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut reporter = Reporter::new(Box::new(move |p| {
            tx.send(p).unwrap();
        }));
        reporter.update(10, 20, true);
        reporter.update(10, 20, true);
        reporter.update(30, 40, true);
        reporter.update(30, 40, false);
        let notices: Vec<_> = rx.try_iter().collect();
        assert_eq!(notices.len(), 3);
        assert_eq!((notices[1].x, notices[1].y), (30, 40));
        assert!(!notices[2].visible);
        assert!(notices
            .windows(2)
            .all(|p| p[0].timestamp_us <= p[1].timestamp_us));
    }
}
