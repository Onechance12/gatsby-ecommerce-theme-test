// Candidate only. A reviewed bridge deployment, capability/build pin and
// versioned Operator installation are required before activation. Never edit
// an installed cache or turn this on as a workaround for a read denial.
export const COMMUNICATION_SWEEP_ENABLED = false;
export const COMMUNICATION_SWEEP_ROUTE = "/ops/recent-communications";

export function validateCommunicationsSweepInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["days", "maxResults", "source"].includes(key))) throw new Error("Unsupported communications-sweep input.");
  const { days = 7, maxResults = 50, source = "all" } = input;
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100
    || !["all", "quo", "gmail"].includes(source)) throw new Error("Invalid bounded communications-sweep input.");
  return { days, maxResults, source };
}

export function assertCommunicationsSweepResult(result, { request = validateCommunicationsSweepInput(), lineNumber, mailbox = "cpearson@wavepa.com" } = {}) {
  if (result?.mode !== "read_only_discovery" || result.effectsAuthorized !== false
    || result.scope !== "chance_own_mailbox_and_quo_line" || !Array.isArray(result.queue)
    || typeof result.complete !== "boolean" || !result.coverage?.gmail || !result.coverage?.quo
    || result.queue.length > request.maxResults || result.window?.days !== request.days
    || result.window?.source !== request.source || result.window?.maxResults !== request.maxResults
    || !Number.isFinite(Date.parse(result.window?.start)) || !Number.isFinite(Date.parse(result.window?.end))
    || Date.parse(result.window.end) - Date.parse(result.window.start) !== request.days * 86400000) {
    throw new Error("Communications discovery failed its read-only response contract.");
  }
  const gmail = result.coverage.gmail, quo = result.coverage.quo;
  if (!["unavailable", "not_requested"].includes(gmail.status) && gmail.mailbox !== mailbox) throw new Error("Communications discovery mailbox mismatch.");
  if (!["unavailable", "not_requested"].includes(quo.status) && (!lineNumber || quo.lineNumber !== lineNumber)) throw new Error("Communications discovery line mismatch.");
  if (result.queue.some(item => !["gmail", "quo"].includes(item.channel) || !["incoming", "outgoing", "draft"].includes(item.direction)
    || String(item.fileMatch?.file?.number || "") === "2628"
    || !Number.isFinite(Date.parse(item.atUtc)) || Date.parse(item.atUtc) < Date.parse(result.window.start) || Date.parse(item.atUtc) > Date.parse(result.window.end)
    || (request.source !== "all" && item.channel !== request.source)
    || (item.channel === "quo" && item.lineNumber !== lineNumber))) throw new Error("Communications discovery item scope mismatch.");
  if (result.complete && (result.omittedItems > 0 || [gmail, quo].some(source => source.status !== "not_requested" && source.complete !== true))) {
    throw new Error("Communications discovery incorrectly claims complete coverage.");
  }
  return result;
}

export async function readAttestedCommunications({ input, verify, read, canonical = JSON.stringify }) {
  const request = validateCommunicationsSweepInput(input);
  const before = await verify();
  if (before?.ready !== true || !before.boundary) throw new Error("Communications discovery requires a ready attested boundary.");
  const result = assertCommunicationsSweepResult(await read(request), { request, lineNumber: before.lineNumber });
  const after = await verify();
  if (after?.ready !== true || canonical(after.boundary) !== canonical(before.boundary) || after.lineNumber !== before.lineNumber) {
    throw new Error("The bridge boundary changed during read-only communications discovery.");
  }
  return result;
}
