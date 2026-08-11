export type PermanentAccount =
  | { status: "signed_out" }
  | { status: "signed_in"; userId: string; email: string };

export type LocalLibraryEntry = {
  count: number;
  canContinueLocal: boolean;
  canCopyAfterSignIn: boolean;
};

/** Keep account entry honest about captures that already exist in this browser. */
export function localLibraryEntry(count: number): LocalLibraryEntry {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const hasLocalLibrary = safeCount > 0;
  return {
    count: safeCount,
    canContinueLocal: true,
    canCopyAfterSignIn: hasLocalLibrary,
  };
}

export function localLibrarySafetyVerb(count: number): "remains" | "remain" {
  return count === 1 ? "remains" : "remain";
}

type UserLike = {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
};

type SessionLike = { user: UserLike } | null;

type ResultError = { message?: string } | null;

type SessionAuth = {
  getSession(): Promise<{
    data: { session: SessionLike };
    error: ResultError;
  }>;
  signOut(options?: { scope?: "global" | "local" | "others" }): Promise<{
    error: ResultError;
  }>;
};

type OtpAuth = {
  signInWithOtp(credentials: {
    email: string;
    options: {
      shouldCreateUser: boolean;
      emailRedirectTo: string;
    };
  }): Promise<{ error: ResultError }>;
};

function failure(prefix: string, error: ResultError): Error {
  const detail = error?.message?.trim();
  return new Error(detail ? `${prefix} ${detail}` : prefix);
}

/** Convert only durable email identities into Capso library owners. */
export function permanentAccountFromSession(session: SessionLike): PermanentAccount {
  const user = session?.user;
  const email = user?.email?.trim();
  if (!user || user.is_anonymous || !email) return { status: "signed_out" };
  return { status: "signed_in", userId: user.id, email };
}

/**
 * Read the browser session and discard any legacy anonymous identity locally.
 *
 * The owner chose a fresh authenticated library. Local-scope sign-out preserves
 * every remote row and other signed-in device while ensuring an old anonymous
 * token can never become the apparent owner of the new account library.
 */
export async function loadPermanentAccount(auth: SessionAuth): Promise<PermanentAccount> {
  const { data, error } = await auth.getSession();
  if (error) throw failure("Capso could not check your account.", error);

  const account = permanentAccountFromSession(data.session);
  if (data.session && account.status === "signed_out") {
    const { error: signOutError } = await auth.signOut({ scope: "local" });
    if (signOutError) throw failure("Capso could not clear the old browser session.", signOutError);
  }
  return account;
}

/** Send a magic link that creates (or reopens) the permanent email account. */
export async function requestPermanentAccountLink(
  auth: OtpAuth,
  email: string,
  origin: string,
): Promise<void> {
  const normalized = email.trim();
  if (!normalized) throw new Error("Enter the email you want to use for Capso.");

  const { error } = await auth.signInWithOtp({
    email: normalized,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: origin,
    },
  });
  if (error) throw failure("Capso could not send the sign-in link.", error);
}

/** Store code must never turn a signed-out state into an empty remote library. */
export function requirePermanentUserId(account: PermanentAccount): string {
  if (account.status !== "signed_in") {
    throw new Error("Sign in to open your Capso library.");
  }
  return account.userId;
}
