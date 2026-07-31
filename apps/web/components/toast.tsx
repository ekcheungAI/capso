"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

/**
 * Filing a capture used to be silent — the card just vanished from the Inbox.
 * A toast gives the action a receipt and, more importantly, an Undo, which is
 * what makes one-click filing safe enough to do without thinking.
 */

type Toast = { id: number; text: string; undo?: () => void };

const Ctx = createContext<(text: string, undo?: () => void) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((text: string, undo?: () => void) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, undo }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="capso-toast pointer-events-auto flex items-center gap-3 rounded-lg bg-foreground px-4 py-2.5 text-xs text-background shadow-lg"
          >
            <span>{t.text}</span>
            {t.undo && (
              <button
                onClick={() => {
                  t.undo?.();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
                className="font-medium underline underline-offset-2"
              >
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
