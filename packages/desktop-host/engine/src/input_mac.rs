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
        Self::post(event);
    }

    pub fn key(&mut self, code: i16, down: bool) -> Result<()> {
        let code = native_keycode(code)? as u16;
        Self::post(unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) });
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
