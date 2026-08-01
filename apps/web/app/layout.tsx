import type { Metadata, Viewport } from "next";
import { color } from "@capso/shared/tokens";
import "./globals.css";
import { Shell } from "@/components/shell";
import { StoreProvider } from "@/lib/store/provider";
import { ToastProvider } from "@/components/toast";

// No production domain is registered yet, so this reads from the environment
// and falls back to the dev server. metadataBase has to be absolute — without
// it, the relative og:image path below is a build error rather than a warning.
const SITE = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: SITE,
  title: { default: "Capso", template: "%s · Capso" },
  description: "Screenshot memory — capture, organise, retrieve.",
  applicationName: "Capso",
  icons: {
    // favicon.ico is deliberately absent here: app/favicon.ico is a Next file
    // convention and already emits its own link tag, so declaring it again just
    // produces two tags for one file. Its 16px frame is drawn on its own pixel
    // grid rather than downscaled — see drafts/brand/mark/capso-icon-16.svg.
    icon: [
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  openGraph: {
    type: "website",
    siteName: "Capso",
    title: "You're not organised. Capso is.",
    description: "Every screenshot read, filed, and findable by a sentence.",
    url: "/",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Capso" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "You're not organised. Capso is.",
    description: "Every screenshot read, filed, and findable by a sentence.",
    images: ["/og-image.png"],
  },
};

// themeColor lives on the viewport export, not metadata — it was deprecated
// there in Next 14. Pulled from the shared tokens rather than retyped, so
// mobile browser chrome cannot drift away from the page it sits above.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: color.light.background! },
    { media: "(prefers-color-scheme: dark)", color: color.dark.background! },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <StoreProvider>
          <ToastProvider>
            <Shell>{children}</Shell>
          </ToastProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
