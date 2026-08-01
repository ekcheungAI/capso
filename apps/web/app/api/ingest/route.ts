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
/** How long a handed-out capture may go unacknowledged before it is re-offered. */
const IN_FLIGHT_MS = 60_000;

// Module scope persists across requests in a running dev server.
const queue: Pending[] = [];
/** Handed to a client but not yet confirmed stored. */
const inFlight = new Map<string, { item: Pending; takenAt: number }>();

/** Anything a client took but never acknowledged goes back in the queue. */
function reclaim() {
  const now = Date.now();
  for (const [id, entry] of inFlight) {
    if (now - entry.takenAt > IN_FLIGHT_MS) {
      inFlight.delete(id);
      queue.push(entry.item);
    }
  }
}

export async function POST(req: Request) {
  let body: (Partial<Pending> & { ack?: string[] }) | null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, req);
  }

  // An acknowledgement, not a capture: the client has stored these for real.
  if (Array.isArray(body?.ack)) {
    for (const id of body.ack) inFlight.delete(id);
    return json({ acked: body.ack.length }, 200, req);
  }

  if (!body?.imageDataUrl?.startsWith("data:image/")) {
    return json({ error: "imageDataUrl must be an image data URL" }, 400, req);
  }

  queue.push({
    id: `ext_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    imageDataUrl: body.imageDataUrl,
    source: "extension",
    pageUrl: body.pageUrl,
    pageTitle: body.pageTitle,
    at: new Date().toISOString(),
  });

  // Drop the oldest rather than grow without bound if no app is open to drain —
  // but say so. This used to evict silently and still answer 200, so the
  // extension reported "Sent to Capso" for a capture that had been thrown away.
  let dropped = 0;
  while (queue.length > MAX_QUEUED) {
    queue.shift();
    dropped++;
  }

  return json({ queued: queue.length, dropped }, dropped > 0 ? 507 : 200, req);
}

/**
 * Hands out pending captures. They are held in flight rather than deleted:
 * `splice` used to remove them at read time, so if the client threw while
 * storing item 2 of 5 — or the tab closed mid-loop — items 3 to 5 were gone
 * from both sides with nothing reporting it.
 */
export async function GET() {
  reclaim();
  const items = queue.splice(0, queue.length);
  const now = Date.now();
  for (const item of items) inFlight.set(item.id, { item, takenAt: now });
  return json({ items });
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req) });
}

/**
 * Only a Capso extension may talk to this endpoint, and only to POST.
 *
 * This used to return `access-control-allow-origin: *` on every response —
 * including the GET that drains the queue — which meant any page the user
 * happened to visit could read the full base64 of screenshots taken from their
 * private tabs, and push forged captures into their library. The comment above
 * it claimed "allow only the local app"; the code said otherwise.
 *
 * GET is same-origin only: it is drained by the Capso tab itself, which needs
 * no CORS header at all. Absent an `Origin`, nothing is echoed back.
 */
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin?.startsWith("chrome-extension://")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
}

function json(body: unknown, status = 200, req?: Request) {
  return NextResponse.json(body, { status, headers: req ? cors(req) : {} });
}
