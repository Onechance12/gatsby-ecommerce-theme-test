import { createHash } from "node:crypto";

import { routeAllowed } from "../auth/google-user.js";
import { RELEASE_GATE_DEFAULTS, RELEASE_GATE_KEYS } from "./release-gates.js";

export const CAPABILITY_SCHEMA = "hcn.platform.capability-descriptor";
export const CAPABILITY_SCHEMA_VERSION = "1.0.0";
export const CAPABILITY_VERSION = "2026-08-24.1";

const GOOGLE_ROLES = new Set([
  "chance",
  "administrator",
  "employee",
  "onboarding",
  "client_coordinator",
  "manager"
]);

// This is intentionally an allowlist. A newly added server route is not advertised
// until it receives a reviewed, stable capability name here.
export const CAPABILITY_ROUTE_REGISTRY = Object.freeze([
  capability("identity.read", "GET /auth/whoami"),
  capability("platform.session.read", "GET /api/v1/session"),
  capability("hcn.work_center.read", "POST /hcn/api/v1/work-center"),
  capability("hcn.file.review", "POST /hcn/api/v1/file-review"),
  capability("hcn.action_plans.prepare", "POST /hcn/api/v1/action-plans/prepare"),
  capability("hcn.action_plans.read", "POST /hcn/api/v1/action-plans/list"),
  capability("hcn.action_plans.read", "POST /hcn/api/v1/action-plans/detail"),
  capability("hcn.action_plans.execute", "POST /hcn/api/v1/action-plans/execute"),
  capability("hcn.action_plans.invalidate", "POST /hcn/api/v1/action-plans/invalidate"),
  capability("hcn.action_receipts.read", "POST /hcn/api/v1/action-receipts/list"),
  capability("hcn.action_receipts.read", "POST /hcn/api/v1/action-receipts/detail"),
  capability("quo.line.link", "POST /auth/quo-line"),
  capability("voice.call.place", "POST /voice/outbound-call"),
  capability("voice.transcript.create", "POST /voice/transcript"),
  capability("voice.transcripts.read", "POST /voice/transcripts"),
  capability("handoff.pending.read", "POST /handoff/pending"),
  capability("handoff.artifact.read", "POST /handoff/get"),
  capability("handoff.artifact.process", "POST /handoff/process"),
  capability("handoff.artifact.complete", "POST /handoff/complete"),
  capability("brain.context.read", "POST /brain/context"),
  capability("memory.file_actions.read", "POST /memory/file-actions"),
  capability("memory.persistence.probe", "POST /memory/persistence-check"),
  capability("operations.session.start", "POST /ops/start-session"),
  capability("operations.scheduling.recover", "POST /ops/recover-scheduling-communications"),
  capability("operations.files.review", "POST /ops/review-chance-files"),
  capability("operations.run_policy.read", "GET /ops/run-policy"),
  capability("operations.action_batch.process", "POST /ops/action-batch"),
  capability("operations.action_batch_receipts.read", "POST /ops/action-batch-receipts"),
  capability("operations.action_batch_receipts.reconcile", "POST /ops/action-batch-reconcile"),
  capability("scheduling.availability.review", "POST /scheduling/availability"),
  capability("jobnimbus.contacts.search", "POST /jobnimbus/search"),
  capability("jobnimbus.files.review", "POST /jobnimbus/review-file"),
  capability("jobnimbus.assigned_files.read", "POST /jobnimbus/assigned-files"),
  capability("jobnimbus.assigned_counts.read", "POST /jobnimbus/assigned-counts"),
  capability("jobnimbus.documents.text.read", "POST /jobnimbus/document-text"),
  capability("jobnimbus.documents.review", "POST /jobnimbus/document-review"),
  capability("jobnimbus.documents.attach_to_chat", "POST /jobnimbus/document-file"),
  capability("jobnimbus.photos.review", "POST /jobnimbus/photo-review"),
  capability("weather.date_of_loss.research", "POST /weather/dol-research"),
  capability("jobnimbus.documents.upload", "POST /jobnimbus/upload-file"),
  capability("jobnimbus.contacts.update", "POST /jobnimbus/update-contact"),
  capability("jobnimbus.status.update", "POST /jobnimbus/update-status"),
  capability("jobnimbus.process.update", "POST /jobnimbus/process-update"),
  capability("jobnimbus.notes.create", "POST /jobnimbus/create-note"),
  capability("jobnimbus.tasks.create", "POST /jobnimbus/create-task"),
  capability("jobnimbus.tasks.update", "POST /jobnimbus/update-task"),
  capability("jobnimbus.calendar.create", "POST /jobnimbus/create-calendar-event"),
  capability("jobnimbus.calendar.update", "POST /jobnimbus/update-calendar-event"),
  capability("claims.filing.prepare", "POST /claim-filing/prepare"),
  capability("claims.filing.configuration.review", "POST /claim-filing/configuration"),
  capability("claims.filing.call.place", "POST /claim-filing/call"),
  capability("claims.filing.result.review", "POST /claim-filing/result"),
  capability("claims.filing.callbacks.read", "POST /claim-filing/callbacks"),
  capability("claims.filing.writeback.process", "POST /claim-filing/writeback"),
  capability("retell.agent.configure", "POST /retell/configure-agent"),
  capability("retell.call.end.guard", "POST /retell/guarded-end-call"),
  capability("retell.client_coordinator.configure", "POST /retell/configure-client-coordinator"),
  capability("retell.client_coordinator.call.place", "POST /retell/client-coordinator-call"),
  capability("retell.client_coordinator.call.review", "POST /retell/client-coordinator-call-result"),
  capability("retell.carrier_follow_up.configure", "POST /retell/configure-carrier-follow-up"),
  capability("retell.carrier_follow_up.call.place", "POST /retell/carrier-follow-up-call"),
  capability("retell.carrier_follow_up.call.review", "POST /retell/carrier-follow-up-call-result"),
  capability("retell.homeowner.call.place", "POST /retell/homeowner-call"),
  capability("retell.homeowner.call.review", "POST /retell/homeowner-call-result"),
  capability("gmail.messages.search", "POST /gmail/search"),
  capability("gmail.threads.read", "POST /gmail/thread"),
  capability("gmail.attachments.review", "POST /gmail/attachment-review"),
  capability("gmail.drafts.create", "POST /gmail/draft"),
  capability("gmail.drafts.send", "POST /gmail/send"),
  capability("quo.lines.read", "POST /quo/numbers"),
  capability("quo.history.read", "POST /quo/history"),
  capability("quo.transcripts.read", "POST /quo/transcript"),
  capability("quo.messages.send", "POST /quo/send")
]);

export function buildCapabilityDescriptor({ identity, runtime = {} } = {}) {
  const safeIdentity = normalizeIdentity(identity);
  const { subject: _routingSubject, ...publicIdentity } = safeIdentity;
  const descriptor = {
    schema: CAPABILITY_SCHEMA,
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    capabilityVersion: CAPABILITY_VERSION,
    identity: publicIdentity,
    authorizedCapabilities: capabilitiesForIdentity(identity),
    runtime: buildRuntimeStatus(runtime)
  };

  return {
    ...descriptor,
    descriptorHash: hashDescriptor(descriptor)
  };
}

export function capabilitiesForIdentity(identity) {
  const safeIdentity = normalizeIdentity(identity);
  if (safeIdentity.authentication !== "authenticated") return [];

  const policyIdentity = safeIdentity.type === "codex_operator"
    ? {
        type: "codex_operator_token",
        role: "codex_operator",
        subject: safeIdentity.subject || ""
      }
    : safeIdentity.type === "hcn_browser_session"
      ? { type: "hcn_browser_session", role: safeIdentity.role }
      : { type: "google_oauth", role: safeIdentity.role };

  return [...new Set(CAPABILITY_ROUTE_REGISTRY
    .filter(({ route }) => {
      const separator = route.indexOf(" ");
      return routeAllowed(policyIdentity, route.slice(0, separator), route.slice(separator + 1));
    })
    .map(({ name }) => name))]
    .sort();
}

export function buildRuntimeStatus(runtime = {}) {
  const source = safeObject(runtime);
  const userOAuth = safeObject(source.userOAuth);
  const codexOperator = safeObject(source.codexOperator);
  const outboundSafety = safeObject(source.outboundSafety);
  const voice = safeObject(source.voice);
  const claimFiling = safeObject(source.claimFiling);
  const clientCoordinator = safeObject(source.clientCoordinator);
  const carrierFollowUp = safeObject(source.carrierFollowUp);
  const scheduling = safeObject(source.schedulingAvailability);
  const brain = safeObject(source.brain);
  const hcnActions = safeObject(source.hcnActions);

  return {
    brain: {
      advisory: advisoryStatus(brain),
      availability: configurationStatus(brain.available),
      clientMemory: clientMemoryStatus(brain),
      execution: gateStatus(brain.modelCanExecute),
      fallback: fallbackStatus(brain),
      legacyClientMemoryWrites: gateStatus(brain.legacyClientMemoryWritesAllowed),
      persistence: configurationStatus(brain.persistentRootConfigured),
      snapshotSafety: snapshotSafetyStatus(brain)
    },
    connectors: {
      carrierFollowUp: configurationStatus(carrierFollowUp.available),
      claimFiling: configurationStatus(claimFiling.available),
      clientCoordinator: configurationStatus(clientCoordinator.available),
      gmail: configurationStatus(source.gmailConfigured),
      googleCalendar: configurationStatus(scheduling.googleCalendarConfigured),
      googleOAuth: configurationStatus(userOAuth.available),
      jobNimbus: configurationStatus(source.jobNimbusConfigured),
      quo: configurationStatus(source.quoConfigured),
      realtimeVoice: configurationStatus(voice.available)
    },
    controls: {
      actionBatchOnly: gateStatus(codexOperator.actionBatchOnly),
      automaticEmailOrTextSending: gateStatus(outboundSafety.automaticEmailOrTextSending),
      changedPayloadInvalidatesApproval: gateStatus(outboundSafety.changedPayloadInvalidatesApproval),
      claimFilingApprovalLane: gateStatus(codexOperator.claimFilingApprovalLane),
      directEffectRoutes: gateStatus(codexOperator.directUnapprovedWriteUploadSendOrCallRoutes),
      exactDryRunDigestRequired: gateStatus(outboundSafety.exactDryRunDigestRequired),
      explicitChanceApprovalRequired: gateStatus(outboundSafety.explicitChanceApprovalRequired),
      jobNimbusWritesActionBatchOnly: gateStatus(codexOperator.jobNimbusWritesActionBatchOnly),
      modelCanExecute: gateStatus(brain.modelCanExecute),
      roleEnforcement: gateStatus(userOAuth.roleEnforcement),
      schedulingFailClosed: gateStatus(scheduling.failClosed),
      shortLivedSingleUseChallengeRequired: gateStatus(
        outboundSafety.shortLivedSingleUseChallengeRequired
      )
    },
    gates: {
      carrierFollowUpCalls: gateStatus(carrierFollowUp.callsAllowed),
      claimFilingCalls: gateStatus(claimFiling.callsAllowed),
      clientCoordinatorAppointmentCalls: gateStatus(clientCoordinator.appointmentCallsAllowed),
      clientCoordinatorExpandedCalls: gateStatus(clientCoordinator.expandedModesAllowed),
      externalWrites: gateStatus(source.writesAllowed),
      gmailSend: gateStatus(source.gmailSendAllowed),
      hcnActionExecution: gateStatus(hcnActions.executionGateEnabled),
      quoSend: gateStatus(source.quoSendAllowed),
      realtimeVoiceCalls: gateStatus(voice.callsAllowed)
    },
    configurationDrift: buildRuntimeGateDrift(runtime)
  };
}

export function buildRuntimeGateDrift(runtime = {}) {
  const source = safeObject(runtime);
  const releaseGates = safeObject(source.releaseGates);
  const observed = Object.fromEntries(
    RELEASE_GATE_KEYS.map((key) => [key, booleanOrNull(releaseGates[key])])
  );
  const differences = RELEASE_GATE_KEYS
    .filter((key) => observed[key] !== null && observed[key] !== RELEASE_GATE_DEFAULTS[key])
    .map((key) => ({
      key,
      checkedIn: gateStatus(RELEASE_GATE_DEFAULTS[key]),
      runtime: gateStatus(observed[key])
    }));
  const unknown = RELEASE_GATE_KEYS
    .filter((key) => observed[key] === null)
    .sort();
  return {
    scope: "release_critical_effect_gates",
    monitoredKeys: RELEASE_GATE_KEYS,
    status: differences.length ? "detected" : unknown.length ? "unknown" : "aligned",
    differences,
    unknown
  };
}

export function hashDescriptor(descriptor) {
  const withoutExistingHash = safeObject(descriptor);
  const value = { ...withoutExistingHash };
  delete value.descriptorHash;
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function normalizeIdentity(identity) {
  const candidate = safeObject(identity);
  const role = normalizeRole(candidate.role);

  if (
    candidate.enabled !== false
    && candidate.type === "codex_operator_token"
    && role === "codex_operator"
  ) {
    return {
      authentication: "authenticated",
      type: "codex_operator",
      role: "codex_operator",
      subject: String(candidate.subject || ""),
      jobNimbusScope: "assigned",
      gmailMode: "exact_assigned_file_evidence"
    };
  }

  if (
    candidate.enabled !== false
    && candidate.type === "google_oauth"
    && GOOGLE_ROLES.has(role)
  ) {
    return {
      authentication: "authenticated",
      type: "google_oauth",
      role,
      jobNimbusScope: normalizeJobNimbusScope(candidate.jobNimbusScope, role),
      gmailMode: "signed_in_employee_mailbox"
    };
  }

  if (
    candidate.enabled !== false
    && candidate.type === "hcn_browser_session"
    && GOOGLE_ROLES.has(role)
  ) {
    const isChance = role === "chance";
    return {
      authentication: "authenticated",
      type: "hcn_browser_session",
      role,
      jobNimbusScope: isChance ? "assigned" : "none",
      gmailMode: isChance ? "exact_assigned_file_evidence" : "none"
    };
  }

  return {
    authentication: "unsupported",
    type: "unsupported",
    role: "unsupported",
    jobNimbusScope: "none",
    gmailMode: "none"
  };
}

function normalizeRole(value) {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GOOGLE_ROLES.has(role) || role === "codex_operator" ? role : "unsupported";
}

function normalizeJobNimbusScope(value, role) {
  const scope = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (scope === "assigned" || scope === "company") return scope;
  return role === "chance" ? "assigned" : "company";
}

function advisoryStatus(brain) {
  if (brain.operationalProviderConfigured === true) return "configured";
  if (brain.operationalProviderConfigured === false) return "unconfigured";
  if (brain.optionalModelAdvisory === false) return "disabled";
  return "unknown";
}

function fallbackStatus(brain) {
  if (brain.fallbackProviderConfigured === true) return "configured";
  if (brain.fallbackProvider === "disabled" || brain.optionalModelAdvisory === false) return "disabled";
  if (brain.fallbackProviderConfigured === false) return "unconfigured";
  return "unknown";
}

function clientMemoryStatus(brain) {
  if (
    brain.codexOperatorClientMemory === "disabled_no_read_no_write"
    || brain.codexOperatorClientMemory === "disabled"
  ) {
    return "disabled";
  }
  if (brain.clientSnapshots === "legacy_v1_unsafe_until_migrated") return "legacy_restricted";
  if (brain.clientSnapshots === "hcn_v2_minimized") return "hcn_v2_minimized";
  return "unknown";
}

function snapshotSafetyStatus(brain) {
  if (
    brain.mode === "legacy_v1_client_snapshot_persistence_requires_v2_privacy_migration"
    || brain.clientSnapshots === "legacy_v1_unsafe_until_migrated"
  ) {
    return "migration_required";
  }
  if (brain.mode === "hcn_v2" || brain.clientSnapshots === "hcn_v2_minimized") return "current";
  return "unknown";
}

function configurationStatus(value) {
  if (value === true) return "configured";
  if (value === false) return "unconfigured";
  return "unknown";
}

function gateStatus(value) {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "unknown";
}

function booleanOrNull(value) {
  return value === true || value === false ? value : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function capability(name, route) {
  return Object.freeze({ name, route });
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
