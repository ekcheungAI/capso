use crate::{capture::CaptureMode, clipboard::ClipboardStatus};
#[cfg(target_os = "macos")]
use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType, CGMouseButton};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::{mpsc, Arc};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

pub(crate) const OVERLAY_LABEL: &str = "capture-overlay";
pub(crate) const OVERLAY_WIDTH_LOGICAL: f64 = 252.0;
pub(crate) const OVERLAY_HEIGHT_LOGICAL: f64 = 194.0;
const OVERLAY_MARGIN_LOGICAL: f64 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct ScreenPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ScreenRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct DisplayGeometry {
    bounds: ScreenRect,
    work_area: ScreenRect,
    scale_factor: f64,
}

impl From<&tauri::Monitor> for DisplayGeometry {
    fn from(monitor: &tauri::Monitor) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        let work_area = monitor.work_area();
        Self {
            bounds: ScreenRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            },
            work_area: ScreenRect {
                x: work_area.position.x,
                y: work_area.position.y,
                width: work_area.size.width,
                height: work_area.size.height,
            },
            scale_factor: monitor.scale_factor(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayCapture {
    path: String,
    presentation_id: u64,
    clipboard: ClipboardStatus,
    source: OverlaySource,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OverlaySource {
    Capture,
    History,
}

#[derive(Default)]
pub(crate) struct OverlayRuntime {
    current: Option<OverlayCapture>,
    last_failure: Option<OverlayFailureRecord>,
    presentation_generation: u64,
    active_drag: Option<OverlayDragIdentity>,
    pending_latency: Option<PendingOverlayLatency>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OverlayDragIdentity {
    path: String,
    presentation_id: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PendingOverlayLatency {
    presentation_id: u64,
    start: crate::latency::OverlayLatencyStart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DragGestureState {
    left_button_is_down: bool,
    left_mouse_down_counter: u32,
}

impl OverlayRuntime {
    fn reset(&mut self) {
        self.current = None;
        self.last_failure = None;
        self.pending_latency = None;
    }

    fn replace(&mut self, capture: OverlayCapture) {
        self.current = Some(capture);
        self.last_failure = None;
        self.pending_latency = None;
    }

    fn next_capture(
        &mut self,
        path: String,
        clipboard: ClipboardStatus,
        source: OverlaySource,
    ) -> OverlayCapture {
        self.presentation_generation = self
            .presentation_generation
            .checked_add(1)
            .expect("overlay presentation generation cannot exhaust u64");
        OverlayCapture {
            path,
            presentation_id: self.presentation_generation,
            clipboard,
            source,
        }
    }

    fn record_failure(
        &mut self,
        path: &str,
        presentation_id: u64,
        code: &'static str,
        message: impl Into<String>,
    ) -> OverlayFailureRecord {
        let failure = OverlayFailureRecord {
            path: path.into(),
            presentation_id,
            code,
            message: message.into(),
        };
        self.last_failure = Some(failure.clone());
        failure
    }

    fn fail_if_current(
        &mut self,
        path: &str,
        presentation_id: u64,
        code: &'static str,
        message: impl Into<String>,
    ) -> Option<OverlayFailureRecord> {
        if !capture_matches(self.current.as_ref(), path, presentation_id) {
            return None;
        }

        self.current = None;
        self.pending_latency = None;
        Some(self.record_failure(path, presentation_id, code, message))
    }

    fn begin_drag(
        &mut self,
        path: &str,
        presentation_id: u64,
    ) -> Result<OverlayDragIdentity, String> {
        if !capture_matches(self.current.as_ref(), path, presentation_id) {
            return Err("That capture is no longer active in the overlay.".into());
        }
        if self.active_drag.is_some() {
            return Err("Another capture drag is still in progress.".into());
        }
        let identity = OverlayDragIdentity {
            path: path.into(),
            presentation_id,
        };
        self.active_drag = Some(identity.clone());
        Ok(identity)
    }

    fn finish_drag(&mut self, identity: &OverlayDragIdentity) -> bool {
        if self.active_drag.as_ref() != Some(identity) {
            return false;
        }
        self.active_drag = None;
        true
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayFailureRecord {
    path: String,
    presentation_id: u64,
    code: &'static str,
    message: String,
}

trait OverlayWindowOps {
    fn hide_overlay(&self) -> Result<(), String>;
    fn show_overlay(&self) -> Result<(), String>;
    fn position_overlay(&self, x: i32, y: i32) -> Result<(), String>;
}

impl OverlayWindowOps for WebviewWindow {
    fn hide_overlay(&self) -> Result<(), String> {
        self.hide().map_err(|error| error.to_string())
    }

    fn show_overlay(&self) -> Result<(), String> {
        self.show().map_err(|error| error.to_string())
    }

    fn position_overlay(&self, x: i32, y: i32) -> Result<(), String> {
        self.set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, PartialEq)]
enum RevealTransition {
    Stale,
    Shown(Option<crate::latency::OverlayLatencySample>),
    Failed(OverlayFailureRecord),
}

#[derive(Debug, PartialEq)]
enum DismissTransition {
    Stale,
    Dismissed,
    Failed(OverlayFailureRecord),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DismissReason {
    Close,
    Timeout,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlaySaveResult {
    destination: String,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayDragStarted {
    bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OverlayDragOutcome {
    Dropped,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayDragEnded {
    path: String,
    presentation_id: u64,
    outcome: OverlayDragOutcome,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayDismissed<'a> {
    path: &'a str,
    presentation_id: u64,
    reason: DismissReason,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum OverlayStatus {
    Prepared { x: i32, y: i32 },
    Failed { code: &'static str, message: String },
}

fn display_at_cursor(displays: &[DisplayGeometry], cursor: ScreenPoint) -> Option<DisplayGeometry> {
    displays.iter().copied().find(|display| {
        let right = f64::from(display.bounds.x) + f64::from(display.bounds.width);
        let bottom = f64::from(display.bounds.y) + f64::from(display.bounds.height);
        cursor.x >= f64::from(display.bounds.x)
            && cursor.x < right
            && cursor.y >= f64::from(display.bounds.y)
            && cursor.y < bottom
    })
}

fn bottom_right_position(display: DisplayGeometry) -> (i32, i32) {
    let overlay_width = (OVERLAY_WIDTH_LOGICAL * display.scale_factor).round() as i64;
    let overlay_height = (OVERLAY_HEIGHT_LOGICAL * display.scale_factor).round() as i64;
    let margin = (OVERLAY_MARGIN_LOGICAL * display.scale_factor).round() as i64;
    let x = i64::from(display.work_area.x) + i64::from(display.work_area.width)
        - overlay_width
        - margin;
    let y = i64::from(display.work_area.y) + i64::from(display.work_area.height)
        - overlay_height
        - margin;

    (
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}

fn overlay_failure(code: &'static str, message: impl Into<String>) -> OverlayStatus {
    OverlayStatus::Failed {
        code,
        message: message.into(),
    }
}

fn capture_matches(current: Option<&OverlayCapture>, path: &str, presentation_id: u64) -> bool {
    current
        .is_some_and(|capture| capture.path == path && capture.presentation_id == presentation_id)
}

fn prepare_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    capture: OverlayCapture,
    latency_start: Option<crate::latency::OverlayLatencyStart>,
    x: i32,
    y: i32,
) -> Result<(), OverlayFailureRecord> {
    let path = capture.path.clone();
    let presentation_id = capture.presentation_id;

    // Reset, hide, position and replace are one serialized transition. A ready
    // or failed callback cannot interleave and mutate visibility for an older
    // capture while a newer capture is being prepared.
    runtime.reset();
    if let Err(error) = window.hide_overlay() {
        return Err(runtime.record_failure(
            &path,
            presentation_id,
            "overlay_hide_failed",
            format!("Could not reset the capture overlay: {error}"),
        ));
    }
    if let Err(error) = window.position_overlay(x, y) {
        return Err(runtime.record_failure(
            &path,
            presentation_id,
            "overlay_position_failed",
            format!("Could not position the capture overlay: {error}"),
        ));
    }

    runtime.replace(capture);
    runtime.pending_latency = latency_start.map(|start| PendingOverlayLatency {
        presentation_id,
        start,
    });
    Ok(())
}

fn reveal_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
) -> RevealTransition {
    reveal_transition_with_clock(runtime, window, path, presentation_id, Instant::now)
}

fn reveal_transition_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    now: impl FnOnce() -> Instant,
) -> RevealTransition {
    if !capture_matches(runtime.current.as_ref(), path, presentation_id) {
        return RevealTransition::Stale;
    }

    match window.show_overlay() {
        Ok(()) => {
            let sample = runtime.pending_latency.take().and_then(|pending| {
                (pending.presentation_id == presentation_id).then(|| pending.start.finish(now()))
            });
            RevealTransition::Shown(sample)
        }
        Err(error) => {
            let failure = runtime
                .fail_if_current(
                    path,
                    presentation_id,
                    "overlay_show_failed",
                    format!("Could not show the capture overlay: {error}"),
                )
                .expect("the exact current capture was validated above");
            let _ = window.hide_overlay();
            RevealTransition::Failed(failure)
        }
    }
}

fn fail_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    code: &'static str,
    message: impl Into<String>,
) -> Option<OverlayFailureRecord> {
    let failure = runtime.fail_if_current(path, presentation_id, code, message);
    if failure.is_some() {
        let _ = window.hide_overlay();
    }
    failure
}

fn dismiss_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
) -> DismissTransition {
    if !capture_matches(runtime.current.as_ref(), path, presentation_id) {
        return DismissTransition::Stale;
    }

    match window.hide_overlay() {
        Ok(()) => {
            runtime.reset();
            DismissTransition::Dismissed
        }
        Err(error) => DismissTransition::Failed(runtime.record_failure(
            path,
            presentation_id,
            "overlay_dismiss_failed",
            format!("Could not dismiss the capture overlay: {error}"),
        )),
    }
}

fn current_capture_path(
    runtime: &OverlayRuntime,
    path: &str,
    presentation_id: u64,
) -> Result<PathBuf, String> {
    runtime
        .current
        .as_ref()
        .filter(|capture| capture.path == path && capture.presentation_id == presentation_id)
        .map(|capture| PathBuf::from(&capture.path))
        .ok_or_else(|| "That capture is no longer active in the overlay.".to_string())
}

pub(crate) fn current_capture_for_action(
    state: &Mutex<OverlayRuntime>,
    path: &str,
    presentation_id: u64,
) -> Result<PathBuf, String> {
    let runtime = state
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    current_capture_path(&runtime, path, presentation_id)
}

pub(crate) fn annotation_candidate(
    runtime: &OverlayRuntime,
    path: &str,
    presentation_id: u64,
) -> Result<(PathBuf, OverlaySource), String> {
    runtime
        .current
        .as_ref()
        .filter(|capture| capture.path == path && capture.presentation_id == presentation_id)
        .map(|capture| (PathBuf::from(&capture.path), capture.source))
        .ok_or_else(|| "That capture is no longer active in the overlay.".to_string())
}

pub(crate) fn hide_for_annotation(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let runtime = app.state::<Mutex<OverlayRuntime>>();
    let runtime = runtime
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    current_capture_path(&runtime, path, presentation_id)?;
    window
        .hide()
        .map_err(|error| format!("Could not hide the capture overlay for editing: {error}"))
}

pub(crate) fn restore_after_annotation(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let runtime = app.state::<Mutex<OverlayRuntime>>();
    let runtime = runtime
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    current_capture_path(&runtime, path, presentation_id)?;
    window
        .show()
        .map_err(|error| format!("Could not restore the capture overlay: {error}"))
}

fn annotation_refresh_payload(
    runtime: &mut OverlayRuntime,
    path: &str,
    presentation_id: u64,
    clipboard: Option<&ClipboardStatus>,
) -> Result<(OverlayCapture, OverlayCapture), String> {
    let previous = runtime
        .current
        .as_ref()
        .filter(|capture| capture.path == path && capture.presentation_id == presentation_id)
        .cloned()
        .ok_or_else(|| "The annotated capture is no longer active in the overlay.".to_string())?;
    let payload = runtime.next_capture(
        path.into(),
        clipboard
            .cloned()
            .unwrap_or_else(|| previous.clipboard.clone()),
        previous.source,
    );
    Ok((previous, payload))
}

pub(crate) fn refresh_after_annotation(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
    clipboard: Option<&ClipboardStatus>,
) -> Result<OverlayStatus, String> {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return Err("The capture overlay window is unavailable after annotation.".into());
    };
    let state = app.state::<Mutex<OverlayRuntime>>();
    let position = window.outer_position().ok();
    let mut runtime = state
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    let (previous, payload) =
        annotation_refresh_payload(&mut runtime, path, presentation_id, clipboard)?;
    window
        .hide()
        .map_err(|error| format!("Could not reset the annotated capture preview: {error}"))?;
    runtime.replace(payload.clone());
    if let Err(error) = app.emit_to(OVERLAY_LABEL, "overlay-capture", payload) {
        runtime.replace(previous);
        let _ = window.show();
        return Err(format!(
            "Could not refresh the annotated capture preview: {error}"
        ));
    }
    Ok(OverlayStatus::Prepared {
        x: position.as_ref().map(|position| position.x).unwrap_or(0),
        y: position.as_ref().map(|position| position.y).unwrap_or(0),
    })
}

fn begin_drag_transition(
    runtime: &mut OverlayRuntime,
    path: &str,
    presentation_id: u64,
    initial_gesture: DragGestureState,
    current_gesture: DragGestureState,
) -> Result<OverlayDragIdentity, String> {
    if !initial_gesture.left_button_is_down
        || !current_gesture.left_button_is_down
        || initial_gesture.left_mouse_down_counter != current_gesture.left_mouse_down_counter
    {
        return Err(
            "The original pointer gesture ended before the capture drag could start.".into(),
        );
    }
    runtime.begin_drag(path, presentation_id)
}

fn export_capture(source: &Path, destination: &Path) -> io::Result<u64> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".capso-export-{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| {
        let mut input = File::open(source)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let bytes = io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, destination)?;
        Ok(bytes)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn report_overlay_failure(app: &AppHandle, failure: &OverlayFailureRecord) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Capso — capture saved; {}", failure.message)));
    }
    let _ = app.emit("capture-overlay-failed", failure.clone());
}

fn capture_display(
    mode: CaptureMode,
    cursor_display: Option<DisplayGeometry>,
    primary_display: Option<DisplayGeometry>,
) -> Option<DisplayGeometry> {
    match mode {
        CaptureMode::Fullscreen => primary_display.or(cursor_display),
        CaptureMode::Region | CaptureMode::Window => cursor_display.or(primary_display),
    }
}

fn target_display(app: &AppHandle, mode: CaptureMode) -> Result<DisplayGeometry, OverlayStatus> {
    let monitors = app.available_monitors().map_err(|error| {
        overlay_failure(
            "overlay_displays_unavailable",
            format!("Could not inspect the connected displays: {error}"),
        )
    })?;
    let geometries = monitors
        .iter()
        .map(DisplayGeometry::from)
        .collect::<Vec<_>>();

    let selected = app.cursor_position().ok().and_then(|cursor| {
        display_at_cursor(
            &geometries,
            ScreenPoint {
                x: cursor.x,
                y: cursor.y,
            },
        )
    });

    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(DisplayGeometry::from);

    capture_display(mode, selected, primary)
        .or_else(|| geometries.first().copied())
        .ok_or_else(|| {
            overlay_failure(
                "overlay_display_missing",
                "Could not find a display for the capture overlay.",
            )
        })
}

/// Prepares the hidden overlay with the latest durable capture. The webview
/// reveals itself only after the local image has decoded, preventing a stale
/// previous thumbnail from flashing while preserving the non-focusable window.
pub(crate) fn prepare_capture_overlay(
    app: &AppHandle,
    mode: CaptureMode,
    path: &Path,
    clipboard: &ClipboardStatus,
    latency_start: crate::latency::OverlayLatencyStart,
) -> OverlayStatus {
    let status = prepare_capture_overlay_transaction(app, mode, path, clipboard, latency_start);
    if matches!(status, OverlayStatus::Failed { .. }) {
        release_quick_access_capture(app, path);
    }
    crate::clipboard::complete_new_capture_transaction(app, path);
    status
}

fn prepare_capture_overlay_transaction(
    app: &AppHandle,
    mode: CaptureMode,
    path: &Path,
    clipboard: &ClipboardStatus,
    latency_start: crate::latency::OverlayLatencyStart,
) -> OverlayStatus {
    if crate::annotation::is_active(app) {
        return overlay_failure(
            "overlay_annotation_active",
            "Quick Access is still protecting the capture open in Annotate.",
        );
    }
    let (window, display) = match overlay_window_and_display(app, mode) {
        Ok(target) => target,
        Err(status) => return status,
    };
    prepare_overlay(
        app,
        &window,
        display,
        path,
        clipboard,
        OverlaySource::Capture,
        Some(latency_start),
    )
}

/// Restores a validated local original on the display containing the cursor.
/// The clipboard status is deliberately `unchanged`: selecting history only
/// presents the original and Copy remains an explicit user action.
pub(crate) fn prepare_history_overlay(app: &AppHandle, path: &Path) -> OverlayStatus {
    if crate::annotation::is_active(app) {
        return overlay_failure(
            "overlay_annotation_active",
            "Finish or cancel the open annotation before restoring another capture.",
        );
    }
    let (window, display) = match overlay_window_and_display(app, CaptureMode::Region) {
        Ok(target) => target,
        Err(status) => return status,
    };
    match crate::clipboard::publish_restored_capture(app, path.to_path_buf(), |clipboard| {
        let status = prepare_overlay(
            app,
            &window,
            display,
            path,
            &clipboard,
            OverlaySource::History,
            None,
        );
        match status {
            OverlayStatus::Prepared { .. } => Ok(status),
            OverlayStatus::Failed { .. } => Err(status),
        }
    }) {
        Ok(status) => status,
        Err(crate::clipboard::RestoredCapturePublicationError::Clipboard(
            ClipboardStatus::Failed { code, message },
        )) => overlay_failure(code, message),
        Err(crate::clipboard::RestoredCapturePublicationError::Clipboard(_)) => overlay_failure(
            "clipboard_restore_failed",
            "Could not prepare that recent capture for copying.",
        ),
        Err(crate::clipboard::RestoredCapturePublicationError::Publication(status)) => status,
    }
}

fn overlay_window_and_display(
    app: &AppHandle,
    mode: CaptureMode,
) -> Result<(WebviewWindow, DisplayGeometry), OverlayStatus> {
    let window = app.get_webview_window(OVERLAY_LABEL).ok_or_else(|| {
        overlay_failure(
            "overlay_unavailable",
            "The capture overlay window is unavailable.",
        )
    })?;
    let display = target_display(app, mode)?;
    Ok((window, display))
}

fn prepare_overlay(
    app: &AppHandle,
    window: &WebviewWindow,
    display: DisplayGeometry,
    path: &Path,
    clipboard: &ClipboardStatus,
    source: OverlaySource,
    latency_start: Option<crate::latency::OverlayLatencyStart>,
) -> OverlayStatus {
    let (x, y) = bottom_right_position(display);
    let state = app.state::<Mutex<OverlayRuntime>>();
    let mut runtime = match state.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return overlay_failure(
                "overlay_state_failed",
                "The capture overlay state is temporarily unavailable.",
            )
        }
    };
    // Keep this guard until publication commits. An editor may read the old
    // overlay before we enter this transition, but it cannot establish its
    // annotation session until the new payload is current. Its later exact
    // overlay validation will then reject and roll back that stale open.
    let annotation_state = app.state::<Mutex<crate::annotation::AnnotationRuntime>>();
    let annotation_runtime = match annotation_state.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return overlay_failure(
                "overlay_annotation_state_failed",
                "The annotation editor state is temporarily unavailable.",
            )
        }
    };
    if annotation_runtime.is_active() {
        return overlay_failure(
            "overlay_annotation_active",
            "Quick Access is still protecting the capture open in Annotate.",
        );
    }
    let payload = runtime.next_capture(
        path.to_string_lossy().into_owned(),
        clipboard.clone(),
        source,
    );

    if let Err(failure) =
        prepare_transition(&mut runtime, window, payload.clone(), latency_start, x, y)
    {
        drop(annotation_runtime);
        drop(runtime);
        finish_quick_access_publication(app, None);
        return overlay_failure(failure.code, failure.message);
    }

    // Keep the transition lock through delivery: a ready callback can run only
    // after the matching payload is committed, and failed delivery is cleared
    // before another capture can replace it.
    if let Err(error) = app.emit_to(OVERLAY_LABEL, "overlay-capture", payload.clone()) {
        let message = format!("Could not update the capture overlay: {error}");
        let _ = runtime.fail_if_current(
            path.to_string_lossy().as_ref(),
            payload.presentation_id,
            "overlay_event_failed",
            &message,
        );
        drop(annotation_runtime);
        drop(runtime);
        finish_quick_access_publication(app, None);
        return overlay_failure("overlay_event_failed", message);
    }

    drop(annotation_runtime);
    drop(runtime);
    let active_capture = (source == OverlaySource::Capture).then_some(path);
    finish_quick_access_publication(app, active_capture);
    OverlayStatus::Prepared { x, y }
}

fn wake_after_quick_access_release(app: &AppHandle, released: Result<bool, String>) {
    match released {
        Ok(true) => {
            #[cfg(target_os = "macos")]
            crate::spawn_background_sync(app.clone(), crate::drain::DrainWake::CaptureEnqueued);
        }
        Ok(false) => {}
        Err(error) => eprintln!("Could not update Capso's Quick Access upload hold: {error}"),
    }
}

fn finish_quick_access_publication(app: &AppHandle, active_capture: Option<&Path>) {
    wake_after_quick_access_release(
        app,
        crate::queue::publish_quick_access_for_app(app, active_capture),
    );
}

fn release_quick_access_capture(app: &AppHandle, capture: &Path) {
    wake_after_quick_access_release(
        app,
        crate::queue::release_quick_access_for_app(app, capture),
    );
}

#[tauri::command]
pub(crate) fn get_overlay_capture(
    state: State<'_, Mutex<OverlayRuntime>>,
) -> Result<Option<OverlayCapture>, String> {
    state
        .lock()
        .map(|runtime| runtime.current.clone())
        .map_err(|_| "The capture overlay state is temporarily unavailable.".into())
}

#[tauri::command]
pub(crate) fn overlay_image_ready(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let transition = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        reveal_transition(&mut runtime, &window, &path, presentation_id)
    };

    match transition {
        RevealTransition::Stale => Ok(false),
        RevealTransition::Shown(sample) => {
            if let Some(sample) = sample {
                if let Err(error) = crate::latency::record_for_app(&app, sample) {
                    if let Some(tray) = app.tray_by_id("main") {
                        let _ = tray.set_tooltip(Some(format!(
                            "Capso — overlay shown; timing evidence unavailable: {error}"
                        )));
                    }
                }
                if let Err(error) = crate::refresh_tray_status(&app) {
                    eprintln!("Could not refresh Capso overlay timing status: {error}");
                }
            }
            Ok(true)
        }
        RevealTransition::Failed(failure) => {
            release_quick_access_capture(&app, Path::new(&path));
            report_overlay_failure(&app, &failure);
            Err(failure.message)
        }
    }
}

#[tauri::command]
pub(crate) fn overlay_image_failed(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let failure = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        fail_transition(
            &mut runtime,
            &window,
            &path,
            presentation_id,
            "overlay_decode_failed",
            "The saved capture could not be decoded for the overlay preview.",
        )
    };
    let Some(failure) = failure else {
        return Ok(false);
    };

    release_quick_access_capture(&app, Path::new(&path));
    report_overlay_failure(&app, &failure);
    Ok(true)
}

#[tauri::command]
pub(crate) async fn overlay_copy_capture(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<ClipboardStatus, String> {
    let source = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        current_capture_path(&runtime, &path, presentation_id)?
    };

    let status = crate::clipboard::recopy_current_capture_to_general_pasteboard(app, source).await;
    if let Ok(mut runtime) = state.lock() {
        if let Some(capture) = runtime
            .current
            .as_mut()
            .filter(|capture| capture.path == path && capture.presentation_id == presentation_id)
        {
            capture.clipboard = status.clone();
        }
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn overlay_save_capture(
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    destination: String,
) -> Result<OverlaySaveResult, String> {
    if destination.trim().is_empty() {
        return Err("Choose a destination for the saved capture.".into());
    }

    let source = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        current_capture_path(&runtime, &path, presentation_id)?
    };
    let destination_path = PathBuf::from(&destination);
    if source == destination_path {
        return Err("Choose a different location for the saved copy.".into());
    }

    let bytes =
        tauri::async_runtime::spawn_blocking(move || export_capture(&source, &destination_path))
            .await
            .map_err(|error| format!("The capture export task stopped unexpectedly: {error}"))?
            .map_err(|error| format!("Could not save the capture copy: {error}"))?;

    Ok(OverlaySaveResult { destination, bytes })
}

fn drag_exports_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join("drag-exports"))
        .map_err(|error| format!("Could not locate Capso's drag cache: {error}"))
}

#[cfg(target_os = "macos")]
fn current_drag_gesture_state() -> DragGestureState {
    let state_id = CGEventSourceStateID::CombinedSessionState;
    DragGestureState {
        left_button_is_down: CGEventSource::button_state(state_id, CGMouseButton::Left),
        left_mouse_down_counter: CGEventSource::counter_for_event_type(
            state_id,
            CGEventType::LeftMouseDown,
        ),
    }
}

#[cfg(target_os = "macos")]
fn native_drag_options() -> drag::Options {
    drag::Options {
        mode: drag::DragMode::Copy,
        ..drag::Options::default()
    }
}

#[cfg(target_os = "macos")]
fn begin_native_drag(
    app: &AppHandle,
    window: &WebviewWindow,
    identity: OverlayDragIdentity,
    artifact: crate::dragout::PreparedDragArtifact,
) -> Result<(), String> {
    let export_path = artifact.export_path.clone();
    let preview_png = artifact.preview_png.clone();
    let artifact_owner = Arc::new(Mutex::new(Some(artifact)));
    let callback_owner = Arc::clone(&artifact_owner);
    let callback_app = app.clone();
    let callback_identity = identity.clone();

    let result = drag::start_drag(
        window,
        drag::DragItem::Files(vec![export_path]),
        drag::Image::Raw(preview_png),
        move |result, _cursor| {
            let outcome = match result {
                drag::DragResult::Dropped => OverlayDragOutcome::Dropped,
                drag::DragResult::Cancel => OverlayDragOutcome::Cancelled,
            };
            if outcome == OverlayDragOutcome::Dropped {
                if let Ok(mut owner) = callback_owner.lock() {
                    if let Some(artifact) = owner.take() {
                        // Keep the isolated friendly-name proxy until next
                        // launch so async destination apps can finish reading.
                        artifact.retain();
                    }
                }
            } else if let Ok(mut owner) = callback_owner.lock() {
                // Cancellation drops and cleans the isolated proxy now.
                let _ = owner.take();
            }

            let finished = callback_app
                .state::<Mutex<OverlayRuntime>>()
                .lock()
                .map(|mut runtime| runtime.finish_drag(&callback_identity))
                .unwrap_or(false);
            if finished {
                let _ = callback_app.emit_to(
                    OVERLAY_LABEL,
                    "overlay-drag-ended",
                    OverlayDragEnded {
                        path: callback_identity.path.clone(),
                        presentation_id: callback_identity.presentation_id,
                        outcome,
                    },
                );
            }
        },
        native_drag_options(),
    );

    if let Err(error) = result {
        if let Ok(mut runtime) = app.state::<Mutex<OverlayRuntime>>().lock() {
            let _ = runtime.finish_drag(&identity);
        }
        if let Ok(mut owner) = artifact_owner.lock() {
            if let Some(artifact) = owner.take() {
                crate::dragout::cleanup_drag_artifact(&artifact);
            }
        }
        return Err(format!("Could not start the macOS capture drag: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn overlay_start_drag(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    filename: String,
) -> Result<OverlayDragStarted, String> {
    let source = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        current_capture_path(&runtime, &path, presentation_id)?
    };
    let capture_directory = crate::history::capture_directory(&app)?;
    let export_root = drag_exports_directory(&app)?;

    #[cfg(target_os = "macos")]
    let initial_gesture = current_drag_gesture_state();

    #[cfg(target_os = "macos")]
    if !initial_gesture.left_button_is_down {
        return Err(
            "The original pointer gesture ended before the capture drag could start.".into(),
        );
    }

    let artifact = tauri::async_runtime::spawn_blocking(move || {
        crate::dragout::prepare_drag_artifact(&capture_directory, &export_root, &source, &filename)
    })
    .await
    .map_err(|error| format!("The capture drag task stopped unexpectedly: {error}"))??;

    let bytes = artifact.bytes;

    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window(OVERLAY_LABEL)
            .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let start_app = app.clone();
        app.run_on_main_thread(move || {
            let identity = start_app
                .state::<Mutex<OverlayRuntime>>()
                .lock()
                .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())
                .and_then(|mut runtime| {
                    begin_drag_transition(
                        &mut runtime,
                        &path,
                        presentation_id,
                        initial_gesture,
                        current_drag_gesture_state(),
                    )
                });
            let result = match identity {
                Ok(identity) => begin_native_drag(&start_app, &window, identity, artifact),
                Err(error) => {
                    crate::dragout::cleanup_drag_artifact(&artifact);
                    Err(error)
                }
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule the macOS capture drag: {error}"))?;

        tauri::async_runtime::spawn_blocking(move || receiver.recv())
            .await
            .map_err(|error| format!("The capture drag start task stopped unexpectedly: {error}"))?
            .map_err(|error| format!("The capture drag did not start: {error}"))??;
        Ok(OverlayDragStarted { bytes })
    }

    #[cfg(not(target_os = "macos"))]
    {
        crate::dragout::cleanup_drag_artifact(&artifact);
        let _ = (app, path, presentation_id);
        Err("Capture drag-out is only available in the macOS app.".into())
    }
}

#[tauri::command]
pub(crate) fn overlay_dismiss(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    reason: DismissReason,
) -> Result<bool, String> {
    let annotation_protected = app
        .state::<Mutex<crate::annotation::AnnotationRuntime>>()
        .lock()
        .map_err(|_| "The annotation editor state is temporarily unavailable.".to_string())?
        .protects_overlay(&path, presentation_id);
    if annotation_protected {
        return Ok(false);
    }
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let transition = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        dismiss_transition(&mut runtime, &window, &path, presentation_id)
    };

    match transition {
        DismissTransition::Stale => Ok(false),
        DismissTransition::Dismissed => {
            release_quick_access_capture(&app, Path::new(&path));
            let _ = app.emit(
                "capture-overlay-dismissed",
                OverlayDismissed {
                    path: &path,
                    presentation_id,
                    reason,
                },
            );
            Ok(true)
        }
        DismissTransition::Failed(failure) => {
            report_overlay_failure(&app, &failure);
            Err(failure.message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        annotation_refresh_payload, begin_drag_transition, bottom_right_position, capture_display,
        capture_matches, current_capture_path, dismiss_transition, display_at_cursor,
        export_capture, fail_transition, prepare_transition, reveal_transition,
        reveal_transition_with_clock, DismissTransition, DisplayGeometry, DragGestureState,
        OverlayCapture, OverlayDragEnded, OverlayDragOutcome, OverlayRuntime, OverlaySource,
        OverlayWindowOps, RevealTransition, ScreenPoint, ScreenRect, OVERLAY_HEIGHT_LOGICAL,
        OVERLAY_LABEL, OVERLAY_WIDTH_LOGICAL,
    };
    use crate::capture::CaptureMode;
    use crate::clipboard::ClipboardStatus;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct FakeWindow {
        visible: Cell<bool>,
        position: Cell<(i32, i32)>,
        fail_hide: Cell<bool>,
        fail_show: Cell<bool>,
        transitions: RefCell<Vec<&'static str>>,
    }

    impl OverlayWindowOps for FakeWindow {
        fn hide_overlay(&self) -> Result<(), String> {
            self.transitions.borrow_mut().push("hide");
            if self.fail_hide.get() {
                return Err("native hide rejected".into());
            }
            self.visible.set(false);
            Ok(())
        }

        fn show_overlay(&self) -> Result<(), String> {
            self.transitions.borrow_mut().push("show");
            if self.fail_show.get() {
                return Err("native show rejected".into());
            }
            self.visible.set(true);
            Ok(())
        }

        fn position_overlay(&self, x: i32, y: i32) -> Result<(), String> {
            self.transitions.borrow_mut().push("position");
            self.position.set((x, y));
            Ok(())
        }
    }

    fn capture(path: &str) -> OverlayCapture {
        capture_with_id(path, 1)
    }

    fn capture_with_id(path: &str, presentation_id: u64) -> OverlayCapture {
        OverlayCapture {
            path: path.into(),
            presentation_id,
            clipboard: ClipboardStatus::Copied { bytes: 42 },
            source: OverlaySource::Capture,
        }
    }

    fn display(bounds: ScreenRect, work_area: ScreenRect, scale_factor: f64) -> DisplayGeometry {
        DisplayGeometry {
            bounds,
            work_area,
            scale_factor,
        }
    }

    #[test]
    fn cursor_selects_the_capture_display_even_with_a_negative_origin() {
        let primary = display(
            ScreenRect {
                x: 0,
                y: 0,
                width: 3024,
                height: 1964,
            },
            ScreenRect {
                x: 0,
                y: 48,
                width: 3024,
                height: 1816,
            },
            2.0,
        );
        let external = display(
            ScreenRect {
                x: -2880,
                y: 0,
                width: 2880,
                height: 1800,
            },
            ScreenRect {
                x: -2880,
                y: 48,
                width: 2880,
                height: 1690,
            },
            2.0,
        );

        assert_eq!(
            display_at_cursor(
                &[primary, external],
                ScreenPoint {
                    x: -1440.0,
                    y: 900.0,
                },
            ),
            Some(external)
        );
    }

    #[test]
    fn overlay_sits_inside_the_bottom_right_of_the_target_work_area() {
        let external = display(
            ScreenRect {
                x: -2880,
                y: 0,
                width: 2880,
                height: 1800,
            },
            ScreenRect {
                x: -2880,
                y: 48,
                width: 2880,
                height: 1690,
            },
            2.0,
        );

        assert_eq!(bottom_right_position(external), (-544, 1310));
    }

    #[test]
    fn fullscreen_uses_the_main_display_even_when_the_cursor_is_external() {
        let primary = display(
            ScreenRect {
                x: 0,
                y: 0,
                width: 3024,
                height: 1964,
            },
            ScreenRect {
                x: 0,
                y: 48,
                width: 3024,
                height: 1816,
            },
            2.0,
        );
        let external = display(
            ScreenRect {
                x: -2880,
                y: 0,
                width: 2880,
                height: 1800,
            },
            ScreenRect {
                x: -2880,
                y: 48,
                width: 2880,
                height: 1690,
            },
            2.0,
        );

        assert_eq!(
            capture_display(CaptureMode::Fullscreen, Some(external), Some(primary)),
            Some(primary)
        );
        assert_eq!(
            capture_display(CaptureMode::Region, Some(external), Some(primary)),
            Some(external)
        );
        assert_eq!(
            capture_display(CaptureMode::Window, Some(external), Some(primary)),
            Some(external)
        );
    }

    #[test]
    fn stale_image_decode_cannot_reveal_a_newer_capture() {
        let current = OverlayCapture {
            path: "/tmp/capso/new.png".into(),
            presentation_id: 2,
            clipboard: ClipboardStatus::Copied { bytes: 42 },
            source: OverlaySource::Capture,
        };

        assert!(!capture_matches(Some(&current), "/tmp/capso/old.png", 2));
        assert!(capture_matches(Some(&current), "/tmp/capso/new.png", 2));
        assert!(!capture_matches(Some(&current), "/tmp/capso/new.png", 1));
        assert!(!capture_matches(None, "/tmp/capso/new.png", 2));
    }

    #[test]
    fn native_presentations_increase_even_when_the_capture_path_repeats() {
        let mut runtime = OverlayRuntime::default();
        let first = runtime.next_capture(
            "/tmp/capso/recent.png".into(),
            ClipboardStatus::Unchanged,
            OverlaySource::History,
        );
        let second = runtime.next_capture(
            "/tmp/capso/recent.png".into(),
            ClipboardStatus::Unchanged,
            OverlaySource::History,
        );

        assert_eq!(first.presentation_id, 1);
        assert_eq!(second.presentation_id, 2);
    }

    #[test]
    fn only_exact_fresh_capture_reveal_finishes_overlay_latency() {
        let path = "/tmp/capso/fresh.png";
        let started_at = std::time::Instant::now();
        let visible_at = started_at + std::time::Duration::from_millis(742);
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();

        prepare_transition(
            &mut runtime,
            &window,
            capture_with_id(path, 1),
            Some(crate::latency::OverlayLatencyStart::new(
                CaptureMode::Region,
                started_at,
            )),
            120,
            240,
        )
        .expect("fresh capture prepares");

        assert_eq!(
            reveal_transition_with_clock(&mut runtime, &window, path, 2, || visible_at),
            RevealTransition::Stale
        );
        assert_eq!(
            reveal_transition_with_clock(&mut runtime, &window, path, 1, || visible_at),
            RevealTransition::Shown(Some(crate::latency::OverlayLatencySample::new(
                CaptureMode::Region,
                742,
            )))
        );
        assert_eq!(
            reveal_transition_with_clock(&mut runtime, &window, path, 1, || visible_at),
            RevealTransition::Shown(None),
            "one visible presentation contributes at most one sample"
        );
    }

    #[test]
    fn history_and_decode_failure_never_contribute_latency_samples() {
        let history_path = "/tmp/capso/history.png";
        let window = FakeWindow::default();
        let mut history_runtime = OverlayRuntime::default();
        let history = OverlayCapture {
            path: history_path.into(),
            presentation_id: 1,
            clipboard: ClipboardStatus::Unchanged,
            source: OverlaySource::History,
        };
        prepare_transition(&mut history_runtime, &window, history, None, 120, 240)
            .expect("history prepares");
        assert_eq!(
            reveal_transition_with_clock(
                &mut history_runtime,
                &window,
                history_path,
                1,
                || panic!("history has no capture latency clock"),
            ),
            RevealTransition::Shown(None)
        );

        let failed_path = "/tmp/capso/decode-failed.png";
        let started_at = std::time::Instant::now();
        let mut failed_runtime = OverlayRuntime::default();
        prepare_transition(
            &mut failed_runtime,
            &window,
            capture_with_id(failed_path, 2),
            Some(crate::latency::OverlayLatencyStart::new(
                CaptureMode::Window,
                started_at,
            )),
            120,
            240,
        )
        .expect("fresh capture prepares");
        assert!(fail_transition(
            &mut failed_runtime,
            &window,
            failed_path,
            2,
            "overlay_decode_failed",
            "decode failed",
        )
        .is_some());
        assert!(failed_runtime.pending_latency.is_none());
        assert_eq!(
            reveal_transition_with_clock(&mut failed_runtime, &window, failed_path, 2, || {
                started_at
            },),
            RevealTransition::Stale
        );
    }

    #[test]
    fn annotation_cancel_and_save_refresh_to_a_new_timer_generation() {
        let path = "/tmp/capso/current.png";
        let mut cancel_runtime = OverlayRuntime::default();
        let current = cancel_runtime.next_capture(
            path.into(),
            ClipboardStatus::Copied { bytes: 42 },
            OverlaySource::Capture,
        );
        cancel_runtime.replace(current.clone());
        let (cancel_previous, cancel_payload) =
            annotation_refresh_payload(&mut cancel_runtime, path, current.presentation_id, None)
                .expect("cancel refresh");
        assert_eq!(cancel_previous, current);
        assert_eq!(cancel_payload.presentation_id, 2);
        assert_eq!(
            cancel_payload.clipboard,
            ClipboardStatus::Copied { bytes: 42 }
        );

        let mut save_runtime = OverlayRuntime::default();
        let current = save_runtime.next_capture(
            path.into(),
            ClipboardStatus::Unchanged,
            OverlaySource::Capture,
        );
        save_runtime.replace(current.clone());
        let (_, save_payload) = annotation_refresh_payload(
            &mut save_runtime,
            path,
            current.presentation_id,
            Some(&ClipboardStatus::Copied { bytes: 84 }),
        )
        .expect("save refresh");
        assert_eq!(save_payload.presentation_id, 2);
        assert_eq!(
            save_payload.clipboard,
            ClipboardStatus::Copied { bytes: 84 }
        );
    }

    #[test]
    fn old_same_path_callbacks_cannot_mutate_a_newer_restore() {
        let path = "/tmp/capso/recent.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id(path, 2));

        assert_eq!(
            reveal_transition(&mut runtime, &window, path, 1),
            RevealTransition::Stale
        );
        assert!(fail_transition(
            &mut runtime,
            &window,
            path,
            1,
            "overlay_decode_failed",
            "old decode failed",
        )
        .is_none());
        assert_eq!(
            dismiss_transition(&mut runtime, &window, path, 1),
            DismissTransition::Stale
        );
        assert!(current_capture_path(&runtime, path, 1).is_err());
        assert_eq!(
            current_capture_path(&runtime, path, 2).expect("new restore remains current"),
            std::path::PathBuf::from(path)
        );
        assert!(window.visible.get());
        assert_eq!(runtime.current, Some(capture_with_id(path, 2)));
    }

    #[test]
    fn native_drag_is_exact_single_flight_and_survives_capture_replacement() {
        let old_path = "/tmp/capso/old.png";
        let new_path = "/tmp/capso/new.png";
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id(old_path, 7));

        assert!(runtime.begin_drag(old_path, 6).is_err());
        let old_drag = runtime
            .begin_drag(old_path, 7)
            .expect("exact current drag starts");
        assert!(runtime.begin_drag(old_path, 7).is_err());

        runtime.replace(capture_with_id(new_path, 8));
        assert!(runtime.begin_drag(new_path, 8).is_err());
        assert!(runtime.finish_drag(&old_drag));
        assert!(!runtime.finish_drag(&old_drag));

        let new_drag = runtime
            .begin_drag(new_path, 8)
            .expect("new capture drags after old session finishes");
        assert_eq!(new_drag.path, new_path);
        assert_eq!(new_drag.presentation_id, 8);
    }

    #[test]
    fn repeated_path_drag_completion_cannot_finish_a_newer_presentation() {
        let path = "/tmp/capso/recent.png";
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id(path, 1));
        let old_drag = runtime.begin_drag(path, 1).expect("old drag starts");
        assert!(runtime.finish_drag(&old_drag));

        runtime.replace(capture_with_id(path, 2));
        let new_drag = runtime.begin_drag(path, 2).expect("new drag starts");

        assert!(!runtime.finish_drag(&old_drag));
        assert!(runtime.finish_drag(&new_drag));
    }

    #[test]
    fn released_pointer_never_arms_a_delayed_native_drag() {
        let path = "/tmp/capso/current.png";
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id(path, 3));

        let original_press = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 41,
        };
        let released = DragGestureState {
            left_button_is_down: false,
            left_mouse_down_counter: 41,
        };

        assert!(begin_drag_transition(&mut runtime, path, 3, original_press, released).is_err());
        assert!(runtime.active_drag.is_none());
        assert!(
            begin_drag_transition(&mut runtime, path, 3, original_press, original_press).is_ok()
        );
    }

    #[test]
    fn released_then_repressed_pointer_never_revives_the_old_drag() {
        let path = "/tmp/capso/current.png";
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id(path, 4));
        let original_press = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 91,
        };
        let later_press = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 92,
        };

        assert!(begin_drag_transition(&mut runtime, path, 4, original_press, later_press).is_err());
        assert!(runtime.active_drag.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_drag_advertises_copy_only() {
        assert!(matches!(
            super::native_drag_options().mode,
            drag::DragMode::Copy
        ));
    }

    #[test]
    fn native_drag_completion_event_is_exact_and_explicit() {
        let event = OverlayDragEnded {
            path: "/tmp/capso/current.png".into(),
            presentation_id: 12,
            outcome: OverlayDragOutcome::Dropped,
        };

        assert_eq!(
            serde_json::to_value(event).expect("serialize drag completion"),
            serde_json::json!({
                "path": "/tmp/capso/current.png",
                "presentationId": 12,
                "outcome": "dropped"
            })
        );
    }

    #[test]
    fn restored_overlay_payload_is_explicit_and_does_not_claim_clipboard_copy() {
        let restored = OverlayCapture {
            path: "/tmp/capso/history.png".into(),
            presentation_id: 7,
            clipboard: ClipboardStatus::Unchanged,
            source: OverlaySource::History,
        };

        assert_eq!(
            serde_json::to_value(restored).expect("serialize restored overlay"),
            serde_json::json!({
                "path": "/tmp/capso/history.png",
                "presentationId": 7,
                "clipboard": { "status": "unchanged" },
                "source": "history"
            })
        );
    }

    #[test]
    fn failed_delivery_rolls_back_only_the_exact_current_capture() {
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture("/tmp/capso/new.png"));

        assert!(runtime
            .fail_if_current(
                "/tmp/capso/old.png",
                1,
                "overlay_event_failed",
                "old failure"
            )
            .is_none());
        assert_eq!(
            runtime
                .current
                .as_ref()
                .map(|capture| capture.path.as_str()),
            Some("/tmp/capso/new.png")
        );

        let failure = runtime
            .fail_if_current(
                "/tmp/capso/new.png",
                1,
                "overlay_decode_failed",
                "new failure",
            )
            .expect("current capture rolls back");
        assert_eq!(failure.path, "/tmp/capso/new.png");
        assert_eq!(failure.code, "overlay_decode_failed");
        assert!(runtime.current.is_none());
        assert_eq!(runtime.last_failure, Some(failure));
    }

    #[test]
    fn ready_and_new_prepare_are_linearized_in_either_order() {
        let old_path = "/tmp/capso/old.png";
        let new_path = "/tmp/capso/new.png";

        // If old ready wins the lock first, new prepare hides it before
        // committing the new still-hidden preview.
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(old_path));
        assert_eq!(
            reveal_transition(&mut runtime, &window, old_path, 1),
            RevealTransition::Shown(None)
        );
        prepare_transition(&mut runtime, &window, capture(new_path), None, 120, 240)
            .expect("new capture prepares");
        assert!(!window.visible.get());
        assert_eq!(runtime.current, Some(capture(new_path)));

        // If new prepare wins first, the stale old callback is rejected and
        // cannot show the window while the new image is still decoding.
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(old_path));
        prepare_transition(&mut runtime, &window, capture(new_path), None, 120, 240)
            .expect("new capture prepares");
        assert_eq!(
            reveal_transition(&mut runtime, &window, old_path, 1),
            RevealTransition::Stale
        );
        assert!(!window.visible.get());
        assert_eq!(window.position.get(), (120, 240));
    }

    #[test]
    fn stale_failure_and_new_ready_are_linearized_in_either_order() {
        let old_path = "/tmp/capso/old.png";
        let new_path = "/tmp/capso/new.png";

        // If the old failure wins first, the subsequent new prepare/ready
        // sequence is authoritative and ends visible.
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(old_path));
        assert!(fail_transition(
            &mut runtime,
            &window,
            old_path,
            1,
            "overlay_decode_failed",
            "old failed",
        )
        .is_some());
        prepare_transition(&mut runtime, &window, capture(new_path), None, 120, 240)
            .expect("new capture prepares");
        assert_eq!(
            reveal_transition(&mut runtime, &window, new_path, 1),
            RevealTransition::Shown(None)
        );
        assert!(window.visible.get());

        // If the new preview is already current and visible, the stale old
        // failure cannot clear it or hide its window.
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(new_path));
        assert_eq!(
            reveal_transition(&mut runtime, &window, new_path, 1),
            RevealTransition::Shown(None)
        );
        assert!(fail_transition(
            &mut runtime,
            &window,
            old_path,
            1,
            "overlay_decode_failed",
            "old failed",
        )
        .is_none());
        assert!(window.visible.get());
        assert_eq!(runtime.current, Some(capture(new_path)));
    }

    #[test]
    fn native_show_failure_clears_and_hides_the_exact_preview() {
        let path = "/tmp/capso/current.png";
        let window = FakeWindow::default();
        window.fail_show.set(true);
        let mut runtime = OverlayRuntime::default();
        prepare_transition(
            &mut runtime,
            &window,
            capture(path),
            Some(crate::latency::OverlayLatencyStart::new(
                CaptureMode::Fullscreen,
                std::time::Instant::now(),
            )),
            120,
            240,
        )
        .expect("fresh capture prepares");

        let RevealTransition::Failed(failure) = reveal_transition(&mut runtime, &window, path, 1)
        else {
            panic!("native show failure must be reported");
        };

        assert_eq!(failure.code, "overlay_show_failed");
        assert!(failure.message.contains("native show rejected"));
        assert!(runtime.current.is_none());
        assert!(runtime.pending_latency.is_none());
        assert_eq!(runtime.last_failure, Some(failure));
        assert!(!window.visible.get());
        assert_eq!(
            *window.transitions.borrow(),
            vec!["hide", "position", "show", "hide"]
        );
    }

    #[test]
    fn dismiss_is_exact_and_cannot_hide_a_newer_capture() {
        let old_path = "/tmp/capso/old.png";
        let new_path = "/tmp/capso/new.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(new_path));

        assert_eq!(
            dismiss_transition(&mut runtime, &window, old_path, 1),
            DismissTransition::Stale
        );
        assert!(window.visible.get());
        assert_eq!(runtime.current, Some(capture(new_path)));

        assert_eq!(
            dismiss_transition(&mut runtime, &window, new_path, 1),
            DismissTransition::Dismissed
        );
        assert!(!window.visible.get());
        assert!(runtime.current.is_none());
        assert_eq!(*window.transitions.borrow(), vec!["hide"]);
    }

    #[test]
    fn failed_dismiss_keeps_the_exact_capture_available_for_retry() {
        let path = "/tmp/capso/current.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        window.fail_hide.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(path));

        let DismissTransition::Failed(failure) = dismiss_transition(&mut runtime, &window, path, 1)
        else {
            panic!("native hide failure must be reported");
        };
        assert_eq!(failure.code, "overlay_dismiss_failed");
        assert_eq!(runtime.current, Some(capture(path)));
        assert!(window.visible.get());

        window.fail_hide.set(false);
        assert_eq!(
            dismiss_transition(&mut runtime, &window, path, 1),
            DismissTransition::Dismissed
        );
        assert!(runtime.current.is_none());
        assert!(!window.visible.get());
    }

    #[test]
    fn copy_and_save_actions_reject_a_stale_capture_path() {
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture("/tmp/capso/new.png"));

        assert!(current_capture_path(&runtime, "/tmp/capso/old.png", 1).is_err());
        assert_eq!(
            current_capture_path(&runtime, "/tmp/capso/new.png", 1).expect("current capture"),
            std::path::PathBuf::from("/tmp/capso/new.png")
        );
    }

    #[test]
    fn save_as_exports_exact_bytes_without_mutating_the_durable_capture() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.png");
        let destination = directory.path().join("Capso capture.png");
        let pixels = b"\x89PNG\r\n\x1a\nexact-action-export";
        std::fs::write(&source, pixels).expect("write source capture");

        assert_eq!(
            export_capture(&source, &destination).expect("export succeeds"),
            pixels.len() as u64
        );
        assert_eq!(std::fs::read(&source).expect("source remains"), pixels);
        assert_eq!(
            std::fs::read(&destination).expect("destination exists"),
            pixels
        );
    }

    #[test]
    fn save_as_is_safe_when_the_destination_aliases_the_durable_capture() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.png");
        let alias = directory.path().join("alias.png");
        let pixels = b"\x89PNG\r\n\x1a\nsource-cannot-be-truncated";
        std::fs::write(&source, pixels).expect("write source capture");

        assert_eq!(
            export_capture(&source, &source).expect("same path remains safe"),
            pixels.len() as u64
        );
        assert_eq!(std::fs::read(&source).expect("source remains"), pixels);

        std::fs::hard_link(&source, &alias).expect("create aliased destination");
        assert_eq!(
            export_capture(&source, &alias).expect("hard-link alias remains safe"),
            pixels.len() as u64
        );
        assert_eq!(std::fs::read(&source).expect("source remains"), pixels);
        assert_eq!(std::fs::read(&alias).expect("alias remains"), pixels);
    }

    #[test]
    fn bundled_overlay_window_is_hidden_non_activating_and_capture_scoped() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let windows = config["app"]["windows"]
            .as_array()
            .expect("window configurations");
        let overlay = windows
            .iter()
            .find(|window| window["label"] == OVERLAY_LABEL)
            .expect("capture overlay window");

        assert_eq!(overlay["url"], "index.html?surface=overlay");
        assert_eq!(overlay["width"], OVERLAY_WIDTH_LOGICAL);
        assert_eq!(overlay["height"], OVERLAY_HEIGHT_LOGICAL);
        assert_eq!(overlay["visible"], false);
        assert_eq!(overlay["focus"], false);
        assert_eq!(overlay["focusable"], false);
        assert_eq!(overlay["alwaysOnTop"], true);
        assert_eq!(overlay["visibleOnAllWorkspaces"], true);
        assert_eq!(overlay["decorations"], false);
        assert_eq!(overlay["resizable"], false);

        assert_eq!(config["app"]["security"]["assetProtocol"]["enable"], true);
        assert_eq!(
            config["app"]["security"]["assetProtocol"]["scope"],
            serde_json::json!(["$APPDATA/captures/**"])
        );

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/capture-overlay.json"))
                .expect("valid overlay capability");
        assert!(capability["windows"]
            .as_array()
            .expect("capability windows")
            .iter()
            .any(|window| window == OVERLAY_LABEL));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["core:event:default", "dialog:allow-save"])
        );
    }
}
