//! Optional cpal silent output that drives [`crate::clock::AudioClock`].
//!
//! This is the audio master-clock half of the slice. It opens the default output
//! device, writes silence, and increments an atomic frame counter every audio
//! callback. The production engine will fill the callback with mixed timeline
//! audio instead of silence; the clock contract is unchanged.
//!
//! The cpal `Stream` is `!Send` on macOS, so [`CpalOutput`] must stay on the
//! thread that opened it (the addon's audio thread). The cloneable
//! [`AudioClock`] may be moved into the render/decoder thread.
//!
//! Hardware output is *not* required to test the playback core: the default
//! crate tests use [`crate::clock::ManualClock`] / [`crate::AudioClock`] with a
//! simulated sample counter. The ignored `cpal_output` test is the only place
//! that touches a real device; it is reported as unverified in
//! `docs/architecture/route-b-playback.md` unless it is run on hardware.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::clock::AudioClock;
use crate::error::{PlaybackError, PlaybackResult};

/// Owns the cpal output stream and its master clock.
pub struct CpalOutput {
    stream: cpal::Stream,
    clock: Arc<AudioClock>,
}

impl CpalOutput {
    /// Open the default output device at its default config and start playing
    /// silence. `fps` is the project fps used by the audio clock.
    pub fn start(fps: i32) -> PlaybackResult<Self> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| PlaybackError::engine("no default audio output device"))?;
        let supported = device
            .default_output_config()
            .map_err(|error| PlaybackError::engine(format!("default output config: {error}")))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = config.channels as usize;
        if channels == 0 {
            return Err(PlaybackError::engine("audio output has zero channels"));
        }
        let sample_rate = config.sample_rate.0;
        let position = Arc::new(AtomicU64::new(0));
        let clock = Arc::new(AudioClock::new(Arc::clone(&position), sample_rate, fps)?);

        let error_callback = |error| eprintln!("[opentake-playback] cpal stream error: {error}");
        let stream = match sample_format {
            cpal::SampleFormat::F32 => {
                let position = Arc::clone(&position);
                device
                    .build_output_stream(
                        &config,
                        move |data: &mut [f32], _| {
                            position.fetch_add((data.len() / channels) as u64, Ordering::AcqRel);
                            data.fill(0.0);
                        },
                        error_callback,
                        None,
                    )
                    .map_err(|error| PlaybackError::engine(format!("build f32 output: {error}")))?
            }
            cpal::SampleFormat::I16 => {
                let position = Arc::clone(&position);
                device
                    .build_output_stream(
                        &config,
                        move |data: &mut [i16], _| {
                            position.fetch_add((data.len() / channels) as u64, Ordering::AcqRel);
                            data.fill(0);
                        },
                        error_callback,
                        None,
                    )
                    .map_err(|error| PlaybackError::engine(format!("build i16 output: {error}")))?
            }
            cpal::SampleFormat::U16 => {
                let position = Arc::clone(&position);
                device
                    .build_output_stream(
                        &config,
                        move |data: &mut [u16], _| {
                            position.fetch_add((data.len() / channels) as u64, Ordering::AcqRel);
                            data.fill(u16::MAX / 2);
                        },
                        error_callback,
                        None,
                    )
                    .map_err(|error| PlaybackError::engine(format!("build u16 output: {error}")))?
            }
            other => {
                return Err(PlaybackError::engine(format!(
                    "unsupported default audio sample format: {other:?}"
                )))
            }
        };

        stream
            .play()
            .map_err(|error| PlaybackError::engine(format!("start cpal output: {error}")))?;
        Ok(Self { stream, clock })
    }

    pub fn clock(&self) -> Arc<AudioClock> {
        Arc::clone(&self.clock)
    }
}

impl Drop for CpalOutput {
    fn drop(&mut self) {
        let _ = self.stream.pause();
    }
}

/// Whether a default output device is visible (does not open/play it).
pub fn default_output_available() -> bool {
    cpal::default_host().default_output_device().is_some()
}
