import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createLorPdf } from "./lor.js";

const FIELDS = Object.freeze({
  insured: "Fixture Homeowner",
  carrier: "State Farm",
  addressLine1: "3431 Manana Dr",
  addressLine2: "Dallas, TX 75220",
  dateOfLoss: "04/25/2026",
  claimNumber: "43-0H7K-093",
  letterDate: "09/01/2026"
});

test("generated LOR bytes stay identical across wall-clock time", async () => {
  const first = await createLorPdf(FIELDS);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = await createLorPdf(FIELDS);

  assert.equal(first.equals(second), true);
  assert.equal(
    createHash("sha256").update(first).digest("hex"),
    createHash("sha256").update(second).digest("hex")
  );
});

test("generated LOR rejects an invalid metadata date", async () => {
  await assert.rejects(
    createLorPdf({ ...FIELDS, letterDate: "02/30/2026" }),
    /valid calendar date/i
  );
});
