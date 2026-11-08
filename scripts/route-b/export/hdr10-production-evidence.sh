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
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=gray:s=640x360:r=30:d=2,format=yuv420p" \
  -frames:v 60 -c:v libx264 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 "$OUT/sdr_source.mp4"

echo "== addon production export (HDR10 + SDR regression)"
node "$HERE/hdr10-production-evidence.mjs" "$ADDON" "$OUT/hdr_source.mp4" "$OUT/sdr_source.mp4" "$OUT" \
  | tee "$OUT/production.log"

echo "== ffprobe"
"$HERE/ffprobe-verify.sh" "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" "$OUT/production_hdr10_transformed.mp4" \
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

echo "== hashes"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" "$OUT/production_hdr10_transformed.mp4" | tee "$OUT/sha256.txt"
else
  sha256sum "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" "$OUT/production_hdr10_transformed.mp4" | tee "$OUT/sha256.txt"
fi
echo "PASS: production HDR10 evidence written under $OUT"
