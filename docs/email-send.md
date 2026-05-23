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

**Safety gate:** `requiresConfirm: false` — sends immediately (operator choice,
2026-05-23). Because `email_send` can mail arbitrary addresses and Saskia ingests
untrusted email/Telegram content (a prompt-injection exfiltration vector), this
can be clamped to confirm-first anytime by flipping `requiresConfirm` on the tool
row at `/settings/tools` — no code change. (Confirm-first routes the send through
the `pending_tool_calls` approval queue, same as `telegram_send`.)

## Layers

| Concern | Where |
|---|---|
| Send + SMTP probe | [`packages/email/src/send.ts`](../packages/email/src/send.ts) (`sendEmail`, `probeSmtpConnection`, `accountCanSend`) — nodemailer |
| Credentials | reuses `unsealImapPassword(account)` — same sealed app password as IMAP |
| Tool | [`packages/tools/src/builtins-email.ts`](../packages/tools/src/builtins-email.ts) |
| Grant | `CORE_AUTO_GRANT_SLUGS` in `apps/agent/src/main.ts` (auto-granted to responder/assistant at boot) |
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
- **Per-recipient allowlist** — a middle ground between ungated and confirm-first:
  send freely to your own addresses, confirm for others.
