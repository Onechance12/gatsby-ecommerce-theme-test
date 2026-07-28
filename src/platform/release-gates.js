const DEFAULTS = {
  BRIDGE_ALLOW_WRITES: false,
  ALLOW_GMAIL_SEND: false,
  ALLOW_QUO_SEND: false,
  ALLOW_VOICE_CALLS: false,
  ALLOW_RETELL_CALLS: true,
  ALLOW_CLIENT_COORDINATOR_CALLS: false,
  ALLOW_CARRIER_FOLLOWUP_CALLS: true,
  ALLOW_LEGACY_CLIENT_MEMORY_WRITES: false
};

/**
 * Checked-in production defaults for every release-critical effect gate.
 *
 * Keep this list synchronized with render.yaml. The legacy client-memory gate
 * is intentionally fail-closed.
 */
export const RELEASE_GATE_DEFAULTS = Object.freeze(DEFAULTS);

/**
 * Stable key order for descriptors, drift checks, and release validation.
 */
export const RELEASE_GATE_KEYS = Object.freeze(
  Object.keys(RELEASE_GATE_DEFAULTS).sort()
);

/**
 * Read only the allowlisted effect gates from an environment-like object.
 *
 * Gate parsing is deliberately strict and fail-closed: only the exact string
 * "true" enables an effect. The returned object contains no other environment
 * fields and is immutable.
 */
export function readReleaseGates(env = process.env) {
  const source = isRecord(env) ? env : {};
  const gates = {};

  for (const key of RELEASE_GATE_KEYS) {
    gates[key] = source[key] === "true";
  }

  return Object.freeze(gates);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
