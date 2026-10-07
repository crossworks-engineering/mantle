---
title: Contacts
toolGroups: [contacts, email]
---

## Contacts

Contacts are the people and companies you deal with. They are also the email gate: Mantle only takes in mail from contacts, and the assistant only sends mail to contacts.

- Click **+** (Add a contact) and fill in a name, a **Company**, **Email addresses**, a **Cell number** and tags.
- Each email line is a full address (`orders@example.com`) or a whole domain (`@example.com`).
- Use the **Description** field to tell the assistant who this is, for example "our electrician, only works Tuesdays".
- Adding an address pulls in the last 90 days of mail from it. Removing it stops new mail.
- On the **Shared** tab, see and revoke items you have shared with this contact. **Enable sharing** gives the contact a code to open those links.

## Assistant

- "Add Sam at Example Ltd, sam@example.com."
- "What's the number for the electrician?"
- "Email Sam the quote."

The assistant cannot email someone who is not a contact, or a domain wildcard. It cannot delete contacts.

## Technical

- A contact is a `contact` node. Its email list is checked by both mail sync and `email_send`.
- Mail from addresses that are not contacts is never stored.
- The sharing code is shown once. Only a keyed hash of it is stored.
- Tools: `contact_find`, `contact_list`, `contact_get`, `contact_create`, `contact_update`. `contact_delete` is in a separate admin group.
