import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { createLatestRequestGate } from "./async-control";
import { CapsoGlyph, CapsoGlyphDefs } from "./glyphs.generated";
import { firstRunComplete, firstRunSteps, type FirstRunInput } from "./onboarding";

/**
 * The first-run walkthrough `12_MAC_APP_PLAN.md` specified and nobody built.
 *
 * It adds no capability. Every control here already existed as settings UI in
 * App.tsx — `request_screen_recording_permission`, `open_screen_recording_settings`,
 * `set_launch_at_login_enabled`, the shortcut recorder — and this screen calls the
 * same commands rather than re-implementing them. Re-implementing permission logic
 * is how the palette ended up hand-copied into six places before gen-tokens.mjs
 * existed, and it would drift the same way.
 *
 * Two deliberate simplifications against the plan, both to avoid Rust changes that
 * could not be verified from here:
 *
 *  - `hasCaptured` is derived from `get_diagnostics().latency_statistics`, which is
 *    `None` until a capture produces a timing sample and whose samples survive
 *    restart (see `latency.rs`, and the test named
 *    `latest_twenty_privacy_safe_samples_survive_restart`). That is a durable
 *    "has captured at least once" signal with no new bookkeeping.
 *  - Dismissal is a localStorage latch in the webview, not `onboarding.json` via
 *    two new Tauri commands. Nothing on the Rust side needs to read it.
 */

const DISMISSED = "capso.mac.firstRun";
const HOTKEY_SEEN = "capso.mac.hotkeySeen";
const LIBRARY_CHOICE = "capso.mac.libraryChoice";

type SystemStatus = {
  screenRecording: "granted" | "required";
  launchAtLogin: string;
};

type Diagnostics = { latency_statistics: string | null };
type ShortcutSettings = { shortcut?: string };
type ShortcutStatus = { settings: ShortcutSettings };
type AuthUiSnapshot = {
  configured: boolean;
  account: {
    status: "signed_in" | "signed_out";
  };
};

export function FirstRun({ onDone }: { onDone: () => void }) {
  const [input, setInput] = useState<FirstRunInput | null>(null);
  const [shortcut, setShortcut] = useState("⌃⇧C");
  const [email, setEmail] = useState("");
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const refreshGate = useRef(createLatestRequestGate());
  const mounted = useRef(true);

  function beginFirstRunAction() {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setBusy(true);
    return true;
  }

  function endFirstRunAction() {
    if (!actionInFlight.current) return;
    actionInFlight.current = false;
    if (mounted.current) setBusy(false);
  }

  const refresh = useCallback(async () => {
    const isLatest = refreshGate.current.begin();
    try {
      const [system, diagnostics, keys, auth] = await Promise.all([
        invoke<SystemStatus>("get_system_status"),
        invoke<Diagnostics>("get_diagnostics"),
        invoke<ShortcutStatus>("get_shortcut_settings"),
        invoke<AuthUiSnapshot>("get_auth_status"),
      ]);
      if (!isLatest()) return;
      if (keys.settings.shortcut) setShortcut(keys.settings.shortcut);
      const rememberedLibraryChoice = localStorage.getItem(LIBRARY_CHOICE);
      setInput({
        screenRecording: system.screenRecording,
        launchAtLogin: system.launchAtLogin,
        hotkeyConfirmed: localStorage.getItem(HOTKEY_SEEN) === "1",
        cloudConfigured: auth.configured,
        libraryChoice:
          auth.account.status === "signed_in"
            ? "connected"
            : rememberedLibraryChoice === "local_only"
              ? "local_only"
              : "undecided",
        hasCaptured: diagnostics.latency_statistics !== null,
      });
    } catch (error) {
      if (!isLatest()) return;
      setNote(String(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // macOS can grant Screen Recording while this window is open, and it does not
    // tell us. Poll while the walkthrough is up; it stops when it unmounts.
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      clearInterval(timer);
      mounted.current = false;
      refreshGate.current.invalidate();
    };
  }, [refresh]);

  useEffect(() => {
    if (input && firstRunComplete(input)) {
      localStorage.setItem(DISMISSED, "1");
      onDone();
    }
  }, [input, onDone]);

  if (!input) {
    return (
      <main className="first-run">
        <p className="first-run__note">Checking this Mac…</p>
      </main>
    );
  }

  const steps = firstRunSteps(input);
  const current = steps.find((s) => s.state === "current");

  const act = async () => {
    if (!current || !beginFirstRunAction()) return;
    setNote(null);
    try {
      if (current.id === "permission") {
        // Ask first; the system prompt only ever appears once, so fall back to
        // opening System Settings for anyone who already dismissed it.
        await invoke("request_screen_recording_permission").catch(() => undefined);
        if (!mounted.current) return;
        await invoke("open_screen_recording_settings");
        if (!mounted.current) return;
        setNote("Turn Capso on in System Settings, then come back — this updates on its own.");
      } else if (current.id === "hotkey") {
        localStorage.setItem(HOTKEY_SEEN, "1");
      } else if (current.id === "login") {
        await invoke("set_launch_at_login_enabled", { enabled: true });
      }
      await refresh();
    } catch (error) {
      if (mounted.current) setNote(String(error));
    } finally {
      endFirstRunAction();
    }
  };

  const decline = async () => {
    if (!current || !beginFirstRunAction()) return;
    try {
      if (current.id === "login") await invoke("set_launch_at_login_enabled", { enabled: false });
      await refresh();
    } catch (error) {
      if (mounted.current) setNote(String(error));
    } finally {
      endFirstRunAction();
    }
  };

  const chooseLocalOnly = () => {
    if (actionInFlight.current) return;
    localStorage.setItem(LIBRARY_CHOICE, "local_only");
    setInput((currentInput) =>
      currentInput === null
        ? currentInput
        : { ...currentInput, libraryChoice: "local_only" },
    );
    setShowConnectForm(false);
    setNote("Local-only selected. You can connect later in Account Settings.");
  };

  const requestSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input.cloudConfigured || !beginFirstRunAction()) return;
    setNote("Requesting a secure sign-in email…");
    try {
      await invoke("request_sign_in_email", { email });
      if (!mounted.current) return;
      setNote(
        "Check your email, then choose Open Capso. This screen will update when your library connects.",
      );
    } catch (error) {
      if (mounted.current) setNote(String(error));
    } finally {
      endFirstRunAction();
    }
  };

  const label =
    current?.id === "permission"
      ? "Open System Settings"
      : current?.id === "hotkey"
        ? `Use ${shortcut}`
        : current?.id === "login"
          ? "Start at login"
          : null;

  return (
    <main className="first-run">
      <CapsoGlyphDefs />
      <h1 className="first-run__title">Set up Capso</h1>
      <p className="first-run__lead">
        A few quick choices, then Capso stays out of the way in your menu bar.
      </p>

      <ol className="first-run__steps">
        {steps.map((step) => (
          <li key={step.id} className="first-run__step" data-state={step.state}>
            <span className="first-run__bullet" aria-hidden="true">
              {step.state === "done" ? "✓" : ""}
            </span>
            <div className="first-run__body">
              <p className="first-run__step-title">
                {step.title}
                {step.optional && <span className="first-run__optional"> · optional</span>}
              </p>
              <p className="first-run__detail">{step.detail}</p>

              {step.state === "current" && (
                <div className="first-run__actions">
                  {step.id === "library" && !input.cloudConfigured ? (
                    <button
                      type="button"
                      className="first-run__primary"
                      disabled={busy}
                      onClick={chooseLocalOnly}
                    >
                      Use this Mac only
                    </button>
                  ) : step.id === "library" && showConnectForm ? (
                    <form className="first-run__account-form" onSubmit={requestSignIn}>
                      <label htmlFor="first-run-email">Capso account email</label>
                      <div>
                        <input
                          id="first-run-email"
                          type="email"
                          value={email}
                          autoComplete="email"
                          inputMode="email"
                          placeholder="you@example.com"
                          required
                          disabled={busy}
                          onChange={(event) => setEmail(event.target.value)}
                        />
                        <button type="submit" className="first-run__primary" disabled={busy}>
                          {busy ? "Sending…" : "Send secure link"}
                        </button>
                      </div>
                      <p>Your Chrome extension can join this same library after sign-in.</p>
                      <button
                        type="button"
                        className="first-run__secondary"
                        disabled={busy}
                        onClick={chooseLocalOnly}
                      >
                        Use this Mac only
                      </button>
                    </form>
                  ) : step.id === "library" ? (
                    <>
                      <button
                        type="button"
                        className="first-run__primary"
                        disabled={busy}
                        onClick={() => {
                          setNote(null);
                          setShowConnectForm(true);
                        }}
                      >
                        Connect library
                      </button>
                      <button
                        type="button"
                        className="first-run__secondary"
                        disabled={busy}
                        onClick={chooseLocalOnly}
                      >
                        Use this Mac only
                      </button>
                    </>
                  ) : label ? (
                    <button type="button" className="first-run__primary" disabled={busy} onClick={() => void act()}>
                      {label}
                    </button>
                  ) : null}
                  {step.optional && (
                    <button type="button" className="first-run__secondary" disabled={busy} onClick={() => void decline()}>
                      No thanks
                    </button>
                  )}
                  {step.id === "capture" && (
                    <p className="first-run__waiting">
                      <CapsoGlyph name="rack" /> Waiting for your first capture — press {shortcut}.
                    </p>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      {note && <p className="first-run__note">{note}</p>}

      {/* Nothing may block capture (doc 15, interaction principle 2). The way out
          is explicit rather than a hidden Escape, and it does not pretend the
          remaining steps are done — Settings still shows them. */}
      <button
        type="button"
        className="first-run__skip"
        onClick={() => {
          localStorage.setItem(DISMISSED, "1");
          onDone();
        }}
      >
        Skip — I'll do this in Settings
      </button>
    </main>
  );
}

/** Whether the walkthrough was already dismissed or completed on this Mac. */
export function firstRunDismissed(): boolean {
  return localStorage.getItem(DISMISSED) === "1";
}
