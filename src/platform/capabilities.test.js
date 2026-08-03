import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_ROUTE_REGISTRY,
  buildCapabilityDescriptor,
  buildRuntimeStatus,
  capabilitiesForIdentity,
  hashDescriptor
} from "./capabilities.js";

test("Codex operator descriptor names exactly the existing least-privilege routes", () => {
  const capabilities = capabilitiesForIdentity({
    type: "codex_operator_token",
    role: "codex_operator",
    jobNimbusScope: "company"
  });

  assert.deepEqual(capabilities, [
    "gmail.attachments.review",
    "gmail.messages.search",
    "gmail.threads.read",
    "identity.read",
    "jobnimbus.contacts.search",
    "jobnimbus.documents.attach_to_chat",
    "jobnimbus.documents.review",
    "jobnimbus.documents.text.read",
    "jobnimbus.files.review",
    "operations.action_batch.process",
    "operations.files.review",
    "operations.session.start",
    "platform.session.read",
    "quo.history.read",
    "quo.lines.read",
    "quo.transcripts.read",
    "scheduling.availability.review"
  ]);

  const descriptor = buildCapabilityDescriptor({
    identity: { type: "codex_operator_token", role: "codex_operator" }
  });
  assert.equal(descriptor.identity.jobNimbusScope, "assigned");
  assert.equal(descriptor.authorizedCapabilities.includes("brain.context.read"), false);
  assert.equal(descriptor.authorizedCapabilities.includes("memory.file_actions.read"), false);
  assert.equal(descriptor.authorizedCapabilities.includes("memory.persistence.probe"), false);
  assert.equal(descriptor.authorizedCapabilities.includes("gmail.drafts.send"), false);
  assert.equal(descriptor.authorizedCapabilities.includes("jobnimbus.documents.upload"), false);
  assert.equal(descriptor.authorizedCapabilities.includes("voice.call.place"), false);
});

test("only the exact scoped HP operator advertises the fixed management read capabilities", () => {
  const hpCapabilities = capabilitiesForIdentity({
    type: "codex_operator_token",
    subject: "codex-hp-operator",
    role: "codex_operator",
    scopes: [
      "client_evidence:read",
      "management_sweep:read",
      "approval_batches:prepare_execute"
    ]
  });
  assert.equal(
    hpCapabilities.includes("hcn.management_sweep.read"),
    true
  );
  assert.equal(
    hpCapabilities.includes("hcn.closed_file_benchmark.read"),
    true
  );

  for (const identity of [
    {
      type: "codex_operator_token",
      subject: "codex-mac-operator",
      role: "codex_operator",
      scopes: [
        "client_evidence:read",
        "management_sweep:read"
      ]
    },
    {
      type: "codex_operator_token",
      subject: "codex-hp-operator",
      role: "codex_operator",
      scopes: ["client_evidence:read"]
    },
    {
      type: "codex_operator_token",
      subject: "spoofed-operator",
      role: "codex_operator",
      scopes: ["management_sweep:read"]
    }
  ]) {
    assert.equal(
      capabilitiesForIdentity(identity).includes(
        "hcn.management_sweep.read"
      ),
      false
    );
    assert.equal(
      capabilitiesForIdentity(identity).includes(
        "hcn.closed_file_benchmark.read"
      ),
      false
    );
  }
});

test("Google roles are normalized to named capabilities without wildcard authority", () => {
  const onboarding = buildCapabilityDescriptor({
    identity: { type: "google_oauth", role: "onboarding" }
  });
  assert.deepEqual(onboarding.authorizedCapabilities, ["identity.read", "platform.session.read", "quo.line.link"]);

  const coordinator = buildCapabilityDescriptor({
    identity: { type: "google_oauth", role: "client_coordinator" }
  });
  assert.equal(coordinator.authorizedCapabilities.includes("jobnimbus.contacts.search"), true);
  assert.equal(coordinator.authorizedCapabilities.includes("retell.client_coordinator.call.place"), true);
  assert.equal(coordinator.authorizedCapabilities.includes("gmail.drafts.send"), false);
  assert.equal(coordinator.authorizedCapabilities.includes("jobnimbus.contacts.update"), false);

  const chance = buildCapabilityDescriptor({
    identity: { type: "google_oauth", role: "chance" }
  });
  const nonHcnCapabilityCount = new Set(
    CAPABILITY_ROUTE_REGISTRY
      .filter(({ route }) => !route.includes(" /hcn/"))
      .map(({ name }) => name)
  ).size;
  assert.equal(chance.authorizedCapabilities.length, nonHcnCapabilityCount);
  assert.equal(chance.authorizedCapabilities.includes("gmail.drafts.send"), true);
  assert.equal(chance.authorizedCapabilities.includes("claims.filing.call.place"), true);
  assert.equal(chance.authorizedCapabilities.includes("hcn.work_center.read"), false);
  assert.equal(chance.authorizedCapabilities.includes("hcn.file.review"), false);
  assert.equal(JSON.stringify(chance).includes("allRoutes"), false);
  assert.equal(JSON.stringify(chance).includes('"*"'), false);
});

test("the advertised registry has no Chance Brain or legacy-memory route", () => {
  const serialized = JSON.stringify(CAPABILITY_ROUTE_REGISTRY);
  assert.doesNotMatch(serialized, /brain\.context|memory\.file_actions|memory\.persistence/i);
  assert.doesNotMatch(serialized, /\/brain\/|\/memory\//i);
});

test("HCN browser capability metadata is intersected with the console surface", () => {
  const browser = buildCapabilityDescriptor({
    identity: {
      type: "hcn_browser_session",
      role: "chance",
      subject: "private-google-subject",
      email: "private@example.test",
      googleAccessToken: "private-provider-token"
    }
  });

  assert.deepEqual(browser.authorizedCapabilities, [
    "hcn.action_plans.execute",
    "hcn.action_plans.invalidate",
    "hcn.action_plans.prepare",
    "hcn.action_plans.read",
    "hcn.action_receipts.read",
    "hcn.assistant.conversations.manage",
    "hcn.assistant.conversations.read",
    "hcn.assistant.turn",
    "hcn.closed_file_benchmark.read",
    "hcn.connectors.google.disconnect",
    "hcn.connectors.google.link",
    "hcn.connectors.quo_line.link",
    "hcn.connectors.read",
    "hcn.file.review",
    "hcn.management_sweep.read",
    "hcn.work_center.read",
    "platform.session.read"
  ]);
  assert.deepEqual(browser.identity, {
    authentication: "authenticated",
    type: "hcn_browser_session",
    role: "chance",
    jobNimbusScope: "assigned",
    gmailMode: "per_user_connector_required"
  });
  assert.doesNotMatch(JSON.stringify(browser), /private-google-subject|private@example|private-provider-token/);
});

test("non-Chance HCN browser sessions receive only their reviewed employee capabilities", () => {
  const cases = {
    administrator: [
      "hcn.action_plans.execute",
      "hcn.action_plans.invalidate",
      "hcn.action_plans.prepare",
      "hcn.action_plans.read",
      "hcn.action_receipts.read",
      "hcn.assistant.conversations.manage",
      "hcn.assistant.conversations.read",
      "hcn.assistant.turn",
      "hcn.closed_file_benchmark.read",
      "hcn.connectors.google.disconnect",
      "hcn.connectors.google.link",
      "hcn.connectors.quo_line.link",
      "hcn.connectors.read",
      "hcn.file.review",
      "hcn.management_sweep.read",
      "hcn.work_center.read",
      "platform.session.read"
    ],
    employee: [
      "hcn.action_plans.execute",
      "hcn.action_plans.invalidate",
      "hcn.action_plans.prepare",
      "hcn.action_plans.read",
      "hcn.action_receipts.read",
      "hcn.assistant.conversations.manage",
      "hcn.assistant.conversations.read",
      "hcn.assistant.turn",
      "hcn.connectors.google.disconnect",
      "hcn.connectors.google.link",
      "hcn.connectors.quo_line.link",
      "hcn.connectors.read",
      "hcn.file.review",
      "hcn.work_center.read",
      "platform.session.read"
    ],
    onboarding: [
      "hcn.connectors.google.disconnect",
      "hcn.connectors.google.link",
      "hcn.connectors.quo_line.link",
      "hcn.connectors.read",
      "platform.session.read"
    ],
    client_coordinator: [
      "hcn.action_plans.execute",
      "hcn.action_plans.invalidate",
      "hcn.action_plans.prepare",
      "hcn.action_plans.read",
      "hcn.action_receipts.read",
      "hcn.assistant.conversations.manage",
      "hcn.assistant.conversations.read",
      "hcn.assistant.turn",
      "hcn.connectors.google.disconnect",
      "hcn.connectors.google.link",
      "hcn.connectors.quo_line.link",
      "hcn.connectors.read",
      "hcn.file.review",
      "hcn.work_center.read",
      "platform.session.read"
    ],
    manager: [
      "hcn.action_plans.execute",
      "hcn.action_plans.invalidate",
      "hcn.action_plans.prepare",
      "hcn.action_plans.read",
      "hcn.action_receipts.read",
      "hcn.assistant.conversations.manage",
      "hcn.assistant.conversations.read",
      "hcn.assistant.turn",
      "hcn.closed_file_benchmark.read",
      "hcn.connectors.google.disconnect",
      "hcn.connectors.google.link",
      "hcn.connectors.quo_line.link",
      "hcn.connectors.read",
      "hcn.file.review",
      "hcn.management_sweep.read",
      "hcn.work_center.read",
      "platform.session.read"
    ]
  };
  for (const [role, capabilities] of Object.entries(cases)) {
    const browser = buildCapabilityDescriptor({
      identity: { type: "hcn_browser_session", role }
    });
    assert.deepEqual(browser.authorizedCapabilities, capabilities, role);
    assert.deepEqual(browser.identity, {
      authentication: "authenticated",
      type: "hcn_browser_session",
      role,
      jobNimbusScope: "assigned",
      gmailMode: "per_user_connector_required"
    });
  }
});

test("unsupported or spoofed identities fail closed", () => {
  for (const identity of [
    null,
    { type: "bridge_token", role: "chance" },
    { type: "google_oauth", role: "codex_operator" },
    { type: "codex_operator_token", role: "chance" },
    { type: "google_oauth", role: "manager", enabled: false },
    { type: "something_else", role: "administrator" }
  ]) {
    const descriptor = buildCapabilityDescriptor({ identity });
    assert.deepEqual(descriptor.authorizedCapabilities, []);
    assert.deepEqual(descriptor.identity, {
      authentication: "unsupported",
      type: "unsupported",
      role: "unsupported",
      jobNimbusScope: "none",
      gmailMode: "none"
    });
  }
});

test("runtime output contains only normalized booleans-as-statuses and reviewed enums", () => {
  const status = buildRuntimeStatus({
    jobNimbusConfigured: true,
    gmailConfigured: false,
    quoConfigured: "a-secret-is-not-a-boolean",
    writesAllowed: true,
    gmailSendAllowed: false,
    quoSendAllowed: undefined,
    releaseGates: {
      ALLOW_CARRIER_FOLLOWUP_CALLS: true,
      ALLOW_CLIENT_COORDINATOR_CALLS: false,
      ALLOW_GMAIL_SEND: false,
      ALLOW_QUO_SEND: undefined,
      ALLOW_RETELL_CALLS: true,
      ALLOW_VOICE_CALLS: false,
      BRIDGE_ALLOW_WRITES: true,
      HCN_ACTION_EXECUTION_ENABLED: false
    },
    hcnActions: {
      executionGateEnabled: false
    },
    userOAuth: {
      available: true,
      roleEnforcement: true
    },
    codexOperator: {
      actionBatchOnly: true,
      directWriteUploadSendOrCallRoutes: false
    },
    outboundSafety: {
      automaticEmailOrTextSending: false,
      explicitChanceApprovalRequired: true,
      exactDryRunDigestRequired: true,
      shortLivedSingleUseChallengeRequired: true,
      changedPayloadInvalidatesApproval: true
    },
    schedulingAvailability: {
      googleCalendarConfigured: true,
      failClosed: true
    },
    hcnConsole: {
      managementSweep: {
        configured: true,
        ready: true
      }
    },
    hcnAssistant: {
      deterministicReady: true,
      historyReady: true,
      ready: false
    },
    hcnOperationsBrain: {
      contractsAvailable: true,
      operationalProviderConfigured: false,
      optionalModelAdvisory: false,
      persistenceConfigured: false,
      modelCanExecute: false,
      externalActions: false,
      thresherRulesAvailable: true
    }
  });

  assert.equal(status.connectors.jobNimbus, "configured");
  assert.equal(status.connectors.managementSweep, "configured");
  assert.equal(status.connectors.gmail, "unconfigured");
  assert.equal(status.connectors.quo, "unknown");
  assert.equal(status.assistant.availability, "unconfigured");
  assert.equal(status.assistant.directReads, "configured");
  assert.equal(status.assistant.durableHistory, "configured");
  assert.equal(status.gates.externalWrites, "enabled");
  assert.equal(status.gates.gmailSend, "disabled");
  assert.equal(status.gates.hcnActionExecution, "disabled");
  assert.equal(status.gates.quoSend, "unknown");
  assert.equal(status.controls.actionBatchOnly, "enabled");
  assert.equal(status.controls.directEffectRoutes, "disabled");
  assert.equal(status.hcnOperationsBrain.advisory, "disabled");
  assert.equal(status.hcnOperationsBrain.contracts, "configured");
  assert.equal(status.hcnOperationsBrain.execution, "disabled");
  assert.equal(status.hcnOperationsBrain.externalActions, "disabled");
  assert.equal(status.hcnOperationsBrain.persistence, "unconfigured");
  assert.equal(status.hcnOperationsBrain.thresherRules, "configured");
  assert.equal("brain" in status, false);
  assert.doesNotMatch(
    JSON.stringify(status.hcnOperationsBrain),
    /legacy|chance|snapshot/i
  );
  assert.equal(status.configurationDrift.scope, "release_critical_effect_gates");
  assert.equal(status.configurationDrift.monitoredKeys.length, 8);
  assert.equal(status.configurationDrift.status, "detected");
  assert.deepEqual(status.configurationDrift.differences, [
    {
      key: "ALLOW_CARRIER_FOLLOWUP_CALLS",
      checkedIn: "disabled",
      runtime: "enabled"
    },
    {
      key: "ALLOW_GMAIL_SEND",
      checkedIn: "enabled",
      runtime: "disabled"
    },
    {
      key: "ALLOW_RETELL_CALLS",
      checkedIn: "disabled",
      runtime: "enabled"
    },
    {
      key: "HCN_ACTION_EXECUTION_ENABLED",
      checkedIn: "enabled",
      runtime: "disabled"
    }
  ]);
  assert.deepEqual(status.configurationDrift.unknown, ["ALLOW_QUO_SEND"]);
  assert.equal(buildRuntimeStatus(null).connectors.jobNimbus, "unknown");
  assert.equal(
    buildRuntimeStatus(null).connectors.managementSweep,
    "unknown"
  );
  assert.equal(
    buildRuntimeStatus({
      hcnConsole: {
        managementSweep: {
          configured: true,
          ready: false
        }
      }
    }).connectors.managementSweep,
    "unconfigured"
  );
});

test("identity and runtime secrets, contact data, and arbitrary strings cannot leak", () => {
  const secretValues = [
    "bearer-very-sensitive-value",
    "person-private@example.test",
    "+1-555-867-5309",
    "provider-secret-value",
    "google-refresh-sensitive-value",
    "private-subject-identifier",
    "Chance Private Name"
  ];
  const identity = {
    type: "google_oauth",
    role: "manager",
    jobNimbusScope: "company",
    token: secretValues[0],
    email: secretValues[1],
    phone: secretValues[2],
    subject: secretValues[5],
    name: secretValues[6],
    googleAccessToken: secretValues[4]
  };
  const runtime = {
    jobNimbusConfigured: true,
    gmailConfigured: true,
    quoConfigured: true,
    apiKey: secretValues[3],
    nestedSecrets: {
      token: secretValues[0],
      email: secretValues[1],
      phone: secretValues[2]
    },
    hcnOperationsBrain: {
      contractsAvailable: true,
      operationalProviderConfigured: true,
      operationalProvider: secretValues[3],
      apiKey: secretValues[3]
    },
    userOAuth: {
      available: true,
      clientSecret: secretValues[3],
      refreshToken: secretValues[4]
    }
  };

  const descriptor = buildCapabilityDescriptor({ identity, runtime });
  const serialized = JSON.stringify(descriptor);
  for (const secret of secretValues) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(serialized.includes("googleAccessToken"), false);
  assert.equal(serialized.includes("clientSecret"), false);
  assert.equal(serialized.includes("refreshToken"), false);
  assert.equal(serialized.includes('"email"'), false);
  assert.equal(serialized.includes('"phone"'), false);
  assert.equal(serialized.includes('"subject"'), false);
});

test("descriptor hashes are deterministic, stable under input noise, and configuration-sensitive", () => {
  const identityA = {
    email: "first@example.test",
    type: "google_oauth",
    role: "manager",
    jobNimbusScope: "company"
  };
  const identityB = {
    jobNimbusScope: "company",
    role: "manager",
    type: "google_oauth",
    email: "different@example.test",
    token: "different-token"
  };
  const runtimeA = {
    writesAllowed: false,
    gmailConfigured: true,
    jobNimbusConfigured: true,
    ignored: "first-secret"
  };
  const runtimeB = {
    ignored: "second-secret",
    jobNimbusConfigured: true,
    gmailConfigured: true,
    writesAllowed: false
  };

  const first = buildCapabilityDescriptor({ identity: identityA, runtime: runtimeA });
  const second = buildCapabilityDescriptor({ identity: identityB, runtime: runtimeB });
  assert.match(first.descriptorHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.descriptorHash, second.descriptorHash);
  assert.equal(hashDescriptor(first), first.descriptorHash);

  const changed = buildCapabilityDescriptor({
    identity: identityA,
    runtime: { ...runtimeA, writesAllowed: true }
  });
  assert.notEqual(changed.descriptorHash, first.descriptorHash);
  assert.deepEqual(first.authorizedCapabilities, [...first.authorizedCapabilities].sort());
});
