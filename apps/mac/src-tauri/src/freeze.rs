use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

pub(crate) const FREEZE_LABEL: &str = "freeze-screen";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FreezeFrame {
    pub(crate) generation: u64,
    pub(crate) path: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FreezeWait {
    Ready,
    Cancelled,
    TimedOut,
    Stale,
}

#[derive(Debug)]
struct ActiveFrame {
    generation: u64,
    path: PathBuf,
    ready: bool,
    cancelled: bool,
    picker_started: bool,
}

#[derive(Default, Debug)]
struct FreezeState {
    generation: u64,
    active: Option<ActiveFrame>,
}

#[derive(Default, Debug)]
pub(crate) struct FreezeCoordinator {
    state: Mutex<FreezeState>,
    changed: Condvar,
}

impl FreezeCoordinator {
    pub(crate) fn prepare(&self, path: PathBuf) -> Result<FreezeFrame, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Freeze Screen state is temporarily unavailable.".to_string())?;
        if state.active.is_some() {
            return Err("Another Freeze Screen capture is already active.".into());
        }
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| "Freeze Screen generation exhausted its safe range.".to_string())?;
        let generation = state.generation;
        let frame = FreezeFrame {
            generation,
            path: path.to_string_lossy().into_owned(),
        };
        state.active = Some(ActiveFrame {
            generation,
            path,
            ready: false,
            cancelled: false,
            picker_started: false,
        });
        Ok(frame)
    }

    pub(crate) fn current(&self) -> Option<FreezeFrame> {
        self.state.lock().ok().and_then(|state| {
            state.active.as_ref().map(|active| FreezeFrame {
                generation: active.generation,
                path: active.path.to_string_lossy().into_owned(),
            })
        })
    }

    pub(crate) fn mark_ready(&self, generation: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(active) = state
            .active
            .as_mut()
            .filter(|active| active.generation == generation && !active.cancelled)
        else {
            return false;
        };
        active.ready = true;
        self.changed.notify_all();
        true
    }

    pub(crate) fn cancel(&self, generation: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(active) = state
            .active
            .as_mut()
            .filter(|active| active.generation == generation && !active.picker_started)
        else {
            return false;
        };
        active.cancelled = true;
        self.changed.notify_all();
        true
    }

    pub(crate) fn begin_picker(&self, generation: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(active) = state.active.as_mut().filter(|active| {
            active.generation == generation
                && active.ready
                && !active.cancelled
                && !active.picker_started
        }) else {
            return false;
        };
        active.picker_started = true;
        true
    }

    pub(crate) fn wait_until_ready(&self, generation: u64, timeout: Duration) -> FreezeWait {
        let deadline = Instant::now().checked_add(timeout);
        let Ok(mut state) = self.state.lock() else {
            return FreezeWait::Stale;
        };
        loop {
            let Some(active) = state
                .active
                .as_ref()
                .filter(|active| active.generation == generation)
            else {
                return FreezeWait::Stale;
            };
            if active.cancelled {
                return FreezeWait::Cancelled;
            }
            if active.ready {
                return FreezeWait::Ready;
            }
            let Some(remaining) =
                deadline.and_then(|deadline| deadline.checked_duration_since(Instant::now()))
            else {
                return FreezeWait::TimedOut;
            };
            if remaining.is_zero() {
                return FreezeWait::TimedOut;
            }
            let Ok((next, waited)) = self.changed.wait_timeout(state, remaining) else {
                return FreezeWait::Stale;
            };
            state = next;
            if waited.timed_out() {
                continue;
            }
        }
    }

    pub(crate) fn cleanup(&self, generation: u64) -> Option<PathBuf> {
        let mut state = self.state.lock().ok()?;
        if state.active.as_ref()?.generation != generation {
            return None;
        }
        let path = state.active.take().map(|active| active.path);
        self.changed.notify_all();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::{FreezeCoordinator, FreezeWait};
    use std::{path::PathBuf, time::Duration};

    #[test]
    fn only_the_current_generation_can_ready_or_cancel_a_frame() {
        let coordinator = FreezeCoordinator::default();
        let frame = coordinator
            .prepare(PathBuf::from("/tmp/capso-freeze/current.png"))
            .expect("frame should prepare");

        assert!(!coordinator.mark_ready(frame.generation + 1));
        assert!(!coordinator.cancel(frame.generation + 1));
        assert_eq!(
            coordinator.wait_until_ready(frame.generation, Duration::ZERO),
            FreezeWait::TimedOut
        );

        assert!(coordinator.mark_ready(frame.generation));
        assert_eq!(
            coordinator.wait_until_ready(frame.generation, Duration::ZERO),
            FreezeWait::Ready
        );
        assert!(coordinator.begin_picker(frame.generation));
        assert!(!coordinator.cancel(frame.generation));
    }

    #[test]
    fn cancel_timeout_and_cleanup_never_become_ready() {
        let coordinator = FreezeCoordinator::default();
        let cancelled = coordinator
            .prepare(PathBuf::from("/tmp/capso-freeze/cancelled.png"))
            .expect("frame should prepare");
        assert!(coordinator.cancel(cancelled.generation));
        assert_eq!(
            coordinator.wait_until_ready(cancelled.generation, Duration::ZERO),
            FreezeWait::Cancelled
        );
        assert_eq!(
            coordinator.cleanup(cancelled.generation),
            Some(PathBuf::from("/tmp/capso-freeze/cancelled.png"))
        );
        assert_eq!(coordinator.current(), None);

        let timed_out = coordinator
            .prepare(PathBuf::from("/tmp/capso-freeze/timeout.png"))
            .expect("next frame should prepare after cleanup");
        assert_eq!(
            coordinator.wait_until_ready(timed_out.generation, Duration::ZERO),
            FreezeWait::TimedOut
        );
        assert_eq!(
            coordinator.cleanup(timed_out.generation),
            Some(PathBuf::from("/tmp/capso-freeze/timeout.png"))
        );
        assert_eq!(
            coordinator.wait_until_ready(timed_out.generation, Duration::ZERO),
            FreezeWait::Stale
        );
    }
}
