---
title: PDF passwords
---

## PDF passwords

This screen stores passwords for locked PDFs, so Mantle can read them. Bank
and investment statements often arrive locked with the same password every
month, such as the last digits of an ID or account number.

1. Enter a **Label** (optional), for example "Bank statements".
2. Enter the **Password** and press **Add**.

When a locked PDF comes in, the extractor tries each saved password until one
opens it. The list shows when each password last unlocked a file. Keep the list
short: every password is tried on every locked PDF.

A locked PDF that arrived before you saved its password is not retried by
itself. It stays in your files without searchable text until it is extracted
again.

## Assistant

The assistant has no tools for this screen. Add and remove passwords here
yourself. Once a PDF is unlocked, ask about it like any other document:

- "What was the closing balance on last month's bank statement?"
- "Find the statement that shows the annual fee."

## Technical

Passwords are sealed with AES-256-GCM under the brain's master key and are
never shown again after you save them. They live in the `pdf_passwords` table.
Only the extracted text is unlocked: the stored file stays encrypted, so a
download is still the original locked PDF.

A failed unlock is recorded as a skipped extractor trace with the reason
`encrypted_pdf`, so you can find it on the Traces screen. A scanned PDF with a password has no text
layer to unlock, so a saved password does not help it.
