use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
const MAX_FREEZE_FRAME_BYTES: u64 = 512 * 1024 * 1024;
const FREEZE_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const AREA_SELECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const MAX_STYLED_WINDOW_EDGE: u32 = 32_768;
const MAX_STYLED_WINDOW_PIXELS: u64 = 100_000_000;

pub(crate) fn is_capture_in_progress() -> bool {
    CAPTURE_IN_PROGRESS.load(Ordering::Acquire)
}

pub(crate) fn acquire_capture_lease() -> Result<impl Drop, CaptureFailure> {
    CaptureLease::try_acquire(&CAPTURE_IN_PROGRESS)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CaptureMode {
    Region,
    Window,
    Fullscreen,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl CaptureRect {
    pub(crate) fn new(x: i32, y: i32, width: u32, height: u32) -> Result<Self, String> {
        const MAX_ORIGIN: i32 = 1_000_000;
        const MAX_EDGE: u32 = 32_768;
        if !(-MAX_ORIGIN..=MAX_ORIGIN).contains(&x)
            || !(-MAX_ORIGIN..=MAX_ORIGIN).contains(&y)
            || !(2..=MAX_EDGE).contains(&width)
            || !(2..=MAX_EDGE).contains(&height)
        {
            return Err("Previous Area rectangle is outside Capso's safe screen bounds.".into());
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
enum StoredCaptureOutcome {
    Captured {
        path: PathBuf,
        overlay_latency_start: crate::latency::OverlayLatencyStart,
    },
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum CaptureOutcome {
    Captured {
        path: String,
        clipboard: crate::clipboard::ClipboardStatus,
        overlay: crate::overlay::OverlayStatus,
        queue: crate::queue::CaptureQueueStatus,
    },
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CapturedArea {
    pub(crate) rect: CaptureRect,
    pub(crate) pixel_dimensions: (u32, u32),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct CaptureFailure {
    pub code: &'static str,
    pub message: String,
}

struct CaptureLease<'a> {
    flag: &'a AtomicBool,
}

#[derive(Debug)]
struct OwnedFreezeFrame {
    path: PathBuf,
}

impl OwnedFreezeFrame {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for OwnedFreezeFrame {
    fn drop(&mut self) {
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("Could not remove Capso's private freeze frame: {error}"),
        }
        if let Some(directory) = self.path.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
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
    mode: CaptureMode,
    cancellable: bool,
    selection_completed_at: Instant,
}

#[derive(Debug)]
struct ProcessResult {
    stderr: String,
}

trait CaptureRunner {
    fn run(&self, args: &[OsString]) -> io::Result<ProcessResult>;
}

trait CaptureDurability {
    fn sync_file(&self, path: &Path) -> io::Result<()>;
    fn sync_directory(&self, path: &Path) -> io::Result<()>;
}

struct SystemCaptureRunner;
struct SystemCaptureDurability;

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

impl CaptureDurability for SystemCaptureDurability {
    fn sync_file(&self, path: &Path) -> io::Result<()> {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)?
            .sync_all()
    }

    fn sync_directory(&self, path: &Path) -> io::Result<()> {
        fs::File::open(path)?.sync_all()
    }
}

fn run_capture<R: CaptureRunner>(
    app_data: &Path,
    mode: CaptureMode,
    capture_id: &str,
    runner: &R,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    run_capture_with_durability(app_data, mode, capture_id, runner, &SystemCaptureDurability)
}

fn run_capture_with_durability<R: CaptureRunner, D: CaptureDurability>(
    app_data: &Path,
    mode: CaptureMode,
    capture_id: &str,
    runner: &R,
    durability: &D,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    run_capture_with_arguments(
        app_data,
        mode,
        capture_id,
        runner,
        durability,
        mode != CaptureMode::Fullscreen,
        |output| screencapture_args(mode, output),
        |_| Ok(()),
    )
}

fn run_window_capture_with_style<R: CaptureRunner>(
    app_data: &Path,
    capture_id: &str,
    runner: &R,
    style: crate::capture_hud::WindowCaptureStyle,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    run_capture_with_arguments(
        app_data,
        CaptureMode::Window,
        capture_id,
        runner,
        &SystemCaptureDurability,
        true,
        |output| screencapture_args_with_window_style(CaptureMode::Window, output, style),
        |output| apply_window_style(output, &style),
    )
}

fn run_rectangle_capture<R: CaptureRunner>(
    app_data: &Path,
    rect: CaptureRect,
    capture_id: &str,
    runner: &R,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    run_capture_with_arguments(
        app_data,
        CaptureMode::Region,
        capture_id,
        runner,
        &SystemCaptureDurability,
        false,
        |output| screencapture_rect_args(rect, output),
        |_| Ok(()),
    )
}

fn run_precise_rectangle_capture<R: CaptureRunner>(
    app_data: &Path,
    rect: CaptureRect,
    expected_dimensions: (u32, u32),
    capture_id: &str,
    runner: &R,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    let outcome = run_rectangle_capture(app_data, rect, capture_id, runner)?;
    let StoredCaptureOutcome::Captured { path, .. } = &outcome else {
        return Ok(outcome);
    };
    let dimensions = image::image_dimensions(path).map_err(|error| {
        let _ = fs::remove_file(path);
        CaptureFailure {
            code: "area_dimensions_invalid",
            message: format!("Could not verify the exact Area capture dimensions: {error}"),
        }
    })?;
    if dimensions != expected_dimensions {
        let _ = fs::remove_file(path);
        return Err(CaptureFailure {
            code: "area_dimensions_mismatch",
            message: format!(
                "Area capture produced {} × {} pixels instead of the confirmed {} × {}.",
                dimensions.0, dimensions.1, expected_dimensions.0, expected_dimensions.1
            ),
        });
    }
    Ok(outcome)
}

fn run_frozen_area_capture<R: CaptureRunner>(
    app_data: &Path,
    capture_id: &str,
    runner: &R,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    run_capture_with_arguments(
        app_data,
        CaptureMode::Region,
        capture_id,
        runner,
        &SystemCaptureDurability,
        true,
        frozen_area_args,
        |_| Ok(()),
    )
}

fn run_freeze_frame<R: CaptureRunner>(
    app_data: &Path,
    frame_id: &str,
    runner: &R,
) -> Result<OwnedFreezeFrame, CaptureFailure> {
    let path = app_data.join("freeze").join(format!("{frame_id}.png"));
    let directory = path.parent().expect("freeze frame always has a parent");
    fs::create_dir_all(directory).map_err(|error| CaptureFailure {
        code: "freeze_storage_failed",
        message: format!("Could not create the private Freeze Screen directory: {error}"),
    })?;
    let owned = OwnedFreezeFrame::new(path);
    let process = runner
        .run(&freeze_frame_args(owned.path()))
        .map_err(|error| CaptureFailure {
            code: "freeze_capture_unavailable",
            message: format!("Could not capture the main display for Freeze Screen: {error}"),
        })?;
    let metadata = fs::metadata(owned.path()).map_err(|error| CaptureFailure {
        code: "freeze_frame_missing",
        message: if process.stderr.trim().is_empty() {
            format!("Freeze Screen did not create a usable private frame: {error}")
        } else {
            process.stderr.trim().to_string()
        },
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_FREEZE_FRAME_BYTES {
        return Err(CaptureFailure {
            code: "freeze_frame_invalid",
            message: "Freeze Screen produced a frame outside Capso's safe size bounds.".into(),
        });
    }
    fs::File::open(owned.path())
        .and_then(|file| file.sync_all())
        .map_err(|error| CaptureFailure {
            code: "freeze_storage_failed",
            message: format!("Could not sync the private Freeze Screen frame: {error}"),
        })?;
    Ok(owned)
}

fn run_area_selector_frame<R: CaptureRunner>(
    app_data: &Path,
    rect: CaptureRect,
    expected_dimensions: (u32, u32),
    frame_id: &str,
    runner: &R,
) -> Result<OwnedFreezeFrame, CaptureFailure> {
    let path = app_data.join("freeze").join(format!("{frame_id}.png"));
    let directory = path
        .parent()
        .expect("Area magnifier frame always has a parent");
    fs::create_dir_all(directory).map_err(|error| CaptureFailure {
        code: "area_preview_storage_failed",
        message: format!("Could not create the private Area preview directory: {error}"),
    })?;
    let owned = OwnedFreezeFrame::new(path);
    let process = runner
        .run(&screencapture_rect_args(rect, owned.path()))
        .map_err(|error| CaptureFailure {
            code: "area_preview_unavailable",
            message: format!("Could not capture the private Area magnifier frame: {error}"),
        })?;
    let metadata = fs::metadata(owned.path()).map_err(|error| CaptureFailure {
        code: "area_preview_missing",
        message: if process.stderr.trim().is_empty() {
            format!("Area magnifier did not create a usable private frame: {error}")
        } else {
            process.stderr.trim().to_string()
        },
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_FREEZE_FRAME_BYTES {
        return Err(CaptureFailure {
            code: "area_preview_invalid",
            message: "Area magnifier produced a frame outside Capso's safe size bounds.".into(),
        });
    }
    let dimensions = image::image_dimensions(owned.path()).map_err(|error| CaptureFailure {
        code: "area_preview_invalid",
        message: format!("Area magnifier produced an unreadable private frame: {error}"),
    })?;
    if dimensions != expected_dimensions {
        return Err(CaptureFailure {
            code: "area_preview_dimensions_mismatch",
            message: format!(
                "Area magnifier produced {} × {} pixels instead of {} × {}.",
                dimensions.0, dimensions.1, expected_dimensions.0, expected_dimensions.1
            ),
        });
    }
    fs::File::open(owned.path())
        .and_then(|file| file.sync_all())
        .map_err(|error| CaptureFailure {
            code: "area_preview_storage_failed",
            message: format!("Could not sync the private Area magnifier frame: {error}"),
        })?;
    Ok(owned)
}

fn run_capture_with_arguments<R, D, A, P>(
    app_data: &Path,
    mode: CaptureMode,
    capture_id: &str,
    runner: &R,
    durability: &D,
    cancellable: bool,
    arguments: A,
    postprocess: P,
) -> Result<StoredCaptureOutcome, CaptureFailure>
where
    R: CaptureRunner,
    D: CaptureDurability,
    A: FnOnce(&Path) -> Vec<OsString>,
    P: FnOnce(&Path) -> Result<(), CaptureFailure>,
{
    let output = capture_path(app_data, capture_id);
    let directory = output.parent().expect("capture path always has a parent");
    fs::create_dir_all(directory).map_err(|error| CaptureFailure {
        code: "storage_failed",
        message: format!("Could not create the capture directory: {error}"),
    })?;

    let process = runner
        .run(&arguments(&output))
        .map_err(|error| CaptureFailure {
            code: "capture_unavailable",
            message: format!("Could not start macOS screen capture: {error}"),
        })?;
    let selection_completed_at = Instant::now();

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

    let outcome = classify_capture(
        &output,
        CaptureEvidence {
            output_bytes,
            stderr: &process.stderr,
            mode,
            cancellable,
            selection_completed_at,
        },
    )?;
    if matches!(outcome, StoredCaptureOutcome::Captured { .. }) {
        if let Err(error) = postprocess(&output) {
            match fs::remove_file(&output) {
                Ok(()) => {
                    let _ = durability.sync_directory(directory);
                }
                Err(remove_error) if remove_error.kind() == io::ErrorKind::NotFound => {}
                Err(remove_error) => eprintln!(
                    "Could not remove an unpublished Capso capture after styling failed: {remove_error}"
                ),
            }
            return Err(error);
        }
        durability
            .sync_file(&output)
            .map_err(|error| CaptureFailure {
                code: "storage_failed",
                message: format!("Could not sync the captured image: {error}"),
            })?;
        durability
            .sync_directory(directory)
            .map_err(|error| CaptureFailure {
                code: "storage_failed",
                message: format!("Could not sync the capture directory: {error}"),
            })?;
    }
    Ok(outcome)
}

fn classify_capture(
    output: &Path,
    evidence: CaptureEvidence<'_>,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    if evidence.output_bytes.is_some_and(|bytes| bytes > 0) {
        return Ok(StoredCaptureOutcome::Captured {
            path: output.to_path_buf(),
            overlay_latency_start: crate::latency::OverlayLatencyStart::new(
                evidence.mode,
                evidence.selection_completed_at,
            ),
        });
    }

    if evidence.output_bytes.is_none() && evidence.stderr.trim().is_empty() && evidence.cancellable
    {
        return Ok(StoredCaptureOutcome::Cancelled);
    }

    if evidence.output_bytes.is_none() && evidence.stderr.trim().is_empty() {
        return Err(CaptureFailure {
            code: "capture_failed",
            message: "Screen capture ended without creating an image.".into(),
        });
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

fn resolve_cancelled_capture_permission(
    result: Result<StoredCaptureOutcome, CaptureFailure>,
    screen_recording_granted: bool,
) -> Result<StoredCaptureOutcome, CaptureFailure> {
    let produced_no_pixels = matches!(result, Ok(StoredCaptureOutcome::Cancelled))
        || matches!(
            result,
            Err(CaptureFailure {
                code: "capture_failed" | "empty_output",
                ..
            })
        );
    if produced_no_pixels && !screen_recording_granted {
        return Err(CaptureFailure {
            code: "screen_recording_required",
            message: "Screen Recording is required for Area, Window, and Full Screen screenshots."
                .into(),
        });
    }
    result
}

pub(crate) fn screencapture_args(mode: CaptureMode, output: &Path) -> Vec<OsString> {
    screencapture_args_with_window_style(
        mode,
        output,
        crate::capture_hud::WindowCaptureStyle::default(),
    )
}

fn screencapture_args_with_window_style(
    mode: CaptureMode,
    output: &Path,
    style: crate::capture_hud::WindowCaptureStyle,
) -> Vec<OsString> {
    let flags: &[&str] = match mode {
        CaptureMode::Region => &["-i", "-s", "-x", "-t", "png"],
        CaptureMode::Window if style.shadow => &["-i", "-w", "-x", "-t", "png"],
        CaptureMode::Window => &["-i", "-w", "-o", "-x", "-t", "png"],
        CaptureMode::Fullscreen => &["-m", "-x", "-t", "png"],
    };

    flags
        .iter()
        .map(OsString::from)
        .chain([output.as_os_str().to_os_string()])
        .collect()
}

fn window_background_rgba(style: &crate::capture_hud::WindowCaptureStyle) -> image::Rgba<u8> {
    use crate::capture_hud::WindowBackground;

    match style.background {
        WindowBackground::Transparent => image::Rgba([0, 0, 0, 0]),
        WindowBackground::Canvas => image::Rgba([244, 240, 235, 255]),
        WindowBackground::Ink => image::Rgba([31, 31, 30, 255]),
        WindowBackground::Blue => image::Rgba([74, 111, 165, 255]),
        WindowBackground::Custom => style.custom_background.rgba(),
    }
}

fn blend_window_pixel(destination: image::Rgba<u8>, source: image::Rgba<u8>) -> image::Rgba<u8> {
    let source_alpha = u32::from(source.0[3]);
    let destination_alpha = u32::from(destination.0[3]);
    let inverse_source = 255 - source_alpha;
    let alpha_numerator = source_alpha * 255 + destination_alpha * inverse_source;
    if alpha_numerator == 0 {
        return image::Rgba([0, 0, 0, 0]);
    }
    let mut output = [0_u8; 4];
    for channel in 0..3 {
        let colour_numerator = u32::from(source.0[channel]) * source_alpha * 255
            + u32::from(destination.0[channel]) * destination_alpha * inverse_source;
        output[channel] = ((colour_numerator + alpha_numerator / 2) / alpha_numerator) as u8;
    }
    output[3] = ((alpha_numerator + 127) / 255) as u8;
    image::Rgba(output)
}

fn apply_window_style(
    path: &Path,
    style: &crate::capture_hud::WindowCaptureStyle,
) -> Result<(), CaptureFailure> {
    if style.padding == 0 && style.background == crate::capture_hud::WindowBackground::Transparent {
        return Ok(());
    }
    let source = image::open(path)
        .map_err(|error| CaptureFailure {
            code: "window_style_invalid",
            message: format!("Could not decode the selected window before styling it: {error}"),
        })?
        .into_rgba8();
    let padding = u32::from(style.padding);
    let width = source
        .width()
        .checked_add(padding.saturating_mul(2))
        .ok_or_else(|| CaptureFailure {
            code: "window_style_too_large",
            message: "Window styling would exceed Capso's safe image bounds.".into(),
        })?;
    let height = source
        .height()
        .checked_add(padding.saturating_mul(2))
        .ok_or_else(|| CaptureFailure {
            code: "window_style_too_large",
            message: "Window styling would exceed Capso's safe image bounds.".into(),
        })?;
    if width > MAX_STYLED_WINDOW_EDGE
        || height > MAX_STYLED_WINDOW_EDGE
        || u64::from(width) * u64::from(height) > MAX_STYLED_WINDOW_PIXELS
    {
        return Err(CaptureFailure {
            code: "window_style_too_large",
            message: "Window styling would exceed Capso's safe image bounds.".into(),
        });
    }
    let mut canvas = image::RgbaImage::from_pixel(width, height, window_background_rgba(style));
    for (x, y, source_pixel) in source.enumerate_pixels() {
        let destination = canvas.get_pixel_mut(x + padding, y + padding);
        *destination = blend_window_pixel(*destination, *source_pixel);
    }
    let temporary = path.with_extension("window-style.tmp");
    let write = canvas
        .save_with_format(&temporary, image::ImageFormat::Png)
        .map_err(|error| CaptureFailure {
            code: "window_style_failed",
            message: format!("Could not encode the styled window capture: {error}"),
        })
        .and_then(|_| {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&temporary)
                .and_then(|file| file.sync_all())
                .map_err(|error| CaptureFailure {
                    code: "window_style_failed",
                    message: format!("Could not sync the styled window capture: {error}"),
                })
        })
        .and_then(|_| {
            fs::rename(&temporary, path).map_err(|error| CaptureFailure {
                code: "window_style_failed",
                message: format!("Could not activate the styled window capture: {error}"),
            })
        });
    if write.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write
}

fn screencapture_rect_args(rect: CaptureRect, output: &Path) -> Vec<OsString> {
    [
        OsString::from(format!(
            "-R{},{},{},{}",
            rect.x, rect.y, rect.width, rect.height
        )),
        OsString::from("-x"),
        OsString::from("-t"),
        OsString::from("png"),
        output.as_os_str().to_os_string(),
    ]
    .into()
}

fn freeze_frame_args(output: &Path) -> Vec<OsString> {
    ["-m", "-x", "-t", "png"]
        .into_iter()
        .map(OsString::from)
        .chain([output.as_os_str().to_os_string()])
        .collect()
}

fn frozen_area_args(output: &Path) -> Vec<OsString> {
    ["-D1", "-i", "-s", "-x", "-t", "png"]
        .into_iter()
        .map(OsString::from)
        .chain([output.as_os_str().to_os_string()])
        .collect()
}

fn capture_path(app_data: &Path, capture_id: &str) -> PathBuf {
    app_data.join("captures").join(format!("{capture_id}.png"))
}

fn prepare_capture_output(app_data: &Path, capture_id: &str) -> Result<PathBuf, CaptureFailure> {
    let output = capture_path(app_data, capture_id);
    let directory = output.parent().expect("capture path always has a parent");
    fs::create_dir_all(directory).map_err(|error| CaptureFailure {
        code: "storage_failed",
        message: format!("Could not create the capture directory: {error}"),
    })?;
    let directory_metadata = fs::symlink_metadata(directory).map_err(|error| CaptureFailure {
        code: "storage_failed",
        message: format!("Could not verify the capture directory: {error}"),
    })?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err(CaptureFailure {
            code: "storage_untrusted",
            message: "Capso's capture directory is not a direct local directory.".into(),
        });
    }
    match fs::symlink_metadata(&output) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(output),
        Err(error) => Err(CaptureFailure {
            code: "storage_failed",
            message: format!("Could not verify the new capture destination: {error}"),
        }),
        Ok(_) => Err(CaptureFailure {
            code: "capture_collision",
            message: "A capture already exists at the newly reserved destination.".into(),
        }),
    }
}

fn new_capture_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn cleanup_stale_freeze_frames(app_data: &Path) -> Result<usize, String> {
    const MAX_STALE_ENTRIES: usize = 256;
    let directory = app_data.join("freeze");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(format!(
                "Could not inspect stale Freeze Screen frames: {error}"
            ))
        }
    };
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not inspect a stale Freeze Screen frame: {error}"))?;
    if entries.len() > MAX_STALE_ENTRIES {
        return Err(
            "The Freeze Screen directory contains too many entries to clean safely.".into(),
        );
    }
    entries.sort_by_key(|entry| entry.file_name());

    let mut removed = 0;
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect a stale Freeze Screen entry: {error}"))?;
        let path = entry.path();
        let owned = file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("png")
            && path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok());
        if !owned {
            continue;
        }
        fs::remove_file(&path)
            .map_err(|error| format!("Could not remove a stale private freeze frame: {error}"))?;
        removed += 1;
    }
    let _ = fs::remove_dir(directory);
    Ok(removed)
}

fn require_idle_annotation(annotation_active: bool) -> Result<(), CaptureFailure> {
    if annotation_active {
        return Err(CaptureFailure {
            code: "annotation_in_progress",
            message: "Finish or cancel the open annotation before starting another capture.".into(),
        });
    }
    Ok(())
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

    require_idle_annotation(crate::annotation::is_active(&app))?;

    if crate::system::permission_for_capture(mode, crate::system::screen_recording_granted())
        == crate::system::CapturePermission::RequiresScreenRecording
    {
        return Err(CaptureFailure {
            code: "screen_recording_required",
            message: "Screen Recording is required for Area, Window, and Full Screen screenshots."
                .into(),
        });
    }

    let app_data = app.path().app_data_dir().map_err(|error| CaptureFailure {
        code: "storage_unavailable",
        message: format!("Could not locate Capso's data directory: {error}"),
    })?;
    let capture_id = new_capture_id();
    prepare_capture_output(&app_data, &capture_id)?;
    let settings = crate::capture_hud::load_settings(&app_data).settings;
    let window_style = settings.window_style;
    let _overlay_capture_lease =
        crate::overlay::CaptureOverlayLease::begin(app.clone()).map_err(|message| {
            CaptureFailure {
                code: "overlay_hide_failed",
                message,
            }
        })?;
    let mut desktop_clutter =
        crate::recording::DesktopClutterLease::begin(app.clone(), settings.hide_desktop_icons)
            .map_err(|message| CaptureFailure {
                code: "desktop_clutter_unavailable",
                message,
            })?;

    let stored_result = tauri::async_runtime::spawn_blocking(move || {
        if mode == CaptureMode::Window {
            run_window_capture_with_style(
                &app_data,
                &capture_id,
                &SystemCaptureRunner,
                window_style,
            )
        } else {
            run_capture(&app_data, mode, &capture_id, &SystemCaptureRunner)
        }
    })
    .await
    .map_err(|error| CaptureFailure {
        code: "capture_task_failed",
        message: format!("The native capture task stopped unexpectedly: {error}"),
    });
    desktop_clutter.restore();
    let stored = resolve_cancelled_capture_permission(
        stored_result?,
        crate::system::screen_recording_granted(),
    )?;

    publish_stored_capture(&app, mode, stored).await
}

pub(crate) async fn capture_previous_area(
    app: AppHandle,
    rect: CaptureRect,
) -> Result<CaptureOutcome, CaptureFailure> {
    let _capture_lease = CaptureLease::try_acquire(&CAPTURE_IN_PROGRESS)?;
    require_idle_annotation(crate::annotation::is_active(&app))?;
    if !crate::system::screen_recording_granted() {
        return Err(CaptureFailure {
            code: "screen_recording_required",
            message: "Grant Screen Recording before replaying Previous Area.".into(),
        });
    }
    let app_data = app.path().app_data_dir().map_err(|error| CaptureFailure {
        code: "storage_unavailable",
        message: format!("Could not locate Capso's data directory: {error}"),
    })?;
    let capture_id = new_capture_id();
    prepare_capture_output(&app_data, &capture_id)?;
    let settings = crate::capture_hud::load_settings(&app_data).settings;
    let mut desktop_clutter =
        crate::recording::DesktopClutterLease::begin(app.clone(), settings.hide_desktop_icons)
            .map_err(|message| CaptureFailure {
                code: "desktop_clutter_unavailable",
                message,
            })?;
    let stored_result = tauri::async_runtime::spawn_blocking(move || {
        run_rectangle_capture(&app_data, rect, &capture_id, &SystemCaptureRunner)
    })
    .await
    .map_err(|error| CaptureFailure {
        code: "capture_task_failed",
        message: format!("The Previous Area task stopped unexpectedly: {error}"),
    });
    desktop_clutter.restore();
    let stored = resolve_cancelled_capture_permission(
        stored_result?,
        crate::system::screen_recording_granted(),
    )?;
    publish_stored_capture(&app, CaptureMode::Region, stored).await
}

/// Presents Capso's full-display precision selector on the display under the
/// pointer, then captures the exact bounded rectangle through the same durable
/// Region pipeline. This legacy precision path also requires Screen Recording.
pub(crate) async fn capture_selected_area(
    app: AppHandle,
) -> Result<(CaptureOutcome, Option<CapturedArea>), CaptureFailure> {
    let _capture_lease = CaptureLease::try_acquire(&CAPTURE_IN_PROGRESS)?;
    require_idle_annotation(crate::annotation::is_active(&app))?;
    if !crate::system::screen_recording_granted() {
        return Err(CaptureFailure {
            code: "screen_recording_required",
            message: "Grant Screen Recording to use exact Area dimensions and aspect lock.".into(),
        });
    }

    let monitors = app.available_monitors().map_err(|error| CaptureFailure {
        code: "area_display_unavailable",
        message: format!("Could not inspect displays for Area selection: {error}"),
    })?;
    let cursor = app.cursor_position().ok();
    let monitor = cursor
        .and_then(|cursor| {
            monitors.iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                cursor.x >= f64::from(position.x)
                    && cursor.x < f64::from(position.x) + f64::from(size.width)
                    && cursor.y >= f64::from(position.y)
                    && cursor.y < f64::from(position.y) + f64::from(size.height)
            })
        })
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| CaptureFailure {
            code: "area_display_missing",
            message: "Could not find a display for Area selection.".into(),
        })?;
    let position = *monitor.position();
    let size = *monitor.size();
    let scale = monitor.scale_factor();
    let logical_width = f64::from(size.width) / scale;
    let logical_height = f64::from(size.height) / scale;
    let geometry = crate::area_selector::DisplayGeometry::new(
        (f64::from(position.x) / scale).round() as i32,
        (f64::from(position.y) / scale).round() as i32,
        logical_width,
        logical_height,
        scale,
    )
    .map_err(|message| CaptureFailure {
        code: "area_display_invalid",
        message,
    })?;
    let app_data = app.path().app_data_dir().map_err(|error| CaptureFailure {
        code: "storage_unavailable",
        message: format!("Could not locate Capso's data directory: {error}"),
    })?;
    let capture_id = new_capture_id();
    prepare_capture_output(&app_data, &capture_id)?;
    let settings = crate::capture_hud::load_settings(&app_data).settings;
    let mut desktop_clutter =
        crate::recording::DesktopClutterLease::begin(app.clone(), settings.hide_desktop_icons)
            .map_err(|message| CaptureFailure {
                code: "desktop_clutter_unavailable",
                message,
            })?;
    let full_display = crate::area_selector::AreaSelection {
        x: 0.0,
        y: 0.0,
        width: logical_width,
        height: logical_height,
    };
    let preview_rect = geometry
        .capture_rect(full_display)
        .map_err(|message| CaptureFailure {
            code: "area_display_invalid",
            message,
        })?;
    let preview_data = app_data.clone();
    let preview_id = new_capture_id();
    let preview_frame = match tauri::async_runtime::spawn_blocking(move || {
        run_area_selector_frame(
            &preview_data,
            preview_rect,
            (size.width, size.height),
            &preview_id,
            &SystemCaptureRunner,
        )
    })
    .await
    {
        Ok(Ok(frame)) => Some(frame),
        Ok(Err(error)) => {
            eprintln!(
                "Area magnifier unavailable ({}): {}",
                error.code, error.message
            );
            None
        }
        Err(error) => {
            eprintln!("Area magnifier task stopped unexpectedly: {error}");
            None
        }
    };
    let preview_path = preview_frame
        .as_ref()
        .map(|frame| frame.path().to_string_lossy().into_owned());
    let session = app
        .state::<crate::area_selector::AreaSelectorCoordinator>()
        .prepare(geometry, preview_path)
        .map_err(|message| CaptureFailure {
            code: "area_state_unavailable",
            message,
        })?;
    let generation = session.generation;
    let selection_result = async {
        let window = app
            .get_webview_window(crate::area_selector::AREA_SELECTOR_LABEL)
            .ok_or_else(|| CaptureFailure {
                code: "area_window_unavailable",
                message: "Capso's Area precision selector is unavailable.".into(),
            })?;
        window.hide().map_err(|error| CaptureFailure {
            code: "area_window_failed",
            message: format!("Could not reset the Area selector: {error}"),
        })?;
        window
            .set_position(PhysicalPosition::new(position.x, position.y))
            .and_then(|_| window.set_size(PhysicalSize::new(size.width, size.height)))
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
            .map_err(|error| CaptureFailure {
                code: "area_window_failed",
                message: format!("Could not present the Area selector: {error}"),
            })?;
        app.emit_to(
            crate::area_selector::AREA_SELECTOR_LABEL,
            "area-selector-changed",
            session,
        )
        .map_err(|error| CaptureFailure {
            code: "area_window_failed",
            message: format!("Could not deliver the Area selector state: {error}"),
        })?;

        let wait_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            wait_app
                .state::<crate::area_selector::AreaSelectorCoordinator>()
                .wait_for_selection(generation, AREA_SELECTION_TIMEOUT)
        })
        .await
        .map_err(|error| CaptureFailure {
            code: "area_task_failed",
            message: format!("Area selection stopped unexpectedly: {error}"),
        })
    }
    .await;

    if let Some(window) = app.get_webview_window(crate::area_selector::AREA_SELECTOR_LABEL) {
        let _ = window.hide();
    }
    let display = app
        .state::<crate::area_selector::AreaSelectorCoordinator>()
        .display(generation);
    let _ = app
        .state::<crate::area_selector::AreaSelectorCoordinator>()
        .cleanup(generation);

    let wait = selection_result?;
    let selection = match wait {
        crate::area_selector::AreaSelectorWait::Selected(selection) => selection,
        crate::area_selector::AreaSelectorWait::Cancelled => {
            return Ok((CaptureOutcome::Cancelled, None));
        }
        crate::area_selector::AreaSelectorWait::TimedOut => {
            return Err(CaptureFailure {
                code: "area_selection_timeout",
                message: "Area selection timed out before a rectangle was confirmed.".into(),
            });
        }
        crate::area_selector::AreaSelectorWait::Stale => {
            return Err(CaptureFailure {
                code: "area_selection_stale",
                message: "Area selection was replaced before capture could start.".into(),
            });
        }
    };
    let display = display.ok_or_else(|| CaptureFailure {
        code: "area_selection_stale",
        message: "Area display geometry was lost before capture could start.".into(),
    })?;
    let rect = display
        .capture_rect(selection)
        .map_err(|message| CaptureFailure {
            code: "area_selection_invalid",
            message,
        })?;
    let expected_dimensions =
        display
            .output_dimensions(selection)
            .map_err(|message| CaptureFailure {
                code: "area_selection_invalid",
                message,
            })?;
    let stored_result = tauri::async_runtime::spawn_blocking(move || {
        run_precise_rectangle_capture(
            &app_data,
            rect,
            expected_dimensions,
            &capture_id,
            &SystemCaptureRunner,
        )
    })
    .await
    .map_err(|error| CaptureFailure {
        code: "capture_task_failed",
        message: format!("The exact Area capture task stopped unexpectedly: {error}"),
    });
    desktop_clutter.restore();
    let stored = resolve_cancelled_capture_permission(
        stored_result?,
        crate::system::screen_recording_granted(),
    )?;
    let outcome = publish_stored_capture(&app, CaptureMode::Region, stored).await?;
    Ok((
        outcome,
        Some(CapturedArea {
            rect,
            pixel_dimensions: expected_dimensions,
        }),
    ))
}

/// Freezes the main display into an app-owned private frame, waits until the
/// borderless webview has decoded it, then runs macOS' Area picker on display 1.
/// The frame guard removes the private PNG on success, cancel, timeout, or error.
pub(crate) async fn capture_frozen_area(app: AppHandle) -> Result<CaptureOutcome, CaptureFailure> {
    let _capture_lease = CaptureLease::try_acquire(&CAPTURE_IN_PROGRESS)?;
    require_idle_annotation(crate::annotation::is_active(&app))?;
    if !crate::system::screen_recording_granted() {
        return Err(CaptureFailure {
            code: "screen_recording_required",
            message: "Grant Screen Recording before using Freeze Screen.".into(),
        });
    }

    let app_data = app.path().app_data_dir().map_err(|error| CaptureFailure {
        code: "storage_unavailable",
        message: format!("Could not locate Capso's data directory: {error}"),
    })?;
    let capture_id = new_capture_id();
    prepare_capture_output(&app_data, &capture_id)?;
    let settings = crate::capture_hud::load_settings(&app_data).settings;
    let mut desktop_clutter =
        crate::recording::DesktopClutterLease::begin(app.clone(), settings.hide_desktop_icons)
            .map_err(|message| CaptureFailure {
                code: "desktop_clutter_unavailable",
                message,
            })?;
    let frame_id = new_capture_id();
    let frame_data = app_data.clone();
    let frame = tauri::async_runtime::spawn_blocking(move || {
        run_freeze_frame(&frame_data, &frame_id, &SystemCaptureRunner)
    })
    .await
    .map_err(|error| CaptureFailure {
        code: "freeze_task_failed",
        message: format!("The Freeze Screen frame task stopped unexpectedly: {error}"),
    })??;

    let presented = app
        .state::<crate::freeze::FreezeCoordinator>()
        .prepare(frame.path().to_path_buf())
        .map_err(|message| CaptureFailure {
            code: "freeze_state_unavailable",
            message,
        })?;
    let generation = presented.generation;

    let frozen_result = async {
        let monitor = app
            .primary_monitor()
            .map_err(|error| CaptureFailure {
                code: "freeze_display_unavailable",
                message: format!("Could not inspect the main display: {error}"),
            })?
            .ok_or_else(|| CaptureFailure {
                code: "freeze_display_missing",
                message: "Could not find the main display for Freeze Screen.".into(),
            })?;
        let window = app
            .get_webview_window(crate::freeze::FREEZE_LABEL)
            .ok_or_else(|| CaptureFailure {
                code: "freeze_window_unavailable",
                message: "Capso's Freeze Screen surface is unavailable.".into(),
            })?;
        window.hide().map_err(|error| CaptureFailure {
            code: "freeze_window_failed",
            message: format!("Could not reset Freeze Screen: {error}"),
        })?;
        window
            .set_position(PhysicalPosition::new(
                monitor.position().x,
                monitor.position().y,
            ))
            .and_then(|_| {
                window.set_size(PhysicalSize::new(
                    monitor.size().width,
                    monitor.size().height,
                ))
            })
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
            .map_err(|error| CaptureFailure {
                code: "freeze_window_failed",
                message: format!("Could not present Freeze Screen on the main display: {error}"),
            })?;
        app.emit_to(
            crate::freeze::FREEZE_LABEL,
            "freeze-frame-changed",
            presented.clone(),
        )
        .map_err(|error| CaptureFailure {
            code: "freeze_window_failed",
            message: format!("Could not deliver the private Freeze Screen frame: {error}"),
        })?;

        let wait_app = app.clone();
        let wait = tauri::async_runtime::spawn_blocking(move || {
            wait_app
                .state::<crate::freeze::FreezeCoordinator>()
                .wait_until_ready(generation, FREEZE_READY_TIMEOUT)
        })
        .await
        .map_err(|error| CaptureFailure {
            code: "freeze_task_failed",
            message: format!("Freeze Screen readiness stopped unexpectedly: {error}"),
        })?;

        match wait {
            crate::freeze::FreezeWait::Ready => {
                if !app
                    .state::<crate::freeze::FreezeCoordinator>()
                    .begin_picker(generation)
                {
                    return Ok(None);
                }
            }
            crate::freeze::FreezeWait::Cancelled => return Ok(None),
            crate::freeze::FreezeWait::TimedOut => {
                return Err(CaptureFailure {
                    code: "freeze_frame_timeout",
                    message: "Freeze Screen could not display the private frame in time.".into(),
                });
            }
            crate::freeze::FreezeWait::Stale => {
                return Err(CaptureFailure {
                    code: "freeze_frame_stale",
                    message: "Freeze Screen was replaced before capture could start.".into(),
                });
            }
        }

        let capture_id = capture_id.clone();
        let capture_data = app_data.clone();
        let stored_result = tauri::async_runtime::spawn_blocking(move || {
            run_frozen_area_capture(&capture_data, &capture_id, &SystemCaptureRunner)
        })
        .await
        .map_err(|error| CaptureFailure {
            code: "capture_task_failed",
            message: format!("The frozen Area task stopped unexpectedly: {error}"),
        })?;
        let stored = resolve_cancelled_capture_permission(
            stored_result,
            crate::system::screen_recording_granted(),
        )?;
        Ok(Some(stored))
    }
    .await;

    if let Some(window) = app.get_webview_window(crate::freeze::FREEZE_LABEL) {
        let _ = window.hide();
    }
    let _ = app
        .state::<crate::freeze::FreezeCoordinator>()
        .cleanup(generation);
    drop(frame);
    desktop_clutter.restore();

    match frozen_result? {
        Some(stored) => publish_stored_capture(&app, CaptureMode::Region, stored).await,
        None => Ok(CaptureOutcome::Cancelled),
    }
}

async fn publish_stored_capture(
    app: &AppHandle,
    mode: CaptureMode,
    stored: StoredCaptureOutcome,
) -> Result<CaptureOutcome, CaptureFailure> {
    publish_stored_capture_with_source(app, mode, mode.into(), stored).await
}

async fn publish_stored_capture_with_source(
    app: &AppHandle,
    mode: CaptureMode,
    queue_source: crate::queue::QueueSource,
    stored: StoredCaptureOutcome,
) -> Result<CaptureOutcome, CaptureFailure> {
    match stored {
        StoredCaptureOutcome::Cancelled => Ok(CaptureOutcome::Cancelled),
        StoredCaptureOutcome::Captured {
            path,
            overlay_latency_start,
        } => {
            let queue =
                crate::queue::enqueue_capture(app.clone(), path.clone(), queue_source).await;
            let clipboard =
                crate::clipboard::copy_new_capture_to_general_pasteboard(app.clone(), path.clone())
                    .await;
            let overlay = crate::overlay::prepare_capture_overlay(
                app,
                mode,
                &path,
                &clipboard,
                overlay_latency_start,
            );
            if let Err(error) = crate::refresh_tray_status(app) {
                eprintln!("Could not refresh Capso after capture: {error}");
            }
            Ok(CaptureOutcome::Captured {
                path: path.to_string_lossy().into_owned(),
                clipboard,
                overlay,
                queue,
            })
        }
    }
}

/// Publishes an already-durable image produced by an in-app composition tool
/// through the same clipboard, queue, Quick Access, and tray transaction as a
/// new screenshot. Composition owns file creation; this function owns all
/// post-creation identity and delivery state.
pub(crate) async fn publish_created_capture(
    app: &AppHandle,
    path: PathBuf,
) -> Result<CaptureOutcome, CaptureFailure> {
    publish_stored_capture_with_source(
        app,
        CaptureMode::Region,
        crate::queue::QueueSource::Created,
        StoredCaptureOutcome::Captured {
            path,
            overlay_latency_start: crate::latency::OverlayLatencyStart::new(
                CaptureMode::Region,
                Instant::now(),
            ),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        apply_window_style, capture_path, classify_capture, cleanup_stale_freeze_frames,
        freeze_frame_args, frozen_area_args, prepare_capture_output, require_idle_annotation,
        run_area_selector_frame, run_freeze_frame, run_precise_rectangle_capture,
        run_rectangle_capture, screencapture_args, screencapture_rect_args, CaptureDurability,
        CaptureEvidence, CaptureMode, CaptureOutcome, CaptureRect, CaptureRunner, ProcessResult,
        StoredCaptureOutcome,
    };
    use crate::capture_hud::{WindowBackground, WindowCaptureStyle};
    use crate::clipboard::ClipboardStatus;
    use crate::overlay::OverlayStatus;
    use crate::queue::CaptureQueueStatus;
    use std::{
        cell::RefCell,
        ffi::OsString,
        fs, io,
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
        time::Instant,
    };

    struct WritingRunner;

    #[test]
    fn screenshot_desktop_cleanup_preflight_rejects_collisions_and_linked_storage() {
        let root = tempfile::tempdir().expect("temporary app data");
        let output = prepare_capture_output(root.path(), "safe-capture")
            .expect("direct missing output should preflight");
        assert_eq!(output, root.path().join("captures/safe-capture.png"));

        std::fs::write(&output, b"collision").expect("collision fixture");
        assert!(prepare_capture_output(root.path(), "safe-capture").is_err());

        let linked_root = tempfile::tempdir().expect("linked app data");
        let outside = tempfile::tempdir().expect("outside capture directory");
        std::os::unix::fs::symlink(outside.path(), linked_root.path().join("captures"))
            .expect("capture directory symlink fixture");
        assert!(prepare_capture_output(linked_root.path(), "linked-capture").is_err());
    }

    #[test]
    fn active_annotation_blocks_every_capture_before_the_picker_runs() {
        let failure = require_idle_annotation(true).expect_err("annotation blocks capture");
        assert_eq!(failure.code, "annotation_in_progress");
        assert!(failure.message.contains("Finish or cancel"));
        assert!(require_idle_annotation(false).is_ok());
    }

    #[test]
    fn previous_area_uses_one_exact_noninteractive_rectangle() {
        let output = Path::new("/tmp/capso-previous.png");
        let rect = CaptureRect::new(-640, 120, 480, 320).expect("valid rectangle");
        assert_eq!(
            screencapture_rect_args(rect, output),
            vec![
                OsString::from("-R-640,120,480,320"),
                OsString::from("-x"),
                OsString::from("-t"),
                OsString::from("png"),
                output.as_os_str().to_os_string(),
            ]
        );
    }

    #[test]
    fn freeze_screen_uses_main_display_only_for_frame_and_picker() {
        let frame = Path::new("/tmp/capso-freeze-frame.png");
        assert_eq!(
            freeze_frame_args(frame),
            vec![
                OsString::from("-m"),
                OsString::from("-x"),
                OsString::from("-t"),
                OsString::from("png"),
                frame.as_os_str().to_os_string(),
            ]
        );

        let output = Path::new("/tmp/capso-frozen-selection.png");
        assert_eq!(
            frozen_area_args(output),
            vec![
                OsString::from("-D1"),
                OsString::from("-i"),
                OsString::from("-s"),
                OsString::from("-x"),
                OsString::from("-t"),
                OsString::from("png"),
                output.as_os_str().to_os_string(),
            ]
        );
    }

    #[test]
    fn private_freeze_frame_is_removed_when_its_owner_leaves_scope() {
        let root = tempfile::tempdir().expect("temporary app data");
        let path = root.path().join("freeze/owned.png");
        {
            let frame = run_freeze_frame(root.path(), "owned", &WritingRunner)
                .expect("private frame should be captured");
            assert_eq!(frame.path(), path);
            assert_eq!(std::fs::read(&path).unwrap(), b"fake png bytes");
        }
        assert!(!path.exists());
        assert!(!root.path().join("freeze").exists());
    }

    #[test]
    fn startup_cleanup_removes_only_capso_owned_uuid_freeze_frames() {
        let root = tempfile::tempdir().expect("temporary app data");
        let directory = root.path().join("freeze");
        std::fs::create_dir_all(&directory).unwrap();
        let owned = directory.join("018f22c4-cada-7c6b-9d5b-fc35f7f9227a.png");
        let unknown = directory.join("keep-me.png");
        std::fs::write(&owned, b"private stale pixels").unwrap();
        std::fs::write(&unknown, b"not owned by the UUID contract").unwrap();

        assert_eq!(cleanup_stale_freeze_frames(root.path()).unwrap(), 1);
        assert!(!owned.exists());
        assert!(unknown.exists());
    }

    #[test]
    fn previous_area_enters_the_same_durable_region_capture_path() {
        let root = tempfile::tempdir().expect("temporary app data");
        let rect = CaptureRect::new(20, 30, 640, 360).unwrap();
        let outcome = run_rectangle_capture(root.path(), rect, "previous", &WritingRunner)
            .expect("rectangle capture should complete");
        let StoredCaptureOutcome::Captured { path, .. } = outcome else {
            panic!("rectangle should create a capture");
        };
        assert_eq!(path, root.path().join("captures/previous.png"));
        assert_eq!(std::fs::read(path).unwrap(), b"fake png bytes");
    }

    struct SizedPngRunner {
        width: u32,
        height: u32,
    }

    impl CaptureRunner for SizedPngRunner {
        fn run(&self, args: &[OsString]) -> io::Result<ProcessResult> {
            let output = Path::new(args.last().expect("output path").as_os_str());
            image::RgbaImage::from_pixel(self.width, self.height, image::Rgba([4, 8, 12, 255]))
                .save(output)
                .map_err(io::Error::other)?;
            Ok(ProcessResult {
                stderr: String::new(),
            })
        }
    }

    #[test]
    fn precision_capture_requires_the_png_to_match_the_displayed_pixel_dimensions() {
        let root = tempfile::tempdir().expect("temporary app data");
        let rect = CaptureRect::new(20, 30, 32, 18).unwrap();
        assert!(run_precise_rectangle_capture(
            root.path(),
            rect,
            (64, 36),
            "exact",
            &SizedPngRunner {
                width: 64,
                height: 36
            },
        )
        .is_ok());

        let failure = run_precise_rectangle_capture(
            root.path(),
            rect,
            (64, 36),
            "mismatch",
            &SizedPngRunner {
                width: 63,
                height: 36,
            },
        )
        .expect_err("wrong output dimensions fail closed");
        assert_eq!(failure.code, "area_dimensions_mismatch");
        assert!(!root.path().join("captures/mismatch.png").exists());
    }

    #[test]
    fn area_magnifier_frame_is_private_exact_and_owned() {
        let root = tempfile::tempdir().expect("temporary app data");
        let rect = CaptureRect::new(-20, 30, 32, 18).unwrap();
        let frame = run_area_selector_frame(
            root.path(),
            rect,
            (64, 36),
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            &SizedPngRunner {
                width: 64,
                height: 36,
            },
        )
        .expect("exact private preview should be available");
        let path = root
            .path()
            .join("freeze/018f22c4-cada-7c6b-9d5b-fc35f7f9227a.png");
        assert_eq!(frame.path(), path);
        drop(frame);
        assert!(!path.exists());

        let failure = run_area_selector_frame(
            root.path(),
            rect,
            (64, 36),
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227b",
            &SizedPngRunner {
                width: 63,
                height: 36,
            },
        )
        .expect_err("mismatched private preview fails closed");
        assert_eq!(failure.code, "area_preview_dimensions_mismatch");
        assert!(!root
            .path()
            .join("freeze/018f22c4-cada-7c6b-9d5b-fc35f7f9227b.png")
            .exists());
    }

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

    #[derive(Default)]
    struct BoundaryRunner {
        returning_at: RefCell<Option<Instant>>,
    }

    impl CaptureRunner for BoundaryRunner {
        fn run(&self, args: &[OsString]) -> io::Result<ProcessResult> {
            let output = Path::new(args.last().expect("output path").as_os_str());
            fs::write(output, b"fake png bytes")?;
            self.returning_at.replace(Some(Instant::now()));
            Ok(ProcessResult {
                stderr: String::new(),
            })
        }
    }

    #[derive(Default)]
    struct BoundaryDurability {
        file_sync_started_at: RefCell<Option<Instant>>,
    }

    impl CaptureDurability for BoundaryDurability {
        fn sync_file(&self, _path: &Path) -> io::Result<()> {
            self.file_sync_started_at.replace(Some(Instant::now()));
            Ok(())
        }

        fn sync_directory(&self, _path: &Path) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum DurabilityStage {
        File,
        Directory,
    }

    struct FaultDurability {
        fail_at: DurabilityStage,
        calls: RefCell<Vec<DurabilityStage>>,
    }

    impl CaptureDurability for FaultDurability {
        fn sync_file(&self, _path: &Path) -> io::Result<()> {
            self.calls.borrow_mut().push(DurabilityStage::File);
            if self.fail_at == DurabilityStage::File {
                Err(io::Error::other("injected file sync failure"))
            } else {
                Ok(())
            }
        }

        fn sync_directory(&self, _path: &Path) -> io::Result<()> {
            self.calls.borrow_mut().push(DurabilityStage::Directory);
            if self.fail_at == DurabilityStage::Directory {
                Err(io::Error::other("injected directory sync failure"))
            } else {
                Ok(())
            }
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
    fn window_shadow_is_an_explicit_picker_argument() {
        let output = Path::new("/tmp/capso/window.png");
        let no_shadow = WindowCaptureStyle {
            shadow: false,
            ..WindowCaptureStyle::default()
        };
        assert!(super::screencapture_args_with_window_style(
            CaptureMode::Window,
            output,
            no_shadow,
        )
        .contains(&OsString::from("-o")));
        assert!(!super::screencapture_args_with_window_style(
            CaptureMode::Window,
            output,
            WindowCaptureStyle::default(),
        )
        .contains(&OsString::from("-o")));
    }

    #[test]
    fn window_padding_and_background_export_exact_rgba_without_resizing_the_source() {
        let root = tempfile::tempdir().expect("temporary app data");
        let path = root.path().join("window.png");
        image::RgbaImage::from_pixel(2, 1, image::Rgba([10, 20, 30, 128]))
            .save(&path)
            .unwrap();
        apply_window_style(
            &path,
            &WindowCaptureStyle {
                shadow: true,
                padding: 1,
                background: WindowBackground::Custom,
                custom_background: "#A1B2C3".into(),
            },
        )
        .expect("bounded style should export");
        let output = image::open(&path).unwrap().into_rgba8();
        assert_eq!(output.dimensions(), (4, 3));
        assert_eq!(output.get_pixel(0, 0).0, [161, 178, 195, 255]);
        assert_eq!(output.get_pixel(1, 1).0, [85, 99, 112, 255]);
    }

    #[test]
    fn window_style_failure_removes_the_unpublished_picker_output() {
        let root = tempfile::tempdir().expect("temporary app data");
        let failure = super::run_window_capture_with_style(
            root.path(),
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            &WritingRunner,
            WindowCaptureStyle {
                background: WindowBackground::Canvas,
                ..WindowCaptureStyle::default()
            },
        )
        .expect_err("invalid picker pixels must fail before publication");
        assert_eq!(failure.code, "window_style_invalid");
        assert!(!root
            .path()
            .join("captures/018f22c4-cada-7c6b-9d5b-fc35f7f9227a.png")
            .exists());
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
        let selection_completed_at = Instant::now();

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: None,
                    stderr: "",
                    mode: CaptureMode::Region,
                    cancellable: true,
                    selection_completed_at,
                },
            ),
            Ok(StoredCaptureOutcome::Cancelled)
        );
    }

    #[test]
    fn missing_output_from_a_noninteractive_capture_is_a_failure() {
        let output = Path::new("/tmp/capso/missing.png");

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: None,
                    stderr: "",
                    mode: CaptureMode::Fullscreen,
                    cancellable: false,
                    selection_completed_at: Instant::now(),
                },
            ),
            Err(super::CaptureFailure {
                code: "capture_failed",
                message: "Screen capture ended without creating an image.".into(),
            })
        );
    }

    #[test]
    fn cancelled_picker_becomes_permission_guidance_when_access_was_lost() {
        let failure =
            super::resolve_cancelled_capture_permission(Ok(StoredCaptureOutcome::Cancelled), false)
                .expect_err("revoked access is not a user cancellation");

        assert_eq!(failure.code, "screen_recording_required");
        assert!(failure.message.contains("Area, Window, and Full Screen"));
        assert_eq!(
            super::resolve_cancelled_capture_permission(Ok(StoredCaptureOutcome::Cancelled), true,),
            Ok(StoredCaptureOutcome::Cancelled)
        );
    }

    #[test]
    fn diagnostic_no_output_becomes_permission_guidance_only_after_access_is_lost() {
        let diagnostic = super::CaptureFailure {
            code: "capture_failed",
            message: "macOS did not create an image".into(),
        };
        let failure = super::resolve_cancelled_capture_permission(Err(diagnostic.clone()), false)
            .expect_err("revoked access should replace a no-pixels diagnostic");
        assert_eq!(failure.code, "screen_recording_required");

        assert_eq!(
            super::resolve_cancelled_capture_permission(Err(diagnostic.clone()), true),
            Err(diagnostic)
        );

        let storage = super::CaptureFailure {
            code: "storage_failed",
            message: "disk is full".into(),
        };
        assert_eq!(
            super::resolve_cancelled_capture_permission(Err(storage.clone()), false),
            Err(storage),
            "permission recovery must not hide an independent storage failure",
        );
    }

    #[test]
    fn non_empty_output_is_a_completed_capture() {
        let output = Path::new("/tmp/capso/captured.png");
        let selection_completed_at = Instant::now();

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: Some(42),
                    stderr: "",
                    mode: CaptureMode::Window,
                    cancellable: true,
                    selection_completed_at,
                },
            ),
            Ok(StoredCaptureOutcome::Captured {
                path: output.to_path_buf(),
                overlay_latency_start: crate::latency::OverlayLatencyStart::new(
                    CaptureMode::Window,
                    selection_completed_at,
                ),
            })
        );
    }

    #[test]
    fn completed_capture_serializes_the_saved_path_and_clipboard_proof() {
        let outcome = CaptureOutcome::Captured {
            path: "/tmp/capso/captured.png".into(),
            clipboard: ClipboardStatus::Copied { bytes: 42 },
            overlay: OverlayStatus::Prepared { x: 1440, y: 900 },
            queue: CaptureQueueStatus::Enqueued {
                id: "018f22c4-cada-7c6b-9d5b-fc35f7f9227a".into(),
                queued: 1,
            },
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
                },
                "queue": {
                    "status": "enqueued",
                    "id": "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
                    "queued": 1
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
            queue: CaptureQueueStatus::Failed {
                code: "queue_persist_failed",
                message: "Could not commit queue".into(),
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
                },
                "queue": {
                    "status": "failed",
                    "code": "queue_persist_failed",
                    "message": "Could not commit queue"
                }
            })
        );
    }

    #[test]
    fn missing_output_with_a_diagnostic_is_an_actionable_failure() {
        let output = Path::new("/tmp/capso/denied.png");
        let selection_completed_at = Instant::now();

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: None,
                    stderr: "screen capture permission denied\n",
                    mode: CaptureMode::Window,
                    cancellable: true,
                    selection_completed_at,
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
        let selection_completed_at = Instant::now();

        assert_eq!(
            classify_capture(
                output,
                CaptureEvidence {
                    output_bytes: Some(0),
                    stderr: "",
                    mode: CaptureMode::Fullscreen,
                    cancellable: false,
                    selection_completed_at,
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

        let StoredCaptureOutcome::Captured { path, .. } = result.expect("stored capture") else {
            panic!("expected completed capture");
        };
        assert_eq!(path, expected);
        assert_eq!(
            fs::read(&expected).expect("stored capture"),
            b"fake png bytes"
        );

        fs::remove_dir_all(app_data).expect("clean test capture directory");
    }

    #[test]
    fn overlay_latency_starts_after_picker_completion_and_before_durability_work() {
        let app_data = tempfile::tempdir().expect("temporary app data");
        let runner = BoundaryRunner::default();
        let durability = BoundaryDurability::default();

        let outcome = super::run_capture_with_durability(
            app_data.path(),
            CaptureMode::Region,
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            &runner,
            &durability,
        )
        .expect("capture succeeds");
        let StoredCaptureOutcome::Captured {
            overlay_latency_start,
            ..
        } = outcome
        else {
            panic!("expected completed capture");
        };
        let selection_completed_at = overlay_latency_start.selection_completed_at();

        assert!(selection_completed_at >= runner.returning_at.borrow().expect("runner boundary"));
        assert!(
            selection_completed_at
                <= durability
                    .file_sync_started_at
                    .borrow()
                    .expect("durability boundary")
        );
    }

    #[test]
    fn capture_success_requires_both_file_and_directory_sync() {
        for (failure, expected_calls) in [
            (DurabilityStage::File, vec![DurabilityStage::File]),
            (
                DurabilityStage::Directory,
                vec![DurabilityStage::File, DurabilityStage::Directory],
            ),
        ] {
            let app_data = tempfile::tempdir().expect("temporary app data");
            let durability = FaultDurability {
                fail_at: failure,
                calls: RefCell::new(Vec::new()),
            };

            let error = super::run_capture_with_durability(
                app_data.path(),
                CaptureMode::Region,
                "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
                &WritingRunner,
                &durability,
            )
            .expect_err("unsynced pixels cannot be reported as durable");

            assert_eq!(error.code, "storage_failed");
            assert_eq!(*durability.calls.borrow(), expected_calls);
            assert!(
                capture_path(app_data.path(), "018f22c4-cada-7c6b-9d5b-fc35f7f9227a").exists(),
                "sync failure reporting must not delete captured pixels"
            );
        }
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
