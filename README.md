# JobNimbus ChatGPT Bridge

Small authenticated bridge that lets a ChatGPT Custom GPT Action read and, when explicitly enabled, update JobNimbus.
It also supports Gmail search/thread review and dry-run email drafting/sending when Gmail OAuth credentials are configured.

## Safety

- Keep `JOBNIMBUS_API_KEY` only in Render environment variables.
- Set `JOBNIMBUS_BRIDGE_TOKEN` and use it as the Custom GPT bearer token.
- Leave `BRIDGE_ALLOW_WRITES=false` until you intentionally want approved write actions.
- Write endpoints are dry-run unless the request includes `execute:true` and Render has `BRIDGE_ALLOW_WRITES=true`.
- Gmail draft/send endpoints are also dry-run unless `execute:true` and `BRIDGE_ALLOW_WRITES=true`.

## Render

Start command:

```bash
npm start
```

Health path:

```text
/health
```

Required private env vars:

```text
JOBNIMBUS_API_KEY=
JOBNIMBUS_BRIDGE_TOKEN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

## Gmail OAuth

Create a Google OAuth client with Gmail API enabled, then run:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run gmail:oauth
```

Open the printed URL, approve access, and copy the printed refresh token into Render as `GOOGLE_REFRESH_TOKEN`.
