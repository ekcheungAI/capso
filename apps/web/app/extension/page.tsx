"use client";

import { useEffect, useState } from "react";

/**
 * Self-hosted extension download.
 *
 * Chrome blocks .crx installs from anywhere but the Web Store, so there is no
 * silent auto-update without publishing. The honest mechanism is: serve a .zip,
 * publish the version, and have the installed extension tell the user when it
 * has fallen behind.
 */
export default function ExtensionPage() {
  const [info, setInfo] = useState<{ version: string; builtAt: string } | null>(null);

  useEffect(() => {
    fetch("/extension-version.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Chrome extension</h1>
        <p className="mt-1 text-xs text-muted">
          Captures the visible browser tab into Capso. Native app windows still need the Mac app.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Capso for Chrome {info ? `v${info.version}` : ""}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            {info
              ? `Built ${new Date(info.builtAt).toLocaleString("en-GB")}`
              : "Run pnpm build:extension to produce the download."}
          </p>
        </div>
        <a
          href="/capso-extension.zip"
          download
          className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-ink"
        >
          Download .zip
        </a>
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Install or update</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted">
          <li>Unzip the download.</li>
          <li>
            Open <code className="rounded bg-surface px-1">chrome://extensions</code> and turn on{" "}
            <strong>Developer mode</strong>.
          </li>
          <li>
            <strong>First install:</strong> click <strong>Load unpacked</strong> and pick the
            unzipped folder.
          </li>
          <li>
            <strong>Updating:</strong> replace the contents of that same folder with the new files,
            then press <strong>Reload</strong> (↻) on the Capso card. Keeping the folder path stable
            means the extension ID and your hotkey survive the update.
          </li>
          <li>
            Set the shortcut at{" "}
            <code className="rounded bg-surface px-1">chrome://extensions/shortcuts</code> — default
            is ⌘⇧U.
          </li>
        </ol>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Why there is no auto-update</h2>
        <p className="text-xs leading-relaxed text-muted">
          Chrome only auto-updates extensions installed from the Web Store, and it refuses{" "}
          <code className="rounded bg-surface px-1">.crx</code> files served from a website unless
          the machine is managed by enterprise policy. So a self-hosted extension updates by
          replacing the folder and hitting Reload. The extension checks this page&apos;s version on
          startup and notifies you when your copy is behind — that is the closest honest equivalent.
        </p>
        <p className="text-xs leading-relaxed text-muted">
          Publishing to the Web Store would give real auto-update. It needs a one-off US$5 developer
          registration and a review pass, so it is an owner decision, not something to do quietly.
        </p>
      </section>
    </div>
  );
}
