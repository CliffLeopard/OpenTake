//! Deterministic cadence demo: manual clock, bounded queue, no hardware.
//!
//! Usage: cadence_demo [frames] [queue-capacity] [fps]
//! Exit code 0 only when every expected frame is published exactly once,
//! in order, with a terminal frame at the end.

use std::env;
use std::sync::Arc;

use opentake_playback::{
    ManualClock, PlaybackConfig, PlaybackEngine, PlaybackIdentity, PlaybackState, RecordingSink,
    SyntheticSource,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let frames: i32 = args
        .next()
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(300);
    let capacity: usize = args
        .next()
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(8);
    let fps: i32 = args
        .next()
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(30);

    let clock = Arc::new(ManualClock::new(0));
    let source = SyntheticSource::new(frames);
    let decode_calls = source.decode_calls();
    let sink = RecordingSink::new();
    let identity = PlaybackIdentity::new(1, 1, "cadence-demo")?;
    let config = PlaybackConfig::new(fps, 0, frames, capacity)?;
    let mut engine = PlaybackEngine::new(
        identity,
        config,
        Box::new(source),
        clock.clone(),
        Box::new(sink.clone()),
    )?;

    for frame in 0..frames {
        clock.set_frame(frame);
        engine.fill_to_capacity()?;
        let published = engine
            .tick()?
            .unwrap_or_else(|| panic!("no frame published for target {frame}"));
        if published.frame != frame || published.sequence != frame as u64 + 1 {
            return Err(format!(
                "cadence mismatch at target {frame}: published frame {} sequence {}",
                published.frame, published.sequence
            )
            .into());
        }
        if frame < 5 || frame == frames - 1 {
            println!(
                "frame={:>4} seq={:>4} terminal={} queue={} decoded={} dropped={}",
                published.frame,
                published.sequence,
                published.terminal,
                engine.queue_len(),
                engine.stats().decoded,
                engine.stats().dropped
            );
        }
    }

    let stats = engine.stats();
    println!(
        "summary: frames={frames} published={} decoded={} dropped={} queue_peak={} seeks={} \
         decode_calls={} state={:?}",
        stats.published,
        stats.decoded,
        stats.dropped,
        stats.queue_peak,
        stats.seeks,
        decode_calls.load(std::sync::atomic::Ordering::Acquire),
        engine.state()
    );
    if engine.state() != PlaybackState::Stopped {
        return Err("engine did not stop after the terminal frame".into());
    }
    if sink.frames().len() != frames as usize {
        return Err("published count does not match frame count".into());
    }
    println!("cadence: OK");
    Ok(())
}
