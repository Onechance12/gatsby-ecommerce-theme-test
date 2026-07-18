import PDFDocument from "pdfkit";

const PHOTO_EXTENSION = /\.(?:jpe?g|png|webp|heic|tiff?)$/i;
const MEASUREMENT_HINT = /\b(?:measure(?:ment)?s?|dimension(?:s)?|magic\s*plan|room|length|width|height|screenshot)\b/i;

export function isPhotoMetadata(document) {
  const name = photoName(document);
  const contentType = String(document?.content_type || document?.contentType || document?.mime_type || "").toLowerCase();
  const type = String(document?.record_type_name || document?.type || "").toLowerCase();
  return contentType.startsWith("image/") || PHOTO_EXTENSION.test(name) || type === "photo";
}

export function buildPhotoCandidateCatalog(documents, { limit = 12 } = {}) {
  const photos = documents.filter(isPhotoMetadata);
  const groups = new Map();

  for (const document of photos) {
    const name = photoName(document) || `unnamed-${photoId(document)}`;
    const rows = groups.get(name) || [];
    rows.push(compactPhoto(document));
    groups.set(name, rows);
  }

  const batches = [...groups.entries()].map(([batchKey, items]) => ({
    batchKey,
    count: items.length,
    likelyMeasurementBatch: MEASUREMENT_HINT.test(batchKey) || items.length > 1,
    reason: MEASUREMENT_HINT.test(batchKey)
      ? "filename_contains_measurement_hint"
      : (items.length > 1 ? "multiple_images_uploaded_as_one_batch" : "recent_photo"),
    photos: items
  })).sort((a, b) => {
    if (a.likelyMeasurementBatch !== b.likelyMeasurementBatch) return a.likelyMeasurementBatch ? -1 : 1;
    return b.batchKey.localeCompare(a.batchKey);
  });

  const selected = batches.slice(0, Math.max(1, Math.min(Number(limit) || 12, 25)));
  return {
    photoCount: photos.length,
    batchCount: batches.length,
    candidateBatches: selected,
    omittedBatchCount: Math.max(0, batches.length - selected.length),
    instruction: "Start with batches marked likelyMeasurementBatch. Ordinary inspection photos remain excluded from the operational document list. Use attach_batch with one exact batchKey or up to six exact photoIds to inspect images."
  };
}

export async function createPhotoReviewPdf(images, { title = "JobNimbus photo review" } = {}) {
  const doc = new PDFDocument({ autoFirstPage: false, compress: true, info: { Title: title } });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let rendered = 0;
  for (const image of images) {
    try {
      const opened = doc.openImage(image.bytes);
      doc.addPage({ size: "LETTER", layout: "landscape", margin: 24 });
      doc.font("Helvetica-Bold").fontSize(10).text(image.label || `Photo ${rendered + 1}`, 24, 18, {
        width: 744,
        height: 20,
        ellipsis: true
      });
      doc.image(opened, 24, 44, { fit: [744, 520], align: "center", valign: "center" });
      rendered += 1;
    } catch {
      // Skip unsupported or corrupt image bytes; the caller reports omitted ids.
    }
  }

  if (!rendered) {
    doc.end();
    await completed;
    throw new Error("None of the selected JobNimbus photos could be rendered as JPEG or PNG pages.");
  }

  doc.end();
  return { bytes: await completed, rendered };
}

function compactPhoto(document) {
  return {
    id: photoId(document),
    name: photoName(document),
    contentType: String(document?.content_type || document?.contentType || document?.mime_type || ""),
    type: String(document?.record_type_name || document?.type || "")
  };
}

function photoId(document) {
  return String(document?.jnid || document?.id || "");
}

function photoName(document) {
  return String(document?.name || document?.filename || document?.file_name || "");
}
