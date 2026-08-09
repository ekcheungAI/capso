export type NativeAuthHandoff =
  | { kind: "ready"; openUrl: string }
  | { kind: "invalid"; message: string };

const INVALID_HANDOFF: NativeAuthHandoff = {
  kind: "invalid",
  message: "This sign-in link is invalid or expired. Start again from the Capso app.",
};

function isOpaqueCode(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_048 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
  );
}

function isNativeState(value: string): boolean {
  return (
    value.length >= 43 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

/**
 * Convert only Supabase's one-time PKCE code plus Capso's own state into the
 * installed-app callback. Tokens, provider errors, duplicate fields and any
 * future/unknown parameters stay in the browser and cannot launch Capso.
 */
export function nativeAuthHandoff(search: URLSearchParams): NativeAuthHandoff {
  const entries = [...search.entries()];
  if (
    entries.length !== 2 ||
    search.getAll("code").length !== 1 ||
    search.getAll("state").length !== 1 ||
    entries.some(([key]) => key !== "code" && key !== "state")
  ) {
    return INVALID_HANDOFF;
  }

  const code = search.get("code") ?? "";
  const state = search.get("state") ?? "";
  if (!isOpaqueCode(code) || !isNativeState(state)) return INVALID_HANDOFF;

  const callback = new URL("capso://auth/callback");
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  return { kind: "ready", openUrl: callback.toString() };
}
