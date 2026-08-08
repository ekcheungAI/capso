import type { ClassificationCall, ClassificationProvider } from "./worker.ts";

type MiniMaxConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
};

const DEFAULT_BASE = "https://api.minimax.io";
const DEFAULT_MODEL = "MiniMax-M3";

function stripThink(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export class MiniMaxClassificationProvider implements ClassificationProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetcher: typeof fetch;

  constructor(config: MiniMaxConfig) {
    this.#apiKey = config.apiKey;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.#model = config.model ?? DEFAULT_MODEL;
    this.#fetcher = config.fetcher ?? fetch;
  }

  async classify(call: ClassificationCall): Promise<string> {
    const prompt = call.repairError
      ? `${call.prompt}\n\nThe previous response failed validation (${call.repairError}). Return only the corrected JSON object.`
      : call.prompt;
    const response = await this.#fetcher(
      `${this.#baseUrl}/anthropic/v1/messages`,
      {
        method: "POST",
        signal: AbortSignal.timeout(55_000),
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: 2_048,
          system: call.system,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: call.image.mediaType,
                  data: call.image.base64,
                },
              },
              { type: "text", text: "Return only the JSON object." },
            ],
          }],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `classification provider unavailable (${response.status})`,
      );
    }

    const body = await response.json() as {
      content?: { type: string; text?: string }[];
    };
    return stripThink(
      (body.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join(""),
    );
  }
}
