---
title: Team Portal
toolGroups: [team-admin]
---

## Team Portal

The front door to the portal your team actually uses. The portal itself lives
outside this app, behind a member's token, so there is no way to reach it, or
even to know it exists, from inside your own session. This screen is that
missing signpost.

The rule that explains everything else: **only a contact can get in, using a
token you mint for them.** There is no sign-up, no password, no invitation
email. The token *is* the credential, it's shown once, and you send it to them
yourself.

The roster shows who holds one. "Never signed in" against a name is worth
noticing; it means the token was minted and never redeemed, which is almost
always the real story behind "the link you sent me doesn't work".

## Assistant

- "Who's on the team portal?"
- "What has anyone asked this week?"

The assistant can read the team surface, the roster, the threads, the access
log, because you hold the admin group. The responder that answers your team is
a different agent with a much smaller grant, and it cannot see this view.

## Technical

Membership is a **role a contact holds**, not a separate account. A live token
row is the role, so there is no user list running in parallel with your
contacts, and deleting the contact revokes access as a side effect rather than
leaving an orphan.

Revocation takes effect mid-session, not at the next sign-in, because every
request re-checks that the membership is still live. That's the property that
makes handing out a token safe: you can take it back and know it's gone.

What a member can reach is the team responder's grant, and the brain is the
trust boundary; they can read broadly and write almost nothing. Their single
write is filing a request into your review queue, stamped with who asked.
Delegation, sending, the terminal and bulk export are all excluded by design;
bulk export specifically because it turns exfiltration into one call.

Your email and journal are a further step in: those tools are granted to the
responder but gated behind a switch that is **off** by default, so they exist
and refuse until you decide otherwise.

Opening the portal from here uses a new tab on purpose. It expects a member
credential rather than your owner session, and it has no app shell to navigate
back from.
