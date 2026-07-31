import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/shell";
import { StoreProvider } from "@/lib/store/provider";

export const metadata: Metadata = {
  title: "Capso",
  description: "Screenshot memory — capture, organise, retrieve.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <StoreProvider>
          <Shell>{children}</Shell>
        </StoreProvider>
      </body>
    </html>
  );
}
