---
title: Docs
toolGroups: [memory-core]
---

## Docs

Docs lets you read markdown documentation and choose which collections the assistant can search. A collection is a folder of `.md` files on the server.

- Browse and read docs from the list on the left.
- Turn a collection's switch on to index it, or off to remove it from the brain. **Enable all** and **Disable all** do every collection at once.
- Click **New collection** to add one: give it a **Label**, a **Key**, a **Root path** and a **Brain depth**.

Brain depth has two settings:

- **Retrieval-only**: the assistant can find and cite the text. Good for reference material you did not write.
- **Full extraction**: facts and entities are pulled out too. Good for your own documentation.

Nothing is indexed until you switch it on. The built-in collections ship switched off.

## Assistant

- "What do the docs say about backups?"
- "Find the section on tool groups."

Answers cite the file and section. If the assistant cannot find something you know is written down, check that its collection is switched on.

## Technical

- Each `.md` file becomes one `documentation` node, split into chunks at headings, so a question returns the matching section.
- A watcher follows enabled folders and re-syncs on change. Unchanged files and sections are skipped.
- Switching a collection off deletes its indexed nodes. The files on disk stay.
- If a collection's folder turns up empty, sync deletes nothing, so an unmounted disk does not wipe the index.
- Tools: `search_chunks`, `read_section`, `search_nodes`.
- More: [Documentation collections](../05-admin/08-doc-collections.md).
