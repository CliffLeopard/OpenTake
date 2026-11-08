//! SigLIP2 dual encoder through the pure-Rust tract ONNX engine.
//!
//! This is the ORT-free backend for platforms where the native ONNX Runtime
//! build is unavailable or undesirable (macOS x86_64, Windows, Linux x64). The
//! pinned SigLIP2 graphs have dynamic/symbolic batch dimensions, so the loader
//! binds the fixed input shapes in memory while keeping the downloaded assets
//! untouched. On Windows this is the same engine used by `ort_embedder`; the
//! shared implementation lives here so `tract-backend` builds do not need the
//! `ort` crate at all.
//!
//! Image input is `NCHW` f32 `(1,3,256,256)`; text input is int64
//! `(1,context_length)`, right-padded. Both encoders return pooled
//! `(1, embedding_dim)` features, L2-normalized for cosine ranking.

use std::path::Path;
use std::sync::Mutex;

use ndarray::{Array2, Array4};
use tract_onnx::prelude::*;
use tract_onnx::tract_hir::infer::{Factoid, ShapeFactoid};

use super::embedder::{
    l2_normalize, preprocess_image, Embedder, EmbedderSpec, SIGLIP_MEAN, SIGLIP_STD,
};
use super::tokenizer::SiglipTokenizer;
use crate::error::{MediaError, Result};
use crate::frame::RgbaFrame;

/// ONNX graph IO tensor names (identical to the pinned exported encoders).
#[derive(Clone, Debug)]
pub struct TractIoNames {
    pub image_input: String,
    pub image_output: String,
    pub text_input: String,
    pub text_output: String,
}

impl Default for TractIoNames {
    fn default() -> Self {
        TractIoNames {
            image_input: "pixel_values".into(),
            image_output: "pooler_output".into(),
            text_input: "input_ids".into(),
            text_output: "pooler_output".into(),
        }
    }
}

/// One fixed-shape tract encoder plan.
struct Encoder {
    plan: TypedRunnableModel<TypedModel>,
    shape: Vec<usize>,
    datum_type: DatumType,
    embedding_dim: usize,
}

impl Encoder {
    fn load(
        path: &Path,
        input_name: &str,
        output_name: &str,
        datum_type: DatumType,
        shape: &[usize],
        embedding_dim: usize,
    ) -> Result<Self> {
        let result = (|| -> TractResult<Self> {
            let mut model = tract_onnx::onnx().model_for_path(path)?;
            bind_input(&mut model, input_name, datum_type, shape)?;
            let model = model.with_output_names([output_name])?.into_optimized()?;
            let output = model.output_fact(0)?;
            anyhow::ensure!(
                output.datum_type == DatumType::F32
                    && output.shape.as_concrete() == Some(&[1, embedding_dim]),
                "expected pooled float32 output [1, {embedding_dim}], got {output:?}"
            );
            Ok(Self {
                plan: model.into_runnable()?,
                shape: shape.to_vec(),
                datum_type,
                embedding_dim,
            })
        })();
        result
            .map_err(|e| MediaError::ModelInstall(format!("tract load {}: {e:#}", path.display())))
    }

    fn run<T: Datum + Copy>(&self, shape: &[usize], data: &[T]) -> Result<Vec<f32>> {
        if shape != self.shape || T::datum_type() != self.datum_type {
            return Err(MediaError::BadModelOutput);
        }
        let input = Tensor::from_shape(shape, data)
            .map_err(|e| MediaError::Decode(format!("tract input: {e:#}")))?;
        let output = self
            .plan
            .run(tvec!(input.into()))
            .map_err(|e| MediaError::Decode(format!("tract run: {e:#}")))?;
        if output.len() != 1 || output[0].shape() != [1, self.embedding_dim] {
            return Err(MediaError::BadModelOutput);
        }
        output[0]
            .as_slice::<f32>()
            .map(|v| v.to_vec())
            .map_err(|_| MediaError::BadModelOutput)
    }
}

/// ORT-free SigLIP2 embedder (tract).
pub struct TractEmbedder {
    image: Mutex<Encoder>,
    text: Mutex<Encoder>,
    tokenizer: SiglipTokenizer,
    spec: EmbedderSpec,
    io: TractIoNames,
}

impl TractEmbedder {
    pub fn new(
        image_encoder: &Path,
        text_encoder: &Path,
        tokenizer_json: &Path,
        spec: EmbedderSpec,
    ) -> Result<Self> {
        Self::with_io(
            image_encoder,
            text_encoder,
            tokenizer_json,
            spec,
            TractIoNames::default(),
        )
    }

    pub fn with_io(
        image_encoder: &Path,
        text_encoder: &Path,
        tokenizer_json: &Path,
        spec: EmbedderSpec,
        io: TractIoNames,
    ) -> Result<Self> {
        let image = Encoder::load(
            image_encoder,
            &io.image_input,
            &io.image_output,
            DatumType::F32,
            &[1, 3, spec.image_size as usize, spec.image_size as usize],
            spec.embedding_dim,
        )?;
        let text = Encoder::load(
            text_encoder,
            &io.text_input,
            &io.text_output,
            DatumType::I64,
            &[1, spec.context_length],
            spec.embedding_dim,
        )?;
        let tokenizer = SiglipTokenizer::from_file(tokenizer_json, spec.context_length)?;
        Ok(TractEmbedder {
            image: Mutex::new(image),
            text: Mutex::new(text),
            tokenizer,
            spec,
            io,
        })
    }

    pub fn io(&self) -> &TractIoNames {
        &self.io
    }

    fn finalize(&self, v: Vec<f32>) -> Result<Vec<f32>> {
        if v.len() != self.spec.embedding_dim || v.iter().any(|x| !x.is_finite()) {
            return Err(MediaError::BadModelOutput);
        }
        let norm_squared = v.iter().map(|x| x * x).sum::<f32>();
        if !norm_squared.is_finite() || norm_squared <= f32::EPSILON {
            return Err(MediaError::BadModelOutput);
        }
        let mut v = v;
        if !self.spec.normalized {
            l2_normalize(&mut v);
        }
        Ok(v)
    }
}

impl Embedder for TractEmbedder {
    fn spec(&self) -> &EmbedderSpec {
        &self.spec
    }

    fn encode_image(&self, frame: &RgbaFrame) -> Result<Vec<f32>> {
        let tensor: Array4<f32> =
            preprocess_image(frame, self.spec.image_size, SIGLIP_MEAN, SIGLIP_STD);
        let data = tensor
            .as_slice()
            .ok_or_else(|| MediaError::Decode("tract image tensor is not contiguous".into()))?;
        let v = self
            .image
            .lock()
            .map_err(|_| MediaError::ModelInstall("image tract plan poisoned".into()))?
            .run(tensor.shape(), data)?;
        self.finalize(v)
    }

    fn encode_text(&self, text: &str) -> Result<Vec<f32>> {
        let ids = self.tokenizer.tokenize(text)?;
        let arr = Array2::from_shape_vec((1, ids.len()), ids)
            .map_err(|e| MediaError::Decode(format!("tract text shape: {e}")))?;
        let data = arr
            .as_slice()
            .ok_or_else(|| MediaError::Decode("tract text tensor is not contiguous".into()))?;
        let v = self
            .text
            .lock()
            .map_err(|_| MediaError::ModelInstall("text tract plan poisoned".into()))?
            .run(arr.shape(), data)?;
        self.finalize(v)
    }
}

fn bind_input(
    model: &mut InferenceModel,
    input_name: &str,
    datum_type: DatumType,
    shape: &[usize],
) -> TractResult<()> {
    let inputs = model.input_outlets()?;
    anyhow::ensure!(
        inputs.len() == 1 && model.node(inputs[0].node).name == input_name,
        "expected a single input named {input_name}"
    );
    let input = model.input_fact(0)?;
    anyhow::ensure!(
        input.datum_type.concretize() == Some(datum_type),
        "unexpected input type"
    );
    anyhow::ensure!(
        input.shape.rank().concretize() == Some(shape.len() as i64),
        "unexpected input rank"
    );
    for (dimension, expected) in input.shape.dims().zip(shape) {
        if let Some(dimension) = dimension.concretize().and_then(|d| d.to_i64().ok()) {
            anyhow::ensure!(
                dimension == *expected as i64,
                "input dimension conflicts with model spec"
            );
        }
    }
    // The exporter includes symbolic expressions in value_info. Tract 0.22
    // parses their division precedence incorrectly. Re-infer only dynamic
    // dimensions from the fixed input; retain dtype, rank and static checks.
    for node in model.nodes_mut() {
        for output in &mut node.outputs {
            let dims = output
                .fact
                .shape
                .dims()
                .map(|dimension| {
                    if dimension.concretize().is_some_and(|d| d.to_i64().is_ok()) {
                        dimension.clone()
                    } else {
                        Default::default()
                    }
                })
                .collect();
            output.fact.shape = if output.fact.shape.is_open() {
                ShapeFactoid::open(dims)
            } else {
                ShapeFactoid::closed(dims)
            };
        }
    }
    model.set_input_fact(0, TypedFact::dt_shape(datum_type, shape).into())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_model() -> InferenceModel {
        let mut model = InferenceModel::default();
        let batch = model.symbols.sym("batch_size");
        let shape: [TDim; 4] = [batch.into(), 3.into(), 256.into(), 256.into()];
        model
            .add_source("pixel_values", f32::fact(shape).into())
            .unwrap();
        model
    }

    #[test]
    fn binds_dynamic_input_without_relaxing_static_dimensions() {
        let mut model = image_model();
        bind_input(
            &mut model,
            "pixel_values",
            DatumType::F32,
            &[1, 3, 256, 256],
        )
        .unwrap();
        assert_eq!(
            model
                .input_fact(0)
                .unwrap()
                .shape
                .as_concrete_finite()
                .unwrap()
                .unwrap()
                .as_slice(),
            &[1, 3, 256, 256]
        );
        assert!(bind_input(
            &mut image_model(),
            "pixel_values",
            DatumType::F32,
            &[1, 3, 128, 128]
        )
        .is_err());
    }

    #[test]
    fn rejects_wrong_input_name_type_and_rank() {
        assert!(bind_input(
            &mut image_model(),
            "wrong",
            DatumType::F32,
            &[1, 3, 256, 256]
        )
        .is_err());
        assert!(bind_input(
            &mut image_model(),
            "pixel_values",
            DatumType::I64,
            &[1, 3, 256, 256]
        )
        .is_err());
        assert!(bind_input(
            &mut image_model(),
            "pixel_values",
            DatumType::F32,
            &[1, 768]
        )
        .is_err());
    }

    fn solid_frame(width: u32, height: u32, color: [u8; 4]) -> RgbaFrame {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            rgba.extend_from_slice(&color);
        }
        RgbaFrame::new(width, height, rgba)
    }

    /// Real pinned-asset tract inference. Opt-in:
    /// `OPENTAKE_SEARCH_MODELS_DIR=$HOME/.dsh/opentake/models \
    ///  cargo test -p opentake-media --features tract-backend real_model_tract \
    ///  -- --ignored --nocapture`
    #[test]
    #[ignore = "requires the pinned SigLIP2 install at OPENTAKE_SEARCH_MODELS_DIR"]
    fn real_model_tract_embeddings_and_ranking() {
        use crate::search::{config, embed_store, model_download, ranker};

        let models_root = std::env::var("OPENTAKE_SEARCH_MODELS_DIR")
            .map(std::path::PathBuf::from)
            .or_else(|_| {
                dirs::home_dir()
                    .map(|home| home.join(".dsh").join("opentake").join("models"))
                    .ok_or(())
            })
            .expect("models directory");
        let manifest = config::manifest();
        let installed = model_download::verify_installed(&models_root, &manifest)
            .expect("pinned SigLIP2 assets must be installed and checksum-verified");
        let embedder = TractEmbedder::new(
            &installed.image_encoder,
            &installed.text_encoder,
            &installed.tokenizer_folder.join("tokenizer.json"),
            manifest.spec(),
        )
        .expect("tract must load the pinned fixed-shape encoders");

        let colors = [
            ("red", [230u8, 20, 20, 255]),
            ("blue", [20, 30, 230, 255]),
            ("green", [20, 210, 40, 255]),
        ];
        let check_vector = |v: &[f32]| {
            assert_eq!(v.len(), 768);
            assert!(v.iter().all(|x| x.is_finite()));
            assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-4);
        };
        let mut indexes = Vec::new();
        for (name, color) in colors {
            let frame = solid_frame(96, 96, color);
            let vector = embedder.encode_image(&frame).expect("tract image encode");
            check_vector(&vector);
            let header = embed_store::Header {
                model: manifest.model.clone(),
                model_version: manifest.version,
                sampler_version: 1,
                dim: 768,
                count: 1,
            };
            let rows = [embed_store::Row {
                time: 0.0,
                shot_start: 0.0,
                shot_end: 0.0,
            }];
            let index = embed_store::decode(&embed_store::encode(&header, &rows, &vector).unwrap())
                .unwrap();
            indexes.push((name.to_owned(), index));
        }
        let text = embedder
            .encode_text("a solid red square")
            .expect("tract text encode");
        check_vector(&text);
        let hits = ranker::search(
            &text,
            &indexes,
            config::SEARCH_LIMIT,
            config::RELATIVE_CUTOFF,
            Some(config::VISUAL_MATCH_COSINE_FLOOR),
        );
        println!("tract text query hits={hits:?}");
        assert_eq!(hits.first().map(|hit| hit.asset_id.as_str()), Some("red"));

        let red = solid_frame(96, 96, colors[0].1);
        let red_query = embedder.encode_image(&red).expect("tract self encode");
        let self_hits = ranker::search(
            &red_query,
            &indexes,
            config::SEARCH_LIMIT,
            config::RELATIVE_CUTOFF,
            Some(config::VISUAL_MATCH_COSINE_FLOOR),
        );
        println!("tract image self hits={self_hits:?}");
        assert_eq!(
            self_hits.first().map(|hit| hit.asset_id.as_str()),
            Some("red")
        );
        assert!(self_hits[0].score > 0.99);
    }
}
