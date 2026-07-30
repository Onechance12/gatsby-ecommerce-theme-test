import assert from "node:assert/strict";
import test from "node:test";

import {
  HcnGoogleGrantRevocationError,
  revokeHcnGoogleRefreshGrant
} from "./hcn-google-grant-revocation.js";

test("revocation sends only the refresh grant to the pinned endpoint", async () => {
  let observed;
  const result = await revokeHcnGoogleRefreshGrant({
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return new Response("", { status: 200 });
    },
    endpoint: "https://oauth2.googleapis.com/revoke",
    refreshToken: "fixture-refresh-token"
  });

  assert.deepEqual(result, {
    provider: "google",
    status: "revoked"
  });
  assert.equal(
    observed.url,
    "https://oauth2.googleapis.com/revoke"
  );
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.redirect, "error");
  assert.equal(
    observed.options.body.get("token"),
    "fixture-refresh-token"
  );
  assert.equal(
    JSON.stringify(result).includes("fixture-refresh-token"),
    false
  );
});

test("already-invalid grants are terminal but other provider failures are not", async () => {
  const invalid = await revokeHcnGoogleRefreshGrant({
    fetchImpl: async () => new Response(
      JSON.stringify({ error: "invalid_token" }),
      {
        status: 400,
        headers: { "content-type": "application/json" }
      }
    ),
    endpoint: "https://oauth2.googleapis.com/revoke",
    refreshToken: "fixture-refresh-token"
  });
  assert.equal(invalid.status, "already_invalid");

  await assert.rejects(
    revokeHcnGoogleRefreshGrant({
      fetchImpl: async () => new Response(
        JSON.stringify({ error: "invalid_request" }),
        {
          status: 400,
          headers: { "content-type": "application/json" }
        }
      ),
      endpoint: "https://oauth2.googleapis.com/revoke",
      refreshToken: "fixture-refresh-token"
    }),
    HcnGoogleGrantRevocationError
  );
  await assert.rejects(
    revokeHcnGoogleRefreshGrant({
      fetchImpl: async () => new Response("", { status: 503 }),
      endpoint: "https://oauth2.googleapis.com/revoke",
      refreshToken: "fixture-refresh-token"
    }),
    HcnGoogleGrantRevocationError
  );
});

test("network, timeout, malformed endpoint, and malformed grant fail closed", async () => {
  await assert.rejects(
    revokeHcnGoogleRefreshGrant({
      fetchImpl: async () => {
        throw new Error("provider details");
      },
      endpoint: "https://oauth2.googleapis.com/revoke",
      refreshToken: "fixture-refresh-token"
    }),
    /revocation is unavailable/
  );
  await assert.rejects(
    revokeHcnGoogleRefreshGrant({
      fetchImpl: async (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        }),
      endpoint: "https://oauth2.googleapis.com/revoke",
      refreshToken: "fixture-refresh-token",
      timeoutMs: 100
    }),
    /timed out/
  );
  await assert.rejects(
    revokeHcnGoogleRefreshGrant({
      fetchImpl: async () => new Response("", { status: 200 }),
      endpoint: "https://evil.example/revoke?token=leak",
      refreshToken: "fixture-refresh-token"
    }),
    /canonical/
  );
  await assert.rejects(
    revokeHcnGoogleRefreshGrant({
      fetchImpl: async () => new Response("", { status: 200 }),
      endpoint: "https://oauth2.googleapis.com/revoke",
      refreshToken: "contains a space"
    }),
    /refreshToken is invalid/
  );
});
