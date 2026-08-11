const MAX_PROVIDER_ID_BYTES = 1024;

/**
 * A successful JobNimbus create response is not proof that the requested note
 * exists on the approved file. This helper requires the returned provider id,
 * performs one caller-supplied fresh exact-record read, and accepts the result
 * only when every security-relevant field matches the approved mutation.
 */
export async function verifyCreatedJobNimbusNote({
  createResult,
  expectedFileId,
  expectedNote,
  readActivity
} = {}) {
  if (typeof expectedFileId !== "string" || !expectedFileId.trim()) {
    throw new TypeError("expectedFileId must be a non-empty string");
  }
  if (typeof expectedNote !== "string" || !expectedNote.length) {
    throw new TypeError("expectedNote must be a non-empty string");
  }
  if (typeof readActivity !== "function") {
    throw new TypeError("readActivity must be a function");
  }

  const providerRecordId = exactCreatedRecordId(createResult);
  let record;
  try {
    record = await readActivity(providerRecordId);
  } catch {
    throw verificationFailure(
      "readback_unavailable",
      "The created JobNimbus note could not be confirmed by a fresh read."
    );
  }

  assertExactReadbackRecordId(record, providerRecordId);
  assertExactNoteType(record);
  assertExactPrimaryFile(record, expectedFileId);
  if (typeof record.note !== "string" || record.note !== expectedNote) {
    throw verificationFailure(
      "note_material_mismatch",
      "The fresh JobNimbus note did not match the approved text."
    );
  }

  return Object.freeze({ providerRecordId, record });
}

export class JobNimbusNoteCreateVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JobNimbusNoteCreateVerificationError";
    this.code = code;
    this.statusCode = 409;
    this.automaticRetry = false;
    this.outcome = "reconciliation_required";
  }
}

function exactCreatedRecordId(value) {
  const candidates = providerIds([
    value?.jnid,
    value?.id,
    value?.data?.jnid,
    value?.data?.id,
    value?.activity?.jnid,
    value?.activity?.id,
    value?.note?.jnid,
    value?.note?.id
  ]);
  if (candidates.length !== 1) {
    throw verificationFailure(
      "missing_created_record_id",
      "JobNimbus did not return one exact created-note identifier."
    );
  }
  return candidates[0];
}

function assertExactReadbackRecordId(record, providerRecordId) {
  if (!isPlainRecord(record)) {
    throw verificationFailure(
      "malformed_note_readback",
      "The fresh JobNimbus note readback was malformed."
    );
  }
  const candidates = providerIds([record.jnid, record.id]);
  if (candidates.length !== 1 || candidates[0] !== providerRecordId) {
    throw verificationFailure(
      "created_record_id_mismatch",
      "The fresh JobNimbus note did not match the created record."
    );
  }
}

function assertExactNoteType(record) {
  const types = [
    record.record_type_name,
    record.type_name,
    record.type
  ].filter((value) => value !== undefined && value !== null && value !== "");
  if (
    types.length === 0
    || types.some((value) => String(value).trim().toLowerCase() !== "note")
  ) {
    throw verificationFailure(
      "created_record_type_mismatch",
      "The fresh JobNimbus activity was not the approved Note record type."
    );
  }
}

function assertExactPrimaryFile(record, expectedFileId) {
  const primaryIds = relationIds(record.primary);
  if (
    primaryIds.length === 0
    || primaryIds.some((value) => value !== expectedFileId)
  ) {
    throw verificationFailure(
      "created_record_file_mismatch",
      "The fresh JobNimbus note was not related to the approved file."
    );
  }
}

function relationIds(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(relationIds);
  if (typeof value === "string" || typeof value === "number") {
    const identifier = providerId(value);
    return identifier ? [identifier] : [];
  }
  if (!isPlainRecord(value)) return [];
  return providerIds([value.jnid, value.id]);
}

function providerIds(values) {
  return [...new Set(values.map(providerId).filter(Boolean))];
}

function providerId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string" || value.trim() !== value || !value) {
    return "";
  }
  if (
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ID_BYTES
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    return "";
  }
  return value;
}

function isPlainRecord(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function verificationFailure(code, message) {
  return new JobNimbusNoteCreateVerificationError(code, message);
}
