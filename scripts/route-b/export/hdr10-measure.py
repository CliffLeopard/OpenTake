#!/usr/bin/env python3
"""Measure PQ/BT.2020 bar codes in a raw 10-bit YUV frame.

Used by ``hdr10-evidence.sh`` to distinguish the true HDR10 writer from the
SDR fallback:

- ``--kind hdr``: the four gray bars are scene-linear 0.0001/0.0203/0.1/0.4
  (1/203/1000/4000 cd/m²). The expected Y code is the PQ inverse-EOTF of the
  bar followed by 10-bit limited-range quantisation (64 + 876*PQ).
- ``--kind sdr``: the same bars were clipped at 203 cd/m² and encoded BT.709;
  the three brightest bars must collapse to the same white Y code.

Exit code 0 only when the measured shape matches the requested mode.
"""

import argparse
import json
import struct
import sys

WIDTH_BARS = 4


def pq_inverse_eotf(linear: float) -> float:
    m1 = 2610.0 / 16384.0
    m2 = (2523.0 / 4096.0) * 128.0
    c1 = 3424.0 / 4096.0
    c2 = (2413.0 / 4096.0) * 32.0
    c3 = (2392.0 / 4096.0) * 32.0
    y = max(linear, 0.0) ** m1
    return ((c1 + c2 * y) / (1.0 + c3 * y)) ** m2


def expected_hdr_y_codes() -> list[int]:
    linear = [0.0001, 0.0203, 0.1, 0.4]
    return [round(64 + 876 * pq_inverse_eotf(value)) for value in linear]


def read_y_plane(path: str, width: int, height: int) -> list[int]:
    with open(path, "rb") as handle:
        data = handle.read()
    needed = width * height * 2
    if len(data) < needed:
        raise SystemExit(f"{path}: expected {needed} bytes for the Y plane, got {len(data)}")
    return list(struct.unpack(f"<{width * height}H", data[:needed]))


def bar_centers(y_plane: list[int], width: int, height: int) -> list[int]:
    y = height // 2
    return [y_plane[y * width + (width // 8 + index * width // 4)] for index in range(WIDTH_BARS)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--kind", choices=["hdr", "sdr"], required=True)
    parser.add_argument("--tolerance", type=int, default=12)
    args = parser.parse_args()

    measured = bar_centers(read_y_plane(args.raw, args.width, args.height), args.width, args.height)
    result: dict = {
        "kind": args.kind,
        "width": args.width,
        "height": args.height,
        "measuredYCodes": measured,
        "monotonicNonDecreasing": all(a <= b for a, b in zip(measured, measured[1:])),
    }

    if args.kind == "hdr":
        expected = expected_hdr_y_codes()
        deltas = [abs(a - b) for a, b in zip(measured, expected)]
        # The HDR writer must preserve four distinct PQ levels above SDR white.
        distinct = len({round(value / 4) for value in measured[1:]}) >= 2
        passed = max(deltas) <= args.tolerance and distinct
        result.update({
            "expectedPqYCodes": expected,
            "deltas": deltas,
            "distinctAboveSdrWhite": distinct,
            "interpretation": "true HDR10: PQ/BT.2020 codes match the linear frame contract",
            "pass": passed,
        })
    else:
        # SDR fallback clips 203/1000/4000 cd/m² to the same white; only the
        # dimmest bar is lower.
        clipped_together = (
            abs(measured[1] - measured[2]) <= 4 and abs(measured[2] - measured[3]) <= 4
        )
        dimmer = measured[0] < measured[1]
        passed = clipped_together and dimmer
        result.update({
            "clippedAboveReferenceWhite": clipped_together,
            "dimmestBarLower": dimmer,
            "interpretation": "SDR fallback: reference-white clip, not PQ HDR10",
            "pass": passed,
        })

    print(json.dumps(result, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
