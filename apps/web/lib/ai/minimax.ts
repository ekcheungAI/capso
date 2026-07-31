import "server-only";

/**
 * MiniMax M3 — server-only caller.
 *
 * Coding-plan keys (`sk-cp-…`) are served on the Anthropic-compatible endpoint
 * `${MINIMAX_API_BASE_URL}/anthropic/v1/messages`, which draws on plan quota.
 * Same arrangement as ~/Desktop/ekOS/20_projects/heyommi-redesign/lib/ai/minimax.ts,
 * extended here with image content blocks for the per-capture vision pass.
 *
 * Env:
 *   MINIMAX_TEXT_API_KEY  (required)
 *   MINIMAX_API_BASE_URL  (optional, defaults to https://api.minimax.io)
 *   MINIMAX_MODEL         (optional, defaults to MiniMax-M3)
 */

const DEFAULT_BASE = "https://api.minimax.io";
const DEFAULT_MODEL = "MiniMax-M3";

export function isConfigured(): boolean {
  return Boolean(process.env.MINIMAX_TEXT_API_KEY?.trim());
}

/** Reasoning models sometimes inline a <think> block; it is never part of the answer. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

type ImagePart = { kind: "image"; mediaType: string; base64: string };
type TextPart = { kind: "text"; text: string };
export type Part = TextPart | ImagePart;

/** Split a data URL into the media type and payload the API expects. */
export function parseDataUrl(dataUrl: string): ImagePart | null {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const [, mediaType = "image/png", isBase64, payload = ""] = m;

  // SVG placeholders are URI-encoded, not base64, and no vision model wants them.
  if (!isBase64) return null;
  return { kind: "image", mediaType, base64: payload };
}

export async function complete({
  system,
  parts,
  maxTokens = 1024,
  signal,
}: {
  system: string;
  parts: Part[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const key = process.env.MINIMAX_TEXT_API_KEY?.trim();
  if (!key) throw new Error("MINIMAX_TEXT_API_KEY is not set");

  const base = process.env.MINIMAX_API_BASE_URL?.trim() || DEFAULT_BASE;
  const model = process.env.MINIMAX_MODEL?.trim() || DEFAULT_MODEL;

  const content = parts.map((p) =>
    p.kind === "text"
      ? { type: "text", text: p.text }
      : {
          type: "image",
          source: { type: "base64", media_type: p.mediaType, data: p.base64 },
        },
  );

  const res = await fetch(`${base}/anthropic/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MiniMax ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (json.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");

  return stripThink(text);
}
