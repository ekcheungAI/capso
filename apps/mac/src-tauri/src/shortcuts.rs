use crate::capture::CaptureMode;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct CaptureShortcut {
    pub(crate) action: CaptureAction,
    pub(crate) code: Code,
    pub(crate) menu_id: &'static str,
    pub(crate) menu_label: &'static str,
    pub(crate) display: &'static str,
}

impl CaptureShortcut {
    pub(crate) fn shortcut(self) -> Shortcut {
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), self.code)
    }
}

const CAPTURE_SHORTCUTS: [CaptureShortcut; 3] = [
    CaptureShortcut {
        action: CaptureAction::Region,
        code: Code::KeyC,
        menu_id: "capture-region",
        menu_label: "Capture Region    ⌃⇧C",
        display: "⌃⇧C",
    },
    CaptureShortcut {
        action: CaptureAction::Window,
        code: Code::KeyW,
        menu_id: "capture-window",
        menu_label: "Capture Window    ⌃⇧W",
        display: "⌃⇧W",
    },
    CaptureShortcut {
        action: CaptureAction::Fullscreen,
        code: Code::KeyF,
        menu_id: "capture-fullscreen",
        menu_label: "Capture Fullscreen    ⌃⇧F",
        display: "⌃⇧F",
    },
];

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct ShortcutConflict {
    pub(crate) action: CaptureAction,
    pub(crate) display: &'static str,
    pub(crate) error: String,
}

pub(crate) fn definitions() -> &'static [CaptureShortcut; 3] {
    &CAPTURE_SHORTCUTS
}

pub(crate) fn register_capture_shortcuts<F>(
    mut register: F,
) -> Vec<ShortcutConflict>
where
    F: FnMut(CaptureShortcut) -> Result<(), String>,
{
    definitions()
        .iter()
        .filter_map(|definition| {
            register(*definition)
                .err()
                .map(|error| ShortcutConflict {
                    action: definition.action,
                    display: definition.display,
                    error,
                })
        })
        .collect()
}

pub(crate) fn action_for_event(
    shortcut: &Shortcut,
    state: ShortcutState,
) -> Option<CaptureAction> {
    if state != ShortcutState::Pressed {
        return None;
    }

    definitions()
        .iter()
        .find(|definition| {
            shortcut.matches(
                Modifiers::CONTROL | Modifiers::SHIFT,
                definition.code,
            )
        })
        .map(|definition| definition.action)
}

pub(crate) fn action_for_menu_id(id: &str) -> Option<CaptureAction> {
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

#[cfg(test)]
mod tests {
    use super::{
        action_for_event, action_for_menu_id, conflict_label, definitions,
        register_capture_shortcuts, CaptureAction,
    };
    use std::collections::HashSet;
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    #[test]
    fn defaults_are_unique_and_match_the_capture_contract() {
        let definitions = definitions();
        let ids = definitions
            .iter()
            .map(|definition| definition.menu_id)
            .collect::<HashSet<_>>();
        let shortcut_ids = definitions
            .iter()
            .map(|definition| definition.shortcut().id())
            .collect::<HashSet<_>>();

        assert_eq!(definitions.len(), 3);
        assert_eq!(ids.len(), definitions.len());
        assert_eq!(shortcut_ids.len(), definitions.len());
        assert_eq!(definitions[0].display, "⌃⇧C");
        assert_eq!(definitions[1].display, "⌃⇧W");
        assert_eq!(definitions[2].display, "⌃⇧F");
    }

    #[test]
    fn one_conflict_does_not_prevent_other_shortcuts_registering() {
        let mut attempted = Vec::new();
        let conflicts = register_capture_shortcuts(|definition| {
            attempted.push(definition.action);
            if definition.action == CaptureAction::Window {
                Err("already registered".into())
            } else {
                Ok(())
            }
        });

        assert_eq!(
            attempted,
            vec![
                CaptureAction::Region,
                CaptureAction::Window,
                CaptureAction::Fullscreen,
            ]
        );
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].action, CaptureAction::Window);
        assert_eq!(conflicts[0].display, "⌃⇧W");
        assert_eq!(conflicts[0].error, "already registered");
        assert_eq!(
            conflict_label(&conflicts).as_deref(),
            Some(
                "Shortcut unavailable: ⌃⇧W (already registered) — use Capture menu actions"
            )
        );
    }

    #[test]
    fn only_known_pressed_shortcuts_launch_capture_actions() {
        let control_shift = Modifiers::CONTROL | Modifiers::SHIFT;
        let region = Shortcut::new(Some(control_shift), Code::KeyC);
        let unrelated = Shortcut::new(Some(control_shift), Code::KeyP);

        assert_eq!(
            action_for_event(&region, ShortcutState::Pressed),
            Some(CaptureAction::Region)
        );
        assert_eq!(action_for_event(&region, ShortcutState::Released), None);
        assert_eq!(action_for_event(&unrelated, ShortcutState::Pressed), None);
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
        assert_eq!(action_for_menu_id("quit"), None);
    }
}
