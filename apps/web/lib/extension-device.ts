/** Shape shared by the pairing UI and its same-origin account endpoint. */
export const EXTENSION_DEVICE_TOKEN = /^d_[A-Za-z0-9_-]{16,62}$/;
export const EXTENSION_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ExtensionDevice = {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastCaptureAt: string | null;
};

export function extensionDeviceActivity(device: ExtensionDevice): string {
  if (!device.lastCaptureAt) return "Ready · no captures delivered yet";
  const time = new Date(device.lastCaptureAt);
  if (!Number.isFinite(time.getTime())) return "Last delivery time unavailable";
  return `Last delivered ${time.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** Persist only a one-way fingerprint; the raw code remains in the browser profile. */
export async function extensionDeviceHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
