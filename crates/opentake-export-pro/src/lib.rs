//! Route B export prototype: **10-bit H.265**, **HDR/tone-map policy** and
//! **audio ducking** for the in-process Rust engine.
//!
//! This is an isolated export slice, not a change to the shared encoders
//! (`opentake-media::encode`, `crates/opentake-node`). It exists to answer three
//! questions with reproducible evidence before the production encoder is
//! extended:
//!
//! 1. Can the export path emit a genuine 10-bit HEVC stream (`yuv420p10le`,
//!    Main 10) from the SDR RGBA8 frames the wgpu compositor produces?
//! 2. What does an HDR policy look like when the compositor is SDR-only, and
//!    can this machine actually convert HDR (PQ) pixels to SDR?
//! 3. What sidechain/role contract is needed for ducking music under voice, and
//!    does the resulting envelope measure as the requested gain reduction?
//!
//! The crate deliberately has **no OpenTake path dependencies** so it can be
//! built and tested without the root workspace. The integration contract (how
//! this becomes `opentake_media::encode` / node addon code) lives in
//! `docs/architecture/route-b-export-pro.md`.
//!
//! Claims are kept separate, as required by the workstream:
//! - `10-bit encoding works` is proven by [`codec`] + real ffprobe output.
//! - `HDR content tone-mapped` is only claimed when [`hdr`] selected a real
//!   tone-map backend and the pixel values actually changed; otherwise the
//!   decision records "not tone-mapped" explicitly.

pub mod codec;
pub mod ducking;
pub mod hdr;
pub mod hdr10;
pub mod wav;

use std::fmt;

/// Errors raised by the export prototype.
#[derive(Debug)]
pub enum ExportProError {
    /// The requested codec/bit-depth/color combination is not encodable.
    InvalidSpec(String),
    /// A filesystem operation failed.
    Io(std::io::Error),
    /// Spawning ffmpeg or writing frames failed.
    Encode(String),
    /// Parsing or measuring an output failed.
    Analysis(String),
}

impl fmt::Display for ExportProError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExportProError::InvalidSpec(message) => write!(f, "invalid export spec: {message}"),
            ExportProError::Io(error) => write!(f, "io: {error}"),
            ExportProError::Encode(message) => write!(f, "encode: {message}"),
            ExportProError::Analysis(message) => write!(f, "analysis: {message}"),
        }
    }
}

impl std::error::Error for ExportProError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ExportProError::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ExportProError {
    fn from(error: std::io::Error) -> Self {
        ExportProError::Io(error)
    }
}

/// Result alias for the prototype.
pub type Result<T> = std::result::Result<T, ExportProError>;

/// Resolve the ffmpeg binary path: `OPENTAKE_FFMPEG` wins, otherwise `ffmpeg`
/// from `PATH`. This mirrors `opentake-media`'s development fallback but stays
/// independent of it.
pub fn ffmpeg_bin() -> String {
    std::env::var("OPENTAKE_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// Resolve the ffprobe binary path: `OPENTAKE_FFPROBE` wins, otherwise
/// `ffprobe` from `PATH`.
pub fn ffprobe_bin() -> String {
    std::env::var("OPENTAKE_FFPROBE").unwrap_or_else(|_| "ffprobe".to_string())
}
