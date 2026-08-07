import { invoke } from "@tauri-apps/api/core";
import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import "./App.css";

type ShortcutSettings = {
  region: string;
  window: string;
  fullscreen: string;
};

type CaptureAction = keyof ShortcutSettings;

type ShortcutConflict = {
  action: CaptureAction;
  display: string;
  error: string;
};

type ShortcutStatus = {
  settings: ShortcutSettings;
  conflicts: ShortcutConflict[];
  storageWarning: string | null;
};

const DEFAULT_SHORTCUTS: ShortcutSettings = {
  region: "Control+Shift+C",
  window: "Control+Shift+W",
  fullscreen: "Control+Shift+F",
};

const SHORTCUT_FIELDS: Array<{
  action: CaptureAction;
  label: string;
  detail: string;
}> = [
  { action: "region", label: "Area", detail: "Select any region" },
  { action: "window", label: "Window", detail: "Choose one window" },
  {
    action: "fullscreen",
    label: "Full screen",
    detail: "Capture the main display",
  },
];

const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function formatShortcut(shortcut: string) {
  return shortcut
    .split("+")
    .map((part) => {
      const token = part.trim();
      const normalized = token.toLowerCase();
      if (normalized === "command" || normalized === "super") return "⌘";
      if (normalized === "control" || normalized === "ctrl") return "⌃";
      if (normalized === "alt" || normalized === "option") return "⌥";
      if (normalized === "shift") return "⇧";
      if (/^key[a-z]$/i.test(token)) return token.slice(3).toUpperCase();
      if (/^digit[0-9]$/i.test(token)) return token.slice(5);
      return token.replace(/^Arrow/i, "");
    })
    .join("");
}

function shortcutFromEvent(event: KeyboardEvent<HTMLButtonElement>) {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  if (modifiers.length === 0) {
    throw new Error("Include ⌘, ⌃, ⌥, or ⇧ in the shortcut.");
  }
  if (!event.code || event.code === "Unidentified") {
    throw new Error("That key cannot be used as a global shortcut.");
  }

  return [...modifiers, event.code].join("+");
}

function sameSettings(left: ShortcutSettings, right: ShortcutSettings) {
  return (
    left.region === right.region &&
    left.window === right.window &&
    left.fullscreen === right.fullscreen
  );
}

function App() {
  const [settings, setSettings] = useState(DEFAULT_SHORTCUTS);
  const [savedSettings, setSavedSettings] = useState(DEFAULT_SHORTCUTS);
  const [conflicts, setConflicts] = useState<ShortcutConflict[]>([]);
  const [recording, setRecording] = useState<CaptureAction | null>(null);
  const [notice, setNotice] = useState(() =>
    isTauriRuntime()
      ? "Loading shortcuts…"
      : "Preview mode — changes activate in the installed app.",
  );
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [needsRetry, setNeedsRetry] = useState(false);
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const isDirty = !sameSettings(settings, savedSettings);

  useEffect(() => {
    if (!nativeRuntime) {
      setNotice("Preview mode — changes activate in the installed app.");
      setNoticeIsError(false);
      return;
    }

    invoke<ShortcutStatus>("get_shortcut_settings")
      .then((status) => {
        setSettings(status.settings);
        setSavedSettings(status.settings);
        setConflicts(status.conflicts);
        setNotice(
          status.storageWarning ??
            (status.conflicts.length > 0
              ? "Some shortcuts are unavailable. Tray capture still works."
              : "Shortcuts are active globally."),
        );
        setNoticeIsError(
          status.storageWarning !== null || status.conflicts.length > 0,
        );
        setNeedsRetry(
          status.storageWarning !== null || status.conflicts.length > 0,
        );
      })
      .catch((error: unknown) => {
        setNotice(`Could not load shortcuts: ${String(error)}`);
        setNoticeIsError(true);
        setNeedsRetry(true);
      });
  }, [nativeRuntime]);

  function recordShortcut(
    action: CaptureAction,
    event: KeyboardEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();

    if (event.code === "Escape") {
      setRecording(null);
      setNotice("Shortcut unchanged.");
      setNoticeIsError(false);
      return;
    }
    if (MODIFIER_CODES.has(event.code)) return;

    try {
      const shortcut = shortcutFromEvent(event);
      setSettings((current) => ({ ...current, [action]: shortcut }));
      setRecording(null);
      setNotice("Shortcut ready to save.");
      setNoticeIsError(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      setNoticeIsError(true);
    }
  }

  async function save() {
    if (!nativeRuntime) return;
    setIsSaving(true);
    setNotice("Checking shortcuts…");
    setNoticeIsError(false);

    try {
      const status = await invoke<ShortcutStatus>(
        "update_shortcut_settings",
        { settings },
      );
      setSettings(status.settings);
      setSavedSettings(status.settings);
      setConflicts(status.conflicts);
      setNotice("Saved. Shortcuts are active globally.");
      setNoticeIsError(false);
      setNeedsRetry(false);
    } catch (error) {
      setNotice(String(error));
      setNoticeIsError(true);
      setNeedsRetry(true);
      try {
        const status = await invoke<ShortcutStatus>("get_shortcut_settings");
        setSavedSettings(status.settings);
        setConflicts(status.conflicts);
      } catch {
        // Keep the last known status; the original update error is actionable.
      }
    } finally {
      setIsSaving(false);
    }
  }

  function restoreDefaults() {
    setSettings({ ...DEFAULT_SHORTCUTS });
    setRecording(null);
    setNotice("Defaults ready to save.");
    setNoticeIsError(false);
    setNeedsRetry(true);
  }

  return (
    <main className="popover">
      <header className="popover-header">
        <div>
          <p className="eyebrow">Capso capture</p>
          <h1>Keyboard shortcuts</h1>
        </div>
        <span className="status-dot" aria-label="Capso is running" />
      </header>

      <section className="shortcut-list" aria-label="Capture shortcuts">
        {SHORTCUT_FIELDS.map(({ action, label, detail }) => (
          <div className="shortcut-row" key={action}>
            <div className="shortcut-copy">
              <strong>{label}</strong>
              <span>{detail}</span>
            </div>
            <button
              type="button"
              className="shortcut-recorder"
              data-recording={recording === action}
              aria-pressed={recording === action}
              aria-label={`Record ${label} shortcut`}
              onClick={() => {
                setRecording(action);
                setNotice("Press your new shortcut. Escape cancels.");
                setNoticeIsError(false);
              }}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => {
                if (recording === action) {
                  recordShortcut(action, event);
                }
              }}
            >
              {recording === action
                ? "Type shortcut"
                : formatShortcut(settings[action])}
            </button>
          </div>
        ))}
      </section>

      <div className="notice" data-error={noticeIsError} aria-live="polite">
        <span className="notice-mark" aria-hidden="true" />
        <p>{notice}</p>
      </div>

      {conflicts.length > 0 && (
        <ul className="conflict-list" aria-label="Shortcut conflicts">
          {conflicts.map((conflict) => (
            <li key={conflict.action}>
              {formatShortcut(conflict.display)} — {conflict.error}
            </li>
          ))}
        </ul>
      )}

      <footer className="actions">
        <button
          type="button"
          className="secondary-button"
          onClick={restoreDefaults}
          disabled={isSaving}
        >
          Restore defaults
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={save}
          disabled={!nativeRuntime || (!isDirty && !needsRetry) || isSaving}
        >
          {isSaving
            ? "Saving…"
            : !isDirty && needsRetry
              ? "Retry shortcuts"
              : "Save shortcuts"}
        </button>
      </footer>
    </main>
  );
}

export default App;
