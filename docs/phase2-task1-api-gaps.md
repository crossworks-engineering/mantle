# Phase 2 · Task 1 — API Gaps Checklist (living)

Closes the holes from `docs/frontend-backend-split.md` §6 Task 1: every
page / server-action that touches `@mantle/db` **without an HTTP endpoint in
front of it**. When this list is all checked, the `/api` surface is *complete* —
the prerequisite for an external (Electron / DB-less) client.

Source of truth grep (re-run to verify progress; should shrink to 0 real holes):

```bash
grep -rl "@mantle/db" apps/web/app --include='*.tsx' --include='*.ts' | grep -v '/api/' | sort
```

Audited at commit `fe27dbe` (2026-06-26). Raw grep returns **27 non-API files**,
but **only 17 are real runtime-DB holes** — see "Not holes" at the bottom before
touching anything.

---

## Real holes — 17 (11 pages + 6 server actions)

Each maps to an existing endpoint (**REWIRE**) or needs a new one (**NEW**).
"DB symbols" = what it imports from `@mantle/db` today.

### A. Email / accounts cluster — 8 holes, biggest payoff (no `/api/email*` exists yet)

Build the endpoint set once, close 8 holes. Suggested surface:
`GET /api/email/accounts`, `GET /api/email/accounts/[id]`,
`POST/PATCH/DELETE /api/email/accounts/[id]` (incl. IMAP + folders),
`GET /api/email/messages` (list/inbox), `POST /api/email/discover`.
All exist as package functions in `@mantle/email` already — wrap, don't rewrite.

- [ ] `app/(app)/inbox/page.tsx` — *page* — DB: `emailAccounts, emails, emailAttachments` → **NEW** `GET /api/email/messages`
- [ ] `app/(app)/settings/accounts/page.tsx` — *page* — DB: `emailAccounts, syncRuns` → **NEW** `GET /api/email/accounts` (+ sync-run state)
- [ ] `app/(app)/settings/accounts/[id]/edit/page.tsx` — *page* — DB: `emailAccounts` → **NEW** `GET /api/email/accounts/[id]`
- [ ] `app/(app)/settings/discover/page.tsx` — *page* — DB: `emailAccounts` → **NEW** (reuse `GET /api/email/accounts`)
- [ ] `app/(app)/email-actions.ts` — *server action* — DB: `emailAccounts, emails` → **NEW** mutation endpoint(s)
- [ ] `app/(app)/settings/accounts/folders-actions.ts` — *server action* — DB: `emailAccounts` → **NEW** folder mutation endpoint
- [ ] `app/(app)/settings/accounts/imap/actions.ts` — *server action* — DB: `emailAccounts` → **NEW** IMAP account CRUD endpoint
- [ ] `app/(app)/settings/discover/actions.ts` — *server action* — DB: `emailAccounts` → **NEW** `POST /api/email/discover`

### B. Heartbeats — 2 holes (no `/api/heartbeats` exists)

- [ ] `app/(app)/settings/heartbeats/page.tsx` — *page* — DB: `agents, skills` → **NEW** `GET /api/heartbeats` (agents/skills already have endpoints; needs a heartbeats list)
- [ ] `app/(app)/settings/heartbeats/actions.ts` — *server action* — DB: `heartbeats` → **NEW** `POST/PATCH/DELETE /api/heartbeats`

### C. Microsoft — 1 hole (only OAuth routes exist, no data endpoint)

- [ ] `app/(app)/settings/microsoft/page.tsx` — *page* — DB: `msAccounts` → **NEW** `GET /api/microsoft/accounts` (drives list already a client comp consuming this)

### D. Node detail — 1 hole

- [ ] `app/(app)/n/[id]/page.tsx` — *page* — DB: `nodes` → **VERIFY then NEW** `GET /api/nodes/[id]` (content endpoints exist for notes/events/etc.; confirm none already returns a raw node before adding)

### E. Auth bootstrap — 1 hole

- [ ] `app/login/page.tsx` — *page* — DB helper: `countUsers` → **NEW** tiny `GET /api/auth/bootstrap-state` (has-any-user flag); avoids shipping `@mantle/db` for a single count

### F. Already-covered — 4 holes, REWIRE only (endpoint exists)

- [ ] `app/(app)/settings/profile/page.tsx` — *page* — DB: `agents, channels` → **REWIRE** to `/api/agents` + `/api/profile/reminder-channel`
- [ ] `app/(app)/settings/tool-groups/page.tsx` — *page* — DB: `tools` → **REWIRE** to `/api/tools` (+ `/api/tool-groups`)
- [ ] `app/onboarding/page.tsx` — *page* — DB: `agents` → **REWIRE** to `/api/agents`
- [ ] `app/onboarding/actions.ts` — *server action* — DB: `agents` → **REWIRE** to `/api/agents` mutations

---

## Not holes — 10 files (false positives; do NOT spend time here)

The Task 0 grep flags these, but none does runtime DB access:

**Comment-only (4)** — deliberately avoid importing `@mantle/db` (keeps postgres
out of the browser bundle); the string appears only in a comment:
- `app/(app)/assistant/assistant-client.tsx`
- `app/(app)/contacts/contacts-client.tsx`
- `app/(app)/settings/microsoft/drives-list.tsx` *(type-only, see below)*
- `app/onboarding/onboarding-client.tsx`

**`import type` only (6)** — types are erased at compile; no postgres at runtime.
Eventually move these types to a client-safe package so the grep is truly clean,
but they are **not** Task-1 work:
- `app/(app)/settings/agents/agents-client.tsx` — `AgentAvatar, PersonaNote`
- `app/(app)/settings/agents/persona-notes-editor.tsx` — `PersonaNote`
- `app/(app)/settings/ai-workers/actions.ts` — `AiWorkerKind, AiWorkerParams` *(server action, but mutates via package fns — already correct)*
- `app/(app)/settings/ai-workers/ai-workers-client.tsx` — `AiWorker, AiWorkerKind`
- `app/(app)/settings/ai-workers/worker-form.tsx` — `AiWorker, AiWorkerKind`
- `app/(app)/settings/calendar/calendar-row.tsx` — `CalendarAccount`
- `app/(app)/settings/microsoft/drives-list.tsx` — `MsDrive`

> Net: Task 1 is **~6 new endpoint groups** (email is the big one), **4 rewires**,
> **1 verify**, **1 tiny bootstrap endpoint** — then a follow-up cleanup to relocate
> the type-only imports.

---

## Also fine (behind HTTP already) — the 10 `/api` routes importing `@mantle/db`

Not holes; an endpoint *is* the boundary. Listed so they aren't re-flagged:
`agents/[id]/avatar`, `assistant/transcribe`, `attachments/[id]`,
`auth/mobile-login`, `auth/mobile-logout`, `auth/signup`,
`dev-tools/queue-approval`, `mentions/search`, `peers/nodes`,
`telegram/chats/[id]`.

---

## Definition of done (Task 1)

- The §6 grep returns only the type-only / comment-only files above (ideally 0
  after the type-relocation cleanup).
- Every screen's data is reachable through `/api/**`.
- New endpoints follow the house convention: Zod validate → `@mantle/*` package
  fn → JSON, gated by `requireOwner()` (already bearer-aware — see audit).
