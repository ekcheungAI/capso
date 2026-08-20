#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const ANNOTATION_SYNC_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AnnotationSyncCandidate {
    pub(crate) capture_id: String,
    pub(crate) document_revision: u64,
    pub(crate) mutation_id: String,
    pub(crate) project_path: PathBuf,
    pub(crate) flattened_path: PathBuf,
    pub(crate) original_path: PathBuf,
    pub(crate) original_sha256: String,
    pub(crate) flattened_sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnnotationSyncStatus {
    Pending,
    Uploading,
    Failed,
    Conflict,
    Synced,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationSyncFlight {
    mutation_id: String,
    base_cloud_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSyncEntry {
    pub(crate) capture_id: String,
    pub(crate) document_revision: u64,
    pub(crate) mutation_id: String,
    pub(crate) project_path: PathBuf,
    pub(crate) flattened_path: PathBuf,
    pub(crate) original_path: PathBuf,
    pub(crate) original_sha256: String,
    pub(crate) flattened_sha256: String,
    pub(crate) cloud_revision: u64,
    pub(crate) status: AnnotationSyncStatus,
    pub(crate) last_error: Option<String>,
    in_flight: Option<AnnotationSyncFlight>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AnnotationSyncClaim {
    pub(crate) capture_id: String,
    pub(crate) document_revision: u64,
    pub(crate) mutation_id: String,
    pub(crate) project_path: PathBuf,
    pub(crate) flattened_path: PathBuf,
    pub(crate) original_path: PathBuf,
    pub(crate) original_sha256: String,
    pub(crate) flattened_sha256: String,
    pub(crate) base_cloud_revision: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSyncSummary {
    pub(crate) pending: usize,
    pub(crate) uploading: usize,
    pub(crate) failed: usize,
    pub(crate) conflicts: usize,
    pub(crate) synced: usize,
    pub(crate) total: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSyncStatusEntry {
    pub(crate) capture_id: String,
    pub(crate) document_revision: u64,
    pub(crate) cloud_revision: u64,
    pub(crate) status: AnnotationSyncStatus,
    pub(crate) last_error: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSyncRuntimeStatus {
    pub(crate) summary: AnnotationSyncSummary,
    pub(crate) warning: Option<String>,
    pub(crate) entries: Vec<AnnotationSyncStatusEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AnnotationProjectUploadResult {
    Confirmed {
        capture_id: String,
        mutation_id: String,
        cloud_revision: u64,
    },
    Retryable {
        message: String,
    },
    Held {
        message: String,
    },
    Conflict {
        remote_cloud_revision: u64,
        message: String,
    },
    Terminal {
        message: String,
    },
}

pub(crate) trait AnnotationSyncTransport: Send + Sync {
    fn upload_annotation_project(
        &self,
        claim: &AnnotationSyncClaim,
    ) -> AnnotationProjectUploadResult;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub(crate) struct RemoteAnnotationHead {
    #[serde(rename = "screenshot_id")]
    pub(crate) capture_id: String,
    #[serde(rename = "cloud_revision")]
    pub(crate) cloud_revision: u64,
    #[serde(rename = "document_revision")]
    pub(crate) document_revision: u64,
    #[serde(rename = "mutation_id")]
    pub(crate) mutation_id: String,
    pub(crate) original_storage_path: String,
    pub(crate) flattened_storage_path: String,
    pub(crate) original_sha256: String,
    pub(crate) flattened_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteAnnotationBundle {
    pub(crate) head: RemoteAnnotationHead,
    pub(crate) document: Vec<u8>,
    pub(crate) original: Vec<u8>,
    pub(crate) flattened: Vec<u8>,
}

pub(crate) trait AnnotationCloudTransport: AnnotationSyncTransport {
    fn list_remote_annotation_heads(&self) -> Result<Vec<RemoteAnnotationHead>, String>;

    fn download_remote_annotation_revision(
        &self,
        head: &RemoteAnnotationHead,
    ) -> Result<RemoteAnnotationBundle, String>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteReconcileDecision {
    Current,
    Download { replace: bool },
    Conflict,
}

fn remote_reconcile_decision(
    local: Option<&AnnotationSyncEntry>,
    remote: &RemoteAnnotationHead,
) -> RemoteReconcileDecision {
    let Some(local) = local else {
        return RemoteReconcileDecision::Download { replace: false };
    };
    if remote.cloud_revision <= local.cloud_revision {
        return RemoteReconcileDecision::Current;
    }
    if local.status == AnnotationSyncStatus::Synced && local.in_flight.is_none() {
        RemoteReconcileDecision::Download { replace: true }
    } else {
        RemoteReconcileDecision::Conflict
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AnnotationSyncQueue {
    entries: Vec<AnnotationSyncEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationSyncDocument {
    version: u32,
    entries: Vec<AnnotationSyncEntry>,
}

impl Default for AnnotationSyncDocument {
    fn default() -> Self {
        Self {
            version: ANNOTATION_SYNC_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub(crate) struct DurableAnnotationSyncQueue {
    store_path: PathBuf,
    projects_directory: PathBuf,
    captures_directory: PathBuf,
    originals_directory: PathBuf,
    queue: AnnotationSyncQueue,
}

#[derive(Debug, Default)]
pub(crate) struct AnnotationSyncRuntime {
    queue: Option<DurableAnnotationSyncQueue>,
    warning: Option<String>,
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|parsed| parsed.to_string() == value)
        .unwrap_or(false)
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn validate_candidate(candidate: &AnnotationSyncCandidate) -> Result<(), String> {
    if !canonical_uuid(&candidate.capture_id)
        || !canonical_uuid(&candidate.mutation_id)
        || candidate.document_revision == 0
        || !valid_sha256(&candidate.original_sha256)
        || !valid_sha256(&candidate.flattened_sha256)
    {
        Err("The editable project sync candidate is invalid.".into())
    } else {
        Ok(())
    }
}

impl AnnotationSyncQueue {
    pub(crate) fn stage(&mut self, candidate: AnnotationSyncCandidate) -> Result<(), String> {
        validate_candidate(&candidate)?;
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.capture_id == candidate.capture_id)
        {
            let unresolved_conflict = entry.status == AnnotationSyncStatus::Conflict;
            if candidate.document_revision < entry.document_revision {
                return Err(
                    "An older editable project revision cannot replace newer local work.".into(),
                );
            }
            if candidate.document_revision == entry.document_revision {
                let unchanged = entry.project_path == candidate.project_path
                    && entry.flattened_path == candidate.flattened_path
                    && entry.original_path == candidate.original_path
                    && entry.original_sha256 == candidate.original_sha256
                    && entry.flattened_sha256 == candidate.flattened_sha256;
                return unchanged.then_some(()).ok_or_else(|| {
                    "That editable project revision already has different sync bytes.".into()
                });
            }
            entry.document_revision = candidate.document_revision;
            entry.mutation_id = candidate.mutation_id;
            entry.project_path = candidate.project_path;
            entry.flattened_path = candidate.flattened_path;
            entry.original_path = candidate.original_path;
            entry.original_sha256 = candidate.original_sha256;
            entry.flattened_sha256 = candidate.flattened_sha256;
            entry.status = if unresolved_conflict {
                AnnotationSyncStatus::Conflict
            } else {
                AnnotationSyncStatus::Pending
            };
            return Ok(());
        }
        self.entries.push(AnnotationSyncEntry {
            capture_id: candidate.capture_id,
            document_revision: candidate.document_revision,
            mutation_id: candidate.mutation_id,
            project_path: candidate.project_path,
            flattened_path: candidate.flattened_path,
            original_path: candidate.original_path,
            original_sha256: candidate.original_sha256,
            flattened_sha256: candidate.flattened_sha256,
            cloud_revision: 0,
            status: AnnotationSyncStatus::Pending,
            last_error: None,
            in_flight: None,
        });
        Ok(())
    }

    pub(crate) fn adopt_remote(
        &mut self,
        candidate: AnnotationSyncCandidate,
        cloud_revision: u64,
    ) -> Result<(), String> {
        validate_candidate(&candidate)?;
        if cloud_revision == 0 {
            return Err("The remote editable project revision is invalid.".into());
        }
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.capture_id == candidate.capture_id)
        {
            if entry.status != AnnotationSyncStatus::Synced || entry.in_flight.is_some() {
                return Err("Unsynced local work cannot be replaced by a remote revision.".into());
            }
            if cloud_revision <= entry.cloud_revision {
                return Ok(());
            }
            entry.document_revision = candidate.document_revision;
            entry.mutation_id = candidate.mutation_id;
            entry.project_path = candidate.project_path;
            entry.flattened_path = candidate.flattened_path;
            entry.original_path = candidate.original_path;
            entry.original_sha256 = candidate.original_sha256;
            entry.flattened_sha256 = candidate.flattened_sha256;
            entry.cloud_revision = cloud_revision;
            entry.status = AnnotationSyncStatus::Synced;
            entry.last_error = None;
            return Ok(());
        }
        self.entries.push(AnnotationSyncEntry {
            capture_id: candidate.capture_id,
            document_revision: candidate.document_revision,
            mutation_id: candidate.mutation_id,
            project_path: candidate.project_path,
            flattened_path: candidate.flattened_path,
            original_path: candidate.original_path,
            original_sha256: candidate.original_sha256,
            flattened_sha256: candidate.flattened_sha256,
            cloud_revision,
            status: AnnotationSyncStatus::Synced,
            last_error: None,
            in_flight: None,
        });
        Ok(())
    }

    pub(crate) fn observe_remote_head(
        &mut self,
        capture_id: &str,
        cloud_revision: u64,
    ) -> Result<(), String> {
        if !canonical_uuid(capture_id) || cloud_revision == 0 {
            return Err("The remote editable project head is invalid.".into());
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.capture_id == capture_id)
            .ok_or_else(|| "That remote editable project is not tracked locally.".to_string())?;
        if cloud_revision <= entry.cloud_revision {
            return Ok(());
        }
        if entry.status == AnnotationSyncStatus::Synced || entry.in_flight.is_some() {
            return Err("A newer remote revision must be downloaded before it is adopted.".into());
        }
        entry.cloud_revision = cloud_revision;
        entry.status = AnnotationSyncStatus::Conflict;
        entry.last_error = Some(format!(
            "Another Mac saved cloud revision {cloud_revision}. Your local work is still safe."
        ));
        Ok(())
    }

    pub(crate) fn claim_next(&mut self) -> Result<Option<AnnotationSyncClaim>, String> {
        self.claim_next_ready(&HashSet::new(), true)
    }

    fn claim_next_ready(
        &mut self,
        ready_capture_ids: &HashSet<String>,
        allow_any_capture: bool,
    ) -> Result<Option<AnnotationSyncClaim>, String> {
        let Some(entry) = self.entries.iter_mut().find(|entry| {
            entry.status == AnnotationSyncStatus::Pending
                && entry.in_flight.is_none()
                && (allow_any_capture || ready_capture_ids.contains(&entry.capture_id))
        }) else {
            return Ok(None);
        };
        entry.in_flight = Some(AnnotationSyncFlight {
            mutation_id: entry.mutation_id.clone(),
            base_cloud_revision: entry.cloud_revision,
        });
        entry.status = AnnotationSyncStatus::Uploading;
        Ok(Some(AnnotationSyncClaim {
            capture_id: entry.capture_id.clone(),
            document_revision: entry.document_revision,
            mutation_id: entry.mutation_id.clone(),
            project_path: entry.project_path.clone(),
            flattened_path: entry.flattened_path.clone(),
            original_path: entry.original_path.clone(),
            original_sha256: entry.original_sha256.clone(),
            flattened_sha256: entry.flattened_sha256.clone(),
            base_cloud_revision: entry.cloud_revision,
        }))
    }

    pub(crate) fn acknowledge(
        &mut self,
        mutation_id: &str,
        cloud_revision: u64,
    ) -> Result<(), String> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| {
                entry
                    .in_flight
                    .as_ref()
                    .is_some_and(|flight| flight.mutation_id == mutation_id)
            })
            .ok_or_else(|| "That editable project upload is no longer active.".to_string())?;
        let flight = entry
            .in_flight
            .as_ref()
            .expect("matching active flight exists");
        if cloud_revision != flight.base_cloud_revision.saturating_add(1) {
            return Err(
                "The editable project acknowledgement has the wrong cloud revision.".into(),
            );
        }
        entry.cloud_revision = cloud_revision;
        entry.in_flight = None;
        entry.status = if entry.mutation_id == mutation_id {
            AnnotationSyncStatus::Synced
        } else {
            AnnotationSyncStatus::Pending
        };
        entry.last_error = None;
        Ok(())
    }

    pub(crate) fn mark_conflict(
        &mut self,
        mutation_id: &str,
        remote_cloud_revision: u64,
        message: &str,
    ) -> Result<(), String> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| {
                entry
                    .in_flight
                    .as_ref()
                    .is_some_and(|flight| flight.mutation_id == mutation_id)
            })
            .ok_or_else(|| "That editable project upload is no longer active.".to_string())?;
        let flight = entry
            .in_flight
            .as_ref()
            .expect("matching active flight exists");
        if remote_cloud_revision <= flight.base_cloud_revision || message.trim().is_empty() {
            return Err("The editable project conflict acknowledgement is invalid.".into());
        }
        entry.cloud_revision = remote_cloud_revision;
        entry.status = AnnotationSyncStatus::Conflict;
        entry.last_error = Some(message.into());
        entry.in_flight = None;
        Ok(())
    }

    fn finish_with_error(
        &mut self,
        mutation_id: &str,
        message: &str,
        status: AnnotationSyncStatus,
    ) -> Result<(), String> {
        if message.trim().is_empty() {
            return Err("The editable project sync failure needs a recovery reason.".into());
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| {
                entry
                    .in_flight
                    .as_ref()
                    .is_some_and(|flight| flight.mutation_id == mutation_id)
            })
            .ok_or_else(|| "That editable project upload is no longer active.".to_string())?;
        entry.in_flight = None;
        entry.status = status;
        entry.last_error = Some(message.into());
        Ok(())
    }

    pub(crate) fn mark_retryable(
        &mut self,
        mutation_id: &str,
        message: &str,
    ) -> Result<(), String> {
        self.finish_with_error(mutation_id, message, AnnotationSyncStatus::Pending)
    }

    pub(crate) fn mark_terminal(&mut self, mutation_id: &str, message: &str) -> Result<(), String> {
        self.finish_with_error(mutation_id, message, AnnotationSyncStatus::Failed)
    }

    pub(crate) fn resolve_keep_local(
        &mut self,
        capture_id: &str,
        mutation_id: &str,
    ) -> Result<(), String> {
        if !canonical_uuid(mutation_id) {
            return Err("The editable project resolution identifier is invalid.".into());
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.capture_id == capture_id)
            .ok_or_else(|| "That editable project is not waiting for resolution.".to_string())?;
        if entry.status != AnnotationSyncStatus::Conflict || entry.in_flight.is_some() {
            return Err("Only a conflicted editable project can keep its local revision.".into());
        }
        entry.mutation_id = mutation_id.into();
        entry.status = AnnotationSyncStatus::Pending;
        entry.last_error = None;
        Ok(())
    }

    pub(crate) fn retry_failed(&mut self, capture_id: &str) -> Result<(), String> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.capture_id == capture_id)
            .ok_or_else(|| "That editable project is not waiting for recovery.".to_string())?;
        if entry.status != AnnotationSyncStatus::Failed || entry.in_flight.is_some() {
            return Err("Only a failed editable project can be retried.".into());
        }
        entry.status = AnnotationSyncStatus::Pending;
        entry.last_error = None;
        Ok(())
    }

    pub(crate) fn summary(&self) -> AnnotationSyncSummary {
        let mut summary = AnnotationSyncSummary {
            total: self.entries.len(),
            ..AnnotationSyncSummary::default()
        };
        for entry in &self.entries {
            match entry.status {
                AnnotationSyncStatus::Pending => summary.pending += 1,
                AnnotationSyncStatus::Uploading => summary.uploading += 1,
                AnnotationSyncStatus::Failed => summary.failed += 1,
                AnnotationSyncStatus::Conflict => summary.conflicts += 1,
                AnnotationSyncStatus::Synced => summary.synced += 1,
            }
        }
        summary
    }

    pub(crate) fn entry(&self, capture_id: &str) -> Option<&AnnotationSyncEntry> {
        self.entries
            .iter()
            .find(|entry| entry.capture_id == capture_id)
    }
}

fn expected_path(directory: &Path, capture_id: &str, extension: &str) -> PathBuf {
    directory.join(format!("{capture_id}.{extension}"))
}

fn validate_durable_queue(
    queue: &AnnotationSyncQueue,
    projects_directory: &Path,
    captures_directory: &Path,
    originals_directory: &Path,
) -> Result<(), String> {
    let mut capture_ids = HashSet::new();
    let mut mutation_ids = HashSet::new();
    for entry in &queue.entries {
        if !capture_ids.insert(entry.capture_id.as_str())
            || !mutation_ids.insert(entry.mutation_id.as_str())
            || !canonical_uuid(&entry.capture_id)
            || !canonical_uuid(&entry.mutation_id)
            || entry.document_revision == 0
            || !valid_sha256(&entry.original_sha256)
            || !valid_sha256(&entry.flattened_sha256)
            || entry.project_path != expected_path(projects_directory, &entry.capture_id, "json")
            || entry.flattened_path != expected_path(captures_directory, &entry.capture_id, "png")
            || entry.original_path != expected_path(originals_directory, &entry.capture_id, "png")
        {
            return Err("Capso's editable project sync queue is invalid.".into());
        }
        if let Some(flight) = &entry.in_flight {
            if !canonical_uuid(&flight.mutation_id)
                || (flight.mutation_id != entry.mutation_id
                    && !mutation_ids.insert(flight.mutation_id.as_str()))
                || flight.base_cloud_revision != entry.cloud_revision
                || entry.status == AnnotationSyncStatus::Conflict
                || entry.status == AnnotationSyncStatus::Synced
            {
                return Err("Capso's editable project sync flight is invalid.".into());
            }
        } else if entry.status == AnnotationSyncStatus::Uploading {
            return Err("Capso's editable project upload has no active mutation.".into());
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The editable project sync queue has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Capso's sync directory: {error}"))?;
    let temporary = parent.join(format!(".annotation-sync-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not reserve Capso's sync update: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Could not write Capso's sync queue: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync Capso's sync queue: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not commit Capso's sync queue: {error}"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync Capso's sync directory: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

impl DurableAnnotationSyncQueue {
    fn recover_local_projects(&mut self) -> Result<bool, String> {
        let entries = match fs::read_dir(&self.projects_directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Could not inspect Capso's local editable projects for sync recovery: {error}"
                ))
            }
        };
        let mut recovered = false;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("Could not inspect a local editable project for sync recovery: {error}")
            })?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let capture_id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or_else(|| "A local editable project has an invalid identity.".to_string())?;
            if self.queue.entry(capture_id).is_some() {
                continue;
            }
            let capture_path = expected_path(&self.captures_directory, capture_id, "png");
            let original_path = expected_path(&self.originals_directory, capture_id, "png");
            let document = crate::annotation_project::load_for_capture(
                &self.projects_directory,
                &capture_path,
                &original_path,
            )
            .map_err(|error| {
                format!("Could not safely recover local editable project {capture_id}: {error}")
            })?;
            self.queue.stage(AnnotationSyncCandidate {
                capture_id: document.capture_id,
                document_revision: document.revision,
                mutation_id: uuid::Uuid::new_v4().to_string(),
                project_path: path,
                flattened_path: capture_path,
                original_path,
                original_sha256: document.original_sha256,
                flattened_sha256: document.flattened_sha256,
            })?;
            recovered = true;
        }
        Ok(recovered)
    }

    pub(crate) fn open(
        store_path: impl AsRef<Path>,
        projects_directory: impl AsRef<Path>,
        captures_directory: impl AsRef<Path>,
        originals_directory: impl AsRef<Path>,
    ) -> Result<Self, String> {
        let store_path = store_path.as_ref().to_path_buf();
        let projects_directory = projects_directory.as_ref().to_path_buf();
        let captures_directory = captures_directory.as_ref().to_path_buf();
        let originals_directory = originals_directory.as_ref().to_path_buf();
        let document = match fs::read(&store_path) {
            Ok(bytes) => {
                serde_json::from_slice::<AnnotationSyncDocument>(&bytes).map_err(|error| {
                    format!("Could not decode Capso's editable project sync queue: {error}")
                })?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                AnnotationSyncDocument::default()
            }
            Err(error) => {
                return Err(format!(
                    "Could not read Capso's editable project sync queue: {error}"
                ))
            }
        };
        if document.version != ANNOTATION_SYNC_SCHEMA_VERSION {
            return Err("Unsupported Capso editable project sync queue version.".into());
        }
        let mut queue = AnnotationSyncQueue {
            entries: document.entries,
        };
        validate_durable_queue(
            &queue,
            &projects_directory,
            &captures_directory,
            &originals_directory,
        )?;
        let recovered = queue.entries.iter_mut().fold(false, |changed, entry| {
            if entry.in_flight.take().is_some() {
                if entry.status != AnnotationSyncStatus::Conflict
                    && entry.status != AnnotationSyncStatus::Synced
                {
                    entry.status = AnnotationSyncStatus::Pending;
                }
                true
            } else {
                changed
            }
        });
        let mut opened = Self {
            store_path,
            projects_directory,
            captures_directory,
            originals_directory,
            queue,
        };
        let recovered_projects = opened.recover_local_projects()?;
        if recovered || recovered_projects {
            opened.persist()?;
        }
        Ok(opened)
    }

    fn persist(&self) -> Result<(), String> {
        validate_durable_queue(
            &self.queue,
            &self.projects_directory,
            &self.captures_directory,
            &self.originals_directory,
        )?;
        let bytes = serde_json::to_vec(&AnnotationSyncDocument {
            version: ANNOTATION_SYNC_SCHEMA_VERSION,
            entries: self.queue.entries.clone(),
        })
        .map_err(|error| {
            format!("Could not encode Capso's editable project sync queue: {error}")
        })?;
        atomic_write(&self.store_path, &bytes)
    }

    fn transaction<T>(
        &mut self,
        change: impl FnOnce(&mut AnnotationSyncQueue) -> Result<T, String>,
    ) -> Result<T, String> {
        let before = self.queue.clone();
        let value = change(&mut self.queue)?;
        if let Err(error) = self.persist() {
            self.queue = before;
            return Err(error);
        }
        Ok(value)
    }

    pub(crate) fn stage(&mut self, candidate: AnnotationSyncCandidate) -> Result<(), String> {
        self.transaction(|queue| queue.stage(candidate))
    }

    pub(crate) fn claim_next(&mut self) -> Result<Option<AnnotationSyncClaim>, String> {
        self.transaction(AnnotationSyncQueue::claim_next)
    }

    fn claim_next_ready(
        &mut self,
        ready_capture_ids: &HashSet<String>,
    ) -> Result<Option<AnnotationSyncClaim>, String> {
        self.transaction(|queue| queue.claim_next_ready(ready_capture_ids, false))
    }

    pub(crate) fn acknowledge(
        &mut self,
        mutation_id: &str,
        cloud_revision: u64,
    ) -> Result<(), String> {
        self.transaction(|queue| queue.acknowledge(mutation_id, cloud_revision))
    }

    pub(crate) fn mark_conflict(
        &mut self,
        mutation_id: &str,
        remote_cloud_revision: u64,
        message: &str,
    ) -> Result<(), String> {
        self.transaction(|queue| queue.mark_conflict(mutation_id, remote_cloud_revision, message))
    }

    pub(crate) fn mark_retryable(
        &mut self,
        mutation_id: &str,
        message: &str,
    ) -> Result<(), String> {
        self.transaction(|queue| queue.mark_retryable(mutation_id, message))
    }

    pub(crate) fn mark_terminal(&mut self, mutation_id: &str, message: &str) -> Result<(), String> {
        self.transaction(|queue| queue.mark_terminal(mutation_id, message))
    }

    pub(crate) fn resolve_keep_local(
        &mut self,
        capture_id: &str,
        mutation_id: &str,
    ) -> Result<(), String> {
        self.transaction(|queue| queue.resolve_keep_local(capture_id, mutation_id))
    }

    pub(crate) fn retry_failed(&mut self, capture_id: &str) -> Result<(), String> {
        self.transaction(|queue| queue.retry_failed(capture_id))
    }

    pub(crate) fn adopt_remote(
        &mut self,
        candidate: AnnotationSyncCandidate,
        cloud_revision: u64,
    ) -> Result<(), String> {
        self.transaction(|queue| queue.adopt_remote(candidate, cloud_revision))
    }

    pub(crate) fn observe_remote_head(
        &mut self,
        capture_id: &str,
        cloud_revision: u64,
    ) -> Result<(), String> {
        self.transaction(|queue| queue.observe_remote_head(capture_id, cloud_revision))
    }

    pub(crate) fn summary(&self) -> AnnotationSyncSummary {
        self.queue.summary()
    }

    pub(crate) fn entry(&self, capture_id: &str) -> Option<&AnnotationSyncEntry> {
        self.queue.entry(capture_id)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSyncDrainReport {
    pub(crate) attempted: usize,
    pub(crate) synced: usize,
    pub(crate) retryable: usize,
    pub(crate) held: usize,
    pub(crate) conflicts: usize,
    pub(crate) failed: usize,
    pub(crate) waiting_for_capture: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteAnnotationReconcileReport {
    pub(crate) discovered: usize,
    pub(crate) downloaded: usize,
    pub(crate) conflicts: usize,
    pub(crate) current: usize,
    pub(crate) deferred_for_editor: usize,
    pub(crate) deferred_for_capture: usize,
}

fn remote_capture_ready(ready_capture_ids: &HashSet<String>, capture_id: &str) -> bool {
    ready_capture_ids.contains(capture_id)
}

pub(crate) fn drain_ready_projects<T: AnnotationSyncTransport>(
    queue: &mut DurableAnnotationSyncQueue,
    transport: &T,
    ready_capture_ids: &HashSet<String>,
) -> Result<AnnotationSyncDrainReport, String> {
    let mut report = AnnotationSyncDrainReport {
        waiting_for_capture: queue
            .queue
            .entries
            .iter()
            .filter(|entry| {
                entry.status == AnnotationSyncStatus::Pending
                    && !ready_capture_ids.contains(&entry.capture_id)
            })
            .count(),
        ..AnnotationSyncDrainReport::default()
    };
    let mut attempted = HashSet::new();
    loop {
        let eligible = ready_capture_ids
            .iter()
            .filter(|capture_id| !attempted.contains(*capture_id))
            .cloned()
            .collect::<HashSet<_>>();
        let Some(claim) = queue.claim_next_ready(&eligible)? else {
            break;
        };
        attempted.insert(claim.capture_id.clone());
        report.attempted += 1;
        match transport.upload_annotation_project(&claim) {
            AnnotationProjectUploadResult::Confirmed {
                capture_id,
                mutation_id,
                cloud_revision,
            } if capture_id == claim.capture_id && mutation_id == claim.mutation_id => {
                queue.acknowledge(&mutation_id, cloud_revision)?;
                report.synced += 1;
            }
            AnnotationProjectUploadResult::Confirmed { .. } => {
                queue.mark_retryable(
                    &claim.mutation_id,
                    "Capso received a mismatched editable project acknowledgement.",
                )?;
                report.retryable += 1;
            }
            AnnotationProjectUploadResult::Retryable { message } => {
                queue.mark_retryable(&claim.mutation_id, &message)?;
                report.retryable += 1;
            }
            AnnotationProjectUploadResult::Held { message } => {
                queue.mark_retryable(&claim.mutation_id, &message)?;
                report.held += 1;
            }
            AnnotationProjectUploadResult::Conflict {
                remote_cloud_revision,
                message,
            } => {
                queue.mark_conflict(&claim.mutation_id, remote_cloud_revision, &message)?;
                report.conflicts += 1;
            }
            AnnotationProjectUploadResult::Terminal { message } => {
                queue.mark_terminal(&claim.mutation_id, &message)?;
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

impl AnnotationSyncRuntime {
    fn initialize(&mut self, queue: Result<DurableAnnotationSyncQueue, String>) {
        match queue {
            Ok(queue) => {
                self.queue = Some(queue);
                self.warning = None;
            }
            Err(error) => {
                self.queue = None;
                self.warning = Some(error);
            }
        }
    }

    fn stage(&mut self, candidate: AnnotationSyncCandidate) -> Result<(), String> {
        let queue = self.queue.as_mut().ok_or_else(|| {
            self.warning
                .clone()
                .unwrap_or_else(|| "Capso's editable project sync queue is not initialized.".into())
        })?;
        match queue.stage(candidate) {
            Ok(()) => {
                self.warning = None;
                Ok(())
            }
            Err(error) => {
                self.warning = Some(error.clone());
                Err(error)
            }
        }
    }

    pub(crate) fn status(&self) -> AnnotationSyncRuntimeStatus {
        let Some(queue) = self.queue.as_ref() else {
            return AnnotationSyncRuntimeStatus {
                warning: self.warning.clone(),
                ..AnnotationSyncRuntimeStatus::default()
            };
        };
        AnnotationSyncRuntimeStatus {
            summary: queue.summary(),
            warning: self.warning.clone(),
            entries: queue
                .queue
                .entries
                .iter()
                .map(|entry| AnnotationSyncStatusEntry {
                    capture_id: entry.capture_id.clone(),
                    document_revision: entry.document_revision,
                    cloud_revision: entry.cloud_revision,
                    status: entry.status,
                    last_error: entry.last_error.clone(),
                })
                .collect(),
        }
    }
}

fn app_paths<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    app.path()
        .app_data_dir()
        .map(|directory| {
            (
                directory.join("annotation-sync-queue.json"),
                directory.join("annotation-projects"),
                directory.join("captures"),
                directory.join("capture-originals"),
            )
        })
        .map_err(|error| format!("Could not locate Capso's editable project sync queue: {error}"))
}

pub(crate) fn initialize_for_app(app: &AppHandle) -> Result<(), String> {
    let (store, projects, captures, originals) = app_paths(app)?;
    let opened = DurableAnnotationSyncQueue::open(store, projects, captures, originals);
    app.state::<std::sync::Mutex<AnnotationSyncRuntime>>()
        .lock()
        .map_err(|_| "Capso's editable project sync queue is temporarily unavailable.".to_string())?
        .initialize(opened);
    Ok(())
}

pub(crate) fn stage_for_app<R: Runtime>(
    app: &AppHandle<R>,
    candidate: AnnotationSyncCandidate,
) -> Result<(), String> {
    let result = app
        .state::<std::sync::Mutex<AnnotationSyncRuntime>>()
        .lock()
        .map_err(|_| "Capso's editable project sync queue is temporarily unavailable.".to_string())?
        .stage(candidate);
    if result.is_ok() {
        emit_status(app);
    }
    result
}

pub(crate) fn status_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<AnnotationSyncRuntimeStatus, String> {
    app.state::<std::sync::Mutex<AnnotationSyncRuntime>>()
        .lock()
        .map_err(|_| "Capso's editable project sync queue is temporarily unavailable.".to_string())
        .map(|runtime| runtime.status())
}

fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(status) = status_for_app(app) {
        let _ = app.emit("annotation-project-sync-changed", status);
    }
}

pub(crate) fn retry_for_app<R: Runtime>(
    app: &AppHandle<R>,
    capture_id: &str,
) -> Result<AnnotationSyncRuntimeStatus, String> {
    {
        let state = app.state::<std::sync::Mutex<AnnotationSyncRuntime>>();
        let mut runtime = state.lock().map_err(|_| {
            "Capso's editable project sync queue is temporarily unavailable.".to_string()
        })?;
        let warning = runtime.warning.clone();
        runtime
            .queue
            .as_mut()
            .ok_or_else(|| {
                warning.unwrap_or_else(|| {
                    "Capso's editable project sync queue is not initialized.".into()
                })
            })?
            .retry_failed(capture_id)?;
    }
    let status = status_for_app(app)?;
    let _ = app.emit("annotation-project-sync-changed", &status);
    Ok(status)
}

pub(crate) fn keep_local_for_app<R: Runtime>(
    app: &AppHandle<R>,
    capture_id: &str,
) -> Result<AnnotationSyncRuntimeStatus, String> {
    let mutation_id = uuid::Uuid::new_v4().to_string();
    {
        let state = app.state::<std::sync::Mutex<AnnotationSyncRuntime>>();
        let mut runtime = state.lock().map_err(|_| {
            "Capso's editable project sync queue is temporarily unavailable.".to_string()
        })?;
        let warning = runtime.warning.clone();
        runtime
            .queue
            .as_mut()
            .ok_or_else(|| {
                warning.unwrap_or_else(|| {
                    "Capso's editable project sync queue is not initialized.".into()
                })
            })?
            .resolve_keep_local(capture_id, &mutation_id)?;
    }
    let status = status_for_app(app)?;
    let _ = app.emit("annotation-project-sync-changed", &status);
    Ok(status)
}

pub(crate) fn drain_for_app<R: Runtime, T: AnnotationSyncTransport>(
    app: &AppHandle<R>,
    transport: &T,
    ready_capture_ids: &HashSet<String>,
) -> Result<AnnotationSyncDrainReport, String> {
    let state = app.state::<std::sync::Mutex<AnnotationSyncRuntime>>();
    let waiting_for_capture = state
        .lock()
        .map_err(|_| "Capso's editable project sync queue is temporarily unavailable.".to_string())?
        .queue
        .as_ref()
        .map(|queue| {
            queue
                .queue
                .entries
                .iter()
                .filter(|entry| {
                    entry.status == AnnotationSyncStatus::Pending
                        && !ready_capture_ids.contains(&entry.capture_id)
                })
                .count()
        })
        .unwrap_or_default();
    let mut report = AnnotationSyncDrainReport {
        waiting_for_capture,
        ..AnnotationSyncDrainReport::default()
    };
    let mut attempted = HashSet::new();
    loop {
        let eligible = ready_capture_ids
            .iter()
            .filter(|capture_id| !attempted.contains(*capture_id))
            .cloned()
            .collect::<HashSet<_>>();
        let claim = {
            let mut runtime = state.lock().map_err(|_| {
                "Capso's editable project sync queue is temporarily unavailable.".to_string()
            })?;
            let warning = runtime.warning.clone();
            let result = runtime
                .queue
                .as_mut()
                .ok_or_else(|| {
                    warning.unwrap_or_else(|| {
                        "Capso's editable project sync queue is not initialized.".into()
                    })
                })?
                .claim_next_ready(&eligible);
            drop(runtime);
            result?
        };
        let Some(claim) = claim else {
            break;
        };
        attempted.insert(claim.capture_id.clone());
        report.attempted += 1;
        let outcome = transport.upload_annotation_project(&claim);
        let held = matches!(outcome, AnnotationProjectUploadResult::Held { .. });
        let mut runtime = state.lock().map_err(|_| {
            "Capso's editable project sync queue is temporarily unavailable.".to_string()
        })?;
        let warning = runtime.warning.clone();
        let queue = runtime.queue.as_mut().ok_or_else(|| {
            warning
                .unwrap_or_else(|| "Capso's editable project sync queue is not initialized.".into())
        })?;
        match outcome {
            AnnotationProjectUploadResult::Confirmed {
                capture_id,
                mutation_id,
                cloud_revision,
            } if capture_id == claim.capture_id && mutation_id == claim.mutation_id => {
                queue.acknowledge(&mutation_id, cloud_revision)?;
                report.synced += 1;
            }
            AnnotationProjectUploadResult::Confirmed { .. } => {
                queue.mark_retryable(
                    &claim.mutation_id,
                    "Capso received a mismatched editable project acknowledgement.",
                )?;
                report.retryable += 1;
            }
            AnnotationProjectUploadResult::Retryable { message } => {
                queue.mark_retryable(&claim.mutation_id, &message)?;
                report.retryable += 1;
            }
            AnnotationProjectUploadResult::Held { message } => {
                queue.mark_retryable(&claim.mutation_id, &message)?;
                report.held += 1;
            }
            AnnotationProjectUploadResult::Conflict {
                remote_cloud_revision,
                message,
            } => {
                queue.mark_conflict(&claim.mutation_id, remote_cloud_revision, &message)?;
                report.conflicts += 1;
            }
            AnnotationProjectUploadResult::Terminal { message } => {
                queue.mark_terminal(&claim.mutation_id, &message)?;
                report.failed += 1;
            }
        }
        drop(runtime);
        if held {
            break;
        }
    }
    emit_status(app);
    Ok(report)
}

pub(crate) fn reconcile_remote_for_app<R: Runtime, T: AnnotationCloudTransport>(
    app: &AppHandle<R>,
    transport: &T,
    ready_capture_ids: &HashSet<String>,
) -> Result<RemoteAnnotationReconcileReport, String> {
    let heads = transport.list_remote_annotation_heads()?;
    let mut report = RemoteAnnotationReconcileReport {
        discovered: heads.len(),
        ..RemoteAnnotationReconcileReport::default()
    };
    let sync_state = app.state::<std::sync::Mutex<AnnotationSyncRuntime>>();
    let editor_state = app.state::<std::sync::Mutex<crate::annotation::AnnotationRuntime>>();

    for head in heads {
        if !remote_capture_ready(ready_capture_ids, &head.capture_id) {
            report.deferred_for_capture += 1;
            continue;
        }
        let mut downloaded_this_head = false;
        let initial_decision = {
            let runtime = sync_state.lock().map_err(|_| {
                "Capso's editable project sync queue is temporarily unavailable.".to_string()
            })?;
            let warning = runtime.warning.clone();
            let queue = runtime.queue.as_ref().ok_or_else(|| {
                warning.unwrap_or_else(|| {
                    "Capso's editable project sync queue is not initialized.".into()
                })
            })?;
            remote_reconcile_decision(queue.entry(&head.capture_id), &head)
        };
        match initial_decision {
            RemoteReconcileDecision::Current => {
                report.current += 1;
                continue;
            }
            RemoteReconcileDecision::Conflict => {
                let mut runtime = sync_state.lock().map_err(|_| {
                    "Capso's editable project sync queue is temporarily unavailable.".to_string()
                })?;
                let warning = runtime.warning.clone();
                runtime
                    .queue
                    .as_mut()
                    .ok_or_else(|| {
                        warning.unwrap_or_else(|| {
                            "Capso's editable project sync queue is not initialized.".into()
                        })
                    })?
                    .observe_remote_head(&head.capture_id, head.cloud_revision)?;
                report.conflicts += 1;
                continue;
            }
            RemoteReconcileDecision::Download { .. } => {}
        }

        if editor_state
            .lock()
            .map_err(|_| "Capso's annotation editor is temporarily unavailable.".to_string())?
            .is_editing_capture(&head.capture_id)
        {
            report.deferred_for_editor += 1;
            continue;
        }
        let bundle = transport.download_remote_annotation_revision(&head)?;

        // Holding the editor guard prevents an edit session from starting
        // between the final queue check and the three-file durable install.
        let editor = editor_state
            .lock()
            .map_err(|_| "Capso's annotation editor is temporarily unavailable.".to_string())?;
        if editor.is_editing_capture(&head.capture_id) {
            report.deferred_for_editor += 1;
            continue;
        }
        let mut runtime = sync_state.lock().map_err(|_| {
            "Capso's editable project sync queue is temporarily unavailable.".to_string()
        })?;
        let warning = runtime.warning.clone();
        let queue = runtime.queue.as_mut().ok_or_else(|| {
            warning
                .unwrap_or_else(|| "Capso's editable project sync queue is not initialized.".into())
        })?;
        match remote_reconcile_decision(queue.entry(&head.capture_id), &head) {
            RemoteReconcileDecision::Current => {
                report.current += 1;
            }
            RemoteReconcileDecision::Conflict => {
                queue.observe_remote_head(&head.capture_id, head.cloud_revision)?;
                report.conflicts += 1;
            }
            RemoteReconcileDecision::Download { replace } => {
                let projects_directory = queue.projects_directory.clone();
                let captures_directory = queue.captures_directory.clone();
                let originals_directory = queue.originals_directory.clone();
                let document = crate::annotation_project::install_remote_revision(
                    &projects_directory,
                    &captures_directory,
                    &originals_directory,
                    &head.capture_id,
                    &bundle.document,
                    &bundle.original,
                    &bundle.flattened,
                    replace,
                )?;
                queue.adopt_remote(
                    AnnotationSyncCandidate {
                        capture_id: head.capture_id.clone(),
                        document_revision: document.revision,
                        mutation_id: head.mutation_id.clone(),
                        project_path: expected_path(&projects_directory, &head.capture_id, "json"),
                        flattened_path: expected_path(&captures_directory, &head.capture_id, "png"),
                        original_path: expected_path(&originals_directory, &head.capture_id, "png"),
                        original_sha256: head.original_sha256.clone(),
                        flattened_sha256: head.flattened_sha256.clone(),
                    },
                    head.cloud_revision,
                )?;
                report.downloaded += 1;
                downloaded_this_head = true;
            }
        }
        drop(runtime);
        drop(editor);
        if downloaded_this_head {
            let _ = app.emit(
                "annotation-project-saved",
                serde_json::json!({
                    "id": head.capture_id,
                    "revision": head.document_revision,
                    "source": "cloud",
                }),
            );
        }
    }
    emit_status(app);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::{
        drain_ready_projects, remote_capture_ready, remote_reconcile_decision,
        AnnotationProjectUploadResult, AnnotationSyncCandidate, AnnotationSyncClaim,
        AnnotationSyncQueue, AnnotationSyncRuntime, AnnotationSyncStatus, AnnotationSyncTransport,
        DurableAnnotationSyncQueue, RemoteAnnotationHead, RemoteReconcileDecision,
    };
    use std::{collections::HashSet, fs, path::PathBuf, sync::Mutex};

    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";
    const FIRST_MUTATION: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227b";
    const SECOND_MUTATION: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227c";

    fn candidate(document_revision: u64, mutation_id: &str) -> AnnotationSyncCandidate {
        AnnotationSyncCandidate {
            capture_id: CAPTURE_ID.into(),
            document_revision,
            mutation_id: mutation_id.into(),
            project_path: PathBuf::from(format!("annotation-projects/{CAPTURE_ID}.json")),
            flattened_path: PathBuf::from(format!("captures/{CAPTURE_ID}.png")),
            original_path: PathBuf::from(format!("capture-originals/{CAPTURE_ID}.png")),
            original_sha256: format!("sha256:{:064x}", 1),
            flattened_sha256: format!("sha256:{:064x}", document_revision + 1),
        }
    }

    fn candidate_at(
        root: &std::path::Path,
        document_revision: u64,
        mutation_id: &str,
    ) -> AnnotationSyncCandidate {
        let mut value = candidate(document_revision, mutation_id);
        value.project_path = root
            .join("annotation-projects")
            .join(format!("{CAPTURE_ID}.json"));
        value.flattened_path = root.join("captures").join(format!("{CAPTURE_ID}.png"));
        value.original_path = root
            .join("capture-originals")
            .join(format!("{CAPTURE_ID}.png"));
        value
    }

    #[test]
    fn a_new_save_during_upload_survives_the_old_ack_and_inherits_its_cloud_base() {
        let mut queue = AnnotationSyncQueue::default();
        queue
            .stage(candidate(1, FIRST_MUTATION))
            .expect("stage first local revision");
        let first = queue.claim_next().expect("claim first").expect("work");
        assert_eq!(first.base_cloud_revision, 0);

        queue
            .stage(candidate(2, SECOND_MUTATION))
            .expect("stage newer local revision during first upload");
        queue
            .acknowledge(FIRST_MUTATION, 1)
            .expect("acknowledge exact older mutation");

        let entry = queue.entry(CAPTURE_ID).expect("latest local entry remains");
        assert_eq!(entry.status, AnnotationSyncStatus::Pending);
        assert_eq!(entry.document_revision, 2);
        assert_eq!(entry.cloud_revision, 1);
        assert_eq!(entry.mutation_id, SECOND_MUTATION);

        let second = queue
            .claim_next()
            .expect("claim second")
            .expect("newer work");
        assert_eq!(second.mutation_id, SECOND_MUTATION);
        assert_eq!(second.base_cloud_revision, 1);
    }

    #[test]
    fn retrying_the_same_local_revision_reuses_its_first_durable_mutation() {
        let mut queue = AnnotationSyncQueue::default();
        queue
            .stage(candidate(1, FIRST_MUTATION))
            .expect("stage first save attempt");
        queue
            .stage(candidate(1, SECOND_MUTATION))
            .expect("later save retry is content-idempotent");

        let entry = queue.entry(CAPTURE_ID).expect("one durable mutation");
        assert_eq!(entry.mutation_id, FIRST_MUTATION);
        assert_eq!(entry.document_revision, 1);
    }

    #[test]
    fn a_cloud_conflict_blocks_automatic_overwrite_until_keep_local_is_explicit() {
        let mut queue = AnnotationSyncQueue::default();
        queue
            .stage(candidate(1, FIRST_MUTATION))
            .expect("stage local revision");
        queue.claim_next().expect("claim").expect("work");
        queue
            .mark_conflict(FIRST_MUTATION, 4, "Another Mac saved revision 4.")
            .expect("record exact conflict");

        let conflicted = queue.entry(CAPTURE_ID).expect("conflict remains local");
        assert_eq!(conflicted.status, AnnotationSyncStatus::Conflict);
        assert_eq!(conflicted.cloud_revision, 4);
        assert!(queue.claim_next().expect("blocked queue").is_none());
        queue
            .stage(candidate(2, SECOND_MUTATION))
            .expect("newer local work remains safe during conflict");
        let still_conflicted = queue.entry(CAPTURE_ID).expect("conflict remains explicit");
        assert_eq!(still_conflicted.status, AnnotationSyncStatus::Conflict);
        assert_eq!(still_conflicted.document_revision, 2);

        queue
            .resolve_keep_local(CAPTURE_ID, SECOND_MUTATION)
            .expect("explicit keep-local resolution");
        let retry = queue.claim_next().expect("claim resolution").expect("work");
        assert_eq!(retry.base_cloud_revision, 4);
        assert_eq!(retry.mutation_id, SECOND_MUTATION);
    }

    #[test]
    fn restart_discards_an_interrupted_flight_but_durably_keeps_the_newest_local_revision() {
        let root = tempfile::tempdir().expect("sync root");
        for directory in ["annotation-projects", "captures", "capture-originals"] {
            fs::create_dir(root.path().join(directory)).expect("candidate directory");
        }
        let store = root.path().join("annotation-sync-queue.json");
        let open = || {
            DurableAnnotationSyncQueue::open(
                &store,
                root.path().join("annotation-projects"),
                root.path().join("captures"),
                root.path().join("capture-originals"),
            )
        };

        {
            let mut queue = open().expect("open queue");
            queue
                .stage(candidate_at(root.path(), 1, FIRST_MUTATION))
                .expect("persist first revision");
            queue.claim_next().expect("persist claim").expect("work");
            queue
                .stage(candidate_at(root.path(), 2, SECOND_MUTATION))
                .expect("persist newer revision during flight");
        }

        let mut restarted = open().expect("recover interrupted queue");
        let entry = restarted
            .entry(CAPTURE_ID)
            .expect("latest revision survived");
        assert_eq!(entry.document_revision, 2);
        assert_eq!(entry.status, AnnotationSyncStatus::Pending);
        let retry = restarted
            .claim_next()
            .expect("claim recovered revision")
            .expect("work");
        assert_eq!(retry.mutation_id, SECOND_MUTATION);
        assert_eq!(retry.base_cloud_revision, 0);
    }

    #[test]
    fn retryable_and_terminal_results_leave_distinct_durable_recovery_states() {
        let mut retryable = AnnotationSyncQueue::default();
        retryable
            .stage(candidate(1, FIRST_MUTATION))
            .expect("stage retryable");
        retryable.claim_next().expect("claim").expect("work");
        retryable
            .mark_retryable(FIRST_MUTATION, "Network route changed.")
            .expect("release retryable mutation");
        let waiting = retryable.entry(CAPTURE_ID).expect("waiting entry");
        assert_eq!(waiting.status, AnnotationSyncStatus::Pending);
        assert_eq!(
            waiting.last_error.as_deref(),
            Some("Network route changed.")
        );
        assert!(retryable.claim_next().expect("retry can claim").is_some());

        let mut terminal = AnnotationSyncQueue::default();
        terminal
            .stage(candidate(1, FIRST_MUTATION))
            .expect("stage terminal");
        terminal.claim_next().expect("claim").expect("work");
        terminal
            .mark_terminal(FIRST_MUTATION, "Protected original is missing.")
            .expect("record terminal mutation");
        let failed = terminal.entry(CAPTURE_ID).expect("failed entry");
        assert_eq!(failed.status, AnnotationSyncStatus::Failed);
        assert_eq!(
            failed.last_error.as_deref(),
            Some("Protected original is missing.")
        );
        assert!(terminal.claim_next().expect("terminal blocked").is_none());
    }

    #[derive(Debug)]
    struct ScriptedTransport {
        outcomes: Mutex<Vec<AnnotationProjectUploadResult>>,
        uploaded: Mutex<Vec<String>>,
    }

    impl AnnotationSyncTransport for ScriptedTransport {
        fn upload_annotation_project(
            &self,
            claim: &AnnotationSyncClaim,
        ) -> AnnotationProjectUploadResult {
            self.uploaded
                .lock()
                .expect("uploaded lock")
                .push(claim.capture_id.clone());
            self.outcomes.lock().expect("outcomes lock").remove(0)
        }
    }

    #[test]
    fn project_drain_waits_for_capture_ack_and_settles_each_result_once_per_wake() {
        let root = tempfile::tempdir().expect("sync root");
        for directory in ["annotation-projects", "captures", "capture-originals"] {
            fs::create_dir(root.path().join(directory)).expect("candidate directory");
        }
        let mut queue = DurableAnnotationSyncQueue::open(
            root.path().join("annotation-sync-queue.json"),
            root.path().join("annotation-projects"),
            root.path().join("captures"),
            root.path().join("capture-originals"),
        )
        .expect("open queue");
        queue
            .stage(candidate_at(root.path(), 1, FIRST_MUTATION))
            .expect("stage project");
        let transport = ScriptedTransport {
            outcomes: Mutex::new(vec![AnnotationProjectUploadResult::Confirmed {
                capture_id: CAPTURE_ID.into(),
                mutation_id: FIRST_MUTATION.into(),
                cloud_revision: 1,
            }]),
            uploaded: Mutex::new(Vec::new()),
        };

        let held = drain_ready_projects(&mut queue, &transport, &HashSet::new())
            .expect("capture not ready");
        assert_eq!(held.waiting_for_capture, 1);
        assert!(transport.uploaded.lock().expect("uploaded lock").is_empty());

        let ready = HashSet::from([CAPTURE_ID.to_string()]);
        let synced = drain_ready_projects(&mut queue, &transport, &ready).expect("project drain");
        assert_eq!(synced.attempted, 1);
        assert_eq!(synced.synced, 1);
        assert_eq!(
            queue.entry(CAPTURE_ID).expect("synced entry").status,
            AnnotationSyncStatus::Synced
        );
    }

    #[test]
    fn summary_and_recovery_keep_conflicts_distinct_from_retryable_failures() {
        let mut queue = AnnotationSyncQueue::default();
        queue
            .stage(candidate(1, FIRST_MUTATION))
            .expect("stage project");
        assert_eq!(queue.summary().pending, 1);
        queue.claim_next().expect("claim").expect("work");
        queue
            .mark_terminal(FIRST_MUTATION, "Local asset needs attention.")
            .expect("terminal");
        assert_eq!(queue.summary().failed, 1);
        queue.retry_failed(CAPTURE_ID).expect("explicit retry");
        assert_eq!(queue.summary().pending, 1);

        queue.claim_next().expect("claim retry").expect("work");
        queue
            .mark_conflict(FIRST_MUTATION, 3, "Another Mac saved revision 3.")
            .expect("conflict");
        let summary = queue.summary();
        assert_eq!(summary.conflicts, 1);
        assert_eq!(summary.failed, 0);
        assert_eq!(summary.pending, 0);
    }

    #[test]
    fn runtime_status_exposes_recovery_without_leaking_local_paths_or_mutation_ids() {
        let root = tempfile::tempdir().expect("sync root");
        for directory in ["annotation-projects", "captures", "capture-originals"] {
            fs::create_dir(root.path().join(directory)).expect("candidate directory");
        }
        let mut queue = DurableAnnotationSyncQueue::open(
            root.path().join("annotation-sync-queue.json"),
            root.path().join("annotation-projects"),
            root.path().join("captures"),
            root.path().join("capture-originals"),
        )
        .expect("open queue");
        queue
            .stage(candidate_at(root.path(), 2, FIRST_MUTATION))
            .expect("stage project");
        queue.claim_next().expect("claim").expect("work");
        queue
            .mark_conflict(FIRST_MUTATION, 4, "Another Mac saved revision 4.")
            .expect("conflict");

        let mut runtime = AnnotationSyncRuntime::default();
        runtime.initialize(Ok(queue));
        let status = runtime.status();
        assert_eq!(status.summary.conflicts, 1);
        assert_eq!(status.warning, None);
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].capture_id, CAPTURE_ID);
        assert_eq!(status.entries[0].document_revision, 2);
        assert_eq!(status.entries[0].cloud_revision, 4);
        assert_eq!(status.entries[0].status, AnnotationSyncStatus::Conflict);
        assert_eq!(
            status.entries[0].last_error.as_deref(),
            Some("Another Mac saved revision 4.")
        );

        let json = serde_json::to_string(&status).expect("serialize safe status");
        assert!(!json.contains("projectPath"));
        assert!(!json.contains("mutationId"));
        assert!(!json.contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn a_downloaded_remote_head_becomes_the_base_for_the_next_local_save() {
        let mut queue = AnnotationSyncQueue::default();
        queue
            .adopt_remote(candidate(3, FIRST_MUTATION), 5)
            .expect("install remote head");
        let remote = queue.entry(CAPTURE_ID).expect("remote entry");
        assert_eq!(remote.status, AnnotationSyncStatus::Synced);
        assert_eq!(remote.cloud_revision, 5);
        assert_eq!(remote.document_revision, 3);

        queue
            .stage(candidate(4, SECOND_MUTATION))
            .expect("edit imported project");
        let upload = queue.claim_next().expect("claim").expect("local edit");
        assert_eq!(upload.base_cloud_revision, 5);
        assert_eq!(upload.document_revision, 4);
    }

    #[test]
    fn a_new_remote_head_conflicts_with_unsynced_local_work_without_overwriting_it() {
        let mut queue = AnnotationSyncQueue::default();
        queue
            .adopt_remote(candidate(2, FIRST_MUTATION), 4)
            .expect("install starting head");
        queue
            .stage(candidate(3, SECOND_MUTATION))
            .expect("stage local work");
        queue
            .observe_remote_head(CAPTURE_ID, 6)
            .expect("observe other Mac head");

        let conflict = queue.entry(CAPTURE_ID).expect("local work remains");
        assert_eq!(conflict.status, AnnotationSyncStatus::Conflict);
        assert_eq!(conflict.cloud_revision, 6);
        assert_eq!(conflict.document_revision, 3);
        assert_eq!(conflict.mutation_id, SECOND_MUTATION);
        assert!(queue
            .claim_next()
            .expect("conflict blocks upload")
            .is_none());
    }

    #[test]
    fn remote_reconciliation_downloads_only_when_local_state_is_absent_or_fully_synced() {
        let head = RemoteAnnotationHead {
            capture_id: CAPTURE_ID.into(),
            cloud_revision: 6,
            document_revision: 4,
            mutation_id: SECOND_MUTATION.into(),
            original_storage_path: format!("annotation-assets/user/{CAPTURE_ID}/original.png"),
            flattened_storage_path: format!(
                "annotation-assets/user/{CAPTURE_ID}/revisions/{SECOND_MUTATION}.png"
            ),
            original_sha256: format!("sha256:{:064x}", 1),
            flattened_sha256: format!("sha256:{:064x}", 2),
        };
        assert_eq!(
            remote_reconcile_decision(None, &head),
            RemoteReconcileDecision::Download { replace: false }
        );

        let mut queue = AnnotationSyncQueue::default();
        queue
            .adopt_remote(candidate(3, FIRST_MUTATION), 5)
            .expect("synced base");
        assert_eq!(
            remote_reconcile_decision(queue.entry(CAPTURE_ID), &head),
            RemoteReconcileDecision::Download { replace: true }
        );
        queue
            .stage(candidate(4, SECOND_MUTATION))
            .expect("local edit");
        assert_eq!(
            remote_reconcile_decision(queue.entry(CAPTURE_ID), &head),
            RemoteReconcileDecision::Conflict
        );
        queue
            .observe_remote_head(CAPTURE_ID, 6)
            .expect("record conflict");
        assert_eq!(
            remote_reconcile_decision(queue.entry(CAPTURE_ID), &head),
            RemoteReconcileDecision::Current
        );
    }

    #[test]
    fn remote_annotation_waits_until_its_base_capture_is_local() {
        let mut ready = HashSet::new();
        assert!(!remote_capture_ready(&ready, CAPTURE_ID));
        ready.insert(CAPTURE_ID.to_string());
        assert!(remote_capture_ready(&ready, CAPTURE_ID));
    }

    #[test]
    fn opening_the_queue_recovers_pre_sync_local_projects_instead_of_leaving_them_unowned() {
        let root = tempfile::tempdir().expect("sync root");
        let projects = root.path().join("annotation-projects");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        fs::create_dir_all(&captures).expect("captures");
        fs::create_dir_all(&originals).expect("originals");
        let capture = captures.join(format!("{CAPTURE_ID}.png"));
        let original = originals.join(format!("{CAPTURE_ID}.png"));
        let image = image::RgbaImage::from_pixel(12, 8, image::Rgba([10, 20, 30, 255]));
        image.save(&capture).expect("capture png");
        image.save(&original).expect("original png");
        let flattened = fs::read(&capture).expect("flattened bytes");
        crate::annotation_project::persist_for_capture(
            &projects,
            &capture,
            &original,
            &flattened,
            0,
            None,
            vec![crate::annotation_project::AnnotationMark::Line {
                color: "red".into(),
                x1: 0.0,
                y1: 0.0,
                x2: 10.0,
                y2: 7.0,
                stroke_weight: None,
            }],
        )
        .expect("legacy local project");

        let queue = DurableAnnotationSyncQueue::open(
            root.path().join("annotation-sync-queue.json"),
            &projects,
            &captures,
            &originals,
        )
        .expect("open and recover queue");
        let recovered = queue.entry(CAPTURE_ID).expect("recovered local project");
        assert_eq!(recovered.status, AnnotationSyncStatus::Pending);
        assert_eq!(recovered.document_revision, 1);
        assert_eq!(
            recovered.project_path,
            projects.join(format!("{CAPTURE_ID}.json"))
        );
        assert!(root.path().join("annotation-sync-queue.json").exists());
    }
}
