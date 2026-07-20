const DEFAULT_TIME_ZONE = "America/Chicago";
const APPOINTMENT_PATTERN = /\b(adjuster|apprais|inspection|reinspection|meeting|appointment|site visit|field visit)\b/i;

export function availabilityRange(options = {}) {
  const now = validDate(options.now) || new Date();
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const horizonDays = positiveInteger(options.horizonDays, 21);
  const firstDate = centralDateKey(now, timeZone);
  const lastDate = addDays(firstDate, horizonDays - 1);
  return {
    timeMin: zonedDateTimeToDate(firstDate, "00:00", timeZone).toISOString(),
    timeMax: zonedDateTimeToDate(lastDate, "23:59", timeZone).toISOString(),
    firstDate,
    lastDate,
    timeZone
  };
}

export function busyIntervalsFromJobNimbusTasks(tasks, options = {}) {
  const ownerId = String(options.ownerId || "").trim();
  const rangeStart = dateMs(options.timeMin) || Number.NEGATIVE_INFINITY;
  const rangeEnd = dateMs(options.timeMax) || Number.POSITIVE_INFINITY;
  const defaultDurationMs = positiveInteger(options.defaultDurationMinutes, 60) * 60_000;

  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && task.is_completed !== true && task.is_archived !== true && task.is_active !== false)
    .filter((task) => task.hide_from_calendarview !== true && task.all_day !== true)
    .filter((task) => !ownerId || ownerIds(task).includes(ownerId))
    .map((task) => {
      const start = unixMs(task.date_start || task.date_sort || task.date_end);
      const explicitEnd = unixMs(task.date_end);
      const title = String(task.title || task.subject || task.record_type_name || "").trim();
      const hasRange = explicitEnd > start;
      if (!start || (!hasRange && !APPOINTMENT_PATTERN.test(title))) return null;
      const end = hasRange ? explicitEnd : start + defaultDurationMs;
      if (end <= rangeStart || start >= rangeEnd) return null;
      return {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        source: "jobnimbus",
        sourceId: String(task.jnid || task.id || task.recid || ""),
        label: title || "JobNimbus calendar item"
      };
    })
    .filter(Boolean);
}

export function buildUnifiedAvailability(options = {}) {
  const range = options.range || availabilityRange(options);
  const timeZone = range.timeZone || options.timeZone || DEFAULT_TIME_ZONE;
  const durationMinutes = positiveInteger(options.durationMinutes, 120);
  const bufferMinutes = nonNegativeInteger(options.bufferMinutes, 60);
  const minLeadHours = nonNegativeInteger(options.minLeadHours, 24);
  const workdayStart = validClock(options.workdayStart) || "08:00";
  const workdayEnd = validClock(options.workdayEnd) || "18:00";
  const now = validDate(options.now) || new Date();
  const sources = normalizeSources(options.sources);
  const failedSources = sources.filter((source) => source.status !== "ready");
  const busy = mergeIntervals([
    ...(options.jobNimbusBusy || []),
    ...(options.googleBusy || [])
  ], bufferMinutes);
  const settings = {
    timeZone,
    durationMinutes,
    bufferMinutes,
    minLeadHours,
    workdayStart,
    workdayEnd,
    sundaysExcluded: true
  };

  if (failedSources.length) {
    return {
      status: "BLOCKED",
      reason: `Availability is not authoritative because ${failedSources.map((source) => source.name).join(" and ")} could not be checked.`,
      range,
      settings,
      sources,
      busy,
      availableWindows: [],
      voiceWindows: "None. Do not schedule an appointment."
    };
  }

  const earliest = Math.max(now.getTime() + minLeadHours * 60 * 60_000, dateMs(range.timeMin));
  const latest = dateMs(range.timeMax);
  const availableWindows = [];
  for (let dateKey = range.firstDate; dateKey <= range.lastDate; dateKey = addDays(dateKey, 1)) {
    if (isSunday(dateKey)) continue;
    const dayStart = Math.max(zonedDateTimeToDate(dateKey, workdayStart, timeZone).getTime(), earliest);
    const dayEnd = Math.min(zonedDateTimeToDate(dateKey, workdayEnd, timeZone).getTime(), latest);
    if (dayEnd - dayStart < durationMinutes * 60_000) continue;
    const dayBusy = busy.filter((interval) => dateMs(interval.end) > dayStart && dateMs(interval.start) < dayEnd);
    let cursor = dayStart;
    for (const interval of dayBusy) {
      const start = Math.max(dayStart, dateMs(interval.start));
      const end = Math.min(dayEnd, dateMs(interval.end));
      if (start - cursor >= durationMinutes * 60_000) {
        availableWindows.push(windowRecord(cursor, start, timeZone));
      }
      cursor = Math.max(cursor, end);
    }
    if (dayEnd - cursor >= durationMinutes * 60_000) {
      availableWindows.push(windowRecord(cursor, dayEnd, timeZone));
    }
  }

  return {
    status: availableWindows.length ? "READY" : "BLOCKED",
    reason: availableWindows.length ? "Both calendars were checked and merged." : "Both calendars were checked, but no qualifying appointment window is open.",
    range,
    settings,
    sources,
    busy,
    availableWindows,
    voiceWindows: availableWindows.length
      ? availableWindows.map((window) => window.label).join(" | ")
      : "None. Do not schedule an appointment."
  };
}

export function appointmentFitsAvailability(start, end, availability) {
  const startMs = dateMs(start);
  const endMs = dateMs(end);
  if (availability?.status !== "READY" || !startMs || !endMs || endMs <= startMs) return false;
  return (availability.availableWindows || []).some((window) => (
    startMs >= dateMs(window.start) && endMs <= dateMs(window.end)
  ));
}

function normalizeSources(sources) {
  const rows = Array.isArray(sources) ? sources : [];
  return ["jobnimbus", "google_calendar"].map((name) => {
    const source = rows.find((row) => row?.name === name) || {};
    return {
      name,
      status: source.status === "ready" ? "ready" : "blocked",
      busyCount: Number(source.busyCount || 0),
      error: String(source.error || "")
    };
  });
}

function mergeIntervals(intervals, bufferMinutes) {
  const bufferMs = bufferMinutes * 60_000;
  const rows = (Array.isArray(intervals) ? intervals : [])
    .map((interval) => {
      const start = dateMs(interval.start) - bufferMs;
      const end = dateMs(interval.end) + bufferMs;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return { start, end, sources: [String(interval.source || "unknown")] };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const row of rows) {
    const previous = merged.at(-1);
    if (!previous || row.start > previous.end) {
      merged.push({ ...row });
      continue;
    }
    previous.end = Math.max(previous.end, row.end);
    previous.sources = [...new Set([...previous.sources, ...row.sources])];
  }
  return merged.map((row) => ({
    start: new Date(row.start).toISOString(),
    end: new Date(row.end).toISOString(),
    sources: row.sources
  }));
}

function windowRecord(start, end, timeZone) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    label: `${formatDay(startDate, timeZone)}, ${formatTime(startDate, timeZone)}-${formatTime(endDate, timeZone)} Central`
  };
}

function formatDay(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function ownerIds(task) {
  const rows = Array.isArray(task?.owners) ? task.owners : [task?.owner, task?.assigned_to, task?.assignedTo];
  return rows.flatMap((row) => {
    if (!row) return [];
    if (typeof row === "string") return [row];
    return [row.id, row.jnid].filter(Boolean).map(String);
  });
}

function unixMs(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number > 9_999_999_999 ? number : number * 1000;
}

function dateMs(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function validClock(value) {
  const text = String(value || "").trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : "";
}

function centralDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(amount || 0)));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function isSunday(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0;
}

function zonedDateTimeToDate(dateKey, clock, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = clock.split(":").map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(targetUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, timeZone);
    const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate = new Date(candidate.getTime() + (targetUtc - representedUtc));
  }
  return candidate;
}

function zonedParts(date, timeZone) {
  const values = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
