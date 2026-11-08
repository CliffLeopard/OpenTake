//! Serde-friendly JSON mirror of `EditCommand`, extracted from the Tauri command
//! layer so the N-API addon can accept the same `{type: ...}` requests the
//! existing React UI sends. Keep this in sync with `src-tauri/src/commands.rs`.

use serde::Deserialize;

use opentake_core::EditCommand;
use opentake_domain::{
    AnimPair, AudioDenoise, ChromaKey, Clip, ClipType, ColorGrade, Crop, Effect, Interpolation,
    Keyframe, KeyframeTrack, LoudnessNormalization, LutReference, Mask, StabilizationTrack,
    TextStyle, Transform, TransitionKind,
};
use opentake_ops::command::{
    NewTrackClipMode, PasteClipEntry, PlaceMediaTarget, ProjectTimelineSettings, UnplacedClipEntry,
};
use opentake_ops::{
    CaptionEntry, ClipEntry, ClipMove, ClipProperties, FrameRange, KeyframePayload,
    KeyframeProperty, KeyframeValue, RenameEntry, TextAutoTrackEntry, TextEntry,
};

// MARK: - EditRequest (serde-friendly mirror of EditCommand)

/// A serde-deserializable mirror of the [`EditCommand`] variants the front end
/// issues. Tagged `{ "type": "addClips", ... }` to match the TS discriminated
/// union. Engine value types (`ClipMove`, `TrimEdit`, `FrameRange`, keyframe
/// tracks) are mirrored as local serde DTOs and converted in [`into_command`].
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum EditRequest {
    #[serde(rename_all = "camelCase")]
    CreateNestedSequence { name: String, clip_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    EditNestedSequence {
        sequence_id: String,
        command: Box<EditRequest>,
    },
    #[serde(rename_all = "camelCase")]
    RenameNestedSequence { sequence_id: String, name: String },
    #[serde(rename_all = "camelCase")]
    DissolveNestedSequence { clip_id: String },
    #[serde(rename_all = "camelCase")]
    PlaceMedia {
        sequence_id: Option<String>,
        settings: Option<ProjectTimelineSettingsDto>,
        target: PlaceMediaTargetDto,
        entry: UnplacedClipEntryDto,
    },
    #[serde(rename_all = "camelCase")]
    AddClips { entries: Vec<ClipEntryDto> },
    #[serde(rename_all = "camelCase")]
    InsertClips {
        track_index: usize,
        at_frame: i32,
        entries: Vec<ClipEntryDto>,
    },
    #[serde(rename_all = "camelCase")]
    MoveClips { moves: Vec<ClipMoveDto> },
    #[serde(rename_all = "camelCase")]
    DuplicateClips {
        clip_ids: Vec<String>,
        offset_frames: i32,
        target_track_indexes: Vec<usize>,
    },
    #[serde(rename_all = "camelCase")]
    MoveOrDuplicateClipsToNewTrack {
        clip_ids: Vec<String>,
        lead_clip_id: String,
        requested_frame_delta: i32,
        insert_at: usize,
        mode: NewTrackClipModeDto,
    },
    #[serde(rename_all = "camelCase")]
    PasteClips { entries: Vec<PasteClipEntryDto> },
    #[serde(rename_all = "camelCase")]
    RemoveClips { clip_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    SplitClip { clip_id: String, at_frame: i32 },
    #[serde(rename_all = "camelCase")]
    SplitClips {
        clip_ids: Vec<String>,
        at_frame: i32,
    },
    #[serde(rename_all = "camelCase")]
    FreezeFrame {
        clip_id: String,
        at_frame: i32,
        duration_frames: i32,
    },
    #[serde(rename_all = "camelCase")]
    TrimClips { edits: Vec<TrimEditDto> },
    #[serde(rename_all = "camelCase")]
    SetClipProperties {
        clip_ids: Vec<String>,
        // Boxed to keep `EditRequest` small: `ClipPropertiesDto` carries a full
        // `TextStyle`, which would otherwise dominate the enum size.
        properties: Box<ClipPropertiesDto>,
    },
    #[serde(rename_all = "camelCase")]
    SetTransformAtFrame {
        clip_id: String,
        frame: i32,
        transform: Transform,
    },
    #[serde(rename_all = "camelCase")]
    SetKeyframes {
        clip_id: String,
        property: KeyframePropertyDto,
        payload: KeyframePayloadDto,
    },
    #[serde(rename_all = "camelCase")]
    StampKeyframe {
        clip_id: String,
        property: KeyframePropertyDto,
        frame: i32,
    },
    #[serde(rename_all = "camelCase")]
    UpsertKeyframe {
        clip_id: String,
        property: KeyframePropertyDto,
        frame: i32,
        value: KeyframeValueDto,
    },
    #[serde(rename_all = "camelCase")]
    RemoveKeyframe {
        clip_id: String,
        property: KeyframePropertyDto,
        frame: i32,
    },
    #[serde(rename_all = "camelCase")]
    MoveKeyframe {
        clip_id: String,
        property: KeyframePropertyDto,
        from_frame: i32,
        to_frame: i32,
    },
    #[serde(rename_all = "camelCase")]
    SetKeyframeInterpolation {
        clip_id: String,
        property: KeyframePropertyDto,
        frame: i32,
        interpolation: Interpolation,
    },
    #[serde(rename_all = "camelCase")]
    SetColorGrade {
        clip_ids: Vec<String>,
        grade: Option<ColorGrade>,
    },
    #[serde(rename_all = "camelCase")]
    SetLut {
        clip_ids: Vec<String>,
        lut: Option<LutReference>,
    },
    #[serde(rename_all = "camelCase")]
    SetChromaKey {
        clip_ids: Vec<String>,
        chroma_key: Option<ChromaKey>,
    },
    #[serde(rename_all = "camelCase")]
    SetMasks {
        clip_ids: Vec<String>,
        masks: Vec<Mask>,
    },
    #[serde(rename_all = "camelCase")]
    SetEffects {
        clip_ids: Vec<String>,
        effects: Vec<Effect>,
    },
    #[serde(rename_all = "camelCase")]
    SetLoudnessNormalization {
        clip_id: String,
        normalization: Option<LoudnessNormalization>,
    },
    #[serde(rename_all = "camelCase")]
    SetAudioDenoise {
        clip_id: String,
        denoise: Option<AudioDenoise>,
    },
    #[serde(rename_all = "camelCase")]
    ApplyStabilization {
        clip_id: String,
        solution: StabilizationTrack,
    },
    #[serde(rename_all = "camelCase")]
    AdjustStabilization {
        clip_id: String,
        strength: Option<f64>,
        crop_margin: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    ResetStabilization { clip_id: String },
    #[serde(rename_all = "camelCase")]
    SetTransition {
        from_clip_id: String,
        to_clip_id: String,
        kind: Option<TransitionKind>,
        duration_frames: i32,
    },
    #[serde(rename_all = "camelCase")]
    RippleDeleteRanges {
        track_index: usize,
        ranges: Vec<FrameRangeDto>,
    },
    #[serde(rename_all = "camelCase")]
    RippleDeleteClips { clip_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    AddTexts { entries: Vec<TextEntryDto> },
    #[serde(rename_all = "camelCase")]
    AddTextsAutoTrack { entries: Vec<TextAutoTrackEntryDto> },
    #[serde(rename_all = "camelCase")]
    AddCaptions { entries: Vec<CaptionEntryDto> },
    #[serde(rename_all = "camelCase")]
    Link { clip_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Unlink { clip_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    RemoveTracks { track_indexes: Vec<usize> },
    #[serde(rename_all = "camelCase")]
    SwapTracks { a: usize, b: usize },
    #[serde(rename_all = "camelCase")]
    SwapClips { clip_a: String, clip_b: String },
    #[serde(rename_all = "camelCase")]
    InsertTrack { kind: ClipType, at: Option<usize> },
    #[serde(rename_all = "camelCase")]
    SetTrackProps {
        track_index: usize,
        muted: Option<bool>,
        hidden: Option<bool>,
        sync_locked: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    CreateFolder {
        name: String,
        parent_folder_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    MoveToFolder {
        asset_ids: Vec<String>,
        folder_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RenameMedia { entries: Vec<RenameEntryDto> },
    #[serde(rename_all = "camelCase")]
    RenameFolder { entries: Vec<RenameEntryDto> },
    #[serde(rename_all = "camelCase")]
    DeleteMedia { asset_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    DeleteFolder { folder_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    SwapMedia { clip_id: String, media_ref: String },
    #[serde(rename_all = "camelCase")]
    ResetTransform { clip_ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    SetTimelineSettings { fps: i32, width: i32, height: i32 },
}

impl EditRequest {
    pub fn into_command(self) -> Result<EditCommand, String> {
        Ok(match self {
            EditRequest::CreateNestedSequence { name, clip_ids } => {
                EditCommand::CreateNestedSequenceFromClips { name, clip_ids }
            }
            EditRequest::EditNestedSequence {
                sequence_id,
                command,
            } => EditCommand::EditNestedSequence {
                sequence_id,
                command: Box::new(command.into_command()?),
            },
            EditRequest::RenameNestedSequence { sequence_id, name } => {
                EditCommand::RenameNestedSequence { sequence_id, name }
            }
            EditRequest::DissolveNestedSequence { clip_id } => {
                EditCommand::DissolveNestedSequence { clip_id }
            }
            EditRequest::PlaceMedia {
                sequence_id,
                settings,
                target,
                entry,
            } => EditCommand::PlaceMedia {
                sequence_id,
                settings: settings.map(ProjectTimelineSettingsDto::into_settings),
                target: target.into_target(),
                entry: entry.into_entry(),
            },
            EditRequest::AddClips { entries } => EditCommand::AddClips {
                entries: entries.into_iter().map(ClipEntryDto::into_entry).collect(),
            },
            EditRequest::InsertClips {
                track_index,
                at_frame,
                entries,
            } => EditCommand::InsertClips {
                track_index,
                at_frame,
                entries: entries.into_iter().map(ClipEntryDto::into_entry).collect(),
            },
            EditRequest::MoveClips { moves } => EditCommand::MoveClips {
                moves: moves.into_iter().map(ClipMoveDto::into_move).collect(),
            },
            EditRequest::DuplicateClips {
                clip_ids,
                offset_frames,
                target_track_indexes,
            } => EditCommand::DuplicateClips {
                clip_ids,
                offset_frames,
                target_track_indexes,
            },
            EditRequest::MoveOrDuplicateClipsToNewTrack {
                clip_ids,
                lead_clip_id,
                requested_frame_delta,
                insert_at,
                mode,
            } => EditCommand::MoveOrDuplicateClipsToNewTrack {
                clip_ids,
                lead_clip_id,
                requested_frame_delta,
                insert_at,
                mode: mode.into(),
            },
            EditRequest::PasteClips { entries } => EditCommand::PasteClips {
                entries: entries
                    .into_iter()
                    .map(PasteClipEntryDto::into_entry)
                    .collect(),
            },
            EditRequest::RemoveClips { clip_ids } => EditCommand::RemoveClips { clip_ids },
            EditRequest::SplitClip { clip_id, at_frame } => {
                EditCommand::SplitClip { clip_id, at_frame }
            }
            EditRequest::SplitClips { clip_ids, at_frame } => {
                EditCommand::SplitClips { clip_ids, at_frame }
            }
            EditRequest::FreezeFrame { .. } => {
                return Err("freezeFrame must be handled by edit_apply".into())
            }
            EditRequest::TrimClips { edits } => EditCommand::TrimClips {
                edits: edits.into_iter().map(TrimEditDto::into_edit).collect(),
            },
            EditRequest::SetClipProperties {
                clip_ids,
                properties,
            } => EditCommand::SetClipProperties {
                clip_ids,
                properties: Box::new((*properties).into_properties()),
            },
            EditRequest::SetTransformAtFrame {
                clip_id,
                frame,
                transform,
            } => EditCommand::SetTransformAtFrame {
                clip_id,
                frame,
                transform,
            },
            EditRequest::SetKeyframes {
                clip_id,
                property,
                payload,
            } => EditCommand::SetKeyframes {
                clip_id,
                property: property.into(),
                payload: payload.into_payload()?,
            },
            EditRequest::StampKeyframe {
                clip_id,
                property,
                frame,
            } => EditCommand::StampKeyframe {
                clip_id,
                property: property.into(),
                frame,
            },
            EditRequest::UpsertKeyframe {
                clip_id,
                property,
                frame,
                value,
            } => EditCommand::UpsertKeyframe {
                clip_id,
                property: property.into(),
                frame,
                value: value.into_value(),
            },
            EditRequest::RemoveKeyframe {
                clip_id,
                property,
                frame,
            } => EditCommand::RemoveKeyframe {
                clip_id,
                property: property.into(),
                frame,
            },
            EditRequest::MoveKeyframe {
                clip_id,
                property,
                from_frame,
                to_frame,
            } => EditCommand::MoveKeyframe {
                clip_id,
                property: property.into(),
                from_frame,
                to_frame,
            },
            EditRequest::SetKeyframeInterpolation {
                clip_id,
                property,
                frame,
                interpolation,
            } => EditCommand::SetKeyframeInterpolation {
                clip_id,
                property: property.into(),
                frame,
                interpolation,
            },
            EditRequest::SetColorGrade { clip_ids, grade } => {
                EditCommand::SetColorGrade { clip_ids, grade }
            }
            EditRequest::SetLut { clip_ids, lut } => EditCommand::SetLut { clip_ids, lut },
            EditRequest::SetChromaKey {
                clip_ids,
                chroma_key,
            } => EditCommand::SetChromaKey {
                clip_ids,
                chroma_key,
            },
            EditRequest::SetMasks { clip_ids, masks } => EditCommand::SetMasks { clip_ids, masks },
            EditRequest::SetEffects { clip_ids, effects } => {
                EditCommand::SetEffects { clip_ids, effects }
            }
            EditRequest::SetLoudnessNormalization {
                clip_id,
                normalization,
            } => EditCommand::SetLoudnessNormalization {
                clip_id,
                normalization,
            },
            EditRequest::SetAudioDenoise { clip_id, denoise } => {
                EditCommand::SetAudioDenoise { clip_id, denoise }
            }
            EditRequest::ApplyStabilization { clip_id, solution } => {
                EditCommand::ApplyStabilization { clip_id, solution }
            }
            EditRequest::AdjustStabilization {
                clip_id,
                strength,
                crop_margin,
            } => EditCommand::AdjustStabilization {
                clip_id,
                strength,
                crop_margin,
            },
            EditRequest::ResetStabilization { clip_id } => {
                EditCommand::ResetStabilization { clip_id }
            }
            EditRequest::SetTransition {
                from_clip_id,
                to_clip_id,
                kind,
                duration_frames,
            } => EditCommand::SetTransition {
                from_clip_id,
                to_clip_id,
                kind,
                duration_frames,
            },
            EditRequest::RippleDeleteRanges {
                track_index,
                ranges,
            } => EditCommand::RippleDeleteRanges {
                track_index,
                ranges: ranges.into_iter().map(FrameRangeDto::into_range).collect(),
            },
            EditRequest::RippleDeleteClips { clip_ids } => {
                EditCommand::RippleDeleteClips { clip_ids }
            }
            EditRequest::AddTexts { entries } => EditCommand::AddTexts {
                entries: entries.into_iter().map(TextEntryDto::into_entry).collect(),
            },
            EditRequest::AddTextsAutoTrack { entries } => EditCommand::AddTextsAutoTrack {
                entries: entries
                    .into_iter()
                    .map(TextAutoTrackEntryDto::into_entry)
                    .collect(),
            },
            EditRequest::AddCaptions { entries } => EditCommand::AddCaptions {
                entries: entries
                    .into_iter()
                    .map(CaptionEntryDto::into_entry)
                    .collect(),
            },
            EditRequest::Link { clip_ids } => EditCommand::Link { clip_ids },
            EditRequest::Unlink { clip_ids } => EditCommand::Unlink { clip_ids },
            EditRequest::RemoveTracks { track_indexes } => {
                EditCommand::RemoveTracks { track_indexes }
            }
            EditRequest::SwapTracks { a, b } => EditCommand::SwapTracks { a, b },
            EditRequest::SwapClips { clip_a, clip_b } => EditCommand::SwapClips {
                a: clip_a,
                b: clip_b,
            },
            EditRequest::InsertTrack { kind, at } => EditCommand::InsertTrack { kind, at },
            EditRequest::SetTrackProps {
                track_index,
                muted,
                hidden,
                sync_locked,
            } => EditCommand::SetTrackProps {
                track_index,
                muted,
                hidden,
                sync_locked,
            },
            EditRequest::CreateFolder {
                name,
                parent_folder_id,
            } => EditCommand::CreateFolder {
                name,
                parent_folder_id,
            },
            EditRequest::MoveToFolder {
                asset_ids,
                folder_id,
            } => EditCommand::MoveToFolder {
                asset_ids,
                folder_id,
            },
            EditRequest::RenameMedia { entries } => EditCommand::RenameMedia {
                entries: entries
                    .into_iter()
                    .map(RenameEntryDto::into_entry)
                    .collect(),
            },
            EditRequest::RenameFolder { entries } => EditCommand::RenameFolder {
                entries: entries
                    .into_iter()
                    .map(RenameEntryDto::into_entry)
                    .collect(),
            },
            EditRequest::DeleteMedia { asset_ids } => EditCommand::DeleteMedia { asset_ids },
            EditRequest::DeleteFolder { folder_ids } => EditCommand::DeleteFolder { folder_ids },
            EditRequest::SwapMedia { clip_id, media_ref } => {
                EditCommand::SwapMedia { clip_id, media_ref }
            }
            EditRequest::ResetTransform { clip_ids } => EditCommand::ResetTransform { clip_ids },
            EditRequest::SetTimelineSettings { fps, width, height } => {
                EditCommand::SetTimelineSettings { fps, width, height }
            }
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTimelineSettingsDto {
    pub fps: i32,
    pub width: i32,
    pub height: i32,
}

impl ProjectTimelineSettingsDto {
    fn into_settings(self) -> ProjectTimelineSettings {
        ProjectTimelineSettings {
            fps: self.fps,
            width: self.width,
            height: self.height,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlaceMediaTargetDto {
    #[serde(rename_all = "camelCase")]
    ExistingTrack { track_id: String },
    #[serde(rename_all = "camelCase")]
    NewTrack {
        track_type: ClipType,
        at: Option<usize>,
    },
}

impl PlaceMediaTargetDto {
    fn into_target(self) -> PlaceMediaTarget {
        match self {
            Self::ExistingTrack { track_id } => PlaceMediaTarget::ExistingTrack { track_id },
            Self::NewTrack { track_type, at } => PlaceMediaTarget::NewTrack {
                kind: track_type,
                at,
            },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnplacedClipEntryDto {
    pub media_ref: String,
    pub media_type: ClipType,
    pub source_clip_type: ClipType,
    pub start_frame: i32,
    pub duration_frames: i32,
    #[serde(default)]
    pub trim_start_frame: Option<i32>,
    #[serde(default)]
    pub trim_end_frame: Option<i32>,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub add_linked_audio: bool,
    #[serde(default)]
    pub transform: Option<Transform>,
}

impl UnplacedClipEntryDto {
    fn into_entry(self) -> UnplacedClipEntry {
        UnplacedClipEntry {
            media_ref: self.media_ref,
            media_type: self.media_type,
            source_clip_type: self.source_clip_type,
            start_frame: self.start_frame,
            duration_frames: self.duration_frames,
            trim_start_frame: self.trim_start_frame,
            trim_end_frame: self.trim_end_frame,
            has_audio: self.has_audio,
            add_linked_audio: self.add_linked_audio,
            transform: self.transform,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewTrackClipModeDto {
    Move,
    Duplicate,
}

impl From<NewTrackClipModeDto> for NewTrackClipMode {
    fn from(value: NewTrackClipModeDto) -> Self {
        match value {
            NewTrackClipModeDto::Move => NewTrackClipMode::Move,
            NewTrackClipModeDto::Duplicate => NewTrackClipMode::Duplicate,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteClipEntryDto {
    pub clip: Clip,
    pub target_track_id: String,
    pub start_frame: i32,
}

impl PasteClipEntryDto {
    fn into_entry(self) -> PasteClipEntry {
        PasteClipEntry {
            clip: self.clip,
            target_track_id: self.target_track_id,
            start_frame: self.start_frame,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntryDto {
    pub media_ref: String,
    pub media_type: ClipType,
    pub source_clip_type: ClipType,
    pub track_index: usize,
    pub start_frame: i32,
    pub duration_frames: i32,
    #[serde(default)]
    pub trim_start_frame: Option<i32>,
    #[serde(default)]
    pub trim_end_frame: Option<i32>,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub add_linked_audio: bool,
    #[serde(default)]
    pub transform: Option<Transform>,
}

impl ClipEntryDto {
    fn into_entry(self) -> ClipEntry {
        ClipEntry {
            media_ref: self.media_ref,
            media_type: self.media_type,
            source_clip_type: self.source_clip_type,
            track_index: self.track_index,
            start_frame: self.start_frame,
            duration_frames: self.duration_frames,
            trim_start_frame: self.trim_start_frame,
            trim_end_frame: self.trim_end_frame,
            has_audio: self.has_audio,
            add_linked_audio: self.add_linked_audio,
            transform: self.transform,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMoveDto {
    pub clip_id: String,
    pub to_track: usize,
    pub to_frame: i32,
}

impl ClipMoveDto {
    fn into_move(self) -> ClipMove {
        ClipMove {
            clip_id: self.clip_id,
            to_track: self.to_track,
            to_frame: self.to_frame,
        }
    }
}

/// `[clip_id, trim_start, trim_end]` in source frames (matches `TrimEdit`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimEditDto {
    pub clip_id: String,
    pub trim_start_frame: i32,
    pub trim_end_frame: i32,
}

impl TrimEditDto {
    fn into_edit(self) -> (String, i32, i32) {
        (self.clip_id, self.trim_start_frame, self.trim_end_frame)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRangeDto {
    pub start: i32,
    pub end: i32,
}

impl FrameRangeDto {
    fn into_range(self) -> FrameRange {
        FrameRange::new(self.start, self.end)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPropertiesDto {
    #[serde(default)]
    pub duration_frames: Option<i32>,
    #[serde(default)]
    pub trim_start_frame: Option<i32>,
    #[serde(default)]
    pub trim_end_frame: Option<i32>,
    #[serde(default)]
    pub speed: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub transform: Option<Transform>,
    #[serde(default)]
    pub reversed: Option<bool>,
    #[serde(default)]
    pub text_content: Option<String>,
    #[serde(default)]
    pub text_style: Option<TextStyle>,
    #[serde(default)]
    pub crop: Option<Crop>,
    #[serde(default)]
    pub fade_in_frames: Option<i32>,
    #[serde(default)]
    pub fade_out_frames: Option<i32>,
    #[serde(default)]
    pub fade_in_interpolation: Option<Interpolation>,
    #[serde(default)]
    pub fade_out_interpolation: Option<Interpolation>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
}

impl ClipPropertiesDto {
    fn into_properties(self) -> ClipProperties {
        ClipProperties {
            duration_frames: self.duration_frames,
            trim_start_frame: self.trim_start_frame,
            trim_end_frame: self.trim_end_frame,
            speed: self.speed,
            volume: self.volume,
            opacity: self.opacity,
            transform: self.transform,
            reversed: self.reversed,
            text_content: self.text_content,
            text_style: self.text_style,
            crop: self.crop,
            fade_in_frames: self.fade_in_frames,
            fade_out_frames: self.fade_out_frames,
            fade_in_interpolation: self.fade_in_interpolation,
            fade_out_interpolation: self.fade_out_interpolation,
            flip_horizontal: self.flip_horizontal,
            flip_vertical: self.flip_vertical,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEntryDto {
    pub track_index: usize,
    pub start_frame: i32,
    pub duration_frames: i32,
    pub content: String,
    pub text_style: TextStyle,
    pub transform: Transform,
}

impl TextEntryDto {
    fn into_entry(self) -> TextEntry {
        TextEntry {
            track_index: self.track_index,
            start_frame: self.start_frame,
            duration_frames: self.duration_frames,
            content: self.content,
            text_style: self.text_style,
            transform: self.transform,
        }
    }
}

/// Like [`TextEntryDto`] minus `trackIndex` — every entry in an
/// `addTextsAutoTrack` batch lands on the single fresh track the command
/// creates, so there's nothing to target (#194).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAutoTrackEntryDto {
    pub start_frame: i32,
    pub duration_frames: i32,
    pub content: String,
    pub text_style: TextStyle,
    pub transform: Transform,
}

impl TextAutoTrackEntryDto {
    fn into_entry(self) -> TextAutoTrackEntry {
        TextAutoTrackEntry {
            start_frame: self.start_frame,
            duration_frames: self.duration_frames,
            content: self.content,
            text_style: self.text_style,
            transform: self.transform,
        }
    }
}

/// One built caption clip on the wire (mirrors [`CaptionEntry`]). Multi-word
/// fields MUST be camelCase (`startFrame`, `durationFrames`, `textStyle`,
/// `captionGroupId`) — the repo's #1 bug class is a DTO field that silently fails
/// to deserialize because it wasn't camelCase. See `commands.rs` module header.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionEntryDto {
    pub start_frame: i32,
    pub duration_frames: i32,
    pub content: String,
    pub text_style: TextStyle,
    pub transform: Transform,
    pub caption_group_id: String,
}

impl CaptionEntryDto {
    fn into_entry(self) -> CaptionEntry {
        CaptionEntry {
            start_frame: self.start_frame,
            duration_frames: self.duration_frames,
            content: self.content,
            text_style: self.text_style,
            transform: self.transform,
            caption_group_id: self.caption_group_id,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntryDto {
    pub id: String,
    pub name: String,
}

impl RenameEntryDto {
    fn into_entry(self) -> RenameEntry {
        RenameEntry {
            id: self.id,
            name: self.name,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyframePropertyDto {
    Opacity,
    Volume,
    Rotation,
    Position,
    Scale,
    Crop,
}

impl From<KeyframePropertyDto> for KeyframeProperty {
    fn from(p: KeyframePropertyDto) -> Self {
        match p {
            KeyframePropertyDto::Opacity => KeyframeProperty::Opacity,
            KeyframePropertyDto::Volume => KeyframeProperty::Volume,
            KeyframePropertyDto::Rotation => KeyframeProperty::Rotation,
            KeyframePropertyDto::Position => KeyframeProperty::Position,
            KeyframePropertyDto::Scale => KeyframeProperty::Scale,
            KeyframePropertyDto::Crop => KeyframeProperty::Crop,
        }
    }
}

/// One keyframe `{ frame, value, interpolationOut }` carrying a JSON value;
/// shaped per the target track in [`KeyframePayloadDto`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScalarKfDto {
    pub frame: i32,
    pub value: f64,
    #[serde(default)]
    pub interpolation_out: Option<Interpolation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairKfDto {
    pub frame: i32,
    pub value: AnimPair,
    #[serde(default)]
    pub interpolation_out: Option<Interpolation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropKfDto {
    pub frame: i32,
    pub value: Crop,
    #[serde(default)]
    pub interpolation_out: Option<Interpolation>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KeyframePayloadDto {
    Scalar { keyframes: Vec<ScalarKfDto> },
    Pair { keyframes: Vec<PairKfDto> },
    Crop { keyframes: Vec<CropKfDto> },
}

impl KeyframePayloadDto {
    fn into_payload(self) -> Result<KeyframePayload, String> {
        Ok(match self {
            KeyframePayloadDto::Scalar { keyframes } => {
                let kfs = keyframes
                    .into_iter()
                    .map(|k| match k.interpolation_out {
                        Some(i) => Keyframe::with_interpolation(k.frame, k.value, i),
                        None => Keyframe::new(k.frame, k.value),
                    })
                    .collect();
                KeyframePayload::Scalar(KeyframeTrack::from_keyframes(kfs))
            }
            KeyframePayloadDto::Pair { keyframes } => {
                let kfs = keyframes
                    .into_iter()
                    .map(|k| match k.interpolation_out {
                        Some(i) => Keyframe::with_interpolation(k.frame, k.value, i),
                        None => Keyframe::new(k.frame, k.value),
                    })
                    .collect();
                KeyframePayload::Pair(KeyframeTrack::from_keyframes(kfs))
            }
            KeyframePayloadDto::Crop { keyframes } => {
                let kfs = keyframes
                    .into_iter()
                    .map(|k| match k.interpolation_out {
                        Some(i) => Keyframe::with_interpolation(k.frame, k.value, i),
                        None => Keyframe::new(k.frame, k.value),
                    })
                    .collect();
                KeyframePayload::Crop(KeyframeTrack::from_keyframes(kfs))
            }
        })
    }
}

/// An explicit single-value payload for [`EditRequest::UpsertKeyframe`]. Mirrors
/// [`KeyframePayloadDto`]'s `kind`-tagging, but carries one value (not a whole
/// replacement track) to upsert at the command's `frame`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KeyframeValueDto {
    Scalar { value: f64 },
    Pair { value: AnimPair },
    Crop { value: Crop },
}

impl KeyframeValueDto {
    fn into_value(self) -> KeyframeValue {
        match self {
            KeyframeValueDto::Scalar { value } => KeyframeValue::Scalar(value),
            KeyframeValueDto::Pair { value } => KeyframeValue::Pair(value),
            KeyframeValueDto::Crop { value } => KeyframeValue::Crop(value),
        }
    }
}
