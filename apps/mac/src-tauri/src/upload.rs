#![allow(dead_code)]

use crate::{
    annotation_project,
    annotation_sync::{
        AnnotationCloudTransport, AnnotationProjectUploadResult, AnnotationSyncClaim,
        AnnotationSyncTransport, RemoteAnnotationBundle, RemoteAnnotationHead,
    },
    auth::{AuthSession, SupabaseAuthConfig},
    capture_mirror::{CaptureCloudTransport, RemoteCaptureHead, RemoteCaptureSource},
    device::MacDeviceCredential,
    drain::{TransportAvailability, UploadAcknowledgement, UploadResult, UploadTransport},
    ingest::{
        IngestFailureDisposition, NativeApiErrorEnvelope, NativeIngestRequest,
        NativeIngestResponse, NativeIngestSource,
    },
    queue::{QueueItem, QueueSource},
};
use image::{ImageDecoder, ImageFormat};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt, fs, io::Cursor, time::Duration};

const MAX_ORIGINAL_BYTES: u64 = 25 * 1_024 * 1_024;
const MAX_DECODE_PIXELS: u64 = 80_000_000;
const MAX_THUMB_BYTES: usize = 5 * 1_024 * 1_024;
const THUMB_EDGE: u32 = 640;
const MAX_RESPONSE_BYTES: usize = 64 * 1_024;
const MAX_ANNOTATION_PROJECT_BYTES: u64 = 8 * 1_024 * 1_024;
const MAX_ANNOTATION_HEADS_BYTES: usize = 512 * 1_024;
const MAX_CAPTURE_HEADS_BYTES: usize = 512 * 1_024;

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct UploadSession {
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    user_id: String,
    device_id: String,
    device_token: String,
}

impl fmt::Debug for UploadSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadSession")
            .field("supabase_url", &self.supabase_url)
            .field("publishable_key", &"[PUBLIC CONFIG]")
            .field("access_token", &"[REDACTED]")
            .field("user_id", &self.user_id)
            .field("device_id", &self.device_id)
            .field("device_token", &"[REDACTED]")
            .finish()
    }
}

impl UploadSession {
    pub(crate) fn from_auth(
        config: &SupabaseAuthConfig,
        session: &AuthSession,
        device: &MacDeviceCredential,
        now_ms: u64,
    ) -> Option<Self> {
        if session.user_id() != device.user_id() {
            return None;
        }
        Some(Self {
            supabase_url: config.url.clone(),
            publishable_key: config.publishable_key.clone(),
            access_token: session.usable_access_token(now_ms)?.into(),
            user_id: session.user_id().into(),
            device_id: device.id().into(),
            device_token: device.token().into(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HttpRequest {
    method: &'static str,
    url: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HttpResponse {
    status: u16,
    body: Vec<u8>,
}

trait HttpClient: Send + Sync {
    fn execute(&self, request: HttpRequest) -> Result<HttpResponse, String>;

    fn execute_bounded(
        &self,
        request: HttpRequest,
        max_response_bytes: usize,
    ) -> Result<HttpResponse, String> {
        let response = self.execute(request)?;
        if response.body.len() > max_response_bytes {
            Err("Capso's private library response exceeded its safety limit.".into())
        } else {
            Ok(response)
        }
    }
}

#[derive(Debug)]
pub(crate) struct ReqwestHttpClient {
    client: reqwest::blocking::Client,
}

impl ReqwestHttpClient {
    pub(crate) fn new() -> Result<Self, String> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map(|client| Self { client })
            .map_err(|error| format!("Could not prepare Capso's secure upload client: {error}"))
    }

    fn execute_with_limit(
        &self,
        request: HttpRequest,
        max_response_bytes: usize,
    ) -> Result<HttpResponse, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "Capso prepared an invalid upload method.".to_string())?;
        let mut builder = self.client.request(method, request.url);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        let response = builder
            .body(request.body)
            .send()
            .map_err(|error| format!("Capso could not reach its private library: {error}"))?;
        let status = response.status().as_u16();
        if response
            .content_length()
            .is_some_and(|length| length > max_response_bytes as u64)
        {
            return Err("Capso's private library response exceeded its safety limit.".into());
        }
        let body = response.bytes().map_err(|error| {
            format!("Capso could not read its private library response: {error}")
        })?;
        if body.len() > max_response_bytes {
            return Err("Capso's private library response exceeded its safety limit.".into());
        }
        Ok(HttpResponse {
            status,
            body: body.to_vec(),
        })
    }
}

impl HttpClient for ReqwestHttpClient {
    fn execute(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        self.execute_with_limit(request, MAX_RESPONSE_BYTES)
    }

    fn execute_bounded(
        &self,
        request: HttpRequest,
        max_response_bytes: usize,
    ) -> Result<HttpResponse, String> {
        self.execute_with_limit(request, max_response_bytes)
    }
}

#[derive(Debug)]
pub(crate) struct AuthenticatedUploadTransport<C> {
    client: C,
    session: Option<UploadSession>,
}

impl<C> AuthenticatedUploadTransport<C> {
    pub(crate) fn new(client: C, session: Option<UploadSession>) -> Self {
        Self { client, session }
    }

    #[cfg(test)]
    fn client(&self) -> &C {
        &self.client
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string() == value && (1..=8).contains(&id.get_version_num()))
        .unwrap_or(false)
}

fn bearer_headers(session: &UploadSession, content_type: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("apikey".into(), session.publishable_key.clone()),
        (
            "authorization".into(),
            format!("Bearer {}", session.access_token),
        ),
        ("content-type".into(), content_type.into()),
    ])
}

fn captured_at(ms: u64) -> Result<String, String> {
    let timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map_err(|_| "The queued capture timestamp is outside the supported range.".to_string())?;
    let date = timestamp.date();
    let clock = timestamp.time();
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.year(),
        u8::from(date.month()),
        date.day(),
        clock.hour(),
        clock.minute(),
        clock.second(),
        clock.millisecond(),
    ))
}

fn ingest_source(source: QueueSource) -> NativeIngestSource {
    match source {
        QueueSource::Region => NativeIngestSource::HotkeyRegion,
        QueueSource::Window => NativeIngestSource::HotkeyWindow,
        QueueSource::Fullscreen => NativeIngestSource::HotkeyFullscreen,
        QueueSource::Created => NativeIngestSource::Clipboard,
        QueueSource::Browser => NativeIngestSource::Clipboard,
        QueueSource::Recovered => NativeIngestSource::Clipboard,
    }
}

fn thumbnail_png(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_DECODE_PIXELS {
        return Err("The queued capture is too large to preview safely.".into());
    }
    let original = image::load_from_memory_with_format(bytes, ImageFormat::Png)
        .map_err(|_| "The queued capture could not be decoded for its preview.".to_string())?;
    // `DynamicImage::thumbnail` may upscale when both requested bounds exceed
    // the source, so cap the requested edge at the original's longest side.
    let edge = THUMB_EDGE.min(width.max(height));
    let thumb = original.thumbnail(edge, edge);
    let mut encoded = Cursor::new(Vec::new());
    thumb
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|_| "Capso could not encode the capture preview.".to_string())?;
    let bytes = encoded.into_inner();
    if bytes.is_empty() || bytes.len() > MAX_THUMB_BYTES {
        return Err("The capture preview exceeded Capso's safety limit.".into());
    }
    Ok(bytes)
}

fn safe_message(response: &HttpResponse, fallback: &str) -> String {
    serde_json::from_slice::<NativeApiErrorEnvelope>(&response.body)
        .map(|error| error.message().to_string())
        .or_else(|_| {
            serde_json::from_slice::<serde_json::Value>(&response.body).and_then(|body| {
                body.get("message")
                    .and_then(serde_json::Value::as_str)
                    .filter(|message| (1..=512).contains(&message.encode_utf16().count()))
                    .map(str::to_string)
                    .ok_or_else(|| serde_json::Error::io(std::io::Error::other("missing message")))
            })
        })
        .unwrap_or_else(|_| format!("{fallback} (HTTP {}).", response.status))
}

fn failure(response: &HttpResponse, fallback: &str) -> UploadResult {
    if let Ok(error) = serde_json::from_slice::<NativeApiErrorEnvelope>(&response.body) {
        return match error.disposition() {
            IngestFailureDisposition::Held => UploadResult::Held {
                message: error.message().into(),
            },
            IngestFailureDisposition::Retryable => UploadResult::Retryable {
                message: error.message().into(),
            },
            IngestFailureDisposition::Terminal => UploadResult::Terminal {
                message: error.message().into(),
            },
        };
    }
    let message = safe_message(response, fallback);
    match response.status {
        401 | 403 | 507 => UploadResult::Held { message },
        413 => UploadResult::Terminal { message },
        408 | 425 | 429 | 500..=599 => UploadResult::Retryable { message },
        _ => UploadResult::Terminal { message },
    }
}

fn is_existing_storage_object(response: &HttpResponse) -> bool {
    if response.status == 409 {
        return true;
    }
    if response.status != 400 {
        return false;
    }
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&response.body) else {
        return false;
    };
    let duplicate = [body.get("code"), body.get("error")]
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(|code| code.to_ascii_lowercase())
        .any(|code| {
            matches!(
                code.as_str(),
                "duplicate" | "resourcealreadyexists" | "keyalreadyexists" | "already_exists"
            )
        });
    duplicate
}

impl<C: HttpClient> UploadTransport for AuthenticatedUploadTransport<C> {
    fn availability(&self) -> TransportAvailability {
        let Some(session) = self.session.as_ref() else {
            return TransportAvailability::Held {
                code: "sign_in_required",
                message: "Sign in to sync captures; original pixels remain saved locally.".into(),
            };
        };
        if !session.supabase_url.starts_with("https://")
            || session.supabase_url.ends_with('/')
            || session.publishable_key.is_empty()
            || session.access_token.is_empty()
            || !canonical_uuid(&session.user_id)
            || !canonical_uuid(&session.device_id)
            || !session.device_token.starts_with("m_")
        {
            return TransportAvailability::Held {
                code: "session_invalid",
                message: "Capso's saved session needs to be refreshed before syncing.".into(),
            };
        }
        TransportAvailability::Ready
    }

    fn upload(&self, item: &QueueItem) -> UploadResult {
        let Some(session) = self.session.as_ref() else {
            return UploadResult::Held {
                message: "Sign in to sync captures; original pixels remain saved locally.".into(),
            };
        };
        if !matches!(self.availability(), TransportAvailability::Ready) {
            return UploadResult::Held {
                message: "Capso's saved session needs to be refreshed before syncing.".into(),
            };
        }
        let metadata = match fs::symlink_metadata(&item.file_path) {
            Ok(metadata)
                if metadata.file_type().is_file()
                    && (1..=MAX_ORIGINAL_BYTES).contains(&metadata.len()) =>
            {
                metadata
            }
            _ => {
                return UploadResult::Terminal {
                    message: "The queued capture is missing or exceeds Capso's 25 MiB limit."
                        .into(),
                }
            }
        };
        let bytes = match fs::read(&item.file_path) {
            Ok(bytes) if bytes.len() as u64 == metadata.len() => bytes,
            _ => {
                return UploadResult::Retryable {
                    message: "Capso could not read the complete queued capture.".into(),
                }
            }
        };
        // Read dimensions from the PNG decoder without materializing the full
        // bitmap. A small, highly compressed image must not turn an upload
        // attempt into an unbounded memory allocation.
        let decoder = match image::codecs::png::PngDecoder::new(Cursor::new(&bytes)) {
            Ok(decoder) => decoder,
            Err(_) => {
                return UploadResult::Terminal {
                    message: "The queued capture is not a valid PNG.".into(),
                }
            }
        };
        let (width, height) = decoder.dimensions();
        let storage_path = format!("originals/{}/{}.png", session.user_id, item.id);
        let thumb_path = format!("thumbs/{}/{}.png", session.user_id, item.id);
        let thumb = match thumbnail_png(&bytes, width, height) {
            Ok(thumb) => thumb,
            Err(message) => return UploadResult::Terminal { message },
        };
        let hash = format!("sha256:{:x}", Sha256::digest(&bytes));
        let request = NativeIngestRequest {
            screenshot_id: item.id.clone(),
            storage_path: storage_path.clone(),
            thumb_path: thumb_path.clone(),
            captured_at: match captured_at(item.created_at_ms) {
                Ok(value) => value,
                Err(message) => return UploadResult::Terminal { message },
            },
            source: ingest_source(item.source),
            content_hash: hash,
            annotated: item.annotated,
            width,
            height,
            bytes: bytes.len() as u64,
            project_id: item.project_id.clone(),
        };
        if let Err(error) = request.validate() {
            return UploadResult::Terminal {
                message: error.to_string(),
            };
        }

        let storage = match self.client.execute(HttpRequest {
            method: "POST",
            url: format!(
                "{}/storage/v1/object/originals/{}/{}.png",
                session.supabase_url, session.user_id, item.id
            ),
            headers: {
                let mut headers = bearer_headers(session, "image/png");
                headers.insert("x-upsert".into(), "false".into());
                headers
            },
            body: bytes,
        }) {
            Ok(response) => response,
            Err(message) => return UploadResult::Retryable { message },
        };
        if !(200..300).contains(&storage.status) && !is_existing_storage_object(&storage) {
            return failure(&storage, "Capso could not store the original capture");
        }

        let thumbnail = match self.client.execute(HttpRequest {
            method: "POST",
            url: format!(
                "{}/storage/v1/object/thumbs/{}/{}.png",
                session.supabase_url, session.user_id, item.id
            ),
            headers: {
                let mut headers = bearer_headers(session, "image/png");
                headers.insert("x-upsert".into(), "false".into());
                headers
            },
            body: thumb,
        }) {
            Ok(response) => response,
            Err(message) => return UploadResult::Retryable { message },
        };
        if !(200..300).contains(&thumbnail.status) && !is_existing_storage_object(&thumbnail) {
            return failure(&thumbnail, "Capso could not store the capture preview");
        }

        let body = json!({
            "p_screenshot_id": request.screenshot_id,
            "p_storage_path": request.storage_path,
            "p_thumb_path": request.thumb_path,
            "p_captured_at": request.captured_at,
            "p_source": request.source.as_str(),
            "p_content_hash": request.content_hash,
            "p_annotated": request.annotated,
            "p_width": request.width,
            "p_height": request.height,
            "p_bytes": request.bytes,
            "p_project_id": request.project_id,
            "p_device_id": session.device_id,
            "p_device_token": session.device_token,
        });
        let registration = match self.client.execute(HttpRequest {
            method: "POST",
            url: format!("{}/rest/v1/rpc/ingest_native_capture", session.supabase_url),
            headers: bearer_headers(session, "application/json"),
            body: serde_json::to_vec(&body).expect("native ingest metadata is serializable"),
        }) {
            Ok(response) => response,
            Err(message) => return UploadResult::Retryable { message },
        };
        if !(200..300).contains(&registration.status) {
            return failure(&registration, "Capso could not register the stored capture");
        }
        match serde_json::from_slice::<NativeIngestResponse>(&registration.body)
            .map_err(|_| "Capso received an invalid upload acknowledgement.".to_string())
            .and_then(|response| {
                response
                    .acknowledge(&item.id)
                    .map_err(|error| error.to_string())
            }) {
            Ok(capture_id) => UploadResult::Confirmed(UploadAcknowledgement { capture_id }),
            Err(message) => UploadResult::Retryable { message },
        }
    }
}

#[derive(Debug, Deserialize)]
struct AnnotationCommitResponse {
    status: String,
    screenshot_id: String,
    cloud_revision: u64,
    document_revision: u64,
    mutation_id: String,
    #[allow(dead_code)]
    deduped: bool,
}

fn read_annotation_asset(
    path: &std::path::Path,
    limit: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the editable annotation {label}: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err(format!(
            "The editable annotation {label} is not a bounded regular file."
        ));
    }
    fs::read(path)
        .map_err(|error| format!("Could not read the editable annotation {label}: {error}"))
}

fn annotation_png_dimensions(bytes: &[u8], label: &str) -> Result<(u32, u32), String> {
    let decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes))
        .map_err(|_| format!("The editable annotation {label} is not a valid PNG."))?;
    let dimensions = decoder.dimensions();
    if dimensions.0 == 0
        || dimensions.1 == 0
        || u64::from(dimensions.0).saturating_mul(u64::from(dimensions.1)) > MAX_DECODE_PIXELS
    {
        return Err(format!(
            "The editable annotation {label} dimensions are outside Capso's safety limit."
        ));
    }
    Ok(dimensions)
}

fn annotation_failure(response: &HttpResponse, fallback: &str) -> AnnotationProjectUploadResult {
    let message = safe_message(response, fallback);
    match response.status {
        401 | 403 | 507 => AnnotationProjectUploadResult::Held { message },
        408 | 425 | 429 | 500..=599 => AnnotationProjectUploadResult::Retryable { message },
        _ => AnnotationProjectUploadResult::Terminal { message },
    }
}

impl<C: HttpClient> AnnotationSyncTransport for AuthenticatedUploadTransport<C> {
    fn upload_annotation_project(
        &self,
        claim: &AnnotationSyncClaim,
    ) -> AnnotationProjectUploadResult {
        let Some(session) = self.session.as_ref() else {
            return AnnotationProjectUploadResult::Held {
                message: "Sign in to sync editable projects; local revisions remain safe.".into(),
            };
        };
        if !matches!(
            UploadTransport::availability(self),
            TransportAvailability::Ready
        ) {
            return AnnotationProjectUploadResult::Held {
                message:
                    "Capso's saved session needs to be refreshed before syncing editable projects."
                        .into(),
            };
        }
        if !canonical_uuid(&claim.capture_id)
            || !canonical_uuid(&claim.mutation_id)
            || claim.document_revision == 0
            || !claim.original_sha256.starts_with("sha256:")
            || !claim.flattened_sha256.starts_with("sha256:")
        {
            return AnnotationProjectUploadResult::Terminal {
                message: "The editable project upload identity is invalid.".into(),
            };
        }
        let original = match read_annotation_asset(
            &claim.original_path,
            MAX_ORIGINAL_BYTES,
            "protected original",
        ) {
            Ok(bytes) => bytes,
            Err(message) => return AnnotationProjectUploadResult::Terminal { message },
        };
        let flattened = match read_annotation_asset(
            &claim.flattened_path,
            MAX_ORIGINAL_BYTES,
            "flattened revision",
        ) {
            Ok(bytes) => bytes,
            Err(message) => return AnnotationProjectUploadResult::Terminal { message },
        };
        let project_bytes = match read_annotation_asset(
            &claim.project_path,
            MAX_ANNOTATION_PROJECT_BYTES,
            "project document",
        ) {
            Ok(bytes) => bytes,
            Err(message) => return AnnotationProjectUploadResult::Terminal { message },
        };
        let flattened_dimensions = match annotation_png_dimensions(&flattened, "flattened revision")
        {
            Ok(dimensions) => dimensions,
            Err(message) => return AnnotationProjectUploadResult::Terminal { message },
        };
        if let Err(message) = annotation_png_dimensions(&original, "protected original") {
            return AnnotationProjectUploadResult::Terminal { message };
        }
        if format!("sha256:{:x}", Sha256::digest(&original)) != claim.original_sha256
            || format!("sha256:{:x}", Sha256::digest(&flattened)) != claim.flattened_sha256
        {
            return AnnotationProjectUploadResult::Terminal {
                message: "The editable project pixels changed after they were queued.".into(),
            };
        }
        let document: serde_json::Value = match serde_json::from_slice(&project_bytes) {
            Ok(document) => document,
            Err(_) => {
                return AnnotationProjectUploadResult::Terminal {
                    message: "The editable project document is invalid.".into(),
                }
            }
        };
        if annotation_project::decode_for_sync(&project_bytes).is_err() {
            return AnnotationProjectUploadResult::Terminal {
                message: "The editable project document failed Capso's strict mark validation."
                    .into(),
            };
        }
        let marks = document.get("marks").and_then(serde_json::Value::as_array);
        let valid_document = document
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            == Some(1)
            && document
                .get("captureId")
                .and_then(serde_json::Value::as_str)
                == Some(claim.capture_id.as_str())
            && document.get("revision").and_then(serde_json::Value::as_u64)
                == Some(claim.document_revision)
            && document
                .get("originalSha256")
                .and_then(serde_json::Value::as_str)
                == Some(claim.original_sha256.as_str())
            && document
                .get("flattenedSha256")
                .and_then(serde_json::Value::as_str)
                == Some(claim.flattened_sha256.as_str())
            && document.get("width").and_then(serde_json::Value::as_u64)
                == Some(u64::from(flattened_dimensions.0))
            && document.get("height").and_then(serde_json::Value::as_u64)
                == Some(u64::from(flattened_dimensions.1))
            && marks.is_some_and(|marks| marks.len() <= 10_000)
            && (marks.is_some_and(|marks| !marks.is_empty()) || !document["crop"].is_null());
        if !valid_document {
            return AnnotationProjectUploadResult::Terminal {
                message: "The editable project document no longer matches its queued revision."
                    .into(),
            };
        }

        let original_path = format!(
            "annotation-assets/{}/{}/original.png",
            session.user_id, claim.capture_id
        );
        let flattened_path = format!(
            "annotation-assets/{}/{}/revisions/{}.png",
            session.user_id, claim.capture_id, claim.mutation_id
        );
        let upload = |object_name: &str, body: Vec<u8>| {
            self.client.execute(HttpRequest {
                method: "POST",
                url: format!(
                    "{}/storage/v1/object/annotation-assets/{}",
                    session.supabase_url, object_name
                ),
                headers: {
                    let mut headers = bearer_headers(session, "image/png");
                    headers.insert("x-upsert".into(), "false".into());
                    headers
                },
                body,
            })
        };
        let original_response = match upload(
            &format!("{}/{}/original.png", session.user_id, claim.capture_id),
            original,
        ) {
            Ok(response) => response,
            Err(message) => return AnnotationProjectUploadResult::Retryable { message },
        };
        if !(200..300).contains(&original_response.status)
            && !is_existing_storage_object(&original_response)
        {
            return annotation_failure(
                &original_response,
                "Capso could not store the protected annotation original",
            );
        }
        let flattened_response = match upload(
            &format!(
                "{}/{}/revisions/{}.png",
                session.user_id, claim.capture_id, claim.mutation_id
            ),
            flattened,
        ) {
            Ok(response) => response,
            Err(message) => return AnnotationProjectUploadResult::Retryable { message },
        };
        if !(200..300).contains(&flattened_response.status)
            && !is_existing_storage_object(&flattened_response)
        {
            return annotation_failure(
                &flattened_response,
                "Capso could not store the flattened annotation revision",
            );
        }

        let registration = match self.client.execute(HttpRequest {
            method: "POST",
            url: format!(
                "{}/rest/v1/rpc/commit_annotation_project_revision",
                session.supabase_url
            ),
            headers: bearer_headers(session, "application/json"),
            body: serde_json::to_vec(&json!({
                "p_screenshot_id": claim.capture_id,
                "p_base_cloud_revision": claim.base_cloud_revision,
                "p_document_revision": claim.document_revision,
                "p_mutation_id": claim.mutation_id,
                "p_original_storage_path": original_path,
                "p_flattened_storage_path": flattened_path,
                "p_original_sha256": claim.original_sha256,
                "p_flattened_sha256": claim.flattened_sha256,
                "p_document": document,
                "p_device_id": session.device_id,
                "p_device_token": session.device_token,
            }))
            .expect("editable annotation metadata is serializable"),
        }) {
            Ok(response) => response,
            Err(message) => return AnnotationProjectUploadResult::Retryable { message },
        };
        if !(200..300).contains(&registration.status) {
            return annotation_failure(
                &registration,
                "Capso could not commit the editable annotation revision",
            );
        }
        let expected_cloud_revision = claim.base_cloud_revision.checked_add(1);
        match serde_json::from_slice::<AnnotationCommitResponse>(&registration.body) {
            Ok(response)
                if response.status == "conflict"
                    && response.screenshot_id == claim.capture_id
                    && response.mutation_id == claim.mutation_id
                    && response.document_revision == claim.document_revision
                    && response.cloud_revision > claim.base_cloud_revision =>
            {
                AnnotationProjectUploadResult::Conflict {
                    remote_cloud_revision: response.cloud_revision,
                    message: "Another Mac saved a newer editable revision. Your local work is still safe."
                        .into(),
                }
            }
            Ok(response)
                if response.status == "committed"
                    && response.screenshot_id == claim.capture_id
                    && response.mutation_id == claim.mutation_id
                    && response.document_revision == claim.document_revision
                    && Some(response.cloud_revision) == expected_cloud_revision =>
            {
                AnnotationProjectUploadResult::Confirmed {
                    capture_id: response.screenshot_id,
                    mutation_id: response.mutation_id,
                    cloud_revision: response.cloud_revision,
                }
            }
            _ => AnnotationProjectUploadResult::Retryable {
                message: "Capso received an invalid editable project acknowledgement.".into(),
            },
        }
    }
}

#[derive(Debug, Deserialize)]
struct RemoteAnnotationRevisionResponse {
    screenshot_id: String,
    cloud_revision: u64,
    document_revision: u64,
    mutation_id: String,
    original_storage_path: String,
    flattened_storage_path: String,
    original_sha256: String,
    flattened_sha256: String,
    document: serde_json::Value,
}

impl RemoteAnnotationRevisionResponse {
    fn head(&self) -> RemoteAnnotationHead {
        RemoteAnnotationHead {
            capture_id: self.screenshot_id.clone(),
            cloud_revision: self.cloud_revision,
            document_revision: self.document_revision,
            mutation_id: self.mutation_id.clone(),
            original_storage_path: self.original_storage_path.clone(),
            flattened_storage_path: self.flattened_storage_path.clone(),
            original_sha256: self.original_sha256.clone(),
            flattened_sha256: self.flattened_sha256.clone(),
        }
    }
}

fn valid_annotation_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn validate_remote_capture_head(
    session: &UploadSession,
    head: &RemoteCaptureHead,
) -> Result<(), String> {
    let extension = if head.source == RemoteCaptureSource::Browser {
        "jpg"
    } else {
        "png"
    };
    let expected_path = format!(
        "originals/{}/{}.{}",
        session.user_id, head.capture_id, extension
    );
    let timestamp = time::OffsetDateTime::parse(
        &head.captured_at,
        &time::format_description::well_known::Rfc3339,
    )
    .ok();
    if !canonical_uuid(&head.capture_id)
        || head
            .project_thread_id
            .as_deref()
            .is_some_and(|project_id| !canonical_uuid(project_id))
        || head.storage_path != expected_path
        || !valid_annotation_hash(&head.content_hash)
        || !(8..=MAX_ORIGINAL_BYTES).contains(&head.bytes)
        || head.width == 0
        || head.width > 100_000
        || head.height == 0
        || head.height > 100_000
        || u64::from(head.width).saturating_mul(u64::from(head.height)) > MAX_DECODE_PIXELS
        || timestamp.is_none_or(|timestamp| timestamp.unix_timestamp_nanos() < 0)
    {
        return Err("Capso received an invalid remote screenshot head.".into());
    }
    Ok(())
}

impl<C: HttpClient> CaptureCloudTransport for AuthenticatedUploadTransport<C> {
    fn list_remote_capture_heads(&self) -> Result<Vec<RemoteCaptureHead>, String> {
        let session = self.session.as_ref().ok_or_else(|| {
            "Sign in to discover screenshots; local captures remain safe.".to_string()
        })?;
        if !matches!(
            UploadTransport::availability(self),
            TransportAvailability::Ready
        ) {
            return Err(
                "Capso's saved session needs to be refreshed before discovering screenshots."
                    .into(),
            );
        }
        let response = self.client.execute_bounded(
            HttpRequest {
                method: "POST",
                url: format!(
                    "{}/rest/v1/rpc/list_mac_screenshot_heads",
                    session.supabase_url
                ),
                headers: bearer_headers(session, "application/json"),
                body: serde_json::to_vec(&json!({
                    "p_device_id": session.device_id,
                    "p_device_token": session.device_token,
                }))
                .expect("screenshot discovery is serializable"),
            },
            MAX_CAPTURE_HEADS_BYTES,
        )?;
        if !(200..300).contains(&response.status) {
            return Err(safe_message(
                &response,
                "Capso could not discover remote screenshots",
            ));
        }
        let heads: Vec<RemoteCaptureHead> = serde_json::from_slice(&response.body)
            .map_err(|_| "Capso received an invalid remote screenshot head list.".to_string())?;
        if heads.len() > 500 {
            return Err("Capso received too many screenshot heads at once.".into());
        }
        let mut capture_ids = std::collections::HashSet::new();
        for head in &heads {
            validate_remote_capture_head(session, head)?;
            if !capture_ids.insert(head.capture_id.as_str()) {
                return Err("Capso received duplicate screenshot heads.".into());
            }
        }
        Ok(heads)
    }

    fn download_remote_capture(&self, head: &RemoteCaptureHead) -> Result<Vec<u8>, String> {
        let session = self.session.as_ref().ok_or_else(|| {
            "Sign in to download screenshots; local captures remain safe.".to_string()
        })?;
        validate_remote_capture_head(session, head)?;
        let object_name = head
            .storage_path
            .strip_prefix("originals/")
            .ok_or_else(|| "The remote screenshot path is invalid.".to_string())?;
        let response = self.client.execute_bounded(
            HttpRequest {
                method: "GET",
                url: format!(
                    "{}/storage/v1/object/originals/{}",
                    session.supabase_url, object_name
                ),
                headers: bearer_headers(session, "application/octet-stream"),
                body: Vec::new(),
            },
            MAX_ORIGINAL_BYTES as usize,
        )?;
        if !(200..300).contains(&response.status) {
            return Err(safe_message(
                &response,
                "Capso could not download a private screenshot",
            ));
        }
        if response.body.len() as u64 != head.bytes
            || format!("sha256:{:x}", Sha256::digest(&response.body)) != head.content_hash
        {
            return Err("The remote screenshot failed its exact byte identity.".into());
        }
        let dimensions = if head.source == RemoteCaptureSource::Browser {
            image::codecs::jpeg::JpegDecoder::new(Cursor::new(&response.body))
                .map(|decoder| decoder.dimensions())
                .map_err(|_| "The remote browser screenshot is not a valid JPEG.".to_string())?
        } else {
            image::codecs::png::PngDecoder::new(Cursor::new(&response.body))
                .map(|decoder| decoder.dimensions())
                .map_err(|_| "The remote screenshot is not a valid PNG.".to_string())?
        };
        if dimensions != (head.width, head.height) {
            return Err("The remote screenshot dimensions do not match its cloud head.".into());
        }
        Ok(response.body)
    }
}

fn validate_remote_head(
    session: &UploadSession,
    head: &RemoteAnnotationHead,
) -> Result<(), String> {
    let expected_original = format!(
        "annotation-assets/{}/{}/original.png",
        session.user_id, head.capture_id
    );
    let expected_flattened = format!(
        "annotation-assets/{}/{}/revisions/{}.png",
        session.user_id, head.capture_id, head.mutation_id
    );
    if !canonical_uuid(&head.capture_id)
        || !canonical_uuid(&head.mutation_id)
        || head.cloud_revision == 0
        || head.document_revision == 0
        || !valid_annotation_hash(&head.original_sha256)
        || !valid_annotation_hash(&head.flattened_sha256)
        || head.original_storage_path != expected_original
        || head.flattened_storage_path != expected_flattened
    {
        return Err("Capso received an invalid remote editable project head.".into());
    }
    Ok(())
}

impl<C: HttpClient> AnnotationCloudTransport for AuthenticatedUploadTransport<C> {
    fn list_remote_annotation_heads(&self) -> Result<Vec<RemoteAnnotationHead>, String> {
        let session = self.session.as_ref().ok_or_else(|| {
            "Sign in to discover editable projects; local revisions remain safe.".to_string()
        })?;
        if !matches!(
            UploadTransport::availability(self),
            TransportAvailability::Ready
        ) {
            return Err(
                "Capso's saved session needs to be refreshed before discovering editable projects."
                    .into(),
            );
        }
        let response = self.client.execute_bounded(
            HttpRequest {
                method: "POST",
                url: format!(
                    "{}/rest/v1/rpc/list_annotation_project_heads",
                    session.supabase_url
                ),
                headers: bearer_headers(session, "application/json"),
                body: serde_json::to_vec(&json!({
                    "p_device_id": session.device_id,
                    "p_device_token": session.device_token,
                }))
                .expect("editable project discovery is serializable"),
            },
            MAX_ANNOTATION_HEADS_BYTES,
        )?;
        if !(200..300).contains(&response.status) {
            return Err(safe_message(
                &response,
                "Capso could not discover remote editable projects",
            ));
        }
        let heads: Vec<RemoteAnnotationHead> = serde_json::from_slice(&response.body)
            .map_err(|_| "Capso received an invalid editable project head list.".to_string())?;
        if heads.len() > 500 {
            return Err("Capso received too many editable project heads at once.".into());
        }
        let mut capture_ids = std::collections::HashSet::new();
        for head in &heads {
            validate_remote_head(session, head)?;
            if !capture_ids.insert(head.capture_id.as_str()) {
                return Err("Capso received duplicate editable project heads.".into());
            }
        }
        Ok(heads)
    }

    fn download_remote_annotation_revision(
        &self,
        head: &RemoteAnnotationHead,
    ) -> Result<RemoteAnnotationBundle, String> {
        let session = self.session.as_ref().ok_or_else(|| {
            "Sign in to download editable projects; local revisions remain safe.".to_string()
        })?;
        validate_remote_head(session, head)?;
        let response = self.client.execute_bounded(
            HttpRequest {
                method: "POST",
                url: format!(
                    "{}/rest/v1/rpc/fetch_annotation_project_revision",
                    session.supabase_url
                ),
                headers: bearer_headers(session, "application/json"),
                body: serde_json::to_vec(&json!({
                    "p_screenshot_id": head.capture_id,
                    "p_revision": head.cloud_revision,
                    "p_device_id": session.device_id,
                    "p_device_token": session.device_token,
                }))
                .expect("editable project fetch is serializable"),
            },
            MAX_ANNOTATION_PROJECT_BYTES as usize + MAX_RESPONSE_BYTES,
        )?;
        if !(200..300).contains(&response.status) {
            return Err(safe_message(
                &response,
                "Capso could not fetch the remote editable project",
            ));
        }
        let revision: RemoteAnnotationRevisionResponse = serde_json::from_slice(&response.body)
            .map_err(|_| "Capso received an invalid remote editable project.".to_string())?;
        if revision.head() != *head {
            return Err("The remote editable project changed while Capso downloaded it.".into());
        }
        let document = serde_json::to_vec(&revision.document)
            .map_err(|_| "Capso could not preserve the remote editable document.".to_string())?;
        if document.len() as u64 > MAX_ANNOTATION_PROJECT_BYTES {
            return Err("The remote editable project exceeded Capso's safety limit.".into());
        }
        let decoded = annotation_project::decode_for_sync(&document)?;
        if decoded.capture_id != head.capture_id
            || decoded.revision != head.document_revision
            || decoded.original_sha256 != head.original_sha256
            || decoded.flattened_sha256 != head.flattened_sha256
        {
            return Err("The remote editable document does not match its cloud head.".into());
        }
        let download = |storage_path: &str| -> Result<Vec<u8>, String> {
            let object_name = storage_path
                .strip_prefix("annotation-assets/")
                .ok_or_else(|| "The remote editable asset path is invalid.".to_string())?;
            let response = self.client.execute_bounded(
                HttpRequest {
                    method: "GET",
                    url: format!(
                        "{}/storage/v1/object/annotation-assets/{}",
                        session.supabase_url, object_name
                    ),
                    headers: bearer_headers(session, "application/octet-stream"),
                    body: Vec::new(),
                },
                MAX_ORIGINAL_BYTES as usize,
            )?;
            if !(200..300).contains(&response.status) {
                return Err(safe_message(
                    &response,
                    "Capso could not download a private editable project asset",
                ));
            }
            if response.body.is_empty() {
                return Err("A remote editable project asset was empty.".into());
            }
            Ok(response.body)
        };
        let original = download(&head.original_storage_path)?;
        let flattened = download(&head.flattened_storage_path)?;
        if format!("sha256:{:x}", Sha256::digest(&original)) != head.original_sha256
            || format!("sha256:{:x}", Sha256::digest(&flattened)) != head.flattened_sha256
        {
            return Err("A remote editable project asset failed its protected hash.".into());
        }
        Ok(RemoteAnnotationBundle {
            head: head.clone(),
            document,
            original,
            flattened,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        thumbnail_png, AuthenticatedUploadTransport, HttpClient, HttpRequest, HttpResponse,
        UploadSession,
    };
    use crate::{
        annotation_sync::{
            AnnotationCloudTransport, AnnotationProjectUploadResult, AnnotationSyncClaim,
            AnnotationSyncTransport,
        },
        auth::{AuthSession, SupabaseAuthConfig},
        capture_mirror::{CaptureCloudTransport, RemoteCaptureSource},
        device::MacDeviceCredential,
        drain::{TransportAvailability, UploadResult, UploadTransport},
        queue::{QueueItem, QueueItemStatus, QueueSource},
    };
    use sha2::{Digest, Sha256};
    use std::{fs, sync::Mutex};

    const USER_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";
    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";
    const DEVICE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92271";
    const MUTATION_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92272";
    const DEVICE_TOKEN: &str = "m_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[derive(Debug, Default)]
    struct RecordingClient {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<Vec<HttpResponse>>,
        bounded_limits: Mutex<Vec<usize>>,
    }

    impl RecordingClient {
        fn with_responses(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().rev().collect()),
                ..Self::default()
            }
        }
    }

    impl HttpClient for RecordingClient {
        fn execute(&self, request: HttpRequest) -> Result<HttpResponse, String> {
            self.requests.lock().expect("request lock").push(request);
            self.responses
                .lock()
                .expect("response lock")
                .pop()
                .ok_or_else(|| "missing scripted response".into())
        }

        fn execute_bounded(
            &self,
            request: HttpRequest,
            max_response_bytes: usize,
        ) -> Result<HttpResponse, String> {
            self.bounded_limits
                .lock()
                .expect("bounded limits lock")
                .push(max_response_bytes);
            let response = self.execute(request)?;
            if response.body.len() > max_response_bytes {
                Err("Capso's private library response exceeded its safety limit.".into())
            } else {
                Ok(response)
            }
        }
    }

    fn response(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            body: body.as_bytes().to_vec(),
        }
    }

    fn session() -> UploadSession {
        UploadSession {
            supabase_url: "https://capso-test.supabase.co".into(),
            publishable_key: "sb_publishable_capso_test".into(),
            access_token: "header.payload.signature".into(),
            user_id: USER_ID.into(),
            device_id: DEVICE_ID.into(),
            device_token: DEVICE_TOKEN.into(),
        }
    }

    fn device() -> MacDeviceCredential {
        MacDeviceCredential::for_test(DEVICE_ID, USER_ID, DEVICE_TOKEN)
    }

    fn capture_item() -> (tempfile::TempDir, QueueItem) {
        let root = tempfile::tempdir().expect("temp capture root");
        let path = root.path().join(format!("{CAPTURE_ID}.png"));
        let image = image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]));
        image.save(&path).expect("write png fixture");
        (
            root,
            QueueItem {
                id: CAPTURE_ID.into(),
                file_path: path,
                created_at_ms: 1_723_076_880_000,
                source: QueueSource::Fullscreen,
                status: QueueItemStatus::Uploading,
                attempts: 1,
                next_attempt_at_ms: None,
                last_error: None,
                annotated: true,
                project_id: None,
                uploaded_at_ms: None,
                remote_content_hash: None,
                remote_local_hash: None,
            },
        )
    }

    fn annotation_claim() -> (tempfile::TempDir, AnnotationSyncClaim, Vec<u8>, Vec<u8>) {
        let root = tempfile::tempdir().expect("annotation sync root");
        let project_path = root.path().join(format!("{CAPTURE_ID}.json"));
        let flattened_path = root.path().join(format!("{CAPTURE_ID}.png"));
        let original_path = root.path().join("original.png");
        let original_image = image::RgbaImage::from_pixel(12, 8, image::Rgba([12, 34, 56, 255]));
        let flattened_image = image::RgbaImage::from_pixel(12, 8, image::Rgba([90, 80, 70, 255]));
        original_image.save(&original_path).expect("original png");
        flattened_image
            .save(&flattened_path)
            .expect("flattened png");
        let original = fs::read(&original_path).expect("read original");
        let flattened = fs::read(&flattened_path).expect("read flattened");
        let original_sha256 = format!("sha256:{:x}", Sha256::digest(&original));
        let flattened_sha256 = format!("sha256:{:x}", Sha256::digest(&flattened));
        fs::write(
            &project_path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "captureId": CAPTURE_ID,
                "revision": 2,
                "width": 12,
                "height": 8,
                "originalSha256": original_sha256,
                "flattenedSha256": flattened_sha256,
                "savedAtMs": 1_723_076_880_000_u64,
                "marks": [{
                    "kind": "line", "color": "#b03a48",
                    "x1": 0, "y1": 0, "x2": 10, "y2": 7
                }]
            }))
            .expect("project json"),
        )
        .expect("write project");
        (
            root,
            AnnotationSyncClaim {
                capture_id: CAPTURE_ID.into(),
                document_revision: 2,
                mutation_id: MUTATION_ID.into(),
                project_path,
                flattened_path,
                original_path,
                original_sha256,
                flattened_sha256,
                base_cloud_revision: 4,
            },
            original,
            flattened,
        )
    }

    #[test]
    fn missing_session_holds_without_touching_the_network() {
        let client = RecordingClient::default();
        let transport = AuthenticatedUploadTransport::new(client, None);

        assert!(matches!(
            transport.availability(),
            TransportAvailability::Held {
                code: "sign_in_required",
                ..
            }
        ));
    }

    #[test]
    fn fresh_auth_session_becomes_upload_credentials_but_expiring_session_does_not() {
        let config = SupabaseAuthConfig {
            url: "https://capso-test.supabase.co".into(),
            publishable_key: "sb_publishable_capso_test".into(),
        };
        let session = AuthSession::for_test(
            "header.payload.signature",
            "refresh_0123456789abcdef",
            USER_ID,
            120_001,
        );
        let upload = UploadSession::from_auth(&config, &session, &device(), 60_000)
            .expect("fresh access token and device");
        assert_eq!(upload.supabase_url, config.url);
        assert_eq!(upload.publishable_key, config.publishable_key);
        assert_eq!(upload.access_token, "header.payload.signature");
        assert_eq!(upload.user_id, USER_ID);
        assert_eq!(upload.device_id, DEVICE_ID);
        assert_eq!(upload.device_token, DEVICE_TOKEN);

        assert!(UploadSession::from_auth(&config, &session, &device(), 60_001).is_none());
    }

    #[test]
    fn upload_debug_output_never_contains_account_or_device_secrets() {
        let output = format!("{:?}", session());
        assert!(!output.contains("header.payload.signature"));
        assert!(!output.contains(DEVICE_TOKEN));
        assert!(output.contains(DEVICE_ID));
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn exact_png_is_stored_then_atomically_registered_for_background_processing() {
        let client = RecordingClient::with_responses(vec![
            response(200, "{}"),
            response(200, "{}"),
            response(
                200,
                &format!(
                    r#"{{"screenshot_id":"{CAPTURE_ID}","status":"processing","deduped":false}}"#,
                ),
            ),
        ]);
        let transport = AuthenticatedUploadTransport::new(client, Some(session()));
        let (_root, mut item) = capture_item();
        item.project_id = Some("018f22c4-cada-7c6b-9d5b-fc35f7f92276".into());
        let expected_png = fs::read(&item.file_path).expect("read expected png");

        assert_eq!(
            transport.upload(&item),
            UploadResult::Confirmed(crate::drain::UploadAcknowledgement {
                capture_id: CAPTURE_ID.into(),
            })
        );

        let requests = transport.client().requests.lock().expect("request lock");
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(
            requests[0].url,
            format!(
                "https://capso-test.supabase.co/storage/v1/object/originals/{USER_ID}/{CAPTURE_ID}.png"
            )
        );
        assert_eq!(requests[0].body, expected_png);
        assert_eq!(
            requests[0].headers.get("authorization").map(String::as_str),
            Some("Bearer header.payload.signature")
        );
        assert_eq!(
            requests[1].url,
            format!(
                "https://capso-test.supabase.co/storage/v1/object/thumbs/{USER_ID}/{CAPTURE_ID}.png"
            )
        );
        let thumb = image::load_from_memory(&requests[1].body).expect("valid thumbnail png");
        assert_eq!((thumb.width(), thumb.height()), (2, 3));
        assert_eq!(
            requests[2].url,
            "https://capso-test.supabase.co/rest/v1/rpc/ingest_native_capture"
        );
        let metadata: serde_json::Value =
            serde_json::from_slice(&requests[2].body).expect("metadata json");
        assert_eq!(metadata["p_screenshot_id"], CAPTURE_ID);
        assert_eq!(
            metadata["p_storage_path"],
            format!("originals/{USER_ID}/{CAPTURE_ID}.png")
        );
        assert_eq!(
            metadata["p_thumb_path"],
            format!("thumbs/{USER_ID}/{CAPTURE_ID}.png")
        );
        assert_eq!(metadata["p_width"], 2);
        assert_eq!(metadata["p_height"], 3);
        assert_eq!(metadata["p_annotated"], true);
        assert_eq!(metadata["p_device_id"], DEVICE_ID);
        assert_eq!(metadata["p_device_token"], DEVICE_TOKEN);
        assert_eq!(
            metadata["p_project_id"],
            "018f22c4-cada-7c6b-9d5b-fc35f7f92276"
        );
        assert!(metadata["p_content_hash"]
            .as_str()
            .expect("hash")
            .starts_with("sha256:"));
    }

    #[test]
    fn exact_editable_project_assets_commit_one_conflict_checked_cloud_revision() {
        let client = RecordingClient::with_responses(vec![
            response(200, "{}"),
            response(200, "{}"),
            response(
                200,
                &format!(
                    r#"{{"status":"committed","screenshot_id":"{CAPTURE_ID}","cloud_revision":5,"document_revision":2,"mutation_id":"{MUTATION_ID}","deduped":false}}"#,
                ),
            ),
        ]);
        let transport = AuthenticatedUploadTransport::new(client, Some(session()));
        let (_root, claim, original, flattened) = annotation_claim();

        assert_eq!(
            transport.upload_annotation_project(&claim),
            AnnotationProjectUploadResult::Confirmed {
                capture_id: CAPTURE_ID.into(),
                mutation_id: MUTATION_ID.into(),
                cloud_revision: 5,
            }
        );

        let requests = transport.client().requests.lock().expect("request lock");
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[0].url,
            format!("https://capso-test.supabase.co/storage/v1/object/annotation-assets/{USER_ID}/{CAPTURE_ID}/original.png")
        );
        assert_eq!(requests[0].body, original);
        assert_eq!(
            requests[0].headers.get("x-upsert").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            requests[1].url,
            format!("https://capso-test.supabase.co/storage/v1/object/annotation-assets/{USER_ID}/{CAPTURE_ID}/revisions/{MUTATION_ID}.png")
        );
        assert_eq!(requests[1].body, flattened);
        assert_eq!(
            requests[2].url,
            "https://capso-test.supabase.co/rest/v1/rpc/commit_annotation_project_revision"
        );
        let body: serde_json::Value =
            serde_json::from_slice(&requests[2].body).expect("commit body");
        assert_eq!(body["p_screenshot_id"], CAPTURE_ID);
        assert_eq!(body["p_base_cloud_revision"], 4);
        assert_eq!(body["p_document_revision"], 2);
        assert_eq!(body["p_mutation_id"], MUTATION_ID);
        assert_eq!(body["p_device_id"], DEVICE_ID);
        assert_eq!(body["p_device_token"], DEVICE_TOKEN);
        assert_eq!(body["p_document"]["revision"], 2);
    }

    #[test]
    fn cross_mac_discovery_and_download_bind_the_exact_head_document_and_private_assets() {
        let (_root, claim, original, flattened) = annotation_claim();
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&claim.project_path).expect("project fixture"))
                .expect("project json");
        let original_path = format!("annotation-assets/{USER_ID}/{CAPTURE_ID}/original.png");
        let flattened_path =
            format!("annotation-assets/{USER_ID}/{CAPTURE_ID}/revisions/{MUTATION_ID}.png");
        let head = serde_json::json!({
            "screenshot_id": CAPTURE_ID,
            "cloud_revision": 5,
            "document_revision": 2,
            "mutation_id": MUTATION_ID,
            "original_storage_path": original_path,
            "flattened_storage_path": flattened_path,
            "original_sha256": claim.original_sha256,
            "flattened_sha256": claim.flattened_sha256,
            "created_at": "2026-08-13T01:02:03.000Z"
        });
        let revision = serde_json::json!({
            "screenshot_id": CAPTURE_ID,
            "cloud_revision": 5,
            "document_revision": 2,
            "mutation_id": MUTATION_ID,
            "original_storage_path": original_path,
            "flattened_storage_path": flattened_path,
            "original_sha256": claim.original_sha256,
            "flattened_sha256": claim.flattened_sha256,
            "document": document,
        });
        let client = RecordingClient::with_responses(vec![
            response(200, &serde_json::to_string(&vec![head]).unwrap()),
            response(200, &revision.to_string()),
            HttpResponse {
                status: 200,
                body: original.clone(),
            },
            HttpResponse {
                status: 200,
                body: flattened.clone(),
            },
        ]);
        let transport = AuthenticatedUploadTransport::new(client, Some(session()));

        let heads = transport
            .list_remote_annotation_heads()
            .expect("list heads");
        assert_eq!(heads.len(), 1);
        assert_eq!(heads[0].capture_id, CAPTURE_ID);
        assert_eq!(heads[0].cloud_revision, 5);
        let bundle = transport
            .download_remote_annotation_revision(&heads[0])
            .expect("download exact head");
        assert_eq!(bundle.head, heads[0]);
        assert_eq!(bundle.original, original);
        assert_eq!(bundle.flattened, flattened);
        assert_eq!(bundle.document, serde_json::to_vec(&document).unwrap());

        let requests = transport.client().requests.lock().expect("requests");
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests[0].url,
            "https://capso-test.supabase.co/rest/v1/rpc/list_annotation_project_heads"
        );
        let list_body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(list_body["p_device_id"], DEVICE_ID);
        assert_eq!(list_body["p_device_token"], DEVICE_TOKEN);
        assert_eq!(
            requests[1].url,
            "https://capso-test.supabase.co/rest/v1/rpc/fetch_annotation_project_revision"
        );
        let fetch_body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(fetch_body["p_screenshot_id"], CAPTURE_ID);
        assert_eq!(fetch_body["p_revision"], 5);
        assert_eq!(requests[2].method, "GET");
        assert_eq!(
            requests[2].url,
            format!("https://capso-test.supabase.co/storage/v1/object/annotation-assets/{USER_ID}/{CAPTURE_ID}/original.png")
        );
        assert_eq!(requests[3].method, "GET");
        assert_eq!(
            requests[3].url,
            format!("https://capso-test.supabase.co/storage/v1/object/annotation-assets/{USER_ID}/{CAPTURE_ID}/revisions/{MUTATION_ID}.png")
        );
    }

    #[test]
    fn screenshot_mirror_lists_and_downloads_one_exact_private_extension_capture() {
        let image = image::RgbaImage::from_pixel(2, 3, image::Rgba([17, 34, 51, 255]));
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, image::ImageFormat::Jpeg)
            .expect("encode remote JPEG");
        let pixels = encoded.into_inner();
        let content_hash = format!("sha256:{:x}", Sha256::digest(&pixels));
        let storage_path = format!("originals/{USER_ID}/{CAPTURE_ID}.jpg");
        let head = serde_json::json!({
            "screenshot_id": CAPTURE_ID,
            "captured_at": "2026-08-14T03:04:05.006Z",
            "storage_path": storage_path,
            "content_hash": content_hash,
            "source": "extension",
            "width": 2,
            "height": 3,
            "bytes": pixels.len(),
            "project_thread_id": null,
            "processing_status": "processed"
        });
        let client = RecordingClient::with_responses(vec![
            response(200, &serde_json::to_string(&vec![head]).expect("head JSON")),
            HttpResponse {
                status: 200,
                body: pixels.clone(),
            },
        ]);
        let transport = AuthenticatedUploadTransport::new(client, Some(session()));

        let heads = transport
            .list_remote_capture_heads()
            .expect("list remote screenshots");
        assert_eq!(heads.len(), 1);
        assert_eq!(heads[0].capture_id, CAPTURE_ID);
        assert_eq!(heads[0].source, RemoteCaptureSource::Browser);
        assert_eq!(
            transport
                .download_remote_capture(&heads[0])
                .expect("download exact screenshot"),
            pixels,
        );

        let requests = transport.client().requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].url,
            "https://capso-test.supabase.co/rest/v1/rpc/list_mac_screenshot_heads"
        );
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).expect("list body");
        assert_eq!(body["p_device_id"], DEVICE_ID);
        assert_eq!(body["p_device_token"], DEVICE_TOKEN);
        assert!(!requests[0].url.contains(DEVICE_TOKEN));
        assert!(!requests[0].url.contains("header.payload.signature"));
        assert_eq!(requests[1].method, "GET");
        assert_eq!(
            requests[1].url,
            format!(
                "https://capso-test.supabase.co/storage/v1/object/originals/{USER_ID}/{CAPTURE_ID}.jpg"
            )
        );
        drop(requests);
        assert_eq!(
            *transport
                .client()
                .bounded_limits
                .lock()
                .expect("bounded limits"),
            vec![512 * 1_024, 25 * 1_024 * 1_024],
        );
    }

    #[test]
    fn a_tampered_mark_document_fails_closed_before_any_annotation_network_request() {
        let transport =
            AuthenticatedUploadTransport::new(RecordingClient::default(), Some(session()));
        let (_root, claim, _original, _flattened) = annotation_claim();
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(&claim.project_path).expect("project fixture"))
                .expect("project json");
        document["marks"][0]["color"] = serde_json::Value::String(String::new());
        fs::write(
            &claim.project_path,
            serde_json::to_vec(&document).expect("tampered project"),
        )
        .expect("write tampered project");

        assert!(matches!(
            transport.upload_annotation_project(&claim),
            AnnotationProjectUploadResult::Terminal { .. }
        ));
        assert!(transport
            .client()
            .requests
            .lock()
            .expect("request lock")
            .is_empty());
    }

    #[test]
    fn a_stale_cloud_base_becomes_an_explicit_remote_revision_conflict() {
        let client = RecordingClient::with_responses(vec![
            response(409, r#"{"message":"exists"}"#),
            response(409, r#"{"message":"exists"}"#),
            response(
                200,
                &format!(
                    r#"{{"status":"conflict","screenshot_id":"{CAPTURE_ID}","cloud_revision":9,"document_revision":2,"mutation_id":"{MUTATION_ID}","deduped":false}}"#,
                ),
            ),
        ]);
        let transport = AuthenticatedUploadTransport::new(client, Some(session()));
        let (_root, claim, _original, _flattened) = annotation_claim();

        assert_eq!(
            transport.upload_annotation_project(&claim),
            AnnotationProjectUploadResult::Conflict {
                remote_cloud_revision: 9,
                message:
                    "Another Mac saved a newer editable revision. Your local work is still safe."
                        .into(),
            }
        );
    }

    #[test]
    fn an_existing_exact_object_continues_to_the_idempotent_registration_call() {
        let client = RecordingClient::with_responses(vec![
            response(409, r#"{"message":"The resource already exists"}"#),
            response(409, r#"{"message":"The resource already exists"}"#),
            response(
                200,
                &format!(
                    r#"{{"screenshot_id":"{CAPTURE_ID}","status":"processing","deduped":true}}"#,
                ),
            ),
        ]);
        let transport = AuthenticatedUploadTransport::new(client, Some(session()));
        let (_root, item) = capture_item();

        assert!(matches!(
            transport.upload(&item),
            UploadResult::Confirmed(_)
        ));
        assert_eq!(
            transport
                .client()
                .requests
                .lock()
                .expect("request lock")
                .len(),
            3
        );
    }

    #[test]
    fn legacy_storage_duplicate_code_also_resumes_registration_but_other_400s_do_not() {
        let legacy = AuthenticatedUploadTransport::new(
            RecordingClient::with_responses(vec![
                response(
                    400,
                    r#"{"statusCode":"400","error":"Duplicate","message":"The resource already exists"}"#,
                ),
                response(409, r#"{"message":"The resource already exists"}"#),
                response(
                    200,
                    &format!(
                        r#"{{"screenshot_id":"{CAPTURE_ID}","status":"processing","deduped":true}}"#,
                    ),
                ),
            ]),
            Some(session()),
        );
        let (_root, item) = capture_item();
        assert!(matches!(legacy.upload(&item), UploadResult::Confirmed(_)));

        let invalid = AuthenticatedUploadTransport::new(
            RecordingClient::with_responses(vec![response(
                400,
                r#"{"code":"InvalidMimeType","message":"wrong type"}"#,
            )]),
            Some(session()),
        );
        assert!(matches!(
            invalid.upload(&item),
            UploadResult::Terminal { .. }
        ));
    }

    #[test]
    fn generated_native_thumbnail_is_a_bounded_aspect_preserving_png() {
        let original = image::DynamicImage::new_rgba8(800, 400);
        let mut source = std::io::Cursor::new(Vec::new());
        original
            .write_to(&mut source, image::ImageFormat::Png)
            .expect("encode source png");
        let thumb = thumbnail_png(&source.into_inner(), 800, 400).expect("thumbnail");
        let decoded = image::load_from_memory(&thumb).expect("decode thumbnail");
        assert_eq!((decoded.width(), decoded.height()), (640, 320));
    }

    #[test]
    fn expired_credentials_hold_but_transient_failures_retry() {
        let (_root, item) = capture_item();
        let unauthorized = AuthenticatedUploadTransport::new(
            RecordingClient::with_responses(vec![response(401, r#"{"message":"expired"}"#)]),
            Some(session()),
        );
        assert!(matches!(
            unauthorized.upload(&item),
            UploadResult::Held { .. }
        ));

        let transient = AuthenticatedUploadTransport::new(
            RecordingClient::with_responses(vec![response(503, r#"{"message":"busy"}"#)]),
            Some(session()),
        );
        assert!(matches!(
            transient.upload(&item),
            UploadResult::Retryable { .. }
        ));
    }

    #[test]
    fn oversized_server_rejection_is_terminal_but_quota_exhaustion_remains_held() {
        let (_root, item) = capture_item();
        let oversized = AuthenticatedUploadTransport::new(
            RecordingClient::with_responses(vec![response(413, r#"{"message":"too large"}"#)]),
            Some(session()),
        );
        assert!(matches!(
            oversized.upload(&item),
            UploadResult::Terminal { .. }
        ));

        let quota = AuthenticatedUploadTransport::new(
            RecordingClient::with_responses(vec![response(507, r#"{"message":"quota full"}"#)]),
            Some(session()),
        );
        assert!(matches!(quota.upload(&item), UploadResult::Held { .. }));
    }
}
