import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS,
  CHANCE_OPERATOR_PDF_ALLOWED_ACTION_TYPES,
  CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES,
  CHANCE_OPERATOR_QUO_SMS_RUN_POLICY_ID,
  CHANCE_OPERATOR_LIVE_ASSIGNED_POLICY_ID,
  loadChanceOperatorRunManifest
} from "./operations/thresher-policy.js";
import {
  QUO_SMS_TYPE,
  assertQuoSmsPlan,
  assertQuoSmsReceipt
} from "../integrations/jobnimbus-operator/mcp/quo-sms-contract.mjs";

const TOKEN = "fixture-quo-sms-operator-token-12345678901234567890";
const OWNER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FROM = "+12025550101";
const TO = "+12025550102";
const TEXT = "Synthetic inspection scheduling message — reply with a convenient time. Saturday at 11:00 or 12:00 also works.";

const operation = (overrides = {}) => ({
  type: QUO_SMS_TYPE,
  payload: {
    query: "#990001",
    from: FROM,
    to: TO,
    content: TEXT,
    operatorScope: "assigned",
    ...overrides
  }
});

const pluginOperation = (overrides = {}) => ({
  type: QUO_SMS_TYPE,
  payload: {
    query: "#990001",
    from: FROM,
    to: TO,
    content: TEXT,
    ...overrides
  }
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "approved-quo-sms-test-"));
  const state = {
    posts: 0,
    messages: [],
    mode: "normal",
    body: null
  };
  const contacts = [
    {
      number: 990001,
      jnid: "contact-synthetic-alpha",
      record_type_name: "Insurance",
      display_name: "Synthetic Client Alpha",
      mobile_phone: TO,
      owners: [{ id: OWNER }],
      is_active: true,
      is_archived: false,
      is_closed: false,
      is_deleted: false,
      status_name: "Ready for PA Review"
    },
    {
      number: 990002,
      jnid: "contact-synthetic-beta",
      record_type_name: "Insurance",
      display_name: "Synthetic Client Beta",
      mobile_phone: "+12025550103",
      owners: [{ id: OWNER }],
      is_active: true,
      is_archived: false,
      is_closed: false,
      is_deleted: false,
      status_name: "Ready for PA Review"
    },
    {
      number: 2628,
      jnid: "contact-2628",
      record_type_name: "Insurance",
      display_name: "Synthetic Excluded Fixture",
      mobile_phone: "+12025550104",
      owners: [{ id: OWNER }]
    }
  ];
  const provider = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    };
    if (url.pathname === "/jn/contacts") {
      return json(200, { contacts, count: contacts.length });
    }
    const contact = contacts.find((row) => url.pathname === `/jn/contacts/${row.jnid}`);
    if (contact) return json(200, contact);
    if (url.pathname === "/quo/v1/phone-numbers") {
      return json(200, { data: [{ id: "PN_synthetic", name: "Synthetic Sender", number: FROM }] });
    }
    if (url.pathname === "/quo/v1/messages" && req.method === "POST") {
      state.posts += 1;
      state.body = await readBody();
      const id = `MSG_${state.posts}`;
      if (state.mode !== "post_timeout") {
        state.messages.push({
          id,
          conversationId: `CONV_${state.posts}`,
          phoneNumberId: "PN_synthetic",
          from: FROM,
          to: state.body.to,
          direction: "outgoing",
          status: "queued",
          createdAt: "2026-10-14T14:00:00Z",
          content: state.body.content
        });
      }
      if (state.mode === "post_timeout") return req.socket.destroy();
      return json(202, {
        data: {
          id: state.mode === "missing_id" ? undefined : id,
          conversationId: `CONV_${state.posts}`,
          phoneNumberId: "PN_synthetic",
          from: FROM,
          to: [TO],
          direction: "outgoing",
          status: "queued",
          createdAt: "2026-10-14T14:00:00Z"
        }
      });
    }
    if (url.pathname === "/quo/v1/messages" && req.method === "GET") {
      if (state.mode === "restricted_readback") return json(403, { error: "restricted" });
      const rows = state.messages.map((message) => ({
        ...message,
        ...(state.mode === "wrong_readback" ? { content: "Wrong content" } : {})
      }));
      return json(200, { data: rows });
    }
    if (url.pathname === "/quo/v1/calls") return json(200, { data: [] });
    return json(404, { error: "Fixture route missing" });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));

  const policyId = options.old
    ? "chance-58-files-pdf-v1"
    : CHANCE_OPERATOR_QUO_SMS_RUN_POLICY_ID;
  const allowedActionTypes = options.old
    ? CHANCE_OPERATOR_PDF_ALLOWED_ACTION_TYPES
    : CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES;
  let input = {
    schemaVersion: 1,
    id: policyId,
    operatorScope: "assigned",
    expiresAt: "2099-01-01T00:00:00.000Z",
    files: [
      ...contacts.slice(0, 2).map((row) => ({ number: String(row.number), fileId: row.jnid })),
      ...Array.from({ length: 56 }, (_, index) => ({
        number: String(4000 + index),
        fileId: `fixture-file-${index}`
      }))
    ],
    excludedFileNumbers: ["2628"],
    allowedActionTypes: [...allowedActionTypes],
    allowedContactFields: [...CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS]
  };
  if (options.omitAssignedFile) {
    input.files[0] = { number: "8001", fileId: "fixture-unrelated-8001" };
  }
  if (options.live) {
    const receiptPredecessor = options.migrate ? structuredClone(input) : undefined;
    const { files, ...baseInput } = input;
    input = { ...baseInput, schemaVersion: 2, id: CHANCE_OPERATOR_LIVE_ASSIGNED_POLICY_ID,
      assignmentMode: "live_assigned", assignmentOwnerId: OWNER,
      ...(receiptPredecessor ? { receiptPredecessor } : {}) };
  }
  const manifest = loadChanceOperatorRunManifest(input);
  const runPolicy = { id: manifest.id, sha256: manifest.sha256 };
  const base = `http://127.0.0.1:${provider.address().port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_MAC_OPERATOR_TOKEN: TOKEN,
      CHANCE_JOBNIMBUS_OWNER_ID: OWNER,
      JOBNIMBUS_API_BASE_URL: `${base}/jn`,
      JOBNIMBUS_API_KEY: "fixture-jobnimbus-key",
      QUO_API_BASE_URL: `${base}/quo/v1`,
      QUO_API_KEY: "fixture-quo-key",
      QUO_DEFAULT_FROM_NUMBER: FROM,
      ALLOW_QUO_SEND: "false",
      MEMORY_ROOT: root,
      REQUIRE_CHANCE_RUN_POLICY: "true",
      CHANCE_OPERATOR_RUN_MANIFEST_JSON: JSON.stringify(input),
      BRIDGE_ALLOW_WRITES: "true",
      ALLOW_GOOGLE_USER_AUTH: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, logs);
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    state,
    contacts,
    manifest,
    root,
    request,
    readPolicy: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/ops/run-policy`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    prepare: (operations) => request("/ops/action-batch", {
      runPolicy,
      operations,
      execute: false
    }),
    execute: (operations, plan) => request("/ops/action-batch", {
      runPolicy,
      operations,
      execute: true,
      approvalDigest: plan.approvalDigest,
      approvalChallenge: plan.approvalChallenge
    })
  };
}

test("fixed roster reports the actual assigned count and explains a blocked existing client", async (t) => {
  const f = await fixture(t, { omitAssignedFile: true });
  const index = await f.request("/ops/review-chance-files", { indexOnly: true });
  assert.equal(index.status, 200, JSON.stringify(index.body));
  assert.equal(index.body.total, 1);
  assert.equal(index.body.counts.assignedInsurance, 3);
  assert.equal(index.body.counts.restrictedByActionScope, 2);
  assert.equal(index.body.countScope, "fixed_manifest_subset");
  const blocked = await f.prepare([operation()]);
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.match(blocked.body.error, /assigned JobNimbus file exists/);
  assert.equal(f.state.posts, 0);
});

test("reviewed live policy discovers newly assigned files and sends only an exact approved synthetic SMS", async (t) => {
  const f = await fixture(t, { live: true });
  // Added after startup: no policy/file-count rewrite is needed.
  f.contacts.push({ ...f.contacts[0], number: 990003, jnid: "synthetic-new-assignment",
    mobile_phone: "+12025550105", display_name: "Synthetic New Assignment" });
  const index = await f.request("/ops/review-chance-files", { indexOnly: true });
  assert.equal(index.status, 200, JSON.stringify(index.body));
  assert.equal(index.body.total, 3);
  assert.equal(index.body.counts.assignedInsurance, 4);
  assert.equal(index.body.countScope, "live_assigned_insurance");
  const ops = [operation({ query: "#990003", to: "+12025550105" })];
  const plan = await f.prepare(ops);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(f.state.posts, 0);
  const sent = await f.execute(ops, plan.body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.batch.completed[0].receipt.verifiedByReadback, true);
  assert.equal(sent.body.batch.completed[0].receipt.recipient, "+12025550105");
  assert.equal(f.state.posts, 1);
});

test("live policy blocks changed ownership, inactivity, exclusion and generic send routes", async (t) => {
  const f = await fixture(t, { live: true });
  const ops = [operation()];
  const plan = await f.prepare(ops);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  f.contacts[0].owners = [{ id: "another-synthetic-owner" }];
  assert.notEqual((await f.execute(ops, plan.body)).status, 200);
  f.contacts[0].owners = [{ id: OWNER }];
  f.contacts[0].is_closed = true;
  assert.notEqual((await f.prepare(ops)).status, 200);
  assert.notEqual((await f.prepare([operation({ query: "#2628", to: "+12025550104" })])).status, 200);
  assert.equal((await f.request("/quo/send", { query: "#990001", to: TO, content: TEXT, execute: true })).status, 403);
  assert.equal(f.state.posts, 0);
});

test("live-policy migration preserves exact prior quarantines, never globalizes or clears them silently", async (t) => {
  const f = await fixture(t, { live: true, migrate: true });
  assert.equal((await f.prepare([operation()])).status, 200);
  const ledgerPath = path.join(f.root, "bridge", "action-batches.json");
  const ownPrincipal = createHash("sha256").update("codex_operator_token|codex-mac-operator||codex_operator").digest("hex");
  for (const principalHash of [ownPrincipal, "9".repeat(64)]) {
    const quarantine = {
      schemaVersion: 2, id: `synthetic-prior-quarantine-${principalHash.slice(0, 8)}`,
      principalHash, operatorScope: "assigned", status: "manual_quarantined",
      runPolicyId: f.manifest.receiptPredecessor.id,
      runPolicySha256: f.manifest.receiptPredecessor.sha256,
      operationCount: 1, fileCount: 1, batchMode: "assigned_single_file_v2",
      files: [{ id: "contact-synthetic-alpha", number: "990001", operationIndexes: [0], operationTypes: ["quo.send_text"] }],
      completed: [], recovery: { fileScopedQuarantine: true, automaticRetryAllowed: false },
      manualQuarantine: { scope: "file", fileId: "contact-synthetic-alpha", fileIds: ["contact-synthetic-alpha"],
        fileNumber: "990001", fileNumbers: ["990001"] }
    };
    await writeFile(ledgerPath, JSON.stringify([quarantine]));
    assert.equal((await f.readPolicy()).ready, true);
    assert.equal((await f.prepare([operation()])).status, 409);
    assert.equal((await f.prepare([operation({ query: "#990002", to: "+12025550103" })])).status, 200);
    assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")), [quarantine]);
    for (const change of [
      { runPolicySha256: "f".repeat(64) },
      { files: [{ ...quarantine.files[0], id: "synthetic-wrong-file" }] }
    ]) {
      await writeFile(ledgerPath, JSON.stringify([{ ...quarantine, ...change }]));
      assert.equal((await f.readPolicy()).ready, false);
      assert.equal((await f.prepare([operation({ query: "#990002", to: "+12025550103" })])).status, 409);
    }
  }
  assert.equal(f.state.posts, 0);
});

test("Quo SMS requires the new manifest while generic Quo send remains disabled", async (t) => {
  const fixtureState = await fixture(t, { old: true });
  assert.equal((await fixtureState.prepare([operation()])).status, 400);
  assert.equal((await fixtureState.request("/quo/send", {
    query: "#990001",
    to: TO,
    content: TEXT,
    execute: true
  })).status, 403);
  assert.equal(fixtureState.state.posts, 0);
});

test("Quo SMS exact plan, provider readback receipt and durable duplicate guard", async (t) => {
  const fixtureState = await fixture(t);
  const operations = [operation()];
  const planned = await fixtureState.prepare(operations);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assertQuoSmsPlan(planned.body, [pluginOperation()]);
  assert.equal(fixtureState.state.posts, 0);

  for (const [patch, status] of [
    [{ content: `${TEXT} changed` }, 409],
    [{ from: "+12025550103" }, 400],
    [{ to: "+12025550104" }, 400]
  ]) {
    assert.equal((await fixtureState.execute([operation(patch)], planned.body)).status, status);
  }
  assert.equal(fixtureState.state.posts, 0);

  const result = await fixtureState.execute(operations, planned.body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.mode, "executed");
  const receipt = result.body.batch.completed[0].receipt;
  assertQuoSmsReceipt(receipt, pluginOperation().payload);
  assert.equal(receipt.deliveryStatus, "queued");
  assert.equal(receipt.deliveryConfirmed, false);
  assert.equal(receipt.manualVerificationRequired, false);
  assert.equal(fixtureState.state.posts, 1);
  assert.deepEqual(fixtureState.state.body, {
    content: TEXT,
    from: "PN_synthetic",
    to: [TO]
  });

  const duplicatePlan = await fixtureState.prepare(operations);
  assert.equal(duplicatePlan.status, 200, JSON.stringify(duplicatePlan.body));
  const duplicate = await fixtureState.execute(operations, duplicatePlan.body);
  assert.equal(duplicate.body.mode, "blocked_duplicate");
  assert.equal(fixtureState.state.posts, 1);

  const detail = await fixtureState.request("/ops/action-batch-receipts", {
    batchId: result.body.batch.id
  });
  assertQuoSmsReceipt(detail.body.receipt.completed[0].receipt, pluginOperation().payload);
  const actionLedger = await readFile(path.join(fixtureState.root, "bridge", "action-batches.json"), "utf8");
  const outboundLedger = await readFile(path.join(fixtureState.root, "bridge", "outbound-sends.json"), "utf8");
  assert.equal(actionLedger.includes(TEXT), false);
  assert.equal(outboundLedger.includes(TEXT), false);
  assert.equal(outboundLedger.includes("fixture-quo-key"), false);
});

for (const live of [false, true]) {
test(`${live ? "Live-assigned" : "Fixed-roster"} Quo SMS uncertain readback reconciles by provider id without a second send`, async (t) => {
  const fixtureState = await fixture(t, { live });
  const operations = [operation()];
  const planned = await fixtureState.prepare(operations);
  fixtureState.state.mode = "wrong_readback";
  const result = await fixtureState.execute(operations, planned.body);
  assert.equal(result.body.mode, "partial_failure", JSON.stringify(result.body));
  assert.equal(result.body.batch.current.status, "reconciliation_required");
  assert.equal(fixtureState.state.posts, 1);

  fixtureState.state.mode = "normal";
  const reconciled = await fixtureState.request("/ops/action-batch-reconcile", {
    batchId: result.body.batch.id
  });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.outcome, "applied_verified");
  assertQuoSmsReceipt(
    reconciled.body.receipt.completed[0].receipt,
    pluginOperation().payload
  );
  assert.equal(fixtureState.state.posts, 1);
  assert.notEqual((await fixtureState.execute(operations, planned.body)).body.mode, "executed");
  assert.equal(fixtureState.state.posts, 1);
});

test(`${live ? "Live-assigned" : "Fixed-roster"} Quo SMS missing provider id is quarantined and never retried`, async (t) => {
  const fixtureState = await fixture(t, { live });
  const operations = [operation()];
  const planned = await fixtureState.prepare(operations);
  fixtureState.state.mode = "missing_id";
  const result = await fixtureState.execute(operations, planned.body);
  assert.equal(result.body.mode, "partial_failure", JSON.stringify(result.body));
  assert.equal(fixtureState.state.posts, 1);
  const reconciled = await fixtureState.request("/ops/action-batch-reconcile", {
    batchId: result.body.batch.id
  });
  assert.equal(reconciled.body.mode, "manual_quarantined", JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.outcome, "unknown_file_quarantined");
  assert.equal(fixtureState.state.posts, 1);
});
}
