// AI-01a1 lands the provider-neutral PKCE boundary before a production Supabase
// adapter or URL-scheme registration is selected and approved.
#![allow(dead_code)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};
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
    use super::{AuthRuntime, AuthStart, AUTH_CALLBACK_URI, HANDOFF_TTL_MS};

    const STATE: &str = "state_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const VERIFIER: &str =
        "verifier_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const CODE: &str = "code_018f22c4cada7c6b9d5bfc35f7f92270";

    fn begin(runtime: &mut AuthRuntime, now_ms: u64) -> AuthStart {
        runtime
            .begin_with_tokens(now_ms, STATE, VERIFIER)
            .expect("begin deterministic PKCE handoff")
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
}
