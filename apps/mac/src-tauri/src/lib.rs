mod annotation;
mod annotation_project;
mod annotation_sync;
mod area_selector;
mod auth;
mod automation;
mod capture;
mod capture_hud;
mod capture_mirror;
mod clipboard;
mod device;
mod dragout;
mod drain;
mod freeze;
mod history;
mod ingest;
mod latency;
mod ocr;
mod overlay;
mod pin;
mod projects;
mod queue;
mod recording;
mod retry;
mod self_timer;
mod settings_transfer;
mod shortcuts;
mod sync;
mod system;
mod upload;

use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{IconMenuItemBuilder, Menu, MenuBuilder, MenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime, State,
};
#[cfg(target_os = "macos")]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
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

fn background_wake_for_capture(
    result: &Result<capture::CaptureOutcome, capture::CaptureFailure>,
) -> Option<drain::DrainWake> {
    matches!(
        result,
        Ok(capture::CaptureOutcome::Captured {
            queue: queue::CaptureQueueStatus::Enqueued { .. }
                | queue::CaptureQueueStatus::AlreadyQueued { .. },
            ..
        })
    )
    .then_some(drain::DrainWake::CaptureEnqueued)
}

fn background_sync_now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .map_err(|_| "Capso could not timestamp its background sync wake.".into())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthEmailRequestStatus {
    status: &'static str,
    expires_at_ms: u64,
}

#[derive(Debug, Default)]
pub(crate) struct AuthBoundaryState {
    active_drains: usize,
    active_auth_operations: usize,
}

#[derive(Debug, Default)]
pub(crate) struct AuthAccountBoundary(Mutex<AuthBoundaryState>);

pub(crate) struct AuthDrainGuard<'a> {
    boundary: &'a AuthAccountBoundary,
}

pub(crate) struct AuthOperationGuard<'a> {
    boundary: &'a AuthAccountBoundary,
}

impl Drop for AuthDrainGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.boundary.0.lock() {
            state.active_drains = state.active_drains.saturating_sub(1);
        }
    }
}

impl Drop for AuthOperationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.boundary.0.lock() {
            state.active_auth_operations = state.active_auth_operations.saturating_sub(1);
        }
    }
}

impl AuthAccountBoundary {
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, AuthBoundaryState>, String> {
        self.0
            .lock()
            .map_err(|_| "Capso's account transition is temporarily unavailable.".into())
    }

    fn begin_drain(&self) -> Result<AuthDrainGuard<'_>, String> {
        self.lock()?.active_drains += 1;
        Ok(AuthDrainGuard { boundary: self })
    }

    pub(crate) fn begin_auth_operation(&self) -> Result<AuthOperationGuard<'_>, String> {
        self.lock()?.active_auth_operations += 1;
        Ok(AuthOperationGuard { boundary: self })
    }

    pub(crate) fn lock_for_sign_out(&self) -> Result<MutexGuard<'_, AuthBoundaryState>, String> {
        let guard = self.lock()?;
        if guard.active_auth_operations > 0 {
            return Err(
                "Wait for the current account request to finish before signing out; no pixels were removed."
                    .into(),
            );
        }
        if guard.active_drains > 0 {
            return Err(
                "Wait for the current background sync to finish before signing out; no pixels were removed."
                    .into(),
            );
        }
        Ok(guard)
    }
}

#[derive(Debug, Default)]
struct AuthFeedbackState(Mutex<Option<String>>);

impl AuthFeedbackState {
    fn record_failure(&self, message: &str) {
        if let Ok(mut failure) = self.0.lock() {
            *failure = Some(message.to_string());
        }
    }

    fn last_failure(&self) -> Option<String> {
        self.0.lock().ok().and_then(|failure| failure.clone())
    }

    fn clear(&self) {
        if let Ok(mut failure) = self.0.lock() {
            *failure = None;
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SyncFailureRecord {
    message: String,
    reconnect_required: bool,
}

#[derive(Debug, Default)]
struct SyncFeedbackState(Mutex<Option<SyncFailureRecord>>);

impl SyncFeedbackState {
    fn record_failure(&self, message: &str) {
        if let Ok(mut failure) = self.0.lock() {
            *failure = Some(SyncFailureRecord {
                message: message.into(),
                reconnect_required: sync_error_requires_reconnect(message),
            });
        }
    }

    fn current(&self) -> Option<SyncFailureRecord> {
        self.0.lock().ok().and_then(|failure| failure.clone())
    }

    fn clear(&self) {
        if let Ok(mut failure) = self.0.lock() {
            *failure = None;
        }
    }
}

fn sync_error_requires_reconnect(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("sign in again")
        || lower.contains("start sign-in again")
        || lower.contains("saved session is invalid")
        || lower.contains("this mac was disconnected")
}

fn sync_error_is_device_revoked(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains("this mac was disconnected")
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncUiSnapshot {
    summary: queue::QueueSummary,
    annotation_summary: annotation_sync::AnnotationSyncSummary,
    warning: Option<String>,
    last_success_at_ms: Option<u64>,
    reconnect_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthUiSnapshot {
    configured: bool,
    account: auth::AuthAccountStatus,
    last_failure: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    name: &'static str,
    platform: &'static str,
    app_version: String,
}

#[tauri::command]
fn get_device_info(app: AppHandle) -> DeviceInfo {
    DeviceInfo {
        name: "This Mac",
        platform: "macOS",
        app_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn open_web_library() -> Result<(), String> {
    history::open_library()
}

#[tauri::command]
fn get_local_history(app: AppHandle) -> Result<history::HistorySnapshot, String> {
    history::history_for_app(&app)
}

fn announce_history_change(app: &AppHandle) {
    let _ = app.emit("history-changed", ());
    if let Err(error) = refresh_tray_status(app) {
        eprintln!("Could not refresh the Capso tray after a History change: {error}");
    }
}

#[tauri::command]
fn remove_history_captures(app: AppHandle, ids: Vec<String>) -> Result<Vec<String>, String> {
    let removed = history::remove_from_history_for_app(&app, &ids)?;
    announce_history_change(&app);
    Ok(removed)
}

#[tauri::command]
fn clear_capture_history(app: AppHandle) -> Result<Vec<String>, String> {
    let removed = history::clear_history_for_app(&app)?;
    announce_history_change(&app);
    Ok(removed)
}

#[tauri::command]
fn restore_history_captures(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    history::restore_to_history_for_app(&app, &ids)?;
    announce_history_change(&app);
    Ok(())
}

#[tauri::command]
fn open_capture_history(app: AppHandle) -> Result<(), String> {
    history::show_history_window(&app)
}

#[tauri::command]
fn get_overlay_settings(app: AppHandle) -> Result<overlay::OverlaySettingsSnapshot, String> {
    overlay::get_overlay_settings(&app)
}

#[tauri::command]
fn get_save_as_preferences(app: AppHandle) -> Result<overlay::OverlaySaveAsPreferences, String> {
    overlay::get_save_as_preferences(&app)
}

#[tauri::command]
fn choose_capture_save_directory(
    app: AppHandle,
    current: String,
) -> Result<Option<String>, String> {
    let starting_directory = if current.is_empty() {
        overlay::default_save_directory(&app)?
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "Could not locate a starting Save folder.".to_string())?
    } else {
        PathBuf::from(current)
    };
    let selected = app
        .dialog()
        .file()
        .set_title("Choose Capso Save folder")
        .set_directory(starting_directory)
        .blocking_pick_folder();
    selected
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|_| "Choose a readable local Save folder.".to_string())
        })
        .transpose()
}

#[tauri::command]
fn update_overlay_settings(
    app: AppHandle,
    display_id: String,
    preferences: overlay::OverlayPreferences,
    save_as: overlay::OverlaySaveAsPreferences,
) -> Result<overlay::OverlaySettingsSnapshot, String> {
    overlay::update_overlay_settings(&app, &display_id, preferences, save_as)
}

#[tauri::command]
fn get_annotation_project_sync_status(
    app: AppHandle,
) -> Result<annotation_sync::AnnotationSyncRuntimeStatus, String> {
    annotation_sync::status_for_app(&app)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn retry_annotation_project_sync(
    app: AppHandle,
    id: String,
) -> Result<annotation_sync::AnnotationSyncRuntimeStatus, String> {
    let status = annotation_sync::retry_for_app(&app, &id)?;
    spawn_background_sync(app, drain::DrainWake::AnnotationSaved);
    Ok(status)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn keep_local_annotation_project(
    app: AppHandle,
    id: String,
) -> Result<annotation_sync::AnnotationSyncRuntimeStatus, String> {
    let status = annotation_sync::keep_local_for_app(&app, &id)?;
    spawn_background_sync(app, drain::DrainWake::AnnotationSaved);
    Ok(status)
}

#[tauri::command]
fn restore_history_capture(app: AppHandle, id: String) -> Result<overlay::OverlayStatus, String> {
    restore_recent_capture(&app, &id)
}

#[tauri::command]
async fn recognize_history_capture_text(
    app: AppHandle,
    id: String,
) -> Result<ocr::OcrResult, String> {
    ocr::recognize_history_capture_text(app, id).await
}

#[tauri::command]
async fn recognize_selected_png_text(
    app: AppHandle,
) -> Result<Option<ocr::SelectedOcrResult>, String> {
    ocr::recognize_selected_png_text(app).await
}

#[tauri::command]
async fn recognize_screen_selection_text(
    app: AppHandle,
) -> Result<Option<ocr::SelectedOcrResult>, String> {
    ocr::recognize_screen_selection_text(app).await
}

#[tauri::command]
async fn copy_recognized_text(
    app: AppHandle,
    capture_id: String,
    session_id: u64,
) -> Result<(), String> {
    ocr::copy_recognized_text(app, capture_id, session_id).await
}

#[tauri::command]
async fn copy_recognized_link(
    app: AppHandle,
    capture_id: String,
    session_id: u64,
    link_index: usize,
) -> Result<(), String> {
    ocr::copy_recognized_link(app, capture_id, session_id, link_index).await
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CombineHistoryResult {
    width: u32,
    height: u32,
    bytes: u64,
    capture: capture::CaptureOutcome,
}

#[tauri::command]
async fn combine_history_captures(
    app: AppHandle,
    ids: Vec<String>,
    layout: history::CombineLayout,
) -> Result<CombineHistoryResult, String> {
    let _capture_lease = capture::acquire_capture_lease().map_err(|error| error.message)?;
    if annotation::is_active(&app) {
        return Err("Finish or cancel the open annotation before combining captures.".into());
    }
    if capture_timer_is_running(&app) {
        return Err("Wait for the active capture to finish before combining history.".into());
    }
    let directory = history::capture_directory(&app)?;
    let output_id = uuid::Uuid::new_v4().to_string();
    let combined = tauri::async_runtime::spawn_blocking(move || {
        history::combine_captures(&directory, &ids, layout, &output_id)
    })
    .await
    .map_err(|error| format!("The combine task stopped unexpectedly: {error}"))??;
    let result = capture::publish_created_capture(&app, combined.path.clone()).await;
    finish_launched_capture(&app, &result, None);
    result
        .map(|capture| CombineHistoryResult {
            width: combined.width,
            height: combined.height,
            bytes: combined.bytes,
            capture,
        })
        .map_err(|error| error.message)
}

#[tauri::command]
async fn frame_history_capture(
    app: AppHandle,
    id: String,
    style: history::FrameStyle,
) -> Result<CombineHistoryResult, String> {
    let _capture_lease = capture::acquire_capture_lease().map_err(|error| error.message)?;
    if annotation::is_active(&app) {
        return Err("Finish or cancel the open annotation before framing a capture.".into());
    }
    if capture_timer_is_running(&app) {
        return Err("Wait for the active capture to finish before framing history.".into());
    }
    let directory = history::capture_directory(&app)?;
    let output_id = uuid::Uuid::new_v4().to_string();
    let framed = tauri::async_runtime::spawn_blocking(move || {
        history::frame_capture(&directory, &id, style, &output_id)
    })
    .await
    .map_err(|error| format!("The social framing task stopped unexpectedly: {error}"))??;
    let result = capture::publish_created_capture(&app, framed.path.clone()).await;
    finish_launched_capture(&app, &result, None);
    result
        .map(|capture| CombineHistoryResult {
            width: framed.width,
            height: framed.height,
            bytes: framed.bytes,
            capture,
        })
        .map_err(|error| error.message)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct AuthFailureEvent<'a> {
    message: &'a str,
}

#[cfg(target_os = "macos")]
fn receive_auth_callback(app: &AppHandle, callback: &str) {
    let result = app
        .state::<AuthAccountBoundary>()
        .begin_auth_operation()
        .and_then(|_operation| {
            let now_ms = background_sync_now_ms()?;
            app.state::<auth::ProductionAuthRuntime>()
                .complete_callback(callback, now_ms)
        });
    match result {
        Ok(status) => {
            let reset_device = app
                .state::<SyncFeedbackState>()
                .current()
                .is_some_and(|failure| sync_error_is_device_revoked(&failure.message));
            if reset_device {
                let reset_result = app
                    .state::<Mutex<sync::ProductionSyncRuntime>>()
                    .lock()
                    .map_err(|_| {
                        "Capso's Mac identity is temporarily unavailable; reconnect again."
                            .to_string()
                    })
                    .and_then(|sync| sync.reset_device_identity());
                if let Err(error) = reset_result {
                    app.state::<SyncFeedbackState>().record_failure(&error);
                    let _ = app.emit("auth-status-changed", &status);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    return;
                }
            }
            app.state::<AuthFeedbackState>().clear();
            app.state::<SyncFeedbackState>().clear();
            let _ = app.emit("auth-status-changed", &status);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            spawn_background_sync(app.clone(), drain::DrainWake::CredentialsRestored);
        }
        Err(error) => {
            app.state::<AuthFeedbackState>().record_failure(&error);
            let _ = app.emit("auth-sign-in-failed", AuthFailureEvent { message: &error });
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn spawn_auth_callback(app: AppHandle, callback: String) {
    let _auth_task = tauri::async_runtime::spawn_blocking(move || {
        receive_auth_callback(&app, &callback);
    });
}

#[cfg(target_os = "macos")]
fn run_automation_action(
    app: &AppHandle,
    action: automation::AutomationAction,
) -> Result<&'static str, String> {
    let capture_request = match action {
        automation::AutomationAction::CaptureArea { delay_seconds } => {
            Some((shortcuts::CaptureAction::Region, delay_seconds))
        }
        automation::AutomationAction::CaptureWindow { delay_seconds } => {
            Some((shortcuts::CaptureAction::Window, delay_seconds))
        }
        automation::AutomationAction::CaptureFullscreen { delay_seconds } => {
            Some((shortcuts::CaptureAction::Fullscreen, delay_seconds))
        }
        _ => None,
    };
    if let Some((capture_action, delay_seconds)) = capture_request {
        if capture_timer_is_running(app) {
            return Err("Cancel the running capture timer before using URL automation.".into());
        }
        if capture::is_capture_in_progress() || annotation::is_active(app) {
            return Err(
                "Finish the current capture or annotation before using URL automation.".into(),
            );
        }
        if system::permission_for_capture(capture_action.mode(), system::screen_recording_granted())
            == system::CapturePermission::RequiresScreenRecording
        {
            show_permission_guidance(app);
            return Err("Grant Screen Recording before using that URL action.".into());
        }
        if delay_seconds == 0 {
            launch_capture(app.clone(), capture_action);
        } else if !launch_capture_timer(app.clone(), capture_action, delay_seconds, false)? {
            return Err("Cancel the running capture timer before using URL automation.".into());
        }
        return Ok(match capture_action {
            shortcuts::CaptureAction::Region if delay_seconds > 0 => {
                "Area capture timer started by URL automation."
            }
            shortcuts::CaptureAction::Window if delay_seconds > 0 => {
                "Window capture timer started by URL automation."
            }
            shortcuts::CaptureAction::Fullscreen if delay_seconds > 0 => {
                "Full-screen capture timer started by URL automation."
            }
            shortcuts::CaptureAction::Region => "Area capture requested by URL automation.",
            shortcuts::CaptureAction::Window => "Window capture requested by URL automation.",
            shortcuts::CaptureAction::Fullscreen => {
                "Full-screen capture requested by URL automation."
            }
        });
    }
    match action {
        automation::AutomationAction::OpenHistory => {
            history::show_history_window(app)?;
            Ok("History opened by URL automation.")
        }
        automation::AutomationAction::OpenRecording => {
            recording::show_recording_studio(app)?;
            Ok("Recording Studio opened by URL automation.")
        }
        automation::AutomationAction::OpenSettings => {
            open_settings_window(app);
            Ok("Settings opened by URL automation.")
        }
        automation::AutomationAction::CaptureArea { .. }
        | automation::AutomationAction::CaptureWindow { .. }
        | automation::AutomationAction::CaptureFullscreen { .. } => {
            unreachable!("capture actions return above")
        }
    }
}

#[cfg(target_os = "macos")]
fn receive_deep_link(app: &AppHandle, value: &str) {
    match automation::parse_deep_link(value) {
        Ok(automation::DeepLinkRoute::AuthCallback) => {
            spawn_auth_callback(app.clone(), value.to_string());
        }
        Ok(automation::DeepLinkRoute::Automation(action)) => {
            let result = run_automation_action(app, action);
            let feedback = match result {
                Ok(message) => app
                    .state::<automation::AutomationFeedbackState>()
                    .record(message, false),
                Err(message) => {
                    open_settings_window(app);
                    app.state::<automation::AutomationFeedbackState>()
                        .record(message, true)
                }
            };
            let _ = app.emit("automation-status-changed", feedback);
        }
        Err(message) => {
            open_settings_window(app);
            let feedback = app
                .state::<automation::AutomationFeedbackState>()
                .record(message, true);
            let _ = app.emit("automation-status-changed", feedback);
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn get_auth_status(app: AppHandle) -> Result<AuthUiSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let boundary = app.state::<AuthAccountBoundary>();
        let _operation = boundary.begin_auth_operation()?;
        let (configured, account) = app.state::<auth::ProductionAuthRuntime>().ui_status()?;
        Ok(AuthUiSnapshot {
            configured,
            account,
            last_failure: app.state::<AuthFeedbackState>().last_failure(),
        })
    })
    .await
    .map_err(|error| format!("Capso could not check its account task: {error}"))?
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_sign_in_email(
    app: AppHandle,
    email: String,
) -> Result<AuthEmailRequestStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let boundary = app.state::<AuthAccountBoundary>();
        let _operation = boundary.begin_auth_operation()?;
        let now_ms = background_sync_now_ms()?;
        app.state::<auth::ProductionAuthRuntime>()
            .start_email(&email, now_ms)
            .map(|_| {
                app.state::<AuthFeedbackState>().clear();
                AuthEmailRequestStatus {
                    status: "email_sent",
                    expires_at_ms: now_ms.saturating_add(auth::HANDOFF_TTL_MS),
                }
            })
    })
    .await
    .map_err(|error| format!("Capso could not finish its sign-in task: {error}"))?
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_reconnect_email(app: AppHandle) -> Result<AuthEmailRequestStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let boundary = app.state::<AuthAccountBoundary>();
        let _operation = boundary.begin_auth_operation()?;
        let now_ms = background_sync_now_ms()?;
        app.state::<auth::ProductionAuthRuntime>()
            .start_reconnect(now_ms)
            .map(|_| AuthEmailRequestStatus {
                status: "email_sent",
                expires_at_ms: now_ms.saturating_add(auth::HANDOFF_TTL_MS),
            })
    })
    .await
    .map_err(|error| format!("Capso could not finish its reconnect task: {error}"))?
}

fn ensure_sign_out_queue_is_safe(status: &queue::QueueRuntimeStatus) -> Result<(), String> {
    let active = status.summary.pending + status.summary.uploading + status.summary.retrying;
    if active == 0 {
        Ok(())
    } else {
        Err(format!(
            "Wait for {active} local {} to finish syncing before signing out; no pixels were removed.",
            if active == 1 { "capture" } else { "captures" }
        ))
    }
}

fn ensure_sign_out_annotation_sync_is_safe(
    summary: &annotation_sync::AnnotationSyncSummary,
) -> Result<(), String> {
    let unsynced = summary.pending + summary.uploading + summary.failed + summary.conflicts;
    if unsynced == 0 {
        Ok(())
    } else {
        Err(format!(
            "Resolve or sync {unsynced} local editable {} before signing out; their protected originals remain on this Mac.",
            if unsynced == 1 { "project" } else { "projects" }
        ))
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn sign_out(app: AppHandle) -> Result<auth::AuthAccountStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let boundary = app.state::<AuthAccountBoundary>();
        let _guard = boundary.lock_for_sign_out()?;
        ensure_sign_out_queue_is_safe(&current_queue_status(&app)?)?;
        let annotation_status = annotation_sync::status_for_app(&app)?;
        if annotation_status.warning.is_some() {
            return Err("Capso cannot verify the local editable project queue yet. Reopen the app before signing out; no files were removed.".into());
        }
        ensure_sign_out_annotation_sync_is_safe(&annotation_status.summary)?;
        let status = app.state::<auth::ProductionAuthRuntime>().sign_out()?;
        app.state::<AuthFeedbackState>().clear();
        let _ = app.emit("auth-status-changed", &status);
        app.state::<retry::RetryMonitorSignal>().notify();
        Ok(status)
    })
    .await
    .map_err(|error| format!("Capso could not finish its sign-out task: {error}"))?
}

#[cfg(target_os = "macos")]
pub(crate) fn spawn_background_sync(app: AppHandle, wake: drain::DrainWake) {
    app.state::<retry::RetryMonitorSignal>().notify();
    let _sync_task = tauri::async_runtime::spawn_blocking(move || {
        let result: Result<
            (
                drain::WakeResult,
                capture_mirror::RemoteCaptureReconcileReport,
                annotation_sync::AnnotationSyncDrainReport,
                annotation_sync::RemoteAnnotationReconcileReport,
            ),
            String,
        > = (|| {
            let route = retry::SystemConnectivityProbe::new()
                .ok()
                .and_then(|probe| probe.is_reachable().ok());
            app.state::<retry::ConnectivityState>().observe_probe(route);
            let boundary = app.state::<AuthAccountBoundary>();
            let _drain_guard = boundary.begin_drain()?;
            let now_ms = background_sync_now_ms()?;
            let sync_state = app.state::<Mutex<sync::ProductionSyncRuntime>>();
            let sync = sync_state
                .lock()
                .map_err(|_| "Capso's background sync is temporarily unavailable.".to_string())?;
            let coordinator = app.state::<drain::DrainCoordinator>();
            let queue = app.state::<Mutex<queue::QueueRuntime>>();
            let connectivity_available = app.state::<retry::ConnectivityState>().permits_sync();
            let capture_result =
                sync.wake(wake, &coordinator, &*queue, now_ms, connectivity_available)?;
            let annotation_transport = connectivity_available
                .then(|| sync.annotation_transport(now_ms))
                .transpose()?;
            drop(sync);
            let (capture_mirror_report, annotation_report, remote_report) = if let Some(transport) =
                annotation_transport
            {
                let capture_mirror_report =
                    capture_mirror::reconcile_remote_captures(&*queue, &transport, now_ms)?;
                let ready_capture_ids = queue
                    .lock()
                    .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?
                    .uploaded_capture_ids()?;
                let annotation_report =
                    annotation_sync::drain_for_app(&app, &transport, &ready_capture_ids)?;
                let remote_report = annotation_sync::reconcile_remote_for_app(
                    &app,
                    &transport,
                    &ready_capture_ids,
                )?;
                (capture_mirror_report, annotation_report, remote_report)
            } else {
                (
                    capture_mirror::RemoteCaptureReconcileReport::default(),
                    annotation_sync::AnnotationSyncDrainReport::default(),
                    annotation_sync::RemoteAnnotationReconcileReport::default(),
                )
            };
            Ok((
                capture_result,
                capture_mirror_report,
                annotation_report,
                remote_report,
            ))
        })();
        match &result {
            Ok((drain::WakeResult::Ran(report), _, _, _))
                if report
                    .last_hold
                    .as_deref()
                    .is_some_and(sync_error_requires_reconnect) =>
            {
                app.state::<SyncFeedbackState>().record_failure(
                    report
                        .last_hold
                        .as_deref()
                        .expect("reconnect hold checked above"),
                );
            }
            Ok((_, capture_mirror_report, _, _)) if capture_mirror_report.last_error.is_some() => {
                app.state::<SyncFeedbackState>().record_failure(
                    capture_mirror_report
                        .last_error
                        .as_deref()
                        .expect("remote screenshot failure checked above"),
                );
            }
            Ok(_) => app.state::<SyncFeedbackState>().clear(),
            Err(error) => {
                app.state::<SyncFeedbackState>().record_failure(error);
                eprintln!("Capso background sync wake failed safely: {error}");
            }
        }
        if let Ok((_, capture_mirror_report, _, _)) = &result {
            if capture_mirror_report.downloaded > 0 {
                let _ = app.emit("history-changed", ());
            }
        }
        if let Err(error) = refresh_tray_status(&app) {
            eprintln!("Could not refresh Capso after background sync: {error}");
        }
        if let Ok(status) = current_sync_status(&app) {
            let _ = app.emit("sync-status-changed", status);
        }
        app.state::<retry::RetryMonitorSignal>().notify();
    });
}

/// Settings reads the same durable queue snapshot as the tray. The command is
/// intentionally read-only: queue transitions remain owned by the drain.
#[tauri::command]
fn get_sync_status(app: AppHandle) -> Result<SyncUiSnapshot, String> {
    current_sync_status(&app)
}

fn current_sync_status(app: &AppHandle) -> Result<SyncUiSnapshot, String> {
    let queue = current_queue_status(app)?;
    let annotation_status = annotation_sync::status_for_app(app)?;
    let feedback = app.state::<SyncFeedbackState>().current();
    let queue_warning = queue.warning.is_some() || annotation_status.warning.is_some();
    Ok(SyncUiSnapshot {
        summary: queue.summary,
        annotation_summary: annotation_status.summary,
        warning: queue
            .warning
            .or(annotation_status.warning)
            .or_else(|| feedback.as_ref().map(|failure| failure.message.clone())),
        last_success_at_ms: queue.last_success_at_ms,
        reconnect_required: !queue_warning
            && feedback.is_some_and(|failure| failure.reconnect_required),
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn get_capture_projects(app: AppHandle) -> Result<Vec<projects::CaptureProject>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let boundary = app.state::<AuthAccountBoundary>();
        let _operation = boundary.begin_auth_operation()?;
        let now_ms = background_sync_now_ms()?;
        app.state::<Mutex<sync::ProductionSyncRuntime>>()
            .lock()
            .map_err(|_| "Capso's project service is temporarily unavailable.".to_string())?
            .capture_projects(now_ms)
    })
    .await
    .map_err(|error| format!("Capso could not finish its project request: {error}"))?
}

/// A manual retry is a wake-up, not a second uploader. Coalescing, credentials,
/// connectivity and durable transitions still pass through the one coordinator.
#[cfg(target_os = "macos")]
#[tauri::command]
fn retry_sync(app: AppHandle) {
    spawn_background_sync(app, drain::DrainWake::RetryDeadline);
}

#[cfg(target_os = "macos")]
fn spawn_background_retry_monitor(app: AppHandle) -> Result<(), String> {
    if let Ok(probe) = retry::SystemConnectivityProbe::new() {
        app.state::<retry::ConnectivityState>()
            .observe_probe(probe.is_reachable().ok());
    }
    let receiver = app.state::<retry::RetryMonitorSignal>().take_receiver()?;

    thread::Builder::new()
        .name("capso-background-retry".into())
        .spawn(move || {
            let mut probe = retry::SystemConnectivityProbe::new().ok();
            let mut planner = retry::RetryDeadlinePlanner::default();
            let mut remote_planner = retry::RemoteDiscoveryPlanner::default();
            loop {
                let now_ms = match background_sync_now_ms() {
                    Ok(now_ms) => now_ms,
                    Err(_) => {
                        retry::RetryMonitorSignal::wait(
                            &receiver,
                            Some(retry::CONNECTIVITY_POLL_INTERVAL_MS),
                        );
                        continue;
                    }
                };
                let connectivity = app.state::<retry::ConnectivityState>();
                let transition = connectivity
                    .observe_probe(probe.as_ref().and_then(|probe| probe.is_reachable().ok()));
                let snapshot = queue::retry_monitor_snapshot_for_app(&app).unwrap_or_default();
                let signed_in = app
                    .state::<auth::ProductionAuthRuntime>()
                    .status()
                    .is_ok_and(|status| status.status == "signed_in");
                let timed_wake = planner.observe(
                    now_ms,
                    snapshot.next_retry_at_ms,
                    connectivity.permits_sync(),
                );
                let remote_wake =
                    remote_planner.observe(now_ms, signed_in, connectivity.permits_sync());
                let wake = if transition == retry::ConnectivityTransition::Restored {
                    Some(drain::DrainWake::ConnectivityRestored)
                } else {
                    timed_wake.or(remote_wake)
                };
                if let Some(wake) = wake {
                    spawn_background_sync(app.clone(), wake);
                }
                let retry_wait = retry::RetryDeadlinePlanner::wait_ms(
                    now_ms,
                    snapshot.next_retry_at_ms,
                    snapshot.has_retryable_work,
                    &connectivity,
                );
                let remote_wait = remote_planner.wait_ms(now_ms, signed_in);
                let wait_ms = match (retry_wait, remote_wait) {
                    (Some(left), Some(right)) => Some(left.min(right)),
                    (Some(wait), None) | (None, Some(wait)) => Some(wait),
                    (None, None) => None,
                };
                retry::RetryMonitorSignal::wait(&receiver, wait_ms);

                if probe.is_none() {
                    probe = retry::SystemConnectivityProbe::new().ok();
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Capso could not start its background retry monitor: {error}"))
}

fn capture_timer_is_running(app: &AppHandle) -> bool {
    app.state::<Mutex<self_timer::CaptureTimerRuntime>>()
        .lock()
        .map(|runtime| runtime.is_running())
        .unwrap_or(true)
}

fn finish_launched_capture(
    app: &AppHandle,
    result: &Result<capture::CaptureOutcome, capture::CaptureFailure>,
    successful_capture_warning: Option<&str>,
) {
    if matches!(
        result,
        Err(capture::CaptureFailure {
            code: "screen_recording_required",
            ..
        })
    ) {
        show_permission_guidance(app);
    }
    let desktop_clutter_warning = recording::desktop_clutter_warning(app);
    let successful_capture_warning = match (
        successful_capture_warning,
        desktop_clutter_warning.as_deref(),
    ) {
        (Some(first), Some(second)) => Some(format!("{first}; {second}")),
        (Some(warning), None) | (None, Some(warning)) => Some(warning.to_string()),
        (None, None) => None,
    };
    if let Some(tray) = app.tray_by_id("main") {
        match result {
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
            Ok(capture::CaptureOutcome::Captured { .. })
                if successful_capture_warning.is_some() =>
            {
                let _ = tray.set_tooltip(Some(format!(
                    "Capso — capture saved; {}",
                    successful_capture_warning.as_deref().unwrap_or_default()
                )));
            }
            Ok(_) => {}
        }
    }

    if let Some(wake) = background_wake_for_capture(result) {
        #[cfg(target_os = "macos")]
        spawn_background_sync(app.clone(), wake);
    }
    let _ = app.emit("capture-finished", capture_event(result));
}

fn launch_capture(app: AppHandle, action: shortcuts::CaptureAction) {
    if capture_timer_is_running(&app) {
        if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
            let _ = window.show();
        }
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(
                "Capso — cancel the running capture timer before starting another capture",
            ));
        }
        return;
    }
    if let Some(window) = app.get_webview_window(capture_hud::HUD_LABEL) {
        let _ = window.hide();
    }
    if system::permission_for_capture(action.mode(), system::screen_recording_granted())
        == system::CapturePermission::RequiresScreenRecording
    {
        show_permission_guidance(&app);
        return;
    }

    let _capture_task = tauri::async_runtime::spawn(async move {
        // Keep ordinary Area capture on macOS's live interactive selector.
        // Screen Recording permission must not switch users into the slower
        // full-display precision preview: mouse-up should always commit.
        let result = capture::capture_screen(app.clone(), action.mode()).await;
        let previous_area_warning = if action == shortcuts::CaptureAction::Region
            && matches!(result, Ok(capture::CaptureOutcome::Captured { .. }))
        {
            let record_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                capture_hud::record_system_previous_area(&record_app)
            })
            .await
            .map_or_else(
                |error| Some(format!("Previous Area could not be saved: {error}")),
                Result::err,
            )
        } else {
            None
        };
        finish_launched_capture(&app, &result, previous_area_warning.as_deref());
    });
}

fn launch_previous_area_capture(app: AppHandle) -> Result<(), String> {
    if capture_timer_is_running(&app) {
        return Err("Cancel the running capture timer before using Previous Area.".into());
    }
    if capture::is_capture_in_progress() {
        return Err("Wait for the current capture to finish before using Previous Area.".into());
    }
    let rect = capture_hud::previous_area_for_app(&app)?;
    if !system::screen_recording_granted() {
        let _ = hide_capture_hud(app.clone());
        show_permission_guidance(&app);
        return Err("Grant Screen Recording before replaying Previous Area.".into());
    }
    hide_capture_hud(app.clone())?;
    let _capture_task = tauri::async_runtime::spawn(async move {
        let result = capture::capture_previous_area(app.clone(), rect).await;
        finish_launched_capture(&app, &result, None);
    });
    Ok(())
}

fn launch_frozen_capture(app: AppHandle) -> Result<(), String> {
    if capture_timer_is_running(&app) {
        return Err("Cancel the running capture timer before using Freeze Screen.".into());
    }
    if capture::is_capture_in_progress() {
        return Err("Wait for the current capture to finish before using Freeze Screen.".into());
    }
    if !system::screen_recording_granted() {
        let _ = hide_capture_hud(app.clone());
        show_permission_guidance(&app);
        return Err("Grant Screen Recording before using Freeze Screen.".into());
    }
    if let Some(window) = app.get_webview_window(capture_hud::HUD_LABEL) {
        let _ = window.hide();
    }
    let _capture_task = tauri::async_runtime::spawn(async move {
        let result = capture::capture_frozen_area(app.clone()).await;
        finish_launched_capture(&app, &result, None);
    });
    Ok(())
}

fn launch_capture_timer(
    app: AppHandle,
    action: shortcuts::CaptureAction,
    seconds: u8,
    freeze_screen: bool,
) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(capture_hud::HUD_LABEL) {
        let _ = window.hide();
    }
    let outcome = app
        .state::<Mutex<self_timer::CaptureTimerRuntime>>()
        .lock()
        .map_err(|_| "The capture timer is temporarily unavailable.".to_string())?
        .start(action, seconds, freeze_screen);
    let status = match outcome {
        self_timer::StartOutcome::Started(status) => status,
        self_timer::StartOutcome::AlreadyRunning(status) => {
            if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
                let _ = window.show();
            }
            let _ = app.emit_to(
                self_timer::TIMER_LABEL,
                "capture-timer-changed",
                status.clone(),
            );
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(format!(
                    "Capso — a {} capture timer is already running",
                    status.mode.label().to_lowercase()
                )));
            }
            return Ok(false);
        }
    };

    if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
        let _ = window.show();
    }
    let _ = app.emit_to(
        self_timer::TIMER_LABEL,
        "capture-timer-changed",
        status.clone(),
    );
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!(
            "Capso — {}{} capture starts in {seconds} seconds; Cancel is available",
            if freeze_screen { "frozen " } else { "" },
            action.label().to_lowercase(),
        )));
    }

    let generation = status.generation;
    let _timer_task = tauri::async_runtime::spawn_blocking(move || {
        for seconds_remaining in (1..seconds).rev() {
            thread::sleep(Duration::from_secs(1));
            let status = app
                .state::<Mutex<self_timer::CaptureTimerRuntime>>()
                .lock()
                .ok()
                .and_then(|mut runtime| runtime.tick(generation, seconds_remaining));
            let Some(status) = status else {
                return;
            };
            let _ = app.emit_to(self_timer::TIMER_LABEL, "capture-timer-changed", status);
        }

        thread::sleep(Duration::from_secs(1));
        let target = app
            .state::<Mutex<self_timer::CaptureTimerRuntime>>()
            .lock()
            .map(|mut runtime| runtime.finish(generation))
            .unwrap_or(None);
        let Some(target) = target else {
            return;
        };
        if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
            let _ = window.hide();
        }
        if target.freeze_screen {
            let _ = launch_frozen_capture(app);
        } else {
            launch_capture(app, target.mode);
        }
    });
    Ok(true)
}

#[tauri::command]
fn get_capture_timer_status(
    state: State<'_, Mutex<self_timer::CaptureTimerRuntime>>,
) -> Result<self_timer::CaptureTimerStatus, String> {
    state
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "The capture timer is temporarily unavailable.".to_string())
}

#[tauri::command]
fn cancel_capture_timer(
    app: AppHandle,
    state: State<'_, Mutex<self_timer::CaptureTimerRuntime>>,
) -> Result<bool, String> {
    let cancelled = state
        .lock()
        .map_err(|_| "The capture timer is temporarily unavailable.".to_string())?
        .cancel();
    let Some(status) = cancelled else {
        return Ok(false);
    };

    let _ = app.emit_to(
        self_timer::TIMER_LABEL,
        "capture-timer-changed",
        status.clone(),
    );
    if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
        let _ = window.hide();
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!(
            "Capso — {} capture timer cancelled",
            status.mode.label().to_lowercase()
        )));
    }
    Ok(true)
}

fn cancel_capture_timer_from_window(app: &AppHandle) {
    let state = app.state::<Mutex<self_timer::CaptureTimerRuntime>>();
    if let Ok(mut runtime) = state.lock() {
        let _ = runtime.cancel();
    };
}

#[tauri::command]
fn get_capture_hud_settings(
    app: AppHandle,
) -> Result<capture_hud::LoadedCaptureHudSettings, String> {
    capture_hud::status_for_app(&app)
}

#[tauri::command]
fn show_capture_hud(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(capture_hud::HUD_LABEL)
        .ok_or_else(|| "Capso's capture controls are unavailable.".to_string())?;
    let _ = window.center();
    window
        .show()
        .and_then(|_| {
            let _ = app.emit_to(capture_hud::HUD_LABEL, "capture-hud-opened", ());
            window.set_focus()
        })
        .map_err(|error| format!("Could not open Capso's capture controls: {error}"))
}

#[tauri::command]
fn hide_capture_hud(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(capture_hud::HUD_LABEL)
        .ok_or_else(|| "Capso's capture controls are unavailable.".to_string())?
        .hide()
        .map_err(|error| format!("Could not close Capso's capture controls: {error}"))
}

#[tauri::command]
fn start_capture_from_hud(
    app: AppHandle,
    settings: capture_hud::CaptureHudSettings,
) -> Result<(), String> {
    let settings = capture_hud::validate_settings(settings)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's settings directory: {error}"))?;
    capture_hud::store_settings(&app_data, settings)?;
    hide_capture_hud(app.clone())?;
    if settings.delay_seconds == 0 {
        if settings.freeze_screen {
            launch_frozen_capture(app)?;
        } else {
            launch_capture(app, settings.mode);
        }
    } else {
        let _ = launch_capture_timer(
            app,
            settings.mode,
            settings.delay_seconds,
            settings.freeze_screen,
        )?;
    }
    Ok(())
}

#[tauri::command]
fn start_previous_area_capture(app: AppHandle) -> Result<(), String> {
    launch_previous_area_capture(app)
}

#[tauri::command]
fn get_freeze_frame(state: State<'_, freeze::FreezeCoordinator>) -> Option<freeze::FreezeFrame> {
    state.current()
}

#[tauri::command]
fn freeze_frame_ready(state: State<'_, freeze::FreezeCoordinator>, generation: u64) -> bool {
    state.mark_ready(generation)
}

#[tauri::command]
fn cancel_freeze_capture(
    app: AppHandle,
    state: State<'_, freeze::FreezeCoordinator>,
    generation: u64,
) -> bool {
    let cancelled = state.cancel(generation);
    if cancelled {
        if let Some(window) = app.get_webview_window(freeze::FREEZE_LABEL) {
            let _ = window.hide();
        }
    }
    cancelled
}

fn cancel_freeze_capture_from_window(app: &AppHandle) {
    let state = app.state::<freeze::FreezeCoordinator>();
    if let Some(frame) = state.current() {
        let _ = state.cancel(frame.generation);
    }
}

#[tauri::command]
fn get_area_selector(
    state: State<'_, area_selector::AreaSelectorCoordinator>,
) -> Option<area_selector::AreaSelectorSession> {
    state.current()
}

#[tauri::command]
fn complete_area_selection(
    state: State<'_, area_selector::AreaSelectorCoordinator>,
    generation: u64,
    selection: area_selector::AreaSelection,
) -> bool {
    state.complete(generation, selection)
}

#[tauri::command]
fn cancel_area_selection(
    app: AppHandle,
    state: State<'_, area_selector::AreaSelectorCoordinator>,
    generation: u64,
) -> bool {
    let cancelled = state.cancel(generation);
    if cancelled {
        if let Some(window) = app.get_webview_window(area_selector::AREA_SELECTOR_LABEL) {
            let _ = window.hide();
        }
    }
    cancelled
}

fn cancel_area_selection_from_window(app: &AppHandle) {
    let state = app.state::<area_selector::AreaSelectorCoordinator>();
    if let Some(session) = state.current() {
        let _ = state.cancel(session.generation);
    }
}

fn show_permission_guidance(app: &AppHandle) {
    open_settings_window(app);
    if let Ok(status) = current_system_status(app) {
        let _ = app.emit("system-status-changed", status);
    }
    if let Err(error) = refresh_tray_status(app) {
        eprintln!("Could not refresh the Capso permission guidance: {error}");
    }
}

/// Settings is a destination, not a toggle: an already-open window is raised and
/// focused rather than hidden, so choosing "Settings…" always shows settings.
fn open_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn should_ignore_global_shortcut(annotation_active: bool) -> bool {
    annotation_active
}

fn should_reveal_main_on_reopen(has_visible_windows: bool) -> bool {
    !has_visible_windows
}

fn shortcut_settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("shortcut-settings.json"))
        .map_err(|error| format!("Could not locate the Capso settings directory: {error}"))
}

fn portable_settings_paths(app: &AppHandle) -> Result<settings_transfer::SettingsPaths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's settings directory: {error}"))?;
    Ok(settings_transfer::SettingsPaths {
        shortcuts: shortcut_settings_path(app)?,
        capture: capture_hud::settings_path(&app_data),
        quick_access: overlay::overlay_settings_path(app)?,
    })
}

fn current_portable_settings(
    app: &AppHandle,
    shortcut_state: &State<'_, Mutex<shortcuts::ShortcutRuntime>>,
) -> Result<settings_transfer::PortableSettingsDocument, String> {
    let shortcuts = shortcut_state
        .lock()
        .map_err(|_| "Shortcut settings are temporarily unavailable.".to_string())?
        .status();
    if let Some(warning) = shortcuts.storage_warning {
        return Err(format!(
            "Resolve the saved shortcut warning before exporting settings: {warning}"
        ));
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's settings directory: {error}"))?;
    let capture = capture_hud::load_settings(&app_data);
    if let Some(warning) = capture.storage_warning {
        return Err(format!(
            "Resolve the remembered capture warning before exporting settings: {warning}"
        ));
    }
    Ok(settings_transfer::document(
        shortcuts.settings,
        capture.settings,
        overlay::stored_overlay_settings(app)?,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsExportResult {
    file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsImportResult {
    source_name: String,
    shortcut_status: shortcuts::ShortcutStatus,
}

fn finish_settings_transfer(state: &State<'_, Mutex<settings_transfer::SettingsTransferRuntime>>) {
    if let Ok(mut runtime) = state.lock() {
        runtime.finish();
    }
}

#[tauri::command]
async fn export_portable_settings(
    app: AppHandle,
    shortcut_state: State<'_, Mutex<shortcuts::ShortcutRuntime>>,
    transfer_state: State<'_, Mutex<settings_transfer::SettingsTransferRuntime>>,
) -> Result<Option<SettingsExportResult>, String> {
    transfer_state
        .lock()
        .map_err(|_| "Settings transfer is temporarily unavailable.".to_string())?
        .begin()?;
    let result = (|| {
        let document = current_portable_settings(&app, &shortcut_state)?;
        let selected = app
            .dialog()
            .file()
            .set_title("Export Capso settings")
            .set_file_name("Capso Settings.json")
            .add_filter("Capso settings", &["json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "Choose a readable local destination for Capso settings.".to_string())?;
        settings_transfer::write_document(&path, &document)?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "The exported settings file name is unreadable.".to_string())?
            .to_string();
        Ok(Some(SettingsExportResult { file_name }))
    })();
    finish_settings_transfer(&transfer_state);
    result
}

fn apply_portable_settings(
    app: &AppHandle,
    shortcut_state: &State<'_, Mutex<shortcuts::ShortcutRuntime>>,
    document: &settings_transfer::PortableSettingsDocument,
) -> Result<shortcuts::ShortcutStatus, String> {
    let paths = portable_settings_paths(app)?;
    let candidate = shortcuts::validate_shortcut_settings(document.shortcuts.clone())?;
    let mut runtime = shortcut_state
        .lock()
        .map_err(|_| "Shortcut settings are temporarily unavailable.".to_string())?;
    let registered_before = runtime.active_bindings.clone();
    let restore_on_failure = runtime.desired_active_bindings();
    let mut registry = TauriShortcutRegistry { app };
    settings_transfer::apply_document_files(&paths, document, || {
        if let Err(error) = shortcuts::replace_registered_shortcuts(
            &mut registry,
            &registered_before,
            &restore_on_failure,
            &candidate.bindings,
            || Ok(()),
        ) {
            runtime.reconcile_failed_update(&error);
            return Err(error.message);
        }
        Ok(())
    })?;
    runtime.replace_with(candidate);
    let status = runtime.status();
    drop(runtime);
    if let Err(error) = refresh_tray_status(app) {
        eprintln!("Could not refresh the Capso tray after settings import: {error}");
    }
    Ok(status)
}

#[tauri::command]
async fn import_portable_settings(
    app: AppHandle,
    shortcut_state: State<'_, Mutex<shortcuts::ShortcutRuntime>>,
    transfer_state: State<'_, Mutex<settings_transfer::SettingsTransferRuntime>>,
) -> Result<Option<SettingsImportResult>, String> {
    transfer_state
        .lock()
        .map_err(|_| "Settings transfer is temporarily unavailable.".to_string())?
        .begin()?;
    let result = (|| {
        let selected = app
            .dialog()
            .file()
            .set_title("Import Capso settings")
            .add_filter("Capso settings", &["json"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "Choose a readable local Capso settings file.".to_string())?;
        let document = settings_transfer::read_document(&path)?;
        let source_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "The imported settings file name is unreadable.".to_string())?
            .to_string();
        let shortcut_status = apply_portable_settings(&app, &shortcut_state, &document)?;
        Ok(Some(SettingsImportResult {
            source_name,
            shortcut_status,
        }))
    })();
    finish_settings_transfer(&transfer_state);
    result
}

#[tauri::command]
fn reset_portable_settings(
    app: AppHandle,
    shortcut_state: State<'_, Mutex<shortcuts::ShortcutRuntime>>,
    transfer_state: State<'_, Mutex<settings_transfer::SettingsTransferRuntime>>,
) -> Result<SettingsImportResult, String> {
    transfer_state
        .lock()
        .map_err(|_| "Settings transfer is temporarily unavailable.".to_string())?
        .begin()?;
    let result = apply_portable_settings(
        &app,
        &shortcut_state,
        &settings_transfer::default_document(),
    )
    .map(|shortcut_status| SettingsImportResult {
        source_name: "Built-in defaults".into(),
        shortcut_status,
    });
    finish_settings_transfer(&transfer_state);
    result
}

fn tray_tooltip(
    shortcut_status: &shortcuts::ShortcutStatus,
    system_status: &system::SystemStatus,
    queue_status: &queue::QueueRuntimeStatus,
    latency_report: &latency::OverlayLatencyReport,
) -> &'static str {
    if screen_recording_guidance_needed(system_status.screen_recording) {
        "Capso — Screen Recording needed for capture"
    } else if queue_status.warning.is_some() || queue_status.summary.failed > 0 {
        "Capso — uploads need attention; captures remain saved locally"
    } else if !shortcut_status.conflicts.is_empty() {
        "Capso — shortcut conflict; Capture menu remains available"
    } else if shortcut_status.storage_warning.is_some() {
        "Capso — shortcut settings warning; defaults are active"
    } else if queue_status.summary.queued() > 0 {
        "Capso — captures saved locally and waiting to sync"
    } else if latency_report.warning.is_some() {
        "Capso — overlay timing evidence unavailable; captures are unaffected"
    } else {
        "Capso"
    }
}

fn tray_template_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate@2x.png"))
}

#[derive(Debug, Eq, PartialEq)]
struct LatencyMenuCopy {
    title: String,
    status: String,
    statistics: Option<String>,
}

fn latency_menu_copy(report: &latency::OverlayLatencyReport) -> LatencyMenuCopy {
    if report.warning.is_some() {
        return LatencyMenuCopy {
            title: "Overlay Speed Check — unavailable".into(),
            status: "Timing evidence could not be saved; captures are unaffected".into(),
            statistics: None,
        };
    }

    let statistics = report.max_ms.map(|maximum| {
        format!(
            "p50 {} ms · p90 {} ms · max {maximum} ms",
            report.p50_ms.unwrap_or(maximum),
            report.p90_ms.unwrap_or(maximum),
        )
    });
    if !report.complete {
        return LatencyMenuCopy {
            title: format!(
                "Overlay Speed Check — {}/{}",
                report.sample_count, report.required_samples
            ),
            status: format!(
                "Make {} more real {} to verify under 1 second",
                report.required_samples - report.sample_count,
                if report.required_samples - report.sample_count == 1 {
                    "capture"
                } else {
                    "captures"
                }
            ),
            statistics,
        };
    }

    LatencyMenuCopy {
        title: if report.passes {
            "Overlay Speed Check — PASS".into()
        } else {
            "Overlay Speed Check — needs attention".into()
        },
        status: format!(
            "{}/{} latest real captures under 1 second",
            report.under_sla_count, report.required_samples
        ),
        statistics,
    }
}

fn queue_menu_label(status: &queue::QueueRuntimeStatus) -> Option<String> {
    if status.warning.is_some() {
        return Some("Uploads need attention — captures remain local".into());
    }
    if status.summary.failed > 0 {
        return Some(format!(
            "{} {} could not sync — originals stay local",
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
            "{queued} {} saved locally — choose Retry Sync Now",
            if queued == 1 { "capture" } else { "captures" }
        )
    })
}

const RETRY_UPLOADS_MENU_ID: &str = "retry-uploads";
const OPEN_SETTINGS_MENU_ID: &str = "open-settings";

fn screen_recording_guidance_needed(status: system::ScreenRecordingStatus) -> bool {
    status == system::ScreenRecordingStatus::Required
}

fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    shortcut_status: &shortcuts::ShortcutStatus,
    system_status: &system::SystemStatus,
    queue_status: &queue::QueueRuntimeStatus,
    _latency_report: &latency::OverlayLatencyReport,
) -> tauri::Result<Menu<R>> {
    let mut menu_builder =
        MenuBuilder::new(app).text(capture_hud::OPEN_CAPTURE_HUD_MENU_ID, "Capture…");
    menu_builder = menu_builder.text(
        recording::OPEN_RECORDING_STUDIO_MENU_ID,
        recording::recording_menu_label(app),
    );
    if overlay::has_temporarily_hidden_capture(app) {
        menu_builder = menu_builder.text(overlay::SHOW_HIDDEN_OVERLAY_MENU_ID, "Show Quick Access");
    }
    menu_builder = menu_builder.separator();
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
    menu_builder = menu_builder.text(
        shortcuts::CAPTURE_REGION_TIMER_MENU_ID,
        "Capture Region in 5 Seconds",
    );

    let mut recent_builder = SubmenuBuilder::with_id(app, "recent-captures", "Recent Captures");
    match history::recent_menu_entries_for_app(app) {
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
            for entry in captures {
                let item = IconMenuItemBuilder::with_id(
                    history::recent_menu_id(&entry.capture.id),
                    history::recent_capture_label(&entry.capture, now),
                )
                .icon(entry.thumbnail)
                .build(app)?;
                recent_builder = recent_builder.item(&item);
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
    let open_library = MenuItem::with_id(
        app,
        history::OPEN_LIBRARY_MENU_ID,
        "Open Web Library…",
        true,
        None::<&str>,
    )?;
    let open_history = MenuItem::with_id(
        app,
        history::OPEN_HISTORY_MENU_ID,
        "Capture History…",
        true,
        None::<&str>,
    )?;
    menu_builder = menu_builder
        .separator()
        .item(&open_history)
        .item(&open_library)
        .item(&recent_submenu);

    // Only actionable problems earn a place in the daily menu. The overlay-speed
    // evidence and the full queue breakdown now live in Settings → Advanced.
    let mut has_alert = false;

    if let Some(label) = queue_menu_label(queue_status) {
        let retryable = queue_status.summary.pending
            + queue_status.summary.uploading
            + queue_status.summary.retrying;
        if retryable > 0 {
            let queue_item =
                MenuItem::with_id(app, "upload-queue-status", label, false, None::<&str>)?;
            menu_builder = menu_builder.separator().item(&queue_item);
            has_alert = true;
            let retry_item = MenuItem::with_id(
                app,
                RETRY_UPLOADS_MENU_ID,
                "Retry Sync Now",
                true,
                None::<&str>,
            )?;
            menu_builder = menu_builder.item(&retry_item);
        }
    }

    if screen_recording_guidance_needed(system_status.screen_recording) {
        let permission_warning = MenuItem::with_id(
            app,
            OPEN_SETTINGS_MENU_ID,
            "Screen Recording required — open Settings to grant",
            true,
            None::<&str>,
        )?;
        if !has_alert {
            menu_builder = menu_builder.separator();
        }
        menu_builder = menu_builder.item(&permission_warning);
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

    let settings = MenuItem::with_id(app, OPEN_SETTINGS_MENU_ID, "Settings…", true, Some("cmd+,"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Capso", true, Some("cmd+q"))?;
    menu_builder.separator().item(&settings).item(&quit).build()
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

pub(crate) fn refresh_recording_tray_title(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(recording::recording_tray_title(app));
    }
}

fn refresh_tray_status(app: &AppHandle) -> Result<(), String> {
    let shortcut_status = current_shortcut_status(app)?;
    let system_status = current_system_status(app)?;
    let queue_status = current_queue_status(app)?;
    let latency_report = latency::current_report(app)?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(
            build_tray_menu(
                app,
                &shortcut_status,
                &system_status,
                &queue_status,
                &latency_report,
            )
            .map_err(|error| error.to_string())?,
        ))
        .map_err(|error| error.to_string())?;
        tray.set_tooltip(Some(tray_tooltip(
            &shortcut_status,
            &system_status,
            &queue_status,
            &latency_report,
        )))
        .map_err(|error| error.to_string())?;
    }
    refresh_recording_tray_title(app);
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutRecordingResult {
    generation: u64,
    active: bool,
    status: shortcuts::ShortcutStatus,
}

fn shortcut_recording_result(runtime: &shortcuts::ShortcutRuntime) -> ShortcutRecordingResult {
    ShortcutRecordingResult {
        generation: runtime.recording_generation,
        active: runtime.recording_suspended,
        status: runtime.status(),
    }
}

fn transition_shortcut_recording(
    app: &AppHandle,
    runtime: &mut shortcuts::ShortcutRuntime,
    active: bool,
    generation: Option<u64>,
) -> Result<ShortcutRecordingResult, String> {
    if active && runtime.recording_suspended {
        runtime.renew_recording_session();
        return Ok(shortcut_recording_result(runtime));
    }
    if !active && !runtime.recording_suspended {
        return Ok(shortcut_recording_result(runtime));
    }
    if !active
        && !generation.is_some_and(|generation| runtime.recording_session_matches(generation))
    {
        return Ok(shortcut_recording_result(runtime));
    }

    let registered_before = runtime.active_bindings.clone();
    let restore_on_failure = runtime.desired_active_bindings();
    let candidate = if active {
        Vec::new()
    } else {
        runtime.suspended_bindings.clone()
    };
    let mut registry = TauriShortcutRegistry { app };
    match shortcuts::replace_registered_shortcuts(
        &mut registry,
        &registered_before,
        &restore_on_failure,
        &candidate,
        || Ok(()),
    ) {
        Ok(()) if active => {
            runtime.begin_recording_session(registered_before);
            Ok(shortcut_recording_result(runtime))
        }
        Ok(()) => {
            runtime.finish_recording_resume_success(candidate);
            Ok(shortcut_recording_result(runtime))
        }
        Err(error) if active => {
            runtime.reconcile_failed_update(&error);
            Err(error.message)
        }
        Err(error) => {
            runtime.finish_recording_resume_failure(&error);
            Ok(shortcut_recording_result(runtime))
        }
    }
}

#[tauri::command]
fn set_shortcut_recording(
    app: AppHandle,
    state: State<'_, Mutex<shortcuts::ShortcutRuntime>>,
    active: bool,
    generation: Option<u64>,
) -> Result<ShortcutRecordingResult, String> {
    let mut runtime = state
        .lock()
        .map_err(|_| "Shortcut settings are temporarily unavailable".to_string())?;
    let result = transition_shortcut_recording(&app, &mut runtime, active, generation);
    drop(runtime);
    if !active || result.is_err() {
        if let Err(error) = refresh_tray_status(&app) {
            eprintln!("Could not refresh the tray after shortcut recording: {error}");
        }
    }
    result
}

fn restore_shortcuts_after_recording(app: &AppHandle) {
    let state = app.state::<Mutex<shortcuts::ShortcutRuntime>>();
    let mut runtime = match state.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("Could not restore capture shortcuts because their state is unavailable");
            return;
        }
    };
    if !runtime.recording_suspended {
        return;
    }
    let generation = runtime.recording_generation;
    let result = transition_shortcut_recording(app, &mut runtime, false, Some(generation));
    drop(runtime);

    if let Err(error) = refresh_tray_status(app) {
        eprintln!("Could not refresh the tray after recorder focus changed: {error}");
    }
    match result {
        Ok(status) => {
            let _ = app.emit("shortcut-recording-ended", status);
        }
        Err(error) => {
            eprintln!("Could not restore capture shortcuts after recorder focus changed: {error}");
        }
    }
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

/// Read-only diagnostics for Settings → Advanced. It reuses the exact copy the tray
/// menu builds, so the window and the menu can never disagree about sync or latency.
#[derive(serde::Serialize)]
struct Diagnostics {
    latency_title: String,
    latency_status: String,
    latency_statistics: Option<String>,
    queue_label: Option<String>,
    queue_retryable: u32,
    automation_status: Option<automation::AutomationFeedback>,
}

#[tauri::command]
fn get_diagnostics(app: AppHandle) -> Result<Diagnostics, String> {
    let latency_report = latency::current_report(&app)?;
    let latency_copy = latency_menu_copy(&latency_report);
    let queue_status = current_queue_status(&app)?;
    let retryable = queue_status.summary.pending
        + queue_status.summary.uploading
        + queue_status.summary.retrying;
    Ok(Diagnostics {
        latency_title: latency_copy.title,
        latency_status: latency_copy.status,
        latency_statistics: latency_copy.statistics,
        queue_label: queue_menu_label(&queue_status),
        queue_retryable: u32::try_from(retryable).unwrap_or(u32::MAX),
        automation_status: app.state::<automation::AutomationFeedbackState>().current(),
    })
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
fn restart_capso(app: AppHandle) {
    app.request_restart();
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
    let app = tauri::Builder::default()
        // This must remain the first plugin. A second Capso process can otherwise
        // compete for the same global shortcuts and make a healthy binding appear
        // inert depending on which bundle launched first.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Mutex::new(shortcuts::ShortcutRuntime::default()))
        .manage(Mutex::new(
            settings_transfer::SettingsTransferRuntime::default(),
        ))
        .manage(Mutex::new(system::PermissionRuntime::default()))
        .manage(Mutex::new(self_timer::CaptureTimerRuntime::default()))
        .manage(freeze::FreezeCoordinator::default())
        .manage(area_selector::AreaSelectorCoordinator::default())
        .manage(Mutex::new(overlay::OverlayRuntime::default()))
        .manage(Mutex::new(pin::PinRuntime::default()))
        .manage(Mutex::new(annotation::AnnotationRuntime::default()))
        .manage(Mutex::new(annotation_sync::AnnotationSyncRuntime::default()))
        .manage(Mutex::new(clipboard::ClipboardRuntime::default()))
        .manage(Mutex::new(queue::QueueRuntime::default()))
        .manage(Mutex::new(recording::RecordingRuntime::default()))
        .manage(Mutex::new(ocr::OcrRuntime::default()))
        .manage(Mutex::new(latency::OverlayLatencyRuntime::default()))
        .manage(drain::DrainCoordinator::default())
        .manage(retry::ConnectivityState::default())
        .manage(retry::RetryMonitorSignal::default())
        .manage(AuthAccountBoundary::default())
        .manage(AuthFeedbackState::default())
        .manage(SyncFeedbackState::default())
        .manage(automation::AutomationFeedbackState::default())
        .manage(auth::ProductionAuthRuntime::from_embedded())
        .manage(Mutex::new(sync::ProductionSyncRuntime::from_embedded()))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if should_ignore_global_shortcut(annotation::is_active(app)) {
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
            set_shortcut_recording,
            update_shortcut_settings,
            export_portable_settings,
            import_portable_settings,
            reset_portable_settings,
            get_system_status,
            get_diagnostics,
            get_sync_status,
            get_capture_projects,
            retry_sync,
            get_device_info,
            open_web_library,
            open_capture_history,
            get_local_history,
            remove_history_captures,
            clear_capture_history,
            restore_history_captures,
            get_overlay_settings,
            get_save_as_preferences,
            choose_capture_save_directory,
            update_overlay_settings,
            restore_history_capture,
            recognize_history_capture_text,
            recognize_selected_png_text,
            recognize_screen_selection_text,
            copy_recognized_text,
            copy_recognized_link,
            combine_history_captures,
            frame_history_capture,
            get_annotation_project_sync_status,
            retry_annotation_project_sync,
            keep_local_annotation_project,
            request_screen_recording_permission,
            open_screen_recording_settings,
            restart_capso,
            set_launch_at_login_enabled,
            open_login_item_settings,
            get_capture_timer_status,
            cancel_capture_timer,
            get_capture_hud_settings,
            show_capture_hud,
            hide_capture_hud,
            start_capture_from_hud,
            start_previous_area_capture,
            get_freeze_frame,
            freeze_frame_ready,
            cancel_freeze_capture,
            get_area_selector,
            complete_area_selection,
            cancel_area_selection,
            get_auth_status,
            request_sign_in_email,
            request_reconnect_email,
            sign_out,
            overlay::get_overlay_capture,
            overlay::get_overlay_sync_status,
            overlay::get_overlay_file_info,
            overlay::reveal_overlay_capture,
            overlay::open_overlay_capture,
            overlay::assign_overlay_project,
            overlay::overlay_image_ready,
            overlay::overlay_image_failed,
            overlay::overlay_copy_capture,
            overlay::overlay_save_capture,
            overlay::overlay_start_drag,
            overlay::overlay_hide_temporarily,
            overlay::overlay_set_auto_dismiss_paused,
            overlay::overlay_dismiss,
            pin::pin_overlay_capture,
            pin::get_pin_capture,
            pin::pin_image_ready,
            pin::copy_pin_capture,
            pin::resize_pin_capture,
            pin::set_pin_opacity,
            pin::set_pin_locked,
            pin::close_pin_capture,
            recording::open_recording_studio,
            recording::hide_recording_studio,
            recording::get_recording_capabilities,
            recording::request_recording_microphone_access,
            recording::open_recording_microphone_settings,
            recording::get_recording_status,
            recording::start_recording,
            recording::stop_recording,
            recording::open_recording_output,
            recording::reveal_recording_output,
            recording::trim_recording,
            recording::export_recording_gif,
            annotation::open_annotation_editor,
            annotation::open_history_annotation_editor,
            annotation::get_annotation_capture,
            annotation::cancel_annotation_editor,
            annotation::copy_annotation_image,
            annotation::export_annotation_copy,
            annotation::start_annotation_drag,
            annotation::save_annotation_editor
        ])
        .setup(|app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                if let Some(urls) = app.deep_link().get_current()? {
                    for url in urls {
                        receive_deep_link(app.handle(), url.as_str());
                    }
                }
                let auth_app = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        receive_deep_link(&auth_app, url.as_str());
                    }
                });
            }

            if let Ok(cache_directory) = app.path().app_cache_dir() {
                let _ = dragout::cleanup_drag_exports(&cache_directory.join("drag-exports"));
            }
            if let Err(error) = ocr::cleanup_ephemeral_selections(app.handle()) {
                eprintln!("Could not clean stale private OCR screen selections: {error}");
            }
            if let Ok(app_data) = app.path().app_data_dir() {
                if let Err(error) = capture::cleanup_stale_freeze_frames(&app_data) {
                    eprintln!("Could not clean stale private Freeze Screen frames: {error}");
                }
            }

            let queue_status = queue::initialize_for_app(app.handle())
                .map_err(|error| format!("Could not initialize upload queue state: {error}"))?;
            annotation_sync::initialize_for_app(app.handle()).map_err(|error| {
                format!("Could not initialize editable project sync state: {error}")
            })?;
            let latency_report = latency::initialize_for_app(app.handle())
                .map_err(|error| format!("Could not initialize overlay timing state: {error}"))?;

            // The panel remains non-focusable but accepts deliberate Quick
            // Access clicks without activating Capso or blocking outside it.
            if let Some(overlay_window) = app.get_webview_window(overlay::OVERLAY_LABEL) {
                overlay_window.set_ignore_cursor_events(false)?;
            }
            if let Err(error) = pin::restore_pinned_captures(app.handle()) {
                eprintln!("Could not restore pinned captures: {error}");
            }
            if let Err(error) = recording::recover_desktop_clutter(app.handle()) {
                recording::note_desktop_clutter_warning(app.handle(), error.clone());
                eprintln!(
                    "Could not recover desktop icons after an interrupted recording: {error}"
                );
            }
            if let Err(error) = recording::recover_interrupted_recordings(app.handle()) {
                eprintln!("Could not recover interrupted recordings: {error}");
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
            let menu = build_tray_menu(
                app.handle(),
                &status,
                &system_status,
                &queue_status,
                &latency_report,
            )?;
            TrayIconBuilder::with_id("main")
                .icon(tray_template_icon()?)
                .icon_as_template(true)
                .tooltip(tray_tooltip(
                    &status,
                    &system_status,
                    &queue_status,
                    &latency_report,
                ))
                .menu(&menu)
                // One menu on either click. Capture actions are the reason to open the
                // icon; Settings is a rare destination behind its own item.
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    if event.id() == capture_hud::OPEN_CAPTURE_HUD_MENU_ID {
                        if let Err(error) = show_capture_hud(app.clone()) {
                            if let Some(tray) = app.tray_by_id("main") {
                                let _ = tray.set_tooltip(Some(format!(
                                    "Capso — could not open capture controls; {error}"
                                )));
                            }
                        }
                    } else if event.id() == recording::OPEN_RECORDING_STUDIO_MENU_ID {
                        if let Err(error) = recording::show_recording_studio(app) {
                            if let Some(tray) = app.tray_by_id("main") {
                                let _ = tray.set_tooltip(Some(format!(
                                    "Capso — could not open recording controls; {error}"
                                )));
                            }
                        }
                    } else if event.id() == shortcuts::CAPTURE_REGION_TIMER_MENU_ID {
                        let _ = launch_capture_timer(
                            app.clone(),
                            shortcuts::CaptureAction::Region,
                            5,
                            false,
                        );
                    } else if event.id() == overlay::SHOW_HIDDEN_OVERLAY_MENU_ID {
                        if let Err(error) = overlay::restore_temporarily_hidden_overlay(app) {
                            if let Some(tray) = app.tray_by_id("main") {
                                let _ = tray.set_tooltip(Some(format!(
                                    "Capso — could not restore Quick Access; {error}"
                                )));
                            }
                        }
                    } else if let Some(action) = shortcuts::action_for_menu_id(event.id().as_ref())
                    {
                        launch_capture(app.clone(), action);
                    } else if event.id() == history::OPEN_LIBRARY_MENU_ID {
                        if let Err(error) = history::open_library() {
                            if let Some(tray) = app.tray_by_id("main") {
                                let _ = tray.set_tooltip(Some(format!(
                                    "Capso — could not open library; {error}"
                                )));
                            }
                        }
                    } else if event.id() == history::OPEN_HISTORY_MENU_ID {
                        if let Err(error) = history::show_history_window(app) {
                            if let Some(tray) = app.tray_by_id("main") {
                                let _ = tray.set_tooltip(Some(format!(
                                    "Capso — could not open history; {error}"
                                )));
                            }
                        }
                    } else if let Some(id) = history::parse_recent_menu_id(event.id().as_ref()) {
                        if let Err(error) = restore_recent_capture(app, &id) {
                            if let Some(tray) = app.tray_by_id("main") {
                                let _ = tray.set_tooltip(Some(format!(
                                    "Capso — could not restore capture; {error}"
                                )));
                            }
                        }
                    } else if event.id() == RETRY_UPLOADS_MENU_ID {
                        spawn_background_sync(app.clone(), drain::DrainWake::RetryDeadline);
                    } else if event.id() == OPEN_SETTINGS_MENU_ID {
                        open_settings_window(app);
                    } else if event.id() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;

            // The app lives in the menu bar, so it starts with no window. A first
            // launch that still needs Screen Recording is the one case where staying
            // silent would look like a failed launch, so Settings opens to be granted.
            // Re-launching an already-running copy reveals it via single-instance and
            // Reopen, so an already-configured Mac boots straight to the menu bar.
            if screen_recording_guidance_needed(system_status.screen_recording) {
                open_settings_window(app.handle());
            }

            #[cfg(target_os = "macos")]
            spawn_background_retry_monitor(app.handle().clone())?;

            #[cfg(target_os = "macos")]
            spawn_background_sync(app.handle().clone(), drain::DrainWake::Startup);

            Ok(())
        })
        .on_window_event(|window, event| {
            pin::record_window_geometry(window.app_handle(), window.label(), event);
            // Closing the popover hides it — the app lives in the menu bar.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    restore_shortcuts_after_recording(window.app_handle());
                }
                if window.label() == self_timer::TIMER_LABEL {
                    api.prevent_close();
                    cancel_capture_timer_from_window(window.app_handle());
                    let _ = window.hide();
                    return;
                }
                if window.label() == capture_hud::HUD_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                if window.label() == freeze::FREEZE_LABEL {
                    api.prevent_close();
                    cancel_freeze_capture_from_window(window.app_handle());
                    let _ = window.hide();
                    return;
                }
                if window.label() == area_selector::AREA_SELECTOR_LABEL {
                    api.prevent_close();
                    cancel_area_selection_from_window(window.app_handle());
                    let _ = window.hide();
                    return;
                }
                if pin::is_pin_window_label(window.label()) {
                    api.prevent_close();
                    pin::close_from_window_request(window.app_handle(), window.label());
                    return;
                }
                api.prevent_close();
                if window.label() == annotation::ANNOTATION_LABEL {
                    if annotation::cancel_from_window_close(window.app_handle()) {
                        let _ = window.hide();
                    }
                } else {
                    let _ = window.hide();
                }
            } else if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "main" {
                    restore_shortcuts_after_recording(window.app_handle());
                }
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            if should_reveal_main_on_reopen(has_visible_windows) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{capture, clipboard, drain, latency, overlay, queue};
    use crate::annotation_sync;
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };

    #[test]
    fn only_an_active_annotation_blocks_global_capture_shortcuts() {
        assert!(!super::should_ignore_global_shortcut(false));
        assert!(super::should_ignore_global_shortcut(true));
    }

    fn latency_report(
        sample_count: usize,
        under_sla_count: usize,
        p50_ms: Option<u64>,
        p90_ms: Option<u64>,
        max_ms: Option<u64>,
        warning: Option<&str>,
    ) -> latency::OverlayLatencyReport {
        latency::OverlayLatencyReport {
            sample_count,
            required_samples: 20,
            under_sla_count,
            p50_ms,
            p90_ms,
            max_ms,
            complete: sample_count == 20,
            passes: sample_count == 20 && under_sla_count == 20,
            warning: warning.map(str::to_string),
        }
    }

    fn event_json(
        result: Result<capture::CaptureOutcome, capture::CaptureFailure>,
    ) -> serde_json::Value {
        serde_json::to_value(super::capture_event(&result)).expect("serialize capture event")
    }

    #[test]
    fn the_menu_bar_app_starts_windowless_but_is_always_reachable() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let main = config["app"]["windows"]
            .as_array()
            .expect("window configurations")
            .iter()
            .find(|window| window["label"] == "main")
            .expect("main control surface");

        // Settings is a destination, not the app itself: a configured Mac boots to the
        // menu bar alone, and never steals focus at login.
        assert_eq!(main["visible"], false);
        assert_eq!(main["skipTaskbar"], true);
        // A standard titlebar keeps the window movable and closable without the app
        // having to supply its own drag region.
        assert_eq!(main["titleBarStyle"], "Visible");
        assert_eq!(main["hiddenTitle"], false);

        // Reachability is what the old always-visible window really guaranteed, and it
        // is asserted against this file from `capture-parity.check.ts`. Scanning this
        // source from inside it cannot work: the search string would match the
        // assertion's own text and pass no matter what the menu actually builds.
        assert_eq!(super::OPEN_SETTINGS_MENU_ID, "open-settings");
    }

    #[test]
    fn menu_bar_uses_the_dedicated_template_sized_icon() {
        let icon = super::tray_template_icon().expect("decode bundled tray icon");

        assert_eq!(icon.width(), 44);
        assert_eq!(icon.height(), 44);
    }

    #[test]
    fn reopening_a_running_menu_bar_app_reveals_its_hidden_control_surface() {
        assert!(super::should_reveal_main_on_reopen(false));
        assert!(!super::should_reveal_main_on_reopen(true));
    }

    #[test]
    fn missing_effective_permission_opens_guidance_at_launch() {
        use crate::system::ScreenRecordingStatus;

        assert!(super::screen_recording_guidance_needed(
            ScreenRecordingStatus::Required
        ));
        assert!(!super::screen_recording_guidance_needed(
            ScreenRecordingStatus::Granted
        ));
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
    fn only_a_durably_queued_capture_requests_a_background_drain_wake() {
        let captured = |queue| {
            Ok(capture::CaptureOutcome::Captured {
                path: "/tmp/capso/captured.png".into(),
                clipboard: clipboard::ClipboardStatus::Copied { bytes: 42 },
                overlay: overlay::OverlayStatus::Prepared { x: 1440, y: 900 },
                queue,
            })
        };
        assert_eq!(
            super::background_wake_for_capture(&captured(queue::CaptureQueueStatus::Enqueued {
                id: "018f22c4-cada-7c6b-9d5b-fc35f7f9227a".into(),
                queued: 1,
            })),
            Some(drain::DrainWake::CaptureEnqueued)
        );
        assert_eq!(
            super::background_wake_for_capture(&captured(
                queue::CaptureQueueStatus::AlreadyQueued {
                    id: "018f22c4-cada-7c6b-9d5b-fc35f7f9227a".into(),
                    queued: 1,
                }
            )),
            Some(drain::DrainWake::CaptureEnqueued)
        );
        assert_eq!(
            super::background_wake_for_capture(&captured(queue::CaptureQueueStatus::Failed {
                code: "queue_persist_failed",
                message: "kept local".into(),
            })),
            None
        );
        assert_eq!(
            super::background_wake_for_capture(&Ok(capture::CaptureOutcome::Cancelled)),
            None
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
            last_success_at_ms: None,
        };
        assert_eq!(
            super::queue_menu_label(&one).as_deref(),
            Some("1 capture saved locally — choose Retry Sync Now")
        );

        let failed = queue::QueueRuntimeStatus {
            summary: queue::QueueSummary {
                failed: 2,
                total: 2,
                ..queue::QueueSummary::default()
            },
            warning: None,
            last_success_at_ms: None,
        };
        assert_eq!(
            super::queue_menu_label(&failed).as_deref(),
            Some("2 captures could not sync — originals stay local")
        );
    }

    #[test]
    fn sign_out_blocks_active_work_but_keeps_terminal_failures_local() {
        let status = |pending, uploading, retrying, failed, uploaded| queue::QueueRuntimeStatus {
            summary: queue::QueueSummary {
                pending,
                uploading,
                retrying,
                failed,
                uploaded,
                remote_pending: 0,
                total: pending + uploading + retrying + failed + uploaded,
            },
            warning: None,
            last_success_at_ms: None,
        };

        assert!(super::ensure_sign_out_queue_is_safe(&status(0, 0, 0, 0, 2)).is_ok());
        assert!(super::ensure_sign_out_queue_is_safe(&status(0, 0, 0, 2, 0)).is_ok());
        assert_eq!(
            super::ensure_sign_out_queue_is_safe(&status(1, 0, 0, 0, 0))
                .expect_err("pending capture blocks account switch"),
            "Wait for 1 local capture to finish syncing before signing out; no pixels were removed."
        );
        assert_eq!(
            super::ensure_sign_out_queue_is_safe(&status(0, 1, 1, 2, 0))
                .expect_err("active upload and retry block account switch"),
            "Wait for 2 local captures to finish syncing before signing out; no pixels were removed."
        );

        assert!(super::ensure_sign_out_annotation_sync_is_safe(
            &annotation_sync::AnnotationSyncSummary {
                synced: 2,
                total: 2,
                ..annotation_sync::AnnotationSyncSummary::default()
            }
        )
        .is_ok());
        assert_eq!(
            super::ensure_sign_out_annotation_sync_is_safe(
                &annotation_sync::AnnotationSyncSummary {
                    pending: 1,
                    failed: 1,
                    conflicts: 1,
                    total: 3,
                    ..annotation_sync::AnnotationSyncSummary::default()
                }
            )
            .expect_err("any unsynced editable project blocks an account switch"),
            "Resolve or sync 3 local editable projects before signing out; their protected originals remain on this Mac."
        );
    }

    #[test]
    fn stalled_background_network_does_not_block_a_fresh_capture_transition() {
        let boundary = Arc::new(super::AuthAccountBoundary::default());
        let stalled_upload = boundary.begin_drain().expect("begin stalled upload");
        let (entered_tx, entered_rx) = mpsc::channel();
        let contender = Arc::clone(&boundary);
        let worker = thread::spawn(move || {
            let _guard = contender.lock().expect("enter transition boundary");
            entered_tx.send(()).expect("announce entry");
        });

        entered_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("fresh capture enters while upload remains stalled");
        assert!(boundary.lock_for_sign_out().is_err());
        drop(stalled_upload);
        drop(
            boundary
                .lock_for_sign_out()
                .expect("drain released for sign-out"),
        );
        worker.join().expect("transition worker");
    }

    #[test]
    fn auth_feedback_retains_startup_failure_until_the_ui_reads_it() {
        let feedback = super::AuthFeedbackState::default();
        feedback.record_failure("This sign-in link expired.");
        assert_eq!(
            feedback.last_failure().as_deref(),
            Some("This sign-in link expired.")
        );
        feedback.clear();
        assert_eq!(feedback.last_failure(), None);
    }

    #[test]
    fn only_session_failures_request_reconnect_while_network_errors_stay_retryable() {
        assert!(super::sync_error_requires_reconnect(
            "Capso's saved session is invalid; sign in again."
        ));
        assert!(super::sync_error_requires_reconnect(
            "Supabase rejected the sign-in exchange; start sign-in again."
        ));
        assert!(super::sync_error_requires_reconnect(
            "This Mac was disconnected from Capso. Reconnect the same account to resume sync."
        ));
        assert!(super::sync_error_is_device_revoked(
            "This Mac was disconnected from Capso. Reconnect the same account to resume sync."
        ));
        assert!(!super::sync_error_requires_reconnect(
            "Capso could not reach Supabase Auth; try again when online."
        ));
        assert!(!super::sync_error_requires_reconnect(
            "Could not commit Capso's upload queue."
        ));
    }

    #[test]
    fn overlay_speed_menu_never_claims_pass_before_twenty_real_samples() {
        assert_eq!(
            super::latency_menu_copy(&latency_report(
                19,
                19,
                Some(410),
                Some(730),
                Some(890),
                None,
            )),
            super::LatencyMenuCopy {
                title: "Overlay Speed Check — 19/20".into(),
                status: "Make 1 more real capture to verify under 1 second".into(),
                statistics: Some("p50 410 ms · p90 730 ms · max 890 ms".into()),
            }
        );

        assert_eq!(
            super::latency_menu_copy(&latency_report(
                20,
                20,
                Some(420),
                Some(760),
                Some(940),
                None,
            )),
            super::LatencyMenuCopy {
                title: "Overlay Speed Check — PASS".into(),
                status: "20/20 latest real captures under 1 second".into(),
                statistics: Some("p50 420 ms · p90 760 ms · max 940 ms".into()),
            }
        );

        assert_eq!(
            super::latency_menu_copy(&latency_report(
                20,
                18,
                Some(500),
                Some(990),
                Some(1_140),
                None,
            ))
            .title,
            "Overlay Speed Check — needs attention"
        );
        assert_eq!(
            super::latency_menu_copy(&latency_report(
                0,
                0,
                None,
                None,
                None,
                Some("private disk error"),
            ))
            .status,
            "Timing evidence could not be saved; captures are unaffected"
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
