# Agent Handoff

Last updated: 2026-07-10

This is the durable status record shared by Claude, Codex, and Chance. Read it
before starting and update it before stopping. Keep client PII out of this file.

Claude and Codex are coworkers who both work for Chance. They share ownership of
the functional end-to-end outcome, help unblock one another, and collaborate
asynchronously through GitHub. Automated agent watchers are not part of this
system and must not be introduced.

## Current State

- Claude operations branch: `claude/jobnimbus-tool-search-cpeh4n` at `999a633`
  (advanced from `41a7a53` by the report-modules repair, pushed via the GitHub
  API because Claude's git proxy is down this session). It contains the local
  assistant, Chance sweep/review tools, JobNimbus actions, Gmail/Drive/Quo
  modules, storm research, LOR packaging, and voice-call tooling.
- Render bridge branch: `jobnimbus-bridge` at `55346ac`. Deployed ChatGPT action
  bridge and OpenAI/Twilio voice path. Separate runtime line from Claude's branch.
- Collaboration scaffold: `codex/agent-collab`, based on Claude's branch.

### ⚠️ Claude has unpushed local commits (git proxy outage)

Claude's session container can reach GitHub via the MCP API but its **git-over-
HTTPS proxy is down**, so ordinary `git push` fails. The report-modules repair
was landed via the GitHub API. Separately, Claude has **4 local commits not yet
on any remote** (they will push when the proxy recovers, or can be re-landed via
API on request):
  1. Audit fixes — wind-CSV `Speed` column, LOR attachment honesty + live
     refresh, duplicate-filing guard, silent-refresh warning, regex escapes.
  2. Post-call writeback (`file:claim` callId mode -> dry-run JobNimbus bundle)
     and `file:pulse` (Gmail+Quo reconciliation with status-change signals).
  3. Gated `update_jobnimbus_note` action (edit a note in place).
  4. `file:pulse` Quo curl-fallback (runs without a local machine) + adjuster-
     number matching + inspection-signal regex.
Codex/Chance: do not assume `claude/...` on GitHub reflects these four yet.

## Claimed / In-Progress Work

- Codex — 2026-07-10 — collaboration scaffold and production-boundary mapping
  — `AGENTS.md`, `CLAUDE.md`, `docs/AGENT_HANDOFF.md`, `agent-tasks/` — in progress.
- Claude — 2026-07-10 — operations assistant + voice/claim workflow. In-session
  scope: `src/voice/retell.js` + `retellCli.js` (the reusable "Mitra" claim-call
  agent + Retell post-call extraction), `src/assistant/fileClaim.js`,
  `postCallWriteback.js`, `filePulse.js`, `claimCallPrompt.js`,
  `carrierDirectory.js`, `lorPackage.js`, `stormResearch.js`, `actionTools.js`;
  docs under `docs/carriers/`, `inspection-capture.md`, `backlog.md`. Most is in
  the 4 unpushed commits above.
- Claude — 2026-07-10 — DONE (needs_review) — restored `src/reports/markdown.js`
  and `src/reports/csv.js` so baseline + fixture commands load — task
  `t-20260710-repair-report-modules`. Commit `999a633` on
  `claude/jobnimbus-tool-search-cpeh4n`.

## Open Questions

1. Which modules from Claude's operations branch should become Render actions,
   and which should remain local-only tools?
2. Should the long-term production service replace `jobnimbus-bridge`, or should
   the existing bridge import a small, reviewed subset of the assistant modules?
3. Which branch and commit is Render currently configured to deploy?
4. What is the smallest read-only end-to-end test that proves the local assistant
   and deployed bridge see the same JobNimbus file state?
5. (Claude) When Claude's git proxy recovers, reconcile: GitHub `claude/...` has
   the API report-modules commit; Claude's local has 4 additional commits +
   its own report-modules commit. Plan: `git fetch` + rebase local onto the
   remote tip (no path overlap beyond src/reports, which will de-dupe).

## Next Coordination Steps

1. Codex reviews `t-20260710-repair-report-modules` (needs_review) and closes it.
2. Review `docs/BRIDGE_INTEGRATION_MAP.md`; agree on the read-only comparison test.
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
- 2026-07-10 — Claude — Reviewed PR #1 (scaffold looks right). Completed
  `t-20260710-repair-report-modules`. ROOT CAUSE was not missing code but a
  `.gitignore` pattern `reports/` (no leading slash) that also shadowed
  `src/reports/`, so the generators were never trackable. Anchored the ignore
  patterns to repo root (`/data/ /reports/ /work/`) and tracked both modules
  (pure formatters, no PII). `npm run check` and `npm run sweep:fixture` now exit
  0. Landed via GitHub API (`999a633`) because Claude's git push proxy is down.
- 2026-07-10 — Claude — Flagged 4 additional unpushed local commits (see Current
  State) so no one assumes GitHub reflects the full session yet.
