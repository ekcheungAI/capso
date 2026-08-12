import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import "./App.css";
import { FirstRun, firstRunDismissed } from "./FirstRun";
import {
  cloudAccountPresentation,
  shortcutRecorderLabel,
} from "./setup";

type ShortcutSettings = {
  region: string;
  window: string;
  fullscreen: string;
};

type CaptureAction = keyof ShortcutSettings;
type SettingsSection = "general" | "shortcuts" | "account" | "advanced";

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

type AuthAccountStatus = {
  status: "signed_in" | "signed_out";
  userId: string | null;
  email: string | null;
};

type Diagnostics = {
  latency_title: string;
  latency_status: string;
  latency_statistics: string | null;
  queue_label: string | null;
  queue_retryable: number;
};

type AuthFailureEvent = { message: string };

type AuthUiSnapshot = {
  configured: boolean;
  account: AuthAccountStatus;
  lastFailure: string | null;
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

const PREVIEW_AUTH_STATUS: AuthAccountStatus = {
  status: "signed_out",
  userId: null,
  email: null,
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

const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "shortcuts",
  "account",
  "advanced",
];

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
  // Read once, not polled: the walkthrough owns its own completion and calls
  // onDone. Only the real app can run it, so the dev preview goes straight to
  // Settings rather than showing a walkthrough whose invoke calls would all fail.
  const [showFirstRun, setShowFirstRun] = useState(
    () => isTauriRuntime() && !firstRunDismissed(),
  );
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("general");
  const screenRecordingButtonRef = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState(DEFAULT_SHORTCUTS);
  const [savedSettings, setSavedSettings] = useState(DEFAULT_SHORTCUTS);
  const [conflicts, setConflicts] = useState<ShortcutConflict[]>([]);
  const [recording, setRecording] = useState<CaptureAction | null>(null);
  const [notice, setNotice] = useState(() =>
    isTauriRuntime()
      ? "Loading shortcuts…"
      : "Preview mode - changes activate in the installed app.",
  );
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [needsRetry, setNeedsRetry] = useState(false);
  const [systemStatus, setSystemStatus] = useState(PREVIEW_SYSTEM_STATUS);
  const [systemNotice, setSystemNotice] = useState(() =>
    isTauriRuntime()
      ? "Checking macOS access…"
      : "Preview mode - system controls activate in the installed app.",
  );
  const [systemNoticeIsError, setSystemNoticeIsError] = useState(
    () => !isTauriRuntime(),
  );
  const [systemAction, setSystemAction] = useState<
    "permission" | "login" | null
  >(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosticsNotice, setDiagnosticsNotice] = useState(() =>
    isTauriRuntime()
      ? "Checking capture diagnostics…"
      : "Preview mode - diagnostics activate in the installed app.",
  );
  const [diagnosticsNoticeIsError, setDiagnosticsNoticeIsError] = useState(
    () => !isTauriRuntime(),
  );
  const [authStatus, setAuthStatus] = useState(PREVIEW_AUTH_STATUS);
  const [authConfigured, setAuthConfigured] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authAction, setAuthAction] = useState<"email" | "sign_out" | null>(
    null,
  );
  const [authNotice, setAuthNotice] = useState(() =>
    isTauriRuntime()
      ? "Checking your Capso account…"
      : "Preview mode - sign-in activates in the installed app.",
  );
  const [authNoticeIsError, setAuthNoticeIsError] = useState(
    () => !isTauriRuntime(),
  );
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const accountPresentation = useMemo(
    () => cloudAccountPresentation(authConfigured, authStatus.status),
    [authConfigured, authStatus.status],
  );
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

  async function refreshDiagnostics() {
    if (!nativeRuntime) return;

    try {
      const report = await invoke<Diagnostics>("get_diagnostics");
      setDiagnostics(report);
      setDiagnosticsNotice(
        "Read-only. Quote these lines when you report a problem.",
      );
      setDiagnosticsNoticeIsError(false);
    } catch (error) {
      setDiagnostics(null);
      setDiagnosticsNotice(`Could not load diagnostics: ${String(error)}`);
      setDiagnosticsNoticeIsError(true);
    }
  }

  useEffect(() => {
    if (!nativeRuntime) {
      setNotice("Preview mode - changes activate in the installed app.");
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
    let active = true;
    const statusListener = listen<AuthAccountStatus>(
      "auth-status-changed",
      ({ payload }) => {
        if (!active) return;
        setAuthConfigured(true);
        setAuthStatus(payload);
        setAuthNotice(
          payload.status === "signed_in"
            ? `Signed in${payload.email ? ` as ${payload.email}` : ""}. Ready to sync when the cloud connection is available.`
            : "Sign in before syncing captures to your private web library.",
        );
        setAuthNoticeIsError(false);
        setAuthAction(null);
      },
    );
    const failureListener = listen<AuthFailureEvent>(
      "auth-sign-in-failed",
      ({ payload }) => {
        if (!active) return;
        setAuthNotice(payload.message);
        setAuthNoticeIsError(true);
        setAuthAction(null);
      },
    );

    invoke<AuthUiSnapshot>("get_auth_status")
      .then((snapshot) => {
        if (!active) return;
        setAuthConfigured(snapshot.configured);
        const status = snapshot.account;
        setAuthStatus(status);
        setAuthNotice(
          snapshot.lastFailure ??
            (status.status === "signed_in"
              ? `Signed in${status.email ? ` as ${status.email}` : ""}. Ready to sync when the cloud connection is available.`
              : "Sign in before syncing captures to your private web library."),
        );
        setAuthNoticeIsError(snapshot.lastFailure !== null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAuthNotice(String(error));
        setAuthNoticeIsError(true);
      });

    return () => {
      active = false;
      void statusListener.then((unlisten) => unlisten());
      void failureListener.then((unlisten) => unlisten());
    };
  }, [nativeRuntime]);

  async function requestSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nativeRuntime || authAction !== null) return;
    setAuthAction("email");
    setAuthNotice("Requesting a secure sign-in email…");
    setAuthNoticeIsError(false);
    try {
      await invoke("request_sign_in_email", { email: authEmail });
      setAuthNotice(
        "Check your email, then choose Open Capso on the confirmation page. The link expires in five minutes.",
      );
      setAuthAction(null);
    } catch (error) {
      setAuthNotice(String(error));
      setAuthNoticeIsError(true);
      setAuthAction(null);
    }
  }

  async function signOut() {
    if (!nativeRuntime || authAction !== null) return;
    setAuthAction("sign_out");
    setAuthNotice("Signing out…");
    setAuthNoticeIsError(false);
    try {
      const status = await invoke<AuthAccountStatus>("sign_out");
      setAuthStatus(status);
      setAuthEmail("");
      setAuthNotice("Signed out. Local captures remain on this Mac.");
    } catch (error) {
      setAuthNotice(String(error));
      setAuthNoticeIsError(true);
    } finally {
      setAuthAction(null);
    }
  }

  useEffect(() => {
    if (!nativeRuntime) return;

    void refreshSystemStatus();
    const handleFocus = () => void refreshSystemStatus();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [nativeRuntime]);

  // Diagnostics are a snapshot, so they load once on mount and refresh whenever
  // Advanced is opened again rather than polling in the background.
  useEffect(() => {
    if (!nativeRuntime) return;
    void refreshDiagnostics();
  }, [nativeRuntime]);

  useEffect(() => {
    if (!nativeRuntime || activeSection !== "advanced") return;
    void refreshDiagnostics();
  }, [nativeRuntime, activeSection]);

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
      setNotice("Saved. Switch to another app to use your shortcuts.");
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

  function moveSettingsTab(
    section: SettingsSection,
    event: KeyboardEvent<HTMLButtonElement>,
  ) {
    const currentIndex = SETTINGS_SECTIONS.indexOf(section);
    const nextIndex =
      event.key === "ArrowRight"
        ? (currentIndex + 1) % SETTINGS_SECTIONS.length
        : event.key === "ArrowLeft"
          ? (currentIndex - 1 + SETTINGS_SECTIONS.length) %
            SETTINGS_SECTIONS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? SETTINGS_SECTIONS.length - 1
              : null;
    if (nextIndex === null) return;

    event.preventDefault();
    setActiveSection(SETTINGS_SECTIONS[nextIndex]);
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    );
    tabs?.[nextIndex]?.focus();
  }

  function openSystemPermissions() {
    setActiveSection("general");
    requestAnimationFrame(() => screenRecordingButtonRef.current?.focus());
  }

  /**
   * First run covers Settings until it is done or skipped. `12_MAC_APP_PLAN.md`
   * specified this flow and it did not exist — a new user landed on a settings
   * panel with four tabs and had to work out that Screen Recording was the thing
   * standing between them and a screenshot. Deliberately a cover, not a modal:
   * nothing may block capture (doc 15, interaction principle 2), and the hotkey
   * keeps working throughout — which is the point, since taking a capture is the
   * last step.
   */
  if (showFirstRun) {
    return <FirstRun onDone={() => setShowFirstRun(false)} />;
  }

  return (
    <main className="popover">
      <header className="popover-header">
        <div>
          <p className="eyebrow">Capso</p>
          <h1>Settings</h1>
          <p className="header-copy">
            {authStatus.status === "signed_in"
              ? "Captures sync automatically to your library."
              : "Sign in to sync captures to your library."}
          </p>
        </div>
        <span className="status-pill" data-ready={screenRecordingGranted}>
          {screenRecordingGranted ? "All modes ready" : "Area ready"}
        </span>
      </header>

      <div className="settings-tabs" role="tablist" aria-label="Capso settings">
        <button id="general-tab" type="button" role="tab" aria-controls="general-panel" aria-selected={activeSection === "general"} tabIndex={activeSection === "general" ? 0 : -1} onClick={() => setActiveSection("general")} onKeyDown={(event) => moveSettingsTab("general", event)}>General</button>
        <button id="shortcuts-tab" type="button" role="tab" aria-controls="shortcuts-panel" aria-selected={activeSection === "shortcuts"} tabIndex={activeSection === "shortcuts" ? 0 : -1} onClick={() => setActiveSection("shortcuts")} onKeyDown={(event) => moveSettingsTab("shortcuts", event)}>Shortcuts</button>
        <button id="account-tab" type="button" role="tab" aria-controls="account-panel" aria-selected={activeSection === "account"} tabIndex={activeSection === "account" ? 0 : -1} onClick={() => setActiveSection("account")} onKeyDown={(event) => moveSettingsTab("account", event)}>Account</button>
        <button id="advanced-tab" type="button" role="tab" aria-controls="advanced-panel" aria-selected={activeSection === "advanced"} tabIndex={activeSection === "advanced" ? 0 : -1} onClick={() => setActiveSection("advanced")} onKeyDown={(event) => moveSettingsTab("advanced", event)}>Advanced</button>
      </div>

      {activeSection === "shortcuts" && (
        <div id="shortcuts-panel" role="tabpanel" aria-labelledby="shortcuts-tab" className="settings-panel">
          {!screenRecordingGranted && (
            <button type="button" className="permission-bridge" onClick={openSystemPermissions}>
              <strong>Area works now.</strong>
              <span>Enable Window &amp; Full Screen</span>
            </button>
          )}

          <section className="shortcut-section" aria-labelledby="shortcuts-heading">
        <div className="setup-heading">
          <div>
            <h2 id="shortcuts-heading">Keyboard shortcuts</h2>
            <p>Click a shortcut, then press your new key combination.</p>
          </div>
          <span>Works from any app</span>
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
                aria-label={`Change ${label} shortcut`}
                onClick={(event) => {
                  event.currentTarget.focus();
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
                {shortcutRecorderLabel(
                  formatShortcut(settings[action]),
                  recording === action,
                )}
              </button>
            </div>
          ))}
        </div>

        <div className="notice" data-error={noticeIsError} aria-live="polite">
          <span className="notice-mark" aria-hidden="true" />
          <p>{notice}</p>
        </div>

        {conflicts.length > 0 && (
          <ul className="conflict-list" aria-label="Shortcut conflicts">
            {conflicts.map((conflict) => (
              <li key={conflict.action}>
                {formatShortcut(conflict.display)} - {conflict.error}
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
                : "Save changes"}
          </button>
        </footer>
          </section>
        </div>
      )}

      {activeSection === "general" && (
        <div id="general-panel" role="tabpanel" aria-labelledby="general-tab" className="settings-panel">
          <section className="system-card" aria-labelledby="system-heading">
        <div className="section-heading">
          <h2 id="system-heading">Capture permissions</h2>
          <span data-ready={screenRecordingGranted}>
            {screenRecordingGranted ? "All modes ready" : "Area works now"}
          </span>
        </div>

        <div className="system-row">
          <div className="system-copy">
            <strong>Window &amp; full screen</strong>
            <span>
              {screenRecordingGranted
                ? "Screen Recording access is enabled"
                : "Allow Screen Recording to unlock these modes"}
            </span>
          </div>
          <button
            ref={screenRecordingButtonRef}
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
                    : "Optional - off until you enable it"}
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
        </div>
      )}

      {activeSection === "account" && (
        <div id="account-panel" role="tabpanel" aria-labelledby="account-tab" className="settings-panel">
          <section className="account-card" aria-labelledby="account-heading">
        <div className="section-heading">
          <h2 id="account-heading">Cloud sync</h2>
          <span
            data-ready={authStatus.status === "signed_in"}
            data-muted={!authConfigured}
          >
            {accountPresentation.status}
          </span>
        </div>

        {authStatus.status === "signed_in" ? (
          <div className="account-row">
            <div className="system-copy">
              <strong>{authStatus.email ?? "Capso account"}</strong>
              <span>{accountPresentation.message}</span>
            </div>
            <button
              type="button"
              className="compact-button"
              disabled={!nativeRuntime || authAction !== null}
              onClick={() => void signOut()}
            >
              {authAction === "sign_out" ? "Signing out…" : "Sign out"}
            </button>
          </div>
        ) : accountPresentation.showEmailForm ? (
          <>
            <p className="account-guidance">{accountPresentation.message}</p>
            <form className="account-form" onSubmit={requestSignIn}>
              <label htmlFor="account-email">Capso account email</label>
              <div>
                <input
                  id="account-email"
                  type="email"
                  value={authEmail}
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  required
                  disabled={!nativeRuntime || authAction !== null}
                  onChange={(event) => setAuthEmail(event.target.value)}
                />
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!nativeRuntime || authAction !== null}
                >
                  {authAction === "email" ? "Sending…" : "Send link"}
                </button>
              </div>
            </form>
            <div
              className="account-notice"
              data-error={authNoticeIsError}
              aria-live="polite"
            >
              {authNotice}
            </div>
          </>
        ) : (
          <div className="account-unavailable">
            <strong>No email needed</strong>
            <span>{accountPresentation.message}</span>
          </div>
        )}
          </section>
        </div>
      )}

      {activeSection === "advanced" && (
        <div id="advanced-panel" role="tabpanel" aria-labelledby="advanced-tab" className="settings-panel">
          <section className="system-card" aria-labelledby="diagnostics-heading">
            <div className="section-heading">
              <h2 id="diagnostics-heading">Diagnostics</h2>
              <span data-muted={true}>Read only</span>
            </div>

            {diagnostics !== null && (
              <>
                <div className="system-row">
                  <div className="system-copy">
                    <strong>{diagnostics.latency_title}</strong>
                    <span>{diagnostics.latency_status}</span>
                    {diagnostics.latency_statistics !== null && (
                      <span className="diagnostic-metric">
                        {diagnostics.latency_statistics}
                      </span>
                    )}
                  </div>
                </div>

                <div className="system-row">
                  <div className="system-copy">
                    <strong>Upload queue</strong>
                    <span>
                      {diagnostics.queue_label ??
                        "Nothing is waiting to sync."}
                    </span>
                    {diagnostics.queue_retryable > 0 && (
                      <span className="diagnostic-metric">
                        {diagnostics.queue_retryable} waiting to retry
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}

            <div
              className="system-notice"
              data-error={diagnosticsNoticeIsError}
              aria-live="polite"
            >
              {diagnosticsNotice}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
