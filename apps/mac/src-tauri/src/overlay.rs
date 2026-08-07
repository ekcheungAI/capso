use crate::{capture::CaptureMode, clipboard::ClipboardStatus};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::Mutex,
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
    clipboard: ClipboardStatus,
}

#[derive(Default)]
pub(crate) struct OverlayRuntime {
    current: Option<OverlayCapture>,
    last_failure: Option<OverlayFailureRecord>,
}

impl OverlayRuntime {
    fn reset(&mut self) {
        self.current = None;
        self.last_failure = None;
    }

    fn replace(&mut self, capture: OverlayCapture) {
        self.current = Some(capture);
        self.last_failure = None;
    }

    fn record_failure(
        &mut self,
        path: &str,
        code: &'static str,
        message: impl Into<String>,
    ) -> OverlayFailureRecord {
        let failure = OverlayFailureRecord {
            path: path.into(),
            code,
            message: message.into(),
        };
        self.last_failure = Some(failure.clone());
        failure
    }

    fn fail_if_current(
        &mut self,
        path: &str,
        code: &'static str,
        message: impl Into<String>,
    ) -> Option<OverlayFailureRecord> {
        if !capture_matches_path(self.current.as_ref(), path) {
            return None;
        }

        self.current = None;
        Some(self.record_failure(path, code, message))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayFailureRecord {
    path: String,
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
    Shown,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayDismissed<'a> {
    path: &'a str,
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

fn capture_matches_path(current: Option<&OverlayCapture>, path: &str) -> bool {
    current.is_some_and(|capture| capture.path == path)
}

fn prepare_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    capture: OverlayCapture,
    x: i32,
    y: i32,
) -> Result<(), OverlayFailureRecord> {
    let path = capture.path.clone();

    // Reset, hide, position and replace are one serialized transition. A ready
    // or failed callback cannot interleave and mutate visibility for an older
    // capture while a newer capture is being prepared.
    runtime.reset();
    if let Err(error) = window.hide_overlay() {
        return Err(runtime.record_failure(
            &path,
            "overlay_hide_failed",
            format!("Could not reset the capture overlay: {error}"),
        ));
    }
    if let Err(error) = window.position_overlay(x, y) {
        return Err(runtime.record_failure(
            &path,
            "overlay_position_failed",
            format!("Could not position the capture overlay: {error}"),
        ));
    }

    runtime.replace(capture);
    Ok(())
}

fn reveal_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
) -> RevealTransition {
    if !capture_matches_path(runtime.current.as_ref(), path) {
        return RevealTransition::Stale;
    }

    match window.show_overlay() {
        Ok(()) => RevealTransition::Shown,
        Err(error) => {
            let failure = runtime
                .fail_if_current(
                    path,
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
    code: &'static str,
    message: impl Into<String>,
) -> Option<OverlayFailureRecord> {
    let failure = runtime.fail_if_current(path, code, message);
    if failure.is_some() {
        let _ = window.hide_overlay();
    }
    failure
}

fn dismiss_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
) -> DismissTransition {
    if !capture_matches_path(runtime.current.as_ref(), path) {
        return DismissTransition::Stale;
    }

    match window.hide_overlay() {
        Ok(()) => {
            runtime.reset();
            DismissTransition::Dismissed
        }
        Err(error) => DismissTransition::Failed(runtime.record_failure(
            path,
            "overlay_dismiss_failed",
            format!("Could not dismiss the capture overlay: {error}"),
        )),
    }
}

fn current_capture_path(runtime: &OverlayRuntime, path: &str) -> Result<PathBuf, String> {
    runtime
        .current
        .as_ref()
        .filter(|capture| capture.path == path)
        .map(|capture| PathBuf::from(&capture.path))
        .ok_or_else(|| "That capture is no longer active in the overlay.".to_string())
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
) -> OverlayStatus {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return overlay_failure(
            "overlay_unavailable",
            "The capture overlay window is unavailable.",
        );
    };
    let display = match target_display(app, mode) {
        Ok(display) => display,
        Err(status) => return status,
    };
    let (x, y) = bottom_right_position(display);
    let payload = OverlayCapture {
        path: path.to_string_lossy().into_owned(),
        clipboard: clipboard.clone(),
    };

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

    if let Err(failure) = prepare_transition(&mut runtime, &window, payload.clone(), x, y) {
        return overlay_failure(failure.code, failure.message);
    }

    // Keep the transition lock through delivery: a ready callback can run only
    // after the matching payload is committed, and failed delivery is cleared
    // before another capture can replace it.
    if let Err(error) = app.emit_to(OVERLAY_LABEL, "overlay-capture", payload) {
        let message = format!("Could not update the capture overlay: {error}");
        let _ = runtime.fail_if_current(
            path.to_string_lossy().as_ref(),
            "overlay_event_failed",
            &message,
        );
        return overlay_failure("overlay_event_failed", message);
    }

    OverlayStatus::Prepared { x, y }
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
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let transition = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        reveal_transition(&mut runtime, &window, &path)
    };

    match transition {
        RevealTransition::Stale => Ok(false),
        RevealTransition::Shown => Ok(true),
        RevealTransition::Failed(failure) => {
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
            "overlay_decode_failed",
            "The saved capture could not be decoded for the overlay preview.",
        )
    };
    let Some(failure) = failure else {
        return Ok(false);
    };

    report_overlay_failure(&app, &failure);
    Ok(true)
}

#[tauri::command]
pub(crate) async fn overlay_copy_capture(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
) -> Result<ClipboardStatus, String> {
    let source = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        current_capture_path(&runtime, &path)?
    };

    let status = crate::clipboard::recopy_current_capture_to_general_pasteboard(app, source).await;
    if let Ok(mut runtime) = state.lock() {
        if let Some(capture) = runtime
            .current
            .as_mut()
            .filter(|capture| capture.path == path)
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
    destination: String,
) -> Result<OverlaySaveResult, String> {
    if destination.trim().is_empty() {
        return Err("Choose a destination for the saved capture.".into());
    }

    let source = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        current_capture_path(&runtime, &path)?
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

#[tauri::command]
pub(crate) fn overlay_dismiss(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    reason: DismissReason,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let transition = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        dismiss_transition(&mut runtime, &window, &path)
    };

    match transition {
        DismissTransition::Stale => Ok(false),
        DismissTransition::Dismissed => {
            let _ = app.emit(
                "capture-overlay-dismissed",
                OverlayDismissed {
                    path: &path,
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
        bottom_right_position, capture_display, capture_matches_path, current_capture_path,
        dismiss_transition, display_at_cursor, export_capture, fail_transition, prepare_transition,
        reveal_transition, DismissTransition, DisplayGeometry, OverlayCapture, OverlayRuntime,
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
        OverlayCapture {
            path: path.into(),
            clipboard: ClipboardStatus::Copied { bytes: 42 },
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
            clipboard: ClipboardStatus::Copied { bytes: 42 },
        };

        assert!(!capture_matches_path(Some(&current), "/tmp/capso/old.png"));
        assert!(capture_matches_path(Some(&current), "/tmp/capso/new.png"));
        assert!(!capture_matches_path(None, "/tmp/capso/new.png"));
    }

    #[test]
    fn failed_delivery_rolls_back_only_the_exact_current_capture() {
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture("/tmp/capso/new.png"));

        assert!(runtime
            .fail_if_current("/tmp/capso/old.png", "overlay_event_failed", "old failure")
            .is_none());
        assert_eq!(
            runtime
                .current
                .as_ref()
                .map(|capture| capture.path.as_str()),
            Some("/tmp/capso/new.png")
        );

        let failure = runtime
            .fail_if_current("/tmp/capso/new.png", "overlay_decode_failed", "new failure")
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
            reveal_transition(&mut runtime, &window, old_path),
            RevealTransition::Shown
        );
        prepare_transition(&mut runtime, &window, capture(new_path), 120, 240)
            .expect("new capture prepares");
        assert!(!window.visible.get());
        assert_eq!(runtime.current, Some(capture(new_path)));

        // If new prepare wins first, the stale old callback is rejected and
        // cannot show the window while the new image is still decoding.
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(old_path));
        prepare_transition(&mut runtime, &window, capture(new_path), 120, 240)
            .expect("new capture prepares");
        assert_eq!(
            reveal_transition(&mut runtime, &window, old_path),
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
            "overlay_decode_failed",
            "old failed",
        )
        .is_some());
        prepare_transition(&mut runtime, &window, capture(new_path), 120, 240)
            .expect("new capture prepares");
        assert_eq!(
            reveal_transition(&mut runtime, &window, new_path),
            RevealTransition::Shown
        );
        assert!(window.visible.get());

        // If the new preview is already current and visible, the stale old
        // failure cannot clear it or hide its window.
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(new_path));
        assert_eq!(
            reveal_transition(&mut runtime, &window, new_path),
            RevealTransition::Shown
        );
        assert!(fail_transition(
            &mut runtime,
            &window,
            old_path,
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
        runtime.replace(capture(path));

        let RevealTransition::Failed(failure) = reveal_transition(&mut runtime, &window, path)
        else {
            panic!("native show failure must be reported");
        };

        assert_eq!(failure.code, "overlay_show_failed");
        assert!(failure.message.contains("native show rejected"));
        assert!(runtime.current.is_none());
        assert_eq!(runtime.last_failure, Some(failure));
        assert!(!window.visible.get());
        assert_eq!(*window.transitions.borrow(), vec!["show", "hide"]);
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
            dismiss_transition(&mut runtime, &window, old_path),
            DismissTransition::Stale
        );
        assert!(window.visible.get());
        assert_eq!(runtime.current, Some(capture(new_path)));

        assert_eq!(
            dismiss_transition(&mut runtime, &window, new_path),
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

        let DismissTransition::Failed(failure) = dismiss_transition(&mut runtime, &window, path)
        else {
            panic!("native hide failure must be reported");
        };
        assert_eq!(failure.code, "overlay_dismiss_failed");
        assert_eq!(runtime.current, Some(capture(path)));
        assert!(window.visible.get());

        window.fail_hide.set(false);
        assert_eq!(
            dismiss_transition(&mut runtime, &window, path),
            DismissTransition::Dismissed
        );
        assert!(runtime.current.is_none());
        assert!(!window.visible.get());
    }

    #[test]
    fn copy_and_save_actions_reject_a_stale_capture_path() {
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture("/tmp/capso/new.png"));

        assert!(current_capture_path(&runtime, "/tmp/capso/old.png").is_err());
        assert_eq!(
            current_capture_path(&runtime, "/tmp/capso/new.png").expect("current capture"),
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
