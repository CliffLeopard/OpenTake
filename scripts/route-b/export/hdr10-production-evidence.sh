#!/usr/bin/env bash
# Production-path HDR10 evidence through the Route B Node-API addon.
#
#  1. builds crates/opentake-node (release)
#  2. creates a real PQ/BT.2020 HDR source MP4
#  3. imports it into a real .opentake project via the addon
#  4. exports hdr10=true and hdr10=false through the addon chunked API
#  5. ffprobe + raw PQ/SDR pixel measurement
#
# Usage: scripts/route-b/export/hdr10-production-evidence.sh [output-dir]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-/tmp/route-b-hdr10-production}"
FFMPEG="${OPENTAKE_FFMPEG:-$(command -v ffmpeg || true)}"
FFPROBE="${OPENTAKE_FFPROBE:-$(command -v ffprobe || true)}"
export PATH="$HOME/.cargo/bin:$PATH"
export OPENTAKE_FFMPEG="${OPENTAKE_FFMPEG:-$FFMPEG}"
export OPENTAKE_FFPROBE="${OPENTAKE_FFPROBE:-$FFPROBE}"

if [ -z "$FFMPEG" ] || [ ! -x "$FFMPEG" ]; then echo "ffmpeg not found" >&2; exit 1; fi
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
mkdir -p "$OUT"

echo "== build addon"
cargo build --release -p opentake-node
ADDON_SRC="$ROOT/target/release/libopentake_node.dylib"
if [ ! -f "$ADDON_SRC" ]; then
  ADDON_SRC="$ROOT/target/release/libopentake_node.so"
fi
if [ ! -f "$ADDON_SRC" ]; then
  ADDON_SRC="$ROOT/target/release/opentake_node.dll"
fi
if [ ! -f "$ADDON_SRC" ]; then echo "addon build output not found" >&2; exit 1; fi
ADDON="$OUT/opentake_engine.node"
cp "$ADDON_SRC" "$ADDON"

echo "== HDR PQ source: four bars matching the linear contract"
# PQ codes for linear 1/203/1000/4000 cd/m² -> 10-bit limited-range Y codes.
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=640x360:r=30:d=2,format=yuv420p10le,geq=lum='if(lt(X,160),195,if(lt(X,320),573,if(lt(X,480),723,855)))':cb=512:cr=512" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" \
  -frames:v 60 -map 0:v:0 -map 1:a:0 -c:v libx265 -pix_fmt yuv420p10le -c:a aac -b:a 128k \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -x265-params "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc" \
  -shortest "$OUT/hdr_source.mp4"

echo "== SDR source for the false-HDR guard"
echo "== HLG fixture (ARIB STD-B67 input)"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=640x360:r=30:d=1,format=yuv420p10le,geq=lum='if(lt(X,160),128,if(lt(X,320),384,if(lt(X,480),640,896)))':cb=512:cr=512" \
  -frames:v 30 -c:v libx265 -pix_fmt yuv420p10le \
  -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc \
  -x265-params "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc" \
  "$OUT/hlg_source.mp4"

echo "== SDR image overlay fixture"
"$FFMPEG" -y -hide_banner -loglevel error -f lavfi -i "color=c=white:s=160x160:d=1,format=rgba" \
  -frames:v 1 "$OUT/sdr_overlay.png"

"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=gray:s=640x360:r=30:d=2,format=yuv420p" \
  -frames:v 60 -c:v libx264 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 "$OUT/sdr_source.mp4"

echo "== addon production export (HDR10 + SDR regression)"
node "$HERE/hdr10-production-evidence.mjs" "$ADDON" "$OUT/hdr_source.mp4" "$OUT/sdr_source.mp4" "$OUT" \
  | tee "$OUT/production.log"

echo "== ffprobe"
"$HERE/ffprobe-verify.sh" "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" "$OUT/production_hdr10_transformed.mp4" "$OUT/production_hdr10_overlays.mp4" "$OUT/production_hdr10_keyframed.mp4" \
  | tee "$OUT/ffprobe.txt"

WIDTH=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$OUT/production_hdr10.mp4")
HEIGHT=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$OUT/production_hdr10.mp4")
AUDIO_CODEC=$("$FFPROBE" -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$OUT/production_hdr10.mp4")
if [ "$AUDIO_CODEC" != "aac" ]; then
  echo "production HDR10 is missing the AAC audio stream (got: ${AUDIO_CODEC:-none})" >&2
  exit 1
fi
echo "== audio stream: $AUDIO_CODEC"
echo "== pixel measurement (${WIDTH}x${HEIGHT})"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/production_hdr10.yuv"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_sdr10.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/production_sdr10.yuv"
python3 "$HERE/hdr10-measure.py" --raw "$OUT/production_hdr10.yuv" --width "$WIDTH" --height "$HEIGHT" --kind hdr \
  | tee "$OUT/production-hdr-measure.json"
python3 "$HERE/hdr10-measure.py" --raw "$OUT/production_sdr10.yuv" --width "$WIDTH" --height "$HEIGHT" --kind sdr-tone-mapped \
  | tee "$OUT/production-sdr-measure.json"

echo "== affine-transform HDR pixel evidence (layer at left half, opacity 0.75)"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10_transformed.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/production_hdr10_transformed.yuv"
python3 - "$OUT/production_hdr10_transformed.yuv" "$WIDTH" "$HEIGHT" <<'PY' | tee "$OUT/production-transform-measure.json"
import json, struct, sys
path, width, height = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
data = open(path, 'rb').read()
needed = width * height * 2
if len(data) < needed:
    raise SystemExit(f'{path}: short Y plane ({len(data)} < {needed})')
y = list(struct.unpack(f'<{width * height}H', data[:needed]))
row = height // 2
inside = y[row * width + width // 10]
outside = y[row * width + 3 * width // 4]
result = {
    'insideY': inside,
    'outsideY': outside,
    'insideIsHdr': inside > 100,
    'outsideIsBlack': 60 <= outside <= 70,
    'pass': inside > 100 and 60 <= outside <= 70,
}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['pass'] else 1)
PY

"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/base_f0.yuv"

echo "== SDR overlay evidence (image + text over HDR)"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10_overlays.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/overlay_f0.yuv"
python3 - "$OUT/base_f0.yuv" "$OUT/overlay_f0.yuv" "$WIDTH" "$HEIGHT" <<'PY' | tee "$OUT/production-overlay-measure.json"
import json, struct, sys
base, overlay, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def plane(path):
    data = open(path, 'rb').read()
    return struct.unpack(f'<{width * height}H', data[:width * height * 2])
a, b = plane(base), plane(overlay)
image_at = (int(0.75 * width), int(0.25 * height))
image_delta = abs(a[image_at[1] * width + image_at[0]] - b[image_at[1] * width + image_at[0]])
changed_text = 0
for y in range(int(0.65 * height), int(0.85 * height)):
    for x in range(int(0.05 * width), int(0.45 * width)):
        i = y * width + x
        if abs(a[i] - b[i]) > 2:
            changed_text += 1
result = {
    'imageSampleDelta': image_delta,
    'textChangedPixels': changed_text,
    'imageOverlayVisible': image_delta > 50,
    'textOverlayVisible': changed_text > 100,
    'pass': image_delta > 50 and changed_text > 100,
}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['pass'] else 1)
PY

echo "== crop evidence"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10_cropped.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/cropped_f0.yuv"
python3 - "$OUT/base_f0.yuv" "$OUT/cropped_f0.yuv" "$WIDTH" "$HEIGHT" <<'PY' | tee "$OUT/production-crop-measure.json"
import json, struct, sys
base, cropped, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def plane(path):
    data = open(path, 'rb').read()
    return struct.unpack(f'<{width * height}H', data[:width * height * 2])
a, b = plane(base), plane(cropped)
row = height // 2
left = abs(a[row * width + int(0.2 * width)] - b[row * width + int(0.2 * width)])
right = abs(a[row * width + int(0.8 * width)] - b[row * width + int(0.8 * width)])
result = {'leftDelta': left, 'rightDelta': right, 'pass': left > 20 and right > 20}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['pass'] else 1)
PY

echo "== grade + 3D LUT evidence"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10_grade_lut.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/grade_f0.yuv"
python3 - "$OUT/base_f0.yuv" "$OUT/grade_f0.yuv" "$WIDTH" "$HEIGHT" <<'PY' | tee "$OUT/production-grade-measure.json"
import json, struct, sys
base, graded, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def sample(path):
    data = open(path, 'rb').read()
    return struct.unpack_from('<H', data, (height // 2 * width + width // 2) * 2)[0]
a, b = sample(base), sample(graded)
result = {'baseY': a, 'gradedY': b, 'delta': abs(a - b), 'pass': abs(a - b) > 20}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['pass'] else 1)
PY

echo "== HLG→PQ input evidence"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10_from_hlg.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/hlg_f0.yuv"
python3 - "$OUT/hlg_f0.yuv" "$WIDTH" "$HEIGHT" <<'PY' | tee "$OUT/production-hlg-measure.json"
import json, struct, sys
path, width, height = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
data = open(path, 'rb').read()
y = struct.unpack(f'<{width * height}H', data[:width * height * 2])
codes = [y[(height // 2) * width + int(width * fraction)] for fraction in (0.125, 0.375, 0.625, 0.875)]
result = {'measuredYCodes': codes, 'distinctLevels': len(set(codes)), 'pass': len(set(codes)) >= 3}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['pass'] else 1)
PY

echo "== ellipse mask evidence (feather 0.02)"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10_masked.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/masked_f0.yuv"
python3 - "$OUT/masked_f0.yuv" "$WIDTH" "$HEIGHT" <<'PY' | tee "$OUT/production-mask-measure.json"
import json, struct, sys
path, width, height = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
data = open(path, 'rb').read()
y = struct.unpack(f'<{width * height}H', data[:width * height * 2])
center = y[(height // 2) * width + width // 2]
corner = y[int(0.05 * height) * width + int(0.05 * width)]
result = {'centerY': center, 'cornerY': corner, 'centerIsHdr': center > 100, 'cornerIsBlack': 60 <= corner <= 70, 'pass': center > 100 and 60 <= corner <= 70}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['pass'] else 1)
PY

echo "== keyframed opacity evidence (frame 0 vs frame 9)"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10_keyframed.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/keyframed_f0.yuv"
"$FFMPEG" -y -hide_banner -loglevel error -ss 0.3 -i "$OUT/production_hdr10_keyframed.mp4" -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/keyframed_f9.yuv"
python3 - "$OUT/keyframed_f0.yuv" "$OUT/keyframed_f9.yuv" "$WIDTH" "$HEIGHT" <<'PY' | tee "$OUT/production-keyframe-measure.json"
import json, struct, sys
f0, f9, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def sample(path):
    data = open(path, 'rb').read()
    return struct.unpack_from('<H', data, (height // 2 * width + width // 2) * 2)[0]
a, b = sample(f0), sample(f9)
result = {'frame0Y': a, 'frame9Y': b, 'keyframed': b < a - 50, 'pass': b < a - 50}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['pass'] else 1)
PY

echo "== hashes"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" "$OUT/production_hdr10_transformed.mp4" "$OUT/production_hdr10_overlays.mp4" "$OUT/production_hdr10_keyframed.mp4" "$OUT/production_hdr10_masked.mp4" "$OUT/production_hdr10_from_hlg.mp4" "$OUT/production_hdr10_cropped.mp4" "$OUT/production_hdr10_grade_lut.mp4" | tee "$OUT/sha256.txt"
else
  sha256sum "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" "$OUT/production_hdr10_transformed.mp4" "$OUT/production_hdr10_overlays.mp4" "$OUT/production_hdr10_keyframed.mp4" "$OUT/production_hdr10_masked.mp4" "$OUT/production_hdr10_from_hlg.mp4" "$OUT/production_hdr10_cropped.mp4" "$OUT/production_hdr10_grade_lut.mp4" | tee "$OUT/sha256.txt"
fi
echo "PASS: production HDR10 evidence written under $OUT"
