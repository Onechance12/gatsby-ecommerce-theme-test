console.error([
  "This legacy local OAuth helper is disabled because it accepted a client secret through shell history",
  "and printed a refresh token to the terminal.",
  "",
  "Use the separately approved Google/Render credential-storage runbook. Secrets must be entered only",
  "into the provider secret UI and must never be pasted into a shell, log, chat, repository, or file."
].join("\n"));
process.exitCode = 1;
