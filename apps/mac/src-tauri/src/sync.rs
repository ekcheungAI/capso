use crate::{
    auth::{AuthHttpClient, AuthSession, SessionCoordinator, SessionVault, SupabaseAuthConfig},
    device::MacDeviceCredential,
    drain::{DrainCoordinator, DrainQueue, DrainWake, UploadTransport, WakeResult},
    projects::{fetch_capture_projects, CaptureProject},
    upload::{AuthenticatedUploadTransport, ReqwestHttpClient, UploadSession},
};

#[cfg(target_os = "macos")]
use crate::{
    auth::{KeychainSessionVault, ReqwestAuthHttpClient, SessionRepository},
    device::{DeviceRepository, KeychainDeviceVault, MacDeviceRegistry},
};

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

    fn prepare_device(
        &self,
        _config: &SupabaseAuthConfig,
        _session: &AuthSession,
        _now_ms: u64,
    ) -> Result<Option<MacDeviceCredential>, String> {
        Ok(None)
    }

    fn prepare(
        &self,
        config: &SupabaseAuthConfig,
        session: Option<&AuthSession>,
        device: Option<&MacDeviceCredential>,
        now_ms: u64,
    ) -> Result<Self::Transport, String>;
}

#[cfg(target_os = "macos")]
type NativeDeviceRegistry = MacDeviceRegistry<ReqwestAuthHttpClient, KeychainDeviceVault>;

#[cfg(target_os = "macos")]
#[derive(Debug)]
pub(crate) struct ReqwestUploadTransportFactory {
    devices: NativeDeviceRegistry,
}

#[cfg(target_os = "macos")]
impl ReqwestUploadTransportFactory {
    fn new() -> Result<Self, String> {
        Ok(Self {
            devices: MacDeviceRegistry::new(
                ReqwestAuthHttpClient::new().map_err(|error| error.to_string())?,
                DeviceRepository::new(KeychainDeviceVault),
            ),
        })
    }

    fn reset_device_identity(&self) -> Result<(), String> {
        self.devices.reset()
    }
}

#[cfg(target_os = "macos")]
impl UploadTransportFactory for ReqwestUploadTransportFactory {
    type Transport = AuthenticatedUploadTransport<ReqwestHttpClient>;

    fn prepare_device(
        &self,
        config: &SupabaseAuthConfig,
        session: &AuthSession,
        now_ms: u64,
    ) -> Result<Option<MacDeviceCredential>, String> {
        self.devices.ensure(config, session, now_ms).map(Some)
    }

    fn prepare(
        &self,
        config: &SupabaseAuthConfig,
        session: Option<&AuthSession>,
        device: Option<&MacDeviceCredential>,
        now_ms: u64,
    ) -> Result<Self::Transport, String> {
        let upload_session =
            session.and_then(|session| UploadSession::from_auth(config, session, device?, now_ms));
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
    pub(crate) fn annotation_transport(&self, now_ms: u64) -> Result<F::Transport, String> {
        let session = self
            .sessions
            .fresh_session(now_ms)
            .map_err(|error| error.to_string())?;
        let device = match session.as_ref() {
            Some(session) => {
                self.factory
                    .prepare_device(self.sessions.config(), session, now_ms)?
            }
            None => None,
        };
        self.factory.prepare(
            self.sessions.config(),
            session.as_ref(),
            device.as_ref(),
            now_ms,
        )
    }

    pub(crate) fn capture_projects(&self, now_ms: u64) -> Result<Vec<CaptureProject>, String> {
        let session = self
            .sessions
            .fresh_session(now_ms)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Sign in to Capso before choosing a project.".to_string())?;
        fetch_capture_projects(
            self.sessions.http(),
            self.sessions.config(),
            &session,
            now_ms,
        )
    }

    pub(crate) fn wake_with_connectivity<Q: DrainQueue>(
        &self,
        wake: DrainWake,
        coordinator: &DrainCoordinator,
        queue: &Q,
        now_ms: u64,
        connectivity_available: bool,
    ) -> Result<WakeResult, String> {
        if !connectivity_available {
            let summary = queue.summary()?;
            return Ok(WakeResult::Ran(crate::drain::DrainReport {
                passes: 1,
                held: summary.queued(),
                remaining: summary.queued(),
                last_hold: Some(
                    "offline: No network route is available; captures remain saved locally.".into(),
                ),
                ..crate::drain::DrainReport::default()
            }));
        }
        let session = self
            .sessions
            .fresh_session(now_ms)
            .map_err(|error| error.to_string())?;
        let device = match session.as_ref() {
            Some(session) => {
                self.factory
                    .prepare_device(self.sessions.config(), session, now_ms)?
            }
            None => None,
        };
        let transport = self.factory.prepare(
            self.sessions.config(),
            session.as_ref(),
            device.as_ref(),
            now_ms,
        )?;
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
            Ok::<_, String>(BackgroundSync::new(
                sessions,
                ReqwestUploadTransportFactory::new()?,
            ))
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
        connectivity_available: bool,
    ) -> Result<WakeResult, String> {
        match self {
            Self::Ready(sync) => sync.wake_with_connectivity(
                wake,
                coordinator,
                queue,
                now_ms,
                connectivity_available,
            ),
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

    pub(crate) fn capture_projects(&self, now_ms: u64) -> Result<Vec<CaptureProject>, String> {
        match self {
            Self::Ready(sync) => sync.capture_projects(now_ms),
            Self::Disabled { warning } => Err(warning.clone()),
        }
    }

    pub(crate) fn annotation_transport(
        &self,
        now_ms: u64,
    ) -> Result<AuthenticatedUploadTransport<ReqwestHttpClient>, String> {
        match self {
            Self::Ready(sync) => sync.annotation_transport(now_ms),
            Self::Disabled { warning } => Err(warning.clone()),
        }
    }

    pub(crate) fn reset_device_identity(&self) -> Result<(), String> {
        match self {
            Self::Ready(sync) => sync.factory.reset_device_identity(),
            Self::Disabled { warning } => Err(warning.clone()),
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
        retry::{RetryDeadlinePlanner, RETRY_WAKE_REARM_MS},
    };
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    const USER_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";
    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";

    #[derive(Debug)]
    struct NoAuthNetwork;

    impl AuthHttpClient for NoAuthNetwork {
        fn execute(&self, _request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
            panic!("a fresh or missing session must not call Supabase Auth")
        }
    }

    #[derive(Debug, Clone)]
    struct FailingAuthNetwork {
        calls: Arc<AtomicUsize>,
    }

    impl AuthHttpClient for FailingAuthNetwork {
        fn execute(&self, _request: AuthHttpRequest) -> Result<AuthHttpResponse, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err("simulated auth refresh outage".into())
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
                    project_id: None,
                    uploaded_at_ms: None,
                    remote_content_hash: None,
                    remote_local_hash: None,
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

        fn mark_uploaded(&self, _id: &str, _uploaded_at_ms: u64) -> Result<(), String> {
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
            _device: Option<&crate::device::MacDeviceCredential>,
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
            .wake_with_connectivity(
                DrainWake::Startup,
                &DrainCoordinator::default(),
                &queue,
                10_000,
                true,
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
    fn known_offline_route_holds_before_auth_or_transport_and_consumes_zero_attempts() {
        let repository = SessionRepository::new(MemoryVault::default());
        repository
            .save(&AuthSession::for_test(
                "header.payload.signature",
                "refresh_0123456789abcdef",
                USER_ID,
                1,
            ))
            .expect("seed expired session");
        let sync = runtime(repository);
        let queue = MemoryQueue::one_pending();
        let result = sync
            .wake_with_connectivity(
                DrainWake::CaptureEnqueued,
                &DrainCoordinator::default(),
                &queue,
                10_000,
                false,
            )
            .expect("offline hold");

        let WakeResult::Ran(report) = result else {
            panic!("offline wake must report a hold")
        };
        assert_eq!(report.attempted, 0);
        assert_eq!(report.held, 1);
        assert_eq!(*queue.claims.lock().expect("claim lock"), 0);
        assert_eq!(
            *sync.factory().prepared_user.lock().expect("factory lock"),
            None,
            "offline gating must happen before session or transport preparation"
        );
    }

    #[test]
    fn auth_failure_before_claim_rearms_the_same_persisted_deadline() {
        let repository = SessionRepository::new(MemoryVault::default());
        repository
            .save(&AuthSession::for_test(
                "header.payload.signature",
                "refresh_0123456789abcdef",
                USER_ID,
                1,
            ))
            .expect("seed expired session");
        let calls = Arc::new(AtomicUsize::new(0));
        let sync = BackgroundSync::new(
            SessionCoordinator::new(
                config(),
                FailingAuthNetwork {
                    calls: Arc::clone(&calls),
                },
                repository,
            )
            .expect("session coordinator"),
            RecordingFactory::default(),
        );
        let queue = MemoryQueue::one_pending();
        let deadline = 5_000;
        let mut planner = RetryDeadlinePlanner::default();

        assert_eq!(
            planner.observe(deadline, Some(deadline), true),
            Some(DrainWake::RetryDeadline)
        );
        assert!(sync
            .wake_with_connectivity(
                DrainWake::RetryDeadline,
                &DrainCoordinator::default(),
                &queue,
                deadline,
                true,
            )
            .is_err());
        assert_eq!(*queue.claims.lock().expect("claim lock"), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            planner.observe(deadline + RETRY_WAKE_REARM_MS, Some(deadline), true,),
            Some(DrainWake::RetryDeadline)
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
            .wake_with_connectivity(
                DrainWake::CaptureEnqueued,
                &DrainCoordinator::default(),
                &queue,
                10_000,
                true,
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
