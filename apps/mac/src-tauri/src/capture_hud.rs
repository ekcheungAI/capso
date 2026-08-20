use crate::shortcuts::CaptureAction;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager, Runtime};

pub(crate) const HUD_LABEL: &str = "capture-hud";
pub(crate) const OPEN_CAPTURE_HUD_MENU_ID: &str = "open-capture-hud";
const SETTINGS_FILE: &str = "capture-hud-settings.json";
const PREVIOUS_AREA_FILE: &str = "previous-area.json";
const MAX_PREVIOUS_AREA_BYTES: usize = 16 * 1024;
const SAFE_DELAYS: [u8; 4] = [0, 3, 5, 10];
const NO_PREVIOUS_AREA: &str = "Choose Area once to save a reusable selection.";
const SAFE_WINDOW_PADDINGS: [u16; 4] = [0, 24, 48, 72];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WindowBackground {
    Transparent,
    Canvas,
    Ink,
    Blue,
    Custom,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WindowHexColor([u8; 3]);

impl WindowHexColor {
    fn parse(value: &str) -> Result<Self, String> {
        if value.len() != 7 || !value.starts_with('#') {
            return Err("Custom window background must use #RRGGBB.".into());
        }
        let channel = |start| {
            u8::from_str_radix(&value[start..start + 2], 16)
                .map_err(|_| "Custom window background must use #RRGGBB.".to_string())
        };
        Ok(Self([channel(1)?, channel(3)?, channel(5)?]))
    }

    pub(crate) fn rgba(self) -> image::Rgba<u8> {
        image::Rgba([self.0[0], self.0[1], self.0[2], 255])
    }
}

impl Default for WindowHexColor {
    fn default() -> Self {
        Self([0x4A, 0x6F, 0xA5])
    }
}

impl From<&str> for WindowHexColor {
    fn from(value: &str) -> Self {
        Self::parse(value).expect("WindowHexColor fixture must use #RRGGBB")
    }
}

impl Serialize for WindowHexColor {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&format!(
            "#{:02X}{:02X}{:02X}",
            self.0[0], self.0[1], self.0[2]
        ))
    }
}

impl<'de> Deserialize<'de> for WindowHexColor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct WindowCaptureStyle {
    #[serde(default = "default_window_shadow", rename = "windowShadow")]
    pub(crate) shadow: bool,
    #[serde(default, rename = "windowPadding")]
    pub(crate) padding: u16,
    #[serde(default = "default_window_background", rename = "windowBackground")]
    pub(crate) background: WindowBackground,
    #[serde(default, rename = "windowCustomBackground")]
    pub(crate) custom_background: WindowHexColor,
}

const fn default_window_shadow() -> bool {
    true
}

const fn default_window_background() -> WindowBackground {
    WindowBackground::Transparent
}

impl Default for WindowCaptureStyle {
    fn default() -> Self {
        Self {
            shadow: true,
            padding: 0,
            background: WindowBackground::Transparent,
            custom_background: WindowHexColor::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureHudSettings {
    pub(crate) mode: CaptureAction,
    pub(crate) delay_seconds: u8,
    #[serde(default)]
    pub(crate) freeze_screen: bool,
    #[serde(default)]
    pub(crate) hide_desktop_icons: bool,
    #[serde(default, flatten)]
    pub(crate) window_style: WindowCaptureStyle,
}

impl Default for CaptureHudSettings {
    fn default() -> Self {
        Self {
            mode: CaptureAction::Region,
            delay_seconds: 0,
            freeze_screen: false,
            hide_desktop_icons: false,
            window_style: WindowCaptureStyle::default(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadedCaptureHudSettings {
    pub(crate) settings: CaptureHudSettings,
    pub(crate) storage_warning: Option<String>,
    pub(crate) desktop_clutter_warning: Option<String>,
    pub(crate) previous_area: PreviousAreaStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayFingerprint {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_milli: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviousAreaRecord {
    rect: crate::capture::CaptureRect,
    display_index: u8,
    topology: Vec<DisplayFingerprint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pixel_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pixel_height: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviousAreaStatus {
    pub(crate) available: bool,
    pub(crate) label: Option<String>,
    pub(crate) unavailable_reason: Option<String>,
}

fn previous_area_status(
    record: Option<&PreviousAreaRecord>,
    topology: &[DisplayFingerprint],
) -> PreviousAreaStatus {
    let Some(record) = record else {
        return PreviousAreaStatus {
            available: false,
            label: None,
            unavailable_reason: Some(NO_PREVIOUS_AREA.into()),
        };
    };
    let (label_width, label_height) = match (record.pixel_width, record.pixel_height) {
        (Some(width), Some(height)) => (width, height),
        _ => (record.rect.width, record.rect.height),
    };
    let label = Some(format!("{label_width} × {label_height}"));
    if record.topology != topology {
        return PreviousAreaStatus {
            available: false,
            label,
            unavailable_reason: Some(
                "The display layout changed. Choose Area again before replaying it.".into(),
            ),
        };
    }
    PreviousAreaStatus {
        available: true,
        label,
        unavailable_reason: None,
    }
}

fn parse_system_selection(
    selection: &str,
    display_index: &str,
) -> Result<(crate::capture::CaptureRect, u8), String> {
    let mut height = None;
    let mut width = None;
    let mut x = None;
    let mut y = None;
    let normalized = selection.replace(['{', '}', '\n', '\r'], " ");
    for entry in normalized
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let (key, raw) = entry
            .split_once('=')
            .ok_or_else(|| "macOS returned an unreadable Previous Area rectangle.".to_string())?;
        let value = raw
            .trim()
            .parse::<i64>()
            .map_err(|_| "macOS returned a non-integer Previous Area coordinate.".to_string())?;
        let destination = match key.trim() {
            "Height" => &mut height,
            "Width" => &mut width,
            "X" => &mut x,
            "Y" => &mut y,
            _ => return Err("macOS returned an unknown Previous Area field.".into()),
        };
        if destination.replace(value).is_some() {
            return Err("macOS returned a duplicate Previous Area field.".into());
        }
    }

    let x = i32::try_from(x.ok_or_else(|| "Previous Area is missing X.".to_string())?)
        .map_err(|_| "Previous Area X is outside safe bounds.".to_string())?;
    let y = i32::try_from(y.ok_or_else(|| "Previous Area is missing Y.".to_string())?)
        .map_err(|_| "Previous Area Y is outside safe bounds.".to_string())?;
    let width = u32::try_from(width.ok_or_else(|| "Previous Area is missing Width.".to_string())?)
        .map_err(|_| "Previous Area Width is outside safe bounds.".to_string())?;
    let height =
        u32::try_from(height.ok_or_else(|| "Previous Area is missing Height.".to_string())?)
            .map_err(|_| "Previous Area Height is outside safe bounds.".to_string())?;
    let display_index = display_index
        .trim()
        .parse::<u8>()
        .map_err(|_| "macOS returned an invalid Previous Area display.".to_string())?;
    if display_index > 15 {
        return Err("Previous Area display is outside Capso's safe bounds.".into());
    }
    Ok((
        crate::capture::CaptureRect::new(x, y, width, height)?,
        display_index,
    ))
}

pub(crate) fn settings_path(app_data: &Path) -> PathBuf {
    app_data.join(SETTINGS_FILE)
}

pub(crate) fn validate_settings(
    settings: CaptureHudSettings,
) -> Result<CaptureHudSettings, String> {
    if !SAFE_DELAYS.contains(&settings.delay_seconds) {
        return Err("Capture delay must be 0, 3, 5, or 10 seconds.".into());
    }
    if settings.freeze_screen && settings.mode != CaptureAction::Region {
        return Err("Freeze Screen is available only for Area capture.".into());
    }
    if !SAFE_WINDOW_PADDINGS.contains(&settings.window_style.padding) {
        return Err("Window padding must be 0, 24, 48, or 72 pixels.".into());
    }
    Ok(settings)
}

pub(crate) fn load_settings(app_data: &Path) -> LoadedCaptureHudSettings {
    let path = settings_path(app_data);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LoadedCaptureHudSettings {
                settings: CaptureHudSettings::default(),
                storage_warning: None,
                desktop_clutter_warning: None,
                previous_area: previous_area_status(None, &[]),
            };
        }
        Err(error) => {
            return LoadedCaptureHudSettings {
                settings: CaptureHudSettings::default(),
                storage_warning: Some(format!(
                    "Could not read remembered capture choices; safe defaults are active: {error}"
                )),
                desktop_clutter_warning: None,
                previous_area: previous_area_status(None, &[]),
            };
        }
    };

    match serde_json::from_str::<CaptureHudSettings>(&contents)
        .and_then(|settings| validate_settings(settings).map_err(serde::de::Error::custom))
    {
        Ok(settings) => LoadedCaptureHudSettings {
            settings,
            storage_warning: None,
            desktop_clutter_warning: None,
            previous_area: previous_area_status(None, &[]),
        },
        Err(error) => LoadedCaptureHudSettings {
            settings: CaptureHudSettings::default(),
            storage_warning: Some(format!(
                "Saved capture choices were ignored; safe defaults are active: {error}"
            )),
            desktop_clutter_warning: None,
            previous_area: previous_area_status(None, &[]),
        },
    }
}

pub(crate) fn store_settings(app_data: &Path, settings: CaptureHudSettings) -> Result<(), String> {
    let settings = validate_settings(settings)?;
    fs::create_dir_all(app_data)
        .map_err(|error| format!("Could not create Capso's settings directory: {error}"))?;
    let path = settings_path(app_data);
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Could not encode capture choices: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not write capture choices: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not durably write capture choices: {error}"));
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not activate capture choices: {error}"));
    }
    File::open(app_data)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not durably activate capture choices: {error}"))
}

fn previous_area_path(app_data: &Path) -> PathBuf {
    app_data.join(PREVIOUS_AREA_FILE)
}

fn display_topology<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<DisplayFingerprint>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("Could not inspect the current display layout: {error}"))?;
    if monitors.is_empty() || monitors.len() > 16 {
        return Err("The current display layout is outside Capso's safe bounds.".into());
    }
    let mut topology = monitors
        .into_iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor();
            if size.width == 0
                || size.height == 0
                || size.width > 32_768
                || size.height > 32_768
                || !scale.is_finite()
                || !(0.5..=5.0).contains(&scale)
            {
                return Err("A display has geometry outside Capso's safe bounds.".to_string());
            }
            Ok(DisplayFingerprint {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale_milli: (scale * 1_000.0).round() as u32,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    topology.sort_by_key(|display| {
        (
            display.x,
            display.y,
            display.width,
            display.height,
            display.scale_milli,
        )
    });
    Ok(topology)
}

fn validate_previous_area_record(record: PreviousAreaRecord) -> Result<PreviousAreaRecord, String> {
    crate::capture::CaptureRect::new(
        record.rect.x,
        record.rect.y,
        record.rect.width,
        record.rect.height,
    )?;
    if record.topology.is_empty()
        || record.topology.len() > 16
        || usize::from(record.display_index) >= record.topology.len()
    {
        return Err("Saved Previous Area has an invalid display identity.".into());
    }
    match (record.pixel_width, record.pixel_height) {
        (None, None) => {}
        (Some(width), Some(height))
            if (2..=32_768).contains(&width) && (2..=32_768).contains(&height) => {}
        _ => return Err("Saved Previous Area has invalid output pixel dimensions.".into()),
    }
    for display in &record.topology {
        if display.width == 0
            || display.height == 0
            || display.width > 32_768
            || display.height > 32_768
            || !(500..=5_000).contains(&display.scale_milli)
        {
            return Err("Saved Previous Area has unsafe display geometry.".into());
        }
    }
    if record.topology.windows(2).any(|pair| {
        let left = &pair[0];
        let right = &pair[1];
        (left.x, left.y, left.width, left.height, left.scale_milli)
            > (
                right.x,
                right.y,
                right.width,
                right.height,
                right.scale_milli,
            )
    }) {
        return Err("Saved Previous Area display topology is not canonical.".into());
    }
    Ok(record)
}

fn load_previous_area(app_data: &Path) -> Result<Option<PreviousAreaRecord>, String> {
    let bytes = match fs::read(previous_area_path(app_data)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read Previous Area: {error}")),
    };
    if bytes.len() > MAX_PREVIOUS_AREA_BYTES {
        return Err("Saved Previous Area is too large to trust.".into());
    }
    let record = serde_json::from_slice::<PreviousAreaRecord>(&bytes)
        .map_err(|error| format!("Saved Previous Area is invalid: {error}"))?;
    validate_previous_area_record(record).map(Some)
}

fn store_previous_area(app_data: &Path, record: PreviousAreaRecord) -> Result<(), String> {
    let record = validate_previous_area_record(record)?;
    fs::create_dir_all(app_data)
        .map_err(|error| format!("Could not create Capso's settings directory: {error}"))?;
    let path = previous_area_path(app_data);
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("Could not encode Previous Area: {error}"))?;
    if bytes.len() > MAX_PREVIOUS_AREA_BYTES {
        return Err("Previous Area is too large to save safely.".into());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not write Previous Area: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not durably write Previous Area: {error}"));
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not activate Previous Area: {error}"));
    }
    File::open(app_data)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not durably activate Previous Area: {error}"))
}

fn read_macos_capture_default(key: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.screencapture", key])
        .output()
        .map_err(|error| format!("Could not read macOS Previous Area state: {error}"))?;
    if !output.status.success() || output.stdout.len() > MAX_PREVIOUS_AREA_BYTES {
        return Err("macOS did not provide a safe Previous Area value.".into());
    }
    String::from_utf8(output.stdout)
        .map_err(|_| "macOS returned non-text Previous Area state.".into())
}

pub(crate) fn record_system_previous_area<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let selection = read_macos_capture_default("last-selection")?;
    let display = read_macos_capture_default("last-selection-display")?;
    let (rect, display_index) = parse_system_selection(&selection, &display)?;
    let topology = display_topology(app)?;
    if usize::from(display_index) >= topology.len() {
        return Err("macOS Previous Area points to a display that is no longer connected.".into());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's settings directory: {error}"))?;
    store_previous_area(
        &app_data,
        PreviousAreaRecord {
            rect,
            display_index,
            topology,
            pixel_width: None,
            pixel_height: None,
        },
    )
}

pub(crate) fn record_previous_area_rect<R: Runtime>(
    app: &AppHandle<R>,
    rect: crate::capture::CaptureRect,
    pixel_dimensions: (u32, u32),
) -> Result<(), String> {
    let topology = display_topology(app)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's settings directory: {error}"))?;
    store_previous_area(
        &app_data,
        PreviousAreaRecord {
            rect,
            // Replay is bound to the complete topology. The rectangle itself is
            // authoritative; this index exists only for backwards-compatible
            // validation of native macOS picker records.
            display_index: 0,
            topology,
            pixel_width: Some(pixel_dimensions.0),
            pixel_height: Some(pixel_dimensions.1),
        },
    )
}

pub(crate) fn status_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LoadedCaptureHudSettings, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's settings directory: {error}"))?;
    let mut status = load_settings(&app_data);
    status.desktop_clutter_warning = crate::recording::desktop_clutter_warning(app);
    let topology = match display_topology(app) {
        Ok(topology) => topology,
        Err(_) => {
            status.previous_area = PreviousAreaStatus {
                available: false,
                label: None,
                unavailable_reason: Some(
                    "The current display layout could not be verified. Choose Area instead.".into(),
                ),
            };
            return Ok(status);
        }
    };
    status.previous_area = match load_previous_area(&app_data) {
        Ok(record) => previous_area_status(record.as_ref(), &topology),
        Err(_) => PreviousAreaStatus {
            available: false,
            label: None,
            unavailable_reason: Some(
                "Saved Previous Area could not be verified. Choose Area again.".into(),
            ),
        },
    };
    Ok(status)
}

pub(crate) fn previous_area_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<crate::capture::CaptureRect, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's settings directory: {error}"))?;
    let record = load_previous_area(&app_data)?
        .ok_or_else(|| "Choose Area once before using Previous Area.".to_string())?;
    let topology = display_topology(app)?;
    let status = previous_area_status(Some(&record), &topology);
    if !status.available {
        return Err(status
            .unavailable_reason
            .unwrap_or_else(|| "Previous Area is unavailable.".into()));
    }
    Ok(record.rect)
}

#[cfg(test)]
mod tests {
    use super::{
        load_settings, parse_system_selection, previous_area_status, store_previous_area,
        store_settings, validate_settings, CaptureHudSettings, DisplayFingerprint,
        PreviousAreaRecord,
    };
    use crate::capture::CaptureRect;
    use crate::shortcuts::CaptureAction;

    #[test]
    fn settings_round_trip_atomically_and_corrupt_data_falls_back_safely() {
        let root = tempfile::tempdir().expect("temporary app data");
        let settings = CaptureHudSettings {
            mode: CaptureAction::Window,
            delay_seconds: 10,
            freeze_screen: false,
            hide_desktop_icons: true,
            window_style: super::WindowCaptureStyle {
                shadow: false,
                padding: 72,
                background: super::WindowBackground::Ink,
                custom_background: "#A1B2C3".into(),
            },
        };

        store_settings(root.path(), settings).expect("settings should persist");
        let loaded = load_settings(root.path());
        assert_eq!(loaded.settings, settings);
        assert_eq!(loaded.storage_warning, None);

        std::fs::write(root.path().join("capture-hud-settings.json"), b"not json")
            .expect("fixture should write");
        let fallback = load_settings(root.path());
        assert_eq!(fallback.settings, CaptureHudSettings::default());
        assert!(fallback.storage_warning.is_some());
    }

    #[test]
    fn only_supported_delays_cross_the_native_boundary() {
        assert!(validate_settings(CaptureHudSettings {
            mode: CaptureAction::Fullscreen,
            delay_seconds: 3,
            freeze_screen: false,
            hide_desktop_icons: false,
            window_style: super::WindowCaptureStyle::default(),
        })
        .is_ok());
        assert!(validate_settings(CaptureHudSettings {
            mode: CaptureAction::Region,
            delay_seconds: 30,
            freeze_screen: false,
            hide_desktop_icons: false,
            window_style: super::WindowCaptureStyle::default(),
        })
        .is_err());
    }

    #[test]
    fn freeze_screen_is_only_valid_for_area_and_legacy_settings_default_off() {
        assert!(validate_settings(CaptureHudSettings {
            mode: CaptureAction::Region,
            delay_seconds: 5,
            freeze_screen: true,
            hide_desktop_icons: false,
            window_style: super::WindowCaptureStyle::default(),
        })
        .is_ok());
        assert!(validate_settings(CaptureHudSettings {
            mode: CaptureAction::Window,
            delay_seconds: 0,
            freeze_screen: true,
            hide_desktop_icons: false,
            window_style: super::WindowCaptureStyle::default(),
        })
        .is_err());
        assert!(validate_settings(CaptureHudSettings {
            mode: CaptureAction::Fullscreen,
            delay_seconds: 0,
            freeze_screen: true,
            hide_desktop_icons: false,
            window_style: super::WindowCaptureStyle::default(),
        })
        .is_err());

        let legacy: CaptureHudSettings = serde_json::from_value(serde_json::json!({
            "mode": "region",
            "delaySeconds": 3
        }))
        .expect("legacy settings should remain readable");
        assert!(!legacy.freeze_screen);
        assert_eq!(legacy.window_style, super::WindowCaptureStyle::default());
    }

    #[test]
    fn desktop_icon_cleanup_is_remembered_and_legacy_safe() {
        let enabled: CaptureHudSettings = serde_json::from_value(serde_json::json!({
            "mode": "fullscreen",
            "delaySeconds": 0,
            "hideDesktopIcons": true
        }))
        .expect("desktop cleanup choice should decode");
        assert!(enabled.hide_desktop_icons);

        let legacy: CaptureHudSettings = serde_json::from_value(serde_json::json!({
            "mode": "region",
            "delaySeconds": 3
        }))
        .expect("legacy capture choices should remain readable");
        assert!(!legacy.hide_desktop_icons);
    }

    #[test]
    fn window_finish_is_bounded_and_custom_colour_is_exact() {
        use super::{WindowBackground, WindowCaptureStyle};

        let mut settings = CaptureHudSettings {
            mode: CaptureAction::Window,
            delay_seconds: 0,
            freeze_screen: false,
            hide_desktop_icons: false,
            window_style: WindowCaptureStyle {
                shadow: false,
                padding: 48,
                background: WindowBackground::Custom,
                custom_background: "#A1B2C3".into(),
            },
        };
        assert!(validate_settings(settings.clone()).is_ok());
        settings.window_style.padding = 4_096;
        assert!(validate_settings(settings.clone()).is_err());
        assert!(
            serde_json::from_value::<CaptureHudSettings>(serde_json::json!({
                "mode": "window",
                "delaySeconds": 0,
                "freezeScreen": false,
                "windowShadow": true,
                "windowPadding": 48,
                "windowBackground": "custom",
                "windowCustomBackground": "red"
            }))
            .is_err()
        );
    }

    fn topology(x: i32, width: u32, scale_milli: u32) -> Vec<DisplayFingerprint> {
        vec![DisplayFingerprint {
            x,
            y: 0,
            width,
            height: 1_440,
            scale_milli,
        }]
    }

    #[test]
    fn native_selection_defaults_parse_exactly_and_reject_ambiguous_rectangles() {
        assert_eq!(
            parse_system_selection(
                "{\n    Height = 1013;\n    Width = 1299;\n    X = 800;\n    Y = 278;\n}",
                "0\n",
            )
            .expect("native selection should parse"),
            (CaptureRect::new(800, 278, 1299, 1013).unwrap(), 0)
        );
        assert!(parse_system_selection("{ Width = 4; X = 1; Y = 2; }", "0").is_err());
        assert!(parse_system_selection("{ Height = 20; Width = -4; X = 1; Y = 2; }", "0").is_err());
        assert!(parse_system_selection(
            "{ Height = 20; Width = 4; Width = 5; X = 1; Y = 2; }",
            "0"
        )
        .is_err());
    }

    #[test]
    fn previous_area_is_available_only_for_the_exact_saved_display_topology() {
        let record = PreviousAreaRecord {
            rect: CaptureRect::new(-600, 90, 480, 320).unwrap(),
            display_index: 1,
            topology: topology(-1_920, 1_920, 2_000),
            pixel_width: None,
            pixel_height: None,
        };

        let available = previous_area_status(Some(&record), &topology(-1_920, 1_920, 2_000));
        assert!(available.available);
        assert_eq!(available.label.as_deref(), Some("480 × 320"));

        let moved = previous_area_status(Some(&record), &topology(0, 1_920, 2_000));
        assert!(!moved.available);
        assert!(moved
            .unavailable_reason
            .as_deref()
            .unwrap()
            .contains("display layout changed"));
    }

    #[test]
    fn precise_previous_area_labels_use_verified_output_pixels() {
        let record = PreviousAreaRecord {
            rect: CaptureRect::new(20, 30, 640, 360).unwrap(),
            display_index: 0,
            topology: topology(0, 2_560, 2_000),
            pixel_width: Some(1_280),
            pixel_height: Some(720),
        };

        let status = previous_area_status(Some(&record), &topology(0, 2_560, 2_000));
        assert_eq!(status.label.as_deref(), Some("1280 × 720"));
    }

    #[test]
    fn previous_area_record_round_trips_without_overwriting_corrupt_state() {
        let root = tempfile::tempdir().expect("temporary app data");
        let record = PreviousAreaRecord {
            rect: CaptureRect::new(20, 30, 640, 360).unwrap(),
            display_index: 0,
            topology: topology(0, 2_560, 2_000),
            pixel_width: None,
            pixel_height: None,
        };
        store_previous_area(root.path(), record.clone()).expect("record should persist");
        assert_eq!(
            super::load_previous_area(root.path()).unwrap(),
            Some(record)
        );

        let path = root.path().join("previous-area.json");
        std::fs::write(&path, b"not json").expect("corrupt fixture should write");
        assert!(super::load_previous_area(root.path()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"not json");
    }
}
