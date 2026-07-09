// Operational file records worth syncing as documents: PDFs, ESX/ZIP estimate
// files, and office-style document content types. Photos are counted, not stored.
export const OPERATIONAL_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/rtf",
  "text/csv",
  "text/plain"
];

export const PHOTO_CONTENT_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/bmp"
];

const OPERATIONAL_EXTENSIONS = /\.(pdf|esx|zip|doc|docx|xls|xlsx|csv|rtf|txt)$/i;
const PHOTO_EXTENSIONS = /\.(jpe?g|png|heic|heif|gif|webp|tiff?|bmp)$/i;

export function isOperationalDocument(document) {
  if (!document || typeof document !== "object") return false;
  const contentType = String(document.content_type || document.contentType || document.type || "").toLowerCase();
  const filename = String(document.filename || document.name || document.title || "");

  if (PHOTO_CONTENT_TYPES.includes(contentType)) return false;
  if (PHOTO_EXTENSIONS.test(filename)) return false;
  if (OPERATIONAL_DOCUMENT_CONTENT_TYPES.includes(contentType)) return true;
  return OPERATIONAL_EXTENSIONS.test(filename);
}

export function documentFilterSummary(documents) {
  const byContentType = {};
  let operational = 0;
  let photos = 0;

  for (const document of documents || []) {
    const contentType = String(document?.content_type || document?.contentType || document?.type || "unknown").toLowerCase();
    byContentType[contentType] = (byContentType[contentType] || 0) + 1;
    if (isOperationalDocument(document)) operational += 1;
    if (PHOTO_CONTENT_TYPES.includes(contentType)) photos += 1;
  }

  return {
    total: (documents || []).length,
    operational,
    photos,
    byContentType
  };
}
