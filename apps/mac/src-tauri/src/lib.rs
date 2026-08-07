mod capture;
mod shortcuts;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

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

fn launch_capture(app: AppHandle, action: shortcuts::CaptureAction) {
    if CAPTURE_IN_PROGRESS.swap(true, Ordering::AcqRel) {
        return;
    }

    let _capture_task = tauri::async_runtime::spawn(async move {
        let result = capture::capture_screen(app.clone(), action.mode()).await;
        CAPTURE_IN_PROGRESS.store(false, Ordering::Release);

        if let Err(error) = &result {
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(format!("Capso — {}", error.message)));
            }
        }

        let _ = app.emit("capture-finished", result);
    });
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

fn shortcut_tooltip(status: &shortcuts::ShortcutStatus) -> &'static str {
    if !status.conflicts.is_empty() {
        "Capso — shortcut conflict; Capture menu remains available"
    } else if status.storage_warning.is_some() {
        "Capso — shortcut settings warning; defaults are active"
    } else {
        "Capso"
    }
}

fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    status: &shortcuts::ShortcutStatus,
) -> tauri::Result<Menu<R>> {
    let mut menu_builder = MenuBuilder::new(app);
    for definition in shortcuts::definitions() {
        menu_builder = menu_builder.text(definition.menu_id, definition.menu_label);
    }

    let warning_label =
        shortcuts::conflict_label(&status.conflicts).or_else(|| status.storage_warning.clone());
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

fn refresh_tray_status(app: &AppHandle, status: &shortcuts::ShortcutStatus) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(build_tray_menu(app, status)?))?;
        tray.set_tooltip(Some(shortcut_tooltip(status)))?;
    }
    Ok(())
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
        let status = runtime.status();
        let message = error.message;
        drop(runtime);
        if let Err(refresh_error) = refresh_tray_status(&app, &status) {
            eprintln!("Could not refresh the Capso tray after shortcut failure: {refresh_error}");
        }
        return Err(message);
    }

    runtime.replace_with(candidate);
    let status = runtime.status();
    drop(runtime);

    if let Err(error) = refresh_tray_status(&app, &status) {
        eprintln!("Could not refresh the Capso tray menu: {error}");
    }
    Ok(status)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(shortcuts::ShortcutRuntime::default()))
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
            update_shortcut_settings
        ])
        .setup(|app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

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

            let menu = build_tray_menu(app.handle(), &status)?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip(shortcut_tooltip(&status))
                .menu(&menu)
                // Left click toggles the popover; the menu stays on right click.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if let Some(action) = shortcuts::action_for_menu_id(event.id().as_ref()) {
                        launch_capture(app.clone(), action);
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
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
