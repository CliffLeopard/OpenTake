//! OpenTake Route B — isolated streaming playback slice.
//!
//! This crate is a deliberately standalone extraction of the playback core the
//! Route B N-API addon needs, without pulling GPU/ffmpeg/cpal into the existing
//! workspace crates. It owns:
//!
//! - [`identity::PlaybackIdentity`] / session guards (`projectEpoch`,
//!   `timelineVersion`, `sessionId`);
//! - a bounded forward decode queue ([`queue::BoundedFrameQueue`]) with
//!   decode-ahead backpressure and stale-frame dropping;
//! - a clock abstraction ([`clock::Clock`]) with a cpal sample-position master
//!   clock ([`clock::AudioClock`]), a wall clock, and a manual test clock;
//! - an identity-guarded state machine ([`engine::PlaybackEngine`]) with
//!   fill/tick publication, pause/resume, seek (generation invalidation), stop
//!   and cancellation;
//! - the [`frame::FrameSource`] / [`frame::FrameSink`] adapters that the addon
//!   will bind to `opentake-media` decode + Host JPEG/PNG publication.
//!
//! The deterministic core is single-threaded and fully testable. Threading and
//! transport belong to the addon/Host adapters; see
//! `docs/architecture/route-b-playback.md` for the lifecycle, error model,
//! threading rules and exact integration points.
//!
//! The crate is intentionally **not** a member of the shared workspace: it has
//! its own empty `[workspace]` so building/testing it does not require editing
//! the root `Cargo.toml` until the integration is reviewed.

pub mod cancel;
pub mod clock;
pub mod engine;
pub mod error;
pub mod frame;
pub mod identity;
pub mod queue;
pub mod synthetic;

#[cfg(feature = "cpal-output")]
pub mod cpal_output;

pub use cancel::CancelToken;
pub use clock::{AudioClock, Clock, ClockKind, ManualClock, WallClock};
pub use engine::{PlaybackConfig, PlaybackEngine, PlaybackState, PlaybackStats};
pub use error::{PlaybackError, PlaybackErrorKind, PlaybackResult};
pub use frame::{FrameSink, FrameSource, PublishedFrame, RgbaFrame};
pub use identity::PlaybackIdentity;
pub use queue::{BoundedFrameQueue, PushOutcome, QueuedFrame};
pub use synthetic::{RecordingSink, SyntheticSource};
