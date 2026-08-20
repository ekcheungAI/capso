// AI-01a1 owns the strict cross-language payload before the authenticated HTTP
// adapter exists. No token, user id, or network side effect enters this module.
#![allow(dead_code)]

use serde::{Deserialize, Deserializer, Serialize};
use std::{error::Error, fmt};

const MAX_ORIGINAL_BYTES: u64 = 25 * 1_024 * 1_024;
const MAX_CAPTURE_DIMENSION: u32 = 100_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeIngestSource {
    HotkeyRegion,
    HotkeyWindow,
    HotkeyFullscreen,
    Drag,
    Clipboard,
}

impl NativeIngestSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::HotkeyRegion => "hotkey_region",
            Self::HotkeyWindow => "hotkey_window",
            Self::HotkeyFullscreen => "hotkey_fullscreen",
            Self::Drag => "drag",
            Self::Clipboard => "clipboard",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeIngestRequest {
    pub(crate) screenshot_id: String,
    pub(crate) storage_path: String,
    pub(crate) thumb_path: String,
    pub(crate) captured_at: String,
    pub(crate) source: NativeIngestSource,
    pub(crate) content_hash: String,
    pub(crate) annotated: bool,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bytes: u64,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
}

impl NativeIngestRequest {
    pub(crate) fn validate(&self) -> Result<(), IngestContractError> {
        if !canonical_uuid(&self.screenshot_id) {
            return Err(IngestContractError::new(
                "ingest_id_invalid",
                "The native capture identifier is not a canonical UUID.",
            ));
        }
        if self
            .project_id
            .as_deref()
            .is_some_and(|project_id| !canonical_uuid(project_id))
        {
            return Err(IngestContractError::new(
                "ingest_project_invalid",
                "The native capture project identifier is not a canonical UUID.",
            ));
        }
        let parts = self.storage_path.split('/').collect::<Vec<_>>();
        let thumb_parts = self.thumb_path.split('/').collect::<Vec<_>>();
        if parts.len() != 3
            || parts[0] != "originals"
            || !canonical_uuid(parts[1])
            || parts[2] != format!("{}.png", self.screenshot_id)
        {
            return Err(IngestContractError::new(
                "ingest_path_mismatch",
                "The private Storage path does not name the exact queued capture.",
            ));
        }
        if thumb_parts.len() != 3
            || thumb_parts[0] != "thumbs"
            || !canonical_uuid(thumb_parts[1])
            || thumb_parts[2] != format!("{}.png", self.screenshot_id)
        {
            return Err(IngestContractError::new(
                "ingest_thumb_path_mismatch",
                "The private thumbnail path does not name the exact queued capture.",
            ));
        }
        if !valid_sha256(&self.content_hash) {
            return Err(IngestContractError::new(
                "ingest_hash_invalid",
                "The native ingest hash must be lowercase sha256:<64 hex>.",
            ));
        }
        if self.width == 0
            || self.width > MAX_CAPTURE_DIMENSION
            || self.height == 0
            || self.height > MAX_CAPTURE_DIMENSION
            || self.bytes == 0
            || self.bytes > MAX_ORIGINAL_BYTES
        {
            return Err(IngestContractError::new(
                "ingest_dimensions_invalid",
                "The native ingest dimensions or byte count are outside the capture contract.",
            ));
        }
        if !explicit_offset_timestamp(&self.captured_at) {
            return Err(IngestContractError::new(
                "ingest_timestamp_invalid",
                "The native capture timestamp must include an explicit RFC 3339 offset.",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeIngestStatus {
    Processing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeIngestResponse {
    pub(crate) screenshot_id: String,
    pub(crate) status: NativeIngestStatus,
    pub(crate) deduped: bool,
}

impl NativeIngestResponse {
    pub(crate) fn acknowledge(
        &self,
        expected_capture_id: &str,
    ) -> Result<String, IngestContractError> {
        if self.screenshot_id != expected_capture_id || !canonical_uuid(&self.screenshot_id) {
            return Err(IngestContractError::new(
                "ingest_ack_mismatch",
                "The ingest response did not acknowledge the exact queued capture.",
            ));
        }
        Ok(self.screenshot_id.clone())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeApiErrorCode {
    Unauthorized,
    InvalidRequest,
    NotFound,
    Conflict,
    StorageQuota,
    RateLimited,
    ProviderUnavailable,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeApiError {
    code: NativeApiErrorCode,
    #[serde(deserialize_with = "deserialize_api_error_message")]
    message: String,
    retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeApiErrorEnvelope {
    error: NativeApiError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum IngestFailureDisposition {
    Held,
    Retryable,
    Terminal,
}

impl NativeApiErrorEnvelope {
    pub(crate) fn disposition(&self) -> IngestFailureDisposition {
        match self.error.code {
            NativeApiErrorCode::Unauthorized | NativeApiErrorCode::StorageQuota => {
                IngestFailureDisposition::Held
            }
            _ if self.error.retryable => IngestFailureDisposition::Retryable,
            _ => IngestFailureDisposition::Terminal,
        }
    }

    pub(crate) fn message(&self) -> &str {
        &self.error.message
    }
}

fn deserialize_api_error_message<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let message = String::deserialize(deserializer)?;
    if !(1..=512).contains(&message.encode_utf16().count()) {
        return Err(serde::de::Error::custom(
            "API error message must contain 1 to 512 UTF-16 code units",
        ));
    }
    Ok(message)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct IngestContractError {
    code: &'static str,
    message: String,
}

impl IngestContractError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for IngestContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for IngestContractError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeAuthExchangeFixture {
    code: String,
    code_verifier: String,
    redirect_uri: String,
}

impl NativeAuthExchangeFixture {
    fn validate(&self) -> Result<(), IngestContractError> {
        let valid_token = |value: &str, min: usize, max: usize| {
            (min..=max).contains(&value.len())
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
                })
        };
        if !crate::auth::valid_opaque_code(&self.code)
            || !valid_token(&self.code_verifier, 43, 128)
            || self.redirect_uri != crate::auth::AUTH_CALLBACK_URI
        {
            return Err(IngestContractError::new(
                "auth_exchange_invalid",
                "The shared PKCE exchange fixture does not match the native boundary.",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeContractFixture {
    auth_exchange: NativeAuthExchangeFixture,
    pub(crate) ingest_request: NativeIngestRequest,
    pub(crate) ingest_response: NativeIngestResponse,
    pub(crate) ingest_error: NativeApiErrorEnvelope,
    invalid_boundaries: NativeInvalidBoundariesFixture,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeInvalidBoundariesFixture {
    captured_at: Vec<String>,
    empty_api_error_message: String,
    overlong_api_error_message_length: usize,
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| {
            id.to_string() == value
                && (1..=8).contains(&id.get_version_num())
                && id.get_variant() == uuid::Variant::RFC4122
        })
        .unwrap_or(false)
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn explicit_offset_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
            .iter()
            .any(|index| !bytes[*index].is_ascii_digit())
    {
        return false;
    }
    let two_digits = |start: usize| (bytes[start] - b'0') * 10 + bytes[start + 1] - b'0';
    if two_digits(11) > 23 || two_digits(14) > 59 || two_digits(17) > 59 {
        return false;
    }

    let zone_start = if bytes.last() == Some(&b'Z') {
        bytes.len() - 1
    } else if bytes.len() >= 25 {
        let start = bytes.len() - 6;
        if !matches!(bytes[start], b'+' | b'-')
            || bytes[start + 3] != b':'
            || !bytes[start + 1..start + 3]
                .iter()
                .chain(bytes[start + 4..].iter())
                .all(u8::is_ascii_digit)
        {
            return false;
        }
        start
    } else {
        return false;
    };

    if zone_start != 19
        && (zone_start <= 20
            || bytes[19] != b'.'
            || !bytes[20..zone_start].iter().all(u8::is_ascii_digit))
    {
        return false;
    }

    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{
        IngestFailureDisposition, NativeApiError, NativeApiErrorCode, NativeApiErrorEnvelope,
        NativeContractFixture, NativeIngestRequest, NativeIngestResponse,
    };

    const FIXTURE: &str =
        include_str!("../../../../packages/shared/fixtures/native-authenticated-ingest.json");

    fn fixture() -> NativeContractFixture {
        serde_json::from_str(FIXTURE).expect("shared native contract fixture")
    }

    #[test]
    fn rust_contract_reads_the_same_strict_fixture_as_shared_zod() {
        let fixture = fixture();
        fixture
            .auth_exchange
            .validate()
            .expect("valid shared PKCE exchange");
        fixture
            .ingest_request
            .validate()
            .expect("valid authenticated ingest request");
        assert_eq!(fixture.ingest_request.source.as_str(), "hotkey_fullscreen");
        assert_eq!(
            fixture.ingest_error.disposition(),
            IngestFailureDisposition::Held
        );
        assert_eq!(
            fixture
                .ingest_response
                .acknowledge(&fixture.ingest_request.screenshot_id)
                .expect("exact acknowledgement"),
            fixture.ingest_request.screenshot_id
        );

        for captured_at in &fixture.invalid_boundaries.captured_at {
            let mut request = fixture.ingest_request.clone();
            request.captured_at.clone_from(captured_at);
            assert_eq!(
                request
                    .validate()
                    .expect_err("shared invalid timestamp boundary")
                    .code(),
                "ingest_timestamp_invalid"
            );
        }
        let overlong = "x".repeat(fixture.invalid_boundaries.overlong_api_error_message_length);
        for message in [
            fixture.invalid_boundaries.empty_api_error_message.clone(),
            overlong,
        ] {
            let mut value =
                serde_json::to_value(&fixture.ingest_error).expect("error envelope JSON");
            value["error"]["message"] = serde_json::Value::String(message);
            assert!(
                serde_json::from_value::<NativeApiErrorEnvelope>(value).is_err(),
                "shared invalid API error boundary must fail"
            );
        }
    }

    #[test]
    fn request_rejects_owner_spoofing_mismatched_paths_and_bad_hashes() {
        let contract = fixture();
        let mut value = serde_json::to_value(&contract.ingest_request).expect("request JSON");
        value["user_id"] = serde_json::json!("018f22c4-cada-7c6b-9d5b-fc35f7f92279");
        assert!(serde_json::from_value::<NativeIngestRequest>(value).is_err());

        let mut mismatched = contract.ingest_request.clone();
        mismatched.storage_path = mismatched.storage_path.replace(
            &mismatched.screenshot_id,
            "018f22c4-cada-7c6b-9d5b-fc35f7f92271",
        );
        assert_eq!(
            mismatched
                .validate()
                .expect_err("path identity mismatch")
                .code(),
            "ingest_path_mismatch"
        );

        let mut bad_hash = contract.ingest_request.clone();
        bad_hash.content_hash = "sha256:ABCDEF".into();
        assert_eq!(
            bad_hash.validate().expect_err("bad hash").code(),
            "ingest_hash_invalid"
        );

        let mut bad_project = contract.ingest_request.clone();
        bad_project.project_id = Some("not-a-project".into());
        assert_eq!(
            bad_project
                .validate()
                .expect_err("bad project identifier")
                .code(),
            "ingest_project_invalid"
        );

        let mut bad_timestamp = contract.ingest_request.clone();
        bad_timestamp.captured_at = "2026-99-99T99:99:99+99:99".into();
        assert_eq!(
            bad_timestamp
                .validate()
                .expect_err("invalid RFC 3339 timestamp")
                .code(),
            "ingest_timestamp_invalid"
        );

        let mut oversized = contract.ingest_request.clone();
        oversized.width = 100_001;
        assert_eq!(
            oversized
                .validate()
                .expect_err("oversized dimension")
                .code(),
            "ingest_dimensions_invalid"
        );

        let mut nil_id = contract.ingest_request;
        nil_id.screenshot_id = "00000000-0000-0000-0000-000000000000".into();
        nil_id.storage_path = nil_id.storage_path.replace(
            "018f22c4-cada-7c6b-9d5b-fc35f7f92270",
            "00000000-0000-0000-0000-000000000000",
        );
        assert_eq!(
            nil_id.validate().expect_err("versionless UUID").code(),
            "ingest_id_invalid"
        );
    }

    #[test]
    fn acknowledgement_must_name_the_exact_capture() {
        let fixture = fixture();
        let wrong = NativeIngestResponse {
            screenshot_id: "018f22c4-cada-7c6b-9d5b-fc35f7f92271".into(),
            ..fixture.ingest_response
        };
        assert_eq!(
            wrong
                .acknowledge(&fixture.ingest_request.screenshot_id)
                .expect_err("wrong acknowledgement")
                .code(),
            "ingest_ack_mismatch"
        );
    }

    #[test]
    fn server_error_dispositions_preserve_queue_attempt_semantics() {
        let error = |code, retryable| NativeApiErrorEnvelope {
            error: NativeApiError {
                code,
                message: "contract fixture".into(),
                retryable,
            },
        };
        assert_eq!(
            error(NativeApiErrorCode::Unauthorized, false).disposition(),
            IngestFailureDisposition::Held
        );
        assert_eq!(
            error(NativeApiErrorCode::StorageQuota, false).disposition(),
            IngestFailureDisposition::Held
        );
        assert_eq!(
            error(NativeApiErrorCode::ProviderUnavailable, true).disposition(),
            IngestFailureDisposition::Retryable
        );
        assert_eq!(
            error(NativeApiErrorCode::InvalidRequest, false).disposition(),
            IngestFailureDisposition::Terminal
        );
    }
}
