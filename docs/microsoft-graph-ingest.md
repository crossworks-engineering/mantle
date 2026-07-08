# Microsoft Graph ingestion — design

**Status:** M0 (OAuth) + M1 (SharePoint/OneDrive) + M2 (Outlook mail) built — migrations `0100`–`0103` pending apply. **M3 (calendar) HELD** — superseded by the provider-agnostic calendar pipeline (`docs/calendar-ingest.md`); M3 becomes "implement `CalendarProvider` for Graph `/me/calendarView/delta`", reusing `ms_accounts` tokens, exactly as Outlook mail reused the email pipeline.
**Author:** drafted 2026-06-24

> **M2 build notes (2026-06-24).** Outlook mail reuses the email pipeline
> wholesale (Choice A): `@mantle/microsoft/outlook/mail.ts` implements
> `@mantle/email`'s `EmailProvider` interface (listSince / fetchFull /
> listRecent / listFromSender) over Graph, and the existing `syncAccount` does
> the contact gate, classification, dedup, and node+emails+attachments insert
> unchanged. A companion `email_accounts` row (`provider='microsoft'`, new
> `ms_account_id` FK, migration `0103`) satisfies the emails FK and links the
> OAuth token. `outlook/manage.ts` creates/toggles it; the microsoft-sync worker
> gained a mail scheduler+queue; the IMAP worker now filters to `provider='imap'`
> (skips the companions). UI: a "Outlook mail" opt-in toggle per account.
>
> **Cursor:** monotonic `receivedDateTime` watermark in
> `email_accounts.sync_state.graph.mail.since` (mirrors IMAP's UID watermark);
> `ge` re-yields the boundary message, deduped. Delta (deletion-aware) not used —
> the email pipeline is append-only like IMAP.
>
> **v1 simplifications:** Inbox folder only (other folders later, like IMAP
> discovery); mail respects the SAME contact gate (only approved senders
> ingested — zero contacts = nothing); sender-approval backfill not wired for
> Microsoft accounts (new mail still flows via the watermark).

> **M1 build notes (2026-06-24).** Shipped: `@mantle/microsoft/drives/`
> (`discover` OneDrive + followed SharePoint libraries → `ms_drives`; `sync`
> delta-query → file nodes; `store` = the email-attachment ingestion path;
> `manage` enable/discover), `ms_drives` + `ms_drive_items` schema + migration
> `0102`, the `workers/microsoft-sync.ts` pg-boss worker (+ dev script +
> `worker_microsoft` compose service), and a drive picker on `/settings/microsoft`
> (opt-in toggles, "Refresh drives"). All packages typecheck clean.
>
> **Key reuse decision:** synced files are ordinary `type: 'file'` nodes (NOT a
> new node type), so the existing extractor parses/summarizes/embeds them
> unchanged. Provenance lives in `ms_drive_items` + `data.source`
> (`sharepoint`/`onedrive`). Dedup is owner-scoped by sha256 (a file shared with
> an email attachment is one node).
>
> **v1 simplifications (noted for later):** flat layout — all of a drive's files
> land under one branch (`<acct>.<driveLabel>`), folder tree not mirrored into
> ltree (SharePoint path kept in `web_url`); `graphGetAll` loads a delta page set
> into memory (fine for bounded libraries — see "Large libraries"); files over
> `MAX_UPLOAD_BYTES` skipped; changed-content leaves the old node until GC.
> Discovery covers OneDrive + *followed* SharePoint sites (manual add-by-URL
> later).

> **M0 build notes (2026-06-24).** Shipped: `@mantle/microsoft` package
> (`config`, `config-store`, `oauth` PKCE, `token-store` with single-flight
> refresh, `client`), `ms_accounts` + `microsoft_config` schema + migrations
> `0100`/`0101`, `/api/microsoft/oauth/{start,callback}` routes, and the
> `/settings/microsoft` page (Azure-app config form + connect / list / disconnect)
> + nav entry. All packages typecheck clean.
>
> **Azure app config is UI-settable** (no longer env-only): the
> `microsoft_config` singleton-per-owner table (client secret sealed, AAD =
> owner id) is the primary path, with `MS_*` env as fallback for headless/
> scripted deploys. `config-store.resolveOAuthConfig()` encodes the DB→env
> precedence; the redirect URI is stored explicitly and surfaced in the form to
> copy into Azure (no `NEXT_PUBLIC_APP_URL` dependency).
>
> **Not yet done:** apply migrations `0100`+`0101` (DATABASE_URL is prod — needs
> a `pg_dump` backup + go-ahead first), and the Azure app registration itself
> (admin consent). After the migrations land, an admin just fills in the form —
> no env or restart needed. Browser end-to-end verification is blocked on the
> migrations (the page queries both new tables).
**Decision context:** Multiple users will need to connect Microsoft 365 sources.
We are building a **Microsoft Graph foundation** (OAuth2 + Graph client +
delta-sync framework), not a one-off SharePoint connector. SharePoint ships
first; OneDrive, Outlook mail, and Outlook calendar are designed-for consumers
of the same plumbing.

## Locked decisions

| Fork | Decision | Consequence |
|---|---|---|
| Auth model | **Delegated (per-user)** | Each user signs in with their own MS account via OAuth Authorization Code + PKCE. Mantle sees only what that user can see. One Azure app registration, per-user token rows. |
| Graph surface | **SharePoint + OneDrive + Outlook (mail/cal)** | One `@mantle/microsoft` package with a shared Graph client; per-surface sync modules. Outlook finally delivers the `microsoft` email provider that was stubbed and removed. |
| Deployment | **Self-hosted per-brain** | One shared Azure app registration (client id + secret in env, not per-user). Tokens stored per-brain in that brain's Postgres, sealed with `@mantle/crypto`. |

## Why this is mostly a known quantity

Mantle already has a battle-tested ingestion pipeline. The back half is
**source-agnostic**:

```
fetch → dedup/gate → insert as `node` → pg_notify('node_ingested') →
  extractor (apps/agent) → summary + 768-dim embedding + entity facts → graph
```

Once Graph bytes land as a `node` (file) or an `emails` row, search, RAG,
entity extraction, and the knowledge graph all work unchanged. So the work is
entirely in the **front half**: OAuth, the Graph client, and per-surface sync
cursors. The email connector
([packages/email](../packages/email), [apps/web/workers/email-sync.ts](../apps/web/workers/email-sync.ts))
is the structural template for everything except OAuth.

## The one genuine gap: OAuth2

Mantle has **no OAuth2 anywhere today**. All current auth is static secrets
(IMAP app passwords, Telegram bot tokens) sealed with AES-256-GCM. Microsoft
Graph requires OAuth2 with **token refresh** (access tokens live ~60–90 min;
refresh tokens must be stored, rotated, and re-exchanged). This is the ~80%-of-
effort piece and it is net-new. Everything else is "copy the email connector."

Note: [packages/db/src/schema/emails.ts:24](../packages/db/src/schema/emails.ts)
still carries `email_provider = ['gmail','microsoft','imap']` and
[apps/web/workers/email-sync.ts:42](../apps/web/workers/email-sync.ts) explicitly
throws on `microsoft` — "we shipped OAuth then ripped it out." This design puts
it back, properly, as a shared foundation rather than email-only.

---

## Architecture

### New package: `@mantle/microsoft`

```
packages/microsoft/src/
  oauth.ts          ← Auth Code + PKCE: authorize URL, code→token, refresh, revoke
  token-store.ts    ← sealed token CRUD + getValidAccessToken() (auto-refresh)
  client.ts         ← Graph fetch wrapper: auth header, throttling/429+Retry-After, paging
  graph-types.ts    ← minimal typed shapes for the endpoints we touch
  drives/
    sync.ts         ← SharePoint + OneDrive: delta enumeration → file nodes
    sites.ts        ← site/drive discovery + the access "gate"
  outlook/
    mail.ts         ← messages delta → `emails` rows (reuses @mantle/email insert path)
    calendar.ts     ← events delta → event nodes
  index.ts
```

A single OAuth + client core; each surface is a thin sync module. Adding Teams
later = one more folder, no core changes.

### OAuth2 module (`oauth.ts` + `token-store.ts`) — the hard part

Delegated **Authorization Code flow with PKCE**:

1. **Connect** (`/settings/accounts` → "Connect Microsoft"): generate PKCE
   `code_verifier`/`code_challenge` + `state`, redirect to
   `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` with our
   scopes. For multi-org reach use `tenant = common` (or `organizations`).
2. **Callback** (`/api/microsoft/oauth/callback`): validate `state`, exchange
   `code` + `code_verifier` at the `/token` endpoint → `{access_token,
   refresh_token, expires_in, scope}`. Create the `ms_accounts` row.
3. **Refresh** (`getValidAccessToken(accountId)`): if the cached access token
   expires within a skew window (~5 min), exchange the refresh token, persist
   the rotated pair, return the fresh access token. **Single-flight per account**
   (advisory lock or `singletonKey`) so concurrent sync jobs don't double-refresh
   and race the refresh-token rotation.

Token storage mirrors [packages/api-keys](../packages/api-keys/src/index.ts):
`seal(plaintext, rowId)` / `open(ciphertext, rowId)` from `@mantle/crypto`, AAD =
row id. Access **and** refresh tokens sealed; only non-secret metadata
(expiry, scope, `upn`) kept plaintext so the scheduler can reason without
unsealing.

**Azure app config** (shared, per-deployment, in env — not per user):

```
MS_CLIENT_ID=…
MS_CLIENT_SECRET=…          # confidential client; keep server-side only
MS_TENANT=common            # or a specific tenant id
MS_REDIRECT_URI=https://<brain-host>/api/microsoft/oauth/callback
```

Delegated **scopes** (least-privilege, offline access for refresh):

```
offline_access openid profile
Files.Read.All Sites.Read.All           # SharePoint + OneDrive (read)
Mail.Read                               # Outlook mail
Calendars.Read                          # Outlook calendar
```

Read-only by design for v1. Widen to `.ReadWrite` only when a write feature
actually needs it.

### Schema (new migration)

Follow the `email_accounts` / `emails` split:
[packages/db/src/schema/emails.ts](../packages/db/src/schema/emails.ts).

```ts
// ms_accounts — one per connected Microsoft identity (delegated)
ms_accounts(
  id uuid pk,
  user_id uuid not null,
  upn text not null,                 // user principal name / email
  display_name text,
  tenant_id text,                    // home tenant of the signed-in user
  access_token_enc bytea,            // sealed
  refresh_token_enc bytea,           // sealed
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  branch_path text not null,         // ltree root for this account's content
  enabled bool not null default true,
  surfaces jsonb not null default '{}', // which surfaces are on: {drives,mail,calendar}
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, upn)
)

// ms_drive_items — provenance + dedup for SharePoint/OneDrive files
ms_drive_items(
  id uuid pk,
  account_id uuid not null references ms_accounts on delete cascade,
  node_id uuid not null references nodes on delete cascade,  // the file node
  drive_id text not null,
  item_id text not null,             // Graph driveItem id (dedup key)
  etag text,                         // cheap change check
  web_url text,
  last_modified timestamptz,
  created_at timestamptz default now(),
  unique(account_id, drive_id, item_id)
)

// Per-surface, per-drive delta cursors live in ms_accounts.sync_state jsonb,
// keyed like { "drive:<driveId>": "<deltaLink>", "mail": "<deltaLink>", ... }
```

Outlook mail reuses the existing `emails` table — `provider_msg_id` already
documents "Graph message id" as an intended value
([emails.ts:122](../packages/db/src/schema/emails.ts)). We add a `microsoft`-
provider branch to the email insert path rather than a parallel table. Add
`'sharepoint_file' | 'onedrive_file'` to the node-type enum (or carry source in
`nodes.data.source` — decide in build; node-type is cleaner for provenance
filtering).

### Drive discovery — the Follow rule

What "Refresh drives" lists (`drives/discover.ts`) is exactly the union of:

1. **The account's own OneDrive** — `GET /me/drive`. Included whenever the
   account has one provisioned (non-fatal if not).
2. **Every document library of every SharePoint site the user *follows*** —
   `GET /me/followedSites`, then `GET /sites/{id}/drives` per site. "Follows"
   is the star/Follow button on the site in SharePoint — the list under
   "Following" on the SharePoint start page.

Consequences worth stating plainly (this is the #1 "why isn't my site
showing?" question):

- **Access alone is not enough.** A site the user can open but doesn't follow
  is invisible to discovery. The fix is: Follow the site in SharePoint, then
  hit Refresh drives.
- **Each followed site contributes ALL of its document libraries**, and most
  sites have a default library named just "Documents" — several same-named
  entries means several followed sites (the UI shows `siteName` to
  disambiguate; the branch label carries a drive-id hash so they never
  collide).
- **Not listed, by design:** items merely shared with the user, other people's
  OneDrives, and sites the user doesn't follow. A manual add-site-by-URL
  (`GET /sites/{hostname}:/{server-relative-path}`) is the planned escape
  hatch if follow-based scoping proves too coarse.

Discovery only *catalogs*: every found drive is upserted **disabled**, and
re-running refreshes display metadata without touching `enabled`/`delta_link`
— a re-discover never disrupts an active sync.

### Sync workers (delta queries)

New worker `apps/web/workers/microsoft-sync.ts`, structured exactly like
[email-sync.ts](../apps/web/workers/email-sync.ts):

- **Scheduler** (`*/2 * * * *` pg-boss cron) fans out one sync job per enabled
  `ms_accounts` row, `singletonKey: ms:sync:<accountId>`.
- **Sync worker** loads the account, calls `getValidAccessToken`, then runs each
  enabled surface:
  - **Drives:** `GET /drives/{id}/root/delta` (or `/sites/{id}/drive`), page via
    `@odata.nextLink`, persist `@odata.deltaLink` per drive. For each
    added/changed `driveItem`: dedup on `(drive_id, item_id)`; download bytes
    (`/content`), sha256 → MinIO via `@mantle/storage`, insert/attach the file
    node, `notifyNodeIngested()`. Deletes → tombstone/remove the node.
  - **Mail:** `GET /me/mailFolders/.../messages/delta` → reuse the email insert +
    classify + contact-gate path.
  - **Calendar:** `GET /me/calendarView/delta` → event nodes.
- **Throttling:** Graph returns `429` with `Retry-After` under load; the client
  wrapper honours it with backoff. pg-boss retry + dead-letter on exhaustion,
  same as email.

### Access gating

Email has a hard **contact gate** (only approved senders ingested). Drives
have two opt-in layers, mirroring that stance:

1. **Per-drive toggle** — discovery upserts every drive *disabled*; nothing
   syncs until a drive is switched on.
2. **Per-drive scopes** (`ms_drive_scopes`) — the "Choose content" picker on
   any drive, enabled or not (the safe first-connect flow for a big OneDrive
   is: choose content while the drive is still OFF, then enable). No selections = the whole drive syncs; selections =
   only files under ticked folders (after-`root:` path prefix) or exactly
   ticked files sync. Graph only supports delta from the drive **root** on
   OneDrive for Business/SharePoint, so scoping is a client-side filter over
   the root delta feed (`drives/scope.ts` — same cursor, no extra API cost).
   Saving a scope set clears `delta_link`; the next sync full-walks, ingesting
   newly-in-scope files and pruning ingested files now out of scope. File
   scopes match by item id (rename-stable); folder scopes by path prefix, so
   renaming a scoped folder drops its contents until re-selected.

### Permissions fidelity

Delegated tokens already scope reads to what the user can see — the simplest and
safest baseline. v1 flattens ownership to the connecting Mantle user (no
mirroring of per-item SharePoint ACLs into Mantle's sharing model). Revisit only
if multi-user sharing of ingested SharePoint content becomes a requirement.

---

## Azure / IT checklist (hand to the user's tenant admin)

This is the long-pole approval, independent of our code. Start it **day one**.

1. **App registration** in Entra ID (Azure AD): single multi-tenant app
   (`tenant = common`) so any user's org can consent.
2. **Redirect URI** (Web): `https://<brain-host>/api/microsoft/oauth/callback`.
3. **Client secret** (confidential client) → `MS_CLIENT_SECRET`.
4. **Delegated API permissions:** `offline_access`, `openid`, `profile`,
   `Files.Read.All`, `Sites.Read.All`, `Mail.Read`, `Calendars.Read`.
5. **Admin consent:** some orgs require a tenant admin to consent once before
   individual users can connect. If a target org locks this down, that approval
   can take longer than the build — flag it early.

## Security notes

- Tokens sealed at rest (`@mantle/crypto`), never logged, never returned to the
  client. Callback handler validates `state`; PKCE protects the code exchange.
- `MS_CLIENT_SECRET` server-side only. Graph calls go through the SSRF-guarded
  fetch posture already used by `@mantle/tools` dispatch where applicable.
- Per-user revoke: deleting an `ms_accounts` row + best-effort token revoke at
  Microsoft; downstream nodes follow existing deletion semantics.

---

## Phasing

| Milestone | Scope | Proves |
|---|---|---|
| **M0 — OAuth core** | `@mantle/microsoft` oauth + token-store + client; connect/callback UI; refresh single-flight | A user can connect M365 and we hold a self-refreshing token. *The risky part, done first.* |
| **M1 — SharePoint/OneDrive** | `drives/sync` + `ms_drive_items` + drives worker + site/folder gate | Documents land as file nodes and become searchable end-to-end. |
| **M2 — Outlook mail** | `outlook/mail` reusing the `emails` path; flip the dead `microsoft` provider on | M365 mail without IMAP app passwords. |
| **M3 — Calendar** | `outlook/calendar` → event nodes | Calendar in the graph. |

Each milestone is independently shippable. M0 is the gate — if OAuth refresh is
solid, M1–M3 are mechanical applications of the email pattern.

## Open questions

- **Node-type vs `data.source`** for drive-file provenance — lean node-type for
  filterable provenance; confirm against the enum's migration cost.
- **Webhooks vs polling:** Graph change notifications (subscriptions) would beat
  2-min polling but add a public webhook endpoint + subscription-renewal cron.
  Start with delta polling (matches email); add subscriptions later if latency
  matters.
- **Large libraries:** initial backfill of a big SharePoint site needs the same
  paced-backfill treatment email uses ([packages/email backfill queue](../packages/email)).
  Cap first-sync breadth via the allow-list.
