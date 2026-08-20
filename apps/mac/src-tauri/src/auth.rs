// Native auth keeps PKCE state, rotating Supabase sessions, and Keychain bytes
// behind strict redacted boundaries. User-facing sign-in delivery remains a
// separate surface from this background runtime.
#![allow(dead_code)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, fmt, io::Read, sync::Mutex, time::Duration};
use url::Url;

pub(crate) const AUTH_CALLBACK_URI: &str = "capso://auth/callback";
pub(crate) const HANDOFF_TTL_MS: u64 = 5 * 60 * 1_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthStart {
    pub(crate) state: String,
    pub(crate) code_challenge: String,
    pub(crate) code_challenge_method: &'static str,
    pub(crate) redirect_uri: &'static str,
}

struct PendingAuth {
    state: String,
    code_verifier: String,
    started_at_ms: u64,
}

impl fmt::Debug for PendingAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingAuth")
            .field("state", &"[REDACTED]")
            .field("code_verifier", &"[REDACTED]")
            .field("started_at_ms", &self.started_at_ms)
            .finish()
    }
}

#[derive(Default)]
pub(crate) struct AuthRuntime {
    pending: Option<PendingAuth>,
}

impl fmt::Debug for AuthRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthRuntime")
            .field("handoff_pending", &self.pending.is_some())
            .finish()
    }
}

pub(crate) struct AuthCodeExchange {
    code: String,
    code_verifier: String,
}

impl AuthCodeExchange {
    pub(crate) fn code(&self) -> &str {
        &self.code
    }

    pub(crate) fn code_verifier(&self) -> &str {
        &self.code_verifier
    }

    pub(crate) fn redirect_uri(&self) -> &'static str {
        AUTH_CALLBACK_URI
    }
}

impl fmt::Debug for AuthCodeExchange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthCodeExchange")
            .field("code", &"[REDACTED]")
            .field("code_verifier", &"[REDACTED]")
            .field("redirect_uri", &AUTH_CALLBACK_URI)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthContractError {
    code: &'static str,
    message: String,
}

impl AuthContractError {
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

impl fmt::Display for AuthContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AuthContractError {}

const MAX_AUTH_RESPONSE_BYTES: usize = 64 * 1_024;
const MAX_STORED_SESSION_BYTES: usize = 32 * 1_024;
const ACCESS_TOKEN_REFRESH_SKEW_MS: u64 = 60_000;
const MAX_TOKEN_BYTES: usize = 16 * 1_024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SupabaseAuthConfig {
    pub(crate) url: String,
    pub(crate) publishable_key: String,
}

impl SupabaseAuthConfig {
    fn validate(mut self) -> Result<Self, AuthContractError> {
        let parsed = Url::parse(&self.url).map_err(|_| {
            AuthContractError::new(
                "auth_config_invalid",
                "Capso's Supabase URL is not a valid secure origin.",
            )
        })?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !matches!(parsed.path(), "" | "/")
            || !(8..=1_024).contains(&self.publishable_key.len())
            || !self
                .publishable_key
                .bytes()
                .all(|byte| (b'!'..=b'~').contains(&byte))
        {
            return Err(AuthContractError::new(
                "auth_config_invalid",
                "Capso's public Supabase configuration is incomplete or unsafe.",
            ));
        }
        self.url = self.url.trim_end_matches('/').into();
        Ok(self)
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AuthSession {
    access_token: String,
    refresh_token: String,
    user_id: String,
    #[serde(default)]
    email: Option<String>,
    expires_at_ms: u64,
}

impl fmt::Debug for AuthSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthSession")
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("user_id", &self.user_id)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl AuthSession {
    fn validate(&self) -> Result<(), AuthContractError> {
        if !valid_secret_token(&self.access_token)
            || !valid_secret_token(&self.refresh_token)
            || !canonical_uuid(&self.user_id)
            || self
                .email
                .as_deref()
                .is_some_and(|email| normalize_email(email).as_deref() != Ok(email))
            || self.expires_at_ms == 0
        {
            return Err(AuthContractError::new(
                "auth_session_invalid",
                "Supabase returned an invalid session; Capso did not save it.",
            ));
        }
        Ok(())
    }

    pub(crate) fn user_id(&self) -> &str {
        &self.user_id
    }

    pub(crate) fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    pub(crate) fn usable_access_token(&self, now_ms: u64) -> Option<&str> {
        (self.expires_at_ms.saturating_sub(now_ms) > ACCESS_TOKEN_REFRESH_SKEW_MS)
            .then_some(self.access_token.as_str())
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        access_token: &str,
        refresh_token: &str,
        user_id: &str,
        expires_at_ms: u64,
    ) -> Self {
        Self {
            access_token: access_token.into(),
            refresh_token: refresh_token.into(),
            user_id: user_id.into(),
            email: None,
            expires_at_ms,
        }
    }
}

fn valid_secret_token(value: &str) -> bool {
    (8..=MAX_TOKEN_BYTES).contains(&value.len())
        && value.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string() == value && (1..=8).contains(&id.get_version_num()))
        .unwrap_or(false)
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AuthHttpRequest {
    pub(crate) method: &'static str,
    pub(crate) url: String,
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) body: Vec<u8>,
}

impl fmt::Debug for AuthHttpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let redacted_url: String = Url::parse(&self.url)
            .map(|mut url| {
                if url.query().is_some() {
                    url.set_query(Some("[REDACTED]"));
                }
                url.into()
            })
            .unwrap_or_else(|_| "[INVALID URL]".into());
        formatter
            .debug_struct("AuthHttpRequest")
            .field("method", &self.method)
            .field("url", &redacted_url)
            .field("header_names", &self.headers.keys().collect::<Vec<_>>())
            .field("body", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AuthHttpResponse {
    pub(crate) status: u16,
    pub(crate) body: Vec<u8>,
}

impl fmt::Debug for AuthHttpResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthHttpResponse")
            .field("status", &self.status)
            .field("body", &"[REDACTED]")
            .finish()
    }
}

pub(crate) trait AuthHttpClient: Send + Sync {
    fn execute(&self, request: AuthHttpRequest) -> Result<AuthHttpResponse, String>;
}

#[derive(Debug)]
pub(crate) struct ReqwestAuthHttpClient {
    client: reqwest::blocking::Client,
}

impl ReqwestAuthHttpClient {
    pub(crate) fn new() -> Result<Self, AuthContractError> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map(|client| Self { client })
            .map_err(|_| {
                AuthContractError::new(
                    "auth_client_unavailable",
                    "Capso could not prepare its secure sign-in connection.",
                )
            })
    }
}

impl AuthHttpClient for ReqwestAuthHttpClient {
    fn execute(&self, request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "Capso prepared an invalid sign-in request.".to_string())?;
        let mut builder = self.client.request(method, request.url);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        let response = builder
            .body(request.body)
            .send()
            .map_err(|_| "Capso could not reach Supabase Auth.".to_string())?;
        let status = response.status().as_u16();
        if response
            .content_length()
            .is_some_and(|length| length > MAX_AUTH_RESPONSE_BYTES as u64)
        {
            return Err("Supabase Auth returned an oversized response.".into());
        }
        let body = read_bounded(response, MAX_AUTH_RESPONSE_BYTES)?;
        Ok(AuthHttpResponse { status, body })
    }
}

fn read_bounded(reader: impl Read, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1_024));
    reader
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Capso could not read the Supabase Auth response.".to_string())?;
    if bytes.len() > max_bytes {
        return Err("Supabase Auth returned an oversized response.".into());
    }
    Ok(bytes)
}

#[derive(Deserialize)]
struct TokenUser {
    id: String,
    email: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: u64,
    user: TokenUser,
}

#[derive(Debug)]
pub(crate) struct SupabaseAuthClient<C> {
    config: SupabaseAuthConfig,
    http: C,
}

impl<C> SupabaseAuthClient<C> {
    pub(crate) fn new(config: SupabaseAuthConfig, http: C) -> Result<Self, AuthContractError> {
        Ok(Self {
            config: config.validate()?,
            http,
        })
    }

    #[cfg(test)]
    fn http(&self) -> &C {
        &self.http
    }
}

impl<C: AuthHttpClient> SupabaseAuthClient<C> {
    fn request_email_link(
        &self,
        email: &str,
        start: &AuthStart,
        confirmation_origin: &Url,
    ) -> Result<(), AuthContractError> {
        let mut confirmation = confirmation_origin.clone();
        confirmation.set_path("/auth/open-capso");
        confirmation
            .query_pairs_mut()
            .append_pair("state", &start.state);

        let mut endpoint = Url::parse(&format!("{}/auth/v1/otp", self.config.url))
            .expect("validated Supabase origin joins an auth endpoint");
        endpoint
            .query_pairs_mut()
            .append_pair("redirect_to", confirmation.as_str());
        let response = self
            .http
            .execute(AuthHttpRequest {
                method: "POST",
                url: endpoint.into(),
                headers: BTreeMap::from([
                    ("apikey".into(), self.config.publishable_key.clone()),
                    ("content-type".into(), "application/json".into()),
                    ("accept".into(), "application/json".into()),
                ]),
                body: serde_json::to_vec(&serde_json::json!({
                    "email": email,
                    "create_user": true,
                    "code_challenge": start.code_challenge,
                    "code_challenge_method": start.code_challenge_method,
                }))
                .expect("email auth request JSON is serializable"),
            })
            .map_err(|_| {
                AuthContractError::new(
                    "auth_network_failed",
                    "Capso could not request the sign-in email; try again when online.",
                )
            })?;
        if !(200..300).contains(&response.status) {
            return Err(AuthContractError::new(
                "auth_email_rejected",
                "Supabase could not send that sign-in email; check the address and try again.",
            ));
        }
        Ok(())
    }

    pub(crate) fn exchange(
        &self,
        exchange: &AuthCodeExchange,
        now_ms: u64,
    ) -> Result<AuthSession, AuthContractError> {
        self.token_request(
            "pkce",
            serde_json::json!({
                "auth_code": exchange.code(),
                "code_verifier": exchange.code_verifier(),
            }),
            now_ms,
            None,
        )
    }

    pub(crate) fn refresh(
        &self,
        session: &AuthSession,
        now_ms: u64,
    ) -> Result<AuthSession, AuthContractError> {
        self.token_request(
            "refresh_token",
            serde_json::json!({ "refresh_token": session.refresh_token }),
            now_ms,
            Some(session.user_id()),
        )
    }

    fn token_request(
        &self,
        grant: &'static str,
        body: serde_json::Value,
        now_ms: u64,
        expected_user: Option<&str>,
    ) -> Result<AuthSession, AuthContractError> {
        let response = self
            .http
            .execute(AuthHttpRequest {
                method: "POST",
                url: format!("{}/auth/v1/token?grant_type={grant}", self.config.url),
                headers: BTreeMap::from([
                    ("apikey".into(), self.config.publishable_key.clone()),
                    ("content-type".into(), "application/json".into()),
                    ("accept".into(), "application/json".into()),
                ]),
                body: serde_json::to_vec(&body).expect("auth request JSON is serializable"),
            })
            .map_err(|_| {
                AuthContractError::new(
                    "auth_network_failed",
                    "Capso could not reach Supabase Auth; try again when online.",
                )
            })?;
        if !(200..300).contains(&response.status) {
            return Err(AuthContractError::new(
                "auth_exchange_rejected",
                "Supabase rejected the sign-in exchange; start sign-in again.",
            ));
        }
        let token = serde_json::from_slice::<TokenResponse>(&response.body).map_err(|_| {
            AuthContractError::new(
                "auth_response_invalid",
                "Supabase returned an invalid session; Capso did not save it.",
            )
        })?;
        if !token.token_type.eq_ignore_ascii_case("bearer")
            || !(1..=7 * 24 * 60 * 60).contains(&token.expires_in)
        {
            return Err(AuthContractError::new(
                "auth_response_invalid",
                "Supabase returned an invalid session; Capso did not save it.",
            ));
        }
        let session = AuthSession {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            user_id: token.user.id,
            email: token.user.email,
            expires_at_ms: now_ms.saturating_add(token.expires_in.saturating_mul(1_000)),
        };
        session.validate()?;
        if expected_user.is_some_and(|expected| expected != session.user_id()) {
            return Err(AuthContractError::new(
                "auth_user_changed",
                "Supabase refreshed a different account; Capso kept the existing library locked.",
            ));
        }
        Ok(session)
    }
}

pub(crate) trait SessionVault: Send + Sync {
    fn store(&self, bytes: &[u8]) -> Result<(), String>;
    fn load(&self) -> Result<Option<Vec<u8>>, String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Debug)]
pub(crate) struct SessionRepository<V> {
    vault: V,
}

impl<V> SessionRepository<V> {
    pub(crate) fn new(vault: V) -> Self {
        Self { vault }
    }

    #[cfg(test)]
    fn vault(&self) -> &V {
        &self.vault
    }
}

impl<V: SessionVault> SessionRepository<V> {
    pub(crate) fn save(&self, session: &AuthSession) -> Result<(), String> {
        session.validate().map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec(session)
            .map_err(|_| "Capso could not encode its secure session.".to_string())?;
        if bytes.len() > MAX_STORED_SESSION_BYTES {
            return Err("Capso's secure session exceeded its storage limit.".into());
        }
        self.vault.store(&bytes)
    }

    pub(crate) fn load(&self) -> Result<Option<AuthSession>, String> {
        let Some(bytes) = self.vault.load()? else {
            return Ok(None);
        };
        if bytes.len() > MAX_STORED_SESSION_BYTES {
            return Err("Capso's saved session is invalid; sign in again.".into());
        }
        let session = serde_json::from_slice::<AuthSession>(&bytes)
            .map_err(|_| "Capso's saved session is invalid; sign in again.".to_string())?;
        session
            .validate()
            .map_err(|_| "Capso's saved session is invalid; sign in again.".to_string())?;
        Ok(Some(session))
    }

    pub(crate) fn delete(&self) -> Result<(), String> {
        self.vault.delete()
    }
}

#[derive(Debug)]
pub(crate) struct SessionCoordinator<C, V> {
    config: SupabaseAuthConfig,
    auth: SupabaseAuthClient<C>,
    repository: SessionRepository<V>,
}

impl<C, V> SessionCoordinator<C, V> {
    pub(crate) fn new(
        config: SupabaseAuthConfig,
        http: C,
        repository: SessionRepository<V>,
    ) -> Result<Self, AuthContractError> {
        let auth = SupabaseAuthClient::new(config.clone(), http)?;
        Ok(Self {
            config,
            auth,
            repository,
        })
    }

    pub(crate) fn config(&self) -> &SupabaseAuthConfig {
        &self.config
    }

    pub(crate) fn http(&self) -> &C {
        &self.auth.http
    }

    #[cfg(test)]
    fn repository(&self) -> &SessionRepository<V> {
        &self.repository
    }
}

impl<C: AuthHttpClient, V: SessionVault> SessionCoordinator<C, V> {
    pub(crate) fn fresh_session(
        &self,
        now_ms: u64,
    ) -> Result<Option<AuthSession>, AuthContractError> {
        let Some(session) = self.repository.load().map_err(|_| {
            AuthContractError::new(
                "auth_session_unavailable",
                "Capso could not read its secure session; sign in again if this continues.",
            )
        })?
        else {
            return Ok(None);
        };
        if session.usable_access_token(now_ms).is_some() {
            return Ok(Some(session));
        }

        let refreshed = self.auth.refresh(&session, now_ms)?;
        self.repository.save(&refreshed).map_err(|_| {
            AuthContractError::new(
                "auth_session_store_failed",
                "Capso refreshed your session but could not save it securely; try again.",
            )
        })?;
        Ok(Some(refreshed))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthAccountStatus {
    pub(crate) status: &'static str,
    pub(crate) user_id: Option<String>,
    pub(crate) email: Option<String>,
}

impl AuthAccountStatus {
    fn signed_out() -> Self {
        Self {
            status: "signed_out",
            user_id: None,
            email: None,
        }
    }

    fn signed_in(session: &AuthSession) -> Self {
        Self {
            status: "signed_in",
            user_id: Some(session.user_id().into()),
            email: session.email.clone(),
        }
    }
}

pub(crate) struct NativeSignIn<C, V> {
    runtime: Mutex<AuthRuntime>,
    auth: SupabaseAuthClient<C>,
    repository: SessionRepository<V>,
    confirmation_origin: Url,
}

impl<C, V> fmt::Debug for NativeSignIn<C, V> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeSignIn")
            .field(
                "handoff_pending",
                &self
                    .runtime
                    .lock()
                    .map(|runtime| runtime.pending.is_some())
                    .unwrap_or(false),
            )
            .field("confirmation_origin", &self.confirmation_origin)
            .finish_non_exhaustive()
    }
}

impl<C, V> NativeSignIn<C, V> {
    pub(crate) fn new(
        config: SupabaseAuthConfig,
        http: C,
        repository: SessionRepository<V>,
        confirmation_origin: &str,
    ) -> Result<Self, AuthContractError> {
        let confirmation_origin = validate_confirmation_origin(confirmation_origin)?;
        Ok(Self {
            runtime: Mutex::new(AuthRuntime::default()),
            auth: SupabaseAuthClient::new(config, http)?,
            repository,
            confirmation_origin,
        })
    }

    #[cfg(test)]
    fn http(&self) -> &C {
        &self.auth.http
    }
}

impl<C: AuthHttpClient, V: SessionVault> NativeSignIn<C, V> {
    pub(crate) fn start_email(
        &self,
        email: &str,
        now_ms: u64,
    ) -> Result<AuthStart, AuthContractError> {
        let email = normalize_email(email)?;
        self.ensure_signed_out()?;
        let start = self
            .runtime
            .lock()
            .map_err(|_| auth_runtime_unavailable())?
            .begin(now_ms)?;
        self.auth
            .request_email_link(&email, &start, &self.confirmation_origin)?;
        Ok(start)
    }

    pub(crate) fn start_reconnect(&self, now_ms: u64) -> Result<AuthStart, AuthContractError> {
        let email = self.reconnect_email()?;
        let start = self
            .runtime
            .lock()
            .map_err(|_| auth_runtime_unavailable())?
            .begin(now_ms)?;
        self.auth
            .request_email_link(&email, &start, &self.confirmation_origin)?;
        Ok(start)
    }

    #[cfg(test)]
    fn start_email_with_tokens(
        &self,
        email: &str,
        now_ms: u64,
        state: &str,
        verifier: &str,
    ) -> Result<AuthStart, AuthContractError> {
        let email = normalize_email(email)?;
        self.ensure_signed_out()?;
        let start = self
            .runtime
            .lock()
            .map_err(|_| auth_runtime_unavailable())?
            .begin_with_tokens(now_ms, state, verifier)?;
        self.auth
            .request_email_link(&email, &start, &self.confirmation_origin)?;
        Ok(start)
    }

    #[cfg(test)]
    fn start_reconnect_with_tokens(
        &self,
        now_ms: u64,
        state: &str,
        verifier: &str,
    ) -> Result<AuthStart, AuthContractError> {
        let email = self.reconnect_email()?;
        let start = self
            .runtime
            .lock()
            .map_err(|_| auth_runtime_unavailable())?
            .begin_with_tokens(now_ms, state, verifier)?;
        self.auth
            .request_email_link(&email, &start, &self.confirmation_origin)?;
        Ok(start)
    }

    fn reconnect_email(&self) -> Result<String, AuthContractError> {
        let session = self
            .repository
            .load()
            .map_err(|_| auth_session_unavailable())?
            .ok_or_else(|| {
                AuthContractError::new(
                    "auth_reconnect_unavailable",
                    "Sign in to Capso before reconnecting this account.",
                )
            })?;
        session
            .email
            .as_deref()
            .ok_or_else(|| {
                AuthContractError::new(
                    "auth_reconnect_email_missing",
                    "This saved account has no verified email; sign out after local sync is safe, then sign in again.",
                )
            })
            .and_then(normalize_email)
    }

    pub(crate) fn complete_callback(
        &self,
        callback: &str,
        now_ms: u64,
    ) -> Result<AuthAccountStatus, AuthContractError> {
        let exchange = self
            .runtime
            .lock()
            .map_err(|_| auth_runtime_unavailable())?
            .complete_callback(callback, now_ms)?;
        let session = self.auth.exchange(&exchange, now_ms)?;
        if self
            .repository
            .load()
            .map_err(|_| auth_session_unavailable())?
            .as_ref()
            .is_some_and(|existing| existing.user_id() != session.user_id())
        {
            return Err(AuthContractError::new(
                "auth_account_switch_forbidden",
                "Sign out of the current Capso account before signing in with another one.",
            ));
        }
        self.repository.save(&session).map_err(|_| {
            AuthContractError::new(
                "auth_session_store_failed",
                "Capso signed in but could not save the session securely; try again.",
            )
        })?;
        Ok(AuthAccountStatus::signed_in(&session))
    }

    fn ensure_signed_out(&self) -> Result<(), AuthContractError> {
        if self
            .repository
            .load()
            .map_err(|_| auth_session_unavailable())?
            .is_some()
        {
            Err(AuthContractError::new(
                "auth_already_signed_in",
                "Sign out of the current Capso account before starting another sign-in.",
            ))
        } else {
            Ok(())
        }
    }

    pub(crate) fn status(&self) -> Result<AuthAccountStatus, AuthContractError> {
        self.repository
            .load()
            .map(|session| {
                session
                    .as_ref()
                    .map(AuthAccountStatus::signed_in)
                    .unwrap_or_else(AuthAccountStatus::signed_out)
            })
            .map_err(|_| {
                AuthContractError::new(
                    "auth_session_unavailable",
                    "Capso could not read its secure session; sign in again if this continues.",
                )
            })
    }

    pub(crate) fn sign_out(&self) -> Result<(), AuthContractError> {
        self.repository.delete().map_err(|_| {
            AuthContractError::new(
                "auth_sign_out_failed",
                "Capso could not remove its secure session; try again.",
            )
        })?;
        *self
            .runtime
            .lock()
            .map_err(|_| auth_runtime_unavailable())? = AuthRuntime::default();
        Ok(())
    }
}

#[cfg(target_os = "macos")]
type MacNativeSignIn = NativeSignIn<ReqwestAuthHttpClient, KeychainSessionVault>;

#[cfg(target_os = "macos")]
#[derive(Debug)]
pub(crate) enum ProductionAuthRuntime {
    Ready(Box<MacNativeSignIn>),
    Disabled { warning: String },
}

#[cfg(target_os = "macos")]
impl ProductionAuthRuntime {
    pub(crate) fn from_embedded() -> Self {
        let configured = (|| {
            let config = crate::sync::embedded_public_config()?.ok_or_else(|| {
                "Capso sign-in is not configured in this build; local capture still works."
                    .to_string()
            })?;
            let confirmation_origin = option_env!("CAPSO_AUTH_SITE_URL").ok_or_else(|| {
                "Capso's secure sign-in website is not configured in this build.".to_string()
            })?;
            let http = ReqwestAuthHttpClient::new().map_err(|error| error.to_string())?;
            NativeSignIn::new(
                config,
                http,
                SessionRepository::new(KeychainSessionVault),
                confirmation_origin,
            )
            .map_err(|error| error.to_string())
        })();

        match configured {
            Ok(sign_in) => Self::Ready(Box::new(sign_in)),
            Err(warning) => Self::Disabled { warning },
        }
    }

    pub(crate) fn start_email(&self, email: &str, now_ms: u64) -> Result<AuthStart, String> {
        match self {
            Self::Ready(sign_in) => sign_in
                .start_email(email, now_ms)
                .map_err(|error| error.to_string()),
            Self::Disabled { warning } => Err(warning.clone()),
        }
    }

    pub(crate) fn start_reconnect(&self, now_ms: u64) -> Result<AuthStart, String> {
        match self {
            Self::Ready(sign_in) => sign_in
                .start_reconnect(now_ms)
                .map_err(|error| error.to_string()),
            Self::Disabled { warning } => Err(warning.clone()),
        }
    }

    pub(crate) fn complete_callback(
        &self,
        callback: &str,
        now_ms: u64,
    ) -> Result<AuthAccountStatus, String> {
        match self {
            Self::Ready(sign_in) => sign_in
                .complete_callback(callback, now_ms)
                .map_err(|error| error.to_string()),
            Self::Disabled { warning } => Err(warning.clone()),
        }
    }

    pub(crate) fn status(&self) -> Result<AuthAccountStatus, String> {
        match self {
            Self::Ready(sign_in) => sign_in.status().map_err(|error| error.to_string()),
            Self::Disabled { warning } => Err(warning.clone()),
        }
    }

    pub(crate) fn ui_status(&self) -> Result<(bool, AuthAccountStatus), String> {
        match self {
            Self::Ready(sign_in) => sign_in
                .status()
                .map(|account| (true, account))
                .map_err(|error| error.to_string()),
            Self::Disabled { .. } => Ok((false, AuthAccountStatus::signed_out())),
        }
    }

    pub(crate) fn sign_out(&self) -> Result<AuthAccountStatus, String> {
        match self {
            Self::Ready(sign_in) => {
                sign_in.sign_out().map_err(|error| error.to_string())?;
                Ok(AuthAccountStatus::signed_out())
            }
            Self::Disabled { warning } => Err(warning.clone()),
        }
    }
}

fn auth_runtime_unavailable() -> AuthContractError {
    AuthContractError::new(
        "auth_runtime_unavailable",
        "Capso sign-in is temporarily unavailable; try again.",
    )
}

fn auth_session_unavailable() -> AuthContractError {
    AuthContractError::new(
        "auth_session_unavailable",
        "Capso could not read its secure session; sign in again if this continues.",
    )
}

fn validate_confirmation_origin(value: &str) -> Result<Url, AuthContractError> {
    let parsed = Url::parse(value.trim()).map_err(|_| {
        AuthContractError::new(
            "auth_site_invalid",
            "Capso's sign-in website is not a valid secure origin.",
        )
    })?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(AuthContractError::new(
            "auth_site_invalid",
            "Capso's sign-in website is not a valid secure origin.",
        ));
    }
    Ok(parsed)
}

fn normalize_email(value: &str) -> Result<String, AuthContractError> {
    let value = value.trim();
    let mut parts = value.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if value.len() > 254
        || local.is_empty()
        || local.len() > 64
        || domain.is_empty()
        || parts.next().is_some()
        || value.bytes().any(|byte| !(b'!'..=b'~').contains(&byte))
        || local.starts_with('.')
        || local.ends_with('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return Err(AuthContractError::new(
            "auth_email_invalid",
            "Enter a valid email address to sign in.",
        ));
    }
    Ok(value.into())
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct KeychainSessionVault;

#[cfg(target_os = "macos")]
impl SessionVault for KeychainSessionVault {
    fn store(&self, bytes: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(
            "Capso Supabase Session",
            "active-session",
            bytes,
        )
        .map_err(|error| {
            format!(
                "Capso could not save its Keychain session ({}).",
                error.code()
            )
        })
    }

    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        match security_framework::passwords::get_generic_password(
            "Capso Supabase Session",
            "active-session",
        ) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == security_framework_sys::base::errSecItemNotFound => {
                Ok(None)
            }
            Err(error) => Err(format!(
                "Capso could not read its Keychain session ({}).",
                error.code()
            )),
        }
    }

    fn delete(&self) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(
            "Capso Supabase Session",
            "active-session",
        ) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == security_framework_sys::base::errSecItemNotFound => {
                Ok(())
            }
            Err(error) => Err(format!(
                "Capso could not delete its Keychain session ({}).",
                error.code()
            )),
        }
    }
}

impl AuthRuntime {
    pub(crate) fn begin(&mut self, now_ms: u64) -> Result<AuthStart, AuthContractError> {
        let state = random_token("state");
        let code_verifier = random_token("verifier");
        self.begin_with_tokens(now_ms, &state, &code_verifier)
    }

    fn begin_with_tokens(
        &mut self,
        now_ms: u64,
        state: &str,
        code_verifier: &str,
    ) -> Result<AuthStart, AuthContractError> {
        if !valid_url_token(state, 43, 128) {
            return Err(AuthContractError::new(
                "auth_state_invalid",
                "The native auth state is not a valid high-entropy URL token.",
            ));
        }
        if !valid_url_token(code_verifier, 43, 128) {
            return Err(AuthContractError::new(
                "auth_verifier_invalid",
                "The PKCE verifier is outside the required URL-safe shape.",
            ));
        }
        let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
        self.pending = Some(PendingAuth {
            state: state.into(),
            code_verifier: code_verifier.into(),
            started_at_ms: now_ms,
        });
        Ok(AuthStart {
            state: state.into(),
            code_challenge,
            code_challenge_method: "S256",
            redirect_uri: AUTH_CALLBACK_URI,
        })
    }

    pub(crate) fn complete_callback(
        &mut self,
        callback: &str,
        now_ms: u64,
    ) -> Result<AuthCodeExchange, AuthContractError> {
        let (code, state) = parse_callback(callback)?;
        let pending = self.pending.as_ref().ok_or_else(|| {
            AuthContractError::new(
                "auth_not_pending",
                "Start sign-in from this Capso app before completing the callback.",
            )
        })?;
        if now_ms < pending.started_at_ms
            || now_ms.saturating_sub(pending.started_at_ms) >= HANDOFF_TTL_MS
        {
            self.pending = None;
            return Err(AuthContractError::new(
                "auth_handoff_expired",
                "The sign-in handoff expired; start again from Capso.",
            ));
        }
        if !constant_time_eq(state.as_bytes(), pending.state.as_bytes()) {
            return Err(AuthContractError::new(
                "auth_state_mismatch",
                "The sign-in callback did not match the handoff started by this app.",
            ));
        }
        let pending = self.pending.take().expect("pending checked above");
        Ok(AuthCodeExchange {
            code,
            code_verifier: pending.code_verifier,
        })
    }
}

fn random_token(prefix: &str) -> String {
    format!(
        "{prefix}_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn valid_url_token(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'))
}

pub(crate) fn valid_opaque_code(value: &str) -> bool {
    (1..=2_048).contains(&value.len()) && value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
}

fn parse_callback(callback: &str) -> Result<(String, String), AuthContractError> {
    let invalid = || {
        AuthContractError::new(
            "auth_callback_invalid",
            "The native sign-in callback has an unexpected or unsafe shape.",
        )
    };
    let Some((raw_base, _)) = callback.split_once('?') else {
        return Err(invalid());
    };
    if raw_base != AUTH_CALLBACK_URI || callback.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(invalid());
    }
    let url = Url::parse(callback).map_err(|_| invalid())?;
    if url.scheme() != "capso"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }

    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = Some(value.into_owned()),
            "state" if state.is_none() => state = Some(value.into_owned()),
            _ => return Err(invalid()),
        }
    }
    let code = code
        .filter(|value| valid_opaque_code(value))
        .ok_or_else(invalid)?;
    let state = state
        .filter(|value| valid_url_token(value, 8, 128))
        .ok_or_else(invalid)?;
    Ok((code, state))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        let left = left.get(index).copied().unwrap_or_default();
        let right = right.get(index).copied().unwrap_or_default();
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::{
        AuthHttpClient, AuthHttpRequest, AuthHttpResponse, AuthRuntime, AuthSession, AuthStart,
        NativeSignIn, ProductionAuthRuntime, SessionCoordinator, SessionRepository, SessionVault,
        SupabaseAuthClient, SupabaseAuthConfig, AUTH_CALLBACK_URI, HANDOFF_TTL_MS,
    };
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::Duration,
    };

    const STATE: &str = "state_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const VERIFIER: &str =
        "verifier_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const CODE: &str = "code_018f22c4cada7c6b9d5bfc35f7f92270";

    fn begin(runtime: &mut AuthRuntime, now_ms: u64) -> AuthStart {
        runtime
            .begin_with_tokens(now_ms, STATE, VERIFIER)
            .expect("begin deterministic PKCE handoff")
    }

    #[test]
    fn disabled_production_auth_is_an_explicit_signed_out_ui_state() {
        let runtime = ProductionAuthRuntime::Disabled {
            warning: "test build has no cloud configuration".into(),
        };

        let (configured, account) = runtime.ui_status().expect("safe UI status");
        assert!(!configured);
        assert_eq!(account, super::AuthAccountStatus::signed_out());
    }

    fn callback(state: &str) -> String {
        format!("{AUTH_CALLBACK_URI}?code={CODE}&state={state}")
    }

    #[test]
    fn valid_callback_yields_one_redacted_exchange_then_replay_is_rejected() {
        let mut runtime = AuthRuntime::default();
        let start = begin(&mut runtime, 1_000);
        assert_eq!(start.state, STATE);
        assert_eq!(start.redirect_uri, AUTH_CALLBACK_URI);
        assert_eq!(start.code_challenge_method, "S256");
        assert_eq!(
            start.code_challenge,
            "z8HAYl2-kI-gUtjJqfqUvnIIoD_s3UEA1TYL7ckmlBQ"
        );

        let exchange = runtime
            .complete_callback(&callback(STATE), 1_001)
            .expect("complete exact callback");
        assert_eq!(exchange.code(), CODE);
        assert_eq!(exchange.code_verifier(), VERIFIER);
        assert_eq!(exchange.redirect_uri(), AUTH_CALLBACK_URI);
        let debug = format!("{exchange:?}");
        assert!(!debug.contains(CODE));
        assert!(!debug.contains(VERIFIER));
        assert!(debug.contains("REDACTED"));

        let replay = runtime
            .complete_callback(&callback(STATE), 1_002)
            .expect_err("callback code is single-use locally");
        assert_eq!(replay.code(), "auth_not_pending");
    }

    #[test]
    fn forged_callback_shape_and_url_tokens_are_rejected_without_consuming_pending() {
        let invalid = [
            format!("https://auth/callback?code={CODE}&state={STATE}"),
            format!("capso://evil/callback?code={CODE}&state={STATE}"),
            format!("capso://auth/other?code={CODE}&state={STATE}"),
            format!("capso://auth/foo/../callback?code={CODE}&state={STATE}"),
            format!("capso://auth/%63allback?code={CODE}&state={STATE}"),
            format!("{AUTH_CALLBACK_URI}?code={CODE}&state={STATE}&access_token=secret"),
            format!("{AUTH_CALLBACK_URI}?code=raw\ncontrol&state={STATE}"),
            format!("{AUTH_CALLBACK_URI}?code=raw\tcontrol&state={STATE}"),
            format!("{AUTH_CALLBACK_URI}?code={CODE}&state={STATE}#refresh_token=secret"),
            format!("{AUTH_CALLBACK_URI}?code={CODE}&code=other&state={STATE}"),
            format!("{AUTH_CALLBACK_URI}?code={CODE}&state={STATE}&state=other"),
            format!("{AUTH_CALLBACK_URI}?code={CODE}&state={STATE}&unknown=value"),
        ];

        for url in invalid {
            let mut runtime = AuthRuntime::default();
            begin(&mut runtime, 1_000);
            let error = runtime
                .complete_callback(&url, 1_001)
                .expect_err("forged callback must fail");
            assert_eq!(error.code(), "auth_callback_invalid");
            assert!(
                runtime.complete_callback(&callback(STATE), 1_002).is_ok(),
                "invalid callback must not deny the valid in-flight handoff: {url}"
            );
        }
    }

    #[test]
    fn authorization_code_is_bounded_opaque_visible_ascii() {
        let mut runtime = AuthRuntime::default();
        begin(&mut runtime, 1_000);
        let callback = format!("{AUTH_CALLBACK_URI}?code=%2B%2F%3D%3A%21&state={STATE}");
        assert_eq!(
            runtime
                .complete_callback(&callback, 1_001)
                .expect("opaque authorization code")
                .code(),
            "+/=:!"
        );

        for code in ["", "%00", "%0A"] {
            begin(&mut runtime, 2_000);
            let callback = format!("{AUTH_CALLBACK_URI}?code={code}&state={STATE}");
            assert_eq!(
                runtime
                    .complete_callback(&callback, 2_001)
                    .expect_err("empty or control authorization code")
                    .code(),
                "auth_callback_invalid"
            );
        }
    }

    #[test]
    fn wrong_state_does_not_consume_handoff_but_expiry_does() {
        let mut runtime = AuthRuntime::default();
        begin(&mut runtime, 1_000);
        let wrong = runtime
            .complete_callback(&callback("state_attacker"), 1_001)
            .expect_err("wrong state");
        assert_eq!(wrong.code(), "auth_state_mismatch");
        assert!(runtime.complete_callback(&callback(STATE), 1_002).is_ok());

        begin(&mut runtime, 2_000);
        let expired = runtime
            .complete_callback(&callback(STATE), 2_000 + HANDOFF_TTL_MS)
            .expect_err("expired handoff");
        assert_eq!(expired.code(), "auth_handoff_expired");
        assert_eq!(
            runtime
                .complete_callback(&callback(STATE), 2_001 + HANDOFF_TTL_MS)
                .expect_err("expired handoff was consumed")
                .code(),
            "auth_not_pending"
        );
    }

    #[test]
    fn starting_again_invalidates_the_older_browser_flow() {
        let mut runtime = AuthRuntime::default();
        begin(&mut runtime, 1_000);
        let next_state = "state_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let next_verifier =
            "verifier_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        runtime
            .begin_with_tokens(1_001, next_state, next_verifier)
            .expect("replace handoff");
        assert_eq!(
            runtime
                .complete_callback(&callback(STATE), 1_002)
                .expect_err("old state is stale")
                .code(),
            "auth_state_mismatch"
        );
        let exchange = runtime
            .complete_callback(&callback(next_state), 1_003)
            .expect("new flow remains valid");
        assert_eq!(exchange.code_verifier(), next_verifier);
    }

    #[derive(Debug, Default)]
    struct RecordingAuthHttp {
        requests: Mutex<Vec<AuthHttpRequest>>,
        responses: Mutex<VecDeque<Result<AuthHttpResponse, String>>>,
    }

    impl RecordingAuthHttp {
        fn responding(response: AuthHttpResponse) -> Self {
            Self {
                responses: Mutex::new(VecDeque::from([Ok(response)])),
                ..Self::default()
            }
        }

        fn responding_in_order(responses: impl IntoIterator<Item = AuthHttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().map(Ok).collect()),
                ..Self::default()
            }
        }
    }

    impl AuthHttpClient for RecordingAuthHttp {
        fn execute(&self, request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
            self.requests.lock().expect("request lock").push(request);
            self.responses
                .lock()
                .expect("response lock")
                .pop_front()
                .expect("scripted auth response")
        }
    }

    #[derive(Debug)]
    struct BlockingAuthHttp {
        responses: Mutex<VecDeque<Result<AuthHttpResponse, String>>>,
        calls: AtomicUsize,
        block_at: usize,
        started: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl BlockingAuthHttp {
        fn at_request(
            block_at: usize,
            responses: impl IntoIterator<Item = AuthHttpResponse>,
        ) -> (Self, mpsc::Receiver<()>, mpsc::SyncSender<()>) {
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            (
                Self {
                    responses: Mutex::new(responses.into_iter().map(Ok).collect()),
                    calls: AtomicUsize::new(0),
                    block_at,
                    started: started_tx,
                    release: Mutex::new(release_rx),
                },
                started_rx,
                release_tx,
            )
        }
    }

    impl AuthHttpClient for BlockingAuthHttp {
        fn execute(&self, _request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            if index == self.block_at {
                self.started.send(()).expect("announce blocked auth HTTP");
                self.release
                    .lock()
                    .expect("release lock")
                    .recv()
                    .expect("release blocked auth HTTP");
            }
            self.responses
                .lock()
                .expect("response lock")
                .pop_front()
                .expect("scripted auth response")
        }
    }

    fn assert_capture_transition_enters_while_auth_http_is_blocked(
        boundary: &Arc<crate::AuthAccountBoundary>,
    ) {
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let capture_boundary = Arc::clone(boundary);
        let capture = thread::spawn(move || {
            let _transition = capture_boundary.lock().expect("capture transition");
            entered_tx.send(()).expect("announce capture transition");
        });
        entered_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("capture transition must not wait for auth HTTP");
        capture.join().expect("capture transition worker");
    }

    #[derive(Debug, Default)]
    struct MemoryVault {
        bytes: Mutex<Option<Vec<u8>>>,
    }

    impl SessionVault for MemoryVault {
        fn store(&self, bytes: &[u8]) -> Result<(), String> {
            *self.bytes.lock().expect("vault lock") = Some(bytes.to_vec());
            Ok(())
        }

        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.bytes.lock().expect("vault lock").clone())
        }

        fn delete(&self) -> Result<(), String> {
            *self.bytes.lock().expect("vault lock") = None;
            Ok(())
        }
    }

    fn auth_config() -> SupabaseAuthConfig {
        SupabaseAuthConfig {
            url: "https://capso-test.supabase.co".into(),
            publishable_key: "sb_publishable_capso_test".into(),
        }
    }

    fn token_response(status: u16) -> AuthHttpResponse {
        AuthHttpResponse {
            status,
            body: br#"{
              "access_token":"header.payload.signature",
              "token_type":"bearer",
              "expires_in":3600,
              "refresh_token":"refresh_0123456789abcdef",
              "user":{"id":"018f22c4-cada-7c6b-9d5b-fc35f7f92279","email":"ek@example.com"}
            }"#
            .to_vec(),
        }
    }

    fn code_exchange() -> super::AuthCodeExchange {
        let mut runtime = AuthRuntime::default();
        begin(&mut runtime, 1_000);
        runtime
            .complete_callback(&callback(STATE), 1_001)
            .expect("valid code exchange")
    }

    #[test]
    fn email_pkce_start_uses_only_public_config_and_an_https_confirmation_handoff() {
        let http = RecordingAuthHttp::responding(AuthHttpResponse {
            status: 200,
            body: b"{}".to_vec(),
        });
        let sign_in = NativeSignIn::new(
            auth_config(),
            http,
            SessionRepository::new(MemoryVault::default()),
            "https://app.capso.test",
        )
        .expect("native sign-in");

        let start = sign_in
            .start_email_with_tokens(" ek+mac@example.com ", 1_000, STATE, VERIFIER)
            .expect("request email sign-in");
        assert_eq!(start.state, STATE);

        let requests = sign_in.http().requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "POST");
        let request_url = url::Url::parse(&requests[0].url).expect("OTP URL");
        assert_eq!(
            request_url.as_str().split('?').next(),
            Some("https://capso-test.supabase.co/auth/v1/otp")
        );
        let query = request_url.query_pairs().collect::<Vec<_>>();
        assert_eq!(query.len(), 1);
        assert_eq!(query[0].0, "redirect_to");
        let redirect = url::Url::parse(&query[0].1).expect("confirmation URL");
        assert_eq!(redirect.scheme(), "https");
        assert_eq!(redirect.host_str(), Some("app.capso.test"));
        assert_eq!(redirect.path(), "/auth/open-capso");
        assert_eq!(
            redirect.query_pairs().collect::<Vec<_>>(),
            vec![("state".into(), STATE.into())]
        );

        assert_eq!(
            requests[0].headers.get("apikey").map(String::as_str),
            Some("sb_publishable_capso_test")
        );
        assert!(!requests[0].headers.contains_key("authorization"));
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).expect("OTP JSON");
        assert_eq!(
            body,
            serde_json::json!({
                "email": "ek+mac@example.com",
                "create_user": true,
                "code_challenge": "z8HAYl2-kI-gUtjJqfqUvnIIoD_s3UEA1TYL7ckmlBQ",
                "code_challenge_method": "S256"
            })
        );
        let debug = format!("{:?}", requests[0]);
        assert!(!debug.contains("ek+mac@example.com"));
        assert!(!debug.contains(STATE));
        assert!(!debug.contains(VERIFIER));
    }

    #[test]
    fn stalled_otp_http_never_holds_the_capture_transition_mutex() {
        let (http, started, release) = BlockingAuthHttp::at_request(
            0,
            [AuthHttpResponse {
                status: 200,
                body: b"{}".to_vec(),
            }],
        );
        let sign_in = Arc::new(
            NativeSignIn::new(
                auth_config(),
                http,
                SessionRepository::new(MemoryVault::default()),
                "https://app.capso.test",
            )
            .expect("native sign-in"),
        );
        let boundary = Arc::new(crate::AuthAccountBoundary::default());
        let operation_boundary = Arc::clone(&boundary);
        let worker_sign_in = Arc::clone(&sign_in);
        let worker = thread::spawn(move || {
            let _operation = operation_boundary
                .begin_auth_operation()
                .expect("begin email operation");
            worker_sign_in.start_email_with_tokens("ek@example.com", 1_000, STATE, VERIFIER)
        });

        started
            .recv_timeout(Duration::from_secs(1))
            .expect("OTP request reached HTTP boundary");
        assert_capture_transition_enters_while_auth_http_is_blocked(&boundary);
        assert!(boundary.lock_for_sign_out().is_err());
        release.send(()).expect("release OTP request");
        worker.join().expect("OTP worker").expect("OTP request");
        drop(
            boundary
                .lock_for_sign_out()
                .expect("sign-out transition released"),
        );
    }

    #[test]
    fn stalled_pkce_exchange_never_holds_the_capture_transition_mutex() {
        let (http, started, release) = BlockingAuthHttp::at_request(
            1,
            [
                AuthHttpResponse {
                    status: 200,
                    body: b"{}".to_vec(),
                },
                token_response(200),
            ],
        );
        let sign_in = Arc::new(
            NativeSignIn::new(
                auth_config(),
                http,
                SessionRepository::new(MemoryVault::default()),
                "https://app.capso.test",
            )
            .expect("native sign-in"),
        );
        sign_in
            .start_email_with_tokens("ek@example.com", 1_000, STATE, VERIFIER)
            .expect("prepare callback state");
        let boundary = Arc::new(crate::AuthAccountBoundary::default());
        let operation_boundary = Arc::clone(&boundary);
        let worker_sign_in = Arc::clone(&sign_in);
        let worker = thread::spawn(move || {
            let _operation = operation_boundary
                .begin_auth_operation()
                .expect("begin callback operation");
            worker_sign_in.complete_callback(&callback(STATE), 2_000)
        });

        started
            .recv_timeout(Duration::from_secs(1))
            .expect("exchange reached HTTP boundary");
        assert_capture_transition_enters_while_auth_http_is_blocked(&boundary);
        assert!(boundary.lock_for_sign_out().is_err());
        release.send(()).expect("release exchange");
        let status = worker
            .join()
            .expect("exchange worker")
            .expect("complete callback");
        assert_eq!(status.status, "signed_in");
        drop(
            boundary
                .lock_for_sign_out()
                .expect("sign-out transition released"),
        );
    }

    #[test]
    fn invalid_email_or_confirmation_origin_is_rejected_before_network_io() {
        for email in ["", "not-an-email", "two@@example.com", "a b@example.com"] {
            let sign_in = NativeSignIn::new(
                auth_config(),
                RecordingAuthHttp::default(),
                SessionRepository::new(MemoryVault::default()),
                "https://app.capso.test",
            )
            .expect("native sign-in");
            let error = sign_in
                .start_email_with_tokens(email, 1_000, STATE, VERIFIER)
                .expect_err("invalid email");
            assert_eq!(error.code(), "auth_email_invalid");
            assert!(sign_in
                .http()
                .requests
                .lock()
                .expect("request lock")
                .is_empty());
        }

        for origin in [
            "http://app.capso.test",
            "https://user@app.capso.test",
            "https://app.capso.test/path",
            "https://app.capso.test?token=secret",
        ] {
            let error = NativeSignIn::new(
                auth_config(),
                RecordingAuthHttp::default(),
                SessionRepository::new(MemoryVault::default()),
                origin,
            )
            .expect_err("unsafe confirmation origin");
            assert_eq!(error.code(), "auth_site_invalid");
        }
    }

    #[test]
    fn exact_native_callback_exchanges_and_persists_one_session_then_sign_out_deletes_it() {
        let http = RecordingAuthHttp::responding_in_order([
            AuthHttpResponse {
                status: 200,
                body: b"{}".to_vec(),
            },
            token_response(200),
        ]);
        let sign_in = NativeSignIn::new(
            auth_config(),
            http,
            SessionRepository::new(MemoryVault::default()),
            "https://app.capso.test",
        )
        .expect("native sign-in");
        sign_in
            .start_email_with_tokens("ek@example.com", 1_000, STATE, VERIFIER)
            .expect("request email sign-in");

        let status = sign_in
            .complete_callback(&callback(STATE), 2_000)
            .expect("exchange and persist session");
        assert_eq!(
            status.user_id.as_deref(),
            Some("018f22c4-cada-7c6b-9d5b-fc35f7f92279")
        );
        assert_eq!(status.email.as_deref(), Some("ek@example.com"));
        assert_eq!(status.status, "signed_in");
        assert_eq!(sign_in.status().expect("stored status"), status);
        assert_eq!(
            sign_in.http().requests.lock().expect("request lock").len(),
            2
        );

        sign_in.sign_out().expect("delete session");
        assert_eq!(
            sign_in.status().expect("signed-out status").status,
            "signed_out"
        );
    }

    #[test]
    fn an_existing_session_rejects_a_second_email_flow_before_network_io() {
        let repository = SessionRepository::new(MemoryVault::default());
        repository
            .save(&AuthSession::for_test(
                "existing.access.token",
                "existing_refresh_token",
                "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
                9_000,
            ))
            .expect("store existing session");
        let sign_in = NativeSignIn::new(
            auth_config(),
            RecordingAuthHttp::default(),
            repository,
            "https://app.capso.test",
        )
        .expect("native sign-in");

        let error = sign_in
            .start_email_with_tokens("other@example.com", 1_000, STATE, VERIFIER)
            .expect_err("signed-in account cannot be replaced");
        assert_eq!(error.code(), "auth_already_signed_in");
        assert!(sign_in
            .http()
            .requests
            .lock()
            .expect("request lock")
            .is_empty());
    }

    #[test]
    fn reconnect_keeps_the_existing_session_until_same_account_pkce_replaces_it() {
        let repository = SessionRepository::new(MemoryVault::default());
        let mut existing = AuthSession::for_test(
            "existing.access.token",
            "existing_refresh_token",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
            9_000,
        );
        existing.email = Some("ek@example.com".into());
        repository.save(&existing).expect("store existing session");
        let sign_in = NativeSignIn::new(
            auth_config(),
            RecordingAuthHttp::responding_in_order([
                AuthHttpResponse {
                    status: 200,
                    body: b"{}".to_vec(),
                },
                token_response(200),
            ]),
            repository,
            "https://app.capso.test",
        )
        .expect("native reconnect");

        sign_in
            .start_reconnect_with_tokens(1_000, STATE, VERIFIER)
            .expect("request same-account reconnect");
        assert_eq!(
            sign_in.status().expect("old session remains").user_id,
            Some("018f22c4-cada-7c6b-9d5b-fc35f7f92279".into())
        );
        let reconnected = sign_in
            .complete_callback(&callback(STATE), 2_000)
            .expect("same account reconnects");
        assert_eq!(reconnected.status, "signed_in");
        assert_eq!(reconnected.email.as_deref(), Some("ek@example.com"));
        assert_eq!(sign_in.http().requests.lock().expect("requests").len(), 2);
    }

    #[test]
    fn a_callback_cannot_replace_a_different_session_that_arrived_mid_flow() {
        let different_user_response = AuthHttpResponse {
            status: 200,
            body: br#"{
              "access_token":"other.payload.signature",
              "token_type":"bearer",
              "expires_in":3600,
              "refresh_token":"other_refresh_0123456789",
              "user":{"id":"018f22c4-cada-7c6b-9d5b-fc35f7f92271","email":"other@example.com"}
            }"#
            .to_vec(),
        };
        let sign_in = NativeSignIn::new(
            auth_config(),
            RecordingAuthHttp::responding_in_order([
                AuthHttpResponse {
                    status: 200,
                    body: b"{}".to_vec(),
                },
                different_user_response,
            ]),
            SessionRepository::new(MemoryVault::default()),
            "https://app.capso.test",
        )
        .expect("native sign-in");
        sign_in
            .start_email_with_tokens("other@example.com", 1_000, STATE, VERIFIER)
            .expect("begin while signed out");
        let existing = AuthSession::for_test(
            "existing.access.token",
            "existing_refresh_token",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
            9_000,
        );
        sign_in
            .repository
            .save(&existing)
            .expect("store concurrent session");

        let error = sign_in
            .complete_callback(&callback(STATE), 2_000)
            .expect_err("different callback user cannot replace existing account");
        assert_eq!(error.code(), "auth_account_switch_forbidden");
        assert_eq!(
            sign_in
                .repository
                .load()
                .expect("load retained session")
                .expect("existing session remains")
                .user_id(),
            existing.user_id()
        );
    }

    #[test]
    fn pkce_exchange_sends_only_public_config_and_returns_a_redacted_bounded_session() {
        let http = RecordingAuthHttp::responding(token_response(200));
        let client = SupabaseAuthClient::new(auth_config(), http).expect("auth client");
        let session = client
            .exchange(&code_exchange(), 10_000)
            .expect("PKCE token exchange");

        assert_eq!(session.user_id(), "018f22c4-cada-7c6b-9d5b-fc35f7f92279");
        assert_eq!(session.expires_at_ms(), 3_610_000);
        assert_eq!(
            session.usable_access_token(3_549_999),
            Some("header.payload.signature")
        );
        assert_eq!(session.usable_access_token(3_550_000), None);
        let debug = format!("{session:?}");
        assert!(!debug.contains("header.payload.signature"));
        assert!(!debug.contains("refresh_0123456789abcdef"));
        assert!(debug.contains("REDACTED"));

        let requests = client.http().requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(
            requests[0].url,
            "https://capso-test.supabase.co/auth/v1/token?grant_type=pkce"
        );
        assert_eq!(
            requests[0].headers.get("apikey").map(String::as_str),
            Some("sb_publishable_capso_test")
        );
        assert!(!requests[0].headers.contains_key("authorization"));
        let body: serde_json::Value =
            serde_json::from_slice(&requests[0].body).expect("request JSON");
        assert_eq!(body["auth_code"], CODE);
        assert_eq!(body["code_verifier"], VERIFIER);
        assert_eq!(body.as_object().expect("object").len(), 2);
        let request_debug = format!("{:?}", requests[0]);
        assert!(!request_debug.contains(CODE));
        assert!(!request_debug.contains(VERIFIER));
        let verifier_bytes = VERIFIER
            .bytes()
            .map(|byte| byte.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        assert!(!request_debug.contains(&verifier_bytes));
        let response_debug = format!("{:?}", token_response(200));
        assert!(!response_debug.contains("header.payload.signature"));
        assert!(!response_debug.contains("refresh_0123456789abcdef"));
        let refresh_bytes = "refresh_0123456789abcdef"
            .bytes()
            .map(|byte| byte.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        assert!(!response_debug.contains(&refresh_bytes));
    }

    #[test]
    fn refresh_rotates_the_session_and_accepts_any_successful_2xx_status() {
        let http = RecordingAuthHttp::responding(token_response(201));
        let client = SupabaseAuthClient::new(auth_config(), http).expect("auth client");
        let old = AuthSession::for_test(
            "old.access.token",
            "old_refresh_token",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
            10,
        );
        let refreshed = client.refresh(&old, 20_000).expect("refresh session");
        assert_eq!(refreshed.expires_at_ms(), 3_620_000);

        let requests = client.http().requests.lock().expect("request lock");
        assert_eq!(
            requests[0].url,
            "https://capso-test.supabase.co/auth/v1/token?grant_type=refresh_token"
        );
        let body: serde_json::Value =
            serde_json::from_slice(&requests[0].body).expect("refresh JSON");
        assert_eq!(
            body,
            serde_json::json!({ "refresh_token": "old_refresh_token" })
        );
    }

    #[test]
    fn provider_failures_and_malformed_tokens_never_expose_remote_bodies_or_partial_sessions() {
        let secret = "SUPER_SECRET_PROVIDER_BODY";
        let client = SupabaseAuthClient::new(
            auth_config(),
            RecordingAuthHttp::responding(AuthHttpResponse {
                status: 400,
                body: secret.as_bytes().to_vec(),
            }),
        )
        .expect("auth client");
        let error = client
            .exchange(&code_exchange(), 10_000)
            .expect_err("provider rejection");
        assert!(!error.to_string().contains(secret));

        let malformed = SupabaseAuthClient::new(
            auth_config(),
            RecordingAuthHttp::responding(AuthHttpResponse {
                status: 200,
                body: br#"{"access_token":"x","refresh_token":"y","expires_in":0,"token_type":"bearer","user":{"id":"attacker"}}"#.to_vec(),
            }),
        )
        .expect("auth client");
        assert!(malformed.exchange(&code_exchange(), 10_000).is_err());
    }

    #[test]
    fn session_repository_round_trips_exact_secrets_and_rejects_corrupt_keychain_data() {
        let repository = SessionRepository::new(MemoryVault::default());
        let session = AuthSession::for_test(
            "header.payload.signature",
            "refresh_0123456789abcdef",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
            3_610_000,
        );
        repository.save(&session).expect("save session");
        assert_eq!(repository.load().expect("load session"), Some(session));
        repository.delete().expect("delete session");
        assert_eq!(repository.load().expect("deleted session"), None);

        repository
            .vault()
            .store(br#"{"access_token":"leaked-but-corrupt"}"#)
            .expect("seed corrupt record");
        let error = repository.load().expect_err("corrupt record rejected");
        assert!(!error.contains("leaked-but-corrupt"));
    }

    #[test]
    fn session_coordinator_reuses_a_fresh_keychain_session_without_auth_network() {
        let vault = MemoryVault::default();
        let repository = SessionRepository::new(vault);
        let session = AuthSession::for_test(
            "header.payload.signature",
            "refresh_0123456789abcdef",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
            3_610_000,
        );
        repository.save(&session).expect("seed secure session");
        let coordinator =
            SessionCoordinator::new(auth_config(), RecordingAuthHttp::default(), repository)
                .expect("session coordinator");

        assert_eq!(
            coordinator.fresh_session(10_000).expect("fresh session"),
            Some(session)
        );
        assert!(
            coordinator
                .http()
                .requests
                .lock()
                .expect("request lock")
                .is_empty(),
            "a fresh Keychain access token must not trigger an Auth request"
        );
    }

    #[test]
    fn session_coordinator_rotates_an_expiring_session_before_returning_it() {
        let repository = SessionRepository::new(MemoryVault::default());
        let expiring = AuthSession::for_test(
            "old.access.token",
            "old_refresh_token",
            "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
            60_000,
        );
        repository.save(&expiring).expect("seed expiring session");
        let coordinator = SessionCoordinator::new(
            auth_config(),
            RecordingAuthHttp::responding(token_response(200)),
            repository,
        )
        .expect("session coordinator");

        let rotated = coordinator
            .fresh_session(1)
            .expect("rotate session")
            .expect("stored session");
        assert_ne!(rotated, expiring);
        assert_eq!(rotated.expires_at_ms(), 3_600_001);
        assert_eq!(
            coordinator.repository().load().expect("persisted rotation"),
            Some(rotated)
        );
        assert_eq!(
            coordinator
                .http()
                .requests
                .lock()
                .expect("request lock")
                .len(),
            1
        );
    }

    #[test]
    fn session_coordinator_has_a_network_free_missing_session_hold() {
        let coordinator = SessionCoordinator::new(
            auth_config(),
            RecordingAuthHttp::default(),
            SessionRepository::new(MemoryVault::default()),
        )
        .expect("session coordinator");

        assert_eq!(coordinator.fresh_session(10_000).expect("no session"), None);
        assert!(coordinator
            .http()
            .requests
            .lock()
            .expect("request lock")
            .is_empty());
    }

    #[test]
    fn chunked_auth_responses_are_stopped_before_crossing_the_memory_limit() {
        assert_eq!(
            super::read_bounded(std::io::Cursor::new(b"exact"), 5).expect("exact bound"),
            b"exact"
        );
        assert!(super::read_bounded(std::io::Cursor::new(b"oversized"), 8).is_err());
    }
}
