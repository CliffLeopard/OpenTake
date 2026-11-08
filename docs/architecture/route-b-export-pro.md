# Route B export-pro — 10-bit H.265, HDR policy, audio ducking

Status: isolated prototype slice · 2026-11-08 · branch `feat/dsh-rust-engine`

This document reports the export-parity slice implemented in
`crates/opentake-export-pro` and verified by `scripts/route-b/export/run-evidence.sh`.
It is deliberately self-contained: **the root workspace, `crates/opentake-node` and
the shared encoders were not modified**. The crate is a standalone Cargo workspace
(`[workspace]` in its manifest) with only `serde`/`serde_json` dependencies, so it
can be built and reviewed without the Route B integration tree.

## 1. Claims, kept separate

The workstream requires separating "10-bit encoding works" from "HDR content is
tone-mapped". This is the evidence-backed split:

| Claim | Status | Evidence |
|---|---|---|
| The export path can emit a real 10-bit HEVC stream (`yuv420p10le`, Main 10) from RGBA8 compositor frames | **Verified** | `/tmp/opentake-export-pro/h265_10bit.mp4`, ffprobe `profile=Main 10`, `pix_fmt=yuv420p10le`, 60 frames, 640x360, 30 fps |
| 10-bit delivery adds precision, not dynamic range: the composited source is SDR RGBA8 BT.709 | **Verified by construction** | `EncodeSpec::bit_depth = ten` with `ColorTags::bt709`; no HDR tags on the output |
| HDR10 passthrough is available from the current compositor | **No** | The compositor output is RGBA8 SDR (`composite_frame_decoded` → `RgbaFrame`); `HdrDecision` refuses passthrough unless `CompositorCapability::HdrLinear16` is declared |
| HDR (PQ) content is converted to SDR on this machine, and the conversion actually changes pixels | **Verified** | VideoToolbox `scale_vt` decode→SDR; bars `64/300/600/900` → `64/276/893/939` BT.709 codes; PSNR vs source is finite (`18.54 dB`); a tag-only retag copy stays pixel-identical (`PSNR=inf`) |
| The VideoToolbox tone-map curve/peak is configurable | **No** | System defaults only; software `zscale`/`tonemap` is not compiled into the local ffmpeg 9.0.2 build |
| Ducking produces the requested gain reduction | **Verified** | Requested `-12 dB`; measured voice-window mean `-11.73 dB`, report peak `-11.997 dB`; voice amplitude unchanged (window std ratio `1.000`); pre-voice delta `0.00 dB`; post-voice recovery `-1.19 dB` at 1.95 s (still releasing) |

**Bottom line:** 10-bit encoding works today for SDR frames. HDR export is not a
packaging switch; it needs a compositor that can emit linear/HDR frames and a
tunable tone-map path. The decode-stage HDR→SDR conversion already used by
`opentake-media::color` is demonstrated and measured here.

## 2. Environment

| Item | Value |
|---|---|
| System | Darwin 27.2.0 arm64 (macOS) |
| ffmpeg / ffprobe | 9.0.2 (Homebrew) |
| Rust | rustc 1.99.1, cargo 1.99.1 |
| Node | not involved (export-pro is a Rust CLI) |
| HDR filters found | `scale_vt` (VideoToolbox), `tonemap`; **no** `zscale`/`libplacebo` |
| Encoders found | `libx264`, `libx265`, `prores_ks` |

Unit tests: **26 passed / 0 failed** (`cargo test --release --manifest-path
crates/opentake-export-pro/Cargo.toml --lib`).

## 3. Files

```
crates/opentake-export-pro/
  Cargo.toml                 standalone workspace, serde + serde_json only
  src/lib.rs                 error type, ffmpeg/ffprobe resolution
  src/codec.rs               codec × bit-depth × colour → ffmpeg args, frame writer
  src/hdr.rs                 HDR detection, backend probe, policy decision
  src/ducking.rs             role/sidechain contract, gate + envelope, mix
  src/wav.rs                 mono 16-bit WAV writer (ducking evidence)
  src/bin/export-pro.rs      encode / probe / hdr-policy / tone-map / ducking CLI
scripts/route-b/export/
  run-evidence.sh            end-to-end reproduction
  ffprobe-verify.sh          bit-depth/pix_fmt/colour/HDR-side-data checks
  hdr-yuv-measure.py         raw 10-bit bar measurement before/after tone-map
  ducking-measure.py         WAV gain-deviation measurement
```

## 4. Reproduction

```bash
# from the repository root
cd /Users/cliffleopard/Develop/OpenSource/Harness/OpenTake

# 1. build + unit tests (target dir stays under /tmp)
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR=/tmp/opentake-export-pro-target
cargo build --release --manifest-path crates/opentake-export-pro/Cargo.toml
cargo test  --release --manifest-path crates/opentake-export-pro/Cargo.toml --lib

# 2. full evidence run (real encodes, tone-map, ducking, ffprobe)
./scripts/route-b/export/run-evidence.sh            # writes /tmp/opentake-export-pro
```

The script honours `OPENTAKE_FFMPEG` / `OPENTAKE_FFPROBE` (default: `ffmpeg` /
`ffprobe` on `PATH`) and never writes the repository `target/` directory.

Individual commands, as executed:

```bash
BIN=/tmp/opentake-export-pro-target/release/export-pro

# 10-bit H.265 from synthetic RGBA8 frames
$BIN encode --out /tmp/opentake-export-pro/h265_10bit.mp4 \
  --codec h265 --bit-depth 10 --width 640 --height 360 --fps 30 --frames 60 \
  --crf 20 --preset medium

# 8-bit control (same frames)
$BIN encode --out /tmp/opentake-export-pro/h265_8bit.mp4 \
  --codec h265 --bit-depth 8 --width 640 --height 360 --fps 30 --frames 60 \
  --crf 20 --preset medium

# HDR policy for a PQ source against the current SDR compositor
$BIN hdr-policy --primaries bt2020 --transfer smpte2084 --matrix bt2020nc \
  --range tv --compositor sdr

# PQ bar source (10-bit, BT.2020/PQ tags)
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=640x360:r=30:d=1,format=yuv420p10le,geq=lum='if(lt(X,160),64,if(lt(X,320),300,if(lt(X,480),600,900)))':cb=512:cr=512" \
  -c:v libx265 -pix_fmt yuv420p10le \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -x265-params "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc" \
  /tmp/opentake-export-pro/hdr_pq_bars.mp4

# HDR->SDR tone-map through the policy-selected backend
$BIN tone-map --source /tmp/opentake-export-pro/hdr_pq_bars.mp4 \
  --out /tmp/opentake-export-pro/hdr_pq_bars_tonemapped.mp4

# Control: metadata-only retag (copy stream, new colour tags, no conversion)
ffmpeg -y -hide_banner -loglevel error -i /tmp/opentake-export-pro/hdr_pq_bars.mp4 -c copy \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  /tmp/opentake-export-pro/hdr_pq_bars_retagged.mp4

# Ducking demo render + report
$BIN ducking --out /tmp/opentake-export-pro/duck.wav \
  --noduck /tmp/opentake-export-pro/noduck.wav \
  --report /tmp/opentake-export-pro/ducking-report.json \
  --depth 12 --threshold -38 --attack 80 --release 400 --hold 200
```

## 5. 10-bit H.265 results

`h265_10bit.mp4` (60 frames, 640×360, 30 fps, CRF 20, medium):

```
codec_name=hevc
profile=Main 10
pix_fmt=yuv420p10le
width=640  height=360  r_frame_rate=30/1
color_space=bt709  color_transfer=bt709  color_primaries=bt709
format: duration=2.000000  bit_rate=97084
```

`ffprobe` reports `bits_per_raw_sample=N/A` for HEVC in this build; the
authoritative 10-bit evidence is `profile=Main 10` + `pix_fmt=yuv420p10le`.
The stream is a normal 8-bit-input encode: the compositor frames are RGBA8, so
this is 10-bit **coding precision**, not a higher dynamic range source.

The argument contract adds, over the production 8-bit path
(`opentake_media::encode::preset::ExportPreset`):

```
-c:v libx265 -pix_fmt yuv420p10le -profile:v main10 -crf 20 -preset medium
-vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709
-x265-params log-level=error
-colorspace bt709 -color_primaries bt709 -color_trc bt709
```

The `setparams` filter is required: stream flags alone leave primaries/transfer
`unknown` in the produced bitstream (the shared preset documents the same
workaround for SDR delivery).

### Size at equal CRF (synthetic gradient + moving box, 60 frames)

| Delivery | Bytes | Bitrate | Encode time |
|---|---:|---:|---:|
| H.265 8-bit (`yuv420p`) | 30,514 | 122 kb/s | 412 ms |
| H.265 10-bit (`yuv420p10le`) | 24,271 | 97 kb/s | 547 ms |

This is one synthetic clip, not a quality ranking; 10-bit is not expected to be
larger at equal CRF for flat gradients (quantisation error is smaller), and the
prototype does not claim a quality metric for 10-bit vs 8-bit. On real camera
media compare VMAF/SSIM at matched bitrate before selecting a delivery default.

## 6. HDR policy and tone-map evidence

### Policy decision

`hdr-policy` for a PQ (SMPTE ST 2084) source against the current compositor:

```json
{
  "sourceIsHdr": true,
  "compositor": "sdrRgba8",
  "deliverable": "sdr10",
  "bitDepth": 10,
  "toneMapBackend": "videoToolbox",
  "toneMapStage": "decode",
  "toneMapFilter": "scale_vt=w=iw:h=ih:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le",
  "toneMapped": true,
  "notes": [
    "HDR source: tone-map at decode time (before the SDR RGBA8 compositor), matching opentake-media::color; the encoder receives SDR frames.",
    "VideoToolbox uses system EDR→SDR defaults; curve/peak are not tunable in this build."
  ]
}
```

This mirrors the existing `opentake-media::color::hdr_tonemap_filter` policy:
HDR is converted while decoding, not by the encoder. The compositor therefore
never sees HDR, and the export encoder only ever receives SDR frames.

The policy also models the future path (unit-tested, not reachable today):

- `CompositorCapability::HdrLinear16` + `allow_hdr_passthrough` →
  `deliverable: "hdr10"`, BT.2020/PQ tags and `-x265-params`
  `colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=…:max-cll=…`.
- Without an HDR compositor the same request falls back to SDR and records that
  passthrough was refused.

### Measured conversion (real pixels)

The PQ test source has four flat luma bars. `hdr-yuv-measure.py` reads the raw
10-bit Y plane before and after the tone-map:

| Bar | PQ source code | Tone-mapped BT.709 code |
|---|---:|---:|
| 1 | 64 | 64 |
| 2 | 300 | 276 |
| 3 | 600 | 893 |
| 4 | 900 | 939 |

A metadata-only retag (`-c copy` plus BT.709 tags) leaves every code unchanged;
the PSNR comparison proves the difference:

```
tone-mapped vs source: PSNR y:16.776  average:18.537  (pixels changed)
retag-only  vs source: PSNR average:inf              (pixels identical)
```

So the tone-map is real, but its curve is VideoToolbox's system EDR→SDR
mapping; there is no peak/curve control in this ffmpeg build
(`zscale`/`libplacebo` absent). Treat this as an HDR→SDR *decode* capability,
not a graded HDR delivery pipeline.

## 7. Audio ducking

### Contract

`crates/opentake-export-pro/src/ducking.rs` defines the minimum sidechain
contract:

```rust
enum AudioRole { Voice, Music, Sfx, Other }
struct DuckingConfig { threshold_db, depth_db, attack_ms, release_ms, hold_ms, sample_rate }
struct AudioLayer { start_sample, samples: Vec<f32>, base_gains: Vec<f32>, role }
```

Voice layers build a peak-follower envelope (instant attack, 10 ms peak-hold
decay so a sine's zero crossings do not chatter the gate). The envelope opens
the gate above `threshold_db`; non-voice layers receive a one-pole attack/hold/
release envelope whose steady state is `-depth_db`. Explicit `base_gains`
(clip volume/fades) multiply the ducking gain, so ducking composes with current
fade automation.

This is the same shape as `opentake_media::encode::mix::ClipAudio`
(`start_sample` + `samples` + per-sample `gains`), so promotion is mechanical:
compute `ducking_gains`, multiply them into each non-voice clip's
`ClipAudio.gains`, then call the existing `mix_clips`.

### Measured demo (music bed 0.5 DC, 440 Hz voice from 0.5 s to 1.0 s)

Config: `threshold=-38 dB`, `depth=12 dB`, `attack=80 ms`, `release=400 ms`,
`hold=200 ms`, 48 kHz.

| Measurement | Value |
|---|---|
| Pre-voice window (0.20–0.45 s) gain delta | `0.00 dB` |
| Voice window (0.80–0.98 s) mean gain delta | `-11.73 dB` (requested `-12.00`) |
| Report peak gain | `-11.997 dB` |
| Voice-window std ratio (ducked/reference) | `1.000` → voice not attenuated |
| Post-voice window (1.90–1.99 s) delta | `-1.19 dB` (still releasing) |
| Open voice ranges | `[[24001, 59340]]` at 48 kHz |

The reference WAV is the same layers with ducking disabled, so the deltas
isolate the gain change. `ducking-measure.py` asserts these relationships and
exits non-zero on regression.

## 8. Codec constraints implemented

| Combination | Status | Notes |
|---|---|---|
| H.265 8-bit (`yuv420p`) | supported | profile `main` |
| H.265 10-bit (`yuv420p10le`) | supported | profile `main10`; requires even dimensions |
| H.264 10-bit | rejected | H.264 delivery stays 8-bit in this prototype |
| ProRes 422 / 4444 | supported, 10-bit only | `yuv422p10le` / `yuva444p10le` |
| HDR10 tags (`bt2020`/`smpte2084`) | policy + arg builder only | requires H.265 10-bit; refused with SDR compositor |
| `master-display` / `max-cll` | unit-tested | emitted through `-x265-params`; only when HDR tags are set |
| odd width/height | rejected | 4:2:0/4:2:2 require even dimensions |
| `crf` with ProRes | rejected | ProRes uses qscale in this prototype |

## 9. Integration contract (next milestone)

Read against the existing tree:

- `crates/opentake-media/src/encode/preset.rs` — `ExportPreset::pix_fmt_arg()`
  returns `yuv420p` for H.265. Add a bit-depth dimension (or an
  `H265TenBit` codec variant) and return `yuv420p10le`; return
  `Option<bit_depth>` from the preset so the node `export_begin` can pass it.
- `crates/opentake-media/src/encode/mod.rs` — `encode_args` should accept the
  new preset and keep the existing `setparams` colour filter; 10-bit needs no
  input change because the compositor still streams RGBA8.
- `crates/opentake-node/src/lib.rs` — `export_begin` currently maps
  `codec`/`quality` strings to `VideoCodec`/`ExportResolution`. Add a
  `bitDepth`/`hdr` option and pass the resolved preset; keep `composite_frame_decoded`
  unchanged (SDR RGBA8).
- `crates/opentake-media/src/color.rs` — already owns decode-stage HDR→SDR; the
  export-pro policy decision should delegate to the same backend probe instead
  of duplicating it once the crate is promoted.
- `crates/opentake-media/src/encode/mix.rs` — add role-aware ducking by
  multiplying `ducking_gains` into `ClipAudio.gains`; no signature change to
  `mix_clips`.
- `opentake_node::export_begin` audio mix currently collects `ClipType::Audio`
  clips only; video-clip audio and denoise remain separate gaps (see
  `docs/architecture/route-b-parity.md` H4).

Recommended staging:

1. Land bit-depth-aware `ExportPreset` + node `bitDepth` option (no HDR claim).
2. Add domain fields for audio roles/ducking parameters, then apply ducking in
   the mix.
3. Only after a linear/HDR compositor exists, enable `HdrPolicy::allow_hdr_passthrough`
   and HDR10 signing; do not expose an "HDR" export toggle before that.

## 10. Missing domain fields (exact)

- `opentake-domain/src/timeline.rs:327 Track` — no `role`
  (`voice`/`music`/`sfx`/`other`) and no ducking config/automation; only
  `muted`, `hidden`, `syncLocked`.
- `opentake-domain/src/clip.rs` — audio clips have `volume`, `fadeIn/OutFrames`,
  `volumeTrack` and `audioDenoise`, but no `audioRole`/`isVoice` and no
  sidechain/ducking source reference.
- Project/timeline settings — no ducking enable/depth/threshold/attack/release
  defaults; no export HDR policy.
- `opentake-domain/src/media.rs:60 MediaColorMetadata` — has
  primaries/transfer/matrix/range only. Missing for HDR10 delivery:
  mastering-display chromaticity/luminance, MaxCLL, MaxFALL, and a declared
  bit-depth/HDR format (e.g. Dolby Vision).
- `opentake-media/src/encode/preset.rs` — `ExportPreset` has no bit-depth or
  HDR mode field, so 10-bit/HDR cannot be requested through the existing
  node/desktop API.
- Frame contract — `opentake_media::RgbaFrame` is RGBA8; there is no
  linear/HDR frame type or compositor capability flag for the policy to read.

## 11. Evidence artifacts (`/tmp/opentake-export-pro`)

| File | Content |
|---|---|
| `h265_10bit.mp4` | 10-bit HEVC, Main 10, `yuv420p10le`, BT.709 |
| `h265_8bit.mp4` | 8-bit control, same frames/CRF |
| `hdr_pq_bars.mp4` | PQ/BT.2020 test source (10-bit) |
| `hdr_pq_bars_tonemapped.mp4` | VideoToolbox tone-mapped SDR 10-bit output |
| `hdr_pq_bars_retagged.mp4` | metadata-only retag control (pixels identical) |
| `duck.wav`, `noduck.wav` | ducked mix and same-layer reference |
| `ducking-report.json` | envelope windows, voice ranges, peak gain |
| `ffprobe.txt` | full ffprobe evidence for every video |
| `hdr-yuv.txt` | bar codes before/after tone-map |
| `psnr-tonemap.txt`, `psnr-retag.txt` | finite vs `inf` PSNR proof |
| `ducking-measure.txt` | gain checks and PASS/FAIL |
| `encode-10bit.json`, `encode-8bit.json`, `hdr-policy.json`, `tone-map.json`, `ducking.json` | exact command outputs |

## 12. Limitations

- The HDR tone-map is VideoToolbox's system EDR→SDR conversion; no curve/peak
  control is available in this ffmpeg build (no `zscale`/`libplacebo`).
- HDR10 passthrough (`Deliverable::Hdr10`) is implemented as a policy and
  argument builder, **not** as a working export: the compositor cannot supply
  HDR frames yet.
- 10-bit encoding is proven on synthetic SDR frames; real-media quality/size
  comparison (VMAF at matched bitrate) is future work.
- Ducking evidence is synthetic (DC bed + sine voice). Speech/material content
  needs a real voice-activity detector and listening tests before defaults ship.
- Audio muxing was not part of this slice; the production encoder's AAC mux path
  is unchanged.


## Host integration status (Lead, 2026-11-08)

`ExportPreset` now carries an optional bit depth; the N-API/Host export path
accepts `bitDepth:10` for H.265. Verified Host export produced HEVC Main10
`yuv420p10le` at 1280x720 (0.5 s, BT.709 tags). HDR10 passthrough, tone-map
policy and ducking remain isolated/not wired.
