//! `export-pro` verification CLI.
//!
//! Subcommands (all print JSON on success so the shell scripts can quote exact
//! evidence):
//!
//! - `encode`      — encode synthetic RGBA8 frames with a chosen codec/bit depth
//! - `probe`       — selected ffprobe fields for one output
//! - `hdr-policy`  — resolve the HDR/tone-map deliverable for a source
//! - `tone-map`    — apply the selected HDR→SDR chain to a direct HDR source
//! - `ducking`     — render demo ducked/reference WAVs plus a JSON report
//!
//! The binary is intentionally dependency-light (std + serde_json) and is the
//! executable form of the crate's integration contract.

use std::process::Command;
use std::time::Instant;

use serde_json::{json, Value};

use opentake_export_pro::codec::{encode_rgba8_frames, synthetic_test_frames, BitDepth, ColorTags, EncodeSpec, ProCodec};
use opentake_export_pro::ducking::{demo_layers, mix_layers, mix_with_ducking, DuckingConfig};
use opentake_export_pro::hdr::{
    decide, CompositorCapability, HdrPolicy, SourceColorMetadata, ToneMapBackend, ToneMapStage,
};
use opentake_export_pro::wav::write_wav_f32_mono;
use opentake_export_pro::{ffmpeg_bin, ffprobe_bin};

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("export-pro: {message}");
    std::process::exit(1);
}

/// Tiny `--key value` / `--flag` argument reader.
struct Args {
    values: std::collections::HashMap<String, String>,
    flags: std::collections::HashSet<String>,
}

impl Args {
    fn parse() -> Self {
        let mut values = std::collections::HashMap::new();
        let mut flags = std::collections::HashSet::new();
        // argv[0] is the binary, argv[1] is the subcommand.
        let mut args = std::env::args().skip(2).peekable();
        while let Some(arg) = args.next() {
            if !arg.starts_with("--") {
                fail(format!("unexpected positional argument: {arg}"));
            }
            let key = arg.trim_start_matches("--").to_string();
            match args.peek() {
                Some(next) if !next.starts_with("--") => {
                    values.insert(key, args.next().unwrap_or_default());
                }
                _ => {
                    flags.insert(key);
                }
            }
        }
        Args { values, flags }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    fn required(&self, key: &str) -> &str {
        self.get(key)
            .unwrap_or_else(|| fail(format!("missing required --{key}")))
    }

    fn number<T: std::str::FromStr>(&self, key: &str, default: T) -> T {
        match self.get(key) {
            Some(value) => value
                .parse()
                .unwrap_or_else(|_| fail(format!("--{key} is not a valid number: {value}"))),
            None => default,
        }
    }

    fn flag(&self, key: &str) -> bool {
        self.flags.contains(key)
    }
}

fn codec_from(value: &str) -> ProCodec {
    match value {
        "h264" => ProCodec::H264,
        "h265" => ProCodec::H265,
        "prores" | "prores422" => ProCodec::ProRes422,
        "prores4444" => ProCodec::ProRes4444,
        other => fail(format!("unknown codec {other}")),
    }
}

fn main() {
    let args = Args::parse();
    let command = std::env::args().nth(1).unwrap_or_default();
    let result = match command.as_str() {
        "encode" => cmd_encode(&args),
        "probe" => cmd_probe(&args),
        "hdr-policy" => cmd_hdr_policy(&args),
        "tone-map" => cmd_tone_map(&args),
        "ducking" => cmd_ducking(&args),
        other => fail(format!(
            "unknown subcommand {other}; expected encode|probe|hdr-policy|tone-map|ducking"
        )),
    };
    match result {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap()),
        Err(error) => fail(error),
    }
}

fn cmd_encode(args: &Args) -> opentake_export_pro::Result<Value> {
    let codec = codec_from(args.get("codec").unwrap_or("h265"));
    let bit_depth = BitDepth::parse(args.number("bit-depth", 10u8))?;
    let width: u32 = args.number("width", 640u32);
    let height: u32 = args.number("height", 360u32);
    let fps: i32 = args.number("fps", 30i32);
    let frames: usize = args.number("frames", 60usize);
    let color = match args.get("color").unwrap_or("bt709") {
        "bt709" => ColorTags::bt709(),
        "bt2020pq" | "bt2020-pq" => ColorTags::bt2020_pq(),
        other => fail(format!("unknown --color {other}")),
    };
    let spec = EncodeSpec {
        out: args.required("out").to_string(),
        width,
        height,
        fps,
        codec,
        bit_depth,
        crf: Some(args.number("crf", 20u8)),
        preset: Some(args.get("preset").unwrap_or("medium").to_string()),
        color,
        mastering_display: args.get("mastering-display").map(str::to_string),
        max_cll: args.get("max-cll").map(|value| value.parse().unwrap()),
        max_fall: args.get("max-fall").map(|value| value.parse().unwrap()),
    };
    let started = Instant::now();
    let stderr = encode_rgba8_frames(&spec, synthetic_test_frames(width, height, frames))?;
    let elapsed_ms = started.elapsed().as_millis();
    let size = std::fs::metadata(&spec.out).map(|meta| meta.len()).unwrap_or(0);
    Ok(json!({
        "out": spec.out,
        "codec": spec.codec,
        "bitDepth": spec.bit_depth,
        "pixelFormat": spec.pixel_format(),
        "profile": spec.codec.profile_token(spec.bit_depth),
        "width": width,
        "height": height,
        "fps": fps,
        "frames": frames,
        "color": spec.color,
        "x265Params": spec.x265_params(),
        "bytes": size,
        "elapsedMs": elapsed_ms,
        "ffmpegStderr": stderr.trim(),
    }))
}

fn cmd_probe(args: &Args) -> opentake_export_pro::Result<Value> {
    let path = args.required("path");
    let output = Command::new(ffprobe_bin())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,profile,pix_fmt,bits_per_raw_sample,width,height,color_space,color_transfer,color_primaries,r_frame_rate:format=size,duration,bit_rate",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|error| opentake_export_pro::ExportProError::Analysis(format!("ffprobe: {error}")))?;
    if !output.status.success() {
        return Err(opentake_export_pro::ExportProError::Analysis(format!(
            "ffprobe exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        opentake_export_pro::ExportProError::Analysis(format!("ffprobe JSON: {error}"))
    })?;
    Ok(json!({
        "path": path,
        "stream": parsed.get("streams").and_then(|streams| streams.get(0)).cloned().unwrap_or(Value::Null),
        "format": parsed.get("format").cloned().unwrap_or(Value::Null),
    }))
}

fn cmd_hdr_policy(args: &Args) -> opentake_export_pro::Result<Value> {
    let source = SourceColorMetadata {
        primaries: args.get("primaries").map(str::to_string),
        transfer: args.get("transfer").map(str::to_string),
        matrix: args.get("matrix").map(str::to_string),
        range: args.get("range").map(str::to_string),
    };
    let compositor = match args.get("compositor").unwrap_or("sdr") {
        "sdr" => CompositorCapability::SdrRgba8,
        "hdr" => CompositorCapability::HdrLinear16,
        other => fail(format!("unknown --compositor {other}")),
    };
    let backend = match args.get("backend").unwrap_or("detect") {
        "detect" => ToneMapBackend::detect(&ffmpeg_bin()),
        "videotoolbox" => ToneMapBackend::VideoToolbox,
        "zscale" => ToneMapBackend::Zscale,
        "unsupported" => ToneMapBackend::Unsupported,
        other => fail(format!("unknown --backend {other}")),
    };
    let mut policy = HdrPolicy {
        prefer_10bit_sdr: !args.flag("prefer-8bit"),
        allow_hdr_passthrough: args.flag("allow-passthrough"),
        ..HdrPolicy::default()
    };
    policy.mastering_display = args.get("mastering-display").map(str::to_string);
    policy.max_cll = args.get("max-cll").map(|value| value.parse().unwrap());
    policy.max_fall = args.get("max-fall").map(|value| value.parse().unwrap());
    let decision = decide(&source, compositor, &policy, backend);
    Ok(serde_json::to_value(decision).unwrap())
}

/// Probe one video source's colour metadata (HDR detection input).
fn probe_source_color(path: &str) -> opentake_export_pro::Result<SourceColorMetadata> {
    let output = Command::new(ffprobe_bin())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=color_primaries,color_transfer,color_space,color_range",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|error| opentake_export_pro::ExportProError::Analysis(format!("ffprobe: {error}")))?;
    if !output.status.success() {
        return Err(opentake_export_pro::ExportProError::Analysis(format!(
            "ffprobe exited {}",
            output.status
        )));
    }
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| opentake_export_pro::ExportProError::Analysis(error.to_string()))?;
    let stream = parsed
        .get("streams")
        .and_then(|streams| streams.get(0))
        .cloned()
        .unwrap_or(Value::Null);
    let field = |name: &str| {
        stream
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    Ok(SourceColorMetadata {
        primaries: field("color_primaries"),
        transfer: field("color_transfer"),
        matrix: field("color_space"),
        range: field("color_range"),
    })
}

fn cmd_tone_map(args: &Args) -> opentake_export_pro::Result<Value> {
    let source = args.required("source");
    let out = args.required("out");
    let metadata = probe_source_color(source)?;
    let backend = ToneMapBackend::detect(&ffmpeg_bin());
    let decision = decide(
        &metadata,
        CompositorCapability::SdrRgba8,
        &HdrPolicy::default(),
        backend,
    );
    let filter = decision.tone_map_filter.clone().ok_or_else(|| {
        opentake_export_pro::ExportProError::Analysis(format!(
            "no tone-map backend/filter available (backend={:?}); refusing to claim a tone-map",
            backend
        ))
    })?;
    let mut command = Command::new(ffmpeg_bin());
    command.args(["-y", "-hide_banner", "-loglevel", "error"]);
    if decision.tone_map_stage == ToneMapStage::Decode && backend == ToneMapBackend::VideoToolbox {
        command.args([
            "-hwaccel",
            "videotoolbox",
            "-hwaccel_output_format",
            "videotoolbox_vld",
        ]);
    }
    command.args(["-i", source, "-vf", &filter]);
    command.args([
        "-c:v",
        "libx265",
        "-pix_fmt",
        "yuv420p10le",
        "-profile:v",
        "main10",
        "-crf",
        &args.number("crf", 20u8).to_string(),
        "-x265-params",
        "log-level=error",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-y",
        out,
    ]);
    let output = command
        .output()
        .map_err(|error| opentake_export_pro::ExportProError::Encode(format!("spawn ffmpeg: {error}")))?;
    if !output.status.success() {
        return Err(opentake_export_pro::ExportProError::Encode(format!(
            "tone-map ffmpeg exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(json!({
        "source": source,
        "out": out,
        "sourceColor": metadata,
        "decision": decision,
        "filter": filter,
        "ffmpegArgs": command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "bytes": std::fs::metadata(out).map(|meta| meta.len()).unwrap_or(0),
    }))
}

fn cmd_ducking(args: &Args) -> opentake_export_pro::Result<Value> {
    let config = DuckingConfig {
        threshold_db: args.number("threshold", -38.0f32),
        depth_db: args.number("depth", 12.0f32),
        attack_ms: args.number("attack", 80.0f32),
        release_ms: args.number("release", 400.0f32),
        hold_ms: args.number("hold", 200.0f32),
        sample_rate: args.number("sample-rate", 48_000u32),
    };
    config.validate()?;
    let (_music_only, ducked_layers) = demo_layers(&config);
    // Reference render uses the same layers with ducking disabled, so a
    // ducked-vs-reference window comparison isolates the gain reduction.
    let reference = mix_layers(&ducked_layers)?;
    let (ducked, report) = mix_with_ducking(&ducked_layers, &config)?;
    let out = args.required("out");
    let noduck = args.required("noduck");
    let report_path = args.required("report");
    write_wav_f32_mono(std::path::Path::new(out), &ducked, config.sample_rate)?;
    write_wav_f32_mono(std::path::Path::new(noduck), &reference, config.sample_rate)?;
    if let Some(parent) = std::path::Path::new(report_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(report_path, serde_json::to_string_pretty(&report).unwrap())?;
    Ok(json!({
        "duckedOut": out,
        "referenceOut": noduck,
        "reportOut": report_path,
        "report": report,
        "duckedSamples": ducked.len(),
        "referenceSamples": reference.len(),
    }))
}
