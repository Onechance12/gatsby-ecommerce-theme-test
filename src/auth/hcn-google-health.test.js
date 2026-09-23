import assert from "node:assert/strict";
import test from "node:test";
import { checkHcnGmailHealth } from "./hcn-google-health.js";

const good = { email: "synthetic@wavepa.com", getAccessToken: async () => "secret-fixture",
  readProfile: async () => ({ emailAddress: "SYNTHETIC@wavepa.com" }) };
test("saved authorization alone is not live Gmail health", async () => {
  assert.deepEqual(await checkHcnGmailHealth(good), { gmail: "connected", verification: "live", reason: "verified" });
  for (const error of [{ hcnSourceFailureCode: "google_not_linked" }, { statusCode: 401 }]) {
    const result = await checkHcnGmailHealth({ ...good, getAccessToken: async () => { throw error; } });
    assert.equal(result.gmail, "not_connected");
    assert.equal(result.reason, "reconnect_required");
  }
});
test("wrong account, provider outage and malformed replies are not healthy", async () => {
  assert.equal((await checkHcnGmailHealth({ ...good, readProfile: async () => { throw { statusCode: 403 }; } })).reason, "permission_denied");
  for (const profile of [{ emailAddress: "other@wavepa.com" }, {}]) {
    assert.equal((await checkHcnGmailHealth({ ...good, readProfile: async () => profile })).reason, "account_mismatch");
  }
  const result = await checkHcnGmailHealth({ ...good, readProfile: async () => { throw new Error("secret-provider-body"); } });
  assert.equal(result.gmail, "unavailable");
  assert.equal(result.reason, "provider_check_failed");
  assert.ok(!JSON.stringify(result).includes("secret"));
});
