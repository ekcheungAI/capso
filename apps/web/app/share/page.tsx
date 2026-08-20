"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle, Eye, LockKey, SpinnerGap } from "@phosphor-icons/react";
import { CapsoMark, CapsoMarkDefs } from "@/components/mark.generated";
import {
  shareFailureKind,
  shareInspectResult,
  shareLinkFromFragment,
  shareStatusCopy,
  type ShareFailureStatus,
  type ShareInspectResult,
} from "@/lib/share-link";

type ReceiverState =
  | { status: "loading" }
  | { status: "password"; details: ShareInspectResult; error: string | null; busy: boolean }
  | { status: "one_time"; details: ShareInspectResult }
  | { status: "ready"; details: ShareInspectResult; imageUrl: string }
  | { status: "error"; kind: ShareFailureStatus | "unavailable" };

function previewState(preview: string | null): ReceiverState | null {
  const details = {
    status: "ready" as const,
    requiresPassword: preview === "password",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    oneTime: preview === "one-time",
  };
  if (preview === "password") return { status: "password", details, error: null, busy: false };
  if (preview === "one-time") return { status: "one_time", details };
  if (preview === "consumed") return { status: "error", kind: "consumed" };
  return null;
}

export default function SharePage() {
  return (
    <Suspense fallback={(
      <main className="grid min-h-screen place-items-center bg-background px-4 py-8 text-foreground" aria-busy="true">
        <p className="text-sm font-semibold">Opening the private capture…</p>
      </main>
    )}>
      <ShareReceiver />
    </Suspense>
  );
}

function ShareReceiver() {
  const searchParams = useSearchParams();
  const previewMode = process.env.NODE_ENV === "production" ? null : searchParams.get("preview");
  const [state, setState] = useState<ReceiverState>({ status: "loading" });
  const [password, setPassword] = useState("");
  const imageRequest = useRef(false);
  const receiverState = previewState(previewMode) ?? state;

  const loadImage = useCallback(async (token: string, details: ShareInspectResult, pass = "") => {
    if (imageRequest.current) return;
    imageRequest.current = true;
    setState((current) => current.status === "password"
      ? { ...current, error: null, busy: true }
      : { status: "loading" });
    try {
      const response = await fetch("/api/share/image", {
        method: "POST",
        headers: { "content-type": "application/json", "x-capso-share-token": token },
        body: JSON.stringify({ password: pass || null }),
        cache: "no-store",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as unknown;
        if (response.status === 401) {
          setState({ status: "password", details, error: pass ? "That password did not open this capture." : null, busy: false });
          return;
        }
        setState({ status: "error", kind: shareFailureKind(result) });
        return;
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("invalid shared image");
      setState({ status: "ready", details, imageUrl: URL.createObjectURL(blob) });
    } catch {
      setState({ status: "error", kind: "unavailable" });
    } finally {
      imageRequest.current = false;
    }
  }, [setState]);

  useEffect(() => {
    if (previewMode) return;
    const token = shareLinkFromFragment(window.location.hash);
    if (!token) {
      const timeout = window.setTimeout(() => setState({ status: "error", kind: "not_found" }), 0);
      return () => window.clearTimeout(timeout);
    }
    let live = true;
    void fetch("/api/share/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-capso-share-token": token },
      body: "{}",
      cache: "no-store",
    }).then(async (response) => {
      const result = await response.json().catch(() => null) as unknown;
      if (!live) return;
      const details = shareInspectResult(result);
      if (!response.ok || !details) {
        setState({ status: "error", kind: shareFailureKind(result) });
      } else if (details.requiresPassword) {
        setState({ status: "password", details, error: null, busy: false });
      } else if (details.oneTime) {
        setState({ status: "one_time", details });
      } else {
        void loadImage(token, details);
      }
    }).catch(() => {
      if (live) setState({ status: "error", kind: "unavailable" });
    });
    return () => { live = false; };
  }, [loadImage, previewMode]);

  useEffect(() => {
    return () => {
      if (state.status === "ready") URL.revokeObjectURL(state.imageUrl);
    };
  }, [state]);

  const token = typeof window === "undefined" ? null : shareLinkFromFragment(window.location.hash);

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-8 text-foreground" data-share-receiver>
      <CapsoMarkDefs />
      <section className="w-full max-w-5xl overflow-hidden rounded-[28px] border border-line bg-surface shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4 sm:px-7">
          <CapsoMark size={34} fill="full" label="Capso" />
          <div>
            <p className="text-sm font-semibold tracking-tight">Private Capso capture</p>
            <p className="text-xs text-muted">Only the image is shared. Library metadata stays private.</p>
          </div>
          <LockKey size={18} className="ml-auto text-accent" aria-hidden="true" />
        </header>

        {receiverState.status === "loading" && (
          <div
            className="grid min-h-[420px] place-items-center p-8 text-center"
            role="status"
            aria-live="polite"
            aria-label="Opening private capture"
          >
            <div>
              <SpinnerGap size={28} className="mx-auto animate-spin text-accent" />
              <p className="mt-3 text-sm font-semibold">Opening the private capture…</p>
              <p className="mt-1 text-xs text-muted">The link is being checked before any pixels load.</p>
            </div>
          </div>
        )}

        {receiverState.status === "password" && (
          <form
            className="mx-auto grid min-h-[420px] max-w-sm content-center p-8"
            aria-busy={receiverState.busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (token && !receiverState.busy) void loadImage(token, receiverState.details, password);
            }}
          >
            <LockKey size={30} className="text-accent" weight="fill" />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">Password protected</h1>
            <p className="mt-2 text-sm leading-6 text-muted">Enter the password the sender gave you. Capso does not include it in the link.</p>
            <label htmlFor="share-password" className="mt-6 text-xs font-semibold">Password</label>
            <input
              id="share-password"
              type="password"
              autoComplete="off"
              autoFocus
              required
              minLength={6}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              disabled={receiverState.busy}
              className="mt-2 min-h-11 rounded-xl border border-line bg-background px-3 text-sm outline-none focus:border-accent"
            />
            {receiverState.error && <p role="alert" className="mt-2 text-xs text-danger">{receiverState.error}</p>}
            <button type="submit" disabled={receiverState.busy} className="mt-4 min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-50">
              {receiverState.busy ? "Opening…" : "Open capture"}
            </button>
          </form>
        )}

        {receiverState.status === "one_time" && (
          <div className="mx-auto grid min-h-[420px] max-w-md content-center p-8 text-center">
            <Eye size={32} className="mx-auto text-accent" weight="fill" />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">One-time capture</h1>
            <p className="mt-2 text-sm leading-6 text-muted">It becomes unavailable as soon as the image is delivered. Open it only when you are ready.</p>
            <button
              type="button"
              autoFocus
              onClick={() => token && void loadImage(token, receiverState.details)}
              className="mx-auto mt-6 min-h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-accent-ink"
            >Open once</button>
          </div>
        )}

        {receiverState.status === "ready" && (
          <div className="bg-background p-3 sm:p-5">
            {/* eslint-disable-next-line @next/next/no-img-element -- private object URL */}
            <img src={receiverState.imageUrl} alt="Shared Capso capture" className="mx-auto max-h-[78vh] max-w-full rounded-xl border border-line object-contain" />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5"><CheckCircle size={15} weight="fill" className="text-accent" /> Private image loaded</span>
              <a href={receiverState.imageUrl} download="capso-shared-capture" className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-semibold text-foreground">Download image</a>
            </div>
          </div>
        )}

        {receiverState.status === "error" && (
          <div className="mx-auto grid min-h-[420px] max-w-md content-center p-8 text-center">
            <LockKey size={30} className="mx-auto text-muted" />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">Private capture unavailable</h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              {receiverState.kind === "unavailable" ? "Capso could not check this link right now. Try again later." : shareStatusCopy(receiverState.kind)}
            </p>
            {receiverState.kind === "unavailable" && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mx-auto mt-6 min-h-11 rounded-xl border border-line px-5 text-sm font-semibold"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
