"use client";

import { usePathname } from "next/navigation";
import { AccountGate } from "@/components/account-gate";
import { Shell } from "@/components/shell";
import { ToastProvider } from "@/components/toast";
import { StoreProvider } from "@/lib/store/provider";

/**
 * Public share delivery must not mount the private account, IndexedDB store,
 * capture listeners or library navigation. The fragment bearer stays entirely
 * inside the deliberately small receiver surface.
 */
export function AppBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/share") return children;

  return (
    <AccountGate>
      <StoreProvider>
        <ToastProvider>
          <Shell>{children}</Shell>
        </ToastProvider>
      </StoreProvider>
    </AccountGate>
  );
}
