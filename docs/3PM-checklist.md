# Your 3 o'clock MacBook checklist

Everything is already built and waiting. These are the only things I can't do
myself — they need you clicking around once. Do them in order. Total: ~15 min.

Come back to our chat when each is done and I'll take it from there.

---

## ☐ STEP 1 — Get the project onto your MacBook (5 min, one time)

All the code lives on GitHub. To run it on your Mac, open the **Terminal** app
and paste these one at a time (hit Enter after each):

```
cd ~/Desktop
git clone https://github.com/Onechance12/gatsby-ecommerce-theme-test.git jobnimbus-assistant
cd jobnimbus-assistant
git checkout claude/jobnimbus-tool-search-cpeh4n
npm install
```

If it asks you to install Node first, tell me and I'll give you the one-liner.

Then make your secrets file:
```
cp .env.example .env
```
Open that `.env` file (`open -e .env`) and paste in your keys where they're
blank. Tell me if you want me to hand you the exact lines to paste — I have all
the values except the Google ones (Step 2).

---

## ☐ STEP 2 — Google login (10 min, one time) → THE BIG UNLOCK

This is what lets me **attach the LOR + TDI and finish your emails** so you just
hit Send from your phone. Without it, you attach files yourself.

Go to **console.cloud.google.com** (sign in as cpearson@wavepa.com):

1. Top bar → project dropdown → **New Project** → name it `wave-assistant` → Create.
2. Left menu → **APIs & Services → Library**. Search **"Gmail API"** → click it →
   **Enable**. Then search **"Google Drive API"** → **Enable**.
3. Left menu → **APIs & Services → OAuth consent screen** → choose **External** →
   fill your name/email → Save. Under **Test users**, add `cpearson@wavepa.com`.
4. Left menu → **APIs & Services → Credentials** → **Create Credentials** →
   **OAuth client ID** → type **Desktop app** → Create.
5. A box pops up with a **Client ID** and **Client secret**. Copy both and paste
   them to me in chat. I'll finish the rest (I generate the login token and drop
   it in your `.env`).

That's the whole thing. After this, `lor-package` puts the finished email —
attachments and all — straight into your Gmail drafts.

**What this does in plain English:** gives me permission to read your email and
create drafts on your behalf (read + draft only — no sending, no deleting). You
can turn it off anytime at myaccount.google.com/permissions.

---

## ☐ STEP 3 — Retell (optional, do later) → the robot that calls carriers

You already have a Retell account. This is the piece that calls insurance
companies and actually presses the phone-menu buttons ("press 1 for claims") to
file claims — the thing your OpenAI setup couldn't do.

When you're ready: log into Retell, and tell me. I'll give you the exact agent
instructions to paste in and we'll do one test call together. Not needed for the
LOR work — that all runs without it.

---

## What you do NOT need to do

- You don't need to understand the code. That's my job.
- You don't need to touch anything except the steps above.
- You don't need to do Step 3 today.

When you finish Step 1 and Step 2, just say "done" and paste me the two Google
values. I'll test the full Adelle send end-to-end so you can watch it work.
