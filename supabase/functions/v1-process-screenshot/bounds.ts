export const MAX_PROJECT_NAME_BYTES = 160;
export const MAX_PROJECT_DESCRIPTION_BYTES = 256;
export const MAX_CORRECTION_BYTES = 700;
export const MAX_PAGE_URL_BYTES = 2_048;
export const MAX_PAGE_TITLE_BYTES = 512;
export const MAX_PROMPT_BYTES = 48 * 1_024;
export const MAX_CONTEXT_RESPONSE_BYTES = 512 * 1_024;

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Length(value: string) {
  return encoder.encode(value).length;
}

export function truncateUtf8(value: string, maxBytes: number) {
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;

  // UTF-8 uses at most four bytes per code point, so this loop executes no more
  // than three times before landing on a valid boundary.
  for (let end = maxBytes; end > Math.max(0, maxBytes - 4); end -= 1) {
    try {
      return fatalDecoder.decode(bytes.subarray(0, end));
    } catch {
      // Try the preceding code-point boundary.
    }
  }
  return "";
}
