---
title: Peers
toolGroups: [federation]
---

## Peers

Other people's Mantles, and exactly what each of them may read from yours.

This is **not** multi-user access to your brain. Each Mantle stays a separate,
sovereign brain with one owner; peering lets two of them ask each other
questions at the border. Your partner's Mantle can ask yours "do you hold the
passports?" and yours answers only from what you've explicitly shared with that
peer.

Sharing is per peer and always explicit. A new peer starts able to see nothing.

## Assistant

- "Does her Mantle have the insurance renewal date?"
- "Ask my accountant's brain for the last filing."

Answers come back attributed to the peer they came from, and they reflect that
peer's data as it is now rather than a copy you took earlier. If a peer removes
a grant, the next question returns nothing; there's no local cache to go stale.

## Technical

Every relationship has **two tokens, one per direction**. The token they issued
you is replayed when you call them; the one you issued them is what they present
to you. Both are sealed with the brain's master key, bound to their row, and
either side can rotate independently, so revoking your access to them and their
access to you are genuinely separate acts.

Grants come in two shapes. A **node** grant shares one specific thing. A
**category** grant is a standing subscription resolved at query time, enable
Pages for a peer and every page becomes readable, including ones you create
later. The second is powerful and worth being deliberate about, because its
scope grows without you revisiting this screen.

Within a granted scope, queries are auto-answered rather than prompting you.
That's what makes federation useful in practice, and it's why the grant list is
the whole security boundary. Every cross-Mantle read is written to the trace log,
so what a peer actually asked for is auditable after the fact.

Deleting a peer revokes both directions at once.
