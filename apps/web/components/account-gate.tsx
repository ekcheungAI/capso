"use client";

import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, CheckCircle, SpinnerGap } from "@phosphor-icons/react";
import { CapsoMark, CapsoMarkDefs } from "@/components/mark.generated";
import {
  localLibraryEntry,
  localLibrarySafetyVerb,
  loadPermanentAccount,
  permanentAccountFromSession,
  requestPermanentAccountLink,
  type PermanentAccount,
} from "@/lib/supabase/account";
import { isConfigured, supabase } from "@/lib/supabase/client";
import { backendPreference, resetBackend, setBackendPreference, subscribeBackendPreference } from "@/lib/store/backend";
import { localLibrarySize } from "@/lib/store/import-local";
import { plural } from "@/lib/plural";

type AccountContextValue =
  | { mode: "local"; userId: null; email: null; signOut: null; openAccount: (() => void) | null }
  | { mode: "signed_in"; userId: string; email: string; signOut: () => Promise<void>; openAccount: null };

const AccountContext = createContext<AccountContextValue | null>(null);
const subscribeStaticPreview = () => () => undefined;

type GateState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | PermanentAccount;

/**
 * A configured Capso library is private and cannot mount until its permanent
 * email identity is known. Unconfigured developer builds keep their existing
 * local-only behaviour so a fresh clone remains usable without cloud secrets.
 */
export function AccountGate({ children }: { children: React.ReactNode }) {
  const configured = isConfigured();
  const [state, setState] = useState<GateState>(configured ? { status: "loading" } : { status: "signed_out" });
  const [localCount, setLocalCount] = useState(0);
  const devicePreview = useSyncExternalStore(
    subscribeStaticPreview,
    () => process.env.NODE_ENV !== "production" &&
      new URLSearchParams(window.location.search).get("preview") === "devices",
    () => false,
  );
  // The local-only choice is a durable ownership decision, not a dismissal of
  // the current modal. The server snapshot stays account-first; hydration then
  // reads this browser's explicit choice without an effect-driven state copy.
  const localOnly = useSyncExternalStore(
    subscribeBackendPreference,
    () => backendPreference() === "local",
    () => false,
  );

  const refresh = useCallback(async () => {
    if (!configured) return;
    setState({ status: "loading" });
    try {
      const [account, count] = await Promise.all([
        loadPermanentAccount(supabase().auth),
        localLibrarySize().catch(() => 0),
      ]);
      setLocalCount(count);
      setState(account);
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Capso could not check your account.",
      });
    }
  }, [configured]);

  useEffect(() => {
    if (!configured) return;
    let active = true;
    const sb = supabase();

    void Promise.all([
      loadPermanentAccount(sb.auth),
      localLibrarySize().catch(() => 0),
    ])
      .then(([account, count]) => {
        if (!active) return;
        setLocalCount(count);
        setState(account);
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Capso could not check your account.",
          });
        }
      });

    // Keep this callback synchronous. Auth events can fire while Supabase holds
    // its auth lock; async work inside the callback can deadlock later auth calls.
    const { data } = sb.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      const account = permanentAccountFromSession(session);
      if (account.status === "signed_in") {
        setBackendPreference("auto");
      }
      resetBackend();
      setState(account);
      if (session?.user.is_anonymous) void sb.auth.signOut({ scope: "local" });
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [configured]);

  if (devicePreview) {
    return (
      <AccountContext.Provider value={{
        mode: "signed_in",
        userId: "44444444-4444-4444-8444-444444444444",
        email: "elvin@example.com",
        signOut: async () => undefined,
        openAccount: null,
      }}>
        {children}
      </AccountContext.Provider>
    );
  }

  if (!configured) {
    return (
      <AccountContext.Provider value={{ mode: "local", userId: null, email: null, signOut: null, openAccount: null }}>
        {children}
      </AccountContext.Provider>
    );
  }

  if (localOnly) {
    return (
      <AccountContext.Provider
        value={{
          mode: "local",
          userId: null,
          email: null,
          signOut: null,
          openAccount: () => {
            setBackendPreference("auto");
            setState({ status: "signed_out" });
          },
        }}
      >
        {children}
      </AccountContext.Provider>
    );
  }

  if (state.status === "loading") return <AccountLoading />;
  if (state.status === "error") return <AccountError message={state.message} retry={refresh} />;
  if (state.status === "signed_out") {
    return (
      <EmailSignIn
        localCount={localCount}
        continueLocal={() => {
          setBackendPreference("local");
        }}
      />
    );
  }

  const signOut = async () => {
    resetBackend();
    const { error } = await supabase().auth.signOut({ scope: "local" });
    if (error) throw new Error(error.message);
    setState({ status: "signed_out" });
  };

  return (
    <AccountContext.Provider value={{ mode: "signed_in", userId: state.userId, email: state.email, signOut, openAccount: null }}>
      {/* A cross-tab account replacement must throw away the previous user's
          React store as well as the cached backend, or old rows remain visible
          and can be edited through the new account. */}
      <Fragment key={state.userId}>{children}</Fragment>
    </AccountContext.Provider>
  );
}

export function useAccount(): AccountContextValue {
  const account = useContext(AccountContext);
  if (!account) throw new Error("useAccount must be used inside AccountGate");
  return account;
}

function AccountFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-5 py-10 text-foreground">
      <CapsoMarkDefs />
      <section className="w-full max-w-[430px] rounded-[28px] border border-line bg-surface p-6 shadow-2xl sm:p-8">
        <div className="mb-7 flex items-center gap-3">
          <CapsoMark size={38} fill="full" label="Capso" />
          <div>
            <p className="text-sm font-semibold tracking-tight">Capso</p>
            <p className="text-xs text-muted">Your private screenshot memory</p>
          </div>
        </div>
        {children}
      </section>
    </main>
  );
}

function AccountLoading() {
  return (
    <AccountFrame>
      <div role="status" aria-live="polite" className="flex items-center gap-3 py-8 text-sm text-muted">
        <SpinnerGap size={20} className="animate-spin" /> Opening your library…
      </div>
    </AccountFrame>
  );
}

function AccountError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <AccountFrame>
      <h1 className="text-xl font-semibold tracking-tight">We couldn’t check your account</h1>
      <p className="mt-3 text-sm leading-6 text-muted">{message}</p>
      <button type="button" onClick={retry} className="mt-6 min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink">
        Try again
      </button>
    </AccountFrame>
  );
}

function EmailSignIn({ localCount, continueLocal }: { localCount: number; continueLocal: () => void }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRequest = useRef(false);
  const localEntry = localLibraryEntry(localCount);

  if (sent) {
    return (
      <AccountFrame>
        <CheckCircle size={32} weight="fill" className="text-accent" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          We sent a secure sign-in link to <strong className="font-semibold text-foreground">{email.trim()}</strong>.
          Open it on this Mac to continue.
        </p>
        <button type="button" onClick={() => { setSent(false); setError(null); }} className="mt-6 flex min-h-11 items-center text-sm font-semibold text-accent">
          Use a different email
        </button>
      </AccountFrame>
    );
  }

  return (
    <AccountFrame>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">One account, everywhere</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Open your Capso library</h1>
      <p className="mt-3 text-sm leading-6 text-muted">
        Use the same email here and in the Capso Mac app. No password is required.
      </p>

      {localEntry.canContinueLocal && (
        <div className="mt-5 rounded-2xl border border-line bg-background px-4 py-3.5">
          <p className="text-sm font-semibold text-foreground">
            {localEntry.count > 0
              ? `${plural(localEntry.count, "capture")} already ${localEntry.count === 1 ? "lives" : "live"} in this browser`
              : "Prefer to keep Capso local?"}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted">
            {localEntry.count > 0
              ? "Keep using that local library now, or sign in and copy it into your private account from Settings. Nothing is deleted automatically."
              : "Use a private library in this browser without creating an account. You can sign in and copy it later."}
          </p>
          <button type="button" onClick={continueLocal} className="mt-3 flex min-h-11 items-center text-sm font-semibold text-accent">
            {localEntry.count > 0 ? "Continue with my local library" : "Use Capso locally"}
          </button>
        </div>
      )}

          <form
            className="mt-6"
            aria-busy={sending}
            onSubmit={async (event) => {
              event.preventDefault();
              if (emailRequest.current) return;
              emailRequest.current = true;
              setSending(true);
          setError(null);
          try {
            await requestPermanentAccountLink(supabase().auth, email, window.location.origin);
            setSent(true);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Capso could not send the sign-in link.");
              } finally {
                setSending(false);
                emailRequest.current = false;
          }
        }}
      >
        <label htmlFor="capso-account-email" className="text-xs font-semibold">Email</label>
        <div className="mt-2 flex gap-2">
          <input
            id="capso-account-email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="min-w-0 flex-1 rounded-xl border border-line bg-background px-3.5 py-3 text-sm outline-none transition focus:border-accent"
          />
          <button
              type="submit"
              disabled={sending}
              aria-label={sending ? "Sending sign-in link" : "Send sign-in link"}
            className="grid w-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink disabled:opacity-60"
          >
            {sending ? <SpinnerGap size={18} className="animate-spin" /> : <ArrowRight size={18} weight="bold" />}
          </button>
        </div>
        {error && <p role="alert" className="mt-2 text-xs leading-5 text-danger">{error}</p>}
      </form>

      <div className="mt-6 rounded-2xl bg-background px-4 py-3 text-xs leading-5 text-muted">
        {localEntry.canCopyAfterSignIn
          ? `Your ${plural(localEntry.count, "local capture")} ${localLibrarySafetyVerb(localEntry.count)} safe. After signing in, choose “Copy to account” in Settings when you are ready.`
          : "This opens a private library shared by the web and Mac apps."}
      </div>
    </AccountFrame>
  );
}
