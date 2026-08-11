export type VerifiedBearer = { ok: true; token: string; userId: string };
export type BearerFailure = {
  ok: false;
  status: 401 | 503;
  error: "unauthorized" | "authentication unavailable";
};

export type BearerResult = VerifiedBearer | BearerFailure;
export type TokenVerifier = (token: string) => Promise<{ id: string } | null>;

/**
 * Parse a bearer credential and resolve it to one server-verified owner.
 * Origin, request-body user ids, and browser state are deliberately ignored.
 */
export async function verifyBearer(
  authorization: string | null,
  verify: TokenVerifier,
): Promise<BearerResult> {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
  if (!match?.[1]) return { ok: false, status: 401, error: "unauthorized" };

  try {
    const user = await verify(match[1]);
    if (!user?.id) return { ok: false, status: 401, error: "unauthorized" };
    return { ok: true, token: match[1], userId: user.id };
  } catch {
    return { ok: false, status: 503, error: "authentication unavailable" };
  }
}

/** Attach the current session without losing existing request headers. */
export function bearerHeaders(initial: HeadersInit | undefined, token: string): Headers {
  const headers = new Headers(initial);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

/** Compare the browser origin with the public request host, including proxies. */
export function isSameOrigin(request: Request): boolean {
  const rawOrigin = request.headers.get("origin");
  const publicHost = (
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host
  )
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (!rawOrigin || !publicHost) return false;

  try {
    const origin = new URL(rawOrigin);
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwardedProtocol ? `${forwardedProtocol.replace(/:$/, "")}:` : new URL(request.url).protocol;
    return origin.host.toLowerCase() === publicHost && origin.protocol === protocol;
  } catch {
    return false;
  }
}
