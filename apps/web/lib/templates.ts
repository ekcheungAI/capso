/**
 * First-run starter kits. Picking one creates project threads and nothing else —
 * there is no persistent "role" state anywhere in the app afterwards. The
 * classifier still adapts only through the correction ledger (06 §6); this just
 * means the first capture has somewhere sensible to land instead of the Inbox.
 *
 * Owner decision 2026-08-01, overriding 03_PERSONAS_AND_USE_CASES.md's
 * out-of-scope line on persona templates.
 */

export type StarterProject = {
  name: string;
  /** Written as a hint the model can act on, not as marketing copy. */
  description: string;
};

export type Role = {
  id: string;
  name: string;
  blurb: string;
  projects: StarterProject[];
};

export const ROLES: Role[] = [
  {
    id: "marketing",
    name: "Marketing",
    blurb: "Campaigns, competitors, hooks and the numbers afterwards.",
    projects: [
      {
        name: "Campaign ideas",
        description:
          "Concepts for campaigns you might run — formats, angles, seasonal ideas, things worth trying.",
      },
      {
        name: "Competitor ads & positioning",
        description:
          "Ads, landing pages and taglines from other companies — anything about how someone else sells.",
      },
      {
        name: "Hooks & copy swipe file",
        description:
          "Opening lines, headlines, captions and short-form scripts worth stealing the structure of.",
      },
      {
        name: "Landing pages",
        description:
          "Page layouts, sections, social proof and calls to action from pages that convert.",
      },
      {
        name: "Results & analytics",
        description:
          "Dashboards, charts and performance numbers — your own results or someone else's reported ones.",
      },
    ],
  },
  {
    id: "product",
    name: "Product & design",
    blurb: "Interfaces worth stealing, bugs worth fixing, features worth watching.",
    projects: [
      {
        name: "Design inspiration",
        description:
          "Interface patterns worth borrowing — empty states, onboarding flows, navigation, micro-interactions.",
      },
      {
        name: "UX bugs",
        description:
          "Broken layouts, wrong states and visual glitches in your own product, saved to fix later.",
      },
      {
        name: "Competitor features",
        description:
          "How other products solved a problem you also have — feature UIs, settings, flows.",
      },
      {
        name: "User feedback",
        description:
          "Screenshots of what people said — support messages, reviews, survey answers, chat threads.",
      },
      {
        name: "Design system references",
        description:
          "Components, type scales, colour and spacing systems, documentation from other design systems.",
      },
    ],
  },
  {
    id: "founder",
    name: "Founder — both hats",
    blurb: "One set that covers building and selling without splitting hairs.",
    projects: [
      {
        name: "Product ideas",
        description:
          "Features, flows and interface patterns for what you are building.",
      },
      {
        name: "Competitors",
        description:
          "Anything from a company you compete with — pricing, features, ads, positioning.",
      },
      {
        name: "Marketing & hooks",
        description:
          "Headlines, ad creative, landing pages and short-form content structures worth reusing.",
      },
      {
        name: "Bugs to fix",
        description: "Broken states and visual glitches in your own product.",
      },
      {
        name: "Reference",
        description:
          "Anything you want to be able to find again that is not one of the above.",
      },
    ],
  },
  {
    id: "empty",
    name: "Start empty",
    blurb: "No projects. Everything lands in the Inbox until you make some.",
    projects: [],
  },
];

export function roleById(id: string): Role | undefined {
  return ROLES.find((r) => r.id === id);
}
