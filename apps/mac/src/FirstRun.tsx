import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

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

type SystemStatus = {
  screenRecording: "granted" | "required";
  launchAtLogin: string;
};

type Diagnostics = { latency_statistics: string | null };
type ShortcutSettings = { shortcut?: string };
type ShortcutStatus = { settings: ShortcutSettings };

export function FirstRun({ onDone }: { onDone: () => void }) {
  const [input, setInput] = useState<FirstRunInput | null>(null);
  const [shortcut, setShortcut] = useState("⌃⇧C");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [system, diagnostics, keys] = await Promise.all([
        invoke<SystemStatus>("get_system_status"),
        invoke<Diagnostics>("get_diagnostics"),
        invoke<ShortcutStatus>("get_shortcut_settings"),
      ]);
      if (keys.settings.shortcut) setShortcut(keys.settings.shortcut);
      setInput({
        screenRecording: system.screenRecording,
        launchAtLogin: system.launchAtLogin,
        hotkeyConfirmed: localStorage.getItem(HOTKEY_SEEN) === "1",
        hasCaptured: diagnostics.latency_statistics !== null,
      });
    } catch (error) {
      setNote(String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // macOS can grant Screen Recording while this window is open, and it does not
    // tell us. Poll while the walkthrough is up; it stops when it unmounts.
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
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
    if (!current || busy) return;
    setBusy(true);
    setNote(null);
    try {
      if (current.id === "permission") {
        // Ask first; the system prompt only ever appears once, so fall back to
        // opening System Settings for anyone who already dismissed it.
        await invoke("request_screen_recording_permission").catch(() => undefined);
        await invoke("open_screen_recording_settings");
        setNote("Turn Capso on in System Settings, then come back — this updates on its own.");
      } else if (current.id === "hotkey") {
        localStorage.setItem(HOTKEY_SEEN, "1");
      } else if (current.id === "login") {
        await invoke("set_launch_at_login_enabled", { enabled: true });
      }
      await refresh();
    } catch (error) {
      setNote(String(error));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      if (current.id === "login") await invoke("set_launch_at_login_enabled", { enabled: false });
      await refresh();
    } catch (error) {
      setNote(String(error));
    } finally {
      setBusy(false);
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
        Three quick things, then Capso stays out of the way in your menu bar.
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
                  {label && (
                    <button type="button" className="first-run__primary" disabled={busy} onClick={() => void act()}>
                      {label}
                    </button>
                  )}
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
