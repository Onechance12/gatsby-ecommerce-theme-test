/**
 * Closed vocabularies for HCN's deterministic, read-only file intelligence.
 *
 * The intelligence core accepts coded facts and opaque references only. Raw
 * provider content belongs at the fresh-read boundary and must never enter
 * this module.
 */

export const FILE_INTELLIGENCE_SCHEMA =
  "hcn.ops.file-intelligence.v1";
export const WORKFLOW_EVALUATION_SCHEMA =
  "hcn.ops.workflow-evaluation.v1";

export const SOURCE_NAMES = Object.freeze([
  "jobnimbus",
  "gmail",
  "quo",
  "google_calendar",
  "retell"
]);

export const SOURCE_STATUSES = Object.freeze([
  "fresh",
  "stale",
  "unavailable",
  "unsupported",
  "unknown"
]);

export const SOURCE_COMPLETENESS = Object.freeze([
  "complete",
  "partial",
  "none"
]);

export const FILE_STATUSES = Object.freeze(["active", "inactive"]);

export const STAGE_CODES = Object.freeze([
  "intake",
  "claim_readiness",
  "claim_filed",
  "inspection_scheduling",
  "inspection_scheduled",
  "adjustment",
  "estimate",
  "supplement",
  "settlement_review",
  "payment_collection",
  "closed",
  "unknown"
]);

export const FACT_CODES = Object.freeze([
  "carrier",
  "policy_identifier",
  "carrier_contact",
  "date_of_loss",
  "damage_facts",
  "claim_identifier",
  "adjuster_contact",
  "inspection_appointment",
  "homeowner_availability",
  "homeowner_confirmation",
  "coverage_decision",
  "settlement_status",
  "payment_status"
]);

export const FACT_STATES = Object.freeze([
  "confirmed",
  "absent",
  "unknown",
  "disputed",
  "not_applicable"
]);

export const DOCUMENT_CODES = Object.freeze([
  "policy_declaration",
  "authorization_lor",
  "damage_evidence",
  "estimate",
  "carrier_scope",
  "settlement_document",
  "payment_evidence"
]);

export const DOCUMENT_STATES = Object.freeze([
  "present",
  "absent",
  "unknown",
  "not_applicable"
]);

export const REVIEW_STATES = Object.freeze([
  "not_required",
  "needs_review",
  "in_review",
  "reviewed",
  "unknown"
]);

export const EVENT_CODES = Object.freeze([
  // Verified communication.
  "email_received",
  "email_sent_verified",
  "text_received",
  "text_delivered",
  "call_answered",
  "call_completed",

  // Attempted or incomplete communication. These never prove contact.
  "email_send_failed",
  "email_outbound_unverified",
  "text_sent_unconfirmed",
  "text_failed",
  "call_no_answer",
  "call_missed",
  "voicemail_left",
  "outbound_call_failed",

  // Meaningful operational progress.
  "note_substantive",
  "task_completed",
  "claim_filed",
  "claim_result_recorded",
  "appointment_scheduled",
  "appointment_rescheduled",
  "appointment_completed",
  "document_received",
  "document_uploaded",
  "document_reviewed",
  "status_progressed",
  "estimate_created",
  "estimate_revised",
  "supplement_submitted",
  "settlement_received",
  "settlement_reviewed",
  "payment_received",
  "payment_follow_up",

  // Non-substantive noise. These never reset activity or contact gaps.
  "email_draft",
  "text_draft",
  "note_cosmetic",
  "note_automated",
  "task_created",
  "task_reassigned",
  "reminder_generated",
  "file_opened",
  "status_cosmetic",
  "duplicate",
  "system_sync",
  "unknown"
]);

export const EVENT_ACTION_STATES = Object.freeze([
  "none",
  "awaiting_response",
  "responded",
  "failed",
  "unverified",
  "draft",
  "unknown"
]);

export const TASK_CODES = Object.freeze([
  "client_follow_up",
  "document_review",
  "claim_filing",
  "inspection_coordination",
  "carrier_follow_up",
  "adjuster_follow_up",
  "payment_collection",
  "file_review",
  "other"
]);

export const TASK_STATUSES = Object.freeze([
  "open",
  "blocked",
  "completed",
  "cancelled"
]);

export const PRIORITIES = Object.freeze([
  "low",
  "normal",
  "high",
  "urgent"
]);

export const PROMISE_CODES = Object.freeze([
  "client_follow_up",
  "send_document",
  "review_document",
  "file_claim",
  "schedule_inspection",
  "carrier_follow_up",
  "adjuster_follow_up",
  "collect_payment",
  "provide_update",
  "other"
]);

export const PROMISE_STATES = Object.freeze([
  "open",
  "fulfilled",
  "cancelled",
  "unknown"
]);

export const WORKFLOW_IDS = Object.freeze([
  "neglected_files",
  "communications",
  "claim_filing",
  "inspection_scheduling",
  "follow_up"
]);

export const SUCCESSFUL_CONTACT_CODES = Object.freeze([
  "email_received",
  "email_sent_verified",
  "text_received",
  "text_delivered",
  "call_answered",
  "call_completed"
]);

export const ATTEMPT_ONLY_CODES = Object.freeze([
  "email_send_failed",
  "email_outbound_unverified",
  "text_sent_unconfirmed",
  "text_failed",
  "call_no_answer",
  "call_missed",
  "voicemail_left",
  "outbound_call_failed"
]);

export const OPERATIONAL_ACTIVITY_CODES = Object.freeze([
  "note_substantive",
  "task_completed",
  "claim_filed",
  "claim_result_recorded",
  "appointment_scheduled",
  "appointment_rescheduled",
  "appointment_completed",
  "document_received",
  "document_uploaded",
  "document_reviewed",
  "status_progressed",
  "estimate_created",
  "estimate_revised",
  "supplement_submitted",
  "settlement_received",
  "settlement_reviewed",
  "payment_received",
  "payment_follow_up"
]);

export const LIMITS = Object.freeze({
  sources: SOURCE_NAMES.length,
  stages: 32,
  facts: 128,
  documents: 128,
  events: 512,
  tasks: 256,
  promises: 256,
  workflowItems: 2048,
  evidenceRefsPerOutput: 2048
});

export const OPAQUE_PATTERNS = Object.freeze({
  fileRef: /^subject_[a-f0-9]{32}$/,
  ownerRef: /^(?:actor|adjuster|employee)_[a-f0-9]{16,64}$/,
  evidenceRef: /^ref_[a-f0-9]{16,64}$/,
  valueRef: /^value_[a-f0-9]{16,64}$/
});

export const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const MILLISECONDS_PER_DAY = 86_400_000;
