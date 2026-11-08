//! Typed error model shared by the playback engine and adapters.

use std::fmt;

/// Stable error kind names for Host/addon mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackErrorKind {
    /// The request belongs to a stale project/timeline/session identity.
    Superseded,
    /// The session was stopped/cancelled while work was outstanding.
    Cancelled,
    /// Caller supplied invalid configuration/frame/identity values.
    InvalidInput,
    /// Decode or sink failed.
    Engine,
}

/// Playback error with a stable kind and human-readable message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackError {
    pub kind: PlaybackErrorKind,
    pub message: String,
}

impl PlaybackError {
    pub fn new(kind: PlaybackErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn superseded(message: impl Into<String>) -> Self {
        Self::new(PlaybackErrorKind::Superseded, message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(PlaybackErrorKind::Cancelled, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(PlaybackErrorKind::InvalidInput, message)
    }

    pub fn engine(message: impl Into<String>) -> Self {
        Self::new(PlaybackErrorKind::Engine, message)
    }
}

impl fmt::Display for PlaybackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for PlaybackError {}

pub type PlaybackResult<T> = Result<T, PlaybackError>;
