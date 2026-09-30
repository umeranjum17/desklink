//! Exercise the executable without accessing a desktop or loading native adapters.
#![cfg(target_os = "windows")]

use std::process::Command;

#[test]
fn compile_seam_reports_its_limits_and_refuses_serving() {
    let engine = env!("CARGO_BIN_EXE_desklink-host");
    for flag in ["version", "--version", "-V"] {
        let output = Command::new(engine).arg(flag).output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            env!("CARGO_PKG_VERSION")
        );
    }
    let output = Command::new(engine).arg("capabilities").output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["protocol"], 3);
    assert_eq!(value["platform"], "windows");
    assert_eq!(
        value["engine"],
        format!("desklink-host/{}", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(value["capture"]["backends"], serde_json::json!([]));
    assert_eq!(value["capture"]["displays"], serde_json::json!([]));
    assert_eq!(value["encode"]["codecs"], serde_json::json!([]));
    for feature in ["pointer", "wheel", "keyboard"] {
        assert_eq!(value["input"][feature], false);
    }
    for feature in ["read", "write"] {
        assert_eq!(value["clipboard"][feature], false);
    }
    for feature in ["capture", "encode", "input", "clipboard"] {
        assert!(!value[feature]["unavailable_reason"]["reason"]
            .as_str()
            .unwrap()
            .is_empty());
    }
    let output = Command::new(engine).arg("serve").output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("serve requires a VP9-enabled build"));
}
