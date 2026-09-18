// File uploads do not always create an /activities row in JobNimbus. Use the
// provider's creation timestamp, never a filename date or mutable update time.
export function managementDocumentActivities(documents, { fileId, knownFileIds, asOf }) {
  if (!Array.isArray(documents) || documents.length > 5000) throw new Error("Invalid document collection");
  const events = [];
  const summary = { fetched: documents.length, counted: 0, excluded: 0, uncertain: 0, ambiguous: 0 };
  const seen = new Set();
  for (const doc of documents) {
    const id = String(doc?.jnid || doc?.id || "");
    if (!id || id.length > 480 || /[\s\x00-\x1f\x7f]/.test(id) || seen.has(id)) throw new Error("Invalid or duplicate document identity");
    seen.add(id);
    const links = new Set();
    function collect(value) {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") collect(value.id || value.jnid);
      else if (typeof value === "string" && knownFileIds.has(value)) links.add(value);
    }
    for (const key of ["related", "primary", "contact", "parent"]) collect(doc[key]);
    if (!links.has(fileId)) throw new Error("Document escaped the exact-file scope");
    if (links.size !== 1) { summary.ambiguous++; continue; }
    const marker = [doc.source_type, doc.origin, doc.status_name, doc.created_by_name]
      .map(value => typeof value === "string" ? value.toLowerCase() : "").join(" ");
    if (["is_deleted", "deleted", "is_archived", "is_automated", "automated", "is_system"].some(k => doc[k] === true)
      || doc.is_active === false || /\b(system|automated|automation|import|imported|sync|synced|zapier|draft|pending)\b/.test(marker)) {
      summary.excluded++; continue;
    }
    const rawAt = doc.date_created ?? doc.created_at ?? doc.createdAt;
    const numeric = typeof rawAt === "number" || (typeof rawAt === "string" && /^\d+(\.\d+)?$/.test(rawAt));
    const millis = numeric ? Number(rawAt) * (Number(rawAt) < 1e12 ? 1000 : 1) : Date.parse(rawAt);
    const actor = doc.created_by ?? doc.createdBy;
    const hasActor = (typeof actor === "string" && Boolean(actor.trim()))
      || (actor && typeof actor === "object" && Boolean(actor.id || actor.jnid))
      || (typeof doc.created_by_name === "string" && Boolean(doc.created_by_name.trim()));
    if (!hasActor || !Number.isFinite(millis) || millis <= 0 || millis > Date.parse(asOf)) { summary.uncertain++; continue; }
    events.push({ evidenceId: `document:${id}`, providerFileId: fileId, source: "jobnimbus",
      kind: "document_uploaded", state: "uploaded", occurredAt: new Date(millis).toISOString(),
      actorAdjusterId: null, classification: "operational" });
    summary.counted++;
  }
  return { events, summary };
}
