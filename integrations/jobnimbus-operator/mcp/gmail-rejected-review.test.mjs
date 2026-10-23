import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOperatorCoordinator } from "./operator-coordinator.mjs";
import { GMAIL_REJECTED_REVIEW_ENABLED, readAttestedRejectedGmail, validateRejectedReviewInput } from "./gmail-rejected-review-release.mjs";

// Synthetic protocol contracts only, not native-app-host or live-provider proof.
const reference = { v: 1, purpose: "rejected_email_inspection", expiresAt: Date.now() + 60000,
  binding: { fileId: "synthetic-file", mailbox: "owner@example.test" }, messageId: "mail1", threadId: "thread1", decision: "missing_unique_target_evidence" };
const input = { fileQuery: "#990001", reviewRef: `${Buffer.from(JSON.stringify(reference)).toString("base64url")}.synthetic` };
const evidence = () => ({ mode: "rejected_email_inspection", readOnly: true, verifiedFileEvidence: false, authorizesAction: false,
  scope: "chance_own_mailbox_rejected_candidate", file: { id: reference.binding.fileId, number: "990001" },
  mailbox: reference.binding.mailbox, decision: reference.decision, observedAt: new Date().toISOString(),
  sourceChanged: false, originalRejectionUnchanged: true, correlationAudit: { readOnly: true, changesAdmission: false },
  message: { id: reference.messageId, threadId: reference.threadId, bodyTruncated: false, attachmentBodiesReviewed: false, attachments: [] } });

test("both compiled inspection states preserve the sorted exact capability contract", async t => {
  for (const enabled of [false, true]) {
    const directory = await mkdtemp(path.join(tmpdir(), "operator-synthetic-inspection-capabilities-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const name of ["scope.mjs", "communications-sweep-release.mjs", "approved-note-release.mjs",
      "pdf-upload-release.mjs", "pdf-upload-contract.mjs", "quo-sms-release.mjs", "quo-sms-contract.mjs"]) {
      await copyFile(new URL(name, import.meta.url), path.join(directory, name));
    }
    const source = await readFile(new URL("./gmail-rejected-review-release.mjs", import.meta.url), "utf8");
    await writeFile(path.join(directory, "gmail-rejected-review-release.mjs"),
      source.replace(/GMAIL_REJECTED_REVIEW_ENABLED = (?:true|false)/, "GMAIL_REJECTED_REVIEW_ENABLED = " + enabled));
    const scope = await import(pathToFileURL(path.join(directory, "scope.mjs")));
    const capabilities = scope.EXPECTED_OPERATOR_CAPABILITIES;
    assert.deepEqual([...capabilities], [...capabilities].sort());
    assert.equal(capabilities.includes("gmail.rejected_candidates.review"), enabled);
    assert.equal(new Set(capabilities).size, capabilities.length);
    assert.equal(capabilities.some(value => value.includes(".send")), false);
  }
});

test("inactive coordinator stops before bridge reads and exposes no approval/effect", async () => {
  const requests = [];
  const operator = createOperatorCoordinator({ version: "0.0.0-synthetic", bridgeRequest: async (...args) => { requests.push(args); return {}; } });
  await assert.rejects(operator.reviewRejectedGmail(input), GMAIL_REJECTED_REVIEW_ENABLED ? /attest|bound|ready|identity/ : /not activated/);
  assert.equal(requests.length, GMAIL_REJECTED_REVIEW_ENABLED ? 3 : 0);
});

test("inspection checks a ready unchanged boundary before and after one exact read", async () => {
  const calls = [];
  const result = await readAttestedRejectedGmail({ input,
    verify: async () => { calls.push("verify"); return { ready: true, boundary: { boot: "synthetic" } }; },
    read: async request => { calls.push("read"); assert.deepEqual(request, input); return evidence(); } });
  assert.equal(result.authorizesAction, false);
  assert.deepEqual(calls, ["verify", "read", "verify"]);
});

test("invalid input or unready boundary cannot reach the synthetic reader", async () => {
  for (const value of [{ ...input, execute: true }, { ...input, messageId: "arbitrary" }, { ...input, reviewRef: "" }]) {
    assert.throws(() => validateRejectedReviewInput(value));
  }
  let reads = 0;
  await assert.rejects(readAttestedRejectedGmail({ input, verify: async () => ({ ready: false }), read: async () => { reads++; } }), /ready/);
  assert.equal(reads, 0);
});

test("changed bridge boundary or changed response scope withholds the result", async () => {
  let count = 0;
  await assert.rejects(readAttestedRejectedGmail({ input,
    verify: async () => ({ ready: true, boundary: { boot: ++count } }), read: async () => evidence() }), /boundary changed/);
  for (const mutate of [
    row => { row.authorizesAction = true; }, row => { row.verifiedFileEvidence = true; },
    row => { row.message.id = "other"; }, row => { row.message.threadId = "other"; },
    row => { row.file.id = "other"; }, row => { row.file.number = "2628"; },
    row => { row.mailbox = "other@example.test"; }, row => { row.sourceChanged = true; },
    row => { row.correlationAudit.changesAdmission = true; },
    row => { row.message.attachments = [{ attachmentRef: "forbidden" }]; }
  ]) {
    const row = evidence(); mutate(row);
    await assert.rejects(readAttestedRejectedGmail({ input,
      verify: async () => ({ ready: true, boundary: {} }), read: async () => row }), /response contract/);
  }
});
