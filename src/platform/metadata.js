import {
  CAPABILITY_SCHEMA,
  CAPABILITY_SCHEMA_VERSION,
  CAPABILITY_VERSION,
  buildCapabilityDescriptor,
  buildRuntimeStatus
} from "./capabilities.js";
import { getBuildInfo } from "./build-info.js";

export const PLATFORM_META_SCHEMA_VERSION = "hcn.platform.meta.v1";
export const PLATFORM_SESSION_SCHEMA_VERSION = "hcn.platform.session.v1";

export function buildPlatformMeta({
  env = process.env,
  runtime = {},
  nodeRuntime,
  now = () => new Date()
} = {}) {
  const build = getBuildInfo({ env, runtime: nodeRuntime });
  const thresherActive =
    runtime?.hcnOperationsBrain?.persistenceConfigured === true;
  return {
    schemaVersion: PLATFORM_META_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    build,
    capabilityCatalog: {
      schema: CAPABILITY_SCHEMA,
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      capabilityVersion: CAPABILITY_VERSION,
      semantics: "route_authorization_only",
      effectiveAvailability: "combine_with_runtime"
    },
    runtime: buildRuntimeStatus(runtime),
    boundaries: {
      chanceBrain: "disconnected_no_route",
      hcnChanceBrainDataFlow: "none",
      jobrolo: "disconnected",
      hcnOperationsBrain: thresherActive
        ? "active_isolated_encrypted_operational_state"
        : "foundation_persistence_pending",
      legacyClientMemory: "quarantined_unreachable"
    }
  };
}

export function buildPlatformSession({
  identity,
  env = process.env,
  runtime = {},
  nodeRuntime,
  now = () => new Date()
} = {}) {
  const descriptor = buildCapabilityDescriptor({ identity, runtime });
  return {
    schemaVersion: PLATFORM_SESSION_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    authenticated: descriptor.identity.authentication === "authenticated",
    build: getBuildInfo({ env, runtime: nodeRuntime }),
    identity: descriptor.identity,
    authorizedCapabilities: descriptor.authorizedCapabilities,
    runtime: descriptor.runtime,
    descriptorHash: descriptor.descriptorHash
  };
}
