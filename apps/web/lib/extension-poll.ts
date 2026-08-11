import { uuidFromSeed } from "./store/map.ts";

export const EXTENSION_POLL_INTERVAL_MS = 2_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Existing outboxes used `c_<timestamp>...`; remote Postgres ids are UUIDs. */
export function extensionCaptureId(relayId: string): string {
  return UUID.test(relayId) ? relayId : uuidFromSeed(`extension:${relayId}`);
}

/**
 * Headed browsers can emit several focus events while a driver or window
 * manager hands focus around. Treat focus as a wake-up hint, not permission to
 * bypass the regular extension polling cadence.
 */
export function shouldStartExtensionPoll(now: number, lastStartedAt: number): boolean {
  return now - lastStartedAt >= EXTENSION_POLL_INTERVAL_MS;
}
