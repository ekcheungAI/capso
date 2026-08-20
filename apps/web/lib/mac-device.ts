import { EXTENSION_DEVICE_ID } from "./extension-device.ts";

export const MAC_DEVICE_ID = EXTENSION_DEVICE_ID;

export type MacDevice = {
  id: string;
  label: string;
  platform: string;
  appVersion: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastCaptureAt: string | null;
};

export function macDeviceActivity(device: MacDevice): string {
  const version = device.appVersion ? `Capso ${device.appVersion}` : "Capso";
  if (!device.lastCaptureAt) return `${device.platform} · ${version} · ready`;
  const time = new Date(device.lastCaptureAt);
  if (!Number.isFinite(time.getTime())) return `${device.platform} · last sync unavailable`;
  return `${device.platform} · ${version} · Last synced ${time.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
