export type MicrophonePermission =
  | "not_determined"
  | "restricted"
  | "denied"
  | "authorized"
  | "unavailable";

export type RecordingAudioDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type RecordingCapabilities = {
  microphonePermission: MicrophonePermission;
  microphoneDevices: RecordingAudioDevice[];
};

export type MicrophoneRecovery =
  | "none"
  | "request_access"
  | "open_settings"
  | "connect_device"
  | "choose_device"
  | "unavailable";

export function microphoneReadiness(
  enabled: boolean,
  selectedId: string | null,
  capabilities: RecordingCapabilities,
) {
  if (!enabled) {
    return {
      ready: true,
      selectedMissing: false,
      selectedName: "Microphone off",
      recovery: "none" as const,
    };
  }
  if (capabilities.microphonePermission === "not_determined") {
    return {
      ready: false,
      selectedMissing: false,
      selectedName: "Permission required",
      recovery: "request_access" as const,
    };
  }
  if (
    capabilities.microphonePermission === "denied"
    || capabilities.microphonePermission === "restricted"
  ) {
    return {
      ready: false,
      selectedMissing: false,
      selectedName: "Permission denied",
      recovery: "open_settings" as const,
    };
  }
  if (capabilities.microphonePermission !== "authorized") {
    return {
      ready: false,
      selectedMissing: false,
      selectedName: "Unavailable",
      recovery: "unavailable" as const,
    };
  }
  if (capabilities.microphoneDevices.length === 0) {
    return {
      ready: false,
      selectedMissing: false,
      selectedName: "No microphone connected",
      recovery: "connect_device" as const,
    };
  }
  if (selectedId === null) {
    return {
      ready: true,
      selectedMissing: false,
      selectedName:
        capabilities.microphoneDevices.find((device) => device.isDefault)?.name
        ?? "System default",
      recovery: "none" as const,
    };
  }
  const selected = capabilities.microphoneDevices.find((device) => device.id === selectedId);
  if (!selected) {
    return {
      ready: false,
      selectedMissing: true,
      selectedName: "Disconnected source",
      recovery: "choose_device" as const,
    };
  }
  return {
    ready: true,
    selectedMissing: false,
    selectedName: selected.name,
    recovery: "none" as const,
  };
}
