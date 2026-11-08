//! Clocks: cpal sample position (master), wall clock and manual test clock.
//!
//! The engine asks a [`Clock`] for the current *target timeline frame*. In
//! production an [`AudioClock`] is driven by the cpal output callback: the
//! callback counts output sample frames, and [`AudioClock::frame`] converts that
//! position to a project frame. A [`WallClock`] is the silent/fallback path for
//! surfaces where audio is unavailable. [`ManualClock`] makes cadence and seek
//! tests deterministic.

use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::error::{PlaybackError, PlaybackResult};

/// Which clock is driving the session (reported by status/diagnostics).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClockKind {
    Audio,
    Wall,
    Manual,
}

/// A source of the current target timeline frame.
pub trait Clock: Send + Sync {
    /// Current target frame. May be outside the engine bounds; the engine clamps.
    fn frame(&self) -> i32;
    /// Rebase the clock so it resumes counting from `frame`.
    fn reset(&self, frame: i32);
    fn kind(&self) -> ClockKind;
}

/// Deterministic clock for tests and the cadence demo.
#[derive(Debug)]
pub struct ManualClock {
    frame: AtomicI32,
}

impl ManualClock {
    pub fn new(frame: i32) -> Self {
        Self {
            frame: AtomicI32::new(frame),
        }
    }

    pub fn set_frame(&self, frame: i32) {
        self.frame.store(frame, Ordering::Release);
    }
}

impl Clock for ManualClock {
    fn frame(&self) -> i32 {
        self.frame.load(Ordering::Acquire)
    }

    fn reset(&self, frame: i32) {
        self.set_frame(frame);
    }

    fn kind(&self) -> ClockKind {
        ClockKind::Manual
    }
}

/// Monotonic wall clock used when the timeline has no audio device/audio track.
#[derive(Debug)]
pub struct WallClock {
    state: Mutex<(Instant, i32)>,
    fps: i32,
}

impl WallClock {
    pub fn new(start_frame: i32, fps: i32) -> PlaybackResult<Self> {
        if fps <= 0 {
            return Err(PlaybackError::invalid("playback fps must be > 0"));
        }
        Ok(Self {
            state: Mutex::new((Instant::now(), start_frame)),
            fps,
        })
    }
}

impl Clock for WallClock {
    fn frame(&self) -> i32 {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (origin, base) = *guard;
        base.saturating_add((origin.elapsed().as_secs_f64() * self.fps as f64) as i32)
    }

    fn reset(&self, frame: i32) {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = (Instant::now(), frame);
    }

    fn kind(&self) -> ClockKind {
        ClockKind::Wall
    }
}

/// Convert a played output-sample count to the nearest timeline frame.
pub fn frame_for_sample(sample_position: u64, sample_rate: u32, fps: i32) -> i32 {
    if sample_rate == 0 || fps <= 0 {
        return 0;
    }
    ((sample_position as f64 / sample_rate as f64) * fps as f64) as i32
}

/// Convert a timeline frame to the output-sample position for a seek.
pub fn samples_for_frame(frame: i32, sample_rate: u32, fps: i32) -> u64 {
    if sample_rate == 0 || fps <= 0 {
        return 0;
    }
    ((frame.max(0) as f64 / fps as f64) * sample_rate as f64).round() as u64
}

/// cpal-driven master clock.
///
/// The cpal output callback owns the `AtomicU64` and increments it by the number
/// of output frames it rendered. The clock only reads that counter, so it can be
/// cloned into the engine while the `!Send` cpal `Stream` stays on the audio
/// thread/owner.
#[derive(Debug)]
pub struct AudioClock {
    position: Arc<AtomicU64>,
    sample_rate: u32,
    fps: i32,
}

impl AudioClock {
    pub fn new(position: Arc<AtomicU64>, sample_rate: u32, fps: i32) -> PlaybackResult<Self> {
        if sample_rate == 0 {
            return Err(PlaybackError::invalid("audio sample rate must be > 0"));
        }
        if fps <= 0 {
            return Err(PlaybackError::invalid("playback fps must be > 0"));
        }
        Ok(Self {
            position,
            sample_rate,
            fps,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn fps(&self) -> i32 {
        self.fps
    }

    /// Raw output-sample position shared with the cpal callback.
    pub fn sample_position(&self) -> u64 {
        self.position.load(Ordering::Acquire)
    }
}

impl Clock for AudioClock {
    fn frame(&self) -> i32 {
        frame_for_sample(self.sample_position(), self.sample_rate, self.fps)
    }

    fn reset(&self, frame: i32) {
        self.position.store(
            samples_for_frame(frame, self.sample_rate, self.fps),
            Ordering::Release,
        );
    }

    fn kind(&self) -> ClockKind {
        ClockKind::Audio
    }
}
