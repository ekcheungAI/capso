import type { Metadata, Viewport } from "next";
import { color } from "@capso/shared/tokens";
import "./globals.css";
import { Shell } from "@/components/shell";
import { StoreProvider } from "@/lib/store/provider";
import { ToastProvider } from "@/components/toast";

/**
 * Absolute base for every URL-shaped metadata field. It has to be absolute or
 * the relative og:image below is a build error rather than a warning.
 *
 * The localhost fallback alone was not enough: no domain is registered yet, so
 * the first preview deploy shipped `og:image: http://localhost:3000/og-image.png`
 * — a share card pointing at a machine that is not there. Vercel injects its own
 * host, so prefer that before falling back.
 *
 *   NEXT_PUBLIC_SITE_URL              set this once a real domain exists
 *   VERCEL_PROJECT_PRODUCTION_URL     the project's stable production host
 *   VERCEL_URL                        this specific deployment (preview)
 *
 * Production is preferred over the per-deployment host so shared links stay
 * canonical rather than pointing at a preview that will be superseded.
 */
const host =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000");
const SITE = new URL(host);

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
