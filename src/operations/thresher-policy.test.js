import test from "node:test";
import assert from "node:assert/strict";

import {
  CHANCE_OPERATOR_ALLOWED_ACTION_TYPES,
  CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS,
  CHANCE_OPERATOR_ALLOWED_STAGE_EVIDENCE_SOURCES,
  CHANCE_OPERATOR_RUN_POLICY_ID,
  chanceManifestFileBinding,
  chanceOperatorRunManifestSummary,
  chanceOperatorRunPolicy,
  loadChanceOperatorRunManifest,
  normalizeThresherStage,
  resolveChanceOperatorRunPolicy,
  validateThresherTransition
} from "./thresher-policy.js";

const FILE_ID = "file-id-0001";
const reference = {
  source: "jobnimbus_activity",
  id: "activity-1",
  fileId: FILE_ID,
  fact: "Carrier confirmed the required Thresher facts."
};

const gateFacts = {
  policyAuthorityReviewed: "The declarations page and signed PA contract were reviewed.",
  claimFiled: "The insurance claim was filed and claim number was confirmed.",
  deskAdjusterConfirmed: "The assigned desk adjuster was confirmed.",
  paymentHandlingConfirmed: "The carrier confirmed payment and check handling directions.",
  activeNegotiation: "The carrier supplement is in active negotiation.",
  carrierIssuanceConfirmed: "The carrier issued the estimate and ACV payment.",
  paymentReceiptConfirmed: "Accounting confirmed the check was received and deposited by our office.",
  appraisalGapConfirmed: "The estimate comparison confirms an appraisal gap.",
  appraisalDemandSent: "The appraisal demand was sent to the carrier and the carrier acknowledged receipt.",
  carrierAppraiserAssigned: "The carrier appraiser was assigned with contact information.",
  appraisalMeetingScheduled: "The appraisal meeting was scheduled with a date and time.",
  initialAppraisalAgreement: "The appraisers agreed to the initial appraisal amount.",
  fullyExecutedAward: "The fully executed appraisal award was received.",
  finalPaymentConfirmed: "Wave confirmed the final appraisal payment was received and is in our office custody.",
  productionReleased: "Richard approved and production was released.",
  richardDecision: "Richard decided to close after reviewing the evidence.",
  umpireInvoked: "The umpire was invoked and selected by the appraisers."
};

function referencesFor(gates, overrides = {}) {
  return gates.map((gate, index) => ({
    ...reference,
    id: `activity-${index + 1}`,
    gate,
    fact: gateFacts[gate] || reference.fact,
    ...overrides
  }));
}

function manifestInput(overrides = {}) {
  return {
    schemaVersion: 1,
    id: CHANCE_OPERATOR_RUN_POLICY_ID,
    operatorScope: "assigned",
    expiresAt: "2026-10-01T00:00:00.000Z",
    files: Array.from({ length: 58 }, (_, index) => ({
      number: String(1000 + index),
      fileId: index === 0 ? FILE_ID : `file-id-${String(index + 1).padStart(4, "0")}`
    })),
    excludedFileNumbers: ["2628"],
    allowedActionTypes: [...CHANCE_OPERATOR_ALLOWED_ACTION_TYPES],
    allowedContactFields: [...CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS],
    ...overrides
  };
}

test("loads and pins an exact immutable 58-file run manifest", () => {
  const manifest = loadChanceOperatorRunManifest(manifestInput(), {
    now: Date.parse("2026-08-23T00:00:00.000Z")
  });
  const policy = chanceOperatorRunPolicy(manifest);
  const summary = chanceOperatorRunManifestSummary(manifest);
  assert.equal(summary.fileCount, 58);
  assert.equal(summary.excludedFileNumbers.includes("2628"), true);
  assert.equal(summary.allowedActionTypes.includes("gmail.send"), false);
  assert.equal(summary.allowedActionTypes.includes("gmail.send_existing_draft"), true);
  assert.equal(summary.existingDraftSendAllowed, true);
  assert.equal(summary.rawGmailSendAllowed, false);
  assert.deepEqual(summary.allowedStageEvidenceSources, [
    "jobnimbus_activity",
    "gmail_message",
    "quo_message"
  ]);
  assert.deepEqual(
    summary.allowedStageEvidenceSources,
    [...CHANCE_OPERATOR_ALLOWED_STAGE_EVIDENCE_SOURCES]
  );
  assert.equal(summary.allowedStageEvidenceSources.includes("quo_call"), false);
  assert.equal(policy.taskCompletionAllowed, false);
  assert.equal(chanceManifestFileBinding(manifest, "1000", FILE_ID).fileId, FILE_ID);
  assert.equal(resolveChanceOperatorRunPolicy({ id: manifest.id, sha256: manifest.sha256 }, manifest).sha256, manifest.sha256);
  assert.throws(() => resolveChanceOperatorRunPolicy({ id: manifest.id, sha256: "0".repeat(64) }, manifest), /not pinned/i);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.files), true);
});

test("loads the immediately previous four-action manifest without enabling sends", () => {
  const manifest = loadChanceOperatorRunManifest(manifestInput({
    allowedActionTypes: CHANCE_OPERATOR_ALLOWED_ACTION_TYPES.filter(
      (type) => type !== "gmail.send_existing_draft"
    )
  }), {
    now: Date.parse("2026-08-23T00:00:00.000Z")
  });
  const summary = chanceOperatorRunManifestSummary(manifest);
  assert.equal(summary.existingDraftSendAllowed, false);
  assert.equal(summary.rawGmailSendAllowed, false);
  assert.equal(summary.allowedActionTypes.includes("gmail.send_existing_draft"), false);
});

test("manifest rejects expiry, duplicates, excluded file, and non-58 rosters", () => {
  const now = Date.parse("2026-08-23T00:00:00.000Z");
  assert.throws(() => loadChanceOperatorRunManifest(manifestInput({ expiresAt: "2026-08-01T00:00:00.000Z" }), { now }), /expired/i);
  assert.throws(() => loadChanceOperatorRunManifest(manifestInput({ files: manifestInput().files.slice(0, 57) }), { now }), /exactly 58/i);
  const duplicate = manifestInput().files;
  duplicate[1] = { ...duplicate[1], number: duplicate[0].number };
  assert.throws(() => loadChanceOperatorRunManifest(manifestInput({ files: duplicate }), { now }), /Duplicate JobNimbus file number/i);
  const excluded = manifestInput().files;
  excluded[1] = { ...excluded[1], number: "2628" };
  assert.throws(() => loadChanceOperatorRunManifest(manifestInput({ files: excluded }), { now }), /Excluded JobNimbus file/i);
});

test("maps live JobNimbus aliases to Thresher stages", () => {
  assert.equal(normalizeThresherStage("Submitted Awaiting Confirmation").id, "submitted");
  assert.equal(normalizeThresherStage("Submitted (Awaiting Two Key Confirmations)").id, "submitted");
  assert.equal(normalizeThresherStage("Appointment Set").id, "appointment_legacy");
  assert.equal(normalizeThresherStage("Estimating Finalized (Awaiting ACV)").id, "awaiting_acv");
  assert.equal(normalizeThresherStage("Appraisal Finalized (Awaiting ACV)").id, "finalized");
});

test("requires every cumulative gate crossed by a forward leap", () => {
  const requiredGates = [
    "claimFiled",
    "deskAdjusterConfirmed",
    "paymentHandlingConfirmed",
    "carrierIssuanceConfirmed"
  ];
  const approved = validateThresherTransition({
    currentStatus: "Ready for PA Review",
    targetStatus: "Estimating Finalized (Awaiting ACV)",
    fileId: FILE_ID,
    evidence: {
      reason: "The carrier filed and issued the initial payment.",
      references: referencesFor(requiredGates)
    }
  });
  assert.deepEqual(approved.requiredGates, requiredGates);
  assert.deepEqual(approved.gates, Object.fromEntries(requiredGates.map((gate) => [gate, true])));
  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Estimating Finalized (Awaiting ACV)",
    fileId: FILE_ID,
    evidence: {
      reason: "Only issuance is documented for this test.",
      references: referencesFor(["carrierIssuanceConfirmed"]),
      gates: {
        deskAdjusterConfirmed: true,
        paymentHandlingConfirmed: true,
        carrierIssuanceConfirmed: true
      }
    }
  }), /deskAdjusterConfirmed, paymentHandlingConfirmed/);
});

test("allows evidence-backed next moves and rejects wrong-file references", () => {
  const approved = validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Negotiating",
    fileId: FILE_ID,
    evidence: {
      reason: "The carrier confirmed both required keys.",
      references: referencesFor(["deskAdjusterConfirmed", "paymentHandlingConfirmed"])
    }
  });
  assert.equal(approved.forward, true);
  assert.deepEqual(approved.requiredGates, ["deskAdjusterConfirmed", "paymentHandlingConfirmed"]);
  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Negotiating",
    fileId: FILE_ID,
    evidence: {
      reason: "The reference belongs to a different file.",
      references: referencesFor(
        ["deskAdjusterConfirmed", "paymentHandlingConfirmed"],
        { fileId: "different-file" }
      )
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Ready for PA Review",
    targetStatus: "Submitted Awaiting Confirmation",
    fileId: FILE_ID,
    evidence: {
      reason: "Call metadata cannot establish a semantic Thresher gate.",
      references: referencesFor(["claimFiled"], { source: "quo_call" })
    }
  }), /file-bound provider evidence/i);
});

test("derives gate confirmation only from allowed provider references", () => {
  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Negotiating",
    fileId: FILE_ID,
    evidence: {
      reason: "Caller-provided booleans cannot stand in for provider evidence.",
      references: referencesFor(["deskAdjusterConfirmed"]),
      gates: { deskAdjusterConfirmed: true, paymentHandlingConfirmed: true }
    }
  }), /paymentHandlingConfirmed/);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Negotiating",
    fileId: FILE_ID,
    evidence: {
      reason: "A disallowed source cannot establish a transition gate.",
      references: referencesFor(
        ["deskAdjusterConfirmed", "paymentHandlingConfirmed"],
        { source: "manager_decision" }
      )
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Ready for PA Review",
    targetStatus: "Submitted Awaiting Confirmation",
    fileId: FILE_ID,
    evidence: {
      reason: "A request or checklist cannot prove that filing occurred.",
      references: referencesFor(["claimFiled"], {
        fact: "Claim number requested on the claim-filed checklist."
      })
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Negotiating",
    fileId: FILE_ID,
    evidence: {
      reason: "Pending-language records cannot establish completed gates.",
      references: [
        ...referencesFor(["deskAdjusterConfirmed"], {
          fact: "Waiting on the assigned desk adjuster."
        }),
        ...referencesFor(["paymentHandlingConfirmed"], {
          id: "activity-pending-payment",
          fact: "Please confirm payment and check handling directions."
        })
      ]
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Negotiating",
    fileId: FILE_ID,
    evidence: {
      reason: "An unclassified reference cannot establish a transition gate.",
      references: [{ ...reference }]
    }
  }), /file-bound provider evidence/i);
});

test("rejects provider text that mentions a gate without affirmatively proving it", () => {
  for (const fact of [
    "Claim was filed unsuccessfully.",
    "Claim was filed but later canceled.",
    "Claim submitted, but carrier cannot locate the policy."
  ]) {
    assert.throws(() => validateThresherTransition({
      currentStatus: "Ready for PA Review",
      targetStatus: "Submitted Awaiting Confirmation",
      fileId: FILE_ID,
      evidence: {
        reason: "A failed or reversed filing cannot prove that the claim is active.",
        references: referencesFor(["claimFiled"], { fact })
      }
    }), /file-bound provider evidence/i);
  }

  assert.throws(() => validateThresherTransition({
    currentStatus: "Ready for Appraisal",
    targetStatus: "Submitted for Appraisal",
    fileId: FILE_ID,
    evidence: {
      reason: "A bounced appraisal demand cannot prove carrier delivery.",
      references: referencesFor(["appraisalDemandSent"], {
        fact: "Appraisal demand sent to the carrier but bounced as undeliverable."
      })
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted for Appraisal",
    targetStatus: "Carrier Appraiser Assigned",
    fileId: FILE_ID,
    evidence: {
      reason: "A placeholder cannot prove an appraiser assignment.",
      references: referencesFor(["carrierAppraiserAssigned"], {
        fact: "Carrier appraiser assigned: TBD."
      })
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Ready for PA Review",
    targetStatus: "Submitted Awaiting Confirmation",
    fileId: FILE_ID,
    evidence: {
      reason: "A question about filing cannot prove that filing occurred.",
      references: referencesFor(["claimFiled"], {
        fact: "Asked the homeowner whether the claim was filed yesterday."
      })
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Negotiating",
    fileId: FILE_ID,
    evidence: {
      reason: "An unanswered call cannot prove a desk-adjuster assignment.",
      references: [
        ...referencesFor(["deskAdjusterConfirmed"], {
          fact: "We called the desk adjuster but received no response."
        }),
        ...referencesFor(["paymentHandlingConfirmed"], {
          id: "activity-valid-payment"
        })
      ]
    }
  }), /deskAdjusterConfirmed/);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Negotiating",
    targetStatus: "Estimating Finalized (Awaiting ACV)",
    fileId: FILE_ID,
    evidence: {
      reason: "A rejected estimate cannot prove carrier issuance.",
      references: referencesFor(["carrierIssuanceConfirmed"], {
        fact: "Carrier estimate rejected as incorrect."
      })
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "HOT/Final Negotiation",
    targetStatus: "Estimating Finalized (Awaiting ACV)",
    fileId: FILE_ID,
    evidence: {
      reason: "Sending our estimate to a carrier does not prove carrier issuance.",
      references: referencesFor(["carrierIssuanceConfirmed"], {
        fact: "Company estimate sent to carrier."
      })
    }
  }), /file-bound provider evidence/i);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Estimating Finalized (Awaiting ACV)",
    targetStatus: "Ready for Appraisal",
    fileId: FILE_ID,
    evidence: {
      reason: "A needed comparison cannot prove an appraisal gap.",
      references: [
        ...referencesFor(["paymentReceiptConfirmed"]),
        ...referencesFor(["appraisalGapConfirmed"], {
          id: "activity-unproven-gap",
          fact: "Need company estimate comparison."
        })
      ]
    }
  }), /appraisalGapConfirmed/);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Estimating Finalized (Awaiting ACV)",
    targetStatus: "Ready for Appraisal",
    fileId: FILE_ID,
    evidence: {
      reason: "Carrier receipt for processing does not prove HCN payment control.",
      references: [
        ...referencesFor(["paymentReceiptConfirmed"], {
          fact: "Check received by carrier for processing."
        }),
        ...referencesFor(["appraisalGapConfirmed"], {
          id: "activity-valid-gap"
        })
      ]
    }
  }), /paymentReceiptConfirmed/);

  assert.throws(() => validateThresherTransition({
    currentStatus: "Ready for Appraisal",
    targetStatus: "Submitted for Appraisal",
    fileId: FILE_ID,
    evidence: {
      reason: "Internal review routing does not prove carrier delivery.",
      references: referencesFor(["appraisalDemandSent"], {
        fact: "Appraisal demand sent to Richard for review."
      })
    }
  }), /file-bound provider evidence/i);

  for (const fact of [
    "Payees are homeowner and mortgage company.",
    "Mailing destination: old address."
  ]) {
    assert.throws(() => validateThresherTransition({
      currentStatus: "Submitted Awaiting Confirmation",
      targetStatus: "HOT/Final Negotiation",
      fileId: FILE_ID,
      evidence: {
        reason: "An internal payee or destination statement is not carrier confirmation.",
        references: [
          ...referencesFor(["deskAdjusterConfirmed"]),
          ...referencesFor(["paymentHandlingConfirmed"], {
            id: `activity-unconfirmed-payment-${fact.length}`,
            fact
          }),
          ...referencesFor(["activeNegotiation"], {
            id: `activity-active-negotiation-${fact.length}`
          })
        ]
      }
    }), /paymentHandlingConfirmed/);
  }

  for (const scenario of [
    {
      currentStatus: "Submitted for Appraisal",
      targetStatus: "Carrier Appraiser Assigned",
      gate: "carrierAppraiserAssigned",
      fact: "Need carrier appraiser assigned."
    },
    {
      currentStatus: "Carrier Appraiser Assigned",
      targetStatus: "Appraisal Meeting Scheduled",
      gate: "appraisalMeetingScheduled",
      fact: "Need appraisal meeting scheduled for 8/25 at 10:00 AM."
    },
    {
      currentStatus: "Submitted for Appraisal",
      targetStatus: "Umpire",
      gate: "umpireInvoked",
      fact: "Need umpire assigned."
    },
    {
      currentStatus: "Appraisal Meeting Scheduled",
      targetStatus: "Initial Approval",
      gate: "initialAppraisalAgreement",
      fact: "Appraisers agreed to schedule another inspection."
    },
    {
      currentStatus: "Initial Approval",
      targetStatus: "Appraisal Finalized (Awaiting ACV)",
      gate: "fullyExecutedAward",
      fact: "Carrier accepted the estimate but not the award."
    }
  ]) {
    assert.throws(() => validateThresherTransition({
      currentStatus: scenario.currentStatus,
      targetStatus: scenario.targetStatus,
      fileId: FILE_ID,
      evidence: {
        reason: "Mentioning the next gate does not prove its completed outcome.",
        references: referencesFor([scenario.gate], { fact: scenario.fact })
      }
    }), /file-bound provider evidence/i);
  }

  assert.throws(() => validateThresherTransition({
    currentStatus: "Appraisal Finalized (Awaiting ACV)",
    targetStatus: "Ready for Production",
    fileId: FILE_ID,
    evidence: {
      reason: "A negative production statement cannot release the file.",
      references: [
        ...referencesFor(["finalPaymentConfirmed"]),
        ...referencesFor(["productionReleased"], {
          id: "activity-not-ready",
          fact: "We are not ready for production."
        })
      ]
    }
  }), /productionReleased/);

  for (const fact of [
    "Final payment issued by carrier.",
    "Final appraisal payment mailed by carrier."
  ]) {
    assert.throws(() => validateThresherTransition({
      currentStatus: "Appraisal Finalized (Awaiting ACV)",
      targetStatus: "Ready for Production",
      fileId: FILE_ID,
      evidence: {
        reason: "Carrier issuance or mailing does not prove final-payment receipt or control.",
        references: [
          ...referencesFor(["finalPaymentConfirmed"], {
            id: `activity-issued-only-${fact.length}`,
            fact
          }),
          ...referencesFor(["productionReleased"], {
            id: `activity-production-release-${fact.length}`,
            fact: "Production released and approved."
          })
        ]
      }
    }), /finalPaymentConfirmed/);
  }
});

test("blocks same-stage, backward, unsupported, and invalid legacy appointment moves", () => {
  const evidence = {
    reason: "Evidence exists only for the negative test.",
    references: referencesFor(["carrierIssuanceConfirmed"])
  };
  assert.throws(() => validateThresherTransition({
    currentStatus: "Ready for Appraisal",
    targetStatus: "Ready for Appraisal",
    evidence,
    fileId: FILE_ID
  }), /same-stage/i);
  assert.throws(() => validateThresherTransition({
    currentStatus: "Ready for Appraisal",
    targetStatus: "Awaiting ACV",
    evidence,
    fileId: FILE_ID
  }), /Backward Thresher stage moves are blocked/);
  assert.throws(() => validateThresherTransition({
    currentStatus: "Submitted Awaiting Confirmation",
    targetStatus: "Appointment Set",
    evidence,
    fileId: FILE_ID
  }), /not a valid Thresher destination/i);
  assert.throws(() => validateThresherTransition({
    currentStatus: "Mystery",
    targetStatus: "Negotiating",
    evidence,
    fileId: FILE_ID
  }), /not mapped in Thresher/);
  assert.throws(() => validateThresherTransition({
    currentStatus: "Appointment Set",
    targetStatus: "Awaiting ACV",
    evidence,
    fileId: FILE_ID
  }), /may move only to Negotiating/i);
});

test("Review for Close and Umpire use explicit branch gates", () => {
  const close = validateThresherTransition({
    currentStatus: "Negotiating",
    targetStatus: "Review for Close",
    fileId: FILE_ID,
    evidence: {
      reason: "Richard documented the exact close recommendation.",
      references: referencesFor(["richardDecision"])
    }
  });
  assert.deepEqual(close.requiredGates, ["richardDecision"]);
  const umpire = validateThresherTransition({
    currentStatus: "Submitted for Appraisal",
    targetStatus: "Umpire",
    fileId: FILE_ID,
    evidence: {
      reason: "The appraisers invoked the umpire branch.",
      references: referencesFor(["umpireInvoked"])
    }
  });
  assert.deepEqual(umpire.requiredGates, ["umpireInvoked"]);
});
