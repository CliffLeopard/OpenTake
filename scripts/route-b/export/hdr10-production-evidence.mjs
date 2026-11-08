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
    addLinkedAudio: media.hasAudio === true,
  }],
})));
const timeline = applied.timeline.timeline;
if (!timeline.tracks.some((track) => track.clips.length > 0)) throw new Error('clip insertion failed');

function exportOnce(engineInstance, outPath, hdr10) {
  const begin = JSON.parse(engineInstance.exportBegin(
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
    const step = JSON.parse(engineInstance.exportStep(8));
    done = step.done;
  }
  const summary = JSON.parse(engineInstance.exportFinish());
  return { begin, summary };
}

const hdr = exportOnce(engine, path.join(outDir, 'production_hdr10.mp4'), true);
if (hdr.summary.hasAudio !== true) throw new Error('HDR10 export summary did not report the mixed audio stream');
console.log(JSON.stringify({ hdr10Export: hdr }, null, 2));
const sdr = exportOnce(engine, path.join(outDir, 'production_sdr10.mp4'), false);
console.log(JSON.stringify({ sdr10Export: sdr }, null, 2));

// Crop + basic linear color grade + project 3D LUT.
function sourceClip(engineInstance, durationFrames = 10) {
  const catalog = JSON.parse(engineInstance.importMedia([sourcePath]));
  const media = catalog.items.find((item) => item.name.startsWith('hdr_source'));
  engineInstance.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
  const timeline = JSON.parse(engineInstance.getTimeline()).timeline;
  const track = timeline.tracks.findIndex((candidate) => candidate.type === 'video');
  const applied = JSON.parse(engineInstance.apply(JSON.stringify({
    type: 'addClips',
    entries: [{
      mediaRef: media.id, mediaType: 'video', sourceClipType: 'video',
      trackIndex: track, startFrame: 0, durationFrames,
      hasAudio: true, addLinkedAudio: true,
    }],
  })));
  const clip = applied.timeline.timeline.tracks
    .flatMap((candidate) => candidate.clips)
    .find((candidate) => candidate.mediaType === 'video');
  return clip;
}

const cropEngine = new Engine();
const cropProject = path.join(outDir, 'hdr-crop.opentake');
cropEngine.newProjectAt(cropProject);
const cropClip = sourceClip(cropEngine);
cropEngine.apply(JSON.stringify({
  type: 'setClipProperties',
  clipIds: [cropClip.id],
  properties: { crop: { left: 0.25, top: 0.0, right: 0.25, bottom: 0.0 } },
}));
const cropped = exportOnce(cropEngine, path.join(outDir, 'production_hdr10_cropped.mp4'), true);
console.log(JSON.stringify({ croppedHdrExport: cropped }, null, 2));

const gradeEngine = new Engine();
const gradeProject = path.join(outDir, 'hdr-grade-lut.opentake');
gradeEngine.newProjectAt(gradeProject);
const gradeClip = sourceClip(gradeEngine);
gradeEngine.apply(JSON.stringify({
  type: 'setColorGrade',
  clipIds: [gradeClip.id],
  grade: { exposure: 0.5, contrast: 0.1, saturation: 1.2, temperature: 0.1, tint: 0.0 },
}));
const lutId = 'a'.repeat(64);
mkdirSync(path.join(gradeProject, 'media', 'luts'), { recursive: true });
const lutSize = 17;
const lutLines = [`TITLE "Invert HDR evidence"`, `LUT_3D_SIZE ${lutSize}`];
for (let b = 0; b < lutSize; b += 1) {
  for (let g = 0; g < lutSize; g += 1) {
    for (let r = 0; r < lutSize; r += 1) {
      lutLines.push([1 - r / (lutSize - 1), 1 - g / (lutSize - 1), 1 - b / (lutSize - 1)]
        .map((value) => value.toFixed(6)).join(' '));
    }
  }
}
writeFileSync(path.join(gradeProject, 'media', 'luts', `${lutId}.cube`), `${lutLines.join('\n')}\n`);
gradeEngine.apply(JSON.stringify({
  type: 'setLut',
  clipIds: [gradeClip.id],
  lut: { id: lutId, name: 'Invert evidence', intensity: 1.0 },
}));
const graded = exportOnce(gradeEngine, path.join(outDir, 'production_hdr10_grade_lut.mp4'), true);
console.log(JSON.stringify({ gradeLutHdrExport: graded }, null, 2));

// HLG input → PQ HDR10 output policy.
const hlgEngine = new Engine();
hlgEngine.newProjectAt(path.join(outDir, 'hdr-hlg.opentake'));
const hlgCatalog = JSON.parse(hlgEngine.importMedia([path.join(outDir, 'hlg_source.mp4')]));
const hlgMedia = hlgCatalog.items.find((item) => item.name.startsWith('hlg_source'));
if (!hlgMedia || hlgMedia.color?.transfer !== 'arib-std-b67') throw new Error('HLG fixture was not probed as HLG');
hlgEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const hlgTimeline = JSON.parse(hlgEngine.getTimeline()).timeline;
const hlgTrack = hlgTimeline.tracks.findIndex((track) => track.type === 'video');
hlgEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: hlgMedia.id, mediaType: 'video', sourceClipType: 'video',
    trackIndex: hlgTrack, startFrame: 0, durationFrames: 10,
    hasAudio: false, addLinkedAudio: false,
  }],
}));
const hlg = exportOnce(hlgEngine, path.join(outDir, 'production_hdr10_from_hlg.mp4'), true);
console.log(JSON.stringify({ hlgInputHdrExport: hlg }, null, 2));

// Ellipse mask with feather over HDR video.
const maskEngine = new Engine();
maskEngine.newProjectAt(path.join(outDir, 'hdr-mask.opentake'));
const maskCatalog = JSON.parse(maskEngine.importMedia([sourcePath]));
const maskMedia = maskCatalog.items.find((item) => item.name.startsWith('hdr_source'));
maskEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const maskTimeline = JSON.parse(maskEngine.getTimeline()).timeline;
const maskTrack = maskTimeline.tracks.findIndex((track) => track.type === 'video');
const maskApplied = JSON.parse(maskEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: maskMedia.id, mediaType: 'video', sourceClipType: 'video',
    trackIndex: maskTrack, startFrame: 0, durationFrames: 10,
    hasAudio: true, addLinkedAudio: true,
  }],
})));
const maskClip = maskApplied.timeline.timeline.tracks
  .flatMap((track) => track.clips)
  .find((clip) => clip.mediaType === 'video');
maskEngine.apply(JSON.stringify({
  type: 'setMasks',
  clipIds: [maskClip.id],
  masks: [{
    shape: { kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: { x: 0.3, y: 0.3 } },
    feather: 0.02,
    invert: false,
  }],
}));
const masked = exportOnce(maskEngine, path.join(outDir, 'production_hdr10_masked.mp4'), true);
console.log(JSON.stringify({ maskedHdrExport: masked }, null, 2));

// SDR text + image overlays over HDR video (203-nit SDR-white linearisation).
function textStyle() {
  return {
    fontName: 'Helvetica-Bold',
    fontSize: 48,
    fontScale: 1,
    color: { r: 1, g: 1, b: 1, a: 1 },
    alignment: 'center',
    shadow: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 }, offsetX: 0, offsetY: 0, blur: 0 },
    background: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 } },
    border: { enabled: false, color: { r: 0, g: 0, b: 0, a: 1 } },
  };
}
const overlayEngine = new Engine();
overlayEngine.newProjectAt(path.join(outDir, 'hdr-overlays.opentake'));
const overlayCatalog = JSON.parse(overlayEngine.importMedia([sourcePath, path.join(outDir, 'sdr_overlay.png')]));
const overlayVideo = overlayCatalog.items.find((item) => item.name.startsWith('hdr_source'));
const overlayImage = overlayCatalog.items.find((item) => item.name.startsWith('sdr_overlay'));
if (!overlayVideo || !overlayImage) throw new Error('overlay imports failed');
overlayEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const overlayTimeline = JSON.parse(overlayEngine.getTimeline()).timeline;
const videoTrack = overlayTimeline.tracks.findIndex((track) => track.type === 'video');
overlayEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: overlayVideo.id, mediaType: 'video', sourceClipType: 'video',
    trackIndex: videoTrack, startFrame: 0, durationFrames: 10,
    hasAudio: true, addLinkedAudio: true,
  }],
}));
// addClips prunes empty tracks, so create the overlay track after the base clip.
overlayEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const overlayTrack = JSON.parse(overlayEngine.getTimeline()).timeline.tracks
  .map((track, index) => ({ track, index }))
  .filter(({ track }) => track.type === 'video')
  .map(({ index }) => index)
  .find((index) => index !== videoTrack);
if (overlayTrack === undefined) throw new Error('overlay track was not created');
overlayEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: overlayImage.id, mediaType: 'image', sourceClipType: 'image',
    trackIndex: overlayTrack, startFrame: 0, durationFrames: 10,
    hasAudio: false, addLinkedAudio: false,
    transform: { centerX: 0.75, centerY: 0.25, width: 0.25, height: 0.25, rotation: 0, flipHorizontal: false, flipVertical: false },
  }],
}));
overlayEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const textTrack = JSON.parse(overlayEngine.getTimeline()).timeline.tracks
  .map((track, index) => ({ track, index }))
  .filter(({ track }) => track.type === 'video')
  .map(({ index }) => index)
  .find((index) => index !== videoTrack && index !== overlayTrack);
if (textTrack === undefined) throw new Error('text overlay track was not created');
overlayEngine.apply(JSON.stringify({
  type: 'addTexts',
  entries: [{
    trackIndex: textTrack,
    startFrame: 0,
    durationFrames: 10,
    content: 'HDR',
    textStyle: textStyle(),
    transform: { centerX: 0.25, centerY: 0.75, width: 0.4, height: 0.15, rotation: 0, flipHorizontal: false, flipVertical: false },
  }],
}));
const overlays = exportOnce(overlayEngine, path.join(outDir, 'production_hdr10_overlays.mp4'), true);
if (overlays.summary.hasAudio !== true) throw new Error('overlay HDR export lost audio');
console.log(JSON.stringify({ overlayHdrExport: overlays }, null, 2));

// Keyframed opacity on an HDR video layer.
const keyframeEngine = new Engine();
keyframeEngine.newProjectAt(path.join(outDir, 'hdr-keyframes.opentake'));
const keyframeCatalog = JSON.parse(keyframeEngine.importMedia([sourcePath]));
const keyframeMedia = keyframeCatalog.items.find((item) => item.name.startsWith('hdr_source'));
keyframeEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const keyframeTimeline = JSON.parse(keyframeEngine.getTimeline()).timeline;
const keyframeTrack = keyframeTimeline.tracks.findIndex((track) => track.type === 'video');
const keyframeApplied = JSON.parse(keyframeEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: keyframeMedia.id, mediaType: 'video', sourceClipType: 'video',
    trackIndex: keyframeTrack, startFrame: 0, durationFrames: 10,
    hasAudio: true, addLinkedAudio: true,
  }],
})));
const keyframeClip = keyframeApplied.timeline.timeline.tracks
  .flatMap((track) => track.clips)
  .find((clip) => clip.mediaType === 'video');
keyframeEngine.apply(JSON.stringify({
  type: 'setKeyframes',
  clipId: keyframeClip.id,
  property: 'opacity',
  payload: {
    kind: 'scalar',
    keyframes: [
      { frame: 0, value: 1.0 },
      { frame: 9, value: 0.2 },
    ],
  },
}));
const keyframed = exportOnce(keyframeEngine, path.join(outDir, 'production_hdr10_keyframed.mp4'), true);
console.log(JSON.stringify({ keyframedHdrExport: keyframed }, null, 2));

// Affine transform + opacity HDR layer in the linear CPU compositor.
const transformEngine = new Engine();
transformEngine.newProjectAt(path.join(outDir, 'hdr-transform.opentake'));
const transformCatalog = JSON.parse(transformEngine.importMedia([sourcePath]));
const transformMedia = transformCatalog.items.find((item) => item.name.startsWith('hdr_source'));
if (!transformMedia) throw new Error('transform HDR import failed');
transformEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const transformTimeline = JSON.parse(transformEngine.getTimeline()).timeline;
const transformTrack = transformTimeline.tracks.find((track) => track.type === 'video');
const transformApplied = JSON.parse(transformEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: transformMedia.id,
    mediaType: 'video',
    sourceClipType: 'video',
    trackIndex: transformTimeline.tracks.indexOf(transformTrack),
    startFrame: 0,
    durationFrames: 60,
    hasAudio: true,
    addLinkedAudio: true,
    transform: {
      centerX: 0.25, centerY: 0.5, width: 0.5, height: 1.0,
      rotation: 0, flipHorizontal: false, flipVertical: false,
    },
  }],
})));
const transformClip = transformApplied.timeline.timeline.tracks
  .flatMap((track) => track.clips)
  .find((clip) => clip.mediaType === 'video');
if (!transformClip) throw new Error('transformed clip insertion failed');
transformEngine.apply(JSON.stringify({
  type: 'setClipProperties',
  clipIds: [transformClip.id],
  properties: { opacity: 0.75 },
}));
const transformed = exportOnce(transformEngine, path.join(outDir, 'production_hdr10_transformed.mp4'), true);
console.log(JSON.stringify({ transformedHdrExport: transformed }, null, 2));

// False-HDR guard: an SDR-only project must be rejected before any encoder is
// spawned. Without this, tagging SDR pixels as HDR10 would be a false claim.
// Nested sequence: one compound level over the HDR source.
const nestedEngine = new Engine();
nestedEngine.newProjectAt(path.join(outDir, 'hdr-nested.opentake'));
const nestedClip = sourceClip(nestedEngine);
nestedEngine.apply(JSON.stringify({ type: 'createNestedSequence', name: 'HDR Compound', clipIds: [nestedClip.id] }));
const nested = exportOnce(nestedEngine, path.join(outDir, 'production_hdr10_nested.mp4'), true);
console.log(JSON.stringify({ nestedHdrExport: nested }, null, 2));

// Basic linear effects: invert.
const effectsEngine = new Engine();
effectsEngine.newProjectAt(path.join(outDir, 'hdr-effects.opentake'));
const effectsClip = sourceClip(effectsEngine);
effectsEngine.apply(JSON.stringify({ type: 'setEffects', clipIds: [effectsClip.id], effects: [{ name: 'invert', params: { amount: 1 }, enabled: true }] }));
const effects = exportOnce(effectsEngine, path.join(outDir, 'production_hdr10_effects.mp4'), true);
console.log(JSON.stringify({ effectsHdrExport: effects }, null, 2));

// Chroma key: key the neutral grey bars.
const chromaEngine = new Engine();
chromaEngine.newProjectAt(path.join(outDir, 'hdr-chroma.opentake'));
const chromaClip = sourceClip(chromaEngine);
chromaEngine.apply(JSON.stringify({
  type: 'setChromaKey',
  clipIds: [chromaClip.id],
  chromaKey: { keyColor: { r: 0.5, g: 0.5, b: 0.5 }, similarity: 0.8, smoothness: 0.1, spill: 0 },
}));
const chroma = exportOnce(chromaEngine, path.join(outDir, 'production_hdr10_chroma.mp4'), true);
console.log(JSON.stringify({ chromaHdrExport: chroma }, null, 2));

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
  JSON.stringify({ hdr, sdr, overlays, transformed, keyframed, masked, cropped, graded, hlg, nested, effects, chroma, falseHdrRejected, falseHdrMessage }, null, 2),
);
