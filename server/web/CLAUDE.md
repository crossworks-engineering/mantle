# server/web: the HTTP API, workers, and render surfaces

This tier is the brain's public face over HTTP. The owner UI is **not** here:
it lives in the jackdaw repo (`crossworks-engineering/jackdaw`) since the
2026-08-13 split and consumes this repo's published contract packages
(`@crossworks/{client-types,content-core,voice-client,share-ui,app-build}`).
UI conventions, the style guide and the shadcn/Tailwind rules live there —
`jackdaw/docs/ui-style-guide.md` is authoritative for anything visual.

What is here:

- **`app/api/**`** — 345 route handlers (Next-style `route.ts` files) served by
  the Hono app in `server/web/server/app.ts` through the generated route manifest.
  Auth: the gate (`server/web/server/middleware/gate.ts`) answers 401 to any `/api/**`
  request without a credential unless the path is in `PUBLIC_PATHS`
  (`lib/auth-constants.ts`); every handler then re-authenticates with
  `getOwnerOr401()` (owner), `resolveTeamChatCaller()` (team token) or
  `resolveShareVisitor*()` (share token). `server/web/server/auth-sweep.test.ts` drives
  every route credential-less and pins that contract. Bodies are validated
  with zod; report the first problem with `firstIssue()` (`lib/zod-issue.ts`).
  Errors: throw and let `app.onError` answer an opaque 500, or return a
  4xx with `{ error }`; never echo `err.message` to the client.
- **`lib/**`** — the HTTP-side domain adapters (agents, heartbeats, runs,
  shares, model pools, onboarding, integrity, maintenance …). Business logic
  belongs in `packages/*`; a `lib/` module is the thin layer between a route
  and a package.
- **`lib/system-manifest/`** — what a brain ships with (agents, skills, tool
  groups, workers, persona). ONE source of truth; read its `CLAUDE.md` before
  touching defaults. Never hardcode a model, prompt or grant elsewhere.
- **`workers/`** — the background processes (extract, telegram, files, docs,
  events, maintenance, runs, calendar, microsoft, push). All run through
  `workers/_runner.ts` (heartbeat, pg-boss lifecycle, bounded shutdown).
- **`server/`** — the Hono server itself: `main.ts` (boot: env files,
  `assertEnvShape()`, manifest reconcile), `app.ts`, the gate, the route
  loader, and the two render surfaces that still live on the brain because
  they need the database: **`/s/<token>`** (public shares, `server/web/server/pages/share.tsx`)
  and **`/print`** (PDF export via the Chromium sidecar). Their React islands
  under `server/web/server/islands/` and `components/share/` are the only `.tsx` left in
  this tier; they are bundled by `server/web/scripts/build-share-runtime.ts`.
- **`scripts/`** — operator CLIs (`maintain`, `seed-agent <slug>`, backfills,
  `eval-recall`). Each is a `pnpm -C server/web <alias>`.

Rules that matter here:

- **Environment through `@mantle/config`** (`env('NAME')`), never
  `process.env.X` — ESLint refuses it. Add new names to `KnownEnvName` and to
  `.env.example`. See `docs/configuration.md`.
- **Small helpers from `@mantle/std`** (`errorMessage`, `isUuid`, `sleep`);
  do not re-declare them.
- **No personal data or hostnames** in code, comments, docs or examples; the
  repo is public. Client detail lives in the dev brain.
- **Workflow**: `pnpm -C server/web typecheck` before commit; feature work in
  a worktree; land with `scripts/merge-branch.sh`; no agent co-authorship
  trailers (root `CLAUDE.md`); push only when asked. `pnpm -C server/web dev`
  runs this tier under `tsx`; `/s` and `/print` need a running brain with a
  DB. Detached (DB-less) development is a jackdaw concern, see
  `docs/db-less-dev.md`.

Team surfaces: `/team`, `/hub` and `/team-admin` UI live in jackdaw; this tier
keeps the redirect stubs, the `/api/team*` data plane and the `/s` share
brokers (`docs/team-chat.md`). The hub-app contract is `docs/team-hub-app-sdk.md`;
the bridge protocol (`@mantle/share-ui/app-bridge-protocol`) and the `@host`
kit string (`packages/app-build/src/kit.ts`) MUST stay mirrored (`kit.test.ts`).
