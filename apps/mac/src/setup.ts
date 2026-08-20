export type AccountStatus = "signed_in" | "signed_out";

export type CloudAccountPresentation = {
  status: string;
  message: string;
  showEmailForm: boolean;
};

export type SyncQueueSummary = {
  remotePending: number;
  pending: number;
  uploading: number;
  retrying: number;
  failed: number;
  uploaded: number;
  total: number;
};

export type SyncRuntimeStatus = {
  summary: SyncQueueSummary;
  annotationSummary: {
    pending: number;
    uploading: number;
    failed: number;
    conflicts: number;
    synced: number;
    total: number;
  };
  warning: string | null;
  lastSuccessAtMs: number | null;
  reconnectRequired: boolean;
};

export type SyncPresentation = {
  status: string;
  title: string;
  message: string;
  tone: "ready" | "muted" | "attention";
  action: "retry" | "details" | "reconnect" | "history" | null;
};

export function cloudAccountPresentation(
  configured: boolean,
  accountStatus: AccountStatus,
): CloudAccountPresentation {
  if (!configured) {
    return {
      status: "Not enabled in this test build",
      message:
        "No email is needed. Captures stay private on this Mac while cloud sync is being connected.",
      showEmailForm: false,
    };
  }
  if (accountStatus === "signed_in") {
    return {
      status: "Connected",
      message: "This Mac is connected to your private Capso library.",
      showEmailForm: false,
    };
  }
  return {
    status: "Connect account",
    message:
      "Use the same email for Capso on the web and Mac so both libraries belong to one account.",
    showEmailForm: true,
  };
}

/**
 * One human sync vocabulary for the Account panel.
 *
 * Rust remains the sole owner of queue transitions. This function only turns
 * its durable snapshot into the states a person needs to make a decision; it
 * deliberately never guesses at connectivity from a failed HTTP message.
 */
export function syncPresentation(
  configured: boolean,
  accountStatus: AccountStatus,
  runtime: SyncRuntimeStatus,
  nowMs = Date.now(),
): SyncPresentation {
  if (!configured || accountStatus === "signed_out") {
    return {
      status: "Saved on this Mac",
      title: "Cloud library disconnected",
      message: "Your captures remain available here. Connect your account to sync them.",
      tone: "muted",
      action: null,
    };
  }

  const queued =
    runtime.summary.pending +
    runtime.summary.uploading +
    runtime.summary.retrying;
  const plural = (count: number) => (count === 1 ? "capture" : "captures");

  if (runtime.reconnectRequired) {
    const deviceDisconnected = runtime.warning?.toLowerCase().includes("this mac was disconnected") ?? false;
    return {
      status: deviceDisconnected ? "Reconnect this Mac" : "Reconnect account",
      title: deviceDisconnected ? "This Mac was disconnected" : "Your Capso session expired",
      message: deviceDisconnected
        ? "Your originals remain saved on this Mac. Reconnect the same account to connect this Mac again."
        : "Your originals remain saved on this Mac. Reconnect the same account to resume sync.",
      tone: "attention",
      action: "reconnect",
    };
  }

  if (runtime.warning !== null) {
    if (queued === 0 && runtime.summary.remotePending > 0) {
      return {
        status: "Needs attention",
        title: "Library download paused",
        message: "Your cloud library remains private and unchanged. Retry to make these captures available in History.",
        tone: "attention",
        action: "retry",
      };
    }
    return {
      status: "Needs attention",
      title: "Sync is temporarily unavailable",
      message: "Your originals remain saved on this Mac. Retry when you are ready.",
      tone: "attention",
      action: queued > 0 ? "retry" : "details",
    };
  }

  if (runtime.annotationSummary.conflicts > 0) {
    const count = runtime.annotationSummary.conflicts;
    return {
      status: "Conflict",
      title: `${count} editable ${count === 1 ? "project needs" : "projects need"} a choice`,
      message: "Another Mac saved a newer revision. Your local work is still safe; review it in History before choosing which version continues.",
      tone: "attention",
      action: "history",
    };
  }

  if (runtime.annotationSummary.failed > 0) {
    const count = runtime.annotationSummary.failed;
    return {
      status: "Needs attention",
      title: `${count} editable ${count === 1 ? "project could" : "projects could"} not sync`,
      message: "The editable files and pixels remain saved on this Mac. Review them in History.",
      tone: "attention",
      action: "history",
    };
  }

  if (runtime.summary.failed > 0) {
    const count = runtime.summary.failed;
    return {
      status: "Needs attention",
      title: `${count} ${plural(count)} could not sync`,
      message: "The originals remain saved on this Mac. Open diagnostics to report the issue.",
      tone: "attention",
      action: "details",
    };
  }

  if (queued > 0) {
    return {
      status: "Waiting to sync",
      title: `${queued} ${plural(queued)} saved here`,
      message: "Capso will keep retrying in the background. You can keep working.",
      tone: "attention",
      action: "retry",
    };
  }

  if (runtime.summary.remotePending > 0) {
    const count = runtime.summary.remotePending;
    return {
      status: "Downloading library",
      title: `${count} ${plural(count)} downloading to this Mac`,
      message: "Capso is making them available in History. You can keep working.",
      tone: "ready",
      action: null,
    };
  }


  const queuedProjects = runtime.annotationSummary.pending + runtime.annotationSummary.uploading;
  if (queuedProjects > 0) {
    return {
      status: "Waiting to sync",
      title: `${queuedProjects} editable ${queuedProjects === 1 ? "project" : "projects"} waiting`,
      message: "The project documents and protected originals remain saved here while Capso retries.",
      tone: "attention",
      action: "retry",
    };
  }

  return {
    status: "Up to date",
    title: "Your library is connected",
    message:
      runtime.summary.uploaded > 0
        ? runtime.lastSuccessAtMs !== null &&
          Number.isSafeInteger(runtime.lastSuccessAtMs) &&
          runtime.lastSuccessAtMs > 0
          ? `Last synced ${relativeSyncAge(runtime.lastSuccessAtMs, nowMs)}. All recent captures are in your private library.`
          : "All recent captures have synced to your private library."
        : "New captures will sync automatically.",
    tone: "ready",
    action: null,
  };
}

function relativeSyncAge(timestampMs: number, nowMs: number) {
  const elapsed = Math.max(0, nowMs - timestampMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "just now";
  if (elapsed < hour) {
    const minutes = Math.floor(elapsed / minute);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (elapsed < day) {
    const hours = Math.floor(elapsed / hour);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.min(30, Math.floor(elapsed / day));
  return days === 30 ? "30+ days ago" : `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function shortcutRecorderLabel(
  shortcut: string,
  recording: boolean,
) {
  return recording ? "Press keys…" : `Change ${shortcut}`;
}
