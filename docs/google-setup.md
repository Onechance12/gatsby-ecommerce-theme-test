# Google (Gmail + Drive) setup for the assistant

This gives the assistant its **own** Gmail + Drive access — durable, works
headless and when the bridge is deployed (not dependent on the claude.ai
connector). One-time setup. ~15 minutes.

## What you'll end up with (goes in `.env`, never committed)

```
GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REFRESH_TOKEN=...
GOOGLE_OAUTH_SCOPES=https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/drive.readonly
```

Start with these scopes (read + draft only — no sending, no editing yet):
- `gmail.readonly` — read threads/messages (adjuster comms, scheduling context)
- `gmail.compose` — create **drafts** (LORs) — you still hit send
- `drive.readonly` — read your templates (LOR, TDI, FIN535) and estimates

Add `gmail.send` later, only when you want the assistant to actually send.

## Steps (Google Cloud Console — console.cloud.google.com)

1. **Create/pick a project.** Top bar → project dropdown → New Project → name it
   e.g. "wave-ops-assistant" → Create.

2. **Enable the APIs.** APIs & Services → Library → search and **Enable**:
   - "Gmail API"
   - "Google Drive API"

3. **OAuth consent screen.** APIs & Services → OAuth consent screen:
   - User type: **External** → Create.
   - App name, your support email, developer email → Save.
   - **Test users:** add the Google account whose Gmail/Drive this is
     (e.g. cpearson@wavepa.com). While the app is in "Testing," only listed
     test users can authorize — that's fine, keep it in Testing.

4. **Create OAuth client credentials.** APIs & Services → Credentials →
   Create Credentials → **OAuth client ID**:
   - Application type: **Desktop app** (simplest for the one-time token mint).
   - Create → copy the **Client ID** and **Client Secret**.

5. **Send me the Client ID + Client Secret.** I'll add them to `.env` and run
   the one-time authorization helper (ported from your old bridge's
   `scripts/gmail-oauth.mjs`). It prints a Google URL → you approve in your
   browser (as the test user) → Google returns a code → the helper exchanges it
   for a **refresh token**, which I store in `.env`. After that, the assistant
   refreshes its own access automatically; you don't repeat this.

## Security notes

- The Client Secret and refresh token are credentials — they live only in
  `.env` (git-ignored). Never commit them, never paste into GitHub.
- Refresh token = standing access to that Google account's Gmail/Drive within
  the scopes above. You can revoke anytime at
  myaccount.google.com/permissions.
- Prefer sending the client ID/secret by adding them to `.env` yourself if you
  have shell access; if you're on mobile and paste them to me, rotate/revoke
  later if you ever want to be cautious.
- Which mailbox? Use the account that has your LOR/template files in Drive and
  your adjuster email history — likely cpearson@wavepa.com. If templates live in
  a shared drive under a different account, tell me.

## Which path to use

- **Right now, interactive:** the claude.ai Gmail/Drive connectors (already
  authed) — just enable them for the chat. No setup.
- **Durable / deployed / Retell-integrated:** this Google OAuth setup. Do this
  when you want the assistant self-sufficient.
