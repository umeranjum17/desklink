//! Exercise the executable without accessing a desktop or loading native adapters.
#![cfg(target_os = "windows")]

use std::process::Command;

#[test]
fn windows_engine_reports_available_codecs_and_desktop_limits() {
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
    let codecs = if cfg!(desklink_vpx) {
        serde_json::json!(["vp9"])
    } else {
        serde_json::json!([])
    };
    assert_eq!(value["encode"]["codecs"], codecs);
    for feature in ["pointer", "wheel", "keyboard"] {
        assert_eq!(value["input"][feature], false);
    }
    for feature in ["read", "write"] {
        assert_eq!(value["clipboard"][feature], false);
    }
    for feature in ["capture", "input", "clipboard"] {
        assert!(!value[feature]["unavailable_reason"]["reason"]
            .as_str()
            .unwrap()
            .is_empty());
    }
    #[cfg(not(desklink_vpx))]
    {
        let output = Command::new(engine).arg("serve").output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("serve requires a VP9-enabled build"));
    }
}

#[cfg(desklink_vpx)]
#[test]
fn serving_handshakes_reports_missing_source_with_optional_indicator_and_stops_on_eof() {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = Command::new(env!("CARGO_BIN_EXE_desklink-host"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for request in [
        serde_json::json!({"id":1,"method":"hello","params":{"protocol":3}}),
        serde_json::json!({"id":2,"method":"capabilities"}),
        serde_json::json!({"id":3,"method":"session.open","params":{
            "permissions":["view","control"],"agent_indicator":true}}),
        serde_json::json!({"id":4,"method":"session.open","params":{
            "permissions":["view","control"],"agent_indicator":false}}),
    ] {
        writeln!(input, "{request}").unwrap();
    }
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(15);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("serving engine did not exit on stdin EOF");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let messages: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0]["result"]["protocol"], 3);
    assert_eq!(messages[0]["result"], messages[1]["result"]);
    assert_eq!(messages[2]["id"], 3);
    assert_eq!(messages[3]["id"], 4);
    assert_eq!(messages[2]["error"]["code"], "source");
    assert_eq!(messages[2]["error"], messages[3]["error"]);
}
