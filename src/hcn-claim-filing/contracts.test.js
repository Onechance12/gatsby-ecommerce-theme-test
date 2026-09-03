import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHcnClaimFilingPilot,
  assertHcnClaimWritebackFields,
  buildHcnVerifiedClaimWriteback,
  createHcnServerClaimEvidence,
  hcnClaimApprovalDigest,
  hcnClaimPreparationMissingFacts,
  hcnClaimScopeBinding,
  normalizeHcnClaimConfirmations,
  parseHcnClaimWritebackMapping,
  parseHcnClaimFilingPilotSubjects,
  projectHcnClaimResult
} from "./contracts.js";

const FILE_REF = `subject_${"a".repeat(32)}`;
const CONVERSATION_REF = `conversation_${"b".repeat(32)}`;
const PRINCIPAL_REF = `principal_${"c".repeat(64)}`;
const PLAN_ID = `plan_${"1".repeat(32)}`;
const FIELD_MAPPING = parseHcnClaimWritebackMapping(JSON.stringify({
  version: "hcn.jobnimbus.claim-fields.v1",
  verified: true,
  claimNumber: "cf_string_10",
  adjusterName: "cf_string_7",
  adjusterPhone: "cf_string_8",
  adjusterEmail: "cf_string_9"
}));

test("claim-filing pilot allowlist is explicit, immutable, and fail closed", () => {
  const pilots = parseHcnClaimFilingPilotSubjects(
    JSON.stringify(["pilot-one", "pilot-two"])
  );
  assert.doesNotThrow(() => assertHcnClaimFilingPilot(pilots, "pilot-one"));
  assert.equal(Object.isFrozen(pilots), true);
  assert.equal(Object.isFrozen(pilots.values), true);
  assert.equal(pilots.add, undefined);
  assert.throws(() => pilots.values.push("ordinary-employee"), TypeError);
  assert.throws(() => {
    pilots.has = () => true;
  }, TypeError);
  assert.throws(
    () => assertHcnClaimFilingPilot(pilots, "ordinary-employee"),
    { code: "claim_filing_pilot_required", statusCode: 403 }
  );
  assert.throws(
    () => parseHcnClaimFilingPilotSubjects('["pilot-one","pilot-one"]'),
    /duplicate Google subject/
  );
  assert.throws(
    () => parseHcnClaimFilingPilotSubjects('["pilot-one"]'),
    /exactly two Google subjects/
  );
  assert.throws(
    () => parseHcnClaimFilingPilotSubjects('["one","two","three"]'),
    /exactly two Google subjects/
  );
});

test("claim preparation requires exact file facts and explicit human answers", () => {
  const confirmations = normalizeHcnClaimConfirmations({});
  const missing = hcnClaimPreparationMissingFacts({
    file: {
      name: "Assigned Homeowner",
      address: "1 Main St, Dallas, TX, 75001",
      phone: "9725551212",
      carrier: "Carrier",
      policyNumber: "",
      dateOfLoss: "2026-05-01",
      typeOfLoss: "",
      claimNumber: ""
    },
    property: {
      addressLine1: "1 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75001"
    },
    confirmations
  });
  assert.deepEqual(
    missing.map((item) => item.code),
    [
      "policy_number",
      "cause_of_loss",
      "damage_opening",
      "damage_details",
      "injuries",
      "homeLivable",
      "temporaryRepairs",
      "contractorHired"
    ]
  );
});

test("reported injuries and ambiguous confirmation placeholders block preparation", () => {
  const file = {
    name: "Assigned Homeowner",
    address: "1 Main St, Dallas, TX, 75001",
    phone: "9725551212",
    carrier: "State Farm",
    policyNumber: "POLICY-1",
    dateOfLoss: "2026-05-01",
    typeOfLoss: "Hail",
    claimNumber: ""
  };
  const property = {
    addressLine1: "1 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75001"
  };
  const reported = normalizeHcnClaimConfirmations({
    damageOpening: "Hail damaged the roof.",
    damageDetails: ["roof hail damage"],
    injuries: "injuries_reported",
    homeLivable: "livable",
    temporaryRepairs: "none_made",
    contractorHired: "none_hired",
    carrierPhone: ""
  });
  assert.equal(
    hcnClaimPreparationMissingFacts({ file, property, confirmations: reported })
      .some((item) => item.code === "injuries_human_escalation"),
    true
  );
  const ambiguous = normalizeHcnClaimConfirmations({
    damageOpening: "unknown",
    damageDetails: ["N/A"],
    injuries: "unknown",
    homeLivable: "yes",
    temporaryRepairs: "",
    contractorHired: "not sure",
    carrierPhone: ""
  });
  const codes = hcnClaimPreparationMissingFacts({
    file,
    property,
    confirmations: ambiguous
  }).map((item) => item.code);
  assert.equal(codes.includes("damage_opening"), true);
  assert.equal(codes.includes("damage_details"), true);
  assert.equal(codes.includes("injuries"), true);
  assert.equal(codes.includes("homeLivable"), true);
});

test("malformed JobNimbus facts and non-string confirmation objects fail closed", () => {
  const confirmations = normalizeHcnClaimConfirmations({
    damageOpening: "Hail damaged the roof.",
    damageDetails: ["roof hail damage"],
    injuries: "no_injuries_reported",
    homeLivable: "livable",
    temporaryRepairs: "none_made",
    contractorHired: "none_hired",
    carrierPhone: ""
  });
  const codes = hcnClaimPreparationMissingFacts({
    file: {
      name: "Unknown",
      phone: "123",
      carrier: "N/A",
      policyNumber: {},
      dateOfLoss: "2026-02-31",
      typeOfLoss: "Missing",
      claimNumber: ""
    },
    property: {
      addressLine1: "?",
      city: "N/A",
      state: "Texas",
      zip: "75A01"
    },
    confirmations
  }).map((item) => item.code);
  for (const code of [
    "homeowner",
    "property_address",
    "property_city",
    "property_state",
    "property_zip",
    "homeowner_phone",
    "carrier",
    "policy_number",
    "date_of_loss",
    "cause_of_loss"
  ]) {
    assert.equal(codes.includes(code), true, code);
  }
  assert.throws(
    () => normalizeHcnClaimConfirmations({
      damageOpening: { text: "not accepted" }
    }),
    { code: "invalid_confirmation", statusCode: 400 }
  );
});

test("future loss dates and non-directory carrier destinations fail closed", () => {
  const confirmations = normalizeHcnClaimConfirmations({
    damageOpening: "Hail damaged the roof.",
    damageDetails: ["roof hail damage"],
    injuries: "no_injuries_reported",
    homeLivable: "livable",
    temporaryRepairs: "none_made",
    contractorHired: "none_hired",
    carrierPhone: ""
  });
  const missing = hcnClaimPreparationMissingFacts({
    file: {
      name: "Assigned Homeowner",
      phone: "9725551212",
      carrier: "State Farm",
      policyNumber: "POLICY-1",
      dateOfLoss: "2099-01-01",
      typeOfLoss: "Hail",
      claimNumber: ""
    },
    property: {
      addressLine1: "1 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75001"
    },
    confirmations,
    corePlan: {
      readiness: { blockers: [] },
      carrier: { filingPhone: "+18007335244" },
      callPlan: {
        to: "+19725559999",
        from: "+19725550100",
        agentId: "agent_verified"
      }
    }
  });
  const codes = missing.map((item) => item.code);
  assert.equal(codes.includes("date_of_loss"), true);
  assert.equal(codes.includes("untrusted_carrier_destination"), true);
});

test("claim plan bindings invalidate on exact-file state changes", () => {
  const approvalDigest = hcnClaimApprovalDigest({
    principalRef: PRINCIPAL_REF,
    conversationRef: CONVERSATION_REF,
    fileRef: FILE_REF,
    corePlanDigest: "d".repeat(64)
  });
  const first = hcnClaimScopeBinding({
    principalRef: PRINCIPAL_REF,
    conversationRef: CONVERSATION_REF,
    fileRef: FILE_REF,
    providerFileId: "provider-file",
    ownerId: "owner-one",
    relevantFileState: { policyNumber: "P1", dateOfLoss: "2026-05-01" },
    approvalDigest
  });
  const changed = hcnClaimScopeBinding({
    principalRef: PRINCIPAL_REF,
    conversationRef: CONVERSATION_REF,
    fileRef: FILE_REF,
    providerFileId: "provider-file",
    ownerId: "owner-one",
    relevantFileState: { policyNumber: "P1", dateOfLoss: "2026-05-02" },
    approvalDigest
  });
  assert.notEqual(first, changed);
});

test("result review uses only server-built terminal call evidence and labels model analysis as unconfirmed", () => {
  assert.throws(
    () => projectHcnClaimResult({
      schema: "hcn.claim-filing.server-evidence.v1"
    }),
    { code: "untrusted_call_evidence", statusCode: 400 }
  );
  const evidence = claimEvidence();
  const review = projectHcnClaimResult(evidence);
  assert.equal(review.planId, PLAN_ID);
  assert.deepEqual(review.modelAnalyzedSuggestions.claimNumber, {
    value: "CONFIRMED-1",
    provenance: "retell_post_call_model",
    humanConfirmed: false
  });
  assert.deepEqual(
    review.transcriptGuesses.map((item) => item.field),
    ["adjusterPhone"]
  );
  assert.equal(review.writebackEligible, false);
  assert.equal(review.humanConfirmationRequired, true);
  assert.match(review.reviewTranscript, /adjuster team phone/i);
});

test("claim writeback requires exact human confirmation bound to server evidence", () => {
  const evidence = claimEvidence();
  const writeback = buildHcnVerifiedClaimWriteback({
    evidence,
    humanConfirmation: {
      evidenceDigest: evidence.evidenceDigest,
      reviewBasis: "reviewed_call_transcript",
      outcome: "claim_filed",
      claimNumber: "CONFIRMED-1",
      adjusterName: "Carrier Adjuster",
      adjusterPhone: "",
      adjusterEmail: ""
    },
    currentStatus: "Ready for PA Review",
    fieldMapping: FIELD_MAPPING
  });
  assert.equal(writeback.ready, true);
  assert.deepEqual(writeback.fields, {
    cf_string_10: "CONFIRMED-1",
    cf_string_7: "Carrier Adjuster"
  });
  assert.equal(writeback.status, "Submitted Awaiting Confirmation");
  assert.throws(
    () => assertHcnClaimWritebackFields(
      { email: "not-allowed" },
      FIELD_MAPPING
    ),
    { code: "writeback_field_denied", statusCode: 400 }
  );
});

test("writeback mapping is disabled by default and exact verified mappings are unique", () => {
  assert.equal(parseHcnClaimWritebackMapping("").configured, false);
  assert.throws(
    () => parseHcnClaimWritebackMapping(JSON.stringify({
      version: "hcn.jobnimbus.claim-fields.v1",
      verified: true,
      claimNumber: "cf_string_2",
      adjusterName: "cf_string_2",
      adjusterPhone: "cf_string_8",
      adjusterEmail: "cf_string_9"
    })),
    /must be unique/
  );
  const evidence = claimEvidence();
  const blocked = buildHcnVerifiedClaimWriteback({
    evidence,
    humanConfirmation: {
      evidenceDigest: evidence.evidenceDigest,
      reviewBasis: "reviewed_call_transcript",
      outcome: "claim_filed",
      claimNumber: "CONFIRMED-1",
      adjusterName: "Carrier Adjuster",
      adjusterPhone: "",
      adjusterEmail: ""
    },
    currentStatus: "Ready for PA Review",
    fieldMapping: parseHcnClaimWritebackMapping("")
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.blockers[0], /mapping has not been verified/i);
});

test("non-default verified mappings drive every claim and adjuster write", () => {
  const mapping = parseHcnClaimWritebackMapping(JSON.stringify({
    version: "hcn.jobnimbus.claim-fields.v1",
    verified: true,
    claimNumber: "cf_string_42",
    adjusterName: "cf_string_43",
    adjusterPhone: "cf_string_44",
    adjusterEmail: "cf_string_45"
  }));
  const evidence = claimEvidence();
  const writeback = buildHcnVerifiedClaimWriteback({
    evidence,
    humanConfirmation: {
      evidenceDigest: evidence.evidenceDigest,
      reviewBasis: "reviewed_call_transcript",
      outcome: "claim_filed",
      claimNumber: "CONFIRMED-1",
      adjusterName: "Carrier Adjuster",
      adjusterPhone: "",
      adjusterEmail: ""
    },
    currentStatus: "Ready for PA Review",
    fieldMapping: mapping
  });
  assert.deepEqual(writeback.fields, {
    cf_string_42: "CONFIRMED-1",
    cf_string_43: "Carrier Adjuster"
  });
  assert.match(writeback.note, /adjuster details verified/i);
});

test("claim normalization, adjusted values, and status advancement are exact", () => {
  const evidence = claimEvidence({ claimNumber: "---" });
  assert.throws(
    () => buildHcnVerifiedClaimWriteback({
      evidence,
      humanConfirmation: {
        evidenceDigest: evidence.evidenceDigest,
        reviewBasis: "reviewed_call_transcript",
        outcome: "claim_filed",
        claimNumber: "---",
        adjusterName: "Carrier Adjuster",
        adjusterPhone: "",
        adjusterEmail: ""
      },
      currentStatus: "Ready for PA Review",
      fieldMapping: FIELD_MAPPING
    }),
    { code: "invalid_confirmed_value", statusCode: 400 }
  );
  const normalEvidence = claimEvidence();
  const writeback = buildHcnVerifiedClaimWriteback({
    evidence: normalEvidence,
    humanConfirmation: {
      evidenceDigest: normalEvidence.evidenceDigest,
      reviewBasis: "reviewed_call_transcript",
      outcome: "claim_filed",
      claimNumber: "CONFIRMED-1",
      adjusterName: "Carrier Adjuster",
      adjusterPhone: "",
      adjusterEmail: ""
    },
    currentStatus: "Not Ready for PA Review Yet",
    fieldMapping: FIELD_MAPPING
  });
  assert.equal(writeback.status, "");
});

test("missing or partial terminal receipts cannot create trusted call evidence", () => {
  assert.throws(
    () => claimEvidence({ receiptOverrides: { planId: "plan_wrong" } }),
    { code: "terminal_receipt_mismatch", statusCode: 409 }
  );
  assert.throws(
    () => claimEvidence({ receiptOverrides: { unknownCount: 1 } }),
    { code: "terminal_receipt_mismatch", statusCode: 409 }
  );
  assert.throws(
    () => claimEvidence({ metadataOverrides: { contactId: "wrong-file" } }),
    { code: "call_evidence_mismatch", statusCode: 409 }
  );
});

test("forged provenance and mismatched human confirmation cannot authorize writeback", () => {
  const evidence = claimEvidence();
  assert.throws(
    () => buildHcnVerifiedClaimWriteback({
      evidence: {
        ...evidence,
        modelAnalyzedSuggestions: {
          claimNumber: { value: "FORGED", humanConfirmed: true }
        }
      },
      humanConfirmation: {
        evidenceDigest: evidence.evidenceDigest,
        reviewBasis: "reviewed_call_transcript",
        outcome: "claim_filed",
        claimNumber: "FORGED"
      },
      currentStatus: "Ready for PA Review",
      fieldMapping: FIELD_MAPPING
    }),
    { code: "untrusted_call_evidence", statusCode: 400 }
  );
  const corrected = buildHcnVerifiedClaimWriteback({
    evidence,
    humanConfirmation: {
      evidenceDigest: evidence.evidenceDigest,
      reviewBasis: "reviewed_call_transcript",
      outcome: "claim_filed",
      claimNumber: "DIFFERENT",
      adjusterName: "",
      adjusterPhone: "",
      adjusterEmail: ""
    },
    currentStatus: "Ready for PA Review",
    fieldMapping: FIELD_MAPPING
  });
  assert.equal(corrected.ready, true);
  assert.equal(corrected.fields.cf_string_10, "DIFFERENT");
  assert.equal(
    corrected.fieldSources.cf_string_10,
    "human_entered_after_call_review"
  );
});

function claimEvidence({
  claimNumber = "CONFIRMED-1",
  receiptOverrides = {},
  metadataOverrides = {}
} = {}) {
  const planDigest = "d".repeat(64);
  return createHcnServerClaimEvidence({
    callRef: `claim_call_${"e".repeat(32)}`,
    fileRef: FILE_REF,
    callPlanId: PLAN_ID,
    planDigest,
    terminalReceipt: {
      planId: PLAN_ID,
      fileRef: FILE_REF,
      digest: planDigest,
      batchRef: `batch_${"f".repeat(32)}`,
      status: "completed_pending_verification",
      operationCount: 1,
      succeededCount: 1,
      failedCount: 0,
      blockedCount: 0,
      unknownCount: 0,
      terminalAt: "2026-08-03T12:00:00.000Z",
      ...receiptOverrides
    },
    file: {
      id: "provider-file",
      name: "Assigned Homeowner",
      status: "Ready for PA Review",
      carrier: "State Farm"
    },
    ownerId: "owner-one",
    rawCall: {
      call_id: "provider-call-id",
      call_status: "ended",
      transcript:
        "The adjuster team phone is 972-555-1000.",
      metadata: {
        source: "hcn-wave-jobnimbus-bridge",
        hcnCallRef: `claim_call_${"e".repeat(32)}`,
        hcnFileRef: FILE_REF,
        hcnApprovalDigest: planDigest,
        contactId: "provider-file",
        ownerId: "owner-one",
        ...metadataOverrides,
        goal: "file_new_claim"
      },
      call_analysis: {
        custom_analysis_data: {
          filing_outcome: "claim_filed",
          claim_number: claimNumber,
          adjuster_name: "Carrier Adjuster"
        }
      },
      retell_llm_dynamic_variables: {}
    }
  });
}
