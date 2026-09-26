use anyhow::{bail, Result};
use serde_json::Value;

/// A selected macOS display. `node_id` is its CoreGraphics display identifier.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SelectedSource {
    pub node_id: u32,
    pub width: i32,
    pub height: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<(i32, i32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    pub origin_x: i32,
    pub origin_y: i32,
}

pub struct PortalSession {
    pub source: SelectedSource,
    pub restore_token: Option<String>,
}

pub async fn open(_restore_token: Option<&str>) -> Result<PortalSession> {
    open_display_inner(None)
}

pub async fn open_display(display_id: Option<u32>) -> Result<PortalSession> {
    open_display_inner(display_id)
}

fn open_display_inner(display_id: Option<u32>) -> Result<PortalSession> {
    if !unsafe { crate::mac::CGPreflightScreenCaptureAccess() } {
        crate::mac::request_screen_capture_content().map_err(anyhow::Error::msg)?;
        if !unsafe { crate::mac::CGPreflightScreenCaptureAccess() } {
            bail!("capture-permission: allow {} in System Settings › Privacy & Security › Screen & System Audio Recording, then reconnect", crate::mac::tcc_responsible_app_name());
        }
    }
    let displays = crate::mac::displays();
    let selected = displays
        .iter()
        .find(|display| {
            display_id.is_some_and(|id| display["id"].as_u64() == Some(id as u64))
                || (display_id.is_none() && display["main"] == true)
        })
        .or_else(|| display_id.is_none().then(|| displays.first()).flatten())
        .ok_or_else(|| anyhow::anyhow!("no active display is available on the Mac"))?;
    let origin_x = selected
        .pointer("/origin/x")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as i32;
    let origin_y = selected
        .pointer("/origin/y")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as i32;
    let source = SelectedSource {
        node_id: selected["id"].as_u64().unwrap_or_default() as u32,
        width: selected["width"].as_u64().unwrap_or_default() as i32,
        height: selected["height"].as_u64().unwrap_or_default() as i32,
        position: Some((origin_x, origin_y)),
        source_type: Some(String::from("display")),
        origin_x,
        origin_y,
    };
    Ok(PortalSession {
        source,
        restore_token: None,
    })
}
