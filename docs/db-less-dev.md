# Split frontend + brain — setup guide

Run the owner UI (`client/web`) on your laptop against a **deployed** Mantle
brain's HTTP API — no local Docker, Postgres, MinIO, or workers. `client/web` is
a zero-secret Next app: it holds no database connection and no session secret, so
it is **natively detached** — it always talks to the server named by
`MANTLE_SERVER_ORIGIN`. "Detached dev" is simply pointing that at a remote box.
This is the topology delivered by the frontend/backend split
(`docs/frontend-backend-split.md`).

```
┌─────────────── laptop ───────────────┐      ┌────────── brain (box) ──────────┐
│  client/web (pnpm dev:fe)            │      │  full stack: web API, Postgres, │
│  · serves the owner UI bundle        │      │  MinIO, workers, Caddy/HTTPS    │
│  · MANTLE_SERVER_ORIGIN → remote     │      │                                 │
│  · NO database, NO session secret    │      │  MANTLE_API_CORS_ORIGINS        │
│                                      │      │  allowlists the laptop origin   │
│  browser ── apiFetch + bearer ──────────────▶  /api/** (bearer auth, CORS)    │
└──────────────────────────────────────┘      └─────────────────────────────────┘
```

## 1. Set up the brain (once per box)

Any deployed Mantle stack works — prod-style install or dev box. For a fresh
box, the public installer one-liner provisions everything (see
`scripts/install.sh`; the test box is the reference install).

The one addition a brain needs to serve a detached frontend:

1. **Allowlist the frontend's origin for CORS** — in the stack's `.env`:

   ```
   MANTLE_API_CORS_ORIGINS=http://localhost:3000,http://localhost:3001
   ```

   then `docker compose up -d web` to recreate the web service. The variable is
   passed through the compose `x-app-env` anchor (compose ≥ v0.111.0; on an
   older deployed bundle, add `MANTLE_API_CORS_ORIGINS: ${MANTLE_API_CORS_ORIGINS:-}`
   to the `x-app-env` block in its `docker-compose.yml` first).

   CORS is **off by default** (same-origin clients don't need it). `'*'` is
   accepted for the data API but **never applies to `/api/auth/**`** — the
   auth/credential-minting routes require an explicit origin entry, and the
   wildcard is refused there. Since sign-in happens through `/api/auth`, a
   bare `'*'` is not enough for detached dev: your dev origin
   (`http://localhost:3000`) has to be listed explicitly.

2. **Have a login on that brain** (the normal signup/onboarding). You sign in
   on the client's login page as that user; there is no separate "dev user"
   concept.

## 2. Set up the frontend (once per machine)

Create `client/web/.env.detached.local` (git-ignored) with a single line:

```
MANTLE_REMOTE=https://test.crossworks.network
```

That's it — no tokens, no credentials in the file. `pnpm dev:fe` reads
`MANTLE_REMOTE` and runs `client/web` with `MANTLE_SERVER_ORIGIN` pointed at it;
you authenticate interactively on the login page.

> **Legacy file auto-migrates.** Before the member carve the owner UI lived in
> `server/web`, and config sat at `server/web/.env.detached.local` (with token
> and credential lines). If that legacy file exists and the new one doesn't,
> `pnpm dev:fe` copies the `MANTLE_REMOTE` line over to
> `client/web/.env.detached.local` on first run and ignores the rest — the
> bearer-minting config is no longer used.

## 3. Run it

```bash
pnpm dev:fe                 # default port 3000
pnpm dev:fe --port 3001     # extra args pass through to `next dev`
```

`scripts/dev-frontend.sh` sources `MANTLE_REMOTE`, exports it as
`MANTLE_SERVER_ORIGIN`, and execs `pnpm -C client/web dev`. Open the app, **sign
in on the login page** with the remote brain's credentials — the client mints
and stores its own bearer (localStorage) and every data fetch goes browser →
remote from there. There's also a `web-fe` entry in `.claude/launch.json`
running the same script on :3001 for Claude preview sessions.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Shell renders but every data fetch fails `net::ERR_FAILED`; preflight `OPTIONS` returns 204 but the `GET` dies | The brain isn't emitting `Access-Control-Allow-Origin` — `MANTLE_API_CORS_ORIGINS` unset on the box, or set but not passed through compose | Step 1 above (env + anchor passthrough + recreate `web`) |
| Login POST is blocked by CORS even though data reads work / `'*'` is set | The wildcard is never honoured on `/api/auth/**` (credential-minting paths) — your dev origin must be listed explicitly | Add `http://localhost:3000` (your exact dev origin, matching the port) to `MANTLE_API_CORS_ORIGINS` |
| Can't sign in / auth bounces | Wrong credentials, or the box is down | `curl -sf $MANTLE_REMOTE/api/health`; check the creds against the box's login screen |
| Boot fails, `MANTLE_REMOTE missing` | `client/web/.env.detached.local` absent or empty | Create it with the single `MANTLE_REMOTE=…` line (§2) |

## Known limitations

- **Mutations hit the remote's data.** You're driving a real deployed brain —
  edits, deletes, and sends are live. Point at a throwaway/staging box (the
  test box), not prod, unless you mean it.
- **Asset paths carry a minted `?at=` token.** Browser-native asset `src`s
  (`<img>`/`<iframe>`/downloads) can't carry an Authorization header, so
  `assetUrl()` appends the short-lived `?at=` token the client mints
  (`lib/asset-url.ts`). If an image 401s detached, start there.

## How it works (internals)

`client/web` has no server-side data path to gate — every screen is
client-fetched. The browser loads data with `apiFetch`/`apiSend`/
`apiEventStream`, which read `MANTLE_SERVER_ORIGIN` (resolved per-request) and
attach the stored bearer, so the browser talks straight to the remote `/api/**`.
Sign-in mints that bearer via `POST /api/auth/token`; logging out clears it.
There is no local database anywhere in the client tier, detached or not — which
is why "DB-less dev" needs no server-side feature flag on the client: pointing
`MANTLE_SERVER_ORIGIN` at a remote box is the whole mechanism.

The cross-origin auth handshake is the one thing the *remote* has to be told
about (the CORS allowlist in §1): the server refuses the wildcard on
`/api/auth/**` so a shipped client bundle can't be tricked into minting a
credential against an arbitrary origin — the box has to name your dev origin on
purpose.
