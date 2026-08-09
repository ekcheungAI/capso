use crate::{
    auth::{AuthHttpClient, AuthSession, SessionCoordinator, SessionVault, SupabaseAuthConfig},
    drain::{DrainCoordinator, DrainQueue, DrainWake, UploadTransport, WakeResult},
    upload::{AuthenticatedUploadTransport, ReqwestHttpClient, UploadSession},
};

#[cfg(target_os = "macos")]
use crate::auth::{KeychainSessionVault, ReqwestAuthHttpClient, SessionRepository};

pub(crate) fn public_config(
    url: Option<&str>,
    publishable_key: Option<&str>,
) -> Result<Option<SupabaseAuthConfig>, String> {
    match (url, publishable_key) {
        (None, None) => Ok(None),
        (Some(url), Some(publishable_key))
            if !url.trim().is_empty()
                && publishable_key.starts_with("sb_publishable_")
                && !publishable_key.trim().is_empty() =>
        {
            Ok(Some(SupabaseAuthConfig {
                url: url.trim().into(),
                publishable_key: publishable_key.trim().into(),
            }))
        }
        _ => Err(
            "Capso's native Supabase public configuration is missing or unsafe; server secrets are never accepted."
                .into(),
        ),
    }
}

pub(crate) fn embedded_public_config() -> Result<Option<SupabaseAuthConfig>, String> {
    public_config(
        option_env!("CAPSO_SUPABASE_URL"),
        option_env!("CAPSO_SUPABASE_PUBLISHABLE_KEY"),
    )
}

pub(crate) trait UploadTransportFactory: Send + Sync {
    type Transport: UploadTransport;

    fn prepare(
        &self,
        config: &SupabaseAuthConfig,
        session: Option<&AuthSession>,
        now_ms: u64,
    ) -> Result<Self::Transport, String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ReqwestUploadTransportFactory;

impl UploadTransportFactory for ReqwestUploadTransportFactory {
    type Transport = AuthenticatedUploadTransport<ReqwestHttpClient>;

    fn prepare(
        &self,
        config: &SupabaseAuthConfig,
        session: Option<&AuthSession>,
        now_ms: u64,
    ) -> Result<Self::Transport, String> {
        let upload_session =
            session.and_then(|session| UploadSession::from_auth(config, session, now_ms));
        Ok(AuthenticatedUploadTransport::new(
            ReqwestHttpClient::new()?,
            upload_session,
        ))
    }
}

#[derive(Debug)]
pub(crate) struct BackgroundSync<C, V, F> {
    sessions: SessionCoordinator<C, V>,
    factory: F,
}

impl<C, V, F> BackgroundSync<C, V, F> {
    pub(crate) fn new(sessions: SessionCoordinator<C, V>, factory: F) -> Self {
        Self { sessions, factory }
    }

    #[cfg(test)]
    fn factory(&self) -> &F {
        &self.factory
    }
}

impl<C, V, F> BackgroundSync<C, V, F>
where
    C: AuthHttpClient,
    V: SessionVault,
    F: UploadTransportFactory,
{
    pub(crate) fn wake<Q: DrainQueue>(
        &self,
        wake: DrainWake,
        coordinator: &DrainCoordinator,
        queue: &Q,
        now_ms: u64,
    ) -> Result<WakeResult, String> {
        let session = self
            .sessions
            .fresh_session(now_ms)
            .map_err(|error| error.to_string())?;
        let transport = self
            .factory
            .prepare(self.sessions.config(), session.as_ref(), now_ms)?;
        coordinator.wake(wake, queue, &transport, now_ms)
    }
}

#[cfg(target_os = "macos")]
type NativeBackgroundSync =
    BackgroundSync<ReqwestAuthHttpClient, KeychainSessionVault, ReqwestUploadTransportFactory>;

#[cfg(target_os = "macos")]
#[derive(Debug)]
pub(crate) enum ProductionSyncRuntime {
    Ready(NativeBackgroundSync),
    Disabled { warning: String },
}

#[cfg(target_os = "macos")]
impl ProductionSyncRuntime {
    pub(crate) fn from_embedded() -> Self {
        let configured = (|| {
            let config = embedded_public_config()?.ok_or_else(|| {
                "Capso sync is not configured in this build; captures remain saved locally."
                    .to_string()
            })?;
            let auth_http = ReqwestAuthHttpClient::new().map_err(|error| error.to_string())?;
            let sessions = SessionCoordinator::new(
                config,
                auth_http,
                SessionRepository::new(KeychainSessionVault),
            )
            .map_err(|error| error.to_string())?;
            Ok::<_, String>(BackgroundSync::new(sessions, ReqwestUploadTransportFactory))
        })();

        match configured {
            Ok(sync) => Self::Ready(sync),
            Err(warning) => Self::Disabled { warning },
        }
    }

    pub(crate) fn wake<Q: DrainQueue>(
        &self,
        wake: DrainWake,
        coordinator: &DrainCoordinator,
        queue: &Q,
        now_ms: u64,
    ) -> Result<WakeResult, String> {
        match self {
            Self::Ready(sync) => sync.wake(wake, coordinator, queue, now_ms),
            Self::Disabled { warning } => {
                let summary = queue.summary()?;
                Ok(WakeResult::Ran(crate::drain::DrainReport {
                    passes: 1,
                    held: summary.queued(),
                    remaining: summary.queued(),
                    last_hold: Some(format!("sync_not_configured: {warning}")),
                    ..crate::drain::DrainReport::default()
                }))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{public_config, BackgroundSync, UploadTransportFactory};
    use crate::{
        auth::{
            AuthHttpClient, AuthHttpRequest, AuthHttpResponse, AuthSession, SessionCoordinator,
            SessionRepository, SessionVault, SupabaseAuthConfig,
        },
        drain::{
            DrainCoordinator, DrainQueue, DrainWake, TransportAvailability, UploadAcknowledgement,
            UploadResult, UploadTransport, WakeResult,
        },
        queue::{QueueItem, QueueItemStatus, QueueSource, QueueSummary},
    };
    use std::{path::PathBuf, sync::Mutex};

    const USER_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";
    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";

    #[derive(Debug)]
    struct NoAuthNetwork;

    impl AuthHttpClient for NoAuthNetwork {
        fn execute(&self, _request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
            panic!("a fresh or missing session must not call Supabase Auth")
        }
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

    #[derive(Debug, Default)]
    struct MemoryQueue {
        item: Mutex<Option<QueueItem>>,
        claims: Mutex<usize>,
        uploads: Mutex<usize>,
    }

    impl MemoryQueue {
        fn one_pending() -> Self {
            Self {
                item: Mutex::new(Some(QueueItem {
                    id: CAPTURE_ID.into(),
                    file_path: PathBuf::from("/private/capso/test.png"),
                    created_at_ms: 1,
                    source: QueueSource::Region,
                    status: QueueItemStatus::Pending,
                    attempts: 0,
                    next_attempt_at_ms: None,
                    last_error: None,
                    annotated: false,
                })),
                ..Self::default()
            }
        }
    }

    impl DrainQueue for MemoryQueue {
        fn claim_next(&self, _now_ms: u64) -> Result<Option<QueueItem>, String> {
            let mut item = self.item.lock().expect("item lock");
            let Some(mut claimed) = item.take() else {
                return Ok(None);
            };
            *self.claims.lock().expect("claim lock") += 1;
            claimed.status = QueueItemStatus::Uploading;
            claimed.attempts = 1;
            Ok(Some(claimed))
        }

        fn mark_uploaded(&self, _id: &str) -> Result<(), String> {
            *self.uploads.lock().expect("upload lock") += 1;
            Ok(())
        }

        fn mark_failed(&self, _id: &str, _failed_at_ms: u64, _error: &str) -> Result<(), String> {
            Ok(())
        }

        fn mark_terminal(&self, _id: &str, _error: &str) -> Result<(), String> {
            Ok(())
        }

        fn mark_held(&self, _id: &str, _message: &str) -> Result<(), String> {
            Ok(())
        }

        fn summary(&self) -> Result<QueueSummary, String> {
            let pending = usize::from(self.item.lock().expect("item lock").is_some());
            Ok(QueueSummary {
                pending,
                total: pending,
                ..QueueSummary::default()
            })
        }
    }

    #[derive(Debug)]
    struct AuthPresenceTransport {
        authenticated: bool,
    }

    impl UploadTransport for AuthPresenceTransport {
        fn availability(&self) -> TransportAvailability {
            if self.authenticated {
                TransportAvailability::Ready
            } else {
                TransportAvailability::Held {
                    code: "sign_in_required",
                    message: "Sign in to sync captures; original pixels remain saved locally."
                        .into(),
                }
            }
        }

        fn upload(&self, item: &QueueItem) -> UploadResult {
            UploadResult::Confirmed(UploadAcknowledgement {
                capture_id: item.id.clone(),
            })
        }
    }

    #[derive(Debug, Default)]
    struct RecordingFactory {
        prepared_user: Mutex<Option<Option<String>>>,
    }

    impl UploadTransportFactory for RecordingFactory {
        type Transport = AuthPresenceTransport;

        fn prepare(
            &self,
            _config: &SupabaseAuthConfig,
            session: Option<&AuthSession>,
            _now_ms: u64,
        ) -> Result<Self::Transport, String> {
            *self.prepared_user.lock().expect("factory lock") =
                Some(session.map(|session| session.user_id().to_string()));
            Ok(AuthPresenceTransport {
                authenticated: session.is_some(),
            })
        }
    }

    fn config() -> SupabaseAuthConfig {
        SupabaseAuthConfig {
            url: "https://capso-test.supabase.co".into(),
            publishable_key: "sb_publishable_capso_test".into(),
        }
    }

    fn runtime(
        repository: SessionRepository<MemoryVault>,
    ) -> BackgroundSync<NoAuthNetwork, MemoryVault, RecordingFactory> {
        BackgroundSync::new(
            SessionCoordinator::new(config(), NoAuthNetwork, repository)
                .expect("session coordinator"),
            RecordingFactory::default(),
        )
    }

    #[test]
    fn missing_session_holds_the_entire_queue_without_claiming_an_attempt() {
        let sync = runtime(SessionRepository::new(MemoryVault::default()));
        let queue = MemoryQueue::one_pending();
        let result = sync
            .wake(
                DrainWake::Startup,
                &DrainCoordinator::default(),
                &queue,
                10_000,
            )
            .expect("held wake");

        let WakeResult::Ran(report) = result else {
            panic!("first wake must run")
        };
        assert_eq!(report.attempted, 0);
        assert_eq!(report.held, 1);
        assert_eq!(*queue.claims.lock().expect("claim lock"), 0);
        assert_eq!(
            *sync.factory().prepared_user.lock().expect("factory lock"),
            Some(None)
        );
    }

    #[test]
    fn fresh_keychain_session_reaches_the_real_drain_boundary() {
        let repository = SessionRepository::new(MemoryVault::default());
        repository
            .save(&AuthSession::for_test(
                "header.payload.signature",
                "refresh_0123456789abcdef",
                USER_ID,
                3_610_000,
            ))
            .expect("seed session");
        let sync = runtime(repository);
        let queue = MemoryQueue::one_pending();
        let result = sync
            .wake(
                DrainWake::CaptureEnqueued,
                &DrainCoordinator::default(),
                &queue,
                10_000,
            )
            .expect("authenticated wake");

        let WakeResult::Ran(report) = result else {
            panic!("first wake must run")
        };
        assert_eq!(report.attempted, 1);
        assert_eq!(report.uploaded, 1);
        assert_eq!(*queue.uploads.lock().expect("upload lock"), 1);
        assert_eq!(
            *sync.factory().prepared_user.lock().expect("factory lock"),
            Some(Some(USER_ID.into()))
        );
    }

    #[test]
    fn native_public_config_is_all_or_nothing_and_rejects_server_secrets() {
        assert_eq!(public_config(None, None).expect("optional config"), None);
        assert!(public_config(Some("https://capso-test.supabase.co"), None).is_err());
        assert!(public_config(
            Some("https://capso-test.supabase.co"),
            Some("sb_secret_never_ship_this"),
        )
        .is_err());
        assert_eq!(
            public_config(
                Some("https://capso-test.supabase.co"),
                Some("sb_publishable_capso_test"),
            )
            .expect("public config"),
            Some(config())
        );
    }
}
