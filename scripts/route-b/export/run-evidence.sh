#!/usr/bin/env bash
# Reproduce the Route B export-pro evidence:
#   1. 10-bit H.265 encode (yuv420p10le / Main 10) + 8-bit reference
#   2. HDR policy decision for a PQ source against the SDR compositor
#   3. Real HDR->SDR tone-map of a PQ test source via the selected backend
#   4. Tag-only retag control (metadata edit without tone-map)
#   5. Ducking render + numeric gain measurement
#   6. ffprobe verification of every output
#
# Everything is written under ${1:-/tmp/opentake-export-pro}; the repo target
# directory is not touched (CARGO_TARGET_DIR defaults to /tmp).
#
# Usage: scripts/route-b/export/run-evidence.sh [output-dir]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-/tmp/opentake-export-pro}"
FFMPEG="${OPENTAKE_FFMPEG:-$(command -v ffmpeg || true)}"
FFPROBE="${OPENTAKE_FFPROBE:-$(command -v ffprobe || true)}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/opentake-export-pro-target}"
export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found (Tried \$HOME/.cargo/bin and PATH)" >&2
  exit 1
fi
if [ -z "$FFMPEG" ] || [ ! -x "$FFMPEG" ]; then
  echo "ffmpeg not found; set OPENTAKE_FFMPEG" >&2
  exit 1
fi

mkdir -p "$OUT"
BIN="$CARGO_TARGET_DIR/release/export-pro"
CARGO_MANIFEST="$ROOT/crates/opentake-export-pro/Cargo.toml"

echo "== environment"
echo "root:   $ROOT"
echo "out:    $OUT"
echo "target: $CARGO_TARGET_DIR"
echo "ffmpeg: $("$FFMPEG" -version | head -1)"
echo "cargo:  $(cargo --version)"
echo "rustc:  $(rustc --version)"
echo "system: $(uname -srm)"

echo
echo "== build export-pro (standalone crate; no root-workspace changes)"
cargo build --release --manifest-path "$CARGO_MANIFEST" --bin export-pro

echo
echo "== unit tests"
cargo test --release --manifest-path "$CARGO_MANIFEST" --lib 2>&1 | tail -3

echo
echo "== 1. 10-bit H.265 encode"
"$BIN" encode \
  --out "$OUT/h265_10bit.mp4" \
  --codec h265 --bit-depth 10 \
  --width 640 --height 360 --fps 30 --frames 60 \
  --crf 20 --preset medium \
  | tee "$OUT/encode-10bit.json"

echo
echo "== 2. 8-bit H.265 reference (same synthetic frames)"
"$BIN" encode \
  --out "$OUT/h265_8bit.mp4" \
  --codec h265 --bit-depth 8 \
  --width 640 --height 360 --fps 30 --frames 60 \
  --crf 20 --preset medium \
  | tee "$OUT/encode-8bit.json"

echo
echo "== 3. HDR policy for a PQ source against the current SDR compositor"
"$BIN" hdr-policy \
  --primaries bt2020 --transfer smpte2084 --matrix bt2020nc --range tv \
  --compositor sdr \
  | tee "$OUT/hdr-policy.json"

echo
echo "== 4. HDR PQ test source: four 10-bit luma bars (64/300/600/900)"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=640x360:r=30:d=1,format=yuv420p10le,geq=lum='if(lt(X,160),64,if(lt(X,320),300,if(lt(X,480),600,900)))':cb=512:cr=512" \
  -c:v libx265 -pix_fmt yuv420p10le \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -x265-params "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc" \
  "$OUT/hdr_pq_bars.mp4"

echo
echo "== 5. HDR->SDR tone-map via the policy-selected backend"
"$BIN" tone-map \
  --source "$OUT/hdr_pq_bars.mp4" \
  --out "$OUT/hdr_pq_bars_tonemapped.mp4" \
  | tee "$OUT/tone-map.json"

echo
echo "== 6. control: tag-only retag (copy stream, change colour tags, no pixel conversion)"
"$FFMPEG" -y -hide_banner -loglevel error \
  -i "$OUT/hdr_pq_bars.mp4" -c copy \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  "$OUT/hdr_pq_bars_retagged.mp4"

echo
echo "== 7. ducking render (music bed + 440 Hz voice from 0.5 s to 1.0 s)"
"$BIN" ducking \
  --out "$OUT/duck.wav" --noduck "$OUT/noduck.wav" --report "$OUT/ducking-report.json" \
  --depth 12 --threshold -38 --attack 80 --release 400 --hold 200 \
  | tee "$OUT/ducking.json"

echo
echo "== 8. ffprobe verification"
"$HERE/ffprobe-verify.sh" \
  "$OUT/h265_10bit.mp4" \
  "$OUT/h265_8bit.mp4" \
  "$OUT/hdr_pq_bars.mp4" \
  "$OUT/hdr_pq_bars_tonemapped.mp4" \
  "$OUT/hdr_pq_bars_retagged.mp4" \
  | tee "$OUT/ffprobe.txt"

echo
echo "== 9. pixel evidence: PQ bars before/after tone-map"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/hdr_pq_bars.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/bars_src.yuv"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/hdr_pq_bars_tonemapped.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/bars_tone.yuv"
python3 "$HERE/hdr-yuv-measure.py" \
  --src "$OUT/bars_src.yuv" --tone "$OUT/bars_tone.yuv" --width 640 --height 360 \
  | tee "$OUT/hdr-yuv.txt"

echo
echo "== 10. PSNR: tone-mapped vs source (finite = pixels changed)"
"$FFMPEG" -hide_banner -nostdin -i "$OUT/hdr_pq_bars.mp4" -i "$OUT/hdr_pq_bars_tonemapped.mp4" \
  -lavfi "[0:v]format=yuv420p10le[a];[1:v]format=yuv420p10le[b];[a][b]psnr" -f null - 2>&1 \
  | grep -E "Parsed_psnr" | tail -1 | tee "$OUT/psnr-tonemap.txt"

echo
echo "== 11. PSNR: retag-only vs source (inf = pixels untouched)"
"$FFMPEG" -hide_banner -nostdin -i "$OUT/hdr_pq_bars.mp4" -i "$OUT/hdr_pq_bars_retagged.mp4" \
  -lavfi "[0:v]format=yuv420p10le[a];[1:v]format=yuv420p10le[b];[a][b]psnr" -f null - 2>&1 \
  | grep -E "Parsed_psnr" | tail -1 | tee "$OUT/psnr-retag.txt"

echo
echo "== 12. ducking gain measurement"
python3 "$HERE/ducking-measure.py" \
  --ducked "$OUT/duck.wav" --reference "$OUT/noduck.wav" \
  --report "$OUT/ducking-report.json" --depth 12 \
  | tee "$OUT/ducking-measure.txt"

echo
echo "== artifact sizes"
ls -l "$OUT/h265_10bit.mp4" "$OUT/h265_8bit.mp4" "$OUT/hdr_pq_bars.mp4" \
  "$OUT/hdr_pq_bars_tonemapped.mp4" "$OUT/duck.wav" "$OUT/noduck.wav" | tee "$OUT/sizes.txt"

echo
echo "PASS: all evidence written under $OUT"
