use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::os::raw::c_void;

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
type CfTypeRef = *const c_void;
type DisplayModeRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
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
}

fn displays() -> Vec<Value> {
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

fn on_console() -> bool {
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

fn keyboard_layout() -> String {
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

fn capabilities() -> Value {
    let capture_granted = unsafe { CGPreflightScreenCaptureAccess() };
    let input_granted = unsafe { CGPreflightPostEventAccess() };
    json!({
        "protocol": 2,
        "engine": format!("desklink-host/{}", env!("CARGO_PKG_VERSION")),
        "platform": "macos",
        "session": { "kind": "quartz", "on_console": on_console() },
        "capture": {
            "mechanism": "screencapturekit",
            "backends": [],
            "formats": ["bgra"],
            "cursor": "embedded",
            "audio": false,
            "displays": displays(),
            "grant": if capture_granted { "granted" } else { "missing-screen-recording" },
            "unavailable_reason": if capture_granted { Value::Null } else { json!({
                "reason": "Screen Recording permission has not been granted to desklink-host.",
                "remedy": "Allow desklink-host in System Settings › Privacy & Security › Screen & System Audio Recording on the Mac, then reconnect."
            }) }
        },
        "encode": { "codecs": [], "hardware": false },
        "input": {
            "mechanism": "quartz-cgevent",
            "pointer": false,
            "wheel": false,
            "keyboard": false,
            "text": ["unicode"],
            "layout": keyboard_layout(),
            "grant": if input_granted { "granted" } else { "missing-accessibility" },
            "unavailable_reason": if input_granted { Value::Null } else { json!({
                "reason": "Accessibility permission has not been granted to desklink-host.",
                "remedy": "Allow desklink-host in System Settings › Privacy & Security › Accessibility on the Mac, then reconnect."
            }) }
        },
        "clipboard": { "read": false, "write": false, "mime": ["text/plain;charset=utf-8"], "maxBytes": 262144 }
    })
}

fn reply(id: Value, result: Option<Value>, error: Option<(&str, &str)>) -> Value {
    let mut response = json!({ "id": id });
    if let Some(result) = result {
        response["result"] = result;
    }
    if let Some((code, message)) = error {
        response["error"] = json!({ "code": code, "message": message });
    }
    response
}

fn dispatch(request: &Value, hello_seen: &mut bool) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "hello" => {
            let version = request
                .pointer("/params/protocol")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if version != 2 {
                return reply(
                    id,
                    None,
                    Some(("unsupported-protocol", "this engine speaks protocol 2")),
                );
            }
            *hello_seen = true;
            reply(id, Some(capabilities()), None)
        }
        "capabilities" => reply(id, Some(capabilities()), None),
        "shutdown" => reply(id, Some(json!({})), None),
        "session.open" if !*hello_seen => reply(
            id,
            None,
            Some((
                "unsupported-protocol",
                "send `hello` with protocol 2 before anything else",
            )),
        ),
        "session.open" => {
            if !on_console() {
                return reply(
                    id,
                    None,
                    Some((
                        "no-screen",
                        "no active console session is available on the Mac",
                    )),
                );
            }
            let params = &request["params"];
            let source = &params["source"];
            if !source.is_null() && source["kind"] != "display" {
                return reply(
                    id,
                    None,
                    Some(("source", "only a macOS display source is supported")),
                );
            }
            let permissions = params["permissions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if permissions.iter().any(|p| p == "control")
                && !unsafe { CGPreflightPostEventAccess() }
            {
                let _ = unsafe { CGRequestPostEventAccess() };
                return reply(id, None, Some(("input-unavailable", "Allow desklink-host in System Settings › Privacy & Security › Accessibility on the Mac, then reconnect.")));
            }
            if permissions.iter().any(|p| p == "view")
                && !unsafe { CGPreflightScreenCaptureAccess() }
            {
                let _ = unsafe { CGRequestScreenCaptureAccess() };
                return reply(id, None, Some(("capture-permission", "Allow desklink-host in System Settings › Privacy & Security › Screen & System Audio Recording on the Mac, then reconnect.")));
            }
            reply(
                id,
                None,
                Some(("source", "ScreenCaptureKit session support is added in M3.")),
            )
        }
        _ => reply(id, None, Some(("operation", "unknown method"))),
    }
}

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

pub fn run() -> i32 {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".into());
    if matches!(command.as_str(), "serve" | "capabilities" | "capture-probe") {
        if let Err(error) = ensure_disclaimed() {
            eprintln!("error: {error}");
            return 1;
        }
    }
    match command.as_str() {
        "version" | "--version" | "-V" => println!("{}", env!("CARGO_PKG_VERSION")),
        "capabilities" => println!("{}", serde_json::to_string_pretty(&capabilities()).unwrap()),
        "serve" => {
            let stdin = io::stdin();
            let mut hello_seen = false;
            for line in stdin.lock().lines() {
                let Ok(line) = line else { return 1; };
                let (response, shutdown) = match serde_json::from_str::<Value>(&line) {
                    Ok(request) => {
                        let shutdown = request.get("method").and_then(Value::as_str) == Some("shutdown");
                        (dispatch(&request, &mut hello_seen), shutdown)
                    }
                    Err(_) => (reply(Value::Null, None, Some(("malformed", "request is not valid JSON"))), false),
                };
                if writeln!(io::stdout().lock(), "{}", response).is_err() { return 1; }
                if shutdown { return 0; }
            }
        }
        "capture-probe" => {
            if !unsafe { CGPreflightScreenCaptureAccess() } {
                let _ = unsafe { CGRequestScreenCaptureAccess() };
                eprintln!("capture-permission: allow desklink-host in System Settings › Privacy & Security › Screen & System Audio Recording, then reconnect");
                return 1;
            }
            eprintln!("capture-probe requires M3 ScreenCaptureKit support");
            return 1;
        }
        "setup-input" => println!("Accessibility permission is required for desktop input; no settings were changed."),
        _ => println!("desklink-host {}\nUSAGE: desklink-host [serve|capabilities|capture-probe|setup-input|version]", env!("CARGO_PKG_VERSION")),
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_are_non_prompting_and_report_staged_backends_as_unavailable() {
        let value = capabilities();
        assert_eq!(value["platform"], "macos");
        assert_eq!(value["session"]["kind"], "quartz");
        assert_eq!(value["capture"]["backends"], json!([]));
        assert_eq!(value["input"]["pointer"], false);
        assert_eq!(value["clipboard"]["read"], false);
        assert!(value["capture"]["displays"].is_array());
        assert!(matches!(
            value["capture"]["grant"].as_str(),
            Some("granted" | "missing-screen-recording")
        ));
        assert!(matches!(
            value["input"]["grant"].as_str(),
            Some("granted" | "missing-accessibility")
        ));

        let mut hello = false;
        let response = dispatch(
            &json!({"id": 3, "method": "hello", "params": {"protocol": 2}}),
            &mut hello,
        );
        assert!(hello);
        assert_eq!(response["id"], 3);
        assert_eq!(response["result"]["platform"], "macos");

        let invalid_source = dispatch(
            &json!({"id": 4, "method": "session.open", "params": {"source": {"kind": "portal"}}}),
            &mut hello,
        );
        assert_eq!(invalid_source["error"]["code"], "source");
    }
}
