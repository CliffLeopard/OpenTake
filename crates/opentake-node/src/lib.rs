//! Node-API boundary for the OpenTake Rust engine.
//!
//! This is the Route B spike: the DSH Host loads this addon in-process and
//! drives the same `opentake-core::AppCore` the desktop app uses. The first
//! milestone exposes project lifecycle + timeline snapshots; editing commands
//! will be added by extracting the Tauri `EditRequest` serde mirror into a
//! reusable crate.

use napi::bindgen_prelude::*;

mod edit_request;

use edit_request::EditRequest;
use napi_derive::napi;
use opentake_core::dto::{handle_get_timeline, handle_project_new, handle_project_open, handle_project_save, EditResultDto, TimelineSnapshotDto};
use opentake_core::session::ProbedMedia;
use opentake_render::{
    gpu::{upload_rgba, Compositor, CosmicTextRasterizer, GpuTexture, RenderDevice, TextRasterRequest, TextRasterizer, TextureResolver},
    plan::{try_build_render_plan, RenderSize, TextureSource},
    source::{DecodedFrame, SourceMetrics},
};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::rc::Rc;
use opentake_domain::{ClipType, MediaManifestEntry, MediaSource};
use opentake_media::encode::{mix_clips, ClipAudio, MIX_SAMPLE_RATE};
use opentake_media::library::{FavoriteRequest, LibraryStore};
use opentake_media::decode::pcm::{PcmBuffer, PcmFormat, PcmSpec};

fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|error| Error::from_reason(error.to_string()))
}

fn resolve_media_path(entry: &MediaManifestEntry, project_dir: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    match &entry.source {
        MediaSource::External { absolute_path } => Some(std::path::PathBuf::from(absolute_path)),
        MediaSource::Project { relative_path } => project_dir.map(|root| root.join(relative_path)),
    }
}

fn lottie_document_bytes(path: &std::path::Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    if path.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("lottie")) {
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
    let start = value.get("ip").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let end = value.get("op").and_then(serde_json::Value::as_f64).unwrap_or(frame_rate);
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
    let extension = path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase);
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
        .map(|folder| serde_json::json!({
            "id": folder.id,
            "name": folder.name,
            "parentFolderId": folder.parent_folder_id,
        }))
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
        let frame_count = ((composition.frames.end - composition.frames.start).ceil() as i64).max(1);
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
            self.scene_renderer.render(composition, frame, transform, 1.0)
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
            size: opentake_render::wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
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
        Some(Rc::new(GpuTexture { texture, view, width, height }))
    }
}

struct TextInfo {
    content: String,
    style: opentake_domain::TextStyle,
    box_norm: (f64, f64, f64, f64),
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
                return self.lottie.resolve(self.device, self.queue, path, source_frame, self.canvas);
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
                    box_norm: (top_left.x, top_left.y, clip.transform.width, clip.transform.height),
                },
            );
        }
    }
    let metrics = ManifestMetrics { sizes, straight_alpha };
    let plan = try_build_render_plan(timeline, render_size, &metrics)?;
    let mut frame_plan = plan.frame(timeline, frame);
    if transparent {
        frame_plan.clear_rgba = [0.0, 0.0, 0.0, 0.0];
    }
    let device = RenderDevice::try_new().map_err(|error| error.to_string())?;
    let compositor = Compositor::new(&device.device);
    let cache = std::env::temp_dir().join("opentake-route-b").join("cache");
    let media_engine = opentake_media::MediaEngine::new(&cache, cache.join("models"));
    let text_rasterizer = CosmicTextRasterizer::new();
    let mut lottie = LottieState::new();
    let mut resolver = BasicResolver {
        device: &device.device,
        queue: &device.queue,
        engine: &media_engine,
        text: &text,
        text_rasterizer: &text_rasterizer,
        lottie: &mut lottie,
        canvas: (render_size.width, render_size.height),
        media: &media,
        timeline_fps: timeline.fps,
        cache: HashMap::new(),
    };
    compositor
        .render_to_rgba(&device.device, &device.queue, render_size, &frame_plan, &mut resolver)
        .map_err(|error| error.to_string())
}

fn composite_frame_json(core: &opentake_core::AppCore, frame: i32, max_size: Option<u32>) -> std::result::Result<serde_json::Value, String> {
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
    Ok(serde_json::json!({ "width": rendered.width, "height": rendered.height, "dataUrl": data_url }))
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
                if let Some(sequence) = timeline.nested_sequences.iter().find(|sequence| sequence.id == sequence_id) {
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
            let Some(entry) = media_entries.iter().find(|entry| entry.id == clip.media_ref) else {
                continue;
            };
            let Some(path) = resolve_media_path(entry, project_dir) else {
                continue;
            };
            let fps = timeline.fps.max(1) as f64;
            let start_secs = clip.trim_start_frame.max(0) as f64 / fps;
            let end_secs = start_secs + clip.duration_frames.max(1) as f64 / fps;
            let spec = PcmSpec { sample_rate: MIX_SAMPLE_RATE, channels: 1, format: PcmFormat::F32 };
            let Ok(pcm) = opentake_media::extract_pcm(&path, &spec, Some((start_secs, end_secs))) else {
                continue;
            };
            if pcm.samples_f32.is_empty() {
                continue;
            }
            let start_frame = frame_offset + clip.start_frame.max(0);
            let start_sample = ((start_frame as f64 / fps) * f64::from(MIX_SAMPLE_RATE)).round() as usize;
            let sample_count = pcm.samples_f32.len();
            let fade_in_samples = ((clip.fade_in_frames.max(0) as f64 / fps) * f64::from(MIX_SAMPLE_RATE)).round() as usize;
            let fade_out_samples = ((clip.fade_out_frames.max(0) as f64 / fps) * f64::from(MIX_SAMPLE_RATE)).round() as usize;
            let gains = if fade_in_samples == 0 && fade_out_samples == 0 && (clip.volume - 1.0).abs() < f64::EPSILON {
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
            out.push(ClipAudio { start_sample, samples: pcm.samples_f32, gains });
        }
    }
}

struct ExportSession {
    encoder: opentake_media::VideoEncoder,
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

#[napi]
pub struct Engine {
    core: opentake_core::AppCore,
    export: RefCell<Option<ExportSession>>,
    library: Option<LibraryStore>,
}

#[napi]
impl Engine {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            core: opentake_core::AppCore::new(),
            export: RefCell::new(None),
            library: LibraryStore::open_default().ok(),
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
            std::fs::create_dir_all(parent).map_err(|error| Error::from_reason(error.to_string()))?;
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
        if let Some(session) = self.export.borrow_mut().take() {
            let path = session.out_path;
            drop(session.encoder);
            let _ = std::fs::remove_file(path);
            return true;
        }
        false
    }

    fn mix_timeline_audio(&self, timeline: &opentake_domain::Timeline) -> Option<PcmBuffer> {
        let media_entries = self.core.media().entries;
        let project_dir = self.core.project_dir();
        let mut clips: Vec<ClipAudio> = Vec::new();
        collect_audio_clips(timeline, 0, 0, &media_entries, project_dir.as_deref(), &mut clips);
        let Ok(mixed) = mix_clips(&clips) else {
            return None;
        };
        if mixed.is_empty() {
            return None;
        }
        Some(PcmBuffer {
            spec: PcmSpec { sample_rate: MIX_SAMPLE_RATE, channels: 1, format: PcmFormat::F32 },
            samples_f32: mixed,
        })
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
    ) -> Result<String> {
        self.export_cancel_inner();
        let timeline = self.core.get_timeline().timeline;
        let resolution = match quality.as_str() {
            "720p" => opentake_render::ExportResolution::R720p,
            "4k" => opentake_render::ExportResolution::R4k,
            _ => opentake_render::ExportResolution::R1080p,
        };
        let render_size = opentake_render::export_render_size((timeline.width, timeline.height), resolution);
        let video_codec = match codec.as_str() {
            "h265" => opentake_media::VideoCodec::H265,
            "prores" => opentake_media::VideoCodec::ProRes422,
            "prores4444" => opentake_media::VideoCodec::ProRes4444,
            _ => opentake_media::VideoCodec::H264,
        };
        let preset = opentake_media::ExportPreset::new(video_codec, opentake_media::ExportResolution::P1080);
        let out = std::path::PathBuf::from(&out_path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|error| Error::from_reason(error.to_string()))?;
        }
        let encoder = opentake_media::VideoEncoder::new(&out, render_size.width, render_size.height, timeline.fps, &preset)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let audio = self.mix_timeline_audio(&timeline);
        let timeline_frames = timeline.total_frames().max(1);
        let start_frame = range_start.unwrap_or(0).clamp(0, timeline_frames - 1);
        let end_frame = range_end.unwrap_or(timeline_frames).clamp(start_frame + 1, timeline_frames);
        let total = end_frame - start_frame;
        *self.export.borrow_mut() = Some(ExportSession {
            encoder,
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
        json(&serde_json::json!({
            "width": render_size.width,
            "height": render_size.height,
            "fps": timeline.fps,
            "total": total,
        }))
    }

    /// Render up to `frames` more frames; returns `{done,total}`.
    #[napi]
    pub fn export_step(&self, frames: u32) -> Result<String> {
        let mut guard = self.export.borrow_mut();
        let session = guard.as_mut().ok_or_else(|| Error::from_reason("no export session"))?;
        let size = opentake_render::plan::RenderSize::new(session.width, session.height);
        let end = (session.next_frame + frames as i32).min(session.end_frame);
        while session.next_frame < end {
            let frame = session.next_frame;
            let decoded = composite_frame_decoded(&self.core, frame, size, session.transparent)
                .map_err(|message| Error::from_reason(message))?;
            let rgba = opentake_media::RgbaFrame::new(decoded.width, decoded.height, decoded.rgba);
            session
                .encoder
                .push_frame(&rgba)
                .map_err(|error| Error::from_reason(error.to_string()))?;
            session.next_frame += 1;
        }
        json(&serde_json::json!({ "done": session.next_frame - session.start_frame, "total": session.total }))
    }

    /// Finish the active export and return the UI ExportSummary JSON.
    #[napi]
    pub fn export_finish(&self) -> Result<String> {
        let mut session = self
            .export
            .borrow_mut()
            .take()
            .ok_or_else(|| Error::from_reason("no export session"))?;
        let has_audio = session.audio.is_some();
        if let Some(pcm) = session.audio.take() {
            session
                .encoder
                .push_audio(pcm)
                .map_err(|error| Error::from_reason(error.to_string()))?;
        }
        session
            .encoder
            .finish()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&serde_json::json!({
            "outPath": session.out_path.to_string_lossy(),
            "width": session.width,
            "height": session.height,
            "fps": session.fps,
            "frameCount": session.total,
            "hasAudio": has_audio,
        }))
    }

    /// Cancel the active export and remove the partial output.
    #[napi]
    pub fn export_cancel(&self) -> bool {
        self.export_cancel_inner()
    }

    /// Blocking convenience export (used by the agent tool).
    #[napi]
    pub fn export_video(&self, out_path: String, codec: String, quality: String) -> Result<String> {
        self.export_begin(out_path, codec, quality, None, None)?;
        loop {
            let done = {
                let guard = self.export.borrow();
                let session = guard.as_ref().ok_or_else(|| Error::from_reason("no export session"))?;
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
    pub fn create_media_proxy(&self, media_id: String, max_width: u32, max_height: u32) -> Result<String> {
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
            .and_then(|clip| self.core.media().entries.iter().find(|entry| entry.id == clip.media_ref).cloned())
            .ok_or_else(|| Error::from_reason(format!("media not found: {media_id}")))?;
        let source = resolve_media_path(&entry, Some(&project_dir))
            .ok_or_else(|| Error::from_reason("media source path is unavailable"))?;
        let proxy_dir = project_dir.join("media").join("proxies");
        std::fs::create_dir_all(&proxy_dir).map_err(|error| Error::from_reason(error.to_string()))?;
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
            .set_media_proxy_for_project(snapshot.project_epoch, &project_dir, &media_id, Some(proxy))
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
        let Some(project_dir) = self.core.project_dir() else { return false };
        let snapshot = self.core.get_timeline();
        let Some(entry) = self.core.media().entries.iter().find(|entry| entry.id == media_id).cloned() else { return false };
        let proxy_path = entry.proxy.as_ref().map(|proxy| project_dir.join(&proxy.relative_path));
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
                RenderSize::new(snapshot.timeline.width.max(2) as u32, snapshot.timeline.height.max(2) as u32),
                false,
            )
            .map_err(|message| Error::from_reason(message))?
        };
        let directory = project_dir
            .as_ref()
            .map(|root| root.join("media").join("captures"))
            .unwrap_or_else(|| std::env::temp_dir().join("opentake-route-b").join("captures"));
        std::fs::create_dir_all(&directory).map_err(|error| Error::from_reason(error.to_string()))?;
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
            "otio" => opentake_project::export_otio(
                &snapshot.timeline,
                &manifest,
                project_dir.as_deref(),
            ),
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
        let project_dir = self
            .core
            .project_dir()
            .ok_or_else(|| Error::from_reason("save the project before changing global favorites"))?;
        let entry = self
            .core
            .media()
            .entries
            .iter()
            .find(|entry| entry.id == media_id)
            .cloned()
            .ok_or_else(|| Error::from_reason(format!("media asset not found: {media_id}")))?;
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
        if favorite {
            let source = resolve_media_path(&entry, Some(&project_dir))
                .ok_or_else(|| Error::from_reason("media source could not be resolved"))?;
            if !source.is_file() {
                return Err(Error::from_reason("media source is offline; relink before favoriting"));
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
                .set_media_favorite_for_project(snapshot.project_epoch, &project_dir, &[media_id.clone()], true)
                .map_err(|error| Error::from_reason(error.to_string()))?;
        } else {
            let manifest = self.core.media();
            let library_id = manifest.library_favorite_id(&media_id).map(str::to_string);
            if let Some(id) = library_id {
                let _ = store.remove(&id);
            }
            self.core
                .set_media_global_favorite_for_project(snapshot.project_epoch, &project_dir, &media_id, None)
                .map_err(|error| Error::from_reason(error.to_string()))?;
            self.core
                .set_media_favorite_for_project(snapshot.project_epoch, &project_dir, &[media_id], false)
                .map_err(|error| Error::from_reason(error.to_string()))?;
        }
        json(&media_list_json(&self.core))
    }

    /// Global library entries (optionally filtered; empty string = all).
    #[napi]
    pub fn library_list(&self, category: Option<String>) -> Result<String> {
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let entries = match category.as_deref() {
            Some(value) if !value.is_empty() => store.entries_in_category(Some(value)),
            _ => store.entries(),
        }
        .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&entries)
    }

    /// Favorite a source file into the global library.
    #[napi]
    pub fn library_favorite(&self, source: String, kind: String, category: Option<String>, thumb: Option<String>) -> Result<String> {
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
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
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
        store.remove(&id).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Update one entry's category; returns the updated entry or null.
    #[napi]
    pub fn library_categorize(&self, id: String, category: Option<String>) -> Result<String> {
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let updated = store
            .set_category(&id, category.filter(|value| !value.is_empty()))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        json(&updated)
    }

    /// Rename a library category (empty target = uncategorized); returns count.
    #[napi]
    pub fn library_rename(&self, from: String, to: Option<String>) -> Result<u32> {
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let count = store
            .rename_category(&from, to.filter(|value| !value.is_empty()))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(count as u32)
    }

    /// Delete one library entry; returns whether it existed.
    #[napi]
    pub fn library_delete(&self, id: String) -> Result<bool> {
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
        store.remove(&id).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Import one global-library entry into the current project as a new asset.
    #[napi]
    pub fn library_import_to_project(&self, id: String) -> Result<String> {
        let store = self.library.as_ref().ok_or_else(|| Error::from_reason("global library unavailable"))?;
        let entries = store.entries().map_err(|error| Error::from_reason(error.to_string()))?;
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
        json(&serde_json::json!({ "id": imported.id, "name": imported.name, "path": path.to_string_lossy() }))
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
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
