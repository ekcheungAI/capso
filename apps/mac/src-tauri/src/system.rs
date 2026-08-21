use crate::capture::CaptureMode;
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::process::Command;

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
pub(crate) enum ScreenRecordingIdentity {
    Stable,
    BuildSpecific,
    Unknown,
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
    pub(crate) screen_recording_identity: ScreenRecordingIdentity,
    pub(crate) launch_at_login: LoginItemStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CapturePermission {
    Allowed,
    RequiresScreenRecording,
}

#[derive(Debug)]
pub(crate) struct PermissionRuntime {
    request_attempted: bool,
    screen_recording_identity: ScreenRecordingIdentity,
}

impl Default for PermissionRuntime {
    fn default() -> Self {
        Self {
            request_attempted: false,
            screen_recording_identity: current_screen_recording_identity(),
        }
    }
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
            screen_recording_identity: self.screen_recording_identity,
            launch_at_login: launch_at_login_status(),
        }
    }
}

fn normalized_designated_requirement(output: &str) -> Option<String> {
    let line = output.lines().find(|line| line.contains("designated =>"))?;
    let requirement = &line[line.find("designated =>")?..];
    Some(
        requirement
            .replace("/* exists */", "exists")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn has_supported_designated_requirement(
    output: &str,
    identifier: &str,
    team_identifier: &str,
    apple_development_authority: Option<&str>,
) -> bool {
    let Some(actual) = normalized_designated_requirement(output) else {
        return false;
    };
    let developer_id_requirement = [
        team_identifier.to_owned(),
        format!("\"{team_identifier}\""),
    ]
    .into_iter()
    .any(|team_value| {
        actual
            == format!(
                "designated => identifier \"{identifier}\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = {team_value}"
            )
    });
    let apple_development_requirement = apple_development_authority.is_some_and(|authority| {
        actual
            == format!(
                "designated => identifier \"{identifier}\" and anchor apple generic and certificate leaf[subject.CN] = \"{authority}\" and certificate 1[field.1.2.840.113635.100.6.2.1] exists"
            )
    });
    developer_id_requirement || apple_development_requirement
}

fn screen_recording_identity_from_codesign_output(
    details: &str,
    designated_requirement: &str,
    details_succeeded: bool,
    requirement_succeeded: bool,
    integrity_succeeded: bool,
) -> ScreenRecordingIdentity {
    if details.contains("Signature=adhoc")
        || details.contains("TeamIdentifier=not set")
        || designated_requirement
            .to_ascii_lowercase()
            .contains("cdhash")
    {
        return ScreenRecordingIdentity::BuildSpecific;
    }

    if !details_succeeded || !requirement_succeeded || !integrity_succeeded {
        return ScreenRecordingIdentity::Unknown;
    }

    let team_identifier = details
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|value| {
            value.len() == 10
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        });
    let has_expected_identifier = details
        .lines()
        .any(|line| line.trim() == "Identifier=com.capso.app");
    let apple_development_authority = details
        .lines()
        .find_map(|line| line.strip_prefix("Authority=Apple Development:"))
        .map(str::trim)
        .map(|authority| format!("Apple Development: {authority}"));
    let has_stable_requirement = team_identifier.is_some_and(|team_identifier| {
        has_supported_designated_requirement(
            designated_requirement,
            "com.capso.app",
            team_identifier,
            apple_development_authority.as_deref(),
        )
    });
    if team_identifier.is_some() && has_expected_identifier && has_stable_requirement {
        ScreenRecordingIdentity::Stable
    } else {
        ScreenRecordingIdentity::Unknown
    }
}

#[cfg(target_os = "macos")]
fn current_screen_recording_identity() -> ScreenRecordingIdentity {
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(_) => return ScreenRecordingIdentity::Unknown,
    };
    let details = match Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=4"])
        .arg(&executable)
        .output()
    {
        Ok(output) => output,
        Err(_) => return ScreenRecordingIdentity::Unknown,
    };
    let details_diagnostic = format!(
        "{}{}",
        String::from_utf8_lossy(&details.stdout),
        String::from_utf8_lossy(&details.stderr)
    );
    let requirement = match Command::new("/usr/bin/codesign")
        .args(["-dr", "-"])
        .arg(&executable)
        .output()
    {
        Ok(output) => output,
        Err(_) => return ScreenRecordingIdentity::Unknown,
    };
    let requirement_diagnostic = format!(
        "{}{}",
        String::from_utf8_lossy(&requirement.stdout),
        String::from_utf8_lossy(&requirement.stderr)
    );
    let integrity = match Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "--verbose=2"])
        .arg(&executable)
        .output()
    {
        Ok(output) => output,
        Err(_) => return ScreenRecordingIdentity::Unknown,
    };
    screen_recording_identity_from_codesign_output(
        &details_diagnostic,
        &requirement_diagnostic,
        details.status.success(),
        requirement.status.success(),
        integrity.status.success(),
    )
}

#[cfg(not(target_os = "macos"))]
fn current_screen_recording_identity() -> ScreenRecordingIdentity {
    ScreenRecordingIdentity::Unknown
}

pub(crate) fn permission_for_capture(
    _mode: CaptureMode,
    screen_recording_granted: bool,
) -> CapturePermission {
    if screen_recording_granted {
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
        login_item_status_from_raw, permission_for_capture,
        screen_recording_identity_from_codesign_output, CapturePermission, LoginItemStatus,
        PermissionRuntime, ScreenRecordingIdentity,
    };
    use crate::capture::CaptureMode;

    #[test]
    fn every_capture_mode_is_gated_without_screen_recording_permission() {
        for mode in [
            CaptureMode::Region,
            CaptureMode::Window,
            CaptureMode::Fullscreen,
        ] {
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
    fn ad_hoc_codesign_output_is_build_specific() {
        assert_eq!(
            screen_recording_identity_from_codesign_output(
                "Identifier=com.capso.app\nSignature=adhoc\nTeamIdentifier=not set\n",
                "designated => cdhash H\"abc\"",
                true,
                true,
                true,
            ),
            ScreenRecordingIdentity::BuildSpecific
        );
    }

    #[test]
    fn team_signed_codesign_output_is_stable() {
        assert_eq!(
            screen_recording_identity_from_codesign_output(
                "Identifier=com.capso.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
                "Executable=/Applications/Capso.app/Contents/MacOS/Capso\ndesignated => identifier \"com.capso.app\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ABCDE12345",
                true,
                true,
                true,
            ),
            ScreenRecordingIdentity::Stable
        );
    }

    #[test]
    fn apple_development_codesign_output_is_stable_and_bound_to_common_name() {
        let details = "Identifier=com.capso.app\nAuthority=Apple Development: Example Person (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
        let requirement = "designated => identifier \"com.capso.app\" and anchor apple generic and certificate leaf[subject.CN] = \"Apple Development: Example Person (ABCDE12345)\" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */";
        assert_eq!(
            screen_recording_identity_from_codesign_output(details, requirement, true, true, true,),
            ScreenRecordingIdentity::Stable
        );
        assert_ne!(
            screen_recording_identity_from_codesign_output(
                details,
                &requirement.replace("Example Person", "Another Person"),
                true,
                true,
                true,
            ),
            ScreenRecordingIdentity::Stable
        );
    }

    #[test]
    fn missing_or_failed_codesign_output_is_unknown() {
        assert_eq!(
            screen_recording_identity_from_codesign_output("", "", false, false, false),
            ScreenRecordingIdentity::Unknown
        );
        assert_eq!(
            screen_recording_identity_from_codesign_output(
                "Identifier=com.capso.app\nTeamIdentifier=ABCDE12345\n",
                "designated => identifier \"com.capso.app\" and anchor apple generic",
                false,
                true,
                true,
            ),
            ScreenRecordingIdentity::Unknown
        );
        let details = "Identifier=com.capso.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
        let requirement = "designated => identifier \"com.capso.app\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ABCDE12345";
        assert_eq!(
            screen_recording_identity_from_codesign_output(details, requirement, true, true, false,),
            ScreenRecordingIdentity::Unknown
        );
    }

    #[test]
    fn team_id_without_a_stable_capso_requirement_is_not_stable() {
        let details =
            "Identifier=com.capso.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
        for requirement in [
            "",
            "designated => identifier only",
            "designated => identifier \"com.other.app\" and anchor apple generic",
            "designated => identifier \"com.capso.app\" and anchor apple generic and cdhash H\"abc\"",
            "designated => identifier \"com.capso.app\" and anchor apple generic",
            "designated => identifier \"com.capso.app\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = OTHER12345",
            "designated => identifier \"com.capso.app\" or anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ABCDE12345",
        ] {
            assert_ne!(
                screen_recording_identity_from_codesign_output(
                    details,
                    requirement,
                    true,
                    true,
                    true,
                ),
                ScreenRecordingIdentity::Stable,
            );
        }
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
