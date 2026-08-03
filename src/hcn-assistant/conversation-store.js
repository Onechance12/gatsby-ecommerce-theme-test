import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as cryptographicRandomBytes
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";

const STORE_SCHEMA = "hcn.assistant.conversation-store";
const STORE_VERSION = "1.0.0";
const ENVELOPE_SCHEMA = "hcn.assistant.conversation-store.encrypted";
const ENVELOPE_VERSION = "1.0.0";
const ENVELOPE_ALGORITHM = "A256GCM";
const KEY_SALT = Buffer.from(
  "hcn-assistant-conversation-store:hkdf-salt:v1",
  "utf8"
);
const KEY_INFO = Buffer.from(
  "hcn-assistant-conversation-store:aes-256-gcm-key:v1",
  "utf8"
);
const ENVELOPE_AAD = Buffer.from(JSON.stringify({
  schema: ENVELOPE_SCHEMA,
  schemaVersion: ENVELOPE_VERSION,
  algorithm: ENVELOPE_ALGORITHM,
  purpose: "hcn-employee-assistant-conversations"
}), "utf8");

const PRINCIPAL_REF = /^principal_[a-f0-9]{32}$/;
const CONVERSATION_REF = /^conversation_[a-f0-9]{32}$/;
const MESSAGE_REF = /^message_[a-f0-9]{32}$/;
const FILE_REF = /^subject_[a-f0-9]{32}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SOURCE_KEYS = new Set([
  "jobnimbus",
  "gmail",
  "quo",
  "google_calendar",
  "retell",
  "weather"
]);
const SOURCE_STATUSES = new Set([
  "fresh",
  "complete",
  "partial",
  "stale",
  "incomplete",
  "unavailable",
  "not_evaluated",
  "not_configured",
  "unknown",
  "pending_human_review"
]);
const ROUTES = new Set([
  "deterministic",
  "standard",
  "deep",
  "codex_escalation"
]);
const MODES = new Set(["auto", "deep"]);
const STATES = new Set(["active", "archived"]);
const SCOPES = new Set(["assigned", "management"]);
const KINDS = new Set(["general", "file", "sweep"]);

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const MIN_MASTER_KEY_BYTES = 32;
const MAX_MASTER_KEY_BYTES = 128;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_CONVERSATIONS = 512;
const HARD_MAX_CONVERSATIONS = 4096;
const DEFAULT_MAX_CONVERSATIONS_PER_PRINCIPAL = 200;
const HARD_MAX_CONVERSATIONS_PER_PRINCIPAL = 1000;
const DEFAULT_MAX_MESSAGES_PER_CONVERSATION = 1000;
const HARD_MAX_MESSAGES_PER_CONVERSATION = 4000;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TITLE_CHARACTERS = 120;
const MAX_TITLE_BYTES = 512;
const MAX_USER_CHARACTERS = 4000;
const MAX_USER_BYTES = 8 * 1024;
const MAX_ASSISTANT_CHARACTERS = 16000;
const MAX_ASSISTANT_BYTES = 32 * 1024;
const MAX_SOURCES = 50;
const MAX_REASON_CODES = 12;
const TEMPORARY_NAME_ATTEMPTS = 4;

/**
 * Encrypted, HCN-only durable transcript storage.
 *
 * This store is deliberately separate from the minimized Thresher operational
 * state store. It may contain the exact employee-visible prompt and response,
 * but accepts no provider credentials, hidden model state, tool payloads,
 * documents, action plans, or approval material.
 */
export function createHcnAssistantConversationStore({
  filePath,
  encryptionKey,
  now = Date.now,
  randomBytes = cryptographicRandomBytes,
  maxConversations = DEFAULT_MAX_CONVERSATIONS,
  maxConversationsPerPrincipal =
    DEFAULT_MAX_CONVERSATIONS_PER_PRINCIPAL,
  maxMessagesPerConversation =
    DEFAULT_MAX_MESSAGES_PER_CONVERSATION,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES
} = {}) {
  const configuredPath = normalizeStorePath(filePath);
  const key = deriveEncryptionKey(encryptionKey);
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");
  boundedInteger(
    maxConversations,
    1,
    HARD_MAX_CONVERSATIONS,
    "maxConversations"
  );
  boundedInteger(
    maxConversationsPerPrincipal,
    1,
    HARD_MAX_CONVERSATIONS_PER_PRINCIPAL,
    "maxConversationsPerPrincipal"
  );
  if (maxConversationsPerPrincipal > maxConversations) {
    invalidInput(
      "maxConversationsPerPrincipal cannot exceed maxConversations."
    );
  }
  boundedInteger(
    maxMessagesPerConversation,
    2,
    HARD_MAX_MESSAGES_PER_CONVERSATION,
    "maxMessagesPerConversation"
  );
  if (maxMessagesPerConversation % 2 !== 0) {
    invalidInput("maxMessagesPerConversation must be even.");
  }
  boundedInteger(
    maxFileBytes,
    1024,
    HARD_MAX_FILE_BYTES,
    "maxFileBytes"
  );

  let mutationQueue = Promise.resolve();

  async function list(input = {}) {
    const query = normalizeListInput(input);
    const document = await loadDocument();
    const matches = document.conversations
      .filter((item) =>
        item.principalRef === query.principalRef
        && item.state === query.state
      )
      .sort(compareConversationRecency);
    const items = matches
      .slice(query.offset, query.offset + query.limit)
      .map(projectConversation);
    return immutableCopy({
      items,
      page: {
        offset: query.offset,
        limit: query.limit,
        total: matches.length,
        hasMore: query.offset + items.length < matches.length
      }
    });
  }

  async function get(input = {}) {
    const query = normalizeConversationLookup(input);
    const document = await loadDocument();
    const conversation = findOwnedConversation(document, query);
    return conversation ? immutableCopy(conversation) : null;
  }

  async function verify() {
    await loadDocument();
    return true;
  }

  async function create(input = {}) {
    const request = normalizeCreateInput(input);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await loadDocument();
      if (request.kind === "file") {
        const existing = findActiveFileConversation(
          document,
          request.principalRef,
          request.fileRef
        );
        if (existing) return projectConversation(existing);
      }
      const ownedCount = document.conversations.filter(
        (item) => item.principalRef === request.principalRef
      ).length;
      if (document.conversations.length >= maxConversations) {
        conflict(
          "store_capacity_reached",
          "The HCN assistant conversation store is at capacity."
        );
      }
      if (ownedCount >= maxConversationsPerPrincipal) {
        conflict(
          "principal_capacity_reached",
          "This HCN employee has reached the conversation limit."
        );
      }
      const instant = iso(timestamp);
      const conversation = {
        conversationRef: uniqueReference(
          "conversation",
          randomBytes,
          document.conversations.map((item) => item.conversationRef)
        ),
        principalRef: request.principalRef,
        scope: request.scope,
        kind: request.kind,
        fileRef: request.fileRef,
        title: request.title,
        state: "active",
        revision: 0,
        createdAt: instant,
        updatedAt: instant,
        archivedAt: "",
        messages: []
      };
      document.conversations.push(conversation);
      sortDocument(document);
      await saveDocument(document);
      return projectConversation(conversation);
    });
  }

  async function renameConversation(input = {}) {
    const request = normalizeRenameInput(input);
    return mutateExisting(request, (conversation, instant) => {
      conversation.title = request.title;
      conversation.updatedAt = instant;
      conversation.revision += 1;
    });
  }

  async function archive(input = {}) {
    const request = normalizeRevisionInput(input, "archive");
    return mutateExisting(request, (conversation, instant) => {
      if (conversation.state === "archived") {
        conflict(
          "conversation_already_archived",
          "The HCN assistant conversation is already archived."
        );
      }
      conversation.state = "archived";
      conversation.archivedAt = instant;
      conversation.updatedAt = instant;
      conversation.revision += 1;
    });
  }

  async function restore(input = {}) {
    const request = normalizeRevisionInput(input, "restore");
    return mutateExisting(request, (conversation, instant, document) => {
      if (conversation.state === "active") {
        conflict(
          "conversation_already_active",
          "The HCN assistant conversation is already active."
        );
      }
      if (
        conversation.kind === "file"
        && findActiveFileConversation(
          document,
          conversation.principalRef,
          conversation.fileRef,
          conversation.conversationRef
        )
      ) {
        conflict(
          "active_file_conversation_exists",
          "This client already has an active HCN assistant conversation."
        );
      }
      conversation.state = "active";
      conversation.archivedAt = "";
      conversation.updatedAt = instant;
      conversation.revision += 1;
    });
  }

  async function appendTurn(input = {}) {
    const request = normalizeAppendTurnInput(input);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await loadDocument();
      const conversation = requireOwnedConversation(document, request);
      assertRevision(conversation, request.expectedRevision);
      if (conversation.state !== "active") {
        conflict(
          "conversation_archived",
          "An archived HCN assistant conversation cannot receive a turn."
        );
      }
      if (
        conversation.messages.length + 2
          > maxMessagesPerConversation
      ) {
        conflict(
          "conversation_message_capacity_reached",
          "This HCN assistant conversation has reached its message limit."
        );
      }
      const instant = iso(timestamp);
      const existingRefs = conversation.messages.map(
        (item) => item.messageRef
      );
      const userMessage = {
        messageRef: uniqueReference(
          "message",
          randomBytes,
          existingRefs
        ),
        role: "user",
        content: request.prompt,
        createdAt: instant,
        mode: request.mode,
        routing: null,
        sources: []
      };
      existingRefs.push(userMessage.messageRef);
      const assistantMessage = {
        messageRef: uniqueReference(
          "message",
          randomBytes,
          existingRefs
        ),
        role: "assistant",
        content: request.message,
        createdAt: instant,
        mode: request.mode,
        routing: request.routing,
        sources: request.sources
      };
      conversation.messages.push(userMessage, assistantMessage);
      conversation.updatedAt = instant;
      conversation.revision += 1;
      sortDocument(document);
      await saveDocument(document);
      return immutableCopy({
        conversation: projectConversation(conversation),
        userMessage,
        assistantMessage
      });
    });
  }

  async function mutateExisting(request, mutate) {
    return enqueueMutation(async () => {
      const document = await loadDocument();
      const conversation = requireOwnedConversation(document, request);
      assertRevision(conversation, request.expectedRevision);
      mutate(conversation, iso(readNow(now)), document);
      sortDocument(document);
      await saveDocument(document);
      return projectConversation(conversation);
    });
  }

  async function loadDocument() {
    return readEncryptedDocument({
      filePath: configuredPath,
      key,
      maxConversations,
      maxMessagesPerConversation,
      maxFileBytes
    });
  }

  async function saveDocument(document) {
    await writeEncryptedDocument({
      filePath: configuredPath,
      key,
      document,
      randomBytes,
      maxConversations,
      maxMessagesPerConversation,
      maxFileBytes
    });
  }

  function enqueueMutation(operation) {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return Object.freeze({
    verify,
    list,
    get,
    create,
    rename: renameConversation,
    archive,
    restore,
    appendTurn
  });
}

export class HcnAssistantConversationStoreError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "HcnAssistantConversationStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeListInput(value) {
  exactRecord(
    value,
    ["principalRef", "state", "offset", "limit"],
    "conversation list"
  );
  const state = enumValue(value.state, STATES, "state");
  boundedInteger(value.offset, 0, 10_000, "offset");
  boundedInteger(value.limit, 1, 100, "limit");
  return {
    principalRef: principalReference(value.principalRef),
    state,
    offset: value.offset,
    limit: value.limit
  };
}

function normalizeConversationLookup(value) {
  exactRecord(
    value,
    ["principalRef", "conversationRef"],
    "conversation lookup"
  );
  return {
    principalRef: principalReference(value.principalRef),
    conversationRef: conversationReference(value.conversationRef)
  };
}

function normalizeCreateInput(value) {
  exactRecord(
    value,
    ["principalRef", "scope", "kind", "fileRef", "title"],
    "conversation create"
  );
  const scope = enumValue(value.scope, SCOPES, "scope");
  const kind = enumValue(value.kind, KINDS, "kind");
  const fileRef = optionalFileReference(value.fileRef);
  assertScopeKind(scope, kind, fileRef);
  return {
    principalRef: principalReference(value.principalRef),
    scope,
    kind,
    fileRef,
    title: title(value.title)
  };
}

function normalizeRenameInput(value) {
  exactRecord(
    value,
    ["principalRef", "conversationRef", "title", "expectedRevision"],
    "conversation rename"
  );
  return {
    principalRef: principalReference(value.principalRef),
    conversationRef: conversationReference(value.conversationRef),
    title: title(value.title),
    expectedRevision: revision(value.expectedRevision)
  };
}

function normalizeRevisionInput(value, operation) {
  exactRecord(
    value,
    ["principalRef", "conversationRef", "expectedRevision"],
    `conversation ${operation}`
  );
  return {
    principalRef: principalReference(value.principalRef),
    conversationRef: conversationReference(value.conversationRef),
    expectedRevision: revision(value.expectedRevision)
  };
}

function normalizeAppendTurnInput(value) {
  exactRecord(
    value,
    [
      "principalRef",
      "conversationRef",
      "expectedRevision",
      "prompt",
      "message",
      "mode",
      "routing",
      "sources"
    ],
    "conversation turn"
  );
  return {
    principalRef: principalReference(value.principalRef),
    conversationRef: conversationReference(value.conversationRef),
    expectedRevision: revision(value.expectedRevision),
    prompt: content(
      value.prompt,
      "prompt",
      MAX_USER_CHARACTERS,
      MAX_USER_BYTES
    ),
    message: content(
      value.message,
      "message",
      MAX_ASSISTANT_CHARACTERS,
      MAX_ASSISTANT_BYTES
    ),
    mode: enumValue(value.mode, MODES, "mode"),
    routing: normalizeRouting(value.routing),
    sources: normalizeSources(value.sources)
  };
}

function validateDocument(value, limits) {
  exactRecord(
    value,
    ["schema", "schemaVersion", "conversations"],
    "conversation store document",
    true
  );
  if (
    value.schema !== STORE_SCHEMA
    || value.schemaVersion !== STORE_VERSION
    || !Array.isArray(value.conversations)
    || value.conversations.length > limits.maxConversations
  ) {
    corruptStore("The HCN assistant conversation store schema is invalid.");
  }
  const conversationRefs = new Set();
  const activeFileConversationKeys = new Set();
  for (const item of value.conversations) {
    validateConversation(item, limits.maxMessagesPerConversation, true);
    if (conversationRefs.has(item.conversationRef)) {
      corruptStore(
        "The HCN assistant conversation store contains duplicate conversations."
      );
    }
    conversationRefs.add(item.conversationRef);
    if (item.kind === "file" && item.state === "active") {
      const key = `${item.principalRef}\0${item.fileRef}`;
      if (activeFileConversationKeys.has(key)) {
        corruptStore(
          "The HCN assistant conversation store contains duplicate active client chats."
        );
      }
      activeFileConversationKeys.add(key);
    }
  }
  return value;
}

function validateConversation(value, maxMessages, persisted) {
  exactRecord(value, [
    "conversationRef",
    "principalRef",
    "scope",
    "kind",
    "fileRef",
    "title",
    "state",
    "revision",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "messages"
  ], "conversation", persisted);
  conversationReference(value.conversationRef, persisted);
  principalReference(value.principalRef, persisted);
  const scope = enumValue(value.scope, SCOPES, "scope", persisted);
  const kind = enumValue(value.kind, KINDS, "kind", persisted);
  const fileRef = optionalFileReference(value.fileRef, persisted);
  assertScopeKind(scope, kind, fileRef, persisted);
  title(value.title, persisted);
  const state = enumValue(value.state, STATES, "state", persisted);
  revision(value.revision, persisted);
  instant(value.createdAt, "createdAt", persisted);
  instant(value.updatedAt, "updatedAt", persisted);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    persisted
      ? corruptStore("A stored conversation timestamp is invalid.")
      : invalidInput("updatedAt cannot precede createdAt.");
  }
  if (state === "archived") {
    instant(value.archivedAt, "archivedAt", persisted);
    if (Date.parse(value.archivedAt) < Date.parse(value.createdAt)) {
      persisted
        ? corruptStore("A stored conversation archive timestamp is invalid.")
        : invalidInput("archivedAt cannot precede createdAt.");
    }
  } else if (value.archivedAt !== "") {
    persisted
      ? corruptStore("An active stored conversation has archive metadata.")
      : invalidInput("An active conversation cannot have archivedAt.");
  }
  if (
    !Array.isArray(value.messages)
    || value.messages.length > maxMessages
    || value.messages.length % 2 !== 0
  ) {
    persisted
      ? corruptStore("A stored conversation message list is invalid.")
      : invalidInput("messages must contain bounded complete turn pairs.");
  }
  const refs = new Set();
  value.messages.forEach((message, index) => {
    validateMessage(message, index, persisted);
    if (refs.has(message.messageRef)) {
      corruptStore("A stored conversation contains duplicate messages.");
    }
    refs.add(message.messageRef);
  });
  return value;
}

function validateMessage(value, index, persisted) {
  exactRecord(value, [
    "messageRef",
    "role",
    "content",
    "createdAt",
    "mode",
    "routing",
    "sources"
  ], `message[${index}]`, persisted);
  messageReference(value.messageRef, persisted);
  const expectedRole = index % 2 === 0 ? "user" : "assistant";
  if (value.role !== expectedRole) {
    persisted
      ? corruptStore("A stored conversation has invalid message ordering.")
      : invalidInput("Conversation messages must alternate user and assistant.");
  }
  content(
    value.content,
    "content",
    expectedRole === "user"
      ? MAX_USER_CHARACTERS
      : MAX_ASSISTANT_CHARACTERS,
    expectedRole === "user" ? MAX_USER_BYTES : MAX_ASSISTANT_BYTES,
    persisted
  );
  instant(value.createdAt, "createdAt", persisted);
  enumValue(value.mode, MODES, "mode", persisted);
  if (expectedRole === "user") {
    if (value.routing !== null || !Array.isArray(value.sources)
      || value.sources.length !== 0) {
      persisted
        ? corruptStore("A stored user message contains assistant metadata.")
        : invalidInput("A user message cannot contain assistant metadata.");
    }
  } else {
    normalizeRouting(value.routing, persisted);
    normalizeSources(value.sources, persisted);
  }
}

function normalizeRouting(value, persisted = false) {
  exactRecord(
    value,
    ["route", "profileId", "reasonCodes", "modelUsed"],
    "routing",
    persisted
  );
  const route = enumValue(value.route, ROUTES, "route", persisted);
  const profileId = boundedText(
    value.profileId,
    "profileId",
    120,
    256,
    persisted
  );
  if (
    !Array.isArray(value.reasonCodes)
    || value.reasonCodes.length < 1
    || value.reasonCodes.length > MAX_REASON_CODES
  ) {
    persisted
      ? corruptStore("Stored assistant routing reason codes are invalid.")
      : invalidInput("reasonCodes must contain 1-12 codes.");
  }
  const reasonCodes = value.reasonCodes.map((reason) =>
    boundedText(reason, "reasonCode", 80, 160, persisted)
  );
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    persisted
      ? corruptStore("Stored assistant routing reason codes are duplicated.")
      : invalidInput("reasonCodes cannot contain duplicates.");
  }
  if (typeof value.modelUsed !== "boolean") {
    persisted
      ? corruptStore("Stored assistant routing model state is invalid.")
      : invalidInput("modelUsed must be boolean.");
  }
  return { route, profileId, reasonCodes, modelUsed: value.modelUsed };
}

function normalizeSources(value, persisted = false) {
  if (!Array.isArray(value) || value.length > MAX_SOURCES) {
    persisted
      ? corruptStore("Stored assistant source metadata is invalid.")
      : invalidInput("sources must contain at most 50 entries.");
  }
  const seen = new Set();
  return value.map((source) => {
    exactRecord(
      source,
      ["key", "label", "status", "checkedAt"],
      "source",
      persisted
    );
    const key = enumValue(source.key, SOURCE_KEYS, "source.key", persisted);
    if (seen.has(key)) {
      persisted
        ? corruptStore("Stored assistant sources contain duplicates.")
        : invalidInput("sources cannot contain duplicate keys.");
    }
    seen.add(key);
    return {
      key,
      label: boundedText(
        source.label,
        "source.label",
        80,
        256,
        persisted
      ),
      status: enumValue(
        source.status,
        SOURCE_STATUSES,
        "source.status",
        persisted
      ),
      checkedAt: instant(source.checkedAt, "source.checkedAt", persisted)
    };
  });
}

function assertScopeKind(scope, kind, fileRef, persisted = false) {
  const valid = (
    (kind === "general" && scope === "assigned" && fileRef === "")
    || (kind === "file" && scope === "assigned" && Boolean(fileRef))
    || (kind === "sweep" && scope === "management" && fileRef === "")
  );
  if (valid) return;
  persisted
    ? corruptStore("A stored conversation scope is invalid.")
    : invalidInput("scope, kind, and fileRef are not a valid combination.");
}

function requireOwnedConversation(document, input) {
  const conversation = findOwnedConversation(document, input);
  if (!conversation) {
    throw storeError(
      "conversation_not_found",
      "The HCN assistant conversation was not found.",
      404
    );
  }
  return conversation;
}

function findOwnedConversation(document, input) {
  return document.conversations.find((item) =>
    item.conversationRef === input.conversationRef
    && item.principalRef === input.principalRef
  ) || null;
}

function findActiveFileConversation(
  document,
  principalRef,
  fileRef,
  excludedConversationRef = ""
) {
  return document.conversations.find((item) =>
    item.principalRef === principalRef
    && item.kind === "file"
    && item.fileRef === fileRef
    && item.state === "active"
    && item.conversationRef !== excludedConversationRef
  ) || null;
}

function assertRevision(conversation, expected) {
  if (conversation.revision !== expected) {
    conflict(
      "conversation_revision_changed",
      "The HCN assistant conversation changed. Reload it before continuing."
    );
  }
}

function projectConversation(value) {
  return immutableCopy({
    conversationRef: value.conversationRef,
    scope: value.scope,
    kind: value.kind,
    fileRef: value.fileRef,
    title: value.title,
    state: value.state,
    revision: value.revision,
    messageCount: value.messages.length,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt
  });
}

function compareConversationRecency(left, right) {
  return right.updatedAt.localeCompare(left.updatedAt)
    || left.conversationRef.localeCompare(right.conversationRef);
}

function sortDocument(document) {
  document.conversations.sort((left, right) =>
    left.principalRef.localeCompare(right.principalRef)
    || left.conversationRef.localeCompare(right.conversationRef)
  );
}

async function readEncryptedDocument({
  filePath,
  key,
  maxConversations,
  maxMessagesPerConversation,
  maxFileBytes
}) {
  await inspectParentDirectory(path.dirname(filePath), false);
  const metadata = await safeLstat(filePath);
  if (!metadata) return emptyDocument();
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    unsafePath("The HCN assistant conversation path is not a private file.");
  }
  if (metadata.size < 1 || metadata.size > maxFileBytes) {
    corruptStore("The encrypted HCN assistant conversation store is invalid.");
  }
  let handle;
  try {
    handle = await open(filePath, "r");
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size || bytes.length > maxFileBytes) {
      corruptStore(
        "The encrypted HCN assistant conversation store changed while reading."
      );
    }
    return decryptDocument(bytes, key, {
      maxConversations,
      maxMessagesPerConversation
    });
  } catch (error) {
    if (error instanceof HcnAssistantConversationStoreError) throw error;
    throw storeError(
      "store_read_failed",
      "The encrypted HCN assistant conversation store could not be read.",
      503
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeEncryptedDocument({
  filePath,
  key,
  document,
  randomBytes,
  maxConversations,
  maxMessagesPerConversation,
  maxFileBytes
}) {
  validateDocument(document, {
    maxConversations,
    maxMessagesPerConversation
  });
  const parent = path.dirname(filePath);
  await inspectParentDirectory(parent, true);
  const existing = await safeLstat(filePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    unsafePath("The HCN assistant conversation target is unsafe.");
  }
  const output = encryptDocument(document, key, randomBytes);
  if (output.length > maxFileBytes) {
    conflict(
      "store_capacity_reached",
      "The encrypted HCN assistant conversation store is at capacity."
    );
  }
  const temporaryPath = await allocateTemporaryPath(filePath, randomBytes);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(output);
    await handle.sync();
    await handle.close();
    handle = null;
    const temporaryMetadata = await lstat(temporaryPath);
    if (
      temporaryMetadata.isSymbolicLink()
      || !temporaryMetadata.isFile()
      || temporaryMetadata.size !== output.length
    ) {
      unsafePath("The temporary HCN assistant conversation file is unsafe.");
    }
    await rename(temporaryPath, filePath);
    renamed = true;
    await chmod(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    if (error instanceof HcnAssistantConversationStoreError) throw error;
    throw storeError(
      "store_write_failed",
      "The encrypted HCN assistant conversation store could not be written.",
      503
    );
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

function encryptDocument(document, key, randomBytes) {
  const nonce = exactRandomBytes(randomBytes, NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: AUTH_TAG_BYTES
  });
  cipher.setAAD(ENVELOPE_AAD);
  const plaintext = Buffer.from(JSON.stringify(document), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    schema: ENVELOPE_SCHEMA,
    schemaVersion: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  };
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

function decryptDocument(bytes, key, limits) {
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    corruptStore("The encrypted HCN assistant envelope is invalid JSON.");
  }
  exactRecord(envelope, [
    "schema",
    "schemaVersion",
    "algorithm",
    "nonce",
    "ciphertext",
    "authTag"
  ], "encrypted conversation envelope", true);
  if (
    envelope.schema !== ENVELOPE_SCHEMA
    || envelope.schemaVersion !== ENVELOPE_VERSION
    || envelope.algorithm !== ENVELOPE_ALGORITHM
  ) {
    corruptStore("The encrypted HCN assistant envelope is unsupported.");
  }
  const nonce = encodedBytes(envelope.nonce, NONCE_BYTES, "nonce");
  const ciphertext = encodedBytes(
    envelope.ciphertext,
    null,
    "ciphertext"
  );
  const authTag = encodedBytes(
    envelope.authTag,
    AUTH_TAG_BYTES,
    "authTag"
  );
  if (ciphertext.length < 1) {
    corruptStore("The encrypted HCN assistant ciphertext is empty.");
  }
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
  } catch {
    corruptStore(
      "The encrypted HCN assistant conversation store could not be authenticated."
    );
  }
  let document;
  try {
    document = JSON.parse(plaintext.toString("utf8"));
  } catch {
    corruptStore("The decrypted HCN assistant conversation store is invalid.");
  }
  return validateDocument(document, limits);
}

function emptyDocument() {
  return {
    schema: STORE_SCHEMA,
    schemaVersion: STORE_VERSION,
    conversations: []
  };
}

function deriveEncryptionKey(value) {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    invalidConfiguration(
      "The dedicated HCN assistant history key must be canonical base64url."
    );
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    invalidConfiguration("The dedicated HCN assistant history key is invalid.");
  }
  if (
    decoded.length < MIN_MASTER_KEY_BYTES
    || decoded.length > MAX_MASTER_KEY_BYTES
    || decoded.toString("base64url") !== value
  ) {
    invalidConfiguration(
      "The dedicated HCN assistant history key must encode 32-128 bytes."
    );
  }
  return Buffer.from(hkdfSync(
    "sha256",
    decoded,
    KEY_SALT,
    KEY_INFO,
    DERIVED_KEY_BYTES
  ));
}

async function inspectParentDirectory(directory, create) {
  let metadata = await safeLstat(directory);
  if (!metadata && create) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      unsafePath("The HCN assistant history directory could not be created.");
    }
    metadata = await safeLstat(directory);
  }
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    unsafePath("The HCN assistant history directory is unsafe.");
  }
  let actual;
  try {
    actual = await realpath(directory);
  } catch {
    unsafePath("The HCN assistant history directory is unavailable.");
  }
  if (canonicalPath(actual) !== canonicalPath(path.resolve(directory))) {
    unsafePath("Redirected HCN assistant history paths are not allowed.");
  }
}

async function allocateTemporaryPath(filePath, randomBytes) {
  for (let attempt = 0; attempt < TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
    const suffix = exactRandomBytes(randomBytes, 12).toString("hex");
    const candidate = `${filePath}.${suffix}.tmp`;
    if (!await safeLstat(candidate)) return candidate;
  }
  throw storeError(
    "store_write_failed",
    "A unique HCN assistant history temporary file could not be allocated.",
    503
  );
}

function uniqueReference(kind, randomBytes, existing) {
  const prefix = kind === "conversation" ? "conversation_" : "message_";
  const known = new Set(existing);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${prefix}${exactRandomBytes(
      randomBytes,
      16
    ).toString("hex")}`;
    if (!known.has(candidate)) return candidate;
  }
  throw storeError(
    "reference_allocation_failed",
    "A unique HCN assistant reference could not be allocated.",
    503
  );
}

function exactRandomBytes(randomBytes, size) {
  let value;
  try {
    value = randomBytes(size);
  } catch {
    invalidConfiguration("Secure random generation failed.");
  }
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    invalidConfiguration("Secure random generation returned invalid bytes.");
  }
  const bytes = Buffer.from(value);
  if (bytes.length !== size) {
    invalidConfiguration("Secure random generation returned the wrong size.");
  }
  return bytes;
}

function normalizeStorePath(value) {
  if (
    typeof value !== "string"
    || !value.trim()
    || !path.isAbsolute(value)
  ) {
    invalidConfiguration(
      "HCN assistant history storage requires an absolute file path."
    );
  }
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) {
    invalidConfiguration(
      "HCN assistant history storage must identify a file."
    );
  }
  return resolved;
}

async function safeLstat(value) {
  try {
    return await lstat(value);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    unsafePath("The HCN assistant history path could not be inspected.");
  }
}

function canonicalPath(value) {
  return process.platform === "win32"
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
}

function encodedBytes(value, exactLength, label) {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    corruptStore(`The encrypted HCN assistant ${label} is invalid.`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    corruptStore(`The encrypted HCN assistant ${label} is invalid.`);
  }
  if (
    bytes.toString("base64url") !== value
    || (exactLength !== null && bytes.length !== exactLength)
  ) {
    corruptStore(`The encrypted HCN assistant ${label} is invalid.`);
  }
  return bytes;
}

function exactRecord(value, fields, label, persisted = false) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    persisted
      ? corruptStore(`The stored ${label} is invalid.`)
      : invalidInput(`${label} must be a plain object.`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    persisted
      ? corruptStore(`The stored ${label} schema is invalid.`)
      : invalidInput(`${label} must contain only its documented fields.`);
  }
}

function principalReference(value, persisted = false) {
  if (typeof value !== "string" || !PRINCIPAL_REF.test(value)) {
    persisted
      ? corruptStore("A stored HCN principal reference is invalid.")
      : invalidInput("principalRef must be an opaque HCN principal reference.");
  }
  return value;
}

function conversationReference(value, persisted = false) {
  if (typeof value !== "string" || !CONVERSATION_REF.test(value)) {
    persisted
      ? corruptStore("A stored conversation reference is invalid.")
      : invalidInput("conversationRef must be an opaque conversation reference.");
  }
  return value;
}

function messageReference(value, persisted = false) {
  if (typeof value !== "string" || !MESSAGE_REF.test(value)) {
    persisted
      ? corruptStore("A stored message reference is invalid.")
      : invalidInput("messageRef must be an opaque message reference.");
  }
  return value;
}

function optionalFileReference(value, persisted = false) {
  if (value === "") return "";
  if (typeof value !== "string" || !FILE_REF.test(value)) {
    persisted
      ? corruptStore("A stored HCN file reference is invalid.")
      : invalidInput("fileRef must be an opaque HCN file reference or empty.");
  }
  return value;
}

function title(value, persisted = false) {
  return boundedText(
    value,
    "title",
    MAX_TITLE_CHARACTERS,
    MAX_TITLE_BYTES,
    persisted
  );
}

function content(value, label, maxCharacters, maxBytes, persisted = false) {
  return boundedText(
    value,
    label,
    maxCharacters,
    maxBytes,
    persisted
  );
}

function boundedText(
  value,
  label,
  maxCharacters,
  maxBytes,
  persisted = false
) {
  const valid = (
    typeof value === "string"
    && value.length >= 1
    && value.length <= maxCharacters
    && value === value.trim()
    && !CONTROL_CHARACTERS.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes
  );
  if (!valid) {
    persisted
      ? corruptStore(`A stored ${label} is invalid.`)
      : invalidInput(`${label} is invalid or exceeds its safe limit.`);
  }
  return value;
}

function enumValue(value, values, label, persisted = false) {
  if (typeof value !== "string" || !values.has(value)) {
    persisted
      ? corruptStore(`A stored ${label} is invalid.`)
      : invalidInput(`${label} is not enabled.`);
  }
  return value;
}

function revision(value, persisted = false) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    persisted
      ? corruptStore("A stored conversation revision is invalid.")
      : invalidInput("expectedRevision must be a non-negative integer.");
  }
  return value;
}

function instant(value, label, persisted = false) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    persisted
      ? corruptStore(`A stored ${label} is invalid.`)
      : invalidInput(`${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    invalidInput(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    invalidConfiguration("The HCN assistant history clock is unavailable.");
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidConfiguration("The HCN assistant history clock is invalid.");
  }
  return value;
}

function iso(value) {
  return new Date(value).toISOString();
}

function immutableCopy(value) {
  return structuredClone(value);
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    invalidConfiguration(`${label} must be a function.`);
  }
}

function invalidInput(message) {
  throw storeError("invalid_input", message, 400);
}

function invalidConfiguration(message) {
  throw storeError("invalid_configuration", message, 500);
}

function conflict(code, message) {
  throw storeError(code, message, 409);
}

function corruptStore(message) {
  throw storeError("store_corrupt", message, 503);
}

function unsafePath(message) {
  throw storeError("unsafe_store_path", message, 503);
}

function storeError(code, message, statusCode) {
  return new HcnAssistantConversationStoreError(code, message, statusCode);
}
