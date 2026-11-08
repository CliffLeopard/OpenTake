//! HDR detection, tone-map backend probe and delivery policy.
//!
//! ## Why this is a policy module, not an HDR pipeline
//!
//! The current Rust engine composites through a wgpu path whose output frames
//! are **RGBA8 SDR**: `opentake-media::color` converts PQ/HLG sources to BT.709
//! *while decoding* (`hdr_tonemap_filter`, VideoToolbox `scale_vt` or software
//! `zscale`), so every composited frame is already display-referred SDR. There
//! is no 16-bit linear/HDR frame available to the encoder today.
//!
//! Consequences, which this module encodes explicitly:
//! - **10-bit encoding works** for SDR frames (see [`crate::codec`]); it adds
//!   precision/banding headroom, not dynamic range.
//! - **HDR passthrough is not available** until the compositor produces HDR
//!   frames. [`HdrPolicy::allow_hdr_passthrough`] can be set, but
//!   [`decide`] refuses it unless the caller also declares an HDR-capable
//!   compositor.
//! - **HDR tone-map is a decode-stage step** in the current engine. When a
//!   tone-map backend is present, `decide` returns the exact filter chain the
//!   decoder must run (the same chains as `opentake-media::color`) and marks the
//!   decision `tone_mapped = true`. When no backend is present it says so.
//!
//! The standalone `tone-map` CLI subcommand applies the returned chain to a
//! direct HDR source, which is how the prototype proves the backend can change
//! pixels; that is evidence for the *policy*, not a claim that the composited
//! export path is already HDR.

use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::codec::ColorTags;

/// Colour signalling of one source, mirroring
/// `opentake_domain::MediaColorMetadata` (kept as own type so the prototype has
/// no workspace dependency; the mapping is one struct literal).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceColorMetadata {
    pub primaries: Option<String>,
    pub transfer: Option<String>,
    pub matrix: Option<String>,
    pub range: Option<String>,
}

impl SourceColorMetadata {
    /// PQ/HLG transfer functions declare HDR content.
    pub fn is_hdr(&self) -> bool {
        self.transfer.as_deref().is_some_and(|transfer| {
            matches!(
                transfer.to_ascii_lowercase().as_str(),
                "smpte2084" | "pq" | "arib-std-b67" | "hlg"
            )
        })
    }

    /// Normalised transfer token used by [`tone_map_filter`].
    pub fn transfer_token(&self) -> Option<&'static str> {
        match self.transfer.as_deref()?.to_ascii_lowercase().as_str() {
            "smpte2084" | "pq" => Some("smpte2084"),
            "arib-std-b67" | "hlg" => Some("arib-std-b67"),
            _ => None,
        }
    }
}

/// Which HDR→SDR converter the local ffmpeg exposes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToneMapBackend {
    /// macOS VideoToolbox (`scale_vt`); performs the EDR→SDR conversion in the
    /// hardware scaler with system defaults (no tunable curve).
    VideoToolbox,
    /// Software zscale + `tonemap` (Möbius). Not present in the local ffmpeg
    /// 9.0.2 build but supported by the policy.
    Zscale,
    /// No HDR conversion filter in this ffmpeg build.
    Unsupported,
}

impl ToneMapBackend {
    /// Probe `ffmpeg -filters` for a usable converter.
    pub fn detect(ffmpeg_bin: &str) -> Self {
        let output = Command::new(ffmpeg_bin)
            .args(["-hide_banner", "-filters"])
            .output();
        match output {
            Ok(output) => {
                let mut listing = String::from_utf8_lossy(&output.stdout).into_owned();
                listing.push_str(&String::from_utf8_lossy(&output.stderr));
                Self::parse_filter_listing(&listing)
            }
            Err(_) => ToneMapBackend::Unsupported,
        }
    }

    /// Parse an `ffmpeg -filters` listing. VideoToolbox is only selected on
    /// macOS; `scale_vt` is otherwise meaningless.
    pub fn parse_filter_listing(listing: &str) -> Self {
        let has = |expected: &str| {
            listing.lines().any(|line| {
                let mut fields = line.split_whitespace();
                let _flags = fields.next();
                fields.next() == Some(expected)
            })
        };
        if cfg!(target_os = "macos") && has("scale_vt") {
            ToneMapBackend::VideoToolbox
        } else if has("zscale") {
            ToneMapBackend::Zscale
        } else {
            ToneMapBackend::Unsupported
        }
    }
}

/// Where tone-mapping must happen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToneMapStage {
    /// No conversion needed (SDR source, or HDR passthrough selected).
    None,
    /// Decode-time conversion (the current engine path: HDR source → SDR RGBA8
    /// compositor, mirroring `opentake-media::color`).
    Decode,
    /// Encode-stage conversion (only meaningful for an HDR-capable compositor
    /// that chose SDR delivery).
    Encode,
}

/// What the deliverable carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Deliverable {
    /// SDR BT.709, 8-bit.
    Sdr8,
    /// SDR BT.709, 10-bit (precision headroom only, not HDR).
    Sdr10,
    /// HDR10: BT.2020/PQ 10-bit with mastering metadata. Requires an HDR
    /// compositor; not produced by the current engine.
    Hdr10,
}

/// Policy switches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HdrPolicy {
    /// Prefer 10-bit SDR delivery when the source is SDR (safe: same pixels,
    /// more precision).
    pub prefer_10bit_sdr: bool,
    /// Permit HDR10 passthrough when the compositor is HDR-capable.
    pub allow_hdr_passthrough: bool,
    /// HDR10 mastering display string (only used for passthrough).
    pub mastering_display: Option<String>,
    /// HDR10 MaxCLL (only used for passthrough).
    pub max_cll: Option<u32>,
    /// HDR10 MaxFALL (only used for passthrough).
    pub max_fall: Option<u32>,
}

impl Default for HdrPolicy {
    fn default() -> Self {
        HdrPolicy {
            prefer_10bit_sdr: true,
            allow_hdr_passthrough: false,
            mastering_display: None,
            max_cll: None,
            max_fall: None,
        }
    }
}

/// What the compositor can hand the encoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompositorCapability {
    /// Current engine: RGBA8 SDR frames only.
    SdrRgba8,
    /// A future linear/HDR frame path.
    HdrLinear16,
}

/// The decision returned to the export orchestrator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HdrDecision {
    pub source_is_hdr: bool,
    pub source_transfer: Option<String>,
    pub compositor: CompositorCapability,
    pub deliverable: Deliverable,
    pub bit_depth: u8,
    pub tone_map_backend: ToneMapBackend,
    pub tone_map_stage: ToneMapStage,
    /// Decode/encode filter chain when [`ToneMapStage`] is not `None`.
    pub tone_map_filter: Option<String>,
    /// True only when a real converter was selected; this is the claim boundary.
    pub tone_mapped: bool,
    pub color: ColorTags,
    /// ffmpeg stream colour args for the chosen deliverable.
    pub stream_args: Vec<String>,
    /// `-x265-params` colour/VUI extras (HDR10 only).
    pub x265_params: Vec<String>,
    pub notes: Vec<String>,
}

/// The exact VideoToolbox decode→SDR filter chain used by the current engine
/// (`opentake-media::color::hdr_tonemap_filter`).
pub const VIDEOTOOLBOX_TONEMAP_FILTER: &str =
    "scale_vt=w=iw:h=ih:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le";

/// The software zscale + Möbius tone-map chain (same shape as
/// `opentake-media::color`); requires an ffmpeg built with `--enable-libzimg`.
pub const ZSCALE_TONEMAP_FILTER: &str =
    "zscale=pin=bt2020:tin={transfer}:min=bt2020nc:rin=limited:t=linear:npl=100,format=gbrpf32le,tonemap=mobius:param=0.3:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=limited";

/// Resolve the tone-map filter for a source transfer and backend, or `None`
/// when the backend cannot convert. Never interpolates untrusted strings except
/// the fixed PQ/HLG token from [`SourceColorMetadata::transfer_token`].
pub fn tone_map_filter(transfer: &str, backend: ToneMapBackend) -> Option<String> {
    let input_transfer = match transfer.to_ascii_lowercase().as_str() {
        "smpte2084" | "pq" => "smpte2084",
        "arib-std-b67" | "hlg" => "arib-std-b67",
        _ => return None,
    };
    match backend {
        ToneMapBackend::VideoToolbox => Some(VIDEOTOOLBOX_TONEMAP_FILTER.to_string()),
        ToneMapBackend::Zscale => Some(ZSCALE_TONEMAP_FILTER.replace("{transfer}", input_transfer)),
        ToneMapBackend::Unsupported => None,
    }
}

/// Decide the delivery policy for one source/compositor combination.
///
/// The honest claim boundary lives here: `tone_mapped` is true only when a real
/// converter was selected. A 10-bit SDR deliverable never sets it.
pub fn decide(
    source: &SourceColorMetadata,
    compositor: CompositorCapability,
    policy: &HdrPolicy,
    backend: ToneMapBackend,
) -> HdrDecision {
    let mut notes = Vec::new();
    let source_is_hdr = source.is_hdr();
    let source_transfer = source.transfer.clone();

    if !source_is_hdr {
        let ten_bit = policy.prefer_10bit_sdr;
        let deliverable = if ten_bit {
            Deliverable::Sdr10
        } else {
            Deliverable::Sdr8
        };
        notes.push(
            "SDR source: no tone-map required; 10-bit delivery adds precision, not dynamic range."
                .to_string(),
        );
        return finalize(
            source_is_hdr,
            source_transfer,
            compositor,
            deliverable,
            if ten_bit { 10 } else { 8 },
            backend,
            ToneMapStage::None,
            None,
            false,
            ColorTags::bt709(),
            Vec::new(),
            notes,
        );
    }

    // HDR source from an SDR compositor: conversion must happen while decoding,
    // before the frames become RGBA8. This mirrors opentake-media::color.
    if compositor == CompositorCapability::SdrRgba8 {
        let filter = source
            .transfer_token()
            .and_then(|transfer| tone_map_filter(transfer, backend));
        match filter {
            Some(filter) => {
                notes.push(
                    "HDR source: tone-map at decode time (before the SDR RGBA8 compositor), matching opentake-media::color; the encoder receives SDR frames."
                        .to_string(),
                );
                if backend == ToneMapBackend::VideoToolbox {
                    notes.push(
                        "VideoToolbox uses system EDR→SDR defaults; curve/peak are not tunable in this build."
                            .to_string(),
                    );
                }
                let ten_bit = policy.prefer_10bit_sdr;
                finalize(
                    true,
                    source_transfer,
                    compositor,
                    if ten_bit {
                        Deliverable::Sdr10
                    } else {
                        Deliverable::Sdr8
                    },
                    if ten_bit { 10 } else { 8 },
                    backend,
                    ToneMapStage::Decode,
                    Some(filter),
                    true,
                    ColorTags::bt709(),
                    Vec::new(),
                    notes,
                )
            }
            None => {
                notes.push(
                    "HDR source but this FFmpeg build exposes no tone-map converter: pixels will be clipped/misinterpreted. 10-bit encoding alone does NOT make this HDR."
                        .to_string(),
                );
                finalize(
                    true,
                    source_transfer,
                    compositor,
                    if policy.prefer_10bit_sdr {
                        Deliverable::Sdr10
                    } else {
                        Deliverable::Sdr8
                    },
                    if policy.prefer_10bit_sdr { 10 } else { 8 },
                    backend,
                    ToneMapStage::Decode,
                    None,
                    false,
                    ColorTags::bt709(),
                    Vec::new(),
                    notes,
                )
            }
        }
    } else {
        // HDR-capable compositor.
        if policy.allow_hdr_passthrough {
            notes.push(
                "HDR10 passthrough selected: 10-bit BT.2020/PQ with mastering metadata. This requires the future HDR compositor; the current engine cannot supply it."
                    .to_string(),
            );
            finalize(
                true,
                source_transfer,
                compositor,
                Deliverable::Hdr10,
                10,
                backend,
                ToneMapStage::None,
                None,
                false,
                ColorTags::bt2020_pq(),
                hdr10_x265_params(policy),
                notes,
            )
        } else {
            let filter = source
                .transfer_token()
                .and_then(|transfer| tone_map_filter(transfer, backend));
            let tone_mapped = filter.is_some();
            notes.push(if tone_mapped {
                "HDR-capable compositor but SDR delivery requested: tone-map before encode.".to_string()
            } else {
                "HDR-capable compositor, SDR delivery requested, but no tone-map backend; output is not tone-mapped."
                    .to_string()
            });
            finalize(
                true,
                source_transfer,
                compositor,
                if policy.prefer_10bit_sdr {
                    Deliverable::Sdr10
                } else {
                    Deliverable::Sdr8
                },
                if policy.prefer_10bit_sdr { 10 } else { 8 },
                backend,
                ToneMapStage::Encode,
                filter,
                tone_mapped,
                ColorTags::bt709(),
                Vec::new(),
                notes,
            )
        }
    }
}

/// Build the HDR10 `-x265-params` colour/VUI extras.
fn hdr10_x265_params(policy: &HdrPolicy) -> Vec<String> {
    let mut params = vec![
        "colorprim=bt2020".to_string(),
        "transfer=smpte2084".to_string(),
        "colormatrix=bt2020nc".to_string(),
    ];
    if let Some(display) = &policy.mastering_display {
        params.push(format!("master-display={display}"));
    }
    if let Some(cll) = policy.max_cll {
        params.push(format!("max-cll={cll},{}", policy.max_fall.unwrap_or(cll)));
    }
    params
}

#[allow(clippy::too_many_arguments)]
fn finalize(
    source_is_hdr: bool,
    source_transfer: Option<String>,
    compositor: CompositorCapability,
    deliverable: Deliverable,
    bit_depth: u8,
    backend: ToneMapBackend,
    stage: ToneMapStage,
    filter: Option<String>,
    tone_mapped: bool,
    color: ColorTags,
    x265_params: Vec<String>,
    notes: Vec<String>,
) -> HdrDecision {
    HdrDecision {
        source_is_hdr,
        source_transfer,
        compositor,
        deliverable,
        bit_depth,
        tone_map_backend: backend,
        tone_map_stage: stage,
        tone_map_filter: filter,
        tone_mapped,
        stream_args: color.stream_args(),
        x265_params,
        color,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pq_source() -> SourceColorMetadata {
        SourceColorMetadata {
            primaries: Some("bt2020".into()),
            transfer: Some("smpte2084".into()),
            matrix: Some("bt2020nc".into()),
            range: Some("tv".into()),
        }
    }

    #[test]
    fn pq_and_hlg_are_detected() {
        assert!(pq_source().is_hdr());
        assert!(SourceColorMetadata {
            transfer: Some("arib-std-b67".into()),
            ..Default::default()
        }
        .is_hdr());
        assert!(!SourceColorMetadata {
            transfer: Some("bt709".into()),
            ..Default::default()
        }
        .is_hdr());
    }

    #[test]
    fn sdr_source_never_claims_hdr_or_tone_map() {
        let decision = decide(
            &SourceColorMetadata {
                transfer: Some("bt709".into()),
                ..Default::default()
            },
            CompositorCapability::SdrRgba8,
            &HdrPolicy::default(),
            ToneMapBackend::VideoToolbox,
        );
        assert_eq!(decision.deliverable, Deliverable::Sdr10);
        assert!(!decision.tone_mapped);
        assert_eq!(decision.tone_map_stage, ToneMapStage::None);
        assert!(decision.tone_map_filter.is_none());
        assert_eq!(decision.color, ColorTags::bt709());
    }

    #[test]
    fn hdr_from_sdr_compositor_tone_maps_at_decode_with_videotoolbox() {
        let decision = decide(
            &pq_source(),
            CompositorCapability::SdrRgba8,
            &HdrPolicy::default(),
            ToneMapBackend::VideoToolbox,
        );
        assert!(decision.source_is_hdr);
        assert_eq!(decision.deliverable, Deliverable::Sdr10);
        assert_eq!(decision.tone_map_stage, ToneMapStage::Decode);
        assert!(decision.tone_mapped);
        assert_eq!(
            decision.tone_map_filter.as_deref(),
            Some(VIDEOTOOLBOX_TONEMAP_FILTER)
        );
    }

    #[test]
    fn hdr_without_backend_is_explicitly_not_tone_mapped() {
        let decision = decide(
            &pq_source(),
            CompositorCapability::SdrRgba8,
            &HdrPolicy::default(),
            ToneMapBackend::Unsupported,
        );
        assert!(!decision.tone_mapped);
        assert!(decision.tone_map_filter.is_none());
        assert!(decision
            .notes
            .iter()
            .any(|note| note.contains("does NOT make this HDR")));
    }

    #[test]
    fn hdr_passthrough_requires_hdr_compositor() {
        let mut policy = HdrPolicy {
            allow_hdr_passthrough: true,
            ..HdrPolicy::default()
        };
        policy.mastering_display = Some("G(1,2)B(3,4)R(5,6)WP(7,8)L(1000,1)".into());
        policy.max_cll = Some(1000);
        policy.max_fall = Some(400);

        let sdr_compositor = decide(
            &pq_source(),
            CompositorCapability::SdrRgba8,
            &policy,
            ToneMapBackend::Unsupported,
        );
        assert_eq!(sdr_compositor.deliverable, Deliverable::Sdr10);
        assert!(!sdr_compositor.tone_mapped);

        let hdr_compositor = decide(
            &pq_source(),
            CompositorCapability::HdrLinear16,
            &policy,
            ToneMapBackend::Unsupported,
        );
        assert_eq!(hdr_compositor.deliverable, Deliverable::Hdr10);
        assert_eq!(hdr_compositor.bit_depth, 10);
        assert_eq!(hdr_compositor.color, ColorTags::bt2020_pq());
        assert!(hdr_compositor
            .x265_params
            .iter()
            .any(|param| param.starts_with("master-display=")));
        assert!(hdr_compositor
            .x265_params
            .iter()
            .any(|param| param == "max-cll=1000,400"));
    }

    #[test]
    fn zscale_chain_carries_the_input_transfer() {
        let filter = tone_map_filter("hlg", ToneMapBackend::Zscale).expect("zscale chain");
        assert!(filter.contains("tin=arib-std-b67"));
        assert!(filter.contains("tonemap=mobius"));
    }

    #[test]
    fn filter_listing_probe_prefers_videotoolbox_on_macos() {
        let listing = " .S. scale_vt V->V Scale Videotoolbox frames\n .SC zscale V->V Apply resizing";
        let selected = ToneMapBackend::parse_filter_listing(listing);
        if cfg!(target_os = "macos") {
            assert_eq!(selected, ToneMapBackend::VideoToolbox);
        } else {
            assert_eq!(selected, ToneMapBackend::Zscale);
        }
        assert_eq!(
            ToneMapBackend::parse_filter_listing(" .. scale V->V Scale video"),
            ToneMapBackend::Unsupported
        );
    }
}
