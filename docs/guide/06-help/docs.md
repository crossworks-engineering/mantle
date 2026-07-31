---
title: Docs
toolGroups: [memory-core]
---

## Docs

Markdown files on disk, readable here and — once you enable them — searchable by
the assistant. The sidebar browses; this pane is where you decide what gets
indexed.

The thing to understand is that **nothing indexes until you switch it on**. A
collection is a directory of markdown somewhere on the machine, and it sits
inert until enabled. The system documentation ships **disabled** on purpose: it
describes how Mantle works, and most people don't want that mixed into their
personal corpus by default.

Each collection also has a depth. **Retrieval-only** means the assistant can
find and cite the text but nothing is extracted into your facts and entities.
**Full extraction** runs the complete pipeline, so the docs feed the knowledge
graph like any other content. Retrieval-only is right for reference material
you didn't write; full is right for your own documentation.

## Assistant

- "What do the docs say about backups?"
- "How does the memory architecture work?"
- "Find me the section on tool groups."

Answers come back with a citation to the file and section, which is the reason
to keep documentation here rather than paste it into a note. Retrieval works at
**section** level rather than whole-file, so a question about one heading in a
long document returns that heading instead of the whole thing.

If the assistant can't find something you know is written down, the first thing
to check is whether its collection is enabled on this screen.

## Technical

One node per `.md` file, with the markdown stored on the node and identity taken
from the collection plus the file's relative path. Sub-document retrieval comes
from content chunks split on headings.

Re-indexing is cheap by construction. A file-level content hash skips unchanged
files entirely, and the chunk-level embedding cache makes unchanged sections
free even when a file did change — so editing one paragraph in a long document
costs one paragraph's worth of work, not the document's.

A background watcher follows the enabled collections' directories and re-syncs
on change; it refreshes which collections are enabled every minute, so toggling
one here takes effect without a restart. Enabling also reconciles immediately,
which is why a newly enabled collection is searchable straight away.

Two guards worth knowing. **Disabling a collection purges its indexed nodes** —
that's why it asks first. And if a collection's directory turns up empty,
reconcile skips rather than deleting everything, so an unmounted disk doesn't
silently wipe the index.
