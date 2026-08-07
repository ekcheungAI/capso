use serde::Serialize;
use std::{fs, path::Path, path::PathBuf, sync::Mutex};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPasteboard, NSPasteboardType, NSPasteboardTypePNG};
#[cfg(target_os = "macos")]
use objc2_foundation::NSData;
use tauri::{AppHandle, Manager};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum ClipboardStatus {
    Copied { bytes: usize },
    Failed { code: &'static str, message: String },
}

pub(crate) trait ClipboardWriter {
    fn write_png(&mut self, png: &[u8]) -> Result<(), String>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ClipboardTicket {
    generation: u64,
    path: PathBuf,
}

#[derive(Default)]
pub(crate) struct ClipboardRuntime {
    generation: u64,
    latest: Option<ClipboardTicket>,
}

impl ClipboardRuntime {
    fn register_capture(&mut self, path: PathBuf) -> ClipboardTicket {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("clipboard generation cannot exhaust u64");
        let ticket = ClipboardTicket {
            generation: self.generation,
            path,
        };
        self.latest = Some(ticket.clone());
        ticket
    }

    fn ticket_for_current(&self, path: &Path) -> Result<ClipboardTicket, ClipboardStatus> {
        self.latest
            .as_ref()
            .filter(|ticket| ticket.path == path)
            .cloned()
            .ok_or_else(|| {
                clipboard_failure(
                    "clipboard_stale_capture",
                    "That capture is no longer current, so it was not copied.",
                )
            })
    }
}

#[cfg(test)]
pub(crate) fn copy_png_file<W: ClipboardWriter>(path: &Path, writer: &mut W) -> ClipboardStatus {
    match read_png_payload(path) {
        Ok(png) => write_png_payload(&png, writer),
        Err(status) => status,
    }
}

fn read_png_payload(path: &Path) -> Result<Vec<u8>, ClipboardStatus> {
    let png = fs::read(path).map_err(|error| ClipboardStatus::Failed {
        code: "clipboard_read_failed",
        message: format!("Could not read the saved capture for copying: {error}"),
    })?;

    if !png.starts_with(PNG_SIGNATURE) {
        return Err(ClipboardStatus::Failed {
            code: "clipboard_invalid_png",
            message: "The saved capture is not a valid PNG payload.".into(),
        });
    }

    Ok(png)
}

fn write_png_payload<W: ClipboardWriter>(png: &[u8], writer: &mut W) -> ClipboardStatus {
    match writer.write_png(png) {
        Ok(()) => ClipboardStatus::Copied { bytes: png.len() },
        Err(error) => ClipboardStatus::Failed {
            code: "clipboard_write_failed",
            message: format!("Could not copy the capture: {error}"),
        },
    }
}

fn commit_registered_payload<W: ClipboardWriter>(
    runtime: &ClipboardRuntime,
    ticket: &ClipboardTicket,
    png: &[u8],
    writer: &mut W,
) -> ClipboardStatus {
    if runtime.latest.as_ref() != Some(ticket) {
        return clipboard_failure(
            "clipboard_stale_capture",
            "A newer capture replaced this clipboard request before it could finish.",
        );
    }
    write_png_payload(png, writer)
}

fn clipboard_failure(code: &'static str, message: impl Into<String>) -> ClipboardStatus {
    ClipboardStatus::Failed {
        code,
        message: message.into(),
    }
}

#[cfg(target_os = "macos")]
fn wait_for_scheduled_write(
    receiver: std::sync::mpsc::Receiver<ClipboardStatus>,
) -> ClipboardStatus {
    receiver.recv().unwrap_or_else(|error| {
        clipboard_failure(
            "clipboard_task_failed",
            format!("The macOS clipboard copy did not complete: {error}"),
        )
    })
}

#[cfg(target_os = "macos")]
fn png_pasteboard_type() -> &'static NSPasteboardType {
    // SAFETY: AppKit exports NSPasteboardTypePNG as a process-lifetime NSString.
    unsafe { NSPasteboardTypePNG }
}

#[cfg(target_os = "macos")]
fn write_png_to_pasteboard(pasteboard: &NSPasteboard, png: &[u8]) -> Result<(), String> {
    let data = NSData::with_bytes(png);
    pasteboard.clearContents();
    if pasteboard.setData_forType(Some(&data), png_pasteboard_type()) {
        Ok(())
    } else {
        Err("macOS rejected the PNG pasteboard payload".into())
    }
}

#[cfg(target_os = "macos")]
struct MacClipboard;

#[cfg(target_os = "macos")]
impl ClipboardWriter for MacClipboard {
    fn write_png(&mut self, png: &[u8]) -> Result<(), String> {
        write_png_to_pasteboard(&NSPasteboard::generalPasteboard(), png)
    }
}

/// Reads the already-persisted capture off the UI thread, then performs the
/// AppKit pasteboard mutation on macOS' main thread. Clipboard failure is a
/// recoverable post-capture status: it must never delete or downgrade pixels
/// that are already durable on disk.
async fn copy_registered_png_to_general_pasteboard(
    app: AppHandle,
    ticket: ClipboardTicket,
) -> ClipboardStatus {
    let path = ticket.path.clone();
    let payload = match tauri::async_runtime::spawn_blocking(move || read_png_payload(&path)).await
    {
        Ok(Ok(payload)) => payload,
        Ok(Err(status)) => return status,
        Err(error) => {
            return clipboard_failure(
                "clipboard_read_task_failed",
                format!("Could not prepare the saved capture for copying: {error}"),
            )
        }
    };

    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let commit_app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let status = match commit_app.state::<Mutex<ClipboardRuntime>>().lock() {
                Ok(runtime) => {
                    let mut writer = MacClipboard;
                    commit_registered_payload(&runtime, &ticket, &payload, &mut writer)
                }
                Err(_) => clipboard_failure(
                    "clipboard_state_failed",
                    "The clipboard state is temporarily unavailable.",
                ),
            };
            let _ = sender.send(status);
        }) {
            return clipboard_failure(
                "clipboard_schedule_failed",
                format!("Could not schedule the macOS clipboard copy: {error}"),
            );
        }

        match tauri::async_runtime::spawn_blocking(move || wait_for_scheduled_write(receiver)).await
        {
            Ok(status) => status,
            Err(error) => clipboard_failure(
                "clipboard_task_failed",
                format!("The macOS clipboard task stopped unexpectedly: {error}"),
            ),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, ticket, payload);
        clipboard_failure(
            "clipboard_unavailable",
            "Image clipboard copy is only available in the macOS app",
        )
    }
}

/// Registers a newly persisted capture before any asynchronous read. The
/// registration is the ordering point: an older delayed copy must either
/// commit before this call or fail its final main-thread revalidation.
pub(crate) async fn copy_new_capture_to_general_pasteboard(
    app: AppHandle,
    path: PathBuf,
) -> ClipboardStatus {
    let ticket = match app.state::<Mutex<ClipboardRuntime>>().lock() {
        Ok(mut runtime) => runtime.register_capture(path),
        Err(_) => {
            return clipboard_failure(
                "clipboard_state_failed",
                "The clipboard state is temporarily unavailable.",
            )
        }
    };
    copy_registered_png_to_general_pasteboard(app, ticket).await
}

pub(crate) async fn recopy_current_capture_to_general_pasteboard(
    app: AppHandle,
    path: PathBuf,
) -> ClipboardStatus {
    let ticket = match app.state::<Mutex<ClipboardRuntime>>().lock() {
        Ok(runtime) => match runtime.ticket_for_current(&path) {
            Ok(ticket) => ticket,
            Err(status) => return status,
        },
        Err(_) => {
            return clipboard_failure(
                "clipboard_state_failed",
                "The clipboard state is temporarily unavailable.",
            )
        }
    };
    copy_registered_png_to_general_pasteboard(app, ticket).await
}

#[cfg(test)]
mod tests {
    use super::{
        commit_registered_payload, copy_png_file, ClipboardRuntime, ClipboardStatus,
        ClipboardWriter, PNG_SIGNATURE,
    };
    use std::{fs, path::Path, path::PathBuf};

    const PNG_FIXTURE: &[u8] = b"\x89PNG\r\n\x1a\nexact-pixel-payload";

    #[derive(Default)]
    struct RecordingWriter {
        attempts: usize,
        payload: Vec<u8>,
        failure: Option<String>,
    }

    impl ClipboardWriter for RecordingWriter {
        fn write_png(&mut self, png: &[u8]) -> Result<(), String> {
            self.attempts += 1;
            self.payload = png.to_vec();
            match &self.failure {
                Some(message) => Err(message.clone()),
                None => Ok(()),
            }
        }
    }

    fn write_fixture(directory: &Path, bytes: &[u8]) -> std::path::PathBuf {
        let path = directory.join("capture.png");
        fs::write(&path, bytes).expect("write capture fixture");
        path
    }

    #[test]
    fn successful_copy_writes_the_exact_persisted_png_payload() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = write_fixture(directory.path(), PNG_FIXTURE);
        let mut writer = RecordingWriter::default();

        assert_eq!(
            copy_png_file(&path, &mut writer),
            ClipboardStatus::Copied {
                bytes: PNG_FIXTURE.len()
            }
        );
        assert_eq!(writer.attempts, 1);
        assert_eq!(writer.payload, PNG_FIXTURE);
    }

    #[test]
    fn pasteboard_failure_keeps_the_capture_and_returns_an_actionable_status() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = write_fixture(directory.path(), PNG_FIXTURE);
        let mut writer = RecordingWriter {
            failure: Some("pasteboard rejected PNG".into()),
            ..RecordingWriter::default()
        };

        assert_eq!(
            copy_png_file(&path, &mut writer),
            ClipboardStatus::Failed {
                code: "clipboard_write_failed",
                message: "Could not copy the capture: pasteboard rejected PNG".into(),
            }
        );
        assert_eq!(fs::read(&path).expect("capture remains"), PNG_FIXTURE);
    }

    #[test]
    fn missing_capture_never_clears_or_writes_the_pasteboard() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("missing.png");
        let mut writer = RecordingWriter::default();

        let status = copy_png_file(&path, &mut writer);

        assert!(matches!(
            status,
            ClipboardStatus::Failed {
                code: "clipboard_read_failed",
                ..
            }
        ));
        assert_eq!(writer.attempts, 0);
    }

    #[test]
    fn non_png_data_never_replaces_the_existing_pasteboard() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = write_fixture(directory.path(), b"not a png");
        let mut writer = RecordingWriter::default();

        assert_eq!(
            copy_png_file(&path, &mut writer),
            ClipboardStatus::Failed {
                code: "clipboard_invalid_png",
                message: "The saved capture is not a valid PNG payload.".into(),
            }
        );
        assert_eq!(writer.attempts, 0);
    }

    #[test]
    fn png_signature_constant_matches_the_platform_format_contract() {
        assert_eq!(&PNG_FIXTURE[..PNG_SIGNATURE.len()], PNG_SIGNATURE);
    }

    #[test]
    fn delayed_old_copy_is_rejected_after_a_new_capture_registers() {
        let mut runtime = ClipboardRuntime::default();
        let old_path = PathBuf::from("/tmp/capso/old.png");
        let new_path = PathBuf::from("/tmp/capso/new.png");
        runtime.register_capture(old_path.clone());
        let delayed_old = runtime
            .ticket_for_current(&old_path)
            .expect("old capture starts current");
        let newest = runtime.register_capture(new_path);
        let mut writer = RecordingWriter::default();

        let stale =
            commit_registered_payload(&runtime, &delayed_old, b"\x89PNG\r\n\x1a\nold", &mut writer);
        assert!(matches!(
            stale,
            ClipboardStatus::Failed {
                code: "clipboard_stale_capture",
                ..
            }
        ));
        assert_eq!(writer.attempts, 0);

        assert_eq!(
            commit_registered_payload(&runtime, &newest, b"\x89PNG\r\n\x1a\nnew", &mut writer,),
            ClipboardStatus::Copied { bytes: 11 }
        );
        assert_eq!(writer.payload, b"\x89PNG\r\n\x1a\nnew");
    }

    #[test]
    fn old_copy_before_new_registration_is_followed_by_the_newest_pixels() {
        let mut runtime = ClipboardRuntime::default();
        let old = runtime.register_capture(PathBuf::from("/tmp/capso/old.png"));
        let mut writer = RecordingWriter::default();

        assert!(matches!(
            commit_registered_payload(&runtime, &old, b"\x89PNG\r\n\x1a\nold", &mut writer,),
            ClipboardStatus::Copied { .. }
        ));
        let newest = runtime.register_capture(PathBuf::from("/tmp/capso/new.png"));
        assert!(matches!(
            commit_registered_payload(&runtime, &newest, b"\x89PNG\r\n\x1a\nnew", &mut writer,),
            ClipboardStatus::Copied { .. }
        ));

        assert_eq!(writer.attempts, 2);
        assert_eq!(writer.payload, b"\x89PNG\r\n\x1a\nnew");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn appkit_round_trip_preserves_the_exact_png_bytes() {
        let pasteboard = objc2_app_kit::NSPasteboard::pasteboardWithUniqueName();

        super::write_png_to_pasteboard(&pasteboard, PNG_FIXTURE)
            .expect("write custom test pasteboard");
        let copied = pasteboard
            .dataForType(super::png_pasteboard_type())
            .expect("PNG exists on custom test pasteboard")
            .to_vec();

        // Byte identity is stronger than decoded-pixel equality: it proves
        // metadata, alpha, colour profile and every encoded pixel are unchanged.
        assert_eq!(copied, PNG_FIXTURE);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn scheduled_clipboard_write_cannot_report_before_delayed_mutation_finishes() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc::sync_channel,
            Arc,
        };

        let (sender, receiver) = sync_channel(1);
        let mutation_finished = Arc::new(AtomicBool::new(false));
        let worker_finished = Arc::clone(&mutation_finished);
        let worker = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            worker_finished.store(true, Ordering::Release);
            sender
                .send(ClipboardStatus::Copied { bytes: 42 })
                .expect("report delayed mutation");
        });

        let status = super::wait_for_scheduled_write(receiver);

        assert!(mutation_finished.load(Ordering::Acquire));
        assert_eq!(status, ClipboardStatus::Copied { bytes: 42 });
        worker.join().expect("delayed mutation worker");
    }
}
