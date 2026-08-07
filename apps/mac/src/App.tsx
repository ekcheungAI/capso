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

type ScreenRecordingStatus = "granted" | "required";
type LoginItemStatus =
  | "disabled"
  | "enabled"
  | "requiresApproval"
  | "unavailable";

type SystemStatus = {
  screenRecording: ScreenRecordingStatus;
  screenRecordingRequestAttempted: boolean;
  launchAtLogin: LoginItemStatus;
};

const DEFAULT_SHORTCUTS: ShortcutSettings = {
  region: "Control+Shift+C",
  window: "Control+Shift+W",
  fullscreen: "Control+Shift+F",
};

const PREVIEW_SYSTEM_STATUS: SystemStatus = {
  screenRecording: "required",
  screenRecordingRequestAttempted: false,
  launchAtLogin: "disabled",
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
  const [systemStatus, setSystemStatus] = useState(PREVIEW_SYSTEM_STATUS);
  const [systemNotice, setSystemNotice] = useState(() =>
    isTauriRuntime()
      ? "Checking macOS access…"
      : "Preview mode — system controls activate in the installed app.",
  );
  const [systemNoticeIsError, setSystemNoticeIsError] = useState(
    () => !isTauriRuntime(),
  );
  const [systemAction, setSystemAction] = useState<
    "permission" | "login" | null
  >(null);
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const isDirty = !sameSettings(settings, savedSettings);
  const screenRecordingGranted = systemStatus.screenRecording === "granted";
  const launchAtLoginEnabled =
    systemStatus.launchAtLogin === "enabled" ||
    systemStatus.launchAtLogin === "requiresApproval";

  async function refreshSystemStatus() {
    if (!nativeRuntime) return;

    try {
      const status = await invoke<SystemStatus>("get_system_status");
      setSystemStatus(status);
      if (status.screenRecording === "granted") {
        setSystemNotice("Screen capture access is ready.");
        setSystemNoticeIsError(false);
      } else {
        setSystemNotice(
          "Area capture still works. Window and full-screen capture need access.",
        );
        setSystemNoticeIsError(true);
      }
    } catch (error) {
      setSystemNotice(`Could not check macOS access: ${String(error)}`);
      setSystemNoticeIsError(true);
    }
  }

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

  useEffect(() => {
    if (!nativeRuntime) return;

    void refreshSystemStatus();
    const handleFocus = () => void refreshSystemStatus();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [nativeRuntime]);

  async function handleScreenRecording() {
    if (!nativeRuntime || screenRecordingGranted) return;
    setSystemAction("permission");
    setSystemNoticeIsError(false);

    try {
      if (systemStatus.screenRecordingRequestAttempted) {
        await invoke("open_screen_recording_settings");
        setSystemNotice(
          "System Settings opened. Enable Capso, then return here to recheck.",
        );
      } else {
        setSystemNotice("Waiting for your macOS permission choice…");
        const status = await invoke<SystemStatus>(
          "request_screen_recording_permission",
        );
        setSystemStatus(status);
        if (status.screenRecording === "granted") {
          setSystemNotice("Screen Recording granted. All capture modes are ready.");
          setSystemNoticeIsError(false);
        } else {
          setSystemNotice(
            "Access is still off. Open System Settings to enable Capso.",
          );
          setSystemNoticeIsError(true);
        }
      }
    } catch (error) {
      setSystemNotice(String(error));
      setSystemNoticeIsError(true);
    } finally {
      setSystemAction(null);
    }
  }

  async function toggleLaunchAtLogin() {
    if (
      !nativeRuntime ||
      systemAction !== null ||
      systemStatus.launchAtLogin === "unavailable"
    ) {
      return;
    }

    setSystemAction("login");
    setSystemNotice(
      launchAtLoginEnabled
        ? "Turning off launch at login…"
        : "Enabling launch at login…",
    );
    setSystemNoticeIsError(false);

    try {
      const status = await invoke<SystemStatus>(
        "set_launch_at_login_enabled",
        { enabled: !launchAtLoginEnabled },
      );
      setSystemStatus(status);
      if (status.launchAtLogin === "requiresApproval") {
        setSystemNotice("macOS needs your approval in Login Items.");
        setSystemNoticeIsError(true);
      } else {
        setSystemNotice(
          status.launchAtLogin === "enabled"
            ? "Capso will start after you log in."
            : "Capso will only start when you open it.",
        );
      }
    } catch (error) {
      const message = String(error);
      try {
        const status = await invoke<SystemStatus>("get_system_status");
        setSystemStatus(status);
      } catch {
        // Preserve the last known state; the mutation error remains actionable.
      }
      setSystemNotice(message);
      setSystemNoticeIsError(true);
    } finally {
      setSystemAction(null);
    }
  }

  async function openLoginItemSettings() {
    if (!nativeRuntime) return;
    try {
      await invoke("open_login_item_settings");
      setSystemNotice(
        "Login Items opened. Approve Capso, then return here to recheck.",
      );
      setSystemNoticeIsError(false);
    } catch (error) {
      setSystemNotice(String(error));
      setSystemNoticeIsError(true);
    }
  }

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
          <h1>Capture settings</h1>
        </div>
        <span
          className="status-dot"
          data-ready={screenRecordingGranted}
          aria-label={
            screenRecordingGranted
              ? "Capso is ready"
              : "Capso needs Screen Recording access"
          }
        />
      </header>

      <section className="system-card" aria-labelledby="system-heading">
        <div className="section-heading">
          <h2 id="system-heading">System readiness</h2>
          <span data-ready={screenRecordingGranted}>
            {screenRecordingGranted ? "Ready" : "Action needed"}
          </span>
        </div>

        <div className="system-row">
          <div className="system-copy">
            <strong>Screen Recording</strong>
            <span>
              {screenRecordingGranted
                ? "Window and full-screen capture enabled"
                : "Required for windows and full screens"}
            </span>
          </div>
          <button
            type="button"
            className="compact-button"
            data-granted={screenRecordingGranted}
            disabled={
              !nativeRuntime ||
              screenRecordingGranted ||
              systemAction !== null
            }
            onClick={handleScreenRecording}
          >
            {screenRecordingGranted
              ? "Granted"
              : systemAction === "permission"
                ? "Checking…"
                : systemStatus.screenRecordingRequestAttempted
                  ? "Open settings"
                  : "Grant access"}
          </button>
        </div>

        <div className="system-row">
          <div className="system-copy">
            <strong>Launch at login</strong>
            <span>
              {systemStatus.launchAtLogin === "requiresApproval"
                ? "Needs approval in Login Items"
                : systemStatus.launchAtLogin === "enabled"
                  ? "Starts automatically after login"
                  : systemStatus.launchAtLogin === "unavailable"
                    ? "Unavailable outside the installed Mac app"
                    : "Optional — off until you enable it"}
            </span>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-label="Launch Capso at login"
            aria-checked={launchAtLoginEnabled}
            disabled={
              !nativeRuntime ||
              systemAction !== null ||
              systemStatus.launchAtLogin === "unavailable"
            }
            onClick={toggleLaunchAtLogin}
          >
            <span aria-hidden="true" />
          </button>
        </div>

        {systemStatus.launchAtLogin === "requiresApproval" && (
          <button
            type="button"
            className="settings-link"
            onClick={openLoginItemSettings}
          >
            Open Login Items
          </button>
        )}

        <div
          className="system-notice"
          data-error={systemNoticeIsError}
          aria-live="polite"
        >
          {systemNotice}
        </div>
      </section>

      <section aria-labelledby="shortcuts-heading">
        <div className="section-heading shortcuts-heading">
          <h2 id="shortcuts-heading">Keyboard shortcuts</h2>
        </div>
        <div className="shortcut-list">
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
        </div>
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
