//! Minimal mono 16-bit PCM WAV writer for ducking evidence.
//!
//! The production encoder muxes raw `s16le`; this module writes a standalone
//! WAV so the verification script can measure gain with a plain Python `wave`
//! reader (no third-party audio library).

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use crate::{ExportProError, Result};

/// Write `samples` (mono f32 in `[-1, 1]`) as a 16-bit PCM WAV at `sample_rate`.
///
/// Values are scaled by 32767 and clamped, matching
/// `opentake_media::encode::mix::mono_f32_to_s16le`.
pub fn write_wav_f32_mono(path: &Path, samples: &[f32], sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(ExportProError::InvalidSpec(
            "WAV sample rate must be positive".into(),
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data_len = samples.len() * 2;
    let mut writer = BufWriter::new(File::create(path)?);
    writer.write_all(b"RIFF")?;
    writer.write_all(&((36 + data_len) as u32).to_le_bytes())?;
    writer.write_all(b"WAVEfmt ")?;
    writer.write_all(&16u32.to_le_bytes())?;
    writer.write_all(&1u16.to_le_bytes())?; // PCM
    writer.write_all(&1u16.to_le_bytes())?; // mono
    writer.write_all(&sample_rate.to_le_bytes())?;
    writer.write_all(&(sample_rate * 2).to_le_bytes())?; // byte rate
    writer.write_all(&2u16.to_le_bytes())?; // block align
    writer.write_all(&16u16.to_le_bytes())?; // bits per sample
    writer.write_all(b"data")?;
    writer.write_all(&(data_len as u32).to_le_bytes())?;
    for sample in samples {
        let scaled = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        writer.write_all(&scaled.to_le_bytes())?;
    }
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_and_payload_are_written() {
        let dir = std::env::temp_dir().join(format!(
            "opentake-export-pro-wav-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.wav");
        let samples: Vec<f32> = (0..480).map(|i| (i as f32 / 480.0) * 2.0 - 1.0).collect();
        write_wav_f32_mono(&path, &samples, 48_000).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(bytes.len(), 44 + samples.len() * 2);
        let declared = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        assert_eq!(declared, samples.len() * 2);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn zero_sample_rate_is_rejected() {
        let path = std::env::temp_dir().join("opentake-export-pro-zero.wav");
        assert!(write_wav_f32_mono(&path, &[0.0], 0).is_err());
    }
}
