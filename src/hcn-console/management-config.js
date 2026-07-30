/**
 * Explicit allowlist for the company management sweep.
 *
 * The broad report is intentionally unavailable until exactly three
 * JobNimbus adjuster owners are configured. The configuration contains
 * employee display metadata only; it must never contain client data or
 * credentials.
 */

export const HCN_MANAGEMENT_ADJUSTER_SCHEMA =
  "hcn.management-adjusters.v1";

const CONFIGURED_ADJUSTER_COUNT = 3;
const OWNER_ID = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const DISPLAY_NAME = /^[^\x00-\x1f\x7f]{1,80}$/;
const ENTRY_FIELDS = Object.freeze(["ownerId", "displayName"]);

export function loadHcnManagementAdjusterConfiguration(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return immutableCopy({
      schema: HCN_MANAGEMENT_ADJUSTER_SCHEMA,
      ready: false,
      reason: "not_configured",
      adjusters: []
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw configurationError(
      "HCN_MANAGEMENT_ADJUSTERS_JSON must be valid JSON."
    );
  }
  if (
    !Array.isArray(parsed)
    || parsed.length !== CONFIGURED_ADJUSTER_COUNT
  ) {
    throw configurationError(
      `HCN_MANAGEMENT_ADJUSTERS_JSON must contain exactly ${CONFIGURED_ADJUSTER_COUNT} adjusters.`
    );
  }

  const adjusters = parsed.map((candidate, index) =>
    normalizeAdjuster(candidate, index)
  );
  if (new Set(adjusters.map((item) => item.ownerId)).size !== adjusters.length) {
    throw configurationError(
      "HCN_MANAGEMENT_ADJUSTERS_JSON contains duplicate owner ids."
    );
  }
  if (
    new Set(
      adjusters.map((item) => item.displayName.toLocaleLowerCase("en-US"))
    ).size !== adjusters.length
  ) {
    throw configurationError(
      "HCN_MANAGEMENT_ADJUSTERS_JSON contains duplicate display names."
    );
  }

  return immutableCopy({
    schema: HCN_MANAGEMENT_ADJUSTER_SCHEMA,
    ready: true,
    reason: null,
    adjusters
  });
}

function normalizeAdjuster(value, index) {
  if (!isPlainObject(value)) {
    throw configurationError(
      `HCN management adjuster ${index + 1} must be an object.`
    );
  }
  const keys = Object.keys(value);
  if (
    keys.length !== ENTRY_FIELDS.length
    || ENTRY_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(value, field)
    )
    || keys.some((field) => !ENTRY_FIELDS.includes(field))
  ) {
    throw configurationError(
      `HCN management adjuster ${index + 1} must contain only ownerId and displayName.`
    );
  }

  const ownerId = typeof value.ownerId === "string"
    ? value.ownerId.trim()
    : "";
  const rawDisplayName = typeof value.displayName === "string"
    ? value.displayName
    : "";
  if (/[\x00-\x1f\x7f]/.test(rawDisplayName)) {
    throw configurationError(
      `HCN management adjuster ${index + 1} has an invalid display name.`
    );
  }
  const displayName = rawDisplayName.trim().replace(/ +/g, " ");
  if (!OWNER_ID.test(ownerId)) {
    throw configurationError(
      `HCN management adjuster ${index + 1} has an invalid owner id.`
    );
  }
  if (!DISPLAY_NAME.test(displayName)) {
    throw configurationError(
      `HCN management adjuster ${index + 1} has an invalid display name.`
    );
  }
  return {
    ownerId,
    displayName
  };
}

function configurationError(message) {
  const error = new Error(message);
  error.name = "HcnManagementConfigurationError";
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutableCopy(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableCopy(item)));
  }
  if (isPlainObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          immutableCopy(item)
        ])
      )
    );
  }
  return value;
}
