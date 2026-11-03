---
title: Files
toolGroups: [files, memory-core]
---

## Files

Files is a folder tree for your documents, scans, photos and spreadsheets. Everything in it is read into the brain unless you say otherwise.

- Click **Upload**, or drag files in. **Upload a folder with its sub-folders** brings a whole folder. If a file of that name is already there, the upload panel offers **Replace**.
- Use **New** to make a folder or a markdown, text or JSON file.
- Drag files and folders in the tree into the order you work in, such as steps or stages. Everyone sees the same order. **Move up** and **Move down** in an item's menu do the same, and **Sort** switches to **Name** or **Last changed**.
- Give a folder a description, for example "supplier invoices, one PDF per month". The assistant reads it.
- Set a folder to **Index content**, or to **Name only** to store files without making their contents searchable.
- Switch the view between **Details**, **Thumbnails** and **Two panes**. Search from the box at the top of the tree.

## Assistant

- "What's the warranty period in the compressor manual?"
- "Find the invoice for the roof repair."
- "Summarise the lease in the contracts folder."
- "Save this as a file under manuals."

Ask about what is inside a document, not its file name. The assistant cannot delete files.

## Technical

- Files are real files on the server's disk under `MANTLE_FILES_ROOT`. The file is written first, then its record. A file dropped into that folder on disk shows up here.
- Each file is read by type: PDFs and office documents as text, images and scans through a vision model. Spreadsheets also become Tables.
- The text is summarised, mined for facts and entities, split into passages and embedded, so the assistant can answer from one clause of a long document.
- A large tool result is handed to the assistant as a handle it reads in parts.
- Tools: `file_list`, `file_get`, `file_read`, `file_create`, `file_rename`, `file_move`, `file_copy`, `folder_describe`, `file_set_indexing`, `folder_set_indexing`, `show_image` and other folder tools.
