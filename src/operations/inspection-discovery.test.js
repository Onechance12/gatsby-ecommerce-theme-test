import test from "node:test";
import assert from "node:assert/strict";

import { localDateKey, selectTodaysInspectionTasks } from "./inspection-discovery.js";

const NOW = new Date("2026-07-18T15:00:00-05:00");

test("selects active inspection tasks due today and orders them by time", () => {
  const rows = [
    { contact: { number: "2758" }, task: { title: "Estimate Inspection", date_start: Date.parse("2026-07-18T15:00:00-05:00") / 1000 } },
    { contact: { number: "2776" }, task: { title: "Estimate Inspection", date_start: Date.parse("2026-07-18T12:00:00-05:00") / 1000 } },
    { contact: { number: "old" }, task: { title: "Estimate Inspection", date_start: Date.parse("2026-07-17T12:00:00-05:00") / 1000 } },
    { contact: { number: "done" }, task: { title: "Carrier inspection", date_start: Date.parse("2026-07-18T10:00:00-05:00") / 1000, is_completed: true } },
    { contact: { number: "other" }, task: { title: "Call homeowner", date_start: Date.parse("2026-07-18T09:00:00-05:00") / 1000 } }
  ];

  assert.deepEqual(
    selectTodaysInspectionTasks(rows, { now: NOW }).map((row) => row.contact.number),
    ["2776", "2758"]
  );
});

test("local date matching honors America/Chicago rather than UTC", () => {
  assert.equal(localDateKey("2026-07-19T02:00:00Z"), "2026-07-18");
});
