use anyhow::{bail, Result};
use std::os::raw::c_void;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
}

pub mod keycode {
    pub const LEFT_CTRL: i16 = 59;
    pub const LEFT_SHIFT: i16 = 56;
    pub const LEFT_ALT: i16 = 58;
    pub const LEFT_META: i16 = 55;
}

impl Button {
    pub fn from_number(number: i64) -> Self {
        match number {
            2 => Self::Middle,
            3 => Self::Right,
            _ => Self::Left,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct HeldState {
    keys: Vec<i16>,
    buttons: Vec<Button>,
}

impl HeldState {
    pub fn key(&mut self, code: i16, down: bool) {
        if down {
            if !self.keys.contains(&code) {
                self.keys.push(code);
            }
        } else {
            self.keys.retain(|held| *held != code);
        }
    }

    pub fn button(&mut self, button: Button, down: bool) {
        if down {
            if !self.buttons.contains(&button) {
                self.buttons.push(button);
            }
        } else {
            self.buttons.retain(|held| *held != button);
        }
    }

    pub fn release_plan(&mut self) -> (Vec<Button>, Vec<i16>) {
        (
            std::mem::take(&mut self.buttons),
            std::mem::take(&mut self.keys),
        )
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InputUnavailable {
    pub reason: String,
    pub remedy: String,
}

pub fn probe() -> Result<(), InputUnavailable> {
    if unsafe { crate::mac::CGPreflightPostEventAccess() } {
        Ok(())
    } else {
        let app = crate::mac::tcc_responsible_app_name();
        Err(InputUnavailable {
            reason: format!("Accessibility permission has not been granted to {app}."),
            remedy: format!("Allow {app} in System Settings › Privacy & Security › Accessibility, then reconnect."),
        })
    }
}

pub fn request_access() -> bool {
    let key = unsafe { kAXTrustedCheckOptionPrompt };
    let value = unsafe { kCFBooleanTrue };
    let keys = [key];
    let values = [value];
    let options = unsafe {
        CFDictionaryCreate(
            kCFAllocatorDefault,
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    };
    if options.is_null() {
        return false;
    }
    let trusted = unsafe { AXIsProcessTrustedWithOptions(options) };
    unsafe { CFRelease(options) };
    trusted
}

fn modifier_flag(code: i16) -> u64 {
    match code {
        keycode::LEFT_SHIFT => 0x20000,
        keycode::LEFT_CTRL => 0x40000,
        keycode::LEFT_ALT => 0x80000,
        keycode::LEFT_META => 0x100000,
        _ => 0,
    }
}

pub fn native_keycode(code: i16) -> Result<i16> {
    anyhow::ensure!(
        (0..=127).contains(&code),
        "invalid macOS virtual key code {code}"
    );
    Ok(code)
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

type EventRef = *const c_void;
type SourceRef = *const c_void;
type CfTypeRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CfTypeRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CfTypeRef;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateMouseEvent(
        source: SourceRef,
        event_type: u32,
        point: Point,
        button: u32,
    ) -> EventRef;
    fn CGEventCreateScrollWheelEvent(
        source: SourceRef,
        units: u32,
        wheel_count: u32,
        vertical: i32,
        horizontal: i32,
    ) -> EventRef;
    fn CGEventCreateKeyboardEvent(source: SourceRef, keycode: u16, key_down: bool) -> EventRef;
    fn CGEventKeyboardSetUnicodeString(event: EventRef, length: u32, text: *const u16);
    fn CGEventSetFlags(event: EventRef, flags: u64);
    fn CGEventSetLocation(event: EventRef, location: Point);
    fn CGEventPost(tap: u32, event: EventRef);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDictionaryCreate(
        allocator: CfTypeRef,
        keys: *const CfTypeRef,
        values: *const CfTypeRef,
        count: isize,
        key_callbacks: *const u8,
        value_callbacks: *const u8,
    ) -> CfTypeRef;
    fn CFRelease(value: CfTypeRef);
    static kCFAllocatorDefault: CfTypeRef;
    static kCFBooleanTrue: CfTypeRef;
    static kCFTypeDictionaryKeyCallBacks: u8;
    static kCFTypeDictionaryValueCallBacks: u8;
}

pub struct InputDevices {
    pixel_width: i32,
    pixel_height: i32,
    origin: (f64, f64),
    points_per_pixel: (f64, f64),
    last_position: Point,
    wheel_rest: (f64, f64),
    modifier_flags: u64,
}

unsafe impl Send for InputDevices {}

impl InputDevices {
    pub fn create_for_display(width: i32, height: i32, display_id: u32) -> Result<Self> {
        if !request_access() && !unsafe { crate::mac::CGPreflightPostEventAccess() } {
            let app = crate::mac::tcc_responsible_app_name();
            bail!("Accessibility permission is required; allow {app} in System Settings › Privacy & Security › Accessibility");
        }
        let (origin_x, origin_y, point_width, point_height) =
            crate::mac::display_geometry(display_id)
                .ok_or_else(|| anyhow::anyhow!("the selected display is no longer active"))?;
        anyhow::ensure!(
            width > 0 && height > 0,
            "display has invalid pixel dimensions"
        );
        let origin = (origin_x, origin_y);
        Ok(Self {
            pixel_width: width,
            pixel_height: height,
            origin,
            points_per_pixel: (point_width / width as f64, point_height / height as f64),
            last_position: Point {
                x: origin_x,
                y: origin_y,
            },
            wheel_rest: (0.0, 0.0),
            modifier_flags: 0,
        })
    }

    pub fn move_absolute(&mut self, x: i64, y: i64) {
        let x = x.clamp(0, self.pixel_width as i64 - 1);
        let y = y.clamp(0, self.pixel_height as i64 - 1);
        let point = Point {
            x: self.origin.0 + x as f64 * self.points_per_pixel.0,
            y: self.origin.1 + y as f64 * self.points_per_pixel.1,
        };
        self.last_position = point;
        self.post_mouse(5, point, 0);
    }

    pub fn button(&mut self, button: Button, down: bool) {
        let (event_type, native_button) = match (button, down) {
            (Button::Left, true) => (1, 0),
            (Button::Left, false) => (2, 0),
            (Button::Right, true) => (3, 1),
            (Button::Right, false) => (4, 1),
            (Button::Middle, true) => (25, 2),
            (Button::Middle, false) => (26, 2),
        };
        self.post_mouse(event_type, self.last_position, native_button);
    }

    pub fn scroll(&mut self, dx: f64, dy: f64) {
        let (x, y) = (self.wheel_rest.0 + dx, self.wheel_rest.1 + dy);
        let whole_x = x.trunc();
        let whole_y = y.trunc();
        self.wheel_rest = (x - whole_x, y - whole_y);
        if whole_x == 0.0 && whole_y == 0.0 {
            return;
        }
        let event = unsafe {
            CGEventCreateScrollWheelEvent(std::ptr::null(), 0, 2, -whole_y as i32, whole_x as i32)
        };
        if !event.is_null() {
            unsafe { CGEventSetLocation(event, self.last_position) };
        }
        Self::post(event);
    }

    pub fn key(&mut self, code: i16, down: bool) -> Result<()> {
        let code = native_keycode(code)? as u16;
        let flag = modifier_flag(code as i16);
        if down {
            self.modifier_flags |= flag;
        } else {
            self.modifier_flags &= !flag;
        }
        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) };
        if !event.is_null() {
            unsafe { CGEventSetFlags(event, self.modifier_flags) };
        }
        Self::post(event);
        Ok(())
    }

    pub fn unicode_text(&mut self, text: &str) -> Result<()> {
        let characters: Vec<u16> = text.encode_utf16().collect();
        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, true) };
        if event.is_null() {
            bail!("CoreGraphics could not create a Unicode key event");
        }
        unsafe {
            CGEventKeyboardSetUnicodeString(event, characters.len() as u32, characters.as_ptr());
            CGEventSetFlags(event, self.modifier_flags);
        }
        Self::post(event);
        Self::post(unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, false) });
        Ok(())
    }

    fn post_mouse(&self, event_type: u32, point: Point, button: u32) {
        Self::post(unsafe { CGEventCreateMouseEvent(std::ptr::null(), event_type, point, button) });
    }

    fn post(event: EventRef) {
        if !event.is_null() {
            unsafe {
                CGEventPost(0, event);
                CFRelease(event);
            }
        }
    }
}

/// Whether the engine may listen to the desktop's input. Listening needs Input
/// Monitoring, a separate grant from the Accessibility one that posting needs.
pub fn observe_probe() -> Result<(), InputUnavailable> {
    if unsafe { crate::mac::CGPreflightListenEventAccess() } {
        Ok(())
    } else {
        let app = crate::mac::tcc_responsible_app_name();
        Err(InputUnavailable {
            reason: format!("Input Monitoring permission has not been granted to {app}."),
            remedy: format!("Allow {app} in System Settings › Privacy & Security › Input Monitoring, then reconnect."),
        })
    }
}

/// Shows the system's Input Monitoring prompt, once, and lists the app there.
pub fn request_observe_access() -> bool {
    unsafe { crate::mac::CGRequestListenEventAccess() }
}

#[cfg(desklink_vpx)]
pub use observer::observe;

#[cfg(desklink_vpx)]
mod observer {
    use super::*;
    use crate::observe::{Observation, Sink, Tap, Unavailable};
    use crate::protocol::{timestamp_us, ObservedInput, PointerPhase};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    type TapCallback = extern "C" fn(EventRef, u32, EventRef, *mut c_void) -> EventRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: TapCallback,
            user_info: *mut c_void,
        ) -> CfTypeRef;
        fn CGEventTapEnable(tap: CfTypeRef, enable: bool);
        fn CGEventCreate(source: SourceRef) -> EventRef;
        fn CGEventGetLocation(event: EventRef) -> Point;
        fn CGEventGetFlags(event: EventRef) -> u64;
        fn CGEventGetIntegerValueField(event: EventRef, field: u32) -> i64;
        fn CGEventKeyboardGetUnicodeString(
            event: EventRef,
            max_length: usize,
            actual_length: *mut usize,
            buffer: *mut u16,
        );
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFMachPortCreateRunLoopSource(
            allocator: CfTypeRef,
            port: CfTypeRef,
            order: isize,
        ) -> CfTypeRef;
        fn CFMachPortInvalidate(port: CfTypeRef);
        fn CFRunLoopGetCurrent() -> CfTypeRef;
        fn CFRunLoopAddSource(run_loop: CfTypeRef, source: CfTypeRef, mode: CfTypeRef);
        fn CFRunLoopRunInMode(mode: CfTypeRef, seconds: f64, return_after_source: u8) -> i32;
        static kCFRunLoopCommonModes: CfTypeRef;
        static kCFRunLoopDefaultMode: CfTypeRef;
    }

    // CGEventType values this tap listens for.
    const LEFT_DOWN: u32 = 1;
    const LEFT_UP: u32 = 2;
    const RIGHT_DOWN: u32 = 3;
    const RIGHT_UP: u32 = 4;
    const MOVED: u32 = 5;
    const LEFT_DRAGGED: u32 = 6;
    const RIGHT_DRAGGED: u32 = 7;
    const KEY_DOWN: u32 = 10;
    const KEY_UP: u32 = 11;
    const FLAGS_CHANGED: u32 = 12;
    const OTHER_DOWN: u32 = 25;
    const OTHER_UP: u32 = 26;
    const OTHER_DRAGGED: u32 = 27;
    // The system switches a tap off when its callback is slow or on its own
    // say-so; these arrive in its place.
    const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

    const BUTTON_NUMBER: u32 = 3;
    const KEYCODE: u32 = 9;
    const AUTOREPEAT: u32 = 8;

    /// Where the selected display is on the desktop, so a point the system
    /// reports (global, in points) becomes the source's own pixel.
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Geometry {
        origin: (f64, f64),
        points_per_pixel: (f64, f64),
        pixels: (i64, i64),
    }

    impl Geometry {
        pub fn new(origin: (f64, f64), points: (f64, f64), pixels: (i64, i64)) -> Self {
            Self {
                origin,
                points_per_pixel: (points.0 / pixels.0 as f64, points.1 / pixels.1 as f64),
                pixels,
            }
        }

        /// `None` when the point is on another display.
        pub fn to_source(&self, x: f64, y: f64) -> Option<(i64, i64)> {
            let px = ((x - self.origin.0) / self.points_per_pixel.0).floor() as i64;
            let py = ((y - self.origin.1) / self.points_per_pixel.1).floor() as i64;
            ((0..self.pixels.0).contains(&px) && (0..self.pixels.1).contains(&py))
                .then_some((px, py))
        }
    }

    /// The control channel's pointer button numbers: 1 left, 2 middle, 3 right,
    /// and 4 and up for the extra buttons.
    pub fn observed_button(event_type: u32, button_number: i64) -> Option<(PointerPhase, i64)> {
        let extra = |down| match button_number {
            2 => Some((down, 2)),
            n if n > 2 => Some((down, n + 1)),
            _ => None,
        };
        match event_type {
            LEFT_DOWN => Some((PointerPhase::Down, 1)),
            LEFT_UP => Some((PointerPhase::Up, 1)),
            RIGHT_DOWN => Some((PointerPhase::Down, 3)),
            RIGHT_UP => Some((PointerPhase::Up, 3)),
            OTHER_DOWN => extra(PointerPhase::Down),
            OTHER_UP => extra(PointerPhase::Up),
            _ => None,
        }
    }

    struct Observer {
        geometry: Geometry,
        sink: Sink,
        cursor: crate::cursor::Reporter,
        last_inside: (i64, i64),
        port: CfTypeRef,
    }

    impl Observer {
        fn handle(&mut self, event_type: u32, event: EventRef) {
            match event_type {
                DISABLED_BY_TIMEOUT | DISABLED_BY_USER_INPUT => {
                    log::warn!("the input event tap was switched off by the system; re-enabling it");
                    unsafe { CGEventTapEnable(self.port, true) };
                }
                MOVED | LEFT_DRAGGED | RIGHT_DRAGGED | OTHER_DRAGGED => {
                    let at = unsafe { CGEventGetLocation(event) };
                    self.report_pointer(at);
                }
                LEFT_DOWN | LEFT_UP | RIGHT_DOWN | RIGHT_UP | OTHER_DOWN | OTHER_UP => {
                    let number = unsafe { CGEventGetIntegerValueField(event, BUTTON_NUMBER) };
                    let Some((phase, button)) = observed_button(event_type, number) else {
                        return;
                    };
                    let at = unsafe { CGEventGetLocation(event) };
                    // A click on another display is not on this source.
                    let Some((x, y)) = self.geometry.to_source(at.x, at.y) else {
                        return;
                    };
                    self.last_inside = (x, y);
                    self.send(ObservedInput::Pointer { phase, x, y, button });
                }
                KEY_DOWN | KEY_UP | FLAGS_CHANGED => {
                    let code = unsafe { CGEventGetIntegerValueField(event, KEYCODE) } as i16;
                    let flags = unsafe { CGEventGetFlags(event) };
                    let repeat = unsafe { CGEventGetIntegerValueField(event, AUTOREPEAT) } != 0;
                    let text = if event_type == FLAGS_CHANGED {
                        String::new()
                    } else {
                        let mut buffer = [0u16; 8];
                        let mut length = 0usize;
                        unsafe {
                            CGEventKeyboardGetUnicodeString(
                                event,
                                buffer.len(),
                                &mut length,
                                buffer.as_mut_ptr(),
                            )
                        };
                        String::from_utf16_lossy(&buffer[..length.min(buffer.len())])
                    };
                    if let Some(input) =
                        crate::keymap::observed_key(event_type, code, flags, repeat, &text)
                    {
                        self.send(input);
                    }
                }
                _ => {}
            }
        }

        /// Reports where the pointer is now, whether or not it moves.
        fn report_pointer(&mut self, at: Point) {
            match self.geometry.to_source(at.x, at.y) {
                Some(inside) => {
                    self.last_inside = inside;
                    self.cursor.update(inside.0 as i32, inside.1 as i32, true);
                }
                None => self.cursor.update(
                    self.last_inside.0 as i32,
                    self.last_inside.1 as i32,
                    false,
                ),
            }
        }

        fn send(&self, input: ObservedInput) {
            (self.sink)(Observation::Input {
                timestamp_us: timestamp_us(Instant::now()),
                input,
            });
        }
    }

    extern "C" fn tap_callback(
        _proxy: EventRef,
        event_type: u32,
        event: EventRef,
        user_info: *mut c_void,
    ) -> EventRef {
        // The run loop of the tap's own thread is the only caller.
        let observer = unsafe { &mut *(user_info as *mut Observer) };
        observer.handle(event_type, event);
        event
    }

    /// The observer thread and the flag that ends it.
    struct Running {
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn unavailable(code: &'static str, reason: String, remedy: String) -> Unavailable {
        Unavailable {
            code,
            reason,
            remedy,
        }
    }

    /// Listens to the pointer and keyboard of the display `display_id` with a
    /// listen-only event tap: it sees events, it cannot change or block them.
    pub fn observe(
        display_id: u32,
        pixels: (usize, usize),
        sink: Sink,
    ) -> Result<Tap, Unavailable> {
        let app = crate::mac::tcc_responsible_app_name();
        // Preflight never prompts; the owner grants with `setup-input` or by
        // adding the app in System Settings.
        if let Err(missing) = observe_probe() {
            return Err(unavailable(
                "missing-input-monitoring",
                missing.reason,
                missing.remedy,
            ));
        }
        let (origin_x, origin_y, width, height) = crate::mac::display_geometry(display_id)
            .ok_or_else(|| {
                unavailable(
                    "display-unavailable",
                    String::from("the selected display is no longer active"),
                    String::from("select an active display and reconnect"),
                )
            })?;
        let geometry = Geometry::new(
            (origin_x, origin_y),
            (width, height),
            (pixels.0 as i64, pixels.1 as i64),
        );
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::Builder::new()
            .name(String::from("input-observer"))
            .spawn(move || {
                let cursor_sink = sink.clone();
                let observer = Box::into_raw(Box::new(Observer {
                    geometry,
                    sink,
                    cursor: crate::cursor::Reporter::new(Box::new(move |position| {
                        cursor_sink(Observation::Cursor(position))
                    })),
                    last_inside: (0, 0),
                    port: std::ptr::null(),
                }));
                let mask: u64 = [
                    LEFT_DOWN,
                    LEFT_UP,
                    RIGHT_DOWN,
                    RIGHT_UP,
                    MOVED,
                    LEFT_DRAGGED,
                    RIGHT_DRAGGED,
                    KEY_DOWN,
                    KEY_UP,
                    FLAGS_CHANGED,
                    OTHER_DOWN,
                    OTHER_UP,
                    OTHER_DRAGGED,
                ]
                .iter()
                .fold(0u64, |mask, event| mask | (1u64 << *event));
                // kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly.
                let port =
                    unsafe { CGEventTapCreate(1, 0, 1, mask, tap_callback, observer.cast()) };
                if port.is_null() {
                    drop(unsafe { Box::from_raw(observer) });
                    let _ = started_tx.send(Err(()));
                    return;
                }
                unsafe { (*observer).port = port };
                let source = unsafe { CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0) };
                let run_loop = unsafe { CFRunLoopGetCurrent() };
                unsafe {
                    CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
                    CGEventTapEnable(port, true);
                    // Where the pointer already is, so a consumer does not wait for it to move.
                    let here = CGEventCreate(std::ptr::null());
                    if !here.is_null() {
                        (*observer).report_pointer(CGEventGetLocation(here));
                        CFRelease(here);
                    }
                }
                let _ = started_tx.send(Ok(()));
                // Polled rather than stopped from outside: stopping a run loop
                // that has not started yet is lost, and Drop would wait forever.
                while !stopped.load(Ordering::Acquire) {
                    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 0) };
                }
                unsafe {
                    CGEventTapEnable(port, false);
                    CFMachPortInvalidate(port);
                    CFRelease(source);
                    CFRelease(port);
                    drop(Box::from_raw(observer));
                }
            })
            .map_err(|error| {
                unavailable(
                    "event-tap-failed",
                    format!("could not start the input observer thread: {error}"),
                    String::from("retry; if it persists, restart the engine"),
                )
            })?;
        match started_rx.recv() {
            Ok(Ok(())) => Ok(Tap {
                mechanism: "cgeventtap",
                guard: Box::new(Running {
                    stop,
                    thread: Some(thread),
                }),
            }),
            _ => {
                let _ = thread.join();
                Err(unavailable(
                    "event-tap-failed",
                    format!("macOS refused to create the input event tap for {app}."),
                    format!("Remove {app} from System Settings › Privacy & Security › Input Monitoring, add it again, then reconnect."),
                ))
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // A 3420x2224 pixel panel shown as 1710x1112 points, with a second
        // display to its right.
        fn geometry() -> Geometry {
            Geometry::new((0.0, 0.0), (1710.0, 1112.0), (3420, 2224))
        }

        #[test]
        fn a_point_becomes_the_source_pixel_under_it() {
            assert_eq!(geometry().to_source(100.5, 50.0), Some((201, 100)));
            assert_eq!(geometry().to_source(0.0, 0.0), Some((0, 0)));
            assert_eq!(geometry().to_source(1709.9, 1111.9), Some((3419, 2223)));
        }

        #[test]
        fn a_point_on_another_display_is_not_on_this_source() {
            assert_eq!(geometry().to_source(1710.0, 10.0), None);
            assert_eq!(geometry().to_source(-1.0, 10.0), None);
            assert_eq!(geometry().to_source(10.0, 1112.0), None);
        }

        #[test]
        fn a_display_left_of_the_main_one_maps_from_its_own_origin() {
            let left = Geometry::new((-1920.0, 0.0), (1920.0, 1080.0), (1920, 1080));
            assert_eq!(left.to_source(-1920.0, 0.0), Some((0, 0)));
            assert_eq!(left.to_source(-1.0, 1.0), Some((1919, 1)));
            assert_eq!(left.to_source(0.0, 1.0), None);
        }

        #[test]
        fn buttons_use_the_control_channels_numbers() {
            assert_eq!(observed_button(LEFT_DOWN, 0), Some((PointerPhase::Down, 1)));
            assert_eq!(observed_button(LEFT_UP, 0), Some((PointerPhase::Up, 1)));
            assert_eq!(observed_button(RIGHT_DOWN, 1), Some((PointerPhase::Down, 3)));
            assert_eq!(observed_button(RIGHT_UP, 1), Some((PointerPhase::Up, 3)));
            assert_eq!(observed_button(OTHER_DOWN, 2), Some((PointerPhase::Down, 2)));
            assert_eq!(observed_button(OTHER_UP, 3), Some((PointerPhase::Up, 4)));
        }

        #[test]
        fn a_motion_or_a_key_is_not_a_button() {
            assert_eq!(observed_button(MOVED, 0), None);
            assert_eq!(observed_button(KEY_DOWN, 0), None);
            assert_eq!(observed_button(OTHER_DOWN, 1), None);
        }

        #[test]
        fn without_input_monitoring_the_tap_is_typed_unavailable_and_silent() {
            // The CI and lab Macs this runs on have not granted Input Monitoring
            // to the test binary; where one has, there is nothing to refuse.
            if observe_probe().is_ok() {
                return;
            }
            let delivered = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = delivered.clone();
            let refused = observe(
                1,
                (1920, 1080),
                std::sync::Arc::new(move |_| {
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }),
            );
            let Err(refused) = refused else {
                panic!("a tap was created without the grant");
            };
            assert_eq!(refused.code, "missing-input-monitoring");
            assert!(refused.remedy.contains("Input Monitoring"));
            assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 0);
        }
    }
}
