mod capture;
mod shortcuts;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if let Some(action) =
                        shortcuts::action_for_event(shortcut, event.state)
                    {
                        launch_capture(app.clone(), action);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![capture::capture_screen])
        .setup(|app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let conflicts = shortcuts::register_capture_shortcuts(|definition| {
                app.global_shortcut()
                    .register(definition.shortcut())
                    .map_err(|error| error.to_string())
            });

            let mut menu_builder = MenuBuilder::new(app);
            for definition in shortcuts::definitions() {
                menu_builder = menu_builder.text(definition.menu_id, definition.menu_label);
            }

            let conflict_label = shortcuts::conflict_label(&conflicts);
            let conflict_item = conflict_label
                .as_ref()
                .map(|label| {
                    MenuItem::with_id(
                        app,
                        "shortcut-conflict",
                        label,
                        false,
                        None::<&str>,
                    )
                })
                .transpose()?;
            if let Some(item) = &conflict_item {
                menu_builder = menu_builder.separator().item(item);
            }

            let quit = MenuItem::with_id(app, "quit", "Quit Capso", true, Some("cmd+q"))?;
            let menu = menu_builder.separator().item(&quit).build()?;
            let tooltip = if conflicts.is_empty() {
                "Capso"
            } else {
                "Capso — shortcut conflict; Capture menu remains available"
            };

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip(tooltip)
                .menu(&menu)
                // Left click toggles the popover; the menu stays on right click.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if let Some(action) =
                        shortcuts::action_for_menu_id(event.id().as_ref())
                    {
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
