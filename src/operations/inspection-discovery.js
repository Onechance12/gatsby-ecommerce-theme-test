const INSPECTION_TASK_PATTERN = /\b(?:estimate inspection|carrier inspection|reinspection|adjuster appointment|adjuster meeting|appraisal inspection|inspection)\b/i;

export function selectTodaysInspectionTasks(rows = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const timeZone = options.timeZone || "America/Chicago";
  const today = localDateKey(now, timeZone);

  return rows
    .filter((row) => row && row.contact && row.task)
    .filter((row) => row.task.is_completed !== true)
    .filter((row) => INSPECTION_TASK_PATTERN.test(taskText(row.task)))
    .filter((row) => localDateKey(taskDate(row.task), timeZone) === today)
    .sort((a, b) => dateValue(taskDate(a.task)) - dateValue(taskDate(b.task)));
}

export function localDateKey(value, timeZone = "America/Chicago") {
  const date = toDate(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function taskText(task) {
  return `${task.title || task.subject || ""} ${task.description || task.note || ""}`;
}

function taskDate(task) {
  return task.date_start || task.date_end || task.dueDate || "";
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value || ""))) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    const milliseconds = number < 1e12 ? number * 1000 : number;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateValue(value) {
  return toDate(value)?.getTime() || Number.MAX_SAFE_INTEGER;
}
