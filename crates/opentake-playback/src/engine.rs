//! Identity-guarded streaming playback state machine.
//!
//! The engine is deliberately single-threaded and deterministic: the caller
//! drives a loop of `fill` (decode ahead into the bounded queue) and `tick`
//! (publish the newest frame at/before the clock target). The production addon
//! runs that loop on a decoder/render thread and calls `tick` from the audio
//! callback or a paced ticker; the identity and publication rules are identical.
//!
//! Lifecycle:
//!
//! ```text
//!            new()
//!              │
//!          ┌───▼───┐  pause(identity)   ┌────────┐
//!          │Playing│ ─────────────────►│ Paused │
//!          └───┬───┘ ◄───────────────── └────┬───┘
//!              │        resume(identity)     │
//!              │ terminal frame published    │ stop/seek(identity)
//!              ▼                             ▼
//!           ┌──────────────────────────────────┐
//!           │ Stopped (cancelled/terminal)     │
//!           └──────────────────────────────────┘
//! ```
//!
//! `seek` is valid while Playing or Paused; it bumps the generation, resets the
//! publication sequence and flushes the queue so stale frames can never publish.
//! Every control call carries a [`PlaybackIdentity`]; a mismatched session is
//! rejected as `Superseded`.

use std::sync::Arc;

use crate::cancel::CancelToken;
use crate::clock::Clock;
use crate::error::{PlaybackError, PlaybackResult};
use crate::frame::{FrameSink, FrameSource, PublishedFrame};
use crate::identity::PlaybackIdentity;
use crate::queue::{BoundedFrameQueue, PushOutcome, QueuedFrame};

/// Playback transport state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackState {
    Playing,
    Paused,
    Stopped,
}

/// Immutable session configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackConfig {
    pub fps: i32,
    /// Frames to decode ahead of the publication tick.
    pub queue_capacity: usize,
    /// First frame of the session range (inclusive).
    pub start_frame: i32,
    /// End of the session range (exclusive). Clamped to the source frame count.
    pub end_frame: i32,
}

impl PlaybackConfig {
    pub fn new(
        fps: i32,
        start_frame: i32,
        end_frame: i32,
        queue_capacity: usize,
    ) -> PlaybackResult<Self> {
        if fps <= 0 {
            return Err(PlaybackError::invalid("playback fps must be > 0"));
        }
        if start_frame < 0 {
            return Err(PlaybackError::invalid("startFrame must be >= 0"));
        }
        if end_frame <= start_frame {
            return Err(PlaybackError::invalid("endFrame must be > startFrame"));
        }
        if queue_capacity == 0 {
            return Err(PlaybackError::invalid("decode queue capacity must be > 0"));
        }
        Ok(Self {
            fps,
            queue_capacity,
            start_frame,
            end_frame,
        })
    }
}

/// Counters useful for probes/status endpoints.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlaybackStats {
    pub decoded: u64,
    pub published: u64,
    pub dropped: u64,
    pub queue_peak: usize,
    pub seeks: u64,
}

/// The playback core.
pub struct PlaybackEngine {
    identity: PlaybackIdentity,
    config: PlaybackConfig,
    source: Box<dyn FrameSource>,
    clock: Arc<dyn Clock>,
    sink: Box<dyn FrameSink>,
    queue: BoundedFrameQueue,
    state: PlaybackState,
    generation: u64,
    sequence: u64,
    decode_cursor: i32,
    last_published: Option<i32>,
    cancel: CancelToken,
    stats: PlaybackStats,
}

impl PlaybackEngine {
    /// Construct an engine at `config.start_frame`; playback is immediately
    /// playing (the caller may `pause` before making it observable).
    pub fn new(
        identity: PlaybackIdentity,
        config: PlaybackConfig,
        source: Box<dyn FrameSource>,
        clock: Arc<dyn Clock>,
        sink: Box<dyn FrameSink>,
    ) -> PlaybackResult<Self> {
        let frame_count = source.frame_count();
        if frame_count <= 0 {
            return Err(PlaybackError::invalid("frame source reports no frames"));
        }
        if config.start_frame >= frame_count {
            return Err(PlaybackError::invalid(format!(
                "startFrame {} is outside the source's {frame_count} frames",
                config.start_frame
            )));
        }
        let mut config = config;
        config.end_frame = config.end_frame.min(frame_count);
        if config.end_frame <= config.start_frame {
            return Err(PlaybackError::invalid(
                "playback range is empty after clamping to the source",
            ));
        }

        clock.reset(config.start_frame);
        let start_frame = config.start_frame;
        Ok(Self {
            identity,
            queue: BoundedFrameQueue::new(config.queue_capacity)?,
            config,
            source,
            clock,
            sink,
            state: PlaybackState::Playing,
            generation: 1,
            sequence: 0,
            decode_cursor: start_frame,
            last_published: None,
            cancel: CancelToken::new(),
            stats: PlaybackStats::default(),
        })
    }

    pub fn identity(&self) -> &PlaybackIdentity {
        &self.identity
    }

    pub fn config(&self) -> &PlaybackConfig {
        &self.config
    }

    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }

    pub fn state(&self) -> PlaybackState {
        self.state
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }

    pub fn queue_capacity(&self) -> usize {
        self.queue.capacity()
    }

    pub fn last_published(&self) -> Option<i32> {
        self.last_published
    }

    pub fn stats(&self) -> PlaybackStats {
        self.stats
    }

    /// Decode up to `max_steps` frames ahead, stopping early at queue capacity or
    /// end-of-range. Returns the number of frames decoded by this call.
    pub fn fill(&mut self, max_steps: usize) -> PlaybackResult<usize> {
        if self.state == PlaybackState::Stopped {
            return Err(PlaybackError::superseded("playback session is stopped"));
        }
        if self.cancel.is_cancelled() {
            return Err(PlaybackError::cancelled("playback session was cancelled"));
        }

        let mut decoded = 0usize;
        while decoded < max_steps && self.decode_cursor < self.config.end_frame {
            if self.queue.is_full() {
                break;
            }
            if self.cancel.is_cancelled() {
                return Err(PlaybackError::cancelled("playback session was cancelled"));
            }
            let image = self.source.decode(self.decode_cursor, &self.cancel)?;
            let generation = self.generation;
            let queued = QueuedFrame {
                generation,
                frame: self.decode_cursor,
                image,
            };
            match self.queue.push(queued) {
                PushOutcome::Pushed => {
                    decoded += 1;
                    self.decode_cursor += 1;
                    self.stats.decoded += 1;
                    self.stats.queue_peak = self.stats.queue_peak.max(self.queue.len());
                }
                PushOutcome::Full(_) => break,
            }
        }
        Ok(decoded)
    }

    /// Fill the queue to capacity.
    pub fn fill_to_capacity(&mut self) -> PlaybackResult<usize> {
        self.fill(usize::MAX)
    }

    /// Publish the newest queued frame at or before the clock target. Returns
    /// `None` when paused/stopped, starving, or already at the target frame.
    ///
    /// A terminal publication flips the engine to `Stopped`; subsequent ticks
    /// return `None`.
    pub fn tick(&mut self) -> PlaybackResult<Option<PublishedFrame>> {
        if self.state != PlaybackState::Playing {
            return Ok(None);
        }

        let target = self
            .clock
            .frame()
            .clamp(self.config.start_frame, self.config.end_frame - 1);
        if let Some(last) = self.last_published {
            if target <= last {
                return Ok(None);
            }
        }

        let (latest, dropped) = self.queue.take_latest_at_or_before(target, self.generation);
        self.stats.dropped += dropped as u64;
        self.stats.queue_peak = self.stats.queue_peak.max(self.queue.len());
        let Some(frame) = latest else {
            return Ok(None);
        };

        if self.last_published.is_some_and(|last| frame.frame <= last) {
            return Ok(None);
        }

        self.sequence += 1;
        let terminal = frame.frame >= self.config.end_frame - 1;
        let published = PublishedFrame {
            identity: self.identity.clone(),
            generation: self.generation,
            sequence: self.sequence,
            frame: frame.frame,
            terminal,
            image: frame.image,
        };
        self.sink.publish(&published);
        self.last_published = Some(published.frame);
        self.stats.published += 1;

        if terminal {
            self.state = PlaybackState::Stopped;
            self.queue.clear();
        }
        Ok(Some(published))
    }

    /// Decode up to `decode_budget` frames and then attempt one publication.
    pub fn step(&mut self, decode_budget: usize) -> PlaybackResult<Option<PublishedFrame>> {
        if self.state == PlaybackState::Stopped {
            return Ok(None);
        }
        self.fill(decode_budget)?;
        self.tick()
    }

    /// Freeze publication and rebase the clock at the last published frame.
    /// Idempotent while paused; rejected after stop or on a stale identity.
    pub fn pause(&mut self, identity: &PlaybackIdentity) -> PlaybackResult<()> {
        self.verify_active(identity)?;
        if self.state == PlaybackState::Paused {
            return Ok(());
        }
        let freeze = self.last_published.unwrap_or_else(|| {
            self.clock
                .frame()
                .clamp(self.config.start_frame, self.config.end_frame - 1)
        });
        self.clock.reset(freeze);
        self.state = PlaybackState::Paused;
        Ok(())
    }

    /// Reopen publication. Idempotent while playing; rejected after stop.
    pub fn resume(&mut self, identity: &PlaybackIdentity) -> PlaybackResult<()> {
        self.verify_active(identity)?;
        if self.state == PlaybackState::Playing {
            return Ok(());
        }
        self.state = PlaybackState::Playing;
        Ok(())
    }

    /// Jump to `frame`, flush the decode queue and invalidate the previous
    /// generation/sequence. Play/pause state is preserved.
    pub fn seek(&mut self, identity: &PlaybackIdentity, frame: i32) -> PlaybackResult<()> {
        self.verify_active(identity)?;
        if frame < self.config.start_frame || frame >= self.config.end_frame {
            return Err(PlaybackError::invalid(format!(
                "seek frame {frame} is outside {}..{}",
                self.config.start_frame, self.config.end_frame
            )));
        }
        self.queue.clear();
        self.generation += 1;
        self.sequence = 0;
        self.decode_cursor = frame;
        self.last_published = None;
        self.clock.reset(frame);
        self.stats.seeks += 1;
        Ok(())
    }

    /// Stop the session (idempotent for the same identity). Cancels outstanding
    /// decode work and discards queued/pub pending frames.
    pub fn stop(&mut self, identity: &PlaybackIdentity) -> PlaybackResult<()> {
        if identity != &self.identity {
            return Err(PlaybackError::superseded(
                "playback control belongs to a stale session identity",
            ));
        }
        if self.state != PlaybackState::Stopped {
            self.state = PlaybackState::Stopped;
            self.cancel.cancel();
            self.queue.clear();
            self.generation += 1;
        }
        Ok(())
    }

    /// Teardown without an identity (engine drop/route cleanup).
    pub fn cancel(&mut self) {
        if self.state != PlaybackState::Stopped {
            self.state = PlaybackState::Stopped;
            self.generation += 1;
        }
        self.cancel.cancel();
        self.queue.clear();
    }

    fn verify_active(&self, identity: &PlaybackIdentity) -> PlaybackResult<()> {
        if identity != &self.identity {
            return Err(PlaybackError::superseded(
                "playback control belongs to a stale session identity",
            ));
        }
        if self.state == PlaybackState::Stopped {
            return Err(PlaybackError::superseded("playback session is stopped"));
        }
        Ok(())
    }
}
