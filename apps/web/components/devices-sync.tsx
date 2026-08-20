"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Browser, Desktop, SpinnerGap, X } from "@phosphor-icons/react";
import {
  extensionDeviceActivity,
  type ExtensionDevice,
} from "@/lib/extension-device";
import { macDeviceActivity, type MacDevice } from "@/lib/mac-device";
import { accountFetch } from "@/lib/supabase/client";

export function DevicesAndSync({ email, onNavigate }: { email: string; onNavigate: () => void }) {
  type ConnectedDevice =
    | ({ kind: "chrome" } & ExtensionDevice)
    | ({ kind: "mac" } & MacDevice);
  const [devices, setDevices] = useState<ConnectedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const revokeRequest = useRef(false);

  const loadDevices = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setDevices(null);
    setError(null);
    try {
      const [chromeResponse, macResponse] = await Promise.all([
        accountFetch("/api/extension/devices", { cache: "no-store", signal }),
        accountFetch("/api/mac/devices", { cache: "no-store", signal }),
      ]);
      if (!chromeResponse.ok || !macResponse.ok) throw new Error("Could not load connected devices.");
      const chrome = await chromeResponse.json() as { devices?: ExtensionDevice[] };
      const mac = await macResponse.json() as { devices?: MacDevice[] };
      if (signal?.aborted) return;
      setDevices([
        ...(mac.devices ?? []).map((device) => ({ ...device, kind: "mac" as const })),
        ...(chrome.devices ?? []).map((device) => ({ ...device, kind: "chrome" as const })),
      ]);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "Could not load connected devices.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Start from an external callback so mount itself stays subscription-like
    // and cannot synchronously cascade state through the Settings panel.
    const timeout = window.setTimeout(() => void loadDevices(controller.signal), 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [loadDevices]);

  async function revoke(device: ConnectedDevice) {
    if (!confirm(`Disconnect ${device.label}? It will stop syncing new captures. Captures already in ${email} stay in your library.`)) return;
    if (revokeRequest.current) return;
    revokeRequest.current = true;
    setRevoking(device.id);
    setError(null);
    setNotice(null);
    try {
      const response = await accountFetch(
        device.kind === "mac" ? "/api/mac/devices" : "/api/extension/devices",
        {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: device.id }),
        },
      );
      if (!response.ok) throw new Error("Could not disconnect this device.");
      setDevices((current) => current?.filter((item) => item.id !== device.id) ?? []);
      setNotice(`${device.label} disconnected. Existing captures remain in ${email}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect this device.");
    } finally {
      setRevoking(null);
      revokeRequest.current = false;
    }
  }

  return (
    <section aria-labelledby="devices-sync-title" className="rounded-xl bg-background px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="devices-sync-title" className="font-semibold text-foreground">Devices &amp; sync</h3>
          <p className="mt-0.5 text-xs leading-5">This browser is connected to {email}.</p>
        </div>
        {!devices && !error && <SpinnerGap aria-label="Loading devices" className="mt-0.5 animate-spin" size={16} />}
      </div>

      {devices && devices.length === 0 && (
        <p className="mt-3 text-xs leading-5">No capture device is connected.</p>
      )}
      {devices && devices.length > 0 && (
        <ul className="mt-3 grid gap-2">
          {devices.map((device) => (
            <li key={device.id} className="grid grid-cols-[auto_minmax(0,1fr)_44px] items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2">
              {device.kind === "mac"
                ? <Desktop aria-hidden size={17} className="shrink-0 text-foreground" />
                : <Browser aria-hidden size={17} className="shrink-0 text-foreground" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">{device.label}</p>
                <p className="truncate text-xs">
                  {device.kind === "mac" ? macDeviceActivity(device) : extensionDeviceActivity(device)}
                </p>
              </div>
              <button
                type="button"
                disabled={revoking !== null}
                onClick={() => void revoke(device)}
                aria-label={`Disconnect ${device.label}`}
                title="Disconnect device"
                className="grid min-h-11 min-w-11 place-items-center rounded-lg text-muted hover:bg-background hover:text-danger disabled:opacity-50"
              >
                {revoking === device.id ? <SpinnerGap className="animate-spin" size={16} /> : <X size={16} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-xs leading-5 text-danger">{error}</p>}
      {error && (
        <button
          type="button"
          onClick={() => void loadDevices()}
          className="mt-2 min-h-11 rounded-lg border border-line px-3 text-xs font-semibold"
        >
          Retry devices
        </button>
      )}
      {notice && <p role="status" aria-live="polite" className="mt-2 text-xs leading-5">{notice}</p>}
      <Link href="/extension" onClick={onNavigate} className="mt-2 flex min-h-11 items-center font-medium text-accent">
        Connect or update Chrome
      </Link>
    </section>
  );
}
