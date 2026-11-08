//! Codec/pixel-format selection and the ffmpeg argument contract for the
//! export prototype.
//!
//! The production encoder (`opentake_media::encode::VideoEncoder`) pipes raw
//! **RGBA8** frames from the wgpu compositor into ffmpeg and its
//! `ExportPreset::pix_fmt_arg` returns `yuv420p` for H.264/H.265. This module
//! keeps the same "raw RGBA frames on stdin" input but adds the delivery
//! combinations Route B needs: **10-bit HEVC** (`yuv420p10le`, Main 10) and
//! **HDR10 signing** (BT.2020/PQ tags + mastering display metadata).
//!
//! Everything here is pure argument construction except
//! [`encode_rgba8_frames`], which spawns ffmpeg and is exercised by the
//! verification script.

use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::{ExportProError, Result};

/// Video codecs supported by this prototype.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProCodec {
    H264,
    H265,
    ProRes422,
    ProRes4444,
}

impl ProCodec {
    /// ffmpeg `-c:v` token.
    pub fn encoder_token(self) -> &'static str {
        match self {
            ProCodec::H264 => "libx264",
            ProCodec::H265 => "libx265",
            ProCodec::ProRes422 | ProCodec::ProRes4444 => "prores_ks",
        }
    }

    /// ffmpeg `-profile:v` token, when one is required.
    pub fn profile_token(self, bit_depth: BitDepth) -> Option<&'static str> {
        match self {
            ProCodec::H264 => Some("high"),
            ProCodec::H265 if bit_depth == BitDepth::Ten => Some("main10"),
            ProCodec::H265 => Some("main"),
            ProCodec::ProRes422 => Some("422"),
            ProCodec::ProRes4444 => Some("4444"),
        }
    }

    /// Whether this codec can carry 10-bit samples in this prototype.
    pub fn supports_ten_bit(self) -> bool {
        matches!(
            self,
            ProCodec::H265 | ProCodec::ProRes422 | ProCodec::ProRes4444
        )
    }

    /// Container extension ffmpeg infers from the output path (used for docs).
    pub fn container_extension(self) -> &'static str {
        match self {
            ProCodec::ProRes422 | ProCodec::ProRes4444 => "mov",
            ProCodec::H264 | ProCodec::H265 => "mp4",
        }
    }
}

/// Requested sample bit depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BitDepth {
    Eight,
    Ten,
}

impl BitDepth {
    pub fn bits(self) -> u8 {
        match self {
            BitDepth::Eight => 8,
            BitDepth::Ten => 10,
        }
    }

    pub fn parse(value: u8) -> Result<Self> {
        match value {
            8 => Ok(BitDepth::Eight),
            10 => Ok(BitDepth::Ten),
            other => Err(ExportProError::InvalidSpec(format!(
                "unsupported bit depth {other}; expected 8 or 10"
            ))),
        }
    }
}

/// Delivery colour signalling. Strings are the ffmpeg colour token vocabulary
/// (`bt709`, `bt2020`, `smpte2084`, ...); the prototype never interpolates
/// untrusted input into a filter graph because only [`ColorTags::bt709`] and
/// [`ColorTags::bt2020_pq`] are used by the CLI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorTags {
    pub primaries: String,
    pub transfer: String,
    pub matrix: String,
}

impl ColorTags {
    /// SDR BT.709 delivery, matching the current production `color_args()`.
    pub fn bt709() -> Self {
        ColorTags {
            primaries: "bt709".into(),
            transfer: "bt709".into(),
            matrix: "bt709".into(),
        }
    }

    /// HDR10 delivery: BT.2020 primaries, PQ (SMPTE ST 2084) transfer.
    pub fn bt2020_pq() -> Self {
        ColorTags {
            primaries: "bt2020".into(),
            transfer: "smpte2084".into(),
            matrix: "bt2020nc".into(),
        }
    }

    /// Whether the transfer function declares an HDR signal.
    pub fn is_hdr(&self) -> bool {
        matches!(
            self.transfer.to_ascii_lowercase().as_str(),
            "smpte2084" | "pq" | "arib-std-b67" | "hlg"
        )
    }

    /// ffmpeg stream/container colour args.
    pub fn stream_args(&self) -> Vec<String> {
        vec![
            "-colorspace".into(),
            self.matrix.clone(),
            "-color_primaries".into(),
            self.primaries.clone(),
            "-color_trc".into(),
            self.transfer.clone(),
        ]
    }
}

/// One encode request. Field names map 1:1 to the JSON the verification binary
/// accepts, so the same struct is the integration contract with the node addon.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeSpec {
    /// Output path.
    pub out: String,
    /// Frame width in pixels (must be even).
    pub width: u32,
    /// Frame height in pixels (must be even).
    pub height: u32,
    /// Frames per second.
    pub fps: i32,
    pub codec: ProCodec,
    pub bit_depth: BitDepth,
    /// x264/x265 CRF; ignored for ProRes.
    pub crf: Option<u8>,
    /// x264/x265 speed preset.
    pub preset: Option<String>,
    pub color: ColorTags,
    /// HDR10 mastering-display string (`G(x,y)B(x,y)R(x,y)WP(x,y)L(max,min)`).
    pub mastering_display: Option<String>,
    /// HDR10 maximum content light level (nits).
    pub max_cll: Option<u32>,
    /// HDR10 maximum frame-average light level (nits).
    pub max_fall: Option<u32>,
}

impl EncodeSpec {
    /// Validate that the requested combination is encodable.
    pub fn validate(&self) -> Result<()> {
        if self.out.trim().is_empty() {
            return Err(ExportProError::InvalidSpec("output path is empty".into()));
        }
        if self.width < 2 || self.height < 2 {
            return Err(ExportProError::InvalidSpec(
                "width and height must be at least 2".into(),
            ));
        }
        if self.width % 2 != 0 || self.height % 2 != 0 {
            return Err(ExportProError::InvalidSpec(
                "width and height must be even for 4:2:0/4:2:2 encoding".into(),
            ));
        }
        if self.fps <= 0 {
            return Err(ExportProError::InvalidSpec("fps must be positive".into()));
        }
        if self.bit_depth == BitDepth::Ten && !self.codec.supports_ten_bit() {
            return Err(ExportProError::InvalidSpec(format!(
                "{:?} is 8-bit only in this prototype; use H.265 for 10-bit delivery",
                self.codec
            )));
        }
        if self.bit_depth == BitDepth::Eight
            && matches!(self.codec, ProCodec::ProRes422 | ProCodec::ProRes4444)
        {
            return Err(ExportProError::InvalidSpec(
                "ProRes 422/4444 are 10-bit formats".into(),
            ));
        }
        if self.color.is_hdr() && (self.codec != ProCodec::H265 || self.bit_depth != BitDepth::Ten)
        {
            return Err(ExportProError::InvalidSpec(
                "HDR10 delivery requires H.265 10-bit (yuv420p10le)".into(),
            ));
        }
        if !self.color.is_hdr()
            && (self.mastering_display.is_some() || self.max_cll.is_some() || self.max_fall.is_some())
        {
            return Err(ExportProError::InvalidSpec(
                "mastering-display/max-cll metadata requires HDR colour tags".into(),
            ));
        }
        if self.crf.is_some() && matches!(self.codec, ProCodec::ProRes422 | ProCodec::ProRes4444) {
            return Err(ExportProError::InvalidSpec(
                "crf is not an x264/x265 option; ProRes ignores it".into(),
            ));
        }
        if let Some(crf) = self.crf {
            if crf > 51 {
                return Err(ExportProError::InvalidSpec("crf must be <= 51".into()));
            }
        }
        Ok(())
    }

    /// Output pixel format.
    pub fn pixel_format(&self) -> &'static str {
        match self.codec {
            ProCodec::H264 => "yuv420p",
            ProCodec::H265 => match self.bit_depth {
                BitDepth::Eight => "yuv420p",
                BitDepth::Ten => "yuv420p10le",
            },
            ProCodec::ProRes422 => "yuv422p10le",
            ProCodec::ProRes4444 => "yuva444p10le",
        }
    }

    /// Bytes per composed RGBA8 frame expected on stdin.
    pub fn frame_bytes(&self) -> usize {
        (self.width as usize) * (self.height as usize) * 4
    }

    /// `-x265-params` payload: quiet logging plus colour/HDR metadata. FFmpeg's
    /// `-color_primaries` stream flags alone do not reliably write the VUI, so
    /// the x265 params repeat the signalling; HDR10 metadata is written here.
    pub fn x265_params(&self) -> Option<String> {
        if self.codec != ProCodec::H265 {
            return None;
        }
        let mut params = vec!["log-level=error".to_string()];
        if self.color.is_hdr() {
            params.push(format!("colorprim={}", self.color.primaries));
            params.push(format!("transfer={}", self.color.transfer));
            params.push(format!("colormatrix={}", self.color.matrix));
            if let Some(display) = &self.mastering_display {
                params.push(format!("master-display={display}"));
            }
            if let Some(cll) = self.max_cll {
                params.push(format!("max-cll={cll},{}", self.max_fall.unwrap_or(cll)));
            }
        }
        Some(params.join(":"))
    }
}

/// Build the ffmpeg argument list for encoding raw RGBA8 frames read from
/// stdin. Mirrors `opentake_media::encode::encode_args` but adds the 10-bit and
/// HDR variants; the input side is unchanged so the wgpu compositor can keep
/// producing `[u8; w*h*4]` frames.
pub fn encode_args(spec: &EncodeSpec) -> Result<Vec<String>> {
    spec.validate()?;
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-s".into(),
        format!("{}x{}", spec.width, spec.height),
        "-r".into(),
        spec.fps.to_string(),
        "-i".into(),
        "-".into(),
        "-c:v".into(),
        spec.codec.encoder_token().into(),
        "-pix_fmt".into(),
        spec.pixel_format().into(),
    ];

    if let Some(profile) = spec.codec.profile_token(spec.bit_depth) {
        args.push("-profile:v".into());
        args.push(profile.into());
    }
    match spec.codec {
        ProCodec::H264 | ProCodec::H265 => {
            if let Some(preset) = &spec.preset {
                args.push("-preset".into());
                args.push(preset.clone());
            }
            if let Some(crf) = spec.crf {
                args.push("-crf".into());
                args.push(crf.to_string());
            }
        }
        ProCodec::ProRes422 | ProCodec::ProRes4444 => {
            // Keep ProRes deterministically high quality; the preset is lossy
            // by design and the prototype's question is bit depth, not rate.
            args.push("-qscale:v".into());
            args.push("1".into());
        }
    }
    // FFmpeg stream colour flags alone leave primaries/transfer `unknown` in
    // the produced HEVC bitstream (the production preset documents the same
    // issue); tag every frame explicitly before the encoder sees it.
    args.push("-vf".into());
    args.push(format!(
        "setparams=color_primaries={}:color_trc={}:colorspace={}",
        spec.color.primaries, spec.color.transfer, spec.color.matrix
    ));
    if let Some(params) = spec.x265_params() {
        args.push("-x265-params".into());
        args.push(params);
    }
    args.extend(spec.color.stream_args());
    if spec.color.is_hdr() {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args.push(spec.out.clone());
    Ok(args)
}

/// Encode a sequence of RGBA8 frames by streaming them to ffmpeg.
///
/// Returned string is ffmpeg's stderr (empty on success because the argument
/// list uses `-loglevel error`). Callers should verify the file with ffprobe;
/// this function only proves the frames were accepted.
pub fn encode_rgba8_frames<I>(spec: &EncodeSpec, frames: I) -> Result<String>
where
    I: IntoIterator<Item = Vec<u8>>,
{
    let args = encode_args(spec)?;
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
    let frame_bytes = spec.frame_bytes();
    let mut written = 0usize;
    for (index, frame) in frames.into_iter().enumerate() {
        if frame.len() != frame_bytes {
            return Err(ExportProError::Encode(format!(
                "frame {index} has {} bytes, expected {frame_bytes}",
                frame.len()
            )));
        }
        stdin
            .write_all(&frame)
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

/// A deterministic RGBA8 test pattern: a horizontal hue/luma gradient with a
/// moving bright square. The same generator feeds the 8-bit and 10-bit encodes
/// so their sizes are comparable; it is intentionally not an HDR source.
pub fn synthetic_test_frames(width: u32, height: u32, frame_count: usize) -> Vec<Vec<u8>> {
    let mut frames = Vec::with_capacity(frame_count);
    let box_size = (height / 6).max(8);
    for frame_index in 0..frame_count {
        let mut frame = vec![0u8; width as usize * height as usize * 4];
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
                let r = (x as f32 / width as f32 * 255.0) as u8;
                let g = (y as f32 / height as f32 * 255.0) as u8;
                let b = (progress * 255.0) as u8;
                let in_box =
                    x >= box_x && x < box_x + box_size && y >= box_y && y < box_y + box_size;
                let (r, g, b) = if in_box { (255, 255, 255) } else { (r, g, b) };
                frame[index] = r;
                frame[index + 1] = g;
                frame[index + 2] = b;
                frame[index + 3] = 255;
            }
        }
        frames.push(frame);
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(codec: ProCodec, bit_depth: BitDepth) -> EncodeSpec {
        EncodeSpec {
            out: "/tmp/out.mp4".into(),
            width: 640,
            height: 360,
            fps: 30,
            codec,
            bit_depth,
            crf: Some(20),
            preset: Some("medium".into()),
            color: ColorTags::bt709(),
            mastering_display: None,
            max_cll: None,
            max_fall: None,
        }
    }

    #[test]
    fn h265_ten_bit_uses_yuv420p10le_and_main10() {
        let args = encode_args(&spec(ProCodec::H265, BitDepth::Ten)).unwrap();
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx265"]));
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p10le"]));
        assert!(args.windows(2).any(|w| w == ["-profile:v", "main10"]));
        assert!(args.windows(2).any(|w| w == ["-color_trc", "bt709"]));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-vf" && w[1].contains("color_primaries=bt709")));
        assert!(args.windows(2).any(|w| w == ["-crf", "20"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["-x265-params", "log-level=error"]));
    }

    #[test]
    fn h264_eight_bit_stays_yuv420p() {
        let args = encode_args(&spec(ProCodec::H264, BitDepth::Eight)).unwrap();
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
        assert!(args.windows(2).any(|w| w == ["-profile:v", "high"]));
    }

    #[test]
    fn h264_ten_bit_is_rejected() {
        let error = encode_args(&spec(ProCodec::H264, BitDepth::Ten)).unwrap_err();
        assert!(error.to_string().contains("8-bit only"));
    }

    #[test]
    fn prores_is_ten_bit_only() {
        let error = encode_args(&spec(ProCodec::ProRes422, BitDepth::Eight)).unwrap_err();
        assert!(error.to_string().contains("10-bit"));
        let mut request = spec(ProCodec::ProRes422, BitDepth::Ten);
        request.crf = None;
        request.preset = None;
        let args = encode_args(&request).unwrap();
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv422p10le"]));
        assert!(args.windows(2).any(|w| w == ["-c:v", "prores_ks"]));
    }

    #[test]
    fn hdr_requires_h265_ten_bit() {
        let mut request = spec(ProCodec::H265, BitDepth::Eight);
        request.color = ColorTags::bt2020_pq();
        let error = encode_args(&request).unwrap_err();
        assert!(error.to_string().contains("H.265 10-bit"));
    }

    #[test]
    fn hdr10_signs_stream_and_x265_vui_metadata() {
        let mut request = spec(ProCodec::H265, BitDepth::Ten);
        request.color = ColorTags::bt2020_pq();
        request.mastering_display = Some(
            "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)".into(),
        );
        request.max_cll = Some(1000);
        request.max_fall = Some(400);
        let args = encode_args(&request).unwrap();
        assert!(args.windows(2).any(|w| w == ["-colorspace", "bt2020nc"]));
        assert!(args.windows(2).any(|w| w == ["-color_primaries", "bt2020"]));
        assert!(args.windows(2).any(|w| w == ["-color_trc", "smpte2084"]));
        let params = args
            .windows(2)
            .find(|w| w[0] == "-x265-params")
            .map(|w| w[1].clone())
            .expect("x265 params");
        assert!(params.contains("transfer=smpte2084"));
        assert!(params.contains("master-display=G(13250,34500)"));
        assert!(params.contains("max-cll=1000,400"));
    }

    #[test]
    fn mastering_display_without_hdr_tags_is_rejected() {
        let mut request = spec(ProCodec::H265, BitDepth::Ten);
        request.max_cll = Some(1000);
        let error = encode_args(&request).unwrap_err();
        assert!(error.to_string().contains("requires HDR colour tags"));
    }

    #[test]
    fn odd_dimensions_are_rejected() {
        let mut request = spec(ProCodec::H265, BitDepth::Ten);
        request.width = 641;
        assert!(encode_args(&request).is_err());
    }

    #[test]
    fn frame_bytes_match_rgba8() {
        assert_eq!(spec(ProCodec::H264, BitDepth::Eight).frame_bytes(), 640 * 360 * 4);
    }

    #[test]
    fn synthetic_frames_are_deterministic_and_sized() {
        let first = synthetic_test_frames(64, 36, 2);
        let second = synthetic_test_frames(64, 36, 2);
        assert_eq!(first, second);
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].len(), 64 * 36 * 4);
    }
}
