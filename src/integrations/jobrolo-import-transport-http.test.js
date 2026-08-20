import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA,
  JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
  JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS,
  JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
  JOBROLO_IMPORT_CATALOG_ROUTE,
  JOBROLO_IMPORT_REQUEST_HEADERS,
  JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
  JOBROLO_IMPORT_SNAPSHOT_ROUTE,
  jobroloImportDocumentResponseSigningMaterial,
  signJobroloImportRequest,
  verifyJobroloImportTransportResponse
} from "./jobrolo-import-service-auth.js";

const EMAIL = "chance@wavepa.com";
const SUBJECT = "chance-import-google-subject";
const OWNER_ID = "chance-import-owner-id";
const CLIENT_ID = "jobrolo-import-http-fixture";
const SECRET = "jobrolo-import-http-fixture-secret-0123456789";
const CONNECTION_REF = "connection_cccccccccccccccccccccccccccccccc";
const RAW_FILE_ID = "private-provider-file-id";
const ACCOUNT_USER_ID = "private-account-user-id";
const CUSTOMER_ID = "private-customer-account-id";
const DOCUMENT_BYTES = Buffer.from("%PDF-1.7\nfixture document bytes\n", "utf8");

test("dedicated import routes are signed, exact, bounded, and provider-read-only", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-import-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = {
    mode: "normal",
    detailAssigned: true,
    dateOfLoss: "2026-05-17",
    calls: [],
    writes: 0
  };
  const provider = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://provider.invalid");
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.method !== "GET") state.writes += 1;
    if (req.method === "GET" && url.pathname === "/account/users") {
      return json(res, 200, {
        total: 2,
        users: [
          {
            jnid: OWNER_ID,
            email: EMAIL,
            display_name: "Chance Pearson",
            is_active: true
          },
          {
            jnid: ACCOUNT_USER_ID,
            email: "verified-user@wavepa.com",
            display_name: "Verified User",
            is_active: true
          }
        ]
      });
    }
    if (req.method === "GET" && url.pathname === "/contacts") {
      if (state.mode === "provider_failure") {
        return json(res, 500, {
          error: "RAW_PROVIDER_SECRET https://private.invalid"
        });
      }
      const contacts = state.mode === "catalog_overflow"
        ? Array.from({ length: 501 }, (_, index) => contact({
            jnid: `private-provider-file-${index}`,
            number: `JN-${index}`,
            display_name: `Assigned ${index}`
          }))
        : [contact({ "Date of Loss": state.dateOfLoss })];
      return paged(res, url, "contacts", contacts);
    }
    if (
      req.method === "GET"
      && url.pathname === `/contacts/${RAW_FILE_ID}`
    ) {
      return json(res, 200, contact({
        owners: [{ id: state.detailAssigned ? OWNER_ID : "other-owner" }],
        "Date of Loss": state.dateOfLoss
      }));
    }
    if (req.method === "GET" && url.pathname === "/activities") {
      const field = filterField(url);
      const records = state.mode === "foreign_contact"
        ? field === "related.id"
          ? [{
              jnid: "private-cross-file-activity",
              primary: { id: RAW_FILE_ID },
              related: [
                { id: RAW_FILE_ID },
                {
                  wrapper: {
                    id: "unassigned-foreign-client",
                    record_type_name: "Contact"
                  }
                }
              ],
              occurred_at: new Date(Date.now() - 120_000).toISOString(),
              label: "PRIVATE FOREIGN CLIENT LABEL"
            }]
          : []
        : field === "primary.id"
          ? collection("activities", state.mode)
          : field === "related.id" && state.mode === "normal"
            ? [{
                jnid: "private-verified-user-activity",
                primary: {
                  id: ACCOUNT_USER_ID,
                  type: "Contact",
                  old_status: "Ready",
                  new_status: "Review"
                },
                related: [
                  { id: RAW_FILE_ID, type: "Contact" },
                  { id: ACCOUNT_USER_ID, type: "Contact" }
                ],
                customer: CUSTOMER_ID,
                occurred_at: "2026-08-08T14:31:00.000Z",
                label: "Verified employee changed status"
              }]
          : [];
      return paged(res, url, "activities", records);
    }
    if (req.method === "GET" && url.pathname === "/tasks") {
      return paged(res, url, "tasks", collection("tasks", state.mode));
    }
    if (req.method === "GET" && url.pathname === "/files") {
      return paged(res, url, "files", collection("files", state.mode));
    }
    if (
      req.method === "GET"
      && url.pathname === "/download/private-document-0"
    ) {
      if (state.mode === "binary_redirect") {
        res.writeHead(302, { location: "https://private.invalid/secret" });
        return res.end();
      }
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(DOCUMENT_BYTES.byteLength),
        "content-encoding": "identity"
      });
      return res.end(DOCUMENT_BYTES);
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
      JOBNIMBUS_API_KEY: "jobnimbus-import-provider-key",
      JOBNIMBUS_API_BASE_URL:
        `http://127.0.0.1:${provider.address().port}`,
      JOBNIMBUS_FILE_BASE_URL:
        `http://127.0.0.1:${provider.address().port}/download`,
      CHANCE_GOOGLE_EMAIL: EMAIL,
      CHANCE_GOOGLE_SUBJECT: SUBJECT,
      CHANCE_JOBNIMBUS_OWNER_ID: OWNER_ID,
      WAVE_AUTH_USERS_JSON: "[]",
      HCN_TENANT_ID: "tenant_0123456789abcdef",
      HCN_REFERENCE_KEY: Buffer.alloc(32, 0x61).toString("base64url"),
      HCN_OPERATIONS_ROOT: root,
      HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED: "true",
      HCN_JOBROLO_IMPORT_CLIENT_ID: CLIENT_ID,
      HCN_JOBROLO_IMPORT_SHARED_SECRET: SECRET,
      HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL: EMAIL,
      HCN_JOBROLO_IMPORT_CONNECTION_REF: CONNECTION_REF,
      HCN_JOBROLO_ADAPTER_ENABLED: "",
      HCN_JOBROLO_CLIENT_ID: "",
      HCN_JOBROLO_SHARED_SECRET: "",
      HCN_JOBROLO_PRINCIPAL_EMAIL: "",
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "",
      CODEX_MAC_OPERATOR_TOKEN: "",
      GOOGLE_CLIENT_SECRET: "",
      HCN_GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      OAUTH_SESSION_SECRET: "",
      GPT_OAUTH_CLIENT_SECRET: "",
      HCN_GOOGLE_GRANT_KEY: "",
      HCN_ASSISTANT_HISTORY_KEY: "",
      HCN_THRESHER_STORE_KEY: "",
      HCN_THRESHER_REFERENCE_KEY: "",
      HCN_THRESHER_SIGNING_KEY: "",
      HCN_THRESHER_AI_GROQ_API_KEY: "",
      HCN_QUO_LINK_KEY: "",
      QUO_API_KEY: "",
      TWILIO_AUTH_TOKEN: "",
      RETELL_API_KEY: "",
      RETELL_INBOUND_WEBHOOK_TOKEN: "",
      VOICE_STREAM_TOKEN: "",
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  t.after(() => stopChild(child));
  await waitForBridge(child, bridgePort, () => output);
  const origin = `http://127.0.0.1:${bridgePort}`;

  const catalog = await signedPost(origin, JOBROLO_IMPORT_CATALOG_ROUTE, {
    schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
    requestId: `request_${"1".repeat(32)}`
  }, `nonce_${"1".repeat(32)}`);
  assert.equal(catalog.response.status, 200, catalog.text);
  assert.equal(catalog.body.kind, "catalog");
  assert.equal(catalog.body.payload.returnedItems, 1);
  assert.equal(catalog.body.payload.source.connectionRef, CONNECTION_REF);
  assert.equal(catalog.body.payload.source.complete, true);
  assert.equal(catalog.body.payload.source.scope, "assigned");
  assert.match(catalog.response.headers.get("cache-control"), /no-store/);
  const sourceFileRef = catalog.body.payload.items[0].sourceFileRef;
  assert.match(sourceFileRef, /^subject_[a-f0-9]{32}$/);
  verifyResponse(catalog, JOBROLO_IMPORT_CATALOG_ROUTE);
  assertNoPrivateMaterial(catalog.text);
  assert.equal(state.calls.length, 3, "catalog provider-call budget");

  const callsBeforeSnapshot = state.calls.length;
  const snapshot = await signedPost(origin, JOBROLO_IMPORT_SNAPSHOT_ROUTE, {
    schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
    requestId: `request_${"2".repeat(32)}`,
    sourceFileRef
  }, `nonce_${"2".repeat(32)}`);
  assert.equal(snapshot.response.status, 200, snapshot.text);
  assert.equal(snapshot.body.kind, "snapshot");
  assert.equal(snapshot.body.payload.sourceFileRef, sourceFileRef);
  assert.equal(snapshot.body.payload.source.connectionRef, CONNECTION_REF);
  assert.equal(snapshot.body.payload.activities.completeness, "complete");
  assert.equal(snapshot.body.payload.activities.returnedItems, 2);
  assert.equal(snapshot.body.payload.tasks.completeness, "complete");
  assert.equal(snapshot.body.payload.documents.completeness, "complete");
  verifyResponse(snapshot, JOBROLO_IMPORT_SNAPSHOT_ROUTE);
  assertNoPrivateMaterial(snapshot.text);
  assert.equal(
    state.calls.length - callsBeforeSnapshot,
    12,
    "snapshot provider-call budget"
  );
  for (const call of state.calls) {
    const parsed = new URL(call.replace(/^GET /, ""), "http://provider.invalid");
    if (parsed.searchParams.has("size")) {
      assert.equal(Number(parsed.searchParams.get("size")) <= 500, true);
    }
  }
  assert.equal(state.writes, 0);

  const manifest = {
    schema: "jobrolo.jobnimbus-import.document-manifest.v1",
    sourceFileRef,
    document: snapshot.body.payload.documents.items[0]
  };
  const manifestDigest = createHash("sha256")
    .update(canonicalJson(manifest), "utf8")
    .digest("hex");
  const callsBeforeDocument = state.calls.length;
  const documentResult = await signedBinaryPost(
    origin,
    JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
    {
      schema: JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA,
      requestId: `request_${"ab".repeat(16)}`,
      sourceFileRef,
      sourceRecordRef: manifest.document.sourceRecordRef,
      manifestDigest
    },
    `nonce_${"ab".repeat(16)}`
  );
  assert.equal(documentResult.response.status, 200);
  assert.deepEqual(documentResult.bytes, DOCUMENT_BYTES);
  assert.equal(
    documentResult.response.headers.get("content-type"),
    "application/octet-stream"
  );
  assert.equal(
    documentResult.response.headers.get("content-length"),
    String(DOCUMENT_BYTES.byteLength)
  );
  assert.equal(
    documentResult.response.headers.get(
      JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.contentSha256
    ),
    createHash("sha256").update(DOCUMENT_BYTES).digest("hex")
  );
  assert.equal(
    documentResult.response.headers.get(
      JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.manifestDigest
    ),
    manifestDigest
  );
  verifyDocumentResponse(documentResult, {
    sourceFileRef,
    sourceRecordRef: manifest.document.sourceRecordRef,
    manifestDigest
  });
  assert.equal(
    state.calls.length - callsBeforeDocument,
    7,
    "document provider-call budget"
  );
  assert.equal(state.writes, 0);

  const callsBeforeStale = state.calls.length;
  const staleManifest = await signedPost(
    origin,
    JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
    {
      schema: JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA,
      requestId: `request_${"cd".repeat(16)}`,
      sourceFileRef,
      sourceRecordRef: manifest.document.sourceRecordRef,
      manifestDigest: "0".repeat(64)
    },
    `nonce_${"cd".repeat(16)}`
  );
  assert.equal(staleManifest.response.status, 409, staleManifest.text);
  assert.equal(staleManifest.body.error.code, "jobrolo_import_source_changed");
  assert.equal(
    state.calls.slice(callsBeforeStale)
      .some((call) => call.includes("/download/")),
    false,
    "stale metadata must block before the byte fetch"
  );

  state.mode = "binary_redirect";
  const redirectedDocument = await signedPost(
    origin,
    JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
    {
      schema: JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA,
      requestId: `request_${"ef".repeat(16)}`,
      sourceFileRef,
      sourceRecordRef: manifest.document.sourceRecordRef,
      manifestDigest
    },
    `nonce_${"ef".repeat(16)}`
  );
  assert.equal(redirectedDocument.response.status, 503, redirectedDocument.text);
  assert.equal(
    redirectedDocument.body.error.code,
    "jobrolo_import_unavailable"
  );
  assert.doesNotMatch(redirectedDocument.text, /private\.invalid|secret/);
  state.mode = "normal";

  state.dateOfLoss = 1785261000;
  const numericCatalog = await signedPost(
    origin,
    JOBROLO_IMPORT_CATALOG_ROUTE,
    {
      schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
      requestId: `request_${"e".repeat(32)}`
    },
    `nonce_${"e".repeat(32)}`
  );
  assert.equal(numericCatalog.response.status, 200, numericCatalog.text);
  assert.equal(numericCatalog.body.payload.returnedItems, 1);
  assert.equal(numericCatalog.text.includes(String(state.dateOfLoss)), false);
  verifyResponse(numericCatalog, JOBROLO_IMPORT_CATALOG_ROUTE);

  const numericSourceFileRef =
    numericCatalog.body.payload.items[0].sourceFileRef;
  const numericSnapshot = await signedPost(
    origin,
    JOBROLO_IMPORT_SNAPSHOT_ROUTE,
    {
      schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
      requestId: `request_${"0".repeat(32)}`,
      sourceFileRef: numericSourceFileRef
    },
    `nonce_${"0".repeat(32)}`
  );
  assert.equal(numericSnapshot.response.status, 200, numericSnapshot.text);
  assert.equal(numericSnapshot.body.payload.file.dateOfLoss, null);
  assert.equal(
    numericSnapshot.body.payload.file.missingFacts.dateOfLoss,
    true
  );
  assert.equal(numericSnapshot.text.includes(String(state.dateOfLoss)), false);
  assert.equal(
    numericSnapshot.text.includes(
      new Date(state.dateOfLoss * 1000).toISOString().slice(0, 10)
    ),
    false
  );
  verifyResponse(numericSnapshot, JOBROLO_IMPORT_SNAPSHOT_ROUTE);
  assertNoPrivateMaterial(numericSnapshot.text);

  state.dateOfLoss = "2026-05-17T23:00:00-05:00";
  const timestampCatalog = await signedPost(
    origin,
    JOBROLO_IMPORT_CATALOG_ROUTE,
    {
      schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
      requestId: `request_${"f".repeat(32)}`
    },
    `nonce_${"f".repeat(32)}`
  );
  assert.equal(timestampCatalog.response.status, 503, timestampCatalog.text);
  assert.equal(timestampCatalog.body.error.code, "jobrolo_import_unavailable");
  assert.doesNotMatch(timestampCatalog.text, /2026-05-17T23:00:00-05:00/);
  state.dateOfLoss = "2026-05-17";

  const callsBeforeUnknown = state.calls.length;
  const unknown = await signedPost(origin, JOBROLO_IMPORT_SNAPSHOT_ROUTE, {
    schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
    requestId: `request_${"3".repeat(32)}`,
    sourceFileRef: `subject_${"f".repeat(32)}`
  }, `nonce_${"3".repeat(32)}`);
  assert.equal(unknown.response.status, 404, unknown.text);
  assert.equal(unknown.body.error.code, "jobrolo_import_source_not_found");
  assert.equal(
    state.calls.slice(callsBeforeUnknown)
      .some((call) => call.includes(`/contacts/${RAW_FILE_ID}`)),
    false
  );

  const replayBody = {
    schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
    requestId: `request_${"4".repeat(32)}`
  };
  const replayNonce = `nonce_${"4".repeat(32)}`;
  const firstReplay = await signedPost(
    origin,
    JOBROLO_IMPORT_CATALOG_ROUTE,
    replayBody,
    replayNonce
  );
  assert.equal(firstReplay.response.status, 200, firstReplay.text);
  const callsBeforeReplay = state.calls.length;
  const secondReplay = await signedPost(
    origin,
    JOBROLO_IMPORT_CATALOG_ROUTE,
    replayBody,
    replayNonce
  );
  assert.equal(secondReplay.response.status, 401, secondReplay.text);
  assert.equal(secondReplay.body.error.code,
    "invalid_jobrolo_import_authentication");
  assert.equal(state.calls.length, callsBeforeReplay);

  const query = await signedPost(
    origin,
    `${JOBROLO_IMPORT_CATALOG_ROUTE}?sourceFileRef=${RAW_FILE_ID}`,
    {
      schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
      requestId: `request_${"5".repeat(32)}`
    },
    `nonce_${"5".repeat(32)}`,
    { signingPath: JOBROLO_IMPORT_CATALOG_ROUTE }
  );
  assert.equal(query.response.status, 401, query.text);
  assertNoPrivateMaterial(query.text);

  const wrongDomain = await signedPost(
    origin,
    JOBROLO_IMPORT_CATALOG_ROUTE,
    {
      schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
      requestId: `request_${"6".repeat(32)}`
    },
    `nonce_${"6".repeat(32)}`,
    { authorization: `Jobrolo-HMAC ${CLIENT_ID}` }
  );
  assert.equal(wrongDomain.response.status, 401, wrongDomain.text);

  const wrongMethod = await fetch(`${origin}${JOBROLO_IMPORT_CATALOG_ROUTE}`, {
    method: "GET"
  });
  assert.equal(wrongMethod.status, 401);
  assert.equal((await wrongMethod.json()).error.code,
    "invalid_jobrolo_import_authentication");

  const wrongContentType = await signedPost(
    origin,
    JOBROLO_IMPORT_CATALOG_ROUTE,
    {
      schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
      requestId: `request_${"a".repeat(32)}`
    },
    `nonce_${"a".repeat(32)}`,
    { contentType: "text/plain" }
  );
  assert.equal(wrongContentType.response.status, 415,
    wrongContentType.text);
  assert.equal(wrongContentType.body.error.code,
    "invalid_jobrolo_import_request");

  state.detailAssigned = false;
  const assignmentChanged = await signedPost(
    origin,
    JOBROLO_IMPORT_SNAPSHOT_ROUTE,
    {
      schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
      requestId: `request_${"7".repeat(32)}`,
      sourceFileRef
    },
    `nonce_${"7".repeat(32)}`
  );
  assert.equal(assignmentChanged.response.status, 409,
    assignmentChanged.text);
  assert.equal(assignmentChanged.body.error.code,
    "jobrolo_import_source_changed");
  state.detailAssigned = true;

  state.mode = "foreign_contact";
  const foreignContact = await signedPost(
    origin,
    JOBROLO_IMPORT_SNAPSHOT_ROUTE,
    {
      schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
      requestId: `request_${"d".repeat(32)}`,
      sourceFileRef
    },
    `nonce_${"d".repeat(32)}`
  );
  assert.equal(foreignContact.response.status, 409, foreignContact.text);
  assert.equal(foreignContact.body.error.code,
    "jobrolo_import_source_changed");
  assert.doesNotMatch(
    foreignContact.text,
    /unassigned-foreign-client|PRIVATE FOREIGN CLIENT LABEL/
  );

  state.mode = "catalog_overflow";
  const overflow = await signedPost(origin, JOBROLO_IMPORT_CATALOG_ROUTE, {
    schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
    requestId: `request_${"8".repeat(32)}`
  }, `nonce_${"8".repeat(32)}`);
  assert.equal(overflow.response.status, 503, overflow.text);
  assert.equal(overflow.body.error.code, "jobrolo_import_unavailable");

  state.mode = "collection_overflow";
  const collectionOverflow = await signedPost(
    origin,
    JOBROLO_IMPORT_SNAPSHOT_ROUTE,
    {
      schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
      requestId: `request_${"b".repeat(32)}`,
      sourceFileRef
    },
    `nonce_${"b".repeat(32)}`
  );
  assert.equal(collectionOverflow.response.status, 503,
    collectionOverflow.text);
  assert.equal(collectionOverflow.body.error.code,
    "jobrolo_import_unavailable");

  state.mode = "oversize";
  const oversizedSnapshot = await signedPost(
    origin,
    JOBROLO_IMPORT_SNAPSHOT_ROUTE,
    {
      schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
      requestId: `request_${"c".repeat(32)}`,
      sourceFileRef
    },
    `nonce_${"c".repeat(32)}`
  );
  assert.equal(oversizedSnapshot.response.status, 503,
    oversizedSnapshot.text);
  assert.equal(oversizedSnapshot.body.error.code,
    "jobrolo_import_unavailable");
  assertNoPrivateMaterial(oversizedSnapshot.text);

  state.mode = "provider_failure";
  const unavailable = await signedPost(origin, JOBROLO_IMPORT_CATALOG_ROUTE, {
    schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
    requestId: `request_${"9".repeat(32)}`
  }, `nonce_${"9".repeat(32)}`);
  assert.equal(unavailable.response.status, 503, unavailable.text);
  assertNoPrivateMaterial(unavailable.text);
  assert.doesNotMatch(unavailable.text, /private\.invalid|RAW_PROVIDER_SECRET/);
  assert.equal(state.writes, 0);
});

function contact(overrides = {}) {
  return {
    jnid: RAW_FILE_ID,
    number: "JN-2739",
    record_type_name: "Insurance",
    owners: [{ id: OWNER_ID }],
    display_name: "Fixture Homeowner",
    status_name: "Ready for Review",
    stage_name: "Carrier Review",
    is_active: true,
    date_updated: new Date(Date.now() - 60_000).toISOString(),
    next_appointment_at: new Date(Date.now() + 86_400_000).toISOString(),
    email: "owner@example.test",
    mobile_phone: "(555) 555-0101",
    address_line1: "100 Private Street",
    city: "Example",
    state_text: "TX",
    zip: "75001",
    "Insurance Company": "Example Carrier",
    "Claim #": "CLAIM-100",
    "Policy #": "POLICY-100",
    "Date of Loss": "2026-05-17",
    "Damage Summary": "Roof damage documented",
    "Carrier DA": "Taylor Adjuster",
    "Carrier DA Contact #": "(555) 555-0130",
    "Carrier DA Email": "adjuster@carrier.example",
    customer: CUSTOMER_ID,
    ...overrides
  };
}

function collection(kind, mode) {
  const count = mode === "collection_overflow"
    ? 501
    : mode === "oversize"
      ? 500
      : 1;
  return Array.from({ length: count }, (_, index) => {
    if (kind === "activities") return {
      jnid: `private-activity-${index}`,
      primary: { id: RAW_FILE_ID },
      customer: CUSTOMER_ID,
      activity_type: "Status Change",
      status_name: "Complete",
      occurred_at: "2026-08-08T14:30:00.000Z",
      actor_role: "Employee",
      label: mode === "oversize" ? "😀".repeat(160) : "Carrier review opened"
    };
    if (kind === "tasks") return {
      jnid: `private-task-${index}`,
      related: { id: RAW_FILE_ID },
      customer: CUSTOMER_ID,
      task_type: "Task",
      status_name: "Open",
      priority_name: "Urgent",
      due_at: "2026-08-12T14:00:00.000Z",
      assigned_role: "Employee",
      label: mode === "oversize" ? "😀".repeat(160) : "Review settlement"
    };
    return {
      jnid: `private-document-${index}`,
      related: { id: RAW_FILE_ID },
      customer: CUSTOMER_ID,
      filename: mode === "oversize"
        ? `${"😀".repeat(156)}.pdf`
        : "Carrier settlement estimate.pdf",
      content_type: "application/pdf",
      status_name: "New",
      created_at: "2026-08-08T14:45:00.000Z",
      download_url: "https://private.invalid/document"
    };
  });
}

function paged(res, url, key, rows) {
  const size = Number(url.searchParams.get("size") || 500);
  const from = Number(url.searchParams.get("from") || 0);
  return json(res, 200, { [key]: rows.slice(from, from + size) });
}

function filterField(url) {
  try {
    const filter = JSON.parse(url.searchParams.get("filter") || "{}");
    return Object.keys(filter?.must?.[0]?.term || {})[0] || "";
  } catch {
    return "";
  }
}

async function signedPost(
  origin,
  route,
  body,
  nonce,
  overrides = {}
) {
  const pathname = overrides.signingPath || new URL(route, origin).pathname;
  const timestamp = new Date().toISOString();
  const signed = signJobroloImportRequest({
    clientId: CLIENT_ID,
    secret: SECRET,
    pathname,
    timestamp,
    nonce,
    body
  });
  const headers = {
    ...signed.headers,
    ...(overrides.authorization
      ? { authorization: overrides.authorization }
      : {}),
    ...(overrides.contentType
      ? { "content-type": overrides.contentType }
      : {})
  };
  const response = await fetch(`${origin}${route}`, {
    method: "POST",
    headers,
    body: signed.bodyText
  });
  const text = await response.text();
  return {
    response,
    text,
    body: JSON.parse(text),
    verifiedRequest: {
      requestId: body.requestId,
      requestNonce: nonce,
      requestTimestamp: timestamp,
      requestBodyHash: headers[JOBROLO_IMPORT_REQUEST_HEADERS.contentSha256]
    }
  };
}

async function signedBinaryPost(origin, route, body, nonce) {
  const pathname = new URL(route, origin).pathname;
  const timestamp = new Date().toISOString();
  const signed = signJobroloImportRequest({
    clientId: CLIENT_ID,
    secret: SECRET,
    pathname,
    timestamp,
    nonce,
    body
  });
  const response = await fetch(`${origin}${route}`, {
    method: "POST",
    headers: signed.headers,
    body: signed.bodyText
  });
  return {
    response,
    bytes: Buffer.from(await response.arrayBuffer()),
    verifiedRequest: {
      requestId: body.requestId,
      requestNonce: nonce,
      requestTimestamp: timestamp,
      requestBodyHash:
        signed.headers[JOBROLO_IMPORT_REQUEST_HEADERS.contentSha256]
    }
  };
}

function verifyResponse(result, pathname) {
  assert.equal(verifyJobroloImportTransportResponse({
    secret: SECRET,
    pathname,
    verifiedRequest: result.verifiedRequest,
    body: result.body,
    headers: Object.fromEntries(result.response.headers.entries())
  }), true);
}

function verifyDocumentResponse(result, {
  sourceFileRef,
  sourceRecordRef,
  manifestDigest
}) {
  const responseTimestamp = result.response.headers.get(
    JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.responseTimestamp
  );
  const contentSha256 = result.response.headers.get(
    JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.contentSha256
  );
  const contentLength = Number(result.response.headers.get("content-length"));
  const material = jobroloImportDocumentResponseSigningMaterial({
    pathname: JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
    requestTimestamp: result.verifiedRequest.requestTimestamp,
    requestNonce: result.verifiedRequest.requestNonce,
    requestBodyHash: result.verifiedRequest.requestBodyHash,
    requestId: result.verifiedRequest.requestId,
    sourceFileRef,
    sourceRecordRef,
    manifestDigest,
    responseTimestamp,
    contentType: result.response.headers.get("content-type"),
    contentLength,
    contentSha256
  });
  assert.equal(
    result.response.headers.get(
      JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.requestId
    ),
    result.verifiedRequest.requestId
  );
  assert.equal(
    result.response.headers.get(
      JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.requestNonce
    ),
    result.verifiedRequest.requestNonce
  );
  assert.equal(
    result.response.headers.get(
      JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.signature
    ),
    createHmac("sha256", SECRET).update(material, "utf8").digest("hex")
  );
}

function assertNoPrivateMaterial(text) {
  for (const forbidden of [
    RAW_FILE_ID,
    OWNER_ID,
    ACCOUNT_USER_ID,
    CUSTOMER_ID,
    "jobnimbus-import-provider-key",
    "download_url",
    "private.invalid",
    "providerFileId",
    "authorization"
  ]) assert.equal(text.includes(forbidden), false, forbidden);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function reservePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function waitForBridge(child, port, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bridge exited early (${child.exitCode}): ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Bridge did not start: ${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
