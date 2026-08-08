use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const RECENT_CAPTURE_LIMIT: usize = 5;
const RECENT_MENU_PREFIX: &str = "recent-capture:";
const MENU_THUMBNAIL_WIDTH: u32 = 48;
const MENU_THUMBNAIL_HEIGHT: u32 = 32;
pub(crate) const OPEN_LIBRARY_MENU_ID: &str = "open-library";
pub(crate) const LIBRARY_URL: &str = "https://capso-cyan.vercel.app/library";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentCapture {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) captured_at_ms: u64,
    pub(crate) bytes: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct RecentCaptureMenuEntry {
    pub(crate) capture: RecentCapture,
    pub(crate) thumbnail: tauri::image::Image<'static>,
}

fn canonical_capture_id(value: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(value).ok()?;
    let canonical = parsed.to_string();
    (canonical == value).then_some(canonical)
}

fn png_has_signature(path: &Path) -> io::Result<bool> {
    let mut file = File::open(path)?;
    let mut signature = [0_u8; PNG_SIGNATURE.len()];
    let signature_matches = match file.read_exact(&mut signature) {
        Ok(()) => signature == *PNG_SIGNATURE,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(signature_matches)
}

fn decode_png(path: &Path) -> io::Result<image::DynamicImage> {
    if !png_has_signature(path)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "capture does not have a PNG signature",
        ));
    }
    image::open(path).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn menu_thumbnail(path: &Path) -> io::Result<tauri::image::Image<'static>> {
    let resized = decode_png(path)?
        .resize(
            MENU_THUMBNAIL_WIDTH,
            MENU_THUMBNAIL_HEIGHT,
            image::imageops::FilterType::Triangle,
        )
        .to_rgba8();
    let width = resized.width();
    let height = resized.height();
    let x_offset = (MENU_THUMBNAIL_WIDTH - width) / 2;
    let y_offset = (MENU_THUMBNAIL_HEIGHT - height) / 2;
    let mut rgba = vec![0_u8; (MENU_THUMBNAIL_WIDTH * MENU_THUMBNAIL_HEIGHT * 4) as usize];
    let source = resized.as_raw();
    for row in 0..height {
        let source_start = (row * width * 4) as usize;
        let source_end = source_start + (width * 4) as usize;
        let target_start = (((row + y_offset) * MENU_THUMBNAIL_WIDTH + x_offset) * 4) as usize;
        let target_end = target_start + (width * 4) as usize;
        rgba[target_start..target_end].copy_from_slice(&source[source_start..source_end]);
    }
    Ok(tauri::image::Image::new_owned(
        rgba,
        MENU_THUMBNAIL_WIDTH,
        MENU_THUMBNAIL_HEIGHT,
    ))
}

fn capture_metadata_from_path(
    path: &Path,
    expected_id: Option<&str>,
) -> io::Result<Option<RecentCapture>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Ok(None);
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("png") {
        return Ok(None);
    }
    let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
        return Ok(None);
    };
    let Some(id) = canonical_capture_id(stem) else {
        return Ok(None);
    };
    if expected_id.is_some_and(|expected| expected != id) {
        return Ok(None);
    }

    let captured_at_ms = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    Ok(Some(RecentCapture {
        id,
        path: path.to_path_buf(),
        captured_at_ms,
        bytes: metadata.len(),
    }))
}

fn ordered_newest(mut captures: Vec<RecentCapture>) -> Vec<RecentCapture> {
    captures.sort_by(|left, right| {
        right
            .captured_at_ms
            .cmp(&left.captured_at_ms)
            .then_with(|| right.id.cmp(&left.id))
    });
    captures
}

#[cfg(test)]
fn newest_five(captures: Vec<RecentCapture>) -> Vec<RecentCapture> {
    ordered_newest(captures)
        .into_iter()
        .take(RECENT_CAPTURE_LIMIT)
        .collect()
}

#[cfg(test)]
fn scan_recent_captures(directory: &Path) -> io::Result<Vec<RecentCapture>> {
    scan_recent_menu_entries(directory, &HashMap::new())
        .map(|entries| entries.into_iter().map(|entry| entry.capture).collect())
}

pub(crate) fn scan_recent_menu_entries(
    directory: &Path,
    captured_at_by_id: &HashMap<String, u64>,
) -> io::Result<Vec<RecentCaptureMenuEntry>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };

    let captures = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            capture_metadata_from_path(&entry.path(), None)
                .ok()
                .flatten()
        })
        .map(|mut capture| {
            if let Some(captured_at_ms) = captured_at_by_id.get(&capture.id) {
                capture.captured_at_ms = *captured_at_ms;
            }
            capture
        })
        .collect::<Vec<_>>();
    let mut menu_entries = Vec::with_capacity(RECENT_CAPTURE_LIMIT);
    for capture in ordered_newest(captures) {
        let Ok(thumbnail) = menu_thumbnail(&capture.path) else {
            continue;
        };
        menu_entries.push(RecentCaptureMenuEntry { capture, thumbnail });
        if menu_entries.len() == RECENT_CAPTURE_LIMIT {
            break;
        }
    }
    Ok(menu_entries)
}

pub(crate) fn resolve_recent_capture(directory: &Path, id: &str) -> Result<RecentCapture, String> {
    let canonical = canonical_capture_id(id)
        .ok_or_else(|| "That recent capture identifier is invalid.".to_string())?;
    let path = directory.join(format!("{canonical}.png"));
    let capture = capture_metadata_from_path(&path, Some(&canonical))
        .map_err(|error| format!("Could not inspect that recent capture: {error}"))?
        .ok_or_else(|| "That recent capture is missing or no longer a valid PNG.".to_string())?;
    decode_png(&capture.path)
        .map_err(|error| format!("Could not decode that recent capture: {error}"))?;
    Ok(capture)
}

pub(crate) fn recent_menu_id(id: &str) -> String {
    format!("{RECENT_MENU_PREFIX}{id}")
}

pub(crate) fn parse_recent_menu_id(value: &str) -> Option<String> {
    value
        .strip_prefix(RECENT_MENU_PREFIX)
        .and_then(canonical_capture_id)
}

pub(crate) fn capture_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("captures"))
        .map_err(|error| format!("Could not locate Capso's capture history: {error}"))
}

pub(crate) fn recent_menu_entries_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<RecentCaptureMenuEntry>, String> {
    let directory = capture_directory(app)?;
    let captured_at_by_id = crate::queue::capture_timestamps_for_app(app).unwrap_or_default();
    scan_recent_menu_entries(&directory, &captured_at_by_id)
        .map_err(|error| format!("Could not inspect Capso's recent captures: {error}"))
}

pub(crate) fn resolve_recent_capture_for_app<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<RecentCapture, String> {
    resolve_recent_capture(&capture_directory(app)?, id)
}

pub(crate) fn recent_capture_label(capture: &RecentCapture, now: SystemTime) -> String {
    let now_ms = now
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let age_seconds = now_ms.saturating_sub(capture.captured_at_ms) / 1_000;
    let age = match age_seconds {
        0..=59 => "Just now".to_string(),
        60..=3_599 => format!("{} min ago", age_seconds / 60),
        3_600..=86_399 => format!("{} hr ago", age_seconds / 3_600),
        _ => format!("{} days ago", age_seconds / 86_400),
    };
    let size = if capture.bytes < 1_024 {
        format!("{} B", capture.bytes)
    } else if capture.bytes < 1_048_576 {
        format!("{} KB", (capture.bytes + 512) / 1_024)
    } else {
        let tenths = (capture.bytes.saturating_mul(10) + 524_288) / 1_048_576;
        format!("{}.{:01} MB", tenths / 10, tenths % 10)
    };
    format!("{age} · {size}")
}

fn open_library_with<F, E>(opener: F) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), E>,
    E: std::fmt::Display,
{
    opener(LIBRARY_URL).map_err(|error| format!("Could not open Capso's library: {error}"))
}

pub(crate) fn open_library() -> Result<(), String> {
    open_library_with(|url| tauri_plugin_opener::open_url(url, None::<&str>))
}

#[cfg(test)]
mod tests {
    use super::{
        newest_five, open_library_with, parse_recent_menu_id, recent_capture_label, recent_menu_id,
        resolve_recent_capture, scan_recent_captures, scan_recent_menu_entries, RecentCapture,
        LIBRARY_URL, PNG_SIGNATURE,
    };
    use image::{Rgba, RgbaImage};
    use std::{cell::RefCell, collections::HashMap, fs, path::Path, time::SystemTime};

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
        0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64,
        0xf8, 0x0f, 0x00, 0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn write_capture(directory: &Path, id: &str, bytes: &[u8]) {
        fs::write(directory.join(format!("{id}.png")), bytes).expect("write capture fixture");
    }

    fn recent(id: &str, captured_at_ms: u64) -> RecentCapture {
        RecentCapture {
            id: id.into(),
            path: Path::new("/tmp/capso/captures").join(format!("{id}.png")),
            captured_at_ms,
            bytes: PNG.len() as u64,
        }
    }

    #[test]
    fn newest_five_are_deterministic_and_limited() {
        let ids = [
            "018f22c4-cada-7c6b-9d5b-fc35f7f92270",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92271",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92272",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92273",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92274",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92275",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92276",
        ];
        let unordered = vec![
            recent(ids[0], 100),
            recent(ids[3], 400),
            recent(ids[6], 400),
            recent(ids[1], 200),
            recent(ids[5], 600),
            recent(ids[2], 300),
            recent(ids[4], 500),
        ];

        let selected = newest_five(unordered);

        assert_eq!(selected.len(), 5);
        assert_eq!(
            selected
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![ids[5], ids[4], ids[6], ids[3], ids[2]]
        );
    }

    #[test]
    fn scan_accepts_only_direct_canonical_uuid_png_files() {
        let root = tempfile::tempdir().expect("capture directory");
        let valid = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        write_capture(root.path(), valid, PNG);
        write_capture(root.path(), "not-a-uuid", PNG);
        write_capture(
            root.path(),
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227b",
            b"not a PNG",
        );
        write_capture(
            root.path(),
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227e",
            PNG_SIGNATURE,
        );
        write_capture(
            root.path(),
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227f",
            &PNG[..24],
        );
        fs::write(
            root.path().join("018f22c4-cada-7c6b-9d5b-fc35f7f9227c.jpg"),
            PNG,
        )
        .expect("write wrong extension");
        let nested = root.path().join("nested");
        fs::create_dir(&nested).expect("create nested directory");
        write_capture(&nested, "018f22c4-cada-7c6b-9d5b-fc35f7f9227d", PNG);

        let captures = scan_recent_captures(root.path()).expect("scan recent captures");

        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].id, valid);
        assert_eq!(captures[0].path, root.path().join(format!("{valid}.png")));
        assert_eq!(captures[0].bytes, PNG.len() as u64);
        assert!(captures[0].captured_at_ms > 0);
    }

    #[test]
    fn missing_capture_directory_is_an_empty_first_run() {
        let root = tempfile::tempdir().expect("app data directory");
        let missing = root.path().join("captures");

        assert_eq!(
            scan_recent_captures(&missing).expect("first-run scan"),
            vec![]
        );
    }

    #[test]
    fn exact_id_resolution_revalidates_the_file_and_rejects_path_input() {
        let root = tempfile::tempdir().expect("capture directory");
        let id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        write_capture(root.path(), id, PNG);

        let resolved = resolve_recent_capture(root.path(), id).expect("resolve capture");
        assert_eq!(resolved.id, id);
        assert!(resolve_recent_capture(root.path(), "../outside").is_err());
        assert!(resolve_recent_capture(root.path(), &id.to_uppercase()).is_err());

        fs::write(root.path().join(format!("{id}.png")), b"corrupted").expect("corrupt fixture");
        assert!(resolve_recent_capture(root.path(), id).is_err());

        fs::write(root.path().join(format!("{id}.png")), PNG_SIGNATURE)
            .expect("write signature-only fixture");
        assert!(resolve_recent_capture(root.path(), id).is_err());
    }

    #[test]
    fn recent_menu_ids_round_trip_only_canonical_uuids() {
        let id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        let menu_id = recent_menu_id(id);

        assert_eq!(menu_id, format!("recent-capture:{id}"));
        assert_eq!(parse_recent_menu_id(&menu_id), Some(id.to_string()));
        assert_eq!(parse_recent_menu_id("recent-capture:../outside"), None);
        assert_eq!(
            parse_recent_menu_id("capture:018f22c4-cada-7c6b-9d5b-fc35f7f9227a"),
            None
        );
    }

    #[test]
    fn recent_capture_serialization_exposes_stable_restore_metadata() {
        let item = recent(
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            SystemTime::UNIX_EPOCH
                .elapsed()
                .expect("time after epoch")
                .as_millis() as u64,
        );

        let value = serde_json::to_value(item).expect("serialize recent capture");
        assert_eq!(value["id"], "018f22c4-cada-7c6b-9d5b-fc35f7f9227a");
        assert!(value["path"].as_str().is_some());
        assert!(value["capturedAtMs"].as_u64().is_some());
        assert_eq!(value["bytes"], PNG.len() as u64);
    }

    #[test]
    fn menu_label_uses_local_relative_age_without_a_clock_dependency() {
        let item = RecentCapture {
            bytes: 1_572_864,
            ..recent("018f22c4-cada-7c6b-9d5b-fc35f7f9227a", 1_000_000)
        };
        let now = SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_120_000);

        assert_eq!(recent_capture_label(&item, now), "2 min ago · 1.5 MB");
    }

    #[test]
    fn queue_timestamps_keep_recent_order_stable_after_pixels_change() {
        let root = tempfile::tempdir().expect("capture directory");
        let older = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        let newer = "018f22c4-cada-7c6b-9d5b-fc35f7f9227b";
        write_capture(root.path(), newer, PNG);
        write_capture(root.path(), older, PNG);
        let stable_times = HashMap::from([(older.to_string(), 1_000), (newer.to_string(), 2_000)]);

        let entries = scan_recent_menu_entries(root.path(), &stable_times)
            .expect("scan queue-backed menu entries");

        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.capture.id.as_str(), entry.capture.captured_at_ms))
                .collect::<Vec<_>>(),
            vec![(newer, 2_000), (older, 1_000)]
        );
    }

    #[test]
    fn menu_thumbnail_is_bounded_and_letterboxed_without_cropping() {
        let root = tempfile::tempdir().expect("capture directory");
        let id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        let source = RgbaImage::from_pixel(80, 40, Rgba([210, 30, 40, 255]));
        source
            .save(root.path().join(format!("{id}.png")))
            .expect("write landscape PNG");

        let entries = scan_recent_menu_entries(root.path(), &HashMap::new())
            .expect("scan visual menu entries");
        let thumbnail = &entries[0].thumbnail;

        assert_eq!((thumbnail.width(), thumbnail.height()), (48, 32));
        let top_left = &thumbnail.rgba()[..4];
        let image_pixel = &thumbnail.rgba()[4 * 48 * 4..4 * 48 * 4 + 4];
        assert_eq!(top_left, &[0, 0, 0, 0]);
        assert_eq!(image_pixel, &[210, 30, 40, 255]);
    }

    #[test]
    fn library_opens_only_the_fixed_production_route_and_maps_failures() {
        let opened = RefCell::new(Vec::new());
        open_library_with(|url| {
            opened.borrow_mut().push(url.to_string());
            Ok::<(), &'static str>(())
        })
        .expect("open library route");
        assert_eq!(opened.into_inner(), vec![LIBRARY_URL]);

        let failure = open_library_with(|_| Err::<(), _>("browser unavailable"))
            .expect_err("surface opener failure");
        assert!(failure.contains("browser unavailable"));
    }
}
