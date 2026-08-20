use image::{GenericImage, GenericImageView, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Cursor, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

use crate::queue::QueueSource;

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const RECENT_CAPTURE_LIMIT: usize = 8;
const HISTORY_CAPTURE_LIMIT: usize = 500;
const RECENT_MENU_PREFIX: &str = "recent-capture:";
const MENU_THUMBNAIL_WIDTH: u32 = 48;
const MENU_THUMBNAIL_HEIGHT: u32 = 32;
const MIN_COMBINE_IMAGES: usize = 2;
const MAX_COMBINE_IMAGES: usize = 8;
const MAX_COMBINED_EDGE: u32 = 32_768;
const MAX_COMBINED_PIXELS: u64 = 100_000_000;
const MAX_COMBINED_PNG_BYTES: usize = 512 * 1024 * 1024;
const HISTORY_REMOVAL_SUFFIX: &str = ".removed";
const MAX_HISTORY_REMOVAL_BATCH: usize = 10_000;
pub(crate) const COMBINE_GAP: u32 = 16;
pub(crate) const OPEN_LIBRARY_MENU_ID: &str = "open-library";
pub(crate) const OPEN_HISTORY_MENU_ID: &str = "open-history";
pub(crate) const LIBRARY_URL: &str = "https://capso-cyan.vercel.app/library";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CombineLayout {
    Horizontal,
    Vertical,
    Grid,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FrameAlignment {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FrameAspect {
    Auto,
    Square,
    Portrait,
    Story,
    Landscape,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrameStyle {
    pub(crate) padding: u16,
    pub(crate) background: crate::capture_hud::WindowBackground,
    pub(crate) custom_background: crate::capture_hud::WindowHexColor,
    pub(crate) alignment: FrameAlignment,
    pub(crate) aspect: FrameAspect,
    pub(crate) auto_balance: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CombinedCapture {
    pub(crate) path: PathBuf,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentCapture {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) captured_at_ms: u64,
    pub(crate) bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<QueueSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) annotation_revision: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct RecentCaptureMenuEntry {
    pub(crate) capture: RecentCapture,
    pub(crate) thumbnail: tauri::image::Image<'static>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistorySnapshot {
    pub(crate) captures: Vec<RecentCapture>,
    pub(crate) total: usize,
    pub(crate) removed: usize,
    pub(crate) truncated: bool,
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
        source: None,
        project_id: None,
        annotation_revision: None,
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
fn newest_recent(captures: Vec<RecentCapture>) -> Vec<RecentCapture> {
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

#[cfg(test)]
pub(crate) fn scan_recent_menu_entries(
    directory: &Path,
    captured_at_by_id: &HashMap<String, u64>,
) -> io::Result<Vec<RecentCaptureMenuEntry>> {
    scan_recent_menu_entries_excluding(directory, captured_at_by_id, &HashSet::new())
}

pub(crate) fn scan_recent_menu_entries_excluding(
    directory: &Path,
    captured_at_by_id: &HashMap<String, u64>,
    excluded_ids: &HashSet<String>,
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
        .filter(|capture| !excluded_ids.contains(&capture.id))
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

#[cfg(test)]
pub(crate) fn scan_history(
    directory: &Path,
    captured_at_by_id: &HashMap<String, u64>,
) -> io::Result<HistorySnapshot> {
    scan_history_excluding(directory, captured_at_by_id, &HashSet::new())
}

pub(crate) fn scan_history_excluding(
    directory: &Path,
    captured_at_by_id: &HashMap<String, u64>,
    excluded_ids: &HashSet<String>,
) -> io::Result<HistorySnapshot> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(HistorySnapshot {
                captures: Vec::new(),
                total: 0,
                removed: 0,
                truncated: false,
            })
        }
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
    let removed = captures
        .iter()
        .filter(|capture| excluded_ids.contains(&capture.id))
        .count();
    let visible = captures
        .into_iter()
        .filter(|capture| !excluded_ids.contains(&capture.id))
        .collect::<Vec<_>>();
    let total = visible.len();
    let captures = ordered_newest(visible)
        .into_iter()
        .take(HISTORY_CAPTURE_LIMIT)
        .collect();
    Ok(HistorySnapshot {
        captures,
        total,
        removed,
        truncated: total > HISTORY_CAPTURE_LIMIT,
    })
}

fn removal_marker_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    let canonical = canonical_capture_id(id)
        .ok_or_else(|| "That History capture identifier is invalid.".to_string())?;
    Ok(directory.join(format!("{canonical}{HISTORY_REMOVAL_SUFFIX}")))
}

fn validate_removal_directory(directory: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|error| format!("Could not inspect Capso's History removal index: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("Capso's History removal index is not a direct directory.".into());
    }
    Ok(())
}

fn ensure_removal_directory(directory: &Path) -> Result<(), String> {
    match fs::create_dir(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Could not create Capso's History removal index: {error}"
            ))
        }
    }
    validate_removal_directory(directory)
}

fn valid_removal_marker(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file() && metadata.len() == 0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Could not inspect a Capso History removal marker: {error}"
        )),
    }
}

pub(crate) fn removed_capture_ids(directory: &Path) -> Result<HashSet<String>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => {
            validate_removal_directory(directory)?;
            entries
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => {
            return Err(format!(
                "Could not read Capso's History removal index: {error}"
            ))
        }
    };
    let mut removed = HashSet::new();
    for entry in entries.flatten() {
        let Some(filename) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(id) = filename
            .strip_suffix(HISTORY_REMOVAL_SUFFIX)
            .and_then(canonical_capture_id)
        else {
            continue;
        };
        if valid_removal_marker(&entry.path())? {
            removed.insert(id);
        }
    }
    Ok(removed)
}

fn validated_removal_batch(ids: &[String]) -> Result<Vec<String>, String> {
    if ids.len() > MAX_HISTORY_REMOVAL_BATCH {
        return Err(format!(
            "Choose no more than {MAX_HISTORY_REMOVAL_BATCH} captures at once."
        ));
    }
    let mut unique = HashSet::with_capacity(ids.len());
    let mut canonical = Vec::with_capacity(ids.len());
    for id in ids {
        let id = canonical_capture_id(id)
            .ok_or_else(|| "That History capture identifier is invalid.".to_string())?;
        if !unique.insert(id.clone()) {
            return Err("A History removal batch contains a duplicate capture.".into());
        }
        canonical.push(id);
    }
    Ok(canonical)
}

pub(crate) fn remove_captures_from_history(
    captures_directory: &Path,
    removals_directory: &Path,
    ids: &[String],
) -> Result<Vec<String>, String> {
    let ids = validated_removal_batch(ids)?;
    for id in &ids {
        let path = captures_directory.join(format!("{id}.png"));
        capture_metadata_from_path(&path, Some(id))
            .map_err(|error| format!("Could not inspect that History capture: {error}"))?
            .ok_or_else(|| {
                "That History capture is missing or no longer a direct PNG.".to_string()
            })?;
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    ensure_removal_directory(removals_directory)?;
    let mut created = Vec::new();
    let result = (|| {
        for id in &ids {
            let marker = removal_marker_path(removals_directory, id)?;
            if valid_removal_marker(&marker)? {
                continue;
            }
            if fs::symlink_metadata(&marker).is_ok() {
                return Err("A History removal marker is not a direct empty file.".into());
            }
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
                .map_err(|error| format!("Could not reserve a History removal marker: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Could not sync a History removal marker: {error}"))?;
            created.push((id.clone(), marker));
        }
        File::open(removals_directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync Capso's History removal index: {error}"))
    })();
    if let Err(error) = result {
        for (_, marker) in &created {
            let _ = fs::remove_file(marker);
        }
        return Err(error);
    }
    Ok(created.into_iter().map(|(id, _)| id).collect())
}

pub(crate) fn restore_captures_to_history(
    removals_directory: &Path,
    ids: &[String],
) -> Result<(), String> {
    let ids = validated_removal_batch(ids)?;
    if ids.is_empty() || !removals_directory.exists() {
        return Ok(());
    }
    validate_removal_directory(removals_directory)?;
    let mut markers = Vec::new();
    for id in ids {
        let marker = removal_marker_path(removals_directory, &id)?;
        match fs::symlink_metadata(&marker) {
            Ok(metadata) if metadata.file_type().is_file() && metadata.len() == 0 => {
                markers.push(marker)
            }
            Ok(_) => return Err("A History removal marker is not a direct empty file.".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not inspect a Capso History removal marker: {error}"
                ))
            }
        }
    }
    let mut restored = Vec::new();
    for marker in markers {
        if let Err(error) = fs::remove_file(&marker) {
            for removed in restored {
                let _ = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(removed);
            }
            return Err(format!("Could not restore a capture to History: {error}"));
        }
        restored.push(marker);
    }
    File::open(removals_directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync Capso's History removal index: {error}"))
}

pub(crate) fn clear_capture_history(
    captures_directory: &Path,
    removals_directory: &Path,
) -> Result<Vec<String>, String> {
    let already_removed = removed_capture_ids(removals_directory)?;
    let entries = match fs::read_dir(captures_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not inspect Capso's capture history before clearing it: {error}"
            ))
        }
    };
    let mut visible = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            capture_metadata_from_path(&entry.path(), None)
                .ok()
                .flatten()
        })
        .filter(|capture| !already_removed.contains(&capture.id))
        .map(|capture| capture.id)
        .collect::<Vec<_>>();
    visible.sort();
    remove_captures_from_history(captures_directory, removals_directory, &visible)
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

fn checked_axis(total: u32, addition: u32) -> Result<u32, String> {
    total
        .checked_add(addition)
        .filter(|value| *value <= MAX_COMBINED_EDGE)
        .ok_or_else(|| "The combined image would exceed Capso's safe edge limit.".into())
}

fn combined_dimensions(
    dimensions: &[(u32, u32)],
    layout: CombineLayout,
) -> Result<(u32, u32, u32), String> {
    let count = u32::try_from(dimensions.len())
        .map_err(|_| "The combined image has too many inputs.".to_string())?;
    let gap_total = COMBINE_GAP
        .checked_mul(count.saturating_sub(1))
        .ok_or_else(|| "The combined image spacing is outside Capso's safe bounds.".to_string())?;
    let max_width = dimensions
        .iter()
        .map(|(width, _)| *width)
        .max()
        .unwrap_or(0);
    let max_height = dimensions
        .iter()
        .map(|(_, height)| *height)
        .max()
        .unwrap_or(0);
    let source_pixels = dimensions.iter().try_fold(0_u64, |sum, (width, height)| {
        sum.checked_add(u64::from(*width).saturating_mul(u64::from(*height)))
            .ok_or_else(|| {
                "The combined source pixels are outside Capso's safe bounds.".to_string()
            })
    })?;
    if source_pixels > MAX_COMBINED_PIXELS {
        return Err("The combined sources exceed Capso's safe pixel limit.".into());
    }
    let (width, height, columns) = match layout {
        CombineLayout::Horizontal => {
            let source_width = dimensions.iter().try_fold(0_u32, |sum, (width, _)| {
                sum.checked_add(*width).ok_or_else(|| {
                    "The combined image width is outside Capso's safe bounds.".to_string()
                })
            })?;
            (checked_axis(source_width, gap_total)?, max_height, count)
        }
        CombineLayout::Vertical => {
            let source_height = dimensions.iter().try_fold(0_u32, |sum, (_, height)| {
                sum.checked_add(*height).ok_or_else(|| {
                    "The combined image height is outside Capso's safe bounds.".to_string()
                })
            })?;
            (max_width, checked_axis(source_height, gap_total)?, 1)
        }
        CombineLayout::Grid => {
            let columns = match dimensions.len() {
                2..=4 => 2_u32,
                _ => 3_u32,
            };
            let rows = count.div_ceil(columns);
            let source_width = max_width.checked_mul(columns).ok_or_else(|| {
                "The combined grid width is outside Capso's safe bounds.".to_string()
            })?;
            let source_height = max_height.checked_mul(rows).ok_or_else(|| {
                "The combined grid height is outside Capso's safe bounds.".to_string()
            })?;
            let width = checked_axis(
                source_width,
                COMBINE_GAP.saturating_mul(columns.saturating_sub(1)),
            )?;
            let height = checked_axis(
                source_height,
                COMBINE_GAP.saturating_mul(rows.saturating_sub(1)),
            )?;
            (width, height, columns)
        }
    };
    if width == 0
        || height == 0
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_COMBINED_PIXELS
    {
        return Err("The combined image would exceed Capso's safe pixel limit.".into());
    }
    Ok((width, height, columns))
}

fn combine_position(
    dimensions: &[(u32, u32)],
    layout: CombineLayout,
    index: usize,
    columns: u32,
) -> (u32, u32) {
    let (image_width, image_height) = dimensions[index];
    let max_width = dimensions
        .iter()
        .map(|(width, _)| *width)
        .max()
        .unwrap_or(0);
    let max_height = dimensions
        .iter()
        .map(|(_, height)| *height)
        .max()
        .unwrap_or(0);
    match layout {
        CombineLayout::Horizontal => {
            let x = dimensions[..index]
                .iter()
                .map(|(width, _)| *width + COMBINE_GAP)
                .sum();
            (x, (max_height - image_height) / 2)
        }
        CombineLayout::Vertical => {
            let y = dimensions[..index]
                .iter()
                .map(|(_, height)| *height + COMBINE_GAP)
                .sum();
            ((max_width - image_width) / 2, y)
        }
        CombineLayout::Grid => {
            let index = index as u32;
            let column = index % columns;
            let row = index / columns;
            (
                column * (max_width + COMBINE_GAP) + (max_width - image_width) / 2,
                row * (max_height + COMBINE_GAP) + (max_height - image_height) / 2,
            )
        }
    }
}

fn bounded_combined_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let dimensions = image::image_dimensions(path)
        .map_err(|error| format!("Could not inspect a combined capture: {error}"))?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || dimensions.0 > MAX_COMBINED_EDGE
        || dimensions.1 > MAX_COMBINED_EDGE
        || u64::from(dimensions.0).saturating_mul(u64::from(dimensions.1)) > MAX_COMBINED_PIXELS
    {
        return Err("A combined capture exceeds Capso's safe image limits.".into());
    }
    Ok(dimensions)
}

fn decode_combined_png(
    path: &Path,
    expected_dimensions: (u32, u32),
) -> Result<image::RgbaImage, String> {
    let file =
        File::open(path).map_err(|error| format!("Could not open a combined capture: {error}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_COMBINED_EDGE);
    limits.max_image_height = Some(MAX_COMBINED_EDGE);
    limits.max_alloc = Some(MAX_COMBINED_PIXELS.saturating_mul(4) + 64 * 1024 * 1024);
    let mut reader = ImageReader::with_format(BufReader::new(file), image::ImageFormat::Png);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("Could not decode a combined capture: {error}"))?;
    if image.dimensions() != expected_dimensions {
        return Err("A combined capture changed after its dimensions were checked.".into());
    }
    Ok(image.to_rgba8())
}

fn write_combined_png(directory: &Path, output: &Path, png: &[u8]) -> Result<(), String> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|error| format!("Could not inspect Capso's capture history: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("Capso's capture history is not a direct directory.".into());
    }
    if fs::symlink_metadata(output).is_ok() {
        return Err("The combined capture identifier is already in use.".into());
    }
    let temporary = directory.join(format!(".capso-combine-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not reserve the combined capture: {error}"))?;
        file.write_all(png)
            .map_err(|error| format!("Could not write the combined capture: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync the combined capture: {error}"))?;
        fs::rename(&temporary, output)
            .map_err(|error| format!("Could not commit the combined capture: {error}"))?;
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync Capso's capture history: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn combine_captures(
    directory: &Path,
    ids: &[String],
    layout: CombineLayout,
    output_id: &str,
) -> Result<CombinedCapture, String> {
    if !(MIN_COMBINE_IMAGES..=MAX_COMBINE_IMAGES).contains(&ids.len()) {
        return Err("Choose between two and eight captures to combine.".into());
    }
    let output_id = canonical_capture_id(output_id)
        .ok_or_else(|| "The combined capture identifier is invalid.".to_string())?;
    let mut unique = HashSet::with_capacity(ids.len());
    let mut captures = Vec::with_capacity(ids.len());
    let mut dimensions = Vec::with_capacity(ids.len());
    for id in ids {
        if !unique.insert(id.as_str()) || id == &output_id {
            return Err("Every combined capture must be a distinct local image.".into());
        }
        let capture = resolve_recent_capture(directory, id)?;
        dimensions.push(bounded_combined_dimensions(&capture.path)?);
        captures.push(capture);
    }
    let (width, height, columns) = combined_dimensions(&dimensions, layout)?;
    let mut canvas = image::RgbaImage::new(width, height);
    for (index, capture) in captures.iter().enumerate() {
        let image = decode_combined_png(&capture.path, dimensions[index])?;
        let (x, y) = combine_position(&dimensions, layout, index, columns);
        canvas
            .copy_from(&image, x, y)
            .map_err(|error| format!("Could not place a combined capture: {error}"))?;
    }
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| format!("Could not encode the combined capture: {error}"))?;
    if png.is_empty() || png.len() > MAX_COMBINED_PNG_BYTES {
        return Err("The combined PNG is outside Capso's safe file limit.".into());
    }
    let path = directory.join(format!("{output_id}.png"));
    write_combined_png(directory, &path, &png)?;
    Ok(CombinedCapture {
        path,
        width,
        height,
        bytes: png.len() as u64,
    })
}

fn frame_background(style: FrameStyle) -> Result<image::Rgba<u8>, String> {
    use crate::capture_hud::WindowBackground;

    match style.background {
        WindowBackground::Transparent => {
            Err("Social framing requires a visible background.".into())
        }
        WindowBackground::Canvas => Ok(image::Rgba([244, 240, 235, 255])),
        WindowBackground::Ink => Ok(image::Rgba([31, 31, 30, 255])),
        WindowBackground::Blue => Ok(image::Rgba([74, 111, 165, 255])),
        WindowBackground::Custom => Ok(style.custom_background.rgba()),
    }
}

fn frame_aspect_ratio(aspect: FrameAspect) -> Option<(u32, u32)> {
    match aspect {
        FrameAspect::Auto => None,
        FrameAspect::Square => Some((1, 1)),
        FrameAspect::Portrait => Some((4, 5)),
        FrameAspect::Story => Some((9, 16)),
        FrameAspect::Landscape => Some((16, 9)),
    }
}

fn frame_axis_bias(alignment: FrameAlignment) -> (u32, u32) {
    match alignment {
        FrameAlignment::TopLeft => (0, 0),
        FrameAlignment::Top => (1, 0),
        FrameAlignment::TopRight => (2, 0),
        FrameAlignment::Left => (0, 1),
        FrameAlignment::Center => (1, 1),
        FrameAlignment::Right => (2, 1),
        FrameAlignment::BottomLeft => (0, 2),
        FrameAlignment::Bottom => (1, 2),
        FrameAlignment::BottomRight => (2, 2),
    }
}

fn frame_geometry(source: (u32, u32), style: FrameStyle) -> Result<(u32, u32, u32, u32), String> {
    if ![24_u16, 48, 96, 144].contains(&style.padding) {
        return Err("Social frame padding must use a supported preset.".into());
    }
    let padding = u32::from(style.padding);
    let doubled_padding = padding
        .checked_mul(2)
        .ok_or_else(|| "Social frame padding is outside Capso's safe bounds.".to_string())?;
    let base_width = source
        .0
        .checked_add(doubled_padding)
        .ok_or_else(|| "The social frame width is outside Capso's safe bounds.".to_string())?;
    let base_height = source
        .1
        .checked_add(doubled_padding)
        .ok_or_else(|| "The social frame height is outside Capso's safe bounds.".to_string())?;
    let (width, height) =
        if let Some((ratio_width, ratio_height)) = frame_aspect_ratio(style.aspect) {
            let units = base_width
                .div_ceil(ratio_width)
                .max(base_height.div_ceil(ratio_height));
            (
                units.checked_mul(ratio_width),
                units.checked_mul(ratio_height),
            )
        } else {
            (Some(base_width), Some(base_height))
        };
    let width = width
        .ok_or_else(|| "The social frame width is outside Capso's safe bounds.".to_string())?;
    let height = height
        .ok_or_else(|| "The social frame height is outside Capso's safe bounds.".to_string())?;
    if width > MAX_COMBINED_EDGE
        || height > MAX_COMBINED_EDGE
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_COMBINED_PIXELS
    {
        return Err("The social frame exceeds Capso's safe image limits.".into());
    }
    let extra_x = width - source.0 - doubled_padding;
    let extra_y = height - source.1 - doubled_padding;
    let (bias_x, bias_y) = if style.auto_balance {
        (1, 1)
    } else {
        frame_axis_bias(style.alignment)
    };
    Ok((
        width,
        height,
        padding + extra_x.saturating_mul(bias_x) / 2,
        padding + extra_y.saturating_mul(bias_y) / 2,
    ))
}

fn blend_opaque_background(
    background: image::Rgba<u8>,
    source: image::Rgba<u8>,
) -> image::Rgba<u8> {
    let alpha = u32::from(source.0[3]);
    let inverse = 255 - alpha;
    let mut output = [0_u8; 4];
    for channel in 0..3 {
        output[channel] = ((u32::from(source.0[channel]) * alpha
            + u32::from(background.0[channel]) * inverse
            + 127)
            / 255) as u8;
    }
    output[3] = 255;
    image::Rgba(output)
}

pub(crate) fn frame_capture(
    directory: &Path,
    source_id: &str,
    style: FrameStyle,
    output_id: &str,
) -> Result<CombinedCapture, String> {
    let output_id = canonical_capture_id(output_id)
        .ok_or_else(|| "The social frame identifier is invalid.".to_string())?;
    if source_id == output_id {
        return Err("The social frame must create a distinct capture.".into());
    }
    let background = frame_background(style)?;
    let source_capture = resolve_recent_capture(directory, source_id)?;
    let source_dimensions = bounded_combined_dimensions(&source_capture.path)?;
    let (width, height, x, y) = frame_geometry(source_dimensions, style)?;
    let source = decode_combined_png(&source_capture.path, source_dimensions)?;
    let mut canvas = image::RgbaImage::from_pixel(width, height, background);
    for (source_x, source_y, source_pixel) in source.enumerate_pixels() {
        let destination = canvas.get_pixel_mut(x + source_x, y + source_y);
        *destination = blend_opaque_background(background, *source_pixel);
    }
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| format!("Could not encode the social frame: {error}"))?;
    if png.is_empty() || png.len() > MAX_COMBINED_PNG_BYTES {
        return Err("The social frame PNG is outside Capso's safe file limit.".into());
    }
    let path = directory.join(format!("{output_id}.png"));
    write_combined_png(directory, &path, &png)?;
    Ok(CombinedCapture {
        path,
        width,
        height,
        bytes: png.len() as u64,
    })
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

fn removal_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("history-removals"))
        .map_err(|error| format!("Could not locate Capso's History removal index: {error}"))
}

pub(crate) fn recent_menu_entries_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<RecentCaptureMenuEntry>, String> {
    let directory = capture_directory(app)?;
    let removed = removed_capture_ids(&removal_directory(app)?)?;
    let captured_at_by_id = crate::queue::capture_timestamps_for_app(app).unwrap_or_default();
    scan_recent_menu_entries_excluding(&directory, &captured_at_by_id, &removed)
        .map_err(|error| format!("Could not inspect Capso's recent captures: {error}"))
}

pub(crate) fn history_for_app<R: Runtime>(app: &AppHandle<R>) -> Result<HistorySnapshot, String> {
    let directory = capture_directory(app)?;
    let removed = removed_capture_ids(&removal_directory(app)?)?;
    let captured_at_by_id = crate::queue::capture_timestamps_for_app(app).unwrap_or_default();
    let mut snapshot = scan_history_excluding(&directory, &captured_at_by_id, &removed)
        .map_err(|error| format!("Could not inspect Capso's capture history: {error}"))?;
    let sources = crate::queue::capture_sources_for_app(app).unwrap_or_default();
    let projects = crate::queue::capture_projects_for_app(app).unwrap_or_default();
    for capture in &mut snapshot.captures {
        apply_history_queue_metadata(capture, &sources, &projects);
    }
    if let Ok(projects_directory) = crate::annotation_project::project_directory(app) {
        for capture in &mut snapshot.captures {
            capture.annotation_revision =
                crate::annotation_project::inspect_revision(&projects_directory, &capture.id);
        }
    }
    Ok(snapshot)
}

fn apply_history_queue_metadata(
    capture: &mut RecentCapture,
    sources: &HashMap<String, QueueSource>,
    projects: &HashMap<String, String>,
) {
    capture.source = sources.get(&capture.id).copied();
    capture.project_id = projects.get(&capture.id).cloned();
}

pub(crate) fn remove_from_history_for_app<R: Runtime>(
    app: &AppHandle<R>,
    ids: &[String],
) -> Result<Vec<String>, String> {
    remove_captures_from_history(&capture_directory(app)?, &removal_directory(app)?, ids)
}

pub(crate) fn clear_history_for_app<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    clear_capture_history(&capture_directory(app)?, &removal_directory(app)?)
}

pub(crate) fn restore_to_history_for_app<R: Runtime>(
    app: &AppHandle<R>,
    ids: &[String],
) -> Result<(), String> {
    restore_captures_to_history(&removal_directory(app)?, ids)
}

pub(crate) fn show_history_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("history")
        .ok_or_else(|| "Capso's history window is unavailable.".to_string())?;
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| format!("Could not open Capso's capture history: {error}"))
}

pub(crate) fn resolve_recent_capture_for_app<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<RecentCapture, String> {
    let mut capture = resolve_recent_capture(&capture_directory(app)?, id)?;
    if let Ok(timestamps) = crate::queue::capture_timestamps_for_app(app) {
        if let Some(captured_at_ms) = timestamps.get(&capture.id) {
            capture.captured_at_ms = *captured_at_ms;
        }
    }
    Ok(capture)
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
        apply_history_queue_metadata, clear_capture_history, combine_captures, combined_dimensions,
        frame_capture, newest_recent, open_library_with, parse_recent_menu_id,
        recent_capture_label, recent_menu_id, remove_captures_from_history, removed_capture_ids,
        resolve_recent_capture, restore_captures_to_history, scan_history, scan_history_excluding,
        scan_recent_captures, scan_recent_menu_entries, scan_recent_menu_entries_excluding,
        CombineLayout, FrameAlignment, FrameAspect, FrameStyle, RecentCapture, COMBINE_GAP,
        HISTORY_CAPTURE_LIMIT, LIBRARY_URL, MAX_COMBINED_EDGE, PNG_SIGNATURE,
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

    fn write_rgba_capture(directory: &Path, id: &str, image: &RgbaImage) -> Vec<u8> {
        let path = directory.join(format!("{id}.png"));
        image.save(&path).expect("write RGBA capture fixture");
        fs::read(path).expect("read RGBA fixture bytes")
    }

    fn recent(id: &str, captured_at_ms: u64) -> RecentCapture {
        RecentCapture {
            id: id.into(),
            path: Path::new("/tmp/capso/captures").join(format!("{id}.png")),
            captured_at_ms,
            bytes: PNG.len() as u64,
            source: None,
            project_id: None,
            annotation_revision: None,
        }
    }

    #[test]
    fn newest_eight_are_deterministic_and_limited() {
        let ids = [
            "018f22c4-cada-7c6b-9d5b-fc35f7f92270",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92271",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92272",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92273",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92274",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92275",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92276",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92277",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92278",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
        ];
        let unordered = vec![
            recent(ids[0], 100),
            recent(ids[3], 400),
            recent(ids[6], 400),
            recent(ids[1], 200),
            recent(ids[5], 600),
            recent(ids[2], 300),
            recent(ids[4], 500),
            recent(ids[7], 700),
            recent(ids[8], 800),
            recent(ids[9], 900),
        ];

        let selected = newest_recent(unordered);

        assert_eq!(selected.len(), 8);
        assert_eq!(
            selected
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![ids[9], ids[8], ids[7], ids[5], ids[4], ids[6], ids[3], ids[2]]
        );
    }

    #[test]
    fn full_history_is_newest_first_bounded_and_reports_the_unshown_total() {
        let root = tempfile::tempdir().expect("history root");
        let mut stable_times = HashMap::new();
        for index in 0..HISTORY_CAPTURE_LIMIT + 3 {
            let id = uuid::Uuid::from_u128(index as u128 + 1).to_string();
            fs::write(root.path().join(format!("{id}.png")), PNG).expect("write capture");
            stable_times.insert(id, index as u64 + 1);
        }
        let history = scan_history(root.path(), &stable_times).expect("scan history");
        assert_eq!(history.captures.len(), HISTORY_CAPTURE_LIMIT);
        assert_eq!(history.total, HISTORY_CAPTURE_LIMIT + 3);
        assert!(history.truncated);
        assert!(history
            .captures
            .windows(2)
            .all(|pair| pair[0].captured_at_ms > pair[1].captured_at_ms));
    }

    #[test]
    fn removal_tombstones_hide_history_and_recent_menu_without_touching_pixels() {
        let root = tempfile::tempdir().expect("app data root");
        let captures = root.path().join("captures");
        let removals = root.path().join("history-removals");
        fs::create_dir(&captures).expect("capture directory");
        let first = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        let second = "018f22c4-cada-7c6b-9d5b-fc35f7f9227b";
        write_capture(&captures, first, PNG);
        write_capture(&captures, second, PNG);
        let first_before = fs::read(captures.join(format!("{first}.png"))).expect("source bytes");

        let removed = remove_captures_from_history(&captures, &removals, &[first.to_string()])
            .expect("remove exact capture from History");
        assert_eq!(removed, vec![first]);
        let excluded = removed_capture_ids(&removals).expect("durable removal index");
        let history =
            scan_history_excluding(&captures, &HashMap::new(), &excluded).expect("visible history");
        assert_eq!(
            history
                .captures
                .iter()
                .map(|capture| capture.id.as_str())
                .collect::<Vec<_>>(),
            vec![second]
        );
        assert_eq!(history.total, 1);
        assert_eq!(history.removed, 1);
        let recent = scan_recent_menu_entries_excluding(&captures, &HashMap::new(), &excluded)
            .expect("visible recent menu");
        assert_eq!(
            recent
                .iter()
                .map(|entry| entry.capture.id.as_str())
                .collect::<Vec<_>>(),
            vec![second]
        );
        assert_eq!(
            fs::read(captures.join(format!("{first}.png"))).unwrap(),
            first_before
        );

        restore_captures_to_history(&removals, &removed).expect("undo exact removal");
        let restored = scan_history_excluding(
            &captures,
            &HashMap::new(),
            &removed_capture_ids(&removals).expect("empty removal index"),
        )
        .expect("restored history");
        assert_eq!(restored.total, 2);
        assert_eq!(restored.removed, 0);
        assert!(restored.captures.iter().any(|capture| capture.id == first));
    }

    #[test]
    fn removal_batch_is_validated_before_writes_and_is_idempotent() {
        let root = tempfile::tempdir().expect("app data root");
        let captures = root.path().join("captures");
        let removals = root.path().join("history-removals");
        fs::create_dir(&captures).expect("capture directory");
        let first = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        write_capture(&captures, first, PNG);

        assert!(remove_captures_from_history(
            &captures,
            &removals,
            &[first.to_string(), "../outside".to_string()],
        )
        .is_err());
        assert!(
            !removals.exists(),
            "invalid batches must not create tombstones"
        );
        assert!(remove_captures_from_history(
            &captures,
            &removals,
            &[first.to_string(), first.to_string()],
        )
        .is_err());
        assert!(
            !removals.exists(),
            "duplicate batches must not partially commit"
        );

        assert_eq!(
            remove_captures_from_history(&captures, &removals, &[first.to_string()])
                .expect("first removal"),
            vec![first],
        );
        assert!(
            remove_captures_from_history(&captures, &removals, &[first.to_string()])
                .expect("idempotent removal")
                .is_empty()
        );
        restore_captures_to_history(&removals, &[first.to_string()]).expect("first restore");
        restore_captures_to_history(&removals, &[first.to_string()]).expect("idempotent restore");
    }

    #[test]
    fn a_corrupt_history_entry_can_be_hidden_without_deleting_its_bytes() {
        let root = tempfile::tempdir().expect("app data root");
        let captures = root.path().join("captures");
        let removals = root.path().join("history-removals");
        fs::create_dir(&captures).expect("capture directory");
        let id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        write_capture(&captures, id, PNG_SIGNATURE);

        let visible = scan_history(&captures, &HashMap::new()).expect("signature-backed history");
        assert_eq!(visible.total, 1);
        assert_eq!(
            remove_captures_from_history(&captures, &removals, &[id.to_string()])
                .expect("hide corrupt History entry"),
            vec![id],
        );
        assert_eq!(
            fs::read(captures.join(format!("{id}.png"))).unwrap(),
            PNG_SIGNATURE
        );
    }

    #[test]
    fn clear_history_hides_every_visible_capture_and_undo_restores_only_that_batch() {
        let root = tempfile::tempdir().expect("app data root");
        let captures = root.path().join("captures");
        let removals = root.path().join("history-removals");
        fs::create_dir(&captures).expect("capture directory");
        let ids = [
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227b",
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227c",
        ];
        for id in ids {
            write_capture(&captures, id, PNG);
        }
        remove_captures_from_history(&captures, &removals, &[ids[0].to_string()])
            .expect("existing hidden capture");

        let cleared = clear_capture_history(&captures, &removals).expect("clear visible History");
        assert_eq!(cleared.len(), 2);
        assert!(!cleared.contains(&ids[0].to_string()));
        let hidden = removed_capture_ids(&removals).expect("all removal markers");
        let empty =
            scan_history_excluding(&captures, &HashMap::new(), &hidden).expect("cleared History");
        assert_eq!((empty.total, empty.removed), (0, 3));

        restore_captures_to_history(&removals, &cleared).expect("undo clear batch");
        let still_hidden = removed_capture_ids(&removals).expect("original marker remains");
        let restored = scan_history_excluding(&captures, &HashMap::new(), &still_hidden)
            .expect("partially restored History");
        assert_eq!((restored.total, restored.removed), (2, 1));
        assert!(!restored.captures.iter().any(|capture| capture.id == ids[0]));
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
    fn combine_preserves_inputs_and_places_full_resolution_pixels_in_requested_order() {
        let root = tempfile::tempdir().expect("capture directory");
        let first = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        let second = "018f22c4-cada-7c6b-9d5b-fc35f7f9227b";
        let output = "018f22c4-cada-7c6b-9d5b-fc35f7f9227c";
        let mut first_image = RgbaImage::new(2, 1);
        first_image.put_pixel(0, 0, Rgba([210, 30, 40, 255]));
        first_image.put_pixel(1, 0, Rgba([30, 190, 80, 255]));
        let mut second_image = RgbaImage::new(1, 2);
        second_image.put_pixel(0, 0, Rgba([40, 90, 220, 255]));
        second_image.put_pixel(0, 1, Rgba([240, 190, 30, 255]));
        let first_before = write_rgba_capture(root.path(), first, &first_image);
        let second_before = write_rgba_capture(root.path(), second, &second_image);

        let result = combine_captures(
            root.path(),
            &[first.to_string(), second.to_string()],
            CombineLayout::Horizontal,
            output,
        )
        .expect("combine exact captures");

        assert_eq!((result.width, result.height), (3 + COMBINE_GAP, 2));
        assert_eq!(result.path, root.path().join(format!("{output}.png")));
        let pixels = image::open(&result.path).expect("decode output").to_rgba8();
        assert_eq!(pixels.get_pixel(0, 0), first_image.get_pixel(0, 0));
        assert_eq!(pixels.get_pixel(1, 0), first_image.get_pixel(1, 0));
        assert_eq!(
            pixels.get_pixel(2 + COMBINE_GAP, 0),
            second_image.get_pixel(0, 0)
        );
        assert_eq!(
            pixels.get_pixel(2 + COMBINE_GAP, 1),
            second_image.get_pixel(0, 1)
        );
        assert_eq!(pixels.get_pixel(2, 0), &Rgba([0, 0, 0, 0]));
        assert_eq!(
            fs::read(root.path().join(format!("{first}.png"))).unwrap(),
            first_before
        );
        assert_eq!(
            fs::read(root.path().join(format!("{second}.png"))).unwrap(),
            second_before
        );
    }

    #[test]
    fn combine_grid_is_row_major_and_rejects_untrusted_or_duplicate_inputs() {
        let root = tempfile::tempdir().expect("capture directory");
        let ids = [
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227a",
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227b",
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227c",
        ];
        for (index, id) in ids.iter().enumerate() {
            write_rgba_capture(
                root.path(),
                id,
                &RgbaImage::from_pixel(1, 1, Rgba([20 + index as u8, 0, 0, 255])),
            );
        }
        let output = "018f22c4-cada-7c6b-9d5b-fc35f7f9227d";
        let result = combine_captures(
            root.path(),
            &ids.map(str::to_string),
            CombineLayout::Grid,
            output,
        )
        .expect("combine grid");
        assert_eq!(
            (result.width, result.height),
            (2 + COMBINE_GAP, 2 + COMBINE_GAP)
        );
        let pixels = image::open(result.path).expect("decode grid").to_rgba8();
        assert_eq!(pixels.get_pixel(0, 0), &Rgba([20, 0, 0, 255]));
        assert_eq!(pixels.get_pixel(1 + COMBINE_GAP, 0), &Rgba([21, 0, 0, 255]));
        assert_eq!(pixels.get_pixel(0, 1 + COMBINE_GAP), &Rgba([22, 0, 0, 255]));

        assert!(combine_captures(
            root.path(),
            &[ids[0].into()],
            CombineLayout::Vertical,
            output,
        )
        .is_err());
        assert!(combine_captures(
            root.path(),
            &[ids[0].into(), ids[0].into()],
            CombineLayout::Vertical,
            output,
        )
        .is_err());
        assert!(combine_captures(
            root.path(),
            &[ids[0].into(), "../outside".into()],
            CombineLayout::Vertical,
            output,
        )
        .is_err());
    }

    #[test]
    fn combine_dimensions_are_preflighted_before_any_full_pixel_decode() {
        assert_eq!(
            combined_dimensions(&[(2, 1), (1, 2)], CombineLayout::Horizontal)
                .expect("bounded horizontal layout"),
            (3 + COMBINE_GAP, 2, 2),
        );
        assert!(combined_dimensions(
            &[(MAX_COMBINED_EDGE, 1), (1, MAX_COMBINED_EDGE)],
            CombineLayout::Grid,
        )
        .is_err());
    }

    #[test]
    fn social_frame_exports_exact_padding_background_alignment_and_aspect() {
        use crate::capture_hud::{WindowBackground, WindowHexColor};

        let root = tempfile::tempdir().expect("capture directory");
        let source_id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        let output_id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227b";
        let source = RgbaImage::from_pixel(2, 1, Rgba([210, 30, 40, 255]));
        let source_before = write_rgba_capture(root.path(), source_id, &source);
        let result = frame_capture(
            root.path(),
            source_id,
            FrameStyle {
                padding: 24,
                background: WindowBackground::Custom,
                custom_background: WindowHexColor::from("#A1B2C3"),
                alignment: FrameAlignment::BottomRight,
                aspect: FrameAspect::Square,
                auto_balance: false,
            },
            output_id,
        )
        .expect("frame exact local capture");

        assert_eq!((result.width, result.height), (50, 50));
        let pixels = image::open(result.path).expect("decode frame").to_rgba8();
        assert_eq!(pixels.get_pixel(0, 0), &Rgba([161, 178, 195, 255]));
        assert_eq!(pixels.get_pixel(24, 25), &Rgba([210, 30, 40, 255]));
        assert_eq!(
            fs::read(root.path().join(format!("{source_id}.png"))).unwrap(),
            source_before,
        );
    }

    #[test]
    fn social_frame_auto_balance_centres_extra_aspect_space_and_rejects_unsafe_style() {
        use crate::capture_hud::{WindowBackground, WindowHexColor};

        let root = tempfile::tempdir().expect("capture directory");
        let source_id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        write_rgba_capture(
            root.path(),
            source_id,
            &RgbaImage::from_pixel(2, 1, Rgba([30, 190, 80, 255])),
        );
        let style = FrameStyle {
            padding: 24,
            background: WindowBackground::Canvas,
            custom_background: WindowHexColor::from("#A1B2C3"),
            alignment: FrameAlignment::BottomRight,
            aspect: FrameAspect::Story,
            auto_balance: true,
        };
        let result = frame_capture(
            root.path(),
            source_id,
            style,
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227b",
        )
        .expect("auto-balance story frame");
        assert_eq!((result.width, result.height), (54, 96));
        let pixels = image::open(result.path).expect("decode story").to_rgba8();
        assert_eq!(pixels.get_pixel(26, 47), &Rgba([30, 190, 80, 255]));

        assert!(frame_capture(
            root.path(),
            source_id,
            FrameStyle {
                padding: 25,
                ..style
            },
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227c",
        )
        .is_err());
        assert!(frame_capture(
            root.path(),
            source_id,
            FrameStyle {
                background: WindowBackground::Transparent,
                ..style
            },
            "018f22c4-cada-7c6b-9d5b-fc35f7f9227d",
        )
        .is_err());
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
    fn history_snapshot_receives_durable_project_and_browser_metadata() {
        let capture_id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
        let project_id = "018f22c4-cada-7c6b-9d5b-fc35f7f92276";
        let mut item = recent(capture_id, 1_000);
        let sources = HashMap::from([(capture_id.to_string(), crate::queue::QueueSource::Browser)]);
        let projects = HashMap::from([(capture_id.to_string(), project_id.to_string())]);

        apply_history_queue_metadata(&mut item, &sources, &projects);

        assert_eq!(item.source, Some(crate::queue::QueueSource::Browser));
        assert_eq!(item.project_id.as_deref(), Some(project_id));
        let value = serde_json::to_value(item).expect("serialize organised capture");
        assert_eq!(value["source"], "browser");
        assert_eq!(value["projectId"], project_id);
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
