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

## Connecting Gmail

Gmail uses OAuth, so you need Google Cloud OAuth credentials before the
**Connect Gmail** button on `/settings/accounts` will work. One-time setup:

1. **Create a Google Cloud project** at https://console.cloud.google.com.
   Free tier is fine. Pick any name.

2. **Enable the Gmail API**: APIs & Services → Library → search "Gmail
   API" → Enable.

3. **Configure the OAuth consent screen**: APIs & Services → OAuth consent
   screen.
   - User type: **External**
   - App name: anything (e.g. "Mantle (local)")
   - User support email: yours
   - Developer contact email: yours
   - Add scopes: `gmail.readonly` and `userinfo.email`
   - **Test users**: add your own Gmail address. (Apps in "Testing" mode
     can only be used by listed test users — that's fine for local use.)

4. **Create OAuth credentials**: APIs & Services → Credentials →
   "Create Credentials" → **OAuth client ID**.
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/api/oauth/google/callback`
   - Save and copy the **Client ID** and **Client secret**.

5. **Paste into `apps/web/.env.local`**:
   ```
   GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<your-client-secret>
   GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/google/callback
   ```

6. **Restart `pnpm dev`** so Next.js picks up the new env vars.

7. Go to `/settings/accounts` → click **Connect Gmail** → consent →
   you'll redirect back with a success banner.

### If you previously connected and need a fresh refresh token

Google won't re-issue a refresh token if you've already granted access.
If you see "No refresh_token returned" in the connect error, **revoke
Mantle's access** at https://myaccount.google.com/permissions and try
again — the next consent will include the refresh token.

## Plan

See [`/Users/jasonschoeman/.claude/plans/this-is-a-brand-generic-beacon.md`](../../.claude/plans/this-is-a-brand-generic-beacon.md) for the architectural plan this implements.
