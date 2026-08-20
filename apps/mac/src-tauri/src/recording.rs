use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use uuid::Uuid;

pub(crate) const RECORDING_STUDIO_LABEL: &str = "recording-studio";
pub(crate) const OPEN_RECORDING_STUDIO_MENU_ID: &str = "open-recording-studio";
const MAX_RECORDING_SECONDS: u32 = 7_200;
const MAX_RECORDING_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_RECORDING_HISTORY: usize = 100;
const MAX_RECORDING_DIRECTORY_ENTRIES: usize = 1_024;
const RECORDINGS_DIRECTORY: &str = "recordings";
const IN_PROGRESS_DIRECTORY: &str = ".in-progress";
const MAX_GIF_DURATION_MS: u64 = 30_000;
const MAX_GIF_FRAMES: usize = 450;
const MAX_GIF_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GIF_WIDTH: u16 = 960;
const MAX_GIF_HEIGHT: u16 = 2_160;
const MAX_GIF_PIXELS: usize = MAX_GIF_WIDTH as usize * MAX_GIF_HEIGHT as usize;
const DESKTOP_CLUTTER_RECOVERY_FILE: &str = ".recording-desktop-clutter-recovery.json";
const MAX_DESKTOP_CLUTTER_RECOVERY_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum FinderDesktopPreference {
    Inherited,
    Visible,
    Hidden,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DesktopClutterRecovery {
    version: u8,
    previous: FinderDesktopPreference,
}

trait DesktopClutterSystem {
    fn read_preference(&mut self) -> Result<FinderDesktopPreference, String>;
    fn write_preference(&mut self, preference: FinderDesktopPreference) -> Result<(), String>;
    fn refresh_finder(&mut self) -> Result<(), String>;
}

struct MacDesktopClutterSystem;

#[cfg(target_os = "macos")]
impl DesktopClutterSystem for MacDesktopClutterSystem {
    fn read_preference(&mut self) -> Result<FinderDesktopPreference, String> {
        use objc2_core_foundation::{
            kCFPreferencesAnyHost, kCFPreferencesCurrentUser, CFBoolean, CFPreferencesCopyValue,
            CFString,
        };

        let key = CFString::from_static_str("CreateDesktop");
        let application = CFString::from_static_str("com.apple.finder");
        let value = CFPreferencesCopyValue(
            &key,
            &application,
            unsafe { kCFPreferencesCurrentUser },
            unsafe { kCFPreferencesAnyHost },
        );
        let Some(value) = value else {
            return Ok(FinderDesktopPreference::Inherited);
        };
        let value = value.downcast::<CFBoolean>().map_err(|_| {
            "Finder's desktop visibility preference is not a trusted Boolean.".to_string()
        })?;
        Ok(if value.as_bool() {
            FinderDesktopPreference::Visible
        } else {
            FinderDesktopPreference::Hidden
        })
    }

    fn write_preference(&mut self, preference: FinderDesktopPreference) -> Result<(), String> {
        use objc2_core_foundation::{
            kCFPreferencesAnyHost, kCFPreferencesCurrentUser, CFBoolean, CFPreferencesSetValue,
            CFPreferencesSynchronize, CFPropertyList, CFString,
        };

        let key = CFString::from_static_str("CreateDesktop");
        let application = CFString::from_static_str("com.apple.finder");
        let value: Option<&CFPropertyList> = match preference {
            FinderDesktopPreference::Inherited => None,
            FinderDesktopPreference::Visible => Some(CFBoolean::new(true).as_ref()),
            FinderDesktopPreference::Hidden => Some(CFBoolean::new(false).as_ref()),
        };
        unsafe {
            CFPreferencesSetValue(
                &key,
                value,
                &application,
                kCFPreferencesCurrentUser,
                kCFPreferencesAnyHost,
            );
        }
        if !CFPreferencesSynchronize(&application, unsafe { kCFPreferencesCurrentUser }, unsafe {
            kCFPreferencesAnyHost
        }) {
            return Err("macOS did not persist Finder's desktop visibility preference.".into());
        }
        Ok(())
    }

    fn refresh_finder(&mut self) -> Result<(), String> {
        Command::new("/usr/bin/killall")
            .arg("Finder")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|_| ())
            .map_err(|error| format!("Could not refresh Finder's desktop: {error}"))
    }
}

#[cfg(not(target_os = "macos"))]
impl DesktopClutterSystem for MacDesktopClutterSystem {
    fn read_preference(&mut self) -> Result<FinderDesktopPreference, String> {
        Err("Desktop cleanup is only available in the macOS app.".into())
    }

    fn write_preference(&mut self, _preference: FinderDesktopPreference) -> Result<(), String> {
        Err("Desktop cleanup is only available in the macOS app.".into())
    }

    fn refresh_finder(&mut self) -> Result<(), String> {
        Err("Desktop cleanup is only available in the macOS app.".into())
    }
}

fn desktop_clutter_recovery_path(app_data: &Path) -> PathBuf {
    app_data.join(DESKTOP_CLUTTER_RECOVERY_FILE)
}

fn store_desktop_clutter_recovery(
    app_data: &Path,
    previous: FinderDesktopPreference,
) -> Result<(), String> {
    fs::create_dir_all(app_data)
        .map_err(|error| format!("Could not create Capso's recovery directory: {error}"))?;
    let path = desktop_clutter_recovery_path(app_data);
    if fs::symlink_metadata(&path).is_ok() {
        return Err("A previous desktop cleanup still needs recovery.".into());
    }
    let bytes = serde_json::to_vec(&DesktopClutterRecovery {
        version: 1,
        previous,
    })
    .map_err(|error| format!("Could not encode desktop cleanup recovery: {error}"))?;
    if bytes.len() > MAX_DESKTOP_CLUTTER_RECOVERY_BYTES {
        return Err("Desktop cleanup recovery exceeded Capso's safe limit.".into());
    }
    let temporary = app_data.join(format!(".recording-desktop-clutter-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Could not prepare desktop cleanup recovery: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not save desktop cleanup recovery: {error}"))?;
        drop(file);
        fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not activate desktop cleanup recovery: {error}"))?;
        File::open(app_data)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not make desktop cleanup recovery durable: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn load_desktop_clutter_recovery(
    app_data: &Path,
) -> Result<Option<DesktopClutterRecovery>, String> {
    let path = desktop_clutter_recovery_path(app_data);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect desktop cleanup recovery: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_DESKTOP_CLUTTER_RECOVERY_BYTES as u64
    {
        return Err("Desktop cleanup recovery is not a trusted Capso file.".into());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read desktop cleanup recovery: {error}"))?;
    let recovery = serde_json::from_slice::<DesktopClutterRecovery>(&bytes)
        .map_err(|error| format!("Desktop cleanup recovery is invalid: {error}"))?;
    if recovery.version != 1 {
        return Err("Desktop cleanup recovery has an unsupported version.".into());
    }
    Ok(Some(recovery))
}

fn clear_desktop_clutter_recovery(app_data: &Path) -> Result<(), String> {
    let path = desktop_clutter_recovery_path(app_data);
    fs::remove_file(&path)
        .map_err(|error| format!("Could not clear desktop cleanup recovery: {error}"))?;
    File::open(app_data)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not durably clear desktop cleanup recovery: {error}"))
}

fn begin_desktop_clutter_lease<S: DesktopClutterSystem>(
    app_data: &Path,
    system: &mut S,
) -> Result<bool, String> {
    if load_desktop_clutter_recovery(app_data)?.is_some() {
        return Err(
            "Restore the previous desktop cleanup before starting another capture or recording."
                .into(),
        );
    }
    let previous = system.read_preference()?;
    if previous == FinderDesktopPreference::Hidden {
        return Ok(false);
    }
    store_desktop_clutter_recovery(app_data, previous)?;
    let activation = system
        .write_preference(FinderDesktopPreference::Hidden)
        .and_then(|_| system.refresh_finder());
    if let Err(error) = activation {
        let compensation = system
            .write_preference(previous)
            .and_then(|_| system.refresh_finder())
            .and_then(|_| clear_desktop_clutter_recovery(app_data));
        return match compensation {
            Ok(()) => Err(format!("Could not hide desktop icons safely: {error}")),
            Err(restore_error) => Err(format!(
                "Could not hide desktop icons, and automatic restoration still needs attention: {error}; {restore_error}"
            )),
        };
    }
    Ok(true)
}

fn restore_desktop_clutter<S: DesktopClutterSystem>(
    app_data: &Path,
    system: &mut S,
) -> Result<bool, String> {
    let Some(recovery) = load_desktop_clutter_recovery(app_data)? else {
        return Ok(false);
    };
    system.write_preference(recovery.previous)?;
    system.refresh_finder()?;
    clear_desktop_clutter_recovery(app_data)?;
    Ok(true)
}

fn recording_app_data<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Capso's recording recovery directory: {error}"))
}

fn begin_recording_desktop_clutter<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    begin_desktop_clutter_lease(&recording_app_data(app)?, &mut MacDesktopClutterSystem)
}

fn restore_recording_desktop_clutter<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    restore_desktop_clutter(&recording_app_data(app)?, &mut MacDesktopClutterSystem)
}

pub(crate) fn recover_desktop_clutter<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    restore_recording_desktop_clutter(app)
}

pub(crate) fn note_desktop_clutter_warning<R: Runtime>(app: &AppHandle<R>, detail: String) {
    let message = format!(
        "Desktop icons could not be restored automatically. Quit and reopen Capso to retry: {detail}"
    );
    if let Ok(mut runtime) = app.state::<Mutex<RecordingRuntime>>().lock() {
        runtime.desktop_clutter_warning = Some(message.clone());
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Capso — {message}")));
    }
}

pub(crate) fn desktop_clutter_warning<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.state::<Mutex<RecordingRuntime>>()
        .lock()
        .ok()
        .and_then(|runtime| runtime.desktop_clutter_warning.clone())
}

fn clear_desktop_clutter_warning<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut runtime) = app.state::<Mutex<RecordingRuntime>>().lock() {
        runtime.desktop_clutter_warning = None;
    }
}

pub(crate) struct DesktopClutterLease<R: Runtime> {
    app: AppHandle<R>,
    changed: bool,
}

impl<R: Runtime> DesktopClutterLease<R> {
    pub(crate) fn begin(app: AppHandle<R>, requested: bool) -> Result<Self, String> {
        let changed = if requested {
            let changed = begin_recording_desktop_clutter(&app)?;
            clear_desktop_clutter_warning(&app);
            changed
        } else {
            false
        };
        Ok(Self { app, changed })
    }

    pub(crate) fn restore(&mut self) {
        if !self.changed {
            return;
        }
        self.changed = false;
        if let Err(error) = restore_recording_desktop_clutter(&self.app) {
            note_desktop_clutter_warning(&self.app, error);
        }
    }
}

impl<R: Runtime> Drop for DesktopClutterLease<R> {
    fn drop(&mut self) {
        self.restore();
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordingMode {
    Area,
    Window,
    Fullscreen,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordingQuality {
    Source,
    FullHd,
    Hd,
}

impl RecordingQuality {
    fn preset(self) -> &'static str {
        match self {
            Self::Source => "PresetHighestQuality",
            Self::FullHd => "Preset1920x1080",
            Self::Hd => "Preset1280x720",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GifFrameSpec {
    timestamp_ms: u64,
    delay_centiseconds: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GifFramePlan {
    width: u16,
    frames: Vec<GifFrameSpec>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GifRgbaFrame {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
}

fn gif_frame_plan(
    start_ms: u64,
    end_ms: u64,
    width: u16,
    frames_per_second: u8,
) -> Result<GifFramePlan, String> {
    if ![480, 720, 960].contains(&width) {
        return Err("Choose a supported 480, 720 or 960 pixel GIF width.".into());
    }
    if ![8, 12, 15].contains(&frames_per_second) {
        return Err("Choose a supported 8, 12 or 15 fps GIF frame rate.".into());
    }
    if start_ms >= end_ms || end_ms > u64::from(MAX_RECORDING_SECONDS) * 1_000 {
        return Err("Choose a valid GIF range inside the two-hour recording limit.".into());
    }
    let duration_ms = end_ms - start_ms;
    if !(250..=MAX_GIF_DURATION_MS).contains(&duration_ms) {
        return Err("GIF copies keep between 0.25 and 30 seconds.".into());
    }

    let fps = u64::from(frames_per_second);
    let frame_count = duration_ms
        .checked_mul(fps)
        .and_then(|value| value.checked_add(999))
        .map(|value| value / 1_000)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "That GIF frame plan is too large.".to_string())?;
    if frame_count == 0 || frame_count > MAX_GIF_FRAMES {
        return Err("That GIF exceeds Capso's 450-frame safety limit.".into());
    }

    let mut frames = Vec::with_capacity(frame_count);
    let mut previous_boundary_centiseconds = 0_u64;
    for index in 0..frame_count {
        let index = u64::try_from(index).map_err(|_| "That GIF frame index is invalid.")?;
        let offset_ms = index
            .checked_mul(1_000)
            .map(|value| value / fps)
            .ok_or_else(|| "That GIF timestamp is too large.".to_string())?;
        let next_offset_ms = index
            .checked_add(1)
            .and_then(|value| value.checked_mul(1_000))
            .map(|value| (value / fps).min(duration_ms))
            .ok_or_else(|| "That GIF timing is too large.".to_string())?;
        let boundary_centiseconds = next_offset_ms
            .checked_add(5)
            .map(|value| value / 10)
            .ok_or_else(|| "That GIF timing is too large.".to_string())?;
        let delay_centiseconds = boundary_centiseconds
            .saturating_sub(previous_boundary_centiseconds)
            .max(1);
        previous_boundary_centiseconds = boundary_centiseconds;
        frames.push(GifFrameSpec {
            timestamp_ms: start_ms + offset_ms,
            delay_centiseconds: u16::try_from(delay_centiseconds)
                .map_err(|_| "That GIF frame delay is too large.".to_string())?,
        });
    }
    Ok(GifFramePlan { width, frames })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MicrophonePermission {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingAudioDevice {
    id: String,
    name: String,
    is_default: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingCapabilities {
    microphone_permission: MicrophonePermission,
    microphone_devices: Vec<RecordingAudioDevice>,
}

fn safe_audio_device_text(value: String, max_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(target_os = "macos")]
fn microphone_permission() -> MicrophonePermission {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return MicrophonePermission::Unavailable;
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::NotDetermined => MicrophonePermission::NotDetermined,
        AVAuthorizationStatus::Restricted => MicrophonePermission::Restricted,
        AVAuthorizationStatus::Denied => MicrophonePermission::Denied,
        AVAuthorizationStatus::Authorized => MicrophonePermission::Authorized,
        _ => MicrophonePermission::Unavailable,
    }
}

#[cfg(not(target_os = "macos"))]
fn microphone_permission() -> MicrophonePermission {
    MicrophonePermission::Unavailable
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn recording_audio_devices() -> Vec<RecordingAudioDevice> {
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return Vec::new();
    };
    let default_id = unsafe { AVCaptureDevice::defaultDeviceWithMediaType(audio) }
        .and_then(|device| safe_audio_device_text(unsafe { device.uniqueID() }.to_string(), 512));
    let devices = unsafe { AVCaptureDevice::devicesWithMediaType(audio) };
    let mut normalized = Vec::new();
    for index in 0..devices.count().min(32) {
        let device = devices.objectAtIndex(index);
        let Some(id) = safe_audio_device_text(unsafe { device.uniqueID() }.to_string(), 512) else {
            continue;
        };
        let Some(name) = safe_audio_device_text(unsafe { device.localizedName() }.to_string(), 128)
        else {
            continue;
        };
        if normalized
            .iter()
            .any(|existing: &RecordingAudioDevice| existing.id == id)
        {
            continue;
        }
        normalized.push(RecordingAudioDevice {
            is_default: default_id.as_deref() == Some(id.as_str()),
            id,
            name,
        });
    }
    normalized.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
    normalized
}

#[cfg(not(target_os = "macos"))]
fn recording_audio_devices() -> Vec<RecordingAudioDevice> {
    Vec::new()
}

fn recording_capabilities() -> RecordingCapabilities {
    RecordingCapabilities {
        microphone_permission: microphone_permission(),
        microphone_devices: recording_audio_devices(),
    }
}

fn microphone_argument(
    enabled: bool,
    selected_id: Option<&str>,
    permission: MicrophonePermission,
    devices: &[RecordingAudioDevice],
) -> Result<Option<String>, String> {
    if !enabled {
        return Ok(None);
    }
    match permission {
        MicrophonePermission::NotDetermined => {
            return Err("Microphone access is required before recording audio.".into())
        }
        MicrophonePermission::Restricted => {
            return Err("Microphone access is restricted by this Mac's policy.".into())
        }
        MicrophonePermission::Denied => {
            return Err("Microphone access is denied. Open System Settings to allow Capso.".into())
        }
        MicrophonePermission::Unavailable => {
            return Err("Microphone access is unavailable on this Mac.".into())
        }
        MicrophonePermission::Authorized => {}
    }
    if devices.is_empty() {
        return Err("No recording microphone is currently connected.".into());
    }
    let Some(selected_id) = selected_id else {
        return Ok(Some("-g".into()));
    };
    let Some(selected_id) = safe_audio_device_text(selected_id.to_string(), 512) else {
        return Err("The selected microphone identifier is invalid.".into());
    };
    if !devices.iter().any(|device| device.id == selected_id) {
        return Err(
            "The selected microphone is no longer connected. Choose another source.".into(),
        );
    }
    Ok(Some(format!("-G{selected_id}")))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordingRequest {
    mode: RecordingMode,
    quality: RecordingQuality,
    microphone: bool,
    #[serde(default)]
    microphone_device_id: Option<String>,
    show_clicks: bool,
    show_cursor: bool,
    hide_desktop_icons: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingOutput {
    id: String,
    path: String,
    bytes: u64,
    format: &'static str,
    modified_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingSnapshot {
    status: &'static str,
    session_id: Option<u64>,
    mode: Option<RecordingMode>,
    quality: Option<RecordingQuality>,
    microphone: bool,
    microphone_device_id: Option<String>,
    show_clicks: bool,
    show_cursor: bool,
    hide_desktop_icons: bool,
    started_at_ms: Option<u64>,
    output: Option<RecordingOutput>,
    recordings: Vec<RecordingOutput>,
    history_warning: Option<String>,
    desktop_clutter_warning: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Debug)]
struct ActiveRecording {
    session_id: u64,
    pid: u32,
    request: RecordingRequest,
    source_path: PathBuf,
    output_path: PathBuf,
    started_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default)]
enum RecordingResultState {
    #[default]
    Idle,
    Completed(RecordingOutput),
    Cancelled,
    Failed {
        message: String,
        recovery: Option<RecordingOutput>,
    },
}

#[derive(Clone, Default)]
pub(crate) struct RecordingRuntime {
    active: Option<ActiveRecording>,
    generation: u64,
    finalizing: bool,
    last: RecordingResultState,
    desktop_clutter_warning: Option<String>,
}

impl RecordingRuntime {
    fn begin(
        &mut self,
        pid: u32,
        request: RecordingRequest,
        source_path: PathBuf,
        output_path: PathBuf,
    ) -> Result<RecordingSnapshot, String> {
        if self.active.is_some() || self.finalizing {
            return Err("A Capso recording is already active.".into());
        }
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| "The recording session counter is exhausted.".to_string())?;
        self.last = RecordingResultState::Idle;
        self.desktop_clutter_warning = None;
        self.active = Some(ActiveRecording {
            session_id: self.generation,
            pid,
            request,
            source_path,
            output_path,
            started_at_ms: None,
        });
        Ok(self.snapshot())
    }

    fn note_desktop_clutter_warning(&mut self, detail: String) {
        self.desktop_clutter_warning = Some(format!(
            "Desktop icons could not be restored automatically. Quit and reopen Capso to retry: {detail}"
        ));
    }

    fn tray_title(&self, at_ms: u64) -> Option<String> {
        let started_at_ms = self.active.as_ref()?.started_at_ms?;
        let seconds = at_ms
            .saturating_sub(started_at_ms)
            .checked_div(1_000)
            .unwrap_or_default()
            .min(u64::from(MAX_RECORDING_SECONDS));
        let hours = seconds / 3_600;
        let minutes = (seconds % 3_600) / 60;
        let seconds = seconds % 60;
        Some(if hours > 0 {
            format!("{hours}:{minutes:02}:{seconds:02}")
        } else {
            format!("{minutes:02}:{seconds:02}")
        })
    }

    fn mark_started(&mut self, session_id: u64, started_at_ms: u64) -> Option<RecordingSnapshot> {
        let active = self
            .active
            .as_mut()
            .filter(|active| active.session_id == session_id)?;
        if active.started_at_ms.is_some() {
            return None;
        }
        active.started_at_ms = Some(started_at_ms);
        Some(self.snapshot())
    }

    fn begin_finalizing(&mut self, session_id: u64) -> Option<ActiveRecording> {
        let active = self
            .active
            .take()
            .filter(|active| active.session_id == session_id)?;
        self.finalizing = true;
        Some(active)
    }

    fn begin_local_export(&mut self) -> Result<u64, String> {
        if self.active.is_some() || self.finalizing {
            return Err("Wait for the current recording task to finish before editing.".into());
        }
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| "The recording session counter is exhausted.".to_string())?;
        self.finalizing = true;
        Ok(self.generation)
    }

    fn finish(
        &mut self,
        result: RecordingResultState,
        expected_generation: u64,
    ) -> RecordingSnapshot {
        if self.generation == expected_generation {
            self.finalizing = false;
            self.last = result;
        }
        self.snapshot()
    }

    fn active_for_stop(&self, session_id: u64) -> Result<&ActiveRecording, String> {
        self.active
            .as_ref()
            .filter(|active| active.session_id == session_id)
            .ok_or_else(|| "That recording session is no longer active.".into())
    }

    fn snapshot(&self) -> RecordingSnapshot {
        if let Some(active) = &self.active {
            return RecordingSnapshot {
                status: if active.started_at_ms.is_some() {
                    "recording"
                } else {
                    "selecting"
                },
                session_id: Some(active.session_id),
                mode: Some(active.request.mode),
                quality: Some(active.request.quality),
                microphone: active.request.microphone,
                microphone_device_id: active.request.microphone_device_id.clone(),
                show_clicks: active.request.show_clicks,
                show_cursor: active.request.show_cursor,
                hide_desktop_icons: active.request.hide_desktop_icons,
                started_at_ms: active.started_at_ms,
                output: None,
                recordings: Vec::new(),
                history_warning: None,
                desktop_clutter_warning: self.desktop_clutter_warning.clone(),
                message: None,
            };
        }
        if self.finalizing {
            return RecordingSnapshot {
                status: "finalizing",
                session_id: Some(self.generation),
                mode: None,
                quality: None,
                microphone: false,
                microphone_device_id: None,
                show_clicks: false,
                show_cursor: false,
                hide_desktop_icons: false,
                started_at_ms: None,
                output: None,
                recordings: Vec::new(),
                history_warning: None,
                desktop_clutter_warning: self.desktop_clutter_warning.clone(),
                message: Some("Finishing the local recording copy…".into()),
            };
        }
        match &self.last {
            RecordingResultState::Idle => RecordingSnapshot {
                status: "idle",
                session_id: None,
                mode: None,
                quality: None,
                microphone: false,
                microphone_device_id: None,
                show_clicks: false,
                show_cursor: false,
                hide_desktop_icons: false,
                started_at_ms: None,
                output: None,
                recordings: Vec::new(),
                history_warning: None,
                desktop_clutter_warning: self.desktop_clutter_warning.clone(),
                message: None,
            },
            RecordingResultState::Completed(output) => RecordingSnapshot {
                status: "completed",
                session_id: Some(self.generation),
                mode: None,
                quality: None,
                microphone: false,
                microphone_device_id: None,
                show_clicks: false,
                show_cursor: false,
                hide_desktop_icons: false,
                started_at_ms: None,
                output: Some(output.clone()),
                recordings: Vec::new(),
                history_warning: None,
                desktop_clutter_warning: self.desktop_clutter_warning.clone(),
                message: Some(if output.format == "gif" {
                    "GIF copy saved locally.".into()
                } else {
                    "MP4 saved locally.".into()
                }),
            },
            RecordingResultState::Cancelled => RecordingSnapshot {
                status: "cancelled",
                session_id: Some(self.generation),
                mode: None,
                quality: None,
                microphone: false,
                microphone_device_id: None,
                show_clicks: false,
                show_cursor: false,
                hide_desktop_icons: false,
                started_at_ms: None,
                output: None,
                recordings: Vec::new(),
                history_warning: None,
                desktop_clutter_warning: self.desktop_clutter_warning.clone(),
                message: Some("Recording cancelled. No video was published.".into()),
            },
            RecordingResultState::Failed { message, recovery } => RecordingSnapshot {
                status: "failed",
                session_id: Some(self.generation),
                mode: None,
                quality: None,
                microphone: false,
                microphone_device_id: None,
                show_clicks: false,
                show_cursor: false,
                hide_desktop_icons: false,
                started_at_ms: None,
                output: recovery.clone(),
                recordings: Vec::new(),
                history_warning: None,
                desktop_clutter_warning: self.desktop_clutter_warning.clone(),
                message: Some(message.clone()),
            },
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn recording_arguments(request: &RecordingRequest, output: &Path) -> Vec<String> {
    let mut arguments = vec!["-v".into(), format!("-V{MAX_RECORDING_SECONDS}")];
    match request.mode {
        RecordingMode::Area => {
            arguments.push("-i".into());
            arguments.push("-Jvideo".into());
        }
        RecordingMode::Window => {
            arguments.push("-i".into());
            arguments.push("-w".into());
            arguments.push("-Jwindow".into());
        }
        RecordingMode::Fullscreen => {
            arguments.push("-D1".into());
            if request.show_cursor {
                arguments.push("-C".into());
            }
        }
    }
    if request.microphone {
        arguments.push(
            request
                .microphone_device_id
                .as_ref()
                .map_or_else(|| "-g".into(), |id| format!("-G{id}")),
        );
    }
    if request.show_clicks {
        arguments.push("-k".into());
    }
    arguments.push("-x".into());
    arguments.push(output.to_string_lossy().into_owned());
    arguments
}

fn validate_recording_request(request: &RecordingRequest) -> Result<(), String> {
    if request.mode != RecordingMode::Fullscreen && !request.show_cursor {
        return Err(
            "The macOS Area and Window pickers own pointer visibility; only Full screen can hide it explicitly."
                .into(),
        );
    }
    if let Some(id) = request.microphone_device_id.as_ref() {
        if safe_audio_device_text(id.clone(), 512).as_deref() != Some(id.as_str()) {
            return Err("The selected microphone identifier is invalid.".into());
        }
    }
    Ok(())
}

fn recordings_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(RECORDINGS_DIRECTORY))
        .map_err(|error| format!("Could not locate Capso recordings: {error}"))
}

fn recording_paths<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(PathBuf, PathBuf), String> {
    let directory = recordings_directory(app)?;
    let in_progress = directory.join(IN_PROGRESS_DIRECTORY);
    fs::create_dir_all(&in_progress)
        .map_err(|error| format!("Could not create the private recording directory: {error}"))?;
    Ok((
        in_progress.join(format!("{id}.mov")),
        directory.join(format!("{id}.mp4")),
    ))
}

fn recording_file_kind(name: &str) -> Option<&'static str> {
    let (id, format) = if let Some(id) = name.strip_suffix(".mp4") {
        (id, "mp4")
    } else if let Some(id) = name.strip_suffix(".gif") {
        (id, "gif")
    } else if let Some(id) = name.strip_suffix(".recovery.mov") {
        (id, "mov_recovery")
    } else if let Some(id) = name.strip_suffix(".interrupted.mov") {
        (id, "mov_interrupted")
    } else {
        return None;
    };
    let parsed = Uuid::parse_str(id).ok()?;
    (parsed.to_string() == id).then_some(format)
}

fn modified_at_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn recording_output(
    path: &Path,
    bytes: u64,
    format: &'static str,
    modified_at_ms: u64,
) -> Result<RecordingOutput, String> {
    let id = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|name| recording_file_kind(name) == Some(format))
        .ok_or_else(|| "The recording filename is not a canonical Capso identity.".to_string())?;
    Ok(RecordingOutput {
        id: id.into(),
        path: path.to_string_lossy().into_owned(),
        bytes,
        format,
        modified_at_ms,
    })
}

fn validate_mp4(path: &Path) -> Result<u64, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect the finished MP4: {error}"))?;
    if !metadata.is_file() || metadata.len() < 12 || metadata.len() > MAX_RECORDING_BYTES {
        return Err("The finished recording is outside Capso's safe MP4 limits.".into());
    }
    let inspection_bytes = metadata.len().min(1024 * 1024) as usize;
    let mut header = vec![0_u8; inspection_bytes];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| format!("Could not validate the finished MP4: {error}"))?;
    if &header[4..8] != b"ftyp" {
        return Err("The finished recording is not an MP4 container.".into());
    }
    if !header
        .windows(4)
        .any(|value| value == b"avc1" || value == b"avc3")
    {
        return Err("The finished MP4 does not contain a verified H.264 video track.".into());
    }
    Ok(metadata.len())
}

fn validate_gif(path: &Path) -> Result<u64, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect the finished GIF: {error}"))?;
    if !metadata.is_file() || metadata.len() < 14 || metadata.len() > MAX_GIF_BYTES {
        return Err("The finished GIF is outside Capso's safe file limits.".into());
    }
    let mut file = File::open(path)
        .map_err(|error| format!("Could not validate the finished GIF: {error}"))?;
    let mut header = [0_u8; 10];
    file.read_exact(&mut header)
        .map_err(|error| format!("Could not read the finished GIF header: {error}"))?;
    if &header[..6] != b"GIF87a" && &header[..6] != b"GIF89a" {
        return Err("The finished recording copy is not a GIF container.".into());
    }
    let width = u16::from_le_bytes([header[6], header[7]]);
    let height = u16::from_le_bytes([header[8], header[9]]);
    let pixels = usize::from(width)
        .checked_mul(usize::from(height))
        .ok_or_else(|| "The finished GIF dimensions overflow Capso's limits.".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_GIF_WIDTH
        || height > MAX_GIF_HEIGHT
        || pixels > MAX_GIF_PIXELS
    {
        return Err("The finished GIF dimensions exceed Capso's safe limits.".into());
    }
    use std::io::Seek;
    file.seek(io::SeekFrom::End(-1))
        .and_then(|_| file.read_exact(&mut header[..1]))
        .map_err(|error| format!("Could not read the finished GIF trailer: {error}"))?;
    if header[0] != 0x3b {
        return Err("The finished GIF is incomplete.".into());
    }
    Ok(metadata.len())
}

fn scan_recording_history(directory: &Path) -> Result<Vec<RecordingOutput>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not inspect local recording history: {error}"
            ))
        }
    };
    let mut candidates = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_RECORDING_DIRECTORY_ENTRIES {
            return Err("Local recording history exceeds Capso's safe scan limit.".into());
        }
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(format) = recording_file_kind(name) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() == 0 || metadata.len() > MAX_RECORDING_BYTES {
            continue;
        }
        candidates.push((path, metadata, format));
    }
    candidates.sort_by(
        |(left_path, left_metadata, _), (right_path, right_metadata, _)| {
            modified_at_ms(right_metadata)
                .cmp(&modified_at_ms(left_metadata))
                .then_with(|| right_path.file_name().cmp(&left_path.file_name()))
        },
    );
    let mut history = candidates
        .into_iter()
        .filter_map(|(path, metadata, format)| {
            match format {
                "mp4" if validate_mp4(&path).is_err() => return None,
                "gif" if validate_gif(&path).is_err() => return None,
                _ => {}
            }
            recording_output(&path, metadata.len(), format, modified_at_ms(&metadata)).ok()
        })
        .collect::<Vec<_>>();
    history.truncate(MAX_RECORDING_HISTORY);
    Ok(history)
}

fn snapshot_with_history<R: Runtime>(
    app: &AppHandle<R>,
    mut snapshot: RecordingSnapshot,
) -> RecordingSnapshot {
    match recordings_directory(app).and_then(|directory| scan_recording_history(&directory)) {
        Ok(recordings) => snapshot.recordings = recordings,
        Err(error) => snapshot.history_warning = Some(error),
    }
    snapshot
}

fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The recording has no parent directory.".to_string())?;
    OpenOptions::new()
        .read(true)
        .open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not finish the local recording: {error}"))
}

fn preserve_raw_recording(source: &Path, output: &Path) -> Option<RecordingOutput> {
    let source_metadata = fs::metadata(source).ok()?;
    let bytes = source_metadata.len();
    if bytes == 0 || bytes > MAX_RECORDING_BYTES {
        return None;
    }
    let recovery = output.with_extension("recovery.mov");
    fs::rename(source, &recovery).ok()?;
    let _ = sync_parent(&recovery);
    let metadata = fs::metadata(&recovery).ok()?;
    recording_output(&recovery, bytes, "mov_recovery", modified_at_ms(&metadata)).ok()
}

fn finalize_mp4(
    source: &Path,
    output: &Path,
    quality: RecordingQuality,
) -> Result<RecordingOutput, String> {
    let source_metadata = fs::metadata(source)
        .map_err(|error| format!("Could not inspect the captured video: {error}"))?;
    if !source_metadata.is_file()
        || source_metadata.len() == 0
        || source_metadata.len() > MAX_RECORDING_BYTES
    {
        return Err("The captured video is outside Capso's safe local limit.".into());
    }
    let partial = output.with_extension("partial.mp4");
    if partial.exists() {
        return Err(
            "A stale partial MP4 blocks this recording; the source MOV was preserved.".into(),
        );
    }
    let result = (|| -> Result<u64, String> {
        let status = Command::new("/usr/bin/avconvert")
            .arg("--source")
            .arg(source)
            .arg("--preset")
            .arg(quality.preset())
            .arg("--output")
            .arg(&partial)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Could not start local MP4 conversion: {error}"))?;
        if !status.success() {
            return Err(
                "macOS could not finish the local H.264 MP4; the source MOV was preserved.".into(),
            );
        }
        let bytes = validate_mp4(&partial)?;
        File::open(&partial)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Could not sync the finished MP4: {error}"))?;
        fs::rename(&partial, output)
            .map_err(|error| format!("Could not publish the finished MP4: {error}"))?;
        sync_parent(output)?;
        Ok(bytes)
    })();
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
    };
    if let Err(error) = fs::remove_file(source) {
        eprintln!("The MP4 is safe, but its private source could not be removed: {error}");
    }
    let metadata = fs::metadata(output)
        .map_err(|error| format!("Could not inspect the published MP4: {error}"))?;
    recording_output(output, bytes, "mp4", modified_at_ms(&metadata))
}

fn trim_arguments(
    source: &Path,
    output: &Path,
    start_ms: u64,
    end_ms: u64,
    quality: RecordingQuality,
) -> Result<Vec<String>, String> {
    if start_ms >= end_ms || end_ms > u64::from(MAX_RECORDING_SECONDS) * 1_000 {
        return Err("Choose a valid trim range inside the two-hour recording limit.".into());
    }
    if end_ms - start_ms < 250 {
        return Err("Keep at least 0.25 seconds in the trimmed recording.".into());
    }
    let seconds =
        |milliseconds: u64| format!("{}.{:03}", milliseconds / 1_000, milliseconds % 1_000);
    Ok(vec![
        "--source".into(),
        source.to_string_lossy().into_owned(),
        "--preset".into(),
        quality.preset().into(),
        "--output".into(),
        output.to_string_lossy().into_owned(),
        "--start".into(),
        seconds(start_ms),
        "--duration".into(),
        seconds(end_ms - start_ms),
    ])
}

fn trim_mp4(
    source: &Path,
    output: &Path,
    start_ms: u64,
    end_ms: u64,
    quality: RecordingQuality,
) -> Result<RecordingOutput, String> {
    validate_mp4(source)?;
    let partial = output.with_extension("partial.mp4");
    if output.exists() || partial.exists() {
        return Err("The trimmed recording output identity is already in use.".into());
    }
    let result = (|| -> Result<u64, String> {
        let status = Command::new("/usr/bin/avconvert")
            .args(trim_arguments(source, &partial, start_ms, end_ms, quality)?)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Could not start the local video trim: {error}"))?;
        if !status.success() {
            return Err(
                "macOS could not create the trimmed H.264 MP4; the source is unchanged.".into(),
            );
        }
        let bytes = validate_mp4(&partial)?;
        File::open(&partial)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Could not sync the trimmed MP4: {error}"))?;
        fs::rename(&partial, output)
            .map_err(|error| format!("Could not publish the trimmed MP4: {error}"))?;
        sync_parent(output)?;
        Ok(bytes)
    })();
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
    };
    let metadata = fs::metadata(output)
        .map_err(|error| format!("Could not inspect the trimmed MP4: {error}"))?;
    recording_output(output, bytes, "mp4", modified_at_ms(&metadata))
}

struct BoundedWriter<W> {
    inner: W,
    written: u64,
    limit: u64,
}

impl<W> BoundedWriter<W> {
    fn new(inner: W, limit: u64) -> Self {
        Self {
            inner,
            written: 0,
            limit,
        }
    }

    fn into_inner(self) -> W {
        self.inner
    }
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let requested = u64::try_from(buffer.len())
            .map_err(|_| io::Error::other("GIF write length is unavailable"))?;
        if requested > self.limit.saturating_sub(self.written) {
            return Err(io::Error::other("GIF exceeds Capso's 256 MB output limit"));
        }
        let written = self.inner.write(buffer)?;
        self.written = self
            .written
            .saturating_add(u64::try_from(written).unwrap_or(u64::MAX));
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn validate_gif_frame(frame: &GifRgbaFrame, expected: Option<(u16, u16)>) -> Result<(), String> {
    let pixels = usize::from(frame.width)
        .checked_mul(usize::from(frame.height))
        .ok_or_else(|| "A decoded GIF frame exceeds Capso's dimension limits.".to_string())?;
    let bytes = pixels
        .checked_mul(4)
        .ok_or_else(|| "A decoded GIF frame exceeds Capso's memory limits.".to_string())?;
    if frame.width == 0
        || frame.height == 0
        || frame.width > MAX_GIF_WIDTH
        || frame.height > MAX_GIF_HEIGHT
        || pixels > MAX_GIF_PIXELS
        || bytes != frame.pixels.len()
    {
        return Err("A decoded GIF frame is outside Capso's safe pixel limits.".into());
    }
    if expected.is_some_and(|dimensions| dimensions != (frame.width, frame.height)) {
        return Err("The recording changed dimensions during GIF export.".into());
    }
    Ok(())
}

fn encode_gif_frames(
    output: &Path,
    plan: &GifFramePlan,
    loop_forever: bool,
    mut frame_at: impl FnMut(u64) -> Result<GifRgbaFrame, String>,
) -> Result<u64, String> {
    if output.exists() {
        return Err("The GIF output identity is already in use.".into());
    }
    let partial = output.with_extension("partial.gif");
    if partial.exists() {
        return Err("A stale partial GIF blocks this export; the MP4 is unchanged.".into());
    }
    let first_spec = plan
        .frames
        .first()
        .copied()
        .ok_or_else(|| "The GIF frame plan is empty.".to_string())?;
    let first = frame_at(first_spec.timestamp_ms)?;
    validate_gif_frame(&first, None)?;
    let dimensions = (first.width, first.height);
    let mut first = Some(first);

    let result = (|| -> Result<u64, String> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|error| format!("Could not create the private GIF output: {error}"))?;
        let writer = BoundedWriter::new(file, MAX_GIF_BYTES);
        let mut encoder = gif::Encoder::new(writer, dimensions.0, dimensions.1, &[])
            .map_err(|error| format!("Could not start the local GIF encoder: {error}"))?;
        if loop_forever {
            encoder
                .set_repeat(gif::Repeat::Infinite)
                .map_err(|error| format!("Could not set the GIF loop: {error}"))?;
        }
        for (index, spec) in plan.frames.iter().enumerate() {
            let mut rgba = if index == 0 {
                first
                    .take()
                    .ok_or_else(|| "The first GIF frame is unavailable.".to_string())?
            } else {
                frame_at(spec.timestamp_ms)?
            };
            validate_gif_frame(&rgba, Some(dimensions))?;
            let mut frame =
                gif::Frame::from_rgba_speed(rgba.width, rgba.height, &mut rgba.pixels, 10);
            frame.delay = spec.delay_centiseconds;
            frame.dispose = gif::DisposalMethod::Keep;
            encoder
                .write_frame(&frame)
                .map_err(|error| format!("Could not encode the local GIF frame: {error}"))?;
        }
        let writer = encoder
            .into_inner()
            .map_err(|error| format!("Could not finish the local GIF: {error}"))?;
        let file = writer.into_inner();
        file.sync_all()
            .map_err(|error| format!("Could not sync the finished GIF: {error}"))?;
        drop(file);
        let bytes = validate_gif(&partial)?;
        fs::rename(&partial, output)
            .map_err(|error| format!("Could not publish the finished GIF: {error}"))?;
        if let Err(error) = sync_parent(output) {
            let _ = fs::remove_file(output);
            return Err(error);
        }
        Ok(bytes)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

#[cfg(target_os = "macos")]
fn rgba_from_cg_image(image: &objc2_core_graphics::CGImage) -> Result<GifRgbaFrame, String> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
        CGImageByteOrderInfo,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let width_u16 = u16::try_from(width)
        .map_err(|_| "Apple returned a GIF frame that is too wide.".to_string())?;
    let height_u16 = u16::try_from(height)
        .map_err(|_| "Apple returned a GIF frame that is too tall.".to_string())?;
    let bytes_per_row = width
        .checked_mul(4)
        .ok_or_else(|| "Apple returned a GIF frame with an invalid row size.".to_string())?;
    let bytes = bytes_per_row
        .checked_mul(height)
        .ok_or_else(|| "Apple returned a GIF frame that is too large.".to_string())?;
    let mut pixels = vec![0_u8; bytes];
    let color_space = CGColorSpace::new_device_rgb()
        .ok_or_else(|| "macOS could not create the GIF color space.".to_string())?;
    let bitmap_info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    // SAFETY: `pixels` remains exclusively owned and fixed in memory until the
    // bitmap context is dropped. The row and allocation sizes were checked.
    let context = unsafe {
        CGBitmapContextCreate(
            pixels.as_mut_ptr().cast(),
            width,
            height,
            8,
            bytes_per_row,
            Some(&color_space),
            bitmap_info,
        )
    }
    .ok_or_else(|| "macOS could not allocate the GIF frame renderer.".to_string())?;
    CGContext::draw_image(
        Some(&context),
        NSRect::new(NSPoint::ZERO, NSSize::new(width as f64, height as f64)),
        Some(image),
    );
    drop(context);
    let frame = GifRgbaFrame {
        width: width_u16,
        height: height_u16,
        pixels,
    };
    validate_gif_frame(&frame, None)?;
    Ok(frame)
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn export_gif_mp4(
    source: &Path,
    output: &Path,
    plan: &GifFramePlan,
    loop_forever: bool,
) -> Result<RecordingOutput, String> {
    use objc2::AnyThread;
    use objc2_av_foundation::{AVAsset, AVAssetImageGenerator};
    use objc2_core_media::CMTime;
    use objc2_foundation::{NSSize, NSString, NSURL};

    validate_mp4(source)?;
    let source_path = source
        .to_str()
        .ok_or_else(|| "The local MP4 path cannot be read by AVFoundation.".to_string())?;
    let source_path = NSString::from_str(source_path);
    let url = NSURL::fileURLWithPath(&source_path);
    // SAFETY: The immutable file URL points to the already revalidated local
    // Capso MP4 and remains alive while AVFoundation creates the asset.
    let asset = unsafe { AVAsset::assetWithURL(&url) };
    // SAFETY: The asset remains alive for the generator's full lifetime.
    let generator =
        unsafe { AVAssetImageGenerator::initWithAsset(AVAssetImageGenerator::alloc(), &asset) };
    // SAFETY: These properties are set before any synchronous extraction and
    // remain unchanged until all frames are encoded.
    unsafe {
        generator.setAppliesPreferredTrackTransform(true);
        generator.setMaximumSize(NSSize::new(
            f64::from(plan.width),
            f64::from(MAX_GIF_HEIGHT),
        ));
        let zero = CMTime::new(0, 1_000);
        generator.setRequestedTimeToleranceBefore(zero);
        generator.setRequestedTimeToleranceAfter(zero);
    }
    let bytes = encode_gif_frames(output, plan, loop_forever, |timestamp_ms| {
        let requested = unsafe {
            CMTime::new(
                i64::try_from(timestamp_ms)
                    .map_err(|_| "The GIF timestamp is unavailable.".to_string())?,
                1_000,
            )
        };
        // SAFETY: Extraction runs on a blocking worker, the generator is not
        // mutated concurrently, and the returned retained CGImage is consumed
        // before the next frame is requested.
        let image = unsafe {
            generator.copyCGImageAtTime_actualTime_error(requested, std::ptr::null_mut())
        }
        .map_err(|_| "AVFoundation could not decode a requested GIF frame.".to_string())?;
        rgba_from_cg_image(&image)
    })?;
    let metadata = fs::metadata(output)
        .map_err(|error| format!("Could not inspect the published GIF: {error}"))?;
    recording_output(output, bytes, "gif", modified_at_ms(&metadata))
}

#[cfg(not(target_os = "macos"))]
fn export_gif_mp4(
    _source: &Path,
    _output: &Path,
    _plan: &GifFramePlan,
    _loop_forever: bool,
) -> Result<RecordingOutput, String> {
    Err("Native GIF export is only available in the macOS app.".into())
}

fn emit_snapshot(app: &AppHandle, snapshot: &RecordingSnapshot, show: bool) {
    let snapshot = snapshot_with_history(app, snapshot.clone());
    let _ = app.emit_to(RECORDING_STUDIO_LABEL, "recording-status-changed", snapshot);
    if show {
        if let Some(window) = app.get_webview_window(RECORDING_STUDIO_LABEL) {
            let _ = window.show();
        }
    }
    let _ = crate::refresh_tray_status(app);
}

pub(crate) fn recording_tray_title<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.state::<Mutex<RecordingRuntime>>()
        .lock()
        .ok()
        .and_then(|runtime| runtime.tray_title(now_ms()))
}

fn monitor_recording(app: AppHandle, mut child: std::process::Child, session_id: u64) {
    let mut announced_started = false;
    let mut last_tray_refresh_second = None;
    loop {
        if !announced_started {
            let source_exists = app
                .state::<Mutex<RecordingRuntime>>()
                .lock()
                .ok()
                .and_then(|runtime| {
                    runtime
                        .active
                        .as_ref()
                        .filter(|active| active.session_id == session_id)
                        .map(|active| active.source_path.clone())
                })
                .and_then(|path| fs::metadata(path).ok())
                .is_some_and(|metadata| metadata.len() > 0);
            if source_exists {
                let snapshot = app
                    .state::<Mutex<RecordingRuntime>>()
                    .lock()
                    .ok()
                    .and_then(|mut runtime| runtime.mark_started(session_id, now_ms()));
                if let Some(snapshot) = snapshot {
                    emit_snapshot(&app, &snapshot, true);
                }
                announced_started = true;
            }
        }
        if announced_started {
            let current_second = now_ms() / 1_000;
            if last_tray_refresh_second != Some(current_second) {
                last_tray_refresh_second = Some(current_second);
                crate::refresh_recording_tray_title(&app);
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(120)),
            Err(error) => {
                let restoration = restore_recording_desktop_clutter(&app);
                let snapshot =
                    app.state::<Mutex<RecordingRuntime>>()
                        .lock()
                        .ok()
                        .map(|mut runtime| {
                            if let Err(restore_error) = &restoration {
                                runtime.note_desktop_clutter_warning(restore_error.clone());
                            }
                            runtime.active = None;
                            runtime.finalizing = false;
                            runtime.last = RecordingResultState::Failed {
                                message: match &restoration {
                                    Ok(_) => format!("Could not monitor the screen recording: {error}"),
                                    Err(restore_error) => format!(
                                        "Could not monitor the screen recording, and desktop icons still need recovery: {error}; {restore_error}"
                                    ),
                                },
                                recovery: None,
                            };
                            runtime.snapshot()
                        });
                if let Some(snapshot) = snapshot {
                    emit_snapshot(&app, &snapshot, true);
                }
                return;
            }
        }
    }

    let desktop_restoration = restore_recording_desktop_clutter(&app);
    if let Err(error) = &desktop_restoration {
        if let Ok(mut runtime) = app.state::<Mutex<RecordingRuntime>>().lock() {
            runtime.note_desktop_clutter_warning(error.clone());
        }
    }
    let active = app
        .state::<Mutex<RecordingRuntime>>()
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.begin_finalizing(session_id));
    let Some(active) = active else {
        return;
    };
    let has_video = fs::metadata(&active.source_path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0);
    if !has_video {
        let snapshot = app
            .state::<Mutex<RecordingRuntime>>()
            .lock()
            .ok()
            .map(|mut runtime| runtime.finish(RecordingResultState::Cancelled, active.session_id));
        if let Some(snapshot) = snapshot {
            emit_snapshot(&app, &snapshot, true);
        }
        return;
    }

    let finalizing = app
        .state::<Mutex<RecordingRuntime>>()
        .lock()
        .ok()
        .map(|runtime| runtime.snapshot());
    if let Some(snapshot) = finalizing {
        emit_snapshot(&app, &snapshot, true);
    }
    let result = match finalize_mp4(
        &active.source_path,
        &active.output_path,
        active.request.quality,
    ) {
        Ok(output) => RecordingResultState::Completed(output),
        Err(message) => RecordingResultState::Failed {
            recovery: preserve_raw_recording(&active.source_path, &active.output_path),
            message,
        },
    };
    let snapshot = app
        .state::<Mutex<RecordingRuntime>>()
        .lock()
        .ok()
        .map(|mut runtime| runtime.finish(result, active.session_id));
    if let Some(snapshot) = snapshot {
        emit_snapshot(&app, &snapshot, true);
    }
}

pub(crate) fn show_recording_studio<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window(RECORDING_STUDIO_LABEL)
        .ok_or_else(|| "The recording studio window is unavailable.".to_string())?;
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| format!("Could not open recording controls: {error}"))
}

pub(crate) fn recording_menu_label<R: Runtime>(app: &AppHandle<R>) -> String {
    app.state::<Mutex<RecordingRuntime>>()
        .lock()
        .map(|runtime| match runtime.snapshot().status {
            "selecting" => "Recording picker…".into(),
            "recording" => "Recording controls…".into(),
            "finalizing" => "Finishing recording…".into(),
            _ => "Record Screen…".into(),
        })
        .unwrap_or_else(|_| "Record Screen…".into())
}

#[tauri::command]
pub(crate) fn open_recording_studio(app: AppHandle) -> Result<(), String> {
    show_recording_studio(&app)
}

#[tauri::command]
pub(crate) fn hide_recording_studio(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(RECORDING_STUDIO_LABEL)
        .ok_or_else(|| "The recording studio window is unavailable.".to_string())?
        .hide()
        .map_err(|error| format!("Could not hide recording controls: {error}"))
}

#[tauri::command]
pub(crate) fn get_recording_capabilities() -> RecordingCapabilities {
    recording_capabilities()
}

#[cfg(target_os = "macos")]
fn request_microphone_access_blocking() -> Result<(), String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    if microphone_permission() != MicrophonePermission::NotDetermined {
        return Ok(());
    }
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return Err("Microphone access is unavailable on this Mac.".into());
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let completion = RcBlock::new(move |granted: Bool| {
        let _ = sender.send(granted.as_bool());
    });
    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &completion);
    }
    receiver
        .recv_timeout(Duration::from_secs(120))
        .map_err(|_| "The microphone permission request did not finish in time.".to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn request_microphone_access_blocking() -> Result<(), String> {
    Err("Microphone access is available only in the macOS app.".into())
}

#[tauri::command]
pub(crate) async fn request_recording_microphone_access() -> Result<RecordingCapabilities, String> {
    tauri::async_runtime::spawn_blocking(request_microphone_access_blocking)
        .await
        .map_err(|error| {
            format!("The microphone permission task stopped unexpectedly: {error}")
        })??;
    Ok(recording_capabilities())
}

#[tauri::command]
pub(crate) fn open_recording_microphone_settings() -> Result<(), String> {
    tauri_plugin_opener::open_url(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        None::<&str>,
    )
    .map_err(|error| format!("Could not open Microphone settings: {error}"))
}

#[tauri::command]
pub(crate) fn get_recording_status(
    app: AppHandle,
    state: State<'_, Mutex<RecordingRuntime>>,
) -> Result<RecordingSnapshot, String> {
    let snapshot = state
        .lock()
        .map(|runtime| runtime.snapshot())
        .map_err(|_| "The recording state is temporarily unavailable.".to_string())?;
    Ok(snapshot_with_history(&app, snapshot))
}

#[tauri::command]
pub(crate) fn start_recording(
    app: AppHandle,
    state: State<'_, Mutex<RecordingRuntime>>,
    request: RecordingRequest,
) -> Result<RecordingSnapshot, String> {
    validate_recording_request(&request)?;
    let capabilities = recording_capabilities();
    microphone_argument(
        request.microphone,
        request.microphone_device_id.as_deref(),
        capabilities.microphone_permission,
        &capabilities.microphone_devices,
    )?;
    if !crate::system::screen_recording_granted() {
        return Err("Grant Screen Recording before starting a video.".into());
    }
    let mut runtime = state
        .lock()
        .map_err(|_| "The recording state is temporarily unavailable.".to_string())?;
    if runtime.active.is_some() || runtime.finalizing {
        return Err("A Capso recording is already active.".into());
    }
    let id = Uuid::new_v4().to_string();
    let (source_path, output_path) = recording_paths(&app, &id)?;
    let desktop_clutter_lease = if request.hide_desktop_icons {
        begin_recording_desktop_clutter(&app)?
    } else {
        false
    };
    let mut child = Command::new("/usr/sbin/screencapture")
        .args(recording_arguments(&request, &source_path))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            let restoration = if desktop_clutter_lease {
                restore_recording_desktop_clutter(&app).map(|_| ())
            } else {
                Ok(())
            };
            match restoration {
                Ok(()) => format!("Could not start macOS screen recording: {error}"),
                Err(restore_error) => format!(
                    "Could not start macOS screen recording, and desktop icons still need recovery: {error}; {restore_error}"
                ),
            }
        })?;
    let pid = child.id();
    let snapshot = match runtime.begin(pid, request, source_path, output_path) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = child.kill();
            let restoration = if desktop_clutter_lease {
                restore_recording_desktop_clutter(&app).map(|_| ())
            } else {
                Ok(())
            };
            return match restoration {
                Ok(()) => Err(error),
                Err(restore_error) => Err(format!(
                    "{error}; desktop icons still need recovery: {restore_error}"
                )),
            };
        }
    };
    drop(runtime);
    if let Some(window) = app.get_webview_window(RECORDING_STUDIO_LABEL) {
        let _ = window.hide();
    }
    emit_snapshot(&app, &snapshot, false);
    let monitor_app = app.clone();
    thread::spawn(move || monitor_recording(monitor_app, child, snapshot.session_id.unwrap_or(0)));
    Ok(snapshot_with_history(&app, snapshot))
}

#[tauri::command]
pub(crate) fn stop_recording(
    state: State<'_, Mutex<RecordingRuntime>>,
    session_id: u64,
) -> Result<bool, String> {
    let pid = state
        .lock()
        .map_err(|_| "The recording state is temporarily unavailable.".to_string())?
        .active_for_stop(session_id)?
        .pid;
    let status = Command::new("/bin/kill")
        .arg("-INT")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Could not stop the recording safely: {error}"))?;
    if !status.success() {
        return Err(
            "macOS did not accept the stop request; the recording may already be finishing.".into(),
        );
    }
    Ok(true)
}

fn exact_history_output<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    let output = scan_recording_history(&recordings_directory(app)?)?
        .into_iter()
        .find(|output| output.id == id)
        .ok_or_else(|| "That local recording is no longer in Capso history.".to_string())?;
    let path = PathBuf::from(&output.path);
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("The finished recording is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.len() != output.bytes {
        return Err("The finished recording changed after Capso published it.".into());
    }
    Ok(path)
}

#[tauri::command]
pub(crate) fn open_recording_output(app: AppHandle, id: String) -> Result<(), String> {
    let path = exact_history_output(&app, &id)?;
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("Could not open the finished recording: {error}"))
}

#[tauri::command]
pub(crate) fn reveal_recording_output(app: AppHandle, id: String) -> Result<(), String> {
    let path = exact_history_output(&app, &id)?;
    let status = Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Could not reveal the finished recording: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Finder could not reveal the finished recording.".into())
    }
}

#[tauri::command]
pub(crate) async fn trim_recording(
    app: AppHandle,
    state: State<'_, Mutex<RecordingRuntime>>,
    id: String,
    start_ms: u64,
    end_ms: u64,
    quality: RecordingQuality,
) -> Result<RecordingOutput, String> {
    if recording_file_kind(&id) != Some("mp4") {
        return Err("Only a finished Capso MP4 can be trimmed.".into());
    }
    let source = exact_history_output(&app, &id)?;
    trim_arguments(&source, Path::new("trim.mp4"), start_ms, end_ms, quality)?;
    let output = recordings_directory(&app)?.join(format!("{}.mp4", Uuid::new_v4()));
    let export_generation = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The recording state is temporarily unavailable.".to_string())?;
        runtime.begin_local_export()?
    };
    let starting = state
        .lock()
        .map_err(|_| "The recording state is temporarily unavailable.".to_string())?
        .snapshot();
    emit_snapshot(&app, &starting, true);
    let trim_result = match tauri::async_runtime::spawn_blocking(move || {
        trim_mp4(&source, &output, start_ms, end_ms, quality)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!(
            "The local video trim task stopped unexpectedly: {error}"
        )),
    };
    let (result, state_result) = match trim_result {
        Ok(output) => (Ok(output.clone()), RecordingResultState::Completed(output)),
        Err(message) => (
            Err(message.clone()),
            RecordingResultState::Failed {
                message,
                recovery: None,
            },
        ),
    };
    let snapshot = state
        .lock()
        .map_err(|_| "The recording state is temporarily unavailable.".to_string())?
        .finish(state_result, export_generation);
    emit_snapshot(&app, &snapshot, true);
    result
}

#[tauri::command]
pub(crate) async fn export_recording_gif(
    app: AppHandle,
    state: State<'_, Mutex<RecordingRuntime>>,
    id: String,
    start_ms: u64,
    end_ms: u64,
    width: u16,
    frames_per_second: u8,
    loop_forever: bool,
) -> Result<RecordingOutput, String> {
    if recording_file_kind(&id) != Some("mp4") {
        return Err("Only a finished Capso MP4 can become a GIF copy.".into());
    }
    let plan = gif_frame_plan(start_ms, end_ms, width, frames_per_second)?;
    let source = exact_history_output(&app, &id)?;
    let output = recordings_directory(&app)?.join(format!("{}.gif", Uuid::new_v4()));
    let export_generation = {
        let mut runtime = state
            .lock()
            .map_err(|_| "The recording state is temporarily unavailable.".to_string())?;
        runtime.begin_local_export()?
    };
    let starting = state
        .lock()
        .map_err(|_| "The recording state is temporarily unavailable.".to_string())?
        .snapshot();
    emit_snapshot(&app, &starting, true);
    let export_result = match tauri::async_runtime::spawn_blocking(move || {
        export_gif_mp4(&source, &output, &plan, loop_forever)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!(
            "The local GIF export task stopped unexpectedly: {error}"
        )),
    };
    let (result, state_result) = match export_result {
        Ok(output) => (Ok(output.clone()), RecordingResultState::Completed(output)),
        Err(message) => (
            Err(message.clone()),
            RecordingResultState::Failed {
                message,
                recovery: None,
            },
        ),
    };
    let snapshot = state
        .lock()
        .map_err(|_| "The recording state is temporarily unavailable.".to_string())?
        .finish(state_result, export_generation);
    emit_snapshot(&app, &snapshot, true);
    result
}

pub(crate) fn recover_interrupted_recordings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = recordings_directory(app)?;
    let in_progress = directory.join(IN_PROGRESS_DIRECTORY);
    let entries = match fs::read_dir(&in_progress) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect interrupted recordings: {error}")),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| Uuid::parse_str(value).ok())
            .map(|value| value.to_string())
        else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_RECORDING_BYTES {
            continue;
        }
        let recovery = directory.join(format!("{id}.interrupted.mov"));
        if !recovery.exists() {
            fs::rename(&path, &recovery)
                .map_err(|error| format!("Could not preserve an interrupted recording: {error}"))?;
        }
    }
    sync_parent(&directory.join("placeholder"))
}

#[cfg(test)]
mod tests {
    use super::{
        begin_desktop_clutter_lease, encode_gif_frames, gif_frame_plan, recording_arguments,
        recording_capabilities, recording_file_kind, restore_desktop_clutter,
        scan_recording_history, trim_arguments, validate_gif, validate_mp4, DesktopClutterSystem,
        FinderDesktopPreference, GifRgbaFrame, MicrophonePermission, RecordingAudioDevice,
        RecordingMode, RecordingQuality, RecordingRequest, RecordingResultState, RecordingRuntime,
        MAX_GIF_FRAMES, MAX_RECORDING_HISTORY,
    };
    use std::{fs, path::PathBuf};
    use tempfile::tempdir;

    #[derive(Default)]
    struct FakeDesktopClutterSystem {
        preference: Option<FinderDesktopPreference>,
        writes: Vec<FinderDesktopPreference>,
        refreshes: usize,
    }

    impl DesktopClutterSystem for FakeDesktopClutterSystem {
        fn read_preference(&mut self) -> Result<FinderDesktopPreference, String> {
            Ok(self
                .preference
                .unwrap_or(FinderDesktopPreference::Inherited))
        }

        fn write_preference(&mut self, preference: FinderDesktopPreference) -> Result<(), String> {
            self.preference = Some(preference);
            self.writes.push(preference);
            Ok(())
        }

        fn refresh_finder(&mut self) -> Result<(), String> {
            self.refreshes += 1;
            Ok(())
        }
    }

    #[test]
    fn desktop_clutter_lease_restores_the_exact_inherited_finder_preference_after_restart() {
        let root = tempdir().expect("temporary app data");
        let mut system = FakeDesktopClutterSystem::default();

        assert!(begin_desktop_clutter_lease(root.path(), &mut system).expect("hide desktop icons"));
        assert_eq!(
            system.writes,
            [FinderDesktopPreference::Hidden],
            "the transaction hides only after saving a recovery marker"
        );
        assert_eq!(system.refreshes, 1);

        let mut restarted_system = FakeDesktopClutterSystem {
            preference: Some(FinderDesktopPreference::Hidden),
            ..Default::default()
        };
        assert!(
            restore_desktop_clutter(root.path(), &mut restarted_system).expect("restart recovery")
        );
        assert_eq!(
            restarted_system.writes,
            [FinderDesktopPreference::Inherited]
        );
        assert_eq!(restarted_system.refreshes, 1);
        assert!(!restore_desktop_clutter(root.path(), &mut restarted_system)
            .expect("recovery is idempotent"));
    }

    #[test]
    fn desktop_clutter_lease_never_overrides_a_desktop_the_user_already_hid() {
        let root = tempdir().expect("temporary app data");
        let mut system = FakeDesktopClutterSystem {
            preference: Some(FinderDesktopPreference::Hidden),
            ..Default::default()
        };

        assert!(!begin_desktop_clutter_lease(root.path(), &mut system)
            .expect("already hidden is a no-op"));
        assert!(system.writes.is_empty());
        assert_eq!(system.refreshes, 0);
        assert!(!restore_desktop_clutter(root.path(), &mut system)
            .expect("no recovery marker was created"));
    }

    fn request(
        mode: RecordingMode,
        microphone: bool,
        show_clicks: bool,
        show_cursor: bool,
    ) -> RecordingRequest {
        RecordingRequest {
            mode,
            quality: RecordingQuality::Source,
            microphone,
            microphone_device_id: None,
            show_clicks,
            show_cursor,
            hide_desktop_icons: false,
        }
    }

    #[test]
    fn recording_request_and_active_snapshot_preserve_the_desktop_clutter_choice() {
        let request: RecordingRequest = serde_json::from_value(serde_json::json!({
            "mode": "fullscreen",
            "quality": "source",
            "microphone": false,
            "showClicks": false,
            "showCursor": true,
            "hideDesktopIcons": true
        }))
        .expect("desktop cleanup is a strict recording request choice");
        let mut runtime = RecordingRuntime::default();
        let snapshot = runtime
            .begin(
                123,
                request,
                PathBuf::from("/private/source.mov"),
                PathBuf::from("/recordings/output.mp4"),
            )
            .expect("recording begins");

        assert_eq!(
            serde_json::to_value(snapshot).expect("snapshot serializes")["hideDesktopIcons"],
            true
        );
    }

    #[test]
    fn desktop_clutter_restore_failure_stays_visible_in_the_recording_snapshot() {
        let mut runtime = RecordingRuntime::default();
        runtime.note_desktop_clutter_warning("Finder did not restart".into());

        assert_eq!(
            serde_json::to_value(runtime.snapshot()).expect("warning snapshot serializes")
                ["desktopClutterWarning"],
            "Desktop icons could not be restored automatically. Quit and reopen Capso to retry: Finder did not restart"
        );
    }

    #[test]
    fn active_recording_owns_a_bounded_menu_bar_timer_until_finalizing() {
        let mut runtime = RecordingRuntime::default();
        let selecting = runtime
            .begin(
                123,
                request(RecordingMode::Fullscreen, false, false, true),
                PathBuf::from("/private/source.mov"),
                PathBuf::from("/recordings/output.mp4"),
            )
            .expect("recording picker begins");
        let session_id = selecting.session_id.expect("active session");

        assert_eq!(runtime.tray_title(9_999), None);
        runtime
            .mark_started(session_id, 10_000)
            .expect("recording starts");
        assert_eq!(runtime.tray_title(10_000).as_deref(), Some("00:00"));
        assert_eq!(runtime.tray_title(69_999).as_deref(), Some("00:59"));
        assert_eq!(runtime.tray_title(70_000).as_deref(), Some("01:00"));
        assert_eq!(runtime.tray_title(3_610_000).as_deref(), Some("1:00:00"));
        assert_eq!(
            runtime.tray_title(99_999_999).as_deref(),
            Some("2:00:00"),
            "the visible timer never exceeds the native two-hour recording limit"
        );
        runtime
            .begin_finalizing(session_id)
            .expect("recording stops");
        assert_eq!(runtime.tray_title(3_610_000), None);
    }

    #[test]
    fn export_quality_has_one_strict_native_preset_per_visible_choice() {
        assert_eq!(RecordingQuality::Source.preset(), "PresetHighestQuality");
        assert_eq!(RecordingQuality::FullHd.preset(), "Preset1920x1080");
        assert_eq!(RecordingQuality::Hd.preset(), "Preset1280x720");
    }

    #[test]
    fn trim_arguments_use_exact_milliseconds_and_reject_empty_or_unbounded_ranges() {
        assert_eq!(
            trim_arguments(
                PathBuf::from("/recordings/source.mp4").as_path(),
                PathBuf::from("/recordings/trimmed.mp4").as_path(),
                1_250,
                5_000,
                RecordingQuality::FullHd,
            )
            .expect("exact trim arguments"),
            [
                "--source",
                "/recordings/source.mp4",
                "--preset",
                "Preset1920x1080",
                "--output",
                "/recordings/trimmed.mp4",
                "--start",
                "1.250",
                "--duration",
                "3.750",
            ]
        );
        assert!(trim_arguments(
            PathBuf::from("/recordings/source.mp4").as_path(),
            PathBuf::from("/recordings/trimmed.mp4").as_path(),
            500,
            500,
            RecordingQuality::Source,
        )
        .is_err());
        assert!(trim_arguments(
            PathBuf::from("/recordings/source.mp4").as_path(),
            PathBuf::from("/recordings/trimmed.mp4").as_path(),
            0,
            7_200_001,
            RecordingQuality::Hd,
        )
        .is_err());
    }

    #[test]
    fn gif_frame_plan_preserves_exact_range_timing_and_hard_limits() {
        let plan = gif_frame_plan(1_250, 2_500, 720, 8).expect("bounded GIF plan");
        assert_eq!(plan.width, 720);
        assert_eq!(plan.frames.len(), 10);
        assert_eq!(plan.frames.first().unwrap().timestamp_ms, 1_250);
        assert_eq!(plan.frames.last().unwrap().timestamp_ms, 2_375);
        assert_eq!(
            plan.frames
                .iter()
                .map(|frame| usize::from(frame.delay_centiseconds))
                .sum::<usize>(),
            125
        );
        assert_eq!(
            gif_frame_plan(0, 30_000, 960, 15)
                .expect("maximum GIF plan")
                .frames
                .len(),
            MAX_GIF_FRAMES
        );
        assert!(gif_frame_plan(0, 30_001, 720, 12).is_err());
        assert!(gif_frame_plan(0, 1_000, 721, 12).is_err());
        assert!(gif_frame_plan(0, 1_000, 720, 30).is_err());
        assert!(gif_frame_plan(1_000, 1_000, 720, 12).is_err());
    }

    #[test]
    fn gif_encoder_atomically_creates_a_valid_loop_without_touching_the_source() {
        let directory = tempdir().expect("temporary GIF export");
        let source = directory.path().join("source.mp4");
        let output = directory
            .path()
            .join(format!("{}.gif", uuid::Uuid::new_v4()));
        fs::write(&source, b"protected source bytes").expect("source fixture");
        let source_before = fs::read(&source).expect("source before GIF");
        let plan = gif_frame_plan(0, 500, 480, 8).expect("GIF plan");
        let mut decoded_timestamps = Vec::new();

        let bytes = encode_gif_frames(&output, &plan, true, |timestamp_ms| {
            decoded_timestamps.push(timestamp_ms);
            let value = u8::try_from(timestamp_ms / 125).unwrap_or_default();
            Ok(GifRgbaFrame {
                width: 2,
                height: 1,
                pixels: vec![value, 24, 48, 255, 240, value, 96, 255],
            })
        })
        .expect("atomic GIF export");

        assert_eq!(decoded_timestamps, [0, 125, 250, 375]);
        assert_eq!(validate_gif(&output).expect("published GIF"), bytes);
        let encoded = fs::read(&output).expect("read GIF");
        assert!(encoded.starts_with(b"GIF89a"));
        assert!(encoded.windows(11).any(|window| window == b"NETSCAPE2.0"));
        assert_eq!(encoded.last(), Some(&0x3b));
        assert!(!output.with_extension("partial.gif").exists());
        assert_eq!(fs::read(&source).expect("source after GIF"), source_before);
    }

    #[test]
    fn gif_encoder_removes_partial_output_when_a_later_frame_is_invalid() {
        let directory = tempdir().expect("temporary failed GIF export");
        let output = directory
            .path()
            .join(format!("{}.gif", uuid::Uuid::new_v4()));
        let plan = gif_frame_plan(0, 500, 480, 8).expect("GIF plan");
        let result = encode_gif_frames(&output, &plan, false, |timestamp_ms| {
            if timestamp_ms == 0 {
                Ok(GifRgbaFrame {
                    width: 2,
                    height: 1,
                    pixels: vec![20, 40, 60, 255, 80, 100, 120, 255],
                })
            } else {
                Ok(GifRgbaFrame {
                    width: 1,
                    height: 1,
                    pixels: vec![20, 40, 60, 255],
                })
            }
        });

        assert!(result.is_err());
        assert!(!output.exists());
        assert!(!output.with_extension("partial.gif").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "manual Apple H.264 decode smoke; set CAPSO_GIF_SMOKE_MP4 to a disposable fixture"]
    fn native_avfoundation_decodes_a_real_h264_mp4_into_a_valid_gif() {
        let source = std::env::var_os("CAPSO_GIF_SMOKE_MP4")
            .map(PathBuf::from)
            .expect("CAPSO_GIF_SMOKE_MP4 fixture path");
        validate_mp4(&source).expect("H.264 fixture");
        let source_before = fs::read(&source).expect("fixture before export");
        let directory = tempdir().expect("native GIF output");
        let output = directory
            .path()
            .join(format!("{}.gif", uuid::Uuid::new_v4()));
        let plan = gif_frame_plan(0, 1_000, 480, 8).expect("native GIF plan");

        let exported =
            super::export_gif_mp4(&source, &output, &plan, true).expect("Apple-decoded GIF export");

        assert_eq!(exported.format, "gif");
        assert_eq!(validate_gif(&output).expect("native GIF"), exported.bytes);
        assert_eq!(
            fs::read(&source).expect("fixture after export"),
            source_before
        );
    }

    #[test]
    fn local_trim_export_shares_the_recording_single_flight_lease() {
        let mut runtime = RecordingRuntime::default();
        let generation = runtime.begin_local_export().expect("local trim lease");
        assert_eq!(runtime.snapshot().status, "finalizing");
        assert!(runtime.begin_local_export().is_err());
        assert!(runtime
            .begin(
                123,
                request(RecordingMode::Area, false, false, true),
                PathBuf::from("/private/source.mov"),
                PathBuf::from("/recordings/output.mp4"),
            )
            .is_err());
        assert_eq!(
            runtime
                .finish(RecordingResultState::Cancelled, generation)
                .status,
            "cancelled"
        );
        assert!(runtime.begin_local_export().is_ok());
    }

    #[test]
    fn native_arguments_are_bounded_and_include_only_explicit_audio_click_and_cursor_choices() {
        assert_eq!(
            recording_arguments(
                &request(RecordingMode::Area, true, true, true),
                PathBuf::from("/private/session.mov").as_path(),
            ),
            [
                "-v",
                "-V7200",
                "-i",
                "-Jvideo",
                "-g",
                "-k",
                "-x",
                "/private/session.mov",
            ]
        );
        assert_eq!(
            recording_arguments(
                &request(RecordingMode::Window, false, true, true),
                PathBuf::from("/private/window.mov").as_path(),
            ),
            [
                "-v",
                "-V7200",
                "-i",
                "-w",
                "-Jwindow",
                "-k",
                "-x",
                "/private/window.mov",
            ]
        );
        assert_eq!(
            recording_arguments(
                &request(RecordingMode::Fullscreen, false, false, true),
                PathBuf::from("/private/full.mov").as_path(),
            ),
            ["-v", "-V7200", "-D1", "-C", "-x", "/private/full.mov"]
        );
        assert_eq!(
            recording_arguments(
                &request(RecordingMode::Fullscreen, false, false, false),
                PathBuf::from("/private/no-cursor.mov").as_path(),
            ),
            ["-v", "-V7200", "-D1", "-x", "/private/no-cursor.mov"]
        );
        assert!(super::validate_recording_request(&request(
            RecordingMode::Area,
            false,
            false,
            false,
        ))
        .is_err());

        let mut selected = request(RecordingMode::Fullscreen, true, false, true);
        selected.microphone_device_id = Some("usb-mic".into());
        assert!(
            recording_arguments(&selected, PathBuf::from("/private/source.mov").as_path())
                .contains(&"-Gusb-mic".to_string())
        );
    }

    #[test]
    fn microphone_source_requires_permission_and_one_exact_live_device() {
        let devices = vec![
            RecordingAudioDevice {
                id: "built-in".into(),
                name: "MacBook Microphone".into(),
                is_default: true,
            },
            RecordingAudioDevice {
                id: "usb-mic".into(),
                name: "USB Microphone".into(),
                is_default: false,
            },
        ];
        assert_eq!(
            super::microphone_argument(
                false,
                Some("usb-mic"),
                MicrophonePermission::Denied,
                &devices
            )
            .expect("disabled microphone never requests access"),
            None
        );
        assert_eq!(
            super::microphone_argument(true, None, MicrophonePermission::Authorized, &devices)
                .expect("system default microphone"),
            Some("-g".into())
        );
        assert_eq!(
            super::microphone_argument(
                true,
                Some("usb-mic"),
                MicrophonePermission::Authorized,
                &devices,
            )
            .expect("exact connected microphone"),
            Some("-Gusb-mic".into())
        );
        assert!(super::microphone_argument(
            true,
            Some("disconnected"),
            MicrophonePermission::Authorized,
            &devices,
        )
        .is_err());
        assert!(super::microphone_argument(
            true,
            None,
            MicrophonePermission::NotDetermined,
            &devices,
        )
        .is_err());
        assert!(
            super::microphone_argument(true, None, MicrophonePermission::Denied, &devices,)
                .is_err()
        );
    }

    #[test]
    fn native_microphone_capabilities_are_bounded_and_privacy_safe() {
        let capabilities = recording_capabilities();
        assert!(capabilities.microphone_devices.len() <= 32);
        for device in capabilities.microphone_devices {
            assert!(!device.id.is_empty());
            assert!(device.id.chars().count() <= 512);
            assert!(!device.id.chars().any(char::is_control));
            assert!(!device.name.is_empty());
            assert!(device.name.chars().count() <= 128);
            assert!(!device.name.chars().any(char::is_control));
        }
    }

    #[test]
    fn runtime_is_single_flight_and_rejects_stale_stop_identity() {
        let mut runtime = RecordingRuntime::default();
        let snapshot = runtime
            .begin(
                123,
                request(RecordingMode::Area, false, false, true),
                PathBuf::from("/private/source.mov"),
                PathBuf::from("/recordings/output.mp4"),
            )
            .expect("first recording");
        let session_id = snapshot.session_id.unwrap();
        assert_eq!(snapshot.status, "selecting");
        assert!(runtime
            .begin(
                456,
                request(RecordingMode::Fullscreen, false, false, true),
                PathBuf::from("/private/other.mov"),
                PathBuf::from("/recordings/other.mp4"),
            )
            .is_err());
        assert!(runtime.active_for_stop(session_id + 1).is_err());
        assert_eq!(
            runtime.mark_started(session_id, 99).unwrap().status,
            "recording"
        );
        assert!(runtime.mark_started(session_id, 100).is_none());
    }

    #[test]
    fn mp4_validation_checks_a_bounded_iso_container_without_loading_the_video() {
        let directory = tempdir().expect("temporary video");
        let path = directory.path().join("recording.mp4");
        fs::write(
            &path,
            [0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'],
        )
        .expect("container-only header");
        assert!(
            validate_mp4(&path).is_err(),
            "an MP4 container alone is not proof of H.264"
        );
        fs::write(
            &path,
            [
                0, 0, 0, 28, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', b'a', b'v', b'c', b'1',
            ],
        )
        .expect("H.264 MP4 header");
        assert_eq!(validate_mp4(&path).unwrap(), 16);
        fs::write(&path, b"not an mp4!").expect("invalid video");
        assert!(validate_mp4(&path).is_err());
    }

    #[test]
    fn local_history_is_canonical_newest_first_bounded_and_restart_readable() {
        let directory = tempdir().expect("temporary recording history");
        let mp4 = [
            0, 0, 0, 28, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', b'a', b'v', b'c', b'1',
        ];
        for value in 1..=MAX_RECORDING_HISTORY + 2 {
            let id = uuid::Uuid::from_u128(value as u128).to_string();
            fs::write(directory.path().join(format!("{id}.mp4")), mp4).expect("recording fixture");
        }
        let recovery_id = uuid::Uuid::from_u128(500).to_string();
        fs::write(
            directory.path().join(format!("{recovery_id}.recovery.mov")),
            b"recoverable mov",
        )
        .expect("recovery fixture");
        fs::write(directory.path().join("not-a-capso-id.mp4"), mp4)
            .expect("invalid identity fixture");
        fs::write(directory.path().join("partial.partial.mp4"), mp4).expect("partial fixture");

        let history = scan_recording_history(directory.path()).expect("restart history");
        assert_eq!(history.len(), MAX_RECORDING_HISTORY);
        assert!(history.iter().all(|entry| entry.bytes > 0));
        assert!(history
            .windows(2)
            .all(|pair| pair[0].modified_at_ms >= pair[1].modified_at_ms));
        assert!(history.iter().all(|entry| entry.id != "not-a-capso-id.mp4"));
        assert!(recording_file_kind(&format!("{recovery_id}.recovery.mov")).is_some());
        assert!(recording_file_kind("partial.partial.mp4").is_none());
    }
}
