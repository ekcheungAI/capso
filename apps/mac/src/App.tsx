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
  saveAsTemplateError,
  suggestedCaptureFilename,
  type OverlaySaveAsPreferences,
} from "./overlay-drag";
import {
  cloudAccountPresentation,
  shortcutRecorderLabel,
  syncPresentation,
  type SyncRuntimeStatus,
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

type OverlayPlacement = "top_left" | "top_right" | "bottom_left" | "bottom_right";
type OverlaySize = "compact" | "regular" | "large";
type OverlayAutoDismiss = "eight_seconds" | "fifteen_seconds" | "never";
type OverlayQuickActions = {
  pin: boolean;
  annotate: boolean;
  copy: boolean;
  save: boolean;
};

type OverlayPreferences = {
  placement: OverlayPlacement;
  size: OverlaySize;
  autoDismiss: OverlayAutoDismiss;
  quickActions: OverlayQuickActions;
};

type OverlayDisplaySettings = {
  id: string;
  name: string;
  isPrimary: boolean;
  preferences: OverlayPreferences;
};

type OverlaySettingsSnapshot = {
  displays: OverlayDisplaySettings[];
  selectedDisplayId: string;
  saveAs: OverlaySaveAsPreferences;
  storageWarning: string | null;
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
  automation_status: AutomationFeedback | null;
};

type AutomationFeedback = {
  message: string;
  isError: boolean;
};

type AuthFailureEvent = { message: string };

type AuthUiSnapshot = {
  configured: boolean;
  account: AuthAccountStatus;
  lastFailure: string | null;
};

type DeviceInfo = {
  name: string;
  platform: string;
  appVersion: string;
};

type SettingsTransferAction = "export" | "import" | "reset";
type AuthAction = "email" | "reconnect" | "sign_out";
type SystemAction = "permission" | "login" | "login_settings";

type SettingsExportResult = {
  fileName: string;
};

type SettingsImportResult = {
  sourceName: string;
  shortcutStatus: ShortcutStatus;
};

const PREVIEW_MODE = new URLSearchParams(window.location.search).get("preview");
const PREVIEW_CONNECTED =
  !("__TAURI_INTERNALS__" in window) &&
  ["connected", "reconnect", "device-revoked"].includes(PREVIEW_MODE ?? "");
const PREVIEW_RECONNECT = PREVIEW_CONNECTED && PREVIEW_MODE === "reconnect";
const PREVIEW_DEVICE_REVOKED = PREVIEW_CONNECTED && PREVIEW_MODE === "device-revoked";

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

const DEFAULT_OVERLAY_PREFERENCES: OverlayPreferences = {
  placement: "bottom_right",
  size: "compact",
  autoDismiss: "eight_seconds",
  quickActions: { pin: true, annotate: true, copy: true, save: true },
};

const DEFAULT_SAVE_AS_PREFERENCES: OverlaySaveAsPreferences = {
  format: "png",
  filenameTemplate: "Capso {date} at {time}",
};

const PREVIEW_OVERLAY_SETTINGS: OverlaySettingsSnapshot = {
  displays: [
    {
      id: "built-in-retina",
      name: "Built-in Retina Display",
      isPrimary: true,
      preferences: DEFAULT_OVERLAY_PREFERENCES,
    },
    {
      id: "studio-display",
      name: "Studio Display",
      isPrimary: false,
      preferences: {
        placement: "top_right",
        size: "regular",
        autoDismiss: "never",
        quickActions: { pin: true, annotate: true, copy: false, save: true },
      },
    },
  ],
  selectedDisplayId: "built-in-retina",
  saveAs: DEFAULT_SAVE_AS_PREFERENCES,
  storageWarning: null,
};

const PREVIEW_AUTH_STATUS: AuthAccountStatus = {
  status: PREVIEW_CONNECTED ? "signed_in" : "signed_out",
  userId: PREVIEW_CONNECTED ? "018f22c4-cada-7c6b-9d5b-fc35f7f92279" : null,
  email: PREVIEW_CONNECTED ? "elvin@example.com" : null,
};

const PREVIEW_SYNC_STATUS: SyncRuntimeStatus = {
  summary: {
    remotePending: 0,
    pending: 0,
    uploading: 0,
    retrying: 0,
    failed: 0,
    uploaded: PREVIEW_CONNECTED ? 4 : 0,
    total: PREVIEW_CONNECTED ? 4 : 0,
  },
  annotationSummary: {
    pending: 0,
    uploading: 0,
    failed: 0,
    conflicts: 0,
    synced: PREVIEW_CONNECTED ? 2 : 0,
    total: PREVIEW_CONNECTED ? 2 : 0,
  },
  warning: PREVIEW_RECONNECT
    ? "The saved session expired."
    : PREVIEW_DEVICE_REVOKED
      ? "This Mac was disconnected from Capso. Reconnect the same account to resume sync."
      : null,
  lastSuccessAtMs: PREVIEW_CONNECTED ? Date.now() - 5 * 60_000 : null,
  reconnectRequired: PREVIEW_RECONNECT || PREVIEW_DEVICE_REVOKED,
};

const PREVIEW_DEVICE_INFO: DeviceInfo = {
  name: "This Mac",
  platform: "macOS",
  appVersion: "preview",
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

const AUTOMATION_ROUTES = [
  ["Capture Area", "capso://capture/area"],
  ["Capture Window", "capso://capture/window"],
  ["Capture Full screen", "capso://capture/fullscreen"],
  ["Open History", "capso://open/history"],
  ["Open Recording", "capso://open/recording"],
  ["Open Settings", "capso://open/settings"],
] as const;

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
  const shortcutSaveInFlight = useRef(false);
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
  const [systemAction, setSystemAction] = useState<SystemAction | null>(null);
  const systemActionInFlight = useRef<SystemAction | null>(null);
  const [overlaySettings, setOverlaySettings] = useState(PREVIEW_OVERLAY_SETTINGS);
  const [overlayDisplayId, setOverlayDisplayId] = useState(PREVIEW_OVERLAY_SETTINGS.selectedDisplayId);
  const [overlayDraft, setOverlayDraft] = useState(DEFAULT_OVERLAY_PREFERENCES);
  const [saveAsDraft, setSaveAsDraft] = useState(DEFAULT_SAVE_AS_PREFERENCES);
  const [overlaySaving, setOverlaySaving] = useState(false);
  const overlaySaveInFlight = useRef(false);
  const [overlayNotice, setOverlayNotice] = useState(() =>
    isTauriRuntime()
      ? "Loading Quick Access behavior…"
      : "Preview mode - each display keeps its own Quick Access choices.",
  );
  const [overlayNoticeIsError, setOverlayNoticeIsError] = useState(false);
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
  const [authConfigured, setAuthConfigured] = useState(PREVIEW_CONNECTED);
  const [authEmail, setAuthEmail] = useState("");
  const [authAction, setAuthAction] = useState<AuthAction | null>(null);
  const authActionInFlight = useRef<AuthAction | null>(null);
  const [authNotice, setAuthNotice] = useState(() =>
    isTauriRuntime()
      ? "Checking your Capso account…"
      : "Preview mode - sign-in activates in the installed app.",
  );
  const [authNoticeIsError, setAuthNoticeIsError] = useState(
    () => !isTauriRuntime(),
  );
  const [syncStatus, setSyncStatus] = useState(PREVIEW_SYNC_STATUS);
  const [syncAction, setSyncAction] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(PREVIEW_DEVICE_INFO);
  const [libraryAction, setLibraryAction] = useState(false);
  const [historyAction, setHistoryAction] = useState(false);
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);
  const [settingsTransferAction, setSettingsTransferAction] =
    useState<SettingsTransferAction | null>(null);
  const settingsTransferInFlight = useRef<SettingsTransferAction | null>(null);
  const [settingsTransferNotice, setSettingsTransferNotice] = useState(() =>
    isTauriRuntime()
      ? "Export a local backup or bring the same preferences to another Mac."
      : "Preview mode - system file pickers activate in the installed app.",
  );
  const [settingsTransferNoticeIsError, setSettingsTransferNoticeIsError] =
    useState(false);
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const accountPresentation = useMemo(
    () => cloudAccountPresentation(authConfigured, authStatus.status),
    [authConfigured, authStatus.status],
  );
  const syncState = useMemo(
    () => syncPresentation(authConfigured, authStatus.status, syncStatus),
    [authConfigured, authStatus.status, syncStatus],
  );
  const isDirty = !sameSettings(settings, savedSettings);
  const screenRecordingGranted = systemStatus.screenRecording === "granted";
  const launchAtLoginEnabled =
    systemStatus.launchAtLogin === "enabled" ||
    systemStatus.launchAtLogin === "requiresApproval";
  const overlaySavedPreferences = overlaySettings.displays.find(
    (display) => display.id === overlayDisplayId,
  )?.preferences ?? DEFAULT_OVERLAY_PREFERENCES;
  const saveAsTemplateIssue = saveAsTemplateError(saveAsDraft.filenameTemplate);
  const overlayDirty =
    JSON.stringify(overlayDraft) !== JSON.stringify(overlaySavedPreferences) ||
    JSON.stringify(saveAsDraft) !== JSON.stringify(overlaySettings.saveAs);

  function beginSettingsTransfer(action: SettingsTransferAction) {
    if (settingsTransferInFlight.current !== null) return false;
    settingsTransferInFlight.current = action;
    setSettingsTransferAction(action);
    return true;
  }

  function endSettingsTransfer(action: SettingsTransferAction) {
    if (settingsTransferInFlight.current !== action) return;
    settingsTransferInFlight.current = null;
    setSettingsTransferAction(null);
  }

  function beginAuthAction(action: AuthAction) {
    if (authActionInFlight.current !== null) return false;
    authActionInFlight.current = action;
    setAuthAction(action);
    return true;
  }

  function endAuthAction(action: AuthAction) {
    if (authActionInFlight.current !== action) return;
    authActionInFlight.current = null;
    setAuthAction(null);
  }

  function beginSystemAction(action: SystemAction) {
    if (systemActionInFlight.current !== null) return false;
    systemActionInFlight.current = action;
    setSystemAction(action);
    return true;
  }

  function endSystemAction(action: SystemAction) {
    if (systemActionInFlight.current !== action) return;
    systemActionInFlight.current = null;
    setSystemAction(null);
  }

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

  function installOverlaySettings(snapshot: OverlaySettingsSnapshot) {
    const selected = snapshot.displays.find(
      (display) => display.id === snapshot.selectedDisplayId,
    ) ?? snapshot.displays[0];
    setOverlaySettings(snapshot);
    if (selected) {
      setOverlayDisplayId(selected.id);
      setOverlayDraft(selected.preferences);
    }
    setSaveAsDraft(snapshot.saveAs);
    setOverlayNotice(
      snapshot.storageWarning
        ?? "Saved separately for each connected display. New captures use these choices.",
    );
    setOverlayNoticeIsError(snapshot.storageWarning !== null);
  }

  function installTransferredShortcuts(status: ShortcutStatus) {
    setSettings(status.settings);
    setSavedSettings(status.settings);
    setConflicts(status.conflicts);
    setNotice(
      status.conflicts.length > 0
        ? "Imported, but some shortcuts are unavailable. Tray capture still works."
        : "Imported shortcuts are active globally.",
    );
    setNoticeIsError(status.conflicts.length > 0);
    setNeedsRetry(status.conflicts.length > 0);
  }

  async function refreshOverlayAfterSettingsTransfer() {
    if (!nativeRuntime) return;
    try {
      installOverlaySettings(
        await invoke<OverlaySettingsSnapshot>("get_overlay_settings"),
      );
    } catch (error) {
      setOverlayNotice(`Settings changed, but Quick Access could not refresh: ${String(error)}`);
      setOverlayNoticeIsError(true);
    }
  }

  function installPreviewDefaults() {
    const shortcutStatus: ShortcutStatus = {
      settings: { ...DEFAULT_SHORTCUTS },
      conflicts: [],
      storageWarning: null,
    };
    installTransferredShortcuts(shortcutStatus);
    const snapshot: OverlaySettingsSnapshot = {
      ...PREVIEW_OVERLAY_SETTINGS,
      displays: PREVIEW_OVERLAY_SETTINGS.displays.map((display) => ({
        ...display,
        preferences: {
          ...DEFAULT_OVERLAY_PREFERENCES,
          quickActions: { ...DEFAULT_OVERLAY_PREFERENCES.quickActions },
        },
      })),
    };
    installOverlaySettings(snapshot);
  }

  async function exportSettings() {
    const action = "export";
    if (isDirty || overlayDirty || !beginSettingsTransfer(action)) return;
    setSettingsTransferNotice("Choosing where to save a local settings backup…");
    setSettingsTransferNoticeIsError(false);
    try {
      if (!nativeRuntime) {
        setSettingsTransferNotice(
          "Preview only. The installed app exports Capso Settings.json through a system save dialog.",
        );
        return;
      }
      const result = await invoke<SettingsExportResult | null>(
        "export_portable_settings",
      );
      setSettingsTransferNotice(
        result === null
          ? "Export cancelled. No file was changed."
          : `Exported ${result.fileName}. Account and library data were excluded.`,
      );
    } catch (error) {
      setSettingsTransferNotice(String(error));
      setSettingsTransferNoticeIsError(true);
    } finally {
      endSettingsTransfer(action);
    }
  }

  async function importSettings() {
    const action = "import";
    if (settingsTransferInFlight.current !== null) return;
    if (
      (isDirty || overlayDirty) &&
      !window.confirm(
        "Importing will discard unsaved shortcut and Quick Access changes. Continue?",
      )
    ) {
      return;
    }
    if (!beginSettingsTransfer(action)) return;
    setSettingsTransferNotice("Choosing a Capso settings JSON file…");
    setSettingsTransferNoticeIsError(false);
    try {
      if (!nativeRuntime) {
        installPreviewDefaults();
        setSettingsTransferNotice(
          "Preview imported safe sample defaults. The installed app validates the whole file before replacing anything.",
        );
        return;
      }
      const result = await invoke<SettingsImportResult | null>(
        "import_portable_settings",
      );
      if (result === null) {
        setSettingsTransferNotice("Import cancelled. Current settings were not changed.");
        return;
      }
      installTransferredShortcuts(result.shortcutStatus);
      await refreshOverlayAfterSettingsTransfer();
      setSettingsTransferNotice(
        `Imported ${result.sourceName}. Capture and Quick Access choices are active.`,
      );
    } catch (error) {
      setSettingsTransferNotice(String(error));
      setSettingsTransferNoticeIsError(true);
    } finally {
      endSettingsTransfer(action);
    }
  }

  async function resetAllSettings() {
    const action = "reset";
    if (settingsTransferInFlight.current !== null) return;
    if (
      !window.confirm(
        "Reset shortcuts, remembered capture choices, and Quick Access on every display to built-in defaults? Your account and captures stay untouched.",
      )
    ) {
      return;
    }
    if (!beginSettingsTransfer(action)) return;
    setSettingsTransferNotice("Restoring built-in settings…");
    setSettingsTransferNoticeIsError(false);
    try {
      if (!nativeRuntime) {
        installPreviewDefaults();
        setSettingsTransferNotice(
          "Preview reset complete. Account and library data stayed untouched.",
        );
        return;
      }
      const result = await invoke<SettingsImportResult>("reset_portable_settings");
      installTransferredShortcuts(result.shortcutStatus);
      await refreshOverlayAfterSettingsTransfer();
      setSettingsTransferNotice(
        "Built-in defaults restored. Account and library data stayed untouched.",
      );
    } catch (error) {
      setSettingsTransferNotice(String(error));
      setSettingsTransferNoticeIsError(true);
    } finally {
      endSettingsTransfer(action);
    }
  }

  function chooseOverlayDisplay(displayId: string) {
    if (overlayDirty) {
      setOverlayNotice("Save or discard changes before switching displays.");
      setOverlayNoticeIsError(false);
      return;
    }
    const display = overlaySettings.displays.find((candidate) => candidate.id === displayId);
    if (!display) return;
    setOverlayDisplayId(display.id);
    setOverlayDraft(display.preferences);
    setOverlayNotice(`Editing Quick Access on ${display.name}.`);
    setOverlayNoticeIsError(false);
  }

  async function saveOverlaySettings() {
    if (!overlayDirty || overlaySaveInFlight.current) return;
    if (saveAsTemplateIssue) {
      setOverlayNotice(saveAsTemplateIssue);
      setOverlayNoticeIsError(true);
      return;
    }
    overlaySaveInFlight.current = true;
    setOverlaySaving(true);
    setOverlayNoticeIsError(false);
    try {
      if (nativeRuntime) {
        const snapshot = await invoke<OverlaySettingsSnapshot>("update_overlay_settings", {
          displayId: overlayDisplayId,
          preferences: overlayDraft,
          saveAs: saveAsDraft,
        });
        installOverlaySettings(snapshot);
      } else {
        setOverlaySettings((current) => ({
          ...current,
          saveAs: saveAsDraft,
          displays: current.displays.map((display) => display.id === overlayDisplayId
            ? { ...display, preferences: overlayDraft }
            : display),
        }));
        setOverlayNotice("Preview saved for this display. The installed app stores it locally.");
      }
    } catch (error) {
      setOverlayNotice(String(error));
      setOverlayNoticeIsError(true);
    } finally {
      overlaySaveInFlight.current = false;
      setOverlaySaving(false);
    }
  }

  function restoreOverlayDefaults() {
    setOverlayDraft(DEFAULT_OVERLAY_PREFERENCES);
    setSaveAsDraft(DEFAULT_SAVE_AS_PREFERENCES);
    setOverlayNotice("Default Quick Access and Save As choices are ready to save.");
    setOverlayNoticeIsError(false);
  }

  function setOverlayQuickAction(
    action: keyof OverlayQuickActions,
    enabled: boolean,
  ) {
    const quickActions = { ...overlayDraft.quickActions, [action]: enabled };
    if (!Object.values(quickActions).some(Boolean)) {
      setOverlayNotice("Keep at least one Quick Access action visible.");
      setOverlayNoticeIsError(false);
      return;
    }
    setOverlayDraft({ ...overlayDraft, quickActions });
    setOverlayNotice("Action visibility is ready to save for this display.");
    setOverlayNoticeIsError(false);
  }

  function discardOverlayChanges() {
    setOverlayDraft(overlaySavedPreferences);
    setSaveAsDraft(overlaySettings.saveAs);
    setOverlayNotice("Unsaved Quick Access and Save As changes were discarded.");
    setOverlayNoticeIsError(false);
  }

  async function refreshDiagnostics() {
    if (!nativeRuntime) return;

    try {
      const report = await invoke<Diagnostics>("get_diagnostics");
      setDiagnostics(report);
      setDiagnosticsNotice(report.automation_status?.message ??
        "Read-only. Quote these lines when you report a problem.");
      setDiagnosticsNoticeIsError(report.automation_status?.isError ?? false);
      if (report.automation_status?.isError) setActiveSection("advanced");
    } catch (error) {
      setDiagnostics(null);
      setDiagnosticsNotice(`Could not load diagnostics: ${String(error)}`);
      setDiagnosticsNoticeIsError(true);
    }
  }

  async function refreshSyncStatus() {
    if (!nativeRuntime) return;

    try {
      setSyncStatus(await invoke<SyncRuntimeStatus>("get_sync_status"));
    } catch (error) {
      setSyncStatus((current) => ({ ...current, warning: String(error) }));
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
    void invoke<DeviceInfo>("get_device_info")
      .then(setDeviceInfo)
      .catch(() => setDeviceInfo(PREVIEW_DEVICE_INFO));
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
        setReconnectNotice(null);
        void refreshSyncStatus();
      },
    );
    const failureListener = listen<AuthFailureEvent>(
      "auth-sign-in-failed",
      ({ payload }) => {
        if (!active) return;
        setAuthNotice(payload.message);
        setAuthNoticeIsError(true);
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

  useEffect(() => {
    if (!nativeRuntime) return;
    let active = true;
    const statusListener = listen<SyncRuntimeStatus>(
      "sync-status-changed",
      ({ payload }) => {
        if (!active) return;
        setSyncStatus(payload);
        setSyncAction(false);
      },
    );
    const captureListener = listen("capture-finished", () => {
      if (active) void refreshSyncStatus();
    });

    void refreshSyncStatus();
    const handleFocus = () => void refreshSyncStatus();
    window.addEventListener("focus", handleFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", handleFocus);
      void statusListener.then((unlisten) => unlisten());
      void captureListener.then((unlisten) => unlisten());
    };
  }, [nativeRuntime]);

  async function requestSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = "email";
    if (!nativeRuntime || !beginAuthAction(action)) return;
    setAuthNotice("Requesting a secure sign-in email…");
    setAuthNoticeIsError(false);
    try {
      await invoke("request_sign_in_email", { email: authEmail });
      setAuthNotice(
        "Check your email, then choose Open Capso on the confirmation page. The link expires in five minutes.",
      );
    } catch (error) {
      setAuthNotice(String(error));
      setAuthNoticeIsError(true);
    } finally {
      endAuthAction(action);
    }
  }

  async function signOut() {
    const action = "sign_out";
    if (!nativeRuntime || !beginAuthAction(action)) return;
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
      endAuthAction(action);
    }
  }

  async function retrySync() {
    if (!nativeRuntime || syncAction) return;
    setSyncAction(true);
    setAuthNotice("Retrying saved captures…");
    setAuthNoticeIsError(false);
    try {
      await invoke("retry_sync");
      window.setTimeout(() => void refreshSyncStatus(), 800);
    } catch (error) {
      setSyncAction(false);
      setAuthNotice(String(error));
      setAuthNoticeIsError(true);
    }
  }

  async function reconnectAccount() {
    const action = "reconnect";
    if (!nativeRuntime || !beginAuthAction(action)) return;
    setReconnectNotice(null);
    setAuthNoticeIsError(false);
    try {
      await invoke("request_reconnect_email");
      setReconnectNotice(
        "Check your account email, then choose Open Capso. Local captures stay queued while you reconnect.",
      );
    } catch (error) {
      setAuthNotice(String(error));
      setAuthNoticeIsError(true);
    } finally {
      endAuthAction(action);
    }
  }

  async function openWebLibrary() {
    if (!nativeRuntime || libraryAction) return;
    setLibraryAction(true);
    setAuthNoticeIsError(false);
    try {
      await invoke("open_web_library");
      setAuthNotice("Opened your web library in the default browser.");
    } catch (error) {
      setAuthNotice(String(error));
      setAuthNoticeIsError(true);
    } finally {
      setLibraryAction(false);
    }
  }

  async function openCaptureHistory() {
    if (!nativeRuntime) return;
    setHistoryAction(true);
    try {
      await invoke("open_capture_history");
    } finally {
      setHistoryAction(false);
    }
  }

  useEffect(() => {
    if (!nativeRuntime) return;

    void refreshSystemStatus();
    const handleFocus = () => void refreshSystemStatus();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [nativeRuntime]);

  useEffect(() => {
    if (!nativeRuntime) return;
    let active = true;
    void invoke<OverlaySettingsSnapshot>("get_overlay_settings")
      .then((snapshot) => {
        if (active) installOverlaySettings(snapshot);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setOverlayNotice(`Could not load Quick Access behavior: ${String(error)}`);
        setOverlayNoticeIsError(true);
      });
    return () => {
      active = false;
    };
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

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AutomationFeedback>("automation-status-changed", ({ payload }) => {
      if (disposed) return;
      setDiagnosticsNotice(payload.message);
      setDiagnosticsNoticeIsError(payload.isError);
      if (payload.isError) setActiveSection("advanced");
      void refreshDiagnostics();
    }).then((remove) => {
      if (disposed) remove();
      else unlisten = remove;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  async function handleScreenRecording() {
    const action = "permission";
    if (!nativeRuntime || screenRecordingGranted || !beginSystemAction(action)) return;
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
      endSystemAction(action);
    }
  }

  async function toggleLaunchAtLogin() {
    const action = "login";
    if (
      !nativeRuntime ||
      systemStatus.launchAtLogin === "unavailable" ||
      !beginSystemAction(action)
    ) {
      return;
    }

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
      endSystemAction(action);
    }
  }

  async function openLoginItemSettings() {
    const action = "login_settings";
    if (!nativeRuntime || !beginSystemAction(action)) return;
    try {
      await invoke("open_login_item_settings");
      setSystemNotice(
        "Login Items opened. Approve Capso, then return here to recheck.",
      );
      setSystemNoticeIsError(false);
    } catch (error) {
      setSystemNotice(String(error));
      setSystemNoticeIsError(true);
    } finally {
      endSystemAction(action);
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
    if (!nativeRuntime || shortcutSaveInFlight.current) return;
    shortcutSaveInFlight.current = true;
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
      shortcutSaveInFlight.current = false;
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
              ? syncState.message
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
            disabled={systemAction !== null}
            onClick={openLoginItemSettings}
          >
            {systemAction === "login_settings" ? "Opening…" : "Open Login Items"}
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

          <section className="system-card quick-access-settings" aria-labelledby="quick-access-settings-heading">
            <div className="section-heading">
              <div>
                <h2 id="quick-access-settings-heading">Quick Access behavior</h2>
                <p>Position, size and autoclose are remembered per display.</p>
              </div>
              <span data-muted={true}>Per display</span>
            </div>

            <div className="quick-access-settings__grid">
              <label>
                <span>Display</span>
                <select
                  aria-label="Quick Access display"
                  value={overlayDisplayId}
                  disabled={overlaySaving}
                  onChange={(event) => chooseOverlayDisplay(event.currentTarget.value)}
                >
                  {overlaySettings.displays.map((display) => (
                    <option key={display.id} value={display.id}>
                      {display.name}{display.isPrimary ? " · Main" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Position</span>
                <select
                  aria-label="Quick Access position"
                  value={overlayDraft.placement}
                  disabled={overlaySaving}
                  onChange={(event) => setOverlayDraft({
                    ...overlayDraft,
                    placement: event.currentTarget.value as OverlayPlacement,
                  })}
                >
                  <option value="top_left">Top left</option>
                  <option value="top_right">Top right</option>
                  <option value="bottom_left">Bottom left</option>
                  <option value="bottom_right">Bottom right</option>
                </select>
              </label>
              <label>
                <span>Size</span>
                <select
                  aria-label="Quick Access size"
                  value={overlayDraft.size}
                  disabled={overlaySaving}
                  onChange={(event) => setOverlayDraft({
                    ...overlayDraft,
                    size: event.currentTarget.value as OverlaySize,
                  })}
                >
                  <option value="compact">Compact · 304 × 194</option>
                  <option value="regular">Regular · 384 × 244</option>
                  <option value="large">Large · 464 × 294</option>
                </select>
              </label>
              <label>
                <span>Autoclose</span>
                <select
                  aria-label="Quick Access autoclose"
                  value={overlayDraft.autoDismiss}
                  disabled={overlaySaving}
                  onChange={(event) => setOverlayDraft({
                    ...overlayDraft,
                    autoDismiss: event.currentTarget.value as OverlayAutoDismiss,
                  })}
                >
                  <option value="eight_seconds">After 8 seconds</option>
                  <option value="fifteen_seconds">After 15 seconds</option>
                  <option value="never">Never</option>
                </select>
              </label>
            </div>

            <fieldset className="quick-access-settings__actions">
              <legend>Quick actions</legend>
              <p>Keep at least one Quick Access action visible.</p>
              <div>
                {([
                  ["pin", "Pin"],
                  ["annotate", "Annotate"],
                  ["copy", "Copy"],
                  ["save", "Save"],
                ] as const).map(([action, label]) => (
                  <label key={action}>
                    <input
                      type="checkbox"
                      aria-label={`Show ${label} in Quick Access`}
                      checked={overlayDraft.quickActions[action]}
                      disabled={overlaySaving}
                      onChange={(event) => setOverlayQuickAction(action, event.currentTarget.checked)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="quick-access-settings__save-as">
              <legend>Save As defaults <span>Every display</span></legend>
              <div>
                <label>
                  <span>Format</span>
                  <select
                    aria-label="Default Save As format"
                    value={saveAsDraft.format}
                    disabled={overlaySaving}
                    onChange={(event) => {
                      setSaveAsDraft({
                        ...saveAsDraft,
                        format: event.currentTarget.value as OverlaySaveAsPreferences["format"],
                      });
                      setOverlayNotice("Default export format is ready to save.");
                      setOverlayNoticeIsError(false);
                    }}
                  >
                    <option value="png">PNG · lossless transparency</option>
                    <option value="jpeg">JPEG · white background</option>
                  </select>
                </label>
                <label className="quick-access-settings__template">
                  <span>Filename</span>
                  <input
                    type="text"
                    aria-label="Save As filename template"
                    aria-invalid={saveAsTemplateIssue !== null}
                    maxLength={96}
                    value={saveAsDraft.filenameTemplate}
                    disabled={overlaySaving}
                    onChange={(event) => {
                      const filenameTemplate = event.currentTarget.value;
                      const issue = saveAsTemplateError(filenameTemplate);
                      setSaveAsDraft({ ...saveAsDraft, filenameTemplate });
                      setOverlayNotice(
                        issue
                          ? "Fix the Save As filename before saving."
                          : "Filename template is ready to save for every display.",
                      );
                      setOverlayNoticeIsError(issue !== null);
                    }}
                  />
                </label>
              </div>
              <p data-error={saveAsTemplateIssue !== null}>
                {saveAsTemplateIssue
                  ? saveAsTemplateIssue
                  : `Example · ${suggestedCaptureFilename(new Date(), saveAsDraft)}`}
              </p>
              <small>Use {"{date}"} and {"{time}"}. Internal History UUIDs never change.</small>
            </fieldset>

            <div className="quick-access-settings__preview" data-size={overlayDraft.size} data-placement={overlayDraft.placement} aria-hidden="true">
              <span><i /></span>
            </div>

            <div className="system-notice" data-error={overlayNoticeIsError} aria-live="polite">
              {overlayNotice}
            </div>
            <footer className="actions">
              <button
                type="button"
                className="secondary-button"
                disabled={overlaySaving}
                onClick={restoreOverlayDefaults}
              >Restore defaults</button>
              {overlayDirty && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={overlaySaving}
                  onClick={discardOverlayChanges}
                >Discard changes</button>
              )}
              <button
                type="button"
                className="primary-button"
                disabled={!overlayDirty || overlaySaving || saveAsTemplateIssue !== null}
                onClick={() => void saveOverlaySettings()}
              >{overlaySaving ? "Saving…" : "Save changes"}</button>
            </footer>
          </section>
        </div>
      )}

      {activeSection === "account" && (
        <div id="account-panel" role="tabpanel" aria-labelledby="account-tab" className="settings-panel">
          <section className="account-card" aria-labelledby="account-heading">
        <div className="section-heading">
          <h2 id="account-heading">Cloud sync</h2>
          <span
            data-ready={syncState.tone === "ready"}
            data-error={syncState.tone === "attention"}
            data-muted={!authConfigured}
          >
            {syncState.status}
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

        <div className="account-row">
          <div className="system-copy">
            <strong>{deviceInfo.name}</strong>
            <span>{deviceInfo.platform} · Capso {deviceInfo.appVersion}</span>
          </div>
          <button
            type="button"
            className="compact-button"
            disabled={!nativeRuntime || libraryAction}
            onClick={() => void openWebLibrary()}
          >
            {libraryAction ? "Opening…" : "Open web library"}
          </button>
        </div>

        {authStatus.status === "signed_in" && (
          <div className="account-row">
            <div className="system-copy">
              <strong>{syncState.title}</strong>
              <span>{syncState.message}</span>
            </div>
            {syncState.action === "retry" && (
              <button
                type="button"
                className="compact-button"
                disabled={!nativeRuntime || syncAction}
                onClick={() => void retrySync()}
              >
                {syncAction ? "Retrying…" : "Retry now"}
              </button>
            )}
            {syncState.action === "details" && (
              <button
                type="button"
                className="compact-button"
                onClick={() => setActiveSection("advanced")}
              >
                View details
              </button>
            )}
            {syncState.action === "history" && (
              <button
                type="button"
                className="compact-button"
                disabled={!nativeRuntime || historyAction}
                onClick={() => void openCaptureHistory()}
              >
                {historyAction ? "Opening…" : "Review in History"}
              </button>
            )}
            {syncState.action === "reconnect" && (
              <button
                type="button"
                className="compact-button"
                disabled={!nativeRuntime || authAction !== null}
                onClick={() => void reconnectAccount()}
              >
                {authAction === "reconnect" ? "Sending…" : "Reconnect"}
              </button>
            )}
          </div>
        )}

        {authStatus.status === "signed_in" && reconnectNotice !== null && (
          <div className="account-notice" aria-live="polite">
            {reconnectNotice}
          </div>
        )}

        {authStatus.status === "signed_in" && authNoticeIsError && (
          <div className="account-notice" data-error="true" aria-live="polite">
            {authNotice}
          </div>
        )}
          </section>
        </div>
      )}

      {activeSection === "advanced" && (
        <div id="advanced-panel" role="tabpanel" aria-labelledby="advanced-tab" className="settings-panel">
          <section className="system-card settings-portability" aria-labelledby="settings-portability-heading">
            <div className="section-heading">
              <h2 id="settings-portability-heading">Settings portability</h2>
              <span data-muted={true}>Local JSON · version 1</span>
            </div>
            <p className="settings-portability__guidance">
              Carries global shortcuts, remembered capture choices, and Quick Access profiles.
              It never includes your account, captures, upload queue, or editable projects.
            </p>
            <div className="settings-portability__scope" aria-label="Portable settings scope">
              <div>
                <strong>Included</strong>
                <span>Shortcuts · Capture HUD · Quick Access</span>
              </div>
              <div>
                <strong>Stays on this Mac</strong>
                <span>Account · Library · Previous Area</span>
              </div>
            </div>
            <div className="settings-portability__actions">
              <button
                type="button"
                className="secondary-button"
                disabled={settingsTransferAction !== null || isDirty || overlayDirty}
                title={isDirty || overlayDirty ? "Save or discard current changes before exporting." : undefined}
                onClick={() => void exportSettings()}
              >
                {settingsTransferAction === "export" ? "Exporting…" : "Export settings"}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={settingsTransferAction !== null}
                onClick={() => void importSettings()}
              >
                {settingsTransferAction === "import" ? "Importing…" : "Import settings"}
              </button>
              <button
                type="button"
                className="secondary-button settings-portability__reset"
                disabled={settingsTransferAction !== null}
                onClick={() => void resetAllSettings()}
              >
                {settingsTransferAction === "reset" ? "Resetting…" : "Reset all settings"}
              </button>
            </div>
            <div
              className="system-notice"
              data-error={settingsTransferNoticeIsError}
              aria-live="polite"
            >
              {settingsTransferNotice}
            </div>
          </section>

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

          <section className="system-card" aria-labelledby="automation-heading">
            <div className="section-heading">
              <h2 id="automation-heading">URL automation</h2>
              <span data-muted={true}>Raycast · Shortcuts · scripts</span>
                </div>
                <p className="automation-guidance">
                  Open one exact URL locally. Only capture URLs accept the optional delay{" "}
                  <code>?delay=3</code>, <code>?delay=5</code>, or <code>?delay=10</code>;
                  every other parameter, fragment, and unknown action is rejected.
                </p>
            <div className="automation-routes">
              {AUTOMATION_ROUTES.map(([label, route]) => (
                <div className="automation-route" key={route}>
                  <span>{label}</span>
                  <code>{route}</code>
                </div>
              ))}
            </div>
            {diagnostics?.automation_status && (
              <div
                className="system-notice"
                data-error={diagnostics.automation_status.isError}
                aria-live="polite"
              >
                {diagnostics.automation_status.message}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
