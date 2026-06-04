# Todos, Events, Contacts & Secrets

Four structured surfaces for the practical bits of life. Each is a first-class part
of the brain (searchable, citable), and the assistant can create and manage all of
them for you.

## Todos

Tasks with **status**, **priority**, and an optional **due date**. Use the **Todos**
screen, or just tell the assistant: "add a todo to renew the car licence, high
priority." Mark them done in the UI or by asking. Todos are indexed, so "what's
outstanding for the church project?" works.

## Events

Calendar events with a start (and optional end), location, and a **reminder**. When
a reminder is due, Mantle **pings you on Telegram** — so "remind me to call Don
Friday at 3pm" actually reaches your phone. Events support **recurrence** (daily/
weekly/monthly/yearly), and times respect your [profile timezone](../04-configuring/06-profile-appearance-security.md)
so "tomorrow at 3pm" resolves correctly. Shared events offer an "add to calendar"
(.ics) download.

> Reminders go to your most-recent Telegram chat, so make sure your phone is paired
> (see [Assistant & Telegram](01-assistant-and-telegram.md)).

## Contacts

People you know — **name, company, one or more emails, phone**, and an
**AI-facing description** ("my electrician; prefers WhatsApp"). The description is
read into the brain, so the assistant understands who each person is. A contact can
hold **several email entries**, each either a full address (`jane@modular.co`) or a
**whole-domain wildcard** (`@modular.co` = anyone at that domain).

Contacts are the **email allowlist in both directions:**

- **Inbound** — Mantle only ingests mail *from* people in your contacts (an
  address or a `@domain` match), plus your own account addresses. With no
  contacts, nothing new comes in; adding a contact also backfills their last 90
  days. (See [Email & inbox](02-email-inbox-and-contacts.md).)
- **Outbound** — the assistant may only *email* people in your contacts (plus your
  own addresses); here only concrete addresses count, since you can't send to a
  whole domain. With no contacts, sending is open (bootstrap).

Adding a contact unlocks both; removing one revokes both. Mantle also tracks light
activity (how many times, last contacted) per person.

Tell the assistant "save Jane at Modular, jane@modular.co" and it creates the
contact (it won't add people on its own initiative — only when you ask).

## Secrets

An **encrypted vault** for passwords, codes, API keys, and other sensitive values.
The security model is the important part:

- Each secret has **plaintext metadata** (title, description, tags) that the brain
  *can* read and search — so "what's my gate code note?" finds it.
- The **actual secret values are sealed** with strong encryption and are **never
  shown to the assistant or sent to any model.** You reveal them yourself in the UI
  (per-field show/copy).

So the assistant can help you *find* a secret and tell you what it's for, but it
can't read the value — by design. (Secrets are intentionally not exposed to the
assistant's tools.)

---

Everything here flows through the same memory pipeline as notes and files — see
[The brain](../02-concepts/01-the-brain.md) — and everything here can be driven by
the assistant, with risky actions gated behind your approval if you choose (see
[Skills & tools](../04-configuring/02-skills-and-tools.md)).
