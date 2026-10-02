import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../skills/jobnimbus-operator/SKILL.md", import.meta.url);
const serverUrl = new URL("./server.mjs", import.meta.url);
const coordinatorUrl = new URL("./operator-coordinator.mjs", import.meta.url);
const scopeUrl = new URL("./scope.mjs", import.meta.url);

test("status payload documentation uses reference-level provider evidence", async () => {
  const skill = await readFile(skillUrl, "utf8");
  const statusSection = skill.match(
    /`jobnimbus\.update_status`:[\s\S]*?`jobnimbus\.ensure_current_task`:/
  )?.[0] || "";

  assert.match(statusSection, /"gate": "requiredGateName"/);
  assert.doesNotMatch(statusSection, /"gates"\s*:/);
  assert.match(statusSection, /booleans are not evidence/i);
  assert.match(statusSection, /derives confirmed gates only after freshly reading/i);
});

test("status evidence documentation pins only provider-verifiable sources", async () => {
  const skill = await readFile(skillUrl, "utf8");
  const statusSection = skill.match(
    /`jobnimbus\.update_status`:[\s\S]*?`jobnimbus\.ensure_current_task`:/
  )?.[0] || "";
  const expectedSources = [
    "jobnimbus_activity",
    "gmail_message",
    "quo_message"
  ];
  const disallowedSources = [
    "operator_readback",
    "jobnimbus_task",
    "jobnimbus_document",
    "quo_call",
    "manager_decision",
    "signed_document",
    "carrier_document",
    "accounting_record"
  ];

  for (const source of expectedSources) assert.match(statusSection, new RegExp("`" + source + "`"));
  for (const source of disallowedSources) assert.doesNotMatch(statusSection, new RegExp("`" + source + "`"));
  assert.match(statusSection, /negative, unknown, waiting, or pending language is rejected/i);
  assert.match(statusSection, /document metadata cannot prove a gate/i);
  for (const phrase of [
    "request",
    "requested",
    "checklist",
    "template",
    "draft",
    "proposed",
    "planned"
  ]) {
    assert.match(statusSection, new RegExp("`" + phrase + "`"));
  }
});

test("status evidence documentation pins exact provider-record eligibility", async () => {
  const skill = await readFile(skillUrl, "utf8");
  const statusSection = skill.match(
    /`jobnimbus\.update_status`:[\s\S]*?`jobnimbus\.ensure_current_task`:/
  )?.[0] || "";

  assert.match(statusSection, /exact related \*\*Note\*\*/i);
  assert.match(statusSection, /not deleted, archived, or explicitly inactive/i);
  assert.match(statusSection, /Events and appointments are not stage evidence/i);
  for (const label of ["DRAFT", "TRASH", "SPAM"]) {
    assert.match(statusSection, new RegExp("`" + label + "`"));
  }
  assert.match(statusSection, /mixed-file\/mixed-claim evidence and is blocked/i);
  assert.match(statusSection, /inbound with status `received` or `delivered`/i);
  assert.match(statusSection, /outbound with status `sent`, `delivered`, or `completed`/i);
  assert.match(statusSection, /Blank status, `queued`, `failed`, and `canceled` are blocked/i);
});

test("manual reconciliation tool is exact-batch and never an automatic retry", async () => {
  const [skill, server, coordinator] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(serverUrl, "utf8"),
    readFile(coordinatorUrl, "utf8")
  ]);

  assert.match(server, /"action_batch_reconcile"/);
  assert.match(coordinator, /"\/ops\/action-batch-reconcile"/);
  assert.match(server, /batchId: z\.string\(\)\.uuid\(\)/);
  assert.match(server, /never retries, resumes, executes/i);
  assert.match(skill, /Reconciliation only re-reads provider state/i);
  assert.match(skill, /retry nothing automatically/i);
  assert.match(skill, /`manual_quarantined` with outcome `unknown_file_quarantined`/i);
  assert.match(skill, /never retry that batch or action/i);
  assert.match(skill, /Scope `files` carries a blank singular value and a nonempty unique numeric list/i);
  assert.match(skill, /Scope `global` carries a blank singular value and an empty list/i);
  assert.match(skill, /never call reconciliation on it again/i);
});

test("plugin documentation pins build, dual lanes, runtime gates, and fresh action attestation", async () => {
  const [skill, readme, coordinator, scope, server] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(coordinatorUrl, "utf8"),
    readFile(scopeUrl, "utf8"),
    readFile(serverUrl, "utf8")
  ]);

  for (const document of [skill, readme]) {
    assert.match(document, /provider-attested/i);
    assert.match(document, /exact pinned bridge (?:source )?commit/i);
    assert.match(document, /actionBatchOnly.*disabled/is);
    assert.match(document, /jobNimbusWritesActionBatchOnly.*enabled/is);
    assert.match(document, /claimFilingApprovalLane.*enabled/is);
    assert.match(document, /directEffectRoutes.*disabled/is);
    assert.match(document, /JobNimbus, Gmail, and claim-filing connectors.*configured/i);
    assert.match(document, /externalWrites.*enabled/is);
    assert.match(document, /Only `?claimFilingCalls`?.*enabled/is);
    assert.match(document, /send, generic.*call, and HCN action gate.*disabled/is);
    assert.match(document, /gmail\.send_existing_draft/);
    assert.match(document, /(?:sole-operation|only operation).*separate|separate.*(?:sole-operation|only operation)/is);
    assert.match(document, /raw.*send.*(?:blocked|unavailable|impossible)|(?:blocked|unavailable|impossible).*raw.*send/is);
    assert.match(document, /six-receipt historical-isolation/i);
    assert.match(document, /never[- ]replay/i);
    assert.match(document, /manual risk acceptance/i);
    assert.match(document, /fresh(?:ly)?.*(?:attest|attestation).*(?:before|precedes).*plan|before.*plan.*fresh(?:ly)?.*(?:attest|attestation)/is);
    assert.match(document, /re-attest.*before.*execution/is);
    assert.match(document, /boot.*build.*policy.*isolation.*runtime.*(?:change|boundary)/is);
  }
  assert.match(scope, /sourceCommit: APPROVED_NOTES_ENABLED \? ACTIVE_RELEASE\.bridgeCommit : "[a-f0-9]{40}"/);
  assert.match(scope, /const ACTIVE_RELEASE = PDF_UPLOADS_ENABLED \? PDF_UPLOAD_RELEASE : APPROVED_NOTE_RELEASE/);
  assert.match(scope, /EXPECTED_OPERATOR_CAPABILITIES/);
  assert.match(coordinator, /attestedBoundary: canonical\(attestedBoundary\)/);
  assert.match(coordinator, /pending\.attestedBoundary !== canonical\(currentBoundary\)/);
  assert.match(readme, /hard-pins that HTTPS origin/i);
  assert.match(server, /const BASE_URL = "https:\/\/jobnimbus-chatgpt-bridge\.onrender\.com"/);
  assert.doesNotMatch(server, /JOBNIMBUS_OPERATOR_BASE_URL/);
  assert.match(coordinator, /reconcileActionBatch[\s\S]*verifiedBridgeSession\(\)/);
});

test("Retell documentation and server expose only the approval-gated single-file claim lane", async () => {
  const [skill, readme, coordinator, server] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(coordinatorUrl, "utf8"),
    readFile(serverUrl, "utf8")
  ]);

  for (const document of [skill, readme]) {
    assert.match(document, /single-file.*Retell claim|Retell claim.*single-file/is);
    assert.match(document, /includeCarrierBatch:false/);
    assert.match(document, /file_new_claim/);
    assert.match(document, /find_existing_claim/);
    assert.match(document, /automaticJobNimbusWriteback:false|never automatically updates JobNimbus/i);
    assert.match(document, /claim.*writeback.*not exposed|does not expose `?\/claim-filing\/writeback`?/is);
    assert.match(document, /complete.*(?:packet|plan).*planDigest.*approvalId|planDigest.*approvalId/is);
    assert.match(document, /explicit.*approv/is);
  }
  for (const tool of [
    "retell_claim_configuration_verify",
    "retell_claim_call_plan",
    "retell_claim_call_execute",
    "retell_claim_call_get",
    "retell_claim_pending_callbacks"
  ]) {
    assert.match(server, new RegExp(`"${tool}"`));
  }
  assert.doesNotMatch(server, /register\(\s*"retell_claim.*writeback"/);
  assert.match(coordinator, /includeCarrierBatch: false/);
  assert.match(coordinator, /approvals\.delete\(exactApprovalId\)/);
  assert.match(coordinator, /"\/claim-filing\/configuration"/);
  assert.match(coordinator, /"\/claim-filing\/prepare"/);
  assert.match(coordinator, /"\/claim-filing\/call"/);
  assert.match(coordinator, /"\/claim-filing\/result"/);
  assert.match(coordinator, /"\/claim-filing\/callbacks"/);
  assert.doesNotMatch(coordinator, /"\/claim-filing\/writeback"/);
});

test("startup permits only enumerated receipt recovery before full readiness", async () => {
  const skill = await readFile(skillUrl, "utf8");

  assert.match(skill, /Do not initially require `ready:true`/i);
  assert.match(skill, /`recoveryBoundaryAttested:true`/);
  assert.match(skill, /`recoveryAllowed:true`/);
  assert.match(skill, /`hardBlockedCount` is zero/i);
  assert.match(skill, /reconciliation-eligible batch IDs exactly equal all unresolved batch IDs/i);
  assert.match(skill, /If any hard-blocked batch exists, stop all work/i);
  assert.match(skill, /`recoveryBoundary\.status` equal to `ready` with no error/i);
  assert.match(skill, /Rerun `bridge_restart_verify` after reconciliation/i);
  assert.match(skill, /Any not-ready cause other than enumerated unresolved receipts is a hard stop/i);
});
