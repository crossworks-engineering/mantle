---
title: Notes
toolGroups: [notes]
---

## Notes

Notes are quick markdown notes: the fastest way to get something into the brain.

- Click **New**, give it a title and tags, and write in markdown.
- Save with **Create note** or **Save note**, or press Ctrl/Cmd+S. Esc cancels.
- Search notes or click a tag to filter the list.
- Export a note to Word, or delete it from the list.

Use a note for a phone number, a quote or a quick observation. When it grows into a document, ask the assistant to turn it into a page.

## Assistant

- "Make a note that the pump was cycling every 4 minutes today."
- "Add to the supplier note: two-week lead time."
- "What did I write down about the pump?"

Ask it to add to a note and it appends rather than rewriting. The assistant cannot delete notes.

## Technical

- A note is a node with a title, tags and a markdown body.
- On save it goes through ingest: a summary, extracted facts and entities, then chunks and embeddings for search.
- Tools: `note_create`, `note_update` (with an append mode), `note_list`, `note_get`, `note_from_file`, `note_from_page`.
