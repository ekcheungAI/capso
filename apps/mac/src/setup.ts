export type AccountStatus = "signed_in" | "signed_out";

export type CloudAccountPresentation = {
  status: string;
  message: string;
  showEmailForm: boolean;
};

export function cloudAccountPresentation(
  configured: boolean,
  accountStatus: AccountStatus,
): CloudAccountPresentation {
  if (!configured) {
    return {
      status: "Not enabled in this test build",
      message:
        "No email is needed. Captures stay private on this Mac while cloud sync is being connected.",
      showEmailForm: false,
    };
  }
  if (accountStatus === "signed_in") {
    return {
      status: "Connected",
      message: "This Mac is connected to your private Capso library.",
      showEmailForm: false,
    };
  }
  return {
    status: "Connect account",
    message:
      "Use the same email for Capso on the web and Mac so both libraries belong to one account.",
    showEmailForm: true,
  };
}

export function shortcutRecorderLabel(
  shortcut: string,
  recording: boolean,
) {
  return recording ? "Press keys…" : `Change ${shortcut}`;
}
