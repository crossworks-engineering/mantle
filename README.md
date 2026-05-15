# Mantle

Jason's AI-queryable life tree. Single Postgres-backed system that knows about emails, files, notes, sermons, secrets, and printer projects — and exposes all of it to Claude over MCP.

## Layout

```
mantle/
├── supabase/          # local Supabase config (CLI) + platform migrations
├── apps/
│   ├── web/           # Next.js 15 (App Router) + shadcn UI + Supabase clients
│   └── mcp/           # MCP server (stdio + HTTP)
├── packages/
│   ├── db/            # Drizzle schema + migrations
│   ├── email/         # Gmail / Graph / IMAP adapters + sync engine
│   ├── storage/       # Supabase Storage wrapper
│   ├── crypto/        # AES-256-GCM helpers for secrets at rest
│   ├── search/        # full-text + vector search helpers
│   └── rules/         # ingest rules engine
└── scripts/           # dev convenience
```

## First-time setup

```bash
# 1. Install pnpm if you don't have it
corepack enable && corepack prepare pnpm@10 --activate

# 2. Install the Supabase CLI (one-time)
brew install supabase/tap/supabase

# 3. Install deps
pnpm install

# 4. Copy env (single file — Next.js, worker, MCP, and Drizzle all read from here)
cp .env.example apps/web/.env.local
openssl rand -base64 32  # paste into MANTLE_MASTER_KEY

# 5. Start the platform
supabase start          # brings up Postgres, Auth, Storage, Studio
# Supabase prints the anon/service-role keys — paste them into .env.local

# 6. Apply Mantle's app schema
pnpm db:migrate

# 7. Run everything
pnpm dev                # web (3000) + mcp + email worker
```

Studio: http://localhost:54323
App: http://localhost:3000

## Connecting an email account

Mantle uses **IMAP for every provider** — Gmail, Outlook, custom
domains, all of them. No OAuth, no Google Cloud Console setup, no
refresh tokens to babysit. The cost is one app-password per account.

For each account:

1. **Enable 2FA** on the account if it isn't already (provider requires
   this before issuing app passwords).
2. **Generate an app password** in the provider's account-security UI:
   - Gmail / Workspace: https://myaccount.google.com/apppasswords
     (also: Gmail Settings → Forwarding and POP/IMAP → IMAP access: Enable)
   - Outlook / Microsoft personal:
     https://account.live.com → Security → Advanced → App passwords
   - Fastmail / iCloud / Zoho / Proton (via Bridge): same idea —
     account security → app passwords
3. **Open `/settings/accounts` → Add IMAP account**:
   - **Host** depends on provider:
     - Gmail: `imap.gmail.com`
     - Outlook personal: `outlook.office365.com`
     - Your own domain: whatever your registrar set up
   - **Port**: 993, TLS on
   - **Username**: full email address
   - **Password**: the app password from step 2
4. Hit **Test connection** to verify before saving.

The first sync starts within ~2 min and scans 12 months of headers
without ingesting any bodies — those wait until you approve a sender
at `/settings/senders`.

**Microsoft 365 corporate caveat**: some tenants have basic-auth IMAP
disabled by admin policy. If you can't get IMAP working from a paid
M365 mailbox, the easiest workaround is to ask your admin to enable
it for your mailbox — Mantle does not implement Microsoft OAuth.

## Plan

See [`/Users/jasonschoeman/.claude/plans/this-is-a-brand-generic-beacon.md`](../../.claude/plans/this-is-a-brand-generic-beacon.md) for the architectural plan this implements.
