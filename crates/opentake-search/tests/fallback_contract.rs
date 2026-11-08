//! External-contract test for the capability-gated fallback. Kept as an
//! integration test (not a unit test) so it exercises only the public API the
//! Host adapter would consume.

use opentake_search::lexical::{Asset, AssetKind, Cue};
use opentake_search::model::{
    custom_files, probe_files, probe_models, VisualCapability, BACKEND_NONE, BACKEND_ORT_NATIVE,
    TOTAL_BYTES,
};
use opentake_search::service::{SearchService, VISUAL_UNAVAILABLE};

fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "opentake-search-contract-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn assets() -> Vec<Asset> {
    vec![
        Asset::new("a1", "Beach Sunrise.mp4", AssetKind::Visual).with_transcript(vec![Cue {
            start_sec: 1.0,
            end_sec: 2.0,
            text: "sunset over water".into(),
        }]),
        Asset::new("a2", "City Night.mov", AssetKind::Visual),
    ]
}

#[test]
fn uninstalled_assets_yield_deterministic_text_fallback_and_no_moments() {
    let models_dir = unique_temp_dir("uninstalled");
    let probe = probe_models(Some(&models_dir), false);
    let capability = VisualCapability::evaluate(&probe, BACKEND_NONE);
    assert!(!capability.installed);
    assert!(!capability.visual_available);
    assert_eq!(capability.expected_bytes, TOTAL_BYTES);
    assert_eq!(capability.reason, Some(VISUAL_UNAVAILABLE));

    let service = SearchService::new(None, capability, 30);
    let text = service.query_text(&assets(), &[], "sun");
    assert!(text.moments.is_empty());
    assert_eq!(text.files.len(), 1);
    assert_eq!(text.spoken.len(), 1);
    assert_eq!(text.visual_error, Some(VISUAL_UNAVAILABLE));
    assert!(text.to_json().contains("\"visualAvailable\":false"));

    let image = service.query_image(&assets(), &[], b"image-bytes");
    assert!(image.moments.is_empty());
    assert_eq!(image.visual_error, Some(VISUAL_UNAVAILABLE));
    assert_eq!(image.query_kind, "image");
    assert_eq!(
        image.to_json(),
        service
            .query_image(&assets(), &[], b"image-bytes")
            .to_json()
    );
    std::fs::remove_dir_all(&models_dir).ok();
}

#[test]
fn complete_assets_without_a_linked_backend_are_still_gated() {
    // Synthetic small pins: this test must not read or download the real 1.5 GB
    // assets. Complete layout + backend "none" must still be unavailable.
    let models_dir = unique_temp_dir("complete");
    let dir = models_dir.join(format!(
        "{}-v{}",
        opentake_search::MODEL_NAME,
        opentake_search::MODEL_VERSION
    ));
    std::fs::create_dir_all(&dir).expect("install dir");
    let pinned = custom_files(&[(
        "src.bin",
        "src.bin",
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        5,
    )]);
    std::fs::write(dir.join("src.bin"), b"hello").expect("write");
    let probe = probe_files(Some(&models_dir), &pinned, true);
    assert!(probe.installed());

    let no_backend = VisualCapability::evaluate(&probe, BACKEND_NONE);
    assert!(no_backend.installed);
    assert!(!no_backend.visual_available);
    assert_eq!(no_backend.detail, Some("backend_not_linked"));

    let linked = VisualCapability::evaluate(&probe, BACKEND_ORT_NATIVE);
    assert!(linked.visual_available);

    // Even if a future adapter reports a linked backend, this standalone build
    // has no implementation: it must say visual_unavailable, not fake Moments.
    let service = SearchService::new(None, linked, 30);
    let results = service.query_text(&assets(), &[], "sun");
    assert!(results.moments.is_empty());
    assert_eq!(results.visual_error, Some(VISUAL_UNAVAILABLE));
    std::fs::remove_dir_all(&models_dir).ok();
}
