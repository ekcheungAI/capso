"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as store from "./index";
import { isOwnCapture, type Stage } from "@/lib/onboarding";
import type { Correction, Message, Revisit, Screenshot, Thread } from "./types";

type State = {
  ready: boolean;
  /**
   * Why the library could not be opened, if it could not. Never null-and-ready
   * at the same time: an unreadable store has to say so, because the alternative
   * is an infinite skeleton that looks identical to a slow load.
   */
  loadError: string | null;
  /** No library and no record of a first run — Shell shows the picker instead of the app. */
  needsSetup: boolean;
  /**
   * Where this person is in first run. `needsSetup` is the same question asked
   * only about the picker; this one also distinguishes "set up but has never
   * captured" from "done", which is the distinction `app/page.tsx` got wrong.
   */
  stage: Stage;
  threads: Thread[];
  screenshots: Screenshot[];
  corrections: Correction[];
  revisits: Revisit[];
  messages: Message[];
};

type Api = State & {
  inbox: Screenshot[];
  filed: Screenshot[];
  byThread: (id: string) => Screenshot[];
  get: (id: string) => Screenshot | undefined;
  threadName: (id: string | null) => string;
  assign: (s: Screenshot, threadId: string | null, source: Screenshot["assignmentSource"]) => Promise<void>;
  addThread: (name: string, description?: string) => Promise<Thread>;
  applyTemplate: (roleId: string) => Promise<void>;
  loadSamples: () => Promise<void>;
  /** "Skip for now" from the picker — start blank without choosing a role. */
  skipSetup: () => Promise<void>;
  saveWhySaved: (s: Screenshot, text: string) => Promise<void>;
  saveIntent: (s: Screenshot, intent: Screenshot["intent"]) => Promise<void>;
  addTag: (s: Screenshot, tag: string) => Promise<void>;
  dropTag: (s: Screenshot, tag: string) => Promise<void>;
  remove: (s: Screenshot) => Promise<void>;
  visit: (id: string, kind: Revisit["kind"]) => Promise<void>;
  ingest: (s: Screenshot) => Promise<void>;
  /** Merge fields onto a capture as it currently exists — see `patchScreenshot`. */
  patch: (
    id: string,
    fields: Partial<Screenshot> | ((current: Screenshot) => Partial<Screenshot>),
  ) => Promise<void>;
  archive: (s: Screenshot, archived: boolean) => Promise<void>;
  forget: (correctionId: string) => Promise<void>;
  rememberCorrection: (correction: Correction) => Promise<boolean>;
  say: (m: Omit<Message, "id" | "createdAt">) => Promise<Message>;
  threadMessages: (threadId: string) => Message[];
  reset: () => Promise<void>;
  clearSamples: () => Promise<void>;
};

const Ctx = createContext<Api | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<State>({
    ready: false,
    loadError: null,
    needsSetup: false,
    stage: "done",
    threads: [],
    screenshots: [],
    corrections: [],
    revisits: [],
    messages: [],
  });

  useEffect(() => {
    store
      .loadAll()
      .then((data) => setS({ ready: true, loadError: null, ...data }))
      .catch((err: unknown) =>
        setS((p) => ({
          ...p,
          ready: true,
          loadError: err instanceof Error ? err.message : "Your library could not be opened.",
        })),
      );
  }, []);

  const upsert = useCallback((next: Screenshot, correction?: Correction) => {
    setS((p) => ({
      ...p,
      screenshots: p.screenshots.some((x) => x.id === next.id)
        ? p.screenshots.map((x) => (x.id === next.id ? next : x))
        : [next, ...p.screenshots],
      corrections: correction ? [correction, ...p.corrections] : p.corrections,
    }));
  }, []);

  const api = useMemo<Api>(() => {
    const threadName = (id: string | null) =>
      id === null ? "Inbox" : (s.threads.find((t) => t.id === id)?.name ?? "Inbox");

    return {
      ...s,
      // Derived, never stored alongside `stage`. They encode the same fact, and
      // holding both in state meant they could disagree: `ingest` moved `stage`
      // to "done" and left `needsSetup` true, so capturing during first run
      // filed the capture and left the role picker on screen.
      needsSetup: s.stage === "pick_role",
      inbox: s.screenshots.filter((x) => x.threadId === null && !x.archived),
      filed: s.screenshots.filter((x) => x.threadId !== null && !x.archived),
      byThread: (id) => s.screenshots.filter((x) => x.threadId === id && !x.archived),
      get: (id) => s.screenshots.find((x) => x.id === id),
      threadName,

      async assign(shot, threadId, source) {
        const { screenshot, correction, thread } = await store.assignThread(shot, threadId, source);
        upsert(screenshot, correction);
        if (thread)
          setS((p) => ({
            ...p,
            threads: p.threads.map((t) => (t.id === thread.id ? thread : t)),
          }));
      },
      async addThread(name, description) {
        const t = await store.createThread(name, description);
        setS((p) => ({ ...p, threads: [...p.threads, t] }));
        return t;
      },
      async applyTemplate(roleId) {
        const data = await store.applyTemplate(roleId);
        setS({ ready: true, loadError: null, ...data });
      },
      async loadSamples() {
        const data = await store.loadSamples();
        setS({ ready: true, loadError: null, ...data });
      },
      async skipSetup() {
        const data = await store.skipSetup();
        setS({ ready: true, loadError: null, ...data });
      },
      async saveWhySaved(shot, text) {
        const { screenshot, correction } = await store.editWhySaved(shot, text);
        upsert(screenshot, correction);
      },
      async saveIntent(shot, intent) {
        const { screenshot, correction } = await store.setIntent(shot, intent);
        upsert(screenshot, correction);
      },
      async addTag(shot, tag) {
        const { screenshot } = await store.addUserTag(shot, tag);
        upsert(screenshot);
      },
      async dropTag(shot, tag) {
        const { screenshot, correction } = await store.removeTag(shot, tag);
        upsert(screenshot, correction);
      },
      async remove(shot) {
        await store.deleteScreenshot(shot);
        setS((p) => ({
          ...p,
          screenshots: p.screenshots.filter((x) => x.id !== shot.id),
          corrections: p.corrections.filter((c) => c.screenshotId !== shot.id),
        }));
      },
      async visit(id, kind) {
        const r = await store.recordRevisit(id, kind);
        setS((p) => ({ ...p, revisits: [r, ...p.revisits] }));
      },
      async ingest(shot) {
        await store.putScreenshot(shot);
        upsert(shot);

        // Onboarding's self-destruct. Doc 15 bans checklists that outlive
        // onboarding, so nothing here is dismissible: the welcome and the nudge
        // disappear because the thing they were asking for has happened. A
        // dismiss button would let a user turn off a prompt they never satisfied,
        // and leave one they did satisfy on screen.
        if (isOwnCapture(shot)) {
          store.completeFirstCapture();
          setS((p) => (p.stage === "done" ? p : { ...p, stage: "done" }));
        }
      },
      async patch(id, fields) {
        const next = await store.patchScreenshot(id, fields);
        // Null means the row is gone — deleted while the model was running.
        // Re-inserting it here would resurrect a capture the user threw away.
        if (next) upsert(next);
      },
      async archive(shot, archived) {
        const next = await store.setArchived(shot, archived);
        upsert(next);
      },
      async forget(correctionId) {
        await store.forgetCorrection(correctionId);
        setS((p) => ({ ...p, corrections: p.corrections.filter((c) => c.id !== correctionId) }));
      },
      async rememberCorrection(correction) {
        const restored = await store.restoreCorrection(correction);
        if (restored) {
          setS((p) => ({
            ...p,
            corrections: p.corrections.some((candidate) => candidate.id === correction.id)
              ? p.corrections
              : [correction, ...p.corrections],
          }));
        }
        return restored;
      },
      async say(m) {
        const msg = await store.addMessage(m);
        setS((p) => ({ ...p, messages: [...p.messages, msg] }));
        return msg;
      },
      threadMessages: (threadId) =>
        s.messages
          .filter((m) => m.threadId === threadId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      async reset() {
        const data = await store.resetAll();
        setS({ ready: true, loadError: null, ...data });
      },
      async clearSamples() {
        const data = await store.clearSamples();
        setS({ ready: true, loadError: null, ...data });
      },
    };
  }, [s, upsert]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}
