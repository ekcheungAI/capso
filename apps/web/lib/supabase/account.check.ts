import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPermanentAccount,
  requestPermanentAccountLink,
  requirePermanentUserId,
} from "./account.ts";

test("a persisted anonymous session is discarded instead of becoming the fresh library", async () => {
  const signOutCalls: unknown[] = [];
  const account = await loadPermanentAccount({
    async getSession() {
      return {
        data: {
          session: {
            user: {
              id: "anonymous-user",
              email: null,
              is_anonymous: true,
            },
          },
        },
        error: null,
      };
    },
    async signOut(options) {
      signOutCalls.push(options);
      return { error: null };
    },
  });

  assert.deepEqual(account, { status: "signed_out" });
  assert.deepEqual(signOutCalls, [{ scope: "local" }]);
});

test("an email session becomes the one remote-library owner", async () => {
  let signedOut = false;
  const account = await loadPermanentAccount({
    async getSession() {
      return {
        data: {
          session: {
            user: {
              id: "email-user",
              email: "owner@example.com",
              is_anonymous: false,
            },
          },
        },
        error: null,
      };
    },
    async signOut() {
      signedOut = true;
      return { error: null };
    },
  });

  assert.deepEqual(account, {
    status: "signed_in",
    userId: "email-user",
    email: "owner@example.com",
  });
  assert.equal(requirePermanentUserId(account), "email-user");
  assert.equal(signedOut, false);
});

test("requesting a link creates the fresh permanent account and returns to this web origin", async () => {
  let request: unknown;
  await requestPermanentAccountLink(
    {
      async signInWithOtp(credentials) {
        request = credentials;
        return { error: null };
      },
    },
    "  owner@example.com  ",
    "https://capso.example",
  );

  assert.deepEqual(request, {
    email: "owner@example.com",
    options: {
      shouldCreateUser: true,
      emailRedirectTo: "https://capso.example",
    },
  });
});

test("an unsigned-in account cannot silently select the remote backend", () => {
  assert.throws(
    () => requirePermanentUserId({ status: "signed_out" }),
    /Sign in to open your Capso library/i,
  );
});
