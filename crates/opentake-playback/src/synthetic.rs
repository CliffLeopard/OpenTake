//! Deterministic frame source/sink used by tests, the cadence demo and scripts.
//! Production adapters replace these with ffmpeg/wgpu composition and JPEG/PNG
//! transport, while the engine behavior remains identical.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::cancel::CancelToken;
use crate::error::PlaybackResult;
use crate::frame::{FrameSink, FrameSource, PublishedFrame, RgbaFrame};

/// Generates small RGBA frames whose first pixel encodes the frame number.
#[derive(Debug)]
pub struct SyntheticSource {
    frame_count: i32,
    decode_calls: Arc<AtomicUsize>,
    fail_at: Option<i32>,
}

impl SyntheticSource {
    pub fn new(frame_count: i32) -> Self {
        Self {
            frame_count,
            decode_calls: Arc::new(AtomicUsize::new(0)),
            fail_at: None,
        }
    }

    pub fn with_failure_at(frame_count: i32, frame: i32) -> Self {
        Self {
            frame_count,
            decode_calls: Arc::new(AtomicUsize::new(0)),
            fail_at: Some(frame),
        }
    }

    pub fn decode_calls(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.decode_calls)
    }
}

impl FrameSource for SyntheticSource {
    fn frame_count(&self) -> i32 {
        self.frame_count
    }

    fn decode(&mut self, frame: i32, cancel: &CancelToken) -> PlaybackResult<RgbaFrame> {
        if cancel.is_cancelled() {
            return Err(crate::error::PlaybackError::cancelled(
                "decode cancelled before frame",
            ));
        }
        if frame < 0 || frame >= self.frame_count {
            return Err(crate::error::PlaybackError::invalid(format!(
                "frame {frame} is outside 0..{}",
                self.frame_count
            )));
        }
        if self.fail_at == Some(frame) {
            return Err(crate::error::PlaybackError::engine(format!(
                "synthetic decode failure at frame {frame}"
            )));
        }
        self.decode_calls.fetch_add(1, Ordering::AcqRel);
        let mut pixels = vec![0_u8; 4 * 4 * 4];
        let value = (frame % 256) as u8;
        for pixel in pixels.chunks_mut(4) {
            pixel[0] = value;
            pixel[1] = value.wrapping_add(1);
            pixel[2] = value.wrapping_add(2);
            pixel[3] = 255;
        }
        RgbaFrame::new(4, 4, pixels)
    }
}

/// Collects published frames for assertions/demos.
#[derive(Clone, Debug, Default)]
pub struct RecordingSink {
    frames: Arc<Mutex<Vec<PublishedFrame>>>,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn frames(&self) -> Vec<PublishedFrame> {
        self.frames
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn len(&self) -> usize {
        self.frames
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl FrameSink for RecordingSink {
    fn publish(&mut self, frame: &PublishedFrame) {
        self.frames
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(frame.clone());
    }
}
