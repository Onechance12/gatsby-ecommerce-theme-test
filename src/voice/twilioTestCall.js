import { createTwilioCall, normalizeE164, parseJsonArg, requireTwilioConfig } from "./twilioHelpers.js";

export async function runTwilioTestCall(config, args) {
  const input = parseJsonArg(args);
  const to = normalizeE164(input.to || config.twilio.verifiedTestNumber);
  const message = input.message || "This is a JobNimbus assistant test call. The voice pipeline is working. Goodbye.";
  const execute = input.execute === true;

  if (!to) {
    console.log("Usage: npm run voice:test-call -- '{\"to\":\"+18065551212\"}' (or set TWILIO_VERIFIED_TEST_NUMBER)");
    process.exitCode = 1;
    return;
  }

  const missing = requireTwilioConfig(config);
  const plan = {
    action: "twilio_test_call",
    to,
    from: config.twilio.fromNumber || "(TWILIO_FROM_NUMBER not set)",
    message,
    mode: execute && config.twilio.allowVoiceCalls ? "EXECUTE" : "DRY RUN",
    missingConfig: missing
  };
  console.log(JSON.stringify(plan, null, 2));

  if (!execute || !config.twilio.allowVoiceCalls) {
    console.log("");
    console.log("Dry run only. To place the call, set ALLOW_VOICE_CALLS=true and pass \"execute\":true.");
    return;
  }
  if (missing.length) {
    console.log(`Blocked: missing ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const twiml = `<Response><Say voice="alice">${escapeXml(message)}</Say></Response>`;
  const params = { To: to, From: config.twilio.fromNumber, Twiml: twiml };
  if (config.twilio.statusCallbackUrl) params.StatusCallback = config.twilio.statusCallbackUrl;

  const call = await createTwilioCall(config, params);
  console.log(`Call created: ${call.sid} (status: ${call.status})`);
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  }[char]));
}
