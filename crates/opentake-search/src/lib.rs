//! # opentake-search — isolated Route B visual-search slice
//!
//! This crate is the self-contained, offline-testable slice of OpenTake's
//! SigLIP2 visual search for the Route B (Rust engine inside DeepSeek Harness)
//! workstream. It intentionally has **no dependencies** and is **not** a member
//! of the root workspace yet: root `Cargo.toml` belongs to the integration
//! workstream and must not be edited here. See
//! `docs/architecture/route-b-search.md` for the promotion checklist.
//!
//! What it provides:
//! - [`model`]: the exact pinned SigLIP2 manifest (revision, sizes, SHA-256),
//!   install-layout probing, and a capability verdict (`visual_unavailable` when
//!   the ~1.53 GB assets are missing or no inference backend is linked).
//! - [`lexical`]: the deterministic text-search fallback (Files + Spoken over
//!   names and cached transcripts) that keeps working with zero setup.
//! - [`service`]: the query/ranking contract, a [`service::VisualBackend`] hook
//!   for the real ORT embedder, `NoVisualBackend` for honest gating, and the
//!   exact camelCase JSON payloads recommended to the Host.
//! - [`sha256`]: dependency-free SHA-256 for optional asset verification.
//!
//! The default build never downloads or loads model weights and never returns
//! fabricated visual Moments: without assets + backend the result carries
//! `visualError: "visual_unavailable"`.

pub mod json;
pub mod lexical;
pub mod model;
pub mod service;
pub mod sha256;

pub use lexical::{Asset, AssetKind, Cue, FileHit, SpokenHit};
pub use model::{
    install_dir, probe_files, probe_models, FileProbe, ModelFile, ModelProbe, ModelState,
    VisualCapability, BACKEND_NONE, BACKEND_ORT_NATIVE, BACKEND_ORT_TRACT, CONTEXT_LENGTH,
    EMBEDDING_DIM, IMAGE_SIZE, MODEL_DOWNLOAD_BASE_URL, MODEL_NAME, MODEL_VERSION, TOTAL_BYTES,
};
pub use service::{
    IndexedAsset, IndexedFrame, MomentHit, NoVisualBackend, SearchError, SearchResults,
    SearchService, VisualBackend, RELATIVE_CUTOFF, SEARCH_LIMIT, VISUAL_ERROR,
    VISUAL_MATCH_COSINE_FLOOR, VISUAL_UNAVAILABLE,
};
