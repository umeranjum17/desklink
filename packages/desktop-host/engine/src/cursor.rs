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
