# Microsoft Graph ingestion — design

**Status:** M0 (OAuth core) built — migration `0100_ms_accounts` pending apply. M1–M3 not started.
**Author:** drafted 2026-06-24

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

Email has a hard **contact gate** (only approved senders ingested). The drives
analogue is a **site/folder allow-list** so we don't vacuum a user's entire
OneDrive on first connect. v1: at connect time the user picks which SharePoint
sites / OneDrive folders to sync (stored in `ms_accounts.surfaces`/an allow
table). Default to *nothing* until chosen — opt-in, mirroring the email gate's
"silently drop everything unapproved" stance.

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
