# Email and contacts

Link your mailboxes, choose whose mail the brain keeps, and let the assistant send mail.

## Before you start

Email and Contacts need the **Sync** service. An admin turns it on in **Settings > Services**. While it is off, both screens are hidden; nothing is deleted.

## Link a mailbox

1. Open **Settings > Sync** and choose **Add a mailbox**.
2. Enter your email address and an **app password** from your mail provider (not your account password).
3. Enter the IMAP server (incoming). Add the SMTP server (sending) if the assistant may send from this mailbox.
4. Choose **Check and save**. The brain logs in once to check, then the first sync starts.

New mail arrives every 5 minutes. The first sync reads back one year by default.

## Contacts are the gate

Your contacts decide whose mail the brain keeps when mail sync runs.

- Mail is kept only when it comes from a contact, or from one of your own logins.
- Add a contact and the last 90 days of their mail comes in.
- Remove a contact and their new mail is no longer kept.

**Settings > Sync > Find senders** lists recent senders who are not contacts yet, with **Add as contact**.

Each contact holds one or more email entries. An entry is a full address (`sam@example.com`) or a whole domain (`@example.com`, anyone there). A domain entry does not cover sub-domains.

## Add a contact

1. Open **Contacts** and create a contact.
2. Fill in the name, company and one email entry per row.
3. Write a **Description**: who this is, for the AI. For example: "Our electrician. Only works Tuesdays."
4. Save.

You can also tell the assistant: "Add Sam at Acme, sam@example.com."

## Read mail

**Email** shows stored mail by account and folder. Attachments are read too, so a PDF quote is searchable by its contents.

Ask the assistant about the content, not the message:

- "What did Sam quote for the roof?"
- "Summarise this week's mail from Acme."

## Send mail

Ask the assistant: "Email Sam the quote" or "Email Sam the meeting notes page". It sends from your linked mailbox, to contacts only, and waits for your approval by default.

## Next

- [Files](04-files.md)
- Screen help: [Email](../06-help/inbox.md), [Contacts](../06-help/contacts.md)
