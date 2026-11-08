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

use std::io::Write;

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

/// Affine transform of a linear layer in normalized canvas coordinates.
/// `center_x/center_y` are the layer centre; `width/height` are the layer's
/// normalized size; rotation is clockwise degrees. This mirrors the subset of
/// `opentake_domain::Transform` the HDR path supports.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerTransform {
    pub center_x: f64,
    pub center_y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation_degrees: f64,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
}

impl Default for LayerTransform {
    fn default() -> Self {
        Self {
            center_x: 0.5,
            center_y: 0.5,
            width: 1.0,
            height: 1.0,
            rotation_degrees: 0.0,
            flip_horizontal: false,
            flip_vertical: false,
        }
    }
}

/// One linear-path mask shape in normalized canvas coordinates. Rectangle,
/// ellipse, polygon and half-plane shapes are supported with feather/invert and
/// the same whole-mask offset/scale/rotation semantics as the domain mask.
#[derive(Clone, Debug, PartialEq)]
pub enum LayerMaskShape {
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Ellipse {
        center_x: f64,
        center_y: f64,
        radius_x: f64,
        radius_y: f64,
    },
    Polygon {
        points: Vec<(f64, f64)>,
    },
    Linear {
        point_x: f64,
        point_y: f64,
        normal_x: f64,
        normal_y: f64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct LayerMask {
    pub shape: LayerMaskShape,
    pub feather: f64,
    pub invert: bool,
    pub offset_x: f64,
    pub offset_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation_degrees: f64,
}

impl Default for LayerMask {
    fn default() -> Self {
        Self {
            shape: LayerMaskShape::Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            feather: 0.0,
            invert: false,
            offset_x: 0.0,
            offset_y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation_degrees: 0.0,
        }
    }
}

fn smoothstep01(edge0: f64, edge1: f64, value: f64) -> f64 {
    if (edge1 - edge0).abs() <= f64::EPSILON {
        return if value < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn polygon_signed_distance(points: &[(f64, f64)], x: f64, y: f64) -> f64 {
    if points.len() < 3 {
        return f64::INFINITY;
    }
    let mut inside = false;
    let mut min_edge = f64::INFINITY;
    let mut j = points.len() - 1;
    for i in 0..points.len() {
        let (xi, yi) = points[i];
        let (xj, yj) = points[j];
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        let dx = xj - xi;
        let dy = yj - yi;
        let len2 = dx * dx + dy * dy;
        let t = if len2 > f64::EPSILON {
            (((x - xi) * dx + (y - yi) * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let px = xi + t * dx;
        let py = yi + t * dy;
        min_edge = min_edge.min(((x - px).powi(2) + (y - py).powi(2)).sqrt());
        j = i;
    }
    if inside {
        -min_edge
    } else {
        min_edge
    }
}

impl LayerMask {
    fn local_point(&self, x: f64, y: f64) -> (f64, f64) {
        let sx = self.scale_x.abs().max(f64::EPSILON);
        let sy = self.scale_y.abs().max(f64::EPSILON);
        let radians = self.rotation_degrees.to_radians();
        let (sin, cos) = radians.sin_cos();
        let dx = x - 0.5 - self.offset_x;
        let dy = y - 0.5 - self.offset_y;
        let unrotated_x = cos * dx + sin * dy;
        let unrotated_y = -sin * dx + cos * dy;
        (unrotated_x / sx + 0.5, unrotated_y / sy + 0.5)
    }

    fn signed_distance(&self, x: f64, y: f64) -> f64 {
        let (x, y) = self.local_point(x, y);
        match &self.shape {
            LayerMaskShape::Rect {
                x: rx,
                y: ry,
                width,
                height,
            } => {
                let cx = rx + width * 0.5;
                let cy = ry + height * 0.5;
                let dx = (x - cx).abs() - width * 0.5;
                let dy = (y - cy).abs() - height * 0.5;
                let outside = (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt();
                outside + dx.max(dy).min(0.0)
            }
            LayerMaskShape::Ellipse {
                center_x,
                center_y,
                radius_x,
                radius_y,
            } => {
                let rx = radius_x.abs().max(f64::EPSILON);
                let ry = radius_y.abs().max(f64::EPSILON);
                let nx = (x - center_x) / rx;
                let ny = (y - center_y) / ry;
                ((nx * nx + ny * ny).sqrt() - 1.0) * rx.min(ry)
            }
            LayerMaskShape::Polygon { points } => polygon_signed_distance(points, x, y),
            LayerMaskShape::Linear {
                point_x,
                point_y,
                normal_x,
                normal_y,
            } => {
                let len = (normal_x * normal_x + normal_y * normal_y).sqrt();
                if len <= f64::EPSILON {
                    return 0.0;
                }
                -((x - point_x) * (normal_x / len) + (y - point_y) * (normal_y / len))
            }
        }
    }

    pub fn coverage(&self, x: f64, y: f64) -> f64 {
        let sd = self.signed_distance(x, y);
        let f = self.feather.max(0.0);
        let inside = if f <= f64::EPSILON {
            if sd <= 0.0 {
                1.0
            } else {
                0.0
            }
        } else {
            1.0 - smoothstep01(-f * 0.5, f * 0.5, sd)
        };
        if self.invert {
            1.0 - inside
        } else {
            inside
        }
    }
}

/// A transformed full-frame-resolution linear source layer.
#[derive(Clone, Debug)]
pub struct TransformedLinearLayer<'a> {
    pub frame: &'a LinearFrame,
    pub opacity: f32,
    pub transform: LayerTransform,
    /// All masks are intersected (coverage multiplied), matching the domain
    /// render plan's multiple-mask semantics.
    pub masks: Vec<LayerMask>,
}

/// Bilinear sample from a straight-alpha linear frame; outside = transparent.
fn sample_linear(frame: &LinearFrame, x: f64, y: f64) -> [f32; 4] {
    if x < 0.0 || y < 0.0 || x > (frame.width - 1) as f64 || y > (frame.height - 1) as f64 {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(frame.width - 1);
    let y1 = (y0 + 1).min(frame.height - 1);
    let tx = (x - x0 as f64) as f32;
    let ty = (y - y0 as f64) as f32;
    let p00 = frame.pixel(x0, y0).unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let p10 = frame.pixel(x1, y0).unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let p01 = frame.pixel(x0, y1).unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let p11 = frame.pixel(x1, y1).unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let mut out = [0.0f32; 4];
    for channel in 0..4 {
        let top = p00[channel] * (1.0 - tx) + p10[channel] * tx;
        let bottom = p01[channel] * (1.0 - tx) + p11[channel] * tx;
        out[channel] = top * (1.0 - ty) + bottom * ty;
    }
    out
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
        for layer in layers {
            if layer.frame.width() != self.width || layer.frame.height() != self.height {
                return Err(HdrError::from(
                    "linear compositor full-frame API requires full-frame layers",
                ));
            }
        }
        let transformed: Vec<TransformedLinearLayer<'_>> = layers
            .iter()
            .map(|layer| TransformedLinearLayer {
                frame: layer.frame,
                opacity: layer.opacity,
                transform: LayerTransform::default(),
                masks: Vec::new(),
            })
            .collect();
        self.composite_transformed(background, &transformed)
    }

    /// Composite affine-transformed layers in scene-linear BT.2020. Sampling is
    /// bilinear in linear light with straight-alpha source frames; the output is
    /// straight alpha (premultiplied only for blending internally).
    pub fn composite_transformed(
        &self,
        background: [f32; 4],
        layers: &[TransformedLinearLayer<'_>],
    ) -> Result<LinearFrame, HdrError> {
        let mut dst = vec![0_f32; self.width as usize * self.height as usize * 4];
        for pixel in dst.chunks_mut(4) {
            pixel.copy_from_slice(&background);
        }
        for layer in layers {
            if !(0.0..=1.0).contains(&layer.opacity) {
                return Err(HdrError::from("layer opacity must be in [0,1]"));
            }
            let transform = layer.transform;
            if !transform.width.is_finite()
                || !transform.height.is_finite()
                || transform.width <= 0.0
                || transform.height <= 0.0
                || !transform.center_x.is_finite()
                || !transform.center_y.is_finite()
                || !transform.rotation_degrees.is_finite()
            {
                return Err(HdrError::from("invalid layer transform"));
            }
            let rotation = transform.rotation_degrees.to_radians();
            let (sin_t, cos_t) = rotation.sin_cos();
            let frame_width = layer.frame.width() as f64;
            let frame_height = layer.frame.height() as f64;
            for py in 0..self.height {
                for px in 0..self.width {
                    let dx = (px as f64 + 0.5) - transform.center_x * self.width as f64;
                    let dy = (py as f64 + 0.5) - transform.center_y * self.height as f64;
                    // Inverse rotation, then normalize into the layer's local box.
                    let rx = dx * cos_t + dy * sin_t;
                    let ry = -dx * sin_t + dy * cos_t;
                    let mut lx = rx / (transform.width * self.width as f64) + 0.5;
                    let mut ly = ry / (transform.height * self.height as f64) + 0.5;
                    if transform.flip_horizontal {
                        lx = 1.0 - lx;
                    }
                    if transform.flip_vertical {
                        ly = 1.0 - ly;
                    }
                    if !(0.0..=1.0).contains(&lx) || !(0.0..=1.0).contains(&ly) {
                        continue;
                    }
                    let src = sample_linear(
                        layer.frame,
                        (lx * frame_width - 0.5).clamp(0.0, frame_width - 1.0),
                        (ly * frame_height - 0.5).clamp(0.0, frame_height - 1.0),
                    );
                    let mut mask_coverage = 1.0_f64;
                    if !layer.masks.is_empty() {
                        let nx = (px as f64 + 0.5) / self.width as f64;
                        let ny = (py as f64 + 0.5) / self.height as f64;
                        for mask in &layer.masks {
                            mask_coverage *= mask.coverage(nx, ny);
                        }
                    }
                    let alpha = (src[3] * layer.opacity * mask_coverage as f32).clamp(0.0, 1.0);
                    if alpha <= 0.0 {
                        continue;
                    }
                    let base = ((py as usize * self.width as usize) + px as usize) * 4;
                    for channel in 0..3 {
                        dst[base + channel] =
                            src[channel] * alpha + dst[base + channel] * (1.0 - alpha);
                    }
                    dst[base + 3] = alpha + dst[base + 3] * (1.0 - alpha);
                }
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

/// HLG inverse OETF (ARIB STD-B67). Input is the encoded `E'` in [0,1];
/// output is scene-linear in [0,1] relative to the HLG 1000-nit peak.
pub fn hlg_oetf_inverse(encoded: f32) -> f32 {
    const A: f32 = 0.178_832_77;
    const B: f32 = 1.0 - 4.0 * A;
    let encoded = encoded.clamp(0.0, 1.0);
    if encoded <= 0.5 {
        encoded * encoded / 3.0
    } else {
        (((encoded - (0.5 - A * (4.0 * A).ln())) / A).exp() + B) / 12.0
    }
}

/// HLG encoded value → scene-linear BT.2020 relative to the 10,000-nit PQ
/// contract. Policy: HLG peak (encoded 1.0) maps to 1,000 cd/m² = 0.1, so the
/// conversion is `hlg_oetf_inverse(value) * 1000/10000`.
pub fn hlg_to_linear_10k(encoded: f32) -> f32 {
    hlg_oetf_inverse(encoded) * 0.1
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

/// Production HDR10 output spec used by the addon/export orchestration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hdr10OutputSpec {
    pub out: String,
    pub width: u32,
    pub height: u32,
    pub fps: i32,
    pub crf: u8,
    pub preset: String,
    pub metadata: Hdr10Metadata,
}

impl Hdr10OutputSpec {
    pub fn validate(&self) -> Result<(), HdrError> {
        if self.out.trim().is_empty() {
            return Err(HdrError::from("HDR10 output path is empty"));
        }
        if self.width < 2 || self.height < 2 {
            return Err(HdrError::from("HDR10 width/height must be >= 2"));
        }
        if !self.width.is_multiple_of(2) || !self.height.is_multiple_of(2) {
            return Err(HdrError::from(
                "HDR10 yuv420p10le requires even width/height",
            ));
        }
        if self.fps <= 0 {
            return Err(HdrError::from("HDR10 fps must be positive"));
        }
        if self.crf > 51 {
            return Err(HdrError::from("HDR10 crf must be <= 51"));
        }
        Ok(())
    }

    /// ffmpeg argv for raw `yuv420p10le` stdin -> H.265 Main10 HDR10.
    pub fn encode_args(&self) -> Result<Vec<String>, HdrError> {
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

    pub fn frame_bytes(&self) -> usize {
        let y = self.width as usize * self.height as usize;
        let chroma = (self.width as usize / 2) * (self.height as usize / 2);
        (y + chroma * 2) * 2
    }
}

/// Convert one linear RGBA16F frame to raw `yuv420p10le` bytes.
pub fn linear_frame_to_yuv420p10le(frame: &LinearFrame) -> Result<Vec<u8>, HdrError> {
    if frame.width() % 2 != 0 || frame.height() % 2 != 0 {
        return Err(HdrError::from("HDR10 conversion requires even dimensions"));
    }
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    let source = frame.to_f32();
    let mut y_plane = vec![0_u16; width * height];
    let mut u_plane = vec![0_u16; (width / 2) * (height / 2)];
    let mut v_plane = vec![0_u16; (width / 2) * (height / 2)];
    let pq = |linear: f32| pq_inverse_eotf(linear.clamp(0.0, 1.0));
    let quant_y = |value: f32| (64.0 + value.clamp(0.0, 1.0) * 876.0).round() as u16;
    let quant_c = |value: f32| (512.0 + value.clamp(-0.5, 0.5) * 896.0).round() as u16;
    for py in 0..height {
        for px in 0..width {
            let base = (py * width + px) * 4;
            let rgb = [pq(source[base]), pq(source[base + 1]), pq(source[base + 2])];
            let luma = 0.262_7 * rgb[0] + 0.678_0 * rgb[1] + 0.059_3 * rgb[2];
            y_plane[py * width + px] = quant_y(luma);
            if px % 2 == 0 && py % 2 == 0 {
                let mut cb = 0.0;
                let mut cr = 0.0;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let sbase = ((py + dy) * width + px + dx) * 4;
                        let srgb = [
                            pq(source[sbase]),
                            pq(source[sbase + 1]),
                            pq(source[sbase + 2]),
                        ];
                        let sy = 0.262_7 * srgb[0] + 0.678_0 * srgb[1] + 0.059_3 * srgb[2];
                        cb += (srgb[2] - sy) / 1.881_4;
                        cr += (srgb[0] - sy) / 1.474_6;
                    }
                }
                u_plane[(py / 2) * (width / 2) + px / 2] = quant_c(cb / 4.0);
                v_plane[(py / 2) * (width / 2) + px / 2] = quant_c(cr / 4.0);
            }
        }
    }
    let mut bytes = Vec::with_capacity((y_plane.len() + u_plane.len() + v_plane.len()) * 2);
    for value in y_plane.iter().chain(u_plane.iter()).chain(v_plane.iter()) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(bytes)
}

/// Incremental HDR10 ffmpeg writer: start once, push linear frames, finish.
pub struct Hdr10Writer {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    spec: Hdr10OutputSpec,
    written: u64,
}

impl Hdr10Writer {
    pub fn start(spec: Hdr10OutputSpec) -> Result<Self, HdrError> {
        let args = spec.encode_args()?;
        let ffmpeg = std::env::var("OPENTAKE_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string());
        let mut child = std::process::Command::new(&ffmpeg)
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| HdrError::from(format!("spawn {ffmpeg}: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| HdrError::from("ffmpeg stdin unavailable"))?;
        Ok(Self {
            child,
            stdin,
            spec,
            written: 0,
        })
    }

    pub fn write_frame(&mut self, frame: &LinearFrame) -> Result<(), HdrError> {
        if frame.width() != self.spec.width || frame.height() != self.spec.height {
            return Err(HdrError::from(format!(
                "frame is {}x{}, expected {}x{}",
                frame.width(),
                frame.height(),
                self.spec.width,
                self.spec.height
            )));
        }
        let bytes = linear_frame_to_yuv420p10le(frame)?;
        if bytes.len() != self.spec.frame_bytes() {
            return Err(HdrError::from("HDR10 frame byte count mismatch"));
        }
        self.stdin
            .write_all(&bytes)
            .map_err(|error| HdrError::from(format!("write HDR10 frame: {error}")))?;
        self.written += 1;
        Ok(())
    }

    pub fn frame_count(&self) -> u64 {
        self.written
    }

    pub fn finish(self) -> Result<u64, HdrError> {
        drop(self.stdin);
        let output = self
            .child
            .wait_with_output()
            .map_err(|error| HdrError::from(format!("wait for ffmpeg: {error}")))?;
        if !output.status.success() {
            return Err(HdrError::from(format!(
                "ffmpeg exited {} after {} frames: {}",
                output.status,
                self.written,
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(self.written)
    }

    /// Abort the encoder and reap ffmpeg; caller removes the partial file.
    pub fn abort(mut self) {
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
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
    fn hdr10_writer_args_and_conversion_contract() {
        let spec = Hdr10OutputSpec {
            out: "/tmp/hdr10.mp4".into(),
            width: 64,
            height: 36,
            fps: 30,
            crf: 20,
            preset: "medium".into(),
            metadata: Hdr10Metadata::reference_1000nit(),
        };
        assert!(spec.validate().is_ok());
        assert_eq!(spec.frame_bytes(), (64 * 36 + 32 * 18 * 2) * 2);
        let args = spec.encode_args().unwrap();
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx265"]));
        assert!(args.windows(2).any(|pair| pair == ["-profile:v", "main10"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-pix_fmt", "yuv420p10le"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-color_primaries", "bt2020"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-color_trc", "smpte2084"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-colorspace", "bt2020nc"]));
        let params = args
            .windows(2)
            .find(|pair| pair[0] == "-x265-params")
            .map(|pair| pair[1].clone())
            .expect("x265 params");
        assert!(params.contains("master-display=G(13250,34500)"));
        assert!(params.contains("max-cll=1000,400"));

        let black = LinearFrame::from_f32(
            2,
            2,
            &[0.0; 16],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let black_raw = linear_frame_to_yuv420p10le(&black).unwrap();
        assert_eq!(black_raw.len(), (2 * 2 + 2) * 2);
        assert_eq!(u16::from_le_bytes([black_raw[0], black_raw[1]]), 64);
        let white = LinearFrame::from_f32(
            2,
            2,
            &[1.0, 1.0, 1.0, 1.0].repeat(4),
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let white_raw = linear_frame_to_yuv420p10le(&white).unwrap();
        assert_eq!(u16::from_le_bytes([white_raw[0], white_raw[1]]), 940);
        assert!(Hdr10OutputSpec { width: 65, ..spec }.validate().is_err());
    }

    #[test]
    fn transformed_layers_support_scale_offset_opacity_and_rotation() {
        // 2x2 source: top row red-ish, bottom row green-ish.
        let source = LinearFrame::from_f32(
            2,
            2,
            &[
                1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0,
            ],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let compositor = LinearCompositor::new(4, 4).unwrap();
        // Half-width layer at the left: outside the box must stay black.
        let out = compositor
            .composite_transformed(
                [0.0, 0.0, 0.0, 1.0],
                &[TransformedLinearLayer {
                    frame: &source,
                    opacity: 1.0,
                    transform: LayerTransform {
                        center_x: 0.25,
                        center_y: 0.5,
                        width: 0.5,
                        height: 1.0,
                        rotation_degrees: 0.0,
                        flip_horizontal: false,
                        flip_vertical: false,
                    },
                    masks: Vec::new(),
                }],
            )
            .unwrap();
        let inside = out.pixel(1, 1).unwrap();
        let outside = out.pixel(3, 1).unwrap();
        assert_eq!(outside, [0.0, 0.0, 0.0, 1.0]);
        assert!(inside[0] > 0.5 || inside[1] > 0.5, "inside={inside:?}");
        // 50% opacity over black halves the linear value.
        let out = compositor
            .composite_transformed(
                [0.0, 0.0, 0.0, 1.0],
                &[TransformedLinearLayer {
                    frame: &source,
                    opacity: 0.5,
                    transform: LayerTransform {
                        center_x: 0.5,
                        center_y: 0.5,
                        ..LayerTransform::default()
                    },
                    masks: Vec::new(),
                }],
            )
            .unwrap();
        let center = out.pixel(2, 2).unwrap();
        assert!(center[0] > 0.05 && center[0] < 0.8, "center={center:?}");
        // A 90° rotation still keeps the layer inside the canvas and composited.
        let out = compositor
            .composite_transformed(
                [0.0, 0.0, 0.0, 1.0],
                &[TransformedLinearLayer {
                    frame: &source,
                    opacity: 1.0,
                    transform: LayerTransform {
                        rotation_degrees: 90.0,
                        ..LayerTransform::default()
                    },
                    masks: Vec::new(),
                }],
            )
            .unwrap();
        assert!(out.to_f32().iter().any(|value| *value > 0.2));
    }

    #[test]
    fn linear_masks_support_rect_ellipse_polygon_feather_and_invert() {
        let ellipse = LayerMask {
            shape: LayerMaskShape::Ellipse {
                center_x: 0.5,
                center_y: 0.5,
                radius_x: 0.25,
                radius_y: 0.25,
            },
            ..LayerMask::default()
        };
        assert_eq!(ellipse.coverage(0.5, 0.5), 1.0);
        assert_eq!(ellipse.coverage(0.0, 0.0), 0.0);

        let rect = LayerMask {
            shape: LayerMaskShape::Rect {
                x: 0.25,
                y: 0.25,
                width: 0.5,
                height: 0.5,
            },
            ..LayerMask::default()
        };
        assert_eq!(rect.coverage(0.5, 0.5), 1.0);
        assert_eq!(rect.coverage(0.05, 0.05), 0.0);

        let polygon = LayerMask {
            shape: LayerMaskShape::Polygon {
                points: vec![(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)],
            },
            ..LayerMask::default()
        };
        assert_eq!(polygon.coverage(0.1, 0.1), 1.0);
        assert_eq!(polygon.coverage(0.9, 0.9), 0.0);

        let feathered = LayerMask {
            shape: LayerMaskShape::Rect {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
            feather: 0.2,
            ..LayerMask::default()
        };
        let edge = feathered.coverage(0.5, 0.5);
        assert!(edge > 0.2 && edge < 0.8, "edge={edge}");
        assert_eq!(feathered.coverage(0.1, 0.5), 1.0);

        let inverted = LayerMask {
            shape: LayerMaskShape::Rect {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
            invert: true,
            ..LayerMask::default()
        };
        assert_eq!(inverted.coverage(0.1, 0.5), 0.0);
        assert_eq!(inverted.coverage(0.9, 0.5), 1.0);
    }

    #[test]
    fn hlg_inverse_oetf_is_monotonic_and_maps_peak_to_1000_nits() {
        assert!((hlg_oetf_inverse(0.0)).abs() < 1e-6);
        assert!((hlg_oetf_inverse(1.0) - 1.0).abs() < 1e-4);
        assert!((hlg_to_linear_10k(1.0) - 0.1).abs() < 1e-5);
        let mut previous = 0.0;
        for step in 0..=100 {
            let value = hlg_oetf_inverse(step as f32 / 100.0);
            assert!(
                value >= previous - 1e-6,
                "step {step}: {value} < {previous}"
            );
            previous = value;
        }
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
