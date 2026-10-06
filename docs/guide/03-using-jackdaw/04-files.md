# Files

Upload documents into a folder tree that the brain reads, then ask about what is inside them.

**Files** is a real folder tree on the server's disk. A file you upload here is a normal file on disk, and a file placed in that folder on disk shows up here.

## Upload

1. Open **Files** and pick a folder.
2. Click **Upload** for files, or **Upload folder** to bring a folder with its sub-folders.
3. Or drag files onto the screen.

The web uploader takes files up to 512 MB by default. Files you attach in chat are saved here too (up to 64 MB each).

## What gets read

| File | How it is read |
|---|---|
| Text, markdown, JSON | Read directly. |
| PDF | Text layer read. Scanned pages are run through OCR. |
| Word | Converted to text. |
| Excel, CSV | Read, and also turned into a typed table. |
| Images | Described and OCR'd by the vision worker. |

A password-protected PDF opens if its password is saved in **Settings > PDF passwords**.

## Organise

- **New** makes a folder or a text, markdown or JSON file. Text files edit in place.
- **Rename**, **Move** and **Copy** work on files and folders.
- Give a folder a description. The assistant reads it, so "supplier invoices, one PDF per month" tells it more than a folder name.

## Keep a folder out of search

Some files should be stored but not read, such as a photo archive. Set the folder's indexing to **Name only**. Its files stay findable by name, type and tags, but their contents are not indexed. Set it back to **Index content** to read them again.

## Ask about them

Ask about content, not file names:

- "What is the warranty period in the compressor manual?"
- "Summarise the lease in the contracts folder."
- "Save this as a file under manuals."

The assistant can read and create files. It cannot delete them.

## Check it worked

Ask the assistant a question only the new file can answer. A large file can take a few minutes to be read.

## Next

- [Notes and journal](05-notes-and-journal.md)
- Screen help: [Files](../06-help/files.md)
