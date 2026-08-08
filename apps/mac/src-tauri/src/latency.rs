use crate::capture::CaptureMode;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use tauri::{AppHandle, Manager};

const STORE_VERSION: u8 = 1;
const STORE_FILENAME: &str = "overlay-latency.json";
pub(crate) const REQUIRED_SAMPLES: usize = 20;
pub(crate) const OVERLAY_SLA_MS: u64 = 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct OverlayLatencyStart {
    mode: CaptureMode,
    selection_completed_at: Instant,
}

impl OverlayLatencyStart {
    pub(crate) fn new(mode: CaptureMode, selection_completed_at: Instant) -> Self {
        Self {
            mode,
            selection_completed_at,
        }
    }

    pub(crate) fn finish(self, overlay_visible_at: Instant) -> OverlayLatencySample {
        let elapsed = overlay_visible_at.saturating_duration_since(self.selection_completed_at);
        OverlayLatencySample::new(
            self.mode,
            elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
        )
    }

    #[cfg(test)]
    pub(crate) fn selection_completed_at(self) -> Instant {
        self.selection_completed_at
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayLatencySample {
    mode: CaptureMode,
    duration_ms: u64,
}

impl OverlayLatencySample {
    pub(crate) fn new(mode: CaptureMode, duration_ms: u64) -> Self {
        Self { mode, duration_ms }
    }

    #[cfg(test)]
    fn duration_ms(self) -> u64 {
        self.duration_ms
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OverlayLatencyReport {
    pub(crate) sample_count: usize,
    pub(crate) required_samples: usize,
    pub(crate) under_sla_count: usize,
    pub(crate) p50_ms: Option<u64>,
    pub(crate) p90_ms: Option<u64>,
    pub(crate) max_ms: Option<u64>,
    pub(crate) complete: bool,
    pub(crate) passes: bool,
    pub(crate) warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct OverlayLatencyDiskState {
    version: u8,
    samples: Vec<OverlayLatencySample>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct OverlayLatencyRuntime {
    samples: Vec<OverlayLatencySample>,
    warning: Option<String>,
}

impl OverlayLatencyRuntime {
    pub(crate) fn report(&self) -> OverlayLatencyReport {
        let mut durations = self
            .samples
            .iter()
            .map(|sample| sample.duration_ms)
            .collect::<Vec<_>>();
        durations.sort_unstable();
        let sample_count = durations.len();
        let under_sla_count = durations
            .iter()
            .filter(|duration| **duration < OVERLAY_SLA_MS)
            .count();
        let complete = sample_count == REQUIRED_SAMPLES;

        OverlayLatencyReport {
            sample_count,
            required_samples: REQUIRED_SAMPLES,
            under_sla_count,
            p50_ms: nearest_rank(&durations, 50),
            p90_ms: nearest_rank(&durations, 90),
            max_ms: durations.last().copied(),
            complete,
            passes: complete && under_sla_count == REQUIRED_SAMPLES,
            warning: self.warning.clone(),
        }
    }

    pub(crate) fn record(
        &mut self,
        path: &Path,
        sample: OverlayLatencySample,
    ) -> Result<OverlayLatencyReport, String> {
        let mut next = self.samples.clone();
        next.push(sample);
        if next.len() > REQUIRED_SAMPLES {
            next.drain(..next.len() - REQUIRED_SAMPLES);
        }

        let state = OverlayLatencyDiskState {
            version: STORE_VERSION,
            samples: next.clone(),
        };
        if let Err(error) = persist_overlay_latency(path, &state) {
            let message = format!("Could not save overlay timing evidence: {error}");
            self.warning = Some(message.clone());
            return Err(message);
        }

        self.samples = next;
        self.warning = None;
        Ok(self.report())
    }

    #[cfg(test)]
    fn record_in_memory(&mut self, sample: OverlayLatencySample) {
        self.samples.push(sample);
        if self.samples.len() > REQUIRED_SAMPLES {
            self.samples.drain(..self.samples.len() - REQUIRED_SAMPLES);
        }
    }

    #[cfg(test)]
    fn samples(&self) -> &[OverlayLatencySample] {
        &self.samples
    }
}

pub(crate) struct LoadedOverlayLatency {
    runtime: OverlayLatencyRuntime,
}

impl LoadedOverlayLatency {
    #[cfg(test)]
    fn warning(&self) -> Option<&str> {
        self.runtime.warning.as_deref()
    }

    #[cfg(test)]
    fn runtime(&self) -> &OverlayLatencyRuntime {
        &self.runtime
    }

    fn into_runtime(self) -> OverlayLatencyRuntime {
        self.runtime
    }
}

fn nearest_rank(sorted: &[u64], percentile: usize) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (sorted.len() * percentile).div_ceil(100);
    sorted.get(rank.saturating_sub(1)).copied()
}

fn latency_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(STORE_FILENAME))
        .map_err(|error| format!("Could not locate Capso's timing directory: {error}"))
}

pub(crate) fn load_overlay_latency(path: &Path) -> LoadedOverlayLatency {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return LoadedOverlayLatency {
                runtime: OverlayLatencyRuntime::default(),
            };
        }
        Err(error) => {
            return LoadedOverlayLatency {
                runtime: OverlayLatencyRuntime {
                    samples: Vec::new(),
                    warning: Some(format!("Could not read overlay timing evidence: {error}")),
                },
            };
        }
    };

    match serde_json::from_slice::<OverlayLatencyDiskState>(&bytes) {
        Ok(mut state) if state.version == STORE_VERSION => {
            if state.samples.len() > REQUIRED_SAMPLES {
                state
                    .samples
                    .drain(..state.samples.len() - REQUIRED_SAMPLES);
            }
            LoadedOverlayLatency {
                runtime: OverlayLatencyRuntime {
                    samples: state.samples,
                    warning: None,
                },
            }
        }
        Ok(state) => LoadedOverlayLatency {
            runtime: OverlayLatencyRuntime {
                samples: Vec::new(),
                warning: Some(format!(
                    "Overlay timing evidence uses unsupported version {}.",
                    state.version
                )),
            },
        },
        Err(error) => LoadedOverlayLatency {
            runtime: OverlayLatencyRuntime {
                samples: Vec::new(),
                warning: Some(format!("Could not parse overlay timing evidence: {error}")),
            },
        },
    }
}

fn persist_overlay_latency(path: &Path, state: &OverlayLatencyDiskState) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".overlay-latency-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        output.write_all(&bytes)?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn initialize_for_app(app: &AppHandle) -> Result<OverlayLatencyReport, String> {
    let path = latency_store_path(app)?;
    let loaded = load_overlay_latency(&path);
    let state = app.state::<Mutex<OverlayLatencyRuntime>>();
    let mut runtime = state
        .lock()
        .map_err(|_| "Overlay timing evidence is temporarily unavailable.".to_string())?;
    *runtime = loaded.into_runtime();
    Ok(runtime.report())
}

pub(crate) fn current_report(app: &AppHandle) -> Result<OverlayLatencyReport, String> {
    app.state::<Mutex<OverlayLatencyRuntime>>()
        .lock()
        .map(|runtime| runtime.report())
        .map_err(|_| "Overlay timing evidence is temporarily unavailable.".to_string())
}

pub(crate) fn record_for_app(
    app: &AppHandle,
    sample: OverlayLatencySample,
) -> Result<OverlayLatencyReport, String> {
    let path = latency_store_path(app)?;
    app.state::<Mutex<OverlayLatencyRuntime>>()
        .lock()
        .map_err(|_| "Overlay timing evidence is temporarily unavailable.".to_string())?
        .record(&path, sample)
}

#[cfg(test)]
mod tests {
    use super::{load_overlay_latency, OverlayLatencyRuntime, OverlayLatencySample};
    use crate::capture::CaptureMode;

    fn sample(mode: CaptureMode, duration_ms: u64) -> OverlayLatencySample {
        OverlayLatencySample::new(mode, duration_ms)
    }

    #[test]
    fn latest_twenty_privacy_safe_samples_survive_restart() {
        let directory = tempfile::tempdir().expect("temporary latency directory");
        let path = directory.path().join("overlay-latency.json");
        let mut runtime = OverlayLatencyRuntime::default();

        for duration_ms in 1..=25 {
            runtime
                .record(&path, sample(CaptureMode::Region, duration_ms * 10))
                .expect("persist latency sample");
        }

        let loaded = load_overlay_latency(&path);
        assert_eq!(loaded.warning(), None);
        assert_eq!(loaded.runtime().samples().len(), 20);
        assert_eq!(loaded.runtime().samples()[0].duration_ms(), 60);
        assert_eq!(loaded.runtime().samples()[19].duration_ms(), 250);

        let json = std::fs::read_to_string(&path).expect("latency state");
        assert!(!json.contains("path"));
        assert!(!json.contains("capture_id"));
        assert!(!json.contains("captured_at"));
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("latency directory")
                .count(),
            1,
            "atomic persistence must not leave temporary files behind"
        );
    }

    #[test]
    fn report_requires_twenty_real_samples_and_uses_exact_percentiles() {
        let mut runtime = OverlayLatencyRuntime::default();
        for duration_ms in (100..=2_000).step_by(100) {
            runtime.record_in_memory(sample(CaptureMode::Window, duration_ms));
        }

        let report = runtime.report();
        assert_eq!(report.sample_count, 20);
        assert_eq!(report.required_samples, 20);
        assert_eq!(report.under_sla_count, 9);
        assert_eq!(report.p50_ms, Some(1_000));
        assert_eq!(report.p90_ms, Some(1_800));
        assert_eq!(report.max_ms, Some(2_000));
        assert!(report.complete);
        assert!(!report.passes);

        let mut passing = OverlayLatencyRuntime::default();
        for _ in 0..20 {
            passing.record_in_memory(sample(CaptureMode::Fullscreen, 999));
        }
        assert!(passing.report().passes);

        let mut incomplete = OverlayLatencyRuntime::default();
        for _ in 0..19 {
            incomplete.record_in_memory(sample(CaptureMode::Region, 100));
        }
        assert!(!incomplete.report().complete);
        assert!(!incomplete.report().passes);
    }

    #[test]
    fn corrupt_state_is_non_blocking_and_replaced_only_by_a_new_sample() {
        let directory = tempfile::tempdir().expect("temporary latency directory");
        let path = directory.path().join("overlay-latency.json");
        std::fs::write(&path, b"not json").expect("corrupt fixture");

        let loaded = load_overlay_latency(&path);
        assert!(loaded.warning().is_some());
        assert!(loaded.runtime().samples().is_empty());
        assert_eq!(
            std::fs::read(&path).expect("corrupt state remains available"),
            b"not json"
        );

        let mut runtime = loaded.into_runtime();
        runtime
            .record(&path, sample(CaptureMode::Region, 420))
            .expect("a new measurement replaces unusable telemetry state");
        let recovered = load_overlay_latency(&path);
        assert_eq!(recovered.warning(), None);
        assert_eq!(
            recovered.runtime().samples(),
            &[sample(CaptureMode::Region, 420)]
        );
    }
}
