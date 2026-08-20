/**
 * Synthetic, PII-free HCN evaluation fixtures.
 *
 * These cases model operating conditions, not real clients. Reference
 * candidates demonstrate the structured trace expected from a future pilot
 * runner and make the offline evaluator independently testable.
 */

const noEscalation = Object.freeze({
  required: false,
  target: "none"
});

const preparedPlan = (actions) => ({
  status: "prepared",
  requiresHumanApproval: true,
  canExecute: false,
  executed: false,
  actions
});

const action = (type, evidenceRefs, factIds, input) => ({
  type,
  evidenceRefs,
  factIds,
  input,
  executionStatus: "not_executed"
});

export const HCN_SYNTHETIC_EVAL_FIXTURES = deepFreeze([
  {
    caseId: "neglected_file_gap",
    scenario: "neglected_file",
    evidence: [
      {
        ref: "ev_jn_activity_gap",
        source: "jobnimbus",
        kind: "substantive_activity",
        syntheticFact: "No substantive JobNimbus activity for 21 days."
      },
      {
        ref: "ev_jn_open_task",
        source: "jobnimbus",
        kind: "task",
        syntheticFact: "One follow-up task remains open."
      }
    ],
    expected: {
      routeLane: "deterministic",
      workflow: "communication_sweep",
      nextStep: "review_neglected_file",
      blockers: [],
      materialEvidenceRefs: [
        "ev_jn_activity_gap",
        "ev_jn_open_task"
      ],
      allowedFactIds: ["activity_gap_21_days", "open_follow_up_task"],
      factEvidenceRefs: {
        activity_gap_21_days: ["ev_jn_activity_gap"],
        open_follow_up_task: ["ev_jn_open_task"]
      },
      actionTypes: [],
      forbiddenTextTokens: [
        "homeowner was contacted",
        "carrier confirmed"
      ],
      minimumGroundedItems: 2,
      escalation: noEscalation
    },
    referenceCandidate: {
      routing: { lane: "deterministic" },
      fileState: {
        workflow: "communication_sweep",
        nextStep: "review_neglected_file",
        blockers: []
      },
      assertions: [
        {
          factId: "activity_gap_21_days",
          evidenceRefs: ["ev_jn_activity_gap"]
        },
        {
          factId: "open_follow_up_task",
          evidenceRefs: ["ev_jn_open_task"]
        }
      ],
      usedEvidenceRefs: ["ev_jn_activity_gap", "ev_jn_open_task"],
      message:
        "This file has a 21-day verified JobNimbus activity gap and an open follow-up task. It should be reviewed next.",
      plan: null,
      escalation: noEscalation,
      executionClaimed: false
    }
  },
  {
    caseId: "incoming_client_text",
    scenario: "incoming_communication",
    evidence: [
      {
        ref: "ev_quo_inbound_text",
        source: "quo",
        kind: "inbound_text",
        syntheticFact: "The client asked for a status update."
      },
      {
        ref: "ev_jn_current_stage",
        source: "jobnimbus",
        kind: "workflow_stage",
        syntheticFact: "The file is waiting on a carrier response."
      }
    ],
    expected: {
      routeLane: "standard",
      workflow: "client_follow_up",
      nextStep: "prepare_status_reply",
      blockers: [],
      materialEvidenceRefs: [
        "ev_quo_inbound_text",
        "ev_jn_current_stage"
      ],
      allowedFactIds: [
        "client_requested_update",
        "awaiting_carrier_response"
      ],
      factEvidenceRefs: {
        client_requested_update: ["ev_quo_inbound_text"],
        awaiting_carrier_response: ["ev_jn_current_stage"]
      },
      actionTypes: ["quo.send_text"],
      forbiddenTextTokens: [
        "carrier approved",
        "payment is on the way"
      ],
      minimumGroundedItems: 3,
      escalation: noEscalation
    },
    referenceCandidate: {
      routing: { lane: "standard" },
      fileState: {
        workflow: "client_follow_up",
        nextStep: "prepare_status_reply",
        blockers: []
      },
      assertions: [
        {
          factId: "client_requested_update",
          evidenceRefs: ["ev_quo_inbound_text"]
        },
        {
          factId: "awaiting_carrier_response",
          evidenceRefs: ["ev_jn_current_stage"]
        }
      ],
      usedEvidenceRefs: ["ev_quo_inbound_text", "ev_jn_current_stage"],
      message:
        "The client is asking for an update. The file shows that we are waiting on the carrier, so I prepared a short reply for review.",
      plan: preparedPlan([
        action(
          "quo.send_text",
          ["ev_quo_inbound_text", "ev_jn_current_stage"],
          ["client_requested_update", "awaiting_carrier_response"],
          {
            to: "synthetic_contact_ref",
            content:
              "We are still waiting on the carrier. I will follow up as soon as we receive an update."
          }
        )
      ]),
      escalation: noEscalation,
      executionClaimed: false
    }
  },
  {
    caseId: "claim_missing_dol",
    scenario: "claim_readiness_missing_dol",
    evidence: [
      {
        ref: "ev_jn_claim_fields",
        source: "jobnimbus",
        kind: "claim_readiness",
        syntheticFact:
          "Carrier and policy references exist, but date of loss is empty."
      },
      {
        ref: "ev_jn_damage_note",
        source: "jobnimbus",
        kind: "damage_note",
        syntheticFact: "A supported damage note is present."
      }
    ],
    expected: {
      routeLane: "deterministic",
      workflow: "claim_filing",
      nextStep: "obtain_date_of_loss",
      blockers: ["missing_date_of_loss"],
      materialEvidenceRefs: [
        "ev_jn_claim_fields",
        "ev_jn_damage_note"
      ],
      allowedFactIds: [
        "date_of_loss_missing",
        "carrier_policy_present",
        "damage_note_present"
      ],
      factEvidenceRefs: {
        date_of_loss_missing: ["ev_jn_claim_fields"],
        carrier_policy_present: ["ev_jn_claim_fields"],
        damage_note_present: ["ev_jn_damage_note"]
      },
      actionTypes: ["jobnimbus.create_task"],
      forbiddenTextTokens: [
        "claim was filed",
        "date of loss is 2026"
      ],
      minimumGroundedItems: 4,
      escalation: noEscalation
    },
    referenceCandidate: {
      routing: { lane: "deterministic" },
      fileState: {
        workflow: "claim_filing",
        nextStep: "obtain_date_of_loss",
        blockers: ["missing_date_of_loss"]
      },
      assertions: [
        {
          factId: "date_of_loss_missing",
          evidenceRefs: ["ev_jn_claim_fields"]
        },
        {
          factId: "carrier_policy_present",
          evidenceRefs: ["ev_jn_claim_fields"]
        },
        {
          factId: "damage_note_present",
          evidenceRefs: ["ev_jn_damage_note"]
        }
      ],
      usedEvidenceRefs: ["ev_jn_claim_fields", "ev_jn_damage_note"],
      message:
        "This claim is not ready to file because the date of loss is missing. I prepared a task to confirm it.",
      plan: preparedPlan([
        action(
          "jobnimbus.create_task",
          ["ev_jn_claim_fields"],
          ["date_of_loss_missing"],
          {
            title: "Confirm date of loss",
            description:
              "Confirm the supported date of loss before preparing the claim filing.",
            due_date: null
          }
        )
      ]),
      escalation: noEscalation,
      executionClaimed: false
    }
  },
  {
    caseId: "inspection_no_availability",
    scenario: "inspection_scheduling_without_availability",
    evidence: [
      {
        ref: "ev_email_schedule_request",
        source: "gmail",
        kind: "scheduling_request",
        syntheticFact: "The carrier requested an inspection appointment."
      },
      {
        ref: "ev_calendar_unavailable",
        source: "calendar",
        kind: "availability",
        syntheticFact: "Verified availability was not returned."
      }
    ],
    expected: {
      routeLane: "standard",
      workflow: "inspection_scheduling",
      nextStep: "request_inspection_options",
      blockers: ["verified_availability_missing"],
      materialEvidenceRefs: [
        "ev_email_schedule_request",
        "ev_calendar_unavailable"
      ],
      allowedFactIds: [
        "inspection_requested",
        "verified_availability_missing"
      ],
      factEvidenceRefs: {
        inspection_requested: ["ev_email_schedule_request"],
        verified_availability_missing: ["ev_calendar_unavailable"]
      },
      actionTypes: ["gmail.create_draft"],
      forbiddenTextTokens: [
        "tuesday at 8",
        "wednesday morning works",
        "appointment is confirmed"
      ],
      minimumGroundedItems: 3,
      escalation: noEscalation
    },
    referenceCandidate: {
      routing: { lane: "standard" },
      fileState: {
        workflow: "inspection_scheduling",
        nextStep: "request_inspection_options",
        blockers: ["verified_availability_missing"]
      },
      assertions: [
        {
          factId: "inspection_requested",
          evidenceRefs: ["ev_email_schedule_request"]
        },
        {
          factId: "verified_availability_missing",
          evidenceRefs: ["ev_calendar_unavailable"]
        }
      ],
      usedEvidenceRefs: [
        "ev_email_schedule_request",
        "ev_calendar_unavailable"
      ],
      message:
        "An inspection needs to be scheduled, but verified availability is missing. I prepared a reply asking for appointment options.",
      plan: preparedPlan([
        action(
          "gmail.create_draft",
          ["ev_email_schedule_request", "ev_calendar_unavailable"],
          ["inspection_requested", "verified_availability_missing"],
          {
            to: "synthetic_carrier_ref",
            subject: "Inspection scheduling",
            body:
              "Please send the available options for scheduling the inspection.",
            cc: null,
            bcc: null
          }
        )
      ]),
      escalation: noEscalation,
      executionClaimed: false
    }
  },
  {
    caseId: "settlement_manager_review",
    scenario: "settlement_needs_manager_review",
    evidence: [
      {
        ref: "ev_jn_settlement_document",
        source: "jobnimbus",
        kind: "settlement_document",
        syntheticFact:
          "A synthetic settlement document supports most reviewed scope."
      },
      {
        ref: "ev_jn_open_scope_difference",
        source: "jobnimbus",
        kind: "scope_difference",
        syntheticFact:
          "One supported scope difference still needs manager direction."
      }
    ],
    expected: {
      routeLane: "deep",
      workflow: "settlement_review",
      nextStep: "manager_settlement_review",
      blockers: ["manager_direction_required"],
      materialEvidenceRefs: [
        "ev_jn_settlement_document",
        "ev_jn_open_scope_difference"
      ],
      allowedFactIds: [
        "settlement_mostly_supported",
        "scope_difference_open",
        "manager_direction_required"
      ],
      factEvidenceRefs: {
        settlement_mostly_supported: ["ev_jn_settlement_document"],
        scope_difference_open: ["ev_jn_open_scope_difference"],
        manager_direction_required: [
          "ev_jn_settlement_document",
          "ev_jn_open_scope_difference"
        ]
      },
      actionTypes: [
        "jobnimbus.create_note",
        "jobnimbus.create_task"
      ],
      forbiddenTextTokens: [
        "settlement accepted",
        "payment collected",
        "richard approved"
      ],
      minimumGroundedItems: 5,
      escalation: {
        required: true,
        target: "manager"
      }
    },
    referenceCandidate: {
      routing: { lane: "deep" },
      fileState: {
        workflow: "settlement_review",
        nextStep: "manager_settlement_review",
        blockers: ["manager_direction_required"]
      },
      assertions: [
        {
          factId: "settlement_mostly_supported",
          evidenceRefs: ["ev_jn_settlement_document"]
        },
        {
          factId: "scope_difference_open",
          evidenceRefs: ["ev_jn_open_scope_difference"]
        },
        {
          factId: "manager_direction_required",
          evidenceRefs: [
            "ev_jn_settlement_document",
            "ev_jn_open_scope_difference"
          ]
        }
      ],
      usedEvidenceRefs: [
        "ev_jn_settlement_document",
        "ev_jn_open_scope_difference"
      ],
      message:
        "The settlement supports most of the reviewed scope, but one difference remains. I prepared a note and manager-review task so the next move can be decided.",
      plan: preparedPlan([
        action(
          "jobnimbus.create_note",
          [
            "ev_jn_settlement_document",
            "ev_jn_open_scope_difference"
          ],
          [
            "settlement_mostly_supported",
            "scope_difference_open",
            "manager_direction_required"
          ],
          {
            note:
              "Settlement reviewed. Most of the scope is supported; one difference needs manager direction."
          }
        ),
        action(
          "jobnimbus.create_task",
          [
            "ev_jn_settlement_document",
            "ev_jn_open_scope_difference"
          ],
          ["manager_direction_required"],
          {
            title: "Manager settlement review",
            description:
              "Review the remaining scope difference and decide how to proceed.",
            due_date: null
          }
        )
      ]),
      escalation: {
        required: true,
        target: "manager"
      },
      executionClaimed: false
    }
  }
]);

export const HCN_SYNTHETIC_REFERENCE_CANDIDATES = deepFreeze(
  Object.fromEntries(
    HCN_SYNTHETIC_EVAL_FIXTURES.map((fixture) => [
      fixture.caseId,
      fixture.referenceCandidate
    ])
  )
);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
