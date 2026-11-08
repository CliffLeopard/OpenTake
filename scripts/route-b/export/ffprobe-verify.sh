#!/usr/bin/env bash
# Verify 10-bit/HDR signalling of Route B export-pro outputs with ffprobe.
#
# Usage: ffprobe-verify.sh <file> [<file> ...]
#
# Prints, per file: container size/duration, video codec/profile/pixel format,
# bits-per-raw-sample, resolution/frame rate, colour primaries/transfer/matrix,
# and any stream side data (HDR10 mastering display / content light metadata).
# Exits non-zero if a file is missing or ffprobe fails.
set -euo pipefail

FFPROBE="${OPENTAKE_FFPROBE:-$(command -v ffprobe || true)}"
if [ -z "$FFPROBE" ] || [ ! -x "$FFPROBE" ]; then
  echo "ffprobe not found; set OPENTAKE_FFPROBE" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <file> [<file> ...]" >&2
  exit 2
fi

for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "MISSING $file" >&2
    exit 1
  fi
  size=$(wc -c <"$file" | tr -d ' ')
  echo "== $(basename "$file") ($size bytes)"
  "$FFPROBE" -v error -select_streams v:0 \
    -show_entries "stream=codec_name,profile,pix_fmt,bits_per_raw_sample,width,height,r_frame_rate,color_space,color_transfer,color_primaries,color_range" \
    -of default=nw=1 "$file" | sed 's/^/  /'
  "$FFPROBE" -v error \
    -show_entries "format=duration,bit_rate" \
    -of default=nw=1 "$file" | sed 's/^/  format: /'
  # HDR10 mastering display / content light metadata lives in stream side data.
  side_data=$("$FFPROBE" -v error -select_streams v:0 -show_streams -of json "$file" \
    | python3 -c '
import json,sys
data=json.load(sys.stdin)
for stream in data.get("streams", []):
    for item in stream.get("side_data_list", []):
        kind=item.get("side_data_type") or item.get("side_type") or "side-data"
        if "Mastering" in kind or "Content light" in kind or "Mastering" in str(item):
            print(kind)
            for key, value in item.items():
                if key != "side_data_type":
                    print(f"  {key}: {value}")
')
  if [ -n "$side_data" ]; then
    echo "  stream side-data:"
    echo "$side_data" | sed 's/^/    /'
  else
    echo "  stream side-data: none"
  fi
  # MP4/HEVC mastering-display and content-light SEI metadata are exposed on the
  # first frame by ffprobe, not on the stream side-data.
  frame_side=$("$FFPROBE" -v error -select_streams v:0 -show_frames \
    -read_intervals "%+#1" -show_entries frame=side_data_list -of json "$file" \
    | python3 -c '
import json,sys
data=json.load(sys.stdin)
for frame in data.get("frames", []):
    for item in frame.get("side_data_list", []):
        kind=item.get("side_data_type") or "side-data"
        if "Mastering" in kind or "Content light" in kind:
            print(kind)
            for key, value in item.items():
                if key != "side_data_type":
                    print(f"  {key}: {value}")
')
  if [ -n "$frame_side" ]; then
    echo "  frame HDR side-data:"
    echo "$frame_side" | sed 's/^/    /'
  else
    echo "  frame HDR side-data: none"
  fi
  echo
done
