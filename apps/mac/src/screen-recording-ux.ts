export type ScreenRecordingIdentity = "stable" | "buildSpecific" | "unknown";

export type ScreenRecordingAccess = {
  screenRecording: "granted" | "required";
  screenRecordingRequestAttempted: boolean;
  screenRecordingIdentity: ScreenRecordingIdentity;
};

export type ScreenRecordingPresentation = {
  stateLabel: string;
  captureDetail: string;
  notice: string;
  noticeTone: "success" | "attention";
  primaryAction: "request" | "settings" | null;
  primaryLabel: "Grant access" | "Open settings" | null;
  showRestart: boolean;
};

export function screenRecordingPresentation(
  status: ScreenRecordingAccess,
): ScreenRecordingPresentation {
  if (status.screenRecording === "granted") {
    return {
      stateLabel: "All modes ready",
      captureDetail: "Area, Window, and Full Screen are ready.",
      notice: "Screen capture access is ready.",
      noticeTone: "success",
      primaryAction: null,
      primaryLabel: null,
      showRestart: false,
    };
  }

  const attempted = status.screenRecordingRequestAttempted;
  const notice =
    status.screenRecordingIdentity === "buildSpecific"
      ? "This development build has a temporary macOS identity. System Settings may show an older Capso build as enabled; grant access to this build, then restart Capso."
      : status.screenRecordingIdentity === "unknown"
        ? "Capso could not verify that this build has a stable macOS identity. Use a verified signed build, grant Screen Recording to that build, then restart Capso."
      : attempted
        ? "This installed build is not authorized yet. If System Settings already shows Capso on, turn Capso off and on there, then restart Capso."
        : "macOS must authorize this installed build before Capso can save Area, Window, or Full Screen screenshots.";

  return {
    stateLabel: "Setup required",
    captureDetail: "Screen Recording is required for Area, Window, and Full Screen.",
    notice,
    noticeTone: "attention",
    primaryAction: attempted ? "settings" : "request",
    primaryLabel: attempted ? "Open settings" : "Grant access",
    showRestart: attempted,
  };
}
