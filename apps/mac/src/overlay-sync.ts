export type CaptureSyncStatus = {
  status:
    | "local"
    | "ready"
    | "waiting"
    | "syncing"
    | "retrying"
    | "needs_attention"
    | "synced"
    | "unavailable";
};

export type OverlaySyncPresentation = {
  copy: string;
  detail: string;
  tone: "neutral" | "ready" | "warning";
};

export function overlaySyncPresentation(
  status: CaptureSyncStatus,
): OverlaySyncPresentation {
  switch (status.status) {
    case "local":
      return {
        copy: "Saved on this Mac",
        detail: "The original is safely stored on this Mac.",
        tone: "neutral",
      };
    case "ready":
      return {
        copy: "Ready to sync",
        detail: "Sync starts after Quick Access closes.",
        tone: "neutral",
      };
    case "waiting":
      return {
        copy: "Waiting to sync",
        detail: "The original remains safely stored on this Mac.",
        tone: "neutral",
      };
    case "syncing":
      return {
        copy: "Syncing now",
        detail: "Uploading this capture to your private web library.",
        tone: "neutral",
      };
    case "retrying":
      return {
        copy: "Will retry sync",
        detail: "The original is safe here and Capso will retry automatically.",
        tone: "neutral",
      };
    case "needs_attention":
      return {
        copy: "Sync needs attention",
        detail: "The original is safe here. Open Capso Settings for recovery.",
        tone: "warning",
      };
    case "synced":
      return {
        copy: "Synced to library",
        detail: "This capture is available in your private web library.",
        tone: "ready",
      };
    case "unavailable":
      return {
        copy: "Saved on this Mac",
        detail: "Sync status is unavailable. The original remains safely stored here.",
        tone: "warning",
      };
  }
}
