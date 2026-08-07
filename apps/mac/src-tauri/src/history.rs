use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const RECENT_CAPTURE_LIMIT: usize = 5;
const RECENT_MENU_PREFIX: &str = "recent-capture:";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentCapture {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) captured_at_ms: u64,
    pub(crate) bytes: u64,
}

fn canonical_capture_id(value: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(value).ok()?;
    let canonical = parsed.to_string();
    (canonical == value).then_some(canonical)
}

fn png_is_decodable(path: &Path) -> io::Result<bool> {
    let mut file = File::open(path)?;
    let mut signature = [0_u8; PNG_SIGNATURE.len()];
    let signature_matches = match file.read_exact(&mut signature) {
        Ok(()) => signature == *PNG_SIGNATURE,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(false),
        Err(error) => return Err(error),
    };
    if !signature_matches {
        return Ok(false);
    }
    Ok(tauri::image::Image::from_path(path).is_ok())
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

pub(crate) fn scan_recent_captures(directory: &Path) -> io::Result<Vec<RecentCapture>> {
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
        .collect::<Vec<_>>();
    Ok(ordered_newest(captures)
        .into_iter()
        .filter(|capture| png_is_decodable(&capture.path).unwrap_or(false))
        .take(RECENT_CAPTURE_LIMIT)
        .collect())
}

pub(crate) fn resolve_recent_capture(directory: &Path, id: &str) -> Result<RecentCapture, String> {
    let canonical = canonical_capture_id(id)
        .ok_or_else(|| "That recent capture identifier is invalid.".to_string())?;
    let path = directory.join(format!("{canonical}.png"));
    let capture = capture_metadata_from_path(&path, Some(&canonical))
        .map_err(|error| format!("Could not inspect that recent capture: {error}"))?
        .ok_or_else(|| "That recent capture is missing or no longer a valid PNG.".to_string())?;
    if !png_is_decodable(&capture.path)
        .map_err(|error| format!("Could not decode that recent capture: {error}"))?
    {
        return Err("That recent capture is missing or no longer a valid PNG.".into());
    }
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

pub(crate) fn recent_captures_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<RecentCapture>, String> {
    let directory = capture_directory(app)?;
    scan_recent_captures(&directory)
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

#[cfg(test)]
mod tests {
    use super::{
        newest_five, parse_recent_menu_id, recent_capture_label, recent_menu_id,
        resolve_recent_capture, scan_recent_captures, RecentCapture, PNG_SIGNATURE,
    };
    use std::{fs, path::Path, time::SystemTime};

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
}
