use crate::{capture::CaptureMode, clipboard::ClipboardStatus};
use image::{codecs::jpeg::JpegEncoder, ImageReader, Limits};
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSAccessibility, NSWindow, NSWindowAnimationBehavior};
#[cfg(target_os = "macos")]
use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType, CGMouseButton};
#[cfg(target_os = "macos")]
use objc2_quartz_core::CATransaction;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
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
const OVERLAY_PAINT_ACK_TIMEOUT: Duration = Duration::from_secs(15);
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
    surface_generation: u64,
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

pub(crate) struct OverlayRuntime {
    current: Option<OverlayCapture>,
    presented: Option<OverlayPresentationIdentity>,
    last_failure: Option<OverlayFailureRecord>,
    presentation_generation: u64,
    surface_generation: u64,
    surface_phase: OverlaySurfacePhase,
    renderer_bootstrap_generation: Option<u64>,
    auto_dismiss_generation: u64,
    auto_dismiss_clock: Option<OverlayAutoDismissClock>,
    pending_paint_generation: u64,
    pending_paint: Option<OverlayPendingPaint>,
    active_drag: Option<OverlayDragIdentity>,
    pending_latency: Option<PendingOverlayLatency>,
    temporarily_hidden: bool,
}

impl Default for OverlayRuntime {
    fn default() -> Self {
        Self {
            current: None,
            presented: None,
            last_failure: None,
            presentation_generation: 0,
            surface_generation: 0,
            surface_phase: OverlaySurfacePhase::HardHidden,
            renderer_bootstrap_generation: None,
            auto_dismiss_generation: 0,
            auto_dismiss_clock: None,
            pending_paint_generation: 0,
            pending_paint: None,
            active_drag: None,
            pending_latency: None,
            temporarily_hidden: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OverlaySurfacePhase {
    #[default]
    HardHidden,
    WarmHidden,
    Visible,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlaySurfaceState {
    surface_generation: u64,
    phase: OverlaySurfacePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presentation_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayRendererReadySnapshot {
    surface: OverlaySurfaceState,
    capture: Option<OverlayCapture>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OverlayPresentationIdentity {
    path: String,
    presentation_id: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OverlayHiddenSurfaceIdentity {
    path: String,
    presentation_id: u64,
    surface_generation: u64,
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

#[derive(Clone, Debug, Eq, PartialEq)]
struct OverlayPendingPaintSchedule {
    identity: OverlayPresentationIdentity,
    surface_generation: u64,
    generation: u64,
    after: Duration,
    deadline: Instant,
}

#[derive(Clone, Debug)]
struct OverlayPendingPaint {
    identity: OverlayPresentationIdentity,
    surface_generation: u64,
    generation: u64,
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

#[derive(Clone, Debug, Eq, PartialEq)]
enum OverlayPaintAcknowledgement {
    Stale,
    NotShown,
    AlreadyArmed,
    Paused,
    Armed(OverlayAutoDismissSchedule),
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct OverlayResumeSchedules {
    auto_dismiss: Option<OverlayAutoDismissSchedule>,
    paint_watchdog: Option<OverlayPendingPaintSchedule>,
    latency: Option<crate::latency::OverlayLatencySample>,
}

enum OverlayDismissConstraint {
    AutoDismiss(OverlayAutoDismissSchedule),
    PendingPaint(OverlayPendingPaintSchedule),
}

pub(crate) struct CaptureOverlayLease {
    app: AppHandle,
    hidden: Option<OverlayHiddenSurfaceIdentity>,
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
            if let Err(error) = restore_temporarily_hidden_overlay_surface_if_current(
                &self.app,
                &hidden.path,
                hidden.presentation_id,
                hidden.surface_generation,
            ) {
                eprintln!("Could not restore Quick Access after capture: {error}");
            }
        }
    }
}

struct OverlayRendererPauseLease {
    app: AppHandle,
    identity: OverlayPresentationIdentity,
    surface_generation: u64,
}

impl OverlayRendererPauseLease {
    fn acquire(
        app: &AppHandle,
        path: &str,
        presentation_id: u64,
        surface_generation: u64,
    ) -> Result<Self, String> {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let update = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?
            .set_auto_dismiss_paused_exact(
                path,
                presentation_id,
                surface_generation,
                true,
                Instant::now(),
            );
        if matches!(update, OverlayAutoDismissUpdate::Stale) {
            return Err("That capture is no longer active in the overlay.".into());
        }
        Ok(Self {
            app: app.clone(),
            identity: OverlayPresentationIdentity {
                path: path.into(),
                presentation_id,
            },
            surface_generation,
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
                release_renderer_auto_dismiss_pause_exact_with_clock(
                    &mut runtime,
                    &self.identity.path,
                    self.identity.presentation_id,
                    self.surface_generation,
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
    surface_generation: u64,
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
    fn surface_state(&self) -> OverlaySurfaceState {
        let (path, presentation_id) = self
            .current
            .as_ref()
            .map(|capture| (Some(capture.path.clone()), Some(capture.presentation_id)))
            .unwrap_or((None, None));
        OverlaySurfaceState {
            surface_generation: self.surface_generation,
            phase: self.surface_phase,
            path,
            presentation_id,
        }
    }

    fn begin_hard_hidden_surface(&mut self) -> u64 {
        self.surface_generation = self
            .surface_generation
            .checked_add(1)
            .expect("overlay surface generation cannot exhaust u64");
        self.surface_phase = OverlaySurfacePhase::HardHidden;
        self.renderer_bootstrap_generation = None;
        self.presented = None;
        self.active_drag = None;
        if let Some(capture) = self.current.as_mut() {
            capture.surface_generation = self.surface_generation;
        }
        self.surface_generation
    }

    fn is_exact_surface(&self, path: &str, presentation_id: u64, surface_generation: u64) -> bool {
        self.surface_generation == surface_generation
            && self.current.as_ref().is_some_and(|capture| {
                capture.path == path
                    && capture.presentation_id == presentation_id
                    && capture.surface_generation == surface_generation
            })
    }

    fn reset(&mut self) {
        self.invalidate_auto_dismiss_clock();
        self.invalidate_pending_paint();
        self.current = None;
        self.presented = None;
        self.last_failure = None;
        self.pending_latency = None;
        self.temporarily_hidden = false;
        self.active_drag = None;
    }

    fn replace(&mut self, capture: OverlayCapture) {
        self.invalidate_auto_dismiss_clock();
        self.invalidate_pending_paint();
        self.current = Some(capture);
        self.presented = None;
        self.last_failure = None;
        self.pending_latency = None;
        self.temporarily_hidden = false;
        self.active_drag = None;
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
            surface_generation: self.surface_generation,
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

    fn next_pending_paint_generation(&mut self) -> u64 {
        self.pending_paint_generation = self
            .pending_paint_generation
            .checked_add(1)
            .expect("overlay pending-paint generation cannot exhaust u64");
        self.pending_paint_generation
    }

    fn invalidate_pending_paint(&mut self) -> u64 {
        let generation = self.next_pending_paint_generation();
        self.pending_paint = None;
        generation
    }

    fn begin_pending_paint(
        &mut self,
        path: &str,
        presentation_id: u64,
        surface_generation: u64,
        now: Instant,
    ) -> Option<OverlayPendingPaintSchedule> {
        let eligible = self.is_exact_surface(path, presentation_id, surface_generation)
            && self.surface_phase == OverlaySurfacePhase::WarmHidden
            && self
                .current
                .as_ref()
                .is_some_and(|capture| !capture.temporarily_hidden)
            && !self.temporarily_hidden;
        if !eligible {
            return None;
        }
        let already_pending = self.pending_paint.as_ref().is_some_and(|pending| {
            pending.identity.path == path
                && pending.identity.presentation_id == presentation_id
                && pending.surface_generation == surface_generation
        });
        if already_pending {
            return None;
        }
        let after = OVERLAY_PAINT_ACK_TIMEOUT;
        let deadline = now + after;
        let identity = OverlayPresentationIdentity {
            path: path.into(),
            presentation_id,
        };
        let generation = self.next_pending_paint_generation();
        self.pending_paint = Some(OverlayPendingPaint {
            identity: identity.clone(),
            surface_generation,
            generation,
            deadline: Some(deadline),
            pause_reasons: 0,
        });
        Some(OverlayPendingPaintSchedule {
            identity,
            surface_generation,
            generation,
            after,
            deadline,
        })
    }

    fn acknowledge_painted(
        &mut self,
        path: &str,
        presentation_id: u64,
        now: Instant,
    ) -> OverlayPaintAcknowledgement {
        self.acknowledge_painted_exact(path, presentation_id, self.surface_generation, now)
    }

    fn acknowledge_painted_exact(
        &mut self,
        path: &str,
        presentation_id: u64,
        surface_generation: u64,
        now: Instant,
    ) -> OverlayPaintAcknowledgement {
        if !self.is_exact_surface(path, presentation_id, surface_generation) {
            return OverlayPaintAcknowledgement::Stale;
        }
        let Some(pending) = self.pending_paint.clone().filter(|pending| {
            pending.identity.path == path
                && pending.identity.presentation_id == presentation_id
                && pending.surface_generation == surface_generation
        }) else {
            return if self.auto_dismiss_clock.as_ref().is_some_and(|clock| {
                clock.identity.path == path && clock.identity.presentation_id == presentation_id
            }) {
                OverlayPaintAcknowledgement::AlreadyArmed
            } else {
                OverlayPaintAcknowledgement::NotShown
            };
        };

        if self.auto_dismiss_clock.as_ref().is_some_and(|clock| {
            clock.identity.path == path && clock.identity.presentation_id == presentation_id
        }) {
            let pending_pause_reasons = pending.pause_reasons;
            self.invalidate_pending_paint();
            for reason in [
                OverlayAutoDismissPauseReason::Renderer,
                OverlayAutoDismissPauseReason::ActiveDrag,
            ] {
                if pending_pause_reasons & reason.bit() != 0 {
                    let _ = self.set_auto_dismiss_pause_reason(
                        path,
                        presentation_id,
                        reason,
                        true,
                        now,
                    );
                }
            }
            return match self.set_auto_dismiss_pause_reason(
                path,
                presentation_id,
                OverlayAutoDismissPauseReason::TemporarilyHidden,
                false,
                now,
            ) {
                OverlayAutoDismissUpdate::Resumed(schedule) => {
                    OverlayPaintAcknowledgement::Armed(schedule)
                }
                OverlayAutoDismissUpdate::Paused => OverlayPaintAcknowledgement::Paused,
                OverlayAutoDismissUpdate::Unchanged => OverlayPaintAcknowledgement::AlreadyArmed,
                OverlayAutoDismissUpdate::Stale | OverlayAutoDismissUpdate::Unarmed => {
                    OverlayPaintAcknowledgement::Stale
                }
            };
        }

        let mut pause_reasons = pending.pause_reasons;
        if self.temporarily_hidden
            || self
                .current
                .as_ref()
                .is_some_and(|capture| capture.temporarily_hidden)
        {
            pause_reasons |= OverlayAutoDismissPauseReason::TemporarilyHidden.bit();
        }
        if self
            .active_drag
            .as_ref()
            .is_some_and(|drag| drag.path == path && drag.presentation_id == presentation_id)
        {
            pause_reasons |= OverlayAutoDismissPauseReason::ActiveDrag.bit();
        }

        self.invalidate_pending_paint();
        let identity = pending.identity;
        let generation = self.invalidate_auto_dismiss_clock();
        let deadline = (pause_reasons == 0).then_some(now + OVERLAY_AUTO_DISMISS_DURATION);
        self.auto_dismiss_clock = Some(OverlayAutoDismissClock {
            identity: identity.clone(),
            generation,
            remaining: OVERLAY_AUTO_DISMISS_DURATION,
            deadline,
            pause_reasons,
        });
        match deadline {
            Some(deadline) => OverlayPaintAcknowledgement::Armed(OverlayAutoDismissSchedule {
                identity,
                generation,
                after: OVERLAY_AUTO_DISMISS_DURATION,
                deadline,
            }),
            None => OverlayPaintAcknowledgement::Paused,
        }
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

    fn set_auto_dismiss_paused_exact(
        &mut self,
        path: &str,
        presentation_id: u64,
        surface_generation: u64,
        paused: bool,
        now: Instant,
    ) -> OverlayAutoDismissUpdate {
        if !self.is_exact_surface(path, presentation_id, surface_generation) {
            return OverlayAutoDismissUpdate::Stale;
        }
        self.set_auto_dismiss_paused(path, presentation_id, paused, now)
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
        if let Some(pending) = self.pending_paint.as_mut().filter(|pending| {
            pending.identity.path == path && pending.identity.presentation_id == presentation_id
        }) {
            let reason = reason.bit();
            let reason_was_paused = pending.pause_reasons & reason != 0;
            if reason_was_paused == paused {
                return OverlayAutoDismissUpdate::Unchanged;
            }
            if paused {
                pending.pause_reasons |= reason;
            } else {
                pending.pause_reasons &= !reason;
            }
            return OverlayAutoDismissUpdate::Paused;
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

    fn claim_pending_paint_expiry(
        &self,
        schedule: &OverlayPendingPaintSchedule,
        now: Instant,
    ) -> bool {
        self.pending_paint.as_ref().is_some_and(|pending| {
            pending.identity == schedule.identity
                && pending.surface_generation == schedule.surface_generation
                && pending.generation == schedule.generation
                && pending.deadline == Some(schedule.deadline)
                && schedule.deadline <= now
                && !self.temporarily_hidden
                && self.surface_generation == schedule.surface_generation
                && self.surface_phase == OverlaySurfacePhase::WarmHidden
                && capture_matches(
                    self.current.as_ref(),
                    &schedule.identity.path,
                    schedule.identity.presentation_id,
                )
        })
    }

    fn should_retry_pending_paint(
        &self,
        schedule: &OverlayPendingPaintSchedule,
        now: Instant,
    ) -> bool {
        self.pending_paint.as_ref().is_some_and(|pending| {
            pending.identity == schedule.identity
                && pending.surface_generation == schedule.surface_generation
                && pending.generation == schedule.generation
                && pending.deadline == Some(schedule.deadline)
                && schedule.deadline <= now
                && !self.temporarily_hidden
                && self.surface_generation == schedule.surface_generation
                && self.surface_phase == OverlaySurfacePhase::WarmHidden
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
        self.presented = None;
        self.invalidate_auto_dismiss_clock();
        self.invalidate_pending_paint();
        self.pending_latency = None;
        self.temporarily_hidden = false;
        self.active_drag = None;
        Some(self.record_failure(path, presentation_id, code, message))
    }

    fn begin_drag(
        &mut self,
        path: &str,
        presentation_id: u64,
    ) -> Result<OverlayDragIdentity, String> {
        let surface_generation = self
            .current
            .as_ref()
            .filter(|capture| capture.path == path && capture.presentation_id == presentation_id)
            .map(|capture| capture.surface_generation)
            .ok_or_else(|| "That capture is no longer active in the overlay.".to_string())?;
        if self.active_drag.is_some() {
            return Err("Another capture drag is still in progress.".into());
        }
        let identity = OverlayDragIdentity {
            path: path.into(),
            presentation_id,
            surface_generation,
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

type OverlayMainThreadTask = Box<dyn FnOnce() + Send + 'static>;

fn dispatch_acknowledged_main_thread_transaction<T, D, F>(
    dispatch: D,
    transaction: F,
) -> Result<T, String>
where
    T: Send + 'static,
    D: FnOnce(OverlayMainThreadTask) -> Result<(), String>,
    F: FnOnce() -> T + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    dispatch(Box::new(move || {
        let _ = sender.send(transaction());
    }))?;
    receiver
        .recv()
        .map_err(|_| "The Quick Access main-thread transaction did not complete.".to_string())
}

fn run_overlay_main_thread_transaction<T, F>(app: &AppHandle, transaction: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(AppHandle) -> T + Send + 'static,
{
    let transaction_app = app.clone();
    dispatch_acknowledged_main_thread_transaction(
        |task| {
            app.run_on_main_thread(task)
                .map_err(|error| format!("Could not schedule Quick Access on main: {error}"))
        },
        move || transaction(transaction_app),
    )
}

#[cfg(target_os = "macos")]
fn mutate_native_overlay_window<T, F>(window: &WebviewWindow, mutation: F) -> Result<T, String>
where
    F: FnOnce(&NSWindow) -> Result<T, String>,
{
    let _main_thread = MainThreadMarker::new().ok_or_else(|| {
        "Quick Access native mutation was not on AppKit's main thread.".to_string()
    })?;
    let pointer = window
        .ns_window()
        .map_err(|error| format!("Could not access the native Quick Access panel: {error}"))?;
    // SAFETY: Tauri owns this NSWindow for at least as long as WebviewWindow,
    // and MainThreadMarker above proves AppKit's thread requirement.
    let window = unsafe { &*pointer.cast::<NSWindow>() };
    mutation(window)
}

#[cfg(target_os = "macos")]
fn park_native_overlay(window: &WebviewWindow) -> Result<(), String> {
    mutate_native_overlay_window(window, |window| {
        let content = window
            .contentView()
            .ok_or_else(|| "The Quick Access content view is unavailable.".to_string())?;
        // The transparent NSWindow stays fully present so WindowServer never
        // defers its next reveal. Only the content view is concealed; WebKit
        // remains warm and native expiry can still remove pixels immediately.
        window.setIgnoresMouseEvents(true);
        content.setAccessibilityHidden(true);
        window.setAnimationBehavior(NSWindowAnimationBehavior::None);
        window.setAlphaValue(1.0);
        content.setAlphaValue(0.0);
        if window.isKeyWindow() {
            window.orderOut(None);
        }
        window.orderFrontRegardless();
        window.displayIfNeeded();
        CATransaction::flush();
        Ok(())
    })
}

#[cfg(target_os = "macos")]
fn warm_native_overlay(window: &WebviewWindow) -> Result<(), String> {
    mutate_native_overlay_window(window, |window| {
        let content = window
            .contentView()
            .ok_or_else(|| "The Quick Access content view is unavailable.".to_string())?;
        // The renderer has committed an exact hidden DOM generation. Warm its
        // compositor surface without exposing it to pointer or accessibility
        // input; the later exact paint acknowledgement performs activation.
        window.setIgnoresMouseEvents(true);
        content.setAccessibilityHidden(true);
        window.setAnimationBehavior(NSWindowAnimationBehavior::None);
        window.setAlphaValue(1.0);
        content.setAlphaValue(1.0);
        window.orderFrontRegardless();
        content.displayIfNeededIgnoringOpacity();
        window.displayIfNeeded();
        CATransaction::flush();
        Ok(())
    })
}

#[cfg(target_os = "macos")]
fn present_native_overlay(window: &WebviewWindow, reduced_motion: bool) -> Result<(), String> {
    mutate_native_overlay_window(window, move |window| {
        let _ = reduced_motion;
        let content = window
            .contentView()
            .ok_or_else(|| "The Quick Access content view is unavailable.".to_string())?;
        window.setAnimationBehavior(NSWindowAnimationBehavior::None);
        window.setIgnoresMouseEvents(true);
        if !window.isVisible() {
            window.orderFrontRegardless();
        }

        // Force the decoded WebKit tree to display while concealed, then
        // reveal only that content. NSWindow itself never leaves alpha one.
        content.displayIfNeededIgnoringOpacity();
        window.setAlphaValue(1.0);
        content.setAlphaValue(1.0);
        content.setAccessibilityHidden(false);
        window.orderFrontRegardless();
        content.displayIfNeeded();
        window.displayIfNeeded();
        CATransaction::flush();
        window.setIgnoresMouseEvents(false);
        Ok(())
    })
}

trait OverlayWindowOps {
    fn park_overlay(&self) -> Result<(), String>;
    fn warm_overlay(&self) -> Result<(), String>;
    fn present_overlay(&self, reduced_motion: bool) -> Result<(), String>;
    fn size_overlay(&self, width: u32, height: u32) -> Result<(), String>;
    fn position_overlay(&self, x: i32, y: i32) -> Result<(), String>;
}

impl OverlayWindowOps for WebviewWindow {
    fn park_overlay(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            return park_native_overlay(self);
        }
        #[cfg(not(target_os = "macos"))]
        self.hide().map_err(|error| error.to_string())
    }

    fn present_overlay(&self, reduced_motion: bool) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            return present_native_overlay(self, reduced_motion);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = reduced_motion;
            self.show().map_err(|error| error.to_string())
        }
    }

    fn warm_overlay(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            return warm_native_overlay(self);
        }
        #[cfg(not(target_os = "macos"))]
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

pub(crate) fn initialize_warm_overlay(window: &WebviewWindow) -> Result<(), String> {
    window
        .park_overlay()
        .map_err(|error| format!("Could not conceal the warm Quick Access webview: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Could not activate the warm Quick Access webview: {error}"))?;
    window
        .park_overlay()
        .map_err(|error| format!("Could not initialize the warm Quick Access panel: {error}"))
}

#[derive(Debug, PartialEq)]
enum RevealTransition {
    Stale,
    Hidden,
    Shown(Option<crate::latency::OverlayLatencySample>),
}

#[derive(Debug, PartialEq)]
enum WarmHiddenTransition {
    Stale,
    AlreadyWarm,
    Warmed,
    Failed(String),
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
    surface_generation: u64,
    outcome: OverlayDragOutcome,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayDismissed<'a> {
    path: &'a str,
    presentation_id: u64,
    surface_generation: u64,
    reason: DismissReason,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayRestored<'a> {
    path: &'a str,
    presentation_id: u64,
    surface_generation: u64,
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
    mut capture: OverlayCapture,
    latency_start: Option<crate::latency::OverlayLatencyStart>,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
) -> Result<OverlayCapture, OverlayFailureRecord> {
    let path = capture.path.clone();
    let presentation_id = capture.presentation_id;

    // Reset, hide, position and replace are one serialized transition. A ready
    // or failed callback cannot interleave and mutate visibility for an older
    // capture while a newer capture is being prepared.
    runtime.reset();
    capture.surface_generation = runtime.begin_hard_hidden_surface();
    if let Err(error) = window.park_overlay() {
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

    runtime.replace(capture.clone());
    runtime.pending_latency = latency_start.map(|start| PendingOverlayLatency {
        presentation_id,
        start,
    });
    Ok(capture)
}

fn warm_hidden_transition(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    surface_generation: u64,
) -> WarmHiddenTransition {
    if runtime.surface_generation != surface_generation {
        return WarmHiddenTransition::Stale;
    }
    match runtime.surface_phase {
        OverlaySurfacePhase::WarmHidden => return WarmHiddenTransition::AlreadyWarm,
        OverlaySurfacePhase::Visible => return WarmHiddenTransition::Stale,
        OverlaySurfacePhase::HardHidden => {}
    }
    match window.warm_overlay() {
        Ok(()) => {
            runtime.surface_phase = OverlaySurfacePhase::WarmHidden;
            WarmHiddenTransition::Warmed
        }
        Err(error) => WarmHiddenTransition::Failed(error),
    }
}

fn renderer_ready_transition_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    now: impl FnOnce() -> Instant,
) -> Result<OverlayRendererReadySnapshot, String> {
    // Native pixels disappear before any renderer state is accepted. Main
    // thread serialization means a capture prepare or timeout cannot interleave
    // between this park and the atomic generation snapshot below.
    window
        .park_overlay()
        .map_err(|error| format!("Could not park Quick Access for renderer startup: {error}"))?;
    if runtime.surface_phase == OverlaySurfacePhase::HardHidden
        && runtime.renderer_bootstrap_generation == Some(runtime.surface_generation)
    {
        return Ok(OverlayRendererReadySnapshot {
            surface: runtime.surface_state(),
            capture: runtime.current.clone(),
        });
    }
    let parked_at = now();

    // A WebView reload abandons every old JS-owned paint/hover/drag callback.
    // Invalidate its watchdog, preserve the native visible-time balance behind
    // one hidden pause, and release JS interaction pauses that can no longer end.
    runtime.invalidate_pending_paint();
    if let Some(capture) = runtime.current.clone() {
        let _ = runtime.set_auto_dismiss_pause_reason(
            &capture.path,
            capture.presentation_id,
            OverlayAutoDismissPauseReason::TemporarilyHidden,
            true,
            parked_at,
        );
        let _ = runtime.set_auto_dismiss_pause_reason(
            &capture.path,
            capture.presentation_id,
            OverlayAutoDismissPauseReason::Renderer,
            false,
            parked_at,
        );
        let _ = runtime.set_auto_dismiss_pause_reason(
            &capture.path,
            capture.presentation_id,
            OverlayAutoDismissPauseReason::ActiveDrag,
            false,
            parked_at,
        );
    }
    runtime.active_drag = None;
    let surface_generation = runtime.begin_hard_hidden_surface();
    runtime.renderer_bootstrap_generation = Some(surface_generation);

    Ok(OverlayRendererReadySnapshot {
        surface: runtime.surface_state(),
        capture: runtime.current.clone(),
    })
}

fn renderer_page_load_started_transition_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    now: impl FnOnce() -> Instant,
) -> Result<OverlaySurfaceState, String> {
    // A committed navigation is a new renderer even when the previous renderer
    // was already waiting on a hard-hidden bootstrap surface.
    runtime.renderer_bootstrap_generation = None;
    renderer_ready_transition_with_clock(runtime, window, now).map(|snapshot| snapshot.surface)
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
    _window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    _now: impl FnOnce() -> Instant,
) -> RevealTransition {
    reveal_transition_exact_with_clock(
        runtime,
        _window,
        path,
        presentation_id,
        runtime.surface_generation,
        _now,
    )
}

fn reveal_transition_exact_with_clock(
    runtime: &mut OverlayRuntime,
    _window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    _now: impl FnOnce() -> Instant,
) -> RevealTransition {
    if !runtime.is_exact_surface(path, presentation_id, surface_generation) {
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
    if runtime.surface_phase != OverlaySurfacePhase::WarmHidden {
        return RevealTransition::Hidden;
    }

    RevealTransition::Shown(None)
}

fn reveal_transition_and_begin_paint_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    now: impl FnOnce() -> Instant,
) -> (RevealTransition, Option<OverlayPendingPaintSchedule>) {
    reveal_transition_and_begin_paint_exact_with_clock(
        runtime,
        window,
        path,
        presentation_id,
        runtime.surface_generation,
        now,
    )
}

fn reveal_transition_and_begin_paint_exact_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    now: impl FnOnce() -> Instant,
) -> (RevealTransition, Option<OverlayPendingPaintSchedule>) {
    let transition = reveal_transition_exact_with_clock(
        runtime,
        window,
        path,
        presentation_id,
        surface_generation,
        Instant::now,
    );
    let schedule = matches!(transition, RevealTransition::Shown(_))
        .then(|| runtime.begin_pending_paint(path, presentation_id, surface_generation, now()))
        .flatten();
    (transition, schedule)
}

#[cfg(test)]
fn acknowledge_painted_presentation(
    runtime: &mut OverlayRuntime,
    path: &str,
    presentation_id: u64,
    now: Instant,
) -> OverlayPaintAcknowledgement {
    runtime.acknowledge_painted(path, presentation_id, now)
}

fn present_painted_transition_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    _reduced_motion: bool,
    now: impl FnOnce() -> Instant,
) -> Result<
    (
        OverlayPaintAcknowledgement,
        Option<crate::latency::OverlayLatencySample>,
    ),
    OverlayFailureRecord,
> {
    present_painted_transition_exact_with_clock(
        runtime,
        window,
        path,
        presentation_id,
        runtime.surface_generation,
        _reduced_motion,
        now,
    )
}

fn present_painted_transition_exact_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    reduced_motion: bool,
    now: impl FnOnce() -> Instant,
) -> Result<
    (
        OverlayPaintAcknowledgement,
        Option<crate::latency::OverlayLatencySample>,
    ),
    OverlayFailureRecord,
> {
    if !runtime.is_exact_surface(path, presentation_id, surface_generation) {
        return Ok((OverlayPaintAcknowledgement::Stale, None));
    }
    if runtime.surface_phase == OverlaySurfacePhase::Visible {
        return Ok((OverlayPaintAcknowledgement::AlreadyArmed, None));
    }
    if runtime.surface_phase != OverlaySurfacePhase::WarmHidden {
        return Ok((OverlayPaintAcknowledgement::NotShown, None));
    }
    let pending_is_exact = runtime.pending_paint.as_ref().is_some_and(|pending| {
        pending.identity.path == path
            && pending.identity.presentation_id == presentation_id
            && pending.surface_generation == surface_generation
    });
    if !pending_is_exact {
        return Ok((OverlayPaintAcknowledgement::NotShown, None));
    }
    if runtime.temporarily_hidden
        || runtime
            .current
            .as_ref()
            .is_some_and(|capture| capture.temporarily_hidden)
    {
        return Ok((
            runtime.acknowledge_painted_exact(path, presentation_id, surface_generation, now()),
            None,
        ));
    }

    match window.present_overlay(reduced_motion) {
        Ok(()) => {
            let presented_at = now();
            let acknowledgement = runtime.acknowledge_painted_exact(
                path,
                presentation_id,
                surface_generation,
                presented_at,
            );
            runtime.presented = Some(OverlayPresentationIdentity {
                path: path.into(),
                presentation_id,
            });
            runtime.surface_phase = OverlaySurfacePhase::Visible;
            let sample = runtime.pending_latency.take().and_then(|pending| {
                (pending.presentation_id == presentation_id)
                    .then(|| pending.start.finish(presented_at))
            });
            Ok((acknowledgement, sample))
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
            if window.park_overlay().is_ok() {
                runtime.begin_hard_hidden_surface();
            }
            Err(failure)
        }
    }
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
    match window.park_overlay() {
        Ok(()) => {
            let hidden_at = now();
            runtime.temporarily_hidden = true;
            runtime.presented = None;
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
            let _ = runtime.set_auto_dismiss_pause_reason(
                path,
                presentation_id,
                OverlayAutoDismissPauseReason::Renderer,
                false,
                hidden_at,
            );
            let _ = runtime.set_auto_dismiss_pause_reason(
                path,
                presentation_id,
                OverlayAutoDismissPauseReason::ActiveDrag,
                false,
                hidden_at,
            );
            runtime.active_drag = None;
            runtime.invalidate_pending_paint();
            runtime.begin_hard_hidden_surface();
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

fn temporary_hide_transition_exact_with_clock(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    now: impl FnOnce() -> Instant,
) -> TemporaryHideTransition {
    if !runtime.is_exact_surface(path, presentation_id, surface_generation) {
        return TemporaryHideTransition::Stale;
    }
    temporary_hide_transition_with_clock(runtime, window, path, presentation_id, now)
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
    if let Err(error) = window.park_overlay() {
        return RestoreHiddenTransition::Failed(runtime.record_failure(
            &capture.path,
            capture.presentation_id,
            "overlay_temporary_restore_failed",
            format!("Could not prepare Quick Access for restore: {error}"),
        ));
    }
    runtime.temporarily_hidden = false;
    if let Some(current) = runtime.current.as_mut() {
        current.temporarily_hidden = false;
    }
    runtime.invalidate_pending_paint();
    runtime.begin_hard_hidden_surface();
    RestoreHiddenTransition::Restored(
        runtime
            .current
            .clone()
            .expect("hidden capture remains current through native restore"),
    )
}

fn restore_hidden_transition_without_resume(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
) -> (RestoreHiddenTransition, OverlayResumeSchedules) {
    (
        restore_hidden_transition(runtime, window),
        OverlayResumeSchedules::default(),
    )
}

fn restore_exact_hidden_transition_without_resume(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
) -> (RestoreHiddenTransition, OverlayResumeSchedules) {
    if !capture_matches(runtime.current.as_ref(), path, presentation_id) {
        return (
            RestoreHiddenTransition::Stale,
            OverlayResumeSchedules::default(),
        );
    }
    restore_hidden_transition_without_resume(runtime, window)
}

fn restore_exact_hidden_surface_transition_without_resume(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
) -> (RestoreHiddenTransition, OverlayResumeSchedules) {
    if !runtime.is_exact_surface(path, presentation_id, surface_generation) {
        return (
            RestoreHiddenTransition::Stale,
            OverlayResumeSchedules::default(),
        );
    }
    restore_hidden_transition_without_resume(runtime, window)
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
        if window.park_overlay().is_ok() {
            runtime.begin_hard_hidden_surface();
        }
    }
    failure
}

fn fail_transition_exact(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    code: &'static str,
    message: impl Into<String>,
) -> Option<OverlayFailureRecord> {
    if !runtime.is_exact_surface(path, presentation_id, surface_generation) {
        return None;
    }
    fail_transition(runtime, window, path, presentation_id, code, message)
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

    match window.park_overlay() {
        Ok(()) => {
            runtime.reset();
            runtime.begin_hard_hidden_surface();
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

fn dismiss_transition_for_reason_exact(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    reason: DismissReason,
) -> DismissTransition {
    if !runtime.is_exact_surface(path, presentation_id, surface_generation) {
        return DismissTransition::Stale;
    }
    dismiss_transition_for_reason(runtime, window, path, presentation_id, reason)
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

fn dismiss_transition_for_pending_paint(
    runtime: &mut OverlayRuntime,
    window: &impl OverlayWindowOps,
    schedule: &OverlayPendingPaintSchedule,
    now: Instant,
) -> DismissTransition {
    if !runtime.claim_pending_paint_expiry(schedule, now) {
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
    let path = path.to_string();
    run_overlay_main_thread_transaction(app, move |main_app| {
        hide_for_annotation_on_main(&main_app, &path, presentation_id)
    })?
}

fn hide_for_annotation_on_main(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
) -> Result<(), String> {
    overlay_hide_temporarily_on_main(app, path.to_string(), presentation_id, None).and_then(
        |hidden| {
            hidden
                .then_some(())
                .ok_or_else(|| "That capture is no longer active in Quick Access.".to_string())
        },
    )
}

pub(crate) fn restore_after_annotation(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
) -> Result<(), String> {
    let path = path.to_string();
    run_overlay_main_thread_transaction(app, move |main_app| {
        restore_after_annotation_on_main(&main_app, &path, presentation_id)
    })?
}

fn restore_after_annotation_on_main(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
) -> Result<(), String> {
    restore_temporarily_hidden_overlay_if_current_on_main(app, path, presentation_id).and_then(
        |restored| {
            restored
                .then_some(())
                .ok_or_else(|| "That capture is no longer hidden in Quick Access.".to_string())
        },
    )
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
    let path = path.to_string();
    let clipboard = clipboard.cloned();
    run_overlay_main_thread_transaction(app, move |main_app| {
        refresh_after_annotation_on_main(&main_app, &path, presentation_id, clipboard.as_ref())
    })?
}

fn refresh_after_annotation_on_main(
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
    let (previous, mut payload) =
        annotation_refresh_payload(&mut runtime, path, presentation_id, clipboard)?;
    window
        .park_overlay()
        .map_err(|error| format!("Could not reset the annotated capture preview: {error}"))?;
    payload.surface_generation = runtime.begin_hard_hidden_surface();
    runtime.replace(payload.clone());
    if let Err(error) = app.emit_to(OVERLAY_LABEL, "overlay-capture", payload) {
        let mut previous = previous;
        previous.surface_generation = runtime.begin_hard_hidden_surface();
        runtime.replace(previous);
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

fn begin_drag_transition_exact_with_clock(
    runtime: &mut OverlayRuntime,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    initial_gesture: DragGestureState,
    current_gesture: DragGestureState,
    now: Instant,
) -> Result<OverlayDragIdentity, String> {
    if !runtime.is_exact_surface(path, presentation_id, surface_generation) {
        return Err("That capture surface is no longer active in the overlay.".into());
    }
    begin_drag_transition_with_clock(
        runtime,
        path,
        presentation_id,
        initial_gesture,
        current_gesture,
        now,
    )
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

fn release_renderer_auto_dismiss_pause_exact_with_clock(
    runtime: &mut OverlayRuntime,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
    now: Instant,
) -> Option<OverlayAutoDismissSchedule> {
    match runtime.set_auto_dismiss_paused_exact(
        path,
        presentation_id,
        surface_generation,
        false,
        now,
    ) {
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
    let capture_path = path.to_path_buf();
    let transition_clipboard = clipboard.clone();
    let status = run_overlay_main_thread_transaction(app, move |main_app| {
        prepare_capture_overlay_transaction(
            &main_app,
            mode,
            &capture_path,
            &transition_clipboard,
            latency_start,
        )
    })
    .unwrap_or_else(|error| overlay_failure("overlay_main_thread_failed", error));
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
    let history_path = path.to_path_buf();
    run_overlay_main_thread_transaction(app, move |main_app| {
        prepare_history_overlay_on_main(&main_app, &history_path)
    })
    .unwrap_or_else(|error| overlay_failure("overlay_main_thread_failed", error))
}

fn prepare_history_overlay_on_main(app: &AppHandle, path: &Path) -> OverlayStatus {
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

    payload = match prepare_transition(
        &mut runtime,
        window,
        payload.clone(),
        latency_start,
        width,
        height,
        x,
        y,
    ) {
        Ok(payload) => payload,
        Err(failure) => {
            drop(annotation_runtime);
            drop(runtime);
            finish_quick_access_publication(app, None);
            return overlay_failure(failure.code, failure.message);
        }
    };

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
                path.clone(),
                presentation_id,
                DismissReason::Timeout,
                None,
                Some(OverlayDismissConstraint::AutoDismiss(schedule.clone())),
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

fn spawn_overlay_paint_watchdog(app: &AppHandle, schedule: OverlayPendingPaintSchedule) {
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
                path.clone(),
                presentation_id,
                DismissReason::Timeout,
                None,
                Some(OverlayDismissConstraint::PendingPaint(schedule.clone())),
            );
            if matches!(outcome, Ok(true)) {
                break;
            }
            let now = Instant::now();
            let should_retry = state
                .lock()
                .map(|runtime| runtime.should_retry_pending_paint(&schedule, now))
                .unwrap_or(false);
            if !should_retry {
                break;
            }
            if let Err(error) = outcome {
                eprintln!("Could not close an unpainted Quick Access preview: {error}");
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

#[tauri::command]
pub(crate) fn get_overlay_surface_state(
    state: State<'_, Mutex<OverlayRuntime>>,
) -> Result<OverlaySurfaceState, String> {
    state
        .lock()
        .map(|runtime| runtime.surface_state())
        .map_err(|_| "The capture overlay state is temporarily unavailable.".into())
}

#[tauri::command]
pub(crate) fn overlay_renderer_ready(
    app: AppHandle,
    _state: State<'_, Mutex<OverlayRuntime>>,
) -> Result<OverlayRendererReadySnapshot, String> {
    run_overlay_main_thread_transaction(&app, |main_app| overlay_renderer_ready_on_main(&main_app))?
}

fn overlay_renderer_ready_on_main(app: &AppHandle) -> Result<OverlayRendererReadySnapshot, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let state = app.state::<Mutex<OverlayRuntime>>();
    let mut runtime = state
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    renderer_ready_transition_with_clock(&mut runtime, &window, Instant::now)
}

pub(crate) fn overlay_renderer_page_load_started_on_main(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let state = app.state::<Mutex<OverlayRuntime>>();
    let mut runtime = state
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    renderer_page_load_started_transition_with_clock(&mut runtime, &window, Instant::now)
        .map(|_| ())
}

#[tauri::command]
pub(crate) fn overlay_dom_hidden_painted(
    app: AppHandle,
    _state: State<'_, Mutex<OverlayRuntime>>,
    surface_generation: u64,
) -> Result<bool, String> {
    run_overlay_main_thread_transaction(&app, move |main_app| {
        overlay_dom_hidden_painted_on_main(&main_app, surface_generation)
    })?
}

fn overlay_dom_hidden_painted_on_main(
    app: &AppHandle,
    surface_generation: u64,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let state = app.state::<Mutex<OverlayRuntime>>();
    let mut runtime = state
        .lock()
        .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
    match warm_hidden_transition(&mut runtime, &window, surface_generation) {
        WarmHiddenTransition::Stale => Ok(false),
        WarmHiddenTransition::AlreadyWarm | WarmHiddenTransition::Warmed => Ok(true),
        WarmHiddenTransition::Failed(error) => Err(format!(
            "Could not warm the hidden Quick Access surface: {error}"
        )),
    }
}

pub(crate) fn has_temporarily_hidden_capture<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Mutex<OverlayRuntime>>()
        .lock()
        .map(|runtime| runtime.temporarily_hidden && runtime.current.is_some())
        .unwrap_or(false)
}

pub(crate) fn has_logically_presented_capture<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Mutex<OverlayRuntime>>()
        .lock()
        .map(|runtime| runtime.presented.is_some())
        .unwrap_or(false)
}

fn hide_current_overlay_for_capture(
    app: &AppHandle,
) -> Result<Option<OverlayHiddenSurfaceIdentity>, String> {
    run_overlay_main_thread_transaction(app, |main_app| {
        hide_current_overlay_for_capture_on_main(&main_app)
    })?
}

fn hide_current_overlay_for_capture_on_main(
    app: &AppHandle,
) -> Result<Option<OverlayHiddenSurfaceIdentity>, String> {
    let (transition, identity, surface_generation) = {
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
        (transition, identity, runtime.surface_generation)
    };
    match transition {
        TemporaryHideTransition::Stale | TemporaryHideTransition::AlreadyHidden => Ok(None),
        TemporaryHideTransition::Hidden => {
            let hidden = OverlayHiddenSurfaceIdentity {
                path: identity.path,
                presentation_id: identity.presentation_id,
                surface_generation,
            };
            if let Err(error) = app.emit_to(
                OVERLAY_LABEL,
                "overlay-hidden",
                OverlayRestored {
                    path: &hidden.path,
                    presentation_id: hidden.presentation_id,
                    surface_generation: hidden.surface_generation,
                },
            ) {
                let rollback = restore_temporarily_hidden_overlay_surface_if_current(
                    app,
                    &hidden.path,
                    hidden.presentation_id,
                    hidden.surface_generation,
                )
                .err()
                .map(|restore_error| format!(" Restore also failed: {restore_error}"))
                .unwrap_or_default();
                return Err(format!(
                    "Could not pause the Quick Access timer before capture: {error}.{rollback}"
                ));
            }
            Ok(Some(hidden))
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
    _state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    surface_generation: u64,
) -> Result<bool, String> {
    run_overlay_main_thread_transaction(&app, move |main_app| {
        overlay_hide_temporarily_on_main(&main_app, path, presentation_id, Some(surface_generation))
    })?
}

fn overlay_hide_temporarily_on_main(
    app: &AppHandle,
    path: String,
    presentation_id: u64,
    surface_generation: Option<u64>,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let (transition, payload) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        let transition = match surface_generation {
            Some(surface_generation) => temporary_hide_transition_exact_with_clock(
                &mut runtime,
                &window,
                &path,
                presentation_id,
                surface_generation,
                Instant::now,
            ),
            None => temporary_hide_transition(&mut runtime, &window, &path, presentation_id),
        };
        let payload = runtime.current.clone();
        (transition, payload)
    };
    match transition {
        TemporaryHideTransition::Stale => Ok(false),
        TemporaryHideTransition::AlreadyHidden | TemporaryHideTransition::Hidden => {
            if let Some(capture) = payload {
                app.emit_to(
                    OVERLAY_LABEL,
                    "overlay-hidden",
                    OverlayRestored {
                        path: &capture.path,
                        presentation_id: capture.presentation_id,
                        surface_generation: capture.surface_generation,
                    },
                )
                .map_err(|error| format!("Could not publish hidden Quick Access state: {error}"))?;
            }
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
    surface_generation: u64,
    paused: bool,
) -> Result<bool, String> {
    let update = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        runtime.set_auto_dismiss_paused_exact(
            &path,
            presentation_id,
            surface_generation,
            paused,
            Instant::now(),
        )
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
    run_overlay_main_thread_transaction(app, |main_app| {
        restore_temporarily_hidden_overlay_on_main(&main_app)
    })?
}

fn restore_temporarily_hidden_overlay_on_main(app: &AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let (transition, schedules) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        restore_hidden_transition_without_resume(&mut runtime, &window)
    };
    finish_restore_transition(app, transition, schedules)
}

fn restore_temporarily_hidden_overlay_surface_if_current(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
) -> Result<bool, String> {
    let path = path.to_string();
    run_overlay_main_thread_transaction(app, move |main_app| {
        restore_temporarily_hidden_overlay_surface_if_current_on_main(
            &main_app,
            &path,
            presentation_id,
            surface_generation,
        )
    })?
}

fn restore_temporarily_hidden_overlay_surface_if_current_on_main(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
    surface_generation: u64,
) -> Result<bool, String> {
    let (transition, schedules) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        let window = app
            .get_webview_window(OVERLAY_LABEL)
            .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
        restore_exact_hidden_surface_transition_without_resume(
            &mut runtime,
            &window,
            path,
            presentation_id,
            surface_generation,
        )
    };
    finish_restore_transition(app, transition, schedules)
}

fn restore_temporarily_hidden_overlay_if_current_on_main(
    app: &AppHandle,
    path: &str,
    presentation_id: u64,
) -> Result<bool, String> {
    let (transition, schedules) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        let window = app
            .get_webview_window(OVERLAY_LABEL)
            .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
        restore_exact_hidden_transition_without_resume(&mut runtime, &window, path, presentation_id)
    };
    finish_restore_transition(app, transition, schedules)
}

fn finish_restore_transition(
    app: &AppHandle,
    transition: RestoreHiddenTransition,
    schedules: OverlayResumeSchedules,
) -> Result<bool, String> {
    debug_assert_eq!(schedules, OverlayResumeSchedules::default());
    match transition {
        RestoreHiddenTransition::Stale | RestoreHiddenTransition::NotHidden => Ok(false),
        RestoreHiddenTransition::Restored(capture) => {
            app.emit_to(
                OVERLAY_LABEL,
                "overlay-restored",
                OverlayRestored {
                    path: &capture.path,
                    presentation_id: capture.presentation_id,
                    surface_generation: capture.surface_generation,
                },
            )
            .map_err(|error| format!("Could not publish restored Quick Access state: {error}"))?;
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
    surface_generation: u64,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let (transition, watchdog) = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            &path,
            presentation_id,
            surface_generation,
            Instant::now,
        )
    };

    match transition {
        RevealTransition::Stale => Ok(false),
        RevealTransition::Hidden => Ok(false),
        RevealTransition::Shown(sample) => {
            if let Some(watchdog) = watchdog {
                spawn_overlay_paint_watchdog(&app, watchdog);
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
    }
}

#[tauri::command]
pub(crate) fn overlay_presentation_painted(
    app: AppHandle,
    _state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    surface_generation: u64,
    reduced_motion: bool,
) -> Result<bool, String> {
    run_overlay_main_thread_transaction(&app, move |main_app| {
        overlay_presentation_painted_on_main(
            &main_app,
            path,
            presentation_id,
            surface_generation,
            reduced_motion,
        )
    })?
}

fn overlay_presentation_painted_on_main(
    app: &AppHandle,
    path: String,
    presentation_id: u64,
    surface_generation: u64,
    reduced_motion: bool,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let presentation = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        present_painted_transition_exact_with_clock(
            &mut runtime,
            &window,
            &path,
            presentation_id,
            surface_generation,
            reduced_motion,
            Instant::now,
        )
    };
    let (acknowledgement, sample) = match presentation {
        Ok(presentation) => presentation,
        Err(failure) => {
            release_quick_access_capture(&app, Path::new(&path));
            report_overlay_failure(&app, &failure);
            return Err(failure.message);
        }
    };
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
    match acknowledgement {
        OverlayPaintAcknowledgement::Stale | OverlayPaintAcknowledgement::NotShown => Ok(false),
        OverlayPaintAcknowledgement::AlreadyArmed | OverlayPaintAcknowledgement::Paused => Ok(true),
        OverlayPaintAcknowledgement::Armed(schedule) => {
            spawn_overlay_auto_dismiss(&app, schedule);
            Ok(true)
        }
    }
}

#[tauri::command]
pub(crate) fn overlay_image_failed(
    app: AppHandle,
    _state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    surface_generation: u64,
) -> Result<bool, String> {
    run_overlay_main_thread_transaction(&app, move |main_app| {
        overlay_image_failed_on_main(&main_app, path, presentation_id, surface_generation)
    })?
}

fn overlay_image_failed_on_main(
    app: &AppHandle,
    path: String,
    presentation_id: u64,
    surface_generation: u64,
) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "The capture overlay window is unavailable.".to_string())?;
    let (failure, hard_hidden_generation) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        let failure = fail_transition_exact(
            &mut runtime,
            &window,
            &path,
            presentation_id,
            surface_generation,
            "overlay_decode_failed",
            "The saved capture could not be decoded for the overlay preview.",
        );
        (failure, runtime.surface_generation)
    };
    let Some(failure) = failure else {
        return Ok(false);
    };

    let dismissed = app.emit_to(
        OVERLAY_LABEL,
        "capture-overlay-dismissed",
        OverlayDismissed {
            path: &path,
            presentation_id,
            surface_generation: hard_hidden_generation,
            reason: DismissReason::Close,
        },
    );
    release_quick_access_capture(&app, Path::new(&path));
    report_overlay_failure(&app, &failure);
    dismissed
        .map_err(|error| format!("Could not publish failed Quick Access cleanup state: {error}"))?;
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
                        surface_generation: callback_identity.surface_generation,
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
    surface_generation: u64,
    filename: String,
) -> Result<OverlayDragStarted, String> {
    let _renderer_pause_lease =
        OverlayRendererPauseLease::acquire(&app, &path, presentation_id, surface_generation)?;
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
                    begin_drag_transition_exact_with_clock(
                        &mut runtime,
                        &path,
                        presentation_id,
                        surface_generation,
                        initial_gesture,
                        current_drag_gesture_state(),
                        Instant::now(),
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
        let _ = (app, path, presentation_id, surface_generation);
        Err("Capture drag-out is only available in the macOS app.".into())
    }
}

#[tauri::command]
pub(crate) fn overlay_dismiss(
    app: AppHandle,
    _state: State<'_, Mutex<OverlayRuntime>>,
    path: String,
    presentation_id: u64,
    surface_generation: u64,
    reason: DismissReason,
) -> Result<bool, String> {
    dismiss_overlay_exact(
        &app,
        path,
        presentation_id,
        reason,
        Some(surface_generation),
        None,
    )
}

fn dismiss_overlay_exact(
    app: &AppHandle,
    path: String,
    presentation_id: u64,
    reason: DismissReason,
    requested_surface_generation: Option<u64>,
    constraint: Option<OverlayDismissConstraint>,
) -> Result<bool, String> {
    run_overlay_main_thread_transaction(app, move |main_app| {
        dismiss_overlay_exact_on_main(
            &main_app,
            path,
            presentation_id,
            reason,
            requested_surface_generation,
            constraint,
        )
    })?
}

fn dismiss_overlay_exact_on_main(
    app: &AppHandle,
    path: String,
    presentation_id: u64,
    reason: DismissReason,
    requested_surface_generation: Option<u64>,
    constraint: Option<OverlayDismissConstraint>,
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
    let (transition, surface_generation) = {
        let state = app.state::<Mutex<OverlayRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "The capture overlay state is temporarily unavailable.".to_string())?;
        let transition = match constraint {
            Some(OverlayDismissConstraint::AutoDismiss(schedule)) => {
                dismiss_transition_for_auto_dismiss(
                    &mut runtime,
                    &window,
                    &schedule,
                    Instant::now(),
                )
            }
            Some(OverlayDismissConstraint::PendingPaint(schedule)) => {
                dismiss_transition_for_pending_paint(
                    &mut runtime,
                    &window,
                    &schedule,
                    Instant::now(),
                )
            }
            None => match requested_surface_generation {
                Some(surface_generation) => dismiss_transition_for_reason_exact(
                    &mut runtime,
                    &window,
                    &path,
                    presentation_id,
                    surface_generation,
                    reason,
                ),
                None => dismiss_transition_for_reason(
                    &mut runtime,
                    &window,
                    &path,
                    presentation_id,
                    reason,
                ),
            },
        };
        (transition, runtime.surface_generation)
    };

    match transition {
        DismissTransition::Stale | DismissTransition::Hidden => Ok(false),
        DismissTransition::Dismissed => {
            release_quick_access_capture(app, Path::new(&path));
            let _ = app.emit_to(
                OVERLAY_LABEL,
                "capture-overlay-dismissed",
                OverlayDismissed {
                    path: &path,
                    presentation_id,
                    surface_generation,
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
        acknowledge_painted_presentation, annotation_refresh_payload, begin_drag_transition,
        begin_drag_transition_exact_with_clock, begin_drag_transition_with_clock,
        bottom_right_position, capture_display, capture_matches, current_capture_path,
        current_capture_project_path, dismiss_transition, dismiss_transition_for_auto_dismiss,
        dismiss_transition_for_pending_paint, dismiss_transition_for_reason,
        dismiss_transition_for_reason_exact, dispatch_acknowledged_main_thread_transaction,
        display_at_cursor, display_profile_ids, export_capture, export_png_bytes, fail_transition,
        fail_transition_exact, finish_drag_transition_with_clock, load_stored_overlay_settings,
        prepare_transition, present_painted_transition_exact_with_clock,
        present_painted_transition_with_clock, release_renderer_auto_dismiss_pause_with_clock,
        renderer_ready_transition_with_clock, restore_exact_hidden_transition,
        restore_hidden_transition, restore_hidden_transition_without_resume, reveal_transition,
        reveal_transition_and_begin_paint_exact_with_clock,
        reveal_transition_and_begin_paint_with_clock, reveal_transition_with_clock,
        save_stored_overlay_settings, settings_for_display, temporary_hide_transition,
        temporary_hide_transition_exact_with_clock, temporary_hide_transition_with_clock,
        update_stored_preferences, validate_save_as_preferences, warm_hidden_transition,
        CaptureExportFormat, DismissReason, DismissTransition, DisplayGeometry, DragGestureState,
        OverlayAutoDismiss, OverlayAutoDismissSchedule, OverlayAutoDismissUpdate, OverlayCapture,
        OverlayDismissed, OverlayDragEnded, OverlayDragOutcome, OverlayPaintAcknowledgement,
        OverlayPlacement, OverlayPreferences, OverlayQuickActions, OverlayRestored,
        OverlayResumeSchedules, OverlayRuntime, OverlaySaveAsPreferences, OverlaySize,
        OverlaySource, OverlayWindowOps, RestoreHiddenTransition, RevealTransition, ScreenPoint,
        ScreenRect, StoredOverlaySettings, TemporaryHideTransition, OVERLAY_HEIGHT_LOGICAL,
        OVERLAY_LABEL, OVERLAY_PAINT_ACK_TIMEOUT, OVERLAY_WIDTH_LOGICAL,
    };

    #[test]
    fn parked_native_panel_conceals_content_without_lowering_window_alpha() {
        let implementation = include_str!("overlay.rs");
        let parking = implementation
            .split("fn park_native_overlay")
            .nth(1)
            .and_then(|tail| tail.split("fn warm_native_overlay").next())
            .expect("native parking remains explicit");

        assert!(parking.contains(".contentView()"));
        assert!(parking.contains("content.setAlphaValue(0.0)"));
        assert!(parking.contains("window.setAlphaValue(1.0)"));
    }

    #[test]
    fn renderer_lifecycle_commands_require_an_exact_surface_generation() {
        let implementation = include_str!("overlay.rs");
        for command in [
            "pub(crate) fn overlay_hide_temporarily(",
            "pub(crate) fn overlay_set_auto_dismiss_paused(",
            "pub(crate) fn overlay_image_failed(",
            "pub(crate) async fn overlay_start_drag(",
            "pub(crate) fn overlay_dismiss(",
        ] {
            let body = implementation
                .split(command)
                .nth(1)
                .and_then(|tail| tail.split("#[tauri::command]").next())
                .unwrap_or_else(|| panic!("{command} remains a registered command"));
            assert!(
                body.contains("surface_generation: u64"),
                "{command} must validate the exact renderer surface"
            );
        }

        let pause_drop = implementation
            .split("impl Drop for OverlayRendererPauseLease")
            .nth(1)
            .and_then(|tail| tail.split("struct OverlayDragIdentity").next())
            .expect("renderer pause cleanup remains explicit");
        assert!(pause_drop.contains("release_renderer_auto_dismiss_pause_exact_with_clock"));
        assert!(pause_drop.contains("self.surface_generation"));
    }

    #[test]
    fn accepted_image_failure_publishes_targeted_hard_hidden_cleanup() {
        let implementation = include_str!("overlay.rs");
        let failure_command = implementation
            .split("fn overlay_image_failed_on_main")
            .nth(1)
            .and_then(|tail| tail.split("#[tauri::command]").next())
            .expect("image failure command remains explicit");

        assert!(failure_command.contains("capture-overlay-dismissed"));
        assert!(failure_command.contains("OverlayDismissed"));
        assert!(failure_command.contains("surface_generation"));
        assert!(failure_command.contains("DismissReason::Close"));
    }

    #[test]
    fn capture_overlay_lease_restores_only_its_owned_hidden_surface() {
        let implementation = include_str!("overlay.rs");
        let lease = implementation
            .split("pub(crate) struct CaptureOverlayLease")
            .nth(1)
            .and_then(|tail| tail.split("struct OverlayRendererPauseLease").next())
            .expect("capture overlay lease remains explicit");

        assert!(lease.contains("OverlayHiddenSurfaceIdentity"));
        assert!(lease.contains("hidden.surface_generation"));
        assert!(lease.contains("restore_temporarily_hidden_overlay_surface_if_current"));
    }

    #[test]
    fn native_panel_hides_accessibility_before_parking_and_restores_it_before_input() {
        let implementation = include_str!("overlay.rs");
        let parking = implementation
            .split("fn park_native_overlay")
            .nth(1)
            .and_then(|tail| tail.split("fn warm_native_overlay").next())
            .expect("native parking remains explicit");
        let ignore_pointer = parking
            .find("window.setIgnoresMouseEvents(true)")
            .expect("parking must reject input first");
        let hide_accessibility = parking
            .find("content.setAccessibilityHidden(true)")
            .expect("parked content must leave the accessibility tree");
        let hide_pixels = parking
            .find("content.setAlphaValue(0.0)")
            .expect("parking must conceal the pixels");
        assert!(ignore_pointer < hide_accessibility && hide_accessibility < hide_pixels);

        let presentation = implementation
            .split("fn present_native_overlay")
            .nth(1)
            .and_then(|tail| tail.split("trait OverlayWindowOps").next())
            .expect("native presentation remains explicit");
        let show_pixels = presentation
            .find("content.setAlphaValue(1.0)")
            .expect("presentation must reveal pixels");
        let show_accessibility = presentation
            .find("content.setAccessibilityHidden(false)")
            .expect("presented content must return to the accessibility tree");
        let flush_pixels = presentation
            .find("CATransaction::flush()")
            .expect("presented pixels must reach the compositor before input");
        let accept_pointer = presentation
            .find("window.setIgnoresMouseEvents(false)")
            .expect("presentation must accept input last");
        assert!(
            show_pixels < show_accessibility
                && show_accessibility < flush_pixels
                && flush_pixels < accept_pointer
        );
    }

    #[test]
    fn native_panel_flushes_each_content_visibility_change_before_returning() {
        let implementation = include_str!("overlay.rs");
        let parking = implementation
            .split("fn park_native_overlay")
            .nth(1)
            .and_then(|tail| tail.split("fn warm_native_overlay").next())
            .expect("native parking remains explicit");
        let hide_pixels = parking
            .find("content.setAlphaValue(0.0)")
            .expect("parking must conceal pixels");
        let park_flush = parking
            .find("CATransaction::flush()")
            .expect("parking must commit the Core Animation transaction");
        assert!(hide_pixels < park_flush);

        let presentation = implementation
            .split("fn present_native_overlay")
            .nth(1)
            .and_then(|tail| tail.split("trait OverlayWindowOps").next())
            .expect("native presentation remains explicit");
        let show_pixels = presentation
            .find("content.setAlphaValue(1.0)")
            .expect("presentation must reveal pixels");
        let present_flush = presentation
            .find("CATransaction::flush()")
            .expect("presentation must commit the Core Animation transaction");
        assert!(show_pixels < present_flush);
    }

    #[test]
    fn native_warm_surface_exposes_pixels_only_to_the_hidden_renderer() {
        let implementation = include_str!("overlay.rs");
        let warming = implementation
            .split("fn warm_native_overlay")
            .nth(1)
            .and_then(|tail| tail.split("fn present_native_overlay").next())
            .expect("native warming remains a distinct phase");
        let ignore_pointer = warming
            .find("window.setIgnoresMouseEvents(true)")
            .expect("warm surface remains click-through");
        let hide_accessibility = warming
            .find("content.setAccessibilityHidden(true)")
            .expect("warm surface remains outside accessibility");
        let warm_pixels = warming
            .find("content.setAlphaValue(1.0)")
            .expect("renderer surface is composited after hidden DOM paint");
        let flush = warming
            .find("CATransaction::flush()")
            .expect("warm surface is committed synchronously");
        assert!(ignore_pointer < hide_accessibility);
        assert!(hide_accessibility < warm_pixels);
        assert!(warm_pixels < flush);
        assert!(!warming.contains("content.setAccessibilityHidden(false)"));
        assert!(!warming.contains("window.setIgnoresMouseEvents(false)"));
    }

    #[test]
    fn warm_panel_conceals_content_before_tauri_marks_the_window_visible() {
        let implementation = include_str!("overlay.rs");
        let initializer = implementation
            .split("pub(crate) fn initialize_warm_overlay")
            .nth(1)
            .and_then(|tail| tail.split("enum RevealTransition").next())
            .expect("warm overlay initializer remains explicit");
        let show = initializer
            .find(".show()")
            .expect("Tauri must mark the webview visible once at startup");
        let first_park = initializer
            .find("park_overlay()")
            .expect("the webview must be concealed before its first show");
        let final_park = initializer
            .rfind("park_overlay()")
            .expect("the visible webview must remain parked click-through");
        assert!(first_park < show && show < final_park);
    }

    #[test]
    fn native_entrance_commits_visible_alpha_without_a_deferred_window_animator() {
        let implementation = include_str!("overlay.rs");
        let presentation = implementation
            .split("fn present_native_overlay")
            .nth(1)
            .and_then(|tail| tail.split("trait OverlayWindowOps").next())
            .expect("native presentation remains explicit");
        let visible = presentation
            .find("window.setAlphaValue(1.0)")
            .expect("the panel must become synchronously visible");
        let reordered = presentation[visible..]
            .find("window.orderFrontRegardless()")
            .map(|offset| visible + offset)
            .expect("visible alpha must be flushed through WindowServer");

        assert!(visible < reordered);
        assert!(presentation.contains(".contentView()"));
        assert!(presentation.contains("content.setAlphaValue(1.0)"));
        assert!(
            !presentation.contains("window.setAlphaValue(0.0)"),
            "alpha zero makes WindowServer defer the otherwise-ready panel"
        );
        assert!(!presentation.contains("NSAnimationContext"));
        assert!(!presentation.contains(".animator()"));
        assert!(!presentation.contains("setFrameOrigin"));
    }

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
        fn park_overlay(&self) -> Result<(), String> {
            self.transitions.borrow_mut().push("park");
            if self.fail_hide.get() {
                return Err("native hide rejected".into());
            }
            self.visible.set(false);
            Ok(())
        }

        fn present_overlay(&self, reduced_motion: bool) -> Result<(), String> {
            self.transitions.borrow_mut().push(if reduced_motion {
                "present_reduced"
            } else {
                "present"
            });
            if self.fail_show.get() {
                return Err("native show rejected".into());
            }
            self.visible.set(true);
            Ok(())
        }

        fn warm_overlay(&self) -> Result<(), String> {
            self.transitions.borrow_mut().push("warm");
            if self.fail_show.get() {
                return Err("native warm rejected".into());
            }
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
            surface_generation: 0,
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

    fn commit_hidden_dom_for_fixture(runtime: &mut OverlayRuntime) {
        assert_eq!(
            runtime.surface_phase,
            super::OverlaySurfacePhase::HardHidden
        );
        runtime.surface_phase = super::OverlaySurfacePhase::WarmHidden;
    }

    fn shown_pending_paint(
        path: &str,
        presentation_id: u64,
        start: std::time::Instant,
    ) -> (
        OverlayRuntime,
        FakeWindow,
        super::OverlayPendingPaintSchedule,
    ) {
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id(path, presentation_id));
        commit_hidden_dom_for_fixture(&mut runtime);
        let (shown, watchdog) = reveal_transition_and_begin_paint_with_clock(
            &mut runtime,
            &window,
            path,
            presentation_id,
            || start,
        );
        assert_eq!(shown, RevealTransition::Shown(None));
        let watchdog = watchdog.expect("exact pending-paint watchdog");
        assert_eq!(watchdog.deadline, start + OVERLAY_PAINT_ACK_TIMEOUT,);
        assert!(runtime.auto_dismiss_clock.is_none());
        (runtime, window, watchdog)
    }

    fn revealed_clock(
        path: &str,
        presentation_id: u64,
        start: std::time::Instant,
    ) -> (OverlayRuntime, FakeWindow, OverlayAutoDismissSchedule) {
        let (mut runtime, window, _) = shown_pending_paint(path, presentation_id, start);
        let OverlayPaintAcknowledgement::Armed(schedule) =
            acknowledge_painted_presentation(&mut runtime, path, presentation_id, start)
        else {
            panic!("first exact paint acknowledgement arms the native clock");
        };
        assert_eq!(schedule.deadline, at(start, 10));
        (runtime, window, schedule)
    }

    #[test]
    fn image_ready_starts_only_the_paint_watchdog_while_the_window_stays_parked() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (runtime, window, watchdog) = shown_pending_paint(path, 1, start);
        assert!(runtime.auto_dismiss_clock.is_none());
        assert_eq!(watchdog.deadline, start + OVERLAY_PAINT_ACK_TIMEOUT);
        assert!(!window.visible.get());
        assert!(window.transitions.borrow().is_empty());
    }

    #[test]
    fn exact_paint_ack_presents_before_starting_the_visible_clock() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);

        let (acknowledgement, sample) =
            present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || {
                window.transitions.borrow_mut().push("clock");
                at(start, 5)
            })
            .expect("exact paint presents");

        assert!(sample.is_none());
        let OverlayPaintAcknowledgement::Armed(schedule) = acknowledgement else {
            panic!("first painted frame arms the native clock");
        };
        assert_eq!(schedule.deadline, at(start, 15));
        assert!(window.visible.get());
        assert_eq!(*window.transitions.borrow(), vec!["present", "clock"]);
    }

    #[test]
    fn reduced_motion_presents_immediately_without_the_entrance_animation() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);

        present_painted_transition_with_clock(&mut runtime, &window, path, 1, true, || start)
            .expect("reduced-motion presentation");

        assert_eq!(*window.transitions.borrow(), vec!["present_reduced"]);
        assert!(window.visible.get());
    }

    #[test]
    fn native_overlay_never_dispatches_to_main_from_inside_a_runtime_transition() {
        let implementation = include_str!("overlay.rs");
        let forbidden_inner_dispatch = ["fn run_acknowledged", "_overlay_window_mutation"].concat();
        let native_mutation = implementation
            .split("fn mutate_native_overlay_window")
            .nth(1)
            .and_then(|tail| tail.split("fn park_native_overlay").next())
            .expect("native window mutation helper remains explicit");

        assert!(
            !implementation.contains(&forbidden_inner_dispatch),
            "a runtime transition must not hold OverlayRuntime while waiting for main"
        );
        assert!(native_mutation.contains("MainThreadMarker::new"));
        assert!(
            !native_mutation.contains("run_on_main_thread"),
            "native mutation must fail fast off-main instead of dispatching while a lock may exist"
        );
        assert!(implementation.contains("fn run_overlay_main_thread_transaction"));
    }

    #[test]
    fn background_main_transaction_dispatches_before_it_can_lock_runtime() {
        let runtime = std::sync::Arc::new(std::sync::Mutex::new(()));
        let worker_runtime = runtime.clone();
        let (task_sender, task_receiver) =
            std::sync::mpsc::sync_channel::<super::OverlayMainThreadTask>(1);

        let worker = std::thread::spawn(move || {
            dispatch_acknowledged_main_thread_transaction(
                |task| {
                    task_sender
                        .send(task)
                        .map_err(|_| "main transaction receiver stopped".to_string())
                },
                move || {
                    let _runtime = worker_runtime.lock().expect("runtime lock");
                    42
                },
            )
        });

        let task = task_receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("background worker dispatches without owning runtime");
        let main_runtime = runtime
            .try_lock()
            .expect("main can inspect runtime before executing the transaction");
        drop(main_runtime);
        task();

        assert_eq!(
            worker.join().expect("worker joins").expect("transaction"),
            42
        );
    }

    #[test]
    fn prepare_parks_the_warm_window_before_replacing_its_presentation() {
        let window = FakeWindow::default();
        window.visible.set(true);
        let mut runtime = OverlayRuntime::default();

        prepare_transition(
            &mut runtime,
            &window,
            capture("/tmp/capso/current.png"),
            None,
            304,
            194,
            120,
            240,
        )
        .expect("warm preview parks and prepares");

        assert!(!window.visible.get());
        assert_eq!(
            *window.transitions.borrow(),
            vec!["park", "size", "position"]
        );
    }

    #[test]
    fn restoring_an_unpainted_capture_keeps_the_warm_window_parked() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);

        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 2)),
            TemporaryHideTransition::Hidden,
        );
        let (restored, schedules) = restore_hidden_transition_without_resume(&mut runtime, &window);

        assert!(matches!(restored, RestoreHiddenTransition::Restored(_)));
        assert!(!window.visible.get());
        assert_eq!(*window.transitions.borrow(), vec!["park", "park"]);
        assert_eq!(schedules, OverlayResumeSchedules::default());
        assert_eq!(
            runtime.surface_phase,
            super::OverlaySurfacePhase::HardHidden
        );
    }

    #[test]
    fn first_exact_paint_ack_arms_ten_seconds_and_duplicates_do_not_extend_it() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, _, _) = shown_pending_paint(path, 1, start);
        let OverlayPaintAcknowledgement::Armed(schedule) =
            acknowledge_painted_presentation(&mut runtime, path, 1, at(start, 5))
        else {
            panic!("first paint acknowledgement arms");
        };
        assert_eq!(schedule.after, std::time::Duration::from_secs(10));
        assert_eq!(schedule.deadline, at(start, 15));
        assert_eq!(
            acknowledge_painted_presentation(&mut runtime, path, 1, at(start, 9)),
            OverlayPaintAcknowledgement::AlreadyArmed,
        );
        assert_eq!(
            runtime
                .auto_dismiss_clock
                .as_ref()
                .and_then(|clock| clock.deadline),
            Some(at(start, 15)),
        );
    }

    #[test]
    fn stale_paint_ack_and_watchdog_cannot_mutate_a_replacement() {
        let path = "/tmp/capso/repeated.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, old_watchdog) = shown_pending_paint(path, 1, start);
        runtime.replace(capture_with_id(path, 2));
        let (acknowledgement, sample) =
            present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || {
                at(start, 5)
            })
            .expect("stale presentation is a harmless no-op");
        assert_eq!(acknowledgement, OverlayPaintAcknowledgement::Stale);
        assert!(sample.is_none());
        assert!(!window.visible.get());
        assert!(window.transitions.borrow().is_empty());
        assert!(runtime.presented.is_none());
        assert_eq!(
            dismiss_transition_for_pending_paint(
                &mut runtime,
                &window,
                &old_watchdog,
                start + OVERLAY_PAINT_ACK_TIMEOUT,
            ),
            DismissTransition::Stale,
        );
        assert!(runtime
            .current
            .is_some_and(|capture| capture.presentation_id == 2));
    }

    #[test]
    fn pauses_acquired_before_paint_transfer_to_the_native_clock() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, _, _) = shown_pending_paint(path, 1, start);
        assert_eq!(
            runtime.set_auto_dismiss_paused(path, 1, true, at(start, 1)),
            OverlayAutoDismissUpdate::Paused,
        );
        assert_eq!(
            acknowledge_painted_presentation(&mut runtime, path, 1, at(start, 5)),
            OverlayPaintAcknowledgement::Paused,
        );
        let OverlayAutoDismissUpdate::Resumed(schedule) =
            runtime.set_auto_dismiss_paused(path, 1, false, at(start, 20))
        else {
            panic!("the last pre-paint owner resumes the transferred clock");
        };
        assert_eq!(schedule.after, std::time::Duration::from_secs(10));
        assert_eq!(schedule.deadline, at(start, 30));
    }

    #[test]
    fn active_drag_acquired_before_paint_transfers_until_exact_drag_completion() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, _, _) = shown_pending_paint(path, 1, start);
        let pressed = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 7,
        };
        let identity =
            begin_drag_transition_with_clock(&mut runtime, path, 1, pressed, pressed, at(start, 1))
                .expect("exact pending presentation owns the drag pause");
        assert_eq!(
            acknowledge_painted_presentation(&mut runtime, path, 1, at(start, 2)),
            OverlayPaintAcknowledgement::Paused,
        );
        let (finished, schedule) =
            finish_drag_transition_with_clock(&mut runtime, &identity, at(start, 20));
        assert!(finished);
        let schedule = schedule.expect("drag completion starts the full visible lifetime");
        assert_eq!(schedule.after, std::time::Duration::from_secs(10));
        assert_eq!(schedule.deadline, at(start, 30));
    }

    #[test]
    fn renderer_pause_cannot_make_an_unpainted_window_immortal() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, watchdog) = shown_pending_paint(path, 1, start);
        assert_eq!(
            runtime.set_auto_dismiss_paused(path, 1, true, at(start, 1)),
            OverlayAutoDismissUpdate::Paused,
        );
        assert_eq!(
            dismiss_transition_for_pending_paint(
                &mut runtime,
                &window,
                &watchdog,
                start + OVERLAY_PAINT_ACK_TIMEOUT,
            ),
            DismissTransition::Dismissed,
        );
        assert!(runtime.current.is_none());
    }

    #[test]
    fn pending_paint_watchdog_is_bounded_and_temporary_hide_replaces_it_exactly() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, first_watchdog) = shown_pending_paint(path, 1, start);
        assert_eq!(
            dismiss_transition_for_pending_paint(
                &mut runtime,
                &window,
                &first_watchdog,
                start + OVERLAY_PAINT_ACK_TIMEOUT - std::time::Duration::from_millis(1),
            ),
            DismissTransition::Stale,
        );
        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 2)),
            TemporaryHideTransition::Hidden,
        );
        assert_eq!(
            dismiss_transition_for_pending_paint(
                &mut runtime,
                &window,
                &first_watchdog,
                start + OVERLAY_PAINT_ACK_TIMEOUT,
            ),
            DismissTransition::Stale,
        );
        let (_, schedules) = restore_hidden_transition_without_resume(&mut runtime, &window);
        assert_eq!(schedules, OverlayResumeSchedules::default());
        let restored_generation = runtime.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        let (_, resumed_watchdog) = reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            || at(start, 30),
        );
        let resumed_watchdog = resumed_watchdog.expect("restore creates a fresh exact watchdog");
        assert_eq!(resumed_watchdog.after, OVERLAY_PAINT_ACK_TIMEOUT);
        assert_eq!(
            dismiss_transition_for_pending_paint(
                &mut runtime,
                &window,
                &resumed_watchdog,
                resumed_watchdog.deadline,
            ),
            DismissTransition::Dismissed,
        );
    }

    #[test]
    fn paint_ack_while_temporarily_hidden_is_rejected_until_exact_restore_paints() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 2)),
            TemporaryHideTransition::Hidden,
        );
        assert_eq!(
            acknowledge_painted_presentation(&mut runtime, path, 1, at(start, 3)),
            OverlayPaintAcknowledgement::NotShown,
        );
        let (_, schedules) = restore_hidden_transition_without_resume(&mut runtime, &window);
        assert_eq!(schedules, OverlayResumeSchedules::default());
        let restored_generation = runtime.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        assert!(reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            || at(start, 30),
        )
        .1
        .is_some());
        let (OverlayPaintAcknowledgement::Armed(schedule), _) =
            present_painted_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                restored_generation,
                true,
                || at(start, 30),
            )
            .expect("restored paint activates")
        else {
            panic!("restored exact paint arms the clock");
        };
        assert_eq!(schedule.after, std::time::Duration::from_secs(10));
        assert_eq!(schedule.deadline, at(start, 40));
    }

    #[test]
    fn pending_paint_is_invalidated_by_decode_failure() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        assert!(fail_transition(
            &mut runtime,
            &window,
            path,
            1,
            "overlay_decode_failed",
            "decode failed",
        )
        .is_some());
        assert!(runtime.pending_paint.is_none());
    }

    #[test]
    fn paint_ack_after_a_hidden_unarmed_restore_still_owns_the_clock_start() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let window = FakeWindow::default();

        let mut hidden_runtime = OverlayRuntime::default();
        hidden_runtime.replace(capture(path));
        assert_eq!(
            temporary_hide_transition_with_clock(&mut hidden_runtime, &window, path, 1, || at(
                start, 1
            )),
            TemporaryHideTransition::Hidden
        );
        let (_, restored_schedules) =
            restore_hidden_transition_without_resume(&mut hidden_runtime, &window);
        assert_eq!(restored_schedules, super::OverlayResumeSchedules::default());
        let restored_generation = hidden_runtime.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut hidden_runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        let (shown, watchdog) = reveal_transition_and_begin_paint_with_clock(
            &mut hidden_runtime,
            &window,
            path,
            1,
            || at(start, 25),
        );
        assert_eq!(shown, RevealTransition::Shown(None));
        assert!(watchdog.is_some());
        let OverlayPaintAcknowledgement::Armed(schedule) =
            acknowledge_painted_presentation(&mut hidden_runtime, path, 1, at(start, 26))
        else {
            panic!("restored decoded paint arms");
        };
        assert_eq!(schedule.deadline, at(start, 36));
    }

    #[test]
    fn pending_paint_deadline_is_sampled_while_the_native_panel_stays_parked() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let shown_at = at(start, 5);
        let window = FakeWindow::default();
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture(path));
        commit_hidden_dom_for_fixture(&mut runtime);

        let (shown, schedule) =
            reveal_transition_and_begin_paint_with_clock(&mut runtime, &window, path, 1, || {
                window.transitions.borrow_mut().push("clock");
                shown_at
            });

        assert_eq!(shown, RevealTransition::Shown(None));
        assert_eq!(*window.transitions.borrow(), vec!["clock"]);
        assert_eq!(
            schedule.expect("shown presentation clock").deadline,
            shown_at + OVERLAY_PAINT_ACK_TIMEOUT,
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
        let (_, native_schedule) = restore_hidden_transition_without_resume(&mut runtime, &window);
        assert_eq!(native_schedule, OverlayResumeSchedules::default());
        assert_eq!(
            runtime.set_auto_dismiss_paused(path, 1, false, at(start, 40)),
            OverlayAutoDismissUpdate::Unchanged,
            "the old renderer pause is abandoned while hidden paint still owns its pause"
        );
        let restored_generation = runtime.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        assert!(reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            || at(start, 40),
        )
        .1
        .is_some());
        let (OverlayPaintAcknowledgement::Armed(resumed), _) =
            present_painted_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                restored_generation,
                true,
                || at(start, 40),
            )
            .expect("exact restore paint resumes")
        else {
            panic!("last hidden-paint owner resumes");
        };
        assert_eq!(resumed.after, std::time::Duration::from_secs(8));
        assert_ne!(resumed.generation, first.generation);
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &first, at(start, 10)),
            DismissTransition::Stale
        );
    }

    #[test]
    fn restored_paint_transfers_renderer_pause_to_the_existing_visible_clock() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = revealed_clock(path, 1, start);
        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 2)),
            TemporaryHideTransition::Hidden
        );
        let (_, schedules) = restore_hidden_transition_without_resume(&mut runtime, &window);
        assert_eq!(schedules, OverlayResumeSchedules::default());
        let restored_generation = runtime.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        assert!(reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            || at(start, 20),
        )
        .1
        .is_some());
        assert_eq!(
            runtime.set_auto_dismiss_paused(path, 1, true, at(start, 21)),
            OverlayAutoDismissUpdate::Paused
        );
        let (acknowledgement, _) = present_painted_transition_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            true,
            || at(start, 22),
        )
        .expect("restored paint activates while renderer remains paused");
        assert_eq!(acknowledgement, OverlayPaintAcknowledgement::Paused);
        let OverlayAutoDismissUpdate::Resumed(schedule) =
            runtime.set_auto_dismiss_paused(path, 1, false, at(start, 30))
        else {
            panic!("renderer releases the last pause after restored paint");
        };
        assert_eq!(schedule.after, std::time::Duration::from_secs(8));
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
        let (_, restore_schedule) = restore_hidden_transition_without_resume(&mut runtime, &window);
        assert_eq!(restore_schedule, OverlayResumeSchedules::default());
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &first, at(start, 10)),
            DismissTransition::Stale
        );
        let (finished, resumed) =
            finish_drag_transition_with_clock(&mut runtime, &identity, at(start, 30));
        assert!(!finished, "the hidden surface abandoned its old drag");
        assert!(resumed.is_none());
        let restored_generation = runtime.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        assert!(reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            || at(start, 30),
        )
        .1
        .is_some());
        let (OverlayPaintAcknowledgement::Armed(resumed), _) =
            present_painted_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                restored_generation,
                true,
                || at(start, 30),
            )
            .expect("exact restored paint resumes")
        else {
            panic!("restored paint is the last pause owner");
        };
        assert_eq!(resumed.after, std::time::Duration::from_secs(8));
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
        let (_, watchdog) =
            reveal_transition_and_begin_paint_with_clock(&mut runtime, &window, path, 2, || start);
        assert!(watchdog.is_some());
        let OverlayPaintAcknowledgement::Armed(replacement) =
            acknowledge_painted_presentation(&mut runtime, path, 2, start)
        else {
            panic!("replacement paint arms its exact clock");
        };
        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &replacement, at(start, 10),),
            DismissTransition::Dismissed
        );
        assert!(!runtime.finish_drag(&old_drag));
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
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        let (acknowledgement, _) =
            present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || start)
                .expect("painted preview presents");
        assert!(matches!(
            acknowledgement,
            OverlayPaintAcknowledgement::Armed(_)
        ));
        assert!(window.visible.get());

        assert_eq!(
            temporary_hide_transition(&mut runtime, &window, path, 1),
            TemporaryHideTransition::Hidden
        );
        assert!(!window.visible.get());
        assert!(runtime.temporarily_hidden);
        let hidden = runtime.current.as_ref().expect("capture remains current");
        assert_eq!(hidden.path, path);
        assert!(hidden.temporarily_hidden);
        let hidden_generation = hidden.surface_generation;
        let restored = restore_hidden_transition(&mut runtime, &window);
        let RestoreHiddenTransition::Restored(restored_capture) = restored else {
            panic!("exact capture begins its restored surface");
        };
        assert_eq!(restored_capture.path, path);
        assert!(restored_capture.surface_generation > hidden_generation);
        assert!(!window.visible.get());
        assert_eq!(
            *window.transitions.borrow(),
            vec!["present", "park", "park"]
        );
        assert!(!runtime.temporarily_hidden);
        assert_eq!(
            runtime.surface_phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert_eq!(runtime.current, Some(restored_capture));
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
            surface_generation: 0,
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
            surface_generation: 0,
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
    fn only_the_exact_native_paint_presentation_finishes_overlay_latency() {
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
        commit_hidden_dom_for_fixture(&mut runtime);

        assert_eq!(
            reveal_transition_with_clock(&mut runtime, &window, path, 2, || visible_at),
            RevealTransition::Stale
        );
        let (ready, watchdog) =
            reveal_transition_and_begin_paint_with_clock(&mut runtime, &window, path, 1, || {
                started_at + std::time::Duration::from_millis(100)
            });
        assert_eq!(ready, RevealTransition::Shown(None));
        assert!(watchdog.is_some());

        let (acknowledgement, sample) =
            present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || {
                visible_at
            })
            .expect("exact painted presentation");
        assert!(matches!(
            acknowledgement,
            OverlayPaintAcknowledgement::Armed(_)
        ));
        assert_eq!(
            sample,
            Some(crate::latency::OverlayLatencySample::new(
                CaptureMode::Region,
                742,
            ))
        );

        let (duplicate, duplicate_sample) =
            present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || {
                visible_at + std::time::Duration::from_secs(1)
            })
            .expect("duplicate exact acknowledgement is harmless");
        assert_eq!(duplicate, OverlayPaintAcknowledgement::AlreadyArmed);
        assert!(duplicate_sample.is_none());
        assert_eq!(
            window
                .transitions
                .borrow()
                .iter()
                .filter(|transition| **transition == "present")
                .count(),
            1,
            "one presentation contributes at most one native reveal"
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
            surface_generation: 0,
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
        commit_hidden_dom_for_fixture(&mut history_runtime);
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
    fn capture_replacement_abandons_the_old_surface_drag() {
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
        assert!(!runtime.finish_drag(&old_drag));

        let new_drag = runtime
            .begin_drag(new_path, 8)
            .expect("new capture drag is not blocked by the abandoned surface");
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
            surface_generation: 41,
            outcome: OverlayDragOutcome::Dropped,
        };

        let serialized = serde_json::to_value(event).expect("serialize drag completion");
        assert_eq!(serialized["path"], "/tmp/capso/current.png");
        assert_eq!(serialized["presentationId"], 12);
        assert_eq!(serialized["outcome"], "dropped");
        assert_eq!(serialized["surfaceGeneration"], 41);
    }

    #[test]
    fn restored_overlay_payload_is_explicit_and_does_not_claim_clipboard_copy() {
        let restored = OverlayCapture {
            path: "/tmp/capso/history.png".into(),
            presentation_id: 7,
            surface_generation: 0,
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
                "surfaceGeneration": 0,
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
        commit_hidden_dom_for_fixture(&mut runtime);
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
        let prepared = runtime.current.as_ref().expect("new capture is current");
        assert_eq!(prepared.path, new_path);
        assert_eq!(prepared.presentation_id, 1);
        assert_eq!(prepared.surface_generation, 1);

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
        commit_hidden_dom_for_fixture(&mut runtime);
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
        commit_hidden_dom_for_fixture(&mut runtime);
        assert_eq!(
            reveal_transition_and_begin_paint_with_clock(
                &mut runtime,
                &window,
                new_path,
                1,
                std::time::Instant::now,
            )
            .0,
            RevealTransition::Shown(None)
        );
        present_painted_transition_with_clock(
            &mut runtime,
            &window,
            new_path,
            1,
            false,
            std::time::Instant::now,
        )
        .expect("new painted preview presents");
        assert!(window.visible.get());

        // If the new preview is already current and visible, the stale old
        // failure cannot clear it or hide its window.
        let (mut runtime, window, _) = shown_pending_paint(new_path, 1, std::time::Instant::now());
        present_painted_transition_with_clock(
            &mut runtime,
            &window,
            new_path,
            1,
            false,
            std::time::Instant::now,
        )
        .expect("new painted preview presents");
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
    fn native_presentation_failure_clears_and_reparks_the_exact_preview() {
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
        commit_hidden_dom_for_fixture(&mut runtime);

        let (ready, watchdog) = reveal_transition_and_begin_paint_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            std::time::Instant::now,
        );
        assert_eq!(ready, RevealTransition::Shown(None));
        assert!(watchdog.is_some());
        let failure = present_painted_transition_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            false,
            std::time::Instant::now,
        )
        .expect_err("native presentation failure must be reported");

        assert_eq!(failure.code, "overlay_show_failed");
        assert!(failure.message.contains("native show rejected"));
        assert!(runtime.current.is_none());
        assert!(runtime.pending_latency.is_none());
        assert_eq!(runtime.last_failure, Some(failure));
        assert!(!window.visible.get());
        assert_eq!(
            *window.transitions.borrow(),
            vec!["park", "size", "position", "present", "park"]
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
        assert_eq!(*window.transitions.borrow(), vec!["park"]);
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
    fn startup_surface_requires_the_exact_hidden_dom_paint_before_warming() {
        let mut runtime = OverlayRuntime::default();
        let window = FakeWindow::default();

        assert_eq!(runtime.surface_state().surface_generation, 0);
        assert_eq!(
            runtime.surface_state().phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, 1),
            super::WarmHiddenTransition::Stale
        );
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, 0),
            super::WarmHiddenTransition::Warmed
        );
        assert_eq!(
            runtime.surface_state().phase,
            super::OverlaySurfacePhase::WarmHidden
        );
        assert_eq!(*window.transitions.borrow(), vec!["warm"]);
    }

    #[test]
    fn renderer_ready_atomically_reparks_and_preserves_remaining_visible_time() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        let (OverlayPaintAcknowledgement::Armed(_), _) =
            present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || start)
                .expect("initial paint activates")
        else {
            panic!("initial paint arms the clock");
        };
        assert_eq!(
            runtime.set_auto_dismiss_paused(path, 1, true, at(start, 2)),
            OverlayAutoDismissUpdate::Paused
        );
        let pressed = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 4,
        };
        begin_drag_transition_with_clock(&mut runtime, path, 1, pressed, pressed, at(start, 3))
            .expect("drag is active when renderer reloads");
        let visible_generation = runtime.surface_generation;

        let snapshot = renderer_ready_transition_with_clock(&mut runtime, &window, || at(start, 4))
            .expect("renderer mount is atomically parked");

        assert!(runtime.surface_generation > visible_generation);
        assert_eq!(snapshot.surface, runtime.surface_state());
        assert_eq!(snapshot.capture, runtime.current);
        assert_eq!(
            snapshot.surface.phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert!(runtime.pending_paint.is_none());
        assert!(runtime.active_drag.is_none());
        let clock = runtime
            .auto_dismiss_clock
            .as_ref()
            .expect("clock is preserved");
        assert_eq!(clock.remaining, std::time::Duration::from_secs(8));
        assert!(clock.deadline.is_none());
        assert_eq!(
            clock.pause_reasons,
            super::OverlayAutoDismissPauseReason::TemporarilyHidden.bit()
        );
        assert_eq!(window.transitions.borrow().last(), Some(&"park"));

        let generation = snapshot.surface.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, generation),
            super::WarmHiddenTransition::Warmed
        );
        assert!(reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            generation,
            || at(start, 10),
        )
        .1
        .is_some());
        let (OverlayPaintAcknowledgement::Armed(resumed), _) =
            present_painted_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                generation,
                true,
                || at(start, 11),
            )
            .expect("reloaded renderer exact paint reactivates")
        else {
            panic!("reloaded renderer paint resumes its preserved clock");
        };
        assert_eq!(resumed.after, std::time::Duration::from_secs(8));
        assert_eq!(resumed.deadline, at(start, 19));
    }

    #[test]
    fn renderer_ready_invalidates_pending_paint_and_returns_one_atomic_snapshot() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, old_watchdog) = shown_pending_paint(path, 1, start);

        let snapshot = renderer_ready_transition_with_clock(&mut runtime, &window, || at(start, 1))
            .expect("renderer reload parks pending paint");
        assert!(runtime.pending_paint.is_none());
        assert!(
            !runtime.claim_pending_paint_expiry(&old_watchdog, start + OVERLAY_PAINT_ACK_TIMEOUT,)
        );
        assert_eq!(
            snapshot.surface.phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert_eq!(
            snapshot
                .capture
                .as_ref()
                .map(|capture| capture.surface_generation),
            Some(snapshot.surface.surface_generation)
        );
        let serialized = serde_json::to_value(&snapshot).expect("serialize atomic snapshot");
        assert_eq!(
            serialized["surface"]["surfaceGeneration"],
            serialized["capture"]["surfaceGeneration"]
        );
        assert_eq!(serialized["surface"]["phase"], "hard_hidden");

        let mut startup = OverlayRuntime::default();
        let startup_window = FakeWindow::default();
        let startup_snapshot =
            renderer_ready_transition_with_clock(&mut startup, &startup_window, || start)
                .expect("first renderer mount parks startup surface");
        assert_eq!(startup_snapshot.surface.surface_generation, 1);
        assert_eq!(
            startup_snapshot.surface.phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert!(startup_snapshot.capture.is_none());

        let duplicate_snapshot =
            renderer_ready_transition_with_clock(&mut startup, &startup_window, || at(start, 1))
                .expect("duplicate mount stays on the already parked bootstrap surface");
        assert_eq!(duplicate_snapshot, startup_snapshot);
        assert_eq!(startup.surface_generation, 1);
    }

    #[test]
    fn page_load_start_parks_once_and_renderer_ready_reuses_that_hard_surface() {
        let path = "/tmp/capso/reload.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || start)
            .expect("surface begins visible");
        let visible_generation = runtime.surface_generation;

        let page_surface =
            super::renderer_page_load_started_transition_with_clock(&mut runtime, &window, || {
                at(start, 3)
            })
            .expect("navigation start parks before the new document paints");
        assert!(page_surface.surface_generation > visible_generation);
        assert_eq!(page_surface.phase, super::OverlaySurfacePhase::HardHidden);
        let clock_after_start = runtime.auto_dismiss_clock.as_ref().map(|clock| {
            (
                clock.generation,
                clock.remaining,
                clock.deadline,
                clock.pause_reasons,
            )
        });

        let ready = renderer_ready_transition_with_clock(&mut runtime, &window, || at(start, 9))
            .expect("renderer ready snapshots the page-start surface");
        assert_eq!(ready.surface, page_surface);
        assert_eq!(ready.capture, runtime.current);
        assert_eq!(runtime.surface_generation, page_surface.surface_generation);
        assert_eq!(
            runtime.auto_dismiss_clock.as_ref().map(|clock| {
                (
                    clock.generation,
                    clock.remaining,
                    clock.deadline,
                    clock.pause_reasons,
                )
            }),
            clock_after_start
        );
        assert_eq!(
            *window.transitions.borrow(),
            vec!["present", "park", "park"]
        );

        let next_page_surface =
            super::renderer_page_load_started_transition_with_clock(&mut runtime, &window, || {
                at(start, 10)
            })
            .expect("a later navigation owns a fresh hard-hidden generation");
        assert!(next_page_surface.surface_generation > page_surface.surface_generation);
    }

    #[test]
    fn surface_generation_rejects_stale_ready_and_paint_for_same_path_cycles() {
        let path = "/tmp/capso/repeated.png";
        let start = std::time::Instant::now();
        let mut runtime = OverlayRuntime::default();
        let window = FakeWindow::default();
        runtime.replace(capture_with_id(path, 9));
        let first_generation = runtime.begin_hard_hidden_surface();
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, first_generation),
            super::WarmHiddenTransition::Warmed
        );
        let (_, first_watchdog) = reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            9,
            first_generation,
            || start,
        );
        assert!(first_watchdog.is_some());

        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 9, || at(start, 1)),
            TemporaryHideTransition::Hidden
        );
        let hidden_generation = runtime.surface_state().surface_generation;
        assert!(hidden_generation > first_generation);
        let (restored, schedules) = restore_hidden_transition_without_resume(&mut runtime, &window);
        assert!(matches!(restored, RestoreHiddenTransition::Restored(_)));
        assert_eq!(schedules, OverlayResumeSchedules::default());
        let restored_generation = runtime.surface_state().surface_generation;
        assert!(restored_generation > hidden_generation);

        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, hidden_generation),
            super::WarmHiddenTransition::Stale
        );
        assert!(matches!(
            present_painted_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                9,
                first_generation,
                true,
                || at(start, 3),
            )
            .expect("stale paint is harmless")
            .0,
            OverlayPaintAcknowledgement::Stale
        ));
        assert_eq!(
            runtime.surface_state().phase,
            super::OverlaySurfacePhase::HardHidden
        );

        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        let (_, restored_watchdog) = reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            9,
            restored_generation,
            || at(start, 4),
        );
        assert!(restored_watchdog.is_some());
        let (acknowledgement, _) = present_painted_transition_exact_with_clock(
            &mut runtime,
            &window,
            path,
            9,
            restored_generation,
            true,
            || at(start, 5),
        )
        .expect("exact restored paint activates");
        assert!(matches!(
            acknowledgement,
            OverlayPaintAcknowledgement::Armed(_)
        ));
        assert_eq!(
            runtime.surface_state().phase,
            super::OverlaySurfacePhase::Visible
        );
    }

    #[test]
    fn old_surface_commands_cannot_mutate_the_same_capture_after_restore() {
        let path = "/tmp/capso/repeated.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        let old_generation = runtime.surface_generation;
        present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || start)
            .expect("first surface is visible");
        assert_eq!(
            temporary_hide_transition_with_clock(&mut runtime, &window, path, 1, || at(start, 2)),
            TemporaryHideTransition::Hidden
        );
        let _ = restore_hidden_transition_without_resume(&mut runtime, &window);
        let restored_generation = runtime.surface_generation;
        assert!(restored_generation > old_generation);
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        assert!(reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            || at(start, 3),
        )
        .1
        .is_some());
        present_painted_transition_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            true,
            || at(start, 4),
        )
        .expect("restored surface is visible");
        let clock_snapshot = |runtime: &OverlayRuntime| {
            runtime.auto_dismiss_clock.as_ref().map(|clock| {
                (
                    clock.identity.clone(),
                    clock.generation,
                    clock.remaining,
                    clock.deadline,
                    clock.pause_reasons,
                )
            })
        };
        let clock_before = clock_snapshot(&runtime);

        assert_eq!(
            temporary_hide_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                old_generation,
                || at(start, 5),
            ),
            TemporaryHideTransition::Stale
        );
        assert_eq!(
            runtime.set_auto_dismiss_paused_exact(path, 1, old_generation, true, at(start, 5),),
            OverlayAutoDismissUpdate::Stale
        );
        let pressed = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 8,
        };
        assert!(begin_drag_transition_exact_with_clock(
            &mut runtime,
            path,
            1,
            old_generation,
            pressed,
            pressed,
            at(start, 5),
        )
        .is_err());
        assert!(fail_transition_exact(
            &mut runtime,
            &window,
            path,
            1,
            old_generation,
            "overlay_decode_failed",
            "stale decode",
        )
        .is_none());
        assert_eq!(
            dismiss_transition_for_reason_exact(
                &mut runtime,
                &window,
                path,
                1,
                old_generation,
                DismissReason::Close,
            ),
            DismissTransition::Stale
        );

        assert_eq!(runtime.surface_generation, restored_generation);
        assert_eq!(runtime.surface_phase, super::OverlaySurfacePhase::Visible);
        assert_eq!(clock_snapshot(&runtime), clock_before);
        assert!(runtime.active_drag.is_none());
        assert!(capture_matches(runtime.current.as_ref(), path, 1));
    }

    #[test]
    fn temporary_hide_abandons_old_surface_interactions_and_drag_completion() {
        let path = "/tmp/capso/drag-cycle.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        let old_generation = runtime.surface_generation;
        present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || start)
            .expect("first surface is visible");
        assert_eq!(
            runtime.set_auto_dismiss_paused_exact(path, 1, old_generation, true, at(start, 1),),
            OverlayAutoDismissUpdate::Paused
        );
        let pressed = DragGestureState {
            left_button_is_down: true,
            left_mouse_down_counter: 17,
        };
        let old_drag = begin_drag_transition_exact_with_clock(
            &mut runtime,
            path,
            1,
            old_generation,
            pressed,
            pressed,
            at(start, 1),
        )
        .expect("old surface drag starts");

        assert_eq!(
            temporary_hide_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                old_generation,
                || at(start, 2),
            ),
            TemporaryHideTransition::Hidden
        );
        assert!(runtime.active_drag.is_none());
        let hidden_clock = runtime
            .auto_dismiss_clock
            .as_ref()
            .expect("clock is preserved");
        assert_eq!(
            hidden_clock.pause_reasons,
            super::OverlayAutoDismissPauseReason::TemporarilyHidden.bit()
        );

        let _ = restore_hidden_transition_without_resume(&mut runtime, &window);
        let restored_generation = runtime.surface_generation;
        assert_eq!(
            warm_hidden_transition(&mut runtime, &window, restored_generation),
            super::WarmHiddenTransition::Warmed
        );
        let _ = reveal_transition_and_begin_paint_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            || at(start, 3),
        );
        present_painted_transition_exact_with_clock(
            &mut runtime,
            &window,
            path,
            1,
            restored_generation,
            true,
            || at(start, 4),
        )
        .expect("restored surface is visible");
        let new_drag = begin_drag_transition_exact_with_clock(
            &mut runtime,
            path,
            1,
            restored_generation,
            pressed,
            pressed,
            at(start, 5),
        )
        .expect("restored surface drag starts");
        assert_ne!(old_drag, new_drag);

        assert_eq!(
            finish_drag_transition_with_clock(&mut runtime, &old_drag, at(start, 6)),
            (false, None)
        );
        assert_eq!(runtime.active_drag.as_ref(), Some(&new_drag));
    }

    #[test]
    fn stale_capture_lease_cannot_restore_a_later_hide_of_the_same_capture() {
        let path = "/tmp/capso/lease-cycle.png";
        let start = std::time::Instant::now();
        let mut runtime = OverlayRuntime::default();
        let window = FakeWindow::default();
        runtime.replace(capture_with_id(path, 1));
        let visible_generation = runtime.begin_hard_hidden_surface();
        assert_eq!(
            temporary_hide_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                visible_generation,
                || start,
            ),
            TemporaryHideTransition::Hidden
        );
        let first_hidden_generation = runtime.surface_generation;
        assert!(matches!(
            super::restore_exact_hidden_surface_transition_without_resume(
                &mut runtime,
                &window,
                path,
                1,
                first_hidden_generation,
            )
            .0,
            RestoreHiddenTransition::Restored(_)
        ));

        let restored_generation = runtime.surface_generation;
        assert_eq!(
            temporary_hide_transition_exact_with_clock(
                &mut runtime,
                &window,
                path,
                1,
                restored_generation,
                || at(start, 1),
            ),
            TemporaryHideTransition::Hidden
        );
        let second_hidden_generation = runtime.surface_generation;

        assert_eq!(
            super::restore_exact_hidden_surface_transition_without_resume(
                &mut runtime,
                &window,
                path,
                1,
                first_hidden_generation,
            ),
            (
                RestoreHiddenTransition::Stale,
                OverlayResumeSchedules::default(),
            )
        );
        assert_eq!(runtime.surface_generation, second_hidden_generation);
        assert!(runtime.temporarily_hidden);
        assert!(runtime
            .current
            .as_ref()
            .is_some_and(|capture| capture.temporarily_hidden));
    }

    #[test]
    fn prepare_and_dismiss_each_advance_to_a_hard_hidden_surface() {
        let path = "/tmp/capso/current.png";
        let mut runtime = OverlayRuntime::default();
        let window = FakeWindow::default();

        let prepared =
            prepare_transition(&mut runtime, &window, capture(path), None, 304, 194, 10, 20)
                .expect("prepare hard-hides first");
        assert_eq!(prepared.surface_generation, 1);
        assert_eq!(
            runtime.surface_state().phase,
            super::OverlaySurfacePhase::HardHidden
        );

        assert_eq!(
            dismiss_transition(&mut runtime, &window, path, 1),
            DismissTransition::Dismissed
        );
        assert_eq!(runtime.surface_state().surface_generation, 2);
        assert_eq!(
            runtime.surface_state().phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert!(runtime.surface_state().path.is_none());
    }

    #[test]
    fn failed_prepare_still_invalidates_every_callback_from_the_old_surface() {
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture("/tmp/capso/old.png"));
        runtime.surface_phase = super::OverlaySurfacePhase::Visible;
        let window = FakeWindow::default();
        window.fail_hide.set(true);

        let failure = prepare_transition(
            &mut runtime,
            &window,
            capture("/tmp/capso/new.png"),
            None,
            304,
            194,
            10,
            20,
        )
        .expect_err("native hard-hide failure is reported");
        assert_eq!(failure.code, "overlay_hide_failed");
        assert_eq!(runtime.surface_generation, 1);
        assert_eq!(
            runtime.surface_phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert!(runtime.current.is_none());
    }

    #[test]
    fn timeout_dismiss_invalidates_the_visible_surface_generation() {
        let path = "/tmp/capso/current.png";
        let start = std::time::Instant::now();
        let (mut runtime, window, _) = shown_pending_paint(path, 1, start);
        let (OverlayPaintAcknowledgement::Armed(schedule), _) =
            present_painted_transition_with_clock(&mut runtime, &window, path, 1, false, || start)
                .expect("exact paint activates")
        else {
            panic!("visible paint arms timeout");
        };
        let visible_generation = runtime.surface_generation;

        assert_eq!(
            dismiss_transition_for_auto_dismiss(&mut runtime, &window, &schedule, at(start, 10),),
            DismissTransition::Dismissed
        );
        assert!(runtime.surface_generation > visible_generation);
        assert_eq!(
            runtime.surface_phase,
            super::OverlaySurfacePhase::HardHidden
        );
        assert!(runtime.current.is_none());
    }

    #[test]
    fn surface_and_targeted_lifecycle_payloads_serialize_the_exact_generation() {
        let mut runtime = OverlayRuntime::default();
        runtime.replace(capture_with_id("/tmp/capso/current.png", 12));
        let surface_generation = runtime.begin_hard_hidden_surface();

        assert_eq!(
            serde_json::to_value(runtime.surface_state()).expect("serialize surface state"),
            serde_json::json!({
                "surfaceGeneration": surface_generation,
                "phase": "hard_hidden",
                "path": "/tmp/capso/current.png",
                "presentationId": 12
            })
        );
        assert_eq!(
            serde_json::to_value(OverlayRestored {
                path: "/tmp/capso/current.png",
                presentation_id: 12,
                surface_generation,
            })
            .expect("serialize restored surface"),
            serde_json::json!({
                "path": "/tmp/capso/current.png",
                "presentationId": 12,
                "surfaceGeneration": surface_generation
            })
        );
        assert_eq!(
            serde_json::to_value(OverlayDismissed {
                path: "/tmp/capso/current.png",
                presentation_id: 12,
                surface_generation,
                reason: DismissReason::Timeout,
            })
            .expect("serialize dismissed surface"),
            serde_json::json!({
                "path": "/tmp/capso/current.png",
                "presentationId": 12,
                "surfaceGeneration": surface_generation,
                "reason": "timeout"
            })
        );
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
        assert_eq!(overlay["transparent"], true);
        assert_eq!(overlay["backgroundThrottling"], "disabled");
        assert_eq!(overlay["contentProtected"], true);
        assert_eq!(overlay["shadow"], false);

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
