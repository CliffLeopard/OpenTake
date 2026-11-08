// Node-API production-path evidence for Route B HDR10 export.
//
// Usage: node hdr10-production-evidence.mjs <addon.node> <hdr-source.mp4> <out-dir>
//
// Creates a real .opentake project, imports a PQ/BT.2020 HDR source, inserts it
// on a video track, and runs the addon's chunked export twice:
//   - hdr10=true  -> production HDR10 path (HDR decode -> linear -> Main10)
//   - hdr10=false -> SDR regression path (existing RGBA8 compositor -> 10-bit)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [addonPath, sourcePath, sdrSourcePath, outDir] = process.argv.slice(2);
if (!addonPath || !sourcePath || !sdrSourcePath || !outDir) {
  console.error('usage: hdr10-production-evidence.mjs <addon.node> <hdr-source.mp4> <sdr-source.mp4> <out-dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const { Engine } = createRequire(import.meta.url)(addonPath);

const engine = new Engine();
const projectPath = path.join(outDir, 'hdr10-production.opentake');
const created = JSON.parse(engine.newProjectAt(projectPath));
if (created.projectPath !== projectPath) throw new Error('newProjectAt did not open the project');

const catalog = JSON.parse(engine.importMedia([sourcePath]));
const sourceBase = path.basename(sourcePath);
const sourceStem = sourceBase.slice(0, -path.extname(sourceBase).length);
const media = catalog.items.find(
  (item) => item.name === sourceBase || item.name === sourceStem || item.id === sourceStem,
);
if (!media) throw new Error(`import did not return ${path.basename(sourcePath)}`);
if (media.isHdr !== true) throw new Error('source was not probed as HDR');
console.log(JSON.stringify({ imported: { id: media.id, name: media.name, isHdr: media.isHdr, color: media.color } }));

engine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const durationFrames = Math.max(1, Math.round(Number(media.duration) * 30));
const applied = JSON.parse(engine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: media.id,
    mediaType: 'video',
    sourceClipType: 'video',
    trackIndex: 0,
    startFrame: 0,
    durationFrames,
    hasAudio: media.hasAudio === true,
    addLinkedAudio: false,
  }],
})));
const timeline = applied.timeline.timeline;
if (!timeline.tracks.some((track) => track.clips.length > 0)) throw new Error('clip insertion failed');

function exportOnce(outPath, hdr10) {
  const begin = JSON.parse(engine.exportBegin(
    outPath,
    'h265',
    '1080p',
    0,
    null,
    hdr10 ? 10 : 10,
    false,
    hdr10,
  ));
  let done = 0;
  while (done < begin.total) {
    const step = JSON.parse(engine.exportStep(8));
    done = step.done;
  }
  const summary = JSON.parse(engine.exportFinish());
  return { begin, summary };
}

const hdr = exportOnce(path.join(outDir, 'production_hdr10.mp4'), true);
console.log(JSON.stringify({ hdr10Export: hdr }, null, 2));
const sdr = exportOnce(path.join(outDir, 'production_sdr10.mp4'), false);
console.log(JSON.stringify({ sdr10Export: sdr }, null, 2));

// False-HDR guard: an SDR-only project must be rejected before any encoder is
// spawned. Without this, tagging SDR pixels as HDR10 would be a false claim.
const falseEngine = new Engine();
falseEngine.newProjectAt(path.join(outDir, 'false-hdr.opentake'));
const falseCatalog = JSON.parse(falseEngine.importMedia([sdrSourcePath]));
const falseMedia = falseCatalog.items.find((item) => item.name.startsWith('sdr_source'));
if (!falseMedia) throw new Error('SDR import failed');
falseEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
falseEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: falseMedia.id,
    mediaType: 'video',
    sourceClipType: 'video',
    trackIndex: 0,
    startFrame: 0,
    durationFrames: Math.max(1, Math.round(Number(falseMedia.duration) * 30)),
    hasAudio: false,
    addLinkedAudio: false,
  }],
}));
let falseHdrRejected = false;
let falseHdrMessage = '';
try {
  falseEngine.exportBegin(path.join(outDir, 'false_hdr.mp4'), 'h265', '1080p', 0, null, 10, false, true);
} catch (error) {
  falseHdrRejected = true;
  falseHdrMessage = error instanceof Error ? error.message : String(error);
}
if (!falseHdrRejected) throw new Error('false-HDR guard failed: SDR project was accepted as HDR10');
console.log(JSON.stringify({ falseHdrRejected, falseHdrMessage }));

writeFileSync(
  path.join(outDir, 'production-export.json'),
  JSON.stringify({ hdr, sdr, falseHdrRejected, falseHdrMessage }, null, 2),
);
