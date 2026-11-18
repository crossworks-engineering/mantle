# Sending mail (the Sync service)

`email_send` (a plain-text message) and `email_page` (one of the user's
pages as a rich HTML email, images inline) send FROM the user's own mailbox,
through the Sync service (Sync plan M2, [services.md](./services.md)
"Sync"). We never run an MTA: the sidecar hands the message to the
mailbox's provider on its authenticated submission port (465 TLS or 587
STARTTLS) with the mailbox's app password, and the provider relays it with
its own reputation, SPF and DKIM. Before M4 the brain sent itself; that
design is in [\_archive/email-send.md](./_archive/email-send.md).

## What the brain checks first

1. The box policy: `MANTLE_POLICY_EMAIL_SEND=off` refuses every send
   (`sendViaSync`, [policy.md](./policy.md)), and the two tools leave every
   agent and MCP list while it is off.
2. Sync is on (the tools are marked `sync`: off, they are not listed).
3. Every recipient (to, cc, bcc) is a contact address, a login's address or
   one of the owner's mailbox addresses. Domains do not count for sending.
   With no contacts, mail can only go to the user.
4. For `email_page`: the page is one the caller reads, and `includeLink`
   needs the right to open its public link. Both are checked before
   anything is sent.

Both tools wait for a person by default (`requiresConfirm`); an operator
clears it per tool in Settings > Tools.

## What the sidecar does

`POST /send` (the brain only, with `SYNC_TOKEN`): it picks the mailbox
(`from`, or the first enabled mailbox with SMTP settings), checks the SMTP
server's address as for IMAP, and sends with nodemailer. A refusal (no
mailbox can send, the server refused) comes back as the tool's error.

A mailbox sends only when it has SMTP settings (Settings > Sync, the
mailbox's "Sending" part).
