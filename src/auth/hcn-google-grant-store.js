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
import { constants as filesystemConstants } from "node:fs";
import path from "node:path";

const STORE_SCHEMA = "hcn.google.connector.grants";
const STATUS_SCHEMA = "hcn.google.connector.grant-status";
const SCHEMA_VERSION = "1.0.0";
const ENVELOPE_SCHEMA = "hcn.google.connector.grants.encrypted";
const ENVELOPE_VERSION = "1.0.0";
const ENVELOPE_ALGORITHM = "A256GCM";
const ENVELOPE_KEY_DERIVATION = "HKDF-SHA256";
const KEY_DERIVATION_SALT = Buffer.from(
  "hcn-google-grant-store:hkdf-salt:v1",
  "utf8"
);
const KEY_DERIVATION_INFO = Buffer.from(
  "hcn-google-grant-store:aes-256-gcm-key:v1",
  "utf8"
);
const ENVELOPE_AAD = Buffer.from(
  JSON.stringify({
    schema: ENVELOPE_SCHEMA,
    schemaVersion: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    keyDerivation: ENVELOPE_KEY_DERIVATION,
    purpose: "hcn-google-connector-grants"
  }),
  "utf8"
);
const PRINCIPAL_REF_PATTERN = /^principal_[a-f0-9]{32}$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const SCOPE_PATTERN = /^[A-Za-z][A-Za-z0-9._:/-]{0,255}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const MIN_MASTER_KEY_BYTES = 32;
const MAX_MASTER_KEY_BYTES = 128;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_SCOPES = 32;
const DEFAULT_MAX_RECORDS = 512;
const HARD_MAX_RECORDS = 4096;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const TEMPORARY_NAME_ATTEMPTS = 4;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Create a standalone encrypted Google connector grant store.
 *
 * `encryptionKey` must come from a dedicated HCN connector secret such as
 * HCN_GOOGLE_GRANT_KEY. It must never reuse OAUTH_SESSION_SECRET, a provider
 * credential, a Chance Brain key, or a Jobrolo key.
 *
 * The returned store exposes exactly four operations:
 * - get({ principalRef }) -> an active private grant or null
 * - upsert({ principalRef, refreshToken, scopes, accessToken?, accessExpiresAt? })
 * - revoke({ principalRef })
 * - status({ principalRef })
 *
 * Private tokens on a `get` result are non-enumerable. JSON serialization of
 * that result yields only the public status projection.
 */
export function createHcnGoogleGrantStore({
  filePath,
  encryptionKey,
  now = Date.now,
  randomBytes = cryptographicRandomBytes,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES
} = {}) {
  const configuredPath = normalizeStorePath(filePath);
  const derivedKey = deriveEncryptionKey(encryptionKey);
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");
  assertBoundedInteger(
    maxRecords,
    1,
    HARD_MAX_RECORDS,
    "maxRecords"
  );
  assertBoundedInteger(
    maxFileBytes,
    1024,
    HARD_MAX_FILE_BYTES,
    "maxFileBytes"
  );

  let mutationQueue = Promise.resolve();

  async function get(input) {
    const principalRef = validatePrincipalInput(input);
    const document = await readEncryptedDocument({
      filePath: configuredPath,
      key: derivedKey,
      maxRecords,
      maxFileBytes
    });
    const record = findRecord(document, principalRef);
    if (!record || record.state !== "active") return null;
    return privateGrant(record, readNow(now));
  }

  async function status(input) {
    const principalRef = validatePrincipalInput(input);
    const document = await readEncryptedDocument({
      filePath: configuredPath,
      key: derivedKey,
      maxRecords,
      maxFileBytes
    });
    return publicStatus(
      findRecord(document, principalRef),
      principalRef,
      readNow(now)
    );
  }

  async function upsert(input) {
    const normalized = validateUpsertInput(input);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await readEncryptedDocument({
        filePath: configuredPath,
        key: derivedKey,
        maxRecords,
        maxFileBytes
      });
      const existingIndex = document.records.findIndex(
        (record) => record.principalRef === normalized.principalRef
      );
      if (
        existingIndex === -1
        && document.records.length >= maxRecords
      ) {
        throw storeError(
          "capacity_exceeded",
          "The Google connector grant store is at capacity.",
          409
        );
      }

      const instant = iso(timestamp);
      const record = {
        principalRef: normalized.principalRef,
        state: "active",
        scopes: normalized.scopes,
        createdAt:
          existingIndex === -1
            ? instant
            : document.records[existingIndex].createdAt,
        updatedAt: instant,
        revokedAt: "",
        refreshToken: normalized.refreshToken,
        accessToken: normalized.accessToken,
        accessExpiresAt: normalized.accessExpiresAt
      };
      if (existingIndex === -1) {
        document.records.push(record);
      } else {
        document.records[existingIndex] = record;
      }
      document.records.sort((left, right) =>
        left.principalRef.localeCompare(right.principalRef)
      );
      await writeEncryptedDocument({
        filePath: configuredPath,
        key: derivedKey,
        document,
        randomBytes,
        maxRecords,
        maxFileBytes
      });
      return publicStatus(record, normalized.principalRef, timestamp);
    });
  }

  async function revoke(input) {
    const principalRef = validatePrincipalInput(input);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await readEncryptedDocument({
        filePath: configuredPath,
        key: derivedKey,
        maxRecords,
        maxFileBytes
      });
      const index = document.records.findIndex(
        (record) => record.principalRef === principalRef
      );
      if (index === -1) {
        return publicStatus(null, principalRef, timestamp);
      }
      if (document.records[index].state === "revoked") {
        return publicStatus(
          document.records[index],
          principalRef,
          timestamp
        );
      }

      const instant = iso(timestamp);
      const record = {
        ...document.records[index],
        state: "revoked",
        updatedAt: instant,
        revokedAt: instant,
        refreshToken: "",
        accessToken: "",
        accessExpiresAt: ""
      };
      document.records[index] = record;
      await writeEncryptedDocument({
        filePath: configuredPath,
        key: derivedKey,
        document,
        randomBytes,
        maxRecords,
        maxFileBytes
      });
      return publicStatus(record, principalRef, timestamp);
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
    get,
    upsert,
    revoke,
    status
  });
}

export class HcnGoogleGrantStoreError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "HcnGoogleGrantStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validatePrincipalInput(value) {
  exactRecord(value, ["principalRef"], [], "grant lookup");
  return principalRef(value.principalRef);
}

function validateUpsertInput(value) {
  exactRecord(
    value,
    ["principalRef", "refreshToken", "scopes"],
    ["accessToken", "accessExpiresAt"],
    "grant upsert"
  );
  const hasAccessToken = Object.hasOwn(value, "accessToken");
  const hasAccessExpiry = Object.hasOwn(value, "accessExpiresAt");
  if (hasAccessToken !== hasAccessExpiry) {
    invalidInput(
      "accessToken and accessExpiresAt must be supplied together."
    );
  }
  return Object.freeze({
    principalRef: principalRef(value.principalRef),
    refreshToken: credential(value.refreshToken, "refreshToken"),
    scopes: normalizeScopes(value.scopes),
    accessToken: hasAccessToken
      ? credential(value.accessToken, "accessToken")
      : "",
    accessExpiresAt: hasAccessExpiry
      ? canonicalInstant(value.accessExpiresAt, "accessExpiresAt")
      : ""
  });
}

function normalizeScopes(value) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_SCOPES
  ) {
    invalidInput(`scopes must contain 1-${MAX_SCOPES} values.`);
  }
  const scopes = value.map((scope) => {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      invalidInput("Each Google scope must be a bounded canonical value.");
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) {
    invalidInput("Google scopes must be unique.");
  }
  return Object.freeze([...scopes].sort());
}

function privateGrant(record, timestamp) {
  const result = {
    schema: STORE_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    provider: "google",
    principalRef: record.principalRef,
    state: "active",
    scopes: Object.freeze([...record.scopes]),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    accessExpiresAt: record.accessExpiresAt
  };
  defineSensitive(result, "refreshToken", record.refreshToken);
  defineSensitive(result, "accessToken", record.accessToken);
  Object.defineProperty(result, "toJSON", {
    value() {
      return publicStatus(record, record.principalRef, timestamp);
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(result);
}

function publicStatus(record, principalReference, timestamp) {
  const state = record?.state === "active"
    ? "linked"
    : record?.state === "revoked"
      ? "revoked"
      : "not_linked";
  let accessCredential = "not_cached";
  if (record?.state === "active" && record.accessToken) {
    accessCredential =
      Date.parse(record.accessExpiresAt) > timestamp
        ? "fresh"
        : "expired";
  }
  return Object.freeze({
    schema: STATUS_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    provider: "google",
    principalRef: principalReference,
    state,
    scopes: Object.freeze(record ? [...record.scopes] : []),
    hasRefreshGrant:
      record?.state === "active" && Boolean(record.refreshToken),
    accessCredential,
    createdAt: record?.createdAt || "",
    updatedAt: record?.updatedAt || "",
    revokedAt: record?.revokedAt || ""
  });
}

function findRecord(document, principalReference) {
  return document.records.find(
    (record) => record.principalRef === principalReference
  ) || null;
}

async function readEncryptedDocument({
  filePath,
  key,
  maxRecords,
  maxFileBytes
}) {
  const parentState = await inspectParentDirectory(
    path.dirname(filePath),
    false
  );
  if (parentState === "missing") return emptyDocument();

  const metadata = await safeLstat(filePath);
  if (!metadata) return emptyDocument();
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    unsafePath(
      "The Google connector grant path is not a regular private file."
    );
  }
  if (metadata.size < 1 || metadata.size > maxFileBytes) {
    corruptStore(
      "The Google connector grant file has an invalid size."
    );
  }
  await assertCanonicalRealPath(filePath);

  let handle;
  try {
    const noFollow = Number(filesystemConstants.O_NOFOLLOW || 0);
    handle = await open(
      filePath,
      Number(filesystemConstants.O_RDONLY) | noFollow
    );
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size < 1
      || opened.size > maxFileBytes
    ) {
      corruptStore(
        "The Google connector grant file changed to an invalid object."
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length < 1 || bytes.length > maxFileBytes) {
      corruptStore(
        "The Google connector grant file has an invalid size."
      );
    }
    return decryptDocument(bytes, key, maxRecords);
  } catch (error) {
    if (error instanceof HcnGoogleGrantStoreError) throw error;
    corruptStore("The Google connector grant file could not be read.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeEncryptedDocument({
  filePath,
  key,
  document,
  randomBytes,
  maxRecords,
  maxFileBytes
}) {
  validateDocument(document, maxRecords);
  const parent = path.dirname(filePath);
  await inspectParentDirectory(parent, true);
  const existing = await safeLstat(filePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    unsafePath(
      "The Google connector grant path is not a regular private file."
    );
  }
  if (existing) await assertCanonicalRealPath(filePath);

  const output = encryptDocument(document, key, randomBytes);
  if (output.length > maxFileBytes) {
    throw storeError(
      "store_oversize",
      "The encrypted Google connector grant store exceeds its size limit.",
      409
    );
  }

  let temporaryPath = "";
  let handle;
  let renamed = false;
  try {
    temporaryPath = await uniqueTemporaryPath(
      filePath,
      randomBytes
    );
    handle = await open(
      temporaryPath,
      Number(filesystemConstants.O_WRONLY)
        | Number(filesystemConstants.O_CREAT)
        | Number(filesystemConstants.O_EXCL),
      PRIVATE_FILE_MODE
    );
    await handle.writeFile(output);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;

    const temporaryMetadata = await lstat(temporaryPath);
    if (
      temporaryMetadata.isSymbolicLink()
      || !temporaryMetadata.isFile()
    ) {
      unsafePath(
        "The temporary Google connector grant path is unsafe."
      );
    }
    await rename(temporaryPath, filePath);
    renamed = true;
    await chmod(filePath, PRIVATE_FILE_MODE);
    const finalMetadata = await lstat(filePath);
    if (
      finalMetadata.isSymbolicLink()
      || !finalMetadata.isFile()
      || finalMetadata.size !== output.length
    ) {
      unsafePath(
        "The Google connector grant file was not written safely."
      );
    }
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof HcnGoogleGrantStoreError) throw error;
    throw storeError(
      "store_write_failed",
      "The Google connector grant store could not be written.",
      503
    );
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryPath && !renamed) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

function encryptDocument(document, key, randomBytes) {
  const nonce = secureRandomBytes(randomBytes, NONCE_BYTES, "nonce");
  const plaintext = Buffer.from(JSON.stringify(document), "utf8");
  try {
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      nonce,
      { authTagLength: AUTH_TAG_BYTES }
    );
    cipher.setAAD(ENVELOPE_AAD, {
      plaintextLength: plaintext.length
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    const envelope = {
      schema: ENVELOPE_SCHEMA,
      schemaVersion: ENVELOPE_VERSION,
      algorithm: ENVELOPE_ALGORITHM,
      keyDerivation: ENVELOPE_KEY_DERIVATION,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url")
    };
    return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  } finally {
    plaintext.fill(0);
  }
}

function decryptDocument(bytes, key, maxRecords) {
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    corruptStore("The Google connector grant envelope is invalid.");
  }
  exactEncryptedEnvelope(envelope);
  const nonce = canonicalBase64UrlBytes(
    envelope.nonce,
    "nonce",
    NONCE_BYTES
  );
  const tag = canonicalBase64UrlBytes(
    envelope.tag,
    "tag",
    AUTH_TAG_BYTES
  );
  const ciphertext = canonicalBase64UrlBytes(
    envelope.ciphertext,
    "ciphertext"
  );
  if (ciphertext.length < 1) {
    corruptStore("The Google connector grant ciphertext is empty.");
  }

  let plaintext;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      nonce,
      { authTagLength: AUTH_TAG_BYTES }
    );
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    const document = JSON.parse(plaintext.toString("utf8"));
    validateDocument(document, maxRecords);
    return document;
  } catch (error) {
    if (error instanceof HcnGoogleGrantStoreError) throw error;
    corruptStore(
      "The Google connector grant ciphertext could not be authenticated."
    );
  } finally {
    plaintext?.fill(0);
  }
}

function validateDocument(value, maxRecords) {
  exactPersistedRecord(
    value,
    ["schema", "schemaVersion", "records"],
    "grant document"
  );
  if (
    value.schema !== STORE_SCHEMA
    || value.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(value.records)
    || value.records.length > maxRecords
  ) {
    corruptStore("The Google connector grant document is invalid.");
  }

  const seen = new Set();
  for (const record of value.records) {
    validateStoredGrant(record);
    if (seen.has(record.principalRef)) {
      corruptStore(
        "The Google connector grant document contains duplicate principals."
      );
    }
    seen.add(record.principalRef);
  }
}

function validateStoredGrant(value) {
  exactPersistedRecord(
    value,
    [
      "principalRef",
      "state",
      "scopes",
      "createdAt",
      "updatedAt",
      "revokedAt",
      "refreshToken",
      "accessToken",
      "accessExpiresAt"
    ],
    "grant record"
  );
  principalRef(value.principalRef, true);
  if (value.state !== "active" && value.state !== "revoked") {
    corruptStore("The Google connector grant state is invalid.");
  }
  const normalizedScopes = normalizeStoredScopes(value.scopes);
  if (
    normalizedScopes.some(
      (scope, index) => scope !== value.scopes[index]
    )
  ) {
    corruptStore("Stored Google scopes are not canonical.");
  }
  canonicalInstant(value.createdAt, "createdAt", true);
  canonicalInstant(value.updatedAt, "updatedAt", true);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    corruptStore("The Google connector grant timestamps are invalid.");
  }

  if (value.state === "active") {
    if (value.revokedAt !== "") {
      corruptStore("An active Google connector grant cannot be revoked.");
    }
    credential(value.refreshToken, "refreshToken", true);
    const hasAccessToken = value.accessToken !== "";
    const hasAccessExpiry = value.accessExpiresAt !== "";
    if (hasAccessToken !== hasAccessExpiry) {
      corruptStore(
        "The cached Google access credential is incomplete."
      );
    }
    if (hasAccessToken) {
      credential(value.accessToken, "accessToken", true);
      canonicalInstant(
        value.accessExpiresAt,
        "accessExpiresAt",
        true
      );
    }
  } else {
    canonicalInstant(value.revokedAt, "revokedAt", true);
    if (
      Date.parse(value.revokedAt) < Date.parse(value.createdAt)
      || value.refreshToken !== ""
      || value.accessToken !== ""
      || value.accessExpiresAt !== ""
    ) {
      corruptStore("A revoked Google connector grant is invalid.");
    }
  }
}

function normalizeStoredScopes(value) {
  try {
    return normalizeScopes(value);
  } catch {
    corruptStore("Stored Google scopes are invalid.");
  }
}

function exactEncryptedEnvelope(value) {
  exactPersistedRecord(
    value,
    [
      "schema",
      "schemaVersion",
      "algorithm",
      "keyDerivation",
      "nonce",
      "ciphertext",
      "tag"
    ],
    "encrypted envelope"
  );
  if (
    value.schema !== ENVELOPE_SCHEMA
    || value.schemaVersion !== ENVELOPE_VERSION
    || value.algorithm !== ENVELOPE_ALGORITHM
    || value.keyDerivation !== ENVELOPE_KEY_DERIVATION
  ) {
    corruptStore("The Google connector grant envelope is unsupported.");
  }
}

function emptyDocument() {
  return {
    schema: STORE_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    records: []
  };
}

function deriveEncryptionKey(value) {
  const master = canonicalEncryptionKey(value);
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        master,
        KEY_DERIVATION_SALT,
        KEY_DERIVATION_INFO,
        DERIVED_KEY_BYTES
      )
    );
  } finally {
    master.fill(0);
  }
}

function canonicalEncryptionKey(value) {
  if (
    typeof value !== "string"
    || !CANONICAL_BASE64URL_PATTERN.test(value)
  ) {
    throw storeError(
      "invalid_configuration",
      "The dedicated HCN Google grant key must be canonical base64url.",
      500
    );
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (
    bytes.length < MIN_MASTER_KEY_BYTES
    || bytes.length > MAX_MASTER_KEY_BYTES
    || bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    throw storeError(
      "invalid_configuration",
      "The dedicated HCN Google grant key must encode 32-128 bytes.",
      500
    );
  }
  return bytes;
}

function canonicalBase64UrlBytes(value, label, exactBytes = null) {
  if (
    typeof value !== "string"
    || !CANONICAL_BASE64URL_PATTERN.test(value)
  ) {
    corruptStore(`The encrypted ${label} is invalid.`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (
    bytes.toString("base64url") !== value
    || (
      exactBytes !== null
      && bytes.length !== exactBytes
    )
  ) {
    corruptStore(`The encrypted ${label} is invalid.`);
  }
  return bytes;
}

async function inspectParentDirectory(directory, create) {
  let metadata = await safeLstat(directory);
  if (!metadata && create) {
    try {
      await mkdir(directory, {
        recursive: true,
        mode: 0o700
      });
    } catch {
      unsafePath(
        "The Google connector grant directory could not be created."
      );
    }
    metadata = await safeLstat(directory);
  }
  if (!metadata) return "missing";
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    unsafePath(
      "The Google connector grant directory is not a regular directory."
    );
  }
  await assertCanonicalRealPath(directory);
  return "ready";
}

async function assertCanonicalRealPath(target) {
  let actual;
  try {
    actual = await realpath(target);
  } catch {
    unsafePath(
      "The Google connector grant path could not be resolved safely."
    );
  }
  if (canonicalPath(actual) !== canonicalPath(path.resolve(target))) {
    unsafePath(
      "Symbolic or redirected Google connector grant paths are not allowed."
    );
  }
}

function canonicalPath(value) {
  const normalized = path.normalize(String(value || ""));
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

async function safeLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    unsafePath(
      "The Google connector grant path could not be inspected safely."
    );
  }
}

async function uniqueTemporaryPath(filePath, randomBytes) {
  for (
    let attempt = 0;
    attempt < TEMPORARY_NAME_ATTEMPTS;
    attempt += 1
  ) {
    const suffix = secureRandomBytes(
      randomBytes,
      16,
      "temporary filename"
    ).toString("hex");
    const candidate = `${filePath}.tmp-${suffix}`;
    if (!(await safeLstat(candidate))) return candidate;
  }
  throw storeError(
    "store_write_failed",
    "A unique temporary Google connector grant file could not be allocated.",
    503
  );
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, Number(filesystemConstants.O_RDONLY));
    await handle.sync();
  } catch (error) {
    if (
      !["EINVAL", "EPERM", "EISDIR", "EBADF", "ENOTSUP"].includes(
        error?.code
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function secureRandomBytes(randomBytes, size, label) {
  let result;
  try {
    result = randomBytes(size);
  } catch {
    throw storeError(
      "randomness_unavailable",
      `Cryptographic ${label} generation failed.`,
      503
    );
  }
  if (
    (!Buffer.isBuffer(result) && !(result instanceof Uint8Array))
    || result.byteLength !== size
  ) {
    throw storeError(
      "randomness_unavailable",
      `Cryptographic ${label} generation returned an invalid value.`,
      503
    );
  }
  return Buffer.from(result);
}

function normalizeStorePath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw storeError(
      "invalid_configuration",
      "The Google connector grant store requires an absolute file path.",
      500
    );
  }
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) {
    throw storeError(
      "invalid_configuration",
      "The Google connector grant store path must identify a file.",
      500
    );
  }
  return resolved;
}

function credential(value, label, persisted = false) {
  if (
    typeof value !== "string"
    || value.length < 8
    || Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES
    || !TOKEN_PATTERN.test(value)
  ) {
    if (persisted) {
      corruptStore(`The stored ${label} is invalid.`);
    }
    invalidInput(`${label} must be a bounded opaque credential.`);
  }
  return value;
}

function principalRef(value, persisted = false) {
  if (
    typeof value !== "string"
    || !PRINCIPAL_REF_PATTERN.test(value)
  ) {
    if (persisted) {
      corruptStore("A stored HCN principal reference is invalid.");
    }
    invalidInput(
      "principalRef must be a stable opaque HCN principal reference."
    );
  }
  return value;
}

function canonicalInstant(value, label, persisted = false) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    if (persisted) {
      corruptStore(`The stored ${label} is invalid.`);
    }
    invalidInput(`${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function exactRecord(
  value,
  requiredKeys,
  optionalKeys,
  label
) {
  const keys = plainDataKeys(value, label, false);
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !keys.includes(key))
    || keys.some((key) => !allowed.has(key))
  ) {
    invalidInput(
      `${label} must contain only the documented exact fields.`
    );
  }
  return required;
}

function exactPersistedRecord(value, requiredKeys, label) {
  const keys = plainDataKeys(value, label, true);
  const required = new Set(requiredKeys);
  if (
    requiredKeys.some((key) => !keys.includes(key))
    || keys.some((key) => !required.has(key))
  ) {
    corruptStore(`The stored ${label} has an invalid schema.`);
  }
}

function plainDataKeys(value, label, persisted) {
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    if (persisted) corruptStore(`The stored ${label} is invalid.`);
    invalidInput(`${label} must be a plain object.`);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
  ) {
    if (persisted) corruptStore(`The stored ${label} is invalid.`);
    invalidInput(`${label} must be a plain object.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      if (persisted) corruptStore(`The stored ${label} is invalid.`);
      invalidInput(`${label} must contain plain enumerable fields.`);
    }
  }
  return keys;
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw storeError(
      "clock_unavailable",
      "The Google connector grant clock is unavailable.",
      503
    );
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (
    !Number.isSafeInteger(timestamp)
    || timestamp < 0
  ) {
    throw storeError(
      "clock_unavailable",
      "The Google connector grant clock returned an invalid value.",
      503
    );
  }
  return timestamp;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function defineSensitive(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
}

function assertBoundedInteger(value, min, max, label) {
  if (
    !Number.isSafeInteger(value)
    || value < min
    || value > max
  ) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  }
}

function invalidInput(message) {
  throw storeError("invalid_input", message, 400);
}

function corruptStore(message) {
  throw storeError("store_corrupt", message, 503);
}

function unsafePath(message) {
  throw storeError("unsafe_store_path", message, 503);
}

function storeError(code, message, statusCode) {
  return new HcnGoogleGrantStoreError(code, message, statusCode);
}
