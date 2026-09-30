use anyhow::{bail, Result};
use serde_json::Value;

/// A selected display; Windows enumeration is deferred to the capture lane.
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

fn open_display_inner(_display_id: Option<u32>) -> Result<PortalSession> {
    bail!("{}", crate::capture::unavailable_reason())
}

pub fn displays() -> Vec<Value> {
    Vec::new()
}
