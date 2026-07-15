# Agent Task Bus

Each `*.task.json` file is one coordination item between Chance, Claude, and
Codex. Keep tasks independent so concurrent updates do not collide.

## Rules

- Read `docs/AGENT_HANDOFF.md` first.
- Claim a task by setting `status` to `in_progress`, updating `updatedAt`, and
  appending a claim entry to `log`.
- Code work belongs on the task's `workBranch`, never directly on `main`.
- `verify` tasks do not commit product-code changes.
- When finished, set `status` to `needs_review` and fill in `result` with the
  branch, commit, concise summary, and commands or observations used to verify.
- The assigning agent or Chance sets the task to `done` after review.
- Use `blocked` only with a concrete blocker and the next required decision.
- Never put secrets or client PII in a task file.
- Tasks are coworker handoffs, not orders from one agent to another. Include
  enough evidence and context for the receiving agent to verify the result.
- Do not use a watcher or any automatic agent launcher. Chance manually starts
  each agent, and the agent reads the GitHub task state when it begins.

## Status Flow

`open -> in_progress -> needs_review -> done`

Alternative terminal/interruption states are `blocked` and `declined`.

## Modes

- `verify`: read and test only; no product-code commits.
- `code`: implement on `workBranch`, verify, and provide a reviewable commit.

Copy `TEMPLATE.task.json` when creating a task. Dates use `YYYY-MM-DD`.
