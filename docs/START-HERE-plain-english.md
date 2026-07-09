# Start Here — what this thing is, in plain English

No jargon. This is for Chance.

## What we built

A helper that sits behind your JobNimbus and does the boring back-office work so
you can be the hands, feet, and eyes in the field. You tell it a client's name,
it looks at everything (JobNimbus + your emails + your Quo texts/calls) and tells
you exactly what that file needs and what to do next — then it can write the
emails and letters for you.

Think of it as a really fast assistant who never forgets, reads every file, and
already knows how you and Richard like things done.

## The tools you have (what each one actually does)

- **Sweep** — "Show me all my files and what each one needs."
  Pulls all 53 of your files and gives back a short list: who's stuck, who's
  waiting, who needs a letter, who's missing info. (Command: `chance:sweep` then
  `chance:brief`.)

- **File look-up** — "Tell me everything about ONE client."
  Everything on one file — status, adjuster, what's missing, next move.
  (Command: `review:file -- "Name"`.)

- **LOR Package** — "Make the letter, grab the docs, write the email — for this client."
  This is the big one. For any file it: writes the Letter of Representation on
  your letterhead, pulls the signed TDI out of JobNimbus, and drafts the carrier
  email (claim # in the subject, your exact wording). Right now it hands you the
  files to attach; once we do the 3 o'clock setup, it puts the whole email —
  attachments and all — in your Gmail drafts so you just hit Send.
  (Command: `lor-package -- '{"query":"Adelle"}'`.)

- **Quo** — "What have we actually said to this person?"
  Reads your texts and call logs (and transcripts of recorded calls) across your
  whole team's phone lines. This is how I know what's really been communicated.
  (Command: `quo -- history '{"phone":"..."}'`.)

- **Gmail + Drive** — reads your adjuster emails and your template documents so
  everything I write sounds like you, not a robot.

## What I do vs. what you do

- **I do:** read every file, spot what's missing, draft letters/emails/notes,
  pull documents, tell you the one next action per file. I never send or change
  anything in JobNimbus without you saying "go."
- **You do:** the field work, the signatures, and the final "send it." You're
  the boss; I'm the back office.

## The safety rule (always on)

Nothing goes out and nothing changes in JobNimbus unless you approve that exact
thing. Emails are drafts. Texts are shown to you first. That's on purpose.

## What's still turned OFF (needs the 3 o'clock setup)

See `docs/3PM-checklist.md`. Two things, both quick, both need you at the
MacBook once:
1. **Google login** — so I can attach files and finish your emails for you.
2. **Retell** (optional, later) — the robot that calls insurance companies and
   presses the phone-menu buttons to file claims.

That's it. Everything else already works.
