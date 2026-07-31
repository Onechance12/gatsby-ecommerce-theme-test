import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "hcn.employee-invitations.v1";
const ENVELOPE_VERSION = "hcn.employee-invitations.encrypted.v1";
const ENVELOPE_AAD = Buffer.from(
  "hcn-employee-invitation-store:v1",
  "utf8"
);
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_STORE_BYTES = 512 * 1024;
const MAX_RECORDS = 512;
const INVITATION_REF_PATTERN = /^invite_[a-f0-9]{32}$/;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GOOGLE_SUBJECT_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const PRINCIPAL_REF_PATTERN = /^[A-Za-z0-9._~-]{16,192}$/;
const INVITABLE_ROLES = new Set([
  "client_coordinator",
  "employee",
  "manager"
]);
const STORED_STATES = new Set([
  "accepted",
  "pending",
  "revoked"
]);
const MIN_INVITATION_TTL_MS = 60 * 60_000;
const MAX_INVITATION_TTL_MS = 72 * 60 * 60_000;

/**
 * Authenticated, bounded, HCN-only employee invitation and authorization
 * store. It contains employee admission metadata only and no client data.
 */
export function createHcnInvitationStore({
  filePath,
  key,
  allowedDomain = "",
  now = Date.now,
  randomBytes = nodeRandomBytes
} = {}) {
  const storePath = normalizeStorePath(filePath);
  const {
    encryptionKey,
    tokenKey
  } = deriveStoreKeys(key);
  const domain = normalizeDomain(allowedDomain);
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");
  let mutationQueue = Promise.resolve();

  async function list() {
    const records = await readVerifiedRecords({
      filePath: storePath,
      encryptionKey,
      randomBytes,
      allowedDomain: domain
    });
    const timestamp = readNow(now);
    return records.map((record) => copyRecord(record, timestamp));
  }

  async function getByRef(invitationRef) {
    const ref = normalizeInvitationRef(invitationRef);
    const records = await list();
    return records.find((record) => record.invitationRef === ref) || null;
  }

  async function getPendingByEmail(email) {
    const normalizedEmail = normalizeEmail(email, domain);
    const records = await list();
    return [...records]
      .reverse()
      .find(
        (record) =>
          record.email === normalizedEmail
          && record.state === "pending"
      ) || null;
  }

  async function getAuthorizationByEmail(email) {
    const normalizedEmail = normalizeEmail(email, domain);
    const records = await list();
    return [...records]
      .reverse()
      .find(
        (record) =>
          record.email === normalizedEmail
          && record.state === "accepted"
      ) || null;
  }

  async function validateInviteToken(candidate = {}) {
    assertPlainObject(candidate, "invitation token");
    assertExactKeys(
      candidate,
      ["invitationRef", "inviteToken"],
      "invitation token"
    );
    const invitationRef = normalizeInvitationRef(
      candidate.invitationRef
    );
    const inviteToken = normalizeInviteToken(candidate.inviteToken);
    const record = await getByRef(invitationRef);
    if (!record || record.state !== "pending") {
      // Perform the same MAC work for absent and inactive records.
      inviteTokenDigest(
        tokenKey,
        invitationRef,
        inviteToken
      );
      return null;
    }
    const received = Buffer.from(
      inviteTokenDigest(
        tokenKey,
        invitationRef,
        inviteToken
      ),
      "hex"
    );
    const expected = Buffer.from(record.inviteTokenHash, "hex");
    return received.length === expected.length
      && timingSafeEqual(received, expected)
        ? record
        : null;
  }

  async function createInvitation(candidate = {}) {
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const record = normalizeNewInvitation(candidate, {
        allowedDomain: domain,
        timestamp,
        randomBytes,
        tokenKey
      });
      const records = await readVerifiedRecords({
        filePath: storePath,
        encryptionKey,
        randomBytes,
        allowedDomain: domain
      });
      const active = records.filter(
        (entry) =>
          effectiveState(entry, timestamp) === "pending"
          || entry.state === "accepted"
      );
      if (active.some((entry) => entry.email === record.email)) {
        throw storeError(
          "employee_already_invited",
          "This employee already has a pending invitation or active authorization.",
          409
        );
      }
      if (
        records.some(
          (entry) =>
            entry.email === record.email
            && entry.jobNimbusOwnerId
              !== record.jobNimbusOwnerId
        )
      ) {
        throw storeError(
          "historical_identity_transfer_denied",
          "This employee email has historical HCN authority for another JobNimbus owner.",
          409
        );
      }
      if (
        records.some(
          (entry) =>
            entry.jobNimbusOwnerId === record.jobNimbusOwnerId
            && entry.email !== record.email
        )
      ) {
        throw storeError(
          "jobnimbus_owner_already_authorized",
          "This JobNimbus employee is already bound to another HCN invitation.",
          409
        );
      }
      if (records.length >= MAX_RECORDS) {
        throw storeError(
          "store_capacity_reached",
          "The HCN employee invitation store has reached its safe capacity.",
          409
        );
      }
      const next = [...records, record].sort(compareRecords);
      await writeVerifiedRecords({
        filePath: storePath,
        encryptionKey,
        randomBytes,
        records: next
      });
      const result = {
        ...copyRecord(record, timestamp)
      };
      Object.defineProperty(result, "inviteToken", {
        value: record[PRIVATE_INVITE_TOKEN],
        enumerable: false,
        configurable: false,
        writable: false
      });
      return Object.freeze(result);
    });
  }

  async function acceptInvitation(candidate = {}) {
    return enqueueMutation(async () => {
      const input = normalizeAcceptance(candidate, domain);
      const timestamp = readNow(now);
      const records = await readVerifiedRecords({
        filePath: storePath,
        encryptionKey,
        randomBytes,
        allowedDomain: domain
      });
      const index = records.findIndex(
        (record) => record.invitationRef === input.invitationRef
      );
      if (index === -1 || records[index].email !== input.email) {
        throw storeError(
          "invitation_not_found",
          "No matching HCN employee invitation is available.",
          404
        );
      }
      const existing = records[index];
      if (existing.state === "accepted") {
        throw storeError(
          "invitation_already_consumed",
          "This HCN employee invitation has already been used.",
          409
        );
      }
      if (
        existing.state !== "pending"
        || effectiveState(existing, timestamp) !== "pending"
      ) {
        throw storeError(
          "invitation_not_active",
          "This HCN employee invitation is no longer active.",
          409
        );
      }
      const providedTokenHash = Buffer.from(
        inviteTokenDigest(
          tokenKey,
          input.invitationRef,
          input.inviteToken
        ),
        "hex"
      );
      const expectedTokenHash = Buffer.from(
        existing.inviteTokenHash,
        "hex"
      );
      if (
        providedTokenHash.length !== expectedTokenHash.length
        || !timingSafeEqual(
          providedTokenHash,
          expectedTokenHash
        )
      ) {
        throw storeError(
          "invalid_invitation_token",
          "The HCN employee invitation token is invalid.",
          403
        );
      }
      if (
        records.some(
          (record, recordIndex) =>
            recordIndex !== index
            && (
              (
                record.state === "accepted"
                && (
                  record.email === existing.email
                  || record.jobNimbusOwnerId
                    === existing.jobNimbusOwnerId
                )
              )
              || (
                record.googleSubject
                && record.googleSubject === input.googleSubject
                && record.email !== existing.email
              )
            )
        )
      ) {
        throw storeError(
          "employee_authorization_conflict",
          "This employee identity is already bound to another HCN authorization.",
          409
        );
      }
      const accepted = {
        ...existing,
        state: "accepted",
        googleSubject: input.googleSubject,
        acceptedAt: iso(timestamp)
      };
      records[index] = accepted;
      await writeVerifiedRecords({
        filePath: storePath,
        encryptionKey,
        randomBytes,
        records
      });
      return copyRecord(accepted, timestamp);
    });
  }

  async function revokeInvitation(candidate = {}) {
    return enqueueMutation(async () => {
      const input = normalizeRevocation(candidate);
      const timestamp = readNow(now);
      const records = await readVerifiedRecords({
        filePath: storePath,
        encryptionKey,
        randomBytes,
        allowedDomain: domain
      });
      const index = records.findIndex(
        (record) => record.invitationRef === input.invitationRef
      );
      if (index === -1) {
        throw storeError(
          "invitation_not_found",
          "No matching HCN employee invitation is available.",
          404
        );
      }
      const existing = records[index];
      if (
        existing.state === "revoked"
        || effectiveState(existing, timestamp) === "expired"
      ) {
        throw storeError(
          "invitation_not_active",
          "This HCN employee invitation or authorization is no longer active.",
          409
        );
      }
      const revoked = {
        ...existing,
        state: "revoked",
        revokedByRef: input.revokedByRef,
        revokedAt: iso(timestamp)
      };
      records[index] = revoked;
      await writeVerifiedRecords({
        filePath: storePath,
        encryptionKey,
        records,
        randomBytes
      });
      return copyRecord(revoked, timestamp);
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
    list,
    getByRef,
    getPendingByEmail,
    getAuthorizationByEmail,
    validateInviteToken,
    createInvitation,
    acceptInvitation,
    revokeInvitation,
    status() {
      return Object.freeze({
        configured: true,
        schemaVersion: SCHEMA_VERSION,
        maxRecords: MAX_RECORDS
      });
    }
  });
}

export function hcnInvitationPublicRecord(record = {}) {
  return Object.freeze({
    invitationRef: String(record.invitationRef || ""),
    email: String(record.email || ""),
    displayName: String(record.displayName || ""),
    role: String(record.role || ""),
    jobNimbusScope: String(record.jobNimbusScope || ""),
    state: String(record.state || ""),
    invitedAt: String(record.invitedAt || ""),
    expiresAt: String(record.expiresAt || ""),
    acceptedAt: String(record.acceptedAt || ""),
    revokedAt: String(record.revokedAt || "")
  });
}

function normalizeStorePath(value) {
  const candidate = String(value || "").trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new TypeError(
      "HCN employee invitation storage requires an absolute file path."
    );
  }
  return path.resolve(candidate);
}

function deriveStoreKeys(value) {
  const material = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(String(value || ""), "utf8");
  if (material.length < 32) {
    throw new TypeError(
      "HCN employee invitation storage requires at least 32 bytes of key material."
    );
  }
  return Object.freeze({
    encryptionKey: createHmac("sha256", material)
      .update(
        "hcn-employee-invitation-store:encryption-key:v1",
        "utf8"
      )
      .digest(),
    tokenKey: createHmac("sha256", material)
      .update(
        "hcn-employee-invitation-store:invite-token-key:v1",
        "utf8"
      )
      .digest()
  });
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (!domain) return "";
  if (
    domain.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
  ) {
    throw new TypeError(
      "HCN employee invitation storage requires a valid email domain."
    );
  }
  return domain;
}

function normalizeNewInvitation(
  value,
  { allowedDomain, timestamp, randomBytes, tokenKey }
) {
  assertPlainObject(value, "invitation");
  const expectedKeys = [
    "displayName",
    "email",
    "expiresAt",
    "invitedByRef",
    "jobNimbusOwnerId",
    "jobNimbusScope",
    "role"
  ];
  assertExactKeys(value, expectedKeys, "invitation");
  const invitedAt = iso(timestamp);
  const expiresAt = normalizeInstant(value.expiresAt);
  const lifetime = Date.parse(expiresAt) - timestamp;
  if (
    lifetime < MIN_INVITATION_TTL_MS
    || lifetime > MAX_INVITATION_TTL_MS
  ) {
    throw storeError(
      "invalid_invitation",
      "The HCN employee invitation expiration is outside the allowed range.",
      400
    );
  }
  const invitationRef = createInvitationRef(randomBytes);
  const inviteToken = createInviteToken(randomBytes);
  const record = {
    invitationRef,
    email: normalizeEmail(value.email, allowedDomain),
    displayName: normalizeDisplayName(value.displayName),
    role: normalizeRole(value.role),
    jobNimbusOwnerId: normalizeProviderId(value.jobNimbusOwnerId),
    jobNimbusScope: normalizeAssignedScope(value.jobNimbusScope),
    invitedByRef: normalizePrincipalRef(value.invitedByRef),
    state: "pending",
    invitedAt,
    expiresAt,
    inviteTokenHash: inviteTokenDigest(
      tokenKey,
      invitationRef,
      inviteToken
    ),
    googleSubject: "",
    acceptedAt: "",
    revokedByRef: "",
    revokedAt: ""
  };
  Object.defineProperty(record, PRIVATE_INVITE_TOKEN, {
    value: inviteToken,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(record);
}

function normalizeAcceptance(value, allowedDomain) {
  assertPlainObject(value, "invitation acceptance");
  assertExactKeys(
    value,
    [
      "email",
      "googleSubject",
      "invitationRef",
      "inviteToken"
    ],
    "invitation acceptance"
  );
  const googleSubject = String(value.googleSubject || "").trim();
  if (!GOOGLE_SUBJECT_PATTERN.test(googleSubject)) {
    throw storeError(
      "invalid_invitation_acceptance",
      "The Google identity is invalid.",
      400
    );
  }
  return Object.freeze({
    invitationRef: normalizeInvitationRef(value.invitationRef),
    email: normalizeEmail(value.email, allowedDomain),
    googleSubject,
    inviteToken: normalizeInviteToken(value.inviteToken)
  });
}

function normalizeRevocation(value) {
  assertPlainObject(value, "invitation revocation");
  assertExactKeys(
    value,
    ["invitationRef", "revokedByRef"],
    "invitation revocation"
  );
  return Object.freeze({
    invitationRef: normalizeInvitationRef(value.invitationRef),
    revokedByRef: normalizePrincipalRef(value.revokedByRef)
  });
}

function normalizeStoredRecord(value, allowedDomain) {
  assertPlainObject(value, "stored invitation", true);
  const expectedKeys = [
    "acceptedAt",
    "displayName",
    "email",
    "expiresAt",
    "googleSubject",
    "invitationRef",
    "invitedAt",
    "invitedByRef",
    "inviteTokenHash",
    "jobNimbusOwnerId",
    "jobNimbusScope",
    "revokedAt",
    "revokedByRef",
    "role",
    "state"
  ];
  assertExactKeys(value, expectedKeys, "stored invitation", true);
  const state = String(value.state || "");
  if (!STORED_STATES.has(state)) corruptStore();
  const invitedAt = normalizeInstant(value.invitedAt, true);
  const expiresAt = normalizeInstant(value.expiresAt, true);
  const lifetime = Date.parse(expiresAt) - Date.parse(invitedAt);
  if (
    lifetime < MIN_INVITATION_TTL_MS
    || lifetime > MAX_INVITATION_TTL_MS
  ) {
    corruptStore();
  }
  const googleSubject = String(value.googleSubject || "");
  const inviteTokenHash = String(value.inviteTokenHash || "");
  const acceptedAt = String(value.acceptedAt || "");
  const revokedByRef = String(value.revokedByRef || "");
  const revokedAt = String(value.revokedAt || "");
  if (state === "pending") {
    if (googleSubject || acceptedAt || revokedByRef || revokedAt) {
      corruptStore();
    }
  } else if (state === "accepted") {
    if (
      !GOOGLE_SUBJECT_PATTERN.test(googleSubject)
      || !normalizeInstant(acceptedAt, true)
      || Date.parse(acceptedAt) < Date.parse(invitedAt)
      || revokedByRef
      || revokedAt
    ) {
      corruptStore();
    }
  } else if (
    !normalizePrincipalRef(revokedByRef, true)
    || !normalizeInstant(revokedAt, true)
    || Date.parse(revokedAt) < Date.parse(invitedAt)
  ) {
    corruptStore();
  }
  return Object.freeze({
    invitationRef: normalizeInvitationRef(value.invitationRef, true),
    email: normalizeEmail(value.email, allowedDomain, true),
    displayName: normalizeDisplayName(value.displayName, true),
    role: normalizeRole(value.role, true),
    jobNimbusOwnerId: normalizeProviderId(
      value.jobNimbusOwnerId,
      true
    ),
    jobNimbusScope: normalizeAssignedScope(
      value.jobNimbusScope,
      true
    ),
    invitedByRef: normalizePrincipalRef(value.invitedByRef, true),
    state,
    invitedAt,
    expiresAt,
    inviteTokenHash:
      /^[a-f0-9]{64}$/.test(inviteTokenHash)
        ? inviteTokenHash
        : corruptStore(),
    googleSubject,
    acceptedAt,
    revokedByRef,
    revokedAt
  });
}

async function readVerifiedRecords({
  filePath,
  encryptionKey,
  allowedDomain,
  randomBytes: _randomBytes
}) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw unavailableStore();
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size > MAX_STORE_BYTES
  ) {
    throw corruptStore();
  }
  let envelope;
  try {
    envelope = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw corruptStore();
  }
  if (
    !envelope
    || typeof envelope !== "object"
    || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(",")
      !== "ciphertext,iv,schemaVersion,tag"
    || envelope.schemaVersion !== ENVELOPE_VERSION
  ) {
    throw corruptStore();
  }
  let iv;
  let tag;
  let ciphertext;
  let plaintext;
  let payload;
  try {
    iv = decodeCanonicalBase64url(envelope.iv);
    tag = decodeCanonicalBase64url(envelope.tag);
    ciphertext = decodeCanonicalBase64url(envelope.ciphertext);
  } catch {
    throw corruptStore();
  }
  if (
    iv.length !== IV_BYTES
    || tag.length !== TAG_BYTES
    || ciphertext.length === 0
    || ciphertext.length > MAX_STORE_BYTES
  ) {
    throw corruptStore();
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      iv
    );
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    if (
      plaintext.length === 0
      || plaintext.length > MAX_STORE_BYTES
    ) {
      throw new Error("invalid plaintext");
    }
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw corruptStore();
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || Object.keys(payload).sort().join(",")
      !== "records,schemaVersion"
    || payload.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(payload.records)
    || payload.records.length > MAX_RECORDS
  ) {
    throw corruptStore();
  }
  const records = payload.records.map((record) =>
    normalizeStoredRecord(record, allowedDomain)
  );
  const refs = records.map((record) => record.invitationRef);
  if (
    new Set(refs).size !== refs.length
    || records.some(
      (record, index) =>
        index > 0 && compareRecords(records[index - 1], record) > 0
    )
  ) {
    throw corruptStore();
  }
  const acceptedEmails = new Set();
  const historicalOwners = new Map();
  const historicalSubjects = new Map();
  for (const record of records) {
    const ownerEmail = historicalOwners.get(
      record.jobNimbusOwnerId
    );
    if (ownerEmail && ownerEmail !== record.email) {
      throw corruptStore();
    }
    historicalOwners.set(record.jobNimbusOwnerId, record.email);
    if (record.googleSubject) {
      const subjectEmail = historicalSubjects.get(
        record.googleSubject
      );
      if (subjectEmail && subjectEmail !== record.email) {
        throw corruptStore();
      }
      historicalSubjects.set(record.googleSubject, record.email);
    }
    if (record.state !== "accepted") continue;
    if (
      acceptedEmails.has(record.email)
    ) {
      throw corruptStore();
    }
    acceptedEmails.add(record.email);
  }
  return records;
}

async function writeVerifiedRecords({
  filePath,
  encryptionKey,
  records,
  randomBytes
}) {
  const plaintext = Buffer.from(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      records
    }),
    "utf8"
  );
  if (
    plaintext.length === 0
    || plaintext.length > MAX_STORE_BYTES
  ) {
    throw storeError(
      "store_capacity_reached",
      "The HCN employee invitation store exceeds its safe size.",
      409
    );
  }
  let iv;
  try {
    iv = Buffer.from(randomBytes(IV_BYTES));
  } catch {
    throw unavailableStore();
  }
  if (iv.length !== IV_BYTES) throw unavailableStore();
  let ciphertext;
  let tag;
  try {
    const cipher = createCipheriv(
      "aes-256-gcm",
      encryptionKey,
      iv
    );
    cipher.setAAD(ENVELOPE_AAD);
    ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    tag = cipher.getAuthTag();
  } catch {
    throw unavailableStore();
  }
  const envelope = {
    schemaVersion: ENVELOPE_VERSION,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
  const output = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_STORE_BYTES) {
    throw storeError(
      "store_capacity_reached",
      "The HCN employee invitation store exceeds its safe size.",
      409
    );
  }
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath =
    `${filePath}.tmp-${randomUUID().replaceAll("-", "")}`;
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(output, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const metadata = await lstat(temporaryPath);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.size !== Buffer.byteLength(output, "utf8")
    ) {
      throw corruptStore();
    }
    await rename(temporaryPath, filePath);
    renamed = true;
  } catch (error) {
    if (
      error?.code === "invitation_store_corrupt"
      || error?.code === "store_capacity_reached"
    ) {
      throw error;
    }
    throw unavailableStore();
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

function decodeCanonicalBase64url(value) {
  const encoded = String(value || "");
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("invalid base64url");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new Error("non-canonical base64url");
  }
  return decoded;
}

function effectiveState(record, timestamp) {
  return record.state === "pending"
    && Date.parse(record.expiresAt) <= timestamp
      ? "expired"
      : record.state;
}

function copyRecord(record, timestamp) {
  return Object.freeze({
    ...record,
    state: effectiveState(record, timestamp)
  });
}

function compareRecords(left, right) {
  const byTime = left.invitedAt.localeCompare(right.invitedAt);
  return byTime || left.invitationRef.localeCompare(right.invitationRef);
}

function createInvitationRef(randomBytes) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = Buffer.from(randomBytes(16));
    if (bytes.length === 16) return `invite_${bytes.toString("hex")}`;
  }
  throw storeError(
    "randomness_unavailable",
    "A secure HCN invitation reference could not be created.",
    503
  );
}

const PRIVATE_INVITE_TOKEN = Symbol("privateInviteToken");

function createInviteToken(randomBytes) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = Buffer.from(randomBytes(32));
    if (bytes.length === 32) return bytes.toString("base64url");
  }
  throw storeError(
    "randomness_unavailable",
    "A secure HCN invitation token could not be created.",
    503
  );
}

function normalizeInviteToken(value) {
  const token = String(value || "").trim();
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    throw storeError(
      "invalid_invitation_token",
      "The HCN invitation token is invalid.",
      400
    );
  }
  return token;
}

function inviteTokenDigest(tokenKey, invitationRef, token) {
  return createHmac("sha256", tokenKey)
    .update("hcn-employee-invite-token:v1", "utf8")
    .update("\0", "utf8")
    .update(invitationRef, "utf8")
    .update("\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

function normalizeInvitationRef(value, corrupt = false) {
  const ref = String(value || "").trim();
  if (!INVITATION_REF_PATTERN.test(ref)) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "The HCN invitation reference is invalid.",
      400
    );
  }
  return ref;
}

function normalizeEmail(value, allowedDomain, corrupt = false) {
  const input = String(value || "");
  const email = input.trim().toLowerCase();
  const domain = email.split("@").at(-1);
  if (
    input !== email
    || email.length > 320
    || !/^[^\s@]+@[^\s@]+$/.test(email)
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
    || (allowedDomain && domain !== allowedDomain)
  ) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "The HCN employee email is invalid.",
      400
    );
  }
  return email;
}

function normalizeDisplayName(value, corrupt = false) {
  const displayName = String(value || "").trim();
  if (
    !displayName
    || displayName.length > 256
    || /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "The HCN employee display name is invalid.",
      400
    );
  }
  return displayName;
}

function normalizeRole(value, corrupt = false) {
  const role = String(value || "").trim().toLowerCase();
  if (!INVITABLE_ROLES.has(role)) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "The HCN employee role is not invitable.",
      400
    );
  }
  return role;
}

function normalizeProviderId(value, corrupt = false) {
  const providerId = String(value || "").trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "The JobNimbus employee identifier is invalid.",
      400
    );
  }
  return providerId;
}

function normalizeAssignedScope(value, corrupt = false) {
  const scope = String(value || "").trim().toLowerCase();
  if (scope !== "assigned") {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "HCN employee invitations must use assigned-file scope.",
      400
    );
  }
  return scope;
}

function normalizePrincipalRef(value, corrupt = false) {
  const reference = String(value || "").trim();
  if (!PRINCIPAL_REF_PATTERN.test(reference)) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "The HCN invitation actor reference is invalid.",
      400
    );
  }
  return reference;
}

function normalizeInstant(value, corrupt = false) {
  const instant = String(value || "");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant)
    || !Number.isFinite(Date.parse(instant))
  ) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      "The HCN invitation timestamp is invalid.",
      400
    );
  }
  return instant;
}

function readNow(now) {
  const timestamp = Number(now());
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(
      "HCN employee invitation storage requires a valid clock."
    );
  }
  return timestamp;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function assertPlainObject(value, label, corrupt = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      `The HCN ${label} is invalid.`,
      400
    );
  }
}

function assertExactKeys(value, expected, label, corrupt = false) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    keys.length !== allowed.length
    || keys.some((key, index) => key !== allowed[index])
  ) {
    if (corrupt) corruptStore();
    throw storeError(
      "invalid_invitation",
      `The HCN ${label} contains unsupported fields.`,
      400
    );
  }
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function.`);
  }
}

function corruptStore() {
  throw storeError(
    "invitation_store_corrupt",
    "The HCN employee invitation store could not be authenticated.",
    503
  );
}

function unavailableStore() {
  return storeError(
    "invitation_store_unavailable",
    "The HCN employee invitation store is unavailable.",
    503
  );
}

function storeError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
