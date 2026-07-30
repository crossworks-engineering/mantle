---
title: PDF passwords
---

## PDF passwords

A small vault of passwords for encrypted PDFs, so protected documents can be
read into the brain without you decrypting them by hand.

The case this exists for is bank and investment statements. Providers routinely
send them password-protected with something stable — an ID number, a date of
birth — and every statement for years uses the same one. Without this, the most
consistently useful financial record you own is the one thing Mantle can't read.

Save the password once and matching PDFs unlock automatically on ingest,
including future ones.

## When to use this

Add a password when a PDF arrives that you can open and Mantle can't. The file
will have been stored — it's the *text* that's missing, so the document is in
your files and unsearchable.

Passwords are tried against any encrypted PDF, so keep the list short. Every
stored password is an attempt on every locked document, and a list of thirty
turns ingest into a guessing exercise.

Removing a password doesn't remove the text already extracted from documents it
unlocked. Delete the documents themselves if that's what you meant.

## Technical

Values are sealed with AES-256-GCM under the brain's master key, bound to their
row — the same treatment as Secrets and API keys. Nothing shows the password
back to you after saving, and it is excluded from extraction, embedding and
search.

On ingest, an encrypted PDF branches to an unlock path that tries each vaulted
password in turn against the document's text layer. Success extracts the text
normally from there; failure leaves the file stored with no text, which is why
such a document appears in your files but never in a search result.

Only the text layer is unlocked, not the file. The stored PDF stays encrypted
exactly as it arrived, so a copy you download is still the original protected
document.

The usual reason a statement stays unreadable after adding its password is that
it's a **scanned** PDF — no text layer to decrypt. That needs the vision worker,
not this screen.
