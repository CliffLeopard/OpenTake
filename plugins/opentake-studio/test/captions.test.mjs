import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captionClipFromSegments,
  formatTimestamp,
  parseSubtitles,
  parseTimestamp,
  projectCaptionSegments,
  serializeSubtitles,
} from '../lib/captions.js';
import { createProject } from '../lib/model.js';

test('formats and parses SRT and WebVTT timestamps', () => {
  assert.equal(formatTimestamp(0, 'srt'), '00:00:00,000');
  assert.equal(formatTimestamp(3661.234, 'srt'), '01:01:01,234');
  assert.equal(formatTimestamp(1.5, 'vtt'), '00:00:01.500');
  assert.equal(parseTimestamp('00:00:01,500'), 1.5);
  assert.equal(parseTimestamp('01:02:03.250'), 3723.25);
  assert.equal(parseTimestamp('02:03,5'), 123.5);
  assert.throws(() => parseTimestamp('nope'), /Invalid caption timestamp/);
});

test('parses SRT cues with indexes, multiline text and CRLF', () => {
  const text = [
    '1',
    '00:00:01,000 --> 00:00:02,500',
    'Hello',
    'world',
    '',
    '2',
    '00:00:03,000 --> 00:00:04,000',
    '<i>Second</i>',
    '',
  ].join('\r\n');
  const parsed = parseSubtitles(text);
  assert.equal(parsed.format, 'srt');
  assert.equal(parsed.segments.length, 2);
  assert.deepEqual(parsed.segments[0], { startSeconds: 1, endSeconds: 2.5, text: 'Hello\nworld' });
  assert.equal(parsed.segments[1].text, 'Second');
});

test('parses WebVTT with a header and cue identifiers', () => {
  const text = [
    'WEBVTT',
    '',
    'cue-1',
    '00:01.000 --> 00:02.000 align:center',
    'First',
    '',
    '00:03.000 --> 00:04.000',
    'Second',
  ].join('\n');
  const parsed = parseSubtitles(text);
  assert.equal(parsed.format, 'vtt');
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].text, 'First');
  assert.equal(parsed.segments[1].startSeconds, 3);
});

test('rejects empty or invalid subtitles', () => {
  assert.throws(() => parseSubtitles('WEBVTT\n\n'), /No caption cues/);
  assert.throws(() => parseSubtitles('not a subtitle'), /No caption cues/);
  assert.throws(() => parseSubtitles(42), /Subtitle text is required/);
});

test('serializes cues to SRT and VTT with frame rounding', () => {
  const cues = [
    { startSeconds: 0, endSeconds: 1.001, text: 'A' },
    { startSeconds: 2, endSeconds: 3.5, text: 'B\nC' },
  ];
  const srt = serializeSubtitles(cues, 'srt');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,001\nA/);
  assert.match(srt, /\n2\n00:00:02,000 --> 00:00:03,500\nB\nC\n$/);
  const vtt = serializeSubtitles(cues, 'vtt');
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.001\nA/);
});

test('builds one caption clip with clip-relative segments and defaults', () => {
  const project = createProject({ name: 'Captions', fps: 30, width: 640, height: 360 });
  const clip = captionClipFromSegments(project, [
    { startSeconds: 1, endSeconds: 2, text: 'One' },
    { startSeconds: 3, endSeconds: 4.5, text: 'Two' },
  ]);
  assert.equal(clip.startFrame, 30);
  assert.equal(clip.durationFrames, 105);
  assert.deepEqual(clip.segments, [
    { startFrame: 0, durationFrames: 30, text: 'One' },
    { startFrame: 60, durationFrames: 45, text: 'Two' },
  ]);
  assert.equal(clip.style.fontSize, 48);
  assert.equal(clip.style.align, 'center');
});

test('flattens project caption clips back to timeline seconds', () => {
  const project = createProject({ name: 'Captions', fps: 30 });
  const track = {
    id: 'caption-track',
    type: 'video',
    name: 'Captions',
    clips: [
      {
        id: 'caption-clip',
        type: 'caption',
        startFrame: 30,
        durationFrames: 60,
        caption: {
          segments: [{ startFrame: 0, durationFrames: 30, text: 'Hello' }],
          style: { fontSize: 40 },
        },
      },
    ],
    muted: false,
    hidden: false,
  };
  const segments = projectCaptionSegments({ ...project, tracks: [track] });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startSeconds, 1);
  assert.equal(segments[0].endSeconds, 2);
  assert.equal(segments[0].text, 'Hello');
});
