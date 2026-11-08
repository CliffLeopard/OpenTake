//! Identity for one playback session.
//!
//! Mirrors the desktop `src-tauri/src/playback/session.rs` identity and the
//! Route B Host's `{projectEpoch, timelineVersion, sessionId}` payload. Every
//! control call carries the identity and is rejected as `Superseded` when it
//! does not match the engine's session, so late frames/commands from a replaced
//! timeline or project can never control the new one.

use crate::error::{PlaybackError, PlaybackResult};

/// Exact playback session identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PlaybackIdentity {
    project_epoch: u64,
    timeline_version: u64,
    session_id: String,
}

impl PlaybackIdentity {
    /// Validate and construct an identity.
    ///
    /// `sessionId` accepts 1..=128 ASCII alphanumeric / `-` characters, the
    /// same shape the desktop session validator accepts.
    pub fn new(
        project_epoch: u64,
        timeline_version: u64,
        session_id: impl Into<String>,
    ) -> PlaybackResult<Self> {
        let session_id = session_id.into();
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(PlaybackError::invalid(
                "playback sessionId must be 1..=128 characters",
            ));
        }
        if !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(PlaybackError::invalid(
                "playback sessionId may only contain ASCII alphanumeric or '-'",
            ));
        }
        Ok(Self {
            project_epoch,
            timeline_version,
            session_id,
        })
    }

    pub fn project_epoch(&self) -> u64 {
        self.project_epoch
    }

    pub fn timeline_version(&self) -> u64 {
        self.timeline_version
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// `(project_epoch, timeline_version)` revision pair.
    pub fn revision(&self) -> (u64, u64) {
        (self.project_epoch, self.timeline_version)
    }
}
