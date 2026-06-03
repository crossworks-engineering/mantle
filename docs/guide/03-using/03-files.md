# Files

**Files** is a real folder tree of your documents — and it's mirrored to actual
folders and files on disk. Everything you put here is read into the brain, so you
can ask about a document's *contents* later, not just find it by name.

## A folder tree you actually own

Unlike most apps, Mantle's Files aren't locked in a database blob. Each folder and
file exists as a genuine file on the server's disk (under the configured files
root). That means:

- You can `cp`, `vim`, or sync the folder with Syncthing/Nextcloud and it just works.
- Backing up is copying a folder.
- **External edits round-trip** — change a file on disk and Mantle notices and
  re-reads it; upload in the app and it appears on disk. (The two stay paired, with
  disk written first so nothing is ever half-saved.)

In the app you can create folders, upload files (drag-and-drop), browse, and edit
text-based files (markdown, txt, json, yaml) inline.

## Everything gets read into memory

Whatever you drop in is ingested automatically — the universal pipeline handles
each type:

- **Text/markdown** — read directly.
- **PDFs** — text extracted; **scanned PDFs with no text layer are OCR'd** page by
  page; password-protected PDFs unlock via your saved
  [PDF passwords](../04-configuring/06-profile-appearance-security.md).
- **Word / Excel / CSV / PowerPoint** — parsed to text.
- **Images** — described and OCR'd by the vision worker, so a photo of a whiteboard
  or a receipt becomes searchable.

So "drop it in and ask about it later" works for almost any file. (Upload limit is
25 MB per file.)

## A few practical notes

- **Folders can't be renamed** in place (it would have to reshuffle the whole tree
  on disk) — create the folder you want and move files into it.
- The assistant can read and create files too (via its file tools), and files
  attached to a chat or sent over Telegram are saved here automatically.
- Files dropped straight on disk or via the app are indexed the same way — there's
  one indexing path however a file arrives.

## Files vs Pages vs Notes

- **Files** — documents you own as real files (PDFs, spreadsheets, images, your
  own markdown). Best when the file *is* the artifact.
- **[Pages](04-pages-tables-notes-docs.md)** — rich documents you write *inside*
  Mantle, with formatting and structure.
- **Notes** — quick markdown jottings, the fastest way to capture a thought.

All three feed the same brain.
