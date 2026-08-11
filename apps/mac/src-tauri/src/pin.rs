use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State};

pub(crate) const PIN_LABEL: &str = "pinned-capture";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PinCapture {
    path: String,
    presentation_id: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinCopyEvent {
    presentation_id: u64,
    result: crate::clipboard::ClipboardStatus,
}

#[derive(Default)]
pub(crate) struct PinRuntime {
    current: Option<PinCapture>,
    generation: u64,
}

impl PinRuntime {
    fn replace(&mut self, path: PathBuf) -> PinCapture {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("pin presentation generation cannot exhaust u64");
        let capture = PinCapture {
            path: path.to_string_lossy().into_owned(),
            presentation_id: self.generation,
        };
        self.current = Some(capture.clone());
        capture
    }

    fn current_path(&self, presentation_id: u64) -> Result<PathBuf, String> {
        self.current
            .as_ref()
            .filter(|capture| capture.presentation_id == presentation_id)
            .map(|capture| PathBuf::from(&capture.path))
            .ok_or_else(|| "That pinned capture is no longer active.".to_string())
    }

    fn clear(&mut self, presentation_id: u64) -> bool {
        if self
            .current
            .as_ref()
            .is_some_and(|capture| capture.presentation_id == presentation_id)
        {
            self.current = None;
            true
        } else {
            false
        }
    }
}

fn pin_window_size(path: &std::path::Path) -> Result<LogicalSize<f64>, String> {
    let (width, height) = image::image_dimensions(path)
        .map_err(|error| format!("Could not inspect the capture for pinning: {error}"))?;
    let width = f64::from(width.max(1));
    let height = f64::from(height.max(1));
    let scale = (560.0 / width).min(420.0 / height).min(1.0);
    Ok(LogicalSize::new(
        (width * scale).max(180.0),
        (height * scale).max(120.0),
    ))
}

#[tauri::command]
pub(crate) fn pin_overlay_capture(
    app: AppHandle,
    overlay_state: State<'_, Mutex<crate::overlay::OverlayRuntime>>,
    pin_state: State<'_, Mutex<PinRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<PinCapture, String> {
    let source =
        crate::overlay::current_capture_for_action(overlay_state.inner(), &path, presentation_id)?;
    let size = pin_window_size(&source)?;
    let window = app
        .get_webview_window(PIN_LABEL)
        .ok_or_else(|| "The pinned capture window is unavailable.".to_string())?;
    window
        .hide()
        .map_err(|error| format!("Could not reset the pinned capture: {error}"))?;
    window
        .set_size(size)
        .map_err(|error| format!("Could not size the pinned capture: {error}"))?;

    let capture = pin_state
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?
        .replace(source);
    window
        .show()
        .map_err(|error| format!("Could not show the pinned capture: {error}"))?;
    app.emit_to(PIN_LABEL, "pin-capture", capture.clone())
        .map_err(|error| format!("Could not present the pinned capture: {error}"))?;
    Ok(capture)
}

#[tauri::command]
pub(crate) fn get_pin_capture(
    state: State<'_, Mutex<PinRuntime>>,
) -> Result<Option<PinCapture>, String> {
    state
        .lock()
        .map(|runtime| runtime.current.clone())
        .map_err(|_| "The pinned capture state is temporarily unavailable.".into())
}

#[tauri::command]
pub(crate) fn pin_image_ready(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    presentation_id: u64,
) -> Result<bool, String> {
    let is_current = state
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?
        .current
        .as_ref()
        .is_some_and(|capture| capture.presentation_id == presentation_id);
    if !is_current {
        return Ok(false);
    }
    app.get_webview_window(PIN_LABEL)
        .ok_or_else(|| "The pinned capture window is unavailable.".to_string())?
        .show()
        .map_err(|error| format!("Could not show the pinned capture: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn copy_pin_capture(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    presentation_id: u64,
) -> Result<bool, String> {
    let source = state
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?
        .current_path(presentation_id)?;
    let event_app = app.clone();
    crate::clipboard::schedule_recopy_current_capture_to_general_pasteboard(
        app,
        source,
        move |result| {
            let _ = event_app.emit_to(
                PIN_LABEL,
                "pin-copy-finished",
                PinCopyEvent {
                    presentation_id,
                    result,
                },
            );
        },
    )
    .await
    .map_err(|status| status.user_message())?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn close_pin_capture(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    presentation_id: u64,
) -> Result<bool, String> {
    let cleared = state
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?
        .clear(presentation_id);
    if cleared {
        app.get_webview_window(PIN_LABEL)
            .ok_or_else(|| "The pinned capture window is unavailable.".to_string())?
            .hide()
            .map_err(|error| format!("Could not close the pinned capture: {error}"))?;
    }
    Ok(cleared)
}

pub(crate) fn clear_from_window_close(app: &AppHandle) {
    if let Ok(mut runtime) = app.state::<Mutex<PinRuntime>>().lock() {
        runtime.current = None;
    }
}

#[cfg(test)]
mod tests {
    use super::PinRuntime;
    use std::path::PathBuf;

    #[test]
    fn replacing_a_pin_invalidates_old_window_actions() {
        let mut runtime = PinRuntime::default();
        let old = runtime.replace(PathBuf::from("/captures/old.png"));
        let new = runtime.replace(PathBuf::from("/captures/new.png"));

        assert!(new.presentation_id > old.presentation_id);
        assert!(runtime.current_path(old.presentation_id).is_err());
        assert_eq!(
            runtime.current_path(new.presentation_id).unwrap(),
            PathBuf::from("/captures/new.png")
        );
        assert!(!runtime.clear(old.presentation_id));
        assert!(runtime.clear(new.presentation_id));
    }
}
