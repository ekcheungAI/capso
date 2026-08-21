use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

pub(crate) const MAX_SETTINGS_DOCUMENT_BYTES: usize = 256 * 1024;
const SETTINGS_FORMAT: &str = "capso-settings";
const SETTINGS_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableSettingsDocument {
    format: String,
    schema_version: u8,
    pub(crate) shortcuts: crate::shortcuts::ShortcutSettings,
    pub(crate) capture: crate::capture_hud::CaptureHudSettings,
    pub(crate) quick_access: crate::overlay::StoredOverlaySettings,
}

pub(crate) fn default_document() -> PortableSettingsDocument {
    PortableSettingsDocument {
        format: SETTINGS_FORMAT.into(),
        schema_version: SETTINGS_SCHEMA_VERSION,
        shortcuts: crate::shortcuts::ShortcutSettings::default(),
        capture: crate::capture_hud::CaptureHudSettings::default(),
        quick_access: crate::overlay::StoredOverlaySettings::default(),
    }
}

pub(crate) fn document(
    shortcuts: crate::shortcuts::ShortcutSettings,
    capture: crate::capture_hud::CaptureHudSettings,
    quick_access: crate::overlay::StoredOverlaySettings,
) -> PortableSettingsDocument {
    PortableSettingsDocument {
        format: SETTINGS_FORMAT.into(),
        schema_version: SETTINGS_SCHEMA_VERSION,
        shortcuts,
        capture,
        quick_access,
    }
}

fn exact_keys(map: &Map<String, Value>, allowed: &[&str], context: &str) -> Result<(), String> {
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!(
            "Capso settings contain an unknown {context} field: {key}"
        ));
    }
    if let Some(key) = allowed.iter().find(|key| !map.contains_key(**key)) {
        return Err(format!(
            "Capso settings are missing the {context} field: {key}"
        ));
    }
    Ok(())
}

fn object<'a>(value: &'a Value, context: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("Capso settings {context} must be an object."))
}

fn validate_json_shape(value: &Value) -> Result<(), String> {
    let root = object(value, "document")?;
    exact_keys(
        root,
        &[
            "format",
            "schemaVersion",
            "shortcuts",
            "capture",
            "quickAccess",
        ],
        "document",
    )?;
    exact_keys(
        object(&root["shortcuts"], "shortcuts")?,
        &["region", "window", "fullscreen"],
        "shortcut",
    )?;
    let capture = object(&root["capture"], "capture")?;
    if let Some(key) = capture.keys().find(|key| {
        ![
            "mode",
            "delaySeconds",
            "freezeScreen",
            "hideDesktopIcons",
            "windowShadow",
            "windowPadding",
            "windowBackground",
            "windowCustomBackground",
        ]
        .contains(&key.as_str())
    }) {
        return Err(format!(
            "Capso settings contain an unknown capture field: {key}"
        ));
    }
    for required in [
        "mode",
        "delaySeconds",
        "freezeScreen",
        "windowShadow",
        "windowPadding",
        "windowBackground",
        "windowCustomBackground",
    ] {
        if !capture.contains_key(required) {
            return Err(format!(
                "Capso settings are missing the capture field: {required}"
            ));
        }
    }
    let quick_access = object(&root["quickAccess"], "Quick Access")?;
    if let Some(key) = quick_access
        .keys()
        .find(|key| !["version", "saveAs", "profiles"].contains(&key.as_str()))
    {
        return Err(format!(
            "Capso settings contain an unknown Quick Access field: {key}"
        ));
    }
    for required in ["version", "profiles"] {
        if !quick_access.contains_key(required) {
            return Err(format!(
                "Capso settings are missing the Quick Access field: {required}"
            ));
        }
    }
    if let Some(save_as) = quick_access.get("saveAs") {
        let save_as = object(save_as, "Save preferences")?;
        if let Some(key) = save_as
            .keys()
            .find(|key| !["format", "filenameTemplate", "directory"].contains(&key.as_str()))
        {
            return Err(format!(
                "Capso settings contain an unknown Save preference field: {key}"
            ));
        }
        for required in ["format", "filenameTemplate"] {
            if !save_as.contains_key(required) {
                return Err(format!(
                    "Capso settings are missing the Save preference field: {required}"
                ));
            }
        }
    }
    let profiles = object(&quick_access["profiles"], "Quick Access profiles")?;
    for (display_id, preferences) in profiles {
        let preferences = object(preferences, "Quick Access profile")?;
        exact_keys(
            preferences,
            &["placement", "size", "autoDismiss", "quickActions"],
            "Quick Access profile",
        )?;
        exact_keys(
            object(&preferences["quickActions"], "Quick Access actions")?,
            &["pin", "annotate", "copy", "save"],
            "Quick Access actions",
        )
        .map_err(|error| format!("{error} ({display_id})"))?;
    }
    Ok(())
}

fn validate_document(document: &PortableSettingsDocument) -> Result<(), String> {
    if document.format != SETTINGS_FORMAT || document.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err("That file is not a supported Capso settings document.".into());
    }
    crate::shortcuts::validate_shortcut_settings(document.shortcuts.clone())?;
    crate::capture_hud::validate_settings(document.capture)?;
    crate::overlay::validate_stored_overlay_settings(&document.quick_access)?;
    Ok(())
}

pub(crate) fn decode_document(bytes: &[u8]) -> Result<PortableSettingsDocument, String> {
    if bytes.is_empty() || bytes.len() > MAX_SETTINGS_DOCUMENT_BYTES {
        return Err("Capso settings must be a non-empty JSON file no larger than 256 KiB.".into());
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Could not read Capso settings JSON: {error}"))?;
    validate_json_shape(&value)?;
    let document: PortableSettingsDocument = serde_json::from_value(value)
        .map_err(|error| format!("Could not decode Capso settings: {error}"))?;
    validate_document(&document)?;
    Ok(document)
}

pub(crate) fn encode_document(document: &PortableSettingsDocument) -> Result<Vec<u8>, String> {
    validate_document(document)?;
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("Could not encode Capso settings: {error}"))?;
    if bytes.len() > MAX_SETTINGS_DOCUMENT_BYTES {
        return Err("Capso settings exceed the 256 KiB export limit.".into());
    }
    Ok(bytes)
}

fn validate_json_path(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Capso settings need a readable local file name.".to_string())?;
    if name.is_empty() || name.len() > 255 || name.chars().any(char::is_control) {
        return Err("Capso settings have an unsafe file name.".into());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Capso settings must use the .json extension.".into());
    }
    Ok(())
}

pub(crate) fn read_document(path: &Path) -> Result<PortableSettingsDocument, String> {
    validate_json_path(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the selected settings file: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err("Choose a direct, non-empty local JSON file.".into());
    }
    if metadata.len() > MAX_SETTINGS_DOCUMENT_BYTES as u64 {
        return Err("Capso settings cannot exceed 256 KiB.".into());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Could not read the selected settings file: {error}"))?;
    decode_document(&bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not locate the settings file folder.".to_string())?;
    let parent_metadata = fs::metadata(parent)
        .map_err(|error| format!("Could not inspect the settings file folder: {error}"))?;
    if !parent_metadata.is_dir() {
        return Err("The settings destination folder is unavailable.".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("Capso will not replace a linked or non-file settings destination.".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not inspect the settings destination: {error}"
            ))
        }
    }

    let temporary = parent.join(format!(".capso-settings-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("Could not create the temporary settings file: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not durably write Capso settings: {error}"))?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not activate Capso settings: {error}"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync the Capso settings folder: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn write_document(
    path: &Path,
    document: &PortableSettingsDocument,
) -> Result<(), String> {
    validate_json_path(path)?;
    atomic_write(path, &encode_document(document)?)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FileSnapshot {
    Missing,
    Present(Vec<u8>),
}

pub(crate) fn snapshot_file(path: &Path, max_bytes: usize) -> Result<FileSnapshot, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileSnapshot::Missing)
        }
        Err(error) => {
            return Err(format!(
                "Could not inspect existing Capso settings: {error}"
            ))
        }
    };
    if !metadata.file_type().is_file() || metadata.len() > max_bytes as u64 {
        return Err("Existing Capso settings are not a safe bounded direct file.".into());
    }
    fs::read(path)
        .map(FileSnapshot::Present)
        .map_err(|error| format!("Could not preserve existing Capso settings: {error}"))
}

pub(crate) fn restore_file_snapshot(path: &Path, snapshot: &FileSnapshot) -> Result<(), String> {
    match snapshot {
        FileSnapshot::Present(bytes) => atomic_write(path, bytes),
        FileSnapshot::Missing => match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(path)
                .map_err(|error| format!("Could not remove a partial settings file: {error}")),
            Ok(_) => Err("A partial settings path changed into an unsafe file type.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Could not inspect a partial settings file: {error}"
            )),
        },
    }
}

#[derive(Default)]
pub(crate) struct SettingsTransferRuntime {
    busy: bool,
}

impl SettingsTransferRuntime {
    pub(crate) fn begin(&mut self) -> Result<(), String> {
        if self.busy {
            return Err("Another settings import or export is already open.".into());
        }
        self.busy = true;
        Ok(())
    }

    pub(crate) fn finish(&mut self) {
        self.busy = false;
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SettingsPaths {
    pub(crate) shortcuts: std::path::PathBuf,
    pub(crate) capture: std::path::PathBuf,
    pub(crate) quick_access: std::path::PathBuf,
}

fn rollback_files(snapshots: &[(&Path, FileSnapshot)]) -> Result<(), String> {
    let errors = snapshots
        .iter()
        .rev()
        .filter_map(|(path, snapshot)| restore_file_snapshot(path, snapshot).err())
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub(crate) fn apply_document_files<F>(
    paths: &SettingsPaths,
    document: &PortableSettingsDocument,
    activate: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    validate_document(document)?;
    let shortcut_bytes = serde_json::to_vec_pretty(&document.shortcuts)
        .map_err(|error| format!("Could not encode shortcut settings: {error}"))?;
    let capture_bytes = serde_json::to_vec_pretty(&document.capture)
        .map_err(|error| format!("Could not encode capture settings: {error}"))?;
    let quick_access_bytes = serde_json::to_vec(&document.quick_access)
        .map_err(|error| format!("Could not encode Quick Access settings: {error}"))?;
    let snapshots = [
        (
            paths.shortcuts.as_path(),
            snapshot_file(&paths.shortcuts, MAX_SETTINGS_DOCUMENT_BYTES)?,
        ),
        (
            paths.capture.as_path(),
            snapshot_file(&paths.capture, MAX_SETTINGS_DOCUMENT_BYTES)?,
        ),
        (
            paths.quick_access.as_path(),
            snapshot_file(&paths.quick_access, MAX_SETTINGS_DOCUMENT_BYTES)?,
        ),
    ];

    let result = atomic_write(&paths.capture, &capture_bytes)
        .and_then(|_| atomic_write(&paths.quick_access, &quick_access_bytes))
        .and_then(|_| atomic_write(&paths.shortcuts, &shortcut_bytes))
        .and_then(|_| activate());
    if let Err(error) = result {
        return match rollback_files(&snapshots) {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!(
                "{error}. Settings rollback needs attention: {rollback_error}"
            )),
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_document_files, decode_document, default_document, encode_document, read_document,
        restore_file_snapshot, snapshot_file, write_document, FileSnapshot, SettingsPaths,
        SettingsTransferRuntime, MAX_SETTINGS_DOCUMENT_BYTES,
    };

    #[test]
    fn portable_document_round_trips_only_explicit_non_secret_preferences() {
        let document = default_document();
        let encoded = encode_document(&document).expect("defaults should encode");
        let decoded = decode_document(&encoded).expect("encoded defaults should decode");

        assert_eq!(decoded, document);
        let json = String::from_utf8(encoded).expect("settings JSON should be UTF-8");
        assert!(json.contains("\"format\": \"capso-settings\""));
        assert!(json.contains("\"schemaVersion\": 1"));
        for forbidden in [
            "accessToken",
            "refreshToken",
            "email",
            "userId",
            "deviceId",
            "captureId",
            "previousArea",
            "queue",
            "project",
        ] {
            assert!(
                !json.contains(forbidden),
                "portable JSON leaked {forbidden}"
            );
        }
    }

    #[test]
    fn import_rejects_unknown_fields_bad_versions_and_unbounded_documents() {
        let valid = encode_document(&default_document()).expect("defaults should encode");
        let with_unknown = String::from_utf8(valid.clone())
            .expect("settings JSON should be UTF-8")
            .replacen("{", "{\n  \"accessToken\": \"secret\",", 1);
        assert!(decode_document(with_unknown.as_bytes()).is_err());

        let bad_version = String::from_utf8(valid)
            .expect("settings JSON should be UTF-8")
            .replace("\"schemaVersion\": 1", "\"schemaVersion\": 99");
        assert!(decode_document(bad_version.as_bytes()).is_err());
        assert!(decode_document(&vec![b' '; MAX_SETTINGS_DOCUMENT_BYTES + 1]).is_err());
    }

    #[test]
    fn every_nested_preference_is_validated_before_import() {
        let valid = String::from_utf8(
            encode_document(&default_document()).expect("defaults should encode"),
        )
        .expect("settings JSON should be UTF-8");

        assert!(decode_document(
            valid
                .replace("Control+Shift+W", "Control+Shift+F")
                .as_bytes()
        )
        .is_err());
        assert!(decode_document(
            valid
                .replace("\"delaySeconds\": 0", "\"delaySeconds\": 30")
                .as_bytes()
        )
        .is_err());
        assert!(decode_document(
            valid
                .replace("Capso {date} at {time}", "../escape {date}")
                .as_bytes()
        )
        .is_err());

        let mut legacy: serde_json::Value =
            serde_json::from_str(&valid).expect("portable JSON should parse");
        legacy["quickAccess"]
            .as_object_mut()
            .expect("Quick Access object")
            .remove("saveAs");
        legacy["capture"]
            .as_object_mut()
            .expect("capture object")
            .remove("hideDesktopIcons");
        let decoded = decode_document(
            &serde_json::to_vec(&legacy).expect("legacy portable JSON should encode"),
        )
        .expect("schema v1 exports from before Save As defaults remain importable");
        assert_eq!(
            decoded.quick_access.save_as,
            crate::overlay::OverlaySaveAsPreferences::default()
        );
        assert!(!decoded.capture.hide_desktop_icons);
    }

    #[test]
    fn picker_files_are_direct_bounded_json_and_exports_are_atomic() {
        let root = tempfile::tempdir().expect("temporary settings directory");
        let path = root.path().join("Capso Settings.json");
        write_document(&path, &default_document()).expect("settings should export");
        assert_eq!(
            read_document(&path).expect("settings should import"),
            default_document()
        );
        assert!(root
            .path()
            .read_dir()
            .expect("directory should be readable")
            .all(|entry| !entry
                .expect("entry should be readable")
                .file_name()
                .to_string_lossy()
                .contains(".tmp")));

        assert!(write_document(&root.path().join("settings.txt"), &default_document()).is_err());
        std::fs::write(
            root.path().join("too-large.json"),
            vec![b' '; MAX_SETTINGS_DOCUMENT_BYTES + 1],
        )
        .expect("large fixture should write");
        assert!(read_document(&root.path().join("too-large.json")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn import_rejects_a_symlink_even_when_its_target_is_valid() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("temporary settings directory");
        let source = root.path().join("source.json");
        write_document(&source, &default_document()).expect("settings should export");
        let link = root.path().join("linked.json");
        symlink(&source, &link).expect("fixture symlink should be created");

        assert!(read_document(&link).is_err());
        assert!(write_document(&link, &default_document()).is_err());
    }

    #[test]
    fn rollback_restores_exact_old_bytes_and_removes_only_new_files() {
        let root = tempfile::tempdir().expect("temporary settings directory");
        let existing = root.path().join("existing.json");
        let newly_created = root.path().join("new.json");
        std::fs::write(&existing, b"old exact bytes").expect("old fixture should write");

        let old = snapshot_file(&existing, 1024).expect("old file should snapshot");
        let missing = snapshot_file(&newly_created, 1024).expect("missing file should snapshot");
        assert!(matches!(missing, FileSnapshot::Missing));
        std::fs::write(&existing, b"replacement").expect("replacement should write");
        std::fs::write(&newly_created, b"created during import").expect("new file should write");

        restore_file_snapshot(&existing, &old).expect("old file should restore");
        restore_file_snapshot(&newly_created, &missing).expect("new file should be removed");
        assert_eq!(
            std::fs::read(existing).expect("restored bytes should read"),
            b"old exact bytes"
        );
        assert!(!newly_created.exists());
    }

    #[test]
    fn settings_transfer_is_single_flight() {
        let mut runtime = SettingsTransferRuntime::default();
        assert!(runtime.begin().is_ok());
        assert!(runtime.begin().is_err());
        runtime.finish();
        assert!(runtime.begin().is_ok());
    }

    #[test]
    fn failed_live_activation_rolls_back_all_three_settings_files_exactly() {
        let root = tempfile::tempdir().expect("temporary settings directory");
        let paths = SettingsPaths {
            shortcuts: root.path().join("shortcut-settings.json"),
            capture: root.path().join("capture-hud-settings.json"),
            quick_access: root.path().join("overlay-settings.json"),
        };
        std::fs::write(&paths.shortcuts, b"old shortcuts").expect("shortcut fixture should write");
        std::fs::write(&paths.capture, b"old capture").expect("capture fixture should write");
        std::fs::write(&paths.quick_access, b"old overlay").expect("overlay fixture should write");

        let error = apply_document_files(&paths, &default_document(), || {
            Err("shortcut unavailable".to_string())
        })
        .expect_err("activation should fail");

        assert!(error.contains("shortcut unavailable"));
        assert_eq!(std::fs::read(paths.shortcuts).unwrap(), b"old shortcuts");
        assert_eq!(std::fs::read(paths.capture).unwrap(), b"old capture");
        assert_eq!(std::fs::read(paths.quick_access).unwrap(), b"old overlay");
    }

    #[test]
    fn successful_activation_writes_three_independently_readable_current_files() {
        let root = tempfile::tempdir().expect("temporary settings directory");
        let paths = SettingsPaths {
            shortcuts: root.path().join("shortcut-settings.json"),
            capture: root.path().join("capture-hud-settings.json"),
            quick_access: root.path().join("overlay-settings.json"),
        };
        let mut activations = 0;

        apply_document_files(&paths, &default_document(), || {
            activations += 1;
            Ok(())
        })
        .expect("valid defaults should activate");

        assert_eq!(activations, 1);
        assert_eq!(
            crate::shortcuts::load_shortcut_settings(&paths.shortcuts).settings,
            crate::shortcuts::ShortcutSettings::default(),
        );
        assert_eq!(
            crate::capture_hud::load_settings(root.path()).settings,
            crate::capture_hud::CaptureHudSettings::default(),
        );
        let quick_access: crate::overlay::StoredOverlaySettings = serde_json::from_slice(
            &std::fs::read(paths.quick_access).expect("Quick Access settings should read"),
        )
        .expect("Quick Access settings should decode");
        crate::overlay::validate_stored_overlay_settings(&quick_access)
            .expect("Quick Access settings should validate");
    }
}
