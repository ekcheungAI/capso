use crate::capture::CaptureMode;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::Path};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CaptureAction {
    Region,
    Window,
    Fullscreen,
}

impl CaptureAction {
    pub(crate) fn mode(self) -> CaptureMode {
        match self {
            Self::Region => CaptureMode::Region,
            Self::Window => CaptureMode::Window,
            Self::Fullscreen => CaptureMode::Fullscreen,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Region => "Region",
            Self::Window => "Window",
            Self::Fullscreen => "Fullscreen",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct CaptureShortcut {
    pub(crate) action: CaptureAction,
    pub(crate) menu_id: &'static str,
    pub(crate) menu_label: &'static str,
}

const CAPTURE_SHORTCUTS: [CaptureShortcut; 3] = [
    CaptureShortcut {
        action: CaptureAction::Region,
        menu_id: "capture-region",
        menu_label: "Capture Region",
    },
    CaptureShortcut {
        action: CaptureAction::Window,
        menu_id: "capture-window",
        menu_label: "Capture Window",
    },
    CaptureShortcut {
        action: CaptureAction::Fullscreen,
        menu_id: "capture-fullscreen",
        menu_label: "Capture Fullscreen",
    },
];

pub(crate) const CAPTURE_REGION_TIMER_MENU_ID: &str = "capture-region-timer";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutSettings {
    pub(crate) region: String,
    pub(crate) window: String,
    pub(crate) fullscreen: String,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            region: "Control+Shift+C".into(),
            window: "Control+Shift+W".into(),
            fullscreen: "Control+Shift+F".into(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CaptureBinding {
    pub(crate) action: CaptureAction,
    pub(crate) shortcut: Shortcut,
    pub(crate) display: String,
}

#[derive(Debug)]
pub(crate) struct ValidatedShortcutSettings {
    pub(crate) settings: ShortcutSettings,
    pub(crate) bindings: Vec<CaptureBinding>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutConflict {
    pub(crate) action: CaptureAction,
    pub(crate) display: String,
    pub(crate) error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutStatus {
    pub(crate) settings: ShortcutSettings,
    pub(crate) conflicts: Vec<ShortcutConflict>,
    pub(crate) storage_warning: Option<String>,
}

#[derive(Debug)]
pub(crate) struct LoadedShortcutSettings {
    pub(crate) settings: ShortcutSettings,
    pub(crate) warning: Option<String>,
}

#[derive(Debug)]
pub(crate) struct RegistrationOutcome {
    pub(crate) active: Vec<CaptureBinding>,
    pub(crate) conflicts: Vec<ShortcutConflict>,
}

#[derive(Debug)]
pub(crate) struct ShortcutUpdateFailure {
    pub(crate) message: String,
    pub(crate) active_bindings: Vec<CaptureBinding>,
    pub(crate) rollback_complete: bool,
}

#[derive(Debug)]
pub(crate) struct ShortcutRuntime {
    pub(crate) settings: ShortcutSettings,
    pub(crate) bindings: Vec<CaptureBinding>,
    pub(crate) active_bindings: Vec<CaptureBinding>,
    pub(crate) conflicts: Vec<ShortcutConflict>,
    pub(crate) storage_warning: Option<String>,
}

impl Default for ShortcutRuntime {
    fn default() -> Self {
        let validated = validate_shortcut_settings(ShortcutSettings::default())
            .expect("built-in shortcuts must remain valid");
        Self {
            settings: validated.settings,
            bindings: validated.bindings,
            active_bindings: Vec::new(),
            conflicts: Vec::new(),
            storage_warning: None,
        }
    }
}

impl ShortcutRuntime {
    pub(crate) fn status(&self) -> ShortcutStatus {
        ShortcutStatus {
            settings: self.settings.clone(),
            conflicts: self.conflicts.clone(),
            storage_warning: self.storage_warning.clone(),
        }
    }

    pub(crate) fn action_for_event(
        &self,
        shortcut: &Shortcut,
        state: ShortcutState,
    ) -> Option<CaptureAction> {
        action_for_event(shortcut, state, &self.bindings)
    }

    pub(crate) fn replace_with(&mut self, validated: ValidatedShortcutSettings) {
        self.settings = validated.settings;
        self.active_bindings = validated.bindings.clone();
        self.bindings = validated.bindings;
        self.conflicts.clear();
        self.storage_warning = None;
    }

    pub(crate) fn desired_active_bindings(&self) -> Vec<CaptureBinding> {
        let active_ids = self
            .active_bindings
            .iter()
            .map(|binding| binding.shortcut.id())
            .collect::<HashSet<_>>();
        self.bindings
            .iter()
            .filter(|binding| active_ids.contains(&binding.shortcut.id()))
            .cloned()
            .collect()
    }

    pub(crate) fn reconcile_failed_update(&mut self, failure: &ShortcutUpdateFailure) {
        self.active_bindings = failure.active_bindings.clone();
        if failure.rollback_complete {
            return;
        }

        let active_ids = self
            .active_bindings
            .iter()
            .map(|binding| binding.shortcut.id())
            .collect::<HashSet<_>>();
        self.conflicts = self
            .bindings
            .iter()
            .filter(|binding| !active_ids.contains(&binding.shortcut.id()))
            .map(|binding| ShortcutConflict {
                action: binding.action,
                display: binding.display.clone(),
                error: "not active after a failed shortcut update".into(),
            })
            .collect();
        self.storage_warning = Some(
            "Shortcut rollback is incomplete. Tray capture remains available; retry or restart Capso."
                .into(),
        );
    }
}

pub(crate) trait ShortcutRegistry {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn is_registered(&self, shortcut: Shortcut) -> bool;
}

pub(crate) fn definitions() -> &'static [CaptureShortcut; 3] {
    &CAPTURE_SHORTCUTS
}

pub(crate) fn validate_shortcut_settings(
    settings: ShortcutSettings,
) -> Result<ValidatedShortcutSettings, String> {
    let normalized = ShortcutSettings {
        region: settings.region.trim().to_string(),
        window: settings.window.trim().to_string(),
        fullscreen: settings.fullscreen.trim().to_string(),
    };
    let values = [
        (CaptureAction::Region, normalized.region.as_str()),
        (CaptureAction::Window, normalized.window.as_str()),
        (CaptureAction::Fullscreen, normalized.fullscreen.as_str()),
    ];
    let mut ids = HashSet::new();
    let mut bindings = Vec::with_capacity(values.len());

    for (action, display) in values {
        if display.is_empty() {
            return Err(format!("{} shortcut cannot be empty", action.label()));
        }
        let shortcut = display
            .parse::<Shortcut>()
            .map_err(|error| format!("{} shortcut is invalid: {error}", action.label()))?;
        if shortcut.mods.is_empty() {
            return Err(format!(
                "{} shortcut needs at least one modifier",
                action.label()
            ));
        }
        if !ids.insert(shortcut.id()) {
            return Err("Capture shortcuts must be unique".into());
        }
        bindings.push(CaptureBinding {
            action,
            shortcut,
            display: display.to_string(),
        });
    }

    Ok(ValidatedShortcutSettings {
        settings: normalized,
        bindings,
    })
}

pub(crate) fn register_capture_shortcuts<F>(
    bindings: &[CaptureBinding],
    mut register: F,
) -> RegistrationOutcome
where
    F: FnMut(Shortcut) -> Result<(), String>,
{
    let mut active = Vec::new();
    let mut conflicts = Vec::new();

    for binding in bindings {
        match register(binding.shortcut) {
            Ok(()) => active.push(binding.clone()),
            Err(error) => conflicts.push(ShortcutConflict {
                action: binding.action,
                display: binding.display.clone(),
                error,
            }),
        }
    }

    RegistrationOutcome { active, conflicts }
}

pub(crate) fn action_for_event(
    shortcut: &Shortcut,
    state: ShortcutState,
    bindings: &[CaptureBinding],
) -> Option<CaptureAction> {
    if state != ShortcutState::Pressed {
        return None;
    }

    bindings
        .iter()
        .find(|binding| binding.shortcut.id() == shortcut.id())
        .map(|binding| binding.action)
}

pub(crate) fn action_for_menu_id(id: &str) -> Option<CaptureAction> {
    if id == CAPTURE_REGION_TIMER_MENU_ID {
        return Some(CaptureAction::Region);
    }
    definitions()
        .iter()
        .find(|definition| definition.menu_id == id)
        .map(|definition| definition.action)
}

pub(crate) fn conflict_label(conflicts: &[ShortcutConflict]) -> Option<String> {
    if conflicts.is_empty() {
        return None;
    }

    Some(format!(
        "Shortcut unavailable: {} — use Capture menu actions",
        conflicts
            .iter()
            .map(|conflict| format!("{} ({})", conflict.display, conflict.error))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub(crate) fn load_shortcut_settings(path: &Path) -> LoadedShortcutSettings {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LoadedShortcutSettings {
                settings: ShortcutSettings::default(),
                warning: None,
            };
        }
        Err(error) => {
            return LoadedShortcutSettings {
                settings: ShortcutSettings::default(),
                warning: Some(format!(
                    "Could not read shortcut settings; defaults are active: {error}"
                )),
            };
        }
    };

    let parsed = serde_json::from_str::<ShortcutSettings>(&contents)
        .map_err(|error| format!("Shortcut settings JSON is invalid: {error}"))
        .and_then(validate_shortcut_settings);

    match parsed {
        Ok(validated) => LoadedShortcutSettings {
            settings: validated.settings,
            warning: None,
        },
        Err(error) => LoadedShortcutSettings {
            settings: ShortcutSettings::default(),
            warning: Some(format!(
                "Saved shortcut settings were ignored; defaults are active: {error}"
            )),
        },
    }
}

pub(crate) fn save_shortcut_settings(
    path: &Path,
    settings: &ShortcutSettings,
) -> Result<(), String> {
    let validated = validate_shortcut_settings(settings.clone())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Shortcut settings path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create shortcut settings directory: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&validated.settings)
        .map_err(|error| format!("Could not encode shortcut settings: {error}"))?;
    fs::write(&temporary_path, bytes)
        .map_err(|error| format!("Could not write shortcut settings: {error}"))?;
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("Could not activate shortcut settings: {error}"));
    }
    Ok(())
}

pub(crate) fn replace_registered_shortcuts<R, P>(
    registry: &mut R,
    registered_before: &[CaptureBinding],
    restore_on_failure: &[CaptureBinding],
    candidate: &[CaptureBinding],
    persist: P,
) -> Result<(), ShortcutUpdateFailure>
where
    R: ShortcutRegistry,
    P: FnOnce() -> Result<(), String>,
{
    for binding in registered_before {
        if let Err(error) = registry.unregister(binding.shortcut) {
            let rollback_errors = restore_bindings(registry, restore_on_failure);
            return Err(reconciled_failure(
                registry,
                format!(
                    "Could not release the current {} shortcut: {error}",
                    binding.action.label()
                ),
                rollback_errors,
                registered_before,
                restore_on_failure,
                candidate,
            ));
        }
    }

    let mut registered_candidate = Vec::new();
    for binding in candidate {
        if let Err(error) = registry.register(binding.shortcut) {
            let rollback_errors =
                rollback_candidate(registry, &registered_candidate, restore_on_failure);
            return Err(reconciled_failure(
                registry,
                format!(
                    "{} shortcut {} is unavailable: {error}",
                    binding.action.label(),
                    binding.display
                ),
                rollback_errors,
                registered_before,
                restore_on_failure,
                candidate,
            ));
        }
        registered_candidate.push(binding.clone());
    }

    if let Err(error) = persist() {
        let rollback_errors =
            rollback_candidate(registry, &registered_candidate, restore_on_failure);
        return Err(reconciled_failure(
            registry,
            error,
            rollback_errors,
            registered_before,
            restore_on_failure,
            candidate,
        ));
    }

    Ok(())
}

fn restore_bindings<R: ShortcutRegistry>(
    registry: &mut R,
    bindings: &[CaptureBinding],
) -> Vec<String> {
    bindings
        .iter()
        .filter_map(|binding| {
            if registry.is_registered(binding.shortcut) {
                return None;
            }
            registry
                .register(binding.shortcut)
                .err()
                .map(|error| format!("could not restore {}: {error}", binding.action.label()))
        })
        .collect()
}

fn rollback_candidate<R: ShortcutRegistry>(
    registry: &mut R,
    candidate: &[CaptureBinding],
    previous: &[CaptureBinding],
) -> Vec<String> {
    let mut errors = candidate
        .iter()
        .rev()
        .filter_map(|binding| {
            registry.unregister(binding.shortcut).err().map(|error| {
                format!(
                    "could not remove candidate {}: {error}",
                    binding.action.label()
                )
            })
        })
        .collect::<Vec<_>>();
    errors.extend(restore_bindings(registry, previous));
    errors
}

fn reconciled_failure<R: ShortcutRegistry>(
    registry: &R,
    message: String,
    rollback_errors: Vec<String>,
    registered_before: &[CaptureBinding],
    restore_on_failure: &[CaptureBinding],
    candidate: &[CaptureBinding],
) -> ShortcutUpdateFailure {
    let mut seen = HashSet::new();
    let active_bindings = restore_on_failure
        .iter()
        .chain(registered_before)
        .chain(candidate)
        .filter(|binding| {
            seen.insert(binding.shortcut.id()) && registry.is_registered(binding.shortcut)
        })
        .cloned()
        .collect::<Vec<_>>();
    let expected_ids = restore_on_failure
        .iter()
        .map(|binding| binding.shortcut.id())
        .collect::<HashSet<_>>();
    let active_ids = active_bindings
        .iter()
        .map(|binding| binding.shortcut.id())
        .collect::<HashSet<_>>();
    let rollback_complete = active_ids == expected_ids;
    let message = if rollback_complete {
        format!("{message}. Previous shortcuts remain active")
    } else if rollback_errors.is_empty() {
        format!(
            "{message}. Shortcut rollback needs attention: the active shortcut set did not reconcile"
        )
    } else {
        format!(
            "{message}. Shortcut rollback needs attention: {}",
            rollback_errors.join("; ")
        )
    };

    ShortcutUpdateFailure {
        message,
        active_bindings,
        rollback_complete,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        action_for_event, action_for_menu_id, conflict_label, definitions, load_shortcut_settings,
        register_capture_shortcuts, replace_registered_shortcuts, save_shortcut_settings,
        validate_shortcut_settings, CaptureAction, ShortcutRegistry, ShortcutRuntime,
        ShortcutSettings,
    };
    use std::{
        cell::RefCell,
        collections::{HashMap, HashSet},
        rc::Rc,
    };
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    #[test]
    fn defaults_are_unique_and_match_the_capture_contract() {
        let definitions = definitions();
        let ids = definitions
            .iter()
            .map(|definition| definition.menu_id)
            .collect::<HashSet<_>>();
        let defaults = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let shortcut_ids = defaults
            .bindings
            .iter()
            .map(|binding| binding.shortcut.id())
            .collect::<HashSet<_>>();

        assert_eq!(definitions.len(), 3);
        assert_eq!(ids.len(), definitions.len());
        assert_eq!(shortcut_ids.len(), definitions.len());
        assert_eq!(defaults.settings.region, "Control+Shift+C");
        assert_eq!(defaults.settings.window, "Control+Shift+W");
        assert_eq!(defaults.settings.fullscreen, "Control+Shift+F");
    }

    #[test]
    fn one_conflict_does_not_prevent_other_shortcuts_registering() {
        let bindings = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let mut attempted = Vec::new();
        let outcome = register_capture_shortcuts(&bindings.bindings, |shortcut| {
            attempted.push(shortcut.id());
            if shortcut.id() == bindings.bindings[1].shortcut.id() {
                Err("already registered".into())
            } else {
                Ok(())
            }
        });

        assert_eq!(attempted.len(), 3);
        assert_eq!(outcome.active.len(), 2);
        assert_eq!(outcome.conflicts.len(), 1);
        assert_eq!(outcome.conflicts[0].action, CaptureAction::Window);
        assert_eq!(outcome.conflicts[0].display, "Control+Shift+W");
        assert_eq!(outcome.conflicts[0].error, "already registered");
        assert_eq!(
            conflict_label(&outcome.conflicts).as_deref(),
            Some(
                "Shortcut unavailable: Control+Shift+W (already registered) — use Capture menu actions"
            )
        );
    }

    #[test]
    fn only_known_pressed_shortcuts_launch_capture_actions() {
        let bindings = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let control_shift = Modifiers::CONTROL | Modifiers::SHIFT;
        let region = Shortcut::new(Some(control_shift), Code::KeyC);
        let unrelated = Shortcut::new(Some(control_shift), Code::KeyP);

        assert_eq!(
            action_for_event(&region, ShortcutState::Pressed, &bindings.bindings),
            Some(CaptureAction::Region)
        );
        assert_eq!(
            action_for_event(&region, ShortcutState::Released, &bindings.bindings),
            None
        );
        assert_eq!(
            action_for_event(&unrelated, ShortcutState::Pressed, &bindings.bindings),
            None
        );
    }

    #[test]
    fn tray_actions_match_the_shortcut_modes() {
        assert_eq!(
            action_for_menu_id("capture-region"),
            Some(CaptureAction::Region)
        );
        assert_eq!(
            action_for_menu_id("capture-window"),
            Some(CaptureAction::Window)
        );
        assert_eq!(
            action_for_menu_id("capture-fullscreen"),
            Some(CaptureAction::Fullscreen)
        );
        assert_eq!(
            action_for_menu_id("capture-region-timer"),
            Some(CaptureAction::Region)
        );
        assert_eq!(action_for_menu_id("quit"), None);
    }

    #[test]
    fn persisted_bindings_validate_and_drive_event_mapping() {
        let settings = ShortcutSettings {
            region: "Command+Shift+KeyR".into(),
            window: "Command+Shift+KeyW".into(),
            fullscreen: "Command+Shift+KeyF".into(),
        };
        let bindings = validate_shortcut_settings(settings.clone()).unwrap();
        let region: Shortcut = "Command+Shift+KeyR".parse().unwrap();

        assert_eq!(bindings.settings, settings);
        assert_eq!(
            action_for_event(&region, ShortcutState::Pressed, &bindings.bindings),
            Some(CaptureAction::Region)
        );
    }

    #[test]
    fn duplicate_and_modifier_free_bindings_are_rejected() {
        let duplicate = ShortcutSettings {
            region: "Control+Shift+C".into(),
            window: "Control+Shift+C".into(),
            ..ShortcutSettings::default()
        };
        let modifier_free = ShortcutSettings {
            region: "C".into(),
            ..ShortcutSettings::default()
        };

        assert!(validate_shortcut_settings(duplicate)
            .unwrap_err()
            .contains("unique"));
        assert!(validate_shortcut_settings(modifier_free)
            .unwrap_err()
            .contains("modifier"));
    }

    #[test]
    fn invalid_persisted_json_falls_back_without_overwriting_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shortcut-settings.json");
        std::fs::write(&path, b"not json").unwrap();

        let loaded = load_shortcut_settings(&path);

        assert_eq!(loaded.settings, ShortcutSettings::default());
        assert!(loaded.warning.unwrap().contains("ignored"));
        assert_eq!(std::fs::read(&path).unwrap(), b"not json");
    }

    #[test]
    fn settings_round_trip_through_atomic_json_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shortcut-settings.json");
        let settings = ShortcutSettings {
            region: "Command+Shift+R".into(),
            window: "Command+Shift+W".into(),
            fullscreen: "Command+Shift+F".into(),
        };

        save_shortcut_settings(&path, &settings).unwrap();
        let loaded = load_shortcut_settings(&path);

        assert_eq!(loaded.settings, settings);
        assert_eq!(loaded.warning, None);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[derive(Default)]
    struct FakeRegistry {
        registered: HashSet<u32>,
        register_failures: HashMap<u32, String>,
        unregister_failures: HashMap<u32, String>,
        events: Rc<RefCell<Vec<String>>>,
    }

    impl ShortcutRegistry for FakeRegistry {
        fn register(&mut self, shortcut: Shortcut) -> Result<(), String> {
            self.events
                .borrow_mut()
                .push(format!("register:{}", shortcut.id()));
            if let Some(error) = self.register_failures.get(&shortcut.id()) {
                return Err(error.clone());
            }
            self.registered.insert(shortcut.id());
            Ok(())
        }

        fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
            self.events
                .borrow_mut()
                .push(format!("unregister:{}", shortcut.id()));
            if let Some(error) = self.unregister_failures.get(&shortcut.id()) {
                return Err(error.clone());
            }
            self.registered.remove(&shortcut.id());
            Ok(())
        }

        fn is_registered(&self, shortcut: Shortcut) -> bool {
            self.registered.contains(&shortcut.id())
        }
    }

    #[test]
    fn conflicting_rebind_rolls_back_every_previous_shortcut() {
        let previous = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let candidate = validate_shortcut_settings(ShortcutSettings {
            region: "Command+Shift+R".into(),
            window: "Command+Shift+W".into(),
            fullscreen: "Command+Shift+F".into(),
        })
        .unwrap();
        let mut registry = FakeRegistry::default();
        for binding in &previous.bindings {
            registry.registered.insert(binding.shortcut.id());
        }
        registry.register_failures.insert(
            candidate.bindings[1].shortcut.id(),
            "owned by another app".into(),
        );
        let mut persisted = false;

        let error = replace_registered_shortcuts(
            &mut registry,
            &previous.bindings,
            &previous.bindings,
            &candidate.bindings,
            || {
                persisted = true;
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.message.contains("owned by another app"));
        assert!(error.rollback_complete);
        assert!(!persisted);
        assert_eq!(
            registry.registered,
            previous
                .bindings
                .iter()
                .map(|binding| binding.shortcut.id())
                .collect()
        );
    }

    #[test]
    fn persistence_failure_rolls_back_every_previous_shortcut() {
        let previous = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let candidate = validate_shortcut_settings(ShortcutSettings {
            region: "Command+Shift+R".into(),
            window: "Command+Shift+W".into(),
            fullscreen: "Command+Shift+F".into(),
        })
        .unwrap();
        let mut registry = FakeRegistry::default();
        for binding in &previous.bindings {
            registry.registered.insert(binding.shortcut.id());
        }

        let error = replace_registered_shortcuts(
            &mut registry,
            &previous.bindings,
            &previous.bindings,
            &candidate.bindings,
            || Err("disk is full".into()),
        )
        .unwrap_err();

        assert!(error.message.contains("disk is full"));
        assert!(error.rollback_complete);
        assert_eq!(
            registry.registered,
            previous
                .bindings
                .iter()
                .map(|binding| binding.shortcut.id())
                .collect()
        );
    }

    #[test]
    fn successful_rebind_persists_after_new_shortcuts_are_live() {
        let previous = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let candidate = validate_shortcut_settings(ShortcutSettings {
            region: "Command+Shift+R".into(),
            window: "Command+Shift+W".into(),
            fullscreen: "Command+Shift+F".into(),
        })
        .unwrap();
        let mut registry = FakeRegistry::default();
        let events = registry.events.clone();
        for binding in &previous.bindings {
            registry.registered.insert(binding.shortcut.id());
        }
        let expected_ids = candidate
            .bindings
            .iter()
            .map(|binding| binding.shortcut.id())
            .collect::<HashSet<_>>();

        replace_registered_shortcuts(
            &mut registry,
            &previous.bindings,
            &previous.bindings,
            &candidate.bindings,
            || {
                events.borrow_mut().push("persist".into());
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(registry.registered, expected_ids);
        assert_eq!(events.borrow().last().map(String::as_str), Some("persist"));
    }

    #[test]
    fn failed_candidate_cleanup_reports_the_extra_live_registration() {
        let previous = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let candidate = validate_shortcut_settings(ShortcutSettings {
            region: "Command+Shift+R".into(),
            window: "Command+Shift+W".into(),
            fullscreen: "Command+Shift+F".into(),
        })
        .unwrap();
        let mut registry = FakeRegistry::default();
        for binding in &previous.bindings {
            registry.registered.insert(binding.shortcut.id());
        }
        registry.register_failures.insert(
            candidate.bindings[1].shortcut.id(),
            "owned by another app".into(),
        );
        registry.unregister_failures.insert(
            candidate.bindings[0].shortcut.id(),
            "OS refused candidate cleanup".into(),
        );

        let error = replace_registered_shortcuts(
            &mut registry,
            &previous.bindings,
            &previous.bindings,
            &candidate.bindings,
            || Ok(()),
        )
        .unwrap_err();

        assert!(!error.rollback_complete);
        assert!(error.message.contains("rollback needs attention"));
        assert!(error
            .active_bindings
            .iter()
            .any(|binding| binding.shortcut.id() == candidate.bindings[0].shortcut.id()));
        assert_eq!(error.active_bindings.len(), previous.bindings.len() + 1);

        let mut runtime = ShortcutRuntime {
            settings: previous.settings,
            bindings: previous.bindings.clone(),
            active_bindings: previous.bindings,
            conflicts: Vec::new(),
            storage_warning: None,
        };
        runtime.reconcile_failed_update(&error);
        assert_eq!(runtime.active_bindings.len(), 4);
        assert!(runtime.conflicts.is_empty());
        assert!(runtime.storage_warning.unwrap().contains("incomplete"));
    }

    #[test]
    fn failed_previous_restore_reports_the_missing_live_registration() {
        let previous = validate_shortcut_settings(ShortcutSettings::default()).unwrap();
        let candidate = validate_shortcut_settings(ShortcutSettings {
            region: "Command+Shift+R".into(),
            window: "Command+Shift+W".into(),
            fullscreen: "Command+Shift+F".into(),
        })
        .unwrap();
        let mut registry = FakeRegistry::default();
        for binding in &previous.bindings {
            registry.registered.insert(binding.shortcut.id());
        }
        registry.register_failures.insert(
            candidate.bindings[1].shortcut.id(),
            "owned by another app".into(),
        );
        registry.register_failures.insert(
            previous.bindings[0].shortcut.id(),
            "OS refused previous restore".into(),
        );

        let error = replace_registered_shortcuts(
            &mut registry,
            &previous.bindings,
            &previous.bindings,
            &candidate.bindings,
            || Ok(()),
        )
        .unwrap_err();

        assert!(!error.rollback_complete);
        assert!(!error
            .active_bindings
            .iter()
            .any(|binding| binding.shortcut.id() == previous.bindings[0].shortcut.id()));
        assert_eq!(error.active_bindings.len(), previous.bindings.len() - 1);

        let mut runtime = ShortcutRuntime {
            settings: previous.settings,
            bindings: previous.bindings.clone(),
            active_bindings: previous.bindings,
            conflicts: Vec::new(),
            storage_warning: None,
        };
        runtime.reconcile_failed_update(&error);
        assert_eq!(runtime.active_bindings.len(), 2);
        assert_eq!(runtime.conflicts.len(), 1);
        assert_eq!(runtime.conflicts[0].action, CaptureAction::Region);
        assert!(runtime.storage_warning.unwrap().contains("incomplete"));
    }
}
