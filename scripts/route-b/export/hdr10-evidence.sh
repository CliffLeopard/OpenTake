#!/usr/bin/env bash
# Reproduce the HDR10 linear-compositor export evidence.
#
#   true HDR10: render-crate RGBA16F linear frames -> export-pro PQ/BT.2020
#               yuv420p10le writer -> libx265 Main10 + mastering metadata
#   SDR fallback: same linear bars clipped at 203 cd/m² -> BT.709 10-bit
#
# Usage: scripts/route-b/export/hdr10-evidence.sh [output-dir]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-/tmp/route-b-hdr10}"
FFMPEG="${OPENTAKE_FFMPEG:-$(command -v ffmpeg || true)}"
FFPROBE="${OPENTAKE_FFPROBE:-$(command -v ffprobe || true)}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/route-b-hdr10-target}"
export PATH="$HOME/.cargo/bin:$PATH"

if [ -z "$FFMPEG" ] || [ ! -x "$FFMPEG" ]; then
  echo "ffmpeg not found; set OPENTAKE_FFMPEG" >&2
  exit 1
fi
mkdir -p "$OUT"
MANIFEST="$ROOT/crates/opentake-export-pro/Cargo.toml"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

echo "== environment"
echo "root:   $ROOT"
echo "out:    $OUT"
echo "target: $CARGO_TARGET_DIR"
echo "ffmpeg: $("$FFMPEG" -version | head -1)"
echo "system: $(uname -srm)"

echo
echo "== build export-pro (standalone; root Cargo untouched)"
cargo build --release --manifest-path "$MANIFEST" --bin export-pro

echo
echo "== unit tests (render HDR contract + export-pro HDR10 writer)"
cargo test --offline --manifest-path "$ROOT/crates/opentake-export-pro/Cargo.toml" --lib 2>&1 | tail -3

BIN="$CARGO_TARGET_DIR/release/export-pro"

echo
echo "== 1. true HDR10 encode (linear RGBA16F -> PQ/BT.2020 -> Main10)"
"$BIN" hdr10-encode \
  --out "$OUT/hdr10_true.mp4" \
  --width 640 --height 360 --fps 30 --frames 60 --crf 20 --preset medium \
  --max-cll 1000 --max-fall 400 \
  | tee "$OUT/hdr10-encode.json"

echo
echo "== 2. SDR fallback encode of the same bars (203-nit clip -> BT.709)"
"$BIN" sdr-fallback-encode \
  --out "$OUT/hdr10_sdr_fallback.mp4" \
  --width 640 --height 360 --fps 30 --frames 60 --crf 20 --preset medium \
  | tee "$OUT/sdr-fallback-encode.json"

echo
echo "== 3. policy decisions (claim boundary)"
"$BIN" hdr-policy \
  --primaries bt2020 --transfer smpte2084 --matrix bt2020nc --range tv \
  --compositor sdr \
  >"$OUT/policy-sdr-compositor.json"
"$BIN" hdr-policy \
  --primaries bt2020 --transfer smpte2084 --matrix bt2020nc --range tv \
  --compositor hdr --allow-passthrough \
  --mastering-display "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)" \
  --max-cll 1000 --max-fall 400 \
  >"$OUT/policy-hdr-compositor.json"
python3 - <<'PY' "$OUT/policy-sdr-compositor.json" "$OUT/policy-hdr-compositor.json"
import json, sys
sdr, hdr = (json.load(open(path)) for path in sys.argv[1:])
print("SDR-compositor deliverable:", sdr.get("deliverable"), "toneMapped:", sdr.get("toneMapped"))
print("HDR-compositor deliverable:", hdr.get("deliverable"), "x265 params present:", bool(hdr.get("x265Params")))
PY

echo
echo "== 4. ffprobe verification (codec/profile/pix_fmt/colour/HDR side data)"
"$HERE/ffprobe-verify.sh" "$OUT/hdr10_true.mp4" "$OUT/hdr10_sdr_fallback.mp4" \
  | tee "$OUT/ffprobe.txt"

echo
echo "== 5. pixel evidence: PQ bar codes vs SDR clipping"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/hdr10_true.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/hdr10_true.yuv"
"$FFMPEG" -y -hide_banner -loglevel error -i "$OUT/hdr10_sdr_fallback.mp4" \
  -frames:v 1 -f rawvideo -pix_fmt yuv420p10le "$OUT/hdr10_sdr_fallback.yuv"
python3 "$HERE/hdr10-measure.py" --raw "$OUT/hdr10_true.yuv" --width 640 --height 360 --kind hdr \
  | tee "$OUT/hdr10-measure.json"
python3 "$HERE/hdr10-measure.py" --raw "$OUT/hdr10_sdr_fallback.yuv" --width 640 --height 360 --kind sdr \
  | tee "$OUT/sdr-fallback-measure.json"

echo
echo "== 6. hashes"
{
  for file in "$OUT/hdr10_true.mp4" "$OUT/hdr10_sdr_fallback.mp4" \
      "$OUT/hdr10-measure.json" "$OUT/sdr-fallback-measure.json"; do
    printf '%s  %s\n' "$(sha256_file "$file")" "$(basename "$file")"
  done
} | tee "$OUT/sha256.txt"

echo
echo "PASS: HDR10 evidence written under $OUT"
