---
title: Audit log
---

## Audit log

The audit log lists what signed-in people did on this brain, and when.

- Filter by **Login**, by **Action**, and by a **From** and **To** date.
- Each row shows the time, the login, the action, the request and the IP address.
- Results come 50 to a page. The filters live in the address, so you can keep or share a view as a link.

Use it when something changed and you want to know who did it: a sign-in, a new login, a sharing change, a service switched on or off, or a change made through the API.

## Assistant

The assistant cannot read the audit log. Open it here.

## Technical

- Entries are stored in the `audit_log` table. Nothing in the app edits or deletes them.
- The log records actions, not content. It shows that something was deleted and by whom, not what it held.
- The login's email is stored as text, so entries remain after the login is removed.
- What the assistant and its tools did is recorded in traces, not here. See [Traces, debug and integrity](../05-admin/09-observability.md).
