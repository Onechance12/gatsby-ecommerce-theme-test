import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHcnInvitationStore } from "../auth/hcn-invitation-store.js";
import { signJobroloHcnRequest } from "../integrations/jobrolo-service-auth.js";

const EMAIL = "claim.pilot@wavepa.com";
const SUBJECT = "claim-pilot-google-subject";
const SECOND_PILOT_SUBJECT = "claim-pilot-second-google-subject";
const OWNER_ID = "claim-pilot-jobnimbus-owner";
const REFERENCE_KEY = Buffer.alloc(32, 0x61).toString("base64url");
const JOBROLO_CLAIM_CLIENT_ID = "jobrolo-claim-filing-http-fixture";
const JOBROLO_CLAIM_SHARED_SECRET =
  "jobrolo-claim-filing-http-fixture-secret-123456789";
const JOBROLO_GENERAL_CLIENT_ID = "jobrolo-general-http-fixture";
const JOBROLO_GENERAL_SHARED_SECRET =
  "jobrolo-general-http-fixture-secret-123456789";
const CONFIRMATIONS = Object.freeze({
  damageOpening: "Hail damaged the roof and exterior soft metals.",
  damageDetails: ["roof hail damage", "gutter dents"],
  injuries: "no_injuries_reported",
  homeLivable: "livable",
  temporaryRepairs: "none_made",
  contractorHired: "none_hired",
  carrierPhone: ""
});

test("non-pilot employee is denied by the dedicated claim preparation route", async (t) => {
  const fixture = await startFixture(t, { pilot: false });
  const session = await loginAndCreateFileChat(fixture);
  const statusResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/status",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef
    }
  );
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(
    await statusResponse.json().then((value) => value.eligible),
    false
  );
  const response = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  assert.equal(response.status, 403);
  assert.match(
    (await response.json()).error,
    /not enabled for the internal claim-filing pilot/i
  );
  assert.deepEqual(fixture.providerMutations, []);
});

test("claim preparation is exact-file, missing-fact, assignment, and stale-plan fail closed", async (t) => {
  const fixture = await startFixture(t, { pilot: true });
  const session = await loginAndCreateFileChat(fixture);
  const statusResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/status",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef
    }
  );
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.eligible, true);
  assert.equal(status.callsEnabled, false);
  assert.equal(status.writebackConfigured, false);


  fixture.contact.cf_string_3 = "";
  const missingResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  assert.equal(missingResponse.status, 200);
  const missing = await missingResponse.json();
  assert.equal(missing.review.ready, false);
  assert.equal(missing.plan, null);
  assert.equal(
    missing.review.missingFacts.some(
      (item) => item.code === "policy_number"
    ),
    true
  );

  fixture.contact.cf_string_3 = "POLICY-100";
  const preparedResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  assert.equal(preparedResponse.status, 200);
  const prepared = await preparedResponse.json();
  assert.equal(prepared.review.ready, true);
  assert.equal(prepared.callsEnabled, false);
  assert.match(prepared.review.planDigest, /^[a-f0-9]{64}$/);
  assert.match(prepared.plan.planId, /^plan_[a-f0-9]{32}$/);
  assert.equal(prepared.plan.status, "pending");
  assert.deepEqual(
    prepared.review.employeeConfirmedFacts.damageDetails,
    CONFIRMATIONS.damageDetails
  );
  assert.equal(prepared.authority.modelCanExecute, false);
  assert.equal(prepared.authority.legacyClaimRoutesExposed, false);
  assert.equal(
    prepared.review.stopRules.some((rule) =>
      /information not verified in the packet/i.test(rule)
    ),
    true
  );
  const callsDisabledResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/execute",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      planId: prepared.plan.planId,
      approvalDigest: prepared.review.planDigest
    }
  );
  assert.equal(callsDisabledResponse.status, 503);

  fixture.contact.cf_date_1 = "2026-05-02";
  const changedResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  assert.equal(changedResponse.status, 200);
  const changed = await changedResponse.json();
  assert.notEqual(changed.review.planDigest, prepared.review.planDigest);
  assert.equal(changed.plan.status, "pending");

  const generalConversation = await createConversation(
    fixture,
    session,
    { kind: "general", title: "Not a file chat", fileRef: "" }
  );
  const crossScopeResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: generalConversation.conversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  assert.equal(crossScopeResponse.status, 404);

  fixture.contact.owners = [{ id: "another-owner" }];
  const reassignedResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  assert.equal(reassignedResponse.status, 404);
  assert.deepEqual(fixture.providerMutations, []);
});

test("approved call is single-use, opaque, result-only, and stale plans never call", async (t) => {
  const fixture = await startFixture(t, {
    pilot: true,
    callsEnabled: true
  });
  const session = await loginAndCreateFileChat(fixture);
  const preparedResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  const prepared = await preparedResponse.json();
  assert.equal(prepared.review.ready, true);
  const executeInput = {
    conversationRef: session.fileConversationRef,
    fileRef: session.fileRef,
    planId: prepared.plan.planId,
    approvalDigest: prepared.review.planDigest
  };
  const executeResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/execute",
    executeInput
  );
  assert.equal(executeResponse.status, 200);
  const executed = await executeResponse.json();
  assert.match(executed.callRef, /^claim_call_[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(executed), /retell-provider-call-1/);
  assert.equal(executed.automaticRetry, false);
  assert.equal(fixture.retellCalls.length, 1);

  const recoveredStatus = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/status",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef
      }
    )
  ).json();
  assert.deepEqual(recoveredStatus.recovery, {
    state: "available",
    planId: prepared.plan.planId,
    callRef: executed.callRef,
    acceptedAt: recoveredStatus.recovery.acceptedAt
  });
  assert.match(recoveredStatus.recovery.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);

  const repeatResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/execute",
    executeInput
  );
  assert.equal(repeatResponse.status, 409);
  assert.equal(fixture.retellCalls.length, 1);

  const resultInput = {
    conversationRef: session.fileConversationRef,
    fileRef: session.fileRef,
    planId: prepared.plan.planId,
    callRef: executed.callRef
  };
  const pendingResultResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/result",
    resultInput
  );
  assert.equal(pendingResultResponse.status, 200);
  assert.equal((await pendingResultResponse.json()).result.terminal, false);

  fixture.retellCalls[0].call_status = "ended";
  fixture.retellCalls[0].call_analysis = {
    custom_analysis_data: {
      filing_outcome: "claim_filed",
      claim_number: "MODEL-CLAIM-1",
      adjuster_name: "Model Suggested Adjuster"
    }
  };
  const terminalResultResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/result",
    resultInput
  );
  assert.equal(terminalResultResponse.status, 200);
  const terminalResult = await terminalResultResponse.json();
  assert.equal(terminalResult.result.humanConfirmationRequired, true);
  assert.equal(terminalResult.result.writebackEligible, false);
  assert.equal(
    terminalResult.result.modelAnalyzedSuggestions.claimNumber.humanConfirmed,
    false
  );
  assert.match(terminalResult.result.reviewTranscript, /confirmed the filing details/i);
  assert.equal(
    fixture.retellListRequests.every((request) =>
      request.limit === 2
      && Array.isArray(request.filter_criteria?.metadata)
      && request.filter_criteria.metadata.length === 6
    ),
    true
  );
  assert.doesNotMatch(
    JSON.stringify(terminalResult),
    /retell-provider-call-1|claim-file-provider-id|claim-pilot-jobnimbus-owner/
  );
  const blockedWritebackResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/writeback/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      callPlanId: prepared.plan.planId,
      callRef: executed.callRef,
      humanConfirmation: {
        evidenceDigest: terminalResult.result.evidenceDigest,
        reviewBasis: "reviewed_call_transcript",
        outcome: "claim_filed",
        claimNumber: "MODEL-CLAIM-1",
        adjusterName: "Model Suggested Adjuster",
        adjusterPhone: "",
        adjusterEmail: ""
      }
    }
  );
  assert.equal(blockedWritebackResponse.status, 200);
  const blockedWriteback = await blockedWritebackResponse.json();
  assert.equal(blockedWriteback.mappingConfigured, false);
  assert.equal(blockedWriteback.plan, null);
  assert.match(blockedWriteback.review.blockers[0], /mapping/i);

  const stalePreparedResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      confirmations: CONFIRMATIONS
    }
  );
  const stalePrepared = await stalePreparedResponse.json();
  fixture.contact.cf_date_1 = "2026-05-03";
  const staleExecuteResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/execute",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      planId: stalePrepared.plan.planId,
      approvalDigest: stalePrepared.review.planDigest
    }
  );
  assert.equal(staleExecuteResponse.status, 409);
  assert.equal(fixture.retellCalls.length, 1);
  assert.deepEqual(fixture.providerMutations, []);
});

test("human-approved mapped writeback completes only after exact JobNimbus readback", async (t) => {
  const fixture = await startFixture(t, {
    pilot: true,
    callsEnabled: true,
    writesEnabled: true,
    fieldMapping: true
  });
  const session = await loginAndCreateFileChat(fixture);
  const prepared = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/prepare",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        confirmations: CONFIRMATIONS
      }
    )
  ).json();
  const executed = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/execute",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        planId: prepared.plan.planId,
        approvalDigest: prepared.review.planDigest
      }
    )
  ).json();
  fixture.retellCalls[0].call_status = "ended";
  fixture.retellCalls[0].transcript =
    "The carrier representative stated the actual claim number is HUMAN-CORRECTED-900 and confirmed the adjuster details.";
  fixture.retellCalls[0].call_analysis = {
    custom_analysis_data: {
      filing_outcome: "claim_filed",
      claim_number: "MODEL-WRONG-900",
      adjuster_name: "Reviewed Adjuster",
      adjuster_phone: "972-555-0199",
      adjuster_email: "adjuster@example.test"
    }
  };
  const result = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/result",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        planId: prepared.plan.planId,
        callRef: executed.callRef
      }
    )
  ).json();
  const humanConfirmation = {
    evidenceDigest: result.result.evidenceDigest,
    reviewBasis: "reviewed_call_transcript",
    outcome: "claim_filed",
    claimNumber: "HUMAN-CORRECTED-900",
    adjusterName: "Reviewed Adjuster",
    adjusterPhone: "972-555-0199",
    adjusterEmail: "adjuster@example.test"
  };
  const writebackPreparedResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/writeback/prepare",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      callPlanId: prepared.plan.planId,
      callRef: executed.callRef,
      humanConfirmation
    }
  );
  assert.equal(writebackPreparedResponse.status, 200);
  const writebackPrepared = await writebackPreparedResponse.json();
  assert.equal(writebackPrepared.review.ready, true);
  assert.equal(writebackPrepared.mappingConfigured, true);
  assert.deepEqual(writebackPrepared.review.mappedFields, {
    cf_string_10: "HUMAN-CORRECTED-900",
    cf_string_7: "Reviewed Adjuster",
    cf_string_8: "972-555-0199",
    cf_string_9: "adjuster@example.test"
  });
  assert.equal(
    Object.hasOwn(writebackPrepared.review.mappedFields, "cf_string_2"),
    false
  );
  const writebackExecutedResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/writeback/execute",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      planId: writebackPrepared.plan.planId,
      approvalDigest: writebackPrepared.review.approvalDigest
    }
  );
  assert.equal(writebackExecutedResponse.status, 200);
  const writebackExecuted = await writebackExecutedResponse.json();
  assert.equal(writebackExecuted.verifiedByReadback, true);
  assert.equal(fixture.contact.cf_string_10, "HUMAN-CORRECTED-900");
  assert.equal(fixture.contact.cf_string_2, undefined);
  assert.equal(
    fixture.contact.status_name,
    "Submitted (Awaiting Two Key Confirmations)"
  );
  assert.equal(fixture.activities.length, 1);
  assert.equal(
    fixture.activities[0].note.includes("Claim filed by phone"),
    true
  );
  assert.equal(
    fixture.providerMutations.filter((item) => item.pathname === "/contacts/claim-file-provider-id").length,
    1
  );
  assert.equal(
    fixture.providerMutations.filter((item) => item.pathname === "/activities").length,
    1
  );
});

test("failed exact-field readback terminalizes as reconciliation with no retry", async (t) => {
  const fixture = await startFixture(t, {
    pilot: true,
    callsEnabled: true,
    writesEnabled: true,
    fieldMapping: true
  });
  const session = await loginAndCreateFileChat(fixture);
  const claim = await prepareTerminalClaim(fixture, session, {
    claimNumber: "READBACK-FAIL-1",
    adjusterName: "Reviewed Adjuster"
  });
  const humanConfirmation = {
    evidenceDigest: claim.result.result.evidenceDigest,
    reviewBasis: "reviewed_call_transcript",
    outcome: "claim_filed",
    claimNumber: "READBACK-FAIL-1",
    adjusterName: "Reviewed Adjuster",
    adjusterPhone: "",
    adjusterEmail: ""
  };
  const prepared = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/writeback/prepare",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        callPlanId: claim.prepared.plan.planId,
        callRef: claim.executed.callRef,
        humanConfirmation
      }
    )
  ).json();
  fixture.writebackState.applyContactWrites = false;
  const executeInput = {
    conversationRef: session.fileConversationRef,
    fileRef: session.fileRef,
    planId: prepared.plan.planId,
    approvalDigest: prepared.review.approvalDigest
  };
  const response = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/writeback/execute",
    executeInput
  );
  assert.equal(response.status, 200);
  const reconciled = await response.json();
  assert.equal(reconciled.verifiedByReadback, false);
  assert.equal(reconciled.automaticRetry, false);
  assert.equal(reconciled.receipt.status, "reconciliation_required");
  assert.equal(fixture.contact.cf_string_10, undefined);
  const repeat = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/writeback/execute",
    executeInput
  );
  assert.equal(repeat.status, 409);
});

test("an exact existing JobNimbus claim note is verified instead of duplicated", async (t) => {
  const fixture = await startFixture(t, {
    pilot: true,
    callsEnabled: true,
    writesEnabled: true,
    fieldMapping: true
  });
  const session = await loginAndCreateFileChat(fixture);
  const claim = await prepareTerminalClaim(fixture, session, {
    claimNumber: "IDEMPOTENT-1",
    adjusterName: "Reviewed Adjuster"
  });
  const prepared = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/writeback/prepare",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        callPlanId: claim.prepared.plan.planId,
        callRef: claim.executed.callRef,
        humanConfirmation: {
          evidenceDigest: claim.result.result.evidenceDigest,
          reviewBasis: "reviewed_call_transcript",
          outcome: "claim_filed",
          claimNumber: "IDEMPOTENT-1",
          adjusterName: "Reviewed Adjuster",
          adjusterPhone: "",
          adjusterEmail: ""
        }
      }
    )
  ).json();
  fixture.activities.push({
    jnid: "preexisting-claim-note",
    note: prepared.review.note,
    primary: { id: "claim-file-provider-id" }
  });
  const response = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/claim-filings/writeback/execute",
    {
      conversationRef: session.fileConversationRef,
      fileRef: session.fileRef,
      planId: prepared.plan.planId,
      approvalDigest: prepared.review.approvalDigest
    }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verifiedByReadback, true);
  assert.equal(fixture.activities.length, 1);
  assert.equal(
    fixture.providerMutations.filter((item) =>
      item.method === "POST" && item.pathname === "/activities"
    ).length,
    0
  );
});

test("dedicated signed Jobrolo profile reuses the full two-approval claim workflow", async (t) => {
  const fixture = await startFixture(t, {
    pilot: false,
    callsEnabled: true,
    writesEnabled: true,
    fieldMapping: true,
    jobroloClaim: true
  });
  const workCenter = await signedJobroloGeneralPost(
    fixture,
    "/integrations/jobrolo/v1/work-center",
    { offset: 0, limit: 1 },
    "a"
  );
  assert.equal(workCenter.response.status, 200, workCenter.text);
  const fileRef = workCenter.body.result.files[0].fileRef;
  const status = await signedJobroloClaimPost(
    fixture,
    "/integrations/jobrolo/v1/claim-filings/status",
    { fileRef },
    "1"
  );
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.body.result.eligible, true);
  assert.equal(status.body.result.principalEligible, true);
  assert.equal(status.body.result.filingState, "new_claim_candidate");
  assert.equal(status.body.result.existingClaim, false);
  assert.deepEqual(status.body.result.blockers, []);
  assert.equal(status.body.result.callsEnabled, true);

  fixture.contact.cf_string_10 = "EXISTING-JOBROLO-CLAIM-1";
  const existingClaimStatus = await signedJobroloClaimPost(
    fixture,
    "/integrations/jobrolo/v1/claim-filings/status",
    { fileRef },
    "0"
  );
  assert.equal(existingClaimStatus.response.status, 200, existingClaimStatus.text);
  assert.equal(existingClaimStatus.body.result.eligible, false);
  assert.equal(existingClaimStatus.body.result.principalEligible, true);
  assert.equal(existingClaimStatus.body.result.filingState, "existing_claim");
  assert.equal(existingClaimStatus.body.result.existingClaim, true);
  assert.equal(existingClaimStatus.body.result.callsEnabled, false);
  assert.equal(existingClaimStatus.body.result.writebackConfigured, true);
  assert.deepEqual(existingClaimStatus.body.result.blockers, [{
    code: "existing_claim",
    label: "This file already has a claim number. Use status follow-up instead of opening a new claim.",
    source: "jobnimbus"
  }]);
  fixture.contact.cf_string_10 = "";

  const prepared = await signedJobroloClaimPost(
    fixture,
    "/integrations/jobrolo/v1/claim-filings/prepare",
    { fileRef, confirmations: CONFIRMATIONS },
    "2"
  );
  assert.equal(prepared.response.status, 200, prepared.text);
  assert.equal(prepared.body.result.review.ready, true);
  assert.match(prepared.body.result.plan.planId, /^plan_[a-f0-9]{32}$/);

  const executed = await signedJobroloClaimPost(
    fixture,
    "/integrations/jobrolo/v1/claim-filings/execute",
    {
      fileRef,
      planId: prepared.body.result.plan.planId,
      approval: jobroloApproval(
        prepared.body.result.plan.planId,
        prepared.body.result.review.planDigest,
        "call"
      )
    },
    "3"
  );
  assert.equal(executed.response.status, 200, executed.text);
  assert.match(executed.body.result.callRef, /^claim_call_[a-f0-9]{32}$/);
  assert.equal(fixture.retellCalls.length, 1);

  fixture.retellCalls[0].call_status = "ended";
  fixture.retellCalls[0].transcript =
    "The carrier confirmed claim number JOBROLO-CLAIM-1 and the assigned adjuster.";
  fixture.retellCalls[0].call_analysis = {
    custom_analysis_data: {
      filing_outcome: "claim_filed",
      claim_number: "JOBROLO-CLAIM-1",
      adjuster_name: "Jobrolo Reviewed Adjuster"
    }
  };
  const result = await signedJobroloClaimPost(
    fixture,
    "/integrations/jobrolo/v1/claim-filings/result",
    {
      fileRef,
      planId: prepared.body.result.plan.planId,
      callRef: executed.body.result.callRef
    },
    "4"
  );
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.body.result.result.callStatus, "ended");
  assert.equal(result.body.result.result.humanConfirmationRequired, true);

  const writebackPrepared = await signedJobroloClaimPost(
    fixture,
    "/integrations/jobrolo/v1/claim-filings/writeback/prepare",
    {
      fileRef,
      callPlanId: prepared.body.result.plan.planId,
      callRef: executed.body.result.callRef,
      humanConfirmation: {
        evidenceDigest: result.body.result.result.evidenceDigest,
        reviewBasis: "reviewed_call_transcript",
        outcome: "claim_filed",
        claimNumber: "JOBROLO-CLAIM-1",
        adjusterName: "Jobrolo Reviewed Adjuster",
        adjusterPhone: "",
        adjusterEmail: ""
      }
    },
    "5"
  );
  assert.equal(
    writebackPrepared.response.status,
    200,
    writebackPrepared.text
  );
  assert.equal(writebackPrepared.body.result.review.ready, true);

  const writebackExecuted = await signedJobroloClaimPost(
    fixture,
    "/integrations/jobrolo/v1/claim-filings/writeback/execute",
    {
      fileRef,
      planId: writebackPrepared.body.result.plan.planId,
      approval: jobroloApproval(
        writebackPrepared.body.result.plan.planId,
        writebackPrepared.body.result.review.approvalDigest,
        "writeback"
      )
    },
    "6"
  );
  assert.equal(
    writebackExecuted.response.status,
    200,
    writebackExecuted.text
  );
  assert.equal(writebackExecuted.body.result.verifiedByReadback, true);
  assert.equal(fixture.contact.cf_string_10, "JOBROLO-CLAIM-1");
  assert.equal(fixture.activities.length, 1);
});

async function prepareTerminalClaim(
  fixture,
  session,
  { claimNumber, adjusterName }
) {
  const prepared = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/prepare",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        confirmations: CONFIRMATIONS
      }
    )
  ).json();
  const executed = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/execute",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        planId: prepared.plan.planId,
        approvalDigest: prepared.review.planDigest
      }
    )
  ).json();
  fixture.retellCalls[0].call_status = "ended";
  fixture.retellCalls[0].call_analysis = {
    custom_analysis_data: {
      filing_outcome: "claim_filed",
      claim_number: claimNumber,
      adjuster_name: adjusterName
    }
  };
  const result = await (
    await postHcn(
      fixture,
      session,
      "/hcn/api/v1/claim-filings/result",
      {
        conversationRef: session.fileConversationRef,
        fileRef: session.fileRef,
        planId: prepared.plan.planId,
        callRef: executed.callRef
      }
    )
  ).json();
  return { prepared, executed, result };
}

async function startFixture(t, {
  pilot,
  callsEnabled = false,
  writesEnabled = false,
  fieldMapping = false,
  jobroloClaim = false
}) {
  const temporaryRoot = await realpath(await mkdtemp(
    path.join(tmpdir(), "hcn-claim-filing-http-")
  ));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const invitationTimestamp = Date.now();
  const invitationStore = createHcnInvitationStore({
    filePath: path.join(
      temporaryRoot,
      "platform",
      "employee-invitations.enc.json"
    ),
    key: REFERENCE_KEY,
    allowedDomain: "",
    now: () => invitationTimestamp
  });
  const invitation = await invitationStore.createInvitation({
    email: EMAIL,
    displayName: "Claim Pilot",
    role: "employee",
    jobNimbusOwnerId: OWNER_ID,
    jobNimbusScope: "assigned",
    invitedByRef: `principal_${"a".repeat(64)}`,
    expiresAt: new Date(
      invitationTimestamp + 72 * 60 * 60_000
    ).toISOString()
  });
  await invitationStore.acceptInvitation({
    invitationRef: invitation.invitationRef,
    email: EMAIL,
    googleSubject: SUBJECT,
    inviteToken: invitation.inviteToken
  });

  const providerMutations = [];
  const retellCalls = [];
  const retellListRequests = [];
  const activities = [];
  const writebackState = { applyContactWrites: true };
  const fixedJobroloEmail = "cpearson@wavepa.com";
  const fixedJobroloSubject = "chance-jobrolo-google-subject";
  const contact = {
    jnid: "claim-file-provider-id",
    number: 3010,
    record_type_name: "Insurance",
    owners: [{ id: OWNER_ID }],
    display_name: "Claim Filing Fixture",
    status_name: "Ready for PA Review",
    stage_name: "Estimating",
    is_active: true,
    date_updated: 1785261000,
    address_line1: "100 Main Street",
    city: "Dallas",
    state_text: "TX",
    zip: "75001",
    mobile_phone: "9725551212",
    email: "homeowner@example.test",
    cf_string_1: "State Farm",
    cf_string_3: "POLICY-100",
    cf_date_1: "2026-05-01",
    cf_string_5: "Hail"
  };
  const provider = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${provider.address().port}`;
    const url = new URL(req.url || "/", origin);
    if (url.pathname === "/token" && req.method === "POST") {
      return json(res, 200, {
        access_token: "claim-pilot-login-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    if (url.pathname === "/tokeninfo" && req.method === "GET") {
      return json(res, 200, {
        audience: "hcn-claim-pilot-client",
        expires_in: 3600,
        verified_email: true,
        scope: "openid email profile"
      });
    }
    if (url.pathname === "/userinfo" && req.method === "GET") {
      return json(res, 200, {
        sub: SUBJECT,
        email: EMAIL,
        email_verified: true,
        hd: "wavepa.com",
        name: "Claim Pilot"
      });
    }
    if (url.pathname === "/account/users" && req.method === "GET") {
      return json(res, 200, {
        total: 1,
        users: [{
          jnid: OWNER_ID,
          email: jobroloClaim ? fixedJobroloEmail : EMAIL,
          display_name: jobroloClaim ? "Chance Pearson" : "Claim Pilot",
          is_active: true
        }]
      });
    }
    if (url.pathname === "/contacts" && req.method === "GET") {
      return json(res, 200, { contacts: [
        { ...contact },
        {
          ...contact,
          jnid: "status-catalog-provider-id",
          number: 3999,
          owners: [{ id: "another-owner" }],
          display_name: "Status catalog fixture",
          status_name: "Submitted (Awaiting Two Key Confirmations)"
        }
      ] });
    }
    if (
      url.pathname === "/contacts/claim-file-provider-id"
      && req.method === "GET"
    ) {
      return json(res, 200, { ...contact });
    }
    if (
      url.pathname === "/contacts/claim-file-provider-id"
      && req.method === "PUT"
    ) {
      const body = JSON.parse(await readRequestBody(req));
      providerMutations.push({
        method: req.method,
        pathname: url.pathname,
        body
      });
      if (writebackState.applyContactWrites) Object.assign(contact, body);
      return json(res, 200, { accepted: true });
    }
    if (url.pathname === "/activities" && req.method === "POST") {
      const body = JSON.parse(await readRequestBody(req));
      providerMutations.push({
        method: req.method,
        pathname: url.pathname,
        body
      });
      activities.push({
        jnid: `activity-${activities.length + 1}`,
        ...body,
        related: { id: "claim-file-provider-id" }
      });
      return json(res, 200, activities.at(-1));
    }
    if (url.pathname === "/activities" && req.method === "GET") {
      return json(res, 200, { activities: activities.map((row) => ({ ...row })) });
    }
    if (
      url.pathname === "/v2/create-phone-call"
      && req.method === "POST"
    ) {
      const body = JSON.parse(await readRequestBody(req));
      const call = {
        call_id: `retell-provider-call-${retellCalls.length + 1}`,
        call_status: "in_progress",
        direction: "outbound",
        metadata: body.metadata,
        retell_llm_dynamic_variables:
          body.retell_llm_dynamic_variables || {},
        transcript: "Carrier representative confirmed the filing details during this call.",
        call_analysis: {}
      };
      retellCalls.push(call);
      return json(res, 200, { call_id: call.call_id });
    }
    if (url.pathname === "/v3/list-calls" && req.method === "POST") {
      const body = JSON.parse(await readRequestBody(req));
      retellListRequests.push(body);
      const metadataFilters = Array.isArray(body.filter_criteria?.metadata)
        ? body.filter_criteria.metadata
        : [];
      return json(res, 200, {
        items: retellCalls
          .filter((call) => metadataFilters.every((filter) =>
            filter.type === "string"
            && String(call.metadata?.[filter.key] || "") === String(filter.value)
          ))
          .map((call) => ({ ...call })),
        has_more: false
      });
    }
    if (
      url.pathname.startsWith("/v2/get-call/")
      && req.method === "GET"
    ) {
      const callId = decodeURIComponent(
        url.pathname.slice("/v2/get-call/".length)
      );
      const call = retellCalls.find((item) => item.call_id === callId);
      return call
        ? json(res, 200, { ...call })
        : json(res, 404, { error: "call not found" });
    }
    if (req.method !== "GET") {
      providerMutations.push({ method: req.method, pathname: url.pathname });
    }
    return json(res, 404, { error: "not found" });
  });
  await listenOnLoopback(provider);
  t.after(() => closeServer(provider));

  const bridgePort = await reserveLoopbackPort();
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      PUBLIC_BASE_URL: bridgeOrigin,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: bridgeOrigin,
      HCN_TENANT_ID: "tenant_0123456789abcdef",
      HCN_REFERENCE_KEY: REFERENCE_KEY,
      HCN_GOOGLE_GRANT_KEY: Buffer.alloc(32, 0x62).toString("base64url"),
      HCN_QUO_LINK_KEY: Buffer.alloc(32, 0x63).toString("base64url"),
      HCN_ASSISTANT_HISTORY_KEY: Buffer.alloc(32, 0x64).toString("base64url"),
      HCN_OPERATIONS_ROOT: temporaryRoot,
      ALLOW_GOOGLE_USER_AUTH: "true",
      AUTO_ENROLL_WAVE_USERS: "false",
      GOOGLE_CLIENT_ID: "unused-legacy-client",
      GOOGLE_CLIENT_SECRET: "unused-legacy-secret-claim-test",
      HCN_GOOGLE_CLIENT_ID: "hcn-claim-pilot-client",
      HCN_GOOGLE_CLIENT_SECRET: "hcn-claim-pilot-secret-test",
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${provider.address().port}/token`,
      GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${provider.address().port}/tokeninfo`,
      GOOGLE_USERINFO_URL: `http://127.0.0.1:${provider.address().port}/userinfo`,
      GOOGLE_OAUTH_ALLOWED_DOMAIN: "wavepa.com",
      HCN_GOOGLE_LOGIN_ALLOWED_DOMAIN: "wavepa.com",
      OAUTH_SESSION_SECRET: "hcn-claim-pilot-session-sealing-secret-12345",
      WAVE_AUTH_USERS_JSON: "[]",
      JOBNIMBUS_API_KEY: "hcn-claim-pilot-jobnimbus-key",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "",
      ...(jobroloClaim ? {
        CHANCE_GOOGLE_EMAIL: fixedJobroloEmail,
        CHANCE_GOOGLE_SUBJECT: fixedJobroloSubject,
        CHANCE_JOBNIMBUS_OWNER_ID: OWNER_ID,
        HCN_JOBROLO_ADAPTER_ENABLED: "true",
        HCN_JOBROLO_CLIENT_ID: JOBROLO_GENERAL_CLIENT_ID,
        HCN_JOBROLO_SHARED_SECRET: JOBROLO_GENERAL_SHARED_SECRET,
        HCN_JOBROLO_PRINCIPAL_EMAIL: fixedJobroloEmail,
        HCN_JOBROLO_CLAIM_FILING_ENABLED: "true",
        HCN_JOBROLO_CLAIM_FILING_CLIENT_ID: JOBROLO_CLAIM_CLIENT_ID,
        HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET:
          JOBROLO_CLAIM_SHARED_SECRET,
        HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL: fixedJobroloEmail
      } : {}),
      RETELL_AGENT_ID: "agent_claim_pilot_fixture",
      RETELL_FROM_NUMBER: "+19725550100",
      RETELL_API_BASE_URL:
        `http://127.0.0.1:${provider.address().port}`,
      RETELL_API_KEY: callsEnabled
        ? "retell_claim_test_key"
        : "",
      HCN_CLAIM_FILING_PILOT_SUBJECTS_JSON: pilot
        ? JSON.stringify([SUBJECT, SECOND_PILOT_SUBJECT])
        : "[]",
      HCN_JOBNIMBUS_CLAIM_FIELD_MAPPING_JSON: fieldMapping
        ? JSON.stringify({
            version: "hcn.jobnimbus.claim-fields.v1",
            verified: true,
            claimNumber: "cf_string_10",
            adjusterName: "cf_string_7",
            adjusterPhone: "cf_string_8",
            adjusterEmail: "cf_string_9"
          })
        : "",
      BRIDGE_ALLOW_WRITES: writesEnabled ? "true" : "false",
      HCN_ACTION_EXECUTION_ENABLED: writesEnabled ? "true" : "false",
      ALLOW_RETELL_CALLS: callsEnabled ? "true" : "false",
      ALLOW_GMAIL_SEND: "false",
      ALLOW_QUO_SEND: "false",
      ALLOW_VOICE_CALLS: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => stopChild(child));
  await waitForServer(child, bridgePort);
  return {
    bridgeOrigin,
    child,
    contact,
    providerMutations,
    retellCalls,
    retellListRequests,
    activities,
    writebackState
  };
}

async function loginAndCreateFileChat(fixture) {
  const login = await fetch(
    `${fixture.bridgeOrigin}/hcn/auth/login?returnTo=${encodeURIComponent("/hcn")}`,
    { redirect: "manual" }
  );
  assert.equal(login.status, 302);
  const loginCookie = cookieStartingWith(
    login.headers.getSetCookie(),
    "__Host-hcn_login="
  );
  const authorize = new URL(login.headers.get("location"));
  const callback = await fetch(
    `${fixture.bridgeOrigin}/oauth/google/callback?${new URLSearchParams({
      code: "claim-pilot-google-code",
      state: authorize.searchParams.get("state")
    })}`,
    { redirect: "manual", headers: { cookie: loginCookie } }
  );
  assert.equal(callback.status, 302);
  const cookie = cookieStartingWith(
    callback.headers.getSetCookie(),
    "__Host-hcn_session="
  );
  const sessionResponse = await fetch(
    `${fixture.bridgeOrigin}/hcn/auth/session`,
    { headers: { cookie } }
  );
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  const session = {
    cookie,
    csrfToken: sessionBody.browserSession.csrfToken
  };
  const workCenterResponse = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/work-center",
    { offset: 0, limit: 1 }
  );
  assert.equal(workCenterResponse.status, 200);
  const workCenter = await workCenterResponse.json();
  session.fileRef = workCenter.files[0].fileRef;
  const conversation = await createConversation(
    fixture,
    session,
    { kind: "file", title: "Claim filing", fileRef: session.fileRef }
  );
  session.fileConversationRef = conversation.conversationRef;
  return session;
}

async function createConversation(fixture, session, input) {
  const response = await postHcn(
    fixture,
    session,
    "/hcn/api/v1/assistant/conversations/create",
    input
  );
  assert.equal(response.status, 200);
  return (await response.json()).conversation;
}

function postHcn(fixture, session, pathname, body) {
  return fetch(`${fixture.bridgeOrigin}${pathname}`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: fixture.bridgeOrigin,
      "x-hcn-csrf": session.csrfToken,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function jobroloApproval(planId, planDigest, suffix) {
  return {
    schema: "jobrolo.approval-attestation.v1",
    approvalRequestId: `approval_${suffix}_fixture`,
    planDigest,
    approvedAt: new Date().toISOString(),
    approvedByUserId: `actor_${suffix}_fixture_user`
  };
}

async function signedJobroloClaimPost(
  fixture,
  pathname,
  input,
  nonceDigit
) {
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId: `request_${nonceDigit.repeat(32)}`,
    actor: {
      sessionRef: "session_abcdefabcdefabcdefabcdefabcdefab"
    },
    input
  };
  const headers = signJobroloHcnRequest({
    clientId: JOBROLO_CLAIM_CLIENT_ID,
    secret: JOBROLO_CLAIM_SHARED_SECRET,
    pathname,
    timestamp: Date.now(),
    nonce: `nonce_${nonceDigit.repeat(32)}`,
    body
  });
  const response = await fetch(`${fixture.bridgeOrigin}${pathname}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let decoded = null;
  try {
    decoded = JSON.parse(text);
  } catch {
    // Keep raw response text in the assertion helper for useful failures.
  }
  return { response, text, body: decoded };
}

async function signedJobroloGeneralPost(
  fixture,
  pathname,
  input,
  nonceDigit
) {
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId: `request_${nonceDigit.repeat(32)}`,
    actor: {
      sessionRef: "session_0123456789abcdef0123456789abcdef"
    },
    input
  };
  const headers = signJobroloHcnRequest({
    clientId: JOBROLO_GENERAL_CLIENT_ID,
    secret: JOBROLO_GENERAL_SHARED_SECRET,
    pathname,
    timestamp: Date.now(),
    nonce: `nonce_${nonceDigit.repeat(32)}`,
    body
  });
  const response = await fetch(`${fixture.bridgeOrigin}${pathname}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    text,
    body: JSON.parse(text)
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function reserveLoopbackPort() {
  const server = createServer();
  await listenOnLoopback(server);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function cookieStartingWith(setCookies, prefix) {
  const value = setCookies.find((cookie) => cookie.startsWith(prefix));
  assert.ok(value, `Missing cookie ${prefix}`);
  return value.split(";", 1)[0];
}

async function waitForServer(child, port) {
  let output = "";
  const capture = (chunk) => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before test: ${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server: ${output}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
