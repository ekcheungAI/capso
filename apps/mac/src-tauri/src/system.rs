use crate::capture::CaptureMode;
use serde::Serialize;

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

    pub(crate) fn status(&self) -> SystemStatus {
        SystemStatus {
            screen_recording: if screen_recording_granted() {
                ScreenRecordingStatus::Granted
            } else {
                ScreenRecordingStatus::Required
            },
            screen_recording_request_attempted: self.request_attempted,
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
        login_item_status_from_raw, permission_for_capture, CapturePermission, LoginItemStatus,
        PermissionRuntime,
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
