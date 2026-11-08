#!/usr/bin/env node
/**
 * HDR10 metadata validator (independent ffprobe).
 *
 * Classifies each file as `hdr10`, `hlg`, `sdr`, `false-hdr` or `unknown` and
 * refuses to call a file HDR10 unless ALL of these are observed:
 *   - HEVC Main 10 and a 10-bit pixel format;
 *   - colour primaries BT.2020, transfer SMPTE 2084 (PQ), matrix BT.2020-NCL;
 *   - mastering-display metadata is present (frame or stream side data).
 * HDR-looking tags without the mastering metadata / 10-bit depth are reported
 * as `false-hdr` (e.g. an SDR file re-tagged as PQ), never as HDR10.
 *
 * Usage:
 *   node scripts/route-b/verify/verify-hdr10.mjs [--expect hdr10|sdr|not-hdr] <file...> [--json]
 *
 * With --expect, exits 1 when a file does not match. Exit 2 on usage/ffprobe errors.
 */
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const args = { expect: null, json: false, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--expect') args.expect = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: verify-hdr10.mjs [--expect hdr10|sdr|not-hdr] <file...> [--json]');
      process.exit(0);
    } else args.files.push(arg);
  }
  if (args.files.length === 0) {
    console.error('verify-hdr10: no files given');
    process.exit(2);
  }
  if (args.expect !== null && !['hdr10', 'sdr', 'not-hdr'].includes(args.expect)) {
    console.error(`verify-hdr10: invalid --expect ${args.expect}`);
    process.exit(2);
  }
  return args;
}

function ffprobe(file, entries, extra = []) {
  const output = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, ...extra, '-of', 'json', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(output);
}

function sideDataTypeNames(sideDataList = []) {
  return sideDataList.map((entry) => String(entry.side_data_type ?? entry.side_type ?? ''));
}

function classify(file) {
  const streamProbe = ffprobe(file, 'stream=codec_name,profile,pix_fmt,width,height,color_space,color_transfer,color_primaries:stream_side_data_list');
  const stream = (streamProbe.streams ?? [])[0];
  if (!stream) return { file, kind: 'unknown', reason: 'no video stream' };
  let frameSideData = [];
  try {
    const frameProbe = ffprobe(file, 'frame=side_data_list', ['-read_intervals', '%+#1', '-show_frames']);
    frameSideData = ((frameProbe.frames ?? [])[0]?.side_data_list) ?? [];
  } catch {
    frameSideData = [];
  }
  const sideTypes = [...sideDataTypeNames(stream.side_data_list), ...sideDataTypeNames(frameSideData)];
  const hasMastering = sideTypes.some((type) => /mastering/i.test(type));
  const hasContentLight = sideTypes.some((type) => /content light/i.test(type));
  const pixFmt = String(stream.pix_fmt ?? '');
  const tenBit = /10(le|be)$/.test(pixFmt) || /p010|p210|p410/.test(pixFmt);
  const primaries = String(stream.color_primaries ?? '');
  const transfer = String(stream.color_transfer ?? '');
  const matrix = String(stream.color_space ?? '');
  const hdrTags = primaries === 'bt2020' || ['smpte2084', 'arib-std-b67'].includes(transfer);

  const details = { file, codec: stream.codec_name, profile: stream.profile, pix_fmt: pixFmt, width: stream.width, height: stream.height, color_primaries: primaries, color_transfer: transfer, color_space: matrix, tenBit, masteringDisplay: hasMastering, contentLight: hasContentLight, sideDataTypes: sideTypes };
  if (transfer === 'arib-std-b67') return { ...details, kind: 'hlg', reason: 'HLG transfer, not HDR10 PQ' };
  if (hdrTags) {
    if (primaries === 'bt2020' && transfer === 'smpte2084' && matrix === 'bt2020nc' && tenBit && /main 10/i.test(String(stream.profile ?? '')) && hasMastering) {
      return { ...details, kind: 'hdr10', reason: 'BT.2020/PQ Main10 with mastering-display metadata' };
    }
    return { ...details, kind: 'false-hdr', reason: `HDR-looking tags without a complete HDR10 signal (codec=${stream.codec_name}, 10bit=${tenBit}, mastering=${hasMastering}, primaries=${primaries}, transfer=${transfer}, matrix=${matrix})` };
  }
  if (hasMastering || hasContentLight) return { ...details, kind: 'false-hdr', reason: 'HDR side data on non-HDR tags' };
  if (stream.codec_name !== 'hevc') return { ...details, kind: 'unknown', reason: `non-HDR codec ${stream.codec_name}` };
  return { ...details, kind: 'sdr', reason: `SDR tags (${primaries}/${transfer}/${matrix}) and no HDR metadata` };
}

const args = parseArgs(process.argv.slice(2));
const results = [];
let failed = false;
for (const file of args.files) {
  try {
    const result = classify(file);
    results.push(result);
    const matches = args.expect === null || (args.expect === 'not-hdr' ? !['hdr10', 'hlg'].includes(result.kind) : result.kind === args.expect);
    if (!matches) failed = true;
    result.expect = args.expect;
    result.matches = matches;
  } catch (error) {
    results.push({ file, kind: 'error', reason: error.message });
    failed = true;
  }
}
if (args.json) console.log(JSON.stringify({ expect: args.expect, results, pass: !failed }, null, 2));
else {
  for (const result of results) {
    console.log(`${result.matches === false ? 'FAIL' : 'PASS'} ${result.file}`);
    console.log(`  kind: ${result.kind} — ${result.reason}`);
    if (result.codec) console.log(`  ${result.codec} ${result.profile} ${result.pix_fmt} ${result.color_primaries}/${result.color_transfer}/${result.color_space}; mastering=${result.masteringDisplay} contentLight=${result.contentLight}`);
  }
  console.log(failed ? 'verify-hdr10: FAIL' : 'verify-hdr10: OK');
}
process.exit(failed ? 1 : 0);
