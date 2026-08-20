use crate::drain::DrainWake;
use std::{
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Mutex,
    },
    time::Duration,
};

pub(crate) const CONNECTIVITY_POLL_INTERVAL_MS: u64 = 5_000;
pub(crate) const RETRY_WAKE_REARM_MS: u64 = 30_000;
pub(crate) const REMOTE_DISCOVERY_INTERVAL_MS: u64 = 60_000;

const CONNECTIVITY_UNKNOWN: u8 = 0;
const CONNECTIVITY_OFFLINE: u8 = 1;
const CONNECTIVITY_ONLINE: u8 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectivityTransition {
    InitializedOnline,
    InitializedOffline,
    Lost,
    Restored,
    Unchanged,
}

#[derive(Debug, Default)]
pub(crate) struct ConnectivityState(AtomicU8);

impl ConnectivityState {
    pub(crate) fn permits_sync(&self) -> bool {
        self.0.load(Ordering::SeqCst) != CONNECTIVITY_OFFLINE
    }

    pub(crate) fn observe(&self, reachable: bool) -> ConnectivityTransition {
        let next = if reachable {
            CONNECTIVITY_ONLINE
        } else {
            CONNECTIVITY_OFFLINE
        };
        match (self.0.swap(next, Ordering::SeqCst), next) {
            (CONNECTIVITY_UNKNOWN, CONNECTIVITY_ONLINE) => {
                ConnectivityTransition::InitializedOnline
            }
            (CONNECTIVITY_UNKNOWN, CONNECTIVITY_OFFLINE) => {
                ConnectivityTransition::InitializedOffline
            }
            (CONNECTIVITY_OFFLINE, CONNECTIVITY_ONLINE) => ConnectivityTransition::Restored,
            (CONNECTIVITY_ONLINE, CONNECTIVITY_OFFLINE) => ConnectivityTransition::Lost,
            _ => ConnectivityTransition::Unchanged,
        }
    }

    pub(crate) fn observe_probe(&self, reachable: Option<bool>) -> ConnectivityTransition {
        reachable
            .map(|reachable| self.observe(reachable))
            .unwrap_or(ConnectivityTransition::Unchanged)
    }

    fn is_online(&self) -> bool {
        self.0.load(Ordering::SeqCst) == CONNECTIVITY_ONLINE
    }
}

#[derive(Debug, Default)]
pub(crate) struct RetryDeadlinePlanner {
    fired_deadline_ms: Option<u64>,
    fired_at_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub(crate) struct RemoteDiscoveryPlanner {
    next_poll_at_ms: Option<u64>,
}

impl RemoteDiscoveryPlanner {
    pub(crate) fn observe(
        &mut self,
        now_ms: u64,
        signed_in: bool,
        connectivity_available: bool,
    ) -> Option<DrainWake> {
        if !signed_in {
            self.next_poll_at_ms = None;
            return None;
        }
        let deadline = *self
            .next_poll_at_ms
            .get_or_insert_with(|| now_ms.saturating_add(REMOTE_DISCOVERY_INTERVAL_MS));
        if connectivity_available && deadline <= now_ms {
            self.next_poll_at_ms = Some(now_ms.saturating_add(REMOTE_DISCOVERY_INTERVAL_MS));
            Some(DrainWake::RemotePoll)
        } else {
            None
        }
    }

    pub(crate) fn wait_ms(&self, now_ms: u64, signed_in: bool) -> Option<u64> {
        if !signed_in {
            return None;
        }
        self.next_poll_at_ms.map(|deadline| {
            let remaining = deadline.saturating_sub(now_ms);
            if remaining == 0 {
                CONNECTIVITY_POLL_INTERVAL_MS
            } else {
                remaining
            }
        })
    }
}

impl RetryDeadlinePlanner {
    pub(crate) fn observe(
        &mut self,
        now_ms: u64,
        next_retry_at_ms: Option<u64>,
        connectivity_available: bool,
    ) -> Option<DrainWake> {
        if next_retry_at_ms != self.fired_deadline_ms {
            self.fired_deadline_ms = None;
            self.fired_at_ms = None;
        }
        let deadline = next_retry_at_ms?;
        let suppressed = self.fired_deadline_ms == Some(deadline)
            && self
                .fired_at_ms
                .is_some_and(|fired_at| now_ms < fired_at.saturating_add(RETRY_WAKE_REARM_MS));
        if connectivity_available && deadline <= now_ms && !suppressed {
            self.fired_deadline_ms = Some(deadline);
            self.fired_at_ms = Some(now_ms);
            Some(DrainWake::RetryDeadline)
        } else {
            None
        }
    }

    pub(crate) fn wait_ms(
        now_ms: u64,
        next_retry_at_ms: Option<u64>,
        has_retryable_work: bool,
        connectivity: &ConnectivityState,
    ) -> Option<u64> {
        if !has_retryable_work {
            return None;
        }
        if let Some(deadline) = next_retry_at_ms {
            let until_deadline = deadline.saturating_sub(now_ms);
            return Some(if until_deadline == 0 {
                CONNECTIVITY_POLL_INTERVAL_MS
            } else {
                until_deadline.min(CONNECTIVITY_POLL_INTERVAL_MS)
            });
        }
        (!connectivity.is_online()).then_some(CONNECTIVITY_POLL_INTERVAL_MS)
    }
}

#[derive(Debug)]
pub(crate) struct RetryMonitorSignal {
    sender: SyncSender<()>,
    receiver: Mutex<Option<Receiver<()>>>,
}

impl Default for RetryMonitorSignal {
    fn default() -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
        }
    }
}

impl RetryMonitorSignal {
    pub(crate) fn notify(&self) {
        match self.sender.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) | Err(TrySendError::Disconnected(())) => {}
        }
    }

    pub(crate) fn take_receiver(&self) -> Result<Receiver<()>, String> {
        self.receiver
            .lock()
            .map_err(|_| "Capso's retry monitor signal is temporarily unavailable.".to_string())?
            .take()
            .ok_or_else(|| "Capso's retry monitor is already running.".into())
    }

    pub(crate) fn wait(receiver: &Receiver<()>, timeout_ms: Option<u64>) {
        match timeout_ms {
            Some(timeout_ms) => {
                let _ = receiver.recv_timeout(Duration::from_millis(timeout_ms));
            }
            None => {
                let _ = receiver.recv();
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) struct SystemConnectivityProbe(
    system_configuration::network_reachability::SCNetworkReachability,
);

#[cfg(target_os = "macos")]
impl SystemConnectivityProbe {
    pub(crate) fn new() -> Result<Self, String> {
        let default_route = "0.0.0.0:0"
            .parse::<std::net::SocketAddr>()
            .map_err(|error| {
                format!("Capso could not prepare its network-route monitor: {error}")
            })?;
        Ok(Self(
            system_configuration::network_reachability::SCNetworkReachability::from(default_route),
        ))
    }

    pub(crate) fn is_reachable(&self) -> Result<bool, String> {
        use system_configuration::network_reachability::ReachabilityFlags;

        let flags = self
            .0
            .reachability()
            .map_err(|error| format!("Capso could not inspect its network route: {error}"))?;
        let can_connect_automatically = flags.intersects(
            ReachabilityFlags::CONNECTION_ON_DEMAND | ReachabilityFlags::CONNECTION_ON_TRAFFIC,
        );
        Ok(flags.contains(ReachabilityFlags::REACHABLE)
            && (!flags.contains(ReachabilityFlags::CONNECTION_REQUIRED)
                || can_connect_automatically)
            && !flags.contains(ReachabilityFlags::INTERVENTION_REQUIRED))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectivityState, ConnectivityTransition, RemoteDiscoveryPlanner, RetryDeadlinePlanner,
        CONNECTIVITY_POLL_INTERVAL_MS, REMOTE_DISCOVERY_INTERVAL_MS, RETRY_WAKE_REARM_MS,
    };
    use crate::drain::DrainWake;

    #[test]
    fn connectivity_restoration_wakes_once_after_a_known_offline_state() {
        let state = ConnectivityState::default();

        assert!(state.permits_sync(), "unknown connectivity must fail open");
        assert_eq!(
            state.observe(true),
            ConnectivityTransition::InitializedOnline
        );
        assert_eq!(state.observe(true), ConnectivityTransition::Unchanged);
        assert_eq!(state.observe(false), ConnectivityTransition::Lost);
        assert!(!state.permits_sync());
        assert_eq!(state.observe(false), ConnectivityTransition::Unchanged);
        assert_eq!(state.observe(true), ConnectivityTransition::Restored);
        assert!(state.permits_sync());
        assert_eq!(state.observe(true), ConnectivityTransition::Unchanged);
    }

    #[test]
    fn transient_probe_error_preserves_offline_until_online_restores() {
        let state = ConnectivityState::default();

        assert_eq!(
            state.observe_probe(Some(false)),
            ConnectivityTransition::InitializedOffline
        );
        assert_eq!(state.observe_probe(None), ConnectivityTransition::Unchanged);
        assert!(!state.permits_sync());
        assert_eq!(
            state.observe_probe(Some(true)),
            ConnectivityTransition::Restored
        );
    }

    #[test]
    fn retry_deadline_wakes_once_at_the_exact_deadline_and_rearms_on_change() {
        let mut planner = RetryDeadlinePlanner::default();

        assert_eq!(planner.observe(4_999, Some(5_000), true), None);
        assert_eq!(
            planner.observe(5_000, Some(5_000), true),
            Some(DrainWake::RetryDeadline)
        );
        assert_eq!(planner.observe(5_001, Some(5_000), true), None);
        assert_eq!(planner.observe(9_999, Some(10_000), true), None);
        assert_eq!(
            planner.observe(10_000, Some(10_000), true),
            Some(DrainWake::RetryDeadline)
        );
        assert_eq!(planner.observe(10_001, None, true), None);
    }

    #[test]
    fn offline_deadlines_wait_for_connectivity_and_never_busy_loop() {
        let mut planner = RetryDeadlinePlanner::default();

        assert_eq!(planner.observe(5_000, Some(5_000), false), None);
        assert_eq!(planner.observe(6_000, Some(5_000), false), None);
        assert_eq!(
            planner.observe(6_001, Some(5_000), true),
            Some(DrainWake::RetryDeadline)
        );
        assert_eq!(planner.observe(6_002, Some(5_000), true), None);
    }

    #[test]
    fn unchanged_overdue_deadline_rearms_after_a_bounded_hold() {
        let mut planner = RetryDeadlinePlanner::default();

        assert_eq!(
            planner.observe(5_000, Some(5_000), true),
            Some(DrainWake::RetryDeadline)
        );
        assert_eq!(
            planner.observe(5_000 + RETRY_WAKE_REARM_MS - 1, Some(5_000), true),
            None
        );
        assert_eq!(
            planner.observe(5_000 + RETRY_WAKE_REARM_MS, Some(5_000), true),
            Some(DrainWake::RetryDeadline)
        );
    }

    #[test]
    fn monitor_waits_for_a_signal_when_idle_or_online_without_a_deadline() {
        let state = ConnectivityState::default();
        state.observe(true);

        assert_eq!(
            RetryDeadlinePlanner::wait_ms(1_000, None, false, &state),
            None
        );
        assert_eq!(
            RetryDeadlinePlanner::wait_ms(1_000, None, true, &state),
            None
        );
        assert_eq!(
            RetryDeadlinePlanner::wait_ms(1_000, Some(20_000), true, &state),
            Some(CONNECTIVITY_POLL_INTERVAL_MS)
        );
        assert_eq!(
            RetryDeadlinePlanner::wait_ms(1_000, Some(1_250), true, &state),
            Some(250)
        );

        state.observe(false);
        assert_eq!(
            RetryDeadlinePlanner::wait_ms(1_000, None, true, &state),
            Some(CONNECTIVITY_POLL_INTERVAL_MS)
        );
    }

    #[test]
    fn remote_discovery_polls_only_while_signed_in_and_never_busy_loops_offline() {
        let mut planner = RemoteDiscoveryPlanner::default();
        assert_eq!(planner.observe(1_000, false, true), None);
        assert_eq!(planner.wait_ms(1_000, false), None);

        assert_eq!(planner.observe(1_000, true, true), None);
        assert_eq!(
            planner.wait_ms(1_000, true),
            Some(REMOTE_DISCOVERY_INTERVAL_MS)
        );
        assert_eq!(
            planner.observe(1_000 + REMOTE_DISCOVERY_INTERVAL_MS, true, true),
            Some(DrainWake::RemotePoll)
        );
        assert_eq!(
            planner.wait_ms(1_000 + REMOTE_DISCOVERY_INTERVAL_MS, true),
            Some(REMOTE_DISCOVERY_INTERVAL_MS)
        );

        let due = 1_000 + REMOTE_DISCOVERY_INTERVAL_MS * 2;
        assert_eq!(planner.observe(due, true, false), None);
        assert_eq!(
            planner.wait_ms(due, true),
            Some(CONNECTIVITY_POLL_INTERVAL_MS)
        );
        assert_eq!(
            planner.observe(due + CONNECTIVITY_POLL_INTERVAL_MS, true, true),
            Some(DrainWake::RemotePoll)
        );
        assert_eq!(
            planner.observe(due + CONNECTIVITY_POLL_INTERVAL_MS, false, true),
            None
        );
        assert_eq!(
            planner.wait_ms(due + CONNECTIVITY_POLL_INTERVAL_MS, false),
            None
        );
    }
}
