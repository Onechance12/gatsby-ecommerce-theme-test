// JobNimbus can omit its derived is_closed contact field after a partial PUT.
// Only the matching provider workflow/status can supply the omitted value.
// This function does not fetch, write, or decide owner/action eligibility.
export function contactWithWorkflowClosure(contact, settings) {
  if (!record(contact) || Object.hasOwn(contact, "is_closed")) return contact;
  const workflowId = numericId(contact.record_type);
  const statusId = numericId(contact.status);
  const workflowName = name(contact.record_type_name);
  const statusName = name(contact.status_name);
  // The documented field selector may return the selected array directly.
  const rows = Array.isArray(settings) ? settings
    : record(settings) && Array.isArray(settings.workflows) ? settings.workflows : null;
  if (!workflowId || !statusId || !workflowName || !statusName
    || !rows) return contact;
  const workflows = rows.filter((row) => record(row)
    && numericId(row.id) === workflowId);
  if (workflows.length !== 1) return contact;
  const workflow = workflows[0];
  if (workflow.object_type !== "contact" || name(workflow.name) !== workflowName
    || flag(workflow.is_active) !== true || !Array.isArray(workflow.status)) return contact;
  const statuses = workflow.status.filter((row) => record(row)
    && numericId(row.id) === statusId);
  if (statuses.length !== 1) return contact;
  const status = statuses[0];
  const closed = flag(status.is_closed);
  if (name(status.name) !== statusName || closed === null
    || flag(status.is_active) !== true || flag(status.is_archived) !== false) return contact;
  return {
    ...contact,
    is_closed: closed,
    closureVerification: {
      schemaVersion: 1,
      source: "jobnimbus_workflow_status",
      workflowId,
      statusId,
      isClosed: closed
    }
  };
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numericId(value) {
  if ((typeof value !== "number" && typeof value !== "string")
    || !/^[1-9]\d{0,14}$/.test(String(value))) return "";
  return String(value);
}

function name(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function flag(value) {
  if (value === true || value === 1 || value === "true" || value === "1") return true;
  if (value === false || value === 0 || value === "false" || value === "0") return false;
  return null;
}
