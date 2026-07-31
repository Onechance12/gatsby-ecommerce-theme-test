import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual
} from "node:crypto";

const SCHEMA_VERSION = "hcn.team.invitation-approval.v1";
const APPROVAL_ID_PATTERN =
  /^invite_approval_[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_PATTERN = /^[a-f0-9]{64}$/;
const PRINCIPAL_REF_PATTERN = /^[A-Za-z0-9._~-]{16,192}$/;
const ACTIONS = new Set(["create", "revoke"]);
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_RECORDS = 128;

/**
 * Bounded, in-memory, single-use approval gate for Chance-managed employee
 * invitations. The hidden challenge never reaches the browser.
 */
export function createHcnInvitationApprovalStore({
  now = Date.now,
  randomBytes = nodeRandomBytes,
  ttlMs = DEFAULT_TTL_MS,
  maxRecords = DEFAULT_MAX_RECORDS
} = {}) {
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");
  if (
    !Number.isSafeInteger(ttlMs)
    || ttlMs < 60_000
    || ttlMs > MAX_TTL_MS
  ) {
    throw new TypeError(
      "HCN invitation approval ttlMs must be 60000 to 600000."
    );
  }
  if (
    !Number.isSafeInteger(maxRecords)
    || maxRecords < 1
    || maxRecords > 512
  ) {
    throw new TypeError(
      "HCN invitation approval maxRecords must be 1 to 512."
    );
  }
  const records = new Map();

  function prepare({
    sessionBinding,
    actorRef,
    action,
    plan
  } = {}) {
    const timestamp = readNow(now);
    cleanup(timestamp);
    const normalizedSessionBinding =
      normalizeSessionBinding(sessionBinding);
    const normalizedActorRef = normalizePrincipalRef(actorRef);
    const normalizedAction = normalizeAction(action);
    const immutablePlan = normalizePlan(plan, normalizedAction);
    const approvalDigest = digestPlan(
      normalizedAction,
      immutablePlan
    );
    const approvalId = createApprovalId(randomBytes, records);
    const hiddenChallenge = createHiddenChallenge(randomBytes);
    const challengeMac = authenticateChallenge({
      hiddenChallenge,
      approvalId,
      approvalDigest,
      sessionBinding: normalizedSessionBinding,
      actorRef: normalizedActorRef
    });

    for (const record of records.values()) {
      if (
        record.state === "pending"
        && record.sessionBinding === normalizedSessionBinding
      ) {
        record.state = "superseded";
        record.closedAt = timestamp;
        record.hiddenChallenge.fill(0);
      }
    }
    if (records.size >= maxRecords) {
      cleanup(timestamp, true);
    }
    if (records.size >= maxRecords) {
      throw approvalError(
        "approval_capacity_reached",
        "The HCN invitation approval gate is at capacity.",
        503
      );
    }
    const expiresAt = timestamp + ttlMs;
    records.set(approvalId, {
      approvalId,
      approvalDigest,
      sessionBinding: normalizedSessionBinding,
      actorRef: normalizedActorRef,
      action: normalizedAction,
      plan: immutablePlan,
      hiddenChallenge,
      challengeMac,
      state: "pending",
      createdAt: timestamp,
      expiresAt,
      closedAt: 0
    });
    return publicApproval(records.get(approvalId));
  }

  function consume({
    sessionBinding,
    actorRef,
    action,
    approvalId,
    approvalDigest
  } = {}) {
    const timestamp = readNow(now);
    cleanup(timestamp);
    const id = normalizeApprovalId(approvalId);
    const digest = normalizeDigest(approvalDigest);
    const binding = normalizeSessionBinding(sessionBinding);
    const principalRef = normalizePrincipalRef(actorRef);
    const expectedAction = normalizeAction(action);
    const record = records.get(id);
    if (!record || record.state !== "pending") {
      throw approvalError(
        "approval_not_available",
        "This HCN invitation approval is unavailable or already used.",
        409
      );
    }

    // Consume before reporting any mismatch so an approval is one-shot even
    // after a changed payload, stale browser, or uncertain request.
    record.state = "consumed";
    record.closedAt = timestamp;
    const hiddenChallenge = Buffer.from(record.hiddenChallenge);
    record.hiddenChallenge.fill(0);
    const recomputedDigest = digestPlan(record.action, record.plan);
    const recomputedMac = authenticateChallenge({
      hiddenChallenge,
      approvalId: record.approvalId,
      approvalDigest: record.approvalDigest,
      sessionBinding: record.sessionBinding,
      actorRef: record.actorRef
    });
    hiddenChallenge.fill(0);
    const valid = (
      record.expiresAt > timestamp
      && record.sessionBinding === binding
      && record.actorRef === principalRef
      && record.action === expectedAction
      && record.approvalDigest === digest
      && record.approvalDigest === recomputedDigest
      && constantTimeHexEqual(record.challengeMac, recomputedMac)
    );
    if (!valid) {
      throw approvalError(
        "approval_changed_or_expired",
        "The HCN invitation approval changed or expired. Review a fresh dry run.",
        409
      );
    }
    return Object.freeze({
      schema: SCHEMA_VERSION,
      action: record.action,
      plan: cloneAndFreeze(record.plan),
      approvalId: record.approvalId,
      approvalDigest: record.approvalDigest
    });
  }

  function cleanup(timestamp, aggressive = false) {
    for (const [id, record] of records) {
      if (
        record.state === "pending"
        && record.expiresAt <= timestamp
      ) {
        record.state = "expired";
        record.closedAt = timestamp;
        record.hiddenChallenge.fill(0);
      }
      if (
        record.state !== "pending"
        && (
          aggressive
          || record.closedAt + ttlMs <= timestamp
        )
      ) {
        record.hiddenChallenge.fill(0);
        records.delete(id);
      }
    }
  }

  return Object.freeze({
    prepare,
    consume,
    status() {
      const timestamp = readNow(now);
      cleanup(timestamp);
      return Object.freeze({
        configured: true,
        schemaVersion: SCHEMA_VERSION,
        pendingCount: [...records.values()].filter(
          (record) => record.state === "pending"
        ).length,
        ttlMs,
        maxRecords
      });
    }
  });
}

function publicApproval(record) {
  return Object.freeze({
    schema: SCHEMA_VERSION,
    approvalId: record.approvalId,
    approvalDigest: record.approvalDigest,
    action: record.action,
    expiresAt: new Date(record.expiresAt).toISOString()
  });
}

function normalizePlan(value, action) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw approvalError(
      "invalid_approval_plan",
      "The HCN invitation approval plan is invalid.",
      400
    );
  }
  if (String(value.action || "") !== action) {
    throw approvalError(
      "invalid_approval_plan",
      "The HCN invitation approval action does not match its plan.",
      400
    );
  }
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch {
    throw approvalError(
      "invalid_approval_plan",
      "The HCN invitation approval plan is invalid.",
      400
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > 8 * 1024) {
    throw approvalError(
      "invalid_approval_plan",
      "The HCN invitation approval plan is too large.",
      400
    );
  }
  return cloneAndFreeze(JSON.parse(serialized));
}

function digestPlan(action, plan) {
  return createHash("sha256")
    .update("hcn-team-invitation-approval:v1", "utf8")
    .update("\0", "utf8")
    .update(action, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(plan), "utf8")
    .digest("hex");
}

function authenticateChallenge({
  hiddenChallenge,
  approvalId,
  approvalDigest,
  sessionBinding,
  actorRef
}) {
  return createHash("sha256")
    .update("hcn-team-invite-hidden-challenge:v1", "utf8")
    .update("\0", "utf8")
    .update(hiddenChallenge)
    .update("\0", "utf8")
    .update(approvalId, "utf8")
    .update("\0", "utf8")
    .update(approvalDigest, "utf8")
    .update("\0", "utf8")
    .update(sessionBinding, "utf8")
    .update("\0", "utf8")
    .update(actorRef, "utf8")
    .digest("hex");
}

function createApprovalId(randomBytes, records) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = secureRandomBytes(randomBytes, 16);
    const id = `invite_approval_${bytes.toString("hex")}`;
    if (!records.has(id)) return id;
  }
  throw approvalError(
    "randomness_unavailable",
    "A secure HCN invitation approval could not be created.",
    503
  );
}

function createHiddenChallenge(randomBytes) {
  return secureRandomBytes(randomBytes, 32);
}

function secureRandomBytes(randomBytes, count) {
  let bytes;
  try {
    bytes = Buffer.from(randomBytes(count));
  } catch {
    throw approvalError(
      "randomness_unavailable",
      "Secure HCN invitation approval randomness is unavailable.",
      503
    );
  }
  if (bytes.length !== count) {
    throw approvalError(
      "randomness_unavailable",
      "Secure HCN invitation approval randomness is unavailable.",
      503
    );
  }
  return bytes;
}

function normalizeApprovalId(value) {
  const id = String(value || "").trim();
  if (!APPROVAL_ID_PATTERN.test(id)) {
    throw approvalError(
      "invalid_approval",
      "The HCN invitation approval identifier is invalid.",
      400
    );
  }
  return id;
}

function normalizeDigest(value) {
  const digest = String(value || "").trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw approvalError(
      "invalid_approval",
      "The HCN invitation approval digest is invalid.",
      400
    );
  }
  return digest;
}

function normalizeSessionBinding(value) {
  const binding = String(value || "").trim();
  if (!BINDING_PATTERN.test(binding)) {
    throw approvalError(
      "invalid_approval",
      "The HCN invitation session binding is invalid.",
      400
    );
  }
  return binding;
}

function normalizePrincipalRef(value) {
  const reference = String(value || "").trim();
  if (!PRINCIPAL_REF_PATTERN.test(reference)) {
    throw approvalError(
      "invalid_approval",
      "The HCN invitation actor reference is invalid.",
      400
    );
  }
  return reference;
}

function normalizeAction(value) {
  const action = String(value || "").trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    throw approvalError(
      "invalid_approval",
      "The HCN invitation approval action is invalid.",
      400
    );
  }
  return action;
}

function canonicalJson(value) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (
    typeof value === "number"
    && Number.isFinite(value)
    && Number.isSafeInteger(value)
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (
    value
    && typeof value === "object"
    && Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      )
      .join(",")}}`;
  }
  throw new TypeError("Unsupported canonical JSON value.");
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreeze));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = cloneAndFreeze(child);
    }
    return Object.freeze(output);
  }
  return value;
}

function constantTimeHexEqual(left, right) {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readNow(now) {
  const timestamp = Number(now());
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(
      "HCN invitation approval clock is invalid."
    );
  }
  return timestamp;
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function.`);
  }
}

function approvalError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
