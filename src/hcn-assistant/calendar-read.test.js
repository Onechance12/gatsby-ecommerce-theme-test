import assert from "node:assert/strict";
import test from "node:test";

import {
  HcnCalendarReadError,
  readGoogleCalendarDayAvailability,
  readGoogleCalendarFileAppointments
} from "./calendar-read.js";

const ACCESS_TOKEN = "calendar-access-token-fixture-123456789";
const FILE_REF = `subject_${"a".repeat(32)}`;

test("reads one local day through Google freeBusy and returns only minimized intervals", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(200, {
      kind: "calendar#freeBusy",
      calendars: {
        primary: {
          busy: [
            {
              start: "2026-08-03T17:00:00Z",
              end: "2026-08-03T18:00:00Z",
              summary: "Private client meeting",
              attendees: [{ email: "private@example.com" }],
              id: "provider-event-id"
            },
            {
              start: "2026-08-03T14:00:00-05:00",
              end: "2026-08-03T15:30:00-05:00"
            }
          ]
        }
      }
    });
  };

  const result = await readGoogleCalendarDayAvailability({
    fetchImpl,
    accessToken: ACCESS_TOKEN,
    date: "2026-08-03",
    timeZone: "America/Chicago",
    calendarId: "primary",
    fileRef: FILE_REF,
    now: () => new Date("2026-08-03T12:00:00.000Z")
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://www.googleapis.com/calendar/v3/freeBusy"
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(
    requests[0].options.headers.authorization,
    `Bearer ${ACCESS_TOKEN}`
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    timeMin: "2026-08-03T05:00:00.000Z",
    timeMax: "2026-08-04T05:00:00.000Z",
    timeZone: "America/Chicago",
    items: [{ id: "primary" }]
  });

  assert.deepEqual(result, {
    schema: "hcn.assistant.calendar-availability.v1",
    generatedAt: "2026-08-03T12:00:00.000Z",
    ephemeral: true,
    cachePolicy: "no_store",
    authority: {
      mode: "read_only",
      employeeConnectorRequired: true,
      canWrite: false,
      canInvite: false,
      canExposeEventDetails: false
    },
    request: {
      date: "2026-08-03",
      timeZone: "America/Chicago",
      fileRef: FILE_REF
    },
    source: {
      source: "google_calendar",
      status: "fresh",
      completeness: "complete",
      checkedAt: "2026-08-03T12:00:00.000Z"
    },
    availability: {
      busy: true,
      busyCount: 2,
      intervals: [
        {
          start: "2026-08-03T17:00:00.000Z",
          end: "2026-08-03T18:00:00.000Z"
        },
        {
          start: "2026-08-03T19:00:00.000Z",
          end: "2026-08-03T20:30:00.000Z"
        }
      ]
    }
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /calendar-access-token|Private client|private@example|provider-event-id/
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.availability.intervals), true);
});

test("uses exact local-day boundaries across daylight-saving changes", async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return jsonResponse(200, {
      calendars: { primary: { busy: [] } }
    });
  };

  await readGoogleCalendarDayAvailability({
    fetchImpl,
    accessToken: ACCESS_TOKEN,
    date: "2026-03-08",
    timeZone: "America/Chicago"
  });
  await readGoogleCalendarDayAvailability({
    fetchImpl,
    accessToken: ACCESS_TOKEN,
    date: "2026-11-01",
    timeZone: "America/Chicago"
  });

  assert.deepEqual(
    [bodies[0].timeMin, bodies[0].timeMax],
    ["2026-03-08T06:00:00.000Z", "2026-03-09T05:00:00.000Z"]
  );
  assert.deepEqual(
    [bodies[1].timeMin, bodies[1].timeMax],
    ["2026-11-01T05:00:00.000Z", "2026-11-02T06:00:00.000Z"]
  );
});

test("fails closed for malformed requests before a provider call", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, {
      calendars: { primary: { busy: [] } }
    });
  };
  const invalid = [
    { date: "2026-02-30", timeZone: "America/Chicago" },
    { date: "08/03/2026", timeZone: "America/Chicago" },
    { date: "2026-08-03", timeZone: "Not/A_Time_Zone" },
    {
      date: "2026-08-03",
      timeZone: "America/Chicago",
      fileRef: "raw-provider-id"
    }
  ];
  for (const input of invalid) {
    await assert.rejects(
      readGoogleCalendarDayAvailability({
        fetchImpl,
        accessToken: ACCESS_TOKEN,
        ...input
      }),
      (error) =>
        error instanceof HcnCalendarReadError
        && error.statusCode === 400
    );
  }
  assert.equal(calls, 0);
});

test("fails closed on missing employee credential or incomplete provider results", async () => {
  await assert.rejects(
    readGoogleCalendarDayAvailability({
      fetchImpl: async () => jsonResponse(200, {}),
      accessToken: "",
      date: "2026-08-03",
      timeZone: "America/Chicago"
    }),
    (error) =>
      error instanceof HcnCalendarReadError
      && error.code === "calendar_read_unavailable"
      && error.statusCode === 503
  );

  await assert.rejects(
    readGoogleCalendarDayAvailability({
      fetchImpl: async () => jsonResponse(200, {
        calendars: {
          primary: {
            errors: [{ reason: "forbidden", private: "not returned" }],
            busy: []
          }
        }
      }),
      accessToken: ACCESS_TOKEN,
      date: "2026-08-03",
      timeZone: "America/Chicago"
    }),
    (error) =>
      error instanceof HcnCalendarReadError
      && error.message ===
        "Google Calendar returned an incomplete availability result."
  );
});

test("rejects provider intervals outside the exact requested day", async () => {
  await assert.rejects(
    readGoogleCalendarDayAvailability({
      fetchImpl: async () => jsonResponse(200, {
        calendars: {
          primary: {
            busy: [{
              start: "2026-08-04T05:00:00Z",
              end: "2026-08-04T06:00:00Z"
            }]
          }
        }
      }),
      accessToken: ACCESS_TOKEN,
      date: "2026-08-03",
      timeZone: "America/Chicago"
    }),
    (error) =>
      error instanceof HcnCalendarReadError
      && error.code === "calendar_read_unavailable"
  );
});

test("correlates an exact file appointment without returning event text or contacts", async () => {
  let request;
  const result = await readGoogleCalendarFileAppointments({
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return jsonResponse(200, {
        items: [
          {
            status: "confirmed",
            start: { dateTime: "2026-08-03T13:00:00-05:00" },
            end: { dateTime: "2026-08-03T14:00:00-05:00" },
            summary: "Adjuster inspection - Client Fixture",
            location: "101 Exact Match Lane, Dallas TX 75001",
            description:
              "Claim ABC-98765. Homeowner private@example.com, 214-555-0199.",
            attendees: [{ email: "should-not-have-been-requested@example.com" }],
            id: "provider-event-id"
          },
          {
            status: "confirmed",
            start: { dateTime: "2026-08-03T15:00:00-05:00" },
            end: { dateTime: "2026-08-03T16:00:00-05:00" },
            summary: "Unrelated private meeting",
            description: "No file identifiers."
          }
        ]
      });
    },
    accessToken: ACCESS_TOKEN,
    date: "2026-08-03",
    timeZone: "America/Chicago",
    calendarId: "primary",
    fileRef: FILE_REF,
    matchTerms: [
      { kind: "property_address", value: "101 Exact Match Lane Dallas TX 75001" },
      { kind: "claim_number", value: "ABC-98765" },
      { kind: "email", value: "private@example.com" },
      { kind: "phone", value: "214-555-0199" },
      { kind: "client_name", value: "Client Fixture" },
      { kind: "job_number", value: "2739" }
    ],
    now: () => new Date("2026-08-03T12:00:00.000Z")
  });

  assert.equal(
    request.url.origin + request.url.pathname,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events"
  );
  assert.equal(request.options.method, "GET");
  assert.equal(request.url.searchParams.get("maxResults"), "100");
  assert.equal(request.url.searchParams.get("singleEvents"), "true");
  assert.equal(
    request.url.searchParams.get("fields"),
    "nextPageToken,items(status,start,end,summary,location,description)"
  );
  assert.doesNotMatch(
    request.url.searchParams.get("fields"),
    /attendee|organizer|creator|conference|attachment|reminder|id/i
  );
  assert.equal(result.appointmentCount, 1);
  assert.deepEqual(result.appointments, [{
    start: "2026-08-03T18:00:00.000Z",
    end: "2026-08-03T19:00:00.000Z",
    allDay: false,
    appointmentKind: "adjuster_inspection",
    matchBasis: [
      "claim_number",
      "client_name",
      "email",
      "phone",
      "property_address"
    ]
  }]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /Exact Match Lane|ABC-98765|private@example|214|provider-event|Unrelated/
  );
});

test("does not correlate a calendar event from a client name or job number alone", async () => {
  const result = await readGoogleCalendarFileAppointments({
    fetchImpl: async () => jsonResponse(200, {
      items: [{
        status: "confirmed",
        start: { dateTime: "2026-08-03T13:00:00-05:00" },
        end: { dateTime: "2026-08-03T14:00:00-05:00" },
        summary: "Inspection for Client Fixture"
      }, {
        status: "confirmed",
        start: { dateTime: "2026-08-03T14:00:00-05:00" },
        end: { dateTime: "2026-08-03T15:00:00-05:00" },
        summary: "File 2739 follow-up"
      }]
    }),
    accessToken: ACCESS_TOKEN,
    date: "2026-08-03",
    timeZone: "America/Chicago",
    fileRef: FILE_REF,
    matchTerms: [
      { kind: "client_name", value: "Client Fixture" },
      { kind: "job_number", value: "2739" }
    ]
  });

  assert.equal(result.appointmentCount, 0);
  assert.deepEqual(result.appointments, []);
});

test("accepts exact name plus job number together and fails closed on truncated results", async () => {
  const input = {
    accessToken: ACCESS_TOKEN,
    date: "2026-08-03",
    timeZone: "America/Chicago",
    fileRef: FILE_REF,
    matchTerms: [
      { kind: "client_name", value: "Client Fixture" },
      { kind: "job_number", value: "2739" }
    ]
  };
  const result = await readGoogleCalendarFileAppointments({
    ...input,
    fetchImpl: async () => jsonResponse(200, {
      items: [{
        status: "confirmed",
        start: { dateTime: "2026-08-03T13:00:00-05:00" },
        end: { dateTime: "2026-08-03T14:00:00-05:00" },
        summary: "Client Fixture inspection - file 2739"
      }]
    })
  });
  assert.equal(result.appointmentCount, 1);
  assert.deepEqual(
    result.appointments[0].matchBasis,
    ["client_name", "job_number"]
  );

  await assert.rejects(
    readGoogleCalendarFileAppointments({
      ...input,
      fetchImpl: async () => jsonResponse(200, {
        nextPageToken: "more-private-events",
        items: []
      })
    }),
    (error) =>
      error instanceof HcnCalendarReadError
      && error.message ===
        "Google Calendar returned an incomplete appointment result."
  );
});

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
