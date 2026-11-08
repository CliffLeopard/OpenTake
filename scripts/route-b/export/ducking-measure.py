#!/usr/bin/env python3
"""Measure the Route B ducking gain from rendered WAVs.

`export-pro ducking` writes two otherwise-identical mixes:
- `--noduck` reference: music bed + voice, no ducking;
- `--out` ducked: same layers, music ducked under the voice.

The demo bed is a constant (DC) level and the voice is a 440 Hz sine, so a
window **mean** isolates the music gain while the window **standard deviation**
isolates the (unducked) voice amplitude:

- pre-voice mean delta should be ~0 dB;
- voice-window mean delta should equal `-depth` dB;
- voice-window std ratio should be ~1.0 (voice not attenuated);
- post-voice mean delta should recover.

Usage:
  ducking-measure.py --ducked duck.wav --reference noduck.wav \
      --report ducking-report.json --depth 12
"""

import argparse
import json
import math
import struct
import sys
import wave


def read_mono_wav(path: str) -> tuple[int, list[float]]:
    with wave.open(path, "rb") as handle:
        if handle.getnchannels() != 1:
            raise SystemExit(f"{path}: expected mono, got {handle.getnchannels()} channels")
        if handle.getsampwidth() != 2:
            raise SystemExit(f"{path}: expected 16-bit PCM, got {handle.getsampwidth() * 8}-bit")
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    return rate, [sample / 32767.0 for sample in samples]


def window_stats(samples: list[float], rate: int, start_seconds: float, end_seconds: float):
    start = int(start_seconds * rate)
    end = min(int(end_seconds * rate), len(samples))
    if end <= start:
        raise SystemExit(f"empty measurement window {start_seconds}..{end_seconds}")
    segment = samples[start:end]
    mean = sum(segment) / len(segment)
    variance = sum((value - mean) ** 2 for value in segment) / len(segment)
    return mean, math.sqrt(variance), len(segment)


def db_ratio(numerator: float, denominator: float) -> float:
    numerator = max(abs(numerator), 1e-9)
    denominator = max(abs(denominator), 1e-9)
    return 20.0 * math.log10(numerator / denominator)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ducked", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--report")
    parser.add_argument("--depth", type=float, default=12.0)
    parser.add_argument("--tolerance", type=float, default=1.0)
    args = parser.parse_args()

    duck_rate, ducked = read_mono_wav(args.ducked)
    ref_rate, reference = read_mono_wav(args.reference)
    if duck_rate != ref_rate:
        raise SystemExit(f"sample-rate mismatch: {duck_rate} vs {ref_rate}")
    if len(ducked) != len(reference):
        raise SystemExit(f"length mismatch: {len(ducked)} vs {len(reference)} samples")

    windows = {
        "preVoice": (0.20, 0.45),
        "voice": (0.80, 0.98),
        "postVoice": (1.90, 1.99),
    }
    measurements = {}
    for name, (start, end) in windows.items():
        duck_mean, duck_std, count = window_stats(ducked, duck_rate, start, end)
        ref_mean, ref_std, _ = window_stats(reference, ref_rate, start, end)
        measurements[name] = {
            "windowSeconds": [start, end],
            "samples": count,
            "duckedMean": round(duck_mean, 6),
            "referenceMean": round(ref_mean, 6),
            "meanDeltaDb": round(db_ratio(duck_mean, ref_mean), 3),
            "duckedStd": round(duck_std, 6),
            "referenceStd": round(ref_std, 6),
            "stdRatio": round(duck_std / max(ref_std, 1e-9), 4),
        }

    voice_delta = measurements["voice"]["meanDeltaDb"]
    pre_delta = measurements["preVoice"]["meanDeltaDb"]
    post_delta = measurements["postVoice"]["meanDeltaDb"]
    std_ratio = measurements["voice"]["stdRatio"]

    checks = {
        "preVoiceUnchanged": abs(pre_delta) <= 0.3,
        "voiceDuckedToDepth": abs(voice_delta - (-args.depth)) <= args.tolerance,
        "voiceAmplitudeUnaffected": 0.95 <= std_ratio <= 1.05,
        "recoveredAfterRelease": post_delta >= -1.5,
    }

    report_summary = None
    if args.report:
        try:
            with open(args.report, "r", encoding="utf-8") as handle:
                report = json.load(handle)
            windows_report = report.get("windows") or []
            report_summary = {
                "requestedDepthDb": report.get("requestedDepthDb"),
                "peakGainDb": report.get("peakGainDb"),
                "voiceRanges": report.get("voiceRanges"),
                "finalWindowGainDb": windows_report[-1]["meanGainDb"] if windows_report else None,
            }
            depth = report.get("requestedDepthDb") or args.depth
            peak = report.get("peakGainDb")
            if peak is not None:
                checks["reportPeakMatchesDepth"] = abs(peak - (-depth)) <= args.tolerance
        except (OSError, ValueError, KeyError) as error:
            checks["reportReadable"] = False
            report_summary = {"error": str(error)}

    result = {
        "ducked": args.ducked,
        "reference": args.reference,
        "requestedDepthDb": -args.depth,
        "measurements": measurements,
        "report": report_summary,
        "checks": checks,
        "pass": all(checks.values()),
    }
    print(json.dumps(result, indent=2))
    for name, ok in checks.items():
        print(f"{'PASS' if ok else 'FAIL'} {name}")
    print(
        f"summary: voice-window gain {voice_delta:+.2f} dB (requested {-args.depth:+.2f} dB), "
        f"std ratio {std_ratio:.3f}, pre {pre_delta:+.2f} dB, post {post_delta:+.2f} dB"
    )
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
