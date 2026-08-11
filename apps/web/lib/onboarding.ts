/**
 * Where a new user is in first run, as one derived value.
 *
 * Split out as a pure function because the bug this exists to fix was a
 * *predicate* bug, not a rendering bug. `app/page.tsx` gated its welcome on
 * `screenshots.length === 0 && threads.length === 0`, which is false the moment
 * a role creates projects — so the one screen written to greet a new user was
 * unreachable for every user who picked a role, which is nearly all of them.
 * A predicate that wrong deserves a test, and `lib/**\/*.check.ts` under
 * `node --test` is the only thing in this app that can hold one.
 */

export type Setup = "template" | "samples" | "empty";

export type Stage =
  /** No record of a first run at all — show the role picker. */
  | "pick_role"
  /** Set up, nothing captured yet, nothing on screen — the full front door. */
  | "first_capture"
  /** Set up, nothing captured yet, but samples are on screen — one quiet line. */
  | "nudge"
  /** Has captured, or the library predates the flags. Never onboard again. */
  | "done";

/**
 * Seeded fixtures are furniture, not achievements. Counting them as captures
 * would mark onboarding complete for a user who has never captured anything,
 * which is the failure mode the nudge exists to catch.
 */
export function isOwnCapture(s: { source: string }): boolean {
  return s.source !== "seed";
}

export function onboardingStage(input: {
  setup: Setup | null;
  firstCaptureDone: boolean;
  ownCaptures: number;
  libraryNotEmpty: boolean;
}): Stage {
  const { setup, firstCaptureDone, ownCaptures, libraryNotEmpty } = input;

  if (setup === null) {
    // Mirrors the back-compat rule in store/index.ts: a library that predates
    // the flag is set up by definition. Never interrogate an existing
    // collection — this is also the signed-in-on-a-new-browser case, where the
    // rows are all remote and localStorage is empty.
    return libraryNotEmpty ? "done" : "pick_role";
  }

  // One-way latch. A user who captures and then deletes everything is finished
  // with onboarding forever; re-showing the front door would read as the app
  // forgetting them.
  if (firstCaptureDone || ownCaptures > 0) return "done";

  // Samples on screen means the page is not empty, so the full-page welcome
  // would have nowhere to go. One line above the tray instead.
  if (setup === "samples") return "nudge";

  return "first_capture";
}
