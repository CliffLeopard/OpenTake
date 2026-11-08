//! Search query contract + ranking for the isolated Route B slice.
//!
//! The slice is deliberately backend-agnostic:
//! - [`VisualBackend`] is the hook the real integration fills with the desktop
//!   engine's ONNX embedder (`opentake_media::search::OrtEmbedder`, feature
//!   `ort-backend`). This standalone crate ships [`NoVisualBackend`] so the
//!   default build stays offline, dependency-free and free of ONNX Runtime.
//! - Files/Spoken search is always available and deterministic (see
//!   [`crate::lexical`]); visual Moments only exist when a complete model is
//!   installed *and* a backend is linked. Otherwise the result says
//!   `visual_unavailable` instead of fabricating Moments.
//! - Indexed frame embeddings are passed in by the caller: the real integration
//!   loads them from the `PALMEMB1` store (`opentake-media::search::embed_store`);
//!   tests build synthetic indexes with a deterministic mock backend.

use crate::json;
use crate::lexical::{self, Asset, FileHit, SpokenHit};
use crate::model::{VisualCapability, BACKEND_NONE};

/// Desktop defaults (`Search/SearchIndexConfig.swift`).
pub const SEARCH_LIMIT: usize = 20;
pub const VISUAL_MATCH_COSINE_FLOOR: f32 = 0.05;
pub const RELATIVE_CUTOFF: f32 = 0.85;

/// Stable visual status codes returned to the Host.
pub const VISUAL_UNAVAILABLE: &str = "visual_unavailable";
pub const VISUAL_ERROR: &str = "visual_error";

/// Backend failure vocabulary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchError {
    BackendUnavailable,
    Inference(String),
    DimensionMismatch { expected: usize, actual: usize },
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SearchError::BackendUnavailable => write!(f, "visual backend is not linked"),
            SearchError::Inference(message) => write!(f, "inference failed: {message}"),
            SearchError::DimensionMismatch { expected, actual } => {
                write!(
                    f,
                    "embedding dimension mismatch: expected {expected}, got {actual}"
                )
            }
        }
    }
}

impl std::error::Error for SearchError {}

/// Dual-encoder inference hook. Implementations must be deterministic for a
/// given input (pure functions are easiest to test).
pub trait VisualBackend: Send + Sync {
    /// Stable identity used in status JSON: `ort-native`, `ort-tract`, `mock`…
    fn backend_name(&self) -> &'static str;
    fn embedding_dim(&self) -> usize;
    fn embed_text(&self, text: &str) -> Result<Vec<f32>, SearchError>;
    fn embed_image(&self, image: &[u8]) -> Result<Vec<f32>, SearchError>;
}

/// Default backend: explicit "not linked", never fake inference.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoVisualBackend;

impl VisualBackend for NoVisualBackend {
    fn backend_name(&self) -> &'static str {
        BACKEND_NONE
    }
    fn embedding_dim(&self) -> usize {
        0
    }
    fn embed_text(&self, _text: &str) -> Result<Vec<f32>, SearchError> {
        Err(SearchError::BackendUnavailable)
    }
    fn embed_image(&self, _image: &[u8]) -> Result<Vec<f32>, SearchError> {
        Err(SearchError::BackendUnavailable)
    }
}

/// One frame embedding from a `PALMEMB1` index. `shot_start`/`shot_end` are
/// source seconds (equal for stills).
#[derive(Clone, Debug, PartialEq)]
pub struct IndexedFrame {
    pub time: f64,
    pub shot_start: f64,
    pub shot_end: f64,
    pub vector: Vec<f32>,
}

/// Per-asset frame embeddings loaded from the embed store.
#[derive(Clone, Debug, PartialEq)]
pub struct IndexedAsset {
    pub id: String,
    pub frames: Vec<IndexedFrame>,
}

impl IndexedAsset {
    pub fn new(id: impl Into<String>, frames: Vec<IndexedFrame>) -> Self {
        IndexedAsset {
            id: id.into(),
            frames,
        }
    }
}

/// One visual ("Moments") hit — same fields as the desktop `MomentHitDto`.
#[derive(Clone, Debug, PartialEq)]
pub struct MomentHit {
    pub media_id: String,
    pub frame: i64,
    pub start_sec: f64,
    pub end_sec: f64,
    pub score: f32,
    pub is_image: bool,
}

/// The full three-group query result (desktop `SearchResultsDto` shape, plus the
/// explicit capability fields this workstream adds).
#[derive(Clone, Debug, PartialEq)]
pub struct SearchResults {
    pub moments: Vec<MomentHit>,
    pub spoken: Vec<SpokenHit>,
    pub files: Vec<FileHit>,
    pub visual_available: bool,
    /// `null` when visual search ran (even if the index was empty); stable code
    /// `visual_unavailable` or `visual_error` otherwise.
    pub visual_error: Option<&'static str>,
    pub visual_error_detail: Option<String>,
    pub query_kind: &'static str,
}

impl SearchResults {
    pub fn empty(query_kind: &'static str) -> Self {
        SearchResults {
            moments: Vec::new(),
            spoken: Vec::new(),
            files: Vec::new(),
            visual_available: false,
            visual_error: None,
            visual_error_detail: None,
            query_kind,
        }
    }

    /// Exact JSON payload returned by the probe CLI and recommended to the Host.
    /// camelCase matches the frontend `SearchResults` type.
    pub fn to_json(&self) -> String {
        let moments = self
            .moments
            .iter()
            .map(moment_json)
            .collect::<Vec<_>>()
            .join(",");
        let spoken = self
            .spoken
            .iter()
            .map(spoken_json)
            .collect::<Vec<_>>()
            .join(",");
        let files = self
            .files
            .iter()
            .map(|hit| {
                format!(
                    "{{\"mediaId\":{},\"score\":{}}}",
                    json::string(&hit.media_id),
                    json::f32_number(hit.score)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let visual_error = match self.visual_error {
            Some(code) => json::string(code),
            None => "null".to_string(),
        };
        let detail = match &self.visual_error_detail {
            Some(detail) => json::string(detail),
            None => "null".to_string(),
        };
        format!(
            concat!(
                "{{",
                "\"moments\":[{}],",
                "\"spoken\":[{}],",
                "\"files\":[{}],",
                "\"visualAvailable\":{},",
                "\"visualError\":{},",
                "\"visualErrorDetail\":{},",
                "\"queryKind\":{}",
                "}}"
            ),
            moments,
            spoken,
            files,
            self.visual_available,
            visual_error,
            detail,
            json::string(self.query_kind),
        )
    }
}

fn moment_json(hit: &MomentHit) -> String {
    format!(
        concat!(
            "{{",
            "\"mediaId\":{},",
            "\"frame\":{},",
            "\"startSec\":{},",
            "\"endSec\":{},",
            "\"score\":{},",
            "\"isImage\":{}",
            "}}"
        ),
        json::string(&hit.media_id),
        hit.frame,
        json::f64_number(hit.start_sec),
        json::f64_number(hit.end_sec),
        json::f32_number(hit.score),
        hit.is_image,
    )
}

fn spoken_json(hit: &SpokenHit) -> String {
    format!(
        concat!(
            "{{",
            "\"mediaId\":{},",
            "\"startSec\":{},",
            "\"endSec\":{},",
            "\"text\":{},",
            "\"score\":{}",
            "}}"
        ),
        json::string(&hit.media_id),
        json::f64_number(hit.start_sec),
        json::f64_number(hit.end_sec),
        json::string(&hit.text),
        json::f32_number(hit.score),
    )
}

/// The query service. Holds an optional backend and the capability verdict that
/// gates visual results.
pub struct SearchService<'a> {
    backend: Option<&'a dyn VisualBackend>,
    capability: VisualCapability,
    fps: i32,
    limit: usize,
    relative_cutoff: f32,
    min_score: f32,
}

impl<'a> SearchService<'a> {
    pub fn new(
        backend: Option<&'a dyn VisualBackend>,
        capability: VisualCapability,
        fps: i32,
    ) -> Self {
        SearchService {
            backend,
            capability,
            fps: if fps > 0 { fps } else { 30 },
            limit: SEARCH_LIMIT,
            relative_cutoff: RELATIVE_CUTOFF,
            min_score: VISUAL_MATCH_COSINE_FLOOR,
        }
    }

    /// Tuning hook for tests/benchmarks; the Host contract uses the defaults.
    pub fn with_limits(mut self, limit: usize, relative_cutoff: f32, min_score: f32) -> Self {
        self.limit = limit;
        self.relative_cutoff = relative_cutoff;
        self.min_score = min_score;
        self
    }

    pub fn capability(&self) -> &VisualCapability {
        &self.capability
    }

    pub fn fps(&self) -> i32 {
        self.fps
    }

    /// Text query: Files + Spoken are always available; Moments only when the
    /// capability and backend both allow it.
    pub fn query_text(
        &self,
        assets: &[Asset],
        indexes: &[IndexedAsset],
        query: &str,
    ) -> SearchResults {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            let mut results = SearchResults::empty("text");
            results.visual_available = self.capability.visual_available;
            return results;
        }
        let (moments, visual_error, detail) = match self.backend {
            None => (
                Vec::new(),
                Some(VISUAL_UNAVAILABLE),
                self.unavailable_detail(),
            ),
            Some(_) if !self.capability.visual_available => (
                Vec::new(),
                Some(VISUAL_UNAVAILABLE),
                self.unavailable_detail(),
            ),
            Some(backend) => match backend.embed_text(trimmed) {
                Ok(vector) => match self.rank(&vector, indexes) {
                    Ok(moments) => (moments, None, None),
                    Err(error) => (Vec::new(), Some(VISUAL_ERROR), Some(error.to_string())),
                },
                Err(error) => (Vec::new(), Some(VISUAL_ERROR), Some(error.to_string())),
            },
        };
        SearchResults {
            moments,
            spoken: lexical::matched_spoken(assets, trimmed, self.limit),
            files: lexical::matched_files(assets, trimmed, self.limit),
            visual_available: self.capability.visual_available,
            visual_error,
            visual_error_detail: detail,
            query_kind: "text",
        }
    }

    /// Image query: no text fallback groups; the visual encoder ranks the image
    /// against the indexed frames. When no backend/model is available this is a
    /// deterministic `visual_unavailable` result, never a fake Moment.
    pub fn query_image(
        &self,
        _assets: &[Asset],
        indexes: &[IndexedAsset],
        image: &[u8],
    ) -> SearchResults {
        let (moments, visual_error, detail) = match self.backend {
            None => (
                Vec::new(),
                Some(VISUAL_UNAVAILABLE),
                self.unavailable_detail(),
            ),
            Some(_) if !self.capability.visual_available => (
                Vec::new(),
                Some(VISUAL_UNAVAILABLE),
                self.unavailable_detail(),
            ),
            Some(backend) => match backend.embed_image(image) {
                Ok(vector) => match self.rank(&vector, indexes) {
                    Ok(moments) => (moments, None, None),
                    Err(error) => (Vec::new(), Some(VISUAL_ERROR), Some(error.to_string())),
                },
                Err(error) => (Vec::new(), Some(VISUAL_ERROR), Some(error.to_string())),
            },
        };
        SearchResults {
            moments,
            spoken: Vec::new(),
            files: Vec::new(),
            visual_available: self.capability.visual_available,
            visual_error,
            visual_error_detail: detail,
            query_kind: "image",
        }
    }

    fn unavailable_detail(&self) -> Option<String> {
        Some(
            self.capability
                .detail
                .unwrap_or("backend_not_linked")
                .to_string(),
        )
    }

    /// Rank a query vector against the caller-supplied frame indexes. Mirrors the
    /// desktop ranker: dot product, best row per shot, score-sorted, absolute
    /// floor, limit first, then relative cutoff.
    pub fn rank(
        &self,
        query: &[f32],
        indexes: &[IndexedAsset],
    ) -> Result<Vec<MomentHit>, SearchError> {
        if query.is_empty() {
            return Err(SearchError::DimensionMismatch {
                expected: 1,
                actual: 0,
            });
        }
        // Best frame per (asset, shot_start); insertion order is the encounter
        // order so ties stay deterministic (stable sort by score).
        let mut best: Vec<(usize, u64, usize, f32)> = Vec::new();
        for (asset_index, asset) in indexes.iter().enumerate() {
            for (frame_index, frame) in asset.frames.iter().enumerate() {
                if frame.vector.len() != query.len() {
                    return Err(SearchError::DimensionMismatch {
                        expected: query.len(),
                        actual: frame.vector.len(),
                    });
                }
                let score = dot(query, &frame.vector);
                if !score.is_finite() {
                    continue;
                }
                let shot = frame.shot_start.to_bits();
                if let Some(slot) = best
                    .iter_mut()
                    .find(|(a, s, _, _)| *a == asset_index && *s == shot)
                {
                    if score > slot.3 {
                        slot.2 = frame_index;
                        slot.3 = score;
                    }
                } else {
                    best.push((asset_index, shot, frame_index, score));
                }
            }
        }
        let mut hits: Vec<(MomentHit, usize)> = best
            .into_iter()
            .map(|(asset_index, _, frame_index, score)| {
                let asset = &indexes[asset_index];
                let frame = &asset.frames[frame_index];
                (
                    MomentHit {
                        media_id: asset.id.clone(),
                        frame: (frame.shot_start * self.fps as f64).round() as i64,
                        start_sec: frame.shot_start,
                        end_sec: frame.shot_end,
                        score,
                        is_image: frame.shot_end <= frame.shot_start,
                    },
                    asset_index,
                )
            })
            .collect();
        // Stable score-descending sort (ties keep index order).
        hits.sort_by(|left, right| {
            right
                .0
                .score
                .partial_cmp(&left.0.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut moments: Vec<MomentHit> = Vec::new();
        let mut top: Option<f32> = None;
        for (hit, _) in hits {
            if hit.score < self.min_score {
                continue;
            }
            if top.is_none() {
                top = Some(hit.score);
                if hit.score <= 0.0 {
                    return Ok(Vec::new());
                }
            }
            moments.push(hit);
            if moments.len() >= self.limit {
                break;
            }
        }
        let Some(top) = top else {
            return Ok(Vec::new());
        };
        let floor = top * self.relative_cutoff;
        moments.retain(|hit| hit.score >= floor);
        Ok(moments)
    }
}

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{VisualCapability, BACKEND_NONE, MODEL_NAME, MODEL_VERSION, TOTAL_BYTES};

    fn capability(available: bool) -> VisualCapability {
        VisualCapability {
            model: MODEL_NAME,
            version: MODEL_VERSION,
            expected_bytes: TOTAL_BYTES,
            models_dir: None,
            installed: available,
            backend: if available { "mock" } else { BACKEND_NONE },
            visual_available: available,
            reason: if available {
                None
            } else {
                Some(VISUAL_UNAVAILABLE)
            },
            detail: if available {
                None
            } else {
                Some("model_not_installed")
            },
        }
    }

    /// Deterministic 4-dim "embedding": FNV-1a hash of the bytes spread over four
    /// normalized lanes. Distinct inputs are very unlikely to collide; tests use
    /// exact inputs, so determinism is what matters.
    #[derive(Clone, Copy, Default)]
    struct MockBackend;

    fn mock_vector(bytes: &[u8]) -> Vec<f32> {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut lanes = [0u64; 4];
        for (i, byte) in bytes.iter().enumerate() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            lanes[i % 4] = lanes[i % 4].wrapping_add(hash);
        }
        let mut out: Vec<f32> = lanes
            .iter()
            .map(|lane| ((*lane % 1000) as f32 + 1.0) / 1000.0)
            .collect();
        let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt();
        for value in &mut out {
            *value /= norm;
        }
        out
    }

    impl VisualBackend for MockBackend {
        fn backend_name(&self) -> &'static str {
            "mock"
        }
        fn embedding_dim(&self) -> usize {
            4
        }
        fn embed_text(&self, text: &str) -> Result<Vec<f32>, SearchError> {
            Ok(mock_vector(text.as_bytes()))
        }
        fn embed_image(&self, image: &[u8]) -> Result<Vec<f32>, SearchError> {
            Ok(mock_vector(image))
        }
    }

    struct FailingBackend;
    impl VisualBackend for FailingBackend {
        fn backend_name(&self) -> &'static str {
            "failing"
        }
        fn embedding_dim(&self) -> usize {
            4
        }
        fn embed_text(&self, _text: &str) -> Result<Vec<f32>, SearchError> {
            Err(SearchError::Inference("boom".into()))
        }
        fn embed_image(&self, _image: &[u8]) -> Result<Vec<f32>, SearchError> {
            Err(SearchError::Inference("boom".into()))
        }
    }

    fn frame(shot_start: f64, shot_end: f64, vector: Vec<f32>) -> IndexedFrame {
        IndexedFrame {
            time: shot_start,
            shot_start,
            shot_end,
            vector,
        }
    }

    fn assets() -> Vec<Asset> {
        vec![
            Asset::new("a1", "Beach Sunrise.mp4", lexical::AssetKind::Visual).with_transcript(
                vec![lexical::Cue {
                    start_sec: 1.0,
                    end_sec: 2.0,
                    text: "sunset over water".into(),
                }],
            ),
            Asset::new("a2", "City Night.mov", lexical::AssetKind::Visual),
        ]
    }

    fn index_for(backend: &MockBackend, text: &str) -> Vec<IndexedAsset> {
        let vector = backend.embed_text(text).expect("embed");
        vec![IndexedAsset::new("a1", vec![frame(1.0, 2.0, vector)])]
    }

    #[test]
    fn unavailable_backend_returns_files_and_spoken_without_fabricated_moments() {
        let service = SearchService::new(None, capability(false), 30);
        let results = service.query_text(&assets(), &[], "sun");
        assert_eq!(results.moments, Vec::new());
        assert_eq!(results.files.len(), 1);
        assert_eq!(results.files[0].media_id, "a1");
        assert_eq!(results.spoken.len(), 1);
        assert!(!results.visual_available);
        assert_eq!(results.visual_error, Some("visual_unavailable"));
        assert_eq!(
            results.visual_error_detail.as_deref(),
            Some("model_not_installed")
        );
        let payload = results.to_json();
        assert!(payload.contains("\"moments\":[]"));
        assert!(payload.contains("\"visualError\":\"visual_unavailable\""));
        assert!(payload.contains("\"visualAvailable\":false"));
        assert!(payload.contains("\"queryKind\":\"text\""));
    }

    #[test]
    fn unavailable_image_query_is_explicit_and_deterministic() {
        let service = SearchService::new(None, capability(false), 30);
        let first = service.query_image(&assets(), &[], b"image-bytes");
        let second = service.query_image(&assets(), &[], b"image-bytes");
        assert_eq!(first, second);
        assert!(first.moments.is_empty());
        assert!(first.files.is_empty());
        assert!(first.spoken.is_empty());
        assert!(!first.visual_available);
        assert_eq!(first.visual_error, Some("visual_unavailable"));
        assert_eq!(first.query_kind, "image");
    }

    #[test]
    fn available_capability_without_backend_stays_gated() {
        let service = SearchService::new(None, capability(true), 30);
        let results = service.query_text(&assets(), &[], "sun");
        assert!(results.moments.is_empty());
        assert_eq!(results.visual_error, Some("visual_unavailable"));
        assert_eq!(
            results.visual_error_detail.as_deref(),
            Some("backend_not_linked")
        );
    }

    #[test]
    fn mock_backend_answers_text_queries_with_ranked_moments() {
        let backend = MockBackend;
        let service = SearchService::new(Some(&backend), capability(true), 30);
        let indexes = index_for(&backend, "sunset over water");
        let results = service.query_text(&assets(), &indexes, "sunset over water");
        assert_eq!(results.moments.len(), 1);
        let hit = &results.moments[0];
        assert_eq!(hit.media_id, "a1");
        assert_eq!(hit.start_sec, 1.0);
        assert_eq!(hit.end_sec, 2.0);
        assert_eq!(hit.frame, 30);
        assert!(!hit.is_image);
        assert!((hit.score - 1.0).abs() < 1e-6);
        assert!(results.visual_available);
        assert_eq!(results.visual_error, None);
        // The lexical groups still work alongside the visual group: the query
        // text is not a media-name substring, but it matches the transcript cue.
        assert_eq!(results.files.len(), 0);
        assert_eq!(results.spoken.len(), 1);
    }

    #[test]
    fn mock_backend_answers_image_queries_with_ranked_moments() {
        let backend = MockBackend;
        let service = SearchService::new(Some(&backend), capability(true), 30);
        let vector = backend.embed_image(b"sunset-image").expect("embed");
        let indexes = vec![
            IndexedAsset::new("a1", vec![frame(1.0, 2.0, vector)]),
            IndexedAsset::new("a2", vec![frame(3.0, 4.0, mock_vector(b"other"))]),
        ];
        let results = service.query_image(&assets(), &indexes, b"sunset-image");
        assert_eq!(results.query_kind, "image");
        assert!(results.files.is_empty());
        assert!(results.spoken.is_empty());
        assert!(!results.moments.is_empty());
        assert_eq!(results.moments[0].media_id, "a1");
        assert!((results.moments[0].score - 1.0).abs() < 1e-6);
        assert!(results.visual_available);
        assert_eq!(results.visual_error, None);
    }

    #[test]
    fn backend_errors_are_reported_instead_of_faked() {
        let backend = FailingBackend;
        let service = SearchService::new(Some(&backend), capability(true), 30);
        let results = service.query_text(&assets(), &[], "sun");
        assert!(results.moments.is_empty());
        assert_eq!(results.visual_error, Some("visual_error"));
        assert!(results
            .visual_error_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("boom")));
    }

    #[test]
    fn rank_keeps_best_per_shot_applies_floor_limit_and_cutoff() {
        let service = SearchService::new(None, capability(false), 30).with_limits(2, 0.85, 0.05);
        let query = vec![1.0, 0.0];
        let indexes = vec![
            IndexedAsset::new(
                "a1",
                vec![
                    frame(1.0, 2.0, vec![1.0, 0.0]), // 1.00
                    frame(1.0, 2.0, vec![0.5, 0.0]), // same shot, lower: ignored
                    frame(3.0, 4.0, vec![0.90, 0.0]),
                    frame(5.0, 6.0, vec![0.10, 0.0]),
                ],
            ),
            IndexedAsset::new("a2", vec![frame(7.0, 8.0, vec![0.04, 0.0])]),
        ];
        let hits = service.rank(&query, &indexes).expect("rank");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].score, 1.0);
        assert_eq!(hits[0].media_id, "a1");
        // 0.90 >= top*0.85, 0.10 and 0.04 are rejected.
        assert_eq!(hits[1].score, 0.90);
        assert_eq!(hits[1].start_sec, 3.0);
    }

    #[test]
    fn empty_query_matches_desktop_default_without_visual_error() {
        let service = SearchService::new(None, capability(false), 30);
        let results = service.query_text(&assets(), &[], "   ");
        assert!(results.moments.is_empty());
        assert!(results.files.is_empty());
        assert!(results.spoken.is_empty());
        assert_eq!(results.visual_error, None);
    }

    #[test]
    fn results_json_is_deterministic_and_camel_case() {
        let service = SearchService::new(None, capability(false), 30);
        let first = service.query_text(&assets(), &[], "sun").to_json();
        let second = service.query_text(&assets(), &[], "sun").to_json();
        assert_eq!(first, second);
        assert!(first.contains("\"mediaId\":\"a1\""));
        assert!(first.contains("\"startSec\":1"));
        assert!(first.contains("\"visualErrorDetail\":\"model_not_installed\""));
    }
}
