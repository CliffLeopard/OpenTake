//! Frame model and the source/sink adapters.
//!
//! `FrameSource` is what the addon will bind to `opentake-media` decode plus
//! `opentake-render` composition. `FrameSink` is what the Host will bind to its
//! JPEG/PNG transport. Keeping both as traits makes the core deterministic and
//! crate-local; no ffmpeg/GPU dependency is needed to test playback lifecycle.

use crate::cancel::CancelToken;
use crate::error::PlaybackResult;
use crate::identity::PlaybackIdentity;

/// One decoded/composited RGBA frame (straight or premultiplied per adapter;
/// the sink must document its expectation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbaFrame {
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> PlaybackResult<Self> {
        if width == 0 || height == 0 {
            return Err(crate::error::PlaybackError::invalid(
                "frame width/height must be > 0",
            ));
        }
        let expected = width as usize * height as usize * 4;
        if pixels.len() != expected {
            return Err(crate::error::PlaybackError::invalid(format!(
                "RGBA buffer is {} bytes, expected {expected}",
                pixels.len()
            )));
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    pub fn byte_len(&self) -> usize {
        self.pixels.len()
    }
}

/// Produce the RGBA frame for one timeline frame. Implementations should check
/// `cancel` before/after a blocking decode and return `Cancelled` promptly.
pub trait FrameSource: Send {
    fn frame_count(&self) -> i32;
    fn decode(&mut self, frame: i32, cancel: &CancelToken) -> PlaybackResult<RgbaFrame>;
}

/// Consume a published frame. The engine calls this only while the publication
/// gate is open (playing) and with the current identity/generation, so a sink
/// never receives a stale session frame from this core.
pub trait FrameSink: Send {
    fn publish(&mut self, frame: &PublishedFrame);
}

/// One frame handed to the sink, carrying the guard fields the Host transport
/// needs to match late image loads/events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedFrame {
    pub identity: PlaybackIdentity,
    /// Increments on every seek; queued frames from older generations are
    /// discarded before they can publish.
    pub generation: u64,
    /// Monotonic publication sequence; resets to 1 on seek.
    pub sequence: u64,
    /// Timeline frame shown.
    pub frame: i32,
    /// True for the final frame of the session (engine stops after publishing).
    pub terminal: bool,
    pub image: RgbaFrame,
}
