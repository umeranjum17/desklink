use serde_json::{json, Value};
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

type DisplayId = u32;

unsafe extern "C" {
    fn desklink_agent_overlay_main(display_id: i32) -> i32;
    fn desklink_image_bgra(image: *const c_void, length: *mut usize, stride: *mut usize)
        -> *mut u8;
}
type CfTypeRef = *const c_void;
type DisplayModeRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    pub(crate) fn CGPreflightScreenCaptureAccess() -> bool;
    pub(crate) fn CGPreflightPostEventAccess() -> bool;
    pub(crate) fn CGRequestPostEventAccess() -> bool;
    fn CGGetActiveDisplayList(max: u32, displays: *mut DisplayId, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> DisplayId;
    fn CGDisplayPixelsWide(display: DisplayId) -> usize;
    fn CGDisplayPixelsHigh(display: DisplayId) -> usize;
    fn CGDisplayCopyDisplayMode(display: DisplayId) -> DisplayModeRef;
    fn CGDisplayModeGetPixelWidth(mode: DisplayModeRef) -> usize;
    fn CGDisplayModeGetPixelHeight(mode: DisplayModeRef) -> usize;
    fn CGDisplayModeRelease(mode: DisplayModeRef);
    fn CGDisplayBounds(display: DisplayId) -> CGRect;
    fn CGSessionCopyCurrentDictionary() -> CfTypeRef;
    static kCGSSessionOnConsoleKey: CfTypeRef;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CfTypeRef;
    fn TISGetInputSourceProperty(source: CfTypeRef, property: CfTypeRef) -> CfTypeRef;
    static kTISPropertyInputSourceID: CfTypeRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDictionaryGetValue(dictionary: CfTypeRef, key: CfTypeRef) -> CfTypeRef;
    fn CFBooleanGetValue(value: CfTypeRef) -> bool;
    fn CFStringGetCString(value: CfTypeRef, buffer: *mut i8, size: isize, encoding: u32) -> bool;
    fn CFRelease(value: CfTypeRef);
    fn CFRunLoopRunInMode(mode: CfTypeRef, seconds: f64, return_after_source_handled: u8) -> i32;
    static kCFRunLoopDefaultMode: CfTypeRef;
}

pub(crate) fn displays() -> Vec<Value> {
    let mut ids = [0; 16];
    let mut count = 0;
    let result = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if result != 0 {
        return Vec::new();
    }
    let main = unsafe { CGMainDisplayID() };
    ids.into_iter().take(count as usize).map(|id| {
        let bounds = unsafe { CGDisplayBounds(id) };
        let mode = unsafe { CGDisplayCopyDisplayMode(id) };
        let (width, height) = if mode.is_null() {
            (unsafe { CGDisplayPixelsWide(id) }, unsafe { CGDisplayPixelsHigh(id) })
        } else {
            let pixels = unsafe { (CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetPixelHeight(mode)) };
            unsafe { CGDisplayModeRelease(mode); }
            pixels
        };
        json!({
            "id": id,
            "width": width,
            "height": height,
            "scale": if bounds.size.width > 0.0 { width as f64 / bounds.size.width } else { 1.0 },
            "points": { "width": bounds.size.width, "height": bounds.size.height },
            "origin": { "x": bounds.origin.x, "y": bounds.origin.y },
            "main": id == main
        })
    }).collect()
}

pub(crate) fn display_geometry(id: DisplayId) -> Option<(f64, f64, f64, f64)> {
    let bounds = unsafe { CGDisplayBounds(id) };
    (bounds.size.width > 0.0 && bounds.size.height > 0.0).then_some((
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
    ))
}

pub(crate) fn on_console() -> bool {
    let dictionary = unsafe { CGSessionCopyCurrentDictionary() };
    if dictionary.is_null() {
        return false;
    }
    let value = unsafe { CFDictionaryGetValue(dictionary, kCGSSessionOnConsoleKey) };
    let result = !value.is_null() && unsafe { CFBooleanGetValue(value) };
    unsafe {
        CFRelease(dictionary);
    }
    result
}

pub(crate) fn tcc_responsible_app_name() -> String {
    if let Ok(executable) = std::env::current_exe() {
        let path = executable.to_string_lossy();
        if let Some((bundle, _)) = path.split_once(".app/Contents/MacOS/") {
            if let Some(name) = std::path::Path::new(bundle)
                .file_name()
                .and_then(|name| name.to_str())
            {
                return name.to_owned();
            }
        }
    }
    match std::env::var("TERM_PROGRAM").as_deref() {
        Ok("Apple_Terminal") => String::from("Terminal"),
        Ok("iTerm.app") => String::from("iTerm"),
        _ => String::from("Node.js"),
    }
}

pub(crate) fn keyboard_layout() -> String {
    let source = unsafe { TISCopyCurrentKeyboardLayoutInputSource() };
    if source.is_null() {
        return String::from("unknown");
    }
    let value = unsafe { TISGetInputSourceProperty(source, kTISPropertyInputSourceID) };
    let mut buffer = [0i8; 256];
    let copied = !value.is_null()
        && unsafe {
            CFStringGetCString(
                value,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                0x0800_0100,
            )
        };
    unsafe {
        CFRelease(source);
    }
    if copied {
        unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    } else {
        String::from("unknown")
    }
}

#[cfg(not(desklink_vpx))]
fn capabilities() -> Value {
    let capture_granted = unsafe { CGPreflightScreenCaptureAccess() };
    let input_granted = unsafe { CGPreflightPostEventAccess() };
    json!({
        "protocol": 3,
        "engine": format!("desklink-host/{}", env!("CARGO_PKG_VERSION")),
        "platform": "macos",
        "session": { "kind": "quartz", "on_console": on_console() },
        "capture": {
            "mechanism": "screencapturekit",
            "backends": ["screencapturekit"],
            "formats": ["bgra"],
            "cursor": "embedded",
            "audio": false,
            "displays": displays(),
            "grant": if capture_granted { "granted" } else { "missing-screen-recording" },
            "unavailable_reason": if capture_granted { Value::Null } else { json!({
                "reason": format!("Screen Recording permission has not been granted to {}.", tcc_responsible_app_name()),
                "remedy": format!("Allow {} in System Settings › Privacy & Security › Screen & System Audio Recording, then reconnect.", tcc_responsible_app_name())
            }) }
        },
        "encode": { "codecs": [], "hardware": false },
        "input": {
            "mechanism": "quartz-cgevent",
            "pointer": input_granted,
            "wheel": input_granted,
            "keyboard": input_granted,
            "text": ["unicode", "us-ansi-keymap"],
            "layout": keyboard_layout(),
            "grant": if input_granted { "granted" } else { "missing-accessibility" },
            "unavailable_reason": if input_granted { Value::Null } else { json!({
                "reason": format!("Accessibility permission has not been granted to {}.", tcc_responsible_app_name()),
                "remedy": format!("Allow {} in System Settings › Privacy & Security › Accessibility on the Mac, then reconnect.", tcc_responsible_app_name())
            }) }
        },
        "clipboard": { "read": true, "write": true, "mime": ["text/plain;charset=utf-8"], "maxBytes": crate::clipboard::MAX_CLIPBOARD_BYTES }
    })
}

#[cfg(not(desklink_macos_cli))]
fn ensure_disclaimed() -> Result<(), String> {
    if std::env::var("DESKLINK_DISCLAIMED").as_deref() == Ok("1") {
        return Ok(());
    }
    unsafe {
        let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attributes) != 0 {
            return Err("could not initialize macOS spawn attributes".into());
        }
        let symbol = libc::dlsym(
            libc::RTLD_DEFAULT,
            b"responsibility_spawnattrs_setdisclaim\0".as_ptr().cast(),
        );
        if symbol.is_null() {
            libc::posix_spawnattr_destroy(&mut attributes);
            return Err("macOS process-disclaim API is unavailable; refusing to run with the parent process TCC identity".into());
        }
        let set_disclaim: unsafe extern "C" fn(
            *mut libc::posix_spawnattr_t,
            libc::c_int,
        ) -> libc::c_int = std::mem::transmute(symbol);
        let flags_ok = libc::posix_spawnattr_setflags(
            &mut attributes,
            libc::POSIX_SPAWN_SETEXEC as libc::c_short,
        ) == 0;
        let disclaim_ok = set_disclaim(&mut attributes, 1) == 0;
        if !flags_ok || !disclaim_ok {
            libc::posix_spawnattr_destroy(&mut attributes);
            return Err("could not configure macOS process-disclaim attributes".into());
        }
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let executable_c = std::ffi::CString::new(executable.as_os_str().as_encoded_bytes())
            .map_err(|e| e.to_string())?;
        let mut argv: Vec<std::ffi::CString> = std::env::args_os()
            .map(|s| std::ffi::CString::new(s.as_encoded_bytes()).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        let mut env: Vec<std::ffi::CString> = std::env::vars_os()
            .filter(|(k, _)| k != "DESKLINK_DISCLAIMED")
            .map(|(k, v)| {
                std::ffi::CString::new(format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<_, _>>()?;
        env.push(std::ffi::CString::new("DESKLINK_DISCLAIMED=1").unwrap());
        let mut argv_ptrs: Vec<*mut libc::c_char> =
            argv.iter_mut().map(|s| s.as_ptr() as *mut _).collect();
        argv_ptrs.push(std::ptr::null_mut());
        let mut env_ptrs: Vec<*mut libc::c_char> =
            env.iter_mut().map(|s| s.as_ptr() as *mut _).collect();
        env_ptrs.push(std::ptr::null_mut());
        let mut child = 0;
        let error = libc::posix_spawn(
            &mut child,
            executable_c.as_ptr(),
            std::ptr::null(),
            &attributes,
            argv_ptrs.as_ptr(),
            env_ptrs.as_ptr(),
        );
        libc::posix_spawnattr_destroy(&mut attributes);
        if error != 0 {
            return Err(format!("disclaimed self-exec failed: {error}"));
        }
        // SETEXEC normally replaces this process. If the platform instead
        // returns with a child, wait and preserve its exit status.
        let mut status = 0;
        if libc::waitpid(child, &mut status, 0) < 0 {
            return Err("could not wait for disclaimed engine process".into());
        }
        std::process::exit(if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            128 + libc::WTERMSIG(status)
        });
    }
}

pub(crate) fn request_screen_capture_content() -> Result<(), String> {
    use block2::RcBlock;
    use objc2_screen_capture_kit::SCShareableContent;

    let completed = Arc::new(AtomicBool::new(false));
    let callback_state = completed.clone();
    let completion = RcBlock::new(move |_content, _error| {
        callback_state.store(true, Ordering::Release);
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&completion) };
    let deadline = Instant::now() + Duration::from_secs(60);
    while !completed.load(Ordering::Acquire) && Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        unsafe {
            CFRunLoopRunInMode(
                kCFRunLoopDefaultMode,
                remaining.min(Duration::from_millis(100)).as_secs_f64(),
                0,
            )
        };
    }
    if completed.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(String::from(
            "capture-permission: timed out waiting for ScreenCaptureKit permission request",
        ))
    }
}

#[cfg(desklink_vpx)]
fn encode_probe() -> Result<(), String> {
    let mut frame = crate::convert::I420 {
        width: 640,
        height: 360,
        data: vec![96; 640 * 360 + 2 * 320 * 180],
    };
    frame.data[640 * 360..].fill(128);
    let mut encoder = crate::encoder::Encoder::new(640, 360, 1000, 30, 1)
        .map_err(|error| format!("VP9 encoder initialization failed: {error:#}"))?;
    let packet = encoder
        .encode(&frame, true)
        .map_err(|error| format!("VP9 encoding failed: {error:#}"))?;
    println!(
        "{}",
        serde_json::json!({"codec":"vp9", "width":640, "height":360, "bytes":packet.data.len(), "keyframe":packet.keyframe})
    );
    Ok(())
}

pub(crate) fn capture_display(
    display_id: DisplayId,
) -> Result<(Vec<u8>, usize, usize, usize), String> {
    use block2::RcBlock;
    use objc2_core_foundation::{
        CGPoint as NativePoint, CGRect as NativeRect, CGSize as NativeSize,
    };
    use objc2_screen_capture_kit::SCScreenshotManager;

    let bounds = unsafe { CGDisplayBounds(display_id) };
    let rect = NativeRect {
        origin: NativePoint {
            x: bounds.origin.x,
            y: bounds.origin.y,
        },
        size: NativeSize {
            width: bounds.size.width,
            height: bounds.size.height,
        },
    };
    let ready = Arc::new((
        Mutex::new(None::<Result<(Vec<u8>, usize, usize, usize), String>>),
        Condvar::new(),
    ));
    let callback_state = ready.clone();
    let callback = RcBlock::new(
        move |image: *mut objc2_core_graphics::CGImage, error: *mut objc2_foundation::NSError| {
            let frame = if !error.is_null() || image.is_null() {
                Err(String::from(
                    "ScreenCaptureKit returned an error or no image",
                ))
            } else {
                let image = unsafe { &*image };
                let width = objc2_core_graphics::CGImage::width(Some(image));
                let height = objc2_core_graphics::CGImage::height(Some(image));
                let mut length = 0;
                let mut stride = 0;
                let pointer = unsafe {
                    desklink_image_bgra(
                        image as *const _ as *const c_void,
                        &mut length,
                        &mut stride,
                    )
                };
                if pointer.is_null() || width == 0 || height == 0 {
                    Err(String::from(
                        "ScreenCaptureKit image could not be converted to BGRA",
                    ))
                } else {
                    let bytes = unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec();
                    unsafe { libc::free(pointer.cast()) };
                    Ok((bytes, width, height, stride))
                }
            };
            let (lock, wake) = &*callback_state;
            if let Ok(mut result) = lock.lock() {
                *result = Some(frame);
                wake.notify_one();
            }
        },
    );
    unsafe {
        SCScreenshotManager::captureImageInRect_completionHandler(rect, Some(&callback));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let (lock, wake) = &*ready;
    let mut result = lock
        .lock()
        .map_err(|_| String::from("capture lock poisoned"))?;
    while result.is_none() && Instant::now() < deadline {
        let (next, _) = wake
            .wait_timeout(result, deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| String::from("capture wait failed"))?;
        result = next;
    }
    result
        .take()
        .unwrap_or_else(|| Err(String::from("ScreenCaptureKit timed out")))
}

#[cfg(all(desklink_vpx, not(desklink_macos_cli)))]
fn indicator_demo(display_id: u32, path: &str) -> Result<(), String> {
    use std::io::Write;
    let (width, height) = (unsafe { CGDisplayPixelsWide(display_id) }, unsafe {
        CGDisplayPixelsHigh(display_id)
    });
    let mut indicator = crate::indicator::Indicator::start(display_id, width, height)
        .map_err(|error| error.to_string())?;
    let (out_w, out_h) = crate::convert::fit(width, height, 960, 640);
    let mut file = std::fs::File::create(path).map_err(|error| error.to_string())?;
    for frame in 0..56 {
        let t = frame as f64 / 55.0;
        let x = ((0.15 + t * 0.7) * width as f64) as i64;
        let y = ((0.35 + (t * std::f64::consts::TAU).sin() * 0.13) * height as f64) as i64;
        indicator.event(if frame == 14 || frame == 35 { 'C' } else { 'M' }, x, y);
        if frame == 24 {
            indicator.event('T', -1, -1);
        }
        let (pixels, w, h, stride) = capture_display(display_id)?;
        if frame == 0 {
            eprintln!(
                "demo capture: {w}x{h} stride={stride} bytes={}",
                pixels.len()
            );
        }
        let raw = crate::convert::to_bgrx(
            &pixels,
            w,
            h,
            stride,
            crate::convert::PixelFormat::Bgra,
            out_w,
            out_h,
        )
        .ok_or_else(|| String::from("could not scale demo frame"))?;
        file.write_all(&raw).map_err(|error| error.to_string())?;
        std::thread::sleep(Duration::from_millis(65));
    }
    drop(indicator);
    println!("{}x{} frames=56 path={path}", out_w, out_h);
    Ok(())
}

#[cfg(all(desklink_vpx, not(desklink_macos_cli)))]
fn record_agent_overlay(path: &str) -> Result<(), String> {
    use std::io::Write;
    let display = unsafe { CGMainDisplayID() };
    let (w, h) = crate::convert::fit(unsafe { CGDisplayPixelsWide(display) },
        unsafe { CGDisplayPixelsHigh(display) }, 960, 640);
    let mut file = std::fs::File::create(path).map_err(|error| error.to_string())?;
    for _ in 0..30 {
        let (pixels, sw, sh, stride) = capture_display(display)?;
        let raw = crate::convert::to_bgrx(&pixels, sw, sh, stride,
            crate::convert::PixelFormat::Bgra, w, h)
            .ok_or_else(|| String::from("could not scale recording frame"))?;
        file.write_all(&raw).map_err(|error| error.to_string())?;
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("{w}x{h} frames=30 path={path}");
    Ok(())
}

fn capture_probe(seconds: u64) -> Result<Value, String> {
    use block2::RcBlock;
    use objc2_core_foundation::{
        CGPoint as NativePoint, CGRect as NativeRect, CGSize as NativeSize,
    };
    use objc2_screen_capture_kit::SCScreenshotManager;

    let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let rect = NativeRect {
        origin: NativePoint {
            x: bounds.origin.x,
            y: bounds.origin.y,
        },
        size: NativeSize {
            width: bounds.size.width,
            height: bounds.size.height,
        },
    };
    let ready = Arc::new((
        Mutex::new(None::<Result<(usize, usize, u64), String>>),
        Condvar::new(),
    ));
    let callback_state = ready.clone();
    let callback = RcBlock::new(
        move |image: *mut objc2_core_graphics::CGImage, error: *mut objc2_foundation::NSError| {
            let frame = if !error.is_null() || image.is_null() {
                Err(String::from(
                    "ScreenCaptureKit returned an error or no image",
                ))
            } else {
                let image = unsafe { &*image };
                let provider = objc2_core_graphics::CGImage::data_provider(Some(image));
                let data = provider
                    .as_deref()
                    .and_then(|provider| objc2_core_graphics::CGDataProvider::data(Some(provider)));
                match data {
                    Some(data) => {
                        let length = data.length().max(0) as usize;
                        let pointer = data.byte_ptr();
                        if length == 0 || pointer.is_null() {
                            Err(String::from("ScreenCaptureKit image has empty pixel data"))
                        } else {
                            let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
                            let mut hash = 0xcbf29ce484222325u64;
                            for byte in bytes {
                                hash = (hash ^ *byte as u64).wrapping_mul(0x100000001b3);
                            }
                            Ok((
                                objc2_core_graphics::CGImage::width(Some(image)),
                                objc2_core_graphics::CGImage::height(Some(image)),
                                hash,
                            ))
                        }
                    }
                    None => Err(String::from("ScreenCaptureKit image has no pixel data")),
                }
            };
            let (lock, wake) = &*callback_state;
            if let Ok(mut result) = lock.lock() {
                *result = Some(frame);
                wake.notify_one();
            }
        },
    );
    let deadline = Instant::now() + Duration::from_secs(seconds.max(1));
    let mut frames = 0u64;
    let mut dimensions = (0, 0);
    let mut distinct_frames = std::collections::BTreeSet::new();
    while Instant::now() < deadline {
        unsafe {
            SCScreenshotManager::captureImageInRect_completionHandler(rect, Some(&callback));
        }
        let (lock, wake) = &*ready;
        let mut result = lock
            .lock()
            .map_err(|_| String::from("capture-probe lock poisoned"))?;
        while result.is_none() && Instant::now() < deadline {
            let (next, _) = wake
                .wait_timeout(result, Duration::from_millis(100))
                .map_err(|_| String::from("capture-probe wait failed"))?;
            result = next;
        }
        if let Some(frame) = result.take() {
            let (width, height, hash) = frame?;
            dimensions = (width, height);
            distinct_frames.insert(hash);
            frames += 1;
        }
        std::thread::sleep(Duration::from_millis(33));
    }
    if frames == 0 {
        return Err(String::from("ScreenCaptureKit delivered no frames"));
    }
    Ok(
        serde_json::json!({"frames": frames, "distinct_frames": distinct_frames.len(), "source": {"kind":"screencapturekit", "width":dimensions.0, "height":dimensions.1}}),
    )
}

pub fn run() -> i32 {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".into());
    if matches!(
        command.as_str(),
        "serve" | "capabilities" | "capture-probe" | "indicator-demo" | "axi-record" | "setup-input"
    ) {
        #[cfg(not(desklink_macos_cli))]
        if let Err(error) = ensure_disclaimed() {
            eprintln!("error: {error}");
            return 1;
        }
    }
    match command.as_str() {
        "axi-bridge" => {
            let Some(cli) = args.next() else { eprintln!("usage: desklink-host axi-bridge <absolute desklink-axi.js> [start flags]"); return 2; };
            let engine = match std::env::current_exe() { Ok(path) => path, Err(error) => { eprintln!("engine path: {error}"); return 1; } };
            let result = std::process::Command::new("/opt/homebrew/bin/node")
                .arg(cli).arg("--bridge").args(args)
                .env("DESKLINK_AXI_ENGINE", engine).env("DESKLINK_MACOS", "1")
                .status();
            return match result { Ok(status) => status.code().unwrap_or(1), Err(error) => { eprintln!("axi bridge: {error}"); 1 } };
        }
        "agent-overlay" => {
            let display = args.next().and_then(|value| value.parse().ok()).unwrap_or(0);
            return unsafe { desklink_agent_overlay_main(display) };
        }
        "version" | "--version" | "-V" => println!("{}", env!("CARGO_PKG_VERSION")),
        "capabilities" => {
            #[cfg(desklink_vpx)]
            let value = crate::session::capabilities();
            #[cfg(not(desklink_vpx))]
            let value = capabilities();
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
        }
        "serve" => {
            #[cfg(desklink_vpx)]
            {
                let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    Err(error) => { eprintln!("error: cannot start the runtime: {error}"); return 1; }
                };
                return crate::report(runtime.block_on(crate::serve()));
            }
            #[cfg(not(desklink_vpx))]
            {
                eprintln!("serve requires a VP9-enabled build; set DESKLINK_VPX_STATIC_DIR and rebuild");
                return 1;
            }
        }
        "encode-probe" => {
            #[cfg(desklink_vpx)]
            if let Err(error) = encode_probe() {
                eprintln!("encode-probe: {error}");
                return 1;
            }
            #[cfg(not(desklink_vpx))]
            {
                eprintln!("encode-probe requires DESKLINK_VPX_STATIC_DIR");
                return 1;
            }
        }
        #[cfg(all(desklink_vpx, not(desklink_macos_cli)))]
        "axi-record" => {
            let Some(path) = args.next() else { eprintln!("axi-record requires an output path"); return 2; };
            if let Err(error) = record_agent_overlay(&path) { eprintln!("axi-record: {error}"); return 1; }
        }
        #[cfg(all(desklink_vpx, not(desklink_macos_cli)))]
        "indicator-demo" => {
            let display = args.next().and_then(|value| value.parse().ok()).unwrap_or(0);
            let path = args.next().unwrap_or_else(|| String::from("indicator-demo.bgrx"));
            if let Err(error) = indicator_demo(display, &path) {
                eprintln!("indicator-demo: {error}"); return 1;
            }
        }
        "capture-probe" => {
            let mut seconds = 3;
            let mut output_path = None;
            while let Some(argument) = args.next() {
                if argument == "--out" {
                    output_path = args.next();
                } else if let Ok(value) = argument.parse() {
                    seconds = value;
                }
            }
            let result = if unsafe { CGPreflightScreenCaptureAccess() } {
                capture_probe(seconds)
            } else {
                request_screen_capture_content().and_then(|_| Err(format!("capture-permission: allow {} in System Settings › Privacy & Security › Screen & System Audio Recording, then reconnect", tcc_responsible_app_name())))
            };
            let output = result.as_ref().map_or_else(
                |error| serde_json::json!({"error": error}),
                |value| value.clone(),
            );
            if let Some(path) = output_path {
                if let Err(error) = std::fs::write(&path, serde_json::to_vec_pretty(&output).unwrap()) {
                    eprintln!("capture-probe: could not write {path}: {error}");
                    return 1;
                }
            } else {
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
            }
            if let Err(error) = result {
                eprintln!("capture-probe: {error}");
                return 1;
            }
        }
        "setup-input" => {
            if crate::input::probe().is_ok() {
                println!("Accessibility permission is already granted to {}.", tcc_responsible_app_name());
            } else {
                let _ = crate::input::request_access();
                println!("If the Accessibility alert did not open, allow {} in System Settings › Privacy & Security › Accessibility.", tcc_responsible_app_name());
            }
        }
        _ => println!("desklink-host {}\nUSAGE: desklink-host [serve|capabilities|capture-probe|encode-probe|setup-input|version]", env!("CARGO_PKG_VERSION")),
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(desklink_vpx)]
    #[test]
    fn session_capabilities_are_non_prompting_and_expose_mac_features() {
        let value = crate::session::capabilities();
        assert_eq!(value["protocol"], crate::protocol::PROTOCOL_VERSION);
        assert_eq!(value["platform"], "macos");
        assert_eq!(value["capture"]["mechanism"], "screencapturekit");
        assert_eq!(value["encode"]["codecs"], json!(["vp9"]));
        assert!(value["capture"]["displays"].is_array());
        assert!(value["clipboard"]["read"].as_bool().unwrap());
        assert!(matches!(
            value["capture"]["grant"].as_str(),
            Some("granted" | "missing-screen-recording")
        ));
        assert!(matches!(
            value["input"]["grant"].as_str(),
            Some("granted" | "missing-accessibility")
        ));
    }
}
