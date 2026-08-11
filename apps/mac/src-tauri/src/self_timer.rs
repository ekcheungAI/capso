use serde::Serialize;

pub(crate) const TIMER_LABEL: &str = "capture-timer";
pub(crate) const TIMER_SECONDS: u8 = 5;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegionTimerStatus {
    pub(crate) generation: u64,
    pub(crate) running: bool,
    pub(crate) seconds_remaining: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StartOutcome {
    Started(RegionTimerStatus),
    AlreadyRunning(RegionTimerStatus),
}

#[derive(Default)]
pub(crate) struct RegionTimerRuntime {
    generation: u64,
    seconds_remaining: Option<u8>,
}

impl RegionTimerRuntime {
    pub(crate) fn status(&self) -> RegionTimerStatus {
        RegionTimerStatus {
            generation: self.generation,
            running: self.seconds_remaining.is_some(),
            seconds_remaining: self.seconds_remaining.unwrap_or(0),
        }
    }

    pub(crate) fn start(&mut self) -> StartOutcome {
        if self.seconds_remaining.is_some() {
            return StartOutcome::AlreadyRunning(self.status());
        }
        self.generation = self
            .generation
            .checked_add(1)
            .expect("region timer generation cannot exhaust u64");
        self.seconds_remaining = Some(TIMER_SECONDS);
        StartOutcome::Started(self.status())
    }

    pub(crate) fn tick(
        &mut self,
        generation: u64,
        seconds_remaining: u8,
    ) -> Option<RegionTimerStatus> {
        if self.generation != generation || self.seconds_remaining.is_none() {
            return None;
        }
        self.seconds_remaining = Some(seconds_remaining);
        Some(self.status())
    }

    pub(crate) fn finish(&mut self, generation: u64) -> bool {
        if self.generation != generation || self.seconds_remaining.is_none() {
            return false;
        }
        self.seconds_remaining = None;
        true
    }

    pub(crate) fn cancel(&mut self) -> Option<RegionTimerStatus> {
        self.seconds_remaining?;
        self.generation = self
            .generation
            .checked_add(1)
            .expect("region timer generation cannot exhaust u64");
        self.seconds_remaining = None;
        Some(self.status())
    }
}

#[cfg(test)]
mod tests {
    use super::{RegionTimerRuntime, StartOutcome, TIMER_SECONDS};

    #[test]
    fn start_is_single_flight_and_counts_down() {
        let mut timer = RegionTimerRuntime::default();
        let StartOutcome::Started(started) = timer.start() else {
            panic!("first timer should start");
        };
        assert_eq!(started.seconds_remaining, TIMER_SECONDS);
        assert!(matches!(timer.start(), StartOutcome::AlreadyRunning(_)));

        let tick = timer
            .tick(started.generation, 4)
            .expect("timer should tick");
        assert_eq!(tick.seconds_remaining, 4);
        assert!(timer.finish(started.generation));
        assert!(!timer.status().running);
    }

    #[test]
    fn cancel_invalidates_the_sleeping_timer_task() {
        let mut timer = RegionTimerRuntime::default();
        let StartOutcome::Started(started) = timer.start() else {
            panic!("timer should start");
        };

        let cancelled = timer.cancel().expect("running timer should cancel");
        assert!(!cancelled.running);
        assert_ne!(cancelled.generation, started.generation);
        assert_eq!(timer.tick(started.generation, 4), None);
        assert!(!timer.finish(started.generation));
    }
}
