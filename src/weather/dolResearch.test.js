import assert from "node:assert/strict";
import test from "node:test";

import { haversineMiles, parseHailReportCsv, rankCandidates, researchPropertyHailDates } from "./dolResearch.js";

const CSV = [
  "VALID,VALID2,LAT,LON,MAG,WFO,TYPECODE,TYPETEXT,CITY,COUNTY,STATE,SOURCE,REMARK,UGC,UGCNAME,QUALIFIER",
  '202604252130,2026/04/25 21:30,32.77,-96.65,1.75,FWD,H,HAIL,Mesquite,Dallas,TX,Public,"Golf ball hail, photographed.",TXC113,Dallas,M',
  "202604260130,2026/04/26 01:30,32.90,-96.90,1.00,FWD,H,HAIL,Dallas,Dallas,TX,Trained Spotter,Quarter hail.,TXC113,Dallas,M"
].join("\n");

test("parses quoted hail reports and converts UTC timestamps to Central dates", () => {
  const reports = parseHailReportCsv(CSV);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].localDate, "2026-04-25");
  assert.equal(reports[0].localTime, "4:30 PM CDT");
  assert.match(reports[0].localDateTime, /04\/25\/2026, 4:30 PM CDT/);
  assert.equal(reports[0].hailInches, 1.75);
  assert.equal(reports[0].remark, "Golf ball hail, photographed.");
  assert.equal(reports[1].localDate, "2026-04-25");
});

test("ranks close, large hail as a strong candidate", () => {
  const candidates = rankCandidates([
    { localDate: "2026-04-25", hailInches: 1.75, distanceMiles: 1.2, reportedAtUtc: "2026-04-25T21:30:00.000Z", city: "Mesquite", county: "Dallas", state: "TX", source: "Public", remark: "Golf ball hail" },
    { localDate: "2026-04-25", hailInches: 1, distanceMiles: 12, reportedAtUtc: "2026-04-26T01:30:00.000Z", city: "Dallas", county: "Dallas", state: "TX", source: "Spotter", remark: "Quarter hail" }
  ]);
  assert.equal(candidates[0].date, "2026-04-25");
  assert.equal(candidates[0].confidence, "strong_report_candidate");
  assert.equal(candidates[0].reportCount, 2);
  assert.equal(candidates[0].nearestReport.localTime, undefined);
});

test("researches a property without writing or treating the candidate as confirmed DOL", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("geocoder")) {
      return new Response(JSON.stringify({
        result: { addressMatches: [{ matchedAddress: "2904 HILLSIDE DR, MESQUITE, TX, 75149", coordinates: { x: -96.6436, y: 32.7664 } }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(CSV, { status: 200, headers: { "content-type": "text/csv" } });
  };
  const result = await researchPropertyHailDates({
    address: "2904 Hillside Dr, Mesquite, TX 75149",
    state: "TX",
    startDate: "2025-01-01",
    endDate: "2026-07-16"
  }, { fetchImpl, geocoderUrl: "https://example.test/geocoder", reportsUrl: "https://example.test/lsr" });
  assert.equal(result.mode, "read_only_weather_research");
  assert.equal(result.recommendedCandidate.date, "2026-04-25");
  assert.equal(result.recommendedCandidate.nearestReport.localTime, "4:30 PM CDT");
  assert.match(result.warnings.join(" "), /not proof/i);
  assert.ok(haversineMiles(32.7664, -96.6436, 32.77, -96.65) < 1);
});
