//! cpal hardware probe. Compiled only with `--features cpal-output`.
//!
//! The ignored test is the only test that opens a real audio device; it is not
//! part of the default gate because CI/hardware may have no output device. The
//! non-ignored test only reports visibility and never fails on a headless box.

#![cfg(feature = "cpal-output")]

use std::thread;
use std::time::Duration;

use opentake_playback::cpal_output::{default_output_available, CpalOutput};

#[test]
fn reports_default_output_visibility_without_failing_headless() {
    let available = default_output_available();
    eprintln!("cpal default output device available: {available}");
}

#[test]
#[ignore = "requires a real audio output device; run explicitly on macOS arm64"]
fn cpal_output_advances_the_audio_clock() {
    if !default_output_available() {
        eprintln!("no default audio output device; skipping hardware audio probe");
        return;
    }
    let output = match CpalOutput::start(30) {
        Ok(output) => output,
        Err(error) => {
            eprintln!("cpal output could not start ({error}); skipping hardware audio probe");
            return;
        }
    };
    let clock = output.clock();
    let before = clock.sample_position();
    thread::sleep(Duration::from_millis(200));
    let after = clock.sample_position();
    eprintln!(
        "cpal clock advanced {before} -> {after} samples at {} Hz",
        clock.sample_rate()
    );
    assert!(
        after > before,
        "audio callback did not advance the master clock (device suspended?)"
    );
}
