const phone = value => /^\+1\d{10}$/.test(String(value || "")) ? String(value) : "";
const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,512}$/.test(value);
const list = value => Array.isArray(value) ? value : [];

// Transport is GET-only and bounded by the existing Quo provider client.
export async function readRecentQuoActivity({ readJson, lineNumber, window }) {
  if (!phone(lineNumber)) throw new Error("Quo sweep requires the authenticated operator's configured line.");
  const limitations = new Set();
  const providerRead = readJson, startedAt = Date.now();
  let requestCount = 0;
  readJson = path => {
    if (++requestCount > 120 || Date.now() - startedAt > 90000) {
      limitations.add("provider_read_budget_reached");
      throw new Error("Quo discovery read budget reached.");
    }
    return providerRead(path);
  };
  const pageRows = async (path, maximumPages = 3) => {
    const rows = [], tokens = new Set();
    let token = "";
    for (let page = 0; page < maximumPages; page += 1) {
      if (tokens.has(token)) { limitations.add("repeated_page_token"); break; }
      tokens.add(token);
      const suffix = token ? `${path.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(token)}` : "";
      const payload = await readJson(path + suffix);
      if (!payload || !Array.isArray(payload.data) || payload.data.length > 100) throw new Error("Invalid Quo discovery page.");
      rows.push(...payload.data);
      if (payload.nextPageToken !== undefined && payload.nextPageToken !== null && typeof payload.nextPageToken !== "string") { limitations.add("invalid_page_token"); break; }
      token = payload.nextPageToken || "";
      if (!token) break;
      if (token.length > 2048) { limitations.add("invalid_page_token"); break; }
      if (page + 1 === maximumPages) limitations.add("pagination_limit_reached");
    }
    return rows;
  };
  const lines = await pageRows("/phone-numbers");
  const matching = lines.filter(line => line?.number === lineNumber && safeId(line.id));
  if (matching.length !== 1) throw new Error("Quo sweep line binding failed.");
  const line = matching[0];
  const params = new URLSearchParams({ phoneNumbers: line.id, updatedAfter: window.start, maxResults: "100" });
  const conversations = await pageRows(`/conversations?${params}`);
  conversations.sort((a, b) => String(b?.lastActivityAt || b?.updatedAt || "").localeCompare(String(a?.lastActivityAt || a?.updatedAt || "")));
  const byId = new Map(), seenConversations = new Set();
  if (conversations.length > 25) limitations.add("conversation_limit_reached");
  for (const conversation of conversations.slice(0, 25)) {
    if (!conversation || conversation.phoneNumberId !== line.id || !safeId(conversation.id) || seenConversations.has(conversation.id)) { limitations.add("invalid_conversation_scope"); continue; }
    seenConversations.add(conversation.id);
    if (conversation.deletedAt) continue;
    const participants = list(conversation.participants).map(phone).filter(value => value && value !== lineNumber);
    if (!participants.length || participants.length !== new Set(participants).size || participants.length > 10
      || participants.length !== list(conversation.participants).filter(value => value !== lineNumber).length) { limitations.add("invalid_conversation_participants"); continue; }
    for (const kind of ["calls", "messages"]) {
      if (requestCount >= 120 || Date.now() - startedAt > 90000) { limitations.add("provider_read_budget_reached"); break; }
      const query = new URLSearchParams({ phoneNumberId: line.id, createdAfter: window.start, createdBefore: window.end, maxResults: "100" });
      for (const participant of participants) query.append("participants", participant);
      let rows;
      try { rows = await pageRows(`/${kind}?${query}`); }
      catch { limitations.add(`${kind}_unavailable`); continue; }
      for (const row of rows) {
        if (!row || row.phoneNumberId !== line.id || !safeId(row.id)
          || (row.conversationId && row.conversationId !== conversation.id)) { limitations.add("invalid_record_scope"); continue; }
        const rowParticipants = kind === "calls" ? list(row.participants).map(phone).filter(p => p !== lineNumber)
          : [row.from, ...list(row.to)].map(phone).filter(p => p !== lineNumber);
        if (rowParticipants.length !== participants.length || rowParticipants.some(p => !p || !participants.includes(p))) { limitations.add("invalid_record_participants"); continue; }
        const timestamp = Date.parse(row.createdAt || "");
        if (!Number.isFinite(timestamp)) { limitations.add("invalid_timestamp"); continue; }
        if (timestamp < Date.parse(window.start) || timestamp > Date.parse(window.end)) continue;
        if (!["incoming", "outgoing"].includes(row.direction)) { limitations.add("invalid_direction"); continue; }
        if (typeof row.status !== "string" || (kind === "calls" && (!Number.isFinite(Number(row.duration ?? 0)) || Number(row.duration ?? 0) < 0))) {
          limitations.add("invalid_record_status"); continue;
        }
        if (kind === "messages" && ((row.text !== undefined && typeof row.text !== "string")
          || (row.content !== undefined && typeof row.content !== "string")
          || (row.text !== undefined && row.content !== undefined && row.text !== row.content))) {
          limitations.add("invalid_message_content"); continue;
        }
        const key = `${kind}:${row.id}`;
        if (byId.has(key)) { limitations.add("duplicate_record"); continue; }
        if (byId.size >= 500) { limitations.add("activity_limit_reached"); break; }
        const status = String(row.status || "");
        const missed = kind === "calls" && row.direction === "incoming"
          && (["missed", "no-answer", "abandoned"].includes(status)
            || (status === "completed" && Number(row.duration || 0) === 0 && !row.answeredAt && !row.answeredBy && !row.aiHandled));
        const text = kind === "messages" ? String(row.text ?? row.content ?? "") : "";
        const attachmentCount = list(row.media).length + list(row.attachments).length;
        if (attachmentCount) limitations.add("message_attachments_not_reviewed");
        if (text.length > 8000) limitations.add("message_body_truncated");
        byId.set(key, { id: row.id, conversationId: conversation.id, channel: "quo", type: kind === "messages" ? "text" : missed ? "missed_call" : "call",
          direction: row.direction, status, participants, lineNumber, atUtc: new Date(timestamp).toISOString(),
          durationSec: kind === "calls" ? Number(row.duration || 0) : undefined, text: text.slice(0, 8000), attachmentCount });
      }
    }
  }
  const items = [...byId.values()].sort((a, b) => b.atUtc.localeCompare(a.atUtc));
  const calls = items.filter(item => item.type !== "text");
  // Newest missed calls first, then answered-call speech. No repeated retries.
  const reviewed = [...calls].sort((a, b) => Number(b.type === "missed_call") - Number(a.type === "missed_call") || b.atUtc.localeCompare(a.atUtc)).slice(0, 25);
  if (calls.length > reviewed.length) limitations.add("speech_review_limit_reached");
  for (const item of reviewed) {
    if (requestCount >= 120 || Date.now() - startedAt > 90000) { limitations.add("provider_read_budget_reached"); break; }
    if (item.direction === "incoming") {
      try {
        const data = (await readJson(`/call-voicemails/${encodeURIComponent(item.id)}`))?.data;
        if (!data || typeof data !== "object" || Array.isArray(data)
          || (data.transcript !== null && data.transcript !== undefined && typeof data.transcript !== "string")) throw new Error("Invalid voicemail.");
        item.voicemailStatus = String(data.status || "unknown");
        if (data.status === "completed" && typeof data.transcript === "string" && data.transcript.trim()) {
          item.type = "voicemail"; item.voicemail = data.transcript.slice(0, 8000);
          if (data.transcript.length > 8000) limitations.add("voicemail_truncated");
        } else if (data.status !== "completed") limitations.add("voicemail_pending_or_unknown");
        else if (data.id || Number(data.duration) > 0) limitations.add("voicemail_transcript_unavailable");
      } catch (error) {
        item.voicemailStatus = Number(error?.statusCode) === 404 ? "not_found" : "unavailable";
        if (Number(error?.statusCode) !== 404) limitations.add("voicemail_unavailable");
      }
    }
    if (item.type === "voicemail") continue;
    if (item.type === "missed_call" && item.voicemailStatus === "not_found") continue;
    try {
      const data = (await readJson(`/call-transcripts/${encodeURIComponent(item.id)}`))?.data;
      if (!data || data.callId !== item.id || data.status !== "completed" || !Array.isArray(data.dialogue)
        || data.dialogue.some(segment => typeof segment?.content !== "string")) throw new Error("Invalid call transcript.");
      const speech = data.dialogue.map(segment => segment.content).join(" ");
      item.transcript = speech.slice(0, 8000); item.transcriptStatus = "reviewed";
      if (speech.length > 8000) limitations.add("transcript_truncated");
    } catch { item.transcriptStatus = "unavailable"; limitations.add("call_transcript_unavailable"); }
  }
  return { items, coverage: { complete: limitations.size === 0, status: limitations.size ? "partial" : "reviewed", lineNumber,
    windowStart: window.start, windowEnd: window.end, conversationsScanned: seenConversations.size, returned: items.length,
    callsFound: calls.length, speechReviewSelected: reviewed.length, requestCount, limitationCodes: [...limitations],
    answeredCallsWithoutTranscriptsAreNotReviewed: true, companyLinesScanned: false } };
}
