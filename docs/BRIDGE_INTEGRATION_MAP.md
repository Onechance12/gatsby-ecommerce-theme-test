# Cloud / Local / Live Integration Map

Verified: 2026-07-10

## The Boundary

The two active branches are separate products with no common Git merge base:

| Surface | Branch | Runtime entry | What it currently owns |
| --- | --- | --- | --- |
| Operations assistant | `claude/jobnimbus-tool-search-cpeh4n` | `src/index.js`, `src/bridge/server.js` | Chance sweep/review packets, claim preparation, workflow logic, storm research, Gmail/Drive/Quo modules, LOR packages, Retell/Twilio tools |
| Deployed ChatGPT bridge | `jobnimbus-bridge` | `src/server.js` | OpenAPI schema, ChatGPT actions, direct JobNimbus endpoints, document extraction, handoff inbox, Gmail actions, calendar/task actions, OpenAI/Twilio realtime calls |

The operations branch's `render.yaml` uses the same Render service name as the
live bridge. Pointing Render at that branch would replace the current API with a
different route surface. That is a migration, not a normal deploy.

## Important Differences

### Operations assistant branch

- Rich business logic and evidence-first Chance workflow.
- Small authenticated bridge exposing `/tools/<name>` and `/actions/<name>`.
- No ChatGPT OpenAPI document.
- No handoff inbox, direct Gmail API routes, transcript routes, or calendar
  update routes on its bridge surface.
- Uses CLI subprocesses so local and hosted behavior can share the same modules.

### Live bridge branch

- Broad API/OpenAPI surface already shaped for ChatGPT Actions.
- Direct JobNimbus, Gmail, document, handoff, task/calendar, and voice routes.
- Business logic is concentrated in one large `src/server.js` file.
- Does not use the richer evidence-review, ledger, workflow-gate, claim-prep,
  or LOR-package modules from the operations branch.

## Recommended Integration Direction

Keep `jobnimbus-bridge` as the production API shell for now. Move reviewed,
read-only operations capabilities into it one at a time behind existing bearer
authentication and write gates. Do not point Render directly at Claude's branch
or attempt a Git merge between the unrelated histories.

The first candidate should be one read-only evidence packet or claim-prep action.
It has immediate operational value, exercises the richer Claude modules, and
cannot alter JobNimbus when implemented correctly.

## Minimal Read-Only End-To-End Test

Use an operator-supplied test query via an environment variable; never commit the
query or its output.

1. With writes disabled, run Claude's bridge locally.
2. Call local `POST /tools/review_file` using the test query.
3. Call live `POST /jobnimbus/review-file` using the same query.
4. Compare only structural facts in a local redacted report: matched record ID,
   current status, owner match, document counts, task counts, and latest-activity
   timestamp.
5. Treat any mismatch as an evidence-source or normalization bug. Do not resolve
   it by writing to JobNimbus.

Success means both surfaces identify the same current file state and the local
assistant adds interpretation without changing the source record.

## Deployment Gate

Before any integration deploy, Chance must approve:

- source branch and target branch;
- exact endpoints added or changed;
- Render service and branch configuration;
- environment-variable additions;
- rollback commit;
- read-only verification query;
- whether any write, email, text, call, or calendar action will be exercised.

No client values, outputs, transcripts, or credentials belong in GitHub tasks,
PR descriptions, CI logs, or this document.

## Baseline Verification Result

From a clean `npm ci` on `codex/agent-collab`:

- dependency audit: passed, zero reported vulnerabilities;
- `src/selftest.js`: passed all fixture assertions;
- `npm run check`: failed while loading the command graph;
- `npm run sweep:fixture`: failed for the same reason;
- blocker: `src/sweep/runSweep.js` and `src/sweep/runChanceSweep.js` import
  `src/reports/markdown.js` and `src/reports/csv.js`, but neither file exists on
  Claude's branch.

This must be repaired before using the operations branch as a deploy candidate.
