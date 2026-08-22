use crate::{capture::CaptureMode, clipboard::ClipboardStatus};
use image::{codecs::jpeg::JpegEncoder, ImageReader, Limits};
#[cfg(target_os = "macos")]
use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType, CGMouseButton};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::{mpsc, Arc};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, State, WebviewWindow,
};

pub(crate) const OVERLAY_LABEL: &str = "capture-overlay";
pub(crate) const SHOW_HIDDEN_OVERLAY_MENU_ID: &str = "show-hidden-overlay";
pub(crate) const OVERLAY_WIDTH_LOGICAL: f64 = 304.0;
pub(crate) const OVERLAY_HEIGHT_LOGICAL: f64 = 194.0;
const OVERLAY_MARGIN_LOGICAL: f64 = 20.0;
const OVERLAY_SETTINGS_VERSION: u8 = 1;
const MAX_OVERLAY_DISPLAY_PROFILES: usize = 16;
const MAX_OVERLAY_SETTINGS_BYTES: u64 = 64 * 1024;
const OVERLAY_SETTINGS_FILE: &str = "overlay-settings.json";
const MAX_SAVE_AS_EDGE: u32 = 32_768;
const MAX_SAVE_AS_PIXELS: u64 = 100_000_000;
const MAX_SAVE_AS_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const JPEG_SAVE_AS_QUALITY: u8 = 92;
const OVERLAY_AUTO_DISMISS_DURATION: Duration = Duration::from_secs(10);
const OVERLAY_AUTO_DISMISS_RETRY_DELAY: Duration = Duration::from_secs(1);
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const JPEG_SIGNATURE: &[u8; 3] = b"\xff\xd8\xff";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OverlayPlacement {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OverlaySize {
    Compact,
    Regular,
    Large,
}

impl OverlaySize {
    fn logical_dimensions(self) -> (f64, f64) {
        match self {
            Self::Compact => (OVERLAY_WIDTH_LOGICAL, OVERLAY_HEIGHT_LOGICAL),
            Self::Regular => (384.0, 244.0),
            Self::Large => (464.0, 294.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OverlayAutoDismiss {
    EightSeconds,
    FifteenSeconds,
    TenSeconds,
    Never,
}

impl OverlayAutoDismiss {
    fn milliseconds(self) -> Option<u64> {
        match self {
            Self::EightSeconds | Self::FifteenSeconds | Self::TenSeconds => Some(10_000),
            Self::Never => Some(10_000),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OverlayQuickActions {
    pub(crate) pin: bool,
    pub(crate) annotate: bool,
    pub(crate) copy: bool,
    pub(crate) save: bool,
}

impl Default for OverlayQuickActions {
    fn default() -> Self {
        Self {
            pin: true,
            annotate: true,
            copy: true,
            save: true,
        }
    }
}

impl OverlayQuickActions {
    fn any(self) -> bool {
        self.pin || self.annotate || self.copy || self.save
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OverlayPreferences {
    pub(crate) placement: OverlayPlacement,
    pub(crate) size: OverlaySize,
    pub(crate) auto_dismiss: OverlayAutoDismiss,
    #[serde(default)]
    pub(crate) quick_actions: OverlayQuickActions,
}

impl Default for OverlayPreferences {
    fn default() -> Self {
        Self {
            placement: OverlayPlacement::BottomRight,
            size: OverlaySize::Compact,
            auto_dismiss: OverlayAutoDismiss::TenSeconds,
            quick_actions: OverlayQuickActions::default(),
        }
    }
}

impl OverlayPreferences {
    fn physical_dimensions(self, display: DisplayGeometry) -> (u32, u32) {
        let (width, height) = self.size.logical_dimensions();
        let scale_factor = if display.scale_factor.is_finite() && display.scale_factor > 0.0 {
            display.scale_factor
        } else {
            1.0
        };
        let desired_width = width * scale_factor;
        let desired_height = height * scale_factor;
        let margin = (OVERLAY_MARGIN_LOGICAL * scale_factor)
            .round()
            .clamp(0.0, f64::from(u32::MAX / 2)) as u32;
        let available_width = display
            .work_area
            .width
            .saturating_sub(
                margin
                    .saturating_mul(2)
                    .min(display.work_area.width.saturating_sub(1)),
            )
            .max(1);
        let available_height = display
            .work_area
            .height
            .saturating_sub(
                margin
                    .saturating_mul(2)
                    .min(display.work_area.height.saturating_sub(1)),
            )
            .max(1);
        let fit = (f64::from(available_width) / desired_width)
            .min(f64::from(available_height) / desired_height)
            .min(1.0);
        (
            (desired_width * fit)
                .round()
                .clamp(1.0, f64::from(available_width)) as u32,
            (desired_height * fit)
                .round()
                .clamp(1.0, f64::from(available_height)) as u32,
        )
    }

    fn position(self, display: DisplayGeometry) -> (i32, i32) {
        let (width, height) = self.physical_dimensions(display);
        let scale_factor = if display.scale_factor.is_finite() && display.scale_factor > 0.0 {
            display.scale_factor
        } else {
            1.0
        };
        let desired_margin = (OVERLAY_MARGIN_LOGICAL * scale_factor).round() as i64;
        let margin_x =
            desired_margin.min(i64::from(display.work_area.width.saturating_sub(width)) / 2);
        let margin_y =
            desired_margin.min(i64::from(display.work_area.height.saturating_sub(height)) / 2);
        let left = i64::from(display.work_area.x) + margin_x;
        let top = i64::from(display.work_area.y) + margin_y;
        let right = i64::from(display.work_area.x) + i64::from(display.work_area.width)
            - i64::from(width)
            - margin_x;
        let bottom = i64::from(display.work_area.y) + i64::from(display.work_area.height)
            - i64::from(height)
            - margin_y;
        let (x, y) = match self.placement {
            OverlayPlacement::TopLeft => (left, top),
            OverlayPlacement::TopRight => (right, top),
            OverlayPlacement::BottomLeft => (left, bottom),
            OverlayPlacement::BottomRight => (right, bottom),
        };
        (
            x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
            y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OverlaySaveAsPreferences {
    pub(crate) format: CaptureExportFormat,
    pub(crate) filename_template: String,
    #[serde(default)]
    pub(crate) directory: String,
}

impl Default for OverlaySaveAsPreferences {
    fn default() -> Self {
        Self {
            format: CaptureExportFormat::Png,
            filename_template: "Capso {date} at {time}".into(),
            directory: String::new(),
        }
    }
}

fn validate_save_as_preferences(preferences: &OverlaySaveAsPreferences) -> Result<(), String> {
    let template = preferences.filename_template.trim();
    if template.is_empty()
        || template.len() > 96
        || template.starts_with('.')
        || template
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err(
            "Save As names must be 1–96 safe characters and cannot start with a dot.".into(),
        );
    }
    let remainder = template.replace("{date}", "").replace("{time}", "");
    if remainder.contains('{') || remainder.contains('}') {
        return Err("Save As names support only the {date} and {time} tokens.".into());
    }
    if !preferences.directory.is_empty() {
        let directory = Path::new(&preferences.directory);
        if !directory.is_absolute() {
            return Err("The Save folder must be an absolute local folder.".into());
        }
        let metadata = fs::symlink_metadata(directory)
            .map_err(|error| format!("Could not use the selected Save folder: {error}"))?;
        if !metadata.file_type().is_dir() {
            return Err("The Save folder must be a direct local folder.".into());
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredOverlaySettings {
    pub(crate) version: u8,
    #[serde(default)]
    pub(crate) save_as: OverlaySaveAsPreferences,
    #[serde(default)]
    pub(crate) profiles: BTreeMap<String, OverlayPreferences>,
}

impl Default for StoredOverlaySettings {
    fn default() -> Self {
        Self {
            version: OVERLAY_SETTINGS_VERSION,
            save_as: OverlaySaveAsPreferences::default(),
            profiles: BTreeMap::new(),
        }
    }
}

fn settings_for_display(stored: &StoredOverlaySettings, display_id: &str) -> OverlayPreferences {
    stored.profiles.get(display_id).copied().unwrap_or_default()
}

fn update_stored_preferences(
    stored: &mut StoredOverlaySettings,
    display_id: &str,
    mut preferences: OverlayPreferences,
) -> Result<(), String> {
    if display_id.is_empty() || display_id.len() > 256 || display_id.chars().any(char::is_control) {
        return Err("The Quick Access display identifier is invalid.".into());
    }
    if !stored.profiles.contains_key(display_id)
        && stored.profiles.len() >= MAX_OVERLAY_DISPLAY_PROFILES
    {
        return Err("Quick Access settings already contain too many display profiles.".into());
    }
    if !preferences.quick_actions.any() {
        return Err("Keep at least one Quick Access action visible.".into());
    }
    preferences.auto_dismiss = OverlayAutoDismiss::TenSeconds;
    stored.profiles.insert(display_id.into(), preferences);
    Ok(())
}

fn load_stored_overlay_settings(path: &Path) -> Result<StoredOverlaySettings, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(StoredOverlaySettings::default())
        }
        Err(error) => return Err(format!("Could not inspect Quick Access settings: {error}")),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_OVERLAY_SETTINGS_BYTES {
        return Err("Quick Access settings are not a safe bounded file.".into());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read Quick Access settings: {error}"))?;
    let mut stored: StoredOverlaySettings = serde_json::from_slice(&bytes).map_err(|_| {
        "Quick Access settings are damaged. The existing file was preserved.".to_string()
    })?;
    for preferences in stored.profiles.values_mut() {
        if matches!(
            preferences.auto_dismiss,
            OverlayAutoDismiss::EightSeconds
                | OverlayAutoDismiss::FifteenSeconds
                | OverlayAutoDismiss::Never
        ) {
            preferences.auto_dismiss = OverlayAutoDismiss::TenSeconds;
        }
    }
    validate_stored_overlay_settings(&stored)?;
    Ok(stored)
}

pub(crate) fn validate_stored_overlay_settings(
    stored: &StoredOverlaySettings,
) -> Result<(), String> {
    if stored.version != OVERLAY_SETTINGS_VERSION
        || stored.profiles.len() > MAX_OVERLAY_DISPLAY_PROFILES
    {
        return Err("Quick Access settings use an unsupported format.".into());
    }
    validate_save_as_preferences(&stored.save_as)?;
    for (id, preferences) in &stored.profiles {
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
            return Err("Quick Access settings contain an invalid display profile.".into());
        }
        if !preferences.quick_actions.any() {
            return Err("Quick Access settings must keep at least one action visible.".into());
        }
    }
    Ok(())
}

fn save_stored_overlay_settings(path: &Path, stored: &StoredOverlaySettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not locate the Quick Access settings folder.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the Quick Access settings folder: {error}"))?;
    let bytes = serde_json::to_vec(stored)
        .map_err(|error| format!("Could not encode Quick Access settings: {error}"))?;
    if bytes.len() as u64 > MAX_OVERLAY_SETTINGS_BYTES {
        return Err("Quick Access settings exceed the safe file limit.".into());
    }
    let temporary = parent.join(format!(".overlay-settings-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!("Could not create temporary Quick Access settings: {error}")
            })?;
        file.write_all(&bytes)
            .map_err(|error| format!("Could not write Quick Access settings: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync Quick Access settings: {error}"))?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not activate Quick Access settings: {error}"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync the Quick Access settings folder: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

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

#[derive(Clone, Debug, PartialEq)]
struct DisplayTarget {
    id: String,
    name: String,
    geometry: DisplayGeometry,
    is_primary: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayDisplaySettings {
    id: String,
    name: String,
    is_primary: bool,
    preferences: OverlayPreferences,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlaySettingsSnapshot {
    displays: Vec<OverlayDisplaySettings>,
    selected_display_id: String,
    save_as: OverlaySaveAsPreferences,
    storage_warning: Option<String>,
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

fn safe_display_name(name: Option<&str>, index: usize) -> String {
    let cleaned = name
        .unwrap_or("")
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect::<String>();
    if cleaned.trim().is_empty() {
        format!("Display {}", index + 1)
    } else {
        cleaned
    }
}

fn display_profile_base_id(name: &str, geometry: DisplayGeometry) -> String {
    format!(
        "{}:{}:{}:{}",
        name,
        geometry.bounds.width,
        geometry.bounds.height,
        (geometry.scale_factor * 1_000.0).round() as u32,
    )
}

fn display_profile_ids(displays: &[(String, DisplayGeometry)]) -> Vec<String> {
    let mut counts = BTreeMap::new();
    for (name, geometry) in displays {
        *counts
            .entry(display_profile_base_id(name, *geometry))
            .or_insert(0_usize) += 1;
    }
    displays
        .iter()
        .map(|(name, geometry)| {
            let base = display_profile_base_id(name, *geometry);
            if counts.get(&base).copied().unwrap_or_default() > 1 {
                format!("{}:at:{}:{}", base, geometry.bounds.x, geometry.bounds.y)
            } else {
                base
            }
        })
        .collect()
}

fn available_display_targets(app: &AppHandle) -> Result<Vec<DisplayTarget>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("Could not inspect the connected displays: {error}"))?;
    let primary = app
        .primary_monitor()
        .map_err(|error| format!("Could not inspect the primary display: {error}"))?
        .as_ref()
        .map(DisplayGeometry::from);
    let named_displays = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let geometry = DisplayGeometry::from(monitor);
            let name = safe_display_name(monitor.name().map(String::as_str), index);
            (name, geometry)
        })
        .collect::<Vec<_>>();
    let ids = display_profile_ids(&named_displays);
    Ok(named_displays
        .into_iter()
        .zip(ids)
        .map(|((name, geometry), id)| DisplayTarget {
            id,
            name,
            geometry,
            is_primary: primary == Some(geometry),
        })
        .collect())
}

pub(crate) fn overlay_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(OVERLAY_SETTINGS_FILE))
        .map_err(|error| format!("Could not locate Quick Access settings: {error}"))
}

pub(crate) fn stored_overlay_settings(app: &AppHandle) -> Result<StoredOverlaySettings, String> {
    load_stored_overlay_settings(&overlay_settings_path(app)?)
}

fn selected_display_id(app: &AppHandle, displays: &[DisplayTarget]) -> Option<String> {
    let cursor_display = app.cursor_position().ok().and_then(|cursor| {
        displays.iter().find(|display| {
            display_at_cursor(
                &[display.geometry],
                ScreenPoint {
                    x: cursor.x,
                    y: cursor.y,
                },
            )
            .is_some()
        })
    });
    cursor_display
        .or_else(|| displays.iter().find(|display| display.is_primary))
        .or_else(|| displays.first())
        .map(|display| display.id.clone())
}

fn overlay_settings_snapshot(
    app: &AppHandle,
    selected_override: Option<&str>,
) -> Result<OverlaySettingsSnapshot, String> {
    let displays = available_display_targets(app)?;
    let path = overlay_settings_path(app)?;
    let (stored, storage_warning) = match load_stored_overlay_settings(&path) {
        Ok(stored) => (stored, None),
        Err(error) => (StoredOverlaySettings::default(), Some(error)),
    };
    let selected = selected_override
        .and_then(|id| displays.iter().find(|display| display.id == id))
        .map(|display| display.id.clone())
        .or_else(|| selected_display_id(app, &displays))
        .ok_or_else(|| "Could not find a display for Quick Access settings.".to_string())?;
    Ok(OverlaySettingsSnapshot {
        save_as: stored.save_as.clone(),
        displays: displays
            .into_iter()
            .map(|display| OverlayDisplaySettings {
                preferences: settings_for_display(&stored, &display.id),
                id: display.id,
                name: display.name,
                is_primary: display.is_primary,
            })
            .collect(),
        selected_display_id: selected,
        storage_warning,
    })
}

pub(crate) fn get_overlay_settings(app: &AppHandle) -> Result<OverlaySettingsSnapshot, String> {
    overlay_settings_snapshot(app, None)
}

pub(crate) fn get_save_as_preferences(app: &AppHandle) -> Result<OverlaySaveAsPreferences, String> {
    stored_overlay_settings(app).map(|stored| stored.save_as)
}

pub(crate) fn default_save_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .picture_dir()
        .map(|directory| directory.join("Capso"))
        .map_err(|error| format!("Could not locate the Pictures folder: {error}"))
}

pub(crate) fn update_overlay_settings(
    app: &AppHandle,
    display_id: &str,
    preferences: OverlayPreferences,
    save_as: OverlaySaveAsPreferences,
) -> Result<OverlaySettingsSnapshot, String> {
    let displays = available_display_targets(app)?;
    if !displays.iter().any(|display| display.id == display_id) {
        return Err("That display is no longer connected.".into());
    }
    let path = overlay_settings_path(app)?;
    let mut stored = load_stored_overlay_settings(&path)?;
    validate_save_as_preferences(&save_as)?;
    update_stored_preferences(&mut stored, display_id, preferences)?;
    stored.save_as = save_as;
    save_stored_overlay_settings(&path, &stored)?;
    overlay_settings_snapshot(app, Some(display_id))
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayCapture {
    path: String,
    presentation_id: u64,
    clipboard: ClipboardStatus,
    source: OverlaySource,
    auto_dismiss_ms: Option<u64>,
    quick_actions: OverlayQuickActions,
    temporarily_hidden: bool,
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
    auto_dismiss_generation: u64,
    auto_dismiss_clock: Option<OverlayAutoDismissClock>,
    active_drag: Option<OverlayDragIdentity>,
    pending_latency: Option<PendingOverlayLatency>,
    temporarily_hidden: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OverlayPresentationIdentity {
    path: String,
    presentation_id: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OverlayAutoDismissSchedule {
    identity: OverlayPresentationIdentity,
    generation: u64,
    after: Duration,
    deadline: Instant,
}

#[derive(Clone, Debug)]
struct OverlayAutoDismissClock {
    identity: OverlayPresentationIdentity,
    generation: u64,
    remaining: Duration,
    deadline: Option<Instant>,
    pause_reasons: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OverlayAutoDismissPauseReason {
    Renderer,
    TemporarilyHidden,
    ActiveDrag,
}

impl OverlayAutoDismissPauseReason {
    fn bit(self) -> u8 {
        match self {
            Self::Renderer => 1 << 0,
            Self::TemporarilyHidden => 1 << 1,
            Self::ActiveDrag => 1 << 2,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum OverlayAutoDismissUpdate {
    Stale,
    Unarmed,
    Unchanged,
    Paused,
    Resumed(OverlayAutoDismissSchedule),
}

pub(crate) struct CaptureOverlayLease {
    app: AppHandle,
    hidden: Option<OverlayPresentationIdentity>,
}

impl CaptureOverlayLease {
    pub(crate) fn begin(app: AppHandle) -> Result<Self, String> {
        let hidden = hide_current_overlay_for_capture(&app)?;
        Ok(Self { app, hidden })
    }
}

impl Drop for CaptureOverlayLease {
    fn drop(&mut self) {
        if let Some(hidden) = self.hidden.as_ref() {
            if let Err(error) = restore_temporarily_hidden_overlay_if_current(
                &self.app,
                &hidden.path,
                hidden.presentation_id,
            ) {
                eprintln!("Could not restore Quick Access after capture: {error}");
            }
        }
    }
}

struct OverlayRendererPauseLease {
    app: AppHandle,
    identity: OverlayPresentationIdentity,
}

impl OverlayRendererPauseLease {
    fn acquire(app: &AppHandle, path: &str, presentation_id: u64) -> Result<Self, String> {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let update = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?
            .set_auto_dismiss_paused(path, presentation_id, true, Instant::now());
        if matches!(update, OverlayAutoDismissUpdate::Stale) {
            return Err("That capture is no longer active in the overlay.".into());
        }
        Ok(Self {
            app: app.clone(),
            identity: OverlayPresentationIdentity {
                path: path.into(),
                presentation_id,
            },
        })
    }
}

impl Drop for OverlayRendererPauseLease {
    fn drop(&mut self) {
        let schedule = self
            .app
            .state::<Mutex<OverlayRuntime>>()
            .lock()
            .ok()
            .and_then(|mut runtime| {
                release_renderer_auto_dismiss_pause_with_clock(
                    &mut runtime,
                    &self.identity.path,
                    self.identity.presentation_id,
                    Instant::now(),
                )
            });
        if let Some(schedule) = schedule {
            spawn_overlay_auto_dismiss(&self.app, schedule);
        }
    }
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
        self.invalidate_auto_dismiss_clock();
        self.current = None;
        self.last_failure = None;
        self.pending_latency = None;
        self.temporarily_hidden = false;
    }

    fn replace(&mut self, capture: OverlayCapture) {
        self.invalidate_auto_dismiss_clock();
        self.current = Some(capture);
        self.last_failure = None;
        self.pending_latency = None;
        self.temporarily_hidden = false;
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
            auto_dismiss_ms: OverlayAutoDismiss::TenSeconds.milliseconds(),
            quick_actions: OverlayQuickActions::default(),
            temporarily_hidden: false,
        }
    }

    fn invalidate_auto_dismiss_clock(&mut self) -> u64 {
        self.auto_dismiss_generation = self
            .auto_dismiss_generation
            .checked_add(1)
            .expect("overlay auto-dismiss generation cannot exhaust u64");
        self.auto_dismiss_clock = None;
        self.auto_dismiss_generation
    }

    fn arm_auto_dismiss(
        &mut self,
        path: &str,
        presentation_id: u64,
        now: Instant,
    ) -> Option<OverlayAutoDismissSchedule> {
        let eligible = self.current.as_ref().is_some_and(|capture| {
            capture.path == path
                && capture.presentation_id == presentation_id
                && !capture.temporarily_hidden
                && !self.temporarily_hidden
        });
        if !eligible {
            return None;
        }
        if self.auto_dismiss_clock.as_ref().is_some_and(|clock| {
            clock.identity.path == path && clock.identity.presentation_id == presentation_id
        }) {
            return None;
        }
        let after = OVERLAY_AUTO_DISMISS_DURATION;
        let deadline = now + after;
        let identity = OverlayPresentationIdentity {
            path: path.into(),
            presentation_id,
        };
        let generation = self.invalidate_auto_dismiss_clock();
        self.auto_dismiss_clock = Some(OverlayAutoDismissClock {
            identity: identity.clone(),
            generation,
            remaining: after,
            deadline: Some(deadline),
            pause_reasons: 0,
        });
        Some(OverlayAutoDismissSchedule {
            identity,
            generation,
            after,
            deadline,
        })
    }

    fn set_auto_dismiss_paused(
        &mut self,
        path: &str,
        presentation_id: u64,
        paused: bool,
        now: Instant,
    ) -> OverlayAutoDismissUpdate {
        self.set_auto_dismiss_pause_reason(
            path,
            presentation_id,
            OverlayAutoDismissPauseReason::Renderer,
            paused,
            now,
        )
    }

    fn set_auto_dismiss_pause_reason(
        &mut self,
        path: &str,
        presentation_id: u64,
        reason: OverlayAutoDismissPauseReason,
        paused: bool,
        now: Instant,
    ) -> OverlayAutoDismissUpdate {
        if !capture_matches(self.current.as_ref(), path, presentation_id) {
            return OverlayAutoDismissUpdate::Stale;
        }
        let Some(clock) = self.auto_dismiss_clock.clone() else {
            return OverlayAutoDismissUpdate::Unarmed;
        };
        if clock.identity.path != path || clock.identity.presentation_id != presentation_id {
            return OverlayAutoDismissUpdate::Unarmed;
        }

        let reason = reason.bit();
        let reason_was_paused = clock.pause_reasons & reason != 0;
        if reason_was_paused == paused {
            return OverlayAutoDismissUpdate::Unchanged;
        }
        let was_paused = clock.pause_reasons != 0;
        let pause_reasons = if paused {
            clock.pause_reasons | reason
        } else {
            clock.pause_reasons & !reason
        };
        let remains_paused = pause_reasons != 0;
        let remaining = if !was_paused && remains_paused {
            clock
                .deadline
                .map(|deadline| deadline.saturating_duration_since(now))
                .unwrap_or(clock.remaining)
        } else {
            clock.remaining
        };
        let identity = clock.identity;
        let generation = self.invalidate_auto_dismiss_clock();
        self.auto_dismiss_clock = Some(OverlayAutoDismissClock {
            identity: identity.clone(),
            generation,
            remaining,
            deadline: (!remains_paused).then_some(now + remaining),
            pause_reasons,
        });
        if was_paused && !remains_paused {
            OverlayAutoDismissUpdate::Resumed(OverlayAutoDismissSchedule {
                identity,
                generation,
                after: remaining,
                deadline: now + remaining,
            })
        } else {
            OverlayAutoDismissUpdate::Paused
        }
    }

    fn claim_auto_dismiss_expiry(
        &mut self,
        schedule: &OverlayAutoDismissSchedule,
        now: Instant,
    ) -> bool {
        if self.temporarily_hidden {
            let _ = self.set_auto_dismiss_pause_reason(
                &schedule.identity.path,
                schedule.identity.presentation_id,
                OverlayAutoDismissPauseReason::TemporarilyHidden,
                true,
                now,
            );
            return false;
        }
        if self.active_drag.as_ref().is_some_and(|drag| {
            drag.path == schedule.identity.path
                && drag.presentation_id == schedule.identity.presentation_id
        }) {
            let _ = self.set_auto_dismiss_pause_reason(
                &schedule.identity.path,
                schedule.identity.presentation_id,
                OverlayAutoDismissPauseReason::ActiveDrag,
                true,
                now,
            );
            return false;
        }
        let is_due = self.auto_dismiss_clock.as_ref().is_some_and(|clock| {
            clock.identity == schedule.identity
                && clock.generation == schedule.generation
                && clock.pause_reasons == 0
                && clock.deadline.is_some_and(|deadline| deadline <= now)
                && capture_matches(
                    self.current.as_ref(),
                    &schedule.identity.path,
                    schedule.identity.presentation_id,
                )
        });
        is_due
    }

    fn should_retry_ignored_auto_dismiss(
        &self,
        schedule: &OverlayAutoDismissSchedule,
        now: Instant,
    ) -> bool {
        self.auto_dismiss_clock.as_ref().is_some_and(|clock| {
            clock.identity == schedule.identity
                && clock.generation == schedule.generation
                && clock.pause_reasons == 0
                && clock.deadline == Some(schedule.deadline)
                && schedule.deadline <= now
                && capture_matches(
                    self.current.as_ref(),
                    &schedule.identity.path,
                    schedule.identity.presentation_id,
                )
        })
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
        self.invalidate_auto_dismiss_clock();
        self.pending_latency = None;
        self.temporarily_hidden = false;
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
    fn size_overlay(&self, width: u32, height: u32) -> Result<(), String>;
    fn position_overlay(&self, x: i32, y: i32) -> Result<(), String>;
}

impl OverlayWindowOps for WebviewWindow {
    fn hide_overlay(&self) -> Result<(), String> {
        self.hide().map_err(|error| error.to_string())
    }

    fn show_overlay(&self) -> Result<(), String> {
        self.show().map_err(|error| error.to_string())
    }

    fn size_overlay(&self, width: u32, height: u32) -> Result<(), String> {
        self.set_size(PhysicalSize::new(width, height))
            .map_err(|error| error.to_string())
    }

    fn position_overlay(&self, x: i32, y: i32) -> Result<(), String> {
        self.set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, PartialEq)]
enum RevealTransition {
    Stale,
    Hidden,
    Shown(Option<crate::latency::OverlayLatencySample>),
    Failed(OverlayFailureRecord),
}

#[derive(Debug, PartialEq)]
enum DismissTransition {
    Stale,
    Hidden,
    Dismissed,
    Failed(OverlayFailureRecord),
}

#[derive(Debug, PartialEq)]
enum TemporaryHideTransition {
    Stale,
    AlreadyHidden,
    Hidden,
    Failed(OverlayFailureRecord),
}

#[derive(Debug, PartialEq)]
enum RestoreHiddenTransition {
    Stale,
    NotHidden,
    Restored(OverlayCapture),
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
    format: CaptureExportFormat,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CaptureExportFormat {
    Png,
    Jpeg,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CaptureExport {
    pub(crate) bytes: u64,
    pub(crate) format: CaptureExportFormat,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayFileInfo {
    format: &'static str,
    bytes: u64,
    captured_at_ms: u64,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayRestored<'a> {
    path: &'a str,
    presentation_id: u64,
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

#[cfg(test)]
fn bottom_right_position(display: DisplayGeometry) -> (i32, i32) {
    OverlayPreferences::default().position(display)
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
    width: u32,
    height: u32,
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
    if let Err(error) = window.size_overlay(width, height) {
        return Err(runtime.record_failure(
            &path,
            presentation_id,
            "overlay_size_failed",
            format!("Could not size the capture overlay: {error}"),
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

#[cfg(test)]
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
    if runtime.temporarily_hidden
        || runtime
            .current
            .as_ref()
            .is_some_and(|capture| capture.temporarily_hidden)
    {
        return RevealTransition::Hidden;
    }

    match window.show_overlay() {
        Ok(()) => {
            let shown_at = now();
            runtime.temporarily_hidden = false;
            let sample = runtime.pending_latency.take().and_then(|pending| {
                (pending.presentation_id == presentation_id).then(|| pending.start.finish(shown_at))
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

fn reveal_transition_and_arm_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    now: impl FnOnce() -> Instant,
) -> (RevealTransition, Option<OverlayAutoDismissSchedule>) {
    let mut shown_at = None;
    let transition = reveal_transition_with_clock(runtime, window, path, presentation_id, || {
        let instant = now();
        shown_at = Some(instant);
        instant
    });
    let schedule = matches!(transition, RevealTransition::Shown(_))
        .then(|| {
            shown_at.and_then(|instant| runtime.arm_auto_dismiss(path, presentation_id, instant))
        })
        .flatten();
    (transition, schedule)
}

fn temporary_hide_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
) -> TemporaryHideTransition {
    temporary_hide_transition_with_clock(runtime, window, path, presentation_id, Instant::now)
}

fn temporary_hide_transition_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    now: impl FnOnce() -> Instant,
) -> TemporaryHideTransition {
    if !capture_matches(runtime.current.as_ref(), path, presentation_id) {
        return TemporaryHideTransition::Stale;
    }
    if runtime.temporarily_hidden {
        return TemporaryHideTransition::AlreadyHidden;
    }
    match window.hide_overlay() {
        Ok(()) => {
            let hidden_at = now();
            runtime.temporarily_hidden = true;
            if let Some(capture) = runtime.current.as_mut() {
                capture.temporarily_hidden = true;
            }
            let _ = runtime.set_auto_dismiss_pause_reason(
                path,
                presentation_id,
                OverlayAutoDismissPauseReason::TemporarilyHidden,
                true,
                hidden_at,
            );
            TemporaryHideTransition::Hidden
        }
        Err(error) => TemporaryHideTransition::Failed(runtime.record_failure(
            path,
            presentation_id,
            "overlay_temporary_hide_failed",
            format!("Could not temporarily hide Quick Access: {error}"),
        )),
    }
}

fn restore_hidden_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
) -> RestoreHiddenTransition {
    if !runtime.temporarily_hidden {
        return RestoreHiddenTransition::NotHidden;
    }
    let Some(capture) = runtime.current.clone() else {
        runtime.temporarily_hidden = false;
        return RestoreHiddenTransition::NotHidden;
    };
    match window.show_overlay() {
        Ok(()) => {
            runtime.temporarily_hidden = false;
            if let Some(current) = runtime.current.as_mut() {
                current.temporarily_hidden = false;
            }
            RestoreHiddenTransition::Restored(
                runtime
                    .current
                    .clone()
                    .expect("hidden capture remains current through native show"),
            )
        }
        Err(error) => RestoreHiddenTransition::Failed(runtime.record_failure(
            &capture.path,
            capture.presentation_id,
            "overlay_temporary_restore_failed",
            format!("Could not restore Quick Access: {error}"),
        )),
    }
}

fn restore_hidden_transition_and_resume_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    now: impl FnOnce() -> Instant,
) -> (RestoreHiddenTransition, Option<OverlayAutoDismissSchedule>) {
    let transition = restore_hidden_transition(runtime, window);
    let schedule = match &transition {
        RestoreHiddenTransition::Restored(capture) => {
            let shown_at = now();
            match runtime.set_auto_dismiss_pause_reason(
                &capture.path,
                capture.presentation_id,
                OverlayAutoDismissPauseReason::TemporarilyHidden,
                false,
                shown_at,
            ) {
                OverlayAutoDismissUpdate::Resumed(schedule) => Some(schedule),
                _ => None,
            }
        }
        _ => None,
    };
    (transition, schedule)
}

fn restore_exact_hidden_transition_and_resume_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    now: impl FnOnce() -> Instant,
) -> (RestoreHiddenTransition, Option<OverlayAutoDismissSchedule>) {
    if !capture_matches(runtime.current.as_ref(), path, presentation_id) {
        return (RestoreHiddenTransition::Stale, None);
    }
    restore_hidden_transition_and_resume_with_clock(runtime, window, now)
}

#[cfg(test)]
fn restore_exact_hidden_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
) -> RestoreHiddenTransition {
    if !capture_matches(runtime.current.as_ref(), path, presentation_id) {
        return RestoreHiddenTransition::Stale;
    }
    restore_hidden_transition(runtime, window)
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

#[cfg(test)]
fn dismiss_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
) -> DismissTransition {
    dismiss_transition_for_reason(runtime, window, path, presentation_id, DismissReason::Close)
}

fn dismiss_transition_for_reason(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    reason: DismissReason,
) -> DismissTransition {
    if !capture_matches(runtime.current.as_ref(), path, presentation_id) {
        return DismissTransition::Stale;
    }
    if runtime.temporarily_hidden && matches!(reason, DismissReason::Timeout) {
        return DismissTransition::Hidden;
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

fn dismiss_transition_for_auto_dismiss(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    schedule: &OverlayAutoDismissSchedule,
    now: Instant,
) -> DismissTransition {
    if !runtime.claim_auto_dismiss_expiry(schedule, now) {
        return DismissTransition::Stale;
    }
    dismiss_transition_for_reason(
        runtime,
        window,
        &schedule.identity.path,
        schedule.identity.presentation_id,
        DismissReason::Timeout,
    )
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

fn current_capture_project_path(
    runtime: &OverlayRuntime,
    path: &str,
    presentation_id: u64,
) -> Result<PathBuf, String> {
    let capture = runtime
        .current
        .as_ref()
        .filter(|capture| capture.path == path && capture.presentation_id == presentation_id)
        .ok_or_else(|| "That capture is no longer active in the overlay.".to_string())?;
    if capture.source != OverlaySource::Capture {
        return Err("A restored history capture cannot change its project here.".into());
    }
    Ok(PathBuf::from(&capture.path))
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
    begin_drag_transition_with_clock(
        runtime,
        path,
        presentation_id,
        initial_gesture,
        current_gesture,
        Instant::now(),
    )
}

fn begin_drag_transition_with_clock(
    runtime: &mut OverlayRuntime,
    path: &str,
    presentation_id: u64,
    initial_gesture: DragGestureState,
    current_gesture: DragGestureState,
    now: Instant,
) -> Result<OverlayDragIdentity, String> {
    if !initial_gesture.left_button_is_down
        || !current_gesture.left_button_is_down
        || initial_gesture.left_mouse_down_counter != current_gesture.left_mouse_down_counter
    {
        return Err(
            "The original pointer gesture ended before the capture drag could start.".into(),
        );
    }
    let identity = runtime.begin_drag(path, presentation_id)?;
    let _ = runtime.set_auto_dismiss_pause_reason(
        path,
        presentation_id,
        OverlayAutoDismissPauseReason::ActiveDrag,
        true,
        now,
    );
    Ok(identity)
}

fn finish_drag_transition_with_clock(
    runtime: &mut OverlayRuntime,
    identity: &OverlayDragIdentity,
    now: Instant,
) -> (bool, Option<OverlayAutoDismissSchedule>) {
    if !runtime.finish_drag(identity) {
        return (false, None);
    }
    let schedule = match runtime.set_auto_dismiss_pause_reason(
        &identity.path,
        identity.presentation_id,
        OverlayAutoDismissPauseReason::ActiveDrag,
        false,
        now,
    ) {
        OverlayAutoDismissUpdate::Resumed(schedule) => Some(schedule),
        _ => None,
    };
    (true, schedule)
}

fn release_renderer_auto_dismiss_pause_with_clock(
    runtime: &mut OverlayRuntime,
    path: &str,
    presentation_id: u64,
    now: Instant,
) -> Option<OverlayAutoDismissSchedule> {
    match runtime.set_auto_dismiss_paused(path, presentation_id, false, now) {
        OverlayAutoDismissUpdate::Resumed(schedule) => Some(schedule),
        _ => None,
    }
}

fn invalid_export(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn capture_export_format(destination: &Path) -> io::Result<CaptureExportFormat> {
    let extension = destination
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| invalid_export("Choose a PNG or JPEG filename."))?;
    match extension.as_str() {
        "png" => Ok(CaptureExportFormat::Png),
        "jpg" | "jpeg" => Ok(CaptureExportFormat::Jpeg),
        _ => Err(invalid_export("Capso Save As supports PNG, JPG, and JPEG.")),
    }
}

fn validate_export_destination(destination: &Path) -> io::Result<()> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !fs::symlink_metadata(parent)?.file_type().is_dir() {
        return Err(invalid_export(
            "Choose a destination inside a direct local directory.",
        ));
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if !metadata.file_type().is_file() => Err(invalid_export(
            "The destination must be a direct regular file, not a link or directory.",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn validate_export_paths(source: &Path, destination: &Path) -> io::Result<()> {
    let source_metadata = fs::symlink_metadata(source)?;
    if !source_metadata.file_type().is_file()
        || source_metadata.len() == 0
        || source_metadata.len() > MAX_SAVE_AS_SOURCE_BYTES
    {
        return Err(invalid_export(
            "The durable capture is not a safe bounded regular file.",
        ));
    }
    validate_export_destination(destination)
}

fn decode_bounded_png_reader(input: impl io::BufRead + Seek) -> io::Result<image::RgbaImage> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SAVE_AS_EDGE);
    limits.max_image_height = Some(MAX_SAVE_AS_EDGE);
    limits.max_alloc = Some(MAX_SAVE_AS_PIXELS.saturating_mul(4) + 64 * 1024 * 1024);
    let mut reader = ImageReader::with_format(input, image::ImageFormat::Png);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let (width, height) = (image.width(), image.height());
    if width == 0
        || height == 0
        || width > MAX_SAVE_AS_EDGE
        || height > MAX_SAVE_AS_EDGE
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_SAVE_AS_PIXELS
    {
        return Err(invalid_export(
            "The durable capture exceeds Capso's safe image limits.",
        ));
    }
    Ok(image.to_rgba8())
}

fn decode_bounded_capture_png(source: &Path) -> io::Result<image::RgbaImage> {
    let file = File::open(source)?;
    let mut signature = [0_u8; PNG_SIGNATURE.len()];
    let mut input = BufReader::new(file);
    input.read_exact(&mut signature)?;
    if &signature != PNG_SIGNATURE {
        return Err(invalid_export(
            "The durable capture is not a real PNG image.",
        ));
    }
    input.seek(SeekFrom::Start(0))?;
    decode_bounded_png_reader(input)
}

fn write_jpeg_image(rgba: &image::RgbaImage, output: &mut File) -> io::Result<(u32, u32)> {
    let dimensions = rgba.dimensions();
    let mut rgb = image::RgbImage::new(dimensions.0, dimensions.1);
    for (source_pixel, output_pixel) in rgba.pixels().zip(rgb.pixels_mut()) {
        let alpha = u16::from(source_pixel[3]);
        let inverse = 255_u16.saturating_sub(alpha);
        for channel in 0..3 {
            output_pixel[channel] =
                ((u16::from(source_pixel[channel]) * alpha + 255_u16 * inverse + 127) / 255) as u8;
        }
    }
    JpegEncoder::new_with_quality(output, JPEG_SAVE_AS_QUALITY)
        .encode(
            rgb.as_raw(),
            dimensions.0,
            dimensions.1,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(dimensions)
}

fn write_jpeg_capture(source: &Path, output: &mut File) -> io::Result<(u32, u32)> {
    let rgba = decode_bounded_capture_png(source)?;
    write_jpeg_image(&rgba, output)
}

fn validate_exported_image(
    temporary: &Path,
    format: CaptureExportFormat,
    expected_dimensions: Option<(u32, u32)>,
) -> io::Result<u64> {
    let metadata = fs::symlink_metadata(temporary)?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(invalid_export("Capso did not produce a valid image file."));
    }
    let mut file = File::open(temporary)?;
    let mut signature = [0_u8; PNG_SIGNATURE.len()];
    let signature_length = match format {
        CaptureExportFormat::Png => PNG_SIGNATURE.len(),
        CaptureExportFormat::Jpeg => JPEG_SIGNATURE.len(),
    };
    file.read_exact(&mut signature[..signature_length])?;
    let valid_signature = match format {
        CaptureExportFormat::Png => &signature == PNG_SIGNATURE,
        CaptureExportFormat::Jpeg => &signature[..signature_length] == JPEG_SIGNATURE,
    };
    if !valid_signature {
        return Err(invalid_export(
            "Capso produced an image with the wrong format.",
        ));
    }
    if let Some(expected) = expected_dimensions {
        let file = File::open(temporary)?;
        let image_format = match format {
            CaptureExportFormat::Png => image::ImageFormat::Png,
            CaptureExportFormat::Jpeg => image::ImageFormat::Jpeg,
        };
        let dimensions = ImageReader::with_format(BufReader::new(file), image_format)
            .into_dimensions()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if dimensions != expected {
            return Err(invalid_export(
                "The saved image dimensions do not match the durable capture.",
            ));
        }
    }
    Ok(metadata.len())
}

fn export_capture(source: &Path, destination: &Path) -> io::Result<CaptureExport> {
    let format = capture_export_format(destination)?;
    validate_export_paths(source, destination)?;
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".capso-export-{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let expected_dimensions = match format {
            CaptureExportFormat::Png => {
                let mut input = File::open(source)?;
                io::copy(&mut input, &mut output)?;
                None
            }
            CaptureExportFormat::Jpeg => Some(write_jpeg_capture(source, &mut output)?),
        };
        output.sync_all()?;
        drop(output);
        let bytes = validate_exported_image(&temporary, format, expected_dimensions)?;
        fs::rename(&temporary, destination)?;
        File::open(parent)?.sync_all()?;
        Ok(CaptureExport { bytes, format })
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn export_png_bytes(png: &[u8], destination: &Path) -> io::Result<CaptureExport> {
    if png.is_empty() || png.len() as u64 > MAX_SAVE_AS_SOURCE_BYTES {
        return Err(invalid_export(
            "The flattened annotation is not a safe bounded PNG image.",
        ));
    }
    let format = capture_export_format(destination)?;
    validate_export_destination(destination)?;
    let rgba = decode_bounded_png_reader(Cursor::new(png))?;
    let dimensions = rgba.dimensions();
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".capso-export-{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        match format {
            CaptureExportFormat::Png => output.write_all(png)?,
            CaptureExportFormat::Jpeg => {
                write_jpeg_image(&rgba, &mut output)?;
            }
        }
        output.sync_all()?;
        drop(output);
        let bytes = validate_exported_image(&temporary, format, Some(dimensions))?;
        fs::rename(&temporary, destination)?;
        File::open(parent)?.sync_all()?;
        Ok(CaptureExport { bytes, format })
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

fn target_display(app: &AppHandle, mode: CaptureMode) -> Result<DisplayTarget, OverlayStatus> {
    let displays = available_display_targets(app)
        .map_err(|error| overlay_failure("overlay_displays_unavailable", error))?;
    let geometries = displays
        .iter()
        .map(|display| display.geometry)
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

    let primary = displays
        .iter()
        .find(|display| display.is_primary)
        .map(|display| display.geometry);

    let selected_geometry = capture_display(mode, selected, primary)
        .or_else(|| geometries.first().copied())
        .ok_or_else(|| {
            overlay_failure(
                "overlay_display_missing",
                "Could not find a display for the capture overlay.",
            )
        })?;
    displays
        .into_iter()
        .find(|display| display.geometry == selected_geometry)
        .ok_or_else(|| {
            overlay_failure(
                "overlay_display_missing",
                "Could not resolve the target display for the capture overlay.",
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
) -> Result<(WebviewWindow, DisplayTarget), OverlayStatus> {
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
    display: DisplayTarget,
    path: &Path,
    clipboard: &ClipboardStatus,
    source: OverlaySource,
    latency_start: Option<crate::latency::OverlayLatencyStart>,
) -> OverlayStatus {
    let preferences = overlay_settings_path(app)
        .and_then(|path| load_stored_overlay_settings(&path))
        .map(|stored| settings_for_display(&stored, &display.id))
        .unwrap_or_else(|error| {
            eprintln!("Capso — Quick Access settings unavailable; using safe defaults: {error}");
            OverlayPreferences::default()
        });
    let (width, height) = preferences.physical_dimensions(display.geometry);
    let (x, y) = preferences.position(display.geometry);
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
    let mut payload = runtime.next_capture(
        path.to_string_lossy().into_owned(),
        clipboard.clone(),
        source,
    );
    payload.auto_dismiss_ms = preferences.auto_dismiss.milliseconds();
    payload.quick_actions = preferences.quick_actions;

    if let Err(failure) = prepare_transition(
        &mut runtime,
        window,
        payload.clone(),
        latency_start,
        width,
        height,
        x,
        y,
    ) {
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

fn spawn_overlay_auto_dismiss(app: &AppHandle, schedule: OverlayAutoDismissSchedule) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut deadline = schedule.deadline;
        let path = schedule.identity.path.clone();
        let presentation_id = schedule.identity.presentation_id;
        loop {
            tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            let state = app.state::<Mutex<OverlayRuntime>>();
            let outcome = dismiss_overlay_exact(
                &app,
                state.inner(),
                path.clone(),
                presentation_id,
                DismissReason::Timeout,
                Some(&schedule),
            );
            if matches!(outcome, Ok(true)) {
                break;
            }
            let now = Instant::now();
            let should_retry = state
                .lock()
                .map(|runtime| runtime.should_retry_ignored_auto_dismiss(&schedule, now))
                .unwrap_or(false);
            if !should_retry {
                break;
            }
            if let Err(error) = outcome {
                eprintln!("Could not auto-dismiss Quick Access: {error}");
            }
            deadline = now + OVERLAY_AUTO_DISMISS_RETRY_DELAY;
        }
    });
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

pub(crate) fn has_temporarily_hidden_capture<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Mutex<OverlayRuntime>>()
        .lock()
        .map(|runtime| runtime.temporarily_hidden && runtime.current.is_some())
        .unwrap_or(false)
}

fn hide_current_overlay_for_capture(
    app: &AppHandle,
) -> Result<Option<OverlayPresentationIdentity>, String> {
    let (transition, identity) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        let Some(capture) = runtime.current.clone() else {
            return Ok(None);
        };
        let identity = OverlayPresentationIdentity {
            path: capture.path.clone(),
            presentation_id: capture.presentation_id,
        };
        let window = app
            .get_webview_window(OVERLAY_LABEL)
            .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
        let transition = temporary_hide_transition(
            &mut runtime,
            &window,
            &capture.path,
            capture.presentation_id,
        );
        (transition, identity)
    };
    match transition {
        TemporaryHideTransition::Stale | TemporaryHideTransition::AlreadyHidden => Ok(None),
        TemporaryHideTransition::Hidden => {
            if let Err(error) = app.emit_to(
                OVERLAY_LABEL,
                "overlay-hidden",
                OverlayRestored {
                    path: &identity.path,
                    presentation_id: identity.presentation_id,
                },
            ) {
                let rollback = restore_temporarily_hidden_overlay_if_current(
                    app,
                    &identity.path,
                    identity.presentation_id,
                )
                .err()
                .map(|restore_error| format!(" Restore also failed: {restore_error}"))
                .unwrap_or_default();
                return Err(format!(
                    "Could not pause the Quick Access timer before capture: {error}.{rollback}"
                ));
            }
            Ok(Some(identity))
        }
        TemporaryHideTransition::Failed(failure) => {
            report_overlay_failure(app, &failure);
            Err(failure.message)
        }
    }
}

#[tauri::command]
pub(crate) fn overlay_hide_temporarily(
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
        temporary_hide_transition(&mut runtime, &window, &path, presentation_id)
    };
    match transition {
        TemporaryHideTransition::Stale => Ok(false),
        TemporaryHideTransition::AlreadyHidden | TemporaryHideTransition::Hidden => {
            crate::refresh_tray_status(&app)?;
            Ok(true)
        }
        TemporaryHideTransition::Failed(failure) => {
            report_overlay_failure(&app, &failure);
            Err(failure.message)
        }
    }
}

#[tauri::command]
pub(crate) fn overlay_set_auto_dismiss_paused(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    paused: bool,
) -> Result<bool, String> {
    let update = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        runtime.set_auto_dismiss_paused(&path, presentation_id, paused, Instant::now())
    };
    match update {
        OverlayAutoDismissUpdate::Stale => Ok(false),
        OverlayAutoDismissUpdate::Resumed(schedule) => {
            spawn_overlay_auto_dismiss(&app, schedule);
            Ok(true)
        }
        OverlayAutoDismissUpdate::Unarmed
        | OverlayAutoDismissUpdate::Unchanged
        | OverlayAutoDismissUpdate::Paused => Ok(true),
    }
}

pub(crate) fn restore_temporarily_hidden_overlay(app: &AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let (transition, schedule) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        restore_hidden_transition_and_resume_with_clock(&mut runtime, &window, Instant::now)
    };
    finish_restore_transition(app, transition, schedule)
}

fn restore_temporarily_hidden_overlay_if_current(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
) -> Result<bool, String> {
    let (transition, schedule) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        let window = app
            .get_webview_window(OVERLAY_LABEL)
            .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
        restore_exact_hidden_transition_and_resume_with_clock(
            &mut runtime,
            &window,
            path,
            presentation_id,
            Instant::now,
        )
    };
    finish_restore_transition(app, transition, schedule)
}

fn finish_restore_transition(
    app: &AppHandle,
    transition: RestoreHiddenTransition,
    schedule: Option<OverlayAutoDismissSchedule>,
) -> Result<bool, String> {
    match transition {
        RestoreHiddenTransition::Stale | RestoreHiddenTransition::NotHidden => Ok(false),
        RestoreHiddenTransition::Restored(capture) => {
            if let Some(schedule) = schedule {
                spawn_overlay_auto_dismiss(app, schedule);
            }
            app.emit_to(
                OVERLAY_LABEL,
                "overlay-restored",
                OverlayRestored {
                    path: &capture.path,
                    presentation_id: capture.presentation_id,
                },
            )
            .map_err(|error| format!("Could not resume the Quick Access timer: {error}"))?;
            crate::refresh_tray_status(app)?;
            Ok(true)
        }
        RestoreHiddenTransition::Failed(failure) => {
            report_overlay_failure(app, &failure);
            Err(failure.message)
        }
    }
}

#[tauri::command]
pub(crate) fn get_overlay_sync_status(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<crate::queue::CaptureSyncStatus, String> {
    let source = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        current_capture_path(&runtime, &path, presentation_id)?
    };
    crate::queue::capture_sync_status_for_app(&app, &source)
}

fn validated_current_local_capture(
    app: &AppHandle,
    runtime: &OverlayRuntime,
    path: &str,
    presentation_id: u64,
) -> Result<crate::history::RecentCapture, String> {
    let current = current_capture_path(runtime, path, presentation_id)?;
    let id = current
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The current capture does not have a valid local identity.".to_string())?;
    let capture = crate::history::resolve_recent_capture_for_app(app, id)?;
    if capture.path != current {
        return Err("The current capture no longer matches Capso's local original.".into());
    }
    Ok(capture)
}

#[tauri::command]
pub(crate) fn get_overlay_file_info(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<OverlayFileInfo, String> {
    let capture = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        validated_current_local_capture(&app, &runtime, &path, presentation_id)?
    };
    Ok(OverlayFileInfo {
        format: "PNG",
        bytes: capture.bytes,
        captured_at_ms: capture.captured_at_ms,
    })
}

#[tauri::command]
pub(crate) fn reveal_overlay_capture(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<(), String> {
    let capture = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        validated_current_local_capture(&app, &runtime, &path, presentation_id)?
    };
    tauri_plugin_opener::reveal_item_in_dir(&capture.path)
        .map_err(|error| format!("Could not show the local original in Finder: {error}"))
}

#[tauri::command]
pub(crate) fn open_overlay_capture(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
) -> Result<(), String> {
    let capture = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        validated_current_local_capture(&app, &runtime, &path, presentation_id)?
    };
    tauri_plugin_opener::open_path(&capture.path, None::<&str>)
        .map_err(|error| format!("Could not open the local original: {error}"))
}

#[tauri::command]
pub(crate) fn assign_overlay_project(
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    project_id: Option<String>,
) -> Result<(), String> {
    let runtime = state
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    let capture = current_capture_project_path(&runtime, &path, presentation_id)?;
    crate::queue::assign_project_for_app(&app, &capture, project_id.as_deref())
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
    let (transition, schedule) = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        reveal_transition_and_arm_with_clock(
            &mut runtime,
            &window,
            &path,
            presentation_id,
            Instant::now,
        )
    };

    match transition {
        RevealTransition::Stale => Ok(false),
        RevealTransition::Hidden => Ok(false),
        RevealTransition::Shown(sample) => {
            if let Some(schedule) = schedule {
                spawn_overlay_auto_dismiss(&app, schedule);
            }
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
    app: AppHandle,
    state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    filename: String,
) -> Result<OverlaySaveResult, String> {
    let source = {
        let runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        current_capture_path(&runtime, &path, presentation_id)?
    };
    let preferences = get_save_as_preferences(&app)?;
    let filename_path = Path::new(&filename);
    if filename.trim().is_empty()
        || filename_path.file_name().and_then(|name| name.to_str()) != Some(filename.as_str())
        || filename.chars().any(char::is_control)
    {
        return Err("The generated Save filename is invalid.".into());
    }
    let expected_extension = match preferences.format {
        CaptureExportFormat::Png => "png",
        CaptureExportFormat::Jpeg => "jpg",
    };
    if filename_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some(expected_extension)
    {
        return Err("The generated Save filename does not match the selected format.".into());
    }
    let directory = if preferences.directory.is_empty() {
        let directory = default_save_directory(&app)?;
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create the Save folder: {error}"))?;
        directory
    } else {
        PathBuf::from(&preferences.directory)
    };
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("Could not use the Save folder: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("The configured Save folder is not a direct local folder.".into());
    }
    let stem = filename_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| "The generated Save filename is invalid.".to_string())?;
    let mut destination_path = directory.join(&filename);
    for suffix in 2..=1_000 {
        if !destination_path.exists() {
            break;
        }
        destination_path = directory.join(format!("{stem} ({suffix}).{expected_extension}"));
    }
    if destination_path.exists() {
        return Err("The Save folder contains too many captures with the same name.".into());
    }
    if source == destination_path {
        return Err("Choose a different location for the saved copy.".into());
    }

    let destination = destination_path.to_string_lossy().into_owned();
    let exported =
        tauri::async_runtime::spawn_blocking(move || export_capture(&source, &destination_path))
            .await
            .map_err(|error| format!("The capture export task stopped unexpectedly: {error}"))?
            .map_err(|error| format!("Could not save the capture copy: {error}"))?;

    Ok(OverlaySaveResult {
        destination,
        bytes: exported.bytes,
        format: exported.format,
    })
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

            let (finished, schedule) = callback_app
                .state::<Mutex<OverlayRuntime>>()
                .lock()
                .map(|mut runtime| {
                    finish_drag_transition_with_clock(
                        &mut runtime,
                        &callback_identity,
                        Instant::now(),
                    )
                })
                .unwrap_or((false, None));
            if let Some(schedule) = schedule {
                spawn_overlay_auto_dismiss(&callback_app, schedule);
            }
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
        let schedule = app
            .state::<Mutex<OverlayRuntime>>()
            .lock()
            .ok()
            .and_then(|mut runtime| {
                finish_drag_transition_with_clock(&mut runtime, &identity, Instant::now()).1
            });
        if let Some(schedule) = schedule {
            spawn_overlay_auto_dismiss(app, schedule);
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
    let _renderer_pause_lease = OverlayRendererPauseLease::acquire(&app, &path, presentation_id)?;
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
    dismiss_overlay_exact(&app, state.inner(), path, presentation_id, reason, None)
}

fn dismiss_overlay_exact(
    app: &AppHandle,
    state: &Mutex<OverlayRuntime>,
    path: String,
    presentation_id: u64,
    reason: DismissReason,
    auto_dismiss: Option<&OverlayAutoDismissSchedule>,
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
        match auto_dismiss {
            Some(schedule) => {
                dismiss_transition_for_auto_dismiss(&mut runtime, &window, schedule, Instant::now())
            }
            None => {
                dismiss_transition_for_reason(&mut runtime, &window, &path, presentation_id, reason)
            }
        }
    };

    match transition {
        DismissTransition::Stale | DismissTransition::Hidden => Ok(false),
        DismissTransition::Dismissed => {
            release_quick_access_capture(app, Path::new(&path));
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
            report_overlay_failure(app, &failure);
            Err(failure.message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        annotation_refresh_payload, begin_drag_transition, begin_drag_transition_with_clock,
        bottom_right_position, capture_display, capture_matches, current_capture_path,
        current_capture_project_path, dismiss_transition, dismiss_transition_for_auto_dismiss,
        dismiss_transition_for_reason, display_at_cursor, display_profile_ids, export_capture,
        export_png_bytes, fail_transition, finish_drag_transition_with_clock,
        load_stored_overlay_settings, prepare_transition,
        release_renderer_auto_dismiss_pause_with_clock, restore_exact_hidden_transition,
        restore_hidden_transition, restore_hidden_transition_and_resume_with_clock,
        reveal_transition, reveal_transition_and_arm_with_clock, reveal_transition_with_clock,
        save_stored_overlay_settings, settings_for_display, temporary_hide_transition,
        temporary_hide_transition_with_clock, update_stored_preferences,
        validate_save_as_preferences, CaptureExportFormat, DismissReason, DismissTransition,
        DisplayGeometry, DragGestureState, OverlayAutoDismiss, OverlayAutoDismissSchedule,
        OverlayAutoDismissUpdate, OverlayCapture, OverlayDragEnded, OverlayDragOutcome,
        OverlayPlacement, OverlayPreferences, OverlayQuickActions, OverlayRuntime,
        OverlaySaveAsPreferences, OverlaySize, OverlaySource, OverlayWindowOps,
        RestoreHiddenTransition, RevealTransition, ScreenPoint, ScreenRect, StoredOverlaySettings,
        TemporaryHideTransition, OVERLAY_HEIGHT_LOGICAL, OVERLAY_LABEL, OVERLAY_WIDTH_LOGICAL,
    };
    use crate::capture::CaptureMode;
    use crate::clipboard::ClipboardStatus;
    use std::{
        cell::{Cell, RefCell},
        fs,
    };

    #[derive(Default)]
    struct FakeWindow {
        visible: Cell<bool>,
        size: Cell<(u32, u32)>,
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

        fn size_overlay(&self, width: u32, height: u32) -> Result<(), String> {
            self.transitions.borrow_mut().push("size");
            self.size.set((width, height));
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
            auto_dismiss_ms: Some(8_000),
            quick_actions: OverlayQuickActions::default(),
            temporarily_hidden: false,
        }
    }

    fn at(start: std::time::Instant, seconds: u64) -> std::time::Instant {
        start + std::time::Duration::from_secs(seconds)
    }

    fn revealed_clock(
        path: &str,
        presentation_id: u64,
        start: std::time::Instant,
    ) -> (OverlayRuntime, FakeWindow, OverlayAutoDismissSchedule) {
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id(path, presentation_id));
        let (shown, schedule) = reveal_transition_and_arm_with_clock(
            &mut runtime,
            &window,
            path,
            presentation_id,
            || start,
        );
        assert_eq!(shown, RevealTransition::Shown(None));
        let schedule = schedule.expect("native clock");
        assert_eq!(
            schedule.deadline,
            start + std::time::Duration::from_secs(10)
        );
        (runtime, window, schedule)
    }

    #[test]
    fn auto_dismiss_arms_on_exact_first_show_for_ten_seconds() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, schedule) = revealed_clock(path, 1, start);
        assert_eq!(schedule.after, std::time::Duration::from_secs(10));
        let (stale, stale_schedule) =
            reveal_transition_and_arm_with_clock(&mut runtime, &window, path, 2, || start);
        assert_eq!((stale, stale_schedule), (RevealTransition::Stale, None));

        let mut hidden_runtime = OverlayRuntime::default();
        hidden_runtime.replace(capture(path));
        assert_eq!(
            temporary_hide_transition_with_clock(&mut hidden_runtime, &window, path, 1, || at(
                start, 1
            )),
            TemporaryHideTransition::Hidden
        );
        let (_, restored_schedule) =
            restore_hidden_transition_and_resume_with_clock(&mut hidden_runtime, &window, || {
                at(start, 20)
            });
        assert_eq!(restored_schedule, None);
        let (shown, revealed_schedule) =
            reveal_transition_and_arm_with_clock(&mut hidden_runtime, &window, path, 1, || {
                at(start, 25)
            });
        assert_eq!(shown, RevealTransition::Shown(None));
        assert_eq!(
            revealed_schedule
                .expect("decoded reveal arms the clock")
                .after,
            std::time::Duration::from_secs(10)
        );
    }

    #[test]
    fn auto_dismiss_deadline_is_sampled_after_native_show() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let shown_at = at(start, 5);
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(path));

        let (shown, schedule) =
            reveal_transition_and_arm_with_clock(&mut runtime, &window, path, 1, || {
                window.transitions.borrow_mut().push("clock");
                shown_at
            });

        assert_eq!(shown, RevealTransition::Shown(None));
        assert_eq!(*window.transitions.borrow(), vec!["show", "clock"]);
        assert_eq!(
            schedule.expect("shown presentation clock").deadline,
            at(shown_at, 10),
        );
    }

    #[test]
    fn auto_dismiss_pause_reasons_preserve_visible_time_independently() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, first) = revealed_clock(path, 1, start);
        assert_eq!(
            runtime.set_auto_dismiss_paused(path, 1, true, at(start, 2)),
            OverlayAutoDismissUpdate::Paused
        );
        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 3)),
            TemporaryHideTransition::Hidden
        );
        let (_, native_schedule) =
            restore_hidden_transition_and_resume_with_clock(&mut runtime, &window, || {
                at(start, 30)
            });
        assert_eq!(native_schedule, None);
        let OverlayAutoDismissUpdate::Resumed(resumed) =
            runtime.set_auto_dismiss_paused(path, 1, false, at(start, 40))
        else {
            panic!("last pause owner resumes");
        };
        assert_eq!(resumed.after, std::time::Duration::from_secs(8));
        assert_ne!(resumed.generation, first.generation);
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &first, at(start, 10)),
            DismissTransition::Stale
        );
    }

    #[test]
    fn auto_dismiss_native_drag_and_hidden_leases_do_not_race_renderer_ipc() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, first) = revealed_clock(path, 1, start);
        let pressed = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 7,
        };
        let identity =
            begin_drag_transition_with_clock(&mut runtime, path, 1, pressed, pressed, at(start, 2))
                .expect("drag begins");
        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 3)),
            TemporaryHideTransition::Hidden
        );
        let (_, restore_schedule) =
            restore_hidden_transition_and_resume_with_clock(&mut runtime, &window, || {
                at(start, 20)
            });
        assert_eq!(restore_schedule, None);
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &first, at(start, 10)),
            DismissTransition::Stale
        );
        let (finished, resumed) =
            finish_drag_transition_with_clock(&mut runtime, &identity, at(start, 30));
        assert!(finished);
        assert_eq!(
            resumed.expect("drag was last pause").after,
            std::time::Duration::from_secs(8)
        );
    }

    #[test]
    fn native_drag_releases_renderer_preflight_even_when_renderer_never_resumes() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, _window, _) = revealed_clock(path, 1, start);
        assert_eq!(
            runtime.set_auto_dismiss_paused(path, 1, true, at(start, 1)),
            OverlayAutoDismissUpdate::Paused
        );
        let pressed = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 11,
        };
        let identity =
            begin_drag_transition_with_clock(&mut runtime, path, 1, pressed, pressed, at(start, 2))
                .expect("native drag owns the live session");
        assert_eq!(
            release_renderer_auto_dismiss_pause_with_clock(&mut runtime, path, 1, at(start, 2),),
            None,
            "ActiveDrag still owns the paused clock"
        );
        let (_, resumed) =
            finish_drag_transition_with_clock(&mut runtime, &identity, at(start, 30));
        assert_eq!(
            resumed.expect("native completion is the final owner").after,
            std::time::Duration::from_secs(9)
        );

        let (mut failed_runtime, _window, _) = revealed_clock(path, 1, start);
        assert_eq!(
            failed_runtime.set_auto_dismiss_paused(path, 1, true, at(start, 1)),
            OverlayAutoDismissUpdate::Paused
        );
        assert_eq!(
            release_renderer_auto_dismiss_pause_with_clock(
                &mut failed_runtime,
                path,
                1,
                at(start, 2),
            )
            .expect("command error releases preflight")
            .after,
            std::time::Duration::from_secs(9)
        );
    }

    #[test]
    fn auto_dismiss_replacement_rejects_old_wakeups_and_unrelated_drags() {
        let path = "/tmp/capso/repeated.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, old_schedule) = revealed_clock(path, 1, start);
        runtime.replace(capture_with_id(path, 2));
        assert_eq!(
            dismiss_transition_for_auto_dismiss(
                &mut runtime,
                &window,
                &old_schedule,
                at(start, 10)
            ),
            DismissTransition::Stale
        );

        runtime.replace(capture_with_id(path, 1));
        let old_drag = runtime.begin_drag(path, 1).expect("old drag");
        runtime.replace(capture_with_id(path, 2));
        let (_, replacement) =
            reveal_transition_and_arm_with_clock(&mut runtime, &window, path, 2, || start);
        assert_eq!(
            dismiss_transition_for_auto_dismiss(
                &mut runtime,
                &window,
                &replacement.expect("replacement clock"),
                at(start, 10),
            ),
            DismissTransition::Dismissed
        );
        assert!(runtime.finish_drag(&old_drag));
    }

    #[test]
    fn auto_dismiss_expiry_retries_hide_failure_and_clears_failed_presentations() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, schedule) = revealed_clock(path, 1, start);
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &schedule, at(start, 9)),
            DismissTransition::Stale
        );
        window.fail_hide.set(true);
        assert!(matches!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &schedule, at(start, 10)),
            DismissTransition::Failed(_)
        ));
        window.fail_hide.set(false);
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &schedule, at(start, 11)),
            DismissTransition::Dismissed
        );

        let (mut failed_runtime, failed_window, _) = revealed_clock(path, 1, start);
        assert!(fail_transition(
            &mut failed_runtime,
            &failed_window,
            path,
            1,
            "overlay_decode_failed",
            "decode failed",
        )
        .is_some());
        assert!(failed_runtime.auto_dismiss_clock.is_none());
    }

    #[test]
    fn auto_dismiss_temporary_hide_failure_leaves_visible_clock_running() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, schedule) = revealed_clock(path, 1, start);
        window.fail_hide.set(true);
        assert!(matches!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 3)),
            TemporaryHideTransition::Failed(_)
        ));
        window.fail_hide.set(false);
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &schedule, at(start, 10)),
            DismissTransition::Dismissed
        );
    }

    #[test]
    fn auto_dismiss_protected_current_retries_but_stale_ignored_wakeup_stops() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, _window, schedule) = revealed_clock(path, 1, start);
        // The scheduler asks this only after the shared dismiss lifecycle says
        // `Ok(false)`. An exact due clock is therefore protected; a replaced
        // or otherwise stale clock must stop instead of leaking a retry task.
        assert!(runtime.should_retry_ignored_auto_dismiss(&schedule, at(start, 10)));
        assert!(!runtime.should_retry_ignored_auto_dismiss(&schedule, at(start, 9)));

        runtime.replace(capture_with_id(path, 2));
        assert!(
            !runtime.should_retry_ignored_auto_dismiss(&schedule, at(start, 11)),
            "a stale ignored wakeup cannot leave a retry task behind"
        );
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

        assert_eq!(bottom_right_position(external), (-648, 1310));
    }

    #[test]
    fn overlay_preferences_keep_every_size_inside_each_scaled_work_area_corner() {
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
        let cases = [
            (OverlayPlacement::TopLeft, OverlaySize::Compact, (-2840, 88)),
            (OverlayPlacement::TopRight, OverlaySize::Regular, (-808, 88)),
            (
                OverlayPlacement::BottomLeft,
                OverlaySize::Large,
                (-2840, 1110),
            ),
            (
                OverlayPlacement::BottomRight,
                OverlaySize::Large,
                (-968, 1110),
            ),
        ];
        for (placement, size, expected) in cases {
            let preferences = OverlayPreferences {
                placement,
                size,
                auto_dismiss: OverlayAutoDismiss::Never,
                quick_actions: OverlayQuickActions::default(),
            };
            assert_eq!(preferences.position(external), expected);
        }
    }

    #[test]
    fn oversized_overlay_scales_down_proportionally_inside_a_tiny_work_area() {
        let tiny = display(
            ScreenRect {
                x: -500,
                y: 20,
                width: 500,
                height: 300,
            },
            ScreenRect {
                x: -500,
                y: 44,
                width: 500,
                height: 276,
            },
            1.0,
        );
        let preferences = OverlayPreferences {
            placement: OverlayPlacement::BottomRight,
            size: OverlaySize::Large,
            auto_dismiss: OverlayAutoDismiss::Never,
            quick_actions: OverlayQuickActions::default(),
        };

        let (width, height) = preferences.physical_dimensions(tiny);
        let (x, y) = preferences.position(tiny);
        assert!(width <= tiny.work_area.width - 40);
        assert!(height <= tiny.work_area.height - 40);
        assert!(((f64::from(width) / f64::from(height)) - (464.0 / 294.0)).abs() < 0.01);
        assert!(x >= tiny.work_area.x);
        assert!(y >= tiny.work_area.y);
        assert!(
            i64::from(x) + i64::from(width)
                <= i64::from(tiny.work_area.x) + i64::from(tiny.work_area.width)
        );
        assert!(
            i64::from(y) + i64::from(height)
                <= i64::from(tiny.work_area.y) + i64::from(tiny.work_area.height)
        );
    }

    #[test]
    fn overlay_settings_keep_distinct_display_profiles_and_ignore_unknown_displays() {
        let mut stored = StoredOverlaySettings::default();
        let studio = OverlayPreferences {
            placement: OverlayPlacement::TopRight,
            size: OverlaySize::Regular,
            auto_dismiss: OverlayAutoDismiss::TenSeconds,
            quick_actions: OverlayQuickActions::default(),
        };
        let laptop = OverlayPreferences {
            placement: OverlayPlacement::BottomLeft,
            size: OverlaySize::Large,
            auto_dismiss: OverlayAutoDismiss::TenSeconds,
            quick_actions: OverlayQuickActions::default(),
        };
        update_stored_preferences(&mut stored, "studio", studio).expect("store Studio profile");
        update_stored_preferences(&mut stored, "laptop", laptop).expect("store laptop profile");
        assert_eq!(settings_for_display(&stored, "studio"), studio);
        assert_eq!(settings_for_display(&stored, "laptop"), laptop);
        assert_eq!(
            settings_for_display(&stored, "new-display"),
            OverlayPreferences::default()
        );
        assert!(update_stored_preferences(&mut stored, "", studio).is_err());
    }

    #[test]
    fn quick_actions_are_backward_compatible_and_cannot_all_be_disabled() {
        let root = std::env::temp_dir().join(format!(
            "capso-overlay-legacy-actions-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("overlay-settings.json");
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(
            &path,
            br#"{"version":1,"profiles":{"studio":{"placement":"top_right","size":"regular","autoDismiss":"never"}}}"#,
        )
        .expect("write legacy preferences");
        let legacy = load_stored_overlay_settings(&path).expect("legacy preferences remain valid");
        assert_eq!(
            settings_for_display(&legacy, "studio").quick_actions,
            OverlayQuickActions::default()
        );

        let mut stored = StoredOverlaySettings::default();
        let invalid = OverlayPreferences {
            quick_actions: OverlayQuickActions {
                pin: false,
                annotate: false,
                copy: false,
                save: false,
            },
            ..OverlayPreferences::default()
        };
        assert!(update_stored_preferences(&mut stored, "studio", invalid).is_err());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn legacy_never_autoclose_is_normalized_to_ten_seconds() {
        assert_eq!(OverlayAutoDismiss::Never.milliseconds(), Some(10_000));

        let root = std::env::temp_dir().join(format!(
            "capso-overlay-legacy-autoclose-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("overlay-settings.json");
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(
            &path,
            br#"{"version":1,"profiles":{"studio":{"placement":"bottom_right","size":"compact","autoDismiss":"never"}}}"#,
        )
        .expect("write legacy preferences");

        let stored = load_stored_overlay_settings(&path).expect("load legacy preferences");
        assert_eq!(
            settings_for_display(&stored, "studio").auto_dismiss,
            OverlayAutoDismiss::TenSeconds
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn save_as_preferences_accept_only_safe_bounded_filename_templates() {
        let valid = OverlaySaveAsPreferences {
            format: CaptureExportFormat::Jpeg,
            filename_template: "Client review {date} — {time}".into(),
            directory: String::new(),
        };
        validate_save_as_preferences(&valid).expect("safe template");

        for filename_template in [
            "",
            "../escape {date}",
            "folder/name {time}",
            "folder\\name {time}",
            ".hidden {date}",
            "Unknown {project}",
        ] {
            assert!(validate_save_as_preferences(&OverlaySaveAsPreferences {
                format: CaptureExportFormat::Png,
                filename_template: filename_template.into(),
                directory: String::new(),
            })
            .is_err());
        }
    }

    #[test]
    fn legacy_overlay_settings_receive_portable_save_as_defaults() {
        let legacy: StoredOverlaySettings =
            serde_json::from_str(r#"{"version":1,"profiles":{}}"#).expect("legacy settings decode");

        assert_eq!(legacy.save_as, OverlaySaveAsPreferences::default());
        assert_eq!(legacy.save_as.format, CaptureExportFormat::Png);
        assert_eq!(legacy.save_as.filename_template, "Capso {date} at {time}");
    }

    #[test]
    fn temporary_hide_preserves_the_exact_capture_until_explicit_restore() {
        let path = "/tmp/capso/current.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(path));

        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, path, 1),
            TemporaryHideTransition::Hidden
        );
        assert!(!window.visible.get());
        assert!(runtime.temporarily_hidden);
        let hidden = runtime.current.as_ref().expect("capture remains current");
        assert_eq!(hidden.path, path);
        assert!(hidden.temporarily_hidden);
        assert_eq!(
            restore_hidden_transition(&mut runtime, &window),
            RestoreHiddenTransition::Restored(capture(path))
        );
        assert!(window.visible.get());
        assert!(!runtime.temporarily_hidden);
        assert_eq!(runtime.current, Some(capture(path)));
    }

    #[test]
    fn repeated_temporary_hide_does_not_claim_restore_ownership() {
        let path = "/tmp/capso/current.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(path));

        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, path, 1),
            TemporaryHideTransition::Hidden
        );
        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, path, 1),
            TemporaryHideTransition::AlreadyHidden
        );
        assert!(!window.visible.get());
        assert!(runtime.temporarily_hidden);
    }

    #[test]
    fn exact_restore_never_reveals_a_different_hidden_capture() {
        let old_path = "/tmp/capso/old.png";
        let new_path = "/tmp/capso/new.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(old_path));
        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, old_path, 1),
            TemporaryHideTransition::Hidden
        );
        runtime.replace(OverlayCapture {
            path: new_path.into(),
            presentation_id: 2,
            ..capture(new_path)
        });
        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, new_path, 2),
            TemporaryHideTransition::Hidden
        );

        assert_eq!(
            restore_exact_hidden_transition(&mut runtime, &window, old_path, 1),
            RestoreHiddenTransition::Stale
        );
        assert!(!window.visible.get());
        assert!(runtime.temporarily_hidden);
        assert_eq!(
            runtime
                .current
                .as_ref()
                .map(|capture| capture.path.as_str()),
            Some(new_path)
        );
    }

    #[test]
    fn hidden_capture_ignores_a_racing_timeout_dismiss() {
        let path = "/tmp/capso/current.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(path));
        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, path, 1),
            TemporaryHideTransition::Hidden
        );

        assert_eq!(
            dismiss_transition_for_reason(&mut runtime, &window, path, 1, DismissReason::Timeout,),
            DismissTransition::Hidden
        );
        assert!(runtime.current.is_some());
        assert!(runtime.temporarily_hidden);
    }

    #[test]
    fn hidden_overlay_ignores_late_image_ready_until_explicit_restore() {
        let path = "/tmp/capso/current.png";
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(path));
        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, path, 1),
            TemporaryHideTransition::Hidden
        );

        assert_eq!(
            reveal_transition(&mut runtime, &window, path, 1),
            RevealTransition::Hidden
        );
        assert!(!window.visible.get());
        assert!(
            runtime
                .current
                .as_ref()
                .expect("capture remains current")
                .temporarily_hidden
        );
    }

    #[test]
    fn display_profiles_survive_rearrangement_and_disambiguate_identical_monitors() {
        let left = display(
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
        let right = display(
            ScreenRect {
                x: 3024,
                y: 0,
                width: 2880,
                height: 1800,
            },
            ScreenRect {
                x: 3024,
                y: 48,
                width: 2880,
                height: 1690,
            },
            2.0,
        );

        assert_eq!(
            display_profile_ids(&[("Studio Display".into(), left)]),
            display_profile_ids(&[("Studio Display".into(), right)]),
            "moving one display must not create a new preference profile",
        );
        let duplicate_ids = display_profile_ids(&[
            ("Studio Display".into(), left),
            ("Studio Display".into(), right),
        ]);
        assert_ne!(duplicate_ids[0], duplicate_ids[1]);
    }

    #[test]
    fn overlay_settings_round_trip_atomically_and_corrupt_state_is_never_overwritten() {
        let root =
            std::env::temp_dir().join(format!("capso-overlay-settings-{}", uuid::Uuid::new_v4()));
        let path = root.join("overlay-settings.json");
        let mut stored =
            load_stored_overlay_settings(&path).expect("missing settings use defaults");
        update_stored_preferences(
            &mut stored,
            "studio",
            OverlayPreferences {
                placement: OverlayPlacement::TopLeft,
                size: OverlaySize::Regular,
                auto_dismiss: OverlayAutoDismiss::Never,
                quick_actions: OverlayQuickActions::default(),
            },
        )
        .expect("store profile");
        save_stored_overlay_settings(&path, &stored).expect("save atomically");
        assert_eq!(load_stored_overlay_settings(&path).expect("reload"), stored);

        fs::write(&path, b"{not-json").expect("install corrupt fixture");
        assert!(load_stored_overlay_settings(&path).is_err());
        assert_eq!(fs::read(&path).expect("corrupt bytes remain"), b"{not-json");
        fs::remove_dir_all(root).expect("remove fixture");
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
            auto_dismiss_ms: Some(8_000),
            quick_actions: OverlayQuickActions::default(),
            temporarily_hidden: false,
        };

        assert!(!capture_matches(Some(&current), "/tmp/capso/old.png", 2));
        assert!(capture_matches(Some(&current), "/tmp/capso/new.png", 2));
        assert!(!capture_matches(Some(&current), "/tmp/capso/new.png", 1));
        assert!(!capture_matches(None, "/tmp/capso/new.png", 2));
    }

    #[test]
    fn project_filing_accepts_only_the_exact_fresh_capture_presentation() {
        let capture = OverlayCapture {
            path: "/tmp/capso/new.png".into(),
            presentation_id: 2,
            clipboard: ClipboardStatus::Copied { bytes: 42 },
            source: OverlaySource::Capture,
            auto_dismiss_ms: Some(8_000),
            quick_actions: OverlayQuickActions::default(),
            temporarily_hidden: false,
        };
        let runtime = OverlayRuntime {
            current: Some(capture),
            ..OverlayRuntime::default()
        };
        assert_eq!(
            current_capture_project_path(&runtime, "/tmp/capso/new.png", 2)
                .expect("exact fresh capture"),
            std::path::PathBuf::from("/tmp/capso/new.png")
        );
        assert!(current_capture_project_path(&runtime, "/tmp/capso/old.png", 2).is_err());
        assert!(current_capture_project_path(&runtime, "/tmp/capso/new.png", 1).is_err());

        let history = OverlayRuntime {
            current: Some(OverlayCapture {
                source: OverlaySource::History,
                ..runtime.current.expect("capture")
            }),
            ..OverlayRuntime::default()
        };
        assert!(current_capture_project_path(&history, "/tmp/capso/new.png", 2).is_err());
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
            304,
            194,
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
            auto_dismiss_ms: Some(8_000),
            quick_actions: OverlayQuickActions::default(),
            temporarily_hidden: false,
        };
        prepare_transition(
            &mut history_runtime,
            &window,
            history,
            None,
            304,
            194,
            120,
            240,
        )
        .expect("history prepares");
        assert_eq!(
            reveal_transition_with_clock(
                &mut history_runtime,
                &window,
                history_path,
                1,
                std::time::Instant::now,
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
            304,
            194,
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
            auto_dismiss_ms: Some(8_000),
            quick_actions: OverlayQuickActions::default(),
            temporarily_hidden: false,
        };

        assert_eq!(
            serde_json::to_value(restored).expect("serialize restored overlay"),
            serde_json::json!({
                "path": "/tmp/capso/history.png",
                "presentationId": 7,
                "clipboard": { "status": "unchanged" },
                "source": "history",
                "autoDismissMs": 8000,
                "quickActions": {
                    "pin": true,
                    "annotate": true,
                    "copy": true,
                    "save": true
                },
                "temporarilyHidden": false
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
        prepare_transition(
            &mut runtime,
            &window,
            capture(new_path),
            None,
            304,
            194,
            120,
            240,
        )
        .expect("new capture prepares");
        assert!(!window.visible.get());
        assert_eq!(runtime.current, Some(capture(new_path)));

        // If new prepare wins first, the stale old callback is rejected and
        // cannot show the window while the new image is still decoding.
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(old_path));
        prepare_transition(
            &mut runtime,
            &window,
            capture(new_path),
            None,
            304,
            194,
            120,
            240,
        )
        .expect("new capture prepares");
        assert_eq!(
            reveal_transition(&mut runtime, &window, old_path, 1),
            RevealTransition::Stale
        );
        assert!(!window.visible.get());
        assert_eq!(window.size.get(), (304, 194));
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
        prepare_transition(
            &mut runtime,
            &window,
            capture(new_path),
            None,
            304,
            194,
            120,
            240,
        )
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
            304,
            194,
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
            vec!["hide", "size", "position", "show", "hide"]
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
            export_capture(&source, &destination)
                .expect("export succeeds")
                .bytes,
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
            export_capture(&source, &source)
                .expect("same path remains safe")
                .bytes,
            pixels.len() as u64
        );
        assert_eq!(std::fs::read(&source).expect("source remains"), pixels);

        std::fs::hard_link(&source, &alias).expect("create aliased destination");
        assert_eq!(
            export_capture(&source, &alias)
                .expect("hard-link alias remains safe")
                .bytes,
            pixels.len() as u64
        );
        assert_eq!(std::fs::read(&source).expect("source remains"), pixels);
        assert_eq!(std::fs::read(&alias).expect("alias remains"), pixels);
    }

    #[test]
    fn save_as_jpeg_flattens_alpha_on_white_at_exact_source_dimensions() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.png");
        let destination = directory.path().join("Capso capture.jpg");
        let mut pixels = image::RgbaImage::new(2, 1);
        pixels.put_pixel(0, 0, image::Rgba([255, 0, 0, 128]));
        pixels.put_pixel(1, 0, image::Rgba([0, 0, 255, 0]));
        pixels.save(&source).expect("write source PNG");
        let source_before = std::fs::read(&source).expect("source bytes");

        let exported = export_capture(&source, &destination).expect("JPEG export succeeds");

        assert_eq!(exported.format, CaptureExportFormat::Jpeg);
        assert_eq!(image::image_dimensions(&destination).unwrap(), (2, 1));
        assert_eq!(
            &std::fs::read(&destination).unwrap()[..3],
            &[0xff, 0xd8, 0xff]
        );
        assert_eq!(std::fs::read(&source).unwrap(), source_before);
    }

    #[test]
    fn save_as_rejects_unsupported_or_linked_destinations_before_mutating_source() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.png");
        image::RgbaImage::new(2, 2)
            .save(&source)
            .expect("write source PNG");
        let source_before = std::fs::read(&source).expect("source bytes");

        assert!(export_capture(&source, &directory.path().join("capture.webp")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                directory.path().join("missing-target.jpg"),
                directory.path().join("linked.jpg"),
            )
            .expect("create destination symlink");
            assert!(export_capture(&source, &directory.path().join("linked.jpg")).is_err());
        }
        assert_eq!(std::fs::read(&source).unwrap(), source_before);
    }

    #[test]
    fn annotation_export_bytes_share_the_exact_png_and_jpeg_contract() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let png_destination = directory.path().join("Annotated.png");
        let jpeg_destination = directory.path().join("Annotated.jpg");
        let mut pixels = image::RgbaImage::new(3, 2);
        pixels.put_pixel(0, 0, image::Rgba([255, 0, 0, 128]));
        let mut source = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(pixels)
            .write_to(&mut source, image::ImageFormat::Png)
            .expect("encode flattened annotation");
        let source = source.into_inner();

        let png = export_png_bytes(&source, &png_destination).expect("PNG export");
        let jpeg = export_png_bytes(&source, &jpeg_destination).expect("JPEG export");

        assert_eq!(png.format, CaptureExportFormat::Png);
        assert_eq!(std::fs::read(png_destination).unwrap(), source);
        assert_eq!(jpeg.format, CaptureExportFormat::Jpeg);
        assert_eq!(image::image_dimensions(jpeg_destination).unwrap(), (3, 2));
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
            serde_json::json!(["$APPDATA/captures/**", "$APPDATA/freeze/**"])
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
            serde_json::json!(["core:event:default"])
        );
    }
}
