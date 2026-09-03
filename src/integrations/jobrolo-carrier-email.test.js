import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHcnGoogleGrantStore
} from "../auth/hcn-google-grant-store.js";
import {
  createHcnInvitationStore
} from "../auth/hcn-invitation-store.js";
import {
  createHcnReferenceFactory
} from "../hcn-ops/references.js";
import { signJobroloHcnRequest } from "./jobrolo-service-auth.js";
import {
  assertJobroloCarrierPlan,
  HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST,
  JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
  projectJobroloCarrierEnvelope,
  validateJobroloCarrierDraftPrepareInput,
  validateJobroloCarrierExecuteInput,
  validateJobroloCarrierSendPrepareInput
} from "./jobrolo-carrier-email.js";

const FILE_REF = `subject_${"a".repeat(32)}`;
const DOCUMENT_REF = `ref_${"b".repeat(32)}`;
const DRAFT_REF = `ref_${"c".repeat(32)}`;
const PLAN_ID = `plan_${"d".repeat(32)}`;

test("carrier facade contract and routes are stable and versioned", () => {
  assert.equal(
    JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    "jobrolo.hcn.carrier-email.v1"
  );
  assert.equal(HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST.length, 6);
  assert.equal(new Set(HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST).size, 6);
  assert.equal(
    HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST.every((route) =>
      route.startsWith("/integrations/jobrolo/v1/carrier-emails/")),
    true
  );
});

test("draft and send inputs expose only opaque exact-file references", () => {
  assert.deepEqual(validateJobroloCarrierDraftPrepareInput({
    contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    fileRef: FILE_REF,
    documentRef: DOCUMENT_REF,
    body: "Please review the attached supplement."
  }), {
    contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    fileRef: FILE_REF,
    documentRef: DOCUMENT_REF,
    body: "Please review the attached supplement."
  });
  assert.deepEqual(validateJobroloCarrierSendPrepareInput({
    contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    fileRef: FILE_REF,
    draftRef: DRAFT_REF
  }), {
    contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    fileRef: FILE_REF,
    draftRef: DRAFT_REF
  });
  for (const extra of [
    { to: "adjuster@example.test" },
    { subject: "CLAIM-123" },
    { providerDocumentId: "private" },
    { attachmentBase64: "c2VjcmV0" }
  ]) {
    assert.throws(
      () => validateJobroloCarrierDraftPrepareInput({
        contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
        fileRef: FILE_REF,
        documentRef: DOCUMENT_REF,
        body: "Exact body",
        ...extra
      }),
      { code: "jobrolo_hcn_carrier_contract_invalid", statusCode: 400 }
    );
  }
});

test("draft and send execution keep distinct exact plans and approvals", () => {
  const approval = {
    schema: "jobrolo.approval-attestation.v1",
    approvalRequestId: "approval_0123456789abcdef",
    planDigest: "e".repeat(64),
    approvedByUserId: "user_0123456789abcdef",
    approvedAt: "2026-09-03T12:00:00.000Z"
  };
  const execute = validateJobroloCarrierExecuteInput({
    contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    planId: PLAN_ID,
    approval
  });
  assert.deepEqual(execute.approval, approval);
  assertJobroloCarrierPlan({
    operations: [{ type: "gmail.create_draft" }]
  }, "gmail.create_draft");
  assertJobroloCarrierPlan({
    operations: [{ type: "gmail.send_existing_draft" }]
  }, "gmail.send_existing_draft");
  assert.throws(() => assertJobroloCarrierPlan({
    operations: [{ type: "gmail.create_draft" }]
  }, "gmail.send_existing_draft"), {
    code: "jobrolo_hcn_carrier_plan_mismatch",
    statusCode: 409
  });
});

test("carrier envelopes always repeat the exact contract", () => {
  assert.deepEqual(projectJobroloCarrierEnvelope({ ready: false }), {
    schema: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    ready: false
  });
});

test("carrier HTTP facade drafts, sends, reads back, and never retries uncertain effects", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "hcn-jobrolo-carrier-http-")
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const tenantId = "tenant_0123456789abcdef";
  const referenceKey = Buffer.alloc(32, 0x71).toString("base64url");
  const grantKey = Buffer.alloc(32, 0x72).toString("base64url");
  const assistantKey = Buffer.alloc(32, 0x73).toString("base64url");
  const principalEmail = "chance@wavepa.com";
  const googleSubject = "carrier-http-google-subject";
  const ownerId = "carrier-http-owner";
  const secondEmail = "readonly@wavepa.com";
  const secondSubject = "carrier-readonly-google-subject";
  const secondOwnerId = "carrier-readonly-owner";
  const clientId = "jobrolo-carrier-http";
  const sharedSecret =
    "jobrolo-carrier-http-shared-secret-123456789";
  const readOnlyClientId = "jobrolo-carrier-readonly";
  const readOnlySecret =
    "jobrolo-carrier-readonly-secret-123456789";
  const references = createHcnReferenceFactory({
    tenantId,
    hmacKey: Buffer.from(referenceKey, "base64url")
  });
  const googleOperatorRef = references.subjectId(
    "hcn_operator",
    `google:${googleSubject}`
  );
  const principalRef =
    `principal_${googleOperatorRef.slice("subject_".length)}`;
  const invitationTimestamp = Date.now();
  const invitationStore = createHcnInvitationStore({
    filePath: path.join(
      root,
      "platform",
      "employee-invitations.enc.json"
    ),
    key: referenceKey,
    allowedDomain: "",
    now: () => invitationTimestamp
  });
  const readOnlyInvitation = await invitationStore.createInvitation({
    email: secondEmail,
    displayName: "Read Only Adjuster",
    role: "employee",
    jobNimbusOwnerId: secondOwnerId,
    jobNimbusScope: "assigned",
    invitedByRef: `principal_${"e".repeat(64)}`,
    expiresAt: new Date(
      invitationTimestamp + 24 * 60 * 60_000
    ).toISOString()
  });
  await invitationStore.acceptInvitation({
    invitationRef: readOnlyInvitation.invitationRef,
    email: secondEmail,
    googleSubject: secondSubject,
    inviteToken: readOnlyInvitation.inviteToken
  });
  const grantStorePath = path.join(
    root,
    "platform",
    "google-grants.enc.json"
  );
  await createHcnGoogleGrantStore({
    filePath: grantStorePath,
    encryptionKey: grantKey
  }).upsert({
    principalRef,
    refreshToken: "carrier-http-refresh-token",
    accessToken: "carrier-http-access-token",
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar.readonly"
    ]
  });

  const carrierBodyA =
    "Please review the attached Patricia supplement.";
  const carrierBodyB =
    "Please review the attached second-file estimate.";
  const pdfA = Buffer.from("%PDF-1.4\ncarrier-a\n%%EOF", "utf8");
  const pdfB = Buffer.from("%PDF-1.4\ncarrier-b\n%%EOF", "utf8");
  const contacts = [{
    jnid: "carrier-file-a",
    number: 2739,
    record_type_name: "Insurance",
    owners: [{ id: ownerId }],
    display_name: "Patricia Carrier Fixture",
    status_name: "Negotiation",
    address_line1: "100 Carrier Way",
    city: "Dallas",
    state_text: "TX",
    zip: "75201",
    mobile_phone: "+12145550101",
    email: "patricia@example.test",
    cf_string_1: "State Farm",
    cf_string_2: "CLAIM-2739-A",
    cf_string_3: "POLICY-2739-A",
    cf_string_9: "adjuster-a@example.test",
    cf_date_1: "2026-04-25",
    is_active: true,
    is_archived: false,
    date_updated: 1785261000
  }, {
    jnid: "carrier-file-b",
    number: 2740,
    record_type_name: "Insurance",
    owners: [{ id: ownerId }],
    display_name: "Second Carrier Fixture",
    status_name: "Negotiation",
    address_line1: "200 Carrier Way",
    city: "Dallas",
    state_text: "TX",
    zip: "75202",
    mobile_phone: "+12145550102",
    email: "second-file@example.test",
    cf_string_1: "Allstate",
    cf_string_2: "CLAIM-2740-B",
    cf_string_3: "POLICY-2740-B",
    cf_string_9: "adjuster-b@example.test",
    cf_date_1: "2026-05-02",
    is_active: true,
    is_archived: false,
    date_updated: 1785260900
  }];
  const documents = [{
    jnid: "carrier-document-a",
    name: "Patricia Supplement.pdf",
    record_type_name: "Document",
    content_type: "application/pdf",
    date_created: "2026-09-03T14:00:00.000Z",
    related: [{ id: "carrier-file-a" }]
  }, {
    jnid: "carrier-document-b",
    name: "Second Estimate.pdf",
    record_type_name: "Document",
    content_type: "application/pdf",
    date_created: "2026-09-03T14:01:00.000Z",
    related: [{ id: "carrier-file-b" }]
  }];
  const draftFixtures = new Map([
    ["carrier-draft-a", {
      draftId: "carrier-draft-a",
      messageId: "carrier-draft-message-a",
      sentMessageId: "carrier-sent-a",
      threadId: "carrier-thread-a",
      to: "adjuster-a@example.test",
      subject: "CLAIM-2739-A",
      body: carrierBodyA,
      filename: "Patricia Supplement.pdf",
      bytes: pdfA
    }],
    ["carrier-draft-b", {
      draftId: "carrier-draft-b",
      messageId: "carrier-draft-message-b",
      sentMessageId: "carrier-sent-b",
      threadId: "carrier-thread-b",
      to: "adjuster-b@example.test",
      subject: "CLAIM-2740-B",
      body: carrierBodyB,
      filename: "Second Estimate.pdf",
      bytes: pdfB
    }]
  ]);
  const sentFixtures = new Map(
    [...draftFixtures.values()].map((fixture) => [
      fixture.sentMessageId,
      fixture
    ])
  );
  const mismatchedDraftRecipients = new Set();
  const mismatchedSentMessages = new Set();
  const providerCalls = [];
  let draftCreateCount = 0;
  let sendCount = 0;

  const provider = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://provider.invalid");
    providerCalls.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.method === "GET" && url.pathname === "/account/users") {
      return carrierJson(res, 200, {
        total: 2,
        users: [{
          jnid: ownerId,
          email: principalEmail,
          display_name: "Chance Pearson",
          is_active: true
        }, {
          jnid: secondOwnerId,
          email: secondEmail,
          display_name: "Read Only Adjuster",
          is_active: true
        }]
      });
    }
    if (req.method === "GET" && url.pathname === "/contacts") {
      return carrierJson(res, 200, { contacts });
    }
    const contactId = /^\/contacts\/([^/]+)$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && contactId) {
      const contact = contacts.find((item) => item.jnid === contactId);
      return carrierJson(
        res,
        contact ? 200 : 404,
        contact || { error: "not found" }
      );
    }
    if (req.method === "GET" && url.pathname === "/activities") {
      return carrierJson(res, 200, { activities: [] });
    }
    if (req.method === "GET" && url.pathname === "/tasks") {
      return carrierJson(res, 200, { tasks: [] });
    }
    if (req.method === "GET" && url.pathname === "/files") {
      const relatedId = carrierRelatedFilter(url);
      return carrierJson(res, 200, {
        files: relatedId
          ? documents.filter((document) =>
              document.related.some((item) => item.id === relatedId))
          : documents
      });
    }
    const fileId = /^\/jobnimbus-files\/([^/]+)$/.exec(
      url.pathname
    )?.[1];
    if (req.method === "GET" && fileId) {
      const bytes = fileId === "carrier-document-a"
        ? pdfA
        : fileId === "carrier-document-b"
          ? pdfB
          : null;
      if (!bytes) return carrierJson(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(bytes.length)
      });
      res.end(bytes);
      return;
    }
    if (
      req.method === "GET"
      && url.pathname === "/gmail/v1/users/me/messages"
    ) {
      return carrierJson(res, 200, {
        messages: [],
        resultSizeEstimate: 0
      });
    }
    if (
      req.method === "POST"
      && url.pathname === "/gmail/v1/users/me/drafts"
    ) {
      void carrierReadJson(req).then(() => {
        draftCreateCount += 1;
        const draftId = draftCreateCount === 1
          ? "carrier-draft-a"
          : "carrier-draft-b";
        const fixture = draftFixtures.get(draftId);
        carrierJson(res, 200, {
          id: fixture.draftId,
          message: {
            id: fixture.messageId,
            threadId: fixture.threadId
          }
        });
      });
      return;
    }
    const draftId = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/
      .exec(url.pathname)?.[1];
    if (req.method === "GET" && draftId) {
      const fixture = draftFixtures.get(draftId);
      return carrierJson(
        res,
        fixture ? 200 : 404,
        fixture
          ? {
              id: fixture.draftId,
              message: carrierGmailMessage(fixture, {
                id: fixture.messageId,
                labels: ["DRAFT"],
                to: mismatchedDraftRecipients.has(draftId)
                  ? "wrong-adjuster@example.test"
                  : fixture.to
              })
            }
          : { error: { message: "Draft not found" } }
      );
    }
    if (
      req.method === "POST"
      && url.pathname === "/gmail/v1/users/me/messages/send"
    ) {
      void carrierReadJson(req).then(() => {
        sendCount += 1;
        const fixture = sendCount === 1
          ? draftFixtures.get("carrier-draft-a")
          : draftFixtures.get("carrier-draft-b");
        carrierJson(res, 200, {
          id: fixture.sentMessageId,
          threadId: fixture.threadId
        });
      });
      return;
    }
    const sentId = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/
      .exec(url.pathname)?.[1];
    if (req.method === "GET" && sentId) {
      const fixture = sentFixtures.get(sentId);
      return carrierJson(
        res,
        fixture ? 200 : 404,
        fixture
          ? carrierGmailMessage(fixture, {
              id: fixture.sentMessageId,
              labels: ["SENT"],
              subject: mismatchedSentMessages.has(sentId)
                ? `${fixture.subject}-MISMATCH`
                : fixture.subject
            })
          : { error: { message: "Message not found" } }
      );
    }
    return carrierJson(res, 404, { error: "not found" });
  });
  await carrierListen(provider);
  t.after(() => carrierCloseServer(provider));

  const bridgePort = await carrierReservePort();
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  const bridgeEnv = {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${bridgePort}`,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: `http://127.0.0.1:${bridgePort}`,
      HCN_GOOGLE_LOGIN_ALLOWED_DOMAIN: "wavepa.com",
      CHANCE_GOOGLE_EMAIL: principalEmail,
      CHANCE_GOOGLE_SUBJECT: googleSubject,
      CHANCE_JOBNIMBUS_OWNER_ID: ownerId,
      WAVE_AUTH_USERS_JSON: JSON.stringify([{
        email: secondEmail,
        name: "Read Only Adjuster",
        role: "employee",
        googleSubject: secondSubject,
        jobNimbusOwnerId: secondOwnerId,
        jobNimbusScope: "assigned"
      }]),
      JOBNIMBUS_API_KEY: "carrier-http-jobnimbus-key",
      JOBNIMBUS_API_BASE_URL: providerOrigin,
      JOBNIMBUS_FILE_BASE_URL: `${providerOrigin}/jobnimbus-files`,
      HCN_TENANT_ID: tenantId,
      HCN_REFERENCE_KEY: referenceKey,
      HCN_OPERATIONS_ROOT: root,
      HCN_JOBROLO_ADAPTER_ENABLED: "true",
      HCN_JOBROLO_CLIENT_ID: clientId,
      HCN_JOBROLO_SHARED_SECRET: sharedSecret,
      HCN_JOBROLO_PRINCIPAL_EMAIL: principalEmail,
      HCN_JOBROLO_ADDITIONAL_PROFILES_JSON: JSON.stringify({
        schema: "hcn.jobrolo.general-profiles.v1",
        profiles: [{
          clientId: readOnlyClientId,
          sharedSecret: readOnlySecret,
          principalEmail: secondEmail,
          effectMode: "read_only"
        }]
      }),
      HCN_GOOGLE_CLIENT_ID: "carrier-http-hcn-google-client",
      HCN_GOOGLE_CLIENT_SECRET:
        "carrier-http-hcn-google-secret-123456789",
      HCN_GOOGLE_GRANT_KEY: grantKey,
      HCN_GOOGLE_GRANT_STORE_PATH: grantStorePath,
      GOOGLE_CLIENT_ID: "carrier-http-legacy-google-client",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      GOOGLE_TOKEN_URL: `${providerOrigin}/google/token`,
      GMAIL_API_BASE_URL: providerOrigin,
      GMAIL_USER: "me",
      HCN_ASSISTANT_HISTORY_KEY: assistantKey,
      HCN_THRESHER_AI_ENABLED: "false",
      HCN_THRESHER_AI_GROQ_API_KEY: "",
      QUO_API_KEY: "",
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "",
      CODEX_MAC_OPERATOR_TOKEN: "",
      OAUTH_SESSION_SECRET: "",
      GPT_OAUTH_CLIENT_SECRET: "",
      BRIDGE_ALLOW_WRITES: "true",
      HCN_ACTION_EXECUTION_ENABLED: "true",
      ALLOW_GMAIL_SEND: "true",
      HCN_THRESHER_ENABLED: "false",
      HCN_THRESHER_STORE_KEY: "",
      HCN_THRESHER_REFERENCE_KEY: "",
      HCN_THRESHER_SIGNING_KEY: ""
  };
  let childOutput = "";
  const startBridge = () => {
    const running = spawn(process.execPath, ["src/server.js"], {
      cwd: process.cwd(),
      env: bridgeEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    running.stdout.on("data", (chunk) => {
      childOutput += chunk.toString("utf8");
    });
    running.stderr.on("data", (chunk) => {
      childOutput += chunk.toString("utf8");
    });
    return running;
  };
  let child = startBridge();
  t.after(() => carrierStopChild(child));
  await carrierWaitForBridge(child, bridgePort, () => childOutput);

  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`;
  let requestSequence = 0;
  const post = (pathname, input, options = {}) => {
    requestSequence += 1;
    const token = requestSequence.toString(16).padStart(32, "0");
    return carrierSignedPost(bridgeOrigin, pathname, {
      requestId: `request_${token}`,
      sessionRef: options.sessionRef
        || `session_${"a".repeat(32)}`,
      nonce: `nonce_${token}`,
      input,
      clientId: options.clientId || clientId,
      secret: options.secret || sharedSecret
    });
  };

  const status = await post(
    "/integrations/jobrolo/v1/carrier-emails/status",
    { contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT }
  );
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.body.result.ready, true);
  assert.equal(status.body.result.draft.providerReadbackRequired, true);
  assert.equal(status.body.result.send.sentReadbackRequired, true);

  const readOnlyReceipt = await post(
    "/integrations/jobrolo/v1/carrier-emails/receipts/detail",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: `plan_${"f".repeat(32)}`
    },
    {
      clientId: readOnlyClientId,
      secret: readOnlySecret,
      sessionRef: `session_${"b".repeat(32)}`
    }
  );
  assert.equal(readOnlyReceipt.response.status, 404, readOnlyReceipt.text);

  const fileRefA = references.subjectId("jobnimbus", "carrier-file-a");
  const documentRefA = references.sourceRecordRef(
    "jobnimbus",
    "carrier-document-a"
  );
  const draftPreparedA = await post(
    "/integrations/jobrolo/v1/carrier-emails/drafts/prepare",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      fileRef: fileRefA,
      documentRef: documentRefA,
      body: carrierBodyA
    }
  );
  assert.equal(
    draftPreparedA.response.status,
    200,
    `${draftPreparedA.text}\n${providerCalls.join("\n")}\n${childOutput}`
  );
  const draftPlanA = draftPreparedA.body.result.plan;
  assert.equal(draftPlanA.operations.length, 1);
  assert.equal(draftPlanA.operations[0].type, "gmail.create_draft");
  assert.equal(draftPlanA.operations[0].material.to, "adjuster-a@example.test");
  assert.equal(draftPlanA.operations[0].material.subject, "CLAIM-2739-A");
  assert.equal(draftCreateCount, 0);

  const rejectedDraftExecute = await post(
    "/integrations/jobrolo/v1/carrier-emails/drafts/execute",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: draftPlanA.planId,
      approval: carrierApproval(draftPlanA, "wrong-draft", {
        planDigest: "0".repeat(64)
      })
    }
  );
  assert.equal(rejectedDraftExecute.response.status, 409);
  assert.equal(draftCreateCount, 0);

  const draftExecutedA = await post(
    "/integrations/jobrolo/v1/carrier-emails/drafts/execute",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: draftPlanA.planId,
      approval: carrierApproval(draftPlanA, "draft-a")
    }
  );
  assert.equal(draftExecutedA.response.status, 200, draftExecutedA.text);
  assert.equal(draftCreateCount, 1);
  assert.equal(draftExecutedA.body.result.receipt.status, "executed");
  const draftReceiptA =
    draftExecutedA.body.result.plan.result.batch.completed[0].receipt;
  assert.equal(draftReceiptA.verifiedByReadback, true);
  assert.match(draftReceiptA.createdDraftRef, /^ref_[a-f0-9]{32}$/);

  await carrierStopChild(child);
  child = startBridge();
  await carrierWaitForBridge(child, bridgePort, () => childOutput);
  const recoveredDraftA = await post(
    "/integrations/jobrolo/v1/carrier-emails/receipts/detail",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: draftPlanA.planId
    }
  );
  assert.equal(recoveredDraftA.response.status, 200, recoveredDraftA.text);
  assert.equal(recoveredDraftA.body.result.receipt.status, "executed");
  assert.equal(recoveredDraftA.body.result.plan.status, "executed");
  assert.equal(
    recoveredDraftA.body.result.plan.result.batch.status,
    "completed"
  );
  const recoveredDraftReceiptA =
    recoveredDraftA.body.result.plan.result.batch.completed[0].receipt;
  assert.equal(recoveredDraftReceiptA.verifiedByReadback, true);
  assert.equal(
    recoveredDraftReceiptA.createdDraftRef,
    draftReceiptA.createdDraftRef
  );

  const batchLedgerPath = path.join(
    root,
    "platform",
    "action-batches.json"
  );
  const originalBatchLedger = await readFile(batchLedgerPath, "utf8");
  const exactBatchLedger = JSON.parse(originalBatchLedger);
  const exactBatchIndex = exactBatchLedger.findIndex(
    (batch) => batch.approvalDigest === draftPlanA.approvalDigest
  );
  assert.notEqual(exactBatchIndex, -1);
  const assertRecoveryBlocked = async (ledger) => {
    await writeFile(batchLedgerPath, JSON.stringify(ledger), "utf8");
    const blocked = await post(
      "/integrations/jobrolo/v1/carrier-emails/receipts/detail",
      {
        contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
        planId: draftPlanA.planId
      }
    );
    assert.equal(blocked.response.status, 409);
    assert.match(blocked.text, /do not retry/i);
  };
  const mismatchedBatchLedger = structuredClone(exactBatchLedger);
  mismatchedBatchLedger[exactBatchIndex].hcnReceiptBatchRef =
    `batch_${"0".repeat(32)}`;
  await assertRecoveryBlocked(mismatchedBatchLedger);
  const wrongFileBatchLedger = structuredClone(exactBatchLedger);
  wrongFileBatchLedger[exactBatchIndex].completed[0].receipt.fileId =
    "carrier-file-b";
  await assertRecoveryBlocked(wrongFileBatchLedger);
  const duplicateBatchLedger = structuredClone(exactBatchLedger);
  duplicateBatchLedger.push({
    ...structuredClone(exactBatchLedger[exactBatchIndex]),
    id: "duplicate-carrier-recovery-batch"
  });
  await assertRecoveryBlocked(duplicateBatchLedger);
  await assertRecoveryBlocked([]);
  await writeFile(batchLedgerPath, originalBatchLedger, "utf8");

  mismatchedDraftRecipients.add("carrier-draft-a");
  const mismatchedSendPrepare = await post(
    "/integrations/jobrolo/v1/carrier-emails/sends/prepare",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      fileRef: fileRefA,
      draftRef: recoveredDraftReceiptA.createdDraftRef
    }
  );
  mismatchedDraftRecipients.delete("carrier-draft-a");
  assert.equal(mismatchedSendPrepare.response.status, 409);
  assert.equal(sendCount, 0);

  const sendPreparedA = await post(
    "/integrations/jobrolo/v1/carrier-emails/sends/prepare",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      fileRef: fileRefA,
      draftRef: recoveredDraftReceiptA.createdDraftRef
    }
  );
  assert.equal(sendPreparedA.response.status, 200, sendPreparedA.text);
  const sendPlanA = sendPreparedA.body.result.plan;
  assert.equal(sendPlanA.operations.length, 1);
  assert.equal(
    sendPlanA.operations[0].type,
    "gmail.send_existing_draft"
  );
  assert.equal(sendCount, 0);

  const sendExecutedA = await post(
    "/integrations/jobrolo/v1/carrier-emails/sends/execute",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: sendPlanA.planId,
      approval: carrierApproval(sendPlanA, "send-a")
    }
  );
  assert.equal(sendExecutedA.response.status, 200, sendExecutedA.text);
  assert.equal(sendCount, 1);
  assert.equal(sendExecutedA.body.result.receipt.status, "executed");
  const sendReceiptA =
    sendExecutedA.body.result.plan.result.batch.completed[0].receipt;
  assert.equal(sendReceiptA.verifiedByReadback, true);
  assert.equal(
    sendReceiptA.sourceDraftRetention,
    "retained_for_separate_cleanup"
  );
  assert.match(sendReceiptA.sourceDraftRef, /^ref_[a-f0-9]{32}$/);
  assert.match(sendReceiptA.sentMessageRef, /^ref_[a-f0-9]{32}$/);

  const receiptA = await post(
    "/integrations/jobrolo/v1/carrier-emails/receipts/detail",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: sendPlanA.planId
    }
  );
  assert.equal(receiptA.response.status, 200, receiptA.text);
  assert.equal(receiptA.body.result.receipt.status, "executed");

  const duplicateSendPrepare = await post(
    "/integrations/jobrolo/v1/carrier-emails/sends/prepare",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      fileRef: fileRefA,
      draftRef: draftReceiptA.createdDraftRef
    }
  );
  assert.equal(duplicateSendPrepare.response.status, 409);
  assert.equal(sendCount, 1);

  const fileRefB = references.subjectId("jobnimbus", "carrier-file-b");
  const documentRefB = references.sourceRecordRef(
    "jobnimbus",
    "carrier-document-b"
  );
  const carrierSessionB = `session_${"c".repeat(32)}`;
  const draftPreparedB = await post(
    "/integrations/jobrolo/v1/carrier-emails/drafts/prepare",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      fileRef: fileRefB,
      documentRef: documentRefB,
      body: carrierBodyB
    },
    { sessionRef: carrierSessionB }
  );
  assert.equal(draftPreparedB.response.status, 200, draftPreparedB.text);
  const draftPlanB = draftPreparedB.body.result.plan;
  const draftExecutedB = await post(
    "/integrations/jobrolo/v1/carrier-emails/drafts/execute",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: draftPlanB.planId,
      approval: carrierApproval(draftPlanB, "draft-b")
    },
    { sessionRef: carrierSessionB }
  );
  assert.equal(draftExecutedB.response.status, 200, draftExecutedB.text);
  assert.equal(draftCreateCount, 2);
  const draftRefB =
    draftExecutedB.body.result.plan.result.batch.completed[0]
      .receipt.createdDraftRef;
  const sendPreparedB = await post(
    "/integrations/jobrolo/v1/carrier-emails/sends/prepare",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      fileRef: fileRefB,
      draftRef: draftRefB
    },
    { sessionRef: carrierSessionB }
  );
  assert.equal(sendPreparedB.response.status, 200, sendPreparedB.text);
  const sendPlanB = sendPreparedB.body.result.plan;
  mismatchedSentMessages.add("carrier-sent-b");
  const uncertainSend = await post(
    "/integrations/jobrolo/v1/carrier-emails/sends/execute",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: sendPlanB.planId,
      approval: carrierApproval(sendPlanB, "send-b")
    },
    { sessionRef: carrierSessionB }
  );
  assert.equal(uncertainSend.response.status, 200, uncertainSend.text);
  assert.equal(sendCount, 2);
  assert.equal(
    uncertainSend.body.result.receipt.status,
    "reconciliation_required"
  );
  assert.equal(
    uncertainSend.body.result.plan.status,
    "reconciliation_required"
  );

  const uncertainReceipt = await post(
    "/integrations/jobrolo/v1/carrier-emails/receipts/detail",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      planId: sendPlanB.planId
    },
    { sessionRef: carrierSessionB }
  );
  assert.equal(uncertainReceipt.response.status, 200, uncertainReceipt.text);
  assert.equal(
    uncertainReceipt.body.result.receipt.status,
    "reconciliation_required"
  );
  const rejectedUncertainRetry = await post(
    "/integrations/jobrolo/v1/carrier-emails/sends/prepare",
    {
      contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
      fileRef: fileRefB,
      draftRef: draftRefB
    },
    { sessionRef: carrierSessionB }
  );
  assert.equal(rejectedUncertainRetry.response.status, 409);
  assert.equal(sendCount, 2, "an uncertain send must never auto-retry");
});

function carrierApproval(plan, suffix, overrides = {}) {
  return {
    schema: "jobrolo.approval-attestation.v1",
    approvalRequestId: `approval_${suffix}`,
    planDigest: plan.approvalDigest,
    approvedAt: new Date().toISOString(),
    approvedByUserId: "user_carrier_http_fixture",
    ...overrides
  };
}

function carrierGmailMessage(
  fixture,
  { id, labels, to = fixture.to, subject = fixture.subject }
) {
  return {
    id,
    threadId: fixture.threadId,
    labelIds: labels,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "To", value: to },
        { name: "Subject", value: subject }
      ],
      parts: [{
        partId: "0",
        filename: "",
        mimeType: "text/plain",
        headers: [{
          name: "Content-Type",
          value: "text/plain; charset=utf-8"
        }],
        body: {
          data: Buffer.from(fixture.body, "utf8").toString("base64url"),
          size: Buffer.byteLength(fixture.body, "utf8")
        }
      }, {
        partId: "1",
        filename: fixture.filename,
        mimeType: "application/pdf",
        headers: [{
          name: "Content-Disposition",
          value: `attachment; filename="${fixture.filename}"`
        }],
        body: {
          data: fixture.bytes.toString("base64url"),
          size: fixture.bytes.length
        }
      }]
    }
  };
}

function carrierRelatedFilter(url) {
  try {
    const filter = JSON.parse(url.searchParams.get("filter") || "{}");
    return String(
      filter?.must?.[0]?.term?.["related.id"] || ""
    );
  } catch {
    return "";
  }
}

async function carrierSignedPost(
  origin,
  pathname,
  { requestId, sessionRef, nonce, input, clientId, secret }
) {
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId,
    actor: { sessionRef },
    input
  };
  const headers = signJobroloHcnRequest({
    clientId,
    secret,
    pathname,
    timestamp: Date.now(),
    nonce,
    body
  });
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    text,
    body: text ? JSON.parse(text) : null
  };
}

function carrierReadJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.once("error", reject);
    req.once("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function carrierJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function carrierReservePort() {
  const server = createServer();
  await carrierListen(server);
  const port = server.address().port;
  await carrierCloseServer(server);
  return port;
}

function carrierListen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function carrierCloseServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function carrierStopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
}

async function carrierWaitForBridge(child, port, readOutput) {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bridge exited early:\n${readOutput()}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Bridge did not start:\n${readOutput()}`);
}
