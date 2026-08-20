/**
 * Mac first run, as a pure function over state the app already knows.
 *
 * `12_MAC_APP_PLAN.md` specified this flow — welcome, permission walkthrough,
 * optional login item, first capture — and it was never built: a grep for
 * `first_run|onboard` across apps/mac returned nothing. What *was* built is every
 * control it needs, as settings UI in App.tsx. So this file adds no capability;
 * it sequences what exists, and deliberately reuses App.tsx's existing `invoke`
 * calls rather than re-implementing permission logic, which is how the palette
 * drifted into six hand-copies before gen-tokens.mjs existed.
 *
 * Pure, and tested, for the same reason `lib/onboarding.ts` is on the web side:
 * the interesting part is a predicate, and `*.check.ts` under `node --test` is
 * the only thing in this app that can hold one.
 */

export type StepId = "permission" | "hotkey" | "login" | "library" | "capture";

export type StepState = "done" | "current" | "todo" | "skipped";

export type Step = {
  id: StepId;
  title: string;
  /** One line. Doc 15's microcopy budget: if it needs two, it needs a redesign. */
  detail: string;
  state: StepState;
  /** Optional steps never block completion — they are offers, not requirements. */
  optional: boolean;
};

export type FirstRunInput = {
  screenRecording: "granted" | "required";
  /** `disabled` is a real answer, not an unfinished one — see `optional`. */
  launchAtLogin: "enabled" | "disabled" | string;
  /** A hotkey always has a default, so this is "has the user seen it", not "is it set". */
  hotkeyConfirmed: boolean;
  /** A configured build may connect; an unconfigured build must say why it cannot. */
  cloudConfigured: boolean;
  /** Both answers are valid, but silence is not an answer. */
  libraryChoice: "connected" | "local_only" | "undecided";
  hasCaptured: boolean;
};

const ORDER: Array<{ id: StepId; title: string; detail: string; optional: boolean }> = [
  {
    id: "permission",
    title: "Allow screen recording",
    detail: "macOS needs this before Capso can take a screenshot.",
    optional: false,
  },
  {
    id: "hotkey",
    title: "Confirm your capture shortcut",
    detail: "⌃⇧C by default. Change it if something else already uses it.",
    optional: false,
  },
  {
    id: "login",
    title: "Start Capso at login",
    detail: "Optional. Capso lives in the menu bar and opens no window.",
    optional: true,
  },
  {
    id: "library",
    title: "Connect your Capso library",
    detail: "Use one private library across this Mac, the web, and your Chrome extension.",
    optional: false,
  },
  {
    id: "capture",
    title: "Take your first capture",
    detail: "Press the shortcut. The capture appears and files itself.",
    optional: false,
  },
];

function isSatisfied(id: StepId, input: FirstRunInput): boolean {
  switch (id) {
    case "permission":
      return input.screenRecording === "granted";
    case "hotkey":
      return input.hotkeyConfirmed;
    case "login":
      // Either answer settles it. Treating `disabled` as unfinished would leave a
      // permanent unticked row for a user who deliberately said no.
      return input.launchAtLogin === "enabled" || input.launchAtLogin === "disabled";
    case "library":
      return input.libraryChoice !== "undecided";
    case "capture":
      return input.hasCaptured;
  }
}

function detailFor(step: (typeof ORDER)[number], input: FirstRunInput) {
  if (step.id !== "library") return step.detail;
  if (input.libraryChoice === "connected") {
    return "Connected. New captures can sync to your private Capso library.";
  }
  if (input.libraryChoice === "local_only") {
    return "Local only. You can connect later in Account Settings without moving your originals.";
  }
  if (!input.cloudConfigured) {
    return "Cloud sync is unavailable in this build. Captures still stay private on this Mac.";
  }
  return step.detail;
}

/**
 * Steps in order, with exactly one `current` — the first unsatisfied step.
 * Everything after it is `todo`, so the screen never presents two things to do.
 */
export function firstRunSteps(input: FirstRunInput): Step[] {
  let currentTaken = false;
  return ORDER.map((step) => {
    const done = isSatisfied(step.id, input);
    let state: StepState;
    if (done) {
      state = "done";
    } else if (!currentTaken) {
      state = "current";
      currentTaken = true;
    } else {
      state = "todo";
    }
    return { ...step, detail: detailFor(step, input), state };
  });
}

/**
 * First run is over when every REQUIRED step is satisfied. `login` is excluded on
 * purpose: an optional step that can block completion is not optional.
 */
export function firstRunComplete(input: FirstRunInput): boolean {
  return ORDER.filter((s) => !s.optional).every((s) => isSatisfied(s.id, input));
}

/**
 * What the primary button should do right now. Returning the step id rather than
 * a handler keeps this testable and leaves the `invoke` calls in the component,
 * where App.tsx's versions already live.
 */
export function firstRunAction(input: FirstRunInput): StepId | null {
  return firstRunSteps(input).find((s) => s.state === "current")?.id ?? null;
}
