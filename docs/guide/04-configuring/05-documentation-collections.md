# Documentation collections

Mantle can index folders of **markdown documentation** into the brain, so the
assistant can answer "how does this work?" by citing real docs — and so you can read
them in-app under **Docs**. This very User Guide is one such collection. You manage
them under **Settings → Documentation**.

## What a collection is

A **collection** is a folder of `.md` files on disk that Mantle syncs into the brain
as read-only documentation. Two built-in ideas:

- **Opt-in.** Nothing is indexed until you enable a collection. Enabling it syncs
  the folder now and tracks it; disabling removes its indexed docs from the brain
  (the files on disk are untouched).
- **One-way, disk → brain.** Docs are authored as files (in git, in an editor,
  synced from elsewhere) and *read* in Mantle. The **Docs** viewer is read-only —
  you don't edit docs inside Mantle (that's what [Pages](../03-using/04-pages-tables-notes-docs.md)
  are for).

There's a built-in **System docs** collection (Mantle's own deep developer
documentation) that ships **disabled** — it's infrastructure-level material, off by
default. The **User Guide** you're reading is its own collection.

## Brain depth: retrieval vs full

When you enable a collection you choose how deep it goes into memory:

- **Retrieval-only** (default) — the docs are summarised and made searchable so the
  assistant can find and cite them, but they **don't** add facts or entities to your
  personal knowledge graph. Right for reference material (you don't want "the docs
  say X" polluting facts about *your life*).
- **Full** — the complete pipeline, including facts and graph. Use this only if a
  collection really is part of your personal knowledge.

## Adding your own collection

Click **New collection** on the Documentation page and fill in:

- **Label** — the display name (e.g. "Work Handbook").
- **Key** — a short unique slug.
- **Root path** — the folder of markdown to index. Two flavours:
  - A **relative** path (e.g. `guide`) resolves *under Mantle's docs root* and
    travels with the install — best for docs shipped alongside Mantle.
  - An **absolute** path (e.g. your Obsidian vault) points at any folder on the
    server — best for your own external docs.
- **Brain depth** — retrieval or full (above).

It's created enabled and synced immediately, then appears in **Docs**. A guard stops
you from creating a collection whose folder overlaps another's, so docs can't get
double-indexed. (Heads-up: the built-in *System docs* covers the entire docs folder,
so don't enable it alongside a child collection that lives inside that folder.)

## Keeping a collection current

When the markdown files change, the collection re-syncs — only changed files are
re-read, so it's cheap. If you've just edited or added files and want to force a
refresh, toggle the collection off and on, which re-indexes it.

## Why this matters

This is the feature that lets the assistant explain *Mantle itself* (and any other
documentation you add) accurately and with citations — instead of guessing. Point it
at a product manual, an internal handbook, or your own notes-as-docs, and the brain
gains a body of reference knowledge it can quote.
