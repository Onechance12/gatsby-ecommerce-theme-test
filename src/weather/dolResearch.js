const DEFAULT_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const DEFAULT_REPORTS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/lsr.py";
const CENTRAL_TIME_ZONE = "America/Chicago";

export async function researchPropertyHailDates(input, options = {}) {
  const address = String(input.address || "").trim();
  if (!address) throw new Error("A complete property address is required for DOL research.");
  const startDate = validIsoDate(input.startDate, "startDate");
  const endDate = validIsoDate(input.endDate, "endDate");
  if (startDate > endDate) throw new Error("startDate must be on or before endDate.");
  if (daysBetween(startDate, endDate) > 800) throw new Error("DOL research is limited to an 800-day window.");

  const radiusMiles = clampNumber(input.radiusMiles, 1, 100, 35);
  const minimumHailInches = clampNumber(input.minimumHailInches, 0.25, 6, 1);
  const limit = Math.round(clampNumber(input.limit, 1, 20, 10));
  const fetchImpl = options.fetchImpl || fetch;
  const geocoderUrl = options.geocoderUrl || DEFAULT_GEOCODER_URL;
  const reportsUrl = options.reportsUrl || DEFAULT_REPORTS_URL;

  const geocoded = await geocodeAddress(address, { fetchImpl, geocoderUrl });
  const bounds = boundingBox(geocoded.latitude, geocoded.longitude, radiusMiles);
  const reports = await fetchHailReports({
    startDate,
    endDate,
    state: String(input.state || "").trim().toUpperCase(),
    minimumHailInches,
    bounds
  }, { fetchImpl, reportsUrl });

  const nearbyReports = reports
    .map((report) => ({
      ...report,
      distanceMiles: round(haversineMiles(
        geocoded.latitude,
        geocoded.longitude,
        report.latitude,
        report.longitude
      ), 1)
    }))
    .filter((report) => report.distanceMiles <= radiusMiles);
  const candidates = rankCandidates(nearbyReports).slice(0, limit);

  return {
    mode: "read_only_weather_research",
    property: {
      requestedAddress: address,
      matchedAddress: geocoded.matchedAddress,
      latitude: geocoded.latitude,
      longitude: geocoded.longitude
    },
    search: {
      startDate,
      endDate,
      radiusMiles,
      minimumHailInches,
      reportsReturned: reports.length,
      nearbyReports: nearbyReports.length
    },
    candidates,
    recommendedCandidate: candidates[0] || null,
    sources: {
      geocoder: "U.S. Census Geocoder",
      hailReports: "Iowa Environmental Mesonet archive of National Weather Service Local Storm Reports",
      geocoderUrl,
      reportsUrl
    },
    warnings: [
      "These are reported hail observations near the property, not proof that this property was damaged on a specific date.",
      "Local Storm Reports are point observations and may be incomplete; no nearby report does not prove that hail did not occur.",
      "Confirm the selected date against policy coverage, current JobNimbus documents, claim history, and carrier evidence before filing or updating JobNimbus."
    ]
  };
}

export async function geocodeAddress(address, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(options.geocoderUrl || DEFAULT_GEOCODER_URL);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const response = await fetchImpl(url, {
    headers: { "user-agent": "Chance-JobNimbus-Ops-Assistant/1.0" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Census geocoder returned HTTP ${response.status}.`);
  const payload = await response.json();
  const match = payload?.result?.addressMatches?.[0];
  const latitude = Number(match?.coordinates?.y);
  const longitude = Number(match?.coordinates?.x);
  if (!match || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`The property address could not be geocoded: ${address}`);
  }
  return { matchedAddress: match.matchedAddress || address, latitude, longitude };
}

export async function fetchHailReports(input, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(options.reportsUrl || DEFAULT_REPORTS_URL);
  url.searchParams.set("sts", `${input.startDate}T00:00:00Z`);
  url.searchParams.set("ets", `${addDays(input.endDate, 1)}T00:00:00Z`);
  url.searchParams.set("type", "HAIL");
  url.searchParams.set("magge", String(input.minimumHailInches));
  url.searchParams.set("fmt", "csv");
  if (input.state) url.searchParams.set("state", input.state);
  for (const [key, value] of Object.entries(input.bounds)) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, {
    headers: { "user-agent": "Chance-JobNimbus-Ops-Assistant/1.0" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Hail report service returned HTTP ${response.status}.`);
  const csv = await response.text();
  if (Buffer.byteLength(csv, "utf8") > 8 * 1024 * 1024) throw new Error("Hail report response exceeded the 8 MB safety limit.");
  return parseHailReportCsv(csv);
}

export function parseHailReportCsv(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => value.trim().toUpperCase());
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  return rows.slice(1).map((row) => {
    const latitude = Number(row[index.LAT]);
    const longitude = Number(row[index.LON]);
    const hailInches = Number(row[index.MAG]);
    const validUtc = parseIemValid(row[index.VALID]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(hailInches) || !validUtc) return null;
    return {
      localDate: formatCentralDate(validUtc),
      reportedAtUtc: validUtc.toISOString(),
      hailInches,
      latitude,
      longitude,
      city: row[index.CITY] || "",
      county: row[index.COUNTY] || "",
      state: row[index.STATE] || "",
      source: row[index.SOURCE] || "",
      remark: row[index.REMARK] || ""
    };
  }).filter(Boolean);
}

export function rankCandidates(reports) {
  const grouped = new Map();
  for (const report of reports) {
    const current = grouped.get(report.localDate) || [];
    current.push(report);
    grouped.set(report.localDate, current);
  }
  return [...grouped.entries()].map(([date, rows]) => {
    const largestHailInches = Math.max(...rows.map((row) => row.hailInches));
    const nearestDistanceMiles = Math.min(...rows.map((row) => row.distanceMiles));
    const nearestReport = [...rows].sort((a, b) => a.distanceMiles - b.distanceMiles || b.hailInches - a.hailInches)[0];
    const confidence = largestHailInches >= 1.5 && nearestDistanceMiles <= 5
      ? "strong_report_candidate"
      : largestHailInches >= 1 && nearestDistanceMiles <= 15
        ? "moderate_report_candidate"
        : "weak_report_candidate";
    return {
      date,
      confidence,
      largestHailInches: round(largestHailInches, 2),
      nearestDistanceMiles: round(nearestDistanceMiles, 1),
      reportCount: rows.length,
      nearestReport: {
        reportedAtUtc: nearestReport.reportedAtUtc,
        hailInches: nearestReport.hailInches,
        distanceMiles: nearestReport.distanceMiles,
        location: [nearestReport.city, nearestReport.county, nearestReport.state].filter(Boolean).join(", "),
        source: nearestReport.source,
        remark: nearestReport.remark
      },
      score: round(largestHailInches * 20 + Math.max(0, 35 - nearestDistanceMiles) + Math.min(rows.length, 10), 1)
    };
  }).sort((a, b) => b.score - a.score || a.nearestDistanceMiles - b.nearestDistanceMiles || b.largestHailInches - a.largestHailInches);
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function boundingBox(latitude, longitude, radiusMiles) {
  const latDelta = radiusMiles / 69;
  const lonDelta = radiusMiles / Math.max(10, 69 * Math.cos(latitude * Math.PI / 180));
  return {
    north: round(latitude + latDelta, 5),
    south: round(latitude - latDelta, 5),
    east: round(longitude + lonDelta, 5),
    west: round(longitude - lonDelta, 5)
  };
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

function parseIemValid(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 12) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCentralDate(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validIsoDate(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  return text;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function round(value, digits) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
