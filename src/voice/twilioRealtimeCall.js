import { createTwilioCall, normalizeE164, parseJsonArg, requireTwilioConfig } from "./twilioHelpers.js";

export async function runTwilioRealtimeCall(config, args) {
  const input = parseJsonArg(args);
  const to = normalizeE164(input.to || config.twilio.verifiedTestNumber);
  const execute = input.execute === true;
  const streamUrl = buildStreamUrl(config);

  if (!to) {
    console.log("Usage: npm run voice:realtime-call -- '{\"to\":\"+18065551212\"}' (or set TWILIO_VERIFIED_TEST_NUMBER)");
    process.exitCode = 1;
    return;
  }

  const missing = requireTwilioConfig(config);
  if (!streamUrl) missing.push("TWILIO_MEDIA_STREAM_URL or VOICE_PUBLIC_BASE_URL");
  if (!config.openai.apiKey) missing.push("OPENAI_API_KEY");

  const plan = {
    action: "twilio_openai_realtime_call",
    to,
    from: config.twilio.fromNumber || "(TWILIO_FROM_NUMBER not set)",
    mediaStreamUrl: streamUrl || "(not configured)",
    realtimeModel: config.openai.realtimeModel,
    voice: config.openai.voice,
    mode: execute && config.twilio.allowVoiceCalls ? "EXECUTE" : "DRY RUN",
    missingConfig: missing,
    note: "The voice server (npm run voice:server) must be running and publicly reachable at the media stream URL."
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

  const twiml = `<Response><Connect><Stream url="${streamUrl}"/></Connect></Response>`;
  const params = { To: to, From: config.twilio.fromNumber, Twiml: twiml };
  if (config.twilio.statusCallbackUrl) params.StatusCallback = config.twilio.statusCallbackUrl;

  const call = await createTwilioCall(config, params);
  console.log(`Realtime call created: ${call.sid} (status: ${call.status})`);
}

export function buildStreamUrl(config) {
  if (config.twilio.mediaStreamUrl) return config.twilio.mediaStreamUrl;
  if (!config.voice.publicBaseUrl) return "";
  const base = config.voice.publicBaseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const token = config.voice.streamToken ? `?token=${encodeURIComponent(config.voice.streamToken)}` : "";
  return `${base}/media-stream${token}`;
}
