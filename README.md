# JobNimbus Operations Assistant

Local operations assistant for JobNimbus claim/job files.

Company operating context lives in the reusable Codex skill:

```text
~/.codex/skills/hcn-wave-ops
```

Use that skill as the playbook for HCN/Wave workflows, communication rules,
claim filing, appraisal handling, approval queues, and safe execution.

Version 1 is designed to be safe while API access and operating rules are still
being confirmed:

- read/review tools by default
- JobNimbus write methods are dry-run unless explicitly executed
- secrets stay in `.env`
- raw data is saved locally
- fixture mode works without admin/API access

This account appears to use JobNimbus `Contact` records with Type `Insurance`
as the main operational file surface, so the assistant reviews both Insurance
contacts and jobs.

## Quick Start Without API Access

Run the fixture sweep:

```bash
npm run sweep:fixture
```

Outputs:

- `reports/jobnimbus-sweep.md`
- `reports/jobnimbus-sweep.csv`
- `data/raw/`
- `data/normalized/`

Useful local checks:

```bash
npm run check
npm run audit
npm run map:fields
```

Review one synced file like an assistant:

```bash
npm run search -- "Josee Jimenez"
npm run review:file -- "Josee Jimenez"
npm run review:file -- "0829457522"
```

`review:file` searches local synced JobNimbus data by client name, claim number,
address, carrier, policy number, status, Thresher phase, or JobNimbus id. It
returns the current phase, bottleneck, risk flags, next three actions, suggested
JobNimbus note, open tasks, payments, documents, and recent timeline.

## Chat-First Tool Layer

This project is intended to power a chat assistant, not a dashboard. The
`chat:tool` command exposes small read-only tools that a chat surface can call
behind the scenes.

List available tools:

```bash
npm run chat:tool -- list
```

Review a file as structured JSON for a chat response:

```bash
npm run chat:tool -- review_file '{"query":"Rosa Sanchez"}'
```

Build a claim-filing/post-filing packet:

```bash
npm run chat:tool -- claim_packet '{"query":"Maribel Munoz"}'
```

Draft a message without sending it:

```bash
npm run chat:tool -- draft_message '{"query":"Rosa Sanchez","audience":"adjuster","purpose":"ask where to send LOR"}'
```

Find action candidates for chat triage:

```bash
npm run chat:tool -- next_actions '{"filter":"ready for appraisal","limit":5}'
```

Safety rule: these tools do not send texts/emails or update JobNimbus. They
return data, drafts, and proposed actions only. Any write/send action should be
confirmed in chat and performed through a separate explicit connector/API call.

## Chance Pearson Approval Queue

For the current workflow, the main command is:

```bash
npm run chance:queue
```

That command runs a fresh JobNimbus sweep first, then only looks at files where
Chance Pearson is an owner. It creates:

```text
reports/chance-approval-queue.json
```

The queue file is not long-term memory. It is the current approval batch created
from the latest sweep. Every time you ask "what needs my approval," this should
be regenerated from live JobNimbus data before analysis.

Build evidence packets for the actual review step:

```bash
npm run chance:review-packets
npm run chance:review-packets -- '{"query":"2696","limit":1}'
```

This creates:

```text
reports/chance-review-packets.json
reports/chance-review-packets.md
```

These packets gather the current JobNimbus facts, recent notes/activity, open
tasks, document metadata, payments, appointment-access signals, and possible
contradictions. They are evidence for the assistant to review, not automatic
approval decisions.

For local debugging only, skip the live refresh:

```bash
npm run chance:queue -- '{"refresh":false}'
```

List the Chance-specific specialist agents:

```bash
npm run chance:agents
```

The queue is built around this chat flow:

```text
User: show me what I need to approve
Assistant: here is everything I need approval to do to move files forward
User: approve
Assistant: execute the approved JobNimbus updates, then send approved Quo/Gmail items through the connected chat tools
```

Dry-run selected approvals:

```bash
npm run chance:approve -- '{"ids":["chance-001","chance-002"]}'
```

Execute the JobNimbus pieces of selected approvals:

```bash
ALLOW_JOBNIMBUS_WRITES=true npm run chance:approve -- '{"ids":["chance-001","chance-002"],"execute":true}'
```

Each approval item includes:

- file name, status, address, carrier, claim number, policy number, and DOL
- primary specialist agent that reviewed it
- why it needs action
- what action needs approval
- whether it is executable locally
- proposed primary JobNimbus task/note/update or Quo/Gmail draft
- supporting cleanup actions, such as overdue task cleanup or missing adjuster info

Important: `chance:approve` can execute local JobNimbus task creation. Quo texts
and Gmail emails still require connected chat-tool approval because those are not
local repo shell actions.

## Gated JobNimbus Action Layer

The `chat:action` command adds the execution primitives a chat assistant needs
to actually move files forward in JobNimbus. It is dry-run by default.

List available actions:

```bash
npm run chat:action -- list
```

Dry-run a JobNimbus note:

```bash
npm run chat:action -- create_jobnimbus_note '{"query":"Rosa Sanchez","note":"Claim filed. Awaiting adjuster contact."}'
```

Dry-run a follow-up task:

```bash
npm run chat:action -- create_jobnimbus_task '{"query":"Rosa Sanchez","title":"Follow up with adjuster for inspection scheduling","dueDate":"2026-07-03"}'
```

Dry-run a contact/file field update:

```bash
npm run chat:action -- update_jobnimbus_contact '{"query":"Rosa Sanchez","fields":{"Claim #":"24085354"}}'
```

To actually write to JobNimbus, both safeguards must be present:

```bash
ALLOW_JOBNIMBUS_WRITES=true npm run chat:action -- create_jobnimbus_note '{"query":"Rosa Sanchez","note":"Claim filed. Awaiting adjuster contact.","execute":true}'
```

This layer currently supports:

- create JobNimbus note
- create JobNimbus task
- update exact JobNimbus contact/file fields

Quo texts and Gmail sends are not local shell commands in this repo. Those
should be handled through their connected chat connectors with explicit approval.

## Live API Setup Later

Once you have JobNimbus admin/API access:

```bash
cp .env.example .env
```

Then edit `.env`:

```bash
JOBNIMBUS_USE_FIXTURES=false
JOBNIMBUS_API_BASE_URL=https://app.jobnimbus.com/api1
JOBNIMBUS_API_KEY=...
JOBNIMBUS_AUTH_SCHEME=Bearer
ALLOW_JOBNIMBUS_WRITES=false
JOBNIMBUS_PAGE_SIZE=1000
JOBNIMBUS_MAX_OFFSET=10000
```

Run a read-only probe:

```bash
npm run probe
```

The probe must show visible contacts or jobs before running the live sweep. If
JobNimbus accepts the key but returns zero contacts and zero jobs, the key is
valid but its selected access profile cannot see operational records.

For this Home Claim Network / Wave Public Adjusting setup, the API key needs a
JobNimbus access profile with read access to:

- contacts, especially the `Insurance` contact workflow
- jobs
- tasks
- activities/notes
- files/documents
- payments
- account settings and users metadata

The current account metadata shows the main operational workflow is the
`Insurance` contact workflow, with statuses such as `Ready for Appraisal` and
`Submitted for Appraisal`. The assistant is built around that file model.

Then run the focused Chance Pearson sweep for normal file work:

```bash
npm run chance:sweep
```

That command reads all contacts only to identify Chance ownership, then fetches
related tasks, activity, files, and payments per Chance file using
`related=<contact_jnid>`. It writes scoped outputs under `data/raw/chance`,
`data/normalized/chance-*.json`, and `reports/chance-sweep.*`.

For documents, the Chance sweep keeps operational file records only: PDFs,
ESX/ZIP estimate files, and office-style document content types. It does not
store JPEG/PNG job-site photo records in `data/raw/chance/documents.json`;
photo/image counts are recorded in `data/raw/chance/sync-meta.json`.

Run the company-wide sweep only for audits:

```bash
npm run sweep
```

Check whether the live JobNimbus API allows high-offset reads before trusting a
bulk sweep:

```bash
npm run pagination:audit
```

## Docker Notes For This Mac

The normal shell `docker` command may point at another app/volume on this machine.
This project does not change global shell paths.

Docker Desktop's app-bundled binaries observed during setup:

```bash
/Applications/Docker.app/Contents/Resources/bin/docker
/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose
```

When the global Docker CLI is healthy, the target command is:

```bash
docker compose run --rm jobnimbus npm run sweep
```

Until then, local `npm run sweep:fixture` is enough to develop and verify the assistant.

## Current Endpoint Assumptions

The JobNimbus public Postman documentation confirms:

- Base URL: `https://app.jobnimbus.com/api1/`
- Auth header: `Authorization: Bearer <token>`
- API keys are created in JobNimbus settings under API
- Common pagination params: `size` and `from`
- Some large endpoints reject pages where `from + size > 10000`; the local
  client treats that as a result-window cap, stops there, and records the
  endpoint as partial in `data/raw/sync-meta.json` instead of failing silently.
- Common list response shape: `count` plus resource arrays such as `results`, `activity`, or `files`

The default endpoint paths in `.env.example` are now aligned to that documentation:

- contacts
- jobs
- tasks
- activities
- documents/files
- payments
- account settings
- account users

The probe and sweep client only make `GET` requests. The action layer can
`POST` notes/tasks and `PUT` contact fields only when explicitly executed.

Reference: [JobNimbus Public API Postman docs](https://documenter.getpostman.com/view/3919598/S11PpG4x)
