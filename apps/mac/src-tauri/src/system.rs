use crate::capture::CaptureMode;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

const MAX_CAPTURE_ACCESS_PREFERENCE_BYTES: usize = 1_024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureAccessPreference {
    area_only: bool,
}

pub(crate) fn load_area_only_preference(path: &Path) -> Result<bool, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not read the capture access choice: {error}")),
    };
    if bytes.len() > MAX_CAPTURE_ACCESS_PREFERENCE_BYTES {
        return Err("The saved capture access choice is too large to trust.".into());
    }
    serde_json::from_slice::<CaptureAccessPreference>(&bytes)
        .map(|preference| preference.area_only)
        .map_err(|error| format!("The saved capture access choice is invalid: {error}"))
}

pub(crate) fn store_area_only_preference(path: &Path, area_only: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The capture access choice has no settings directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Capso's settings directory: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&CaptureAccessPreference { area_only })
        .map_err(|error| format!("Could not encode the capture access choice: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not write the capture access choice: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not durably write the capture access choice: {error}"
        ));
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not activate the capture access choice: {error}"
        ));
    }
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not durably activate the capture access choice: {error}"))
}

#[cfg(target_os = "macos")]
use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};
#[cfg(target_os = "macos")]
use objc2_service_management::{SMAppService, SMAppServiceStatus};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ScreenRecordingStatus {
    Granted,
    Required,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LoginItemStatus {
    Disabled,
    Enabled,
    RequiresApproval,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemStatus {
    pub(crate) screen_recording: ScreenRecordingStatus,
    pub(crate) screen_recording_request_attempted: bool,
    pub(crate) area_only_capture: bool,
    pub(crate) launch_at_login: LoginItemStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CapturePermission {
    Allowed,
    RequiresScreenRecording,
}

#[derive(Debug, Default)]
pub(crate) struct PermissionRuntime {
    request_attempted: bool,
    area_only_capture: bool,
}

impl PermissionRuntime {
    pub(crate) fn should_request(&mut self, currently_granted: bool) -> bool {
        if currently_granted || self.request_attempted {
            return false;
        }

        // Mark first so even a failed or dismissed OS prompt cannot be repeated
        // automatically during this app session.
        self.request_attempted = true;
        true
    }

    pub(crate) fn set_area_only_capture(&mut self, enabled: bool) {
        self.area_only_capture = enabled;
    }

    pub(crate) fn status(&self) -> SystemStatus {
        SystemStatus {
            screen_recording: if screen_recording_granted() {
                ScreenRecordingStatus::Granted
            } else {
                ScreenRecordingStatus::Required
            },
            screen_recording_request_attempted: self.request_attempted,
            area_only_capture: self.area_only_capture,
            launch_at_login: launch_at_login_status(),
        }
    }
}

pub(crate) fn permission_for_capture(
    mode: CaptureMode,
    screen_recording_granted: bool,
) -> CapturePermission {
    if screen_recording_granted || matches!(mode, CaptureMode::Region) {
        CapturePermission::Allowed
    } else {
        CapturePermission::RequiresScreenRecording
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn screen_recording_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn screen_recording_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub(crate) fn request_screen_recording_access() -> bool {
    CGRequestScreenCaptureAccess()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn request_screen_recording_access() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn launch_at_login_status() -> LoginItemStatus {
    // SAFETY: mainAppService and status are macOS 13+ class/instance methods
    // with no borrowed Objective-C pointers crossing this boundary.
    let status = unsafe { SMAppService::mainAppService().status() };
    login_item_status_from_raw(status.0)
}

#[cfg(not(target_os = "macos"))]
fn launch_at_login_status() -> LoginItemStatus {
    LoginItemStatus::Unavailable
}

fn login_item_status_from_raw(status: isize) -> LoginItemStatus {
    match status {
        0 => LoginItemStatus::Disabled,
        1 => LoginItemStatus::Enabled,
        2 => LoginItemStatus::RequiresApproval,
        _ => LoginItemStatus::Unavailable,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn set_launch_at_login(enabled: bool) -> Result<LoginItemStatus, String> {
    // SAFETY: this returns the process' main-app login service on macOS 13+.
    // The retained service remains alive for each Objective-C call below.
    let service = unsafe { SMAppService::mainAppService() };
    let current = unsafe { service.status() };

    let result = if enabled {
        if current == SMAppServiceStatus::Enabled {
            Ok(())
        } else {
            // SAFETY: Apple documents this call for explicit user opt-in. Capso
            // never reaches it during startup or status preflight.
            unsafe { service.registerAndReturnError() }
        }
    } else if current == SMAppServiceStatus::NotRegistered {
        Ok(())
    } else {
        // SAFETY: unregistering the main app changes future login launches but
        // does not terminate the currently running main application.
        unsafe { service.unregisterAndReturnError() }
    };

    result.map_err(|error| {
        format!(
            "Could not {} launch at login: {}",
            if enabled { "enable" } else { "disable" },
            error.localizedDescription()
        )
    })?;

    Ok(launch_at_login_status())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_launch_at_login(_enabled: bool) -> Result<LoginItemStatus, String> {
    Err("Launch at login is only available in the macOS app".into())
}

pub(crate) fn open_screen_recording_settings() -> Result<(), String> {
    tauri_plugin_opener::open_url(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        None::<&str>,
    )
    .map_err(|error| format!("Could not open Screen Recording settings: {error}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn open_login_item_settings() {
    // SAFETY: this class method only navigates System Settings after a direct
    // user action; it does not register or mutate the login item.
    unsafe { SMAppService::openSystemSettingsLoginItems() }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn open_login_item_settings() {}

#[cfg(test)]
mod tests {
    use super::{
        load_area_only_preference, login_item_status_from_raw, permission_for_capture,
        store_area_only_preference, CapturePermission, LoginItemStatus, PermissionRuntime,
    };
    use crate::capture::CaptureMode;

    #[test]
    fn region_capture_remains_available_without_screen_recording_permission() {
        assert_eq!(
            permission_for_capture(CaptureMode::Region, false),
            CapturePermission::Allowed
        );
    }

    #[test]
    fn window_and_fullscreen_capture_are_gated_without_permission() {
        for mode in [CaptureMode::Window, CaptureMode::Fullscreen] {
            assert_eq!(
                permission_for_capture(mode, false),
                CapturePermission::RequiresScreenRecording
            );
        }
    }

    #[test]
    fn every_capture_mode_is_allowed_after_permission_is_granted() {
        for mode in [
            CaptureMode::Region,
            CaptureMode::Window,
            CaptureMode::Fullscreen,
        ] {
            assert_eq!(
                permission_for_capture(mode, true),
                CapturePermission::Allowed
            );
        }
    }

    #[test]
    fn os_permission_prompt_is_attempted_at_most_once_per_session() {
        let mut runtime = PermissionRuntime::default();

        assert!(runtime.should_request(false));
        assert!(!runtime.should_request(false));
        assert!(!runtime.should_request(true));
    }

    #[test]
    fn system_status_uses_the_native_area_only_choice_as_its_single_source_of_truth() {
        let mut runtime = PermissionRuntime::default();

        assert!(!runtime.status().area_only_capture);
        runtime.set_area_only_capture(true);
        assert!(runtime.status().area_only_capture);
        runtime.set_area_only_capture(false);
        assert!(!runtime.status().area_only_capture);
    }

    #[test]
    fn area_only_choice_survives_restart_and_can_be_cleared() {
        let root = tempfile::tempdir().expect("temporary settings directory");
        let path = root.path().join("capture-access.json");

        assert!(!load_area_only_preference(&path).expect("missing choice uses default"));
        store_area_only_preference(&path, true).expect("persist Area-only choice");
        assert!(load_area_only_preference(&path).expect("reload Area-only choice"));
        store_area_only_preference(&path, false).expect("clear Area-only choice");
        assert!(!load_area_only_preference(&path).expect("reload cleared choice"));
        assert!(!root.path().join("capture-access.json.tmp").exists());
    }

    #[test]
    fn corrupt_area_only_choice_fails_closed_to_permission_guidance() {
        let root = tempfile::tempdir().expect("temporary settings directory");
        let path = root.path().join("capture-access.json");
        std::fs::write(&path, b"not json").expect("corrupt fixture");

        assert!(load_area_only_preference(&path).is_err());
    }

    #[test]
    fn native_login_item_states_have_stable_product_meanings() {
        assert_eq!(login_item_status_from_raw(0), LoginItemStatus::Disabled);
        assert_eq!(login_item_status_from_raw(1), LoginItemStatus::Enabled);
        assert_eq!(
            login_item_status_from_raw(2),
            LoginItemStatus::RequiresApproval
        );
        assert_eq!(login_item_status_from_raw(3), LoginItemStatus::Unavailable);
        assert_eq!(login_item_status_from_raw(99), LoginItemStatus::Unavailable);
    }
}
