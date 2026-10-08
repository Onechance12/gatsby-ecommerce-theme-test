import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Gmail download IDs may rotate between full-message reads. This short-lived,
// boot-local reference binds the immutable MIME location and metadata instead.
// It grants no upload/send authority and never bypasses fresh file correlation.
export function createGmailAttachmentReferences({
  secret = randomBytes(32),
  now = Date.now,
  lifetimeMs = 15 * 60 * 1000
} = {}) {
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");
  const metadata = (attachment) => ({
    partId: String(attachment?.partId || ""),
    partPath: String(attachment?.partPath || ""),
    filename: String(attachment?.filename || ""),
    mimeType: String(attachment?.mimeType || "").trim().toLowerCase(),
    size: attachment?.size
  });
  const validMetadata = (value) => value.partPath && value.filename && value.mimeType
    && Number.isSafeInteger(value.size) && value.size >= 0;
  const fail = () => {
    const error = new Error("The Gmail attachment reference is invalid, expired, or no longer matches this exact file/message/MIME part. Refresh the verified thread; do not guess a filename or retry an old download token.");
    error.statusCode = 403;
    throw error;
  };
  return Object.freeze({
    create(binding, attachment) {
      const selected = metadata(attachment);
      if (!binding?.subject || !binding?.fileId || !binding?.messageId || !validMetadata(selected)) return null;
      const payload = Buffer.from(JSON.stringify({
        v: 1,
        subject: String(binding.subject),
        fileId: String(binding.fileId),
        messageId: String(binding.messageId),
        expiresAt: now() + lifetimeMs,
        selected
      })).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },
    resolve(reference, binding, attachments) {
      if (typeof reference !== "string" || reference.length > 4096) return fail();
      const parts = reference.split(".");
      if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return fail();
      const expected = Buffer.from(sign(parts[0]));
      const actual = Buffer.from(parts[1]);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail();
      let payload;
      try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return fail(); }
      if (payload?.v !== 1 || payload.subject !== binding?.subject || payload.fileId !== binding?.fileId
        || payload.messageId !== binding?.messageId || !Number.isSafeInteger(payload.expiresAt)
        || payload.expiresAt <= now() || !validMetadata(payload.selected || {}) || !Array.isArray(attachments)) return fail();
      const matches = attachments.filter((attachment) => (
        JSON.stringify(metadata(attachment)) === JSON.stringify(payload.selected)
      ));
      if (matches.length !== 1 || !matches[0].attachmentId) return fail();
      return matches[0];
    }
  });
}
