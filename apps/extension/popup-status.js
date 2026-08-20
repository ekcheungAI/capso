function ago(iso, nowMs) {
  const then = Date.parse(iso ?? "");
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function deliveryStatusCopy(status, nowMs = Date.now()) {
  if (status.pending > 0) {
    const oldest = ago(status.oldestAt, nowMs);
    const waiting = `${status.pending} waiting${oldest ? ` · oldest ${oldest}` : ""}`;
    return status.lastError ? `${waiting} — ${status.lastError}` : waiting;
  }
  if (status.lastResult) {
    const when = ago(status.lastResult.at, nowMs);
    return `${status.lastResult.message}${when ? ` · ${when}` : ""}`;
  }
  return "No captures yet.";
}
