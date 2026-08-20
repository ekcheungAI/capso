// A Mac installation gets one owner-scoped, revocable credential. The raw
// secret lives only in Keychain; Postgres receives its SHA-256 fingerprint and
// the ingest RPC verifies the secret again for every capture registration.
#![allow(dead_code)]

use crate::auth::{AuthHttpClient, AuthHttpRequest, AuthSession, SupabaseAuthConfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};

const MAX_STORED_DEVICE_BYTES: usize = 4 * 1_024;
const DEVICE_SERVICE: &str = "Capso Mac Device";
const DEVICE_ACCOUNT: &str = "active-installation";

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MacDeviceCredential {
    id: String,
    user_id: String,
    token: String,
    #[serde(default)]
    registered: bool,
    #[serde(default)]
    registered_app_version: String,
}

impl fmt::Debug for MacDeviceCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MacDeviceCredential")
            .field("id", &self.id)
            .field("user_id", &self.user_id)
            .field("token", &"[REDACTED]")
            .field("registered", &self.registered)
            .field("registered_app_version", &self.registered_app_version)
            .finish()
    }
}

impl MacDeviceCredential {
    fn new(user_id: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: user_id.into(),
            token: format!(
                "m_{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            registered: false,
            registered_app_version: String::new(),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if !canonical_uuid(&self.id)
            || !canonical_uuid(&self.user_id)
            || self.token.len() != 66
            || !self.token.starts_with("m_")
            || !self.token[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Capso's saved Mac identity is invalid; reconnect this Mac.".into());
        }
        Ok(())
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn user_id(&self) -> &str {
        &self.user_id
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    fn token_hash(&self) -> String {
        format!("{:x}", Sha256::digest(self.token.as_bytes()))
    }

    #[cfg(test)]
    pub(crate) fn for_test(id: &str, user_id: &str, token: &str) -> Self {
        Self {
            id: id.into(),
            user_id: user_id.into(),
            token: token.into(),
            registered: true,
            registered_app_version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string() == value && (1..=8).contains(&id.get_version_num()))
        .unwrap_or(false)
}

pub(crate) trait DeviceVault: Send + Sync {
    fn store(&self, bytes: &[u8]) -> Result<(), String>;
    fn load(&self) -> Result<Option<Vec<u8>>, String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Debug)]
pub(crate) struct DeviceRepository<V> {
    vault: V,
}

impl<V> DeviceRepository<V> {
    pub(crate) fn new(vault: V) -> Self {
        Self { vault }
    }
}

impl<V: DeviceVault> DeviceRepository<V> {
    fn save(&self, credential: &MacDeviceCredential) -> Result<(), String> {
        credential.validate()?;
        let bytes = serde_json::to_vec(credential)
            .map_err(|_| "Capso could not encode its Mac identity.".to_string())?;
        if bytes.len() > MAX_STORED_DEVICE_BYTES {
            return Err("Capso's Mac identity exceeded its storage limit.".into());
        }
        self.vault.store(&bytes)
    }

    fn load(&self) -> Result<Option<MacDeviceCredential>, String> {
        let Some(bytes) = self.vault.load()? else {
            return Ok(None);
        };
        if bytes.len() > MAX_STORED_DEVICE_BYTES {
            return Err("Capso's saved Mac identity is invalid; reconnect this Mac.".into());
        }
        let credential = serde_json::from_slice::<MacDeviceCredential>(&bytes).map_err(|_| {
            "Capso's saved Mac identity is invalid; reconnect this Mac.".to_string()
        })?;
        credential.validate()?;
        Ok(Some(credential))
    }

    pub(crate) fn delete(&self) -> Result<(), String> {
        self.vault.delete()
    }
}

#[derive(Debug)]
pub(crate) struct MacDeviceRegistry<C, V> {
    http: C,
    repository: DeviceRepository<V>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MacDeviceRegistration {
    device_id: String,
    registered: bool,
}

impl<C, V> MacDeviceRegistry<C, V> {
    pub(crate) fn new(http: C, repository: DeviceRepository<V>) -> Self {
        Self { http, repository }
    }
}

impl<C: AuthHttpClient, V: DeviceVault> MacDeviceRegistry<C, V> {
    pub(crate) fn ensure(
        &self,
        config: &SupabaseAuthConfig,
        session: &AuthSession,
        now_ms: u64,
    ) -> Result<MacDeviceCredential, String> {
        let access_token = session.usable_access_token(now_ms).ok_or_else(|| {
            "Capso's session must be refreshed before connecting this Mac.".to_string()
        })?;
        let mut credential = match self.repository.load()? {
            Some(saved) if saved.user_id() == session.user_id() => saved,
            _ => {
                let pending = MacDeviceCredential::new(session.user_id());
                // Persist the pending secret first. If the network succeeds and
                // the process stops before the final write, the same RPC retry
                // remains idempotent instead of leaking a second device row.
                self.repository.save(&pending)?;
                pending
            }
        };
        if credential.registered_app_version != env!("CARGO_PKG_VERSION") {
            credential.registered = false;
            self.repository.save(&credential)?;
        }
        if credential.registered {
            return Ok(credential);
        }

        let response = self.http.execute(AuthHttpRequest {
            method: "POST",
            url: format!("{}/rest/v1/rpc/register_mac_device", config.url),
            headers: BTreeMap::from([
                ("apikey".into(), config.publishable_key.clone()),
                ("authorization".into(), format!("Bearer {access_token}")),
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "application/json".into()),
            ]),
            body: serde_json::to_vec(&serde_json::json!({
                "p_device_id": credential.id(),
                "p_token_hash": credential.token_hash(),
                "p_label": "This Mac",
                "p_platform": "macOS",
                "p_app_version": env!("CARGO_PKG_VERSION"),
            }))
            .expect("Mac device registration JSON is serializable"),
        })?;
        if !(200..300).contains(&response.status) {
            return Err(match response.status {
                401 | 403 | 409 => {
                    "This Mac was disconnected from Capso. Reconnect the same account to resume sync."
                        .into()
                }
                _ => {
                    "Capso could not register this Mac; your originals remain saved locally.".into()
                }
            });
        }
        let acknowledgement = serde_json::from_slice::<MacDeviceRegistration>(&response.body)
            .map_err(|_| {
                "Capso received an invalid Mac registration acknowledgement.".to_string()
            })?;
        if !acknowledgement.registered || acknowledgement.device_id != credential.id() {
            return Err("Capso did not acknowledge this exact Mac installation.".into());
        }
        credential.registered = true;
        credential.registered_app_version = env!("CARGO_PKG_VERSION").into();
        self.repository.save(&credential)?;
        Ok(credential)
    }

    pub(crate) fn reset(&self) -> Result<(), String> {
        self.repository.delete()
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct KeychainDeviceVault;

#[cfg(target_os = "macos")]
impl DeviceVault for KeychainDeviceVault {
    fn store(&self, bytes: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(DEVICE_SERVICE, DEVICE_ACCOUNT, bytes)
            .map_err(|error| {
                format!(
                    "Capso could not save its Keychain device identity ({}).",
                    error.code()
                )
            })
    }

    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        match security_framework::passwords::get_generic_password(DEVICE_SERVICE, DEVICE_ACCOUNT) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == security_framework_sys::base::errSecItemNotFound => {
                Ok(None)
            }
            Err(error) => Err(format!(
                "Capso could not read its Keychain device identity ({}).",
                error.code()
            )),
        }
    }

    fn delete(&self) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(DEVICE_SERVICE, DEVICE_ACCOUNT)
        {
            Ok(()) => Ok(()),
            Err(error) if error.code() == security_framework_sys::base::errSecItemNotFound => {
                Ok(())
            }
            Err(error) => Err(format!(
                "Capso could not delete its Keychain device identity ({}).",
                error.code()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DeviceRepository, DeviceVault, MacDeviceRegistry};
    use crate::auth::{
        AuthHttpClient, AuthHttpRequest, AuthHttpResponse, AuthSession, SupabaseAuthConfig,
    };
    use std::sync::{Arc, Mutex};

    const USER_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";

    #[derive(Clone, Debug, Default)]
    struct MemoryVault(Arc<Mutex<Option<Vec<u8>>>>);

    impl DeviceVault for MemoryVault {
        fn store(&self, bytes: &[u8]) -> Result<(), String> {
            *self.0.lock().expect("vault lock") = Some(bytes.to_vec());
            Ok(())
        }

        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().expect("vault lock").clone())
        }

        fn delete(&self) -> Result<(), String> {
            *self.0.lock().expect("vault lock") = None;
            Ok(())
        }
    }

    #[derive(Debug)]
    struct RecordingHttp {
        requests: Mutex<Vec<AuthHttpRequest>>,
        responses: Mutex<Vec<Result<AuthHttpResponse, String>>>,
    }

    impl RecordingHttp {
        fn success() -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                responses: Mutex::new(vec![Ok(AuthHttpResponse {
                    status: 200,
                    body: Vec::new(),
                })]),
            }
        }
    }

    impl AuthHttpClient for RecordingHttp {
        fn execute(&self, request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
            let device_id = serde_json::from_slice::<serde_json::Value>(&request.body)
                .ok()
                .and_then(|body| body.get("p_device_id")?.as_str().map(str::to_string));
            self.requests.lock().expect("request lock").push(request);
            let mut response = self
                .responses
                .lock()
                .expect("response lock")
                .pop()
                .expect("scripted response")?;
            if response.body.is_empty() {
                response.body = serde_json::to_vec(&serde_json::json!({
                    "device_id": device_id.expect("registration id"),
                    "registered": true,
                }))
                .expect("registration acknowledgement");
            }
            Ok(response)
        }
    }

    fn config() -> SupabaseAuthConfig {
        SupabaseAuthConfig {
            url: "https://capso-test.supabase.co".into(),
            publishable_key: "sb_publishable_capso_test".into(),
        }
    }

    fn session() -> AuthSession {
        AuthSession::for_test(
            "header.payload.signature",
            "refresh_0123456789abcdef",
            USER_ID,
            120_001,
        )
    }

    #[test]
    fn registration_persists_only_a_fingerprint_upstream_and_reuses_one_keychain_identity() {
        let vault = MemoryVault::default();
        let registry = MacDeviceRegistry::new(
            RecordingHttp::success(),
            DeviceRepository::new(vault.clone()),
        );
        let credential = registry
            .ensure(&config(), &session(), 60_000)
            .expect("register Mac");
        let second = registry
            .ensure(&config(), &session(), 60_000)
            .expect("reuse Mac");
        assert_eq!(credential, second);

        let requests = registry.http.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].url,
            "https://capso-test.supabase.co/rest/v1/rpc/register_mac_device"
        );
        assert!(!String::from_utf8_lossy(&requests[0].body).contains(credential.token()));
        assert!(String::from_utf8_lossy(&requests[0].body).contains("p_token_hash"));
        assert!(vault.load().expect("load vault").is_some());
    }

    #[test]
    fn a_failed_registration_keeps_the_same_pending_secret_for_an_idempotent_retry() {
        let vault = MemoryVault::default();
        let http = RecordingHttp {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(vec![Err("offline".into()), Err("offline".into())]),
        };
        let registry = MacDeviceRegistry::new(http, DeviceRepository::new(vault.clone()));
        assert!(registry.ensure(&config(), &session(), 60_000).is_err());
        let first = vault.load().expect("load pending").expect("pending bytes");
        assert!(registry.ensure(&config(), &session(), 60_000).is_err());
        let second = vault.load().expect("load pending").expect("pending bytes");
        assert_eq!(first, second);
    }

    #[test]
    fn a_mismatched_registration_acknowledgement_never_activates_the_keychain_identity() {
        let vault = MemoryVault::default();
        let http = RecordingHttp {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(vec![Ok(AuthHttpResponse {
                status: 200,
                body: br#"{"device_id":"018f22c4-cada-7c6b-9d5b-fc35f7f92271","registered":true}"#
                    .to_vec(),
            })]),
        };
        let registry = MacDeviceRegistry::new(http, DeviceRepository::new(vault.clone()));
        assert_eq!(
            registry
                .ensure(&config(), &session(), 60_000)
                .expect_err("wrong device acknowledgement"),
            "Capso did not acknowledge this exact Mac installation."
        );
        let bytes = vault.load().expect("load pending").expect("pending bytes");
        assert!(String::from_utf8_lossy(&bytes).contains(r#""registered":false"#));
    }

    #[test]
    fn reset_removes_the_revoked_installation_without_touching_the_auth_session() {
        let vault = MemoryVault::default();
        let registry = MacDeviceRegistry::new(
            RecordingHttp::success(),
            DeviceRepository::new(vault.clone()),
        );
        registry
            .ensure(&config(), &session(), 60_000)
            .expect("register Mac");
        registry.reset().expect("reset device only");
        assert!(vault.load().expect("load vault").is_none());
    }
}
