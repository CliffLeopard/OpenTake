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
  -frames:v 60 -c:v libx265 -pix_fmt yuv420p10le \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -x265-params "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc" \
  "$OUT/hdr_source.mp4"

echo "== SDR source for the false-HDR guard"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=gray:s=640x360:r=30:d=2,format=yuv420p" \
  -frames:v 60 -c:v libx264 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 "$OUT/sdr_source.mp4"

echo "== addon production export (HDR10 + SDR regression)"
node "$HERE/hdr10-production-evidence.mjs" "$ADDON" "$OUT/hdr_source.mp4" "$OUT/sdr_source.mp4" "$OUT" \
  | tee "$OUT/production.log"

echo "== ffprobe"
"$HERE/ffprobe-verify.sh" "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" \
  | tee "$OUT/ffprobe.txt"

WIDTH=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$OUT/production_hdr10.mp4")
HEIGHT=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$OUT/production_hdr10.mp4")
echo "== pixel measurement (${WIDTH}x${HEIGHT})"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_hdr10.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/production_hdr10.yuv"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/production_sdr10.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/production_sdr10.yuv"
python3 "$HERE/hdr10-measure.py" --raw "$OUT/production_hdr10.yuv" --width "$WIDTH" --height "$HEIGHT" --kind hdr \
  | tee "$OUT/production-hdr-measure.json"
python3 "$HERE/hdr10-measure.py" --raw "$OUT/production_sdr10.yuv" --width "$WIDTH" --height "$HEIGHT" --kind sdr-tone-mapped \
  | tee "$OUT/production-sdr-measure.json"

echo "== hashes"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" | tee "$OUT/sha256.txt"
else
  sha256sum "$OUT/production_hdr10.mp4" "$OUT/production_sdr10.mp4" | tee "$OUT/sha256.txt"
fi
echo "PASS: production HDR10 evidence written under $OUT"
