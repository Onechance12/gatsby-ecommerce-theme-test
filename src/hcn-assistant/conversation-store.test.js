import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHcnAssistantConversationStore,
  HcnAssistantConversationStoreError
} from "./conversation-store.js";

const PRINCIPAL_A = `principal_${"a".repeat(32)}`;
const PRINCIPAL_B = `principal_${"b".repeat(32)}`;
const FILE_REF = `subject_${"c".repeat(32)}`;
const FILE_REF_B = `subject_${"d".repeat(32)}`;
const BINDING_A = `binding_${"1".repeat(64)}`;
const BINDING_B = `binding_${"2".repeat(64)}`;
const BINDING_C = `binding_${"3".repeat(64)}`;
const KEY_A = Buffer.alloc(32, 0x41).toString("base64url");
const KEY_B = Buffer.alloc(32, 0x42).toString("base64url");
const ROUTING = Object.freeze({
  route: "standard",
  profileId: "hcn.thresher.groq.gpt-oss-20b.medium.v1",
  reasonCodes: ["general_assistance"],
  modelUsed: true
});

test("conversation store persists encrypted principal-scoped multi-chat history", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "platform", "assistant-history.enc.json");
  let timestamp = Date.parse("2026-08-03T12:00:00.000Z");
  const store = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_A,
    now: () => timestamp
  });

  const general = await store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Daily sweep"
  });
  assert.match(general.conversationRef, /^conversation_[a-f0-9]{32}$/);
  assert.equal(general.revision, 0);
  assert.equal(general.messageCount, 0);

  const sameGeneral = await store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Another workload chat"
  });
  assert.equal(sameGeneral.conversationRef, general.conversationRef);
  assert.equal(sameGeneral.title, "Daily sweep");

  timestamp += 1_000;
  const client = await store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "file",
    fileRef: FILE_REF,
    title: "Client 2739"
  });
  timestamp += 1_000;
  await store.create({
    principalRef: PRINCIPAL_B,
    scope: "management",
    kind: "sweep",
    fileRef: "",
    title: "Management sweep"
  });

  const listA = await store.list({
    principalRef: PRINCIPAL_A,
    state: "active",
    offset: 0,
    limit: 50
  });
  assert.deepEqual(
    listA.items.map((item) => item.title),
    ["Client 2739", "Daily sweep"]
  );
  assert.equal(listA.page.total, 2);
  assert.equal(
    listA.items.some((item) => Object.hasOwn(item, "principalRef")),
    false
  );

  timestamp += 1_000;
  const turn = await store.appendTurn({
    principalRef: PRINCIPAL_A,
    conversationRef: client.conversationRef,
    expectedRevision: 0,
    prompt: "What is next for this file?",
    message: "Review the fresh file evidence before choosing the next step.",
    mode: "auto",
    routing: ROUTING,
    sources: [{
      key: "jobnimbus",
      label: "JobNimbus file",
      status: "fresh",
      checkedAt: "2026-08-03T12:00:03.000Z"
    }]
  });
  assert.equal(turn.conversation.revision, 1);
  assert.equal(turn.conversation.messageCount, 2);
  assert.match(turn.userMessage.messageRef, /^message_[a-f0-9]{32}$/);
  assert.match(turn.assistantMessage.messageRef, /^message_[a-f0-9]{32}$/);

  const storedClient = await store.get({
    principalRef: PRINCIPAL_A,
    conversationRef: client.conversationRef
  });
  assert.equal(storedClient.messages.length, 2);
  assert.equal(storedClient.messages[0].content, "What is next for this file?");
  assert.equal(storedClient.messages[1].routing.route, "standard");
  assert.equal(await store.get({
    principalRef: PRINCIPAL_B,
    conversationRef: client.conversationRef
  }), null);

  const encrypted = await readFile(filePath, "utf8");
  assert.doesNotMatch(
    encrypted,
    /Client 2739|What is next|Review the fresh file|principal_aaaa/
  );
  assert.match(encrypted, /hcn\.assistant\.conversation-store\.encrypted/);

  const reopened = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_A,
    now: () => timestamp
  });
  assert.equal((await reopened.get({
    principalRef: PRINCIPAL_A,
    conversationRef: client.conversationRef
  })).messages.length, 2);
});

test("conversation store atomically reuses active workload and sweep chats", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-singletons-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createHcnAssistantConversationStore({
    filePath: path.join(root, "history.enc.json"),
    encryptionKey: KEY_A
  });

  const generalRequests = Array.from({ length: 8 }, () => store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Workload overview"
  }));
  const general = await Promise.all(generalRequests);
  assert.equal(new Set(general.map((item) => item.conversationRef)).size, 1);

  const sweepRequests = Array.from({ length: 8 }, () => store.create({
    principalRef: PRINCIPAL_A,
    scope: "management",
    kind: "sweep",
    fileRef: "",
    title: "Company sweep"
  }));
  const sweeps = await Promise.all(sweepRequests);
  assert.equal(new Set(sweeps.map((item) => item.conversationRef)).size, 1);

  const active = await store.list({
    principalRef: PRINCIPAL_A,
    state: "active",
    offset: 0,
    limit: 50
  });
  assert.equal(active.page.total, 2);
});

test("conversation mutations use exact revisions and archive/restore safely", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-mutate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let timestamp = Date.parse("2026-08-03T13:00:00.000Z");
  const store = createHcnAssistantConversationStore({
    filePath: path.join(root, "history.enc.json"),
    encryptionKey: KEY_A,
    now: () => timestamp
  });
  const created = await store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "First title"
  });
  timestamp += 1_000;
  const renamed = await store.rename({
    principalRef: PRINCIPAL_A,
    conversationRef: created.conversationRef,
    title: "Better title",
    expectedRevision: 0
  });
  assert.equal(renamed.title, "Better title");
  assert.equal(renamed.revision, 1);

  await assert.rejects(
    store.rename({
      principalRef: PRINCIPAL_A,
      conversationRef: created.conversationRef,
      title: "Stale title",
      expectedRevision: 0
    }),
    (error) =>
      error instanceof HcnAssistantConversationStoreError
      && error.code === "conversation_revision_changed"
      && error.statusCode === 409
  );

  timestamp += 1_000;
  const archived = await store.archive({
    principalRef: PRINCIPAL_A,
    conversationRef: created.conversationRef,
    expectedRevision: 1
  });
  assert.equal(archived.state, "archived");
  assert.equal(archived.revision, 2);
  assert.match(archived.archivedAt, /Z$/);
  assert.equal((await store.list({
    principalRef: PRINCIPAL_A,
    state: "active",
    offset: 0,
    limit: 50
  })).page.total, 0);
  assert.equal((await store.list({
    principalRef: PRINCIPAL_A,
    state: "archived",
    offset: 0,
    limit: 50
  })).page.total, 1);
  await assert.rejects(
    store.appendTurn({
      principalRef: PRINCIPAL_A,
      conversationRef: created.conversationRef,
      expectedRevision: 2,
      prompt: "Do not accept this.",
      message: "No.",
      mode: "auto",
      routing: ROUTING,
      sources: []
    }),
    (error) => error.code === "conversation_archived"
  );

  timestamp += 1_000;
  const restored = await store.restore({
    principalRef: PRINCIPAL_A,
    conversationRef: created.conversationRef,
    expectedRevision: 2
  });
  assert.equal(restored.state, "active");
  assert.equal(restored.archivedAt, "");
  assert.equal(restored.revision, 3);
});

test("one active client chat is idempotent and archived history remains separate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let timestamp = Date.parse("2026-08-03T13:30:00.000Z");
  const store = createHcnAssistantConversationStore({
    filePath: path.join(root, "history.enc.json"),
    encryptionKey: KEY_A,
    now: () => timestamp
  });

  const [first, duplicate] = await Promise.all([
    store.create({
      principalRef: PRINCIPAL_A,
      scope: "assigned",
      kind: "file",
      fileRef: FILE_REF,
      title: "Client 2739"
    }),
    store.create({
      principalRef: PRINCIPAL_A,
      scope: "assigned",
      kind: "file",
      fileRef: FILE_REF,
      title: "Duplicate title is ignored"
    })
  ]);
  assert.equal(duplicate.conversationRef, first.conversationRef);
  assert.equal(duplicate.title, "Client 2739");
  assert.equal((await store.list({
    principalRef: PRINCIPAL_A,
    state: "active",
    offset: 0,
    limit: 50
  })).page.total, 1);

  timestamp += 1_000;
  const archived = await store.archive({
    principalRef: PRINCIPAL_A,
    conversationRef: first.conversationRef,
    expectedRevision: first.revision
  });
  timestamp += 1_000;
  const replacement = await store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "file",
    fileRef: FILE_REF,
    title: "Client 2739 - follow-up"
  });
  assert.notEqual(replacement.conversationRef, first.conversationRef);
  await assert.rejects(
    store.restore({
      principalRef: PRINCIPAL_A,
      conversationRef: first.conversationRef,
      expectedRevision: archived.revision
    }),
    (error) =>
      error instanceof HcnAssistantConversationStoreError
      && error.code === "active_file_conversation_exists"
      && error.statusCode === 409
  );
});

test("concurrent mutations serialize and never overwrite a winning turn", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createHcnAssistantConversationStore({
    filePath: path.join(root, "history.enc.json"),
    encryptionKey: KEY_A,
    now: () => Date.parse("2026-08-03T14:00:00.000Z")
  });
  const created = await store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Race"
  });
  const request = (prompt) => store.appendTurn({
    principalRef: PRINCIPAL_A,
    conversationRef: created.conversationRef,
    expectedRevision: 0,
    prompt,
    message: "One winning response.",
    mode: "auto",
    routing: ROUTING,
    sources: []
  });
  const outcomes = await Promise.allSettled([
    request("First request"),
    request("Second request")
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1
  );
  const rejection = outcomes.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, "conversation_revision_changed");
  const stored = await store.get({
    principalRef: PRINCIPAL_A,
    conversationRef: created.conversationRef
  });
  assert.equal(stored.revision, 1);
  assert.equal(stored.messages.length, 2);
});

test("wrong keys, tampering, malformed scopes, and unknown fields fail closed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "history.enc.json");
  const store = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_A
  });
  await store.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Encrypted"
  });
  const wrongKey = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_B
  });
  await assert.rejects(
    wrongKey.list({
      principalRef: PRINCIPAL_A,
      state: "active",
      offset: 0,
      limit: 50
    }),
    (error) => error.code === "store_corrupt" && error.statusCode === 503
  );

  const envelope = JSON.parse(await readFile(filePath, "utf8"));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${
    envelope.ciphertext.endsWith("A") ? "B" : "A"
  }`;
  await writeFile(filePath, JSON.stringify(envelope), "utf8");
  await assert.rejects(
    store.list({
      principalRef: PRINCIPAL_A,
      state: "active",
      offset: 0,
      limit: 50
    }),
    (error) => error.code === "store_corrupt"
  );

  const cleanPath = path.join(root, "clean.enc.json");
  const clean = createHcnAssistantConversationStore({
    filePath: cleanPath,
    encryptionKey: KEY_A
  });
  await assert.rejects(
    clean.create({
      principalRef: PRINCIPAL_A,
      scope: "management",
      kind: "file",
      fileRef: FILE_REF,
      title: "Invalid management file"
    }),
    (error) => error.code === "invalid_input"
  );
  await assert.rejects(
    clean.create({
      principalRef: PRINCIPAL_A,
      scope: "assigned",
      kind: "general",
      fileRef: "",
      title: "Unknown",
      extra: true
    }),
    (error) => error.code === "invalid_input"
  );
  assert.throws(
    () => createHcnAssistantConversationStore({
      filePath: cleanPath,
      encryptionKey: "not+canonical"
    }),
    (error) => error.code === "invalid_configuration"
  );
});

test("bound conversations persist continuity, isolate exact scopes, and stay out of employee chat lists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "history.enc.json");
  let timestamp = Date.parse("2026-08-05T12:00:00.000Z");
  const store = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_A,
    now: () => timestamp
  });
  const general = await store.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Jobrolo workload",
    externalBindingRef: BINDING_A
  });
  await store.appendTurn({
    principalRef: PRINCIPAL_A,
    conversationRef: general.conversationRef,
    expectedRevision: 0,
    prompt: "Remember this scoped context.",
    message: "This exact scoped context is durable.",
    mode: "auto",
    routing: ROUTING,
    sources: []
  });
  const fileA = await store.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "file",
    fileRef: FILE_REF,
    title: "Jobrolo file A",
    externalBindingRef: BINDING_B
  });
  const fileB = await store.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "file",
    fileRef: FILE_REF_B,
    title: "Jobrolo file B",
    externalBindingRef: BINDING_C
  });
  assert.equal(new Set([
    general.conversationRef,
    fileA.conversationRef,
    fileB.conversationRef
  ]).size, 3);
  assert.equal((await store.list({
    principalRef: PRINCIPAL_A,
    state: "active",
    offset: 0,
    limit: 50
  })).page.total, 0);

  timestamp += 5_000;
  const reopened = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_A,
    now: () => timestamp
  });
  const resumed = await reopened.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "A later title cannot fork the binding",
    externalBindingRef: BINDING_A
  });
  assert.equal(resumed.conversationRef, general.conversationRef);
  assert.equal(resumed.revision, 1);
  const stored = await reopened.get({
    principalRef: PRINCIPAL_A,
    conversationRef: resumed.conversationRef
  });
  assert.deepEqual(
    stored.messages.map((message) => message.content),
    [
      "Remember this scoped context.",
      "This exact scoped context is durable."
    ]
  );
  assert.equal(
    await reopened.get({
      principalRef: PRINCIPAL_B,
      conversationRef: resumed.conversationRef
    }),
    null
  );
  await assert.rejects(
    reopened.getOrCreateBound({
      principalRef: PRINCIPAL_A,
      scope: "assigned",
      kind: "file",
      fileRef: FILE_REF,
      title: "Binding collision",
      externalBindingRef: BINDING_A
    }),
    (error) =>
      error.code === "conversation_binding_scope_changed"
      && error.statusCode === 409
  );
});

test("bound conversation idle expiry slides, prunes atomically, and frees capacity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-expiry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let timestamp = Date.parse("2026-08-05T13:00:00.000Z");
  const store = createHcnAssistantConversationStore({
    filePath: path.join(root, "history.enc.json"),
    encryptionKey: KEY_A,
    now: () => timestamp,
    boundConversationIdleTtlMs: 1_000,
    maxConversations: 4,
    maxConversationsPerPrincipal: 4,
    maxBoundConversations: 1,
    maxBoundConversationsPerPrincipal: 1
  });
  const first = await store.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Sliding",
    externalBindingRef: BINDING_A
  });
  timestamp += 800;
  assert.equal((await store.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Sliding",
    externalBindingRef: BINDING_A
  })).conversationRef, first.conversationRef);
  timestamp += 700;
  assert.equal((await store.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Sliding",
    externalBindingRef: BINDING_A
  })).conversationRef, first.conversationRef);

  await assert.rejects(
    store.getOrCreateBound({
      principalRef: PRINCIPAL_B,
      scope: "assigned",
      kind: "general",
      fileRef: "",
      title: "Global cap",
      externalBindingRef: BINDING_B
    }),
    (error) =>
      error.code === "bound_conversation_capacity_reached"
      && error.statusCode === 409
  );

  timestamp += 1_001;
  const replacement = await store.getOrCreateBound({
    principalRef: PRINCIPAL_B,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "After safe prune",
    externalBindingRef: BINDING_B
  });
  assert.notEqual(replacement.conversationRef, first.conversationRef);
  assert.equal(await store.get({
    principalRef: PRINCIPAL_A,
    conversationRef: first.conversationRef
  }), null);
});

test("bound conversation per-principal capacity fails closed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createHcnAssistantConversationStore({
    filePath: path.join(root, "history.enc.json"),
    encryptionKey: KEY_A,
    maxConversations: 4,
    maxConversationsPerPrincipal: 3,
    maxBoundConversations: 3,
    maxBoundConversationsPerPrincipal: 1
  });
  await store.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "First",
    externalBindingRef: BINDING_A
  });
  await assert.rejects(
    store.getOrCreateBound({
      principalRef: PRINCIPAL_A,
      scope: "assigned",
      kind: "file",
      fileRef: FILE_REF,
      title: "Second",
      externalBindingRef: BINDING_B
    }),
    (error) =>
      error.code === "principal_bound_conversation_capacity_reached"
      && error.statusCode === 409
  );
});

test("legacy v1.0 encrypted history migrates on the next bound mutation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-conversation-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "history.enc.json");
  const initial = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_A
  });
  const existing = await initial.create({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Legacy chat"
  });
  const currentDocument = await decryptTestDocument(filePath, KEY_A);
  currentDocument.schemaVersion = "1.0.0";
  for (const conversation of currentDocument.conversations) {
    delete conversation.externalBindingRef;
    delete conversation.externalBindingExpiresAt;
  }
  await encryptTestDocument(filePath, KEY_A, currentDocument);

  const migrated = createHcnAssistantConversationStore({
    filePath,
    encryptionKey: KEY_A
  });
  assert.equal((await migrated.get({
    principalRef: PRINCIPAL_A,
    conversationRef: existing.conversationRef
  })).title, "Legacy chat");
  await migrated.getOrCreateBound({
    principalRef: PRINCIPAL_A,
    scope: "assigned",
    kind: "file",
    fileRef: FILE_REF,
    title: "New bound chat",
    externalBindingRef: BINDING_A
  });
  const savedDocument = await decryptTestDocument(filePath, KEY_A);
  assert.equal(savedDocument.schemaVersion, "1.1.0");
  assert.equal(
    savedDocument.conversations.every((conversation) =>
      Object.hasOwn(conversation, "externalBindingRef")
      && Object.hasOwn(conversation, "externalBindingExpiresAt")
    ),
    true
  );
});

const TEST_ENVELOPE_AAD = Buffer.from(JSON.stringify({
  schema: "hcn.assistant.conversation-store.encrypted",
  schemaVersion: "1.0.0",
  algorithm: "A256GCM",
  purpose: "hcn-employee-assistant-conversations"
}), "utf8");

function deriveTestStoreKey(masterKey) {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(masterKey, "base64url"),
    Buffer.from("hcn-assistant-conversation-store:hkdf-salt:v1", "utf8"),
    Buffer.from("hcn-assistant-conversation-store:aes-256-gcm-key:v1", "utf8"),
    32
  ));
}

async function decryptTestDocument(filePath, masterKey) {
  const envelope = JSON.parse(await readFile(filePath, "utf8"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveTestStoreKey(masterKey),
    Buffer.from(envelope.nonce, "base64url"),
    { authTagLength: 16 }
  );
  decipher.setAAD(TEST_ENVELOPE_AAD);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function encryptTestDocument(filePath, masterKey, document) {
  const nonce = Buffer.alloc(12, 0x55);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveTestStoreKey(masterKey),
    nonce,
    { authTagLength: 16 }
  );
  cipher.setAAD(TEST_ENVELOPE_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(document), "utf8")),
    cipher.final()
  ]);
  await writeFile(filePath, `${JSON.stringify({
    schema: "hcn.assistant.conversation-store.encrypted",
    schemaVersion: "1.0.0",
    algorithm: "A256GCM",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  })}\n`, "utf8");
}
