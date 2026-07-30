---
title: Security
---

## Security

Your password, and the devices currently signed in.

The devices list is the more useful half. Each entry is a live session, and
signing one out ends it immediately — so a laptop left at an office or a phone
you've replaced can be cut off from here without changing your password.

Changing your password is the blunter instrument: it affects how you sign in
next time, and existing sessions are governed by the device list.

## When to use this

Look at the devices list when something feels off, and after any machine leaves
your control. A session you don't recognise is the clearest signal available
that something is wrong, and it's actionable in one click.

Change your password if it's shared with anything else, or if you've ever typed
it somewhere you weren't sure about. This login guards a brain that holds your
mail, your documents and your secrets — it deserves a password used nowhere
else.

Note what this password does **not** protect. Your sealed data is encrypted with
the brain's master key, which is separate. Changing your password doesn't
re-encrypt anything, and losing it doesn't put your secrets at risk.

## Technical

Passwords are stored as a salted hash, never recoverable — a reset sets a new
one rather than revealing the old, because the old one isn't there to reveal.

Sessions are individually tracked rather than being a single stateless token, so
revoking one device leaves the others alone. Each carries enough context to be
recognisable, which is the point of showing them at all.

The threat model worth holding in mind: this login is the front door, and the
master key is the safe inside. An attacker with your password gets what you see
in the app. An attacker with a copy of the database and no master key gets your
structure and your unsealed content, but no secrets, no API keys and no mail
credentials.

That's also why the two must be stored separately. A backup carrying both is one
compromise away from being fully readable.
