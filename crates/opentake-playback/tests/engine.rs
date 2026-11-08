use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use opentake_playback::{
    AudioClock, BoundedFrameQueue, CancelToken, Clock, ClockKind, ManualClock, PlaybackConfig,
    PlaybackEngine, PlaybackErrorKind, PlaybackIdentity, PlaybackState, QueuedFrame, RecordingSink,
    RgbaFrame, SyntheticSource, WallClock,
};

fn identity(session: &str) -> PlaybackIdentity {
    PlaybackIdentity::new(7, 3, session).expect("valid identity")
}

fn color_frame(value: u8) -> RgbaFrame {
    RgbaFrame::new(2, 2, vec![value; 2 * 2 * 4]).expect("valid frame")
}

fn harness(
    count: i32,
    capacity: usize,
    start: i32,
    end: i32,
    session: &str,
) -> (
    PlaybackEngine,
    Arc<ManualClock>,
    RecordingSink,
    Arc<std::sync::atomic::AtomicUsize>,
) {
    let clock = Arc::new(ManualClock::new(start));
    let source = SyntheticSource::new(count);
    let decode_calls = source.decode_calls();
    let sink = RecordingSink::new();
    let config = PlaybackConfig::new(30, start, end, capacity).expect("valid config");
    let engine = PlaybackEngine::new(
        identity(session),
        config,
        Box::new(source),
        clock.clone(),
        Box::new(sink.clone()),
    )
    .expect("engine");
    (engine, clock, sink, decode_calls)
}

#[test]
fn config_and_identity_validation() {
    assert!(PlaybackConfig::new(0, 0, 10, 2).is_err());
    assert!(PlaybackConfig::new(30, -1, 10, 2).is_err());
    assert!(PlaybackConfig::new(30, 5, 5, 2).is_err());
    assert!(PlaybackConfig::new(30, 0, 10, 0).is_err());
    assert_eq!(PlaybackConfig::new(30, 0, 10, 2).unwrap().end_frame, 10);

    assert!(PlaybackIdentity::new(1, 1, "").is_err());
    assert!(PlaybackIdentity::new(1, 1, "bad session").is_err());
    assert!(PlaybackIdentity::new(1, 1, "a".repeat(129)).is_err());
    let valid = PlaybackIdentity::new(9, 4, "route-b-session").unwrap();
    assert_eq!(valid.revision(), (9, 4));
    assert_eq!(valid.session_id(), "route-b-session");

    assert!(RgbaFrame::new(0, 2, vec![]).is_err());
    assert!(RgbaFrame::new(1, 1, vec![0; 3]).is_err());
    assert!(RgbaFrame::new(1, 1, vec![0; 4]).is_ok());
}

#[test]
fn queue_reports_capacity_and_backpressure() {
    let mut queue = BoundedFrameQueue::new(2).unwrap();
    assert_eq!(
        queue.push(QueuedFrame {
            generation: 1,
            frame: 0,
            image: color_frame(0)
        }),
        opentake_playback::PushOutcome::Pushed
    );
    assert_eq!(
        queue.push(QueuedFrame {
            generation: 1,
            frame: 1,
            image: color_frame(1)
        }),
        opentake_playback::PushOutcome::Pushed
    );
    assert!(queue.is_full());
    assert!(matches!(
        queue.push(QueuedFrame {
            generation: 1,
            frame: 2,
            image: color_frame(2)
        }),
        opentake_playback::PushOutcome::Full(_)
    ));
    assert!(BoundedFrameQueue::new(0).is_err());
}

#[test]
fn fill_is_bounded_by_capacity_and_end() {
    let (mut engine, _clock, _sink, decode_calls) = harness(10, 3, 0, 10, "fill");
    assert_eq!(engine.fill_to_capacity().unwrap(), 3);
    assert_eq!(engine.queue_len(), 3);
    assert_eq!(decode_calls.load(Ordering::Acquire), 3);
    assert_eq!(engine.fill_to_capacity().unwrap(), 0, "queue remains full");

    let (mut bounded_end, _clock, _sink, _calls) = harness(10, 8, 6, 10, "end");
    assert_eq!(bounded_end.fill_to_capacity().unwrap(), 4);
    assert_eq!(bounded_end.queue_len(), 4);
    assert_eq!(bounded_end.fill_to_capacity().unwrap(), 0);
}

#[test]
fn publishes_a_frame_per_clock_tick_in_cadence() {
    let (mut engine, clock, sink, _calls) = harness(30, 3, 0, 30, "cadence");
    for frame in 0..30 {
        clock.set_frame(frame);
        engine.fill_to_capacity().unwrap();
        let published = engine.tick().unwrap().expect("one publication");
        assert_eq!(published.frame, frame);
        assert_eq!(published.sequence, frame as u64 + 1);
        assert_eq!(published.identity, identity("cadence"));
        assert_eq!(published.generation, 1);
        assert_eq!(published.terminal, frame == 29);
    }
    assert_eq!(engine.state(), PlaybackState::Stopped);
    assert_eq!(engine.stats().published, 30);
    assert_eq!(engine.stats().decoded, 30);
    assert_eq!(engine.stats().dropped, 0);
    assert_eq!(sink.frames().len(), 30);
    assert!(engine.tick().unwrap().is_none(), "terminal tick is inert");
}

#[test]
fn duplicate_ticks_do_not_republish() {
    let (mut engine, clock, sink, _calls) = harness(5, 2, 0, 5, "dupes");
    clock.set_frame(0);
    engine.fill_to_capacity().unwrap();
    assert_eq!(engine.tick().unwrap().unwrap().frame, 0);
    assert!(engine.tick().unwrap().is_none());
    assert_eq!(sink.frames().len(), 1);
    clock.set_frame(1);
    assert_eq!(engine.tick().unwrap().unwrap().frame, 1);
}

#[test]
fn clock_jump_drops_stale_queue_entries() {
    let (mut engine, clock, sink, _calls) = harness(10, 4, 0, 10, "jump");
    engine.fill_to_capacity().unwrap();
    assert_eq!(engine.queue_len(), 4);
    clock.set_frame(3);
    let published = engine.tick().unwrap().unwrap();
    assert_eq!(published.frame, 3);
    assert!(engine.stats().dropped >= 3, "frames 0..=2 dropped");
    assert_eq!(engine.queue_len(), 0);
    assert_eq!(sink.frames().len(), 1);

    engine.fill_to_capacity().unwrap();
    clock.set_frame(7);
    assert_eq!(engine.tick().unwrap().unwrap().frame, 7);
    assert!(engine.stats().dropped >= 3);
}

#[test]
fn pause_freezes_publication_until_resume() {
    let (mut engine, clock, sink, _calls) = harness(10, 4, 0, 10, "pause");
    clock.set_frame(0);
    engine.fill_to_capacity().unwrap();
    engine.tick().unwrap().unwrap();
    let identity = identity("pause");
    engine.pause(&identity).unwrap();
    assert_eq!(engine.state(), PlaybackState::Paused);
    assert_eq!(
        clock.frame(),
        0,
        "pause rebases the clock at the published frame"
    );

    // The clock is frozen at the paused frame; decoding may continue but no
    // frame becomes observable until resume.
    engine.fill_to_capacity().unwrap();
    assert!(
        engine.tick().unwrap().is_none(),
        "no publication while paused"
    );
    assert_eq!(sink.frames().len(), 1);
    engine.pause(&identity).unwrap(); // idempotent

    engine.resume(&identity).unwrap();
    clock.set_frame(1);
    engine.fill_to_capacity().unwrap();
    let published = engine.tick().unwrap().unwrap();
    assert_eq!(published.frame, 1);
    assert_eq!(sink.frames().len(), 2);
}

#[test]
fn seek_flushes_queue_and_invalidates_generation() {
    let (mut engine, clock, sink, _calls) = harness(20, 4, 0, 20, "seek");
    clock.set_frame(0);
    engine.fill_to_capacity().unwrap();
    engine.tick().unwrap().unwrap();
    let identity = identity("seek");

    engine.seek(&identity, 10).unwrap();
    assert_eq!(engine.queue_len(), 0);
    assert_eq!(engine.generation(), 2);
    assert_eq!(clock.frame(), 10);
    assert_eq!(engine.last_published(), None);
    engine.fill_to_capacity().unwrap();
    let published = engine.tick().unwrap().unwrap();
    assert_eq!(published.frame, 10);
    assert_eq!(published.generation, 2);
    assert_eq!(published.sequence, 1);
    assert_eq!(sink.frames().len(), 2);

    // Backward seek also clears the queue and resets sequence.
    engine.seek(&identity, 2).unwrap();
    engine.fill_to_capacity().unwrap();
    let backward = engine.tick().unwrap().unwrap();
    assert_eq!(backward.frame, 2);
    assert_eq!(backward.generation, 3);
    assert_eq!(backward.sequence, 1);
    assert_eq!(engine.stats().seeks, 2);
}

#[test]
fn seek_is_preserved_while_paused() {
    let (mut engine, clock, sink, _calls) = harness(20, 3, 0, 20, "paused-seek");
    let identity = identity("paused-seek");
    clock.set_frame(0);
    engine.fill_to_capacity().unwrap();
    engine.tick().unwrap().unwrap();
    engine.pause(&identity).unwrap();
    engine.seek(&identity, 12).unwrap();
    assert_eq!(clock.frame(), 12);
    assert_eq!(engine.state(), PlaybackState::Paused);
    engine.fill_to_capacity().unwrap();
    assert!(engine.tick().unwrap().is_none());
    engine.resume(&identity).unwrap();
    engine.fill_to_capacity().unwrap();
    let published = engine.tick().unwrap().unwrap();
    assert_eq!(published.frame, 12);
    assert_eq!(sink.frames().len(), 2);
}

#[test]
fn stale_identity_is_rejected_and_current_state_remains() {
    let (mut engine, clock, _sink, _calls) = harness(10, 3, 0, 10, "session-a");
    let current = identity("session-a");
    let stale = identity("session-b");
    clock.set_frame(0);
    engine.fill_to_capacity().unwrap();
    engine.tick().unwrap().unwrap();

    for result in [
        engine.pause(&stale),
        engine.resume(&stale),
        engine.seek(&stale, 5),
        engine.stop(&stale),
    ] {
        let error = result.expect_err("stale identity rejected");
        assert_eq!(error.kind, PlaybackErrorKind::Superseded);
    }
    assert_eq!(engine.state(), PlaybackState::Playing);
    assert_eq!(engine.generation(), 1);

    engine.pause(&current).unwrap();
    assert_eq!(engine.state(), PlaybackState::Paused);
}

#[test]
fn stop_is_terminal_idempotent_and_cancels_fill() {
    let (mut engine, _clock, _sink, _calls) = harness(10, 3, 0, 10, "stop");
    let identity = identity("stop");
    engine.stop(&identity).unwrap();
    assert_eq!(engine.state(), PlaybackState::Stopped);
    engine.stop(&identity).unwrap(); // idempotent
    assert_eq!(engine.state(), PlaybackState::Stopped);
    assert_eq!(
        engine.fill(1).unwrap_err().kind,
        PlaybackErrorKind::Superseded
    );
    assert_eq!(
        engine.pause(&identity).unwrap_err().kind,
        PlaybackErrorKind::Superseded
    );
    assert_eq!(
        engine.resume(&identity).unwrap_err().kind,
        PlaybackErrorKind::Superseded
    );
    assert_eq!(
        engine.seek(&identity, 2).unwrap_err().kind,
        PlaybackErrorKind::Superseded
    );
    assert!(engine.tick().unwrap().is_none());
}

#[test]
fn terminal_publication_stops_the_session() {
    let (mut engine, clock, sink, _calls) = harness(3, 2, 0, 3, "terminal");
    for frame in 0..3 {
        clock.set_frame(frame);
        engine.fill_to_capacity().unwrap();
        let published = engine.tick().unwrap().unwrap();
        assert_eq!(published.terminal, frame == 2);
    }
    assert_eq!(engine.state(), PlaybackState::Stopped);
    assert!(sink.frames().last().unwrap().terminal);
    assert_eq!(sink.frames().len(), 3);
}

#[test]
fn seek_validation_and_decoder_errors() {
    let (mut engine, _clock, _sink, _calls) = harness(10, 3, 2, 8, "errors");
    let session_identity = identity("errors");
    assert_eq!(
        engine.seek(&session_identity, 1).unwrap_err().kind,
        PlaybackErrorKind::InvalidInput
    );
    assert_eq!(
        engine.seek(&session_identity, 8).unwrap_err().kind,
        PlaybackErrorKind::InvalidInput
    );

    let clock = Arc::new(ManualClock::new(0));
    let source = SyntheticSource::with_failure_at(10, 0);
    let config = PlaybackConfig::new(30, 0, 10, 2).unwrap();
    let mut broken = PlaybackEngine::new(
        identity("broken"),
        config,
        Box::new(source),
        clock,
        Box::new(RecordingSink::new()),
    )
    .unwrap();
    let error = broken.fill(1).expect_err("decode failure");
    assert_eq!(error.kind, PlaybackErrorKind::Engine);
    assert_eq!(broken.state(), PlaybackState::Playing);
    broken.stop(&identity("broken")).unwrap();
}

#[test]
fn audio_clock_maps_sample_position_to_frames() {
    let position = Arc::new(AtomicU64::new(0));
    let clock = AudioClock::new(position.clone(), 48_000, 30).unwrap();
    assert_eq!(clock.frame(), 0);
    position.store(1_600, Ordering::Release);
    assert_eq!(clock.frame(), 1);
    position.store(48_000, Ordering::Release);
    assert_eq!(clock.frame(), 30);
    assert_eq!(clock.kind(), ClockKind::Audio);

    clock.reset(12);
    assert_eq!(clock.sample_position(), 19_200);
    assert_eq!(clock.frame(), 12);
    assert!(AudioClock::new(Arc::new(AtomicU64::new(0)), 0, 30).is_err());
    assert!(AudioClock::new(Arc::new(AtomicU64::new(0)), 48_000, 0).is_err());
}

#[test]
fn manual_and_wall_clock_behavior() {
    let manual = ManualClock::new(4);
    assert_eq!(manual.frame(), 4);
    manual.set_frame(9);
    assert_eq!(manual.frame(), 9);
    manual.reset(2);
    assert_eq!(manual.frame(), 2);
    assert_eq!(manual.kind(), ClockKind::Manual);

    let wall = WallClock::new(5, 30).unwrap();
    assert!(wall.frame() >= 5);
    wall.reset(11);
    assert!(wall.frame() >= 11);
    assert_eq!(wall.kind(), ClockKind::Wall);
    assert!(WallClock::new(0, 0).is_err());
}

#[test]
fn cancel_token_is_shared_and_one_shot() {
    let token = CancelToken::new();
    let clone = token.clone();
    assert!(!token.is_cancelled());
    clone.cancel();
    assert!(token.is_cancelled());
}

#[test]
fn step_decodes_and_publishes() {
    let (mut engine, clock, _sink, calls) = harness(10, 2, 0, 10, "step");
    clock.set_frame(0);
    let published = engine.step(1).unwrap().unwrap();
    assert_eq!(published.frame, 0);
    assert_eq!(calls.load(Ordering::Acquire), 1);
    clock.set_frame(1);
    let next = engine.step(1).unwrap().unwrap();
    assert_eq!(next.frame, 1);
    assert_eq!(next.sequence, 2);
}
