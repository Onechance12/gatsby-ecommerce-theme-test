import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { PDF_MAX_BYTES, pdfHash, validatePdfPayload, exactKeys } from "./pdf-upload-contract.mjs";

export async function readLocalPdf(input) {
  if (!exactKeys(input, ["query", "path", "filename", "isPrivate"])
    || typeof input.path !== "string" || !path.isAbsolute(input.path) || path.extname(input.path).toLowerCase() !== ".pdf"
    || input.path.includes("\0")) throw new Error("Select one absolute local .pdf path, numeric query, filename and explicit privacy.");
  const resolved = await realpath(input.path);
  // No symlink sources (including parent directory links), URLs, pipes, devices
  // or whole-directory reads. Only this selected regular file enters memory.
  if (resolved !== path.normalize(input.path)) throw new Error("PDF source must not traverse a symlink.");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 20 || before.size > PDF_MAX_BYTES) throw new Error("Select a regular PDF no larger than 8 MiB.");
    const bytes = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("PDF changed while being read. Review the final file and plan again.");
    }
    const content = bytes.subarray(0, total);
    const payload = { query: input.query, filename: input.filename, isPrivate: input.isPrivate,
      contentType: "application/pdf", sizeBytes: total, sha256: pdfHash(content), contentBase64: content.toString("base64") };
    validatePdfPayload(payload);
    return payload;
  } finally { await handle.close(); }
}
