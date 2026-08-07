use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager};

static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CaptureMode {
    Region,
    Window,
    Fullscreen,
}

#[derive(Clone, Debug, PartialEq)]
enum StoredCaptureOutcome {
    Captured { path: PathBuf },
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum CaptureOutcome {
    Captured {
        path: String,
        clipboard: crate::clipboard::ClipboardStatus,
        overlay: crate::overlay::OverlayStatus,
    },
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct CaptureFailure {
    pub code: &'static str,
    pub message: String,
}

struct CaptureLease<'a> {
    flag: &'a AtomicBool,
}

impl<'a> CaptureLease<'a> {
    fn try_acquire(flag: &'a AtomicBool) -> Result<Self, CaptureFailure> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self { flag })
            .map_err(|_| CaptureFailure {
                code: "capture_in_progress",
                message: "Another screen capture is already in progress.".into(),
            })
    }
}

impl Drop for CaptureLease<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

#[derive(Debug)]
struct CaptureEvidence<'a> {
    output_bytes: Option<u64>,
    stderr: &'a str,
}

#[derive(Debug)]
struct ProcessResult {
    stderr: String,
}

trait CaptureRunner {
    fn run(&self, args: &[OsString]) -> io::Result<ProcessResult>;
}

struct SystemCaptureRunner;

impl CaptureRunner for SystemCaptureRunner {
    fn run(&self, args: &[OsString]) -> io::Result<ProcessResult> {
        let output = Command::new("/usr/sbin/screencapture")
            .args(args)
            .output()?;

        Ok(ProcessResult {
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

fn run_capture<R: CaptureRunner>(
    app_data: &Path,
    mode: CaptureMode,
    capture_id: &str,
    runner: &R,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    let output = capture_path(app_data, capture_id);
    let directory = output.parent().expect("capture path always has a parent");
    fs::create_dir_all(directory).map_err(|error| CaptureFailure {
        code: "storage_failed",
        message: format!("Could not create the capture directory: {error}"),
    })?;

    let process = runner
        .run(&screencapture_args(mode, &output))
        .map_err(|error| CaptureFailure {
            code: "capture_unavailable",
            message: format!("Could not start macOS screen capture: {error}"),
        })?;

    let output_bytes = match fs::metadata(&output) {
        Ok(metadata) => Some(metadata.len()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(CaptureFailure {
                code: "storage_failed",
                message: format!("Could not inspect the captured image: {error}"),
            });
        }
    };

    classify_capture(
        &output,
        CaptureEvidence {
            output_bytes,
            stderr: &process.stderr,
        },
    )
}

fn classify_capture(
    output: &Path,
    evidence: CaptureEvidence<'_>,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    if evidence.output_bytes.is_some_and(|bytes| bytes > 0) {
        return Ok(StoredCaptureOutcome::Captured {
            path: output.to_path_buf(),
        });
    }

    if evidence.output_bytes.is_none() && evidence.stderr.trim().is_empty() {
        return Ok(StoredCaptureOutcome::Cancelled);
    }

    if !evidence.stderr.trim().is_empty() {
        return Err(CaptureFailure {
            code: "capture_failed",
            message: evidence.stderr.trim().into(),
        });
    }

    if evidence.output_bytes == Some(0) {
        return Err(CaptureFailure {
            code: "empty_output",
            message: "Screen capture produced an empty image.".into(),
        });
    }

    Err(CaptureFailure {
        code: "capture_failed",
        message: "Screen capture ended without a usable image.".into(),
    })
}

fn screencapture_args(mode: CaptureMode, output: &Path) -> Vec<OsString> {
    let flags: &[&str] = match mode {
        CaptureMode::Region => &["-i", "-s", "-x", "-t", "png"],
        CaptureMode::Window => &["-i", "-w", "-x", "-t", "png"],
        CaptureMode::Fullscreen => &["-m", "-x", "-t", "png"],
    };

    flags
        .iter()
        .map(OsString::from)
        .chain([output.as_os_str().to_os_string()])
        .collect()
}

fn capture_path(app_data: &Path, capture_id: &str) -> PathBuf {
    app_data.join("captures").join(format!("{capture_id}.png"))
}

fn new_capture_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Runs macOS' native picker without occupying Tauri's async command executor.
///
/// Returning `cancelled` is intentional: Escape is a normal user outcome and
/// must not surface as an error toast. A completed result points at pixels that
/// have already been durably written inside the app data directory.
#[tauri::command]
pub(crate) async fn capture_screen(
    app: AppHandle,
    mode: CaptureMode,
) -> Result<CaptureOutcome, CaptureFailure> {
    let _capture_lease = CaptureLease::try_acquire(&CAPTURE_IN_PROGRESS)?;

    if crate::system::permission_for_capture(mode, crate::system::screen_recording_granted())
        == crate::system::CapturePermission::RequiresScreenRecording
    {
        return Err(CaptureFailure {
            code: "screen_recording_required",
            message: "Grant Screen Recording to capture windows or the full screen.".into(),
        });
    }

    let app_data = app.path().app_data_dir().map_err(|error| CaptureFailure {
        code: "storage_unavailable",
        message: format!("Could not locate Capso's data directory: {error}"),
    })?;
    let capture_id = new_capture_id();

    let stored = tauri::async_runtime::spawn_blocking(move || {
        run_capture(&app_data, mode, &capture_id, &SystemCaptureRunner)
    })
    .await
    .map_err(|error| CaptureFailure {
        code: "capture_task_failed",
        message: format!("The native capture task stopped unexpectedly: {error}"),
    })??;

    match stored {
        StoredCaptureOutcome::Cancelled => Ok(CaptureOutcome::Cancelled),
        StoredCaptureOutcome::Captured { path } => {
            let clipboard =
                crate::clipboard::copy_new_capture_to_general_pasteboard(app.clone(), path.clone())
                    .await;
            let overlay = crate::overlay::prepare_capture_overlay(&app, mode, &path, &clipboard);
            if let Err(error) = crate::refresh_tray_status(&app) {
                eprintln!("Could not refresh Capso's recent captures: {error}");
            }
            Ok(CaptureOutcome::Captured {
                path: path.to_string_lossy().into_owned(),
                clipboard,
                overlay,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_path, classify_capture, screencapture_args, CaptureEvidence, CaptureMode,
        CaptureOutcome, CaptureRunner, ProcessResult, StoredCaptureOutcome,
    };
    use crate::clipboard::ClipboardStatus;
    use crate::overlay::OverlayStatus;
    use std::{
        ffi::OsString,
        fs, io,
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
    };

    struct WritingRunner;

    impl CaptureRunner for WritingRunner {
        fn run(&self, args: &[OsString]) -> io::Result<ProcessResult> {
            let output = Path::new(args.last().expect("output path").as_os_str());
            fs::write(output, b"fake png bytes")?;
            Ok(ProcessResult {
                stderr: String::new(),
            })
        }
    }

    struct FailingRunner;

    impl CaptureRunner for FailingRunner {
        fn run(&self, _args: &[OsString]) -> io::Result<ProcessResult> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "runner denied",
            ))
        }
    }

    #[test]
    fn each_mode_uses_the_restricted_silent_png_arguments() {
        let output = Path::new("/tmp/capso/capture.png");

        let cases = [
            (CaptureMode::Region, vec!["-i", "-s", "-x", "-t", "png"]),
            (CaptureMode::Window, vec!["-i", "-w", "-x", "-t", "png"]),
            (CaptureMode::Fullscreen, vec!["-m", "-x", "-t", "png"]),
        ];

        for (mode, flags) in cases {
            let expected = flags
                .into_iter()
                .map(OsString::from)
                .chain([output.as_os_str().to_os_string()])
                .collect::<Vec<_>>();

            assert_eq!(screencapture_args(mode, output), expected);
        }
    }

    #[test]
    fn capture_lease_blocks_overlap_and_releases_after_scope_exit() {
        let flag = AtomicBool::new(false);
        let first = super::CaptureLease::try_acquire(&flag).expect("first capture starts");

        let overlap = super::CaptureLease::try_acquire(&flag)
            .err()
            .expect("overlapping capture is rejected");
        assert_eq!(overlap.code, "capture_in_progress");

        drop(first);
        assert!(!flag.load(Ordering::Acquire));
        let next = super::CaptureLease::try_acquire(&flag).expect("next capture starts");
        drop(next);
        assert!(!flag.load(Ordering::Acquire));
    }

    #[test]
    fn capture_lease_releases_on_an_early_error() {
        let flag = AtomicBool::new(false);
        let result = (|| -> Result<(), super::CaptureFailure> {
            let _lease = super::CaptureLease::try_acquire(&flag)?;
            Err(super::CaptureFailure {
                code: "test_failure",
                message: "simulated early return".into(),
            })
        })();

        assert_eq!(result.expect_err("simulated error").code, "test_failure");
        assert!(!flag.load(Ordering::Acquire));
    }

    #[test]
    fn capture_path_is_stable_under_the_app_data_capture_directory() {
        let app_data = Path::new("/tmp/Library/Application Support/com.capso.app");

        assert_eq!(
            capture_path(app_data, "018f22c4-cada-7c6b-9d5b-fc35f7f9227a"),
            app_data
                .join("captures")
                .join("018f22c4-cada-7c6b-9d5b-fc35f7f9227a.png")
        );
    }

    #[test]
    fn missing_output_without_a_diagnostic_is_a_silent_cancel() {
        let output = Path::new("/tmp/capso/cancelled.png");

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: None,
                    stderr: "",
                },
            ),
            Ok(StoredCaptureOutcome::Cancelled)
        );
    }

    #[test]
    fn non_empty_output_is_a_completed_capture() {
        let output = Path::new("/tmp/capso/captured.png");

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: Some(42),
                    stderr: "",
                },
            ),
            Ok(StoredCaptureOutcome::Captured {
                path: output.to_path_buf(),
            })
        );
    }

    #[test]
    fn completed_capture_serializes_the_saved_path_and_clipboard_proof() {
        let outcome = CaptureOutcome::Captured {
            path: "/tmp/capso/captured.png".into(),
            clipboard: ClipboardStatus::Copied { bytes: 42 },
            overlay: OverlayStatus::Prepared { x: 1440, y: 900 },
        };

        assert_eq!(
            serde_json::to_value(outcome).expect("serialize capture outcome"),
            serde_json::json!({
                "status": "captured",
                "path": "/tmp/capso/captured.png",
                "clipboard": {
                    "status": "copied",
                    "bytes": 42
                },
                "overlay": {
                    "status": "prepared",
                    "x": 1440,
                    "y": 900
                }
            })
        );
    }

    #[test]
    fn clipboard_failure_keeps_the_command_result_captured() {
        let outcome = CaptureOutcome::Captured {
            path: "/tmp/capso/captured.png".into(),
            clipboard: ClipboardStatus::Failed {
                code: "clipboard_write_failed",
                message: "Could not copy the capture: pasteboard unavailable".into(),
            },
            overlay: OverlayStatus::Failed {
                code: "overlay_unavailable",
                message: "The capture overlay window is unavailable.".into(),
            },
        };

        assert_eq!(
            serde_json::to_value(outcome).expect("serialize capture outcome"),
            serde_json::json!({
                "status": "captured",
                "path": "/tmp/capso/captured.png",
                "clipboard": {
                    "status": "failed",
                    "code": "clipboard_write_failed",
                    "message": "Could not copy the capture: pasteboard unavailable"
                },
                "overlay": {
                    "status": "failed",
                    "code": "overlay_unavailable",
                    "message": "The capture overlay window is unavailable."
                }
            })
        );
    }

    #[test]
    fn missing_output_with_a_diagnostic_is_an_actionable_failure() {
        let output = Path::new("/tmp/capso/denied.png");

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: None,
                    stderr: "screen capture permission denied\n",
                },
            ),
            Err(super::CaptureFailure {
                code: "capture_failed",
                message: "screen capture permission denied".into(),
            })
        );
    }

    #[test]
    fn zero_byte_output_is_never_reported_as_a_capture_or_cancel() {
        let output = Path::new("/tmp/capso/empty.png");

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: Some(0),
                    stderr: "",
                },
            ),
            Err(super::CaptureFailure {
                code: "empty_output",
                message: "Screen capture produced an empty image.".into(),
            })
        );
    }

    #[test]
    fn runner_output_is_persisted_at_the_capture_path_before_success_returns() {
        let app_data = std::env::temp_dir().join(format!(
            "capso-native-capture-test-{}-success",
            std::process::id()
        ));
        let expected = app_data
            .join("captures")
            .join("018f22c4-cada-7c6b-9d5b-fc35f7f9227a.png");
        let _ = fs::remove_dir_all(&app_data);

        let result = super::run_capture(
            &app_data,
            CaptureMode::Region,
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            &WritingRunner,
        );

        assert_eq!(
            result,
            Ok(StoredCaptureOutcome::Captured {
                path: expected.clone(),
            })
        );
        assert_eq!(
            fs::read(&expected).expect("stored capture"),
            b"fake png bytes"
        );

        fs::remove_dir_all(app_data).expect("clean test capture directory");
    }

    #[test]
    fn capture_directory_failure_has_a_stable_storage_error_code() {
        let app_data = std::env::temp_dir().join(format!(
            "capso-native-capture-test-{}-blocked-directory",
            std::process::id()
        ));
        let _ = fs::remove_file(&app_data);
        let _ = fs::remove_dir_all(&app_data);
        fs::write(&app_data, b"this file prevents a child directory")
            .expect("create blocking file");

        let error = super::run_capture(
            &app_data,
            CaptureMode::Region,
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            &WritingRunner,
        )
        .expect_err("a file cannot contain the capture directory");

        assert_eq!(error.code, "storage_failed");
        assert!(error
            .message
            .starts_with("Could not create the capture directory:"));

        fs::remove_file(app_data).expect("clean blocking file");
    }

    #[test]
    fn runner_launch_failure_has_a_stable_unavailable_error_code() {
        let app_data = std::env::temp_dir().join(format!(
            "capso-native-capture-test-{}-runner-failure",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&app_data);

        let error = super::run_capture(
            &app_data,
            CaptureMode::Window,
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            &FailingRunner,
        )
        .expect_err("the runner failure must reach the command boundary");

        assert_eq!(error.code, "capture_unavailable");
        assert_eq!(
            error.message,
            "Could not start macOS screen capture: runner denied"
        );

        fs::remove_dir_all(app_data).expect("clean failed-run capture directory");
    }

    #[test]
    fn generated_capture_ids_are_unique_uuids() {
        let first = super::new_capture_id();
        let second = super::new_capture_id();

        uuid::Uuid::parse_str(&first).expect("first capture id is a UUID");
        uuid::Uuid::parse_str(&second).expect("second capture id is a UUID");
        assert_ne!(first, second);
    }
}
