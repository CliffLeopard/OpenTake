//! Node-API boundary for the OpenTake Rust engine.
//!
//! This is the Route B spike: the DSH Host loads this addon in-process and
//! drives the same `opentake-core::AppCore` the desktop app uses. The first
//! milestone exposes project lifecycle + timeline snapshots; editing commands
//! will be added by extracting the Tauri `EditRequest` serde mirror into a
//! reusable crate.

use napi::bindgen_prelude::*;

mod edit_request;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use edit_request::EditRequest;
use napi_derive::napi;
use opentake_core::dto::{
    handle_get_timeline, handle_project_new, handle_project_open, handle_project_save,
    EditResultDto, TimelineSnapshotDto,
};
use opentake_core::session::ProbedMedia;
use opentake_domain::{
    AudioDenoise, ClipType, ColorGrade, CubeLut, DenoiseMode, LutReference,
    MaskShape as DomainMaskShape, MediaColorMetadata, MediaManifestEntry, MediaSource,
};
use opentake_media::analysis::{
    analyze_loudness, analyze_stabilization, denoise_interleaved, track_translation_motion,
    LoudnessNormalizationConfig, StabilizationConfig,
};
use opentake_media::decode::pcm::{PcmBuffer, PcmFormat, PcmSpec};
use opentake_media::encode::{mix_clips, ClipAudio, MIX_SAMPLE_RATE};
use opentake_media::frame::RgbaFrame;
use opentake_media::library::{FavoriteRequest, LibraryStore};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use opentake_media::search::OrtEmbedder as SiglipEmbedder;
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
use opentake_media::search::TractEmbedder as SiglipEmbedder;
use opentake_media::search::{
    config as search_config, embed_store,
    embedder::Embedder,
    indexer::{index_image, index_video, needs_index, CancelToken},
    model_download, ranker, SamplerOptions,
};
use opentake_media::MediaCancelToken;
use opentake_render::{
    gpu::{
        upload_rgba, Compositor, CosmicTextRasterizer, GpuTexture, RenderDevice, TextRasterRequest,
        TextRasterizer, TextureResolver,
    },
    hdr::{
        hlg_to_linear_10k, pq_eotf, Hdr10Metadata, Hdr10OutputSpec, Hdr10Writer, LayerMask,
        LayerMaskShape, LayerTransform, LinearCompositor, LinearFrame, LinearPrimaries,
        LinearTransfer, TransformedLinearLayer,
    },
    plan::{try_build_render_plan, RenderSize, TextureSource},
    source::{DecodedFrame, SourceMetrics},
};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::path::{Path as FsPath, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|error| Error::from_reason(error.to_string()))
}

fn resolve_media_path(
    entry: &MediaManifestEntry,
    project_dir: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    match &entry.source {
        MediaSource::External { absolute_path } => Some(std::path::PathBuf::from(absolute_path)),
        MediaSource::Project { relative_path } => project_dir.map(|root| root.join(relative_path)),
    }
}

fn lottie_document_bytes(path: &std::path::Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("lottie"))
    {
        return Some(bytes);
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).ok()?;
        let name = file.name().to_ascii_lowercase();
        if file.is_file() && name.starts_with("animations/") && name.ends_with(".json") {
            let mut json = Vec::new();
            std::io::Read::read_to_end(&mut file, &mut json).ok()?;
            return Some(json);
        }
    }
    None
}

fn lottie_probe(path: &std::path::Path) -> Option<ProbedMedia> {
    let bytes = lottie_document_bytes(path)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let width = value.get("w")?.as_i64()? as i32;
    let height = value.get("h")?.as_i64()? as i32;
    let frame_rate = value.get("fr")?.as_f64()?.max(1.0);
    let start = value
        .get("ip")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let end = value
        .get("op")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(frame_rate);
    Some(ProbedMedia {
        duration_secs: ((end - start) / frame_rate).max(0.0),
        width: Some(width),
        height: Some(height),
        fps: Some(frame_rate),
        has_audio: false,
        color: None,
    })
}

fn probe_to_probed(path: &std::path::Path) -> Option<ProbedMedia> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension.as_deref() == Some("json") || extension.as_deref() == Some("lottie") {
        return lottie_probe(path);
    }
    let probe = opentake_media::probe(path).ok()?;
    Some(ProbedMedia {
        duration_secs: probe.duration_secs,
        width: probe.width.map(|width| width as i32),
        height: probe.height.map(|height| height as i32),
        fps: probe.fps,
        has_audio: probe.has_audio,
        color: probe.color,
    })
}

fn media_list_json(core: &opentake_core::AppCore) -> serde_json::Value {
    let manifest = core.media();
    let project_dir = core.project_dir();
    let items: Vec<serde_json::Value> = manifest
        .entries
        .iter()
        .map(|entry| {
            let resolved = resolve_media_path(entry, project_dir.as_deref());
            let path = resolved.as_ref().map(|path| path.to_string_lossy().into_owned());
            let missing = resolved.as_ref().is_none_or(|path| !path.exists());
            let proxy_path = entry.proxy.as_ref().and_then(|proxy| {
                project_dir.as_deref().map(|root| root.join(&proxy.relative_path).to_string_lossy().into_owned())
            });
            let kind = serde_json::to_value(entry.kind).unwrap_or(serde_json::Value::Null);
            serde_json::json!({
                "id": entry.id,
                "name": entry.name,
                "type": kind,
                "duration": entry.duration,
                "width": entry.source_width,
                "height": entry.source_height,
                "sourceFps": entry.source_fps,
                "hasAudio": entry.has_audio.unwrap_or(false),
                "color": entry.color,
                "isHdr": entry.color.as_ref().is_some_and(|color| color.is_hdr()),
                "path": path,
                "proxyPath": proxy_path,
                "proxyWidth": entry.proxy.as_ref().map(|proxy| proxy.width),
                "proxyHeight": entry.proxy.as_ref().map(|proxy| proxy.height),
                "thumbnail": null,
                "folderId": entry.folder_id,
                "fileSize": resolved.as_ref().and_then(|path| std::fs::metadata(path).ok()).map(|meta| meta.len()),
                "generationInput": entry.generation_input,
                "generationStatus": "none",
                "generationProgress": null,
                "generationErrorCode": null,
                "missing": missing,
                "favorite": manifest.is_favorite(&entry.id),
            })
        })
        .collect();
    let folders: Vec<serde_json::Value> = manifest
        .folders
        .iter()
        .map(|folder| {
            serde_json::json!({
                "id": folder.id,
                "name": folder.name,
                "parentFolderId": folder.parent_folder_id,
            })
        })
        .collect();
    serde_json::json!({ "items": items, "folders": folders, "skipped": [], "prewarm": [] })
}

struct ManifestMetrics {
    sizes: HashMap<String, (u32, u32)>,
    straight_alpha: HashSet<String>,
}

impl SourceMetrics for ManifestMetrics {
    fn natural_size(&self, media_ref: &str) -> Option<(u32, u32)> {
        self.sizes.get(media_ref).copied()
    }

    fn needs_premultiply(&self, media_ref: &str) -> bool {
        self.straight_alpha.contains(media_ref)
    }
}

struct LottieState {
    documents: HashMap<std::path::PathBuf, velato::Composition>,
    scene_renderer: velato::Renderer,
    gpu_renderer: Option<velato::vello::Renderer>,
}

impl LottieState {
    fn new() -> Self {
        Self {
            documents: HashMap::new(),
            scene_renderer: velato::Renderer::new(),
            gpu_renderer: None,
        }
    }

    fn resolve(
        &mut self,
        device: &opentake_render::wgpu::Device,
        queue: &opentake_render::wgpu::Queue,
        path: &std::path::Path,
        source_frame: i64,
        render_box: (u32, u32),
    ) -> Option<Rc<GpuTexture>> {
        if !self.documents.contains_key(path) {
            let bytes = lottie_document_bytes(path)?;
            let composition = std::panic::catch_unwind(|| velato::Composition::from_slice(&bytes))
                .ok()?
                .ok()?;
            self.documents.insert(path.to_path_buf(), composition);
        }
        let composition = self.documents.get(path)?;
        let frame_count =
            ((composition.frames.end - composition.frames.start).ceil() as i64).max(1);
        let internal_frame = source_frame.rem_euclid(frame_count);
        let max_width = render_box.0.max(1) as f64;
        let max_height = render_box.1.max(1) as f64;
        let scale = (max_width / composition.width as f64)
            .min(max_height / composition.height as f64)
            .min(1.0);
        let width = ((composition.width as f64 * scale).round() as u32).max(1);
        let height = ((composition.height as f64 * scale).round() as u32).max(1);
        let transform = velato::vello::kurbo::Affine::scale_non_uniform(
            width as f64 / composition.width as f64,
            height as f64 / composition.height as f64,
        );
        let frame = composition.frames.start + internal_frame as f64;
        let scene = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.scene_renderer
                .render(composition, frame, transform, 1.0)
        }))
        .ok()?;
        if self.gpu_renderer.is_none() {
            self.gpu_renderer = Some(
                velato::vello::Renderer::new(
                    device,
                    velato::vello::RendererOptions {
                        surface_format: None,
                        use_cpu: false,
                        antialiasing_support: velato::vello::AaSupport::area_only(),
                        num_init_threads: NonZeroUsize::new(1),
                    },
                )
                .ok()?,
            );
        }
        let texture = device.create_texture(&opentake_render::wgpu::TextureDescriptor {
            label: Some("route-b-lottie"),
            size: opentake_render::wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: opentake_render::wgpu::TextureDimension::D2,
            format: opentake_render::wgpu::TextureFormat::Rgba8Unorm,
            usage: opentake_render::wgpu::TextureUsages::STORAGE_BINDING
                | opentake_render::wgpu::TextureUsages::TEXTURE_BINDING
                | opentake_render::wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&opentake_render::wgpu::TextureViewDescriptor::default());
        self.gpu_renderer
            .as_mut()?
            .render_to_texture(
                device,
                queue,
                &scene,
                &view,
                &velato::vello::RenderParams {
                    base_color: velato::vello::peniko::color::palette::css::TRANSPARENT,
                    width,
                    height,
                    antialiasing_method: velato::vello::AaConfig::Area,
                },
            )
            .ok()?;
        Some(Rc::new(GpuTexture {
            texture,
            view,
            width,
            height,
        }))
    }
}

struct TextInfo {
    content: String,
    style: opentake_domain::TextStyle,
    box_norm: (f64, f64, f64, f64),
}

struct RenderCache {
    device: RenderDevice,
    compositor: Compositor,
    media: opentake_media::MediaEngine,
    text: CosmicTextRasterizer,
    lottie: LottieState,
}

thread_local! {
    static RENDER_CACHE: RefCell<Option<Box<RenderCache>>> = const { RefCell::new(None) };
}

impl RenderCache {
    fn get_or_init() -> std::result::Result<(), String> {
        RENDER_CACHE.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_none() {
                let device = RenderDevice::try_new().map_err(|error| error.to_string())?;
                let compositor = Compositor::new(&device.device);
                let cache = std::env::temp_dir().join("opentake-route-b").join("cache");
                let media = opentake_media::MediaEngine::new(&cache, cache.join("models"));
                *slot = Some(Box::new(RenderCache {
                    device,
                    compositor,
                    media,
                    text: CosmicTextRasterizer::new(),
                    lottie: LottieState::new(),
                }));
            }
            Ok(())
        })
    }
}

struct BasicResolver<'a> {
    device: &'a opentake_render::wgpu::Device,
    queue: &'a opentake_render::wgpu::Queue,
    engine: &'a opentake_media::MediaEngine,
    text: &'a HashMap<String, TextInfo>,
    text_rasterizer: &'a CosmicTextRasterizer,
    lottie: &'a mut LottieState,
    canvas: (u32, u32),
    media: &'a HashMap<String, (std::path::PathBuf, bool)>,
    timeline_fps: i32,
    cache: HashMap<String, Rc<GpuTexture>>,
}

impl TextureResolver for BasicResolver<'_> {
    fn resolve(&mut self, source: &TextureSource, source_frame: i64) -> Option<Rc<GpuTexture>> {
        let (media_ref, is_image) = match source {
            TextureSource::Decoded { media_ref } => (media_ref, false),
            TextureSource::Image { media_ref } => (media_ref, true),
            TextureSource::Text { clip_id } => {
                let info = self.text.get(clip_id)?;
                let key = format!("t:{clip_id}");
                if let Some(texture) = self.cache.get(&key) {
                    return Some(texture.clone());
                }
                let frame = self.text_rasterizer.rasterize(&TextRasterRequest {
                    clip_id,
                    content: &info.content,
                    style: &info.style,
                    box_norm: info.box_norm,
                    canvas: self.canvas,
                })?;
                let texture = Rc::new(upload_rgba(
                    self.device,
                    self.queue,
                    &frame,
                    false,
                    Some("route-b-text"),
                ));
                self.cache.insert(key, texture.clone());
                return Some(texture);
            }
            TextureSource::Lottie { media_ref } => {
                let (path, _) = self.media.get(media_ref)?;
                return self.lottie.resolve(
                    self.device,
                    self.queue,
                    path,
                    source_frame,
                    self.canvas,
                );
            }
        };
        let (path, _) = self.media.get(media_ref)?;
        let key = format!("{media_ref}:{source_frame}:{is_image}");
        if let Some(texture) = self.cache.get(&key) {
            return Some(texture.clone());
        }
        let decoded = if is_image {
            opentake_media::thumbnail::image_thumbnail(path, 512).ok()?
        } else {
            let time_secs = source_frame as f64 / f64::from(self.timeline_fps.max(1));
            self.engine
                .decode_frame(
                    path,
                    &opentake_media::decode::FrameRequest {
                        time_secs,
                        max_size: (0, 0),
                        tolerance_secs: 0.1,
                        apply_rotation: true,
                    },
                )
                .ok()?
                .1
        };
        let frame = DecodedFrame::new(decoded.width, decoded.height, decoded.rgba, false);
        let texture = Rc::new(upload_rgba(
            self.device,
            self.queue,
            &frame,
            false,
            Some("route-b-preview"),
        ));
        self.cache.insert(key, texture.clone());
        Some(texture)
    }
}

fn composite_frame_decoded(
    core: &opentake_core::AppCore,
    frame: i32,
    render_size: RenderSize,
    transparent: bool,
) -> std::result::Result<DecodedFrame, String> {
    let snapshot = core.get_timeline();
    let timeline = &snapshot.timeline;
    let manifest = core.media();
    let project_dir = core.project_dir();
    let mut sizes = HashMap::new();
    let mut straight_alpha = HashSet::new();
    let mut media = HashMap::new();
    for entry in &manifest.entries {
        if let (Some(width), Some(height)) = (entry.source_width, entry.source_height) {
            if width > 0 && height > 0 {
                sizes.insert(entry.id.clone(), (width as u32, height as u32));
            }
        }
        if entry.carries_straight_alpha() {
            straight_alpha.insert(entry.id.clone());
        }
        if let Some(path) = resolve_media_path(entry, project_dir.as_deref()) {
            media.insert(entry.id.clone(), (path, entry.kind == ClipType::Image));
        }
    }
    let mut text = HashMap::new();
    for track in &timeline.tracks {
        for clip in &track.clips {
            if clip.media_type != ClipType::Text {
                continue;
            }
            let (Some(content), Some(style)) = (&clip.text_content, &clip.text_style) else {
                continue;
            };
            let top_left = clip.transform.top_left();
            text.insert(
                clip.id.clone(),
                TextInfo {
                    content: content.clone(),
                    style: style.clone(),
                    box_norm: (
                        top_left.x,
                        top_left.y,
                        clip.transform.width,
                        clip.transform.height,
                    ),
                },
            );
        }
    }
    let metrics = ManifestMetrics {
        sizes,
        straight_alpha,
    };
    let plan = try_build_render_plan(timeline, render_size, &metrics)?;
    let mut frame_plan = plan.frame(timeline, frame);
    if transparent {
        frame_plan.clear_rgba = [0.0, 0.0, 0.0, 0.0];
    }
    RenderCache::get_or_init()?;
    RENDER_CACHE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let cache = slot
            .as_mut()
            .ok_or_else(|| "render cache unavailable".to_string())?;
        let mut resolver = BasicResolver {
            device: &cache.device.device,
            queue: &cache.device.queue,
            engine: &cache.media,
            text: &text,
            text_rasterizer: &cache.text,
            lottie: &mut cache.lottie,
            canvas: (render_size.width, render_size.height),
            media: &media,
            timeline_fps: timeline.fps,
            cache: HashMap::new(),
        };
        cache
            .compositor
            .render_to_rgba(
                &cache.device.device,
                &cache.device.queue,
                render_size,
                &frame_plan,
                &mut resolver,
            )
            .map_err(|error| error.to_string())
    })
}

fn composite_frame_json(
    core: &opentake_core::AppCore,
    frame: i32,
    max_size: Option<u32>,
) -> std::result::Result<serde_json::Value, String> {
    let timeline = core.get_timeline().timeline;
    let longest = max_size.unwrap_or(960).max(2);
    let scale = (longest as f64 / timeline.width.max(1) as f64)
        .min(longest as f64 / timeline.height.max(1) as f64)
        .min(1.0);
    let render_size = RenderSize::new(
        ((timeline.width as f64 * scale).round() as u32).max(2),
        ((timeline.height as f64 * scale).round() as u32).max(2),
    );
    let rendered = composite_frame_decoded(core, frame, render_size, false)?;
    let image = image::RgbaImage::from_raw(rendered.width, rendered.height, rendered.rgba)
        .ok_or_else(|| "composite produced an invalid RGBA buffer".to_string())?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    use base64::Engine as _;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    );
    Ok(
        serde_json::json!({ "width": rendered.width, "height": rendered.height, "dataUrl": data_url }),
    )
}

fn fill_audio<T: Copy>(
    data: &mut [T],
    channels: usize,
    device_rate: u32,
    source_rate: f64,
    start_sample: usize,
    sample_len: usize,
    samples: &[f32],
    position: &AtomicU64,
    convert: impl Fn(f32) -> T + Copy,
) {
    let frames = data.len() / channels.max(1);
    let played = position.fetch_add(frames as u64, Ordering::AcqRel);
    for frame in 0..frames {
        let absolute = played as f64 + frame as f64;
        let source_index = start_sample as f64 + (absolute * source_rate / device_rate as f64);
        let sample = if source_index >= 0.0 && (source_index as usize) < sample_len {
            samples[source_index as usize]
        } else {
            0.0
        };
        let value = convert(sample);
        for channel in 0..channels {
            data[frame * channels + channel] = value;
        }
    }
}

fn collect_audio_clips(
    timeline: &opentake_domain::Timeline,
    frame_offset: i32,
    depth: u32,
    media_entries: &[MediaManifestEntry],
    project_dir: Option<&std::path::Path>,
    out: &mut Vec<ClipAudio>,
) {
    if depth > 8 {
        return;
    }
    for track in &timeline.tracks {
        if track.muted {
            continue;
        }
        for clip in &track.clips {
            if let Some(sequence_id) = clip.nested_sequence_id.as_deref() {
                if let Some(sequence) = timeline
                    .nested_sequences
                    .iter()
                    .find(|sequence| sequence.id == sequence_id)
                {
                    collect_audio_clips(
                        &sequence.timeline,
                        frame_offset + clip.start_frame.max(0),
                        depth + 1,
                        media_entries,
                        project_dir,
                        out,
                    );
                }
                continue;
            }
            if clip.media_type != ClipType::Audio {
                continue;
            }
            let Some(entry) = media_entries
                .iter()
                .find(|entry| entry.id == clip.media_ref)
            else {
                continue;
            };
            let Some(path) = resolve_media_path(entry, project_dir) else {
                continue;
            };
            let fps = timeline.fps.max(1) as f64;
            let start_secs = clip.trim_start_frame.max(0) as f64 / fps;
            let end_secs = start_secs + clip.duration_frames.max(1) as f64 / fps;
            let spec = PcmSpec {
                sample_rate: MIX_SAMPLE_RATE,
                channels: 1,
                format: PcmFormat::F32,
            };
            let Ok(pcm) = opentake_media::extract_pcm(&path, &spec, Some((start_secs, end_secs)))
            else {
                continue;
            };
            if pcm.samples_f32.is_empty() {
                continue;
            }
            let start_frame = frame_offset + clip.start_frame.max(0);
            let start_sample =
                ((start_frame as f64 / fps) * f64::from(MIX_SAMPLE_RATE)).round() as usize;
            let sample_count = pcm.samples_f32.len();
            let fade_in_samples = ((clip.fade_in_frames.max(0) as f64 / fps)
                * f64::from(MIX_SAMPLE_RATE))
            .round() as usize;
            let fade_out_samples = ((clip.fade_out_frames.max(0) as f64 / fps)
                * f64::from(MIX_SAMPLE_RATE))
            .round() as usize;
            let gains = if fade_in_samples == 0
                && fade_out_samples == 0
                && (clip.volume - 1.0).abs() < f64::EPSILON
            {
                Vec::new()
            } else {
                (0..sample_count)
                    .map(|index| {
                        let fade_in = if fade_in_samples == 0 {
                            1.0
                        } else {
                            (index as f64 / fade_in_samples as f64).clamp(0.0, 1.0)
                        };
                        let remaining = sample_count.saturating_sub(1).saturating_sub(index);
                        let fade_out = if fade_out_samples == 0 {
                            1.0
                        } else {
                            (remaining as f64 / fade_out_samples as f64).clamp(0.0, 1.0)
                        };
                        (clip.volume * fade_in * fade_out) as f32
                    })
                    .collect()
            };
            out.push(ClipAudio {
                start_sample,
                samples: pcm.samples_f32,
                gains,
            });
        }
    }
}

fn collect_audio_clips_with_roles(
    timeline: &opentake_domain::Timeline,
    frame_offset: i32,
    depth: u32,
    media_entries: &[MediaManifestEntry],
    project_dir: Option<&std::path::Path>,
    out: &mut Vec<(ClipAudio, bool)>,
) {
    if depth > 8 {
        return;
    }
    for track in &timeline.tracks {
        if track.muted {
            continue;
        }
        for clip in &track.clips {
            if let Some(sequence_id) = clip.nested_sequence_id.as_deref() {
                if let Some(sequence) = timeline
                    .nested_sequences
                    .iter()
                    .find(|sequence| sequence.id == sequence_id)
                {
                    collect_audio_clips_with_roles(
                        &sequence.timeline,
                        frame_offset + clip.start_frame.max(0),
                        depth + 1,
                        media_entries,
                        project_dir,
                        out,
                    );
                }
                continue;
            }
            if clip.media_type != ClipType::Audio {
                continue;
            }
            let Some(entry) = media_entries
                .iter()
                .find(|entry| entry.id == clip.media_ref)
            else {
                continue;
            };
            let Some(path) = resolve_media_path(entry, project_dir) else {
                continue;
            };
            let fps = timeline.fps.max(1) as f64;
            let start_secs = clip.trim_start_frame.max(0) as f64 / fps;
            let end_secs = start_secs + clip.duration_frames.max(1) as f64 / fps;
            let spec = PcmSpec {
                sample_rate: MIX_SAMPLE_RATE,
                channels: 1,
                format: PcmFormat::F32,
            };
            let Ok(pcm) = opentake_media::extract_pcm(&path, &spec, Some((start_secs, end_secs)))
            else {
                continue;
            };
            if pcm.samples_f32.is_empty() {
                continue;
            }
            let start_frame = frame_offset + clip.start_frame.max(0);
            let start_sample =
                ((start_frame as f64 / fps) * f64::from(MIX_SAMPLE_RATE)).round() as usize;
            let sample_count = pcm.samples_f32.len();
            let fade_in_samples = ((clip.fade_in_frames.max(0) as f64 / fps)
                * f64::from(MIX_SAMPLE_RATE))
            .round() as usize;
            let fade_out_samples = ((clip.fade_out_frames.max(0) as f64 / fps)
                * f64::from(MIX_SAMPLE_RATE))
            .round() as usize;
            let gains = if fade_in_samples == 0
                && fade_out_samples == 0
                && (clip.volume - 1.0).abs() < f64::EPSILON
            {
                Vec::new()
            } else {
                (0..sample_count)
                    .map(|index| {
                        let fade_in = if fade_in_samples == 0 {
                            1.0
                        } else {
                            (index as f64 / fade_in_samples as f64).clamp(0.0, 1.0)
                        };
                        let remaining = sample_count.saturating_sub(1).saturating_sub(index);
                        let fade_out = if fade_out_samples == 0 {
                            1.0
                        } else {
                            (remaining as f64 / fade_out_samples as f64).clamp(0.0, 1.0)
                        };
                        (clip.volume * fade_in * fade_out) as f32
                    })
                    .collect()
            };
            // Linked A/V audio is treated as voice; standalone audio as music.
            let is_voice = clip.link_group_id.is_some();
            out.push((
                ClipAudio {
                    start_sample,
                    samples: pcm.samples_f32,
                    gains,
                },
                is_voice,
            ));
        }
    }
}

struct NativePlayback {
    stream: cpal::Stream,
    position: Arc<AtomicU64>,
    sample_rate: u32,
    fps: i32,
    start_frame: i32,
    paused: bool,
}

/// HDR10 output metadata policy used by the Route B production path. The
/// mastering/content-light values are policy defaults until content analysis
/// derives per-project values.
fn hdr10_output_metadata() -> Hdr10Metadata {
    Hdr10Metadata::reference_1000nit()
}

fn hdr_source_ffmpeg() -> String {
    std::env::var("OPENTAKE_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// Decode one HDR PQ source frame directly to a scene-linear RGBA16F frame.
///
/// This deliberately bypasses `opentake_media::decode`, which tone-maps HDR
/// sources to SDR RGBA8 for the normal preview/export path. The source is
/// decoded to 16-bit RGBA code values in the PQ domain (no transfer-function
/// conversion), then linearised here with the PQ EOTF. The HDR10 writer applies
/// the inverse PQ at output time, so the round-trip is explicit.
fn decode_hdr_linear_frame(
    path: &FsPath,
    time_secs: f64,
    width: u32,
    height: u32,
    transfer: &str,
) -> std::result::Result<LinearFrame, String> {
    let filter = format!(
        "scale=w={width}:h={height}:force_original_aspect_ratio=decrease,         pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgba64le"
    );
    let output = StdCommand::new(hdr_source_ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{time_secs:.6}"),
            "-i",
            &path.to_string_lossy(),
            "-frames:v",
            "1",
            "-vf",
            &filter,
            "-pix_fmt",
            "rgba64le",
            "-f",
            "rawvideo",
            "-",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("decode HDR source: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "HDR decode failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let expected = width as usize * height as usize * 8;
    if output.stdout.len() < expected {
        return Err(format!(
            "HDR decode returned {} bytes, expected {expected}",
            output.stdout.len()
        ));
    }
    let is_hlg = transfer == "arib-std-b67" || transfer == "hlg";
    let to_linear = |encoded: f32| {
        if is_hlg {
            hlg_to_linear_10k(encoded)
        } else {
            pq_eotf(encoded)
        }
    };
    let mut components = Vec::with_capacity(width as usize * height as usize * 4);
    for chunk in output.stdout[..expected].chunks_exact(8) {
        let r = u16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 65_535.0;
        let g = u16::from_le_bytes([chunk[2], chunk[3]]) as f32 / 65_535.0;
        let b = u16::from_le_bytes([chunk[4], chunk[5]]) as f32 / 65_535.0;
        components.extend_from_slice(&[to_linear(r), to_linear(g), to_linear(b), 1.0]);
    }
    LinearFrame::from_f32(
        width,
        height,
        &components,
        LinearPrimaries::Bt2020,
        LinearTransfer::Linear,
    )
    .map_err(|error| error.to_string())
}

/// BT.709 OETF inverse for SDR RGBA8 overlays.
fn srgb8_to_linear(value: u8) -> f32 {
    let v = value as f32 / 255.0;
    if v < 0.081 {
        v / 4.5
    } else {
        ((v + 0.099) / 1.099).powf(1.0 / 0.45)
    }
}

/// BT.709 linear RGB → BT.2020 linear RGB (inverse of the BT.2087 matrix).
fn bt709_to_bt2020(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb;
    [
        0.627_404 * r + 0.329_286 * g + 0.043_310 * b,
        0.069_097 * r + 0.919_540 * g + 0.011_363 * b,
        0.016_391 * r + 0.088_013 * g + 0.895_596 * b,
    ]
}

/// Convert an SDR RGBA8 layer (sRGB / BT.709 primaries) to scene-linear
/// BT.2020 RGBA16F. `1.0` SDR white maps to 203 cd/m² (BT.2408 reference white)
/// relative to the 10,000 cd/m² PQ peak: linear = OETF^-1(encoded) * 203/10000.
/// The frame is explicitly marked linear; this is not an HDR source claim.
fn sdr_rgba8_to_linear_frame(
    frame: &RgbaFrame,
    premultiplied: bool,
) -> std::result::Result<LinearFrame, String> {
    let mut components = Vec::with_capacity(frame.rgba.len());
    for chunk in frame.rgba.chunks_exact(4) {
        let alpha = chunk[3] as f32 / 255.0;
        let mut rgb = [0.0_f32; 3];
        for (channel, value) in chunk.iter().take(3).enumerate() {
            let mut encoded = *value as f32 / 255.0;
            if premultiplied && alpha > 0.0 {
                encoded /= alpha;
            }
            rgb[channel] = srgb8_to_linear((encoded.clamp(0.0, 1.0) * 255.0) as u8);
        }
        let rgb_2020 = bt709_to_bt2020(rgb);
        let scale = 203.0 / 10_000.0;
        components.extend_from_slice(&[
            rgb_2020[0] * scale,
            rgb_2020[1] * scale,
            rgb_2020[2] * scale,
            alpha,
        ]);
    }
    LinearFrame::from_f32(
        frame.width,
        frame.height,
        &components,
        LinearPrimaries::Bt2020,
        LinearTransfer::Linear,
    )
    .map_err(|error| error.to_string())
}

fn hdr_layer_masks(masks: &[opentake_domain::Mask]) -> Vec<LayerMask> {
    masks
        .iter()
        .map(|mask| {
            let shape = match &mask.shape {
                DomainMaskShape::Circle { center, radius } => LayerMaskShape::Ellipse {
                    center_x: center.x,
                    center_y: center.y,
                    radius_x: radius.x,
                    radius_y: radius.y,
                },
                DomainMaskShape::Poly { points } => LayerMaskShape::Polygon {
                    points: points.iter().map(|point| (point.x, point.y)).collect(),
                },
                DomainMaskShape::Linear { point, normal } => LayerMaskShape::Linear {
                    point_x: point.x,
                    point_y: point.y,
                    normal_x: normal.x,
                    normal_y: normal.y,
                },
            };
            LayerMask {
                shape,
                feather: mask.feather,
                invert: mask.invert,
                offset_x: mask.transform.offset.x,
                offset_y: mask.transform.offset.y,
                scale_x: mask.transform.scale.x,
                scale_y: mask.transform.scale.y,
                rotation_degrees: mask.transform.rotation_degrees,
            }
        })
        .collect()
}

fn sample_cube_lut(lut: &CubeLut, rgb: [f32; 3]) -> [f32; 3] {
    let size = lut.size().max(2);
    let n = (size - 1) as f32;
    let scaled = [
        (rgb[0].clamp(0.0, 1.0) * n),
        (rgb[1].clamp(0.0, 1.0) * n),
        (rgb[2].clamp(0.0, 1.0) * n),
    ];
    let lo = [
        scaled[0].floor() as usize,
        scaled[1].floor() as usize,
        scaled[2].floor() as usize,
    ];
    let hi = [
        (lo[0] + 1).min(size as usize - 1),
        (lo[1] + 1).min(size as usize - 1),
        (lo[2] + 1).min(size as usize - 1),
    ];
    let t = [
        scaled[0] - lo[0] as f32,
        scaled[1] - lo[1] as f32,
        scaled[2] - lo[2] as f32,
    ];
    let table = lut.table();
    let at = |r: usize, g: usize, b: usize| {
        let index = (b * size as usize + g) * size as usize + r;
        table.get(index).copied().unwrap_or([0.0, 0.0, 0.0])
    };
    let mut out = [0.0_f32; 3];
    for channel in 0..3 {
        let c000 = at(lo[0], lo[1], lo[2])[channel];
        let c100 = at(hi[0], lo[1], lo[2])[channel];
        let c010 = at(lo[0], hi[1], lo[2])[channel];
        let c110 = at(hi[0], hi[1], lo[2])[channel];
        let c001 = at(lo[0], lo[1], hi[2])[channel];
        let c101 = at(hi[0], lo[1], hi[2])[channel];
        let c011 = at(lo[0], hi[1], hi[2])[channel];
        let c111 = at(hi[0], hi[1], hi[2])[channel];
        let c00 = c000 * (1.0 - t[0]) + c100 * t[0];
        let c10 = c010 * (1.0 - t[0]) + c110 * t[0];
        let c01 = c001 * (1.0 - t[0]) + c101 * t[0];
        let c11 = c011 * (1.0 - t[0]) + c111 * t[0];
        let c0 = c00 * (1.0 - t[1]) + c10 * t[1];
        let c1 = c01 * (1.0 - t[1]) + c11 * t[1];
        out[channel] = c0 * (1.0 - t[2]) + c1 * t[2];
    }
    out
}

/// Basic unbounded linear grade for HDR: exposure, approximate temperature/tint,
/// contrast around the 0.18 SDR-relative pivot, and saturation. Unlike
/// `ColorGrade::apply_linear`, this does not clamp to [0,1], so HDR highlights
/// above SDR white survive. Lift/gamma/gain and secondary qualifiers are not
/// applied in the HDR path yet.
fn apply_basic_linear_grade(rgb: [f64; 3], grade: &ColorGrade) -> [f64; 3] {
    let exposure = if grade.exposure != 0.0 {
        2.0_f64.powf(grade.exposure)
    } else {
        1.0
    };
    let warm = grade.temperature.clamp(-1.0, 1.0);
    let tint = grade.tint.clamp(-1.0, 1.0);
    let mut rgb = [
        rgb[0] * exposure * (1.0 + 0.15 * warm),
        rgb[1] * exposure * (1.0 - 0.10 * tint),
        rgb[2] * exposure * (1.0 - 0.15 * warm),
    ];
    if grade.contrast != 0.0 {
        let pivot = 0.18;
        let slope = 1.0 + grade.contrast;
        for channel in &mut rgb {
            *channel = (*channel - pivot) * slope + pivot;
        }
    }
    if (grade.saturation - 1.0).abs() > f64::EPSILON {
        let luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        for channel in &mut rgb {
            *channel = luma + (*channel - luma) * grade.saturation;
        }
    }
    rgb
}

/// Apply the supported linear color pipeline: primary grade and project 3D LUT.
/// The grade/LUT operate in SDR-white-relative linear space (203 cd/m² = 1.0),
/// then the result is mapped back to the 10,000-nit linear contract. LUT input
/// is clamped to the [0,1] cube domain; values above SDR white stay in the
/// surrounding linear signal but cannot be represented by the LUT.
fn apply_linear_color_pipeline(
    frame: &LinearFrame,
    grade: Option<&ColorGrade>,
    lut: Option<&LutReference>,
    project_dir: Option<&FsPath>,
) -> std::result::Result<LinearFrame, String> {
    if grade.is_none() && lut.is_none() {
        return Ok(frame.clone());
    }
    let cube = if let Some(reference) = lut {
        let base =
            project_dir.ok_or_else(|| "project directory unavailable for LUT".to_string())?;
        let path = base.join(reference.relative_path());
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("read LUT {}: {error}", path.display()))?;
        Some((
            CubeLut::parse(&bytes).map_err(|error| error.to_string())?,
            reference.intensity.clamp(0.0, 1.0),
        ))
    } else {
        None
    };
    const SDR_WHITE: f64 = 203.0 / 10_000.0;
    let mut components = Vec::with_capacity(frame.width() as usize * frame.height() as usize * 4);
    for y in 0..frame.height() {
        for x in 0..frame.width() {
            let pixel = frame.pixel(x, y).unwrap_or([0.0, 0.0, 0.0, 0.0]);
            let mut rgb = [
                f64::from(pixel[0]) / SDR_WHITE,
                f64::from(pixel[1]) / SDR_WHITE,
                f64::from(pixel[2]) / SDR_WHITE,
            ];
            if let Some(grade) = grade {
                rgb = apply_basic_linear_grade(rgb, grade);
            }
            if let Some((cube, intensity)) = &cube {
                let lut_out = sample_cube_lut(cube, [rgb[0] as f32, rgb[1] as f32, rgb[2] as f32]);
                for channel in 0..3 {
                    let mixed = rgb[channel] * (1.0 - f64::from(*intensity))
                        + f64::from(lut_out[channel]) * f64::from(*intensity);
                    rgb[channel] = mixed;
                }
            }
            components.extend_from_slice(&[
                (rgb[0] * SDR_WHITE) as f32,
                (rgb[1] * SDR_WHITE) as f32,
                (rgb[2] * SDR_WHITE) as f32,
                pixel[3],
            ]);
        }
    }
    LinearFrame::from_f32(
        frame.width(),
        frame.height(),
        &components,
        LinearPrimaries::Bt2020,
        LinearTransfer::Linear,
    )
    .map_err(|error| error.to_string())
}

/// Preflight for the HDR10 production path: reject false-HDR before spawning
/// the encoder. Every visible visual layer in the exported range must be an
/// HDR PQ video layer in the supported subset (static affine transform/opacity
/// allowed; crops/masks/effects/grades/LUTs/keying/transitions/reverse/keyframe
/// tracks and non-video overlays rejected). Audio clips are allowed and mixed
/// separately. At least one HDR video layer must be present, so an SDR-only
/// timeline can never be tagged HDR10.
fn validate_hdr10_timeline(
    core: &opentake_core::AppCore,
    start_frame: i32,
    end_frame: i32,
) -> std::result::Result<(), String> {
    let snapshot = core.get_timeline();
    let timeline = &snapshot.timeline;
    let manifest = core.media();
    let mut hdr_video_layers = 0usize;
    for track in timeline.tracks.iter().filter(|track| !track.hidden) {
        for clip in &track.clips {
            let clip_start = clip.start_frame;
            let clip_end = clip_start + clip.duration_frames;
            if clip_end <= start_frame || clip_start >= end_frame {
                continue;
            }
            if clip.media_type == ClipType::Audio {
                continue;
            }
            if clip.nested_sequence_id.is_some() {
                return Err("HDR10 export does not support nested sequences yet".to_string());
            }
            if !clip.effects.is_empty()
                || clip.stabilization.is_some()
                || clip.chroma_key.is_some()
                || clip.transition_out.is_some()
                || clip.reversed
            {
                return Err(
                    "HDR10 export supports crop, affine/keyframe/opacity, basic masks, SDR text/image overlays and basic grades/LUTs; effects/keying/transitions/reverse/nested sequences are not supported yet"
                        .to_string(),
                );
            }
            match clip.media_type {
                ClipType::Video => {
                    let entry = manifest
                        .entries
                        .iter()
                        .find(|entry| entry.id == clip.media_ref)
                        .ok_or_else(|| format!("HDR source media not found: {}", clip.media_ref))?;
                    let color = entry.color.as_ref().ok_or_else(|| {
                        format!(
                            "HDR10 export requires source color metadata for {}",
                            entry.name
                        )
                    })?;
                    if !color.is_hdr() {
                        return Err(format!(
                            "HDR10 export requires HDR sources; {} is SDR",
                            entry.name
                        ));
                    }
                    let transfer = color
                        .transfer
                        .as_deref()
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if transfer != "smpte2084"
                        && transfer != "pq"
                        && transfer != "arib-std-b67"
                        && transfer != "hlg"
                    {
                        return Err(format!(
                            "HDR10 export supports PQ and HLG sources only; {} uses {:?}",
                            entry.name, color.transfer
                        ));
                    }
                    if color
                        .primaries
                        .as_deref()
                        .is_some_and(|primaries| !primaries.eq_ignore_ascii_case("bt2020"))
                    {
                        return Err(format!(
                            "HDR10 export requires BT.2020 primaries; {} declares {:?}",
                            entry.name, color.primaries
                        ));
                    }
                    hdr_video_layers += 1;
                }
                ClipType::Image => {
                    let entry = manifest
                        .entries
                        .iter()
                        .find(|entry| entry.id == clip.media_ref)
                        .ok_or_else(|| {
                            format!("image overlay media not found: {}", clip.media_ref)
                        })?;
                    if entry.color.as_ref().is_some_and(MediaColorMetadata::is_hdr) {
                        return Err(format!(
                            "HDR image overlays are not supported yet: {}",
                            entry.name
                        ));
                    }
                }
                ClipType::Text => {
                    if clip.text_content.is_none() || clip.text_style.is_none() {
                        return Err("HDR10 text overlay is missing content/style".to_string());
                    }
                }
                other => {
                    return Err(format!(
                        "HDR10 export does not support {:?} layers yet",
                        other
                    ));
                }
            }
        }
    }
    if hdr_video_layers == 0 {
        return Err(
            "HDR10 export requires HDR video content in the selected range; refusing to tag SDR frames as HDR"
                .to_string(),
        );
    }
    Ok(())
}

fn render_hdr_linear_frame(
    core: &opentake_core::AppCore,
    frame: i32,
    width: u32,
    height: u32,
    text_rasterizer: &CosmicTextRasterizer,
) -> std::result::Result<LinearFrame, String> {
    let snapshot = core.get_timeline();
    let timeline = &snapshot.timeline;
    let manifest = core.media();
    let project_dir = core.project_dir();
    let mut layers: Vec<(
        LinearFrame,
        f64,
        LayerTransform,
        (f64, f64, f64, f64),
        Vec<LayerMask>,
    )> = Vec::new();
    for track in timeline.tracks.iter().filter(|track| !track.hidden) {
        for clip in &track.clips {
            if frame < clip.start_frame || frame >= clip.start_frame + clip.duration_frames {
                continue;
            }
            if clip.media_type == ClipType::Audio {
                continue;
            }
            if clip.nested_sequence_id.is_some()
                || !clip.effects.is_empty()
                || clip.stabilization.is_some()
                || clip.chroma_key.is_some()
                || clip.transition_out.is_some()
                || clip.reversed
            {
                return Err(
                    "HDR10 export supports crop, affine/keyframe/opacity, basic masks, SDR text/image overlays and basic grades/LUTs; effects/keying/transitions/reverse/nested sequences are not supported yet"
                        .to_string(),
                );
            }
            let sampled_transform = clip.transform_at(frame);
            let opacity = clip.opacity_at(frame);
            let transform = LayerTransform {
                center_x: sampled_transform.center_x,
                center_y: sampled_transform.center_y,
                width: sampled_transform.width,
                height: sampled_transform.height,
                rotation_degrees: sampled_transform.rotation,
                flip_horizontal: sampled_transform.flip_horizontal,
                flip_vertical: sampled_transform.flip_vertical,
            };
            let linear = match clip.media_type {
                ClipType::Video => {
                    let entry = manifest
                        .entries
                        .iter()
                        .find(|entry| entry.id == clip.media_ref)
                        .ok_or_else(|| format!("HDR source media not found: {}", clip.media_ref))?;
                    let path = resolve_media_path(entry, project_dir.as_deref())
                        .ok_or_else(|| format!("HDR source path unavailable for {}", entry.name))?;
                    let transfer = entry
                        .color
                        .as_ref()
                        .and_then(|color| color.transfer.clone())
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    let fps = timeline.fps.max(1) as f64;
                    let source_frame = clip.trim_start_frame as f64
                        + (frame - clip.start_frame) as f64 * clip.speed.max(0.000_1);
                    decode_hdr_linear_frame(&path, source_frame / fps, width, height, &transfer)?
                }
                ClipType::Image => {
                    let entry = manifest
                        .entries
                        .iter()
                        .find(|entry| entry.id == clip.media_ref)
                        .ok_or_else(|| {
                            format!("image overlay media not found: {}", clip.media_ref)
                        })?;
                    if entry.color.as_ref().is_some_and(MediaColorMetadata::is_hdr) {
                        return Err(format!(
                            "HDR image overlays are not supported yet: {}",
                            entry.name
                        ));
                    }
                    let path =
                        resolve_media_path(entry, project_dir.as_deref()).ok_or_else(|| {
                            format!("image overlay path unavailable for {}", entry.name)
                        })?;
                    let (_, rgba) = opentake_media::decode_frame_at(
                        &path,
                        &opentake_media::decode::FrameRequest {
                            time_secs: 0.0,
                            max_size: (width, height),
                            tolerance_secs: 1.0,
                            apply_rotation: true,
                        },
                    )
                    .map_err(|error| format!("decode image overlay {}: {error}", entry.name))?;
                    sdr_rgba8_to_linear_frame(&rgba, false)?
                }
                ClipType::Text => {
                    let content = clip
                        .text_content
                        .as_deref()
                        .ok_or_else(|| "text overlay has no content".to_string())?;
                    let style = clip
                        .text_style
                        .as_ref()
                        .ok_or_else(|| "text overlay has no style".to_string())?;
                    let top_left = sampled_transform.top_left();
                    let decoded = text_rasterizer
                        .rasterize(&TextRasterRequest {
                            clip_id: &clip.id,
                            content,
                            style,
                            box_norm: (
                                top_left.x,
                                top_left.y,
                                sampled_transform.width,
                                sampled_transform.height,
                            ),
                            canvas: (width, height),
                        })
                        .ok_or_else(|| "text overlay rasterization failed".to_string())?;
                    let rgba = RgbaFrame::new(decoded.width, decoded.height, decoded.rgba);
                    sdr_rgba8_to_linear_frame(&rgba, true)?
                }
                other => {
                    return Err(format!(
                        "HDR10 export does not support {:?} layers yet",
                        other
                    ));
                }
            };
            let linear = apply_linear_color_pipeline(
                &linear,
                clip.color_grade.as_ref(),
                clip.lut.as_ref(),
                project_dir.as_deref(),
            )?;
            let crop = clip.crop_at(frame);
            let crop_uv = (
                crop.left.clamp(0.0, 0.99),
                crop.top.clamp(0.0, 0.99),
                (1.0 - crop.right).clamp(0.01, 1.0),
                (1.0 - crop.bottom).clamp(0.01, 1.0),
            );
            layers.push((
                linear,
                opacity.clamp(0.0, 1.0),
                transform,
                crop_uv,
                hdr_layer_masks(&clip.masks),
            ));
        }
    }
    if layers.is_empty() {
        return Err(format!(
            "HDR10 export frame {frame} has no HDR video content"
        ));
    }
    let compositor = LinearCompositor::new(width, height).map_err(|error| error.to_string())?;
    let refs: Vec<TransformedLinearLayer<'_>> = layers
        .iter()
        .map(
            |(linear, opacity, transform, crop_uv, masks)| TransformedLinearLayer {
                frame: linear,
                opacity: *opacity as f32,
                transform: *transform,
                crop_uv: *crop_uv,
                masks: masks.clone(),
            },
        )
        .collect();
    compositor
        .composite_transformed([0.0, 0.0, 0.0, 1.0], &refs)
        .map_err(|error| error.to_string())
}

fn write_pcm_wav(pcm: &PcmBuffer, path: &FsPath) -> std::result::Result<(), String> {
    use std::io::Write as _;
    let data_len = pcm.samples_f32.len() * 2;
    let mut bytes = Vec::with_capacity(44 + data_len);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&pcm.spec.sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(pcm.spec.sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in &pcm.samples_f32 {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let mut file =
        std::fs::File::create(path).map_err(|error| format!("create HDR10 WAV: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("write HDR10 WAV: {error}"))?;
    Ok(())
}

/// Mux the HDR10 video bitstream (copy, preserving VUI/SEI) with the AAC audio
/// mixdown. The video temp file is produced by `Hdr10Writer`.
fn mux_hdr10_audio(
    video: &FsPath,
    wav: &FsPath,
    final_path: &FsPath,
) -> std::result::Result<(), String> {
    let status = StdCommand::new(hdr_source_ffmpeg())
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &video.to_string_lossy(),
            "-i",
            &wav.to_string_lossy(),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            &final_path.to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("spawn HDR10 audio mux: {error}"))?;
    if !status.status.success() {
        return Err(format!(
            "HDR10 audio mux failed: {}",
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }
    Ok(())
}

struct HdrExport {
    writer: Hdr10Writer,
    metadata: Hdr10Metadata,
    final_path: PathBuf,
    video_temp_path: PathBuf,
    audio_temp_path: PathBuf,
    text_rasterizer: CosmicTextRasterizer,
}

struct ExportSession {
    encoder: Option<opentake_media::VideoEncoder>,
    hdr: Option<HdrExport>,
    transparent: bool,
    width: u32,
    height: u32,
    fps: i32,
    total: i32,
    start_frame: i32,
    end_frame: i32,
    next_frame: i32,
    out_path: std::path::PathBuf,
    audio: Option<PcmBuffer>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCapabilityDto {
    model: String,
    version: i32,
    expected_bytes: i64,
    models_dir: Option<String>,
    installed: bool,
    backend: String,
    visual_available: bool,
    reason: Option<String>,
    detail: Option<String>,
    message: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchIndexStatusDto {
    model_installed: bool,
    visual_available: bool,
    indexable: usize,
    indexed: usize,
    reason: Option<String>,
    detail: Option<String>,
    errors: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMomentDto {
    media_id: String,
    frame: i64,
    start_sec: f64,
    end_sec: f64,
    score: f32,
    is_image: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchQueryResultDto {
    moments: Vec<SearchMomentDto>,
    visual_available: bool,
    visual_error: Option<String>,
    visual_error_detail: Option<String>,
    query_kind: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchAssetDto {
    id: String,
    path: String,
    #[serde(alias = "type")]
    kind: String,
    #[serde(default)]
    duration_secs: Option<f64>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
}

struct SearchState {
    cache_dir: PathBuf,
    embedder: SiglipEmbedder,
    capability: SearchCapabilityDto,
}

fn search_backend_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "ort-native"
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        "tract"
    }
}

fn search_manifest_total_bytes(manifest: &model_download::Manifest) -> i64 {
    manifest.image_encoder.bytes + manifest.text_encoder.bytes + manifest.tokenizer.bytes
}

/// Accept either the models root (`<root>`, containing the version dir) or the
/// version dir itself (`<root>/siglip2-base-patch16-256-v2`), so the Host can
/// pass whatever it configured. Verification always runs against the root.
fn resolve_search_models_root(models_dir: &FsPath, manifest: &model_download::Manifest) -> PathBuf {
    let version_name = format!("{}-v{}", manifest.model, manifest.version);
    let is_version_dir =
        models_dir.file_name().and_then(|name| name.to_str()) == Some(version_name.as_str());
    if is_version_dir {
        models_dir
            .parent()
            .map(FsPath::to_path_buf)
            .unwrap_or_else(|| models_dir.to_path_buf())
    } else {
        models_dir.to_path_buf()
    }
}

fn search_capability_unavailable(
    manifest: &model_download::Manifest,
    models_dir: Option<&str>,
    detail: &str,
) -> SearchCapabilityDto {
    SearchCapabilityDto {
        model: manifest.model.clone(),
        version: manifest.version,
        expected_bytes: search_manifest_total_bytes(manifest),
        models_dir: models_dir.map(str::to_string),
        installed: false,
        backend: search_backend_name().to_string(),
        visual_available: false,
        reason: Some("visual_unavailable".to_string()),
        detail: Some(detail.to_string()),
        message: None,
    }
}

fn parse_search_assets(assets_json: &str) -> Result<Vec<SearchAssetDto>> {
    serde_json::from_str(assets_json)
        .map_err(|error| Error::from_reason(format!("invalid search assets JSON: {error}")))
}

fn is_visual_search_asset(asset: &SearchAssetDto) -> bool {
    matches!(asset.kind.as_str(), "image" | "video")
}

fn decode_rgba_bytes(bytes: &[u8]) -> Result<RgbaFrame> {
    let image = image::load_from_memory(bytes)
        .map_err(|error| Error::from_reason(format!("decode search image: {error}")))?;
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(RgbaFrame::new(width, height, rgba.into_raw()))
}

fn decode_rgba_path(path: &FsPath) -> Result<RgbaFrame> {
    let bytes = std::fs::read(path).map_err(|error| {
        Error::from_reason(format!("read search image {}: {error}", path.display()))
    })?;
    decode_rgba_bytes(&bytes)
}

fn moment_dto(hit: ranker::Hit, fps: i32) -> SearchMomentDto {
    let fps = fps.max(1) as f64;
    SearchMomentDto {
        media_id: hit.asset_id,
        frame: (hit.shot_start * fps).round() as i64,
        start_sec: hit.shot_start,
        end_sec: hit.shot_end,
        score: hit.score,
        is_image: hit.shot_end <= hit.shot_start,
    }
}

#[napi]
pub struct Engine {
    core: opentake_core::AppCore,
    export: RefCell<Option<ExportSession>>,
    playback: RefCell<Option<NativePlayback>>,
    library: Option<LibraryStore>,
    search: RefCell<Option<SearchState>>,
}

#[napi]
impl Engine {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            core: opentake_core::AppCore::new(),
            export: RefCell::new(None),
            playback: RefCell::new(None),
            library: LibraryStore::open_default().ok(),
            search: RefCell::new(None),
        }
    }

    /// Reset to a fresh unsaved project and return its timeline snapshot JSON.
    #[napi]
    pub fn new_project(&self) -> Result<String> {
        json(&TimelineSnapshotDto::from(handle_project_new(&self.core)))
    }

    /// Create a fresh project and immediately persist it at `path`, returning
    /// the snapshot JSON with `projectPath` set.
    #[napi]
    pub fn new_project_at(&self, path: String) -> Result<String> {
        let path = std::path::PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| Error::from_reason(error.to_string()))?;
        }
        self.core.new_project();
        self.core
            .save_project(Some(path))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&TimelineSnapshotDto::from(handle_get_timeline(&self.core)))
    }

    /// Open a `.opentake` project bundle; returns the snapshot JSON.
    #[napi]
    pub fn open_project(&self, path: String) -> Result<String> {
        json(&handle_project_open(&self.core, path).map_err(|e| Error::from_reason(e.message))?)
    }

    /// Save the current project (save-as when `path` is provided); returns the written path.
    #[napi]
    pub fn save_project(&self, path: Option<String>) -> Result<String> {
        handle_project_save(&self.core, path).map_err(|e| Error::from_reason(e.message))
    }

    /// Read-only timeline snapshot JSON.
    #[napi]
    pub fn get_timeline(&self) -> Result<String> {
        json(&handle_get_timeline(&self.core))
    }

    /// Composite the timeline at `frame` and return `{width,height,dataUrl}`.
    #[napi]
    pub fn composite_frame(&self, frame: i32, max_size: Option<u32>) -> Result<String> {
        let value = composite_frame_json(&self.core, frame, max_size)
            .map_err(|message| Error::from_reason(message))?;
        json(&value)
    }

    fn export_cancel_inner(&self) -> bool {
        if let Some(mut session) = self.export.borrow_mut().take() {
            let path = session.out_path;
            if let Some(hdr) = session.hdr.take() {
                hdr.writer.abort();
                let _ = std::fs::remove_file(&hdr.video_temp_path);
                let _ = std::fs::remove_file(&hdr.audio_temp_path);
                let _ = std::fs::remove_file(&hdr.final_path);
            }
            drop(session.encoder.take());
            let _ = std::fs::remove_file(path);
            return true;
        }
        false
    }

    fn mix_timeline_audio(&self, timeline: &opentake_domain::Timeline) -> Option<PcmBuffer> {
        let media_entries = self.core.media().entries;
        let project_dir = self.core.project_dir();
        let mut clips: Vec<ClipAudio> = Vec::new();
        collect_audio_clips(
            timeline,
            0,
            0,
            &media_entries,
            project_dir.as_deref(),
            &mut clips,
        );
        let Ok(mixed) = mix_clips(&clips) else {
            return None;
        };
        if mixed.is_empty() {
            return None;
        }
        Some(PcmBuffer {
            spec: PcmSpec {
                sample_rate: MIX_SAMPLE_RATE,
                channels: 1,
                format: PcmFormat::F32,
            },
            samples_f32: mixed,
        })
    }

    fn mix_timeline_audio_ducked(
        &self,
        timeline: &opentake_domain::Timeline,
        reduction_db: f64,
        threshold_db: f64,
    ) -> Option<PcmBuffer> {
        let media_entries = self.core.media().entries;
        let project_dir = self.core.project_dir();
        let mut roles: Vec<(ClipAudio, bool)> = Vec::new();
        collect_audio_clips_with_roles(
            timeline,
            0,
            0,
            &media_entries,
            project_dir.as_deref(),
            &mut roles,
        );
        let voice: Vec<ClipAudio> = roles
            .iter()
            .filter(|(_, is_voice)| *is_voice)
            .map(|(clip, _)| clip.clone())
            .collect();
        let music: Vec<ClipAudio> = roles
            .iter()
            .filter(|(_, is_voice)| !*is_voice)
            .map(|(clip, _)| clip.clone())
            .collect();
        let voice_mix = mix_clips(&voice).ok()?;
        let music_mix = mix_clips(&music).ok()?;
        if music_mix.is_empty() {
            return None;
        }
        if voice_mix.is_empty() {
            return Some(PcmBuffer {
                spec: PcmSpec {
                    sample_rate: MIX_SAMPLE_RATE,
                    channels: 1,
                    format: PcmFormat::F32,
                },
                samples_f32: music_mix,
            });
        }
        let sample_rate = MIX_SAMPLE_RATE as f64;
        let threshold = 10.0_f64.powf(threshold_db / 20.0);
        let reduction = 10.0_f64.powf(-reduction_db.abs() / 20.0);
        let attack = (-1.0 / (0.008 * sample_rate)).exp();
        let release = (-1.0 / (0.180 * sample_rate)).exp();
        let mut envelope = 1.0_f64;
        let mut out = vec![0.0_f32; music_mix.len()];
        for index in 0..music_mix.len() {
            let voice_level = voice_mix.get(index).copied().unwrap_or(0.0).abs() as f64;
            let target = if voice_level > threshold {
                reduction
            } else {
                1.0
            };
            let coefficient = if target < envelope { attack } else { release };
            envelope = coefficient * envelope + (1.0 - coefficient) * target;
            let voice_sample = voice_mix.get(index).copied().unwrap_or(0.0);
            out[index] = (voice_sample + music_mix[index] * envelope as f32).clamp(-1.0, 1.0);
        }
        Some(PcmBuffer {
            spec: PcmSpec {
                sample_rate: MIX_SAMPLE_RATE,
                channels: 1,
                format: PcmFormat::F32,
            },
            samples_f32: out,
        })
    }

    /// Start native cpal playback of the timeline mix at `start_frame`.
    #[napi]
    pub fn playback_audio_start(&self, start_frame: i32) -> Result<String> {
        self.playback_audio_stop_inner();
        let timeline = self.core.get_timeline().timeline;
        let fps = timeline.fps.max(1);
        let source = self.mix_timeline_audio(&timeline);
        let samples = source.map(|pcm| pcm.samples_f32).unwrap_or_default();
        let source_rate = MIX_SAMPLE_RATE as f64;
        let sample_len = samples.len();
        let samples = Arc::new(samples);
        let start = start_frame.max(0);
        let start_sample = ((start as f64 / fps as f64) * source_rate).round() as usize;
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| Error::from_reason("no default audio output device"))?;
        let supported = device
            .default_output_config()
            .map_err(|error| Error::from_reason(format!("audio output config: {error}")))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = config.channels as usize;
        let sample_rate = config.sample_rate.0;
        if channels == 0 || sample_rate == 0 {
            return Err(Error::from_reason("invalid audio output configuration"));
        }
        let position = Arc::new(AtomicU64::new(0));
        let position_cb = Arc::clone(&position);
        let samples_cb = Arc::clone(&samples);
        let error_callback = |error| eprintln!("[opentake-route-b] audio output error: {error}");
        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_output_stream(
                &config,
                move |data: &mut [f32], _| {
                    fill_audio(
                        data,
                        channels,
                        sample_rate,
                        source_rate,
                        start_sample,
                        sample_len,
                        &samples_cb,
                        &position_cb,
                        |sample| sample,
                    );
                },
                error_callback,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_output_stream(
                &config,
                move |data: &mut [i16], _| {
                    fill_audio(
                        data,
                        channels,
                        sample_rate,
                        source_rate,
                        start_sample,
                        sample_len,
                        &samples_cb,
                        &position_cb,
                        |sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16,
                    );
                },
                error_callback,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_output_stream(
                &config,
                move |data: &mut [u16], _| {
                    fill_audio(
                        data,
                        channels,
                        sample_rate,
                        source_rate,
                        start_sample,
                        sample_len,
                        &samples_cb,
                        &position_cb,
                        |sample| ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32) as u16,
                    );
                },
                error_callback,
                None,
            ),
            other => {
                return Err(Error::from_reason(format!(
                    "unsupported audio sample format: {other:?}"
                )))
            }
        }
        .map_err(|error| Error::from_reason(format!("build audio output: {error}")))?;
        stream
            .play()
            .map_err(|error| Error::from_reason(format!("start audio output: {error}")))?;
        *self.playback.borrow_mut() = Some(NativePlayback {
            stream,
            position,
            sample_rate,
            fps,
            start_frame: start,
            paused: false,
        });
        json(&serde_json::json!({
            "active": true,
            "nativeAudio": true,
            "sampleRate": sample_rate,
            "fps": fps,
            "startFrame": start,
        }))
    }

    /// Current native audio-clock position; `{active:false}` when no session.
    #[napi]
    pub fn playback_audio_status(&self) -> Result<String> {
        let guard = self.playback.borrow();
        let Some(playback) = guard.as_ref() else {
            return json(&serde_json::json!({ "active": false, "nativeAudio": true }));
        };
        let played = playback.position.load(Ordering::Acquire);
        let frame = playback.start_frame as f64
            + (played as f64 / playback.sample_rate as f64) * playback.fps as f64;
        json(&serde_json::json!({
            "active": !playback.paused,
            "paused": playback.paused,
            "nativeAudio": true,
            "frame": frame.floor() as i32,
            "samplePosition": played,
            "fps": playback.fps,
        }))
    }

    #[napi]
    pub fn playback_audio_pause(&self) -> Result<bool> {
        let mut guard = self.playback.borrow_mut();
        let Some(playback) = guard.as_mut() else {
            return Ok(false);
        };
        playback
            .stream
            .pause()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        playback.paused = true;
        Ok(true)
    }

    #[napi]
    pub fn playback_audio_resume(&self) -> Result<bool> {
        let mut guard = self.playback.borrow_mut();
        let Some(playback) = guard.as_mut() else {
            return Ok(false);
        };
        playback
            .stream
            .play()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        playback.paused = false;
        Ok(true)
    }

    #[napi]
    pub fn playback_audio_stop(&self) -> Result<bool> {
        self.playback_audio_stop_inner();
        Ok(true)
    }

    fn playback_audio_stop_inner(&self) {
        if let Some(playback) = self.playback.borrow_mut().take() {
            let _ = playback.stream.pause();
        }
    }

    /// Validate/process one clip's visible audio window with the deterministic
    /// denoise profile and return the persisted AudioDenoise config.
    #[napi]
    pub fn prepare_denoise(
        &self,
        clip_id: String,
        mode: Option<String>,
        strength: Option<f64>,
        preview_enabled: Option<bool>,
    ) -> Result<String> {
        let timeline = self.core.get_timeline().timeline;
        let clip = timeline
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .chain(timeline.nested_sequences.iter().flat_map(|sequence| {
                sequence
                    .timeline
                    .tracks
                    .iter()
                    .flat_map(|track| &track.clips)
            }))
            .find(|clip| clip.id == clip_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("clip not found: {clip_id}")))?;
        if !matches!(clip.media_type, ClipType::Audio | ClipType::Video)
            || clip.nested_sequence_id.is_some()
        {
            return Err(Error::from_reason(
                "denoise requires an ordinary audio-bearing clip",
            ));
        }
        let config = AudioDenoise {
            mode: match mode.as_deref() {
                Some("voice") => DenoiseMode::Voice,
                _ => DenoiseMode::Adaptive,
            },
            strength: strength.unwrap_or(0.5).clamp(0.0, 1.0),
            preview_enabled: preview_enabled.unwrap_or(true),
        };
        config
            .validate()
            .map_err(|error| Error::from_reason(format!("denoise_invalid_config: {error}")))?;
        let entry = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == clip.media_ref)
            .cloned()
            .ok_or_else(|| Error::from_reason("denoise source media not found"))?;
        let path = resolve_media_path(&entry, self.core.project_dir().as_deref())
            .ok_or_else(|| Error::from_reason("denoise source path unavailable"))?;
        let fps = timeline.fps.max(1) as f64;
        let start = clip.trim_start_frame.max(0) as f64 / fps;
        let end = start + clip.duration_frames.max(1) as f64 / fps;
        let spec = PcmSpec {
            sample_rate: MIX_SAMPLE_RATE,
            channels: 1,
            format: PcmFormat::F32,
        };
        let pcm = opentake_media::extract_pcm(&path, &spec, Some((start, end)))
            .map_err(|error| Error::from_reason(format!("denoise_unreadable_audio: {error}")))?;
        if pcm.samples_f32.is_empty() {
            return Err(Error::from_reason(
                "denoise_unreadable_audio: empty PCM window",
            ));
        }
        let cancel = MediaCancelToken::new();
        denoise_interleaved(
            &pcm.samples_f32,
            1,
            pcm.spec.sample_rate,
            config,
            &cancel,
            None,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&config)
    }

    /// Analyze one audio-bearing clip's visible window and return a persisted
    /// loudness-normalization result (no project mutation).
    #[napi]
    pub fn analyze_loudness(
        &self,
        clip_id: String,
        target_lufs: Option<f64>,
        true_peak_ceiling_dbtp: Option<f64>,
    ) -> Result<String> {
        let timeline = self.core.get_timeline().timeline;
        let clip = timeline
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .chain(timeline.nested_sequences.iter().flat_map(|sequence| {
                sequence
                    .timeline
                    .tracks
                    .iter()
                    .flat_map(|track| &track.clips)
            }))
            .find(|clip| clip.id == clip_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("clip not found: {clip_id}")))?;
        if !matches!(clip.media_type, ClipType::Audio | ClipType::Video)
            || clip.nested_sequence_id.is_some()
        {
            return Err(Error::from_reason(
                "loudness requires an ordinary audio-bearing clip",
            ));
        }
        let entry = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == clip.media_ref)
            .cloned()
            .ok_or_else(|| Error::from_reason("loudness source media not found"))?;
        let path = resolve_media_path(&entry, self.core.project_dir().as_deref())
            .ok_or_else(|| Error::from_reason("loudness source path unavailable"))?;
        let fps = timeline.fps.max(1) as f64;
        let start = clip.trim_start_frame.max(0) as f64 / fps;
        let end = start + clip.duration_frames.max(1) as f64 / fps;
        let spec = PcmSpec {
            sample_rate: MIX_SAMPLE_RATE,
            channels: 1,
            format: PcmFormat::F32,
        };
        let pcm = opentake_media::extract_pcm(&path, &spec, Some((start, end)))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        if pcm.samples_f32.is_empty() {
            return Err(Error::from_reason(
                "loudness_unreadable_audio: empty PCM window",
            ));
        }
        let config = LoudnessNormalizationConfig {
            target_lufs: target_lufs.unwrap_or(-16.0),
            true_peak_ceiling_dbtp: true_peak_ceiling_dbtp.unwrap_or(-1.0),
        };
        let result = analyze_loudness(&pcm.samples_f32, pcm.spec.sample_rate, config)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let normalization = opentake_domain::LoudnessNormalization {
            target_lufs: result.target_lufs,
            true_peak_ceiling_dbtp: result.true_peak_ceiling_dbtp,
            input_integrated_lufs: result.input_integrated_lufs,
            input_true_peak_dbtp: result.input_true_peak_dbtp,
            gain_db: result.gain_db,
            output_integrated_lufs: result.output_integrated_lufs,
            output_true_peak_dbtp: result.output_true_peak_dbtp,
        };
        json(&normalization)
    }

    /// Analyze one ordinary video clip into a source-bound stabilization track.
    #[napi]
    pub fn analyze_stabilization(&self, clip_id: String) -> Result<String> {
        let timeline = self.core.get_timeline().timeline;
        let clip = timeline
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .chain(timeline.nested_sequences.iter().flat_map(|sequence| {
                sequence
                    .timeline
                    .tracks
                    .iter()
                    .flat_map(|track| &track.clips)
            }))
            .find(|clip| clip.id == clip_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("clip not found: {clip_id}")))?;
        if clip.media_type != ClipType::Video || clip.nested_sequence_id.is_some() {
            return Err(Error::from_reason(
                "stabilization requires an ordinary video clip",
            ));
        }
        let entry = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == clip.media_ref)
            .cloned()
            .ok_or_else(|| Error::from_reason("stabilization source media not found"))?;
        let path = resolve_media_path(&entry, self.core.project_dir().as_deref())
            .ok_or_else(|| Error::from_reason("stabilization source path unavailable"))?;
        let fps = timeline.fps.max(1) as f64;
        let sample_count = (clip.duration_frames.max(2) as usize).min(48);
        let last_frame = (clip.duration_frames - 1).max(1);
        let cache = std::env::temp_dir().join("opentake-route-b").join("cache");
        let media = opentake_media::MediaEngine::new(&cache, cache.join("models"));
        let source_start = clip.trim_start_frame.max(0) as f64 / fps;
        let mut frames = Vec::with_capacity(sample_count);
        for index in 0..sample_count {
            let relative = if sample_count <= 1 {
                0
            } else {
                ((index as f64 * last_frame as f64 / (sample_count - 1) as f64).round() as i32)
                    .clamp(0, last_frame)
            };
            let time = source_start + relative as f64 * clip.speed.max(0.0001) / fps;
            let Ok((_, rgba)) = media.decode_frame(
                &path,
                &opentake_media::decode::FrameRequest {
                    time_secs: time,
                    max_size: (320, 180),
                    tolerance_secs: 0.1,
                    apply_rotation: true,
                },
            ) else {
                continue;
            };
            frames.push((
                relative,
                opentake_media::RgbaFrame::new(rgba.width, rgba.height, rgba.rgba),
            ));
        }
        let cancel = MediaCancelToken::new();
        let motion = track_translation_motion(&frames, &cancel)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let track = analyze_stabilization(
            &motion,
            clip.media_ref.clone(),
            StabilizationConfig::default(),
            &cancel,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&track)
    }

    /// Start a chunked export session. Returns `{width,height,fps,total}`.
    #[napi]
    pub fn export_begin(
        &self,
        out_path: String,
        codec: String,
        quality: String,
        range_start: Option<i32>,
        range_end: Option<i32>,
        bit_depth: Option<u32>,
        duck_music: Option<bool>,
        hdr10: Option<bool>,
    ) -> Result<String> {
        self.export_cancel_inner();
        let hdr10 = hdr10 == Some(true);
        let timeline = self.core.get_timeline().timeline;
        let resolution = match quality.as_str() {
            "720p" => opentake_render::ExportResolution::R720p,
            "4k" => opentake_render::ExportResolution::R4k,
            _ => opentake_render::ExportResolution::R1080p,
        };
        let render_size =
            opentake_render::export_render_size((timeline.width, timeline.height), resolution);
        let timeline_frames = timeline.total_frames().max(1);
        let start_frame = range_start.unwrap_or(0).clamp(0, timeline_frames - 1);
        let end_frame = range_end
            .unwrap_or(timeline_frames)
            .clamp(start_frame + 1, timeline_frames);
        let total = end_frame - start_frame;
        if hdr10 {
            validate_hdr10_timeline(&self.core, start_frame, end_frame)
                .map_err(Error::from_reason)?;
        }
        let video_codec = match codec.as_str() {
            "h265" => opentake_media::VideoCodec::H265,
            "prores" => opentake_media::VideoCodec::ProRes422,
            "prores4444" => opentake_media::VideoCodec::ProRes4444,
            _ => opentake_media::VideoCodec::H264,
        };
        if hdr10 && video_codec != opentake_media::VideoCodec::H265 {
            return Err(Error::from_reason(
                "HDR10 export requires codec h265 (Main10)",
            ));
        }
        let mut preset =
            opentake_media::ExportPreset::new(video_codec, opentake_media::ExportResolution::P1080);
        if bit_depth == Some(10) || hdr10 {
            preset = preset.with_bit_depth(10);
        }
        let out = std::path::PathBuf::from(&out_path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| Error::from_reason(error.to_string()))?;
        }
        let audio = if duck_music == Some(true) {
            self.mix_timeline_audio_ducked(&timeline, 12.0, -30.0)
        } else {
            self.mix_timeline_audio(&timeline)
        };
        let encoder = if hdr10 {
            None
        } else {
            Some(
                opentake_media::VideoEncoder::new(
                    &out,
                    render_size.width,
                    render_size.height,
                    timeline.fps,
                    &preset,
                )
                .map_err(|error| Error::from_reason(error.to_string()))?,
            )
        };
        let hdr = if hdr10 {
            let metadata = hdr10_output_metadata();
            let token = uuid::Uuid::new_v4();
            let video_temp_path = out.with_file_name(format!(".opentake-hdr10-{token}.mp4"));
            let audio_temp_path = out.with_file_name(format!(".opentake-hdr10-{token}.wav"));
            let spec = Hdr10OutputSpec {
                out: video_temp_path.to_string_lossy().into_owned(),
                width: render_size.width,
                height: render_size.height,
                fps: timeline.fps,
                crf: 20,
                preset: "medium".to_string(),
                metadata,
            };
            Some(HdrExport {
                writer: Hdr10Writer::start(spec)
                    .map_err(|error| Error::from_reason(error.to_string()))?,
                metadata,
                final_path: out.clone(),
                video_temp_path,
                audio_temp_path,
                text_rasterizer: CosmicTextRasterizer::new(),
            })
        } else {
            None
        };
        *self.export.borrow_mut() = Some(ExportSession {
            encoder,
            hdr,
            transparent: matches!(video_codec, opentake_media::VideoCodec::ProRes4444),
            width: render_size.width,
            height: render_size.height,
            fps: timeline.fps,
            total,
            start_frame,
            end_frame,
            next_frame: start_frame,
            out_path: out,
            audio,
        });
        let mut response = serde_json::json!({
            "width": render_size.width,
            "height": render_size.height,
            "fps": timeline.fps,
            "total": total,
            "hdr10": hdr10,
        });
        if hdr10 {
            response["metadata"] = serde_json::json!({
                "primaries": "bt2020",
                "transfer": "smpte2084",
                "matrix": "bt2020nc",
                "maxCll": 1000,
                "maxFall": 400,
                "masteringDisplay": hdr10_output_metadata().mastering_display.x265_token(),
            });
        }
        json(&response)
    }

    /// Render up to `frames` more frames; returns `{done,total}`.
    #[napi]
    pub fn export_step(&self, frames: u32) -> Result<String> {
        let mut guard = self.export.borrow_mut();
        let session = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("no export session"))?;
        let size = opentake_render::plan::RenderSize::new(session.width, session.height);
        let end = (session.next_frame + frames as i32).min(session.end_frame);
        while session.next_frame < end {
            let frame = session.next_frame;
            if let Some(hdr) = session.hdr.as_mut() {
                let linear = render_hdr_linear_frame(
                    &self.core,
                    frame,
                    session.width,
                    session.height,
                    &hdr.text_rasterizer,
                )
                .map_err(Error::from_reason)?;
                hdr.writer
                    .write_frame(&linear)
                    .map_err(|error| Error::from_reason(error.to_string()))?;
            } else {
                let decoded = composite_frame_decoded(&self.core, frame, size, session.transparent)
                    .map_err(|message| Error::from_reason(message))?;
                let rgba =
                    opentake_media::RgbaFrame::new(decoded.width, decoded.height, decoded.rgba);
                session
                    .encoder
                    .as_mut()
                    .ok_or_else(|| Error::from_reason("SDR export encoder is missing"))?
                    .push_frame(&rgba)
                    .map_err(|error| Error::from_reason(error.to_string()))?;
            }
            session.next_frame += 1;
        }
        json(
            &serde_json::json!({ "done": session.next_frame - session.start_frame, "total": session.total }),
        )
    }

    /// Finish the active export and return the UI ExportSummary JSON.
    #[napi]
    pub fn export_finish(&self) -> Result<String> {
        let mut session = self
            .export
            .borrow_mut()
            .take()
            .ok_or_else(|| Error::from_reason("no export session"))?;
        if let Some(hdr) = session.hdr.take() {
            let HdrExport {
                writer,
                metadata,
                final_path,
                video_temp_path,
                audio_temp_path,
                text_rasterizer: _,
            } = hdr;
            let frames = writer
                .finish()
                .map_err(|error| Error::from_reason(error.to_string()))?;
            let audio = session.audio.take();
            let has_audio = audio.is_some();
            if let Some(pcm) = audio {
                write_pcm_wav(&pcm, &audio_temp_path).map_err(Error::from_reason)?;
                mux_hdr10_audio(&video_temp_path, &audio_temp_path, &final_path)
                    .map_err(Error::from_reason)?;
                let _ = std::fs::remove_file(&video_temp_path);
                let _ = std::fs::remove_file(&audio_temp_path);
            } else {
                std::fs::rename(&video_temp_path, &final_path)
                    .or_else(|_| {
                        std::fs::copy(&video_temp_path, &final_path).map(|_| {
                            std::fs::remove_file(&video_temp_path)
                                .map(|_| ())
                                .unwrap_or(())
                        })
                    })
                    .map_err(|error| {
                        Error::from_reason(format!("finalize HDR10 output: {error}"))
                    })?;
            }
            return json(&serde_json::json!({
                "outPath": final_path.to_string_lossy(),
                "width": session.width,
                "height": session.height,
                "fps": session.fps,
                "frameCount": frames,
                "hasAudio": has_audio,
                "hdr10": true,
                "metadata": {
                    "primaries": "bt2020",
                    "transfer": "smpte2084",
                    "matrix": "bt2020nc",
                    "maxCll": metadata.max_cll,
                    "maxFall": metadata.max_fall,
                    "masteringDisplay": metadata.mastering_display.x265_token(),
                },
            }));
        }
        let has_audio = session.audio.is_some();
        if let Some(pcm) = session.audio.take() {
            session
                .encoder
                .as_mut()
                .ok_or_else(|| Error::from_reason("SDR export encoder is missing"))?
                .push_audio(pcm)
                .map_err(|error| Error::from_reason(error.to_string()))?;
        }
        session
            .encoder
            .take()
            .ok_or_else(|| Error::from_reason("SDR export encoder is missing"))?
            .finish()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&serde_json::json!({
            "outPath": session.out_path.to_string_lossy(),
            "width": session.width,
            "height": session.height,
            "fps": session.fps,
            "frameCount": session.total,
            "hasAudio": has_audio,
            "hdr10": false,
        }))
    }

    /// Cancel the active export and remove the partial output.
    #[napi]
    pub fn export_cancel(&self) -> bool {
        self.export_cancel_inner()
    }

    /// Blocking convenience export (used by the agent tool).
    #[napi]
    pub fn export_video(
        &self,
        out_path: String,
        codec: String,
        quality: String,
        bit_depth: Option<u32>,
        duck_music: Option<bool>,
        hdr10: Option<bool>,
    ) -> Result<String> {
        self.export_begin(
            out_path, codec, quality, None, None, bit_depth, duck_music, hdr10,
        )?;
        loop {
            let done = {
                let guard = self.export.borrow();
                let session = guard
                    .as_ref()
                    .ok_or_else(|| Error::from_reason("no export session"))?;
                (session.next_frame, session.total)
            };
            if done.0 >= done.1 {
                break;
            }
            self.export_step(8)?;
        }
        self.export_finish()
    }

    /// Current media catalog in the React UI's `MediaList` JSON shape.    /// Current media catalog in the React UI's `MediaList` JSON shape.
    #[napi]
    pub fn media_list(&self) -> Result<String> {
        json(&media_list_json(&self.core))
    }

    /// Probe and import local media files, returning the updated catalog JSON.
    #[napi]
    pub fn import_media(&self, paths: Vec<String>) -> Result<String> {
        let mut skipped: Vec<String> = Vec::new();
        for raw in paths {
            let path = std::path::PathBuf::from(&raw);
            let name = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("media")
                .to_string();
            let probed = match probe_to_probed(&path) {
                Some(probe) => probe,
                None => {
                    skipped.push(raw);
                    continue;
                }
            };
            if self.core.import_media_file(&path, name, &probed).is_err() {
                skipped.push(raw);
            }
        }
        let mut value = media_list_json(&self.core);
        if !skipped.is_empty() {
            value["skipped"] = serde_json::json!(skipped);
        }
        json(&value)
    }

    /// Relink an existing asset to a new source path, keeping its id; returns
    /// the updated media catalog JSON.
    #[napi]
    pub fn relink_media(&self, media_id: String, new_path: String) -> Result<String> {
        let path = std::path::PathBuf::from(&new_path);
        let probed = probe_to_probed(&path)
            .ok_or_else(|| Error::from_reason(format!("cannot probe media: {new_path}")))?;
        self.core
            .relink_media_file(&media_id, &path, &probed)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&media_list_json(&self.core))
    }

    /// Generate a project-local low-resolution proxy for one video asset and
    /// persist it in the media manifest. Returns the UI MediaProxyResult JSON.
    #[napi]
    pub fn create_media_proxy(
        &self,
        media_id: String,
        max_width: u32,
        max_height: u32,
    ) -> Result<String> {
        let snapshot = self.core.get_timeline();
        let project_dir = self
            .core
            .project_dir()
            .ok_or_else(|| Error::from_reason("media_proxy_project_must_be_saved"))?;
        let entry = snapshot
            .timeline
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter())
            .find(|clip| clip.media_ref == media_id)
            .and_then(|clip| {
                self.core
                    .media()
                    .entries
                    .iter()
                    .find(|entry| entry.id == clip.media_ref)
                    .cloned()
            })
            .ok_or_else(|| Error::from_reason(format!("media not found: {media_id}")))?;
        let source = resolve_media_path(&entry, Some(&project_dir))
            .ok_or_else(|| Error::from_reason("media source path is unavailable"))?;
        let proxy_dir = project_dir.join("media").join("proxies");
        std::fs::create_dir_all(&proxy_dir)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let leaf = format!("{}.mp4", media_id);
        let output = proxy_dir.join(&leaf);
        let _ = std::fs::remove_file(&output);
        let result = opentake_media::proxy::create_proxy(
            opentake_media::proxy::ProxyRequest {
                source: &source,
                output: &output,
                max_size: (max_width.max(2), max_height.max(2)),
            },
            &opentake_media::MediaCancelToken::new(),
            None,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        let relative_path = format!("media/proxies/{leaf}");
        let proxy = opentake_domain::MediaProxy {
            relative_path,
            source_sha256: result.source_sha256.clone(),
            width: result.width,
            height: result.height,
        };
        self.core
            .set_media_proxy_for_project(
                snapshot.project_epoch,
                &project_dir,
                &media_id,
                Some(proxy),
            )
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&serde_json::json!({
            "assetId": media_id,
            "path": result.path.to_string_lossy(),
            "sourceSha256": result.source_sha256,
            "width": result.width,
            "height": result.height,
        }))
    }

    /// Remove one asset's proxy and delete the generated file.
    #[napi]
    pub fn remove_media_proxy(&self, media_id: String) -> bool {
        let Some(project_dir) = self.core.project_dir() else {
            return false;
        };
        let snapshot = self.core.get_timeline();
        let Some(entry) = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == media_id)
            .cloned()
        else {
            return false;
        };
        let proxy_path = entry
            .proxy
            .as_ref()
            .map(|proxy| project_dir.join(&proxy.relative_path));
        let result = self
            .core
            .set_media_proxy_for_project(snapshot.project_epoch, &project_dir, &media_id, None)
            .is_ok();
        if result {
            if let Some(path) = proxy_path {
                let _ = std::fs::remove_file(path);
            }
        }
        result
    }

    /// Composite/decode one frame and import it as a new still image asset.
    #[napi]
    pub fn capture_frame_to_media(
        &self,
        frame: i32,
        name_base: String,
        source_media_id: Option<String>,
    ) -> Result<String> {
        let snapshot = self.core.get_timeline();
        let project_dir = self.core.project_dir();
        let decoded = if let Some(media_id) = source_media_id {
            let entry = self
                .core
                .media()
                .entries
                .iter()
                .find(|entry| entry.id == media_id)
                .cloned()
                .ok_or_else(|| Error::from_reason(format!("media not found: {media_id}")))?;
            let path = resolve_media_path(&entry, project_dir.as_deref())
                .ok_or_else(|| Error::from_reason("media path unavailable"))?;
            let cache = std::env::temp_dir().join("opentake-route-b").join("cache");
            let engine = opentake_media::MediaEngine::new(&cache, cache.join("models"));
            let (_, rgba) = engine
                .decode_frame(
                    &path,
                    &opentake_media::decode::FrameRequest {
                        time_secs: frame as f64 / f64::from(snapshot.timeline.fps.max(1)),
                        max_size: (0, 0),
                        tolerance_secs: 0.1,
                        apply_rotation: true,
                    },
                )
                .map_err(|error| Error::from_reason(error.to_string()))?;
            DecodedFrame::new(rgba.width, rgba.height, rgba.rgba, false)
        } else {
            composite_frame_decoded(
                &self.core,
                frame,
                RenderSize::new(
                    snapshot.timeline.width.max(2) as u32,
                    snapshot.timeline.height.max(2) as u32,
                ),
                false,
            )
            .map_err(|message| Error::from_reason(message))?
        };
        let directory = project_dir
            .as_ref()
            .map(|root| root.join("media").join("captures"))
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join("opentake-route-b")
                    .join("captures")
            });
        std::fs::create_dir_all(&directory)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let file = directory.join(format!("{}.png", uuid::Uuid::new_v4()));
        let image = image::RgbaImage::from_raw(decoded.width, decoded.height, decoded.rgba)
            .ok_or_else(|| Error::from_reason("invalid capture buffer"))?;
        image
            .save_with_format(&file, image::ImageFormat::Png)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let name = format!("{name_base} {frame}");
        let probe = ProbedMedia {
            duration_secs: 0.0,
            width: Some(decoded.width as i32),
            height: Some(decoded.height as i32),
            fps: None,
            has_audio: false,
            color: None,
        };
        self.core
            .import_media_file(&file, name, &probe)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&media_list_json(&self.core))
    }

    /// Write the timeline as an interchange document (`xmeml`, `edl`, `otio`,
    /// `fcpxml`). Returns the written path.
    #[napi]
    pub fn export_timeline(&self, path: String, format: String) -> Result<String> {
        let snapshot = self.core.get_timeline();
        let manifest = self.core.media();
        let project_dir = self.core.project_dir();
        let body = match format.as_str() {
            "edl" => opentake_project::export_edl(&snapshot.timeline, &manifest),
            "otio" => {
                opentake_project::export_otio(&snapshot.timeline, &manifest, project_dir.as_deref())
            }
            "fcpxml" => opentake_project::export_fcpxml(
                &snapshot.timeline,
                &manifest,
                project_dir.as_deref(),
            ),
            _ => opentake_project::export_xmeml_with_timecodes(
                &snapshot.timeline,
                &manifest,
                project_dir.as_deref(),
                &std::collections::HashMap::new(),
            ),
        };
        std::fs::write(&path, body).map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(path)
    }

    /// Write the timeline's caption cues as SRT or VTT; returns `{outPath,cueCount}`.
    #[napi]
    pub fn export_subtitles(&self, path: String, format: String) -> Result<String> {
        let timeline = self.core.get_timeline().timeline;
        let cue_count = opentake_domain::collect_caption_cues(&timeline).len();
        let body = if format.eq_ignore_ascii_case("vtt") {
            opentake_domain::export_vtt(&timeline)
        } else {
            opentake_domain::export_srt(&timeline)
        };
        std::fs::write(&path, body).map_err(|error| Error::from_reason(error.to_string()))?;
        json(&serde_json::json!({ "outPath": path, "cueCount": cue_count }))
    }

    /// Favorite/unfavorite one project asset: mirror it into the global library
    /// and persist the manifest favorite mapping. Returns the updated catalog.
    #[napi]
    pub fn toggle_favorite(&self, media_id: String, favorite: bool) -> Result<String> {
        let snapshot = self.core.get_timeline();
        let project_dir = self.core.project_dir().ok_or_else(|| {
            Error::from_reason("save the project before changing global favorites")
        })?;
        let entry = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == media_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("media asset not found: {media_id}")))?;
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        if favorite {
            let source = resolve_media_path(&entry, Some(&project_dir))
                .ok_or_else(|| Error::from_reason("media source could not be resolved"))?;
            if !source.is_file() {
                return Err(Error::from_reason(
                    "media source is offline; relink before favoriting",
                ));
            }
            let kind = match entry.kind {
                ClipType::Video => "video",
                ClipType::Audio => "audio",
                ClipType::Image => "image",
                ClipType::Lottie => "lottie",
                _ => "other",
            };
            let favorited_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs_f64())
                .unwrap_or(0.0);
            let library_entry = store
                .favorite(&FavoriteRequest {
                    source: &source,
                    kind,
                    category: None,
                    favorited_at,
                    thumb: None,
                })
                .map_err(|error| Error::from_reason(error.to_string()))?;
            self.core
                .set_media_global_favorite_for_project(
                    snapshot.project_epoch,
                    &project_dir,
                    &media_id,
                    Some(library_entry.id),
                )
                .map_err(|error| Error::from_reason(error.to_string()))?;
            self.core
                .set_media_favorite_for_project(
                    snapshot.project_epoch,
                    &project_dir,
                    &[media_id.clone()],
                    true,
                )
                .map_err(|error| Error::from_reason(error.to_string()))?;
        } else {
            let manifest = self.core.media();
            let library_id = manifest.library_favorite_id(&media_id).map(str::to_string);
            if let Some(id) = library_id {
                let _ = store.remove(&id);
            }
            self.core
                .set_media_global_favorite_for_project(
                    snapshot.project_epoch,
                    &project_dir,
                    &media_id,
                    None,
                )
                .map_err(|error| Error::from_reason(error.to_string()))?;
            self.core
                .set_media_favorite_for_project(
                    snapshot.project_epoch,
                    &project_dir,
                    &[media_id],
                    false,
                )
                .map_err(|error| Error::from_reason(error.to_string()))?;
        }
        json(&media_list_json(&self.core))
    }

    /// Global library entries (optionally filtered; empty string = all).
    #[napi]
    pub fn library_list(&self, category: Option<String>) -> Result<String> {
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let entries = match category.as_deref() {
            Some(value) if !value.is_empty() => store.entries_in_category(Some(value)),
            _ => store.entries(),
        }
        .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&entries)
    }

    /// Favorite a source file into the global library.
    #[napi]
    pub fn library_favorite(
        &self,
        source: String,
        kind: String,
        category: Option<String>,
        thumb: Option<String>,
    ) -> Result<String> {
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let path = std::path::PathBuf::from(&source);
        let favorited_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64())
            .unwrap_or(0.0);
        let entry = store
            .favorite(&FavoriteRequest {
                source: &path,
                kind: &kind,
                category: category.filter(|value| !value.is_empty()),
                favorited_at,
                thumb: thumb.filter(|value| !value.is_empty()),
            })
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&entry)
    }

    /// Remove one library entry by content id.
    #[napi]
    pub fn library_unfavorite(&self, id: String) -> Result<bool> {
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        store
            .remove(&id)
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Update one entry's category; returns the updated entry or null.
    #[napi]
    pub fn library_categorize(&self, id: String, category: Option<String>) -> Result<String> {
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let updated = store
            .set_category(&id, category.filter(|value| !value.is_empty()))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&updated)
    }

    /// Rename a library category (empty target = uncategorized); returns count.
    #[napi]
    pub fn library_rename(&self, from: String, to: Option<String>) -> Result<u32> {
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let count = store
            .rename_category(&from, to.filter(|value| !value.is_empty()))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(count as u32)
    }

    /// Delete one library entry; returns whether it existed.
    #[napi]
    pub fn library_delete(&self, id: String) -> Result<bool> {
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        store
            .remove(&id)
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Import one global-library entry into the current project as a new asset.
    #[napi]
    pub fn library_import_to_project(&self, id: String) -> Result<String> {
        let store = self
            .library
            .as_ref()
            .ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let entries = store
            .entries()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let entry = entries
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| Error::from_reason(format!("library entry not found: {id}")))?;
        let path = store
            .stored_path(&id)
            .map_err(|error| Error::from_reason(error.to_string()))?
            .ok_or_else(|| Error::from_reason("library entry file is missing"))?;
        let probed = probe_to_probed(&path)
            .ok_or_else(|| Error::from_reason("cannot probe library entry"))?;
        let name = entry
            .source
            .as_deref()
            .and_then(|source| std::path::Path::new(source).file_stem())
            .and_then(|stem| stem.to_str())
            .unwrap_or("Library asset")
            .to_string();
        let imported = self
            .core
            .import_media_file(&path, name, &probed)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(
            &serde_json::json!({ "id": imported.id, "name": imported.name, "path": path.to_string_lossy() }),
        )
    }

    /// Composite one frame and return a JPEG data URL (playback transport).
    #[napi]
    pub fn composite_frame_jpeg(
        &self,
        frame: i32,
        max_size: Option<i32>,
        quality: Option<u32>,
    ) -> Result<String> {
        let snapshot = self.core.get_timeline();
        let decoded = composite_frame_decoded(
            &self.core,
            frame,
            RenderSize::new(
                snapshot.timeline.width.max(2) as u32,
                snapshot.timeline.height.max(2) as u32,
            ),
            false,
        )
        .map_err(|message| Error::from_reason(message))?;
        let image = image::RgbaImage::from_raw(decoded.width, decoded.height, decoded.rgba)
            .ok_or_else(|| Error::from_reason("invalid composite buffer"))?;
        let rgb = image::DynamicImage::ImageRgba8(image).to_rgb8();
        let mut bytes = Vec::new();
        let quality = quality.unwrap_or(82).clamp(1, 100) as u8;
        let mut cursor = std::io::Cursor::new(&mut bytes);
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality)
            .encode_image(&rgb)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        json(&serde_json::json!({
            "width": decoded.width,
            "height": decoded.height,
            "dataUrl": format!("data:image/jpeg;base64,{encoded}"),
            "maxSize": max_size,
        }))
    }

    /// Export the whole timeline audio mixdown to M4A (AAC) or MP3.
    #[napi]
    pub fn export_audio(
        &self,
        out_path: String,
        format: String,
        duck_music: Option<bool>,
    ) -> Result<String> {
        let timeline = self.core.get_timeline().timeline;
        let pcm = (if duck_music == Some(true) {
            self.mix_timeline_audio_ducked(&timeline, 12.0, -30.0)
        } else {
            self.mix_timeline_audio(&timeline)
        })
        .ok_or_else(|| Error::from_reason("timeline has no audible audio"))?;
        let directory = std::env::temp_dir().join("opentake-route-b").join("audio");
        std::fs::create_dir_all(&directory)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let wav = directory.join(format!("{}.wav", uuid::Uuid::new_v4()));
        let data_len = pcm.samples_f32.len() * 2;
        let mut bytes = Vec::with_capacity(44 + data_len);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&pcm.spec.sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(pcm.spec.sample_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
        for sample in &pcm.samples_f32 {
            let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(&wav, bytes).map_err(|error| Error::from_reason(error.to_string()))?;
        let out = std::path::PathBuf::from(&out_path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| Error::from_reason(error.to_string()))?;
        }
        let mp3 = format.eq_ignore_ascii_case("mp3");
        let codec = if mp3 { "libmp3lame" } else { "aac" };
        let status = std::process::Command::new(opentake_media::ffmpeg_status::ffmpeg_path())
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&wav)
            .args(["-c:a", codec, "-b:a", "192k"])
            .arg(&out)
            .status()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        if !status.success() {
            return Err(Error::from_reason(format!(
                "ffmpeg audio export exited {status}"
            )));
        }
        json(&serde_json::json!({
            "outPath": out_path,
            "format": if mp3 { "mp3" } else { "m4a" },
            "durationSeconds": pcm.duration_secs(),
        }))
    }

    /// Mix the whole timeline audio and write a mono 16-bit WAV; returns its path.
    #[napi]
    pub fn audio_mix_wav(&self) -> Result<String> {
        let timeline = self.core.get_timeline().timeline;
        let pcm = self
            .mix_timeline_audio(&timeline)
            .ok_or_else(|| Error::from_reason("timeline has no audible audio"))?;
        let directory = std::env::temp_dir().join("opentake-route-b").join("audio");
        std::fs::create_dir_all(&directory)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let file = directory.join(format!("{}.wav", uuid::Uuid::new_v4()));
        let data_len = pcm.samples_f32.len() * 2;
        let mut bytes = Vec::with_capacity(44 + data_len);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&pcm.spec.sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(pcm.spec.sample_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
        for sample in &pcm.samples_f32 {
            let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(&file, bytes).map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(file.to_string_lossy().into_owned())
    }

    /// Generate a single-frame poster PNG for one imported asset and return
    /// its absolute path. Video uses the first frame; images use a scaled
    /// thumbnail; unsupported kinds return an empty string.
    #[napi]
    pub fn thumbnail(&self, media_id: String) -> Result<String> {
        let entry = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == media_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("media not found: {media_id}")))?;
        let source = resolve_media_path(&entry, self.core.project_dir().as_deref())
            .ok_or_else(|| Error::from_reason("media source path is unavailable"))?;
        let cache = std::env::temp_dir().join("opentake-route-b").join("cache");
        std::fs::create_dir_all(&cache).map_err(|error| Error::from_reason(error.to_string()))?;
        let output = cache.join(format!("{media_id}.png"));
        let engine = opentake_media::MediaEngine::new(&cache, cache.join("models"));
        let frame = match entry.kind {
            ClipType::Video => engine
                .decode_frame(
                    &source,
                    &opentake_media::decode::FrameRequest {
                        time_secs: 0.0,
                        max_size: (320, 320),
                        tolerance_secs: 1.0,
                        apply_rotation: true,
                    },
                )
                .map(|(_, frame)| frame)
                .map_err(|error| Error::from_reason(error.to_string()))?,
            ClipType::Image => opentake_media::thumbnail::image_thumbnail(&source, 320)
                .map_err(|error| Error::from_reason(error.to_string()))?,
            _ => return Ok(String::new()),
        };
        image::save_buffer(
            &output,
            &frame.rgba,
            frame.width,
            frame.height,
            image::ColorType::Rgba8,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(output.to_string_lossy().into_owned())
    }

    /// Normalized whole-source waveform buckets (`0 = loud`, `1 = silence`) for
    /// one imported audio/video asset.
    #[napi]
    pub fn waveform(&self, media_id: String) -> Result<Vec<f64>> {
        let entry = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == media_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("media not found: {media_id}")))?;
        if !matches!(entry.kind, ClipType::Audio | ClipType::Video) {
            return Err(Error::from_reason("media has no audio track"));
        }
        let source = resolve_media_path(&entry, self.core.project_dir().as_deref())
            .ok_or_else(|| Error::from_reason("media source path is unavailable"))?;
        opentake_media::waveform::waveform(&source, entry.duration)
            .map(|samples| samples.into_iter().map(f64::from).collect())
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Apply one Tauri-compatible `EditRequest` JSON object. Returns
    /// `{result, timeline}` where `result` is the `EditResultDto` and `timeline`
    /// is the latest snapshot.
    #[napi]
    pub fn apply(&self, command_json: String) -> Result<String> {
        let request: EditRequest = serde_json::from_str(&command_json)
            .map_err(|error| Error::from_reason(format!("invalid edit request: {error}")))?;
        let command = request
            .into_command()
            .map_err(|error| Error::from_reason(error))?;
        let result = self
            .core
            .apply(command)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let payload = serde_json::json!({
            "result": EditResultDto::from(result),
            "timeline": TimelineSnapshotDto::from(handle_get_timeline(&self.core)),
        });
        json(&payload)
    }

    /// Whether an undo action is available.
    #[napi]
    pub fn can_undo(&self) -> bool {
        self.core.can_undo()
    }

    /// Whether a redo action is available.
    #[napi]
    pub fn can_redo(&self) -> bool {
        self.core.can_redo()
    }

    /// Undo the last edit; returns the updated timeline snapshot.
    #[napi]
    pub fn undo(&self) -> Result<String> {
        self.core
            .undo()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&TimelineSnapshotDto::from(handle_get_timeline(&self.core)))
    }

    /// Redo the last undone edit; returns the updated timeline snapshot.
    #[napi]
    pub fn redo(&self) -> Result<String> {
        self.core
            .redo()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&TimelineSnapshotDto::from(handle_get_timeline(&self.core)))
    }

    // ------------------------------------------------------------------
    // Route B visual search (SigLIP2). Additive surface: configure the
    // persistent models/cache dirs, verify pinned assets, index project
    // video/image assets, and rank text or image queries into Moments.
    // Deterministic text Files/Spoken search stays in the Host JS fallback.
    // ------------------------------------------------------------------

    /// Configure SigLIP2: verify the pinned assets (size + SHA-256), load the
    /// ONNX encoders, and return the capability JSON.
    #[napi]
    pub fn search_configure(&self, models_dir: String, cache_dir: String) -> Result<String> {
        let manifest = search_config::manifest();
        let models = resolve_search_models_root(FsPath::new(&models_dir), &manifest);
        let cache = PathBuf::from(&cache_dir);
        std::fs::create_dir_all(&cache)
            .map_err(|error| Error::from_reason(format!("create search cache dir: {error}")))?;

        let installed = match model_download::verify_installed(&models, &manifest) {
            Ok(installed) => installed,
            Err(error) => {
                let text = error.to_string();
                let detail = if text.to_ascii_lowercase().contains("checksum")
                    || text.to_ascii_lowercase().contains("sha")
                {
                    "checksum_mismatch"
                } else if text.to_ascii_lowercase().contains("missing")
                    || text.to_ascii_lowercase().contains("incomplete")
                {
                    "model_not_installed"
                } else {
                    "model_incomplete"
                };
                *self.search.borrow_mut() = None;
                return json(&search_capability_unavailable(
                    &manifest,
                    Some(&models_dir),
                    detail,
                ));
            }
        };

        let tokenizer_json = installed.tokenizer_folder.join("tokenizer.json");
        let embedder = match SiglipEmbedder::new(
            &installed.image_encoder,
            &installed.text_encoder,
            &tokenizer_json,
            manifest.spec(),
        ) {
            Ok(embedder) => embedder,
            Err(error) => {
                let mut capability =
                    search_capability_unavailable(&manifest, Some(&models_dir), "backend_error");
                capability.installed = true;
                capability.message = Some(error.to_string());
                *self.search.borrow_mut() = None;
                return json(&capability);
            }
        };
        let capability = SearchCapabilityDto {
            model: manifest.model.clone(),
            version: manifest.version,
            expected_bytes: search_manifest_total_bytes(&manifest),
            models_dir: Some(models_dir),
            installed: true,
            backend: search_backend_name().to_string(),
            visual_available: true,
            reason: None,
            detail: None,
            message: None,
        };
        *self.search.borrow_mut() = Some(SearchState {
            cache_dir: cache,
            embedder,
            capability: capability.clone(),
        });
        json(&capability)
    }

    /// Capability JSON without loading the model (configure first for assets).
    #[napi]
    pub fn search_model_status(&self) -> Result<String> {
        let state = self.search.borrow();
        if let Some(state) = state.as_ref() {
            return json(&state.capability);
        }
        let manifest = search_config::manifest();
        json(&search_capability_unavailable(
            &manifest,
            None,
            "models_dir_not_configured",
        ))
    }

    /// Visual-index coverage over the caller's project asset list.
    #[napi]
    pub fn search_index_status(&self, assets_json: String) -> Result<String> {
        let assets = parse_search_assets(&assets_json)?;
        let visual: Vec<&SearchAssetDto> = assets
            .iter()
            .filter(|asset| is_visual_search_asset(asset))
            .collect();
        let state = self.search.borrow();
        let Some(state) = state.as_ref() else {
            return json(&SearchIndexStatusDto {
                model_installed: false,
                visual_available: false,
                indexable: visual.len(),
                indexed: 0,
                reason: Some("visual_unavailable".to_string()),
                detail: Some("models_dir_not_configured".to_string()),
                errors: Vec::new(),
            });
        };
        let spec = search_config::embedder_spec();
        let indexed = visual
            .iter()
            .filter(|asset| {
                let path = FsPath::new(&asset.path);
                path.is_file() && !needs_index(&state.cache_dir, path, &spec)
            })
            .count();
        json(&SearchIndexStatusDto {
            model_installed: true,
            visual_available: true,
            indexable: visual.len(),
            indexed,
            reason: None,
            detail: None,
            errors: Vec::new(),
        })
    }

    /// Index the caller's visual assets (images directly; videos via sampled
    /// frames). Idempotent: already-current indexes are skipped.
    #[napi]
    pub fn search_index_start(&self, assets_json: String) -> Result<String> {
        let assets = parse_search_assets(&assets_json)?;
        let visual: Vec<&SearchAssetDto> = assets
            .iter()
            .filter(|asset| is_visual_search_asset(asset))
            .collect();
        let state = self.search.borrow();
        let Some(state) = state.as_ref() else {
            return json(&SearchIndexStatusDto {
                model_installed: false,
                visual_available: false,
                indexable: visual.len(),
                indexed: 0,
                reason: Some("visual_unavailable".to_string()),
                detail: Some("models_dir_not_configured".to_string()),
                errors: Vec::new(),
            });
        };
        let cancel = CancelToken::new();
        let mut errors = Vec::new();
        for asset in &visual {
            let path = FsPath::new(&asset.path);
            if !path.is_file() {
                errors.push(format!("{}: file not found", asset.id));
                continue;
            }
            let result = if asset.kind == "image" {
                decode_rgba_path(path).and_then(|frame| {
                    index_image(&state.cache_dir, path, &frame, &state.embedder, &cancel)
                        .map_err(|error| Error::from_reason(error.to_string()))
                })
            } else {
                let probed = opentake_media::probe(path).ok();
                let duration = asset
                    .duration_secs
                    .or_else(|| probed.as_ref().map(|probe| probe.duration_secs))
                    .unwrap_or(0.0);
                let width = asset
                    .width
                    .or_else(|| probed.as_ref().and_then(|probe| probe.width))
                    .unwrap_or(1920);
                let height = asset
                    .height
                    .or_else(|| probed.as_ref().and_then(|probe| probe.height))
                    .unwrap_or(1080);
                index_video(
                    &state.cache_dir,
                    path,
                    duration,
                    width,
                    height,
                    &state.embedder,
                    &SamplerOptions::default(),
                    &cancel,
                    None,
                )
                .map_err(|error| Error::from_reason(error.to_string()))
            };
            if let Err(error) = result {
                errors.push(format!("{}: {}", asset.id, error));
            }
        }
        let spec = search_config::embedder_spec();
        let indexed = visual
            .iter()
            .filter(|asset| {
                let path = FsPath::new(&asset.path);
                path.is_file() && !needs_index(&state.cache_dir, path, &spec)
            })
            .count();
        json(&SearchIndexStatusDto {
            model_installed: true,
            visual_available: true,
            indexable: visual.len(),
            indexed,
            reason: None,
            detail: None,
            errors,
        })
    }

    /// Rank a text query against the caller's indexed visual assets.
    #[napi]
    pub fn search_query(
        &self,
        query: String,
        assets_json: String,
        fps: Option<i32>,
    ) -> Result<String> {
        let assets = parse_search_assets(&assets_json)?;
        let state = self.search.borrow();
        let Some(state) = state.as_ref() else {
            return json(&SearchQueryResultDto {
                moments: Vec::new(),
                visual_available: false,
                visual_error: Some("visual_unavailable".to_string()),
                visual_error_detail: Some("models_dir_not_configured".to_string()),
                query_kind: "text".to_string(),
            });
        };
        if query.trim().is_empty() {
            return json(&SearchQueryResultDto {
                moments: Vec::new(),
                visual_available: true,
                visual_error: None,
                visual_error_detail: None,
                query_kind: "text".to_string(),
            });
        }
        let vector = match state.embedder.encode_text(&query) {
            Ok(vector) => vector,
            Err(error) => {
                return json(&SearchQueryResultDto {
                    moments: Vec::new(),
                    visual_available: true,
                    visual_error: Some("visual_error".to_string()),
                    visual_error_detail: Some(error.to_string()),
                    query_kind: "text".to_string(),
                });
            }
        };
        let moments = search_rank(&state.cache_dir, &vector, &assets, fps.unwrap_or(30));
        json(&SearchQueryResultDto {
            moments,
            visual_available: true,
            visual_error: None,
            visual_error_detail: None,
            query_kind: "text".to_string(),
        })
    }

    /// Rank an image query (base64 PNG/JPEG) against the caller's indexed
    /// visual assets.
    #[napi]
    pub fn search_query_image(
        &self,
        image_base64: String,
        assets_json: String,
        fps: Option<i32>,
    ) -> Result<String> {
        let assets = parse_search_assets(&assets_json)?;
        let state = self.search.borrow();
        let Some(state) = state.as_ref() else {
            return json(&SearchQueryResultDto {
                moments: Vec::new(),
                visual_available: false,
                visual_error: Some("visual_unavailable".to_string()),
                visual_error_detail: Some("models_dir_not_configured".to_string()),
                query_kind: "image".to_string(),
            });
        };
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image_base64.as_bytes())
            .map_err(|error| Error::from_reason(format!("invalid base64 image: {error}")))?;
        let frame = decode_rgba_bytes(&bytes)?;
        let vector = match state.embedder.encode_image(&frame) {
            Ok(vector) => vector,
            Err(error) => {
                return json(&SearchQueryResultDto {
                    moments: Vec::new(),
                    visual_available: true,
                    visual_error: Some("visual_error".to_string()),
                    visual_error_detail: Some(error.to_string()),
                    query_kind: "image".to_string(),
                });
            }
        };
        let moments = search_rank(&state.cache_dir, &vector, &assets, fps.unwrap_or(30));
        json(&SearchQueryResultDto {
            moments,
            visual_available: true,
            visual_error: None,
            visual_error_detail: None,
            query_kind: "image".to_string(),
        })
    }
}

/// Load each indexed visual asset's `PALMEMB1` index and rank the query vector
/// with the desktop ranker (best-per-shot, floor, limit, relative cutoff).
fn search_rank(
    cache_dir: &FsPath,
    query: &[f32],
    assets: &[SearchAssetDto],
    fps: i32,
) -> Vec<SearchMomentDto> {
    let mut indexes = Vec::new();
    for asset in assets.iter().filter(|asset| is_visual_search_asset(asset)) {
        let path = FsPath::new(&asset.path);
        let Some(key) = embed_store::key(path) else {
            continue;
        };
        if let Ok(index) = embed_store::load(cache_dir, &key) {
            indexes.push((asset.id.clone(), index));
        }
    }
    ranker::search(
        query,
        &indexes,
        search_config::SEARCH_LIMIT,
        search_config::RELATIVE_CUTOFF,
        Some(search_config::VISUAL_MATCH_COSINE_FLOOR),
    )
    .into_iter()
    .map(|hit| moment_dto(hit, fps))
    .collect()
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod hdr_overlay_tests {
    use super::*;

    #[test]
    fn sdr_white_maps_to_203_nits_linear_bt2020() {
        let frame = RgbaFrame::new(1, 1, vec![255, 255, 255, 255]);
        let linear = sdr_rgba8_to_linear_frame(&frame, false).unwrap();
        let pixel = linear.pixel(0, 0).unwrap();
        let expected = 203.0 / 10_000.0;
        for channel in 0..3 {
            assert!(
                (pixel[channel] - expected).abs() < 1e-4,
                "channel {channel}: {pixel:?}"
            );
        }
        assert!((pixel[3] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn premultiplied_sdr_is_unpremultiplied_before_conversion() {
        let straight =
            sdr_rgba8_to_linear_frame(&RgbaFrame::new(1, 1, vec![255, 255, 255, 255]), false)
                .unwrap()
                .pixel(0, 0)
                .unwrap();
        let premultiplied =
            sdr_rgba8_to_linear_frame(&RgbaFrame::new(1, 1, vec![128, 128, 128, 128]), true)
                .unwrap()
                .pixel(0, 0)
                .unwrap();
        // Half-alpha premultiplied white must recover roughly the same linear
        // white, with half alpha.
        for channel in 0..3 {
            assert!(
                (premultiplied[channel] - straight[channel]).abs() < 0.02,
                "channel {channel}: straight={straight:?} premul={premultiplied:?}"
            );
        }
        assert!((premultiplied[3] - 0.502).abs() < 0.01);
    }
}

#[cfg(test)]
mod hdr_grade_tests {
    use super::*;

    #[test]
    fn exposure_grade_runs_in_sdr_white_relative_linear_space() {
        let frame = LinearFrame::from_f32(
            1,
            1,
            &[0.0203, 0.0203, 0.0203, 1.0],
            LinearPrimaries::Bt2020,
            LinearTransfer::Linear,
        )
        .unwrap();
        let mut grade = ColorGrade::default();
        grade.exposure = 1.0;
        let graded = apply_linear_color_pipeline(&frame, Some(&grade), None, None).unwrap();
        let pixel = graded.pixel(0, 0).unwrap();
        assert!((pixel[0] - 0.0406).abs() < 1e-4, "pixel={pixel:?}");
        assert!((pixel[3] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cube_lut_identity_table_is_sampled_in_wire_order() {
        let size = 17u32;
        let mut text = format!("TITLE \"identity\"\nLUT_3D_SIZE {size}\n");
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    text.push_str(&format!(
                        "{:.6} {:.6} {:.6}\n",
                        r as f32 / (size - 1) as f32,
                        g as f32 / (size - 1) as f32,
                        b as f32 / (size - 1) as f32,
                    ));
                }
            }
        }
        let lut = CubeLut::parse(text.as_bytes()).unwrap();
        assert_eq!(lut.size(), size);
        let sampled = sample_cube_lut(&lut, [0.25, 0.5, 0.75]);
        assert!((sampled[0] - 0.25).abs() < 1e-5, "sampled={sampled:?}");
        assert!((sampled[1] - 0.5).abs() < 1e-5);
        assert!((sampled[2] - 0.75).abs() < 1e-5);
    }
}
