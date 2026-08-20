use serde::{Deserialize, Serialize};
use std::{
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

pub(crate) const AREA_SELECTOR_LABEL: &str = "area-selector";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AreaSelection {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DisplayGeometry {
    origin_x: i32,
    origin_y: i32,
    width: f64,
    height: f64,
    scale_factor: f64,
}

impl DisplayGeometry {
    pub(crate) fn new(
        origin_x: i32,
        origin_y: i32,
        width: f64,
        height: f64,
        scale_factor: f64,
    ) -> Result<Self, String> {
        if !width.is_finite()
            || !height.is_finite()
            || !scale_factor.is_finite()
            || !(1.0..=32_768.0).contains(&width)
            || !(1.0..=32_768.0).contains(&height)
            || !(0.5..=5.0).contains(&scale_factor)
        {
            return Err("The Area selector display is outside Capso's safe bounds.".into());
        }
        Ok(Self {
            origin_x,
            origin_y,
            width,
            height,
            scale_factor,
        })
    }

    fn validates(self, selection: AreaSelection) -> bool {
        let values = [selection.x, selection.y, selection.width, selection.height];
        if !values.into_iter().all(f64::is_finite)
            || selection.x < 0.0
            || selection.y < 0.0
            || selection.width <= 0.0
            || selection.height <= 0.0
            || selection.x + selection.width > self.width + f64::EPSILON
            || selection.y + selection.height > self.height + f64::EPSILON
        {
            return false;
        }
        let output_width = (selection.width * self.scale_factor).round();
        let output_height = (selection.height * self.scale_factor).round();
        (2.0..=32_768.0).contains(&output_width) && (2.0..=32_768.0).contains(&output_height)
    }

    pub(crate) fn capture_rect(
        self,
        selection: AreaSelection,
    ) -> Result<crate::capture::CaptureRect, String> {
        if !self.validates(selection) {
            return Err("The Area selection is outside the active display.".into());
        }
        let x = i64::from(self.origin_x) + selection.x.round() as i64;
        let y = i64::from(self.origin_y) + selection.y.round() as i64;
        let width = selection.width.round().clamp(2.0, 32_768.0) as u32;
        let height = selection.height.round().clamp(2.0, 32_768.0) as u32;
        let x = i32::try_from(x).map_err(|_| "The Area selection X coordinate is unsafe.")?;
        let y = i32::try_from(y).map_err(|_| "The Area selection Y coordinate is unsafe.")?;
        crate::capture::CaptureRect::new(x, y, width, height)
    }

    pub(crate) fn output_dimensions(self, selection: AreaSelection) -> Result<(u32, u32), String> {
        if !self.validates(selection) {
            return Err("The Area selection is outside the active display.".into());
        }
        Ok((
            (selection.width * self.scale_factor).round() as u32,
            (selection.height * self.scale_factor).round() as u32,
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AreaSelectorSession {
    pub(crate) generation: u64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) scale_factor: f64,
    pub(crate) preview_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AreaSelectorWait {
    Selected(AreaSelection),
    Cancelled,
    TimedOut,
    Stale,
}

#[derive(Debug)]
struct ActiveSelector {
    generation: u64,
    display: DisplayGeometry,
    preview_path: Option<String>,
    selection: Option<AreaSelection>,
    cancelled: bool,
}

#[derive(Default, Debug)]
struct AreaSelectorState {
    generation: u64,
    active: Option<ActiveSelector>,
}

#[derive(Default, Debug)]
pub(crate) struct AreaSelectorCoordinator {
    state: Mutex<AreaSelectorState>,
    changed: Condvar,
}

impl AreaSelectorCoordinator {
    pub(crate) fn prepare(
        &self,
        display: DisplayGeometry,
        preview_path: Option<String>,
    ) -> Result<AreaSelectorSession, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Area selection is temporarily unavailable.".to_string())?;
        if state.active.is_some() {
            return Err("Another Area selector is already active.".into());
        }
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| "Area selector generation exhausted its safe range.".to_string())?;
        let generation = state.generation;
        state.active = Some(ActiveSelector {
            generation,
            display,
            preview_path: preview_path.clone(),
            selection: None,
            cancelled: false,
        });
        Ok(AreaSelectorSession {
            generation,
            width: display.width,
            height: display.height,
            scale_factor: display.scale_factor,
            preview_path,
        })
    }

    pub(crate) fn current(&self) -> Option<AreaSelectorSession> {
        self.state.lock().ok().and_then(|state| {
            state.active.as_ref().map(|active| AreaSelectorSession {
                generation: active.generation,
                width: active.display.width,
                height: active.display.height,
                scale_factor: active.display.scale_factor,
                preview_path: active.preview_path.clone(),
            })
        })
    }

    pub(crate) fn display(&self, generation: u64) -> Option<DisplayGeometry> {
        self.state.lock().ok().and_then(|state| {
            state
                .active
                .as_ref()
                .filter(|active| active.generation == generation)
                .map(|active| active.display)
        })
    }

    pub(crate) fn complete(&self, generation: u64, selection: AreaSelection) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(active) = state.active.as_mut().filter(|active| {
            active.generation == generation
                && !active.cancelled
                && active.selection.is_none()
                && active.display.validates(selection)
        }) else {
            return false;
        };
        active.selection = Some(selection);
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
            .filter(|active| active.generation == generation && active.selection.is_none())
        else {
            return false;
        };
        active.cancelled = true;
        self.changed.notify_all();
        true
    }

    pub(crate) fn wait_for_selection(
        &self,
        generation: u64,
        timeout: Duration,
    ) -> AreaSelectorWait {
        let deadline = Instant::now().checked_add(timeout);
        let Ok(mut state) = self.state.lock() else {
            return AreaSelectorWait::Stale;
        };
        loop {
            let Some(active) = state
                .active
                .as_ref()
                .filter(|active| active.generation == generation)
            else {
                return AreaSelectorWait::Stale;
            };
            if let Some(selection) = active.selection {
                return AreaSelectorWait::Selected(selection);
            }
            if active.cancelled {
                return AreaSelectorWait::Cancelled;
            }
            let Some(remaining) =
                deadline.and_then(|deadline| deadline.checked_duration_since(Instant::now()))
            else {
                return AreaSelectorWait::TimedOut;
            };
            if remaining.is_zero() {
                return AreaSelectorWait::TimedOut;
            }
            let Ok((next, _)) = self.changed.wait_timeout(state, remaining) else {
                return AreaSelectorWait::Stale;
            };
            state = next;
        }
    }

    pub(crate) fn cleanup(&self, generation: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.active.as_ref().map(|active| active.generation) != Some(generation) {
            return false;
        }
        state.active = None;
        self.changed.notify_all();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{AreaSelection, AreaSelectorCoordinator, AreaSelectorWait, DisplayGeometry};
    use std::time::Duration;

    fn display() -> DisplayGeometry {
        DisplayGeometry::new(-1440, 0, 1440.0, 900.0, 2.0).expect("safe display")
    }

    #[test]
    fn selection_is_generation_scoped_bounded_and_converts_to_one_global_rect() {
        let coordinator = AreaSelectorCoordinator::default();
        let session = coordinator.prepare(display(), None).expect("prepare");
        let selection = AreaSelection {
            x: 120.0,
            y: 90.0,
            width: 500.0,
            height: 300.0,
        };
        assert!(!coordinator.complete(session.generation + 1, selection));
        assert!(coordinator.complete(session.generation, selection));
        assert_eq!(
            coordinator.wait_for_selection(session.generation, Duration::ZERO),
            AreaSelectorWait::Selected(selection),
        );
        assert_eq!(
            display().capture_rect(selection).expect("global rect"),
            crate::capture::CaptureRect::new(-1320, 90, 500, 300).expect("rect"),
        );
    }

    #[test]
    fn cancel_timeout_and_invalid_geometry_never_become_a_capture() {
        let coordinator = AreaSelectorCoordinator::default();
        let session = coordinator.prepare(display(), None).expect("prepare");
        assert!(!coordinator.complete(
            session.generation,
            AreaSelection {
                x: 1439.5,
                y: 899.5,
                width: 50.0,
                height: 50.0
            },
        ));
        assert!(coordinator.cancel(session.generation));
        assert_eq!(
            coordinator.wait_for_selection(session.generation, Duration::ZERO),
            AreaSelectorWait::Cancelled,
        );
        assert!(coordinator.cleanup(session.generation));

        let timeout = coordinator.prepare(display(), None).expect("prepare again");
        assert_eq!(
            coordinator.wait_for_selection(timeout.generation, Duration::ZERO),
            AreaSelectorWait::TimedOut,
        );
    }
}
