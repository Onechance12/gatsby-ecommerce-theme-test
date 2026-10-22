// Metadata-only explanation of existing exclusions. Never changes admission,
// activity classification or ranking, and never fetches additional evidence.
export const MANAGEMENT_EXCEPTION_DETAIL_LIMIT = 100;

export function summarizeUnsupportedManagementActivities(events) {
  const groups = new Map();
  let totalRecordCount = 0;
  for (const event of events) {
    if (event.classification !== "unsupported") continue;
    totalRecordCount++;
    const key = `${event.kind}:${event.state}`;
    const group = groups.get(key) || {
      kind: event.kind, state: event.state, count: 0,
      latestAt: event.occurredAt, evidenceId: event.evidenceId
    };
    group.count++;
    if (event.occurredAt > group.latestAt
      || (event.occurredAt === group.latestAt && event.evidenceId < group.evidenceId)) {
      group.latestAt = event.occurredAt;
      group.evidenceId = event.evidenceId;
    }
    groups.set(key, group);
  }
  return {
    totalRecordCount,
    totalGroupCount: groups.size,
    items: [...groups.values()]
      .sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.kind.localeCompare(b.kind) || a.state.localeCompare(b.state))
      .slice(0, MANAGEMENT_EXCEPTION_DETAIL_LIMIT)
  };
}

export function projectManagementCoverageExceptions(data, { references, adjusters }) {
  const ownerRefs = new Map(adjusters.map(owner => [owner.ownerId, owner.adjusterRef]));
  const ownerRef = (id) => {
    const ref = ownerRefs.get(id);
    if (!ref) throw new Error("Management exception owner is outside configured scope.");
    return ref;
  };
  const fileDisplay = file => ({ name: file.displayName, jobNumber: file.jobNumber });
  const ownershipItems = (data.ownershipExceptions || [])
    .slice(0, MANAGEMENT_EXCEPTION_DETAIL_LIMIT)
    .map(file => ({
      fileRef: references.subjectId("jobnimbus", file.providerFileId),
      display: fileDisplay(file),
      adjusterRefs: file.matchingOwnerIds.map(ownerRef),
      // Original admission stops before the active-state predicate.
      activityState: "not_evaluated"
    }));
  const totalCount = data.excluded.ambiguousOwner;
  let totalRecordCount = 0;
  let totalGroupCount = 0;
  const unsupportedItems = [];
  for (const file of data.files) {
    const summary = file.unsupportedActivities;
    totalRecordCount += Number(file.eventSummary?.unsupportedEventCount || 0);
    totalGroupCount += summary?.totalGroupCount || 0;
    if (!summary) continue;
    for (const group of summary.items) {
      if (unsupportedItems.length === MANAGEMENT_EXCEPTION_DETAIL_LIMIT) break;
      unsupportedItems.push({
        fileRef: references.subjectId("jobnimbus", file.providerFileId),
        display: fileDisplay(file),
        adjusterRef: ownerRef(file.assignedAdjusterId),
        kind: group.kind, state: group.state, count: group.count,
        latestAt: group.latestAt,
        evidenceRef: references.sourceRecordRef("jobnimbus", group.evidenceId)
      });
    }
  }
  return {
    ownership: {
      totalCount, returnedCount: ownershipItems.length,
      truncated: totalCount > ownershipItems.length, items: ownershipItems
    },
    unsupportedActivities: {
      totalRecordCount, totalGroupCount, returnedGroupCount: unsupportedItems.length,
      truncated: totalGroupCount > unsupportedItems.length, items: unsupportedItems
    }
  };
}
