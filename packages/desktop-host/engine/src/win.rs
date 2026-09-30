//! Compile-only Windows host seam; no native desktop access or session serving.

use serde_json::{json, Value};

fn capabilities() -> Value {
    json!({
        "protocol": 3,
        "engine": format!("desklink-host/{}", env!("CARGO_PKG_VERSION")),
        "platform": "windows",
        "session": { "kind": "windows" },
        "x11": { "available": false },
        "capture": {
            "mechanism": "unavailable",
            "backends": [],
            "formats": [],
            "cursor": "unavailable",
            "audio": false,
            "displays": crate::portal::displays(),
            "grant": "unavailable",
            "unavailable_reason": {
                "reason": crate::capture::unavailable_reason(),
                "remedy": "Use a future Windows capture-enabled build."
            }
        },
        "encode": {
            "codecs": [],
            "hardware": false,
            "unavailable_reason": {
                "reason": "Windows encoding is not implemented in this build; libvpx is not linked.",
                "remedy": "Use a future Windows VP9-enabled build."
            }
        },
        "input": {
            "mechanism": "unavailable",
            "pointer": false,
            "wheel": false,
            "keyboard": false,
            "text": [],
            "layout": crate::keymap::keyboard_layout(),
            "grant": "unavailable",
            "unavailable_reason": {
                "reason": crate::input::unavailable_reason(),
                "remedy": "Use a future Windows input-enabled build."
            }
        },
        "clipboard": {
            "read": false,
            "write": false,
            "mime": [],
            "maxBytes": crate::clipboard::MAX_CLIPBOARD_BYTES,
            "unavailable_reason": {
                "reason": "Windows clipboard transfer is not implemented in this build.",
                "remedy": "Use a future Windows clipboard-enabled build."
            }
        }
    })
}

pub fn run() -> i32 {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| String::from("help"));
    match command.as_str() {
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
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("error: cannot start the runtime: {error}");
                        return 1;
                    }
                };
                return crate::report(runtime.block_on(crate::serve()));
            }
            #[cfg(not(desklink_vpx))]
            {
                eprintln!("serve requires a VP9-enabled build; Windows libvpx integration is not available in this compile-seam build");
                return 1;
            }
        }
        "help" | "--help" | "-h" => {
            println!("desklink-host — Windows compile seam\n\nCommands: version, capabilities, serve\nWindows session serving requires a future VP9-enabled build.");
        }
        _ => {
            eprintln!("unknown command: {command}; run desklink-host --help");
            return 2;
        }
    }
    0
}
