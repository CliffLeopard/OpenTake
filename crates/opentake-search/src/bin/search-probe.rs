//! `search-probe` — deterministic CLI probe for the isolated Route B search
//! slice. No network, no model download, no model load.
//!
//! Usage:
//!   search-probe --status [--models-dir DIR] [--verify-hashes]
//!   search-probe --assets FILE --query TEXT [--models-dir DIR] [--limit N] [--fps N]
//!   search-probe --assets FILE --image FILE.png
//!   search-probe --benchmark N
//!
//! Asset fixture format (tab separated, `#` comments):
//!   asset<TAB>id<TAB>name<TAB>kind(visual|audio|other)
//!   cue<TAB>assetId<TAB>startSec<TAB>endSec<TAB>text

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use opentake_search::lexical::{Asset, AssetKind, Cue};
use opentake_search::model::{
    probe_models, VisualCapability, BACKEND_NONE, FILES, MODEL_NAME, MODEL_VERSION, TOTAL_BYTES,
};
use opentake_search::service::{SearchResults, SearchService};

#[derive(Default)]
struct Args {
    models_dir: Option<PathBuf>,
    verify_hashes: bool,
    assets: Option<PathBuf>,
    query: Option<String>,
    image: Option<PathBuf>,
    limit: Option<usize>,
    fps: Option<i32>,
    status: bool,
    benchmark: Option<usize>,
}

fn usage() -> &'static str {
    "usage: search-probe (--status | --assets FILE --query TEXT | --assets FILE --image FILE | --benchmark N)\n\
     options: [--models-dir DIR] [--verify-hashes] [--limit N] [--fps N]\n\
     asset fixture (tab separated): asset<TAB>id<TAB>name<TAB>visual|audio|other ; cue<TAB>id<TAB>start<TAB>end<TAB>text"
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        let mut value = |name: &str| iter.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--models-dir" => args.models_dir = Some(PathBuf::from(value("--models-dir")?)),
            "--verify-hashes" => args.verify_hashes = true,
            "--assets" => args.assets = Some(PathBuf::from(value("--assets")?)),
            "--query" => args.query = Some(value("--query")?),
            "--image" => args.image = Some(PathBuf::from(value("--image")?)),
            "--limit" => {
                args.limit = Some(
                    value("--limit")?
                        .parse::<usize>()
                        .map_err(|_| "--limit must be an integer".to_string())?,
                )
            }
            "--fps" => {
                args.fps = Some(
                    value("--fps")?
                        .parse::<i32>()
                        .map_err(|_| "--fps must be an integer".to_string())?,
                )
            }
            "--status" => args.status = true,
            "--benchmark" => {
                args.benchmark = Some(
                    value("--benchmark")?
                        .parse::<usize>()
                        .map_err(|_| "--benchmark must be an integer".to_string())?,
                )
            }
            "--help" | "-h" => return Err(usage().to_string()),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(args)
}

fn parse_asset_fixture(path: &PathBuf) -> Result<Vec<Asset>, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("assets: {error}"))?;
    let mut assets: Vec<Asset> = Vec::new();
    for (line_number, raw) in text.lines().enumerate() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let error = |message: &str| format!("{}:{}: {message}", path.display(), line_number + 1);
        match fields.first().copied() {
            Some("asset") => {
                if fields.len() != 4 {
                    return Err(error("asset needs 3 fields"));
                }
                let kind = match fields[3] {
                    "visual" => AssetKind::Visual,
                    "audio" => AssetKind::Audio,
                    "other" => AssetKind::Other,
                    other => return Err(error(&format!("unknown kind: {other}"))),
                };
                assets.push(Asset::new(fields[1], fields[2], kind));
            }
            Some("cue") => {
                if fields.len() != 5 {
                    return Err(error("cue needs 4 fields"));
                }
                let start = fields[2]
                    .parse::<f64>()
                    .map_err(|_| error("cue start must be a number"))?;
                let end = fields[3]
                    .parse::<f64>()
                    .map_err(|_| error("cue end must be a number"))?;
                let asset = assets
                    .iter_mut()
                    .rev()
                    .find(|asset| asset.id == fields[1])
                    .ok_or_else(|| error("cue references an unknown asset id"))?;
                asset.transcript.push(Cue {
                    start_sec: start,
                    end_sec: end,
                    text: fields[4].to_string(),
                });
            }
            Some(other) => return Err(error(&format!("unknown row kind: {other}"))),
            None => return Err(error("empty row")),
        }
    }
    Ok(assets)
}

fn probe_json(args: &Args) -> String {
    let probe = probe_models(args.models_dir.as_deref(), args.verify_hashes);
    let capability = VisualCapability::evaluate(&probe, BACKEND_NONE);
    let files = probe
        .files
        .iter()
        .map(|file| {
            format!(
                "{{\"path\":{},\"expectedBytes\":{},\"present\":{},\"actualBytes\":{},\"sizeOk\":{},\"sha256Ok\":{}}}",
                opentake_search::json::string(file.file.installed_path),
                file.file.bytes,
                file.present,
                file.actual_bytes.map_or_else(|| "null".to_string(), |bytes| bytes.to_string()),
                file.size_ok,
                file.sha256_ok.map_or_else(|| "null".to_string(), |ok| ok.to_string()),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"capability\":{},\"probe\":{{\"state\":{},\"receiptPresent\":{},\"expectedTotalBytes\":{},\"files\":[{}]}},\"manifest\":{{\"model\":{},\"version\":{},\"files\":{}}}}}",
        capability.to_json(),
        opentake_search::json::string(&format!("{:?}", probe.state).to_lowercase()),
        probe.receipt_present,
        TOTAL_BYTES,
        files,
        opentake_search::json::string(MODEL_NAME),
        MODEL_VERSION,
        FILES.len(),
    )
}

fn results_json(capability: &str, results: &SearchResults) -> String {
    format!(
        "{{\"capability\":{},\"results\":{}}}",
        capability,
        results.to_json()
    )
}

fn benchmark(iterations: usize) -> String {
    let asset_count = 2_000;
    let mut assets = Vec::with_capacity(asset_count);
    for index in 0..asset_count {
        assets.push(
            Asset::new(
                format!("asset-{index}"),
                format!("Shot {index}.mp4"),
                AssetKind::Visual,
            )
            .with_transcript(vec![Cue {
                start_sec: 0.0,
                end_sec: 1.0,
                text: "sunset over water".to_string(),
            }]),
        );
    }
    let iterations = iterations.max(1);
    let started = Instant::now();
    let mut hits = 0usize;
    for _ in 0..iterations {
        let files = opentake_search::lexical::matched_files(&assets, "shot", 20);
        let spoken = opentake_search::lexical::matched_spoken(&assets, "sunset", 20);
        hits += files.len() + spoken.len();
    }
    let elapsed = started.elapsed();
    let total_micros = elapsed.as_secs_f64() * 1_000_000.0;
    format!(
        "{{\"benchmark\":{{\"assets\":{},\"cues\":{},\"iterations\":{},\"hits\":{},\"totalMicros\":{:.3},\"avgMicrosPerQuery\":{:.3}}}}}",
        asset_count,
        asset_count,
        iterations,
        hits,
        total_micros,
        total_micros / iterations as f64,
    )
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    if let Some(iterations) = args.benchmark {
        println!("{}", benchmark(iterations));
        return ExitCode::SUCCESS;
    }
    if args.status || (args.assets.is_none() && args.query.is_none() && args.image.is_none()) {
        println!("{}", probe_json(&args));
        return ExitCode::SUCCESS;
    }
    let assets = match &args.assets {
        Some(path) => match parse_asset_fixture(path) {
            Ok(assets) => assets,
            Err(message) => {
                eprintln!("{message}");
                return ExitCode::from(2);
            }
        },
        None => Vec::new(),
    };
    let probe = probe_models(args.models_dir.as_deref(), args.verify_hashes);
    let capability = VisualCapability::evaluate(&probe, BACKEND_NONE);
    let fps = args.fps.unwrap_or(30);
    let mut service = SearchService::new(None, capability.clone(), fps);
    if let Some(limit) = args.limit {
        service = service.with_limits(
            limit,
            opentake_search::RELATIVE_CUTOFF,
            opentake_search::VISUAL_MATCH_COSINE_FLOOR,
        );
    }
    let results = if let Some(image) = &args.image {
        match std::fs::read(image) {
            Ok(bytes) => service.query_image(&assets, &[], &bytes),
            Err(error) => {
                eprintln!("image: {error}");
                return ExitCode::from(1);
            }
        }
    } else {
        let query = args.query.as_deref().unwrap_or("");
        service.query_text(&assets, &[], query)
    };
    println!("{}", results_json(&capability.to_json(), &results));
    ExitCode::SUCCESS
}
