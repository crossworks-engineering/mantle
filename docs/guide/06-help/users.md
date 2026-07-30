---
title: Logins
---

## Logins

Ways **into** this brain — not separate users with separate data.

This is the distinction the screen exists to make. Every login here sees the
same brain: the same mail, the same notes, the same secrets. Adding one doesn't
create a second workspace, a private area, or a permission tier. It creates
another key to the same door.

What a second login *does* give you is a distinguishable trail. Actions are
attributed, so the audit log can tell one person's activity from another's.

## When to use this

Add a login when someone else genuinely needs full access — a partner, a
business co-owner — and you want their activity separable from yours.

Do **not** add one to give someone limited access. There is no limited access
here. If what you want is "they can ask questions but not change anything",
that's the team surface, where a token grants a read-only responder rather than
the run of the brain.

If two people need genuinely separate data, that's two brains. The single-owner
boundary is the design, and working around it on this screen doesn't produce
isolation — it produces the illusion of it.

## Technical

Every login resolves to the same owner, which is what makes the shared-brain
statement literally true rather than a policy: the data has one owner id, and
authentication decides who may act as that owner, not what they may see.

Attribution is carried into the audit trail, so who did what is recoverable even
though what they could reach was identical. That's the entire functional
difference between one login and three.

A password reset issued from here sets a new password directly rather than
sending a recovery mail — there is no external identity provider in the loop, so
account recovery is an owner action, not a self-service flow.

Removing a login revokes access at the next request. Its existing sessions are
governed by the device list on the Security screen; delete the login and sign
its devices out if you're cutting someone off in a hurry.
