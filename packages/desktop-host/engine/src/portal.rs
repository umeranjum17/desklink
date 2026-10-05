//! Portal (XDG Desktop Portal ScreenCast) session negotiation.
//!
//! The portal is the only capture path this engine asks the compositor for: it
//! is what carries the user's consent, works across Wayland compositors, and
//! hands back a PipeWire remote that [`crate::capture`] consumes. Hidden-cursor
//! positions come from the compositor itself, through [`crate::wl_cursor`].

use anyhow::{Context, Result};
use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
use ashpd::desktop::PersistMode;
use ashpd::enumflags2::BitFlags;
use std::os::fd::OwnedFd;

/// What the portal gave us: a PipeWire remote plus the identity of the selected
/// source. `width`/`height` are the source's logical size in the compositor's
/// own scale; `position` is its origin in the desktop layout.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SelectedSource {
    pub node_id: u32,
    pub width: i32,
    pub height: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<(i32, i32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    /// Absolute origin of the selected source in the desktop layout. Reported
    /// for diagnostics and for geometry consumers only: input is applied in the
    /// source's own pixels, and nothing here is added to a converted
    /// coordinate.
    pub origin_x: i32,
    pub origin_y: i32,
}

pub struct PortalSession {
    pub fd: OwnedFd,
    pub cursor_mode: &'static str,
    pub source: SelectedSource,
    pub restore_token: Option<String>,
}

/// Ask the portal for a screen cast session.
///
/// `restore_token` is a token from an earlier session; supplying it lets a
/// backend skip the picker when its policy allows it. The returned token must be
/// persisted by the consumer and is single-use.
pub async fn open_display(_: Option<u32>) -> Result<PortalSession> {
    anyhow::bail!("display selection is only supported on macOS")
}

pub async fn open(
    restore_token: Option<&str>,
    cursor: crate::protocol::CursorMode,
) -> Result<PortalSession> {
    let proxy = Screencast::new()
        .await
        .context("compositor has no ScreenCast portal")?;

    if proxy
        .available_source_types()
        .await
        .is_ok_and(|types| !types.contains(SourceType::Monitor))
    {
        anyhow::bail!("ScreenCast portal advertises no monitor source");
    }

    let cursor_mode = if cursor == crate::protocol::CursorMode::Hidden {
        let available = proxy
            .available_cursor_modes()
            .await
            .context("portal did not advertise cursor modes")?;
        choose_cursor_mode(available)?
    } else {
        CursorMode::Embedded
    };
    let session = proxy
        .create_session()
        .await
        .context("ScreenCast.CreateSession failed")?;

    proxy
        .select_sources(
            &session,
            cursor_mode,
            BitFlags::from(SourceType::Monitor),
            false,
            restore_token,
            // Request a durable grant, not one tied to this engine process.
            // The portal still owns consent and may decline persistence.
            PersistMode::ExplicitlyRevoked,
        )
        .await
        .context("ScreenCast.SelectSources failed")?
        .response()
        .context("ScreenCast.SelectSources was cancelled")?;

    // `Start` is what the compositor uses to present its consent UI.
    let streams = proxy
        .start(&session, None)
        .await
        .context("ScreenCast.Start failed")?
        .response()
        .context("screen capture was not granted")?;

    let stream = streams
        .streams()
        .first()
        .context("portal returned no capture stream")?;

    let (width, height) = stream.size().context("portal stream has no logical size")?;
    let position = stream.position();

    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .context("OpenPipeWireRemote failed")?;

    Ok(PortalSession {
        cursor_mode: match cursor_mode {
            CursorMode::Metadata => "metadata",
            CursorMode::Hidden => "hidden",
            _ => "embedded",
        },
        fd,
        source: SelectedSource {
            node_id: stream.pipe_wire_node_id(),
            width,
            height,
            position,
            source_type: stream.source_type().map(|t| format!("{t:?}")),
            origin_x: position.map(|(x, _)| x).unwrap_or(0),
            origin_y: position.map(|(_, y)| y).unwrap_or(0),
        },
        restore_token: streams.restore_token().map(str::to_owned),
    })
}

/// Either mode keeps cursor pixels out of the stream; positions never come
/// from the portal.
fn choose_cursor_mode(available: BitFlags<CursorMode>) -> Result<CursorMode> {
    [CursorMode::Hidden, CursorMode::Metadata]
        .into_iter()
        .find(|mode| available.contains(*mode))
        .context("cursor-unavailable: portal cannot leave the cursor out of capture")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidden_takes_any_cursor_free_mode_and_refuses_embedded_only_portals() {
        assert_eq!(
            choose_cursor_mode(CursorMode::Metadata | CursorMode::Hidden).unwrap(),
            CursorMode::Hidden
        );
        assert_eq!(
            choose_cursor_mode(CursorMode::Metadata.into()).unwrap(),
            CursorMode::Metadata
        );
        let error = choose_cursor_mode(CursorMode::Embedded.into()).unwrap_err();
        assert!(error.to_string().contains("cursor-unavailable:"));
    }
}
