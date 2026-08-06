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

Each login also carries the two things that govern access to it: a password you
can reset, and the list of devices currently signed in as it. Signing a device
out ends that session immediately, so a laptop left at an office or a phone
you've replaced can be cut off without touching the password.

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

Look at a login's devices when something feels off, and after any machine leaves
your control. A session you don't recognise is the clearest signal available
that something is wrong, and it's actionable in one click. Reset a password if
it's shared with anything else, or if it's ever been typed somewhere you weren't
sure about. A login guards a brain that holds your mail, your documents and your
secrets, so it deserves a password used nowhere else.

Note what a password does **not** protect. Sealed data is encrypted with the
brain's master key, which is separate. Changing a password doesn't re-encrypt
anything, and losing it doesn't put your secrets at risk.

## Technical

Every login resolves to the same owner, which is what makes the shared-brain
statement literally true rather than a policy: the data has one owner id, and
authentication decides who may act as that owner, not what they may see.

Attribution is carried into the audit trail, so who did what is recoverable even
though what they could reach was identical. That's the entire functional
difference between one login and three.

A password reset issued from here sets a new password directly rather than
sending a recovery mail — there is no external identity provider in the loop, so
account recovery is an owner action, not a self-service flow. Passwords are
stored as a salted hash, never recoverable: a reset sets a new one rather than
revealing the old, because the old one isn't there to reveal.

Bearer sessions are tracked individually rather than as a single stateless
token, so revoking one device leaves the others alone, and each carries enough
context to be recognisable. They're keyed to the login that signed in, which is
why the list is per login rather than per brain. The browser's session cookie
isn't among them — it has no row to revoke, and a password reset plus sign-out
is what governs it.

Removing a login revokes access at the next request. Its existing sessions are
governed by its device list, so delete the login and sign its devices out if
you're cutting someone off in a hurry.

The threat model worth holding in mind: a login is the front door, and the
master key is the safe inside. An attacker with a password gets what that login
sees in the app. An attacker with a copy of the database and no master key gets
your structure and your unsealed content, but no secrets, no API keys and no
mail credentials. That's also why the two must be stored separately — a backup
carrying both is one compromise away from being fully readable.
