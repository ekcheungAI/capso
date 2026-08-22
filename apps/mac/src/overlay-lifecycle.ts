export type OverlayLifecycleCapture = {
  path: string;
  presentationId: number;
  surfaceGeneration: number;
  temporarilyHidden: boolean;
};

export type OverlayLifecycleState = {
  surfaceGeneration: number;
  capture: OverlayLifecycleCapture | null;
};

export type OverlayLifecycleEvent =
  | { kind: "capture"; capture: OverlayLifecycleCapture }
  | {
      kind: "bootstrap";
      surfaceGeneration: number;
      capture: OverlayLifecycleCapture | null;
    }
  | {
      kind: "hidden" | "restored" | "dismissed";
      path: string;
      presentationId: number;
      surfaceGeneration: number;
    };

export type OverlayLifecycleResult = {
  decision: "apply" | "ignore" | "resync";
  state: OverlayLifecycleState;
};

function eventGeneration(event: OverlayLifecycleEvent) {
  return event.kind === "capture"
    ? event.capture.surfaceGeneration
    : event.surfaceGeneration;
}

/**
 * Orders native lifecycle events before React, image decode, or frame timing
 * participate. Native surface generations are monotonic, so a delayed event
 * cannot revive or conceal a newer preview. A newer hide/restore for an
 * unknown identity requests one atomic native snapshot instead of guessing.
 */
export function reduceOverlayLifecycle(
  state: OverlayLifecycleState,
  event: OverlayLifecycleEvent,
): OverlayLifecycleResult {
  const surfaceGeneration = eventGeneration(event);
  if (surfaceGeneration <= state.surfaceGeneration) {
    return { decision: "ignore", state };
  }

  if (event.kind === "capture") {
    return {
      decision: "apply",
      state: { surfaceGeneration, capture: event.capture },
    };
  }

  if (event.kind === "bootstrap") {
    return {
      decision: "apply",
      state: {
        surfaceGeneration,
        capture: event.capture
          ? { ...event.capture, surfaceGeneration }
          : null,
      },
    };
  }

  if (event.kind === "dismissed") {
    return {
      decision: "apply",
      state: { surfaceGeneration, capture: null },
    };
  }

  const current = state.capture;
  if (
    !current ||
    current.path !== event.path ||
    current.presentationId !== event.presentationId
  ) {
    return {
      decision: "resync",
      state: { surfaceGeneration, capture: null },
    };
  }

  return {
    decision: "apply",
    state: {
      surfaceGeneration,
      capture: {
        ...current,
        surfaceGeneration,
        temporarilyHidden: event.kind === "hidden",
      },
    },
  };
}
