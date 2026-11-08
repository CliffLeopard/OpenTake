//! Wall-clock streaming demo: ~real-time decode/tick loop, no hardware/GPU.
//!
//! Usage: streaming_demo [frames] [seconds]
//! Verifies wall-clock cadence, queue bounding and terminal publication. Frame
//! timings are printed for the probe script; exact wall-clock accuracy is not
//! asserted because this is a synthetic producer.

use std::env;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use opentake_playback::{
    PlaybackConfig, PlaybackEngine, PlaybackIdentity, PlaybackState, RecordingSink,
    SyntheticSource, WallClock,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let frames: i32 = args
        .next()
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(60);
    let fps: i32 = 30;
    let clock = Arc::new(WallClock::new(0, fps)?);
    let sink = RecordingSink::new();
    let mut engine = PlaybackEngine::new(
        PlaybackIdentity::new(1, 1, "streaming-demo")?,
        PlaybackConfig::new(fps, 0, frames, 4)?,
        Box::new(SyntheticSource::new(frames)),
        clock,
        Box::new(sink.clone()),
    )?;

    let started = Instant::now();
    let mut last = None;
    while engine.state() != PlaybackState::Stopped {
        engine.fill_to_capacity()?;
        if let Some(published) = engine.tick()? {
            if published.frame < 3 || published.terminal {
                println!(
                    "t={:>6.3}s frame={:>4} seq={:>4} terminal={} queue={}",
                    started.elapsed().as_secs_f64(),
                    published.frame,
                    published.sequence,
                    published.terminal,
                    engine.queue_len()
                );
            }
            last = Some(published);
        }
        if started.elapsed() > Duration::from_secs((frames as u64 / fps as u64).max(1) + 5) {
            return Err("streaming demo timed out".into());
        }
        thread::sleep(Duration::from_millis(2));
    }
    let last = last.ok_or("no frame published")?;
    println!(
        "summary: elapsed={:.3}s frames={} published={} decoded={} dropped={} terminal_frame={}",
        started.elapsed().as_secs_f64(),
        frames,
        engine.stats().published,
        engine.stats().decoded,
        engine.stats().dropped,
        last.frame
    );
    if engine.stats().published != frames as u64 || !last.terminal {
        return Err("streaming cadence incomplete".into());
    }
    println!("streaming: OK");
    Ok(())
}
