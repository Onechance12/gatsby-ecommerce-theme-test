import {
  createHmac,
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

const SCHEMA_VERSION = "hcn.identity-pins.v1";
const MAX_STORE_BYTES = 256 * 1024;
const MAX_RECORDS = 512;
const GOOGLE_SUBJECT_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const ALLOWED_ROLES = new Set([
  "chance",
  "administrator",
  "employee",
  "onboarding",
  "client_coordinator",
  "manager"
]);
const ALLOWED_SOURCES = new Set([
  "explicit_first_use",
  "employee_auto_enroll"
]);

export function createHcnIdentityPinStore({
  filePath,
  key,
  allowedDomain = "wavepa.com",
  now = Date.now
} = {}) {
  const storePath = normalizeStorePath(filePath);
  const signingKey = deriveSigningKey(key);
  const domain = normalizeDomain(allowedDomain);
  let mutationQueue = Promise.resolve();

  async function list() {
    const records = await readVerifiedRecords({
      filePath: storePath,
      signingKey,
      allowedDomain: domain
    });
    return records.map(copyRecord);
  }

  async function get(email) {
    const normalizedEmail = normalizeEmail(email, domain);
    const records = await list();
    const match = records.find((record) => record.email === normalizedEmail);
    return match ? copyRecord(match) : null;
  }

  async function pin(candidate = {}) {
    const operation = mutationQueue.then(async () => {
      const record = normalizeRecord(candidate, {
        allowedDomain: domain,
        now
      });
      const records = await readVerifiedRecords({
        filePath: storePath,
        signingKey,
        allowedDomain: domain
      });
      const existing = records.find((entry) => entry.email === record.email);
      if (existing) {
        assertSameBinding(existing, record);
        return copyRecord(existing);
      }
      if (records.length >= MAX_RECORDS) {
        throw storeError(
          "store_capacity_reached",
          "The HCN identity pin store has reached its safe capacity."
        );
      }
      const next = [...records, record].sort((left, right) =>
        left.email.localeCompare(right.email)
      );
      await writeVerifiedRecords({
        filePath: storePath,
        signingKey,
        records: next
      });
      return copyRecord(record);
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({
    list,
    get,
    pin,
    status() {
      return Object.freeze({
        configured: true,
        schemaVersion: SCHEMA_VERSION
      });
    }
  });
}

function normalizeStorePath(value) {
  const candidate = String(value || "").trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new TypeError(
      "HCN identity pin storage requires an absolute file path."
    );
  }
  return path.resolve(candidate);
}

function deriveSigningKey(value) {
  const material = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(String(value || ""), "utf8");
  if (material.length < 32) {
    throw new TypeError(
      "HCN identity pin storage requires at least 32 bytes of key material."
    );
  }
  return createHmac("sha256", material)
    .update("hcn-identity-pin-store:authentication-key:v1", "utf8")
    .digest();
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (!domain) return "";
  if (
    domain.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
  ) {
    throw new TypeError("HCN identity pin storage requires a valid domain.");
  }
  return domain;
}

function normalizeRecord(value, { allowedDomain, now }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storeError(
      "invalid_identity_pin",
      "The HCN identity pin is invalid."
    );
  }
  const timestamp = new Date(Number(now()));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("HCN identity pin storage requires a valid clock.");
  }
  const role = String(value.role || "").trim().toLowerCase();
  const scope = String(value.jobNimbusScope || "").trim().toLowerCase();
  const source = String(value.source || "").trim().toLowerCase();
  const googleSubject = String(value.googleSubject || "").trim();
  const jobNimbusOwnerId = String(value.jobNimbusOwnerId || "").trim();
  if (!ALLOWED_ROLES.has(role)) {
    throw storeError(
      "invalid_identity_pin",
      "The HCN identity role is invalid."
    );
  }
  if (scope !== "assigned") {
    throw storeError(
      "invalid_identity_pin",
      "The HCN identity must use assigned-file scope."
    );
  }
  if (!ALLOWED_SOURCES.has(source)) {
    throw storeError(
      "invalid_identity_pin",
      "The HCN identity pin source is invalid."
    );
  }
  if (!GOOGLE_SUBJECT_PATTERN.test(googleSubject)) {
    throw storeError(
      "invalid_identity_pin",
      "The HCN Google subject is invalid."
    );
  }
  if (!PROVIDER_ID_PATTERN.test(jobNimbusOwnerId)) {
    throw storeError(
      "invalid_identity_pin",
      "The HCN JobNimbus owner is invalid."
    );
  }
  if (source === "employee_auto_enroll" && role !== "employee") {
    throw storeError(
      "invalid_identity_pin",
      "Auto-enrolled identities must use the employee role."
    );
  }
  return Object.freeze({
    email: normalizeEmail(value.email, allowedDomain),
    displayName: normalizeDisplayName(value.displayName || value.name),
    googleSubject,
    jobNimbusOwnerId,
    jobNimbusScope: scope,
    role,
    source,
    pinnedAt: timestamp.toISOString()
  });
}

function normalizeStoredRecord(value, allowedDomain) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corruptStore();
  }
  const expectedKeys = [
    "displayName",
    "email",
    "googleSubject",
    "jobNimbusOwnerId",
    "jobNimbusScope",
    "pinnedAt",
    "role",
    "source"
  ];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw corruptStore();
  }
  const pinnedAt = String(value.pinnedAt || "");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pinnedAt)
    || !Number.isFinite(Date.parse(pinnedAt))
  ) {
    throw corruptStore();
  }
  const record = normalizeRecord(
    {
      ...value,
      name: value.displayName
    },
    {
      allowedDomain,
      now: () => Date.parse(pinnedAt)
    }
  );
  return Object.freeze({
    ...record,
    pinnedAt
  });
}

function normalizeEmail(value, allowedDomain) {
  const input = String(value || "");
  const email = input.trim().toLowerCase();
  if (
    input !== email
    || email.length > 320
    || !/^[^\s@]+@[^\s@]+$/.test(email)
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(
      email.split("@").at(-1)
    )
    || (
      allowedDomain
      && email.split("@").at(-1) !== allowedDomain
    )
  ) {
    throw storeError(
      "invalid_identity_pin",
      "The HCN employee email is invalid."
    );
  }
  return email;
}

function normalizeDisplayName(value) {
  const input = String(value || "").trim();
  if (!input || input.length > 256 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw storeError(
      "invalid_identity_pin",
      "The HCN employee display name is invalid."
    );
  }
  return input;
}

function assertSameBinding(existing, candidate) {
  const protectedFields = [
    "email",
    "googleSubject",
    "jobNimbusOwnerId",
    "jobNimbusScope",
    "role",
    "source"
  ];
  if (
    protectedFields.some(
      (field) => existing[field] !== candidate[field]
    )
  ) {
    throw storeError(
      "identity_rebinding_denied",
      "This HCN identity is already pinned to different authority."
    );
  }
}

async function readVerifiedRecords({
  filePath,
  signingKey,
  allowedDomain
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
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw unavailableStore();
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw corruptStore();
  }
  if (
    !envelope
    || typeof envelope !== "object"
    || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(",") !== "mac,records,schemaVersion"
    || envelope.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(envelope.records)
    || envelope.records.length > MAX_RECORDS
    || !/^[a-f0-9]{64}$/.test(String(envelope.mac || ""))
  ) {
    throw corruptStore();
  }
  const expectedMac = authenticateRecords(signingKey, envelope.records);
  const receivedMac = Buffer.from(envelope.mac, "hex");
  if (
    receivedMac.length !== expectedMac.length
    || !timingSafeEqual(receivedMac, expectedMac)
  ) {
    throw corruptStore();
  }
  const records = envelope.records.map((record) =>
    normalizeStoredRecord(record, allowedDomain)
  );
  const emails = records.map((record) => record.email);
  if (
    new Set(emails).size !== emails.length
    || emails.some(
      (email, index) =>
        index > 0 && email.localeCompare(emails[index - 1]) < 0
    )
  ) {
    throw corruptStore();
  }
  return records;
}

async function writeVerifiedRecords({
  filePath,
  signingKey,
  records
}) {
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    records,
    mac: authenticateRecords(signingKey, records).toString("hex")
  };
  const output = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_STORE_BYTES) {
    throw storeError(
      "store_capacity_reached",
      "The HCN identity pin store exceeds its safe size."
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
    const temporaryMetadata = await lstat(temporaryPath);
    if (
      temporaryMetadata.isSymbolicLink()
      || !temporaryMetadata.isFile()
      || temporaryMetadata.size !== Buffer.byteLength(output, "utf8")
    ) {
      throw corruptStore();
    }
    await rename(temporaryPath, filePath);
    renamed = true;
  } catch (error) {
    if (error?.code === "identity_store_corrupt") throw error;
    throw unavailableStore();
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

function authenticateRecords(signingKey, records) {
  return createHmac("sha256", signingKey)
    .update(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        records
      }),
      "utf8"
    )
    .digest();
}

function copyRecord(record) {
  return Object.freeze({ ...record });
}

function corruptStore() {
  return storeError(
    "identity_store_corrupt",
    "The HCN identity pin store could not be authenticated."
  );
}

function unavailableStore() {
  return storeError(
    "identity_store_unavailable",
    "The HCN identity pin store is unavailable."
  );
}

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
