import { createServer } from "node:http";

const clientId = process.env.GOOGLE_CLIENT_ID || "";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const port = Number(process.env.GMAIL_OAUTH_PORT || 8788);
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send"
];

if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before running npm run gmail:oauth.");
  process.exit(1);
}

const state = Math.random().toString(36).slice(2);
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", scopes.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400);
      res.end("State mismatch.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end(`Missing code: ${url.searchParams.get("error") || "unknown error"}`);
      return;
    }
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });
    const tokenJson = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenJson.refresh_token) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Token exchange failed:\n${JSON.stringify(tokenJson, null, 2)}`);
      console.error(JSON.stringify(tokenJson, null, 2));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Gmail refresh token created. You can close this tab and copy the token from the terminal.");
    console.log("\nGOOGLE_REFRESH_TOKEN=");
    console.log(tokenJson.refresh_token);
    console.log("\nAdd that value to Render as GOOGLE_REFRESH_TOKEN.");
    server.close();
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.message);
    console.error(error);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`OAuth callback listening on ${redirectUri}`);
  console.log("\nOpen this URL in Chrome, approve Gmail access, then return here:\n");
  console.log(authUrl.toString());
});
