//! HDR10 writer for scene-linear RGBA16F frames.
//!
//! Input contract (byte-compatible with `opentake_render::hdr::LinearFrame`):
//! RGBA half-floats, straight alpha, RGB scene-linear BT.2020 with
//! `1.0 == 10_000 cd/m²`. This module applies the SMPTE ST 2084 (PQ) inverse
//! EOTF, converts BT.2020 RGB to BT.2020 YCbCr 4:2:0, quantises to 10-bit
//! limited range and pipes raw `yuv420p10le` frames to libx265 with HDR10 VUI
//! and mastering-display/content-light metadata.
//!
//! This is a **true HDR10** writer: the pixels are PQ-encoded and tagged
//! BT.2020/PQ; it does not rely on an SDR source or a metadata-only retag. The
//! SDR fallback path remains [`crate::hdr`] + the RGBA8 writer in
//! [`crate::codec`] and is explicitly labelled non-HDR.

use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::{ExportProError, Result};

/// IEEE-754 binary16 encoder/decoder (kept local so the standalone export
/// prototype needs no extra dependency; the frame contract is still RGBA16F).
fn f32_to_f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32;
    let mantissa = bits & 0x7f_ffff;

    if exponent == 0xff {
        let payload = if mantissa == 0 { 0 } else { 0x0200 };
        return sign | 0x7c00 | payload;
    }
    let half_exp = exponent - 127 + 15;
    if half_exp >= 0x1f {
        return sign | 0x7c00;
    }
    if half_exp <= 0 {
        if half_exp < -10 {
            return sign;
        }
        let mantissa = (mantissa | 0x80_0000) >> (1 - half_exp);
        return sign | (mantissa >> 13) as u16;
    }
    sign | ((half_exp as u16) << 10) | ((mantissa >> 13) as u16)
}

fn f16_bits_to_f32(bits: u16) -> f32 {
    let sign = ((bits & 0x8000) as u32) << 16;
    let exponent = ((bits >> 10) & 0x1f) as u32;
    let mantissa = (bits & 0x03ff) as u32;
    let value = if exponent == 0 {
        if mantissa == 0 {
            sign
        } else {
            // Subnormal: normalise the 10-bit mantissa into a float32 mantissa.
            let mut exponent = -1_i32;
            let mut mantissa = mantissa;
            while mantissa & 0x0400 == 0 {
                mantissa <<= 1;
                exponent -= 1;
            }
            let exponent = (127 + exponent) as u32;
            sign | (exponent << 23) | ((mantissa & 0x03ff) << 13)
        }
    } else if exponent == 0x1f {
        sign | 0x7f80_0000 | (mantissa << 13)
    } else {
        sign | ((exponent + 127 - 15) << 23) | (mantissa << 13)
    };
    f32::from_bits(value)
}

/// Scene-linear BT.2020 RGBA16F frame; `1.0` RGB = 10_000 cd/m², alpha straight.
#[derive(Clone, Debug, PartialEq)]
pub struct LinearFrame {
    pub width: u32,
    pub height: u32,
    /// RGBA half-float bits, row-major.
    pub pixels: Vec<u16>,
}

impl LinearFrame {
    pub fn new(width: u32, height: u32, pixels: Vec<u16>) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(ExportProError::InvalidSpec(
                "linear frame width/height must be > 0".into(),
            ));
        }
        let expected = width as usize * height as usize * 4;
        if pixels.len() != expected {
            return Err(ExportProError::InvalidSpec(format!(
                "linear frame has {} half-floats, expected {expected}",
                pixels.len()
            )));
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    pub fn from_f32(width: u32, height: u32, components: &[f32]) -> Result<Self> {
        let expected = width as usize * height as usize * 4;
        if components.len() != expected {
            return Err(ExportProError::InvalidSpec(format!(
                "expected {expected} RGBA components, got {}",
                components.len()
            )));
        }
        let pixels = components
            .iter()
            .map(|value| f32_to_f16_bits(*value))
            .collect();
        Self::new(width, height, pixels)
    }

    pub fn to_f32(&self) -> Vec<f32> {
        self.pixels
            .iter()
            .map(|bits| f16_bits_to_f32(*bits))
            .collect()
    }

    pub fn pixel(&self, x: u32, y: u32) -> Option<[f32; 4]> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let index = ((y as usize * self.width as usize) + x as usize) * 4;
        Some([
            f16_bits_to_f32(self.pixels[index]),
            f16_bits_to_f32(self.pixels[index + 1]),
            f16_bits_to_f32(self.pixels[index + 2]),
            f16_bits_to_f32(self.pixels[index + 3]),
        ])
    }
}

/// HDR10 mastering display metadata (x265 token units: chromaticity 0.00002,
/// luminance 0.0001 cd/m²).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteringDisplay {
    pub green: [u32; 2],
    pub blue: [u32; 2],
    pub red: [u32; 2],
    pub white: [u32; 2],
    pub max_luminance: u32,
    pub min_luminance: u32,
}

impl MasteringDisplay {
    pub fn bt2020_1000nit() -> Self {
        Self {
            green: [13_250, 34_500],
            blue: [7_500, 3_000],
            red: [34_000, 16_000],
            white: [15_635, 16_450],
            max_luminance: 10_000_000,
            min_luminance: 1,
        }
    }

    pub fn x265_token(&self) -> String {
        format!(
            "G({},{})B({},{})R({},{})WP({},{})L({},{})",
            self.green[0],
            self.green[1],
            self.blue[0],
            self.blue[1],
            self.red[0],
            self.red[1],
            self.white[0],
            self.white[1],
            self.max_luminance,
            self.min_luminance
        )
    }
}

/// HDR10 output metadata policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hdr10Metadata {
    pub mastering_display: MasteringDisplay,
    pub max_cll: u32,
    pub max_fall: u32,
}

impl Hdr10Metadata {
    pub fn new(mastering_display: MasteringDisplay, max_cll: u32, max_fall: u32) -> Result<Self> {
        if max_cll == 0 || max_fall == 0 {
            return Err(ExportProError::InvalidSpec(
                "MaxCLL and MaxFALL must be > 0".into(),
            ));
        }
        if max_fall > max_cll {
            return Err(ExportProError::InvalidSpec(
                "MaxFALL must be <= MaxCLL".into(),
            ));
        }
        Ok(Self {
            mastering_display,
            max_cll,
            max_fall,
        })
    }

    pub fn reference_1000nit() -> Self {
        Self {
            mastering_display: MasteringDisplay::bt2020_1000nit(),
            max_cll: 1000,
            max_fall: 400,
        }
    }

    pub fn x265_params(&self) -> String {
        format!(
            "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display={}:max-cll={},{}",
            self.mastering_display.x265_token(),
            self.max_cll,
            self.max_fall
        )
    }
}

/// One HDR10 encode request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hdr10Spec {
    pub out: String,
    pub width: u32,
    pub height: u32,
    pub fps: i32,
    pub crf: u8,
    pub preset: String,
    pub metadata: Hdr10Metadata,
}

impl Hdr10Spec {
    pub fn validate(&self) -> Result<()> {
        if self.out.trim().is_empty() {
            return Err(ExportProError::InvalidSpec("output path is empty".into()));
        }
        if self.width < 2 || self.height < 2 {
            return Err(ExportProError::InvalidSpec(
                "width and height must be at least 2".into(),
            ));
        }
        if !self.width.is_multiple_of(2) || !self.height.is_multiple_of(2) {
            return Err(ExportProError::InvalidSpec(
                "HDR10 yuv420p10le requires even width/height".into(),
            ));
        }
        if self.fps <= 0 {
            return Err(ExportProError::InvalidSpec("fps must be positive".into()));
        }
        if self.crf > 51 {
            return Err(ExportProError::InvalidSpec("crf must be <= 51".into()));
        }
        Ok(())
    }

    /// ffmpeg arguments for raw `yuv420p10le` stdin → H.265 Main10 HDR10.
    pub fn encode_args(&self) -> Result<Vec<String>> {
        self.validate()?;
        Ok(vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "yuv420p10le".into(),
            "-s".into(),
            format!("{}x{}", self.width, self.height),
            "-r".into(),
            self.fps.to_string(),
            "-i".into(),
            "-".into(),
            "-c:v".into(),
            "libx265".into(),
            "-profile:v".into(),
            "main10".into(),
            "-pix_fmt".into(),
            "yuv420p10le".into(),
            "-preset".into(),
            self.preset.clone(),
            "-crf".into(),
            self.crf.to_string(),
            "-vf".into(),
            "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc".into(),
            "-x265-params".into(),
            self.metadata.x265_params(),
            "-color_primaries".into(),
            "bt2020".into(),
            "-color_trc".into(),
            "smpte2084".into(),
            "-colorspace".into(),
            "bt2020nc".into(),
            "-movflags".into(),
            "+faststart".into(),
            self.out.clone(),
        ])
    }

    /// One raw `yuv420p10le` frame size in bytes.
    pub fn frame_bytes(&self) -> usize {
        let y = (self.width as usize) * (self.height as usize);
        let chroma = (self.width as usize / 2) * (self.height as usize / 2);
        (y + chroma * 2) * 2
    }
}

/// PQ inverse EOTF: linear [0,1] (1.0 = 10_000 cd/m²) → normalised code [0,1].
pub fn pq_inverse_eotf(linear: f32) -> f32 {
    const M1: f32 = 2610.0 / 16_384.0;
    const M2: f32 = (2523.0 / 4096.0) * 128.0;
    const C1: f32 = 3424.0 / 4096.0;
    const C2: f32 = (2413.0 / 4096.0) * 32.0;
    const C3: f32 = (2392.0 / 4096.0) * 32.0;
    let y = linear.max(0.0).powf(M1);
    ((C1 + C2 * y) / (1.0 + C3 * y)).powf(M2)
}

/// PQ EOTF (used by tests/measurement): normalised code → linear [0,1].
pub fn pq_eotf(code: f32) -> f32 {
    const M1: f32 = 2610.0 / 16_384.0;
    const M2: f32 = (2523.0 / 4096.0) * 128.0;
    const C1: f32 = 3424.0 / 4096.0;
    const C2: f32 = (2413.0 / 4096.0) * 32.0;
    const C3: f32 = (2392.0 / 4096.0) * 32.0;
    let n = code.clamp(0.0, 1.0).powf(1.0 / M2);
    ((n - C1).max(0.0) / (C2 - C3 * n)).max(0.0).powf(1.0 / M1)
}

fn quantise_y(value: f32) -> u16 {
    (64.0 + value.clamp(0.0, 1.0) * 876.0)
        .round()
        .clamp(64.0, 940.0) as u16
}

fn quantise_chroma(value: f32) -> u16 {
    (512.0 + value.clamp(-0.5, 0.5) * 896.0)
        .round()
        .clamp(64.0, 960.0) as u16
}

/// Convert one linear BT.2020 RGBA16F frame to a raw `yuv420p10le` frame.
pub fn linear_frame_to_yuv420p10le(frame: &LinearFrame) -> Result<Vec<u8>> {
    if frame.width == 0
        || frame.height == 0
        || !frame.width.is_multiple_of(2)
        || !frame.height.is_multiple_of(2)
    {
        return Err(ExportProError::InvalidSpec(
            "HDR10 conversion requires positive even dimensions".into(),
        ));
    }
    let width = frame.width as usize;
    let height = frame.height as usize;
    let source = frame.to_f32();
    let mut y_plane = vec![0_u16; width * height];
    let mut u_plane = vec![0_u16; (width / 2) * (height / 2)];
    let mut v_plane = vec![0_u16; (width / 2) * (height / 2)];

    for py in 0..height {
        for px in 0..width {
            let base = ((py * width) + px) * 4;
            let rgb = [
                pq_inverse_eotf(source[base]),
                pq_inverse_eotf(source[base + 1]),
                pq_inverse_eotf(source[base + 2]),
            ];
            // BT.2020 non-constant-luminance RGB → YCbCr.
            let luma = 0.262_7 * rgb[0] + 0.678_0 * rgb[1] + 0.059_3 * rgb[2];
            let cb = (rgb[2] - luma) / 1.881_4;
            let cr = (rgb[0] - luma) / 1.474_6;
            y_plane[py * width + px] = quantise_y(luma);
            // 2×2 chroma subsampling by averaging the PQ-domain chroma.
            if px % 2 == 0 && py % 2 == 0 {
                let cx = px / 2;
                let cy = py / 2;
                let mut cb_sum = 0.0;
                let mut cr_sum = 0.0;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let sbase = (((py + dy) * width) + px + dx) * 4;
                        let srgb = [
                            pq_inverse_eotf(source[sbase]),
                            pq_inverse_eotf(source[sbase + 1]),
                            pq_inverse_eotf(source[sbase + 2]),
                        ];
                        let sy = 0.262_7 * srgb[0] + 0.678_0 * srgb[1] + 0.059_3 * srgb[2];
                        cb_sum += (srgb[2] - sy) / 1.881_4;
                        cr_sum += (srgb[0] - sy) / 1.474_6;
                    }
                }
                u_plane[cy * (width / 2) + cx] = quantise_chroma(cb_sum / 4.0);
                v_plane[cy * (width / 2) + cx] = quantise_chroma(cr_sum / 4.0);
            }
            let _ = (cb, cr);
        }
    }

    let mut bytes = Vec::with_capacity((y_plane.len() + u_plane.len() + v_plane.len()) * 2);
    for plane in [&y_plane, &u_plane, &v_plane] {
        for value in plane {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(bytes)
}

/// Explicit SDR fallback for comparison/evidence: BT.2020 linear → BT.709
/// linear, 203 cd/m² reference white, hard clip, BT.709 OETF, RGBA8 bytes.
/// This is deliberately **not** a tone map and carries no HDR claim.
pub fn linear_frame_to_sdr_rgba8(frame: &LinearFrame) -> Vec<u8> {
    let source = frame.to_f32();
    let mut rgba = vec![0_u8; frame.width as usize * frame.height as usize * 4];
    for (index, chunk) in rgba.chunks_mut(4).enumerate() {
        let base = index * 4;
        let [r, g, b] = bt2020_to_bt709([source[base], source[base + 1], source[base + 2]]);
        for (channel, value) in [r, g, b].into_iter().enumerate() {
            let nits = (value.max(0.0) * 10_000.0).max(0.0);
            let normalised = (nits / 203.0).clamp(0.0, 1.0);
            chunk[channel] = (bt709_oetf(normalised) * 255.0).round() as u8;
        }
        chunk[3] = (source[base + 3].clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    rgba
}

/// BT.2020 linear RGB → BT.709 linear RGB (BT.2087 coefficients).
pub fn bt2020_to_bt709(rgb_2020: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb_2020;
    [
        1.660_491 * r - 0.587_641 * g - 0.072_850 * b,
        -0.124_55 * r + 1.132_9 * g - 0.008_35 * b,
        -0.018_151 * r - 0.100_579 * g + 1.118_73 * b,
    ]
}

/// BT.709 OETF; input/output [0,1].
pub fn bt709_oetf(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    if value < 0.018 {
        4.5 * value
    } else {
        1.099 * value.powf(0.45) - 0.099
    }
}

/// Encode linear RGBA16F frames as a true HDR10 H.265 Main10 stream.
pub fn encode_hdr10_frames<I>(spec: &Hdr10Spec, frames: I) -> Result<String>
where
    I: IntoIterator<Item = LinearFrame>,
{
    let args = spec.encode_args()?;
    let ffmpeg = crate::ffmpeg_bin();
    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ExportProError::Encode(format!("spawn {ffmpeg}: {error}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ExportProError::Encode("ffmpeg stdin is unavailable".into()))?;
    let mut written = 0usize;
    for (index, frame) in frames.into_iter().enumerate() {
        if frame.width != spec.width || frame.height != spec.height {
            return Err(ExportProError::Encode(format!(
                "frame {index} is {}x{}, expected {}x{}",
                frame.width, frame.height, spec.width, spec.height
            )));
        }
        let raw = linear_frame_to_yuv420p10le(&frame)?;
        if raw.len() != spec.frame_bytes() {
            return Err(ExportProError::Encode(format!(
                "frame {index} converted to {} bytes, expected {}",
                raw.len(),
                spec.frame_bytes()
            )));
        }
        stdin
            .write_all(&raw)
            .map_err(|error| ExportProError::Encode(format!("write frame {index}: {error}")))?;
        written += 1;
    }
    drop(stdin);
    let output = child
        .wait_with_output()
        .map_err(|error| ExportProError::Encode(format!("wait for ffmpeg: {error}")))?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        return Err(ExportProError::Encode(format!(
            "ffmpeg exited {} after {written} frames: {}",
            output.status,
            stderr.trim()
        )));
    }
    Ok(stderr)
}

/// Deterministic synthetic HDR10 frames: four vertical bars at
/// 0.0001/0.0203/0.1/0.4 scene-linear (1/203/1000/4000 cd/m²) plus a moving
/// HDR highlight square. The >0.0203 bars are above SDR reference white, so the
/// SDR fallback would clip them while the HDR writer preserves them.
pub fn synthetic_hdr10_frames(width: u32, height: u32, frame_count: usize) -> Vec<LinearFrame> {
    let mut frames = Vec::with_capacity(frame_count);
    let box_size = (height / 6).max(4);
    for frame_index in 0..frame_count {
        let mut components = vec![0.0_f32; width as usize * height as usize * 4];
        let progress = if frame_count <= 1 {
            0.0
        } else {
            frame_index as f32 / (frame_count - 1) as f32
        };
        let box_x = ((width.saturating_sub(box_size)) as f32 * progress) as u32;
        let box_y = height / 2 - box_size / 2;
        for y in 0..height {
            for x in 0..width {
                let index = ((y as usize * width as usize) + x as usize) * 4;
                let bar = (x * 4 / width.max(1)).min(3) as usize;
                let linear = [0.000_1_f32, 0.020_3, 0.1, 0.4][bar];
                let in_box =
                    x >= box_x && x < box_x + box_size && y >= box_y && y < box_y + box_size;
                let rgb = if in_box {
                    [4.0_f32, 4.0, 4.0]
                } else {
                    [linear; 3]
                };
                components[index] = rgb[0];
                components[index + 1] = rgb[1];
                components[index + 2] = rgb[2];
                components[index + 3] = 1.0;
            }
        }
        frames
            .push(LinearFrame::from_f32(width, height, &components).expect("synthetic HDR frame"));
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> Hdr10Spec {
        Hdr10Spec {
            out: "/tmp/hdr10.mp4".into(),
            width: 64,
            height: 36,
            fps: 30,
            crf: 20,
            preset: "medium".into(),
            metadata: Hdr10Metadata::reference_1000nit(),
        }
    }

    #[test]
    fn pq_round_trip_and_non_gamma_shape() {
        for code in [0.0_f32, 0.1, 0.25, 0.5, 0.75, 0.9] {
            let linear = pq_eotf(code);
            let encoded = pq_inverse_eotf(linear);
            assert!(
                (encoded - code).abs() < 1e-5,
                "{code} -> {linear} -> {encoded}"
            );
        }
        assert!(pq_eotf(0.1) < 0.01);
        assert!((pq_eotf(1.0) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn black_and_white_quantise_to_limited_range() {
        let black = LinearFrame::from_f32(2, 2, &[0.0; 16]).unwrap();
        let raw = linear_frame_to_yuv420p10le(&black).unwrap();
        let y0 = u16::from_le_bytes([raw[0], raw[1]]);
        assert_eq!(y0, 64);

        let white = LinearFrame::from_f32(2, 2, &[1.0, 1.0, 1.0, 1.0].repeat(4)).unwrap();
        let raw = linear_frame_to_yuv420p10le(&white).unwrap();
        let y0 = u16::from_le_bytes([raw[0], raw[1]]);
        assert_eq!(y0, 940);
        let cb = u16::from_le_bytes([raw[2 * 2 * 2], raw[2 * 2 * 2 + 1]]);
        assert_eq!(cb, 512);
    }

    #[test]
    fn hdr10_args_request_main10_pq_bt2020_and_metadata() {
        let args = spec().encode_args().unwrap();
        let pairs = |needle: &str| args.windows(2).any(|w| w[0] == needle);
        assert!(pairs("-c:v"));
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx265"]));
        assert!(args.windows(2).any(|w| w == ["-profile:v", "main10"]));
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p10le"]));
        assert!(args.windows(2).any(|w| w == ["-color_primaries", "bt2020"]));
        assert!(args.windows(2).any(|w| w == ["-color_trc", "smpte2084"]));
        assert!(args.windows(2).any(|w| w == ["-colorspace", "bt2020nc"]));
        let params = args
            .windows(2)
            .find(|w| w[0] == "-x265-params")
            .map(|w| w[1].clone())
            .expect("x265 params");
        assert!(params.contains("master-display=G(13250,34500)"));
        assert!(params.contains("max-cll=1000,400"));
    }

    #[test]
    fn frame_bytes_and_validation() {
        assert_eq!(spec().frame_bytes(), (64 * 36 + 32 * 18 * 2) * 2);
        assert!(spec().validate().is_ok());
        let mut odd = spec();
        odd.width = 65;
        assert!(odd.validate().is_err());
        assert!(Hdr10Metadata::new(MasteringDisplay::bt2020_1000nit(), 0, 0).is_err());
        assert!(Hdr10Metadata::new(MasteringDisplay::bt2020_1000nit(), 100, 400).is_err());
    }

    #[test]
    fn sdr_fallback_clips_bars_above_reference_white() {
        let frames = synthetic_hdr10_frames(64, 36, 1);
        let rgba = linear_frame_to_sdr_rgba8(&frames[0]);
        let sample = |x: usize, y: usize| rgba[(y * 64 + x) * 4] as u16;
        let y = 18;
        let bar0 = sample(8, y);
        let bar1 = sample(24, y);
        let bar2 = sample(40, y);
        let bar3 = sample(56, y);
        // 203 cd/m² is SDR reference white, so bar1 already clamps to 255;
        // bars at 1000/4000 cd/m² clip to the same white. The HDR path keeps
        // all four bars distinct in PQ code values.
        assert_eq!(bar1, 255, "203-nit reference white maps to SDR white");
        assert_eq!(bar2, 255, "1000-nit bar must clip in SDR fallback");
        assert_eq!(bar3, 255, "4000-nit bar must clip in SDR fallback");
        assert!(bar0 < bar1, "{bar0} {bar1} {bar2} {bar3}");
    }

    #[test]
    fn synthetic_frames_are_deterministic_and_above_sdr_white() {
        let first = synthetic_hdr10_frames(64, 36, 2);
        let second = synthetic_hdr10_frames(64, 36, 2);
        assert_eq!(first, second);
        assert_eq!(first.len(), 2);
        let frame = &first[0];
        let third_bar = frame.pixel(32, 18).unwrap();
        assert!((third_bar[0] - 0.1).abs() < 1e-3);
        assert!(third_bar[0] > 0.0203, "bar is above SDR reference white");
    }
}
