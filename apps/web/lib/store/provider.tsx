"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as store from "./index";
import type { Correction, Revisit, Screenshot, Thread } from "./types";

type State = {
  ready: boolean;
  threads: Thread[];
  screenshots: Screenshot[];
  corrections: Correction[];
  revisits: Revisit[];
};

type Api = State & {
  inbox: Screenshot[];
  filed: Screenshot[];
  byThread: (id: string) => Screenshot[];
  get: (id: string) => Screenshot | undefined;
  threadName: (id: string | null) => string;
  assign: (s: Screenshot, threadId: string | null, source: Screenshot["assignmentSource"]) => Promise<void>;
  addThread: (name: string) => Promise<Thread>;
  saveWhySaved: (s: Screenshot, text: string) => Promise<void>;
  saveIntent: (s: Screenshot, intent: Screenshot["intent"]) => Promise<void>;
  remove: (s: Screenshot) => Promise<void>;
  visit: (id: string, kind: Revisit["kind"]) => Promise<void>;
  ingest: (s: Screenshot) => Promise<void>;
  reset: () => Promise<void>;
};

const Ctx = createContext<Api | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<State>({
    ready: false,
    threads: [],
    screenshots: [],
    corrections: [],
    revisits: [],
  });

  useEffect(() => {
    store.loadAll().then((data) => setS({ ready: true, ...data }));
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
      inbox: s.screenshots.filter((x) => x.threadId === null && !x.archived),
      filed: s.screenshots.filter((x) => x.threadId !== null && !x.archived),
      byThread: (id) => s.screenshots.filter((x) => x.threadId === id && !x.archived),
      get: (id) => s.screenshots.find((x) => x.id === id),
      threadName,

      async assign(shot, threadId, source) {
        const { screenshot, correction } = await store.assignThread(shot, threadId, source);
        upsert(screenshot, correction);
      },
      async addThread(name) {
        const t = await store.createThread(name);
        setS((p) => ({ ...p, threads: [...p.threads, t] }));
        return t;
      },
      async saveWhySaved(shot, text) {
        const { screenshot, correction } = await store.editWhySaved(shot, text);
        upsert(screenshot, correction);
      },
      async saveIntent(shot, intent) {
        const { screenshot, correction } = await store.setIntent(shot, intent);
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
      },
      async reset() {
        const data = await store.resetAll();
        setS({ ready: true, ...data });
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
