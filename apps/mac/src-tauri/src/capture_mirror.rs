use crate::queue::QueueSource;
use image::ImageDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Write},
    path::Path,
    sync::Mutex,
};

use crate::queue::{QueueRuntime, RemoteStageOutcome};

const MAX_CAPTURE_BYTES: usize = 25 * 1_024 * 1_024;
const MAX_DECODE_PIXELS: u64 = 80_000_000;
const MAX_DOWNLOADS_PER_PASS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub(crate) enum RemoteCaptureSource {
    #[serde(rename = "hotkey_region")]
    Region,
    #[serde(rename = "hotkey_window")]
    Window,
    #[serde(rename = "hotkey_fullscreen")]
    Fullscreen,
    #[serde(rename = "clipboard", alias = "drag")]
    Created,
    #[serde(rename = "extension")]
    Browser,
}

impl From<RemoteCaptureSource> for QueueSource {
    fn from(source: RemoteCaptureSource) -> Self {
        match source {
            RemoteCaptureSource::Region => Self::Region,
            RemoteCaptureSource::Window => Self::Window,
            RemoteCaptureSource::Fullscreen => Self::Fullscreen,
            RemoteCaptureSource::Created => Self::Created,
            RemoteCaptureSource::Browser => Self::Browser,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RemoteProcessingStatus {
    Pending,
    Processing,
    Processed,
    Unprocessed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RemoteCaptureHead {
    #[serde(rename = "screenshot_id")]
    pub(crate) capture_id: String,
    pub(crate) captured_at: String,
    pub(crate) storage_path: String,
    pub(crate) content_hash: String,
    pub(crate) source: RemoteCaptureSource,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bytes: u64,
    pub(crate) project_thread_id: Option<String>,
    pub(crate) processing_status: RemoteProcessingStatus,
}

pub(crate) trait CaptureCloudTransport {
    fn list_remote_capture_heads(&self) -> Result<Vec<RemoteCaptureHead>, String>;
    fn download_remote_capture(&self, head: &RemoteCaptureHead) -> Result<Vec<u8>, String>;
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RemoteCaptureReconcileReport {
    pub(crate) discovered: usize,
    pub(crate) downloaded: usize,
    pub(crate) current: usize,
    pub(crate) deferred: usize,
    pub(crate) failed: usize,
    pub(crate) last_error: Option<String>,
}

impl RemoteCaptureReconcileReport {
    fn record_failure(&mut self, error: String) {
        self.failed += 1;
        self.last_error = Some(error);
    }
}

fn captured_at_ms(value: &str) -> Result<u64, String> {
    let timestamp =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
            .map_err(|_| "The remote screenshot timestamp is invalid.".to_string())?;
    let nanos = timestamp.unix_timestamp_nanos();
    if nanos <= 0 {
        return Err("The remote screenshot timestamp is invalid.".into());
    }
    u64::try_from(nanos / 1_000_000)
        .map_err(|_| "The remote screenshot timestamp is outside Capso's range.".to_string())
}

fn normalize_pixels(head: &RemoteCaptureHead, pixels: &[u8]) -> Result<Vec<u8>, String> {
    if pixels.len() != head.bytes as usize
        || !(8..=MAX_CAPTURE_BYTES).contains(&pixels.len())
        || format!("sha256:{:x}", Sha256::digest(pixels)) != head.content_hash
    {
        return Err("The downloaded screenshot failed its exact byte identity.".into());
    }
    if head.width == 0
        || head.height == 0
        || u64::from(head.width).saturating_mul(u64::from(head.height)) > MAX_DECODE_PIXELS
    {
        return Err("The downloaded screenshot dimensions exceed Capso's safety limit.".into());
    }
    let dimensions = if head.source == RemoteCaptureSource::Browser {
        image::codecs::jpeg::JpegDecoder::new(Cursor::new(pixels))
            .map(|decoder| decoder.dimensions())
            .map_err(|_| "The downloaded browser screenshot is not a valid JPEG.".to_string())?
    } else {
        image::codecs::png::PngDecoder::new(Cursor::new(pixels))
            .map(|decoder| decoder.dimensions())
            .map_err(|_| "The downloaded screenshot is not a valid PNG.".to_string())?
    };
    if dimensions != (head.width, head.height) {
        return Err("The downloaded screenshot dimensions do not match its cloud head.".into());
    }
    if head.source != RemoteCaptureSource::Browser {
        return Ok(pixels.to_vec());
    }

    let decoded =
        image::load_from_memory_with_format(pixels, image::ImageFormat::Jpeg).map_err(|_| {
            "The downloaded browser screenshot could not be decoded safely.".to_string()
        })?;
    let mut normalized = Cursor::new(Vec::new());
    decoded
        .write_to(&mut normalized, image::ImageFormat::Png)
        .map_err(|_| "The browser screenshot could not be normalized for History.".to_string())?;
    let normalized = normalized.into_inner();
    if !(8..=MAX_CAPTURE_BYTES).contains(&normalized.len())
        || !normalized.starts_with(b"\x89PNG\r\n\x1a\n")
    {
        return Err("The normalized browser screenshot exceeded Capso's safety limit.".into());
    }
    Ok(normalized)
}

fn existing_matches(path: &Path, pixels: &[u8]) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not inspect a local screenshot: {error}")),
    };
    if !metadata.file_type().is_file() || metadata.len() != pixels.len() as u64 {
        return Err("A different local file already uses this screenshot identity.".into());
    }
    fs::read(path)
        .map(|existing| existing == pixels)
        .map_err(|error| format!("Could not verify an existing local screenshot: {error}"))
}

fn install_pixels_atomic(path: &Path, pixels: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The protected screenshot directory is unavailable.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not prepare the screenshot directory: {error}"))?;
    if existing_matches(path, pixels)? {
        return Ok(());
    }

    let capture_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| "The protected screenshot filename is invalid.".to_string())?;
    let temporary = parent.join(format!(
        ".{capture_id}.{}.remote-part",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not reserve the screenshot download: {error}"))?;
        file.write_all(pixels)
            .map_err(|error| format!("Could not write the screenshot download: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync the screenshot download: {error}"))?;
        match fs::hard_link(&temporary, path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !existing_matches(path, pixels)? {
                    return Err(
                        "A different local file already uses this screenshot identity.".into(),
                    );
                }
            }
            Err(error) => {
                return Err(format!("Could not commit the screenshot download: {error}"));
            }
        }
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync the screenshot directory: {error}"))?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    if result.is_ok() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not finish the screenshot install: {error}"))?;
    }
    result
}

pub(crate) fn reconcile_remote_captures<T: CaptureCloudTransport>(
    runtime: &Mutex<QueueRuntime>,
    transport: &T,
    completed_at_ms: u64,
) -> Result<RemoteCaptureReconcileReport, String> {
    if completed_at_ms == 0 {
        return Err("Screenshot reconciliation needs a valid completion time.".into());
    }
    let heads = transport.list_remote_capture_heads()?;
    let mut report = RemoteCaptureReconcileReport {
        discovered: heads.len(),
        ..RemoteCaptureReconcileReport::default()
    };
    let mut attempted_downloads = 0_usize;

    for head in heads {
        let created_at_ms = match captured_at_ms(&head.captured_at) {
            Ok(value) => value,
            Err(error) => {
                report.record_failure(error);
                continue;
            }
        };
        let staged = runtime
            .lock()
            .map_err(|_| "Capso's screenshot queue lock is unavailable.".to_string())?
            .stage_remote_capture(
                &head.capture_id,
                head.source.into(),
                created_at_ms,
                &head.content_hash,
                head.project_thread_id.as_deref(),
            );
        let (outcome, path) = match staged {
            Ok(staged) => staged,
            Err(error) => {
                report.record_failure(error);
                continue;
            }
        };
        if outcome == RemoteStageOutcome::Current {
            report.current += 1;
            continue;
        }
        if attempted_downloads >= MAX_DOWNLOADS_PER_PASS {
            report.deferred += 1;
            continue;
        }
        attempted_downloads += 1;
        let remote_pixels = match transport.download_remote_capture(&head) {
            Ok(pixels) => pixels,
            Err(error) => {
                report.record_failure(error);
                continue;
            }
        };
        let local_pixels = match normalize_pixels(&head, &remote_pixels) {
            Ok(pixels) => pixels,
            Err(error) => {
                report.record_failure(error);
                continue;
            }
        };
        let local_hash = format!("sha256:{:x}", Sha256::digest(&local_pixels));
        if let Err(error) = runtime
            .lock()
            .map_err(|_| "Capso's screenshot queue lock is unavailable.".to_string())?
            .prepare_remote_capture_install(&head.capture_id, &local_hash)
        {
            report.record_failure(error);
            continue;
        }
        if let Err(error) = install_pixels_atomic(&path, &local_pixels) {
            report.record_failure(error);
            continue;
        }
        match runtime
            .lock()
            .map_err(|_| "Capso's screenshot queue lock is unavailable.".to_string())?
            .complete_remote_capture(&head.capture_id, completed_at_ms)
        {
            Ok(()) => report.downloaded += 1,
            Err(error) => report.record_failure(error),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::{
        reconcile_remote_captures, CaptureCloudTransport, RemoteCaptureHead, RemoteCaptureSource,
        RemoteProcessingStatus,
    };
    use crate::queue::{DurableUploadQueue, QueueRuntime, QueueSource};
    use sha2::{Digest, Sha256};
    use std::{fs, path::PathBuf, sync::Mutex};

    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";
    const PROJECT_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92271";
    const USER_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";

    struct InspectingTransport {
        head: RemoteCaptureHead,
        pixels: Vec<u8>,
        store_path: PathBuf,
        downloads: Mutex<usize>,
    }

    impl CaptureCloudTransport for InspectingTransport {
        fn list_remote_capture_heads(&self) -> Result<Vec<RemoteCaptureHead>, String> {
            Ok(vec![self.head.clone()])
        }

        fn download_remote_capture(&self, _head: &RemoteCaptureHead) -> Result<Vec<u8>, String> {
            let document: serde_json::Value = serde_json::from_slice(
                &fs::read(&self.store_path).expect("queue is durable before network download"),
            )
            .expect("queue JSON");
            assert_eq!(document["entries"][0]["status"], "remote_pending");
            *self.downloads.lock().expect("download count") += 1;
            Ok(self.pixels.clone())
        }
    }

    fn remote_fixture(store_path: PathBuf) -> InspectingTransport {
        let image = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, image::ImageFormat::Jpeg)
            .expect("encode JPEG");
        let pixels = encoded.into_inner();
        InspectingTransport {
            head: RemoteCaptureHead {
                capture_id: CAPTURE_ID.into(),
                captured_at: "2026-08-14T03:04:05.006Z".into(),
                storage_path: format!("originals/{USER_ID}/{CAPTURE_ID}.jpg"),
                content_hash: format!("sha256:{:x}", Sha256::digest(&pixels)),
                source: RemoteCaptureSource::Browser,
                width: 3,
                height: 2,
                bytes: pixels.len() as u64,
                project_thread_id: Some(PROJECT_ID.into()),
                processing_status: RemoteProcessingStatus::Processed,
            },
            pixels,
            store_path,
            downloads: Mutex::new(0),
        }
    }

    #[test]
    fn adoption_is_staged_before_download_atomic_visible_and_idempotent() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let queue = DurableUploadQueue::open(&store, &captures, 1_000).expect("open queue");
        let mut runtime = QueueRuntime::default();
        runtime.initialize(Ok(queue));
        let runtime = Mutex::new(runtime);
        let transport = remote_fixture(store.clone());

        let first = reconcile_remote_captures(&runtime, &transport, 2_000)
            .expect("reconcile remote library");
        assert_eq!(first.discovered, 1);
        assert_eq!(first.downloaded, 1);
        assert_eq!(first.current, 0);
        assert_eq!(first.failed, 0);
        assert_eq!(*transport.downloads.lock().expect("downloads"), 1);
        let installed =
            fs::read(captures.join(format!("{CAPTURE_ID}.png"))).expect("installed capture");
        assert!(installed.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_ne!(
            installed, transport.pixels,
            "browser JPEG is normalized locally"
        );
        assert_eq!(
            image::load_from_memory_with_format(&installed, image::ImageFormat::Png)
                .expect("decode installed PNG")
                .to_rgba8()
                .dimensions(),
            (3, 2),
        );
        let guard = runtime.lock().expect("queue runtime");
        assert_eq!(guard.status().summary.remote_pending, 0);
        assert_eq!(guard.status().summary.uploaded, 1);
        assert_eq!(
            guard.capture_sources().expect("sources").get(CAPTURE_ID),
            Some(&QueueSource::Browser),
        );
        drop(guard);
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&store).expect("queue JSON")).expect("decode queue");
        assert_eq!(document["entries"][0]["projectId"], PROJECT_ID);

        let second =
            reconcile_remote_captures(&runtime, &transport, 3_000).expect("repeat reconciliation");
        assert_eq!(second.downloaded, 0);
        assert_eq!(second.current, 1);
        assert_eq!(*transport.downloads.lock().expect("downloads"), 1);
    }

    struct FailingTransport {
        heads: Vec<RemoteCaptureHead>,
        attempts: Mutex<usize>,
    }

    impl CaptureCloudTransport for FailingTransport {
        fn list_remote_capture_heads(&self) -> Result<Vec<RemoteCaptureHead>, String> {
            Ok(self.heads.clone())
        }

        fn download_remote_capture(&self, _head: &RemoteCaptureHead) -> Result<Vec<u8>, String> {
            *self.attempts.lock().expect("attempt count") += 1;
            Err("offline fixture".into())
        }
    }

    #[test]
    fn one_pass_never_attempts_more_than_eight_remote_downloads() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let queue = DurableUploadQueue::open(&store, &captures, 1_000).expect("open queue");
        let mut runtime = QueueRuntime::default();
        runtime.initialize(Ok(queue));
        let runtime = Mutex::new(runtime);
        let heads = (1_u128..=9)
            .map(|number| {
                let capture_id =
                    uuid::Uuid::from_u128(0x018f22c4_cada_7c6b_9d5b_fc35f7f90000 + number)
                        .to_string();
                RemoteCaptureHead {
                    storage_path: format!("originals/{USER_ID}/{capture_id}.png"),
                    capture_id,
                    captured_at: "2026-08-14T03:04:05.006Z".into(),
                    content_hash:
                        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            .into(),
                    source: RemoteCaptureSource::Browser,
                    width: 1,
                    height: 1,
                    bytes: 8,
                    project_thread_id: None,
                    processing_status: RemoteProcessingStatus::Pending,
                }
            })
            .collect();
        let transport = FailingTransport {
            heads,
            attempts: Mutex::new(0),
        };

        let report =
            reconcile_remote_captures(&runtime, &transport, 2_000).expect("bounded reconciliation");

        assert_eq!(*transport.attempts.lock().expect("attempts"), 8);
        assert_eq!(report.failed, 8);
        assert_eq!(report.deferred, 1);
        assert_eq!(report.last_error.as_deref(), Some("offline fixture"));
        assert_eq!(
            runtime
                .lock()
                .expect("runtime")
                .status()
                .summary
                .remote_pending,
            9
        );
    }
}
