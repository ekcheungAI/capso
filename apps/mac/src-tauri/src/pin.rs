use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use uuid::Uuid;

pub(crate) const PIN_LABEL_PREFIX: &str = "pinned-capture-";
const MAX_ACTIVE_PINS: usize = 8;
const PIN_STORE_FILE: &str = "pinned-captures.json";
const PIN_STORE_VERSION: u8 = 1;
const MAX_PIN_STORE_BYTES: u64 = 64 * 1024;
const MIN_PIN_WIDTH: u32 = 180;
const MIN_PIN_HEIGHT: u32 = 120;
const MAX_PIN_WIDTH: u32 = 960;
const MAX_PIN_HEIGHT: u32 = 720;
const MIN_PIN_OPACITY: u8 = 40;
const DEFAULT_PIN_OPACITY: u8 = 100;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PinCapture {
    pin_id: String,
    path: String,
    presentation_id: u64,
    width: u32,
    height: u32,
    x: Option<i32>,
    y: Option<i32>,
    opacity: u8,
    locked: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPinState {
    version: u8,
    generation: u64,
    pins: Vec<PinCapture>,
}

impl Default for StoredPinState {
    fn default() -> Self {
        Self {
            version: PIN_STORE_VERSION,
            generation: 0,
            pins: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinCopyEvent {
    pin_id: String,
    presentation_id: u64,
    result: crate::clipboard::ClipboardStatus,
}

#[derive(Clone, Default)]
pub(crate) struct PinRuntime {
    pins: Vec<PinCapture>,
    generation: u64,
}

impl PinRuntime {
    fn add_with_id(
        &mut self,
        pin_id: String,
        path: PathBuf,
        size: LogicalSize<f64>,
    ) -> Result<PinCapture, String> {
        if self.pins.len() >= MAX_ACTIVE_PINS {
            return Err(format!(
                "Capso keeps at most {MAX_ACTIVE_PINS} pins visible. Close one before pinning another capture."
            ));
        }
        if canonical_pin_id(&pin_id).as_deref() != Some(pin_id.as_str())
            || self.pins.iter().any(|pin| pin.pin_id == pin_id)
        {
            return Err("The pinned capture identity is invalid or already active.".into());
        }
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| "The pinned capture identity counter is exhausted.".to_string())?;
        let capture = PinCapture {
            pin_id,
            path: path.to_string_lossy().into_owned(),
            presentation_id: self.generation,
            width: logical_dimension(size.width, MIN_PIN_WIDTH, MAX_PIN_WIDTH),
            height: logical_dimension(size.height, MIN_PIN_HEIGHT, MAX_PIN_HEIGHT),
            x: None,
            y: None,
            opacity: DEFAULT_PIN_OPACITY,
            locked: false,
        };
        self.pins.push(capture.clone());
        Ok(capture)
    }

    fn add(&mut self, path: PathBuf, size: LogicalSize<f64>) -> Result<PinCapture, String> {
        self.add_with_id(Uuid::new_v4().to_string(), path, size)
    }

    fn exact(&self, pin_id: &str, presentation_id: u64) -> Result<&PinCapture, String> {
        self.pins
            .iter()
            .find(|pin| pin.pin_id == pin_id && pin.presentation_id == presentation_id)
            .ok_or_else(|| "That pinned capture is no longer active.".to_string())
    }

    fn exact_mut(&mut self, pin_id: &str, presentation_id: u64) -> Result<&mut PinCapture, String> {
        self.pins
            .iter_mut()
            .find(|pin| pin.pin_id == pin_id && pin.presentation_id == presentation_id)
            .ok_or_else(|| "That pinned capture is no longer active.".to_string())
    }

    fn current_path(&self, pin_id: &str, presentation_id: u64) -> Result<PathBuf, String> {
        self.exact(pin_id, presentation_id)
            .map(|pin| PathBuf::from(&pin.path))
    }

    fn remove(&mut self, pin_id: &str, presentation_id: u64) -> Option<PinCapture> {
        let index = self
            .pins
            .iter()
            .position(|pin| pin.pin_id == pin_id && pin.presentation_id == presentation_id)?;
        Some(self.pins.remove(index))
    }

    fn stored(&self) -> StoredPinState {
        StoredPinState {
            version: PIN_STORE_VERSION,
            generation: self.generation,
            pins: self.pins.clone(),
        }
    }
}

fn logical_dimension(value: f64, minimum: u32, maximum: u32) -> u32 {
    if !value.is_finite() {
        return minimum;
    }
    value.round().clamp(f64::from(minimum), f64::from(maximum)) as u32
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PinDisplayBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

fn bounded_pin_position(
    requested: Option<(i32, i32)>,
    pin_size: (u32, u32),
    displays: &[PinDisplayBounds],
    cascade_index: usize,
) -> (i32, i32) {
    let Some(fallback) = displays.first().copied() else {
        return requested.unwrap_or((24, 24));
    };
    let display = requested
        .and_then(|(x, y)| {
            displays.iter().copied().find(|display| {
                let right = i64::from(display.x) + i64::from(display.width);
                let bottom = i64::from(display.y) + i64::from(display.height);
                i64::from(x) >= i64::from(display.x)
                    && i64::from(x) < right
                    && i64::from(y) >= i64::from(display.y)
                    && i64::from(y) < bottom
            })
        })
        .unwrap_or(fallback);
    let cascade = 24_u32.saturating_add(28_u32.saturating_mul(cascade_index as u32));
    let default_x = display
        .x
        .saturating_add((f64::from(cascade) * display.scale).round() as i32);
    let default_y = display
        .y
        .saturating_add((f64::from(cascade) * display.scale).round() as i32);
    let (requested_x, requested_y) = requested
        .filter(|(x, y)| {
            i64::from(*x) >= i64::from(display.x)
                && i64::from(*x) < i64::from(display.x) + i64::from(display.width)
                && i64::from(*y) >= i64::from(display.y)
                && i64::from(*y) < i64::from(display.y) + i64::from(display.height)
        })
        .unwrap_or((default_x, default_y));
    let physical_width = (f64::from(pin_size.0) * display.scale).round() as i64;
    let physical_height = (f64::from(pin_size.1) * display.scale).round() as i64;
    let maximum_x = (i64::from(display.x) + i64::from(display.width) - physical_width)
        .max(i64::from(display.x));
    let maximum_y = (i64::from(display.y) + i64::from(display.height) - physical_height)
        .max(i64::from(display.y));
    (
        i64::from(requested_x).clamp(i64::from(display.x), maximum_x) as i32,
        i64::from(requested_y).clamp(i64::from(display.y), maximum_y) as i32,
    )
}

fn ordered_pin_displays<R: Runtime>(app: &AppHandle<R>) -> Vec<PinDisplayBounds> {
    let mut monitors = app.available_monitors().unwrap_or_default();
    let cursor = app.cursor_position().ok();
    if let Some(index) = cursor.and_then(|cursor| {
        monitors.iter().position(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            cursor.x >= f64::from(position.x)
                && cursor.x < f64::from(position.x) + f64::from(size.width)
                && cursor.y >= f64::from(position.y)
                && cursor.y < f64::from(position.y) + f64::from(size.height)
        })
    }) {
        monitors.swap(0, index);
    } else if let Ok(Some(primary)) = app.primary_monitor() {
        if let Some(index) = monitors.iter().position(|monitor| {
            monitor.position() == primary.position() && monitor.size() == primary.size()
        }) {
            monitors.swap(0, index);
        }
    }
    monitors
        .iter()
        .map(|monitor| {
            let work_area = monitor.work_area();
            PinDisplayBounds {
                x: work_area.position.x,
                y: work_area.position.y,
                width: work_area.size.width,
                height: work_area.size.height,
                scale: monitor.scale_factor(),
            }
        })
        .collect()
}

fn keep_pin_reachable<R: Runtime>(
    app: &AppHandle<R>,
    capture: &mut PinCapture,
    cascade_index: usize,
) {
    let requested = capture.x.zip(capture.y);
    let (x, y) = bounded_pin_position(
        requested,
        (capture.width, capture.height),
        &ordered_pin_displays(app),
        cascade_index,
    );
    capture.x = Some(x);
    capture.y = Some(y);
}

fn canonical_pin_id(value: &str) -> Option<String> {
    let parsed = Uuid::parse_str(value).ok()?;
    let canonical = parsed.to_string();
    (canonical == value).then_some(canonical)
}

fn window_label(pin_id: &str) -> Result<String, String> {
    canonical_pin_id(pin_id)
        .map(|id| format!("{PIN_LABEL_PREFIX}{id}"))
        .ok_or_else(|| "The pinned capture window identity is invalid.".into())
}

pub(crate) fn is_pin_window_label(label: &str) -> bool {
    label
        .strip_prefix(PIN_LABEL_PREFIX)
        .and_then(canonical_pin_id)
        .is_some()
}

fn pin_id_from_window_label(label: &str) -> Option<String> {
    label
        .strip_prefix(PIN_LABEL_PREFIX)
        .and_then(canonical_pin_id)
}

fn validate_stored_state(state: StoredPinState) -> Result<StoredPinState, String> {
    if state.version != PIN_STORE_VERSION {
        return Err("Pinned capture settings use an unsupported version.".into());
    }
    if state.pins.len() > MAX_ACTIVE_PINS {
        return Err("Pinned capture settings exceed the safe pin limit.".into());
    }
    let mut ids = HashSet::new();
    let mut presentations = HashSet::new();
    for pin in &state.pins {
        if canonical_pin_id(&pin.pin_id).as_deref() != Some(pin.pin_id.as_str())
            || !ids.insert(pin.pin_id.as_str())
            || pin.path.is_empty()
            || pin.path.len() > 4_096
            || pin.presentation_id == 0
            || pin.presentation_id > state.generation
            || !presentations.insert(pin.presentation_id)
            || !(MIN_PIN_WIDTH..=MAX_PIN_WIDTH).contains(&pin.width)
            || !(MIN_PIN_HEIGHT..=MAX_PIN_HEIGHT).contains(&pin.height)
            || !(MIN_PIN_OPACITY..=DEFAULT_PIN_OPACITY).contains(&pin.opacity)
            || pin
                .x
                .is_some_and(|x| !(-1_000_000..=1_000_000).contains(&x))
            || pin
                .y
                .is_some_and(|y| !(-1_000_000..=1_000_000).contains(&y))
            || pin.x.is_some() != pin.y.is_some()
        {
            return Err("Pinned capture settings contain an unsafe record.".into());
        }
    }
    Ok(state)
}

fn load_pin_store(path: &Path) -> Result<StoredPinState, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredPinState::default())
        }
        Err(error) => return Err(format!("Could not inspect pinned captures: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_PIN_STORE_BYTES {
        return Err("Pinned capture settings are not a safe local file.".into());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read pinned captures: {error}"))?;
    let state = serde_json::from_slice::<StoredPinState>(&bytes)
        .map_err(|error| format!("Pinned capture settings are invalid: {error}"))?;
    validate_stored_state(state)
}

fn save_pin_store(path: &Path, state: &StoredPinState) -> Result<(), String> {
    let state = validate_stored_state(state.clone())?;
    let bytes = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("Could not encode pinned captures: {error}"))?;
    if bytes.len() as u64 > MAX_PIN_STORE_BYTES {
        return Err("Pinned capture settings exceed the safe local limit.".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Pinned capture settings have no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create pinned capture settings: {error}"))?;
    let temporary = parent.join(format!(".{PIN_STORE_FILE}.{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Could not create pinned capture settings: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write pinned capture settings: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not activate pinned capture settings: {error}"))?;
        OpenOptions::new()
            .read(true)
            .open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not finish pinned capture settings: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn pin_store_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(PIN_STORE_FILE))
        .map_err(|error| format!("Could not locate pinned capture settings: {error}"))
}

fn persist_runtime<R: Runtime>(app: &AppHandle<R>, runtime: &PinRuntime) -> Result<(), String> {
    save_pin_store(&pin_store_path(app)?, &runtime.stored())
}

fn pin_window_size(path: &Path) -> Result<LogicalSize<f64>, String> {
    let (width, height) = image::image_dimensions(path)
        .map_err(|error| format!("Could not inspect the capture for pinning: {error}"))?;
    let width = f64::from(width.max(1));
    let height = f64::from(height.max(1));
    let scale = (560.0 / width).min(420.0 / height).min(1.0);
    Ok(LogicalSize::new(
        (width * scale).max(f64::from(MIN_PIN_WIDTH)),
        (height * scale).max(f64::from(MIN_PIN_HEIGHT)),
    ))
}

fn create_pin_window<R: Runtime>(
    app: &AppHandle<R>,
    capture: &PinCapture,
) -> Result<tauri::WebviewWindow<R>, String> {
    let label = window_label(&capture.pin_id)?;
    if let Some(existing) = app.get_webview_window(&label) {
        return Ok(existing);
    }
    let url = format!("index.html?surface=pin&pinId={}", capture.pin_id);
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Pinned capture — Capso")
        .inner_size(f64::from(capture.width), f64::from(capture.height))
        .min_inner_size(f64::from(MIN_PIN_WIDTH), f64::from(MIN_PIN_HEIGHT))
        .max_inner_size(f64::from(MAX_PIN_WIDTH), f64::from(MAX_PIN_HEIGHT))
        .visible(false)
        .focused(false)
        .focusable(true)
        .resizable(!capture.locked)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(true)
        .accept_first_mouse(true)
        .build()
        .map_err(|error| format!("Could not create the pinned capture window: {error}"))?;
    if let (Some(x), Some(y)) = (capture.x, capture.y) {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| format!("Could not restore the pinned capture position: {error}"))?;
    }
    Ok(window)
}

fn capture_is_restorable<R: Runtime>(app: &AppHandle<R>, capture: &PinCapture) -> bool {
    let path = Path::new(&capture.path);
    let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    crate::history::resolve_recent_capture(
        &match crate::history::capture_directory(app) {
            Ok(directory) => directory,
            Err(_) => return false,
        },
        id,
    )
    .is_ok_and(|resolved| resolved.path == path)
}

pub(crate) fn restore_pinned_captures<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let stored = load_pin_store(&pin_store_path(app)?)?;
    let original_len = stored.pins.len();
    let mut pins = stored
        .pins
        .into_iter()
        .filter(|pin| capture_is_restorable(app, pin))
        .collect::<Vec<_>>();
    let original_positions = pins.iter().map(|pin| (pin.x, pin.y)).collect::<Vec<_>>();
    for (index, pin) in pins.iter_mut().enumerate() {
        keep_pin_reachable(app, pin, index);
    }
    let positions_changed = pins
        .iter()
        .zip(&original_positions)
        .any(|(pin, position)| (pin.x, pin.y) != *position);
    let runtime = PinRuntime {
        pins: pins.clone(),
        generation: stored.generation,
    };
    if pins.len() != original_len || positions_changed {
        persist_runtime(app, &runtime)?;
    }
    *app.state::<Mutex<PinRuntime>>()
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())? = runtime;
    for pin in pins {
        if let Err(error) = create_pin_window(app, &pin) {
            eprintln!("Could not restore pin {}: {error}", pin.pin_id);
        }
    }
    Ok(())
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
    let (capture, previous) = {
        let mut runtime = pin_state
            .lock()
            .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?;
        let previous = runtime.clone();
        let mut capture = runtime.add(source, size)?;
        let cascade_index = runtime.pins.len().saturating_sub(1);
        keep_pin_reachable(&app, &mut capture, cascade_index);
        if let Some(stored) = runtime.pins.last_mut() {
            *stored = capture.clone();
        }
        if let Err(error) = persist_runtime(&app, &runtime) {
            *runtime = previous;
            return Err(error);
        }
        (capture, previous)
    };
    let window_label = window_label(&capture.pin_id)?;
    if let Err(error) = create_pin_window(&app, &capture) {
        if let Ok(mut runtime) = pin_state.lock() {
            *runtime = previous;
            let _ = persist_runtime(&app, &runtime);
        }
        return Err(error);
    }
    if let Err(error) = app.emit_to(&window_label, "pin-capture", capture.clone()) {
        if let Some(window) = app.get_webview_window(&window_label) {
            let _ = window.destroy();
        }
        if let Ok(mut runtime) = pin_state.lock() {
            *runtime = previous;
            let _ = persist_runtime(&app, &runtime);
        }
        return Err(format!("Could not present the pinned capture: {error}"));
    }
    Ok(capture)
}

#[tauri::command]
pub(crate) fn get_pin_capture(
    state: State<'_, Mutex<PinRuntime>>,
    pin_id: String,
) -> Result<Option<PinCapture>, String> {
    state
        .lock()
        .map(|runtime| {
            runtime
                .pins
                .iter()
                .find(|pin| pin.pin_id == pin_id)
                .cloned()
        })
        .map_err(|_| "The pinned capture state is temporarily unavailable.".into())
}

#[tauri::command]
pub(crate) fn pin_image_ready(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    pin_id: String,
    presentation_id: u64,
) -> Result<bool, String> {
    state
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?
        .exact(&pin_id, presentation_id)?;
    app.get_webview_window(&window_label(&pin_id)?)
        .ok_or_else(|| "The pinned capture window is unavailable.".to_string())?
        .show()
        .map_err(|error| format!("Could not show the pinned capture: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn copy_pin_capture(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    pin_id: String,
    presentation_id: u64,
) -> Result<bool, String> {
    let source = state
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?
        .current_path(&pin_id, presentation_id)?;
    let event_app = app.clone();
    let event_pin_id = pin_id.clone();
    let label = window_label(&pin_id)?;
    crate::clipboard::schedule_recopy_current_capture_to_general_pasteboard(
        app,
        source,
        move |result| {
            let _ = event_app.emit_to(
                &label,
                "pin-copy-finished",
                PinCopyEvent {
                    pin_id: event_pin_id,
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

fn resize_dimensions(width: u32, height: u32, direction: i8) -> Result<(u32, u32), String> {
    let requested: f64 = match direction {
        -1 => 0.85,
        1 => 1.15,
        _ => return Err("Pinned capture resize direction is invalid.".into()),
    };
    let minimum_scale = (f64::from(MIN_PIN_WIDTH) / f64::from(width))
        .max(f64::from(MIN_PIN_HEIGHT) / f64::from(height));
    let maximum_scale = (f64::from(MAX_PIN_WIDTH) / f64::from(width))
        .min(f64::from(MAX_PIN_HEIGHT) / f64::from(height));
    let scale = requested.clamp(minimum_scale.min(1.0), maximum_scale.max(1.0));
    Ok((
        logical_dimension(f64::from(width) * scale, MIN_PIN_WIDTH, MAX_PIN_WIDTH),
        logical_dimension(f64::from(height) * scale, MIN_PIN_HEIGHT, MAX_PIN_HEIGHT),
    ))
}

fn update_pin_with_rollback<R: Runtime, F>(
    app: &AppHandle<R>,
    state: &Mutex<PinRuntime>,
    pin_id: &str,
    presentation_id: u64,
    update: F,
) -> Result<(PinCapture, PinRuntime), String>
where
    F: FnOnce(&mut PinCapture) -> Result<(), String>,
{
    let mut runtime = state
        .lock()
        .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?;
    let previous = runtime.clone();
    update(runtime.exact_mut(pin_id, presentation_id)?)?;
    if let Err(error) = persist_runtime(app, &runtime) {
        *runtime = previous.clone();
        return Err(error);
    }
    Ok((runtime.exact(pin_id, presentation_id)?.clone(), previous))
}

fn rollback_pin<R: Runtime>(app: &AppHandle<R>, state: &Mutex<PinRuntime>, previous: PinRuntime) {
    if let Ok(mut runtime) = state.lock() {
        *runtime = previous;
        let _ = persist_runtime(app, &runtime);
    }
}

#[tauri::command]
pub(crate) fn resize_pin_capture(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    pin_id: String,
    presentation_id: u64,
    direction: i8,
) -> Result<PinCapture, String> {
    let (capture, previous) =
        update_pin_with_rollback(&app, state.inner(), &pin_id, presentation_id, |pin| {
            let (width, height) = resize_dimensions(pin.width, pin.height, direction)?;
            pin.width = width;
            pin.height = height;
            Ok(())
        })?;
    let window = app
        .get_webview_window(&window_label(&pin_id)?)
        .ok_or_else(|| "The pinned capture window is unavailable.".to_string())?;
    if let Err(error) = window.set_size(LogicalSize::new(
        f64::from(capture.width),
        f64::from(capture.height),
    )) {
        rollback_pin(&app, state.inner(), previous);
        return Err(format!("Could not resize the pinned capture: {error}"));
    }
    Ok(capture)
}

#[tauri::command]
pub(crate) fn set_pin_opacity(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    pin_id: String,
    presentation_id: u64,
    opacity: u8,
) -> Result<PinCapture, String> {
    if !(MIN_PIN_OPACITY..=DEFAULT_PIN_OPACITY).contains(&opacity) {
        return Err(format!(
            "Pinned capture opacity must stay between {MIN_PIN_OPACITY}% and {DEFAULT_PIN_OPACITY}%."
        ));
    }
    update_pin_with_rollback(&app, state.inner(), &pin_id, presentation_id, |pin| {
        pin.opacity = opacity;
        Ok(())
    })
    .map(|(capture, _)| capture)
}

#[tauri::command]
pub(crate) fn set_pin_locked(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    pin_id: String,
    presentation_id: u64,
    locked: bool,
) -> Result<PinCapture, String> {
    let (capture, previous) =
        update_pin_with_rollback(&app, state.inner(), &pin_id, presentation_id, |pin| {
            pin.locked = locked;
            Ok(())
        })?;
    let window = app
        .get_webview_window(&window_label(&pin_id)?)
        .ok_or_else(|| "The pinned capture window is unavailable.".to_string())?;
    if let Err(error) = window.set_resizable(!locked) {
        rollback_pin(&app, state.inner(), previous);
        return Err(format!("Could not update the pinned capture lock: {error}"));
    }
    Ok(capture)
}

fn close_exact_pin<R: Runtime>(
    app: &AppHandle<R>,
    state: &Mutex<PinRuntime>,
    pin_id: &str,
    presentation_id: u64,
) -> Result<bool, String> {
    let label = window_label(pin_id)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "The pinned capture window is unavailable.".to_string())?;
    window
        .hide()
        .map_err(|error| format!("Could not hide the pinned capture: {error}"))?;
    let previous = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The pinned capture state is temporarily unavailable.".to_string())?;
        let previous = runtime.clone();
        if runtime.remove(pin_id, presentation_id).is_none() {
            let _ = window.show();
            return Ok(false);
        }
        if let Err(error) = persist_runtime(app, &runtime) {
            *runtime = previous;
            let _ = window.show();
            return Err(error);
        }
        previous
    };
    if let Err(error) = window.destroy() {
        rollback_pin(app, state, previous);
        let _ = window.show();
        return Err(format!("Could not close the pinned capture: {error}"));
    }
    Ok(true)
}

#[tauri::command]
pub(crate) fn close_pin_capture(
    app: AppHandle,
    state: State<'_, Mutex<PinRuntime>>,
    pin_id: String,
    presentation_id: u64,
) -> Result<bool, String> {
    close_exact_pin(&app, state.inner(), &pin_id, presentation_id)
}

pub(crate) fn close_from_window_request<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(pin_id) = pin_id_from_window_label(label) else {
        return;
    };
    let state = app.state::<Mutex<PinRuntime>>();
    let presentation_id = state.lock().ok().and_then(|runtime| {
        runtime
            .pins
            .iter()
            .find(|pin| pin.pin_id == pin_id)
            .map(|pin| pin.presentation_id)
    });
    if let Some(presentation_id) = presentation_id {
        let _ = close_exact_pin(app, state.inner(), &pin_id, presentation_id);
    }
}

pub(crate) fn record_window_geometry<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    event: &WindowEvent,
) {
    let Some(pin_id) = pin_id_from_window_label(label) else {
        return;
    };
    let state = app.state::<Mutex<PinRuntime>>();
    let Ok(mut runtime) = state.lock() else {
        return;
    };
    let Some(pin) = runtime.pins.iter_mut().find(|pin| pin.pin_id == pin_id) else {
        return;
    };
    match event {
        WindowEvent::Moved(position) => {
            pin.x = Some(position.x);
            pin.y = Some(position.y);
        }
        WindowEvent::Resized(size) => {
            let scale = app
                .get_webview_window(label)
                .and_then(|window| window.scale_factor().ok())
                .unwrap_or(1.0);
            pin.width =
                logical_dimension(f64::from(size.width) / scale, MIN_PIN_WIDTH, MAX_PIN_WIDTH);
            pin.height = logical_dimension(
                f64::from(size.height) / scale,
                MIN_PIN_HEIGHT,
                MAX_PIN_HEIGHT,
            );
        }
        WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => {
            pin.width = logical_dimension(
                f64::from(new_inner_size.width) / scale_factor,
                MIN_PIN_WIDTH,
                MAX_PIN_WIDTH,
            );
            pin.height = logical_dimension(
                f64::from(new_inner_size.height) / scale_factor,
                MIN_PIN_HEIGHT,
                MAX_PIN_HEIGHT,
            );
        }
        _ => return,
    }
    let _ = persist_runtime(app, &runtime);
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_pin_position, load_pin_store, resize_dimensions, save_pin_store, LogicalSize,
        PinDisplayBounds, PinRuntime, StoredPinState, MAX_ACTIVE_PINS, MAX_PIN_HEIGHT,
        MAX_PIN_WIDTH, MIN_PIN_HEIGHT, MIN_PIN_WIDTH,
    };
    use std::{fs, path::PathBuf};
    use tempfile::tempdir;

    fn id(value: u128) -> String {
        uuid::Uuid::from_u128(value).to_string()
    }

    #[test]
    fn multiple_pins_keep_independent_exact_actions_and_enforce_the_bound() {
        let mut runtime = PinRuntime::default();
        let first = runtime
            .add_with_id(
                id(1),
                PathBuf::from("/captures/first.png"),
                LogicalSize::new(420.0, 300.0),
            )
            .expect("first pin");
        let second = runtime
            .add_with_id(
                id(2),
                PathBuf::from("/captures/second.png"),
                LogicalSize::new(320.0, 220.0),
            )
            .expect("second pin");

        assert_ne!(first.pin_id, second.pin_id);
        assert_eq!(
            runtime
                .current_path(&first.pin_id, first.presentation_id)
                .unwrap(),
            PathBuf::from("/captures/first.png")
        );
        assert!(runtime
            .current_path(&first.pin_id, second.presentation_id)
            .is_err());
        assert!(runtime
            .remove(&first.pin_id, second.presentation_id)
            .is_none());
        assert_eq!(runtime.pins.len(), 2);

        for value in 3..=MAX_ACTIVE_PINS as u128 {
            runtime
                .add_with_id(
                    id(value),
                    PathBuf::from(format!("/captures/{value}.png")),
                    LogicalSize::new(300.0, 200.0),
                )
                .expect("bounded pin");
        }
        assert!(runtime
            .add_with_id(
                id(99),
                PathBuf::from("/captures/overflow.png"),
                LogicalSize::new(300.0, 200.0),
            )
            .is_err());
    }

    #[test]
    fn resize_preserves_ratio_until_it_reaches_safe_native_bounds() {
        let mut dimensions = (400, 200);
        dimensions = resize_dimensions(dimensions.0, dimensions.1, 1).expect("grow");
        assert_eq!(dimensions, (460, 230));
        for _ in 0..20 {
            dimensions = resize_dimensions(dimensions.0, dimensions.1, 1).expect("bounded grow");
        }
        assert!(dimensions.0 <= MAX_PIN_WIDTH && dimensions.1 <= MAX_PIN_HEIGHT);
        for _ in 0..40 {
            dimensions = resize_dimensions(dimensions.0, dimensions.1, -1).expect("bounded shrink");
        }
        assert!(dimensions.0 >= MIN_PIN_WIDTH && dimensions.1 >= MIN_PIN_HEIGHT);
        assert!(resize_dimensions(400, 200, 0).is_err());
    }

    #[test]
    fn pin_store_round_trips_atomically_and_corruption_is_preserved() {
        let directory = tempdir().expect("temporary store");
        let path = directory.path().join("pinned-captures.json");
        let mut runtime = PinRuntime::default();
        runtime
            .add_with_id(
                id(1),
                PathBuf::from("/captures/first.png"),
                LogicalSize::new(420.0, 300.0),
            )
            .expect("pin");
        runtime.pins[0].opacity = 65;
        runtime.pins[0].locked = true;
        runtime.pins[0].x = Some(-240);
        runtime.pins[0].y = Some(80);
        save_pin_store(&path, &runtime.stored()).expect("atomic store");
        assert_eq!(load_pin_store(&path).unwrap(), runtime.stored());
        assert_eq!(
            fs::read_dir(directory.path()).unwrap().count(),
            1,
            "atomic persistence must clean its temporary file"
        );

        fs::write(&path, b"not json").expect("corrupt store");
        assert!(load_pin_store(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"not json");
    }

    #[test]
    fn unsafe_persisted_pin_state_fails_closed() {
        let directory = tempdir().expect("temporary store");
        let path = directory.path().join("pinned-captures.json");
        let unsafe_state = StoredPinState {
            version: 1,
            generation: 1,
            pins: vec![super::PinCapture {
                pin_id: id(1),
                path: "/captures/first.png".into(),
                presentation_id: 1,
                width: 420,
                height: 300,
                x: None,
                y: None,
                opacity: 0,
                locked: false,
            }],
        };
        assert!(save_pin_store(&path, &unsafe_state).is_err());
    }

    #[test]
    fn new_and_restored_pins_remain_reachable_across_negative_and_changed_displays() {
        let displays = [
            PinDisplayBounds {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.0,
            },
            PinDisplayBounds {
                x: 0,
                y: 0,
                width: 3024,
                height: 1964,
                scale: 2.0,
            },
        ];
        assert_eq!(
            bounded_pin_position(None, (420, 300), &displays, 0),
            (-1896, 24)
        );
        assert_eq!(
            bounded_pin_position(Some((-1800, 900)), (420, 300), &displays, 0),
            (-1800, 780),
            "a restored negative-origin pin is clamped fully inside its display"
        );
        assert_eq!(
            bounded_pin_position(Some((9000, 9000)), (420, 300), &displays, 2),
            (-1840, 80),
            "a disconnected-display pin falls back to a visible cascade"
        );
    }
}
