/**
 * Subtitle parsing and serialization for OpenTake Studio (SRT and WebVTT).
 *
 * Captions are stored as one `caption` clip whose segments are clip-relative
 * frames (see DESIGN §11.1); these helpers convert between absolute seconds in
 * SRT/VTT files and that representation.
 */

import { ModelError } from './model.js';

/** @typedef {{ startFrame: number, durationFrames: number, text: string }} CaptionSegment */

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/**
 * Convert seconds to an SRT/VTT timestamp.
 * @param {number} seconds
 * @param {'srt'|'vtt'} format
 */
export function formatTimestamp(seconds, format = 'srt') {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMilliseconds = Math.round(safe * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const millis = totalMilliseconds % 1000;
  const separator = format === 'vtt' ? '.' : ',';
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`;
}

/**
 * Parse one timestamp (`HH:MM:SS,mmm`, `MM:SS.mmm`, or with a dot).
 * @param {string} value
 * @returns {number} seconds
 */
export function parseTimestamp(value) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(value).trim());
  if (match === null) throw new ModelError('invalid-captions', `Invalid caption timestamp: ${value}`);
  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number((millis ?? '0').padEnd(3, '0')) / 1000
  );
}

/**
 * Parse SRT or WebVTT text into timed segments in seconds.
 * @param {string} text
 * @returns {{ format: 'srt'|'vtt', segments: Array<{ startSeconds: number, endSeconds: number, text: string }> }}
 */
export function parseSubtitles(text) {
  if (typeof text !== 'string') throw new ModelError('invalid-captions', 'Subtitle text is required');
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const isVtt = /^\s*WEBVTT\b/i.test(normalized);
  const body = (isVtt ? normalized.replace(/^\s*WEBVTT[^\n]*\n?/i, '') : normalized).trim();
  const blocks = body.split(/\n{2,}/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    if (lines.length === 0 || lines.every((line) => line.trim().length === 0)) continue;
    let index = 0;
    const timingAt = (line) => /^\s*(\S+)\s*-->\s*(\S+)/.exec(line);
    if (timingAt(lines[0]) === null) {
      if (/^\d+$/.test(lines[0].trim())) index = 1;
      else if (lines.length > 1 && timingAt(lines[1]) !== null) index = 1;
    }
    if (index >= lines.length) continue;
    const timing = timingAt(lines[index]);
    if (timing === null) continue;
    const startSeconds = parseTimestamp(timing[1]);
    const endSeconds = parseTimestamp(timing[2]);
    const text = lines
      .slice(index + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text.length === 0) continue;
    segments.push({ startSeconds, endSeconds: Math.max(startSeconds, endSeconds), text });
  }
  segments.sort((left, right) => left.startSeconds - right.startSeconds);
  if (segments.length === 0) throw new ModelError('invalid-captions', 'No caption cues were found');
  return { format: isVtt ? 'vtt' : 'srt', segments };
}

/**
 * Serialize caption segments (already in timeline seconds) to SRT/VTT.
 * @param {Array<{ startSeconds: number, endSeconds: number, text: string }>} segments
 * @param {'srt'|'vtt'} format
 */
export function serializeSubtitles(segments, format = 'srt') {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new ModelError('invalid-captions', 'There are no captions to export');
  }
  const result = [];
  if (format === 'vtt') result.push('WEBVTT', '');
  const ordered = [...segments].sort((left, right) => left.startSeconds - right.startSeconds);
  ordered.forEach((segment, index) => {
    if (format !== 'vtt') result.push(String(index + 1));
    result.push(
      `${formatTimestamp(segment.startSeconds, format)} --> ${formatTimestamp(segment.endSeconds, format)}`,
    );
    result.push(segment.text);
    result.push('');
  });
  return result.join('\n');
}

/**
 * Convert parsed subtitle segments to one caption clip on a caption track.
 * @param {import('./model.js').Project} project
 * @param {Array<{ startSeconds: number, endSeconds: number, text: string }>} segments
 * @param {{ trackId?: string, style?: object }} [options]
 */
export function captionClipFromSegments(project, segments, options = {}) {
  if (segments.length === 0) throw new ModelError('invalid-captions', 'There are no caption cues');
  const fps = project.fps;
  const timed = segments.map((segment) => ({
    startFrame: Math.max(0, Math.round(segment.startSeconds * fps)),
    endFrame: Math.max(0, Math.round(segment.endSeconds * fps)),
    text: segment.text,
  }));
  const clipStart = Math.min(...timed.map((segment) => segment.startFrame));
  const clipEnd = Math.max(...timed.map((segment) => segment.endFrame));
  const durationFrames = Math.max(1, clipEnd - clipStart);
  const captionSegments = timed
    .map((segment) => ({
      startFrame: Math.max(0, segment.startFrame - clipStart),
      durationFrames: Math.max(1, segment.endFrame - segment.startFrame),
      text: segment.text,
    }))
    .filter((segment) => segment.startFrame < durationFrames);
  return {
    startFrame: clipStart,
    durationFrames,
    segments: captionSegments,
    style: {
      fontSize: 48,
      color: '#ffffff',
      fontWeight: '600',
      align: 'center',
      background: 'rgba(0,0,0,0.35)',
      ...(options.style ?? {}),
    },
    ...(options.trackId === undefined ? {} : { trackId: options.trackId }),
  };
}

/**
 * Flatten every caption clip of a project into timeline-second cues for export.
 * @param {import('./model.js').Project} project
 */
export function projectCaptionSegments(project) {
  const fps = project.fps;
  const out = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type !== 'caption' || clip.caption === undefined) continue;
      for (const segment of clip.caption.segments) {
        out.push({
          startSeconds: (clip.startFrame + segment.startFrame) / fps,
          endSeconds: (clip.startFrame + segment.startFrame + segment.durationFrames) / fps,
          text: segment.text,
          style: clip.caption.style,
        });
      }
    }
  }
  return out.sort((left, right) => left.startSeconds - right.startSeconds);
}
