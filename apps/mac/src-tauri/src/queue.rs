use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

const QUEUE_SCHEMA_VERSION: u32 = 1;
pub(crate) const RETRY_DELAYS_MS: [u64; 3] = [5_000, 30_000, 120_000];
pub(crate) const MAX_AUTOMATIC_ATTEMPTS: u8 = (RETRY_DELAYS_MS.len() + 1) as u8;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QueueSource {
    Region,
    Window,
    Fullscreen,
    Recovered,
}

impl From<crate::capture::CaptureMode> for QueueSource {
    fn from(mode: crate::capture::CaptureMode) -> Self {
        match mode {
            crate::capture::CaptureMode::Region => Self::Region,
            crate::capture::CaptureMode::Window => Self::Window,
            crate::capture::CaptureMode::Fullscreen => Self::Fullscreen,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QueueItemStatus {
    Pending,
    Uploading,
    Failed,
    Uploaded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueItem {
    pub(crate) id: String,
    pub(crate) file_path: PathBuf,
    pub(crate) created_at_ms: u64,
    pub(crate) source: QueueSource,
    pub(crate) status: QueueItemStatus,
    pub(crate) attempts: u8,
    pub(crate) next_attempt_at_ms: Option<u64>,
    pub(crate) last_error: Option<String>,
    #[serde(default)]
    pub(crate) annotated: bool,
}

impl QueueItem {
    pub(crate) fn is_terminal(&self) -> bool {
        self.status == QueueItemStatus::Failed
            && self.attempts >= MAX_AUTOMATIC_ATTEMPTS
            && self.next_attempt_at_ms.is_none()
    }

    fn ready_at(&self, now_ms: u64) -> bool {
        match self.status {
            QueueItemStatus::Pending => self.attempts < MAX_AUTOMATIC_ATTEMPTS,
            QueueItemStatus::Failed if self.attempts < MAX_AUTOMATIC_ATTEMPTS => self
                .next_attempt_at_ms
                .is_some_and(|ready_at| ready_at <= now_ms),
            QueueItemStatus::Uploading | QueueItemStatus::Failed | QueueItemStatus::Uploaded => {
                false
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueDocument {
    version: u32,
    entries: Vec<QueueItem>,
}

impl Default for QueueDocument {
    fn default() -> Self {
        Self {
            version: QUEUE_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EnqueueOutcome {
    Inserted,
    AlreadyPresent,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueSummary {
    pub(crate) pending: usize,
    pub(crate) uploading: usize,
    pub(crate) retrying: usize,
    pub(crate) failed: usize,
    pub(crate) uploaded: usize,
    pub(crate) total: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum CaptureQueueStatus {
    Enqueued { id: String, queued: usize },
    AlreadyQueued { id: String, queued: usize },
    Failed { code: &'static str, message: String },
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueRuntimeStatus {
    pub(crate) summary: QueueSummary,
    pub(crate) warning: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct RetryMonitorSnapshot {
    pub(crate) has_retryable_work: bool,
    pub(crate) next_retry_at_ms: Option<u64>,
}

impl QueueSummary {
    pub(crate) fn queued(self) -> usize {
        self.pending + self.uploading + self.retrying + self.failed
    }
}

#[derive(Debug)]
pub(crate) struct DurableUploadQueue {
    store_path: PathBuf,
    capture_directory: PathBuf,
    document: QueueDocument,
}

#[derive(Debug)]
struct QueuePersistError {
    message: String,
    commit_visible: bool,
}

impl QueuePersistError {
    fn before_commit(message: String) -> Self {
        Self {
            message,
            commit_visible: false,
        }
    }

    fn after_commit(message: String) -> Self {
        Self {
            message,
            commit_visible: true,
        }
    }
}

impl DurableUploadQueue {
    pub(crate) fn open(
        store_path: impl AsRef<Path>,
        capture_directory: impl AsRef<Path>,
        restart_time_ms: u64,
    ) -> Result<Self, String> {
        let store_path = store_path.as_ref().to_path_buf();
        let capture_directory = capture_directory.as_ref().to_path_buf();
        let document = match fs::read(&store_path) {
            Ok(bytes) => serde_json::from_slice::<QueueDocument>(&bytes)
                .map_err(|error| format!("Could not decode Capso's upload queue: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => QueueDocument::default(),
            Err(error) => return Err(format!("Could not read Capso's upload queue: {error}")),
        };
        validate_document(&document, &capture_directory)?;
        let mut queue = Self {
            store_path,
            capture_directory,
            document,
        };
        let recovered = queue.recover_unavailable_sources()
            | queue.recover_interrupted(restart_time_ms)
            | queue.reconcile_orphaned_captures(restart_time_ms)?
            | queue.reconcile_annotation_metadata()?;
        if recovered {
            queue.persist().map_err(|error| error.message)?;
        }
        Ok(queue)
    }

    pub(crate) fn enqueue(
        &mut self,
        source: &Path,
        capture_source: QueueSource,
        created_at_ms: u64,
    ) -> Result<EnqueueOutcome, String> {
        self.enqueue_with_sync(source, capture_source, created_at_ms, sync_directory)
    }

    fn enqueue_with_sync<S>(
        &mut self,
        source: &Path,
        capture_source: QueueSource,
        created_at_ms: u64,
        sync_parent: S,
    ) -> Result<EnqueueOutcome, String>
    where
        S: FnOnce(&Path) -> io::Result<()>,
    {
        let id = validate_capture_source(&self.capture_directory, source)?;
        if let Some(existing) = self.document.entries.iter().find(|entry| entry.id == id) {
            if existing.file_path == source {
                return Ok(EnqueueOutcome::AlreadyPresent);
            }
            return Err("The capture identifier is already queued with a different path.".into());
        }

        self.transaction_with(
            |document| {
                document.entries.push(QueueItem {
                    id,
                    file_path: source.to_path_buf(),
                    created_at_ms,
                    source: capture_source,
                    status: QueueItemStatus::Pending,
                    attempts: 0,
                    next_attempt_at_ms: None,
                    last_error: None,
                    annotated: false,
                });
                Ok(())
            },
            sync_parent,
        )?;
        Ok(EnqueueOutcome::Inserted)
    }

    // DUR-01b's network adapter will consume these transitions. DUR-01a keeps
    // them executable under T-UNIT-01 before any auth or network work exists.
    #[allow(dead_code)]
    pub(crate) fn claim_next(&mut self, now_ms: u64) -> Result<Option<QueueItem>, String> {
        self.claim_next_excluding(now_ms, &HashSet::new())
    }

    fn claim_next_excluding(
        &mut self,
        now_ms: u64,
        excluded: &HashSet<String>,
    ) -> Result<Option<QueueItem>, String> {
        let next_index = self
            .document
            .entries
            .iter()
            .enumerate()
            .filter(|(_, item)| item.ready_at(now_ms) && !excluded.contains(&item.id))
            .min_by(|(_, left), (_, right)| {
                (left.created_at_ms, left.id.as_str())
                    .cmp(&(right.created_at_ms, right.id.as_str()))
            })
            .map(|(index, _)| index);
        let Some(next_index) = next_index else {
            return Ok(None);
        };

        self.transaction(|document| {
            let item = &mut document.entries[next_index];
            item.status = QueueItemStatus::Uploading;
            item.attempts = item.attempts.saturating_add(1);
            item.next_attempt_at_ms = None;
            Ok(())
        })?;
        Ok(self.document.entries.get(next_index).cloned())
    }

    fn mark_annotated(&mut self, id: &str) -> Result<(), String> {
        self.transaction(|document| {
            let item = document
                .entries
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| "The queued capture no longer exists.".to_string())?;
            if item.status != QueueItemStatus::Pending || item.attempts != 0 {
                return Err("That capture can no longer be edited before upload.".into());
            }
            item.annotated = true;
            Ok(())
        })
    }

    #[allow(dead_code)]
    pub(crate) fn mark_failed(
        &mut self,
        id: &str,
        failed_at_ms: u64,
        error: &str,
    ) -> Result<(), String> {
        self.transaction(|document| {
            let item = document
                .entries
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| "The queued capture no longer exists.".to_string())?;
            if item.status != QueueItemStatus::Uploading || item.attempts == 0 {
                return Err("Only an active upload attempt can be marked failed.".into());
            }
            item.status = QueueItemStatus::Failed;
            item.last_error = Some(error.into());
            item.next_attempt_at_ms = if item.attempts >= MAX_AUTOMATIC_ATTEMPTS {
                None
            } else {
                let delay_index = usize::from(item.attempts.saturating_sub(1));
                RETRY_DELAYS_MS
                    .get(delay_index)
                    .map(|delay| failed_at_ms.saturating_add(*delay))
            };
            Ok(())
        })
    }

    pub(crate) fn mark_terminal(&mut self, id: &str, error: &str) -> Result<(), String> {
        self.transaction(|document| {
            let item = document
                .entries
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| "The queued capture no longer exists.".to_string())?;
            if item.status != QueueItemStatus::Uploading || item.attempts == 0 {
                return Err("Only an active upload attempt can be marked terminal.".into());
            }
            item.status = QueueItemStatus::Failed;
            item.attempts = MAX_AUTOMATIC_ATTEMPTS;
            item.next_attempt_at_ms = None;
            item.last_error = Some(error.into());
            Ok(())
        })
    }

    #[allow(dead_code)]
    pub(crate) fn mark_uploaded(&mut self, id: &str) -> Result<(), String> {
        self.transaction(|document| {
            let item = document
                .entries
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| "The queued capture no longer exists.".to_string())?;
            if item.status != QueueItemStatus::Uploading {
                return Err("Only an active upload can be marked remotely persisted.".into());
            }
            item.status = QueueItemStatus::Uploaded;
            item.next_attempt_at_ms = None;
            item.last_error = None;
            Ok(())
        })
    }

    pub(crate) fn mark_held(&mut self, id: &str, message: &str) -> Result<(), String> {
        self.transaction(|document| {
            let item = document
                .entries
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| "The queued capture no longer exists.".to_string())?;
            if item.status != QueueItemStatus::Uploading || item.attempts == 0 {
                return Err("Only an active upload attempt can be placed on hold.".into());
            }
            item.status = QueueItemStatus::Pending;
            item.attempts = item.attempts.saturating_sub(1);
            item.next_attempt_at_ms = None;
            item.last_error = Some(message.into());
            Ok(())
        })
    }

    #[allow(dead_code)]
    pub(crate) fn item(&self, id: &str) -> Option<&QueueItem> {
        self.document.entries.iter().find(|item| item.id == id)
    }

    pub(crate) fn capture_timestamps(&self) -> HashMap<String, u64> {
        self.document
            .entries
            .iter()
            .map(|item| (item.id.clone(), item.created_at_ms))
            .collect()
    }

    pub(crate) fn summary(&self) -> QueueSummary {
        let mut summary = QueueSummary {
            total: self.document.entries.len(),
            ..QueueSummary::default()
        };
        for item in &self.document.entries {
            match item.status {
                QueueItemStatus::Pending => summary.pending += 1,
                QueueItemStatus::Uploading => summary.uploading += 1,
                QueueItemStatus::Failed if item.is_terminal() => summary.failed += 1,
                QueueItemStatus::Failed => summary.retrying += 1,
                QueueItemStatus::Uploaded => summary.uploaded += 1,
            }
        }
        summary
    }

    pub(crate) fn next_retry_at_ms(&self) -> Option<u64> {
        self.document
            .entries
            .iter()
            .filter_map(|item| item.next_attempt_at_ms)
            .min()
    }

    pub(crate) fn retry_monitor_snapshot(&self) -> RetryMonitorSnapshot {
        RetryMonitorSnapshot {
            has_retryable_work: self.document.entries.iter().any(|item| {
                item.status == QueueItemStatus::Pending
                    || (item.status == QueueItemStatus::Failed && !item.is_terminal())
            }),
            next_retry_at_ms: self.next_retry_at_ms(),
        }
    }

    fn recover_interrupted(&mut self, restart_time_ms: u64) -> bool {
        let mut recovered = false;
        for item in &mut self.document.entries {
            if item.status == QueueItemStatus::Uploading {
                item.status = QueueItemStatus::Failed;
                item.next_attempt_at_ms = if item.attempts >= MAX_AUTOMATIC_ATTEMPTS {
                    None
                } else {
                    RETRY_DELAYS_MS
                        .get(usize::from(item.attempts.saturating_sub(1)))
                        .map(|delay| restart_time_ms.saturating_add(*delay))
                };
                item.last_error = Some(if item.is_terminal() {
                    format!(
                        "Final upload attempt was interrupted before confirmation at {restart_time_ms}; manual retry is required."
                    )
                } else {
                    format!(
                        "Upload interrupted before confirmation; recovered at {restart_time_ms}."
                    )
                });
                recovered = true;
            }
        }
        recovered
    }

    fn reconcile_orphaned_captures(&mut self, restart_time_ms: u64) -> Result<bool, String> {
        let entries = match fs::read_dir(&self.capture_directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Could not inspect Capso's captures for queue recovery: {error}"
                ));
            }
        };
        let mut known_ids = self
            .document
            .entries
            .iter()
            .map(|item| item.id.clone())
            .collect::<HashSet<_>>();
        let mut recovered = Vec::new();

        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("Could not inspect a Capso capture during queue recovery: {error}")
            })?;
            let path = entry.path();
            let Ok(id) = capture_id_from_path(&self.capture_directory, &path) else {
                continue;
            };
            if known_ids.contains(&id) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                format!("Could not inspect a Capso capture during queue recovery: {error}")
            })?;
            if !metadata.file_type().is_file() || metadata.len() == 0 {
                continue;
            }
            let created_at_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(restart_time_ms);
            known_ids.insert(id.clone());
            recovered.push(QueueItem {
                id,
                file_path: path,
                created_at_ms,
                source: QueueSource::Recovered,
                status: QueueItemStatus::Pending,
                attempts: 0,
                next_attempt_at_ms: None,
                last_error: Some(
                    "Recovered a durable capture that was interrupted before queue handoff.".into(),
                ),
                annotated: false,
            });
        }

        recovered.sort_by(|left, right| {
            (left.created_at_ms, left.id.as_str()).cmp(&(right.created_at_ms, right.id.as_str()))
        });
        let changed = !recovered.is_empty();
        self.document.entries.extend(recovered);
        Ok(changed)
    }

    fn recover_unavailable_sources(&mut self) -> bool {
        let mut recovered = false;
        for item in &mut self.document.entries {
            if item.status == QueueItemStatus::Uploaded {
                continue;
            }
            let unavailable = match fs::symlink_metadata(&item.file_path) {
                Ok(metadata) if metadata.len() == 0 => Some("empty"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some("missing"),
                _ => None,
            };
            if let Some(reason) = unavailable {
                item.status = QueueItemStatus::Failed;
                item.attempts = MAX_AUTOMATIC_ATTEMPTS;
                item.next_attempt_at_ms = None;
                item.last_error = Some(format!(
                    "The local capture is {reason}; Capso kept the queue record for recovery."
                ));
                recovered = true;
            }
        }
        recovered
    }

    fn reconcile_annotation_metadata(&mut self) -> Result<bool, String> {
        let Some(app_data_directory) = self.capture_directory.parent() else {
            return Ok(false);
        };
        let original_directory = app_data_directory.join("capture-originals");
        let mut recovered = false;

        for item in &mut self.document.entries {
            if item.annotated {
                continue;
            }
            let original = original_directory.join(format!("{}.png", item.id));
            let original_metadata = match fs::symlink_metadata(&original) {
                Ok(metadata) if metadata.file_type().is_file() && metadata.len() > 0 => metadata,
                Ok(_) => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not inspect Capso's protected annotation original: {error}"
                    ));
                }
            };
            let current_metadata = match fs::symlink_metadata(&item.file_path) {
                Ok(metadata) if metadata.file_type().is_file() && metadata.len() > 0 => metadata,
                _ => continue,
            };
            let differs = if original_metadata.len() != current_metadata.len() {
                true
            } else {
                let original_bytes = fs::read(&original).map_err(|error| {
                    format!("Could not read Capso's protected annotation original: {error}")
                })?;
                let current_bytes = fs::read(&item.file_path).map_err(|error| {
                    format!("Could not read Capso's annotated capture during recovery: {error}")
                })?;
                original_bytes != current_bytes
            };
            if differs {
                item.annotated = true;
                recovered = true;
            }
        }
        Ok(recovered)
    }

    fn transaction<F>(&mut self, mutation: F) -> Result<(), String>
    where
        F: FnOnce(&mut QueueDocument) -> Result<(), String>,
    {
        self.transaction_with(mutation, sync_directory)
    }

    fn transaction_with<F, S>(&mut self, mutation: F, sync_parent: S) -> Result<(), String>
    where
        F: FnOnce(&mut QueueDocument) -> Result<(), String>,
        S: FnOnce(&Path) -> io::Result<()>,
    {
        let previous = self.document.clone();
        mutation(&mut self.document)?;
        if let Err(error) = self.persist_with(sync_parent) {
            if !error.commit_visible {
                self.document = previous;
            }
            return Err(error.message);
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), QueuePersistError> {
        self.persist_with(sync_directory)
    }

    fn persist_with<S>(&self, sync_parent: S) -> Result<(), QueuePersistError>
    where
        S: FnOnce(&Path) -> io::Result<()>,
    {
        let parent = self.store_path.parent().ok_or_else(|| {
            QueuePersistError::before_commit(
                "The upload queue path has no parent directory.".to_string(),
            )
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            QueuePersistError::before_commit(format!(
                "Could not create Capso's queue directory: {error}"
            ))
        })?;
        let file_name = self
            .store_path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| {
                QueuePersistError::before_commit(
                    "The upload queue filename is invalid.".to_string(),
                )
            })?;
        let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(&self.document).map_err(|error| {
            QueuePersistError::before_commit(format!(
                "Could not encode Capso's upload queue: {error}"
            ))
        })?;

        let write_result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("Could not reserve Capso's queue update: {error}"))?;
            file.write_all(&bytes)
                .map_err(|error| format!("Could not write Capso's upload queue: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Could not sync Capso's upload queue: {error}"))?;
            Ok(())
        })();
        if let Err(message) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(QueuePersistError::before_commit(message));
        }
        if let Err(error) = fs::rename(&temporary, &self.store_path) {
            let _ = fs::remove_file(&temporary);
            return Err(QueuePersistError::before_commit(format!(
                "Could not commit Capso's upload queue: {error}"
            )));
        }
        sync_parent(parent).map_err(|error| {
            QueuePersistError::after_commit(format!(
                "Could not sync Capso's queue directory after commit: {error}"
            ))
        })
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[derive(Debug, Default)]
pub(crate) struct QueueRuntime {
    queue: Option<DurableUploadQueue>,
    warning: Option<String>,
    quick_access_reservations: HashSet<String>,
    annotation_reservations: HashSet<String>,
}

impl QueueRuntime {
    fn initialize(&mut self, queue: Result<DurableUploadQueue, String>) {
        self.quick_access_reservations.clear();
        self.annotation_reservations.clear();
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

    fn enqueue(
        &mut self,
        source: &Path,
        capture_source: QueueSource,
        created_at_ms: u64,
    ) -> Result<(String, EnqueueOutcome, QueueSummary), String> {
        let queue = self.queue.as_mut().ok_or_else(|| {
            self.warning
                .clone()
                .unwrap_or_else(|| "Capso's upload queue is not initialized.".into())
        })?;
        let id = capture_id_from_path(&queue.capture_directory, source)?;
        match queue.enqueue(source, capture_source, created_at_ms) {
            Ok(outcome) => {
                self.warning = None;
                self.quick_access_reservations.insert(id.clone());
                Ok((id, outcome, queue.summary()))
            }
            Err(error) => {
                if queue.item(&id).is_some() {
                    self.quick_access_reservations.insert(id);
                }
                self.warning = Some(error.clone());
                Err(error)
            }
        }
    }

    pub(crate) fn status(&self) -> QueueRuntimeStatus {
        QueueRuntimeStatus {
            summary: self
                .queue
                .as_ref()
                .map(DurableUploadQueue::summary)
                .unwrap_or_default(),
            warning: self.warning.clone(),
        }
    }

    pub(crate) fn capture_timestamps(&self) -> Result<HashMap<String, u64>, String> {
        self.queue
            .as_ref()
            .map(DurableUploadQueue::capture_timestamps)
            .ok_or_else(|| self.unavailable_message())
    }

    fn unavailable_message(&self) -> String {
        self.warning
            .clone()
            .unwrap_or_else(|| "Capso's upload queue is not initialized.".into())
    }

    fn record_drain_result<T>(&mut self, result: Result<T, String>) -> Result<T, String> {
        match result {
            Ok(value) => {
                self.warning = None;
                Ok(value)
            }
            Err(error) => {
                self.warning = Some(error.clone());
                Err(error)
            }
        }
    }

    pub(crate) fn claim_next(&mut self, now_ms: u64) -> Result<Option<QueueItem>, String> {
        let reservations = self
            .quick_access_reservations
            .union(&self.annotation_reservations)
            .cloned()
            .collect();
        let result = match self.queue.as_mut() {
            Some(queue) => queue.claim_next_excluding(now_ms, &reservations),
            None => Err(self.unavailable_message()),
        };
        self.record_drain_result(result)
    }

    pub(crate) fn publish_quick_access(&mut self, source: Option<&Path>) -> Result<bool, String> {
        let active_id = match source {
            Some(source) => {
                let queue = self
                    .queue
                    .as_ref()
                    .ok_or_else(|| self.unavailable_message())?;
                Some(capture_id_from_path(&queue.capture_directory, source)?)
            }
            None => None,
        };
        let before = self.quick_access_reservations.len();
        self.quick_access_reservations
            .retain(|id| active_id.as_ref() == Some(id));
        Ok(self.quick_access_reservations.len() != before)
    }

    pub(crate) fn release_quick_access(&mut self, source: &Path) -> Result<bool, String> {
        let queue = self
            .queue
            .as_ref()
            .ok_or_else(|| self.unavailable_message())?;
        let id = capture_id_from_path(&queue.capture_directory, source)?;
        Ok(self.quick_access_reservations.remove(&id))
    }

    pub(crate) fn begin_annotation(&mut self, source: &Path) -> Result<String, String> {
        let queue = self
            .queue
            .as_ref()
            .ok_or_else(|| self.unavailable_message())?;
        let id = capture_id_from_path(&queue.capture_directory, source)?;
        let item = queue
            .item(&id)
            .ok_or_else(|| "That capture is not waiting in Capso's upload queue.".to_string())?;
        if item.status != QueueItemStatus::Pending || item.attempts != 0 {
            return Err("That capture can no longer be edited before upload.".into());
        }
        if self.annotation_reservations.contains(&id) {
            return Err("That capture is already open in the annotation editor.".into());
        }
        if !self.quick_access_reservations.remove(&id) {
            return Err("That capture is no longer reserved for editing before upload.".into());
        }
        self.annotation_reservations.insert(id.clone());
        Ok(id)
    }

    pub(crate) fn cancel_annotation(&mut self, id: &str) {
        if self.annotation_reservations.remove(id) {
            self.quick_access_reservations.insert(id.to_string());
        }
    }

    pub(crate) fn record_annotation(&mut self, id: &str) -> Result<(), String> {
        if !self.annotation_reservations.contains(id) {
            return Err("That annotation session is no longer active.".into());
        }
        let unavailable = self.unavailable_message();
        self.queue.as_mut().ok_or(unavailable)?.mark_annotated(id)
    }

    pub(crate) fn complete_annotation(&mut self, id: &str) -> Result<(), String> {
        if self.annotation_reservations.remove(id) {
            Ok(())
        } else {
            Err("That annotation session is no longer active.".into())
        }
    }

    pub(crate) fn mark_uploaded(&mut self, id: &str) -> Result<(), String> {
        let result = match self.queue.as_mut() {
            Some(queue) => queue.mark_uploaded(id),
            None => Err(self.unavailable_message()),
        };
        self.record_drain_result(result)
    }

    pub(crate) fn mark_failed(
        &mut self,
        id: &str,
        failed_at_ms: u64,
        error: &str,
    ) -> Result<(), String> {
        let result = match self.queue.as_mut() {
            Some(queue) => queue.mark_failed(id, failed_at_ms, error),
            None => Err(self.unavailable_message()),
        };
        self.record_drain_result(result)
    }

    pub(crate) fn mark_terminal(&mut self, id: &str, error: &str) -> Result<(), String> {
        let result = match self.queue.as_mut() {
            Some(queue) => queue.mark_terminal(id, error),
            None => Err(self.unavailable_message()),
        };
        self.record_drain_result(result)
    }

    pub(crate) fn mark_held(&mut self, id: &str, message: &str) -> Result<(), String> {
        let result = match self.queue.as_mut() {
            Some(queue) => queue.mark_held(id, message),
            None => Err(self.unavailable_message()),
        };
        self.record_drain_result(result)
    }

    pub(crate) fn drain_summary(&self) -> Result<QueueSummary, String> {
        self.queue
            .as_ref()
            .map(DurableUploadQueue::summary)
            .ok_or_else(|| self.unavailable_message())
    }

    pub(crate) fn retry_monitor_snapshot(&self) -> Result<RetryMonitorSnapshot, String> {
        self.queue
            .as_ref()
            .map(DurableUploadQueue::retry_monitor_snapshot)
            .ok_or_else(|| self.unavailable_message())
    }
}

fn now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .map_err(|error| format!("The system clock cannot timestamp the capture queue: {error}"))
}

fn queue_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    app.path()
        .app_data_dir()
        .map(|directory| {
            (
                directory.join("upload-queue.json"),
                directory.join("captures"),
            )
        })
        .map_err(|error| format!("Could not locate Capso's upload queue: {error}"))
}

pub(crate) fn initialize_for_app(app: &AppHandle) -> Result<QueueRuntimeStatus, String> {
    let (store_path, capture_directory) = queue_paths(app)?;
    let opened = DurableUploadQueue::open(store_path, capture_directory, now_ms()?);
    let state = app.state::<std::sync::Mutex<QueueRuntime>>();
    let mut runtime = state
        .lock()
        .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?;
    runtime.initialize(opened);
    Ok(runtime.status())
}

pub(crate) fn current_status(app: &AppHandle) -> Result<QueueRuntimeStatus, String> {
    app.state::<std::sync::Mutex<QueueRuntime>>()
        .lock()
        .map(|runtime| runtime.status())
        .map_err(|_| "Capso's upload queue is temporarily unavailable.".into())
}

pub(crate) fn retry_monitor_snapshot_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<RetryMonitorSnapshot, String> {
    app.state::<std::sync::Mutex<QueueRuntime>>()
        .lock()
        .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?
        .retry_monitor_snapshot()
}

pub(crate) fn capture_timestamps_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<HashMap<String, u64>, String> {
    app.state::<std::sync::Mutex<QueueRuntime>>()
        .lock()
        .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?
        .capture_timestamps()
}

pub(crate) fn publish_quick_access_for_app<R: Runtime>(
    app: &AppHandle<R>,
    active_capture: Option<&Path>,
) -> Result<bool, String> {
    app.state::<std::sync::Mutex<QueueRuntime>>()
        .lock()
        .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?
        .publish_quick_access(active_capture)
}

pub(crate) fn release_quick_access_for_app<R: Runtime>(
    app: &AppHandle<R>,
    capture: &Path,
) -> Result<bool, String> {
    app.state::<std::sync::Mutex<QueueRuntime>>()
        .lock()
        .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?
        .release_quick_access(capture)
}

pub(crate) async fn enqueue_capture(
    app: AppHandle,
    source: PathBuf,
    capture_source: QueueSource,
) -> CaptureQueueStatus {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let account_boundary = app.state::<crate::AuthAccountBoundary>();
        let _account_guard = account_boundary.lock()?;
        let created_at_ms = now_ms()?;
        let state = app.state::<std::sync::Mutex<QueueRuntime>>();
        let mut runtime = state
            .lock()
            .map_err(|_| "Capso's upload queue is temporarily unavailable.".to_string())?;
        runtime.enqueue(&source, capture_source, created_at_ms)
    })
    .await;

    match result {
        Ok(Ok((id, EnqueueOutcome::Inserted, summary))) => CaptureQueueStatus::Enqueued {
            id,
            queued: summary.queued(),
        },
        Ok(Ok((id, EnqueueOutcome::AlreadyPresent, summary))) => {
            CaptureQueueStatus::AlreadyQueued {
                id,
                queued: summary.queued(),
            }
        }
        Ok(Err(message)) => CaptureQueueStatus::Failed {
            code: "queue_persist_failed",
            message,
        },
        Err(error) => CaptureQueueStatus::Failed {
            code: "queue_task_failed",
            message: format!("The capture queue task stopped unexpectedly: {error}"),
        },
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string() == value)
        .unwrap_or(false)
}

fn capture_id_from_path(capture_directory: &Path, source: &Path) -> Result<String, String> {
    if source.parent() != Some(capture_directory) || source.extension() != Some(OsStr::new("png")) {
        return Err("The queued capture is outside Capso's protected capture directory.".into());
    }
    let id = source
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "The queued capture filename is invalid.".to_string())?;
    if !canonical_uuid(id) || source != capture_directory.join(format!("{id}.png")) {
        return Err("The queued capture identifier is invalid.".into());
    }
    Ok(id.into())
}

fn validate_capture_source(capture_directory: &Path, source: &Path) -> Result<String, String> {
    let id = capture_id_from_path(capture_directory, source)?;
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect the queued capture: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err("The queued capture is no longer a non-empty regular PNG file.".into());
    }
    Ok(id)
}

fn validate_document(document: &QueueDocument, capture_directory: &Path) -> Result<(), String> {
    if document.version != QUEUE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Capso upload queue version {}.",
            document.version
        ));
    }
    let mut ids = HashSet::new();
    for item in &document.entries {
        if !ids.insert(item.id.as_str()) {
            return Err(format!("Duplicate queued capture identifier {}.", item.id));
        }
        let path_id = capture_id_from_path(capture_directory, &item.file_path)?;
        if path_id != item.id {
            return Err("A queued capture identifier does not match its protected path.".into());
        }
        if item.status != QueueItemStatus::Uploaded {
            match fs::symlink_metadata(&item.file_path) {
                Ok(metadata) if !metadata.file_type().is_file() => {
                    return Err("A queued capture is not a direct regular file.".into());
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Could not inspect a queued capture: {error}"));
                }
            }
        }
        if item.attempts > MAX_AUTOMATIC_ATTEMPTS {
            return Err("A queued capture has an invalid attempt count.".into());
        }
        match item.status {
            QueueItemStatus::Pending
                if item.attempts >= MAX_AUTOMATIC_ATTEMPTS || item.next_attempt_at_ms.is_some() =>
            {
                return Err("A pending queued capture has invalid retry state.".into());
            }
            QueueItemStatus::Uploading
                if item.attempts == 0 || item.next_attempt_at_ms.is_some() =>
            {
                return Err("An active queued upload has invalid attempt state.".into());
            }
            QueueItemStatus::Failed
                if item.attempts == 0
                    || (item.attempts < MAX_AUTOMATIC_ATTEMPTS)
                        != item.next_attempt_at_ms.is_some() =>
            {
                return Err("A failed queued upload has invalid retry state.".into());
            }
            QueueItemStatus::Uploaded
                if item.attempts == 0 || item.next_attempt_at_ms.is_some() =>
            {
                return Err("A completed queued upload has invalid attempt state.".into());
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        DurableUploadQueue, EnqueueOutcome, QueueItemStatus, QueueRuntime, QueueSource,
        RetryMonitorSnapshot, MAX_AUTOMATIC_ATTEMPTS, RETRY_DELAYS_MS,
    };
    use crate::drain::{
        DrainCoordinator, DrainWake, TransportAvailability, UploadAcknowledgement, UploadResult,
        UploadTransport, WakeResult,
    };
    use std::{
        fs,
        path::Path,
        sync::{Arc, Mutex},
    };

    const FIRST_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";
    const SECOND_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92271";
    const THIRD_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f92272";

    fn capture(directory: &Path, id: &str) -> std::path::PathBuf {
        fs::create_dir_all(directory).expect("create capture directory");
        let path = directory.join(format!("{id}.png"));
        fs::write(&path, b"\x89PNG\r\n\x1a\nqueue fixture").expect("write capture fixture");
        path
    }

    #[test]
    fn enqueue_persists_and_restart_restores_fifo_without_duplicates() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut queue = DurableUploadQueue::open(&store, &captures, 1_000).expect("open queue");
        let first = capture(&captures, FIRST_ID);
        let second = capture(&captures, SECOND_ID);
        let third = capture(&captures, THIRD_ID);
        assert_eq!(
            queue
                .enqueue(&second, QueueSource::Window, 2_000)
                .expect("enqueue second"),
            EnqueueOutcome::Inserted
        );
        assert_eq!(
            queue
                .enqueue(&first, QueueSource::Region, 1_000)
                .expect("enqueue first"),
            EnqueueOutcome::Inserted
        );
        assert_eq!(
            queue
                .enqueue(&third, QueueSource::Fullscreen, 3_000)
                .expect("enqueue third"),
            EnqueueOutcome::Inserted
        );
        assert_eq!(
            queue
                .enqueue(&first, QueueSource::Region, 4_000)
                .expect("dedupe first"),
            EnqueueOutcome::AlreadyPresent
        );
        drop(queue);

        let mut restored =
            DurableUploadQueue::open(&store, &captures, 5_000).expect("restore queue");
        assert_eq!(restored.summary().pending, 3);
        assert_eq!(restored.summary().total, 3);
        assert_eq!(
            restored
                .claim_next(5_000)
                .expect("persist first claim")
                .expect("claim first")
                .id,
            FIRST_ID
        );
        restored.mark_uploaded(FIRST_ID).expect("complete first");
        assert_eq!(
            restored
                .claim_next(5_000)
                .expect("persist second claim")
                .expect("claim second")
                .id,
            SECOND_ID
        );
        restored.mark_uploaded(SECOND_ID).expect("complete second");
        assert_eq!(
            restored
                .claim_next(5_000)
                .expect("persist third claim")
                .expect("claim third")
                .id,
            THIRD_ID
        );
        restored.mark_uploaded(THIRD_ID).expect("complete third");
        assert!(restored
            .claim_next(5_000)
            .expect("read exhausted queue")
            .is_none());

        drop(restored);
        let mut completed =
            DurableUploadQueue::open(&store, &captures, 6_000).expect("restore completed queue");
        assert_eq!(completed.summary().uploaded, 3);
        assert!(completed
            .claim_next(6_000)
            .expect("read completed queue")
            .is_none());
        assert_eq!(
            completed
                .enqueue(&first, QueueSource::Region, 6_000)
                .expect("dedupe completed"),
            EnqueueOutcome::AlreadyPresent
        );
        assert!(
            first.exists(),
            "queue completion must not delete local pixels"
        );
    }

    #[test]
    fn history_timestamps_survive_status_changes_and_restart() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let source = capture(&captures, FIRST_ID);
        queue
            .enqueue(&source, QueueSource::Region, 1_234)
            .expect("enqueue capture");
        queue.claim_next(2_000).expect("claim").expect("item");
        queue.mark_uploaded(FIRST_ID).expect("complete upload");
        drop(queue);

        let restored =
            DurableUploadQueue::open(&store, &captures, 3_000).expect("restore completed queue");

        assert_eq!(
            restored.capture_timestamps(),
            std::collections::HashMap::from([(FIRST_ID.to_string(), 1_234)])
        );
    }

    #[test]
    fn annotation_reservation_blocks_upload_until_flattened_pixels_are_committed() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let source = capture(&captures, FIRST_ID);
        let queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let mut runtime = QueueRuntime::default();
        runtime.initialize(Ok(queue));
        runtime
            .enqueue(&source, QueueSource::Region, 0)
            .expect("enqueue capture");

        assert_eq!(
            runtime.begin_annotation(&source).expect("reserve"),
            FIRST_ID
        );
        assert!(runtime.claim_next(1).expect("inspect queue").is_none());
        runtime
            .record_annotation(FIRST_ID)
            .expect("commit annotation record");

        let item = runtime
            .queue
            .as_ref()
            .and_then(|queue| queue.item(FIRST_ID))
            .expect("queued annotation");
        assert!(item.annotated);
        assert_eq!(item.status, QueueItemStatus::Pending);
        assert!(runtime.claim_next(2).expect("still reserved").is_none());
        runtime
            .complete_annotation(FIRST_ID)
            .expect("release annotation reservation");
        assert_eq!(
            runtime
                .claim_next(3)
                .expect("claim after annotation")
                .expect("item")
                .id,
            FIRST_ID
        );
    }

    #[derive(Clone, Debug, Default)]
    struct ImmediateAuthenticatedTransport {
        uploaded_pixels: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl UploadTransport for ImmediateAuthenticatedTransport {
        fn availability(&self) -> TransportAvailability {
            TransportAvailability::Ready
        }

        fn upload(&self, item: &super::QueueItem) -> UploadResult {
            self.uploaded_pixels
                .lock()
                .expect("uploaded pixels lock")
                .push(fs::read(&item.file_path).expect("read exact queued pixels"));
            UploadResult::Confirmed(UploadAcknowledgement {
                capture_id: item.id.clone(),
            })
        }
    }

    #[test]
    fn quick_access_reservation_prevents_fast_upload_then_releases_flattened_pixels() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let source = capture(&captures, FIRST_ID);
        let queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let mut runtime = QueueRuntime::default();
        runtime.initialize(Ok(queue));
        runtime
            .enqueue(&source, QueueSource::Region, 0)
            .expect("enqueue and reserve Quick Access");
        let runtime = Mutex::new(runtime);
        let transport = ImmediateAuthenticatedTransport::default();
        let coordinator = DrainCoordinator::default();

        let WakeResult::Ran(held) = coordinator
            .wake(DrainWake::CaptureEnqueued, &runtime, &transport, 1)
            .expect("fast authenticated wake")
        else {
            panic!("first wake must run")
        };
        assert_eq!(held.attempted, 0);
        assert!(transport
            .uploaded_pixels
            .lock()
            .expect("uploaded pixels lock")
            .is_empty());

        {
            let mut runtime = runtime.lock().expect("queue runtime lock");
            assert_eq!(
                runtime
                    .begin_annotation(&source)
                    .expect("transfer reservation"),
                FIRST_ID
            );
            fs::write(&source, b"\x89PNG\r\n\x1a\nflattened pixels")
                .expect("write flattened pixels");
            runtime
                .record_annotation(FIRST_ID)
                .expect("record flattened annotation");
            runtime
                .complete_annotation(FIRST_ID)
                .expect("release annotation");
        }

        let WakeResult::Ran(drained) = coordinator
            .wake(DrainWake::CaptureEnqueued, &runtime, &transport, 2)
            .expect("wake after annotation")
        else {
            panic!("second wake must run")
        };
        assert_eq!(drained.uploaded, 1);
        assert_eq!(
            *transport
                .uploaded_pixels
                .lock()
                .expect("uploaded pixels lock"),
            vec![b"\x89PNG\r\n\x1a\nflattened pixels".to_vec()]
        );
    }

    #[test]
    fn cancelling_annotation_restores_quick_access_before_unmodified_upload() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let source = capture(&captures, FIRST_ID);
        let queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let mut runtime = QueueRuntime::default();
        runtime.initialize(Ok(queue));
        runtime
            .enqueue(&source, QueueSource::Region, 0)
            .expect("enqueue capture");

        let id = runtime.begin_annotation(&source).expect("reserve");
        runtime.cancel_annotation(&id);
        assert!(runtime
            .claim_next(1)
            .expect("Quick Access remains reserved")
            .is_none());
        assert!(runtime
            .release_quick_access(&source)
            .expect("dismiss Quick Access"));
        let claimed = runtime
            .claim_next(2)
            .expect("claim queue")
            .expect("capture");
        assert!(!claimed.annotated);
    }

    #[test]
    fn restart_recovers_annotation_metadata_only_after_pixels_changed() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let originals = root.path().join("capture-originals");
        let store = root.path().join("upload-queue.json");
        let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let source = capture(&captures, FIRST_ID);
        queue
            .enqueue(&source, QueueSource::Region, 0)
            .expect("enqueue capture");
        fs::create_dir_all(&originals).expect("create protected originals");
        fs::copy(&source, originals.join(format!("{FIRST_ID}.png"))).expect("preserve original");
        drop(queue);

        let unchanged =
            DurableUploadQueue::open(&store, &captures, 1).expect("restart before replacement");
        assert!(!unchanged.item(FIRST_ID).expect("unchanged item").annotated);
        drop(unchanged);

        fs::write(&source, b"\x89PNG\r\n\x1a\nflattened annotation")
            .expect("replace canonical pixels");
        let recovered =
            DurableUploadQueue::open(&store, &captures, 2).expect("restart after replacement");
        assert!(recovered.item(FIRST_ID).expect("recovered item").annotated);
        drop(recovered);

        let durable =
            DurableUploadQueue::open(&store, &captures, 3).expect("restart persisted metadata");
        assert!(durable.item(FIRST_ID).expect("durable item").annotated);
    }

    #[test]
    fn failures_back_off_then_terminal_items_do_not_block_healthy_work() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let poison = capture(&captures, FIRST_ID);
        let healthy = capture(&captures, SECOND_ID);
        let later = capture(&captures, THIRD_ID);
        queue
            .enqueue(&poison, QueueSource::Region, 0)
            .expect("enqueue poison");
        queue
            .enqueue(&healthy, QueueSource::Window, 1)
            .expect("enqueue healthy");

        for (attempt_index, delay) in RETRY_DELAYS_MS.iter().enumerate() {
            let claim_time = if attempt_index == 0 {
                0
            } else {
                RETRY_DELAYS_MS[..attempt_index].iter().sum()
            };
            let claimed = queue
                .claim_next(claim_time)
                .expect("persist poison claim")
                .expect("claim poison retry");
            assert_eq!(claimed.id, FIRST_ID);
            assert_eq!(claimed.attempts as usize, attempt_index + 1);
            queue
                .mark_failed(FIRST_ID, claim_time, "network unavailable")
                .expect("record failure");
            let item = queue.item(FIRST_ID).expect("failed item remains");
            assert_eq!(item.next_attempt_at_ms, Some(claim_time + delay));

            if attempt_index == 0 {
                let healthy_claim = queue
                    .claim_next(1)
                    .expect("persist healthy claim")
                    .expect("healthy item is not blocked");
                assert_eq!(healthy_claim.id, SECOND_ID);
                queue
                    .mark_uploaded(SECOND_ID)
                    .expect("complete healthy item");
            }
        }

        let terminal_time: u64 = RETRY_DELAYS_MS.iter().sum();
        let terminal = queue
            .claim_next(terminal_time)
            .expect("persist final claim")
            .expect("claim final attempt");
        assert_eq!(terminal.id, FIRST_ID);
        assert_eq!(terminal.attempts, MAX_AUTOMATIC_ATTEMPTS);
        queue
            .mark_failed(FIRST_ID, terminal_time, "still offline")
            .expect("record terminal failure");
        let poison_item = queue.item(FIRST_ID).expect("poison remains visible");
        assert_eq!(poison_item.status, QueueItemStatus::Failed);
        assert_eq!(poison_item.next_attempt_at_ms, None);
        assert!(poison_item.is_terminal());

        queue
            .enqueue(&later, QueueSource::Fullscreen, terminal_time + 1)
            .expect("enqueue later");
        assert_eq!(
            queue
                .claim_next(terminal_time + 1)
                .expect("persist later claim")
                .expect("claim later healthy item")
                .id,
            THIRD_ID
        );
    }

    #[test]
    fn restart_recovers_an_interrupted_upload_without_losing_attempt_history() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut first = DurableUploadQueue::open(&store, &captures, 100).expect("open queue");
        let source = capture(&captures, FIRST_ID);
        first
            .enqueue(&source, QueueSource::Region, 100)
            .expect("enqueue");
        let claimed = first
            .claim_next(100)
            .expect("persist pre-crash claim")
            .expect("claim before crash");
        assert_eq!(claimed.attempts, 1);
        assert_eq!(claimed.status, QueueItemStatus::Uploading);
        drop(first);

        let mut restarted =
            DurableUploadQueue::open(&store, &captures, 200).expect("restart queue");
        let recovered = restarted.item(FIRST_ID).expect("recovered item");
        assert_eq!(recovered.status, QueueItemStatus::Failed);
        assert_eq!(recovered.attempts, 1);
        assert_eq!(recovered.next_attempt_at_ms, Some(5_200));
        assert!(restarted
            .claim_next(5_199)
            .expect("inspect pre-deadline queue")
            .is_none());
        let claimed_again = restarted
            .claim_next(5_200)
            .expect("persist recovered claim")
            .expect("retry interrupted item");
        assert_eq!(claimed_again.attempts, 2);
    }

    #[test]
    fn every_interrupted_attempt_reenters_its_exact_retry_schedule() {
        for interrupted_attempt in 1..MAX_AUTOMATIC_ATTEMPTS {
            let root = tempfile::tempdir().expect("temporary app data");
            let captures = root.path().join("captures");
            let store = root.path().join("upload-queue.json");
            let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
            let source = capture(&captures, FIRST_ID);
            queue
                .enqueue(&source, QueueSource::Region, 0)
                .expect("enqueue");
            let mut attempt_time = 0;

            loop {
                let claimed = queue
                    .claim_next(attempt_time)
                    .expect("persist claim")
                    .expect("claim attempt");
                if claimed.attempts == interrupted_attempt {
                    break;
                }
                queue
                    .mark_failed(FIRST_ID, attempt_time, "network unavailable")
                    .expect("record failure");
                attempt_time = queue
                    .item(FIRST_ID)
                    .expect("scheduled item")
                    .next_attempt_at_ms
                    .expect("retry deadline");
            }
            drop(queue);

            let restart_time = 1_000_000 + u64::from(interrupted_attempt);
            let mut restarted =
                DurableUploadQueue::open(&store, &captures, restart_time).expect("restart queue");
            let expected_deadline =
                restart_time + RETRY_DELAYS_MS[usize::from(interrupted_attempt.saturating_sub(1))];
            assert_eq!(
                restarted
                    .item(FIRST_ID)
                    .expect("recovered item")
                    .next_attempt_at_ms,
                Some(expected_deadline)
            );
            assert!(restarted
                .claim_next(expected_deadline - 1)
                .expect("inspect before retry")
                .is_none());
            assert_eq!(
                restarted
                    .claim_next(expected_deadline)
                    .expect("persist scheduled retry")
                    .expect("claim scheduled retry")
                    .attempts,
                interrupted_attempt + 1
            );
        }
    }

    #[test]
    fn earliest_retry_deadline_ignores_pending_uploaded_and_terminal_items() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let first = capture(&captures, FIRST_ID);
        let second = capture(&captures, SECOND_ID);
        let third = capture(&captures, THIRD_ID);
        let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        queue
            .enqueue(&first, QueueSource::Region, 1)
            .expect("enqueue first");
        queue
            .enqueue(&second, QueueSource::Window, 2)
            .expect("enqueue second");
        queue
            .enqueue(&third, QueueSource::Fullscreen, 3)
            .expect("enqueue third");

        let first_claim = queue.claim_next(100).expect("claim first").expect("first");
        queue
            .mark_failed(&first_claim.id, 100, "retry first")
            .expect("fail first");
        let second_claim = queue
            .claim_next(101)
            .expect("claim second")
            .expect("second");
        queue
            .mark_failed(&second_claim.id, 1_000, "retry second")
            .expect("fail second");
        let third_claim = queue.claim_next(102).expect("claim third").expect("third");
        queue.mark_uploaded(&third_claim.id).expect("upload third");

        assert_eq!(queue.next_retry_at_ms(), Some(5_100));
        assert_eq!(
            queue.retry_monitor_snapshot(),
            RetryMonitorSnapshot {
                has_retryable_work: true,
                next_retry_at_ms: Some(5_100),
            }
        );
    }

    #[test]
    fn restart_reconciles_an_orphaned_durable_capture_idempotently() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let orphan = capture(&captures, FIRST_ID);

        let first = DurableUploadQueue::open(&store, &captures, 123).expect("reconcile orphan");
        let recovered = first.item(FIRST_ID).expect("orphan is queued");
        assert_eq!(recovered.status, QueueItemStatus::Pending);
        assert_eq!(recovered.source, QueueSource::Recovered);
        assert_eq!(first.summary().total, 1);
        assert!(store.exists(), "reconciliation must be durable");
        drop(first);

        let second = DurableUploadQueue::open(&store, &captures, 456).expect("restart again");
        assert_eq!(second.summary().total, 1);
        assert_eq!(second.item(FIRST_ID).expect("same item").file_path, orphan);
    }

    #[test]
    fn restart_does_not_exceed_the_attempt_limit_after_a_final_interruption() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut first = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let poison = capture(&captures, FIRST_ID);
        let healthy = capture(&captures, SECOND_ID);
        first
            .enqueue(&poison, QueueSource::Region, 0)
            .expect("enqueue poison");

        let mut now = 0;
        for delay in RETRY_DELAYS_MS {
            let claimed = first
                .claim_next(now)
                .expect("persist claim")
                .expect("claim retry");
            first
                .mark_failed(&claimed.id, now, "network unavailable")
                .expect("record retry");
            now += delay;
        }
        let final_attempt = first
            .claim_next(now)
            .expect("persist final claim")
            .expect("claim final attempt");
        assert_eq!(final_attempt.attempts, MAX_AUTOMATIC_ATTEMPTS);
        drop(first);

        let mut restarted =
            DurableUploadQueue::open(&store, &captures, now + 1).expect("restart queue");
        let recovered = restarted.item(FIRST_ID).expect("recovered final attempt");
        assert!(recovered.is_terminal());
        assert_eq!(recovered.attempts, MAX_AUTOMATIC_ATTEMPTS);

        restarted
            .enqueue(&healthy, QueueSource::Window, now + 2)
            .expect("enqueue healthy");
        assert_eq!(
            restarted
                .claim_next(now + 2)
                .expect("persist healthy claim")
                .expect("claim healthy after poison")
                .id,
            SECOND_ID
        );
    }

    #[test]
    fn missing_poison_capture_is_terminal_after_restart_and_does_not_block_fifo() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut first = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let missing = capture(&captures, FIRST_ID);
        let healthy = capture(&captures, SECOND_ID);
        first
            .enqueue(&missing, QueueSource::Region, 0)
            .expect("enqueue missing");
        first
            .enqueue(&healthy, QueueSource::Window, 1)
            .expect("enqueue healthy");
        drop(first);
        fs::remove_file(&missing).expect("simulate missing local pixels");

        let mut restarted =
            DurableUploadQueue::open(&store, &captures, 10).expect("restore around poison item");
        let poison = restarted
            .item(FIRST_ID)
            .expect("poison entry remains visible");
        assert!(poison.is_terminal());
        assert!(poison
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("missing")));
        assert_eq!(restarted.summary().failed, 1);
        assert_eq!(
            restarted
                .claim_next(10)
                .expect("persist healthy claim")
                .expect("healthy item remains claimable")
                .id,
            SECOND_ID
        );
    }

    #[test]
    fn persistence_failure_rolls_back_memory_and_preserves_the_capture() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let source = capture(&captures, FIRST_ID);
        fs::create_dir(&store).expect("block queue document with a directory");

        assert!(queue.enqueue(&source, QueueSource::Region, 0).is_err());
        assert_eq!(queue.summary().total, 0);
        assert!(source.exists());
        let leftovers = fs::read_dir(root.path())
            .expect("list app data")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .count();
        assert_eq!(
            leftovers, 0,
            "failed atomic writes must clean temporary files"
        );
    }

    #[test]
    fn directory_sync_failure_reports_uncertain_durability_but_keeps_commit_idempotent() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");
        let source = capture(&captures, FIRST_ID);
        let sync_called = std::cell::Cell::new(false);

        let result = queue.enqueue_with_sync(&source, QueueSource::Region, 0, |_| {
            sync_called.set(true);
            Err(std::io::Error::other("injected directory sync failure"))
        });
        assert!(result.is_err());
        assert!(sync_called.get());
        assert_eq!(
            queue.summary().total,
            1,
            "a visible rename must not be rolled back only in memory"
        );
        assert!(source.exists(), "queue failures must preserve local pixels");
        drop(queue);

        let mut restored = DurableUploadQueue::open(&store, &captures, 1).expect("restore commit");
        assert_eq!(restored.summary().total, 1);
        assert_eq!(
            restored
                .enqueue(&source, QueueSource::Region, 2)
                .expect("retry exact enqueue"),
            EnqueueOutcome::AlreadyPresent
        );
    }

    #[test]
    fn corrupt_queue_is_never_silently_replaced() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        fs::create_dir_all(&captures).expect("create captures directory");
        let corrupt = b"{not valid queue json";
        fs::write(&store, corrupt).expect("write corrupt queue");

        assert!(DurableUploadQueue::open(&store, &captures, 0).is_err());
        assert_eq!(
            fs::read(&store).expect("read preserved corrupt queue"),
            corrupt
        );
    }

    #[test]
    fn inconsistent_retry_state_is_rejected_without_overwriting_the_queue() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let source = capture(&captures, FIRST_ID);
        let inconsistent = serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "entries": [{
                "id": FIRST_ID,
                "filePath": source,
                "createdAtMs": 0,
                "source": "region",
                "status": "failed",
                "attempts": MAX_AUTOMATIC_ATTEMPTS,
                "nextAttemptAtMs": 123,
                "lastError": "invalid retry after exhaustion"
            }]
        }))
        .expect("encode inconsistent fixture");
        fs::write(&store, &inconsistent).expect("write inconsistent queue");

        assert!(DurableUploadQueue::open(&store, &captures, 0).is_err());
        assert_eq!(
            fs::read(&store).expect("read preserved queue"),
            inconsistent
        );
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_capture_paths_are_rejected_without_creating_queue_state() {
        let root = tempfile::tempdir().expect("temporary app data");
        let captures = root.path().join("captures");
        let store = root.path().join("upload-queue.json");
        let outside = root.path().join(format!("{FIRST_ID}.png"));
        fs::create_dir_all(&captures).expect("create capture directory");
        fs::write(&outside, b"outside").expect("write outside file");
        let symlink = captures.join(format!("{FIRST_ID}.png"));
        std::os::unix::fs::symlink(&outside, &symlink).expect("create symlink");
        let mut queue = DurableUploadQueue::open(&store, &captures, 0).expect("open queue");

        assert!(queue.enqueue(&outside, QueueSource::Region, 0).is_err());
        assert!(queue.enqueue(&symlink, QueueSource::Region, 0).is_err());
        assert_eq!(queue.summary().total, 0);
        assert!(!store.exists());
    }
}
