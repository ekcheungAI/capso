mod capture;
mod clipboard;
mod dragout;
mod history;
mod overlay;
mod queue;
mod shortcuts;
mod system;

use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

struct TauriShortcutRegistry<'a> {
    app: &'a AppHandle,
}

impl shortcuts::ShortcutRegistry for TauriShortcutRegistry<'_> {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String> {
        self.app
            .global_shortcut()
            .register(shortcut)
            .map_err(|error| error.to_string())
    }

    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
        self.app
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| error.to_string())
    }

    fn is_registered(&self, shortcut: Shortcut) -> bool {
        self.app.global_shortcut().is_registered(shortcut)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum CaptureEvent<'a> {
    Captured {
        path: &'a str,
        clipboard: &'a clipboard::ClipboardStatus,
        overlay: &'a overlay::OverlayStatus,
        queue: &'a queue::CaptureQueueStatus,
    },
    Cancelled,
    Failed {
        code: &'static str,
        message: &'a str,
    },
}

fn capture_event(
    result: &Result<capture::CaptureOutcome, capture::CaptureFailure>,
) -> CaptureEvent<'_> {
    match result {
        Ok(capture::CaptureOutcome::Captured {
            path,
            clipboard,
            overlay,
            queue,
        }) => CaptureEvent::Captured {
            path,
            clipboard,
            overlay,
            queue,
        },
        Ok(capture::CaptureOutcome::Cancelled) => CaptureEvent::Cancelled,
        Err(error) => CaptureEvent::Failed {
            code: error.code,
            message: &error.message,
        },
    }
}

fn launch_capture(app: AppHandle, action: shortcuts::CaptureAction) {
    if system::permission_for_capture(action.mode(), system::screen_recording_granted())
        == system::CapturePermission::RequiresScreenRecording
    {
        show_permission_guidance(&app);
        return;
    }

    let _capture_task = tauri::async_runtime::spawn(async move {
        let result = capture::capture_screen(app.clone(), action.mode()).await;

        if let Some(tray) = app.tray_by_id("main") {
            match &result {
                Err(error) => {
                    let _ = tray.set_tooltip(Some(format!("Capso — {}", error.message)));
                }
                Ok(capture::CaptureOutcome::Captured {
                    clipboard: clipboard::ClipboardStatus::Failed { message, .. },
                    ..
                }) => {
                    let _ = tray.set_tooltip(Some(format!("Capso — capture saved; {message}")));
                }
                Ok(capture::CaptureOutcome::Captured {
                    overlay: overlay::OverlayStatus::Failed { message, .. },
                    ..
                }) => {
                    let _ = tray.set_tooltip(Some(format!("Capso — capture saved; {message}")));
                }
                Ok(capture::CaptureOutcome::Captured {
                    queue: queue::CaptureQueueStatus::Failed { message, .. },
                    ..
                }) => {
                    let _ = tray.set_tooltip(Some(format!(
                        "Capso — capture saved locally; queue needs attention: {message}"
                    )));
                }
                Ok(_) => {}
            }
        }

        let _ = app.emit("capture-finished", capture_event(&result));
    });
}

fn show_permission_guidance(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Ok(status) = current_system_status(app) {
        let _ = app.emit("system-status-changed", status);
    }
    if let Err(error) = refresh_tray_status(app) {
        eprintln!("Could not refresh the Capso permission guidance: {error}");
    }
}

/// Show the popover and give it focus; hide it if it is already visible.
fn toggle_popover(window: &WebviewWindow) -> tauri::Result<()> {
    if window.is_visible()? {
        window.hide()
    } else {
        window.show()?;
        window.set_focus()
    }
}

fn shortcut_settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("shortcut-settings.json"))
        .map_err(|error| format!("Could not locate the Capso settings directory: {error}"))
}

fn tray_tooltip(
    shortcut_status: &shortcuts::ShortcutStatus,
    system_status: &system::SystemStatus,
    queue_status: &queue::QueueRuntimeStatus,
) -> &'static str {
    if system_status.screen_recording == system::ScreenRecordingStatus::Required {
        "Capso — Screen Recording needed for Window and Fullscreen"
    } else if queue_status.warning.is_some() || queue_status.summary.failed > 0 {
        "Capso — uploads need attention; captures remain saved locally"
    } else if !shortcut_status.conflicts.is_empty() {
        "Capso — shortcut conflict; Capture menu remains available"
    } else if shortcut_status.storage_warning.is_some() {
        "Capso — shortcut settings warning; defaults are active"
    } else if queue_status.summary.queued() > 0 {
        "Capso — captures saved locally and waiting to sync"
    } else {
        "Capso"
    }
}

fn queue_menu_label(status: &queue::QueueRuntimeStatus) -> Option<String> {
    if status.warning.is_some() {
        return Some("Uploads need attention — captures remain local".into());
    }
    if status.summary.failed > 0 {
        return Some(format!(
            "{} {} need manual retry",
            status.summary.failed,
            if status.summary.failed == 1 {
                "capture"
            } else {
                "captures"
            }
        ));
    }
    let queued = status.summary.queued();
    (queued > 0).then(|| {
        format!(
            "{queued} {} saved locally — sync pending",
            if queued == 1 { "capture" } else { "captures" }
        )
    })
}

fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    shortcut_status: &shortcuts::ShortcutStatus,
    system_status: &system::SystemStatus,
    queue_status: &queue::QueueRuntimeStatus,
) -> tauri::Result<Menu<R>> {
    let mut menu_builder = MenuBuilder::new(app);
    for definition in shortcuts::definitions() {
        let needs_permission = system_status.screen_recording
            == system::ScreenRecordingStatus::Required
            && system::permission_for_capture(definition.action.mode(), false)
                == system::CapturePermission::RequiresScreenRecording;
        let label = if needs_permission {
            format!("{} — Permission required", definition.menu_label)
        } else {
            definition.menu_label.into()
        };
        menu_builder = menu_builder.text(definition.menu_id, label);
    }

    let mut recent_builder = SubmenuBuilder::with_id(app, "recent-captures", "Recent Captures");
    match history::recent_captures_for_app(app) {
        Ok(captures) if captures.is_empty() => {
            let empty = MenuItem::with_id(
                app,
                "recent-captures-empty",
                "No captures yet",
                false,
                None::<&str>,
            )?;
            recent_builder = recent_builder.item(&empty);
        }
        Ok(captures) => {
            let now = std::time::SystemTime::now();
            for capture in captures {
                recent_builder = recent_builder.text(
                    history::recent_menu_id(&capture.id),
                    history::recent_capture_label(&capture, now),
                );
            }
        }
        Err(_) => {
            let unavailable = MenuItem::with_id(
                app,
                "recent-captures-unavailable",
                "Recent captures unavailable",
                false,
                None::<&str>,
            )?;
            recent_builder = recent_builder.item(&unavailable);
        }
    }
    let recent_submenu = recent_builder.build()?;
    menu_builder = menu_builder.separator().item(&recent_submenu);

    if let Some(label) = queue_menu_label(queue_status) {
        let queue_item = MenuItem::with_id(app, "upload-queue-status", label, false, None::<&str>)?;
        menu_builder = menu_builder.item(&queue_item);
    }

    if system_status.screen_recording == system::ScreenRecordingStatus::Required {
        let permission_warning = MenuItem::with_id(
            app,
            "screen-recording-warning",
            "Screen Recording required — open Capso to grant",
            false,
            None::<&str>,
        )?;
        menu_builder = menu_builder.separator().item(&permission_warning);
    }

    let warning_label = shortcuts::conflict_label(&shortcut_status.conflicts)
        .or_else(|| shortcut_status.storage_warning.clone());
    let warning_item = warning_label
        .as_ref()
        .map(|label| MenuItem::with_id(app, "shortcut-warning", label, false, None::<&str>))
        .transpose()?;
    if let Some(item) = &warning_item {
        menu_builder = menu_builder.separator().item(item);
    }

    let quit = MenuItem::with_id(app, "quit", "Quit Capso", true, Some("cmd+q"))?;
    menu_builder.separator().item(&quit).build()
}

fn current_system_status(app: &AppHandle) -> Result<system::SystemStatus, String> {
    app.state::<Mutex<system::PermissionRuntime>>()
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "System settings are temporarily unavailable".into())
}

fn current_shortcut_status(app: &AppHandle) -> Result<shortcuts::ShortcutStatus, String> {
    app.state::<Mutex<shortcuts::ShortcutRuntime>>()
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "Shortcut settings are temporarily unavailable".into())
}

fn current_queue_status(app: &AppHandle) -> Result<queue::QueueRuntimeStatus, String> {
    queue::current_status(app)
}

fn refresh_tray_status(app: &AppHandle) -> Result<(), String> {
    let shortcut_status = current_shortcut_status(app)?;
    let system_status = current_system_status(app)?;
    let queue_status = current_queue_status(app)?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(
            build_tray_menu(app, &shortcut_status, &system_status, &queue_status)
                .map_err(|error| error.to_string())?,
        ))
        .map_err(|error| error.to_string())?;
        tray.set_tooltip(Some(tray_tooltip(
            &shortcut_status,
            &system_status,
            &queue_status,
        )))
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn restore_recent_capture(app: &AppHandle, id: &str) -> Result<overlay::OverlayStatus, String> {
    let capture = history::resolve_recent_capture_for_app(app, id)?;
    match overlay::prepare_history_overlay(app, &capture.path) {
        status @ overlay::OverlayStatus::Prepared { .. } => Ok(status),
        overlay::OverlayStatus::Failed { message, .. } => Err(message),
    }
}

#[tauri::command]
fn get_shortcut_settings(
    state: State<'_, Mutex<shortcuts::ShortcutRuntime>>,
) -> Result<shortcuts::ShortcutStatus, String> {
    state
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "Shortcut settings are temporarily unavailable".into())
}

#[tauri::command]
fn update_shortcut_settings(
    app: AppHandle,
    state: State<'_, Mutex<shortcuts::ShortcutRuntime>>,
    settings: shortcuts::ShortcutSettings,
) -> Result<shortcuts::ShortcutStatus, String> {
    let candidate = shortcuts::validate_shortcut_settings(settings)?;
    let settings_path = shortcut_settings_path(&app)?;
    let mut runtime = state
        .lock()
        .map_err(|_| "Shortcut settings are temporarily unavailable".to_string())?;
    let registered_before = runtime.active_bindings.clone();
    let restore_on_failure = runtime.desired_active_bindings();
    let mut registry = TauriShortcutRegistry { app: &app };

    if let Err(error) = shortcuts::replace_registered_shortcuts(
        &mut registry,
        &registered_before,
        &restore_on_failure,
        &candidate.bindings,
        || shortcuts::save_shortcut_settings(&settings_path, &candidate.settings),
    ) {
        runtime.reconcile_failed_update(&error);
        let message = error.message;
        drop(runtime);
        if let Err(refresh_error) = refresh_tray_status(&app) {
            eprintln!("Could not refresh the Capso tray after shortcut failure: {refresh_error}");
        }
        return Err(message);
    }

    runtime.replace_with(candidate);
    let status = runtime.status();
    drop(runtime);

    if let Err(error) = refresh_tray_status(&app) {
        eprintln!("Could not refresh the Capso tray menu: {error}");
    }
    Ok(status)
}

#[tauri::command]
fn get_system_status(
    state: State<'_, Mutex<system::PermissionRuntime>>,
) -> Result<system::SystemStatus, String> {
    state
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "System settings are temporarily unavailable".into())
}

#[tauri::command]
fn request_screen_recording_permission(
    app: AppHandle,
    state: State<'_, Mutex<system::PermissionRuntime>>,
) -> Result<system::SystemStatus, String> {
    let granted = system::screen_recording_granted();
    let should_request = state
        .lock()
        .map_err(|_| "System settings are temporarily unavailable".to_string())?
        .should_request(granted);

    if should_request {
        let _ = system::request_screen_recording_access();
    }

    let status = current_system_status(&app)?;
    let _ = app.emit("system-status-changed", status);
    if let Err(error) = refresh_tray_status(&app) {
        eprintln!("Could not refresh the Capso tray after permission request: {error}");
    }
    Ok(status)
}

#[tauri::command]
fn open_screen_recording_settings() -> Result<(), String> {
    system::open_screen_recording_settings()
}

#[tauri::command]
fn set_launch_at_login_enabled(
    app: AppHandle,
    state: State<'_, Mutex<system::PermissionRuntime>>,
    enabled: bool,
) -> Result<system::SystemStatus, String> {
    system::set_launch_at_login(enabled)?;
    let status = state
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "System settings are temporarily unavailable".to_string())?;
    let _ = app.emit("system-status-changed", status);
    Ok(status)
}

#[tauri::command]
fn open_login_item_settings() {
    system::open_login_item_settings();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(shortcuts::ShortcutRuntime::default()))
        .manage(Mutex::new(system::PermissionRuntime::default()))
        .manage(Mutex::new(overlay::OverlayRuntime::default()))
        .manage(Mutex::new(clipboard::ClipboardRuntime::default()))
        .manage(Mutex::new(queue::QueueRuntime::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let settings_are_focused = app
                        .get_webview_window("main")
                        .and_then(|window| window.is_focused().ok())
                        .unwrap_or(false);
                    if settings_are_focused {
                        return;
                    }
                    let action = app
                        .state::<Mutex<shortcuts::ShortcutRuntime>>()
                        .lock()
                        .ok()
                        .and_then(|runtime| runtime.action_for_event(shortcut, event.state));
                    if let Some(action) = action {
                        launch_capture(app.clone(), action);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            capture::capture_screen,
            get_shortcut_settings,
            update_shortcut_settings,
            get_system_status,
            request_screen_recording_permission,
            open_screen_recording_settings,
            set_launch_at_login_enabled,
            open_login_item_settings,
            overlay::get_overlay_capture,
            overlay::overlay_image_ready,
            overlay::overlay_image_failed,
            overlay::overlay_copy_capture,
            overlay::overlay_save_capture,
            overlay::overlay_start_drag,
            overlay::overlay_dismiss
        ])
        .setup(|app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let Ok(cache_directory) = app.path().app_cache_dir() {
                let _ = dragout::cleanup_drag_exports(&cache_directory.join("drag-exports"));
            }

            let queue_status = queue::initialize_for_app(app.handle())
                .map_err(|error| format!("Could not initialize upload queue state: {error}"))?;

            // The panel remains non-focusable but accepts deliberate Quick
            // Access clicks without activating Capso or blocking outside it.
            if let Some(overlay_window) = app.get_webview_window(overlay::OVERLAY_LABEL) {
                overlay_window.set_ignore_cursor_events(false)?;
            }

            let loaded = match shortcut_settings_path(app.handle()) {
                Ok(path) => shortcuts::load_shortcut_settings(&path),
                Err(error) => shortcuts::LoadedShortcutSettings {
                    settings: shortcuts::ShortcutSettings::default(),
                    warning: Some(error),
                },
            };
            let validated = shortcuts::validate_shortcut_settings(loaded.settings)
                .expect("loaded shortcut settings must be validated");
            let registration =
                shortcuts::register_capture_shortcuts(&validated.bindings, |shortcut| {
                    app.global_shortcut()
                        .register(shortcut)
                        .map_err(|error| error.to_string())
                });

            let status = {
                let shortcut_state = app.state::<Mutex<shortcuts::ShortcutRuntime>>();
                let mut runtime = shortcut_state
                    .lock()
                    .map_err(|_| "Could not initialize shortcut settings")?;
                runtime.settings = validated.settings;
                runtime.bindings = validated.bindings;
                runtime.active_bindings = registration.active;
                runtime.conflicts = registration.conflicts;
                runtime.storage_warning = loaded.warning;
                runtime.status()
            };

            let system_status = current_system_status(app.handle())
                .map_err(|error| format!("Could not initialize system status: {error}"))?;
            let menu = build_tray_menu(app.handle(), &status, &system_status, &queue_status)?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip(tray_tooltip(&status, &system_status, &queue_status))
                .menu(&menu)
                // Left click toggles the popover; the menu stays on right click.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if let Some(action) = shortcuts::action_for_menu_id(event.id().as_ref()) {
                        launch_capture(app.clone(), action);
                    } else if let Some(id) = history::parse_recent_menu_id(event.id().as_ref()) {
                        if let Err(error) = restore_recent_capture(app, &id) {
                            if let Some(tray) = app.tray_by_id("main") {
                                let _ = tray.set_tooltip(Some(format!(
                                    "Capso — could not restore capture; {error}"
                                )));
                            }
                        }
                    } else if event.id() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = toggle_popover(&window);
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the popover hides it — the app lives in the menu bar.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            } else if let tauri::WindowEvent::Focused(true) = event {
                let app = window.app_handle();
                if let Ok(status) = current_system_status(app) {
                    let _ = app.emit("system-status-changed", status);
                }
                if let Err(error) = refresh_tray_status(app) {
                    eprintln!("Could not refresh Capso after focus: {error}");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{capture, clipboard, overlay, queue};

    fn event_json(
        result: Result<capture::CaptureOutcome, capture::CaptureFailure>,
    ) -> serde_json::Value {
        serde_json::to_value(super::capture_event(&result)).expect("serialize capture event")
    }

    #[test]
    fn copied_capture_event_has_a_top_level_captured_status() {
        assert_eq!(
            event_json(Ok(capture::CaptureOutcome::Captured {
                path: "/tmp/capso/captured.png".into(),
                clipboard: clipboard::ClipboardStatus::Copied { bytes: 42 },
                overlay: overlay::OverlayStatus::Prepared { x: 1440, y: 900 },
                queue: queue::CaptureQueueStatus::Enqueued {
                    id: "018f22c4-cada-7c6b-9d5b-fc35f7f9227a".into(),
                    queued: 1,
                },
            })),
            serde_json::json!({
                "status": "captured",
                "path": "/tmp/capso/captured.png",
                "clipboard": { "status": "copied", "bytes": 42 },
                "overlay": { "status": "prepared", "x": 1440, "y": 900 },
                "queue": {
                    "status": "enqueued",
                    "id": "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
                    "queued": 1
                }
            })
        );
    }

    #[test]
    fn clipboard_failure_event_still_has_a_top_level_captured_status() {
        assert_eq!(
            event_json(Ok(capture::CaptureOutcome::Captured {
                path: "/tmp/capso/captured.png".into(),
                clipboard: clipboard::ClipboardStatus::Failed {
                    code: "clipboard_write_failed",
                    message: "Could not copy the capture".into(),
                },
                overlay: overlay::OverlayStatus::Failed {
                    code: "overlay_unavailable",
                    message: "The capture overlay window is unavailable.".into(),
                },
                queue: queue::CaptureQueueStatus::Failed {
                    code: "queue_persist_failed",
                    message: "Could not commit queue".into(),
                },
            })),
            serde_json::json!({
                "status": "captured",
                "path": "/tmp/capso/captured.png",
                "clipboard": {
                    "status": "failed",
                    "code": "clipboard_write_failed",
                    "message": "Could not copy the capture"
                },
                "overlay": {
                    "status": "failed",
                    "code": "overlay_unavailable",
                    "message": "The capture overlay window is unavailable."
                },
                "queue": {
                    "status": "failed",
                    "code": "queue_persist_failed",
                    "message": "Could not commit queue"
                }
            })
        );
    }

    #[test]
    fn queue_status_labels_are_explicit_and_pluralized() {
        let one = queue::QueueRuntimeStatus {
            summary: queue::QueueSummary {
                pending: 1,
                total: 1,
                ..queue::QueueSummary::default()
            },
            warning: None,
        };
        assert_eq!(
            super::queue_menu_label(&one).as_deref(),
            Some("1 capture saved locally — sync pending")
        );

        let failed = queue::QueueRuntimeStatus {
            summary: queue::QueueSummary {
                failed: 2,
                total: 2,
                ..queue::QueueSummary::default()
            },
            warning: None,
        };
        assert_eq!(
            super::queue_menu_label(&failed).as_deref(),
            Some("2 captures need manual retry")
        );
    }

    #[test]
    fn cancelled_capture_event_is_explicit() {
        assert_eq!(
            event_json(Ok(capture::CaptureOutcome::Cancelled)),
            serde_json::json!({ "status": "cancelled" })
        );
    }

    #[test]
    fn failed_capture_event_is_explicit_and_actionable() {
        assert_eq!(
            event_json(Err(capture::CaptureFailure {
                code: "capture_failed",
                message: "Screen capture permission denied".into(),
            })),
            serde_json::json!({
                "status": "failed",
                "code": "capture_failed",
                "message": "Screen capture permission denied"
            })
        );
    }
}
