import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildPhotoCandidateCatalog, createPhotoReviewPdf, isPhotoMetadata } from "./photo-review.js";

test("photo catalog prioritizes a repeated camera-roll upload batch", () => {
  const documents = [
    { jnid: "photo-1", filename: "2026-07-18 17:55:46Z.jpeg", content_type: "image/jpeg", record_type_name: "Photo" },
    { jnid: "photo-2", filename: "2026-07-18 17:55:46Z.jpeg", content_type: "image/jpeg", record_type_name: "Photo" },
    { jnid: "photo-3", filename: "2026-07-18 17:53:07Z.jpg", content_type: "image/jpeg", record_type_name: "Photo" },
    { jnid: "document-1", filename: "Policy.pdf", content_type: "application/pdf", record_type_name: "Document" }
  ];

  assert.equal(isPhotoMetadata(documents[0]), true);
  assert.equal(isPhotoMetadata(documents[3]), false);
  const catalog = buildPhotoCandidateCatalog(documents);
  assert.equal(catalog.photoCount, 3);
  assert.equal(catalog.candidateBatches[0].batchKey, "2026-07-18 17:55:46Z.jpeg");
  assert.equal(catalog.candidateBatches[0].count, 2);
  assert.equal(catalog.candidateBatches[0].likelyMeasurementBatch, true);
});

test("selected photos render as a bounded PDF", async () => {
  const fixtureJpeg = await readFile(new URL("../../node_modules/jpeg-exif/test/IMG_0001.JPG", import.meta.url));
  const rendered = await createPhotoReviewPdf([
    { bytes: fixtureJpeg, label: "photo-1: measurement.jpg" },
    { bytes: fixtureJpeg, label: "photo-2: measurement.jpg" }
  ]);
  assert.equal(rendered.rendered, 2);
  assert.equal(rendered.bytes.subarray(0, 4).toString("ascii"), "%PDF");
});
