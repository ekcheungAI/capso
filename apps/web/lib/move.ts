"use client";

import { useCallback } from "react";
import { useStore } from "@/lib/store/provider";
import { useToast } from "@/components/toast";

/**
 * Filing by drag, wherever the drop happened. The sidebar rows and the library
 * shelves are the same gesture and must give the same receipt, so the whole
 * move — transition, write, undo — lives here rather than twice.
 */
export function useMoveCaptures() {
  const { threads, get, assign } = useStore();
  const toast = useToast();

  return useCallback(
    async (threadId: string, ids: string[]) => {
      const moved = ids.map(get).filter((s): s is NonNullable<typeof s> => Boolean(s));
      if (moved.length === 0) return;

      const previous = moved.map((s) => [s.id, s.threadId] as const);
      const run = () => Promise.all(moved.map((s) => assign(s, threadId, "manual")));

      // View Transitions make the cards travel to their new positions instead of
      // snapping. Guarded because Safari/Firefox lag on support.
      if (typeof document.startViewTransition === "function") {
        await new Promise<void>((res) =>
          document.startViewTransition!(async () => {
            await run();
            res();
          }),
        );
      } else {
        await run();
      }

      const name = threads.find((t) => t.id === threadId)?.name ?? "Inbox";
      toast(
        `Moved ${moved.length > 1 ? `${moved.length} captures` : "1 capture"} to ${name}`,
        () => {
          // Read each capture fresh rather than replaying the pre-move
          // snapshot — otherwise any edit made during the undo window (a tag,
          // a note, a landing classify() patch) is silently overwritten.
          for (const [id, prev] of previous) {
            const current = get(id);
            if (current) void assign(current, prev, "manual");
          }
        },
      );
    },
    [threads, get, assign, toast],
  );
}
