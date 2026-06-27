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

**Progress:** ✅ **ALL 17 real holes closed.** A (email) v0.60.0 · F (rewires)
v0.60.1 · B/C/D/E (heartbeats/microsoft/node/login) v0.60.2. The §6 grep now
returns only the documented false positives (comment-only + `import type`).
**Remaining for full DoD:** relocate the 6 type-only imports to a client-safe
package (cosmetic — no runtime DB), and HTTP mutation parity for heartbeats
(group B follow-up).

---

## Real holes — 17 (11 pages + 6 server actions)

Each maps to an existing endpoint (**REWIRE**) or needs a new one (**NEW**).
"DB symbols" = what it imports from `@mantle/db` today.

### A. Email / accounts cluster — 8 holes ✅ DONE (v0.60.0)

Closed by extracting the inline Drizzle into `@mantle/email` (`accounts.ts`,
`messages.ts`, `discover.ts`) and wrapping it with `/api/email/**`. The 4 pages +
4 actions now import `@mantle/email`, not `@mantle/db`. SSR unchanged (in-process);
client conversion is Task 4. Endpoints built:
`GET/POST /api/email/accounts`, `GET/PATCH /api/email/accounts/[id]`,
`GET/PUT /api/email/accounts/[id]/folders`, `GET /api/email/folders`,
`GET /api/email/messages`, `GET/PATCH /api/email/messages/[id]`,
`GET /api/email/discover`, `POST /api/email/discover/contacts`.
Account responses are credential-redacted (`redactAccount` strips `imapConfigEnc`).

- [x] `app/(app)/inbox/page.tsx` — *page* → `navAccounts`/`folderFacets`/`listMessages`/`getMessageWithAttachments`/`setReadStatus`
- [x] `app/(app)/settings/accounts/page.tsx` — *page* → `listAccounts` + `latestSyncRuns`
- [x] `app/(app)/settings/accounts/[id]/edit/page.tsx` — *page* → `getAccount`
- [x] `app/(app)/settings/discover/page.tsx` — *page* → `listImapAccounts`
- [x] `app/(app)/email-actions.ts` — *server action* → `setReadStatus`/`setStarred`
- [x] `app/(app)/settings/accounts/folders-actions.ts` — *server action* → `listAccountFolders`/`setIncludedFolders`
- [x] `app/(app)/settings/accounts/imap/actions.ts` — *server action* → `connectImapAccount`
- [x] `app/(app)/settings/discover/actions.ts` — *server action* → `recentUnknownSenders`/`addContactFromSender`

> Note: the audit assumed these "exist as package functions already" — they did
> not (the reads were inline Drizzle in the pages). The package layer was built
> as part of this task.

### B. Heartbeats — 2 holes ✅ DONE (v0.60.2)

- [x] `app/(app)/settings/heartbeats/page.tsx` — *page* → `listHeartbeats` + `listAgentOptions` (new, all agents) + `listSkills`
- [x] `app/(app)/settings/heartbeats/actions.ts` — *server action* → `getHeartbeatRow` (new, full row for `forceFire`) + shape-type re-exports
- Endpoints: `GET /api/heartbeats`, `GET /api/heartbeats/[id]`. **Follow-up:** HTTP
  mutation parity (`POST/PATCH/DELETE`) — deferred; needs a Zod schema for the
  schedule/surface union (none exists in `@mantle/heartbeats` yet). The settings
  mutations are db-free server actions, so the hole itself is closed.

### C. Microsoft — 1 hole ✅ DONE (v0.60.2)

- [x] `app/(app)/settings/microsoft/page.tsx` — *page* → `@mantle/microsoft` `listAccounts`
- Endpoint: `GET /api/microsoft/accounts` (`redactMsAccount` strips sealed OAuth tokens → `hasAccessToken`/`hasRefreshToken` flags).

### D. Node detail — 1 hole ✅ DONE (v0.60.2)

- [x] `app/(app)/n/[id]/page.tsx` — *page* → `@mantle/content` `getOwnedNode`
- Verified no existing endpoint returned a raw node; added `GET /api/nodes/[id]` (type-blind id+type resolver, 404 on leaked id).

### E. Auth bootstrap — 1 hole ✅ DONE (v0.60.2)

- [x] `app/login/page.tsx` — *page* → `lib/auth` `isFirstRun` (wraps `countUsers`)
- Endpoint: `GET /api/auth/bootstrap-state` (public, pre-auth; only a boolean leaks).

### F. Already-covered — 4 holes ✅ DONE (v0.60.1)

Pure rewires — call the lib fn the existing endpoint already uses (an SSR page
must not fetch its own HTTP API during render). Two owner-scoped helpers added to
`@/lib/agents` (`getAgentBySlug`, `listReminderCapableAgents`); no new endpoints.

- [x] `app/(app)/settings/profile/page.tsx` — *page* → `listReminderCapableAgents` (`@/lib/agents`)
- [x] `app/(app)/settings/tool-groups/page.tsx` — *page* → `listToolsForOwner` (`@/lib/tools`)
- [x] `app/onboarding/page.tsx` — *page* → `getAgentBySlug` (`@/lib/agents`)
- [x] `app/onboarding/actions.ts` — *server action* → `getAgentBySlug` (`@/lib/agents`)

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
