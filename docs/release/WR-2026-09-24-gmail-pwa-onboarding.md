# Jobrolo Gmail onboarding

Chance requested connection setup within the Jobrolo mobile PWA, rather than
landing in the HCN workspace after signing in. This branch is based on deployed
HCN foundation fe25f74; the companion Jobrolo branch has the same name.

## Change

- Fixed Google setup entry accepts an email hint, authenticates the existing
  HCN employee session, and continues through existing mailbox consent.
- Existing PKCE, sealed state, replay checks, session and immutable Google
  subject binding, refresh-grant storage and scopes are unchanged.
- Wrong account, cancellation and expired-state failures return to a fixed
  Jobrolo destination. The short-lived navigation cookie grants no authority.
- Returning is not a success assertion: Jobrolo must recheck its own actor-bound
  live Gmail profile. No provider tokens or identity claims enter the return URL.
- Adapter status explicitly advertises direct-connection support. Deploy this
  backend before the frontend. No migrations, new secrets or OAuth redirect-URI
  changes are required; the current callback is reused.

## Verification and limits

Synthetic tests exercise fresh login → mailbox consent → fixed app return,
wrong account, cancellation, replay, existing scope and isolation controls.
The carrier-email fixture now supplies the Gmail profile response required by
the earlier live-health change; no production readiness check was weakened.
`TMPDIR=/private/tmp npm run check` passed: precheck 201/201, main 795/795,
journey 2/2, management/postcheck 61/61. The canonical temporary directory is
needed for the existing realpath/symlink storage defenses on this Mac.

No paid AI, live Google consent, customer read/write, invitations, credential
changes, merge or deployment performed. The installed iPhone PWA/system-browser
handoff still needs Chance's post-release test with his own consent. Google
unverified-app or Workspace restrictions remain explicit external blockers,
not something this code bypasses.
