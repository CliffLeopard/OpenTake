//! Deterministic text-search fallback. Mirrors the desktop engine's zero-setup
//! groups when the visual model is unavailable:
//! - **Files**: case-insensitive substring over media names (all assets).
//! - **Spoken**: case-insensitive substring over cached transcript cues of
//!   audio/video assets.
//!
//! The order is the caller's asset order (the desktop keeps the project media
//! manifest order; the Host keeps its catalog order), so results are stable and
//! reproducible. No embedding, hashing or model is involved.

/// Media kind relevant to search grouping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetKind {
    Visual,
    Audio,
    Other,
}

/// One cached transcript cue in source seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

/// A project media asset as seen by the fallback search.
#[derive(Clone, Debug, PartialEq)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub kind: AssetKind,
    pub transcript: Vec<Cue>,
}

/// Hidden but useful for the CLI/probes and external adapters.
impl Asset {
    pub fn new(id: impl Into<String>, name: impl Into<String>, kind: AssetKind) -> Self {
        Asset {
            id: id.into(),
            name: name.into(),
            kind,
            transcript: Vec::new(),
        }
    }

    pub fn with_transcript(mut self, transcript: Vec<Cue>) -> Self {
        self.transcript = transcript;
        self
    }

    fn is_spoken(&self) -> bool {
        matches!(self.kind, AssetKind::Visual | AssetKind::Audio)
    }
}

/// A Files-group hit (`score` is the fixed 1.0 desktop value: name matches are
/// unranked).
#[derive(Clone, Debug, PartialEq)]
pub struct FileHit {
    pub media_id: String,
    pub score: f32,
}

/// A Spoken-group hit (`score` fixed 1.0).
#[derive(Clone, Debug, PartialEq)]
pub struct SpokenHit {
    pub media_id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
    pub score: f32,
}

/// Normalize the query exactly once per search: trim + Unicode lowercase.
pub fn normalize_query(query: &str) -> String {
    query.trim().to_lowercase()
}

/// Files-group matches in input order, capped at `limit`.
pub fn matched_files(assets: &[Asset], query: &str, limit: usize) -> Vec<FileHit> {
    let needle = normalize_query(query);
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }
    assets
        .iter()
        .filter(|asset| asset.name.to_lowercase().contains(&needle))
        .take(limit)
        .map(|asset| FileHit {
            media_id: asset.id.clone(),
            score: 1.0,
        })
        .collect()
}

/// Spoken-group matches in asset order then cue order, capped at `limit`.
pub fn matched_spoken(assets: &[Asset], query: &str, limit: usize) -> Vec<SpokenHit> {
    let needle = normalize_query(query);
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for asset in assets.iter().filter(|asset| asset.is_spoken()) {
        for cue in &asset.transcript {
            if hits.len() >= limit {
                return hits;
            }
            if cue.text.to_lowercase().contains(&needle) {
                hits.push(SpokenHit {
                    media_id: asset.id.clone(),
                    start_sec: cue.start_sec,
                    end_sec: cue.end_sec,
                    text: cue.text.clone(),
                    score: 1.0,
                });
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(start: f64, end: f64, text: &str) -> Cue {
        Cue {
            start_sec: start,
            end_sec: end,
            text: text.to_string(),
        }
    }

    fn assets() -> Vec<Asset> {
        vec![
            Asset::new("a1", "Beach Sunrise.mp4", AssetKind::Visual).with_transcript(vec![
                cue(1.0, 2.5, "sunset over the water"),
                cue(3.0, 4.0, "waves rolling in"),
            ]),
            Asset::new("a2", "City Night.mov", AssetKind::Visual).with_transcript(vec![cue(
                0.5,
                1.5,
                "neon lights",
            )]),
            Asset::new("a3", "Sunset Music.wav", AssetKind::Audio).with_transcript(vec![cue(
                10.0,
                12.0,
                "Sunset Song",
            )]),
            Asset::new("a4", "notes.txt", AssetKind::Other),
        ]
    }

    #[test]
    fn file_matches_are_case_insensitive_and_keep_input_order() {
        let hits = matched_files(&assets(), "  SUN  ", 10);
        assert_eq!(
            hits.iter().map(|h| h.media_id.as_str()).collect::<Vec<_>>(),
            ["a1", "a3"]
        );
        assert!(hits.iter().all(|h| h.score == 1.0));
    }

    #[test]
    fn spoken_matches_only_transcripts_of_visual_and_audio_assets() {
        let hits = matched_spoken(&assets(), "sunset", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].media_id, "a1");
        assert_eq!(hits[0].text, "sunset over the water");
        assert_eq!(hits[1].media_id, "a3");
        assert_eq!(hits[1].start_sec, 10.0);
        // `notes.txt` has no transcript and is not an audio/video asset.
        assert!(matched_spoken(&assets(), "notes", 10).is_empty());
    }

    #[test]
    fn empty_query_and_zero_limit_return_nothing() {
        assert!(matched_files(&assets(), "", 10).is_empty());
        assert!(matched_files(&assets(), "   ", 10).is_empty());
        assert!(matched_files(&assets(), "sun", 0).is_empty());
        assert!(matched_spoken(&assets(), "", 10).is_empty());
        assert!(matched_spoken(&assets(), "sunset", 0).is_empty());
    }

    #[test]
    fn limits_are_applied_deterministically() {
        let hits = matched_files(&assets(), "s", 1);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].media_id, "a1");
        let spoken = matched_spoken(&assets(), "s", 1);
        assert_eq!(spoken.len(), 1);
        assert_eq!(spoken[0].media_id, "a1");
        assert_eq!(spoken[0].text, "sunset over the water");
    }

    #[test]
    fn repeated_searches_are_byte_identical() {
        let first = matched_spoken(&assets(), "sunset", 10);
        let second = matched_spoken(&assets(), "sunset", 10);
        assert_eq!(first, second);
    }
}
