---
title: Contacts
toolGroups: [contacts, email]
service: sync
---

## Contacts

Contacts are the people and companies you deal with. They are also the email gate: when mail sync runs (the Sync service), the brain keeps mail from contacts only.

- Click **+** (Add a contact) and fill in a **First name**, **Last name** or **Company**, then **Email addresses**, a **Cell number** and **Tags**.
- Each email line is a full address (`orders@example.com`) or a whole domain (`@example.com`).
- Use the **Description** field to tell the assistant who this is, for example "our electrician, only works Tuesdays".
- A new address pulls in that sender's last 90 days of mail.
- Removing an address stops its new mail from being kept.

## Assistant

- "Add Sam at Example Ltd, sam@example.com."
- "What's the number for the electrician?"

The assistant cannot delete contacts.

## Technical

- A contact is a `contact` node. Its email list is the gate mail sync checks.
- Mail from addresses that are not contacts is never stored. The assistant sends mail to contacts only.
- Tools: `contact_find`, `contact_list`, `contact_get`, `contact_create`, `contact_update`. `contact_delete` is in a separate admin group.
