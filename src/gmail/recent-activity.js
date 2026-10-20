// Own-mailbox discovery only. readJson is the existing bounded GET transport;
// callers cannot supply a mailbox, query, arbitrary URL, or provider message ID.
export async function readRecentGmailActivity({ readJson, compact, mailbox, window }) {
  const profile = await readJson("/gmail/v1/users/me/profile");
  if (!mailbox || String(profile?.emailAddress || "").toLowerCase() !== mailbox.toLowerCase()) throw new Error("Gmail sweep mailbox binding failed.");
  const query = `after:${Math.floor(Date.parse(window.start) / 1000)} before:${Math.ceil(Date.parse(window.end) / 1000) + 1} -in:spam -in:trash`;
  const items = [];
  const seen = new Set();
  const tokens = new Set();
  const limitations = new Set();
  let pageToken = "", pagesRead = 0, scanned = 0, hasMore = false;
  const readLimit = 100, startedAt = Date.now();
  do {
    if (tokens.has(pageToken)) { limitations.add("repeated_page_token"); break; }
    tokens.add(pageToken);
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(25, readLimit - scanned)), includeSpamTrash: "false" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await readJson(`/gmail/v1/users/me/messages?${params}`);
    pagesRead += 1;
    if (!page || typeof page !== "object" || Array.isArray(page)
      || (page.messages !== undefined && !Array.isArray(page.messages)) || (page.messages || []).length > 25) throw new Error("Gmail sweep page failed verification.");
    for (const row of page.messages || []) {
      if (Date.now() - startedAt > 90000) { limitations.add("provider_read_budget_reached"); break; }
      if (!row?.id || !/^[a-zA-Z0-9_-]{1,512}$/.test(row.id) || seen.has(row.id)) { limitations.add("invalid_or_duplicate_message"); continue; }
      seen.add(row.id); scanned += 1;
      let message;
      try { message = await readJson(`/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?format=full`); }
      catch { limitations.add("message_unavailable"); continue; }
      if (message?.id !== row.id || !message.threadId || (row.threadId && row.threadId !== message.threadId)) { limitations.add("message_identity_mismatch"); continue; }
      const stamp = Number(message.internalDate);
      if (!Number.isFinite(stamp)) { limitations.add("invalid_timestamp"); continue; }
      if (stamp < Date.parse(window.start) || stamp > Date.parse(window.end)) continue;
      const body = compact(message, true);
      if (message.labelIds !== undefined && (!Array.isArray(message.labelIds) || message.labelIds.some(label => typeof label !== "string"))) { limitations.add("invalid_message_labels"); continue; }
      const labels = message.labelIds || [];
      const direction = labels.includes("DRAFT") ? "draft" : labels.includes("SENT") ? "outgoing" : "incoming";
      const headers = message.payload?.headers || [];
      const automatic = headers.some(h => String(h.name).toLowerCase() === "auto-submitted" && !/^no$/i.test(String(h.value || "").trim()))
        || /^(?:automatic reply|auto(?:matic)?[- ]response|out of office)\s*:/i.test(body.subject || "");
      const deliveryFailure = /\b(?:undeliverable|delivery (?:status notification.*failure|failure|failed)|mail delivery failed|returned mail|failure notice)\b/i.test(body.subject || "")
        || headers.some(h => String(h.name).toLowerCase() === "x-failed-recipients");
      const original = String(body.plainText || body.htmlText || body.snippet || "");
      if (original.length > 8000 || body.bodyTruncated) limitations.add("message_body_truncated");
      const header = (value, limit = 1000) => {
        const text = String(value || "");
        if (text.length > limit) limitations.add("message_metadata_truncated");
        return text.slice(0, limit);
      };
      items.push({ id: message.id, conversationId: message.threadId, channel: "gmail", type: "email", direction,
        atUtc: new Date(stamp).toISOString(), from: header(body.from), to: header(body.to), subject: header(body.subject),
        text: original.slice(0, 8000), automaticReply: direction === "incoming" && (automatic || deliveryFailure),
        deliveryFailure: direction === "incoming" && deliveryFailure,
        labelIds: labels.slice(0, 100), attachmentNames: (body.attachments || []).slice(0, 25).map(a => header(a.filename, 160)) });
    }
    if (page.nextPageToken !== undefined && typeof page.nextPageToken !== "string") { limitations.add("invalid_page_token"); break; }
    pageToken = page.nextPageToken || "";
    if (pageToken.length > 2048) { limitations.add("invalid_page_token"); break; }
    hasMore = Boolean(pageToken);
  } while (hasMore && scanned < readLimit && pagesRead < 5 && Date.now() - startedAt <= 90000);
  if (hasMore) limitations.add("search_limit_reached");
  items.sort((a, b) => b.atUtc.localeCompare(a.atUtc));
  return { items, coverage: { complete: limitations.size === 0, status: limitations.size ? "partial" : "reviewed", mailbox,
    windowStart: window.start, windowEnd: window.end, pagesRead, scanned, returned: items.length, hasMore,
    limitationCodes: [...limitations], historicalThreadContext: "window_only_not_entire_thread", attachmentBodiesReviewed: false, spamTrashExcluded: true } };
}
