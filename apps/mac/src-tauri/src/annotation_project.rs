use image::GenericImageView;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

const PROJECT_SCHEMA_VERSION: u32 = 1;
const MAX_PROJECT_BYTES: u64 = 8 * 1_024 * 1_024;
const MAX_PIXEL_BYTES: usize = 25 * 1_024 * 1_024;
const MAX_MARKS: usize = 10_000;
const MAX_FREEHAND_POINTS: usize = 100_000;
const MAX_TEXT_BYTES: usize = 4_096;
const MAX_COLOR_BYTES: usize = 64;
const MAX_ABSOLUTE_COORDINATE: f64 = 10_000_000.0;
const DEFAULT_IMAGE_SCALE: f64 = 1.0;
const MIN_OUTPUT_DIMENSION: u32 = 16;
const MAX_OUTPUT_DIMENSION: u32 = 16_384;
const MAX_OUTPUT_PIXELS: u64 = 32 * 1_024 * 1_024;

fn default_image_scale() -> f64 {
    DEFAULT_IMAGE_SCALE
}

fn is_default_image_scale(value: &f64) -> bool {
    *value == DEFAULT_IMAGE_SCALE
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StrokeWeight {
    Thin,
    Regular,
    Bold,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HighlighterOpacity {
    Soft,
    Regular,
    Strong,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArrowStyle {
    Classic,
    Open,
    Curved,
    Double,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) enum TextStyle {
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "rounded")]
    Rounded,
    #[serde(rename = "monospaced")]
    Monospaced,
    #[serde(rename = "outlined")]
    Outlined,
    #[serde(rename = "boxed")]
    Boxed,
    #[serde(rename = "rounded-boxed")]
    RoundedBoxed,
    #[serde(rename = "monospaced-boxed")]
    MonospacedBoxed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SpotlightStrength {
    Soft,
    Regular,
    Strong,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SpotlightShape {
    #[default]
    Rectangle,
    Rounded,
    Ellipse,
}

fn is_default_spotlight_shape(value: &SpotlightShape) -> bool {
    *value == SpotlightShape::Rectangle
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CounterStyle {
    #[default]
    Filled,
    Outlined,
    Plain,
}

fn is_default_counter_style(value: &CounterStyle) -> bool {
    *value == CounterStyle::Filled
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BlurMode {
    #[default]
    Secure,
    Smooth,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BlurStrength {
    Soft,
    #[default]
    Regular,
    Strong,
}

fn is_default_blur_strength(value: &BlurStrength) -> bool {
    *value == BlurStrength::Regular
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AnnotationPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AnnotationCrop {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) w: u32,
    pub(crate) h: u32,
}

fn deserialize_quarter_turns<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = u8::deserialize(deserializer)?;
    if value <= 3 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "image quarterTurns must be between 0 and 3",
        ))
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageTransform {
    #[serde(deserialize_with = "deserialize_quarter_turns")]
    pub(crate) quarter_turns: u8,
    pub(crate) flipped: bool,
}

impl ImageTransform {
    pub(crate) fn is_default(self) -> bool {
        self.quarter_turns == 0 && !self.flipped
    }

    pub(crate) fn output_dimensions(self, width: u32, height: u32) -> (u32, u32) {
        if self.quarter_turns % 2 == 1 {
            (height, width)
        } else {
            (width, height)
        }
    }
}

pub(crate) fn scaled_output_dimensions(
    width: u32,
    height: u32,
    image_transform: ImageTransform,
    image_scale: f64,
) -> Option<(u32, u32)> {
    if !image_scale.is_finite() || image_scale <= 0.0 {
        return None;
    }
    let (oriented_width, oriented_height) = image_transform.output_dimensions(width, height);
    if image_scale == DEFAULT_IMAGE_SCALE {
        return Some((oriented_width, oriented_height));
    }
    let scaled_width = (f64::from(oriented_width) * image_scale).round();
    let scaled_height = (f64::from(oriented_height) * image_scale).round();
    if scaled_width < f64::from(MIN_OUTPUT_DIMENSION)
        || scaled_height < f64::from(MIN_OUTPUT_DIMENSION)
        || scaled_width > f64::from(MAX_OUTPUT_DIMENSION)
        || scaled_height > f64::from(MAX_OUTPUT_DIMENSION)
    {
        return None;
    }
    let output = (scaled_width as u32, scaled_height as u32);
    (u64::from(output.0) * u64::from(output.1) <= MAX_OUTPUT_PIXELS).then_some(output)
}

fn is_default_image_transform(value: &ImageTransform) -> bool {
    value.is_default()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AnnotationMark {
    Arrow {
        color: String,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        #[serde(
            rename = "arrowStyle",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        arrow_style: Option<ArrowStyle>,
        #[serde(
            rename = "strokeWeight",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stroke_weight: Option<StrokeWeight>,
    },
    Line {
        color: String,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        #[serde(
            rename = "strokeWeight",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stroke_weight: Option<StrokeWeight>,
    },
    Box {
        color: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filled: Option<bool>,
        #[serde(
            rename = "strokeWeight",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stroke_weight: Option<StrokeWeight>,
    },
    Ellipse {
        color: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filled: Option<bool>,
        #[serde(
            rename = "strokeWeight",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stroke_weight: Option<StrokeWeight>,
    },
    Text {
        color: String,
        x: f64,
        y: f64,
        text: String,
        size: f64,
        #[serde(rename = "textStyle", default, skip_serializing_if = "Option::is_none")]
        text_style: Option<TextStyle>,
    },
    Pencil {
        points: Vec<AnnotationPoint>,
        color: String,
        #[serde(
            rename = "strokeWeight",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stroke_weight: Option<StrokeWeight>,
    },
    Highlighter {
        points: Vec<AnnotationPoint>,
        color: String,
        #[serde(
            rename = "strokeWeight",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stroke_weight: Option<StrokeWeight>,
        #[serde(
            rename = "smartWidth",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        smart_width: Option<f64>,
        #[serde(
            rename = "highlighterOpacity",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        highlighter_opacity: Option<HighlighterOpacity>,
    },
    Counter {
        color: String,
        x: f64,
        y: f64,
        value: u64,
        size: f64,
        #[serde(
            rename = "counterStyle",
            default,
            skip_serializing_if = "is_default_counter_style"
        )]
        counter_style: CounterStyle,
    },
    Spotlight {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        strength: Option<SpotlightStrength>,
        #[serde(
            rename = "spotlightShape",
            default,
            skip_serializing_if = "is_default_spotlight_shape"
        )]
        spotlight_shape: SpotlightShape,
    },
    Blur {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
    BlurEffect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(rename = "blurMode", default)]
        blur_mode: BlurMode,
        #[serde(
            rename = "blurStrength",
            default,
            skip_serializing_if = "is_default_blur_strength"
        )]
        blur_strength: BlurStrength,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnnotationProjectDocument {
    schema_version: u32,
    pub(crate) capture_id: String,
    pub(crate) revision: u64,
    width: u32,
    height: u32,
    pub(crate) original_sha256: String,
    pub(crate) flattened_sha256: String,
    saved_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) crop: Option<AnnotationCrop>,
    #[serde(default, skip_serializing_if = "is_default_image_transform")]
    pub(crate) image_transform: ImageTransform,
    #[serde(
        default = "default_image_scale",
        skip_serializing_if = "is_default_image_scale"
    )]
    pub(crate) image_scale: f64,
    pub(crate) marks: Vec<AnnotationMark>,
}

fn canonical_capture_id(value: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(value).ok()?;
    let canonical = parsed.to_string();
    (canonical == value).then_some(canonical)
}

fn capture_id_from_png(path: &Path) -> Result<String, String> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("png") {
        return Err("The editable annotation is not attached to a PNG capture.".into());
    }
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(canonical_capture_id)
        .ok_or_else(|| "The editable annotation has an invalid capture identifier.".into())
}

fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn finite_coordinate(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_ABSOLUTE_COORDINATE
}

fn valid_color(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_COLOR_BYTES && !value.chars().any(char::is_control)
}

fn valid_segment(values: [f64; 4]) -> bool {
    values.into_iter().all(finite_coordinate)
        && (values[2] - values[0]).hypot(values[3] - values[1]) >= 6.0
}

fn valid_rect(x: f64, y: f64, w: f64, h: f64) -> bool {
    [x, y, w, h].into_iter().all(finite_coordinate) && w >= 4.0 && h >= 4.0
}

pub(crate) fn validate_marks(marks: &[AnnotationMark]) -> Result<(), String> {
    if marks.len() > MAX_MARKS {
        return Err("The editable annotation has an invalid number of marks.".into());
    }
    let mut points = 0_usize;
    for mark in marks {
        let valid = match mark {
            AnnotationMark::Arrow {
                color,
                x1,
                y1,
                x2,
                y2,
                ..
            }
            | AnnotationMark::Line {
                color,
                x1,
                y1,
                x2,
                y2,
                ..
            } => valid_color(color) && valid_segment([*x1, *y1, *x2, *y2]),
            AnnotationMark::Box {
                color, x, y, w, h, ..
            }
            | AnnotationMark::Ellipse {
                color, x, y, w, h, ..
            } => valid_color(color) && valid_rect(*x, *y, *w, *h),
            AnnotationMark::Text {
                color,
                x,
                y,
                text,
                size,
                ..
            } => {
                valid_color(color)
                    && finite_coordinate(*x)
                    && finite_coordinate(*y)
                    && finite_coordinate(*size)
                    && *size >= 1.0
                    && !text.trim().is_empty()
                    && text.len() <= MAX_TEXT_BYTES
            }
            AnnotationMark::Pencil {
                points: mark_points,
                color,
                ..
            } => {
                points = points.saturating_add(mark_points.len());
                valid_color(color)
                    && mark_points.len() >= 2
                    && mark_points
                        .iter()
                        .all(|point| finite_coordinate(point.x) && finite_coordinate(point.y))
            }
            AnnotationMark::Highlighter {
                points: mark_points,
                color,
                smart_width,
                ..
            } => {
                points = points.saturating_add(mark_points.len());
                valid_color(color)
                    && mark_points.len() >= 2
                    && mark_points
                        .iter()
                        .all(|point| finite_coordinate(point.x) && finite_coordinate(point.y))
                    && smart_width.is_none_or(|width| {
                        finite_coordinate(width) && (4.0..=256.0).contains(&width)
                    })
            }
            AnnotationMark::Counter {
                color,
                x,
                y,
                value,
                size,
                ..
            } => {
                valid_color(color)
                    && finite_coordinate(*x)
                    && finite_coordinate(*y)
                    && finite_coordinate(*size)
                    && *size >= 1.0
                    && *value <= 9_007_199_254_740_991
            }
            AnnotationMark::Spotlight { x, y, w, h, .. }
            | AnnotationMark::Blur { x, y, w, h }
            | AnnotationMark::BlurEffect { x, y, w, h, .. } => valid_rect(*x, *y, *w, *h),
        };
        if !valid {
            return Err("The editable annotation contains an invalid mark.".into());
        }
        if points > MAX_FREEHAND_POINTS {
            return Err("The editable annotation contains too many freehand points.".into());
        }
    }
    Ok(())
}

fn validate_document(document: &AnnotationProjectDocument) -> Result<(), String> {
    if document.schema_version != PROJECT_SCHEMA_VERSION {
        return Err("This editable annotation was created by an unsupported Capso version.".into());
    }
    if canonical_capture_id(&document.capture_id).as_deref() != Some(document.capture_id.as_str())
        || document.revision == 0
        || document.width == 0
        || document.height == 0
        || !document.image_scale.is_finite()
        || document.image_scale <= 0.0
        || !valid_sha256(&document.original_sha256)
        || !valid_sha256(&document.flattened_sha256)
    {
        return Err("The editable annotation project metadata is invalid.".into());
    }
    if document.marks.is_empty()
        && document.crop.is_none()
        && document.image_transform.is_default()
        && is_default_image_scale(&document.image_scale)
    {
        return Err("The editable annotation project has no saved edits.".into());
    }
    validate_crop(
        document.crop,
        document.width,
        document.height,
        None,
        document.image_transform,
        document.image_scale,
    )?;
    validate_marks(&document.marks)
}

fn validate_crop(
    crop: Option<AnnotationCrop>,
    output_width: u32,
    output_height: u32,
    source_dimensions: Option<(u32, u32)>,
    image_transform: ImageTransform,
    image_scale: f64,
) -> Result<(), String> {
    let Some(crop) = crop else {
        if source_dimensions.is_some_and(|(width, height)| {
            scaled_output_dimensions(width, height, image_transform, image_scale)
                != Some((output_width, output_height))
        }) {
            return Err(
                "The editable annotation output dimensions do not match its protected original orientation and resolution.".into(),
            );
        }
        return Ok(());
    };
    if crop.w < 16
        || crop.h < 16
        || scaled_output_dimensions(crop.w, crop.h, image_transform, image_scale)
            != Some((output_width, output_height))
        || source_dimensions.is_some_and(|(width, height)| {
            crop.x.checked_add(crop.w).is_none_or(|right| right > width)
                || crop
                    .y
                    .checked_add(crop.h)
                    .is_none_or(|bottom| bottom > height)
        })
    {
        return Err("The editable annotation crop is outside its protected original.".into());
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the editable annotation project: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > MAX_PROJECT_BYTES
    {
        return Err("The editable annotation project is not a safe regular document.".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(MAX_PROJECT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("Could not read the editable annotation project: {error}"))?;
    if bytes.len() as u64 > MAX_PROJECT_BYTES {
        return Err("The editable annotation project is too large to open safely.".into());
    }
    Ok(bytes)
}

fn read_regular_pixels(path: &Path, label: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the {label}: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(format!("The {label} is not a safe regular file."));
    }
    fs::read(path).map_err(|error| format!("Could not read the {label}: {error}"))
}

fn parse_document(path: &Path) -> Result<AnnotationProjectDocument, String> {
    decode_for_sync(&read_bounded(path)?)
}

pub(crate) fn decode_for_sync(bytes: &[u8]) -> Result<AnnotationProjectDocument, String> {
    let document: AnnotationProjectDocument = serde_json::from_slice(bytes)
        .map_err(|error| format!("Could not decode the editable annotation project: {error}"))?;
    validate_document(&document)?;
    Ok(document)
}

pub(crate) fn project_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("annotation-projects"))
        .map_err(|error| format!("Could not locate Capso's editable annotation store: {error}"))
}

fn project_path(directory: &Path, capture_id: &str) -> Result<PathBuf, String> {
    let canonical = canonical_capture_id(capture_id)
        .ok_or_else(|| "The editable annotation has an invalid capture identifier.".to_string())?;
    Ok(directory.join(format!("{canonical}.json")))
}

pub(crate) fn inspect_revision(directory: &Path, capture_id: &str) -> Option<u64> {
    let path = project_path(directory, capture_id).ok()?;
    let document = parse_document(&path).ok()?;
    (document.capture_id == capture_id).then_some(document.revision)
}

pub(crate) fn load_for_capture(
    directory: &Path,
    canonical_path: &Path,
    original_path: &Path,
) -> Result<AnnotationProjectDocument, String> {
    let capture_id = capture_id_from_png(canonical_path)?;
    if capture_id_from_png(original_path)? != capture_id {
        return Err("The protected original does not match this editable annotation.".into());
    }
    let document = parse_document(&project_path(directory, &capture_id)?)?;
    if document.capture_id != capture_id {
        return Err("The editable annotation project belongs to another capture.".into());
    }
    let canonical_bytes = read_regular_pixels(canonical_path, "annotated capture")?;
    let original_bytes = read_regular_pixels(original_path, "protected original")?;
    if hash(&canonical_bytes) != document.flattened_sha256
        || hash(&original_bytes) != document.original_sha256
    {
        return Err("The editable annotation no longer matches these capture pixels.".into());
    }
    let canonical_image = image::load_from_memory(&canonical_bytes)
        .map_err(|error| format!("Could not decode the annotated capture: {error}"))?;
    let original_image = image::load_from_memory(&original_bytes)
        .map_err(|error| format!("Could not decode the protected original: {error}"))?;
    if canonical_image.dimensions() != (document.width, document.height) {
        return Err("The editable annotation dimensions no longer match the capture.".into());
    }
    validate_crop(
        document.crop,
        document.width,
        document.height,
        Some(original_image.dimensions()),
        document.image_transform,
        document.image_scale,
    )?;
    Ok(document)
}

/// Load an existing editable project, or authorize one clean flattened capture
/// to become a new editable baseline. An orphaned original means a previous
/// save crossed the pixel boundary without completing its project document; in
/// that state silently starting over would bind new marks to the wrong pixels.
pub(crate) fn load_optional_for_capture(
    directory: &Path,
    canonical_path: &Path,
    original_path: &Path,
) -> Result<Option<AnnotationProjectDocument>, String> {
    let capture_id = capture_id_from_png(canonical_path)?;
    let path = project_path(directory, &capture_id)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            load_for_capture(directory, canonical_path, original_path).map(Some)
        }
        Ok(_) => Err("The editable annotation project is not a direct regular file.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::symlink_metadata(original_path) {
                Err(original_error)
                    if original_error.kind() == std::io::ErrorKind::NotFound =>
                {
                    Ok(None)
                }
                Err(original_error) => Err(format!(
                    "Could not inspect the protected annotation original: {original_error}"
                )),
                Ok(_) => Err(
                    "A protected original exists without its editable project. Capso will not replace either file."
                        .into(),
                ),
            }
        }
        Err(error) => Err(format!(
            "Could not inspect the editable annotation project: {error}"
        )),
    }
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err("Capso's editable annotation store is not a direct directory.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| {
                format!("Could not create Capso's editable annotation store: {error}")
            })?;
            let metadata = fs::symlink_metadata(path).map_err(|error| {
                format!("Could not inspect Capso's editable annotation store: {error}")
            })?;
            if metadata.file_type().is_dir() {
                Ok(())
            } else {
                Err("Capso's editable annotation store is not a direct directory.".into())
            }
        }
        Err(error) => Err(format!(
            "Could not inspect Capso's editable annotation store: {error}"
        )),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The editable annotation path has no parent directory.".to_string())?;
    ensure_directory(parent)?;
    let temporary = parent.join(format!(".capso-project-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!("Could not reserve the editable annotation update: {error}")
            })?;
        file.write_all(bytes)
            .map_err(|error| format!("Could not write the editable annotation project: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync the editable annotation project: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| {
            format!("Could not commit the editable annotation project: {error}")
        })?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync the editable annotation store: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
pub(crate) fn persist_for_capture(
    directory: &Path,
    canonical_path: &Path,
    original_path: &Path,
    flattened: &[u8],
    expected_revision: u64,
    crop: Option<AnnotationCrop>,
    marks: Vec<AnnotationMark>,
) -> Result<AnnotationProjectDocument, String> {
    persist_for_capture_with_transform(
        directory,
        canonical_path,
        original_path,
        flattened,
        expected_revision,
        crop,
        ImageTransform::default(),
        marks,
    )
}

#[cfg(test)]
pub(crate) fn persist_for_capture_with_transform(
    directory: &Path,
    canonical_path: &Path,
    original_path: &Path,
    flattened: &[u8],
    expected_revision: u64,
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    marks: Vec<AnnotationMark>,
) -> Result<AnnotationProjectDocument, String> {
    persist_for_capture_with_transform_and_scale(
        directory,
        canonical_path,
        original_path,
        flattened,
        expected_revision,
        crop,
        image_transform,
        DEFAULT_IMAGE_SCALE,
        marks,
    )
}

pub(crate) fn persist_for_capture_with_transform_and_scale(
    directory: &Path,
    canonical_path: &Path,
    original_path: &Path,
    flattened: &[u8],
    expected_revision: u64,
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
    marks: Vec<AnnotationMark>,
) -> Result<AnnotationProjectDocument, String> {
    validate_marks(&marks)?;
    if marks.is_empty()
        && crop.is_none()
        && image_transform.is_default()
        && is_default_image_scale(&image_scale)
    {
        return Err("The editable annotation project has no saved edits.".into());
    }
    let capture_id = capture_id_from_png(canonical_path)?;
    if capture_id_from_png(original_path)? != capture_id {
        return Err("The protected original does not match this editable annotation.".into());
    }
    let project_path = project_path(directory, &capture_id)?;
    let canonical_bytes = read_regular_pixels(canonical_path, "annotated capture")?;
    if canonical_bytes != flattened {
        return Err(
            "The committed capture pixels changed before its editable project was stored.".into(),
        );
    }
    let original_bytes = read_regular_pixels(original_path, "protected original")?;
    let flattened_image = image::load_from_memory(flattened)
        .map_err(|error| format!("Could not decode the flattened annotation project: {error}"))?;
    let original_image = image::load_from_memory(&original_bytes)
        .map_err(|error| format!("Could not decode the protected original: {error}"))?;
    validate_crop(
        crop,
        flattened_image.width(),
        flattened_image.height(),
        Some(original_image.dimensions()),
        image_transform,
        image_scale,
    )?;
    let flattened_sha256 = hash(flattened);
    let original_sha256 = hash(&original_bytes);
    let next_revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| "The editable annotation revision cannot advance safely.".to_string())?;

    if project_path.exists() {
        let existing = parse_document(&project_path)?;
        if existing.capture_id != capture_id || existing.original_sha256 != original_sha256 {
            return Err(
                "The existing editable annotation belongs to different source pixels.".into(),
            );
        }
        if existing.revision == next_revision {
            if existing.flattened_sha256 == flattened_sha256
                && existing.crop == crop
                && existing.image_transform == image_transform
                && existing.image_scale == image_scale
                && existing.marks == marks
            {
                return Ok(existing);
            }
            // A native save can commit pixels/project before a later clipboard,
            // overlay, or queue step reports failure. The one still-active
            // editor may retry with adjusted marks at the same next revision;
            // another editor cannot coexist in AnnotationRuntime.
        } else if existing.revision != expected_revision {
            return Err("This editable annotation changed after the editor opened. Reopen it before saving.".into());
        }
    } else if expected_revision != 0 {
        return Err("The editable annotation project disappeared after the editor opened.".into());
    }

    let (width, height) = flattened_image.dimensions();
    let document = AnnotationProjectDocument {
        schema_version: PROJECT_SCHEMA_VERSION,
        capture_id,
        revision: next_revision,
        width,
        height,
        original_sha256,
        flattened_sha256,
        saved_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64,
        crop,
        image_transform,
        image_scale,
        marks,
    };
    let encoded = serde_json::to_vec(&document)
        .map_err(|error| format!("Could not encode the editable annotation project: {error}"))?;
    if encoded.len() as u64 > MAX_PROJECT_BYTES {
        return Err("The editable annotation project is too large to store safely.".into());
    }
    atomic_write(&project_path, &encoded)?;
    Ok(document)
}

pub(crate) fn install_remote_revision(
    projects_directory: &Path,
    captures_directory: &Path,
    originals_directory: &Path,
    capture_id: &str,
    document_bytes: &[u8],
    original_bytes: &[u8],
    flattened_bytes: &[u8],
    replace_existing: bool,
) -> Result<AnnotationProjectDocument, String> {
    if canonical_capture_id(capture_id).as_deref() != Some(capture_id)
        || document_bytes.is_empty()
        || document_bytes.len() as u64 > MAX_PROJECT_BYTES
        || original_bytes.is_empty()
        || original_bytes.len() > MAX_PIXEL_BYTES
        || flattened_bytes.is_empty()
        || flattened_bytes.len() > MAX_PIXEL_BYTES
    {
        return Err("The downloaded editable annotation is outside Capso's safety limits.".into());
    }
    let document = decode_for_sync(document_bytes)?;
    if document.capture_id != capture_id
        || hash(original_bytes) != document.original_sha256
        || hash(flattened_bytes) != document.flattened_sha256
    {
        return Err(
            "The downloaded editable annotation does not match its protected hashes.".into(),
        );
    }
    let original_image = image::load_from_memory(original_bytes)
        .map_err(|_| "The downloaded protected original is not a valid image.".to_string())?;
    let flattened_image = image::load_from_memory(flattened_bytes)
        .map_err(|_| "The downloaded flattened revision is not a valid image.".to_string())?;
    if flattened_image.dimensions() != (document.width, document.height) {
        return Err("The downloaded editable annotation dimensions do not match.".into());
    }
    validate_crop(
        document.crop,
        document.width,
        document.height,
        Some(original_image.dimensions()),
        document.image_transform,
        document.image_scale,
    )?;

    let project_path = project_path(projects_directory, capture_id)?;
    let capture_path = captures_directory.join(format!("{capture_id}.png"));
    let original_path = originals_directory.join(format!("{capture_id}.png"));
    if project_path.exists() {
        if !replace_existing {
            return Err("That editable annotation already exists on this Mac.".into());
        }
        let existing = parse_document(&project_path)?;
        if existing.capture_id != capture_id || existing.original_sha256 != document.original_sha256
        {
            return Err("The downloaded revision belongs to different protected pixels.".into());
        }
    } else if capture_path.exists() {
        return Err(
            "A local capture already uses that remote editable annotation identity.".into(),
        );
    }
    if original_path.exists() {
        if read_regular_pixels(&original_path, "protected original")? != original_bytes {
            return Err(
                "The downloaded revision would replace a different protected original.".into(),
            );
        }
    } else {
        atomic_write(&original_path, original_bytes)?;
    }
    atomic_write(&capture_path, flattened_bytes)?;
    atomic_write(&project_path, document_bytes)?;
    load_for_capture(projects_directory, &capture_path, &original_path)?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::{
        inspect_revision, install_remote_revision, load_for_capture, load_optional_for_capture,
        persist_for_capture, persist_for_capture_with_transform,
        persist_for_capture_with_transform_and_scale, validate_marks, AnnotationCrop,
        AnnotationMark, ArrowStyle, ImageTransform, StrokeWeight,
    };
    use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};
    use std::{fs, io::Cursor};

    const ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";

    fn png(color: [u8; 4]) -> Vec<u8> {
        png_sized(12, 8, color)
    }

    fn png_sized(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, Rgba(color)))
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("encode PNG");
        bytes
    }

    fn arrow() -> AnnotationMark {
        AnnotationMark::Arrow {
            color: "red".into(),
            x1: 1.0,
            y1: 1.0,
            x2: 10.0,
            y2: 7.0,
            arrow_style: Some(ArrowStyle::Curved),
            stroke_weight: Some(StrokeWeight::Bold),
        }
    }

    #[test]
    fn project_round_trip_binds_revision_original_flattened_and_exact_marks() {
        let root = tempfile::tempdir().expect("project root");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let projects = root.path().join("annotation-projects");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{ID}.png"));
        let original = originals.join(format!("{ID}.png"));
        let original_bytes = png([10, 20, 30, 255]);
        let flattened = png([220, 20, 30, 255]);
        fs::write(&capture, &flattened).expect("capture");
        fs::write(&original, &original_bytes).expect("original");

        let stored = persist_for_capture(
            &projects,
            &capture,
            &original,
            &flattened,
            0,
            None,
            vec![arrow()],
        )
        .expect("persist project");
        assert_eq!(stored.revision, 1);
        assert_eq!(inspect_revision(&projects, ID), Some(1));
        assert_eq!(
            load_for_capture(&projects, &capture, &original)
                .expect("load project")
                .marks,
            vec![arrow()]
        );
        assert_eq!(
            load_optional_for_capture(&projects, &capture, &original)
                .expect("load optional project")
                .expect("stored project")
                .revision,
            1,
        );
    }

    #[test]
    fn flattened_history_can_start_fresh_only_without_project_or_original_residue() {
        let root = tempfile::tempdir().expect("project root");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let projects = root.path().join("annotation-projects");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{ID}.png"));
        let original = originals.join(format!("{ID}.png"));
        fs::write(&capture, png([10, 20, 30, 255])).expect("capture");

        assert_eq!(
            load_optional_for_capture(&projects, &capture, &original)
                .expect("clean flattened capture"),
            None,
        );

        fs::write(&original, png([10, 20, 30, 255])).expect("orphan original");
        assert!(load_optional_for_capture(&projects, &capture, &original)
            .expect_err("orphan original must fail closed")
            .contains("without its editable project"));
        fs::remove_file(&original).expect("remove orphan original");

        fs::create_dir_all(&projects).expect("projects");
        fs::write(projects.join(format!("{ID}.json")), b"not-json").expect("corrupt project");
        assert!(load_optional_for_capture(&projects, &capture, &original)
            .expect_err("corrupt project must not become a fresh baseline")
            .contains("decode"));
    }

    #[test]
    fn project_rejects_stale_revisions_and_pixel_mismatches_but_replay_is_idempotent() {
        let root = tempfile::tempdir().expect("project root");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let projects = root.path().join("annotation-projects");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{ID}.png"));
        let original = originals.join(format!("{ID}.png"));
        let original_bytes = png([10, 20, 30, 255]);
        let flattened = png([220, 20, 30, 255]);
        fs::write(&capture, &flattened).expect("capture");
        fs::write(&original, &original_bytes).expect("original");

        persist_for_capture(
            &projects,
            &capture,
            &original,
            &flattened,
            0,
            None,
            vec![arrow()],
        )
        .expect("first revision");
        assert_eq!(
            persist_for_capture(
                &projects,
                &capture,
                &original,
                &flattened,
                0,
                None,
                vec![arrow()]
            )
            .expect("idempotent retry")
            .revision,
            1
        );
        assert!(persist_for_capture(
            &projects,
            &capture,
            &original,
            &flattened,
            2,
            None,
            vec![arrow()]
        )
        .expect_err("stale revision")
        .contains("changed"));

        fs::write(&capture, png([0, 0, 0, 255])).expect("replace pixels");
        assert!(load_for_capture(&projects, &capture, &original)
            .expect_err("pixel mismatch")
            .contains("pixels"));
    }

    #[test]
    fn malformed_or_oversized_mark_payloads_never_create_a_project() {
        let root = tempfile::tempdir().expect("project root");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let projects = root.path().join("annotation-projects");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{ID}.png"));
        let original = originals.join(format!("{ID}.png"));
        let bytes = png([10, 20, 30, 255]);
        fs::write(&capture, &bytes).expect("capture");
        fs::write(&original, &bytes).expect("original");

        let invalid = AnnotationMark::Text {
            color: "red".into(),
            x: 1.0,
            y: 1.0,
            text: " ".into(),
            size: 20.0,
            text_style: None,
        };
        assert!(persist_for_capture(
            &projects,
            &capture,
            &original,
            &bytes,
            0,
            None,
            vec![invalid]
        )
        .expect_err("invalid mark")
        .contains("invalid mark"));
        assert!(!projects.exists());
    }

    #[test]
    fn native_mark_json_round_trips_the_exact_editor_field_contract() {
        let value = serde_json::json!([
            {"kind":"arrow","color":"#b03a48","x1":1.0,"y1":2.0,"x2":9.0,"y2":10.0,"arrowStyle":"double","strokeWeight":"bold"},
            {"kind":"line","color":"#a8702c","x1":1.0,"y1":2.0,"x2":9.0,"y2":10.0,"strokeWeight":"thin"},
            {"kind":"box","color":"#4f7a45","x":1.0,"y":2.0,"w":9.0,"h":10.0,"filled":true,"strokeWeight":"regular"},
            {"kind":"ellipse","color":"#3f6aa3","x":1.0,"y":2.0,"w":9.0,"h":10.0,"filled":false},
            {"kind":"text","color":"#6a5ba8","x":1.0,"y":2.0,"text":"Ready","size":20.0,"textStyle":"rounded-boxed"},
            {"kind":"pencil","color":"#b03a48","points":[{"x":1.0,"y":2.0},{"x":8.0,"y":9.0}]},
            {"kind":"highlighter","color":"#a8702c","points":[{"x":1.0,"y":2.0},{"x":8.0,"y":9.0}],"strokeWeight":"bold","smartWidth":18.0,"highlighterOpacity":"strong"},
            {"kind":"counter","color":"#4f7a45","x":1.0,"y":2.0,"value":0,"size":24.0,"counterStyle":"outlined"},
            {"kind":"spotlight","x":1.0,"y":2.0,"w":9.0,"h":10.0,"strength":"strong","spotlightShape":"ellipse"},
            {"kind":"blur","x":1.0,"y":2.0,"w":9.0,"h":10.0},
            {"kind":"blur_effect","x":1.0,"y":2.0,"w":9.0,"h":10.0,"blurMode":"secure"},
            {"kind":"blur_effect","x":11.0,"y":12.0,"w":19.0,"h":20.0,"blurMode":"smooth","blurStrength":"strong"}
        ]);
        let marks: Vec<AnnotationMark> =
            serde_json::from_value(value.clone()).expect("decode editor marks");
        assert_eq!(
            serde_json::to_value(marks).expect("encode editor marks"),
            value
        );
    }

    #[test]
    fn smart_highlighter_width_is_optional_but_strictly_bounded() {
        let valid: Vec<AnnotationMark> = serde_json::from_value(serde_json::json!([{
            "kind":"highlighter",
            "color":"#a8702c",
            "points":[{"x":1.0,"y":2.0},{"x":8.0,"y":9.0}],
            "smartWidth":4.0
        }]))
        .expect("valid smart highlighter");
        assert!(validate_marks(&valid).is_ok());
        assert_eq!(
            serde_json::to_value(&valid).expect("encode legacy highlighter"),
            serde_json::json!([{
                "kind":"highlighter",
                "color":"#a8702c",
                "points":[{"x":1.0,"y":2.0},{"x":8.0,"y":9.0}],
                "smartWidth":4.0
            }])
        );

        for opacity in ["soft", "strong"] {
            let value = serde_json::json!({
                "kind":"highlighter",
                "color":"#a8702c",
                "points":[{"x":1.0,"y":2.0},{"x":8.0,"y":9.0}],
                "highlighterOpacity":opacity
            });
            let mark: AnnotationMark =
                serde_json::from_value(value.clone()).expect("decode opacity");
            assert_eq!(serde_json::to_value(mark).expect("encode opacity"), value);
        }
        assert!(serde_json::from_value::<AnnotationMark>(serde_json::json!({
            "kind":"highlighter",
            "color":"#a8702c",
            "points":[{"x":1.0,"y":2.0},{"x":8.0,"y":9.0}],
            "highlighterOpacity":"opaque"
        }))
        .is_err());

        for width in [3.9, 256.1] {
            let invalid: Vec<AnnotationMark> = serde_json::from_value(serde_json::json!([{
                "kind":"highlighter",
                "color":"#a8702c",
                "points":[{"x":1.0,"y":2.0},{"x":8.0,"y":9.0}],
                "smartWidth":width
            }]))
            .expect("structurally decodable highlighter");
            assert!(validate_marks(&invalid).is_err());
        }
    }

    #[test]
    fn spotlight_rectangle_is_default_while_shape_variants_round_trip_exactly() {
        let legacy: AnnotationMark = serde_json::from_value(serde_json::json!({
            "kind":"spotlight","x":1.0,"y":2.0,"w":30.0,"h":20.0
        }))
        .expect("decode legacy spotlight");
        assert_eq!(
            serde_json::to_value(legacy).expect("encode legacy spotlight"),
            serde_json::json!({"kind":"spotlight","x":1.0,"y":2.0,"w":30.0,"h":20.0})
        );
        for shape in ["rounded", "ellipse"] {
            let value = serde_json::json!({
                "kind":"spotlight","x":1.0,"y":2.0,"w":30.0,"h":20.0,"spotlightShape":shape
            });
            let mark: AnnotationMark =
                serde_json::from_value(value.clone()).expect("decode spotlight shape");
            assert_eq!(
                serde_json::to_value(mark).expect("encode spotlight shape"),
                value
            );
        }
    }

    #[test]
    fn image_orientation_has_one_exact_optional_json_contract() {
        let transform: ImageTransform = serde_json::from_value(serde_json::json!({
            "quarterTurns": 3,
            "flipped": true
        }))
        .expect("decode image transform");
        assert_eq!(transform.output_dimensions(80, 60), (60, 80));
        assert_eq!(
            serde_json::to_value(transform).expect("encode image transform"),
            serde_json::json!({"quarterTurns":3,"flipped":true})
        );
        assert!(serde_json::from_value::<ImageTransform>(serde_json::json!({
            "quarterTurns":4,
            "flipped":false
        }))
        .is_err());
    }

    #[test]
    fn crop_only_project_round_trips_source_space_viewport_and_output_dimensions() {
        let root = tempfile::tempdir().expect("project root");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let projects = root.path().join("annotation-projects");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{ID}.png"));
        let original = originals.join(format!("{ID}.png"));
        let original_bytes = png_sized(80, 60, [10, 20, 30, 255]);
        let flattened = png_sized(40, 30, [220, 20, 30, 255]);
        let crop = AnnotationCrop {
            x: 12,
            y: 8,
            w: 40,
            h: 30,
        };
        fs::write(&capture, &flattened).expect("capture");
        fs::write(&original, &original_bytes).expect("original");

        let stored = persist_for_capture(
            &projects,
            &capture,
            &original,
            &flattened,
            0,
            Some(crop),
            vec![],
        )
        .expect("persist crop-only project");
        assert_eq!(stored.crop, Some(crop));
        let loaded = load_for_capture(&projects, &capture, &original).expect("load crop project");
        assert_eq!(loaded.crop, Some(crop));
        assert!(loaded.marks.is_empty());
    }

    #[test]
    fn orientation_only_project_round_trips_without_rewriting_source_space_marks() {
        let root = tempfile::tempdir().expect("project root");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let projects = root.path().join("annotation-projects");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{ID}.png"));
        let original = originals.join(format!("{ID}.png"));
        let original_bytes = png_sized(80, 60, [10, 20, 30, 255]);
        let flattened = png_sized(60, 80, [220, 20, 30, 255]);
        let image_transform = ImageTransform {
            quarter_turns: 1,
            flipped: false,
        };
        fs::write(&capture, &flattened).expect("capture");
        fs::write(&original, &original_bytes).expect("original");

        let stored = persist_for_capture_with_transform(
            &projects,
            &capture,
            &original,
            &flattened,
            0,
            None,
            image_transform,
            vec![],
        )
        .expect("persist orientation-only project");
        assert_eq!(stored.image_transform, image_transform);
        assert!(stored.marks.is_empty());
        let loaded =
            load_for_capture(&projects, &capture, &original).expect("load orientation project");
        assert_eq!(loaded.image_transform, image_transform);
        assert_eq!(image::open(&original).unwrap().dimensions(), (80, 60));
    }

    #[test]
    fn resize_only_project_round_trips_exact_scale_and_rejects_dimension_mismatch() {
        let root = tempfile::tempdir().expect("project root");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let projects = root.path().join("annotation-projects");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{ID}.png"));
        let original = originals.join(format!("{ID}.png"));
        let original_bytes = png_sized(80, 60, [10, 20, 30, 255]);
        let flattened = png_sized(40, 30, [220, 20, 30, 255]);
        fs::write(&capture, &flattened).expect("capture");
        fs::write(&original, &original_bytes).expect("original");

        let stored = persist_for_capture_with_transform_and_scale(
            &projects,
            &capture,
            &original,
            &flattened,
            0,
            None,
            ImageTransform::default(),
            0.5,
            vec![],
        )
        .expect("persist resize-only project");
        assert_eq!(stored.image_scale, 0.5);
        assert!(stored.marks.is_empty());
        let document = fs::read_to_string(projects.join(format!("{ID}.json"))).unwrap();
        assert!(document.contains("\"imageScale\":0.5"));
        assert_eq!(
            load_for_capture(&projects, &capture, &original)
                .expect("load resized project")
                .image_scale,
            0.5
        );
    }

    #[test]
    fn remote_revision_install_validates_every_byte_and_only_replaces_a_known_safe_project() {
        let remote = tempfile::tempdir().expect("remote fixture");
        let remote_captures = remote.path().join("captures");
        let remote_originals = remote.path().join("capture-originals");
        let remote_projects = remote.path().join("annotation-projects");
        fs::create_dir_all(&remote_captures).expect("remote captures");
        fs::create_dir_all(&remote_originals).expect("remote originals");
        let remote_capture = remote_captures.join(format!("{ID}.png"));
        let remote_original = remote_originals.join(format!("{ID}.png"));
        let original_bytes = png([10, 20, 30, 255]);
        let first_flattened = png([220, 20, 30, 255]);
        fs::write(&remote_capture, &first_flattened).expect("remote flattened");
        fs::write(&remote_original, &original_bytes).expect("remote original");
        persist_for_capture(
            &remote_projects,
            &remote_capture,
            &remote_original,
            &first_flattened,
            0,
            None,
            vec![arrow()],
        )
        .expect("remote revision one");
        let first_document =
            fs::read(remote_projects.join(format!("{ID}.json"))).expect("remote document one");

        let local = tempfile::tempdir().expect("local root");
        let local_captures = local.path().join("captures");
        let local_originals = local.path().join("capture-originals");
        let local_projects = local.path().join("annotation-projects");
        let installed = install_remote_revision(
            &local_projects,
            &local_captures,
            &local_originals,
            ID,
            &first_document,
            &original_bytes,
            &first_flattened,
            false,
        )
        .expect("install first remote revision");
        assert_eq!(installed.revision, 1);
        assert_eq!(
            fs::read(local_captures.join(format!("{ID}.png"))).unwrap(),
            first_flattened
        );
        assert_eq!(
            fs::read(local_originals.join(format!("{ID}.png"))).unwrap(),
            original_bytes
        );
        assert_eq!(inspect_revision(&local_projects, ID), Some(1));

        assert!(install_remote_revision(
            &local_projects,
            &local_captures,
            &local_originals,
            ID,
            &first_document,
            &original_bytes,
            &first_flattened,
            false,
        )
        .expect_err("unknown local state cannot be replaced")
        .contains("already exists"));

        let second_flattened = png([20, 220, 30, 255]);
        fs::write(&remote_capture, &second_flattened).expect("second flattened");
        persist_for_capture(
            &remote_projects,
            &remote_capture,
            &remote_original,
            &second_flattened,
            1,
            None,
            vec![AnnotationMark::Text {
                color: "blue".into(),
                x: 1.0,
                y: 1.0,
                text: "Remote".into(),
                size: 18.0,
                text_style: None,
            }],
        )
        .expect("remote revision two");
        let second_document =
            fs::read(remote_projects.join(format!("{ID}.json"))).expect("remote document two");
        install_remote_revision(
            &local_projects,
            &local_captures,
            &local_originals,
            ID,
            &second_document,
            &original_bytes,
            &second_flattened,
            true,
        )
        .expect("replace known synced local project");
        assert_eq!(inspect_revision(&local_projects, ID), Some(2));
        assert_eq!(
            fs::read(local_captures.join(format!("{ID}.png"))).unwrap(),
            second_flattened
        );

        let before = fs::read(local_projects.join(format!("{ID}.json"))).unwrap();
        let mut tampered = second_flattened.clone();
        tampered.push(0);
        assert!(install_remote_revision(
            &local_projects,
            &local_captures,
            &local_originals,
            ID,
            &second_document,
            &original_bytes,
            &tampered,
            true,
        )
        .is_err());
        assert_eq!(
            fs::read(local_projects.join(format!("{ID}.json"))).unwrap(),
            before
        );
    }
}
