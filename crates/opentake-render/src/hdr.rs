//! HDR10 linear frame contract and a reference linear compositor.
//!
//! This module is the **true-HDR** path introduced for Route B:
//!
//! - [`LinearFrame`] is an RGBA16F (`*_16F`, half-float) frame whose RGB values
//!   are **scene-linear** and normalised so `1.0 == 10_000 cd/m²` (the PQ peak).
//!   Alpha is straight (not premultiplied), matching [`crate::DecodedFrame`]'s
//!   contract at the compositor boundary.
//! - [`LinearCompositor`] composites full-frame linear layers in that space. It
//!   does not clamp to [0,1] and therefore preserves highlights above SDR white.
//! - [`LinearFrame::to_sdr_rgba8`] is the explicit **SDR fallback**: it converts
//!   BT.2020 linear to BT.709, maps 203 cd/m² to SDR white and clips. It reports
//!   `tone_mapped = false` because clipping is not tone mapping.
//! - [`Hdr10Metadata`] defines the BT.2020/PQ output policy, mastering display
//!   and MaxCLL/MaxFALL values used by the export writer.
//!
//! The shipped wgpu compositor ([`crate::Compositor`]) still renders RGBA8 SDR.
//! This module is the isolated reference path the export prototype consumes; it
//! must not be described as the current production compositor until the wgpu
//! pipeline itself is migrated to `Rgba16Float`. See
//! `docs/architecture/route-b-hdr.md` for the exact claim boundary.

use half::f16;

use crate::source::DecodedFrame;

/// Fixed error type for invalid HDR frames/contracts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HdrError(pub String);

impl std::fmt::Display for HdrError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for HdrError {}

impl From<&str> for HdrError {
    fn from(message: &str) -> Self {
        HdrError(message.to_string())
    }
}

impl From<String> for HdrError {
    fn from(message: String) -> Self {
        HdrError(message)
    }
}

/// Scene-linear RGB primaries carried by a [`LinearFrame`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinearPrimaries {
    Bt2020,
    Bt709,
}

/// Scene-linear RGB transfer. `Linear` is already scene-linear; the other
/// variants describe how a *source* frame was encoded before linearisation and
/// are informational for the compositor contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinearTransfer {
    Linear,
    Pq,
    Hlg,
}

/// Optional HDR mastering/content-light metadata carried with a source frame so
/// the compositor/export layer can preserve it instead of inventing values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinearSourceMetadata {
    pub mastering_display: Option<MasteringDisplay>,
    pub max_cll: Option<u32>,
    pub max_fall: Option<u32>,
}

/// RGBA16F scene-linear frame. RGB = linear light, 1.0 == 10_000 cd/m².
#[derive(Clone, Debug, PartialEq)]
pub struct LinearFrame {
    width: u32,
    height: u32,
    /// RGBA half-float bits in row-major order.
    pixels: Vec<u16>,
    pub primaries: LinearPrimaries,
    pub transfer: LinearTransfer,
    /// Source mastering/content-light metadata (empty for synthetic/SDR frames).
    pub source_metadata: LinearSourceMetadata,
}

impl LinearFrame {
    pub fn new(
        width: u32,
        height: u32,
        pixels: Vec<u16>,
        primaries: LinearPrimaries,
        transfer: LinearTransfer,
    ) -> Result<Self, HdrError> {
        if width == 0 || height == 0 {
            return Err(HdrError::from("linear frame width/height must be > 0"));
        }
        let expected = width as usize * height as usize * 4;
        if pixels.len() != expected {
            return Err(HdrError::from(format!(
                "linear frame has {} half-floats, expected {expected}",
                pixels.len()
            )));
        }
        Ok(Self {
            width,
            height,
            pixels,
            primaries,
            transfer,
            source_metadata: LinearSourceMetadata::default(),
        })
    }

    /// Attach source mastering/content-light metadata (preserved by adapters).
    pub fn with_source_metadata(mut self, metadata: LinearSourceMetadata) -> Self {
        self.source_metadata = metadata;
        self
    }

    /// Build a frame from f32 RGBA components (linear light).
    pub fn from_f32(
        width: u32,
        height: u32,
        components: &[f32],
        primaries: LinearPrimaries,
        transfer: LinearTransfer,
    ) -> Result<Self, HdrError> {
        let expected = width as usize * height as usize * 4;
        if components.len() != expected {
            return Err(HdrError::from(format!(
                "expected {expected} RGBA components, got {}",
                components.len()
            )));
        }
        let pixels = components
            .iter()
            .map(|value| f16::from_f32(*value).to_bits())
            .collect();
        Self::new(width, height, pixels, primaries, transfer)
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn half_bits(&self) -> &[u16] {
        &self.pixels
    }

    /// Decode to f32 RGBA components (linear light).
    pub fn to_f32(&self) -> Vec<f32> {
        self.pixels
            .iter()
            .map(|bits| f16::from_bits(*bits).to_f32())
            .collect()
    }

    /// One RGBA component at `(x, y)` in linear light.
    pub fn pixel(&self, x: u32, y: u32) -> Option<[f32; 4]> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let index = ((y as usize * self.width as usize) + x as usize) * 4;
        Some([
            f16::from_bits(self.pixels[index]).to_f32(),
            f16::from_bits(self.pixels[index + 1]).to_f32(),
            f16::from_bits(self.pixels[index + 2]).to_f32(),
            f16::from_bits(self.pixels[index + 3]).to_f32(),
        ])
    }

    /// Explicit SDR fallback. Not a production tone mapper: BT.2020→BT.709
    /// linear conversion, 203 cd/m² reference-white scaling, hard clip, then
    /// BT.709 OETF. `tone_mapped` stays false; callers must not claim HDR.
    pub fn to_sdr_rgba8(&self) -> SdrFallback {
        let mut rgba = vec![0_u8; self.width as usize * self.height as usize * 4];
        for (index, chunk) in rgba.chunks_mut(4).enumerate() {
            let base = index * 4;
            let linear_2020 = [
                f16::from_bits(self.pixels[base]).to_f32(),
                f16::from_bits(self.pixels[base + 1]).to_f32(),
                f16::from_bits(self.pixels[base + 2]).to_f32(),
            ];
            let linear_709 = bt2020_to_bt709(linear_2020);
            let white_nits = 203.0;
            for channel in 0..3 {
                let nits = (linear_709[channel].max(0.0) * 10_000.0).max(0.0);
                let normalised = (nits / white_nits).clamp(0.0, 1.0);
                chunk[channel] = (bt709_oetf(normalised) * 255.0).round() as u8;
            }
            let alpha = f16::from_bits(self.pixels[base + 3]).to_f32();
            chunk[3] = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        SdrFallback {
            frame: DecodedFrame::new(self.width, self.height, rgba, false),
            tone_mapped: false,
            mode: SdrFallbackMode::Clip,
        }
    }
}

/// How the SDR fallback handled out-of-range highlights.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SdrFallbackMode {
    /// Hard clip above 203 cd/m² (no tone map; defaults).
    Clip,
}

/// Result of [`LinearFrame::to_sdr_rgba8`].
#[derive(Clone, Debug, PartialEq)]
pub struct SdrFallback {
    pub frame: DecodedFrame,
    /// Always false for the clip fallback; kept explicit so callers cannot
    /// accidentally claim a tone-mapped HDR path.
    pub tone_mapped: bool,
    pub mode: SdrFallbackMode,
}

/// One full-frame linear layer.
#[derive(Clone, Copy, Debug)]
pub struct LinearLayer<'a> {
    pub frame: &'a LinearFrame,
    /// Straight-alpha multiplier in [0,1].
    pub opacity: f32,
}

/// Reference CPU linear compositor (RGBA16F in, RGBA16F out).
///
/// This is intentionally simple and deterministic: it composites full-frame
/// layers with source-over in scene-linear BT.2020. It exists to prove the frame
/// contract and feed the HDR10 export writer; the production wgpu compositor
/// remains RGBA8 until migrated.
#[derive(Clone, Copy, Debug)]
pub struct LinearCompositor {
    width: u32,
    height: u32,
}

impl LinearCompositor {
    pub fn new(width: u32, height: u32) -> Result<Self, HdrError> {
        if width == 0 || height == 0 {
            return Err(HdrError::from("compositor width/height must be > 0"));
        }
        Ok(Self { width, height })
    }

    pub fn composite(
        &self,
        background: [f32; 4],
        layers: &[LinearLayer<'_>],
    ) -> Result<LinearFrame, HdrError> {
        let mut dst = vec![0_f32; self.width as usize * self.height as usize * 4];
        for pixel in dst.chunks_mut(4) {
            pixel.copy_from_slice(&background);
        }
        for layer in layers {
            if layer.frame.width() != self.width || layer.frame.height() != self.height {
                return Err(HdrError::from(
                    "linear compositor currently requires full-frame layers",
                ));
            }
            if !(0.0..=1.0).contains(&layer.opacity) {
                return Err(HdrError::from("layer opacity must be in [0,1]"));
            }
            let src = layer.frame.to_f32();
            for (dst_pixel, src_pixel) in dst.chunks_mut(4).zip(src.chunks(4)) {
                let alpha = (src_pixel[3] * layer.opacity).clamp(0.0, 1.0);
                if alpha <= 0.0 {
                    continue;
                }
                for channel in 0..3 {
                    dst_pixel[channel] =
                        src_pixel[channel] * alpha + dst_pixel[channel] * (1.0 - alpha);
                }
                dst_pixel[3] = alpha + dst_pixel[3] * (1.0 - alpha);
            }
        }
        LinearFrame::from_f32(
            self.width,
            self.height,
            &dst,
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
    }
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

/// BT.709 OETF (SDR encoding); input/output in [0,1].
pub fn bt709_oetf(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    if value < 0.018 {
        4.5 * value
    } else {
        1.099 * value.powf(0.45) - 0.099
    }
}

/// PQ (SMPTE ST 2084) EOTF: normalised code in [0,1] → linear in [0,1]
/// where 1.0 == 10_000 cd/m².
pub fn pq_eotf(code: f32) -> f32 {
    const M1: f32 = 2610.0 / 16_384.0;
    const M2: f32 = (2523.0 / 4096.0) * 128.0;
    const C1: f32 = 3424.0 / 4096.0;
    const C2: f32 = (2413.0 / 4096.0) * 32.0;
    const C3: f32 = (2392.0 / 4096.0) * 32.0;
    let n = code.clamp(0.0, 1.0).powf(1.0 / M2);
    let numerator = (n - C1).max(0.0);
    let denominator = C2 - C3 * n;
    (numerator / denominator).max(0.0).powf(1.0 / M1)
}

/// Inverse PQ: linear [0,1] (1.0 == 10_000 cd/m²) → normalised code [0,1].
pub fn pq_inverse_eotf(linear: f32) -> f32 {
    const M1: f32 = 2610.0 / 16_384.0;
    const M2: f32 = (2523.0 / 4096.0) * 128.0;
    const C1: f32 = 3424.0 / 4096.0;
    const C2: f32 = (2413.0 / 4096.0) * 32.0;
    const C3: f32 = (2392.0 / 4096.0) * 32.0;
    let y = linear.max(0.0).powf(M1);
    ((C1 + C2 * y) / (1.0 + C3 * y)).powf(M2)
}

/// HDR10 mastering display (integers as written into the x265 `master-display`
/// token: chromaticity in 0.00002 units, luminance in 0.0001 cd/m² units).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MasteringDisplay {
    pub green: [u32; 2],
    pub blue: [u32; 2],
    pub red: [u32; 2],
    pub white: [u32; 2],
    pub max_luminance: u32,
    pub min_luminance: u32,
}

impl MasteringDisplay {
    /// HDR10 reference mastering display used by the Route B contract:
    /// BT.2020 primaries, D65, 1000 cd/m² peak, 0.0001 cd/m² black.
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

    /// x265 / HDR10 `master-display` token.
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

/// HDR10 output metadata policy (BT.2020/PQ + mastering + content light).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hdr10Metadata {
    pub mastering_display: MasteringDisplay,
    pub max_cll: u32,
    pub max_fall: u32,
}

impl Hdr10Metadata {
    pub fn new(
        mastering_display: MasteringDisplay,
        max_cll: u32,
        max_fall: u32,
    ) -> Result<Self, HdrError> {
        if max_cll == 0 || max_fall == 0 {
            return Err(HdrError::from("MaxCLL and MaxFALL must be > 0"));
        }
        if max_fall > max_cll {
            return Err(HdrError::from("MaxFALL must be <= MaxCLL"));
        }
        Ok(Self {
            mastering_display,
            max_cll,
            max_fall,
        })
    }

    /// Default 1000-nit mastering metadata for the synthetic proofs.
    pub fn reference_1000nit() -> Self {
        Self {
            mastering_display: MasteringDisplay::bt2020_1000nit(),
            max_cll: 1000,
            max_fall: 400,
        }
    }

    pub fn color_primaries(&self) -> &'static str {
        "bt2020"
    }

    pub fn color_transfer(&self) -> &'static str {
        "smpte2084"
    }

    pub fn color_matrix(&self) -> &'static str {
        "bt2020nc"
    }

    pub fn pixel_format(&self) -> &'static str {
        "yuv420p10le"
    }

    pub fn profile(&self) -> &'static str {
        "main10"
    }

    /// x265 `-x265-params` payload used by the export writer.
    pub fn x265_params(&self) -> String {
        format!(
            "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display={}:max-cll={},{}",
            self.mastering_display.x265_token(),
            self.max_cll,
            self.max_fall
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pq_round_trip() {
        for code in [0.0_f32, 0.1, 0.25, 0.5, 0.75, 0.9] {
            let linear = pq_eotf(code);
            let encoded = pq_inverse_eotf(linear);
            assert!(
                (encoded - code).abs() < 1e-5,
                "{code} -> {linear} -> {encoded}"
            );
        }
        assert!((pq_eotf(0.0)).abs() < 1e-9);
        assert!((pq_eotf(1.0) - 1.0).abs() < 1e-5);
        // PQ is not a plain gamma: 10% code is far below 10% light.
        assert!(pq_eotf(0.1) < 0.01);
    }

    #[test]
    fn linear_compositor_preserves_hdr_highlights() {
        let base = LinearFrame::from_f32(
            2,
            2,
            &[0.0, 0.0, 0.0, 1.0].repeat(4),
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let highlight = LinearFrame::from_f32(
            2,
            2,
            &[2.0, 4.0, 8.0, 1.0].repeat(4),
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let compositor = LinearCompositor::new(2, 2).unwrap();
        let close = |actual: [f32; 4], expected: [f32; 4]| {
            actual
                .iter()
                .zip(expected.iter())
                .all(|(a, e)| (a - e).abs() < 1e-3)
        };
        let out = compositor.composite([0.1, 0.2, 0.3, 1.0], &[]).unwrap();
        assert!(close(out.pixel(0, 0).unwrap(), [0.1, 0.2, 0.3, 1.0]));
        // A fully transparent layer must leave the background untouched.
        let out = compositor
            .composite(
                [0.1, 0.2, 0.3, 1.0],
                &[LinearLayer {
                    frame: &base,
                    opacity: 0.0,
                }],
            )
            .unwrap();
        assert!(close(out.pixel(0, 0).unwrap(), [0.1, 0.2, 0.3, 1.0]));
        // A 50% layer of a >SDR-white highlight must exceed 1.0 in linear space.
        let out = compositor
            .composite(
                [0.0, 0.0, 0.0, 1.0],
                &[LinearLayer {
                    frame: &highlight,
                    opacity: 0.5,
                }],
            )
            .unwrap();
        let pixel = out.pixel(0, 0).unwrap();
        assert!((pixel[0] - 1.0).abs() < 1e-3, "R={}", pixel[0]);
        assert!((pixel[1] - 2.0).abs() < 1e-3, "G={}", pixel[1]);
        assert!((pixel[2] - 4.0).abs() < 1e-3, "B={}", pixel[2]);
        assert_eq!(pixel[3], 1.0);
        // SDR fallback clips the same highlights and explicitly says it was not
        // tone-mapped.
        let fallback = out.to_sdr_rgba8();
        assert!(!fallback.tone_mapped);
        assert_eq!(fallback.mode, SdrFallbackMode::Clip);
        assert_eq!(fallback.frame.rgba[0], 255);
        assert_eq!(fallback.frame.rgba[1], 255);
        assert_eq!(fallback.frame.rgba[2], 255);
    }

    #[test]
    fn sdr_fallback_converts_bt2020_to_bt709_and_clips_reference_white() {
        // Pure BT.2020 green at 203 nits: 0.0203 * 10000 = 203 nits.
        let green = LinearFrame::from_f32(
            1,
            1,
            &[0.0, 0.0203, 0.0, 1.0],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let sdr = green.to_sdr_rgba8().frame;
        // BT.2020 green→BT.709 green is ~0.81, plus sRGB-ish OETF.
        assert!(sdr.rgba[1] > 200 && sdr.rgba[1] <= 255, "G={}", sdr.rgba[1]);
        assert!(sdr.rgba[0] < 40 && sdr.rgba[2] < 40);

        // Very dim linear light must remain a dark SDR value (no tone map).
        let dim = LinearFrame::from_f32(
            1,
            1,
            &[0.0001, 0.0001, 0.0001, 1.0],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let dim_sdr = dim.to_sdr_rgba8().frame;
        assert!(dim_sdr.rgba[0] > 0 && dim_sdr.rgba[0] < 40);
        assert!(!dim.to_sdr_rgba8().tone_mapped);
    }

    #[test]
    fn hdr10_metadata_policy_is_complete_and_validated() {
        let metadata = Hdr10Metadata::reference_1000nit();
        assert_eq!(metadata.pixel_format(), "yuv420p10le");
        assert_eq!(metadata.profile(), "main10");
        assert_eq!(metadata.color_primaries(), "bt2020");
        assert_eq!(metadata.color_transfer(), "smpte2084");
        assert_eq!(metadata.color_matrix(), "bt2020nc");
        let params = metadata.x265_params();
        assert!(params.contains("colorprim=bt2020"));
        assert!(params.contains("transfer=smpte2084"));
        assert!(params.contains("colormatrix=bt2020nc"));
        assert!(params.contains("master-display=G(13250,34500)"));
        assert!(params.contains("max-cll=1000,400"));
        assert!(Hdr10Metadata::new(metadata.mastering_display, 0, 0).is_err());
        assert!(Hdr10Metadata::new(metadata.mastering_display, 100, 400).is_err());
    }

    #[test]
    fn synthetic_pq_frames_composite_in_linear_space() {
        // Four PQ code bars (normalised code 0.1/0.4/0.7/0.95) decoded to
        // scene-linear via the PQ EOTF, then composited. This is the synthetic
        // PQ-frame proof for the linear path (the export-pro writer consumes
        // the same linear contract).
        let width = 8_u32;
        let height = 2_u32;
        let codes = [0.1_f32, 0.4, 0.7, 0.95];
        let mut components = vec![0.0_f32; width as usize * height as usize * 4];
        for y in 0..height {
            for x in 0..width {
                let bar = ((x as usize) * 4 / width as usize).min(3);
                let linear = pq_eotf(codes[bar]);
                let index = ((y as usize * width as usize) + x as usize) * 4;
                components[index] = linear;
                components[index + 1] = linear;
                components[index + 2] = linear;
                components[index + 3] = 1.0;
            }
        }
        let source = LinearFrame::from_f32(
            width,
            height,
            &components,
            LinearPrimaries::Bt2020,
            LinearTransfer::Pq,
        )
        .unwrap();
        let compositor = LinearCompositor::new(width, height).unwrap();
        let out = compositor
            .composite(
                [0.0, 0.0, 0.0, 1.0],
                &[LinearLayer {
                    frame: &source,
                    opacity: 1.0,
                }],
            )
            .unwrap();
        for (bar, code) in codes.iter().enumerate() {
            let x = (width as usize * (2 * bar + 1) / 8) as u32;
            let pixel = out.pixel(x, 1).unwrap();
            let expected = pq_eotf(*code);
            assert!(
                (pixel[0] - expected).abs() < 2e-3,
                "bar {bar}: {} vs {expected}",
                pixel[0]
            );
        }
        // The SDR fallback of the 4000-nit bar clips, while the linear frame
        // retains it above 0.0203 (SDR reference white).
        assert!(pq_eotf(0.95) > 0.0203);
        let fallback = out.to_sdr_rgba8();
        assert!(!fallback.tone_mapped);
        // Bar 3 centre (x=7) clips to white in the SDR fallback.
        assert_eq!(fallback.frame.rgba[(width as usize - 1) * 4], 255);
    }

    #[test]
    fn invalid_frames_and_layers_are_rejected() {
        assert!(LinearFrame::new(
            0,
            1,
            vec![],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear
        )
        .is_err());
        assert!(LinearFrame::new(
            1,
            1,
            vec![0; 3],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear
        )
        .is_err());
        assert!(LinearCompositor::new(0, 1).is_err());
        let frame = LinearFrame::from_f32(
            1,
            1,
            &[0.0; 4],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let compositor = LinearCompositor::new(1, 1).unwrap();
        assert!(compositor
            .composite(
                [0.0; 4],
                &[LinearLayer {
                    frame: &frame,
                    opacity: 1.5
                }]
            )
            .is_err());
        let small = LinearFrame::from_f32(
            2,
            2,
            &[0.0; 16],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        assert!(compositor
            .composite(
                [0.0; 4],
                &[LinearLayer {
                    frame: &small,
                    opacity: 1.0
                }]
            )
            .is_err());
    }
}
