export function requireTwilioConfig(config) {
  const missing = [];
  if (!config.twilio.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.twilio.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.twilio.fromNumber) missing.push("TWILIO_FROM_NUMBER");
  return missing;
}

export async function createTwilioCall(config, params) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`;
  const body = new URLSearchParams(params);
  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`Twilio call create failed with ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return payload;
}

export function parseJsonArg(args) {
  const text = args.join(" ").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected a JSON argument, got: ${text.slice(0, 120)}`);
  }
}

export function normalizeE164(value) {
  const digits = String(value || "").replace(/[^0-9+]/g, "");
  if (!digits) return "";
  return digits.startsWith("+") ? digits : `+1${digits}`;
}
