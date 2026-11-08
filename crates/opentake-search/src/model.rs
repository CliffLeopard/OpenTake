//! SigLIP2 model manifest + capability probe for the isolated Route B search
//! slice. Everything here is read-only and offline: it only inspects local files
//! (sizes, optionally SHA-256) and never downloads or loads a model.

use std::path::{Path, PathBuf};

use crate::sha256;

/// Public ONNX Community export of the SigLIP2 dual encoder. Pinned to an
/// immutable Hugging Face revision; provenance matches
/// `crates/opentake-media/src/search/config.rs` (the desktop search engine).
pub const MODEL_DOWNLOAD_BASE_URL: &str =
    "https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/d1114256522a37ffa257a0a58017348ab0058db2";

/// Model identity and the on-disk install layout.
pub const MODEL_NAME: &str = "siglip2-base-patch16-256";
pub const MODEL_VERSION: i32 = 2;
pub const EMBEDDING_DIM: usize = 768;
pub const IMAGE_SIZE: u32 = 256;
pub const CONTEXT_LENGTH: usize = 64;

/// One pinned asset: the download name from the HF manifest, the name it gets
/// after the installer's atomic publish, its SHA-256 and byte size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelFile {
    pub download_name: &'static str,
    pub installed_path: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// The exact SigLIP2 manifest shipped by the desktop engine (`MODEL_VERSION 2`).
pub const IMAGE_ENCODER: ModelFile = ModelFile {
    download_name: "onnx/vision_model.onnx",
    installed_path: "image_encoder.onnx",
    sha256: "f5cb16728a704703f05516ded628397e11dbca4de2eb5db04b0c0bcee988aa7a",
    bytes: 371_992_072,
};

pub const TEXT_ENCODER: ModelFile = ModelFile {
    download_name: "onnx/text_model.onnx",
    installed_path: "text_encoder.onnx",
    sha256: "d3de4a6bbbfcb429b6615ac496790353cf4a4fc0f19fbbe7179e523ae60daaef",
    bytes: 1_129_469_657,
};

pub const TOKENIZER: ModelFile = ModelFile {
    download_name: "tokenizer.json",
    installed_path: "tokenizer/tokenizer.json",
    sha256: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
    bytes: 34_363_039,
};

/// Total pin bytes: 1,535,824,768 (1.43 GiB).
pub const TOTAL_BYTES: u64 = IMAGE_ENCODER.bytes + TEXT_ENCODER.bytes + TOKENIZER.bytes;

/// All pinned assets, in manifest order.
pub const FILES: [ModelFile; 3] = [IMAGE_ENCODER, TEXT_ENCODER, TOKENIZER];

/// `<models_dir>/<model>-v<version>` — identical to
/// `opentake_media::search::model_download::install_dir`.
pub fn install_dir(models_dir: &Path) -> PathBuf {
    models_dir.join(format!("{MODEL_NAME}-v{MODEL_VERSION}"))
}

/// Layout state of the install directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelState {
    /// No pinned file is present (or no models dir was configured).
    Missing,
    /// Some files exist but the asset set is incomplete / wrong-sized / corrupt.
    Incomplete,
    /// All pinned assets are present with the expected sizes and (if requested)
    /// matching SHA-256 digests.
    Complete,
}

/// Per-file probe result. `sha256_ok` is `None` when hashing was not requested.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileProbe {
    pub file: ModelFile,
    pub present: bool,
    pub actual_bytes: Option<u64>,
    pub size_ok: bool,
    pub sha256_ok: Option<bool>,
}

/// Complete probe of one models directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelProbe {
    pub models_dir: Option<PathBuf>,
    pub install_dir: Option<PathBuf>,
    pub state: ModelState,
    /// Canonical installer receipt (`manifest.json`) is present and parses as
    /// JSON. Its contents are not compared here; hashes/sizes are authoritative.
    pub receipt_present: bool,
    pub files: Vec<FileProbe>,
}

impl ModelProbe {
    pub fn installed(&self) -> bool {
        self.state == ModelState::Complete
    }

    pub fn total_expected_bytes(&self) -> u64 {
        TOTAL_BYTES
    }

    /// First failing file's stable detail code, used for capability reasons.
    pub fn failure_detail(&self) -> Option<&'static str> {
        if self.models_dir.is_none() {
            return Some("models_dir_not_configured");
        }
        match self.state {
            ModelState::Complete => None,
            ModelState::Missing => Some("model_not_installed"),
            ModelState::Incomplete => {
                if self.files.iter().any(|f| f.sha256_ok == Some(false)) {
                    Some("checksum_mismatch")
                } else if self.files.iter().any(|f| f.present && !f.size_ok) {
                    Some("model_incomplete")
                } else {
                    Some("model_not_installed")
                }
            }
        }
    }
}

/// Probe the pinned SigLIP2 assets under `<models_dir>/<model>-v<version>/`.
///
/// Offline and read-only. When `verify_hashes` is true, present files with the
/// expected size are streamed through SHA-256 (1.5 GB read; expensive but exact).
pub fn probe_models(models_dir: Option<&Path>, verify_hashes: bool) -> ModelProbe {
    probe_files(models_dir, &FILES, verify_hashes)
}

/// Probe an arbitrary pinned asset list. Used by tests and by the Node asset
/// probe to verify the same layout logic without duplicating it.
pub fn probe_files(
    models_dir: Option<&Path>,
    pinned: &[ModelFile],
    verify_hashes: bool,
) -> ModelProbe {
    let install = models_dir.map(install_dir);
    let mut files = Vec::with_capacity(pinned.len());
    for file in pinned.iter().copied() {
        let path = install.as_ref().map(|dir| dir.join(file.installed_path));
        let metadata = path.as_ref().and_then(|p| std::fs::metadata(p).ok());
        let present = metadata.as_ref().is_some_and(|meta| meta.is_file());
        let actual_bytes = metadata.as_ref().map(|meta| meta.len());
        let size_ok = actual_bytes == Some(file.bytes);
        let sha256_ok = if verify_hashes && present && size_ok {
            path.as_deref()
                .map(|p| sha256::file_hex_digest(p).is_ok_and(|digest| digest == file.sha256))
        } else {
            None
        };
        files.push(FileProbe {
            file,
            present,
            actual_bytes,
            size_ok,
            sha256_ok,
        });
    }
    let any_present = files.iter().any(|f| f.present);
    let all_ok = files
        .iter()
        .all(|f| f.present && f.size_ok && f.sha256_ok != Some(false));
    let state = if all_ok {
        ModelState::Complete
    } else if any_present {
        ModelState::Incomplete
    } else {
        ModelState::Missing
    };
    let receipt_present = install
        .as_ref()
        .is_some_and(|dir| dir.join("manifest.json").is_file());
    ModelProbe {
        models_dir: models_dir.map(Path::to_path_buf),
        install_dir: install,
        state,
        receipt_present,
        files,
    }
}

/// A synthetic pinned file list helper for tests/probes that must not read the
/// real 1.5 GB assets.
#[doc(hidden)]
pub fn custom_files(entries: &[(&'static str, &'static str, &'static str, u64)]) -> Vec<ModelFile> {
    entries
        .iter()
        .map(|(download_name, installed_path, sha256, bytes)| ModelFile {
            download_name,
            installed_path,
            sha256,
            bytes: *bytes,
        })
        .collect()
}

/// Backend identity strings used by the capability contract. `"none"` means no
/// inference backend is linked (this standalone stub); the real integration uses
/// `"ort-native"` (macOS/Linux `ort 2.0.0-rc.11`) or `"ort-tract"` (Windows
/// pure-Rust tract backend).
pub const BACKEND_NONE: &str = "none";
pub const BACKEND_ORT_NATIVE: &str = "ort-native";
pub const BACKEND_ORT_TRACT: &str = "ort-tract";

/// Capability verdict consumed by the Host status/query contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisualCapability {
    pub model: &'static str,
    pub version: i32,
    pub expected_bytes: u64,
    pub models_dir: Option<String>,
    pub installed: bool,
    pub backend: &'static str,
    pub visual_available: bool,
    /// Stable code: `visual_unavailable` when not available, else `None`.
    pub reason: Option<&'static str>,
    /// Stable detail code: `models_dir_not_configured`, `model_not_installed`,
    /// `model_incomplete`, `checksum_mismatch`, or `backend_not_linked`.
    pub detail: Option<&'static str>,
}

impl VisualCapability {
    /// Combine a model probe with the linked backend identity.
    ///
    /// The model can be complete on disk while visual search is still
    /// unavailable because no inference backend is linked (this standalone
    /// build) — the capability is gated on both assets and backend.
    pub fn evaluate(probe: &ModelProbe, backend: &'static str) -> Self {
        let installed = probe.installed();
        let available = installed && backend != BACKEND_NONE;
        let detail = if available {
            None
        } else if !installed {
            probe.failure_detail()
        } else {
            Some("backend_not_linked")
        };
        VisualCapability {
            model: MODEL_NAME,
            version: MODEL_VERSION,
            expected_bytes: TOTAL_BYTES,
            models_dir: probe
                .models_dir
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            installed,
            backend,
            visual_available: available,
            reason: if available {
                None
            } else {
                Some("visual_unavailable")
            },
            detail,
        }
    }

    /// The exact status JSON consumed by the Host `search_model_status` adapter.
    pub fn to_json(&self) -> String {
        let models_dir = match &self.models_dir {
            Some(path) => crate::json::string(path),
            None => "null".to_string(),
        };
        let reason = match self.reason {
            Some(code) => crate::json::string(code),
            None => "null".to_string(),
        };
        let detail = match self.detail {
            Some(code) => crate::json::string(code),
            None => "null".to_string(),
        };
        format!(
            concat!(
                "{{",
                "\"model\":{},",
                "\"version\":{},",
                "\"expectedBytes\":{},",
                "\"modelsDir\":{},",
                "\"installed\":{},",
                "\"backend\":{},",
                "\"visualAvailable\":{},",
                "\"reason\":{},",
                "\"detail\":{}",
                "}}"
            ),
            crate::json::string(self.model),
            self.version,
            self.expected_bytes,
            models_dir,
            self.installed,
            crate::json::string(self.backend),
            self.visual_available,
            reason,
            detail,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "opentake-search-model-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_sparse(path: &Path, bytes: u64) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        let file = std::fs::File::create(path).expect("create");
        file.set_len(bytes).expect("set_len");
    }

    #[test]
    fn manifest_is_the_pinned_siglip2_contract() {
        assert_eq!(TOTAL_BYTES, 1_535_824_768);
        assert_eq!(MODEL_NAME, "siglip2-base-patch16-256");
        assert_eq!(MODEL_VERSION, 2);
        assert_eq!(EMBEDDING_DIM, 768);
        assert_eq!(IMAGE_SIZE, 256);
        assert_eq!(CONTEXT_LENGTH, 64);
        let revision = MODEL_DOWNLOAD_BASE_URL.rsplit('/').next().unwrap();
        assert_eq!(revision.len(), 40);
        assert!(revision.bytes().all(|b| b.is_ascii_hexdigit()));
        for file in FILES {
            assert_eq!(file.sha256.len(), 64);
            assert!(file.bytes > 0);
        }
        assert_eq!(FILES.iter().map(|f| f.bytes).sum::<u64>(), TOTAL_BYTES);
    }

    #[test]
    fn missing_models_dir_is_gated_with_a_stable_detail() {
        let probe = probe_models(None, false);
        assert_eq!(probe.state, ModelState::Missing);
        let capability = VisualCapability::evaluate(&probe, BACKEND_NONE);
        assert!(!capability.installed);
        assert!(!capability.visual_available);
        assert_eq!(capability.reason, Some("visual_unavailable"));
        assert_eq!(capability.detail, Some("models_dir_not_configured"));
        assert_eq!(capability.expected_bytes, 1_535_824_768);
        assert!(capability.to_json().contains("\"visualAvailable\":false"));
    }

    #[test]
    fn empty_dir_reports_model_not_installed() {
        let models_dir = unique_temp_dir("empty");
        let probe = probe_models(Some(&models_dir), false);
        assert_eq!(probe.state, ModelState::Missing);
        assert_eq!(probe.failure_detail(), Some("model_not_installed"));
        std::fs::remove_dir_all(&models_dir).ok();
    }

    #[test]
    fn partial_install_reports_model_incomplete() {
        let models_dir = unique_temp_dir("partial");
        let dir = install_dir(&models_dir);
        write_sparse(&dir.join(IMAGE_ENCODER.installed_path), IMAGE_ENCODER.bytes);
        // text encoder missing
        let probe = probe_models(Some(&models_dir), false);
        assert_eq!(probe.state, ModelState::Incomplete);
        assert_eq!(probe.failure_detail(), Some("model_not_installed"));
        std::fs::remove_dir_all(&models_dir).ok();
    }

    #[test]
    fn wrong_size_reports_model_incomplete() {
        let models_dir = unique_temp_dir("wrong-size");
        let dir = install_dir(&models_dir);
        for file in FILES {
            write_sparse(&dir.join(file.installed_path), file.bytes);
        }
        write_sparse(&dir.join(TEXT_ENCODER.installed_path), 1);
        let probe = probe_models(Some(&models_dir), false);
        assert_eq!(probe.state, ModelState::Incomplete);
        assert_eq!(probe.failure_detail(), Some("model_incomplete"));
        std::fs::remove_dir_all(&models_dir).ok();
    }

    #[test]
    fn complete_assets_but_no_backend_is_still_gated() {
        let models_dir = unique_temp_dir("complete");
        let dir = install_dir(&models_dir);
        for file in FILES {
            write_sparse(&dir.join(file.installed_path), file.bytes);
        }
        std::fs::write(dir.join("manifest.json"), b"{}").expect("receipt");
        let probe = probe_models(Some(&models_dir), false);
        assert_eq!(probe.state, ModelState::Complete);
        assert!(probe.installed());
        assert!(probe.receipt_present);
        let capability = VisualCapability::evaluate(&probe, BACKEND_NONE);
        assert!(capability.installed);
        assert!(!capability.visual_available);
        assert_eq!(capability.reason, Some("visual_unavailable"));
        assert_eq!(capability.detail, Some("backend_not_linked"));

        let linked = VisualCapability::evaluate(&probe, BACKEND_ORT_NATIVE);
        assert!(linked.visual_available);
        assert_eq!(linked.reason, None);
        assert_eq!(linked.detail, None);
        std::fs::remove_dir_all(&models_dir).ok();
    }

    #[test]
    fn hash_verification_accepts_matching_and_rejects_mismatching_bytes() {
        // Small synthetic pins keep the test fast; the pinned real manifest is
        // covered by the constants test above and the Node asset probe.
        let hello_sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        let pinned = custom_files(&[("src.bin", "src.bin", hello_sha, 5)]);
        let models_dir = unique_temp_dir("hashes");
        let dir = install_dir(&models_dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("src.bin");

        std::fs::write(&path, b"hello").expect("write");
        let good = probe_files(Some(&models_dir), &pinned, true);
        assert_eq!(good.state, ModelState::Complete);

        std::fs::write(&path, b"world").expect("write");
        let bad = probe_files(Some(&models_dir), &pinned, true);
        assert_eq!(bad.state, ModelState::Incomplete);
        assert_eq!(bad.failure_detail(), Some("checksum_mismatch"));
        std::fs::remove_dir_all(&models_dir).ok();
    }
}
