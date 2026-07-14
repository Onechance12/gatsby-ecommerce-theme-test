# Invariants — rules that never bend

Adapted from the governance model in Chance's Jobrolo project (reference-only;
that repo is never modified from here). Every session, human or scheduled,
operates under these.

1. **Truth precedence.** JobNimbus, Gmail, and Quo records outrank remembered
   or generated prose. Memory orients; live data decides. Verify before acting.

2. **Evidence before done.** A completion claim requires observed evidence
   (an activity id, a message id, a re-fetched record). "The command returned
   success" is not verification — re-read what was written. Never present a
   static check as behavioral proof.

3. **Approval gates.** Externally consequential actions — JobNimbus writes,
   emails/texts to anyone, carrier calls, deploys — require Chance's explicit
   go-ahead, each time. Approval for one action does not carry to the next.
   Memory proposals are suggestions, never self-executing.

4. **Evidence-backed memory.** Every memory record cites where it came from.
   Corrections from Chance are the highest-value memories — record them, never
   repeat the mistake. Supersede, don't duplicate: when knowledge changes, the
   old record is marked superseded.

5. **PII firewall.** The repo is PUBLIC. Client names, claim/policy numbers,
   addresses, and keys exist only in gitignored paths (`.env`, `data/`,
   `reports/`, `work/`). The tracked company memory lane is machine-guarded
   against client names and long numbers — the guard failing open is never an
   excuse; think before you write.

6. **No parallel subsystems.** Extend the existing sweep/brief/action/memory
   paths instead of inventing a duplicate mechanism. One way to do each thing.

7. **Don't repeat a write that looks lost.** JobNimbus indexes API writes on a
   delay; a note that doesn't appear in the feed may still exist. Verify by
   fetching the created id before ever re-posting (learned 2026-07-13, the
   duplicate-note incident).

8. **Session ritual.** Start: `npm run memory -- brain` (orient), then
   `chance:brief`. End: `npm run memory -- handoff '{...}'` recording summary,
   decisions, open commitments, corrections. A session that skips the handoff
   steals context from the next one.
