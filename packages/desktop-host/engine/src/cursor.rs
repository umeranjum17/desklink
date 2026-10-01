//! Cursor metadata is independent of pixel damage and never painted into video.
use crate::protocol::{timestamp_us, CursorPosition};
use std::time::Instant;

pub type CursorSink = Box<dyn Fn(CursorPosition) + Send + 'static>;

pub struct Reporter {
    sink: CursorSink,
    last: Option<(i32, i32, bool)>,
    bitmap_visible: bool,
}
impl Reporter {
    pub fn new(sink: CursorSink) -> Self {
        Self {
            sink,
            last: None,
            bitmap_visible: true,
        }
    }
    pub fn update_spa(
        &mut self,
        meta: &pipewire::spa::sys::spa_meta_cursor,
        bitmap: Option<&pipewire::spa::sys::spa_meta_bitmap>,
        width: usize,
        height: usize,
    ) {
        // SPA id zero is no new data, not a visibility change.
        if meta.id == 0 {
            return;
        }
        if let Some(bitmap) = bitmap.filter(|b| b.format != 0) {
            self.bitmap_visible = bitmap.offset != 0;
        }
        let (x, y) = (meta.position.x, meta.position.y);
        self.update(
            x,
            y,
            self.bitmap_visible
                && x >= 0
                && y >= 0
                && (x as usize) < width
                && (y as usize) < height,
        );
    }
    pub fn update(&mut self, x: i32, y: i32, visible: bool) {
        if self.last == Some((x, y, visible)) {
            return;
        }
        self.last = Some((x, y, visible));
        (self.sink)(CursorPosition {
            x,
            y,
            visible,
            timestamp_us: timestamp_us(Instant::now()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spa_no_update_off_source_and_invisible_bitmap_are_distinct() {
        use pipewire::spa::sys::{spa_meta_bitmap, spa_meta_cursor, spa_point, spa_rectangle};
        let (tx, rx) = std::sync::mpsc::channel();
        let mut reporter = Reporter::new(Box::new(move |p| {
            tx.send(p).unwrap();
        }));
        let mut meta = spa_meta_cursor {
            id: 1,
            flags: 0,
            position: spa_point { x: 40, y: 60 },
            hotspot: spa_point { x: 2, y: 3 },
            bitmap_offset: 0,
        };
        reporter.update_spa(&meta, None, 800, 600);
        meta.id = 0;
        reporter.update_spa(&meta, None, 800, 600);
        assert_eq!(rx.try_iter().count(), 1);
        meta.id = 1;
        meta.position.x = -1;
        reporter.update_spa(&meta, None, 800, 600);
        assert!(!rx.try_recv().unwrap().visible);
        meta.position.x = 40;
        let bitmap = spa_meta_bitmap {
            format: 1,
            size: spa_rectangle {
                width: 16,
                height: 16,
            },
            stride: 64,
            offset: 0,
        };
        reporter.update_spa(&meta, Some(&bitmap), 800, 600);
        assert!(!rx.try_recv().unwrap().visible);
        reporter.update_spa(&meta, None, 800, 600);
        assert!(rx.try_recv().is_err(), "no new bitmap retains invisibility");
    }

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
