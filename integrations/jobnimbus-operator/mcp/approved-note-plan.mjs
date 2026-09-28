import { createHash } from "node:crypto";
import { validateApprovedNoteOperation, approvedNoteMentionIntent, matchesApprovedNoteMentionIntent } from "./approved-note-release.mjs";

const plainObject = (value) => Boolean(value && Object.getPrototypeOf(value) === Object.prototype);
const exactKeys = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const providerId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);

// Approval storage must bind what the user sees to the exact caller input.
// A server's displayComplete flag alone is not proof of the displayed note.
export function assertApprovedNotePlan(response, operations, operatorScope, options = {}) {
  if (!operations.some((operation) => operation?.type === "jobnimbus.create_note")) return;
  validateApprovedNoteOperation(operations, operatorScope, options);
  const requested = operations[0].payload;
  const number = requested.query.replace(/^#/, "");
  const noteSha256 = createHash("sha256").update(requested.note, "utf8").digest("hex");
  const mentionIntent = approvedNoteMentionIntent(requested.note);
  const file = response?.files?.[0];
  const operation = response?.operations?.[0];
  const prepared = operation?.plan;
  const plan = prepared?.plan;
  if (
    response?.mode !== "dry_run"
    || response?.batchMode !== "assigned_single_file_v2"
    || response?.fileCount !== 1 || response?.operationCount !== 1
    || response?.displayComplete !== true
    || response?.executionSemantics !== "sequential_fail_stop_no_rollback"
    || !Array.isArray(response?.files) || response.files.length !== 1
    || !plainObject(file) || !providerId(file.id)
    || String(file.number) !== number
    || !Array.isArray(file.operationIndexes) || file.operationIndexes.length !== 1 || file.operationIndexes[0] !== 0
    || !Array.isArray(file.operationTypes) || file.operationTypes.length !== 1 || file.operationTypes[0] !== "jobnimbus.create_note"
    || !Array.isArray(response?.operations) || response.operations.length !== 1
    || !exactKeys(operation, ["type", "plan"]) || operation.type !== "jobnimbus.create_note"
    || !exactKeys(prepared, ["mode", "file", "plan"]) || prepared.mode !== "dry_run"
    || !plainObject(prepared.file) || prepared.file.id !== file.id || String(prepared.file.number) !== number
    || !exactKeys(plan, ["endpoint", "note", "noteSha256", "mentionRequested", "intendedRecipient", "mentionsVerified", "accountingNotified", "notificationNotice", "beforeIds", "body"])
    || plan.endpoint !== "/activities" || plan.note !== requested.note || plan.noteSha256 !== noteSha256
    || plan.mentionsVerified !== false || plan.accountingNotified !== false
    || !matchesApprovedNoteMentionIntent(plan, mentionIntent)
    || plan.notificationNotice !== (mentionIntent.mentionRequested
      ? "The exact @RichardR tag will be saved. Notification delivery to Richard is not confirmed by the API."
      : "No notification requested.")
    || !Array.isArray(plan.beforeIds) || !plan.beforeIds.every(providerId)
    || new Set(plan.beforeIds).size !== plan.beforeIds.length
    || !exactKeys(plan.body, ["note", "record_type_name", "primary"])
    || plan.body.note !== requested.note || plan.body.record_type_name !== "Note"
    || !exactKeys(plan.body.primary, ["id"]) || plan.body.primary.id !== file.id
  ) {
    throw new Error("The approval display does not bind the exact requested plain note, file, and provider body. No local approval was stored.");
  }
}
