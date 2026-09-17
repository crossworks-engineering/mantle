---
title: Files
toolGroups: [files, memory-core]
---

## Files

A real folder tree of your documents, contracts, invoices, photos, manuals,
spreadsheets, and everything in it is read into the brain.

The tree is **mirrored to actual folders on disk** on the server. A file you
upload here exists as a genuine file; a file dropped on disk turns up here.
That matters more than it sounds: your documents aren't locked inside an app
database, and anything you already have on that machine can be brought in by
moving it, not by importing it.

Folders are yours to organise. A folder can carry a description, which the
assistant reads, so "invoices from suppliers, one PDF per month" tells it
something a folder name can't.

## Assistant

- "What's the warranty period in the compressor manual?"
- "Find the invoice where we paid for the roof repair."
- "Summarise the lease agreement in the contracts folder."
- "Save this as a file under manuals/."

Ask about *content*, not filenames; the useful question is "what did we agree
about penalties?", not "open contract-v3-final.pdf". Retrieval works on the text
inside the documents, so a half-remembered phrase is usually enough to find the
right one.

Scanned documents and photographs work too: images and PDFs are read on the way
in, so a photographed page of handwriting is searchable text afterwards.

Deleting files is not something the assistant can do.

## Technical

Disk is the source of truth, and it's written **first**: the database row
follows, so a file is never half-saved with a record pointing at nothing. A
watcher notices external changes and re-reads them, which is what makes the
round-trip work in both directions.

On ingest each file is text-extracted according to type: PDFs and office
documents through a document pipeline, images and scans through a vision model,
plain text directly. Spreadsheets take a different route; they're imported as
typed Tables, so a register arrives as queryable data rather than a wall of
text.

The extracted text is then treated like any other content: summarised, mined for
facts and entities by a local model, chunked, embedded, and indexed. A large
document becomes many passages, which is why the assistant can answer from one
clause of a long contract instead of having to hold the whole thing.

Large results don't get truncated on the way to the model. Past a size threshold
a tool result is stored and handed over as a handle the assistant reads through
 (by page, by grep, or by semantic query) so a big file read stays useful
without flooding the context window.
