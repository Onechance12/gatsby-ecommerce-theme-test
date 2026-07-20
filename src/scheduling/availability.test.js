import assert from "node:assert/strict";
import test from "node:test";

import {
  appointmentFitsAvailability,
  availabilityRange,
  buildUnifiedAvailability,
  busyIntervalsFromJobNimbusTasks
} from "./availability.js";

const OWNER = "chance-owner";
const NOW = new Date("2026-07-15T14:00:00.000Z");

test("availability horizon includes exactly the configured number of calendar dates", () => {
  const range = availabilityRange({ now: NOW, horizonDays: 2 });
  assert.equal(range.firstDate, "2026-07-15");
  assert.equal(range.lastDate, "2026-07-16");
});

test("merges JobNimbus and Google busy time with travel buffers", () => {
  const range = availabilityRange({ now: NOW, horizonDays: 2 });
  const availability = buildUnifiedAvailability({
    now: NOW,
    range,
    durationMinutes: 120,
    bufferMinutes: 60,
    minLeadHours: 0,
    workdayStart: "08:00",
    workdayEnd: "17:00",
    sources: [
      { name: "jobnimbus", status: "ready", busyCount: 1 },
      { name: "google_calendar", status: "ready", busyCount: 1 }
    ],
    jobNimbusBusy: [{ start: "2026-07-16T15:00:00.000Z", end: "2026-07-16T17:00:00.000Z", source: "jobnimbus" }],
    googleBusy: [{ start: "2026-07-16T20:00:00.000Z", end: "2026-07-16T21:00:00.000Z", source: "google_calendar" }]
  });

  assert.equal(availability.status, "READY");
  assert.equal(availability.sources.every((source) => source.status === "ready"), true);
  assert.equal(availability.availableWindows.some((window) => window.label.includes("Central")), true);
  assert.equal(appointmentFitsAvailability(
    availability.availableWindows[0].start,
    new Date(Date.parse(availability.availableWindows[0].start) + 2 * 60 * 60_000).toISOString(),
    availability
  ), true);
});

test("fails closed when either calendar source cannot be checked", () => {
  const range = availabilityRange({ now: NOW, horizonDays: 2 });
  const availability = buildUnifiedAvailability({
    now: NOW,
    range,
    sources: [
      { name: "jobnimbus", status: "ready" },
      { name: "google_calendar", status: "blocked", error: "missing scope" }
    ]
  });
  assert.equal(availability.status, "BLOCKED");
  assert.equal(availability.availableWindows.length, 0);
  assert.match(availability.reason, /google_calendar/);
});

test("uses only active Chance-owned time-specific JobNimbus calendar items", () => {
  const tasks = [
    { jnid: "keep", title: "Adjuster Meeting", date_start: 1784210400, date_end: 1784217600, owners: [{ id: OWNER }], is_completed: false },
    { jnid: "other", title: "Adjuster Meeting", date_start: 1784210400, date_end: 1784217600, owners: [{ id: "other" }], is_completed: false },
    { jnid: "done", title: "Inspection", date_start: 1784210400, date_end: 1784217600, owners: [{ id: OWNER }], is_completed: true },
    { jnid: "reminder", title: "Follow up", date_start: 1784210400, date_end: 0, owners: [{ id: OWNER }], is_completed: false }
  ];
  const busy = busyIntervalsFromJobNimbusTasks(tasks, {
    ownerId: OWNER,
    timeMin: "2026-07-15T00:00:00.000Z",
    timeMax: "2026-07-20T00:00:00.000Z"
  });
  assert.deepEqual(busy.map((row) => row.sourceId), ["keep"]);
});

test("allows Saturdays but never offers Sundays or time after 6 PM Central", () => {
  const now = new Date("2026-07-17T13:00:00.000Z");
  const range = availabilityRange({ now, horizonDays: 3 });
  const availability = buildUnifiedAvailability({
    now,
    range,
    durationMinutes: 120,
    bufferMinutes: 0,
    minLeadHours: 0,
    workdayStart: "08:00",
    workdayEnd: "18:00",
    sources: [
      { name: "jobnimbus", status: "ready" },
      { name: "google_calendar", status: "ready" }
    ]
  });

  assert.equal(availability.availableWindows.some((window) => window.start.startsWith("2026-07-18")), true);
  assert.equal(availability.availableWindows.some((window) => window.start.startsWith("2026-07-19")), false);
  assert.equal(availability.availableWindows.every((window) => new Date(window.end).getUTCHours() <= 23), true);
});
