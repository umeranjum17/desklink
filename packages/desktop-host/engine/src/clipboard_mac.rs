use anyhow::{bail, Result};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};

pub const MAX_CLIPBOARD_BYTES: usize = 262_144;

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSApplicationLoad() -> bool;
}

#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: *const c_void);
}

type Obj = *mut c_void;
type Sel = *mut c_void;

struct Pool(Obj);
impl Pool {
    fn new() -> Result<Self> {
        let name = CString::new("NSAutoreleasePool").unwrap();
        let class = unsafe { objc_getClass(name.as_ptr()) };
        anyhow::ensure!(!class.is_null(), "AppKit autorelease pool is unavailable");
        let allocated = send0(class, "alloc");
        let pool = send0(allocated, "init");
        anyhow::ensure!(!pool.is_null(), "could not create AppKit autorelease pool");
        Ok(Self(pool))
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        send0_void(self.0, "drain");
    }
}

fn selector(name: &str) -> Sel {
    let name = CString::new(name).expect("selector has no nul byte");
    unsafe { sel_registerName(name.as_ptr()) }
}

fn send0(receiver: Obj, name: &str) -> Obj {
    let function: unsafe extern "C" fn(Obj, Sel) -> Obj =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { function(receiver, selector(name)) }
}

fn send0_void(receiver: Obj, name: &str) {
    let function: unsafe extern "C" fn(Obj, Sel) =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { function(receiver, selector(name)) }
}

fn send0_integer(receiver: Obj, name: &str) -> isize {
    let function: unsafe extern "C" fn(Obj, Sel) -> isize =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { function(receiver, selector(name)) }
}

fn send1_object(receiver: Obj, name: &str, argument: Obj) -> Obj {
    let function: unsafe extern "C" fn(Obj, Sel, Obj) -> Obj =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { function(receiver, selector(name), argument) }
}

fn send2_object(receiver: Obj, name: &str, first: Obj, second: Obj) -> bool {
    let function: unsafe extern "C" fn(Obj, Sel, Obj, Obj) -> bool =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { function(receiver, selector(name), first, second) }
}

fn pasteboard() -> Result<Obj> {
    let _ = unsafe { NSApplicationLoad() };
    let class_name = CString::new("NSPasteboard").unwrap();
    let class = unsafe { objc_getClass(class_name.as_ptr()) };
    anyhow::ensure!(!class.is_null(), "AppKit NSPasteboard is unavailable");
    let board = send0(class, "generalPasteboard");
    anyhow::ensure!(
        !board.is_null(),
        "macOS did not provide the general pasteboard"
    );
    Ok(board)
}

fn string_type() -> Result<Obj> {
    let class_name = CString::new("NSString").unwrap();
    let class = unsafe { objc_getClass(class_name.as_ptr()) };
    let allocated = send0(class, "alloc");
    let utf8 = CString::new("public.utf8-plain-text").unwrap();
    let function: unsafe extern "C" fn(Obj, Sel, *const c_char) -> Obj =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    let value = unsafe { function(allocated, selector("initWithUTF8String:"), utf8.as_ptr()) };
    anyhow::ensure!(!value.is_null(), "could not create pasteboard type");
    Ok(value)
}

fn nsstring(text: &str) -> Result<Obj> {
    let class_name = CString::new("NSString").unwrap();
    let class = unsafe { objc_getClass(class_name.as_ptr()) };
    let allocated = send0(class, "alloc");
    let chars: Vec<u16> = text.encode_utf16().collect();
    let function: unsafe extern "C" fn(Obj, Sel, *const u16, usize) -> Obj =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    let value = unsafe {
        function(
            allocated,
            selector("initWithCharacters:length:"),
            chars.as_ptr(),
            chars.len(),
        )
    };
    anyhow::ensure!(!value.is_null(), "could not create clipboard text");
    Ok(value)
}

pub fn write(text: &str) -> Result<()> {
    let _pool = Pool::new()?;
    let board = pasteboard()?;
    let kind = string_type()?;
    anyhow::ensure!(
        text.len() <= MAX_CLIPBOARD_BYTES,
        "refusing to place {} bytes on the clipboard",
        text.len()
    );
    let value = nsstring(text)?;
    let _ = send0_integer(board, "clearContents");
    let written = send2_object(board, "setString:forType:", value, kind);
    unsafe {
        CFRelease(value);
        CFRelease(kind);
    }
    if !written {
        bail!("NSPasteboard refused the text clipboard value");
    }
    Ok(())
}

pub fn read_or_explain() -> Result<(String, bool), String> {
    let _pool = Pool::new().map_err(|error| format!("{error:#}"))?;
    let board = pasteboard().map_err(|error| format!("{error:#}"))?;
    let kind = string_type().map_err(|error| format!("{error:#}"))?;
    let value = send1_object(board, "stringForType:", kind);
    unsafe {
        CFRelease(kind);
    }
    if value.is_null() {
        return Ok((String::new(), false));
    }
    let length_fn: unsafe extern "C" fn(Obj, Sel) -> usize =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    let length = unsafe { length_fn(value, selector("length")) };
    let mut truncated = length > MAX_CLIPBOARD_BYTES;
    let text_value = if truncated {
        let substring_fn: unsafe extern "C" fn(Obj, Sel, usize) -> Obj =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { substring_fn(value, selector("substringToIndex:"), MAX_CLIPBOARD_BYTES) }
    } else {
        value
    };
    let utf8 = send0(text_value, "UTF8String").cast::<c_char>();
    let text = if utf8.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(utf8) }
            .to_string_lossy()
            .into_owned()
    };
    let mut end = text.len().min(MAX_CLIPBOARD_BYTES);
    truncated |= end < text.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((text[..end].to_owned(), truncated))
}
