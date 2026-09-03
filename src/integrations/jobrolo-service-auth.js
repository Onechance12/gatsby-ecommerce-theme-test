import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";

import {
  HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST
} from "./jobrolo-carrier-email.js";

export const JOBROLO_HCN_REQUEST_SCHEMA = "jobrolo.hcn.request.v1";
export const HCN_JOBROLO_REQUEST_SCHEMA = JOBROLO_HCN_REQUEST_SCHEMA;

export const JOBROLO_HCN_READ_ROUTES = Object.freeze([
  "/integrations/jobrolo/v1/status",
  "/integrations/jobrolo/v1/work-center",
  "/integrations/jobrolo/v1/file-review",
  "/integrations/jobrolo/v1/communication-sweep",
  "/integrations/jobrolo/v1/quo-phone-history",
  "/integrations/jobrolo/v1/management-sweep"
]);
export const HCN_JOBROLO_READ_ROUTES = JOBROLO_HCN_READ_ROUTES;

export const JOBROLO_HCN_ROUTES = Object.freeze([
  ...JOBROLO_HCN_READ_ROUTES,
  ...HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST,
  "/integrations/jobrolo/v1/assistant/turn",
  "/integrations/jobrolo/v1/action-plans/prepare",
  "/integrations/jobrolo/v1/action-plans/execute",
  "/integrations/jobrolo/v1/action-receipts/detail"
]);

export const JOBROLO_HCN_GENERAL_EFFECT_ROUTES = Object.freeze([
  "/integrations/jobrolo/v1/action-plans/prepare",
  "/integrations/jobrolo/v1/action-plans/execute",
  "/integrations/jobrolo/v1/action-receipts/detail",
  ...HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST.filter(
    (route) => (
      !route.endsWith("/status")
      && !route.endsWith("/receipts/detail")
    )
  )
]);

export const JOBROLO_HCN_GENERAL_READ_ONLY_ROUTES = Object.freeze([
  ...JOBROLO_HCN_READ_ROUTES,
  "/integrations/jobrolo/v1/assistant/turn",
  ...HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST.filter(
    (route) => (
      route.endsWith("/status")
      || route.endsWith("/receipts/detail")
    )
  )
]);

export const HCN_JOBROLO_NOTE_WRITEBACK_ROUTES = Object.freeze([
  "/integrations/jobrolo/v1/action-plans/prepare",
  "/integrations/jobrolo/v1/action-plans/execute",
  "/integrations/jobrolo/v1/action-receipts/detail"
]);

export const HCN_JOBROLO_CLAIM_FILING_ROUTES = Object.freeze([
  "/integrations/jobrolo/v1/claim-filings/status",
  "/integrations/jobrolo/v1/claim-filings/prepare",
  "/integrations/jobrolo/v1/claim-filings/execute",
  "/integrations/jobrolo/v1/claim-filings/result",
  "/integrations/jobrolo/v1/claim-filings/writeback/prepare",
  "/integrations/jobrolo/v1/claim-filings/writeback/execute"
]);

const ROUTES = new Set([
  ...JOBROLO_HCN_ROUTES,
  ...HCN_JOBROLO_CLAIM_FILING_ROUTES
]);
const CLIENT_ID = /^[A-Za-z0-9._-]{3,64}$/;
const REQUEST_ID = /^request_[a-f0-9]{32}$/;
const SESSION_REF = /^session_[a-f0-9]{32}$/;
const PRINCIPAL_REF = /^principal_[a-f0-9]{32}$/;
const FILE_REF = /^subject_[a-f0-9]{32}$/;
const BINDING_REF = /^binding_[a-f0-9]{64}$/;
const NONCE = /^nonce_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SKEW_MS = 5 * 60_000;
const DEFAULT_MAX_NONCES = 8_192;
const MAX_CANONICAL_DEPTH = 24;
const MAX_CANONICAL_NODES = 30_000;
const GENERAL_PROFILES_SCHEMA = "hcn.jobrolo.general-profiles.v1";
const NOTE_WRITEBACK_PROFILES_SCHEMA =
  "hcn.jobrolo.note-writeback-profiles.v1";
const CLAIM_FILING_PROFILES_SCHEMA =
  "hcn.jobrolo.claim-filing-profiles.v1";
const SAFE_PROFILE_TEXT = /^[^\u0000-\u001f\u007f]{1,254}$/;

export const LEGACY_JOBROLO_CLAIM_CALLER_PROFILE = Object.freeze({
  publicAdjusterName: "Chance Pearson",
  licenseJurisdiction: "Texas",
  licenseNumber: "3351885",
  firmName: "Wave Public Adjusting",
  officeAddress:
    "3500 Oak Lawn Avenue, Suite 460C, Dallas, Texas 75219",
  officePhone: "+19725731730",
  email: "cpearson@wavepa.com",
  queueCallbackPhone: "+18176867361"
});

export function isJobroloHcnRoute(pathname) {
  return ROUTES.has(String(pathname || ""));
}

export function deriveJobroloAssistantSessionBindingRef({
  tenantId,
  clientId,
  principalRef,
  sessionRef
} = {}) {
  const tenant = String(tenantId || "");
  if (
    !tenant
    || tenant.length > 256
    || /[\u0000-\u001f\u007f]/.test(tenant)
    || !CLIENT_ID.test(String(clientId || ""))
    || !PRINCIPAL_REF.test(String(principalRef || ""))
    || !SESSION_REF.test(String(sessionRef || ""))
  ) {
    throw new TypeError("Jobrolo assistant session binding input is invalid.");
  }
  return `binding_${createHash("sha256")
    .update("hcn-jobrolo:assistant-session-binding:v1", "utf8")
    .update("\0", "utf8")
    .update(tenant, "utf8")
    .update("\0", "utf8")
    .update(clientId, "utf8")
    .update("\0", "utf8")
    .update(principalRef, "utf8")
    .update("\0", "utf8")
    .update(sessionRef, "utf8")
    .digest("hex")}`;
}

export function deriveJobroloAssistantScopedBindingRef({
  sessionBindingRef,
  kind,
  fileRef
} = {}) {
  const normalizedFileRef = String(fileRef || "");
  if (
    !BINDING_REF.test(String(sessionBindingRef || ""))
    || !["general", "file"].includes(kind)
    || (kind === "general" && normalizedFileRef !== "")
    || (kind === "file" && !FILE_REF.test(normalizedFileRef))
  ) {
    throw new TypeError("Jobrolo assistant scope binding input is invalid.");
  }
  return `binding_${createHash("sha256")
    .update("hcn-jobrolo:assistant-conversation-scope:v1", "utf8")
    .update("\0", "utf8")
    .update(sessionBindingRef, "utf8")
    .update("\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(normalizedFileRef, "utf8")
    .digest("hex")}`;
}

export function loadJobroloHcnIntegrationConfiguration(
  env = {},
  { disallowedSecrets = [] } = {}
) {
  const enabled = String(env.HCN_JOBROLO_ADAPTER_ENABLED || "")
    .trim() === "true";
  const clientId = String(env.HCN_JOBROLO_CLIENT_ID || "").trim();
  const secret = String(env.HCN_JOBROLO_SHARED_SECRET || "");
  const principalEmail = String(
    env.HCN_JOBROLO_PRINCIPAL_EMAIL || ""
  ).trim().toLowerCase();
  const anyConfigured = Boolean(clientId || secret || principalEmail);

  if (!enabled && !anyConfigured) {
    return Object.freeze({
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    });
  }
  if (!enabled) {
    configurationError(
      "HCN_JOBROLO_ADAPTER_ENABLED must be true when Jobrolo adapter credentials are configured."
    );
  }
  if (!CLIENT_ID.test(clientId)) {
    configurationError(
      "HCN_JOBROLO_CLIENT_ID must contain 3-64 safe identifier characters."
    );
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
    configurationError(
      "HCN_JOBROLO_SHARED_SECRET must contain 32-512 printable non-space ASCII characters."
    );
  }
  if (!EMAIL.test(principalEmail) || principalEmail.length > 254) {
    configurationError(
      "HCN_JOBROLO_PRINCIPAL_EMAIL must be one fixed valid HCN employee email."
    );
  }
  for (const item of disallowedSecrets) {
    const name = String(item?.name || "another secret");
    const value = String(item?.value || "");
    if (value && secureTextEqual(secret, value)) {
      configurationError(
        `HCN_JOBROLO_SHARED_SECRET must be different from ${name}.`
      );
    }
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    clientId,
    secret,
    principalEmail
  });
}

/**
 * Loads the legacy general Thresher credential plus additional server-owned
 * employee profiles. The request may select only a signed client id; the HCN
 * principal is always taken from this registry and never from request JSON.
 */
export function loadJobroloHcnIntegrationRegistry(
  env = {},
  { disallowedClientIds = [], disallowedSecrets = [] } = {}
) {
  const primaryConfiguration = loadJobroloHcnIntegrationConfiguration(env, {
    disallowedSecrets
  });
  if (!primaryConfiguration.ready) {
    return Object.freeze({
      enabled: false,
      ready: false,
      primary: primaryConfiguration,
      profiles: Object.freeze([])
    });
  }
  const primary = Object.freeze({
    ...primaryConfiguration,
    effectMode: "approved_effects"
  });

  assertProfileCredentialDistinct({
    clientId: primary.clientId,
    secret: primary.secret,
    disallowedClientIds,
    disallowedSecrets,
    capability: "general"
  });

  const rawAdditional = String(
    env.HCN_JOBROLO_ADDITIONAL_PROFILES_JSON || ""
  ).trim();
  let additional = [];
  if (rawAdditional) {
    if (Buffer.byteLength(rawAdditional, "utf8") > 64 * 1024) {
      configurationError(
        "HCN_JOBROLO_ADDITIONAL_PROFILES_JSON is too large."
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(rawAdditional);
    } catch {
      configurationError(
        "HCN_JOBROLO_ADDITIONAL_PROFILES_JSON must be valid JSON."
      );
    }
    if (
      !isPlainRecord(parsed)
      || parsed.schema !== GENERAL_PROFILES_SCHEMA
      || !Array.isArray(parsed.profiles)
      || parsed.profiles.length < 1
      || parsed.profiles.length > 50
      || Object.keys(parsed).sort().join(",") !== "profiles,schema"
    ) {
      configurationError(
        "HCN_JOBROLO_ADDITIONAL_PROFILES_JSON has an invalid schema."
      );
    }
    additional = parsed.profiles.map((value) => {
      if (
        !isPlainRecord(value)
        || Object.keys(value).sort().join(",")
          !== "clientId,effectMode,principalEmail,sharedSecret"
      ) {
        configurationError(
          "Each additional general profile must contain only the exact approved fields."
        );
      }
      const clientId = String(value.clientId || "").trim();
      const secret = String(value.sharedSecret || "");
      const principalEmail = normalizedProfileEmail(value.principalEmail);
      const effectMode = String(value.effectMode || "");
      if (
        !CLIENT_ID.test(clientId)
        || !/^[\x21-\x7e]{32,512}$/.test(secret)
        || !principalEmail
        || !["read_only", "approved_effects"].includes(effectMode)
      ) {
        configurationError("An additional general profile is invalid.");
      }
      assertProfileCredentialDistinct({
        clientId,
        secret,
        disallowedClientIds,
        disallowedSecrets,
        capability: "general"
      });
      return Object.freeze({
        enabled: true,
        ready: true,
        clientId,
        secret,
        principalEmail,
        effectMode
      });
    });
  }

  const profiles = [primary, ...additional];
  assertDistinctServerProfiles(profiles, "General HCN profiles");
  return Object.freeze({
    enabled: true,
    ready: true,
    primary,
    profiles: Object.freeze(profiles)
  });
}

export function resolveJobroloHcnIntegrationProfile(registry, clientId) {
  if (!registry?.ready || !Array.isArray(registry.profiles)) return null;
  const requested = String(clientId || "");
  const matches = registry.profiles.filter((profile) =>
    secureTextEqual(profile.clientId, requested)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function jobroloHcnGeneralProfileAllowsRoute(profile, pathname) {
  if (!profile?.ready || !JOBROLO_HCN_ROUTES.includes(String(pathname || ""))) {
    return false;
  }
  return profile.effectMode === "approved_effects"
    ? true
    : profile.effectMode === "read_only"
      && JOBROLO_HCN_GENERAL_READ_ONLY_ROUTES.includes(
        String(pathname || "")
      );
}

/**
 * A separate credential for the ordinary-chat JobNimbus note pilot. It shares
 * the reviewed HCN request envelope and action engine, but its server-owned
 * capability profile is intentionally narrower than the existing general
 * Jobrolo/Thresher adapter.
 */
export function loadJobroloHcnNoteWritebackConfiguration(
  env = {},
  { disallowedClientIds = [], disallowedSecrets = [] } = {}
) {
  const enabled = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_ENABLED || ""
  ).trim() === "true";
  const clientId = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID || ""
  ).trim();
  const secret = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET || ""
  );
  const principalEmail = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL || ""
  ).trim().toLowerCase();
  const anyConfigured = Boolean(clientId || secret || principalEmail);

  if (!enabled && !anyConfigured) {
    return Object.freeze({
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    });
  }
  if (!enabled) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_ENABLED must be true when note-writeback credentials are configured."
    );
  }
  if (!CLIENT_ID.test(clientId)) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID must contain 3-64 safe identifier characters."
    );
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET must contain 32-512 printable non-space ASCII characters."
    );
  }
  if (!EMAIL.test(principalEmail) || principalEmail.length > 254) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL must be one fixed valid HCN employee email."
    );
  }
  for (const item of disallowedClientIds) {
    const name = String(item?.name || "another client id");
    const value = String(item?.value || "");
    if (value && secureTextEqual(clientId, value)) {
      configurationError(
        `HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID must be different from ${name}.`
      );
    }
  }
  for (const item of disallowedSecrets) {
    const name = String(item?.name || "another secret");
    const value = String(item?.value || "");
    if (value && secureTextEqual(secret, value)) {
      configurationError(
        `HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET must be different from ${name}.`
      );
    }
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    clientId,
    secret,
    principalEmail
  });
}

/**
 * Loads the legacy Chance-only note credential plus additional independent
 * employee note-only profiles. Each profile remains limited to the existing
 * exact-one-note routes and resolves its principal only from server config.
 */
export function loadJobroloHcnNoteWritebackRegistry(
  env = {},
  { disallowedClientIds = [], disallowedSecrets = [] } = {}
) {
  const primary = loadJobroloHcnNoteWritebackConfiguration(env, {
    disallowedClientIds,
    disallowedSecrets
  });
  const rawAdditional = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON || ""
  ).trim();
  if (!primary.ready) {
    if (rawAdditional) {
      configurationError(
        "The legacy note-writeback credential must be configured before additional note-only profiles."
      );
    }
    return Object.freeze({
      enabled: false,
      ready: false,
      primary,
      profiles: Object.freeze([])
    });
  }

  let additional = [];
  if (rawAdditional) {
    if (Buffer.byteLength(rawAdditional, "utf8") > 64 * 1024) {
      configurationError(
        "HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON is too large."
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(rawAdditional);
    } catch {
      configurationError(
        "HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON must be valid JSON."
      );
    }
    if (
      !isPlainRecord(parsed)
      || parsed.schema !== NOTE_WRITEBACK_PROFILES_SCHEMA
      || !Array.isArray(parsed.profiles)
      || parsed.profiles.length < 1
      || parsed.profiles.length > 50
      || Object.keys(parsed).sort().join(",") !== "profiles,schema"
    ) {
      configurationError(
        "HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON has an invalid schema."
      );
    }
    additional = parsed.profiles.map((value) => {
      if (
        !isPlainRecord(value)
        || Object.keys(value).sort().join(",")
          !== "clientId,principalEmail,sharedSecret"
      ) {
        configurationError(
          "Each additional note-only profile must contain only the exact approved fields."
        );
      }
      const clientId = String(value.clientId || "").trim();
      const secret = String(value.sharedSecret || "");
      const principalEmail = normalizedProfileEmail(value.principalEmail);
      if (
        !CLIENT_ID.test(clientId)
        || !/^[\x21-\x7e]{32,512}$/.test(secret)
        || !principalEmail
      ) {
        configurationError("An additional note-only profile is invalid.");
      }
      assertProfileCredentialDistinct({
        clientId,
        secret,
        disallowedClientIds,
        disallowedSecrets,
        capability: "note-only"
      });
      return Object.freeze({
        enabled: true,
        ready: true,
        clientId,
        secret,
        principalEmail
      });
    });
  }
  const profiles = [primary, ...additional];
  assertDistinctServerProfiles(profiles, "Note-only HCN profiles");
  return Object.freeze({
    enabled: true,
    ready: true,
    primary,
    profiles: Object.freeze(profiles)
  });
}

export function resolveJobroloHcnNoteWritebackProfile(registry, clientId) {
  if (!registry?.ready || !Array.isArray(registry.profiles)) return null;
  const requested = String(clientId || "");
  const matches = registry.profiles.filter((profile) =>
    secureTextEqual(profile.clientId, requested)
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Dedicated owner-only credential for the existing HCN claim-filing engine.
 * It cannot call the general Thresher or note-writeback routes.
 */
export function loadJobroloHcnClaimFilingConfiguration(
  env = {},
  { disallowedClientIds = [], disallowedSecrets = [] } = {}
) {
  const enabled = String(
    env.HCN_JOBROLO_CLAIM_FILING_ENABLED || ""
  ).trim() === "true";
  const clientId = String(
    env.HCN_JOBROLO_CLAIM_FILING_CLIENT_ID || ""
  ).trim();
  const secret = String(
    env.HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET || ""
  );
  const principalEmail = String(
    env.HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL || ""
  ).trim().toLowerCase();
  const anyConfigured = Boolean(clientId || secret || principalEmail);

  if (!enabled && !anyConfigured) {
    return Object.freeze({
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    });
  }
  if (!enabled) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_ENABLED must be true when claim-filing credentials are configured."
    );
  }
  if (!CLIENT_ID.test(clientId)) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_CLIENT_ID must contain 3-64 safe identifier characters."
    );
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET must contain 32-512 printable non-space ASCII characters."
    );
  }
  if (!EMAIL.test(principalEmail) || principalEmail.length > 254) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL must be one fixed valid HCN employee email."
    );
  }
  for (const item of disallowedClientIds) {
    const name = String(item?.name || "another client id");
    const value = String(item?.value || "");
    if (value && secureTextEqual(clientId, value)) {
      configurationError(
        `HCN_JOBROLO_CLAIM_FILING_CLIENT_ID must be different from ${name}.`
      );
    }
  }
  for (const item of disallowedSecrets) {
    const name = String(item?.name || "another secret");
    const value = String(item?.value || "");
    if (value && secureTextEqual(secret, value)) {
      configurationError(
        `HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET must be different from ${name}.`
      );
    }
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    clientId,
    secret,
    principalEmail
  });
}

export function loadJobroloHcnClaimFilingRegistry(
  env = {},
  {
    disallowedClientIds = [],
    disallowedSecrets = [],
    primaryCallerProfile = LEGACY_JOBROLO_CLAIM_CALLER_PROFILE
  } = {}
) {
  const primaryConfiguration = loadJobroloHcnClaimFilingConfiguration(env, {
    disallowedClientIds,
    disallowedSecrets
  });
  if (!primaryConfiguration.ready) {
    return Object.freeze({
      enabled: false,
      ready: false,
      primary: primaryConfiguration,
      profiles: Object.freeze([])
    });
  }
  const primary = Object.freeze({
    ...primaryConfiguration,
    callerProfile: normalizeClaimCallerProfile(primaryCallerProfile)
  });
  const rawAdditional = String(
    env.HCN_JOBROLO_CLAIM_FILING_ADDITIONAL_PROFILES_JSON || ""
  ).trim();
  let additional = [];
  if (rawAdditional) {
    if (Buffer.byteLength(rawAdditional, "utf8") > 64 * 1024) {
      configurationError(
        "HCN_JOBROLO_CLAIM_FILING_ADDITIONAL_PROFILES_JSON is too large."
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(rawAdditional);
    } catch {
      configurationError(
        "HCN_JOBROLO_CLAIM_FILING_ADDITIONAL_PROFILES_JSON must be valid JSON."
      );
    }
    if (
      !isPlainRecord(parsed)
      || parsed.schema !== CLAIM_FILING_PROFILES_SCHEMA
      || !Array.isArray(parsed.profiles)
      || parsed.profiles.length < 1
      || parsed.profiles.length > 50
      || Object.keys(parsed).sort().join(",") !== "profiles,schema"
    ) {
      configurationError(
        "HCN_JOBROLO_CLAIM_FILING_ADDITIONAL_PROFILES_JSON has an invalid schema."
      );
    }
    additional = parsed.profiles.map((value) => {
      const keys = [
        "clientId",
        "email",
        "firmName",
        "licenseJurisdiction",
        "licenseNumber",
        "officeAddress",
        "officePhone",
        "principalEmail",
        "publicAdjusterName",
        "queueCallbackPhone",
        "sharedSecret"
      ];
      if (
        !isPlainRecord(value)
        || Object.keys(value).sort().join(",") !== keys.sort().join(",")
      ) {
        configurationError(
          "Each additional claim-filing profile must contain only the exact approved fields."
        );
      }
      const clientId = String(value.clientId || "").trim();
      const secret = String(value.sharedSecret || "");
      const principalEmail = normalizedProfileEmail(value.principalEmail);
      if (
        !CLIENT_ID.test(clientId)
        || !/^[\x21-\x7e]{32,512}$/.test(secret)
        || !principalEmail
      ) {
        configurationError("An additional claim-filing credential is invalid.");
      }
      assertCredentialDistinct({
        clientId,
        secret,
        disallowedClientIds,
        disallowedSecrets
      });
      return Object.freeze({
        enabled: true,
        ready: true,
        clientId,
        secret,
        principalEmail,
        callerProfile: normalizeClaimCallerProfile(value)
      });
    });
  }
  const profiles = [primary, ...additional];
  for (let index = 0; index < profiles.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < profiles.length; otherIndex += 1) {
      const left = profiles[index];
      const right = profiles[otherIndex];
      if (
        secureTextEqual(left.clientId, right.clientId)
        || secureTextEqual(left.secret, right.secret)
        || secureTextEqual(left.principalEmail, right.principalEmail)
        || secureTextEqual(
          claimLicenseIdentityKey(left.callerProfile),
          claimLicenseIdentityKey(right.callerProfile)
        )
        || secureTextEqual(
          left.callerProfile.email,
          right.callerProfile.email
        )
        || secureTextEqual(
          left.callerProfile.queueCallbackPhone,
          right.callerProfile.queueCallbackPhone
        )
      ) {
        configurationError(
          "Claim-filing profiles must have distinct client ids, secrets, principals, PA licenses, PA emails, and queue callback phones."
        );
      }
    }
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    primary,
    profiles: Object.freeze(profiles)
  });
}

export function resolveJobroloHcnClaimFilingProfile(registry, clientId) {
  if (!registry?.ready || !Array.isArray(registry.profiles)) return null;
  const requested = String(clientId || "");
  const matches = registry.profiles.filter((profile) =>
    secureTextEqual(profile.clientId, requested)
  );
  return matches.length === 1 ? matches[0] : null;
}

function normalizeClaimCallerProfile(value) {
  if (!isPlainRecord(value)) {
    configurationError("A server-owned claim caller profile is required.");
  }
  const publicAdjusterName = safeProfileText(value.publicAdjusterName);
  const licenseJurisdiction = safeProfileText(value.licenseJurisdiction);
  const licenseNumber = safeProfileText(value.licenseNumber);
  const firmName = safeProfileText(value.firmName);
  const officeAddress = safeProfileText(value.officeAddress);
  const officePhone = normalizedProfilePhone(value.officePhone);
  const email = normalizedProfileEmail(value.email);
  const queueCallbackPhone = normalizedProfilePhone(
    value.queueCallbackPhone
  );
  if (
    !publicAdjusterName
    || !licenseJurisdiction
    || !licenseNumber
    || !firmName
    || !officeAddress
    || !officePhone
    || !email
    || !queueCallbackPhone
  ) {
    configurationError("A server-owned claim caller profile is invalid.");
  }
  return Object.freeze({
    publicAdjusterName,
    licenseJurisdiction,
    licenseNumber,
    firmName,
    officeAddress,
    officePhone,
    email,
    queueCallbackPhone
  });
}

function claimLicenseIdentityKey(callerProfile) {
  const rawJurisdiction = String(
    callerProfile?.licenseJurisdiction || ""
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const jurisdiction = new Map([
    ["tx", "tx"],
    ["texas", "tx"],
    ["stateoftexas", "tx"]
  ]).get(rawJurisdiction) || rawJurisdiction;
  return [
    jurisdiction,
    String(callerProfile?.licenseNumber || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
  ].join(":");
}

function assertCredentialDistinct({
  clientId,
  secret,
  disallowedClientIds,
  disallowedSecrets
}) {
  for (const item of disallowedClientIds) {
    const value = String(item?.value ?? item ?? "");
    if (value && secureTextEqual(clientId, value)) {
      configurationError("A claim-filing client id reuses another capability credential.");
    }
  }
  for (const item of disallowedSecrets) {
    const value = String(item?.value ?? item ?? "");
    if (value && secureTextEqual(secret, value)) {
      configurationError("A claim-filing secret reuses another capability credential.");
    }
  }
}

function assertProfileCredentialDistinct({
  clientId,
  secret,
  disallowedClientIds,
  disallowedSecrets,
  capability
}) {
  const label = safeProfileText(capability) || "integration";
  for (const item of disallowedClientIds) {
    const value = String(item?.value ?? item ?? "");
    if (value && secureTextEqual(clientId, value)) {
      configurationError(
        `A ${label} client id reuses another capability credential.`
      );
    }
  }
  for (const item of disallowedSecrets) {
    const value = String(item?.value ?? item ?? "");
    if (value && secureTextEqual(secret, value)) {
      configurationError(
        `A ${label} secret reuses another capability credential.`
      );
    }
  }
}

function assertDistinctServerProfiles(profiles, label) {
  for (let index = 0; index < profiles.length; index += 1) {
    for (
      let otherIndex = index + 1;
      otherIndex < profiles.length;
      otherIndex += 1
    ) {
      const left = profiles[index];
      const right = profiles[otherIndex];
      if (
        secureTextEqual(left.clientId, right.clientId)
        || secureTextEqual(left.secret, right.secret)
        || secureTextEqual(left.principalEmail, right.principalEmail)
      ) {
        configurationError(
          `${label} must have distinct client ids, secrets, and principals.`
        );
      }
    }
  }
}

function normalizedProfileEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL.test(email) && email.length <= 254 ? email : "";
}

function normalizedProfilePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function safeProfileText(value) {
  const text = String(value || "").trim();
  return SAFE_PROFILE_TEXT.test(text) ? text : "";
}

export function createJobroloHcnNonceGuard({
  now = Date.now,
  ttlMs = DEFAULT_SKEW_MS,
  maxEntries = DEFAULT_MAX_NONCES
} = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) {
    throw new TypeError("ttlMs is outside the supported range");
  }
  if (
    !Number.isSafeInteger(maxEntries)
    || maxEntries < 32
    || maxEntries > 100_000
  ) {
    throw new TypeError("maxEntries is outside the supported range");
  }
  const used = new Map();
  return Object.freeze({
    consume(clientId, nonce, validUntilMs) {
      const current = now();
      for (const [key, expiresAt] of used) {
        if (expiresAt <= current) used.delete(key);
      }
      const key = `${clientId}\0${nonce}`;
      if (used.has(key)) {
        throw authenticationError(
          "Jobrolo integration request replay was rejected."
        );
      }
      if (used.size >= maxEntries) {
        throw serviceError(
          "Jobrolo integration replay protection is at capacity."
        );
      }
      const requestedExpiry = Number(validUntilMs);
      // Authenticators permit at most one hour of clock skew, so a signed
      // future timestamp can remain usable for at most two hours from receipt.
      // Keep this bound independent of the guard's fallback TTL so an injected
      // guard cannot accidentally shorten replay coverage below the signature
      // validity window.
      const maximumExpiry = current + (2 * 3_600_000) + 1;
      const expiresAt = Number.isSafeInteger(requestedExpiry)
        && requestedExpiry > current
        && requestedExpiry <= maximumExpiry
        ? requestedExpiry
        : current + ttlMs;
      used.set(key, expiresAt);
    }
  });
}

export function createJobroloHcnAuthenticator({
  configuration,
  now = Date.now,
  maximumSkewMs = DEFAULT_SKEW_MS,
  nonceGuard = createJobroloHcnNonceGuard({ now, ttlMs: maximumSkewMs }),
  allowedRoutes = JOBROLO_HCN_ROUTES
} = {}) {
  if (!configuration?.ready || !configuration?.enabled) {
    return Object.freeze({
      authenticate() {
        throw serviceError("The Jobrolo HCN integration is unavailable.");
      }
    });
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (
    !Number.isSafeInteger(maximumSkewMs)
    || maximumSkewMs < 1_000
    || maximumSkewMs > 3_600_000
  ) {
    throw new TypeError("maximumSkewMs is outside the supported range");
  }
  const allowedRouteSet = validateAllowedRoutes(allowedRoutes);

  return Object.freeze({
    authenticate({ method, pathname, headers, body } = {}) {
      const normalizedMethod = String(method || "").toUpperCase();
      const normalizedPath = String(pathname || "");
      if (
        normalizedMethod !== "POST"
        || !allowedRouteSet.has(normalizedPath)
      ) {
        throw authenticationError("Jobrolo integration route is not allowed.");
      }
      const authorization = exactHeader(headers, "authorization");
      if (authorization !== `Jobrolo-HMAC ${configuration.clientId}`) {
        throw authenticationError("Jobrolo integration authentication failed.");
      }
      const timestampText = exactHeader(headers, "x-jobrolo-timestamp");
      if (!/^\d{13}$/.test(timestampText)) {
        throw authenticationError("Jobrolo integration timestamp is invalid.");
      }
      const timestamp = Number(timestampText);
      if (
        !Number.isSafeInteger(timestamp)
        || Math.abs(now() - timestamp) > maximumSkewMs
      ) {
        throw authenticationError("Jobrolo integration timestamp is stale.");
      }
      const nonce = exactHeader(headers, "x-jobrolo-nonce");
      if (!NONCE.test(nonce)) {
        throw authenticationError("Jobrolo integration nonce is invalid.");
      }
      const claimedHash = exactHeader(
        headers,
        "x-jobrolo-content-sha256"
      );
      const signature = exactHeader(headers, "x-jobrolo-signature");
      if (!SHA256.test(claimedHash) || !SHA256.test(signature)) {
        throw authenticationError("Jobrolo integration signature is invalid.");
      }

      const canonicalBody = stableCanonicalJson(body);
      const actualHash = createHash("sha256")
        .update(canonicalBody, "utf8")
        .digest("hex");
      if (!secureTextEqual(claimedHash, actualHash)) {
        throw authenticationError("Jobrolo integration body hash is invalid.");
      }
      const canonicalRequest = jobroloHcnSigningMaterial({
        method: normalizedMethod,
        pathname: normalizedPath,
        timestamp: timestampText,
        nonce,
        bodyHash: actualHash
      });
      const expectedSignature = createHmac(
        "sha256",
        configuration.secret
      ).update(canonicalRequest, "utf8").digest("hex");
      if (!secureTextEqual(signature, expectedSignature)) {
        throw authenticationError("Jobrolo integration signature is invalid.");
      }

      const envelope = validateJobroloHcnRequestEnvelope(body);
      // A timestamp may be as much as one skew window in the future. Retain
      // the nonce until that timestamp can no longer authenticate, otherwise
      // a future-dated request could be replayed after a fixed TTL elapsed.
      nonceGuard.consume(
        configuration.clientId,
        nonce,
        timestamp + maximumSkewMs + 1
      );
      return Object.freeze({
        clientId: configuration.clientId,
        principalEmail: configuration.principalEmail,
        requestId: envelope.requestId,
        sessionRef: envelope.actor.sessionRef,
        input: envelope.input
      });
    }
  });
}

function validateAllowedRoutes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("allowedRoutes must be a non-empty route array");
  }
  const routes = new Set();
  for (const route of value) {
    if (
      typeof route !== "string"
      || !ROUTES.has(route)
      || routes.has(route)
    ) {
      throw new TypeError(
        "allowedRoutes must contain unique allowlisted Jobrolo HCN routes"
      );
    }
    routes.add(route);
  }
  return routes;
}

export function signJobroloHcnRequest({
  clientId,
  secret,
  method = "POST",
  pathname,
  timestamp,
  nonce,
  body
} = {}) {
  const canonicalBody = stableCanonicalJson(body);
  const bodyHash = createHash("sha256")
    .update(canonicalBody, "utf8")
    .digest("hex");
  const timestampText = String(timestamp);
  const material = jobroloHcnSigningMaterial({
    method: String(method).toUpperCase(),
    pathname,
    timestamp: timestampText,
    nonce,
    bodyHash
  });
  return Object.freeze({
    authorization: `Jobrolo-HMAC ${clientId}`,
    "x-jobrolo-timestamp": timestampText,
    "x-jobrolo-nonce": nonce,
    "x-jobrolo-content-sha256": bodyHash,
    "x-jobrolo-signature": createHmac("sha256", secret)
      .update(material, "utf8")
      .digest("hex")
  });
}

export function stableCanonicalJson(value) {
  const state = { nodes: 0 };
  return canonicalValue(value, 0, state);
}

function canonicalValue(value, depth, state) {
  state.nodes += 1;
  if (depth > MAX_CANONICAL_DEPTH || state.nodes > MAX_CANONICAL_NODES) {
    throw requestError("Jobrolo integration body is too complex.");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw requestError("Jobrolo integration body contains an invalid number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item, depth + 1, state)).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw requestError("Jobrolo integration body must contain plain JSON data.");
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalValue(value[key], depth + 1, state)}`
  )).join(",")}}`;
}

function validateJobroloHcnRequestEnvelope(value) {
  exactRecord(value, ["schema", "requestId", "actor", "input"], "request");
  if (value.schema !== JOBROLO_HCN_REQUEST_SCHEMA) {
    throw requestError("Jobrolo integration request schema is invalid.");
  }
  if (!REQUEST_ID.test(value.requestId)) {
    throw requestError("Jobrolo integration requestId is invalid.");
  }
  exactRecord(value.actor, ["sessionRef"], "actor");
  if (!SESSION_REF.test(value.actor.sessionRef)) {
    throw requestError("Jobrolo integration sessionRef is invalid.");
  }
  if (!isPlainRecord(value.input)) {
    throw requestError("Jobrolo integration input must be an object.");
  }
  return value;
}

function jobroloHcnSigningMaterial({
  method,
  pathname,
  timestamp,
  nonce,
  bodyHash
}) {
  return `${method}\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function exactHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value) || typeof value !== "string" || !value) {
    throw authenticationError("Jobrolo integration authentication failed.");
  }
  return value;
}

function exactRecord(value, keys, label) {
  if (!isPlainRecord(value)) {
    throw requestError(`Jobrolo integration ${label} must be an object.`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
  ) {
    throw requestError(
      `Jobrolo integration ${label} contains unsupported fields.`
    );
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function secureTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function configurationError(message) {
  const error = new Error(message);
  error.code = "invalid_jobrolo_hcn_configuration";
  throw error;
}

function authenticationError(message) {
  const error = new Error(message);
  error.code = "invalid_jobrolo_hcn_authentication";
  error.statusCode = 401;
  return error;
}

function requestError(message) {
  const error = new Error(message);
  error.code = "invalid_jobrolo_hcn_request";
  error.statusCode = 400;
  return error;
}

function serviceError(message) {
  const error = new Error(message);
  error.code = "jobrolo_hcn_unavailable";
  error.statusCode = 503;
  return error;
}
