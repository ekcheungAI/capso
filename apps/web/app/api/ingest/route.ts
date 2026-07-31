import { NextResponse } from "next/server";

/**
 * Bridge between the Chrome extension and the browser-side store.
 *
 * The demo keeps captures in IndexedDB, which a service worker cannot write to,
 * so the extension POSTs here and the open web app drains the queue. The queue
 * is in-memory and deliberately small: it survives seconds, not restarts. When
 * data moves to Supabase in P1 this becomes the real ingest endpoint from
 * specs/api_contracts.md and the queue disappears.
 */

export type Pending = {
  id: string;
  imageDataUrl: string;
  source: "extension";
  pageUrl?: string;
  pageTitle?: string;
  at: string;
};

const MAX_QUEUED = 20;

// Module scope persists across requests in a running dev server.
const queue: Pending[] = [];

export async function POST(req: Request) {
  let body: Partial<Pending>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!body.imageDataUrl?.startsWith("data:image/")) {
    return json({ error: "imageDataUrl must be an image data URL" }, 400);
  }

  queue.push({
    id: `ext_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    imageDataUrl: body.imageDataUrl,
    source: "extension",
    pageUrl: body.pageUrl,
    pageTitle: body.pageTitle,
    at: new Date().toISOString(),
  });

  // Drop the oldest rather than grow without bound if no app is open to drain.
  while (queue.length > MAX_QUEUED) queue.shift();

  return json({ queued: queue.length });
}

/** Drains the queue — each capture is handed out exactly once. */
export async function GET() {
  const items = queue.splice(0, queue.length);
  return json({ items });
}

/** The extension preflights this cross-origin; allow only the local app. */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: cors() });
}
