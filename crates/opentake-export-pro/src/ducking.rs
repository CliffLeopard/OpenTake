//! Audio ducking: role/sidechain contract plus a per-sample ducking envelope.
//!
//! ## Contract
//!
//! The domain model has no role or ducking fields today (`Track` has only
//! `muted`/`hidden`/`syncLocked`; `Clip` has `volume`, fades and
//! `volumeTrack`). This module prototypes the minimum contract the export mix
//! needs:
//!
//! - every audio layer declares an [`AudioRole`] (`voice`/`music`/`sfx`/`other`);
//! - voice layers form the **sidechain trigger**;
//! - non-voice layers get an automatic gain envelope derived from the voice
//!   activity (`threshold`, `depth`, `attack`, `release`, `hold`);
//! - explicit per-sample base gains (clip volume/fades) are multiplied by the
//!   ducking gain, so ducking composes with existing fades.
//!
//! This mirrors `opentake_media::encode::mix::ClipAudio` (same mono f32 /
//! `start_sample` / per-sample `gains` shape) but is crate-local so the
//! prototype can land without touching the shared mixer. The promotion path is
//! to compute [`ducking_gains`] and fold it into `ClipAudio.gains` before
//! `opentake_media::mix_clips`.

use serde::{Deserialize, Serialize};

use crate::{ExportProError, Result};

/// Canonical mix sample rate, matching `opentake_media::encode::MIX_SAMPLE_RATE`.
pub const MIX_SAMPLE_RATE: u32 = 48_000;

/// Role of one audio layer in the mix.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioRole {
    /// Dialogue/voice: triggers ducking on other roles.
    Voice,
    /// Music bed: ducked under voice.
    Music,
    /// Sound effects: ducked under voice, usually less aggressively.
    Sfx,
    /// Anything else; ducked like music.
    Other,
}

impl AudioRole {
    pub fn is_voice(self) -> bool {
        self == AudioRole::Voice
    }
}

/// Ducking parameters. `depth_db` is the reduction applied while voice is
/// present; `threshold_db` is the voice gate (peak amplitude in dBFS).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckingConfig {
    pub threshold_db: f32,
    pub depth_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub hold_ms: f32,
    pub sample_rate: u32,
}

impl Default for DuckingConfig {
    fn default() -> Self {
        DuckingConfig {
            threshold_db: -38.0,
            depth_db: 12.0,
            attack_ms: 80.0,
            release_ms: 400.0,
            hold_ms: 200.0,
            sample_rate: MIX_SAMPLE_RATE,
        }
    }
}

impl DuckingConfig {
    pub fn validate(&self) -> Result<()> {
        if !(-96.0..=0.0).contains(&self.threshold_db) || !self.threshold_db.is_finite() {
            return Err(ExportProError::InvalidSpec(
                "ducking threshold_db must be within [-96, 0]".into(),
            ));
        }
        if !(1.0..=60.0).contains(&self.depth_db) || !self.depth_db.is_finite() {
            return Err(ExportProError::InvalidSpec(
                "ducking depth_db must be within [1, 60]".into(),
            ));
        }
        if !(1.0..=5_000.0).contains(&self.attack_ms) || !self.attack_ms.is_finite() {
            return Err(ExportProError::InvalidSpec(
                "ducking attack_ms must be within [1, 5000]".into(),
            ));
        }
        if !(1.0..=10_000.0).contains(&self.release_ms) || !self.release_ms.is_finite() {
            return Err(ExportProError::InvalidSpec(
                "ducking release_ms must be within [1, 10000]".into(),
            ));
        }
        if !(0.0..=5_000.0).contains(&self.hold_ms) || !self.hold_ms.is_finite() {
            return Err(ExportProError::InvalidSpec(
                "ducking hold_ms must be within [0, 5000]".into(),
            ));
        }
        if !(8_000..=192_000).contains(&self.sample_rate) {
            return Err(ExportProError::InvalidSpec(
                "ducking sample_rate must be within [8000, 192000]".into(),
            ));
        }
        Ok(())
    }

    fn threshold_linear(&self) -> f32 {
        10.0_f32.powf(self.threshold_db / 20.0)
    }

    fn depth_linear(&self) -> f32 {
        10.0_f32.powf(-self.depth_db / 20.0)
    }

    fn attack_coefficient(&self) -> f32 {
        let samples = (self.attack_ms / 1_000.0 * self.sample_rate as f32).max(1.0);
        1.0 - (-1.0 / samples).exp()
    }

    fn release_coefficient(&self) -> f32 {
        let samples = (self.release_ms / 1_000.0 * self.sample_rate as f32).max(1.0);
        1.0 - (-1.0 / samples).exp()
    }

    fn hold_samples(&self) -> usize {
        (self.hold_ms / 1_000.0 * self.sample_rate as f32).round() as usize
    }
}

/// One audio layer placed on the timeline, mirroring the shared mixer's
/// `ClipAudio` plus the role the sidechain contract needs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLayer {
    pub start_sample: usize,
    pub samples: Vec<f32>,
    /// Empty = unity; otherwise must match `samples.len()`.
    pub base_gains: Vec<f32>,
    pub role: AudioRole,
}

impl AudioLayer {
    pub fn new(start_sample: usize, samples: Vec<f32>, role: AudioRole) -> Self {
        AudioLayer {
            start_sample,
            samples,
            base_gains: Vec::new(),
            role,
        }
    }

    pub fn with_base_gain(mut self, gain: f32) -> Self {
        self.base_gains = vec![gain; self.samples.len()];
        self
    }

    pub fn end_sample(&self) -> usize {
        self.start_sample + self.samples.len()
    }

    fn base_gain(&self, index: usize) -> f32 {
        if self.base_gains.is_empty() {
            1.0
        } else {
            self.base_gains[index]
        }
    }
}

/// One measurement window for the report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GainWindow {
    pub start_sample: usize,
    pub end_sample: usize,
    /// Mean ducking gain in dB over the window (0 = no ducking).
    pub mean_gain_db: f32,
}

/// Serializable ducking evidence, written next to the rendered WAVs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckingReport {
    pub config: DuckingConfig,
    pub ducking_enabled: bool,
    /// Inclusive start / exclusive end sample of each open voice gate.
    pub voice_ranges: Vec<[usize; 2]>,
    /// Minimum gain in dB across the timeline (0 when nothing was ducked).
    pub peak_gain_db: f32,
    /// Requested reduction in dB (positive number).
    pub requested_depth_db: f32,
    pub windows: Vec<GainWindow>,
}

/// Validate layer shapes and compute the total mix length.
fn validate_layers(layers: &[AudioLayer]) -> Result<usize> {
    let mut total = 0usize;
    for (index, layer) in layers.iter().enumerate() {
        if !layer.base_gains.is_empty() && layer.base_gains.len() != layer.samples.len() {
            return Err(ExportProError::InvalidSpec(format!(
                "layer {index}: base_gains len {} != samples len {}",
                layer.base_gains.len(),
                layer.samples.len()
            )));
        }
        if layer.start_sample.checked_add(layer.samples.len()).is_none() {
            return Err(ExportProError::InvalidSpec(format!(
                "layer {index}: start_sample + sample count overflows"
            )));
        }
        total = total.max(layer.end_sample());
    }
    Ok(total)
}

/// Peak-follower voice envelope, one sample per output sample: the maximum
/// post-base-gain absolute amplitude of every voice layer active at that sample.
///
/// A raw `|sine|` envelope crosses zero every half cycle, which would chatter
/// the gate at 440 Hz. The detector therefore applies an instant attack and a
/// 10 ms peak-hold decay after taking the per-sample maximum; the gate then
/// follows speech-like activity rather than individual waveform cycles.
fn voice_envelope(layers: &[AudioLayer], total_samples: usize, sample_rate: u32) -> Vec<f32> {
    let mut raw = vec![0.0f32; total_samples];
    for layer in layers.iter().filter(|layer| layer.role.is_voice()) {
        for (index, sample) in layer.samples.iter().enumerate() {
            let position = layer.start_sample + index;
            if position >= total_samples {
                break;
            }
            let amplitude = (sample * layer.base_gain(index)).abs();
            if amplitude > raw[position] {
                raw[position] = amplitude;
            }
        }
    }
    let decay_samples = (0.010 * sample_rate as f32).max(1.0);
    let decay = (-1.0f32 / decay_samples).exp();
    let mut envelope = vec![0.0f32; total_samples];
    let mut held = 0.0f32;
    for (index, amplitude) in raw.iter().enumerate() {
        held = (*amplitude).max(held * decay);
        envelope[index] = held;
    }
    envelope
}

/// Compute the per-sample ducking gain (linear) applied to non-voice layers,
/// plus the open voice-gate ranges.
///
/// The gate opens when the voice envelope crosses `threshold_db`; the ducking
/// amount then follows a one-pole attack toward full depth, holds for
/// `hold_ms` after the gate closes, and releases back to unity.
pub fn ducking_gains(layers: &[AudioLayer], config: &DuckingConfig) -> Result<(Vec<f32>, Vec<[usize; 2]>)> {
    config.validate()?;
    let total = validate_layers(layers)?;
    if total == 0 {
        return Ok((Vec::new(), Vec::new()));
    }
    let envelope = voice_envelope(layers, total, config.sample_rate);
    let threshold = config.threshold_linear();
    let attack = config.attack_coefficient();
    let release = config.release_coefficient();
    let depth = config.depth_linear();
    let hold_samples = config.hold_samples();

    let mut gains = vec![1.0f32; total];
    let mut ranges: Vec<[usize; 2]> = Vec::new();
    let mut duck: f32 = 0.0;
    let mut hold_remaining = 0usize;
    let mut open_start: Option<usize> = None;

    for (index, amplitude) in envelope.iter().enumerate() {
        let gate_open = *amplitude >= threshold;
        if gate_open {
            if open_start.is_none() {
                open_start = Some(index);
            }
            hold_remaining = hold_samples;
        } else if hold_remaining > 0 {
            hold_remaining -= 1;
        }
        let target = if gate_open || hold_remaining > 0 {
            1.0
        } else {
            0.0
        };
        let coefficient = if target > duck { attack } else { release };
        duck += (target - duck) * coefficient;
        // Linear interpolation between unity and full depth keeps the gain
        // monotonic with the smoothed duck amount.
        let gain = 1.0 - (1.0 - depth) * duck;
        gains[index] = gain;
        if !gate_open && hold_remaining == 0 {
            if let Some(start) = open_start.take() {
                ranges.push([start, index]);
            }
        }
    }
    if let Some(start) = open_start {
        ranges.push([start, total]);
    }

    Ok((gains, ranges))
}

/// Mix layers without ducking (reference render for measurements).
pub fn mix_layers(layers: &[AudioLayer]) -> Result<Vec<f32>> {
    let total = validate_layers(layers)?;
    let mut output = vec![0.0f32; total];
    for layer in layers {
        for (index, sample) in layer.samples.iter().enumerate() {
            output[layer.start_sample + index] += sample * layer.base_gain(index);
        }
    }
    for value in &mut output {
        *value = value.clamp(-1.0, 1.0);
    }
    Ok(output)
}

/// Mix with voice-triggered ducking applied to every non-voice layer.
pub fn mix_with_ducking(layers: &[AudioLayer], config: &DuckingConfig) -> Result<(Vec<f32>, DuckingReport)> {
    let (gains, voice_ranges) = ducking_gains(layers, config)?;
    let total = gains.len();
    let mut output = vec![0.0f32; total];
    for layer in layers {
        let ducked = !layer.role.is_voice();
        for (index, sample) in layer.samples.iter().enumerate() {
            let position = layer.start_sample + index;
            if position >= total {
                break;
            }
            let duck_gain = if ducked { gains[position] } else { 1.0 };
            output[position] += sample * layer.base_gain(index) * duck_gain;
        }
    }
    for value in &mut output {
        *value = value.clamp(-1.0, 1.0);
    }

    let peak_gain_db = gains
        .iter()
        .copied()
        .fold(1.0f32, f32::min)
        .max(1.0e-6)
        .log10()
        * 20.0;
    let window_len = (config.sample_rate as usize / 4).max(1);
    let mut windows = Vec::new();
    let mut start = 0usize;
    while start < total {
        let end = (start + window_len).min(total);
        let mean_linear = gains[start..end].iter().copied().sum::<f32>() / (end - start) as f32;
        windows.push(GainWindow {
            start_sample: start,
            end_sample: end,
            mean_gain_db: 20.0 * mean_linear.max(1.0e-6).log10(),
        });
        start = end;
    }

    Ok((
        output,
        DuckingReport {
            config: config.clone(),
            ducking_enabled: layers.iter().any(|layer| layer.role.is_voice())
                && layers.iter().any(|layer| !layer.role.is_voice()),
            voice_ranges,
            peak_gain_db,
            requested_depth_db: config.depth_db,
            windows,
        },
    ))
}

/// Build the demo timeline used by the CLI and the verification script:
/// a constant music bed for 2 s and a voice tone from 0.5 s to 1.0 s.
pub fn demo_layers(config: &DuckingConfig) -> (Vec<AudioLayer>, Vec<AudioLayer>) {
    let rate = config.sample_rate as usize;
    let duration = rate * 2;
    let music = vec![0.5f32; duration];
    let mut voice = vec![0.0f32; rate / 2];
    let voice_frequency = 440.0f32;
    for (index, sample) in voice.iter_mut().enumerate() {
        let t = index as f32 / config.sample_rate as f32;
        *sample = 0.5 * (std::f32::consts::TAU * voice_frequency * t).sin();
    }
    let music_layer = AudioLayer::new(0, music, AudioRole::Music);
    let voice_layer = AudioLayer::new(rate / 2, voice, AudioRole::Voice);
    (vec![music_layer.clone()], vec![music_layer, voice_layer])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gain_at(gains: &[f32], sample: usize) -> f32 {
        gains[sample]
    }

    fn sine(rate: u32, seconds: f32, frequency: f32, amplitude: f32) -> Vec<f32> {
        let count = (rate as f32 * seconds) as usize;
        (0..count)
            .map(|index| {
                let t = index as f32 / rate as f32;
                amplitude * (std::f32::consts::TAU * frequency * t).sin()
            })
            .collect()
    }

    fn music_and_voice(config: &DuckingConfig) -> Vec<AudioLayer> {
        let rate = config.sample_rate;
        let music = vec![0.5f32; rate as usize * 2];
        let voice = sine(rate, 0.5, 440.0, 0.5);
        vec![
            AudioLayer::new(0, music, AudioRole::Music),
            AudioLayer::new(rate as usize / 2, voice, AudioRole::Voice),
        ]
    }

    #[test]
    fn default_config_is_valid() {
        DuckingConfig::default().validate().unwrap();
    }

    #[test]
    fn invalid_config_is_rejected() {
        let mut config = DuckingConfig::default();
        config.depth_db = 0.0;
        assert!(config.validate().is_err());
        let mut config = DuckingConfig::default();
        config.attack_ms = 0.0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn ducking_reaches_requested_depth_within_tolerance() {
        let config = DuckingConfig {
            attack_ms: 10.0,
            release_ms: 100.0,
            hold_ms: 0.0,
            depth_db: 12.0,
            ..DuckingConfig::default()
        };
        let layers = music_and_voice(&config);
        let (gains, ranges) = ducking_gains(&layers, &config).unwrap();
        let rate = config.sample_rate as usize;
        // Before the voice starts the music is at unity.
        assert!((gain_at(&gains, rate / 4) - 1.0).abs() < 1e-3);
        // 0.4 s into the voice, the envelope has converged to the depth.
        let expected = 10.0f32.powf(-12.0 / 20.0);
        assert!(
            (gain_at(&gains, rate * 9 / 10) - expected).abs() < 0.01,
            "gain {} != {}",
            gain_at(&gains, rate * 9 / 10),
            expected
        );
        // After release it returns to unity.
        assert!(gain_at(&gains, rate * 2 - 1) > 0.999);
        assert_eq!(ranges.len(), 1);
        assert!(ranges[0][0] <= rate / 2 + rate / 100 && ranges[0][1] >= rate);
    }

    #[test]
    fn voice_layers_are_not_ducked() {
        let config = DuckingConfig::default();
        let voice = AudioLayer::new(0, sine(config.sample_rate, 1.0, 440.0, 0.4), AudioRole::Voice);
        let layers = vec![voice];
        let plain = mix_layers(&layers).unwrap();
        let (ducked, report) = mix_with_ducking(&layers, &config).unwrap();
        assert_eq!(plain.len(), ducked.len());
        for (a, b) in plain.iter().zip(ducked.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
        assert!(!report.ducking_enabled);
    }

    #[test]
    fn hold_keeps_ducking_after_voice_stops() {
        let config = DuckingConfig {
            attack_ms: 5.0,
            release_ms: 100.0,
            hold_ms: 300.0,
            depth_db: 12.0,
            ..DuckingConfig::default()
        };
        let layers = music_and_voice(&config);
        let (gains, _) = ducking_gains(&layers, &config).unwrap();
        let rate = config.sample_rate as usize;
        // Voice ends at 1.0 s; 150 ms later the hold still keeps ducking.
        assert!(gain_at(&gains, rate + rate * 15 / 100) < 0.5);
        // 1 s after the voice ends the release has recovered.
        assert!(gain_at(&gains, rate * 2 - 1) > 0.9);
    }

    #[test]
    fn ducking_composes_with_base_gains() {
        let config = DuckingConfig {
            attack_ms: 10.0,
            release_ms: 100.0,
            hold_ms: 0.0,
            ..DuckingConfig::default()
        };
        let rate = config.sample_rate;
        let music = AudioLayer::new(0, vec![0.5f32; rate as usize * 2], AudioRole::Music)
            .with_base_gain(0.5);
        let voice = AudioLayer::new(
            rate as usize / 2,
            sine(rate, 0.5, 440.0, 0.5),
            AudioRole::Voice,
        );
        let (mixed, _) = mix_with_ducking(&[music, voice], &config).unwrap();
        // music = 0.5 sample * 0.5 base gain * 0.2512 duck ≈ 0.0628, voice ≤ 0.5.
        let late = mixed[rate as usize * 75 / 100];
        assert!(late.abs() <= 0.5 + 1e-6);
        assert!(mixed[10].abs() <= 0.25 + 1e-6);
    }

    #[test]
    fn demo_layers_have_expected_shape() {
        let config = DuckingConfig {
            sample_rate: 48_000,
            ..DuckingConfig::default()
        };
        let (reference, with_voice) = demo_layers(&config);
        assert_eq!(reference.len(), 1);
        assert_eq!(with_voice.len(), 2);
        assert_eq!(with_voice[0].samples.len(), 96_000);
        assert_eq!(with_voice[1].start_sample, 24_000);
        assert_eq!(with_voice[1].samples.len(), 24_000);
    }
}
