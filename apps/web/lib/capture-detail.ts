import type { Screenshot } from "./store/types.ts";

type AccountMode = "local" | "signed_in";

type CaptureOrigin = {
  label: string;
  detail: string;
};

type CaptureAvailability = {
  label: string;
  detail: string;
  state: "local" | "waiting" | "ready" | "example";
};

export type CaptureDetailPresentation = {
  origin: CaptureOrigin;
  availability: CaptureAvailability;
  editing: {
    label: string;
    detail: string;
  };
  sourceUrl: string | null;
};

function compactDetail(values: Array<string | null | undefined>): string {
  const unique = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index);
  return unique.join(" · ");
}

function captureOrigin(capture: Pick<
  Screenshot,
  "source" | "sourceApp" | "pageTitle"
>): CaptureOrigin {
  switch (capture.source) {
    case "hotkey_region":
      return {
        label: "Capso for Mac",
        detail: compactDetail(["Area capture", capture.sourceApp]),
      };
    case "hotkey_window":
      return {
        label: "Capso for Mac",
        detail: compactDetail(["Window capture", capture.sourceApp]),
      };
    case "hotkey_fullscreen":
      return {
        label: "Capso for Mac",
        detail: compactDetail(["Full-screen capture", capture.sourceApp]),
      };
    case "extension":
      return {
        label: "Chrome extension",
        detail: compactDetail([capture.pageTitle, capture.sourceApp]) || "Browser capture",
      };
    case "drag":
      return { label: "Capso Web", detail: "Dragged into Capso" };
    case "clipboard":
      return { label: "Capso Web", detail: "Pasted into Capso" };
    case "web_upload":
      return { label: "Capso Web", detail: "Uploaded file" };
    case "seed":
      return { label: "Capso example", detail: "Sample data" };
  }
}

function safeSourceUrl(value: string | null): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
    ) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function captureDetailPresentation(
  capture: Pick<
    Screenshot,
    "source" | "sourceApp" | "pageTitle" | "pageUrl" | "originalPath"
  >,
  accountMode: AccountMode,
): CaptureDetailPresentation {
  let availability: CaptureAvailability;
  if (capture.source === "seed") {
    availability = {
      label: "Example data",
      detail: "This is sample content, not a synced private capture.",
      state: "example",
    };
  } else if (accountMode === "local") {
    availability = {
      label: "This browser only",
      detail: "This library copy is stored in this browser and is not synced to an account.",
      state: "local",
    };
  } else if (capture.originalPath) {
    availability = {
      label: "Private account copy",
      detail: "The original is stored privately and available to this signed-in account.",
      state: "ready",
    };
  } else {
    availability = {
      label: "Original not ready",
      detail: "The library row exists, but the private original has not finished uploading.",
      state: "waiting",
    };
  }

  return {
    origin: captureOrigin(capture),
    availability,
    editing: {
      label: "Flattened library image",
      detail: "Web edits replace this library image; Mac layer and revision state is not available on this page.",
    },
    sourceUrl: safeSourceUrl(capture.pageUrl),
  };
}

const MIME_FORMATS: Record<string, string> = {
  "image/gif": "GIF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/svg+xml": "SVG",
  "image/webp": "WEBP",
};

const EXTENSION_FORMATS: Record<string, string> = {
  gif: "GIF",
  jpeg: "JPEG",
  jpg: "JPEG",
  png: "PNG",
  svg: "SVG",
  webp: "WEBP",
};

function compactBytes(bytes: number): string | null {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatFromPath(path: string | null): string | null {
  const match = path?.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
  return match ? EXTENSION_FORMATS[match[1].toLowerCase()] ?? null : null;
}

export function imageFilePresentation(
  source: string,
  originalPath: string | null,
): { format: string; size: string | null } {
  const data = source.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
  if (!data) {
    return {
      format: formatFromPath(originalPath) ?? "Image",
      size: null,
    };
  }

  const mime = data[1].toLowerCase();
  const payload = data[3];
  let bytes: number | null = null;
  if (data[2]) {
    const base64 = payload.replace(/\s/g, "");
    if (/^[a-z0-9+/]*={0,2}$/i.test(base64) && base64.length % 4 === 0) {
      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
      bytes = (base64.length * 3) / 4 - padding;
    }
  } else {
    try {
      bytes = new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
    } catch {
      bytes = null;
    }
  }

  return {
    format: MIME_FORMATS[mime] ?? formatFromPath(originalPath) ?? "Image",
    size: bytes === null ? null : compactBytes(bytes),
  };
}
