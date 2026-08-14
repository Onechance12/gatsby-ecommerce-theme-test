const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_PAGES = 101;
const USER_ID_FIELDS = Object.freeze([
  "jnid",
  "id",
  "user_id",
  "userId"
]);
const USER_LIST_FIELDS = Object.freeze([
  "users",
  "user",
  "results",
  "data",
  "items"
]);

/**
 * Read the complete JobNimbus employee directory without assuming that a
 * short page means EOF. Completion must be proven by an authoritative total
 * or by an empty page at the next actual offset.
 */
export async function loadCompleteJobNimbusUsers({
  fetchPage,
  pageSize = DEFAULT_PAGE_SIZE,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxPages = DEFAULT_MAX_PAGES
} = {}) {
  if (typeof fetchPage !== "function") {
    throw new TypeError("fetchPage must be a function");
  }
  assertPositiveInteger(pageSize, "pageSize");
  assertPositiveInteger(maxRecords, "maxRecords");
  assertPositiveInteger(maxPages, "maxPages");

  const users = [];
  const seenIds = new Set();
  let offset = 0;
  let expectedTotal = null;

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchPage(
      Object.freeze({ offset, size: pageSize })
    );
    const batch = userRows(payload);
    if (batch.length > pageSize) {
      throw directoryError(
        "JobNimbus employee page exceeded the requested size."
      );
    }
    const payloadTotal = authoritativeTotal(payload);
    if (
      payloadTotal !== null
      && expectedTotal !== null
      && payloadTotal !== expectedTotal
    ) {
      throw directoryError(
        "JobNimbus employee total changed during pagination."
      );
    }
    if (payloadTotal !== null) expectedTotal = payloadTotal;
    if (
      expectedTotal !== null
      && expectedTotal > maxRecords
    ) {
      throw directoryError(
        "JobNimbus employee directory exceeds its reviewed bound."
      );
    }

    for (const row of batch) {
      const id = userRecordId(row);
      if (!id || seenIds.has(id)) {
        throw directoryError(
          "JobNimbus employee pagination repeated or omitted a stable user id."
        );
      }
      seenIds.add(id);
      users.push(row);
    }
    if (users.length > maxRecords) {
      throw directoryError(
        "JobNimbus employee directory exceeds its reviewed bound."
      );
    }

    offset += batch.length;
    if (expectedTotal !== null) {
      if (offset > expectedTotal) {
        throw directoryError(
          "JobNimbus employee pagination exceeded its reported total."
        );
      }
      if (offset === expectedTotal) {
        return Object.freeze([...users]);
      }
      if (batch.length === 0) {
        throw directoryError(
          "JobNimbus employee pagination ended before its reported total."
        );
      }
    } else if (batch.length === 0) {
      return Object.freeze([...users]);
    }
  }

  throw directoryError(
    "JobNimbus employee pagination completeness could not be proven."
  );
}

/**
 * Validate the complete snapshot returned by JobNimbus `/account/users`.
 *
 * Unlike the list endpoints that honor `size`/`from`, this account endpoint
 * returns the full employee array and ignores pagination parameters. Treating
 * it as a paginated endpoint causes the second request to repeat the first
 * page and incorrectly denies every employee login. The endpoint contract is
 * therefore modeled explicitly as a single bounded snapshot.
 */
export function validateCompleteJobNimbusUserSnapshot(
  payload,
  { maxRecords = DEFAULT_MAX_RECORDS } = {}
) {
  assertPositiveInteger(maxRecords, "maxRecords");
  const rows = userRows(payload);
  if (rows.length > maxRecords) {
    throw directoryError(
      "JobNimbus employee directory exceeds its reviewed bound."
    );
  }

  const payloadTotal = authoritativeTotal(payload);
  if (payloadTotal !== null && payloadTotal !== rows.length) {
    throw directoryError(
      "JobNimbus employee snapshot does not match its reported total."
    );
  }

  projectCompleteJobNimbusUserIds(rows, { maxRecords });
  return Object.freeze([...rows]);
}

/**
 * Project only the stable provider ids from one already-complete directory.
 * Callers can use this minimized set as non-client reference proof without
 * retaining names, emails, roles, or any other employee-directory fields.
 */
export function projectCompleteJobNimbusUserIds(
  users,
  { maxRecords = DEFAULT_MAX_RECORDS } = {}
) {
  assertPositiveInteger(maxRecords, "maxRecords");
  if (!Array.isArray(users) || users.length > maxRecords) {
    throw directoryError(
      "JobNimbus employee directory exceeds its reviewed bound."
    );
  }
  const ids = [];
  const seenIds = new Set();
  for (const row of users) {
    const id = userRecordId(row);
    if (!id || seenIds.has(id)) {
      throw directoryError(
        "JobNimbus employee snapshot repeated or omitted a stable user id."
      );
    }
    seenIds.add(id);
    ids.push(id);
  }
  return Object.freeze(ids);
}

export function resolveUniqueActiveJobNimbusUser(
  users,
  email
) {
  if (!Array.isArray(users)) {
    throw new TypeError("users must be an array");
  }
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  const matches = users.filter((row) => {
    if (!isPlainObject(row)) return false;
    const candidateEmail = String(
      row.email
      || row.email_address
      || row.username
      || row.login
      || ""
    ).trim().toLowerCase();
    return candidateEmail === key && userIsExplicitlyActive(row);
  });
  if (matches.length !== 1) return null;
  const match = matches[0];
  const id = userRecordId(match);
  if (!id) return null;
  return Object.freeze({
    id,
    name: String(
      match.display_name
      || match.name
      || [match.first_name, match.last_name]
        .filter(Boolean)
        .join(" ")
      || key
    ).trim()
  });
}

export class JobNimbusUserDirectoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobNimbusUserDirectoryError";
    this.code = "jobnimbus_user_directory_incomplete";
  }
}

function userRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) {
    throw directoryError(
      "JobNimbus employee page has an invalid shape."
    );
  }
  const present = USER_LIST_FIELDS.filter(
    (key) => Object.prototype.hasOwnProperty.call(payload, key)
  );
  if (
    present.length !== 1
    || !Array.isArray(payload[present[0]])
  ) {
    throw directoryError(
      "JobNimbus employee page has an ambiguous shape."
    );
  }
  return payload[present[0]];
}

function authoritativeTotal(payload) {
  if (!isPlainObject(payload)) return null;
  const candidates = [
    payload.total,
    payload.total_count,
    payload.totalCount,
    isPlainObject(payload.meta) ? payload.meta.total : undefined
  ].filter((value) => value !== undefined && value !== null);
  if (candidates.length === 0) return null;
  const normalized = candidates.map((value) => {
    const total =
      typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
        ? Number(value)
        : value;
    if (!Number.isSafeInteger(total) || total < 0) {
      throw directoryError(
        "JobNimbus employee total is invalid."
      );
    }
    return total;
  });
  if (new Set(normalized).size !== 1) {
    throw directoryError(
      "JobNimbus employee totals conflict."
    );
  }
  return normalized[0];
}

function userRecordId(row) {
  if (!isPlainObject(row)) return "";
  for (const key of USER_ID_FIELDS) {
    const value = row[key];
    if (
      (typeof value === "string" || typeof value === "number")
      && String(value).trim()
    ) {
      return String(value).trim();
    }
  }
  return "";
}

function userIsExplicitlyActive(row) {
  const explicitActive = [
    row.is_active,
    row.active,
    row.enabled
  ].some((value) => value === true);
  if (!explicitActive) return false;
  if (
    row.is_active === false
    || row.active === false
    || row.enabled === false
    || row.is_disabled === true
    || row.is_archived === true
    || row.deleted === true
  ) {
    return false;
  }
  const inactiveLabels = new Set([
    "inactive",
    "disabled",
    "archived",
    "deleted",
    "terminated"
  ]);
  return ![
    row.status,
    row.status_name,
    row.state
  ].some(
    (value) =>
      typeof value === "string"
      && inactiveLabels.has(value.trim().toLowerCase())
  );
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function directoryError(message) {
  return new JobNimbusUserDirectoryError(message);
}
