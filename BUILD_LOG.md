# Capso Build Log

Append-only. One entry per build loop, per `20_AGENT_LOOP_INSTRUCTIONS.md` §6.

---

## Loop 01 — Monorepo scaffold
**Date:** 2026-07-31 · **Phase:** P0 Foundation · **Outcome:** done

```
Objective: pnpm monorepo with apps/web, apps/mac, packages/shared installing and typechecking clean.
Phase/tasks: P0 task 1 (monorepo scaffold)
In-scope files: package.json, pnpm-workspace.yaml, .gitignore, .env.example, apps/**, packages/shared/**
Out of scope: Supabase project, auth, tray UI, CI, Sentry/PostHog, any capture code
Done-when: pnpm install clean; pnpm typecheck green in all 3 packages; web + mac both build
Verification: pnpm install && pnpm typecheck && pnpm lint && pnpm --filter web build && pnpm --filter mac build && cargo build
```

**Verification evidence**
- `pnpm typecheck` — Done in all 3 workspace projects (apps/mac, apps/web, packages/shared)
- `pnpm lint` — apps/web eslint clean
- `pnpm --filter web build` — compiled successfully, 2 static routes
- `pnpm --filter mac build` — vite built in 430ms
- `cargo build` (src-tauri) — `Finished dev profile in 1m 01s`, binary at `target/debug/mac` (24 MB)
- Secrets check: only `.env.example` (template, no values) is tracked

**Deviations from plan**
1. **Next.js 16.2.12, not 15.** `create-next-app@latest` now ships Next 16. Pack docs say "Next.js 15 App Router" throughout. App Router APIs used here are unchanged; Next 16 has breaking changes vs. older training data (see `apps/web/AGENTS.md`). **Owner decision needed:** accept 16 and update the pack's version strings, or pin to 15.
2. Tauri scaffolded at repo root by `create-tauri-app` and moved into `apps/mac`; nested `.git` dirs from both scaffolders removed (single repo at Capso root).

**Blockers surfaced (STOP rules)**
- Supabase project creation → external service + likely new recurring charge (org already has 4 active projects). STOP rules 3 & 4. Awaiting owner.
- GitHub remote + Vercel deploy → external. STOP rules 3 & 6. Awaiting owner.

**Next loop:** Loop 02 — Tauri menu-bar tray shell (P0 task 4), fully local, no external dependency.

---

## Loop 02 — Menu-bar tray shell
**Date:** 2026-07-31 · **Phase:** P0 Foundation · **Outcome:** done

```
Objective: Tauri app runs as a macOS menu-bar (Accessory) app with a tray icon that toggles a popover window.
Phase/tasks: P0 task 4 (Tauri menu-bar app boots with tray icon + empty popover window)
In-scope files: apps/mac/src-tauri/{Cargo.toml,src/lib.rs,tauri.conf.json}, apps/mac/src/App.tsx
Out of scope: hotkeys, capture, upload queue, auth, AI — all later phases
Done-when: cargo build green; no dock icon; tray click toggles window; Quit item exits
Verification: cargo build; manual launch of target/debug/mac
```

**Verification evidence**
- `pnpm --filter mac typecheck` — clean
- `cargo build` — `Finished dev profile in 23.44s` (tray-icon + image-png features added)
- Launched `target/debug/mac`: process runs; `osascript … get background only of process "mac"` → **true**, confirming `ActivationPolicy::Accessory` (no Dock tile, no app-switcher entry)

**Deviations / gaps**
- **Tray icon not visually verified.** `screencapture` from the agent shell returns "could not create image from display" — the shell lacks Screen Recording permission. Owner re-granted permissions mid-loop but the shell is still blocked, so the grant likely applied to the Claude app rather than the terminal. Code path is standard `TrayIconBuilder`; pixel QA deferred to owner launch or to the bundled `.app` in P7. **This is the same permission surface P2 depends on — resolve before P2 starts** (`specs/permission_model.md`).
- Scaffold demo assets (`react.svg`, `tauri.svg`, `vite.svg`, greet command) removed; popover renders a placeholder panel.

**Next loop:** blocked on owner — see MASTER_PLAN "Known blockers". Local-only work remaining in P0 is CI config and telemetry init, both unverifiable without a remote/keys.

---

## Loop 03 — Interactive demo: state, capture, detail, organise
**Date:** 2026-07-31 · **Phase:** demo track (ahead of P2/P4, owner-directed) · **Outcome:** done

Owner's verdict on the static demo: "I don't see and feel much demo experience — how do I screenshot? how do I organise? how do I move files? what does each screenshot tell me? where do I optimise my memory?" All fair; the four pages were mock renders with no state.

**Built**
- `lib/store/` — IndexedDB behind an async seam whose function names match the future Supabase calls, so P1 swaps the implementation only. Seeded on first run; "Reset demo data" restores.
- `/s/[id]` detail view — every element `13_WEB_APP_PLAN.md` lists, plus a revisit event on open (F5).
- Organise — project dropdown on detail, keyboard-first inbox triage (j/k/⏎/number), drag card → sidebar project, bulk move, inline project creation.
- Capture — drop/paste anywhere plus a Capture button; overlay with the four chip states from `05_FEATURE_SPEC_CAPTURE.md`.
- Every assignment writes a `corrections` row (accepts included, per 07:34).

**Verification**
- `pnpm --filter web typecheck` / `lint` — clean
- Browser pane: changed a capture's project on `/s/s1`; sidebar counts moved live (Pricing 3→2, Q3 2→3). IndexedDB read-back confirmed `threadId: "q3-launch"`, `assignmentSource: "manual"`, and one `corrections` row with `wasAiAccepted: false`.
- Capture button → overlay "Saved to Capso UI bugs · edit" with Ask AI / Open / Delete; library 10→11.

**Deviations / notes**
- Classification is simulated (`lib/classify.ts`) with the real 8-field shape. Loop C swaps the body for MiniMax M3.
- Overlay placed bottom-right, resolving the 05 (bottom-left) vs F1 (bottom-right) conflict in favour of F1. `05_FEATURE_SPEC_CAPTURE.md` still needs the edit.
- `why_saved` made editable — owner decision; `06_FEATURE_SPEC_AI_MEMORY.md` §5 ("not separately editable in MVP") is now stale and needs updating.
- Turbopack served a stale module graph after `lib/mock.ts` was deleted; fixed by clearing `.next`. Worth remembering when a route 404s with a resolved-on-disk import.

**Next loop:** Loop C — real MiniMax M3 classification, starting with the image-support curl.

---

## Design reference pass — Mobbin
**Date:** 2026-07-31 · **Phase:** P0 (out-of-band, owner-requested) · **Outcome:** done

Owner asked mid-loop to reference Mobbin for UX/UI preparation. Added a **Reference board** section to `15_DESIGN_SYSTEM_AND_UX.md` covering four surfaces (library/inbox grid, inbox triage, thread chat, search results) with 14 cited references and the specific mechanic to copy from each. No code changed. Key adoptions: Notion Mail's three-verb AI action menu (Accept/Discard/Try again), ChatGPT's inline-citation + sources-rail split for AC-CHAT-02, applied-filter pills for the date-extraction feature, and mymind/Fabric/Savee for grid density.

---
