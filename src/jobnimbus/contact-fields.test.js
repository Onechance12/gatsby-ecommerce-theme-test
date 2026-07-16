import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeContactFieldAliases } from "./contact-fields.js";

test("maps friendly date-of-loss names to the JobNimbus custom date field", () => {
  for (const key of ["dateOfLoss", "Date of Loss", "DOL"]) {
    assert.deepEqual(canonicalizeContactFieldAliases({ [key]: "2026-04-26" }), {
      cf_date_1: "2026-04-26"
    });
  }
});

test("preserves an explicit JobNimbus field over a friendly alias", () => {
  assert.deepEqual(canonicalizeContactFieldAliases({
    dateOfLoss: "2026-04-25",
    cf_date_1: "2026-04-26"
  }), {
    cf_date_1: "2026-04-26"
  });
});

test("leaves unrelated JobNimbus fields unchanged", () => {
  assert.deepEqual(canonicalizeContactFieldAliases({ cf_string_2: "ABC123" }), {
    cf_string_2: "ABC123"
  });
});
