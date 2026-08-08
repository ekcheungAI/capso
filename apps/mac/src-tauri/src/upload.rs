#![allow(dead_code)]

use crate::{
    drain::{TransportAvailability, UploadAcknowledgement, UploadResult, UploadTransport},
    ingest::{
        IngestFailureDisposition, NativeApiErrorEnvelope, NativeIngestRequest,
        NativeIngestResponse, NativeIngestSource,
    },
    queue::{QueueItem, QueueSource},
};
use image::ImageDecoder;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Cursor, time::Duration};

const MAX_ORIGINAL_BYTES: u64 = 25 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES: usize = 64 * 1_024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct UploadSession {
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    user_id: String,
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
}

#[derive(Debug)]
struct ReqwestHttpClient {
    client: reqwest::blocking::Client,
}

impl ReqwestHttpClient {
    fn new() -> Result<Self, String> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map(|client| Self { client })
            .map_err(|error| format!("Could not prepare Capso's secure upload client: {error}"))
    }
}

impl HttpClient for ReqwestHttpClient {
    fn execute(&self, request: HttpRequest) -> Result<HttpResponse, String> {
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
        let declared = response.content_length();
        if declared.is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
            return Err("Capso's upload response exceeded its safety limit.".into());
        }
        let body = response
            .bytes()
            .map_err(|error| format!("Capso could not read its upload response: {error}"))?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err("Capso's upload response exceeded its safety limit.".into());
        }
        Ok(HttpResponse {
            status,
            body: body.to_vec(),
        })
    }
}

#[derive(Debug)]
struct AuthenticatedUploadTransport<C> {
    client: C,
    session: Option<UploadSession>,
}

impl<C> AuthenticatedUploadTransport<C> {
    fn new(client: C, session: Option<UploadSession>) -> Self {
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
        QueueSource::Recovered => NativeIngestSource::Clipboard,
    }
}

fn safe_message(response: &HttpResponse, fallback: &str) -> String {
    serde_json::from_slice::<NativeApiErrorEnvelope>(&response.body)
        .map(|error| error.message().to_string())
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
        401 | 403 | 413 | 507 => UploadResult::Held { message },
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
        let hash = format!("sha256:{:x}", Sha256::digest(&bytes));
        let request = NativeIngestRequest {
            screenshot_id: item.id.clone(),
            storage_path: storage_path.clone(),
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

        let body = json!({
            "p_screenshot_id": request.screenshot_id,
            "p_storage_path": request.storage_path,
            "p_captured_at": request.captured_at,
            "p_source": request.source.as_str(),
            "p_content_hash": request.content_hash,
            "p_annotated": request.annotated,
            "p_width": request.width,
            "p_height": request.height,
            "p_bytes": request.bytes,
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

#[cfg(test)]
mod tests {
    use super::{
        AuthenticatedUploadTransport, HttpClient, HttpRequest, HttpResponse, UploadSession,
    };
    use crate::{
        drain::{TransportAvailability, UploadResult, UploadTransport},
        queue::{QueueItem, QueueItemStatus, QueueSource},
    };
    use std::{fs, sync::Mutex};

    const USER_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";
    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";

    #[derive(Debug, Default)]
    struct RecordingClient {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<Vec<HttpResponse>>,
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
        }
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
            },
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
    fn exact_png_is_stored_then_atomically_registered_for_background_processing() {
        let client = RecordingClient::with_responses(vec![
            response(200, "{}"),
            response(
                200,
                &format!(
                    r#"{{"screenshot_id":"{CAPTURE_ID}","status":"processing","deduped":false}}"#,
                ),
            ),
        ]);
        let transport = AuthenticatedUploadTransport::new(client, Some(session()));
        let (_root, item) = capture_item();
        let expected_png = fs::read(&item.file_path).expect("read expected png");

        assert_eq!(
            transport.upload(&item),
            UploadResult::Confirmed(crate::drain::UploadAcknowledgement {
                capture_id: CAPTURE_ID.into(),
            })
        );

        let requests = transport.client().requests.lock().expect("request lock");
        assert_eq!(requests.len(), 2);
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
            "https://capso-test.supabase.co/rest/v1/rpc/ingest_native_capture"
        );
        let metadata: serde_json::Value =
            serde_json::from_slice(&requests[1].body).expect("metadata json");
        assert_eq!(metadata["p_screenshot_id"], CAPTURE_ID);
        assert_eq!(
            metadata["p_storage_path"],
            format!("originals/{USER_ID}/{CAPTURE_ID}.png")
        );
        assert_eq!(metadata["p_width"], 2);
        assert_eq!(metadata["p_height"], 3);
        assert_eq!(metadata["p_annotated"], true);
        assert!(metadata["p_content_hash"]
            .as_str()
            .expect("hash")
            .starts_with("sha256:"));
    }

    #[test]
    fn an_existing_exact_object_continues_to_the_idempotent_registration_call() {
        let client = RecordingClient::with_responses(vec![
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
            2
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
}
