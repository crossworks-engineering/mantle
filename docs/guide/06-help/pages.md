---
title: Pages
toolGroups: [pages-draft, pages, page-share]
---

## Pages

Pages are rich documents for writing you would hand to someone: a proposal, a
runbook, meeting notes, a spec. They hold headings, tables, columns, to-do
lists, callouts and diagrams.

- **New page** creates one, in a folder or at the top level.
- Edits are saved as a **draft**. Readers keep seeing the last committed
  version until you press **Commit**.
- **Revert** throws the whole draft away and goes back to the last commit.
- **Access** sets who can see the page: Admin, Team, Client or Public. Public
  gives a read-only link anyone can open.

## Assistant

- "Write this up as a page called Site Handover."
- "Add a section at the end about the generator service."
- "What did the handover page say about the pump?"
- "Make the handover page public and give me the link."

The assistant's edits land in the draft too. Look at them, then commit, or ask
it to commit or discard the draft for you.

## Technical

A page's body is a JSON document stored on the page row, with the draft in a
separate column until you commit. Everything a page holds can be written as
markdown, so the assistant can write a page as plain text. The committed text
is chunked and embedded, so passages turn up in search and in the assistant's
answers.

The assistant works through `page_create`, `page_update_draft`,
`page_commit`, `page_discard_draft` and block tools such as
`page_block_update`, which change one block without rewriting the page.
Sharing uses `page_share` and `page_unshare`. Deleting a page or overwriting
the live version is kept to the Pages specialist.
