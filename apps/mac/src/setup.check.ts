import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudAccountPresentation,
  shortcutRecorderLabel,
  syncPresentation,
  type SyncRuntimeStatus,
} from "./setup.ts";

function syncStatus(
  fields: Partial<SyncRuntimeStatus["summary"]> = {},
  warning: string | null = null,
): SyncRuntimeStatus {
  return {
    summary: {
      remotePending: 0,
      pending: 0,
      uploading: 0,
      retrying: 0,
      failed: 0,
      uploaded: 0,
      total: 0,
      ...fields,
    },
    annotationSummary: {
      pending: 0,
      uploading: 0,
      failed: 0,
      conflicts: 0,
      synced: 0,
      total: 0,
    },
    warning,
    lastSuccessAtMs: null,
    reconnectRequired: false,
  };
}

test("an unconfigured test build never asks for an email", () => {
  const presentation = cloudAccountPresentation(false, "signed_out");

  assert.equal(presentation.showEmailForm, false);
  assert.equal(presentation.status, "Not enabled in this test build");
  assert.match(presentation.message, /No email is needed/i);
});

test("a configured signed-out build explains which email to use", () => {
  const presentation = cloudAccountPresentation(true, "signed_out");

  assert.equal(presentation.showEmailForm, true);
  assert.match(presentation.message, /same email/i);
  assert.match(presentation.message, /web and Mac/i);
});

test("shortcut controls say that the displayed shortcut is editable", () => {
  assert.equal(shortcutRecorderLabel("⌃⇧C", false), "Change ⌃⇧C");
  assert.equal(shortcutRecorderLabel("⌃⇧C", true), "Press keys…");
});

test("a disconnected library promises only local persistence", () => {
  const presentation = syncPresentation(true, "signed_out", syncStatus({ pending: 2 }));

  assert.equal(presentation.status, "Saved on this Mac");
  assert.equal(presentation.action, null);
  assert.match(presentation.message, /remain available here/i);
});

test("queued captures are explicit, pluralized and retryable", () => {
  const one = syncPresentation(true, "signed_in", syncStatus({ pending: 1 }));
  const many = syncPresentation(
    true,
    "signed_in",
    syncStatus({ pending: 1, uploading: 1, retrying: 1 }),
  );

  assert.equal(one.title, "1 capture saved here");
  assert.equal(many.title, "3 captures saved here");
  assert.equal(many.action, "retry");
});

test("remote library adoption is downloading to this Mac, never waiting to upload", () => {
  const presentation = syncPresentation(
    true,
    "signed_in",
    syncStatus({ remotePending: 2, total: 2 }),
  );

  assert.equal(presentation.status, "Downloading library");
  assert.equal(presentation.title, "2 captures downloading to this Mac");
  assert.match(presentation.message, /available in History/i);
  assert.doesNotMatch(presentation.message, /saved here|upload/i);
  assert.equal(presentation.action, null);
});

test("a paused remote download never claims its cloud-only pixels are already local", () => {
  const presentation = syncPresentation(
    true,
    "signed_in",
    syncStatus({ remotePending: 1, total: 1 }, "Network download failed"),
  );

  assert.equal(presentation.title, "Library download paused");
  assert.match(presentation.message, /cloud library remains private and unchanged/i);
  assert.doesNotMatch(presentation.message, /originals remain saved on this Mac/i);
  assert.equal(presentation.action, "retry");
});

test("failed captures never imply that local originals were lost", () => {
  const presentation = syncPresentation(true, "signed_in", syncStatus({ failed: 2 }));

  assert.equal(presentation.status, "Needs attention");
  assert.equal(presentation.action, "details");
  assert.match(presentation.message, /originals remain saved on this Mac/i);
});

test("editable project conflicts outrank ordinary capture sync and route to History", () => {
  const runtime = syncStatus({ uploaded: 4 });
  runtime.annotationSummary = {
    pending: 0,
    uploading: 0,
    failed: 0,
    conflicts: 1,
    synced: 2,
    total: 3,
  };
  const presentation = syncPresentation(true, "signed_in", runtime);

  assert.equal(presentation.status, "Conflict");
  assert.equal(presentation.title, "1 editable project needs a choice");
  assert.equal(presentation.action, "history");
  assert.match(presentation.message, /local work is still safe/i);
});

test("queued editable projects are counted separately and remain retryable", () => {
  const runtime = syncStatus({ uploaded: 4 });
  runtime.annotationSummary = {
    pending: 2,
    uploading: 1,
    failed: 0,
    conflicts: 0,
    synced: 0,
    total: 3,
  };
  const presentation = syncPresentation(true, "signed_in", runtime);

  assert.equal(presentation.title, "3 editable projects waiting");
  assert.equal(presentation.action, "retry");
});

test("an empty connected queue reads as up to date", () => {
  const presentation = syncPresentation(true, "signed_in", syncStatus({ uploaded: 4 }));

  assert.equal(presentation.status, "Up to date");
  assert.equal(presentation.tone, "ready");
  assert.equal(presentation.action, null);
  assert.match(presentation.message, /All recent captures have synced/i);
});

test("a durable acknowledgement time becomes honest relative last-sync copy", () => {
  const runtime = syncStatus({ uploaded: 4 });
  runtime.lastSuccessAtMs = 1_000_000;
  const presentation = syncPresentation(true, "signed_in", runtime, 1_300_000);

  assert.equal(
    presentation.message,
    "Last synced 5 minutes ago. All recent captures are in your private library.",
  );
});

test("an expired session asks for same-account reconnect without threatening local pixels", () => {
  const runtime = syncStatus({ pending: 2 }, "Supabase rejected the saved session");
  runtime.reconnectRequired = true;
  const presentation = syncPresentation(true, "signed_in", runtime);

  assert.equal(presentation.status, "Reconnect account");
  assert.equal(presentation.action, "reconnect");
  assert.match(presentation.message, /originals remain saved on this Mac/i);
  assert.match(presentation.message, /same account/i);
});

test("remote device revocation is distinct from session expiry and preserves local originals", () => {
  const presentation = syncPresentation(true, "signed_in", {
    summary: { remotePending: 0, pending: 2, uploading: 0, retrying: 0, failed: 0, uploaded: 4, total: 6 },
    annotationSummary: { pending: 0, uploading: 0, failed: 0, conflicts: 0, synced: 0, total: 0 },
    warning: "This Mac was disconnected from Capso. Reconnect the same account to resume sync.",
    lastSuccessAtMs: 1_723_076_880_000,
    reconnectRequired: true,
  });
  assert.equal(presentation.status, "Reconnect this Mac");
  assert.equal(presentation.title, "This Mac was disconnected");
  assert.match(presentation.message, /originals remain saved on this Mac/i);
  assert.equal(presentation.action, "reconnect");
});

test("account settings source exposes a device identity and web-library escape hatch", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./App.tsx", import.meta.url), "utf8")
  );
  assert.match(source, /get_device_info/);
  assert.match(source, /This Mac/);
  assert.match(source, /Open web library/);
  assert.match(source, /open_web_library/);
});

test("first run makes cloud connection explicit without auto-starting sign-in", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./FirstRun.tsx", import.meta.url), "utf8")
  );

  assert.match(source, /Connect library/);
  assert.match(source, /Use this Mac only/);
  assert.match(source, /Chrome extension/);
  assert.match(source, /get_auth_status/);
  assert.match(source, /onSubmit=\{requestSignIn\}/);
  assert.match(source, /request_sign_in_email/);
  assert.match(source, /localStorage\.setItem\(LIBRARY_CHOICE, "local_only"\)/);
  assert.doesNotMatch(
    source,
    /useEffect\([\s\S]{0,500}request_sign_in_email/,
    "mounting first run must not send a sign-in email",
  );
});

test("advanced settings expose bounded portable preferences without account or capture data", async () => {
  const fs = await import("node:fs/promises");
  const [view, native, transfer] = await Promise.all([
    fs.readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src-tauri/src/settings_transfer.rs", import.meta.url), "utf8"),
  ]);

  assert.match(view, /Settings portability/);
  assert.match(view, /Export settings/);
  assert.match(view, /Import settings/);
  assert.match(view, /Reset all settings/);
  assert.match(view, /never includes your account, captures, upload queue, or editable projects/i);
  assert.match(view, /window\.confirm/);
  assert.match(view, /export_portable_settings/);
  assert.match(view, /import_portable_settings/);
  assert.match(view, /reset_portable_settings/);
  assert.match(native, /SettingsTransferRuntime/);
  assert.match(native, /apply_document_files/);
  assert.match(transfer, /MAX_SETTINGS_DOCUMENT_BYTES: usize = 256 \* 1024/);
  assert.match(transfer, /Capso settings contain an unknown/);
  assert.match(transfer, /rollback_files/);
});
