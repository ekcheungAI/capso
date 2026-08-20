use crate::shortcuts::CaptureAction;
use serde::Serialize;

pub(crate) const TIMER_LABEL: &str = "capture-timer";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureTimerStatus {
    pub(crate) generation: u64,
    pub(crate) running: bool,
    pub(crate) seconds_remaining: u8,
    pub(crate) mode: CaptureAction,
    pub(crate) freeze_screen: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ActiveTimer {
    seconds_remaining: u8,
    target: CaptureTimerTarget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CaptureTimerTarget {
    pub(crate) mode: CaptureAction,
    pub(crate) freeze_screen: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StartOutcome {
    Started(CaptureTimerStatus),
    AlreadyRunning(CaptureTimerStatus),
}

pub(crate) struct CaptureTimerRuntime {
    generation: u64,
    active: Option<ActiveTimer>,
    last_mode: CaptureAction,
}

impl Default for CaptureTimerRuntime {
    fn default() -> Self {
        Self {
            generation: 0,
            active: None,
            last_mode: CaptureAction::Region,
        }
    }
}

impl CaptureTimerRuntime {
    pub(crate) fn is_running(&self) -> bool {
        self.active.is_some()
    }

    pub(crate) fn status(&self) -> CaptureTimerStatus {
        let active = self.active;
        CaptureTimerStatus {
            generation: self.generation,
            running: active.is_some(),
            seconds_remaining: active.map_or(0, |timer| timer.seconds_remaining),
            mode: active.map_or(self.last_mode, |timer| timer.target.mode),
            freeze_screen: active.is_some_and(|timer| timer.target.freeze_screen),
        }
    }

    pub(crate) fn start(
        &mut self,
        mode: CaptureAction,
        seconds: u8,
        freeze_screen: bool,
    ) -> StartOutcome {
        debug_assert!(seconds > 0, "zero-delay captures must bypass the timer");
        if self.active.is_some() {
            return StartOutcome::AlreadyRunning(self.status());
        }
        self.generation = self
            .generation
            .checked_add(1)
            .expect("capture timer generation cannot exhaust u64");
        self.active = Some(ActiveTimer {
            seconds_remaining: seconds,
            target: CaptureTimerTarget {
                mode,
                freeze_screen,
            },
        });
        self.last_mode = mode;
        StartOutcome::Started(self.status())
    }

    pub(crate) fn tick(
        &mut self,
        generation: u64,
        seconds_remaining: u8,
    ) -> Option<CaptureTimerStatus> {
        if self.generation != generation || self.active.is_none() {
            return None;
        }
        if let Some(active) = &mut self.active {
            active.seconds_remaining = seconds_remaining;
        }
        Some(self.status())
    }

    pub(crate) fn finish(&mut self, generation: u64) -> Option<CaptureTimerTarget> {
        if self.generation != generation {
            return None;
        }
        self.active.take().map(|active| active.target)
    }

    pub(crate) fn cancel(&mut self) -> Option<CaptureTimerStatus> {
        self.active?;
        self.generation = self
            .generation
            .checked_add(1)
            .expect("capture timer generation cannot exhaust u64");
        self.active = None;
        Some(self.status())
    }
}

#[cfg(test)]
mod tests {
    use super::{CaptureTimerRuntime, StartOutcome};
    use crate::shortcuts::CaptureAction;

    #[test]
    fn start_is_single_flight_and_counts_down() {
        let mut timer = CaptureTimerRuntime::default();
        let StartOutcome::Started(started) = timer.start(CaptureAction::Window, 3, false) else {
            panic!("first timer should start");
        };
        assert_eq!(started.seconds_remaining, 3);
        assert_eq!(started.mode, CaptureAction::Window);
        assert!(matches!(
            timer.start(CaptureAction::Fullscreen, 10, false),
            StartOutcome::AlreadyRunning(_)
        ));

        let tick = timer
            .tick(started.generation, 2)
            .expect("timer should tick");
        assert_eq!(tick.seconds_remaining, 2);
        assert_eq!(
            timer.finish(started.generation),
            Some(super::CaptureTimerTarget {
                mode: CaptureAction::Window,
                freeze_screen: false,
            })
        );
        assert!(!timer.status().running);
    }

    #[test]
    fn cancel_invalidates_the_sleeping_timer_task() {
        let mut timer = CaptureTimerRuntime::default();
        let StartOutcome::Started(started) = timer.start(CaptureAction::Fullscreen, 10, false)
        else {
            panic!("timer should start");
        };

        let cancelled = timer.cancel().expect("running timer should cancel");
        assert!(!cancelled.running);
        assert_eq!(cancelled.mode, CaptureAction::Fullscreen);
        assert_ne!(cancelled.generation, started.generation);
        assert_eq!(timer.tick(started.generation, 4), None);
        assert_eq!(timer.finish(started.generation), None);
    }

    #[test]
    fn direct_capture_is_blocked_only_while_a_timer_owns_the_next_capture() {
        let mut timer = CaptureTimerRuntime::default();
        assert!(!timer.is_running());

        let StartOutcome::Started(started) = timer.start(CaptureAction::Region, 5, false) else {
            panic!("timer should start");
        };
        assert!(timer.is_running());

        assert_eq!(
            timer.finish(started.generation),
            Some(super::CaptureTimerTarget {
                mode: CaptureAction::Region,
                freeze_screen: false,
            })
        );
        assert!(!timer.is_running());
    }

    #[test]
    fn frozen_area_target_survives_the_entire_timer() {
        let mut timer = CaptureTimerRuntime::default();
        let StartOutcome::Started(started) = timer.start(CaptureAction::Region, 3, true) else {
            panic!("frozen timer should start");
        };
        assert!(started.freeze_screen);

        let ticked = timer
            .tick(started.generation, 2)
            .expect("timer should tick");
        assert!(ticked.freeze_screen);
        assert_eq!(
            timer.finish(started.generation),
            Some(super::CaptureTimerTarget {
                mode: CaptureAction::Region,
                freeze_screen: true,
            })
        );
    }
}
