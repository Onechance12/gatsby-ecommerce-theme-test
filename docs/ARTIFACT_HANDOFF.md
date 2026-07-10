# Claude / Codex Artifact Handoff

Use this only when normal Git push is unavailable. Git remains the preferred
transport and the final source of truth. The artifact mailbox is manual file
transport, not a watcher, executor, deployer, or source-code repository.

## Claude Upload Process

1. Finish and commit the local work.
2. Record the exact base commit and run fixture-safe verification.
3. Create one UTF-8 patch:

   ```bash
   git format-patch --stdout <base-sha>..HEAD > claude-codex-handoff.patch
   shasum -a 256 claude-codex-handoff.patch
   ```

4. Confirm the patch excludes `.env`, credentials, client data, transcripts,
   `data/`, `reports/`, and `work/`.
5. Split the text into manageable chunks and upload chunk zero first to:

   ```text
   POST https://jobnimbus-chatgpt-bridge.onrender.com/artifacts/chunk
   Authorization: Bearer $JOBNIMBUS_BRIDGE_TOKEN
   Content-Type: application/json
   ```

6. Chunk zero includes `filename`, `source`, `baseCommit`, `summary`, `sha256`,
   `index`, `total`, and `chunk`. Later chunks reuse `uploadId` and include
   `index`, `total`, and `chunk`.
7. Record the final `artifact.id`, base commit, SHA-256, changed-file summary,
   and test results in the collaboration task or give them to Chance. Never put
   the bearer token in GitHub, chat output, a task, or the patch.

If `JOBNIMBUS_BRIDGE_TOKEN` is unavailable, stop and report the missing
configuration. Do not ask for the token in a public GitHub comment.

## Codex Review Process

1. Retrieve the artifact with authenticated `POST /artifacts/get`.
2. Recompute SHA-256 and compare it with the artifact metadata and Claude's
   handoff.
3. Inspect paths and scan for secrets and client PII.
4. Create an isolated worktree at the declared base commit.
5. Run `git apply --check` before applying anything.
6. Apply and review the patch, then run the relevant checks.
7. Present findings and publication/deployment scope to Chance.
8. Commit, push, merge, or deploy only after Chance approves that action.
9. Mark the artifact complete with a PII-free result.

## Bridge Guarantees

- Only `.patch` and `.diff` text is accepted.
- Bearer authentication is mandatory and fails closed.
- SHA-256 is required and verified on upload and retrieval.
- Default limit is 5 MiB and default expiration is 72 hours.
- Protected runtime/secret paths and common token/private-key material are
  rejected.
- Uploading never applies, executes, commits, pushes, deploys, or writes to a
  client system.
- Default Render storage is ephemeral. Claude retains its local commits and
  patch until Codex confirms receipt.
