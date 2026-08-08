use crate::{
    clipboard::ClipboardStatus,
    overlay::{self, OverlaySource, OverlayStatus},
    queue::QueueRuntime,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const ANNOTATION_LABEL: &str = "annotation-editor";
const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";
const MAX_FLATTENED_BYTES: usize = 25 * 1_024 * 1_024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnnotationTool {
    Arrow,
    Box,
    Text,
    Blur,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationCapture {
    id: String,
    path: String,
    presentation_id: u64,
    session_id: u64,
}

#[derive(Clone, Debug)]
struct AnnotationSession {
    capture: AnnotationCapture,
    saving: bool,
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
            path,
            presentation_id,
            session_id: self.generation,
        };
        self.current = Some(AnnotationSession {
            capture: capture.clone(),
            saving: false,
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
    ) -> Result<AnnotationCapture, String> {
        if !self.exact(path, presentation_id, session_id) {
            return Err("That annotation session is no longer active.".into());
        }
        let session = self.current.as_mut().expect("exact session exists");
        if session.saving {
            return Err("That annotation is already being saved.".into());
        }
        session.saving = true;
        Ok(session.capture.clone())
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

    fn window_close_disposition(&self) -> WindowCloseDisposition {
        match self.current.as_ref() {
            Some(session) if session.saving || session.pixels_committed => {
                WindowCloseDisposition::KeepOpen
            }
            Some(session) => WindowCloseDisposition::Cancel(session.capture.clone()),
            None => WindowCloseDisposition::Hide,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSaveResult {
    bytes: u64,
    original_path: String,
    clipboard: ClipboardStatus,
    overlay: OverlayStatus,
    tools_used: Vec<AnnotationTool>,
    redacted: bool,
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

fn persist_flattened_png(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
) -> Result<FlattenedCapture, PersistFlattenedError> {
    persist_flattened_png_with_hierarchy_sync(
        source,
        capture_directory,
        originals_directory,
        flattened,
        sync_directory,
    )
}

fn persist_flattened_png_with_hierarchy_sync<S>(
    source: &Path,
    capture_directory: &Path,
    originals_directory: &Path,
    flattened: &[u8],
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
    if source_image.dimensions() != flattened_image.dimensions() {
        return Err(PersistFlattenedError {
            message: "The flattened annotation changed the capture dimensions.".into(),
            pixels_committed: false,
        });
    }

    let file_name = source.file_name().ok_or_else(|| PersistFlattenedError {
        message: "The capture filename is invalid.".into(),
        pixels_committed: false,
    })?;
    let original_path = originals_directory.join(file_name);
    if original_path.exists() {
        let metadata =
            fs::symlink_metadata(&original_path).map_err(|error| PersistFlattenedError {
                message: format!("Could not inspect the preserved original: {error}"),
                pixels_committed: false,
            })?;
        if !metadata.file_type().is_file()
            || image::open(&original_path)
                .map(|image| image.dimensions() != source_image.dimensions())
                .unwrap_or(true)
        {
            return Err(PersistFlattenedError {
                message: "The preserved original is unavailable or invalid.".into(),
                pixels_committed: false,
            });
        }
    } else {
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
        return Err("Add an arrow, box, label, or blur before saving.".into());
    }
    let unique = tools.iter().copied().collect::<HashSet<_>>();
    if unique.len() != tools.len() {
        return Err("The annotation tool record contains duplicates.".into());
    }
    if redacted != unique.contains(&AnnotationTool::Blur) {
        return Err("The blur privacy record does not match the flattened annotation.".into());
    }
    Ok(tools)
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
    release_queue_reservation(app, &capture.id);
    if let Some(window) = app.get_webview_window(ANNOTATION_LABEL) {
        let _ = window.hide();
    }
    let _ = overlay::restore_after_annotation(app, &capture.path, capture.presentation_id);
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
    let Some(window) = app.get_webview_window(ANNOTATION_LABEL) else {
        rollback_open(&app, &capture);
        return Err("The annotation editor window is unavailable.".into());
    };
    if let Err(error) = app.emit_to(ANNOTATION_LABEL, "annotation-capture", capture.clone()) {
        rollback_open(&app, &capture);
        return Err(format!("Could not load the annotation editor: {error}"));
    }
    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
        rollback_open(&app, &capture);
        return Err(format!("Could not show the annotation editor: {error}"));
    }
    Ok(capture)
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
            .is_some_and(|session| session.saving)
        {
            return Err("Wait for the annotated capture to finish saving.".into());
        }
        if runtime
            .current
            .as_ref()
            .is_some_and(|session| session.pixels_committed)
        {
            return Err(
                "The flattened image is safe locally. Press Save & copy again to finish its upload record."
                    .into(),
            );
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
    if let Err(error) =
        overlay::refresh_after_annotation(&app, &capture.path, capture.presentation_id, None)
    {
        let _ = window.show().and_then(|_| window.set_focus());
        return Err(format!("Could not restore Quick Access: {error}"));
    }
    state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .finish(session_id)
        .ok_or_else(|| "That annotation session is no longer active.".to_string())?;
    release_queue_reservation(&app, &capture.id);
    Ok(true)
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
    } = request;
    let tools_used = validated_tools(tools_used, redacted)?;
    let capture_directory = crate::history::capture_directory(&app)?;
    let originals_directory = app
        .path()
        .app_data_dir()
        .map(|directory| directory.join("capture-originals"))
        .map_err(|error| format!("Could not locate Capso's original capture store: {error}"))?;
    let capture = state
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .begin_save(&path, presentation_id, session_id)?;
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
    let stored = match tauri::async_runtime::spawn_blocking(move || {
        persist_flattened_png(
            &source,
            &capture_directory,
            &originals_directory,
            &flattened,
        )
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

    let clipboard = crate::clipboard::recopy_current_capture_to_general_pasteboard(
        app.clone(),
        PathBuf::from(&capture.path),
    )
    .await;
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
            if overlay::refresh_after_annotation(app, &capture.path, capture.presentation_id, None)
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
            release_queue_reservation(app, &capture.id);
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write_with_sync, decode_png_data_url, persist_flattened_png,
        persist_flattened_png_with_hierarchy_sync, validated_tools, AnnotationRuntime,
        AnnotationTool, WindowCloseDisposition, ANNOTATION_LABEL,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::{ImageBuffer, Rgba};
    use std::{cell::RefCell, fs, path::Path};

    const ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";

    fn png(color: [u8; 4]) -> Vec<u8> {
        let image = ImageBuffer::from_pixel(8, 6, Rgba(color));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("encode fixture PNG");
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
            .begin_save(path, 7, capture.session_id)
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
            validated_tools(vec![AnnotationTool::Arrow, AnnotationTool::Blur], true)
                .expect("valid tools"),
            vec![AnnotationTool::Arrow, AnnotationTool::Blur]
        );
        assert!(validated_tools(Vec::new(), false).is_err());
        assert!(validated_tools(vec![AnnotationTool::Box, AnnotationTool::Box], false).is_err());
        assert!(validated_tools(vec![AnnotationTool::Blur], false).is_err());
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
