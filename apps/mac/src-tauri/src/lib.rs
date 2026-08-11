mod annotation;
mod auth;
mod capture;
mod clipboard;
mod dragout;
mod drain;
mod history;
mod ingest;
mod latency;
mod overlay;
mod pin;
mod queue;
mod retry;
mod self_timer;
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
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};
#[cfg(target_os = "macos")]
use tauri_plugin_deep_link::DeepLinkExt;
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthUiSnapshot {
    configured: bool,
    account: auth::AuthAccountStatus,
    last_failure: Option<String>,
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
            app.state::<AuthFeedbackState>().clear();
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

#[cfg(target_os = "macos")]
#[tauri::command]
async fn sign_out(app: AppHandle) -> Result<auth::AuthAccountStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let boundary = app.state::<AuthAccountBoundary>();
        let _guard = boundary.lock_for_sign_out()?;
        ensure_sign_out_queue_is_safe(&current_queue_status(&app)?)?;
        let status = app.state::<auth::ProductionAuthRuntime>().sign_out()?;
        app.state::<AuthFeedbackState>().clear();
        let _ = app.emit("auth-status-changed", &status);
        Ok(status)
    })
    .await
    .map_err(|error| format!("Capso could not finish its sign-out task: {error}"))?
}

#[cfg(target_os = "macos")]
pub(crate) fn spawn_background_sync(app: AppHandle, wake: drain::DrainWake) {
    app.state::<retry::RetryMonitorSignal>().notify();
    let _sync_task = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
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
            sync.wake(wake, &coordinator, &*queue, now_ms, connectivity_available)
        })();
        if let Err(error) = result {
            eprintln!("Capso background sync wake failed safely: {error}");
        }
        if let Err(error) = refresh_tray_status(&app) {
            eprintln!("Could not refresh Capso after background sync: {error}");
        }
        app.state::<retry::RetryMonitorSignal>().notify();
    });
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
                let timed_wake = planner.observe(
                    now_ms,
                    snapshot.next_retry_at_ms,
                    connectivity.permits_sync(),
                );
                let wake = if transition == retry::ConnectivityTransition::Restored {
                    Some(drain::DrainWake::ConnectivityRestored)
                } else {
                    timed_wake
                };
                if let Some(wake) = wake {
                    spawn_background_sync(app.clone(), wake);
                }
                retry::RetryMonitorSignal::wait(
                    &receiver,
                    retry::RetryDeadlinePlanner::wait_ms(
                        now_ms,
                        snapshot.next_retry_at_ms,
                        snapshot.has_retryable_work,
                        &connectivity,
                    ),
                );

                if probe.is_none() {
                    probe = retry::SystemConnectivityProbe::new().ok();
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Capso could not start its background retry monitor: {error}"))
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

        if let Some(wake) = background_wake_for_capture(&result) {
            #[cfg(target_os = "macos")]
            spawn_background_sync(app.clone(), wake);
        }

        let _ = app.emit("capture-finished", capture_event(&result));
    });
}

fn launch_region_self_timer(app: AppHandle) {
    let outcome = match app.state::<Mutex<self_timer::RegionTimerRuntime>>().lock() {
        Ok(mut runtime) => runtime.start(),
        Err(_) => return,
    };
    let status = match outcome {
        self_timer::StartOutcome::Started(status) => status,
        self_timer::StartOutcome::AlreadyRunning(status) => {
            if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
                let _ = window.show();
            }
            let _ = app.emit_to(self_timer::TIMER_LABEL, "region-timer-changed", status);
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some("Capso — a 5-second area timer is already running"));
            }
            return;
        }
    };

    if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
        let _ = window.show();
    }
    let _ = app.emit_to(
        self_timer::TIMER_LABEL,
        "region-timer-changed",
        status.clone(),
    );
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(
            "Capso — area capture starts in 5 seconds; Cancel is available",
        ));
    }

    let generation = status.generation;
    let _timer_task = tauri::async_runtime::spawn_blocking(move || {
        for seconds_remaining in (1..self_timer::TIMER_SECONDS).rev() {
            thread::sleep(Duration::from_secs(1));
            let status = app
                .state::<Mutex<self_timer::RegionTimerRuntime>>()
                .lock()
                .ok()
                .and_then(|mut runtime| runtime.tick(generation, seconds_remaining));
            let Some(status) = status else {
                return;
            };
            let _ = app.emit_to(self_timer::TIMER_LABEL, "region-timer-changed", status);
        }

        thread::sleep(Duration::from_secs(1));
        let should_capture = app
            .state::<Mutex<self_timer::RegionTimerRuntime>>()
            .lock()
            .map(|mut runtime| runtime.finish(generation))
            .unwrap_or(false);
        if !should_capture {
            return;
        }
        if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
            let _ = window.hide();
        }
        launch_capture(app, shortcuts::CaptureAction::Region);
    });
}

#[tauri::command]
fn get_region_self_timer_status(
    state: State<'_, Mutex<self_timer::RegionTimerRuntime>>,
) -> Result<self_timer::RegionTimerStatus, String> {
    state
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "The area capture timer is temporarily unavailable.".to_string())
}

#[tauri::command]
fn cancel_region_self_timer(
    app: AppHandle,
    state: State<'_, Mutex<self_timer::RegionTimerRuntime>>,
) -> Result<bool, String> {
    let cancelled = state
        .lock()
        .map_err(|_| "The area capture timer is temporarily unavailable.".to_string())?
        .cancel();
    let Some(status) = cancelled else {
        return Ok(false);
    };

    let _ = app.emit_to(self_timer::TIMER_LABEL, "region-timer-changed", status);
    if let Some(window) = app.get_webview_window(self_timer::TIMER_LABEL) {
        let _ = window.hide();
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some("Capso — area capture timer cancelled"));
    }
    Ok(true)
}

fn cancel_region_self_timer_from_window(app: &AppHandle) {
    let state = app.state::<Mutex<self_timer::RegionTimerRuntime>>();
    if let Ok(mut runtime) = state.lock() {
        let _ = runtime.cancel();
    };
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

/// Settings is a destination, not a toggle: an already-open window is raised and
/// focused rather than hidden, so choosing "Settings…" always shows settings.
fn open_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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

fn tray_tooltip(
    shortcut_status: &shortcuts::ShortcutStatus,
    system_status: &system::SystemStatus,
    queue_status: &queue::QueueRuntimeStatus,
    latency_report: &latency::OverlayLatencyReport,
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

fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    shortcut_status: &shortcuts::ShortcutStatus,
    system_status: &system::SystemStatus,
    queue_status: &queue::QueueRuntimeStatus,
    latency_report: &latency::OverlayLatencyReport,
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
        "Open Library…",
        true,
        None::<&str>,
    )?;
    menu_builder = menu_builder
        .separator()
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

    if system_status.screen_recording == system::ScreenRecordingStatus::Required {
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

/// Read-only diagnostics for Settings → Advanced. It reuses the exact copy the tray
/// menu builds, so the window and the menu can never disagree about sync or latency.
#[derive(serde::Serialize)]
struct Diagnostics {
    latency_title: String,
    latency_status: String,
    latency_statistics: Option<String>,
    queue_label: Option<String>,
    queue_retryable: u32,
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
        .manage(Mutex::new(system::PermissionRuntime::default()))
        .manage(Mutex::new(self_timer::RegionTimerRuntime::default()))
        .manage(Mutex::new(overlay::OverlayRuntime::default()))
        .manage(Mutex::new(pin::PinRuntime::default()))
        .manage(Mutex::new(annotation::AnnotationRuntime::default()))
        .manage(Mutex::new(clipboard::ClipboardRuntime::default()))
        .manage(Mutex::new(queue::QueueRuntime::default()))
        .manage(Mutex::new(latency::OverlayLatencyRuntime::default()))
        .manage(drain::DrainCoordinator::default())
        .manage(retry::ConnectivityState::default())
        .manage(retry::RetryMonitorSignal::default())
        .manage(AuthAccountBoundary::default())
        .manage(AuthFeedbackState::default())
        .manage(auth::ProductionAuthRuntime::from_embedded())
        .manage(Mutex::new(sync::ProductionSyncRuntime::from_embedded()))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let settings_are_focused = app
                        .get_webview_window("main")
                        .and_then(|window| window.is_focused().ok())
                        .unwrap_or(false);
                    if settings_are_focused || annotation::is_active(app) {
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
            get_diagnostics,
            request_screen_recording_permission,
            open_screen_recording_settings,
            set_launch_at_login_enabled,
            open_login_item_settings,
            get_region_self_timer_status,
            cancel_region_self_timer,
            get_auth_status,
            request_sign_in_email,
            sign_out,
            overlay::get_overlay_capture,
            overlay::overlay_image_ready,
            overlay::overlay_image_failed,
            overlay::overlay_copy_capture,
            overlay::overlay_save_capture,
            overlay::overlay_start_drag,
            overlay::overlay_dismiss,
            pin::pin_overlay_capture,
            pin::get_pin_capture,
            pin::pin_image_ready,
            pin::copy_pin_capture,
            pin::close_pin_capture,
            annotation::open_annotation_editor,
            annotation::get_annotation_capture,
            annotation::cancel_annotation_editor,
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
                        spawn_auth_callback(app.handle().clone(), url.to_string());
                    }
                }
                let auth_app = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        spawn_auth_callback(auth_app.clone(), url.to_string());
                    }
                });
            }

            if let Ok(cache_directory) = app.path().app_cache_dir() {
                let _ = dragout::cleanup_drag_exports(&cache_directory.join("drag-exports"));
            }

            let queue_status = queue::initialize_for_app(app.handle())
                .map_err(|error| format!("Could not initialize upload queue state: {error}"))?;
            let latency_report = latency::initialize_for_app(app.handle())
                .map_err(|error| format!("Could not initialize overlay timing state: {error}"))?;

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
                    if event.id() == shortcuts::CAPTURE_REGION_TIMER_MENU_ID {
                        launch_region_self_timer(app.clone());
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
            if system_status.screen_recording == system::ScreenRecordingStatus::Required {
                open_settings_window(app.handle());
            }

            #[cfg(target_os = "macos")]
            spawn_background_retry_monitor(app.handle().clone())?;

            #[cfg(target_os = "macos")]
            spawn_background_sync(app.handle().clone(), drain::DrainWake::Startup);

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the popover hides it — the app lives in the menu bar.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == self_timer::TIMER_LABEL {
                    api.prevent_close();
                    cancel_region_self_timer_from_window(window.app_handle());
                    let _ = window.hide();
                    return;
                }
                if window.label() == pin::PIN_LABEL {
                    api.prevent_close();
                    pin::clear_from_window_close(window.app_handle());
                    let _ = window.hide();
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
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };

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
        assert!(main.get("titleBarStyle").is_none());

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
                total: pending + uploading + retrying + failed + uploaded,
            },
            warning: None,
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
