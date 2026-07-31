/**
 * Offline demo fixtures. Swapped for Supabase queries in P1–P4 —
 * shapes intentionally mirror 10_DATA_MODEL.md.
 */

export type Intent =
  | "design_inspiration"
  | "ux_bug"
  | "competitor"
  | "marketing_hook"
  | "content_idea"
  | "reference"
  | "other";

export type Screenshot = {
  id: string;
  title: string;
  summary: string;
  whySaved: string;
  ocrExcerpt: string;
  intent: Intent;
  threadId: string | null;
  suggestedThreadId?: string;
  confidence: number;
  capturedAt: string;
  aspect: "tall" | "wide" | "square";
  hue: number;
};

export type Thread = {
  id: string;
  name: string;
  screenshotCount: number;
};

export const INTENT_LABEL: Record<Intent, string> = {
  design_inspiration: "Design inspiration",
  ux_bug: "UX bug",
  competitor: "Competitor",
  marketing_hook: "Marketing hook",
  content_idea: "Content idea",
  reference: "Reference",
  other: "Other",
};

export const threads: Thread[] = [
  { id: "pricing-redesign", name: "Pricing page redesign", screenshotCount: 4 },
  { id: "onboarding-teardown", name: "Onboarding teardown", screenshotCount: 3 },
  { id: "capso-bugs", name: "Capso UI bugs", screenshotCount: 2 },
  { id: "q3-launch", name: "Q3 launch campaign", screenshotCount: 2 },
];

export const screenshots: Screenshot[] = [
  {
    id: "s1",
    title: "Linear — pricing, annual toggle",
    summary:
      "Three-tier pricing with an annual/monthly toggle that shows savings inline on the toggle itself.",
    whySaved: "The savings badge sits on the toggle, not under the price — worth stealing.",
    ocrExcerpt: "Free · Basic $8 /user /month · Business $14 · Save 20% annually",
    intent: "competitor",
    threadId: "pricing-redesign",
    confidence: 0.94,
    capturedAt: "2026-03-14T09:12:00Z",
    aspect: "wide",
    hue: 250,
  },
  {
    id: "s2",
    title: "Stripe — checkout empty state",
    summary: "Empty cart state using a single line of copy and one primary action.",
    whySaved: "Reference for our own empty states — one action, no illustration.",
    ocrExcerpt: "Nothing here yet. Add your first product to get started.",
    intent: "design_inspiration",
    threadId: "pricing-redesign",
    confidence: 0.88,
    capturedAt: "2026-03-16T14:40:00Z",
    aspect: "square",
    hue: 205,
  },
  {
    id: "s3",
    title: "Overlay chip overlaps traffic lights",
    summary:
      "The suggestion chip renders under the window controls at 1280px width on the second display.",
    whySaved: "Reproducible bug — only on the external monitor.",
    ocrExcerpt: "Project = Pricing page redesign   Confirm   Ignore",
    intent: "ux_bug",
    threadId: "capso-bugs",
    confidence: 0.91,
    capturedAt: "2026-07-28T11:02:00Z",
    aspect: "wide",
    hue: 12,
  },
  {
    id: "s4",
    title: "Notion — AI accept / discard menu",
    summary: "Three-verb AI action menu: Accept, Discard, Try again.",
    whySaved: "Exactly the vocabulary our overlay chip should use.",
    ocrExcerpt: "Accept   Discard   Try again   Get unlimited AI",
    intent: "design_inspiration",
    threadId: "onboarding-teardown",
    confidence: 0.86,
    capturedAt: "2026-07-21T16:20:00Z",
    aspect: "tall",
    hue: 40,
  },
  {
    id: "s5",
    title: "Superhuman — onboarding step 3",
    summary: "Keyboard-shortcut teaching screen with a single practice action per step.",
    whySaved: "One concept per screen — the pacing we want for hotkey onboarding.",
    ocrExcerpt: "Press ⌘K to jump anywhere. Try it now.",
    intent: "reference",
    threadId: "onboarding-teardown",
    confidence: 0.79,
    capturedAt: "2026-06-02T08:55:00Z",
    aspect: "wide",
    hue: 285,
  },
  {
    id: "s6",
    title: "Ad hook — 'stop losing screenshots'",
    summary: "Short-form ad with the pain stated in the first three words.",
    whySaved: "Hook structure for the launch reel.",
    ocrExcerpt: "You screenshot it. You forget it. Every time.",
    intent: "marketing_hook",
    threadId: "q3-launch",
    confidence: 0.83,
    capturedAt: "2026-07-09T19:31:00Z",
    aspect: "tall",
    hue: 330,
  },
  {
    id: "s7",
    title: "Raycast — command palette",
    summary: "Command palette with inline result grouping and a persistent footer of actions.",
    whySaved: "Footer action bar pattern for our search omnibox.",
    ocrExcerpt: "Search for apps and commands…  ↵ Open  ⌘K Actions",
    intent: "design_inspiration",
    threadId: "pricing-redesign",
    confidence: 0.9,
    capturedAt: "2026-05-11T13:05:00Z",
    aspect: "wide",
    hue: 195,
  },
  {
    id: "s8",
    title: "Arc — sidebar project grouping",
    summary: "Sidebar splits pinned spaces from loose tabs with a hairline divider.",
    whySaved: "Model for Inbox-above-projects ordering.",
    ocrExcerpt: "Spaces  ·  Pinned  ·  Today",
    intent: "reference",
    threadId: "onboarding-teardown",
    confidence: 0.81,
    capturedAt: "2026-04-22T10:14:00Z",
    aspect: "tall",
    hue: 160,
  },
  {
    id: "s9",
    title: "Thumbnail stretches on retina",
    summary: "Grid thumbnail loses aspect ratio when the source capture is HiDPI.",
    whySaved: "Second display again — likely the same scale-factor bug.",
    ocrExcerpt: "captured 2026-07-29 · 3024 × 1964",
    intent: "ux_bug",
    threadId: "capso-bugs",
    confidence: 0.87,
    capturedAt: "2026-07-29T15:48:00Z",
    aspect: "square",
    hue: 8,
  },
  {
    id: "s10",
    title: "Competitor changelog page",
    summary: "Changelog with screenshots per release and a filter by product area.",
    whySaved: "Format reference if we ever ship a public changelog.",
    ocrExcerpt: "July 2026 — Improved search ranking, faster capture",
    intent: "competitor",
    threadId: "q3-launch",
    confidence: 0.74,
    capturedAt: "2026-07-18T12:26:00Z",
    aspect: "wide",
    hue: 220,
  },
  // --- Inbox: unassigned / low-confidence ---
  {
    id: "s11",
    title: "Untitled capture",
    summary: "A settings panel with toggles for notification frequency and quiet hours.",
    whySaved: "Unclear — no strong signal from surrounding context.",
    ocrExcerpt: "Notifications · Quiet hours · Daily digest",
    intent: "other",
    threadId: null,
    suggestedThreadId: "onboarding-teardown",
    confidence: 0.41,
    capturedAt: "2026-07-30T17:03:00Z",
    aspect: "square",
    hue: 100,
  },
  {
    id: "s12",
    title: "Dashboard with revenue chart",
    summary: "Analytics dashboard showing MRR growth and churn side by side.",
    whySaved: "Possibly competitor research, possibly your own metrics.",
    ocrExcerpt: "MRR $12,480 · Churn 2.1% · Net new 34",
    intent: "competitor",
    threadId: null,
    suggestedThreadId: "q3-launch",
    confidence: 0.63,
    capturedAt: "2026-07-30T18:22:00Z",
    aspect: "wide",
    hue: 268,
  },
  {
    id: "s13",
    title: "Mobile nav drawer",
    summary: "Slide-over navigation with large tap targets and a search field pinned to the top.",
    whySaved: "Layout reference for a future mobile read view.",
    ocrExcerpt: "Home · Library · Projects · Settings",
    intent: "design_inspiration",
    threadId: null,
    suggestedThreadId: "onboarding-teardown",
    confidence: 0.58,
    capturedAt: "2026-07-31T08:41:00Z",
    aspect: "tall",
    hue: 340,
  },
];

export const inbox = screenshots.filter((s) => s.threadId === null);
export const filed = screenshots.filter((s) => s.threadId !== null);

export function byThread(threadId: string) {
  return filed.filter((s) => s.threadId === threadId);
}

export function find(id: string) {
  return screenshots.find((s) => s.id === id);
}

export function threadName(id: string) {
  return threads.find((t) => t.id === id)?.name ?? "Inbox";
}

/** Deterministic placeholder standing in for a real capture thumbnail. */
export function placeholder(s: Screenshot): string {
  const h = s.hue;
  const height = s.aspect === "tall" ? 420 : s.aspect === "wide" ? 200 : 300;
  const rows = Array.from({ length: Math.floor(height / 46) }, (_, i) => {
    const w = 190 - ((i * 37) % 110);
    return `<rect x="18" y="${64 + i * 46}" width="${w}" height="12" rx="6" fill="hsl(${h} 22% 62% / 0.5)"/>
      <rect x="18" y="${82 + i * 46}" width="${w - 40}" height="8" rx="4" fill="hsl(${h} 18% 66% / 0.32)"/>`;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${height}" viewBox="0 0 320 ${height}">
    <rect width="320" height="${height}" fill="hsl(${h} 34% 94%)"/>
    <rect width="320" height="40" fill="hsl(${h} 40% 88%)"/>
    <circle cx="22" cy="20" r="5" fill="hsl(${h} 30% 70%)"/>
    <circle cx="40" cy="20" r="5" fill="hsl(${h} 30% 76%)"/>
    <circle cx="58" cy="20" r="5" fill="hsl(${h} 30% 82%)"/>
    <rect x="232" y="${height - 46}" width="70" height="26" rx="13" fill="hsl(${h} 55% 58%)"/>
    ${rows}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
