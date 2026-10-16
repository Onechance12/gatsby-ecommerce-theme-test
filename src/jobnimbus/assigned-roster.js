// File discovery/counting and permission to act are different questions.
// This module never fetches records, prepares effects, or grants approvals.
export function assignedRoster(contacts, {
  ownerId, insurance, assigned, active, actionAllowed, activeOnly = true,
  assignmentMode = "fixed_manifest"
}) {
  if (!Array.isArray(contacts) || !String(ownerId || "").trim()) {
    throw new Error("A complete provider index and configured owner are required for an assigned-file count.");
  }
  const ids = new Set();
  const numbers = new Set();
  const insuranceFiles = contacts.filter(insurance);
  for (const contact of insuranceFiles) {
    const id = String(contact.jnid || contact.id || "");
    const number = String(contact.number || contact.recid || "");
    if (!id || !number || (contact.jnid && contact.id && contact.jnid !== contact.id)
      || ids.has(id) || numbers.has(number)) {
      throw new Error("The assigned-file count is unavailable: missing or duplicate JobNimbus file identity.");
    }
    ids.add(id);
    numbers.add(number);
  }
  const owned = insuranceFiles.filter((contact) => assigned(contact, ownerId));
  const selected = owned.filter((contact) => !activeOnly || active(contact));
  const files = selected.filter(actionAllowed);
  const missingOwners = insuranceFiles.filter((contact) => !Array.isArray(contact.owners)).length;
  const missingActivity = owned.filter((contact) => ["is_active", "is_archived", "is_closed"].some(
    (key) => flag(contact[key]) === null
  )).length;
  return {
    files,
    filters: { ownerId, recordType: "Insurance", activeOnly },
    counts: {
      assignedInsurance: owned.length,
      assignedOpenActiveInsurance: owned.filter(active).length,
      matchingRequestedFilters: selected.length,
      returned: files.length,
      restrictedByActionScope: selected.length - files.length
    },
    countScope: assignmentMode === "live_assigned"
      ? "live_assigned_insurance"
      : "fixed_manifest_subset",
    coverage: {
      providerScanComplete: true,
      ownershipFieldsComplete: missingOwners === 0,
      missingOwnershipRecords: missingOwners,
      activityFieldsComplete: missingActivity === 0,
      missingActivityRecords: missingActivity,
      countIsExact: missingOwners === 0 && missingActivity === 0
    },
    limitations: [
      ...(missingOwners ? ["missing_ownership_fields"] : []),
      ...(missingActivity ? ["missing_activity_fields"] : []),
      ...(files.length !== selected.length ? ["assigned_files_restricted_by_action_scope"] : [])
    ]
  };
}

export function liveAssignedContactAllowed(contact, ownerId, excluded = ["2628"]) {
  const number = String(contact?.number || contact?.recid || "").trim().replace(/^#/, "");
  const id = String(contact?.jnid || contact?.id || "").trim();
  return Boolean(
    String(ownerId || "").trim()
    && /^\d+$/.test(number)
    && /^[a-zA-Z0-9_-]{8,100}$/.test(id)
    && !(contact.jnid && contact.id && contact.jnid !== contact.id)
    && !excluded.includes(number)
    && String(contact.record_type_name || "").toLowerCase() === "insurance"
    && Array.isArray(contact.owners)
    && contact.owners.some((owner) => String(owner?.id || owner?.jnid || owner || "") === ownerId)
    && flag(contact.is_active) === true
    && flag(contact.is_archived) === false
    && flag(contact.is_closed) === false
    && flag(contact.is_deleted) !== true
    && (contact.is_deleted === undefined || flag(contact.is_deleted) !== null)
    && !/\b(closed|cancelled|canceled|archived|dead)\b/i.test(String(contact.status_name || ""))
  );
}

function flag(value) {
  if (value === true || value === 1 || value === "true" || value === "1") return true;
  if (value === false || value === 0 || value === "false" || value === "0") return false;
  return null;
}
