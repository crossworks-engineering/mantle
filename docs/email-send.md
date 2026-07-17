# Email send — Saskia sends via provider SMTP

Mantle reads mail over IMAP ([architecture.md §8](./architecture.md#8-email-pipeline)).
This is the **outbound** half: the `email_send` tool lets an agent send mail
*from the user's own mailbox*, so requests like *"research X and email it to me"*
work end to end.

## Why SMTP submission, not our own mail server

We **never** run an MTA or send on **port 25** (server-to-server relay) — that
path is blocked on most ISPs/VPS hosts (incl. Contabo) and lands in spam without
rDNS/SPF/DKIM/DMARC and IP warmup. Instead we hand the message to the user's own
provider on the **authenticated submission port** (587 STARTTLS or 465 implicit
TLS). The provider relays it under *its* reputation with SPF/DKIM aligned to the
domain — so it's genuinely "from you" and lands in inboxes.

Crucially, this reuses the **same app password already sealed for IMAP**
(`imap_config_enc`) — providers accept one app-password for both IMAP and SMTP —
so there's **no new secret column**, just plaintext `smtp_host`/`smtp_port`/
`smtp_secure` knobs on `email_accounts` (migration 0041).

## The route: "research olive oil + email me"

```
You → Saskia: "research drinking olive oil daily, email me at besties@crossworks.net"
│  trace: responder_turn (Saskia)
├─ invoke_agent('researcher', "...") ─▶ Researcher (child trace)
│     └─ web_search(...) ─▶ Perplexity Sonar → cited answer   [cost attributed]
│     └─ returns synthesis + sources to Saskia
├─ Saskia composes subject + body from the synthesis
├─ email_send({ to: "besties@crossworks.net", subject, body })
│     └─ step: resolve send-account → @mantle/email sendEmail()
│           → SMTP submission (smtp.<provider>:587/465, auth = app password)
│           → provider relays → recipient inbox
└─ Saskia → You: "Sent ✅ — here's the gist…"
```

`from` defaults to the first send-enabled account (the one with SMTP configured);
`besties@crossworks.net` is the **recipient**, not the sender.

## The tool

`email_send` ([`packages/tools/src/builtins-email.ts`](../packages/tools/src/builtins-email.ts)):

| Arg | Required | Notes |
|---|---|---|
| `to` | ✅ | comma-separate for multiple |
| `subject` | ✅ | |
| `body` | ✅ | plain text |
| `cc` / `bcc` | — | comma-separate |
| `from` | — | pick which account sends; defaults to first send-enabled |

Resolves the account, calls `sendEmail`, returns `{ messageId, accepted, rejected }`.
Traced as a `send` step inside the calling agent's turn.

**Safety gate (two independent layers):**
- **Approval gate** — `requiresConfirm: false` by default (sends immediately).
  Because the send tools can mail arbitrary addresses and Saskia ingests
  untrusted email/Telegram content (a prompt-injection exfiltration vector),
  flip `requiresConfirm` on the tool row at `/settings/tools` to route every
  send through the `pending_tool_calls` approval queue (same as `telegram_send`).
- **Recipient gate — the contacts list IS the allowlist.** Managed at
  `/contacts` (see [`contacts.md`](./contacts.md)). With zero contacts, the
  gate is OFF and Saskia can send anywhere (bootstrap state). With one or
  more contacts, the gate enforces: recipient must be the user's own account
  address, or have a matching `contact` node by email. Others are refused
  with a clear *"these recipients aren't in the user's contact list"*
  message. Applies to **both** `email_send` and `email_page` (across
  `to`/`cc`/`bcc`). Implemented by `blockedRecipients` in
  [`builtins-email.ts`](../packages/tools/src/builtins-email.ts), reading
  from `contactEmails(ownerId)`. Adding a contact unlocks emailing them;
  deleting one revokes that reach.

  (Earlier in 2026-05 a `profiles.preferences.emailAllowlist` field served
  this role; it was removed when contacts shipped to give the system a single
  source of truth for "who Saskia may reach.")

## Emailing a rich page — `email_page`

`email_send` carries **plain text**. To mail a *formatted* page — headings,
callouts, columns, tables, task lists, highlights, embedded images — Saskia uses
`email_page` ([`packages/tools/src/builtins-email.ts`](../packages/tools/src/builtins-email.ts)):

| Arg | Required | Notes |
|---|---|---|
| `pageId` | ✅ | the page node id (from `page_list`) |
| `to` | ✅ | comma-separate for multiple |
| `subject` | — | defaults to the page title |
| `cc` / `bcc` | — | comma-separate |
| `from` | — | which account sends; defaults to first send-enabled |
| `includeLink` | — | also mint a public link (see [sharing.md](./sharing.md)) and add a "View online" footer |

It loads the page, renders the ProseMirror doc to **inline-styled HTML** via
`renderPageEmail` ([`packages/content/src/render-page-email.ts`](../packages/content/src/render-page-email.ts)),
derives a plain-text fallback with `docToText` (so it's a proper
`multipart/alternative`), and sends both parts.

**Why a separate renderer.** The public-page renderer
([`apps/web/lib/render-page-doc.ts`](../apps/web/lib/render-page-doc.ts)) emits
*class-based* HTML that leans on the app's stylesheet and `var(--chart-N)` theme
tokens — none of which exist in a mail client. `renderPageEmail` is the
email-flavoured fourth representation of the page schema: every style is inline,
theme tokens resolve to a fixed concrete palette, columns become a `<table>`
row, and KaTeX/lowlight degrade (math → its LaTeX source, code → plain `<pre>`).

**Inline images.** Embedded images reference *private* files, so the renderer
emits `<img src="cid:…">` and the tool attaches the bytes inline
(`cidForPageImage(fileId)` + `readFileById`). This renders even when the client
blocks remote images and never exposes a public asset URL. Inline attachments
ride on `SendEmailInput.attachments`, new on `sendEmail`.

## Microsoft accounts send via Graph, not SMTP

A connected Microsoft account (`provider='microsoft'` companion row — see
[`microsoft-graph-ingest.md`](./microsoft-graph-ingest.md)) has no app password
and its tenant may disable SMTP AUTH outright, so it sends through Graph's
first-class action instead: `POST /me/sendMail`
([`packages/microsoft/src/outlook/send.ts`](../packages/microsoft/src/outlook/send.ts),
`sendViaGraph`). Same `SendEmailInput` contract, including inline `cid`
attachments (mapped to `fileAttachment` + `isInline`/`contentId`), and the sent
message lands in the account's Sent Items.

The dispatch lives in the tools layer (`sendFromAccount` /`canSendFrom` in
`builtins-email.ts`) because `@mantle/microsoft` already depends on
`@mantle/email` — the email package stays SMTP-only.

**Gate:** send requires the `Mail.Send` delegated scope. It's requested by
`MS_SCOPES` at connect time, and eligibility checks the *granted* scopes on
`ms_accounts.scopes` — an account connected before the scope existed keeps
reading mail fine but won't be picked for send until reconnected (the
`/settings/microsoft` mail card says so).

Limits (v1): attachments capped ~2.5 MB total (Graph's simple-request limit;
upload sessions if ever needed), and Graph returns no RFC message id on send
(202, empty body) — `messageId` in the result is empty for Graph sends.

## Layers

| Concern | Where |
|---|---|
| Send + SMTP probe | [`packages/email/src/send.ts`](../packages/email/src/send.ts) (`sendEmail`, `probeSmtpConnection`, `accountCanSend`) — nodemailer; `attachments` for inline images |
| Graph send | [`packages/microsoft/src/outlook/send.ts`](../packages/microsoft/src/outlook/send.ts) (`sendViaGraph`, `msAccountCanSend`) — Microsoft companions only |
| Credentials | reuses `unsealImapPassword(account)` — same sealed app password as IMAP; Microsoft uses the sealed OAuth token store |
| Tools + provider dispatch | [`packages/tools/src/builtins-email.ts`](../packages/tools/src/builtins-email.ts) (`email_send`, `email_page`; `sendFromAccount` routes SMTP vs Graph) |
| Page → email HTML | [`packages/content/src/render-page-email.ts`](../packages/content/src/render-page-email.ts) (`renderPageEmail`, `cidForPageImage`) |
| Grant | `CORE_AUTO_GRANT_SLUGS` in `apps/agent/src/main.ts` (`email_send`, `email_page`, `page_share`, `page_unshare` auto-granted to responder/assistant at boot) |
| Schema | `smtp_*` on `email_accounts` (migration 0041) |
| Config UI | the account add/edit form (`/settings/accounts`) — optional "Sending (SMTP)" section; the save action probes SMTP before persisting |

## Setup

1. `/settings/accounts` → edit your account → fill the **Sending (SMTP)**
   section (host/port/TLS). The form verifies the SMTP login (same app password)
   before saving. Leave it blank to keep an account receive-only.
2. **Restart `apps/agent`** so `email_send` registers + is granted (the builtin
   handler + `CORE_AUTO_GRANT` run at boot; `tsx --watch` doesn't reload
   workspace packages).

Common submission endpoints: Gmail/Workspace `smtp.gmail.com:587` (or 465),
Fastmail `smtp.fastmail.com:465`, personal Outlook `smtp.office365.com:587`.
Corporate M365 may disable SMTP AUTH by tenant policy — same caveat as IMAP.

## Future work

- **Reply threading** — `sendEmail` already accepts `inReplyTo`/`references`; a
  future `email_reply` tool could thread a reply onto an ingested `email` node.
- **Store sent mail** — outbound isn't persisted as a node today; could write a
  `email`/sent node so sent messages are searchable + show in a thread.
- ~~Per-recipient allowlist~~ — **shipped** as a *contacts-driven* gate (see
  the Safety gate above + [`contacts.md`](./contacts.md)); enforced across
  `email_send` + `email_page`.
