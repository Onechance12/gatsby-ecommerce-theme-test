import { fetchBoundedProviderJson } from "../auth/google-provider-http.js";

const GOOGLE_CALENDAR_FREE_BUSY_URL =
  "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_CALENDAR_API_ORIGIN =
  "https://www.googleapis.com/calendar/v3";
const FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_CALENDAR_ID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,256}$/;
const SAFE_TOKEN_PATTERN = /^[\x21-\x7e]{20,16384}$/;
const MAX_BUSY_INTERVALS = 192;
const MAX_PROVIDER_BYTES = 128 * 1024;
const MAX_DAILY_EVENTS = 100;
const MAX_EVENT_MATCH_TEXT_BYTES = 32 * 1024;
const MATCH_TERM_KINDS = new Set([
  "property_address",
  "claim_number",
  "email",
  "phone",
  "client_name",
  "job_number"
]);

/**
 * Read one signed-in employee's Google Calendar free/busy intervals for one
 * local calendar day. This adapter intentionally calls freeBusy rather than
 * events.list: titles, descriptions, locations, attendees, organizer details,
 * event ids, and conference links never enter the response.
 *
 * Credential lookup and employee/file authorization remain server concerns.
 * The caller must inject the already authorized employee access token and, if
 * supplied, must reauthorize `fileRef` against that employee before calling.
 */
export async function readGoogleCalendarDayAvailability({
  fetchImpl,
  accessToken,
  date,
  timeZone,
  calendarId = "primary",
  fileRef = "",
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== "function") {
    invalidConfiguration("fetchImpl must be a function");
  }
  if (
    typeof accessToken !== "string"
    || !SAFE_TOKEN_PATTERN.test(accessToken)
  ) {
    unavailable("The employee Google Calendar connection is unavailable.");
  }
  const normalizedDate = calendarDate(date);
  const normalizedTimeZone = ianaTimeZone(timeZone);
  const normalizedCalendarId = calendarIdValue(calendarId);
  const normalizedFileRef = optionalFileRef(fileRef);
  const range = utcDayRange(normalizedDate, normalizedTimeZone);
  const generatedAt = nowInstant(now);

  let providerResult;
  try {
    providerResult = await fetchBoundedProviderJson(
      fetchImpl,
      GOOGLE_CALENDAR_FREE_BUSY_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          timeMin: range.timeMin,
          timeMax: range.timeMax,
          timeZone: normalizedTimeZone,
          items: [{ id: normalizedCalendarId }]
        })
      },
      {
        timeoutMs: 10_000,
        maxBytes: MAX_PROVIDER_BYTES
      }
    );
  } catch {
    unavailable("Google Calendar availability could not be read.");
  }

  if (providerResult.response.ok !== true) {
    unavailable("Google Calendar availability could not be read.");
  }
  const calendar = providerCalendar(
    providerResult.payload,
    normalizedCalendarId
  );
  const intervals = normalizeBusyIntervals(calendar.busy, range);

  return deepFreeze({
    schema: "hcn.assistant.calendar-availability.v1",
    generatedAt,
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
      date: normalizedDate,
      timeZone: normalizedTimeZone,
      fileRef: normalizedFileRef || null
    },
    source: {
      source: "google_calendar",
      status: "fresh",
      completeness: "complete",
      checkedAt: generatedAt
    },
    availability: {
      busy: intervals.length > 0,
      busyCount: intervals.length,
      intervals
    }
  });
}

/**
 * Find calendar appointments for one already-authorized exact HCN file on one
 * local day. The server must resolve and reauthorize `fileRef`, then provide
 * current matching terms from that exact JobNimbus file. This function reads
 * only event status/time plus text used for matching; it never requests
 * attendees, organizer/creator data, contact fields, ids, conferencing,
 * attachments, or reminders, and it never returns the matching text.
 *
 * A name or job number alone is intentionally insufficient. An appointment is
 * correlated only by a strong exact identifier (address, claim number, email,
 * or phone), or by both the exact client name and exact job number.
 */
export async function readGoogleCalendarFileAppointments({
  fetchImpl,
  accessToken,
  date,
  timeZone,
  calendarId = "primary",
  fileRef,
  matchTerms,
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== "function") {
    invalidConfiguration("fetchImpl must be a function");
  }
  if (
    typeof accessToken !== "string"
    || !SAFE_TOKEN_PATTERN.test(accessToken)
  ) {
    unavailable("The employee Google Calendar connection is unavailable.");
  }
  const normalizedDate = calendarDate(date);
  const normalizedTimeZone = ianaTimeZone(timeZone);
  const normalizedCalendarId = calendarIdValue(calendarId);
  const normalizedFileRef = requiredFileRef(fileRef);
  const normalizedTerms = fileMatchTerms(matchTerms);
  const range = utcDayRange(normalizedDate, normalizedTimeZone);
  const generatedAt = nowInstant(now);
  const url = new URL(
    `${GOOGLE_CALENDAR_API_ORIGIN}/calendars/`
      + `${encodeURIComponent(normalizedCalendarId)}/events`
  );
  url.searchParams.set("timeMin", range.timeMin);
  url.searchParams.set("timeMax", range.timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", String(MAX_DAILY_EVENTS));
  url.searchParams.set(
    "fields",
    "nextPageToken,items(status,start,end,summary,location,description)"
  );

  let providerResult;
  try {
    providerResult = await fetchBoundedProviderJson(
      fetchImpl,
      url.toString(),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json"
        }
      },
      {
        timeoutMs: 10_000,
        maxBytes: MAX_PROVIDER_BYTES
      }
    );
  } catch {
    unavailable("Google Calendar appointments could not be read.");
  }
  if (providerResult.response.ok !== true) {
    unavailable("Google Calendar appointments could not be read.");
  }
  const payload = providerResult.payload;
  if (
    !isPlainObject(payload)
    || (payload.nextPageToken !== undefined && payload.nextPageToken !== null)
    || !Array.isArray(payload.items)
    || payload.items.length > MAX_DAILY_EVENTS
  ) {
    unavailable("Google Calendar returned an incomplete appointment result.");
  }

  const appointments = payload.items
    .map((event) => matchedAppointment(event, normalizedTerms, range))
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.start.localeCompare(right.start)
        || left.end.localeCompare(right.end)
        || left.appointmentKind.localeCompare(right.appointmentKind)
    );

  return deepFreeze({
    schema: "hcn.assistant.calendar-file-appointments.v1",
    generatedAt,
    ephemeral: true,
    cachePolicy: "no_store",
    authority: {
      mode: "read_only",
      employeeConnectorRequired: true,
      exactAssignedFileRequired: true,
      canWrite: false,
      canInvite: false,
      canExposeEventDetails: false
    },
    request: {
      date: normalizedDate,
      timeZone: normalizedTimeZone,
      fileRef: normalizedFileRef
    },
    source: {
      source: "google_calendar",
      status: "fresh",
      completeness: "complete",
      checkedAt: generatedAt
    },
    matchPolicy:
      "strong_exact_identifier_or_exact_name_plus_job_number",
    appointmentCount: appointments.length,
    appointments
  });
}

export class HcnCalendarReadError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = "HcnCalendarReadError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function providerCalendar(payload, calendarId) {
  if (
    !isPlainObject(payload)
    || !isPlainObject(payload.calendars)
    || !isPlainObject(payload.calendars[calendarId])
  ) {
    unavailable("Google Calendar returned an incomplete availability result.");
  }
  const calendar = payload.calendars[calendarId];
  if (
    (Array.isArray(calendar.errors) && calendar.errors.length > 0)
    || !Array.isArray(calendar.busy)
    || calendar.busy.length > MAX_BUSY_INTERVALS
  ) {
    unavailable("Google Calendar returned an incomplete availability result.");
  }
  return calendar;
}

function normalizeBusyIntervals(values, range) {
  const intervals = [];
  const seen = new Set();
  const rangeStart = Date.parse(range.timeMin);
  const rangeEnd = Date.parse(range.timeMax);
  for (const value of values) {
    if (
      !isPlainObject(value)
      || typeof value.start !== "string"
      || typeof value.end !== "string"
      || !RFC3339_INSTANT_PATTERN.test(value.start)
      || !RFC3339_INSTANT_PATTERN.test(value.end)
    ) {
      unavailable("Google Calendar returned an invalid availability interval.");
    }
    const startMs = Date.parse(value.start);
    const endMs = Date.parse(value.end);
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || startMs >= endMs
      || startMs < rangeStart
      || endMs > rangeEnd
    ) {
      unavailable("Google Calendar returned an invalid availability interval.");
    }
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const key = `${start}\0${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    intervals.push({ start, end });
  }
  intervals.sort(
    (left, right) =>
      left.start.localeCompare(right.start)
      || left.end.localeCompare(right.end)
  );
  return intervals;
}

function matchedAppointment(event, terms, range) {
  if (!isPlainObject(event) || event.status === "cancelled") return null;
  if (
    event.status !== undefined
    && !["confirmed", "tentative"].includes(event.status)
  ) {
    unavailable("Google Calendar returned an invalid appointment state.");
  }
  const textFields = ["summary", "location", "description"];
  const text = [];
  let totalBytes = 0;
  for (const field of textFields) {
    const value = event[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      unavailable("Google Calendar returned invalid appointment metadata.");
    }
    totalBytes += Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_EVENT_MATCH_TEXT_BYTES) {
      unavailable("Google Calendar returned oversized appointment metadata.");
    }
    text.push(value);
  }
  const rawText = text.join("\n");
  const normalizedText = normalizeMatchText(rawText);
  const digits = rawText.replace(/\D/g, "");
  const matchedKinds = [];
  for (const term of terms) {
    const matched = term.kind === "phone"
      ? digits.includes(term.normalized)
      : exactNormalizedMatch(normalizedText, term.normalized);
    if (matched) matchedKinds.push(term.kind);
  }
  const uniqueKinds = [...new Set(matchedKinds)].sort();
  const strongMatch = uniqueKinds.some((kind) =>
    ["property_address", "claim_number", "email", "phone"].includes(kind)
  );
  const pairedWeakMatch =
    uniqueKinds.includes("client_name")
    && uniqueKinds.includes("job_number");
  if (!strongMatch && !pairedWeakMatch) return null;

  const timing = eventTiming(event, range);
  return {
    start: timing.start,
    end: timing.end,
    allDay: timing.allDay,
    appointmentKind: appointmentKind(normalizedText),
    matchBasis: uniqueKinds
  };
}

function eventTiming(event, range) {
  if (!isPlainObject(event.start) || !isPlainObject(event.end)) {
    unavailable("Google Calendar returned invalid appointment timing.");
  }
  const dateTimeStart = event.start.dateTime;
  const dateTimeEnd = event.end.dateTime;
  if (dateTimeStart !== undefined || dateTimeEnd !== undefined) {
    if (
      typeof dateTimeStart !== "string"
      || typeof dateTimeEnd !== "string"
      || !RFC3339_INSTANT_PATTERN.test(dateTimeStart)
      || !RFC3339_INSTANT_PATTERN.test(dateTimeEnd)
    ) {
      unavailable("Google Calendar returned invalid appointment timing.");
    }
    const startMs = Date.parse(dateTimeStart);
    const endMs = Date.parse(dateTimeEnd);
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || startMs >= endMs
      || startMs < Date.parse(range.timeMin)
      || endMs > Date.parse(range.timeMax)
    ) {
      unavailable("Google Calendar returned invalid appointment timing.");
    }
    return {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay: false
    };
  }
  if (
    typeof event.start.date !== "string"
    || typeof event.end.date !== "string"
    || !ISO_DATE_PATTERN.test(event.start.date)
    || !ISO_DATE_PATTERN.test(event.end.date)
  ) {
    unavailable("Google Calendar returned invalid appointment timing.");
  }
  const start = calendarDate(event.start.date);
  const end = calendarDate(event.end.date);
  if (start >= end) {
    unavailable("Google Calendar returned invalid appointment timing.");
  }
  return { start, end, allDay: true };
}

function appointmentKind(normalizedText) {
  if (/(?:^| )reinspection(?: |$)/.test(normalizedText)) {
    return "reinspection";
  }
  if (
    /(?:^| )adjuster(?: |$)/.test(normalizedText)
    && /(?:^| )inspection(?: |$)/.test(normalizedText)
  ) {
    return "adjuster_inspection";
  }
  if (/(?:^| )inspection(?: |$)/.test(normalizedText)) {
    return "inspection";
  }
  if (/(?:^| )appraisal(?: |$)/.test(normalizedText)) {
    return "appraisal";
  }
  if (/(?:^| )estimate(?: |$)/.test(normalizedText)) {
    return "estimate_appointment";
  }
  return "appointment";
}

function fileMatchTerms(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 12) {
    invalidInput("matchTerms must contain 1-12 exact file identifiers.");
  }
  const result = [];
  const seen = new Set();
  for (const item of values) {
    if (
      !isPlainObject(item)
      || Object.keys(item).length !== 2
      || !Object.hasOwn(item, "kind")
      || !Object.hasOwn(item, "value")
      || typeof item.kind !== "string"
      || !MATCH_TERM_KINDS.has(item.kind)
      || typeof item.value !== "string"
    ) {
      invalidInput("matchTerms contain an invalid exact file identifier.");
    }
    let normalized;
    if (item.kind === "phone") {
      normalized = item.value.replace(/\D/g, "");
      if (normalized.length < 10 || normalized.length > 15) {
        invalidInput("A phone match term must contain 10-15 digits.");
      }
    } else {
      normalized = normalizeMatchText(item.value);
      const minimum = item.kind === "job_number" ? 3 : 5;
      if (normalized.length < minimum || normalized.length > 256) {
        invalidInput("A calendar match term has an unsafe length.");
      }
      if (
        item.kind === "email"
        && !/^[^ ]+@[^ ]+\.[^ ]+$/.test(normalized)
      ) {
        invalidInput("An email match term is invalid.");
      }
    }
    const key = `${item.kind}\0${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: item.kind, normalized });
  }
  if (!result.length) {
    invalidInput("matchTerms must contain an exact file identifier.");
  }
  return result;
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactNormalizedMatch(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`
  ).test(haystack);
}

function utcDayRange(date, timeZone) {
  const startParts = parseDate(date);
  const endParts = addUtcCalendarDays(startParts, 1);
  const start = localMidnightUtc(startParts, timeZone);
  const end = localMidnightUtc(endParts, timeZone);
  if (!(end > start) || end - start < 20 * 60 * 60_000 || end - start > 28 * 60 * 60_000) {
    invalidInput("The requested calendar day could not be resolved safely.");
  }
  return {
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(end).toISOString()
  };
}

function localMidnightUtc(parts, timeZone) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day);
  let candidate = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = zonedDateTimeParts(candidate, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );
    const adjustment = desired - observedAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const verified = zonedDateTimeParts(candidate, timeZone);
  if (
    verified.year !== parts.year
    || verified.month !== parts.month
    || verified.day !== parts.day
    || verified.hour !== 0
    || verified.minute !== 0
    || verified.second !== 0
  ) {
    invalidInput("The requested calendar day could not be resolved safely.");
  }
  return candidate;
}

function zonedDateTimeParts(instantMs, timeZone) {
  let formatted;
  try {
    formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(new Date(instantMs));
  } catch {
    invalidInput("timeZone must be a supported IANA time zone.");
  }
  const values = Object.fromEntries(
    formatted
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  if (
    !Number.isSafeInteger(values.year)
    || !Number.isSafeInteger(values.month)
    || !Number.isSafeInteger(values.day)
    || !Number.isSafeInteger(values.hour)
    || !Number.isSafeInteger(values.minute)
    || !Number.isSafeInteger(values.second)
  ) {
    invalidInput("The requested calendar day could not be resolved safely.");
  }
  return values;
}

function calendarDate(value) {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    invalidInput("date must be an exact YYYY-MM-DD calendar date.");
  }
  const parts = parseDate(value);
  const checked = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    checked.getUTCFullYear() !== parts.year
    || checked.getUTCMonth() + 1 !== parts.month
    || checked.getUTCDate() !== parts.day
  ) {
    invalidInput("date must be a real calendar date.");
  }
  return value;
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function addUtcCalendarDays(parts, days) {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days)
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function ianaTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    invalidInput("timeZone must be a supported IANA time zone.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    invalidInput("timeZone must be a supported IANA time zone.");
  }
  return value;
}

function calendarIdValue(value) {
  if (
    typeof value !== "string"
    || !SAFE_CALENDAR_ID_PATTERN.test(value)
  ) {
    invalidConfiguration("calendarId is invalid");
  }
  return value;
}

function optionalFileRef(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !FILE_REF_PATTERN.test(value)) {
    invalidInput("fileRef must be one opaque HCN file reference.");
  }
  return value;
}

function requiredFileRef(value) {
  const normalized = optionalFileRef(value);
  if (!normalized) {
    invalidInput("fileRef must be one opaque HCN file reference.");
  }
  return normalized;
}

function nowInstant(now) {
  if (typeof now !== "function") {
    invalidConfiguration("now must be a function");
  }
  let value;
  try {
    value = now();
  } catch {
    unavailable("Calendar read timing is unavailable.");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    unavailable("Calendar read timing is unavailable.");
  }
  return date.toISOString();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function invalidInput(message) {
  throw new HcnCalendarReadError("invalid_calendar_read", 400, message);
}

function invalidConfiguration(message) {
  throw new HcnCalendarReadError(
    "calendar_read_not_configured",
    503,
    message
  );
}

function unavailable(message) {
  throw new HcnCalendarReadError("calendar_read_unavailable", 503, message);
}
