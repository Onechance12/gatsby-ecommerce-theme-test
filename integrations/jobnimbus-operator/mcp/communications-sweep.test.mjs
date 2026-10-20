import test from "node:test";
import assert from "node:assert/strict";
import { COMMUNICATION_SWEEP_ENABLED, validateCommunicationsSweepInput, assertCommunicationsSweepResult, readAttestedCommunications } from "./communications-sweep-release.mjs";
import { createOperatorCoordinator } from "./operator-coordinator.mjs";
const window = { days: 7, maxResults: 50, source: "all", start: "2026-10-13T10:00:00Z", end: "2026-10-20T10:00:00Z" };
const result = () => ({ mode: "read_only_discovery", effectsAuthorized: false, scope: "chance_own_mailbox_and_quo_line", complete: false, queue: [], window,
  coverage: { gmail: { status: "partial", mailbox: "cpearson@wavepa.com" }, quo: { status: "partial", lineNumber: "+12025550101" } } });
test("compiled release gate and fresh attestation precede every provider discovery read", async () => {
  const approvals = new Map([["existing", { preserved: true }]]);
  const requests = [];
  const operator = createOperatorCoordinator({ version: "candidate", approvals, bridgeRequest: async (method, pathname) => { requests.push({ method, pathname }); } });
  await assert.rejects(operator.reviewRecentCommunications({}), COMMUNICATION_SWEEP_ENABLED ? /attest|bound|identity|ready|operator/i : /not activated/);
  assert.equal(requests.length, COMMUNICATION_SWEEP_ENABLED ? 3 : 0);
  assert.equal(requests.every(request => request.method === "GET"), true);
  assert.equal(approvals.size, 1);
});
test("native input cannot request another mailbox, line, arbitrary query, or effect", () => {
  assert.deepEqual(validateCommunicationsSweepInput(), { days: 7, maxResults: 50, source: "all" });
  for (const input of [{ lineNumber: "+12025550102" }, { mailbox: "other@test" }, { query: "all" }, { execute: true }, { source: "company" }, { days: 31 }]) assert.throws(() => validateCommunicationsSweepInput(input));
});
test("native readback checks line, mailbox, window and excluded file", () => {
  const options = { request: validateCommunicationsSweepInput(), lineNumber: "+12025550101" };
  assert.equal(assertCommunicationsSweepResult(result(), options).complete, false);
  for (const mutate of [r => { r.effectsAuthorized = true; }, r => { r.coverage.gmail.mailbox = "other@test"; },
    r => { r.coverage.quo.lineNumber = "+12025550199"; }, r => { r.window = { ...window, days: 30 }; },
    r => { r.queue.push({ channel: "quo", direction: "incoming", fileMatch: { file: { number: "2628" } } }); }]) {
    const row = result(); mutate(row); assert.throws(() => assertCommunicationsSweepResult(row, options));
  }
});

test("enabled read path attests before and after without approval mutation or automatic retry", async () => {
  let reads = 0, attestations = 0;
  const verify = async () => { attestations += 1; return { ready: true, boundary: { boot: "same" }, lineNumber: "+12025550101" }; };
  const read = async request => { reads += 1; assert.deepEqual(request, { days: 7, maxResults: 50, source: "all" }); return result(); };
  assert.equal((await readAttestedCommunications({ verify, read })).effectsAuthorized, false);
  assert.equal(attestations, 2); assert.equal(reads, 1);
  reads = 0;
  await assert.rejects(readAttestedCommunications({ verify: async () => ({ ready: false }), read }), /ready attested/);
  assert.equal(reads, 0);
  attestations = 0;
  await assert.rejects(readAttestedCommunications({ read, verify: async () => ({ ready: true,
    boundary: { boot: String(++attestations) }, lineNumber: "+12025550101" }) }), /boundary changed/);
  assert.equal(reads, 1);
});

test("read failures are not retried and contradictory complete coverage is rejected", async () => {
  let reads = 0;
  await assert.rejects(readAttestedCommunications({ verify: async () => ({ ready: true, boundary: { boot: "same" } }),
    read: async () => { reads += 1; throw new Error("unavailable"); } }), /unavailable/);
  assert.equal(reads, 1);
  const row = result(); row.complete = true;
  assert.throws(() => assertCommunicationsSweepResult(row, { lineNumber: "+12025550101" }), /coverage/);
});
