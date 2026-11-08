#!/usr/bin/env python3
"""Measure HDR PQ luma conversion in raw 10-bit YUV frames.

The Route B verification script decodes the same frame index from a PQ-tagged
HDR test source and from the tone-mapped SDR output, both as raw
`yuv420p10le`, then calls this script. It samples the Y plane at the centre of
four equal-width bars and reports the code values before/after.

Interpretation:
- For the tone-mapped file, the values must differ from the PQ source values
  (the transfer function was applied). The concrete mapping is
  VideoToolbox's system EDR->SDR conversion, not a tunable curve.
- For a tag-only "retag" control, the values would be identical; that is why
  the script reports `changed: false` rather than treating a metadata edit as
  a tone-map.

Usage:
  hdr-yuv-measure.py --src src.yuv --tone tone.yuv --width 640 --height 360
"""

import argparse
import json
import struct
import sys


def read_luma(path: str, width: int, height: int) -> list[int]:
    with open(path, "rb") as handle:
        data = handle.read()
    needed = width * height * 2
    if len(data) < needed:
        raise SystemExit(
            f"{path}: expected at least {needed} bytes for one frame, got {len(data)}"
        )
    return list(struct.unpack(f"<{width * height}H", data[:needed]))


def sample_bars(luma: list[int], width: int, height: int) -> list[int]:
    y = height // 2
    values = []
    for index in range(4):
        x = (width // 8) + index * (width // 4)
        values.append(luma[y * width + x])
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--tone", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    args = parser.parse_args()

    src = sample_bars(read_luma(args.src, args.width, args.height), args.width, args.height)
    tone = sample_bars(read_luma(args.tone, args.width, args.height), args.width, args.height)
    changed = any(abs(a - b) > 2 for a, b in zip(src, tone))
    result = {
        "width": args.width,
        "height": args.height,
        "barCenters": {
            "srcPqCode": src,
            "toneMappedBt709Code": tone,
        },
        "changed": changed,
        "interpretation": (
            "tone-map changed pixel values; VideoToolbox EDR->SDR conversion applied"
            if changed
            else "pixel values unchanged; metadata-only retag would not be a tone-map"
        ),
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
