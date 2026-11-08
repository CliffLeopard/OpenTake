//! Bounded forward decode queue.
//!
//! The queue holds decoded frames ahead of the clock, in display order. `fill`
//! stops at capacity (backpressure, never unbounded growth), and publication
//! takes the newest frame at or before the clock target while dropping the rest.

use std::collections::VecDeque;

use crate::error::{PlaybackError, PlaybackResult};
use crate::frame::RgbaFrame;

/// One queued decoded frame tagged with the session generation that decoded it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueuedFrame {
    pub generation: u64,
    pub frame: i32,
    pub image: RgbaFrame,
}

/// Result of [`BoundedFrameQueue::push`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushOutcome {
    Pushed,
    /// Queue is at capacity; the frame is returned so the caller can retry after
    /// the publication side drains it.
    Full(QueuedFrame),
}

/// FIFO queue with a hard capacity.
#[derive(Debug)]
pub struct BoundedFrameQueue {
    capacity: usize,
    items: VecDeque<QueuedFrame>,
}

impl BoundedFrameQueue {
    pub fn new(capacity: usize) -> PlaybackResult<Self> {
        if capacity == 0 {
            return Err(PlaybackError::invalid("decode queue capacity must be > 0"));
        }
        Ok(Self {
            capacity,
            items: VecDeque::with_capacity(capacity),
        })
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn is_full(&self) -> bool {
        self.items.len() >= self.capacity
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn push(&mut self, frame: QueuedFrame) -> PushOutcome {
        if self.is_full() {
            return PushOutcome::Full(frame);
        }
        self.items.push_back(frame);
        PushOutcome::Pushed
    }

    /// Take the newest queued frame at or before `target` for the current
    /// `generation`. Older/superseded frames in front of it are removed; frames
    /// after `target` remain queued for a later tick.
    ///
    /// Returns `(latest, dropped)` where `dropped` counts removed frames,
    /// including stale-generation frames.
    pub(crate) fn take_latest_at_or_before(
        &mut self,
        target: i32,
        generation: u64,
    ) -> (Option<QueuedFrame>, usize) {
        let mut latest: Option<QueuedFrame> = None;
        let mut dropped = 0usize;
        while let Some(front) = self.items.front() {
            if front.generation != generation {
                self.items.pop_front();
                dropped += 1;
                continue;
            }
            if front.frame > target {
                break;
            }
            let item = self.items.pop_front().expect("front exists");
            if latest.is_some() {
                dropped += 1;
            }
            latest = Some(item);
        }
        (latest, dropped)
    }
}
