use serde::Serialize;
use std::{
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub(crate) const MAX_OCR_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_OCR_TEXT_BYTES: usize = 100 * 1024;
pub(crate) const MAX_OCR_LINES: usize = 512;
const MAX_OCR_LINKS: usize = 32;
const MAX_OCR_LINK_BYTES: usize = 2_048;
const OCR_SELECTION_DIRECTORY: &str = "ocr-selections";

const OCR_ENGINE: &str = "apple_vision_on_device";

struct EphemeralOcrSelection {
    path: PathBuf,
}

impl EphemeralOcrSelection {
    fn prepare(cache_root: &Path, id: &str) -> Result<Self, String> {
        let canonical = uuid::Uuid::parse_str(id)
            .ok()
            .map(|value| value.to_string())
            .filter(|value| value == id)
            .ok_or_else(|| "The OCR screen-selection identifier is invalid.".to_string())?;
        let directory = cache_root.join(OCR_SELECTION_DIRECTORY);
        fs::create_dir_all(&directory).map_err(|error| {
            format!("Could not create the private OCR selection folder: {error}")
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(
                |error| format!("Could not protect the private OCR selection folder: {error}"),
            )?;
        }
        let path = directory.join(format!("{canonical}.png"));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self { path }),
            Ok(_) => Err("A private OCR selection path already exists.".into()),
            Err(error) => Err(format!(
                "Could not inspect the private OCR selection path: {error}"
            )),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for EphemeralOcrSelection {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.path).is_ok_and(|metadata| metadata.file_type().is_file()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn is_ephemeral_selection_name(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("png")
        && path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| uuid::Uuid::parse_str(value).ok().map(|uuid| (value, uuid)))
            .is_some_and(|(value, uuid)| uuid.to_string() == value)
}

fn cleanup_ephemeral_selection_directory(directory: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not inspect the private OCR selection folder: {error}"
            ))
        }
    };
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Could not inspect a private OCR selection entry: {error}"))?;
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|error| format!("Could not inspect a private OCR selection: {error}"))?
            .is_file()
            && is_ephemeral_selection_name(&path)
        {
            fs::remove_file(&path)
                .map_err(|error| format!("Could not remove a stale OCR selection: {error}"))?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BoundedRecognizedText {
    text: String,
    line_count: usize,
    truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OcrResult {
    pub(crate) capture_id: String,
    pub(crate) session_id: u64,
    pub(crate) text: String,
    pub(crate) line_count: usize,
    pub(crate) truncated: bool,
    pub(crate) engine: &'static str,
    pub(crate) links: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedOcrResult {
    source_name: String,
    source_bytes: u64,
    result: OcrResult,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OcrTicket {
    capture_id: String,
    session_id: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StoredOcrResult {
    capture_id: String,
    session_id: u64,
    text: String,
    links: Vec<String>,
}

#[derive(Default)]
pub(crate) struct OcrRuntime {
    generation: u64,
    active: Option<OcrTicket>,
    latest: Option<StoredOcrResult>,
}

impl OcrRuntime {
    fn begin(&mut self, capture_id: &str) -> Result<OcrTicket, String> {
        if self.active.is_some() {
            return Err("Wait for the current on-device text extraction to finish.".into());
        }
        let canonical = uuid::Uuid::parse_str(capture_id)
            .ok()
            .map(|value| value.to_string())
            .filter(|value| value == capture_id)
            .ok_or_else(|| "That history capture identifier is invalid.".to_string())?;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| "The text extraction session counter is unavailable.".to_string())?;
        let ticket = OcrTicket {
            capture_id: canonical,
            session_id: self.generation,
        };
        self.active = Some(ticket.clone());
        self.latest = None;
        Ok(ticket)
    }

    fn finish(
        &mut self,
        ticket: OcrTicket,
        recognized: BoundedRecognizedText,
    ) -> Result<OcrResult, String> {
        if self.active.as_ref() != Some(&ticket) {
            return Err("That text extraction session is no longer current.".into());
        }
        let links = recognized_links(&recognized.text);
        self.active = None;
        self.latest = Some(StoredOcrResult {
            capture_id: ticket.capture_id.clone(),
            session_id: ticket.session_id,
            text: recognized.text.clone(),
            links: links.clone(),
        });
        Ok(OcrResult {
            capture_id: ticket.capture_id,
            session_id: ticket.session_id,
            text: recognized.text,
            line_count: recognized.line_count,
            truncated: recognized.truncated,
            engine: OCR_ENGINE,
            links,
        })
    }

    fn fail(&mut self, ticket: &OcrTicket) {
        if self.active.as_ref() == Some(ticket) {
            self.active = None;
        }
    }

    fn text_for_copy(&self, capture_id: &str, session_id: u64) -> Result<String, String> {
        let result = self
            .latest
            .as_ref()
            .filter(|result| result.capture_id == capture_id && result.session_id == session_id)
            .ok_or_else(|| "That recognized text is no longer the current result.".to_string())?;
        if result.text.is_empty() {
            return Err("No text was recognized in that capture.".into());
        }
        Ok(result.text.clone())
    }

    fn link_for_copy(
        &self,
        capture_id: &str,
        session_id: u64,
        link_index: usize,
    ) -> Result<String, String> {
        self.latest
            .as_ref()
            .filter(|result| result.capture_id == capture_id && result.session_id == session_id)
            .and_then(|result| result.links.get(link_index))
            .cloned()
            .ok_or_else(|| "That recognized link is no longer in the current OCR session.".into())
    }
}

fn recognized_links(text: &str) -> Vec<String> {
    let mut links = Vec::new();
    for token in text.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        let start = match (lower.find("http://"), lower.find("https://")) {
            (Some(http), Some(https)) => Some(http.min(https)),
            (Some(http), None) => Some(http),
            (None, Some(https)) => Some(https),
            (None, None) => None,
        };
        let Some(start) = start.filter(|start| token.is_char_boundary(*start)) else {
            continue;
        };
        let candidate = token[start..].trim_end_matches(|character: char| {
            matches!(
                character,
                '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '>' | '"' | '\''
            )
        });
        if candidate.is_empty() || candidate.len() > MAX_OCR_LINK_BYTES {
            continue;
        }
        let Ok(parsed) = url::Url::parse(candidate) else {
            continue;
        };
        if !["http", "https"].contains(&parsed.scheme())
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            continue;
        }
        if !links.iter().any(|link| link == candidate) {
            links.push(candidate.to_string());
        }
        if links.len() == MAX_OCR_LINKS {
            break;
        }
    }
    links
}

fn sanitized_line(raw: &str) -> String {
    raw.chars()
        .map(|character| {
            if character == '\0' || character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn push_prefix_at_char_boundary(target: &mut String, source: &str, available: usize) {
    if available == 0 {
        return;
    }
    let mut end = source.len().min(available);
    while end > 0 && !source.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&source[..end]);
}

fn bounded_recognized_text(lines: impl IntoIterator<Item = String>) -> BoundedRecognizedText {
    let mut text = String::new();
    let mut line_count = 0;
    let mut truncated = false;

    for raw in lines {
        let line = sanitized_line(&raw);
        if line.is_empty() {
            continue;
        }
        if line_count == MAX_OCR_LINES {
            truncated = true;
            break;
        }

        let separator_bytes = usize::from(!text.is_empty());
        let required = separator_bytes.saturating_add(line.len());
        let available = MAX_OCR_TEXT_BYTES.saturating_sub(text.len());
        if required <= available {
            if separator_bytes == 1 {
                text.push('\n');
            }
            text.push_str(&line);
            line_count += 1;
            continue;
        }

        truncated = true;
        if available > separator_bytes {
            if separator_bytes == 1 {
                text.push('\n');
            }
            let before = text.len();
            let remaining = MAX_OCR_TEXT_BYTES.saturating_sub(text.len());
            push_prefix_at_char_boundary(&mut text, &line, remaining);
            if text.len() > before {
                line_count += 1;
            }
        }
        break;
    }

    BoundedRecognizedText {
        text,
        line_count,
        truncated,
    }
}

fn validate_source(file_name: &str, bytes: u64) -> Result<(), String> {
    if Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        != Some("png")
    {
        return Err("On-device text extraction only accepts Capso PNG captures.".into());
    }
    if bytes == 0 || bytes > MAX_OCR_SOURCE_BYTES {
        return Err("That capture exceeds the safe on-device text extraction limit.".into());
    }
    Ok(())
}

fn validate_selected_png(path: &Path) -> Result<(String, u64), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the selected image: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("Choose a direct local PNG file for on-device text extraction.".into());
    }
    let source_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && value.len() <= 255)
        .ok_or_else(|| "The selected image has an invalid file name.".to_string())?
        .to_string();
    let is_png = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("png"));
    if !is_png {
        return Err("Choose a PNG image for on-device text extraction.".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_OCR_SOURCE_BYTES {
        return Err("That image exceeds the safe on-device text extraction limit.".into());
    }
    let reader = image::ImageReader::new(BufReader::new(
        File::open(path).map_err(|error| format!("Could not open the selected image: {error}"))?,
    ))
    .with_guessed_format()
    .map_err(|_| "The selected file is not a readable PNG image.".to_string())?;
    if reader.format() != Some(image::ImageFormat::Png) {
        return Err("The selected file is not a real PNG image.".into());
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "The selected file is not a readable PNG image.".to_string())?;
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || u64::from(width).saturating_mul(u64::from(height)) > 100_000_000
    {
        return Err("The selected PNG dimensions exceed Capso's safe OCR limit.".into());
    }
    Ok((source_name, metadata.len()))
}

#[cfg(target_os = "macos")]
fn recognize_png(path: &Path) -> Result<BoundedRecognizedText, String> {
    use objc2::{runtime::AnyObject, AnyThread, ClassType};
    use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
    use objc2_vision::{
        VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    let path = path
        .to_str()
        .ok_or_else(|| "That capture path cannot be read by Apple Vision.".to_string())?;
    let path = NSString::from_str(path);
    let url = NSURL::fileURLWithPath(&path);
    let options = NSDictionary::<VNImageOption, AnyObject>::new();
    // SAFETY: The URL is an immutable file URL for the already-validated local
    // history PNG, and the options dictionary remains alive for initialization.
    let handler = unsafe {
        VNImageRequestHandler::initWithURL_options(VNImageRequestHandler::alloc(), &url, &options)
    };
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setAutomaticallyDetectsLanguage(true);
    // Keep the multilingual path deterministic. Apple documents that language
    // correction is not available for every script, including Chinese.
    request.setUsesLanguageCorrection(false);
    let request_base: &VNRequest = request.as_super().as_super();
    let requests = NSArray::<VNRequest>::from_slice(&[request_base]);
    handler
        .performRequests_error(&requests)
        .map_err(|_| "Apple Vision could not recognize text in that capture.".to_string())?;

    let observations = request
        .results()
        .ok_or_else(|| "Apple Vision returned no text recognition result.".to_string())?;
    let mut lines = Vec::with_capacity(observations.len().min(MAX_OCR_LINES + 1));
    for index in 0..observations.len() {
        let candidates = observations.objectAtIndex(index).topCandidates(1);
        if !candidates.is_empty() {
            lines.push(candidates.objectAtIndex(0).string().to_string());
        }
        if lines.len() > MAX_OCR_LINES {
            break;
        }
    }
    Ok(bounded_recognized_text(lines))
}

#[cfg(not(target_os = "macos"))]
fn recognize_png(_path: &Path) -> Result<BoundedRecognizedText, String> {
    Err("On-device Apple Vision text extraction is only available on macOS.".into())
}

async fn recognize_path(
    app: AppHandle,
    capture_id: String,
    path: PathBuf,
) -> Result<OcrResult, String> {
    let ticket = begin_session(&app, &capture_id)?;
    recognize_reserved_path(app, ticket, path).await
}

fn begin_session(app: &AppHandle, capture_id: &str) -> Result<OcrTicket, String> {
    app.state::<Mutex<OcrRuntime>>()
        .lock()
        .map_err(|_| "Text extraction is temporarily unavailable.".to_string())?
        .begin(capture_id)
}

fn fail_session(app: &AppHandle, ticket: &OcrTicket) {
    if let Ok(mut runtime) = app.state::<Mutex<OcrRuntime>>().lock() {
        runtime.fail(ticket);
    }
}

async fn recognize_reserved_path(
    app: AppHandle,
    ticket: OcrTicket,
    path: PathBuf,
) -> Result<OcrResult, String> {
    let worker_ticket = ticket.clone();
    let recognized = tauri::async_runtime::spawn_blocking(move || recognize_png(&path)).await;

    match recognized {
        Ok(Ok(recognized)) => app
            .state::<Mutex<OcrRuntime>>()
            .lock()
            .map_err(|_| "Text extraction is temporarily unavailable.".to_string())?
            .finish(ticket, recognized),
        Ok(Err(error)) => {
            fail_session(&app, &worker_ticket);
            Err(error)
        }
        Err(_) => {
            fail_session(&app, &worker_ticket);
            Err("The on-device text extraction task stopped unexpectedly.".into())
        }
    }
}

pub(crate) async fn recognize_history_capture_text(
    app: AppHandle,
    id: String,
) -> Result<OcrResult, String> {
    let capture = crate::history::resolve_recent_capture_for_app(&app, &id)?;
    let file_name = capture
        .path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "That history capture has an invalid file name.".to_string())?;
    validate_source(file_name, capture.bytes)?;
    recognize_path(app, capture.id, capture.path).await
}

pub(crate) async fn recognize_selected_png_text(
    app: AppHandle,
) -> Result<Option<SelectedOcrResult>, String> {
    let capture_id = uuid::Uuid::new_v4().to_string();
    let ticket = begin_session(&app, &capture_id)?;
    let selected = app
        .dialog()
        .file()
        .set_title("Choose a PNG for on-device text extraction")
        .add_filter("PNG image", &["png"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        fail_session(&app, &ticket);
        return Ok(None);
    };
    let path = match selected
        .into_path()
        .map_err(|_| "The selected image is not a readable local file path.".to_string())
    {
        Ok(path) => path,
        Err(error) => {
            fail_session(&app, &ticket);
            return Err(error);
        }
    };
    let (source_name, source_bytes) = match validate_selected_png(&path) {
        Ok(source) => source,
        Err(error) => {
            fail_session(&app, &ticket);
            return Err(error);
        }
    };
    let result = recognize_reserved_path(app, ticket, path).await?;
    Ok(Some(SelectedOcrResult {
        source_name,
        source_bytes,
        result,
    }))
}

pub(crate) fn cleanup_ephemeral_selections(app: &AppHandle) -> Result<(), String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate Capso's private OCR cache: {error}"))?;
    cleanup_ephemeral_selection_directory(&cache_root.join(OCR_SELECTION_DIRECTORY))
}

pub(crate) async fn recognize_screen_selection_text(
    app: AppHandle,
) -> Result<Option<SelectedOcrResult>, String> {
    let _capture_lease = crate::capture::acquire_capture_lease().map_err(|error| error.message)?;
    let capture_id = uuid::Uuid::new_v4().to_string();
    let ticket = begin_session(&app, &capture_id)?;
    let cache_root = match app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate Capso's private OCR cache: {error}"))
    {
        Ok(cache_root) => cache_root,
        Err(error) => {
            fail_session(&app, &ticket);
            return Err(error);
        }
    };
    let selection = match EphemeralOcrSelection::prepare(&cache_root, &capture_id) {
        Ok(selection) => selection,
        Err(error) => {
            fail_session(&app, &ticket);
            return Err(error);
        }
    };
    let history_window = app.get_webview_window("history");
    let restore_history = history_window
        .as_ref()
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if let Some(window) = history_window.as_ref().filter(|_| restore_history) {
        if let Err(error) = window.hide() {
            fail_session(&app, &ticket);
            return Err(format!(
                "Could not hide Capture History before selecting private screen pixels: {error}"
            ));
        }
    }
    let output = selection.path().to_path_buf();
    let command_output = output.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        Command::new("/usr/sbin/screencapture")
            .args(crate::capture::screencapture_args(
                crate::capture::CaptureMode::Region,
                &command_output,
            ))
            .status()
    })
    .await;
    if restore_history {
        if let Some(window) = history_window {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    let status = match status {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            fail_session(&app, &ticket);
            return Err(format!(
                "Could not start the macOS OCR area selector: {error}"
            ));
        }
        Err(_) => {
            fail_session(&app, &ticket);
            return Err("The macOS OCR area selector stopped unexpectedly.".into());
        }
    };
    if !status.success() {
        fail_session(&app, &ticket);
        if !output.exists() {
            return Ok(None);
        }
        return Err("macOS could not finish the selected OCR area.".into());
    }
    let (_, source_bytes) = match validate_selected_png(&output) {
        Ok(source) => source,
        Err(error) => {
            fail_session(&app, &ticket);
            return Err(error);
        }
    };
    let result = recognize_reserved_path(app, ticket, output).await?;
    Ok(Some(SelectedOcrResult {
        source_name: "Screen selection".into(),
        source_bytes,
        result,
    }))
}

#[cfg(target_os = "macos")]
fn string_pasteboard_type() -> &'static objc2_app_kit::NSPasteboardType {
    // SAFETY: AppKit exports NSPasteboardTypeString as a process-lifetime NSString.
    unsafe { objc2_app_kit::NSPasteboardTypeString }
}

#[cfg(target_os = "macos")]
fn write_text_to_pasteboard(
    pasteboard: &objc2_app_kit::NSPasteboard,
    text: &str,
) -> Result<(), String> {
    use objc2_foundation::NSString;

    let text = NSString::from_str(text);
    pasteboard.clearContents();
    if pasteboard.setString_forType(&text, string_pasteboard_type()) {
        Ok(())
    } else {
        Err("macOS rejected the recognized text clipboard payload.".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_text_to_pasteboard(_text: &str) -> Result<(), String> {
    Err("Recognized text copying is only available in the macOS app.".into())
}

async fn copy_private_text(app: AppHandle, text: String, kind: &'static str) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let result =
            write_text_to_pasteboard(&objc2_app_kit::NSPasteboard::generalPasteboard(), &text);
        #[cfg(not(target_os = "macos"))]
        let result = write_text_to_pasteboard(&text);
        let _ = sender.send(result);
    })
    .map_err(|error| format!("Could not schedule the {kind} copy: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|_| format!("The {kind} copy did not complete."))?
    })
    .await
    .map_err(|_| format!("The {kind} clipboard task stopped unexpectedly."))?
}

pub(crate) async fn copy_recognized_text(
    app: AppHandle,
    capture_id: String,
    session_id: u64,
) -> Result<(), String> {
    let text = app
        .state::<Mutex<OcrRuntime>>()
        .lock()
        .map_err(|_| "Text extraction is temporarily unavailable.".to_string())?
        .text_for_copy(&capture_id, session_id)?;
    copy_private_text(app, text, "recognized text").await
}

pub(crate) async fn copy_recognized_link(
    app: AppHandle,
    capture_id: String,
    session_id: u64,
    link_index: usize,
) -> Result<(), String> {
    if link_index >= MAX_OCR_LINKS {
        return Err("That recognized link index is outside Capso's safe limit.".into());
    }
    let link = app
        .state::<Mutex<OcrRuntime>>()
        .lock()
        .map_err(|_| "Text extraction is temporarily unavailable.".to_string())?
        .link_for_copy(&capture_id, session_id, link_index)?;
    copy_private_text(app, link, "recognized link").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat};
    use std::{fs, io::Cursor};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("encode PNG fixture");
        bytes.into_inner()
    }

    #[test]
    fn user_selected_png_is_validated_without_importing_or_exposing_its_path() {
        let root = tempfile::tempdir().expect("selected image root");
        let selected = root.path().join("Private Board.PNG");
        let bytes = png(320, 180);
        fs::write(&selected, &bytes).expect("write selected image");

        assert_eq!(
            validate_selected_png(&selected).expect("valid selected PNG"),
            ("Private Board.PNG".to_string(), bytes.len() as u64)
        );
        assert_eq!(fs::read(&selected).expect("source unchanged"), bytes);
    }

    #[test]
    fn user_selected_ocr_rejects_disguised_images_before_vision() {
        let root = tempfile::tempdir().expect("selected image root");
        let fake = root.path().join("fake.png");
        fs::write(&fake, b"not an image").expect("write fake image");
        let jpeg = root.path().join("photo.jpg");
        fs::write(&jpeg, png(8, 8)).expect("write wrong extension");

        assert!(validate_selected_png(&fake).is_err());
        assert!(validate_selected_png(&jpeg).is_err());
    }

    #[test]
    fn screen_selection_uses_one_private_uuid_path_and_drop_removes_its_pixels() {
        let root = tempfile::tempdir().expect("OCR cache root");
        let id = "018f22c4-cada-7c6b-9d5b-fc35f7f9227c";
        let selection = EphemeralOcrSelection::prepare(root.path(), id)
            .expect("ephemeral selection should prepare");
        assert_eq!(
            selection.path(),
            root.path().join("ocr-selections").join(format!("{id}.png"))
        );
        fs::write(selection.path(), png(64, 32)).expect("write selected pixels");
        drop(selection);
        assert!(!root
            .path()
            .join("ocr-selections")
            .join(format!("{id}.png"))
            .exists());
    }

    #[test]
    fn startup_cleanup_removes_only_exact_app_owned_selection_names() {
        let root = tempfile::tempdir().expect("OCR cache root");
        let directory = root.path().join("ocr-selections");
        fs::create_dir_all(&directory).expect("create OCR selection cache");
        let stale = directory.join("018f22c4-cada-7c6b-9d5b-fc35f7f9227d.png");
        let unrelated = directory.join("keep-me.png");
        let nested = directory.join("018f22c4-cada-7c6b-9d5b-fc35f7f9227e.png");
        fs::write(&stale, png(8, 8)).expect("write stale selection");
        fs::write(&unrelated, b"caller-owned bytes").expect("write unrelated fixture");
        fs::create_dir(&nested).expect("create matching-name directory");

        cleanup_ephemeral_selection_directory(&directory).expect("cleanup should succeed");

        assert!(!stale.exists());
        assert_eq!(fs::read(unrelated).unwrap(), b"caller-owned bytes");
        assert!(nested.is_dir());
    }

    #[test]
    fn recognized_lines_are_sanitized_without_losing_multilingual_text() {
        let result = bounded_recognized_text([
            "  Capso\r\nCapture  ".to_string(),
            "繁體中文\0 OCR".to_string(),
            "   ".to_string(),
        ]);

        assert_eq!(result.text, "Capso Capture\n繁體中文 OCR");
        assert_eq!(result.line_count, 2);
        assert!(!result.truncated);
    }

    #[test]
    fn recognized_text_never_splits_utf8_or_exceeds_output_limits() {
        let oversized = "字".repeat(MAX_OCR_TEXT_BYTES);
        let result =
            bounded_recognized_text([oversized, "this line is beyond the byte limit".to_string()]);

        assert!(result.text.len() <= MAX_OCR_TEXT_BYTES);
        assert!(result.text.is_char_boundary(result.text.len()));
        assert!(result.truncated);
    }

    #[test]
    fn recognized_text_has_a_hard_line_limit() {
        let result =
            bounded_recognized_text((0..MAX_OCR_LINES + 1).map(|index| format!("line {index}")));

        assert_eq!(result.line_count, MAX_OCR_LINES);
        assert!(result.truncated);
    }

    #[test]
    fn recognized_web_links_are_deduplicated_bounded_and_scheme_safe() {
        let links = recognized_links(
            "Visit (https://capso.app/docs). https://capso.app/docs \
             HTTP://example.com/path?q=one#two ftp://example.com/file \
             javascript:alert(1) http://user:secret@example.com/private",
        );

        assert_eq!(
            links,
            [
                "https://capso.app/docs".to_string(),
                "HTTP://example.com/path?q=one#two".to_string(),
            ]
        );

        let many = (0..MAX_OCR_LINKS + 4)
            .map(|index| format!("https://example.com/{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(recognized_links(&many).len(), MAX_OCR_LINKS);
        assert!(recognized_links(&format!(
            "https://example.com/{}",
            "a".repeat(MAX_OCR_LINK_BYTES)
        ))
        .is_empty());
    }

    #[test]
    fn runtime_copies_only_the_exact_completed_session() {
        let mut runtime = OcrRuntime::default();
        let first = runtime.begin(CAPTURE_ID).expect("start first OCR");
        assert!(runtime.begin(OTHER_CAPTURE_ID).is_err());

        let completed = runtime
            .finish(
                first,
                bounded_recognized_text(["Private text https://capso.app/library".into()]),
            )
            .expect("finish first OCR");
        assert_eq!(
            runtime.text_for_copy(CAPTURE_ID, completed.session_id),
            Ok("Private text https://capso.app/library".into()),
        );
        assert_eq!(
            runtime.link_for_copy(CAPTURE_ID, completed.session_id, 0),
            Ok("https://capso.app/library".into()),
        );
        assert!(runtime
            .link_for_copy(CAPTURE_ID, completed.session_id, 1)
            .is_err());
        assert!(runtime
            .text_for_copy(OTHER_CAPTURE_ID, completed.session_id)
            .is_err());

        let second = runtime.begin(OTHER_CAPTURE_ID).expect("start second OCR");
        assert!(runtime
            .text_for_copy(CAPTURE_ID, completed.session_id)
            .is_err());
        assert!(runtime
            .link_for_copy(CAPTURE_ID, completed.session_id, 0)
            .is_err());
        runtime.fail(&second);
        assert!(runtime
            .text_for_copy(OTHER_CAPTURE_ID, second.session_id)
            .is_err());
    }

    #[test]
    fn source_limits_reject_non_png_or_oversized_history_entries() {
        assert!(validate_source("capture.png", MAX_OCR_SOURCE_BYTES).is_ok());
        assert!(validate_source("capture.jpg", 20).is_err());
        assert!(validate_source("capture.png", MAX_OCR_SOURCE_BYTES + 1).is_err());
        assert!(validate_source("capture.PNG", 20).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "set CAPSO_OCR_FIXTURE to an explicit caller-owned PNG"]
    fn apple_vision_recognizes_an_explicit_local_fixture_without_network() {
        let path = std::env::var_os("CAPSO_OCR_FIXTURE")
            .map(std::path::PathBuf::from)
            .expect("CAPSO_OCR_FIXTURE must name an explicit local PNG");
        let metadata = std::fs::metadata(&path).expect("inspect explicit OCR fixture");
        validate_source(
            path.file_name()
                .and_then(|value| value.to_str())
                .expect("fixture has UTF-8 file name"),
            metadata.len(),
        )
        .expect("fixture stays inside OCR source limits");

        let result = recognize_png(&path).expect("Apple Vision recognizes the fixture");

        assert!(!result.text.is_empty());
        assert!(result.line_count > 0);
        assert!(result.text.len() <= MAX_OCR_TEXT_BYTES);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn appkit_round_trip_preserves_exact_multilingual_ocr_text() {
        let pasteboard = objc2_app_kit::NSPasteboard::pasteboardWithUniqueName();
        let expected = "Capso OCR\n繁體中文 · English";

        write_text_to_pasteboard(&pasteboard, expected).expect("write custom test pasteboard");
        let copied = pasteboard
            .stringForType(string_pasteboard_type())
            .expect("string exists on custom test pasteboard")
            .to_string();

        assert_eq!(copied, expected);
    }

    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
    const OTHER_CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227b";
}
