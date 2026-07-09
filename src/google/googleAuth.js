// Google OAuth token layer, ported from the jobnimbus-bridge branch.
// Uses a long-lived refresh token to mint short-lived access tokens.

let cached = { token: "", expiresAt: 0 };

export function googleConfigured(config) {
  const g = config.google;
  return Boolean(g.clientId && g.clientSecret && g.refreshToken);
}

export async function getGoogleAccessToken(config) {
  const g = config.google;
  if (!googleConfigured(config)) {
    throw new Error("Google is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env (see docs/google-setup.md).");
  }
  if (cached.token && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refreshToken,
      grant_type: "refresh_token"
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`Google OAuth ${response.status}: ${config.redact(JSON.stringify(json))}`);
  }
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000)
  };
  return cached.token;
}

export async function googleApi(config, baseUrl, endpoint, options = {}) {
  const token = await getGoogleAccessToken(config);
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.raw ? {} : { "content-type": "application/json" })
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (options.raw) {
    if (!response.ok) {
      throw new Error(`Google API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return response.text();
  }
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) {
    throw new Error(`Google API ${response.status}: ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}
