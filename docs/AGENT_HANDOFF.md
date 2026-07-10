# Agent Handoff

Last updated: 2026-07-10

This is the durable status record shared by Claude, Codex, and Chance. Read it
before starting and update it before stopping. Keep client PII out of this file.

Claude and Codex are coworkers who both work for Chance. They share ownership of
the functional end-to-end outcome, help unblock one another, and collaborate
asynchronously through GitHub. Automated agent watchers are not part of this
system and must not be introduced.

## Current State

- Claude operations branch: `claude/jobnimbus-tool-search-cpeh4n` at `41a7a53`.
  It contains the larger local assistant, Chance sweep/review tools, JobNimbus
  actions, Gmail/Drive/Quo modules, storm research, LOR packaging, and voice-call
  tooling.
- Render bridge branch: `jobnimbus-bridge` at `55346ac`. It contains the
  currently deployed ChatGPT action bridge and OpenAI/Twilio voice path.
- The two branches are separate runtime lines. A feature existing on Claude's
  branch does not mean the Render bridge exposes or deploys it.
- Collaboration scaffold: `codex/agent-collab`, based on Claude's branch. It
  adds shared orientation, handoff, and task-bus files only.

## Claimed / In-Progress Work

- Codex — 2026-07-10 — collaboration scaffold and production-boundary mapping
  — `AGENTS.md`, `CLAUDE.md`, `docs/AGENT_HANDOFF.md`, `agent-tasks/` — in progress.
- Claude — 2026-07-10 — operations assistant and voice/claim workflow changes
  — `src/assistant/`, `src/voice/`, operational docs — active branch observed;
  exact current in-session scope must be added by Claude.
- Claude — unclaimed task — restore missing `src/reports/markdown.js` and
  `src/reports/csv.js` so baseline and fixture commands load successfully — see
  `agent-tasks/t-20260710-repair-report-modules.task.json`.

## Open Questions

1. Which modules from Claude's operations branch should become Render actions,
   and which should remain local-only tools?
2. Should the long-term production service replace `jobnimbus-bridge`, or should
   the existing bridge import a small, reviewed subset of the assistant modules?
3. Which branch and commit is Render currently configured to deploy?
4. What is the smallest read-only end-to-end test that proves the local assistant
   and deployed bridge see the same JobNimbus file state?

## Next Coordination Steps

1. Claude reviews the collaboration scaffold and records its current claimed
   scope in this file.
2. Review `docs/BRIDGE_INTEGRATION_MAP.md`; Codex confirmed the branches have no
   common merge base and documented a read-only comparison test.
3. Both agents agree on one small integration task and review it through a PR.
4. Chance approves any deployment, environment-variable change, or live write.

## Log

- 2026-07-10 — Chance/Codex — Clarified the coworker model: Claude and Codex
  both work for Chance, share responsibility for the complete result, help each
  other across access boundaries, and use only manual GitHub collaboration.
- 2026-07-10 — Codex — Fetched remote branch state and confirmed Claude's
  assistant and the Render bridge are separate development lines.
- 2026-07-10 — Codex — Added a manual git-native collaboration scaffold. The
  autonomous watcher is intentionally deferred until manual claims and handoffs
  have been proven reliable.
- 2026-07-10 — Codex — Mapped the live/local boundary. Recommended preserving
  the existing production API shell and porting one reviewed read-only capability
  at a time rather than replacing the Render service or merging unrelated trees.
- 2026-07-10 — Codex — Ran a clean dependency install. The self-test passed, but
  `npm run check` and `npm run sweep:fixture` both failed because the sweep
  runners import two report modules absent from Claude's branch. Assigned the
  repair to Claude through the task bus.
