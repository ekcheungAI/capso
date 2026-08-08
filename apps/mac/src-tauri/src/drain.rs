// DUR-01b1 deliberately lands the coordinator before the authenticated HTTP
// adapter. Keeping this narrow module compiled in production makes that next
// adapter exercise the same queue transitions proven below.
#![allow(dead_code)]

use crate::queue::{DurableUploadQueue, QueueItem, QueueRuntime, QueueSummary};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DrainWake {
    Startup,
    CaptureEnqueued,
    ConnectivityRestored,
    CredentialsRestored,
    RetryDeadline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TransportAvailability {
    Ready,
    Held { code: &'static str, message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UploadAcknowledgement {
    pub(crate) capture_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum UploadResult {
    Confirmed(UploadAcknowledgement),
    Retryable { message: String },
    Held { message: String },
    Terminal { message: String },
}

pub(crate) trait UploadTransport: Send + Sync {
    fn availability(&self) -> TransportAvailability;
    fn upload(&self, item: &QueueItem) -> UploadResult;
}

pub(crate) trait DrainQueue: Send + Sync {
    fn claim_next(&self, now_ms: u64) -> Result<Option<QueueItem>, String>;
    fn mark_uploaded(&self, id: &str) -> Result<(), String>;
    fn mark_failed(&self, id: &str, failed_at_ms: u64, error: &str) -> Result<(), String>;
    fn mark_terminal(&self, id: &str, error: &str) -> Result<(), String>;
    fn mark_held(&self, id: &str, message: &str) -> Result<(), String>;
    fn summary(&self) -> Result<QueueSummary, String>;
}

fn queue_lock_error() -> String {
    "Capso's upload queue is temporarily unavailable.".into()
}

impl DrainQueue for Mutex<DurableUploadQueue> {
    fn claim_next(&self, now_ms: u64) -> Result<Option<QueueItem>, String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .claim_next(now_ms)
    }

    fn mark_uploaded(&self, id: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_uploaded(id)
    }

    fn mark_failed(&self, id: &str, failed_at_ms: u64, error: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_failed(id, failed_at_ms, error)
    }

    fn mark_terminal(&self, id: &str, error: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_terminal(id, error)
    }

    fn mark_held(&self, id: &str, message: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_held(id, message)
    }

    fn summary(&self) -> Result<QueueSummary, String> {
        self.lock()
            .map(|queue| queue.summary())
            .map_err(|_| queue_lock_error())
    }
}

impl DrainQueue for Mutex<QueueRuntime> {
    fn claim_next(&self, now_ms: u64) -> Result<Option<QueueItem>, String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .claim_next(now_ms)
    }

    fn mark_uploaded(&self, id: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_uploaded(id)
    }

    fn mark_failed(&self, id: &str, failed_at_ms: u64, error: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_failed(id, failed_at_ms, error)
    }

    fn mark_terminal(&self, id: &str, error: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_terminal(id, error)
    }

    fn mark_held(&self, id: &str, message: &str) -> Result<(), String> {
        self.lock()
            .map_err(|_| queue_lock_error())?
            .mark_held(id, message)
    }

    fn summary(&self) -> Result<QueueSummary, String> {
        self.lock().map_err(|_| queue_lock_error())?.drain_summary()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct DrainReport {
    pub(crate) passes: usize,
    pub(crate) attempted: usize,
    pub(crate) uploaded: usize,
    pub(crate) retrying: usize,
    pub(crate) held: usize,
    pub(crate) remaining: usize,
    pub(crate) last_hold: Option<String>,
}

impl DrainReport {
    fn absorb(&mut self, pass: Self) {
        self.passes += pass.passes;
        self.attempted += pass.attempted;
        self.uploaded += pass.uploaded;
        self.retrying += pass.retrying;
        self.held += pass.held;
        self.remaining = pass.remaining;
        if pass.last_hold.is_some() {
            self.last_hold = pass.last_hold;
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WakeResult {
    Ran(DrainReport),
    Coalesced,
}

#[derive(Debug, Default)]
pub(crate) struct DrainCoordinator {
    running: AtomicBool,
    wake_requested: AtomicBool,
    latest_now_ms: AtomicU64,
}

struct RunningGuard<'a> {
    coordinator: &'a DrainCoordinator,
    armed: bool,
}

impl RunningGuard<'_> {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.coordinator.running.store(false, Ordering::SeqCst);
        }
    }
}

impl DrainCoordinator {
    pub(crate) fn wake<Q, T>(
        &self,
        _wake: DrainWake,
        queue: &Q,
        transport: &T,
        now_ms: u64,
    ) -> Result<WakeResult, String>
    where
        Q: DrainQueue,
        T: UploadTransport,
    {
        self.latest_now_ms.fetch_max(now_ms, Ordering::SeqCst);
        self.wake_requested.store(true, Ordering::SeqCst);
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(WakeResult::Coalesced);
        }

        let mut guard = RunningGuard {
            coordinator: self,
            armed: true,
        };
        let mut report = DrainReport::default();
        let mut first_error = None;
        loop {
            self.wake_requested.store(false, Ordering::SeqCst);
            let pass = self.drain_pass(queue, transport, self.latest_now_ms.load(Ordering::SeqCst));
            match pass {
                Ok(pass) => report.absorb(pass),
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }

            guard.disarm();
            self.running.store(false, Ordering::SeqCst);
            if self.wake_requested.load(Ordering::SeqCst)
                && self
                    .running
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                guard = RunningGuard {
                    coordinator: self,
                    armed: true,
                };
                continue;
            }
            return match first_error {
                Some(error) => Err(error),
                None => Ok(WakeResult::Ran(report)),
            };
        }
    }

    fn drain_pass<Q, T>(&self, queue: &Q, transport: &T, now_ms: u64) -> Result<DrainReport, String>
    where
        Q: DrainQueue,
        T: UploadTransport,
    {
        let mut report = DrainReport {
            passes: 1,
            ..DrainReport::default()
        };
        if let TransportAvailability::Held { code, message } = transport.availability() {
            let summary = queue.summary()?;
            report.held = summary.queued();
            report.remaining = summary.queued();
            report.last_hold = Some(format!("{code}: {message}"));
            return Ok(report);
        }

        while let Some(item) = queue.claim_next(now_ms)? {
            report.attempted += 1;
            match transport.upload(&item) {
                UploadResult::Confirmed(acknowledgement)
                    if acknowledgement.capture_id == item.id =>
                {
                    queue.mark_uploaded(&item.id)?;
                    report.uploaded += 1;
                }
                UploadResult::Confirmed(acknowledgement) => {
                    let message = format!(
                        "Upload acknowledgement {} did not match claimed capture {}; the claimed capture remains queued.",
                        acknowledgement.capture_id, item.id
                    );
                    queue.mark_failed(&item.id, now_ms, &message)?;
                    report.retrying += 1;
                }
                UploadResult::Retryable { message } => {
                    queue.mark_failed(&item.id, now_ms, &message)?;
                    report.retrying += 1;
                }
                UploadResult::Held { message } => {
                    queue.mark_held(&item.id, &message)?;
                    report.held += 1;
                    report.last_hold = Some(message);
                    break;
                }
                UploadResult::Terminal { message } => {
                    queue.mark_terminal(&item.id, &message)?;
                }
            }
        }
        report.remaining = queue.summary()?.queued();
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DrainCoordinator, DrainQueue, DrainWake, TransportAvailability, UploadAcknowledgement,
        UploadResult, UploadTransport, WakeResult,
    };
    use crate::queue::{
        DurableUploadQueue, QueueItem, QueueItemStatus, QueueSource, QueueSummary, RETRY_DELAYS_MS,
    };
    use std::{
        collections::VecDeque,
        fs,
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Condvar, Mutex,
        },
        thread,
    };

    const FIRST_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";
    const SECOND_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92271";
    const THIRD_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92272";

    fn capture(directory: &Path, id: &str) -> std::path::PathBuf {
        fs::create_dir_all(directory).expect("create capture directory");
        let path = directory.join(format!("{id}.png"));
        fs::write(&path, b"\x89PNG\r\n\x1a\ndrain fixture").expect("write capture fixture");
        path
    }

    #[derive(Debug)]
    struct ScriptedTransport {
        availability: Mutex<TransportAvailability>,
        outcomes: Mutex<VecDeque<UploadResult>>,
        calls: Mutex<Vec<String>>,
    }

    impl ScriptedTransport {
        fn new(availability: TransportAvailability, outcomes: Vec<UploadResult>) -> Self {
            Self {
                availability: Mutex::new(availability),
                outcomes: Mutex::new(outcomes.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn set_availability(&self, availability: TransportAvailability) {
            *self.availability.lock().expect("availability lock") = availability;
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    impl UploadTransport for ScriptedTransport {
        fn availability(&self) -> TransportAvailability {
            self.availability.lock().expect("availability lock").clone()
        }

        fn upload(&self, item: &QueueItem) -> UploadResult {
            self.calls.lock().expect("calls lock").push(item.id.clone());
            self.outcomes
                .lock()
                .expect("outcomes lock")
                .pop_front()
                .unwrap_or_else(|| {
                    UploadResult::Confirmed(UploadAcknowledgement {
                        capture_id: item.id.clone(),
                    })
                })
        }
    }

    #[test]
    fn offline_wake_consumes_no_attempt_then_reconnect_drains_fifo_idempotently() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let first = capture(&captures, FIRST_ID);
        let second = capture(&captures, SECOND_ID);
        let third = capture(&captures, THIRD_ID);
        let queue =
            Mutex::new(DurableUploadQueue::open(&store, &captures, 0).expect("open durable queue"));
        {
            let mut queue = queue.lock().expect("queue lock");
            queue
                .enqueue(&second, QueueSource::Window, 2)
                .expect("enqueue second");
            queue
                .enqueue(&first, QueueSource::Region, 1)
                .expect("enqueue first");
            queue
                .enqueue(&third, QueueSource::Fullscreen, 3)
                .expect("enqueue third");
        }
        let transport = ScriptedTransport::new(
            TransportAvailability::Held {
                code: "offline",
                message: "No network route is available.".into(),
            },
            Vec::new(),
        );
        let coordinator = DrainCoordinator::default();

        let offline = coordinator
            .wake(DrainWake::Startup, &queue, &transport, 100)
            .expect("offline wake");
        let WakeResult::Ran(offline) = offline else {
            panic!("initial wake must run");
        };
        assert_eq!(offline.attempted, 0);
        assert_eq!(offline.held, 3);
        assert!(transport.calls().is_empty());
        for id in [FIRST_ID, SECOND_ID, THIRD_ID] {
            let queue = queue.lock().expect("queue lock");
            assert_eq!(queue.item(id).expect("queued item").attempts, 0);
            assert_eq!(
                queue.item(id).expect("queued item").status,
                QueueItemStatus::Pending
            );
        }

        transport.set_availability(TransportAvailability::Ready);
        let reconnected = coordinator
            .wake(DrainWake::ConnectivityRestored, &queue, &transport, 101)
            .expect("reconnect wake");
        let WakeResult::Ran(reconnected) = reconnected else {
            panic!("reconnect wake must run");
        };
        assert_eq!(reconnected.attempted, 3);
        assert_eq!(reconnected.uploaded, 3);
        assert_eq!(reconnected.remaining, 0);
        assert_eq!(transport.calls(), [FIRST_ID, SECOND_ID, THIRD_ID]);
        drop(queue);

        let mut restarted =
            DurableUploadQueue::open(&store, &captures, 500).expect("restart completed queue");
        assert_eq!(restarted.summary().uploaded, 3);
        assert!(restarted
            .claim_next(500)
            .expect("inspect restarted queue")
            .is_none());
        assert!(first.exists() && second.exists() && third.exists());
    }

    #[test]
    fn mismatched_ack_never_completes_claimed_item_or_blocks_healthy_work() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let first = capture(&captures, FIRST_ID);
        let second = capture(&captures, SECOND_ID);
        let queue =
            Mutex::new(DurableUploadQueue::open(&store, &captures, 0).expect("open durable queue"));
        {
            let mut queue = queue.lock().expect("queue lock");
            queue
                .enqueue(&first, QueueSource::Region, 1)
                .expect("enqueue first");
            queue
                .enqueue(&second, QueueSource::Window, 2)
                .expect("enqueue second");
        }
        let transport = ScriptedTransport::new(
            TransportAvailability::Ready,
            vec![
                UploadResult::Confirmed(UploadAcknowledgement {
                    capture_id: THIRD_ID.into(),
                }),
                UploadResult::Confirmed(UploadAcknowledgement {
                    capture_id: SECOND_ID.into(),
                }),
            ],
        );

        let result = DrainCoordinator::default()
            .wake(DrainWake::CaptureEnqueued, &queue, &transport, 100)
            .expect("drain queue");
        let WakeResult::Ran(report) = result else {
            panic!("wake must run");
        };
        assert_eq!(report.attempted, 2);
        assert_eq!(report.uploaded, 1);
        assert_eq!(report.retrying, 1);
        let queue = queue.lock().expect("queue lock");
        let rejected = queue.item(FIRST_ID).expect("first remains queued");
        assert_eq!(rejected.status, QueueItemStatus::Failed);
        assert_eq!(rejected.attempts, 1);
        assert_eq!(rejected.next_attempt_at_ms, Some(100 + RETRY_DELAYS_MS[0]));
        assert!(rejected
            .last_error
            .as_deref()
            .expect("actionable mismatch")
            .contains(THIRD_ID));
        assert_eq!(
            queue.item(SECOND_ID).expect("second item").status,
            QueueItemStatus::Uploaded
        );
        assert!(first.exists() && second.exists());
    }

    #[test]
    fn credential_hold_releases_claim_without_consuming_attempt() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let source = capture(&captures, FIRST_ID);
        let queue =
            Mutex::new(DurableUploadQueue::open(&store, &captures, 0).expect("open durable queue"));
        queue
            .lock()
            .expect("queue lock")
            .enqueue(&source, QueueSource::Region, 1)
            .expect("enqueue capture");
        let transport = ScriptedTransport::new(
            TransportAvailability::Ready,
            vec![UploadResult::Held {
                message: "The session expired during upload.".into(),
            }],
        );
        let coordinator = DrainCoordinator::default();

        let first = coordinator
            .wake(DrainWake::CaptureEnqueued, &queue, &transport, 10)
            .expect("held wake");
        let WakeResult::Ran(first) = first else {
            panic!("wake must run");
        };
        assert_eq!(first.attempted, 1);
        assert_eq!(first.held, 1);
        {
            let queue = queue.lock().expect("queue lock");
            let held = queue.item(FIRST_ID).expect("held item");
            assert_eq!(held.status, QueueItemStatus::Pending);
            assert_eq!(held.attempts, 0);
            assert_eq!(held.next_attempt_at_ms, None);
        }

        let restored = coordinator
            .wake(DrainWake::CredentialsRestored, &queue, &transport, 11)
            .expect("credentials restored wake");
        let WakeResult::Ran(restored) = restored else {
            panic!("wake must run");
        };
        assert_eq!(restored.uploaded, 1);
        assert_eq!(
            queue
                .lock()
                .expect("queue lock")
                .item(FIRST_ID)
                .expect("uploaded item")
                .status,
            QueueItemStatus::Uploaded
        );
        assert!(source.exists());
    }

    #[test]
    fn retryable_failure_is_scheduled_while_later_healthy_item_completes() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let first = capture(&captures, FIRST_ID);
        let second = capture(&captures, SECOND_ID);
        let queue =
            Mutex::new(DurableUploadQueue::open(&store, &captures, 0).expect("open durable queue"));
        {
            let mut queue = queue.lock().expect("queue lock");
            queue
                .enqueue(&first, QueueSource::Region, 1)
                .expect("enqueue first");
            queue
                .enqueue(&second, QueueSource::Window, 2)
                .expect("enqueue second");
        }
        let transport = ScriptedTransport::new(
            TransportAvailability::Ready,
            vec![
                UploadResult::Retryable {
                    message: "Temporary storage timeout.".into(),
                },
                UploadResult::Confirmed(UploadAcknowledgement {
                    capture_id: SECOND_ID.into(),
                }),
            ],
        );

        let result = DrainCoordinator::default()
            .wake(DrainWake::RetryDeadline, &queue, &transport, 1_000)
            .expect("drain queue");
        let WakeResult::Ran(report) = result else {
            panic!("wake must run");
        };
        assert_eq!(report.retrying, 1);
        assert_eq!(report.uploaded, 1);
        assert_eq!(transport.calls(), [FIRST_ID, SECOND_ID]);
        let queue = queue.lock().expect("queue lock");
        assert_eq!(
            queue.item(FIRST_ID).expect("retrying item").status,
            QueueItemStatus::Failed
        );
        assert_eq!(
            queue.item(SECOND_ID).expect("uploaded item").status,
            QueueItemStatus::Uploaded
        );
    }

    #[test]
    fn terminal_transport_rejection_stops_retrying_without_blocking_later_work() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let first = capture(&captures, FIRST_ID);
        let second = capture(&captures, SECOND_ID);
        let queue =
            Mutex::new(DurableUploadQueue::open(&store, &captures, 0).expect("open durable queue"));
        {
            let mut queue = queue.lock().expect("queue lock");
            queue
                .enqueue(&first, QueueSource::Region, 1)
                .expect("enqueue first");
            queue
                .enqueue(&second, QueueSource::Window, 2)
                .expect("enqueue second");
        }
        let transport = ScriptedTransport::new(
            TransportAvailability::Ready,
            vec![
                UploadResult::Terminal {
                    message: "The server rejected invalid immutable metadata.".into(),
                },
                UploadResult::Confirmed(UploadAcknowledgement {
                    capture_id: SECOND_ID.into(),
                }),
            ],
        );

        DrainCoordinator::default()
            .wake(DrainWake::CaptureEnqueued, &queue, &transport, 100)
            .expect("drain queue");
        let queue = queue.lock().expect("queue lock");
        let rejected = queue.item(FIRST_ID).expect("terminal item retained");
        assert!(rejected.is_terminal());
        assert_eq!(rejected.next_attempt_at_ms, None);
        assert_eq!(
            queue.item(SECOND_ID).expect("healthy item").status,
            QueueItemStatus::Uploaded
        );
        assert!(first.exists() && second.exists());
    }

    #[derive(Debug, Default)]
    struct BlockingTransport {
        gate: (Mutex<(bool, bool)>, Condvar),
        calls: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
    }

    impl BlockingTransport {
        fn wait_until_entered(&self) {
            let (state, changed) = &self.gate;
            let mut state = state.lock().expect("gate lock");
            while !state.0 {
                state = changed.wait(state).expect("wait for upload");
            }
        }

        fn release(&self) {
            let (state, changed) = &self.gate;
            let mut state = state.lock().expect("gate lock");
            state.1 = true;
            changed.notify_all();
        }
    }

    impl UploadTransport for BlockingTransport {
        fn availability(&self) -> TransportAvailability {
            TransportAvailability::Ready
        }

        fn upload(&self, item: &QueueItem) -> UploadResult {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            self.calls.fetch_add(1, Ordering::SeqCst);
            let (state, changed) = &self.gate;
            let mut state = state.lock().expect("gate lock");
            state.0 = true;
            changed.notify_all();
            while !state.1 {
                state = changed.wait(state).expect("wait for release");
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            UploadResult::Confirmed(UploadAcknowledgement {
                capture_id: item.id.clone(),
            })
        }
    }

    #[test]
    fn overlapping_wakes_coalesce_into_one_transport_runner() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let source = capture(&captures, FIRST_ID);
        let queue = Arc::new(Mutex::new(
            DurableUploadQueue::open(&store, &captures, 0).expect("open durable queue"),
        ));
        queue
            .lock()
            .expect("queue lock")
            .enqueue(&source, QueueSource::Region, 1)
            .expect("enqueue capture");
        let coordinator = Arc::new(DrainCoordinator::default());
        let transport = Arc::new(BlockingTransport::default());

        let runner = {
            let queue = Arc::clone(&queue);
            let coordinator = Arc::clone(&coordinator);
            let transport = Arc::clone(&transport);
            thread::spawn(move || {
                coordinator
                    .wake(
                        DrainWake::CaptureEnqueued,
                        queue.as_ref(),
                        transport.as_ref(),
                        10,
                    )
                    .expect("first wake")
            })
        };
        transport.wait_until_entered();
        let overlap = coordinator
            .wake(
                DrainWake::ConnectivityRestored,
                queue.as_ref(),
                transport.as_ref(),
                11,
            )
            .expect("overlapping wake");
        assert_eq!(overlap, WakeResult::Coalesced);
        transport.release();
        let first = runner.join().expect("join drain runner");
        let WakeResult::Ran(report) = first else {
            panic!("first wake must run");
        };
        assert_eq!(report.passes, 2);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
        assert_eq!(transport.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(report.uploaded, 1);
    }

    #[derive(Debug, Default)]
    struct FailOnceBlockingQueue {
        gate: (Mutex<(bool, bool)>, Condvar),
        claims: AtomicUsize,
    }

    impl FailOnceBlockingQueue {
        fn wait_until_claimed(&self) {
            let (state, changed) = &self.gate;
            let mut state = state.lock().expect("gate lock");
            while !state.0 {
                state = changed.wait(state).expect("wait for claim");
            }
        }

        fn release_error(&self) {
            let (state, changed) = &self.gate;
            let mut state = state.lock().expect("gate lock");
            state.1 = true;
            changed.notify_all();
        }
    }

    impl DrainQueue for FailOnceBlockingQueue {
        fn claim_next(&self, _now_ms: u64) -> Result<Option<QueueItem>, String> {
            let claim = self.claims.fetch_add(1, Ordering::SeqCst);
            if claim != 0 {
                return Ok(None);
            }
            let (state, changed) = &self.gate;
            let mut state = state.lock().expect("gate lock");
            state.0 = true;
            changed.notify_all();
            while !state.1 {
                state = changed.wait(state).expect("wait for release");
            }
            Err("Injected transient queue read failure.".into())
        }

        fn mark_uploaded(&self, _id: &str) -> Result<(), String> {
            panic!("no item can be uploaded in this fixture")
        }

        fn mark_failed(&self, _id: &str, _failed_at_ms: u64, _error: &str) -> Result<(), String> {
            panic!("no item can fail in this fixture")
        }

        fn mark_terminal(&self, _id: &str, _error: &str) -> Result<(), String> {
            panic!("no item can fail terminally in this fixture")
        }

        fn mark_held(&self, _id: &str, _message: &str) -> Result<(), String> {
            panic!("no item can be held in this fixture")
        }

        fn summary(&self) -> Result<QueueSummary, String> {
            Ok(QueueSummary::default())
        }
    }

    #[test]
    fn coalesced_wake_is_handed_off_even_when_the_active_pass_errors() {
        let queue = Arc::new(FailOnceBlockingQueue::default());
        let coordinator = Arc::new(DrainCoordinator::default());
        let transport = Arc::new(ScriptedTransport::new(
            TransportAvailability::Ready,
            Vec::new(),
        ));
        let runner = {
            let queue = Arc::clone(&queue);
            let coordinator = Arc::clone(&coordinator);
            let transport = Arc::clone(&transport);
            thread::spawn(move || {
                coordinator.wake(
                    DrainWake::CaptureEnqueued,
                    queue.as_ref(),
                    transport.as_ref(),
                    10,
                )
            })
        };

        queue.wait_until_claimed();
        assert_eq!(
            coordinator
                .wake(
                    DrainWake::ConnectivityRestored,
                    queue.as_ref(),
                    transport.as_ref(),
                    11,
                )
                .expect("overlapping wake"),
            WakeResult::Coalesced
        );
        queue.release_error();

        let error = runner
            .join()
            .expect("join drain runner")
            .expect_err("first pass error remains visible");
        assert!(error.contains("Injected transient queue read failure"));
        assert_eq!(
            queue.claims.load(Ordering::SeqCst),
            2,
            "the coalesced wake must own a fresh pass after the error"
        );
    }
}
