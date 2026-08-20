import { AUTO_ASSIGN_MIN, SUGGEST_MIN } from "@capso/shared/classification";
import type { Status } from "./store/types.ts";

export type InboxReviewPresentation = {
  statusLabel: string | null;
  reason: string;
  showConfidence: boolean;
};

export function inboxReviewPresentation(
  status: Status,
  simulated: boolean,
  suggestedThreadId: string | null,
  confidence: number,
): InboxReviewPresentation {
  if (status === "processing") {
    return {
      statusLabel: "Still reading",
      reason: "Capso has not made a project decision yet.",
      showConfidence: false,
    };
  }
  if (status === "unprocessed") {
    return {
      statusLabel: "Couldn’t be read · Try again",
      reason: "Classification did not complete, so nothing was filed automatically.",
      showConfidence: false,
    };
  }
  if (simulated) {
    return {
      statusLabel: "Sample data",
      reason: "Demo metadata is never filed automatically.",
      showConfidence: false,
    };
  }

  const hasConfidence = Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
  if (!suggestedThreadId) {
    return {
      statusLabel: null,
      reason: "No project matched this capture, so Capso left it unfiled.",
      showConfidence: hasConfidence,
    };
  }
  if (!hasConfidence) {
    return {
      statusLabel: null,
      reason: "A project was suggested, but its confidence is unavailable.",
      showConfidence: false,
    };
  }

  if (confidence >= AUTO_ASSIGN_MIN) {
    return {
      statusLabel: null,
      reason: "A project was suggested, but this capture is currently unfiled.",
      showConfidence: true,
    };
  }

  const percent = Math.round(confidence * 100);
  if (confidence >= SUGGEST_MIN) {
    return {
      statusLabel: null,
      reason: `The project match is ${percent}%, below the ${AUTO_ASSIGN_MIN * 100}% automatic filing threshold.`,
      showConfidence: true,
    };
  }

  return {
    statusLabel: null,
    reason: `The project match is ${percent}%, so Capso left it for you.`,
    showConfidence: true,
  };
}
