import {
  CAPABILITY_SCHEMA,
  CAPABILITY_SCHEMA_VERSION,
  CAPABILITY_VERSION,
  buildCapabilityDescriptor,
  buildRuntimeStatus
} from "./capabilities.js";
import { getBuildInfo } from "./build-info.js";
import { JOBROLO_HCN_REQUEST_SCHEMA } from "../integrations/jobrolo-service-auth.js";

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
  const jobroloAdapterReady =
    runtime?.jobroloAdapter?.ready === true;
  const jobroloAdapter = runtime?.jobroloAdapter || {};
  const jobroloImportTransport = runtime?.jobroloImportTransport || {};
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
    integrations: {
      jobrolo: {
        schemaVersion: "hcn.platform.jobrolo-integration.v1",
        generalAdapter: {
          availability: availability(jobroloAdapterReady),
          contract: JOBROLO_HCN_REQUEST_SCHEMA,
          authentication:
            "dedicated_hmac_timestamp_nonce_body_hash",
          principalMode: "fixed_server_side_approved_employee",
          principalSelectableByCaller: false,
          fileScope: "assigned_only",
          readCapabilities: {
            status: availability(jobroloAdapterReady),
            workCenter: availability(jobroloAdapterReady),
            fileReview: availability(jobroloAdapterReady),
            communicationSweep: availability(
              jobroloAdapter.communicationSweepReady === true
            ),
            quoPhoneHistory: availability(
              jobroloAdapter.quoPhoneHistoryReady === true
            ),
            managementSweep: availability(
              jobroloAdapter.managementSweepReady === true
            )
          }
        },
        importTransport: {
          availability: availability(
            jobroloImportTransport.ready === true
          ),
          contract:
            "jobrolo.jobnimbus-import.transport-response.v1",
          authentication:
            "dedicated_import_hmac_exact_bytes_timestamp_durable_nonce",
          principalMode: "fixed_server_side_approved_employee",
          principalSelectableByCaller: false,
          fileScope: "assigned_only",
          photoManifests: availability(
            jobroloImportTransport.ready === true
            && jobroloImportTransport.photoManifestsExposed === true
          ),
          documentContentBoundToManifest:
            jobroloImportTransport.documentContentBoundToManifest === true
        },
        providerCredentialsExposed: false,
        automaticExecution: false
      }
    },
    boundaries: {
      chanceBrain: "disconnected_no_route",
      hcnChanceBrainDataFlow: "none",
      jobrolo: jobroloAdapterReady
        ? "narrow_signed_thresher_adapter"
        : "disconnected",
      hcnOperationsBrain: thresherActive
        ? "active_isolated_encrypted_operational_state"
        : "foundation_persistence_pending",
      legacyClientMemory: "quarantined_unreachable"
    }
  };
}

function availability(ready) {
  return ready === true ? "ready" : "unavailable";
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
