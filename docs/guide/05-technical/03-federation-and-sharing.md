# Sharing & federation

Two ways to let content out of your private brain — both **explicit and scoped**, so
nothing leaks by accident.

## Sharing — read-only public links

Any **page, note, task, event, or file** can be turned into a read-only public link
that anyone with the URL can open — no login. Use it to share a write-up, a plan, or
a document.

How it works:

- Toggle sharing on an item to **mint a link**; toggle off to **revoke** it (the URL
  stops working immediately). One active link per item.
- Links are long random tokens, optionally expiring, and the public page is
  presented cleanly with none of your other data exposed — just that one item (and,
  for a shared page, only the images it actually references).
- **Secrets, emails, and contacts can never be shared** — they're excluded by design.

The assistant can share/unshare **pages** on request ("make this page public and
give me the link"), and share URLs use your configured public address. Shared pages
render through a safe server-side renderer (not the live editor), so formatting
survives without exposing anything private.

## Federation — connecting two Mantles

**Federation** lets your Mantle exchange **specific, granted** items with *another
person's* Mantle (e.g. a partner's). It is not multi-user access — each brain stays
sovereign and single-owner; they negotiate at the border.

The model (managed under **Settings → Peers**):

- You register a **peer** and exchange tokens — each side mints a credential for the
  other, sealed/encrypted at rest. Revoking a peer instantly closes both directions.
- Sharing is **explicit, per node or per whole category**: cherry-pick exactly which
  nodes a peer may see, or flip a category switch (Pages, Notes, Files, Contacts,
  Tables, Events, Tasks) to share every item of that type — **including items you
  create later**; a category grant is a standing subscription resolved at query
  time. Secrets are never shareable this way, and email + journal are deliberately
  excluded from category sharing (individual items can still be cherry-picked).
  Both kinds are revoke-don't-delete, so the grant history stays auditable. A
  peer's query only ever returns the intersection of their request and your active
  grants — anything ungranted simply isn't there.
- Every cross-Mantle request is traced like everything else.

So your assistant can, with permission, ask "does Jane's Mantle have her passport
scan?" and get back *only* what Jane explicitly shared — neither side gives up
ownership or visibility of anything else.

## The principle

Both features follow the same rule as the rest of Mantle: **you decide explicitly
what leaves, it's scoped to exactly that, and it's revocable.** Default-private,
share-by-exception. (Deep references: `docs/sharing.md` and `docs/federation.md` in
the repo.)
