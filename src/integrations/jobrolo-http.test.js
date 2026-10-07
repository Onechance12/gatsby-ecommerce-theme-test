import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHcnInvitationStore } from "../auth/hcn-invitation-store.js";
import { createHcnGoogleGrantStore } from "../auth/hcn-google-grant-store.js";
import { createHcnReferenceFactory } from "../hcn-ops/references.js";
import {
  JOBROLO_HCN_GENERAL_EFFECT_ROUTES,
  signJobroloHcnRequest
} from "./jobrolo-service-auth.js";
import {
  JOBROLO_HCN_CARRIER_EMAIL_CONTRACT
} from "./jobrolo-carrier-email.js";

const EMAIL = "chance@wavepa.com";
const SUBJECT = "chance-google-subject-fixture";
const OWNER_ID = "chance-jobnimbus-owner-fixture";
const SECOND_OWNER_ID = "second-jobnimbus-owner-fixture";
const THIRD_OWNER_ID = "third-jobnimbus-owner-fixture";
const CLIENT_ID = "jobrolo-http-fixture";
const SHARED_SECRET = "jobrolo-http-fixture-shared-secret-123456789";
const SECOND_GENERAL_CLIENT_ID = "jobrolo-http-second-pa";
const SECOND_GENERAL_SHARED_SECRET =
  "jobrolo-http-second-pa-shared-secret-123456789";
const NOTE_CLIENT_ID = "jobrolo-note-writeback-http-fixture";
const NOTE_SHARED_SECRET =
  "jobrolo-note-writeback-http-fixture-secret-123456789";
const QUO_CLIENT_PHONE = "+12145550199";
const REFERENCE_KEY = Buffer.alloc(32, 0x61).toString("base64url");

test("signed adapter fixes principal scope and requires both approval gates for one synthetic action", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-jobrolo-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invitationTimestamp = Date.now();
  const invitationStore = createHcnInvitationStore({
    filePath: path.join(
      root,
      "platform",
      "employee-invitations.enc.json"
    ),
    key: REFERENCE_KEY,
    allowedDomain: "",
    now: () => invitationTimestamp
  });
  const secondInvitation = await invitationStore.createInvitation({
    email: "second@wavepa.com",
    displayName: "Second Adjuster",
    role: "employee",
    jobNimbusOwnerId: SECOND_OWNER_ID,
    jobNimbusScope: "assigned",
    invitedByRef: `principal_${"a".repeat(64)}`,
    expiresAt: new Date(
      invitationTimestamp + 24 * 60 * 60_000
    ).toISOString()
  });
  await invitationStore.acceptInvitation({
    invitationRef: secondInvitation.invitationRef,
    email: "second@wavepa.com",
    googleSubject: "second-google-subject-fixture",
    inviteToken: secondInvitation.inviteToken
  });
  const providerCalls = [];
  const quoActivityLines = [];
  const providerWrites = [];
  const quoProviderWrites = [];
  let gmailMessages = [];
  const grantKey = Buffer.alloc(32, 0x63).toString("base64url");
  const grantPath = path.join(root, "platform", "google-grants.enc.json");
  const grantStore = createHcnGoogleGrantStore({ filePath: grantPath, encryptionKey: grantKey });
  const principalRef = `principal_${createHcnReferenceFactory({
    hmacKey: Buffer.from(REFERENCE_KEY, "base64url"), tenantId: "tenant_0123456789abcdef"
  }).subjectId("hcn_operator", `google:${SUBJECT}`).slice("subject_".length)}`;
  let createdNote = null;
  const assignedContact = {
    jnid: "assigned-file-provider-id",
    number: 2739,
    record_type_name: "Insurance",
    owners: [{ id: OWNER_ID }],
    display_name: "Assigned File Fixture",
    status_name: "Ready for Review",
    stage_name: "Carrier Review",
    mobile_phone: QUO_CLIENT_PHONE,
    is_active: true,
    date_updated: 1785261000
  };
  const assignedContactB = {
    jnid: "assigned-file-provider-id-b",
    number: 2740,
    record_type_name: "Insurance",
    owners: [{ id: OWNER_ID }],
    display_name: "Assigned File Fixture B",
    status_name: "Ready for Review",
    stage_name: "Carrier Review",
    mobile_phone: "+12145550198",
    is_active: true,
    date_updated: 1785260900
  };
  const archivedDuplicateContact = {
    ...assignedContact,
    jnid: "archived-duplicate-provider-id",
    number: 1701,
    display_name: "Archived Duplicate Fixture",
    owners: [{ id: "historical-owner-fixture" }],
    is_active: false,
    is_archived: true
  };
  const malformedUnrelatedContact = {
    jnid: "malformed-unrelated-provider-id",
    number: 1702,
    record_type_name: "Insurance",
    owners: [{ id: "unconfigured-owner-fixture" }],
    display_name: "Malformed Unrelated Fixture",
    mobile_phone: { legacy: "not-an-authoritative-phone" },
    is_active: true,
    is_archived: false
  };
  const inactiveMalformedTargetContact = {
    ...malformedUnrelatedContact,
    jnid: "inactive-malformed-target-provider-id",
    display_name: "Inactive Malformed Target Fixture",
    mobile_phone: { legacy: "214-555-0199" },
    is_active: false,
    is_archived: true
  };
  const nonInsuranceMalformedTargetContact = {
    ...malformedUnrelatedContact,
    jnid: "non-insurance-malformed-target-provider-id",
    record_type_name: "Customer",
    display_name: "Non-Insurance Malformed Target Fixture",
    mobile_phone: { legacy: "214-555-0199" }
  };
  const activeForeignDuplicateContact = {
    ...assignedContact,
    jnid: "active-foreign-duplicate-provider-id",
    number: 1703,
    display_name: "Active Foreign Duplicate Fixture",
    owners: [{ id: SECOND_OWNER_ID }]
  };
  const conflictingTargetDuplicateContact = {
    ...assignedContact,
    display_name: "Conflicting Duplicate Fixture"
  };
  const ambiguousMalformedEligibleContact = {
    jnid: "ambiguous-malformed-provider-id",
    number: 1704,
    record_type_name: "Insurance",
    owners: [{ id: SECOND_OWNER_ID }],
    display_name: "Ambiguous Malformed Fixture",
    mobile_phone: { legacy: "214-555-0199" },
    is_active: true,
    is_archived: false
  };
  let includeActiveForeignDuplicate = false;
  let includeIdenticalTargetDuplicate = false;
  let includeConflictingTargetDuplicate = false;
  let includeAmbiguousMalformedEligible = false;
  let includeOffTargetQuoCalls = false;
  let sharedPhoneTexts = null;
  let freshAssignedPhoneOverride = null;
  let withdrawOwnQuoLine = false;
  const provider = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://provider.invalid");
    providerCalls.push(url.pathname);
    if (req.method === "GET" && url.pathname === "/gmail/v1/users/me/profile") return json(res, 200, { emailAddress: EMAIL });
    if (req.method === "GET" && url.pathname === "/gmail/v1/users/me/messages") {
      return json(res, 200, { messages: gmailMessages.map(row => ({ id: row.id })), resultSizeEstimate: gmailMessages.length });
    }
    if (req.method === "GET" && url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      return json(res, 200, gmailMessages.find(row => row.id === url.pathname.split("/").at(-1)));
    }
    const quoLines = Array.from({ length: 12 }, (_, index) => ({
      id: `PN_${String(index + 1).padStart(2, "0")}`,
      name: `Team Line ${index + 1}`,
      number: `+1972555${String(1000 + index).slice(-4)}`
    }));
    if (req.method === "GET" && url.pathname === "/phone-numbers") {
      return json(res, 200, { data: withdrawOwnQuoLine ? quoLines.filter(line => line.id !== "PN_12") : quoLines });
    }
    if (req.method === "GET" && url.pathname === "/conversations") {
      return json(res, 200, { data: [] });
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        quoProviderWrites.push(body);
        json(res, 200, { data: { id: "synthetic-sms-id", phoneNumberId: body.from, to: body.to, status: "queued" } });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      const lineId = url.searchParams.get("phoneNumberId");
      quoActivityLines.push(lineId);
      const line = quoLines.find((candidate) => candidate.id === lineId);
      if (lineId === "PN_12" && sharedPhoneTexts) {
        return json(res, 200, { data: sharedPhoneTexts.map((content, index) => ({
          id: `MSG_shared_${index}`, phoneNumberId: lineId, from: QUO_CLIENT_PHONE,
          to: [line.number], direction: "incoming", createdAt: "2026-08-20T14:00:00.000Z", content
        })) });
      }
      return json(res, 200, {
        data: lineId === "PN_12" ? [{
          id: "MSG_line_12",
          phoneNumberId: lineId,
          from: QUO_CLIENT_PHONE,
          to: [line.number],
          createdAt: "2026-08-20T14:00:00.000Z",
          direction: "incoming",
          content: "Verified line-12 fixture message."
        }] : []
      });
    }
    if (req.method === "GET" && url.pathname === "/calls") {
      const lineId = url.searchParams.get("phoneNumberId");
      quoActivityLines.push(lineId);
      return json(res, 200, {
        data: includeOffTargetQuoCalls && lineId === "PN_12"
          ? [{
              id: "CALL_exact_line_12",
              phoneNumberId: lineId,
              participants: [QUO_CLIENT_PHONE],
              createdAt: "2026-08-20T14:05:00.000Z",
              direction: "incoming",
              status: "completed",
              duration: 60
            }, {
              id: "SECRET_UNVERIFIABLE_CALL",
              phoneNumberId: lineId,
              participants: { unsafe: "+12145559999" },
              createdAt: "2026-08-20T14:04:00.000Z",
              direction: "incoming",
              status: "completed",
              duration: 30
            }, ...Array.from({ length: 5 }, (_, index) => ({
              id: `SECRET_OFF_TARGET_CALL_${index + 1}`,
              phoneNumberId: lineId,
              participants: [`+1214555000${index}`],
              createdAt: `2026-08-20T1${index}:00:00.000Z`,
              direction: "incoming",
              status: "completed",
              duration: 30
            }))]
          : []
      });
    }
    if (req.method === "GET" && url.pathname === "/account/users") {
      return json(res, 200, {
        total: 3,
        users: [{
          jnid: OWNER_ID,
          email: EMAIL,
          display_name: "Chance Pearson",
          is_active: true
        }, {
          jnid: SECOND_OWNER_ID,
          email: "second@wavepa.com",
          display_name: "Second Adjuster",
          is_active: true
        }, {
          jnid: THIRD_OWNER_ID,
          email: "third@wavepa.com",
          display_name: "Third Adjuster",
          is_active: true
        }]
      });
    }
    if (req.method === "GET" && url.pathname === "/contacts") {
      return json(res, 200, {
        contacts: [
          assignedContact,
          assignedContactB,
          archivedDuplicateContact,
          malformedUnrelatedContact,
          inactiveMalformedTargetContact,
          nonInsuranceMalformedTargetContact,
          ...(includeIdenticalTargetDuplicate
            ? [assignedContact]
            : []),
          ...(includeConflictingTargetDuplicate
            ? [conflictingTargetDuplicateContact]
            : []),
          ...(includeAmbiguousMalformedEligible
            ? [ambiguousMalformedEligibleContact]
            : []),
          ...(includeActiveForeignDuplicate
            ? [activeForeignDuplicateContact]
            : [])
        ]
      });
    }
    if (
      req.method === "GET"
      && url.pathname === "/contacts/assigned-file-provider-id"
    ) {
      return json(res, 200, freshAssignedPhoneOverride === null
        ? assignedContact
        : {
            ...assignedContact,
            mobile_phone: freshAssignedPhoneOverride
          });
    }
    if (
      req.method === "GET"
      && url.pathname === "/contacts/assigned-file-provider-id-b"
    ) {
      return json(res, 200, assignedContactB);
    }
    if (req.method === "GET" && url.pathname === "/activities") {
      return json(res, 200, { activities: [] });
    }
    if (
      req.method === "GET"
      && url.pathname === "/activities/synthetic-note-provider-id"
      && createdNote
    ) {
      return json(res, 200, createdNote);
    }
    if (req.method === "GET" && url.pathname === "/tasks") {
      return json(res, 200, { tasks: [] });
    }
    if (req.method === "GET" && url.pathname === "/files") {
      return json(res, 200, { files: [] });
    }
    if (req.method === "POST" && url.pathname === "/activities") {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        providerWrites.push(body);
        createdNote = {
          jnid: "synthetic-note-provider-id",
          record_type_name: "Note",
          note: body.note === "Synthetic unconfirmed readback fixture."
            ? "Provider returned different note material."
            : body.note,
          primary: body.primary
        };
        json(res, 200, { jnid: "synthetic-note-provider-id" });
      });
      return;
    }
    return json(res, 404, { error: "not found" });
  });
  await listen(provider);
  t.after(() => closeServer(provider));

  const bridgePort = await reservePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${bridgePort}`,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: `http://127.0.0.1:${bridgePort}`,
      HCN_GOOGLE_LOGIN_ALLOWED_DOMAIN: "wavepa.com",
      CHANCE_GOOGLE_EMAIL: EMAIL,
      CHANCE_GOOGLE_SUBJECT: SUBJECT,
      CHANCE_JOBNIMBUS_OWNER_ID: OWNER_ID,
      WAVE_AUTH_USERS_JSON: JSON.stringify([{
        email: "second@wavepa.com",
        name: "Second Adjuster",
        role: "employee",
        googleSubject: "second-google-subject-fixture",
        jobNimbusOwnerId: SECOND_OWNER_ID,
        jobNimbusScope: "assigned"
      }]),
      JOBNIMBUS_API_KEY: "jobnimbus-http-fixture-key",
      JOBNIMBUS_API_BASE_URL:
        `http://127.0.0.1:${provider.address().port}`,
      HCN_TENANT_ID: "tenant_0123456789abcdef",
      HCN_REFERENCE_KEY: REFERENCE_KEY,
      HCN_OPERATIONS_ROOT: root,
      HCN_JOBROLO_ADAPTER_ENABLED: "true",
      HCN_JOBROLO_CLIENT_ID: CLIENT_ID,
      HCN_JOBROLO_SHARED_SECRET: SHARED_SECRET,
      HCN_JOBROLO_PRINCIPAL_EMAIL: EMAIL,
      HCN_JOBROLO_ADDITIONAL_PROFILES_JSON: JSON.stringify({
        schema: "hcn.jobrolo.general-profiles.v1",
        profiles: [{
          clientId: SECOND_GENERAL_CLIENT_ID,
          sharedSecret: SECOND_GENERAL_SHARED_SECRET,
          principalEmail: "second@wavepa.com",
          effectMode: "read_only"
        }]
      }),
      HCN_JOBROLO_NOTE_WRITEBACK_ENABLED: "true",
      HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID: NOTE_CLIENT_ID,
      HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET: NOTE_SHARED_SECRET,
      HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL: EMAIL,
      HCN_MANAGEMENT_ADJUSTERS_JSON: JSON.stringify([{
        ownerId: OWNER_ID,
        displayName: "Chance Pearson"
      }, {
        ownerId: SECOND_OWNER_ID,
        displayName: "Second Adjuster"
      }, {
        ownerId: THIRD_OWNER_ID,
        displayName: "Third Adjuster"
      }]),
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "",
      CODEX_MAC_OPERATOR_TOKEN: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      HCN_GOOGLE_CLIENT_ID: "fixture-hcn-google-client",
      HCN_GOOGLE_CLIENT_SECRET: "fixture-hcn-google-secret",
      HCN_GOOGLE_GRANT_KEY: grantKey,
      HCN_GOOGLE_GRANT_STORE_PATH: grantPath,
      GMAIL_API_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      HCN_QUO_LINK_KEY: "",
      HCN_ASSISTANT_HISTORY_KEY:
        Buffer.alloc(32, 0x62).toString("base64url"),
      HCN_THRESHER_AI_ENABLED: "true",
      HCN_THRESHER_AI_GROQ_API_KEY: "",
      QUO_API_KEY: "quo-http-fixture-key",
      QUO_API_BASE_URL:
        `http://127.0.0.1:${provider.address().port}`,
      QUO_DEFAULT_FROM_NUMBER: "+19725551011",
      TWILIO_AUTH_TOKEN: "",
      RETELL_API_KEY: "",
      OPENAI_API_KEY: "",
      OAUTH_SESSION_SECRET: "",
      GPT_OAUTH_CLIENT_SECRET: "",
      BRIDGE_ALLOW_WRITES: "true",
      ALLOW_QUO_SEND: "true",
      HCN_ACTION_EXECUTION_ENABLED: "true",
      HCN_THRESHER_ENABLED: "false",
      HCN_THRESHER_STORE_KEY: "",
      HCN_THRESHER_REFERENCE_KEY: "",
      HCN_THRESHER_SIGNING_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  t.after(() => stopChild(child));
  await waitForBridge(child, bridgePort, () => output);

  const origin = `http://127.0.0.1:${bridgePort}`;
  const sessionRef = "session_0123456789abcdef0123456789abcdef";
  const status = await signedPost(origin, "/integrations/jobrolo/v1/status", {
    requestId: "request_11111111111111111111111111111111",
    sessionRef,
    nonce: "nonce_11111111111111111111111111111111",
    input: {}
  });
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.body.schema, "hcn.jobrolo.response.v1");
  assert.equal(status.body.result.adapter.status, "connected");
  assert.equal(status.body.result.adapter.managementSweepExposed, true);
  assert.equal(status.body.result.adapter.managementSweepReady, true);
  assert.equal(status.body.result.adapter.communicationSweepReady, true);
  assert.equal(status.body.result.adapter.quoPhoneHistoryReady, true);
  assert.equal(status.body.result.quo.status, "connected");
  assert.equal(status.body.result.quo.senderSelection, "authenticated_employee");
  assert.equal(status.body.result.quo.jobroloConnectSupported, true);
  assert.equal(status.body.result.quo.sendReady, true, "the isolated fixture explicitly enables native sending");
  const secondStatus = await signedPost(
    origin,
    "/integrations/jobrolo/v1/status",
    {
      requestId: `request_${"1a".repeat(16)}`,
      sessionRef: `session_${"2b".repeat(16)}`,
      nonce: `nonce_${"3c".repeat(16)}`,
      input: {},
      clientId: SECOND_GENERAL_CLIENT_ID,
      secret: SECOND_GENERAL_SHARED_SECRET
    }
  );
  assert.equal(secondStatus.response.status, 200, secondStatus.text);
  assert.equal(secondStatus.body.result.profile.email, "second@wavepa.com");
  assert.equal(secondStatus.body.result.quo.status, "not_connected", "another employee cannot borrow Chance's default line");
  assert.equal(secondStatus.body.result.quo.line, null);
  includeActiveForeignDuplicate = true;
  const secondWorkCenter = await signedPost(
    origin,
    "/integrations/jobrolo/v1/work-center",
    {
      requestId: `request_${"4d".repeat(16)}`,
      sessionRef: `session_${"2b".repeat(16)}`,
      nonce: `nonce_${"5e".repeat(16)}`,
      input: { offset: 0, limit: 10 },
      clientId: SECOND_GENERAL_CLIENT_ID,
      secret: SECOND_GENERAL_SHARED_SECRET
    }
  );
  includeActiveForeignDuplicate = false;
  assert.equal(secondWorkCenter.response.status, 200, secondWorkCenter.text);
  assert.equal(secondWorkCenter.body.result.files.length, 1);
  assert.equal(
    secondWorkCenter.body.result.files[0].displayName,
    "Active Foreign Duplicate Fixture"
  );
  assert.doesNotMatch(secondWorkCenter.text, /Assigned File Fixture B/);
  assert.equal(secondStatus.body.result.adapter.effectMode, "read_only");
  assert.equal(secondStatus.body.result.adapter.actions, "read_only");
  const secondCarrierStatus = await signedPost(
    origin,
    "/integrations/jobrolo/v1/carrier-emails/status",
    {
      requestId: `request_${"6a".repeat(16)}`,
      sessionRef: `session_${"2b".repeat(16)}`,
      nonce: `nonce_${"6b".repeat(16)}`,
      input: { contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT },
      clientId: SECOND_GENERAL_CLIENT_ID,
      secret: SECOND_GENERAL_SHARED_SECRET
    }
  );
  assert.equal(
    secondCarrierStatus.response.status,
    200,
    secondCarrierStatus.text
  );
  assert.equal(secondCarrierStatus.body.result.effectMode, "read_only");
  assert.equal(secondCarrierStatus.body.result.ready, false);
  assert.equal(secondCarrierStatus.body.result.draft.ready, false);
  assert.equal(secondCarrierStatus.body.result.send.ready, false);
  const providerCallCountBeforeReadOnlyEffects = providerCalls.length;
  const providerWriteCountBeforeReadOnlyEffects = providerWrites.length;
  for (
    let index = 0;
    index < JOBROLO_HCN_GENERAL_EFFECT_ROUTES.length;
    index += 1
  ) {
    const route = JOBROLO_HCN_GENERAL_EFFECT_ROUTES[index];
    const requestToken = (0x80 + index).toString(16).padStart(2, "0");
    const nonceToken = (0xa0 + index).toString(16).padStart(2, "0");
    const rejected = await signedPost(origin, route, {
      requestId: `request_${requestToken.repeat(16)}`,
      sessionRef: `session_${"2b".repeat(16)}`,
      nonce: `nonce_${nonceToken.repeat(16)}`,
      input: {},
      clientId: SECOND_GENERAL_CLIENT_ID,
      secret: SECOND_GENERAL_SHARED_SECRET
    });
    assert.equal(rejected.response.status, 403, `${route}: ${rejected.text}`);
  }
  assert.equal(providerCalls.length, providerCallCountBeforeReadOnlyEffects);
  assert.equal(providerWrites.length, providerWriteCountBeforeReadOnlyEffects);
  assert.deepEqual(status.body.result.adapter.readRoutes, [
    "/integrations/jobrolo/v1/status",
    "/integrations/jobrolo/v1/work-center",
    "/integrations/jobrolo/v1/file-review",
    "/integrations/jobrolo/v1/communication-sweep",
    "/integrations/jobrolo/v1/quo-phone-history",
    "/integrations/jobrolo/v1/management-sweep"
  ]);
  assert.equal(status.body.result.adapter.importTransport.ready, false);
  assert.equal(
    status.body.result.adapter.importTransport.photoManifestsExposed,
    true
  );
  assert.equal(status.body.result.profile.email, EMAIL);
  assert.equal(status.body.result.jobNimbus.scope, "assigned");

  const workCenter = await signedPost(
    origin,
    "/integrations/jobrolo/v1/work-center",
    {
      requestId: "request_22222222222222222222222222222222",
      sessionRef,
      nonce: "nonce_22222222222222222222222222222222",
      input: { offset: 0, limit: 10 }
    }
  );
  assert.equal(workCenter.response.status, 200, workCenter.text);
  assert.equal(workCenter.body.result.schema, "hcn.console.work-center.v1");
  assert.equal(workCenter.body.result.files.length, 2);
  const workCenterByName = new Map(
    workCenter.body.result.files.map((file) => [file.displayName, file])
  );
  assert.equal(workCenterByName.size, 2);
  assert.match(
    workCenterByName.get("Assigned File Fixture").fileRef,
    /^subject_[a-f0-9]{32}$/
  );
  assert.equal(providerCalls.includes("/account/users"), true);
  assert.equal(providerCalls.includes("/contacts"), true);

  const fileReview = await signedPost(
    origin,
    "/integrations/jobrolo/v1/file-review",
    {
      requestId: "request_94949494949494949494949494949494",
      sessionRef,
      nonce: "nonce_94949494949494949494949494949494",
      input: {
        fileRef: workCenterByName.get("Assigned File Fixture").fileRef,
        recentLimit: 20
      }
    }
  );
  assert.equal(fileReview.response.status, 200, fileReview.text);
  assert.equal(fileReview.body.result.schema, "hcn.console.file.v1");
  assert.equal(fileReview.body.result.sources.quo.status, "fresh");
  assert.equal(fileReview.body.result.recent.quo.length, 0);
  assert.ok(fileReview.body.result.sources.quo.limitations.includes("signed_in_employee_line_only"));
  assert.deepEqual([...new Set(quoActivityLines)], ["PN_12"], "personal exact-file review never probes other employees' history");
  assert.ok(fileReview.body.result.sources.quo.limitations.includes("no_unique_file_anchor"));
  assert.ok(fileReview.body.result.sources.quo.limitations.includes("unattributed_phone_history_withheld"));
  assert.equal(providerWrites.length, 0);

  // A shared destination is not proof of file membership. Only uniquely
  // anchored own-line messages and minimized contact opt-outs are attributable.
  assignedContact.address_line1 = "21 Maple Ave";
  assignedContact.cf_string_2 = "SYNTH-614027ZX";
  activeForeignDuplicateContact.address_line1 = "90 Birch Ct";
  activeForeignDuplicateContact.cf_string_2 = "SYNTH-95281740";
  activeForeignDuplicateContact.status_name = "Billed";
  includeActiveForeignDuplicate = true;
  sharedPhoneTexts = [
    "Please send the policy for 21 Maple Ave.", "STOP",
    "SECRET_OTHER_PROPERTY: policy for 90 Birch Ct",
    "SECRET_MIXED_PROPERTY: 21 Maple Ave and 90 Birch Ct",
    "SECRET_UNATTRIBUTED: here is the policy"
  ];
  quoActivityLines.length = 0;
  const exactSharedReview = token => signedPost(origin, "/integrations/jobrolo/v1/file-review", {
    requestId: `request_${token.repeat(16)}`, sessionRef, nonce: `nonce_${token.repeat(16)}`,
    input: { fileRef: workCenterByName.get("Assigned File Fixture").fileRef, recentLimit: 20 }
  });
  const sharedReview = await exactSharedReview("f1");
  assert.equal(sharedReview.response.status, 200, sharedReview.text);
  assert.equal(sharedReview.body.result.sources.quo.status, "fresh");
  assert.equal(sharedReview.body.result.sources.quo.completeness, "partial");
  assert.deepEqual([...new Set(quoActivityLines)], ["PN_12"]);
  assert.equal(sharedReview.body.result.recent.quo.length, 2);
  assert.ok(sharedReview.body.result.recent.quo.some(item => /policy for 21 Maple Ave/.test(item.preview)));
  assert.ok(sharedReview.body.result.recent.quo.some(item => /opt-out.*Do not send/.test(item.preview)));
  for (const code of ["shared_phone_exact_file_messages_only", "unattributed_phone_history_withheld", "signed_in_employee_line_only"]) {
    assert.ok(sharedReview.body.result.sources.quo.limitations.includes(code));
  }
  assert.doesNotMatch(JSON.stringify(sharedReview.body), /SECRET_|90 Birch Ct|SYNTH-95281740|active-foreign-duplicate-provider-id/);
  assert.equal(providerWrites.length, 0);

  sharedPhoneTexts = sharedPhoneTexts.slice(2);
  const unattributedReview = await exactSharedReview("f2");
  assert.equal(unattributedReview.response.status, 200, unattributedReview.text);
  assert.equal(unattributedReview.body.result.recent.quo.length, 0);
  assert.equal(unattributedReview.body.result.sources.quo.completeness, "partial");
  assert.ok(unattributedReview.body.result.sources.quo.limitations.includes("unattributed_phone_history_withheld"));
  assert.doesNotMatch(JSON.stringify(unattributedReview.body), /SECRET_/);

  // Shared email AND claim token: a unique property is an independent anchor.
  assignedContact.email = activeForeignDuplicateContact.email = "owner@example.test";
  activeForeignDuplicateContact.cf_string_2 = assignedContact.cf_string_2;
  await grantStore.upsert({ principalRef, refreshToken: "fixture-private-refresh", accessToken: "fixture-cached-access",
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: ["https://www.googleapis.com/auth/gmail.modify"] });
  const gmailFixture = (id, text, labels = ["INBOX"]) => ({
    id, threadId: `thread_${id}`, labelIds: labels, internalDate: String(Date.now()), snippet: text,
    payload: { mimeType: "text/plain", headers: [
      { name: "From", value: labels.includes("SENT") ? EMAIL : "adjuster@carrier.example.test" },
      { name: "To", value: labels.includes("SENT") ? "owner@example.test" : EMAIL },
      { name: "Subject", value: "Property policy review" },
    ], body: { data: Buffer.from(text).toString("base64url") } }
  });
  gmailMessages = [
    gmailFixture("target_incoming", "Policy for 21 Maple Avenue"),
    gmailFixture("target_sent", "Policy requested for 21 Maple Ave", ["SENT"]),
    gmailFixture("foreign_property", "SECRET_FOREIGN_EMAIL: policy for 90 Birch Ct"),
    gmailFixture("mixed_properties", "SECRET_MIXED_EMAIL: 21 Maple Ave and 90 Birch Court"),
    gmailFixture("unattributed", "SECRET_UNBOUND_EMAIL: the policy is attached"),
  ];
  const sharedEmailReview = await exactSharedReview("e1");
  assert.equal(sharedEmailReview.response.status, 200, sharedEmailReview.text);
  assert.equal(sharedEmailReview.body.result.sources.gmail.status, "fresh");
  assert.equal(sharedEmailReview.body.result.sources.gmail.completeness, "partial");
  assert.equal(sharedEmailReview.body.result.recent.gmail.length, 2);
  assert.doesNotMatch(JSON.stringify(sharedEmailReview.body.result.recent.gmail), /SECRET_|foreign_property|mixed_properties|unattributed/);
  assert.ok(sharedEmailReview.body.result.recent.gmail.some(item => item.deliveryState === "sent_verified"), JSON.stringify(sharedEmailReview.body.result.recent.gmail));
  await grantStore.revoke({ principalRef });
  gmailMessages = [];
  delete assignedContact.email;
  delete activeForeignDuplicateContact.email;
  activeForeignDuplicateContact.cf_string_2 = "SYNTH-95281740";

  // Same policyholder and destination across two assigned files is legitimate.
  const originalB = { phone: assignedContactB.mobile_phone, name: assignedContactB.display_name };
  assignedContactB.mobile_phone = QUO_CLIENT_PHONE;
  assignedContactB.display_name = assignedContact.display_name;
  assignedContactB.address_line1 = "77 Pine Ln";
  assignedContactB.cf_string_2 = "SYNTH-SECOND-2026";
  sharedPhoneTexts = ["Policy requested for 21 Maple Ave", "SECRET_OTHER_PROPERTY: policy for 90 Birch Ct"];
  let smsSessionRef = `session_${"a".repeat(32)}`;
  let smsRequestNumber = 900;
  const smsRequest = (pathname, input) => {
    const token = (++smsRequestNumber).toString(16).padStart(32, "0");
    return signedPost(origin, pathname, { requestId: `request_${token}`, nonce: `nonce_${token}`, sessionRef: smsSessionRef, input });
  };
  const smsInput = {
    fileRef: workCenterByName.get("Assigned File Fixture").fileRef,
    operations: [{ type: "quo.send_text", input: { to: QUO_CLIENT_PHONE, content: "Please email the policy for 21 Maple Ave." } }]
  };
  quoActivityLines.length = 0;
  const preparedSms = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
  assert.equal(preparedSms.response.status, 200, preparedSms.text);
  assert.equal(preparedSms.body.result.plan.operations[0].material.to, QUO_CLIENT_PHONE);
  assert.equal(preparedSms.body.result.plan.operations[0].material.from, "+19725551011");
  assert.match(preparedSms.body.result.plan.file.displayLabel, /2739.*21 Maple Ave.*SYNTH-614027ZX/);
  assert.deepEqual([...new Set(quoActivityLines)], ["PN_12"]);
  assert.equal(quoProviderWrites.length, 0);
  const secondFileSms = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", {
    fileRef: workCenterByName.get("Assigned File Fixture B").fileRef,
    operations: [{ type: "quo.send_text", input: { to: QUO_CLIENT_PHONE, content: "Policy requested for 77 Pine Ln." } }]
  });
  assert.equal(secondFileSms.response.status, 200, secondFileSms.text);
  assert.match(secondFileSms.body.result.plan.file.displayLabel, /2740.*77 Pine Ln.*SYNTH-SECOND-2026/);
  assert.notEqual(secondFileSms.body.result.plan.file.reference, preparedSms.body.result.plan.file.reference);
  assert.notEqual(secondFileSms.body.result.plan.approvalDigest, preparedSms.body.result.plan.approvalDigest);
  assert.equal(quoProviderWrites.length, 0, "both separate assigned files can prepare for the same verified person");
  const readsBeforeWrongRecipient = quoActivityLines.length;
  const arbitraryRecipient = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", {
    ...smsInput, operations: [{ type: "quo.send_text", input: { to: "+12145550008", content: "Must not be prepared." } }]
  });
  assert.notEqual(arbitraryRecipient.response.status, 200);
  assert.equal(quoActivityLines.length, readsBeforeWrongRecipient);
  sharedPhoneTexts = ["STOP about 90 Birch Ct", "Please don't text me about 90 Birch Ct"];
  const optOut = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
  assert.notEqual(optOut.response.status, 200);
  assert.match(optOut.text, /contact-level opt-out/);
  assert.doesNotMatch(optOut.text, /90 Birch Ct/);
  assert.equal(quoProviderWrites.length, 0);
  sharedPhoneTexts = ["Policy requested for 21 Maple Ave"];
  const staleCandidate = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
  assert.equal(staleCandidate.response.status, 200, staleCandidate.text);
  const smsApproval = plan => ({ schema: "jobrolo.approval-attestation.v1", approvalRequestId: "approval_shared_phone_fixture",
    planDigest: plan.approvalDigest, approvedAt: new Date().toISOString(), approvedByUserId: "user_0123456789abcdef" });
  assignedContact.address_line1 = "22 Maple Ave";
  const changedProperty = await smsRequest("/integrations/jobrolo/v1/action-plans/execute", {
    planId: staleCandidate.body.result.plan.planId, approval: smsApproval(staleCandidate.body.result.plan)
  });
  assert.equal(changedProperty.response.status, 409, changedProperty.text);
  assert.equal(quoProviderWrites.length, 0);
  assignedContact.address_line1 = "21 Maple Ave";
  for (const [field, replacement] of [
    ["cf_string_2", "SYNTH-CHANGED-CLAIM"], ["address_line2", "Apt 3"],
    ["display_name", "Changed Policyholder Fixture"], ["mobile_phone", "+12145550197"]
  ]) {
    // Independent conversations keep each prepare/execute pair inside the
    // unchanged production per-session admission limits.
    smsSessionRef = `session_${(++smsRequestNumber).toString(16).padStart(32, "0")}`;
    const candidate = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
    assert.equal(candidate.response.status, 200, candidate.text);
    const previous = assignedContact[field];
    assignedContact[field] = replacement;
    const changedIdentity = await smsRequest("/integrations/jobrolo/v1/action-plans/execute", {
      planId: candidate.body.result.plan.planId, approval: smsApproval(candidate.body.result.plan)
    });
    if (previous === undefined) delete assignedContact[field];
    else assignedContact[field] = previous;
    assert.equal(changedIdentity.response.status, 409, `${field}: ${changedIdentity.text}`);
    assert.equal(quoProviderWrites.length, 0);
  }
  for (const revoked of ["assignment", "own-line"]) {
    smsSessionRef = `session_${(++smsRequestNumber).toString(16).padStart(32, "0")}`;
    const candidate = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
    assert.equal(candidate.response.status, 200, candidate.text);
    const owners = assignedContact.owners;
    if (revoked === "assignment") assignedContact.owners = [{ id: SECOND_OWNER_ID }];
    else withdrawOwnQuoLine = true;
    const denied = await smsRequest("/integrations/jobrolo/v1/action-plans/execute", {
      planId: candidate.body.result.plan.planId, approval: smsApproval(candidate.body.result.plan)
    });
    assignedContact.owners = owners;
    withdrawOwnQuoLine = false;
    assert.notEqual(denied.response.status, 200, `${revoked}: ${denied.text}`);
    assert.equal(quoProviderWrites.length, 0, "revocation must precede every provider effect");
    const readback = await smsRequest("/integrations/jobrolo/v1/action-receipts/detail", { planId: candidate.body.result.plan.planId });
    assert.notEqual(readback.response.status, 200, "a failed preflight must not create a false uncertain-send receipt");
  }
  smsSessionRef = `session_${(++smsRequestNumber).toString(16).padStart(32, "0")}`;
  const beforeNewOptOut = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
  assert.equal(beforeNewOptOut.response.status, 200, beforeNewOptOut.text);
  sharedPhoneTexts = ["STOP"];
  const newOptOut = await smsRequest("/integrations/jobrolo/v1/action-plans/execute", {
    planId: beforeNewOptOut.body.result.plan.planId, approval: smsApproval(beforeNewOptOut.body.result.plan)
  });
  assert.equal(newOptOut.response.status, 409, newOptOut.text);
  assert.match(newOptOut.text, /contact-level opt-out/);
  assert.equal(quoProviderWrites.length, 0);
  const optOutReceipt = await smsRequest("/integrations/jobrolo/v1/action-receipts/detail", { planId: beforeNewOptOut.body.result.plan.planId });
  assert.notEqual(optOutReceipt.response.status, 200);
  sharedPhoneTexts = ["Policy requested for 21 Maple Ave"];
  freshAssignedPhoneOverride = "+12145550197";
  const changedRecipient = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
  assert.notEqual(changedRecipient.response.status, 200);
  assert.equal(quoProviderWrites.length, 0);
  freshAssignedPhoneOverride = null;
  const finalSms = await smsRequest("/integrations/jobrolo/v1/action-plans/prepare", smsInput);
  assert.equal(finalSms.response.status, 200, finalSms.text);
  const approvedSmsInput = { planId: finalSms.body.result.plan.planId, approval: smsApproval(finalSms.body.result.plan) };
  const sentSms = await smsRequest("/integrations/jobrolo/v1/action-plans/execute", approvedSmsInput);
  assert.equal(sentSms.response.status, 200, sentSms.text);
  assert.equal(quoProviderWrites.length, 1);
  assert.equal(quoProviderWrites[0].from, "PN_12");
  assert.deepEqual(quoProviderWrites[0].to, [QUO_CLIENT_PHONE]);
  const replaySms = await smsRequest("/integrations/jobrolo/v1/action-plans/execute", approvedSmsInput);
  assert.equal(replaySms.response.status, 409);
  assert.equal(quoProviderWrites.length, 1);
  assignedContactB.mobile_phone = originalB.phone;
  assignedContactB.display_name = originalB.name;
  delete assignedContactB.address_line1;
  delete assignedContactB.cf_string_2;

  delete assignedContact.address_line1;
  delete assignedContact.cf_string_2;
  const readsBeforeMissingAnchors = quoActivityLines.length;
  const missingAnchorReview = await exactSharedReview("f3");
  assert.equal(missingAnchorReview.response.status, 200, missingAnchorReview.text);
  assert.equal(missingAnchorReview.body.result.sources.quo.failureCode, "phone_match_shared_active_files");
  assert.equal(missingAnchorReview.body.result.recent.quo.length, 0);
  assert.equal(quoActivityLines.length, readsBeforeMissingAnchors);
  assert.equal(providerWrites.length, 0);
  delete activeForeignDuplicateContact.address_line1;
  delete activeForeignDuplicateContact.cf_string_2;
  activeForeignDuplicateContact.status_name = "Ready for Review";
  sharedPhoneTexts = null;
  includeActiveForeignDuplicate = false;
  includeAmbiguousMalformedEligible = true;
  const readsBeforeMalformedMatch = quoActivityLines.length;
  const malformedMatchReview = await exactSharedReview("f4");
  assert.equal(malformedMatchReview.response.status, 200, malformedMatchReview.text);
  assert.equal(malformedMatchReview.body.result.sources.quo.failureCode, "phone_match_unverified");
  assert.equal(quoActivityLines.length, readsBeforeMalformedMatch);
  includeAmbiguousMalformedEligible = false;

  const communicationSweep = await signedPost(
    origin,
    "/integrations/jobrolo/v1/communication-sweep",
    {
      requestId: "request_98989898989898989898989898989898",
      sessionRef,
      nonce: "nonce_98989898989898989898989898989898",
      input: {
        communicationDays: 14,
        gmailLimit: 10,
        quoLimit: 20,
        quoTranscriptLimit: 4,
        includeQuoTranscripts: true
      }
    }
  );
  assert.equal(communicationSweep.response.status, 200, communicationSweep.text);
  assert.equal(
    communicationSweep.body.result.schema,
    "hcn.console.communication-sweep.v1"
  );
  assert.equal(
    communicationSweep.body.authority.fileScope,
    "assigned_only"
  );
  assert.equal(
    communicationSweep.body.result.scope.jobNimbus,
    "active_assigned_files_only"
  );
  assert.equal(communicationSweep.body.result.scope.readOnly, true);
  assert.equal(communicationSweep.body.result.activeFileCount, 2);
  assert.equal(communicationSweep.body.result.sources.gmail.status, "unavailable");
  assert.equal(communicationSweep.body.result.sources.quo.status, "fresh");
  assert.equal(communicationSweep.body.result.sources.quo.lineCount, 12);
  assert.equal(communicationSweep.body.result.safety.jobNimbusWrites, 0);
  assert.equal(providerWrites.length, 0);

  const rejectedCommunicationSweep = await signedPost(
    origin,
    "/integrations/jobrolo/v1/communication-sweep",
    {
      requestId: "request_97979797979797979797979797979797",
      sessionRef,
      nonce: "nonce_97979797979797979797979797979797",
      input: { ownerId: SECOND_OWNER_ID }
    }
  );
  assert.equal(rejectedCommunicationSweep.response.status, 400);
  assert.equal(providerWrites.length, 0);

  const rejectedQuoPhoneHistory = await signedPost(
    origin,
    "/integrations/jobrolo/v1/quo-phone-history",
    {
      requestId: "request_96969696969696969696969696969696",
      sessionRef,
      nonce: "nonce_96969696969696969696969696969696",
      input: { phone: "+19725731730", ownerId: SECOND_OWNER_ID }
    }
  );
  assert.equal(rejectedQuoPhoneHistory.response.status, 400);
  assert.equal(providerWrites.length, 0);

  includeOffTargetQuoCalls = true;
  includeIdenticalTargetDuplicate = true;
  const quoPhoneHistory = await signedPost(
    origin,
    "/integrations/jobrolo/v1/quo-phone-history",
    {
      requestId: "request_95959595959595959595959595959595",
      sessionRef,
      nonce: "nonce_95959595959595959595959595959595",
      input: {
        phone: QUO_CLIENT_PHONE,
        maxResults: 25,
        includeTranscripts: true,
        transcriptLimit: 3
      }
    }
  );
  includeOffTargetQuoCalls = false;
  includeIdenticalTargetDuplicate = false;
  assert.equal(quoPhoneHistory.response.status, 200, quoPhoneHistory.text);
  assert.equal(
    quoPhoneHistory.body.result.schema,
    "hcn.console.quo-phone-history.v1"
  );
  assert.equal(
    quoPhoneHistory.body.authority.fileScope,
    "fixed_principal_all_team_lines"
  );
  assert.equal(quoPhoneHistory.body.result.scope.exactFileMatch, true);
  assert.equal(quoPhoneHistory.body.result.completeness.lineCount, 12);
  assert.equal(quoPhoneHistory.body.result.completeness.complete, false);
  assert.deepEqual(
    quoPhoneHistory.body.result.completeness.reasons,
    ["provider_filter_mismatch"]
  );
  assert.equal(
    quoPhoneHistory.body.result.completeness.rejectedOffTargetCount,
    5
  );
  assert.equal(
    quoPhoneHistory.body.result.completeness.rejectedUnverifiableCount,
    1
  );
  assert.equal(quoPhoneHistory.body.result.summary.messages, 1);
  assert.equal(quoPhoneHistory.body.result.summary.calls, 1);
  assert.equal(quoPhoneHistory.body.result.items[0].line, "Team Line 12");
  assert.equal(quoPhoneHistory.body.result.safety.messagesSent, 0);
  assert.equal(quoPhoneHistory.body.result.safety.callsPlaced, 0);
  assert.equal(quoPhoneHistory.body.result.safety.jobNimbusWrites, 0);
  assert.doesNotMatch(
    JSON.stringify(quoPhoneHistory.body),
    /SECRET_(?:OFF_TARGET|UNVERIFIABLE)_CALL|\+1214555(?:000[0-4]|9999)/
  );
  assert.equal(
    providerCalls.some((pathname) =>
      /call-transcripts\/SECRET_/.test(pathname)
    ),
    false
  );
  assert.equal(providerWrites.length, 0);

  const quoReadsBeforeAmbiguous = providerCalls.filter(
    (pathname) => pathname === "/messages" || pathname === "/calls"
  ).length;
  includeActiveForeignDuplicate = true;
  const ambiguousQuoPhoneHistory = await signedPost(
    origin,
    "/integrations/jobrolo/v1/quo-phone-history",
    {
      requestId: `request_${"c1".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"d2".repeat(16)}`,
      input: {
        phone: QUO_CLIENT_PHONE,
        maxResults: 25,
        includeTranscripts: false,
        transcriptLimit: 0
      }
    }
  );
  includeActiveForeignDuplicate = false;
  assert.equal(ambiguousQuoPhoneHistory.response.status, 404);
  assert.equal(
    providerCalls.filter(
      (pathname) => pathname === "/messages" || pathname === "/calls"
    ).length,
    quoReadsBeforeAmbiguous
  );
  assert.equal(providerWrites.length, 0);

  const quoReadsBeforeConflictingDuplicate = providerCalls.filter(
    (pathname) => pathname === "/messages" || pathname === "/calls"
  ).length;
  includeConflictingTargetDuplicate = true;
  const conflictingDuplicateQuoPhoneHistory = await signedPost(
    origin,
    "/integrations/jobrolo/v1/quo-phone-history",
    {
      requestId: `request_${"81".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"82".repeat(16)}`,
      input: {
        phone: QUO_CLIENT_PHONE,
        maxResults: 25,
        includeTranscripts: false,
        transcriptLimit: 0
      }
    }
  );
  includeConflictingTargetDuplicate = false;
  assert.equal(conflictingDuplicateQuoPhoneHistory.response.status, 503);
  assert.equal(
    providerCalls.filter(
      (pathname) => pathname === "/messages" || pathname === "/calls"
    ).length,
    quoReadsBeforeConflictingDuplicate
  );

  const quoReadsBeforeMalformedTarget = providerCalls.filter(
    (pathname) => pathname === "/messages" || pathname === "/calls"
  ).length;
  includeAmbiguousMalformedEligible = true;
  const malformedTargetQuoPhoneHistory = await signedPost(
    origin,
    "/integrations/jobrolo/v1/quo-phone-history",
    {
      requestId: `request_${"83".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"84".repeat(16)}`,
      input: {
        phone: QUO_CLIENT_PHONE,
        maxResults: 25,
        includeTranscripts: false,
        transcriptLimit: 0
      }
    }
  );
  includeAmbiguousMalformedEligible = false;
  assert.equal(malformedTargetQuoPhoneHistory.response.status, 503);
  assert.equal(
    providerCalls.filter(
      (pathname) => pathname === "/messages" || pathname === "/calls"
    ).length,
    quoReadsBeforeMalformedTarget
  );

  const quoReadsBeforeFreshMismatch = providerCalls.filter(
    (pathname) => pathname === "/messages" || pathname === "/calls"
  ).length;
  freshAssignedPhoneOverride = "+12145550197";
  const freshMismatchQuoPhoneHistory = await signedPost(
    origin,
    "/integrations/jobrolo/v1/quo-phone-history",
    {
      requestId: `request_${"85".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"86".repeat(16)}`,
      input: {
        phone: QUO_CLIENT_PHONE,
        maxResults: 25,
        includeTranscripts: false,
        transcriptLimit: 0
      }
    }
  );
  freshAssignedPhoneOverride = null;
  assert.equal(freshMismatchQuoPhoneHistory.response.status, 404);
  assert.equal(
    providerCalls.filter(
      (pathname) => pathname === "/messages" || pathname === "/calls"
    ).length,
    quoReadsBeforeFreshMismatch
  );

  const quoReadsBeforeFreshMalformedTarget = providerCalls.filter(
    (pathname) => pathname === "/messages" || pathname === "/calls"
  ).length;
  freshAssignedPhoneOverride = { legacy: "214-555-0199" };
  const freshMalformedTargetQuoPhoneHistory = await signedPost(
    origin,
    "/integrations/jobrolo/v1/quo-phone-history",
    {
      requestId: `request_${"8a".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"8b".repeat(16)}`,
      input: {
        phone: QUO_CLIENT_PHONE,
        maxResults: 25,
        includeTranscripts: false,
        transcriptLimit: 0
      }
    }
  );
  freshAssignedPhoneOverride = null;
  assert.equal(freshMalformedTargetQuoPhoneHistory.response.status, 503);
  assert.equal(
    providerCalls.filter(
      (pathname) => pathname === "/messages" || pathname === "/calls"
    ).length,
    quoReadsBeforeFreshMalformedTarget
  );
  assert.equal(providerWrites.length, 0);

  const managementSweep = await signedPost(
    origin,
    "/integrations/jobrolo/v1/management-sweep",
    {
      requestId: "request_99999999999999999999999999999999",
      sessionRef,
      nonce: "nonce_99999999999999999999999999999999",
      input: { limitPerAdjuster: 10 }
    }
  );
  assert.equal(managementSweep.response.status, 200, managementSweep.text);
  assert.equal(
    managementSweep.body.result.schema,
    "hcn.console.management-sweep.v1"
  );
  assert.equal(managementSweep.body.result.adjusters.length, 3);
  assert.equal(
    managementSweep.body.authority.fileScope,
    "configured_management_adjusters"
  );
  assert.equal(managementSweep.body.authority.exactApprovalRequired, false);
  assert.equal(providerWrites.length, 0);

  const concurrentTurns = await Promise.all([
    signedPost(origin, "/integrations/jobrolo/v1/assistant/turn", {
      requestId: "request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionRef,
      nonce: "nonce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      input: {
        kind: "general",
        fileRef: "",
        prompt: "What can you help me with?",
        mode: "auto"
      }
    }),
    signedPost(origin, "/integrations/jobrolo/v1/assistant/turn", {
      requestId: "request_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sessionRef,
      nonce: "nonce_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      input: {
        kind: "general",
        fileRef: "",
        prompt: "What can you do?",
        mode: "auto"
      }
    })
  ]);
  for (const turn of concurrentTurns) {
    assert.equal(turn.response.status, 200, turn.text);
    assert.equal(
      turn.body.result.schema,
      "hcn.console.assistant-turn.v4"
    );
    assert.doesNotMatch(
      JSON.stringify(turn.body),
      /(?:conversation|message)_[a-f0-9]{32}/
    );
  }
  const encryptedHistory = await readFile(
    path.join(root, "platform", "assistant-conversations.enc.json"),
    "utf8"
  );
  assert.doesNotMatch(
    encryptedHistory,
    /What can you help me with|What can you do/
  );

  const fileRef = workCenterByName.get("Assigned File Fixture").fileRef;
  const fileRefB = workCenterByName.get("Assigned File Fixture B").fileRef;
  const transitionSessionRef =
    "session_fedcba9876543210fedcba9876543210";
  const transitionInputs = [
    {
      kind: "general",
      fileRef: "",
      prompt: "What can you help me with?",
      mode: "auto"
    },
    {
      kind: "file",
      fileRef,
      prompt: "Show the current file status for Job 2739.",
      mode: "auto"
    },
    {
      kind: "file",
      fileRef: fileRefB,
      prompt: "Show the current file status for Job 2740.",
      mode: "auto"
    },
    {
      kind: "file",
      fileRef,
      prompt: "Show the current file status for Job 2739.",
      mode: "auto"
    }
  ];
  for (let index = 0; index < transitionInputs.length; index += 1) {
    const digit = ["c", "d", "e", "f"][index];
    const turn = await signedPost(
      origin,
      "/integrations/jobrolo/v1/assistant/turn",
      {
        requestId: `request_${digit.repeat(32)}`,
        sessionRef: transitionSessionRef,
        nonce: `nonce_${digit.repeat(32)}`,
        input: transitionInputs[index]
      }
    );
    assert.equal(turn.response.status, 200, turn.text);
    assert.equal(
      turn.body.result.schema,
      "hcn.console.assistant-turn.v4"
    );
    assert.doesNotMatch(
      JSON.stringify(turn.body),
      /(?:conversation|message)_[a-f0-9]{32}/
    );
  }
  const prepared = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/prepare",
    {
      requestId: "request_44444444444444444444444444444444",
      sessionRef,
      nonce: "nonce_44444444444444444444444444444444",
      input: {
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: "Synthetic adapter approval fixture." }
        }]
      }
    }
  );
  assert.equal(prepared.response.status, 200, prepared.text);
  const plan = prepared.body.result.plan;
  assert.match(plan.planId, /^plan_[a-f0-9]{32}$/);
  assert.match(plan.approvalDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.status, "pending");
  assert.equal(prepared.text.includes("approvalChallenge"), false);
  assert.equal(prepared.text.includes("assigned-file-provider-id"), false);
  assert.equal(providerWrites.length, 0);

  const missingApproval = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_55555555555555555555555555555555",
      sessionRef,
      nonce: "nonce_55555555555555555555555555555555",
      input: { planId: plan.planId }
    }
  );
  assert.equal(missingApproval.response.status, 400);
  assert.equal(providerWrites.length, 0);

  const approval = {
    schema: "jobrolo.approval-attestation.v1",
    approvalRequestId: "approval_0123456789abcdef",
    planDigest: plan.approvalDigest,
    approvedAt: new Date().toISOString(),
    approvedByUserId: "user_0123456789abcdef"
  };
  const wrongApproval = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_66666666666666666666666666666666",
      sessionRef,
      nonce: "nonce_66666666666666666666666666666666",
      input: {
        planId: plan.planId,
        approval: { ...approval, planDigest: "b".repeat(64) }
      }
    }
  );
  assert.equal(wrongApproval.response.status, 409);
  assert.equal(providerWrites.length, 0);

  const executed = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_77777777777777777777777777777777",
      sessionRef,
      nonce: "nonce_77777777777777777777777777777777",
      input: { planId: plan.planId, approval }
    }
  );
  assert.equal(executed.response.status, 200, executed.text);
  assert.equal(providerWrites.length, 1);
  assert.equal(
    providerWrites[0].note,
    "Synthetic adapter approval fixture."
  );
  assert.equal(providerWrites[0].primary.id, "assigned-file-provider-id");
  assert.equal(
    executed.body.result.receipt.status,
    "executed"
  );
  assert.equal(executed.body.result.plan.status, "executed");
  assert.equal(executed.body.result.plan.result.mode, "executed");
  assert.equal(
    executed.body.result.plan.result.batch.status,
    "completed"
  );
  const completedReceipt =
    executed.body.result.plan.result.batch.completed[0].receipt;
  assert.deepEqual(
    Object.keys(completedReceipt).sort(),
    ["createdRecordRef", "verifiedByReadback"]
  );
  assert.equal(completedReceipt.verifiedByReadback, true);
  assert.match(completedReceipt.createdRecordRef, /^ref_[a-f0-9]{32}$/);
  assert.equal(executed.text.includes("synthetic-note-provider-id"), false);
  assert.equal(
    providerCalls.includes("/activities/synthetic-note-provider-id"),
    true
  );

  const replayedApproval = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_88888888888888888888888888888888",
      sessionRef,
      nonce: "nonce_88888888888888888888888888888888",
      input: { planId: plan.planId, approval }
    }
  );
  assert.equal(replayedApproval.response.status, 409);
  assert.equal(providerWrites.length, 1);

  const uncertainPrepared = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/prepare",
    {
      requestId: `request_${"a1".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"b2".repeat(16)}`,
      input: {
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: "Synthetic unconfirmed readback fixture." }
        }]
      }
    }
  );
  assert.equal(
    uncertainPrepared.response.status,
    200,
    uncertainPrepared.text
  );
  const uncertainPlan = uncertainPrepared.body.result.plan;
  const uncertainApproval = {
    schema: "jobrolo.approval-attestation.v1",
    approvalRequestId: "approval_deadbeefcafefeed",
    planDigest: uncertainPlan.approvalDigest,
    approvedAt: new Date().toISOString(),
    approvedByUserId: "user_0123456789abcdef"
  };
  const uncertainExecution = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: `request_${"c3".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"d4".repeat(16)}`,
      input: {
        planId: uncertainPlan.planId,
        approval: uncertainApproval
      }
    }
  );
  assert.equal(
    uncertainExecution.response.status,
    200,
    uncertainExecution.text
  );
  assert.equal(
    uncertainExecution.body.result.receipt.status,
    "reconciliation_required"
  );
  assert.equal(
    uncertainExecution.body.result.plan.status,
    "reconciliation_required"
  );
  assert.equal(
    uncertainExecution.body.result.plan.result.mode,
    "reconciliation_required"
  );
  assert.equal(providerWrites.length, 2);
  assert.equal(
    uncertainExecution.text.includes("synthetic-note-provider-id"),
    false
  );

  const uncertainReplay = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: `request_${"e5".repeat(16)}`,
      sessionRef,
      nonce: `nonce_${"f6".repeat(16)}`,
      input: {
        planId: uncertainPlan.planId,
        approval: uncertainApproval
      }
    }
  );
  assert.equal(uncertainReplay.response.status, 409);
  assert.equal(providerWrites.length, 2);

  const profileSessionRef = `session_${"7".repeat(32)}`;
  const genericTask = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/prepare",
    {
      requestId: `request_${"70".repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${"71".repeat(16)}`,
      input: {
        fileRef,
        operations: [{
          type: "jobnimbus.create_task",
          input: { title: "Generic adapter remains unchanged" }
        }]
      }
    }
  );
  assert.equal(genericTask.response.status, 200, genericTask.text);
  assert.equal(
    genericTask.body.result.plan.operations[0].type,
    "jobnimbus.create_task"
  );
  assert.equal(providerWrites.length, 2);

  const crossProfileExecution = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: `request_${"72".repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${"73".repeat(16)}`,
      input: {
        planId: genericTask.body.result.plan.planId,
        approval: {
          schema: "jobrolo.approval-attestation.v1",
          approvalRequestId: "approval_cross_profile_fixture",
          planDigest: genericTask.body.result.plan.approvalDigest,
          approvedAt: new Date().toISOString(),
          approvedByUserId: "user_0123456789abcdef"
        }
      },
      clientId: NOTE_CLIENT_ID,
      secret: NOTE_SHARED_SECRET
    }
  );
  assert.notEqual(crossProfileExecution.response.status, 200);
  assert.equal(providerWrites.length, 2);

  for (let index = 0; index < 7; index += 1) {
    const pathname = [
      "/integrations/jobrolo/v1/status",
      "/integrations/jobrolo/v1/work-center",
      "/integrations/jobrolo/v1/file-review",
      "/integrations/jobrolo/v1/communication-sweep",
      "/integrations/jobrolo/v1/quo-phone-history",
      "/integrations/jobrolo/v1/management-sweep",
      "/integrations/jobrolo/v1/assistant/turn"
    ][index];
    const token = (0x20 + index).toString(16).padStart(2, "0");
    const rejected = await signedPost(origin, pathname, {
      requestId: `request_${token.repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${(0x30 + index).toString(16).repeat(16)}`,
      input: {},
      clientId: NOTE_CLIENT_ID,
      secret: NOTE_SHARED_SECRET
    });
    assert.equal(rejected.response.status, 401, rejected.text);
  }

  const rejectedTypes = [
    "jobnimbus.create_task",
    "jobnimbus.update_task",
    "jobnimbus.update_status",
    "jobnimbus.update_contact",
    "jobnimbus.create_calendar_event",
    "jobnimbus.update_calendar_event",
    "gmail.create_draft",
    "gmail.send",
    "quo.send_text"
  ];
  for (let index = 0; index < rejectedTypes.length; index += 1) {
    const requestToken = (0x40 + index).toString(16);
    const nonceToken = (0x50 + index).toString(16);
    const rejected = await signedPost(
      origin,
      "/integrations/jobrolo/v1/action-plans/prepare",
      {
        requestId: `request_${requestToken.repeat(16)}`,
        sessionRef: profileSessionRef,
        nonce: `nonce_${nonceToken.repeat(16)}`,
        input: {
          fileRef,
          operations: [{ type: rejectedTypes[index], input: {} }]
        },
        clientId: NOTE_CLIENT_ID,
        secret: NOTE_SHARED_SECRET
      }
    );
    assert.equal(rejected.response.status, 403, rejected.text);
    assert.equal(providerWrites.length, 2);
  }

  const rejectedBatch = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/prepare",
    {
      requestId: `request_${"60".repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${"61".repeat(16)}`,
      input: {
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: "First note must not be batched." }
        }, {
          type: "jobnimbus.create_note",
          input: { note: "Second note must not be batched." }
        }]
      },
      clientId: NOTE_CLIENT_ID,
      secret: NOTE_SHARED_SECRET
    }
  );
  assert.equal(rejectedBatch.response.status, 403, rejectedBatch.text);
  assert.equal(providerWrites.length, 2);

  const noteOnlyPrepared = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/prepare",
    {
      requestId: `request_${"62".repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${"63".repeat(16)}`,
      input: {
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: "Exact note-only credential fixture." }
        }]
      },
      clientId: NOTE_CLIENT_ID,
      secret: NOTE_SHARED_SECRET
    }
  );
  assert.equal(noteOnlyPrepared.response.status, 200, noteOnlyPrepared.text);
  const noteOnlyPlan = noteOnlyPrepared.body.result.plan;
  const noteOnlyExecution = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: `request_${"64".repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${"65".repeat(16)}`,
      input: {
        planId: noteOnlyPlan.planId,
        approval: {
          schema: "jobrolo.approval-attestation.v1",
          approvalRequestId: "approval_note_profile_fixture",
          planDigest: noteOnlyPlan.approvalDigest,
          approvedAt: new Date().toISOString(),
          approvedByUserId: "user_0123456789abcdef"
        }
      },
      clientId: NOTE_CLIENT_ID,
      secret: NOTE_SHARED_SECRET
    }
  );
  assert.equal(noteOnlyExecution.response.status, 200, noteOnlyExecution.text);
  assert.equal(noteOnlyExecution.body.result.receipt.status, "executed");
  assert.equal(providerWrites.length, 3);
  assert.equal(
    providerWrites[2].note,
    "Exact note-only credential fixture."
  );
  assert.equal(
    noteOnlyExecution.text.includes("synthetic-note-provider-id"),
    false
  );
  const noteOnlyReceipt = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-receipts/detail",
    {
      requestId: `request_${"66".repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${"67".repeat(16)}`,
      input: { planId: noteOnlyPlan.planId },
      clientId: NOTE_CLIENT_ID,
      secret: NOTE_SHARED_SECRET
    }
  );
  assert.equal(noteOnlyReceipt.response.status, 200, noteOnlyReceipt.text);
  assert.equal(noteOnlyReceipt.body.result.receipt.status, "executed");
  assert.equal(
    noteOnlyReceipt.text.includes("synthetic-note-provider-id"),
    false
  );
  const genericCannotReadNoteReceipt = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-receipts/detail",
    {
      requestId: `request_${"68".repeat(16)}`,
      sessionRef: profileSessionRef,
      nonce: `nonce_${"69".repeat(16)}`,
      input: { planId: noteOnlyPlan.planId }
    }
  );
  assert.equal(genericCannotReadNoteReceipt.response.status, 404);

  const callerSelectedIdentity = await signedPost(
    origin,
    "/integrations/jobrolo/v1/status",
    {
      requestId: "request_33333333333333333333333333333333",
      sessionRef,
      nonce: "nonce_33333333333333333333333333333333",
      input: {},
      actorExtra: { email: "other@wavepa.com" }
    }
  );
  assert.equal(callerSelectedIdentity.response.status, 400);
  assert.match(callerSelectedIdentity.body.error, /unsupported fields/i);
});

async function signedPost(
  origin,
  pathname,
  {
    requestId,
    sessionRef,
    nonce,
    input,
    actorExtra = {},
    clientId = CLIENT_ID,
    secret = SHARED_SECRET
  }
) {
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId,
    actor: { sessionRef, ...actorExtra },
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

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function reservePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
}

async function waitForBridge(child, port, readOutput) {
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
