import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { approvedNoteContentHash, approvedNoteMentionIntent } from "./jobnimbus/approved-note.js";
import { assertApprovedNotePlan } from "../integrations/jobnimbus-operator/mcp/approved-note-plan.mjs";
import {
  CHANCE_OPERATOR_ALLOWED_ACTION_TYPES, CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS,
  CHANCE_OPERATOR_NOTES_ALLOWED_ACTION_TYPES, loadChanceOperatorRunManifest
} from "./operations/thresher-policy.js";

const TOKEN = "fixture-codex-mac-note-operator-token-1234567890";
const OWNER = "fc95a213f70e4c9daddc5fa366be9941";
const file = (number, jnid) => ({
  number, jnid, record_type_name: "Insurance", owners: [{ id: OWNER }],
  is_active: true, is_archived: false, is_closed: false, is_deleted: false,
  display_name: "Fixture Client", status_name: "Ready for PA Review"
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "approved-note-test-"));
  const state = {
    posts: 0, notes: [], resultMode: "normal", wrongReadback: false,
    wrongReadbackFile: false, conflictingId: false, body: null, hideNotes: false
  };
  const contacts = [file(2739, "contact-chance"), file(2741, "contact-second"), file(2628, "contact-excluded")];
  const api = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const respond = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/contacts") {
      return respond(200, { contacts, count: contacts.length });
    }
    const contact = contacts.find((row) => url.pathname === `/contacts/${row.jnid}`);
    if (contact && req.method === "GET") return respond(200, contact);
    if (url.pathname === "/activities" && req.method === "GET") {
      const filter = JSON.parse(url.searchParams.get("filter") || "{}");
      const id = Object.values(filter.must?.[0]?.term || {})[0];
      const notes = state.hideNotes ? [] : state.notes.filter((row) => row.primary.id === id);
      const from = Number(url.searchParams.get("from") || 0);
      return respond(200, { activities: notes.slice(from, from + 1000), count: notes.length });
    }
    if (url.pathname === "/activities" && req.method === "POST") {
      state.posts++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      state.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const row = { ...state.body, jnid: `created-note-${state.posts}` };
      if (state.resultMode === "reused_id") {
        const existing = state.notes[0];
        Object.assign(existing, state.body);
        return respond(200, { jnid: existing.jnid });
      }
      if (state.resultMode !== "not_written") state.notes.push(row);
      if (["timeout", "not_written"].includes(state.resultMode)) return req.socket.destroy();
      if (state.resultMode === "missing_id") return respond(200, { accepted: true });
      return respond(200, { jnid: row.jnid });
    }
    const note = state.notes.find((row) => url.pathname === `/activities/${row.jnid}`);
    if (note) return respond(200, {
      ...note,
      ...(state.conflictingId ? { id: "conflicting-id" } : {}),
      ...(state.wrongReadback ? { note: "Wrong body" } : {}),
      ...(state.wrongReadbackFile ? { primary: { id: "contact-second" } } : {})
    });
    return respond(404, { error: "Fixture record missing" });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const input = {
    schemaVersion: 1, id: options.legacy ? "chance-58-files-v1" : "chance-58-files-notes-v1",
    operatorScope: "assigned", expiresAt: "2099-01-01T00:00:00.000Z",
    files: [
      { number: "2739", fileId: "contact-chance" }, { number: "2741", fileId: "contact-second" },
      ...Array.from({ length: 56 }, (_, index) => ({ number: String(4000 + index), fileId: `fixture-id-${index}` }))
    ],
    excludedFileNumbers: ["2628"],
    allowedActionTypes: [...(options.legacy ? CHANCE_OPERATOR_ALLOWED_ACTION_TYPES : CHANCE_OPERATOR_NOTES_ALLOWED_ACTION_TYPES)],
    allowedContactFields: [...CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS]
  };
  const manifest = loadChanceOperatorRunManifest(input);
  const runPolicy = { id: manifest.id, sha256: manifest.sha256 };
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", PORT: String(port),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_MAC_OPERATOR_TOKEN: TOKEN,
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${api.address().port}`,
      JOBNIMBUS_API_KEY: "fixture-key", MEMORY_ROOT: root,
      REQUIRE_CHANCE_RUN_POLICY: "true", CHANCE_OPERATOR_RUN_MANIFEST_JSON: JSON.stringify(input),
      BRIDGE_ALLOW_WRITES: "true", ALLOW_GOOGLE_USER_AUTH: "false",
      ...(options.failLedgerAt ? { ACTION_BATCH_LEDGER_TEST_FAIL_AT: String(options.failLedgerAt) } : {})
    }, stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await new Promise((resolve) => api.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, logs);
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const prepare = (operations) => request("/ops/action-batch", { runPolicy, operations, execute: false });
  const execute = (operations, plan) => request("/ops/action-batch", {
    runPolicy, operations, execute: true,
    approvalDigest: plan.approvalDigest, approvalChallenge: plan.approvalChallenge
  });
  return { state, request, prepare, execute, root, contacts };
}

const operation = (note = "Paused due to license.", query = "#2739") => ({
  type: "jobnimbus.create_note", payload: { query, note }
});

test("a provider-reused existing activity ID cannot certify new note creation", async (t) => {
  const f = await fixture(t);
  f.state.notes.push({ jnid: "existing-note-1", primary: { id: "contact-chance" }, note: "Earlier note", record_type_name: "Note" });
  f.state.resultMode = "reused_id";
  const operations = [operation()];
  const planned = await f.prepare(operations);
  assert.equal(planned.status, 200);
  const result = await f.execute(operations, planned.body);
  assert.equal(result.body.mode, "partial_failure");
  assert.equal(result.body.batch.completed.length, 0);
  assert.equal(f.state.posts, 1);
  const reconciled = await f.request("/ops/action-batch-reconcile", { batchId: result.body.batch.id });
  assert.equal(reconciled.body.mode, "manual_quarantined");
  assert.equal(f.state.posts, 1);
});

test("approved note opt-in leaves the live five-action lane closed", async (t) => {
  const f = await fixture(t, { legacy: true });
  const rejected = await f.prepare([operation()]);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /blocks.*create_note/);
  assert.equal(f.state.posts, 0);
});

test("approved notes reject extra fields, mentions, mixed actions and wrong files before effects", async (t) => {
  const f = await fixture(t);
  for (const operations of [
    [operation(), operation("Another note", "#2741")],
    [operation(), { type: "jobnimbus.update_contact", payload: { query: "#2739", fields: { city: "Dallas" } } }],
    [{ ...operation(), payload: { ...operation().payload, mentions: ["accounting"] } }],
    [operation("@Accounting: payment issued")], [operation("Payment issued", "#2628")],
    [operation("@RichardR @RichardR: payment issued")], [operation("@richard: payment issued")],
    [operation("email@RichardR")], [operation("@RichardRextra")],
    [operation("Payment issued", "#9999")]
  ]) {
    const response = await f.prepare(operations);
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  const direct = await f.request("/jobnimbus/create-note", { query: "#2739", note: "No direct route", execute: true });
  assert.equal(direct.status, 403);
  f.state.notes.push({ jnid: "inventory-id", id: "conflicting-id", primary: { id: "contact-chance" }, note: "Some other note", record_type_name: "Note" });
  const ambiguousInventory = await f.prepare([operation()]);
  assert.equal(ambiguousInventory.status, 409);
  assert.equal(f.state.posts, 0);
});

test("approved note exact digest, readback, receipt and duplicate protection", async (t) => {
  const f = await fixture(t);
  const operations = [operation()];
  const planned = await f.prepare(operations);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.doesNotThrow(() => assertApprovedNotePlan(planned.body, operations, "assigned", { enabled: true }));
  assert.equal(planned.body.runPolicy.noteCreationAllowed, true);
  assert.equal(planned.body.runPolicy.noteMentionsAllowed, false);
  assert.equal(planned.body.runPolicy.noteMentionRequestsAllowed, true);
  const changed = await f.execute([operation("Different body")], planned.body);
  assert.equal(changed.status, 409);
  const wrongFile = await f.execute([operation(undefined, "#2741")], planned.body);
  assert.equal(wrongFile.status, 409);
  const result = await f.execute(operations, planned.body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.mode, "executed");
  assert.equal(JSON.stringify(result.body).includes(operations[0].payload.note), false);
  const receipt = result.body.batch.completed[0].receipt;
  assert.equal(receipt.verifiedByReadback, true);
  assert.equal(receipt.externalId, "created-note-1");
  assert.equal(receipt.fileId, "contact-chance");
  assert.equal(receipt.noteSha256, approvedNoteContentHash(operations[0].payload.note));
  assert.equal(receipt.mentionsVerified, false);
  assert.equal(receipt.accountingNotified, false);
  assert.equal(receipt.mentionRequested, false);
  assert.equal(receipt.intendedRecipient, null);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.body.note, operations[0].payload.note);
  assert.deepEqual(Object.keys(f.state.body).sort(), ["date_created", "note", "primary", "record_type_name"]);
  const duplicate = await f.prepare(operations);
  assert.equal(duplicate.status, 409);
  assert.equal(f.state.posts, 1);
  const detail = await f.request("/ops/action-batch-receipts", { batchId: result.body.batch.id });
  assert.equal(detail.body.receipt.completed[0].receipt.noteSha256, receipt.noteSha256);
  assert.equal(JSON.stringify(detail.body).includes(operations[0].payload.note), false);
});

for (const recover of [false, true]) {
  test(`canonical Richard request preserves exact approval and never claims notification${recover ? " after recovery" : ""}`, async (t) => {
    const f = await fixture(t, recover ? { failLedgerAt: 4 } : {});
    const note = "@RichardR: Carrier reports payment issued. Please track the check.";
    const operations = [operation(note)];
    const intended = approvedNoteMentionIntent(note);
    const planned = await f.prepare(operations);
    assert.equal(planned.status, 200, JSON.stringify(planned.body));
    assert.doesNotThrow(() => assertApprovedNotePlan(planned.body, operations, "assigned", { enabled: true }));
    const plan = planned.body.operations[0].plan.plan;
    assert.equal(plan.note, note);
    assert.equal(plan.mentionRequested, true);
    assert.deepEqual(plan.intendedRecipient, intended.intendedRecipient);
    assert.equal(plan.mentionsVerified, false);
    assert.equal(plan.accountingNotified, false);
    assert.match(plan.notificationNotice, /not confirmed/);
    const stripped = await f.execute([operation(note.replace("@RichardR: ", ""))], planned.body);
    assert.equal(stripped.status, 409);
    assert.equal(f.state.posts, 0);
    const result = await f.execute(operations, planned.body);
    assert.equal(result.body.mode, recover ? "partial_failure" : "executed");
    let receipt = result.body.batch.completed[0]?.receipt;
    if (recover) {
      const recovery = await f.request("/ops/action-batch-reconcile", { batchId: result.body.batch.id });
      assert.equal(recovery.body.outcome, "applied_verified");
      receipt = recovery.body.receipt.completed[0].receipt;
      assert.equal(recovery.body.receipt.intents[0].mentionRequested, true);
      assert.deepEqual(recovery.body.receipt.intents[0].intendedRecipient, intended.intendedRecipient);
    }
    assert.equal(receipt.verifiedByReadback, true);
    assert.equal(receipt.mentionRequested, true);
    assert.deepEqual(receipt.intendedRecipient, intended.intendedRecipient);
    assert.equal(receipt.noteSha256, approvedNoteContentHash(note));
    assert.equal(receipt.mentionsVerified, false);
    assert.equal(receipt.accountingNotified, false);
    assert.equal(f.state.body.note, note);
    assert.equal(f.state.posts, 1);
    const detail = await f.request("/ops/action-batch-receipts", { batchId: result.body.batch.id });
    assert.equal(detail.body.receipt.completed[0].receipt.mentionRequested, true);
    assert.deepEqual(detail.body.receipt.completed[0].receipt.intendedRecipient, intended.intendedRecipient);
    assert.equal(detail.body.receipt.intents[0].mentionRequested, true);
    assert.deepEqual(detail.body.receipt.intents[0].intendedRecipient, intended.intendedRecipient);
    assert.equal(JSON.stringify(detail.body).includes(note), false);
  });
}

test("operator-authored notes cannot bootstrap a later stage transition", async (t) => {
  const f = await fixture(t);
  const note = "The insurance claim was filed and claim number was confirmed.";
  const planned = await f.prepare([operation(note)]);
  const result = await f.execute([operation(note)], planned.body);
  assert.equal(result.body.mode, "executed");
  f.contacts.push({ ...f.contacts[0], number: 4500, jnid: "other-stage", status_name: "Submitted Awaiting Confirmation" });
  const stage = await f.prepare([{
    type: "jobnimbus.update_status", payload: {
      query: "#2739", status: "Submitted Awaiting Confirmation",
      transitionEvidence: { reason: "Evidence must be independent of an authored note.", references: [{
        source: "jobnimbus_activity", id: "created-note-1", fileId: "contact-chance", gate: "claimFiled", fact: note
      }] }
    }
  }]);
  assert.equal(stage.status, 400, JSON.stringify(stage.body));
  assert.match(stage.body.error, /operator-authored/);
});

for (const scenario of ["timeout", "missing_id", "wrong_readback", "wrong_file", "conflicting_id", "provider_id_receipt_failure", "receipt_failure"]) {
  test(`approved note ${scenario} requires reconciliation without a duplicate POST`, async (t) => {
    const f = await fixture(t, { failLedgerAt: scenario === "receipt_failure" ? 4 : scenario === "provider_id_receipt_failure" ? 3 : 0 });
    const operations = [operation()];
    const plan = await f.prepare(operations);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    f.state.resultMode = scenario;
    f.state.wrongReadback = scenario === "wrong_readback";
    f.state.wrongReadbackFile = scenario === "wrong_file";
    f.state.conflictingId = scenario === "conflicting_id";
    const result = await f.execute(operations, plan.body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.mode, "partial_failure");
    assert.equal(result.body.batch.completed.length, 0);
    assert.equal(result.body.batch.current.status, "reconciliation_required");
    assert.equal(f.state.posts, 1);
    const persisted = JSON.parse(await readFile(path.join(f.root, "bridge", "action-batches.json"), "utf8"));
    assert.equal(persisted[0].intents[0].reconciliation.note, operations[0].payload.note);
    f.state.wrongReadback = false;
    f.state.wrongReadbackFile = false;
    f.state.conflictingId = false;
    const recovery = await f.request("/ops/action-batch-reconcile", { batchId: result.body.batch.id });
    assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
    if (["timeout", "missing_id"].includes(scenario)) {
      assert.equal(recovery.body.outcome, "unknown_file_quarantined");
      assert.equal(recovery.body.receipt.completedCount, 0);
    } else {
      assert.equal(recovery.body.outcome, "applied_verified");
      assert.equal(recovery.body.receipt.completed[0].receipt.externalId, "created-note-1");
      assert.equal(recovery.body.receipt.completed[0].receipt.noteSha256, approvedNoteContentHash(operations[0].payload.note));
      assert.equal(recovery.body.receipt.intents[0].noteSha256, recovery.body.receipt.completed[0].receipt.noteSha256);
    }
    assert.equal(f.state.posts, 1);
    const retry = await f.execute(operations, plan.body);
    assert.notEqual(retry.body.mode, "executed");
    assert.equal(f.state.posts, 1);
  });
}

test("absent ambiguous note is quarantined, never classified safe to retry", async (t) => {
  const f = await fixture(t);
  const operations = [operation()];
  const plan = await f.prepare(operations);
  f.state.resultMode = "not_written";
  const result = await f.execute(operations, plan.body);
  assert.equal(result.body.mode, "partial_failure");
  const recovery = await f.request("/ops/action-batch-reconcile", { batchId: result.body.batch.id });
  assert.equal(recovery.body.mode, "manual_quarantined");
  assert.equal(recovery.body.outcome, "unknown_file_quarantined");
  assert.equal(recovery.body.receipt.automaticRetryAllowed, false);
  assert.equal(f.state.posts, 1);
  const retry = await f.prepare(operations);
  assert.equal(retry.status, 409);
  assert.equal(f.state.posts, 1);
});
