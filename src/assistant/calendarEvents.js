const APPOINTMENT_WORDS = /\b(reinspection|inspection|adjuster appointment|adjuster meeting|appraisal meeting|meeting scheduled|scheduled reinspection)\b/i;
const DATE_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;
const BETWEEN_TIME_PATTERN = /\bbetween\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s+(?:and|-|to)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i;
const RANGE_TIME_PATTERN = /\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i;
const SINGLE_TIME_PATTERN = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i;

export function calendarEventActionFromReview(review) {
  const appointment = findAppointment(review);
  if (!appointment) return null;

  const file = review.file;
  const title = `${appointment.kind}: ${file.customer}`;
  const description = [
    `${appointment.kind} found in JobNimbus activity.`,
    "",
    `Client: ${file.customer}`,
    file.address ? `Property: ${file.address}` : "",
    file.carrier ? `Carrier: ${file.carrier}` : "",
    file.claimNumber ? `Claim #: ${cleanClaimNumber(file.claimNumber)}` : "",
    file.policyNumber ? `Policy #: ${file.policyNumber}` : "",
    formatAdjuster(file),
    "",
    "Source note:",
    appointment.sourceText
  ].filter(Boolean).join("\n");

  return {
    channel: "google_calendar",
    action: "create_event",
    executable: false,
    title: "Create calendar event",
    event: {
      summary: title,
      start: appointment.start,
      end: appointment.end,
      timezone: "America/Chicago",
      location: file.address || "",
      description
    },
    reason: "Hard appointment/reinspection window found in JobNimbus; this should be on the calendar before relying on memory or notes."
  };
}

function findAppointment(review) {
  const sources = [];
  for (const note of review.file.notes || []) {
    sources.push({
      kind: "note",
      text: String(note.body || ""),
      createdAt: note.createdAt || ""
    });
  }
  for (const task of review.file.openTasks || []) {
    sources.push({
      kind: "task",
      text: `${task.title || ""} ${task.dueDate || ""}`.trim(),
      createdAt: task.dueDate || ""
    });
  }

  for (const source of sources) {
    if (!APPOINTMENT_WORDS.test(source.text)) continue;
    const parsed = parseAppointmentText(source.text, source.createdAt);
    if (parsed) return parsed;
  }

  return null;
}

function parseAppointmentText(text, fallbackDate) {
  const dateParts = parseDateParts(text) || parseFallbackDate(fallbackDate);
  if (!dateParts) return null;

  const timeRange = parseTimeRange(text);
  if (!timeRange) return null;

  const kind = inferKind(text);
  return {
    kind,
    start: toIsoLocal(dateParts, timeRange.startHour, timeRange.startMinute),
    end: toIsoLocal(dateParts, timeRange.endHour, timeRange.endMinute),
    sourceText: truncate(clean(text), 500)
  };
}

function parseDateParts(text) {
  const match = String(text || "").match(DATE_PATTERN);
  if (!match) return null;
  return {
    year: Number(match[3]),
    month: Number(match[1]),
    day: Number(match[2])
  };
}

function parseFallbackDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    return { year, month, day };
  }
  return null;
}

function parseTimeRange(text) {
  const between = String(text || "").match(BETWEEN_TIME_PATTERN);
  if (between) return buildRange(between[1], between[2], between[3], between[4], between[5], between[6]);

  const range = String(text || "").match(RANGE_TIME_PATTERN);
  if (range) return buildRange(range[1], range[2], range[3], range[4], range[5], range[6]);

  const single = String(text || "").match(SINGLE_TIME_PATTERN);
  if (!single) return null;
  const start = toTwentyFourHour(single[1], single[2], single[3]);
  return {
    startHour: start.hour,
    startMinute: start.minute,
    endHour: start.hour + 1,
    endMinute: start.minute
  };
}

function buildRange(startHour, startMinute, startMeridiem, endHour, endMinute, endMeridiem) {
  const start = toTwentyFourHour(startHour, startMinute, startMeridiem);
  const end = toTwentyFourHour(endHour, endMinute, endMeridiem);
  return {
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute
  };
}

function toTwentyFourHour(hourValue, minuteValue, meridiem) {
  let hour = Number(hourValue);
  const minute = Number(minuteValue || 0);
  const upper = String(meridiem || "").toUpperCase();
  if (upper === "PM" && hour !== 12) hour += 12;
  if (upper === "AM" && hour === 12) hour = 0;
  return { hour, minute };
}

function toIsoLocal(dateParts, hour, minute) {
  return [
    String(dateParts.year).padStart(4, "0"),
    String(dateParts.month).padStart(2, "0"),
    String(dateParts.day).padStart(2, "0")
  ].join("-") + `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function inferKind(text) {
  const cleanText = clean(text);
  if (/reinspection/i.test(cleanText)) return "Reinspection";
  if (/appraisal meeting/i.test(cleanText)) return "Appraisal meeting";
  if (/adjuster/i.test(cleanText)) return "Adjuster appointment";
  if (/inspection/i.test(cleanText)) return "Inspection";
  return "Claim appointment";
}

function formatAdjuster(file) {
  const adjuster = file.adjuster || {};
  const parts = [adjuster.name, adjuster.phone, adjuster.email].filter(Boolean);
  return parts.length ? `Adjuster/contact: ${parts.join(", ")}` : "";
}

function cleanClaimNumber(value) {
  return String(value || "")
    .replace(/\bReference\s*#?\b/gi, "")
    .replace(/\bClaim\s*#?:?\s*/gi, "")
    .replace(/\s+#\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, max) {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
