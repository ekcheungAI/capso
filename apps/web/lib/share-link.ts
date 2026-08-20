export const SHARE_TOKEN = /^sh_[A-Za-z0-9_-]{43}$/;

export const SHARE_EXPIRIES = [
  { seconds: 3_600, label: "1 hour" },
  { seconds: 86_400, label: "1 day" },
  { seconds: 604_800, label: "7 days" },
  { seconds: 2_592_000, label: "30 days" },
] as const;

export type ShareTerminalStatus = "expired" | "revoked" | "consumed" | "not_found";
export type ShareFailureStatus = ShareTerminalStatus | "rate_limited";

export type ShareInspectResult = {
  status: "ready";
  requiresPassword: boolean;
  expiresAt: string;
  oneTime: boolean;
};

export type ShareLink = {
  id: string;
  createdAt: string;
  expiresAt: string;
  hasPassword: boolean;
  oneTime: boolean;
  consumedAt: string | null;
  revokedAt: string | null;
  viewCount: number;
};

export function shareLinkFromFragment(fragment: string): string | null {
  const token = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return SHARE_TOKEN.test(token) ? token : null;
}

export function shareFailureKind(value: unknown): ShareFailureStatus | "unavailable" {
  if (!value || typeof value !== "object") return "unavailable";
  const status = (value as { status?: unknown }).status;
  return status === "expired" || status === "revoked" || status === "consumed" || status === "not_found" || status === "rate_limited"
    ? status
    : "unavailable";
}

export function shareInspectResult(value: unknown): ShareInspectResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ShareInspectResult>;
  if (
    candidate.status !== "ready" ||
    typeof candidate.requiresPassword !== "boolean" ||
    typeof candidate.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    typeof candidate.oneTime !== "boolean"
  ) return null;
  return {
    status: "ready",
    requiresPassword: candidate.requiresPassword,
    expiresAt: candidate.expiresAt,
    oneTime: candidate.oneTime,
  };
}

export function shareStatusCopy(status: ShareFailureStatus): string {
  switch (status) {
    case "expired": return "This private link has expired.";
    case "revoked": return "This private link is no longer available.";
    case "consumed": return "This one-time link has already been opened.";
    case "not_found": return "This private link is invalid or unavailable.";
    case "rate_limited": return "Too many attempts. Wait a minute before trying this private link again.";
  }
}

export function shareLinkState(link: ShareLink, now = Date.now()): "active" | ShareTerminalStatus {
  if (link.revokedAt) return "revoked";
  if (link.oneTime && link.consumedAt) return "consumed";
  if (!Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= now) return "expired";
  return "active";
}
