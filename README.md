# JobNimbus ChatGPT Bridge

Small authenticated bridge that lets a ChatGPT Custom GPT Action read and, when explicitly enabled, update JobNimbus.
It also supports Gmail search/thread review and dry-run email drafting/sending when Gmail OAuth credentials are configured.
It includes a handoff inbox so another ChatGPT chat with Gmail/Quo access can pass findings into this JobNimbus bridge.

## Safety

- Keep `JOBNIMBUS_API_KEY` only in Render environment variables.
- Set `JOBNIMBUS_BRIDGE_TOKEN` and use it as the Custom GPT bearer token.
- Leave `BRIDGE_ALLOW_WRITES=false` until you intentionally want approved write actions.
- Write endpoints are dry-run unless the request includes `execute:true` and Render has `BRIDGE_ALLOW_WRITES=true`.
- Gmail draft/send endpoints are also dry-run unless `execute:true` and `BRIDGE_ALLOW_WRITES=true`.
- The handoff inbox requires the bridge bearer token for create/list/complete actions.

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

Optional env vars:

```text
HANDOFF_STORE_PATH=/tmp/jobnimbus-chatgpt-handoffs.json
```

## Handoff Inbox

Human paste-in page:

```text
/handoff
```

Action/API endpoints:

```text
POST /handoff
POST /handoff/pending
POST /handoff/complete
```

Use this when a separate ChatGPT chat has Gmail/Quo context and needs to pass structured findings to the JobNimbus assistant. The bridge stores handoffs in a small JSON file, intended as a lightweight queue rather than permanent records.

## Gmail OAuth

Create a Google OAuth client with Gmail API enabled, then run:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run gmail:oauth
```

Open the printed URL, approve access, and copy the printed refresh token into Render as `GOOGLE_REFRESH_TOKEN`.
