use crate::{
    annotation_project::{self, AnnotationCrop, AnnotationMark, ImageTransform},
    annotation_sync::{self, AnnotationSyncCandidate},
    clipboard::ClipboardStatus,
    overlay::{self, OverlaySource, OverlayStatus},
    queue::QueueRuntime,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::GenericImageView;
#[cfg(target_os = "macos")]
use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType, CGMouseButton};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::{mpsc, Arc};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub(crate) const ANNOTATION_LABEL: &str = "annotation-editor";
const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";
const MAX_FLATTENED_BYTES: usize = 25 * 1_024 * 1_024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnnotationTool {
    Arrow,
    Line,
    Box,
    Ellipse,
    Text,
    Pencil,
    Highlighter,
    Counter,
    Spotlight,
    Blur,
    BlurEffect,
    Crop,
    Transform,
    Resize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationCapture {
    id: String,
    path: String,
    source_path: String,
    presentation_id: u64,
    session_id: u64,
    document_revision: u64,
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
    marks: Vec<AnnotationMark>,
    editing_existing: bool,
}

#[derive(Clone, Debug)]
struct AnnotationSession {
    capture: AnnotationCapture,
    saving: bool,
    dragging: bool,
    pixels_committed: bool,
}

#[derive(Debug, Default)]
pub(crate) struct AnnotationRuntime {
    current: Option<AnnotationSession>,
    generation: u64,
}

impl AnnotationRuntime {
    pub(crate) fn begin(
        &mut self,
        id: String,
        path: String,
        presentation_id: u64,
    ) -> Result<AnnotationCapture, String> {
        if self.current.is_some() {
            return Err("Another capture is already open in the annotation editor.".into());
        }
        self.generation = self
            .generation
            .checked_add(1)
            .expect("annotation session generation cannot exhaust u64");
        let capture = AnnotationCapture {
            id,
            source_path: path.clone(),
            path,
            presentation_id,
            session_id: self.generation,
            document_revision: 0,
            crop: None,
            image_transform: ImageTransform::default(),
            image_scale: 1.0,
            marks: Vec::new(),
            editing_existing: false,
        };
        self.current = Some(AnnotationSession {
            capture: capture.clone(),
            saving: false,
            dragging: false,
            pixels_committed: false,
        });
        Ok(capture)
    }

    fn begin_existing(
        &mut self,
        id: String,
        path: String,
        source_path: String,
        revision: u64,
        crop: Option<AnnotationCrop>,
        image_transform: ImageTransform,
        image_scale: f64,
        marks: Vec<AnnotationMark>,
    ) -> Result<AnnotationCapture, String> {
        if self.current.is_some() {
            return Err("Another capture is already open in the annotation editor.".into());
        }
        self.generation = self
            .generation
            .checked_add(1)
            .expect("annotation session generation cannot exhaust u64");
        let capture = AnnotationCapture {
            id,
            path,
            source_path,
            presentation_id: 0,
            session_id: self.generation,
            document_revision: revision,
            crop,
            image_transform,
            image_scale,
            marks,
            editing_existing: true,
        };
        self.current = Some(AnnotationSession {
            capture: capture.clone(),
            saving: false,
            dragging: false,
            pixels_committed: false,
        });
        Ok(capture)
    }

    fn exact(&self, path: &str, presentation_id: u64, session_id: u64) -> bool {
        self.current.as_ref().is_some_and(|session| {
            session.capture.path == path
                && session.capture.presentation_id == presentation_id
                && session.capture.session_id == session_id
        })
    }

    fn begin_save(
        &mut self,
        path: &str,
        presentation_id: u64,
        session_id: u64,
        document_revision: u64,
    ) -> Result<AnnotationCapture, String> {
        if !self.exact(path, presentation_id, session_id) {
            return Err("That annotation session is no longer active.".into());
        }
        let session = self.current.as_mut().expect("exact session exists");
        if session.capture.document_revision != document_revision {
            return Err("That editable annotation revision is no longer active.".into());
        }
        if session.saving || session.dragging {
            return Err("Wait for the active annotation action to finish.".into());
        }
        session.saving = true;
        Ok(session.capture.clone())
    }

    fn begin_drag(
        &mut self,
        path: &str,
        presentation_id: u64,
        session_id: u64,
    ) -> Result<AnnotationCapture, String> {
        if !self.exact(path, presentation_id, session_id) {
            return Err("That annotation session is no longer active.".into());
        }
        let session = self.current.as_mut().expect("exact session exists");
        if session.saving || session.dragging || session.pixels_committed {
            return Err("Wait for the active annotation action to finish.".into());
        }
        session.dragging = true;
        Ok(session.capture.clone())
    }

    fn finish_drag(&mut self, session_id: u64) -> bool {
        let Some(session) = self
            .current
            .as_mut()
            .filter(|session| session.capture.session_id == session_id && session.dragging)
        else {
            return false;
        };
        session.dragging = false;
        true
    }

    fn save_failed(&mut self, session_id: u64) {
        if let Some(session) = self
            .current
            .as_mut()
            .filter(|session| session.capture.session_id == session_id)
        {
            session.saving = false;
        }
    }

    fn pixels_committed(&mut self, session_id: u64) {
        if let Some(session) = self
            .current
            .as_mut()
            .filter(|session| session.capture.session_id == session_id)
        {
            session.pixels_committed = true;
        }
    }

    fn finish(&mut self, session_id: u64) -> Option<AnnotationCapture> {
        if self
            .current
            .as_ref()
            .is_some_and(|session| session.capture.session_id == session_id)
        {
            self.current.take().map(|session| session.capture)
        } else {
            None
        }
    }

    pub(crate) fn protects_overlay(&self, path: &str, _presentation_id: u64) -> bool {
        self.current
            .as_ref()
            .is_some_and(|session| session.capture.path == path)
    }

    pub(crate) fn is_active(&self) -> bool {
        self.current.is_some()
    }

    pub(crate) fn is_editing_capture(&self, capture_id: &str) -> bool {
        self.current
            .as_ref()
            .is_some_and(|session| session.capture.id == capture_id)
    }

    fn window_close_disposition(&self) -> WindowCloseDisposition {
        match self.current.as_ref() {
            Some(session) if session.saving || session.dragging || session.pixels_committed => {
                WindowCloseDisposition::KeepOpen
            }
            Some(session) => WindowCloseDisposition::Cancel(session.capture.clone()),
            None => WindowCloseDisposition::Hide,
        }
    }
}

#[derive(Debug, PartialEq)]
enum WindowCloseDisposition {
    Hide,
    KeepOpen,
    Cancel(AnnotationCapture),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSaveRequest {
    path: String,
    presentation_id: u64,
    session_id: u64,
    png_data_url: String,
    tools_used: Vec<AnnotationTool>,
    redacted: bool,
    document_revision: u64,
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
    marks: Vec<AnnotationMark>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSaveResult {
    bytes: u64,
    original_path: String,
    clipboard: ClipboardStatus,
    overlay: Option<OverlayStatus>,
    tools_used: Vec<AnnotationTool>,
    redacted: bool,
    document_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationDragRequest {
    path: String,
    presentation_id: u64,
    session_id: u64,
    png_data_url: String,
    filename: String,
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationExportRequest {
    path: String,
    presentation_id: u64,
    session_id: u64,
    png_data_url: String,
    destination: String,
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationExportResult {
    destination: String,
    bytes: u64,
    format: overlay::CaptureExportFormat,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationCopyRequest {
    path: String,
    presentation_id: u64,
    session_id: u64,
    png_data_url: String,
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationCopyResult {
    bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AnnotationDragOutcome {
    Dropped,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationDragEnded {
    session_id: u64,
    outcome: AnnotationDragOutcome,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationDragStarted {
    bytes: u64,
}

#[derive(Debug, Eq, PartialEq)]
struct FlattenedCapture {
    bytes: u64,
    original_path: PathBuf,
}

#[derive(Debug)]
struct PersistFlattenedError {
    message: String,
    pixels_committed: bool,
}

#[derive(Debug)]
struct AtomicWriteError {
    message: String,
    commit_visible: bool,
}

fn decode_png_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .strip_prefix(PNG_DATA_URL_PREFIX)
        .ok_or_else(|| "The editor did not provide a flattened PNG.".to_string())?;
    if encoded.len() > MAX_FLATTENED_BYTES.saturating_mul(4) / 3 + 8 {
        return Err("The flattened annotation is too large to store safely.".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "The editor produced an invalid flattened PNG.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_FLATTENED_BYTES {
        return Err("The flattened annotation is outside Capso's size limit.".into());
    }
    Ok(bytes)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync Capso's annotation directory: {error}"))
}

fn sync_original_hierarchy_with<S>(
    original_path: &Path,
    originals_directory: &Path,
    mut sync: S,
) -> Result<(), String>
where
    S: FnMut(&Path) -> Result<(), String>,
{
    if original_path.parent() != Some(originals_directory) {
        return Err("The protected original is outside Capso's original store.".into());
    }
    let directory_metadata = fs::symlink_metadata(originals_directory)
        .map_err(|error| format!("Could not inspect Capso's original store: {error}"))?;
    if !directory_metadata.file_type().is_dir() {
        return Err("Capso's original store is not a direct directory.".into());
    }
    let original_metadata = fs::symlink_metadata(original_path)
        .map_err(|error| format!("Could not inspect the protected original: {error}"))?;
    if !original_metadata.file_type().is_file() || original_metadata.len() == 0 {
        return Err("The protected original is not a non-empty direct file.".into());
    }
    File::open(original_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Could not sync the protected original: {error}"))?;
    let ancestor = originals_directory
        .parent()
        .ok_or_else(|| "Capso's original store has no durable parent.".to_string())?;
    sync(ancestor)?;
    sync(originals_directory)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AtomicWriteError> {
    atomic_write_with_sync(path, bytes, sync_directory)
}

fn atomic_write_with_sync<S>(path: &Path, bytes: &[u8], mut sync: S) -> Result<(), AtomicWriteError>
where
    S: FnMut(&Path) -> Result<(), String>,
{
    let parent = path.parent().ok_or_else(|| AtomicWriteError {
        message: "The annotation path has no parent directory.".into(),
        commit_visible: false,
    })?;
    let parent_created = match fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_dir() => false,
        Ok(_) => {
            return Err(AtomicWriteError {
                message: "Capso's annotation directory is not a direct directory.".into(),
                commit_visible: false,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(parent).map_err(|error| AtomicWriteError {
                message: format!("Could not create Capso's annotation directory: {error}"),
                commit_visible: false,
            })?;
            true
        }
        Err(error) => {
            return Err(AtomicWriteError {
                message: format!("Could not inspect Capso's annotation directory: {error}"),
                commit_visible: false,
            });
        }
    };
    if parent_created {
        let ancestor = parent.parent().ok_or_else(|| AtomicWriteError {
            message: "Capso's annotation directory has no durable parent.".into(),
            commit_visible: false,
        })?;
        sync(ancestor).map_err(|message| AtomicWriteError {
            message,
            commit_visible: false,
        })?;
    }
    let temporary = parent.join(format!(".capso-annotation-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), AtomicWriteError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| AtomicWriteError {
                message: format!("Could not reserve Capso's annotation update: {error}"),
                commit_visible: false,
            })?;
        file.write_all(bytes).map_err(|error| AtomicWriteError {
            message: format!("Could not write Capso's flattened annotation: {error}"),
            commit_visible: false,
        })?;
        file.sync_all().map_err(|error| AtomicWriteError {
            message: format!("Could not sync Capso's flattened annotation: {error}"),
            commit_visible: false,
        })?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| AtomicWriteError {
            message: format!("Could not commit Capso's flattened annotation: {error}"),
            commit_visible: false,
        })?;
        sync(parent).map_err(|message| AtomicWriteError {
            message,
            commit_visible: true,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_direct_png(path: &Path, expected_parent: &Path) -> Result<(), String> {
    if path.parent() != Some(expected_parent)
        || path.extension().and_then(|extension| extension.to_str()) != Some("png")
        || !path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|id| {
                uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
            })
    {
        return Err("The annotation target is outside Capso's protected capture directory.".into());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the annotation target: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err("The annotation target is no longer a regular PNG file.".into());
    }
    Ok(())
}

#[cfg(test)]
fn persist_flattened_png(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
) -> Result<FlattenedCapture, PersistFlattenedError> {
    persist_flattened_png_with_crop_and_hierarchy_sync(
        source,
        capture_directory,
        originals_directory,
        flattened,
        None,
        ImageTransform::default(),
        1.0,
        sync_directory,
    )
}

#[cfg(test)]
fn persist_flattened_png_with_crop(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
    crop: Option<AnnotationCrop>,
) -> Result<FlattenedCapture, PersistFlattenedError> {
    persist_flattened_png_with_crop_and_hierarchy_sync(
        source,
        capture_directory,
        originals_directory,
        flattened,
        crop,
        ImageTransform::default(),
        1.0,
        sync_directory,
    )
}

#[cfg(test)]
fn persist_flattened_png_with_crop_and_transform(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
) -> Result<FlattenedCapture, PersistFlattenedError> {
    persist_flattened_png_with_crop_and_hierarchy_sync(
        source,
        capture_directory,
        originals_directory,
        flattened,
        crop,
        image_transform,
        1.0,
        sync_directory,
    )
}

fn persist_flattened_png_with_crop_transform_and_scale(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
) -> Result<FlattenedCapture, PersistFlattenedError> {
    persist_flattened_png_with_crop_and_hierarchy_sync(
        source,
        capture_directory,
        originals_directory,
        flattened,
        crop,
        image_transform,
        image_scale,
        sync_directory,
    )
}

#[cfg(test)]
fn persist_flattened_png_with_hierarchy_sync<S>(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
    sync_hierarchy: S,
) -> Result<FlattenedCapture, PersistFlattenedError>
where
    S: FnMut(&Path) -> Result<(), String>,
{
    persist_flattened_png_with_crop_and_hierarchy_sync(
        source,
        capture_directory,
        originals_directory,
        flattened,
        None,
        ImageTransform::default(),
        1.0,
        sync_hierarchy,
    )
}

fn persist_flattened_png_with_crop_and_hierarchy_sync<S>(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
    mut sync_hierarchy: S,
) -> Result<FlattenedCapture, PersistFlattenedError>
where
    S: FnMut(&Path) -> Result<(), String>,
{
    validate_direct_png(source, capture_directory).map_err(|message| PersistFlattenedError {
        message,
        pixels_committed: false,
    })?;
    let source_image = image::open(source).map_err(|error| PersistFlattenedError {
        message: format!("Could not decode the original capture: {error}"),
        pixels_committed: false,
    })?;
    let flattened_image = image::load_from_memory_with_format(flattened, image::ImageFormat::Png)
        .map_err(|error| PersistFlattenedError {
        message: format!("Could not decode the flattened annotation: {error}"),
        pixels_committed: false,
    })?;
    let file_name = source.file_name().ok_or_else(|| PersistFlattenedError {
        message: "The capture filename is invalid.".into(),
        pixels_committed: false,
    })?;
    let original_path = originals_directory.join(file_name);
    let original_exists = original_path.exists();
    let original_dimensions = if original_exists {
        let metadata =
            fs::symlink_metadata(&original_path).map_err(|error| PersistFlattenedError {
                message: format!("Could not inspect the preserved original: {error}"),
                pixels_committed: false,
            })?;
        let original_image = image::open(&original_path).map_err(|_| PersistFlattenedError {
            message: "The preserved original is unavailable or invalid.".into(),
            pixels_committed: false,
        })?;
        if !metadata.file_type().is_file() {
            return Err(PersistFlattenedError {
                message: "The preserved original is unavailable or invalid.".into(),
                pixels_committed: false,
            });
        }
        original_image.dimensions()
    } else {
        source_image.dimensions()
    };

    let source_output_dimensions = match crop {
        Some(crop)
            if crop.w >= 16
                && crop.h >= 16
                && crop
                    .x
                    .checked_add(crop.w)
                    .is_some_and(|right| right <= original_dimensions.0)
                && crop
                    .y
                    .checked_add(crop.h)
                    .is_some_and(|bottom| bottom <= original_dimensions.1) =>
        {
            (crop.w, crop.h)
        }
        Some(_) => {
            return Err(PersistFlattenedError {
                message: "The annotation crop is outside the protected original.".into(),
                pixels_committed: false,
            })
        }
        None => original_dimensions,
    };
    let expected_dimensions = annotation_project::scaled_output_dimensions(
        source_output_dimensions.0,
        source_output_dimensions.1,
        image_transform,
        image_scale,
    );
    if Some(flattened_image.dimensions()) != expected_dimensions {
        return Err(PersistFlattenedError {
            message: "The flattened annotation dimensions do not match its crop, orientation and resolution."
                .into(),
            pixels_committed: false,
        });
    }

    if !original_exists {
        let source_bytes = fs::read(source).map_err(|error| PersistFlattenedError {
            message: format!("Could not read the original capture: {error}"),
            pixels_committed: false,
        })?;
        atomic_write(&original_path, &source_bytes).map_err(|error| PersistFlattenedError {
            message: error.message,
            pixels_committed: false,
        })?;
    }

    sync_original_hierarchy_with(&original_path, originals_directory, &mut sync_hierarchy)
        .map_err(|message| PersistFlattenedError {
            message,
            pixels_committed: false,
        })?;

    atomic_write(source, flattened).map_err(|error| PersistFlattenedError {
        message: error.message,
        pixels_committed: error.commit_visible,
    })?;
    Ok(FlattenedCapture {
        bytes: flattened.len() as u64,
        original_path,
    })
}

fn validated_tools(
    tools: Vec<AnnotationTool>,
    redacted: bool,
) -> Result<Vec<AnnotationTool>, String> {
    if tools.is_empty() {
        return Err(
            "Add an arrow, line, shape, label, freehand mark, counter, focus, or blur before saving.".into(),
        );
    }
    let unique = tools.iter().copied().collect::<HashSet<_>>();
    if unique.len() != tools.len() {
        return Err("The annotation tool record contains duplicates.".into());
    }
    let has_privacy_tool =
        unique.contains(&AnnotationTool::Blur) || unique.contains(&AnnotationTool::BlurEffect);
    if (redacted && !has_privacy_tool) || (!redacted && unique.contains(&AnnotationTool::Blur)) {
        return Err("The blur privacy record does not match the flattened annotation.".into());
    }
    Ok(tools)
}

fn validated_project_marks(
    marks: Vec<AnnotationMark>,
    tools: &[AnnotationTool],
    redacted: bool,
    cropped: bool,
    transformed: bool,
    resized: bool,
) -> Result<Vec<AnnotationMark>, String> {
    annotation_project::validate_marks(&marks)?;
    let mark_tools = marks
        .iter()
        .map(|mark| match mark {
            AnnotationMark::Arrow { .. } => AnnotationTool::Arrow,
            AnnotationMark::Line { .. } => AnnotationTool::Line,
            AnnotationMark::Box { .. } => AnnotationTool::Box,
            AnnotationMark::Ellipse { .. } => AnnotationTool::Ellipse,
            AnnotationMark::Text { .. } => AnnotationTool::Text,
            AnnotationMark::Pencil { .. } => AnnotationTool::Pencil,
            AnnotationMark::Highlighter { .. } => AnnotationTool::Highlighter,
            AnnotationMark::Counter { .. } => AnnotationTool::Counter,
            AnnotationMark::Spotlight { .. } => AnnotationTool::Spotlight,
            AnnotationMark::Blur { .. } => AnnotationTool::Blur,
            AnnotationMark::BlurEffect { .. } => AnnotationTool::BlurEffect,
        })
        .collect::<HashSet<_>>();
    let recorded_tools = tools
        .iter()
        .copied()
        .filter(|tool| {
            *tool != AnnotationTool::Crop
                && *tool != AnnotationTool::Transform
                && *tool != AnnotationTool::Resize
        })
        .collect::<HashSet<_>>();
    let project_redacts = marks.iter().any(|mark| match mark {
        AnnotationMark::Blur { .. } => true,
        AnnotationMark::BlurEffect { blur_mode, .. } => {
            *blur_mode == annotation_project::BlurMode::Secure
        }
        _ => false,
    });
    if mark_tools != recorded_tools || redacted != project_redacts {
        return Err("The editable annotation marks do not match the flattened tool record.".into());
    }
    if cropped != tools.contains(&AnnotationTool::Crop)
        || transformed != tools.contains(&AnnotationTool::Transform)
        || resized != tools.contains(&AnnotationTool::Resize)
        || (marks.is_empty() && !cropped && !transformed && !resized)
    {
        return Err(
            "The editable annotation crop, orientation or resolution does not match the flattened tool record."
                .into(),
        );
    }
    Ok(marks)
}

fn release_queue_reservation(app: &AppHandle, id: &str) {
    if let Ok(mut queue) = app.state::<Mutex<QueueRuntime>>().lock() {
        queue.cancel_annotation(id);
    }
}

fn rollback_open(app: &AppHandle, capture: &AnnotationCapture) {
    if let Ok(mut runtime) = app.state::<Mutex<AnnotationRuntime>>().lock() {
        let _ = runtime.finish(capture.session_id);
    }
    if let Some(window) = app.get_webview_window(ANNOTATION_LABEL) {
        let _ = window.hide();
    }
    if !capture.editing_existing {
        release_queue_reservation(app, &capture.id);
        let _ = overlay::restore_after_annotation(app, &capture.path, capture.presentation_id);
    }
}

fn show_annotation_editor(app: &AppHandle, capture: &AnnotationCapture) -> Result<(), String> {
    let Some(window) = app.get_webview_window(ANNOTATION_LABEL) else {
        return Err("The annotation editor window is unavailable.".into());
    };
    app.emit_to(ANNOTATION_LABEL, "annotation-capture", capture.clone())
        .map_err(|error| format!("Could not load the annotation editor: {error}"))?;
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| format!("Could not show the annotation editor: {error}"))
}

#[tauri::command]
pub(crate) fn open_annotation_editor(
    app: AppHandle,
    state: State<'_, Mutex<AnnotationRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<AnnotationCapture, String> {
    if crate::capture::is_capture_in_progress() {
        return Err("Wait for the active capture picker before opening Annotate.".into());
    }
    let (source_path, source) = {
        let overlay = app.state::<Mutex<overlay::OverlayRuntime>>();
        let overlay = overlay
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        overlay::annotation_candidate(&overlay, &path, presentation_id)?
    };
    if source != OverlaySource::Capture {
        return Err("Only a fresh capture can be edited before its first upload.".into());
    }
    let id = {
        let queue = app.state::<Mutex<QueueRuntime>>();
        let mut queue = queue
            .lock()
            .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?;
        queue.begin_annotation(&source_path)?
    };
    let capture = match state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .begin(id.clone(), path.clone(), presentation_id)
    {
        Ok(capture) => capture,
        Err(error) => {
            release_queue_reservation(&app, &id);
            return Err(error);
        }
    };

    if crate::capture::is_capture_in_progress() {
        rollback_open(&app, &capture);
        return Err("A capture picker started before Annotate could open. Try again.".into());
    }

    if let Err(error) = overlay::hide_for_annotation(&app, &path, presentation_id) {
        rollback_open(&app, &capture);
        return Err(error);
    }
    if let Err(error) = show_annotation_editor(&app, &capture) {
        rollback_open(&app, &capture);
        return Err(error);
    }
    Ok(capture)
}

#[tauri::command]
pub(crate) fn open_history_annotation_editor(
    app: AppHandle,
    state: State<'_, Mutex<AnnotationRuntime>>,
    id: String,
) -> Result<AnnotationCapture, String> {
    if crate::capture::is_capture_in_progress() {
        return Err("Wait for the active capture picker before reopening an annotation.".into());
    }
    let capture = crate::history::resolve_recent_capture_for_app(&app, &id)?;
    let originals_directory = app
        .path()
        .app_data_dir()
        .map(|directory| directory.join("capture-originals"))
        .map_err(|error| format!("Could not locate Capso's original capture store: {error}"))?;
    let original_path = originals_directory.join(format!("{}.png", capture.id));
    let projects_directory = annotation_project::project_directory(&app)?;
    let project = annotation_project::load_optional_for_capture(
        &projects_directory,
        &capture.path,
        &original_path,
    )?;
    let (source_path, revision, crop, image_transform, image_scale, marks) = match project {
        Some(project) => (
            original_path,
            project.revision,
            project.crop,
            project.image_transform,
            project.image_scale,
            project.marks,
        ),
        None => (
            capture.path.clone(),
            0,
            None,
            ImageTransform::default(),
            1.0,
            Vec::new(),
        ),
    };
    let editor_capture = state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .begin_existing(
            capture.id,
            capture.path.to_string_lossy().into_owned(),
            source_path.to_string_lossy().into_owned(),
            revision,
            crop,
            image_transform,
            image_scale,
            marks,
        )?;
    if let Err(error) = show_annotation_editor(&app, &editor_capture) {
        rollback_open(&app, &editor_capture);
        return Err(error);
    }
    Ok(editor_capture)
}

#[tauri::command]
pub(crate) fn get_annotation_capture(
    state: State<'_, Mutex<AnnotationRuntime>>,
) -> Result<Option<AnnotationCapture>, String> {
    state
        .lock()
        .map(|runtime| {
            runtime
                .current
                .as_ref()
                .map(|session| session.capture.clone())
        })
        .map_err(|_| "The annotation editor state is temporarily unavailable.".into())
}

#[tauri::command]
pub(crate) fn cancel_annotation_editor(
    app: AppHandle,
    state: State<'_, Mutex<AnnotationRuntime>>,
    path: String,
    presentation_id: u64,
    session_id: u64,
) -> Result<bool, String> {
    let capture = {
        let runtime = state
            .lock()
            .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?;
        if !runtime.exact(&path, presentation_id, session_id) {
            return Ok(false);
        }
        if runtime
            .current
            .as_ref()
            .is_some_and(|session| session.saving || session.dragging)
        {
            return Err("Wait for the active annotation action to finish.".into());
        }
        if runtime
            .current
            .as_ref()
            .is_some_and(|session| session.pixels_committed)
        {
            let suffix = if runtime
                .current
                .as_ref()
                .is_some_and(|session| session.capture.editing_existing)
            {
                "finish its editable project"
            } else {
                "finish its upload record"
            };
            return Err(format!(
                "The flattened image is safe locally. Press Save & copy again to {suffix}."
            ));
        }
        runtime
            .current
            .as_ref()
            .expect("exact session exists")
            .capture
            .clone()
    };
    let window = app
        .get_webview_window(ANNOTATION_LABEL)
        .ok_or_else(|| "The annotation editor window is unavailable.".to_string())?;
    window
        .hide()
        .map_err(|error| format!("Could not close the annotation editor: {error}"))?;
    if !capture.editing_existing {
        if let Err(error) =
            overlay::refresh_after_annotation(&app, &capture.path, capture.presentation_id, None)
        {
            let _ = window.show().and_then(|_| window.set_focus());
            return Err(format!("Could not restore Quick Access: {error}"));
        }
    }
    state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .finish(session_id)
        .ok_or_else(|| "That annotation session is no longer active.".to_string())?;
    if !capture.editing_existing {
        release_queue_reservation(&app, &capture.id);
    }
    Ok(true)
}

fn validate_annotation_drag_pixels(
    capture: &AnnotationCapture,
    flattened: &[u8],
    crop: Option<AnnotationCrop>,
    image_transform: ImageTransform,
    image_scale: f64,
) -> Result<(), String> {
    let source = Path::new(&capture.source_path);
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect the protected annotation source: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err("The protected annotation source is no longer a regular image.".into());
    }
    let source_dimensions = image::open(source)
        .map_err(|_| "The protected annotation source is no longer a readable image.".to_string())?
        .dimensions();
    let viewport = match crop {
        Some(crop)
            if crop.w >= 16
                && crop.h >= 16
                && crop
                    .x
                    .checked_add(crop.w)
                    .is_some_and(|right| right <= source_dimensions.0)
                && crop
                    .y
                    .checked_add(crop.h)
                    .is_some_and(|bottom| bottom <= source_dimensions.1) =>
        {
            (crop.w, crop.h)
        }
        Some(_) => return Err("The annotation drag crop is outside the protected source.".into()),
        None => source_dimensions,
    };
    let expected = annotation_project::scaled_output_dimensions(
        viewport.0,
        viewport.1,
        image_transform,
        image_scale,
    )
    .ok_or_else(|| "The annotation drag dimensions are outside Capso's safe limit.".to_string())?;
    let actual = image::load_from_memory_with_format(flattened, image::ImageFormat::Png)
        .map_err(|_| "The annotation drag did not contain a readable PNG.".to_string())?
        .dimensions();
    if actual != expected {
        return Err(
            "The annotation drag pixels do not match the current crop, orientation and resolution."
                .into(),
        );
    }
    Ok(())
}

fn validate_annotation_export_destination(
    app_data: &Path,
    destination: &Path,
) -> Result<(), String> {
    if !destination.is_absolute() {
        return Err("Choose an absolute destination outside Capso's private storage.".into());
    }
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "Choose a destination inside a direct local directory.".to_string())?;
    let app_data = fs::canonicalize(app_data)
        .map_err(|error| format!("Could not verify Capso's private storage: {error}"))?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not verify the export destination: {error}"))?;
    if parent.starts_with(&app_data) {
        return Err(
            "Choose a destination outside Capso's private storage to protect originals and history."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn export_annotation_copy(
    app: AppHandle,
    state: State<'_, Mutex<AnnotationRuntime>>,
    request: AnnotationExportRequest,
) -> Result<AnnotationExportResult, String> {
    let AnnotationExportRequest {
        path,
        presentation_id,
        session_id,
        png_data_url,
        destination,
        crop,
        image_transform,
        image_scale,
    } = request;
    let destination_path = PathBuf::from(&destination);
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's private storage: {error}"))?;
    validate_annotation_export_destination(&app_data, &destination_path)?;
    let capture = state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .begin_drag(&path, presentation_id, session_id)?;

    let result = tauri::async_runtime::spawn_blocking(move || {
        let flattened = decode_png_data_url(&png_data_url)?;
        validate_annotation_drag_pixels(&capture, &flattened, crop, image_transform, image_scale)?;
        let exported = overlay::export_png_bytes(&flattened, &destination_path)
            .map_err(|error| format!("Could not export the annotated image: {error}"))?;
        Ok(AnnotationExportResult {
            destination,
            bytes: exported.bytes,
            format: exported.format,
        })
    })
    .await
    .map_err(|error| format!("The annotation export task stopped unexpectedly: {error}"))
    .and_then(|result| result);

    if let Ok(mut runtime) = state.lock() {
        let _ = runtime.finish_drag(session_id);
    }
    result
}

#[tauri::command]
pub(crate) async fn copy_annotation_image(
    app: AppHandle,
    state: State<'_, Mutex<AnnotationRuntime>>,
    request: AnnotationCopyRequest,
) -> Result<AnnotationCopyResult, String> {
    let AnnotationCopyRequest {
        path,
        presentation_id,
        session_id,
        png_data_url,
        crop,
        image_transform,
        image_scale,
    } = request;
    let capture = state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .begin_drag(&path, presentation_id, session_id)?;
    let current_path = PathBuf::from(&capture.path);

    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let flattened = decode_png_data_url(&png_data_url)?;
        validate_annotation_drag_pixels(&capture, &flattened, crop, image_transform, image_scale)?;
        Ok::<_, String>(flattened)
    })
    .await
    .map_err(|error| format!("The annotation copy task stopped unexpectedly: {error}"))
    .and_then(|result| result);
    let result = match prepared {
        Ok(flattened) => {
            match crate::clipboard::recopy_current_png_bytes_to_general_pasteboard(
                app,
                current_path,
                flattened,
            )
            .await
            {
                ClipboardStatus::Copied { bytes } => Ok(AnnotationCopyResult { bytes }),
                status => Err(status.user_message()),
            }
        }
        Err(error) => Err(error),
    };

    if let Ok(mut runtime) = state.lock() {
        let _ = runtime.finish_drag(session_id);
    }
    result
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AnnotationDragGestureState {
    left_button_is_down: bool,
    left_mouse_down_counter: u32,
}

#[cfg(target_os = "macos")]
fn current_annotation_drag_gesture_state() -> AnnotationDragGestureState {
    let state_id = CGEventSourceStateID::CombinedSessionState;
    AnnotationDragGestureState {
        left_button_is_down: CGEventSource::button_state(state_id, CGMouseButton::Left),
        left_mouse_down_counter: CGEventSource::counter_for_event_type(
            state_id,
            CGEventType::LeftMouseDown,
        ),
    }
}

#[cfg(target_os = "macos")]
fn begin_native_annotation_drag(
    app: &AppHandle,
    window: &WebviewWindow,
    session_id: u64,
    artifact: crate::dragout::PreparedDragArtifact,
) -> Result<(), String> {
    let export_path = artifact.export_path.clone();
    let preview_png = artifact.preview_png.clone();
    let artifact_owner = Arc::new(Mutex::new(Some(artifact)));
    let callback_owner = Arc::clone(&artifact_owner);
    let callback_app = app.clone();
    let result = drag::start_drag(
        window,
        drag::DragItem::Files(vec![export_path]),
        drag::Image::Raw(preview_png),
        move |result, _cursor| {
            let outcome = match result {
                drag::DragResult::Dropped => AnnotationDragOutcome::Dropped,
                drag::DragResult::Cancel => AnnotationDragOutcome::Cancelled,
            };
            if let Ok(mut owner) = callback_owner.lock() {
                if let Some(artifact) = owner.take() {
                    if outcome == AnnotationDragOutcome::Dropped {
                        artifact.retain();
                    }
                }
            }
            let finished = callback_app
                .state::<Mutex<AnnotationRuntime>>()
                .lock()
                .map(|mut runtime| runtime.finish_drag(session_id))
                .unwrap_or(false);
            if finished {
                let _ = callback_app.emit_to(
                    ANNOTATION_LABEL,
                    "annotation-drag-ended",
                    AnnotationDragEnded {
                        session_id,
                        outcome,
                    },
                );
            }
        },
        drag::Options {
            mode: drag::DragMode::Copy,
            ..drag::Options::default()
        },
    );
    if let Err(error) = result {
        if let Ok(mut runtime) = app.state::<Mutex<AnnotationRuntime>>().lock() {
            let _ = runtime.finish_drag(session_id);
        }
        if let Ok(mut owner) = artifact_owner.lock() {
            let _ = owner.take();
        }
        return Err(format!(
            "Could not start the macOS annotation drag: {error}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_annotation_drag(
    app: AppHandle,
    state: State<'_, Mutex<AnnotationRuntime>>,
    request: AnnotationDragRequest,
) -> Result<AnnotationDragStarted, String> {
    let AnnotationDragRequest {
        path,
        presentation_id,
        session_id,
        png_data_url,
        filename,
        crop,
        image_transform,
        image_scale,
    } = request;

    #[cfg(target_os = "macos")]
    {
        let initial_gesture = current_annotation_drag_gesture_state();
        if !initial_gesture.left_button_is_down {
            return Err("Keep holding Drag me until the macOS drag starts.".into());
        }
        let capture = state
            .lock()
            .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
            .begin_drag(&path, presentation_id, session_id)?;

        let result = async {
            let flattened = decode_png_data_url(&png_data_url)?;
            validate_annotation_drag_pixels(
                &capture,
                &flattened,
                crop,
                image_transform,
                image_scale,
            )?;
            let export_root = app
                .path()
                .app_cache_dir()
                .map(|directory| directory.join("drag-exports"))
                .map_err(|error| format!("Could not locate Capso's drag cache: {error}"))?;
            let artifact = tauri::async_runtime::spawn_blocking(move || {
                crate::dragout::prepare_drag_bytes(&export_root, &flattened, &filename)
            })
            .await
            .map_err(|error| format!("The annotation drag task stopped unexpectedly: {error}"))??;
            let bytes = artifact.bytes;
            let window = app
                .get_webview_window(ANNOTATION_LABEL)
                .ok_or_else(|| "The annotation editor window is unavailable.".to_string())?;
            let (sender, receiver) = mpsc::sync_channel(1);
            let start_app = app.clone();
            app.run_on_main_thread(move || {
                let current_gesture = current_annotation_drag_gesture_state();
                let result = if current_gesture.left_button_is_down
                    && current_gesture.left_mouse_down_counter
                        == initial_gesture.left_mouse_down_counter
                {
                    begin_native_annotation_drag(&start_app, &window, session_id, artifact)
                } else {
                    Err("The original pointer gesture ended before the annotation drag could start."
                        .into())
                };
                let _ = sender.send(result);
            })
            .map_err(|error| format!("Could not schedule the macOS annotation drag: {error}"))?;
            tauri::async_runtime::spawn_blocking(move || receiver.recv())
                .await
                .map_err(|error| {
                    format!("The annotation drag start task stopped unexpectedly: {error}")
                })?
                .map_err(|error| format!("The annotation drag did not start: {error}"))??;
            Ok(AnnotationDragStarted { bytes })
        }
        .await;
        if result.is_err() {
            if let Ok(mut runtime) = state.lock() {
                let _ = runtime.finish_drag(session_id);
            }
        }
        result
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            state,
            path,
            presentation_id,
            session_id,
            png_data_url,
            filename,
            crop,
            image_transform,
            image_scale,
        );
        Err("Annotation drag-out is only available in the macOS app.".into())
    }
}

#[tauri::command]
pub(crate) async fn save_annotation_editor(
    app: AppHandle,
    state: State<'_, Mutex<AnnotationRuntime>>,
    request: AnnotationSaveRequest,
) -> Result<AnnotationSaveResult, String> {
    let AnnotationSaveRequest {
        path,
        presentation_id,
        session_id,
        png_data_url,
        tools_used,
        redacted,
        document_revision,
        crop,
        image_transform,
        image_scale,
        marks,
    } = request;
    let tools_used = validated_tools(tools_used, redacted)?;
    let marks = validated_project_marks(
        marks,
        &tools_used,
        redacted,
        crop.is_some(),
        !image_transform.is_default(),
        image_scale != 1.0,
    )?;
    let capture_directory = crate::history::capture_directory(&app)?;
    let originals_directory = app
        .path()
        .app_data_dir()
        .map(|directory| directory.join("capture-originals"))
        .map_err(|error| format!("Could not locate Capso's original capture store: {error}"))?;
    let projects_directory = annotation_project::project_directory(&app)?;
    let capture = state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .begin_save(&path, presentation_id, session_id, document_revision)?;
    let flattened = match decode_png_data_url(&png_data_url) {
        Ok(flattened) => flattened,
        Err(error) => {
            if let Ok(mut runtime) = state.lock() {
                runtime.save_failed(session_id);
            }
            return Err(error);
        }
    };
    let source = PathBuf::from(&capture.path);
    let (stored, saved_revision, sync_candidate) = match tauri::async_runtime::spawn_blocking(move || {
        let stored = persist_flattened_png_with_crop_transform_and_scale(
            &source,
            &capture_directory,
            &originals_directory,
            &flattened,
            crop,
            image_transform,
            image_scale,
        )?;
        let project = annotation_project::persist_for_capture_with_transform_and_scale(
            &projects_directory,
            &source,
            &stored.original_path,
            &flattened,
            document_revision,
            crop,
            image_transform,
            image_scale,
            marks,
        )
        .map_err(|message| PersistFlattenedError {
            message: format!("The image is safe locally, but its editable project could not be stored: {message}"),
            pixels_committed: true,
        })?;
        let sync_candidate = AnnotationSyncCandidate {
            capture_id: project.capture_id.clone(),
            document_revision: project.revision,
            mutation_id: uuid::Uuid::new_v4().to_string(),
            project_path: projects_directory.join(format!("{}.json", project.capture_id)),
            flattened_path: source,
            original_path: stored.original_path.clone(),
            original_sha256: project.original_sha256,
            flattened_sha256: project.flattened_sha256,
        };
        Ok::<_, PersistFlattenedError>((stored, project.revision, sync_candidate))
    })
    .await
    {
        Ok(Ok(stored)) => stored,
        Ok(Err(error)) => {
            if let Ok(mut runtime) = state.lock() {
                if error.pixels_committed {
                    runtime.pixels_committed(session_id);
                }
                runtime.save_failed(session_id);
            }
            return Err(error.message);
        }
        Err(error) => {
            if let Ok(mut runtime) = state.lock() {
                runtime.save_failed(session_id);
            }
            return Err(format!(
                "The annotation save task stopped unexpectedly: {error}"
            ));
        }
    };
    if let Ok(mut runtime) = state.lock() {
        runtime.pixels_committed(session_id);
    }
    if let Err(error) = annotation_sync::stage_for_app(&app, sync_candidate) {
        if let Ok(mut runtime) = state.lock() {
            runtime.save_failed(session_id);
        }
        return Err(format!(
            "The image and editable project are safe locally, but their cloud sync could not be queued: {error}"
        ));
    }
    if capture.editing_existing {
        #[cfg(target_os = "macos")]
        crate::spawn_background_sync(app.clone(), crate::drain::DrainWake::AnnotationSaved);
    }

    let clipboard = crate::clipboard::recopy_current_capture_to_general_pasteboard(
        app.clone(),
        PathBuf::from(&capture.path),
    )
    .await;
    let overlay = if capture.editing_existing {
        None
    } else {
        let queue_result = match app.state::<Mutex<QueueRuntime>>().lock() {
            Ok(mut queue) => queue.record_annotation(&capture.id),
            Err(_) => Err("Capso's upload queue is temporarily unavailable.".into()),
        };
        if let Err(error) = queue_result {
            if let Ok(mut runtime) = state.lock() {
                runtime.save_failed(session_id);
            }
            return Err(format!(
                "The image is safe locally, but its upload record could not be updated: {error}"
            ));
        }

        let overlay = match overlay::refresh_after_annotation(
            &app,
            &capture.path,
            capture.presentation_id,
            Some(&clipboard),
        ) {
            Ok(overlay) => overlay,
            Err(error) => {
                if let Ok(mut runtime) = state.lock() {
                    runtime.save_failed(session_id);
                }
                return Err(format!(
                    "The image is safe locally, but Quick Access could not refresh: {error}"
                ));
            }
        };
        let completion = match app.state::<Mutex<QueueRuntime>>().lock() {
            Ok(mut queue) => queue.complete_annotation(&capture.id),
            Err(_) => Err("Capso's upload queue is temporarily unavailable.".into()),
        };
        if let Err(error) = completion {
            if let Ok(mut runtime) = state.lock() {
                runtime.save_failed(session_id);
            }
            return Err(format!(
                "The image is safe locally, but its upload reservation could not be released: {error}"
            ));
        }
        #[cfg(target_os = "macos")]
        crate::spawn_background_sync(app.clone(), crate::drain::DrainWake::CaptureEnqueued);
        Some(overlay)
    };
    let _ = app.emit(
        "annotation-project-saved",
        serde_json::json!({
            "id": capture.id,
            "revision": saved_revision,
        }),
    );
    if let Some(window) = app.get_webview_window(ANNOTATION_LABEL) {
        let _ = window.hide();
    }
    if let Ok(mut runtime) = state.lock() {
        let _ = runtime.finish(session_id);
    }

    Ok(AnnotationSaveResult {
        bytes: stored.bytes,
        original_path: stored.original_path.to_string_lossy().into_owned(),
        clipboard,
        overlay,
        tools_used,
        redacted,
        document_revision: saved_revision,
    })
}

pub(crate) fn is_active(app: &AppHandle) -> bool {
    app.state::<Mutex<AnnotationRuntime>>()
        .lock()
        .map(|runtime| runtime.is_active())
        .unwrap_or(true)
}

pub(crate) fn cancel_from_window_close(app: &AppHandle) -> bool {
    let disposition = match app.state::<Mutex<AnnotationRuntime>>().lock() {
        Ok(runtime) => runtime.window_close_disposition(),
        Err(_) => return false,
    };
    match disposition {
        WindowCloseDisposition::Hide => true,
        WindowCloseDisposition::KeepOpen => false,
        WindowCloseDisposition::Cancel(capture) => {
            if !capture.editing_existing
                && overlay::refresh_after_annotation(
                    app,
                    &capture.path,
                    capture.presentation_id,
                    None,
                )
                .is_err()
            {
                return false;
            }
            let finished = app
                .state::<Mutex<AnnotationRuntime>>()
                .lock()
                .ok()
                .and_then(|mut runtime| runtime.finish(capture.session_id));
            if finished.is_none() {
                return false;
            }
            if !capture.editing_existing {
                release_queue_reservation(app, &capture.id);
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write_with_sync, decode_png_data_url, persist_flattened_png,
        persist_flattened_png_with_crop, persist_flattened_png_with_crop_and_transform,
        persist_flattened_png_with_crop_transform_and_scale,
        persist_flattened_png_with_hierarchy_sync, validate_annotation_drag_pixels,
        validate_annotation_export_destination, validated_tools, AnnotationCapture, AnnotationCrop,
        AnnotationRuntime, AnnotationTool, ImageTransform, WindowCloseDisposition,
        ANNOTATION_LABEL,
    };
    use crate::{
        clipboard::{copy_png_file, ClipboardStatus, ClipboardWriter},
        drain::{
            DrainCoordinator, DrainWake, TransportAvailability, UploadAcknowledgement,
            UploadResult, UploadTransport, WakeResult,
        },
        queue::{DurableUploadQueue, QueueSource},
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::{GenericImageView, ImageBuffer, Rgba};
    use serde::Deserialize;
    use std::{cell::RefCell, fs, path::Path, sync::Mutex};

    const ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";

    #[test]
    fn annotation_export_rejects_capso_app_data_and_accepts_external_directories() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let app_data = directory.path().join("app-data");
        let captures = app_data.join("captures");
        let exports = directory.path().join("exports");
        fs::create_dir_all(&captures).expect("capture directory");
        fs::create_dir_all(&exports).expect("export directory");

        assert!(
            validate_annotation_export_destination(&app_data, &captures.join("protected.png"),)
                .is_err()
        );
        assert!(
            validate_annotation_export_destination(&app_data, &exports.join("Annotated.png"),)
                .is_ok()
        );

        #[cfg(unix)]
        {
            let linked = directory.path().join("linked-app-data");
            std::os::unix::fs::symlink(&app_data, &linked).expect("app-data symlink");
            assert!(validate_annotation_export_destination(
                &app_data,
                &linked.join("through-link.png"),
            )
            .is_err());
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SharedRedactionFixture {
        width: u32,
        height: u32,
        original_rgba: Vec<u8>,
        flattened_rgba: Vec<u8>,
    }

    #[derive(Default)]
    struct ExactClipboard {
        payload: Vec<u8>,
    }

    impl ClipboardWriter for ExactClipboard {
        fn write_png(&mut self, png: &[u8]) -> Result<(), String> {
            self.payload = png.to_vec();
            Ok(())
        }
    }

    struct ExactUploadTransport {
        expected: Vec<u8>,
        uploads: Mutex<Vec<String>>,
    }

    impl UploadTransport for ExactUploadTransport {
        fn availability(&self) -> TransportAvailability {
            TransportAvailability::Ready
        }

        fn upload(&self, item: &crate::queue::QueueItem) -> UploadResult {
            assert!(item.annotated, "the transport must see redaction metadata");
            assert_eq!(
                fs::read(&item.file_path).expect("read transport payload"),
                self.expected,
                "the transport must consume the flattened canonical PNG",
            );
            self.uploads
                .lock()
                .expect("record transport upload")
                .push(item.id.clone());
            UploadResult::Confirmed(UploadAcknowledgement {
                capture_id: item.id.clone(),
            })
        }
    }

    fn png(color: [u8; 4]) -> Vec<u8> {
        png_sized(8, 6, color)
    }

    fn png_sized(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let image = ImageBuffer::from_pixel(width, height, Rgba(color));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("encode fixture PNG");
        bytes
    }

    fn fixture_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
        let image = ImageBuffer::<Rgba<u8>, _>::from_raw(width, height, rgba.to_vec())
            .expect("fixture dimensions match RGBA pixels");
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("encode shared redaction fixture");
        bytes
    }

    fn write_capture(directory: &Path, bytes: &[u8]) -> std::path::PathBuf {
        fs::create_dir_all(directory).expect("create capture directory");
        let path = directory.join(format!("{ID}.png"));
        fs::write(&path, bytes).expect("write capture");
        path
    }

    #[test]
    fn data_url_requires_a_real_bounded_png_payload() {
        let bytes = png([10, 20, 30, 255]);
        let encoded = format!("data:image/png;base64,{}", STANDARD.encode(&bytes));
        assert_eq!(decode_png_data_url(&encoded).expect("decode PNG"), bytes);
        assert!(decode_png_data_url("data:image/jpeg;base64,AA==").is_err());
        assert!(decode_png_data_url("data:image/png;base64,not-base64").is_err());
    }

    #[test]
    fn flattening_preserves_the_first_original_and_replaces_canonical_pixels() {
        let root = tempfile::tempdir().expect("app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let original = png([10, 20, 30, 255]);
        let first_edit = png([220, 20, 30, 255]);
        let second_edit = png([20, 220, 30, 255]);
        let source = write_capture(&captures, &original);

        let first = persist_flattened_png(&source, &captures, &originals, &first_edit)
            .expect("persist first annotation");
        assert_eq!(fs::read(&source).expect("read canonical"), first_edit);
        assert_eq!(
            fs::read(&first.original_path).expect("read original"),
            original
        );

        persist_flattened_png(&source, &captures, &originals, &second_edit)
            .expect("persist second annotation");
        assert_eq!(
            fs::read(&source).expect("read second canonical"),
            second_edit
        );
        assert_eq!(
            fs::read(&first.original_path).expect("read original again"),
            original
        );
    }

    #[test]
    fn crop_changes_only_canonical_dimensions_and_reset_restores_full_output() {
        let root = tempfile::tempdir().expect("app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let original = png_sized(80, 60, [10, 20, 30, 255]);
        let cropped = png_sized(40, 30, [220, 20, 30, 255]);
        let restored = png_sized(80, 60, [20, 220, 30, 255]);
        let source = write_capture(&captures, &original);

        let stored = persist_flattened_png_with_crop(
            &source,
            &captures,
            &originals,
            &cropped,
            Some(AnnotationCrop {
                x: 12,
                y: 8,
                w: 40,
                h: 30,
            }),
        )
        .expect("persist cropped annotation");
        assert_eq!(
            image::open(&source).expect("cropped PNG").dimensions(),
            (40, 30)
        );
        assert_eq!(
            image::open(&stored.original_path)
                .expect("protected original")
                .dimensions(),
            (80, 60)
        );

        persist_flattened_png_with_crop(&source, &captures, &originals, &restored, None)
            .expect("reset crop from the protected original");
        assert_eq!(
            image::open(&source).expect("restored PNG").dimensions(),
            (80, 60)
        );
        assert_eq!(
            fs::read(stored.original_path).expect("original bytes"),
            original
        );
    }

    #[test]
    fn orientation_changes_only_output_dimensions_and_preserves_the_source() {
        let root = tempfile::tempdir().expect("app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let original = png_sized(80, 60, [10, 20, 30, 255]);
        let rotated = png_sized(60, 80, [220, 20, 30, 255]);
        let source = write_capture(&captures, &original);

        let invalid = persist_flattened_png_with_crop_and_transform(
            &source,
            &captures,
            &originals,
            &rotated,
            None,
            ImageTransform::default(),
        )
        .expect_err("identity orientation rejects swapped dimensions");
        assert!(!invalid.pixels_committed);
        assert_eq!(
            fs::read(&source).expect("source remains original"),
            original
        );

        let stored = persist_flattened_png_with_crop_and_transform(
            &source,
            &captures,
            &originals,
            &rotated,
            None,
            ImageTransform {
                quarter_turns: 1,
                flipped: false,
            },
        )
        .expect("persist rotated annotation");
        assert_eq!(image::open(&source).unwrap().dimensions(), (60, 80));
        assert_eq!(
            image::open(&stored.original_path).unwrap().dimensions(),
            (80, 60)
        );
    }

    #[test]
    fn resize_requires_exact_scaled_dimensions_and_preserves_the_source() {
        let root = tempfile::tempdir().expect("app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let original = png_sized(80, 60, [10, 20, 30, 255]);
        let resized = png_sized(40, 30, [220, 20, 30, 255]);
        let source = write_capture(&captures, &original);

        let invalid = persist_flattened_png_with_crop_transform_and_scale(
            &source,
            &captures,
            &originals,
            &resized,
            None,
            ImageTransform::default(),
            1.0,
        )
        .expect_err("default scale rejects resized pixels");
        assert!(!invalid.pixels_committed);

        let stored = persist_flattened_png_with_crop_transform_and_scale(
            &source,
            &captures,
            &originals,
            &resized,
            None,
            ImageTransform::default(),
            0.5,
        )
        .expect("persist scaled annotation");
        assert_eq!(image::open(&source).unwrap().dimensions(), (40, 30));
        assert_eq!(
            image::open(&stored.original_path).unwrap().dimensions(),
            (80, 60)
        );
    }

    #[test]
    fn shared_redaction_pixels_survive_save_clipboard_queue_and_restart_exactly() {
        let fixture: SharedRedactionFixture = serde_json::from_str(include_str!(
            "../../../../packages/shared/fixtures/annotation-redaction.json"
        ))
        .expect("shared redaction fixture");
        let original = fixture_png(fixture.width, fixture.height, &fixture.original_rgba);
        let flattened = fixture_png(fixture.width, fixture.height, &fixture.flattened_rgba);
        assert_ne!(original, flattened);
        let flattened_data_url = format!("data:image/png;base64,{}", STANDARD.encode(&flattened));
        let validated_flattened =
            decode_png_data_url(&flattened_data_url).expect("validate editor PNG data URL");
        assert_eq!(validated_flattened, flattened);
        assert_eq!(
            validated_tools(vec![AnnotationTool::Blur], true).expect("validate redaction record"),
            vec![AnnotationTool::Blur]
        );

        let root = tempfile::tempdir().expect("app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let store = root.path().join("upload-queue.json");
        let source = write_capture(&captures, &original);
        let mut before_restart =
            DurableUploadQueue::open(&store, &captures, 100).expect("open upload queue");
        before_restart
            .enqueue(&source, QueueSource::Region, 100)
            .expect("queue unannotated capture");

        let stored = persist_flattened_png(&source, &captures, &originals, &validated_flattened)
            .expect("persist actual flattened pixels");
        assert_eq!(fs::read(&source).expect("read canonical PNG"), flattened);
        assert_eq!(
            fs::read(&stored.original_path).expect("read protected original"),
            original
        );
        assert_eq!(
            image::load_from_memory(&fs::read(&source).expect("read flattened PNG"))
                .expect("decode flattened PNG")
                .to_rgba8()
                .into_raw(),
            fixture.flattened_rgba
        );

        let mut clipboard = ExactClipboard::default();
        assert_eq!(
            copy_png_file(&source, &mut clipboard),
            ClipboardStatus::Copied {
                bytes: flattened.len()
            }
        );
        assert_eq!(clipboard.payload, flattened);

        // Model a crash after pixels and clipboard commit but before the queue's
        // annotation bit commits. Restart must infer the protected-original
        // difference and hand the exact flattened bytes to the drain boundary.
        drop(before_restart);
        let restarted =
            DurableUploadQueue::open(&store, &captures, 200).expect("restart upload queue");
        assert!(restarted.item(ID).expect("recovered queue item").annotated);
        let queue = Mutex::new(restarted);
        let transport = ExactUploadTransport {
            expected: flattened.clone(),
            uploads: Mutex::new(Vec::new()),
        };
        let result = DrainCoordinator::default()
            .wake(DrainWake::Startup, &queue, &transport, 200)
            .expect("drain recovered annotation");
        assert!(matches!(result, WakeResult::Ran(report) if report.uploaded == 1));
        assert_eq!(
            *transport.uploads.lock().expect("inspect transport uploads"),
            vec![ID.to_string()]
        );
        assert_eq!(
            fs::read(&source).expect("canonical survives upload"),
            flattened
        );
        assert_eq!(
            fs::read(originals.join(format!("{ID}.png"))).expect("original survives upload"),
            original
        );
    }

    #[test]
    fn original_directory_entry_is_synced_before_its_file_is_committed() {
        let root = tempfile::tempdir().expect("app data");
        let originals = root.path().join("capture-originals");
        let target = originals.join(format!("{ID}.png"));
        let synced = RefCell::new(Vec::new());

        atomic_write_with_sync(&target, &png([10, 20, 30, 255]), |path| {
            synced.borrow_mut().push(path.to_path_buf());
            Ok(())
        })
        .expect("durable original");

        assert_eq!(
            *synced.borrow(),
            vec![root.path().to_path_buf(), originals.clone()]
        );
        assert!(fs::symlink_metadata(&originals)
            .expect("original directory")
            .file_type()
            .is_dir());
    }

    #[test]
    fn post_rename_sync_failure_reports_that_pixels_are_already_visible() {
        let root = tempfile::tempdir().expect("app data");
        let target = root.path().join(format!("{ID}.png"));
        fs::write(&target, b"old pixels").expect("old capture");

        let error = atomic_write_with_sync(&target, b"new pixels", |_| {
            Err("forced directory sync failure".into())
        })
        .expect_err("sync failure");

        assert!(error.commit_visible);
        assert_eq!(fs::read(target).expect("committed capture"), b"new pixels");
    }

    #[test]
    fn retry_resyncs_a_visible_original_hierarchy_before_replacing_pixels() {
        let root = tempfile::tempdir().expect("app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let original = png([10, 20, 30, 255]);
        let flattened = png([220, 20, 30, 255]);
        let source = write_capture(&captures, &original);
        fs::create_dir(&originals).expect("visible original directory");
        fs::write(originals.join(format!("{ID}.png")), &original).expect("visible original");

        let failed = persist_flattened_png_with_hierarchy_sync(
            &source,
            &captures,
            &originals,
            &flattened,
            |_| Err("forced hierarchy sync failure".into()),
        )
        .expect_err("unsynced hierarchy blocks replacement");
        assert!(!failed.pixels_committed);
        assert_eq!(fs::read(&source).expect("canonical untouched"), original);

        let synced = RefCell::new(Vec::new());
        persist_flattened_png_with_hierarchy_sync(
            &source,
            &captures,
            &originals,
            &flattened,
            |path| {
                synced.borrow_mut().push(path.to_path_buf());
                Ok(())
            },
        )
        .expect("retry resyncs and commits");
        assert_eq!(
            *synced.borrow(),
            vec![root.path().to_path_buf(), originals.clone()]
        );
        assert_eq!(fs::read(source).expect("canonical replaced"), flattened);
    }

    #[test]
    fn saving_or_committed_annotation_cannot_be_hidden_by_window_close_or_timeout() {
        let path = "/protected/captures/018f22c4-cada-7c6b-9d5b-fc35f7f9227a.png";
        let mut runtime = AnnotationRuntime::default();
        let capture = runtime
            .begin(ID.into(), path.into(), 7)
            .expect("begin annotation");
        assert!(runtime.is_active());
        assert!(runtime.protects_overlay(path, 7));
        assert!(matches!(
            runtime.window_close_disposition(),
            WindowCloseDisposition::Cancel(_)
        ));

        runtime
            .begin_save(path, 7, capture.session_id, 0)
            .expect("begin save");
        assert_eq!(
            runtime.window_close_disposition(),
            WindowCloseDisposition::KeepOpen
        );
        assert!(runtime.protects_overlay(path, 7));

        runtime.pixels_committed(capture.session_id);
        runtime.save_failed(capture.session_id);
        assert_eq!(
            runtime.window_close_disposition(),
            WindowCloseDisposition::KeepOpen
        );
        assert!(
            runtime.protects_overlay(path, 99),
            "a refreshed presentation of the same capture stays protected"
        );

        runtime.finish(capture.session_id).expect("finish save");
        assert!(!runtime.is_active());
        assert!(!runtime.protects_overlay(path, 99));
        assert_eq!(
            runtime.window_close_disposition(),
            WindowCloseDisposition::Hide
        );
    }

    #[test]
    fn annotation_drag_is_exact_single_flight_and_keeps_the_editor_open() {
        let path = "/protected/captures/018f22c4-cada-7c6b-9d5b-fc35f7f9227a.png";
        let mut runtime = AnnotationRuntime::default();
        let capture = runtime
            .begin(ID.into(), path.into(), 7)
            .expect("begin annotation");

        assert!(runtime.begin_drag(path, 7, capture.session_id).is_ok());
        assert!(runtime.begin_drag(path, 7, capture.session_id).is_err());
        assert!(runtime.begin_drag(path, 8, capture.session_id).is_err());
        assert_eq!(
            runtime.window_close_disposition(),
            WindowCloseDisposition::KeepOpen
        );
        assert!(!runtime.finish_drag(capture.session_id + 1));
        assert!(runtime.finish_drag(capture.session_id));
        assert!(!runtime.finish_drag(capture.session_id));
        assert!(matches!(
            runtime.window_close_disposition(),
            WindowCloseDisposition::Cancel(_)
        ));
    }

    #[test]
    fn annotation_drag_pixels_must_match_the_current_crop_orientation_and_resolution() {
        let root = tempfile::tempdir().expect("app data");
        let source = root.path().join(format!("{ID}.png"));
        fs::write(&source, png_sized(640, 360, [10, 20, 30, 255])).expect("write source");
        let capture = AnnotationCapture {
            id: ID.into(),
            path: source.to_string_lossy().into_owned(),
            source_path: source.to_string_lossy().into_owned(),
            presentation_id: 7,
            session_id: 1,
            document_revision: 0,
            crop: None,
            image_transform: ImageTransform::default(),
            image_scale: 1.0,
            marks: Vec::new(),
            editing_existing: false,
        };
        let crop = Some(AnnotationCrop {
            x: 20,
            y: 30,
            w: 320,
            h: 180,
        });
        let transform = ImageTransform {
            quarter_turns: 1,
            flipped: true,
        };
        let exact = png_sized(90, 160, [220, 20, 30, 255]);

        validate_annotation_drag_pixels(&capture, &exact, crop, transform, 0.5)
            .expect("exact current flattened pixels");
        assert!(validate_annotation_drag_pixels(
            &capture,
            &png_sized(160, 90, [220, 20, 30, 255]),
            crop,
            transform,
            0.5,
        )
        .is_err());
        assert!(validate_annotation_drag_pixels(
            &capture,
            &exact,
            Some(AnnotationCrop {
                x: 600,
                y: 300,
                w: 320,
                h: 180,
            }),
            transform,
            0.5,
        )
        .is_err());
    }

    #[test]
    fn invalid_or_resized_pixels_never_replace_the_capture() {
        let root = tempfile::tempdir().expect("app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let original = png([10, 20, 30, 255]);
        let source = write_capture(&captures, &original);
        let resized = {
            let image = ImageBuffer::from_pixel(2, 2, Rgba([220, 20, 30, 255]));
            let mut bytes = Vec::new();
            image::DynamicImage::ImageRgba8(image)
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .expect("encode resized PNG");
            bytes
        };

        assert!(persist_flattened_png(&source, &captures, &originals, b"not png").is_err());
        assert!(persist_flattened_png(&source, &captures, &originals, &resized).is_err());
        assert_eq!(fs::read(&source).expect("read untouched capture"), original);
        assert!(!originals.exists());
    }

    #[test]
    fn tool_record_is_unique_and_blur_matches_redaction_flag() {
        assert_eq!(
            validated_tools(
                vec![
                    AnnotationTool::Arrow,
                    AnnotationTool::Line,
                    AnnotationTool::Ellipse,
                    AnnotationTool::Pencil,
                    AnnotationTool::Highlighter,
                    AnnotationTool::Counter,
                    AnnotationTool::Spotlight,
                    AnnotationTool::Blur,
                ],
                true,
            )
            .expect("valid tools"),
            vec![
                AnnotationTool::Arrow,
                AnnotationTool::Line,
                AnnotationTool::Ellipse,
                AnnotationTool::Pencil,
                AnnotationTool::Highlighter,
                AnnotationTool::Counter,
                AnnotationTool::Spotlight,
                AnnotationTool::Blur,
            ]
        );
        assert!(validated_tools(Vec::new(), false).is_err());
        assert!(validated_tools(vec![AnnotationTool::Box, AnnotationTool::Box], false).is_err());
        assert!(validated_tools(vec![AnnotationTool::Blur], false).is_err());
    }

    #[test]
    fn secure_and_smooth_blur_have_distinct_privacy_records() {
        use crate::annotation_project::{AnnotationMark, BlurMode, BlurStrength};

        let smooth = AnnotationMark::BlurEffect {
            x: 10.0,
            y: 20.0,
            w: 80.0,
            h: 40.0,
            blur_mode: BlurMode::Smooth,
            blur_strength: BlurStrength::Strong,
        };
        assert!(super::validated_project_marks(
            vec![smooth],
            &[AnnotationTool::BlurEffect],
            false,
            false,
            false,
            false,
        )
        .is_ok());

        let secure = AnnotationMark::BlurEffect {
            x: 10.0,
            y: 20.0,
            w: 80.0,
            h: 40.0,
            blur_mode: BlurMode::Secure,
            blur_strength: BlurStrength::Regular,
        };
        assert!(super::validated_project_marks(
            vec![secure.clone()],
            &[AnnotationTool::BlurEffect],
            true,
            false,
            false,
            false,
        )
        .is_ok());
        assert!(super::validated_project_marks(
            vec![secure],
            &[AnnotationTool::BlurEffect],
            false,
            false,
            false,
            false,
        )
        .is_err());
    }

    #[test]
    fn bundled_editor_is_hidden_focusable_resizable_and_capability_scoped() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let editor = config["app"]["windows"]
            .as_array()
            .expect("window configurations")
            .iter()
            .find(|window| window["label"] == ANNOTATION_LABEL)
            .expect("annotation editor window");
        assert_eq!(editor["url"], "index.html?surface=annotate");
        assert_eq!(editor["visible"], false);
        assert_eq!(editor["focusable"], true);
        assert_eq!(editor["resizable"], true);
        assert_eq!(editor["minWidth"], 760);
        assert_eq!(editor["minHeight"], 540);

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/annotation-editor.json"))
                .expect("valid annotation capability");
        assert_eq!(capability["windows"], serde_json::json!([ANNOTATION_LABEL]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["core:event:default"])
        );
    }
}
